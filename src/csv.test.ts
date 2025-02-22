import { expect, test } from 'bun:test'
import { readCsv } from './csv'

test('csv', async () => {
	const file = Bun.file('data/ephemeris.csv')
	const csv = readCsv(await file.text())!

	expect(csv.header).toHaveLength(17)
	expect(csv.header).toEqual(['Year', 'Month', 'Day', 'Time', 'Age of Moon', 'RA h', 'RA m', 'Ra s', 'DEC deg', 'DEC m', 'DEC s', 'Rise', 'Culm', 'Set', 'Approx', 'Observable', 'Constellation'])
	expect(csv.data).toHaveLength(25)
	expect(csv.data[0]).toHaveLength(17)
	expect(csv.data[0]).toEqual(['2025', 'Feb', '21', '21:00 GMT-03', '24 days', '17', '03', '29', '-27', '59', '46', '23:26', '06:24', '13:25', '-11.6', '00:05 until 05:36', 'Ophiuchus'])
	expect(csv.data[24]).toEqual(['2025', 'Mar', '17', '21:00 GMT-03', '18 days', '14', '16', '54', '-17', '21', '51', '19:34', '02:01', '08:35', '-12.4', '20:09 until 05:47', 'Virgo'])
})
