# Plain-Language Summary: A Scalable and Production Ready Sky and Atmosphere Rendering Technique

**Paper:** Sébastien Hillaire, Epic Games, Inc. — Eurographics Symposium on Rendering 2020
**Source code:** https://github.com/sebh/UnrealEngineSkyAtmosphere
**Shipped in:** Unreal Engine, Fortnite

---

## The one-sentence version

Hillaire shows a way to render realistic skies and atmospheres in real time — sunsets, space views, alien planets and all — that runs fast on everything from iPhones to high-end PCs, handles changing weather/time-of-day without hiccups, and approximates unlimited light bounces cheaply enough to run every frame.

## Why this paper exists

Rendering a planet's sky is harder than it sounds. Light coming from the sun doesn't just travel straight to your eye; it bounces around inside the atmosphere countless times. That's what gives you the blue daytime sky, the orange sunset, the pale band inside Earth's shadow at twilight, and so on.

Before this paper, game engines had two imperfect choices:

1. **Ray-march the atmosphere every frame, per pixel.** Accurate-ish, but expensive, and it usually ignored light bouncing more than once (so the sky looked flat).
2. **Precompute huge 3D/4D lookup tables (LUTs).** Fast to sample, but the tables took hundreds of milliseconds to rebuild whenever the weather, time of day, or atmosphere composition changed. You either accepted a delay (e.g. the sky lags behind the sun moving) or lived with visual artifacts at the horizon. And most of these methods only worked for one kind of atmosphere — fit it to Earth and it can't render Mars.

Hillaire wanted something that:

- Works from the ground, from the air, and from space.
- Handles any kind of atmosphere (Earth, Mars, weird fictional planets).
- Updates instantly when artists change parameters.
- Captures multiple light bounces (multiple scattering) cheaply.
- Runs on an iPhone 6s *and* a gaming PC.

## The core trick: small LUTs instead of giant ones

The paper replaces the expensive 4D lookup tables with four small, cheap ones:

### 1. Transmittance LUT (256 × 64)
A tiny 2D table that says "how much light survives travel from point A to point B through the atmosphere." Standard trick, nothing new here — it's reused from Bruneton & Neyret.

### 2. Sky-View LUT (200 × 100 on PC)
A small latitude/longitude image of the sky as seen from the camera's current position. The sky is mostly smooth and low-frequency — it doesn't need per-pixel detail. So render it at low resolution, then upsample it onto the screen.

The clever bit: they apply a non-linear mapping so more texels get packed near the horizon (where the interesting detail is) and fewer near the zenith (where things are smooth).

### 3. Aerial Perspective LUT (32³ volume)
A 3D "fog box" fit to the camera frustum. RGB stores how much atmosphere-light is added, A stores how much the scene behind is attenuated. Apply it like a post-process on opaque objects; sample it per-vertex for transparent objects. Gives you consistent atmospheric haze on terrain, buildings, clouds, glass — all of it.

### 4. Multiple Scattering LUT (32 × 32) — *this is the paper's main contribution*
See below.

## The clever idea: cheating multiple scattering

Multiple scattering is what makes a real sky look real. But computing it usually means iterating: first bounce, then second bounce, then third… each bounce is another full pass over the atmosphere. For dense atmospheres you might need 5, 10, 40 bounces to converge, which is way too expensive to do every frame.

Hillaire's insight, in plain terms:

1. **After the second bounce, light spreads in all directions roughly equally** (it becomes "isotropic"). So we can stop caring about phase functions and directions past bounce 2.

2. **Inside a small-ish neighborhood of a point, the incoming light is basically the same.** The atmosphere is big and smooth, so a few hundred meters in any direction doesn't change the illumination much.

3. **If you know the second-bounce contribution and you know how efficiently the medium transfers energy from nearby points**, you can compute the sum of all the remaining bounces (3rd, 4th, 5th… to infinity) as a simple geometric series: `1 + f + f² + f³ + ... = 1 / (1 - f)`.

That last equation is the magic. Instead of iterating bounces one at a time (O(n) work), you compute one "transfer factor" `f_ms`, plug it into a closed-form sum, multiply by the second-order luminance, and you've got infinite-bounce scattering in O(1). Every frame. No iteration. No lag.

It's inspired by a similar trick used in hair rendering ("dual scattering") by Zinke et al., 2008.

## How it compares to prior work (Results)

They compare against:

- **Bruneton [Bru17a]** — the prevailing state-of-the-art precomputed method.
- **A GPU path tracer** — the ground truth reference.

### Key findings:

- **Earth daytime and sunset:** Both Bruneton and Hillaire match the path-traced reference very closely. Hillaire's RMSE is slightly better.
- **Earth's shadow in the sky at twilight:** Both models reproduce the pale scattering band correctly.
- **Mars-like atmosphere:** Both work well; comparable RMSE.
- **Tiny fictional planets with thick atmospheres:** Bruneton's method struggles because its LUT parameterization assumes Earth-like curvature. Hillaire's works fine.
- **Dense atmospheres with many scattering orders:** Hillaire's method scales automatically. Bruneton's requires iterating the LUT once per scattering order — at 40 iterations it becomes impractical and actually *explodes numerically* due to precision issues. Hillaire's doesn't explode because the geometric-series math is energy-conserving by construction.

### Known limitations:

- Very high scattering coefficients can shift the hue away from ground truth.
- The "everything past bounce 2 is isotropic" assumption isn't strictly accurate — Mie scattering with a strong anisotropy parameter (g = 0.8) has RMSE of 0.039 vs 0.0058 for g = 0.0. Visually plausible, not physically exact.

## Performance

### PC (NVIDIA 1080) — 1280×720, ~0.31 ms total:

| LUT                | Resolution | Steps | Time    |
|--------------------|------------|-------|---------|
| Transmittance      | 256 × 64   | 40    | 0.01 ms |
| Sky-View           | 200 × 100  | 30    | 0.05 ms |
| Aerial perspective | 32³        | 30    | 0.04 ms |
| Multi-scattering   | 32²        | 20    | 0.07 ms |
| On-screen composite|            |       | 0.14 ms |

**Context:** Bruneton's method renders in 0.22 ms *if* its LUTs are already built. Actually rebuilding the LUTs costs **250 ms**, 99% of which is iterating multiple scattering. Hillaire's rebuilds everything every frame in 0.17 ms. That's the headline.

### Mobile (iPhone 6s): ~1 ms total for the whole sky (as shipped in Fortnite). Lower LUT resolutions and step counts, but the naked eye can't tell the difference.

### Space views:
The Sky-View LUT stops being useful (most of it is empty space), so the implementation switches to per-pixel ray marching. Total cost climbs to ~0.5 ms, which is fine because planetary views tend to have more rendering budget.

### Bonus: accelerating path tracing
The multiple scattering LUT can also shortcut a reference path tracer. Stop the path after the first scattering event, estimate single scattering normally, and read the remaining bounces out of the LUT. In their tests this dropped a 720p daytime path-traced frame from **7.9 ms to 0.6 ms** (with 50 scattering orders).

## Volumetric shadows (the hard-to-fake bit)

Mountains casting shadows into the air, sun beams ("god rays") through valleys — these are high-frequency effects the LUTs can't represent. For these, the paper recommends actual ray marching with:

- **Blue-noise jittered samples** (so visible noise averages out nicely).
- **Temporal reprojection** via TAA to accumulate samples across frames.
- **Optional lower-resolution tracing** with temporal upsampling for cheaper results.

With 32 samples per ray, that pushes total sky cost up to ~1 ms on PC. Still cheap.

## Future directions suggested by the author

- More accurate LUTs for anisotropic phase functions (the g = 0.8 problem).
- Spatially varying atmospheric conditions (e.g. smog over a city, clear elsewhere).
- Spectral rendering for more color accuracy.
- Real-time path tracing + denoiser for the whole sky pipeline.

## Why this paper matters

If you're building a game engine, a flight simulator, or anything that needs a believable sky, this is the reference implementation. It's been shipping in Unreal Engine since roughly 2020, which is why so many Unreal-powered games from that era onward have noticeably better skies than earlier work. The Epic/UnrealEngineSkyAtmosphere GitHub repo has runnable source.

The conceptual contribution that's most transferable beyond atmospheres: **the geometric-series trick for approximating infinite scattering bounces using a single transfer factor** — inspired by hair rendering, applied to air, probably applicable to other participating media (clouds, fog, translucent materials) with care.

## Glossary for non-graphics folks

- **Participating media:** Anything light interacts with as it travels through it. Air, fog, smoke, water, milk. Contrast with "vacuum" where light just goes in a straight line.
- **Scattering:** A photon bouncing off a particle and heading off in a different direction.
- **Absorption:** A photon being swallowed by a particle and converted to heat.
- **Rayleigh scattering:** What tiny molecules do to light. Wavelength-dependent — scatters blue way more than red. This is why the sky is blue.
- **Mie scattering:** What bigger particles (dust, water droplets) do to light. Mostly wavelength-independent, tends to scatter forward (toward the sun). This is why there's a bright halo around the sun and why clouds are white.
- **Phase function:** The probability distribution of which direction a scattered photon heads off in.
- **Isotropic:** Equal in all directions.
- **Single scattering:** The photon bounces once, then hits your eye.
- **Multiple scattering:** The photon bounces 2+ times before hitting your eye. Responsible for sky "glow" and the washed-out look of thick atmospheres.
- **Aerial perspective:** The haze/fog that makes distant mountains look pale and blue. It's just atmosphere between you and the thing.
- **LUT (Lookup Table):** A precomputed texture you sample at runtime instead of doing expensive math.
- **Ray marching:** Stepping along a ray in small increments, sampling at each step, and summing up the contributions. Slow but flexible.
- **Path tracing:** The "ground truth" rendering technique — simulate photons properly with Monte Carlo integration. Expensive but accurate.
- **RMSE:** Root Mean Square Error. Lower = closer to the reference.
