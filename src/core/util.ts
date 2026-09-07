import type { NumberArray } from '../math/numerical/math'

// General collection and error utilities: binary search over sorted numeric arrays or arbitrary
// elements, numeric/bigint comparators, and exception-to-text conversion. Searches preserve inputs
// and return either a matching index or the documented insertion-index encoding.

// Options controlling the search window and miss behavior of the binary-search helpers.
export interface BinarySearchOptions {
	// Inclusive lower bound of the search range; defaults to 0.
	from?: number
	// Exclusive upper bound of the search range; defaults to the array length.
	to?: number
	// When true, a miss returns the insertion index instead of the negative encoding -(insertion + 1).
	positive?: boolean
}

// Binary-searches the ascending-sorted range [from, to) of `a` for `key`.
// On a hit, returns the matching index. On a miss, returns the insertion index when `positive` is set,
// otherwise the standard negative encoding -(insertion + 1). Requires the range to be sorted ascending.
export function binarySearch(a: Readonly<NumberArray>, key: number, { from = 0, to = a.length, positive }: BinarySearchOptions = {}) {
	let right = to - 1

	while (from <= right) {
		const index = from + ((right - from) >>> 1)
		const value = a[index]

		if (value < key) {
			from = index + 1
		} else if (value > key || Number.isNaN(value)) {
			right = index - 1
		} else {
			return index
		}
	}

	return positive ? from : -(from + 1)
}

// Comparator returning <0 when the target ordered before `value`, >0 when after, and 0 on a match.
export type BinarySearchComparator<T> = (value: T) => number

// Binary-searches the range [from, to) of `a` using `comparator` to locate the target element.
// The array must be ordered consistently with the comparator. Miss behavior matches `binarySearch`:
// the insertion index when `positive` is set, otherwise -(insertion + 1).
export function binarySearchWithComparator<T>(a: readonly T[], comparator: BinarySearchComparator<T>, { from = 0, to = a.length, positive }: BinarySearchOptions = {}) {
	let right = to - 1

	while (from <= right) {
		const index = from + ((right - from) >>> 1)
		const cmp = comparator(a[index])

		if (cmp < 0) {
			from = index + 1
		} else if (cmp > 0 || Number.isNaN(cmp)) {
			right = index - 1
		} else {
			return index
		}
	}

	return positive ? from : -(from + 1)
}

// Array.sort comparator ordering numbers or bigints ascending.
export function NumberComparator<T extends number | bigint>(left: T, right: T) {
	return left < right ? -1 : left > right ? 1 : 0
}

// Array.sort comparator ordering numbers or bigints descending.
export function NumberComparatorDescending<T extends number | bigint>(left: T, right: T) {
	return left < right ? 1 : left > right ? -1 : 0
}

// Converts an unknown exception to diagnostic text.
export function errorMessage(error: unknown) {
	if (Error.isError(error)) return error.message
	if (typeof error === 'string') return error
	if (typeof error === 'symbol') return error.description ?? 'Unknown error'

	try {
		return String(error)
	} catch (e) {
		// console.error('failed to convert error into text', e)
		return 'Unknown error'
	}
}
