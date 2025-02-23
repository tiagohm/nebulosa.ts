import sharp, { type AvifOptions, type FormatEnum, type GifOptions, type HeifOptions, type Jp2Options, type JpegOptions, type JxlOptions, type OutputInfo, type OutputOptions, type PngOptions, type TiffOptions, type WebpOptions } from 'sharp'
import { Bitpix, type Fits, type FitsHdu, type FitsHeader, bitpix, height, numberOfChannels, width } from './fits'
import { bufferSource, readUntil } from './io'

export type ImageChannel = 'RED' | 'GREEN' | 'BLUE'

export type ImageFormat = keyof FormatEnum | 'fits' | 'xisf'

export interface Image {
	readonly header: FitsHeader
	readonly metadata: ImageMetadata
	readonly raw: Float64Array
}

export interface ImageMetadata {
	readonly width: number
	readonly height: number
	readonly channels: number
	readonly pixelCount: number
	readonly pixelSizeInBytes: number
}

export async function fromFits(fitsOrHdu?: Fits | FitsHdu): Promise<Image | undefined> {
	const hdu = !fitsOrHdu || 'header' in fitsOrHdu ? fitsOrHdu : fitsOrHdu.hdus[0]
	if (!hdu) return undefined
	const { header, data } = hdu
	const bp = bitpix(header)
	if (bp === Bitpix.LONG) return undefined
	const sw = width(header)
	const sh = height(header)
	const nc = Math.max(1, Math.min(3, numberOfChannels(header)))
	const pixelSizeInBytes = Math.trunc(Math.abs(bp) / 8)
	const pixelCount = sw * sh
	const stride = sw * pixelSizeInBytes
	const buffer = Buffer.allocUnsafe(stride)
	const { source: sourceOrBuffer, offset } = data!
	const raw = new Float64Array(pixelCount * nc)
	const minMax = [1, 0]
	const source = Buffer.isBuffer(sourceOrBuffer) ? bufferSource(sourceOrBuffer) : sourceOrBuffer

	source.seek(offset)

	for (let channel = 0; channel < nc; channel++) {
		let index = channel

		for (let i = 0; i < sh; i++) {
			const n = await readUntil(source, buffer)

			if (n !== stride) return undefined

			for (let k = 0; k < n; k += pixelSizeInBytes, index += nc) {
				let pixel = 0

				if (bp === Bitpix.BYTE) pixel = buffer.readUInt8(k) / 255.0
				else if (bp === Bitpix.SHORT) pixel = (buffer.readInt16BE(k) + 32768) / 65535.0
				else if (bp === Bitpix.INTEGER) pixel = (buffer.readInt32BE(k) + 2147483648) / 4294967295.0
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

	const metadata: ImageMetadata = { width: sw, height: sh, channels: nc, pixelCount, pixelSizeInBytes }
	return { header, metadata, raw }
}

export type ToFormatOptions = OutputOptions | JpegOptions | PngOptions | WebpOptions | AvifOptions | HeifOptions | JxlOptions | GifOptions | Jp2Options | TiffOptions

export async function toFormat(image: Image, path: string, format: Exclude<ImageFormat, 'fits' | 'xisf'>, options?: ToFormatOptions) {
	const { raw, metadata } = image
	const { width, height, channels } = metadata
	const input = new Uint8Array(raw.length)

	for (let i = 0; i < raw.length; i++) {
		input[i] = Math.trunc(raw[i] * 255)
	}

	await sharp(input, { raw: { width, height, channels: channels as OutputInfo['channels'] } })
		.toFormat(format, options)
		.toFile(path)
}

// Apply Screen Transfer Function to image.
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Display_Function__
// https://pixinsight.com/tutorials/24-bit-stf/
export function stf(image: Image, midtone: number = 0.5, shadow: number = 0, highlight: number = 1) {
	if (midtone === 0.5 && shadow === 0 && highlight === 1) return image

	const rangeFactor = shadow === highlight ? 1 : 1 / (highlight - shadow)
	const k1 = (midtone - 1) * rangeFactor
	const k2 = (2 * midtone - 1) * rangeFactor
	const lut = new Float64Array(65536).fill(NaN)

	function df(value: number) {
		const p = Math.max(0, Math.min(Math.trunc(value * 65535), 65535))
		if (!Number.isNaN(lut[p])) return lut[p]
		if (value < shadow) return 0
		if (value > highlight) return 1

		const i = value - shadow
		value = (i * k1) / (i * k2 - midtone)
		lut[p] = value

		return value
	}

	for (let i = 0; i < image.raw.length; i++) {
		image.raw[i] = df(image.raw[i])
	}

	return image
}
