import { PhaseCorrelationWorkspace } from './registration'

// Reusable scratch buffers for extended-scene tracking. Buffers grow monotonically to the largest
// requested size and are returned as prefix views, so steady-state frames with a bounded tracking ROI
// allocate nothing. Views are valid only until the next request for the same buffer; callers must
// copy anything they retain across frames. One phase-correlation workspace is cached per geometry.

// Maximum number of samples used for one robust location/scale estimate.
export const SURFACE_STATISTICS_CAPACITY = 16384

// Growable typed-array prefix views shared by surface, limb and tracker analysis.
export class SurfaceTrackingWorkspace {
	// Robust-statistics scratch with a fixed capacity.
	readonly statistics = new Float64Array(SURFACE_STATISTICS_CAPACITY)

	#raw = new Float32Array(0)
	#normalized = new Float32Array(0)
	#mask = new Uint8Array(0)
	#coarse = new Float32Array(0)
	#coarseMask = new Uint8Array(0)
	#search = new Float64Array(0)
	#refinement = new Float64Array(0)
	#profile = new Float64Array(0)
	#fit = new Float64Array(0)
	#phase?: PhaseCorrelationWorkspace

	// Unnormalized analysis samples (NaN where non-finite) with at least count entries.
	raw(count: number) {
		if (this.#raw.length < count) this.#raw = new Float32Array(count)
		return this.#raw.subarray(0, count)
	}

	// Normalized analysis samples with at least count entries.
	normalized(count: number) {
		if (this.#normalized.length < count) this.#normalized = new Float32Array(count)
		return this.#normalized.subarray(0, count)
	}

	// Sample flags (saturated/invalid) with at least count entries.
	mask(count: number) {
		if (this.#mask.length < count) this.#mask = new Uint8Array(count)
		return this.#mask.subarray(0, count)
	}

	// Downsampled coarse samples with at least count entries.
	coarse(count: number) {
		if (this.#coarse.length < count) this.#coarse = new Float32Array(count)
		return this.#coarse.subarray(0, count)
	}

	// Downsampled coarse flags with at least count entries.
	coarseMask(count: number) {
		if (this.#coarseMask.length < count) this.#coarseMask = new Uint8Array(count)
		return this.#coarseMask.subarray(0, count)
	}

	// ZNCC search surface with at least count entries.
	search(count: number) {
		if (this.#search.length < count) this.#search = new Float64Array(count)
		return this.#search.subarray(0, count)
	}

	// ECC refinement scratch with at least count entries.
	refinement(count: number) {
		if (this.#refinement.length < count) this.#refinement = new Float64Array(count)
		return this.#refinement.subarray(0, count)
	}

	// Radial-profile scratch with at least count entries.
	profile(count: number) {
		if (this.#profile.length < count) this.#profile = new Float64Array(count)
		return this.#profile.subarray(0, count)
	}

	// Correspondence and robust-fit scratch with at least count entries.
	fit(count: number) {
		if (this.#fit.length < count) this.#fit = new Float64Array(count)
		return this.#fit.subarray(0, count)
	}

	// Returns a phase-correlation workspace for the geometry, replacing the cached one on change.
	phaseCorrelation(width: number, height: number, maximumShift: number) {
		const shift = Math.max(0, Math.floor(maximumShift))
		const cached = this.#phase
		if (cached !== undefined && cached.width === width && cached.height === height && cached.maximumShift === shift) return cached
		this.#phase = new PhaseCorrelationWorkspace(width, height, shift)
		return this.#phase
	}
}
