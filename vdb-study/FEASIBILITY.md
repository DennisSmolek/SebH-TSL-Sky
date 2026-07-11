# Feasibility Study: NanoVDB Rendering on WebGPU + WASM VDB Tooling

**Date:** 2026-07-11 · **Status:** Draft for review · **Verdict: FEASIBLE** — with
one architecture decision (the CPU/WASM half) that needs a call from us.

---

## 1. The goals, restated

A **twin effort**:

1. **GPU half** — a "NanoVDB for WebGPU" toolset: upload a NanoVDB grid to the
   GPU as-is and traverse/sample it directly in WGSL shaders (fragment
   raymarch for rendering, compute for operations). Three.js (WebGPURenderer +
   TSL) as the host renderer. **Main goal: render VDB cloud forms (e.g.
   Houdini/EmberGen-authored) with a real sparse-grid raymarch, no dense-bake
   tricks. Main goal: a WebGPU example of reading VDBs on the GPU.**
2. **CPU half** — a WASM-based tool wrapping native VDB libraries for the
   things a GPU can't do: parsing `.vdb` files, converting to the GPU-ready
   NanoVDB layout, and (wishlist) transforms, export, and inspection.

Wishlist: transforms, `.vdb` export, animated sequences (EmberGen smoke),
and a technical "VDB explorer" tool.

---

## 2. Verdict summary

| Question | Answer |
|---|---|
| Can WGSL traverse a NanoVDB grid natively? | **Yes — proven.** PNanoVDB's 32-bit addressing mode is u32-only by design; a working WGSL port with live demo exists (Apache-2.0). |
| Can Three.js TSL host it? | **Yes.** Read-only storage buffers work in fragment-stage node materials; raw WGSL injects via `wgslFn`; `Loop`/`struct`/compute all shipping. |
| Can we render clouds without dense-texture tricks? | **Yes.** HDDA empty-space skipping + per-node min/max stats over the flat buffer is the canonical NanoVDB fog-volume render path, and it maps to WGSL cleanly. |
| Can we load Houdini/EmberGen VDBs? | **Yes, in stages.** `.nvdb` (which Houdini, Blender ≥3.x, and EmberGen can all export directly) is a zero-parse upload today; in-browser `.vdb` parsing is real work with three viable routes (§6). |
| Full native OpenVDB in WASM? | **Hard; nobody has shipped it.** Blockers are the deps (Boost, TBB, Blosc under Emscripten), not the core code. Resolved (D3): CPU path is pure TS; WASM is a targeted, optional escalation (§6). |
| Animated VDB sequences on the web? | **Feasible on desktop, green-field.** Nothing exists to reuse; upload bandwidth math works (§8). |
| GPU-side limits? | NanoVDB is **read-only topology** on GPU: values can be edited in compute, topology (adding/removing active voxels) requires a CPU/WASM rebuild. Fine for rendering + playback; rules out GPU-side simulation. |

---

## 3. Why NanoVDB is the right GPU format (background)

A NanoVDB grid is a **single contiguous, pointer-free memory block** — an
immutable snapshot of an OpenVDB tree where every cross-reference is a byte
offset. Layout (from `NanoVDB.h`):

```
[GridData 672B][TreeData 64B][RootData + tiles][all 32³ upper nodes][all 16³ lower nodes][all 8³ leaves][blind data]
```

- Fixed 4-level tree, same as OpenVDB's default: root → 32³ upper → 16³ lower
  → 8³ leaf (512 voxels). No recursion, no stack: every lookup is the same
  4-step descent.
- Everything is 32-byte aligned; the raw bytes can be `memcpy`'d into a
  `GPUBuffer` at offset 0 with **zero transformation**. Nothing "loads" the
  grid on the GPU — the blob *is* the runtime data structure.
- Bit masks (active-voxel/child masks) are stored as 64-bit words in C++, but
  PNanoVDB reads them as u32 words — masks never need 64-bit math in shaders.
- Every node stores min/max/avg/stddev of its subtree — free acceleration
  data for adaptive stepping and empty-space skipping.
- **Quantized leaf types** matter enormously for clouds: `Fp4/Fp8/Fp16/FpN`
  store per-leaf fixed-point codes (`value = code × quantum + minimum`).
  Fp8 ≈ 3.5× smaller than float leaves, FpN up to ~13×, with decode costing
  one extra multiply-add per sample. NVIDIA's blanket claim: 4–6× with little
  to no visible artifacts.

**Reference sizes** (Disney/WDAS cloud, the standard benchmark): half-res
(1000×680×1224) is 3.3 GB dense, ~585 MB as sparse float VDB, **~170 MB as
Fp8, ~100–130 MB as FpN**. Quarter-res in Fp8 fits inside WebGPU's *default*
128 MiB storage-binding limit. Typical EmberGen per-frame grids are single-
digit MB (quantized) to low-tens-of-MB (float).

### PNanoVDB: the portability layer that solves the 64-bit problem

`PNanoVDB.h` is the official pointer-less C99/HLSL/GLSL port of the NanoVDB
read path. Its `PNANOVDB_ADDRESS_32` mode (the default for HLSL/GLSL) was
*designed* for shading languages without 64-bit integers:

- The grid buffer is an array of **u32 words**; the fundamental read is
  `buf.data[byte_offset >> 2]`. All address math is pure u32.
- 64-bit values (root keys, child offsets, magic) are `uvec2` pairs with
  u32-only helper ops; the root key computation has an explicit non-64-bit
  fallback.
- WGSL has every bit op the traversal needs: `countOneBits`,
  `countTrailingZeros`, `extractBits`, `bitcast<f32>`. WGSL's missing i64/u64
  (still an open proposal upstream) is a **non-issue** for grids < 4 GiB.
- Struct offsets are baked constants (`PNANOVDB_GRID_SIZE 672`, leaf value
  table at +96, etc.), validated against C++ by an upstream unit test — so a
  WGSL port is mechanical transliteration, not reverse-engineering.
- PNanoVDB also ships the traversal algorithms: `readaccessor` (bottom-up
  cached lookups — amortized O(1) for coherent access like raymarching),
  `hdda_*` (hierarchical DDA: step size snaps to node granularity, so cost is
  proportional to *occupied* regions crossed, not resolution), and
  `zero_crossing` (level-set hits). All float/i32/u32 math — WGSL-clean.

**Cost of one uncached lookup** (float grid, single-root-tile cloud):
~9–12 dependent u32 loads; ~1–3 with a warm accessor cache.

---

## 4. Prior art — what exists, what's reusable

| Project | What it is | License / status | Reusable? |
|---|---|---|---|
| [emcfarlane/webgpu-nanovdb](https://github.com/emcfarlane/webgpu-nanovdb) | **Direct WGSL port of PNanoVDB** (`pnanovdb.wgsl`): grid as `array<u32>` storage buffer, readaccessor + float sampling, compute-shader raymarch demo | Apache-2.0; active Nov 2025–Jun 2026; young (single author, few commits) | **Yes — the key building block.** Foundation or reference for our GPU half. |
| [emcfarlane/picovdb](https://github.com/emcfarlane/picovdb) | WebGPU-native sparse format derived from NanoVDB: 32-bit addressing, rank-query bitmask compression (bunny: 28 MB vs 64 MB NanoVDB), Zig `.nvdb→.pvdb` converter, TS loader, HDDA WGSL | **No license published**; format/API unstable | Architecturally the best model; **legally blocked** until licensed. Worth an issue asking the author. |
| [mjurczyk/openvdb](https://github.com/mjurczyk/openvdb) | Pure-JS `.vdb` parser (zlib via pako, blosc via numcodecs, half-float) + WebGL dense-3D-texture renderer | MIT; **dormant since June 2023** (three r153) | Parser logic liftable as reference; renderer is out (per our decision: CPU work goes to WASM, and it's WebGL-era anyway). |
| [Traverse-Research/vdb-rs](https://github.com/Traverse-Research/vdb-rs) | Best-engineered `.vdb` parser outside C++ (pure Rust; zlib, half; blosc via C `blosc-src`) | MIT; moderate activity | **Yes for the WASM half** — wasm32 blocked only by the C blosc dep (feature-flag it off, or swap a pure-Rust LZ4 decode). No writing, no points grids. |
| three.js `VolumeNodeMaterial` + `webgpu_volume_cloud`, `webgpu_compute_texture_3d`, `RaymarchingBox` TSL helper | Official TSL volume raymarch over `Data3DTexture`; compute-writes-3D-texture skeleton | MIT; maintained | **Yes** — the dense fallback path and TSL raymarch scaffolding. |
| [andersblomqvist/unity-nanovdb-renderer](https://github.com/andersblomqvist/unity-nanovdb-renderer) | PNanoVDB in Unity HLSL fragment raymarch | active 2025 | Readable reference for fragment-stage traversal + fog lighting. |
| Will Usher: [webgpu-volume-raycaster](https://github.com/Twinklebear/webgpu-volume-raycaster) / [-pathtracer](https://github.com/Twinklebear/webgpu-volume-pathtracer) / [webgpu-bcmc](https://github.com/Twinklebear/webgpu-bcmc) | WebGPU dense raycaster, delta-tracking path tracer, GPU brick-cache + decompression-on-demand (terascale-in-browser paper) | MIT | WGSL liftable; brick-cache architecture is the blueprint for streaming/large volumes. |
| [openvdb/nanovdb-editor](https://github.com/openvdb/nanovdb-editor) | New official NanoVDB editor/viewer | Apache-2.0; Vulkan/Slang desktop-only | Not directly; possible server-render fallback someday. |
| [eidosmontreal/unreal-vdb](https://github.com/eidosmontreal/unreal-vdb) (archived), [mgr-vanim](https://github.com/betonowy/mgr-vanim) | NanoVDB sequence playback in Unreal; VDB animation-compression thesis | archived / thesis | Design references for animated sequences (frame residency, interpolation, lossy sequence formats). |
| [MeshInspector web VDB viewer](https://meshinspector.com/3d-viewers/vdb/) | Commercial WASM in-browser VDB viewer | closed | Proof the WASM-parse approach ships commercially. Nothing to reuse. |

**Notably absent:** any official ASWF WGSL/WebGPU support (a GitHub-wide
search finds only emcfarlane's port); any shipped OpenVDB-in-WASM; any web
player for VDB sequences; any wgpu/Bevy VDB renderer crate. The field is
open — this project would be near the front of it.

---

## 5. Platform constraints (the numbers that shape the design)

### WebGPU limits

| Limit | Default | Desktop adapters typically allow |
|---|---|---|
| `maxStorageBufferBindingSize` | **128 MiB** | ~2 GiB |
| `maxBufferSize` | 256 MiB | ~4 GiB |
| `maxStorageBuffersPerShaderStage` | 8 (4 in fragment under compat mode) | — |
| `maxTextureDimension3D` | 2048/axis | — |

- Read-only storage buffers in **fragment** shaders are core WebGPU — the
  fragment-raymarch design is legal everywhere.
- Limits must be requested at device creation.
  **Three.js trap:** `WebGPURenderer` requests *default* limits and won't
  auto-raise them (upstream issue closed as not-planned) — we must construct
  it with `requiredLimits` (and query `adapter.limits` first). Mandatory for
  any grid > 128 MiB.
- Mobile realistically stays at the 128 MiB default → quantized grids and/or
  a brick-atlas 3D-texture fallback are the mobile story. `r8unorm`/`r16float`
  3D textures are filterable everywhere; `r32float` filtering is an optional
  feature.
- `shader-f16` is widely available on desktop + Apple mobile (feature-detect),
  absent on a chunk of Android. Useful, not load-bearing.

### Three.js TSL (r178+, verified against dev docs)

- `storage(attr, 'uint', count).toReadOnly()` → readable in `colorNode`
  (fragment). Externally created `GPUBuffer`s are not first-class; the
  renderer owns uploads via `StorageBufferAttribute`.
- `wgslFn(code, [includes])` injects raw WGSL; storage buffers pass as
  `ptr<storage, array<u32>, read>` params. **This is the realistic path for
  reusing ~2k lines of ported PNanoVDB WGSL instead of re-authoring it node
  by node.** (Known rough edges around access-mode mismatches — a spike
  validates this early.)
- `texture3D`, `Loop` (real GPU loop with `Break`/`Continue`), `struct`,
  `Fn().compute(n)` + `renderer.computeAsync`, buffer readback via
  `getArrayBufferAsync` — all shipping. `webgpu_volume_cloud` and
  `webgpu_compute_texture_3d` are direct templates.
- WGSL has no preprocessor: PNanoVDB.h can't be `#include`d; the GLSL-mode
  code paths must be transliterated (mechanical — GLSL mode already avoids
  overloads and pointers).

### File format / transport

- `.nvdb` with `Codec::NONE` is a **zero-parse upload**: skip the 16-byte
  FileHeader + 176-byte-per-grid metadata, `memcpy` the grid image into the
  storage buffer. Since v32.6 a "raw grid buffer" variant exists where the
  file *is* the grid image. ZIP codec needs pako/fflate; BLOSC needs a wasm
  build. Best transport: `Codec::NONE` + HTTP brotli/gzip (quantized flat
  buffers still compress well).
- Houdini (`vdbtonanovdb` SOP), Blender ≥3.x, and EmberGen all export
  `.nvdb` directly; the official `nanovdb_convert` CLI converts and
  quantizes (`--fp8`, `--fpN` with tolerance).

---

## 6. The CPU half — options analysis *(updated per [DECISIONS.md](./DECISIONS.md) D3)*

### Why native OpenVDB can't be "just wrapped"

Wrapping applies to libraries that already run on the target platform. WASM
is a different platform: Emscripten provides no system libraries, so OpenVDB
**and its entire dependency tree** must be cross-compiled from source —
Boost, Blosc, and TBB, a threading runtime that in the browser requires Web
Workers + SharedArrayBuffer and therefore COOP/COEP headers on every
deployment. It is a porting project, not a binding project; nobody has
shipped it, and the only TBB-wasm port is stale/unofficial. Expect 5–15 MB
of .wasm if it works at all.

### What each option actually delivers

The pivotal observation: **the hard part — building a valid NanoVDB tree
from parsed voxel data — must be hand-written by us in every realistic
option except full OpenVDB.** Given that, the options compare as:

| Capability | Pure TS | vdb-rs→WASM | NanoVDB-only WASM | Full OpenVDB WASM |
|---|---|---|---|---|
| Parse `.vdb` (zlib — Blender/Houdini default) | ✅ we write it (proven viable in JS by prior art) | ✅ robust, exists | ❌ | ✅ |
| Parse `.vdb` (blosc) | ⚠️ optional third-party blosc-wasm codec | ⚠️ C dep to replace | ❌ | ✅ |
| `.nvdb` read/write | ✅ trivial | we'd write it | ✅ official code | ✅ |
| Build NanoVDB grid (render Houdini VDBs) | ✅ we write serializer | ✅ we write it (Rust) | ✅ official `createNanoGrid` | ✅ |
| Quantize Fp8/FpN | ✅ we implement | we implement | ✅ official | ✅ |
| Affine transforms | ✅ **metadata-only** (index→world Map edit) | ✅ | ✅ | ✅ |
| Resample / filter / CSG / topology ops | ❌ | ❌ | ❌ (values only) | ✅ |
| Export `.vdb` | ⚠️ feasible later (none/zlib) | ❌ read-only | ❌ | ✅ |
| Bundle / toolchain | zero wasm, zero toolchain | ~0.3 MB wasm + Rust | ~0.5–1 MB wasm + Emscripten | 5–15 MB, high build risk, COOP/COEP |

### Decision (D3): pure TypeScript first, WASM as targeted escalation

The v1 CPU path is **pure TS**: `.vdb` parse (zlib; blosc optional),
NanoVDB serialization, quantization, affine transforms, `.nvdb` I/O —
one language across the project, browser-debuggable, zero deployment
friction, validated byte/value-wise against official `nanovdb_convert`
output on fixtures. At the agreed desktop-scale assets (D4), JS parse
performance is a non-issue (prior art's memory ceiling was hit on
cinema-scale grids only).

WASM rungs are adopted only on demonstrated need:
- **W1: NanoVDB-only WASM** (header-only, single-threaded, ~0.5–1 MB, no
  COOP/COEP) — official builder as a correctness/perf backstop for the TS
  serializer.
- **W2: OpenVDB WASM** — paper-only. Ops the browser stack can't do yet
  (`.vdb` export, resample, CSG, blosc, batch conversion) run interim on a
  **native OpenVDB companion service** (Docker + thin wrapper; same image
  as the fixture-bake environment) — but per D6 the mission is
  browser-first: every service endpoint has a named TS/WGSL successor
  (TS `.vdb` writer, blosc-wasm codec, GPU-compute resample → TS tree
  rebuild), and shrinking the service to zero is tracked roadmap work, not
  a wish. Note: standalone NanoVDB cannot write `.vdb` at all (that
  direction requires OpenVDB linked in) — export was always full-OpenVDB
  territory natively, which is exactly why the TS writer matters.

---

## 7. GPU-half design consequences (what the research dictates)

- **Traversal source:** build on Apache-2.0 `pnanovdb.wgsl`
  (emcfarlane/webgpu-nanovdb) — audit + extend rather than port from scratch;
  fill gaps against upstream `PNanoVDB.h` (HDDA, Fp4/8/16/FpN decoders,
  trilinear sampling via 8 accessor taps). Upstream our fixes where sensible.
- **Two consumption modes, one WGSL core:**
  - *Fragment raymarch* (the "no tricks" main goal): box/bbox entry →
    `hdda_ray_clip` vs root bbox → HDDA coarse skip → fixed-step density
    accumulation inside active regions, per-node max-density stats for
    adaptive stepping; Henyey–Greenstein phase + sun shadow march for the
    cloud look.
  - *Compute* — the "toolset": decode-to-brick-atlas (feeding the dense
    fallback / mobile path), min/max & histogram analysis, value edits.
- **Grid types for v1:** `Float` + `Fp8`/`FpN` FogVolume (covers clouds/smoke);
  `Vec3f` later for velocity/color.
- **Read-only topology on GPU** is a hard boundary: state it in the API docs;
  topology edits round-trip through WASM (L1 rung).

## 8. Animated sequences (EmberGen) — feasibility math

Per-frame `.nvdb` grids at 24 fps: a 100 MB/frame (very heavy) sequence needs
2.4 GB/s sustained upload — within PCIe 3.0 (~16 GB/s) and trivial on Apple
silicon, but demands a **staging-belt** (N pre-mapped buffers rotated on
`mapAsync` callbacks) rather than naive `writeBuffer`/`needsUpdate`. Typical
quantized EmberGen frames are single-digit MB → easy, with prefetch +
double-buffer. Nothing exists to reuse (green-field); unreal-vdb and the
mgr-vanim thesis are the design references. Frame interpolation and delta
compression are v2 concerns. JangaFX publishes **free EmberGen VDB animation
packs** — our test corpus, alongside the CC-BY-SA Disney cloud.

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `wgslFn` + storage-buffer pointer params have rough edges in three.js | Medium — it's the load-bearing integration | Phase-1 spike proves the exact binding pattern before anything else builds on it; fallback is authoring traversal in pure TSL nodes (more work, same output) |
| emcfarlane port is young/single-author | Low | It's a reference, not a dependency: ~2k lines we audit line-by-line against `PNanoVDB.h` + upstream's stride-validation test, with our own unit harness |
| Mobile (128 MiB binding, compat-mode fragment limits) | Medium | Quantized grids; brick-atlas Data3DTexture fallback via compute decode — designed in from the start, not bolted on |
| OpenVDB-in-WASM turns into a tar pit | High if we bet on it | Eliminated as a bet by D3: CPU path is pure TS; OpenVDB-WASM is an optional, timeboxed W2 rung |
| TS NanoVDB serializer has correctness bugs (hand-built tree/masks/offsets) | Medium | Byte/value-level validation against official `nanovdb_convert` output on every fixture; W1 (NanoVDB-WASM official builder) as backstop if divergence resists debugging |
| Per-pixel dependent loads (9–12 per uncached lookup) tank fragment perf on big grids | Medium | Readaccessor caching (coherent rays amortize to ~1–3 loads), HDDA skipping, node-stat adaptive steps; compute-to-atlas path as the perf escape hatch; benchmark gate in the plan |
| picovdb license never materializes | Low | We don't depend on it; if it's licensed later, its 32-bit format is an optimization to adopt |
| Grid > raised binding limit (multi-GB cinema assets) | Low for stated goals | Out of scope v1; Usher's brick-cache architecture is the documented v2 path |

## 10. Open questions — RESOLVED

All five review questions were answered 2026-07-11; see
[DECISIONS.md](./DECISIONS.md) (D1 new repo · D2 adopt + vendor-fork the
existing WGSL port · D3 pure-TS CPU path, WASM as escalation · D4
desktop-only, modest assets, device-first creation · D5 package names).
