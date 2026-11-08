import type { Rect } from '../../math/numerical/geometry'
import { STANDARD_DEVIATION_SCALE } from '../../math/numerical/statistics'
import { BT709_GRAYSCALE, type CfaPattern, type Image } from '../model/types'
import { BackgroundNoiseCollector, type ImageBackgroundNoise } from './background.noise'
import { CFA_ANALYSIS_PLANES, type ImageAnalysisPlane, imagePlaneGeometry, type ImagePlaneGeometry, MONO_ANALYSIS_PLANES, RGB_ANALYSIS_PLANES, resolveAnalysisArea } from './plane'
import { RobustReservoir } from './robust'

// Scientific statistics of the original samples of a normalized image, per plane: mono, each RGB
// channel plus BT.709 luminance, or each non-debayered CFA phase (red, green1, green2, blue) selected by
// absolute image coordinates. Moments (mean, population standard deviation) are exact over every finite
// sample, accumulated per row and merged with Chan's formula in float64. Order statistics (median, MAD,
// percentiles) are exact for populations that fit the robust reservoir and for unscaled 8/16-bit integer
// codes, binned to one code when those codes are not integral, and sampled otherwise. Two fixed-size
// chart histograms per plane (a robust P0.1..P99.9 domain and the full min..max one) count every finite
// sample, with samples outside the domain counted apart. NaN and infinities are counted as invalid and
// never enter a reduction. All values are in normalized sample units; nothing in the image is modified,
// and memory is bounded by a few planes of fixed buffers independent of the image size. The scan can
// advance by rows so a caller can yield between chunks.

// Number of bins of each chart histogram.
export const IMAGE_STATISTICS_BINS = 2048

// Lower percentile (fraction) of the robust histogram domain.
const ROBUST_DOMAIN_LOW = 0.001

// Upper percentile (fraction) of the robust histogram domain.
const ROBUST_DOMAIN_HIGH = 0.999

// Largest distance from an integer, in codes, of a sample still counted as that integer code; covers
// the float32 rounding of a 16-bit code divided by 65535 (at most about 0.004).
const INTEGER_CODE_TOLERANCE = 0.01

// One plane of the statistics: a native plane of the layout, or the luminance of an RGB image.
export type ImageStatisticsPlane = ImageAnalysisPlane | 'luminance'

// How the order statistics were obtained: exact over every sample, from integer codes rounded to one code,
// or from a deterministic bounded sample.
export type QuantileMethod = 'exact' | 'binned' | 'sampled'

// Options of an image statistics scan.
export interface ImageStatisticsOptions {
	// Left/top inclusive, right/bottom exclusive integer area in image pixels; the whole image when omitted.
	readonly area?: Readonly<Rect>
	// Trusted image-local CFA pattern of a one-channel mosaic; omitted analyzes the mosaic as one mono plane.
	readonly cfa?: CfaPattern
	// Whether an RGB image also gets the BT.709 luminance plane; default true.
	readonly luminance?: boolean
	// Whether normalized 0 and 1 are the representable numeric limits of the source, so samples there are
	// counted; default false.
	readonly numericLimits?: boolean
	// Whether each native plane gets a local background noise estimate; default true.
	readonly background?: boolean
}

// Fixed-size histogram of finite samples over a closed domain.
export interface ImageHistogram {
	// Lower domain edge, in normalized units.
	readonly min: number
	// Upper domain edge, in normalized units; equal to min for a single-valued domain, whose samples are in bin 0.
	readonly max: number
	// Sample counts of IMAGE_STATISTICS_BINS equal bins; the last bin includes max.
	readonly counts: Float64Array
	// Finite samples below min.
	readonly belowDomain: number
	// Finite samples above max.
	readonly aboveDomain: number
}

// Samples at the known numeric limits of the source.
export interface ImageNumericLimitCounts {
	// Samples at or below normalized 0.
	readonly lowCount: number
	// Samples at or above normalized 1.
	readonly highCount: number
}

// Statistics of one image plane; every value is in normalized sample units and undefined when no
// finite sample exists.
export interface ImagePlaneStatistics {
	// Plane these statistics describe.
	readonly plane: ImageStatisticsPlane
	// Finite samples considered.
	readonly finiteCount: number
	// NaN or infinite samples skipped.
	readonly nonFiniteCount: number
	// Smallest finite sample.
	readonly min?: number
	// Largest finite sample.
	readonly max?: number
	// Mean of the finite samples.
	readonly mean?: number
	// Population standard deviation (divided by N) of the finite samples.
	readonly standardDeviation?: number
	// Median, equal to the 50th percentile.
	readonly median?: number
	// Median absolute deviation about the median.
	readonly mad?: number
	// MAD scaled by the Gaussian consistency factor 1.4826: a dispersion, not a background noise.
	readonly robustSigma?: number
	// 1st percentile.
	readonly p01?: number
	// 99th percentile.
	readonly p99?: number
	// How the median, MAD and percentiles were obtained.
	readonly quantileMethod: QuantileMethod
	// Samples the order statistics were computed from.
	readonly quantileSamples: number
	// Counts at the numeric limits, present only when the limits were declared known.
	readonly numericLimits?: ImageNumericLimitCounts
	// Chart histograms over the robust and the full domains, absent without finite samples.
	readonly histograms?: { readonly robust: ImageHistogram; readonly full: ImageHistogram }
	// Local background noise of a native plane, absent for luminance or when disabled.
	readonly background?: ImageBackgroundNoise
}

// Statistics of every plane of an image area.
export interface ImageStatisticsResult {
	// Analyzed area in image pixels, right/bottom exclusive.
	readonly area: Readonly<Rect>
	// Per-plane statistics in canonical plane order.
	readonly planes: readonly ImagePlaneStatistics[]
}

// Incremental statistics scan advancing by image rows.
export interface ImageStatisticsScan {
	// Whether every pass is complete.
	readonly done: boolean
	// Processes up to `rows` area rows (a positive integer) and returns whether the scan is complete.
	readonly consumeRows: (rows: number) => boolean
	// Completes any remaining rows synchronously and returns the statistics; may be called more than once.
	readonly finish: () => ImageStatisticsResult
}

// Mutable fixed-bin histogram accumulator.
class HistogramAccumulator {
	// Bin counts.
	readonly counts = new Float64Array(IMAGE_STATISTICS_BINS)
	// Bins per unit of sample, zero for a single-valued domain.
	readonly #scale: number
	// Finite samples below the domain.
	below = 0
	// Finite samples above the domain.
	above = 0

	// Creates an empty histogram over [min, max].
	constructor(
		readonly min: number,
		readonly max: number,
	) {
		this.#scale = max > min ? IMAGE_STATISTICS_BINS / (max - min) : 0
	}

	// Counts `weight` samples of value `value`.
	add(value: number, weight: number): void {
		if (value < this.min) this.below += weight
		else if (value > this.max) this.above += weight
		else if (this.#scale === 0) this.counts[0] += weight
		else {
			const bin = Math.floor((value - this.min) * this.#scale)
			this.counts[bin >= IMAGE_STATISTICS_BINS ? IMAGE_STATISTICS_BINS - 1 : bin] += weight
		}
	}

	// Freezes the accumulator into a histogram result that aliases its counts.
	result(): ImageHistogram {
		return { min: this.min, max: this.max, counts: this.counts, belowDomain: this.below, aboveDomain: this.above }
	}
}

// Order statistics computed at the end of the first pass.
interface PlaneQuantiles {
	// Median, in normalized units.
	readonly median: number
	// Median absolute deviation about the median, in normalized units.
	readonly mad: number
	// 1st percentile, in normalized units.
	readonly p01: number
	// 99th percentile, in normalized units.
	readonly p99: number
	// Lower edge of the robust histogram domain (P0.1), in normalized units.
	readonly low: number
	// Upper edge of the robust histogram domain (P99.9), in normalized units.
	readonly high: number
}

// Running reductions of one plane.
class PlaneReducer {
	// Finite samples.
	finite = 0
	// NaN or infinite samples.
	nonFinite = 0
	// Running mean.
	mean = 0
	// Running sum of squared deviations from the mean.
	m2 = 0
	// Smallest finite sample.
	min = Number.POSITIVE_INFINITY
	// Largest finite sample.
	max = Number.NEGATIVE_INFINITY
	// Samples at or below normalized 0.
	low = 0
	// Samples at or above normalized 1.
	high = 0
	// Whether a sample left the integer-code grid.
	binned = false
	// Order statistics, set when the first pass ends.
	quantiles?: PlaneQuantiles
	// Chart histogram over the robust domain, set when the first pass ends.
	robust?: HistogramAccumulator
	// Chart histogram over the full min..max domain, set when the first pass ends.
	full?: HistogramAccumulator
	// Whether the chart histograms need the second pass over the samples.
	secondPass = false

	// Creates the reducer of a plane; codes holds one bin per integer code when the plane is eligible for
	// the exact integer path, otherwise a reservoir sized for the plane population keeps the quantiles.
	constructor(
		readonly plane: ImageStatisticsPlane,
		readonly geometry: ImagePlaneGeometry | undefined,
		readonly luminance: boolean,
		readonly fullScale: number,
		readonly codes: Float64Array | undefined,
		readonly reservoir: RobustReservoir | undefined,
		readonly background: BackgroundNoiseCollector | undefined,
	) {}
}

// Creates a cooperative statistics scan of a normalized image. The first pass accumulates moments,
// quantile reducers and background samples; the second one, needed unless every plane took the exact
// integer path, fills the chart histograms. The result is identical for every chunking. Throws a
// RangeError for an area that is not a non-empty integer rectangle inside the image.
export function createImageStatisticsScan(image: Image, options: ImageStatisticsOptions = {}): ImageStatisticsScan {
	const { metadata, raw } = image
	const area = resolveAnalysisArea(options.area, metadata.width, metadata.height)
	const cfa = metadata.channels === 1 ? options.cfa : undefined
	const layout = { ...metadata, bayer: cfa }
	const numericLimits = options.numericLimits === true
	const integerBits = (metadata.bitpix === 8 || metadata.bitpix === 16) && metadata.normalization === undefined ? metadata.bitpix : 0
	const fullScale = integerBits > 0 ? 2 ** integerBits - 1 : 1
	const native = cfa !== undefined ? CFA_ANALYSIS_PLANES : metadata.channels === 3 ? RGB_ANALYSIS_PLANES : MONO_ANALYSIS_PLANES

	const reducers: PlaneReducer[] = []

	const reducer = (plane: ImageStatisticsPlane, geometry: ImagePlaneGeometry | undefined, luminance: boolean) => {
		const population = geometry === undefined ? 0 : geometry.width * geometry.height
		const exact = integerBits > 0 && !luminance
		const codes = exact ? new Float64Array(fullScale + 1) : undefined
		const reservoir = exact ? undefined : new RobustReservoir(population)
		const background = options.background !== false && !luminance && geometry !== undefined ? new BackgroundNoiseCollector(geometry.width, geometry.height, numericLimits) : undefined
		reducers.push(new PlaneReducer(plane, geometry, luminance, fullScale, codes, reservoir, background))
	}

	for (const plane of native) reducer(plane, imagePlaneGeometry(layout, area, plane, cfa), false)
	if (metadata.channels === 3 && options.luminance !== false) reducer('luminance', imagePlaneGeometry(layout, area, 'red', undefined), true)

	const { red, green, blue } = BT709_GRAYSCALE
	let phase: 'first' | 'second' | 'done' = 'first'
	let y = area.top
	let result: ImageStatisticsResult | undefined

	const readSample = (reducer: PlaneReducer, index: number) => (reducer.luminance ? red * raw[index] + green * raw[index + 1] + blue * raw[index + 2] : raw[index])

	// Returns the plane row of source row y, or -1 when the plane has no samples on that row.
	const planeRow = (reducer: PlaneReducer) => {
		const geometry = reducer.geometry
		if (geometry === undefined) return -1
		const offset = y - geometry.sourceTop
		if (offset < 0 || offset % geometry.step !== 0) return -1
		const row = offset / geometry.step
		return row < geometry.height ? row : -1
	}

	const firstPassRow = (reducer: PlaneReducer, row: number) => {
		const geometry = reducer.geometry!
		const start = geometry.rawStart + row * geometry.rawRowStep
		const step = geometry.rawColumnStep
		const { codes, reservoir } = reducer
		let n = 0
		let sum = 0

		for (let k = 0, index = start; k < geometry.width; k++, index += step) {
			const value = readSample(reducer, index)

			if (!(value - value === 0)) {
				reducer.nonFinite++
				continue
			}

			n++
			sum += value
			if (value < reducer.min) reducer.min = value
			if (value > reducer.max) reducer.max = value

			if (numericLimits) {
				if (value <= 0) reducer.low++
				else if (value >= 1) reducer.high++
			}

			if (codes !== undefined) {
				const code = value * fullScale
				let rounded = Math.round(code)
				if (Math.abs(code - rounded) > INTEGER_CODE_TOLERANCE) reducer.binned = true
				if (rounded < 0) {
					rounded = 0
					reducer.binned = true
				} else if (rounded > fullScale) {
					rounded = fullScale
					reducer.binned = true
				}
				codes[rounded]++
			} else {
				reservoir!.push(value)
			}
		}

		if (n > 0) {
			const rowMean = sum / n
			let rowM2 = 0

			for (let k = 0, index = start; k < geometry.width; k++, index += step) {
				const value = readSample(reducer, index)
				if (value - value === 0) rowM2 += (value - rowMean) * (value - rowMean)
			}

			const total = reducer.finite + n
			const delta = rowMean - reducer.mean
			reducer.mean += (delta * n) / total
			reducer.m2 += rowM2 + (delta * delta * reducer.finite * n) / total
			reducer.finite = total
		}

		reducer.background?.collectRow(raw, start, step, row)
	}

	const secondPassRow = (reducer: PlaneReducer, row: number) => {
		const geometry = reducer.geometry!
		const robust = reducer.robust!
		const full = reducer.full!
		const step = geometry.rawColumnStep

		for (let k = 0, index = geometry.rawStart + row * geometry.rawRowStep; k < geometry.width; k++, index += step) {
			const value = readSample(reducer, index)
			if (!(value - value === 0)) continue
			robust.add(value, 1)
			full.add(value, 1)
		}
	}

	const endFirstPass = () => {
		let second = false

		for (const reducer of reducers) {
			if (reducer.finite === 0) continue
			const quantiles = reducer.codes !== undefined ? codeQuantiles(reducer.codes, reducer.finite, fullScale) : reservoirQuantiles(reducer.reservoir!)
			reducer.quantiles = quantiles
			let low = quantiles.low
			let high = quantiles.high
			if (!(high > low) && reducer.max > reducer.min) {
				low = reducer.min
				high = reducer.max
			}
			reducer.robust = new HistogramAccumulator(low, high)
			reducer.full = new HistogramAccumulator(reducer.min, reducer.max)

			if (reducer.codes !== undefined && !reducer.binned) {
				const codes = reducer.codes

				for (let code = 0; code <= fullScale; code++) {
					const count = codes[code]
					if (count === 0) continue
					reducer.robust.add(code / fullScale, count)
					reducer.full.add(code / fullScale, count)
				}
			} else {
				reducer.secondPass = true
				second = true
			}
		}

		return second
	}

	const consumeRows = (rows: number) => {
		let remaining = rows

		while (remaining > 0 && phase !== 'done') {
			if (phase === 'first') {
				for (const reducer of reducers) {
					const row = planeRow(reducer)
					if (row >= 0) firstPassRow(reducer, row)
				}
			} else {
				for (const reducer of reducers) {
					if (!reducer.secondPass) continue
					const row = planeRow(reducer)
					if (row >= 0) secondPassRow(reducer, row)
				}
			}

			remaining--

			if (++y === area.bottom) {
				y = area.top
				phase = phase === 'first' && endFirstPass() ? 'second' : 'done'
			}
		}

		return phase === 'done'
	}

	const finish = () => {
		if (result !== undefined) return result
		let complete = phase === 'done'
		while (!complete) complete = consumeRows(area.bottom - area.top)
		result = { area, planes: reducers.map((reducer) => planeStatistics(reducer, numericLimits)) }
		return result
	}

	return {
		get done() {
			return phase === 'done'
		},
		consumeRows,
		finish,
	}
}

// Computes the statistics of a normalized image synchronously; see createImageStatisticsScan.
export function analyzeImageStatistics(image: Image, options: ImageStatisticsOptions = {}): ImageStatisticsResult {
	return createImageStatisticsScan(image, options).finish()
}

// Builds the public statistics of a reducer whose passes are complete.
function planeStatistics(reducer: PlaneReducer, numericLimits: boolean): ImagePlaneStatistics {
	const { plane, finite, nonFinite } = reducer
	const limits = numericLimits ? { lowCount: reducer.low, highCount: reducer.high } : undefined
	const background = reducer.background?.finish()
	const method: QuantileMethod = reducer.codes !== undefined ? (reducer.binned ? 'binned' : 'exact') : reducer.reservoir!.approximate ? 'sampled' : 'exact'
	const quantileSamples = reducer.codes !== undefined ? finite : reducer.reservoir!.retainedCount
	const quantiles = reducer.quantiles

	if (finite === 0 || quantiles === undefined) {
		return { plane, finiteCount: 0, nonFiniteCount: nonFinite, quantileMethod: method, quantileSamples: 0, numericLimits: limits, background }
	}

	return {
		plane,
		finiteCount: finite,
		nonFiniteCount: nonFinite,
		min: reducer.min,
		max: reducer.max,
		mean: reducer.mean,
		standardDeviation: Math.sqrt(reducer.m2 / finite),
		median: quantiles.median,
		mad: quantiles.mad,
		robustSigma: STANDARD_DEVIATION_SCALE * quantiles.mad,
		p01: quantiles.p01,
		p99: quantiles.p99,
		quantileMethod: method,
		quantileSamples,
		numericLimits: limits,
		histograms: { robust: reducer.robust!.result(), full: reducer.full!.result() },
		background,
	}
}

// Order statistics of the reservoir of a plane, reordering its retained samples.
function reservoirQuantiles(reservoir: RobustReservoir): PlaneQuantiles {
	const median = reservoir.median()
	const mad = reservoir.madAround(median)
	return { median, mad, p01: reservoir.percentile(0.01), p99: reservoir.percentile(0.99), low: reservoir.percentile(ROBUST_DOMAIN_LOW), high: reservoir.percentile(ROBUST_DOMAIN_HIGH) }
}

// Order statistics of n samples counted per integer code 0..fullScale, in normalized units. Percentiles
// interpolate linearly between the ranks floor(p (n - 1)) and ceil(p (n - 1)), like percentileOf, so the
// median is the mean of the two middle samples of an even population.
function codeQuantiles(codes: Float64Array, n: number, fullScale: number): PlaneQuantiles {
	const quantile = (fraction: number) => interpolateRank(fraction, n, (rank) => codeAtRank(codes, rank, fullScale))
	const median = quantile(0.5)
	const center = median * fullScale
	const mad = interpolateRank(0.5, n, (rank) => deviationAtRank(codes, center, rank, fullScale))
	return { median, mad: mad / fullScale, p01: quantile(0.01), p99: quantile(0.99), low: quantile(ROBUST_DOMAIN_LOW), high: quantile(ROBUST_DOMAIN_HIGH) }
}

// Returns the normalized value of the sample at 0-based `rank` of the code histogram.
function codeAtRank(codes: Float64Array, rank: number, fullScale: number): number {
	let cumulative = 0

	for (let code = 0; code <= fullScale; code++) {
		cumulative += codes[code]
		if (cumulative > rank) return code / fullScale
	}

	return 1
}

// Interpolates the value at fractional rank fraction * (n - 1) between two integer ranks of `at`.
function interpolateRank(fraction: number, n: number, at: (rank: number) => number): number {
	const rank = fraction * (n - 1)
	const lower = Math.floor(rank)
	const upper = Math.ceil(rank)
	const low = at(lower)
	return lower === upper ? low : low + (at(upper) - low) * (rank - lower)
}

// Returns the absolute deviation |code - center|, in codes, of the sample at 0-based `rank` in ascending
// deviation order, walking outward from the center over the code histogram.
function deviationAtRank(codes: Float64Array, center: number, rank: number, fullScale: number): number {
	let left = Math.floor(center)
	let right = left + 1
	let cumulative = 0

	while (left >= 0 || right <= fullScale) {
		const leftDeviation = left >= 0 ? center - left : Number.POSITIVE_INFINITY
		const rightDeviation = right <= fullScale ? right - center : Number.POSITIVE_INFINITY

		if (leftDeviation <= rightDeviation) {
			cumulative += codes[left--]
			if (cumulative > rank) return leftDeviation
		} else {
			cumulative += codes[right++]
			if (cumulative > rank) return rightDeviation
		}
	}

	return 0
}
