import type { PathLike } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import { type Bitpix, type Fits, type FitsHdu, FitsImageReader, readFits, writeFits } from './fits'
import { bitpixInBytes, cfaPatternKeyword, heightKeyword, isRiceCompressedImageHeader, uncompressedBitpixKeyword, uncompressedHeightKeyword, uncompressedNumberOfChannelsKeyword, uncompressedWidthKeyword, widthKeyword } from './fits.util'
import { DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS, type Image, type ImageFormat, type ImageRawType, type WriteImageToFormatOptions } from './image.types'
import { bufferSink, bufferSource, fileHandleSource, readRemaining, readUntil, type Seekable, type Sink, type Source } from './io'
import { isJpeg, Jpeg, type PixelFormat } from './libturbojpeg'
import { clamp } from './math'
import { readXisf, writeXisf, type Xisf, type XisfImage, XisfImageReader, type XisfWriteFormat } from './xisf'

function findCompressedImageHdu(hdu: FitsHdu) {
	return isRiceCompressedImageHeader(hdu.header)
}

function findUncompressedImageHdu(hdu: FitsHdu) {
	return widthKeyword(hdu.header, 0) > 0 && heightKeyword(hdu.header, 0) > 0
}

// Reads an image from a FITS file
export async function readImageFromFits(fits: Fits | FitsHdu, source: Source & Seekable, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	const hdu = 'hdus' in fits ? (fits.hdus.find(findCompressedImageHdu) ?? fits.hdus.find(findUncompressedImageHdu) ?? fits.hdus[0]) : fits
	const { header } = hdu

	const bitpix = uncompressedBitpixKeyword<Bitpix>(header, 8)
	const width = uncompressedWidthKeyword(header, 0)
	const height = uncompressedHeightKeyword(header, 0)
	const channels = uncompressedNumberOfChannelsKeyword(header, 1)

	const pixelSizeInBytes = bitpixInBytes(bitpix)
	const pixelCount = width * height
	const strideInBytes = width * pixelSizeInBytes
	const stride = width * channels
	const bayer = cfaPatternKeyword(header)

	const reader = new FitsImageReader(hdu)
	if (raw === 'auto') raw = bitpix === 8 ? 32 : 64
	if (typeof raw === 'number') raw = raw === 32 ? new Float32Array(pixelCount * channels) : new Float64Array(pixelCount * channels)
	if (!(await reader.read(source, raw))) return undefined

	normalize(raw)

	return { header, raw, metadata: { width, height, channels, pixelCount, pixelSizeInBytes, strideInBytes, stride, bitpix, bayer } } satisfies Image as Image
}

export async function readImageFromXisf(xisf: Xisf | XisfImage, source: Source & Seekable, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	const image = 'images' in xisf ? xisf.images[0] : xisf
	const { bitpix, geometry, header } = image
	const { width, height, channels } = geometry

	const pixelSizeInBytes = bitpixInBytes(bitpix)
	const pixelCount = width * height
	const strideInBytes = width * pixelSizeInBytes
	const stride = width * channels
	const bayer = cfaPatternKeyword(header)

	const reader = new XisfImageReader(image)
	if (raw === 'auto') raw = bitpix === 8 ? 32 : 64
	if (typeof raw === 'number') raw = raw === 32 ? new Float32Array(pixelCount * channels) : new Float64Array(pixelCount * channels)
	if (!(await reader.read(source, raw))) return undefined

	normalize(raw)

	return { header, raw, metadata: { width, height, channels, pixelCount, pixelSizeInBytes, strideInBytes, stride, bitpix, bayer } } satisfies Image as Image
}

export function readImageFromJpeg(buffer: Buffer, raw: ImageRawType | 32 | 64 | 'auto' = 'auto', format?: PixelFormat): Image | undefined {
	if (!isJpeg(buffer)) return undefined

	const image = new Jpeg().decompress(buffer, format)
	if (!image) return undefined

	const { data, width, height } = image
	const pixelCount = width * height

	if (raw === 'auto') raw = 32
	if (typeof raw === 'number') raw = raw === 32 ? new Float32Array(pixelCount) : new Float64Array(pixelCount)
	if (raw.length < pixelCount) return undefined

	for (let i = 0; i < pixelCount; i++) raw[i] = data[i] / 255

	const header = { BITPIX: 8, NAXIS: 2, NAXIS1: width, NAXIS2: height }
	return { header, raw, metadata: { width, height, channels: 1, pixelCount, pixelSizeInBytes: 1, strideInBytes: width, stride: width, bitpix: 8, bayer: undefined } } satisfies Image as Image
}

export async function readImageFromSource(source: Source & Seekable, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	const { position } = source

	const fits = await readFits(source)
	if (fits) return await readImageFromFits(fits, source, raw)

	source.seek(position)

	const xisf = await readXisf(source)
	if (xisf) return await readImageFromXisf(xisf, source, raw)

	source.seek(position)

	const magic = Buffer.allocUnsafe(2)
	if ((await readUntil(source, magic)) !== magic.byteLength || !isJpeg(magic)) return undefined

	source.seek(position)

	return readImageFromJpeg(await readRemaining(source), raw)
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

export function writeImageToFits(image: Image, output: Buffer | Sink) {
	if (Buffer.isBuffer(output)) output = bufferSink(output)
	return writeFits(output, [image])
}

export function writeImageToXisf(image: Image, output: Buffer | Sink, format?: XisfWriteFormat) {
	if (Buffer.isBuffer(output)) output = bufferSink(output)
	return writeXisf(output, [image], format)
}

export function truncatePixel(p: number, max: number) {
	return clamp(Math.trunc(p * max), 0, max)
}

function normalize(raw: ImageRawType) {
	const n = raw.length
	let min = raw[0]
	let max = raw[0]

	for (let i = 0; i < n; i++) {
		const p = raw[i]
		if (p < min) min = p
		else if (p > max) max = p
	}

	if (min < 0 || max > 1) {
		const rangeDelta = Math.abs(max - min)

		if (rangeDelta <= 1e-12) {
			raw.fill(0)
		} else {
			for (let i = 0; i < n; i++) {
				raw[i] = (raw[i] - min) / rangeDelta
			}
		}
	}
}
