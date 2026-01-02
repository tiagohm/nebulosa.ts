import type { PathLike } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import { Bitpix, bitpixInBytes, bitpixKeyword, cfaPatternKeyword, type Fits, type FitsData, type FitsHdu, heightKeyword, numberOfChannelsKeyword, readFits, widthKeyword, writeFits } from './fits'
import { DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS, type Image, type ImageFormat, type ImageMetadata, type ImageRawType, type WriteImageToFormatOptions } from './image.types'
import { bufferSink, bufferSource, fileHandleSource, type Seekable, type Sink, type Source } from './io'
import { Jpeg } from './jpeg'

const READ_PIXEL: Readonly<Record<Bitpix, (view: DataView, offset: number) => number>> = {
	[Bitpix.BYTE]: (view, offset) => view.getUint8(offset) / 255,
	[Bitpix.SHORT]: (view, offset) => (view.getInt16(offset, false) + 32768) / 65535,
	[Bitpix.INTEGER]: (view, offset) => (view.getInt32(offset, false) + 2147483648) / 4294967295,
	[Bitpix.FLOAT]: (view, offset) => view.getFloat32(offset, false),
	[Bitpix.DOUBLE]: (view, offset) => view.getFloat64(offset, false),
	[Bitpix.LONG]: () => 0,
}

// Reads an image from a FITS file
export async function readImageFromFits(fitsOrHdu?: Fits | FitsHdu, raw: ImageRawType | 32 | 64 | 'auto' = 'auto'): Promise<Image | undefined> {
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
	const bufferView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
	if (raw === 'auto') raw = bp === Bitpix.BYTE ? 32 : 64
	if (typeof raw === 'number') raw = raw === 32 ? new Float32Array(pixelCount * nc) : new Float64Array(pixelCount * nc)
	const range = new Float64Array([1, 0])
	const source = Buffer.isBuffer(data.source) ? bufferSource(data.source) : data.source
	const readPixel = READ_PIXEL[bp]

	source.seek?.(data.offset ?? 0)

	for (let channel = 0; channel < nc; channel++) {
		for (let y = 0, i = channel; y < sh; y++) {
			const n = await source.read(buffer)

			if (n !== strideInBytes) return undefined

			for (let k = 0; k < n; k += pixelSizeInBytes, i += nc) {
				const pixel = readPixel(bufferView, k)

				raw[i] = pixel

				if (pixel < range[0]) range[0] = pixel
				if (pixel > range[1]) range[1] = pixel
			}
		}
	}

	if (range[0] < 0 || range[1] > 1) {
		const [min, max] = range
		const delta = max - min
		const n = raw.length

		for (let i = 0; i < n; i++) {
			raw[i] = (raw[i] - min) / delta
		}
	}

	const metadata: ImageMetadata = { width: sw, height: sh, channels: nc, stride, pixelCount, pixelSizeInBytes, bitpix: bp, bayer: cfaPatternKeyword(header) }

	return { header, metadata, raw }
}

export async function readImageFromSource(source: Source & Seekable, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	const fits = await readFits(source) // TODO: support XISF
	return await readImageFromFits(fits, raw)
}

export async function readImageFromBuffer(buffer: Buffer, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	return await readImageFromSource(bufferSource(buffer), raw)
}

export async function readImageFromFileHandle(handle: FileHandle, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	await using source = fileHandleSource(handle)
	return await readImageFromSource(source, raw)
}

export async function readImageFromPath(path: PathLike, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	await using handle = await fs.open(path, 'r')
	return await readImageFromFileHandle(handle, raw)
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

const WRITE_PIXEL: Readonly<Record<Bitpix, (view: DataView, offset: number, pixel: number) => void>> = {
	[Bitpix.BYTE]: (view, offset, pixel) => view.setUint8(offset, pixel * 255),
	[Bitpix.SHORT]: (view, offset, pixel) => view.setInt16(offset, ((pixel * 65535) & 0xffff) - 32768, false),
	[Bitpix.INTEGER]: (view, offset, pixel) => view.setInt32(offset, ((pixel * 4294967295) & 0xffffffff) - 2147483648, false),
	[Bitpix.FLOAT]: (view, offset, pixel) => view.setFloat32(offset, pixel, false),
	[Bitpix.DOUBLE]: (view, offset, pixel) => view.setFloat64(offset, pixel, false),
	[Bitpix.LONG]: () => {},
}

export class FitsDataSource implements Source {
	private position = 0
	private channel = 0
	private readonly raw: ImageRawType
	private readonly bitpix: Bitpix
	private readonly channels: number

	constructor(image: Image | ImageRawType, bitpix?: Bitpix, channels?: number) {
		this.raw = 'raw' in image ? image.raw : image
		this.bitpix = 'raw' in image ? (image.header.BITPIX as Bitpix) : bitpix!
		this.channels = 'raw' in image ? numberOfChannelsKeyword(image.header, 1) : channels!
	}

	read(buffer: Buffer, offset?: number, size?: number): number {
		offset ??= 0
		size ??= buffer.byteLength - offset

		const length = this.raw.length

		if (this.position >= length) {
			if (++this.channel < this.channels) {
				this.position = this.channel
			} else {
				return 0
			}
		}

		const channels = this.channels
		const pixelSizeInBytes = bitpixInBytes(this.bitpix)
		const bufferView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
		const raw = this.raw
		let position = this.position
		let n = 0
		const writePixel = WRITE_PIXEL[this.bitpix]

		for (; position < length && n < size; position += channels, n += pixelSizeInBytes, offset += pixelSizeInBytes) {
			writePixel(bufferView, offset, raw[position])
		}

		this.position = position

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
