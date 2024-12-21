import type { Angle } from './angle'
import { DAYSEC, DAYSPERJY, DTY, J2000, MJD0, TTMINUSTAI } from './constants'
import { eraCalToJd, eraDat, eraDtDb, eraJdToCal, eraSp00, eraTaiTt, eraTaiUt1, eraTaiUtc, eraTcbTdb, eraTcgTt, eraTdbTcb, eraTdbTt, eraTtTai, eraTtTcg, eraTtTdb, eraUt1Tai, eraUt1Utc, eraUtcTai, eraUtcUt1 } from './erfa'
import { iersab } from './iers'
import { twoProduct, twoSum } from './math'
import type { Mat3 } from './matrix'
import { rotX } from './matrix'

// Holds the number of Julian days and the fraction of the day.
export type Time = readonly [number, number, Timescale]

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

// Computes the ΔT in seconds at time.
export type TimeDelta = (time: Time) => number

// The displaced angles (longitude and latitude) of rotation of the Earth’s spin axis about its geographic axis.
export type PolarMotion = (time: Time) => [Angle, Angle]

// Computes the motion angles (sprime, x, y) from the specified [time].
export function pmAngles(pm: PolarMotion, time: Time): [Angle, Angle, Angle] {
	time = tt(time)
	const sprime = eraSp00(time[0], time[1])
	const [x, y] = pm(time)
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
	const [a, b, scale] = time
	if (scale === Timescale.UT1) return time
	else if (scale === Timescale.TAI) return eraTaiUt1(a, b, ut1MinusTai(time))
	else if (scale === Timescale.UTC) return eraUtcUt1(a, b, iersab.delta(time))
	else return ut1(utc(time))
}

/// Converts to UTC Time.
export function utc(time: Time): Time {
	const [a, b, scale] = time
	if (scale === Timescale.UTC) return time
	else if (scale === Timescale.UT1) return eraUt1Utc(a, b, iersab.delta(time))
	else if (scale === Timescale.TAI) return eraTaiUtc(a, b)
	else return utc(tai(time))
}

/// Converts to TAI Time.
export function tai(time: Time): Time {
	const [a, b, scale] = time
	if (scale === Timescale.TAI) return time
	else if (scale === Timescale.UT1) return eraUt1Tai(a, b, ut1MinusTai(time))
	else if (scale === Timescale.UTC) return eraUtcTai(a, b)
	else if (scale === Timescale.TT) return eraTtTai(a, b)
	else return tai(tt(time))
}

/// Converts to TT Time.
export function tt(time: Time): Time {
	const [a, b, scale] = time
	if (scale === Timescale.TT) return time
	else if (scale === Timescale.TAI) return eraTaiTt(a, b)
	else if (scale === Timescale.TCG) return eraTcgTt(a, b)
	else if (scale === Timescale.TDB) return eraTdbTt(a, b, tdbMinusTt(time))
	else if (scale < Timescale.TAI) return tt(tai(time))
	else return tt(tdb(time))
}

/// Converts to TCG Time.
export function tcg(time: Time): Time {
	const [a, b, scale] = time
	if (scale === Timescale.TCG) return time
	else if (scale === Timescale.TT) return eraTtTcg(a, b)
	else return tcg(tt(time))
}

/// Converts to TDB Time.
export function tdb(time: Time): Time {
	const [a, b, scale] = time
	if (scale === Timescale.TDB) return time
	else if (scale === Timescale.TT) return eraTtTdb(a, b, tdbMinusTt(time))
	else if (scale === Timescale.TCB) return eraTcbTdb(a, b)
	else return tdb(tt(time))
}

/// Converts to TCB Time.
export function tcb(time: Time): Time {
	const [a, b, scale] = time
	if (scale === Timescale.TCB) return time
	else if (scale === Timescale.TDB) return eraTdbTcb(a, b)
	else return tcb(tdb(time))
}

// Computes TDB - TT in seconds at time.
export const tdbMinusTt: TimeDelta = (time) => {
	const [whole, fraction, scale] = time

	if (scale === Timescale.TDB || scale === Timescale.TT) {
		const ut = normalize(whole - 0.5, fraction - TTMINUSTAI / DAYSEC)[1]

		// TODO:
		// return if (time.location != null) {
		//     val (x, y, z) = time.location
		//     val rxy = hypot(x, y) / 1000.0
		//     val elong = if (location is GeodeticLocation) location.longitude else 0.0
		//     eraDtDb(whole, fraction, ut, elong, rxy, z / 1000.0)
		// } else {
		//     eraDtDb(time.whole, time.fraction, ut)
		// }

		return eraDtDb(whole, fraction, ut)
	}

	return 0
}

// Computes TAI - UTC in seconds at time.
export const taiMinusUtc: TimeDelta = (time) => {
	const cal = eraJdToCal(time[0], time[1])
	return eraDat(cal[0], cal[1], cal[2], cal[3])
}

// Computes UT1 - TAI in seconds at time.
export const ut1MinusTai: TimeDelta = (time) => {
	const cal = eraJdToCal(time[0], time[1])
	const dat = eraDat(cal[0], cal[1], cal[2], cal[3])
	const dut1 = iersab.delta(time)
	return dut1 - dat
}
