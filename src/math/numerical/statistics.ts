import { quickSelect } from './array'
import type { Point } from './geometry'
import type { NumberArray } from './math'

// Descriptive statistics over numeric samples and histogram bins, including robust scalar estimators
// and an unweighted 2D geometric median. Sample statistics retain the input units; variance uses
// squared units. Most scalar reducers return NaN for empty input. Selection-based medians rearrange
// their input prefix; geometric medians preserve paired coordinates and allocate scratch buffers.
// Histogram caches descriptors of bin counts, normalizes positions by max, and requires reset()
// after bins change. Sorted-input requirements and scratch-buffer mutation are documented per helper.

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
// `count` restricts the computation to the first `count` elements; a is preserved. The first count
// entries of scratch are overwritten and rearranged, or a temporary Float64Array is allocated.
// Supplied scratch must have at least count entries and must not alias a. Empty input returns NaN.
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

// Memoized statistics for a Histogram; each field is undefined until first computed. Tuple fields hold
// the documented [position, count] or [total, max] pairs.
interface HistogramCache {
	mode: readonly [number, number] | undefined // [pixel, count]
	count: readonly [number, number] | undefined // [total, max]
	mean: number | undefined
	variance: number | undefined
	standardDeviation: number | undefined
	median: number | undefined
	entropy: number | undefined
	skewness: number | undefined
	kurtosis: number | undefined
	minimum: readonly [number, number] | undefined // [pixel, count]
	maximum: readonly [number, number] | undefined // [pixel, count]
}

// Computes cached descriptive statistics over a fixed array of histogram bin counts.
export class Histogram {
	readonly #cache: HistogramCache = {
		mode: undefined,
		count: undefined,
		mean: undefined,
		variance: undefined,
		standardDeviation: undefined,
		median: undefined,
		entropy: undefined,
		skewness: undefined,
		kurtosis: undefined,
		minimum: undefined,
		maximum: undefined,
	}

	// Wraps the bin-count array `histogram` (index = intensity bin, value = sample count) with the
	// normalization scale `max` (the maximum bin index, dividing positions onto 0..1) and its square
	// `maxSq` (defaulting to max², used to normalize variance).
	constructor(
		readonly histogram: Readonly<NumberArray>,
		readonly max: number,
		readonly maxSq: number = max * max,
	) {}

	// Clears one cached statistic or the full cache.
	reset(key?: keyof HistogramCache) {
		if (key !== undefined) {
			this.#cache[key] = undefined
		} else {
			this.#cache.mode = undefined
			this.#cache.count = undefined
			this.#cache.mean = undefined
			this.#cache.variance = undefined
			this.#cache.standardDeviation = undefined
			this.#cache.median = undefined
			this.#cache.entropy = undefined
			this.#cache.skewness = undefined
			this.#cache.kurtosis = undefined
			this.#cache.minimum = undefined
			this.#cache.maximum = undefined
		}
	}

	// Returns the most populated histogram bin and its count.
	get mode() {
		if (this.#cache.mode !== undefined) {
			return this.#cache.mode
		}

		const { histogram, max } = this
		const n = histogram.length
		let maxCount = 0
		let mode = 0

		for (let i = 0; i < n; i++) {
			const value = histogram[i]

			if (value !== 0 && value > maxCount) {
				maxCount = value
				mode = i
			}
		}

		if (max !== 0) mode /= max

		this.#cache.mode = [mode, maxCount] as const

		return this.#cache.mode
	}

	// Returns the total sample count and the largest bin count.
	get count() {
		if (this.#cache.count !== undefined) {
			return this.#cache.count
		}

		const { histogram } = this
		const n = histogram.length
		let total = 0
		let maxCount = 0

		for (let i = 0; i < n; i++) {
			const value = histogram[i]

			if (value !== 0) {
				total += value
				if (value > maxCount) maxCount = value
			}
		}

		this.#cache.count = [total, maxCount] as const

		return this.#cache.count
	}

	// Returns the normalized mean bin position.
	get mean() {
		if (this.#cache.mean !== undefined) {
			return this.#cache.mean
		}

		const { histogram, max } = this
		const total = this.count[0]

		if (!(total > 0)) {
			this.#cache.mean = 0
			return 0
		}

		const n = histogram.length
		let ret = 0

		for (let i = 0; i < n; i++) {
			ret += i * histogram[i]
		}

		ret /= total
		if (max !== 0) ret /= max
		this.#cache.mean = ret
		return ret
	}

	// Returns the normalized variance of the bin positions.
	get variance() {
		if (this.#cache.variance !== undefined) {
			return this.#cache.variance
		}

		const { histogram, max, maxSq } = this
		const total = this.count[0]

		if (!(total > 0)) {
			this.#cache.variance = 0
			return 0
		}

		const mean = max !== 0 ? this.mean * max : this.mean
		const n = histogram.length
		let ret = 0

		for (let i = 0; i < n; i++) {
			const value = histogram[i]

			if (value !== 0) {
				const d = i - mean
				ret += value * (d * d)
			}
		}

		ret /= total
		if (maxSq !== 0) ret /= maxSq
		this.#cache.variance = ret
		return ret
	}

	// Returns the square root of the normalized variance.
	get standardDeviation() {
		if (this.#cache.standardDeviation !== undefined) {
			return this.#cache.standardDeviation
		}

		const ret = Math.sqrt(this.variance)
		this.#cache.standardDeviation = ret
		return ret
	}

	// Returns the normalized median bin position using linear interpolation within the median bin.
	get median() {
		if (this.#cache.median !== undefined) {
			return this.#cache.median
		}

		const ret = this.quantile(0.5)
		this.#cache.median = ret
		return ret
	}

	// Returns the normalized weighted quantile using linear interpolation within the selected bin.
	quantile(probability: number) {
		const { histogram, max } = this
		const total = this.count[0]

		if (!(total > 0) || histogram.length === 0) {
			return 0
		}

		if (!(probability > 0)) return this.minimum[0]
		if (probability >= 1) return this.maximum[0]

		let prev = 0
		let cumulative = 0
		const threshold = probability * total
		const n = histogram.length

		for (let i = 0; i < n; i++) {
			prev = cumulative
			cumulative += histogram[i]

			if (cumulative >= threshold) {
				const p = (threshold - prev) / histogram[i]
				const ret = i + p
				return max !== 0 ? (ret >= max ? 1 : ret / max) : ret
			}
		}

		return max !== 0 ? 1 : n - 1
	}

	// Returns the cumulative probability at a normalized bin position.
	cdf(value: number) {
		const { histogram, max } = this
		const total = this.count[0]
		const n = histogram.length

		if (!(total > 0) || n === 0 || !(value > 0)) return 0

		const x = max !== 0 ? value * max : value

		if (x >= n - 1) return 1

		const bin = Math.trunc(x)
		const fraction = x - bin
		let cumulative = 0

		for (let i = 0; i < bin; i++) {
			cumulative += histogram[i]
		}

		return (cumulative + fraction * histogram[bin]) / total
	}

	// Returns the Shannon entropy in bits.
	get entropy() {
		if (this.#cache.entropy !== undefined) {
			return this.#cache.entropy
		}

		const { histogram } = this
		const total = this.count[0]

		if (!(total > 0)) {
			this.#cache.entropy = 0
			return 0
		}

		const n = histogram.length
		let ret = 0

		for (let i = 0; i < n; i++) {
			const value = histogram[i]

			if (value !== 0) {
				const p = value / total
				ret -= p * Math.log2(p)
			}
		}

		this.#cache.entropy = ret
		return ret
	}

	// Returns the standardized third central moment.
	get skewness() {
		if (this.#cache.skewness !== undefined) {
			return this.#cache.skewness
		}

		const { histogram, max } = this
		const total = this.count[0]
		const standardDeviation = max !== 0 ? this.standardDeviation * max : this.standardDeviation

		if (!(total > 0) || !(standardDeviation > 0)) {
			this.#cache.skewness = 0
			return 0
		}

		const mean = max !== 0 ? this.mean * max : this.mean
		const n = histogram.length
		let ret = 0

		for (let i = 0; i < n; i++) {
			const value = histogram[i]

			if (value !== 0) {
				const z = (i - mean) / standardDeviation
				ret += value * (z * z * z)
			}
		}

		ret /= total
		this.#cache.skewness = ret
		return ret
	}

	// Returns the standardized fourth central moment minus three.
	get kurtosis() {
		if (this.#cache.kurtosis !== undefined) {
			return this.#cache.kurtosis
		}

		const { histogram, max } = this
		const total = this.count[0]
		const standardDeviation = max !== 0 ? this.standardDeviation * max : this.standardDeviation

		if (!(total > 0) || !(standardDeviation > 0)) {
			this.#cache.kurtosis = 0
			return 0
		}

		const mean = max !== 0 ? this.mean * max : this.mean
		const n = histogram.length
		let ret = 0

		for (let i = 0; i < n; i++) {
			const value = histogram[i]

			if (value !== 0) {
				const z = (i - mean) / standardDeviation
				const z2 = z * z
				ret += value * (z2 * z2)
			}
		}

		ret = ret / total - 3
		this.#cache.kurtosis = ret
		return ret
	}

	// Returns the first populated bin and its count.
	get minimum() {
		if (this.#cache.minimum !== undefined) {
			return this.#cache.minimum
		}

		const { histogram, max } = this
		const n = histogram.length
		let count = 0
		let ret = 0

		for (let i = 0; i < n; i++) {
			const value = histogram[i]

			if (value !== 0) {
				count = value
				ret = i
				break
			}
		}

		if (max !== 0) ret /= max
		this.#cache.minimum = [ret, count] as const
		return this.#cache.minimum
	}

	// Returns the last populated bin and its count.
	get maximum() {
		if (this.#cache.maximum !== undefined) {
			return this.#cache.maximum
		}

		const { histogram, max } = this
		const n = histogram.length
		let count = 0
		let ret = 0

		for (let i = n - 1; i >= 0; i--) {
			const value = histogram[i]

			if (value !== 0) {
				count = value
				ret = i
				break
			}
		}

		if (max !== 0) ret /= max
		this.#cache.maximum = [ret, count] as const
		return this.#cache.maximum
	}
}
