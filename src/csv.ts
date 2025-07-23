import type { Source } from './io'

export type CsvRow = string[]

export const CSV_DELIMITER = ','
export const TSV_DELIMITER = '\t'

export interface CsvLineParserOptions {
	delimiter?: string | string[]
	comment?: string | string[]
	quote?: string | string[] | false
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
}

interface ParseColumnOptions {
	offset: number
}

const WHITESPACE = ' \t\r\n'

export class CsvLineParser {
	private readonly comment: string | string[]
	private readonly isDelimiter: (c: string) => boolean
	private readonly isQuoteChar: (c: string) => boolean

	constructor(options: string | string[] | CsvLineParserOptions = DEFAULT_READ_CSV_STREAM_OPTIONS) {
		const delimiter = typeof options === 'string' || Array.isArray(options) ? options : (options.delimiter ?? DEFAULT_READ_CSV_STREAM_OPTIONS.delimiter)
		options = typeof options === 'string' || Array.isArray(options) ? DEFAULT_READ_CSV_STREAM_OPTIONS : options
		const quote = options.quote || DEFAULT_READ_CSV_STREAM_OPTIONS.quote
		this.comment = options.comment || DEFAULT_READ_CSV_STREAM_OPTIONS.comment

		if (typeof delimiter === 'string') this.isDelimiter = (c: string) => c === delimiter
		else this.isDelimiter = (c: string) => delimiter.includes(c)

		if (quote === false) this.isQuoteChar = () => false
		else if (typeof quote === 'string') this.isQuoteChar = (c: string) => c === quote
		else this.isQuoteChar = (c: string) => quote.includes(c)
	}

	parse(line: string, offset: number = 0, row?: CsvRow) {
		const options: ParseColumnOptions = { offset }

		this.skipIfBlank(line, options)

		// Skip empty lines and comment lines
		if (options.offset >= line.length || this.comment.includes(line[options.offset])) return false

		row ??= []

		// Parse the line until the end
		while (options.offset < line.length) {
			const text = this.parseColumn(line, options)
			row.push(text.trim())
			this.skipUntilDelimiter(line, options)
		}

		// If the last character is a delimiter, we need to add an empty column
		if (this.isDelimiter(line[line.length - 1])) row.push('')

		return row
	}

	private parseColumn(line: string, options: ParseColumnOptions) {
		if (this.isQuoteChar(line[options.offset])) {
			options.offset++
			// If the column starts with a quote, parse it as a quoted column
			return this.parseQuotedColumn(line, options)
		} else {
			// Otherwise, parse it as a raw column
			return this.parseRawColumn(line, options)
		}
	}

	private parseQuotedColumn(line: string, options: ParseColumnOptions) {
		const start = options.offset
		let i = start

		for (; i < line.length; i++) {
			const c = line[i]

			if (this.isQuoteChar(c)) {
				i++

				if (i >= line.length || !this.isQuoteChar(line[i])) {
					options.offset = i - 1
					// If the quote is not followed by another quote, return the quoted text
					return line.substring(start, options.offset)
				}
			}
		}

		options.offset = i

		return line.substring(start, options.offset)
	}

	private parseRawColumn(line: string, options: ParseColumnOptions) {
		const start = options.offset
		let i = start

		for (; i < line.length; i++) {
			if (this.isDelimiter(line[i])) break
		}

		options.offset = i

		return line.substring(start, options.offset)
	}

	private skipUntilDelimiter(line: string, options: ParseColumnOptions) {
		while (options.offset < line.length && !this.isDelimiter(line[options.offset++]));
	}

	private skipIfBlank(line: string, options: ParseColumnOptions) {
		while (options.offset < line.length && WHITESPACE.includes(line[options.offset])) options.offset++
	}
}

export function readCsv(input: string | string[], options: string | string[] | ReadCsvOptions = DEFAULT_READ_CSV_STREAM_OPTIONS): CsvRow[] {
	input = typeof input === 'string' ? input.split('\n') : input

	let skipFirstLine = typeof options === 'object' && 'skipFirstLine' in options ? options.skipFirstLine : DEFAULT_READ_CSV_STREAM_OPTIONS.skipFirstLine
	const parser = new CsvLineParser(options)
	const rows: CsvRow[] = []

	for (const line of input) {
		const row = parser.parse(line)

		if (row === false || row.length === 0) continue
		else if (!skipFirstLine) rows.push(row)
		else skipFirstLine = false
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

	while (true) {
		// Read a chunk of data from the source
		const n = await source.read(buffer)

		// End of stream
		if (n <= 0) {
			if (line.length === 0) break

			// Parse the line into a CSV row
			const row = parser.parse(line)

			// If the row is valid and not skipped, yield it
			if (row && row.length > 0 && !skipFirstLine) yield row

			break
		}

		// Decode the buffer to a string
		const decoded = decoder.decode(n < buffer.byteLength ? buffer.subarray(0, n) : buffer, STREAM_TEXT_DECODE_OPTIONS)

		if (decoded.length === 0) continue

		let prevIndex = 0

		while (true) {
			// Find the next newline character
			const index = decoded.indexOf('\n', prevIndex)

			if (index >= 0) {
				// If a newline character is found, split the string at that point
				line += decoded.substring(prevIndex, index)

				// Store the current index as the previous index
				prevIndex = index + 1

				// Parse the line into a CSV row
				const row = parser.parse(line)

				// Reset the line for the next iteration
				line = ''

				// If the row is valid and not skipped, yield it
				if (row === false || row.length === 0) continue
				else if (!skipFirstLine) yield row
				else skipFirstLine = false
			} else {
				// If no newline character is found, continue reading
				line += prevIndex > 0 ? decoded.substring(prevIndex) : decoded

				break
			}
		}
	}
}
