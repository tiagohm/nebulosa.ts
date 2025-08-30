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

const PATTERN_VALID_CHARS = 'YMDHmsS'
const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function formatTemporalFromPattern(temporal: Temporal, pattern: string) {
	const date = temporalToDate(temporal)
	let pc = pattern[0]
	let text = ''
	let sz = 0

	for (let i = 0; i <= pattern.length; i++) {
		const c = pattern[i]

		if (PATTERN_VALID_CHARS.includes(c)) {
			pc = c
			sz++
		} else if (sz > 0) {
			if (pc === 'Y') {
				text += sz === 2 ? (date[0] % 100).toFixed(0).padStart(2, '0') : date[0].toFixed()
			} else if (pc === 'M') {
				text += sz === 1 ? date[1].toFixed(0) : sz === 2 ? date[1].toFixed(0).padStart(2, '0') : sz === 3 ? SHORT_MONTH_NAMES[date[1] - 1] : MONTH_NAMES[date[1] - 1]
			} else if (pc === 'D') {
				text += sz === 1 ? date[2].toFixed(0) : date[2].toFixed(0).padStart(2, '0')
			} else if (pc === 'H') {
				text += sz === 1 ? date[3].toFixed(0) : date[3].toFixed(0).padStart(2, '0')
			} else if (pc === 'm') {
				text += sz === 1 ? date[4].toFixed(0) : date[4].toFixed(0).padStart(2, '0')
			} else if (pc === 's') {
				text += sz === 1 ? date[5].toFixed(0) : date[5].toFixed(0).padStart(2, '0')
			} else if (pc === 'S') {
				text += sz === 1 ? date[6].toFixed(0) : date[6].toFixed(0).padStart(3, '0')
			}

			sz = 0
			i--
		} else if (c) {
			text += c
			sz = 0
		}
	}

	return text
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
