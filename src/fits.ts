import type { Mutable } from 'utility-types'
import { type Seekable, type Sink, type Source, readUntil, sourceTransferToSink } from './io'

export const FITS_IMAGE_MIME_TYPE = 'image/fits'
export const FITS_APPLICATION_MIME_TYPE = 'application/fits'

export type FitsHeaderKey = string
export type FitsHeaderValue = string | number | boolean | undefined
export type FitsHeaderCard = [string, FitsHeaderValue, string?]
export type FitsHeader = Record<FitsHeaderKey, FitsHeaderValue>

export interface FitsData {
	readonly source: (Source & Seekable) | Buffer
	readonly size: number
	readonly offset: number
}

export interface FitsHdu {
	readonly offset: number
	readonly header: FitsHeader
	readonly data: FitsData
}

export interface Fits {
	readonly hdus: FitsHdu[]
}

export enum Bitpix {
	BYTE = 8,
	SHORT = 16,
	INTEGER = 32,
	LONG = 64,
	FLOAT = -32,
	DOUBLE = -64,
}

export function hasKeyword(header: FitsHeader, key: keyof FitsHeader) {
	return header[key] !== undefined
}

export function numericKeyword(header: FitsHeader, key: keyof FitsHeader, defaultValue: number = 0) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value
	else if (typeof value === 'boolean') return value ? 1 : 0
	else return parseFloat(value)
}

export function booleanKeyword(header: FitsHeader, key: keyof FitsHeader, defaultValue: boolean = false) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value !== 0
	else if (typeof value === 'string') return value === 'T' || value.toLowerCase() === 'true'
	else return value
}

export function textKeyword(header: FitsHeader, key: keyof FitsHeader, defaultValue: string = '') {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'string') return value
	else return `${value}`
}

export function naxis(header: FitsHeader, defaultValue: number = 0) {
	return numericKeyword(header, 'NAXIS', defaultValue)
}

export function width(header: FitsHeader, defaultValue: number = 0) {
	return numericKeyword(header, 'NAXIS1', defaultValue)
}

export function height(header: FitsHeader, defaultValue: number = 0) {
	return numericKeyword(header, 'NAXIS2', defaultValue)
}

export function numberOfChannels(header: FitsHeader, defaultValue: number = 1) {
	return numericKeyword(header, 'NAXIS3', defaultValue)
}

export function bitpix(header: FitsHeader, defaultValue: Bitpix | 0 = 0): Bitpix | 0 {
	return numericKeyword(header, 'BITPIX', defaultValue)
}

const MAGIC_BYTES = Buffer.from('SIMPLE', 'ascii')

export const FITS_BLOCK_SIZE = 2880
export const FITS_HEADER_CARD_SIZE = 80
export const FITS_MAX_KEYWORD_LENGTH = 8
export const FITS_MAX_VALUE_LENGTH = 70
const MIN_STRING_END = 19

const COMMENT_KEYWORDS = ['COMMENT', 'HISTORY']

export async function readFits(source: Source & Seekable): Promise<Fits | undefined> {
	const buffer = Buffer.allocUnsafe(FITS_HEADER_CARD_SIZE)
	const reader = new FitsKeywordReader()

	if ((await readUntil(source, buffer)) !== FITS_HEADER_CARD_SIZE) {
		return undefined
	}

	if (!buffer.subarray(0, 6).equals(MAGIC_BYTES)) {
		return undefined
	}

	const hdus: FitsHdu[] = []
	let prev: FitsHeaderCard | undefined

	function parseCard() {
		const card = reader.read(buffer)
		const [key, value, comment] = card

		if (key) {
			if (key === 'SIMPLE' || key === 'XTENSION') {
				const offset = source.position - FITS_HEADER_CARD_SIZE
				hdus.push({ header: { [key]: value }, offset } as never)
			} else if (key !== 'END') {
				const { header } = hdus[hdus.length - 1]

				if (prev && key === 'CONTINUE' && typeof value === 'string' && typeof prev[1] === 'string' && prev[1].endsWith('&')) {
					prev[1] = prev[1].substring(0, prev[1].length - 1) + value
					header[prev[0]] = prev[1]
				} else if (COMMENT_KEYWORDS.includes(key)) {
					if (header[key] === undefined) header[key] = value
					else header[key] += `\n${value}`
					prev = undefined
				} else {
					header[key] = value
					prev = card
				}
			} else {
				const hdu = hdus[hdus.length - 1]

				source.seek(source.position + computeRemainingBytes(source.position))
				const offset = source.position

				const { header } = hdu
				const size = width(header) * height(header) * numberOfChannels(header) * (Math.abs(bitpix(header)) / 8)
				source.seek(source.position + size + computeRemainingBytes(size))
				;(hdu as Mutable<FitsHdu>).data = { source, size, offset }
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

export async function writeFits(sink: Sink & Partial<Seekable>, hdus: FitsHdu[] | Fits) {
	let offset = 'position' in sink ? (sink.position ?? 0) : 0
	const buffer = Buffer.allocUnsafe(FITS_BLOCK_SIZE)
	let bufferPos = 0

	hdus = 'hdus' in hdus ? hdus.hdus : hdus

	function appendText(text: string) {
		if (text.length) {
			bufferPos += buffer.write(text, bufferPos, 'ascii')
		}
	}

	function padTo(n: number) {
		for (let i = bufferPos; i < n; i++) {
			bufferPos += buffer.write(' ', bufferPos, 'ascii')
		}
	}

	function availableCharCount() {
		return (FITS_HEADER_CARD_SIZE - (bufferPos % FITS_HEADER_CARD_SIZE)) % FITS_HEADER_CARD_SIZE
	}

	async function flushBuffer() {
		if (bufferPos > 0) {
			padTo(FITS_HEADER_CARD_SIZE)
			offset += await sink.write(buffer, 0, FITS_HEADER_CARD_SIZE)
			bufferPos = 0
		}
	}

	function appendKey(key: string) {
		appendText(key)
		padTo(FITS_MAX_KEYWORD_LENGTH)
	}

	function appendQuotedValue(value: string, from: number = 0, hasQuote: boolean = true) {
		// Always leave room for an extra & character at the end...
		let available = availableCharCount() - (hasQuote ? 2 : 0)

		// The remaining part of the string fits in the space with the
		// quoted quotes, then it's easy...
		if (available >= value.length - from) {
			const escaped = escapeQuotedText(value.substring(from))

			if (escaped.length <= available) {
				// Opening quote.
				if (hasQuote) appendText("'")
				appendText(escaped)
				// Earlier versions of the FITS standard required that the closing quote
				// does not come before byte 20. It's no longer required but older tools
				// may still expect it, so let's conform. This only affects single
				// record card, but not continued long strings...
				padTo(MIN_STRING_END)
				// Closing quote.
				if (hasQuote) appendText("'")

				return value.length - from
			}
		}

		// Now, we definitely need space for '&' at the end...
		if (hasQuote) available--

		// Opening quote.
		if (hasQuote) appendText("'")

		// For counting the characters consumed from the input.
		let consumed = 0
		let i = 0

		while (i < available) {
			const c = value[from + consumed]

			if (c === "'") {
				// Quoted quotes take up 2 spaces...
				i++

				if (i + 1 >= available) {
					// Otherwise leave the value quote unconsumed.
					break
				}

				// Only append the quoted quote if there is room for both.
				appendText("''")
			} else {
				// Append a non-quote character.
				appendText(c)
			}

			i++
			consumed++
		}

		// & and Closing quote.
		if (hasQuote) appendText("&'")

		return consumed
	}

	async function appendQuotedValueWithContinue(value: string) {
		let from = appendQuotedValue(value, 0)

		while (from < value.length) {
			await flushBuffer()
			appendText('CONTINUE  ')
			from += appendQuotedValue(value, from)
		}
	}

	async function appendLongStringComment(key: keyof FitsHeader, value: string) {
		const parts = value.split('\n')

		if (parts[0]) {
			appendKey(key)
			appendQuotedValue(parts[0], 0, false)

			for (let i = 1; i < parts.length; i++) {
				await flushBuffer()
				appendKey(key)
				appendQuotedValue(parts[i], 0, false)
			}
		}
	}

	async function appendValue(key: keyof FitsHeader, value: FitsHeaderValue) {
		// Comment-style card. Nothing to do here...
		if (value === undefined) return

		// Add assignment sequence "= "
		appendText('= ')

		// 'null' value, nothing more to append.
		// if (value === '') return

		if (typeof value === 'string') {
			await appendQuotedValueWithContinue(value)
		} else {
			const text = typeof value === 'number' ? `${value}` : value ? 'T' : 'F'
			const available = availableCharCount()
			const n = Math.min(available, text.length)

			if (n >= 1) {
				appendText(text.substring(0, n))
			}
		}
	}

	async function writeHeader(key: keyof FitsHeader, value: FitsHeaderValue) {
		if (key === 'COMMENT' || key === 'HISTORY') {
			if (value) {
				await appendLongStringComment(key, value as string)
			}
		} else {
			appendKey(key)
			await appendValue(key, value)
			// appendComment(comment)
		}

		await flushBuffer()
	}

	async function writeData(sink: Sink, data: FitsData) {
		const { source, offset } = data

		if (Buffer.isBuffer(source)) {
			await sink.write(source)
		} else {
			source.seek(offset)
			await sourceTransferToSink(source, sink, buffer)
		}
	}

	async function fillWithRemainingBytes() {
		const remaining = computeRemainingBytes(offset)

		if (remaining > 0) {
			buffer.fill(0, 0, remaining)
			offset += await sink.write(buffer, 0, remaining)
		}
	}

	for (const hdu of hdus) {
		const { header, data } = hdu
		let end = false

		for (const key in header) {
			if (key === 'END') end = true
			await writeHeader(key, header[key])
		}

		if (!end) await writeHeader('END', undefined)

		await fillWithRemainingBytes()
		await writeData(sink, data)
		await fillWithRemainingBytes()
	}
}

function computeRemainingBytes(size: number) {
	const remaining = size % FITS_BLOCK_SIZE
	return remaining === 0 ? 0 : FITS_BLOCK_SIZE - remaining
}

function escapeQuotedText(text: string) {
	return text.replace("'", "''")
}

function unescapeQuotedText(text: string) {
	return text.replace("''", "'")
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
	private position = 0

	read(line: Buffer): FitsHeaderCard {
		this.position = 0
		const key = this.parseKey(line)
		const [value, quoted] = this.parseValue(line, key)
		const comment = this.parseComment(line, value)
		return [key, this.parseValueType(value, quoted), comment?.trim()]
	}

	private parseKey(line: Buffer) {
		// Find the '=' in the line, if any...
		const iEq = line.indexOf(EQUAL, this.position)

		// The stem is in the first 8 characters or what precedes an '=' character before that.
		const endStem = Math.min(iEq >= 0 && iEq <= FITS_MAX_KEYWORD_LENGTH ? iEq : FITS_MAX_KEYWORD_LENGTH, line.byteLength)
		const stem = line.toString('ascii', this.position, endStem)

		// If not using HIERARCH, then be very resilient, and return whatever key the first 8 chars make...
		const key = stem.trim().toUpperCase()
		this.position = endStem
		return key
	}

	private parseValue(line: Buffer, key: string): readonly [string | undefined, boolean] {
		if (!(key.length && this.skipSpaces(line))) {
			// nothing left to parse.
			return [undefined, false]
		}

		if (key === 'CONTINUE') {
			return this.parseValueBody(line)
		} else if (line.readInt8(this.position) === EQUAL) {
			this.position++
			return this.parseValueBody(line)
		} else {
			return [undefined, false]
		}
	}

	private parseValueBody(line: Buffer): readonly [string | undefined, boolean] {
		if (!this.skipSpaces(line)) {
			// Nothing left to parse.
			return [undefined, false]
		}

		if (this.isNextQuote(line)) {
			// Parse as a string value.
			return [this.parseStringValue(line), true]
		} else {
			let end = line.indexOf(SLASH, this.position)

			if (end < 0) end = line.byteLength

			const value = line.toString('ascii', this.position, end).trim()
			this.position = end
			return [value, false]
		}
	}

	private parseStringValue(line: Buffer) {
		let size = 0
		const start = ++this.position

		// Build the string value, up to the end quote and paying attention to double
		// quotes inside the string, which are translated to single quotes within
		// the string value itself.
		for (; this.position < line.byteLength; this.position++) {
			if (this.isNextQuote(line)) {
				this.position++

				if (!this.isNextQuote(line)) {
					// Closing single quote
					return this.noTrailingSpaceString(line, start, start + size)
				}
			}

			size++
		}

		return this.noTrailingSpaceString(line, start, start + size)
	}

	private noTrailingSpaceString(line: Buffer, start: number, end: number) {
		return line.toString('ascii', start, end).trimEnd()
	}

	private parseComment(line: Buffer, value?: string) {
		if (!this.skipSpaces(line)) {
			// Nothing left to parse.
			return
		}

		// If no value, then everything is comment from here on...
		if (value) {
			if (line.readInt8(this.position) === SLASH) {
				// Skip the '/' itself, the comment is whatever is after it.
				this.position++
			}
		}

		return line.toString('ascii', this.position)
	}

	private parseValueType(value: string | undefined, quoted: boolean) {
		if (quoted) return value
		else if (!value) return undefined
		else if (value === 'T') return true
		else if (value === 'F') return false
		// else if (value.startsWith("'") && value.endsWith("'")) return value.substring(1, value.length - 1).trim()
		else if (DECIMAL_REGEX.test(value)) return parseFloat(value.toUpperCase().replace('D', 'E'))
		else if (INT_REGEX.test(value)) return parseInt(value)
		else return value
	}

	private skipSpaces(line: Buffer) {
		for (; this.position < line.byteLength; this.position++) {
			if (line.readInt8(this.position) !== WHITESPACE) {
				// Line has non-space characters left to parse...
				return true
			}
		}

		// Nothing left to parse.
		return false
	}

	private isNextQuote(line: Buffer) {
		return this.position < line.byteLength && line.readInt8(this.position) === SINGLE_QUOTE
	}
}
