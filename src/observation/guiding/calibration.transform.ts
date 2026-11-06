import { DEG2RAD, PIOVERTWO } from '../../core/constants'
import type { PierSide } from '../../devices/indi/device'
import type { Angle } from '../../math/units/angle'
import { DEFAULT_GUIDING_CALIBRATOR_CONFIG, flipGuidingCalibration, type GuidingCalibrationAxisSolution, type GuidingCalibrationResult } from './calibrator'
import type { CalibrationMatrix } from './guider'

// Reuse of a solved guiding calibration in another mount context. A calibration is kept as an immutable source record:
// the solution as measured (or as flipped by hand) with the mount context it was measured in. The calibration used to
// guide is derived from that source for the current context, every time from the source so transformations never
// accumulate: a flip when the mount reports the other side of the pier, then, on an equatorial mount whose RA pulses do
// not already follow the declination, the RA response scaled by cos(current declination) / cos(source declination), as
// PHD2's declination compensation. Both scale columns of the forward (axis-to-image) matrix, so their order does not
// matter, and the inverse is solved again from the result; DEC is never scaled. A context that cannot be trusted is
// refused, never guessed. Records read from storage are validated here once before use. Angles are radians, rates
// pixels per millisecond; pure, each call allocates its result.

// Version of GuidingCalibrationRecord, raised when its shape changes.
export const GUIDING_CALIBRATION_RECORD_VERSION = 1

// Largest |declination| of a source calibration whose RA response may be scaled to another declination, in radians:
// near the pole the RA motion of a calibration is short and its cosine poorly known, so PHD2 recommends calibrating near
// the celestial equator.
export const MAX_COMPENSATED_SOURCE_DECLINATION: Angle = 60 * DEG2RAD

// Largest |declination| an RA response may be scaled to, in radians: closer to the pole the scaled RA rate vanishes and
// its pulses would grow without bound.
export const MAX_COMPENSATED_DECLINATION: Angle = 85 * DEG2RAD

// Relative change of the RA response below which a declination change is ignored and the source is used as it is: an
// error of 1% of the RA rate is far below what the controller corrects anyway, and it keeps coordinate noise from
// reshaping the calibration.
export const DECLINATION_SCALE_TOLERANCE = 0.01

// Mount context of a calibration, as the mount reported it.
export interface GuidingCalibrationContext {
	// Declination of the mount, apparent of date (JNow), in radians within [-π/2, π/2]; absent when unknown.
	readonly declination?: Angle
	// Side of the pier the mount reported; absent or NEITHER when the mount does not tell.
	readonly pierSide?: PierSide
}

// A solved calibration kept to be reused: the source every calibration used to guide is derived from.
export interface GuidingCalibrationRecord {
	// Record shape version, GUIDING_CALIBRATION_RECORD_VERSION.
	readonly version: typeof GUIDING_CALIBRATION_RECORD_VERSION
	// The solution as measured, or as flipped by hand together with its context's pier side.
	readonly calibration: GuidingCalibrationResult
	// Mount context the solution is valid in.
	readonly context: GuidingCalibrationContext
	// Unix time the calibration completed, in milliseconds.
	readonly acquiredAt: number
}

// How a source calibration may be transformed.
export interface GuidingCalibrationTransformOptions {
	// Whether the RA response follows the declination; off for a mount whose firmware already scales its RA guide rate by
	// the declination, or one that is not equatorial.
	readonly declinationCompensation: boolean
	// Whether the DEC output is reversed after a flip, as flipGuidingCalibration's reverseDecOutput.
	readonly reverseDecOutputAfterMeridianFlip: boolean
}

// A transformation applied to the source to derive the calibration used to guide.
export type GuidingCalibrationTransformation = 'pierFlip' | 'declinationCompensation'

// Why a source cannot be used in a context: the pier side or the declination of the source or of the mount now is not
// known, the source or the declination now is too close to the pole for the RA response to be scaled, or the scaled RA
// rate is too small to guide with.
export type GuidingCalibrationRefusal = 'pierSideUnknown' | 'declinationUnknown' | 'sourceNearPole' | 'declinationNearPole' | 'rateTooSmall'

// Whether and how a source calibration applies in a context: as it is, transformed, or not at all, either because the
// context is not known well enough to tell or because the geometry needs a new calibration.
export type GuidingCalibrationApplicability =
	| {
			readonly status: 'direct' | 'transformed'
			// The calibration to guide with; the source itself when direct.
			readonly calibration: GuidingCalibrationResult
			// Transformations applied, in order; empty when direct.
			readonly transformations: readonly GuidingCalibrationTransformation[]
			// Factor applied to the RA response, cos(current) / cos(source declination); 1 without declination compensation.
			readonly declinationScale: number
	  }
	| {
			readonly status: 'insufficientEvidence' | 'requiresRecalibration'
			// Every reason found, at least one.
			readonly reasons: readonly GuidingCalibrationRefusal[]
	  }

// Outcome of validating a stored record: the record, or the first problem found.
export type GuidingCalibrationRecordValidation = { readonly ok: true; readonly record: GuidingCalibrationRecord } | { readonly ok: false; readonly reason: string }

// Reasons that a new calibration fixes, as opposed to missing evidence.
const RECALIBRATION_REASONS: ReadonlySet<GuidingCalibrationRefusal> = new Set(['sourceNearPole', 'declinationNearPole', 'rateTooSmall'])

// Returns the calibration to guide with in the current context, derived from the source record: flipped when both the
// source and the mount now report a known side of the pier and they differ, then with its RA response scaled to the
// current declination when declinationCompensation is on and the scale differs from 1 by more than
// DECLINATION_SCALE_TOLERANCE. A side of the pier that is unknown on either end, or a declination unknown on either end
// while compensating, is refused as insufficientEvidence; a source or a declination now beyond the compensation limits,
// or an RA rate below the calibrator's minimum after scaling, as requiresRecalibration.
export function effectiveGuidingCalibration(record: GuidingCalibrationRecord, current: GuidingCalibrationContext, options: GuidingCalibrationTransformOptions): GuidingCalibrationApplicability {
	const reasons: GuidingCalibrationRefusal[] = []
	const sourceSide = knownPierSide(record.context.pierSide)
	const currentSide = knownPierSide(current.pierSide)
	if (sourceSide === undefined || currentSide === undefined) reasons.push('pierSideUnknown')

	let declinationScale = 1

	if (options.declinationCompensation) {
		const source = record.context.declination
		const now = current.declination

		if (source === undefined || now === undefined) {
			reasons.push('declinationUnknown')
		} else {
			const scale = Math.cos(now) / Math.cos(source)

			if (!(Math.abs(scale - 1) <= DECLINATION_SCALE_TOLERANCE)) {
				if (!(Math.abs(source) <= MAX_COMPENSATED_SOURCE_DECLINATION)) reasons.push('sourceNearPole')
				if (!(Math.abs(now) <= MAX_COMPENSATED_DECLINATION)) reasons.push('declinationNearPole')
				declinationScale = scale
			}
		}
	}

	if (reasons.length > 0) return refused(reasons)

	const transformations: GuidingCalibrationTransformation[] = []
	let calibration = record.calibration

	if (sourceSide !== currentSide) {
		calibration = flipGuidingCalibration(calibration, options.reverseDecOutputAfterMeridianFlip)
		transformations.push('pierFlip')
	}

	if (declinationScale !== 1) {
		calibration = scaleRightAscension(calibration, declinationScale)
		transformations.push('declinationCompensation')
		if (!(calibration.ra.ratePxPerMs >= DEFAULT_GUIDING_CALIBRATOR_CONFIG.minRatePxPerMs)) return refused(['rateTooSmall'])
	}

	return { status: transformations.length > 0 ? 'transformed' : 'direct', calibration, transformations, declinationScale }
}

// Returns the calibration with its RA response scaled by scale (> 0): the RA column of the forward matrix and the RA
// rate multiplied, the inverse and the determinant solved again. The RA unit vector, the DEC axis and the measured travel
// and review stay as they are.
export function scaleRightAscension(calibration: GuidingCalibrationResult, scale: number): GuidingCalibrationResult {
	const [m00, m01, m10, m11] = calibration.imageMotion
	const r00 = m00 * scale
	const r10 = m10 * scale
	const determinant = r00 * m11 - m01 * r10

	return {
		...calibration,
		ra: { ...calibration.ra, ratePxPerMs: calibration.ra.ratePxPerMs * scale },
		imageMotion: [r00, m01, r10, m11],
		imageToAxis: [m11 / determinant, -m01 / determinant, -r10 / determinant, r00 / determinant],
		determinant,
	}
}

// Validates a record read from storage, once, before it can reach a guider: its version, a finite context within range,
// finite axis solutions with unit directions, positive rates and known directions, forward and inverse matrices that
// match the axes and invert each other, a conditioning no worse than the calibrator accepts, and well-formed review
// samples. A stored record that passes is safe to transform and guide with; one that does not would produce runaway or
// non-finite pulses.
export function validateGuidingCalibrationRecord(value: unknown): GuidingCalibrationRecordValidation {
	if (!isRecord(value)) return invalid('the record is not an object')
	if (value.version !== GUIDING_CALIBRATION_RECORD_VERSION) return invalid(`unsupported record version ${String(value.version)}`)
	if (!isFiniteNumber(value.acquiredAt)) return invalid('acquiredAt is not a finite time')

	const context = value.context
	if (!isRecord(context)) return invalid('the context is not an object')
	if (context.declination !== undefined && !(isFiniteNumber(context.declination) && Math.abs(context.declination) <= PIOVERTWO)) return invalid('the context declination is out of range')
	if (context.pierSide !== undefined && context.pierSide !== 'EAST' && context.pierSide !== 'WEST' && context.pierSide !== 'NEITHER') return invalid('the context pier side is unknown')

	const calibration = value.calibration
	if (!isRecord(calibration)) return invalid('the calibration is not an object')

	const ra = validAxis(calibration.ra, 'WEST', 'EAST')
	if (ra === undefined) return invalid('the RA axis is invalid')
	const dec = validAxis(calibration.dec, 'NORTH', 'SOUTH')
	if (dec === undefined) return invalid('the DEC axis is invalid')

	const imageMotion = validMatrix(calibration.imageMotion)
	const imageToAxis = validMatrix(calibration.imageToAxis)
	if (imageMotion === undefined || imageToAxis === undefined) return invalid('a calibration matrix is not four finite numbers')

	// The forward matrix columns are the axis unit vectors times their rates.
	if (!near(imageMotion[0], ra.unitX * ra.ratePxPerMs, ra.ratePxPerMs) || !near(imageMotion[2], ra.unitY * ra.ratePxPerMs, ra.ratePxPerMs) || !near(imageMotion[1], dec.unitX * dec.ratePxPerMs, dec.ratePxPerMs) || !near(imageMotion[3], dec.unitY * dec.ratePxPerMs, dec.ratePxPerMs)) {
		return invalid('the image-motion matrix does not match the axes')
	}

	const normalizedDeterminant = Math.abs(ra.unitX * dec.unitY - ra.unitY * dec.unitX)
	if (!(normalizedDeterminant >= DEFAULT_GUIDING_CALIBRATOR_CONFIG.minDeterminant)) return invalid('the calibration matrix is singular')
	if (!isInverse(imageMotion, imageToAxis)) return invalid('the image-to-axis matrix is not the inverse of the image-motion matrix')
	if (!isFiniteNumber(calibration.determinant) || !near(calibration.determinant, imageMotion[0] * imageMotion[3] - imageMotion[1] * imageMotion[2], Math.abs(calibration.determinant))) return invalid('the determinant does not match the image-motion matrix')
	if (!isFiniteNumber(calibration.backlash) || !(calibration.backlash >= 0)) return invalid('the backlash is not a finite duration')
	if (!isFiniteNumber(calibration.startX) || !isFiniteNumber(calibration.startY) || !isFiniteNumber(calibration.decStartX) || !isFiniteNumber(calibration.decStartY)) return invalid('a calibration origin is not finite')
	if (!isCount(calibration.clearingSteps) || !isCount(calibration.decReturnSteps)) return invalid('a step count is invalid')
	if (!Array.isArray(calibration.warnings) || !calibration.warnings.every((warning) => typeof warning === 'string')) return invalid('the warnings are not strings')
	if (typeof calibration.orthogonalAssumed !== 'boolean') return invalid('orthogonalAssumed is not a boolean')

	const review = calibration.review
	if (!isRecord(review)) return invalid('the review is not an object')
	if (validAxis({ ...(isRecord(review.measuredDec) ? review.measuredDec : {}), direction: 'NORTH' }, 'NORTH', 'SOUTH') === undefined) return invalid('the measured DEC axis is invalid')
	if (!isFiniteNumber(review.orthogonalityError)) return invalid('the orthogonality error is not finite')
	if (!Array.isArray(review.phaseHistory) || !review.phaseHistory.every((phase) => typeof phase === 'string')) return invalid('the phase history is invalid')

	for (const key of ['raSamples', 'clearingSamples', 'decSamples', 'decReturnSamples', 'excludedSamples'] as const) {
		const samples = review[key]
		if (!Array.isArray(samples) || !samples.every(isSample)) return invalid(`the review ${key} are invalid`)
	}

	return { ok: true, record: value as unknown as GuidingCalibrationRecord }
}

// Returns a refusal of the reasons, requiresRecalibration when any of them needs a new calibration.
function refused(reasons: readonly GuidingCalibrationRefusal[]): GuidingCalibrationApplicability {
	return { status: reasons.some((reason) => RECALIBRATION_REASONS.has(reason)) ? 'requiresRecalibration' : 'insufficientEvidence', reasons }
}

// Returns the side of the pier, or undefined when it is not known.
function knownPierSide(side: PierSide | undefined) {
	return side === 'EAST' || side === 'WEST' ? side : undefined
}

// Returns a failed validation.
function invalid(reason: string): GuidingCalibrationRecordValidation {
	return { ok: false, reason }
}

// Whether the value is a non-null, non-array object.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Whether the value is a finite number.
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

// Whether the value is a non-negative integer.
function isCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0
}

// Whether a and b agree within 1e-6 of scale, plus 1e-12 absolute so zeros compare.
function near(a: number, b: number, scale: number) {
	return Math.abs(a - b) <= 1e-6 * Math.abs(scale) + 1e-12
}

// Returns the value as a matrix when it is four finite numbers.
function validMatrix(value: unknown): CalibrationMatrix | undefined {
	return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber) ? [value[0], value[1], value[2], value[3]] : undefined
}

// Whether inverse times matrix is the identity, within 1e-6.
function isInverse(matrix: CalibrationMatrix, inverse: CalibrationMatrix) {
	const [a, b, c, d] = matrix
	const [p, q, r, s] = inverse
	return Math.abs(p * a + q * c - 1) <= 1e-6 && Math.abs(p * b + q * d) <= 1e-6 && Math.abs(r * a + s * c) <= 1e-6 && Math.abs(r * b + s * d - 1) <= 1e-6
}

// Returns the value as an axis solution when it has a unit direction, a positive finite rate, finite travel, pulse
// time, angle and residual, a reverse-step count, and one of the two directions.
function validAxis<D extends string>(value: unknown, positive: D, negative: D): (GuidingCalibrationAxisSolution & { readonly direction: D }) | undefined {
	if (!isRecord(value)) return undefined
	const { unitX, unitY, ratePxPerMs, totalTravelPx, totalPulse, angle, rmsOrthogonalResidualPx, negativeProjectionCount, direction } = value
	if (!isFiniteNumber(unitX) || !isFiniteNumber(unitY) || !(Math.abs(Math.hypot(unitX, unitY) - 1) <= 1e-6)) return undefined
	if (!isFiniteNumber(ratePxPerMs) || !(ratePxPerMs > 0)) return undefined
	if (!isFiniteNumber(totalTravelPx) || !isFiniteNumber(totalPulse) || !isFiniteNumber(angle) || !isFiniteNumber(rmsOrthogonalResidualPx) || !isCount(negativeProjectionCount)) return undefined
	if (direction !== positive && direction !== negative) return undefined
	return value as unknown as GuidingCalibrationAxisSolution & { readonly direction: D }
}

// Whether the value is a well-formed calibration sample: a known leg and finite step, pulse and positions.
function isSample(value: unknown) {
	if (!isRecord(value)) return false
	const { leg, step, pulse, x, y, deltaX, deltaY, netX, netY } = value
	if (leg !== 'raForward' && leg !== 'raClearing' && leg !== 'decForward' && leg !== 'decReturn') return false
	return isFiniteNumber(step) && isFiniteNumber(pulse) && isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(deltaX) && isFiniteNumber(deltaY) && isFiniteNumber(netX) && isFiniteNumber(netY)
}
