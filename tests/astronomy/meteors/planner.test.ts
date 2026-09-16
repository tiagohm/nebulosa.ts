import { expect, test } from 'bun:test'
import { meteorObservingWindows } from '../../../src/astronomy/meteors/planner'
import { meteorSolarLongitude, timeAtMeteorSolarLongitude } from '../../../src/astronomy/meteors/solar'
import { meteorShowerComputationContext, meteorShowerState } from '../../../src/astronomy/meteors/state'
import type { MeteorActivityProfile, MeteorShowerSolution } from '../../../src/astronomy/meteors/types'
import { timeShift, timeSubtract, timeToDate, timeYMDHMS, Timescale } from '../../../src/astronomy/time/time'
import { deg } from '../../../src/math/units/angle'
import { BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, PLANNER_END, PLANNER_MULTI_PROFILE, PLANNER_START, SITE_EPOCH, SITE_EPOCH_END, SOLAR_DRIFT_SOLUTION, ZERO_WIDTH_INTERVAL } from './util'

const DAY_OPTIONS = { maximumSolarAltitude: deg(90), minimumRadiantAltitude: 0, step: 1 / 48 } as const

test('both observing-window overloads identify the same real short window', () => {
	const direct = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, DAY_OPTIONS)
	const reversed = meteorObservingWindows(EXPONENTIAL_PROFILE, BASE_SOLUTION, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, DAY_OPTIONS)

	expect(direct).toHaveLength(1)
	expect(reversed).toHaveLength(1)
	expect(reversed[0].durationHours).toBeCloseTo(direct[0].durationHours, 12)
	expect(reversed[0].expectedCount).toBeCloseTo(direct[0].expectedCount, 12)
	expect(direct[0].durationHours).toBeCloseTo(2, 12)
	expect(direct[0].expectedCount).toBeCloseTo(134.70811528832383, 8)
	expect(direct[0].bestTime).toBeDefined()
	expect(direct[0].moonIlluminationAtBest).toBeUndefined()
	expect(direct[0].maximumRadiantAltitude).toBeDefined()
	expect(direct[0].maximumActivityFraction).toBeDefined()
	expect(direct[0].maximumZhr).toBeDefined()
	expect(direct[0].minimumMoonRadiantSeparation).toBeUndefined()
	expect(direct[0].maximumMoonAltitude).toBeUndefined()
}, 4000)

test('planner intersects a real short window with astronomical darkness', () => {
	const windows = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { step: 1 / 48, minimumRadiantAltitude: 0 })
	expect(windows).toHaveLength(1)
	expect(windows[0].durationHours).toBeGreaterThan(0)
	expect(windows[0].durationHours).toBeLessThan(1.2)
}, 4000)

test('planner refines a minimum radiant-altitude boundary', () => {
	const windows = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { ...DAY_OPTIONS, minimumRadiantAltitude: deg(80) })
	expect(windows).toHaveLength(1)
	expect(windows[0].durationHours).toBeLessThan(1)
}, 2000)

test('planner can reject bright lunar constraints', () => {
	const windows = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { ...DAY_OPTIONS, maximumMoonIllumination: 0.5 })
	expect(windows).toEqual([])
})

test('planner applies lunar altitude and retains sampled lunar metrics', () => {
	const permissive = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { ...DAY_OPTIONS, maximumMoonAltitude: deg(90) })
	expect(permissive).toHaveLength(1)
	expect(permissive[0].moonIlluminationAtBest).toBeDefined()
	expect(permissive[0].minimumMoonRadiantSeparation).toBeDefined()
	expect(permissive[0].maximumMoonAltitude).toBeDefined()

	const rejected = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { ...DAY_OPTIONS, maximumMoonAltitude: deg(-90) })
	expect(rejected).toEqual([])
	const combined = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, {
		...DAY_OPTIONS,
		maximumMoonAltitude: deg(90),
		minimumMoonRadiantSeparation: 0,
		maximumMoonIllumination: 1,
	})
	expect(combined).toHaveLength(1)
}, 1500)

test('a below-horizon Moon satisfies illumination, separation and inclusive altitude limits', () => {
	const start = timeShift(SITE_EPOCH, -6 / 24)
	const end = timeShift(SITE_EPOCH, -4 / 24)
	const moonLimit = meteorShowerState(BASE_SOLUTION, meteorShowerComputationContext(end, OBSERVER)).moonAltitude!
	const windows = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, start, end, {
		maximumSolarAltitude: deg(90),
		minimumRadiantAltitude: 0,
		maximumMoonAltitude: moonLimit,
		maximumMoonIllumination: 0,
		minimumMoonRadiantSeparation: deg(180),
		step: 1 / 48,
	})
	expect(windows).toHaveLength(1)
	expect(windows[0].maximumMoonAltitude).toBeLessThanOrEqual(moonLimit + 1e-10)
})

test('planner samples a sub-step catalog activity interval inside a broad profile', () => {
	const center = meteorSolarLongitude(timeShift(SITE_EPOCH, 0.5 / 24))
	const start = timeShift(SITE_EPOCH, 0.25 / 24)
	const end = timeShift(SITE_EPOCH, 0.75 / 24)
	const narrowCatalog = {
		...BASE_SOLUTION,
		activityInterval: { start: center - deg(0.0075), end: center + deg(0.0075) },
	} satisfies MeteorShowerSolution
	const windows = meteorObservingWindows(narrowCatalog, EXPONENTIAL_PROFILE, OBSERVER, start, end, { ...DAY_OPTIONS, step: 1 / 24 })

	expect(windows).toHaveLength(1)
	expect(windows[0].durationHours).toBeGreaterThan(0)
	expect(windows[0].durationHours).toBeLessThan(0.5)
})

test('planner restricts a year-long scan to a narrow activity support', () => {
	const support = { start: deg(99.99), end: deg(100.01) }
	const solution = { ...BASE_SOLUTION, activityInterval: support } satisfies MeteorShowerSolution
	const profile = { ...EXPONENTIAL_PROFILE, support } satisfies MeteorActivityProfile
	const start = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.UTC)
	const end = timeYMDHMS(2027, 1, 1, 0, 0, 0, Timescale.UTC)
	const windows = meteorObservingWindows(solution, profile, OBSERVER, start, end, { maximumSolarAltitude: deg(90), minimumRadiantAltitude: deg(-90), step: 1 })

	expect(windows).toHaveLength(1)
	expect(windows[0].durationHours).toBeGreaterThan(0)
	expect(windows[0].durationHours).toBeLessThan(1)
})

test('planner limits long candidate searches to catalog activity years', () => {
	const support = { start: deg(99.99), end: deg(100.01) }
	const solution = { ...BASE_SOLUTION, activity: { kind: 'yearSpecific', source: '2014-16', years: { start: 2014, end: 2016 } }, activityInterval: support } satisfies MeteorShowerSolution
	const profile = { ...EXPONENTIAL_PROFILE, support } satisfies MeteorActivityProfile
	const start = timeYMDHMS(2000, 1, 1, 0, 0, 0, Timescale.UTC)
	const end = timeYMDHMS(2031, 1, 1, 0, 0, 0, Timescale.UTC)
	const windows = meteorObservingWindows(solution, profile, OBSERVER, start, end, { maximumSolarAltitude: deg(90), minimumRadiantAltitude: deg(-90), step: 1 })

	expect(windows.length).toBeGreaterThanOrEqual(3)
	expect([...new Set(windows.map((window) => timeToDate(window.start)[0]))].sort((a, b) => a - b)).toEqual([2014, 2015, 2016])
})

test('planner integrates a constant local hourly rate over the window duration', () => {
	const flatProfile = { ...EXPONENTIAL_PROFILE, slopeBefore: 0, slopeAfter: 0 } satisfies MeteorActivityProfile
	const windows = meteorObservingWindows(BASE_SOLUTION, flatProfile, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, {
		...DAY_OPTIONS,
		step: 1 / 24,
		rateCorrection: (_time, conditions) => 1 / Math.sin(conditions.radiant.altitude),
	})

	expect(windows).toHaveLength(1)
	expect(windows[0].bestLocalHourlyRate).toBeCloseTo(120, 12)
	expect(windows[0].expectedCount).toBeCloseTo(windows[0].bestLocalHourlyRate * windows[0].durationHours, 10)
})

test('planner selects the greatest refined maximum when a lower coarse sample hides it', () => {
	const flatProfile = { ...EXPONENTIAL_PROFILE, slopeBefore: 0, slopeAfter: 0 } satisfies MeteorActivityProfile
	const end = timeShift(SITE_EPOCH, 2 / 24)
	const windows = meteorObservingWindows(BASE_SOLUTION, flatProfile, OBSERVER, SITE_EPOCH, end, {
		...DAY_OPTIONS,
		step: 0.5 / 24,
		rateCorrection: (time, conditions) => {
			const hours = timeSubtract(time, SITE_EPOCH) * 24
			const firstOffset = (hours - 0.5) / 0.18
			const secondOffset = (hours - 1.7) / 0.12
			const first = 6 * Math.exp(-(firstOffset * firstOffset))
			const second = 10 * Math.exp(-(secondOffset * secondOffset))
			return (first + second) / (120 * Math.sin(conditions.radiant.altitude))
		},
	})

	expect(windows).toHaveLength(1)
	const bestTime = windows[0].bestTime
	expect(bestTime).toBeDefined()
	if (bestTime === undefined) return
	expect(timeSubtract(bestTime, SITE_EPOCH) * 24).toBeCloseTo(1.7, 3)
	expect(windows[0].bestLocalHourlyRate).toBeCloseTo(10, 6)
})

test('planner can reject a radiant that is too close to the Moon', () => {
	const windows = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { ...DAY_OPTIONS, minimumMoonRadiantSeparation: deg(180) })
	expect(windows).toEqual([])
})

test('separate real profile peaks produce sorted windows by expected local count', () => {
	const windows = meteorObservingWindows(BASE_SOLUTION, PLANNER_MULTI_PROFILE, OBSERVER, PLANNER_START, PLANNER_END, { ...DAY_OPTIONS, step: 1 / 24 })
	expect(windows).toHaveLength(2)
	expect(windows[0].expectedCount).toBeGreaterThan(windows[1].expectedCount)
	expect(windows[0].bestLocalHourlyRate).toBeGreaterThan(windows[1].bestLocalHourlyRate)
	expect(windows[0].durationHours).toBeGreaterThan(0)
	expect(windows[1].durationHours).toBeGreaterThan(0)
})

test('rate correction scales integrated count', () => {
	const corrected = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, PLANNER_START, PLANNER_END, {
		...DAY_OPTIONS,
		rateCorrection: (time, conditions) => {
			expect(conditions.time).toBe(time)
			return 0.5
		},
	})

	expect(corrected).toHaveLength(1)
	expect(corrected[0].expectedCount).toBeCloseTo(69.43670313082661, 6)
	expect(corrected[0].bestLocalHourlyRate).toBeCloseTo(35.68435, 4)
}, 2000)

test('minimum duration filters a real short window', () => {
	const tooLong = meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, PLANNER_START, PLANNER_END, { ...DAY_OPTIONS, minimumDurationHours: 2.1 })
	expect(tooLong).toEqual([])
})

test('inactive profiles, catalog intervals and inverted ranges return empty windows', () => {
	const inactiveProfile = { ...EXPONENTIAL_PROFILE, support: { start: deg(0), end: deg(10) }, solarLongitude: deg(5) } satisfies MeteorActivityProfile
	const inactiveCatalog = { ...BASE_SOLUTION, activityInterval: ZERO_WIDTH_INTERVAL } satisfies MeteorShowerSolution

	expect(meteorObservingWindows(BASE_SOLUTION, inactiveProfile, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, DAY_OPTIONS)).toEqual([])
	expect(meteorObservingWindows(inactiveCatalog, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, DAY_OPTIONS)).toEqual([])
	expect(meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH_END, SITE_EPOCH, DAY_OPTIONS)).toEqual([])
	expect(() => meteorObservingWindows(BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { ...DAY_OPTIONS, step: 0 })).toThrow('finite and positive')
})

test('an unavailable drifting radiant removes the candidate window', () => {
	const polar = { ...SOLAR_DRIFT_SOLUTION, declination: deg(89), radiantDrift: { basis: 'solarLongitude', rightAscensionRate: 0, declinationRate: deg(1000) } } satisfies MeteorShowerSolution
	const windows = meteorObservingWindows(polar, EXPONENTIAL_PROFILE, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, DAY_OPTIONS)
	expect(windows).toEqual([])
})

test('planner honors an inclusive catalog year range', () => {
	const yearSpecific = { ...BASE_SOLUTION, activity: { kind: 'yearSpecific', source: '2014-16', years: { start: 2014, end: 2016 } } } satisfies MeteorShowerSolution
	const hasWindows = [2013, 2014, 2015, 2016, 2017].map((year) => {
		const start = timeAtMeteorSolarLongitude(year, BASE_SOLUTION.referenceSolarLongitude, { step: 7 })
		return meteorObservingWindows(yearSpecific, EXPONENTIAL_PROFILE, OBSERVER, start, timeShift(start, 2 / 24), { maximumSolarAltitude: deg(90), minimumRadiantAltitude: deg(-90), step: 1 / 48 }).length > 0
	})

	expect(hasWindows).toEqual([false, true, true, true, false])
	const start = timeAtMeteorSolarLongitude(2017, BASE_SOLUTION.referenceSolarLongitude, { step: 7 })
	expect(meteorObservingWindows(yearSpecific, EXPONENTIAL_PROFILE, OBSERVER, start, timeShift(start, 2 / 24), { maximumSolarAltitude: deg(90), minimumRadiantAltitude: deg(-90), extrapolateYearLimitedActivity: true, step: 1 / 48 })).toHaveLength(1)
})
