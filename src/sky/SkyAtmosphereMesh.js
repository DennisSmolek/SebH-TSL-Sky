import {
	BackSide,
	BoxGeometry,
	Mesh,
	Vector3,
	NodeMaterial
} from 'three/webgpu';

import {
	Fn,
	If,
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
	integrateScatteredLuminance,
	moveToTopAtmosphere,
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
	 * @param {TransmittanceLUT} [args.transmittanceLUT]  required for the
	 *   space-view raymarch fallback (camera viewHeight > topRadius). Optional
	 *   for ground-only callers; without it, the mesh stays in pure SkyView mode.
	 * @param {MultiScatterLUT} [args.multiScatterLUT]  paired with transmittanceLUT.
	 * @param {THREE.Vector3} [args.sunDirection]  initial Y-up world-space sun dir
	 * @param {THREE.Vector3} [args.upVector]      initial Y-up world-space up dir
	 */
	constructor( { atmosphereUniforms, skyViewLUT, transmittanceLUT = null, multiScatterLUT = null, sunDirection, upVector } = {} ) {

		if ( ! atmosphereUniforms ) throw new Error( 'SkyAtmosphereMesh: atmosphereUniforms is required' );
		if ( ! skyViewLUT ) throw new Error( 'SkyAtmosphereMesh: skyViewLUT is required' );

		const material = new NodeMaterial();

		super( new BoxGeometry( 1, 1, 1 ), material );

		this.atmosphereUniforms = atmosphereUniforms;
		this.skyViewLUT = skyViewLUT;
		this.transmittanceLUT = transmittanceLUT;
		this.multiScatterLUT = multiScatterLUT;

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
		 * Camera viewHeight (km, planet-centred). Drives the SkyView LUT UV
		 * un-map AND the ground-intersect ray origin. Defaults to ground+ε;
		 * the baker's `setCamera()` updates this each frame for phase 2.
		 *
		 * @type {UniformNode<float>}
		 */
		this.viewHeight = uniform( atmosphereUniforms.bottomRadius.value + 0.01 );

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
		// `depthWrite = true` so sky pixels stamp the far-plane value into the
		// scene depth buffer (the `z = w` vertex trick gives them NDC.z = 1).
		// The post-process haze pass uses scene depth to discriminate sky vs
		// geometry; with depthWrite off, sky pixels read the cleared depth
		// value which `getViewZNode` / `getLinearDepthNode` then interpret as
		// "at the camera" rather than "at the far plane" — breaking every
		// depth-based sky test. Writing real far-plane depth makes both tests
		// reliable. Geometry still wins the depth test (it's closer than far)
		// so this doesn't occlude anything.
		material.depthWrite = true;
		material.vertexNode = vertexNode;
		material.colorNode = colorNode;

	}

	_buildColorNode() {

		const params = this.atmosphereUniforms;
		const skyViewTex = this.skyViewLUT.texture;
		const transmittanceTex = this.transmittanceLUT ? this.transmittanceLUT.texture : null;
		const multiScatterTex = this.multiScatterLUT ? this.multiScatterLUT.texture : null;
		const enableSpaceFallback = transmittanceTex !== null && multiScatterTex !== null;
		const sunDirU = this.sunDirection;
		const upU = this.upVector;
		const showSunDiscU = this.showSunDisc;
		const sunIntensityU = this.sunIntensity;
		const luminanceScaleU = this.luminanceScale;
		const viewHeightU = this.viewHeight;

		return Fn( () => {

			// View direction from the camera to this fragment's world position.
			const viewDir = normalize( positionWorld.sub( cameraPosition ) );
			const upVec = normalize( upU );
			const sunDir = normalize( sunDirU );

			// Camera viewHeight (km, distance from planet centre) — driven by the
			// per-frame uniform. Clamp to never fall below `bottomRadius + ε` so
			// the ground-intersect math stays well-defined.
			const viewHeight = max( viewHeightU, params.bottomRadius.add( float( 0.01 ) ) );

			// View-zenith cosine.
			const viewZenithCosAngle = clamp( dot( viewDir, upVec ), float( - 1.0 ), float( 1.0 ) );

			// Light-view cosine, per Unreal RenderSkyRayMarching.hlsl:325-329.
			// Build a stable on-plane basis perpendicular to up, aligned with the
			// view direction's horizontal component, then project the sun onto it.
			const sideRaw = cross( upVec, viewDir );
			const sideLen = max( length( sideRaw ), float( 1e-6 ) );
			const sideVector = sideRaw.div( sideLen );
			const forwardVector = normalize( cross( sideVector, upVec ) );

			const lightOnPlaneX = dot( sunDir, forwardVector );
			const lightOnPlaneY = dot( sunDir, sideVector );
			const lightOnPlaneLen = max( length( vec2( lightOnPlaneX, lightOnPlaneY ) ), float( 1e-6 ) );
			const lightViewCosAngle = clamp( lightOnPlaneX.div( lightOnPlaneLen ), float( - 1.0 ), float( 1.0 ) );

			// Ground intersection test (planet at origin in Y-up; camera at
			// (0, viewHeight, 0)).
			const earthO = vec3( 0.0, 0.0, 0.0 );
			const ro = vec3( float( 0.0 ), viewHeight, float( 0.0 ) );
			const tPlanet = raySphereIntersectNearest( ro, viewDir, earthO, params.bottomRadius );
			const intersectsGround = tPlanet.greaterThanEqual( float( 0.0 ) );

			// Sky color accumulator. Either populated by the SkyView LUT
			// (camera inside / near atmosphere) or by a per-pixel raymarch
			// (camera in space — the LUT's horizon-packed UV layout misallocates
			// texels once the planet stops dominating the view).
			const skyColor = vec3( 0.0, 0.0, 0.0 ).toVar();

			if ( enableSpaceFallback ) {

				const inAtmosphere = viewHeight.lessThanEqual( params.topRadius );

				If( inAtmosphere, () => {

					const lutUv = skyViewLutParamsToUv(
						params,
						intersectsGround,
						viewZenithCosAngle,
						lightViewCosAngle,
						viewHeight
					);
					skyColor.assign( texture( skyViewTex, lutUv ).rgb.mul( luminanceScaleU ) );

				} ).Else( () => {

					// Phase 3 — space-view raymarch fallback.
					// Camera position in planet-centred Y-up frame.
					const camPos = vec3( float( 0.0 ), viewHeight, float( 0.0 ) );

					// Clip the ray origin to the atmosphere boundary; if the ray
					// misses entirely the result stays at zero.
					const moved = moveToTopAtmosphere( camPos, viewDir, params );
					const startPos = moved.newPos.toVar();

					const result = integrateScatteredLuminance( {
						worldPos: startPos,
						worldDir: viewDir,
						sunDir: sunDir,
						params: params,
						transmittanceLUT: transmittanceTex,
						multiScatterLUT: multiScatterTex,
						sampleCount: 30,
						ground: true,
						mieRayPhase: true
					} );

					const validF = moved.valid.select( float( 1.0 ), float( 0.0 ) );
					skyColor.assign( result.L.mul( luminanceScaleU ).mul( validF ) );

				} );

			} else {

				// No fallback wired — pure SkyView LUT path (Phase 1b behaviour).
				const lutUv = skyViewLutParamsToUv(
					params,
					intersectsGround,
					viewZenithCosAngle,
					lightViewCosAngle,
					viewHeight
				);
				skyColor.assign( texture( skyViewTex, lutUv ).rgb.mul( luminanceScaleU ) );

			}

			// Sun disc — same in both paths. cos(angularDiameter) smoothstep.
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
