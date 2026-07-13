import type { ChrominanceSubsampling } from '../../bindings/imaging/libturbojpeg'
import type { Bitpix, FitsHeader } from '../../io/formats/fits/fits'
import type { Size } from '../../math/numerical/geometry'

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

// Backing typed array for raw pixel data (single or double precision).
export type ImageRawType = Float64Array | Float32Array

// Backing typed array precision for raw pixel data (single, double precision, or based on image raw type).
export type ImageRawPrecision = 32 | 64 | 'auto'

// Scale represented by an image sample buffer.
export type ImageSampleScale = 'normalized' | 'digital'

// Options for reading an image into the normalized 0..1 processing scale.
export interface NormalizedImageReadOptions {
	// Caller-provided output buffer or requested floating-point precision.
	readonly raw?: ImageRawType | ImageRawPrecision
	// Normalized processing scale; this is the default when omitted.
	readonly sampleScale?: 'normalized'
}

// Options for preserving source digital numbers after format-defined scaling.
export interface DigitalImageReadOptions {
	// Caller-provided output buffer or requested floating-point precision.
	readonly raw?: ImageRawType | ImageRawPrecision
	// Digital-number scale required for sensor measurements.
	readonly sampleScale: 'digital'
}

// Discriminated image-reader options for normalized or digital samples.
export type ImageReadOptions = NormalizedImageReadOptions | DigitalImageReadOptions

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
	// Normalized processing scale; omitted by legacy normalized producers.
	readonly sampleScale?: 'normalized'
	// Source FITS-compatible header.
	readonly header: FitsHeader
	// Geometry and storage metadata derived from the source.
	readonly metadata: ImageMetadata
	// Normalized pixel buffer.
	readonly raw: ImageRawType
}

// Read-only measurement image whose samples preserve source digital numbers after format scaling.
// DigitalImage is intentionally produced only by digital reader modes for workflows such as sensor
// characterization. It is not a writer input: serialize only a normalized Image instead.
export interface DigitalImage extends Pick<Image, 'header' | 'metadata'> {
	// Discriminant preventing normalized images from being used as digital sensor data.
	readonly sampleScale: 'digital'
	// Flat pixel buffer in physical digital-number scale.
	readonly raw: ImageRawType
	// Representable scaled code range, ordered from low to high when derivable.
	readonly digitalRange?: readonly [number, number]
	// Positive spacing between adjacent integer codes after source scaling, in DN.
	readonly quantizationStep?: number
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

// Type guard: true when a value has the Image shape (header, metadata, raw).
export function isImage(image?: object): image is Image {
	return !!image && 'header' in image && 'metadata' in image && 'raw' in image && (!('sampleScale' in image) || image.sampleScale === 'normalized')
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
