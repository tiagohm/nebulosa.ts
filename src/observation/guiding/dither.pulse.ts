import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import { ASEC2RAD, SIDEREAL_RATE } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import type { GuidingCalibrationResult } from './calibrator'
import type { DitherOffset } from './dither'
import { type GuideDirectionRA, type GuideDirectionDEC, oppositeDEC, oppositeRA } from './guider'

// Pure conversion of a dither increment into a guide-pulse plan, for dithering directly on a guide
// output without an active guiding loop. Two conversions are offered: from a solved calibration, which
// consumes an offset in pixels, and from the mount guide rate, which consumes an offset in radians on
// the sky. Both produce whole-millisecond durations and never touch a device; dispatching the plan is
// the executor's job. Durations are milliseconds and angles are radians.

// Sidereal rate expressed in radians per millisecond. SIDEREAL_RATE is arcsec/s, so the conversion is
// arcsec-to-radian and second-to-millisecond; note that the nearby Alpaca adapter divides the same
// constant by 3600 to obtain deg/s, which is a different unit and must not be reused here.
const SIDEREAL_RATE_RAD_PER_MS = (SIDEREAL_RATE * ASEC2RAD) / 1000

// Sentinel returned by axisPulseDuration meaning the whole plan must be rejected.
const REJECT_PLAN = -1
// Sentinel returned by axisPulseDuration meaning this axis carries no motion and is omitted.
const OMIT_AXIS = 0

// One timed guide pulse on a single axis.
export interface DitherAxisPulse {
	// Physical direction of the pulse, in the same vocabulary the calibration uses.
	readonly direction: GuideDirectionRA | GuideDirectionDEC
	// Pulse duration in whole milliseconds, always at least 1.
	readonly duration: number
}

// A dither expressed as at most one timed pulse per axis. An axis is absent when it carries no motion.
export interface DitherPulsePlan {
	// Pulse on the right ascension axis, west or east.
	readonly rightAscension?: DitherAxisPulse
	// Pulse on the declination axis, north or south.
	readonly declination?: DitherAxisPulse
}

// Context required to convert a sky-plane angular dither into pulse durations from the mount guide
// rate alone, without a calibration.
export interface DitherGuideRateContext {
	// Guide rate per axis, as a fraction of the sidereal rate (0.5 means 0.5x sidereal), matching the
	// INDI GUIDE_RATE convention used by GuideOutput.
	readonly guideRate: EquatorialCoordinate
	// Declination of the target at dither time (radians), used for the cos(declination) projection.
	readonly declination: Angle
	// Physical direction corresponding to a positive right ascension offset. There is no default: the
	// guide rate carries magnitudes only, and without a calibration nothing identifies the equipment's
	// positive sense.
	readonly rightAscensionDirection: GuideDirectionRA
	// Physical direction corresponding to a positive declination offset.
	readonly declinationDirection: GuideDirectionDEC
}

// Computes the normalized pulse duration for one axis from an offset and a rate expressed in offset
// units per millisecond. Returns OMIT_AXIS when the axis carries no motion, REJECT_PLAN when the rate
// cannot produce a usable duration or the duration exceeds maxDuration, and otherwise a whole number
// of milliseconds of at least 1, matching the normalization the guiding loop applies before pulsing.
// A rate of zero, negative or non-finite is rejected rather than skipped: dividing by it would leak
// Infinity into the plan or silently invert the pulse direction.
function axisPulseDuration(offset: number, rate: number, maxDuration: number) {
	if (offset === 0) return OMIT_AXIS
	if (!(rate > 0) || !Number.isFinite(rate)) return REJECT_PLAN

	const duration = Math.abs(offset) / rate
	if (!Number.isFinite(duration)) return REJECT_PLAN

	const normalized = Math.max(1, Math.round(duration))
	return normalized > maxDuration ? REJECT_PLAN : normalized
}

// Builds the pulse plan for a dither offset in pixels along the mount axes, reusing a previously
// solved calibration. This is the closest reproduction of the guider's own dither: the guider reaches
// the shifted lock target with a pulse of exactly abs(offset) / ratePxPerMs milliseconds in the
// calibrated direction, so the same expression is used here.
//
// The sign convention is not a choice. The calibration axis unit vector points along the star motion
// observed while pulsing `direction`, and a dither moves the lock target by +offset along that unit,
// so the star must follow it: a positive offset pulses `direction` and a negative one its opposite.
// Do not "fix" this against PHD2, whose calibration angle points opposite the observed star motion and
// which therefore mirrors the sign of the whole axis frame; both loops correct the same physical way.
//
// `offset` is in pixels and `maxDuration` in milliseconds. Returns `undefined` when the plan must be
// rejected, and an empty plan when the offset is zero on both axes.
//
// The caller must guarantee the calibration is still applicable: same guide output, same optical train
// as the camera that defined the pixel amount, and already passed through flipGuidingCalibration when
// a meridian flip happened since. GuidingCalibrationResult stores no device identity, date or pier
// side, so a stale calibration cannot be detected here.
export function ditherPulsePlanFromCalibration(offset: DitherOffset, calibration: GuidingCalibrationResult, maxDuration: number): DitherPulsePlan | undefined {
	const rightAscension = axisPulseDuration(offset.rightAscension, calibration.ra.ratePxPerMs, maxDuration)
	const declination = axisPulseDuration(offset.declination, calibration.dec.ratePxPerMs, maxDuration)

	if (rightAscension === REJECT_PLAN || declination === REJECT_PLAN) return undefined

	return makePulsePlan(offset, rightAscension, declination, calibration.ra.direction, calibration.dec.direction)
}

// Builds the pulse plan for a dither offset expressed as an angle on the sky, from the mount guide
// rate alone. `offset` is in radians and `maxDuration` in milliseconds.
//
// The right ascension rate carries a cos(declination) factor because the pulse drives the right
// ascension axis while the offset is a sky-plane angle: the same axis motion spans a smaller angle on
// the sky near the poles. The factor is evaluated once at the dither declination, which is accurate
// while the offset stays small compared to the distance to the pole. Near the pole the resulting
// duration grows without bound and the plan is rejected by maxDuration.
//
// Returns `undefined` when the plan must be rejected, and an empty plan when the offset is zero on
// both axes.
export function ditherPulsePlanFromGuideRate(offset: DitherOffset, context: DitherGuideRateContext, maxDuration: number): DitherPulsePlan | undefined {
	const rateRA = SIDEREAL_RATE_RAD_PER_MS * context.guideRate.rightAscension * Math.abs(Math.cos(context.declination))
	const rateDEC = SIDEREAL_RATE_RAD_PER_MS * context.guideRate.declination
	const rightAscension = axisPulseDuration(offset.rightAscension, rateRA, maxDuration)
	const declination = axisPulseDuration(offset.declination, rateDEC, maxDuration)

	if (rightAscension === REJECT_PLAN || declination === REJECT_PLAN) return undefined

	return makePulsePlan(offset, rightAscension, declination, context.rightAscensionDirection, context.declinationDirection)
}

// Assembles the plan from already normalized durations, picking the calibrated direction for a
// positive offset and its opposite for a negative one. Both properties are always present so the
// object keeps a single shape; an omitted axis carries `undefined`.
function makePulsePlan(offset: DitherOffset, raDuration: number, decDuration: number, raPositiveDirection: GuideDirectionRA, decPositiveDirection: GuideDirectionDEC): DitherPulsePlan {
	return {
		rightAscension: raDuration === OMIT_AXIS ? undefined : { direction: offset.rightAscension > 0 ? raPositiveDirection : oppositeRA(raPositiveDirection), duration: raDuration },
		declination: decDuration === OMIT_AXIS ? undefined : { direction: offset.declination > 0 ? decPositiveDirection : oppositeDEC(decPositiveDirection), duration: decDuration },
	}
}
