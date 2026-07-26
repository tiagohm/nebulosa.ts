import { describe, expect, test } from 'bun:test'
import { boresightHistory, boresightHistorySpan, boresightPathLength, clearBoresightHistory, recordBoresightSample, sampleBoresightAt, sampleBoresightTrajectory } from '../../../../src/devices/indi/simulator/mount.trajectory'
import { deg, hour, normalizePI, toDeg } from '../../../../src/math/units/angle'

// Unit coverage for the rolling boresight history: ring wrap, interpolation, clamping outside the
// retained window, and the even sampling a camera integrates an exposure over.

describe('boresight history', () => {
	test('reports no span while empty', () => {
		expect(boresightHistorySpan(boresightHistory(4))).toBeUndefined()
		expect(sampleBoresightAt(boresightHistory(4), 1000, [0, 0])).toBeUndefined()
		expect(sampleBoresightTrajectory(boresightHistory(4), 0, 1000, 4, new Float64Array(8))).toBe(0)
	})

	test('keeps only the most recent samples once the ring wraps', () => {
		const history = boresightHistory(3)

		for (let i = 0; i < 5; i++) recordBoresightSample(history, i * 100, deg(i), deg(-i))

		expect(history.count).toBe(3)
		expect(boresightHistorySpan(history)).toEqual([200, 400])

		// The oldest two are gone, so a time before the window clamps to the third sample.
		const pair: [number, number] = [0, 0]
		sampleBoresightAt(history, 0, pair)
		expect(toDeg(pair[0])).toBeCloseTo(2, 9)
	})

	test('returns the recorded value exactly at a sample time', () => {
		const history = boresightHistory(8)
		recordBoresightSample(history, 1000, deg(10), deg(20))
		recordBoresightSample(history, 2000, deg(12), deg(24))

		const pair: [number, number] = [0, 0]
		sampleBoresightAt(history, 2000, pair)
		expect(toDeg(pair[0])).toBeCloseTo(12, 9)
		expect(toDeg(pair[1])).toBeCloseTo(24, 9)
	})

	test('interpolates linearly between samples', () => {
		const history = boresightHistory(8)
		recordBoresightSample(history, 1000, deg(10), deg(20))
		recordBoresightSample(history, 2000, deg(20), deg(40))

		const pair: [number, number] = [0, 0]
		sampleBoresightAt(history, 1250, pair)
		expect(toDeg(pair[0])).toBeCloseTo(12.5, 9)
		expect(toDeg(pair[1])).toBeCloseTo(25, 9)
	})

	test('interpolates right ascension along the shorter arc across zero', () => {
		const history = boresightHistory(8)
		recordBoresightSample(history, 1000, hour(23.9), 0)
		recordBoresightSample(history, 2000, hour(0.1), 0)

		const pair: [number, number] = [0, 0]
		sampleBoresightAt(history, 1500, pair)

		// Halfway is zero hours, not the twelve hours a naive average would give.
		expect(Math.abs(normalizePI(pair[0]))).toBeLessThan(hour(0.01))
	})

	test('clamps outside the retained window instead of extrapolating', () => {
		const history = boresightHistory(8)
		recordBoresightSample(history, 1000, deg(10), deg(20))
		recordBoresightSample(history, 2000, deg(20), deg(40))

		const before: [number, number] = [0, 0]
		sampleBoresightAt(history, 0, before)
		expect(toDeg(before[0])).toBeCloseTo(10, 9)

		const after: [number, number] = [0, 0]
		sampleBoresightAt(history, 99999, after)
		expect(toDeg(after[0])).toBeCloseTo(20, 9)
	})

	test('forgets everything when cleared', () => {
		const history = boresightHistory(4)
		recordBoresightSample(history, 1000, deg(10), deg(20))
		clearBoresightHistory(history)
		expect(history.count).toBe(0)
		expect(boresightHistorySpan(history)).toBeUndefined()
	})
})

describe('boresight trajectory sampling', () => {
	// A field drifting steadily from 10 to 20 degrees over one second.
	function drifting() {
		const history = boresightHistory(64)
		for (let i = 0; i <= 10; i++) recordBoresightSample(history, 1000 + i * 100, deg(10 + i), deg(0))
		return history
	}

	test('takes a single sample at the midpoint of the interval', () => {
		const out = new Float64Array(2)
		expect(sampleBoresightTrajectory(drifting(), 1000, 2000, 1, out)).toBe(1)
		expect(toDeg(out[0])).toBeCloseTo(15, 9)
	})

	test('spreads samples evenly from the start to the end inclusive', () => {
		const out = new Float64Array(10)
		expect(sampleBoresightTrajectory(drifting(), 1000, 2000, 5, out)).toBe(5)

		expect(toDeg(out[0])).toBeCloseTo(10, 9)
		expect(toDeg(out[2])).toBeCloseTo(12.5, 9)
		expect(toDeg(out[4])).toBeCloseTo(15, 9)
		expect(toDeg(out[6])).toBeCloseTo(17.5, 9)
		expect(toDeg(out[8])).toBeCloseTo(20, 9)
	})

	test('refuses to write past the end of the output', () => {
		expect(sampleBoresightTrajectory(drifting(), 1000, 2000, 5, new Float64Array(8))).toBe(0)
	})

	test('repeats the same position for a stationary field', () => {
		const history = boresightHistory(8)
		recordBoresightSample(history, 1000, deg(10), deg(20))
		recordBoresightSample(history, 2000, deg(10), deg(20))

		const out = new Float64Array(8)
		sampleBoresightTrajectory(history, 1000, 2000, 4, out)

		for (let i = 0; i < 4; i++) {
			expect(toDeg(out[i * 2])).toBeCloseTo(10, 9)
			expect(toDeg(out[i * 2 + 1])).toBeCloseTo(20, 9)
		}
	})
})

describe('boresight path length', () => {
	test('measures nothing without samples or over an empty interval', () => {
		expect(boresightPathLength(boresightHistory(4), 0, 1000)).toBe(0)

		const history = boresightHistory(4)
		recordBoresightSample(history, 1000, deg(10), deg(20))
		expect(boresightPathLength(history, 1000, 1000)).toBe(0)
	})

	test('scales the right ascension by the cosine of the declination', () => {
		const history = boresightHistory(4)
		recordBoresightSample(history, 0, deg(10), deg(60))
		recordBoresightSample(history, 1000, deg(11), deg(60))

		// One degree of right ascension at sixty degrees of declination is half a degree on the sky.
		expect(toDeg(boresightPathLength(history, 0, 1000))).toBeCloseTo(0.5, 6)
	})

	test('sums the path rather than the displacement of its endpoints', () => {
		const history = boresightHistory(8)
		recordBoresightSample(history, 0, deg(10), deg(0))
		recordBoresightSample(history, 1000, deg(11), deg(0))
		recordBoresightSample(history, 2000, deg(10), deg(0))

		// The field swung a degree away and came back, so the endpoints coincide and the path is two
		// degrees. This is the case a fixed probe grid can miss entirely.
		expect(toDeg(boresightPathLength(history, 0, 2000))).toBeCloseTo(2, 6)
	})

	test('measures only the part of the path inside the window', () => {
		const history = boresightHistory(8)
		recordBoresightSample(history, 0, deg(10), deg(0))
		recordBoresightSample(history, 1000, deg(12), deg(0))

		// Half of an evenly travelled interval, with both endpoints interpolated between samples.
		expect(toDeg(boresightPathLength(history, 250, 750))).toBeCloseTo(1, 6)
	})

	test('clamps to the retained window instead of extrapolating', () => {
		const history = boresightHistory(8)
		recordBoresightSample(history, 1000, deg(10), deg(0))
		recordBoresightSample(history, 2000, deg(11), deg(0))

		// Nothing is known before or after the window, so the extra time adds no path.
		expect(toDeg(boresightPathLength(history, 0, 3000))).toBeCloseTo(1, 6)
	})
})
