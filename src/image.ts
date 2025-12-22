import type { PathLike } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import { Bitpix, bitpixInBytes, bitpixKeyword, cfaPatternKeyword, type Fits, type FitsData, type FitsHdu, heightKeyword, numberOfChannelsKeyword, readFits, widthKeyword, writeFits } from './fits'
import { DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS, type Image, type ImageFormat, type ImageMetadata, type WriteImageToFormatOptions } from './image.types'
import { bufferSink, bufferSource, fileHandleSource, readUntil, type Seekable, type Sink, type Source } from './io'
import { Jpeg } from './jpeg'

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

export function writeImageToFormat(image: Image, format: Exclude<ImageFormat, 'fits' | 'xisf'> = 'jpeg', options: Partial<WriteImageToFormatOptions> = DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS) {
	const { raw, metadata } = image
	const { width, height, channels } = metadata

	const input = new Uint8ClampedArray(raw.length)
	for (let i = 0; i < input.length; i++) input[i] = raw[i] * 255

	if (format === 'jpeg') {
		const { quality = 100, chrominanceSubsampling = '4:4:4' } = options.jpeg ?? DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS.jpeg
		return new Jpeg().compress(Buffer.from(input.buffer), width, height, channels === 1 ? 'GRAY' : 'RGB', quality, chrominanceSubsampling)
	}

	return undefined
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
