import { type X2jOptions, XMLParser } from 'fast-xml-parser'
import { type Bitpix, bitpixInBytes, type FitsHeader, type FitsHeaderValue } from './fits'
import type { Size } from './geometry'
import type { ImageRawType } from './image.types'
import { readUntil, type Seekable, type Source } from './io'
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
	private readonly planar: boolean
	private readonly buffer: Buffer
	private readonly data: NumberArray

	constructor(
		private readonly image: XisfImage,
		buffer?: Buffer,
	) {
		const { bitpix, pixelStorage, location, compression } = image
		this.planar = pixelStorage === 'Planar'
		const size = compression?.uncompressedSize ?? location.size
		this.buffer = buffer?.subarray(0, size) ?? Buffer.allocUnsafe(size)
		this.data = bitpix === 8 ? new Uint8Array(this.buffer.buffer) : bitpix === 16 ? new Uint16Array(this.buffer.buffer) : bitpix === 32 ? new Uint32Array(this.buffer.buffer) : bitpix === -32 ? new Float32Array(this.buffer.buffer) : new Float64Array(this.buffer.buffer)
	}

	// Read XISF Image bytes from source into RGB-interleaved array
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
		const { width, height, channels } = this.image.geometry
		const numberOfPixels = width * height
		const invDiv = this.image.bitpix > 0 ? 1 / (2 ** (8 * pixelInBytes) - 1) : 1

		let p = 0

		if (this.planar) {
			for (let i = 0; i < numberOfPixels; i++) {
				for (let c = 0, m = i; c < channels; c++, m += numberOfPixels) {
					output[p++] = data[m] * invDiv
				}
			}
		} else {
			const total = numberOfPixels * channels

			for (let i = 0; i < total; i++) {
				output[i] = data[i] * invDiv
			}
		}

		return true
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
