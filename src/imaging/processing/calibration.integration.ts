import { STANDARD_DEVIATION_SCALE } from '../../math/numerical/statistics'
import { RobustReservoir } from '../analysis/robust'
import type { ImageRawType } from '../model/types'

// Temporal integration of calibration frames in sensor coordinates. Every output sample combines the
// samples of one pixel and channel across frames, with no registration, interpolation, debayering,
// background model, or normalization of its own, so bias pedestal, amp glow, and stable hot pixels
// survive while transient outliers do not. The functions work on rows a caller streams from files,
// never on whole stacks, and take samples in the caller's units: digital numbers for dark, bias and
// dark-flat frames, and dimensionless values for normalized flats. CFA planes are the four phases
// ((y & 1) << 1) | (x & 1) in image-local coordinates, so rows must keep their original y.

// How the samples of one pixel are combined across frames.
export type CalibrationCombination = 'mean' | 'median' | 'sigmaClip'

// Numerical policy of an integration.
export interface CalibrationIntegrationOptions {
	// Combination method.
	readonly method: CalibrationCombination
	// Rejection limits below and above the center, in robust standard deviations; positive. Default 3.
	readonly sigmaLow?: number
	readonly sigmaHigh?: number
	// Most rejection passes per pixel; at least 1. Default 5.
	readonly maxIterations?: number
	// Smallest dispersion used for rejection, in sample units; positive. Quantized data has a zero MAD
	// where most samples are equal, and this floor keeps a neighbouring code from being an outlier.
	// Default 1, a digital number.
	readonly scaleFloor?: number
	// Fewest finite samples a pixel needs; at least 1. Default 1. A pixel below it becomes NaN.
	readonly minimumSamples?: number
}

// Aggregated evidence of an integration. Fields only grow, so one instance can span many rows.
export interface CalibrationIntegrationDiagnostics {
	// Output samples computed.
	samples: number
	// Input samples rejected below and above the center.
	rejectedLow: number
	rejectedHigh: number
	// Non-finite input samples ignored.
	nonFinite: number
	// Output samples left NaN because too few finite inputs remained.
	undersampled: number
	// Pixels whose rejection stopped at the retained-sample limit.
	clipLimited: number
	// Input samples rejected per frame, in the order of the frames.
	readonly rejectedPerFrame: Float64Array
}

// Per-plane level of a set of samples.
export interface CalibrationPlaneLevel {
	// Median, in sample units; NaN when the plane has no finite sample.
	readonly median: number
	// Robust standard deviation from the MAD, in sample units.
	readonly sigma: number
}

// Largest sample vector sorted by insertion; beyond it a typed-array sort is faster.
const INSERTION_SORT_LIMIT = 64

// Default rejection limit, in robust standard deviations.
const DEFAULT_SIGMA = 3

// Default number of rejection passes per pixel.
const DEFAULT_MAX_ITERATIONS = 5

// Fewest frames with a meaningful median and MAD; below it sigma clipping degrades to a mean.
const MINIMUM_SIGMA_CLIP_FRAMES = 3

// Creates empty diagnostics for `frames` input frames.
export function createCalibrationIntegrationDiagnostics(frames: number): CalibrationIntegrationDiagnostics {
	return { samples: 0, rejectedLow: 0, rejectedHigh: 0, nonFinite: 0, undersampled: 0, clipLimited: 0, rejectedPerFrame: new Float64Array(frames) }
}

// Returns the method really applied to `frames` frames. Sigma clipping has no statistics to work with
// below three samples, so it becomes a plain mean, which callers must report as a low sample count.
export function effectiveCalibrationCombination(method: CalibrationCombination, frames: number): CalibrationCombination {
	return method === 'sigmaClip' && frames < MINIMUM_SIGMA_CLIP_FRAMES ? 'mean' : method
}

// Sorts the first `count` values ascending in place.
function sortValues(values: Float64Array, count: number) {
	if (count > INSERTION_SORT_LIMIT) {
		values.subarray(0, count).sort()
		return
	}

	for (let i = 1; i < count; i++) {
		const value = values[i]
		let j = i - 1
		for (; j >= 0 && values[j] > value; j--) values[j + 1] = values[j]
		values[j + 1] = value
	}
}

// Computes the median of ascending values in [start, end).
function sortedMedian(values: Float64Array, start: number, end: number) {
	const count = end - start
	const mid = start + (count >> 1)
	return (count & 1) === 1 ? values[mid] : values[mid - 1] * 0.5 + values[mid] * 0.5
}

// Computes the MAD about `center` of ascending values in [start, end) by walking outwards from the
// center, which visits deviations in order without sorting them. `center` is the median of the range.
function sortedMedianAbsoluteDeviation(values: Float64Array, start: number, end: number, center: number) {
	const count = end - start
	const target = count >> 1
	let left = start + ((count - 1) >> 1)
	let right = left + 1
	let previous = 0
	let current = 0

	for (let i = 0; i <= target; i++) {
		const low = left >= start ? center - values[left] : Number.POSITIVE_INFINITY
		const high = right < end ? values[right] - center : Number.POSITIVE_INFINITY
		previous = current

		if (low <= high) {
			current = low
			left--
		} else {
			current = high
			right++
		}
	}

	return (count & 1) === 1 ? current : previous * 0.5 + current * 0.5
}

// Combines one row buffer per frame into `output`, in order. `rows[f][s]` and `output[s]` are the same
// sensor sample for every s below `count`. Non-finite inputs are ignored, and a pixel without enough
// finite samples becomes NaN and is counted, so the caller can refuse the product. Rejection trims the
// sorted samples at most down to half of them, because a tie of outliers must not outvote the pixel.
// The result does not depend on how a caller splits an image into rows. Mutates `output` and `diagnostics`.
export function integrateCalibrationRows(rows: readonly Readonly<ImageRawType>[], count: number, output: ImageRawType, options: CalibrationIntegrationOptions, diagnostics: CalibrationIntegrationDiagnostics) {
	const frames = rows.length
	const method = effectiveCalibrationCombination(options.method, frames)
	const sigmaLow = options.sigmaLow ?? DEFAULT_SIGMA
	const sigmaHigh = options.sigmaHigh ?? DEFAULT_SIGMA
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
	const scaleFloor = options.scaleFloor ?? 1
	const minimumSamples = options.minimumSamples ?? 1
	const values = new Float64Array(frames)
	const { rejectedPerFrame } = diagnostics

	for (let s = 0; s < count; s++) {
		let finite = 0

		for (let f = 0; f < frames; f++) {
			const value = rows[f][s]
			if (Number.isFinite(value)) values[finite++] = value
			else diagnostics.nonFinite++
		}

		diagnostics.samples++

		if (finite < minimumSamples || finite === 0) {
			output[s] = Number.NaN
			diagnostics.undersampled++
			continue
		}

		if (method === 'mean' || (method === 'sigmaClip' && finite < MINIMUM_SIGMA_CLIP_FRAMES)) {
			let sum = 0
			for (let i = 0; i < finite; i++) sum += values[i]
			output[s] = sum / finite
			continue
		}

		sortValues(values, finite)

		if (method === 'median') {
			output[s] = sortedMedian(values, 0, finite)
			continue
		}

		const minimumRetained = Math.max(2, Math.ceil(finite * 0.5))
		let start = 0
		let end = finite

		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const center = sortedMedian(values, start, end)
			const scale = Math.max(STANDARD_DEVIATION_SCALE * sortedMedianAbsoluteDeviation(values, start, end, center), scaleFloor)
			const low = center - sigmaLow * scale
			const high = center + sigmaHigh * scale
			let nextStart = start
			let nextEnd = end
			while (nextStart < end && values[nextStart] < low) nextStart++
			while (nextEnd > nextStart && values[nextEnd - 1] > high) nextEnd--
			if (nextStart === start && nextEnd === end) break

			if (nextEnd - nextStart < minimumRetained) {
				diagnostics.clipLimited++
				break
			}

			start = nextStart
			end = nextEnd
		}

		let sum = 0
		for (let i = start; i < end; i++) sum += values[i]
		output[s] = sum / (end - start)

		if (end - start < finite) {
			const lowest = values[start]
			const highest = values[end - 1]

			for (let f = 0; f < frames; f++) {
				const value = rows[f][s]

				if (value < lowest) {
					diagnostics.rejectedLow++
					rejectedPerFrame[f]++
				} else if (value > highest) {
					diagnostics.rejectedHigh++
					rejectedPerFrame[f]++
				}
			}
		}
	}
}

// Subtracts a correction from `target` sample by sample, in place. Results keep their sign, so the
// target must be a floating-point buffer in the units of the correction.
export function subtractCalibrationRows(target: ImageRawType, correction: Readonly<ImageRawType>, count: number) {
	for (let i = 0; i < count; i++) target[i] -= correction[i]
}

// Returns the plane of a sample: the CFA phase of a mosaic, or the channel otherwise.
export function calibrationPlane(x: number, y: number, mosaic: boolean, channel: number) {
	return mosaic ? ((y & 1) << 1) | (x & 1) : channel
}

// Number of independent planes of an image.
export function calibrationPlaneCount(mosaic: boolean, channels: number) {
	return mosaic ? 4 : channels
}

// Divides rows of `width` samples by the level of the plane of each sample, in place. `firstRow` is the
// zero-based image row of the first sample, which fixes the CFA phase of a mosaic; a channel-separated
// image passes its `channel`. Multiplicative normalization keeps vignetting and dust structure.
export function divideCalibrationPlanes(samples: ImageRawType, width: number, rows: number, firstRow: number, levels: Readonly<ArrayLike<number>>, mosaic: boolean, channel: number = 0) {
	for (let row = 0, i = 0; row < rows; row++) {
		const y = firstRow + row
		for (let x = 0; x < width; x++, i++) samples[i] /= levels[calibrationPlane(x, y, mosaic, channel)]
	}
}

// Deterministic fixed-memory estimator of the level of every plane of one image, fed row by row.
export class CalibrationPlaneLevels {
	readonly #reservoirs: readonly RobustReservoir[]

	// Prepares `planes` estimators for planes of about `samplesPerPlane` samples each.
	constructor(
		planes: number,
		samplesPerPlane: number,
		readonly mosaic: boolean,
	) {
		this.#reservoirs = Array.from({ length: planes }, () => new RobustReservoir(samplesPerPlane))
	}

	// Considers rows of `width` samples starting at the zero-based image row `firstRow`. Non-finite samples are ignored.
	push(samples: Readonly<ImageRawType>, width: number, rows: number, firstRow: number, channel: number = 0) {
		const reservoirs = this.#reservoirs

		for (let row = 0, i = 0; row < rows; row++) {
			const y = firstRow + row
			for (let x = 0; x < width; x++, i++) reservoirs[calibrationPlane(x, y, this.mosaic, channel)].push(samples[i])
		}
	}

	// Returns the level of every plane. Levels are approximate for planes beyond the reservoir capacity.
	levels(): readonly CalibrationPlaneLevel[] {
		return this.#reservoirs.map((reservoir) => {
			const median = reservoir.median()
			return { median, sigma: reservoir.madAround(median, true) }
		})
	}
}
