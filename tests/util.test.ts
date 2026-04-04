import { expect, test } from 'bun:test'
import { angularSizeOfPixel, binarySearch, binarySearchWithComparator, isNumberArray, maxOf, meanOf, medianOf, minOf, NumberComparator, NumberComparatorDescending, percentileOf, standardDeviationOf } from '../src/util'

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

test('min of', () => {
	expect(minOf([1, 2, 3])).toEqual([1, 0])
	expect(minOf([3, 2, 1])).toEqual([1, 2])
	expect(minOf([2, 3, 1])).toEqual([1, 2])
	expect(minOf([1])).toEqual([1, 0])
	expect(minOf([])).toEqual([NaN, -1])
	expect(minOf([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY])).toEqual([Number.POSITIVE_INFINITY, 0])
	expect(minOf([NaN, NaN, NaN])).toEqual([NaN, -1])
	expect(minOf([1, 2, NaN])).toEqual([1, 0])
	expect(minOf([NaN, 2, 1])).toEqual([1, 2])
})

test('max of', () => {
	expect(maxOf([1, 2, 3])).toEqual([3, 2])
	expect(maxOf([3, 2, 1])).toEqual([3, 0])
	expect(maxOf([2, 3, 1])).toEqual([3, 1])
	expect(maxOf([-3, -2, -7])).toEqual([-2, 1])
	expect(maxOf([1])).toEqual([1, 0])
	expect(maxOf([])).toEqual([NaN, -1])
	expect(maxOf([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY])).toEqual([Number.NEGATIVE_INFINITY, 0])
	expect(maxOf([NaN, NaN, NaN])).toEqual([NaN, -1])
	expect(maxOf([1, 2, NaN])).toEqual([2, 1])
	expect(maxOf([NaN, 2, 1])).toEqual([2, 1])
})

test('mean of', () => {
	expect(meanOf([1, 2, 3])).toBe(2)
	expect(meanOf([3, 2, 1])).toBe(2)
	expect(meanOf([2, 3, 1])).toBe(2)
	expect(meanOf([1, 2, 3, 4])).toBe(2.5)
	expect(meanOf([1])).toBe(1)
	expect(meanOf([])).toBeNaN()
})

test('median of', () => {
	expect(medianOf([1])).toBe(1)
	expect(medianOf([1, 2])).toBe(1.5)
	expect(medianOf([1, 2, 3])).toBe(2)
	expect(medianOf([1, 2, 3, 4])).toBe(2.5)
	expect(medianOf([])).toBeNaN()
})

test('standard deviation of', () => {
	expect(standardDeviationOf(new Float64Array([2, 2, 2, 2]))).toBe(0)
	expect(standardDeviationOf(new Float64Array([2, 4, 4, 4, 5, 5, 7, 9]))).toBe(2)
	expect(standardDeviationOf(new Float64Array([1e12 + 1, 1e12 + 2, 1e12 + 3]))).toBeCloseTo(Math.sqrt(2 / 3), 12)
	expect(standardDeviationOf(new Float64Array())).toBeNaN()
})

test('percentile of', () => {
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 0)).toBe(10)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 0.25)).toBe(17.5)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 0.5)).toBe(25)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 1)).toBe(40)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), -1)).toBe(10)
	expect(percentileOf(new Float64Array([10, 20, 30, 40]), 2)).toBe(40)
	expect(percentileOf(new Float64Array(), 0.5)).toBeNaN()
})

test('binary search', () => {
	expect(binarySearch([0, 1, 2, 3, 4], 3)).toBe(3)
	expect(binarySearch([0, 1, 2, 3, 4], 3, { from: 2, to: 5 })).toBe(3)
	expect(binarySearch([0, 1, 2, 3, 4], 3, { from: 0, to: 3 })).toBe(-4)
	expect(binarySearch([0, 1, 2, 3, 4], 3, { from: 0, to: 3, positive: true })).toBe(3)
	expect(binarySearch([0, 1, 2, 3, 4], -1, { positive: true })).toBe(0)
	expect(binarySearch([0, 1, 2, 3, 4], 5, { positive: true })).toBe(5)
	expect(binarySearch([0, 1, 2, 3, 4], -1)).toBe(-1)
	expect(binarySearch([0, 1, 2, 3, 4], 5)).toBe(-6)
	expect(binarySearch([0, 1, 2, 3, 4], 0.5)).toBe(-2)
	expect(binarySearch([0, 1, 2, 3, 4], 0.5, { positive: true })).toBe(1)
	expect(binarySearch([NaN, NaN, NaN], 3)).toBe(-1)
})

test('binary search with comparator', () => {
	function comparator(key: number) {
		return (a: number) => a - key
	}

	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(3))).toBe(3)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(3), { from: 2, to: 5 })).toBe(3)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(3), { from: 0, to: 3 })).toBe(-4)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(3), { from: 0, to: 3, positive: true })).toBe(3)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(-1), { positive: true })).toBe(0)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(5), { positive: true })).toBe(5)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(-1))).toBe(-1)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(5))).toBe(-6)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(0.5))).toBe(-2)
	expect(binarySearchWithComparator([0, 1, 2, 3, 4], comparator(0.5), { positive: true })).toBe(1)
	expect(binarySearchWithComparator([Number.NaN, Number.NaN], () => Number.NaN)).toBe(-1)
})

test('angular size of pixel', () => {
	expect(angularSizeOfPixel(1000, 3.75)).toBeCloseTo(0.773, 3)
})

test('number comparator', () => {
	expect([3, 1, 2].sort(NumberComparator)).toEqual([1, 2, 3])
	expect([3, 1, 2].sort(NumberComparatorDescending)).toEqual([3, 2, 1])
	expect([3n, 1n, 2n].sort(NumberComparator)).toEqual([1n, 2n, 3n])
	expect([3n, 1n, 2n].sort(NumberComparatorDescending)).toEqual([3n, 2n, 1n])
})
