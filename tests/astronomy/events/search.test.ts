import { expect, test } from 'bun:test'
import { searchExtrema, searchRoots } from '../../../src/astronomy/events/search'
import { Timescale, type Time, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { TAU } from '../../../src/core/constants'

// Reference epoch; the analytic objectives below are expressed in days elapsed from it.
const EPOCH = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.UTC)

// sin(TAU * days-from-epoch): unit-amplitude sinusoid with one cycle per day.
function sine(time: Time) {
	return Math.sin(TAU * timeSubtract(time, EPOCH))
}

test('searchRoots brackets and refines every sign change in the window', () => {
	// Over (0.1, 2.1) days the zeros of sin(TAU·d) fall at 0.5, 1.0, 1.5 and 2.0.
	const start = timeYMDHMS(2026, 1, 1, 2, 24, 0, Timescale.UTC) // EPOCH + 0.1 day
	const stop = timeYMDHMS(2026, 1, 3, 2, 24, 0, Timescale.UTC) // EPOCH + 2.1 day
	const roots = searchRoots(sine, start, stop)

	expect(roots).toHaveLength(4)
	const offsets = roots.map((t) => timeSubtract(t, EPOCH))
	expect(offsets[0]).toBeCloseTo(0.5, 6)
	expect(offsets[1]).toBeCloseTo(1, 6)
	expect(offsets[2]).toBeCloseTo(1.5, 6)
	expect(offsets[3]).toBeCloseTo(2, 6)
})

test('searchRoots returns nothing for an empty or inverted window', () => {
	expect(searchRoots(sine, EPOCH, EPOCH)).toHaveLength(0)
	const earlier = timeYMDHMS(2025, 12, 31, 0, 0, 0, Timescale.UTC)
	expect(searchRoots(sine, EPOCH, earlier)).toHaveLength(0)
})

test('searchExtrema locates the maximum and minimum of the sinusoid', () => {
	const stop = timeYMDHMS(2026, 1, 2, 0, 0, 0, Timescale.UTC) // EPOCH + 1 day
	const extrema = searchExtrema(sine, EPOCH, stop)

	expect(extrema).toHaveLength(2)
	// Maximum at 0.25 day (value +1), minimum at 0.75 day (value -1).
	expect(extrema[0].kind).toBe('maximum')
	expect(timeSubtract(extrema[0].time, EPOCH)).toBeCloseTo(0.25, 8)
	expect(extrema[0].value).toBeCloseTo(1, 9)
	expect(extrema[1].kind).toBe('minimum')
	expect(timeSubtract(extrema[1].time, EPOCH)).toBeCloseTo(0.75, 8)
	expect(extrema[1].value).toBeCloseTo(-1, 9)
})
