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

	time = Math.abs(time)

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
const LOWERCASE_SHORT_MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const PATTERN_SYMBOLS = 'YMDHmsS'

export function parseTemporal(input: string, pattern: string): Temporal {
	const date: TemporalDate = [0, 0, 0, 0, 0, 0, 0]
	const tokens = tokenizePattern(pattern)

	for (const { start, end, found } of tokens) {
		if (end > input.length) break

		const p = pattern.substring(start, end)
		const i = input.substring(start, end)

		if (found) {
			switch (p) {
				case 'YYYY':
					date[0] = +i
					break
				case 'YY':
					date[0] = +i + 2000
					break
				case 'MMM':
					date[1] = LOWERCASE_SHORT_MONTH_NAMES.indexOf(i.toLowerCase()) + 1
					break
				case 'MM':
					date[1] = +i
					break
				case 'DD':
					date[2] = +i
					break
				case 'HH':
					date[3] = +i
					break
				case 'mm':
					date[4] = +i
					break
				case 'ss':
					date[5] = +i
					break
				case 'SSS':
					date[6] = +i
					break
				default:
					throw new Error(`invalid pattern found: ${p}`)
			}
		}
	}

	if (date[0] === 0 || date[1] === 0 || date[2] === 0) {
		throw new Error('invalid date')
	}

	return temporalFromDate(...date)
}

export function formatTemporalFromPattern(temporal: Temporal, pattern: string) {
	const tokens = tokenizePattern(pattern)
	const output: string[] = []
	const date = pattern.includes('Y') || pattern.includes('M') || pattern.includes('D') ? temporalToDate(temporal) : undefined

	for (const { start, end, found } of tokens) {
		const text = pattern.substring(start, end)

		if (found) {
			switch (text) {
				case 'YYYY':
					output.push(date![0].toFixed(0).padStart(4, '0'))
					break
				case 'YYY':
					output.push(date![0].toFixed(0))
					break
				case 'YY':
					output.push((date![0] % 100).toFixed(0).padStart(2, '0'))
					break
				case 'Y':
					output.push((date![0] % 100).toFixed(0))
					break
				case 'MMMM':
					output.push(MONTH_NAMES[date![1] - 1])
					break
				case 'MMM':
					output.push(SHORT_MONTH_NAMES[date![1] - 1])
					break
				case 'MM':
					output.push(date![1].toFixed(0).padStart(2, '0'))
					break
				case 'M':
					output.push(date![1].toFixed(0))
					break
				case 'DD':
					output.push(date![2].toFixed(0).padStart(2, '0'))
					break
				case 'D':
					output.push(date![2].toFixed(0))
					break
				case 'HH':
					output.push(temporalGet(temporal, 'h').toFixed(0).padStart(2, '0'))
					break
				case 'H':
					output.push(temporalGet(temporal, 'h').toFixed(0))
					break
				case 'mm':
					output.push(temporalGet(temporal, 'm').toFixed(0).padStart(2, '0'))
					break
				case 'm':
					output.push(temporalGet(temporal, 'm').toFixed(0))
					break
				case 'ss':
					output.push(temporalGet(temporal, 's').toFixed(0).padStart(2, '0'))
					break
				case 's':
					output.push(temporalGet(temporal, 's').toFixed(0))
					break
				case 'SSS':
					output.push(temporalGet(temporal, 'ms').toFixed(0).padStart(3, '0'))
					break
				case 'S':
					output.push(temporalGet(temporal, 'ms').toFixed(0))
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
	end: number
	readonly found: boolean
}

function tokenizePattern(pattern: string): Readonly<PatternToken>[] {
	const tokens: PatternToken[] = []
	let state = 0 // 0 = not initialized, 1 = pattern found, 2 = pattern not found
	let position = 0
	let prev = ''

	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]

		const found = PATTERN_SYMBOLS.includes(c)
		const token = tokens[position] ?? { start: i, end: i + 1, found }
		tokens[position] = token

		if (state === 0) {
			state = found ? 1 : 2
		} else if (c === prev) {
			token.end++
		} else {
			tokens[++position] = { start: i, end: i + 1, found }
			state = found ? 1 : 2
		}

		prev = c
	}

	return tokens
}

export function isLeapYear(year: number) {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number) {
	return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
}

const DAYS_UNTIL_YEAR = [
	719162, 719527, 719892, 720258, 720623, 720988, 721353, 721719, 722084, 722449, 722814, 723180, 723545, 723910, 724275, 724641, 725006, 725371, 725736, 726102, 726467, 726832, 727197, 727563, 727928, 728293, 728658, 729024, 729389, 729754, 730119, 730485, 730850, 731215, 731580, 731946, 732311, 732676, 733041,
	733407, 733772, 734137, 734502, 734868, 735233, 735598, 735963, 736329, 736694, 737059, 737424, 737790, 738155, 738520, 738885, 739251, 739616, 739981, 740346, 740712, 741077, 741442, 741807, 742173, 742538, 742903, 743268, 743634, 743999, 744364, 744729, 745095, 745460, 745825, 746190, 746556, 746921, 747286,
	747651, 748017, 748382, 748747, 749112, 749478, 749843, 750208, 750573, 750939, 751304, 751669, 752034, 752400, 752765, 753130, 753495, 753861, 754226, 754591, 754956, 755322, 755687, 756052, 756417, 756783, 757148, 757513, 757878, 758244, 758609, 758974, 759339, 759705, 760070, 760435, 760800, 761166, 761531,
	761896, 762261, 762627, 762992, 763357, 763722, 764088, 764453, 764818, 765183, 765549, 765914, 766279, 766644,
]

function daysUntilYear(year: number): number {
	if (year >= 1970 && year <= 2100) return DAYS_UNTIL_YEAR[year - 1970]
	return --year * 365 + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400)
}

function daysFromEpochToYear(year: number): number {
	return daysUntilYear(year) - 719162 // daysUntilYear(1970)
}
