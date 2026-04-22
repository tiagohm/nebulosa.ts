import { type FitsKeyword, KEYWORDS } from './fits.headers'
// oxfmt-ignore
import { bitpixInBytes, bitpixKeyword, computeHduDataSize, escapeQuotedText, heightKeyword, isCommentKeyword, isCommentStyleCard, isRiceCompressedImageHeader, numberOfChannelsKeyword, numericKeyword, RICE_1_COMPRESSION_TYPE, textKeyword, uncompressedBitpixKeyword, uncompressedHeightKeyword, uncompressedNumberOfChannelsKeyword, uncompressedWidthKeyword, unescapeQuotedText, widthKeyword } from './fits.util'
import type { Image, ImageRawType } from './image.types'
import { readUntil, type Seekable, type Sink, type Source } from './io'
import type { NumberArray } from './math'
import type { Writable } from './types'

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

const FITS_HEADER_PADDING = 32
const FITS_DATA_PADDING = 0
const FITS_HEADER_BUFFER_TOO_SMALL = 'FITS header buffer too small'

export function isFits(input: ArrayBufferLike | Buffer) {
	if (input.byteLength < 6) return false

	const bytes = Buffer.isBuffer(input) ? input : new Uint8Array(input, 0, MAGIC_BYTES.length)

	for (let i = 0; i < MAGIC_BYTES.length; i++) {
		if (bytes[i] !== MAGIC_BYTES.charCodeAt(i)) return false
	}

	return true
}

export function computeRemainingBytes(size: number) {
	const remaining = size % FITS_BLOCK_SIZE
	return remaining === 0 ? 0 : FITS_BLOCK_SIZE - remaining
}

export type FitsCompressionType = 'GZIP_1' | 'RICE_1' | 'PLIO_1' | 'HCOMPRESS_1'

export interface FitsCompressionOptions {
	readonly type?: FitsCompressionType | false
	readonly tileHeight?: number
	readonly blockSize?: number
}

export async function readFits(source: Source & Seekable): Promise<Fits | undefined> {
	const buffer = Buffer.allocUnsafe(FITS_HEADER_CARD_SIZE)
	const reader = new FitsKeywordReader()

	if ((await readUntil(source, buffer)) !== FITS_HEADER_CARD_SIZE) return undefined
	if (!isFits(buffer)) return undefined

	const hdus: FitsHdu[] = []
	let prev: FitsHeaderCard | undefined
	let inHeader = false

	// Parses one 80-byte card and stops once trailing bytes are no longer inside an HDU.
	function parseCard() {
		const card = reader.read(buffer)
		const [key, value, comment] = card

		if (!key) {
			prev = undefined
			return inHeader
		}

		if (key === 'SIMPLE' || key === 'XTENSION') {
			const offset = source.position - FITS_HEADER_CARD_SIZE
			hdus.push({ header: { [key]: value }, offset, data: { offset: 0, size: 0 } })
			prev = undefined
			inHeader = true
			return true
		}

		if (!inHeader || hdus.length === 0) {
			prev = undefined
			return false
		}

		const hdu = hdus.at(-1)!
		const { header } = hdu

		if (key === 'END') {
			const offset = source.position + computeRemainingBytes(source.position)
			const size = computeHduDataSize(header)
			const data = hdu.data as Writable<FitsData>
			source.seek(offset + size + computeRemainingBytes(size))
			data.size = size
			data.offset = offset
			prev = undefined
			inHeader = false
			return true
		}

		if (prev && key === 'CONTINUE' && typeof value === 'string' && typeof prev[1] === 'string' && prev[1].endsWith('&')) {
			prev[1] = prev[1].slice(0, prev[1].length - 1) + value
			header[prev[0]] = prev[1]
		} else if (isCommentKeyword(key)) {
			const text = comment ?? ''
			if (header[key] === undefined) header[key] = text
			else header[key] += `\n${text}`
			prev = undefined
		} else {
			header[key] = value
			prev = card
		}

		return true
	}

	if (!parseCard() || hdus.length === 0) return undefined

	while (true) {
		const size = await readUntil(source, buffer)
		if (size !== FITS_HEADER_CARD_SIZE) break
		if (!parseCard()) break
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

// Builds canonical image HDU cards and strips stale compressed-table keywords.
function buildImageHeaderCards(header: Readonly<FitsHeader>, primary: boolean): FitsHeaderCard[] {
	const cards: FitsHeaderCard[] = [[primary ? 'SIMPLE' : 'XTENSION', primary ? true : 'IMAGE']]
	const bitpix = uncompressedBitpixKeyword(header, 0)
	const width = uncompressedWidthKeyword(header, 0)
	const height = uncompressedHeightKeyword(header, 0)
	const channels = uncompressedNumberOfChannelsKeyword(header, 1)
	const hasImage = width > 0 && height > 0

	cards.push(['BITPIX', bitpix], ['NAXIS', hasImage ? (channels > 1 ? 3 : 2) : 0])

	if (hasImage) {
		cards.push(['NAXIS1', width], ['NAXIS2', height])
		if (channels > 1) cards.push(['NAXIS3', channels])
	}

	if (!primary) cards.push(['PCOUNT', 0], ['GCOUNT', 1])

	for (const key in header) {
		if (COMPRESSION_EXTENSION_EXCLUDED_KEYS.has(key)) continue
		const value = header[key]
		if (value !== undefined) cards.push([key, value])
	}

	return cards
}

// Validates RICE tile/table dimensions before allocating buffers.
function validatePositiveInteger(value: number, label: string) {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive integer`)
	}
}

function shouldUseRiceCompression(header: Readonly<FitsHeader>, compression: FitsCompressionOptions['type']) {
	if (compression === false) return false
	if (compression === RICE_1_COMPRESSION_TYPE) return true
	return isRiceCompressedImageHeader(header)
}

function writeInterleavedToPlanar(input: ImageRawType, output: NumberArray, header: Readonly<FitsHeader>, bitpix: BitpixOrZero, width: number, height: number, channels: number) {
	const numberOfPixels = width * height
	const zero = numericKeyword(header, 'BZERO', bitpix === 16 ? 32768 : bitpix === 32 ? 2147483648 : 0)
	const scale = numericKeyword(header, 'BSCALE', 1)
	const factor = bitpix > 0 ? (2 ** bitpix - 1) / (Number.isFinite(scale) && scale !== 0 ? scale : 1) : 1 // Transform float [0..1] to n-bit integer

	for (let c = 0, p = 0; c < channels; c++) {
		for (let i = 0, m = c; i < numberOfPixels; i++, m += channels) {
			output[p++] = input[m] * factor - zero
		}
	}
}

async function buildRiceCompressedImage(header: Readonly<FitsHeader>, raw: ImageRawType, options: Readonly<FitsCompressionOptions>) {
	const bitpix = uncompressedBitpixKeyword(header, 0)
	const width = uncompressedWidthKeyword(header, 0)
	const height = uncompressedHeightKeyword(header, 0)
	const channels = uncompressedNumberOfChannelsKeyword(header, 1)
	const numberOfPixels = width * height

	if (width < 1 || height < 1 || channels < 1) throw new Error('invalid image dimensions')
	if (bitpix !== 8 && bitpix !== 16 && bitpix !== 32) throw new Error('RICE 1 supports only BITPIX = 8, 16 or 32')

	const tileHeightOption = options.tileHeight ?? 1
	const blockSize = options.blockSize ?? RICE_DEFAULT_BLOCK_SIZE
	validatePositiveInteger(tileHeightOption, 'tile height')
	validatePositiveInteger(blockSize, 'block size')

	const tileHeight = Math.min(height, tileHeightOption)

	const ImageTypedArray = bitpix === 8 ? Uint8Array : bitpix === 16 ? Int16Array : Int32Array
	const imageData = new ImageTypedArray(numberOfPixels * channels)
	writeInterleavedToPlanar(raw, imageData, header, bitpix, width, height, channels)

	const rowSize = 8
	const tilesPerChannel = Math.ceil(height / tileHeight)
	const rowCount = tilesPerChannel * channels
	const rows = Buffer.allocUnsafe(rowCount * rowSize)
	const chunks: Uint8Array[] = []
	let heapSize = 0
	let row = 0

	const { compressRice } = await import('./compression')

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
	let buffer = Buffer.allocUnsafe(FITS_BLOCK_SIZE * 4)
	const headerWriter = new FitsKeywordWriter()

	function fillWithRemainingBytes(size: number, offset: number, value: number) {
		const remaining = computeRemainingBytes(size)
		if (remaining > 0) buffer.fill(value, offset, offset + remaining)
		return remaining
	}

	async function writeHeader(header: Readonly<FitsHeader> | readonly Readonly<FitsHeaderCard>[]) {
		while (true) {
			try {
				let offset = headerWriter.writeAll(header, buffer)
				offset += headerWriter.writeEnd(buffer, offset)
				offset += fillWithRemainingBytes(offset, offset, FITS_HEADER_PADDING)
				await sink.write(buffer, 0, offset)
				return
			} catch (error) {
				if (!(error instanceof RangeError) || error.message !== FITS_HEADER_BUFFER_TOO_SMALL) throw error
				buffer = Buffer.allocUnsafe(buffer.byteLength << 1)
			}
		}
	}

	let hasPrimaryHdu = false

	for (const hdu of hdus) {
		const { header, raw } = hdu

		if (shouldUseRiceCompression(header, options.type)) {
			if (!hasPrimaryHdu) {
				await writeHeader(COMPRESSION_PRIMARY_HEADER)
				hasPrimaryHdu = true
			}

			const { cards, payload } = await buildRiceCompressedImage(header, raw, options)
			await writeHeader(cards)
			await sink.write(payload)

			const pad = fillWithRemainingBytes(payload.length, 0, FITS_DATA_PADDING)
			if (pad > 0) await sink.write(buffer, 0, pad)
			continue
		}

		await writeHeader(buildImageHeaderCards(header, !hasPrimaryHdu))
		const imageWriter = new FitsImageWriter(header)
		const offset = fillWithRemainingBytes(await imageWriter.write(raw, sink), 0, FITS_DATA_PADDING)
		if (offset > 0) await sink.write(buffer, 0, offset)
		hasPrimaryHdu = true
	}
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
		const key = this.#parseKey(line, position)
		const [value, quoted] = this.#parseValue(line, key, position)
		const comment = this.#parseComment(line, position, value)
		return [key, this.#parseValueType(value, quoted), comment?.trim()]
	}

	readAll(buffer: Buffer, offset: number = 0): FitsHeader {
		const header: FitsHeader = {}
		let prev: FitsHeaderCard | undefined

		while (offset < buffer.byteLength) {
			const card = this.read(buffer, offset)
			const [key, value, comment] = card

			if (key === 'END') {
				break
			}

			if (key === '') {
				prev = undefined
				offset += FITS_HEADER_CARD_SIZE
				continue
			}

			if (prev && key === 'CONTINUE' && typeof value === 'string' && typeof prev[1] === 'string' && prev[1].endsWith('&')) {
				prev[1] = prev[1].slice(0, prev[1].length - 1) + value
				header[prev[0]] = prev[1]
			} else if (isCommentKeyword(key)) {
				const text = comment ?? ''
				if (header[key] === undefined) header[key] = text
				else header[key] += `\n${text}`
				prev = undefined
			} else {
				header[key] = value
				prev = card
			}

			offset += FITS_HEADER_CARD_SIZE
		}

		return header
	}

	#parseKey(line: Buffer, position: Position) {
		// Find the '=' in the line, if any...
		const iEq = line.indexOf(EQUAL, position.offset) - position.offset

		// The stem is in the first 8 characters or what precedes an '=' character before that.
		const endStem = Math.min(iEq >= 0 && iEq <= FITS_MAX_KEYWORD_LENGTH ? iEq : FITS_MAX_KEYWORD_LENGTH, FITS_HEADER_CARD_SIZE)
		const start = position.offset
		const end = Math.min(start + endStem, line.byteLength)

		let trimmedStart = start
		let trimmedEnd = end

		while (trimmedStart < trimmedEnd && line.readUInt8(trimmedStart) <= WHITESPACE) trimmedStart++
		while (trimmedEnd > trimmedStart && line.readUInt8(trimmedEnd - 1) <= WHITESPACE) trimmedEnd--

		const stem = trimmedStart < trimmedEnd ? line.toString('ascii', trimmedStart, trimmedEnd) : ''

		// If not using HIERARCH, then be very resilient, and return whatever key the first 8 chars make...
		const key = stem.toUpperCase()
		position.offset = end
		return key
	}

	#parseValue(line: Buffer, key: string, position: Position): readonly [string | undefined, boolean] {
		if (!(key.length > 0 && this.#skipSpaces(line, position))) {
			// nothing left to parse.
			return [undefined, false]
		}

		if (key === 'CONTINUE') {
			return this.#parseValueBody(line, position)
		} else if (line.readInt8(position.offset) === EQUAL) {
			position.offset++
			return this.#parseValueBody(line, position)
		} else {
			return [undefined, false]
		}
	}

	#parseValueBody(line: Buffer, position: Position): readonly [string | undefined, boolean] {
		if (!this.#skipSpaces(line, position)) {
			// Nothing left to parse.
			return [undefined, false]
		}

		if (this.#isNextQuote(line, position)) {
			// Parse as a string value.
			return [this.#parseStringValue(line, position), true]
		} else {
			let end = line.indexOf(SLASH, position.offset)
			const limit = cardEnd(line, position)

			if (end < 0 || end > limit) end = limit

			const value = line.toString('ascii', position.offset, end).trim()
			position.offset = end
			return [value, false]
		}
	}

	#parseStringValue(line: Buffer, position: Position) {
		let escaped = false

		const start = ++position.offset
		const limit = cardEnd(line, position)

		// Build the string value, up to the end quote and paying attention to double
		// quotes inside the string, which are translated to single quotes within
		// the string value itself.
		for (; position.offset < limit; position.offset++) {
			if (this.#isNextQuote(line, position)) {
				position.offset++

				if (!this.#isNextQuote(line, position)) {
					// Closing single quote
					return this.#noTrailingSpaceString(line, start, position.offset - 1, escaped)
				} else {
					escaped = true
				}
			}
		}

		return this.#noTrailingSpaceString(line, start, position.offset, escaped)
	}

	#noTrailingSpaceString(line: Buffer, start: number, end: number, escaped: boolean) {
		const text = line.toString('ascii', start, end).trimEnd()
		return escaped ? unescapeQuotedText(text) : text
	}

	#parseComment(line: Buffer, position: Position, value?: string) {
		if (!this.#skipSpaces(line, position)) {
			// Nothing left to parse.
			return
		}

		// If no value, then everything is comment from here on...
		if (value !== undefined) {
			if (line.readInt8(position.offset) === SLASH) {
				// Skip the '/' itself, the comment is whatever is after it.
				position.offset++
			}
		}

		return line.toString('ascii', position.offset, cardEnd(line, position))
	}

	#parseValueType(value: string | undefined, quoted: boolean) {
		if (quoted) return value
		else if (!value) return undefined
		else if (value === 'T') return true
		else if (value === 'F') return false
		else if (INT_REGEX.test(value)) return +value
		// else if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, value.length - 1).trim()
		else if (DECIMAL_REGEX.test(value)) return value.includes('D') || value.includes('d') ? +value.replace(/[dD]/, 'E') : +value
		else return value
	}

	#skipSpaces(line: Buffer, position: Position) {
		const limit = cardEnd(line, position)

		for (; position.offset < limit; position.offset++) {
			if (line.readUInt8(position.offset) > WHITESPACE) {
				// Line has non-space characters left to parse...
				return true
			}
		}

		// Nothing left to parse.
		return false
	}

	#isNextQuote(line: Buffer, position: Position) {
		return position.offset < cardEnd(line, position) && line.readInt8(position.offset) === SINGLE_QUOTE
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

// Resolves the exclusive end offset of the current 80-byte FITS header card.
function cardEnd(line: Buffer, position: Position) {
	return Math.min(line.byteLength, position.start + FITS_HEADER_CARD_SIZE)
}

// Builds a correctly aligned typed view over the backing FITS image buffer.
function imageDataView(buffer: Buffer, bitpix: BitpixOrZero): NumberArray {
	const byteLength = buffer.byteLength

	if (byteLength === 0) return new Uint8Array(0)

	const pixelInBytes = bitpixInBytes(bitpix)

	if (pixelInBytes < 1 || byteLength % pixelInBytes !== 0) {
		throw new Error('invalid FITS image buffer size')
	}

	const { byteOffset } = buffer
	const length = byteLength / pixelInBytes

	switch (bitpix) {
		case 8:
			return new Uint8Array(buffer.buffer, byteOffset, length)
		case 16:
			return new Int16Array(buffer.buffer, byteOffset, length)
		case 32:
			return new Int32Array(buffer.buffer, byteOffset, length)
		case -32:
			return new Float32Array(buffer.buffer, byteOffset, length)
		case -64:
			return new Float64Array(buffer.buffer, byteOffset, length)
		default:
			throw new Error(`unsupported FITS BITPIX: ${bitpix}`)
	}
}

// Uses the caller-provided buffer when aligned, otherwise allocates an aligned scratch buffer.
function imageBufferView(buffer: Buffer | undefined, size: number, bitpix: BitpixOrZero): Buffer {
	if (buffer === undefined) return Buffer.allocUnsafe(size)
	if (buffer.byteLength < size) throw new Error('FITS image buffer is too small')

	const view = buffer.subarray(0, size)
	const pixelInBytes = bitpixInBytes(bitpix)

	if (size === 0 || pixelInBytes <= 1 || view.byteOffset % pixelInBytes === 0) return view

	return Buffer.allocUnsafe(size)
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
				if (output.byteLength - position.offset < FITS_HEADER_CARD_SIZE) {
					throw new RangeError(FITS_HEADER_BUFFER_TOO_SMALL)
				}

				commentCard[2] = value
				this.#appendKey(output, commentCard, position)
				this.#appendComment(output, commentCard, position)
				this.#pad(output, position)
			}
		} else {
			this.#appendKey(output, card, position)
			const valueStart = this.#appendValue(output, card, position)
			const valueEnd = position.size
			this.#appendComment(output, card, position)

			if (!isCommentStyleCard(card)) {
				// Strings must be left aligned with opening quote in byte 11 (counted from 1)
				this.#realign(output, typeof card[1] === 'string' ? valueEnd : valueStart, valueEnd, position)
			}

			this.#pad(output, position)
		}

		return position.size
	}

	writeAll(header: Readonly<FitsHeader> | readonly Readonly<FitsHeaderCard>[], output: Buffer, offset: number = 0) {
		let size = 0

		if (header instanceof Array) {
			for (const card of header) {
				if (card !== undefined) {
					const n = this.write(card, output, offset)

					if (n === 0) {
						throw new RangeError(FITS_HEADER_BUFFER_TOO_SMALL)
					}

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

					if (n === 0) {
						throw new RangeError(FITS_HEADER_BUFFER_TOO_SMALL)
					}

					size += n
					offset += n
				}
			}
		}

		return size
	}

	writeEnd(output: Buffer, offset: number = 0) {
		const size = this.write(END_CARD, output, offset)

		if (size === 0) {
			throw new RangeError(FITS_HEADER_BUFFER_TOO_SMALL)
		}

		return size
	}

	#appendKey(output: Buffer, card: Readonly<FitsHeaderCard>, position: Position) {
		this.#appendText(output, card[0], position)
		this.#padTo(output, FITS_MAX_KEYWORD_LENGTH, position)
	}

	#appendValue(output: Buffer, card: Readonly<FitsHeaderCard>, position: Position) {
		const [, value, comment] = card

		if (isCommentStyleCard(card)) {
			// Comment-style card. Nothing to do here...
			return position.size
		}

		// Add assignment sequence "= "
		this.#appendText(output, '= ', position)

		if (value === undefined) {
			// 'null' value, nothing more to append.
			return position.size
		}

		const start = position.size

		if (typeof value === 'string') {
			let from = this.#appendQuotedValue(output, value, comment, 0, position)

			while (from < value.length) {
				this.#pad(output, position)
				this.#appendText(output, 'CONTINUE  ', position)
				from += this.#appendQuotedValue(output, value, comment, from, position)
			}
		} else if (typeof value === 'boolean') {
			this.#appendText(output, value ? 'T' : 'F', position)
		} else if (Number.isInteger(value)) {
			this.#appendText(output, value.toFixed(0), position)
		} else {
			this.#appendText(output, value.toExponential(20).toUpperCase(), position)
		}

		return start
	}

	#appendComment(output: Buffer, card: Readonly<FitsHeaderCard>, position: Position) {
		const commentStyleCard = isCommentStyleCard(card)
		const comment = commentStyleCard ? card[2] || (typeof card[1] === 'string' ? card[1] : undefined) : card[2] || FitsKeywordWriter.keywords[card[0]]?.comment

		if (!comment) return true

		const available = this.#getAvailable(output, position) - (commentStyleCard ? 1 : COMMENT_PREFIX.length)

		this.#appendText(output, commentStyleCard ? ' ' : COMMENT_PREFIX, position)

		if (available >= comment.length) {
			this.#appendText(output, comment, position)
			return true
		}

		this.#appendText(output, comment.slice(0, available), position)

		return false
	}

	#appendText(output: Buffer, text: string, position: Position) {
		const n = output.write(text, position.offset, 'ascii')
		position.increment(n)
	}

	#appendQuotedValue(output: Buffer, value: string, comment: FitsHeaderComment, from: number, position: Position) {
		// Always leave room for an extra & character at the end...
		let available = this.#getAvailable(output, position) - 2

		// If long strings are enabled leave space for '&' at the end.
		if (comment?.length && this.#isLongStringsEnabled(output, position)) available--

		// The the remaining part of the string fits in the space with the
		// quoted quotes, then it's easy...
		if (available >= value.length - from) {
			const escaped = escapeQuotedText(from === 0 ? value : value.slice(from))

			if (escaped.length <= available) {
				this.#appendText(output, "'", position)
				this.#appendText(output, escaped, position)

				// Earlier versions of the FITS standard required that the closing quote
				// does not come before byte 20. It's no longer required but older tools
				// may still expect it, so let's conform. This only affects single
				// record card, but not continued long strings...
				this.#padTo(output, FITS_MIN_STRING_END, position)

				this.#appendText(output, "'", position)

				return value.length - from
			}
		}

		if (!this.#isLongStringsEnabled(output, position)) {
			throw new RangeError(FITS_HEADER_BUFFER_TOO_SMALL)
		}

		// Now, we definitely need space for '&' at the end...
		available = this.#getAvailable(output, position) - 3

		// Opening quote
		this.#appendText(output, "'", position)

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
				this.#appendText(output, "''", position)
			} else {
				// Append a non-quote character.
				this.#appendText(output, c, position)
			}
		}

		// & and closing quote.
		this.#appendText(output, "&'", position)

		return consumed
	}

	#getAvailable(output: Buffer, position: Position) {
		const remaining = (FITS_HEADER_CARD_SIZE - (position.size % FITS_HEADER_CARD_SIZE)) % FITS_HEADER_CARD_SIZE
		if (remaining > 0 && position.offset !== position.size && position.offset + remaining > output.byteLength) return output.byteLength - position.offset
		return remaining
	}

	#realign(output: Buffer, at: number, from: number, position: Position) {
		if (position.size >= FITS_HEADER_CARD_SIZE || from >= DEFAULT_COMMENT_ALIGN_POSITION) {
			// We are beyond the alignment point already...
			return false
		}

		const spaces = DEFAULT_COMMENT_ALIGN_POSITION - from

		if (spaces > this.#getAvailable(output, position)) {
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

	#padTo(output: Buffer, to: number, position: Position) {
		for (let pos = position.size % FITS_HEADER_CARD_SIZE; pos < to; pos++) {
			output.writeInt8(WHITESPACE, position.offset)
			position.increment()
		}
	}

	#pad(output: Buffer, position: Position, n: number = this.#getAvailable(output, position)) {
		if (n > 0) {
			output.fill(WHITESPACE, position.offset, position.offset + n)
			position.increment(n)
		}
	}

	#isLongStringsEnabled(output: Buffer, position: Position) {
		// return Math.floor((output.byteLength) / FITS_HEADER_CARD_SIZE) > 1
		const start = position.offset - position.size
		return Math.floor((output.byteLength - start) / FITS_HEADER_CARD_SIZE) > 1
	}
}

function riceBlockSizeFromHeader(header: Readonly<FitsHeader>) {
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

function writePlanarToInterleaved(data: NumberArray, output: ImageRawType, header: Readonly<FitsHeader>, bitpix: BitpixOrZero, width: number, height: number, channels: number) {
	const numberOfPixels = width * height
	const scale = numericKeyword(header, 'BSCALE', 1)
	const zero = numericKeyword(header, 'BZERO', bitpix === 16 ? 32768 : bitpix === 32 ? 2147483648 : 0)
	const factor = bitpix > 0 ? (Number.isFinite(scale) && scale !== 0 ? scale : 1) / (2 ** bitpix - 1) : 1 // Transform n-bit integer to float [0..1]

	for (let i = 0, p = 0; i < numberOfPixels; i++) {
		for (let c = 0, m = i; c < channels; c++, m += numberOfPixels) {
			output[p++] = (data[m] + zero) * factor
		}
	}
}

export class FitsImageReader {
	readonly #compressed: boolean
	readonly #buffer: Buffer
	readonly #data: NumberArray

	constructor(
		readonly hdu: FitsHdu,
		buffer?: Buffer,
	) {
		this.#compressed = isRiceCompressedImageHeader(hdu.header)

		if (this.#compressed) {
			this.#buffer = Buffer.alloc(0)
			this.#data = new Uint8Array(0)
		} else {
			const bitpix = bitpixKeyword(hdu.header, 0)
			this.#buffer = imageBufferView(buffer, hdu.data.size, bitpix)
			this.#data = imageDataView(this.#buffer, bitpix)
		}
	}

	// Reads FITS-format image from source into RGB-interleaved array
	async read(source: Source & Seekable, output: ImageRawType) {
		if (this.#compressed) return await this.#readRiceCompressed(source, output)

		source.seek(this.hdu.data.offset)

		if ((await readUntil(source, this.#buffer, this.hdu.data.size, 0)) !== this.hdu.data.size) return false

		const { header } = this.hdu
		const bitpix = bitpixKeyword(header, 0)
		const pixelInBytes = bitpixInBytes(bitpix)

		// big-endian to little-endian
		if (pixelInBytes === 2) this.#buffer.swap16()
		else if (pixelInBytes === 4) this.#buffer.swap32()
		else if (pixelInBytes === 8) this.#buffer.swap64()

		const width = widthKeyword(header, 0)
		const height = heightKeyword(header, 0)
		const channels = numberOfChannelsKeyword(header, 1)
		writePlanarToInterleaved(this.#data, output, header, bitpix, width, height, channels)

		return true
	}

	async #readRiceCompressed(source: Source & Seekable, output: ImageRawType) {
		const { header } = this.hdu
		const bitpix = uncompressedBitpixKeyword(header, 0)
		const width = uncompressedWidthKeyword(header, 0)
		const height = uncompressedHeightKeyword(header, 0)
		const channels = uncompressedNumberOfChannelsKeyword(header, 1)

		if (width < 1 || height < 1 || channels < 1) {
			throw new Error('invalid image dimensions')
		}

		if (bitpix !== 8 && bitpix !== 16 && bitpix !== 32) {
			throw new Error('RICE 1 supports only BITPIX = 8, 16 or 32')
		}

		const compressed = Buffer.allocUnsafe(this.hdu.data.size)
		source.seek(this.hdu.data.offset)

		if ((await readUntil(source, compressed, compressed.length, 0)) !== compressed.length) return false

		const rowSize = widthKeyword(header, 0)
		const rowCount = heightKeyword(header, 0)
		const heapOffset = Math.trunc(numericKeyword(header, 'THEAP', rowSize * rowCount))
		const tileWidth = Math.trunc(numericKeyword(header, 'ZTILE1', width))
		const tileHeight = Math.trunc(numericKeyword(header, 'ZTILE2', height))
		const tileDepth = Math.trunc(numericKeyword(header, 'ZTILE3', 1))
		const blockSize = riceBlockSizeFromHeader(header)

		validatePositiveInteger(rowSize, 'row size')
		validatePositiveInteger(rowCount, 'row count')
		validatePositiveInteger(tileWidth, 'tile width')
		validatePositiveInteger(tileHeight, 'tile height')
		validatePositiveInteger(tileDepth, 'tile depth')

		if (rowSize < 8 || heapOffset < rowSize * rowCount || heapOffset > compressed.length) {
			throw new Error('compressed FITS image has invalid heap offsets')
		}

		const tilesX = Math.ceil(width / tileWidth)
		const tilesY = Math.ceil(height / tileHeight)
		const tilesZ = Math.ceil(channels / tileDepth)
		const totalTiles = tilesX * tilesY * tilesZ
		const tilePlaneSize = tilesX * tilesY
		const maxTilePixels = Math.min(tileWidth, width) * Math.min(tileHeight, height) * Math.min(tileDepth, channels)

		if (rowCount < totalTiles) throw new Error('compressed FITS image has incomplete tile table')

		const numberOfPixels = width * height
		const ImageTypedArray = bitpix === 8 ? Uint8Array : bitpix === 16 ? Int16Array : Int32Array
		const data = new ImageTypedArray(numberOfPixels * channels)
		const tileBuffer = new ImageTypedArray(maxTilePixels)

		const { decompressRice } = await import('./compression')

		for (let tileIndex = 0; tileIndex < totalTiles; tileIndex++) {
			const descriptorOffset = tileIndex * rowSize
			if (descriptorOffset + 8 > compressed.length) throw new Error('compressed FITS image has truncated tile descriptors')

			const byteCount = compressed.readUInt32BE(descriptorOffset)
			const heapRelativeOffset = compressed.readUInt32BE(descriptorOffset + 4)
			const start = heapOffset + heapRelativeOffset
			const end = start + byteCount

			if (start < 0 || end > compressed.length) throw new Error('compressed FITS image has invalid heap offsets')

			const tz = Math.trunc(tileIndex / tilePlaneSize)
			const rem = tileIndex - tz * tilePlaneSize
			const ty = Math.trunc(rem / tilesX)
			const tx = rem - ty * tilesX

			const x0 = tx * tileWidth
			const y0 = ty * tileHeight
			const z0 = tz * tileDepth
			const thisTileWidth = Math.min(tileWidth, width - x0)
			const thisTileHeight = Math.min(tileHeight, height - y0)
			const thisTileDepth = Math.min(tileDepth, channels - z0)
			const thisTilePixels = thisTileWidth * thisTileHeight * thisTileDepth
			const tile = thisTilePixels === tileBuffer.length ? tileBuffer : tileBuffer.subarray(0, thisTilePixels)

			decompressRice(compressed.subarray(start, end), tile, blockSize)

			for (let z = 0; z < thisTileDepth; z++) {
				const channel = z0 + z
				const channelOffset = channel * numberOfPixels
				const tileOffset = z * thisTileWidth * thisTileHeight

				if (thisTileWidth === width && x0 === 0) {
					data.set(tile.subarray(tileOffset, tileOffset + thisTileWidth * thisTileHeight), channelOffset + y0 * width)
					continue
				}

				for (let y = 0; y < thisTileHeight; y++) {
					let sourceOffset = tileOffset + y * thisTileWidth
					let targetOffset = channelOffset + (y0 + y) * width + x0
					const sourceEnd = sourceOffset + thisTileWidth

					for (; sourceOffset < sourceEnd; sourceOffset++, targetOffset++) {
						data[targetOffset] = tile[sourceOffset]
					}
				}
			}
		}

		writePlanarToInterleaved(data, output, header, bitpix, width, height, channels)

		return true
	}
}

export class FitsImageWriter {
	readonly #buffer: Buffer
	readonly #data: NumberArray

	constructor(
		readonly header: FitsHeader,
		buffer?: Buffer,
	) {
		const bitpix = uncompressedBitpixKeyword(header, 0)
		const width = uncompressedWidthKeyword(header, 0)
		const height = uncompressedHeightKeyword(header, 0)
		const channels = uncompressedNumberOfChannelsKeyword(header, 1)
		const size = width * height * channels * bitpixInBytes(bitpix)
		this.#buffer = imageBufferView(buffer, size, bitpix)
		this.#data = imageDataView(this.#buffer, bitpix)
	}

	// Writes FITS-format image from RGB-interleaved array into sink
	async write(input: ImageRawType, sink: Sink) {
		const bitpix = uncompressedBitpixKeyword(this.header, 0)
		const pixelInBytes = bitpixInBytes(bitpix)
		const width = uncompressedWidthKeyword(this.header, 0)
		const height = uncompressedHeightKeyword(this.header, 0)
		const channels = uncompressedNumberOfChannelsKeyword(this.header, 1)

		writeInterleavedToPlanar(input, this.#data, this.header, bitpix, width, height, channels)

		// little-endian to big-endian
		if (pixelInBytes === 2) this.#buffer.swap16()
		else if (pixelInBytes === 4) this.#buffer.swap32()
		else if (pixelInBytes === 8) this.#buffer.swap64()

		return await sink.write(this.#buffer)
	}
}
