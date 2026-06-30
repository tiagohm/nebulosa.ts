import { DAYSEC, DAYSPERJC, DAYSPERJY, DAYSPERTY, J2000, MJD0, ONE_SECOND } from '../../core/constants'
import { type Angle, normalizePI } from '../../math/units/angle'
// oxfmt-ignore
import { eraC2i06a, eraC2teqx, eraCalToJd, eraDat, eraDtDb, eraEra00, eraGmst06, eraGst06a, eraJdToCal, eraNut06a, eraObl06, eraPmat06, eraPnm06a, eraPom00, eraSp00, eraTaiTt, eraTaiUt1, eraTaiUtc, eraTcbTdb, eraTcgTt, eraTdbTcb, eraTdbTt, eraTtTai, eraTtTcg, eraTtTdb, eraUt1Tai, eraUt1Utc, eraUtcTai, eraUtcUt1 } from '../coordinates/erfa/erfa'
import { type Mat3, matClone, matIdentity, matMinus, matMul, matMulScalar, matMulTranspose, type MutMat3, matRotX, matRotZ } from '../../math/linear-algebra/mat3'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import { twoProduct, twoSum, type NumberArray } from '../../math/numerical/math'
import { itrs } from '../coordinates/itrs'
import type { GeographicPosition } from '../observer/location'
import * as iers from './iers'

// Core astronomical time representation and scale conversions. A `Time` is a high-precision instant
// stored as an integer `day` (Julian Date) plus a `fraction` in (-0.5, 0.5], tagged with a `Timescale`,
// with results memoized on an attached `cache`. Provides conversions among UT1/UTC/TAI/TT/TCG/TDB/TCB
// (via ERFA), sidereal time and Earth-rotation angle, precession/nutation and GCRS<->ITRS rotation
// matrices, polar motion, and the ΔT-style scale offsets, all overridable through pluggable providers.

// The specification for measuring time (reference scale of a Time instant).
export enum Timescale {
	// Universal Time (Earth-rotation based).
	UT1,
	// Coordinated Universal Time (UTC, with leap seconds).
	UTC,
	// International Atomic Time.
	TAI,
	// Terrestrial Time.
	TT,
	// Geocentric Coordinate Time.
	TCG,
	// Barycentric Dynamical Time.
	TDB,
	// Barycentric Coordinate Time.
	TCB,
}

// Per-instant memoization of derived quantities, attached to a Time as `cache`. Each field holds the
// result of the matching conversion/derivation so repeated calls reuse it.
export interface TimeCache {
	// The same instant expressed in each timescale, once computed.
	ut1?: Time
	utc?: Time
	tai?: Time
	tt?: Time
	tcg?: Time
	tdb?: Time
	tcb?: Time

	// Cached scale offsets in seconds.
	ut1MinusUtc?: number
	ut1MinusTai?: number
	taiMinusUtc?: number
	tdbMinusTt?: number

	// Greenwich apparent sidereal time (radians).
	gast?: Angle
	// Greenwich mean sidereal time (radians).
	gmst?: Angle
	// Earth rotation angle (radians).
	era?: Angle
	// Mean obliquity of the ecliptic (radians).
	meanObliquity?: Angle
	// Nutation in longitude and obliquity (radians).
	nutation?: readonly [Angle, Angle]
	// Precession matrix.
	precession?: Mat3
	// Precession-nutation matrix (including frame bias).
	precessionNutation?: Mat3
	// CIO-based GCRS->CIRS rotation matrix.
	cirsRotation?: Mat3
	// Polar-motion angles (s', x, y) in radians.
	pmAngles?: readonly [Angle, Angle, Angle] // sprime, x, y
	// Polar-motion provider the cached pmAngles were computed with (cache key).
	pmAnglesPolarMotion?: PolarMotion
	// Polar-motion rotation matrix.
	pmMatrix?: Mat3
	// Polar-motion provider the cached pmMatrix was computed with (cache key).
	pmMatrixPolarMotion?: PolarMotion
	// Equation-of-origins rotation matrix.
	equationOfOrigins?: Mat3
	// Full GCRS->ITRS rotation matrix.
	gcrsToItrsRotationMatrix?: Mat3
	// Instantaneous Earth-rotation drift matrix W = dR/dt·Rᵀ (per day).
	instantaneousEarthRotationMatrix?: Mat3
	// Instantaneous Earth angular-velocity vector in ITRS (rad/day).
	instantaneousEarthAngularVelocity?: Vec3
}

// Pluggable models overriding the default ERFA-based Earth-orientation and scale-offset computations.
// Any omitted provider falls back to the library default.
export interface TimeProviders {
	// Polar motion (x, y) provider.
	pm?: PolarMotion
	// UT1 - UTC provider, in seconds.
	dut1?: TimeDelta // UT1 - UTC

	// TDB - TT provider, in seconds.
	tdbMinusTt?: TimeDelta
	// taiMinusUtc?: TimeDelta
	// UT1 - TAI provider, in seconds.
	ut1MinusTai?: TimeDelta

	// Greenwich apparent sidereal time provider.
	gast?: (ut1: Time, tt: Time) => Angle
	// Greenwich mean sidereal time provider.
	gmst?: (ut1: Time, tt: Time) => Angle
	// Earth rotation angle provider.
	era?: (ut1: Time) => Angle
	// Mean obliquity provider.
	obl?: (tt: Time) => Angle
	// Nutation angles provider.
	nut?: (tt: Time) => [Angle, Angle]
	// Precession matrix provider.
	pmat?: (tt: Time) => Mat3
	// Precession-nutation matrix provider.
	pnm?: (tt: Time) => Mat3
	// TIO locator s' provider.
	sp?: (tt: Time) => Angle
	// Polar-motion matrix provider.
	pom?: (x: Angle, y: Angle, s: Angle) => Mat3
}

// An instant of time for astronomy: integer `day` plus normalized `fraction` in a given `scale`.
export interface Time {
	// Integer Julian Date day number.
	readonly day: number
	// Fractional day in (-0.5, 0.5].
	readonly fraction: number
	// Timescale this instant is expressed in.
	readonly scale: Timescale

	// Optional Earth-orientation/scale-offset provider overrides.
	providers?: TimeProviders

	// Optional observer location used for topocentric TDB-TT.
	location?: GeographicPosition
	// Memoized derived quantities.
	cache?: TimeCache
}

// Julian Day at which a date switches from the Julian to the Gregorian calendar.
export enum JulianCalendarCutOff {
	// Never switch (proleptic).
	None = 0,
	// Standard Gregorian reform (1582-10-15).
	GregorianStart = 2299161,
	// British adoption (1752-09-14).
	GregorianStartEngland = 2361222,
}

// Computes the ΔT in seconds at time.
export type TimeDelta = (time: Time) => number

// The displaced angles (longitude and latitude) of rotation of the Earth's spin axis about its geographic axis.
export type PolarMotion = (time: Time) => [Angle, Angle]

// Polar-motion provider that assumes a perfectly aligned rotation axis (no polar motion).
export const NO_POLAR_MOTION: PolarMotion = () => [0, 0]

// Julian Date day number of the Unix epoch (1970-01-01) and its half-day fraction offset.
const UNIX_EPOCH_DAY = 2440588
const UNIX_EPOCH_FRACTION = -0.5
// Milliseconds per day.
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
	cacheKey(c, 'pmAngles', a)
	cacheKey(c, 'pmAnglesPolarMotion', polarMotion)
	return a
}

// Computes the polar motion matrix from the given time.
export function pmMatrix(time: Time, pm?: PolarMotion): Mat3 {
	const polarMotion = polarMotionProvider(time, pm)
	if (time.cache?.pmMatrix !== undefined && time.cache.pmMatrixPolarMotion === polarMotion) return time.cache.pmMatrix
	const [sprime, x, y] = pmAngles(time, polarMotion)
	const m = time.providers?.pom?.(x, y, sprime) ?? eraPom00(x, y, sprime)
	const c = cache(time)
	cacheKey(c, 'pmMatrix', m)
	cacheKey(c, 'pmMatrixPolarMotion', polarMotion)
	return m
}

// Creates a Time from a Julian Date split into `day` and `fraction`, normalized into the canonical form.
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

// Reusable [sum, error] scratch buffer for the compensated day/fraction normalization (avoids allocation).
const NORMALIZED_TIME = new Float64Array(2)

// Splits day + fraction into a canonical [day, fraction] pair with the fraction in [-0.5, 0.5), using
// error-free transforms so no precision is lost. When `divisor` is nonzero the value is first reduced
// modulo the divisor. Writes [day, fraction] into `out` and returns it.
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
	const milli = (second - Math.trunc(second)) * 1000 // 000000
	return [year, month, day, Math.trunc(hour), Math.trunc(minute), Math.trunc(second), Math.trunc(milli)]
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

	if (source.scale === Timescale.UT1) cacheKey(c, 'ut1', source)
	else if (source.scale === Timescale.UTC) cacheKey(c, 'utc', source)
	else if (source.scale === Timescale.TAI) cacheKey(c, 'tai', source)
	else if (source.scale === Timescale.TT) cacheKey(c, 'tt', source)
	else if (source.scale === Timescale.TCG) cacheKey(c, 'tcg', source)
	else if (source.scale === Timescale.TDB) cacheKey(c, 'tdb', source)
	else if (source.scale === Timescale.TCB) cacheKey(c, 'tcb', source)

	if (source.location) target.location = source.location
}

// Returns the cache object, creating it if necessary.
export function cache(target: Time, cache?: TimeCache) {
	return (target.cache ??= cache ?? {})
}

// Set of non-serializable Time cache keys.
const NON_ENUMERABLE_TIME_CACHE_KEYS = new Set<keyof TimeCache>(['ut1', 'utc', 'tai', 'tt', 'tcb', 'tcg', 'tdb', 'pmAnglesPolarMotion', 'pmMatrixPolarMotion'])

// Makes some Time cache keys non-serializable.
function cacheKey<K extends keyof TimeCache>(c: TimeCache, key: K, value: TimeCache[K]) {
	if (Object.hasOwn(c, key)) {
		c[key] = value
	} else {
		Object.defineProperty(c, key, { value, enumerable: !NON_ENUMERABLE_TIME_CACHE_KEYS.has(key), writable: true })
	}
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

// Reusable [day, fraction] scratch buffer for the ERFA scale-conversion routines (avoids allocation).
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
	cacheKey(cache(time), 'gast', gast)
	return gast
}

// Computes the Greenwich Mean Sidereal Time (GMST) at given time.
export function greenwichMeanSiderealTime(time: Time): Angle {
	const cached = time.cache?.gmst
	if (cached !== undefined) return cached
	const u = ut1(time)
	const t = tt(time)
	const gmst = time.providers?.gmst?.(u, t) ?? eraGmst06(u.day, u.fraction, t.day, t.fraction)
	cacheKey(cache(time), 'gmst', gmst)
	return gmst
}

// Computes the equation of the equinoxes (GAST - GMST) at given time, in radians.
// This is the nutation of the equinox along the equator (dominated by the nutation
// in longitude projected through the obliquity); it is the small offset that turns
// mean sidereal time into apparent sidereal time. Normalized to [-PI, PI] so the
// arcsecond-scale result stays signed across the 0/TAU wrap of GAST and GMST.
export function equationOfEquinoxes(time: Time): Angle {
	return normalizePI(greenwichApparentSiderealTime(time) - greenwichMeanSiderealTime(time))
}

// Computes the Earth rotation angle (IAU 2000 model) at given time.
export function earthRotationAngle(time: Time): Angle {
	const cached = time.cache?.era
	if (cached !== undefined) return cached
	const u = ut1(time)
	const era = time.providers?.era?.(u) ?? eraEra00(u.day, u.fraction)
	cacheKey(cache(time), 'era', era)
	return era
}

// Computes the mean obliquity of the ecliptic.
export function meanObliquity(time: Time): Angle {
	const cached = time.cache?.meanObliquity
	if (cached !== undefined) return cached
	const t = tt(time)
	const meanObliquity = time.providers?.obl?.(t) ?? eraObl06(t.day, t.fraction)
	cacheKey(cache(time), 'meanObliquity', meanObliquity)
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
	cacheKey(cache(time), 'nutation', nutation)
	return nutation
}

// Computes the 3x3 precession matrix.
export function precessionMatrix(time: Time): Mat3 {
	if (time.cache?.precession !== undefined) return time.cache.precession
	const t = tt(time)
	const precession = time.providers?.pmat?.(t) ?? eraPmat06(t.day, t.fraction)
	cacheKey(cache(time), 'precession', precession)
	return precession
}

// Computes the 3x3 precession-nutation matrix (including frame bias).
export function precessionNutationMatrix(time: Time): Mat3 {
	if (time.cache?.precessionNutation !== undefined) return time.cache.precessionNutation
	const t = tt(time)
	const precessionNutation = time.providers?.pnm?.(t) ?? eraPnm06a(t.day, t.fraction)
	cacheKey(cache(time), 'precessionNutation', precessionNutation)
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
	cacheKey(cache(time), 'cirsRotation', cirsRotation)
	return cirsRotation
}

// Computes the 3x3 matrix of Equation of Origins in cycles.
export function equationOfOrigins(time: Time): Mat3 {
	if (time.cache?.equationOfOrigins !== undefined) return time.cache.equationOfOrigins
	const equationOfOrigins = matIdentity()
	matMul(matRotZ(greenwichApparentSiderealTime(time) - earthRotationAngle(time), equationOfOrigins), precessionNutationMatrix(time), equationOfOrigins)
	cacheKey(cache(time), 'equationOfOrigins', equationOfOrigins)
	return equationOfOrigins
}

// Computes the GCRS to ITRS rotation matrix at time.
export function gcrsToItrsRotationMatrix(time: Time) {
	if (time.cache?.gcrsToItrsRotationMatrix !== undefined) return time.cache.gcrsToItrsRotationMatrix
	const gcrsToItrsRotationMatrix = eraC2teqx(precessionNutationMatrix(time), greenwichApparentSiderealTime(time), pmMatrix(time))
	cacheKey(cache(time), 'gcrsToItrsRotationMatrix', gcrsToItrsRotationMatrix)
	return gcrsToItrsRotationMatrix
}

// Computes the instantaneous Earth-rotation drift matrix W = dR/dt · Rᵀ at time,
// where R is the GCRS->ITRS rotation and the derivative is in per-day units. W is
// the (antisymmetric) angular-velocity operator the rotating-frame velocity term
// uses, evaluated exactly by central difference over ±1 second rather than with
// the constant mean-rate approximation. Cached on the time instance.
export function instantaneousEarthRotationMatrix(time: Time): Mat3 {
	if (time.cache?.instantaneousEarthRotationMatrix !== undefined) return time.cache.instantaneousEarthRotationMatrix
	const r = gcrsToItrsRotationMatrix(time)
	const rp = gcrsToItrsRotationMatrix(timeShift(time, ONE_SECOND))
	const rm = gcrsToItrsRotationMatrix(timeShift(time, -ONE_SECOND))
	// Central difference dR/dt with step ±1 second expressed in days.
	const d = matMinus(rp, rm, rp as MutMat3)
	matMulScalar(d, 0.5 / ONE_SECOND, d)
	const instantaneousEarthRotationMatrix = matMulTranspose(d, r, d) // w = dR/dt * R^T
	cacheKey(cache(time), 'instantaneousEarthRotationMatrix', instantaneousEarthRotationMatrix)
	return instantaneousEarthRotationMatrix
}

// Computes Earth's instantaneous angular-velocity vector ω in the ITRS frame, in rad/day,
// extracted from the antisymmetric drift matrix W = dR/dt · Rᵀ (instantaneousEarthRotationMatrix).
// W acts as W·v = ω × v, so ω is recovered from the off-diagonal pairs. The sign is the physical
// Earth rotation vector (≈ +ANGVEL_PER_DAY on z, pointing to the celestial pole), i.e. the negative
// of the standard axial vector of W; this convention is what location.ts rebuilds the per-location
// drift matrix from, where the improper (det = -1) altaz transform flips the sign back. Cached on
// the time instance.
export function instantaneousEarthAngularVelocity(time: Time): Vec3 {
	if (time.cache?.instantaneousEarthAngularVelocity !== undefined) return time.cache.instantaneousEarthAngularVelocity
	const d = instantaneousEarthRotationMatrix(time)

	// ω = -axial(W): each component is half the difference of the symmetric-position pair of W.
	const instantaneousEarthAngularVelocity = [(d[5] - d[7]) * 0.5, (d[6] - d[2]) * 0.5, (d[1] - d[3]) * 0.5] as const
	cacheKey(cache(time), 'instantaneousEarthAngularVelocity', instantaneousEarthAngularVelocity)
	return instantaneousEarthAngularVelocity
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

	cacheKey(cache(time), 'ut1MinusUtc', dt)

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

		cacheKey(cache(time), 'tdbMinusTt', dt)

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
	cacheKey(cache(time), 'taiMinusUtc', dt)
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
	cacheKey(cache(time), 'ut1MinusTai', dt)
	return dt
}

// Default Earth-orientation and scale-offset providers: IERS tables for polar motion and UT1, and the
// IAU 2006/2000A ERFA models for sidereal time, obliquity, nutation, precession, and polar-motion matrices.
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
