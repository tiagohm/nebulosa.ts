// julian.js, Chapter 7, Julian day.
/**
 * @copyright 2013 Sonia Keys
 * @copyright 2016 commenthol
 * @license MIT
 * @module julian
 */
/**
 * Julian: Chapter 7, Julian day.
 */

import * as base from './base.js'

const SECS_OF_DAY = 86400 // 24 * 60 * 60

// Returns delta T in seconds, defaulting to zero because the original deltat module is not ported.
export function deltaTSeconds (decimalYear) {
  return typeof deltaTProvider === 'function' ? deltaTProvider(decimalYear) : 0
}

// Sets the delta T provider used by JDE and TD conversions.
export function setDeltaTProvider (provider) {
  deltaTProvider = provider
}

let deltaTProvider

// Converts seconds of time to signed hours, minutes, and seconds.
function secondsToHms (seconds) {
  let time = seconds
  const neg = time < 0
  time = neg ? -time : time
  const hour = Math.trunc(time / 3600)
  time -= hour * 3600
  const minute = Math.trunc(time / 60)
  const second = time - minute * 60
  return [neg, hour, minute, second]
}

/**
 * Base class for CalendarJulian and CalendarGregorian
 * Respects the start of the Gregorian Calendar at `GREGORIAN0JD`
 */
export class Calendar {
  /**
   * @param {number|Date} [year] - If `Date` is given then year, month, day is taken from that. Shortcut to `new Calendar().fromDate(date)`
   * @param {number} [month]
   * @param {number} [day]
   */
  constructor (year, month = 1, day = 1) {
    if (year instanceof Date) {
      this.fromDate(year)
    } else {
      this.year = year
      this.month = month
      this.day = day
    }
  }

  getDate () {
    return {
      year: this.year,
      month: this.month,
      day: Math.floor(this.day)
    }
  }

  getTime () {
    const [neg, h, m, _s] = secondsToHms(this.day * SECS_OF_DAY) // eslint-disable-line no-unused-vars
    let [s, ms] = base.modf(_s)
    ms = Math.trunc(ms * 1000)
    return {
      hour: h % 24,
      minute: m,
      second: s,
      millisecond: ms
    }
  }

  toISOString () {
    const { year, month, day } = this.getDate()
    const { hour, minute, second, millisecond } = this.getTime()
    return `${pad(year, 4)}-${pad(month)}-${pad(day)}T` +
      `${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(millisecond, 3)}Z`
  }

  isGregorian () {
    return isCalendarGregorian(this.year, this.month, this.day)
  }

  /**
   * Note: Take care for dates < GREGORIAN0JD as `date` is always within the
   * proleptic Gregorian Calender
   * @param {Date} date - proleptic Gregorian date
   */
  fromDate (date) {
    this.year = date.getUTCFullYear()
    this.month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    const hour = date.getUTCHours()
    const minute = date.getUTCMinutes()
    const second = date.getUTCSeconds()
    const ms = date.getMilliseconds()
    this.day = day + (hour + ((minute + ((second + ms / 1000) / 60)) / 60)) / 24
    return this
  }

  /**
   * Note: Take care for dates < GREGORIAN0JD as `date` is always within the
   * proleptic Gregorian Calender
   * @returns {Date} proleptic Gregorian date
   */
  toDate () {
    const [day, fhour] = base.modf(this.day)
    const [hour, fminute] = base.modf(fhour * 24)
    const [minute, fsecond] = base.modf(fminute * 60)
    const [second, fms] = base.modf(fsecond * 60)
    const date = new Date(Date.UTC(
      this.year, this.month - 1, day, hour, minute, second, Math.round(fms * 1000)
    ))
    date.setUTCFullYear(this.year)
    return date
  }

  /**
   * converts a calendar date to decimal year
   * @returns {number} decimal year
   */
  toYear () {
    const [d, f] = base.modf(this.day) // eslint-disable-line no-unused-vars
    const n = this.dayOfYear() - 1 + f
    const days = this.isLeapYear() ? 366 : 365
    const decYear = this.year + (n / days)
    return decYear
  }

  /**
   * converts a decimal year to a calendar date
   * @param {number} year - decimal year
   */
  fromYear (year) {
    const [y, f] = base.modf(year)
    this.year = y
    const days = this.isLeapYear() ? 366 : 365
    const dayOfYear = base.round(f * days, 5)
    let m = 12
    while (m > 0 && DAYS_OF_YEAR[m] > dayOfYear) {
      m--
    }
    this.month = m
    this.day = 1 + dayOfYear - DAYS_OF_YEAR[this.month]
    return this
  }

  isLeapYear () {
    if (this.isGregorian()) {
      return LeapYearGregorian(this.year)
    } else {
      return LeapYearJulian(this.year)
    }
  }

  toJD () {
    return CalendarToJD(this.year, this.month, this.day, !this.isGregorian())
  }

  fromJD (jd) {
    const isJulian = !isJDCalendarGregorian(jd)
    const { year, month, day } = JDToCalendar(jd, isJulian)
    this.year = year
    this.month = month
    this.day = day
    return this
  }

  fromJDE (jde) {
    this.fromJD(jde)
    const dT = deltaTSeconds(this.toYear()) // in seconds
    this.day -= dT / 86400
    return this
  }

  toJDE () {
    const dT = deltaTSeconds(this.toYear()) // in seconds
    this.day += dT / 86400
    return this.toJD()
  }

  /**
   * set date to midnight UTC
   */
  midnight () {
    this.day = Math.floor(this.day)
    return this
  }

  /**
   * set date to noon UTC
   */
  noon () {
    this.day = Math.floor(this.day) + 0.5
    return this
  }

  /**
   * @param {Boolean} td - if `true` calendar instance is in TD; date gets converted to UT
   *   true  - `UT = TD - deltaT`
   *   false - `TD = UT + deltaT`
   */
  deltaT (td) {
    const dT = deltaTSeconds(this.toYear()) // in seconds
    if (td) {
      this.day -= dT / 86400
    } else {
      this.day += dT / 86400
    }
    return this
  }

  dayOfWeek () {
    return DayOfWeek(this.toJD())
  }

  dayOfYear () {
    if (this.isGregorian()) {
      return DayOfYearGregorian(this.year, this.month, this.day)
    } else {
      return DayOfYearJulian(this.year, this.month, this.day)
    }
  }
}

export class CalendarJulian extends Calendar {
  toJD () {
    return CalendarJulianToJD(this.year, this.month, this.day)
  }

  fromJD (jd) {
    const { year, month, day } = JDToCalendarJulian(jd)
    this.year = year
    this.month = month
    this.day = day
    return this
  }

  isLeapYear () {
    return LeapYearJulian(this.year)
  }

  dayOfYear () {
    return DayOfYearJulian(this.year, this.month, this.day)
  }

  /**
   * toGregorian converts a Julian calendar date to a year, month, and day
   * in the Gregorian calendar.
   * @returns {CalendarGregorian}
   */
  toGregorian () {
    const jd = this.toJD()
    return new CalendarGregorian().fromJD(jd)
  }
}

export class CalendarGregorian extends Calendar {
  toJD () {
    return CalendarGregorianToJD(this.year, this.month, this.day)
  }

  fromJD (jd) {
    const { year, month, day } = JDToCalendarGregorian(jd)
    this.year = year
    this.month = month
    this.day = day
    return this
  }

  isLeapYear () {
    return LeapYearGregorian(this.year)
  }

  dayOfYear () {
    return DayOfYearGregorian(this.year, this.month, this.day)
  }

  /*
  * toJulian converts a Gregorian calendar date to a year, month, and day
  * in the Julian calendar.
  * @returns {CalendarJulian}
  */
  toJulian () {
    const jd = this.toJD()
    return new CalendarJulian().fromJD(jd)
  }
}

// -----------------------------------------------------------------------------

/**
 * JDToDate converts a Julian day `jd` to a Date Object (Gregorian Calendar)
 *
 * Note: Javascript uses the the ISO-8601 calendar, which is a proleptic Gregorian
 * calendar, i.e. it acts as if this calendar was always in effect, even before
 * its year of introduction in 1582. Therefore dates between 1582-10-05 and
 * 1582-10-14 exists.
 *
 * @param {number} jd - Julian day (float)
 * @returns {Date}
 */
export function JDToDate (jd) {
  return new CalendarGregorian().fromJD(jd).toDate()
}

/**
 * DateToJD converts a proleptic Gregorian Date into a Julian day `jd`
 * @param {Date} date
 * @returns {number} jd - Julian day (float)
 */
export function DateToJD (date) {
  return new CalendarGregorian().fromDate(date).toJD()
}

/**
 * JDEToDate converts a Julian ephemeris day `jde` to a Date Object (Gregorian Calendar)
 * To obtain "Universal Time" (UT) from "Dynamical Time" (TD) the correction deltaT (in seconds) gets applied
 * ```
 * UT = TD - deltaT
 * ```
 * If your use case does not require such accuracy converting `jde` using `JDToDate` is fine.
 *
 * Note: Javascript uses the the ISO-8601 calendar, which is a proleptic Gregorian
 * calendar, i.e. it acts as if this calendar was always in effect, even before
 * its year of introduction in 1582. Therefore dates between 1582-10-05 and
 * 1582-10-14 exists.
 *
 * @param {number} jde - Julian ephemeris day
 * @returns {Date} Javascript Date Object
 */
export function JDEToDate (jde) {
  return new CalendarGregorian().fromJDE(jde).toDate()
}

/**
 * DateToJDE converts a Date Object (Gregorian Calendar) to a Julian ephemeris day `jde`
 * To obtain "Dynamical Time" (TD) from "Universal Time" (UT) the correction deltaT (in seconds) gets applied
 * ```
 * TD = UT + deltaT
 * ```
 * If your use case does not require such accuracy converting `Date` using `DateToJD` is fine.
 *
 * @param {Date} date - Javascript Date Object
 * @returns {number} jde - Julian ephemeris day (float)
 */
export function DateToJDE (date) {
  return new CalendarGregorian().fromDate(date).toJDE()
}

/**
 * DayOfYearToCalendarGregorian returns the calendar month and day for a given
 * day of year.
 * @param {number} year
 * @param {number} n - day of year (int)
 * @returns {CalendarGregorian} { (int) year, (int) month, (float) day }
 */
export function DayOfYearToCalendarGregorian (year, n) {
  const { month, day } = DayOfYearToCalendar(n, LeapYearGregorian(year))
  return new CalendarGregorian(year, month, day)
}

/**
 * DayOfYearToCalendarJulian returns the calendar month and day for a given
 * day of year.
 * @param {number} year
 * @param {number} n - day of year (int)
 * @returns {CalendarJulian} { (int) year, (int) month, (float) day }
 */
export function DayOfYearToCalendarJulian (year, n) {
  const { month, day } = DayOfYearToCalendar(n, LeapYearJulian(year))
  return new CalendarJulian(year, month, day)
}

function pad (num, len) {
  len = len || 2
  const neg = num < 0 ? '-' : ''
  num = Math.abs(num)
  const padded = ('0000' + num)
  return neg + padded.substr(padded.length - len, len)
}
