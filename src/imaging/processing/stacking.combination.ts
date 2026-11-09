import { clamp } from '../../math/numerical/math'
import { meanOf, medianAbsoluteDeviationOf, medianOf } from '../../math/numerical/statistics'
import type { ImageRawType } from '../model/types'
import type { MinMaxRejectionOptions, PercentileRangeOptions, SigmaClipStackingOptions, StackBounds, StackingCombinationMethod, StackingCropMode, StackingOptions, StackingWeightingMode } from './stacker'
import type { SubframeQualityMetrics } from './subframe.selector'

// Pixel combination primitives shared by the batch and live stacker and by callers that integrate
// registered frames themselves, such as a memory-bounded integrator that visits the output in strips.
// Samples are aligned, normalized values on one output grid; validity bytes are per pixel and cover
// every interleaved channel. Online methods (sum, average, weighted-average) accumulate in Float64 and
// keep no frame; sample-based methods combine one per-pixel sample vector at a time from views of the
// contributing frames. Nothing here allocates per pixel: scratch buffers are created once per caller.

// Resolved numerical parameters of the sample-based rejection methods.
export interface CombinationParameters {
	readonly sigmaClip: Required<SigmaClipStackingOptions>
	readonly minMaxRejection: Required<MinMaxRejectionOptions>
	readonly winsorization: Required<PercentileRangeOptions>
	readonly percentileClip: Required<PercentileRangeOptions>
}

// Default rejection parameters: 3σ median/MAD clipping in 3 iterations, one low and one high sample
// discarded by min/max, and the 10th–90th percentile range for winsorization and percentile clipping.
export const DEFAULT_COMBINATION_PARAMETERS: CombinationParameters = {
	sigmaClip: { sigmaLower: 3, sigmaUpper: 3, maxIterations: 3, centerMethod: 'median', dispersionMethod: 'mad' },
	minMaxRejection: { low: 1, high: 1 },
	winsorization: { lower: 0.1, upper: 0.9 },
	percentileClip: { lower: 0.1, upper: 0.9 },
}

// Smallest frame weight, so a zero or negative caller weight never empties a denominator.
const MIN_FRAME_WEIGHT = 1e-12

// Reusable per-pixel workspaces sized for the largest number of contributing frames.
export interface CombinationScratch {
	// Sample values of the pixel being combined; reordered in place by the sorting methods.
	readonly values: Float64Array
	// Frame weights aligned with `values`.
	readonly weights: Float64Array
	// Workspace of the MAD dispersion of sigma clipping.
	readonly mad: Float64Array
	// Sorted copy of the samples used by weighted sigma clipping, which keeps `values` paired with `weights`.
	readonly sorted: Float64Array
}

// One contributing frame of a strip: views starting at the strip's first pixel. `raw` holds
// pixels × channels interleaved samples and `valid` one byte per pixel, nonzero when the sample exists.
export interface CombinationStripFrame {
	readonly raw: ArrayLike<number>
	readonly valid: ArrayLike<number>
	// Positive frame weight; used by the weighted methods only.
	readonly weight: number
}

// Resolves caller rejection overrides, clamping counts to non-negative integers and fractions to [0, 1].
export function resolveCombinationParameters(options: Pick<StackingOptions, 'sigmaClip' | 'minMaxRejection' | 'winsorization' | 'percentileClip'> = {}): CombinationParameters {
	const defaults = DEFAULT_COMBINATION_PARAMETERS

	return {
		sigmaClip: {
			...defaults.sigmaClip,
			...options.sigmaClip,
			sigmaLower: Math.max(0, options.sigmaClip?.sigmaLower ?? defaults.sigmaClip.sigmaLower),
			sigmaUpper: Math.max(0, options.sigmaClip?.sigmaUpper ?? defaults.sigmaClip.sigmaUpper),
			maxIterations: Math.max(1, Math.trunc(options.sigmaClip?.maxIterations ?? defaults.sigmaClip.maxIterations)),
		},
		minMaxRejection: {
			low: Math.max(0, Math.trunc(options.minMaxRejection?.low ?? defaults.minMaxRejection.low)),
			high: Math.max(0, Math.trunc(options.minMaxRejection?.high ?? defaults.minMaxRejection.high)),
		},
		winsorization: {
			lower: clamp(options.winsorization?.lower ?? defaults.winsorization.lower, 0, 1),
			upper: clamp(options.winsorization?.upper ?? defaults.winsorization.upper, 0, 1),
		},
		percentileClip: {
			lower: clamp(options.percentileClip?.lower ?? defaults.percentileClip.lower, 0, 1),
			upper: clamp(options.percentileClip?.upper ?? defaults.percentileClip.upper, 0, 1),
		},
	}
}

// Whether a method combines exactly by accumulation, without retaining the samples of any frame.
export function isOnlineCombinationMethod(method: StackingCombinationMethod) {
	return method === 'sum' || method === 'average' || method === 'weighted-average'
}

// Allocates workspaces for at most `capacity` contributing frames per pixel.
export function createCombinationScratch(capacity: number): CombinationScratch {
	return { values: new Float64Array(capacity), weights: new Float64Array(capacity), mad: new Float64Array(capacity), sorted: new Float64Array(capacity) }
}

// Resolves the weight of one frame from its caller weight (1 when absent) and the factor of the
// weighting mode, each factor clamped to a bounded range so one frame never dominates without limit.
export function frameWeight(weight: number | undefined, quality: SubframeQualityMetrics, mode: StackingWeightingMode, minAcceptedStars: number) {
	const base = Math.max(MIN_FRAME_WEIGHT, weight ?? 1)

	switch (mode) {
		case 'none':
		default:
			return base
		case 'snr':
			return base * clamp(Math.max(quality.medianSNR, 1) / 10, 0.25, 4)
		case 'inverse-hfd':
			return base * clamp(2.5 / Math.max(quality.medianHFD, 0.5), 0.25, 4)
		case 'stars':
			return base * clamp(Math.max(quality.starCount, 1) / Math.max(minAcceptedStars, 1), 0.25, 4)
		case 'quality':
			return base * clamp((Math.sqrt(Math.max(quality.starCount, 1)) * Math.max(quality.medianSNR, 1)) / Math.max(quality.medianHFD * 10, 1), 0.25, 6)
	}
}

// Minimum number of contributing frames for an output pixel: all of them for an intersection crop,
// otherwise the `minimumCoverage` fraction of the accepted frames, at least one. Zero frames give zero.
export function coverageThreshold(acceptedFrames: number, cropMode: StackingCropMode, minimumCoverage: number) {
	if (acceptedFrames <= 0) return 0
	if (cropMode === 'intersection') return acceptedFrames
	return Math.max(1, Math.ceil(minimumCoverage * acceptedFrames))
}

// Inclusive bounding box of the pixels whose coverage reaches `threshold` on a row-major
// width × height grid, or undefined when none does. The box may contain uncovered holes.
export function coverageBounds(width: number, height: number, coverage: Readonly<Uint32Array>, threshold: number): StackBounds | undefined {
	let left = width
	let top = height
	let right = -1
	let bottom = -1

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const pixel = y * width + x

			if (coverage[pixel] < threshold) continue
			if (x < left) left = x
			if (y < top) top = y
			if (x > right) right = x
			if (y > bottom) bottom = y
		}
	}

	if (right < left || bottom < top) return undefined

	return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
}

// Adds one aligned frame to online accumulators: `sum` (pixels × channels) receives the samples times
// the weight (1 unless weighted-average), `weightSum` (pixels) the weight, or 1 per frame for sum, and
// `coverage`, when given, one count per valid pixel. Invalid pixels are skipped entirely.
export function accumulateSamples(channels: number, raw: ArrayLike<number>, valid: ArrayLike<number>, sum: Float64Array, weightSum: Float64Array, coverage: Uint32Array | undefined, method: StackingCombinationMethod, weight: number) {
	const effectiveWeight = method === 'weighted-average' ? weight : 1
	const sumMode = method === 'sum'

	for (let pixel = 0; pixel < valid.length; pixel++) {
		if (valid[pixel] === 0) continue
		const base = pixel * channels
		for (let channel = 0; channel < channels; channel++) sum[base + channel] += raw[base + channel] * effectiveWeight
		weightSum[pixel] += sumMode ? 1 : effectiveWeight
		if (coverage !== undefined) coverage[pixel]++
	}
}

// Writes the online result into `out` (pixels × channels): the weighted mean, or the plain sum for
// `sum`. Pixels below the coverage threshold or with no weight keep their current `out` value, so a
// caller chooses the no-data convention by pre-filling `out` (the stacker uses zero).
export function finalizeOnlineSamples(sum: Readonly<Float64Array>, weightSum: Readonly<Float64Array>, coverage: Readonly<Uint32Array>, channels: number, threshold: number, method: StackingCombinationMethod, out: ImageRawType) {
	for (let pixel = 0; pixel < weightSum.length; pixel++) {
		if (coverage[pixel] < threshold) continue
		const denominator = method === 'sum' ? 1 : weightSum[pixel]
		if (!(denominator > 0)) continue
		const base = pixel * channels
		for (let channel = 0; channel < channels; channel++) out[base + channel] = sum[base + channel] / denominator
	}
}

// Combines the samples of `pixels` consecutive pixels from views of the contributing frames into
// `out` (pixels × channels), with the coverage counts of the same pixels. Frames are visited in the
// given order, which fixes the reduction order and therefore the floating-point result. Pixels below
// the threshold, and channels with no valid sample, keep their current `out` value. `scratch` must
// hold at least `frames.length` samples.
export function combineStrip(frames: readonly CombinationStripFrame[], pixels: number, channels: number, coverage: Readonly<ArrayLike<number>>, threshold: number, method: StackingCombinationMethod, parameters: CombinationParameters, out: ImageRawType, scratch: CombinationScratch) {
	const { values, weights } = scratch

	for (let pixel = 0; pixel < pixels; pixel++) {
		if (coverage[pixel] < threshold) continue
		const base = pixel * channels
		for (let channel = 0; channel < channels; channel++) {
			let used = 0
			for (let i = 0; i < frames.length; i++) {
				if (frames[i].valid[pixel] === 0) continue
				values[used] = frames[i].raw[base + channel]
				weights[used] = frames[i].weight
				used++
			}
			if (used === 0) continue
			out[base + channel] = combineSamples(method, values, weights, used, parameters, scratch)
		}
	}
}

// Combines one per-pixel sample vector of `count` values with the selected method. `values` is
// reordered in place by the sorting methods, except weighted-sigma-clip, which keeps it paired with
// `weights`; the weighted methods read `weights`. `scratch` supplies reusable workspaces of at least
// `count` samples; omitted, the clipping methods allocate them per call.
export function combineSamples(method: StackingCombinationMethod, values: Float64Array, weights: Float64Array, count: number, parameters: CombinationParameters, scratch?: Pick<CombinationScratch, 'mad' | 'sorted'>) {
	const sorted = values.subarray(0, count)
	const sortedWeights = weights.subarray(0, count)

	switch (method) {
		case 'sum':
		default: {
			let sum = 0
			for (let i = 0; i < count; i++) sum += sorted[i]
			return sum
		}
		case 'average': {
			let sum = 0
			for (let i = 0; i < count; i++) sum += sorted[i]
			return sum / count
		}
		case 'weighted-average': {
			let weighted = 0
			let weightSum = 0

			for (let i = 0; i < count; i++) {
				weighted += sorted[i] * sortedWeights[i]
				weightSum += sortedWeights[i]
			}

			return weightSum > 0 ? weighted / weightSum : 0
		}
		case 'median':
			sorted.sort()
			return medianOf(sorted, count)
		case 'min-max-average':
			sorted.sort()
			return combineMinMaxAverage(sorted, count, parameters.minMaxRejection.low, parameters.minMaxRejection.high)
		case 'winsorized-mean':
			sorted.sort()
			return combineWinsorizedMean(sorted, count, parameters.winsorization.lower, parameters.winsorization.upper)
		case 'percentile-clip-average':
			sorted.sort()
			return combinePercentileClipAverage(sorted, count, parameters.percentileClip.lower, parameters.percentileClip.upper)
		case 'sigma-clip':
			sorted.sort()
			return combineSigmaClip(sorted, count, parameters.sigmaClip, scratch?.mad)
		case 'weighted-sigma-clip':
			return combineWeightedSigmaClip(values, weights, count, parameters.sigmaClip, scratch?.sorted ?? new Float64Array(count), scratch?.mad)
	}
}

// Computes a deterministic min/max rejection average.
function combineMinMaxAverage(values: Float64Array, count: number, lowReject: number, highReject: number) {
	const start = Math.min(lowReject, Math.max(0, count - 1))
	const end = Math.max(start, count - Math.min(highReject, Math.max(0, count - start - 1)))
	if (end <= start) return meanOf(values, 0, count)
	let sum = 0
	for (let i = start; i < end; i++) sum += values[i]
	return sum / (end - start)
}

// Computes a winsorized mean with percentile clamping.
function combineWinsorizedMean(values: Float64Array, count: number, lower: number, upper: number) {
	if (count <= 2) return meanOf(values, 0, count)
	const low = percentileSorted(values, count, lower)
	const high = percentileSorted(values, count, Math.max(lower, upper))
	let sum = 0
	for (let i = 0; i < count; i++) sum += clamp(values[i], low, high)
	return sum / count
}

// Computes a percentile-clipped average.
function combinePercentileClipAverage(values: Float64Array, count: number, lower: number, upper: number) {
	if (count <= 2) return meanOf(values, 0, count)
	const low = percentileSorted(values, count, lower)
	const high = percentileSorted(values, count, Math.max(lower, upper))
	let sum = 0
	let kept = 0

	for (let i = 0; i < count; i++) {
		const value = values[i]
		if (value < low || value > high) continue
		sum += value
		kept++
	}

	return kept > 0 ? sum / kept : meanOf(values, 0, count)
}

// Computes a conservative sigma-clipped average for one sample vector.
// `madScratch` is reused across pixels and iterations when dispersion is MAD; omitted, a temporary array is allocated.
function combineSigmaClip(values: Float64Array, count: number, options: Required<SigmaClipStackingOptions>, madScratch?: Float64Array) {
	if (count <= 2) return meanOf(values, 0, count)
	let active = count

	for (let iteration = 0; iteration < options.maxIterations; iteration++) {
		const sorted = values.subarray(0, active).sort()
		const center = options.centerMethod === 'mean' ? meanOf(sorted) : medianOf(sorted, active)
		let sigma = 0

		if (options.dispersionMethod === 'std') {
			let sumSq = 0

			for (let i = 0; i < active; i++) {
				const delta = sorted[i] - center
				sumSq += delta * delta
			}

			sigma = Math.sqrt(sumSq / active)
		} else {
			sigma = medianAbsoluteDeviationOf(sorted, center, true, active, madScratch)
		}

		if (!(sigma > 0)) return center

		const low = center - options.sigmaLower * sigma
		const high = center + options.sigmaUpper * sigma
		let kept = 0

		for (let i = 0; i < active; i++) if (sorted[i] >= low && sorted[i] <= high) values[kept++] = sorted[i]

		if (kept === 0) return center
		if (kept === active) return meanOf(sorted)

		active = kept
	}

	return meanOf(values, 0, active)
}

// Rejects with exactly the bounds of sigma-clip, iterated on a sorted copy, and returns the weighted
// mean of the original (value, weight) pairs inside the intersection of every iteration's bounds, which
// is the set sigma-clip keeps. With two samples or fewer nothing is rejected; with no positive retained
// weight, or a zero dispersion that sigma-clip answers with its center, the center is returned.
function combineWeightedSigmaClip(values: Float64Array, weights: Float64Array, count: number, options: Required<SigmaClipStackingOptions>, sorted: Float64Array, madScratch?: Float64Array) {
	if (count <= 2) return weightedMeanWithin(values, weights, count, -Infinity, Infinity, meanOf(values, 0, count))

	for (let i = 0; i < count; i++) sorted[i] = values[i]
	let active = count
	let low = -Infinity
	let high = Infinity
	let center = 0

	for (let iteration = 0; iteration < options.maxIterations; iteration++) {
		const current = sorted.subarray(0, active).sort()
		center = options.centerMethod === 'mean' ? meanOf(current) : medianOf(current, active)
		let sigma = 0

		if (options.dispersionMethod === 'std') {
			let sumSq = 0

			for (let i = 0; i < active; i++) {
				const delta = current[i] - center
				sumSq += delta * delta
			}

			sigma = Math.sqrt(sumSq / active)
		} else {
			sigma = medianAbsoluteDeviationOf(current, center, true, active, madScratch)
		}

		if (!(sigma > 0)) return center

		low = Math.max(low, center - options.sigmaLower * sigma)
		high = Math.min(high, center + options.sigmaUpper * sigma)
		let kept = 0

		for (let i = 0; i < active; i++) if (current[i] >= low && current[i] <= high) sorted[kept++] = current[i]

		if (kept === 0) return center
		if (kept === active) break

		active = kept
	}

	return weightedMeanWithin(values, weights, count, low, high, center)
}

// Weighted mean of the samples within [low, high], or `fallback` when their weights sum to no positive value.
function weightedMeanWithin(values: Float64Array, weights: Float64Array, count: number, low: number, high: number, fallback: number) {
	let weighted = 0
	let weightSum = 0

	for (let i = 0; i < count; i++) {
		const value = values[i]
		if (value < low || value > high) continue
		weighted += value * weights[i]
		weightSum += weights[i]
	}

	return weightSum > 0 ? weighted / weightSum : fallback
}

// Computes a percentile from a sorted numeric array.
function percentileSorted(values: Float64Array, count: number, percentile: number) {
	if (count <= 0) return Number.NaN
	if (count === 1) return values[0]
	const clamped = clamp(percentile, 0, 1)
	const index = clamped * (count - 1)
	const lower = Math.floor(index)
	const upper = Math.min(lower + 1, count - 1)
	const fraction = index - lower
	return values[lower] + (values[upper] - values[lower]) * fraction
}
