import { pmod } from './math'
import { type Time, timeToUnixMillis } from './time'

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
const WEEK = DAYS * 7

export type Temporal = number

export type TemporalUnit = 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

export type TemporalUnitShort = 'ms' | 's' | 'm' | 'h' | 'd' | 'w' | 'mo' | 'y'

export type TemporalDate = [number, number, number, number, number, number, number]

// Returns the current timestamp in milliseconds.
export function temporalNow(): Temporal {
	return Date.now()
}

// Converts Unix seconds to milliseconds.
export function temporalUnix(timestamp: number): Temporal {
	return timestamp * 1000
}

// Builds a UTC timestamp from calendar fields.
export function temporalFromDate(year: number, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0, millisecond: number = 0): Temporal {
	const days = daysFromEpochToYear(year) + DAYS_UNTIL_MONTH[month - 1] + (month > 2 && isLeapYear(year) ? 1 : 0) + (day - 1)
	return days * DAYS + hour * HOURS + minute * MINUTES + second * SECONDS + millisecond
}

// Splits a timestamp into its UTC day index and milliseconds inside the day.
function splitTemporalDay(temporal: Temporal) {
	const day = Math.floor(temporal / DAYS)
	return [day, temporal - day * DAYS] as const
}

// Converts a UTC timestamp to calendar fields.
export function temporalToDate(temporal: Temporal) {
	let [day, time] = splitTemporalDay(temporal)

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

	return [year, month, day, hour, minute, second, millisecond] as const
}

// Converts a Time object to Temporal milliseconds.
export function temporalFromTime(time: Time): Temporal {
	return timeToUnixMillis(time)
}

// Converts 1-based fractional day-of-year into a UTC timestamp.
export function temporalFromFractionOfYear(year: number, days: number): Temporal {
	// Round once to millisecond precision to avoid carrying fractional-ms noise.
	return temporalFromDate(year) + Math.round((days - 1) * DAYS)
}

// Adds a duration in calendar or fixed-size time units.
export function temporalAdd(temporal: Temporal, duration: number, unit: TemporalUnit | TemporalUnitShort): Temporal {
	if (duration === 0) return temporal
	if (unit === 'ms' || unit === 'millisecond') return temporal + duration
	else if (unit === 's' || unit === 'second') return temporal + duration * SECONDS
	else if (unit === 'm' || unit === 'minute') return temporal + duration * MINUTES
	else if (unit === 'h' || unit === 'hour') return temporal + duration * HOURS
	else if (unit === 'd' || unit === 'day') return temporal + duration * DAYS
	else if (unit === 'w' || unit === 'week') return temporal + duration * WEEK
	else {
		const [year, month, day, hour, minute, second, millisecond] = temporalToDate(temporal)

		if (unit === 'y' || unit === 'year') {
			const nextYear = year + duration
			return temporalFromDate(nextYear, month, Math.min(day, daysInMonth(nextYear, month)), hour, minute, second, millisecond)
		} else {
			const totalMonths = year * 12 + (month - 1) + duration
			const nextYear = Math.floor(totalMonths / 12)
			const nextMonth = pmod(totalMonths, 12) + 1
			return temporalFromDate(nextYear, nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth)), hour, minute, second, millisecond)
		}
	}
}

// Subtracts a duration in calendar or fixed-size time units.
export function temporalSubtract(temporal: Temporal, duration: number, unit: TemporalUnit | TemporalUnitShort): Temporal {
	return temporalAdd(temporal, -duration, unit)
}

// Floors a timestamp to the start of its UTC day.
export function temporalStartOfDay(temporal: Temporal): Temporal {
	return Math.floor(temporal / DAYS) * DAYS
}

// Ceils a timestamp to the end of its UTC day.
export function temporalEndOfDay(temporal: Temporal): Temporal {
	return Math.floor(temporal / DAYS) * DAYS + DAYS - 1
}

// Returns the UTC day of week where 0 is Sunday.
export function temporalDayOfWeek(temporal: Temporal) {
	return pmod(Math.floor(temporal / DAYS) + 4, 7)
}

// Reads a single UTC calendar or time field.
export function temporalGet(temporal: Temporal, unit: TemporalUnit | TemporalUnitShort) {
	const [, time] = splitTemporalDay(temporal)

	if (unit === 'ms' || unit === 'millisecond') return time % SECONDS
	else if (unit === 's' || unit === 'second') return Math.floor(time / SECONDS) % 60
	else if (unit === 'm' || unit === 'minute') return Math.floor(time / MINUTES) % 60
	else if (unit === 'h' || unit === 'hour') return Math.floor(time / HOURS)
	else if (unit === 'd' || unit === 'day') return temporalToDate(temporal)[2]
	else if (unit === 'w' || unit === 'week') return temporalDayOfWeek(temporal)
	else if (unit === 'mo' || unit === 'month') return temporalToDate(temporal)[1]
	else if (unit === 'y' || unit === 'year') return temporalToDate(temporal)[0]
	return 0
}

// Replaces a single UTC calendar or time field.
export function temporalSet(temporal: Temporal, value: number, unit: TemporalUnit | TemporalUnitShort) {
	const [day, time] = splitTemporalDay(temporal)
	const dayStart = day * DAYS

	if (unit === 'ms' || unit === 'millisecond') return dayStart + Math.floor(time / SECONDS) * SECONDS + value
	else if (unit === 's' || unit === 'second') return dayStart + Math.floor(time / MINUTES) * MINUTES + value * SECONDS + (time % SECONDS)
	else if (unit === 'm' || unit === 'minute') return dayStart + Math.floor(time / HOURS) * HOURS + value * MINUTES + (time % MINUTES)
	else if (unit === 'h' || unit === 'hour') return dayStart + value * HOURS + (time % HOURS)
	else if (unit === 'd' || unit === 'day') {
		const [year, month, , hour, minute, second, millisecond] = temporalToDate(temporal)
		return temporalFromDate(year, month, value, hour, minute, second, millisecond)
	} else if (unit === 'mo' || unit === 'month') {
		const [year, , day, hour, minute, second, millisecond] = temporalToDate(temporal)
		return temporalFromDate(year, value, Math.min(day, daysInMonth(year, value)), hour, minute, second, millisecond)
	} else if (unit === 'y' || unit === 'year') {
		const [, month, day, hour, minute, second, millisecond] = temporalToDate(temporal)
		return temporalFromDate(value, month, Math.min(day, daysInMonth(value, month)), hour, minute, second, millisecond)
	}

	return temporal
}

// Formats a timestamp with either a custom pattern or Intl.DateTimeFormat.
export function formatTemporal(temporal: Temporal, format: Intl.DateTimeFormat | string = DATE_TIME_FORMAT, timezone: number = TIMEZONE) {
	return typeof format === 'string' ? formatTemporalFromPattern(temporal, format, timezone) : format.format(temporal)
}

const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LOWERCASE_SHORT_MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SHORT_WEEK_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEK_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const PATTERN_SYMBOLS = 'YMDWHmsS'
const PATTERN_TOKEN_CACHE = new Map<string, Readonly<PatternToken>[]>()

// Parses a UTC timestamp from a fixed-width pattern.
export function parseTemporal(input: string, pattern: string): Temporal {
	const date: TemporalDate = [1970, 1, 1, 0, 0, 0, 0]
	const tokens = tokenizePattern(pattern)

	input = input.trim()

	for (const { start, end, found, text } of tokens) {
		if (end > input.length) break

		const i = input.substring(start, end)

		if (found) {
			switch (text) {
				case 'YYYY':
					date[0] = parsePatternNumber(i, text)
					break
				case 'YY':
					date[0] = parsePatternNumber(i, text) + 2000
					break
				case 'MMM':
					date[1] = LOWERCASE_SHORT_MONTH_NAMES.indexOf(i.toLowerCase()) + 1
					break
				case 'MM':
					date[1] = parsePatternNumber(i, text)
					break
				case 'DD':
					date[2] = parsePatternNumber(i, text)
					break
				case 'HH':
					date[3] = parsePatternNumber(i, text)
					break
				case 'mm':
					date[4] = parsePatternNumber(i, text)
					break
				case 'ss':
					date[5] = parsePatternNumber(i, text)
					break
				case 'SSS':
					date[6] = parsePatternNumber(i, text)
					break
				default:
					throw new Error(`invalid pattern found: ${text}`)
			}
		} else if (i !== text) {
			throw new Error(`invalid date. expected "${text}" at position ${start}, but got "${i}"`)
		}
	}

	if (date[1] < 1 || date[1] > 12) {
		throw new Error(`invalid month. expected [1-12], but got ${date[1]}`)
	}

	const monthDays = daysInMonth(date[0], date[1])

	if (date[2] < 1 || date[2] > monthDays) {
		throw new Error(`invalid day of month. expected [1-${monthDays}], but got ${date[2]}`)
	}

	if (date[3] < 0 || date[3] > 23) {
		throw new Error(`invalid hour. expected [0-23], but got ${date[3]}`)
	}

	if (date[4] < 0 || date[4] > 59) {
		throw new Error(`invalid minute. expected [0-59], but got ${date[4]}`)
	}

	if (date[5] < 0 || date[5] > 59) {
		throw new Error(`invalid second. expected [0-59], but got ${date[5]}`)
	}

	if (date[6] < 0 || date[6] > 999) {
		throw new Error(`invalid millisecond. expected [0-999], but got ${date[6]}`)
	}

	return temporalFromDate(...date)
}

export const TIMEZONE = -new Date().getTimezoneOffset()

// Formats a UTC timestamp using a fixed-width pattern.
export function formatTemporalFromPattern(temporal: Temporal, pattern: string, timezone: number = TIMEZONE) {
	const tokens = tokenizePattern(pattern)
	const output: string[] = []

	if (timezone) temporal += timezone * MINUTES

	const [year, month, day, hour, minute, second, millisecond] = temporalToDate(temporal)
	const weekday = temporalDayOfWeek(temporal)

	for (const { found, text } of tokens) {
		if (found) {
			switch (text) {
				case 'YYYY':
					output.push(year.toFixed(0).padStart(4, '0'))
					break
				case 'YYY':
					output.push(year.toFixed(0))
					break
				case 'YY':
					output.push((year % 100).toFixed(0).padStart(2, '0'))
					break
				case 'Y':
					output.push((year % 100).toFixed(0))
					break
				case 'MMMM':
					output.push(MONTH_NAMES[month - 1])
					break
				case 'MMM':
					output.push(SHORT_MONTH_NAMES[month - 1])
					break
				case 'MM':
					output.push(month.toFixed(0).padStart(2, '0'))
					break
				case 'M':
					output.push(month.toFixed(0))
					break
				case 'WW':
					output.push(WEEK_NAMES[weekday])
					break
				case 'W':
					output.push(SHORT_WEEK_NAMES[weekday])
					break
				case 'DD':
					output.push(day.toFixed(0).padStart(2, '0'))
					break
				case 'D':
					output.push(day.toFixed(0))
					break
				case 'HH':
					output.push(hour.toFixed(0).padStart(2, '0'))
					break
				case 'H':
					output.push(hour.toFixed(0))
					break
				case 'mm':
					output.push(minute.toFixed(0).padStart(2, '0'))
					break
				case 'm':
					output.push(minute.toFixed(0))
					break
				case 'ss':
					output.push(second.toFixed(0).padStart(2, '0'))
					break
				case 's':
					output.push(second.toFixed(0))
					break
				case 'SSS':
					output.push(millisecond.toFixed(0).padStart(3, '0'))
					break
				case 'S':
					output.push(millisecond.toFixed(0))
					break
			}
		} else {
			output.push(text)
		}
	}

	return output.join('')
}

interface PatternToken {
	readonly start: number
	readonly end: number
	readonly text: string
	readonly found: boolean
}

// Parses a fixed-width numeric token and rejects malformed values.
function parsePatternNumber(input: string, token: string) {
	const value = +input
	if (!Number.isFinite(value)) throw new Error(`invalid ${token} value: ${input}`)
	return value
}

// Tokenizes and caches fixed-width pattern segments.
function tokenizePattern(pattern: string): Readonly<PatternToken>[] {
	const cached = PATTERN_TOKEN_CACHE.get(pattern)
	if (cached) return cached
	if (!pattern) return []

	const tokens: PatternToken[] = []
	let start = 0
	let found = PATTERN_SYMBOLS.includes(pattern[0])

	for (let i = 1; i < pattern.length; i++) {
		const c = pattern[i]
		const nextFound = PATTERN_SYMBOLS.includes(c)

		if (nextFound !== found || (nextFound && c !== pattern[i - 1])) {
			tokens.push({ start, end: i, text: pattern.substring(start, i), found })
			start = i
			found = nextFound
		}
	}

	tokens.push({ start, end: pattern.length, text: pattern.substring(start), found })
	PATTERN_TOKEN_CACHE.set(pattern, tokens)
	return tokens
}

// Checks Gregorian leap years in the proleptic calendar.
export function isLeapYear(year: number) {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

// Returns the number of days in a month.
export function daysInMonth(year: number, month: number) {
	return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
}

const DAYS_UNTIL_YEAR = [
	719162, 719527, 719892, 720258, 720623, 720988, 721353, 721719, 722084, 722449, 722814, 723180, 723545, 723910, 724275, 724641, 725006, 725371, 725736, 726102, 726467, 726832, 727197, 727563, 727928, 728293, 728658, 729024, 729389, 729754, 730119, 730485, 730850, 731215, 731580, 731946, 732311, 732676, 733041,
	733407, 733772, 734137, 734502, 734868, 735233, 735598, 735963, 736329, 736694, 737059, 737424, 737790, 738155, 738520, 738885, 739251, 739616, 739981, 740346, 740712, 741077, 741442, 741807, 742173, 742538, 742903, 743268, 743634, 743999, 744364, 744729, 745095, 745460, 745825, 746190, 746556, 746921, 747286,
	747651, 748017, 748382, 748747, 749112, 749478, 749843, 750208, 750573, 750939, 751304, 751669, 752034, 752400, 752765, 753130, 753495, 753861, 754226, 754591, 754956, 755322, 755687, 756052, 756417, 756783, 757148, 757513, 757878, 758244, 758609, 758974, 759339, 759705, 760070, 760435, 760800, 761166, 761531,
	761896, 762261, 762627, 762992, 763357, 763722, 764088, 764453, 764818, 765183, 765549, 765914, 766279, 766644,
]

// Returns the number of days elapsed before January 1st of the given year.
function daysUntilYear(year: number) {
	if (year >= 1970 && year <= 2100) return DAYS_UNTIL_YEAR[year - 1970]
	return --year * 365 + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400)
}

// Returns the number of days between 1970-01-01 and the start of year.
function daysFromEpochToYear(year: number) {
	return daysUntilYear(year) - 719162 // daysUntilYear(1970)
}
