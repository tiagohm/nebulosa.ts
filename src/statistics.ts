import type { NumberArray } from './math'

interface HistogramCache {
	mode?: readonly [number, number] // [pixel, count]
	count?: number
	mean?: number
	variance?: number
	standardDeviation?: number
	median?: number
	minimum?: readonly [number, number] // [pixel, count]
	maximum?: readonly [number, number] // [pixel, count]
}

export class Histogram {
	private readonly cache: HistogramCache = {}

	constructor(private readonly histogram: Readonly<NumberArray>) {}

	reset(key?: keyof HistogramCache) {
		if (key) {
			this.cache[key] = undefined
		} else {
			for (const key in this.cache) {
				this.cache[key as keyof HistogramCache] = undefined
			}
		}
	}

	mode() {
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

		this.cache.mode = [ret, max]

		return this.cache.mode
	}

	count() {
		if (this.cache.count) {
			return this.cache.count
		}

		let ret = 0
		const n = this.histogram.length

		for (let i = 0; i < n; i++) {
			ret += this.histogram[i]
		}

		this.cache.count = ret

		return ret
	}

	mean() {
		if (this.cache.mean) {
			return this.cache.mean
		}

		let ret = 0
		const n = this.histogram.length

		for (let i = 0; i < n; i++) {
			ret += i * this.histogram[i]
		}

		ret /= this.count()
		this.cache.mean = ret
		return ret
	}

	variance() {
		if (this.cache.variance) {
			return this.cache.variance
		}

		let ret = 0
		const mean = this.mean()
		const n = this.histogram.length

		for (let i = 0; i < n; i++) {
			const value = this.histogram[i]

			if (value !== 0) {
				const d = i - mean
				ret += value * (d * d)
			}
		}

		ret /= this.count()
		this.cache.variance = ret
		return ret
	}

	standardDeviation() {
		if (this.cache.standardDeviation) {
			return this.cache.standardDeviation
		}

		const ret = Math.sqrt(this.variance())
		this.cache.standardDeviation = ret
		return ret
	}

	median() {
		if (this.cache.median) {
			return this.cache.median
		}

		let prev = 0
		let cumulative = 0
		let i = 0

		const n = this.count() / 2

		while (true) {
			prev = cumulative
			cumulative += this.histogram[i]
			if (cumulative >= n) break
			i++
		}

		const p = (n - prev) / this.histogram[i]
		this.cache.median = i + p
		return this.cache.median
	}

	minimum() {
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

		this.cache.minimum = [ret, count]

		return this.cache.minimum
	}

	maximum() {
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

		this.cache.maximum = [ret, count]

		return this.cache.maximum
	}
}
