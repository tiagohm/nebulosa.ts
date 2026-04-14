import { type X2jOptions, XMLParser } from 'fast-xml-parser'
import { deflate, inflate } from './compression'
import type { Bitpix, FitsHeader, FitsHeaderValue } from './fits'
import { bitpixInBytes, formatFitsHeaderValue, unescapeQuotedText } from './fits.util'
import type { Size } from './geometry'
import type { Image, ImageRawType } from './image.types'
import { readUntil, type Seekable, type Sink, type Source } from './io'
import type { NumberArray } from './math'

// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html

export type XisfSampleFormat = 'UInt8' | 'UInt16' | 'UInt32' | 'UInt64' | 'Float32' | 'Float64'

export type XisfColorSpace = 'Gray' | 'RGB' | 'CIELab'

export type XisfPixelStorageModel = 'Planar' | 'Normal'

export type XisfImageType = 'Bias' | 'Dark' | 'Flat' | 'Light' | 'MasterBias' | 'MasterDark' | 'MasterFlat' | 'MasterLight' | 'DefectMap' | 'RejectionMapHigh' | 'RejectionMapLow' | 'BinaryRejectionMapHigh' | 'BinaryRejectionMapLow' | 'SlopeMap' | 'WeightMap'

export type XisfCompressionFormat = 'zlib' | 'lz4' | 'lz4hc' | 'zstd'

export type XisfShuffledCompressionFormat = `${XisfCompressionFormat}+sh`

export type XisfByteOrder = 'big' | 'little'

export type XisfChecksumAlgorithm = 'sha-1' | 'sha-256' | 'sha-512' | 'sha3-256' | 'sha3-512' | 'sha1' | 'sha256' | 'sha512'

export type XisfPropertyType = 'UInt8' | 'UInt16' | 'UInt32' | 'UInt64' | 'Float32' | 'Float64' | 'Int8' | 'Int16' | 'Int32' | 'Int64' | 'Boolean' | 'String'

export const XISF_SIGNATURE = 'XISF0100'

export function isXisf(input: ArrayBufferLike | Buffer) {
	if (input.byteLength < XISF_SIGNATURE.length) return false

	const bytes = Buffer.isBuffer(input) ? input : new Uint8Array(input, 0, XISF_SIGNATURE.length)

	for (let i = 0; i < XISF_SIGNATURE.length; i++) {
		if (bytes[i] !== XISF_SIGNATURE.charCodeAt(i)) return false
	}

	return true
}

export interface Xisf {
	readonly images: readonly XisfImage[]
}

export interface XisfImage extends Required<Pick<XisfParsedImage, 'byteOrder' | 'colorSpace' | 'imageType' | 'pixelStorage' | 'sampleFormat'>> {
	readonly header: FitsHeader
	readonly location: XisfLocation
	readonly geometry: XisfGeometry
	readonly compression?: XisfCompression
	readonly bitpix: Bitpix
}

export interface XisfCompression {
	readonly format: XisfCompressionFormat
	readonly shuffled: boolean
	readonly uncompressedSize: number
	readonly itemSize: number
}

export interface XisfWriteCompression {
	readonly format: XisfCompressionFormat
	readonly shuffled?: boolean
	readonly level?: number
}

export interface XisfWriteFormat {
	readonly byteOrder?: XisfByteOrder
	readonly pixelStorage?: XisfPixelStorageModel
	readonly compression?: false | XisfWriteCompression
}

export interface XisfLocation {
	readonly offset: number
	readonly size: number
}

export interface XisfGeometry extends Readonly<Size> {
	readonly channels: number
}

export interface XisfParsedImage {
	readonly FITSKeyword?: XisfParsedFitsKeyword | readonly XisfParsedFitsKeyword[]
	readonly geometry: `${number}:${number}:${number}`
	readonly sampleFormat: XisfSampleFormat
	readonly bounds: `${number}:${number}`
	readonly colorSpace: XisfColorSpace
	readonly location: `attachment:${number}:${number}`
	readonly pixelStorage?: XisfPixelStorageModel
	readonly imageType?: XisfImageType
	readonly byteOrder?: XisfByteOrder
	readonly checksum?: `${XisfChecksumAlgorithm}:${string}`
	readonly compression?: `${XisfCompressionFormat | XisfShuffledCompressionFormat}:${string}`
}

export interface XisfParsedFitsKeyword {
	readonly name: string
	readonly value: FitsHeaderValue
	readonly comment: string
}

export interface XisfParsedHeader {
	readonly Image?: XisfParsedImage | readonly XisfParsedImage[]
}

const XML_PARSE_OPTIONS: X2jOptions = {
	ignoreAttributes: false,
	attributeNamePrefix: '',
	removeNSPrefix: true,
	textNodeName: 'value',
}

export async function readXisf(source: Source & Seekable): Promise<Xisf | undefined> {
	const signatureData = Buffer.allocUnsafe(16)
	if ((await readUntil(source, signatureData, 16)) !== 16 || !isXisf(signatureData)) return undefined

	const headerLength = signatureData.readUint32LE(8)
	const headerData = Buffer.allocUnsafe(headerLength)
	if ((await readUntil(source, headerData, headerLength)) !== headerLength) return undefined

	const images = parseXisfHeader(headerData)

	return { images }
}

const RESERVED_FITS_KEYS = new Set(['SIMPLE', 'BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'NAXIS3'])
const DEFAULT_WRITE_XISF_FORMAT: Required<XisfWriteFormat> = { byteOrder: 'little', pixelStorage: 'Planar', compression: false }

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

function isSupportedSampleFormat(sampleFormat: string): sampleFormat is XisfSampleFormat {
	return sampleFormat === 'UInt8' || sampleFormat === 'UInt16' || sampleFormat === 'UInt32' || sampleFormat === 'UInt64' || sampleFormat === 'Float32' || sampleFormat === 'Float64'
}

function isSupportedCompressionFormat(format: string): format is XisfCompressionFormat {
	return format === 'zlib' || format === 'lz4' || format === 'lz4hc' || format === 'zstd'
}

function compress(input: ArrayBuffer | Buffer | NodeJS.TypedArray, compression: XisfWriteCompression) {
	if (compression.format === 'zstd') return Bun.zstdCompress(input, compression)
	else if (compression.format === 'zlib') return deflate(input, compression)
}

function escapeXml(text: string) {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

export async function writeXisf(sink: Sink, images: readonly Readonly<Pick<Image, 'header' | 'raw'>>[], format: XisfWriteFormat = DEFAULT_WRITE_XISF_FORMAT) {
	const options = { ...DEFAULT_WRITE_XISF_FORMAT, ...format }
	const entries: XisfWriteEntry[] = []

	for (const image of images) {
		const { header } = image
		const bitpix = (header.BITPIX as Bitpix) || -64
		const width = +header.NAXIS1! || 0
		const height = +header.NAXIS2! || 0
		const channels = (+header.NAXIS3! || 1) as number
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
			const byteOrder = entry.bitpix !== 8 ? ` byteOrder="${options.byteOrder}"` : ''
			const compression = entry.encoded.compression ? ` compression="${formatCompression(entry.encoded.compression)}"` : ''
			xml += `<Image geometry="${entry.width}:${entry.height}:${entry.channels}" sampleFormat="${entry.sampleFormat}" colorSpace="${entry.colorSpace}" location="attachment:${offset}:${entry.encoded.data.byteLength}" pixelStorage="${options.pixelStorage}"${byteOrder}${bounds}${compression}>`
			if (entry.fitsKeywords.length) xml += entry.fitsKeywords.join('')
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

const XML_PARSER = new XMLParser(XML_PARSE_OPTIONS)

export function parseXisfHeader(data: Buffer) {
	const parsedHeader = XML_PARSER.parse(data)?.xisf as XisfParsedHeader | undefined
	if (!parsedHeader?.Image) return []

	const parsedImages = Array.isArray(parsedHeader.Image) ? parsedHeader.Image : [parsedHeader.Image]
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

const NUMERIC_VALUE_REGEX = /^[-+]?([0-9]*\.[0-9]+|[0-9]+)$/

function makeFitsHeaderFromParsedImage(image: XisfParsedImage, geometry: XisfGeometry = parseGeometry(image.geometry)!) {
	const header: FitsHeader = { SIMPLE: true }

	header.BITPIX = bitpixFromSampleFormat(image.sampleFormat)
	header.NAXIS = geometry.channels >= 3 ? 3 : 2
	header.NAXIS1 = geometry.width
	header.NAXIS2 = geometry.height
	if (geometry.channels >= 3) header.NAXIS3 = geometry.channels

	if (image.FITSKeyword) {
		const keywords = Array.isArray(image.FITSKeyword) ? image.FITSKeyword : [image.FITSKeyword]

		for (const keyword of keywords) {
			if (keyword.name in header) continue

			const value = (keyword.value as string | undefined)?.trim()

			if (value === '' || value === undefined || value === null) continue
			else if (value === 'T') header[keyword.name] = true
			else if (value === 'F') header[keyword.name] = false
			else if (value.startsWith("'") && value.endsWith("'")) header[keyword.name] = unescapeQuotedText(value.substring(1, value.length - 1).trim())
			else if (NUMERIC_VALUE_REGEX.test(value)) header[keyword.name] = +value
			else header[keyword.name] = value
		}
	}

	return header
}

function parseLocation(location: XisfParsedImage['location']): XisfLocation | undefined {
	const start = location.indexOf(':')
	const end = location.indexOf(':', start + 1)
	if (start < 0 || end < 0 || end + 1 >= location.length) return undefined

	const offset = +location.slice(start + 1, end)
	const size = +location.slice(end + 1)

	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(size) || size <= 0) return undefined

	return { offset, size }
}

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

function formatCompression(compression: XisfCompression) {
	if (compression.shuffled) return `${compression.format}+sh:${compression.uncompressedSize}:${compression.itemSize}`
	return `${compression.format}:${compression.uncompressedSize}`
}

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

function decompress(input: ArrayBuffer | Buffer | NodeJS.TypedArray, format: XisfCompressionFormat) {
	if (format === 'zstd') return Bun.zstdDecompress(input)
	else if (format === 'zlib') return inflate(input)
}

export class XisfImageReader {
	readonly #buffer: Buffer
	readonly #compressed?: Buffer
	readonly #data: NumberArray

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

	// Reads XISF-format image from source into RGB-interleaved array
	async read(source: Source & Seekable, output: ImageRawType) {
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
		const factor = bitpix > 0 ? 1 / (2 ** (8 * pixelInBytes) - 1) : 1

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

export class XisfImageWriter {
	readonly #buffer: Buffer
	readonly #shuffled?: Buffer
	readonly #data: NumberArray

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
