import { expect, test } from 'bun:test'
import { TSV_DELIMITER, readCsv } from '../src/csv'

const text = `
# Ephemeris for Moon
"Year","Month","Day","Time","Age of Moon","RA h","RA m","Ra s","DEC deg","DEC m","DEC s","Rise","Culm","Set","Approx","Observable","Constellation"
2025,Feb,21,21:00 GMT-03,24 days,17,03,29,-27,59,46,23:26,06:24,13:25,-11.6,00:05 until 05:36,Ophiuchus
"2025","Mar",17,21:00 GMT-03,"18\tdays",14,"16","54","-17",21,51,"19:34","02:01",08:35,"-12.4",20:09 until 05:47,"Virgo"
# Ephemeris computed by Dominic Ford.
# <https://in-the-sky.org/>
`

test('csv', () => {
	const [header, ...data] = readCsv(text)!

	expect(header).toHaveLength(17)
	expect(header).toEqual(['Year', 'Month', 'Day', 'Time', 'Age of Moon', 'RA h', 'RA m', 'Ra s', 'DEC deg', 'DEC m', 'DEC s', 'Rise', 'Culm', 'Set', 'Approx', 'Observable', 'Constellation'])
	expect(data).toHaveLength(2)
	expect(data[0]).toEqual(['2025', 'Feb', '21', '21:00 GMT-03', '24 days', '17', '03', '29', '-27', '59', '46', '23:26', '06:24', '13:25', '-11.6', '00:05 until 05:36', 'Ophiuchus'])
	expect(data[1]).toEqual(['2025', 'Mar', '17', '21:00 GMT-03', '18\tdays', '14', '16', '54', '-17', '21', '51', '19:34', '02:01', '08:35', '-12.4', '20:09 until 05:47', 'Virgo'])
})

test('tsv', () => {
	const [header, ...data] = readCsv(text.replaceAll(',', '\t'), TSV_DELIMITER)!

	expect(header).toHaveLength(17)
	expect(header).toEqual(['Year', 'Month', 'Day', 'Time', 'Age of Moon', 'RA h', 'RA m', 'Ra s', 'DEC deg', 'DEC m', 'DEC s', 'Rise', 'Culm', 'Set', 'Approx', 'Observable', 'Constellation'])
	expect(data).toHaveLength(2)
	expect(data[0]).toEqual(['2025', 'Feb', '21', '21:00 GMT-03', '24 days', '17', '03', '29', '-27', '59', '46', '23:26', '06:24', '13:25', '-11.6', '00:05 until 05:36', 'Ophiuchus'])
	expect(data[1]).toEqual(['2025', 'Mar', '17', '21:00 GMT-03', '18\tdays', '14', '16', '54', '-17', '21', '51', '19:34', '02:01', '08:35', '-12.4', '20:09 until 05:47', 'Virgo'])
})

test('windows', () => {
	const [header, ...data] = readCsv(text.replaceAll('\n', '\r\n'))!

	expect(header).toHaveLength(17)
	expect(header).toEqual(['Year', 'Month', 'Day', 'Time', 'Age of Moon', 'RA h', 'RA m', 'Ra s', 'DEC deg', 'DEC m', 'DEC s', 'Rise', 'Culm', 'Set', 'Approx', 'Observable', 'Constellation'])
	expect(data).toHaveLength(2)
	expect(data[0]).toEqual(['2025', 'Feb', '21', '21:00 GMT-03', '24 days', '17', '03', '29', '-27', '59', '46', '23:26', '06:24', '13:25', '-11.6', '00:05 until 05:36', 'Ophiuchus'])
	expect(data[1]).toEqual(['2025', 'Mar', '17', '21:00 GMT-03', '18\tdays', '14', '16', '54', '-17', '21', '51', '19:34', '02:01', '08:35', '-12.4', '20:09 until 05:47', 'Virgo'])
})
