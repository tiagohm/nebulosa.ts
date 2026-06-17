import { expect, test, describe } from 'bun:test'
import { ONE_ATM } from '../src/constants'
import { fromPressure, kilometer, lightYear, meter, parsec, toKilometer, toLightYear, toMeter, toParsec } from '../src/distance'

test('meter converts meters to AU and back', () => {
	expect(toMeter(meter(1))).toBeCloseTo(1, 15)
	expect(toMeter(meter(149_597_870_700))).toBeCloseTo(149_597_870_700, 5)
})

test('kilometer converts kilometers to AU and back', () => {
	expect(toKilometer(kilometer(1))).toBeCloseTo(1, 15)
	expect(toKilometer(kilometer(149_597_870.7))).toBeCloseTo(149_597_870.7, 8)
})

test('lightYear converts using Julian year', () => {
	expect(lightYear(1)).toBeCloseTo(63241.07708426628, 10)
	expect(toLightYear(lightYear(1))).toBeCloseTo(1, 15)
})

test('parsec converts using AU per parsec', () => {
	expect(parsec(1)).toBeCloseTo(206264.80624709636, 10)
	expect(toParsec(parsec(1))).toBeCloseTo(1, 15)
})

describe('fromPressure', () => {
	test('returns zero altitude at standard pressure', () => {
		expect(toMeter(fromPressure(ONE_ATM, 15))).toBeCloseTo(0, 12)
	})

	test('estimates 500 m altitude pressure', () => {
		// Standard atmosphere pressure around 500 m.
		expect(toMeter(fromPressure(954.608, 15))).toBeCloseTo(500, 1)
	})

	test('estimates 1000 m altitude pressure', () => {
		// Standard atmosphere pressure around 1000 m.
		expect(toMeter(fromPressure(898.746, 15))).toBeCloseTo(1000, 1)
	})
})
