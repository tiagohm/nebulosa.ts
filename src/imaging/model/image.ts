import type { PathLike } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import { isJpeg, Jpeg, type PixelFormat } from '../../bindings/imaging/libturbojpeg'
import { type Bitpix, type Fits, type FitsHdu, FitsImageReader, readFits, writeFits } from '../../io/formats/fits/fits'
import { bitpixInBytes, cfaPatternKeyword, heightKeyword, isRiceCompressedImageHeader, uncompressedBitpixKeyword, uncompressedHeightKeyword, uncompressedNumberOfChannelsKeyword, uncompressedWidthKeyword, widthKeyword } from '../../io/formats/fits/util'
import { readXisf, writeXisf, type Xisf, type XisfImage, XisfImageReader, type XisfWriteFormat } from '../../io/formats/xisf/xisf'
import { bufferSink, bufferSource, fileHandleSource, readRemaining, readUntil, type Seekable, type Sink, type Source } from '../../io/io'
import { clamp } from '../../math/numerical/math'
import { DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS, type Image, type ImageFormat, type ImageRawType, type WriteImageToFormatOptions } from './types'

// Image input/output for the imaging model: reads FITS, XISF, and JPEG sources (auto-detected) into a
// normalized in-memory Image whose pixels are scaled into [0, 1], and writes an Image back out to
// JPEG, FITS, or XISF. The `raw` argument selects the backing precision (Float32 32 / Float64 64) or
// reuses a caller-provided buffer; 'auto' picks 32-bit for 8-bit sources and 64-bit otherwise.

// Predicate selecting a Rice-compressed image HDU.
function findCompressedImageHdu(hdu: FitsHdu) {
	return isRiceCompressedImageHeader(hdu.header)
}

// Predicate selecting an uncompressed image HDU with positive dimensions.
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

// Reads an image from a parsed XISF file or image into a normalized Image.
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

// Decodes a JPEG buffer into a single-channel (luminance) normalized Image, or undefined if not JPEG.
export function readImageFromJpeg(buffer: Buffer, raw: ImageRawType | 32 | 64 | 'auto' = 'auto', format?: PixelFormat): Image | undefined {
	if (!isJpeg(buffer)) return undefined

	// The output is a single-channel image, so decode as luminance. Without this a color
	// JPEG would decode to interleaved RGB and the mono-sized copy below would read
	// R,G,B,... as a raster, producing a garbled frame.
	const image = new Jpeg().decompress(buffer, format ?? 'GRAY')
	if (!image) return undefined

	const { data, width, height } = image
	const pixelCount = width * height

	if (raw === 'auto') raw = 32
	if (typeof raw === 'number') raw = raw === 32 ? new Float32Array(pixelCount) : new Float64Array(pixelCount)
	if (raw.length < pixelCount) return undefined

	for (let i = 0; i < pixelCount; i++) raw[i] = data[i] / 255

	const header = { BITPIX: 8, NAXIS: 2, NAXIS1: width, NAXIS2: height }
	return { header, raw, metadata: { width, height, channels: 1, pixelCount, pixelSizeInBytes: 1, strideInBytes: width, stride: width, bitpix: 8, bayer: undefined } }
}

// Reads an image from a seekable source, auto-detecting FITS, then XISF, then JPEG.
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

// Reads an image from an in-memory buffer.
export async function readImageFromBuffer(buffer: Buffer, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	return await readImageFromSource(bufferSource(buffer), raw)
}

// Reads an image from an open file handle.
export async function readImageFromFileHandle(handle: FileHandle, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	await using source = fileHandleSource(handle)
	return await readImageFromSource(source, raw)
}

// Opens a file path and reads an image from it.
export async function readImageFromPath(path: PathLike, raw: ImageRawType | 32 | 64 | 'auto' = 'auto') {
	await using handle = await fs.open(path, 'r')
	return await readImageFromFileHandle(handle, raw)
}

// Encodes an Image to an in-memory format buffer (currently JPEG); returns undefined for other formats.
// Pixel values in [0, 1] are scaled to 0..255 before compression.
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

// Writes an Image to a FITS file via a buffer or sink.
export function writeImageToFits(image: Image, output: Buffer | Sink) {
	if (Buffer.isBuffer(output)) output = bufferSink(output)
	return writeFits(output, [image])
}

// Writes an Image to an XISF file via a buffer or sink.
export function writeImageToXisf(image: Image, output: Buffer | Sink, format?: XisfWriteFormat) {
	if (Buffer.isBuffer(output)) output = bufferSink(output)
	return writeXisf(output, [image], format)
}

// Scales a normalized pixel `p` (0..1) to an integer 0..max, truncating and clamping.
export function truncatePixel(p: number, max: number) {
	return clamp(Math.trunc(p * max), 0, max)
}

// Rescales the raw buffer into [0, 1] in place when its values fall outside that range; a flat image
// (range below 1e-12) is zeroed.
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
