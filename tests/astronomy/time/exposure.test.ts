import { expect, test } from 'bun:test'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { exposureInterval } from '../../../src/astronomy/time/exposure'
import { type Time, Timescale, tai, tcb, tcg, timeConvert, timeSubtract, timeToDate, timeYMDHMS, ut1, utc } from '../../../src/astronomy/time/time'
import { DAYSEC, ELG } from '../../../src/core/constants'

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

// TCG and TCB seconds are shorter than TAI seconds by L_G ≈ 7.0e-10 and L_B ≈ 1.55e-8 (≈ 2.5 µs and
// ≈ 56 µs per hour), and TDB and UT1 drift against TAI, so the same physical instant must give the same
// physical interval whatever scale labels it, also across the 2016-12-31 leap second in UTC.
test('every timescale gives the same physical interval for the same instant', () => {
	const location = geodeticLocation()
	const scales = [Timescale.UTC, Timescale.TAI, Timescale.TT, Timescale.TCG, Timescale.TDB, Timescale.TCB, Timescale.UT1] as const

	for (const open of [timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.TAI), tai(timeYMDHMS(2016, 12, 31, 23, 30, 0, Timescale.UTC))] as const) {
		open.location = location

		for (const duration of [3600, 21600] as const) {
			const exposure = { reference: 'end', duration, openLatency: 0.1, closeLatency: 0.05 } as const
			const reference = exposureInterval({ time: open, ...exposure })

			for (const scale of scales) {
				const interval = exposureInterval({ time: timeConvert(open, scale), ...exposure })

				expect(interval.start.scale).toBe(scale)
				expect(interval.midpoint.scale).toBe(scale)
				expect(interval.end.scale).toBe(scale)
				expect(interval.midpoint.location).toBe(location)
				expect(interval.duration).toBeCloseTo(duration - 0.05, 9)
				expect(elapsed(interval.start, interval.end)).toBeCloseTo(duration - 0.05, 9)
				expect(elapsed(reference.start, interval.start)).toBeCloseTo(0, 9)
				expect(elapsed(reference.midpoint, interval.midpoint)).toBeCloseTo(0, 9)
				expect(elapsed(reference.end, interval.end)).toBeCloseTo(0, 9)
				expect(elapsed(interval.end, open)).toBeCloseTo(-0.05, 9)
			}
		}
	}

	// In their own seconds the TCG and TCB hours are longer: L_G / (1 - L_G) · 3600 s and ≈ L_B · 3600 s,
	// the TCB one blurred by up to ~1.2 µs of periodic TDB-TT drift.
	const start = timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.TAI)
	const fromTcg = exposureInterval({ time: tcg(start), reference: 'start', duration: 3600 })
	const fromTcb = exposureInterval({ time: tcb(start), reference: 'start', duration: 3600 })
	expect((timeSubtract(fromTcg.end, fromTcg.start) * DAYSEC - 3600) * 1e6).toBeCloseTo((ELG / (1 - ELG)) * 3600 * 1e6, 3)
	expect(Math.abs((timeSubtract(fromTcb.end, fromTcb.start) * DAYSEC - 3600) * 1e6 - 55.82)).toBeLessThan(1.5)
})

// A custom UT1-UTC drifting 1 ms/day stretches one TAI hour by 1/24 ms of UT1, so the provider must be
// carried into the TAI round trip and onto the returned instants.
test('UT1 timestamps use their custom Earth-orientation provider', () => {
	const providers = { dut1: (time: Time) => 0.1 + 0.001 * (time.day - 2460380 + time.fraction) }
	const open = timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.UTC)
	open.providers = providers
	const interval = exposureInterval({ time: ut1(open), reference: 'start', duration: 3600 })

	expect(interval.end.scale).toBe(Timescale.UT1)
	expect(interval.end.providers?.dut1).toBe(providers.dut1)
	expect(elapsed(interval.start, interval.end)).toBeCloseTo(3600, 9)
	expect(timeSubtract(interval.end, interval.start) * DAYSEC).toBeCloseTo(3600 + 0.001 / 24, 9)
})

// DATE-BEG 23:59:59.5 and DATE-END 00:00:00.5 across the 2016-12-31 leap second read 1 s apart on
// the clock labels but are 2 SI seconds apart, and the midpoint is the inserted 23:59:60.5.
test('an open/close span is measured on TAI across a leap second', () => {
	const start = timeYMDHMS(2016, 12, 31, 23, 59, 59.5, Timescale.UTC)
	const end = timeYMDHMS(2017, 1, 1, 0, 0, 0.5, Timescale.UTC)
	const interval = exposureInterval({ start, end })

	expect(interval.duration).toBeCloseTo(2, 9)
	expect(timeToDate(interval.midpoint)).toEqual([2016, 12, 31, 23, 59, 60, 500])
	expect(timeToDate(interval.start)).toEqual([2016, 12, 31, 23, 59, 59, 500])
	expect(timeToDate(interval.end)).toEqual([2017, 1, 1, 0, 0, 0, 500])
	expect(interval.midpoint.scale).toBe(Timescale.UTC)
})

// An electronic shutter with 30 ms open lag and 11 ms close lag on a 1 s span collects for 0.981 s,
// centered 20.5 ms after the commanded midpoint.
test('a span applies asymmetric opening and closing latencies', () => {
	const start = timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.UTC)
	const end = timeYMDHMS(2024, 3, 10, 2, 0, 1, Timescale.UTC)
	const interval = exposureInterval({ start, end, openLatency: 0.03, closeLatency: 0.011, uncertainty: 0.001 })

	expect(interval.duration).toBeCloseTo(0.981, 9)
	expect(interval.uncertainty).toBe(0.001)
	expect(elapsed(start, interval.start)).toBeCloseTo(0.03, 9)
	expect(elapsed(start, interval.end)).toBeCloseTo(1.011, 9)
	expect(elapsed(start, interval.midpoint)).toBeCloseTo(0.5205, 9)
})

// A 200 µs exposure: the day fraction resolves ~1e-11 s, so the microsecond offsets survive.
test('submillisecond exposures keep microsecond offsets in both input forms', () => {
	const start = timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.TAI)
	const fromDuration = exposureInterval({ time: start, reference: 'start', duration: 0.0002, openLatency: 0.00001 })
	const fromSpan = exposureInterval({ start, end: fromDuration.end, openLatency: 0.00001 })

	expect(fromDuration.duration).toBeCloseTo(0.00019, 12)
	expect(elapsed(start, fromDuration.midpoint)).toBeCloseTo(0.000105, 10)
	expect(elapsed(start, fromDuration.end)).toBeCloseTo(0.0002, 10)
	// The span's commanded duration is the measured 0.2 ms, so its collection ends 10 µs later.
	expect(fromSpan.duration).toBeCloseTo(0.0002 - 0.00001, 10)
	expect(elapsed(start, fromSpan.end)).toBeCloseTo(0.0002, 10)
})

test('a span derives its duration and cannot also carry a contradictory one', () => {
	const start = timeYMDHMS(2024, 3, 10, 2, 0, 0, Timescale.UTC)
	const end = timeYMDHMS(2024, 3, 10, 2, 1, 0, Timescale.UTC)
	// @ts-expect-error a span measures its own duration; EXPTIME next to DATE-BEG/DATE-END is rejected
	const interval = exposureInterval({ start, end, duration: 30 })

	expect(interval.duration).toBeCloseTo(60, 9)
	expect(elapsed(start, interval.midpoint)).toBeCloseTo(30, 9)
})

// The same exposure stamped in UTC and in TAI, or with mixed-scale ends, has one midpoint instant.
test('UTC and TAI inputs give the same midpoint instant and round-trip', () => {
	const startUtc = timeYMDHMS(2016, 12, 31, 23, 59, 30, Timescale.UTC)
	const startTai = tai(startUtc)
	const fromUtc = exposureInterval({ time: startUtc, reference: 'start', duration: 60, openLatency: 0.2 })
	const fromTai = exposureInterval({ time: startTai, reference: 'start', duration: 60, openLatency: 0.2 })
	const mixed = exposureInterval({ start: startUtc, end: tai(fromUtc.end), openLatency: 0.2 })

	expect(fromTai.midpoint.scale).toBe(Timescale.TAI)
	expect(timeSubtract(fromUtc.midpoint, fromTai.midpoint, Timescale.TAI) * DAYSEC).toBeCloseTo(0, 9)
	expect(timeToDate(utc(fromTai.midpoint))).toEqual(timeToDate(fromUtc.midpoint))
	expect(timeToDate(fromUtc.midpoint)).toEqual([2016, 12, 31, 23, 59, 60, 100])
	// The close command lands at fromUtc.end (no close latency), so the mixed span is the same exposure.
	expect(mixed.duration).toBeCloseTo(59.8, 9)
	expect(mixed.midpoint.scale).toBe(Timescale.UTC)
	expect(timeSubtract(mixed.midpoint, fromUtc.midpoint, Timescale.TAI) * DAYSEC).toBeCloseTo(0, 9)
})
