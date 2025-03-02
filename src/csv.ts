export type CsvRow = string[]

export const CSV_DELIMITER = ','
export const TSV_DELIMITER = '\t'

export interface ReadCsvOptions {
	delimiter?: string | string[]
	comment?: string
	quote?: string | false
}

export const DEFAULT_READ_CSV_OPTIONS: Required<ReadCsvOptions> = {
	delimiter: CSV_DELIMITER,
	comment: '#',
	quote: '"',
}

export function readCsv(input: string | string[], options: string | string[] | ReadCsvOptions = DEFAULT_READ_CSV_OPTIONS): CsvRow[] {
	input = typeof input === 'string' ? input.split('\n') : input

	const delimiter = typeof options === 'string' || Array.isArray(options) ? options : (options.delimiter ?? DEFAULT_READ_CSV_OPTIONS.delimiter)
	options = typeof options === 'string' || Array.isArray(options) ? DEFAULT_READ_CSV_OPTIONS : options
	const quote = options.quote || DEFAULT_READ_CSV_OPTIONS.quote
	const comment = options.comment || DEFAULT_READ_CSV_OPTIONS.comment

	const rows: CsvRow[] = []

	function parseColumn(line: string, offset: number) {
		if (isQuote(line[offset])) {
			return parseQuotedColumn(line, offset + 1)
		} else {
			return parseRawColumn(line, offset)
		}
	}

	function isDelimiter(c: string) {
		return c === delimiter || delimiter.includes(c)
	}

	function isQuote(c: string) {
		return quote !== false && c === quote
	}

	function parseQuotedColumn(line: string, offset: number): readonly [string, number] {
		const start = offset
		let end = start

		for (let i = offset; i < line.length; i++) {
			const c = line[i]

			if (isQuote(c)) {
				i++

				if (i >= line.length || !isQuote(line[i])) {
					return [line.substring(start, i - 1).trim(), i - 1]
				}
			}

			end = i
		}

		return [line.substring(start, end).trim(), end]
	}

	function parseRawColumn(line: string, offset: number): readonly [string, number] {
		const start = offset
		let end = start

		for (let i = offset; i < line.length; i++) {
			const c = line[i]

			if (isDelimiter(c)) {
				return [line.substring(start, i).trim(), i]
			}

			end = i
		}

		return [line.substring(start, end + 1).trim(), end + 1]
	}

	function skipUntilDelimiter(line: string, offset: number) {
		while (offset < line.length && !isDelimiter(line[offset])) offset++
		return offset + 1
	}

	let text = ''

	for (const line of input) {
		if (!line.trim() || comment.includes(line[0])) continue

		const row: CsvRow = []

		for (let i = 0; i < line.length; ) {
			;[text, i] = parseColumn(line, i)
			row.push(text)
			i = skipUntilDelimiter(line, i)
		}

		if (row.length) {
			rows.push(row)
		}
	}

	return rows
}
