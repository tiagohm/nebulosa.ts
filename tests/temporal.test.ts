import { describe, expect, test } from 'bun:test'
import { DATE_FORMAT, daysInMonth, formatTemporal, isLeapYear, TIME_FORMAT, temporalAdd, temporalEndOfDay, temporalExtract, temporalFromDate, temporalStartOfDay, temporalSubtract, temporalToDate } from '../src/temporal'

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

	let ms = temporalFromDate(2020, 1, 1, 0, 0, 0, 0)

	for (let y = 2020; y < 2025; y++) {
		for (let mo = 1; mo <= 12; mo++) {
			const nd = daysInMonth(y, mo)

			for (let d = 1; d <= nd; d++) {
				for (let h = 0; h < 24; h++, ms += 1000 * 60 * 60) {
					expect(temporalFromDate(y, mo, d, h, 0, 0, 0)).toBe(ms)
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
	expect(temporalToDate(1709210096000)).toEqual([2024, 2, 29, 12, 34, 56, 0])
	expect(temporalToDate(1677674096000)).toEqual([2023, 3, 1, 12, 34, 56, 0])
	expect(temporalToDate(1756510498123)).toEqual([2025, 8, 29, 23, 34, 58, 123])
	expect(temporalToDate(1788046498123)).toEqual([2026, 8, 29, 23, 34, 58, 123])
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

test('extract', () => {
	expect(temporalExtract(1709210096000, 'y')).toBe(2024)
	expect(temporalExtract(1709210096000, 'mo')).toBe(2)
	expect(temporalExtract(1709210096000, 'd')).toBe(29)
	expect(temporalExtract(1709210096000, 'h')).toBe(12)
	expect(temporalExtract(1709210096000, 'm')).toBe(34)
	expect(temporalExtract(1709210096000, 's')).toBe(56)
	expect(temporalExtract(1709210096128, 'ms')).toBe(128)
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
