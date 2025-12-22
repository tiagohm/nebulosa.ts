import type { Bitpix, FitsHeader } from './fits'
import type { ChrominanceSubsampling } from './jpeg'

export type ImageChannel = 'RED' | 'GREEN' | 'BLUE'

export type ImageFormat = 'jpeg' | 'fits' | 'xisf'

export type CfaPattern = 'RGGB' | 'BGGR' | 'GBRG' | 'GRBG' | 'GRGB' | 'GBGR' | 'RGBG' | 'BGRG'

export type SCNRProtectionMethod = 'MAXIMUM_MASK' | 'ADDITIVE_MASK' | 'AVERAGE_NEUTRAL' | 'MAXIMUM_NEUTRAL' | 'MINIMUM_NEUTRAL'

export type SCNRAlgorithm = (a: number, b: number, c: number, amount: number) => number

export type Grayscale = Readonly<Record<Lowercase<ImageChannel>, number>>

export type GrayscaleAlgorithm = 'BT709' | 'RMY' | 'Y' | Grayscale

export type ImageChannelOrGray = ImageChannel | GrayscaleAlgorithm | 'GRAY'

export interface WriteImageToFormatOptions {
	jpeg: {
		quality?: number
		chrominanceSubsampling?: ChrominanceSubsampling
	}
}

export interface Image {
	readonly header: FitsHeader
	readonly metadata: ImageMetadata
	readonly raw: Float64Array
}

export interface ImageMetadata {
	readonly width: number
	readonly height: number
	readonly channels: number
	readonly stride: number
	readonly pixelCount: number
	readonly pixelSizeInBytes: number
	readonly bitpix: Bitpix
	readonly bayer?: CfaPattern
}

export const BT709_GRAYSCALE: Grayscale = { red: 0.2125, green: 0.7154, blue: 0.0721 } // standard sRGB
export const RMY_GRAYSCALE: Grayscale = { red: 0.5, green: 0.419, blue: 0.081 }
export const Y_GRAYSCALE: Grayscale = { red: 0.299, green: 0.587, blue: 0.114 } // NTSC
export const RED_GRAYSCALE: Grayscale = { red: 1, green: 0, blue: 0 }
export const GREEN_GRAYSCALE: Grayscale = { red: 0, green: 1, blue: 0 }
export const BLUE_GRAYSCALE: Grayscale = { red: 0, green: 0, blue: 1 }
export const DEFAULT_GRAYSCALE = BT709_GRAYSCALE

export const DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS = {
	jpeg: {
		quality: 100,
		chrominanceSubsampling: '4:4:4',
	},
} as const

export function isImage(image?: object): image is Image {
	return !!image && 'header' in image && 'metadata' in image && 'raw' in image
}

export function channelIndex(channel?: ImageChannelOrGray) {
	return channel === 'GREEN' ? 1 : channel === 'BLUE' ? 2 : 0
}

export function grayscaleFromChannel(channel?: ImageChannelOrGray): Grayscale {
	return channel === 'BT709' ? BT709_GRAYSCALE : channel === 'RMY' ? RMY_GRAYSCALE : channel === 'Y' ? Y_GRAYSCALE : channel === 'GRAY' ? DEFAULT_GRAYSCALE : channel === 'RED' ? RED_GRAYSCALE : channel === 'GREEN' ? GREEN_GRAYSCALE : channel === 'BLUE' ? BLUE_GRAYSCALE : (channel ?? DEFAULT_GRAYSCALE)
}
