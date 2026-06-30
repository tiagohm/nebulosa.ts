import { expect, test } from 'bun:test'
import { PI, TAU } from '../../../src/core/constants'
import { amod, clamp, divmod, floorDiv, fract, inverseLerp, isNearlyEqual, lerp, pmod, remap, roundToNearestWholeNumber, roundToNthDecimal, signed8, signed16, smoothstep, twoProduct, twoSum } from '../../../src/math/numerical/math'

test('clamp', () => {
	expect(clamp(5, 0, 10)).toBe(5)
	expect(clamp(-1, 0, 10)).toBe(0)
	expect(clamp(11, 0, 10)).toBe(10)
	expect(clamp(0, 0, 10)).toBe(0)
	expect(clamp(10, 0, 10)).toBe(10)
})

test('lerp', () => {
	expect(lerp(10, 20, 0)).toBe(10)
	expect(lerp(10, 20, 1)).toBe(20)
	expect(lerp(10, 20, 0.5)).toBeCloseTo(15, 15)
	// inverseLerp is the inverse of lerp.
	expect(inverseLerp(10, 20, lerp(10, 20, 0.25))).toBeCloseTo(0.25, 15)
})

test('pmod', () => {
	expect(pmod(3.16, PI)).toBeCloseTo(0.018407346410207026, 15)
	expect(pmod(2.45, PI)).toBeCloseTo(2.45, 15)
	expect(pmod(-0.018407346410207026, PI)).toBeCloseTo(3.123185307179586, 15)
	expect(pmod(7.97, TAU)).toBeCloseTo(1.6868146928204135, 15)
	expect(pmod(5.94, TAU)).toBeCloseTo(5.94, 15)
	expect(pmod(-1.6868146928204135, TAU)).toBeCloseTo(4.596370614359173, 15)
	expect(pmod(-5, -3)).toBe(1)
	expect(Object.is(pmod(-6, -3), 0)).toBeTrue()
	expect(pmod(-1, 360)).toBe(359)
	expect(pmod(360, 360)).toBe(0)
	expect(pmod(-0, 360)).toBe(0)
})

test('amod', () => {
	expect(amod(3.16, PI)).toBeCloseTo(0.018407346410207026, 15)
	expect(amod(-0.018407346410207026, PI)).toBeCloseTo(3.123185307179586, 15)
	expect(amod(0, PI)).toBeCloseTo(PI, 15)
	expect(amod(3, -3)).toBe(3)
	expect(amod(-6, -3)).toBe(3)
	expect(amod(0, 12)).toBe(12)
	expect(amod(12, 12)).toBe(12)
	expect(amod(13, 12)).toBe(1)
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

	for (const num of [-25, -13, -1, 0, 1, 13, 25]) {
		for (const den of [-12, 12]) {
			const [q, r] = divmod(num, den)
			expect(q * den + r).toBe(num)
			expect(r).toBeGreaterThanOrEqual(0)
			expect(r).toBeLessThan(Math.abs(den))
		}
	}
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
	expect(roundToNthDecimal(1.335, 2)).toBe(1.34)
	expect(roundToNthDecimal(12.3456, 3)).toBeCloseTo(12.346, 15)
	expect(roundToNthDecimal(-12.3456, 3)).toBeCloseTo(-12.346, 15)
	expect(roundToNthDecimal(149, -2)).toBe(100)
	expect(roundToNthDecimal(-149, -2)).toBe(-100)
	expect(roundToNthDecimal(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY)
	expect(roundToNthDecimal(10000000000000000, 0)).toBe(10000000000000000)
	expect(roundToNthDecimal(-10000000000000000, 0)).toBe(-10000000000000000)
	expect(roundToNthDecimal(9007199254740991, 0)).toBe(9007199254740991)

	expect(roundToNthDecimal(1234.56, -1)).toBe(1230)
	expect(roundToNthDecimal(1234.56, -2)).toBe(1200)
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

test('exact arithmetic helpers write into provided output buffers', () => {
	const sum = new Float64Array(2)
	const product = new Float64Array(2)

	expect(twoSum(1e16, 1, sum)).toBe(sum)
	expect(Array.from(sum)).toEqual([1e16, 1])

	expect(twoProduct(134217729, 134217729, product)).toBe(product)
	expect(Array.from(product)).toEqual([18014398777917440, 1])
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
	expect(inverseLerp(0, 10, 5)).toBe(0.5)
	expect(inverseLerp(10, 0, 5)).toBe(0.5)
	expect(inverseLerp(1e9, 1e9 + 1e-4, 1e9 + 5e-5)).toBeCloseTo(0.5)
	expect(inverseLerp(1, 1, 2)).toBe(0)
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
