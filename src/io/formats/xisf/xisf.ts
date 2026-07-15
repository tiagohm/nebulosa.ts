import { type X2jOptions, XMLParser } from 'fast-xml-parser'
import type { Image, ImageRawType, ImageSampleScale } from '../../../imaging/model/types'
import type { Size } from '../../../math/numerical/geometry'
import type { NumberArray } from '../../../math/numerical/math'
import { deflate, inflate } from '../../compression'
import { readUntil, type Seekable, type Sink, type Source } from '../../io'
import type { Bitpix, FitsHeader, FitsHeaderValue } from '../fits/fits'
import { bitpixInBytes, formatFitsHeaderValue, unescapeQuotedText } from '../fits/util'

// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html

// XISF reader/writer for the monolithic format: parses the XML header and attached image data blocks
// into FITS-compatible headers plus pixel buffers, and serializes images back out. Supports planar and
// normal pixel storage, big/little byte order, optional zlib/zstd compression with byte-shuffling, and
// 8/16/32-bit unsigned integer and 32/64-bit float samples. This is a Bun/Node runtime module (Buffer,
// Bun.zstd*), and relies on fast-xml-parser for header parsing.

// XISF pixel sample data type.
export type XisfSampleFormat = 'UInt8' | 'UInt16' | 'UInt32' | 'UInt64' | 'Float32' | 'Float64'

// Image color space (only Gray and RGB are handled by the reader).
export type XisfColorSpace = 'Gray' | 'RGB' | 'CIELab'

// Channel memory layout: Planar (channel-major) or Normal (pixel-interleaved).
export type XisfPixelStorageModel = 'Planar' | 'Normal'

// Semantic frame type declared by the image.
export type XisfImageType = 'Bias' | 'Dark' | 'Flat' | 'Light' | 'MasterBias' | 'MasterDark' | 'MasterFlat' | 'MasterLight' | 'DefectMap' | 'RejectionMapHigh' | 'RejectionMapLow' | 'BinaryRejectionMapHigh' | 'BinaryRejectionMapLow' | 'SlopeMap' | 'WeightMap'

// Supported compression codec name (only zlib and zstd are implemented for read/write).
export type XisfCompressionFormat = 'zlib' | 'lz4' | 'lz4hc' | 'zstd'

// Compression codec name with the '+sh' byte-shuffling suffix.
export type XisfShuffledCompressionFormat = `${XisfCompressionFormat}+sh`

// Byte order of multibyte samples in the data block.
export type XisfByteOrder = 'big' | 'little'

// Checksum algorithm names allowed by the spec.
export type XisfChecksumAlgorithm = 'sha-1' | 'sha-256' | 'sha-512' | 'sha3-256' | 'sha3-512' | 'sha1' | 'sha256' | 'sha512'

// Scalar property value type used in XISF property elements.
export type XisfPropertyType = 'UInt8' | 'UInt16' | 'UInt32' | 'UInt64' | 'Float32' | 'Float64' | 'Int8' | 'Int16' | 'Int32' | 'Int64' | 'Boolean' | 'String'

// Magic signature at the start of a monolithic XISF file.
export const XISF_SIGNATURE = 'XISF0100'

// Returns true when the input begins with the XISF0100 signature.
export function isXisf(input: ArrayBufferLike | Buffer) {
	if (input.byteLength < XISF_SIGNATURE.length) return false

	const bytes = Buffer.isBuffer(input) ? input : new Uint8Array(input, 0, XISF_SIGNATURE.length)

	for (let i = 0; i < XISF_SIGNATURE.length; i++) {
		if (bytes[i] !== XISF_SIGNATURE.charCodeAt(i)) return false
	}

	return true
}

// A parsed XISF file as its list of supported images.
export interface Xisf {
	// Images decoded from the header, in document order.
	readonly images: readonly XisfImage[]
}

// A resolved XISF image: FITS-compatible header plus the data block location and decoding parameters.
export interface XisfImage extends Required<Pick<XisfParsedImage, 'byteOrder' | 'colorSpace' | 'imageType' | 'pixelStorage' | 'sampleFormat'>> {
	// FITS-style header synthesized from the image geometry and FITSKeyword elements.
	readonly header: FitsHeader
	// Offset/size of the attached pixel data block.
	readonly location: XisfLocation
	// Image dimensions and channel count.
	readonly geometry: XisfGeometry
	// Compression descriptor, present only when the block is compressed.
	readonly compression?: XisfCompression
	// Equivalent FITS BITPIX code for the sample format.
	readonly bitpix: Bitpix
}

// Compression descriptor parsed from an image's `compression` attribute.
export interface XisfCompression {
	// Codec used.
	readonly format: XisfCompressionFormat
	// Whether byte-shuffling was applied before compression.
	readonly shuffled: boolean
	// Size in bytes of the uncompressed data block.
	readonly uncompressedSize: number
	// Element size in bytes used by byte-shuffling (0 when not shuffled).
	readonly itemSize: number
}

// Compression options requested when writing.
export interface XisfWriteCompression {
	// Codec to use (only zlib and zstd are implemented).
	readonly format: XisfCompressionFormat
	// Whether to byte-shuffle multibyte samples before compressing.
	readonly shuffled?: boolean
	// Codec compression level.
	readonly level?: number
}

// Output format options for writeXisf.
export interface XisfWriteFormat {
	// Byte order for multibyte samples (default little).
	readonly byteOrder?: XisfByteOrder
	// Channel storage layout (default Planar).
	readonly pixelStorage?: XisfPixelStorageModel
	// Compression settings, or false for uncompressed output.
	readonly compression?: false | XisfWriteCompression
}

// Byte offset and length of an attached data block within the file.
export interface XisfLocation {
	// Byte offset of the data block from the start of the file.
	readonly offset: number
	// Length of the data block in bytes (compressed size when compressed).
	readonly size: number
}

// Image dimensions: width/height from Size plus channel count.
export interface XisfGeometry extends Readonly<Size> {
	// Number of channels (1 for gray, 3 for RGB).
	readonly channels: number
}

// Raw <Image> element as produced by the XML parser, with attributes as colon-delimited strings.
export interface XisfParsedImage {
	// Embedded FITS keyword element(s).
	readonly FITSKeyword?: XisfParsedFitsKeyword | readonly XisfParsedFitsKeyword[]
	// "width:height:channels" geometry string.
	readonly geometry: `${number}:${number}:${number}`
	// Sample data type.
	readonly sampleFormat: XisfSampleFormat
	// "low:high" sample value bounds (for floating-point images).
	readonly bounds: `${number}:${number}`
	// Color space name.
	readonly colorSpace: XisfColorSpace
	// "attachment:offset:size" data block location.
	readonly location: `attachment:${number}:${number}`
	// Channel storage layout.
	readonly pixelStorage?: XisfPixelStorageModel
	// Semantic frame type.
	readonly imageType?: XisfImageType
	// Byte order of multibyte samples.
	readonly byteOrder?: XisfByteOrder
	// "algorithm:digest" checksum of the data block.
	readonly checksum?: `${XisfChecksumAlgorithm}:${string}`
	// "format:uncompressedSize[:itemSize]" compression descriptor.
	readonly compression?: `${XisfCompressionFormat | XisfShuffledCompressionFormat}:${string}`
}

// Raw <FITSKeyword> element from the XML header.
export interface XisfParsedFitsKeyword {
	// Keyword name.
	readonly name: string
	// Keyword value (still a raw string from XML).
	readonly value: FitsHeaderValue
	// Keyword comment.
	readonly comment: string
}

// Root <xisf> element as parsed, holding one or more images.
export interface XisfParsedHeader {
	// Parsed image element(s), if any.
	readonly Image?: XisfParsedImage | readonly XisfParsedImage[]
}

// fast-xml-parser configuration: keep attributes (unprefixed) and read element text into a `value` field.
const XML_PARSE_OPTIONS: X2jOptions = {
	ignoreAttributes: false,
	attributeNamePrefix: '',
	removeNSPrefix: true,
	textNodeName: 'value',
}

// Reads an XISF file from a seekable source: validates the signature, reads the XML header of the
// declared length, and parses it into images (data blocks are not read here). Returns undefined for non-XISF input.
export async function readXisf(source: Source & Seekable): Promise<Xisf | undefined> {
	const signatureData = Buffer.allocUnsafe(16)
	if ((await readUntil(source, signatureData, 16)) !== 16 || !isXisf(signatureData)) return undefined

	const headerLength = signatureData.readUint32LE(8)
	const headerData = Buffer.allocUnsafe(headerLength)
	if ((await readUntil(source, headerData, headerLength)) !== headerLength) return undefined

	const images = parseXisfHeader(headerData)

	return { images }
}

// FITS keywords that XISF encodes structurally; they are not re-emitted as FITSKeyword elements.
const RESERVED_FITS_KEYS = new Set(['SIMPLE', 'BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'NAXIS3'])
// Default write format: little-endian, planar, uncompressed.
const DEFAULT_WRITE_XISF_FORMAT: Required<XisfWriteFormat> = { byteOrder: 'little', pixelStorage: 'Planar', compression: false }

// Per-image working state accumulated while writing: dimensions, declared format, FITSKeyword XML
// fragments, and the encoded data block.
interface XisfWriteEntry {
	readonly bitpix: Bitpix
	readonly width: number
	readonly height: number
	readonly channels: number
	readonly sampleFormat: XisfSampleFormat
	readonly colorSpace: XisfColorSpace
	readonly fitsKeywords: readonly string[]
	readonly encoded: XisfEncodedBlock
}

// An encoded image data block plus its compression descriptor (absent when stored uncompressed).
interface XisfEncodedBlock {
	readonly data: Buffer
	readonly compression?: XisfCompression
}

// Builds a correctly aligned typed view over the backing XISF image buffer.
function xisfDataView(buffer: Buffer, bitpix: Bitpix): NumberArray {
	const byteLength = buffer.byteLength

	if (byteLength === 0) return new Uint8Array(0)

	const pixelInBytes = bitpixInBytes(bitpix)

	if (pixelInBytes < 1 || byteLength % pixelInBytes !== 0) {
		throw new Error('invalid XISF image buffer size')
	}

	const { byteOffset } = buffer
	const length = byteLength / pixelInBytes

	switch (bitpix) {
		case 8:
			return new Uint8Array(buffer.buffer, byteOffset, length)
		case 16:
			return new Uint16Array(buffer.buffer, byteOffset, length)
		case 32:
			return new Uint32Array(buffer.buffer, byteOffset, length)
		case -32:
			return new Float32Array(buffer.buffer, byteOffset, length)
		case -64:
			return new Float64Array(buffer.buffer, byteOffset, length)
		default:
			throw new Error(`unsupported XISF BITPIX: ${bitpix}`)
	}
}

// Uses the caller-provided buffer when aligned, otherwise allocates an aligned scratch buffer.
function xisfBufferView(buffer: Buffer | undefined, size: number, bitpix: Bitpix): Buffer {
	if (buffer === undefined) return Buffer.allocUnsafe(size)
	if (buffer.byteLength < size) throw new Error('XISF image buffer is too small')

	const view = buffer.subarray(0, size)
	const pixelInBytes = bitpixInBytes(bitpix)

	if (size === 0 || pixelInBytes <= 1 || view.byteOffset % pixelInBytes === 0) return view

	return Buffer.allocUnsafe(size)
}

// Maps a FITS BITPIX code to the corresponding XISF sample format (unsigned integers / IEEE floats).
function sampleFormatFromBitpix(bitpix: Bitpix): XisfSampleFormat {
	switch (bitpix) {
		case 8:
			return 'UInt8'
		case 16:
			return 'UInt16'
		case 32:
			return 'UInt32'
		case 64:
			return 'UInt64'
		case -32:
			return 'Float32'
		case -64:
			return 'Float64'
		default:
			throw new Error(`unsupported XISF BITPIX: ${bitpix}`)
	}
}

// Type guard for sample formats the reader can decode.
function isSupportedSampleFormat(sampleFormat: string): sampleFormat is XisfSampleFormat {
	return sampleFormat === 'UInt8' || sampleFormat === 'UInt16' || sampleFormat === 'UInt32' || sampleFormat === 'UInt64' || sampleFormat === 'Float32' || sampleFormat === 'Float64'
}

// Type guard for recognized compression codec names.
function isSupportedCompressionFormat(format: string): format is XisfCompressionFormat {
	return format === 'zlib' || format === 'lz4' || format === 'lz4hc' || format === 'zstd'
}

// Compresses a buffer with the requested codec (zstd or zlib), or undefined for unsupported codecs.
function compress(input: ArrayBuffer | Buffer | NodeJS.TypedArray, compression: XisfWriteCompression) {
	if (compression.format === 'zstd') return Bun.zstdCompress(input, compression)
	else if (compression.format === 'zlib') return deflate(input, compression)
	return undefined
}

// Escapes the five XML special characters for safe inclusion in attribute values.
function escapeXml(text: string) {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

// Writes images to `sink` as a monolithic XISF file: encodes each image's data block, then builds the
// XML header (iterating until the data offsets stabilize), and writes signature, header, and blocks.
// Returns total bytes written.
export async function writeXisf(sink: Sink, images: readonly Readonly<Pick<Image, 'header' | 'raw' | 'sampleScale'>>[], format: XisfWriteFormat = DEFAULT_WRITE_XISF_FORMAT) {
	const options = { ...DEFAULT_WRITE_XISF_FORMAT, ...format }
	const entries: XisfWriteEntry[] = []

	for (const image of images) {
		const { header } = image
		const bitpix = (header.BITPIX as Bitpix) || -64
		const width = +header.NAXIS1! || 0
		const height = +header.NAXIS2! || 0
		const channels = +header.NAXIS3! || 1
		const sampleFormat = sampleFormatFromBitpix(bitpix)
		const colorSpace: XisfColorSpace = channels >= 3 ? 'RGB' : 'Gray'
		const fitsKeywords: string[] = []

		for (const key in header) {
			const value = header[key]
			if (value === undefined || RESERVED_FITS_KEYS.has(key)) continue
			fitsKeywords.push(`<FITSKeyword name="${escapeXml(key)}" value="${escapeXml(formatFitsHeaderValue(value))}" comment=""/>`)
		}

		const writer = new XisfImageWriter({ byteOrder: options.byteOrder, pixelStorage: options.pixelStorage, bitpix, geometry: { width, height, channels } }, options.compression)
		const encoded = await writer.encode(image.raw)
		entries.push({ bitpix, width, height, channels, sampleFormat, colorSpace, fitsKeywords, encoded })
	}

	const buildHeader = (offset: number) => {
		let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<xisf version="1.0">'

		for (const entry of entries) {
			const bounds = entry.bitpix === -64 || entry.bitpix === -32 ? ' bounds="0:1"' : ''
			const byteOrder = entry.bitpix === 8 ? '' : ` byteOrder="${options.byteOrder}"`
			const compression = entry.encoded.compression ? ` compression="${formatCompression(entry.encoded.compression)}"` : ''
			xml += `<Image geometry="${entry.width}:${entry.height}:${entry.channels}" sampleFormat="${entry.sampleFormat}" colorSpace="${entry.colorSpace}" location="attachment:${offset}:${entry.encoded.data.byteLength}" pixelStorage="${options.pixelStorage}"${byteOrder}${bounds}${compression}>`
			if (entry.fitsKeywords.length > 0) xml += entry.fitsKeywords.join('')
			xml += '</Image>'
			offset += entry.encoded.data.byteLength
		}

		xml += '</xisf>'

		return Buffer.from(xml)
	}

	let firstDataOffset = 16
	let headerData = buildHeader(firstDataOffset)

	for (let i = 0; i < 8; i++) {
		const nextOffset = 16 + headerData.byteLength
		if (nextOffset === firstDataOffset) break
		firstDataOffset = nextOffset
		headerData = buildHeader(firstDataOffset)
	}

	const signatureData = Buffer.allocUnsafe(16)
	signatureData.write(XISF_SIGNATURE, 0, 8, 'ascii')
	signatureData.writeUInt32LE(headerData.byteLength, 8)

	let size = await sink.write(signatureData)
	size += await sink.write(headerData)

	for (const entry of entries) {
		size += await sink.write(entry.encoded.data)
	}

	return size
}

// Shared XML parser instance for XISF headers.
const XML_PARSER = new XMLParser(XML_PARSE_OPTIONS)

// Parses the XISF XML header buffer into the list of supported images, skipping any image whose location
// is not an attachment, whose color space is not Gray/RGB, whose sample format is unsupported, or whose
// geometry/location/compression metadata is invalid.
export function parseXisfHeader(data: Buffer) {
	const parsedHeader = XML_PARSER.parse(data)?.xisf as XisfParsedHeader | undefined
	if (!parsedHeader?.Image) return []

	const parsedImages = parsedHeader.Image instanceof Array ? parsedHeader.Image : [parsedHeader.Image]
	const images: XisfImage[] = []

	for (const image of parsedImages) {
		if (!image.location.startsWith('attachment:')) continue
		if (image.colorSpace !== 'Gray' && image.colorSpace !== 'RGB') continue
		if (!isSupportedSampleFormat(image.sampleFormat) || image.sampleFormat === 'UInt64') continue

		const geometry = parseGeometry(image.geometry)
		const location = parseLocation(image.location)
		if (!geometry || !location) continue

		const compression = image.compression ? parseCompression(image.compression) : undefined
		if (image.compression && !compression) continue

		const header = makeFitsHeaderFromParsedImage(image, geometry)
		const colorSpace = image.colorSpace
		const sampleFormat = image.sampleFormat
		const byteOrder = image.byteOrder === 'big' ? 'big' : 'little'
		const imageType = image.imageType ?? 'Light'
		const pixelStorage = image.pixelStorage === 'Normal' ? 'Normal' : 'Planar'

		images.push({ header, location, geometry, compression, colorSpace, sampleFormat, bitpix: header.BITPIX as Bitpix, byteOrder, imageType, pixelStorage })
	}

	return images
}

// Matches FITS numeric values, including scientific notation such as `1.5e-10`,
// `3E+8`, or `1e21`. The full-string anchors keep quoted string values (which the
// writer wraps in `'...'`) from being misread as numbers.
const NUMERIC_VALUE_REGEX = /^[-+]?([0-9]*\.[0-9]+|[0-9]+)([eE][-+]?[0-9]+)?$/

// Builds a FITS-style header from a parsed image: synthesizes the structural keywords from the geometry
// and merges the FITSKeyword elements, inferring each value's type (logical, quoted string, number, or text).
function makeFitsHeaderFromParsedImage(image: XisfParsedImage, geometry: XisfGeometry = parseGeometry(image.geometry)!) {
	const header: FitsHeader = { SIMPLE: true, BITPIX: bitpixFromSampleFormat(image.sampleFormat), NAXIS: geometry.channels >= 3 ? 3 : 2, NAXIS1: geometry.width, NAXIS2: geometry.height }

	if (geometry.channels >= 3) header.NAXIS3 = geometry.channels

	if (image.FITSKeyword) {
		const keywords = image.FITSKeyword instanceof Array ? image.FITSKeyword : [image.FITSKeyword]

		for (const keyword of keywords) {
			if (keyword.name in header) continue

			const value = (keyword.value as string | undefined)?.trim()

			if (value === '' || value === undefined || value === null) continue
			else if (value === 'T') header[keyword.name] = true
			else if (value === 'F') header[keyword.name] = false
			else if (value.startsWith("'") && value.endsWith("'")) header[keyword.name] = unescapeQuotedText(value.slice(1, value.length - 1).trim())
			else if (NUMERIC_VALUE_REGEX.test(value)) header[keyword.name] = +value
			else header[keyword.name] = value
		}
	}

	return header
}

// Parses an "attachment:offset:size" location string into offset/size, or undefined when malformed.
function parseLocation(location: XisfParsedImage['location']): XisfLocation | undefined {
	const start = location.indexOf(':')
	const end = location.indexOf(':', start + 1)
	if (start < 0 || end < 0 || end + 1 >= location.length) return undefined

	const offset = +location.slice(start + 1, end)
	const size = +location.slice(end + 1)

	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(size) || size <= 0) return undefined

	return { offset, size }
}

// Parses a "width:height:channels" geometry string into positive integers, or undefined when malformed.
function parseGeometry(geometry: XisfParsedImage['geometry']): XisfGeometry | undefined {
	const first = geometry.indexOf(':')
	const second = geometry.indexOf(':', first + 1)
	if (first <= 0 || second <= first + 1 || second + 1 >= geometry.length) return undefined

	const width = +geometry.slice(0, first)
	const height = +geometry.slice(first + 1, second)
	const channels = +geometry.slice(second + 1)

	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || !Number.isInteger(channels) || channels <= 0) return undefined

	return { width, height, channels }
}

// Parses a "format[+sh]:uncompressedSize[:itemSize]" compression string into a descriptor, or undefined when malformed.
function parseCompression(compression: NonNullable<XisfParsedImage['compression']>): XisfCompression | undefined {
	const first = compression.indexOf(':')
	if (first <= 0) return undefined

	const token = compression.slice(0, first)
	const shuffled = token.endsWith('+sh')
	const format = shuffled ? token.slice(0, token.length - 3) : token
	if (!isSupportedCompressionFormat(format)) return undefined

	const second = compression.indexOf(':', first + 1)
	const uncompressedSize = +(second < 0 ? compression.slice(first + 1) : compression.slice(first + 1, second))
	if (!Number.isInteger(uncompressedSize) || uncompressedSize <= 0) return undefined

	const itemSize = shuffled ? +(second < 0 ? '' : compression.slice(second + 1)) : 0
	if (shuffled && (!Number.isInteger(itemSize) || itemSize <= 0)) return undefined

	return { format, shuffled, uncompressedSize, itemSize }
}

// Serializes a compression descriptor back into its XISF attribute string form.
function formatCompression(compression: XisfCompression) {
	if (compression.shuffled) return `${compression.format}+sh:${compression.uncompressedSize}:${compression.itemSize}`
	return `${compression.format}:${compression.uncompressedSize}`
}

// Maps an XISF sample format to the equivalent FITS BITPIX code.
export function bitpixFromSampleFormat(sampleFormat: XisfSampleFormat): Bitpix {
	switch (sampleFormat) {
		case 'UInt8':
			return 8
		case 'UInt16':
			return 16
		case 'UInt32':
			return 32
		case 'UInt64':
			return 64
		case 'Float32':
			return -32
		case 'Float64':
			return -64
		default:
			throw new Error(`unsupported XISF sample format: ${sampleFormat}`)
	}
}

// Decompresses a buffer with the given codec (zstd or zlib), or undefined for unsupported codecs.
function decompress(input: ArrayBuffer | Buffer | NodeJS.TypedArray, format: XisfCompressionFormat) {
	if (format === 'zstd') return Bun.zstdDecompress(input)
	else if (format === 'zlib') return inflate(input)
	return undefined
}

// Reads an XISF image's pixel block into interleaved normalized or digital samples.
export class XisfImageReader {
	readonly #buffer: Buffer
	readonly #compressed?: Buffer
	readonly #data: NumberArray

	// Prepares to read `image`; an optional caller `buffer` is reused as scratch storage when alignment allows.
	constructor(
		readonly image: Pick<XisfImage, 'bitpix' | 'location' | 'compression' | 'byteOrder' | 'pixelStorage' | 'geometry'>,
		buffer?: Buffer,
	) {
		const { bitpix, location, compression } = image
		const size = compression?.uncompressedSize ?? location.size
		this.#buffer = xisfBufferView(buffer, size, bitpix)
		this.#compressed = compression ? Buffer.allocUnsafe(location.size) : undefined
		this.#data = xisfDataView(this.#buffer, bitpix)
	}

	// Reads XISF samples into an interleaved buffer using the requested sample scale.
	async read(source: Source & Seekable, output: ImageRawType, sampleScale: ImageSampleScale = 'normalized') {
		const { bitpix, pixelStorage, geometry, location, compression } = this.image

		source.seek(location.offset)

		const input = this.#compressed ?? this.#buffer
		if ((await readUntil(source, input, location.size, 0)) !== location.size) return false

		if (compression) {
			if (compression.format !== 'zstd' && compression.format !== 'zlib') throw new Error(`unsupported XISF compression format: ${compression.format}`)

			const decompressed = await decompress(input.subarray(0, location.size), compression.format)
			if (decompressed === undefined || decompressed.byteLength !== this.#buffer.byteLength) return false

			if (compression.shuffled) {
				if (compression.itemSize <= 0) return false
				byteUnshuffle(decompressed, this.#buffer, compression.itemSize)
			} else {
				decompressed.copy(this.#buffer)
			}
		}

		const pixelInBytes = bitpixInBytes(this.image.bitpix)

		if (pixelInBytes > 1 && this.image.byteOrder === 'big') {
			if (pixelInBytes === 2) this.#buffer.swap16()
			else if (pixelInBytes === 4) this.#buffer.swap32()
			else if (pixelInBytes === 8) this.#buffer.swap64()
		}

		const data = this.#data
		const { width, height, channels } = geometry
		const numberOfPixels = width * height
		const factor = bitpix > 0 && sampleScale === 'normalized' ? 1 / (2 ** (8 * pixelInBytes) - 1) : 1

		if (pixelStorage === 'Planar') {
			for (let i = 0, p = 0; i < numberOfPixels; i++) {
				for (let c = 0, m = i; c < channels; c++, m += numberOfPixels) {
					output[p++] = data[m] * factor
				}
			}
		} else {
			const total = numberOfPixels * channels

			for (let i = 0; i < total; i++) {
				output[i] = data[i] * factor
			}
		}

		return true
	}
}

// Encodes a channel-interleaved image into an XISF data block: lays it out per the pixel-storage model,
// maps floats to the integer range, swaps byte order, and optionally byte-shuffles and compresses it.
export class XisfImageWriter {
	readonly #buffer: Buffer
	readonly #shuffled?: Buffer
	readonly #data: NumberArray

	// Prepares to encode an image of the given format; an optional caller `buffer` is reused when aligned.
	constructor(
		readonly xisf: Pick<XisfImage, 'byteOrder' | 'bitpix' | 'geometry' | 'pixelStorage' | 'compression'>,
		readonly compression: XisfWriteFormat['compression'] = xisf.compression,
		buffer?: Buffer,
	) {
		const { bitpix, geometry } = xisf
		const { width, height, channels } = geometry
		const pixelInBytes = bitpixInBytes(bitpix)
		this.#buffer = xisfBufferView(buffer, width * height * channels * pixelInBytes, bitpix)
		this.#data = xisfDataView(this.#buffer, bitpix)
		this.#shuffled = compression !== false && compression !== undefined && compression.shuffled && pixelInBytes > 1 ? Buffer.allocUnsafe(this.#buffer.byteLength) : undefined
	}

	// Encodes XISF-format image from RGB-interleaved array into a block buffer
	async encode(input: ImageRawType): Promise<XisfEncodedBlock> {
		const { bitpix, geometry, byteOrder, pixelStorage } = this.xisf
		const { width, height, channels } = geometry
		const pixelInBytes = bitpixInBytes(bitpix)
		const numberOfPixels = width * height
		const factor = bitpix > 0 ? 2 ** bitpix - 1 : 1 // Transform float [0..1] to n-bit integer
		const data = this.#data

		if (pixelStorage === 'Planar') {
			for (let c = 0, p = 0; c < channels; c++) {
				for (let i = 0, m = c; i < numberOfPixels; i++, m += channels) {
					data[p++] = input[m] * factor
				}
			}
		} else {
			const total = numberOfPixels * channels

			for (let i = 0; i < total; i++) {
				data[i] = input[i] * factor
			}
		}

		// little-endian to big-endian
		if (byteOrder === 'big') {
			if (pixelInBytes === 2) this.#buffer.swap16()
			else if (pixelInBytes === 4) this.#buffer.swap32()
			else if (pixelInBytes === 8) this.#buffer.swap64()
		}

		if (!this.compression) return { data: this.#buffer }
		if (this.compression.format !== 'zstd' && this.compression.format !== 'zlib') throw new Error(`unsupported XISF compression format: ${this.compression.format}`)

		const shuffled = this.#shuffled !== undefined && pixelInBytes > 1

		let compressed: Buffer | undefined

		if (shuffled) {
			byteShuffle(this.#buffer, this.#shuffled, pixelInBytes)
			compressed = await compress(this.#shuffled, this.compression)
		} else {
			compressed = await compress(this.#buffer, this.compression)
		}

		return {
			data: compressed!,
			compression: {
				format: this.compression.format,
				shuffled,
				uncompressedSize: this.#buffer.byteLength,
				itemSize: shuffled ? pixelInBytes : 0,
			},
		}
	}

	// Writes XISF-format image from RGB-interleaved array into sink
	async write(input: ImageRawType, sink: Sink) {
		const encoded = await this.encode(input)
		return await sink.write(encoded.data)
	}
}

// For data blocks structured as contiguous sequences of 16-bit or larger integer
// or floating point numbers, a reversible byte shuffling routine can greatly improve
// compression ratios by increasing data locality, i.e. by redistributing the
// sequence such that similar byte values tend to be placed close together.

// Reversibly reorders the bytes of fixed-size items so the i-th byte of every item is grouped together,
// improving compression locality. `itemSize` is bytes per sample; trailing bytes that do not fill a full
// item are copied verbatim. Writes into `output` (must be at least input length).
export function byteShuffle(input: Int8Array | Uint8Array | Buffer, output: Int8Array | Uint8Array | Buffer, itemSize: number) {
	const inputSize = input.byteLength
	if (!Number.isInteger(itemSize) || itemSize <= 0) throw new Error('invalid byte shuffle item size')
	if (output.byteLength < inputSize) throw new Error('byte shuffle output is too small')
	const numberOfItems = Math.trunc(inputSize / itemSize)
	const copyLength = inputSize % itemSize

	let s = 0

	for (let j = 0; j < itemSize; j++) {
		let u = j

		for (let k = 0; k < numberOfItems; k++) {
			output[s++] = input[u]
			u += itemSize
		}
	}

	if (copyLength > 0) output.set(input.subarray(numberOfItems * itemSize, inputSize), s)
}

// Inverse of byteShuffle: restores the original interleaved byte layout of fixed-size items.
export function byteUnshuffle(input: Int8Array | Uint8Array | Buffer, output: Int8Array | Uint8Array | Buffer, itemSize: number) {
	const inputSize = input.byteLength
	if (!Number.isInteger(itemSize) || itemSize <= 0) throw new Error('invalid byte shuffle item size')
	if (output.byteLength < inputSize) throw new Error('byte shuffle output is too small')
	const numberOfItems = Math.trunc(inputSize / itemSize)
	const copyLength = inputSize % itemSize

	let s = 0

	for (let j = 0; j < itemSize; j++) {
		let u = j

		for (let k = 0; k < numberOfItems; k++) {
			output[u] = input[s++]
			u += itemSize
		}
	}

	if (copyLength > 0) output.set(input.subarray(s, s + copyLength), numberOfItems * itemSize)
}
