import { pixelScale } from '../../astronomy/formulas'
import { SIDEREAL_RATE } from '../../core/constants'
import type { Angle } from '../../math/units/angle'

// DEC drift rate produced by a 1-arcmin polar-alignment error at the hour angle where that error
// drifts fastest, in arcseconds per second. Best-case geometry gives dDEC/dt ≈ ω⊕ · error, with
// ω⊕ = 15.041 arcsec/s (sidereal) and 1 arcmin = 2.9089e-4 rad, so 15.041 · 2.9089e-4 ≈ 0.004375.
// The hour-angle dependency is carried separately by the geometry factor. Used only as a visibility

// threshold for DARV exposure estimation, not as a precise drift model.
export const DRIFT_ARCSEC_PER_SECOND_PER_ARCMIN = 0.004375
// Minimum |cos(declination)| for a usable DARV target; below it RA motion is too small near the pole.
export const MIN_RA_COS_DECLINATION = 1e-3
// Minimum DEC drift rate (arcsec/s) below which a visible DARV separation cannot be estimated.
export const MIN_DRIFT_RATE_ARCSEC_PER_SECOND = 1e-9

// Which mount axis is being refined during a DARV run; selects the DEC-drift geometry factor.
export type DarvExposureMode = 'azimuth' | 'altitude'

// Built-in DARV preset selector trading visibility speed against the smallest resolvable polar error.
export type DarvExposurePresetMode = 'coarse' | 'medium' | 'fine'

// DARV exposure preset values used to estimate the visibility threshold.
export interface DarvExposurePreset {
	// Desired RA trail length, in pixels.
	targetTrail: number
	// Minimum visually detectable separation between the DARV segments, in pixels.
	detectableSeparation: number
	// Smallest polar alignment error the user wants to make visible, in arcminutes.
	targetPolarError: number
	// RA guide speed as a multiple of sidereal rate.
	guideRateSidereal: number
}

// Coarse DARV preset for making large polar errors visible quickly.
export const COARSE_DARV_EXPOSURE_PRESET: Readonly<DarvExposurePreset> = {
	targetTrail: 150,
	detectableSeparation: 3,
	targetPolarError: 15,
	guideRateSidereal: 1,
}

// Medium DARV preset for typical visual polar-alignment refinement.
export const MEDIUM_DARV_EXPOSURE_PRESET: Readonly<DarvExposurePreset> = {
	targetTrail: 200,
	detectableSeparation: 3,
	targetPolarError: 5,
	guideRateSidereal: 1,
}

// Fine DARV preset for making smaller polar errors visible with a slower RA guide rate.
export const FINE_DARV_EXPOSURE_PRESET: Readonly<DarvExposurePreset> = {
	targetTrail: 250,
	detectableSeparation: 2,
	targetPolarError: 2,
	guideRateSidereal: 0.5,
}

// Lookup of the built-in DARV presets by mode name.
export const DARV_EXPOSURE_PRESETS = {
	coarse: COARSE_DARV_EXPOSURE_PRESET,
	medium: MEDIUM_DARV_EXPOSURE_PRESET,
	fine: FINE_DARV_EXPOSURE_PRESET,
} as const satisfies Record<DarvExposurePresetMode, DarvExposurePreset>

// Input for estimating a recommended DARV exposure time, not the actual polar error.
export interface DarvExposureInput {
	// Telescope focal length, in millimeters.
	focalLength: number
	// Camera pixel size, in the unit expected by pixelScale.
	pixelSize: number
	// Star declination, in radians. Stars very close to the celestial pole are not suitable DARV targets.
	declination: Angle
	// Star hour angle, in radians, positive west of the meridian. Which star is worth pointing at
	// depends on the mode, and picking the wrong one makes the drift vanish rather than merely shrink:
	// an azimuth error drifts fastest on the meridian and not at all six hours from it, and an altitude
	// error the other way round. Passing it is what lets that be reported instead of silently assumed.
	hourAngle: Angle
	// Observer latitude, in radians.
	latitude: Angle
	// Polar-alignment adjustment mode whose geometry controls the expected DEC drift.
	mode: DarvExposureMode
	// Built-in preset name or custom values. targetPolarError is the smallest polar error to make visible.
	preset: DarvExposurePreset
}

// Intermediate and final exposure estimates for a DARV capture.
export interface DarvExposureEstimate {
	// Image scale, in arcseconds per pixel.
	readonly imageScale: number
	// Usable RA trail speed magnitude, in arcseconds per second.
	readonly raVelocity: number
	// Geometry factor applied to the DEC drift estimate for the alignment mode and hour angle, in
	// [0, 1]. A value near zero means the star is in the wrong part of the sky for this mode and drifts
	// too slowly to measure, which is reported as a range error rather than a very long exposure.
	readonly geometryFactor: number
	// Estimated DEC drift from the target polar-error threshold, in arcseconds per second.
	readonly driftDec: number
	// Time needed for the desired RA trail length, in seconds.
	readonly raTrailTime: number
	// Time needed for the minimum visible DEC separation, in seconds.
	readonly driftDetectionTime: number
	// Recommended time for one DARV leg, in seconds.
	readonly recommendedLegTime: number
	// Total recommended exposure for the outbound plus return legs, in seconds.
	readonly recommendedExposure: number
}

// DEC-drift geometry factor for the alignment mode at a given hour angle, dimensionless and never
// negative, since DARV shows a separation whichever way the drift goes.
//
// Differentiating the declination term of the pointing model, Δδ = MA·sin H + ME·cos H, against the
// hour angle gives dΔδ/dt = ω⊕·(MA·cos H − ME·sin H). With MA = azimuthError·cos(latitude) and
// ME = −altitudeError, one knob at a time leaves:
//
//   azimuth:  |cos(latitude)·cos(H)|, largest on the meridian and zero six hours from it
//   altitude: |sin(H)|, the other way round
//
// Which is the geometric reason drift alignment asks for a star near the meridian to set azimuth and
// one near the eastern or western horizon to set altitude.
function computeDarvGeometryFactor(mode: DarvExposureMode, latitude: Angle, hourAngle: Angle) {
	if (mode === 'azimuth') return Math.abs(Math.cos(latitude) * Math.cos(hourAngle))
	if (mode === 'altitude') return Math.abs(Math.sin(hourAngle))
	throw new TypeError('DARV exposure mode must be azimuth or altitude')
}

// Usable RA trail speed magnitude (arcsec/s) = sidereal rate × guide multiple × |cos(declination)|.
// Throws when the target is too close to the pole for meaningful RA motion.
function computeDarvRaVelocity(declination: Angle, guideRateSidereal: number) {
	const cosDeclination = Math.abs(Math.cos(declination))

	if (!(cosDeclination > MIN_RA_COS_DECLINATION)) throw new RangeError('stars too close to the celestial pole are not recommended for DARV because RA motion becomes too small')

	// DARV reverses RA between legs, so expose the speed magnitude instead of a signed direction.
	return SIDEREAL_RATE * guideRateSidereal * cosDeclination
}

// Expected DEC drift rate (arcsec/s) from the target polar error and mode geometry. Throws when the
// drift would be too small to produce a visible separation.
function computeDarvDriftDec(targetPolarErrorArcmin: number, geometryFactor: number) {
	const driftDec = DRIFT_ARCSEC_PER_SECOND_PER_ARCMIN * targetPolarErrorArcmin * geometryFactor
	if (!(driftDec > MIN_DRIFT_RATE_ARCSEC_PER_SECOND)) throw new RangeError('DARV DEC drift is too small to estimate a visible separation for this alignment geometry')
	return driftDec
}

// Estimates the recommended exposure time for DARV, not the actual polar error.
// recommendedLegTime is one outbound or return leg; recommendedExposure is both legs.
export function estimateDarvExposure(input: Readonly<DarvExposureInput>): DarvExposureEstimate {
	const preset = input.preset
	const geometryFactor = computeDarvGeometryFactor(input.mode, input.latitude, input.hourAngle)
	const imageScale = pixelScale(input.pixelSize, input.focalLength)
	const raVelocity = computeDarvRaVelocity(input.declination, preset.guideRateSidereal)
	const driftDec = computeDarvDriftDec(preset.targetPolarError, geometryFactor)
	const raTrailTime = (preset.targetTrail * imageScale) / raVelocity
	const driftDetectionTime = (preset.detectableSeparation * imageScale) / (2 * driftDec)
	const recommendedLegTime = Math.max(raTrailTime, driftDetectionTime)
	const recommendedExposure = 2 * recommendedLegTime

	return { imageScale, raVelocity, geometryFactor, driftDec, raTrailTime, driftDetectionTime, recommendedLegTime, recommendedExposure }
}
