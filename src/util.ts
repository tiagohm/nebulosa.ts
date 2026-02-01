import type { NumberArray } from './math'

export interface BinarySearchOptions {
	from?: number
	to?: number
	positive?: boolean
}

// Checks if the input is a number array.
export function isNumberArray(a: unknown): a is NumberArray {
	return (Array.isArray(a) && (!a.length || typeof a[0] === 'number')) || ArrayBuffer.isView(a)
}

// Finds the minimum value  and its index in an array of numeric values.
// If the array is empty, it returns [NaN, -1].
export function minOf(a: Readonly<NumberArray>): readonly [number, number] {
	if (a.length === 0) return [NaN, -1]
	if (a.length === 1) return [a[0], 0]

	const ret: [number, number] = [Number.MAX_VALUE, -1]
	const n = a.length

	for (let i = 0; i < n; i++) {
		if (a[i] < ret[0]) {
			ret[0] = a[i]
			ret[1] = i
		}
	}

	return ret
}

// Finds the maximum value and its index in an array of numeric values.
// If the array is empty, it returns [NaN, -1].
export function maxOf(a: Readonly<NumberArray>): readonly [number, number] {
	if (a.length === 0) return [NaN, -1]
	if (a.length === 1) return [a[0], 0]

	const ret: [number, number] = [Number.MIN_VALUE, -1]
	const n = a.length

	for (let i = 0; i < n; i++) {
		if (a[i] > ret[0]) {
			ret[0] = a[i]
			ret[1] = i
		}
	}

	return ret
}

// Computes the mean value of an array of numeric values.
// If the array is empty, it returns NaN.
export function meanOf(a: Readonly<NumberArray>) {
	if (a.length === 0) return NaN
	if (a.length === 1) return a[0]

	let s = 0
	const n = a.length
	for (let i = 0; i < n; i++) s += a[i]
	return s / a.length
}

// Computes the median value of an sorted array of numeric values.
// If the array is empty, it returns NaN.
export function medianOf(a: Readonly<NumberArray>) {
	if (a.length === 0) return NaN
	else if (a.length === 1) return a[0]
	else if (a.length === 2) return (a[0] + a[1]) / 2
	else if (a.length === 3) return a[1]

	const i = Math.trunc(a.length / 2)

	return a.length % 2 === 1 ? a[i] : (a[i - 1] + a[i]) / 2
}

// Searches in the specified input using the range [from, to) for the specified key.
export function binarySearch(a: Readonly<NumberArray>, key: number, { from = 0, to = a.length, positive }: BinarySearchOptions = {}) {
	to--

	while (from <= to) {
		const index = (from + to) >>> 1
		const value = a[index]

		if (value < key) {
			from = index + 1
		} else if (value > key) {
			to = index - 1
		} else if (value === key) {
			return index
		} else {
			to = index - 1
		}
	}

	return positive ? from : -(from + 1)
}

export type BinarySearchComparator<T> = (value: T) => number

// Searches in the specified input using the range [from, to) by the specified comparator.
export function binarySearchWithComparator<T>(a: readonly T[], comparator: BinarySearchComparator<T>, { from = 0, to = a.length, positive }: BinarySearchOptions = {}) {
	to--

	while (from <= to) {
		const index = (from + to) >>> 1
		const cmp = comparator(a[index])

		if (cmp < 0) {
			from = index + 1
		} else if (cmp > 0) {
			to = index - 1
		} else {
			return index
		}
	}

	return positive ? from : -(from + 1)
}

// Computes the angular size of pixel in arcsec given the `focalLength` in mm and `pixelSize` in µm.
export function angularSizeOfPixel(focalLength: number, pixelSize: number) {
	return focalLength <= 0 ? 0 : (pixelSize / focalLength) * 206.265
}
