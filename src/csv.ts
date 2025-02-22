export type CsvRow = string[]

export interface CsvTable {
	readonly header: CsvRow
	readonly data: CsvRow[]
}

export interface ReadCsvOptions {
    delimiter?: string
}

export const CSV_DELIMITER = ','
export const TSV_DELIMITER = '\t'

export function readCsv(text: string | string[], delimiter: string = CSV_DELIMITER): CsvTable | undefined {
	let header: CsvRow = []
	const data: CsvRow[] = []

	const lines = typeof text === 'string' ? text.split('\n') : text

	if (lines.length) {
		for (const line of lines) {
			if (line.startsWith('#') || !line.length) continue

			const item = line.split(delimiter)
			item.forEach((e, i) => (item[i] = escapeQuote(e)))

			if (!header.length) {
				header = item
			} else {
				data.push(item)
			}
		}
	}

	return { header, data }
}

function escapeQuote(item: string) {
	return item.startsWith('"') && item.endsWith('"') ? item.substring(1, item.length - 1).trim() : item
}
