import type { NumberArray } from './math'

export interface BinarySearchOptions {
	from?: number
	to?: number
	positive?: boolean
}

// Checks if the input is a number array.
export function isNumberArray(array: unknown): array is NumberArray {
	return (Array.isArray(array) && (!array.length || typeof array[0] === 'number')) || ArrayBuffer.isView(array)
}

// Finds the minimum value in an array of numbers.
// If the array is empty, it returns [NaN, -1].
export function minOf(array: Readonly<NumberArray>): readonly [number, number] {
	if (array.length === 0) return [NaN, -1]
	if (array.length === 1) return [array[0], 0]

	const ret: [number, number] = [Number.MAX_VALUE, -1]

	for (let i = 0; i < array.length; i++) {
		if (array[i] < ret[0]) {
			ret[0] = array[i]
			ret[1] = i
		}
	}

	return ret
}

// Finds the maximum value in an array of numbers.
// If the array is empty, it returns [NaN, -1].
export function maxOf(array: Readonly<NumberArray>): readonly [number, number] {
	if (array.length === 0) return [NaN, -1]
	if (array.length === 1) return [array[0], 0]

	const ret: [number, number] = [Number.MIN_VALUE, -1]

	for (let i = 0; i < array.length; i++) {
		if (array[i] > ret[0]) {
			ret[0] = array[i]
			ret[1] = i
		}
	}

	return ret
}

// Searches in the specified input using the range [from, to) for the specified key.
export function binarySearch(input: NumberArray, key: number, { from = 0, to = input.length, positive }: BinarySearchOptions = {}) {
	to--

	while (from <= to) {
		const index = (from + to) >>> 1
		const value = input[index]

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

// Computes the angular size of pixel in arcsec given the `focalLength` in mm and `pixelSize` in µm.
export function angularSizeOfPixel(focalLength: number, pixelSize: number) {
	return focalLength <= 0 ? 0 : (pixelSize / focalLength) * 206.265
}
