import { PI, TAU } from '../../../core/constants'
import { chebyshevLeastSquares, type ChebyshevRegression } from '../../../math/numerical/regression'
import { akimaSpline, catmullRomSpline, cubicHermiteSpline, linearSpline, naturalCubicSpline, pchip } from '../../../math/numerical/spline'
import { normalizeAngle, type Angle } from '../../../math/units/angle'
import type { EquatorialCoordinate } from '../../coordinates/coordinate'
import { type Time, Timescale, timeConvert } from '../../time/time'

// Time-series interpolation of precomputed apparent/topocentric RA and Dec samples. Supports
// linear, spline (several cubic variants), and Chebyshev least-squares strategies behind a common
// interpolator interface, with configurable out-of-range handling and optional RMS diagnostics.
// RA is unwrapped before fitting to avoid the 0/TAU discontinuity and re-normalized on output;
// sample times are shifted by the first sample (TT) to keep the interpolation argument small.

// Selectable interpolation algorithm family.
export type EphemerisInterpolationStrategy = 'linear' | 'spline' | 'chebyshev'

// Behavior when a query time falls outside the sample interval.
export type EphemerisInterpolationOutOfRange = 'clamp' | 'extrapolate' | 'throw'

// Cubic spline slope/segment construction variant.
export type SplineEphemerisInterpolationType = 'naturalCubic' | 'cubicHermite' | 'pchip' | 'akima' | 'catmullRom'

// One ephemeris sample: an equatorial position tagged with its instant.
export interface EphemerisPoint extends Readonly<EquatorialCoordinate> {
	// Instant of the sample (converted internally to TT).
	readonly time: Time
}

// Optional knobs controlling interpolation behavior and diagnostics.
export interface EphemerisInterpolationOptions {
	// Out-of-range handling; defaults to 'clamp'.
	outOfRange?: EphemerisInterpolationOutOfRange
	// When true, compute RMS/max residuals at the sample times.
	computeRmsError?: boolean
	// When true, repeated sample times overwrite instead of throwing.
	allowDuplicateTimes?: boolean
}

// Residual statistics of the fit against the input samples, in radians.
export interface EphemerisInterpolationDiagnostics {
	// Root-mean-square RA residual.
	rmsRA: number
	// Root-mean-square Dec residual.
	rmsDEC: number
	// Maximum absolute RA residual.
	maxAbsRA: number
	// Maximum absolute Dec residual.
	maxAbsDEC: number
}

// Common interface for all RA/Dec interpolators.
export interface EphemerisInterpolator {
	// Which strategy this interpolator implements.
	readonly strategy: EphemerisInterpolationStrategy
	// First sample instant as a TT day number.
	readonly startTime: number
	// Last sample instant as a TT day number.
	readonly endTime: number
	// Number of unique samples used.
	readonly sampleCount: number
	// Fit residuals, present only when computeRmsError was requested.
	readonly diagnostics?: EphemerisInterpolationDiagnostics
	// Interpolates [RA, Dec] (radians) at a time, allocating the result.
	readonly compute: (time: Time) => [Angle, Angle]
	// Interpolates into a caller-provided [RA, Dec] buffer, which is returned.
	readonly computeInto: (time: Time, out: [Angle, Angle]) => [Angle, Angle]
	// Evaluates the fit at many times, returning ephemeris points.
	readonly resample: (times: readonly Time[]) => EphemerisPoint[]
}

// Interpolator that can be rebuilt in place from a new sample set.
export interface UpdatableEphemerisInterpolator extends EphemerisInterpolator {
	// Rebuilds all precomputed interpolation state; the shape leaves room for true incremental updates later.
	readonly update: (points: readonly EphemerisPoint[]) => void
}

// Internal sortable view of a sample, retaining original index for stable ordering.
interface SortableEphemerisPoint {
	// Numeric TT instant (day + fraction) used as the sort key.
	time: number
	// Integer TT day part.
	day: number
	// TT day fraction part.
	fraction: number
	// Right ascension, radians.
	rightAscension: number
	// Declination, radians.
	declination: number
	// Original input index, breaks ties to keep the sort stable.
	order: number
}

// Internal sorted, de-duplicated, RA-unwrapped sample arrays ready for fitting.
interface PreparedEphemerisSamples {
	// Numeric TT instants per sample.
	times: Float64Array
	// Instants shifted to start at zero (days from the first sample).
	normalizedTimes: Float64Array
	// Unwrapped right ascension per sample, radians.
	rightAscension: Float64Array
	// Declination per sample, radians.
	declination: Float64Array
	// First sample instant.
	startTime: number
	// Last sample instant.
	endTime: number
	// Integer TT day of the first sample.
	startDay: number
	// TT day fraction of the first sample.
	startFraction: number
}

// Internal scalar fit over normalized time, evaluated per output component.
interface ScalarInterpolator {
	// Evaluates the fit at normalized argument x.
	readonly compute: (x: number) => number
	// Clears any cached per-stream lookup state.
	readonly reset: () => void
}

// Default out-of-range policy when none is supplied.
const DEFAULT_OUT_OF_RANGE: EphemerisInterpolationOutOfRange = 'clamp'

// Creates a linear ephemeris interpolator for apparent/topocentric RA and Dec samples.
export function linearInterpolator(points: readonly EphemerisPoint[], options?: EphemerisInterpolationOptions): EphemerisInterpolator {
	return new LinearEphemerisInterpolator(points, options)
}

// Creates a spline ephemeris interpolator for apparent/topocentric RA and Dec samples.
export function splineInterpolator(points: readonly EphemerisPoint[], type?: SplineEphemerisInterpolationType, options?: EphemerisInterpolationOptions): EphemerisInterpolator {
	return new SplineEphemerisInterpolator(points, type, options)
}

// Creates a Chebyshev ephemeris interpolator over the bounded sample interval.
export function chebyshevInterpolator(points: readonly EphemerisPoint[], degree?: number, options?: EphemerisInterpolationOptions): EphemerisInterpolator {
	return new ChebyshevEphemerisInterpolator(points, degree, options)
}

abstract class BaseEphemerisInterpolator implements UpdatableEphemerisInterpolator {
	abstract readonly strategy: EphemerisInterpolationStrategy

	startTime = 0
	endTime = 0
	sampleCount = 0
	diagnostics?: EphemerisInterpolationDiagnostics

	protected readonly outOfRange: EphemerisInterpolationOutOfRange
	protected readonly computeRmsError: boolean
	protected readonly allowDuplicateTimes: boolean
	protected time0Day = 0
	protected time0Fraction = 0
	protected duration = 0
	protected raInterpolator!: ScalarInterpolator
	protected decInterpolator!: ScalarInterpolator

	constructor(options?: EphemerisInterpolationOptions) {
		this.outOfRange = options?.outOfRange ?? DEFAULT_OUT_OF_RANGE
		this.computeRmsError = options?.computeRmsError === true
		this.allowDuplicateTimes = options?.allowDuplicateTimes === true
	}

	compute(time: Time) {
		return this.computeInto(time, [0, 0])
	}

	computeInto(time: Time, out: [Angle, Angle]) {
		const x = this.evaluationTime(time)
		out[0] = normalizeAngle(this.raInterpolator.compute(x))
		out[1] = this.decInterpolator.compute(x)
		return out
	}

	resample(times: readonly Time[]) {
		const result = new Array<EphemerisPoint>(times.length)
		const scratch: [Angle, Angle] = [0, 0]

		for (let i = 0; i < times.length; i++) {
			this.computeInto(times[i], scratch)
			result[i] = { time: times[i], rightAscension: scratch[0], declination: scratch[1] }
		}

		return result
	}

	update(points: readonly EphemerisPoint[]) {
		const prepared = prepareSamples(points, this.minimumSampleCount, this.allowDuplicateTimes)
		const evaluationTimes = this.createEvaluationTimes(prepared)
		const lastSample = prepared.normalizedTimes.length - 1

		this.startTime = prepared.startTime
		this.endTime = prepared.endTime
		this.sampleCount = prepared.times.length
		this.time0Day = prepared.startDay
		this.time0Fraction = prepared.startFraction
		this.duration = prepared.normalizedTimes[lastSample]

		this.createScalarInterpolators(evaluationTimes, prepared.rightAscension, prepared.declination)
		this.diagnostics = this.computeRmsError ? computeDiagnostics(evaluationTimes, prepared.rightAscension, prepared.declination, this.raInterpolator, this.decInterpolator) : undefined

		this.raInterpolator.reset()
		this.decInterpolator.reset()
	}

	protected abstract minimumSampleCount: number
	protected abstract createScalarInterpolators(times: Float64Array, rightAscension: Float64Array, declination: Float64Array): void

	protected createEvaluationTimes(prepared: PreparedEphemerisSamples) {
		return prepared.normalizedTimes
	}

	protected evaluationTime(time: Time) {
		return this.resolveOutOfRangeOffset(relativeTime(time, this.time0Day, this.time0Fraction))
	}

	protected resolveOutOfRangeOffset(offset: number) {
		if (offset < 0) {
			if (this.outOfRange === 'clamp') return 0
			if (this.outOfRange === 'throw') throw new RangeError('interpolation time is outside the sample range')
		} else if (offset > this.duration) {
			if (this.outOfRange === 'clamp') return this.duration
			if (this.outOfRange === 'throw') throw new RangeError('interpolation time is outside the sample range')
		}

		return offset
	}
}

// Piecewise linear interpolation with cached segment lookup for monotonic query streams.
export class LinearEphemerisInterpolator extends BaseEphemerisInterpolator {
	readonly strategy = 'linear'
	protected readonly minimumSampleCount = 2

	constructor(points: readonly EphemerisPoint[], options?: EphemerisInterpolationOptions) {
		super(options)
		this.update(points)
	}

	protected createScalarInterpolators(times: Float64Array, rightAscension: Float64Array, declination: Float64Array) {
		this.raInterpolator = linearSpline(times, rightAscension, true)
		this.decInterpolator = linearSpline(times, declination, true)
	}
}

// Spline interpolation with selectable cubic segment slope algorithms.
export class SplineEphemerisInterpolator extends BaseEphemerisInterpolator {
	readonly strategy = 'spline'
	protected readonly minimumSampleCount = 3
	readonly #type: SplineEphemerisInterpolationType

	constructor(points: readonly EphemerisPoint[], type: SplineEphemerisInterpolationType = 'naturalCubic', options?: EphemerisInterpolationOptions) {
		super(options)
		this.#type = type
		this.update(points)
	}

	protected createScalarInterpolators(times: Float64Array, rightAscension: Float64Array, declination: Float64Array) {
		this.raInterpolator = splineScalarInterpolator(this.#type, times, rightAscension)
		this.decInterpolator = splineScalarInterpolator(this.#type, times, declination)
	}
}

// Chebyshev polynomial fit over the full sample domain; extrapolation outside it is numerically unsafe.
export class ChebyshevEphemerisInterpolator extends BaseEphemerisInterpolator {
	readonly strategy = 'chebyshev'
	readonly degree: number
	protected readonly minimumSampleCount: number

	constructor(points: readonly EphemerisPoint[], degree?: number, options?: EphemerisInterpolationOptions) {
		super(options)
		this.degree = degree ?? Math.min(12, Math.max(0, points.length - 1))

		if (!Number.isInteger(this.degree) || this.degree < 1) {
			throw new RangeError('chebyshev degree must be a positive integer')
		}

		this.minimumSampleCount = this.degree + 1

		this.update(points)
	}

	protected createEvaluationTimes(prepared: PreparedEphemerisSamples): Float64Array {
		const times = prepared.normalizedTimes
		const mapped = new Float64Array(times.length)
		const last = times.length - 1
		const scale = 2 / times[last]

		// Chebyshev fits use x in [-1, +1] to keep powers well conditioned.
		for (let i = 0; i < times.length; i++) mapped[i] = times[i] * scale - 1

		return mapped
	}

	protected createScalarInterpolators(times: Float64Array, rightAscension: Float64Array, declination: Float64Array) {
		this.raInterpolator = new ChebyshevPolynomialFit(times, rightAscension, this.degree)
		this.decInterpolator = new ChebyshevPolynomialFit(times, declination, this.degree)
	}

	protected evaluationTime(time: Time) {
		return (this.resolveOutOfRangeOffset(relativeTime(time, this.time0Day, this.time0Fraction)) * 2) / this.duration - 1
	}
}

class ChebyshevPolynomialFit implements ScalarInterpolator {
	private readonly chebyshev: ChebyshevRegression

	constructor(x: Float64Array, y: Float64Array, degree: number) {
		this.chebyshev = chebyshevLeastSquares(x, y, degree)
	}

	compute(x: number) {
		return this.chebyshev.predict(x)
	}

	reset() {}
}

function splineScalarInterpolator(splineInterpolation: SplineEphemerisInterpolationType, times: Float64Array, values: Float64Array): ScalarInterpolator {
	switch (splineInterpolation) {
		case 'naturalCubic':
			return naturalCubicSpline(times, values, true)
		case 'cubicHermite':
			return cubicHermiteSpline(times, values, true)
		case 'pchip':
			return pchip(times, values, true)
		case 'akima':
			return akimaSpline(times, values, true)
		case 'catmullRom':
			return catmullRomSpline(times, values, true)
		default:
			throw new RangeError('spline interpolation must be naturalCubic, cubicHermite, pchip, akima, or catmullRom')
	}
}

function prepareSamples(points: readonly EphemerisPoint[], minimumSampleCount: number, allowDuplicateTimes: boolean): PreparedEphemerisSamples {
	if (points.length < minimumSampleCount) {
		throw new RangeError(`ephemeris interpolation requires at least ${minimumSampleCount} samples`)
	}

	const sorted = new Array<SortableEphemerisPoint>(points.length)

	for (let i = 0; i < points.length; i++) {
		const point = points[i]
		const instant = numericTime(point.time)

		if (!Number.isFinite(point.rightAscension)) throw new RangeError('ephemeris RA must be finite')
		if (!Number.isFinite(point.declination)) throw new RangeError('ephemeris Dec must be finite')

		sorted[i] = {
			time: instant.time,
			day: instant.day,
			fraction: instant.fraction,
			rightAscension: point.rightAscension,
			declination: point.declination,
			order: i,
		}
	}

	sorted.sort(EphemerisSamplesComparator)

	const times = new Float64Array(points.length)
	const days = new Float64Array(points.length)
	const fractions = new Float64Array(points.length)
	const rightAscension = new Float64Array(points.length)
	const declination = new Float64Array(points.length)
	let count = 0

	for (let i = 0; i < sorted.length; i++) {
		const point = sorted[i]

		if (count > 0 && point.time === times[count - 1]) {
			if (!allowDuplicateTimes) throw new RangeError('duplicate ephemeris sample time')

			times[count - 1] = point.time
			days[count - 1] = point.day
			fractions[count - 1] = point.fraction
			rightAscension[count - 1] = point.rightAscension
			declination[count - 1] = point.declination
		} else {
			times[count] = point.time
			days[count] = point.day
			fractions[count] = point.fraction
			rightAscension[count] = point.rightAscension
			declination[count] = point.declination
			count++
		}
	}

	if (count < minimumSampleCount) {
		throw new RangeError(`ephemeris interpolation requires at least ${minimumSampleCount} unique samples`)
	}

	const compactTimes = times.slice(0, count)
	const compactRa = rightAscension.slice(0, count)
	const compactDec = declination.slice(0, count)
	const startTime = compactTimes[0]
	const endTime = compactTimes[count - 1]
	const startDay = days[0]
	const startFraction = fractions[0]

	if (!(endTime > startTime)) {
		throw new RangeError('ephemeris sample times must span a non-zero interval')
	}

	unwrapRA(compactRa)

	const normalizedTimes = new Float64Array(count)

	// Times are shifted by the first sample to avoid carrying large JD offsets through interpolation math.
	for (let i = 0; i < count; i++) normalizedTimes[i] = days[i] - startDay + (fractions[i] - startFraction)

	return {
		times: compactTimes,
		normalizedTimes,
		rightAscension: compactRa,
		declination: compactDec,
		startTime,
		endTime,
		startDay,
		startFraction,
	}
}

function EphemerisSamplesComparator(a: SortableEphemerisPoint, b: SortableEphemerisPoint) {
	const delta = a.time - b.time
	return delta || a.order - b.order
}

function unwrapRA(rightAscension: Float64Array) {
	let offset = 0
	let previous = rightAscension[0]

	// RA is unwrapped before fitting so interpolation never crosses the artificial 0/TAU discontinuity.
	for (let i = 1; i < rightAscension.length; i++) {
		let current = rightAscension[i] + offset
		const delta = current - previous

		if (delta > PI) {
			current -= TAU
			offset -= TAU
		} else if (delta < -PI) {
			current += TAU
			offset += TAU
		}

		rightAscension[i] = current
		previous = current
	}
}

function numericTime(time: Time) {
	if (!Number.isFinite(time.day) || !Number.isFinite(time.fraction)) {
		throw new RangeError('ephemeris time must be finite')
	}

	const instant = timeConvert(time, Timescale.TT)
	const value = instant.day + instant.fraction

	if (!Number.isFinite(value)) throw new RangeError('ephemeris time must be finite')

	return { time: value, day: instant.day, fraction: instant.fraction }
}

function relativeTime(time: Time, startDay: number, startFraction: number) {
	if (!Number.isFinite(time.day) || !Number.isFinite(time.fraction)) {
		throw new RangeError('ephemeris time must be finite')
	}

	const instant = timeConvert(time, Timescale.TT)
	return instant.day - startDay + (instant.fraction - startFraction)
}

function computeDiagnostics(times: Float64Array, rightAscension: Float64Array, declination: Float64Array, raInterpolator: ScalarInterpolator, decInterpolator: ScalarInterpolator): EphemerisInterpolationDiagnostics {
	let sumRA = 0
	let sumDEC = 0
	let maxAbsRA = 0
	let maxAbsDEC = 0

	for (let i = 0; i < times.length; i++) {
		const raError = raInterpolator.compute(times[i]) - rightAscension[i]
		const decError = decInterpolator.compute(times[i]) - declination[i]
		const absRa = Math.abs(raError)
		const absDec = Math.abs(decError)

		sumRA += raError * raError
		sumDEC += decError * decError
		if (absRa > maxAbsRA) maxAbsRA = absRa
		if (absDec > maxAbsDEC) maxAbsDEC = absDec
	}

	return {
		rmsRA: Math.sqrt(sumRA / times.length),
		rmsDEC: Math.sqrt(sumDEC / times.length),
		maxAbsRA,
		maxAbsDEC,
	}
}
