import type { NumberArray } from './math'

interface HistogramCache {
	mode?: readonly [number, number] // [pixel, count]
	count?: readonly [number, number] // [total, max]
	mean?: number
	variance?: number
	standardDeviation?: number
	median?: number
	minimum?: readonly [number, number] // [pixel, count]
	maximum?: readonly [number, number] // [pixel, count]
}

export class Histogram {
	private readonly cache: HistogramCache = {}

	constructor(
		readonly histogram: Readonly<NumberArray>,
		private readonly max: number,
		private readonly maxSq: number = max * max,
	) {}

	reset(key?: keyof HistogramCache) {
		if (key) {
			this.cache[key] = undefined
		} else {
			for (const key in this.cache) {
				this.cache[key as keyof HistogramCache] = undefined
			}
		}
	}

	get mode() {
		if (this.cache.mode) {
			return this.cache.mode
		}

		let max = 0
		let ret = 0
		const n = this.histogram.length

		for (let i = 0; i < n; i++) {
			const value = this.histogram[i]

			if (value !== 0 && value > max) {
				max = value
				ret = i
			}
		}

		if (this.max) ret /= this.max

		this.cache.mode = [ret, max]

		return this.cache.mode
	}

	get count() {
		if (this.cache.count) {
			return this.cache.count
		}

		let ret = 0
		let max = 0
		const n = this.histogram.length

		for (let i = 0; i < n; i++) {
			const value = this.histogram[i]

			if (value !== 0) {
				ret += this.histogram[i]
				max = Math.max(max, value)
			}
		}

		this.cache.count = [ret, max]

		return this.cache.count
	}

	get mean() {
		if (this.cache.mean) {
			return this.cache.mean
		}

		let ret = 0
		const n = this.histogram.length

		for (let i = 0; i < n; i++) {
			ret += i * this.histogram[i]
		}

		ret /= this.count[0]
		if (this.max) ret /= this.max
		this.cache.mean = ret
		return ret
	}

	get variance() {
		if (this.cache.variance) {
			return this.cache.variance
		}

		let ret = 0
		const mean = this.max ? this.mean * this.max : this.mean
		const n = this.histogram.length

		for (let i = 0; i < n; i++) {
			const value = this.histogram[i]

			if (value !== 0) {
				const d = i - mean
				ret += value * (d * d)
			}
		}

		ret /= this.count[0]
		if (this.maxSq) ret /= this.maxSq
		this.cache.variance = ret
		return ret
	}

	get standardDeviation() {
		if (this.cache.standardDeviation) {
			return this.cache.standardDeviation
		}

		const ret = Math.sqrt(this.variance)
		this.cache.standardDeviation = ret
		return ret
	}

	get median() {
		if (this.cache.median) {
			return this.cache.median
		}

		let prev = 0
		let cumulative = 0
		let i = 0

		const n = this.count[0] / 2

		while (true) {
			prev = cumulative
			cumulative += this.histogram[i]
			if (cumulative >= n) break
			i++
		}

		const p = (n - prev) / this.histogram[i]
		let ret = i + p
		if (this.max) ret /= this.max
		this.cache.median = ret
		return this.cache.median
	}

	get minimum() {
		if (this.cache.minimum) {
			return this.cache.minimum
		}

		let count = 0
		let ret = 0
		const n = this.histogram.length

		for (let i = 0; i < n; i++) {
			const value = this.histogram[i]

			if (value !== 0) {
				count = value
				ret = i
				break
			}
		}

		if (this.max) ret /= this.max
		this.cache.minimum = [ret, count]
		return this.cache.minimum
	}

	get maximum() {
		if (this.cache.maximum) {
			return this.cache.maximum
		}

		let count = 0
		let ret = 0
		const n = this.histogram.length

		for (let i = n; i >= 0; i--) {
			const value = this.histogram[i]

			if (value !== 0) {
				count = value
				ret = i
				break
			}
		}

		if (this.max) ret /= this.max
		this.cache.maximum = [ret, count]
		return this.cache.maximum
	}
}
