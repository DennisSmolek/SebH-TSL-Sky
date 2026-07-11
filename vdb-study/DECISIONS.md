# Decisions Log

Resolved 2026-07-11 (review round 1). These supersede the corresponding
open questions in [FEASIBILITY.md](./FEASIBILITY.md) §10.

## D1 — Repo
Build proceeds in a **new dedicated repository** (created at Phase 0
kickoff). Until then, study docs live here on the working branch.

## D2 — GPU traversal base
**Adopt the existing Apache-2.0 `pnanovdb.wgsl` port** (emcfarlane/
webgpu-nanovdb). Treat it as experimental: we **vendor it as a fork from
day one** (pinned commit, NOTICE preserved, our fixes applied in-tree with
a diff log) rather than depending on the upstream repo — prepared to
diverge permanently, happy to upstream fixes if the author engages.

## D3 — CPU half: pure TypeScript first, WASM as targeted escalation
Native-OpenVDB-in-WASM is **not** a hard requirement. Since the hard part
(building a valid NanoVDB tree from parsed voxels) must be hand-written in
every realistic option anyway, we write the v1 CPU path in **pure
TypeScript**: `.vdb` parsing (zlib; blosc via optional third-party codec),
NanoVDB serialization, Fp8/FpN quantization, affine transforms
(metadata-only Map edits), `.nvdb` read/write. Validated byte/value-wise
against official `nanovdb_convert` output on fixtures.
WASM becomes escalation rungs, adopted only on demonstrated need:
- **NanoVDB-only WASM** — official `createNanoGrid` as a correctness/perf
  backstop for the TS builder.
- **OpenVDB WASM** — only if resample/filter/CSG/`.vdb`-export become
  priorities; timeboxed, never a foundation.

## D4 — Targets and device creation
**Desktop-only v1**, modest asset sizes (EmberGen/Houdini-scale grids, WDAS
quarter cloud as the stretch fixture — no full Disney-scale assets).
Device pattern per Dennis's prior success: **create the `GPUDevice`
ourselves** (adapter query → our `requiredLimits`/features) **and pass it
to `WebGPURenderer` at construction**, rather than relying on renderer
option plumbing. The mobile atlas fallback stays designed-in but untargeted.

## D5 — Package names (working titles, Claude's pick)
- `nanovdb-wgsl` — renderer-agnostic WGSL traversal module + TS `.nvdb` loader
- `three-nanovdb` — TSL/three.js layer (grid wrapper, materials, compute utils)
- `vdb-web-tools` — TS-first CPU tooling (parse/build/quantize/transform), with optional WASM add-ons

## D6 — Companion service supersedes OpenVDB-WASM for heavy ops
*(added review round 2)* `.vdb` file export is exclusively full-OpenVDB
territory (standalone NanoVDB writes only `.nvdb`; its `.vdb` direction
exists only when OpenVDB is linked in; picovdb is read-oriented). Rather
than ever porting OpenVDB to WASM, heavy/full-fidelity operations go to a
**native OpenVDB companion service** (Docker image + thin CLI/HTTP wrapper
on a server or cloud worker): `.vdb` export, resample, CSG,
mixed-transform merges, blosc, batch sequence conversion. The same image
is the Phase 0 fixture-bake environment — one artifact, two uses. The
browser TS layer still covers same-transform merges and (later) a basic
`.vdb` writer; the W2 (OpenVDB-WASM) rung is retained on paper only,
demoted to "revisit if a fully-offline browser requirement ever
materializes."
