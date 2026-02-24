import type { PathLike } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import { type Bitpix, bitpixInBytes, bitpixKeyword, cfaPatternKeyword, type Fits, type FitsHdu, FitsImageReader, heightKeyword, numberOfChannelsKeyword, readFits, widthKeyword, writeFits } from './fits'
import { DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS, type Image, type ImageFormat, type ImageRawType, type WriteImageToFormatOptions } from './image.types'
import { bufferSink, bufferSource, fileHandleSource, type Seekable, type Sink, type Source } from './io'
import { Jpeg } from './jpeg'
import { readXisf, type Xisf, type XisfImage, XisfImageReader } from './xisf'

// Reads an image from a FITS file
export async function readImageFromFits(fits: Fits | FitsHdu, source: Source & Seekable, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	const hdu = 'hdus' in fits ? fits.hdus[0] : fits
	const { header } = hdu

	const bitpix = bitpixKeyword(header, 8) as Bitpix
	const width = widthKeyword(header, 0)
	const height = heightKeyword(header, 0)
	const channels = numberOfChannelsKeyword(header, 1)

	const pixelSizeInBytes = bitpixInBytes(bitpix)
	const pixelCount = width * height
	const strideInBytes = width * pixelSizeInBytes
	const stride = width * channels
	const bayer = cfaPatternKeyword(header)

	const reader = new FitsImageReader(hdu)
	if (raw === 'auto') raw = bitpix === 8 ? 32 : 64
	if (typeof raw === 'number') raw = raw === 32 ? new Float32Array(pixelCount * channels) : new Float64Array(pixelCount * channels)
	if (!(await reader.read(source, raw))) return undefined

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

	return { header, raw, metadata: { width, height, channels, pixelCount, pixelSizeInBytes, strideInBytes, stride, bitpix, bayer } } satisfies Image as Image
}

export async function readImageFromSource(source: Source & Seekable, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	const { position } = source

	const fits = await readFits(source)
	if (fits) return await readImageFromFits(fits, source, raw)

	source.seek(position)

	const xisf = await readXisf(source)
	if (xisf) return await readImageFromXisf(xisf, source, raw)

	return undefined
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

export function clampPixel(p: number, max: number) {
	return Math.max(0, Math.min(p, max))
}

export function truncatePixel(p: number, max: number) {
	return clampPixel(Math.trunc(p * max), max)
}
