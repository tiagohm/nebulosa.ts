import { medianAbsoluteDeviationOf, medianBySelectionOf } from '../../core/util'

// Deterministic fixed-memory robust sampling shared by image-analysis modules. Small populations are
// retained exactly; larger populations use reproducible reservoir replacement capped at 65,536 values.

// Maximum number of finite samples retained by one robust estimator.
export const ROBUST_SAMPLE_CAPACITY = 65536

// Initial deterministic xorshift state restored whenever a reservoir is reused.
const ROBUST_RESERVOIR_INITIAL_STATE = 0x9e3779b9

// Fixed-capacity deterministic reservoir for approximate robust image statistics.
export class RobustReservoir {
	// Retained finite samples; values may be reordered by selection operations.
	readonly #values: Float64Array
	// Number of finite values observed, including values replaced after the reservoir filled.
	#seen = 0
	// Deterministic xorshift state used for uniform reservoir replacement.
	#state = ROBUST_RESERVOIR_INITIAL_STATE

	// Creates a reservoir sized for the expected population and capped at the shared robust limit.
	constructor(populationCapacity: number) {
		if (!Number.isSafeInteger(populationCapacity) || !(populationCapacity >= 0)) throw new RangeError('robust reservoir population capacity must be a non-negative safe integer')
		this.#values = new Float64Array(Math.max(1, Math.min(populationCapacity, ROBUST_SAMPLE_CAPACITY)))
	}

	// Number of finite values considered, including values no longer retained.
	get seenCount(): number {
		return this.#seen
	}

	// Number of values currently retained for robust reductions.
	get retainedCount(): number {
		return Math.min(this.#seen, this.#values.length)
	}

	// Whether the retained values are a sampled approximation of the observed population.
	get approximate(): boolean {
		return this.#seen > this.#values.length
	}

	// Clears the logical population and restores deterministic sampling without reallocating storage.
	reset(): void {
		this.#seen = 0
		this.#state = ROBUST_RESERVOIR_INITIAL_STATE
	}

	// Considers one value, ignoring non-finite samples and replacing a retained sample when full.
	push(value: number): void {
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

	// Sorts retained samples in place and returns their median, or NaN when no finite value was seen.
	median(): number {
		const count = this.retainedCount
		if (count === 0) return Number.NaN
		return medianBySelectionOf(this.#values.subarray(0, count))
	}

	// Returns the median absolute deviation of retained samples, optionally reusing caller-owned scratch.
	mad(normalized: boolean = false, scratch?: Float64Array): number {
		const count = this.retainedCount
		if (count === 0) return Number.NaN
		const selected = this.#values.subarray(0, count)
		const center = medianBySelectionOf(selected)
		return this.madAround(center, normalized, scratch)
	}

	// Returns retained-sample MAD around a known median, optionally reusing caller-owned scratch.
	madAround(center: number, normalized: boolean = false, scratch?: Float64Array): number {
		const count = this.retainedCount
		if (count === 0) return Number.NaN
		if (scratch !== undefined && scratch.length < count) throw new RangeError('robust MAD scratch must hold every retained sample')
		return medianAbsoluteDeviationOf(this.#values, center, normalized, count, scratch)
	}

	// Returns population standard deviation after rejecting retained samples beyond five scaled MADs.
	robustStandardDeviation(): number {
		const count = this.retainedCount
		if (count === 0) return Number.NaN
		const selected = this.#values.subarray(0, count)
		const center = medianBySelectionOf(selected)
		const mad = medianAbsoluteDeviationOf(selected, center, true)
		const limit = mad > 0 ? mad * 5 : 0
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
