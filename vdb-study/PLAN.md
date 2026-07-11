# Build Plan: VDB-on-the-Web

**Status:** Draft for review · Executes [SPEC.md](./SPEC.md) if approved.
Phases are strictly gated: each ends with a runnable artifact + a written
handoff, so any later phase (or fresh session) can start from documents and
code alone, never from chat history.

## 0. Working method: sub-agents, models, tokens

### Model tiers

| Tier | Model | Used for |
|---|---|---|
| T1 | Haiku | Mechanical/scaffold work with exact instructions: repo scaffolding, fixture download/bake scripts, HTML demo boilerplate, doc formatting, running test matrices |
| T2 | Sonnet | Well-specified implementation with clear references: TS loaders, test harnesses, GUI panels, WASM build wiring, compute utilities from a written design |
| T3 | Opus | Novel/risky work: WGSL traversal audit, TSL `wgslFn` binding spike, raymarch material, lighting quality, L2 spike, phase reviews |

Rules of engagement:
- **Every sub-agent brief is self-contained**: goal, exact file paths, the
  relevant HANDOFF excerpts, acceptance test to run, and "do not touch"
  boundaries. Agents never need prior chat context.
- **T3 designs, T2 implements, T1 grinds.** Where a phase mixes tiers, the
  T3 output is a written mini-design that becomes the T2 brief.
- **Verification is a separate agent from implementation** whenever the
  implementer tier is T1/T2 (fresh eyes, cheap model, runs the gate).

### Compaction strategy

- `vdb-study/handoffs/PHASE-<n>.md` written at each gate: what exists, what
  the tests prove, key decisions + why, known debts, exact next-phase entry
  points. ~1 page max — the *tests and fixtures* are the real ground truth.
- A living `STATUS.md` (10 lines: current phase, gate state, blockers) is
  the only file a resuming orchestrator must read first.
- Long research artifacts (this study) are frozen; sessions cite them by
  section instead of re-deriving.
- Orchestrator context gets compacted at phase boundaries only — never
  mid-gate.

## 1. Phases

Effort keys: S ≈ a focused day, M ≈ 2–4 days, L ≈ 1–2 weeks (calendar-ish,
agent-parallelism can compress).

### Phase 0 — Scaffold + fixtures (T1/T2, S) ✅ gate: `npm test` green on stubs
- New repo (pending decision Q1): pnpm workspace with `packages/nanovdb-wgsl`,
  `packages/three-nanovdb`, `packages/vdb-web-tools`, `examples/`, Vite +
  Playwright + Vitest wiring.
- Fixture pipeline (T2): native `nanovdb_convert` + a tiny C++ bake program
  using upstream `createFogVolumeSphere/Torus/Box` → `fixtures/*.nvdb` +
  JSON sidecars (sampled ground-truth values, tree stats). Download scripts
  for WDAS cloud (quarter/half) + EmberGen free pack; assets git-ignored,
  fetched by script.
- Vendored references: `PNanoVDB.h` (pinned commit), `pnanovdb.wgsl`
  (Apache-2.0, with NOTICE), upstream stride tables extracted to JSON.

### Phase 1 — `.nvdb` loader + first GPU read (T2 impl, T3 review, M)
✅ gate: demo 01 `hello-nvdb` — compute probe values match sidecar ground truth
- `NanoVDBFile` TS loader (header/metadata/codec-NONE/ZIP, raw-buffer files).
- Minimal three.js compute dispatch reading GridData fields + a handful of
  voxels through a *hand-written subset* of traversal (root→leaf for one
  known coordinate) — proves buffer upload, alignment, and `wgslFn`/storage
  binding **before** the full port lands. This is the de-risking spike for
  the load-bearing TSL integration (feasibility risk #1); if `wgslFn`
  pointer-param binding misbehaves, we discover it here with 200 lines at
  stake, and the fallback decision (pure-TSL authoring) gets made at the
  cheapest possible moment.

### Phase 2 — Traversal core (T3 audit/port, T2 test harness, L)
✅ gate: WGSL unit suite green — N-thousand random probes (active/inactive/
boundary, all fixtures, Float+Fp8+FpN) + trilinear samples match CPU sidecars
- Audit `pnanovdb.wgsl` against `PNanoVDB.h` line-by-line; extend with what's
  missing (Fp decoders, HDDA family, readaccessor completeness, stats
  readers, world↔index map). Baked-const stride tables generated from the
  extracted JSON (T1 codegen script) so they're provably in sync.
- Compute-shader probe harness (T2): drives the suite from Vitest via
  headless Chromium, readback via `getArrayBufferAsync`.

### Phase 3 — Cloud material (T3, L) ✅ gate: demos 02 + 03 — WDAS cloud at
≥60 fps/1080p desktop, golden-image SSIM pass, annotated gpu-read example
- `NanoVDBGrid`, `createVolumeRenderer` (requiredLimits!), proxy-box
  raymarch, HDDA skip + stat-driven adaptive steps, HG phase + sun shadow
  march, jitter. GUI: density/steps/sun/g.
- Demo 03 (T2 from T3's material): the single-file, heavily-commented
  educational example — a stated main goal, treated as a deliverable with
  its own review, not an afterthought.
- Perf budget table established via GPU timestamps; recorded in handoff.

### Phase 4 — Compute toolset + fallback (T2 from T3 mini-design, M)
✅ gate: demo 04 — same cloud via compute→atlas→`VolumeNodeMaterial`; stats
utility validated against sidecars
- `decodeToAtlas`, `gridStats`, `valueTransform`.

### Phase 5 — WASM v1: NanoVDB-only (T2 build wiring, T3 API review, M–L)
✅ gate: demo 07 — in-browser dense→grid→render round-trip; node round-trip
tests green; wasm ≤ ~1 MB; no COOP/COEP
- Emscripten single-threaded build, worker-wrapped ESM API
  (`buildFromDense`, `quantize`, `readNvdb/writeNvdb`, `inspect`).

### Phase 6 — `.vdb` in the browser: spike then build (T3 spike, then route-
dependent tier, L) ✅ gate: demo 06 upgrade — drag-drop a Houdini/EmberGen
`.vdb` and render it
- Week-boxed parallel spike (two T3 agents): (a) `vdb-rs`→wasm32 + NanoVDB
  serializer PoC; (b) minimal OpenVDB-core Emscripten attempt. Decision memo
  → handoff; route (a) presumed winner per feasibility §6, (b) promoted only
  if it lands inside the box.
- Implementation on the chosen route (T2/T3 mix).

### Phase 7 — Sequences (T3 design, T2 impl, M–L) ✅ gate: demo 05 — EmberGen
sequence at 24 fps with stats HUD, no >1-frame stalls on target desktop
- `NanoVDBSequence`: prefetch ring, staging-belt uploads, scheduler.

### Phase 8 — Explorer + polish (T2/T1, M) ✅ gate: demo 06 complete —
metadata, per-level node bboxes, slices, histogram, memory breakdown; docs
site; README quickstarts; npm publish dry-run
- The "understand and explore VDBs" wishlist tool, assembled almost entirely
  from parts phases 1–6 already built.

## 2. Sequencing notes

- Phases 0–3 are the critical path to both main goals; 4–8 are
  independent-ish and parallelizable across agents once Phase 3's handoff
  exists (5 and 6 don't touch the GPU packages at all).
- Wishlist "transform VDBs / export as vdb": value transforms arrive free in
  Phase 4 (GPU) and Phase 5 (`writeNvdb`); full `.vdb` export + topology
  transforms ride Phase 6's route decision (feasibility ladder L3).
- Every phase's gate is machine-checkable (tests/perf/SSIM), so gate reviews
  are cheap T2 verification runs, with T3 review reserved for phases 2, 3,
  and 6.

## 3. Immediate next actions on approval

1. Resolve open questions (feasibility §10): repo, traversal base, L2
   framing, mobile posture, package naming.
2. Phase 0 kickoff: scaffold + fixture pipeline (needs a machine with native
   OpenVDB/NanoVDB tools for the one-time fixture bake — or a small Docker
   image so it's reproducible).
3. File the picovdb license question upstream (zero-cost, potential future
   win).
