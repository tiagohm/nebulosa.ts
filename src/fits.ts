import { isWhiteSpaceLike } from 'typescript'
import type { Mutable } from 'utility-types'
import { readUntil, type Seekable, type Source } from './io'

export type FitsHeaderKey = string
export type FitsHeaderValue = string | number | boolean | undefined
export type FitsHeader = Record<string, FitsHeaderValue>

export interface FitsData {
	readonly source: Source & Seekable
	readonly size: number
	readonly offset: number
}

export interface FitsHdu {
	readonly header: FitsHeader
	readonly data?: FitsData
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

export function numeric(header: FitsHeader, key: string, value: number = 0) {
	return (header[key] as number | undefined) ?? value
}

export function naxis(header: FitsHeader, value: number = 0) {
	return numeric(header, 'NAXIS', value)
}

export function width(header: FitsHeader, value: number = 0) {
	return numeric(header, 'NAXIS1', value)
}

export function height(header: FitsHeader, value: number = 0) {
	return numeric(header, 'NAXIS2', value)
}

export function channels(header: FitsHeader, value: number = 1) {
	return numeric(header, 'NAXIS3', value)
}

export function bitpix(header: FitsHeader): Bitpix | 0 {
	return numeric(header, 'BITPIX')
}

const MAGIC_BYTES = Buffer.from('SIMPLE', 'ascii')

const BLOCK_SIZE = 2880
const HEADER_CARD_SIZE = 80
const MAX_KEYWORD_LENGTH = 8
const MAX_VALUE_LENGTH = 70

const WHITESPACE = 32
const SINGLE_QUOTE = 39
const SLASH = 47
const EQUAL = 61

const DECIMAL_REGEX = new RegExp('^[+-]?\\d+(\\.\\d*)?([dDeE][+-]?\\d+)?$')
const INT_REGEX = new RegExp('^[+-]?\\d+$')

export async function read(source: Source & Seekable): Promise<Fits | undefined> {
	const buffer = Buffer.allocUnsafe(HEADER_CARD_SIZE)

	if ((await readUntil(source, buffer, HEADER_CARD_SIZE)) !== HEADER_CARD_SIZE) {
		return undefined
	}

	if (!buffer.subarray(0, 6).equals(MAGIC_BYTES)) {
		return undefined
	}

	const hdus: FitsHdu[] = []
	let position = 0

	function parseKey() {
		// Find the '=' in the line, if any...
		const ieq = buffer.indexOf(EQUAL)

		// The stem is in the first 8 characters or what precedes an '=' character
		// before that.
		position = ieq >= 0 && ieq <= MAX_KEYWORD_LENGTH ? ieq : MAX_KEYWORD_LENGTH
		const key = buffer.subarray(0, position).toString('ascii').trim().toUpperCase()

		// If not using HIERARCH, then be very resilient,
		// and return whatever key the first 8 chars make...

		// If the line does not have an '=', can only be a simple key
		// If it's not a HIERARCH keyword, then return the simple key.
		if (ieq < 0 || key !== 'HIERARCH') {
			return key
		}

		// TODO: Handle HIERARCH keyword
		return key
	}

	function skipSpaces() {
		while (position < buffer.byteLength) {
			const c = buffer.readUInt8(position)

			if (!isWhiteSpaceLike(c)) {
				// Line has non-space characters left to parse...
				return true
			}

			position++
		}

		return false
	}

	function parseValue(key: string) {
		// nothing left to parse.
		if (!key.length || !skipSpaces()) return undefined

		if (key === 'CONTINUE') {
			return parseValueBody()
		} else if (buffer.readUInt8(position) === EQUAL) {
			if (position > MAX_KEYWORD_LENGTH) {
				// equal sign = after the 9th char -- only supported with hierarch keys...
				if (!key.startsWith('HIERARCH')) {
					// It's not a HIERARCH key
					return undefined
				}
			}

			position++

			return parseValueBody()
		} else {
			return undefined
		}
	}

	function isNextQuote() {
		if (position >= buffer.byteLength) return false
		else return buffer.readUInt8(position) == SINGLE_QUOTE
	}

	function parseValueType(value: string) {
		if (!value) return undefined
		else if (value === 'T') return true
		else if (value === 'F') return false
		// else if (value.startsWith("'") && value.endsWith("'")) return value.substring(1, value.length - 1).trim()
		else if (DECIMAL_REGEX.test(value)) return parseFloat(value.toUpperCase().replace('D', 'E'))
		else if (INT_REGEX.test(value)) return parseInt(value)
		else return value
	}

	function parseValueBody() {
		// nothing left to parse.
		if (!skipSpaces()) return undefined

		if (isNextQuote()) {
			// Parse as a string value, or else throw an exception.
			return parseStringValue()
		} else {
			let end = buffer.indexOf(SLASH, position)

			if (end < 0) {
				end = buffer.byteLength
			}

			const value = buffer.subarray(position, end).toString('ascii').trim()
			position = end
			return parseValueType(value)
		}
	}

	function parseStringValue() {
		// Build the string value, up to the end quote and paying attention to double
		// quotes inside the string, which are translated to single quotes within
		// the string value itself.
		position++

		const start = position

		while (position < buffer.byteLength) {
			if (isNextQuote()) {
				position++

				if (!isNextQuote()) {
					// Closing single quote
					return retrieveNoTrailingSpaceText(start, position - 1)
				}
			}

			position++
		}

		return retrieveNoTrailingSpaceText(start, start + (MAX_VALUE_LENGTH - 1))
	}

	function retrieveNoTrailingSpaceText(start: number, end: number) {
		// Remove trailing spaces only!
		while (end-- >= start) {
			if (buffer.readUint8(end) !== WHITESPACE) {
				break
			}
		}

		return end < 0 ? '' : buffer.subarray(start, end + 1).toString('ascii')
	}

	function parseComment(value: boolean) {
		// nothing left to parse.
		if (!skipSpaces()) return undefined

		// if no value, then everything is comment from here on...
		if (value) {
			if (buffer.readUInt8(position) === SLASH) {
				// Skip the '/' itself, the comment is whatever is after it.
				position++
			}
		}

		return buffer.subarray(position).toString('ascii').trim()
	}

	function parseCard() {
		position = 0

		const key = parseKey()
		const value = parseValue(key)
		const comment = parseComment(!!value)

		if (key) {
			if (key === 'SIMPLE' || key === 'XTENSION') {
				hdus.push({ header: { [key]: value } })
			} else if (key !== 'END') {
				const { header } = hdus[hdus.length - 1]

				if (value === undefined && comment) {
					if (key in header) (header[key] as string) += `\n${comment}`
					else header[key] = comment
				} else {
					header[key] = value
				}
			} else {
				const hdu = hdus[hdus.length - 1]

				source.seek(source.position + computeRemainingBytes(source.position))
				const offset = source.position

				const { header } = hdu
				const size = width(header) * height(header) * channels(header) * (Math.abs(bitpix(header)) / 8)
				source.seek(source.position + size + computeRemainingBytes(size))
				;(hdu as Mutable<FitsHdu>).data = { source, size, offset }
			}

			// console.info(`key=${key}, value=${value}, comment=${comment}`)
		}

		return key
	}

	parseCard()

	while (true) {
		const size = await readUntil(source, buffer, HEADER_CARD_SIZE)
		if (size !== HEADER_CARD_SIZE) break
		parseCard()
	}

	return { hdus }
}

function computeRemainingBytes(size: number) {
	const remaining = size % BLOCK_SIZE
	return remaining === 0 ? 0 : BLOCK_SIZE - remaining
}
