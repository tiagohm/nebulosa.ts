import { arcsec, deg, normalize, TURNAS, type Angle } from './angle'
import { DAYSEC, DAYSPERJC, DAYSPERJM, ELB, ELG, J2000, MJD0, MJD1977, PI, TAU, TDB0, TTMINUSTAI } from './constants'
import { toKm, type Distance } from './distance'
import { FAIRHEAD } from './fairhead'
import { IAU2000A_XLS, IAU2000A_XPL } from './iau2000a'
import { IAU2006_S, IAU2006_SP } from './iau2006'
import { pmod, roundToNearestWholeNumber } from './math'
import { rotX, rotZ, type Mat3, type MutMat3 } from './matrix'

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

export type LeapSecondChange = [number, number, number]

export type LeapSecondDrift = [number, number]

// Normalizes [angle] into the range -[PI] <= a < +[PI].
export function eraAnpm(angle: Angle): Angle {
	let w = angle % TAU
	if (Math.abs(w) >= PI) w -= angle >= 0 ? TAU : -TAU
	return w
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

		if (i == -1) {
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

export function eraCalToJd(iy: number, im: number, id: number): number {
	const my = Math.trunc((Math.trunc(im) - 14) / 12)
	const iypmy = Math.trunc(iy) + my
	return Math.trunc((1461 * (iypmy + 4800)) / 4) + Math.trunc((367 * (im - 2 - 12 * my)) / 12) - Math.trunc((3 * Math.trunc((iypmy + 4900) / 100)) / 4) + Math.trunc(id) - 2432076
}

// For a given UTC date, calculate Delta(AT) = TAI-UTC.
export function eraDat(iy: number, im: number, id: number, fd: number): number {
	const djm = eraCalToJd(iy, im, id)

	// Combine year and month to form a date-ordered integer...
	const m = 12 * iy + im
	const i = LEAP_SECOND_CHANGES.findLastIndex((x) => m >= 12 * x[0] + x[1])

	if (i < 0) return NaN

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
	const ukm = toKm(u)
	const vkm = toKm(v)
	const wt = 0.00029e-10 * ukm * Math.sin(tsol + elsun - els) + 0.001e-10 * ukm * Math.sin(tsol - 2 * emsun) + 0.00133e-10 * ukm * Math.sin(tsol - d) + 0.00133e-10 * ukm * Math.sin(tsol + elsun - elj) - 0.00229e-10 * ukm * Math.sin(tsol + 2 * elsun + emsun) - 0.022e-10 * vkm * Math.cos(elsun + emsun) + 0.05312e-10 * ukm * Math.sin(tsol - emsun) - 0.13677e-10 * ukm * Math.sin(tsol + 2 * elsun) - 1.3184e-10 * vkm * Math.cos(elsun) + 3.17679e-10 * ukm * Math.sin(tsol)

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
	const x = rnpb[6] // 2x0
	const y = rnpb[7] // 2x1

	// The CIO locator, s.
	const s = eraS06(tt1, tt2, x, y)

	// Greenwich apparent sidereal time.
	const era = eraEra00(ut11, ut12)
	const eors = eraEors(rnpb, s)

	return normalize(era - eors)
}

// Greenwich mean sidereal time (model consistent with IAU 2006 precession).
export function eraGmst06(ut11: number, ut12: number, tt1: number, tt2: number): Angle {
	// TT Julian centuries since J2000.0.
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	return normalize(eraEra00(ut11, ut12) + arcsec(0.014506 + (4612.156534 + (1.3915817 + (-0.00000044 + (-0.000029956 + -0.0000000368 * t) * t) * t) * t) * t))
}

// Earth rotation angle (IAU 2000 model).
export function eraEra00(ut11: number, ut12: number): Angle {
	const t = ut12 + (ut11 - J2000)

	// Fractional part of T (days).
	const f = (ut12 % 1.0) + (ut11 % 1.0)

	// Earth rotation angle at this UT1.
	return normalize(TAU * (f + 0.779057273264 + 0.00273781191135448 * t))
}

// Equation of the origins, given the classical NPB matrix and the quantity [s].
export function eraEors(rnpb: Mat3, s: Angle): Angle {
	const x = rnpb[6]
	const ax = x / (1.0 + rnpb[8])
	const xs = 1.0 - ax * x
	const ys = -ax * rnpb[7]
	const zs = -x
	const p = rnpb[0] * xs + rnpb[1] * ys + rnpb[2] * zs
	const q = rnpb[3] * xs + rnpb[4] * ys + rnpb[5] * zs
	return p != 0 || q != 0 ? s - Math.atan2(q, p) : s
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
			let a = 0.0

			for (let j = 0; j < 8; j++) {
				a += nfa[j] * fa[j]
			}

			w[k] += s * Math.sin(a) + c * Math.cos(a)
		}
	}

	return arcsec(w[0] + (w[1] + (w[2] + (w[3] + (w[4] + w[5] * t) * t) * t) * t) * t) - (x * y) / 2.0
}

// Form the matrix of precession-nutation for a given date (including
// frame bias), equinox based, IAU 2006 precession and IAU 2000A
// nutation models.
export function eraPnm06a(tt1: number, tt2: number): MutMat3 {
	// Fukushima-Williams angles for frame bias and precession.
	const [gamb, phib, psib, epsa] = eraPfw06(tt1, tt2)
	// Nutation.
	const [dp, de] = eraNut06a(tt1, tt2)
	// Equinox based nutation x precession x bias matrix.
	return eraFw2m(gamb, phib, psib + dp, epsa + de)
}

// Form rotation matrix given the Fukushima-Williams angles.
export function eraFw2m(gamb: Angle, phib: Angle, psi: Angle, eps: Angle): MutMat3 {
	return rotX(-eps, rotZ(-psi, rotX(phib, rotZ(gamb))))
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

	let dp = 0.0
	let de = 0.0

	// Summation of luni-solar nutation series (in reverse order).
	for (let i = IAU2000A_XLS.length - 1; i >= 0; i--) {
		const [nl, nlp, nf, nd, nom, sp, spt, cp, ce, cet, se] = IAU2000A_XLS[i]
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

	dp = 0.0
	de = 0.0

	for (let i = IAU2000A_XPL.length - 1; i >= 0; i--) {
		const [nl, nf, nd, nom, nme, nve, nea, nma, nju, nsa, nur, nne, npa, sp, cp, se, ce] = IAU2000A_XPL[i]
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
