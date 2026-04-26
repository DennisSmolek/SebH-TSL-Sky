# Project notes for Claude Code

This project ports Sebastien Hillaire's atmospheric sky (EGSR 2020) to
Three.js TSL on the WebGPU backend. PLAN.md is the design source of truth;
this file captures repeated traps so future sessions don't relearn them.

## Architecture in one paragraph

A **split-scene bake-first** design. `SkyAtmosphereBaker` owns a private sky
scene containing a single `SkyAtmosphereMesh`, plus three LUTs
(Transmittance → MultiScatter → SkyView), a `CubeRenderTarget`, a
`CubeCamera`, and a `PMREMGenerator`. Caller invokes `baker.update()` per
frame; it cascades dirty flags (atmos→full chain, sun→SkyView+cube+PMREM).
The main scene uses `baker.environmentTexture` (PMREM-filtered) for IBL and
`baker.texture` (raw cube) for `scene.background`.

## Gotchas that have already burned a session each

### TSL `.toVar()` inside a JS-unrolled loop produces a giant shader

If a loop body calls `integrateScatteredLuminance` (or any function with
`.toVar()` declarations and texture samples), unrolling 64 × 20 iterations
produces a shader large enough to lock up WebGPU drivers (browser crash
plus brief OS hang). **Always wrap such loops in TSL `Loop({...}, ...)`**
rather than JS `for`. The accumulator pattern (declare `.toVar()` outside
the Loop, `.assign(reset)` at the start of each iter, `.addAssign` inside)
is the correct way to handle per-iteration state.

### `PMREMGenerator` API differs between WebGL and WebGPU

WebGL has `fromCubeRenderTarget(rt)`. **WebGPU has `fromCubemap(texture)`** —
pass `cubeRenderTarget.texture`, not the RT itself. Each call allocates a
fresh output RT, so dispose the previous one before reassigning.

### LUTs use `ILLUMINANCE_IS_ONE` — consumer must scale

Hillaire's integrator passes `globalL = 1.0`, so the LUTs store sky response
*per unit sun illuminance* — raw values are 0.001-0.04 and render as black
without scaling. `SkyAtmosphereMesh.luminanceScale` (default 40) multiplies
the SkyView sample at composite time. The standalone LUT debug pages
(`examples/11`, `12`) apply the same 40× factor in their display shaders.
This scale is currently tuned by eye; eventually it should be derived from
a physical sun-illuminance constant.

### Y-up world / Z-up LUT-frame coordinate dance

The Three.js scene is Y-up (sun direction in Y-up world space). The Sky-View
LUT internals use Z-up (matches Hillaire's HLSL convention). The
`SkyAtmosphereMesh` resolves this by computing the **frame-invariant scalars**
`viewZenithCosAngle` and `lightViewCosAngle` directly from Y-up vectors and
feeding them to `skyViewLutParamsToUv` — the LUT doesn't care which frame
generated those scalars. When `setSun` updates the LUT's sun uniform, it
synthesizes a Z-up vector with `z = sin(elevation)` so the LUT's internal
`dot(up=(0,0,1), sunDir)` lands on the correct value. **If the horizon ever
appears tilted on the mirror sphere, this is the first place to look.**

### Dev workflow with chrome-devtools-mcp

`chrome-devtools-mcp` is wired up at user scope. The standard loop is:
1. `npm run dev` (background) — Vite on port 5173
2. `mcp__chrome-devtools__navigate_page` to the example URL
3. `mcp__chrome-devtools__evaluate_script` with `() => document.querySelector('button')?.click()` to trigger the start gate
4. `mcp__chrome-devtools__wait_for` on a known text marker (`"MS :"`,
   `"FPS"`, etc.) to know when render finished
5. `take_screenshot` for visual verification, `list_console_messages` for
   logs, `evaluate_script` to mutate GUI sliders
6. The HF16 readback values in the info banner / console are **raw uint16
   bitpatterns**, not floats — decode by hand if you need the actual value
   (`exp = bits[14:10] - 15; mantissa_frac = bits[9:0]/1024; value = (1 + mantissa_frac) * 2^exp`)

### Vite HMR + WebGPU shader edits

Editing a TSL helper while a page is open often leaves the previous shader
binary cached. After non-trivial shader edits, **hard-reload**
(`navigate_page` with `ignoreCache: true`) before drawing conclusions about
shader behavior. The MS LUT "black" mystery during phase 1b debugging was
partly stale build cache.

### The benign `<!DOCTYPE` JSON parse error

Every page logs `Uncaught (in promise) SyntaxError: Unexpected token '<'`
once on load. It's a Vite or browser-extension probe hitting an asset path
that returns the index HTML. **Ignore unless it appears alone without other
errors.**

## File map

```
src/sky/
├── SkyAtmosphereBaker.js   public API (setSun, setAtmosphereParams, update)
├── SkyAtmosphereMesh.js    visible sky, samples SkyView LUT
├── AtmosphereParams.js     EARTH defaults + mergeAtmosphereParams
├── AtmosphereUniforms.js   create/updateAtmosphereUniforms (TSL uniform bundle)
├── shaders/atmosphere.tsl.js   density, phases, ray-sphere, UV remaps
├── luts/
│   ├── resolutions.js      LUT_RESOLUTIONS (override-able defaults)
│   ├── TransmittanceLUT.js 256×64, on atmos change
│   ├── MultiScatterLUT.js  32×32, on atmos change
│   └── SkyViewLUT.js       192×108, on sun OR atmos change
└── legacy/SkyMesh.js       Preetham (unused by baker v1, kept for reference)

examples/
├── 01-legacy-baked.html    full demo scene (mirror + ground + PBR sphere)
├── 02-hillaire-baked.html  same scene, separate page (currently identical)
├── 10-transmittance-lut.html  fullscreen TLUT view + readback
├── 11-multiscatter-lut.html   TLUT|MS split + ?debug=<mode> bisection
└── 12-skyview-lut.html        fullscreen SkyView LUT view (40× scaled)
```

## Reference repos

- `/Users/dex/Documents/GitHub/homefig/UnrealEngineSkyAtmosphere/Resources/`
  is Hillaire's authoritative HLSL. When porting any new helper, search
  there first — `RenderSkyRayMarching.hlsl`, `RenderSkyCommon.hlsl`,
  `SkyAtmosphereCommon.hlsl` are the load-bearing files.
