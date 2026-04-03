import type { Source } from './io'

export type CsvColumn = string

export type CsvRow = CsvColumn[]

export const CSV_DELIMITER = ','
export const TSV_DELIMITER = '\t'

export interface CsvLineParserOptions {
	delimiter?: string | string[]
	comment?: string | string[]
	quote?: string | string[] | false
	forceTrim?: boolean
}

export interface ReadCsvOptions extends CsvLineParserOptions {
	skipFirstLine?: boolean
}

export interface ReadCsvStreamOptions extends ReadCsvOptions, TextDecoderOptions {
	encoding?: string
	bufferSize?: number
}

export const DEFAULT_READ_CSV_STREAM_OPTIONS: Readonly<Required<ReadCsvStreamOptions>> = {
	delimiter: CSV_DELIMITER,
	comment: '#',
	quote: '"',
	skipFirstLine: true,
	encoding: 'utf-8',
	ignoreBOM: true,
	fatal: false,
	bufferSize: 1024 * 8,
	forceTrim: true,
}

interface ParseColumnInfo {
	offset: number
	quoted: boolean
}

const WHITESPACE = ' \t\r\n'

export class CsvLineParser {
	readonly #comment: string | string[]
	readonly #isDelimiter: (c: string) => boolean
	readonly #isQuoteChar: (c: string) => boolean
	readonly #isWhitespace: (c: string) => boolean
	readonly #forceTrim: boolean

	constructor(options: string | string[] | CsvLineParserOptions = DEFAULT_READ_CSV_STREAM_OPTIONS) {
		const delimiter = typeof options === 'string' || Array.isArray(options) ? options : (options.delimiter ?? DEFAULT_READ_CSV_STREAM_OPTIONS.delimiter)
		options = typeof options === 'string' || Array.isArray(options) ? DEFAULT_READ_CSV_STREAM_OPTIONS : options
		const quote = options.quote ?? DEFAULT_READ_CSV_STREAM_OPTIONS.quote
		this.#comment = options.comment ?? DEFAULT_READ_CSV_STREAM_OPTIONS.comment
		this.#forceTrim = options.forceTrim ?? false

		if (typeof delimiter === 'string') this.#isDelimiter = (c) => c === delimiter
		else this.#isDelimiter = (c) => delimiter.includes(c)

		if (quote === false) this.#isQuoteChar = () => false
		else if (typeof quote === 'string') this.#isQuoteChar = (c) => c === quote
		else this.#isQuoteChar = (c) => quote.includes(c)

		this.#isWhitespace = (c) => !this.#isDelimiter(c) && WHITESPACE.includes(c)
	}

	parse(line: string, offset: number = 0, row?: CsvRow) {
		const info: ParseColumnInfo = { offset, quoted: false }

		this.#skipIfBlank(line, info)

		// Skip empty lines and comment lines
		if (info.offset >= line.length || this.#comment.includes(line[info.offset])) return false

		row ??= []

		// Parse the line until the end
		while (info.offset < line.length) {
			const start = info.offset
			this.#skipIfBlank(line, info)

			if (info.offset >= line.length) {
				row.push('')
				break
			}

			if (start < info.offset && this.#isDelimiter(line[info.offset])) {
				row.push('')
				this.#skipUntilDelimiter(line, info)
				continue
			}

			const text = this.#parseColumn(line, info)
			row.push(info.quoted && !this.#forceTrim ? text : text.trim())
			this.#skipUntilDelimiter(line, info)
		}

		// If the last character is a delimiter, we need to add an empty column
		if (this.#isDelimiter(line[line.length - 1])) row.push('')

		return row
	}

	#parseColumn(line: string, info: ParseColumnInfo) {
		info.quoted = false

		if (this.#isQuoteChar(line[info.offset])) {
			info.quoted = true
			info.offset++
			// If the column starts with a quote, parse it as a quoted column
			return this.#parseQuotedColumn(line, info)
		} else {
			// Otherwise, parse it as a raw column
			return this.#parseRawColumn(line, info)
		}
	}

	#parseQuotedColumn(line: string, options: ParseColumnInfo) {
		const start = options.offset
		let segmentStart = start
		let i = start
		let text = ''

		for (; i < line.length; i++) {
			const c = line[i]

			if (this.#isQuoteChar(c)) {
				const next = i + 1

				if (next < line.length && this.#isQuoteChar(line[next])) {
					if (segmentStart < i) text += line.substring(segmentStart, i)
					text += c
					i = next
					segmentStart = i + 1
				} else {
					options.offset = next
					// If the quote is not followed by another quote, return the quoted text
					if (!text.length && segmentStart === start) return line.substring(start, i)
					if (segmentStart < i) text += line.substring(segmentStart, i)
					return text
				}
			}
		}

		options.offset = i

		if (!text.length && segmentStart === start) return line.substring(start, options.offset)
		if (segmentStart < i) text += line.substring(segmentStart, i)
		return text
	}

	scanLineBreak(line: string, offset: number = 0, quoted: boolean = false) {
		let i = offset

		for (; i < line.length; i++) {
			const c = line[i]

			if (this.#isQuoteChar(c)) {
				if (quoted && i + 1 < line.length && this.#isQuoteChar(line[i + 1])) {
					i++
				} else {
					quoted = !quoted
				}
			} else if (!quoted && (c === '\n' || c === '\r')) {
				if (c === '\r' && i + 1 < line.length && line[i + 1] === '\n') {
					return [i, i + 2, false] as const
				}

				return [i, i + 1, false] as const
			}
		}

		return [-1, i, quoted] as const
	}

	#parseRawColumn(line: string, info: ParseColumnInfo) {
		const start = info.offset
		let i = start

		for (; i < line.length; i++) {
			if (this.#isDelimiter(line[i])) break
		}

		info.offset = i

		return line.substring(start, info.offset)
	}

	#skipUntilDelimiter(line: string, info: ParseColumnInfo) {
		while (info.offset < line.length && !this.#isDelimiter(line[info.offset++]));
	}

	#skipIfBlank(line: string, info: ParseColumnInfo) {
		while (info.offset < line.length && this.#isWhitespace(line[info.offset])) info.offset++
	}
}

export function readCsv(input: string | string[], options: string | string[] | ReadCsvOptions = DEFAULT_READ_CSV_STREAM_OPTIONS): CsvRow[] {
	input = Array.isArray(input) ? input.join('\n') : input

	let skipFirstLine = typeof options === 'object' && 'skipFirstLine' in options ? options.skipFirstLine : DEFAULT_READ_CSV_STREAM_OPTIONS.skipFirstLine
	const parser = new CsvLineParser(options)
	const rows: CsvRow[] = []

	let offset = 0
	let quoted = false

	while (offset < input.length) {
		const [index, next, nextQuoted] = parser.scanLineBreak(input, offset, quoted)
		const row = parser.parse(index >= 0 ? input.substring(offset, index) : input.substring(offset))

		if (index >= 0) {
			offset = next
			quoted = nextQuoted
		}

		if (row === false || row.length === 0) {
			if (index < 0) break
			continue
		} else if (!skipFirstLine) rows.push(row)
		else skipFirstLine = false

		if (index < 0) break
	}

	return rows
}

const STREAM_TEXT_DECODE_OPTIONS: TextDecodeOptions = {
	stream: true,
}

export async function* readCsvStream(source: Source, options: string | string[] | ReadCsvStreamOptions = DEFAULT_READ_CSV_STREAM_OPTIONS) {
	const parser = new CsvLineParser(options)

	const encoding = typeof options === 'object' && 'encoding' in options ? options.encoding : 'utf-8'
	const bufferSize = typeof options === 'object' && 'bufferSize' in options && options.bufferSize ? options.bufferSize : DEFAULT_READ_CSV_STREAM_OPTIONS.bufferSize
	let skipFirstLine = typeof options === 'object' && 'skipFirstLine' in options ? options.skipFirstLine : DEFAULT_READ_CSV_STREAM_OPTIONS.skipFirstLine
	const textDecoderOptions = typeof options === 'object' && !Array.isArray(options) ? options : undefined

	const buffer = Buffer.allocUnsafe(bufferSize)
	const decoder = new TextDecoder(encoding, textDecoderOptions)
	let line = ''
	let quoted = false

	while (true) {
		// Read a chunk of data from the source
		const n = await source.read(buffer)

		// Decode the buffer to a string
		const decoded = n > 0 ? decoder.decode(n < buffer.byteLength ? buffer.subarray(0, n) : buffer, STREAM_TEXT_DECODE_OPTIONS) : decoder.decode()

		if (decoded.length > 0) {
			let offset = 0

			while (offset < decoded.length) {
				const [index, next, nextQuoted] = parser.scanLineBreak(decoded, offset, quoted)

				if (index < 0) {
					line += offset > 0 ? decoded.substring(offset) : decoded
					quoted = nextQuoted
					break
				}

				line += decoded.substring(offset, index)

				// Parse the line into a CSV row
				const row = parser.parse(line)

				// Reset the line for the next iteration
				line = ''
				offset = next
				quoted = nextQuoted

				// If the row is valid and not skipped, yield it
				if (row === false || row.length === 0) continue
				else if (!skipFirstLine) yield row
				else skipFirstLine = false
			}
		}

		// End of stream
		if (n <= 0) break
	}

	if (line.length > 0) {
		// Parse the line into a CSV row
		const row = parser.parse(line)

		// If the row is valid and not skipped, yield it
		if (row && row.length > 0 && !skipFirstLine) yield row
	}
}
