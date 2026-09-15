import { expect, test } from 'bun:test'
// oxfmt-ignore
import { combineMeteorVisualObservations, integrateMeteorExpectedCount, meteorGarwoodInterval, meteorGarwoodZhr, meteorLocalHourlyRate, meteorMagnitudeRatio, meteorMassIndex, meteorObservingConditionsAt, meteorObservationContext, meteorPopulationIndex, meteorVisualRate, meteorZhrFromObservation } from '../../../src/astronomy/meteors/observation'
import { meteorRadiantHorizontal } from '../../../src/astronomy/meteors/radiant'
import type { MeteorHorizontalRadiant, MeteorVisualObservation } from '../../../src/astronomy/meteors/types'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { deg } from '../../../src/math/units/angle'
import { EXPONENTIAL_PROFILE, OBSERVER, REFERENCE_UTC, VISUAL_OBSERVATION } from './util'

test('visual ZHR and local rate apply magnitude, population, obstruction and altitude', () => {
	// The standard equation gives 24 ZHR for this frozen visual observation.
	expect(meteorZhrFromObservation(VISUAL_OBSERVATION)).toBeCloseTo(24, 14)
	expect(meteorLocalHourlyRate(24, VISUAL_OBSERVATION)).toBeCloseTo(5, 14)
	expect(meteorVisualRate(VISUAL_OBSERVATION).zhr).toBeCloseTo(24, 14)
	expect(meteorVisualRate(VISUAL_OBSERVATION).localHourlyRate).toBeCloseTo(5, 14)
	expect(meteorVisualRate(VISUAL_OBSERVATION).observation).toBe(VISUAL_OBSERVATION)

	const quadraticAltitude = { ...VISUAL_OBSERVATION, altitudeExponent: 2 } satisfies MeteorVisualObservation
	expect(meteorZhrFromObservation(quadraticAltitude)).toBeCloseTo(48, 12)
	expect(meteorLocalHourlyRate(48, quadraticAltitude)).toBeCloseTo(5, 12)
	expect(meteorZhrFromObservation({ ...VISUAL_OBSERVATION, effectiveTime: 0 })).toBe(0)
	expect(meteorLocalHourlyRate(24, { ...VISUAL_OBSERVATION, radiantAltitude: 0 })).toBe(0)

	expect(meteorMagnitudeRatio(2, 3)).toBe(8)
	expect(meteorMassIndex(2)).toBeCloseTo(1.6923689900271568, 14)
	expect(meteorPopulationIndex(meteorMassIndex(2))).toBeCloseTo(2, 14)
})

test('combining observations weights valid exposure instead of averaging their ZHRs', () => {
	const first = { count: 4, effectiveTime: 1, limitingMagnitude: 6.5, populationIndex: 2, obstructionCorrection: 1, radiantAltitude: deg(90) } satisfies MeteorVisualObservation
	const second = { count: 6, effectiveTime: 2, limitingMagnitude: 6.5, populationIndex: 2, obstructionCorrection: 2, radiantAltitude: deg(90) } satisfies MeteorVisualObservation
	expect(combineMeteorVisualObservations([first, second])).toBeCloseTo(5, 14)
	expect(
		combineMeteorVisualObservations([
			{ ...first, effectiveTime: 0 },
			{ ...first, radiantAltitude: 0 },
		]),
	).toBe(0)
})

test('observation context and circumstances retain supplied local and lunar providers', () => {
	const context = meteorObservationContext(REFERENCE_UTC, OBSERVER)
	expect(context.time).toBe(REFERENCE_UTC)
	expect(context.solarLongitude).toBeDefined()
	expect(context.localSiderealTime).toBeDefined()
	const noObserver = meteorObservationContext(REFERENCE_UTC)
	expect(noObserver.localSiderealTime).toBeUndefined()

	const time = timeYMDHMS(2024, 1, 4, 0, 0, 0, Timescale.UTC)
	const horizontal = meteorRadiantHorizontal({ rightAscension: 0, declination: 0 }, OBSERVER, time, { time, solarLongitude: 0, localSiderealTime: deg(123) })
	const conditions = meteorObservingConditionsAt({ rightAscension: 0, declination: 0 }, OBSERVER, time, {
		time,
		solarLongitude: 0,
		localSiderealTime: deg(123),
		sun: [1, 0, 0],
		moon: [0, 1, 0],
	})
	expect(conditions.time).toBe(time)
	expect(conditions.radiant).toEqual(horizontal)
	expect(conditions.moonIllumination).toBeCloseTo((1 + Math.cos(Math.PI / 4)) * 0.5, 14)
	expect(conditions.moonRadiantSeparation).toBeCloseTo(Math.PI / 2, 14)
})

test('expected-count integration supports all providers and both quadrature paths', () => {
	const start = REFERENCE_UTC
	const end = timeYMDHMS(2024, 1, 5, 0, 0, 0, Timescale.UTC)
	let longitudes = 0
	let altitudes = 0
	const options = {
		limitingMagnitude: 6.5,
		populationIndex: 2,
		obstructionCorrection: 1,
		step: 0.5,
		solarLongitude: () => {
			longitudes++
			return deg(100)
		},
		radiantAltitude: () => {
			altitudes++
			return deg(90)
		},
	}
	// 120 meteors per hour maintained for 24 hours integrates to 2,880 meteors.
	expect(integrateMeteorExpectedCount(EXPONENTIAL_PROFILE, start, end, options)).toBeCloseTo(2880, 12)
	expect(longitudes).toBe(3)
	expect(altitudes).toBe(3)

	let samples = 0
	expect(
		integrateMeteorExpectedCount(EXPONENTIAL_PROFILE, start, end, {
			...options,
			step: 0.4,
			solarLongitude: () => {
				samples++
				return deg(100)
			},
			rateCorrection: () => 0.5,
		}),
	).toBeCloseTo(1440, 12)
	expect(samples).toBe(4)

	const horizontal = { ...meteorRadiantHorizontal({ rightAscension: 0, declination: 0 }, OBSERVER, start), altitude: deg(90) } satisfies MeteorHorizontalRadiant
	expect(integrateMeteorExpectedCount(EXPONENTIAL_PROFILE, start, end, { ...options, step: 0.5, radiant: () => horizontal })).toBeCloseTo(2880, 12)
	expect(integrateMeteorExpectedCount(EXPONENTIAL_PROFILE, start, end, { ...options, radiantAltitude: undefined, radiant: undefined, step: 0.5 })).toBe(0)
	expect(integrateMeteorExpectedCount(EXPONENTIAL_PROFILE, end, start, options)).toBe(0)
	expect(() => integrateMeteorExpectedCount(EXPONENTIAL_PROFILE, start, end, { ...options, step: 0 })).toThrow('finite and positive')
})

test('Garwood intervals match SciPy 1.18.1 at 95%', () => {
	const expected = [
		[0, 0, 3.6888794541139354],
		[1, 0.025317807984289876, 5.571643390938898],
		[5, 1.6234863901184207, 11.66833207932267],
		[10, 4.7953886961324335, 18.39035604201778],
		[25, 16.178681847829328, 36.904931697530365],
	] as const
	for (const [count, lower, upper] of expected) {
		const actual = meteorGarwoodInterval(count)
		expect(actual.lower).toBeCloseTo(lower, 12)
		expect(actual.upper).toBeCloseTo(upper, 12)
	}
})

test('Garwood ZHR propagates the Poisson interval through the observation scale', () => {
	const actual = meteorGarwoodZhr(VISUAL_OBSERVATION)
	expect(actual.lower).toBeCloseTo(11.508932870717853, 12)
	expect(actual.upper).toBeCloseTo(44.13685450084266, 12)
	const invalid = meteorGarwoodZhr({ ...VISUAL_OBSERVATION, radiantAltitude: 0 })
	expect(invalid).toEqual({ lower: 0, upper: 0 })
})
