import {
	BackSide,
	BoxGeometry,
	Mesh,
	Vector3,
	NodeMaterial
} from 'three/webgpu';

import {
	Fn,
	float,
	vec2,
	vec3,
	vec4,
	dot,
	normalize,
	cross,
	length,
	max,
	clamp,
	smoothstep,
	texture,
	modelViewProjection,
	positionWorld,
	cameraPosition,
	uniform
} from 'three/tsl';

import {
	raySphereIntersectNearest,
	skyViewLutParamsToUv
} from './shaders/atmosphere.tsl.js';

/**
 * Phase 1b visible sky — Hillaire LUT-sampled box mesh.
 *
 * Matches the shape of the legacy Preetham `SkyMesh` exactly: `BoxGeometry(1,1,1)`
 * with `BackSide` + `depthWrite=false` + the `z = w` vertex trick so the cube
 * always sits at the far plane. Only the fragment path changes — for each view
 * direction we un-map the Hillaire (viewZenithCos, lightViewCos) parameterization
 * and sample the Sky-View LUT.
 *
 * Port of the final-compose pass `RenderSkyWithLutsPS` in
 * `UnrealEngineSkyAtmosphere/Resources/RenderSkyRayMarching.hlsl:333`. Uses
 * `skyViewLutParamsToUv` (forward map) from `atmosphere.tsl.js`.
 *
 * Sun disc is rendered on top as a smoothstep against the angular diameter,
 * gated by `showSunDisc` (default 0 — off during bake to keep PMREM clean).
 *
 * Sun direction and up vector live in three.js-world Y-up coordinates (baked sky
 * scene uses the main scene's conventions). The Sky-View LUT itself is built in
 * a Z-up local frame, but the *UV parameterization* is frame-independent: it
 * only depends on (viewZenithCos, lightViewCos, viewHeight, intersectsGround),
 * which we compute here from the Y-up world vectors directly.
 */
export class SkyAtmosphereMesh extends Mesh {

	/**
	 * @param {object} args
	 * @param {object} args.atmosphereUniforms  bundle from createAtmosphereUniforms
	 * @param {SkyViewLUT} args.skyViewLUT      already-constructed Sky-View LUT
	 * @param {THREE.Vector3} [args.sunDirection]  initial Y-up world-space sun dir
	 * @param {THREE.Vector3} [args.upVector]      initial Y-up world-space up dir
	 */
	constructor( { atmosphereUniforms, skyViewLUT, sunDirection, upVector } = {} ) {

		if ( ! atmosphereUniforms ) throw new Error( 'SkyAtmosphereMesh: atmosphereUniforms is required' );
		if ( ! skyViewLUT ) throw new Error( 'SkyAtmosphereMesh: skyViewLUT is required' );

		const material = new NodeMaterial();

		super( new BoxGeometry( 1, 1, 1 ), material );

		this.atmosphereUniforms = atmosphereUniforms;
		this.skyViewLUT = skyViewLUT;

		/**
		 * Sun direction in Y-up world space (same frame as the main scene).
		 * Mutate in place or re-assign via `.sunDirection = vec`; the uniform
		 * tracks the Vector3 instance by reference.
		 *
		 * @type {UniformNode<vec3>}
		 */
		this.sunDirection = uniform(
			sunDirection instanceof Vector3 ? sunDirection.clone() : new Vector3( 0.0, 1.0, 0.0 )
		);

		/**
		 * Up vector in Y-up world space.
		 *
		 * @type {UniformNode<vec3>}
		 */
		this.upVector = uniform(
			upVector instanceof Vector3 ? upVector.clone() : new Vector3( 0.0, 1.0, 0.0 )
		);

		/**
		 * Whether to render the solar disc (float 0/1). Default 0 — the baker
		 * flips this on after the cube bake completes so main-scene renders can
		 * still see a sharp sun disc in the background.
		 *
		 * @type {UniformNode<float>}
		 */
		this.showSunDisc = uniform( 0.0 );

		/**
		 * Sun-disc intensity multiplier. Tuned to match the Sky-View LUT's
		 * radiance magnitude (which is already in "Mcd/m²"-like units from
		 * Hillaire's integrator). A value of ~20 reads as a bright sun without
		 * blowing out the IBL when this mesh is used outside a bake.
		 *
		 * @type {UniformNode<float>}
		 */
		this.sunIntensity = uniform( 20.0 );

		/**
		 * Global luminance multiplier applied to the Sky-View LUT sample.
		 *
		 * The LUTs are computed with Hillaire's `ILLUMINANCE_IS_ONE` convention
		 * — the integrator's `globalL = 1.0` means the LUT stores sky response
		 * *per unit sun illuminance*. Raw values are tiny (~1e-3 to 5e-2) and
		 * read as black on a linear-light display. The consumer is expected to
		 * multiply by the actual sun luminance at composite time
		 * (`RenderSkyWithLutsPS` in the Unreal reference does this via
		 * `Atmosphere.GlobalLuminanceScale` × sun terms).
		 *
		 * Default 40.0: produces a visibly bright sky under ACES with exposure
		 * 0.5, matching the legacy Preetham SkyMesh's perceived brightness.
		 * Tunable via the GUI.
		 *
		 * @type {UniformNode<float>}
		 */
		this.luminanceScale = uniform( 40.0 );

		/**
		 * Flag for type testing.
		 *
		 * @type {boolean}
		 */
		this.isSkyAtmosphereMesh = true;

		// --- vertex: same z=w trick as the legacy SkyMesh (keeps the cube at far plane) ---
		const vertexNode = /*@__PURE__*/ Fn( () => {

			const position = modelViewProjection;
			position.z.assign( position.w );
			return position;

		} )();

		// --- fragment: Sky-View LUT sample + sun disc ---
		const colorNode = this._buildColorNode();

		material.side = BackSide;
		material.depthWrite = false;
		material.vertexNode = vertexNode;
		material.colorNode = colorNode;

	}

	_buildColorNode() {

		const params = this.atmosphereUniforms;
		const skyViewTex = this.skyViewLUT.texture;
		const sunDirU = this.sunDirection;
		const upU = this.upVector;
		const showSunDiscU = this.showSunDisc;
		const sunIntensityU = this.sunIntensity;
		const luminanceScaleU = this.luminanceScale;

		return Fn( () => {

			// View direction from the camera to this fragment's world position.
			const viewDir = normalize( positionWorld.sub( cameraPosition ) );
			const upVec = normalize( upU );
			const sunDir = normalize( sunDirU );

			// Camera height: ground-based for phase 1b (matches the Sky-View LUT's
			// assumption that `viewHeight = bottomRadius + ε`). A tiny epsilon keeps
			// the ground-intersection test well-defined.
			const viewHeight = params.bottomRadius.add( float( 0.01 ) );

			// View-zenith cosine.
			const viewZenithCosAngle = clamp( dot( viewDir, upVec ), float( - 1.0 ), float( 1.0 ) );

			// Light-view cosine, per Unreal RenderSkyRayMarching.hlsl:325-329.
			// Build a stable on-plane basis perpendicular to up, aligned with the
			// view direction's horizontal component, then project the sun onto it.
			//
			//   sideVector    = normalize( cross(up, viewDir) )       (perpendicular to both)
			//   forwardVector = normalize( cross(sideVector, up) )    (in the horizontal plane,
			//                                                          same azimuth as viewDir)
			//   lightOnPlane  = normalize( (dot(sun, forward), dot(sun, side)) )
			//   lightViewCos  = lightOnPlane.x
			//
			// Degenerate case: viewDir is exactly ±up (looking at zenith/nadir),
			// `cross(up, viewDir)` is zero-length. We guard the normalize and the
			// resulting lightViewCos is meaningless there, but that texel isn't
			// azimuth-dependent anyway, so any value works.
			const sideRaw = cross( upVec, viewDir );
			const sideLen = max( length( sideRaw ), float( 1e-6 ) );
			const sideVector = sideRaw.div( sideLen );
			const forwardVector = normalize( cross( sideVector, upVec ) );

			const lightOnPlaneX = dot( sunDir, forwardVector );
			const lightOnPlaneY = dot( sunDir, sideVector );
			const lightOnPlaneLen = max( length( vec2( lightOnPlaneX, lightOnPlaneY ) ), float( 1e-6 ) );
			const lightViewCosAngle = clamp( lightOnPlaneX.div( lightOnPlaneLen ), float( - 1.0 ), float( 1.0 ) );

			// Ground intersection test. Unreal tests the planet from the camera
			// position; we use (0, viewHeight, 0) in Y-up — the planet centred at
			// origin with radius `bottomRadius`. Match the `>= 0` convention.
			const earthO = vec3( 0.0, 0.0, 0.0 );
			const ro = vec3( float( 0.0 ), viewHeight, float( 0.0 ) );
			const tPlanet = raySphereIntersectNearest( ro, viewDir, earthO, params.bottomRadius );
			const intersectsGround = tPlanet.greaterThanEqual( float( 0.0 ) );

			// Sky-View LUT UV + sample.
			const lutUv = skyViewLutParamsToUv(
				params,
				intersectsGround,
				viewZenithCosAngle,
				lightViewCosAngle,
				viewHeight
			);
			const skyColor = texture( skyViewTex, lutUv ).rgb.mul( luminanceScaleU );

			// Sun disc. Same `cos(angularDiameter) + 0.00002` smoothstep as legacy.
			// Unreal's `GetSunLuminance` uses `Atmosphere.SunDiscCosAngle`; we use
			// the Earth default from AtmosphereParams (`sunAngularRadius` ≈ 4.675 mrad).
			const sunAngularDiameterCos = float( 0.9999890834 ); // cos(0.004675)
			const cosSun = dot( viewDir, sunDir );
			const sunDiscMask = smoothstep(
				sunAngularDiameterCos,
				sunAngularDiameterCos.add( float( 0.00002 ) ),
				cosSun
			).mul( showSunDiscU );

			const sunContribution = vec3( 1.0, 1.0, 1.0 ).mul( sunDiscMask ).mul( sunIntensityU );

			return vec4( skyColor.add( sunContribution ), float( 1.0 ) );

		} )();

	}

}
