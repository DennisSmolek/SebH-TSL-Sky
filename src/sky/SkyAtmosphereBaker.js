import {
	Scene,
	CubeCamera,
	CubeRenderTarget,
	PMREMGenerator,
	HalfFloatType,
	LinearFilter,
	LinearMipmapLinearFilter,
	Vector3,
	MathUtils
} from 'three/webgpu';

import { EARTH, mergeAtmosphereParams } from './AtmosphereParams.js';
import { createAtmosphereUniforms, updateAtmosphereUniforms } from './AtmosphereUniforms.js';
import { LUT_RESOLUTIONS } from './luts/resolutions.js';
import { TransmittanceLUT } from './luts/TransmittanceLUT.js';
import { MultiScatterLUT } from './luts/MultiScatterLUT.js';
import { SkyViewLUT } from './luts/SkyViewLUT.js';
import { SkyAtmosphereMesh } from './SkyAtmosphereMesh.js';

/**
 * Phase 1b baker.
 *
 * Owns the three-LUT Hillaire pipeline (Transmittance → MultiScatter → SkyView)
 * and a visible `SkyAtmosphereMesh` that samples the Sky-View LUT. The mesh is
 * rendered into a CubeRenderTarget by a CubeCamera, then PMREM-filtered for
 * `scene.environment`.
 *
 * Public API is stable from phase 1a:
 *  - constructor(renderer, { cubeSize = 256, atmosphere?, lutResolutions? })
 *  - setSun({ elevation, azimuth })        — degrees
 *  - setAtmosphereParams(partial)          — merges onto current params
 *  - markCubeDirty()                       — force next update() to re-bake
 *  - update()                              — caller-driven; re-runs only dirty stages
 *  - .texture                              — raw cube (for scene.background)
 *  - .environmentTexture                   — PMREM-filtered (for scene.environment)
 *  - .sky                                  — the SkyAtmosphereMesh (for GUI access)
 *  - dispose()
 *
 * Dirty-flag semantics:
 *   atmosDirty  → Transmittance + MultiScatter + SkyView + cube + PMREM
 *   sunDirty    → SkyView + cube + PMREM          (T and MS do not depend on sun)
 *   cubeDirty   → cube + PMREM                    (e.g. markCubeDirty after direct mutation)
 */
export class SkyAtmosphereBaker {

	constructor( renderer, { cubeSize = 256, atmosphere, lutResolutions } = {} ) {

		this.renderer = renderer;
		this.cubeSize = cubeSize;
		this.lutResolutions = { ...LUT_RESOLUTIONS, ...( lutResolutions || {} ) };

		// --- atmosphere params + TSL uniform bundle ---
		this.atmosphereParams = mergeAtmosphereParams( EARTH, atmosphere );
		this.atmosphereUniforms = createAtmosphereUniforms( this.atmosphereParams );

		// --- LUT pipeline ---
		this.transmittanceLUT = new TransmittanceLUT( renderer, {
			resolution: this.lutResolutions.transmittance,
			atmosphereUniforms: this.atmosphereUniforms
		} );

		this.multiScatterLUT = new MultiScatterLUT( renderer, {
			resolution: this.lutResolutions.multiScatter,
			atmosphereUniforms: this.atmosphereUniforms,
			transmittanceLUT: this.transmittanceLUT
		} );

		this.skyViewLUT = new SkyViewLUT( renderer, {
			resolution: this.lutResolutions.skyView,
			atmosphereUniforms: this.atmosphereUniforms,
			transmittanceLUT: this.transmittanceLUT,
			multiScatterLUT: this.multiScatterLUT
		} );

		// --- sky scene + Hillaire mesh ---
		this.skyScene = new Scene();
		this.sky = new SkyAtmosphereMesh( {
			atmosphereUniforms: this.atmosphereUniforms,
			skyViewLUT: this.skyViewLUT
		} );
		this.sky.scale.setScalar( 450000 );
		this.skyScene.add( this.sky );

		// --- cube render target ---
		this.cubeRenderTarget = new CubeRenderTarget( cubeSize, {
			type: HalfFloatType,
			minFilter: LinearMipmapLinearFilter,
			magFilter: LinearFilter,
			generateMipmaps: true
		} );

		// --- cube camera ---
		// near/far chosen so the sky box (scaled 450000) is fully enclosed
		this.cubeCamera = new CubeCamera( 1, 1_000_000, this.cubeRenderTarget );
		this.skyScene.add( this.cubeCamera );

		// --- PMREM ---
		this.pmremGenerator = new PMREMGenerator( renderer );
		this.pmremGenerator.compileCubemapShader();
		this._pmremTarget = null; // PMREMGenerator.fromCubemap returns a new RT each call

		// --- dirty flags (all true on construction → first update() does a full bake) ---
		this.sunDirty = true;
		this.atmosDirty = true;
		this.cubeDirty = true;

		// Y-up world-space sun vector; assigned on setSun().
		this._sunVec = new Vector3( 0.0, 1.0, 0.0 );

	}

	get texture() {

		return this.cubeRenderTarget.texture;

	}

	get environmentTexture() {

		return this._pmremTarget ? this._pmremTarget.texture : null;

	}

	/**
	 * Set sun direction from (elevation, azimuth) in degrees. Convention matches
	 * the legacy example:
	 *   phi   = 90 - elevation   (polar angle from +Y)
	 *   theta = azimuth
	 *
	 * The resulting Y-up world vector goes to the sky mesh. The SkyView LUT lives
	 * in a Z-up local frame; we feed it a vector whose z-component equals the
	 * sun's zenith cosine (= sin(elevation) = world.y) so its internal
	 * `dot(up=(0,0,1), sunDir)` lands on the correct value. The LUT does not use
	 * sun azimuth internally — azimuth is consumed by the mesh at sample time via
	 * `lightViewCosAngle`.
	 */
	setSun( { elevation, azimuth } ) {

		const phi = MathUtils.degToRad( 90 - elevation );
		const theta = MathUtils.degToRad( azimuth );

		this._sunVec.setFromSphericalCoords( 1, phi, theta );

		// Y-up world sun → mesh uniform (same Vector3 instance is safe; uniform
		// tracks the internal reference).
		this.sky.sunDirection.value.copy( this._sunVec );

		// Z-up sun for SkyView LUT: only z matters (= sin(elevation)).
		const elevRad = MathUtils.degToRad( elevation );
		const cosE = Math.cos( elevRad );
		const sinE = Math.sin( elevRad );
		this.skyViewLUT.sunDirection = new Vector3( cosE, 0.0, sinE );

		this.sunDirty = true;
		this.cubeDirty = true;

	}

	setAtmosphereParams( partial ) {

		this.atmosphereParams = mergeAtmosphereParams( this.atmosphereParams, partial );
		updateAtmosphereUniforms( this.atmosphereUniforms, this.atmosphereParams );

		this.atmosDirty = true;
		this.cubeDirty = true;

	}

	/**
	 * Mark the cube bake as stale. Useful when something mutated sky uniforms
	 * directly without going through setSun/setAtmosphereParams.
	 */
	markCubeDirty() {

		this.cubeDirty = true;

	}

	/**
	 * Caller-driven. Does nothing unless something is dirty. Re-runs only the
	 * stages of the pipeline whose inputs changed.
	 */
	update() {

		if ( ! this.cubeDirty && ! this.sunDirty && ! this.atmosDirty ) return;

		// 1. LUTs
		if ( this.atmosDirty ) {

			this.transmittanceLUT.render();
			this.multiScatterLUT.render();
			this.skyViewLUT.render();

		} else if ( this.sunDirty ) {

			// T and MS are sun-independent; only SkyView needs a refresh.
			this.skyViewLUT.render();

		}

		// 2. Cube bake — sun disc OFF to keep PMREM clean (see PLAN.md risk #3).
		const prevShowSunDisc = this.sky.showSunDisc.value;
		this.sky.showSunDisc.value = 0;

		this.cubeCamera.update( this.renderer, this.skyScene );

		this.sky.showSunDisc.value = prevShowSunDisc;

		// 3. PMREM. WebGPU PMREMGenerator exposes `fromCubemap( texture )` (not the
		// WebGL-style `fromCubeRenderTarget`). It allocates a new RT each call, so
		// dispose the previous one first.
		if ( this._pmremTarget ) this._pmremTarget.dispose();
		this._pmremTarget = this.pmremGenerator.fromCubemap( this.cubeRenderTarget.texture );

		this.sunDirty = false;
		this.atmosDirty = false;
		this.cubeDirty = false;

	}

	dispose() {

		this.transmittanceLUT.dispose();
		this.multiScatterLUT.dispose();
		this.skyViewLUT.dispose();

		this.cubeRenderTarget.dispose();
		if ( this._pmremTarget ) this._pmremTarget.dispose();
		this.pmremGenerator.dispose();

		if ( this.sky.material ) this.sky.material.dispose();
		if ( this.sky.geometry ) this.sky.geometry.dispose();

		this.skyScene.remove( this.sky );
		this.skyScene.remove( this.cubeCamera );

	}

}
