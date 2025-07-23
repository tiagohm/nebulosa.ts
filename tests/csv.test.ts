import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { type CsvRow, type ReadCsvStreamOptions, readCsv, readCsvStream, TSV_DELIMITER } from '../src/csv'
import { bufferSource, fileHandleSource } from '../src/io'

const TSV = 'HIP\tRA\tDEC\tMAG\n1\t00 00 00.22\t+01 05 20.4\t9.10\n2\t00 00 00.91\t-19 29 55.8\t9.27'
const TSV_WITH_EMPTY_COLUMN = 'HIP\tRA\tDEC\tMAG\t\n1\t00 00 00.22\t+01 05 20.4\t9.10\t\n2\t00 00 00.91\t-19 29 55.8\t9.27\t'
const TSV_WITH_SPACED_COLUMNS = ' HIP\tRA\tDEC\tMAG\n 1 \t 00 00 00.22 \t +01 05 20.4 \t 9.10 \n 2 \t 00 00 00.91 \t -19 29 55.8 \t 9.27 '
const CSV_QUOTED = `"HIP","RA","DEC","MAG"\n"1","00 00 00.22","+01 05 20.4","9.10"\n"2","00 00 00.91","-19 29 55.8","9.27"`
const CSV = TSV.replace(/\t/g, ', ')
const CSV_WITH_COMMENTS = `# This is a comment\n# Another comment\n${CSV}\n# Yet another comment`
const CSV_WITH_EMPTY_LINES_AT_END = `${CSV}\n \n\n`

async function readCsvAndTest(input: string | Buffer, options?: string | ReadCsvStreamOptions) {
	let data: CsvRow[] = []

	if (typeof input === 'string') {
		data = readCsv(input, options)
	} else {
		for await (const row of readCsvStream(bufferSource(input), options)) {
			data.push(row)
		}
	}

	const empty = data[0].length === 5 ? [''] : []

	if (!options || typeof options === 'string' || options.skipFirstLine !== false) {
		expect(data).toHaveLength(2)
		expect(data[0]).toEqual(['1', '00 00 00.22', '+01 05 20.4', '9.10', ...empty])
		expect(data[1]).toEqual(['2', '00 00 00.91', '-19 29 55.8', '9.27', ...empty])
	} else {
		expect(data).toHaveLength(3)
		expect(data[0]).toEqual(['HIP', 'RA', 'DEC', 'MAG'])
		expect(data[1]).toEqual(['1', '00 00 00.22', '+01 05 20.4', '9.10', ...empty])
		expect(data[2]).toEqual(['2', '00 00 00.91', '-19 29 55.8', '9.27', ...empty])
	}
}

describe('linux', () => {
	test('tsv', async () => {
		await readCsvAndTest(TSV, TSV_DELIMITER)
	})

	test('tsv without skip first line', async () => {
		await readCsvAndTest(TSV, { skipFirstLine: false, delimiter: TSV_DELIMITER })
	})

	test('csv without skip first line', async () => {
		await readCsvAndTest(CSV, { skipFirstLine: false })!
	})

	test('csv with comments', async () => {
		await readCsvAndTest(CSV_WITH_COMMENTS)!
	})

	test('csv with quoted columns', async () => {
		await readCsvAndTest(CSV_QUOTED)!
	})

	test('tsv with empty column', async () => {
		await readCsvAndTest(TSV_WITH_EMPTY_COLUMN, TSV_DELIMITER)!
	})

	test('csv with empty lines at end', async () => {
		await readCsvAndTest(CSV_WITH_EMPTY_LINES_AT_END)!
	})

	test('tsv with spaced columns', async () => {
		await readCsvAndTest(TSV_WITH_SPACED_COLUMNS, { delimiter: TSV_DELIMITER })
	})
})

describe('windows', () => {
	test('tsv', async () => {
		await readCsvAndTest(TSV.replace(/\n/g, '\r\n'), TSV_DELIMITER)
	})

	test('tsv without skip first line', async () => {
		await readCsvAndTest(TSV.replace(/\n/g, '\r\n'), { skipFirstLine: false, delimiter: TSV_DELIMITER })
	})

	test('csv without skip first line', async () => {
		await readCsvAndTest(CSV.replace(/\n/g, '\r\n'), { skipFirstLine: false })!
	})

	test('csv with comments', async () => {
		await readCsvAndTest(CSV_WITH_COMMENTS.replace(/\n/g, '\r\n'))!
	})

	test('csv with quoted columns', async () => {
		await readCsvAndTest(CSV_QUOTED.replace(/\n/g, '\r\n'))!
	})

	test('tsv with empty column', async () => {
		await readCsvAndTest(TSV_WITH_EMPTY_COLUMN.replace(/\n/g, '\r\n'), TSV_DELIMITER)!
	})

	test('csv with empty lines at end', async () => {
		await readCsvAndTest(CSV_WITH_EMPTY_LINES_AT_END.replace(/\n/g, '\r\n'))!
	})

	test('tsv with spaced columns', async () => {
		await readCsvAndTest(TSV_WITH_SPACED_COLUMNS.replace(/\n/g, '\r\n'), { delimiter: TSV_DELIMITER })
	})
})

describe('stream', () => {
	test('tsv', async () => {
		await readCsvAndTest(Buffer.from(TSV), TSV_DELIMITER)
	})

	test('tsv without skip first line', async () => {
		await readCsvAndTest(Buffer.from(TSV), { skipFirstLine: false, delimiter: TSV_DELIMITER })
	})

	test('csv without skip first line', async () => {
		await readCsvAndTest(Buffer.from(CSV), { skipFirstLine: false })!
	})

	test('csv with comments', async () => {
		await readCsvAndTest(Buffer.from(CSV_WITH_COMMENTS))!
	})

	test('csv with quoted columns', async () => {
		await readCsvAndTest(Buffer.from(CSV_QUOTED))!
	})

	test('tsv with empty column', async () => {
		await readCsvAndTest(Buffer.from(TSV_WITH_EMPTY_COLUMN), TSV_DELIMITER)!
	})

	test('csv with empty lines at end', async () => {
		await readCsvAndTest(Buffer.from(CSV_WITH_EMPTY_LINES_AT_END))!
	})

	test('tsv with spaced columns', async () => {
		await readCsvAndTest(Buffer.from(TSV_WITH_SPACED_COLUMNS), { delimiter: TSV_DELIMITER })
	})

	test('tsv with different buffer size', async () => {
		for (let i = 1; i <= 128; i++) {
			await readCsvAndTest(Buffer.from(TSV), { delimiter: TSV_DELIMITER, bufferSize: i })
		}
	})
})

test('IAU-CSN', async () => {
	const rows: CsvRow[] = []

	for await (const row of readCsvStream(fileHandleSource(await fs.open('data/IAU-CSN.tsv', 'r')), { delimiter: TSV_DELIMITER, skipFirstLine: false })) {
		rows.push(row)
	}

	expect(rows).toHaveLength(452)
	expect(rows[0]).toEqual(['Name/ASCII', 'Name/Diacritics', 'Designation', 'ID', 'ID/Diacritics', 'Con', '#', 'WDS_J', 'mag', 'bnd', 'HIP', 'HD', 'RA(J2000)', 'Dec(J2000)', 'Date', 'notes'])
	expect(rows[451]).toEqual(['Zubeneschamali', 'Zubeneschamali', 'HR 5685', 'bet', 'β', 'Lib', '_', '_', '2.61', 'V', '74785', '135742', '229.251724', '-9.382914', '2016-08-21', ''])
})
