import type { NumberArray } from './math'

// Numeric-array representation detection and order-statistic selection for plain arrays and typed
// arrays. Detection preserves inputs; selection rearranges a prefix in place without scratch buffers
// and leaves its suffix untouched. Selection ranks are zero-based; the selected prefix must hold no NaN.

// Identifies numeric typed arrays or plain arrays in unknown input a without mutation or allocation.
// Plain arrays are assumed homogeneous: only the first element is checked, and empty arrays match.
export function isNumberArray(a: unknown): a is NumberArray {
	if (Array.isArray(a)) return a.length === 0 || typeof a[0] === 'number'
	return a instanceof Float64Array || a instanceof Float32Array || a instanceof Float16Array || a instanceof Int32Array || a instanceof Uint32Array || a instanceof Int16Array || a instanceof Uint16Array || a instanceof Int8Array || a instanceof Uint8Array || a instanceof Uint8ClampedArray
}

// Selects the kth value from the mutable prefix [0, count) in ascending numeric order, by Wirth's
// selection: Hoare partitions around the value at rank k, narrowing to the side that holds k. The
// function rearranges that prefix in place and leaves its suffix untouched; on return every value
// before k is at most the kth and every value after it at least the kth. count must be an integer in
// [1, values.length], and k a zero-based integer rank in [0, count). Invalid prefixes or ranks throw
// RangeError; selection allocates no scratch buffer. The prefix must hold no NaN, which callers filter:
// with NaN the call still terminates within the prefix, but its result and ordering are unspecified.
// Infinities are ordered normally, and runs of equal values cost no extra passes.
export function quickSelect(values: NumberArray, count: number, k: number): number {
	if (!Number.isInteger(count) || !(count > 0) || count > values.length) throw new RangeError('count must identify a non-empty prefix')
	if (!Number.isInteger(k) || !(k >= 0) || !(k < count)) throw new RangeError('k must identify an entry inside the selected prefix')

	let left = 0
	let right = count - 1

	while (left < right) {
		const pivot = values[k]
		let i = left
		let j = right

		// The value at rank k stops both scans, so they never leave [left, right].
		do {
			while (values[i] < pivot) i++
			while (pivot < values[j]) j--

			if (i <= j) {
				const swap = values[i]
				values[i] = values[j]
				values[j] = swap
				i++
				j--
			}
		} while (i <= j)

		if (j < k) left = i
		if (k < i) right = j
	}

	return values[k]
}
