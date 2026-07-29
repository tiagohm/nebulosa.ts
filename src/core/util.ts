import type { NumberArray } from '../math/numerical/math'

// Generic numeric-array utilities: array-type detection, single-pass reducers (min/max/mean/median/
// standard deviation/percentile/RMS), binary search variants, and numeric comparators. Reducers
// operate on plain arrays or typed arrays; functions documented as requiring a sorted input must be
// given one. Most reducers return NaN for empty input to stay composable.

// Options controlling the search window and miss behavior of the binary-search helpers.
export interface BinarySearchOptions {
	// Inclusive lower bound of the search range; defaults to 0.
	from?: number
	// Exclusive upper bound of the search range; defaults to the array length.
	to?: number
	// When true, a miss returns the insertion index instead of the negative encoding -(insertion + 1).
	positive?: boolean
}

// Scale factor 1/Φ⁻¹(3/4) that converts a median absolute deviation into a consistent estimator of
// the standard deviation for normally distributed data.
export const STANDARD_DEVIATION_SCALE = 1.482602218505602

// Checks if the input is a number array.
export function isNumberArray(a: unknown): a is NumberArray {
	if (Array.isArray(a)) return a.length === 0 || typeof a[0] === 'number'
	return a instanceof Float64Array || a instanceof Float32Array || a instanceof Float16Array || a instanceof Int32Array || a instanceof Uint32Array || a instanceof Int16Array || a instanceof Uint16Array || a instanceof Int8Array || a instanceof Uint8Array || a instanceof Uint8ClampedArray
}

// Selects the kth value from the mutable prefix [0, count) in ascending numeric order. The function
// rearranges that prefix in place, leaves its suffix untouched, and orders NaN after numeric values.
export function quickSelect(values: NumberArray, count: number, k: number): number {
	if (!Number.isInteger(count) || count <= 0 || count > values.length) throw new RangeError('count must identify a non-empty prefix')
	if (!Number.isInteger(k) || k < 0 || k >= count) throw new RangeError('k must identify an entry inside the selected prefix')

	let left = 0
	let right = count - 1

	while (left < right) {
		const pivot = values[(left + right) >>> 1]
		const pivotIsNaN = Number.isNaN(pivot)
		let lower = left
		let index = left
		let upper = right

		while (index <= upper) {
			const value = values[index]
			const valueIsNaN = Number.isNaN(value)
			const comparison = valueIsNaN ? (pivotIsNaN ? 0 : 1) : pivotIsNaN ? -1 : value < pivot ? -1 : value > pivot ? 1 : 0

			if (comparison < 0) {
				values[index] = values[lower]
				values[lower] = value
				lower++
				index++
			} else if (comparison > 0) {
				values[index] = values[upper]
				values[upper] = value
				upper--
			} else {
				index++
			}
		}

		if (k < lower) right = lower - 1
		else if (k > upper) left = upper + 1
		else return values[k]
	}

	return values[left]
}

// Computes the median of the mutable prefix [0, count) by selection instead of a full sort. The
// prefix is rearranged in place, the suffix is preserved, and an empty prefix returns NaN.
export function medianBySelectionOf(values: NumberArray, count = values.length): number {
	if (!Number.isInteger(count) || count < 0 || count > values.length) throw new RangeError('count must identify a valid prefix')
	if (count === 0) return Number.NaN

	const middle = count >>> 1
	const upper = quickSelect(values, count, middle)
	if ((count & 1) === 1) return upper

	let lower = values[0]
	for (let index = 1; index < middle; index++) {
		const value = values[index]
		if (value > lower) lower = value
	}
	return lower * 0.5 + upper * 0.5
}

// Finds the minimum value and its index in a numeric array, returned as [value, index].
// NaN entries are skipped. If the array is empty (or all NaN), it returns [NaN, -1].
export function minOf(a: Readonly<NumberArray>): readonly [number, number] {
	const n = a.length
	if (n === 0) return [Number.NaN, -1]

	let value = a[0]
	let index = Number.isNaN(value) ? -1 : 0

	for (let i = 1; i < n; i++) {
		const current = a[i]

		if (current < value || (index < 0 && !Number.isNaN(current))) {
			value = current
			index = i
		}
	}

	return index < 0 ? [Number.NaN, -1] : [value, index]
}

// Finds the maximum value and its index in a numeric array, returned as [value, index].
// NaN entries are skipped. If the array is empty (or all NaN), it returns [NaN, -1].
export function maxOf(a: Readonly<NumberArray>): readonly [number, number] {
	const n = a.length
	if (n === 0) return [Number.NaN, -1]

	let value = a[0]
	let index = Number.isNaN(value) ? -1 : 0

	for (let i = 1; i < n; i++) {
		const current = a[i]

		if (current > value || (index < 0 && !Number.isNaN(current))) {
			value = current
			index = i
		}
	}

	return index < 0 ? [Number.NaN, -1] : [value, index]
}

// Computes the mean value of an numeric array.
// If the array is empty, it returns NaN.
// Uses Neumaier compensated summation so the mean stays accurate for large or wide-ranging inputs.
export function meanOf(a: Readonly<NumberArray>) {
	const n = a.length
	if (n === 0) return Number.NaN
	if (n === 1) return a[0]

	let sum = 0
	let compensation = 0

	for (let i = 0; i < n; i++) {
		const value = a[i]
		const t = sum + value
		compensation += Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum
		sum = t
	}

	return (sum + compensation) / n
}

// Computes the median value of a sorted numeric array. Input must be ascending-sorted.
// `count` optionally restricts the median to the first `count` elements; returns NaN when count is 0.
export function medianOf(a: Readonly<NumberArray>, count: number = a.length) {
	if (count === 0) return Number.NaN
	else if (count === 1) return a[0]
	else if (count === 2) return (a[0] + a[1]) * 0.5
	else if (count === 3) return a[1]

	const mid = count >>> 1
	return count % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) * 0.5
}

// Computes the median absolute deviation of a numeric array about a given `median`.
// `normalized` scales the result by STANDARD_DEVIATION_SCALE to estimate the standard deviation.
// `count` restricts the computation to the first `count` elements. Allocates a temporary buffer that is sorted in place.
export function medianAbsoluteDeviationOf(a: Readonly<NumberArray>, median: number, normalized: boolean, count: number = a.length) {
	const abs = new Float64Array(count)
	for (let i = 0; i < count; i++) abs[i] = Math.abs(a[i] - median)
	const mad = medianOf(abs.sort())
	return normalized ? STANDARD_DEVIATION_SCALE * mad : mad
}

// Computes the population standard deviation of the first `count` values using a single-pass recurrence.
export function standardDeviationOf(a: Readonly<NumberArray>, count: number = a.length) {
	if (count === 0) return Number.NaN

	let mean = 0
	let sumSquared = 0

	for (let i = 0; i < count; i++) {
		const value = a[i]
		const delta = value - mean
		mean += delta / (i + 1)
		sumSquared += delta * (value - mean)
	}

	return Math.sqrt(sumSquared / count)
}

// Computes a percentile from an ascending-sorted numeric array using linear interpolation between ranks.
// `percentile` is a fraction in [0, 1]; values outside that range are clamped to the first/last element.
// Returns NaN for an empty array.
export function percentileOf(values: Readonly<NumberArray>, percentile: number) {
	const n = values.length
	if (n === 0) return Number.NaN
	if (n === 1 || percentile <= 0) return values[0]
	if (percentile >= 1) return values[n - 1]

	const index = percentile * (n - 1)
	const lower = Math.floor(index)
	const upper = Math.ceil(index)
	const t = index - lower
	return values[lower] + (values[upper] - values[lower]) * t
}

// Computes the root-mean-square of a numeric array.
// If the array is empty, it returns NaN, consistent with the other reducers.
export function rmsOf(values: Readonly<NumberArray>) {
	const n = values.length
	if (n === 0) return Number.NaN

	let sumSquares = 0

	for (let i = 0; i < n; i++) {
		const value = values[i]
		sumSquares += value * value
	}

	return Math.sqrt(sumSquares / n)
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
