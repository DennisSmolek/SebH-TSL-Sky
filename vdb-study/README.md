# VDB-on-the-Web Study

> **Note:** This folder is a standalone study, unrelated to the sky/atmosphere
> code in the rest of this repository. It lives here only because this repo
> hosted the working session. The eventual build is expected to land in its
> own repository.

An investigation into loading and rendering OpenVDB/NanoVDB volumes on the
web: WebGPU + Three.js (TSL) for GPU-side rendering, WASM for CPU-side file
I/O and grid operations.

| Doc | Contents |
|---|---|
| [FEASIBILITY.md](./FEASIBILITY.md) | Research findings, prior art, platform constraints, verdict, risks |
| [SPEC.md](./SPEC.md) | What we will build: architecture, components, formats, APIs |
| [PLAN.md](./PLAN.md) | Phased build plan with sub-agent (Haiku/Sonnet/Opus) assignments and token/compaction strategy |

Research date: 2026-07-11. Verified against OpenVDB `master`
(NanoVDB ABI 32.9.1) and three.js r178+ TSL/WebGPURenderer.
