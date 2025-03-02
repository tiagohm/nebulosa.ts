import type { Mutable } from 'utility-types'
import { type Seekable, type Sink, type Source, readUntil, sourceTransferToSink } from './io'

export const FITS_IMAGE_MIME_TYPE = 'image/fits'
export const FITS_APPLICATION_MIME_TYPE = 'application/fits'

export type FitsHeaderKey = string
export type FitsHeaderValue = string | number | boolean | undefined
export type FitsHeaderComment = string | undefined
export type FitsHeaderCard = [FitsHeaderKey, FitsHeaderValue, FitsHeaderComment?]
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

export function hasKeyword(header: FitsHeader, key: FitsHeaderKey) {
	return header[key] !== undefined
}

export function numeric(header: FitsHeader, key: FitsHeaderKey, defaultValue: number = 0) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value
	else if (typeof value === 'boolean') return value ? 1 : 0
	else return parseFloat(value)
}

export function logic(header: FitsHeader, key: FitsHeaderKey, defaultValue: boolean = false) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value !== 0
	else if (typeof value === 'string') return value === 'T' || value.toLowerCase() === 'true'
	else return value
}

export function text(header: FitsHeader, key: FitsHeaderKey, defaultValue: string = '') {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'string') return value
	else return `${value}`
}

export function naxis(header: FitsHeader, defaultValue: number = 0) {
	return numeric(header, 'NAXIS', defaultValue)
}

export function width(header: FitsHeader, defaultValue: number = 0) {
	return numeric(header, 'NAXIS1', defaultValue)
}

export function height(header: FitsHeader, defaultValue: number = 0) {
	return numeric(header, 'NAXIS2', defaultValue)
}

export function numberOfChannels(header: FitsHeader, defaultValue: number = 1) {
	return numeric(header, 'NAXIS3', defaultValue)
}

export function bitpix(header: FitsHeader, defaultValue: Bitpix | 0 = 0): Bitpix | 0 {
	return numeric(header, 'BITPIX', defaultValue)
}

const MAGIC_BYTES = Buffer.from('SIMPLE', 'ascii')

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
			source.seek(data.offset)
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

function computeRemainingBytes(size: number) {
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
		let escaped = false

		const start = ++this.position

		// Build the string value, up to the end quote and paying attention to double
		// quotes inside the string, which are translated to single quotes within
		// the string value itself.
		for (; this.position < line.byteLength; this.position++) {
			if (this.isNextQuote(line)) {
				this.position++

				if (!this.isNextQuote(line)) {
					// Closing single quote
					return this.noTrailingSpaceString(line, start, this.position - 1, escaped)
				} else {
					escaped = true
				}
			}
		}

		return this.noTrailingSpaceString(line, start, this.position, escaped)
	}

	private noTrailingSpaceString(line: Buffer, start: number, end: number, escaped: boolean) {
		const text = line.toString('ascii', start, end).trimEnd()
		return escaped ? unescapeQuotedText(text) : text
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

const DEFAULT_COMMENT_ALIGN_POSITION = 30
const COMMENT_PREFIX = ' / '
const LONG_COMMENT_PREFIX = ' /'

// https://github.com/nom-tam-fits/nom-tam-fits/blob/master/src/main/java/nom/tam/fits/HeaderCardFormatter.java

export class FitsKeywordWriter {
	private position = 0

	write(card: FitsHeaderCard, output: Buffer) {
		this.position = 0
		this.appendKey(output, card)
		const valueStart = this.appendValue(output, card)
		const valueEnd = this.position
		this.appendComment(output, card)

		if (!isCommentStyleCard(card)) {
			// Strings must be left aligned with opening quote in byte 11 (counted from 1)
			this.realign(output, typeof card[1] === 'string' ? valueEnd : valueStart, valueEnd)
		}

		this.pad(output)

		return this.position
	}

	private appendKey(output: Buffer, card: FitsHeaderCard) {
		this.appendText(output, card[0])
		this.padTo(output, FITS_MAX_KEYWORD_LENGTH)
	}

	private appendValue(output: Buffer, card: FitsHeaderCard) {
		const [, value, comment] = card

		if (isCommentStyleCard(card)) {
			// Comment-style card. Nothing to do here...
			return this.position
		}

		// Add assignment sequence "= "
		this.appendText(output, '= ')

		if (value === undefined) {
			// 'null' value, nothing more to append.
			return this.position
		}

		const start = this.position

		if (typeof value === 'string') {
			let from = this.appendQuotedValue(output, value, comment, 0)

			while (from < value.length) {
				this.pad(output)
				this.appendText(output, 'CONTINUE  ')
				from += this.appendQuotedValue(output, value, comment, from)
			}
		} else if (typeof value === 'boolean') {
			this.appendText(output, value ? 'T' : 'F')
		} else if (Number.isInteger(value)) {
			this.appendText(output, value.toFixed(0))
		} else {
			this.appendText(output, value.toExponential(20).toUpperCase())
		}

		return start
	}

	private appendComment(output: Buffer, card: FitsHeaderCard) {
		const commentStyleCard = isCommentStyleCard(card)
		const comment = commentStyleCard ? card[2] || (typeof card[1] === 'string' ? card[1] : undefined) : card[2]

		if (!comment) return true

		const available = this.getAvailable() - (commentStyleCard ? 1 : COMMENT_PREFIX.length)

		this.appendText(output, commentStyleCard ? ' ' : COMMENT_PREFIX)

		if (available >= comment.length) {
			this.appendText(output, comment)
			return true
		}

		this.appendText(output, comment.substring(0, available))

		return false
	}

	private appendText(output: Buffer, text: string) {
		this.position += output.write(text, this.position, 'ascii')
	}

	private appendQuotedValue(output: Buffer, value: string, comment: FitsHeaderComment, from: number) {
		// Always leave room for an extra & character at the end...
		let available = this.getAvailable() - 2

		// If long strings are enabled leave space for '&' at the end.
		if (comment?.length && this.isLongStringsEnabled(output)) available--

		// The the remaining part of the string fits in the space with the
		// quoted quotes, then it's easy...
		if (available >= value.length - from) {
			const escaped = escapeQuotedText(from === 0 ? value : value.substring(from))

			if (escaped.length <= available) {
				this.appendText(output, "'")
				this.appendText(output, escaped)

				// Earlier versions of the FITS standard required that the closing quote
				// does not come before byte 20. It's no longer required but older tools
				// may still expect it, so let's conform. This only affects single
				// record card, but not continued long strings...
				this.padTo(output, FITS_MIN_STRING_END)

				this.appendText(output, "'")

				return value.length - from
			}
		}

		if (!this.isLongStringsEnabled(output)) {
			return value.length - from
		}

		// Now, we definitely need space for '&' at the end...
		available = this.getAvailable() - 3

		// Opening quote
		this.appendText(output, "'")

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
				this.appendText(output, "''")
			} else {
				// Append a non-quote character.
				this.appendText(output, c)
			}
		}

		// & and closing quote.
		this.appendText(output, "&'")

		return consumed
	}

	private getAvailable() {
		return (FITS_HEADER_CARD_SIZE - (this.position % FITS_HEADER_CARD_SIZE)) % FITS_HEADER_CARD_SIZE
	}

	private realign(output: Buffer, at: number, from: number) {
		if (this.position >= FITS_HEADER_CARD_SIZE || from >= DEFAULT_COMMENT_ALIGN_POSITION) {
			// We are beyond the alignment point already...
			return false
		}

		const spaces = DEFAULT_COMMENT_ALIGN_POSITION - from

		if (spaces > this.getAvailable()) {
			// No space left in card to align the the specified position.
			return false
		}

		// Shift value + comment
		for (let i = this.position - 1, k = this.position + spaces - 1; i >= at; i--, k--) {
			output.writeInt8(output.readInt8(i), k)
		}

		this.position += spaces

		// Fill
		output.fill(WHITESPACE, at, at + spaces)

		return true
	}

	private padTo(output: Buffer, to: number) {
		for (let pos = this.position % FITS_HEADER_CARD_SIZE; pos < to; pos++) {
			output.writeInt8(WHITESPACE, this.position++)
		}
	}

	private pad(output: Buffer, n: number = this.getAvailable()) {
		if (n > 0) {
			output.fill(WHITESPACE, this.position, this.position + n)
			this.position += n
		}
	}

	private isLongStringsEnabled(output: Buffer) {
		return Math.floor(output.byteLength / FITS_HEADER_CARD_SIZE) > 1
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
