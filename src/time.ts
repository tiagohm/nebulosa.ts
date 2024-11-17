import { DAYSEC, DAYSPERJY, DTY, J2000, MJD0 } from './constants'
import { eraCalToJd } from './erfa'
import { twoProduct, twoSum } from './math'

// Holds the number of Julian days and the fraction of the day.
export type Time = [number, number]

export enum Timescale {
	UT1,
	UTC,
	TAI,
	TT,
	TCG,
	TDB,
	TCB,
}

export enum JulianCalendarCutOff {
	None = 0,
	GregorianStart = 2299161,
	GregorianStartEngland = 2361222,
}

// Computes the ΔT in seconds at [time].
export type TimeDelta = (time: Time) => number

export function time(day: number, fraction: number = 0): Time {
	return normalize(day, fraction)
}

// Times that represent the interval from a particular epoch as
// a floating point multiple of a unit time interval (e.g. seconds or days).
export function timeFromEpoch(epoch: number, unit: number, day: number, fraction: number = 0): Time {
	const [a, b] = normalize(epoch, 0.0, unit)
	day += a
	fraction += b

	const extra = Math.round(fraction)
	day += extra
	fraction -= extra

	return [day, fraction]
}

// Unix seconds from 1970-01-01 00:00:00 UTC, ignoring leap seconds.
// For example, 946684800.0 in Unix time is midnight on January 1, 2000.
// Must be used with UTC dates.
// This quantity is not exactly unix time and differs from the strict POSIX definition
// by up to 1 second on days with a leap second. POSIX unix time actually jumps backward by 1
// second at midnight on leap second days while this class value is monotonically increasing
// at 86400 seconds per UTC day.
export function timeUnix(seconds: number) {
	return timeFromEpoch(seconds, DAYSEC, 2440588.0, -0.5)
}

// Current time as Unix time.
export function timeNow() {
	return timeUnix(Date.now() / 1000)
}

// Modified Julian Date time format.
// This represents the number of days since midnight on November 17, 1858.
// For example, 51544.0 in MJD is midnight on January 1, 2000.
export function timeMJD(mjd: number) {
	return time(mjd + MJD0)
}

// Julian epoch year as floating point value like 2000.0.
export function timeJulian(epoch: number) {
	return time(J2000 + (epoch - 2000.0) * DAYSPERJY)
}

// Besselian epoch year as floating point value like 1950.0.
export function timeBesselian(epoch: number) {
	return timeMJD(15019.81352 + (epoch - 1900.0) * DTY)
}

// Time from [year], [month], [day], [hour], [minute] and [second].
export function timeYMDHMS(year: number, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0) {
	return normalize(MJD0 + eraCalToJd(year, month, day), (second + minute * 60.0 + hour * 3600.0) / DAYSEC)
}

// Returns the sum of [day] and [fraction] as two 64-bit floats,
// with the latter guaranteed to be within -0.5 and 0.5 (inclusive on
// either side, as the integer is rounded to even).
// The arithmetic is all done with exact floating point operations so no
// precision is lost to rounding error. It is assumed the sum is less
// than about 1E16, otherwise the remainder will be greater than 1.0.
export function normalize(day: number, fraction: number, divisor: number = 0): [number, number] {
	let [sum, err] = twoSum(day, fraction)
	day = Math.round(sum)
	let [extra, frac] = twoSum(sum, -day)
	frac += extra + err

	if (divisor != 0 && isFinite(divisor)) {
		const q = sum / divisor
		const [a, b] = twoProduct(q, divisor)
		const [c, d] = twoSum(sum, -a)
		;[sum, err] = twoSum(q, (c + (d + err - b)) / divisor)
	}

	// Our fraction can now have gotten >0.5 or <-0.5, which means we would
	// loose one bit of precision. So, correct for that.
	day += Math.round(frac)
	;[extra, frac] = twoSum(sum, -day)
	frac += extra + err

	return [day, frac]
}
