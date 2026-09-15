import { expect, test } from 'bun:test'
import { integrateMeteorZhr, isMeteorShowerActive, meteorActivityIntervalsAboveFraction, meteorActivityMaximumSolarLongitude, meteorActivityPhase, meteorActivityZhr, meteorExponentialZhr, meteorSolarLongitudeForwardDelta } from '../../../src/astronomy/meteors/activity'
import type { MeteorActivityProfile } from '../../../src/astronomy/meteors/types'
import { timeYMDHMS, Timescale } from '../../../src/astronomy/time/time'
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
	expect(meteorActivityPhase(WRAPPED_INTERVAL, deg(350))).toBe(0)
	expect(meteorActivityPhase(WRAPPED_INTERVAL, deg(20))).toBe(1)
	expect(meteorActivityPhase(undefined, deg(10))).toBeUndefined()
	expect(meteorActivityPhase(ZERO_WIDTH_INTERVAL, deg(25))).toBeUndefined()
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

test('fraction thresholds include limiting cases and sampled support edges', () => {
	const intervals = meteorActivityIntervalsAboveFraction(SAMPLED_PROFILE, 0.5)
	expect(intervals).toHaveLength(1)
	expect(toDeg(intervals[0].start)).toBeCloseTo(350, 8)
	expect(toDeg(intervals[0].end)).toBeCloseTo(10, 8)
	expect(meteorActivityIntervalsAboveFraction(SAMPLED_PROFILE, 0)).toEqual([{ start: 0, end: 0 }])
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
