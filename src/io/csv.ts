import type { Source } from './io'

// CSV/TSV parsing with configurable delimiters, comment markers, and quoting. `CsvLineParser` parses one
// logical line into columns (handling quoted fields with escaped doubled quotes and embedded newlines);
// `readCsv` parses an in-memory string/array, and `readCsvStream` decodes and parses a byte Source
// incrementally as an async generator of rows.

// A single parsed CSV field.
export type CsvColumn = string

// A parsed CSV record (one row of fields).
export type CsvRow = CsvColumn[]

// Field delimiter for comma-separated values.
export const CSV_DELIMITER = ','
// Field delimiter for tab-separated values.
export const TSV_DELIMITER = '\t'

// Options controlling how a line is split into columns.
export interface CsvLineParserOptions {
	// Field delimiter(s); a single character or a set of accepted characters.
	delimiter?: string | string[]
	// Line-comment marker(s); a line starting with one is skipped.
	comment?: string | string[]
	// Quote character(s), or false to disable quoting entirely.
	quote?: string | string[] | false
	// When true, trims whitespace even inside quoted fields.
	forceTrim?: boolean
}

// Options for parsing a full CSV input.
export interface ReadCsvOptions extends CsvLineParserOptions {
	// When true, the first (header) row is parsed but not emitted.
	skipFirstLine?: boolean
}

// Options for streaming CSV parsing from a byte Source.
export interface ReadCsvStreamOptions extends ReadCsvOptions, TextDecoderOptions {
	// Text encoding passed to the TextDecoder (default 'utf-8').
	encoding?: string
	// Read buffer size in bytes for each source chunk.
	bufferSize?: number
}

// Default options for CSV parsing: comma-delimited, '#' comments, '"' quoting, header skipped, UTF-8.
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

// Mutable cursor state threaded through the column parser: current scan offset and whether the last
// field parsed was quoted.
interface ParseColumnInfo {
	offset: number
	quoted: boolean
}

// Characters treated as trimmable whitespace (a delimiter is never treated as whitespace).
const WHITESPACE = ' \t\r\n'

// Stateless (per-call) parser that splits one logical CSV line into fields per the configured options.
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

	// Parses `line` (from `offset`) into fields appended to `row` (created if omitted). Returns the row,
	// or false for an empty or comment line. Quoted fields keep embedded delimiters and doubled quotes.
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
		if (this.#isDelimiter(line.at(-1)!)) row.push('')

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
					if (segmentStart < i) text += line.slice(segmentStart, i)
					text += c
					i = next
					segmentStart = i + 1
				} else {
					options.offset = next
					// If the quote is not followed by another quote, return the quoted text
					if (text.length === 0 && segmentStart === start) return line.slice(start, i)
					if (segmentStart < i) text += line.slice(segmentStart, i)
					return text
				}
			}
		}

		options.offset = i

		if (text.length === 0 && segmentStart === start) return line.slice(start, options.offset)
		if (segmentStart < i) text += line.slice(segmentStart, i)
		return text
	}

	// Scans for the next record-terminating newline starting at `offset`, honoring quoted regions so
	// newlines inside quotes are not treated as breaks. Returns [breakIndex, nextOffset, stillQuoted];
	// breakIndex is -1 when none is found (quoted carries the open-quote state to the next chunk).
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

		return line.slice(start, info.offset)
	}

	#skipUntilDelimiter(line: string, info: ParseColumnInfo) {
		while (info.offset < line.length && !this.#isDelimiter(line[info.offset++]));
	}

	#skipIfBlank(line: string, info: ParseColumnInfo) {
		while (info.offset < line.length && this.#isWhitespace(line[info.offset])) info.offset++
	}
}

// Parses an entire CSV document (a string, or an array of lines joined with '\n') into rows.
// Empty and comment lines are skipped; quoted fields may span multiple physical lines.
export function readCsv(input: string | string[], options: string | string[] | ReadCsvOptions = DEFAULT_READ_CSV_STREAM_OPTIONS): CsvRow[] {
	input = Array.isArray(input) ? input.join('\n') : input

	let skipFirstLine = typeof options === 'object' && 'skipFirstLine' in options ? options.skipFirstLine : DEFAULT_READ_CSV_STREAM_OPTIONS.skipFirstLine
	const parser = new CsvLineParser(options)
	const rows: CsvRow[] = []

	let offset = 0
	let quoted = false

	while (offset < input.length) {
		const [index, next, nextQuoted] = parser.scanLineBreak(input, offset, quoted)
		const row = parser.parse(index >= 0 ? input.slice(offset, index) : input.slice(offset))

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

// Decode options keeping multibyte sequences intact across chunk boundaries.
const STREAM_TEXT_DECODE_OPTIONS: TextDecodeOptions = {
	stream: true,
}

// Streams CSV rows from a byte `source`, reading and decoding in chunks and yielding each parsed row as
// it becomes available. Fields and quoted regions spanning chunk boundaries are reassembled.
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
					line += offset > 0 ? decoded.slice(offset) : decoded
					quoted = nextQuoted
					break
				}

				line += decoded.slice(offset, index)

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
