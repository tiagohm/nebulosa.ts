import { expect, test, describe } from 'bun:test'
import { angularDistance } from '../src/coordinate'
import { DAYSEC, TAU } from '../src/constants'
import { type EphemerisPoint, chebyshevInterpolator, linearInterpolator, splineInterpolator } from '../src/interpolator'
import { Timescale, time, timeConvert, timeYMDHMS } from '../src/time'
import { earth, mars } from '../src/vsop87e'

const J0 = 2460000
const PLANET_START_TIME = timeYMDHMS(2025, 9, 28, 0, 0, 0, Timescale.TT)

function jd(offset: number) {
	return time(J0, offset, Timescale.TT)
}

function point(offset: number, rightAscension: number, declination: number): EphemerisPoint {
	return { time: jd(offset), rightAscension, declination }
}

function planetTime(offset: number) {
	return time(PLANET_START_TIME.day, PLANET_START_TIME.fraction + offset, PLANET_START_TIME.scale)
}

function marsGeocentricPoint(offset: number): EphemerisPoint {
	const time = planetTime(offset)
	const [marsPosition] = mars(time)
	const [earthPosition] = earth(time)
	const x = marsPosition[0] - earthPosition[0]
	const y = marsPosition[1] - earthPosition[1]
	const z = marsPosition[2] - earthPosition[2]
	let rightAscension = Math.atan2(y, x)

	if (rightAscension < 0) rightAscension += TAU

	return { time, rightAscension, declination: Math.atan2(z, Math.hypot(x, y)) }
}

function chebyshevModel(offset: number) {
	const x = 2 * offset - 1
	const t2 = 2 * x * x - 1
	const t3 = 4 * x * x * x - 3 * x
	return [1 + 0.2 * x + 0.05 * t2, -0.2 + 0.1 * x - 0.03 * t3]
}

test('sorts input points by time', () => {
	const interpolator = linearInterpolator([point(2, 2, 4), point(0, 0, 0), point(1, 1, 2)])

	const value = interpolator.compute(jd(0.5))

	expect(value[0]).toBeCloseTo(0.5, 15)
	expect(value[1]).toBeCloseTo(1, 15)
	expect(interpolator.startTime).toBeCloseTo(J0, 15)
	expect(interpolator.endTime).toBeCloseTo(J0 + 2, 15)
})

test('unwraps RA across the zero boundary', () => {
	const interpolator = linearInterpolator([point(0, TAU - 0.1, 0), point(1, 0.1, 1)])

	const value = interpolator.compute(jd(0.5))

	expect(value[0]).toBeCloseTo(0, 14)
	expect(value[1]).toBeCloseTo(0.5, 15)
})

test('normalizes returned RA to the standard range', () => {
	const interpolator = linearInterpolator([point(0, TAU + 0.2, 0), point(1, TAU + 0.4, 1)])

	const value = interpolator.compute(jd(1))

	expect(value[0]).toBeGreaterThanOrEqual(0)
	expect(value[0]).toBeLessThan(TAU)
	expect(value[0]).toBeCloseTo(0.4, 15)
})

test('linearly interpolates between two points', () => {
	const interpolator = linearInterpolator([point(0, 1, 0.2), point(1, 3, 0.6)])

	const value = interpolator.compute(jd(0.25))

	expect(value[0]).toBeCloseTo(1.5, 15)
	expect(value[1]).toBeCloseTo(0.3, 15)
})

test('linear lookup handles exact sample times', () => {
	const interpolator = linearInterpolator([point(0, 1, -0.1), point(1, 2, 0.1), point(2, 3, 0.3)])

	expect(interpolator.compute(jd(0))).toEqual([1, -0.1])
	expect(interpolator.compute(jd(1))).toEqual([2, 0.1])
	expect(interpolator.compute(jd(2))).toEqual([3, 0.3])
})

test('linear lookup compares mixed timescales as instants', () => {
	const start = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TT)
	const end = timeConvert(time(start.day, start.fraction + 10 / DAYSEC, Timescale.TT), Timescale.UTC)
	const middle = timeConvert(time(start.day, start.fraction + 5 / DAYSEC, Timescale.TT), Timescale.UTC)

	const interpolator = linearInterpolator([
		{ time: end, rightAscension: 2, declination: 1 },
		{ time: start, rightAscension: 1, declination: 0 },
	])
	const value = interpolator.compute(middle)

	expect(value[0]).toBeCloseTo(1.5, 12)
	expect(value[1]).toBeCloseTo(0.5, 12)
})

test('natural cubic spline keeps first derivative continuous at knots', () => {
	const interpolator = splineInterpolator([point(0, 0.9, 0.1), point(1, 1.1, 0.4), point(2, 1.8, 0.2), point(3, 2.2, 0.6), point(4, 2.5, 0.5)])
	const epsilon = 1e-6
	const knot = jd(2)
	const left = (interpolator.compute(knot)[0] - interpolator.compute(jd(2 - epsilon))[0]) / epsilon
	const right = (interpolator.compute(jd(2 + epsilon))[0] - interpolator.compute(knot)[0]) / epsilon

	expect(left).toBeCloseTo(right, 5)
})

test('natural cubic spline has natural endpoint curvature', () => {
	const interpolator = splineInterpolator([point(0, 1, 0), point(1, 1.4, 0.3), point(2, 1.2, 0.1), point(3, 1.8, 0.5)], { outOfRange: 'extrapolate' })
	const epsilon = 1e-4
	const fm = interpolator.compute(jd(-epsilon))[0]
	const f0 = interpolator.compute(jd(0))[0]
	const fp = interpolator.compute(jd(epsilon))[0]
	const second = (fm - 2 * f0 + fp) / (epsilon * epsilon)

	expect(Math.abs(second)).toBeLessThan(1e-3)
})

test('chebyshev approximates a smooth bounded arc', () => {
	const points = new Array<EphemerisPoint>(8)

	for (let i = 0; i < points.length; i++) {
		const offset = i / (points.length - 1)
		const value = chebyshevModel(offset)
		points[i] = point(offset, value[0], value[1])
	}

	const interpolator = chebyshevInterpolator(points, 3)
	const expected = chebyshevModel(0.37)
	const actual = interpolator.compute(jd(0.37))

	expect(actual[0]).toBeCloseTo(expected[0], 12)
	expect(actual[1]).toBeCloseTo(expected[1], 12)
})

test('clamps out-of-range queries by default', () => {
	const interpolator = linearInterpolator([point(0, 1, -1), point(1, 2, 1)])

	expect(interpolator.compute(jd(-1))).toEqual([1, -1])
	expect(interpolator.compute(jd(2))).toEqual([2, 1])
})

test('throws for out-of-range queries when requested', () => {
	const interpolator = linearInterpolator([point(0, 1, -1), point(1, 2, 1)], { outOfRange: 'throw' })

	expect(() => interpolator.compute(jd(-1))).toThrow(RangeError)
	expect(() => interpolator.compute(jd(2))).toThrow(RangeError)
})

test('extrapolates out-of-range queries when requested', () => {
	const interpolator = linearInterpolator([point(0, 1, -1), point(1, 2, 1)], { outOfRange: 'extrapolate' })

	expect(interpolator.compute(jd(2))).toEqual([3, 3])
})

test('computeInto returns the provided output object', () => {
	const interpolator = linearInterpolator([point(0, 1, 0), point(1, 2, 1)])
	const out: [number, number] = [0, 0]

	expect(interpolator.computeInto(jd(0.5), out)).toBe(out)
	expect(out[0]).toBeCloseTo(1.5, 15)
	expect(out[1]).toBeCloseTo(0.5, 15)
})

test('does not mutate input points', () => {
	const points = [point(1, 0.1, 1), point(0, TAU - 0.1, 0)]
	const original = points.map((item) => ({ ...item }))

	linearInterpolator(points)

	expect(points).toEqual(original)
})

test('rejects duplicate timestamps unless explicitly allowed', () => {
	expect(() => linearInterpolator([point(0, 1, 0), point(0, 2, 1)])).toThrow('duplicate ephemeris sample time')

	const interpolator = linearInterpolator([point(0, 1, 0), point(0, 2, 1), point(1, 4, 3)], { allowDuplicateTimes: true })

	expect(interpolator.sampleCount).toBe(2)
	expect(interpolator.compute(jd(0))).toEqual([2, 1])
})

test('handles fast RA motion through a wrap', () => {
	const interpolator = splineInterpolator([point(0, TAU - 0.4, 0), point(0.25, TAU - 0.1, 0.1), point(0.5, 0.2, 0.2), point(0.75, 0.7, 0.3), point(1, 1.1, 0.4)])
	const value = interpolator.compute(jd(0.5))

	expect(value[0]).toBeCloseTo(0.2, 14)
	expect(value[1]).toBeCloseTo(0.2, 14)
})

test('tracks slow planetary-like motion over a night', () => {
	const points = new Array<EphemerisPoint>(6)

	for (let i = 0; i < points.length; i++) {
		const offset = i / (points.length - 1)
		points[i] = point(offset, 2 + 0.001 * offset, -0.3 + 0.0005 * offset)
	}

	const interpolator = splineInterpolator(points)
	const value = interpolator.compute(jd(0.42))

	expect(value[0]).toBeCloseTo(2.00042, 12)
	expect(value[1]).toBeCloseTo(-0.29979, 12)
})

test('tracks faster nonlinear comet-like motion', () => {
	const points = new Array<EphemerisPoint>(7)

	for (let i = 0; i < points.length; i++) {
		const offset = i / (points.length - 1)
		points[i] = point(offset, 1 + 0.8 * offset + 0.4 * offset * offset, -0.2 + 0.3 * offset - 0.15 * offset * offset)
	}

	const interpolator = chebyshevInterpolator(points, 2)
	const offset = 0.43
	const value = interpolator.compute(jd(offset))

	expect(value[0]).toBeCloseTo(1 + 0.8 * offset + 0.4 * offset * offset, 12)
	expect(value[1]).toBeCloseTo(-0.2 + 0.3 * offset - 0.15 * offset * offset, 12)
})

describe('interpolates VSOP87E Mars geocentric coordinates with all strategies', () => {
	const sampleCount = 25
	const step = 1 / (sampleCount - 1)
	const points = new Array<EphemerisPoint>(sampleCount)

	for (let i = 0; i < sampleCount; i++) points[i] = marsGeocentricPoint(i * step)

	const strategies = [
		{ name: 'linear', interpolator: linearInterpolator(points), maxError: 1e-8 },
		{ name: 'spline', interpolator: splineInterpolator(points), maxError: 5e-9 },
		{ name: 'chebshev', interpolator: chebyshevInterpolator(points, 6), maxError: 1e-11 },
	] as const

	for (const { name, interpolator, maxError } of strategies) {
		test(name, () => {
			for (let i = 0; i < sampleCount - 1; i++) {
				const expected = marsGeocentricPoint((i + 0.5) * step)
				const actual = interpolator.compute(expected.time)
				const error = angularDistance(actual[0], actual[1], expected.rightAscension, expected.declination)

				expect(error).toBeLessThan(maxError)
			}
		})
	}
})

test('resamples while preserving requested Time objects', () => {
	const interpolator = linearInterpolator([point(0, 1, 0), point(1, 3, 2)])
	const times = [jd(0.25), jd(0.75)]

	const resampled = interpolator.resample(times)

	expect(resampled).toHaveLength(2)
	expect(resampled[0].time).toBe(times[0])
	expect(resampled[0].rightAscension).toBeCloseTo(1.5, 15)
	expect(resampled[1].declination).toBeCloseTo(1.5, 15)
})

test('computes optional RMS diagnostics on the unwrapped RA domain', () => {
	const interpolator = linearInterpolator([point(0, TAU - 0.1, 0), point(1, 0.1, 1)], { computeRmsError: true })

	expect(interpolator.diagnostics?.rmsRA).toBeCloseTo(0, 15)
	expect(interpolator.diagnostics?.rmsDEC).toBeCloseTo(0, 15)
	expect(interpolator.diagnostics?.maxAbsRA).toBeCloseTo(0, 15)
	expect(interpolator.diagnostics?.maxAbsDEC).toBeCloseTo(0, 15)
})

test('rejects invalid input', () => {
	expect(() => linearInterpolator([])).toThrow('ephemeris interpolation requires at least 2 samples')
	expect(() => splineInterpolator([point(0, 1, 0), point(1, 2, 1)])).toThrow('ephemeris interpolation requires at least 3 samples')
	expect(() => chebyshevInterpolator([point(0, 1, 0), point(1, 2, 1)], 2)).toThrow('ephemeris interpolation requires at least 3 samples')
	expect(() => chebyshevInterpolator([point(0, 1, 0), point(1, 2, 1)], 0)).toThrow('chebyshev degree must be a positive integer')
	expect(() => linearInterpolator([point(0, Number.NaN, 0), point(1, 2, 1)])).toThrow('ephemeris RA must be finite')
	expect(() => linearInterpolator([point(0, 1, Number.POSITIVE_INFINITY), point(1, 2, 1)])).toThrow('ephemeris Dec must be finite')
	expect(() => linearInterpolator([{ time: time(Number.POSITIVE_INFINITY), rightAscension: 1, declination: 0 }, point(1, 2, 1)])).toThrow('ephemeris time must be finite')
})
