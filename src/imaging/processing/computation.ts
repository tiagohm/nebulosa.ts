import { STANDARD_DEVIATION_SCALE } from '../../core/util'
import { validatePositiveInteger } from '../../core/validation'
import type { Rect } from '../../math/numerical/geometry'
import type { NumberArray } from '../../math/numerical/math'
import { Histogram } from '../../math/numerical/statistics'
import { truncatePixel } from '../model/image'
import { channelIndex, grayscaleFromChannel, type Image, type ImageChannelOrGray } from '../model/types'

// Pixel statistics for images: histogram, median, (normalized) median absolute deviation, iterative
// sigma clipping, the PixInsight adaptive display function (auto-stretch parameters), and background
// level estimators. Operates over a chosen channel/grayscale and optional region of interest; pixel
// values are in [0, 1] and binned at the requested bit depth.

// Maps a pixel value `p` at flat index `i` to a transformed value while building a histogram.
export type HistogramPixelTransform = (p: number, i: number) => number

// Central-tendency estimator for sigma clipping.
export type SigmaClipCenterMethod = 'median' | 'mean'

// Dispersion estimator for sigma clipping (standard deviation or median absolute deviation).
export type SigmaClipDispersionMethod = 'std' | 'mad'

// Options controlling histogram computation.
export interface HistogramOptions {
	// Channel or grayscale weighting to sample.
	channel?: ImageChannelOrGray
	// Region of interest; whole image when omitted.
	area?: Partial<Rect>
	// Per-pixel value transform applied before binning.
	transform: HistogramPixelTransform
	// Bit depth (number) or explicit per-channel bit depths.
	bits: NumberArray | number
	// Optional per-pixel sigma-clip mask excluding rejected pixels.
	sigmaClip?: Int8Array | Uint8Array
}

// Options for the adaptive display function (auto-stretch), extending histogram options.
export interface AdaptiveDisplayFunctionOptions extends HistogramOptions {
	meanBackground: number // Controls the global illumination of the displayed image
	clippingPoint: number // Controls the overall contrast of the displayed image
}

// Options for iterative sigma clipping of pixel values.
export interface SigmaClipOptions extends Omit<HistogramOptions, 'sigmaClip'> {
	// Center estimator.
	centerMethod: SigmaClipCenterMethod
	// Dispersion estimator.
	dispersionMethod: SigmaClipDispersionMethod
	// Lower rejection threshold, in sigmas below center.
	sigmaLower: number
	// Upper rejection threshold, in sigmas above center.
	sigmaUpper: number
	// Convergence tolerance on the center/dispersion change between iterations.
	tolerance: number
	// Maximum number of clipping iterations.
	maxIterations: number
	// Optional pre-existing rejection mask to seed the clip.
	mask?: Int8Array | Uint8Array
}

// Default target mean background for the adaptive display function (global brightness).
export const DEFAULT_MEAN_BACKGROUND = 0.25
// Default clipping point (in sigmas) for the adaptive display function (overall contrast).
export const DEFAULT_CLIPPING_POINT = -2.8

// Identity histogram pixel transform.
export const DEFAULT_HISTOGRAM_PIXEL_TRANSFORM: HistogramPixelTransform = (p) => p

// Default histogram options (16-bit, identity transform).
export const DEFAULT_HISTOGRAM_OPTIONS: Readonly<HistogramOptions> = {
	transform: DEFAULT_HISTOGRAM_PIXEL_TRANSFORM,
	bits: 16,
}

// Default adaptive display function options.
export const DEFAULT_ADAPTIVE_DISPLAY_FUNCTION_OPTIONS: Readonly<AdaptiveDisplayFunctionOptions> = {
	...DEFAULT_HISTOGRAM_OPTIONS,
	meanBackground: DEFAULT_MEAN_BACKGROUND,
	clippingPoint: DEFAULT_CLIPPING_POINT,
}

// Default sigma-clip options (mean center, std dispersion, +-3 sigma, 5 iterations).
export const DEFAULT_SIGMA_CLIP_OPTIONS: Readonly<SigmaClipOptions> = {
	...DEFAULT_HISTOGRAM_OPTIONS,
	centerMethod: 'mean',
	dispersionMethod: 'std',
	sigmaLower: 3,
	sigmaUpper: 3,
	tolerance: 1e-3,
	maxIterations: 5,
}

// Maximum supported histogram bit depth, limiting a default Int32 buffer to 64 MiB.
const MAX_HISTOGRAM_BITS = 24

// Allocates or clears a histogram bin buffer after validating its size.
function resolveHistogramBins(bits: NumberArray | number | undefined): NumberArray {
	bits ??= DEFAULT_HISTOGRAM_OPTIONS.bits

	if (typeof bits === 'number') {
		validatePositiveInteger(bits)
		if (bits > MAX_HISTOGRAM_BITS) throw new RangeError(`histogram bits must be <= ${MAX_HISTOGRAM_BITS}`)
		return new Int32Array(2 ** bits)
	}

	if (bits.length === 0) throw new RangeError('histogram buffer must not be empty')
	return bits.fill(0)
}

// Builds a histogram, optionally binning absolute deviations from a center after channel reduction.
function computeHistogram(image: Image, options: Partial<HistogramOptions>, deviationCenter?: number): Histogram {
	const channel = options.channel
	const area = options.area
	const sigmaClip = options.sigmaClip
	const transform = options.transform ?? DEFAULT_HISTOGRAM_PIXEL_TRANSFORM
	const h = resolveHistogramBins(options.bits)
	const max = h.length - 1
	const { raw, metadata } = image
	const { stride, width, height, channels, pixelCount } = metadata

	const pixelMask = sigmaClip !== undefined && sigmaClip.length === pixelCount
	if (sigmaClip !== undefined && !pixelMask && sigmaClip.length < raw.length) throw new RangeError(`sigmaClip must have length ${pixelCount} or >= ${raw.length}`)

	const left = Math.max(0, Math.min(area?.left ?? 0, width - 1))
	const top = Math.max(0, Math.min(area?.top ?? 0, height - 1))
	const right = Math.max(0, Math.min(area?.right ?? width - 1, width - 1))
	const bottom = Math.max(0, Math.min(area?.bottom ?? height - 1, height - 1))

	const offset = channelIndex(channel)
	const { red, green, blue } = grayscaleFromChannel(channel)
	const useGrayscale = channels === 3 && !(channel === 'RED' || channel === 'GREEN' || channel === 'BLUE')
	const identityTransform = transform === DEFAULT_HISTOGRAM_PIXEL_TRANSFORM
	const useDeviation = deviationCenter !== undefined

	if (useGrayscale) {
		for (let y = top; y <= bottom; y++) {
			let i = y * stride + left * channels
			const end = y * stride + (right + 1) * channels
			let pixel = y * width + left

			if (identityTransform) {
				if (sigmaClip === undefined) {
					for (; i < end; i += channels) {
						let value = raw[i] * red + raw[i + 1] * green + raw[i + 2] * blue
						if (useDeviation) value = Math.abs(value - deviationCenter)
						h[truncatePixel(value, max)]++
					}
				} else {
					for (; i < end; i += channels, pixel++) {
						if (sigmaClip[pixelMask ? pixel : i] !== 0) continue
						let value = raw[i] * red + raw[i + 1] * green + raw[i + 2] * blue
						if (useDeviation) value = Math.abs(value - deviationCenter)
						h[truncatePixel(value, max)]++
					}
				}
			} else if (sigmaClip === undefined) {
				for (; i < end; i += channels) {
					let value = transform(raw[i], i) * red + transform(raw[i + 1], i + 1) * green + transform(raw[i + 2], i + 2) * blue
					if (useDeviation) value = Math.abs(value - deviationCenter)
					h[truncatePixel(value, max)]++
				}
			} else {
				for (; i < end; i += channels, pixel++) {
					if (sigmaClip[pixelMask ? pixel : i] !== 0) continue
					let value = transform(raw[i], i) * red + transform(raw[i + 1], i + 1) * green + transform(raw[i + 2], i + 2) * blue
					if (useDeviation) value = Math.abs(value - deviationCenter)
					h[truncatePixel(value, max)]++
				}
			}
		}
	} else {
		for (let y = top; y <= bottom; y++) {
			let i = y * stride + left * channels + offset
			const end = y * stride + (right + 1) * channels + offset
			let pixel = y * width + left

			if (identityTransform) {
				if (sigmaClip === undefined) {
					for (; i < end; i += channels) {
						const value = useDeviation ? Math.abs(raw[i] - deviationCenter) : raw[i]
						h[truncatePixel(value, max)]++
					}
				} else {
					for (; i < end; i += channels, pixel++) {
						if (sigmaClip[pixelMask ? pixel : i] !== 0) continue
						const value = useDeviation ? Math.abs(raw[i] - deviationCenter) : raw[i]
						h[truncatePixel(value, max)]++
					}
				}
			} else if (sigmaClip === undefined) {
				for (; i < end; i += channels) {
					const transformed = transform(raw[i], i)
					const value = useDeviation ? Math.abs(transformed - deviationCenter) : transformed
					h[truncatePixel(value, max)]++
				}
			} else {
				for (; i < end; i += channels, pixel++) {
					if (sigmaClip[pixelMask ? pixel : i] !== 0) continue
					const transformed = transform(raw[i], i)
					const value = useDeviation ? Math.abs(transformed - deviationCenter) : transformed
					h[truncatePixel(value, max)]++
				}
			}
		}
	}

	return new Histogram(h, max)
}

// Median pixel value of the selected channel/region.
export function median(image: Image, options: Partial<HistogramOptions> = DEFAULT_HISTOGRAM_OPTIONS) {
	return histogram(image, options).median
}

// Median absolute deviation about `m`. When `normalized`, scales by the Gaussian-consistency factor so
// the result is comparable to a standard deviation.
export function medianAbsoluteDeviation(image: Image, m: number, normalized: boolean = false, options: Partial<HistogramOptions> = DEFAULT_HISTOGRAM_OPTIONS) {
	const mad = computeHistogram(image, options, m).median
	return normalized ? STANDARD_DEVIATION_SCALE * mad : mad
}

// Adaptive Display Function Algorithm
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Adaptive_Display_Function_Algorithm__
// Computes an auto-stretch midtone/shadow/highlight triple from the image's median and MAD.
// Returns [midtone, shadow, highlight], all in [0, 1], suitable for a screen transfer function.
export function adf(image: Image, options: Partial<AdaptiveDisplayFunctionOptions> = DEFAULT_ADAPTIVE_DISPLAY_FUNCTION_OPTIONS) {
	const bits = resolveHistogramBins(options.bits)
	options = { ...options, bits }
	const meanBackground = options.meanBackground ?? DEFAULT_ADAPTIVE_DISPLAY_FUNCTION_OPTIONS.meanBackground
	const clippingPoint = options.clippingPoint ?? DEFAULT_ADAPTIVE_DISPLAY_FUNCTION_OPTIONS.clippingPoint
	const med = median(image, options)
	const mad = medianAbsoluteDeviation(image, med, true, options)
	const upperHalf = med > 0.5
	const shadow = upperHalf || mad === 0 ? 0 : Math.min(1, Math.max(0, med + clippingPoint * mad))
	const highlight = !upperHalf || mad === 0 ? 1 : Math.min(1, Math.max(0, med - clippingPoint * mad))
	const x = upperHalf ? meanBackground : med - shadow
	const m = upperHalf ? highlight - med : meanBackground
	const midtone = x === 0 ? 0 : x === m ? 0.5 : x === 1 ? 1 : ((m - 1) * x) / ((2 * m - 1) * x - m)
	return [midtone, shadow, highlight] as const
}

// Builds a Histogram of the selected channel/grayscale over the optional region, applying the pixel
// transform and skipping sigma-clip-masked pixels. Color channels are combined by the grayscale weights
// when no single channel is requested.
export function histogram(image: Image, options: Partial<HistogramOptions> = DEFAULT_HISTOGRAM_OPTIONS) {
	return computeHistogram(image, options)
}

// Iteratively rejects outlier pixels beyond [center - sigmaLower*disp, center + sigmaUpper*disp],
// recomputing center and dispersion each pass until convergence, no new rejections, or maxIterations.
// Returns the rejection mask (1 = rejected); for color the whole pixel is rejected on a grayscale clip.
export function sigmaClip(image: Image, options: Partial<SigmaClipOptions> = DEFAULT_SIGMA_CLIP_OPTIONS) {
	const { channel, centerMethod, dispersionMethod, sigmaLower, sigmaUpper, tolerance, maxIterations } = Object.assign({}, DEFAULT_SIGMA_CLIP_OPTIONS, options)

	const { raw, metadata } = image
	const { red, green, blue } = grayscaleFromChannel(channel)
	const { pixelCount: n, channels } = metadata
	const mask = options.mask?.fill(0) ?? new Int8Array(raw.length)

	if (raw.length > mask.length) throw new Error(`mask must have length >= ${raw.length}`)

	const transform = options.transform ?? DEFAULT_SIGMA_CLIP_OPTIONS.transform
	const bits = options.bits === undefined || typeof options.bits === 'number' ? new Int32Array(1 << (options.bits ?? 16)) : options.bits
	// Exclude already-rejected pixels from the iteration statistics through the histogram
	// skip path. Mapping them into the histogram (e.g. to bin 0, or to |median| in the MAD)
	// instead of excluding them biases the center, dispersion, and clip bounds once the
	// rejected fraction grows, weakening convergence.
	options = { ...options, bits, transform, sigmaClip: mask } as HistogramOptions

	const isMono = channels === 1

	let lastCenter = 1

	for (let i = 0; i < maxIterations; i++) {
		const h = histogram(image, options)

		const center = centerMethod === 'mean' ? h.mean : h.median
		const dispersion = dispersionMethod === 'std' ? h.standardDeviation : medianAbsoluteDeviation(image, h.median, true, options)

		if (!Number.isFinite(dispersion) || dispersion === 0) break

		// Check convergence
		if (Math.abs(center - lastCenter) < tolerance * Math.abs(center)) break

		lastCenter = center

		const lower = center - sigmaLower * dispersion
		const upper = center + sigmaUpper * dispersion

		let count = 0

		if (isMono) {
			for (let i = 0; i < n; i++) {
				if (mask[i] === 1) continue

				const p = raw[i]

				if (p < lower || p > upper) {
					mask[i] = 1
					count++
				}
			}
		} else if (channel === 'RED' || channel === 'GREEN' || channel === 'BLUE') {
			for (let i = 0, k = channelIndex(channel); i < n; i++, k += 3) {
				if (mask[k] === 1) continue

				const p = raw[k]

				if (p < lower || p > upper) {
					mask[k] = 1
					count++
				}
			}
		} else {
			for (let i = 0, k = 0; i < n; i++, k += 3) {
				if (mask[k] === 1) continue

				const p = raw[k] * red + raw[k + 1] * green + raw[k + 2] * blue

				if (p < lower || p > upper) {
					mask[k] = 1
					mask[k + 1] = 1
					mask[k + 2] = 1
					count++
				}
			}
		}

		// Good!
		if (count === 0) break
	}

	return mask
}

// Estimates the sky background as the median of the sigma-clipped (median/MAD) pixels.
export function estimateBackground(image: Image, options?: Partial<Omit<SigmaClipOptions, 'centerMethod' | 'dispersionMethod'>>) {
	return median(image, { ...options, sigmaClip: sigmaClip(image, { ...options, centerMethod: 'median', dispersionMethod: 'mad' }) })
}

// Estimates the background using the empirical mode approximation 2.5*median - 1.5*mean.
export function estimateBackgroundUsingMode(image: Image, options?: Partial<HistogramOptions>) {
	const { mean, median } = histogram(image, options)
	return 2.5 * median - 1.5 * mean
}
