# Spec: VDB-on-the-Web

**Status:** Draft for review · Companion to [FEASIBILITY.md](./FEASIBILITY.md)
(which justifies every choice made here).

## 1. What we are building

Three artifacts with one contract between them — *"a valid NanoVDB grid
image in a flat u32 buffer"*:

```
┌─────────────────────────── CPU / WASM ───────────────────────────┐
│  vdb-web-tools                                                   │
│  .vdb / .nvdb file  →  parse / build / quantize / inspect        │
│                     →  NanoVDB grid image (ArrayBuffer)          │
└──────────────────────────────┬───────────────────────────────────┘
                               │  flat buffer (the contract)
┌──────────────────────────────▼───────────────── GPU / WGSL ──────┐
│  nanovdb-wgsl        traversal/sampling WGSL module (no three.js)│
│  three-nanovdb       TSL bindings, materials, compute utilities  │
└──────────────────────────────────────────────────────────────────┘
```

Each side is developed and tested independently against pre-made `.nvdb`
fixtures. Renderer: Three.js `WebGPURenderer` (TSL). No WebGL fallback.

## 2. Package 1: `nanovdb-wgsl` — the GPU traversal core

Renderer-agnostic WGSL source + a thin TS loader. Base: audit-and-extend of
the Apache-2.0 `pnanovdb.wgsl` port, verified line-by-line against upstream
`PNanoVDB.h` (ABI 32.x, `PNANOVDB_ADDRESS_32` mode).

### 2.1 WGSL module contents

| Group | Functions (PNanoVDB-equivalent naming) | Notes |
|---|---|---|
| Buffer reads | `read_uint32/uint64(→vec2u)/float/coord/vec3` | grid bound as `var<storage, read> pnanovdb_buf_data: array<u32>` |
| Handles/getters | grid, tree, root, tile, upper, lower, leaf accessors; bbox, map, voxel size, grid type/class | struct offsets as baked `const`s, cross-checked against upstream stride-validation table |
| Coordinate math | `world_to_index` / `index_to_world` (+ direction variants), leaf/lower/upper coord hashing | `Map` float copies only — no f64 anywhere |
| Value access | `root_get_value_address(_and_level)`, readaccessor `init/get_value/is_active/get_dim` with 3-level bottom-up cache | amortized O(1) coherent lookups |
| Quantized decode | `leaf_fp4/fp8/fp16/fpn_read_float` | v1 grid types: Float, Fp8, FpN (FogVolume) |
| Sampling | nearest; trilinear (8 accessor taps) | triquadratic later if needed |
| Traversal | `hdda_init/step/update/ray_clip`, `zero_crossing` | HDDA = empty-space skipping; zero_crossing enables level-set rendering nearly for free |
| Stats | node min/max/avg/stddev readers | drives adaptive step size |

### 2.2 TS loader (`NanoVDBFile`)

- Parse `.nvdb` FileHeader (16 B) + per-grid FileMetaData (176 B + name);
  also accept raw-grid-buffer files (magic `NanoVDB0/1/2` sniffing).
- Codec support: `NONE` (slice), `ZIP` (fflate). `BLOSC`: not v1 — document
  "re-export with `--zip` or codec NONE".
- Expose: grid list with metadata (type, class, bbox, voxel size, counts),
  `gridImage(i): Uint32Array` (zero-copy view where possible).
- Validation: magic, version, checksum-present flag, grid type ∈ supported
  set; helpful errors ("this is a Double grid — re-export as float/fp8").

## 3. Package 2: `three-nanovdb` — TSL / three.js layer

### 3.1 `NanoVDBGrid`

Wraps one grid image: creates the `StorageBufferAttribute`, exposes metadata
(world bbox → `Box3`, index transform → `Matrix4`), and hands nodes to
materials. Owns the `wgslFn` include wiring so consumers never see raw WGSL.

```js
const file  = await NanoVDBFile.fromURL('cloud.nvdb');
const grid  = new NanoVDBGrid(file.grids[0]);          // GPU-ready
const cloud = new NanoVDBVolumeMaterial({ grid });      // fragment raymarch
scene.add(new Mesh(grid.proxyGeometry(), cloud));       // bbox-fitted box
```

### 3.2 `NanoVDBVolumeMaterial` (the cloud renderer — main goal)

Fragment-stage raymarch in a `NodeMaterial`, sampling the storage buffer
directly (no 3D-texture intermediary):

1. Ray setup in the grid's index space from the proxy box (`RaymarchingBox`
   TSL helper pattern), `hdda_ray_clip` against root bbox.
2. March: HDDA at node granularity to skip inactive space; inside active
   regions, fixed-step density sampling via a per-ray readaccessor; step
   size modulated by node max-density stats.
3. Lighting (cloud look): Henyey–Greenstein phase, N-step sun shadow march
   (secondary readaccessor), ambient/sky term hook; premultiplied
   emission+transmittance out.
4. Params: `densityScale`, `stepSize/maxSteps`, `sunDirection/color`,
   `anisotropy (g)`, `shadowSteps`, blue-noise jitter toggle.
5. Depth-aware compositing hook (scene depth → clip `tMax`) so volumes sit
   in scenes correctly — v1.1, not v1.0.

### 3.3 Compute utilities

- `decodeToAtlas(grid, resolution)` — compute pass writing a brick/dense
  `Data3DTexture` (`r8unorm`/`r16float`): the mobile/compat fallback and the
  bridge to three's stock `VolumeNodeMaterial`.
- `gridStats(grid)` — histogram/min-max readback (validation + explorer).
- `valueTransform(grid, fn)` — in-place value edits (topology fixed);
  demonstrates the "GPU toolset" beyond rendering.

### 3.4 Renderer bootstrap helper

`createVolumeRenderer(opts)` → `WebGPURenderer` constructed with
`requiredLimits` raised to `min(adapter.limits, needed(gridBytes))` +
feature detection (`shader-f16`, `float32-filterable`) + a capability report
object. (Three.js won't do this for us — documented trap.)

### 3.5 Sequence player (wishlist, phased)

`NanoVDBSequence`: manifest of per-frame `.nvdb` URLs; prefetch ring
(decode-ahead N frames), staging-belt buffer rotation, frame-time scheduler.
v1: desktop, uncompressed frames, hold-last-frame on stall. v2: delta/
interpolation ideas from unreal-vdb/mgr-vanim.

## 4. Package 3: `vdb-web-tools` — the WASM half

Built per the feasibility ladder (§6 there): rungs are releases.

| Release | Contents | API sketch |
|---|---|---|
| v0 (L0) | No WASM. Docs + scripts: `nanovdb_convert --fp8 in.vdb out.nvdb`, asset pipeline recipes for Houdini/Blender/EmberGen `.nvdb` export | — |
| v1 (L1) | Emscripten build of NanoVDB headers, single-threaded, no exceptions: `buildFromDense(Float32Array, dims, opts)`, `quantize(grid, 'fp8'|'fpn', tol)`, `readNvdb/writeNvdb`, `inspect(grid)` (tree stats, per-level counts, memory breakdown) | ~0.2–1 MB wasm, no COOP/COEP needed |
| v2 (L2) | In-browser `.vdb` → NanoVDB. Route decided by spike: (a) `vdb-rs`+wasm-bindgen with our VDB-tree→NanoVDB serializer, blosc replaced/feature-flagged; (b) minimal OpenVDB-core Emscripten (`openToNanoVDB`) | `parseVdb(ArrayBuffer) → grids[]` |
| v3 (L3, conditional) | OpenVDB tool ops: resample, filter, CSG, transform-with-rebuild, `.vdb` export | only if v2 took route (b) or (a) matured |

All builds ship as ESM + `.wasm` with a worker-wrapped async API
(`await VdbTools.load()`), zero SharedArrayBuffer requirements through v2(a).

## 5. Demos / examples (each is a phase gate)

| # | Demo | Proves |
|---|---|---|
| 01 | `hello-nvdb` — load `.nvdb`, compute-shader probe of known voxels, values printed vs `nanovdb_print` ground truth | contract + traversal correctness |
| 02 | `cloud` — WDAS quarter cloud (Fp8) fragment-raymarched with sun lighting, orbit camera, GUI | **main goal** |
| 03 | `gpu-read` — minimal annotated "read VDBs on the GPU" example (one file, heavily commented) | **main goal (educational)** |
| 04 | `atlas-fallback` — same cloud through compute→Data3DTexture→`VolumeNodeMaterial` | mobile/compat path |
| 05 | `embergen-sequence` — animated smoke playback with stats HUD | wishlist: animation |
| 06 | `explorer` — drag-drop `.nvdb`/`.vdb`(v2): metadata panel, node-bbox wireframes per level, slice view, histogram, memory breakdown | wishlist: technical tool |
| 07 | `builder` — author a grid in-browser (procedural dense → WASM build → render) | WASM v1 round-trip |

## 6. Test strategy

- **Fixtures:** upstream `createFogVolumeSphere/Torus/Box` primitives baked
  to `.nvdb` (tiny, exact analytic ground truth) + WDAS cloud (quarter/half,
  CC-BY-SA) + EmberGen free pack frames (CC0-style).
- **Traversal unit tests:** compute-shader probes over fixture grids;
  compare N random active/inactive/boundary voxels + trilinear samples
  against CPU reference values exported at fixture-bake time (JSON
  sidecars). This is the WGSL equivalent of upstream's
  `pnanovdb_validate_strides.h` plus value-level checks.
- **Image tests:** golden renders of demo 02 at fixed camera/params, SSIM
  threshold; run via headless Chromium (Playwright, pre-installed).
- **Perf gates:** demo 02 ≥ 60 fps @ 1080p on a mid desktop GPU, and a
  tracked ms-budget table (raymarch pass, shadow march, upload) via GPU
  timestamps (`trackTimestamp`).
- **WASM tests:** node-side round-trips (dense→grid→.nvdb→parse→values).

## 7. Explicit non-goals (v1)

- GPU-side topology mutation / simulation (NanoVDB is read-only topology by
  design; edits round-trip through WASM).
- BLOSC decode in browser; Double/Vec3d/Int64/points grids; multi-GB
  out-of-core grids (brick-cache streaming is the documented v2 path).
- WebGL2 fallback; mobile-first performance targets.
- PicoVDB-format adoption (blocked on licensing; tracked as an optimization).
