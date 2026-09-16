import { expect, test } from 'bun:test'
import { meteorShowerComputationContext, meteorShowerState, meteorShowerStates } from '../../../src/astronomy/meteors/state'
import type { MeteorActivityProfile, MeteorShowerActivity, MeteorShowerSolution, MeteorShowerStateInput } from '../../../src/astronomy/meteors/types'
import { timeYMDHMS, Timescale } from '../../../src/astronomy/time/time'
import { deg } from '../../../src/math/units/angle'
import { BASE_SOLUTION, EXPONENTIAL_PROFILE, OBSERVER, REFERENCE_UTC, SOLAR_DRIFT_SOLUTION } from './util'

test('instantaneous state agrees with individual activity and radiant helpers', () => {
	const context = meteorShowerComputationContext(REFERENCE_UTC, OBSERVER)
	const state = meteorShowerState(BASE_SOLUTION, context, { profile: EXPONENTIAL_PROFILE })
	expect(state.solution).toBe(BASE_SOLUTION)
	expect(state.solarLongitude).toBe(context.solarLongitude)
	expect(state.radiantJ2000).toBeDefined()
	expect(state.radiantOfDate).toBeDefined()
	expect(state.horizontal).toBeDefined()
	expect(state.sunAltitude).toBeDefined()
	expect(state.moonAltitude).toBeDefined()
	expect(state.moonSeparation).toBeDefined()
	expect(state.moonIllumination).toBeDefined()
	expect(state.activityFraction).toBeGreaterThanOrEqual(0)
	expect(state.activityFraction).toBeLessThanOrEqual(1)
})

test('batch states reuse one prepared context and equal scalar states', () => {
	const context = meteorShowerComputationContext(REFERENCE_UTC, OBSERVER)
	const solutions = [BASE_SOLUTION, SOLAR_DRIFT_SOLUTION]
	const inputs = solutions.map((solution) => ({ solution, profile: EXPONENTIAL_PROFILE }))
	const batch = meteorShowerStates(inputs, context)
	expect(batch).toEqual(inputs.map((input) => meteorShowerState(input.solution, context, { profile: input.profile })))
	expect(batch.every((state) => state.solarLongitude === context.solarLongitude)).toBe(true)
})

test('batch states apply independent profiles and preserve scalar equivalence', () => {
	const context = { time: REFERENCE_UTC, solarLongitude: deg(100) }
	const secondProfile = { ...EXPONENTIAL_PROFILE, solarLongitude: deg(99), zhr: 30, slopeBefore: 1, slopeAfter: 1 } satisfies MeteorActivityProfile
	const inputs: readonly MeteorShowerStateInput[] = [{ solution: BASE_SOLUTION, profile: EXPONENTIAL_PROFILE }, { solution: SOLAR_DRIFT_SOLUTION, profile: secondProfile }, { solution: BASE_SOLUTION }]
	const options = { includeHorizontal: false, includeMoon: false, includeRadiantOfDate: false, includeSun: false } as const
	const batch = meteorShowerStates(inputs, context, options)

	expect(batch).toEqual(inputs.map((input) => meteorShowerState(input.solution, context, { ...options, profile: input.profile })))
	expect(batch[0].zhr).toBe(120)
	expect(batch[0].activityFraction).toBe(1)
	expect(batch[1].zhr).toBeCloseTo(3, 12)
	expect(batch[1].activityFraction).toBeCloseTo(0.1, 12)
	expect(batch[2].zhr).toBeUndefined()
	expect(batch.every((state) => state.solarLongitude === context.solarLongitude)).toBe(true)
})

test('state activity combines catalog and profile knowledge as a tri-state', () => {
	const context = { time: REFERENCE_UTC, solarLongitude: deg(100) }
	const quietOptions = { includeHorizontal: false, includeMoon: false, includeRadiantOfDate: false, includeSun: false } as const
	const noCatalog = { ...BASE_SOLUTION, activityInterval: undefined } satisfies MeteorShowerSolution
	const inactiveCatalog = { ...BASE_SOLUTION, activityInterval: { start: deg(200), end: deg(210) } } satisfies MeteorShowerSolution
	const inactiveProfile = { ...EXPONENTIAL_PROFILE, support: { start: deg(200), end: deg(210) }, solarLongitude: deg(205) } satisfies MeteorActivityProfile

	expect(meteorShowerState(BASE_SOLUTION, context, { ...quietOptions, profile: EXPONENTIAL_PROFILE }).active).toBe(true)
	expect(meteorShowerState(BASE_SOLUTION, context, { ...quietOptions, profile: inactiveProfile }).active).toBe(false)
	expect(meteorShowerState(inactiveCatalog, context, { ...quietOptions, profile: EXPONENTIAL_PROFILE }).active).toBe(false)
	expect(meteorShowerState(inactiveCatalog, context, { ...quietOptions, profile: inactiveProfile }).active).toBe(false)
	expect(meteorShowerState(BASE_SOLUTION, context, quietOptions).active).toBe(true)
	expect(meteorShowerState(inactiveCatalog, context, quietOptions).active).toBe(false)
	expect(meteorShowerState(noCatalog, context, { ...quietOptions, profile: EXPONENTIAL_PROFILE }).active).toBe(true)
	expect(meteorShowerState(noCatalog, context, { ...quietOptions, profile: inactiveProfile }).active).toBe(false)
	expect(meteorShowerState(noCatalog, context, quietOptions).active).toBeUndefined()
	expect(meteorShowerState({ ...noCatalog, referenceSolarLongitude: deg(100) }, context, quietOptions).active).toBeUndefined()
	expect(meteorShowerState(BASE_SOLUTION, context, { ...quietOptions, profile: inactiveProfile, includeActivity: false }).active).toBe(true)
	expect(meteorShowerState(noCatalog, context, { ...quietOptions, profile: EXPONENTIAL_PROFILE, includeActivity: false }).active).toBeUndefined()
})

test('state applies dated observation and outburst years only as an activity gate', () => {
	const quietOptions = { includeHorizontal: false, includeMoon: false, includeRadiantOfDate: false, includeSun: false } as const
	const activeInterval = BASE_SOLUTION.activityInterval
	const inactiveInterval = { start: deg(200), end: deg(210) }
	const stateAt = (activity: MeteorShowerActivity, year: number, activityInterval: MeteorShowerSolution['activityInterval']) => meteorShowerState({ ...BASE_SOLUTION, activity, activityInterval }, { time: timeYMDHMS(year, 6, 1, 0, 0, 0, Timescale.UTC), solarLongitude: deg(100) }, quietOptions).active

	expect(stateAt({ kind: 'annual', source: 'annual' }, 2026, activeInterval)).toBe(true)
	expect(stateAt({ kind: 'yearSpecific', source: '2022', years: { start: 2022, end: 2022 } }, 2022, activeInterval)).toBe(true)
	expect(stateAt({ kind: 'yearSpecific', source: '2022', years: { start: 2022, end: 2022 } }, 2026, activeInterval)).toBe(false)
	expect(stateAt({ kind: 'yearSpecific', source: '2022', years: { start: 2022, end: 2022 } }, 2022, inactiveInterval)).toBe(false)
	expect(stateAt({ kind: 'yearSpecific', source: '2022', years: { start: 2022, end: 2022 } }, 2022, undefined)).toBeUndefined()
	expect(stateAt({ kind: 'outburst', source: '1989out', years: { start: 1989, end: 1989 } }, 1989, activeInterval)).toBe(true)
	expect(stateAt({ kind: 'outburst', source: '1989out', years: { start: 1989, end: 1989 } }, 2026, activeInterval)).toBe(false)
	expect([2013, 2014, 2015, 2016, 2017].map((year) => stateAt({ kind: 'yearSpecific', source: '2014-16', years: { start: 2014, end: 2016 } }, year, activeInterval))).toEqual([false, true, true, true, false])
	expect(stateAt({ kind: 'variable', source: 'variable' }, 2026, activeInterval)).toBe(true)
	expect(stateAt({ kind: 'unknown', source: '' }, 2026, undefined)).toBeUndefined()

	const extrapolated = meteorShowerState({ ...BASE_SOLUTION, activity: { kind: 'yearSpecific', source: '2022', years: { start: 2022, end: 2022 } } }, { time: timeYMDHMS(2026, 6, 1, 0, 0, 0, Timescale.UTC), solarLongitude: deg(100) }, { ...quietOptions, extrapolateYearLimitedActivity: true })
	expect(extrapolated.active).toBe(true)
})

test('state retains radiant extrapolation metadata without changing radiant availability', () => {
	const context = { time: REFERENCE_UTC, solarLongitude: SOLAR_DRIFT_SOLUTION.referenceSolarLongitude }
	const options = { includeHorizontal: false, includeMoon: false, includeRadiantOfDate: false, includeSun: false } as const
	expect(meteorShowerState(BASE_SOLUTION, context, options).radiantExtrapolated).toBe(false)
	expect(meteorShowerState(SOLAR_DRIFT_SOLUTION, context, options).radiantExtrapolated).toBe(false)
	expect(meteorShowerState(SOLAR_DRIFT_SOLUTION, { ...context, solarLongitude: deg(101) }, options).radiantExtrapolated).toBe(true)
	expect(meteorShowerState({ ...BASE_SOLUTION, rightAscension: undefined }, context, options).radiantExtrapolated).toBeUndefined()
})

test('state options omit observer, solar, lunar, horizontal and activity work', () => {
	const options = { includeActivity: false, includeHorizontal: false, includeMoon: false, includeRadiantOfDate: false, includeSun: false } as const
	const context = meteorShowerComputationContext(REFERENCE_UTC, undefined, { includeHorizontal: false, includeMoon: false, includeSun: false })
	expect(context.localSiderealTime).toBeUndefined()
	expect(context.sun).toBeUndefined()
	expect(context.moon).toBeUndefined()
	const state = meteorShowerState({ ...BASE_SOLUTION, referenceSolarLongitude: deg(100) }, context, options)
	expect(state.radiantJ2000).toBeDefined()
	expect(state.radiantOfDate).toBeUndefined()
	expect(state.horizontal).toBeUndefined()
	expect(state.sunAltitude).toBeUndefined()
	expect(state.moonAltitude).toBeUndefined()
	expect(state.moonSeparation).toBeUndefined()
	expect(state.moonIllumination).toBeUndefined()
	expect(state.zhr).toBeUndefined()
	expect(state.activityFraction).toBeUndefined()
})
