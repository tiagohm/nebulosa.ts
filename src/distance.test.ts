import { expect, test } from 'bun:test'
import { fromPressure, kilometer, lightYear, meter, parsec, toKilometer, toLightYear, toMeter, toParsec } from './distance'
import { ONE_ATM, pascal } from './pressure'

test('meter', () => {
	expect(meter(1)).toBeCloseTo(6.684587e-12, 18)
})

test('kilometer', () => {
	expect(kilometer(1)).toBeCloseTo(6.684587e-9, 15)
})

test('lightYear', () => {
	expect(lightYear(1)).toBeCloseTo(63241.0771, 4)
})

test('parsec', () => {
	expect(parsec(1)).toBeCloseTo(206264.80624, 4)
})

test('toMeter', () => {
	expect(toMeter(1)).toBeCloseTo(149597870700, 18)
})

test('toKilometer', () => {
	expect(toKilometer(1)).toBeCloseTo(149597870.700, 18)
})

test('toLightYear', () => {
	expect(toLightYear(1)).toBeCloseTo(1.58125e-5, 10)
})

test('toParsec', () => {
	expect(toParsec(1)).toBeCloseTo(4.8481e-6, 10)
})

test('fromPressure', () => {
	expect(fromPressure(ONE_ATM, 15)).toBe(0)
	expect(toMeter(fromPressure(pascal(80000), 15))).toBeCloseTo(1949.02, 2)
})
