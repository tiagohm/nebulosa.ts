import { expect, test } from 'bun:test'
import { atm, pascal, toAtm, toPascal } from '../../../src/math/units/pressure'

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
