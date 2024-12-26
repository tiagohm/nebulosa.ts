import type { Angle } from './angle'
import { DAYSEC, DAYSPERJC, DAYSPERJY, DTY, J2000, MJD0 } from './constants'
import { eraCalToJd, eraDat, eraDtDb, eraEra00, eraGmst06, eraGst06a, eraJdToCal, eraNut06a, eraObl06, eraPmat06, eraPnm06a, eraPom00, eraSp00, eraTaiTt, eraTaiUt1, eraTaiUtc, eraTcbTdb, eraTcgTt, eraTdbTcb, eraTdbTt, eraTtTai, eraTtTcg, eraTtTdb, eraUt1Tai, eraUt1Utc, eraUtcTai, eraUtcUt1 } from './erfa'
import { delta } from './iers'
import { itrs } from './itrs'
import { type Location } from './location'
import { twoProduct, twoSum } from './math'
import { clone, identity, mul, rotX, rotZ, type Mat3, type MutMat3 } from './matrix'

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

export interface TimeExtra {
	ut1?: Time
	utc?: Time
	tai?: Time
	tt?: Time
	tcg?: Time
	tdb?: Time
	tcb?: Time

	ut1MinusUtc?: number
	ut1MinusTai?: number
	taiMinusUtc?: number
	tdbMinusTt?: number

	gast?: Angle
	gmst?: Angle
	era?: Angle
	meanObliquity?: Angle
	nutation?: readonly [Angle, Angle]
	precession?: Mat3
	precessionNutation?: Mat3
	pmAngles?: readonly [Angle, Angle, Angle] // sprime, x, y
	pmMatrix?: Mat3
	equationOfOrigins?: Mat3
}

// Represents and manipulates an instant of time for astronomy.
export interface Time {
	readonly day: number
	readonly fraction: number
	readonly scale: Timescale

	tdbMinusTt?: TimeDelta
	// taiMinusUtc?: TimeDelta
	ut1MinusTai?: TimeDelta
	ut1MinusUtc?: TimeDelta

	location?: Location
	extra?: TimeExtra
}

export enum JulianCalendarCutOff {
	None = 0,
	GregorianStart = 2299161,
	GregorianStartEngland = 2361222,
}

// Computes the ΔT in seconds at time.
export type TimeDelta = (time: Time) => number

// The displaced angles (longitude and latitude) of rotation of the Earth's spin axis about its geographic axis.
export type PolarMotion = (time: Time) => [Angle, Angle]

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const noPolarMotion = (time: Time) => [0, 0]

// Computes the motion angles (sprime, x, y) from the specified time.
export function pmAngles(pm: PolarMotion, time: Time): readonly [Angle, Angle, Angle] {
	if (time.extra?.pmAngles) return time.extra.pmAngles
	const t = tt(time)
	const sprime = eraSp00(t.day, t.fraction)
	const [x, y] = pm(time)
	const a: [Angle, Angle, Angle] = [sprime, x, y]
	extra(time).pmAngles = a
	return a
}

// Computes the polar motion matrix from the specified time.
export function pmMatrix(pm: PolarMotion, time: Time): Mat3 {
	if (time.extra?.pmMatrix) return time.extra.pmMatrix
	const [sprime, x, y] = pmAngles(pm, time)
	const m = eraPom00(x, y, sprime)
	extra(time).pmMatrix = m
	return m
}

export function time(day: number, fraction: number = 0, scale: Timescale = Timescale.UTC, normalized: boolean = true): Time {
	return normalized ? normalize(day, fraction, 0, scale) : { day, fraction, scale }
}

// Times that represent the interval from a particular epoch as
// a floating point multiple of a unit time interval (e.g. seconds or days).
export function timeFromEpoch(epoch: number, unit: number, day: number, fraction: number = 0, scale: Timescale = Timescale.UTC): Time {
	const normalized = normalize(epoch, 0, unit)
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
	return timeFromEpoch(seconds, DAYSEC, 2440588, -0.5, scale)
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
	return time(J2000 + (epoch - 2000) * DAYSPERJY, 0, scale)
}

// Besselian epoch year as floating point value like 1950.0.
export function timeBesselian(epoch: number, scale: Timescale = Timescale.UTC) {
	return timeMJD(15019.81352 + (epoch - 1900) * DTY, scale)
}

// Time from year, month, day, hour, minute and second.
export function timeYMDHMS(year: number, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0, scale: Timescale = Timescale.UTC) {
	return time(MJD0 + eraCalToJd(year, month, day), (second + minute * 60 + hour * 3600) / DAYSEC, scale)
}

// GPS time from 1980-01-06 00:00:00 UTC.
export function timeGPS(seconds: number) {
	return timeFromEpoch(seconds, DAYSEC, 2444245, -0.4997800925925926, Timescale.TAI)
}

// Returns the sum of day and fraction as two 64-bit floats,
// with the latter guaranteed to be within -0.5 and 0.5 (inclusive on
// either side, as the integer is rounded to even).
// The arithmetic is all done with exact floating point operations so no
// precision is lost to rounding error. It is assumed the sum is less
// than about 1E16, otherwise the remainder will be greater than 1.
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

function timescale(target: Time, source: Time) {
	const e = extra(target, source.extra)

	switch (source.scale) {
		case Timescale.UT1:
			e.ut1 = source
			break
		case Timescale.UTC:
			e.utc = source
			break
		case Timescale.TAI:
			e.tai = source
			break
		case Timescale.TT:
			e.tt = source
			break
		case Timescale.TCG:
			e.tcg = source
			break
		case Timescale.TDB:
			e.tdb = source
			break
		case Timescale.TCB:
			e.tcb = source
			break
	}

	if (source.location) target.location = source.location
}

function extra(target: Time, extra?: TimeExtra) {
	return (target.extra ??= extra ?? {})
}

// Converts to UT1 Time.
export function ut1(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.UT1) return time
	if (time.extra?.ut1) return time.extra.ut1

	let ret: Time

	if (scale === Timescale.TAI) ret = makeTime(eraTaiUt1(day, fraction, (time.ut1MinusTai ?? ut1MinusTai)(time)), time, Timescale.UT1)
	else if (scale === Timescale.UTC) ret = makeTime(eraUtcUt1(day, fraction, (time.ut1MinusUtc ?? ut1MinusUtc)(time)), time, Timescale.UT1)
	else ret = ut1(utc(time))

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts to UTC Time.
export function utc(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.UTC) return time
	if (time.extra?.utc) return time.extra.utc

	let ret: Time

	if (scale === Timescale.UT1) ret = makeTime(eraUt1Utc(day, fraction, (time.ut1MinusUtc ?? ut1MinusUtc)(time)), time, Timescale.UTC)
	else if (scale === Timescale.TAI) ret = makeTime(eraTaiUtc(day, fraction), time, Timescale.UTC)
	else ret = utc(tai(time))

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts to TAI Time.
export function tai(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TAI) return time
	if (time.extra?.tai) return time.extra.tai

	let ret: Time

	if (scale === Timescale.UT1) ret = makeTime(eraUt1Tai(day, fraction, (time.ut1MinusTai ?? ut1MinusTai)(time)), time, Timescale.TAI)
	else if (scale === Timescale.UTC) ret = makeTime(eraUtcTai(day, fraction), time, Timescale.TAI)
	else if (scale === Timescale.TT) ret = makeTime(eraTtTai(day, fraction), time, Timescale.TAI)
	else ret = tai(tt(time))

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts to TT Time.
export function tt(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TT) return time
	if (time.extra?.tt) return time.extra.tt

	let ret: Time

	if (scale === Timescale.TAI) ret = makeTime(eraTaiTt(day, fraction), time, Timescale.TT)
	else if (scale === Timescale.TCG) ret = makeTime(eraTcgTt(day, fraction), time, Timescale.TT)
	else if (scale === Timescale.TDB) ret = makeTime(eraTdbTt(day, fraction, (time.tdbMinusTt ?? tdbMinusTt)(time)), time, Timescale.TT)
	else if (scale < Timescale.TAI) return tt(tai(time))
	else ret = tt(tdb(time))

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts to TCG Time.
export function tcg(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TCG) return time
	if (time.extra?.tcg) return time.extra.tcg

	let ret: Time

	if (scale === Timescale.TT) ret = makeTime(eraTtTcg(day, fraction), time, Timescale.TCG)
	else ret = tcg(tt(time))

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts to TDB Time.
export function tdb(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TDB) return time
	if (time.extra?.tdb) return time.extra.tdb

	let ret: Time

	if (scale === Timescale.TT) ret = makeTime(eraTtTdb(day, fraction, (time.tdbMinusTt ?? tdbMinusTt)(time)), time, Timescale.TDB)
	else if (scale === Timescale.TCB) ret = makeTime(eraTcbTdb(day, fraction), time, Timescale.TDB)
	else ret = tdb(tt(time))

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts to TCB Time.
export function tcb(time: Time): Time {
	const { day, fraction, scale } = time
	if (scale === Timescale.TCB) return time
	if (time.extra?.tcb) return time.extra.tcb

	let ret: Time

	if (scale === Timescale.TDB) ret = makeTime(eraTdbTcb(day, fraction), time, Timescale.TCB)
	else ret = tcb(tdb(time))

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Computes the Greenwich Apparent Sidereal Time (GAST) at given time.
export function gast(time: Time): Angle {
	if (time.extra?.gast) return time.extra.gast
	const u = ut1(time)
	const t = tt(time)
	const gast = eraGst06a(u.day, u.fraction, t.day, t.fraction)
	extra(time).gast = gast
	return gast
}

// Computes the Greenwich Mean Sidereal Time (GMST) at given time.
export function gmst(time: Time): Angle {
	if (time.extra?.gmst) return time.extra.gmst
	const u = ut1(time)
	const t = tt(time)
	const gmst = eraGmst06(u.day, u.fraction, t.day, t.fraction)
	extra(time).gmst = gmst
	return gmst
}

// Computes the Earth rotation angle (IAU 2000 model) at given time.
export function era(time: Time): Angle {
	if (time.extra?.era) return time.extra.era
	const u = ut1(time)
	const era = eraEra00(u.day, u.fraction)
	extra(time).era = era
	return era
}

// Computes the mean obliquity of the ecliptic.
export function meanObliquity(time: Time): Angle {
	if (time.extra?.meanObliquity) return time.extra.meanObliquity
	const t = tt(time)
	const meanObliquity = eraObl06(t.day, t.fraction)
	extra(time).meanObliquity = meanObliquity
	return meanObliquity
}

// Computes the true obliquity of the ecliptic.
export function trueObliquity(time: Time): Angle {
	return meanObliquity(time) + nutation(time)[1]
}

// Computes the rotation matrix of the true obliquity of the ecliptic.
export function trueEclipticRotation(time: Time): MutMat3 {
	return rotX(trueObliquity(time), clone(precessionNutation(time)))
}

// Computes the nutation angles.
export function nutation(time: Time): readonly [Angle, Angle] {
	if (time.extra?.nutation) return time.extra.nutation
	const t = tt(time)
	const nutation = eraNut06a(t.day, t.fraction)
	extra(time).nutation = nutation
	return nutation
}

// Computes the 3x3 precession matrix.
export function precession(time: Time): Mat3 {
	if (time.extra?.precession) return time.extra.precession
	const t = tt(time)
	const precession = eraPmat06(t.day, t.fraction)
	extra(time).precession = precession
	return precession
}

// Computes the 3x3 precession-nutation matrix (including frame bias).
export function precessionNutation(time: Time): Mat3 {
	if (time.extra?.precessionNutation) return time.extra.precessionNutation
	const t = tt(time)
	const precessionNutation = eraPnm06a(t.day, t.fraction)
	extra(time).precessionNutation = precessionNutation
	return precessionNutation
}

// Computes the 3x3 matrix of Equation of Origins in cycles.
export function equationOfOrigins(time: Time): Mat3 {
	if (time.extra?.equationOfOrigins) return time.extra.equationOfOrigins
	const equationOfOrigins = identity()
	mul(rotZ(gast(time) - era(time), equationOfOrigins), precessionNutation(time), equationOfOrigins)
	extra(time).equationOfOrigins = equationOfOrigins
	return equationOfOrigins
}

// Computes UT1 - UTC in seconds at time.
export const ut1MinusUtc: TimeDelta = (time) => {
	if (time.extra?.ut1MinusUtc) return time.extra.ut1MinusUtc

	// https://github.com/astropy/astropy/blob/71a2eafd6c09f1992f8b4132e6e40ba68a675bde/astropy/time/core.py#L2554
	// Interpolate UT1-UTC in IERS table
	let dt = delta(time)

	// If we interpolated using UT1, we may be off by one
	// second near leap seconds (and very slightly off elsewhere)
	if (time.scale === Timescale.UT1) {
		const a = eraUt1Utc(time.day, time.fraction, dt)
		// Calculate a better estimate using the nearly correct UTC
		dt = delta({ day: a[0], fraction: a[1], scale: Timescale.UTC })
	}

	extra(time).ut1MinusUtc = dt

	return dt
}

// Computes TDB - TT in seconds at time.
export const tdbMinusTt: TimeDelta = (time) => {
	const { day, fraction, scale } = time

	if (scale === Timescale.TDB || scale === Timescale.TT) {
		if (time.extra?.tdbMinusTt) return time.extra.tdbMinusTt

		// First go from the current input time (which is either
		// TDB or TT) to an approximate UT1. Since TT and TDB are
		// pretty close (few msec?), assume TT. Similarly, since the
		// UT1 terms are very small, use UTC instead of UT1.
		// https://github.com/astropy/astropy/blob/71a2eafd6c09f1992f8b4132e6e40ba68a675bde/astropy/time/core.py#L2597
		const a = eraTaiUtc(...eraTtTai(day, fraction))

		// Subtract 0.5, so UT is fraction of the day from midnight
		const ut = normalize(a[0] - 0.5, a[1]).fraction

		let dt = 0

		if (time.location) {
			const [x, y, z] = itrs(time.location)
			dt = eraDtDb(day, fraction, ut, time.location.longitude, Math.hypot(x, y), z)
		} else {
			dt = eraDtDb(day, fraction, ut)
		}

		extra(time).tdbMinusTt = dt

		return dt
	}

	return 0
}

// Computes TDB - TT in seconds at time.
export const tdbMinusTtByFairheadAndBretagnon1990: TimeDelta = (time) => {
	// Given that the two time scales never diverge by more than 2ms, TT
	// can also be given as the argument to perform the conversion in the
	// other direction.
	if (time.scale === Timescale.TDB || time.scale === Timescale.TT) {
		const t = (time.day - J2000 + time.fraction) / DAYSPERJC

		// USNO Circular 179, eq. 2.6.
		return 0.001657 * Math.sin(628.3076 * t + 6.2401) + 0.000022 * Math.sin(575.3385 * t + 4.297) + 0.000014 * Math.sin(1256.6152 * t + 6.1969) + 0.000005 * Math.sin(606.9777 * t + 4.0212) + 0.000005 * Math.sin(52.9691 * t + 0.4444) + 0.000002 * Math.sin(21.3299 * t + 5.5431) + 0.00001 * t * Math.sin(628.3076 * t + 4.249)
	} else {
		return 0
	}
}

// Computes TAI - UTC in seconds at time.
export const taiMinusUtc: TimeDelta = (time) => {
	if (time.extra?.taiMinusUtc) return time.extra.taiMinusUtc
	const cal = eraJdToCal(time.day, time.fraction)
	const dt = eraDat(cal[0], cal[1], cal[2], cal[3])
	extra(time).taiMinusUtc = dt
	return dt
}

// Computes UT1 - TAI in seconds at time.
export const ut1MinusTai: TimeDelta = (time) => {
	if (time.extra?.ut1MinusTai) return time.extra.ut1MinusTai
	const cal = eraJdToCal(time.day, time.fraction)
	const dat = eraDat(cal[0], cal[1], cal[2], cal[3])
	const dut1 = (time.ut1MinusUtc ?? ut1MinusUtc)(time)
	const dt = dut1 - dat
	extra(time).ut1MinusTai = dt
	return dt
}
