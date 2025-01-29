import { expect, test } from 'bun:test'
import { PI, TAU } from './constants'
import { floorDiv, pmod, roundToNearestWholeNumber } from './math'

test('pmod', () => {
	expect(pmod(3.16, PI)).toBe(0.018407346410207026)
	expect(pmod(2.45, PI)).toBe(2.45)
	expect(pmod(-0.018407346410207026, PI)).toBe(3.123185307179586)
	expect(pmod(7.97, TAU)).toBe(1.6868146928204135)
	expect(pmod(5.94, TAU)).toBe(5.94)
	expect(pmod(-1.6868146928204135, TAU)).toBe(4.596370614359173)
})

test('floorDiv', () => {
	expect(floorDiv(5, 3)).toBe(1)
	expect(floorDiv(-5, 3)).toBe(-2)
	expect(floorDiv(5, -3)).toBe(-2)
	expect(floorDiv(-5, -3)).toBe(1)
	// exact divisors, no remainders
	expect(floorDiv(6, 3)).toBe(2)
	expect(floorDiv(-6, 3)).toBe(-2)
	expect(floorDiv(6, -3)).toBe(-2)
	expect(floorDiv(-6, -3)).toBe(2)
})

test('roundToNearestWholeNumber', () => {
	expect(roundToNearestWholeNumber(0.6)).toBe(1)
	expect(roundToNearestWholeNumber(0.5)).toBe(1)
	expect(roundToNearestWholeNumber(0.4)).toBe(0)
	expect(roundToNearestWholeNumber(0.1)).toBe(0)
	expect(roundToNearestWholeNumber(0)).toBe(0)
	expect(roundToNearestWholeNumber(-0.1)).toBe(0)
	expect(roundToNearestWholeNumber(-0.4)).toBe(0)
	expect(roundToNearestWholeNumber(-0.5)).toBe(-1)
	expect(roundToNearestWholeNumber(-0.6)).toBe(-1)
})
