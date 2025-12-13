import type { PathLike } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import sharp, { type AvifOptions, type FormatEnum, type GifOptions, type HeifOptions, type Jp2Options, type JpegOptions, type JxlOptions, type OutputOptions, type PngOptions, type TiffOptions, type WebpOptions } from 'sharp'
import { Bitpix, bitpixInBytes, bitpixKeyword, cfaPatternKeyword, type Fits, type FitsData, type FitsHdu, type FitsHeader, heightKeyword, numberOfChannelsKeyword, readFits, widthKeyword, writeFits } from './fits'
import { bufferSink, bufferSource, fileHandleSource, readUntil, type Seekable, type Sink, type Source } from './io'

export type ImageChannel = 'RED' | 'GREEN' | 'BLUE'

export type ImageFormat = keyof FormatEnum | 'fits' | 'xisf'

export type CfaPattern = 'RGGB' | 'BGGR' | 'GBRG' | 'GRBG' | 'GRGB' | 'GBGR' | 'RGBG' | 'BGRG'

export type SCNRProtectionMethod = 'MAXIMUM_MASK' | 'ADDITIVE_MASK' | 'AVERAGE_NEUTRAL' | 'MAXIMUM_NEUTRAL' | 'MINIMUM_NEUTRAL'

export type SCNRAlgorithm = (a: number, b: number, c: number, amount: number) => number

export type Grayscale = Readonly<Record<Lowercase<ImageChannel>, number>>

export type GrayscaleAlgorithm = 'BT709' | 'RMY' | 'Y' | Grayscale

export type ImageChannelOrGray = ImageChannel | GrayscaleAlgorithm | 'GRAY'

export interface WriteImageToFormatOptions {
	format?: OutputOptions | JpegOptions | PngOptions | WebpOptions | AvifOptions | HeifOptions | JxlOptions | GifOptions | Jp2Options | TiffOptions
	horizontalFlip?: boolean
	verticalFlip?: boolean
	sharpen?: boolean
	median?: boolean
	blur?: boolean
	gamma?: number // 1 - 3
	normalize?: boolean // Enhance output image contrast
	brightness?: number
	contrast?: number
	saturation?: number
	negate?: boolean
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

export function isImage(image?: object): image is Image {
	return !!image && 'header' in image && 'metadata' in image && 'raw' in image
}

export function channelIndex(channel?: ImageChannelOrGray) {
	return channel === 'GREEN' ? 1 : channel === 'BLUE' ? 2 : 0
}

export function grayscaleFromChannel(channel?: ImageChannelOrGray): Grayscale {
	return channel === 'BT709' ? BT709_GRAYSCALE : channel === 'RMY' ? RMY_GRAYSCALE : channel === 'Y' ? Y_GRAYSCALE : channel === 'GRAY' ? DEFAULT_GRAYSCALE : channel === 'RED' ? RED_GRAYSCALE : channel === 'GREEN' ? GREEN_GRAYSCALE : channel === 'BLUE' ? BLUE_GRAYSCALE : (channel ?? DEFAULT_GRAYSCALE)
}

// Reads an image from a FITS file
export async function readImageFromFits(fitsOrHdu?: Fits | FitsHdu): Promise<Image | undefined> {
	const hdu = !fitsOrHdu || 'header' in fitsOrHdu ? fitsOrHdu : fitsOrHdu.hdus[0]
	if (!hdu) return undefined
	const { header, data } = hdu
	const bp = bitpixKeyword(header, 0)
	if (bp === 0 || bp === Bitpix.LONG) return undefined
	const sw = widthKeyword(header, 0)
	const sh = heightKeyword(header, 0)
	const nc = Math.max(1, Math.min(3, numberOfChannelsKeyword(header, 1)))
	const pixelSizeInBytes = bitpixInBytes(bp)
	const pixelCount = sw * sh
	const strideInBytes = sw * pixelSizeInBytes
	const stride = sw * nc
	const buffer = Buffer.allocUnsafe(strideInBytes)
	const raw = new Float64Array(pixelCount * nc)
	const minMax = [1, 0]
	const source = Buffer.isBuffer(data.source) ? bufferSource(data.source) : data.source

	source.seek?.(data.offset ?? 0)

	for (let channel = 0; channel < nc; channel++) {
		let index = channel

		for (let i = 0; i < sh; i++) {
			const n = await readUntil(source, buffer)

			if (n !== strideInBytes) return undefined

			for (let k = 0; k < n; k += pixelSizeInBytes, index += nc) {
				let pixel = 0

				if (bp === Bitpix.BYTE) pixel = buffer.readUInt8(k) / 255
				else if (bp === Bitpix.SHORT) pixel = (buffer.readInt16BE(k) + 32768) / 65535
				else if (bp === Bitpix.INTEGER) pixel = (buffer.readInt32BE(k) + 2147483648) / 4294967295
				else if (bp === Bitpix.FLOAT) pixel = buffer.readFloatBE(k)
				else if (bp === Bitpix.DOUBLE) pixel = buffer.readDoubleBE(k)

				raw[index] = pixel
				minMax[0] = Math.min(pixel, minMax[0])
				minMax[1] = Math.max(pixel, minMax[1])
			}
		}
	}

	if (minMax[0] < 0 || minMax[1] > 1) {
		const [min, max] = minMax
		const delta = max - min

		for (let i = 0; i < raw.length; i++) {
			raw[i] = (raw[i] - min) / delta
		}
	}

	const metadata: ImageMetadata = { width: sw, height: sh, channels: nc, stride, pixelCount, pixelSizeInBytes, bitpix: bp, bayer: cfaPatternKeyword(header) }
	return { header, metadata, raw }
}

export async function readImageFromSource(source: Source & Seekable) {
	const fits = await readFits(source) // TODO: support XISF
	return await readImageFromFits(fits)
}

export async function readImageFromBuffer(buffer: Buffer) {
	return await readImageFromSource(bufferSource(buffer))
}

export async function readImageFromFileHandle(handle: FileHandle) {
	await using source = fileHandleSource(handle)
	return await readImageFromSource(source)
}

export async function readImageFromPath(path: PathLike) {
	await using handle = await fs.open(path, 'r')
	return await readImageFromFileHandle(handle)
}

export async function writeImageToFormat(image: Image, output: string | NodeJS.WritableStream, format: Exclude<ImageFormat, 'fits' | 'xisf'>, options?: WriteImageToFormatOptions) {
	const { raw, metadata } = image
	const { width, height, channels } = metadata
	const input = new Uint8ClampedArray(raw.length)

	for (let i = 0; i < input.length; i++) input[i] = raw[i] * 255

	const s = sharp(input, { raw: { width, height, channels: channels as never, premultiplied: false } }).toFormat(format, options?.format)

	if (options?.horizontalFlip) s.flop()
	if (options?.verticalFlip) s.flip()
	if (options?.normalize) s.normalise()
	if (options?.brightness !== undefined || options?.saturation !== undefined) s.modulate({ brightness: options.brightness ?? 1, saturation: options.saturation ?? 1 })
	if (options?.gamma !== undefined) s.gamma(options.gamma)
	if (options?.contrast !== undefined && options.contrast !== 1) s.linear(options.contrast, -(128 * options.contrast) + 128)
	if (options?.sharpen) s.sharpen()
	if (options?.median) s.median()
	if (options?.blur) s.blur()
	if (options?.negate) s.negate()

	if (channels === 1) s.toColourspace('b-w')

	if (typeof output === 'string') {
		return await s.toFile(output)
	} else {
		s.pipe(output)
		return undefined
	}
}

export class FitsDataSource implements Source {
	private position = 0
	private channel = 0
	private readonly raw: Float64Array
	private readonly bitpix: Bitpix
	private readonly pixelSizeInBytes: number
	private readonly channels: number

	constructor(image: Image | Float64Array, bitpix?: Bitpix, channels?: number) {
		this.raw = image instanceof Float64Array ? image : image.raw
		this.bitpix = image instanceof Float64Array ? bitpix! : (image.header.BITPIX as Bitpix)
		this.pixelSizeInBytes = bitpixInBytes(this.bitpix)
		this.channels = image instanceof Float64Array ? channels! : numberOfChannelsKeyword(image.header, 1)
	}

	read(buffer: Buffer, offset?: number, size?: number): number {
		offset ??= 0
		size ??= buffer.byteLength - offset

		if (this.position >= this.raw.length) {
			if (++this.channel < this.channels) {
				this.position = this.channel
			} else {
				return 0
			}
		}

		let n = 0

		for (; this.position < this.raw.length && n < size; this.position += this.channels, n += this.pixelSizeInBytes, offset += this.pixelSizeInBytes) {
			const pixel = this.raw[this.position]

			if (this.bitpix === Bitpix.BYTE) buffer.writeUInt8(pixel * 255, offset)
			else if (this.bitpix === Bitpix.SHORT) buffer.writeInt16BE(Math.trunc(pixel * 65535) - 32768, offset)
			else if (this.bitpix === Bitpix.INTEGER) buffer.writeInt32BE(Math.trunc(pixel * 4294967295) - 2147483648, offset)
			else if (this.bitpix === Bitpix.FLOAT) buffer.writeFloatBE(pixel, offset)
			else if (this.bitpix === Bitpix.DOUBLE) buffer.writeDoubleBE(pixel, offset)
		}

		return n
	}
}

export function writeImageToFits(image: Image, output: Buffer | Sink) {
	if (Buffer.isBuffer(output)) {
		output = bufferSink(output)
	}

	const source: Source = new FitsDataSource(image)
	const data: FitsData = { source }
	const hdu: FitsHdu = { header: image.header, data }

	return writeFits(output, [hdu])
}

export function clampPixel(p: number, max: number) {
	return Math.max(0, Math.min(p, max))
}

export function truncatePixel(p: number, max: number) {
	return clampPixel(Math.trunc(p * max), max)
}
