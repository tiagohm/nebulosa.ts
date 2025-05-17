export type HistogramData = Float16Array | Float32Array | Float64Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | Uint8ClampedArray | number[]

interface HistogramCache {
	mode?: readonly [number, number]
	count?: number
	mean?: number
	variance?: number
	standardDeviation?: number
}

export class Histogram {
	private readonly cache: HistogramCache = {}

	constructor(private readonly histogram: HistogramData) {}

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

		for (let i = 0; i < this.histogram.length; i++) {
			if (this.histogram[i] > max) {
				max = this.histogram[i]
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

		for (let i = 0; i < this.histogram.length; i++) {
			ret += this.histogram[i]
		}

		this.cache.count = ret

		return ret
	}

	mean() {
		if (this.cache.mean) {
			return this.cache.mean
		}

		const count = this.count()
		let ret = 0

		for (let i = 0; i < this.histogram.length; i++) {
			ret += i * this.histogram[i]
		}

		ret /= count
		this.cache.mean = ret
		return ret
	}

	variance() {
		if (this.cache.variance) {
			return this.cache.variance
		}

		const mean = this.mean()
		let ret = 0

		for (let i = 0; i < this.histogram.length; i++) {
			if (this.histogram[i]) {
				const d = i - mean
				ret += this.histogram[i] * (d * d)
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
		return i + p
	}
}
