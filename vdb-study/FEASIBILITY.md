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
| Full native OpenVDB in WASM? | **Hard; nobody has shipped it.** Blockers are the deps (Boost, TBB, Blosc under Emscripten), not the core code. We propose a ladder that gets the same user-facing results without betting the project on it. |
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

## 6. The CPU/WASM half — options ladder

Stated intent: **standard/native OpenVDB as the WASM component.** Honest
finding: full OpenVDB under Emscripten is a multi-week yak-shave nobody has
shipped — Boost + TBB (hard requirements) + Blosc + exceptions/RTTI, with
only a stale unofficial TBB-wasm port available; expect 5–15 MB of .wasm if
it works at all. Rather than bet the project on it, we propose a ladder where
each rung delivers user-visible capability and no rung blocks the GPU half:

| Rung | What | Deps | Effort | Delivers |
|---|---|---|---|---|
| **L0** | No WASM: offline `nanovdb_convert`; JS `.nvdb` loader (a header parse + slice) | none | days | Cloud rendering ships against `.nvdb` assets |
| **L1** | **NanoVDB-only WASM** (header-only C++, all deps optional, single-threaded Emscripten build, ~0.2–1 MB) | none | ~1–2 wk | In-browser grid *building* (`tools::build::Grid` + `createNanoGrid`): dense→NanoVDB, quantization, `.nvdb` read/write, stats — no OpenVDB needed (upstream `ex_make_custom_nanovdb` proves the no-dependency path) |
| **L2** | **In-browser `.vdb` parsing** — two candidate routes, pick after a timeboxed spike: (a) `vdb-rs` → wasm32 (drop/replace blosc; write the VDB-tree→NanoVDB-layout serializer ourselves), (b) minimal OpenVDB-core Emscripten build (`openToNanoVDB` path; fight Boost/TBB) | (a) Rust toolchain (b) Emscripten + dep ports | (a) ~2–4 wk (b) unbounded/risky | Drag-drop a Houdini/EmberGen `.vdb`, render it |
| **L3** | Full OpenVDB tools in WASM: transforms, filters, resampling, `.vdb` export | everything | large | Wishlist ops with the real library |

Recommendation: **L0 → L1 immediately; L2 via spike (route (a) favored on
evidence; route (b) timeboxed to one week before abandoning); L3 only if L2's
OpenVDB route lands.** If L2(b) fails, the wishlist "transform/export" goals
are served by L1 (NanoVDB has value transforms + `.nvdb` export) plus a
documented offline round-trip for `.vdb` export. Note: single-threaded WASM
builds avoid the SharedArrayBuffer/COOP/COEP deployment headache entirely;
pthreads would force cross-origin isolation headers on every host.

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
| OpenVDB-in-WASM turns into a tar pit | High if we bet on it | The §6 ladder: it's rung L2(b)/L3, timeboxed, with (a) as the favored route and L1 delivering most wishlist value regardless |
| Per-pixel dependent loads (9–12 per uncached lookup) tank fragment perf on big grids | Medium | Readaccessor caching (coherent rays amortize to ~1–3 loads), HDDA skipping, node-stat adaptive steps; compute-to-atlas path as the perf escape hatch; benchmark gate in the plan |
| picovdb license never materializes | Low | We don't depend on it; if it's licensed later, its 32-bit format is an optimization to adopt |
| Grid > raised binding limit (multi-GB cinema assets) | Low for stated goals | Out of scope v1; Usher's brick-cache architecture is the documented v2 path |

## 10. Open questions for review (decisions needed before build)

1. **Repo:** new dedicated repository (recommended — this is a standalone
   library + demos), or a package inside an existing monorepo?
2. **GPU traversal base:** adopt + audit `pnanovdb.wgsl` (recommended), or
   clean-room transliterate from `PNanoVDB.h`? (Apache-2.0 is compatible
   either way; clean-room costs ~1–2 extra weeks and buys provenance.)
3. **L2 route:** agree to the spike-then-decide framing, or is
   "native OpenVDB in WASM" a hard requirement worth the unbounded L2(b)
   effort up front?
4. **Mobile:** v1 target desktop-only with the fallback designed-in
   (recommended), or mobile as a v1 acceptance criterion?
5. **Naming/scope of the public package(s)** — e.g. `nanovdb-wgsl` (traversal
   module, renderer-agnostic) + `three-nanovdb` (TSL/three.js layer) +
   `vdb-web-tools` (WASM) as three artifacts vs one bundle.
