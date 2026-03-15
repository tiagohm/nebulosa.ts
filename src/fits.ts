import { type Angle, deg, parseAngle } from './angle'
import { compressRice, decompressRice } from './compression'
import { type FitsKeyword, KEYWORDS } from './fits.headers'
import type { CfaPattern, Image, ImageRawType } from './image.types'
import { readUntil, type Seekable, type Sink, type Source } from './io'
import type { NumberArray } from './math'
import { parseTemporal } from './temporal'

export type FitsHeaderKey = string
export type FitsHeaderValue = string | number | boolean | undefined
export type FitsHeaderComment = string | undefined
export type FitsHeaderCard = [FitsHeaderKey, FitsHeaderValue?, FitsHeaderComment?]
export type FitsHeader = Record<FitsHeaderKey, FitsHeaderValue>

export interface FitsData {
	readonly size: number
	readonly offset: number
}

export interface FitsHdu {
	readonly offset?: number
	readonly header: FitsHeader
	readonly data: FitsData
}

export interface Fits {
	readonly hdus: readonly FitsHdu[]
}

export enum Bitpix {
	BYTE = 8, // unsigned 8-bit integer
	SHORT = 16, // signed 16-bit integer
	INTEGER = 32, // signed 32-bit integer
	LONG = 64, // signed 64-bit integer
	FLOAT = -32, // IEEE 32-bit floating point
	DOUBLE = -64, // IEEE 64-bit floating point
}

export type BitpixOrZero = Bitpix | 0

export const FITS_BLOCK_SIZE = 2880
export const FITS_HEADER_CARD_SIZE = 80
export const FITS_MAX_KEYWORD_LENGTH = 8
export const FITS_MAX_VALUE_LENGTH = 70
export const FITS_MIN_STRING_END = 19

export const FITS_IMAGE_MIME_TYPE = 'image/fits'
export const FITS_APPLICATION_MIME_TYPE = 'application/fits'

export const MAGIC_BYTES = 'SIMPLE'

const RICE_1_COMPRESSION_TYPE = 'RICE_1'

export function isFits(input: ArrayBufferLike | Buffer) {
	if (input.byteLength < 6) return false

	if (Buffer.isBuffer(input)) {
		return input.toString('ascii', 0, 6) === MAGIC_BYTES
	} else {
		return isFits(Buffer.from(input, 0, 6))
	}
}

export function hasKeyword(header: FitsHeader, key: FitsHeaderKey) {
	return key in header && header[key] !== undefined
}

export function numericKeyword<T extends number | undefined = number>(header: FitsHeader, key: FitsHeaderKey, defaultValue: NoInfer<T>) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value
	else if (typeof value === 'boolean') return value ? 1 : 0
	else return parseFloat(value)
}

export function booleanKeyword(header: FitsHeader, key: FitsHeaderKey, defaultValue: boolean = false) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value !== 0
	else if (typeof value === 'string') return value === 'T' || value.toLowerCase() === 'true'
	else return value
}

export function textKeyword(header: FitsHeader, key: FitsHeaderKey, defaultValue: string = '') {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'string') return value
	else return `${value}`
}

export function numberOfAxesKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T>(header, 'NAXIS', defaultValue)
}

export function widthKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'NAXIS1', undefined) ?? numericKeyword<T>(header, 'IMAGEW', defaultValue)
}

export function heightKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'NAXIS2', undefined) ?? numericKeyword<T>(header, 'IMAGEH', defaultValue)
}

export function numberOfChannelsKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T>(header, 'NAXIS3', defaultValue)
}

export function bitpixKeyword<T extends BitpixOrZero | undefined = BitpixOrZero>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T>(header, 'BITPIX', defaultValue) as T
}

export function exposureTimeKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'EXPTIME', undefined) ?? numericKeyword<T>(header, 'EXPOSURE', defaultValue)
}

export function cfaPatternKeyword(header: FitsHeader) {
	return textKeyword(header, 'BAYERPAT') as CfaPattern | undefined
}

export function rightAscensionKeyword<T extends Angle | undefined = Angle>(header: FitsHeader, defaultValue: NoInfer<T>) {
	if (hasKeyword(header, 'RA')) {
		const value = deg(numericKeyword(header, 'RA', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'OBJCTRA')) {
		const value = parseAngle(textKeyword(header, 'OBJCTRA', ''), true)
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'RA_OBJ')) {
		const value = deg(numericKeyword(header, 'RA_OBJ', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'CRVAL1')) {
		const value = deg(numericKeyword(header, 'CRVAL1', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	return defaultValue
}

export function declinationKeyword<T extends Angle | undefined = Angle>(header: FitsHeader, defaultValue: NoInfer<T>) {
	if (hasKeyword(header, 'DEC')) {
		const value = deg(numericKeyword(header, 'DEC', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'OBJCTDEC')) {
		const value = parseAngle(textKeyword(header, 'OBJCTDEC', ''))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'DEC_OBJ')) {
		const value = deg(numericKeyword(header, 'DEC_OBJ', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'CRVAL2')) {
		const value = deg(numericKeyword(header, 'CRVAL2', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	return defaultValue
}

export function observationDateKeyword(header: FitsHeader) {
	const date = textKeyword(header, 'DATE-OBS') || textKeyword(header, 'DATE-END') || textKeyword(header, 'DATE')
	if (!date) return undefined
	return parseTemporal(date, 'YYYY-MM-DDTHH:mm:ss.SSS')
}

export function bitpixInBytes(bitpix: BitpixOrZero) {
	return Math.abs(bitpix) >>> 3
}

// https://fits.gsfc.nasa.gov/registry/tilecompression/tilecompression2.2.pdf

export type FitsCompressionType = 'GZIP_1' | 'RICE_1' | 'PLIO_1' | 'HCOMPRESS_1'

export function compressionTypeKeyword(header: FitsHeader): FitsCompressionType | undefined {
	return (textKeyword(header, 'ZCMPTYPE', '').trim().toUpperCase() as FitsCompressionType) || undefined
}

// The value of the NAXIS1 keywords in the uncompressed FITS image
export function uncompressedWidthKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'ZNAXIS1', undefined) ?? widthKeyword<T>(header, defaultValue)
}

// The value of the NAXIS2 keywords in the uncompressed FITS image
export function uncompressedHeightKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'ZNAXIS2', undefined) ?? heightKeyword<T>(header, defaultValue)
}

// The value of the NAXIS3 keywords in the uncompressed FITS image
export function uncompressedNumberOfChannelsKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'ZNAXIS3', undefined) ?? numberOfChannelsKeyword<T>(header, defaultValue)
}

// The value of the BITPIX keyword in the uncompressed FITS image
export function uncompressedBitpixKeyword<T extends BitpixOrZero | undefined = BitpixOrZero>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return (numericKeyword<T | undefined>(header, 'ZBITPIX', undefined) ?? bitpixKeyword(header, defaultValue)) as T
}

export function isCompressedImageHeader(header: FitsHeader) {
	return booleanKeyword(header, 'ZIMAGE', false)
}

export function isRiceCompressedImageHeader(header: FitsHeader) {
	return isCompressedImageHeader(header) && compressionTypeKeyword(header) === RICE_1_COMPRESSION_TYPE
}

export interface FitsCompressionOptions {
	readonly type?: FitsCompressionType | false
	readonly tileHeight?: number
	readonly blockSize?: number
}

const NO_VALUE_KEYWORDS = ['COMMENT', 'HISTORY', 'END']

function computeHduDataSize(header: FitsHeader) {
	const extension = textKeyword(header, 'XTENSION', '').trim().toUpperCase()

	if (extension === 'BINTABLE' || extension === 'TABLE') {
		const rowSize = widthKeyword(header, 0)
		const rows = heightKeyword(header, 0)
		const pcount = numericKeyword(header, 'PCOUNT', 0)
		return rowSize * rows + pcount
	}

	return widthKeyword(header, 0) * heightKeyword(header, 0) * numberOfChannelsKeyword(header, 1) * bitpixInBytes(bitpixKeyword(header, 0))
}

export async function readFits(source: Source & Seekable): Promise<Fits | undefined> {
	const buffer = Buffer.allocUnsafe(FITS_HEADER_CARD_SIZE)
	const reader = new FitsKeywordReader()

	if ((await readUntil(source, buffer)) !== FITS_HEADER_CARD_SIZE) return undefined
	if (!isFits(buffer)) return undefined

	const hdus: FitsHdu[] = []
	let prev: FitsHeaderCard | undefined

	function parseCard() {
		const card = reader.read(buffer)
		const [key, value, comment] = card

		if (key) {
			if (key === 'SIMPLE' || key === 'XTENSION') {
				const offset = source.position - FITS_HEADER_CARD_SIZE
				hdus.push({ header: { [key]: value }, offset, data: { offset: 0, size: 0 } })
			} else if (key !== 'END') {
				const { header } = hdus[hdus.length - 1]

				if (prev && key === 'CONTINUE' && typeof value === 'string' && typeof prev[1] === 'string' && prev[1].endsWith('&')) {
					prev[1] = prev[1].substring(0, prev[1].length - 1) + value
					header[prev[0]] = prev[1]
				} else if (NO_VALUE_KEYWORDS.includes(key)) {
					if (header[key] === undefined) header[key] = comment
					else header[key] += `\n${comment}`
					prev = undefined
				} else {
					header[key] = value
					prev = card
				}
			} else {
				const hdu = hdus[hdus.length - 1]
				const { header, data } = hdu

				const offset = source.position + computeRemainingBytes(source.position)
				const size = computeHduDataSize(header)
				source.seek(offset + size + computeRemainingBytes(size))
				Object.assign(data, { size, offset })
			}
		}

		return key
	}

	parseCard()

	while (true) {
		const size = await readUntil(source, buffer)
		if (size !== FITS_HEADER_CARD_SIZE) break
		parseCard()
	}

	return { hdus }
}

const RICE_DEFAULT_BLOCK_SIZE = 32

const COMPRESSION_PRIMARY_HEADER: readonly FitsHeaderCard[] = [
	['SIMPLE', true],
	['BITPIX', 8],
	['NAXIS', 0],
	['EXTEND', true],
]

const COMPRESSION_EXTENSION_EXCLUDED_KEYS = new Set([
	'SIMPLE',
	'XTENSION',
	'BITPIX',
	'NAXIS',
	'NAXIS1',
	'NAXIS2',
	'NAXIS3',
	'PCOUNT',
	'GCOUNT',
	'TFIELDS',
	'TTYPE1',
	'TFORM1',
	'THEAP',
	'ZIMAGE',
	'ZCMPTYPE',
	'ZBITPIX',
	'ZNAXIS',
	'ZNAXIS1',
	'ZNAXIS2',
	'ZNAXIS3',
	'ZTILE1',
	'ZTILE2',
	'ZTILE3',
	'ZNAME1',
	'ZNAME2',
	'ZVAL1',
	'ZVAL2',
	'END',
])

function shouldUseRiceCompression(header: FitsHeader, compression: FitsCompressionOptions['type']) {
	if (compression === false) return false
	if (compression === RICE_1_COMPRESSION_TYPE) return true
	return isRiceCompressedImageHeader(header) || compressionTypeKeyword(header) === RICE_1_COMPRESSION_TYPE
}

function writeInterleavedToPlanar(input: ImageRawType, output: NumberArray, bitpix: BitpixOrZero, width: number, height: number, channels: number) {
	const numberOfPixels = width * height
	const zero = bitpix === 16 ? 32768 : bitpix === 32 ? 2147483648 : 0
	const factor = bitpix > 0 ? 2 ** bitpix - 1 : 1 // Transform float [0..1] to n-bit integer

	for (let c = 0, p = 0; c < channels; c++) {
		for (let i = 0, m = c; i < numberOfPixels; i++, m += channels) {
			output[p++] = input[m] * factor - zero
		}
	}
}

function buildRiceCompressedImage(header: FitsHeader, raw: ImageRawType, options: FitsCompressionOptions) {
	const bitpix = bitpixKeyword(header, 0)
	const width = widthKeyword(header, 0)
	const height = heightKeyword(header, 0)
	const channels = numberOfChannelsKeyword(header, 1)
	const numberOfPixels = width * height

	if (width < 1 || height < 1 || channels < 1) throw new Error('invalid image dimensions')

	const tileHeight = Math.min(height, options.tileHeight || 1)
	const blockSize = options.blockSize || RICE_DEFAULT_BLOCK_SIZE

	const ImageTypedArray = bitpix === 8 ? Uint8Array : bitpix === 16 ? Int16Array : Int32Array
	const imageData = new ImageTypedArray(numberOfPixels * channels)
	writeInterleavedToPlanar(raw, imageData, bitpix, width, height, channels)

	const rowSize = 8
	const tilesPerChannel = Math.ceil(height / tileHeight)
	const rowCount = tilesPerChannel * channels
	const rows = Buffer.allocUnsafe(rowCount * rowSize)
	const chunks: Uint8Array[] = []
	let heapSize = 0
	let row = 0

	for (let c = 0; c < channels; c++) {
		const channelOffset = c * numberOfPixels

		for (let y = 0; y < height; y += tileHeight) {
			const thisTileHeight = Math.min(tileHeight, height - y)
			const start = channelOffset + y * width
			const tilePixels = thisTileHeight * width
			const tile = imageData.subarray(start, start + tilePixels)
			const compressed = compressRice(tile, blockSize)

			rows.writeUInt32BE(compressed.length, row * rowSize)
			rows.writeUInt32BE(heapSize, row * rowSize + 4)

			chunks.push(compressed)
			heapSize += compressed.length
			row++
		}
	}

	const payload = Buffer.allocUnsafe(rows.length + heapSize)
	rows.copy(payload, 0)

	let offset = rows.length

	for (const chunk of chunks) {
		payload.set(chunk, offset)
		offset += chunk.length
	}

	const cards: FitsHeaderCard[] = [
		['XTENSION', 'BINTABLE'],
		['BITPIX', 8],
		['NAXIS', 2],
		['NAXIS1', rowSize],
		['NAXIS2', rowCount],
		['PCOUNT', heapSize],
		['GCOUNT', 1],
		['TFIELDS', 1],
		['TTYPE1', 'COMPRESSED_DATA'],
		['TFORM1', '1PB'],
		['THEAP', rows.length],
		['ZIMAGE', true],
		['ZCMPTYPE', RICE_1_COMPRESSION_TYPE],
		['ZBITPIX', bitpix],
		['ZNAXIS', channels > 1 ? 3 : 2],
		['ZNAXIS1', width],
		['ZNAXIS2', height],
		['ZTILE1', width],
		['ZTILE2', tileHeight],
		['ZNAME1', 'BLOCKSIZE'],
		['ZVAL1', blockSize],
		['ZNAME2', 'BYTEPIX'],
		['ZVAL2', bitpixInBytes(bitpix)],
	]

	if (channels > 1) {
		cards.push(['ZNAXIS3', channels], ['ZTILE3', 1])
	}

	for (const key in header) {
		if (COMPRESSION_EXTENSION_EXCLUDED_KEYS.has(key)) continue
		const value = header[key]
		if (value !== undefined) cards.push([key, value])
	}

	return { cards, payload }
}

export async function writeFits(sink: Sink & Partial<Seekable>, hdus: readonly Readonly<Pick<Image, 'header' | 'raw'>>[], options: FitsCompressionOptions = {}) {
	const buffer = Buffer.allocUnsafe(FITS_BLOCK_SIZE * 4)
	const headerWriter = new FitsKeywordWriter()

	function fillWithRemainingBytes(size: number, offset: number) {
		const remaining = computeRemainingBytes(size)
		remaining > 0 && buffer.fill(20, offset, offset + remaining)
		return remaining
	}

	async function writeHeader(header: Readonly<FitsHeader> | readonly Readonly<FitsHeaderCard>[]) {
		let offset = headerWriter.writeAll(header, buffer)
		offset += headerWriter.writeEnd(buffer, offset)
		offset += fillWithRemainingBytes(offset, offset)
		await sink.write(buffer, 0, offset)
	}

	let hasPrimaryHdu = false

	for (const hdu of hdus) {
		const { header, raw } = hdu

		if (shouldUseRiceCompression(header, options.type)) {
			if (!hasPrimaryHdu) {
				await writeHeader(COMPRESSION_PRIMARY_HEADER)
				hasPrimaryHdu = true
			}

			const { cards, payload } = buildRiceCompressedImage(header, raw, options)
			await writeHeader(cards)
			await sink.write(payload)

			const pad = fillWithRemainingBytes(payload.length, 0)
			if (pad > 0) await sink.write(buffer, 0, pad)
			continue
		}

		await writeHeader(header)
		const imageWriter = new FitsImageWriter(header)
		const offset = fillWithRemainingBytes(await imageWriter.write(raw, sink), 0)
		if (offset > 0) await sink.write(buffer, 0, offset)
		hasPrimaryHdu = true
	}
}

export function computeRemainingBytes(size: number) {
	const remaining = size % FITS_BLOCK_SIZE
	return remaining === 0 ? 0 : FITS_BLOCK_SIZE - remaining
}

export function escapeQuotedText(text: string) {
	return text.replaceAll("'", "''")
}

export function unescapeQuotedText(text: string) {
	return text.replaceAll("''", "'")
}

export function isCommentStyleCard(card: Readonly<FitsHeaderCard>) {
	return NO_VALUE_KEYWORDS.includes(card[0])
}

const WHITESPACE = 32
const SINGLE_QUOTE = 39
const SLASH = 47
const EQUAL = 61

const DECIMAL_REGEX = /^[+-]?\d+(\.\d*)?([dDeE][+-]?\d+)?$/
const INT_REGEX = /^[+-]?\d+$/

// https://fits.gsfc.nasa.gov/fits_dictionary.html
// Registered Conventions: https://fits.gsfc.nasa.gov/registry/ https://fits.gsfc.nasa.gov/fits_registry.html
// https://github.com/nom-tam-fits/nom-tam-fits/blob/master/src/main/java/nom/tam/fits/HeaderCardParser.java

export class FitsKeywordReader {
	read(line: Buffer, offset: number = 0): FitsHeaderCard {
		const position = new Position(offset)
		const key = this.parseKey(line, position)
		const [value, quoted] = this.parseValue(line, key, position)
		const comment = this.parseComment(line, position, value)
		return [key, this.parseValueType(value, quoted), comment?.trim()]
	}

	readAll(buffer: Buffer, offset: number = 0): FitsHeader {
		const header: FitsHeader = {}
		let prev: FitsHeaderCard | undefined

		while (offset < buffer.byteLength) {
			const card = this.read(buffer, offset)
			const [key, value, comment] = card

			if (key !== '' && key !== 'END') {
				if (prev && key === 'CONTINUE' && typeof value === 'string' && typeof prev[1] === 'string' && prev[1].endsWith('&')) {
					prev[1] = prev[1].substring(0, prev[1].length - 1) + value
					header[prev[0]] = prev[1]
				} else if (NO_VALUE_KEYWORDS.includes(key)) {
					if (header[key] === undefined) header[key] = comment
					else header[key] += `\n${comment}`
					prev = undefined
				} else {
					header[key] = value
					prev = card
				}
			} else {
				break
			}

			offset += FITS_HEADER_CARD_SIZE
		}

		return header
	}

	private parseKey(line: Buffer, position: Position) {
		// Find the '=' in the line, if any...
		const iEq = line.indexOf(EQUAL, position.offset) - position.offset

		// The stem is in the first 8 characters or what precedes an '=' character before that.
		const endStem = Math.min(iEq >= 0 && iEq <= FITS_MAX_KEYWORD_LENGTH ? iEq : FITS_MAX_KEYWORD_LENGTH, FITS_HEADER_CARD_SIZE)
		const stem = line.toString('ascii', position.offset, position.offset + endStem)

		// If not using HIERARCH, then be very resilient, and return whatever key the first 8 chars make...
		const key = stem.trim().toUpperCase()
		position.offset += stem.length
		return key
	}

	private parseValue(line: Buffer, key: string, position: Position): readonly [string | undefined, boolean] {
		if (!(key.length && this.skipSpaces(line, position))) {
			// nothing left to parse.
			return [undefined, false]
		}

		if (key === 'CONTINUE') {
			return this.parseValueBody(line, position)
		} else if (line.readInt8(position.offset) === EQUAL) {
			position.offset++
			return this.parseValueBody(line, position)
		} else {
			return [undefined, false]
		}
	}

	private parseValueBody(line: Buffer, position: Position): readonly [string | undefined, boolean] {
		if (!this.skipSpaces(line, position)) {
			// Nothing left to parse.
			return [undefined, false]
		}

		if (this.isNextQuote(line, position)) {
			// Parse as a string value.
			return [this.parseStringValue(line, position), true]
		} else {
			let end = line.indexOf(SLASH, position.offset)

			if (end < 0) end = position.start + FITS_HEADER_CARD_SIZE

			const value = line.toString('ascii', position.offset, end).trim()
			position.offset = end
			return [value, false]
		}
	}

	private parseStringValue(line: Buffer, position: Position) {
		let escaped = false

		const start = ++position.offset

		// Build the string value, up to the end quote and paying attention to double
		// quotes inside the string, which are translated to single quotes within
		// the string value itself.
		for (; position.offset < line.byteLength; position.offset++) {
			if (this.isNextQuote(line, position)) {
				position.offset++

				if (!this.isNextQuote(line, position)) {
					// Closing single quote
					return this.noTrailingSpaceString(line, start, position.offset - 1, escaped)
				} else {
					escaped = true
				}
			}
		}

		return this.noTrailingSpaceString(line, start, position.offset, escaped)
	}

	private noTrailingSpaceString(line: Buffer, start: number, end: number, escaped: boolean) {
		const text = line.toString('ascii', start, end).trimEnd()
		return escaped ? unescapeQuotedText(text) : text
	}

	private parseComment(line: Buffer, position: Position, value?: string) {
		if (!this.skipSpaces(line, position)) {
			// Nothing left to parse.
			return
		}

		// If no value, then everything is comment from here on...
		if (value) {
			if (line.readInt8(position.offset) === SLASH) {
				// Skip the '/' itself, the comment is whatever is after it.
				position.offset++
			}
		}

		return line.toString('ascii', position.offset)
	}

	private parseValueType(value: string | undefined, quoted: boolean) {
		if (quoted) return value
		else if (!value) return undefined
		else if (value === 'T') return true
		else if (value === 'F') return false
		// else if (value.startsWith("'") && value.endsWith("'")) return value.substring(1, value.length - 1).trim()
		else if (DECIMAL_REGEX.test(value)) return +value.toUpperCase().replace('D', 'E')
		else if (INT_REGEX.test(value)) return +value
		else return value
	}

	private skipSpaces(line: Buffer, position: Position) {
		for (; position.offset < line.byteLength; position.offset++) {
			if (line.readInt8(position.offset) !== WHITESPACE) {
				// Line has non-space characters left to parse...
				return true
			}
		}

		// Nothing left to parse.
		return false
	}

	private isNextQuote(line: Buffer, position: Position) {
		return position.offset < line.byteLength && line.readInt8(position.offset) === SINGLE_QUOTE
	}
}

const DEFAULT_COMMENT_ALIGN_POSITION = 30
const COMMENT_PREFIX = ' / '
const LONG_COMMENT_PREFIX = ' /'

// https://github.com/nom-tam-fits/nom-tam-fits/blob/master/src/main/java/nom/tam/fits/HeaderCardFormatter.java

class Position {
	constructor(
		public offset: number,
		public size: number = 0,
		public readonly start: number = offset,
	) {}

	increment(n: number = 1) {
		this.offset += n
		this.size += n
	}
}

const END_CARD: FitsHeaderCard = ['END']

export class FitsKeywordWriter {
	static keywords: Readonly<Record<string, FitsKeyword>> = KEYWORDS

	write(card: Readonly<FitsHeaderCard>, output: Buffer, offset: number = 0) {
		if (output.byteLength - offset < FITS_HEADER_CARD_SIZE) return 0

		const position = new Position(offset)

		if (card[0] === 'COMMENT' && card[1] !== undefined) {
			const values = card[1].toString().split('\n')
			const commentCard: FitsHeaderCard = [card[0], undefined, '']

			for (const value of values) {
				commentCard[2] = value
				this.appendKey(output, commentCard, position)
				this.appendComment(output, commentCard, position)
				this.pad(output, position)
			}
		} else {
			this.appendKey(output, card, position)
			const valueStart = this.appendValue(output, card, position)
			const valueEnd = position.size
			this.appendComment(output, card, position)

			if (!isCommentStyleCard(card)) {
				// Strings must be left aligned with opening quote in byte 11 (counted from 1)
				this.realign(output, typeof card[1] === 'string' ? valueEnd : valueStart, valueEnd, position)
			}

			this.pad(output, position)
		}

		return position.size
	}

	writeAll(header: Readonly<FitsHeader> | readonly Readonly<FitsHeaderCard>[], output: Buffer, offset: number = 0) {
		let size = 0

		if (header instanceof Array) {
			for (const card of header) {
				if (card !== undefined) {
					const n = this.write(card, output, offset)

					size += n
					offset += n
				}
			}
		} else {
			const card: FitsHeaderCard = ['', 0]

			for (const key in header) {
				if (key === 'END') break

				const value = header[key]

				if (value !== undefined) {
					card[0] = key
					card[1] = value

					const n = this.write(card, output, offset)

					size += n
					offset += n
				}
			}
		}

		return size
	}

	writeEnd(output: Buffer, offset: number = 0) {
		return this.write(END_CARD, output, offset)
	}

	private appendKey(output: Buffer, card: Readonly<FitsHeaderCard>, position: Position) {
		this.appendText(output, card[0], position)
		this.padTo(output, FITS_MAX_KEYWORD_LENGTH, position)
	}

	private appendValue(output: Buffer, card: Readonly<FitsHeaderCard>, position: Position) {
		const [, value, comment] = card

		if (isCommentStyleCard(card)) {
			// Comment-style card. Nothing to do here...
			return position.size
		}

		// Add assignment sequence "= "
		this.appendText(output, '= ', position)

		if (value === undefined) {
			// 'null' value, nothing more to append.
			return position.size
		}

		const start = position.size

		if (typeof value === 'string') {
			let from = this.appendQuotedValue(output, value, comment, 0, position)

			while (from < value.length) {
				this.pad(output, position)
				this.appendText(output, 'CONTINUE  ', position)
				from += this.appendQuotedValue(output, value, comment, from, position)
			}
		} else if (typeof value === 'boolean') {
			this.appendText(output, value ? 'T' : 'F', position)
		} else if (Number.isInteger(value)) {
			this.appendText(output, value.toFixed(0), position)
		} else {
			this.appendText(output, value.toExponential(20).toUpperCase(), position)
		}

		return start
	}

	private appendComment(output: Buffer, card: Readonly<FitsHeaderCard>, position: Position) {
		const commentStyleCard = isCommentStyleCard(card)
		const comment = commentStyleCard ? card[2] || (typeof card[1] === 'string' ? card[1] : undefined) : card[2] || FitsKeywordWriter.keywords[card[0]]?.comment

		if (!comment) return true

		const available = this.getAvailable(output, position) - (commentStyleCard ? 1 : COMMENT_PREFIX.length)

		this.appendText(output, commentStyleCard ? ' ' : COMMENT_PREFIX, position)

		if (available >= comment.length) {
			this.appendText(output, comment, position)
			return true
		}

		this.appendText(output, comment.substring(0, available), position)

		return false
	}

	private appendText(output: Buffer, text: string, position: Position) {
		const n = output.write(text, position.offset, 'ascii')
		position.increment(n)
	}

	private appendQuotedValue(output: Buffer, value: string, comment: FitsHeaderComment, from: number, position: Position) {
		// Always leave room for an extra & character at the end...
		let available = this.getAvailable(output, position) - 2

		// If long strings are enabled leave space for '&' at the end.
		if (comment?.length && this.isLongStringsEnabled(output, position)) available--

		// The the remaining part of the string fits in the space with the
		// quoted quotes, then it's easy...
		if (available >= value.length - from) {
			const escaped = escapeQuotedText(from === 0 ? value : value.substring(from))

			if (escaped.length <= available) {
				this.appendText(output, "'", position)
				this.appendText(output, escaped, position)

				// Earlier versions of the FITS standard required that the closing quote
				// does not come before byte 20. It's no longer required but older tools
				// may still expect it, so let's conform. This only affects single
				// record card, but not continued long strings...
				this.padTo(output, FITS_MIN_STRING_END, position)

				this.appendText(output, "'", position)

				return value.length - from
			}
		}

		if (!this.isLongStringsEnabled(output, position)) {
			return value.length - from
		}

		// Now, we definitely need space for '&' at the end...
		available = this.getAvailable(output, position) - 3

		// Opening quote
		this.appendText(output, "'", position)

		// For counting the characters consumed from the input
		let consumed = 0

		for (let i = 0; i < available; i++, consumed++) {
			const c = value[from + consumed]

			if (c === "'") {
				// Quoted quotes take up 2 spaces...
				i++

				if (i + 1 >= available) {
					// Otherwise leave the value quote unconsumed.
					break
				}

				// Only append the quoted quote if there is room for both.
				this.appendText(output, "''", position)
			} else {
				// Append a non-quote character.
				this.appendText(output, c, position)
			}
		}

		// & and closing quote.
		this.appendText(output, "&'", position)

		return consumed
	}

	private getAvailable(output: Buffer, position: Position) {
		const remaining = (FITS_HEADER_CARD_SIZE - (position.size % FITS_HEADER_CARD_SIZE)) % FITS_HEADER_CARD_SIZE
		if (remaining > 0 && position.offset !== position.size && position.offset + remaining > output.byteLength) return output.byteLength - position.offset
		return remaining
	}

	private realign(output: Buffer, at: number, from: number, position: Position) {
		if (position.size >= FITS_HEADER_CARD_SIZE || from >= DEFAULT_COMMENT_ALIGN_POSITION) {
			// We are beyond the alignment point already...
			return false
		}

		const spaces = DEFAULT_COMMENT_ALIGN_POSITION - from

		if (spaces > this.getAvailable(output, position)) {
			// No space left in card to align the the specified position.
			return false
		}

		const { start, offset } = position

		// Shift value + comment
		for (let i = offset - 1, k = offset + spaces - 1, end = start + at; i >= end; i--, k--) {
			output.writeInt8(output.readInt8(i), k)
		}

		position.increment(spaces)

		// Fill
		output.fill(WHITESPACE, start + at, start + at + spaces)

		return true
	}

	private padTo(output: Buffer, to: number, position: Position) {
		for (let pos = position.size % FITS_HEADER_CARD_SIZE; pos < to; pos++) {
			output.writeInt8(WHITESPACE, position.offset)
			position.increment()
		}
	}

	private pad(output: Buffer, position: Position, n: number = this.getAvailable(output, position)) {
		if (n > 0) {
			output.fill(WHITESPACE, position.offset, position.offset + n)
			position.increment(n)
		}
	}

	private isLongStringsEnabled(output: Buffer, position: Position) {
		// return Math.floor((output.byteLength) / FITS_HEADER_CARD_SIZE) > 1
		const start = position.offset - position.size
		return Math.floor((output.byteLength - start) / FITS_HEADER_CARD_SIZE) > 1
	}
}

export function formatFitsHeaderValue(value: FitsHeaderValue) {
	if (typeof value === 'boolean') return value ? 'T' : 'F'
	if (typeof value === 'number') return `${value}`
	return `'${escapeQuotedText(value ?? '')}'`
}

function riceBlockSizeFromHeader(header: FitsHeader) {
	for (let i = 1; i <= 16; i++) {
		const name = textKeyword(header, `ZNAME${i}`, '').trim().toUpperCase()

		if (name === 'BLOCKSIZE') {
			const value = numericKeyword(header, `ZVAL${i}`, RICE_DEFAULT_BLOCK_SIZE)
			if (Number.isFinite(value) && value > 0) return Math.trunc(value)
		}
	}

	const fallback = numericKeyword(header, 'BLOCKSIZE', RICE_DEFAULT_BLOCK_SIZE)
	return Number.isFinite(fallback) && fallback > 0 ? Math.trunc(fallback) : RICE_DEFAULT_BLOCK_SIZE
}

function writePlanarToInterleaved(data: NumberArray, output: ImageRawType, header: FitsHeader, bitpix: BitpixOrZero, width: number, height: number, channels: number) {
	const numberOfPixels = width * height
	const scale = (header.BSCALE as number) || 1
	const zero = (header.BZERO as number) || 0
	const factor = bitpix > 0 ? scale / (2 ** bitpix - 1) : 1 // Transform n-bit integer to float [0..1]

	for (let i = 0, p = 0; i < numberOfPixels; i++) {
		for (let c = 0, m = i; c < channels; c++, m += numberOfPixels) {
			output[p++] = (data[m] + zero) * factor
		}
	}
}

export class FitsImageReader {
	private readonly compressed: boolean
	private readonly buffer: Buffer
	private readonly data: NumberArray

	constructor(
		private readonly hdu: FitsHdu,
		buffer?: Buffer,
	) {
		this.compressed = isRiceCompressedImageHeader(hdu.header)

		if (this.compressed) {
			this.buffer = Buffer.alloc(0)
			this.data = new Uint8Array(0)
		} else {
			const bitpix = bitpixKeyword(hdu.header, 0)
			this.buffer = buffer?.subarray(0, hdu.data.size) ?? Buffer.allocUnsafe(hdu.data.size)
			this.data = bitpix === 8 ? new Uint8Array(this.buffer.buffer) : bitpix === 16 ? new Int16Array(this.buffer.buffer) : bitpix === 32 ? new Int32Array(this.buffer.buffer) : bitpix === -32 ? new Float32Array(this.buffer.buffer) : new Float64Array(this.buffer.buffer)
		}
	}

	// Reads FITS-format image from source into RGB-interleaved array
	async read(source: Source & Seekable, output: ImageRawType) {
		if (this.compressed) return await this.readRiceCompressed(source, output)

		source.seek(this.hdu.data.offset)

		if ((await readUntil(source, this.buffer, this.hdu.data.size, 0)) !== this.hdu.data.size) return false

		const { header } = this.hdu
		const bitpix = bitpixKeyword(header, 0)
		const pixelInBytes = bitpixInBytes(bitpix)

		// big-endian to little-endian
		if (pixelInBytes === 2) this.buffer.swap16()
		else if (pixelInBytes === 4) this.buffer.swap32()
		else if (pixelInBytes === 8) this.buffer.swap64()

		const width = widthKeyword(header, 0)
		const height = heightKeyword(header, 0)
		const channels = numberOfChannelsKeyword(header, 1)
		writePlanarToInterleaved(this.data, output, header, bitpix, width, height, channels)

		return true
	}

	private async readRiceCompressed(source: Source & Seekable, output: ImageRawType) {
		const { header } = this.hdu
		const bitpix = uncompressedBitpixKeyword(header, 0)
		const width = uncompressedWidthKeyword(header, 0)
		const height = uncompressedHeightKeyword(header, 0)
		const channels = uncompressedNumberOfChannelsKeyword(header, 1)

		if (bitpix !== 8 && bitpix !== 16 && bitpix !== 32) {
			throw new Error('RICE 1 supports only BITPIX = 8, 16 or 32')
		}

		const compressed = Buffer.allocUnsafe(this.hdu.data.size)
		source.seek(this.hdu.data.offset)

		if ((await readUntil(source, compressed, compressed.length, 0)) !== compressed.length) return false

		const rowSize = widthKeyword(header, 0)
		const rowCount = heightKeyword(header, 0)
		const heapOffset = numericKeyword(header, 'THEAP', rowSize * rowCount)
		const tileWidth = numericKeyword(header, 'ZTILE1', width)
		const tileHeight = numericKeyword(header, 'ZTILE2', height)
		const tileDepth = numericKeyword(header, 'ZTILE3', 1)
		const blockSize = riceBlockSizeFromHeader(header)

		const tilesX = Math.ceil(width / tileWidth)
		const tilesY = Math.ceil(height / tileHeight)
		const tilesZ = Math.ceil(channels / tileDepth)
		const totalTiles = tilesX * tilesY * tilesZ

		if (rowCount < totalTiles) throw new Error('compressed FITS image has incomplete tile table')

		const numberOfPixels = width * height
		const ImageTypedArray = bitpix === 8 ? Uint8Array : bitpix === 16 ? Int16Array : Int32Array
		const data = new ImageTypedArray(numberOfPixels * channels)
		const tileBuffer = new ImageTypedArray(tileWidth * tileHeight * tileDepth)

		for (let tileIndex = 0; tileIndex < totalTiles; tileIndex++) {
			const descriptorOffset = tileIndex * rowSize
			if (descriptorOffset + 8 > compressed.length) throw new Error('compressed FITS image has truncated tile descriptors')

			const byteCount = compressed.readUInt32BE(descriptorOffset)
			const heapRelativeOffset = compressed.readUInt32BE(descriptorOffset + 4)
			const start = heapOffset + heapRelativeOffset
			const end = start + byteCount

			if (start < 0 || end > compressed.length) throw new Error('compressed FITS image has invalid heap offsets')

			const tilePlaneIndex = tilesX * tilesY
			const tz = Math.trunc(tileIndex / tilePlaneIndex)
			const rem = tileIndex - tz * tilePlaneIndex
			const ty = Math.trunc(rem / tilesX)
			const tx = rem - ty * tilesX

			const x0 = tx * tileWidth
			const y0 = ty * tileHeight
			const z0 = tz * tileDepth
			const thisTileWidth = Math.min(tileWidth, width - x0)
			const thisTileHeight = Math.min(tileHeight, height - y0)
			const thisTileDepth = Math.min(tileDepth, channels - z0)
			const thisTilePixels = thisTileWidth * thisTileHeight * thisTileDepth
			const tile = tileBuffer.subarray(0, thisTilePixels)

			decompressRice(compressed.subarray(start, end), tile, blockSize)

			for (let z = 0; z < thisTileDepth; z++) {
				const channel = z0 + z
				const channelOffset = channel * numberOfPixels
				const tileOffset = z * thisTileWidth * thisTileHeight

				for (let y = 0; y < thisTileHeight; y++) {
					const sourceOffset = tileOffset + y * thisTileWidth
					const targetOffset = channelOffset + (y0 + y) * width + x0
					data.set(tile.subarray(sourceOffset, sourceOffset + thisTileWidth), targetOffset)
				}
			}
		}

		writePlanarToInterleaved(data, output, header, bitpix, width, height, channels)

		return true
	}
}

export class FitsImageWriter {
	private readonly buffer: Buffer
	private readonly data: NumberArray

	constructor(
		private readonly header: FitsHeader,
		buffer?: Buffer,
	) {
		const bitpix = bitpixKeyword(header, 0)
		const width = widthKeyword(header, 0)
		const height = heightKeyword(header, 0)
		const channels = numberOfChannelsKeyword(header, 1)
		this.buffer = buffer ?? Buffer.allocUnsafe(width * height * channels * bitpixInBytes(bitpix))
		this.data = bitpix === 8 ? new Uint8Array(this.buffer.buffer) : bitpix === 16 ? new Int16Array(this.buffer.buffer) : bitpix === 32 ? new Int32Array(this.buffer.buffer) : bitpix === -32 ? new Float32Array(this.buffer.buffer) : new Float64Array(this.buffer.buffer)
	}

	// Writes FITS-format image from RGB-interleaved array into sink
	async write(input: ImageRawType, sink: Sink) {
		const bitpix = bitpixKeyword(this.header, 0)
		const pixelInBytes = bitpixInBytes(bitpix)
		const width = widthKeyword(this.header, 0)
		const height = heightKeyword(this.header, 0)
		const channels = numberOfChannelsKeyword(this.header, 1)

		writeInterleavedToPlanar(input, this.data, bitpix, width, height, channels)

		// little-endian to big-endian
		if (pixelInBytes === 2) this.buffer.swap16()
		else if (pixelInBytes === 4) this.buffer.swap32()
		else if (pixelInBytes === 8) this.buffer.swap64()

		return await sink.write(this.buffer)
	}
}
