import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useRenderPipeline } from '@react-three/fiber/webgpu';

import { Sky as VanillaSky } from '../Sky.js';
import { SkyContext } from './SkyContext.js';

/**
 * `<Sky>` — mounts a vanilla `Sky` instance against the active R3F renderer
 * and scene, drives `update(camera)` per frame, and publishes the instance
 * via context for `useSky()` consumers.
 *
 * Construction-time options (cause a remount when changed):
 *   `preset`, `quality`, `cubeSize`, `enableAerialPerspective`, `apKmPerSlice`
 *
 * Imperative props (applied via setters; no remount):
 *   `timeOfDay`, `latitude`, `dayOfYear`, `sunDirection`, `north`,
 *   `exposure`, `sunDisc`, `turbidity`, `groundAlbedo`, `atmosphere`,
 *   `hazeStrength`, `hazePolicy`, `hazeAltitudeBlend`
 *
 * `autoHaze` (boolean | options-bag): when set, internally calls
 * `useRenderPipeline` and assigns `renderPipeline.outputNode` to the haze
 * composite. **Mutually exclusive with a user-owned `useRenderPipeline`** —
 * the docs warn against multiple init callsites racing for `outputNode`.
 * For custom pipelines, leave `autoHaze` off and call `sky.applyHaze` from
 * your own `useRenderPipeline` callback (use `useSky()` to grab the instance).
 */
export function Sky( {
	preset = 'earth',
	quality = 'medium',
	cubeSize = 256,
	atmosphere,
	enableAerialPerspective = true,
	apKmPerSlice = 8.0,
	exposure = 40,
	north = '+Z',
	sunDisc = true,
	timeOfDay,
	latitude,
	dayOfYear,
	sunDirection,
	turbidity,
	groundAlbedo,
	hazeStrength,
	hazePolicy,
	hazeAltitudeBlend,
	autoHaze = false,
	children
} ) {

	const renderer = useThree( ( s ) => s.gl );
	const scene = useThree( ( s ) => s.scene );

	const sky = useMemo( () => {

		return new VanillaSky( renderer, {
			preset,
			quality,
			cubeSize,
			atmosphere,
			enableAerialPerspective,
			apKmPerSlice,
			exposure,
			north,
			sunDisc,
			timeOfDay,
			latitude,
			dayOfYear,
			sunDirection,
			turbidity,
			groundAlbedo
		} );

		// Reconstruct only on options that affect LUT layout / cube target sizing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ renderer, preset, quality, cubeSize, enableAerialPerspective, apKmPerSlice ] );

	useEffect( () => {

		sky.attach( scene );
		return () => {

			sky.detach();
			sky.dispose();

		};

	}, [ sky, scene ] );

	useEffect( () => {

		if ( typeof timeOfDay === 'number' ) sky.setTimeOfDay( timeOfDay );

	}, [ sky, timeOfDay ] );

	useEffect( () => {

		if ( typeof latitude === 'number' ) sky.setLatitude( latitude );

	}, [ sky, latitude ] );

	useEffect( () => {

		if ( typeof dayOfYear === 'number' ) sky.setDayOfYear( dayOfYear );

	}, [ sky, dayOfYear ] );

	useEffect( () => {

		if ( sunDirection ) sky.setSunDirection( sunDirection );

	}, [ sky, sunDirection ] );

	useEffect( () => {

		sky.setExposure( exposure );

	}, [ sky, exposure ] );

	useEffect( () => {

		sky.setSunDisc( sunDisc );

	}, [ sky, sunDisc ] );

	useEffect( () => {

		sky.setNorth( north );

	}, [ sky, north ] );

	useEffect( () => {

		if ( typeof turbidity === 'number' ) sky.setTurbidity( turbidity );

	}, [ sky, turbidity ] );

	useEffect( () => {

		if ( groundAlbedo != null ) sky.setGroundAlbedo( groundAlbedo );

	}, [ sky, groundAlbedo ] );

	useEffect( () => {

		if ( atmosphere ) sky.setAtmosphere( atmosphere );

	}, [ sky, atmosphere ] );

	useEffect( () => {

		if ( typeof hazeStrength === 'number' ) sky.setHazeStrength( hazeStrength );

	}, [ sky, hazeStrength ] );

	useEffect( () => {

		if ( hazePolicy ) sky.setHazePolicy( hazePolicy );

	}, [ sky, hazePolicy ] );

	useEffect( () => {

		if ( hazeAltitudeBlend ) sky.setHazeAltitudeBlend( hazeAltitudeBlend );

	}, [ sky, hazeAltitudeBlend ] );

	useFrame( ( state ) => {

		sky.update( state.camera );

	} );

	const autoHazeOptions = autoHaze && typeof autoHaze === 'object' ? autoHaze : null;

	return (
		<SkyContext.Provider value={sky}>
			{autoHaze ? <AutoHaze sky={sky} options={autoHazeOptions} /> : null}
			{children}
		</SkyContext.Provider>
	);

}

/**
 * Internal child that owns the `useRenderPipeline` callsite. Rendered only
 * when `<Sky autoHaze>` is set so users with their own pipeline aren't
 * shadowed by ours.
 *
 * `useRenderPipeline` does not currently support reactive callback bodies —
 * the callback closes over its initial deps. We pass `sky` as a prop so the
 * underlying instance is stable across renders (Sky owns the haze uniforms,
 * so prop changes still take effect through `sky.setHaze*` setters even
 * without rebuilding the callback).
 */
function AutoHaze( { sky, options } ) {

	useRenderPipeline( ( { renderPipeline, passes } ) => {

		if ( ! sky ) return;
		renderPipeline.outputNode = sky.applyHaze(
			passes.scenePass.getTextureNode(),
			{ ...( options || {} ), scenePass: passes.scenePass }
		);

	} );

	return null;

}
