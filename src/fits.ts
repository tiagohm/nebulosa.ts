import { type Angle, deg, parseAngle } from './angle'
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

const NO_VALUE_KEYWORDS = ['COMMENT', 'HISTORY', 'END']

// TODO: Compression
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
				const size = widthKeyword(header, 0) * heightKeyword(header, 0) * numberOfChannelsKeyword(header, 1) * bitpixInBytes(bitpixKeyword(header, 0))
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

// TODO: Compression
export async function writeFits(sink: Sink & Partial<Seekable>, hdus: readonly Readonly<Pick<Image, 'header' | 'raw'>>[]) {
	const buffer = Buffer.allocUnsafe(FITS_BLOCK_SIZE)
	const writer = new FitsKeywordWriter()

	let offset = 'position' in sink ? sink.position! : 0

	async function writeHeader(key: FitsHeaderKey, value: FitsHeaderValue) {
		const length = writer.write([key, value], buffer)
		offset += await sink.write(buffer, 0, length)
	}

	async function fillWithRemainingBytes() {
		const remaining = computeRemainingBytes(offset)

		if (remaining > 0) {
			buffer.fill(20, 0, remaining)
			offset += await sink.write(buffer, 0, remaining)
		}
	}

	for (const hdu of hdus) {
		const { header, raw } = hdu
		let end = false

		for (const key in header) {
			await writeHeader(key, header[key])

			if (key === 'END') {
				end = true
				break
			}
		}

		if (!end) await writeHeader('END', undefined)
		await fillWithRemainingBytes()

		const writer = new FitsImageWriter(header)
		await writer.write(raw, sink)
		await fillWithRemainingBytes()
	}
}

export function computeRemainingBytes(size: number) {
	const remaining = size % FITS_BLOCK_SIZE
	return remaining === 0 ? 0 : FITS_BLOCK_SIZE - remaining
}

function escapeQuotedText(text: string) {
	return text.replaceAll("'", "''")
}

function unescapeQuotedText(text: string) {
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

export class FitsImageReader {
	private readonly buffer: Buffer
	private readonly data: NumberArray

	constructor(
		private readonly hdu: FitsHdu,
		buffer?: Buffer,
	) {
		const bitpix = bitpixKeyword(hdu.header, 0)
		this.buffer = buffer?.subarray(0, hdu.data.size) ?? Buffer.allocUnsafe(hdu.data.size)
		this.data = bitpix === 8 ? new Uint8Array(this.buffer.buffer) : bitpix === 16 ? new Int16Array(this.buffer.buffer) : bitpix === 32 ? new Int32Array(this.buffer.buffer) : bitpix === -32 ? new Float32Array(this.buffer.buffer) : new Float64Array(this.buffer.buffer)
	}

	// Reads FITS-format image from source into RGB-interleaved array
	async read(source: Source & Seekable, output: ImageRawType) {
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
		const numberOfPixels = width * height
		const scale = (header.BSCALE as number) || 1
		const zero = (header.BZERO as number) || 0
		const factor = bitpix > 0 ? scale / (2 ** bitpix - 1) : 1 // Transform n-bit integer to float [0..1]
		const data = this.data

		for (let i = 0, p = 0; i < numberOfPixels; i++) {
			for (let c = 0, m = i; c < channels; c++, m += numberOfPixels) {
				output[p++] = (data[m] + zero) * factor
			}
		}

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
		const numberOfPixels = width * height
		const zero = bitpix === 16 ? 32768 : bitpix === 32 ? 2147483648 : 0
		const factor = bitpix > 0 ? 2 ** bitpix - 1 : 1 // Transform float [0..1] to n-bit integer
		const data = this.data

		for (let c = 0, p = 0; c < channels; c++) {
			for (let i = 0, m = c; i < numberOfPixels; i++, m += channels) {
				data[p++] = input[m] * factor - zero
			}
		}

		// little-endian to big-endian
		if (pixelInBytes === 2) this.buffer.swap16()
		else if (pixelInBytes === 4) this.buffer.swap32()
		else if (pixelInBytes === 8) this.buffer.swap64()

		await sink.write(this.buffer)
	}
}
