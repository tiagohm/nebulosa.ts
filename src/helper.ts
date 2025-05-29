import type { NumberArray } from './math'

export interface BinarySearchOptions {
	from?: number
	to?: number
	positive?: boolean
}

export function isNumberArray(array: unknown): array is NumberArray {
	return Array.isArray(array) || ArrayBuffer.isView(array)
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
export function binarySearch(input: NumberArray, key: number, options?: BinarySearchOptions) {
	let a = Math.trunc(options?.from ?? 0)
	let b = Math.trunc(options?.to ?? input.length) - 1

	while (a <= b) {
		const index = (a + b) >>> 1
		const value = input[index]

		if (value < key) {
			a = index + 1
		} else if (value > key) {
			b = index - 1
		} else if (value === key) {
			return index
		} else if (value < key) {
			a = index + 1
		} else {
			b = index - 1
		}
	}

	return options?.positive ? a : -(a + 1)
}
