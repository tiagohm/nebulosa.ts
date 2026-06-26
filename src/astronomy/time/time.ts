import { DAYSEC, DAYSPERJC, DAYSPERJY, DAYSPERTY, J2000, MJD0 } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
// oxfmt-ignore
import { eraC2i06a, eraC2teqx, eraCalToJd, eraDat, eraDtDb, eraEra00, eraGmst06, eraGst06a, eraJdToCal, eraNut06a, eraObl06, eraPmat06, eraPnm06a, eraPom00, eraSp00, eraTaiTt, eraTaiUt1, eraTaiUtc, eraTcbTdb, eraTcgTt, eraTdbTcb, eraTdbTt, eraTtTai, eraTtTcg, eraTtTdb, eraUt1Tai, eraUt1Utc, eraUtcTai, eraUtcUt1 } from '../coordinates/erfa/erfa'
import { type Mat3, matClone, matIdentity, matMul, matRotX, matRotZ } from '../../math/linear-algebra/mat3'
import { twoProduct, twoSum, type NumberArray } from '../../math/numerical/math'
import { itrs } from '../coordinates/itrs'
import type { GeographicPosition } from '../observer/location'
import * as iers from './iers'

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

export interface TimeCache {
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
	cirsRotation?: Mat3
	pmAngles?: readonly [Angle, Angle, Angle] // sprime, x, y
	pmAnglesPolarMotion?: PolarMotion
	pmMatrix?: Mat3
	pmMatrixPolarMotion?: PolarMotion
	equationOfOrigins?: Mat3
	gcrsToItrsRotationMatrix?: Mat3
}

export interface TimeProviders {
	pm?: PolarMotion
	dut1?: TimeDelta // UT1 - UTC

	tdbMinusTt?: TimeDelta
	// taiMinusUtc?: TimeDelta
	ut1MinusTai?: TimeDelta

	gast?: (ut1: Time, tt: Time) => Angle
	gmst?: (ut1: Time, tt: Time) => Angle
	era?: (ut1: Time) => Angle
	obl?: (tt: Time) => Angle
	nut?: (tt: Time) => [Angle, Angle]
	pmat?: (tt: Time) => Mat3
	pnm?: (tt: Time) => Mat3
	sp?: (tt: Time) => Angle
	pom?: (x: Angle, y: Angle, s: Angle) => Mat3
}

// Represents and manipulates an instant of time for astronomy.
export interface Time {
	readonly day: number
	readonly fraction: number
	readonly scale: Timescale

	providers?: TimeProviders

	location?: GeographicPosition
	cache?: TimeCache
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

export const NO_POLAR_MOTION: PolarMotion = () => [0, 0]

const UNIX_EPOCH_DAY = 2440588
const UNIX_EPOCH_FRACTION = -0.5
const DAYSEC_MS = DAYSEC * 1000

// Returns the polar motion provider used for this computation.
function polarMotionProvider(time: Time, pm?: PolarMotion): PolarMotion {
	return pm ?? time.providers?.pm ?? iers.xy
}

// Computes the motion angles (sprime, x, y) from the given time.
export function pmAngles(time: Time, pm?: PolarMotion): readonly [Angle, Angle, Angle] {
	const polarMotion = polarMotionProvider(time, pm)
	if (time.cache?.pmAngles !== undefined && time.cache.pmAnglesPolarMotion === polarMotion) return time.cache.pmAngles
	const t = tt(time)
	const sprime = time.providers?.sp?.(t) ?? eraSp00(t.day, t.fraction)
	const [x, y] = polarMotion(time)
	const a: [Angle, Angle, Angle] = [sprime, x, y]
	const c = cache(time)
	c.pmAngles = a
	c.pmAnglesPolarMotion = polarMotion
	return a
}

// Computes the polar motion matrix from the given time.
export function pmMatrix(time: Time, pm?: PolarMotion): Mat3 {
	const polarMotion = polarMotionProvider(time, pm)
	if (time.cache?.pmMatrix !== undefined && time.cache.pmMatrixPolarMotion === polarMotion) return time.cache.pmMatrix
	const [sprime, x, y] = pmAngles(time, polarMotion)
	const m = time.providers?.pom?.(x, y, sprime) ?? eraPom00(x, y, sprime)
	const c = cache(time)
	c.pmMatrix = m
	c.pmMatrixPolarMotion = polarMotion
	return m
}

export function time(day: number, fraction: number = 0, scale: Timescale = Timescale.UTC) {
	return timeNormalize(day, fraction, 0, scale)
}

// Times that represent the interval from a particular epoch as
// a floating point multiple of a unit time interval (e.g. seconds or days).
export function timeFromEpoch(epoch: number, unit: number, day: number, fraction: number = 0, scale: Timescale = Timescale.UTC): Time {
	const normalized = timeNormalize(epoch, 0, unit)
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
export function timeUnix(seconds: number, fast: boolean = false) {
	if (fast) {
		const offsetDays = Math.trunc(seconds / DAYSEC)
		let day = UNIX_EPOCH_DAY + offsetDays
		let fraction = (seconds - offsetDays * DAYSEC) / DAYSEC + UNIX_EPOCH_FRACTION

		if (fraction > 0.5) {
			day++
			fraction--
		} else if (fraction < -0.5) {
			day--
			fraction++
		}

		return { day, fraction, scale: Timescale.UTC }
	} else {
		return timeFromEpoch(seconds, DAYSEC, UNIX_EPOCH_DAY, UNIX_EPOCH_FRACTION, Timescale.UTC)
	}
}

// Current time as Unix time.
export function timeNow(fast: boolean = false) {
	return timeUnix(Date.now() / 1000, fast)
}

// Modified Julian Date time format.
// This represents the number of days since midnight on November 17, 1858.
// For example, 51544.0 in MJD is midnight on January 1, 2000.
export function timeMJD(mjd: number, scale: Timescale = Timescale.UTC) {
	return time(mjd + MJD0, 0, scale)
}

// Julian epoch year as floating point value like 2000.0.
export function timeJulianYear(epoch: number, scale: Timescale = Timescale.TT) {
	return time(J2000 + (epoch - 2000) * DAYSPERJY, 0, scale)
}

// Besselian epoch year as floating point value like 1950.0.
export function timeBesselianYear(epoch: number, scale: Timescale = Timescale.TT) {
	return timeMJD(15019.81352 + (epoch - 1900) * DAYSPERTY, scale)
}

// Time from year, month, day, hour, minute and second.
export function timeYMDHMS(year: number, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0, second: number = 0, scale: Timescale = Timescale.UTC) {
	return time(MJD0 + eraCalToJd(year, month, day), (second + minute * 60 + hour * 3600) / DAYSEC, scale)
}

// Time from year, month, day.
export function timeYMD(year: number, month: number = 1, day: number = 1, fraction: number = 0, scale: Timescale = Timescale.UTC) {
	return time(MJD0 + eraCalToJd(year, month, day), fraction, scale)
}

// GPS time from 1980-01-06 00:00:00 UTC.
export function timeGPS(seconds: number) {
	return timeFromEpoch(seconds, DAYSEC, 2444245, -0.4997800925925926, Timescale.TAI)
}

const NORMALIZED_TIME = new Float64Array(2)

function normalizeDayAndFraction(day: number, fraction: number, divisor: number, out: NumberArray) {
	if ((day === 0 && fraction === 0) || (divisor === 0 && Number.isInteger(day) && fraction >= -0.5 && fraction < 0.5)) {
		out[0] = day
		out[1] = fraction

		return out
	}

	twoSum(day, fraction, NORMALIZED_TIME)

	if (divisor !== 0 && Number.isFinite(divisor)) {
		const q = NORMALIZED_TIME[0] / divisor
		const [a, b] = twoProduct(q, divisor)
		const [c, d] = twoSum(NORMALIZED_TIME[0], -a)
		twoSum(q, (c + (d + NORMALIZED_TIME[1] - b)) / divisor, NORMALIZED_TIME)
	}

	const sum = NORMALIZED_TIME[0]
	const err = NORMALIZED_TIME[1]
	day = Math.round(sum)
	twoSum(sum, -day, NORMALIZED_TIME)
	NORMALIZED_TIME[1] += NORMALIZED_TIME[0] + err

	// Our fraction can now have gotten >0.5 or <-0.5, which means we would
	// lose one bit of precision. So, correct for that.
	day += Math.round(NORMALIZED_TIME[1])
	twoSum(sum, -day, NORMALIZED_TIME)
	fraction = NORMALIZED_TIME[1] + NORMALIZED_TIME[0] + err

	out[0] = day
	out[1] = fraction

	return out
}

// Returns the sum of day and fraction as two 64-bit floats,
// with the latter guaranteed to be within -0.5 and 0.5 (inclusive on either side).
// The arithmetic is all done with exact floating point operations so no
// precision is lost to rounding error. It is assumed the sum is less
// than about 1E16, otherwise the remainder will be greater than 1.
export function timeNormalize(day: number, fraction: number, divisor: number = 0, scale: Timescale = Timescale.UTC): Time {
	normalizeDayAndFraction(day, fraction, divisor, NORMALIZED_TIME)
	return { day: NORMALIZED_TIME[0], fraction: NORMALIZED_TIME[1], scale }
}

// Subtracts two Times.
export function timeSubtract(a: Time, b: Time, scale: Timescale = a.scale) {
	const c = timeConvert(a, scale)
	const d = timeConvert(b, scale)
	return c.day - d.day + (c.fraction - d.fraction)
}

// Converts the time to year, month, day, hour, minute, second and nanosecond.
export function timeToDate(time: Time): [number, number, number, number, number, number, number] {
	const [year, month, day, fraction] = eraJdToCal(time.day, time.fraction)
	const hour = fraction * 24
	const minute = ((hour - Math.trunc(hour)) * 60) % 60
	const second = ((minute - Math.trunc(minute)) * 60) % 60
	const nano = (second - Math.trunc(second)) * 1000000000
	return [year, month, day, Math.trunc(hour), Math.trunc(minute), Math.trunc(second), Math.trunc(nano)]
}

// Converts the time to Unix timestamp.
export function timeToUnix(time: Time) {
	return Math.trunc(timeToUnixMillis(time) / 1000)
}

// Converts the time to Unix timestamp in milliseconds.
export function timeToUnixMillis(time: Time) {
	const { day, fraction } = utc(time)
	return Math.trunc((day - UNIX_EPOCH_DAY) * DAYSEC_MS + (fraction - UNIX_EPOCH_FRACTION) * DAYSEC_MS)
}

// Converts the time to Julian day.
export function toJulianDay(time: Time) {
	return time.day + time.fraction
}

// Clones a nearby sample instant while preserving custom Earth-orientation providers.
export function timeShift(time: Time, fraction: number): Time {
	const normalized = timeNormalize(time.day, time.fraction + fraction, undefined, time.scale)
	normalized.providers = time.providers
	normalized.location = time.location
	return normalized
}

// Builds a Time at a Julian Day, preserving the reference time scale and providers.
export function timeAtJulianDay(reference: Time, julianDay: number) {
	return timeShift(reference, julianDay - reference.day - reference.fraction)
}

// Caches the timescale for target based on source.
function timescale(target: Time, source: Time) {
	const c = cache(target, source.cache)

	if (source.scale === Timescale.UT1) c.ut1 = source
	else if (source.scale === Timescale.UTC) c.utc = source
	else if (source.scale === Timescale.TAI) c.tai = source
	else if (source.scale === Timescale.TT) c.tt = source
	else if (source.scale === Timescale.TCG) c.tcg = source
	else if (source.scale === Timescale.TDB) c.tdb = source
	else if (source.scale === Timescale.TCB) c.tcb = source

	if (source.location) target.location = source.location
}

// Returns the cache object, creating it if necessary.
export function cache(target: Time, cache?: TimeCache) {
	return (target.cache ??= cache ?? {})
}

// Converts the given time to the specified scale.
export function timeConvert(time: Time, scale: Timescale) {
	if (time.scale === scale) return time
	else if (scale === Timescale.UTC) return utc(time)
	else if (scale === Timescale.UT1) return ut1(time)
	else if (scale === Timescale.TAI) return tai(time)
	else if (scale === Timescale.TT) return tt(time)
	else if (scale === Timescale.TCG) return tcg(time)
	else if (scale === Timescale.TDB) return tdb(time)
	else if (scale === Timescale.TCB) return tcb(time)
	return time
}

const DAY_FRACTION: [number, number] = [0, 0]

// Converts the given time to UT1 Time.
export function ut1(time: Time) {
	const { day, fraction, scale } = time
	if (scale === Timescale.UT1) return time
	if (time.cache?.ut1 !== undefined) return time.cache.ut1

	if (scale === Timescale.TAI) {
		eraTaiUt1(day, fraction, (time.providers?.ut1MinusTai ?? ut1MinusTai)(time), DAY_FRACTION)
	} else if (scale === Timescale.UTC) {
		eraUtcUt1(day, fraction, (time.providers?.dut1 ?? dut1)(time), DAY_FRACTION)
	} else {
		const u = utc(time)
		eraUtcUt1(u.day, u.fraction, (time.providers?.dut1 ?? dut1)(u), DAY_FRACTION)
	}

	normalizeDayAndFraction(DAY_FRACTION[0], DAY_FRACTION[1], 0, DAY_FRACTION)
	const ret: Time = { ...time, day: DAY_FRACTION[0], fraction: DAY_FRACTION[1], scale: Timescale.UT1 }

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts the given time to UTC Time.
export function utc(time: Time) {
	const { day, fraction, scale } = time
	if (scale === Timescale.UTC) return time
	if (time.cache?.utc !== undefined) return time.cache.utc

	if (scale === Timescale.UT1) {
		eraUt1Utc(day, fraction, (time.providers?.dut1 ?? dut1)(time), DAY_FRACTION)
	} else if (scale === Timescale.TAI) {
		eraTaiUtc(day, fraction, DAY_FRACTION)
	} else {
		const t = tai(time)
		eraTaiUtc(t.day, t.fraction, DAY_FRACTION)
	}

	normalizeDayAndFraction(DAY_FRACTION[0], DAY_FRACTION[1], 0, DAY_FRACTION)
	const ret: Time = { ...time, day: DAY_FRACTION[0], fraction: DAY_FRACTION[1], scale: Timescale.UTC }

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts the given time to TAI Time.
export function tai(time: Time) {
	const { day, fraction, scale } = time
	if (scale === Timescale.TAI) return time
	if (time.cache?.tai !== undefined) return time.cache.tai

	if (scale === Timescale.UT1) {
		eraUt1Tai(day, fraction, (time.providers?.ut1MinusTai ?? ut1MinusTai)(time), DAY_FRACTION)
	} else if (scale === Timescale.UTC) {
		eraUtcTai(day, fraction, DAY_FRACTION)
	} else if (scale === Timescale.TT) {
		eraTtTai(day, fraction, DAY_FRACTION)
	} else {
		const t = tt(time)
		eraTtTai(t.day, t.fraction, DAY_FRACTION)
	}

	normalizeDayAndFraction(DAY_FRACTION[0], DAY_FRACTION[1], 0, DAY_FRACTION)
	const ret: Time = { ...time, day: DAY_FRACTION[0], fraction: DAY_FRACTION[1], scale: Timescale.TAI }

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts the given time to TT Time.
export function tt(time: Time) {
	const { day, fraction, scale } = time
	if (scale === Timescale.TT) return time
	if (time.cache?.tt !== undefined) return time.cache.tt

	if (scale === Timescale.TAI) {
		eraTaiTt(day, fraction, DAY_FRACTION)
	} else if (scale === Timescale.TCG) {
		eraTcgTt(day, fraction, DAY_FRACTION)
	} else if (scale === Timescale.TDB) {
		eraTdbTt(day, fraction, (time.providers?.tdbMinusTt ?? tdbMinusTt)(time), DAY_FRACTION)
	} else if (scale < Timescale.TAI) {
		const t = tai(time)
		eraTaiTt(t.day, t.fraction, DAY_FRACTION)
	} else {
		const t = tdb(time)
		eraTdbTt(t.day, t.fraction, (time.providers?.tdbMinusTt ?? tdbMinusTt)(t), DAY_FRACTION)
	}

	normalizeDayAndFraction(DAY_FRACTION[0], DAY_FRACTION[1], 0, DAY_FRACTION)
	const ret: Time = { ...time, day: DAY_FRACTION[0], fraction: DAY_FRACTION[1], scale: Timescale.TT }

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts the given time to TCG Time.
export function tcg(time: Time) {
	const { day, fraction, scale } = time
	if (scale === Timescale.TCG) return time
	if (time.cache?.tcg !== undefined) return time.cache.tcg

	if (scale === Timescale.TT) {
		eraTtTcg(day, fraction, DAY_FRACTION)
	} else {
		const t = tt(time)
		eraTtTcg(t.day, t.fraction, DAY_FRACTION)
	}

	normalizeDayAndFraction(DAY_FRACTION[0], DAY_FRACTION[1], 0, DAY_FRACTION)
	const ret: Time = { ...time, day: DAY_FRACTION[0], fraction: DAY_FRACTION[1], scale: Timescale.TCG }

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts the given time to TDB Time.
export function tdb(time: Time) {
	const { day, fraction, scale } = time
	if (scale === Timescale.TDB) return time
	if (time.cache?.tdb !== undefined) return time.cache.tdb

	if (scale === Timescale.TT) {
		eraTtTdb(day, fraction, (time.providers?.tdbMinusTt ?? tdbMinusTt)(time), DAY_FRACTION)
	} else if (scale === Timescale.TCB) {
		eraTcbTdb(day, fraction, DAY_FRACTION)
	} else {
		const t = tt(time)
		eraTtTdb(t.day, t.fraction, (time.providers?.tdbMinusTt ?? tdbMinusTt)(t), DAY_FRACTION)
	}

	normalizeDayAndFraction(DAY_FRACTION[0], DAY_FRACTION[1], 0, DAY_FRACTION)
	const ret: Time = { ...time, day: DAY_FRACTION[0], fraction: DAY_FRACTION[1], scale: Timescale.TDB }

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Converts the given time to TCB Time.
export function tcb(time: Time) {
	const { day, fraction, scale } = time
	if (scale === Timescale.TCB) return time
	if (time.cache?.tcb !== undefined) return time.cache.tcb

	if (scale === Timescale.TDB) {
		eraTdbTcb(day, fraction, DAY_FRACTION)
	} else {
		const t = tdb(time)
		eraTdbTcb(t.day, t.fraction, DAY_FRACTION)
	}

	normalizeDayAndFraction(DAY_FRACTION[0], DAY_FRACTION[1], 0, DAY_FRACTION)
	const ret: Time = { ...time, day: DAY_FRACTION[0], fraction: DAY_FRACTION[1], scale: Timescale.TCB }

	timescale(ret, time)
	timescale(time, ret)

	return ret
}

// Computes the Greenwich Apparent Sidereal Time (GAST) at given time.
export function greenwichApparentSiderealTime(time: Time): Angle {
	const cached = time.cache?.gast
	if (cached !== undefined) return cached
	const u = ut1(time)
	const t = tt(time)
	const gast = time.providers?.gast?.(u, t) ?? eraGst06a(u.day, u.fraction, t.day, t.fraction)
	cache(time).gast = gast
	return gast
}

// Computes the Greenwich Mean Sidereal Time (GMST) at given time.
export function greenwichMeanSiderealTime(time: Time): Angle {
	const cached = time.cache?.gmst
	if (cached !== undefined) return cached
	const u = ut1(time)
	const t = tt(time)
	const gmst = time.providers?.gmst?.(u, t) ?? eraGmst06(u.day, u.fraction, t.day, t.fraction)
	cache(time).gmst = gmst
	return gmst
}

// Computes the Earth rotation angle (IAU 2000 model) at given time.
export function earthRotationAngle(time: Time): Angle {
	const cached = time.cache?.era
	if (cached !== undefined) return cached
	const u = ut1(time)
	const era = time.providers?.era?.(u) ?? eraEra00(u.day, u.fraction)
	cache(time).era = era
	return era
}

// Computes the mean obliquity of the ecliptic.
export function meanObliquity(time: Time): Angle {
	const cached = time.cache?.meanObliquity
	if (cached !== undefined) return cached
	const t = tt(time)
	const meanObliquity = time.providers?.obl?.(t) ?? eraObl06(t.day, t.fraction)
	cache(time).meanObliquity = meanObliquity
	return meanObliquity
}

// Computes the true obliquity of the ecliptic.
export function trueObliquity(time: Time): Angle {
	return meanObliquity(time) + nutationAngles(time)[1]
}

// Computes the rotation matrix of the true obliquity of the ecliptic.
export function trueEclipticRotation(time: Time) {
	return matRotX(trueObliquity(time), matClone(precessionNutationMatrix(time)))
}

// Computes the nutation angles.
export function nutationAngles(time: Time): readonly [Angle, Angle] {
	if (time.cache?.nutation !== undefined) return time.cache.nutation
	const t = tt(time)
	const nutation = time.providers?.nut?.(t) ?? eraNut06a(t.day, t.fraction)
	cache(time).nutation = nutation
	return nutation
}

// Computes the 3x3 precession matrix.
export function precessionMatrix(time: Time): Mat3 {
	if (time.cache?.precession !== undefined) return time.cache.precession
	const t = tt(time)
	const precession = time.providers?.pmat?.(t) ?? eraPmat06(t.day, t.fraction)
	cache(time).precession = precession
	return precession
}

// Computes the 3x3 precession-nutation matrix (including frame bias).
export function precessionNutationMatrix(time: Time): Mat3 {
	if (time.cache?.precessionNutation !== undefined) return time.cache.precessionNutation
	const t = tt(time)
	const precessionNutation = time.providers?.pnm?.(t) ?? eraPnm06a(t.day, t.fraction)
	cache(time).precessionNutation = precessionNutation
	return precessionNutation
}

// Computes the 3x3 CIO-based GCRS -> CIRS (celestial-to-intermediate) rotation matrix.
// Unlike precessionNutationMatrix, which is equinox based and places right ascension on the
// true equinox, this matrix places it on the CIO. It is the correct companion to the CIO/ERA
// based observed conversions (cirsToObserved/observedToCirs, which use eraAtioq/eraAtoiq):
// pairing the equinox matrix with those routines offsets RA by the equation of origins, which
// is zero at J2000 but grows ~50 arcsec/year. Cached on the time instance.
export function cirsRotationMatrix(time: Time): Mat3 {
	if (time.cache?.cirsRotation !== undefined) return time.cache.cirsRotation
	const t = tt(time)
	const cirsRotation = eraC2i06a(t.day, t.fraction)
	cache(time).cirsRotation = cirsRotation
	return cirsRotation
}

// Computes the 3x3 matrix of Equation of Origins in cycles.
export function equationOfOrigins(time: Time): Mat3 {
	if (time.cache?.equationOfOrigins !== undefined) return time.cache.equationOfOrigins
	const equationOfOrigins = matIdentity()
	matMul(matRotZ(greenwichApparentSiderealTime(time) - earthRotationAngle(time), equationOfOrigins), precessionNutationMatrix(time), equationOfOrigins)
	cache(time).equationOfOrigins = equationOfOrigins
	return equationOfOrigins
}

// Computes the GCRS to ITRS rotation matrix at time.
export function gcrsToItrsRotationMatrix(time: Time) {
	if (time.cache?.gcrsToItrsRotationMatrix !== undefined) return time.cache.gcrsToItrsRotationMatrix
	const gcrsToItrsRotationMatrix = eraC2teqx(precessionNutationMatrix(time), greenwichApparentSiderealTime(time), pmMatrix(time))
	cache(time).gcrsToItrsRotationMatrix = gcrsToItrsRotationMatrix
	return gcrsToItrsRotationMatrix
}

// Computes UT1 - UTC in seconds at time.
export const dut1: TimeDelta = (time) => {
	const cached = time.cache?.ut1MinusUtc
	if (cached !== undefined) return cached

	const ut1MinusUtc = time.providers?.dut1 ?? iers.dut1

	// https://github.com/astropy/astropy/blob/71a2eafd6c09f1992f8b4132e6e40ba68a675bde/astropy/time/core.py#L2554
	// Interpolate UT1-UTC in IERS table
	let dt = ut1MinusUtc(time)

	// If we interpolated using UT1, we may be off by one
	// second near leap seconds (and very slightly off elsewhere)
	if (time.scale === Timescale.UT1) {
		const a = eraUt1Utc(time.day, time.fraction, dt, DAY_FRACTION)
		// Calculate a better estimate using the nearly correct UTC
		dt = ut1MinusUtc({ day: a[0], fraction: a[1], scale: Timescale.UTC })
	}

	cache(time).ut1MinusUtc = dt

	return dt
}

// Computes TDB - TT in seconds at time.
export const tdbMinusTt: TimeDelta = (time) => {
	const { day, fraction, scale } = time

	if (scale === Timescale.TDB || scale === Timescale.TT) {
		const cached = time.cache?.tdbMinusTt
		if (cached !== undefined) return cached

		// First go from the current input time (which is either
		// TDB or TT) to an approximate UT1. Since TT and TDB are
		// pretty close (few msec?), assume TT. Similarly, since the
		// UT1 terms are very small, use UTC instead of UT1.
		// https://github.com/astropy/astropy/blob/71a2eafd6c09f1992f8b4132e6e40ba68a675bde/astropy/time/core.py#L2597
		eraTtTai(day, fraction, DAY_FRACTION)
		const a = eraTaiUtc(DAY_FRACTION[0], DAY_FRACTION[1], DAY_FRACTION)

		// Subtract 0.5, so UT is fraction of the day from midnight
		const ut = normalizeDayAndFraction(a[0] - 0.5, a[1], 0, DAY_FRACTION)[1]

		let dt = 0

		if (time.location) {
			const [x, y, z] = itrs(time.location)
			dt = eraDtDb(day, fraction, ut, time.location.longitude, Math.hypot(x, y), z)
		} else {
			dt = eraDtDb(day, fraction, ut)
		}

		cache(time).tdbMinusTt = dt

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
		return (
			0.001657 * Math.sin(628.3076 * t + 6.2401) +
			0.000022 * Math.sin(575.3385 * t + 4.297) +
			0.000014 * Math.sin(1256.6152 * t + 6.1969) +
			0.000005 * Math.sin(606.9777 * t + 4.0212) +
			0.000005 * Math.sin(52.9691 * t + 0.4444) +
			0.000002 * Math.sin(21.3299 * t + 5.5431) +
			0.00001 * t * Math.sin(628.3076 * t + 4.249)
		)
	}

	return 0
}

// Computes TAI - UTC in seconds at time.
export const taiMinusUtc: TimeDelta = (time) => {
	const cached = time.cache?.taiMinusUtc
	if (cached !== undefined) return cached
	const cal = eraJdToCal(time.day, time.fraction)
	const dt = eraDat(cal[0], cal[1], cal[2], cal[3])
	cache(time).taiMinusUtc = dt
	return dt
}

// Computes UT1 - TAI in seconds at time.
export const ut1MinusTai: TimeDelta = (time) => {
	const cached = time.cache?.ut1MinusTai
	if (cached !== undefined) return cached
	const cal = eraJdToCal(time.day, time.fraction)
	const dat = eraDat(cal[0], cal[1], cal[2], cal[3])
	const ut1MinusUtc = (time.providers?.dut1 ?? dut1)(time)
	const dt = ut1MinusUtc - dat
	cache(time).ut1MinusTai = dt
	return dt
}

export const DEFAULT_TIME_PROVIDERS: Required<Readonly<TimeProviders>> = {
	pm: iers.xy,
	dut1: iers.dut1,
	tdbMinusTt: tdbMinusTt,
	// taiMinusUtc: taiMinusUtc,
	ut1MinusTai: ut1MinusTai,
	era: (u) => eraEra00(u.day, u.fraction),
	gast: (u, t) => eraGst06a(u.day, u.fraction, t.day, t.fraction),
	gmst: (u, t) => eraGmst06(u.day, u.fraction, t.day, t.fraction),
	obl: (t) => eraObl06(t.day, t.fraction),
	nut: (t) => eraNut06a(t.day, t.fraction),
	pmat: (t) => eraPmat06(t.day, t.fraction),
	pnm: (t) => eraPnm06a(t.day, t.fraction),
	sp: (t) => eraSp00(t.day, t.fraction),
	pom: (x, y, s) => eraPom00(x, y, s),
}
