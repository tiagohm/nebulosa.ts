import { makeImageRawTypedArray, type Image, type ImageMetadata, type ImageRawType } from '../model/types'
import { multiscaleDetailScales, multiscaleNeedsDenoise, resolveMultiscaleLayer, resolveMultiscaleLayers, resolveMultiscaleResidualGain, type MultiscaleTransformLayerOptions, type MultiscaleTransformOptions } from './multiscale'

// Multiscale median transform (MMT) similar to PixInsight's: decomposes the image into dyadic detail
// layers using a quantized sliding-median filter, applies per-layer threshold/amount/bias, and
// reconstructs in place without clamping the raw buffer.

// Quantization bit depth of the sliding-median histogram used by the multiscale median transform.
const MMT_MEDIAN_HISTOGRAM_BITS = 14
// Number of fine histogram bins (2^bits).
const MMT_MEDIAN_HISTOGRAM_SIZE = 1 << MMT_MEDIAN_HISTOGRAM_BITS
// Index of the last fine bin.
const MMT_MEDIAN_HISTOGRAM_LAST = MMT_MEDIAN_HISTOGRAM_SIZE - 1
// Bits grouping fine bins into the coarse (two-level) histogram for fast selection.
const MMT_MEDIAN_HISTOGRAM_GROUP_BITS = 6
// Fine bins per coarse group (2^groupBits).
const MMT_MEDIAN_HISTOGRAM_GROUP_SIZE = 1 << MMT_MEDIAN_HISTOGRAM_GROUP_BITS
// Number of coarse groups.
const MMT_MEDIAN_HISTOGRAM_GROUP_COUNT = MMT_MEDIAN_HISTOGRAM_SIZE >> MMT_MEDIAN_HISTOGRAM_GROUP_BITS

// Per-detail-layer options of the multiscale median transform.
export interface MultiscaleMedianTransformLayerOptions extends MultiscaleTransformLayerOptions {}

// Options for the multiscale median transform (wavelet-like detail manipulation).
export interface MultiscaleMedianTransformOptions extends MultiscaleTransformOptions {}

// Default per-layer multiscale median transform options (no thresholding, unit gain).
export const DEFAULT_MMT_LAYER_OPTIONS: Readonly<MultiscaleMedianTransformLayerOptions> = {
	threshold: 0,
	amount: 1,
	bias: 0,
}

// Default multiscale median transform options (3 layers, unit residual gain).
export const DEFAULT_MMT_OPTIONS: Readonly<MultiscaleMedianTransformOptions> = {
	layers: 3,
	detailLayers: [],
	residualGain: 1,
}

// Tracks the quantization range for one image channel.
function multiscaleMedianHistogramRange(raw: ImageRawType, channels: number, channel: number) {
	let min = Number.POSITIVE_INFINITY
	let max = Number.NEGATIVE_INFINITY

	for (let i = channel; i < raw.length; i += channels) {
		const value = raw[i]

		if (value < min) min = value
		if (value > max) max = value
	}

	return [min, max] as const
}

// Quantizes one value into the MMT histogram domain.
function multiscaleMedianHistogramBin(value: number, min: number, inverse: number) {
	const bin = Math.round((value - min) * inverse)
	if (bin <= 0) return 0
	if (bin >= MMT_MEDIAN_HISTOGRAM_LAST) return MMT_MEDIAN_HISTOGRAM_LAST
	return bin
}

// Updates both fine and coarse histograms for one quantized sample.
function multiscaleMedianHistogramUpdate(fine: Int32Array, coarse: Int32Array, bin: number, delta: number) {
	fine[bin] += delta
	coarse[bin >>> MMT_MEDIAN_HISTOGRAM_GROUP_BITS] += delta
}

// Adds or removes a full window column from the histogram.
function multiscaleMedianHistogramColumn(raw: ImageRawType, stride: number, channels: number, channel: number, x: number, y0: number, y1: number, min: number, inverse: number, fine: Int32Array, coarse: Int32Array, delta: number) {
	for (let y = y0, i = y0 * stride + x * channels + channel; y <= y1; y++, i += stride) {
		const bin = multiscaleMedianHistogramBin(raw[i], min, inverse)
		multiscaleMedianHistogramUpdate(fine, coarse, bin, delta)
	}
}

// Finds the first bin whose cumulative population exceeds the requested rank.
function multiscaleMedianHistogramSelect(fine: Int32Array, coarse: Int32Array, rank: number) {
	let cumulative = 0
	let group = 0

	for (; group < coarse.length; group++) {
		const next = cumulative + coarse[group]
		if (next > rank) break
		cumulative = next
	}

	const start = group << MMT_MEDIAN_HISTOGRAM_GROUP_BITS
	const end = Math.min(start + MMT_MEDIAN_HISTOGRAM_GROUP_SIZE, fine.length)

	for (let bin = start; bin < end; bin++) {
		cumulative += fine[bin]
		if (cumulative > rank) return bin
	}

	return MMT_MEDIAN_HISTOGRAM_LAST
}

// Returns the quantized median value for the current histogram population.
function multiscaleMedianHistogramMedian(fine: Int32Array, coarse: Int32Array, count: number, min: number, scale: number) {
	if (count <= 1 || scale === 0) return min

	const lower = multiscaleMedianHistogramSelect(fine, coarse, (count - 1) >>> 1)
	const upper = multiscaleMedianHistogramSelect(fine, coarse, count >>> 1)
	return min + (lower + upper) * 0.5 * scale
}

// Applies a quantized Huang-style sliding median with truncated borders.
function multiscaleMedianFilter(raw: ImageRawType, output: ImageRawType, metadata: ImageMetadata, radius: number) {
	if (radius <= 0) {
		output.set(raw)
		return output
	}

	const { width, height, channels, stride } = metadata
	const fine = new Int32Array(MMT_MEDIAN_HISTOGRAM_SIZE)
	const coarse = new Int32Array(MMT_MEDIAN_HISTOGRAM_GROUP_COUNT)

	for (let channel = 0; channel < channels; channel++) {
		const range = multiscaleMedianHistogramRange(raw, channels, channel)

		const [min, max] = range
		const scale = (max - min) / MMT_MEDIAN_HISTOGRAM_LAST

		if (scale === 0) {
			for (let y = 0, i = channel; y < height; y++) {
				for (let x = 0; x < width; x++, i += channels) {
					output[i] = min
				}
			}

			continue
		}

		const inverse = 1 / scale

		for (let y = 0; y < height; y++) {
			const y0 = Math.max(0, y - radius)
			const y1 = Math.min(height - 1, y + radius)
			const rowCount = y1 - y0 + 1

			fine.fill(0)
			coarse.fill(0)

			for (let x = 0, end = Math.min(width - 1, radius); x <= end; x++) {
				multiscaleMedianHistogramColumn(raw, stride, channels, channel, x, y0, y1, min, inverse, fine, coarse, 1)
			}

			for (let x = 0, i = y * stride + channel; x < width; x++, i += channels) {
				const left = Math.max(0, x - radius)
				const right = Math.min(width - 1, x + radius)
				const count = rowCount * (right - left + 1)

				output[i] = multiscaleMedianHistogramMedian(fine, coarse, count, min, scale)

				const removeX = x - radius

				if (removeX >= 0) {
					multiscaleMedianHistogramColumn(raw, stride, channels, channel, removeX, y0, y1, min, inverse, fine, coarse, -1)
				}

				const addX = x + radius + 1

				if (addX < width) {
					multiscaleMedianHistogramColumn(raw, stride, channels, channel, addX, y0, y1, min, inverse, fine, coarse, 1)
				}
			}
		}
	}

	return output
}

// Applies a redundant dyadic multiscale median transform similar to PixInsight's MMT.
export function multiscaleMedianTransform(image: Image, options: Partial<MultiscaleMedianTransformOptions> = DEFAULT_MMT_OPTIONS): Image {
	const layers = resolveMultiscaleLayers(options.layers, DEFAULT_MMT_OPTIONS.layers)

	if (layers === 0) return image

	const detailLayers = options.detailLayers ?? DEFAULT_MMT_OPTIONS.detailLayers
	const residualGain = resolveMultiscaleResidualGain(options.residualGain, DEFAULT_MMT_OPTIONS.residualGain)
	const { raw, metadata } = image
	const n = raw.length
	let working: ImageRawType = raw.slice()
	let filtered = makeImageRawTypedArray(raw, n)
	const denoise = multiscaleNeedsDenoise(detailLayers, layers, DEFAULT_MMT_LAYER_OPTIONS)
	const samples = denoise ? new Float64Array(metadata.pixelCount) : undefined
	const scales = denoise ? new Float64Array(metadata.channels) : undefined

	raw.fill(0)

	for (let layer = 0; layer < layers; layer++) {
		const radius = 2 ** layer
		const detail = resolveMultiscaleLayer(detailLayers[layer], DEFAULT_MMT_LAYER_OPTIONS)

		multiscaleMedianFilter(working, filtered, metadata, radius)

		const channelScales = detail.threshold > 0 && detail.amount > 0 ? multiscaleDetailScales(working, filtered, metadata.channels, samples!, scales!) : undefined

		for (let i = 0; i < n; i++) {
			let value = working[i] - filtered[i]

			if (channelScales !== undefined) {
				const limit = detail.threshold * channelScales[i % metadata.channels]

				if (Math.abs(value) <= limit) {
					value *= 1 - detail.amount
				}
			}

			raw[i] += value * detail.gain
		}

		const swap = working
		working = filtered
		filtered = swap
	}

	if (residualGain !== 0) {
		for (let i = 0; i < n; i++) {
			raw[i] += working[i] * residualGain
		}
	}

	return image
}
