import { expect, test } from 'bun:test'
import { meteorShowerComputationContext, meteorShowerState, meteorShowerStates } from '../../../src/astronomy/meteors/state'
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
	const options = { profile: EXPONENTIAL_PROFILE } as const
	const batch = meteorShowerStates(solutions, context, options)
	expect(batch).toEqual(solutions.map((solution) => meteorShowerState(solution, context, options)))
	expect(batch.every((state) => state.solarLongitude === context.solarLongitude)).toBe(true)
})

test('state options omit observer, solar, lunar, horizontal and activity work', () => {
	const options = { includeActivity: false, includeHorizontal: false, includeMoon: false, includeRadiantOfDate: false, includeSun: false } as const
	const context = meteorShowerComputationContext(REFERENCE_UTC, undefined, options)
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
