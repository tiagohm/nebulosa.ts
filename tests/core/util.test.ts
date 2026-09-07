import { expect, test } from 'bun:test'
import { binarySearch, binarySearchWithComparator, NumberComparator, NumberComparatorDescending } from '../../src/core/util'

test('descending comparator is the reverse of the ascending comparator', () => {
	for (const [a, b] of [
		[1, 2],
		[2, 1],
		[3, 3],
	] as const) {
		// Descending order is the ascending comparator with swapped arguments.
		expect(Math.sign(NumberComparatorDescending(a, b))).toBe(Math.sign(NumberComparator(b, a)))
	}
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
	expect(binarySearch([Number.NaN, Number.NaN, Number.NaN], 3)).toBe(-1)
})

test('binary search with comparator', () => {
	// oxlint-disable-next-line unicorn/consistent-function-scoping
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

test('number comparator', () => {
	expect([3, 1, 2].sort(NumberComparator)).toEqual([1, 2, 3])
	expect([3, 1, 2].sort(NumberComparatorDescending)).toEqual([3, 2, 1])
	expect([3n, 1n, 2n].sort(NumberComparator)).toEqual([1n, 2n, 3n])
	expect([3n, 1n, 2n].sort(NumberComparatorDescending)).toEqual([3n, 2n, 1n])
})
