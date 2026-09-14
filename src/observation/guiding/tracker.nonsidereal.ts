import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import type { EphemerisInterpolator } from '../../astronomy/ephemeris/interpolation/ephemeris'
import { Timescale, timeConvert, timeShift, toJulianDay, type Time } from '../../astronomy/time/time'
import { DAYSEC, PI, ASEC2RAD, TAU } from '../../core/constants'
import type { GuideTracker, GuideTrackerContext, GuideTrackerFrame, GuideTrackerResult } from './tracker'

// Synchronous non-sidereal contracts and numerical helpers. Positions are equatorial RA/DEC in
// radians, time validity is inclusive JD TT, angular offsets are local east/north radians, and image
// offsets are pixels in the same origin and axis directions as GuideTrackerResult.targetOffset.

// Runtime states for a non-sidereal source. `rateDegraded` still permits safe absolute-position
// offsets; `limitReached` and `faulted` do not.
export type NonSiderealState = 'disabled' | 'armed' | 'active' | 'rateDegraded' | 'limitReached' | 'faulted'

// Machine-readable reasons for refusing a non-sidereal position or derivative.
export type NonSiderealFailureCode = 'outsideValidity' | 'invalidPosition' | 'invalidTime' | 'invalidTransform' | 'antipodal' | 'angularLimit' | 'pixelLimit' | 'outOfOrder' | 'providerError' | 'rateUnavailable' | 'rateLimit'

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

// Structured non-sidereal telemetry attached to a generic tracker result. Snapshots are freshly
// allocated for each frame so consumers cannot mutate the tracker anchor or derivative state.
export interface NonSiderealTrackerDiagnostic {
	// State reached while processing the current frame.
	readonly state: NonSiderealState
	// Stable failure or degraded-quality reason, when applicable.
	readonly reason?: NonSiderealFailureCode | 'rateUnavailable'
	// Current absolute position, in RA/DEC radians.
	readonly position?: NonSiderealPositionSnapshot
	// Current position time in the provider's Time representation.
	readonly captureTime?: Time
	// Relative angular offset from the anchor, in east/north radians.
	readonly angularOffset?: readonly [number, number]
	// Relative image target offset, in pixels.
	readonly targetOffset?: readonly [number, number]
	// Angular separation from the anchor, in radians.
	readonly separationRadians?: number
	// Finite-difference angular rate, in radians per second.
	readonly rateRadiansPerSecond?: readonly [number, number]
	// Finite-difference angular acceleration, in radians per second squared.
	readonly accelerationRadiansPerSecondSquared?: readonly [number, number]
	// Step used by the derivative estimate, in seconds.
	readonly derivativeStepSeconds?: number
	// Age of the derivative sample relative to this frame, in seconds.
	readonly derivativeAgeSeconds?: number
	// Generation of the transform used for this frame, when supplied.
	readonly transformGeneration?: number
	// Frame identifier associated with the diagnostic.
	readonly frameId?: number
}

// Generic tracking result carrying the non-sidereal state without narrowing the base tracker
// result. Stellar detections and all other base fields remain present by structural composition.
export interface NonSiderealTrackerResult extends GuideTrackerResult {
	// Structured non-sidereal state and current-frame telemetry.
	readonly nonSidereal: NonSiderealTrackerDiagnostic
}

// Runtime configuration for the persistent non-sidereal decorator. All angular limits are radians.
export interface NonSiderealTrackerOptions {
	// Geometry limits applied to the absolute anchor-to-current offset.
	readonly geometry?: NonSiderealGeometryOptions
	// Finite-difference step and validity-window controls.
	readonly derivative?: NonSiderealDerivativeOptions
	// Optional maximum angular velocity in radians per second.
	readonly maxRateRadiansPerSecond?: number
	// Optional maximum angular acceleration in radians per second squared.
	readonly maxAccelerationRadiansPerSecondSquared?: number
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

// Persistent decorator that combines a synchronous non-sidereal target offset with a base image
// tracker. The base tracker owns detection, identity, staged state, and commit timing.
export class NonSiderealTracker implements GuideTracker {
	readonly baseTracker: GuideTracker
	readonly options: NonSiderealTrackerOptions
	#ephemeris?: NonSiderealEphemeris
	#transform?: NonSiderealImageTransform
	#anchor?: { readonly time: Time; readonly position: NonSiderealPositionSnapshot }
	#lastCapture?: { readonly julianDay: number; readonly monotonic?: number }
	#failureReason?: NonSiderealFailureCode | 'rateUnavailable'
	#state: NonSiderealState = 'disabled'
	#lastResult?: NonSiderealTrackerResult

	// Creates a persistent wrapper around a base tracker without changing the base tracker's identity.
	constructor(baseTracker: GuideTracker, options: NonSiderealTrackerOptions = {}) {
		this.baseTracker = baseTracker
		this.options = options
	}

	// Returns the current state without exposing mutable internal objects.
	get state() {
		return this.#state
	}

	// Returns the most recent decorated result, including its immutable telemetry snapshot.
	get lastResult(): NonSiderealTrackerResult | undefined {
		return this.#lastResult
	}

	// Configures a synchronous source and image transform, clears the previous anchor, and arms the
	// decorator. Provider and transform execution begins only after a guided lock exists.
	arm(ephemeris: NonSiderealEphemeris, transform: NonSiderealImageTransform) {
		if (typeof ephemeris.position !== 'function') throw new NonSiderealError('providerError', 'non-sidereal ephemeris has no synchronous position function')
		if (typeof transform.offsetToImage !== 'function') throw new NonSiderealError('invalidTransform', 'non-sidereal transform has no synchronous offset function')
		this.#ephemeris = ephemeris
		this.#transform = transform
		this.#anchor = undefined
		this.#lastCapture = undefined
		this.#failureReason = undefined
		this.#lastResult = undefined
		this.#state = 'armed'
	}

	// Captures a fresh celestial anchor while preserving the configured source and transform. The
	// optional position avoids a second provider call when the caller already owns a valid sample.
	reanchor(time: Time, position?: EquatorialCoordinate) {
		if (this.#ephemeris === undefined || this.#transform === undefined) throw new NonSiderealError('providerError', 'non-sidereal tracker is not armed')
		const snapshot = position === undefined ? this.#positionAt(time) : nonSiderealPositionSnapshot(position)
		const julianDay = this.#julianDayOf(time)
		this.#anchor = { time, position: snapshot }
		this.#lastCapture = { julianDay }
		this.#failureReason = undefined
		this.#state = 'active'
	}

	// Clears temporal state and the base tracker while preserving a configured source for the next
	// visual lock. An armed source returns to armed; an unconfigured source returns to disabled.
	reset() {
		this.baseTracker.reset()
		this.#anchor = undefined
		this.#lastCapture = undefined
		this.#failureReason = undefined
		this.#lastResult = undefined
		this.#state = this.#ephemeris === undefined || this.#transform === undefined ? 'disabled' : 'armed'
	}

	// Disables non-sidereal control and removes its source, transform, anchor, and diagnostics.
	clear() {
		this.#ephemeris = undefined
		this.#transform = undefined
		this.#anchor = undefined
		this.#lastCapture = undefined
		this.#failureReason = undefined
		this.#lastResult = undefined
		this.#state = 'disabled'
	}

	// Invalidates transform-dependent derivative diagnostics while retaining the celestial anchor.
	onCalibrationChanged() {
		if (this.#state === 'active' || this.#state === 'rateDegraded') this.#state = 'active'
	}

	// Delegates staged state commit to the base tracker at the exact point chosen by the guide
	// consumer. The decorator never commits or advances base identity during track().
	commit() {
		this.baseTracker.commit?.()
	}

	// Tracks the base frame first, then adds an absolute-position offset only for an established
	// guided lock. Calibration, acquisition, and lost-lock frames remain free of ephemeris calls.
	track(frame: GuideTrackerFrame, context: GuideTrackerContext): NonSiderealTrackerResult {
		const baseResult = this.baseTracker.track(frame, context)
		if (this.#ephemeris === undefined || this.#transform === undefined) return this.#publish(this.#result(baseResult, { state: 'disabled', frameId: frame.frameId }))
		if (context.phase !== 'guiding' || context.lockEstablished !== true) return this.#publish(this.#result(baseResult, { state: this.#state, frameId: frame.frameId }))

		if (frame.captureTime === undefined) return this.#failure(baseResult, frame, 'invalidTime', 'non-sidereal guiding requires an astronomical capture time')
		let julianDay: number
		try {
			julianDay = this.#julianDayOf(frame.captureTime)
		} catch {
			return this.#failure(baseResult, frame, 'invalidTime', 'non-sidereal capture time is not finite')
		}
		const hasCurrentMonotonic = frame.captureMonotonic !== undefined && Number.isFinite(frame.captureMonotonic)
		if (this.#lastCapture !== undefined && (this.#lastCapture.monotonic !== undefined && hasCurrentMonotonic ? frame.captureMonotonic <= this.#lastCapture.monotonic : julianDay <= this.#lastCapture.julianDay)) {
			return this.#failure(baseResult, frame, 'outOfOrder', 'non-sidereal frame capture time is duplicate or out of order')
		}
		if (this.#state === 'faulted' || this.#state === 'limitReached') return this.#failure(baseResult, frame, this.#failureReason ?? 'providerError', 'non-sidereal tracker requires reset, clear, or reanchor after a fault')

		if (this.#anchor === undefined) {
			try {
				this.reanchor(frame.captureTime)
			} catch (error) {
				return this.#failure(baseResult, frame, error instanceof NonSiderealError ? error.code : 'providerError', error instanceof Error ? error.message : 'non-sidereal anchor failed')
			}
			this.#rememberCapture(frame, julianDay)
			const baseOffset = baseResult.targetOffset ?? [0, 0]
			return this.#publish(this.#result(baseResult, { state: 'active', targetOffset: [baseOffset[0], baseOffset[1]], captureTime: frame.captureTime, frameId: frame.frameId }))
		}

		this.#rememberCapture(frame, julianDay)
		let position: NonSiderealPositionSnapshot
		try {
			position = this.#positionAt(frame.captureTime)
		} catch (error) {
			return this.#failure(baseResult, frame, error instanceof NonSiderealError ? error.code : 'providerError', error instanceof Error ? error.message : 'non-sidereal position failed')
		}

		let angularOffset: NonSiderealAngularOffset
		try {
			angularOffset = nonSiderealAngularOffset(this.#anchor.position, position, this.options.geometry)
		} catch (error) {
			return this.#failure(baseResult, frame, error instanceof NonSiderealError ? error.code : 'providerError', error instanceof Error ? error.message : 'non-sidereal angular geometry failed', position)
		}

		let targetOffset: readonly [number, number]
		try {
			const transformed = this.#transform.offsetToImage([angularOffset.east, angularOffset.north], frame.captureTime, frame)
			if (transformed === undefined || !Number.isFinite(transformed[0]) || !Number.isFinite(transformed[1])) throw new NonSiderealError('invalidTransform', 'non-sidereal transform returned a non-finite offset')
			const baseOffset = baseResult.targetOffset ?? [0, 0]
			targetOffset = [baseOffset[0] + transformed[0], baseOffset[1] + transformed[1]]
			if (!Number.isFinite(targetOffset[0]) || !Number.isFinite(targetOffset[1])) throw new NonSiderealError('invalidTransform', 'combined non-sidereal target offset is not finite')
		} catch (error) {
			return this.#failure(baseResult, frame, error instanceof NonSiderealError ? error.code : 'invalidTransform', error instanceof Error ? error.message : 'non-sidereal transform failed', position, angularOffset)
		}

		const derivative = estimateNonSiderealDerivative(this.#ephemeris, frame.captureTime, this.options.derivative)
		if (this.options.maxRateRadiansPerSecond !== undefined && derivative.rate !== undefined && Math.hypot(derivative.rate[0], derivative.rate[1]) > this.options.maxRateRadiansPerSecond) {
			return this.#failure(baseResult, frame, 'rateLimit', 'non-sidereal angular rate exceeded its configured limit', position, angularOffset, derivative)
		}
		if (this.options.maxAccelerationRadiansPerSecondSquared !== undefined && derivative.acceleration !== undefined && Math.hypot(derivative.acceleration[0], derivative.acceleration[1]) > this.options.maxAccelerationRadiansPerSecondSquared) {
			return this.#failure(baseResult, frame, 'rateLimit', 'non-sidereal angular acceleration exceeded its configured limit', position, angularOffset, derivative)
		}

		const state: NonSiderealState = derivative.available ? 'active' : 'rateDegraded'
		this.#state = state
		return this.#publish(
			this.#result(baseResult, {
				state,
				reason: derivative.available ? undefined : 'rateUnavailable',
				position,
				captureTime: frame.captureTime,
				angularOffset: [angularOffset.east, angularOffset.north],
				targetOffset,
				separationRadians: angularOffset.separation,
				rateRadiansPerSecond: derivative.rate,
				accelerationRadiansPerSecondSquared: derivative.acceleration,
				derivativeStepSeconds: derivative.stepSeconds,
				frameId: frame.frameId,
			}),
		)
	}

	// Publishes a result with a fresh diagnostic object and no mutable alias to internal state.
	#publish(result: NonSiderealTrackerResult) {
		this.#lastResult = result
		return result
	}

	// Creates a decorated result while preserving every base tracker field and array identity.
	#result(baseResult: GuideTrackerResult, diagnostic: NonSiderealTrackerDiagnostic): NonSiderealTrackerResult {
		return { ...baseResult, targetOffset: diagnostic.targetOffset ?? baseResult.targetOffset, nonSidereal: diagnostic }
	}

	// Produces a safe failure result: the visual measurement cannot feed the sideral controller and
	// no previous target offset is reused after a provider, time, or transform failure.
	#failure(baseResult: GuideTrackerResult, frame: GuideTrackerFrame, reason: NonSiderealFailureCode | 'rateUnavailable', message: string, position?: NonSiderealPositionSnapshot, angularOffset?: NonSiderealAngularOffset, derivative?: NonSiderealDerivative): NonSiderealTrackerResult {
		this.#failureReason = reason
		this.#state = reason === 'rateUnavailable' ? 'rateDegraded' : reason === 'angularLimit' || reason === 'pixelLimit' ? 'limitReached' : 'faulted'
		return this.#publish({
			...baseResult,
			measurement: undefined,
			qualityScore: 0,
			targetOffset: undefined,
			notes: [...baseResult.notes, `non_sidereal_${reason}`, message],
			nonSidereal: {
				state: this.#state,
				reason,
				position,
				captureTime: frame.captureTime,
				angularOffset: angularOffset === undefined ? undefined : [angularOffset.east, angularOffset.north],
				separationRadians: angularOffset?.separation,
				rateRadiansPerSecond: derivative?.rate,
				accelerationRadiansPerSecondSquared: derivative?.acceleration,
				derivativeStepSeconds: derivative?.stepSeconds,
				frameId: frame.frameId,
			},
		})
	}

	// Evaluates and validates one absolute ephemeris position without retaining provider scratch.
	#positionAt(time: Time): NonSiderealPositionSnapshot {
		if (this.#ephemeris === undefined) throw new NonSiderealError('providerError', 'non-sidereal tracker is not armed')
		const output: EquatorialCoordinate = { rightAscension: 0, declination: 0 }
		try {
			return nonSiderealPositionSnapshot(this.#ephemeris.position(time, output))
		} catch (error) {
			if (error instanceof NonSiderealError) throw error
			throw new NonSiderealError('providerError', error instanceof Error ? error.message : 'non-sidereal position provider failed')
		}
	}

	// Converts a capture instant to finite JD TT for frame ordering and derivative-window checks.
	#julianDayOf(time: Time) {
		const julianDay = toJulianDay(timeConvert(time, Timescale.TT))
		if (!Number.isFinite(julianDay)) throw new NonSiderealError('invalidTime', 'non-sidereal time is not finite')
		return julianDay
	}

	// Records frame ordering after the current frame has passed the duplicate/out-of-order check.
	#rememberCapture(frame: GuideTrackerFrame, julianDay: number) {
		this.#lastCapture = { julianDay, monotonic: frame.captureMonotonic !== undefined && Number.isFinite(frame.captureMonotonic) ? frame.captureMonotonic : undefined }
	}
}

// Returns the underlying tracker so capability checks continue to recognize a decorated tracker.
export function baseTrackerOf(tracker: GuideTracker): GuideTracker {
	return tracker instanceof NonSiderealTracker ? tracker.baseTracker : tracker
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
