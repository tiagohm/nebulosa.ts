import type { NumberArray } from './math'

// Numeric-array representation detection and order-statistic selection for plain arrays and typed
// arrays. Detection preserves inputs; selection rearranges a prefix in place without scratch buffers
// and leaves its suffix untouched. Selection ranks are zero-based, with NaN ordered last.

// Identifies numeric typed arrays or plain arrays in unknown input a without mutation or allocation.
// Plain arrays are assumed homogeneous: only the first element is checked, and empty arrays match.
export function isNumberArray(a: unknown): a is NumberArray {
	if (Array.isArray(a)) return a.length === 0 || typeof a[0] === 'number'
	return a instanceof Float64Array || a instanceof Float32Array || a instanceof Float16Array || a instanceof Int32Array || a instanceof Uint32Array || a instanceof Int16Array || a instanceof Uint16Array || a instanceof Int8Array || a instanceof Uint8Array || a instanceof Uint8ClampedArray
}

// Selects the kth value from the mutable prefix [0, count) in ascending numeric order. The function
// rearranges that prefix in place, leaves its suffix untouched, and orders NaN after numeric values.
// count must be an integer in [1, values.length], and k a zero-based integer rank in [0, count).
// Invalid prefixes or ranks throw RangeError; selection allocates no scratch buffer.
export function quickSelect(values: NumberArray, count: number, k: number): number {
	if (!Number.isInteger(count) || !(count > 0) || count > values.length) throw new RangeError('count must identify a non-empty prefix')
	if (!Number.isInteger(k) || !(k >= 0) || !(k < count)) throw new RangeError('k must identify an entry inside the selected prefix')

	let left = 0
	let right = count - 1

	while (left < right) {
		// (left + right) >>> 1 wraps past 2^32 and can hang the 3-way partition.
		const pivot = values[left + ((right - left) >>> 1)]
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
