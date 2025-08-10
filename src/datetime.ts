import dayjs, { type ConfigType, type Dayjs } from 'dayjs'
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
import { type Time, toUnix } from './time'

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

// Gets the current date and time
export function dateNow(isUtc: boolean = false): DateTime {
	return isUtc ? dayjs.utc() : dayjs()
}

// Creates a date from a variety of input formats
export function dateFrom(date: Exclude<ConfigType, null | undefined>, isUtc: boolean = false): DateTime {
	if (Array.isArray(date) && date[1] !== undefined) date[1]--
	return isUtc ? dayjs.utc(date) : dayjs(date)
}

// Creates a date from a Time instance.
export function dateFromTime(time: Time) {
	return dateUnix(toUnix(time))
}

// Creates a date from year, month, day, hour, minute, second, and millisecond
export function dateYMDHMS(year: number, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0, millisecond: number = 0, isUtc: boolean = false): DateTime {
	return dateFrom([year, month, day, hour, minute, second, millisecond], isUtc)
}

// Creates a date from a Unix timestamp
export function dateUnix(seconds: number): DateTime {
	return dayjs.unix(seconds)
}
