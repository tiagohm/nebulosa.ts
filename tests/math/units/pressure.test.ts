import { expect, test } from 'bun:test'
import { ONE_ATM } from '../../../src/core/constants'
import { meter } from '../../../src/math/units/distance'
import { atm, pascal, pressureFrom, toAtm, toPascal } from '../../../src/math/units/pressure'

test('pascal', () => {
	expect(pascal(7)).toBe(0.07)
})

test('atm', () => {
	expect(atm(7)).toBe(7092.75)
})

test('toPascal', () => {
	expect(toPascal(45)).toBe(4500)
})

test('toAtm', () => {
	expect(toAtm(45)).toBeCloseTo(0.044411547, 9)
})

test('conversions round-trip', () => {
	expect(toPascal(pascal(123.4))).toBeCloseTo(123.4, 9)
	expect(toAtm(atm(2.5))).toBeCloseTo(2.5, 9)
})

test('pressureFrom returns standard pressure at sea level', () => {
	expect(pressureFrom(meter(0), 15)).toBeCloseTo(ONE_ATM, 12)
})

test('pressureFrom is continuous at the tropopause boundary', () => {
	const below = pressureFrom(meter(10999.999), 15)
	const at = pressureFrom(meter(11000), 15)
	const above = pressureFrom(meter(11000.001), 15)

	expect(below).toBeCloseTo(at, 3)
	expect(above).toBeCloseTo(at, 3)
})
