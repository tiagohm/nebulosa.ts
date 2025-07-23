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

test('hygdata_v41', async () => {
	const data: CsvRow[] = []
	const source = fileHandleSource(await fs.open('data/hygdata_v41.csv', 'r'))

	for await (const row of readCsvStream(source, { skipFirstLine: false })) {
		data.push(row)
	}

	expect(data).toHaveLength(119627)
	for (let i = 0; i < data.length; i++) expect(data[i]).toHaveLength(37)
	expect(data[0]).toEqual(['id', 'hip', 'hd', 'hr', 'gl', 'bf', 'proper', 'ra', 'dec', 'dist', 'pmra', 'pmdec', 'rv', 'mag', 'absmag', 'spect', 'ci', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'rarad', 'decrad', 'pmrarad', 'pmdecrad', 'bayer', 'flam', 'con', 'comp', 'comp_primary', 'base', 'lum', 'var', 'var_min', 'var_max'])
	expect(data[1]).toEqual(['0', '', '', '', '', '', 'Sol', '0.0', '0.0', '0.0', '0.0', '0.0', '0.0', '-26.7', '4.85', 'G2V', '0.656', '0.000005', '0.0', '0.0', '0.0', '0.0', '0.0', '0.0', '0.0', '0.0', '0.0', '', '', '', '1', '0', '', '1.0', '', '', ''])
	// biome-ignore format: too long!
	expect(data[119626]).toEqual(['119630', '', '224960', '9090', '', '', '', '0.03536111', '-14.67611111', '100000.0', '-13.0', '-16.0', '13.0', '7.1', '-12.9', 'S7.3e', '', '96733.2018040608', '895.53483839403', '-25335.4630130983', '0.0', '0.0', '0.0', '0.00925752', '-0.25614646', '-0.0000000630257785', '-0.00000007', '', '', 'Cet', '1', '119630', '', '12589254.1179417', 'W', '14.8', '7.1'])
})
