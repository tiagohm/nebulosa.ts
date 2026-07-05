import type { ChrominanceSubsampling } from '../../bindings/imaging/libturbojpeg'
import type { Bitpix, FitsHeader } from '../../io/formats/fits/fits'
import type { Rect, Size } from '../../math/numerical/geometry'
import type { NumberArray } from '../../math/numerical/math'

// Shared image-processing types, configuration interfaces, default option sets, and small helpers for
// the imaging model. Defines the in-memory Image shape, channel/grayscale conventions, and the option
// contracts for the processing operations (convolution, stretches, histogram, curves, sigma clipping,
// background neutralization). Pixel data is stored as a flat Float32/Float64 raw buffer.

// A color channel of an RGB image.
export type ImageChannel = 'RED' | 'GREEN' | 'BLUE'

// Supported image container formats.
export type ImageFormat = 'jpeg' | 'fits' | 'xisf'

// Color filter array (Bayer) pixel pattern.
export type CfaPattern = 'RGGB' | 'BGGR' | 'GBRG' | 'GRBG' | 'GRGB' | 'GBGR' | 'RGBG' | 'BGRG'

// Per-channel weights summing a color pixel to a single luminance value.
export type Grayscale = Readonly<Record<Lowercase<ImageChannel>, number>>

// A named grayscale weighting (BT.709, RMY, NTSC Y) or an explicit weight set.
export type GrayscaleAlgorithm = 'BT709' | 'RMY' | 'Y' | Grayscale

// A single channel, a grayscale weighting, or the generic 'GRAY' luminance.
export type ImageChannelOrGray = ImageChannel | GrayscaleAlgorithm | 'GRAY'

// Maps a pixel value `p` at flat index `i` to a transformed value while building a histogram.
export type HistogramPixelTransform = (p: number, i: number) => number

// Central-tendency estimator for sigma clipping.
export type SigmaClipCenterMethod = 'median' | 'mean'

// Dispersion estimator for sigma clipping (standard deviation or median absolute deviation).
export type SigmaClipDispersionMethod = 'std' | 'mad'

// Backing typed array for raw pixel data (single or double precision).
export type ImageRawType = Float64Array | Float32Array

// Per-format options when serializing an image.
export interface WriteImageToFormatOptions {
	jpeg: {
		// JPEG quality 0..100.
		quality?: number
		// Chroma subsampling scheme.
		chrominanceSubsampling?: ChrominanceSubsampling
	}
}

// An in-memory image: its FITS header, derived metadata, and the flat raw pixel buffer.
export interface Image {
	readonly header: FitsHeader
	readonly metadata: ImageMetadata
	readonly raw: ImageRawType
}

// Geometry and storage metadata derived from an image's header.
export interface ImageMetadata extends Readonly<Size> {
	// Number of color channels (1 grayscale, 3 RGB).
	readonly channels: number
	// Pixels per row.
	readonly stride: number
	// Total pixels per channel (width * height).
	readonly pixelCount: number
	// Bytes per row.
	readonly strideInBytes: number
	// Bytes per pixel sample.
	readonly pixelSizeInBytes: number
	// FITS BITPIX of the source data.
	readonly bitpix: Bitpix
	// Bayer pattern if the data is a raw CFA mosaic, otherwise undefined.
	readonly bayer: CfaPattern | undefined
}

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

// BT.709 / sRGB luminance weights.
export const BT709_GRAYSCALE: Grayscale = { red: 0.2125, green: 0.7154, blue: 0.0721 } // standard sRGB
// "Red-minus-Y" style luminance weights.
export const RMY_GRAYSCALE: Grayscale = { red: 0.5, green: 0.419, blue: 0.081 }
// NTSC luminance weights.
export const Y_GRAYSCALE: Grayscale = { red: 0.299, green: 0.587, blue: 0.114 } // NTSC
// Red-only weighting (extracts the red channel).
export const RED_GRAYSCALE: Grayscale = { red: 1, green: 0, blue: 0 }
// Green-only weighting (extracts the green channel).
export const GREEN_GRAYSCALE: Grayscale = { red: 0, green: 1, blue: 0 }
// Blue-only weighting (extracts the blue channel).
export const BLUE_GRAYSCALE: Grayscale = { red: 0, green: 0, blue: 1 }
// Default grayscale weighting (BT.709).
export const DEFAULT_GRAYSCALE = BT709_GRAYSCALE

// Lookup from a named channel/grayscale to its weight set.
export const GRAYSCALES: Readonly<Record<Exclude<ImageChannelOrGray, Grayscale>, Grayscale>> = {
	GRAY: DEFAULT_GRAYSCALE,
	RED: RED_GRAYSCALE,
	GREEN: GREEN_GRAYSCALE,
	BLUE: BLUE_GRAYSCALE,
	BT709: BT709_GRAYSCALE,
	RMY: RMY_GRAYSCALE,
	Y: Y_GRAYSCALE,
}

// Default serialization options (lossless JPEG settings).
export const DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS = {
	jpeg: {
		quality: 100,
		chrominanceSubsampling: '4:4:4',
	},
} as const

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

// Type guard: true when a value has the Image shape (header, metadata, raw).
export function isImage(image?: object): image is Image {
	return !!image && 'header' in image && 'metadata' in image && 'raw' in image
}

// Maps a channel to its index in the raw buffer (RED/GRAY 0, GREEN 1, BLUE 2).
export function channelIndex(channel?: ImageChannelOrGray) {
	return channel === 'GREEN' ? 1 : channel === 'BLUE' ? 2 : 0
}

// Resolves a channel/grayscale selector to its concrete weight set, defaulting to BT.709.
export function grayscaleFromChannel(channel?: ImageChannelOrGray): Grayscale {
	return typeof channel === 'object' ? channel : channel ? GRAYSCALES[channel] : DEFAULT_GRAYSCALE
}

// Allocates a same-type raw pixel buffer for the cropped ROI.
export function makeImageRawTypedArray(source: ImageRawType, size: number): ImageRawType {
	return source.BYTES_PER_ELEMENT === 4 ? new Float32Array(size) : new Float64Array(size)
}
