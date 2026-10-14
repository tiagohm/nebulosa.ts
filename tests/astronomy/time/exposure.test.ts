import { expect, test } from 'bun:test'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { exposureInterval } from '../../../src/astronomy/time/exposure'
import { type Time, Timescale, timeSubtract, timeToDate, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC } from '../../../src/core/constants'

// Elapsed SI seconds from a to b, measured on TAI.
function elapsed(a: Time, b: Time) {
	return timeSubtract(b, a, Timescale.TAI) * DAYSEC
}

test('start, midpoint, and end references recover the same collection interval', () => {
	const open = timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.UTC)
	const fromStart = exposureInterval({ time: open, reference: 'start', duration: 60 })
	const fromMidpoint = exposureInterval({ time: timeYMDHMS(2024, 3, 10, 2, 0, 30, Timescale.UTC), reference: 'midpoint', duration: 60 })
	const fromEnd = exposureInterval({ time: timeYMDHMS(2024, 3, 10, 2, 1, 0, Timescale.UTC), reference: 'end', duration: 60 })

	for (const interval of [fromStart, fromMidpoint, fromEnd]) {
		expect(interval.duration).toBe(60)
		expect(interval.uncertainty).toBe(0)
		expect(interval.start.scale).toBe(Timescale.UTC)
		expect(elapsed(open, interval.start)).toBeCloseTo(0, 6)
		expect(elapsed(open, interval.midpoint)).toBeCloseTo(30, 6)
		expect(elapsed(open, interval.end)).toBeCloseTo(60, 6)
	}

	expect(timeToDate(fromEnd.midpoint)).toEqual([2024, 3, 10, 2, 0, 30, 0])
})

// A mechanical shutter that starts collecting 120 ms after the open command and stops 40 ms
// after the close command collects for 60 - 0.12 + 0.04 s, centered 80 ms after the nominal midpoint.
test('shutter latency moves the midpoint and changes the effective duration', () => {
	const open = timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.UTC)
	const interval = exposureInterval({ time: open, reference: 'start', duration: 60, openLatency: 0.12, closeLatency: 0.04, uncertainty: 0.005 })

	expect(interval.duration).toBeCloseTo(59.92, 12)
	expect(interval.uncertainty).toBe(0.005)
	expect(elapsed(open, interval.start)).toBeCloseTo(0.12, 6)
	expect(elapsed(open, interval.end)).toBeCloseTo(60.04, 6)
	expect(elapsed(open, interval.midpoint)).toBeCloseTo(30.08, 6)
})

// The 2016-12-31 leap second: a 2 s exposure opened at 23:59:59 UTC spans 23:59:60 and ends at
// 00:00:00, so its midpoint is the inserted second itself rather than 00:00:00 civil time.
test('an exposure spanning a leap second keeps its SI length', () => {
	const open = timeYMDHMS(2016, 12, 31, 23, 59, 59, Timescale.UTC)
	const interval = exposureInterval({ time: open, reference: 'start', duration: 2 })

	expect(timeToDate(interval.midpoint)).toEqual([2016, 12, 31, 23, 59, 60, 0])
	expect(timeToDate(interval.end)).toEqual([2017, 1, 1, 0, 0, 0, 0])
	expect(elapsed(interval.start, interval.end)).toBeCloseTo(2, 6)
})

test('non-UTC timestamps are shifted in their own scale and keep their location', () => {
	const location = geodeticLocation()
	const open = timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.TDB)
	open.location = location
	const interval = exposureInterval({ time: open, reference: 'end', duration: 10 })

	expect(interval.midpoint.scale).toBe(Timescale.TDB)
	expect(interval.midpoint.location).toBe(location)
	expect(timeSubtract(open, interval.midpoint) * DAYSEC).toBeCloseTo(5, 6)
})
