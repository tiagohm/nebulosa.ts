import { normalizeAngle, type Angle } from './angle'
import { PI, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { chebyshevLeastSquares, type ChebyshevRegression } from './regression'
import { akimaSpline, catmullRomSpline, cubicHermiteSpline, linearSpline, naturalCubicSpline, pchip } from './spline'
import { type Time, Timescale, timeConvert } from './time'

export type InterpolationStrategy = 'linear' | 'spline' | 'chebyshev'

export type InterpolationOutOfRange = 'clamp' | 'extrapolate' | 'throw'

export type SplineInterpolationType = 'naturalCubic' | 'cubicHermite' | 'pchip' | 'akima' | 'catmullRom'

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
const DEFAULT_SPLINE_INTERPOLATION: SplineInterpolationType = 'naturalCubic'

// Creates a linear ephemeris interpolator for apparent/topocentric RA and Dec samples.
export function linearInterpolator(points: readonly EphemerisPoint[], options?: InterpolationOptions): EphemerisInterpolator {
	return new LinearEphemerisInterpolator(points, options)
}

// Creates a spline ephemeris interpolator for apparent/topocentric RA and Dec samples.
export function splineInterpolator(points: readonly EphemerisPoint[], type?: SplineInterpolationType, options?: InterpolationOptions): EphemerisInterpolator {
	return new SplineEphemerisInterpolator(points, type, options)
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
		this.raInterpolator = linearSpline(times, rightAscension, true)
		this.decInterpolator = linearSpline(times, declination, true)
	}
}

// Spline interpolation with selectable cubic segment slope algorithms.
export class SplineEphemerisInterpolator extends BaseEphemerisInterpolator {
	readonly strategy = 'spline'
	protected readonly minimumSampleCount = 3
	readonly #type: SplineInterpolationType

	constructor(points: readonly EphemerisPoint[], type: SplineInterpolationType = 'naturalCubic', options?: InterpolationOptions) {
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

function splineScalarInterpolator(splineInterpolation: SplineInterpolationType, times: Float64Array, values: Float64Array): ScalarInterpolator {
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

function computeDiagnostics(times: Float64Array, rightAscension: Float64Array, declination: Float64Array, raInterpolator: ScalarInterpolator, decInterpolator: ScalarInterpolator): InterpolationDiagnostics {
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
