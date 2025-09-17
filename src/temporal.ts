import { type Time, toUnixMillis } from './time'

// gv-IM, mg-MG, sn-ZW, zu-ZA
export const DATE_FORMAT = 'YYYY-MM-DD'
export const TIME_FORMAT = 'HH:mm:ss.SSS'
export const DATE_TIME_FORMAT = 'YYYY-MM-DD HH:mm:ss.SSS'
export const ISO8601_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ'

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const DAYS_UNTIL_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]

const DAYS = 86400000
const HOURS = 3600000
const MINUTES = 60000
const SECONDS = 1000

export type Temporal = number

export type TemporalUnit = 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

export type TemporalUnitShort = 'ms' | 's' | 'm' | 'h' | 'd' | 'mo' | 'y'

export type TemporalDate = [number, number, number, number, number, number, number]

export function temporalNow(): Temporal {
	return Date.now()
}

export function temporalUnix(timestamp: number): Temporal {
	return timestamp * 1000
}

export function temporalFromDate(year: number, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0, millisecond: number = 0): Temporal {
	const days = daysFromEpochToYear(year) + DAYS_UNTIL_MONTH[month - 1] + (month > 2 && isLeapYear(year) ? 1 : 0) + (day - 1)
	return days * DAYS + hour * HOURS + minute * MINUTES + second * SECONDS + millisecond
}

export function temporalToDate(temporal: Temporal): TemporalDate {
	let day = Math.floor(temporal / DAYS)
	let time = temporal % DAYS

	if (time < 0) {
		const offset = Math.ceil(Math.abs(time) / DAYS)
		time += offset * DAYS
		day -= offset
	}

	let year = 1970 + Math.floor(day / 365.2425)
	let daysUpToYear = daysFromEpochToYear(year)

	// Adjust year if overshot or undershot
	while (day < daysUpToYear) {
		daysUpToYear = daysFromEpochToYear(--year)
	}

	while (day >= daysFromEpochToYear(year + 1)) {
		daysUpToYear = daysFromEpochToYear(++year)
	}

	day -= daysUpToYear

	let month = 1

	while (true) {
		const a = daysInMonth(year, month)

		if (day >= a) {
			day -= a
			month++
		} else {
			break
		}
	}

	day++

	const hour = Math.floor(time / HOURS)
	time %= HOURS
	const minute = Math.floor(time / MINUTES)
	time %= MINUTES
	const second = Math.floor(time / SECONDS)
	const millisecond = time % SECONDS

	return [year, month, day, hour, minute, second, millisecond]
}

export function temporalFromTime(time: Time): Temporal {
	return toUnixMillis(time)
}

export function temporalAdd(temporal: Temporal, duration: number, unit: TemporalUnit | TemporalUnitShort): Temporal {
	if (unit === 'ms' || unit === 'millisecond') return temporal + duration
	else if (unit === 's' || unit === 'second') return temporal + duration * SECONDS
	else if (unit === 'm' || unit === 'minute') return temporal + duration * MINUTES
	else if (unit === 'h' || unit === 'hour') return temporal + duration * HOURS
	else if (unit === 'd' || unit === 'day') return temporal + duration * DAYS
	else {
		const date = temporalToDate(temporal)

		if (unit === 'y' || unit === 'year') {
			date[0] += duration
			return temporalFromDate(...date)
		} else {
			const months = date[0] * 12 + (date[1] - 1) + duration
			date[0] = Math.floor(months / 12)
			date[1] = (months % 12) + 1
			date[2] = Math.min(date[2], daysInMonth(date[0], date[1]))
			return temporalFromDate(...date)
		}
	}
}

export function temporalSubtract(temporal: Temporal, duration: number, unit: TemporalUnit | TemporalUnitShort): Temporal {
	return temporalAdd(temporal, -duration, unit)
}

export function temporalStartOfDay(temporal: Temporal): Temporal {
	return temporal - (temporal % DAYS)
}

export function temporalEndOfDay(temporal: Temporal): Temporal {
	return temporal + (DAYS - (temporal % DAYS)) - 1
}

export function temporalDayOfWeek(temporal: Temporal) {
	return (((Math.floor(temporal / DAYS) + 4) % 7) + 7) % 7
}

export function temporalGet(temporal: Temporal, unit: TemporalUnit | TemporalUnitShort) {
	if (unit === 'ms' || unit === 'millisecond') return temporal % 1000
	else if (unit === 's' || unit === 'second') return Math.floor(temporal / 1000) % 60
	else if (unit === 'm' || unit === 'minute') return Math.floor(temporal / 60000) % 60
	else if (unit === 'h' || unit === 'hour') return Math.floor(temporal / 3600000) % 24
	else if (unit === 'd' || unit === 'day') return temporalToDate(temporal)[2]
	else if (unit === 'mo' || unit === 'month') return temporalToDate(temporal)[1]
	else if (unit === 'y' || unit === 'year') return temporalToDate(temporal)[0]
	return 0
}

export function temporalSet(temporal: Temporal, value: number, unit: TemporalUnit | TemporalUnitShort) {
	if (unit === 'ms' || unit === 'millisecond') return temporal - (temporal % 1000) + value
	else if (unit === 's' || unit === 'second') return temporal - (temporal % 60000) + value * 1000 + (temporal % 1000)
	else if (unit === 'm' || unit === 'minute') return temporal - (temporal % 3600000) + value * 60000 + (temporal % 60000)
	else if (unit === 'h' || unit === 'hour') return temporal - (temporal % 86400000) + value * 3600000 + (temporal % 3600000)
	else if (unit === 'd' || unit === 'day') {
		const date = temporalToDate(temporal)
		date[2] = value
		return temporalFromDate(...date)
	} else if (unit === 'mo' || unit === 'month') {
		const date = temporalToDate(temporal)
		date[1] = value
		date[2] = Math.min(date[2], daysInMonth(date[0], date[1]))
		return temporalFromDate(...date)
	} else if (unit === 'y' || unit === 'year') {
		const date = temporalToDate(temporal)
		date[0] = value
		return temporalFromDate(...date)
	}

	return temporal
}

export function formatTemporal(temporal: Temporal, format: Intl.DateTimeFormat | string = DATE_TIME_FORMAT) {
	return typeof format === 'string' ? formatTemporalFromPattern(temporal, format) : format.format(temporal)
}

const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function parseTemporal(text: string, pattern: string): Temporal {
	const date: TemporalDate = [0, 0, 0, 0, 0, 0, 0]

	function numeric(text: string, start: number, end: number) {
		let res = 0
		for (let i = start; i < end; i++) res = res * 10 + (text.charCodeAt(i) - 48)
		return res
	}

	function year(text: string, start: number, end: number) {
		return 2000 + numeric(text, start, end)
	}

	function month(text: string, start: number, end: number) {
		return SHORT_MONTH_NAMES.indexOf(text.substring(start, end)) + 1
	}

	function replace(format: string, index: number, value: (text: string, start: number, end: number) => number) {
		const i = pattern.indexOf(format)

		if (i >= 0) {
			date[index] = value(text, i, i + format.length)
			pattern = pattern.replace(format, '#'.padStart(format.length, '#'))
			return true
		}

		return false
	}

	while (true) {
		let found = replace('YYYY', 0, numeric)
		found = replace('YY', 0, year) || found
		found = replace('DD', 2, numeric) || found
		found = replace('HH', 3, numeric) || found
		found = replace('mm', 4, numeric) || found
		found = replace('ss', 5, numeric) || found
		found = replace('SSS', 6, numeric) || found
		found = replace('MMM', 1, month) || found
		found = replace('MM', 1, numeric) || found

		if (!found) break
	}

	if (date[0] === 0 || date[1] === 0 || date[2] === 0) {
		throw new Error('invalid date')
	}

	return temporalFromDate(...date)
}

export function formatTemporalFromPattern(temporal: Temporal, pattern: string) {
	const date = temporalToDate(temporal)

	if (pattern.includes('Y')) pattern = pattern.replaceAll('YYYY', date[0].toFixed(0).padStart(4, '0'))
	if (pattern.includes('Y')) pattern = pattern.replaceAll('YY', (date[0] % 100).toFixed(0).padStart(2, '0'))

	if (pattern.includes('D')) pattern = pattern.replaceAll('DD', date[2].toFixed(0).padStart(2, '0'))
	if (pattern.includes('D')) pattern = pattern.replaceAll('D', date[2].toFixed(0))

	if (pattern.includes('H')) pattern = pattern.replaceAll('HH', date[3].toFixed(0).padStart(2, '0'))
	if (pattern.includes('H')) pattern = pattern.replaceAll('H', date[3].toFixed(0))

	if (pattern.includes('m')) pattern = pattern.replaceAll('mm', date[4].toFixed(0).padStart(2, '0'))
	if (pattern.includes('m')) pattern = pattern.replaceAll('m', date[4].toFixed(0))

	if (pattern.includes('s')) pattern = pattern.replaceAll('ss', date[5].toFixed(0).padStart(2, '0'))
	if (pattern.includes('s')) pattern = pattern.replaceAll('s', date[5].toFixed(0))

	if (pattern.includes('S')) pattern = pattern.replaceAll('SSS', date[6].toFixed(0).padStart(3, '0'))
	if (pattern.includes('S')) pattern = pattern.replaceAll('S', date[6].toFixed(0))

	if (pattern.includes('M')) pattern = pattern.replaceAll('MMMM', MONTH_NAMES[date[1] - 1])
	if (pattern.includes('M')) pattern = pattern.replaceAll('MMM', SHORT_MONTH_NAMES[date[1] - 1])
	if (pattern.includes('M')) pattern = pattern.replaceAll('MM', date[1].toFixed(0).padStart(2, '0'))
	if (pattern.includes('M')) pattern = pattern.replaceAll('M', date[1].toFixed(0))

	return pattern
}

export function isLeapYear(year: number) {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number) {
	return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
}

function daysUntilYear(year: number): number {
	return --year * 365 + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400)
}

function daysFromEpochToYear(year: number): number {
	return daysUntilYear(year) - 719162 // daysUntilYear(1970)
}
