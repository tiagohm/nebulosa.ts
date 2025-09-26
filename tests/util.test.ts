import { expect, test } from 'bun:test'
import { angularSizeOfPixel, binarySearch, isNumberArray, maxOf, meanOf, minOf } from '../src/util'

test('is number array', () => {
	expect(isNumberArray([1, 2, 3])).toBe(true)
	expect(isNumberArray(new Float64Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Int32Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Uint32Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Int16Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Uint16Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Int8Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Uint8Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Uint8ClampedArray([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Float32Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray(new Float16Array([1, 2, 3]))).toBe(true)
	expect(isNumberArray([])).toBe(true)
	expect(isNumberArray(['1'])).toBe(false)
	expect(isNumberArray(new ArrayBuffer(8))).toBe(false)
	expect(isNumberArray('[1, 2, 3]')).toBe(false)
	expect(isNumberArray({})).toBe(false)
	expect(isNumberArray(null)).toBe(false)
	expect(isNumberArray(undefined)).toBe(false)
	expect(isNumberArray(123)).toBe(false)
	expect(isNumberArray(true)).toBe(false)
})

test('min of', () => {
	expect(minOf([1, 2, 3])).toEqual([1, 0])
	expect(minOf([3, 2, 1])).toEqual([1, 2])
	expect(minOf([2, 3, 1])).toEqual([1, 2])
	expect(minOf([1])).toEqual([1, 0])
	expect(minOf([])).toEqual([NaN, -1])
	expect(minOf([NaN, NaN, NaN])).toEqual([Number.MAX_VALUE, -1])
	expect(minOf([1, 2, NaN])).toEqual([1, 0])
	expect(minOf([NaN, 2, 1])).toEqual([1, 2])
})

test('max of', () => {
	expect(maxOf([1, 2, 3])).toEqual([3, 2])
	expect(maxOf([3, 2, 1])).toEqual([3, 0])
	expect(maxOf([2, 3, 1])).toEqual([3, 1])
	expect(maxOf([1])).toEqual([1, 0])
	expect(maxOf([])).toEqual([NaN, -1])
	expect(maxOf([NaN, NaN, NaN])).toEqual([Number.MIN_VALUE, -1])
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

test('angular size of pixel', () => {
	expect(angularSizeOfPixel(1000, 3.75)).toBeCloseTo(0.773, 3)
})
