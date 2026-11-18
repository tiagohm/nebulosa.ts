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
	const values = new Float64Array([7, 2, 5, 2, 9, 1, Number.POSITIVE_INFINITY, 100])
	expect(quickSelect(values, 7, 3)).toBe(5)
	expect(values[7]).toBe(100)
	for (let index = 0; index < 3; index++) expect(values[index]).toBeLessThanOrEqual(5)
	for (let index = 4; index < 7; index++) expect(values[index]).toBeGreaterThanOrEqual(5)
	expect(quickSelect(values, 7, 6)).toBe(Number.POSITIVE_INFINITY)
	expect(() => quickSelect(values, 0, 0)).toThrow(RangeError)
	expect(() => quickSelect(values, 7, 7)).toThrow(RangeError)
})

test('quick select partitions every rank of random, tied, and constant prefixes', () => {
	let seed = 12345
	const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

	for (const count of [1, 2, 3, 8, 9, 10, 31, 1000, 1001]) {
		for (const kind of ['random', 'tied', 'constant'] as const) {
			const source = Float64Array.from({ length: count }, () => (kind === 'random' ? random() - 0.5 : kind === 'tied' ? Math.round(random() * 4) : 0.25))
			const sorted = source.toSorted()

			for (const k of [0, count >>> 1, count - 1]) {
				const values = source.slice()
				expect(quickSelect(values, count, k)).toBe(sorted[k])
				for (let index = 0; index < k; index++) expect(values[index]).toBeLessThanOrEqual(values[k])
				for (let index = k + 1; index < count; index++) expect(values[index]).toBeGreaterThanOrEqual(values[k])
			}
		}
	}
})

test('quick select terminates on a prefix with NaN', () => {
	const values = new Float64Array([3, Number.NaN, 1, Number.NaN, 2, 7])
	for (let k = 0; k < 5; k++) quickSelect(values, 5, k)
	expect(values[5]).toBe(7)
})
