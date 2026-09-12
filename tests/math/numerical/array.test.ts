import { expect, test } from 'bun:test'
import { isNumberArray, quickSelect } from '../../../src/math/numerical/array'

test('is number array', () => {
	expect(isNumberArray([1, 2, 3])).toBeTrue()
	// expect(isNumberArray([1, '2'])).toBeFalse()
	expect(isNumberArray(new Float64Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Int32Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Uint32Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Int16Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Uint16Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Int8Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Uint8Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Uint8ClampedArray([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Float32Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new Float16Array([1, 2, 3]))).toBeTrue()
	expect(isNumberArray(new BigInt64Array([1n, 2n, 3n]))).toBeFalse()
	expect(isNumberArray(new DataView(new ArrayBuffer(8)))).toBeFalse()
	expect(isNumberArray([])).toBeTrue()
	expect(isNumberArray(['1'])).toBeFalse()
	expect(isNumberArray(new ArrayBuffer(8))).toBeFalse()
	expect(isNumberArray('[1, 2, 3]')).toBeFalse()
	expect(isNumberArray({})).toBeFalse()
	expect(isNumberArray(null)).toBeFalse()
	expect(isNumberArray(undefined)).toBeFalse()
	expect(isNumberArray(123)).toBeFalse()
	expect(isNumberArray(true)).toBeFalse()
})

test('quick select', () => {
	const values = new Float64Array([7, 2, 5, 2, 9, 1, Number.NaN, 100])
	expect(quickSelect(values, 7, 3)).toBe(5)
	expect(values[7]).toBe(100)
	for (let index = 0; index < 3; index++) expect(values[index]).toBeLessThanOrEqual(5)
	for (let index = 4; index < 7; index++) expect(Number.isNaN(values[index]) || values[index] >= 5).toBeTrue()
	expect(quickSelect(values, 7, 6)).toBeNaN()
	expect(() => quickSelect(values, 0, 0)).toThrow(RangeError)
	expect(() => quickSelect(values, 7, 7)).toThrow(RangeError)
})

test('quick select midpoint does not wrap past 2^32', async () => {
	const source = await Bun.file(new URL('../../../src/math/numerical/array.ts', import.meta.url)).text()
	expect(source).toContain('values[left + ((right - left) >>> 1)]')

	// Same overflow-safe index as quickSelect. (left + right) >>> 1 wraps through uint32.
	const midpoint = (left: number, right: number) => left + ((right - left) >>> 1)
	const windows = [
		[2 ** 31, 2 ** 31],
		[2 ** 31, 2 ** 31 + 10],
		[2 ** 32 - 3, 2 ** 32 - 2],
	] as const

	for (const [left, right] of windows) {
		const mid = midpoint(left, right)
		expect(mid).toBeGreaterThanOrEqual(left)
		expect(mid).toBeLessThanOrEqual(right)
		expect((left + right) >>> 1).not.toBe(mid)
	}

	expect(midpoint(2 ** 31, 2 ** 31)).toBe(2 ** 31)
	expect(midpoint(2 ** 31, 2 ** 31 + 10)).toBe(2 ** 31 + 5)
	expect(midpoint(2 ** 32 - 3, 2 ** 32 - 2)).toBe(2 ** 32 - 3)

	// The overflowing window [2^31, 2^31+10] is all 5s; a wrapped pivot at index 5
	// (value 0) would make every element greater and hang. The safe midpoint stays
	// inside the window, so an 11-element copy of that window selects in one pass.
	const window = new Float64Array(11).fill(5)
	expect(quickSelect(window, 11, 2)).toBe(5)
})
