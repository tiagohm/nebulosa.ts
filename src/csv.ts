import { parse } from 'csv-parse/sync'

export type CsvRow = string[]

export const CSV_DELIMITER = ','
export const TSV_DELIMITER = '\t'

export function readCsv(input: Buffer | string, delimiter: string | string[] = CSV_DELIMITER, comment: string = '#'): CsvRow[] {
	return parse(input, { columns: false, comment, delimiter })
}
