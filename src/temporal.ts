// gv-IM, mg-MG, sn-ZW, zu-ZA
export const DATE_FORMAT = Intl.DateTimeFormat('zu-ZA', { timeZone: 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: undefined, minute: undefined, second: undefined, fractionalSecondDigits: undefined })
export const TIME_FORMAT = Intl.DateTimeFormat('zu-ZA', { timeZone: 'UTC', hour12: false, year: undefined, month: undefined, day: undefined, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
export const DATE_TIME_FORMAT = Intl.DateTimeFormat('zu-ZA', { timeZone: 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })

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

export function temporalToDate(temporal: Temporal): Readonly<TemporalDate> {
	let day = Math.floor(temporal / DAYS)
	let time = temporal % DAYS

	if (time < 0) {
		time += DAYS
		day -= 1
	}

	let year = 1970

	while (true) {
		const a = isLeapYear(year) ? 366 : 365

		if (day >= a) {
			day -= a
			year++
		} else if (day < 0) {
			day += isLeapYear(--year) ? 366 : 365
		} else {
			break
		}
	}

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

	return [year, month, day, hour, minute, second, millisecond] as const
}

export function temporalAdd(temporal: Temporal, duration: number, unit: TemporalUnit | TemporalUnitShort): Temporal {
	if (unit === 'ms' || unit === 'millisecond') return temporal + duration
	else if (unit === 's' || unit === 'second') return temporal + duration * SECONDS
	else if (unit === 'm' || unit === 'minute') return temporal + duration * MINUTES
	else if (unit === 'h' || unit === 'hour') return temporal + duration * HOURS
	else if (unit === 'd' || unit === 'day') return temporal + duration * DAYS
	else {
		const date = temporalToDate(temporal) as TemporalDate

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

export function temporalExtract(temporal: Temporal, unit: TemporalUnit | TemporalUnitShort) {
	if (unit === 'ms' || unit === 'millisecond') return temporal % 1000
	else if (unit === 's' || unit === 'second') return Math.floor(temporal / 1000) % 60
	else if (unit === 'm' || unit === 'minute') return Math.floor(temporal / 60000) % 60
	else if (unit === 'h' || unit === 'hour') return Math.floor(temporal / 3600000) % 24
	else if (unit === 'd' || unit === 'day') return temporalToDate(temporal)[2]
	else if (unit === 'mo' || unit === 'month') return temporalToDate(temporal)[1]
	else if (unit === 'y' || unit === 'year') return temporalToDate(temporal)[0]
	return 0
}

export function formatTemporal(temporal: Temporal, format: Intl.DateTimeFormat = DATE_TIME_FORMAT) {
	return format.format(temporal)
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
