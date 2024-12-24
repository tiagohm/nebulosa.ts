import { file } from 'bun'
import fairheadFile from '../data/fairhead.dat' with { type: 'file' }
import { arcsec, deg, type Angle } from './angle'
import { DAYSEC, DAYSPERJC, DAYSPERJM, ELB, ELG, J2000, MJD0, MJD1977, TAU, TDB0, TTMINUSTAI } from './constants'
import { toKm, type Distance } from './distance'
import { pmod, roundToNearestWholeNumber } from './math'

const DBL_EPSILON = 2.220446049250313e-16

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

export type LeapSecondChange = [number, number, number]
export type LeapSecondDrift = [number, number]

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

// TODO: Can be lazy loaded?
const fairhead = new Float64Array(await file(fairheadFile).arrayBuffer())

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
		wn[0] += fairhead[j] * Math.sin(fairhead[j + 1] * t + fairhead[j + 2])
	}

	// T^1
	for (let j = 2034; j >= 1422; j -= 3) {
		wn[1] += fairhead[j] * Math.sin(fairhead[j + 1] * t + fairhead[j + 2])
	}

	// T^2
	for (let j = 2289; j >= 2037; j -= 3) {
		wn[2] += fairhead[j] * Math.sin(fairhead[j + 1] * t + fairhead[j + 2])
	}

	// T^3
	for (let j = 2349; j >= 2292; j -= 3) {
		wn[3] += fairhead[j] * Math.sin(fairhead[j + 1] * t + fairhead[j + 2])
	}

	// T^4
	for (let j = 2358; j >= 2352; j -= 3) {
		wn[4] += fairhead[j] * Math.sin(fairhead[j + 1] * t + fairhead[j + 2])
	}

	// Multiply by powers of T and combine.
	const wf = t * (t * (t * (t * wn[4] + wn[3]) + wn[2]) + wn[1]) + wn[0]

	// Adjustments to use JPL planetary masses instead of IAU.
	const wj = 0.00065e-6 * Math.sin(6069.776754 * t + 4.021194) + 0.00033e-6 * Math.sin(213.299095 * t + 5.543132) + -0.00196e-6 * Math.sin(6208.294251 * t + 5.696701) + -0.00173e-6 * Math.sin(74.781599 * t + 2.4359) + 0.03638e-6 * t * t

	// TDB-TT in seconds.
	return wt + wf + wj
}
