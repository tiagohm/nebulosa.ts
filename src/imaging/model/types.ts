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

// Highlight/green-cast protection method for the SCNR (subtractive chromatic noise reduction) operation.
export type SCNRProtectionMethod = 'MAXIMUM_MASK' | 'ADDITIVE_MASK' | 'AVERAGE_NEUTRAL' | 'MAXIMUM_NEUTRAL' | 'MINIMUM_NEUTRAL'

// FFT frequency-domain filter direction.
export type FFTFilterType = 'lowPass' | 'highPass'

// SCNR kernel: given the three channel values and an amount, returns the corrected middle channel.
export type SCNRAlgorithm = (a: number, b: number, c: number, amount: number) => number

// Strategy for remapping the neutralized background level.
export type BackgroundNeutralizationMode = 'targetBackground' | 'rescale' | 'rescaleAsNeeded' | 'truncate'

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

// Spline interpolation used by the curves transformation.
export type CurvesTransformationInterpolation = 'cubicHermite' | 'akima' | 'catmullRom' | 'naturalCubic'

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

// A convolution kernel and its normalization divisor.
export interface ConvolutionKernel extends Readonly<Size> {
	// Row-major kernel weights, width*height long.
	readonly kernel: Readonly<NumberArray>
	// Divisor applied to the weighted sum (kernel normalization).
	readonly divisor: number
}

// Common convolution behavior options.
export interface ConvolutionOptions {
	// Recompute the divisor at edges from the in-bounds kernel weights instead of clamping.
	dynamicDivisorForEdges: boolean
	// Normalize the kernel so its weights sum to one.
	normalize: boolean
}

// Options for a Gaussian blur convolution.
export interface GaussianBlurConvolutionOptions extends ConvolutionOptions {
	// Standard deviation of the Gaussian, in pixels.
	sigma: number
	// Kernel side length, in pixels.
	size: number
}

// Per-detail-layer options of the multiscale median transform.
export interface MultiscaleMedianTransformLayerOptions {
	// Coefficient threshold below which detail is suppressed.
	readonly threshold: number
	// Gain applied to the layer's detail coefficients.
	readonly amount: number
	// Bias added to the layer's detail coefficients.
	readonly bias: number
}

// Options for the multiscale median transform (wavelet-like detail manipulation).
export interface MultiscaleMedianTransformOptions {
	// Number of decomposition layers.
	readonly layers: number
	// Per-layer overrides, indexed by detail layer.
	readonly detailLayers: readonly Partial<MultiscaleMedianTransformLayerOptions>[]
	// Gain applied to the residual (smoothest) layer.
	readonly residualGain: number
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

// One channel's control points for the curves transformation.
export interface CurvesTransformationCurve {
	readonly channel: ImageChannelOrGray
	// Input control-point values (ascending).
	readonly x: Readonly<NumberArray>
	// Output values at each control point.
	readonly y: Readonly<NumberArray>
}

// Options for the curves transformation.
export interface CurvesTransformationOptions {
	// Bit depth of the input/output values.
	readonly bits: number
	// Spline interpolation between control points.
	readonly interpolation: CurvesTransformationInterpolation
	// Per-channel curves; undefined entries leave that channel unchanged.
	readonly curves: readonly (CurvesTransformationCurve | undefined)[]
}

// Options for applying a screen transfer function (display stretch).
export interface ApplyScreenTransferFunctionOptions {
	channel?: ImageChannelOrGray
	// Bit depth of the data.
	bits: number
}

// Options for the arcsinh stretch.
export interface ArcsinhStretchOptions {
	// Strength of the arcsinh stretch.
	stretchFactor: number
	// Black point clipped before stretching, 0..1.
	blackPoint: number
	// Preserve highlight color ratios while stretching.
	protectHighlights: boolean
	// Stretch luminance in an RGB working space rather than per channel.
	useRgbWorkingSpace: boolean
	// Grayscale weighting defining the RGB working space.
	rgbWorkingSpace: GrayscaleAlgorithm
}

// Fitted parameters approximating an arcsinh stretch.
export interface ApproximateArcsinhStretchParameters {
	readonly stretchFactor: number
	readonly blackPoint: number
}

// Options for background neutralization (removing a color cast from the sky background).
export interface BackgroundNeutralizationOptions {
	// Lower reference level (background floor), 0..1.
	lowerLimit: number
	// Upper reference level, 0..1.
	upperLimit: number
	// Desired background level after neutralization, 0..1.
	targetBackground: number
	// How the neutralized values are remapped.
	mode: BackgroundNeutralizationMode
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

// Default convolution options.
export const DEFAULT_CONVOLUTION_OPTIONS: Readonly<ConvolutionOptions> = {
	dynamicDivisorForEdges: true,
	normalize: true,
}

// Default Gaussian blur (sigma 1.4, 5x5 kernel).
export const DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS: Readonly<GaussianBlurConvolutionOptions> = {
	...DEFAULT_CONVOLUTION_OPTIONS,
	sigma: 1.4,
	size: 5,
}

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

// Identity histogram pixel transform.
export const DEFAULT_HISTOGRAM_PIXEL_TRANSFORM: HistogramPixelTransform = (p) => p

// Default histogram options (16-bit, identity transform).
export const DEFAULT_HISTOGRAM_OPTIONS: Readonly<HistogramOptions> = {
	transform: DEFAULT_HISTOGRAM_PIXEL_TRANSFORM,
	bits: 16,
}

// Default curves transformation (16-bit, Akima spline, no-op curve).
export const DEFAULT_CURVES_TRANSFORMATION_OPTIONS: Readonly<CurvesTransformationOptions> = {
	bits: 16,
	interpolation: 'akima',
	curves: [undefined],
}

// Default screen transfer function options (grayscale, 16-bit).
export const DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS: Readonly<ApplyScreenTransferFunctionOptions> = {
	channel: 'GRAY',
	bits: 16,
}

// Default arcsinh stretch options (no stretch, no highlight protection).
export const DEFAULT_ARCSINH_STRETCH_OPTIONS: Readonly<ArcsinhStretchOptions> = {
	stretchFactor: 1,
	blackPoint: 0,
	protectHighlights: false,
	useRgbWorkingSpace: false,
	rgbWorkingSpace: BT709_GRAYSCALE,
}

// Default background neutralization options.
export const DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS: Readonly<BackgroundNeutralizationOptions> = {
	lowerLimit: 0,
	upperLimit: 1,
	targetBackground: 0.05,
	mode: 'rescaleAsNeeded',
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
