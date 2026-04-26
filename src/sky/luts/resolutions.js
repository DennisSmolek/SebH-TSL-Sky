/**
 * Single source of truth for Hillaire LUT texture sizes. Defaults match the paper.
 *
 * Overridable per-construction via `new SkyAtmosphereBaker(renderer, { lutResolutions })`.
 */
export const LUT_RESOLUTIONS = {
	transmittance: { width: 256, height: 64 },
	multiScatter: { width: 32, height: 32 },
	skyView: { width: 192, height: 108 }
};
