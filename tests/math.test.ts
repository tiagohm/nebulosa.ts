import { expect, test } from 'bun:test'
import { PI, TAU } from '../src/constants'
import { amod, divmod, floorDiv, fract, inverseLerp, isNearlyEqual, pmod, remap, roundToNearestWholeNumber, roundToNthDecimal, signed8, signed16, smoothstep, twoProduct, twoSum } from '../src/math'

test('pmod', () => {
	expect(pmod(3.16, PI)).toBeCloseTo(0.018407346410207026, 15)
	expect(pmod(2.45, PI)).toBeCloseTo(2.45, 15)
	expect(pmod(-0.018407346410207026, PI)).toBeCloseTo(3.123185307179586, 15)
	expect(pmod(7.97, TAU)).toBeCloseTo(1.6868146928204135, 15)
	expect(pmod(5.94, TAU)).toBeCloseTo(5.94, 15)
	expect(pmod(-1.6868146928204135, TAU)).toBeCloseTo(4.596370614359173, 15)
	expect(pmod(-5, -3)).toBe(1)
	expect(Object.is(pmod(-6, -3), 0)).toBeTrue()
})

test('amod', () => {
	expect(amod(3.16, PI)).toBeCloseTo(0.018407346410207026, 15)
	expect(amod(-0.018407346410207026, PI)).toBeCloseTo(3.123185307179586, 15)
	expect(amod(0, PI)).toBeCloseTo(PI, 15)
	expect(amod(3, -3)).toBe(3)
	expect(amod(-6, -3)).toBe(3)
})

test('divmod', () => {
	expect(divmod(5, 3)).toEqual([1, 2])
	expect(divmod(-5, 3)).toEqual([-2, 1])
	expect(divmod(5, -3)).toEqual([-1, 2])
	expect(divmod(-5, -3)).toEqual([2, 1])

	const [quotient, remainder] = divmod(3.16, PI)
	expect(quotient).toBe(1)
	expect(remainder).toBeCloseTo(0.018407346410207026, 15)
	expect(quotient * PI + remainder).toBeCloseTo(3.16, 15)
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

test('roundToNthDecimal', () => {
	expect(roundToNthDecimal(1.005, 2)).toBeCloseTo(1.01, 15)
	expect(roundToNthDecimal(-1.005, 2)).toBeCloseTo(-1.01, 15)
	expect(roundToNthDecimal(12.3456, 3)).toBeCloseTo(12.346, 15)
	expect(roundToNthDecimal(-12.3456, 3)).toBeCloseTo(-12.346, 15)
	expect(roundToNthDecimal(149, -2)).toBe(100)
	expect(roundToNthDecimal(-149, -2)).toBe(-100)
	expect(roundToNthDecimal(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY)
})

test('signed 8-bit', () => {
	expect(signed8(1)).toBe(1)
	expect(signed8(-1)).toBe(-1)
	expect(signed8(255)).toBe(-1)
	expect(signed8(256)).toBe(0)
	expect(signed8(257)).toBe(1)
	expect(signed8(127)).toBe(127)
	expect(signed8(128)).toBe(-128)
	expect(signed8(129)).toBe(-127)
})

test('signed 16-bit', () => {
	expect(signed16(1)).toBe(1)
	expect(signed16(-1)).toBe(-1)
	expect(signed16(255)).toBe(255)
	expect(signed16(65535)).toBe(-1)
	expect(signed16(65536)).toBe(0)
	expect(signed16(65537)).toBe(1)
	expect(signed16(32767)).toBe(32767)
	expect(signed16(32768)).toBe(-32768)
	expect(signed16(32769)).toBe(-32767)
})

test('twoSum', () => {
	const [sum, err] = twoSum(1e16, 1)

	expect(sum).toBe(1e16)
	expect(err).toBe(1)
})

test('twoProduct', () => {
	const [product, err] = twoProduct(134217729, 134217729)

	expect(product).toBe(18014398777917440)
	expect(err).toBe(1)
})

test('isNearlyEqual', () => {
	expect(isNearlyEqual(1, 1 + Number.EPSILON)).toBeTrue()
	expect(isNearlyEqual(1, 1.0000001)).toBeFalse()
	expect(isNearlyEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBeTrue()
	expect(isNearlyEqual(Number.NaN, Number.NaN)).toBeFalse()
})

test('inverseLerp', () => {
	expect(inverseLerp(10, 20, 15)).toBeCloseTo(0.5, 15)
	expect(inverseLerp(20, 10, 15)).toBeCloseTo(0.5, 15)
	expect(inverseLerp(5, 5, 42)).toBe(0)
})

test('remap', () => {
	expect(remap(0.25, 0, 1, 20, 40)).toBeCloseTo(25, 15)
	expect(remap(15, 10, 20, 0, 1)).toBeCloseTo(0.5, 15)
	expect(remap(5, 5, 5, 10, 20)).toBe(10)
})

test('fract', () => {
	expect(fract(12.75)).toBeCloseTo(0.75, 15)
	expect(fract(-12.75)).toBeCloseTo(0.25, 15)
	expect(fract(4)).toBe(0)
})

test('smoothstep', () => {
	expect(smoothstep(0, 1, -0.25)).toBe(0)
	expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 15)
	expect(smoothstep(0, 1, 1.25)).toBe(1)
	expect(smoothstep(2, 2, 5)).toBe(0)
})
