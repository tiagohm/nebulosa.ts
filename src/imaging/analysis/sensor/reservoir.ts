import { medianOf } from '../../../core/util'

// Fixed-memory robust sampling for image-scale sensor statistics. The deterministic reservoir keeps
// exact samples for small inputs and a reproducible uniform approximation for large sensor planes.

// Maximum finite samples retained by one robust estimator.
const ROBUST_SAMPLE_CAPACITY = 65536

// Fixed-capacity deterministic reservoir for approximate medians and median absolute deviations.
export class SensorRobustReservoir {
	// Retained finite samples.
	readonly #values: Float64Array
	// Number of finite values observed, including values replaced in the reservoir.
	#seen = 0
	// Deterministic xorshift state used for unbiased reservoir replacement.
	#state = 0x9e3779b9

	// Creates a reservoir capped at the smaller of the population and fixed robust-sample limits.
	constructor(populationCapacity: number) {
		this.#values = new Float64Array(Math.max(1, Math.min(populationCapacity, ROBUST_SAMPLE_CAPACITY)))
	}

	// Considers one value, ignoring non-finite samples and replacing an older sample when full.
	push(value: number) {
		if (!Number.isFinite(value)) return
		const seen = this.#seen++
		if (seen < this.#values.length) {
			this.#values[seen] = value
			return
		}
		let state = this.#state
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		this.#state = state >>> 0
		const replacement = this.#state % (seen + 1)
		if (replacement < this.#values.length) this.#values[replacement] = value
	}

	// Sorts retained samples in place and returns their median, or NaN when empty.
	median(): number {
		const count = Math.min(this.#seen, this.#values.length)
		if (count === 0) return Number.NaN
		const selected = this.#values.subarray(0, count)
		return medianOf(selected.sort())
	}

	// Returns a population standard deviation after rejecting samples beyond five scaled MADs.
	robustStandardDeviation(): number {
		const count = Math.min(this.#seen, this.#values.length)
		if (count === 0) return Number.NaN
		const selected = this.#values.subarray(0, count)
		const center = medianOf(selected.sort())
		const deviations = new Float64Array(count)
		for (let i = 0; i < count; i++) deviations[i] = Math.abs(selected[i] - center)
		const mad = medianOf(deviations.sort())
		const limit = mad > 0 ? mad * 1.482602218505602 * 5 : 0
		let accepted = 0
		let mean = 0
		let m2 = 0
		for (let i = 0; i < count; i++) {
			const value = selected[i]
			if (Math.abs(value - center) > limit) continue
			accepted++
			const delta = value - mean
			mean += delta / accepted
			m2 += delta * (value - mean)
		}
		return accepted > 0 ? Math.sqrt(m2 / accepted) : Number.NaN
	}
}
