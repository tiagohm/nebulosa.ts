import { expect, test } from 'bun:test'
// oxfmt-ignore
import { integrateMeteorZhr, isMeteorShowerActive, meteorActivityFraction, meteorActivityIntervalsAboveFraction, meteorActivityMaximumSolarLongitude, meteorActivityPhase, meteorActivityProgress, meteorActivityZhr, meteorExponentialZhr, meteorShowerActivityYearApplies, meteorSolarLongitudeForwardDelta } from '../../../src/astronomy/meteors/activity'
import type { MeteorActivityProfile } from '../../../src/astronomy/meteors/types'
import { timeConvert, timeYMDHMS, Timescale } from '../../../src/astronomy/time/time'
import { deg, toDeg } from '../../../src/math/units/angle'
import { EXPONENTIAL_PROFILE, MULTI_PEAK_PROFILE, REFERENCE_UTC, SAMPLED_PROFILE, WRAPPED_EXPONENTIAL_PROFILE, WRAPPED_INTERVAL, ZERO_WIDTH_INTERVAL } from './util'

test('circular intervals handle the 0/2π seam and expose phase', () => {
	expect(meteorSolarLongitudeForwardDelta(deg(350), deg(10))).toBeCloseTo(deg(20), 14)
	expect(isMeteorShowerActive(WRAPPED_INTERVAL, deg(350))).toBe(true)
	expect(isMeteorShowerActive(WRAPPED_INTERVAL, 0)).toBe(true)
	expect(isMeteorShowerActive(WRAPPED_INTERVAL, deg(20))).toBe(true)
	expect(isMeteorShowerActive(WRAPPED_INTERVAL, deg(21))).toBe(false)
	expect(isMeteorShowerActive(undefined, deg(10))).toBeUndefined()
	expect(isMeteorShowerActive(ZERO_WIDTH_INTERVAL, deg(25))).toBe(false)
	expect(meteorActivityProgress(WRAPPED_INTERVAL, deg(350))).toBe(0)
	expect(meteorActivityProgress(WRAPPED_INTERVAL, deg(20))).toBe(1)
	expect(meteorActivityProgress(WRAPPED_INTERVAL, deg(21))).toBeUndefined()
	expect(meteorActivityProgress(undefined, deg(10))).toBeUndefined()
	expect(meteorActivityProgress(ZERO_WIDTH_INTERVAL, deg(25))).toBeUndefined()
	const before = meteorActivityPhase(WRAPPED_EXPONENTIAL_PROFILE, deg(349))
	expect(before.active).toBe(false)
	expect(before.progress).toBeUndefined()
	expect(before.deltaFromMaximum).toBeCloseTo(deg(-11), 14)
	const start = meteorActivityPhase(WRAPPED_EXPONENTIAL_PROFILE, deg(350))
	expect(start.active).toBe(true)
	expect(start.progress).toBe(0)
	expect(start.deltaFromMaximum).toBeCloseTo(deg(-10), 14)
	const maximum = meteorActivityPhase(WRAPPED_EXPONENTIAL_PROFILE, 0)
	expect(maximum.active).toBe(true)
	expect(maximum.progress).toBeCloseTo(1 / 3, 14)
	expect(maximum.deltaFromMaximum).toBe(0)
	const end = meteorActivityPhase(WRAPPED_EXPONENTIAL_PROFILE, deg(20))
	expect(end.active).toBe(true)
	expect(end.progress).toBe(1)
	expect(end.deltaFromMaximum).toBeCloseTo(deg(20), 14)
	expect(meteorActivityPhase(WRAPPED_EXPONENTIAL_PROFILE, deg(21)).active).toBe(false)
})

test('dated activity uses the civil UTC year even for TT and TDB inputs', () => {
	const utc = timeYMDHMS(2023, 12, 31, 23, 59, 59, Timescale.UTC)
	const activity = { kind: 'outburst', source: '2023out', years: { start: 2023, end: 2023 } } as const

	expect(meteorShowerActivityYearApplies(activity, utc)).toBe(true)
	expect(meteorShowerActivityYearApplies(activity, timeConvert(utc, Timescale.TT))).toBe(true)
	expect(meteorShowerActivityYearApplies(activity, timeConvert(utc, Timescale.TDB))).toBe(true)
	expect(meteorShowerActivityYearApplies(activity, 2024)).toBe(false)
	expect(meteorShowerActivityYearApplies({ kind: 'annual', source: 'annual', years: { start: 2023, end: 2023 } }, 2024)).toBe(true)
})

test('multi-year activity includes both boundaries and every intervening civil year', () => {
	const activity = { kind: 'yearSpecific', source: '2014-16', years: { start: 2014, end: 2016 } } as const

	expect([2013, 2014, 2015, 2016, 2017].map((year) => meteorShowerActivityYearApplies(activity, year))).toEqual([false, true, true, true, false])
	const boundary = timeYMDHMS(2016, 12, 31, 23, 59, 59, Timescale.UTC)
	expect(meteorShowerActivityYearApplies(activity, timeConvert(boundary, Timescale.TT))).toBe(true)
	expect(meteorShowerActivityYearApplies(activity, timeConvert(boundary, Timescale.TDB))).toBe(true)
	expect(meteorShowerActivityYearApplies(activity, timeYMDHMS(2017, 1, 1, 0, 0, 0, Timescale.UTC))).toBe(false)
})

test('exponential activity applies degree slopes on both sides of its maximum', () => {
	expect(meteorActivityZhr(WRAPPED_EXPONENTIAL_PROFILE, deg(355))).toBeCloseTo(100 * 10 ** -5, 12)
	expect(meteorExponentialZhr(WRAPPED_EXPONENTIAL_PROFILE, 0)).toBeCloseTo(100, 12)
	expect(meteorActivityZhr(WRAPPED_EXPONENTIAL_PROFILE, deg(15))).toBeCloseTo(100 * 10 ** -30, 12)
	expect(meteorActivityZhr(WRAPPED_EXPONENTIAL_PROFILE, deg(21))).toBe(0)
	expect(meteorActivityMaximumSolarLongitude(WRAPPED_EXPONENTIAL_PROFILE)).toBe(0)

	const maximumOutsideSupport = { ...EXPONENTIAL_PROFILE, solarLongitude: deg(120) } satisfies MeteorActivityProfile
	expect(meteorActivityMaximumSolarLongitude(maximumOutsideSupport)).toBeUndefined()
})

test('sampled profiles use PCHIP inside support and reject unordered samples', () => {
	expect(meteorActivityZhr(SAMPLED_PROFILE, deg(350))).toBe(10)
	expect(meteorActivityZhr(SAMPLED_PROFILE, 0)).toBeCloseTo(20, 12)
	expect(meteorActivityZhr(SAMPLED_PROFILE, deg(355))).toBeCloseTo(17.5, 12)
	expect(meteorActivityZhr(SAMPLED_PROFILE, deg(5))).toBeCloseTo(17.5, 12)
	expect(meteorActivityZhr(SAMPLED_PROFILE, deg(25))).toBe(0)
	expect(meteorActivityMaximumSolarLongitude(SAMPLED_PROFILE)).toBe(0)

	const oneSample = { type: 'sampled', support: WRAPPED_INTERVAL, samples: [{ solarLongitude: 0, zhr: 7 }] } satisfies MeteorActivityProfile
	expect(meteorActivityZhr(oneSample, 0)).toBe(7)
	expect(meteorActivityZhr(oneSample, deg(1))).toBe(0)

	const unordered = {
		type: 'sampled',
		support: WRAPPED_INTERVAL,
		samples: [
			{ solarLongitude: deg(350), zhr: 1 },
			{ solarLongitude: deg(10), zhr: 2 },
			{ solarLongitude: 0, zhr: 3 },
		],
	} satisfies MeteorActivityProfile
	expect(() => meteorActivityZhr(unordered, deg(5))).toThrow('strictly increasing')
})

test('multi-peak profiles preserve disconnected widths and find the global maximum', () => {
	expect(toDeg(meteorActivityMaximumSolarLongitude(MULTI_PEAK_PROFILE)!)).toBeCloseTo(10, 10)
	const intervals = meteorActivityIntervalsAboveFraction(MULTI_PEAK_PROFILE, 0.5)
	expect(intervals).toHaveLength(2)
	expect(toDeg(intervals[0].start)).toBeCloseTo(6.9897, 3)
	expect(toDeg(intervals[0].end)).toBeCloseTo(13.0103, 3)
	expect(toDeg(intervals[1].start)).toBeCloseTo(186.9897, 3)
	expect(toDeg(intervals[1].end)).toBeCloseTo(193.0103, 3)
	expect(meteorActivityIntervalsAboveFraction(MULTI_PEAK_PROFILE, -0.1)).toEqual([])
	expect(meteorActivityIntervalsAboveFraction(MULTI_PEAK_PROFILE, 1.1)).toEqual([])
})

test('activity fractions are normalized by the finite global peak', () => {
	expect(meteorActivityFraction(EXPONENTIAL_PROFILE, EXPONENTIAL_PROFILE.solarLongitude)).toBe(1)
	expect(meteorActivityFraction(EXPONENTIAL_PROFILE, deg(80))).toBe(0)
	expect(meteorActivityFraction(SAMPLED_PROFILE, deg(350))).toBeCloseTo(0.5, 14)
	expect(meteorActivityFraction(SAMPLED_PROFILE, 0)).toBe(1)
	const unequal = {
		type: 'multiPeak',
		components: [
			{ type: 'exponential', support: { start: deg(0), end: deg(20) }, solarLongitude: deg(10), zhr: 100, slopeBefore: 1, slopeAfter: 1 },
			{ type: 'exponential', support: { start: deg(180), end: deg(200) }, solarLongitude: deg(190), zhr: 25, slopeBefore: 1, slopeAfter: 1 },
		],
	} satisfies MeteorActivityProfile
	expect(meteorActivityFraction(unequal, deg(190))).toBeCloseTo(0.25, 12)
	const zero = { type: 'sampled', support: WRAPPED_INTERVAL, samples: [{ solarLongitude: 0, zhr: 0 }] } satisfies MeteorActivityProfile
	expect(meteorActivityFraction(zero, 0)).toBe(0)
})

test('fraction thresholds include limiting cases and sampled support edges', () => {
	const intervals = meteorActivityIntervalsAboveFraction(SAMPLED_PROFILE, 0.5)
	expect(intervals).toHaveLength(1)
	expect(toDeg(intervals[0].start)).toBeCloseTo(350, 8)
	expect(toDeg(intervals[0].end)).toBeCloseTo(10, 8)
	const fullCircle = meteorActivityIntervalsAboveFraction(SAMPLED_PROFILE, 0)
	expect(fullCircle).toEqual([{ start: 0, end: 0, fullCircle: true }])
	expect(isMeteorShowerActive(fullCircle[0], deg(180))).toBe(true)
	expect(meteorActivityProgress(fullCircle[0], Math.PI)).toBeCloseTo(0.5, 14)
	expect(meteorActivityIntervalsAboveFraction(SAMPLED_PROFILE, 1)).toHaveLength(1)

	const empty = { type: 'sampled', support: WRAPPED_INTERVAL, samples: [] } satisfies MeteorActivityProfile
	expect(meteorActivityZhr(empty, 0)).toBe(0)
	expect(meteorActivityMaximumSolarLongitude(empty)).toBeUndefined()
	expect(meteorActivityIntervalsAboveFraction(empty, 0.5)).toEqual([])
})

test('activity integration uses Simpson for even panels and trapezoids otherwise', () => {
	const start = REFERENCE_UTC
	const end = timeYMDHMS(2024, 1, 5, 0, 0, 0, Timescale.UTC)
	let samples = 0
	const options = {
		step: 0.5,
		solarLongitude: () => {
			samples++
			return deg(100)
		},
	}
	expect(integrateMeteorZhr(EXPONENTIAL_PROFILE, start, end, options)).toBeCloseTo(120 * 24, 12)
	expect(samples).toBe(3)

	samples = 0
	expect(
		integrateMeteorZhr(EXPONENTIAL_PROFILE, start, end, {
			step: 0.4,
			solarLongitude: () => {
				samples++
				return deg(100)
			},
		}),
	).toBeCloseTo(120 * 24, 12)
	expect(samples).toBe(4)
	expect(integrateMeteorZhr(EXPONENTIAL_PROFILE, end, start, { solarLongitude: () => deg(100) })).toBe(0)
	expect(() => integrateMeteorZhr(EXPONENTIAL_PROFILE, start, end, { step: 0 })).toThrow('finite and positive')
	expect(() => integrateMeteorZhr(EXPONENTIAL_PROFILE, start, end, { step: Number.POSITIVE_INFINITY })).toThrow('finite and positive')
})
