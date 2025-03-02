import { expect, test } from 'bun:test'
import { binarySearch } from '../src/helper'

test('binarySearch', () => {
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
