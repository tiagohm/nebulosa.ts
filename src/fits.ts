import type { Mutable } from 'utility-types'
import { bitpix, bitpixInBytes, height, numberOfChannels, width } from './fits.util'
import { readUntil, type Seekable, type Sink, type Source, sourceTransferToSink } from './io'

export type FitsHeaderKey = string
export type FitsHeaderValue = string | number | boolean | undefined
export type FitsHeaderComment = string | undefined
export type FitsHeaderCard = [FitsHeaderKey, FitsHeaderValue, FitsHeaderComment?]
export type FitsHeader = Record<FitsHeaderKey, FitsHeaderValue>

export interface FitsData {
	readonly source: (Source & Partial<Seekable>) | Buffer
	readonly size?: number
	readonly offset?: number
}

export interface FitsHdu {
	readonly offset?: number
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

export type BitpixOrZero = Bitpix | 0

const MAGIC_BYTES = 'SIMPLE'

export const FITS_BLOCK_SIZE = 2880
export const FITS_HEADER_CARD_SIZE = 80
export const FITS_MAX_KEYWORD_LENGTH = 8
export const FITS_MAX_VALUE_LENGTH = 70
export const FITS_MIN_STRING_END = 19

const NO_VALUE_KEYWORDS = ['COMMENT', 'HISTORY', 'END']

export async function readFits(source: Source & Seekable): Promise<Fits | undefined> {
	const buffer = Buffer.allocUnsafe(FITS_HEADER_CARD_SIZE)
	const reader = new FitsKeywordReader()

	if ((await readUntil(source, buffer)) !== FITS_HEADER_CARD_SIZE) {
		return undefined
	}

	if (buffer.subarray(0, 6).toString('ascii') !== MAGIC_BYTES) {
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

				source.seek(source.position + computeRemainingBytes(source.position))
				const offset = source.position

				const { header } = hdu
				const size = width(header) * height(header) * numberOfChannels(header) * bitpixInBytes(bitpix(header))
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

export async function writeFits(sink: Sink & Partial<Seekable>, fits: FitsHdu[] | Fits) {
	let offset = 'position' in sink ? (sink.position ?? 0) : 0
	const buffer = Buffer.allocUnsafe(FITS_BLOCK_SIZE)
	const writer = new FitsKeywordWriter()

	const hdus = 'hdus' in fits ? fits.hdus : fits

	async function writeHeader(key: FitsHeaderKey, value: FitsHeaderValue) {
		if (typeof value === 'string') {
			for (const part of value.split('\n')) {
				const length = writer.write([key, part], buffer)
				offset += await sink.write(buffer, 0, length)
			}
		} else {
			const length = writer.write([key, value], buffer)
			offset += await sink.write(buffer, 0, length)
		}
	}

	async function writeData(sink: Sink, data: FitsData) {
		const { source } = data

		if (Buffer.isBuffer(source)) {
			offset += await sink.write(source)
		} else {
			source.seek?.(data.offset ?? 0)
			offset += await sourceTransferToSink(source, sink, buffer)
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
			await writeHeader(key, header[key])

			if (key === 'END') {
				end = true
				break
			}
		}

		if (!end) {
			await writeHeader('END', undefined)
		}

		await fillWithRemainingBytes()

		await writeData(sink, data)
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

export function isCommentStyleCard(card: FitsHeaderCard) {
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
		else if (INT_REGEX.test(value)) return parseInt(value)
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
	write(card: FitsHeaderCard, output: Buffer, offset: number = 0) {
		if (output.byteLength - offset < FITS_HEADER_CARD_SIZE) return 0

		const position = new Position(offset)
		this.appendKey(output, card, position)
		const valueStart = this.appendValue(output, card, position)
		const valueEnd = position.size
		this.appendComment(output, card, position)

		if (!isCommentStyleCard(card)) {
			// Strings must be left aligned with opening quote in byte 11 (counted from 1)
			this.realign(output, typeof card[1] === 'string' ? valueEnd : valueStart, valueEnd, position)
		}

		this.pad(output, position)

		return position.size
	}

	private appendKey(output: Buffer, card: FitsHeaderCard, position: Position) {
		this.appendText(output, card[0], position)
		this.padTo(output, FITS_MAX_KEYWORD_LENGTH, position)
	}

	private appendValue(output: Buffer, card: FitsHeaderCard, position: Position) {
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

	private appendComment(output: Buffer, card: FitsHeaderCard, position: Position) {
		const commentStyleCard = isCommentStyleCard(card)
		const comment = commentStyleCard ? card[2] || (typeof card[1] === 'string' ? card[1] : undefined) : card[2]

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

// https://fits.gsfc.nasa.gov/fits_dictionary.html

export type FitsKeywords = FitsStandardKeywords | FitsCommonlyUsedKeywords

// https://heasarc.gsfc.nasa.gov/docs/fcg/standard_dict.html

export type FitsStandardKeywords =
	| 'AUTHOR' // author of the data
	| 'BITPIX' // bits per data value
	| 'BLANK' // value used for undefined array elements
	| 'BLOCKED' // is physical blocksize a multiple of 2880?
	| 'BSCALE' // linear factor in scaling equation
	| 'BUNIT' // physical units of the array values
	| 'BZERO' // zero point in scaling equation
	| `CDELT${number}` // coordinate increment along axis
	| 'COMMENT' // descriptive comment
	| `CROTA${number}` // coordinate system rotation angle
	| `CRPIX${number}` // coordinate system reference pixel
	| `CRVAL${number}` // coordinate system value at reference pixel
	| `CTYPE${number}` // name of the coordinate axis
	| 'DATAMAX' // maximum data value
	| 'DATAMIN' // minimum data value
	| 'DATE' // date of file creation
	| 'DATE-OBS' // date of the observation
	| 'END' // marks the end of the header keywords
	| 'EPOCH' // equinox of celestial coordinate system
	| 'EQUINOX' // equinox of celestial coordinate system
	| 'EXTEND' // may the FITS file contain extensions?
	| 'EXTLEVEL' // hierarchical level of the extension
	| 'EXTNAME' // name of the extension
	| 'EXTVER' // version of the extension
	| 'GCOUNT' // group count
	| 'GROUPS' // indicates random groups structure
	| 'HISTORY' // processing history of the data
	| 'INSTRUME' // name of instrument
	| 'NAXIS' // number of axes
	| `NAXIS${number}` // size of the axis
	| 'OBJECT' // name of observed object
	| 'OBSERVER' // observer who acquired the data
	| 'ORIGIN' // organization responsible for the data
	| 'PCOUNT' // parameter count
	| `PSCAL${number}` // parameter scaling factor
	| `PTYPE${number}` // name of random groups parameter
	| `PZERO${number}` // parameter scaling zero point
	| 'REFERENC' // bibliographic reference
	| 'SIMPLE' // does file conform to the Standard?
	| `TBCOL${number}` // begining column number
	| `TDIM${number}` // dimensionality of the array
	| `TDISP${number}` // display format
	| 'TELESCOP' // name of telescope
	| 'TFIELDS' // number of columns in the table
	| `TFORM${number}` // column data format
	| 'THEAP' // offset to starting data heap address
	| `TNULL${number}` // value used to indicate undefined table element
	| `TSCAL${number}` // linear data scaling factor
	| `TTYPE${number}` // column name
	| `TUNIT${number}` // column units
	| `TZERO${number}` // column scaling zero point
	| 'XTENSION' // marks beginning of new HDU

// https://heasarc.gsfc.nasa.gov/docs/fcg/common_dict.html

export type FitsCommonlyUsedKeywords =
	| 'AIRMASS' // air mass
	| 'APERTURE' // name of field of view aperture
	| 'CHECKSUM' // checksum for the current HDU
	| 'CHECKVER' // version of checksum algorithm
	| 'CONFIGUR' // software configuration used to process the data
	| 'CONTINUE' // denotes the CONTINUE long string keyword convention
	| 'CREATOR' // the name of the software task that created the file
	| 'DATAMODE' // pre-processor data mode
	| 'DATASUM' // checksum of the data records
	| 'DATE-END' // date of the end of observation
	| 'DEC' // declination of the observed object
	| 'DEC_NOM' // nominal declination of the observation
	| 'DEC_OBJ' // declination of the observed object
	| 'DEC_PNT' // declination of the pointed direction of the instrument
	| 'DEC_SCX' // declination of the X spacecraft axis
	| 'DEC_SCY' // declination of the Y spacecraft axis
	| 'DEC_SCZ' // declination of the Z spacecraft axis
	| 'DETNAM' // name of the detector used to make the observation
	| 'ELAPTIME' // elapsed time of the observation
	| 'EXPOSURE' // exposure time
	| 'EXPTIME' // exposure time
	| 'FILENAME' // name of the file
	| 'FILETYPE' // type of file
	| 'FILTER' // name of filter used during the observation
	| `FILTER${number}` // name of filters used during the observation
	| 'GRATING' // name of the grating used during the observation.
	| `GRATING${number}` // name of gratings used during the observation.
	| 'HDUCLASS' // general identifier for the classification of the data
	| `HDUCLAS${number}` // hierarchical classification of the data
	| 'HDUDOC' // reference to document describing the data format
	| 'HDULEVEL' // hierarchical level of the HDU
	| 'HDUNAME ' // descriptive name of the HDU
	| 'HDUVER' // version number of the HDU
	| 'HDUVERS' // specific version of the document referenced by HDUDOC
	| 'HIERARCH' // denotes the HIERARCH keyword convention
	| 'INHERIT' // denotes the INHERIT keyword convention
	| 'LATITUDE' // geographic latitude of the observation
	| 'LIVETIME' // exposure time after deadtime correction
	| 'MOONANGL' // angle between the observation and the moon
	| 'NEXTEND' // Number of standard extensions
	| 'OBJNAME' // IAU name of observed object
	| 'OBS_ID' // unique observation ID
	| 'OBS_MODE' // instrumental mode of the observation
	| 'ONTIME' // integration time during the observation
	| 'ORIENTAT' //  position angle of image y axis (deg. E of N)
	| 'PA_PNT' // position angle of the pointing
	| 'PROGRAM' // the name of the software task that created the file
	| 'RA' // R.A. of the observation
	| 'RA_NOM' // nominal R.A. of the observation
	| 'RA_OBJ' // R.A. of the observed object
	| 'RA_PNT' // R.A. of the pointed direction of the instrument
	| 'RA_SCX' // R.A. of the X spacecraft axis
	| 'RA_SCY' // R.A. of the Y spacecraft axis
	| 'RA_SCZ' // R.A. of the Z spacecraft axis
	| 'ROOTNAME' // rootname of the file
	| 'SATURATE' //  Data value at which saturation occurs
	| 'SUNANGLE' // angle between the observation and the sun
	| `TDBIN${number}` // default histogram bin size for the column
	| `TDMAX${number}` // maximum physical value in the column
	| `TDMIN${number}` // minimum physical value in the column
	| 'TELAPSE' // elapsed time of the observation
	| 'TIME-END' // time at the end of the observation
	| 'TIME-OBS' // time at the start of the observation
	| 'TITLE' // title for the observation or data
	| `TLMAX${number}` // maximum legal value in the column
	| `TLMIN${number}` // minimum legal value in the column
	| 'TSORTKEY' // defines the sort order of a table
