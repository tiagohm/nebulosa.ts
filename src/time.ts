import type { Angle } from './angle'
import { DAYSEC, DAYSPERJY, DTY, J2000, MJD0, TTMINUSTAI } from './constants'
import { eraCalToJd, eraDat, eraDtDb, eraJdToCal, eraSp00, eraTaiTt, eraTaiUt1, eraTaiUtc, eraTcbTdb, eraTcgTt, eraTdbTcb, eraTdbTt, eraTtTai, eraTtTcg, eraTtTdb, eraUt1Tai, eraUt1Utc, eraUtcTai, eraUtcUt1 } from './erfa'
import { iersab } from './iers'
import { twoProduct, twoSum } from './math'
import type { Mat3 } from './matrix'
import { rotX } from './matrix'

// The specification for measuring time.
export enum Timescale {
	UT1,
	UTC,
	TAI,
	TT,
	TCG,
	TDB,
	TCB,
}

export interface TimeMemoize {
	ut1?: Time
	utc?: Time
	tai?: Time
	tt?: Time
	tcg?: Time
	tdb?: Time
	tcb?: Time
}

// Represents and manipulates an instant of time for astronomy.
export interface Time {
	readonly day: number
	readonly fraction: number
	readonly scale: Timescale

	tdbMinusTt?: TimeDelta
	// taiMinusUtc?: TimeDelta
	ut1MinusTai?: TimeDelta

	memoize?: TimeMemoize
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

// Computes the motion angles (sprime, x, y) from the specified time.
export function pmAngles(pm: PolarMotion, time: Time): [Angle, Angle, Angle] {
	time = tt(time)
	const sprime = eraSp00(time.day, time.fraction)
	const [x, y] = pm(time)
	return [sprime, x, y]
}

// Computes the motion matrix from the specified time.
export function pmMatrix(pm: PolarMotion, time: Time): Mat3 {
	const [sprime, x, y] = pmAngles(pm, time)
	return rotX(y).rotY(x).rotZ(-sprime)
}

export function time(day: number, fraction: number = 0, scale: Timescale = Timescale.UTC, normalized: boolean = true): Time {
	return normalized ? normalize(day, fraction, 0, scale) : { day, fraction, scale }
}

// Times that represent the interval from a particular epoch as
// a floating point multiple of a unit time interval (e.g. seconds or days).
export function timeFromEpoch(epoch: number, unit: number, day: number, fraction: number = 0, scale: Timescale = Timescale.UTC): Time {
	const normalized = normalize(epoch, 0.0, unit)
	day += normalized.day
	fraction += normalized.fraction

	const extra = Math.round(fraction)
	day += extra
	fraction -= extra

	return { day, fraction, scale }
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
	fraction = frac + extra + err

	return { day, fraction, scale }
}

function makeTime(a: [number, number], time: Time, scale: Timescale = time.scale): Time {
	return { ...time, day: a[0], fraction: a[1], scale }
}

function memoize(source: Time, target: Time, scale: Timescale = target.scale) {
	source.memoize ??= {}

	switch (scale) {
		case Timescale.UT1:
			source.memoize.ut1 = target
			break
		case Timescale.UTC:
			source.memoize.utc = target
			break
		case Timescale.TAI:
			source.memoize.tai = target
			break
		case Timescale.TT:
			source.memoize.tt = target
			break
		case Timescale.TCG:
			source.memoize.tcg = target
			break
		case Timescale.TDB:
			source.memoize.tdb = target
			break
		case Timescale.TCB:
			source.memoize.tcb = target
			break
	}
}

/// Converts to UT1 Time.
export function ut1(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.UT1) return time
	if (time.memoize?.ut1) return time.memoize.ut1

	let ret: Time

	if (scale === Timescale.TAI) ret = makeTime(eraTaiUt1(day, fraction, (time.ut1MinusTai ?? ut1MinusTai)(time)), time, Timescale.UT1)
	else if (scale === Timescale.UTC) ret = makeTime(eraUtcUt1(day, fraction, iersab.delta(time)), time, Timescale.UT1)
	else ret = ut1(utc(time))

	memoize(ret, time)
	memoize(time, ret)

	return ret
}

/// Converts to UTC Time.
export function utc(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.UTC) return time
	if (time.memoize?.utc) return time.memoize.utc

	let ret: Time

	if (scale === Timescale.UT1) ret = makeTime(eraUt1Utc(day, fraction, iersab.delta(time)), time, Timescale.UTC)
	else if (scale === Timescale.TAI) ret = makeTime(eraTaiUtc(day, fraction), time, Timescale.UTC)
	else ret = utc(tai(time))

	memoize(ret, time)
	memoize(time, ret)

	return ret
}

/// Converts to TAI Time.
export function tai(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TAI) return time
	if (time.memoize?.tai) return time.memoize.tai

	let ret: Time

	if (scale === Timescale.UT1) ret = makeTime(eraUt1Tai(day, fraction, (time.ut1MinusTai ?? ut1MinusTai)(time)), time, Timescale.TAI)
	else if (scale === Timescale.UTC) ret = makeTime(eraUtcTai(day, fraction), time, Timescale.TAI)
	else if (scale === Timescale.TT) ret = makeTime(eraTtTai(day, fraction), time, Timescale.TAI)
	else ret = tai(tt(time))

	memoize(ret, time)
	memoize(time, ret)

	return ret
}

/// Converts to TT Time.
export function tt(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TT) return time
	if (time.memoize?.tt) return time.memoize.tt

	let ret: Time

	if (scale === Timescale.TAI) ret = makeTime(eraTaiTt(day, fraction), time, Timescale.TT)
	else if (scale === Timescale.TCG) ret = makeTime(eraTcgTt(day, fraction), time, Timescale.TT)
	else if (scale === Timescale.TDB) ret = makeTime(eraTdbTt(day, fraction, (time.tdbMinusTt ?? tdbMinusTt)(time)), time, Timescale.TT)
	else if (scale < Timescale.TAI) return tt(tai(time))
	else ret = tt(tdb(time))

	memoize(ret, time)
	memoize(time, ret)

	return ret
}

/// Converts to TCG Time.
export function tcg(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TCG) return time
	if (time.memoize?.tcg) return time.memoize.tcg

	let ret: Time

	if (scale === Timescale.TT) ret = makeTime(eraTtTcg(day, fraction), time, Timescale.TCG)
	else ret = tcg(tt(time))

	memoize(ret, time)
	memoize(time, ret)

	return ret
}

/// Converts to TDB Time.
export function tdb(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TDB) return time
	if (time.memoize?.tdb) return time.memoize.tdb

	let ret: Time

	if (scale === Timescale.TT) ret = makeTime(eraTtTdb(day, fraction, (time.tdbMinusTt ?? tdbMinusTt)(time)), time, Timescale.TDB)
	else if (scale === Timescale.TCB) ret = makeTime(eraTcbTdb(day, fraction), time, Timescale.TDB)
	else ret = tdb(tt(time))

	memoize(ret, time)
	memoize(time, ret)

	return ret
}

/// Converts to TCB Time.
export function tcb(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TCB) return time
	if (time.memoize?.tcb) return time.memoize.tcb

	let ret: Time

	if (scale === Timescale.TDB) ret = makeTime(eraTdbTcb(day, fraction), time, Timescale.TCB)
	else ret = tcb(tdb(time))

	memoize(ret, time)
	memoize(time, ret)

	return ret
}

// Computes TDB - TT in seconds at time.
export const tdbMinusTt: TimeDelta = (time) => {
	const { day, fraction, scale } = time

	if (scale === Timescale.TDB || scale === Timescale.TT) {
		const ut = normalize(day - 0.5, fraction - TTMINUSTAI / DAYSEC).fraction

		// TODO:
		// return if (time.location != null) {
		//     val (x, y, z) = time.location
		//     val rxy = hypot(x, y) / 1000.0
		//     val elong = if (location is GeodeticLocation) location.longitude else 0.0
		//     eraDtDb(day, fraction, ut, elong, rxy, z / 1000.0)
		// } else {
		//     eraDtDb(time.day, time.fraction, ut)
		// }

		return eraDtDb(day, fraction, ut)
	}

	return 0
}

// Computes TDB - TT in seconds at time.
export const tdbMinusTtByFairheadAndBretagnon1990: TimeDelta = (time) => {
	// Given that the two time scales never diverge by more than 2ms, TT
	// can also be given as the argument to perform the conversion in the
	// other direction.
	if (time.scale === Timescale.TDB || time.scale === Timescale.TT) {
		const t = (time.day - J2000 + time.fraction) / 36525.0

		// USNO Circular 179, eq. 2.6.
		return 0.001657 * Math.sin(628.3076 * t + 6.2401) + 0.000022 * Math.sin(575.3385 * t + 4.297) + 0.000014 * Math.sin(1256.6152 * t + 6.1969) + 0.000005 * Math.sin(606.9777 * t + 4.0212) + 0.000005 * Math.sin(52.9691 * t + 0.4444) + 0.000002 * Math.sin(21.3299 * t + 5.5431) + 0.00001 * t * Math.sin(628.3076 * t + 4.249)
	} else {
		return 0
	}
}

// Computes TAI - UTC in seconds at time.
export const taiMinusUtc: TimeDelta = (time) => {
	const cal = eraJdToCal(time.day, time.fraction)
	return eraDat(cal[0], cal[1], cal[2], cal[3])
}

// Computes UT1 - TAI in seconds at time.
export const ut1MinusTai: TimeDelta = (time) => {
	const cal = eraJdToCal(time.day, time.fraction)
	const dat = eraDat(cal[0], cal[1], cal[2], cal[3])
	const dut1 = iersab.delta(time)
	return dut1 - dat
}
