import type { PathLike } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import { isJpeg, Jpeg, type PixelFormat } from '../../bindings/imaging/libturbojpeg'
import { type Bitpix, type Fits, type FitsHdu, FitsImageReader, readFits, writeFits } from '../../io/formats/fits/fits'
import { bitpixInBytes, cfaPatternKeyword, heightKeyword, isRiceCompressedImageHeader, uncompressedBitpixKeyword, uncompressedHeightKeyword, uncompressedNumberOfChannelsKeyword, uncompressedScaleKeyword, uncompressedWidthKeyword, uncompressedZeroKeyword, widthKeyword } from '../../io/formats/fits/util'
import { readXisf, writeXisf, type Xisf, type XisfImage, XisfImageReader, type XisfWriteFormat } from '../../io/formats/xisf/xisf'
import { bufferSink, bufferSource, fileHandleSource, readRemaining, readUntil, type Seekable, type Sink, type Source } from '../../io/io'
import { clamp } from '../../math/numerical/math'
import { DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS, type DigitalImage, type DigitalImageReadOptions, type Image, type ImageFormat, type ImageRawPrecision, type ImageRawType, type ImageReadOptions, type ImageSampleScale, type NormalizedImageReadOptions, type WriteImageToFormatOptions } from './types'

// Image input/output for the imaging model: reads FITS, XISF, and JPEG sources (auto-detected) into a
// normalized in-memory Image or a DigitalImage preserving source digital numbers, and writes an Image
// back out to JPEG, FITS, or XISF. Reader options select the sample scale and backing precision while
// the legacy positional raw argument remains normalized for compatibility.

// Accepted legacy or options-based image-reader argument.
type ImageReadArgument = ImageRawType | ImageRawPrecision | ImageReadOptions

// Predicate selecting a Rice-compressed image HDU.
function findCompressedImageHdu(hdu: FitsHdu) {
	return isRiceCompressedImageHeader(hdu.header)
}

// Predicate selecting an uncompressed image HDU with positive dimensions.
function findUncompressedImageHdu(hdu: FitsHdu) {
	return widthKeyword(hdu.header, 0) > 0 && heightKeyword(hdu.header, 0) > 0
}

// Resolves legacy raw arguments and discriminated reader options.
function resolveImageReadArgument(argument: ImageReadArgument = 'auto'): readonly [ImageRawType | ImageRawPrecision, ImageSampleScale] {
	if (typeof argument === 'object' && !(argument instanceof Float32Array) && !(argument instanceof Float64Array)) {
		return [argument.raw ?? 'auto', argument.sampleScale ?? 'normalized']
	}

	return [argument, 'normalized']
}

// Computes the representable physical range and code spacing for an integer FITS image.
function fitsDigitalProperties(header: FitsHdu['header'], bitpix: Bitpix): Pick<DigitalImage, 'digitalRange' | 'quantizationStep'> {
	if (bitpix < 0) return {}

	const storedMinimum = bitpix === 8 ? 0 : -(2 ** (bitpix - 1))
	const storedMaximum = bitpix === 8 ? 2 ** bitpix - 1 : 2 ** (bitpix - 1) - 1
	const scaleValue = uncompressedScaleKeyword(header, 1)
	const zeroValue = uncompressedZeroKeyword(header, 0)
	const scale = Number.isFinite(scaleValue) ? scaleValue : 1
	const zero = Number.isFinite(zeroValue) ? zeroValue : 0
	const first = storedMinimum * scale + zero
	const last = storedMaximum * scale + zero
	const quantizationStep = Math.abs(scale)

	return {
		digitalRange: first <= last ? [first, last] : [last, first],
		quantizationStep: quantizationStep > 0 ? quantizationStep : undefined,
	}
}

// Computes the representable range and code spacing for an integer XISF image.
function xisfDigitalProperties(bitpix: Bitpix): Pick<DigitalImage, 'digitalRange' | 'quantizationStep'> {
	return bitpix > 0 ? { digitalRange: [0, 2 ** bitpix - 1], quantizationStep: 1 } : {}
}

// Reads a FITS image while preserving source digital numbers.
export function readImageFromFits(fits: Fits | FitsHdu, source: Source & Seekable, options: DigitalImageReadOptions): Promise<DigitalImage | undefined>
// Reads a FITS image in the normalized processing scale.
export function readImageFromFits(fits: Fits | FitsHdu, source: Source & Seekable, options?: NormalizedImageReadOptions): Promise<Image | undefined>
// Reads a FITS image with the legacy normalized raw-buffer argument.
export function readImageFromFits(fits: Fits | FitsHdu, source: Source & Seekable, raw?: ImageRawType | ImageRawPrecision): Promise<Image | undefined>
// Reads a FITS image with a runtime-selected sample scale.
export function readImageFromFits(fits: Fits | FitsHdu, source: Source & Seekable, options: ImageReadOptions): Promise<Image | DigitalImage | undefined>

export async function readImageFromFits(fits: Fits | FitsHdu, source: Source & Seekable, argument: ImageReadArgument = 'auto'): Promise<Image | DigitalImage | undefined> {
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
	const resolved = resolveImageReadArgument(argument)
	let raw = resolved[0]
	const sampleScale = resolved[1]
	if (raw === 'auto') raw = bitpix === 8 ? 32 : 64
	if (typeof raw === 'number') raw = raw === 32 ? new Float32Array(pixelCount * channels) : new Float64Array(pixelCount * channels)
	if (raw.length < pixelCount * channels) return undefined
	if (!(await reader.read(source, raw, sampleScale))) return undefined

	const metadata = { width, height, channels, pixelCount, pixelSizeInBytes, strideInBytes, stride, bitpix, bayer }
	if (sampleScale === 'digital') return { header, raw, metadata, sampleScale, ...fitsDigitalProperties(header, bitpix) }

	normalize(raw)

	return { header, raw, metadata }
}

// Reads an XISF image while preserving source digital numbers.
export function readImageFromXisf(xisf: Xisf | XisfImage, source: Source & Seekable, options: DigitalImageReadOptions): Promise<DigitalImage | undefined>
// Reads an XISF image in the normalized processing scale.
export function readImageFromXisf(xisf: Xisf | XisfImage, source: Source & Seekable, options?: NormalizedImageReadOptions): Promise<Image | undefined>
// Reads an XISF image with the legacy normalized raw-buffer argument.
export function readImageFromXisf(xisf: Xisf | XisfImage, source: Source & Seekable, raw?: ImageRawType | ImageRawPrecision): Promise<Image | undefined>
// Reads an XISF image with a runtime-selected sample scale.
export function readImageFromXisf(xisf: Xisf | XisfImage, source: Source & Seekable, options: ImageReadOptions): Promise<Image | DigitalImage | undefined>

export async function readImageFromXisf(xisf: Xisf | XisfImage, source: Source & Seekable, argument: ImageReadArgument = 'auto'): Promise<Image | DigitalImage | undefined> {
	const image = 'images' in xisf ? xisf.images[0] : xisf
	const { bitpix, geometry, header } = image
	const { width, height, channels } = geometry

	const pixelSizeInBytes = bitpixInBytes(bitpix)
	const pixelCount = width * height
	const strideInBytes = width * pixelSizeInBytes
	const stride = width * channels
	const bayer = cfaPatternKeyword(header)

	const reader = new XisfImageReader(image)
	const resolved = resolveImageReadArgument(argument)
	let raw = resolved[0]
	const sampleScale = resolved[1]
	if (raw === 'auto') raw = bitpix === 8 ? 32 : 64
	if (typeof raw === 'number') raw = raw === 32 ? new Float32Array(pixelCount * channels) : new Float64Array(pixelCount * channels)
	if (raw.length < pixelCount * channels) return undefined
	if (!(await reader.read(source, raw, sampleScale))) return undefined

	const metadata = { width, height, channels, pixelCount, pixelSizeInBytes, strideInBytes, stride, bitpix, bayer }
	if (sampleScale === 'digital') return { header, raw, metadata, sampleScale, ...xisfDigitalProperties(bitpix) }

	normalize(raw)

	return { header, raw, metadata }
}

// Decodes a JPEG buffer into a single-channel (luminance) normalized Image, or undefined if not JPEG.
export function readImageFromJpeg(buffer: Buffer, raw: ImageRawType | ImageRawPrecision = 'auto', format?: PixelFormat): Image | undefined {
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

// Reads a FITS or XISF source while preserving source digital numbers.
export function readImageFromSource(source: Source & Seekable, options: DigitalImageReadOptions): Promise<DigitalImage | undefined>
// Reads an auto-detected source in the normalized processing scale.
export function readImageFromSource(source: Source & Seekable, options?: NormalizedImageReadOptions): Promise<Image | undefined>
// Reads an auto-detected source with the legacy normalized raw-buffer argument.
export function readImageFromSource(source: Source & Seekable, raw?: ImageRawType | ImageRawPrecision): Promise<Image | undefined>
// Reads an auto-detected source with a runtime-selected sample scale.
export function readImageFromSource(source: Source & Seekable, options: ImageReadOptions): Promise<Image | DigitalImage | undefined>

export async function readImageFromSource(source: Source & Seekable, argument: ImageReadArgument = 'auto'): Promise<Image | DigitalImage | undefined> {
	const { position } = source
	const [, sampleScale] = resolveImageReadArgument(argument)

	const fits = await readFits(source)
	if (fits) return await readImageFromFits(fits, source, argument as ImageReadOptions)

	source.seek(position)

	const xisf = await readXisf(source)
	if (xisf) return await readImageFromXisf(xisf, source, argument as ImageReadOptions)

	source.seek(position)

	const magic = Buffer.allocUnsafe(2)
	if ((await readUntil(source, magic)) !== magic.byteLength || !isJpeg(magic)) return undefined

	source.seek(position)

	if (sampleScale === 'digital') return undefined
	const [raw] = resolveImageReadArgument(argument)
	return readImageFromJpeg(await readRemaining(source), raw)
}

// Reads a buffer while preserving FITS or XISF source digital numbers.
export function readImageFromBuffer(buffer: Buffer, options: DigitalImageReadOptions): Promise<DigitalImage | undefined>
// Reads a buffer in the normalized processing scale.
export function readImageFromBuffer(buffer: Buffer, options?: NormalizedImageReadOptions): Promise<Image | undefined>
// Reads a buffer with the legacy normalized raw-buffer argument.
export function readImageFromBuffer(buffer: Buffer, raw?: ImageRawType | ImageRawPrecision): Promise<Image | undefined>
// Reads a buffer with a runtime-selected sample scale.
export function readImageFromBuffer(buffer: Buffer, options: ImageReadOptions): Promise<Image | DigitalImage | undefined>
export async function readImageFromBuffer(buffer: Buffer, argument: ImageReadArgument = 'auto'): Promise<Image | DigitalImage | undefined> {
	return await readImageFromSource(bufferSource(buffer), argument as ImageReadOptions)
}

// Reads a file handle while preserving FITS or XISF source digital numbers.
export function readImageFromFileHandle(handle: FileHandle, options: DigitalImageReadOptions): Promise<DigitalImage | undefined>
// Reads a file handle in the normalized processing scale.
export function readImageFromFileHandle(handle: FileHandle, options?: NormalizedImageReadOptions): Promise<Image | undefined>
// Reads a file handle with the legacy normalized raw-buffer argument.
export function readImageFromFileHandle(handle: FileHandle, raw?: ImageRawType | ImageRawPrecision): Promise<Image | undefined>
// Reads a file handle with a runtime-selected sample scale.
export function readImageFromFileHandle(handle: FileHandle, options: ImageReadOptions): Promise<Image | DigitalImage | undefined>
export async function readImageFromFileHandle(handle: FileHandle, argument: ImageReadArgument = 'auto'): Promise<Image | DigitalImage | undefined> {
	await using source = fileHandleSource(handle)
	return await readImageFromSource(source, argument as ImageReadOptions)
}

// Reads a FITS or XISF path while preserving source digital numbers.
export function readImageFromPath(path: PathLike, options: DigitalImageReadOptions): Promise<DigitalImage | undefined>
// Reads a path in the normalized processing scale.
export function readImageFromPath(path: PathLike, options?: NormalizedImageReadOptions): Promise<Image | undefined>
// Reads a path with the legacy normalized raw-buffer argument.
export function readImageFromPath(path: PathLike, raw?: ImageRawType | ImageRawPrecision): Promise<Image | undefined>
// Reads a path with a runtime-selected sample scale.
export function readImageFromPath(path: PathLike, options: ImageReadOptions): Promise<Image | DigitalImage | undefined>
export async function readImageFromPath(path: PathLike, argument: ImageReadArgument = 'auto'): Promise<Image | DigitalImage | undefined> {
	await using handle = await fs.open(path, 'r')
	return await readImageFromFileHandle(handle, argument as ImageReadOptions)
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
