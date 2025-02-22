export type CsvRow = string[]

export interface CsvTable {
	readonly header: CsvRow
	readonly data: CsvRow[]
}

export const CSV_DELIMITER = ','
export const TSV_DELIMITER = '\t'

export function readCsv(text: string | string[], delimiter: string = CSV_DELIMITER, comment: string = '#'): CsvTable | undefined {
	let header: CsvRow = []
	const data: CsvRow[] = []

	const lines = typeof text === 'string' ? text.split('\n') : text

	for (const line of lines) {
		const item = parseCsvLine(line, delimiter, comment)

		if (item) {
			if (!header.length) {
				header = item
			} else {
				data.push(item)
			}
		}
	}

	return { header, data }
}

const DOUBLE_QUOTE = '"'
const IDLE = -1
const SIMPLE_COLUMN = 0
const QUOTED_COLUMN = 1
const END = 2

export function parseCsvLine(line: string, delimiter: string = CSV_DELIMITER, comment: string = '#') {
	if (!line || comment.includes(line[0])) return undefined

	let state = IDLE
	let start = -1
	let end = -1
	const ret: string[] = []
	const length = line.length - 1

	for (let i = 0; i <= length; i++) {
		const c = line[i]

		switch (state) {
			case IDLE: {
				state = c === DOUBLE_QUOTE ? QUOTED_COLUMN : SIMPLE_COLUMN
				start = i
				end = start + 1
				break
			}
			case SIMPLE_COLUMN: {
				if (delimiter.includes(c)) {
					state = END
				} else {
					end++
				}

				break
			}
			case QUOTED_COLUMN: {
				if (c === DOUBLE_QUOTE) {
					start++
					state = SIMPLE_COLUMN
				} else {
					end++
				}

				break
			}
		}

		if (state === END || i === length) {
			ret.push(line.substring(start, end))
			start = end = -1
			state = IDLE
		}
	}

	return ret
}
