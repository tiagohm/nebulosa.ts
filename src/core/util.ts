import type { Point } from '../math/numerical/geometry'
import type { NumberArray } from '../math/numerical/math'

// Generic numeric-array utilities: array-type detection, scalar reducers (min/max/mean/median/
// standard deviation/percentile/RMS), a 2D geometric median, binary search, and numeric comparators.
// Reducers operate on plain arrays or typed arrays; functions requiring a sorted input must be
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

// Modified Weiszfeld iterations; every accepted result also passes a convex subgradient criterion.
const GEOMETRIC_MEDIAN_ITERATIONS = 512
// Sum-of-unit-vectors stationarity tolerance per sample, independent of coordinate units.
const GEOMETRIC_MEDIAN_GRADIENT_TOLERANCE = 1e-9
// Bounded backtracking for smooth Newton acceleration; rejected steps fall back to Weiszfeld.
const GEOMETRIC_MEDIAN_LINE_SEARCH_STEPS = 24

// Largest sample count in the common 3x3 local-median window; insertion sort avoids a TypedArray
// subarray/sort call for the per-pixel.
const SMALL_MEDIAN_SORT_LIMIT = 9

// Checks if the input is a number array.
export function isNumberArray(a: unknown): a is NumberArray {
	if (Array.isArray(a)) return a.length === 0 || typeof a[0] === 'number'
	return a instanceof Float64Array || a instanceof Float32Array || a instanceof Float16Array || a instanceof Int32Array || a instanceof Uint32Array || a instanceof Int16Array || a instanceof Uint16Array || a instanceof Int8Array || a instanceof Uint8Array || a instanceof Uint8ClampedArray
}

// Selects the kth value from the mutable prefix [0, count) in ascending numeric order. The function
// rearranges that prefix in place, leaves its suffix untouched, and orders NaN after numeric values.
export function quickSelect(values: NumberArray, count: number, k: number): number {
	if (!Number.isInteger(count) || !(count > 0) || count > values.length) throw new RangeError('count must identify a non-empty prefix')
	if (!Number.isInteger(k) || !(k >= 0) || !(k < count)) throw new RangeError('k must identify an entry inside the selected prefix')

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

// Computes the median with an overflow-safe midpoint of the mutable prefix [0, count) by selection instead of a full sort.
// The prefix is rearranged in place, the suffix is preserved, and an empty prefix returns NaN.
export function medianBySelectionOf(values: NumberArray, count = values.length): number {
	if (!Number.isInteger(count) || !(count >= 0) || count > values.length) throw new RangeError('count must identify a valid prefix')
	if (count === 0) return Number.NaN
	if (count === 1) return values[0]

	if (count <= SMALL_MEDIAN_SORT_LIMIT) {
		return medianOf(sortSmallPrefix(values, count), count)
	}

	const middle = count >>> 1
	const upper = quickSelect(values, count, middle)
	if ((count & 1) === 1) return upper

	let lower = values[0]

	for (let index = 1; index < middle; index++) {
		const value = values[index]
		if (value > lower) lower = value
	}

	return Math.sign(lower) === Math.sign(upper) ? lower + (upper - lower) * 0.5 : lower * 0.5 + upper * 0.5
}

// Sorts a tiny prefix of `values` in ascending numeric order, matching TypedArray sort's practical NaN
// placement by pushing NaNs to the high end. Used for 3x3 neighborhoods and very small robust samples.
function sortSmallPrefix(values: NumberArray, count: number) {
	for (let i = 1; i < count; i++) {
		const value = values[i]
		const valueIsNaN = Number.isNaN(value)
		let j = i - 1

		while (j >= 0) {
			const previous = values[j]
			if (!Number.isNaN(previous) ? valueIsNaN || previous <= value : valueIsNaN) break
			values[j + 1] = previous
			j--
		}

		values[j + 1] = value
	}

	return values
}

// Approximates the unweighted 2D geometric median minimizing the sum of Euclidean distances to
// paired finite coordinates in x/y. Both axes must use the same units. Integer count selects a prefix
// within both buffers, defaulting to x.length; suffixes are ignored. Inputs are preserved and a successful
// result is freshly allocated. Empty input, unresolved normalized separations, or failure to reach
// convex subgradient stationarity (1e-9 per point) within 512 iterations returns undefined.
// Uses O(count) scratch and bounded modified Weiszfeld iteration with up to 24 Newton backtracks.
// Coincidences use their full multiplicity; no relative-distance threshold merges distinct points.
// A collinear even population can have nonunique medians; any minimizing point is valid. Component
// medians initialize the solve, and coordinate centering/scaling preserve the Euclidean metric.
// Result precision is limited by floating-point resolution at its original coordinate magnitude.
// Vardi & Zhang (2000), https://doi.org/10.1073/pnas.97.4.1423.
export function geometricMedian(x: Readonly<NumberArray>, y: Readonly<NumberArray>, count = x.length): Point | undefined {
	// A prefix outside either coordinate buffer would allocate unchecked scratch and mispair points.
	if (!Number.isInteger(count) || !(count >= 0 && count <= x.length && count <= y.length)) throw new RangeError('count must identify a valid prefix of both coordinate arrays')
	if (count === 0) return undefined
	if (count === 1) return { x: x[0], y: y[0] }

	const nx = new Float64Array(count)
	const ny = new Float64Array(count)

	for (let i = 0; i < count; i++) {
		nx[i] = x[i]
		ny[i] = y[i]
	}

	const anchorX = medianBySelectionOf(nx)
	const anchorY = medianBySelectionOf(ny)

	let coordinateScale = 1
	let scale = 0

	for (let i = 0; i < count; i++) scale = Math.max(scale, Math.abs(x[i] - anchorX), Math.abs(y[i] - anchorY))

	if (scale === Infinity) {
		// Exact power-of-two scaling makes differences of opposite finite extremes representable.
		coordinateScale = 0.5
		scale = 0
		for (let i = 0; i < count; i++) scale = Math.max(scale, Math.abs(x[i] * 0.5 - anchorX * 0.5), Math.abs(y[i] * 0.5 - anchorY * 0.5))
	}

	if (scale === 0) return { x: anchorX, y: anchorY }

	for (let i = 0; i < count; i++) {
		nx[i] = (x[i] * coordinateScale - anchorX * coordinateScale) / scale
		ny[i] = (y[i] * coordinateScale - anchorY * coordinateScale) / scale
		// An underflowed separation must not turn a resolved input cluster into coincident points.
		if ((x[i] !== anchorX && nx[i] === 0) || (y[i] !== anchorY && ny[i] === 0)) return undefined
	}

	let cx = 0
	let cy = 0
	let checkedPoint = -1

	for (let iteration = 0; iteration < GEOMETRIC_MEDIAN_ITERATIONS; iteration++) {
		let weightSum = 0
		let distanceScale = Infinity
		let rx = 0
		let ry = 0
		let coincident = 0
		let hxx = 0
		let hxy = 0
		let hyy = 0
		let closestPoint = 0
		let closestDistance = Infinity

		for (let i = 0; i < count; i++) {
			const dx = nx[i] - cx
			const dy = ny[i] - cy
			const distance = Math.hypot(dx, dy)

			if (distance < closestDistance) {
				closestPoint = i
				closestDistance = distance
			}

			if (distance === 0) {
				coincident++
				continue
			}

			const ux = dx / distance
			const uy = dy / distance
			if (distance < distanceScale) {
				// Relative reciprocal weights stay at most one even beside a very distant outlier.
				const rescale = distance / distanceScale
				weightSum *= rescale
				hxx *= rescale
				hxy *= rescale
				hyy *= rescale
				distanceScale = distance
			}
			const weight = distanceScale / distance
			weightSum += weight
			rx += ux
			ry += uy
			hxx += uy * uy * weight
			hxy -= ux * uy * weight
			hyy += ux * ux * weight
		}

		const norm = Math.hypot(rx, ry)
		if (norm <= coincident + GEOMETRIC_MEDIAN_GRADIENT_TOLERANCE * count) {
			const px = (anchorX * coordinateScale + cx * scale) / coordinateScale
			const py = (anchorY * coordinateScale + cy * scale) / coordinateScale
			return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : undefined
		}

		if (closestPoint !== checkedPoint) {
			checkedPoint = closestPoint
			if (geometricMedianAtPoint(nx, ny, count, closestPoint)) return { x: x[closestPoint], y: y[closestPoint] }
		}

		const hscale = hxx + hyy
		const a = hxx / hscale
		const b = hxy / hscale
		const c = hyy / hscale
		const determinant = a * c - b * b
		let accelerated = false

		// Near-singular Hessians retain Weiszfeld steps; smooth trials use bounded length and Armijo decrease.
		if (coincident === 0 && determinant > 1e-15) {
			let sx = ((c * rx - b * ry) / (determinant * hscale)) * distanceScale
			let sy = ((a * ry - b * rx) / (determinant * hscale)) * distanceScale
			const length = Math.hypot(sx, sy)

			if (length > 2) {
				sx *= 2 / length
				sy *= 2 / length
			}

			for (let step = 0; step < GEOMETRIC_MEDIAN_LINE_SEARCH_STEPS; step++) {
				if (geometricMedianObjectiveChange(nx, ny, count, cx, cy, sx, sy) <= -1e-4 * (rx * sx + ry * sy)) {
					cx += sx
					cy += sy
					accelerated = true
					break
				}

				sx *= 0.5
				sy *= 0.5
			}
		}

		if (accelerated) continue

		const fraction = 1 - coincident / norm
		cx += ((fraction * rx) / weightSum) * distanceScale
		cy += ((fraction * ry) / weightSum) * distanceScale
	}

	return undefined
}

// Tests the convex subgradient ball at index in the first count paired, centered/scaled x/y values.
// Multiplicity includes coincident points; no distances or inputs are mutated.
function geometricMedianAtPoint(x: Float64Array, y: Float64Array, count: number, index: number) {
	let rx = 0
	let ry = 0
	let coincident = 0

	for (let i = 0; i < count; i++) {
		const dx = x[i] - x[index]
		const dy = y[i] - y[index]
		const distance = Math.hypot(dx, dy)

		if (distance === 0) {
			coincident++
		} else {
			rx += dx / distance
			ry += dy / distance
		}
	}

	return Math.hypot(rx, ry) <= coincident + GEOMETRIC_MEDIAN_GRADIENT_TOLERANCE * count
}

// Sum-of-distances change for the first count paired x/y values from candidate (cx,cy) by step
// (sx,sy), all in normalized coordinate units; inputs are preserved.
// Rationalized distance differences preserve small decreases near stationarity. Dividing each
// step component before multiplying avoids squared-step underflow beside distant outliers.
function geometricMedianObjectiveChange(x: Float64Array, y: Float64Array, count: number, cx: number, cy: number, sx: number, sy: number) {
	let change = 0

	for (let i = 0; i < count; i++) {
		const dx = x[i] - cx
		const dy = y[i] - cy
		const denominator = Math.hypot(dx - sx, dy - sy) + Math.hypot(dx, dy)
		if (denominator > 0) change += (sx / denominator) * (sx - 2 * dx) + (sy / denominator) * (sy - 2 * dy)
	}

	return change
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

	const mid = count >>> 1
	const upper = a[mid]
	if ((count & 1) === 1) return upper

	const lower = a[mid - 1]
	return Math.sign(lower) === Math.sign(upper) ? lower + (upper - lower) * 0.5 : lower * 0.5 + upper * 0.5
}

// Computes the median absolute deviation of a numeric array about a given `median`.
// `normalized` scales the result by STANDARD_DEVIATION_SCALE to estimate the standard deviation.
// `count` restricts the computation to the first `count` elements. Allocates a temporary buffer that is sorted in place.
export function medianAbsoluteDeviationOf(a: Readonly<NumberArray>, median: number, normalized: boolean, count: number = a.length, scratch?: Float64Array) {
	const abs = scratch ?? new Float64Array(count)
	for (let i = 0; i < count; i++) abs[i] = Math.abs(a[i] - median)
	const mad = medianBySelectionOf(abs, count)
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
