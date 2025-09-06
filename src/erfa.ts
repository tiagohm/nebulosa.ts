import { type Angle, arcsec, deg, normalizeAngle } from './angle'
import { ASEC2RAD, AU_M, DAYSEC, DAYSPERJC, DAYSPERJM, DAYSPERJY, ELB, ELG, J2000, LIGHT_TIME_AU, MILLIASEC2RAD, MJD0, MJD1977, MJD2000, PI, PIOVERTWO, SCHWARZSCHILD_RADIUS_OF_THE_SUN, SPEED_OF_LIGHT_AU_DAY, TAU, TDB0, TTMINUSTAI, TURNAS } from './constants'
import { type Distance, toKilometer } from './distance'
import { FAIRHEAD, IAU2000A_LS, IAU2000A_PL, IAU2000B_LS, IAU2006_S, IAU2006_SP } from './erfa.data'
import { type Mat3, type MutMat3, matClone, matCopy, matIdentity, matMul, matMulTransposeVec, matMulVec, matRotX, matRotY, matRotZ, matTranspose } from './mat3'
import { pmod, roundToNearestWholeNumber } from './math'
import type { Pressure } from './pressure'
import type { Temperature } from './temperature'
import { type MutVec3, type Vec3, vecClone, vecCross, vecDivScalar, vecDot, vecFill, vecLength, vecMinus, vecMulScalar, vecNormalize, vecPlus, vecZero } from './vec3'
import type { Velocity } from './velocity'

const DBL_EPSILON = 2.220446049250313e-16

const LEAP_SECOND_CHANGES: LeapSecondChange[] = [
	[1960, 1, 1.417818],
	[1961, 1, 1.422818],
	[1961, 8, 1.372818],
	[1962, 1, 1.845858],
	[1963, 11, 1.945858],
	[1964, 1, 3.24013],
	[1964, 4, 3.34013],
	[1964, 9, 3.44013],
	[1965, 1, 3.54013],
	[1965, 3, 3.64013],
	[1965, 7, 3.74013],
	[1965, 9, 3.84013],
	[1966, 1, 4.31317],
	[1968, 2, 4.21317],
	[1972, 1, 10],
	[1972, 7, 11],
	[1973, 1, 12],
	[1974, 1, 13],
	[1975, 1, 14],
	[1976, 1, 15],
	[1977, 1, 16],
	[1978, 1, 17],
	[1979, 1, 18],
	[1980, 1, 19],
	[1981, 7, 20],
	[1982, 7, 21],
	[1983, 7, 22],
	[1985, 7, 23],
	[1988, 1, 24],
	[1990, 1, 25],
	[1991, 1, 26],
	[1992, 7, 27],
	[1993, 7, 28],
	[1994, 7, 29],
	[1996, 1, 30],
	[1997, 7, 31],
	[1999, 1, 32],
	[2006, 1, 33],
	[2009, 1, 34],
	[2012, 7, 35],
	[2015, 7, 36],
	[2017, 1, 37],
]

const LEAP_SECOND_DRIFT: LeapSecondDrift[] = [
	[37300, 0.001296],
	[37300, 0.001296],
	[37300, 0.001296],
	[37665, 0.0011232],
	[37665, 0.0011232],
	[38761, 0.001296],
	[38761, 0.001296],
	[38761, 0.001296],
	[38761, 0.001296],
	[38761, 0.001296],
	[38761, 0.001296],
	[38761, 0.001296],
	[39126, 0.002592],
	[39126, 0.002592],
]

const EMPTY_ERA_ASTROM: EraAstrom = {
	pmt: 0,
	eb: [0, 0, 0],
	eh: [0, 0, 0],
	em: 0,
	v: [0, 0, 0],
	bm1: 0,
	bpn: [0, 0, 0, 0, 0, 0, 0, 0, 0],
	along: 0,
	phi: 0,
	xpl: 0,
	ypl: 0,
	sphi: 0,
	cphi: 0,
	diurab: 0,
	eral: 0,
	refa: 0,
	refb: 0,
}

export type LeapSecondChange = readonly [number, number, number]

export type LeapSecondDrift = readonly [number, number]

export interface EraAstrom {
	pmt: number // PM time interval (SSB, Julian years)
	eb: MutVec3 // SSB to observer (vector, au)
	eh: MutVec3 // Sun to observer (unit vector)
	em: Distance // distance from Sun to observer (au)
	v: MutVec3 // barycentric observer velocity (vector, c)
	bm1: number // sqrt(1-|v|^2): reciprocal of Lorenz factor
	bpn: MutMat3 // bias-precession-nutation matrix
	along: number // longitude + s' + dERA(DUT) (radians)
	phi: number // geodetic latitude (radians)
	xpl: number // polar motion xp wrt local meridian (radians)
	ypl: number // polar motion yp wrt local meridian (radians)
	sphi: number // sine of geodetic latitude
	cphi: number // cosine of geodetic latitude
	diurab: number // magnitude of diurnal aberration vector
	eral: number // "local" Earth rotation angle (radians)
	refa: number // refraction constant A (radians)
	refb: number // refraction constant B (radians)
}

// Normalizes [angle] into the range -[PI] <= a < +[PI].
export function eraAnpm(angle: Angle): Angle {
	let w = angle % TAU
	if (Math.abs(w) >= PI) w -= angle >= 0 ? TAU : -TAU
	return w
}

// P-vector to spherical polar coordinates.
export function eraP2s(x: Distance, y: Distance, z: Distance): [Angle, Angle, Distance] {
	const [theta, phi] = eraC2s(x, y, z)
	const r = Math.sqrt(x * x + y * y + z * z)
	return [theta, phi, r]
}

// P-vector to spherical coordinates.
export function eraC2s(x: Distance, y: Distance, z: Distance): [Angle, Angle] {
	const d2 = x * x + y * y
	const theta = d2 === 0 ? 0 : Math.atan2(y, x)
	const phi = z === 0 ? 0 : Math.atan2(z, Math.sqrt(d2))
	return [theta, phi]
}

// Spherical coordinates to Cartesian coordinates.
export function eraS2c(theta: Angle, phi: Angle): MutVec3 {
	const cp = Math.cos(phi)
	return [Math.cos(theta) * cp, Math.sin(theta) * cp, Math.sin(phi)]
}

// Spherical polar coordinates to P-vector.
export function eraS2p(theta: Angle, phi: Angle, r: Distance): [Distance, Distance, Distance] {
	const u = eraS2c(theta, phi)
	u[0] *= r
	u[1] *= r
	u[2] *= r
	return u
}

// Barycentric Coordinate Time, TCB, to Barycentric Dynamical Time, TDB.
export function eraTcbTdb(tcb1: number, tcb2: number): [number, number] {
	const d = tcb1 - (MJD0 + MJD1977)
	const tdb2 = tcb2 + TDB0 / DAYSEC - (d + (tcb2 - TTMINUSTAI / DAYSEC)) * ELB
	return [tcb1, tdb2]
}

// Geocentric Coordinate Time, TCG, to Terrestrial Time, TT.
export function eraTcgTt(tcg1: number, tcg2: number): [number, number] {
	const tt2 = tcg2 - (tcg1 - MJD0 + (tcg2 - (MJD1977 + TTMINUSTAI / DAYSEC))) * ELG
	return [tcg1, tt2]
}

// Barycentric Dynamical Time, TDB, to Barycentric Coordinate Time, TCB.
export function eraTdbTcb(tdb1: number, tdb2: number): [number, number] {
	const d = MJD0 + MJD1977 - tdb1
	const f = tdb2 - TDB0 / DAYSEC
	const tcb2 = f - (d - (f - TTMINUSTAI / DAYSEC)) * (ELB / (1 - ELB))
	return [tdb1, tcb2]
}

// Terrestrial Time, TT, to Geocentric Coordinate Time, TCG.
export function eraTtTcg(tt1: number, tt2: number): [number, number] {
	const tcg2 = tt2 + (tt1 - MJD0 + (tt2 - (MJD1977 + TTMINUSTAI / DAYSEC))) * (ELG / (1 - ELG))
	return [tt1, tcg2]
}

// International Atomic Time, TAI, to Universal Time, UT1.
export function eraTaiUt1(tai1: number, tai2: number, ut1MinusTai: number): [number, number] {
	return [tai1, tai2 + ut1MinusTai / DAYSEC]
}

// Universal Time, UT1, to International Atomic Time, TAI.
export function eraUt1Tai(ut11: number, ut12: number, ut1MinusTai: number): [number, number] {
	return [ut11, ut12 - ut1MinusTai / DAYSEC]
}

// International Atomic Time, TAI, to Terrestrial Time, TT.
export function eraTaiTt(tai1: number, tai2: number): [number, number] {
	return [tai1, tai2 + TTMINUSTAI / DAYSEC]
}

// Terrestrial Time, TT, to International Atomic Time, TAI.
export function eraTtTai(tt1: number, tt2: number): [number, number] {
	return [tt1, tt2 - TTMINUSTAI / DAYSEC]
}

// Terrestrial Time, TT, to Barycentric Dynamical Time, TDB.
export function eraTtTdb(tt1: number, tt2: number, tdbMinusTt: number): [number, number] {
	return [tt1, tt2 + tdbMinusTt / DAYSEC]
}

// Barycentric Dynamical Time, TDB, to Terrestrial Time, TT.
export function eraTdbTt(tdb1: number, tdb2: number, tdbMinusTt: number): [number, number] {
	return [tdb1, tdb2 - tdbMinusTt / DAYSEC]
}

// International Atomic Time, TAI, to Coordinated Universal Time, UTC.
export function eraTaiUtc(tai1: number, tai2: number): [number, number] {
	let u2 = tai2

	// Iterate(though in most cases just once is enough).
	for (let i = 0; i < 3; i++) {
		const [g1, g2] = eraUtcTai(tai1, u2)

		// Adjust guessed UTC.
		u2 += tai1 - g1
		u2 += tai2 - g2
	}

	return [tai1, u2]
}

export function eraUtcTai(utc1: number, utc2: number): [number, number] {
	const u1 = Math.max(utc1, utc2)
	const u2 = Math.min(utc1, utc2)

	// Get TAI-UTC at 0h today.
	const cal = eraJdToCal(u1, u2)
	const dat0 = eraDat(cal[0], cal[1], cal[2], 0)

	// Get TAI-UTC at 12h today (to detect drift).
	const dat12 = eraDat(cal[0], cal[1], cal[2], 0.5)

	// Get TAI-UTC at 0h tomorrow (to detect jumps).
	const calt = eraJdToCal(u1 + 1.5, u2 - cal[3])
	const dat24 = eraDat(calt[0], calt[1], calt[2], 0)

	// Separate TAI-UTC change into per-day (DLOD) and any jump (DLEAP).
	const dlod = 2 * (dat12 - dat0)
	const dleap = dat24 - (dat0 + dlod)

	// Remove any scaling applied to spread leap into preceding day.
	let fd = (cal[3] * (DAYSEC + dleap)) / DAYSEC

	// Scale from (pre-1972) UTC seconds to SI seconds.
	fd *= (DAYSEC + dlod) / DAYSEC

	// Today's calendar date to 2-part JD.
	const z = eraCalToJd(cal[0], cal[1], cal[2])

	// Assemble the TAI result, preserving the UTC split and order.
	const a2 = MJD0 - u1 + z + (fd + dat0 / DAYSEC)

	return [u1, a2]
}

export function eraUtcUt1(utc1: number, utc2: number, dut1: number): [number, number] {
	const cal = eraJdToCal(utc1, utc2)
	const dat = eraDat(cal[0], cal[1], cal[2], cal[3])

	// Form UT1-TAI
	const dta = dut1 - dat

	const [tai1, tai2] = eraUtcTai(utc1, utc2)
	return eraTaiUt1(tai1, tai2, dta)
}

export function eraUt1Utc(ut11: number, ut12: number, dut1: number): [number, number] {
	const u1 = Math.max(ut11, ut12)
	let u2 = Math.min(ut11, ut12)

	let duts = dut1

	// See if the UT1 can possibly be in a leap-second day.
	let d1 = u1
	let dats1 = 0

	for (let i = -1; i < 4; i++) {
		let d2 = u2 + i
		const cal = eraJdToCal(d1, d2)
		const dats2 = eraDat(cal[0], cal[1], cal[2], 0)

		if (i === -1) {
			dats1 = dats2
		}

		const ddats = dats2 - dats1

		if (Math.abs(ddats) >= 0.5) {
			// Yes, leap second nearby: ensure UT1-UTC is "before" value.
			if (ddats * duts >= 0) {
				duts -= ddats
			}

			// UT1 for the start of the UTC day that ends in a leap.
			d1 = MJD0
			d2 = eraCalToJd(cal[0], cal[1], cal[2])

			const us1 = d1
			const us2 = d2 - 1 + duts / DAYSEC

			// Is the UT1 after this point?
			const du = u1 - us1 + (u2 - us2)

			if (du > 0) {
				// Yes: fraction of the current UTC day that has elapsed.
				const fd = (du * DAYSEC) / (DAYSEC + ddats)

				// Ramp UT1-UTC to bring about ERFA's JD(UTC) convention.
				duts += ddats * fd <= 1 ? fd : 1
			}

			break
		}

		dats1 = dats2
	}

	// Subtract the (possibly adjusted) UT1-UTC from UT1 to give UTC.
	u2 -= duts / DAYSEC

	return [u1, u2]
}

export function eraJdToCal(dj1: number, dj2: number): [number, number, number, number] {
	// Separate day and fraction (where -0.5 <= fraction < 0.5).
	let d = roundToNearestWholeNumber(dj1)
	const f1 = dj1 - d
	let jd = d

	d = roundToNearestWholeNumber(dj2)
	const f2 = dj2 - d
	jd += d

	// Compute f1+f2+0.5 using compensated summation (Klein 2006).
	let s = 0.5
	let cs = 0

	for (const x of [f1, f2]) {
		const t = s + x

		cs += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s
		s = t

		if (s >= 1) {
			jd++
			s -= 1
		}
	}

	let f = s + cs
	cs = f - s

	// Deal with negative f.
	if (f < 0) {
		// Compensated summation: assume that |s| <= 1.
		f = s + 1
		cs += 1 - f + s
		s = f
		f = s + cs
		cs = f - s
		jd--
	}

	// Deal with f that is 1 or more (when rounded to double).
	if (f - 1 >= -DBL_EPSILON / 4) {
		// Compensated summation: assume that |s| <= 1.
		const t = s - 1
		cs += s - t - 1
		s = t
		f = s + cs

		if (-DBL_EPSILON / 2 < f) {
			jd++
			f = Math.max(f, 0)
		}
	}

	// Express day in Gregorian calendar.
	let l = jd + 68569
	const n = Math.trunc((4 * l) / 146097)
	l -= Math.trunc((146097 * n + 3) / 4)
	const i = Math.trunc((4000 * (l + 1)) / 1461001)
	l -= Math.trunc((1461 * i) / 4) - 31
	const k = Math.trunc((80 * l) / 2447)
	const id = l - Math.trunc((2447 * k) / 80)
	l = Math.trunc(k / 11)
	const im = Math.trunc(k + 2 - 12 * l)
	const iy = Math.trunc(100 * (n - 49) + i + l)

	return [iy, im, id, f]
}

// Gregorian Calendar to Julian Date.
export function eraCalToJd(iy: number, im: number, id: number): number {
	const my = Math.trunc((im - 14) / 12)
	const iypmy = iy + my
	return Math.trunc((1461 * (iypmy + 4800)) / 4) + Math.trunc((367 * (im - 2 - 12 * my)) / 12) - Math.trunc((3 * Math.trunc((iypmy + 4900) / 100)) / 4) + Math.trunc(id) - 2432076
}

// For a given UTC date, calculate Delta(AT) = TAI-UTC.
export function eraDat(iy: number, im: number, id: number, fd: number): number {
	const djm = eraCalToJd(iy, im, id)

	// Combine year and month to form a date-ordered integer...
	const m = 12 * iy + im
	const i = LEAP_SECOND_CHANGES.findLastIndex((x) => m >= 12 * x[0] + x[1])

	if (i < 0) return 0

	// Get the Delta(AT).
	let da = LEAP_SECOND_CHANGES[i][2]

	// If pre-1972, adjust for drift.
	if (LEAP_SECOND_CHANGES[i][0] < 1972) {
		da += (djm + fd - LEAP_SECOND_DRIFT[i][0]) * LEAP_SECOND_DRIFT[i][1]
	}

	return da
}

// The TIO locator s', positioning the Terrestrial Intermediate Origin
// on the equator of the Celestial Intermediate Pole.
export function eraSp00(tt1: number, tt2: number): Angle {
	const t = (tt1 - J2000 + tt2) / DAYSPERJC
	const sp = -47e-6 * t
	return arcsec(sp)
}

// An approximation to TDB-TT, the difference between barycentric
// dynamical time and terrestrial time, for an observer on the Earth.
export function eraDtDb(tdb1: number, tdb2: number, ut: number, elong: Angle = 0, u: Distance = 0, v: Distance = 0) {
	// Time since J2000.0 in Julian millennia.
	const t = (tdb1 - J2000 + tdb2) / DAYSPERJM
	// Convert UT to local solar time in radians.
	const tsol = pmod(ut, 1) * TAU + elong
	// Combine time argument (millennia) with deg/arcsec factor.
	const w = t / 3600
	// Sun Mean Meridian.
	const elsun = deg(280.46645683 + 1296027711.03429 * w)
	// Sun Mean Anomaly.
	const emsun = deg(357.52910918 + 1295965810.481 * w)
	// Mean Elongation of Moon from Sun.
	const d = deg(297.85019547 + 16029616012.09 * w)
	// Mean Longitude of Jupiter.
	const elj = deg(34.35151874 + 109306899.89453 * w)
	// Mean Longitude of Saturn.
	const els = deg(50.0774443 + 44046398.47038 * w)
	// TOPOCENTRIC TERMS: Moyer 1981 and Murray 1983.
	const ukm = toKilometer(u)
	const vkm = toKilometer(v)
	const wt =
		0.00029e-10 * ukm * Math.sin(tsol + elsun - els) +
		0.001e-10 * ukm * Math.sin(tsol - 2 * emsun) +
		0.00133e-10 * ukm * Math.sin(tsol - d) +
		0.00133e-10 * ukm * Math.sin(tsol + elsun - elj) -
		0.00229e-10 * ukm * Math.sin(tsol + 2 * elsun + emsun) -
		0.022e-10 * vkm * Math.cos(elsun + emsun) +
		0.05312e-10 * ukm * Math.sin(tsol - emsun) -
		0.13677e-10 * ukm * Math.sin(tsol + 2 * elsun) -
		1.3184e-10 * vkm * Math.cos(elsun) +
		3.17679e-10 * ukm * Math.sin(tsol)

	const wn = [0, 0, 0, 0, 0]

	// T^0
	for (let j = 1419; j >= 0; j -= 3) {
		wn[0] += FAIRHEAD[j] * Math.sin(FAIRHEAD[j + 1] * t + FAIRHEAD[j + 2])
	}

	// T^1
	for (let j = 2034; j >= 1422; j -= 3) {
		wn[1] += FAIRHEAD[j] * Math.sin(FAIRHEAD[j + 1] * t + FAIRHEAD[j + 2])
	}

	// T^2
	for (let j = 2289; j >= 2037; j -= 3) {
		wn[2] += FAIRHEAD[j] * Math.sin(FAIRHEAD[j + 1] * t + FAIRHEAD[j + 2])
	}

	// T^3
	for (let j = 2349; j >= 2292; j -= 3) {
		wn[3] += FAIRHEAD[j] * Math.sin(FAIRHEAD[j + 1] * t + FAIRHEAD[j + 2])
	}

	// T^4
	for (let j = 2358; j >= 2352; j -= 3) {
		wn[4] += FAIRHEAD[j] * Math.sin(FAIRHEAD[j + 1] * t + FAIRHEAD[j + 2])
	}

	// Multiply by powers of T and combine.
	const wf = t * (t * (t * (t * wn[4] + wn[3]) + wn[2]) + wn[1]) + wn[0]

	// Adjustments to use JPL planetary masses instead of IAU.
	const wj = 0.00065e-6 * Math.sin(6069.776754 * t + 4.021194) + 0.00033e-6 * Math.sin(213.299095 * t + 5.543132) + -0.00196e-6 * Math.sin(6208.294251 * t + 5.696701) + -0.00173e-6 * Math.sin(74.781599 * t + 2.4359) + 0.03638e-6 * t * t

	// TDB-TT in seconds.
	return wt + wf + wj
}

// Greenwich apparent sidereal time (consistent with IAU 2000 and 2006 resolutions).
export function eraGst06a(ut11: number, ut12: number, tt1: number, tt2: number): Angle {
	const rnpb = eraPnm06a(tt1, tt2)
	return eraGst06(ut11, ut12, tt1, tt2, rnpb)
}

// Greenwich apparent sidereal time, IAU 2006, given the NPB matrix.
export function eraGst06(ut11: number, ut12: number, tt1: number, tt2: number, rnpb: Mat3): Angle {
	// Extract CIP X,Y.
	const x = rnpb[6] // 2x0
	const y = rnpb[7] // 2x1

	// The CIO locator, s.
	const s = eraS06(tt1, tt2, x, y)

	// Greenwich apparent sidereal time.
	const era = eraEra00(ut11, ut12)
	const eors = eraEors(rnpb, s)

	return normalizeAngle(era - eors)
}

// Greenwich mean sidereal time (model consistent with IAU 2006 precession).
export function eraGmst06(ut11: number, ut12: number, tt1: number, tt2: number): Angle {
	// TT Julian centuries since J2000.0.
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	return normalizeAngle(eraEra00(ut11, ut12) + arcsec(0.014506 + (4612.156534 + (1.3915817 + (-0.00000044 + (-0.000029956 + -0.0000000368 * t) * t) * t) * t) * t))
}

// Earth rotation angle (IAU 2000 model).
export function eraEra00(ut11: number, ut12: number): Angle {
	const t = ut12 + (ut11 - J2000)

	// Fractional part of T (days).
	const f = (ut12 % 1) + (ut11 % 1)

	// Earth rotation angle at this UT1.
	return normalizeAngle(TAU * (f + 0.779057273264 + 0.00273781191135448 * t))
}

// Equation of the origins, given the classical NPB matrix and the CIO locator.
export function eraEors(rnpb: Mat3, s: Angle): Angle {
	const x = rnpb[6]
	const ax = x / (1 + rnpb[8])
	const xs = 1 - ax * x
	const ys = -ax * rnpb[7]
	const zs = -x
	const p = rnpb[0] * xs + rnpb[1] * ys + rnpb[2] * zs
	const q = rnpb[3] * xs + rnpb[4] * ys + rnpb[5] * zs
	return p !== 0 || q !== 0 ? s - Math.atan2(q, p) : s
}

// The CIO locator s, positioning the Celestial Intermediate Origin on
// the equator of the Celestial Intermediate Pole, given the CIP's X,Y
// coordinates. Compatible with IAU 2006/2000A precession-nutation.
export function eraS06(tt1: number, tt2: number, x: Angle, y: Angle): Angle {
	// Interval between fundamental epoch J2000.0 and current date (JC).
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	// Fundamental Arguments (from IERS Conventions 2003)
	const fa = [0, 0, 0, 0, 0, 0, 0, 0]

	// Mean anomaly of the Moon.
	fa[0] = eraFal03(t)
	// Mean anomaly of the Sun.
	fa[1] = eraFalp03(t)
	// Mean longitude of the Moon minus that of the ascending node.
	fa[2] = eraFaf03(t)
	// Mean elongation of the Moon from the Sun.
	fa[3] = eraFad03(t)
	// Mean longitude of the ascending node of the Moon.
	fa[4] = eraFaom03(t)
	// Mean longitude of Venus.
	fa[5] = eraFave03(t)
	// Mean longitude of Earth.
	fa[6] = eraFae03(t)
	// General precession in longitude.
	fa[7] = eraFapa03(t)

	// Evalutate s.
	const w = [...IAU2006_SP]

	for (let k = 0; k < IAU2006_S.length; k++) {
		for (let i = IAU2006_S[k].length - 1; i >= 0; i--) {
			const [nfa, s, c] = IAU2006_S[k][i]
			let a = 0

			for (let j = 0; j < 8; j++) {
				a += nfa[j] * fa[j]
			}

			w[k] += s * Math.sin(a) + c * Math.cos(a)
		}
	}

	return arcsec(w[0] + (w[1] + (w[2] + (w[3] + (w[4] + w[5] * t) * t) * t) * t) * t) - (x * y) / 2
}

// Form the matrix of precession-nutation for a given date (including
// frame bias), equinox based, IAU 2006 precession and IAU 2000A
// nutation models.
export function eraPnm06a(tt1: number, tt2: number) {
	// Fukushima-Williams angles for frame bias and precession.
	const [gamb, phib, psib, epsa] = eraPfw06(tt1, tt2)
	// Nutation.
	const [dp, de] = eraNut06a(tt1, tt2)
	// Equinox based nutation x precession x bias matrix.
	return eraFw2m(gamb, phib, psib + dp, epsa + de)
}

// Form rotation matrix given the Fukushima-Williams angles.
export function eraFw2m(gamb: Angle, phib: Angle, psi: Angle, eps: Angle) {
	return matRotX(-eps, matRotZ(-psi, matRotX(phib, matRotZ(gamb))))
}

// Precession angles, IAU 2006 (Fukushima-Williams 4-angle formulation).
export function eraPfw06(tt1: number, tt2: number): [Angle, Angle, Angle, Angle] {
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	const gamb = arcsec(-0.052928 + (10.556378 + (0.4932044 + (-0.00031238 + (-0.000002788 + 0.000000026 * t) * t) * t) * t) * t)
	const phib = arcsec(84381.412819 + (-46.811016 + (0.0511268 + (0.00053289 + (-0.00000044 + -0.0000000176 * t) * t) * t) * t) * t)
	const psib = arcsec(-0.041775 + (5038.481484 + (1.5584175 + (-0.00018522 + (-0.000026452 + -0.0000000148 * t) * t) * t) * t) * t)
	const epsa = eraObl06(tt1, tt2)

	return [gamb, phib, psib, epsa]
}

// Mean obliquity of the ecliptic, IAU 2006 precession model.
export function eraObl06(tt1: number, tt2: number): Angle {
	// Interval between fundamental date J2000.0 and given date (JC).
	const t = (tt1 - J2000 + tt2) / DAYSPERJC
	// Mean obliquity.
	return arcsec(84381.406 + (-46.836769 + (-0.0001831 + (0.0020034 + (-0.000000576 + -0.0000000434 * t) * t) * t) * t) * t)
}

// Fundamental argument, IERS Conventions (2003): mean anomaly of the Moon.
export function eraFal03(t: number): Angle {
	return arcsec((485868.249036 + t * (1717915923.2178 + t * (31.8792 + t * (0.051635 + t * -0.0002447)))) % TURNAS)
}

// Fundamental argument, IERS Conventions (2003): mean anomaly of the Sun.
export function eraFalp03(t: number): Angle {
	return arcsec((1287104.793048 + t * (129596581.0481 + t * (-0.5532 + t * (0.000136 + t * -0.00001149)))) % TURNAS)
}

// Fundamental argument, IERS Conventions (2003): mean anomaly of the Sun.
export function eraFad03(t: number): Angle {
	return arcsec((1072260.703692 + t * (1602961601.209 + t * (-6.3706 + t * (0.006593 + t * -0.00003169)))) % TURNAS)
}

// Fundamental argument, IERS Conventions (2003): mean longitude of the Moon
// minus mean longitude of the ascending node.
export function eraFaf03(t: number): Angle {
	return arcsec((335779.526232 + t * (1739527262.8478 + t * (-12.7512 + t * (-0.001037 + t * 0.00000417)))) % TURNAS)
}

// Fundamental argument, IERS Conventions (2003): mean longitude of the Moon's ascending node.
export function eraFaom03(t: number): Angle {
	return arcsec((450160.398036 + t * (-6962890.5431 + t * (7.4722 + t * (0.007702 + t * -0.00005939)))) % TURNAS)
}

// Fundamental argument, IERS Conventions (2003): general accumulated precession in longitude.
export function eraFapa03(t: number): Angle {
	return (0.02438175 + 0.00000538691 * t) * t
}

// Fundamental argument, IERS Conventions (2003): mean longitude of Mercury.
export function eraFame03(t: number): Angle {
	return (4.402608842 + 2608.7903141574 * t) % TAU
}

// Fundamental argument, IERS Conventions (2003): mean longitude of Venus.
export function eraFave03(t: number): Angle {
	return (3.176146697 + 1021.3285546211 * t) % TAU
}

// Fundamental argument, IERS Conventions (2003): mean longitude of Earth.
export function eraFae03(t: number): Angle {
	return (1.753470314 + 628.3075849991 * t) % TAU
}

// Fundamental argument, IERS Conventions (2003): mean longitude of Mars.
export function eraFama03(t: number): Angle {
	return (6.203480913 + 334.06124267 * t) % TAU
}

// Fundamental argument, IERS Conventions (2003): mean longitude of Jupiter.
export function eraFaju03(t: number): Angle {
	return (0.599546497 + 52.9690962641 * t) % TAU
}

// Fundamental argument, IERS Conventions (2003): mean longitude of Saturn.
export function eraFasa03(t: number): Angle {
	return (0.874016757 + 21.329910496 * t) % TAU
}

// Fundamental argument, IERS Conventions (2003): mean longitude of Uranus.
export function eraFaur03(t: number): Angle {
	return (5.481293872 + 7.4781598567 * t) % TAU
}

// Nutation, IAU 2000A model (MHB2000 luni-solar and planetary nutation
// with free core nutation omitted).
export function eraNut00a(tt1: number, tt2: number): [Angle, Angle] {
	// Interval between fundamental date J2000.0 and given date (JC).
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	// Mean anomaly of the Moon (IERS 2003).
	const el = eraFal03(t)

	// Mean anomaly of the Sun (MHB2000).
	const elp = arcsec((1287104.79305 + t * (129596581.0481 + t * (-0.5532 + t * (0.000136 + t * -0.00001149)))) % TURNAS)

	// Mean longitude of the Moon minus that of the ascending node (IERS 2003).
	const f = eraFaf03(t)

	// Mean elongation of the Moon from the Sun (MHB2000).

	const d = arcsec((1072260.70369 + t * (1602961601.209 + t * (-6.3706 + t * (0.006593 + t * -0.00003169)))) % TURNAS)

	// Mean longitude of the ascending node of the Moon (IERS 2003).
	const om = eraFaom03(t)

	let dp = 0
	let de = 0

	// Summation of luni-solar nutation series (in reverse order).
	for (let i = IAU2000A_LS.length - 1; i >= 0; i--) {
		const [nl, nlp, nf, nd, nom, sp, spt, cp, ce, cet, se] = IAU2000A_LS[i]
		const arg = (nl * el + nlp * elp + nf * f + nd * d + nom * om) % TAU

		const sarg = Math.sin(arg)
		const carg = Math.cos(arg)

		dp += (sp + spt * t) * sarg + cp * carg
		de += (ce + cet * t) * carg + se * sarg
	}

	const dpls = dp
	const dels = de

	// Mean anomaly of the Moon (MHB2000).
	const al = (2.35555598 + 8328.6914269554 * t) % TAU

	// Mean longitude of the Moon minus that of the ascending node.
	const af = (1.627905234 + 8433.466158131 * t) % TAU

	// Mean elongation of the Moon from the Sun (MHB2000).
	const ad = (5.198466741 + 7771.3771468121 * t) % TAU

	// Mean longitude of the ascending node of the Moon (MHB2000).
	const aom = (2.1824392 - 33.757045 * t) % TAU

	// General accumulated precession in longitude (IERS 2003).
	const apa = eraFapa03(t)

	// Planetary longitudes, Mercury through Uranus (IERS 2003).
	const alme = eraFame03(t)
	const alve = eraFave03(t)
	const alea = eraFae03(t)
	const alma = eraFama03(t)
	const alju = eraFaju03(t)
	const alsa = eraFasa03(t)
	const alur = eraFaur03(t)

	// Neptune longitude (MHB2000).
	const alne = (5.321159 + 3.8127774 * t) % TAU

	dp = 0
	de = 0

	for (let i = IAU2000A_PL.length - 1; i >= 0; i--) {
		const [nl, nf, nd, nom, nme, nve, nea, nma, nju, nsa, nur, nne, npa, sp, cp, se, ce] = IAU2000A_PL[i]
		const arg = (nl * al + nf * af + nd * ad + nom * aom + nme * alme + nve * alve + nea * alea + nma * alma + nju * alju + nsa * alsa + nur * alur + nne * alne + npa * apa) % TAU

		const sarg = Math.sin(arg)
		const carg = Math.cos(arg)

		dp += sp * sarg + cp * carg
		de += se * sarg + ce * carg
	}

	// Units of 0.1 microarcsecond to radians.
	return [arcsec(dpls + dp) / 10000000, arcsec(dels + de) / 10000000]
}

// IAU 2000A nutation with adjustments to match the IAU 2006 precession.
export function eraNut06a(tt1: number, tt2: number): [Angle, Angle] {
	// Interval between fundamental date J2000.0 and given date (JC).
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	// Factor correcting for secular variation of J2.
	const fj2 = -2.7774e-6 * t

	// Obtain IAU 2000A nutation.
	const [dp, de] = eraNut00a(tt1, tt2)

	// Apply P03 adjustments (Wallace & Capitaine, 2006, Eqs.5).
	const dpsi = dp + dp * (0.4697e-6 + fj2)
	const deps = de + de * fj2

	return [dpsi, deps]
}

const DPPLAN = -0.135 * MILLIASEC2RAD
const DEPLAN = 0.388 * MILLIASEC2RAD

// Nutation, IAU 2000B model.
export function eraNut00b(tt1: number, tt2: number): [Angle, Angle] {
	// Interval between fundamental epoch J2000.0 and given date (JC).
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	// Fundamental (Delaunay) arguments from Simon et al. (1994)

	// Mean anomaly of the Moon.
	const el = arcsec((485868.249036 + 1717915923.2178 * t) % TURNAS)
	// Mean anomaly of the Sun.
	const elp = arcsec((1287104.79305 + 129596581.0481 * t) % TURNAS)
	// Mean argument of the latitude of the Moon.
	const f = arcsec((335779.526232 + 1739527262.8478 * t) % TURNAS)
	// Mean elongation of the Moon from the Sun.
	const d = arcsec((1072260.70369 + 1602961601.209 * t) % TURNAS)
	// Mean longitude of the ascending node of the Moon.
	const om = arcsec((450160.398036 - 6962890.5431 * t) % TURNAS)

	let dp = 0
	let de = 0

	for (let i = IAU2000B_LS.length - 1; i >= 0; i--) {
		const [nl, nlp, nf, nd, nom, ps, pst, pc, ec, ect, es] = IAU2000B_LS[i]
		const arg = (nl * el + nlp * elp + nf * f + nd * d + nom * om) % TAU

		const sarg = Math.sin(arg)
		const carg = Math.cos(arg)

		// Term.
		dp += (ps + pst * t) * sarg + pc * carg
		de += (ec + ect * t) * carg + es * sarg
	}

	// Add luni-solar and planetary components.
	return [arcsec(dp) / 10000000 + DPPLAN, arcsec(de) / 10000000 + DEPLAN]
}

// Precession matrix (including frame bias) from GCRS to a specified date, IAU 2006 model.
export function eraPmat06(tt1: number, tt2: number) {
	// Bias-precession Fukushima-Williams angles.
	const [gamb, phib, psib, epsa] = eraPfw06(tt1, tt2)
	// Form the matrix.
	return eraFw2m(gamb, phib, psib, epsa)
}

// Form the matrix of polar motion for a given date, IAU 2000.
export function eraPom00(xp: Angle, yp: Angle, sp: Angle) {
	return matRotZ(sp, matRotY(-xp, matRotX(-yp)))
}

// Assemble the celestial to terrestrial matrix from equinox-based
// components (the celestial-to-true matrix, the Greenwich Apparent
// Sidereal Time and the polar motion matrix).
export function eraC2teqx(rbpn: Mat3, gast: Angle, rpom: Mat3) {
	const m = matRotZ(gast)
	return matMul(rpom, matMul(m, rbpn, m), m)
}

const WGS84_RADIUS = 6378137 / AU_M
const WGS84_FLATTENING = 1 / 298.257223563

// Transform geocentric coordinates to geodetic for a reference ellipsoid of specified form.
export function eraGc2Gde(radius: Distance, flattening: number, x: Distance, y: Distance, z: Distance): [Angle, Angle, Distance] {
	const aeps2 = radius * radius * 1e-32
	const e2 = (2 - flattening) * flattening

	const e4t = e2 * e2 * 1.5
	const ec2 = 1 - e2

	const ec = Math.sqrt(ec2)
	const b = radius * ec

	const p2 = x * x + y * y

	const elong = p2 > 0 ? Math.atan2(y, x) : 0

	const absz = Math.abs(z)

	let phi = 0
	let height = 0

	// Proceed unless polar case.
	if (p2 > aeps2) {
		// Distance from polar axis.
		const p = Math.sqrt(p2)

		// Normalization.
		const s0 = absz / radius
		const pn = p / radius
		const zc = ec * s0

		// Prepare Newton correction factors.
		const c0 = ec * pn
		const c02 = c0 * c0
		const c03 = c02 * c0
		const s02 = s0 * s0
		const s03 = s02 * s0
		const a02 = c02 + s02
		const a0 = Math.sqrt(a02)
		const a03 = a02 * a0
		const d0 = zc * a03 + e2 * s03
		const f0 = pn * a03 - e2 * c03

		const b0 = e4t * s02 * c02 * pn * (a0 - ec)
		const s1 = d0 * f0 - b0 * s0
		const cc = ec * (f0 * f0 - b0 * c0)

		phi = Math.sign(z) * Math.atan(s1 / cc)
		const s12 = s1 * s1
		const cc2 = cc * cc
		height = (p * cc + absz * s1 - radius * Math.sqrt(ec2 * s12 + cc2)) / Math.sqrt(s12 + cc2)
	} else {
		phi = Math.sign(z) * PIOVERTWO
		height = absz - b
	}

	return [elong, phi, height]
}

// Transform geodetic coordinates to geocentric using the specified reference ellipsoid.
export function eraGd2Gce(radius: Distance, flattening: number, elong: Angle, phi: Angle, height: Distance): [Distance, Distance, Distance] {
	const sp = Math.sin(phi)
	const cp = Math.cos(phi)
	const omf = 1 - flattening
	const w = omf * omf
	const d = cp * cp + w * sp * sp

	const ac = radius / Math.sqrt(d)
	const aS = w * ac

	const r = (ac + height) * cp
	const x = r * Math.cos(elong)
	const y = r * Math.sin(elong)
	const z = (aS + height) * sp

	return [x, y, z]
}

// Frame bias and precession, IAU 2006.
export function eraBp06(tt1: number, tt2: number) {
	// B matrix.
	const [gamb, phib, psib, epsa] = eraPfw06(MJD0, MJD2000)
	const rb = eraFw2m(gamb, phib, psib, epsa)

	// PxB matrix (temporary).
	const rbpw = eraPmat06(tt1, tt2)

	// P matrix.
	const rp = matTranspose(rb)
	matMul(rbpw, rp, rp)

	return [rb, rp, rbpw] as const
}

const PXMIN = 5e-7 * ASEC2RAD

//  Convert star catalog coordinates to position+velocity vector.
export function eraStarpv(ra: Angle, dec: Angle, pmRa: Angle, pmDec: Angle, parallax: Angle, rv: Velocity) {
	// Distance (au).
	const r = 1 / Math.max(parallax, PXMIN)
	// const r = parallax === 0 ? ONE_GIGAPARSEC : (ONE_PARSEC * PI) / 648000 / Math.max(parallax, PXMIN)

	// To pv-vector (au, au/day).
	const pv = eraS2pv(ra, dec, r, pmRa / DAYSPERJY, pmDec / DAYSPERJY, rv)

	// Largest allowed speed (fraction of c).
	if (vecLength(pv[1]) / SPEED_OF_LIGHT_AU_DAY > 0.5) {
		vecFill(pv[1], 0, 0, 0)
		return pv
	}

	// Isolate the radial component of the velocity (au/day).
	const pu = vecNormalize(pv[0])
	const vsr = vecDot(pu, pv[1])
	const usr = vecMulScalar(pu, vsr)

	// Isolate the transverse component of the velocity (au/day).
	const ust = vecMinus(pv[1], usr, usr)
	const vst = vecLength(ust)

	// Special-relativity dimensionless parameters.
	const betsr = vsr / SPEED_OF_LIGHT_AU_DAY
	const betst = vst / SPEED_OF_LIGHT_AU_DAY

	// Determine the observed-to-inertial correction terms.
	let bett = betst
	let betr = betsr

	let d = 0
	let del = 0
	let odd = 0
	let oddel = 0
	let od = 0
	let odel = 0

	for (let i = 0; i < 100; i++) {
		d = 1 + betr
		const w = betr * betr + bett * bett
		del = -w / (Math.sqrt(1 - w) + 1)
		betr = d * betsr + del
		bett = d * betst

		if (i > 0) {
			const dd = Math.abs(d - od)
			const ddel = Math.abs(del - odel)
			if (i > 1 && dd >= odd && ddel >= oddel) break
			odd = dd
			oddel = ddel
		}

		od = d
		odel = del
	}

	// Scale observed tangential velocity vector into inertial (au/d).
	const ut = vecMulScalar(ust, d, ust)

	// Compute inertial radial velocity vector (au/d).
	const ur = vecMulScalar(pu, SPEED_OF_LIGHT_AU_DAY * (d * betsr + del), pu)

	// Combine the two to obtain the inertial space velocity vector.
	vecPlus(ur, ut, pv[1])

	return pv
}

// Convert position+velocity from spherical to cartesian coordinates.
export function eraS2pv(theta: Angle, phi: Angle, r: Distance, td: Angle, pd: Angle, rd: Velocity) {
	const st = Math.sin(theta)
	const ct = Math.cos(theta)
	const sp = Math.sin(phi)
	const cp = Math.cos(phi)
	const rcp = r * cp
	const x = rcp * ct
	const y = rcp * st
	const rpd = r * pd
	const w = rpd * sp - cp * rd

	const p: MutVec3 = [x, y, r * sp]
	const v: MutVec3 = [-y * td - w * ct, x * td - w * st, rpd * cp + sp * rd]
	return [p, v] as const
}

// NOT PRESENT IN ERFA!
// Update star position+velocity vector for space motion.
export function eraStarpmpv(pv1: readonly [Vec3, Vec3], ep1a: number, ep1b: number, ep2a: number, ep2b: number) {
	// Light time when observed (days).
	const tl1 = vecLength(pv1[0]) / SPEED_OF_LIGHT_AU_DAY

	// Time interval, "before" to "after" (days).
	const dt = ep2a - ep1a + (ep2b - ep1b)

	// Move star along track from the "before" observed position to the "after" geometric position.
	const p1 = eraPpsp(pv1[0], dt + tl1, pv1[1])

	// From this geometric position, deduce the observed light time (days)
	// at the "after" epoch (with theoretically unneccessary error check).
	const v2 = vecDot(pv1[1], pv1[1])
	const c2mv2 = SPEED_OF_LIGHT_AU_DAY * SPEED_OF_LIGHT_AU_DAY - v2
	// if (c2mv2 <= 0) return false

	const r2 = vecDot(p1, p1)
	const rdv = vecDot(p1, pv1[1])
	const tl2 = (-rdv + Math.sqrt(rdv * rdv + c2mv2 * r2)) / c2mv2

	// Move the position along track from the observed place at the
	// "before" epoch to the observed place at the "after" epoch.
	return eraPpsp(pv1[0], dt + (tl1 - tl2), pv1[1], p1)
}

// Update star catalog data for space motion.
// ra(rad), dec(rad), pmRa(rad/y), pmDec(rad/y), parallax(rad), rv(AU/d)
export function eraStarpm(ra1: Angle, dec1: Angle, pmr1: Angle, pmd1: Angle, px1: Angle, rv1: Velocity, ep1a: number, ep1b: number, ep2a: number, ep2b: number) {
	// RA,Dec etc. at the "before" epoch to space motion pv-vector.
	const pv1 = eraStarpv(ra1, dec1, pmr1, pmd1, Math.max(px1, PXMIN), rv1)

	// Space motion pv-vector to RA,Dec etc. at the "after" epoch.
	const pv2 = eraStarpmpv(pv1, ep1a, ep1b, ep2a, ep2b)
	return eraPvstar(pv2, pv1[1])
}

// Convert star position+velocity vector to catalog coordinates.
// ra(rad), dec(rad), pmRa(rad/y), pmDec(rad/y), parallax(rad), rv(AU/d)
export function eraPvstar(p: Vec3, v: Vec3): [Angle, Angle, Angle, Angle, Angle, Velocity] | false {
	// Isolate the radial component of the velocity (au/day, inertial).
	const pu = vecNormalize(p)
	const vr = vecDot(pu, v)
	const ur = vecMulScalar(pu, vr)

	// Isolate the transverse component of the velocity (au/day, inertial).
	const ut = vecMinus(v, ur, ur)
	const vt = vecLength(ut)

	// Special-relativity dimensionless parameters.
	const bett = vt / SPEED_OF_LIGHT_AU_DAY
	const betr = vr / SPEED_OF_LIGHT_AU_DAY

	// The observed-to-inertial correction terms.
	const d = 1 + betr
	const w = betr * betr + bett * bett
	if (d === 0 || w > 1) return false
	const del = -w / (Math.sqrt(1 - w) + 1)

	// Scale inertial tangential velocity vector into observed (au/d).
	const ust = vecDivScalar(ut, d, ut)

	// Compute observed radial velocity vector (au/d).
	const usr = vecMulScalar(pu, (SPEED_OF_LIGHT_AU_DAY * (betr - del)) / d)

	// Combine the two to obtain the observed velocity vector.
	const ov = vecPlus(usr, ust, usr)

	// Cartesian to spherical.
	// [ra, dec, r, rad, decd, rd]
	const ret = eraPv2s(p, ov)

	if (ret[2] === 0) return false

	// Return RA in range 0 to 2pi.
	ret[0] = normalizeAngle(ret[0])

	// Return proper motions in radians per year.
	ret[3] *= DAYSPERJY
	ret[4] *= DAYSPERJY

	// Return parallax.
	const px = ret[2]

	// Adjust the return order.
	ret[2] = ret[3]
	ret[3] = ret[4]
	ret[4] = 1 / px

	return ret
}

// Convert position+velocity from cartesian to spherical coordinates.
export function eraPv2s(p: Vec3, v: Vec3): [Angle, Angle, Angle, number, number, number] {
	// Components of position+velocity vector.
	let [x, y, z] = p
	const [xd, yd, zd] = v

	// Component of r in XY plane squared.
	let rxy2 = x * x + y * y

	// Modulus squared.
	let r2 = rxy2 + z * z

	// Modulus.
	const rtrue = Math.sqrt(r2)

	// If null vector, move the origin along the direction of movement.
	let rw = rtrue

	if (rtrue === 0) {
		x = xd
		y = yd
		z = zd
		rxy2 = x * x + y * y
		r2 = rxy2 + z * z
		rw = Math.sqrt(r2)
	}

	// Position and velocity in spherical coordinates.
	const rxy = Math.sqrt(rxy2)
	const xyp = x * xd + y * yd

	const rd = rw !== 0 ? (xyp + z * zd) / rw : 0

	if (rxy2 !== 0) {
		const theta = Math.atan2(y, x)
		const phi = Math.atan2(z, rxy)
		const td = (x * yd - y * xd) / rxy2
		const pd = (zd * rxy2 - z * xyp) / (r2 * rxy)
		return [theta, phi, rtrue, td, pd, rd]
	} else {
		const phi = z !== 0 ? Math.atan2(z, rxy) : 0
		return [0, phi, rtrue, 0, 0, rd]
	}
}

// P-vector plus scaled p-vector: a + s*b.
export function eraPpsp(a: Vec3, s: number, b: Vec3, o?: MutVec3) {
	const sb = vecMulScalar(b, s, o)
	return vecPlus(a, sb, o ?? sb)
}

// Angular separation between two sets of spherical coordinates.
export function eraSeps(al: Angle, ap: Angle, bl: Angle, bp: Angle) {
	return eraSepp(eraS2c(al, ap), eraS2c(bl, bp))
}

// Angular separation between two p-vectors.
export function eraSepp(a: Vec3, b: Vec3) {
	// Sine of angle between the vectors, multiplied by the two moduli.
	const axb = vecCross(a, b)
	const ss = vecLength(axb)

	// Cosine of the angle, multiplied by the two moduli.
	const cs = vecDot(a, b)

	return ss !== 0 || cs !== 0 ? Math.atan2(ss, cs) : 0
}

const AULTY = LIGHT_TIME_AU / DAYSEC / DAYSPERJY

// Proper motion and parallax.
export function eraPmpx(rc: Angle, dc: Angle, pr: Angle, pd: Angle, px: Angle, rv: Angle, pmt: number, pob: Vec3) {
	// Spherical coordinates to unit vector (and useful functions).
	const sr = Math.sin(rc)
	const cr = Math.cos(rc)
	const sd = Math.sin(dc)
	const cd = Math.cos(dc)
	const x = cr * cd
	const y = sr * cd
	const z = sd

	// Proper motion time interval (y) including Roemer effect.
	const dt = pmt + (x * pob[0] + y * pob[1] + z * pob[2]) * AULTY

	// Space motion (radians per year).
	const pxr = Math.max(px, PXMIN)
	const w = rv * DAYSPERJY * pxr
	const pdz = pd * z
	const pm0 = -pr * y - pdz * cr + w * x
	const pm1 = pr * x - pdz * sr + w * y
	const pm2 = pd * cd + w * z

	// Coordinate direction of star (unit vector, BCRS).
	const p0 = x + dt * pm0 - pxr * pob[0]
	const p1 = y + dt * pm1 - pxr * pob[1]
	const p2 = z + dt * pm2 - pxr * pob[2]
	const p: MutVec3 = [p0, p1, p2]

	return vecNormalize(p, p) as MutVec3
}

// Apply aberration to transform natural direction into proper direction.
export function eraAb(pnat: Vec3, v: Vec3, s: number, bm1: number, o?: MutVec3) {
	const pdv = vecDot(pnat, v)
	const w1 = 1 + pdv / (1 + bm1)
	const w2 = SCHWARZSCHILD_RADIUS_OF_THE_SUN / s
	let r2 = 0

	const p = o ?? vecZero()

	for (let i = 0; i < 3; i++) {
		const w = pnat[i] * bm1 + w1 * v[i] + w2 * (v[i] - pdv * pnat[i])
		p[i] = w
		r2 += w * w
	}

	return vecDivScalar(p, Math.sqrt(r2), p)
}

export interface LdBody {
	readonly bm: number // mass of the body (solar masses)
	readonly dl: number // deflection limiter (radians^2/2)
	// barycentric PV of the body (au, au/day)
	readonly p: Vec3
	readonly v: Vec3
}

// For a star, apply light deflection by multiple solar-system bodies,
// as part of transforming coordinate direction into natural direction.
export function eraLdn(b: LdBody[], ob: Vec3, sc: Vec3) {
	const v: MutVec3 = [0, 0, 0]
	const ev: MutVec3 = [0, 0, 0]

	// Star direction prior to deflection.
	const sn = vecClone(sc)

	for (const a of b) {
		// Body to observer vector at epoch of observation (au).
		vecMinus(ob, a.p, v)

		// Minus the time since the light passed the body (days).
		// Neutralize if the star is "behind" the observer.
		const dt = Math.min(vecDot(sn, v) * (LIGHT_TIME_AU / DAYSEC), 0)

		// Backtrack the body to the time the light was passing the body.
		eraPpsp(v, -dt, a.v, ev)

		// Body to observer vector as magnitude and direction.
		const em = vecLength(ev)
		vecDivScalar(ev, em, ev)

		// Apply light deflection for this body.
		eraLd(a.bm, sn, sn, ev, em, a.dl, sn)
	}

	return sn
}

// Apply light deflection by a solar-system body, as part of
// transforming coordinate direction into natural direction.
export function eraLd(bm: number, p: Vec3, q: Vec3, e: Vec3, em: number, dlim: number, o?: MutVec3) {
	// q . (q + e).
	const qpe = vecPlus(q, e)
	const qdqpe = vecDot(q, qpe)

	// 2 x G x bm / ( em x c^2 x ( q . (q + e) ) ).
	const w = (bm * SCHWARZSCHILD_RADIUS_OF_THE_SUN) / em / Math.max(qdqpe, dlim)

	// p x (e x q).
	vecCross(p, vecCross(e, q, qpe), qpe)

	// Apply the deflection.
	return vecPlus(p, vecMulScalar(qpe, w, qpe), o ?? qpe)
}

// Deflection of starlight by the Sun.
export function eraLdSun(p: Vec3, e: Vec3, em: number, o?: MutVec3) {
	// Deflection limiter (smaller for distant observers).
	const em2 = Math.max(1, em * em)

	// Apply the deflection.
	return eraLd(1, p, p, e, em, 1e-6 / em2, o)
}

// Form the celestial to terrestrial matrix given the date, the UT1 and
// the polar motion, using the IAU 2006/2000A precession-nutation model.
export function eraC2t06a(tt1: number, tt2: number, ut11: number, ut12: number, xp: Angle, yp: Angle) {
	// Form the celestial-to-intermediate matrix for this TT.
	const rc2i = eraC2i06a(tt1, tt2)

	// Predict the Earth rotation angle for this UT1.
	const era = eraEra00(ut11, ut12)

	// Estimate s'.
	const sp = eraSp00(tt1, tt2)

	// Form the polar motion matrix.
	const rpom = eraPom00(xp, yp, sp)

	// Combine to form the celestial-to-terrestrial matrix.
	return eraC2tcio(rc2i, era, rpom, rc2i)
}

// Form the celestial-to-intermediate matrix for a given date using the
// IAU 2006 precession and IAU 2000A nutation models.
export function eraC2i06a(tt1: number, tt2: number) {
	// Obtain the celestial-to-true matrix (IAU 2006/2000A).
	const rbpn = eraPnm06a(tt1, tt2)

	// Extract the X,Y coordinates.
	const x = rbpn[6]
	const y = rbpn[7]

	// Obtain the CIO locator.
	const s = eraS06(tt1, tt2, x, y)

	// Form the celestial-to-intermediate matrix.
	return eraC2ixys(x, y, s, rbpn)
}

// Form the celestial to intermediate-frame-of-date matrix given the CIP X,Y and the CIO locator s.
export function eraC2ixys(x: Angle, y: Angle, s: Angle, o?: MutMat3) {
	// Obtain the spherical angles E and d.
	const r2 = x * x + y * y
	const e = r2 > 0 ? Math.atan2(y, x) : 0
	const d = Math.atan(Math.sqrt(r2 / (1 - r2)))

	if (o) matIdentity(o)

	// Form the matrix.
	return matRotZ(-(e + s), matRotY(d, matRotZ(e, o)))
}

// Assemble the celestial to terrestrial matrix from CIO-based
// components (the celestial-to-intermediate matrix, the Earth Rotation
// Angle and the polar motion matrix).
export function eraC2tcio(rc2i: Mat3, era: Angle, rpom: Mat3, o?: MutMat3) {
	o = o ? matCopy(rc2i, o) : matClone(rc2i)
	return matMul(rpom, matRotZ(era, o), o)
}

// For a terrestrial observer, prepare star-independent astrometry
// parameters for transformations between ICRS and geocentric CIRS
// coordinates. The caller supplies the date, and ERFA models are used
// to predict the Earth ephemeris and CIP/CIO.
export function eraApci13(tdb1: number, tdb2: number, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], astrom?: EraAstrom) {
	// Form the equinox based BPN matrix, IAU 2006/2000A.
	const r = eraPnm06a(tdb1, tdb2)

	// Extract CIP X,Y.
	const x = r[6] // 2x0
	const y = r[7] // 2x1

	// Obtain CIO locator s.
	const s = eraS06(tdb1, tdb2, x, y)

	// Compute the star-independent astrometry parameters.
	astrom = eraApci(tdb1, tdb2, ebpv, ehp, x, y, s, astrom)

	// Equation of the origins.
	const eo = eraEors(r, s)

	return [astrom, eo] as const
}

// For a terrestrial observer, prepare star-independent astrometry
// parameters for transformations between ICRS and geocentric CIRS
// coordinates. The Earth ephemeris and CIP/CIO are supplied by the caller.
// TT can be used instead of TDB without any significant impact on accuracy.
export function eraApci(tdb1: number, tdb2: number, ebpv: readonly [Vec3, Vec3], ehp: Vec3, x: Angle, y: Angle, s: Angle, astrom?: EraAstrom) {
	// Star-independent astrometry parameters for geocenter.
	astrom = eraApcg(tdb1, tdb2, ebpv, ehp, astrom)

	// CIO based BPN matrix.
	astrom.bpn = eraC2ixys(x, y, s, astrom.bpn)

	return astrom
}

const ZERO_PV = [vecZero(), vecZero()] as const

// For a geocentric observer, prepare star-independent astrometry
// parameters for transformations between ICRS and GCRS coordinates.
// The Earth ephemeris is supplied by the caller.
// TT can be used instead of TDB without any significant impact on accuracy.
export function eraApcg(tdb1: number, tdb2: number, ebpv: readonly [Vec3, Vec3], ehp: Vec3, astrom?: EraAstrom) {
	// Compute the star-independent astrometry parameters.
	return eraApcs(tdb1, tdb2, ZERO_PV, ebpv, ehp, astrom)
}

// For an observer whose geocentric position and velocity are known,
// prepare star-independent astrometry parameters for transformations
// between ICRS and GCRS. The Earth ephemeris is supplied by the caller.
// TT can be used instead of TDB without any significant impact on accuracy.
export function eraApcs(tdb1: number, tdb2: number, pv: readonly [Vec3, Vec3], ebpv: readonly [Vec3, Vec3], ehp: Vec3, astrom?: EraAstrom) {
	astrom ??= structuredClone(EMPTY_ERA_ASTROM)

	// Time since reference epoch, years (for proper motion calculation).
	astrom.pmt = (tdb1 - J2000 + tdb2) / DAYSPERJY

	// Adjust Earth ephemeris to observer.
	for (let i = 0; i < 3; i++) {
		const dp = pv[0][i]
		const dv = pv[1][i]
		astrom.eb[i] = ebpv[0][i] + dp
		astrom.v[i] = ebpv[1][i] + dv
		astrom.eh[i] = ehp[i] + dp
	}

	// Heliocentric direction and distance (unit vector and au).
	astrom.em = vecLength(astrom.eh)
	astrom.eh = vecDivScalar(astrom.eh, astrom.em, astrom.eh)

	// Barycentric vel. in units of c, and reciprocal of Lorenz factor.
	let v2 = 0

	for (let i = 0; i < 3; i++) {
		const w = astrom.v[i] * (LIGHT_TIME_AU / DAYSEC)
		astrom.v[i] = w
		v2 += w * w
	}

	astrom.bm1 = Math.sqrt(1.0 - v2)

	// Reset the NPB matrix.
	astrom.bpn = matIdentity(astrom.bpn)

	return astrom
}

// Quick transformation of a star's ICRS catalog entry (epoch J2000.0)
// into ICRS astrometric place, given precomputed star-independent
// astrometry parameters.
// NOTE: Changed to return cartesian coordinate instead of spherical coordinate.
export function eraAtccq(rc: Angle, dc: Angle, pr: Angle, pd: Angle, px: Distance, rv: Velocity, astrom: EraAstrom) {
	// Proper motion and parallax, giving BCRS coordinate direction.
	const p = eraPmpx(rc, dc, pr, pd, px, rv, astrom.pmt, astrom.eb)

	// ICRS astrometric RA,Dec.
	// const s = eraC2s(...p)
	// s[0] = pmod(s[0], TAU)
	// return s

	return p
}

// Quick ICRS, epoch J2000.0, to CIRS transformation, given precomputed
// star-independent astrometry parameters.
// NOTE: Changed to return cartesian coordinate instead of spherical coordinate.
export function eraAtciq(rc: Angle, dc: Angle, pr: Angle, pd: Angle, px: Distance, rv: Velocity, astrom: EraAstrom) {
	// Proper motion and parallax, giving BCRS coordinate direction.
	const pco = eraPmpx(rc, dc, pr, pd, px, rv, astrom.pmt, astrom.eb)

	// BCRS to CIRS transformation.
	// Light deflection by the Sun, giving BCRS natural direction.
	const pnat = eraLdSun(pco, astrom.eh, astrom.em, pco)

	// Aberration, giving GCRS proper direction.
	const ppr = eraAb(pnat, astrom.v, astrom.em, astrom.bm1, pnat)

	// Bias-precession-nutation, giving CIRS proper direction.
	const pi = matMulVec(astrom.bpn, ppr, ppr)

	// ICRS astrometric RA,Dec.
	const s = eraC2s(...pi)
	s[0] = pmod(s[0], TAU)
	return s
}

// For a terrestrial observer, prepare star-independent astrometry
// parameters for transformations between ICRS and observed
// coordinates.  The caller supplies the Earth ephemeris, the Earth
// rotation information and the refraction constants as well as the
// site coordinates.
export function eraApco(
	tdb1: number,
	tdb2: number,
	ebpv: readonly [Vec3, Vec3],
	ehp: Vec3,
	x: number,
	y: number,
	s: Angle,
	theta: Angle,
	elong: Angle,
	phi: Angle,
	hm: Distance,
	xp: Angle,
	yp: Angle,
	sp: Angle,
	refa: number,
	refb: number,
	radius: Distance = WGS84_RADIUS,
	flattening: number = WGS84_FLATTENING,
	astrom?: EraAstrom,
) {
	astrom ??= structuredClone(EMPTY_ERA_ASTROM)

	// Form the rotation matrix, CIRS to apparent [HA,Dec].
	const r = matRotZ(elong, matRotX(-yp, matRotY(-xp, matRotZ(theta + sp))))

	// Solve for local Earth rotation angle.
	let a = r[0]
	let b = r[1]
	astrom.eral = a !== 0 || b !== 0 ? Math.atan2(b, a) : 0

	// Solve for polar motion [X,Y] with respect to local meridian.
	a = r[0]
	const c = r[2]
	astrom.xpl = Math.atan2(c, Math.sqrt(a * a + b * b))
	a = r[5]
	b = r[8]
	astrom.ypl = a !== 0 || b !== 0 ? -Math.atan2(a, b) : 0

	// Adjusted longitude.
	astrom.along = eraAnpm(astrom.eral - theta)

	// Functions of latitude.
	astrom.sphi = Math.sin(phi)
	astrom.cphi = Math.cos(phi)

	// Refraction constants.
	astrom.refa = refa
	astrom.refb = refb

	// Disable the (redundant) diurnal aberration step.
	astrom.diurab = 0.0

	// CIO based BPN matrix.
	eraC2ixys(x, y, s, r)

	// Observer's geocentric position and velocity (AU, AU/day, CIRS).
	const pvc = eraPvtob(elong, phi, hm, xp, yp, sp, theta, radius, flattening)

	// Rotate into GCRS.
	matMulTransposeVec(r, pvc[0], pvc[0])
	matMulTransposeVec(r, pvc[1], pvc[1])

	// ICRS <-> GCRS parameters.
	astrom = eraApcs(tdb1, tdb2, pvc, ebpv, ehp, astrom)

	// Store the CIO based BPN matrix.
	astrom.bpn = r

	return astrom
}

// Earth rotation rate in radians per UT1 second.
// const OM = (1.00273781191135448 * TAU) / DAYSEC
const OM = 1.00273781191135448 * TAU // as unit is AU/day

// Position and velocity of a terrestrial observing station.
export function eraPvtob(elong: Angle, phi: Angle, hm: Distance, xp: Angle, yp: Angle, sp: Angle, theta: Angle, radius: Distance = WGS84_RADIUS, flattening: number = WGS84_FLATTENING) {
	// Geodetic to geocentric transformation (ERFA_WGS84).
	const xyzm = eraGd2Gce(radius, flattening, elong, phi, hm)

	// Polar motion and TIO position.
	const rpm = eraPom00(xp, yp, sp)
	const p = matMulTransposeVec(rpm, xyzm, xyzm)
	const [x, y, z] = p

	// Functions of ERA.
	const s = Math.sin(theta)
	const c = Math.cos(theta)

	// Position.
	p[0] = c * x - s * y
	p[1] = s * x + c * y
	p[2] = z

	// Velocity.
	const vx = OM * (-s * x - c * y)
	const vy = OM * (c * x - s * y)
	const v: MutVec3 = [vx, vy, 0]

	return [p, v] as const
}

// For a terrestrial observer, prepare star-independent astrometry
// parameters for transformations between ICRS and observed
// coordinates. The caller supplies UTC, site coordinates, ambient air
// conditions and observing wavelength, and ERFA models are used to
// obtain the Earth ephemeris, CIP/CIO and refraction constants.
export function eraApco13(
	tt1: number,
	tt2: number,
	ut11: number,
	ut12: number,
	elong: Angle,
	phi: Angle,
	hm: Distance,
	xp: Angle,
	yp: Angle,
	sp: Angle,
	phpa: Pressure,
	tc: Temperature,
	rh: number,
	wl: number,
	ebpv: readonly [Vec3, Vec3],
	ehp: Vec3,
	radius: Distance = WGS84_RADIUS,
	flattening: number = WGS84_FLATTENING,
	astrom?: EraAstrom,
) {
	// Form the equinox based BPN matrix, IAU 2006/2000A.
	const r = eraPnm06a(tt1, tt2)

	// Extract CIP X,Y.
	const x = r[6] // 2x0
	const y = r[7] // 2x1

	// Obtain CIO locator s.
	const s = eraS06(tt1, tt2, x, y)

	// Earth rotation angle.
	const theta = eraEra00(ut11, ut12)

	// TIO locator s'.
	if (sp === 0) sp = eraSp00(tt1, tt2)

	// Refraction constants A and B.
	const ref = eraRefco(phpa, tc, rh, wl)

	// Compute the star-independent astrometry parameters.
	astrom = eraApco(tt1, tt2, ebpv, ehp, x, y, s, theta, elong, phi, hm, xp, yp, sp, ref[0], ref[1], radius, flattening, astrom)

	// Equation of the origins.
	const eo = eraEors(r, s)

	return [astrom, eo] as const
}

// Determine the constants A and B in the atmospheric refraction model dZ = A tan Z + B tan^3 Z.
// Z is the "observed" zenith distance (i.e. affected by refraction)
// and dZ is what to add to Z to give the "topocentric" (i.e. in vacuo)
// zenith distance.
export function eraRefco(phpa: Pressure, tc: Temperature, rh: number, wl: number) {
	if (phpa === 0) return [0, 0] as const

	// Decide whether optical/IR or radio case:  switch at 100 microns.
	const optic = wl <= 100

	// Restrict parameters to safe values.
	const t = Math.max(-150, Math.min(tc, 200))
	const p = Math.max(0, Math.min(phpa, 10000))
	const r = Math.max(0, Math.min(rh, 1))
	const w = Math.max(0.1, Math.min(wl, 1e6))

	let pw = 0

	// Water vapour pressure at the observer.
	if (p > 0) {
		const ps = 10 ** ((0.7859 + 0.03477 * t) / (1 + 0.00412 * t)) * (1 + p * (4.5e-6 + 6e-10 * t * t))
		pw = (r * ps) / (1 - ((1 - r) * ps) / p)
	}

	// Refractive index minus 1 at the observer.
	const tk = t + 273.15
	let gamma = 0

	if (optic) {
		const wlsq = w * w
		gamma = ((77.53484e-6 + (4.39108e-7 + 3.666e-9 / wlsq) / wlsq) * p - 11.2684e-6 * pw) / tk
	} else {
		gamma = (77.689e-6 * p - (6.3938e-6 - 0.375463 / tk) * pw) / tk
	}

	// Formula for beta from Stone, with empirical adjustments.
	let beta = 4.4474e-6 * tk
	if (!optic) beta -= 0.0074 * pw * beta

	// Refraction constants from Green.
	const refa = gamma * (1 - beta)
	const refb = -gamma * (beta - gamma / 2)

	return [refa, refb] as const
}

// For a terrestrial observer, prepare star-independent astrometry
// parameters for transformations between CIRS and observed
// coordinates.  The caller supplies UTC, site coordinates, ambient air
// conditions and observing wavelength.
export function eraApio13(tt1: number, tt2: number, ut11: number, ut12: number, elong: Angle, phi: Angle, hm: Distance, xp: Angle, yp: Angle, phpa: Pressure, tc: Temperature, rh: number, wl: number, astrom?: EraAstrom) {
	// TIO locator s'.
	const sp = eraSp00(tt1, tt2)

	// Earth rotation angle.
	const theta = eraEra00(ut11, ut12)

	// Refraction constants A and B.
	const ref = eraRefco(phpa, tc, rh, wl)

	// CIRS <-> observed astrometry parameters.
	astrom = eraApio(sp, theta, elong, phi, hm, xp, yp, ref[0], ref[1], astrom)

	return astrom
}

// For a terrestrial observer, prepare star-independent astrometry
// parameters for transformations between CIRS and observed
// coordinates.  The caller supplies the Earth orientation information
// and the refraction constants as well as the site coordinates.
export function eraApio(sp: Angle, theta: Angle, elong: Angle, phi: Angle, hm: Distance, xp: Angle, yp: Angle, refa: number, refb: number, astrom?: EraAstrom) {
	astrom ??= structuredClone(EMPTY_ERA_ASTROM)

	// Form the rotation matrix, CIRS to apparent [HA,Dec].
	const r = matRotZ(elong, matRotX(-yp, matRotY(-xp, matRotZ(theta + sp))))

	// Solve for local Earth rotation angle.
	let a = r[0]
	let b = r[1]
	astrom.eral = a !== 0 || b !== 0 ? Math.atan2(b, a) : 0

	// Solve for polar motion [X,Y] with respect to local meridian.
	a = r[0]
	const c = r[2]
	astrom.xpl = Math.atan2(c, Math.sqrt(a * a + b * b))
	a = r[5]
	b = r[8]
	astrom.ypl = a !== 0 || b !== 0 ? -Math.atan2(a, b) : 0

	// Adjusted longitude.
	astrom.along = eraAnpm(astrom.eral - theta)

	// Functions of latitude.
	astrom.sphi = Math.sin(phi)
	astrom.cphi = Math.cos(phi)

	// Observer's geocentric position and velocity (m, m/s, CIRS).
	const pv = eraPvtob(elong, phi, hm, xp, yp, sp, theta)

	// Magnitude of diurnal aberration vector.
	astrom.diurab = Math.sqrt(pv[1][0] * pv[1][0] + pv[1][1] * pv[1][1]) / SPEED_OF_LIGHT_AU_DAY

	// Refraction constants.
	astrom.refa = refa
	astrom.refb = refb

	return astrom
}

// Quick CIRS to observed place transformation.
export function eraAtioq(ri: Angle, di: Angle, astrom: EraAstrom) {
	// CIRS RA,Dec to Cartesian -HA,Dec.
	const v = eraS2c(ri - astrom.eral, di)
	const x = v[0]
	const y = v[1]
	let z = v[2]

	// Polar motion.
	const sx = Math.sin(astrom.xpl)
	const cx = Math.cos(astrom.xpl)
	const sy = Math.sin(astrom.ypl)
	const cy = Math.cos(astrom.ypl)
	const xhd = cx * x + sx * z
	const yhd = sx * sy * x + cy * y - cx * sy * z
	const zhd = -sx * cy * x + sy * y + cx * cy * z

	// Diurnal aberration.
	let f = 1 - astrom.diurab * yhd
	const xhdt = f * xhd
	const yhdt = f * (yhd + astrom.diurab)
	const zhdt = f * zhd

	// Cartesian -HA,Dec to Cartesian Az,El (S=0,E=90).
	const xaet = astrom.sphi * xhdt - astrom.cphi * zhdt
	const yaet = yhdt
	const zaet = astrom.cphi * xhdt + astrom.sphi * zhdt

	// Azimuth (N=0,E=90).
	const azobs = xaet !== 0 || yaet !== 0 ? Math.atan2(yaet, -xaet) : 0.0

	// ----------
	// Refraction
	// ----------

	// Cosine and sine of altitude, with precautions.
	const r = Math.max(1e-6, Math.sqrt(xaet * xaet + yaet * yaet))
	z = Math.max(0.05, zaet)

	// A*tan(z)+B*tan^3(z) model, with Newton-Raphson correction.
	const tz = r / z
	const w = astrom.refb * tz * tz
	const del = ((astrom.refa + w) * tz) / (1.0 + (astrom.refa + 3.0 * w) / (z * z))

	// Apply the change, giving observed vector.
	const cosdel = 1.0 - (del * del) / 2.0
	f = cosdel - (del * z) / r
	const xaeo = xaet * f
	const yaeo = yaet * f
	const zaeo = cosdel * zaet + del * r

	// Observed ZD.
	const zdobs = Math.atan2(Math.sqrt(xaeo * xaeo + yaeo * yaeo), zaeo)

	// Az/El vector to HA,Dec vector (both right-handed).
	v[0] = astrom.sphi * xaeo + astrom.cphi * zaeo
	v[1] = yaeo
	v[2] = -astrom.cphi * xaeo + astrom.sphi * zaeo

	// To spherical -HA,Dec.
	const [hmobs, dcobs] = eraC2s(...v)

	// Right ascension (with respect to CIO).
	const raobs = astrom.eral + hmobs

	// Return the results.
	const aob = pmod(azobs, TAU)
	const zob = zdobs
	const hob = -hmobs
	const dob = dcobs
	const rob = pmod(raobs, TAU)

	return [aob, zob, hob, dob, rob] as const
}

const FRAME_BIAS_IAU2000 = [-0.041775 * ASEC2RAD, -0.0068192 * ASEC2RAD, -0.0146 * ASEC2RAD] as const

// Frame bias components of IAU 2000 precession-nutation models;  part
// of the Mathews-Herring-Buffett (MHB2000) nutation series, with
// additions. Returns longitude and obliquity corrections,
// and the ICRS RA of the J2000.0 mean equinox.
export function eraBi00() {
	return FRAME_BIAS_IAU2000
}
