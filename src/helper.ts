import type { NumberArray } from './math'

export interface BinarySearchOptions {
	from?: number
	to?: number
	positive?: boolean
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
