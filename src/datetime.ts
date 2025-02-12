import dayjs, { type ConfigType, type ConfigTypeMap, type Dayjs } from 'dayjs'
import arraySupport from 'dayjs/plugin/arraySupport'
import dayOfYear from 'dayjs/plugin/dayOfYear'
import isBetween from 'dayjs/plugin/isBetween'
import isLeapYear from 'dayjs/plugin/isLeapYear'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore'
import isToday from 'dayjs/plugin/isToday'
import isTomorrow from 'dayjs/plugin/isTomorrow'
import isYesterday from 'dayjs/plugin/isYesterday'
import minMax from 'dayjs/plugin/minMax'
// import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)
dayjs.extend(arraySupport)
dayjs.extend(dayOfYear)
dayjs.extend(isBetween)
dayjs.extend(isLeapYear)
dayjs.extend(isSameOrAfter)
dayjs.extend(isSameOrBefore)
dayjs.extend(isToday)
dayjs.extend(isTomorrow)
dayjs.extend(isYesterday)
dayjs.extend(minMax)
// dayjs.extend(timezone)

export type DateTime = Dayjs

export function now(isUtc: boolean = false): DateTime {
	return isUtc ? dayjs.utc() : dayjs()
}

export function dateFrom(date: Exclude<ConfigType, ConfigTypeMap['arraySupport'] | null | undefined>, isUtc: boolean = false): DateTime {
	return isUtc ? dayjs.utc(date) : dayjs(date)
}

export function dateYMDHMS(year: number, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0, millsecond: number = 0): DateTime {
	return dayjs([year, month - 1, day, hour, minute, second, millsecond])
}

export function dateUnix(date: number): DateTime {
	return dayjs.unix(date)
}

export function formatDate(date: DateTime | Date, template?: string) {
	date = date instanceof Date ? dateFrom(date) : date
	return date.format(template)
}
