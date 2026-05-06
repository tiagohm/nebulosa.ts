import { normalizeAngle, type Angle } from './angle'
import { PI, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { chebyshevLeastSquares, type ChebyshevRegression } from './regression'
import { type Time, Timescale, timeConvert } from './time'

export type InterpolationStrategy = 'linear' | 'spline' | 'chebyshev'

export type InterpolationOutOfRange = 'clamp' | 'extrapolate' | 'throw'

export interface EphemerisPoint extends Readonly<EquatorialCoordinate> {
	readonly time: Time
}

export interface InterpolationOptions {
	outOfRange?: InterpolationOutOfRange
	computeRmsError?: boolean
	allowDuplicateTimes?: boolean
}

export interface InterpolationDiagnostics {
	rmsRA: number
	rmsDEC: number
	maxAbsRA: number
	maxAbsDEC: number
}

export interface EphemerisInterpolator {
	readonly strategy: InterpolationStrategy
	readonly startTime: number
	readonly endTime: number
	readonly sampleCount: number
	readonly diagnostics?: InterpolationDiagnostics

	readonly compute: (time: Time) => [Angle, Angle]
	readonly computeInto: (time: Time, out: [Angle, Angle]) => [Angle, Angle]
	readonly resample: (times: readonly Time[]) => EphemerisPoint[]
}

export interface UpdatableEphemerisInterpolator extends EphemerisInterpolator {
	// Rebuilds all precomputed interpolation state; the shape leaves room for true incremental updates later.
	readonly update: (points: readonly EphemerisPoint[]) => void
}

interface SortableEphemerisPoint {
	time: number
	day: number
	fraction: number
	rightAscension: number
	declination: number
	order: number
}

interface PreparedEphemerisSamples {
	times: Float64Array
	normalizedTimes: Float64Array
	rightAscension: Float64Array
	declination: Float64Array
	startTime: number
	endTime: number
	startDay: number
	startFraction: number
}

interface ScalarInterpolator {
	readonly compute: (x: number) => number
	readonly reset: () => void
}

const DEFAULT_OUT_OF_RANGE: InterpolationOutOfRange = 'clamp'

// Creates a linear ephemeris interpolator for apparent/topocentric RA and Dec samples.
export function linearInterpolator(points: readonly EphemerisPoint[], options?: InterpolationOptions): EphemerisInterpolator {
	return new LinearEphemerisInterpolator(points, options)
}

// Creates a natural cubic spline ephemeris interpolator for apparent/topocentric RA and Dec samples.
export function splineInterpolator(points: readonly EphemerisPoint[], options?: InterpolationOptions): EphemerisInterpolator {
	return new SplineEphemerisInterpolator(points, options)
}

// Creates a Chebyshev ephemeris interpolator over the bounded sample interval.
export function chebyshevInterpolator(points: readonly EphemerisPoint[], degree?: number, options?: InterpolationOptions): EphemerisInterpolator {
	return new ChebyshevEphemerisInterpolator(points, degree, options)
}

abstract class BaseEphemerisInterpolator implements UpdatableEphemerisInterpolator {
	abstract readonly strategy: InterpolationStrategy

	startTime = 0
	endTime = 0
	sampleCount = 0
	diagnostics?: InterpolationDiagnostics

	protected readonly outOfRange: InterpolationOutOfRange
	protected readonly computeRmsError: boolean
	protected readonly allowDuplicateTimes: boolean
	protected time0Day = 0
	protected time0Fraction = 0
	protected duration = 0
	protected evaluationTimes: Float64Array = new Float64Array(0)
	protected raSamples: Float64Array = new Float64Array(0)
	protected decSamples: Float64Array = new Float64Array(0)
	protected raInterpolator!: ScalarInterpolator
	protected decInterpolator!: ScalarInterpolator

	constructor(options?: InterpolationOptions) {
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
		this.evaluationTimes = evaluationTimes
		this.raSamples = prepared.rightAscension
		this.decSamples = prepared.declination

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

	constructor(points: readonly EphemerisPoint[], options?: InterpolationOptions) {
		super(options)
		this.update(points)
	}

	protected createScalarInterpolators(times: Float64Array, rightAscension: Float64Array, declination: Float64Array) {
		this.raInterpolator = new LinearScalarInterpolator(times, rightAscension)
		this.decInterpolator = new LinearScalarInterpolator(times, declination)
	}
}

// Natural cubic spline interpolation with precomputed per-segment coefficients.
export class SplineEphemerisInterpolator extends BaseEphemerisInterpolator {
	readonly strategy = 'spline'
	protected readonly minimumSampleCount = 3

	constructor(points: readonly EphemerisPoint[], options?: InterpolationOptions) {
		super(options)
		this.update(points)
	}

	protected createScalarInterpolators(times: Float64Array, rightAscension: Float64Array, declination: Float64Array) {
		this.raInterpolator = new NaturalCubicSpline(times, rightAscension)
		this.decInterpolator = new NaturalCubicSpline(times, declination)
	}
}

// Chebyshev polynomial fit over the full sample domain; extrapolation outside it is numerically unsafe.
export class ChebyshevEphemerisInterpolator extends BaseEphemerisInterpolator {
	readonly strategy = 'chebyshev'
	readonly degree: number
	protected readonly minimumSampleCount: number

	constructor(points: readonly EphemerisPoint[], degree?: number, options?: InterpolationOptions) {
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

class LinearScalarInterpolator implements ScalarInterpolator {
	private lastIndex = 0

	constructor(
		private readonly times: Float64Array,
		private readonly values: Float64Array,
	) {}

	compute(t: number) {
		const i = this.segmentIndex(t)
		const t0 = this.times[i]
		const width = this.times[i + 1] - t0
		const u = (t - t0) / width

		return this.values[i] + u * (this.values[i + 1] - this.values[i])
	}

	reset() {
		this.lastIndex = 0
	}

	private segmentIndex(t: number) {
		const times = this.times
		const lastSegment = times.length - 2
		let i = this.lastIndex

		if (t >= times[i] && t <= times[i + 1]) return i

		if (i < lastSegment && t >= times[i + 1] && t <= times[i + 2]) {
			this.lastIndex = i + 1
			return this.lastIndex
		}

		if (i > 0 && t >= times[i - 1] && t <= times[i]) {
			this.lastIndex = i - 1
			return this.lastIndex
		}

		if (t <= times[0]) {
			this.lastIndex = 0
			return 0
		}

		if (t >= times[lastSegment + 1]) {
			this.lastIndex = lastSegment
			return lastSegment
		}

		let low = 0
		let high = lastSegment

		while (low <= high) {
			i = (low + high) >> 1

			if (t < times[i]) high = i - 1
			else if (t > times[i + 1]) low = i + 1
			else {
				this.lastIndex = i
				return i
			}
		}

		this.lastIndex = lastSegment
		return lastSegment
	}
}

class NaturalCubicSpline implements ScalarInterpolator {
	private lastIndex = 0
	private readonly a: Float64Array
	private readonly b: Float64Array
	private readonly c: Float64Array
	private readonly d: Float64Array

	constructor(
		private readonly times: Float64Array,
		values: Float64Array,
	) {
		const n = times.length
		const segmentCount = n - 1
		const h = new Float64Array(segmentCount)
		const delta = new Float64Array(segmentCount)
		const second = new Float64Array(n)

		for (let i = 0; i < segmentCount; i++) {
			const width = times[i + 1] - times[i]
			h[i] = width
			delta[i] = (values[i + 1] - values[i]) / width
		}

		const internal = n - 2
		const lower = new Float64Array(internal)
		const diagonal = new Float64Array(internal)
		const upper = new Float64Array(internal)
		const rhs = new Float64Array(internal)

		for (let i = 0; i < internal; i++) {
			lower[i] = i === 0 ? 0 : h[i]
			diagonal[i] = 2 * (h[i] + h[i + 1])
			upper[i] = i === internal - 1 ? 0 : h[i + 1]
			rhs[i] = 6 * (delta[i + 1] - delta[i])
		}

		for (let i = 1; i < internal; i++) {
			const factor = lower[i] / diagonal[i - 1]
			diagonal[i] -= factor * upper[i - 1]
			rhs[i] -= factor * rhs[i - 1]
		}

		second[n - 2] = rhs[internal - 1] / diagonal[internal - 1]

		for (let i = internal - 2; i >= 0; i--) {
			second[i + 1] = (rhs[i] - upper[i] * second[i + 2]) / diagonal[i]
		}

		this.a = new Float64Array(segmentCount)
		this.b = new Float64Array(segmentCount)
		this.c = new Float64Array(segmentCount)
		this.d = new Float64Array(segmentCount)

		// Coefficients are stored as a + b * dx + c * dx^2 + d * dx^3 per segment.
		for (let i = 0; i < segmentCount; i++) {
			this.a[i] = values[i]
			this.b[i] = delta[i] - (h[i] * (2 * second[i] + second[i + 1])) / 6
			this.c[i] = second[i] / 2
			this.d[i] = (second[i + 1] - second[i]) / (6 * h[i])
		}
	}

	compute(t: number) {
		const i = this.segmentIndex(t)
		const dx = t - this.times[i]

		return this.a[i] + dx * (this.b[i] + dx * (this.c[i] + dx * this.d[i]))
	}

	reset() {
		this.lastIndex = 0
	}

	private segmentIndex(t: number) {
		const times = this.times
		const lastSegment = times.length - 2
		let i = this.lastIndex

		if (t >= times[i] && t <= times[i + 1]) return i

		if (i < lastSegment && t >= times[i + 1] && t <= times[i + 2]) {
			this.lastIndex = i + 1
			return this.lastIndex
		}

		if (i > 0 && t >= times[i - 1] && t <= times[i]) {
			this.lastIndex = i - 1
			return this.lastIndex
		}

		if (t <= times[0]) {
			this.lastIndex = 0
			return 0
		}

		if (t >= times[lastSegment + 1]) {
			this.lastIndex = lastSegment
			return lastSegment
		}

		let low = 0
		let high = lastSegment

		while (low <= high) {
			i = (low + high) >> 1

			if (t < times[i]) high = i - 1
			else if (t > times[i + 1]) low = i + 1
			else {
				this.lastIndex = i
				return i
			}
		}

		this.lastIndex = lastSegment
		return lastSegment
	}
}

class ChebyshevPolynomialFit implements ScalarInterpolator {
	private readonly cheebyshev: ChebyshevRegression

	constructor(x: Float64Array, y: Float64Array, degree: number) {
		this.cheebyshev = chebyshevLeastSquares(x, y, degree)
	}

	compute(x: number) {
		return this.cheebyshev.predict(x)
	}

	reset() {}
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

function computeDiagnostics(times: Float64Array, rightAscension: Float64Array, declination: Float64Array, raInterpolator: ScalarInterpolator, decInterpolator: ScalarInterpolator): InterpolationDiagnostics {
	let sumRa = 0
	let sumDec = 0
	let maxAbsRA = 0
	let maxAbsDEC = 0

	for (let i = 0; i < times.length; i++) {
		const raError = raInterpolator.compute(times[i]) - rightAscension[i]
		const decError = decInterpolator.compute(times[i]) - declination[i]
		const absRa = Math.abs(raError)
		const absDec = Math.abs(decError)

		sumRa += raError * raError
		sumDec += decError * decError
		if (absRa > maxAbsRA) maxAbsRA = absRa
		if (absDec > maxAbsDEC) maxAbsDEC = absDec
	}

	return {
		rmsRA: Math.sqrt(sumRa / times.length),
		rmsDEC: Math.sqrt(sumDec / times.length),
		maxAbsRA,
		maxAbsDEC,
	}
}
