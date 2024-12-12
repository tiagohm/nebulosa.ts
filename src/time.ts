/* eslint-disable no-extra-semi */
import type { Angle } from './angle'
import { DAYSEC, DAYSPERJY, DTY, J2000, MJD0 } from './constants'
import { eraCalToJd, eraSp00, eraTaiTt, eraTaiUtc, eraUt1Utc, eraUtcUt1 } from './erfa'
import { iersab } from './iers'
import { twoProduct, twoSum } from './math'
import type { Mat3 } from './matrix'
import { rotX } from './matrix'

// Holds the number of Julian days and the fraction of the day.
export type Time = [number, number, Timescale]

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
export interface TimeDelta {
	delta(time: Time): number
}

export interface PolarMotion {
	xy(time: Time): [Angle, Angle]
}

// Computes the motion angles (sprime, x, y) from the specified [time].
export function pmAngles(pm: PolarMotion, time: Time): [Angle, Angle, Angle] {
	time = tt(time)
	const sprime = eraSp00(time[0], time[1])
	const [x, y] = pm.xy(time)
	return [sprime, x, y]
}

// Computes the motion matrix from the specified [time].
export function pmMatrix(pm: PolarMotion, time: Time): Mat3 {
	const [sprime, x, y] = pmAngles(pm, time)
	return rotX(y).rotY(x).rotZ(-sprime)
}

export function time(day: number, fraction: number = 0, scale: Timescale = Timescale.UTC): Time {
	return normalize(day, fraction, 0, scale)
}

// Times that represent the interval from a particular epoch as
// a floating point multiple of a unit time interval (e.g. seconds or days).
export function timeFromEpoch(epoch: number, unit: number, day: number, fraction: number = 0, scale: Timescale = Timescale.UTC): Time {
	const [a, b] = normalize(epoch, 0.0, unit)
	day += a
	fraction += b

	const extra = Math.round(fraction)
	day += extra
	fraction -= extra

	return [day, fraction, scale]
}

// Unix seconds from 1970-01-01 00:00:00 UTC, ignoring leap seconds.
// For example, 946684800.0 in Unix time is midnight on January 1, 2000.
// Must be used with UTC dates.
// This quantity is not exactly unix time and differs from the strict POSIX definition
// by up to 1 second on days with a leap second. POSIX unix time actually jumps backward by 1
// second at midnight on leap second days while this class value is monotonically increasing
// at 86400 seconds per UTC day.
export function timeUnix(seconds: number, scale: Timescale = Timescale.UTC) {
	return timeFromEpoch(seconds, DAYSEC, 2440588.0, -0.5, scale)
}

// Current time as Unix time.
export function timeNow() {
	return timeUnix(Date.now() / 1000, Timescale.UTC)
}

// Modified Julian Date time format.
// This represents the number of days since midnight on November 17, 1858.
// For example, 51544.0 in MJD is midnight on January 1, 2000.
export function timeMJD(mjd: number, scale: Timescale = Timescale.UTC) {
	return time(mjd + MJD0, 0, scale)
}

// Julian epoch year as floating point value like 2000.0.
export function timeJulian(epoch: number, scale: Timescale = Timescale.UTC) {
	return time(J2000 + (epoch - 2000.0) * DAYSPERJY, 0, scale)
}

// Besselian epoch year as floating point value like 1950.0.
export function timeBesselian(epoch: number, scale: Timescale = Timescale.UTC) {
	return timeMJD(15019.81352 + (epoch - 1900.0) * DTY, scale)
}

// Time from [year], [month], [day], [hour], [minute] and [second].
export function timeYMDHMS(year: number, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0, scale: Timescale = Timescale.UTC) {
	return time(MJD0 + eraCalToJd(year, month, day), (second + minute * 60.0 + hour * 3600.0) / DAYSEC, scale)
}

/// GPS time from 1980-01-06 00:00:00 UTC.
export function timeGPS(seconds: number) {
	return timeFromEpoch(seconds, DAYSEC, 2444245.0, -0.4997800925925926, Timescale.TAI)
}

// Returns the sum of [day] and [fraction] as two 64-bit floats,
// with the latter guaranteed to be within -0.5 and 0.5 (inclusive on
// either side, as the integer is rounded to even).
// The arithmetic is all done with exact floating point operations so no
// precision is lost to rounding error. It is assumed the sum is less
// than about 1E16, otherwise the remainder will be greater than 1.0.
export function normalize(day: number, fraction: number, divisor: number = 0, scale: Timescale = Timescale.UTC): Time {
	let [sum, err] = twoSum(day, fraction)
	day = Math.round(sum)
	let [extra, frac] = twoSum(sum, -day)
	frac += extra + err

	if (divisor && isFinite(divisor)) {
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

	return [day, frac, scale]
}

/// Converts to UT1 Time.
export function ut1(time: Time): Time {
	const ret = [0, 0, Timescale.UT1]

	switch (time[2]) {
		case Timescale.UTC:
			;[ret[0], ret[1]] = eraUtcUt1(time[0], time[1], iersab.delta(time))
			break
		case Timescale.TAI:
			return time
		case Timescale.TT:
			return time
		case Timescale.TCG:
			return time
		case Timescale.TDB:
			return time
		case Timescale.TCB:
			return time
		default:
			return time
	}

	return ret as Time
}

/// Converts to UTC Time.
export function utc(time: Time): Time {
	const ret = [0, 0, Timescale.UTC]

	switch (time[2]) {
		case Timescale.UT1:
			;[ret[0], ret[1]] = eraUt1Utc(time[0], time[1], iersab.delta(time))
			break
		case Timescale.TAI:
			;[ret[0], ret[1]] = eraTaiUtc(time[0], time[1])
			break
		case Timescale.TT:
			return time
		case Timescale.TCG:
			return time
		case Timescale.TDB:
			return time
		case Timescale.TCB:
			return time
		default:
			return time
	}

	return ret as Time
}

/// Converts to TAI Time.
export function tai(time: Time): Time {
	const ret = [0, 0, Timescale.TAI]

	switch (time[2]) {
		case Timescale.UT1:
			return time
		case Timescale.UTC:
			return time
		case Timescale.TT:
			;[ret[0], ret[1]] = eraTaiTt(time[0], time[1])
			break
		case Timescale.TCG:
			return time
		case Timescale.TDB:
			return time
		case Timescale.TCB:
			return time
		default:
			return time
	}

	return ret as Time
}

/// Converts to TT Time.
export function tt(time: Time): Time {
	const ret = [0, 0, Timescale.TT]

	switch (time[2]) {
		case Timescale.UT1:
			return time
		case Timescale.UTC:
			return time
		case Timescale.TAI:
			;[ret[0], ret[1]] = eraTaiTt(time[0], time[1])
			break
		case Timescale.TCG:
			return time
		case Timescale.TDB:
			return time
		case Timescale.TCB:
			return time
		default:
			return time
	}

	return ret as Time
}
