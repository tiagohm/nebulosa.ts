import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import type { EphemerisInterpolator } from '../../astronomy/ephemeris/interpolation/ephemeris'
import { Timescale, timeConvert, timeShift, toJulianDay, type Time } from '../../astronomy/time/time'
import { DAYSEC, PI, ASEC2RAD, TAU } from '../../core/constants'
import type { GuideTrackerFrame } from './tracker'

// Synchronous non-sidereal contracts and numerical helpers. Positions are equatorial RA/DEC in
// radians, time validity is inclusive JD TT, angular offsets are local east/north radians, and image
// offsets are pixels in the same origin and axis directions as GuideTrackerResult.targetOffset.

// Runtime states for a non-sidereal source. `rateDegraded` still permits safe absolute-position
// offsets; `limitReached` and `faulted` do not.
export type NonSiderealState = 'disabled' | 'armed' | 'active' | 'rateDegraded' | 'limitReached' | 'faulted'

// Machine-readable reasons for refusing a non-sidereal position or derivative.
export type NonSiderealFailureCode = 'outsideValidity' | 'invalidPosition' | 'invalidTime' | 'invalidTransform' | 'antipodal' | 'angularLimit' | 'pixelLimit' | 'outOfOrder' | 'providerError' | 'rateUnavailable'

// A synchronous position source. RA is normalized to [0, TAU), DEC is in [-PI/2, PI/2], and the
// supplied output object is mutated and returned. Providers must not perform I/O or return a Promise.
export interface NonSiderealEphemeris {
	// Writes the apparent or astrometric position represented by this source at `time` into `out`.
	readonly position: (time: Time, out: EquatorialCoordinate) => EquatorialCoordinate
	// Inclusive validity interval in JD TT. A missing interval means the provider owns its validity.
	readonly validTime?: readonly [number, number]
	// Optional generation used to invalidate derivative/transform caches after a source update.
	readonly generation?: number | (() => number)
}

// A synchronous transformation from a local celestial offset to image pixels. The provider owns
// calibration, orientation, scale, WCS/Jacobian choice, image origin, and any position dependence.
export interface NonSiderealImageTransform {
	// Converts [east, north] radians at `time` into [x, y] image pixels, or rejects the frame.
	readonly offsetToImage: (eastNorthRadians: readonly [number, number], time: Time, frame: GuideTrackerFrame) => readonly [number, number] | undefined
	// Optional generation used to invalidate cached image derivatives after calibration changes.
	readonly generation?: number | (() => number)
}

// Structured failure thrown at the synchronous provider boundary. The tracker can convert it into
// a safe diagnostic without allowing a Promise or untyped provider exception to cross track().
export class NonSiderealError extends Error {
	// Machine-readable reason for the rejected position, geometry, transform, or derivative.
	readonly code: NonSiderealFailureCode

	// Creates a typed non-sidereal failure with a stable code and diagnostic message.
	constructor(code: NonSiderealFailureCode, message: string) {
		super(message)
		this.name = 'NonSiderealError'
		this.code = code
	}
}

// Stable angular offset from an anchor to a current position. Components are local east and north
// tangent-plane radians at the anchor; separation is the great-circle distance in radians.
export interface NonSiderealAngularOffset {
	// Eastward tangent-plane component, in radians.
	readonly east: number
	// Northward tangent-plane component, in radians.
	readonly north: number
	// Great-circle separation between anchor and current position, in radians.
	readonly separation: number
}

// Limits protecting the local tangent approximation and image-control envelope.
export interface NonSiderealGeometryOptions {
	// Maximum accepted great-circle separation, in radians; must be strictly below PI.
	readonly maxAngularSeparationRadians?: number
	// Cross-product magnitude below which an antipodal direction is considered undefined.
	readonly antipodalTolerance?: number
}

// Result of a finite-difference estimate in local east/north radians per second and radians per
// second squared. `oneSided` identifies a validity-window boundary estimate.
export interface NonSiderealDerivative {
	// Whether a finite rate was obtained.
	readonly available: boolean
	// Local angular velocity [east, north], in radians per second.
	readonly rate?: readonly [number, number]
	// Local angular acceleration [east, north], in radians per second squared.
	readonly acceleration?: readonly [number, number]
	// Step used for the estimate, in seconds.
	readonly stepSeconds?: number
	// Whether the selected stencil was one-sided at a validity boundary.
	readonly oneSided: boolean
	// Stable reason when no derivative is available.
	readonly reason?: 'rateUnavailable' | 'outsideValidity' | 'providerError'
}

// Finite-difference controls. The default uses a five-point centered stencil when the validity
// interval permits it, then falls back to centered/one-sided lower-order formulas without retries.
export interface NonSiderealDerivativeOptions {
	// Requested finite-difference step, in seconds.
	readonly stepSeconds?: number
	// Minimum allowed step, in seconds.
	readonly minStepSeconds?: number
	// Maximum allowed step, in seconds.
	readonly maxStepSeconds?: number
}

// Explicit mapping from celestial east/north radians to calibrated RA/DEC axis radians. The first
// row is RA-axis angular motion per [east, north], and the second row is DEC-axis angular motion.
export interface NonSiderealAxisOrientation {
	readonly axisFromEastNorth: readonly [number, number, number, number]
}

// Configuration for the scale-and-calibration transform. `pixelScaleArcsecPerPixel` is arcsec/pixel,
// and `calibration` contains the image direction of positive calibrated RA/DEC-axis motion.
export interface CalibratedNonSiderealTransformOptions {
	// Current guider scale, in arcseconds per image pixel.
	readonly pixelScaleArcsecPerPixel: number
	// Unit image directions observed for positive calibrated axes.
	readonly calibration: {
		readonly ra: { readonly unitX: number; readonly unitY: number }
		readonly dec: { readonly unitX: number; readonly unitY: number }
	}
	// Explicit celestial-to-axis orientation; identity means east=RA and north=DEC.
	readonly orientation?: NonSiderealAxisOrientation
	// Optional generation forwarded to the transform contract.
	readonly generation?: number | (() => number)
}

// Snapshot of an equatorial position with no alias to provider scratch state.
export interface NonSiderealPositionSnapshot {
	readonly rightAscension: number
	readonly declination: number
}

// Default maximum local separation leaves a unique tangent direction away from the antipode.
export const DEFAULT_NONSIDEREAL_MAX_ANGULAR_SEPARATION = PI - 1e-7

// Default cross-product tolerance for rejecting an undefined antipodal tangent direction.
export const DEFAULT_NONSIDEREAL_ANTIPODAL_TOLERANCE = 1e-10

// Default finite-difference step, in seconds, suitable for smooth local ephemeris interpolation.
export const DEFAULT_NONSIDEREAL_DERIVATIVE_STEP_SECONDS = 30

// Reads a generation value without exposing whether it is stored or computed.
export function nonSiderealGenerationOf(source: { readonly generation?: number | (() => number) }) {
	return typeof source.generation === 'function' ? source.generation() : source.generation
}

// Copies and validates an equatorial position. The result is a new object and the input object is
// never retained; RA is normalized and DEC remains signed in its physical domain.
export function nonSiderealPositionSnapshot(position: EquatorialCoordinate): NonSiderealPositionSnapshot {
	const rightAscension = position.rightAscension
	const declination = position.declination
	if (!Number.isFinite(rightAscension) || !Number.isFinite(declination) || declination < -Math.PI / 2 || declination > Math.PI / 2) {
		throw new NonSiderealError('invalidPosition', 'non-sidereal position is not finite or has invalid declination')
	}
	return { rightAscension: normalizeRightAscension(rightAscension), declination }
}

// Converts equatorial RA/DEC radians into a unit vector in the source's declared frame.
export function nonSiderealUnitVector(position: EquatorialCoordinate): readonly [number, number, number] {
	const snapshot = nonSiderealPositionSnapshot(position)
	const cosDeclination = Math.cos(snapshot.declination)
	return [cosDeclination * Math.cos(snapshot.rightAscension), cosDeclination * Math.sin(snapshot.rightAscension), Math.sin(snapshot.declination)]
}

// Computes a stable local tangent-plane offset with atan2 separation and a log-map scale. Tiny
// offsets use the direct projected difference; near-antipodal positions are rejected because their
// direction is not unique. East and north are the anchor's conventional RA/DEC basis.
export function nonSiderealAngularOffset(anchor: EquatorialCoordinate, current: EquatorialCoordinate, options: NonSiderealGeometryOptions = {}): NonSiderealAngularOffset {
	const anchorSnapshot = nonSiderealPositionSnapshot(anchor)
	const currentSnapshot = nonSiderealPositionSnapshot(current)
	const anchorVector = nonSiderealUnitVector(anchorSnapshot)
	const currentVector = nonSiderealUnitVector(currentSnapshot)
	const crossX = anchorVector[1] * currentVector[2] - anchorVector[2] * currentVector[1]
	const crossY = anchorVector[2] * currentVector[0] - anchorVector[0] * currentVector[2]
	const crossZ = anchorVector[0] * currentVector[1] - anchorVector[1] * currentVector[0]
	const crossMagnitude = Math.hypot(crossX, crossY, crossZ)
	const dot = clampUnit(anchorVector[0] * currentVector[0] + anchorVector[1] * currentVector[1] + anchorVector[2] * currentVector[2])
	const separation = Math.atan2(crossMagnitude, dot)
	const maxSeparation = options.maxAngularSeparationRadians ?? DEFAULT_NONSIDEREAL_MAX_ANGULAR_SEPARATION
	const antipodalTolerance = options.antipodalTolerance ?? DEFAULT_NONSIDEREAL_ANTIPODAL_TOLERANCE

	if (!(maxSeparation > 0 && maxSeparation < PI) || separation > maxSeparation) throw new NonSiderealError('angularLimit', `non-sidereal separation exceeds ${maxSeparation} radians`)
	if (dot < 0 && crossMagnitude <= antipodalTolerance) throw new NonSiderealError('antipodal', 'non-sidereal separation has no unique tangent direction')

	const sinRightAscension = Math.sin(anchorSnapshot.rightAscension)
	const cosRightAscension = Math.cos(anchorSnapshot.rightAscension)
	const sinDeclination = Math.sin(anchorSnapshot.declination)
	const cosDeclination = Math.cos(anchorSnapshot.declination)
	const east: readonly [number, number, number] = [-sinRightAscension, cosRightAscension, 0]
	const north: readonly [number, number, number] = [-sinDeclination * cosRightAscension, -sinDeclination * sinRightAscension, cosDeclination]

	if (crossMagnitude <= antipodalTolerance) {
		if (separation === 0) return { east: 0, north: 0, separation }
		throw new NonSiderealError('antipodal', 'non-sidereal tangent direction is numerically undefined')
	}

	const scale = separation / crossMagnitude
	const tangentX = (currentVector[0] - dot * anchorVector[0]) * scale
	const tangentY = (currentVector[1] - dot * anchorVector[1]) * scale
	const tangentZ = (currentVector[2] - dot * anchorVector[2]) * scale
	return {
		east: tangentX * east[0] + tangentY * east[1] + tangentZ * east[2],
		north: tangentX * north[0] + tangentY * north[1] + tangentZ * north[2],
		separation,
	}
}

// Creates an explicit scale-and-calibration image transform. The astronomical input is east/north
// radians; ASEC2RAD converts the supplied arcsec/pixel scale before applying calibrated axis vectors.
export function calibratedNonSiderealTransform(options: CalibratedNonSiderealTransformOptions): NonSiderealImageTransform {
	const scale = options.pixelScaleArcsecPerPixel * ASEC2RAD
	if (!(scale > 0) || !Number.isFinite(scale)) throw new NonSiderealError('invalidTransform', 'pixel scale must be finite and positive')
	const [a00, a01, a10, a11] = options.orientation?.axisFromEastNorth ?? [1, 0, 0, 1]
	const { ra, dec } = options.calibration
	const values = [a00, a01, a10, a11, ra.unitX, ra.unitY, dec.unitX, dec.unitY]
	if (values.some((value) => !Number.isFinite(value))) throw new NonSiderealError('invalidTransform', 'calibration transform contains a non-finite value')

	return {
		generation: options.generation,
		offsetToImage: (eastNorthRadians) => {
			const east = eastNorthRadians[0]
			const north = eastNorthRadians[1]
			const raPixels = (a00 * east + a01 * north) / scale
			const decPixels = (a10 * east + a11 * north) / scale
			const result: readonly [number, number] = [ra.unitX * raPixels + dec.unitX * decPixels, ra.unitY * raPixels + dec.unitY * decPixels]
			return Number.isFinite(result[0]) && Number.isFinite(result[1]) ? result : undefined
		},
	}
}

// Wraps an EphemerisInterpolator with an inclusive JD-TT preflight. It always uses computeInto(),
// never accepts the interpolator's default clamp behavior outside the declared table, and exposes a
// generation that changes when the adapter is explicitly updated.
export class InterpolatedNonSiderealEphemeris implements NonSiderealEphemeris {
	#interpolator: EphemerisInterpolator
	#generation = 0
	#validTime: [number, number]
	readonly position: NonSiderealEphemeris['position']

	// Creates an adapter around a local interpolation table and captures its inclusive TT bounds.
	constructor(interpolator: EphemerisInterpolator) {
		this.#interpolator = interpolator
		this.#validTime = [interpolator.startTime, interpolator.endTime]
		this.position = (time, out) => {
			const tt = timeConvert(time, Timescale.TT)
			const julianDay = toJulianDay(tt)
			if (julianDay < this.#validTime[0] || julianDay > this.#validTime[1]) throw new NonSiderealError('outsideValidity', 'ephemeris time is outside the inclusive interpolation window')
			const scratch: [number, number] = [0, 0]
			try {
				this.#interpolator.computeInto(tt, scratch)
			} catch (error) {
				if (error instanceof NonSiderealError) throw error
				throw new NonSiderealError('providerError', error instanceof Error ? error.message : 'ephemeris interpolation failed')
			}
			out.rightAscension = normalizeRightAscension(scratch[0])
			out.declination = scratch[1]
			nonSiderealPositionSnapshot(out)
			return out
		}
	}

	// Returns the inclusive Julian-date validity interval in TT.
	get validTime(): readonly [number, number] {
		return this.#validTime
	}

	// Current adapter generation; update() increments it so consumers can invalidate local caches.
	get generation() {
		return this.#generation
	}

	// Replaces the local interpolator and validity window without exposing a stale cached table.
	update(interpolator: EphemerisInterpolator) {
		this.#interpolator = interpolator
		this.#validTime = [interpolator.startTime, interpolator.endTime]
		this.#generation++
	}
}

// Creates the interpolator adapter with a concise factory name for integration code.
export function nonSiderealEphemerisFromInterpolator(interpolator: EphemerisInterpolator) {
	return new InterpolatedNonSiderealEphemeris(interpolator)
}

// Estimates local angular rate and, when the centered five-point stencil is available, acceleration.
// Samples are absolute positions evaluated at valid times; no rate is integrated into a position.
export function estimateNonSiderealDerivative(ephemeris: NonSiderealEphemeris, time: Time, options: NonSiderealDerivativeOptions = {}): NonSiderealDerivative {
	const requestedStep = options.stepSeconds ?? DEFAULT_NONSIDEREAL_DERIVATIVE_STEP_SECONDS
	const minStep = options.minStepSeconds ?? 0.001
	const maxStep = options.maxStepSeconds ?? 3600
	const stepSeconds = clampFinite(requestedStep, minStep, maxStep)
	if (!(stepSeconds > 0)) return { available: false, oneSided: false, reason: 'rateUnavailable' }
	const center = makePosition()
	try {
		ephemeris.position(time, center)
	} catch (error) {
		return { available: false, oneSided: false, reason: error instanceof NonSiderealError && error.code === 'outsideValidity' ? 'outsideValidity' : 'providerError' }
	}

	const valid = ephemeris.validTime
	const centerDay = toJulianDay(timeConvert(time, Timescale.TT))
	const h = stepSeconds / DAYSEC
	const canSample = (offset: number) => valid === undefined || (centerDay + offset >= valid[0] && centerDay + offset <= valid[1])
	const sample = (offset: number) => {
		const sampleTime = timeShift(time, offset)
		const position = makePosition()
		ephemeris.position(sampleTime, position)
		return nonSiderealAngularOffset(center, position)
	}
	const values = (offsets: readonly number[]) => offsets.map((offset) => sample(offset))

	try {
		if (canSample(-2 * h) && canSample(-h) && canSample(h) && canSample(2 * h)) {
			const [minus2, minus1, plus1, plus2] = values([-2 * h, -h, h, 2 * h])
			const rate = derivativeFivePoint(minus2, minus1, plus1, plus2, stepSeconds)
			const acceleration = accelerationFivePoint(minus2, minus1, { east: 0, north: 0, separation: 0 }, plus1, plus2, stepSeconds)
			return { available: true, rate, acceleration, stepSeconds, oneSided: false } as const
		}
		if (canSample(-h) && canSample(h)) {
			const [minus1, plus1] = values([-h, h])
			return { available: true, rate: derivativeCentered(minus1, plus1, stepSeconds), stepSeconds, oneSided: false } as const
		}
		if (canSample(0) && canSample(h) && canSample(2 * h) && canSample(3 * h) && canSample(4 * h)) {
			const [zero, plus1, plus2, plus3, plus4] = values([0, h, 2 * h, 3 * h, 4 * h])
			return { available: true, rate: derivativeForwardFivePoint(zero, plus1, plus2, plus3, plus4, stepSeconds), stepSeconds, oneSided: true } as const
		}
		if (canSample(0) && canSample(-h) && canSample(-2 * h) && canSample(-3 * h) && canSample(-4 * h)) {
			const [zero, minus1, minus2, minus3, minus4] = values([0, -h, -2 * h, -3 * h, -4 * h])
			return { available: true, rate: derivativeBackwardFivePoint(zero, minus1, minus2, minus3, minus4, stepSeconds), stepSeconds, oneSided: true } as const
		}
		if (canSample(0) && canSample(h) && canSample(2 * h)) {
			const [zero, plus1, plus2] = values([0, h, 2 * h])
			return { available: true, rate: derivativeForwardThreePoint(zero, plus1, plus2, stepSeconds), stepSeconds, oneSided: true } as const
		}
		if (canSample(0) && canSample(-h) && canSample(-2 * h)) {
			const [zero, minus1, minus2] = values([0, -h, -2 * h])
			return { available: true, rate: derivativeBackwardThreePoint(zero, minus1, minus2, stepSeconds), stepSeconds, oneSided: true } as const
		}
	} catch (error) {
		return { available: false, oneSided: false, reason: error instanceof NonSiderealError && error.code === 'outsideValidity' ? 'outsideValidity' : 'providerError' }
	}

	return { available: false, oneSided: false, reason: 'rateUnavailable' }
}

// Allocates a mutable position scratch object for one synchronous provider call.
function makePosition(): EquatorialCoordinate {
	return { rightAscension: 0, declination: 0 }
}

// Normalizes a right ascension and rejects non-finite input before it can enter vector geometry.
function normalizeRightAscension(value: number) {
	if (!Number.isFinite(value)) throw new NonSiderealError('invalidPosition', 'right ascension is not finite')
	const normalized = value % TAU
	return normalized < 0 ? normalized + TAU : normalized
}

// Clamps a dot product affected by floating-point roundoff into the inverse-trigonometric domain.
function clampUnit(value: number) {
	return Math.max(-1, Math.min(1, value))
}

// Clamps a finite numeric setting while preserving the caller's explicit lower/upper bounds.
function clampFinite(value: number, minimum: number, maximum: number) {
	if (!Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum)) return 0
	return Math.max(minimum, Math.min(maximum, value))
}

// Applies the centered five-point first derivative to east/north offsets.
function derivativeFivePoint(minus2: NonSiderealAngularOffset, minus1: NonSiderealAngularOffset, plus1: NonSiderealAngularOffset, plus2: NonSiderealAngularOffset, stepSeconds: number) {
	return [(minus2.east - 8 * minus1.east + 8 * plus1.east - plus2.east) / (12 * stepSeconds), (minus2.north - 8 * minus1.north + 8 * plus1.north - plus2.north) / (12 * stepSeconds)] as const
}

// Applies the centered three-point first derivative to east/north offsets.
function derivativeCentered(minus1: NonSiderealAngularOffset, plus1: NonSiderealAngularOffset, stepSeconds: number) {
	return [(plus1.east - minus1.east) / (2 * stepSeconds), (plus1.north - minus1.north) / (2 * stepSeconds)] as const
}

// Applies a fourth-order forward first derivative at the left validity boundary.
function derivativeForwardFivePoint(zero: NonSiderealAngularOffset, plus1: NonSiderealAngularOffset, plus2: NonSiderealAngularOffset, plus3: NonSiderealAngularOffset, plus4: NonSiderealAngularOffset, stepSeconds: number) {
	return [(-25 * zero.east + 48 * plus1.east - 36 * plus2.east + 16 * plus3.east - 3 * plus4.east) / (12 * stepSeconds), (-25 * zero.north + 48 * plus1.north - 36 * plus2.north + 16 * plus3.north - 3 * plus4.north) / (12 * stepSeconds)] as const
}

// Applies a fourth-order backward first derivative at the right validity boundary.
function derivativeBackwardFivePoint(zero: NonSiderealAngularOffset, minus1: NonSiderealAngularOffset, minus2: NonSiderealAngularOffset, minus3: NonSiderealAngularOffset, minus4: NonSiderealAngularOffset, stepSeconds: number) {
	return [(25 * zero.east - 48 * minus1.east + 36 * minus2.east - 16 * minus3.east + 3 * minus4.east) / (12 * stepSeconds), (25 * zero.north - 48 * minus1.north + 36 * minus2.north - 16 * minus3.north + 3 * minus4.north) / (12 * stepSeconds)] as const
}

// Applies the second-order forward first derivative when only three future samples fit.
function derivativeForwardThreePoint(zero: NonSiderealAngularOffset, plus1: NonSiderealAngularOffset, plus2: NonSiderealAngularOffset, stepSeconds: number) {
	return [(-3 * zero.east + 4 * plus1.east - plus2.east) / (2 * stepSeconds), (-3 * zero.north + 4 * plus1.north - plus2.north) / (2 * stepSeconds)] as const
}

// Applies the second-order backward first derivative when only three past samples fit.
function derivativeBackwardThreePoint(zero: NonSiderealAngularOffset, minus1: NonSiderealAngularOffset, minus2: NonSiderealAngularOffset, stepSeconds: number) {
	return [(3 * zero.east - 4 * minus1.east + minus2.east) / (2 * stepSeconds), (3 * zero.north - 4 * minus1.north + minus2.north) / (2 * stepSeconds)] as const
}

// Applies the centered five-point second derivative; the result is intentionally absent for
// one-sided stencils because no equally stable acceleration contract is promised there.
function accelerationFivePoint(minus2: NonSiderealAngularOffset, minus1: NonSiderealAngularOffset, zero: NonSiderealAngularOffset, plus1: NonSiderealAngularOffset, plus2: NonSiderealAngularOffset, stepSeconds: number) {
	const denominator = 12 * stepSeconds * stepSeconds
	return [(-minus2.east + 16 * minus1.east - 30 * zero.east + 16 * plus1.east - plus2.east) / denominator, (-minus2.north + 16 * minus1.north - 30 * zero.north + 16 * plus1.north - plus2.north) / denominator] as const
}
