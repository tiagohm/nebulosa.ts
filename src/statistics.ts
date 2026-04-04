import type { NumberArray } from './math'

interface HistogramCache {
	mode: readonly [number, number] | undefined // [pixel, count]
	count: readonly [number, number] | undefined // [total, max]
	mean: number | undefined
	variance: number | undefined
	standardDeviation: number | undefined
	median: number | undefined
	minimum: readonly [number, number] | undefined // [pixel, count]
	maximum: readonly [number, number] | undefined // [pixel, count]
}

export class Histogram {
	readonly #cache: HistogramCache = {
		mode: undefined,
		count: undefined,
		mean: undefined,
		variance: undefined,
		standardDeviation: undefined,
		median: undefined,
		minimum: undefined,
		maximum: undefined,
	}

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

		const { histogram, max } = this
		const total = this.count[0]

		if (!(total > 0) || histogram.length === 0) {
			this.#cache.median = 0
			return 0
		}

		let prev = 0
		let cumulative = 0
		const threshold = total / 2
		const n = histogram.length

		for (let i = 0; i < n; i++) {
			prev = cumulative
			cumulative += histogram[i]

			if (cumulative >= threshold) {
				const p = (threshold - prev) / histogram[i]
				let ret = i + p
				if (max !== 0) ret /= max
				this.#cache.median = ret
				return ret
			}
		}

		const ret = max !== 0 ? (n - 1) / max : n - 1
		this.#cache.median = ret
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
