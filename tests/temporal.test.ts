import { describe, expect, test } from 'bun:test'
// biome-ignore format: too long!
import { DATE_FORMAT, daysInMonth, formatTemporal, formatTemporalFromPattern, isLeapYear, parseTemporal, TIME_FORMAT, temporalAdd, temporalDayOfWeek, temporalEndOfDay, temporalFromDate, temporalFromTime, temporalGet, temporalSet, temporalStartOfDay, temporalSubtract, temporalToDate } from '../src/temporal'
import { timeYMDHMS } from '../src/time'

test('is leap year', () => {
	expect(isLeapYear(2020)).toBe(true)
	expect(isLeapYear(2021)).toBe(false)
	expect(isLeapYear(1900)).toBe(false)
	expect(isLeapYear(1970)).toBe(false)
	expect(isLeapYear(2000)).toBe(true)
	expect(isLeapYear(2400)).toBe(true)
})

test('temporal from date', () => {
	expect(temporalFromDate(1970, 1, 1, 0, 0, 0, 0)).toBe(0)
	expect(temporalFromDate(1970, 1, 1, 0, 0, 0, 1)).toBe(1)
	expect(temporalFromDate(1970, 1, 1, 0, 0, 1, 0)).toBe(1000)
	expect(temporalFromDate(1970, 1, 1, 0, 1, 0, 0)).toBe(60000)
	expect(temporalFromDate(1970, 1, 1, 1, 0, 0, 0)).toBe(3600000)
	expect(temporalFromDate(1970, 1, 2, 0, 0, 0, 0)).toBe(86400000)
	expect(temporalFromDate(1970, 2, 28, 0, 0, 0, 0)).toBe(5011200000)
	expect(temporalFromDate(2024, 2, 29, 12, 34, 56, 0)).toBe(1709210096000)
	expect(temporalFromDate(2023, 3, 1, 12, 34, 56, 0)).toBe(1677674096000)
	expect(temporalFromDate(2025, 8, 29, 23, 34, 58, 123)).toBe(1756510498123)
	expect(temporalFromDate(2026, 8, 29, 23, 34, 58, 123)).toBe(1788046498123)

	let ms = temporalFromDate(2020, 1, 1, 0, 0, 0, 789)

	for (let y = 2020; y < 2028; y++) {
		for (let mo = 1; mo <= 12; mo++) {
			const nd = daysInMonth(y, mo)

			for (let d = 1; d <= nd; d++) {
				for (let h = 0; h < 24; h++, ms += 1000 * 60 * 60) {
					expect(temporalFromDate(y, mo, d, h, 0, 0, 789)).toBe(ms)
				}
			}
		}
	}
})

test('temporal to date', () => {
	expect(temporalToDate(0)).toEqual([1970, 1, 1, 0, 0, 0, 0])
	expect(temporalToDate(1)).toEqual([1970, 1, 1, 0, 0, 0, 1])
	expect(temporalToDate(1000)).toEqual([1970, 1, 1, 0, 0, 1, 0])
	expect(temporalToDate(60000)).toEqual([1970, 1, 1, 0, 1, 0, 0])
	expect(temporalToDate(3600000)).toEqual([1970, 1, 1, 1, 0, 0, 0])
	expect(temporalToDate(86400000)).toEqual([1970, 1, 2, 0, 0, 0, 0])
	expect(temporalToDate(5011200000)).toEqual([1970, 2, 28, 0, 0, 0, 0])
	expect(temporalToDate(-5011200000)).toEqual([1969, 11, 4, 0, 0, 0, 0])
	expect(temporalToDate(1709210096000)).toEqual([2024, 2, 29, 12, 34, 56, 0])
	expect(temporalToDate(1677674096000)).toEqual([2023, 3, 1, 12, 34, 56, 0])
	expect(temporalToDate(1756510498123)).toEqual([2025, 8, 29, 23, 34, 58, 123])
	expect(temporalToDate(1788046498123)).toEqual([2026, 8, 29, 23, 34, 58, 123])
	// expect(temporalToDate(-1788046498123)).toEqual([1913, 5, 5, 0, 25, 1, 877])

	let ms = temporalFromDate(2020, 1, 1, 0, 0, 0, 456)

	for (let y = 2020; y < 2028; y++) {
		for (let mo = 1; mo <= 12; mo++) {
			const nd = daysInMonth(y, mo)

			for (let d = 1; d <= nd; d++) {
				for (let h = 0; h < 24; h++, ms += 1000 * 60 * 60) {
					expect(temporalToDate(ms)).toEqual([y, mo, d, h, 0, 0, 456])
				}
			}
		}
	}
})

test('temporal from time', () => {
	const time = timeYMDHMS(2024, 2, 29, 12, 34, 56.789)
	expect(temporalFromTime(time)).toBe(1709210096789)
	expect(temporalToDate(temporalFromTime(time))).toEqual([2024, 2, 29, 12, 34, 56, 789])
})

describe('add', () => {
	test('start of year', () => {
		const date = 1738193698123
		expect(temporalToDate(temporalAdd(date, 1, 'ms'))).toEqual([2025, 1, 29, 23, 34, 58, 124])
		expect(temporalToDate(temporalAdd(date, 1, 's'))).toEqual([2025, 1, 29, 23, 34, 59, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'm'))).toEqual([2025, 1, 29, 23, 35, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'h'))).toEqual([2025, 1, 30, 0, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'd'))).toEqual([2025, 1, 30, 23, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'mo'))).toEqual([2025, 2, 28, 23, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'y'))).toEqual([2026, 1, 29, 23, 34, 58, 123])
	})

	test('mid of year', () => {
		const date = 1756510498123
		expect(temporalToDate(temporalAdd(date, 1, 'ms'))).toEqual([2025, 8, 29, 23, 34, 58, 124])
		expect(temporalToDate(temporalAdd(date, 1, 's'))).toEqual([2025, 8, 29, 23, 34, 59, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'm'))).toEqual([2025, 8, 29, 23, 35, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'h'))).toEqual([2025, 8, 30, 0, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'd'))).toEqual([2025, 8, 30, 23, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'mo'))).toEqual([2025, 9, 29, 23, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'y'))).toEqual([2026, 8, 29, 23, 34, 58, 123])
	})

	test('end of year', () => {
		const date = 1767051298123
		expect(temporalToDate(temporalAdd(date, 1, 'ms'))).toEqual([2025, 12, 29, 23, 34, 58, 124])
		expect(temporalToDate(temporalAdd(date, 1, 's'))).toEqual([2025, 12, 29, 23, 34, 59, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'm'))).toEqual([2025, 12, 29, 23, 35, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'h'))).toEqual([2025, 12, 30, 0, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'd'))).toEqual([2025, 12, 30, 23, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'mo'))).toEqual([2026, 1, 29, 23, 34, 58, 123])
		expect(temporalToDate(temporalAdd(date, 1, 'y'))).toEqual([2026, 12, 29, 23, 34, 58, 123])
	})
})

describe('subtract', () => {
	test('start of year', () => {
		const date = 1738193698123
		expect(temporalToDate(temporalSubtract(date, 1, 'ms'))).toEqual([2025, 1, 29, 23, 34, 58, 122])
		expect(temporalToDate(temporalSubtract(date, 1, 's'))).toEqual([2025, 1, 29, 23, 34, 57, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'm'))).toEqual([2025, 1, 29, 23, 33, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'h'))).toEqual([2025, 1, 29, 22, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'd'))).toEqual([2025, 1, 28, 23, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'mo'))).toEqual([2024, 12, 29, 23, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'y'))).toEqual([2024, 1, 29, 23, 34, 58, 123])
	})

	test('mid of year', () => {
		const date = 1756510498123
		expect(temporalToDate(temporalSubtract(date, 1, 'ms'))).toEqual([2025, 8, 29, 23, 34, 58, 122])
		expect(temporalToDate(temporalSubtract(date, 1, 's'))).toEqual([2025, 8, 29, 23, 34, 57, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'm'))).toEqual([2025, 8, 29, 23, 33, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'h'))).toEqual([2025, 8, 29, 22, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'd'))).toEqual([2025, 8, 28, 23, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'mo'))).toEqual([2025, 7, 29, 23, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'y'))).toEqual([2024, 8, 29, 23, 34, 58, 123])
	})

	test('end of year', () => {
		const date = 1767051298123
		expect(temporalToDate(temporalSubtract(date, 1, 'ms'))).toEqual([2025, 12, 29, 23, 34, 58, 122])
		expect(temporalToDate(temporalSubtract(date, 1, 's'))).toEqual([2025, 12, 29, 23, 34, 57, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'm'))).toEqual([2025, 12, 29, 23, 33, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'h'))).toEqual([2025, 12, 29, 22, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'd'))).toEqual([2025, 12, 28, 23, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'mo'))).toEqual([2025, 11, 29, 23, 34, 58, 123])
		expect(temporalToDate(temporalSubtract(date, 1, 'y'))).toEqual([2024, 12, 29, 23, 34, 58, 123])
	})
})

test('start of day', () => {
	expect(temporalToDate(temporalStartOfDay(1709210096000))).toEqual([2024, 2, 29, 0, 0, 0, 0])
	expect(temporalToDate(temporalStartOfDay(1756510498123))).toEqual([2025, 8, 29, 0, 0, 0, 0])
})

test('end of day', () => {
	expect(temporalToDate(temporalEndOfDay(1709210096000))).toEqual([2024, 2, 29, 23, 59, 59, 999])
	expect(temporalToDate(temporalEndOfDay(1756510498123))).toEqual([2025, 8, 29, 23, 59, 59, 999])
})

test('day of week', () => {
	expect(temporalDayOfWeek(1709210096000)).toBe(4)
	expect(temporalDayOfWeek(1756510498123)).toBe(5)
})

test('get', () => {
	expect(temporalGet(1709210096000, 'y')).toBe(2024)
	expect(temporalGet(1709210096000, 'mo')).toBe(2)
	expect(temporalGet(1709210096000, 'd')).toBe(29)
	expect(temporalGet(1709210096000, 'h')).toBe(12)
	expect(temporalGet(1709210096000, 'm')).toBe(34)
	expect(temporalGet(1709210096000, 's')).toBe(56)
	expect(temporalGet(1709210096128, 'ms')).toBe(128)
})

test('set', () => {
	const date = 1756510498123
	expect(temporalToDate(temporalSet(date, 1, 'ms'))).toEqual([2025, 8, 29, 23, 34, 58, 1])
	expect(temporalToDate(temporalSet(date, 0, 's'))).toEqual([2025, 8, 29, 23, 34, 0, 123])
	expect(temporalToDate(temporalSet(date, 59, 'm'))).toEqual([2025, 8, 29, 23, 59, 58, 123])
	expect(temporalToDate(temporalSet(date, 12, 'h'))).toEqual([2025, 8, 29, 12, 34, 58, 123])
	expect(temporalToDate(temporalSet(date, 1, 'd'))).toEqual([2025, 8, 1, 23, 34, 58, 123])
	expect(temporalToDate(temporalSet(date, 12, 'mo'))).toEqual([2025, 12, 29, 23, 34, 58, 123])
	expect(temporalToDate(temporalSet(date, 2, 'mo'))).toEqual([2025, 2, 28, 23, 34, 58, 123])
	expect(temporalToDate(temporalSet(date, 2000, 'y'))).toEqual([2000, 8, 29, 23, 34, 58, 123])
})

describe('format', () => {
	test('date time', () => {
		expect(formatTemporal(1709210096000)).toEqual('2024-02-29 12:34:56.000')
		expect(formatTemporal(1756510498123)).toEqual('2025-08-29 23:34:58.123')
	})

	test('date', () => {
		expect(formatTemporal(1709210096000, DATE_FORMAT)).toEqual('2024-02-29')
		expect(formatTemporal(1756510498123, DATE_FORMAT)).toEqual('2025-08-29')
	})

	test('time', () => {
		expect(formatTemporal(1709210096000, TIME_FORMAT)).toEqual('12:34:56.000')
		expect(formatTemporal(1756510498123, TIME_FORMAT)).toEqual('23:34:58.123')
	})
})

describe('format using pattern', () => {
	const date = 1849334947008

	test('year', () => {
		expect(formatTemporalFromPattern(date, 'YYYY')).toEqual('2028')
		expect(formatTemporalFromPattern(date, 'YYY')).toEqual('2028')
		expect(formatTemporalFromPattern(date, 'YY')).toEqual('28')
		expect(formatTemporalFromPattern(date, 'Y')).toEqual('28')
	})

	test('month', () => {
		expect(formatTemporalFromPattern(date, 'MMMM')).toEqual('August')
		expect(formatTemporalFromPattern(date, 'MMM')).toEqual('Aug')
		expect(formatTemporalFromPattern(date, 'MM')).toEqual('08')
		expect(formatTemporalFromPattern(date, 'M')).toEqual('8')
	})

	test('year and month', () => {
		expect(formatTemporalFromPattern(date, 'YYYY-MM')).toEqual('2028-08')
		expect(formatTemporalFromPattern(date, 'YY-MM')).toEqual('28-08')
		expect(formatTemporalFromPattern(date, 'YYYY/MM')).toEqual('2028/08')
		expect(formatTemporalFromPattern(date, 'YY/MM')).toEqual('28/08')
	})

	test('day', () => {
		expect(formatTemporalFromPattern(date, 'DD')).toEqual('08')
		expect(formatTemporalFromPattern(date, 'D')).toEqual('8')
	})

	test('month and day', () => {
		expect(formatTemporalFromPattern(date, 'MM/DD')).toEqual('08/08')
		expect(formatTemporalFromPattern(date, 'M-D')).toEqual('8-8')
	})

	test('year, month and day', () => {
		expect(formatTemporalFromPattern(date, 'YYYY-MM-DD')).toEqual('2028-08-08')
		expect(formatTemporalFromPattern(date, 'YY-MM-DD')).toEqual('28-08-08')
		expect(formatTemporalFromPattern(date, 'YYYY/MM/DD')).toEqual('2028/08/08')
		expect(formatTemporalFromPattern(date, 'YY/MM/DD')).toEqual('28/08/08')
		expect(formatTemporalFromPattern(date, 'YYYYMMDD')).toEqual('20280808')
	})

	test('hour', () => {
		expect(formatTemporalFromPattern(date, 'HH')).toEqual('08')
		expect(formatTemporalFromPattern(date, 'H')).toEqual('8')
	})

	test('minute', () => {
		expect(formatTemporalFromPattern(date, 'mm')).toEqual('09')
		expect(formatTemporalFromPattern(date, 'm')).toEqual('9')
	})

	test('second', () => {
		expect(formatTemporalFromPattern(date, 'ss')).toEqual('07')
		expect(formatTemporalFromPattern(date, 's')).toEqual('7')
	})

	test('millisecond', () => {
		expect(formatTemporalFromPattern(date, 'SSS')).toEqual('008')
		expect(formatTemporalFromPattern(date, 'S')).toEqual('8')
	})

	test('hour, minute and second', () => {
		expect(formatTemporalFromPattern(date, 'HH:mm:ss')).toEqual('08:09:07')
		expect(formatTemporalFromPattern(date, 'H:m:s')).toEqual('8:9:7')
		expect(formatTemporalFromPattern(date, 'HHmmss')).toEqual('080907')
	})

	test('hour, minute, second and millisecond', () => {
		expect(formatTemporalFromPattern(date, 'HH:mm:ss.SSS')).toEqual('08:09:07.008')
		expect(formatTemporalFromPattern(date, 'H:m:s.S')).toEqual('8:9:7.8')
		expect(formatTemporalFromPattern(date, 'HHmmssSSS')).toEqual('080907008')
	})

	test('full', () => {
		expect(formatTemporalFromPattern(date, 'YYYY-MM-DD HH:mm:ss.SSS')).toEqual('2028-08-08 08:09:07.008')
		expect(formatTemporalFromPattern(date, 'YY/MM/DD H:m:s.S')).toEqual('28/08/08 8:9:7.8')
		expect(formatTemporalFromPattern(date, 'YYYYMMDDHHmmssSSS')).toEqual('20280808080907008')
	})

	test('iso 8601', () => {
		expect(formatTemporalFromPattern(date, 'YYYY-MM-DDTHH:mm:ss.SSSZ')).toEqual('2028-08-08T08:09:07.008Z')
	})
})

describe('parse', () => {
	test('date', () => {
		expect(temporalToDate(parseTemporal('2028-01-01', 'YYYY-MM-DD'))).toEqual([2028, 1, 1, 0, 0, 0, 0])
		expect(temporalToDate(parseTemporal('01-01-2028', 'DD-MM-YYYY'))).toEqual([2028, 1, 1, 0, 0, 0, 0])
		expect(temporalToDate(parseTemporal('02-01-2028', 'MM-DD-YYYY'))).toEqual([2028, 2, 1, 0, 0, 0, 0])
		expect(temporalToDate(parseTemporal('28-01-01', 'YY-MM-DD'))).toEqual([2028, 1, 1, 0, 0, 0, 0])
		expect(temporalToDate(parseTemporal('01-01-28', 'DD-MM-YY'))).toEqual([2028, 1, 1, 0, 0, 0, 0])
		expect(temporalToDate(parseTemporal('02-01-28', 'MM-DD-YY'))).toEqual([2028, 2, 1, 0, 0, 0, 0])
		expect(temporalToDate(parseTemporal('2028-Jan-01', 'YYYY-MMM-DD'))).toEqual([2028, 1, 1, 0, 0, 0, 0])
		expect(temporalToDate(parseTemporal('20280101', 'YYYYMMDD'))).toEqual([2028, 1, 1, 0, 0, 0, 0])
		expect(temporalToDate(parseTemporal('2028-01-01T08:09:07.008Z', 'YYYY-MM-DD'))).toEqual([2028, 1, 1, 0, 0, 0, 0])
	})

	test('date and time', () => {
		expect(temporalToDate(parseTemporal('2028-01-01T08:09:07.008Z', 'YYYY-MM-DDTHH:mm:ss.SSSZ'))).toEqual([2028, 1, 1, 8, 9, 7, 8])
		expect(temporalToDate(parseTemporal('01-01-2028 08:09:07.008', 'DD-MM-YYYY HH:mm:ss.SSS'))).toEqual([2028, 1, 1, 8, 9, 7, 8])
		expect(temporalToDate(parseTemporal('02-01-2028 08:09:07', 'MM-DD-YYYY HH:mm:ss'))).toEqual([2028, 2, 1, 8, 9, 7, 0])
		expect(temporalToDate(parseTemporal('20280101080907008Z', 'YYYYMMDDHHmmssSSSZ'))).toEqual([2028, 1, 1, 8, 9, 7, 8])
		expect(temporalToDate(parseTemporal('2028-01-01', 'YYYY-MM-DDTHH:mm:ss.SSS'))).toEqual([2028, 1, 1, 0, 0, 0, 0])
	})
})
