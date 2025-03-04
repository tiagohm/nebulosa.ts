import sharp, { type AvifOptions, type FormatEnum, type GifOptions, type HeifOptions, type Jp2Options, type JpegOptions, type JxlOptions, type OutputInfo, type OutputOptions, type PngOptions, type TiffOptions, type WebpOptions } from 'sharp'
import { Bitpix, type Fits, type FitsData, type FitsHdu, type FitsHeader, bitpix, bitpixInBytes, height, numberOfChannels, width, writeFits } from './fits'
import { type Sink, type Source, bufferSink, bufferSource, readUntil } from './io'

export type ImageChannel = 'RED' | 'GREEN' | 'BLUE'

export type ImageFormat = keyof FormatEnum | 'fits' | 'xisf'

export interface WriteImageToFormatOptions {
	format: OutputOptions | JpegOptions | PngOptions | WebpOptions | AvifOptions | HeifOptions | JxlOptions | GifOptions | Jp2Options | TiffOptions
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
	readonly pixelCount: number
	readonly pixelSizeInBytes: number
}

export async function readImageFromFits(fitsOrHdu?: Fits | FitsHdu): Promise<Image | undefined> {
	const hdu = !fitsOrHdu || 'header' in fitsOrHdu ? fitsOrHdu : fitsOrHdu.hdus[0]
	if (!hdu) return undefined
	const { header, data } = hdu
	const bp = bitpix(header)
	if (bp === 0 || bp === Bitpix.LONG) return undefined
	const sw = width(header)
	const sh = height(header)
	const nc = Math.max(1, Math.min(3, numberOfChannels(header)))
	const pixelSizeInBytes = bitpixInBytes(bp)
	const pixelCount = sw * sh
	const stride = sw * pixelSizeInBytes
	const buffer = Buffer.allocUnsafe(stride)
	const raw = new Float64Array(pixelCount * nc)
	const minMax = [1, 0]
	const source = Buffer.isBuffer(data.source) ? bufferSource(data.source) : data.source

	source.seek?.(data.offset ?? 0)

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

export async function writeImageToFormat(image: Image, output: string | NodeJS.WritableStream, format: Exclude<ImageFormat, 'fits' | 'xisf'>, options?: WriteImageToFormatOptions) {
	const { raw, metadata } = image
	const { width, height, channels } = metadata
	const input = new Uint8Array(raw.length)

	for (let i = 0; i < input.length; i++) input[i] = Math.trunc(raw[i] * 255)

	const s = sharp(input, { raw: { width, height, channels: channels as OutputInfo['channels'], premultiplied: false } }).toFormat(format, options?.format)

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
		this.channels = image instanceof Float64Array ? channels! : numberOfChannels(image.header)
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

			switch (this.bitpix) {
				case Bitpix.BYTE:
					buffer.writeUint8(pixel * 255, offset)
					break
				case Bitpix.SHORT:
					buffer.writeInt16BE(Math.trunc(pixel * 65535) - 32768, offset)
					break
				case Bitpix.INTEGER:
					buffer.writeInt32BE(Math.trunc(pixel * 4294967295) - 2147483648, offset)
					break
				case Bitpix.FLOAT:
					buffer.writeFloatBE(pixel, offset)
					break
				case Bitpix.DOUBLE:
					buffer.writeDoubleBE(pixel, offset)
					break
			}
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
