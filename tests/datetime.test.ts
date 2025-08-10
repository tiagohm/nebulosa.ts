import { beforeAll, expect, setSystemTime, test } from 'bun:test'
import { dateFrom, dateFromTime, dateNow, dateUnix, dateYMDHMS } from '../src/datetime'
import { timeYMDHMS } from '../src/time'

beforeAll(() => {
	setSystemTime(new Date('2025-01-09T12:34:56.000-03:00'))
})

test('year', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.year()).toBe(2025)
	expect(dateTime.year(2024).year()).toBe(2024)
})

test('month', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.month()).toBe(0)
	expect(dateTime.month(11).month()).toBe(11)
})

test('date', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.date()).toBe(9)
	expect(dateTime.date(22).date()).toBe(22)
})

test('day', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.day()).toBe(4)
})

test('hour', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.hour()).toBe(12)
	expect(dateTime.hour(19).hour()).toBe(19)
})

test('minute', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.minute()).toBe(34)
	expect(dateTime.minute(1).minute()).toBe(1)
})

test('second', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.second()).toBe(56)
	expect(dateTime.second(29).second()).toBe(29)
})

test('millisecond', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.millisecond()).toBe(0)
	expect(dateTime.millisecond(555).millisecond()).toBe(555)
})

test('day of year', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.dayOfYear()).toBe(9)
})

test('unix', () => {
	const dateTime = dateUnix(1736426096)
	expect(dateTime.format()).toBe('2025-01-09T12:34:56+00:00')
})

test('ymdhms', () => {
	const dateTime = dateYMDHMS(2025, 1, 9, 12, 34, 56, 456)
	expect(dateTime.format('YYYY-MM-DDTHH:mm:ss.SSSZ')).toBe('2025-01-09T12:34:56.456+00:00')
})

test('array', () => {
	const dateTime = dateFrom([2025, 1, 9, 12, 34, 56, 456])
	expect(dateTime.format('YYYY-MM-DDTHH:mm:ss.SSSZ')).toBe('2025-01-09T12:34:56.456+00:00')
})

test('time', () => {
	const dateTime = dateFromTime(timeYMDHMS(2025, 1, 9, 12, 34, 56))
	expect(dateTime.format()).toBe('2025-01-09T12:34:56+00:00')
})

test('format', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.format()).toBe('2025-01-09T12:34:56+00:00')
	expect(dateTime.format('YYYY-MM-DD')).toBe('2025-01-09')
	expect(dateTime.format('HH:mm:ss')).toBe('12:34:56')
	expect(dateTime.format('HH:mm:ss.SSS')).toBe('12:34:56.000')
	expect(dateTime.format('HH:mm:ssZ')).toBe('12:34:56+00:00')
})

test('now', () => {
	expect(dateNow().format()).toBe('2025-01-09T15:34:56+00:00')
	expect(dateNow(true).format()).toBe('2025-01-09T15:34:56Z')
})

test('add', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.add(1, 's').format()).toBe('2025-01-09T12:34:57+00:00')
	expect(dateTime.add(1, 'm').format()).toBe('2025-01-09T12:35:56+00:00')
	expect(dateTime.add(1, 'h').format()).toBe('2025-01-09T13:34:56+00:00')
	expect(dateTime.add(1, 'd').format()).toBe('2025-01-10T12:34:56+00:00')
	expect(dateTime.add(1, 'M').format()).toBe('2025-02-09T12:34:56+00:00')
	expect(dateTime.add(1, 'y').format()).toBe('2026-01-09T12:34:56+00:00')
})

test('subtract', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.subtract(1, 's').format()).toBe('2025-01-09T12:34:55+00:00')
	expect(dateTime.subtract(1, 'm').format()).toBe('2025-01-09T12:33:56+00:00')
	expect(dateTime.subtract(1, 'h').format()).toBe('2025-01-09T11:34:56+00:00')
	expect(dateTime.subtract(1, 'd').format()).toBe('2025-01-08T12:34:56+00:00')
	expect(dateTime.subtract(1, 'M').format()).toBe('2024-12-09T12:34:56+00:00')
	expect(dateTime.subtract(1, 'y').format()).toBe('2024-01-09T12:34:56+00:00')
})

test('start of', () => {
	const dateTime = dateFrom('2025-02-09 12:34:56')
	expect(dateTime.startOf('ms').format()).toBe('2025-02-09T12:34:56+00:00')
	expect(dateTime.startOf('s').format()).toBe('2025-02-09T12:34:56+00:00')
	expect(dateTime.startOf('m').format()).toBe('2025-02-09T12:34:00+00:00')
	expect(dateTime.startOf('h').format()).toBe('2025-02-09T12:00:00+00:00')
	expect(dateTime.startOf('d').format()).toBe('2025-02-09T00:00:00+00:00')
	expect(dateTime.startOf('M').format()).toBe('2025-02-01T00:00:00+00:00')
	expect(dateTime.startOf('y').format()).toBe('2025-01-01T00:00:00+00:00')
})

test('end of', () => {
	const dateTime = dateFrom('2025-02-09 12:34:56')
	expect(dateTime.endOf('ms').format()).toBe('2025-02-09T12:34:56+00:00')
	expect(dateTime.endOf('s').format()).toBe('2025-02-09T12:34:56+00:00')
	expect(dateTime.endOf('m').format()).toBe('2025-02-09T12:34:59+00:00')
	expect(dateTime.endOf('h').format()).toBe('2025-02-09T12:59:59+00:00')
	expect(dateTime.endOf('d').format()).toBe('2025-02-09T23:59:59+00:00')
	expect(dateTime.endOf('M').format()).toBe('2025-02-28T23:59:59+00:00')
	expect(dateTime.endOf('y').format()).toBe('2025-12-31T23:59:59+00:00')
})

test('utc', () => {
	const dateTime = dateFrom('2025-02-09 12:34:56+01:00')
	expect(dateTime.utc().format()).toBe('2025-02-09T11:34:56Z')
})

test('utc offset', () => {
	const dateTime = dateFrom('2025-02-09 12:34:56+01:00')
	expect(dateTime.utcOffset(-3).format()).toBe('2025-02-09T08:34:56-03:00')
	expect(dateTime.utcOffset(-3).utc().format()).toBe('2025-02-09T11:34:56Z')
	expect(dateTime.utcOffset(-3).utc().utcOffset(-3).format()).toBe('2025-02-09T08:34:56-03:00')
})

test('utc offset and keep local time', () => {
	const dateTime = dateFrom('2025-02-09 12:34:56+01:00')
	expect(dateTime.utcOffset(3, true).format()).toBe('2025-02-09T11:34:56+03:00')
})

test('diff', () => {
	const dateTime = dateFrom('2025-01-09 12:34:56')
	expect(dateTime.diff('2025-01-09 12:34:56')).toBe(0)

	expect(dateTime.diff('2025-01-09 12:34:57')).toBe(-1000)
	expect(dateTime.diff('2025-01-09 12:34:55')).toBe(1000)
	expect(dateTime.diff('2025-01-09 12:34:55', 's')).toBe(1)
	expect(dateTime.diff('2025-01-09 12:34:55', 'm')).toBe(0)
	expect(dateTime.diff('2025-01-09 12:34:55', 'm', true)).toBeCloseTo(0.0166667, 6)

	expect(dateTime.diff('2025-01-09 12:36:56')).toBe(-120000)
	expect(dateTime.diff('2025-01-09 12:32:56')).toBe(120000)
	expect(dateTime.diff('2025-01-09 12:32:56', 's')).toBe(120)
	expect(dateTime.diff('2025-01-09 12:32:56', 'm')).toBe(2)
	expect(dateTime.diff('2025-01-09 12:32:56', 'h')).toBe(0)
	expect(dateTime.diff('2025-01-09 12:32:56', 'h', true)).toBeCloseTo(0.0333334, 6)

	expect(dateTime.diff('2025-01-08 12:32:56', 'd')).toBe(1)
	expect(dateTime.diff('2024-12-09 12:32:56', 'M')).toBe(1)
	expect(dateTime.diff('2026-02-09 12:32:56', 'y')).toBe(-1)

	expect(dateFrom('2024-01-01').diff('2025-01-01', 'd')).toBe(-366)
})

test('local', () => {
	process.env.TZ = 'America/Sao_Paulo'
	const dateTime = dateFrom('2025-02-09 12:34:56+01:00')
	expect(dateTime.local().format()).toBe('2025-02-09T08:34:56-03:00')
})
