import { type X2jOptions, XMLParser } from 'fast-xml-parser'
import { type Bitpix, bitpixInBytes, type FitsHeader, type FitsHeaderValue, fitsHeaderValueToText } from './fits'
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
	if (input.byteLength < 8) return false

	if (Buffer.isBuffer(input)) {
		return input.toString('ascii', 0, 8) === XISF_SIGNATURE
	} else {
		return isXisf(Buffer.from(input, 0, 8))
	}
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
const DEFAULT_WRITE_XISF_FORMAT: Pick<XisfImage, 'byteOrder' | 'pixelStorage'> = { byteOrder: 'little', pixelStorage: 'Planar' }

export async function writeXisf(sink: Sink & Seekable, images: readonly Readonly<Pick<Image, 'header' | 'raw'>>[], format: Pick<XisfImage, 'byteOrder' | 'pixelStorage'> = DEFAULT_WRITE_XISF_FORMAT) {
	const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')

	const entries = images.map((image) => {
		const { header } = image
		const bitpix = (header.BITPIX as Bitpix) || -64
		const width = +header.NAXIS1! || 0
		const height = +header.NAXIS2! || 0
		const channels = (+header.NAXIS3! || 1) as number
		const sampleFormat: XisfSampleFormat = bitpix === 8 ? 'UInt8' : bitpix === 16 ? 'UInt16' : bitpix === 32 ? 'UInt32' : bitpix === 64 ? 'UInt64' : bitpix === -32 ? 'Float32' : 'Float64'
		const colorSpace: XisfColorSpace = channels >= 3 ? 'RGB' : 'Gray'
		const size = width * height * channels * bitpixInBytes(bitpix)
		const fitsKeywords: string[] = []

		for (const key in header) {
			const value = header[key]
			if (value === undefined || RESERVED_FITS_KEYS.has(key)) continue
			fitsKeywords.push(`<FITSKeyword name="${escapeXml(key)}" value="${escapeXml(fitsHeaderValueToText(value))}" comment=""/>`)
		}

		return { raw: image.raw, bitpix, width, height, channels, sampleFormat, colorSpace, size, fitsKeywords }
	})

	const buildHeader = (offset: number) => {
		let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<xisf version="1.0">'

		for (const entry of entries) {
			const bounds = entry.bitpix === -64 || entry.bitpix === -32 ? ' bounds="0:1"' : ''
			const byteOrder = entry.bitpix !== 8 ? ` byteOrder="${format.byteOrder}"` : ''
			xml += `<Image geometry="${entry.width}:${entry.height}:${entry.channels}" sampleFormat="${entry.sampleFormat}" colorSpace="${entry.colorSpace}" location="attachment:${offset}:${entry.size}" pixelStorage="${format.pixelStorage}"${byteOrder}${bounds}>`
			if (entry.fitsKeywords.length) xml += entry.fitsKeywords.join('')
			xml += '</Image>'
			offset += entry.size
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

	sink.seek(0)

	await sink.write(signatureData)
	await sink.write(headerData)

	for (const entry of entries) {
		const writer = new XisfImageWriter({ byteOrder: format.byteOrder, pixelStorage: format.pixelStorage, bitpix: entry.bitpix, geometry: entry })
		await writer.write(entry.raw, sink)
	}
}

const XML_PARSER = new XMLParser(XML_PARSE_OPTIONS)

export function parseXisfHeader(data: Buffer) {
	const parsedHeader = XML_PARSER.parse(data)?.xisf as XisfParsedHeader | undefined
	if (!parsedHeader?.Image) return []

	const parsedImages = parsedHeader.Image instanceof Array ? parsedHeader.Image : [parsedHeader.Image]
	const images: XisfImage[] = []

	for (const image of parsedImages) {
		if (!image.location.startsWith('attachment:')) continue
		if (image.colorSpace === 'CIELab') continue
		if (image.sampleFormat === 'UInt64') continue

		const geometry = parseGeometry(image.geometry)
		const header = makeFitsHeaderFromParsedImage(image, geometry)
		const location = parseLocation(image.location)
		const compression = parseCompression(image.compression)
		const { colorSpace, sampleFormat, byteOrder = 'little', imageType = 'Light', pixelStorage = 'Planar' } = image

		images.push({ header, location, geometry, compression, colorSpace, sampleFormat, bitpix: header.BITPIX as Bitpix, byteOrder, imageType, pixelStorage })
	}

	return images
}

function makeFitsHeaderFromParsedImage(image: XisfParsedImage, geometry: XisfGeometry = parseGeometry(image.geometry)) {
	const header: FitsHeader = { SIMPLE: true }

	header.BITPIX = bitpixFromSampleFormat(image.sampleFormat)
	header.NAXIS = geometry.channels >= 3 ? 3 : 2
	header.NAXIS1 = geometry.width
	header.NAXIS2 = geometry.height
	if (geometry.channels >= 3) header.NAXIS3 = geometry.channels

	if (image.FITSKeyword) {
		const keywords = image.FITSKeyword instanceof Array ? image.FITSKeyword : [image.FITSKeyword]

		for (const keyword of keywords) {
			const value = keyword.value as string

			if (keyword.name in header) continue
			if (value === '' || value === undefined || value === null) continue
			else if (value === 'T') header[keyword.name] = true
			else if (value === 'F') header[keyword.name] = false
			else if (value.startsWith("'") && value.endsWith("'")) header[keyword.name] = value.substring(1, value.length - 1).trim()
			else header[keyword.name] = +value
		}
	}

	return header
}

function parseLocation(location: XisfParsedImage['location']): XisfLocation {
	const parts = location.split(':')
	return { offset: +parts[1], size: +parts[2] }
}

function parseGeometry(geometry: XisfParsedImage['geometry']): XisfGeometry {
	const parts = geometry.split(':')
	return { width: +parts[0], height: +parts[1], channels: +parts[2] }
}

function parseCompression(compression: XisfParsedImage['compression']): XisfCompression | undefined {
	if (!compression) return undefined
	const parts = compression.split(':')
	const shuffled = parts[0].endsWith('+sh')
	const format = (shuffled ? parts[0].substring(0, parts[0].length - 3) : parts[0]) as XisfCompressionFormat
	const uncompressedSize = +parts[1]
	const itemSize = shuffled ? +parts[2] : 0
	return { format, shuffled, uncompressedSize, itemSize }
}

export function bitpixFromSampleFormat(sampleFormat: XisfSampleFormat): Bitpix {
	return sampleFormat === 'UInt8' ? 8 : sampleFormat === 'UInt16' ? 16 : sampleFormat === 'UInt32' ? 32 : sampleFormat === 'UInt64' ? 64 : sampleFormat === 'Float32' ? -32 : -64
}

export class XisfImageReader {
	private readonly buffer: Buffer
	private readonly data: NumberArray

	constructor(
		private readonly image: Pick<XisfImage, 'bitpix' | 'location' | 'compression' | 'byteOrder' | 'pixelStorage' | 'geometry'>,
		buffer?: Buffer,
	) {
		const { bitpix, location, compression } = image
		const size = compression?.uncompressedSize ?? location.size
		this.buffer = buffer?.subarray(0, size) ?? Buffer.allocUnsafe(size)
		this.data = bitpix === 8 ? new Uint8Array(this.buffer.buffer) : bitpix === 16 ? new Uint16Array(this.buffer.buffer) : bitpix === 32 ? new Uint32Array(this.buffer.buffer) : bitpix === -32 ? new Float32Array(this.buffer.buffer) : new Float64Array(this.buffer.buffer)
	}

	// Reads XISF-format image from source into RGB-interleaved array
	async read(source: Source & Seekable, output: ImageRawType) {
		source.seek(this.image.location.offset)

		if ((await readUntil(source, this.buffer, this.image.location.size, 0)) !== this.image.location.size) return false

		const pixelInBytes = bitpixInBytes(this.image.bitpix)

		if (pixelInBytes > 1 && this.image.byteOrder === 'big') {
			if (pixelInBytes === 2) this.buffer.swap16()
			else if (pixelInBytes === 4) this.buffer.swap32()
			else if (pixelInBytes === 8) this.buffer.swap64()
		}

		const data = this.data
		const { bitpix, pixelStorage, geometry } = this.image
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
	private readonly buffer: Buffer
	private readonly data: NumberArray

	constructor(
		private readonly xisf: Pick<XisfImage, 'byteOrder' | 'bitpix' | 'geometry' | 'pixelStorage'>,
		buffer?: Buffer,
	) {
		const { bitpix, geometry } = xisf
		const { width, height, channels } = geometry
		this.buffer = buffer ?? Buffer.allocUnsafe(width * height * channels * bitpixInBytes(bitpix))
		this.data = bitpix === 8 ? new Uint8Array(this.buffer.buffer) : bitpix === 16 ? new Int16Array(this.buffer.buffer) : bitpix === 32 ? new Int32Array(this.buffer.buffer) : bitpix === -32 ? new Float32Array(this.buffer.buffer) : new Float64Array(this.buffer.buffer)
	}

	// Writes FITS-format image from RGB-interleaved array into sink
	async write(input: ImageRawType, sink: Sink) {
		const { bitpix, geometry, byteOrder, pixelStorage } = this.xisf
		const { width, height, channels } = geometry
		const pixelInBytes = bitpixInBytes(bitpix)
		const numberOfPixels = width * height
		const factor = bitpix > 0 ? 2 ** bitpix - 1 : 1 // Transform float [0..1] to n-bit integer
		const data = this.data

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
			if (pixelInBytes === 2) this.buffer.swap16()
			else if (pixelInBytes === 4) this.buffer.swap32()
			else if (pixelInBytes === 8) this.buffer.swap64()
		}

		return await sink.write(this.buffer)
	}
}

// For data blocks structured as contiguous sequences of 16-bit or larger integer
// or floating point numbers, a reversible byte shuffling routine can greatly improve
// compression ratios by increasing data locality, i.e. by redistributing the
// sequence such that similar byte values tend to be placed close together.

export function byteShuffle(input: Int8Array | Uint8Array, output: Int8Array | Uint8Array, itemSize: number) {
	const inputSize = input.byteLength
	const numberOfItems = Math.trunc(inputSize / itemSize)
	const copyLength = inputSize % itemSize

	let s = 0

	for (let j = 0; j < itemSize; j++) {
		let u = j

		for (let k = 0; k < numberOfItems; k++) {
			output[s++] = input[u]
			u += itemSize
		}

		if (copyLength > 0) {
			const begin = numberOfItems * itemSize
			output.set(input.subarray(begin, begin + copyLength), s)
		}
	}
}

export function byteUnshuffle(input: Int8Array | Uint8Array, output: Int8Array | Uint8Array, itemSize: number) {
	const inputSize = input.byteLength
	const numberOfItems = Math.trunc(inputSize / itemSize)
	const copyLength = inputSize % itemSize

	let s = 0

	for (let j = 0; j < itemSize; j++) {
		let u = j

		for (let k = 0; k < numberOfItems; k++) {
			output[u] = input[s++]
			u += itemSize
		}

		if (copyLength > 0) {
			const offset = numberOfItems * itemSize
			output.set(input.subarray(s, s + copyLength), offset)
		}
	}
}
