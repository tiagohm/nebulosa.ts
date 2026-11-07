import { expect, test } from 'bun:test'
import { moonInterference, observationScore, observationScoreFactors } from '../../src/astronomy/planning'
import { DEG2RAD, PI, PIOVERTWO } from '../../src/core/constants'

test('moon interference is zero below the horizon and one for a zenith full moon on the target', () => {
	expect(moonInterference(1, -0.1, 0)).toBe(0)
	expect(moonInterference(0, PIOVERTWO, 0)).toBe(0)
	expect(moonInterference(1, PIOVERTWO, 0)).toBeCloseTo(1, 12)
	expect(moonInterference(1, PIOVERTWO, 30 * DEG2RAD)).toBeCloseTo(Math.exp(-0.5), 12)
	expect(moonInterference(1, PIOVERTWO, PI)).toBeLessThan(0.02)
})

test('observation score saturates for a dark high target and falls when a constraint gets worse', () => {
	const perfect = { altitude: PIOVERTWO, sunAltitude: -20 * DEG2RAD, moonInterference: 0, availableDurationHours: 4, requiredDurationHours: 2 }
	expect(observationScore(perfect)).toBeCloseTo(1, 8)
	expect(observationScore(perfect, { scale: 100 })).toBeCloseTo(100, 6)
	expect(observationScore({ altitude: 0 })).toBe(0)
	expect(observationScore({ ...perfect, sunAltitude: 0 })).toBe(0)
	expect(observationScore({ ...perfect, moonInterference: 1 })).toBe(0)
	expect(observationScore({ altitude: PIOVERTWO, availableDurationHours: 1, requiredDurationHours: 2 })).toBeLessThan(observationScore({ altitude: PIOVERTWO }))
})

test('observation score factors name each term and their geometric mean is the score', () => {
	const input = { altitude: 30 * DEG2RAD, sunAltitude: -15 * DEG2RAD, moonInterference: 0.2, availableDurationHours: 1, requiredDurationHours: 4 }
	const factors = observationScoreFactors(input)
	expect(factors.altitude).toBeCloseTo(0.5, 12)
	expect(factors.twilight).toBeCloseTo(0.5, 12)
	expect(factors.moon).toBeCloseTo(0.8, 12)
	expect(factors.duration).toBeCloseTo(0.25, 12)
	expect(factors.airmass).toBeGreaterThan(0)
	expect(factors.airmass).toBeLessThan(1)
	const mean = (factors.altitude * factors.airmass * factors.twilight! * factors.moon! * factors.duration!) ** (1 / 5)
	expect(observationScore(input)).toBeCloseTo(mean, 12)
	expect(observationScoreFactors({ altitude: -0.1 })).toEqual({ altitude: 0, airmass: 0, twilight: undefined, moon: undefined, duration: undefined })
	expect(observationScoreFactors({ altitude: PIOVERTWO, availableDurationHours: 0, requiredDurationHours: 0 }).duration).toBe(1)
})
