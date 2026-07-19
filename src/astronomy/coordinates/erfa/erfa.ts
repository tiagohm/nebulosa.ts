import { ASEC2RAD, DAYSEC, DAYSPERJC, DAYSPERJM, DAYSPERJY, DAYSPERTY, ELB, ELG, J2000, LIGHT_TIME_AU, MILLIASEC2RAD, MJD0, MJD1977, PI, PIOVERTWO, SCHWARZSCHILD_RADIUS_OF_THE_SUN, SPEED_OF_LIGHT_AU_DAY, TAU, TDB0, TTMINUSTAI, TURNAS, WGS84_FLATTENING, WGS84_RADIUS } from '../../../core/constants'
import { type Mat3, type MutMat3, matClone, matCopy, matIdentity, matMul, matMulTranspose, matMulVec, matRotX, matRotY, matRotZ, matTransposeMulVec } from '../../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecClone, vecCross, vecDivScalar, vecDot, vecFill, vecLength, vecMinus, vecMulScalar, vecNormalize, vecNormalizeMut, vecPlus } from '../../../math/linear-algebra/vec3'
import { pmod, roundToNearestWholeNumber, type NumberArray } from '../../../math/numerical/math'
import { type Angle, arcsec, deg, normalizeAngle, secondsOfTime } from '../../../math/units/angle'
import { type Distance, toKilometer } from '../../../math/units/distance'
import type { Pressure } from '../../../math/units/pressure'
import type { Temperature } from '../../../math/units/temperature'
import type { Velocity } from '../../../math/units/velocity'
import { FAIRHEAD, IAU2000_EECT, IAU2000_S, IAU2006_S, NUT00A_LS, NUT00A_PL, NUT00B_LS, NUT80_X, PLAN94, VONDRAK_ECLIPTIC, VONDRAK_ECLIPTIC_POLYNOMIAL, VONDRAK_EQUATOR, VONDRAK_EQUATOR_POLYNOMIAL } from './erfa.data'

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
	eo: number // Equation of the origins (radians)
}

function eraAstrom(astrom?: Partial<EraAstrom>): EraAstrom {
	return {
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
		eo: 0,
		...astrom,
	}
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
	const theta = d2 < DBL_EPSILON ? 0 : Math.atan2(y, x)
	const phi = Math.abs(z) < DBL_EPSILON ? 0 : Math.atan2(z, Math.sqrt(d2))
	return [theta, phi]
}

// Spherical coordinates to Cartesian coordinates.
export function eraS2c(theta: Angle, phi: Angle, out?: MutVec3): MutVec3 {
	out ??= [0, 0, 0]
	const cp = Math.cos(phi)
	out[0] = Math.cos(theta) * cp
	out[1] = Math.sin(theta) * cp
	out[2] = Math.sin(phi)
	return out
}

// Spherical polar coordinates to P-vector.
export function eraS2p(theta: Angle, phi: Angle, r: Distance, out?: MutVec3): [Distance, Distance, Distance] {
	const u = eraS2c(theta, phi, out)
	u[0] *= r
	u[1] *= r
	u[2] *= r
	return u
}

// Julian Date to Besselian Epoch.
export function eraEpb(jd1: number, jd2: number) {
	return 1900 + (jd1 - J2000 + (jd2 + 36524.68648)) / DAYSPERTY
}

// Julian Date to Julian Epoch.
export function eraEpj(jd1: number, jd2: number) {
	return 2000 + (jd1 - J2000 + jd2) / DAYSPERJY
}

// Besselian epoch to Julian Date, returned as a two-part Modified Julian Date.
export function eraEpb2jd(epb: number): [number, number] {
	// MJD zero-point and Besselian epoch offset.
	return [MJD0, 15019.81352 + (epb - 1900) * DAYSPERTY]
}

// Transform ICRS right ascension and declination to ecliptic longitude and latitude of date, IAU 2006.
export function eraEqec06(date1: number, date2: number, dr: Angle, dd: Angle): [Angle, Angle] {
	const v = matMulVec(eraEcm06(date1, date2), eraS2c(dr, dd))
	const [longitude, latitude] = eraC2s(v[0], v[1], v[2])
	return [normalizeAngle(longitude), eraAnpm(latitude)]
}

// Transform ecliptic longitude and latitude of date to ICRS right ascension and declination, IAU 2006.
export function eraEceq06(date1: number, date2: number, dl: Angle, db: Angle): [Angle, Angle] {
	const v = matTransposeMulVec(eraEcm06(date1, date2), eraS2c(dl, db))
	const [rightAscension, declination] = eraC2s(v[0], v[1], v[2])
	return [normalizeAngle(rightAscension), eraAnpm(declination)]
}

// ICRS equatorial-to-ecliptic rotation matrix for the ecliptic and equinox of date, IAU 2006.
export function eraEcm06(date1: number, date2: number): MutMat3 {
	return matMul(matRotX(eraObl06(date1, date2)), eraPmat06(date1, date2))
}

// Long-term precession of the ecliptic: pole vector in the J2000.0 equatorial frame.
export function eraLtpecl(epj: number): MutVec3 {
	const t = (epj - 2000) / 100
	let p = 0
	let q = 0
	const w = TAU * t

	for (const [period, pc, qc, ps, qs] of VONDRAK_ECLIPTIC) {
		const a = w / period
		p += Math.cos(a) * pc + Math.sin(a) * ps
		q += Math.cos(a) * qc + Math.sin(a) * qs
	}

	let tp = 1
	for (let i = 0; i < 4; i++) {
		p += VONDRAK_ECLIPTIC_POLYNOMIAL[0][i] * tp
		q += VONDRAK_ECLIPTIC_POLYNOMIAL[1][i] * tp
		tp *= t
	}

	p *= ASEC2RAD
	q *= ASEC2RAD

	const pole = Math.sqrt(Math.max(0, 1 - p * p - q * q))
	const eps0 = 84381.406 * ASEC2RAD
	return [p, -q * Math.cos(eps0) - pole * Math.sin(eps0), -q * Math.sin(eps0) + pole * Math.cos(eps0)]
}

// Long-term precession of the equator: pole vector in the J2000.0 equatorial frame.
export function eraLtpequ(epj: number): MutVec3 {
	const t = (epj - 2000) / 100
	let x = 0
	let y = 0
	const w = TAU * t

	for (const [period, xc, yc, xs, ys] of VONDRAK_EQUATOR) {
		const a = w / period
		x += Math.cos(a) * xc + Math.sin(a) * xs
		y += Math.cos(a) * yc + Math.sin(a) * ys
	}

	let tp = 1
	for (let i = 0; i < 4; i++) {
		x += VONDRAK_EQUATOR_POLYNOMIAL[0][i] * tp
		y += VONDRAK_EQUATOR_POLYNOMIAL[1][i] * tp
		tp *= t
	}

	x *= ASEC2RAD
	y *= ASEC2RAD

	return [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))]
}

// Long-term precession matrix from J2000.0 mean equator and equinox to the given Julian epoch.
export function eraLtp(epj: number): MutMat3 {
	const equatorPole = eraLtpequ(epj)
	const eclipticPole = eraLtpecl(epj)
	const equinox = vecNormalize(vecCross(equatorPole, eclipticPole))
	const middle = vecCross(equatorPole, equinox)
	return [equinox[0], equinox[1], equinox[2], middle[0], middle[1], middle[2], equatorPole[0], equatorPole[1], equatorPole[2]]
}

// Long-term precession matrix including the ICRS frame bias.
export function eraLtpb(epj: number): MutMat3 {
	const rp = eraLtp(epj)
	const dx = -0.016617 * ASEC2RAD
	const de = -0.0068192 * ASEC2RAD
	const dr = -0.0146 * ASEC2RAD
	for (let i = 0; i < 9; i += 3) {
		const x = rp[i]
		const y = rp[i + 1]
		const z = rp[i + 2]
		rp[i] = x - y * dr + z * dx
		rp[i + 1] = x * dr + y + z * de
		rp[i + 2] = -x * dx - y * de + z
	}
	return rp
}

// ICRS equatorial-to-ecliptic rotation matrix using the Vondrak long-term precession model.
export function eraLtecm(epj: number): MutMat3 {
	const p = eraLtpequ(epj)
	const z = eraLtpecl(epj)
	const x = vecNormalize(vecCross(p, z))
	const y = vecCross(z, x)
	const dx = -0.016617 * ASEC2RAD
	const de = -0.0068192 * ASEC2RAD
	const dr = -0.0146 * ASEC2RAD
	return [x[0] - x[1] * dr + x[2] * dx, x[0] * dr + x[1] + x[2] * de, -x[0] * dx - x[1] * de + x[2], y[0] - y[1] * dr + y[2] * dx, y[0] * dr + y[1] + y[2] * de, -y[0] * dx - y[1] * de + y[2], z[0] - z[1] * dr + z[2] * dx, z[0] * dr + z[1] + z[2] * de, -z[0] * dx - z[1] * de + z[2]]
}

// Transform ICRS right ascension and declination to ecliptic coordinates using long-term precession.
export function eraLteqec(epj: number, dr: Angle, dd: Angle): [Angle, Angle] {
	const v = matMulVec(eraLtecm(epj), eraS2c(dr, dd))
	const [longitude, latitude] = eraC2s(v[0], v[1], v[2])
	return [normalizeAngle(longitude), eraAnpm(latitude)]
}

// Transform ecliptic coordinates to ICRS right ascension and declination using long-term precession.
export function eraLteceq(epj: number, dl: Angle, db: Angle): [Angle, Angle] {
	const v = matTransposeMulVec(eraLtecm(epj), eraS2c(dl, db))
	const [rightAscension, declination] = eraC2s(v[0], v[1], v[2])
	return [normalizeAngle(rightAscension), eraAnpm(declination)]
}

// Julian epoch to Julian Date, returned as a two-part Modified Julian Date.
export function eraEpj2jd(epj: number): [number, number] {
	// MJD zero-point and Julian epoch offset.
	return [MJD0, 51544.5 + (epj - 2000) * DAYSPERJY]
}

// Approximate heliocentric position and velocity of Mercury, Venus,
// EMB, Mars, Jupiter, Saturn, Uranus or Neptune, in J2000.0 axes.
// Returns the ERFA status (-1 invalid planet, 1 remote date, 2 no convergence)
// and position/velocity in AU and AU/day.
export function eraPlan94(tdb1: number, tdb2: number, np: number): readonly [MutVec3, MutVec3] {
	// Gaussian constant and J2000.0 mean obliquity (IAU 1976).
	const gaussianConstant = 0.01720209895
	const sineObliquity = 0.3977771559319137
	const cosineObliquity = 0.9174820620691818

	const pv: readonly [MutVec3, MutVec3] = [
		[0, 0, 0],
		[0, 0, 0],
	]

	// Time: Julian millennia since J2000.0.
	const t = (tdb1 - J2000 + tdb2) / DAYSPERJM

	const { masses, semiMajorAxis, meanLongitude, eccentricity, perihelionLongitude, inclination, ascendingNodeLongitude, semiMajorAxisArgument, semiMajorAxisCosine, semiMajorAxisSine, meanLongitudeArgument, meanLongitudeCosine, meanLongitudeSine } = PLAN94

	// Compute the mean elements.
	let da = semiMajorAxis[np][0] + (semiMajorAxis[np][1] + semiMajorAxis[np][2] * t) * t
	let dl = (3600 * meanLongitude[np][0] + (meanLongitude[np][1] + meanLongitude[np][2] * t) * t) * ASEC2RAD
	const de = eccentricity[np][0] + (eccentricity[np][1] + eccentricity[np][2] * t) * t
	const dp = eraAnpm((3600 * perihelionLongitude[np][0] + (perihelionLongitude[np][1] + perihelionLongitude[np][2] * t) * t) * ASEC2RAD)
	const di = (3600 * inclination[np][0] + (inclination[np][1] + inclination[np][2] * t) * t) * ASEC2RAD
	const dom = eraAnpm((3600 * ascendingNodeLongitude[np][0] + (ascendingNodeLongitude[np][1] + ascendingNodeLongitude[np][2] * t) * t) * ASEC2RAD)

	// Apply the trigonometric terms.
	const dmu = 0.3595362 * t

	const smaa = semiMajorAxisArgument[np]
	const smac = semiMajorAxisCosine[np]
	const mla = meanLongitudeArgument[np]
	const mlc = meanLongitudeCosine[np]

	for (let k = 0; k < 8; k++) {
		const arga = smaa[k] * dmu
		const argl = mla[k] * dmu
		da += (smac[k] * Math.cos(arga) + semiMajorAxisSine[np][k] * Math.sin(arga)) * 1e-7
		dl += (mlc[k] * Math.cos(argl) + meanLongitudeSine[np][k] * Math.sin(argl)) * 1e-7
	}

	const arga = smaa[8] * dmu
	da += t * (smac[8] * Math.cos(arga) + semiMajorAxisSine[np][8] * Math.sin(arga)) * 1e-7

	for (let k = 8; k < 10; k++) {
		const argl = mla[k] * dmu
		dl += t * (mlc[k] * Math.cos(argl) + meanLongitudeSine[np][k] * Math.sin(argl)) * 1e-7
	}

	dl %= TAU

	// Iterative solution of Kepler's equation to get eccentric anomaly.
	const am = dl - dp
	let ae = am + de * Math.sin(am)
	let dae = 1

	for (let k = 0; k < 10 && Math.abs(dae) > 1e-12; k++) {
		dae = (am - ae + de * Math.sin(ae)) / (1 - de * Math.cos(ae))
		ae += dae
	}

	// True anomaly.
	const ae2 = ae / 2
	const at = 2 * Math.atan2(Math.sqrt((1 + de) / (1 - de)) * Math.sin(ae2), Math.cos(ae2))

	// Distance (AU) and speed (radians per day).
	const r = da * (1 - de * Math.cos(ae))
	const v = gaussianConstant * Math.sqrt((1 + 1 / masses[np]) / (da * da * da))
	const si2 = Math.sin(di / 2)
	const xq = si2 * Math.cos(dom)
	const xp = si2 * Math.sin(dom)
	const tl = at + dp
	const xsw = Math.sin(tl)
	const xcw = Math.cos(tl)
	const xm2 = 2 * (xp * xcw - xq * xsw)
	const xf = da / Math.sqrt(1 - de * de)
	const ci2 = Math.cos(di / 2)
	const xms = (de * Math.sin(dp) + xsw) * xf
	const xmc = (de * Math.cos(dp) + xcw) * xf
	const xpxq2 = 2 * xp * xq

	// Position (J2000.0 ecliptic x,y,z in AU).
	let x = r * (xcw - xm2 * xp)
	let y = r * (xsw + xm2 * xq)
	let z = r * -xm2 * ci2

	// Rotate to equatorial.
	pv[0][0] = x
	pv[0][1] = y * cosineObliquity - z * sineObliquity
	pv[0][2] = y * sineObliquity + z * cosineObliquity

	// Velocity (J2000.0 ecliptic xdot,ydot,zdot in AU/day).
	x = v * ((-1 + 2 * xp * xp) * xms + xpxq2 * xmc)
	y = v * ((1 - 2 * xq * xq) * xmc - xpxq2 * xms)
	z = v * (2 * ci2 * (xp * xms + xq * xmc))

	// Rotate to equatorial.
	pv[1][0] = x
	pv[1][1] = y * cosineObliquity - z * sineObliquity
	pv[1][2] = y * sineObliquity + z * cosineObliquity

	return pv
}

function fillDayAndFraction(out: NumberArray, day: number, fraction: number) {
	out[0] = day
	out[1] = fraction
	return out
}

// Barycentric Coordinate Time, TCB, to Barycentric Dynamical Time, TDB.
export function eraTcbTdb(tcb1: number, tcb2: number, out?: NumberArray): NumberArray {
	const d = tcb1 - (MJD0 + MJD1977)
	const tdb2 = tcb2 + TDB0 / DAYSEC - (d + (tcb2 - TTMINUSTAI / DAYSEC)) * ELB
	if (out !== undefined) return fillDayAndFraction(out, tcb1, tdb2)
	return [tcb1, tdb2]
}

// Geocentric Coordinate Time, TCG, to Terrestrial Time, TT.
export function eraTcgTt(tcg1: number, tcg2: number, out?: NumberArray): NumberArray {
	const tt2 = tcg2 - (tcg1 - MJD0 + (tcg2 - (MJD1977 + TTMINUSTAI / DAYSEC))) * ELG
	if (out !== undefined) return fillDayAndFraction(out, tcg1, tt2)
	return [tcg1, tt2]
}

// Barycentric Dynamical Time, TDB, to Barycentric Coordinate Time, TCB.
export function eraTdbTcb(tdb1: number, tdb2: number, out?: NumberArray): NumberArray {
	const d = MJD0 + MJD1977 - tdb1
	const f = tdb2 - TDB0 / DAYSEC
	const tcb2 = f - (d - (f - TTMINUSTAI / DAYSEC)) * (ELB / (1 - ELB))
	if (out !== undefined) return fillDayAndFraction(out, tdb1, tcb2)
	return [tdb1, tcb2]
}

// Terrestrial Time, TT, to Geocentric Coordinate Time, TCG.
export function eraTtTcg(tt1: number, tt2: number, out?: NumberArray): NumberArray {
	const tcg2 = tt2 + (tt1 - MJD0 + (tt2 - (MJD1977 + TTMINUSTAI / DAYSEC))) * (ELG / (1 - ELG))
	if (out !== undefined) return fillDayAndFraction(out, tt1, tcg2)
	return [tt1, tcg2]
}

// Terrestrial Time, TT, to Universal Time, UT1.
export function eraTtUt1(tt1: number, tt2: number, dt: number, out?: NumberArray): NumberArray {
	const dtd = dt / DAYSEC
	if (out !== undefined) return fillDayAndFraction(out, tt1, tt2 - dtd)
	return [tt1, tt2 - dtd]
}

// International Atomic Time, TAI, to Universal Time, UT1.
export function eraTaiUt1(tai1: number, tai2: number, ut1MinusTai: number, out?: NumberArray): NumberArray {
	if (out !== undefined) return fillDayAndFraction(out, tai1, tai2 + ut1MinusTai / DAYSEC)
	return [tai1, tai2 + ut1MinusTai / DAYSEC]
}

// Universal Time, UT1, to International Atomic Time, TAI.
export function eraUt1Tai(ut11: number, ut12: number, ut1MinusTai: number, out?: NumberArray): NumberArray {
	if (out !== undefined) return fillDayAndFraction(out, ut11, ut12 - ut1MinusTai / DAYSEC)
	return [ut11, ut12 - ut1MinusTai / DAYSEC]
}

// Universal Time, UT1 to Terrestrial Time, TT.
export function eraUt1Tt(tt1: number, tt2: number, dt: number, out?: NumberArray): NumberArray {
	const dtd = dt / DAYSEC
	if (out !== undefined) return fillDayAndFraction(out, tt1, tt2 + dtd)
	return [tt1, tt2 + dtd]
}

// International Atomic Time, TAI, to Terrestrial Time, TT.
export function eraTaiTt(tai1: number, tai2: number, out?: NumberArray): NumberArray {
	if (out !== undefined) return fillDayAndFraction(out, tai1, tai2 + TTMINUSTAI / DAYSEC)
	return [tai1, tai2 + TTMINUSTAI / DAYSEC]
}

// Terrestrial Time, TT, to International Atomic Time, TAI.
export function eraTtTai(tt1: number, tt2: number, out?: NumberArray): NumberArray {
	if (out !== undefined) return fillDayAndFraction(out, tt1, tt2 - TTMINUSTAI / DAYSEC)
	return [tt1, tt2 - TTMINUSTAI / DAYSEC]
}

// Terrestrial Time, TT, to Barycentric Dynamical Time, TDB.
export function eraTtTdb(tt1: number, tt2: number, tdbMinusTt: number, out?: NumberArray): NumberArray {
	if (out !== undefined) return fillDayAndFraction(out, tt1, tt2 + tdbMinusTt / DAYSEC)
	return [tt1, tt2 + tdbMinusTt / DAYSEC]
}

// Barycentric Dynamical Time, TDB, to Terrestrial Time, TT.
export function eraTdbTt(tdb1: number, tdb2: number, tdbMinusTt: number, out?: NumberArray): NumberArray {
	if (out !== undefined) return fillDayAndFraction(out, tdb1, tdb2 - tdbMinusTt / DAYSEC)
	return [tdb1, tdb2 - tdbMinusTt / DAYSEC]
}

// International Atomic Time, TAI, to Coordinated Universal Time, UTC.
export function eraTaiUtc(tai1: number, tai2: number, out?: NumberArray): NumberArray {
	let u2 = tai2

	// Iterate(though in most cases just once is enough).
	for (let i = 0; i < 3; i++) {
		const [g1, g2] = eraUtcTai(tai1, u2)

		// Adjust guessed UTC.
		u2 += tai1 - g1
		u2 += tai2 - g2
	}

	if (out !== undefined) return fillDayAndFraction(out, tai1, u2)
	return [tai1, u2]
}

export function eraUtcTai(utc1: number, utc2: number, out?: NumberArray): NumberArray {
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

	if (out !== undefined) return fillDayAndFraction(out, u1, a2)
	return [u1, a2]
}

export function eraUtcUt1(utc1: number, utc2: number, dut1: number, out?: NumberArray): NumberArray {
	const cal = eraJdToCal(utc1, utc2)
	const dat = eraDat(cal[0], cal[1], cal[2], cal[3])

	// Form UT1-TAI
	const dta = dut1 - dat

	out = eraUtcTai(utc1, utc2, out)
	return eraTaiUt1(out[0], out[1], dta, out)
}

export function eraUt1Utc(ut11: number, ut12: number, dut1: number, out?: NumberArray): NumberArray {
	const u1 = Math.max(ut11, ut12)
	let u2 = Math.min(ut11, ut12)

	let duts = dut1

	// See if the UT1 can possibly be in a leap-second day.
	let d1 = u1
	let dats1 = 0

	const cal: [number, number, number, number] = [0, 0, 0, 0]

	for (let i = -1; i < 4; i++) {
		let d2 = u2 + i
		eraJdToCal(d1, d2, cal)
		const dats2 = eraDat(cal[0], cal[1], cal[2], 0)

		if (i === -1) dats1 = dats2

		const ddats = dats2 - dats1

		if (Math.abs(ddats) >= 0.5) {
			// Yes, leap second nearby: ensure UT1-UTC is "before" value.
			if (ddats * duts >= 0) duts -= ddats

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

	if (out !== undefined) return fillDayAndFraction(out, u1, u2)
	return [u1, u2]
}

export function eraJdToCal(dj1: number, dj2: number, out?: [number, number, number, number]): [number, number, number, number] {
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

	if (out !== undefined) {
		out[0] = iy
		out[1] = im
		out[2] = id
		out[3] = f
		return out
	}

	return [iy, im, id, f]
}

// Gregorian Calendar to Julian Date.
export function eraCalToJd(iy: number, im: number, id: number): number {
	const my = Math.trunc((im - 14) / 12)
	const iypmy = iy + my
	return Math.trunc(DAYSPERJY * (iypmy + 4800)) + Math.trunc((367 * (im - 2 - 12 * my)) / 12) - Math.trunc((3 * Math.trunc((iypmy + 4900) / 100)) / 4) + Math.trunc(id) - 2432076
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

// Equation of the equinoxes, IAU 1994 model.
export function eraEqeq94(tdb1: number, tdb2: number) {
	// Interval between fundamental epoch J2000.0 and given date (JC).
	const t = (tdb1 - J2000 + tdb2) / DAYSPERJC

	// Longitude of the mean ascending node of the lunar orbit on the ecliptic, measured from the mean equinox of date.
	const om = eraAnpm(ASEC2RAD * (450160.28 + (-482890.539 + (7.455 + 0.008 * t) * t) * t) + ((-5 * t) % 1) * TAU)

	// Nutation components and mean obliquity.
	const [dpsi] = eraNut80(tdb1, tdb2)
	const eps0 = eraObl80(tdb1, tdb2)

	// Equation of the equinoxes.
	return dpsi * Math.cos(eps0) + ASEC2RAD * (0.00264 * Math.sin(om) + 0.000063 * Math.sin(om + om))
}

// Greenwich apparent sidereal time (consistent with IAU 1982/94 resolutions).
export function eraGst94(ut11: number, ut12: number) {
	const gmst82 = eraGmst82(ut11, ut12)
	const eqeq94 = eraEqeq94(ut11, ut12)
	return normalizeAngle(gmst82 + eqeq94)
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

// Universal Time to Greenwich mean sidereal time (IAU 1982 model).
export function eraGmst82(ut11: number, ut12: number): Angle {
	// TT Julian centuries since J2000.0.
	const t = (ut11 - J2000 + ut12) / DAYSPERJC
	// Fractional part of JD(UT1), in seconds
	const f = ((ut11 % 1) + (ut12 % 1)) * DAYSEC

	return normalizeAngle(secondsOfTime(24110.54841 - DAYSEC / 2 + (8640184.812866 + (0.093104 + -6.2e-6 * t) * t) * t + f))
}

// Greenwich mean sidereal time (model consistent with IAU 2000 resolutions).
export function eraGmst00(ut11: number, ut12: number, tt1: number, tt2: number): Angle {
	// TT Julian centuries since J2000.0.
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	return normalizeAngle(eraEra00(ut11, ut12) + arcsec(0.014506 + (4612.15739966 + (1.39667721 + (-0.00009344 + 0.00001882 * t) * t) * t) * t))
}

// Equation of the equinoxes complementary terms, compatible with IAU 2000 resolutions.
export function eraEect00(date1: number, date2: number): Angle {
	// Interval between fundamental epoch J2000.0 and current date (JC).
	const t = (date1 - J2000 + date2) / DAYSPERJC
	// Fundamental arguments from IERS Conventions 2003.
	const fa = [eraFal03(t), eraFalp03(t), eraFaf03(t), eraFad03(t), eraFaom03(t), eraFave03(t), eraFae03(t), eraFapa03(t)]
	const s = [0, 0]

	for (let k = 0; k < IAU2000_EECT.length; k++) {
		for (let i = IAU2000_EECT[k].length - 1; i >= 0; i--) {
			const [nfa, sine, cosine] = IAU2000_EECT[k][i]
			let a = 0
			for (let j = 0; j < 8; j++) a += nfa[j] * fa[j]
			s[k] += sine * Math.sin(a) + cosine * Math.cos(a)
		}
	}

	return arcsec(s[0] + s[1] * t)
}

// Equation of the equinoxes, IAU 2000, using the supplied mean obliquity and nutation in longitude.
export function eraEe00(date1: number, date2: number, epsa: Angle, dpsi: Angle): Angle {
	return dpsi * Math.cos(epsa) + eraEect00(date1, date2)
}

// Equation of the equinoxes, IAU 2000A model.
export function eraEe00a(date1: number, date2: number): Angle {
	const [, depspr] = eraPr00(date1, date2)
	const epsa = eraObl80(date1, date2) + depspr
	const [dpsi] = eraNut00a(date1, date2)
	return eraEe00(date1, date2, epsa, dpsi)
}

// Equation of the equinoxes, IAU 2000B abridged model.
export function eraEe00b(date1: number, date2: number): Angle {
	const [, depspr] = eraPr00(date1, date2)
	const epsa = eraObl80(date1, date2) + depspr
	const [dpsi] = eraNut00b(date1, date2)
	return eraEe00(date1, date2, epsa, dpsi)
}

// Equation of the equinoxes using IAU 2006 precession and IAU 2000A nutation.
export function eraEe06a(date1: number, date2: number): Angle {
	return eraAnpm(eraGst06a(0, 0, date1, date2) - eraGmst06(0, 0, date1, date2))
}

// Equation of the origins using IAU 2006 precession and IAU 2000A nutation.
export function eraEo06a(date1: number, date2: number): Angle {
	const rnpb = eraPnm06a(date1, date2)
	const [x, y] = eraBpn2xy(rnpb)
	return eraEors(rnpb, eraS06(date1, date2, x, y))
}

// Greenwich apparent sidereal time, IAU 2000A model, in the range 0 to 2pi radians.
export function eraGst00a(ut11: number, ut12: number, tt1: number, tt2: number): Angle {
	return normalizeAngle(eraGmst00(ut11, ut12, tt1, tt2) + eraEe00a(tt1, tt2))
}

// Greenwich apparent sidereal time, IAU 2000B abridged model, in the range 0 to 2pi radians.
export function eraGst00b(ut11: number, ut12: number): Angle {
	return normalizeAngle(eraGmst00(ut11, ut12, ut11, ut12) + eraEe00b(ut11, ut12))
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
	return Math.abs(p) > DBL_EPSILON || Math.abs(q) > DBL_EPSILON ? s - Math.atan2(q, p) : s
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

	// Polynomial coefficients.
	const w = [94e-6, 3808.65e-6, -122.68e-6, -72574.11e-6, 27.98e-6, 15.62e-6]

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

// The CIO locator s, positioning the Celestial Intermediate Origin on
// the equator of the Celestial Intermediate Pole, given the CIP's X,Y
// coordinates. Compatible with IAU 2000A precession-nutation.
export function eraS00(tt1: number, tt2: number, x: Angle, y: Angle): Angle {
	// Interval between fundamental epoch J2000.0 and current date (JC).
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	// Fundamental arguments from IERS Conventions 2003.
	const fa = [eraFal03(t), eraFalp03(t), eraFaf03(t), eraFad03(t), eraFaom03(t), eraFave03(t), eraFae03(t), eraFapa03(t)]

	// Polynomial coefficients and periodic terms for s + XY/2.
	const w = [94e-6, 3808.35e-6, -119.94e-6, -72574.09e-6, 27.7e-6, 15.61e-6]

	for (let k = 0; k < IAU2000_S.length; k++) {
		for (let i = IAU2000_S[k].length - 1; i >= 0; i--) {
			const [nfa, s, c] = IAU2000_S[k][i]
			let a = 0
			for (let j = 0; j < 8; j++) a += nfa[j] * fa[j]
			w[k] += s * Math.sin(a) + c * Math.cos(a)
		}
	}

	// Form s, removing the polynomial XY/2 term.
	return arcsec(w[0] + (w[1] + (w[2] + (w[3] + (w[4] + w[5] * t) * t) * t) * t) * t) - (x * y) / 2
}

// CIO locator s using the IAU 2000A precession-nutation model.
export function eraS00a(date1: number, date2: number): Angle {
	const [x, y] = eraBpn2xy(eraPnm00a(date1, date2))
	return eraS00(date1, date2, x, y)
}

// CIO locator s using the IAU 2000B abridged precession-nutation model.
export function eraS00b(date1: number, date2: number): Angle {
	const [x, y] = eraBpn2xy(eraPnm00b(date1, date2))
	return eraS00(date1, date2, x, y)
}

// CIO locator s using IAU 2006 precession and IAU 2000A nutation.
export function eraS06a(date1: number, date2: number): Angle {
	const [x, y] = eraBpn2xy(eraPnm06a(date1, date2))
	return eraS06(date1, date2, x, y)
}

// CIP X,Y coordinates and CIO locator s using the IAU 2000A precession-nutation model.
export function eraXys00a(date1: number, date2: number): [Angle, Angle, Angle] {
	const [x, y] = eraBpn2xy(eraPnm00a(date1, date2))
	return [x, y, eraS00(date1, date2, x, y)]
}

// CIP X,Y coordinates and CIO locator s using the IAU 2000B abridged precession-nutation model.
export function eraXys00b(date1: number, date2: number): [Angle, Angle, Angle] {
	const [x, y] = eraBpn2xy(eraPnm00b(date1, date2))
	return [x, y, eraS00(date1, date2, x, y)]
}

// CIP X,Y coordinates and CIO locator s using IAU 2006 precession and IAU 2000A nutation.
export function eraXys06a(date1: number, date2: number): [Angle, Angle, Angle] {
	const [x, y] = eraBpn2xy(eraPnm06a(date1, date2))
	return [x, y, eraS06(date1, date2, x, y)]
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

// Mean obliquity of the ecliptic, IAU 1980 model.
export function eraObl80(tt1: number, tt2: number): Angle {
	// Interval between fundamental epoch J2000.0 and given date (JC).
	const t = (tt1 - J2000 + tt2) / DAYSPERJC
	// Mean obliquity of date.
	return ASEC2RAD * (84381.448 + (-46.815 + (-0.00059 + 0.001813 * t) * t) * t)
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

// Fundamental argument, IERS Conventions (2003): mean longitude of Neptune.
export function eraFane03(t: number): Angle {
	return (5.311886287 + 3.8133035638 * t) % TAU
}

// Nutation, IAU 1980 model.
export function eraNut80(tt1: number, tt2: number): [Angle, Angle] {
	// Interval between fundamental epoch J2000.0 and given date (JC).
	const t = (tt1 - J2000 + tt2) / DAYSPERJC

	// Fundamental arguments

	// Mean longitude of Moon minus mean longitude of Moon's perigee.
	const el = eraAnpm(ASEC2RAD * (485866.733 + (715922.633 + (31.31 + 0.064 * t) * t) * t) + ((1325 * t) % 1) * TAU)

	// Mean longitude of Sun minus mean longitude of Sun's perigee.
	const elp = eraAnpm(ASEC2RAD * (1287099.804 + (1292581.224 + (-0.577 - 0.012 * t) * t) * t) + ((99 * t) % 1) * TAU)

	// Mean longitude of Moon minus mean longitude of Moon's node.
	const f = eraAnpm(ASEC2RAD * (335778.877 + (295263.137 + (-13.257 + 0.011 * t) * t) * t) + ((1342 * t) % 1) * TAU)

	// Mean elongation of Moon from Sun.
	const d = eraAnpm(ASEC2RAD * (1072261.307 + (1105601.328 + (-6.891 + 0.019 * t) * t) * t) + ((1236 * t) % 1) * TAU)

	// Longitude of the mean ascending node of the lunar orbit on the ecliptic, measured from the mean equinox of date.
	const om = eraAnpm(ASEC2RAD * (450160.28 + (-482890.539 + (7.455 + 0.008 * t) * t) * t) + ((-5 * t) % 1) * TAU)

	// Nutation series

	let dp = 0
	let de = 0

	// Sum the nutation terms, ending with the biggest.
	for (let j = NUT80_X.length - 1; j >= 0; j--) {
		const x = NUT80_X[j]

		// Form argument for current term.
		const arg = x[0] * el + x[1] * elp + x[2] * f + x[3] * d + x[4] * om

		// Accumulate current nutation term.
		const s = x[5] + x[6] * t
		const c = x[7] + x[8] * t
		if (s !== 0) dp += s * Math.sin(arg)
		if (c !== 0) de += c * Math.cos(arg)
	}

	// Units of 0.1 milliarcsecond to radians.
	return [dp * (ASEC2RAD / 10000), de * (ASEC2RAD / 10000)]
}

// Forms the matrix of nutation for a given date, IAU 1980 model.
export function eraNutm80(tt1: number, tt2: number) {
	// Nutation components and mean obliquity.
	const [dpsi, deps] = eraNut80(tt1, tt2)
	const epsa = eraObl80(tt1, tt2)

	// Build the rotation matrix.
	return eraNumat(epsa, dpsi, deps)
}

// Forms the matrix of nutation.
export function eraNumat(epsa: Angle, dpsi: Angle, deps: Angle, m?: MutMat3): MutMat3 {
	return matRotX(-(epsa + deps), matRotZ(-dpsi, matRotX(epsa, m)))
}

// Nutation matrix, IAU 2000A model.
export function eraNum00a(date1: number, date2: number): MutMat3 {
	return eraPn00a(date1, date2)[6]
}

// Nutation matrix, IAU 2000B abridged model.
export function eraNum00b(date1: number, date2: number): MutMat3 {
	return eraPn00b(date1, date2)[6]
}

// Nutation matrix using IAU 2006 precession and IAU 2000A nutation.
export function eraNum06a(date1: number, date2: number): MutMat3 {
	const [dpsi, deps] = eraNut06a(date1, date2)
	return eraNumat(eraObl06(date1, date2), dpsi, deps)
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
	for (let i = NUT00A_LS.length - 1; i >= 0; i--) {
		const [nl, nlp, nf, nd, nom, sp, spt, cp, ce, cet, se] = NUT00A_LS[i]
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

	for (let i = NUT00A_PL.length - 1; i >= 0; i--) {
		const [nl, nf, nd, nom, nme, nve, nea, nma, nju, nsa, nur, nne, npa, sp, cp, se, ce] = NUT00A_PL[i]
		const arg = (nl * al + nf * af + nd * ad + nom * aom + nme * alme + nve * alve + nea * alea + nma * alma + nju * alju + nsa * alsa + nur * alur + nne * alne + npa * apa) % TAU

		const sarg = Math.sin(arg)
		const carg = Math.cos(arg)

		dp += sp * sarg + cp * carg
		de += se * sarg + ce * carg
	}

	// Units of 0.1 microarcsecond to radians.
	return [(dpls + dp) * (ASEC2RAD / 10000000), (dels + de) * (ASEC2RAD / 10000000)]
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

	for (let i = NUT00B_LS.length - 1; i >= 0; i--) {
		const [nl, nlp, nf, nd, nom, ps, pst, pc, ec, ect, es] = NUT00B_LS[i]
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

// Equinox-based IAU 2006 precession angles, in radians.
export function eraP06e(date1: number, date2: number): readonly [Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle, Angle] {
	const t = (date1 - J2000 + date2) / DAYSPERJC
	const eps0 = 84381.406 * ASEC2RAD
	const psia = arcsec((5038.481507 + (-1.0790069 + (-0.00114045 + (0.000132851 - 0.0000000951 * t) * t) * t) * t) * t)
	const oma = eps0 + arcsec((-0.025754 + (0.0512623 + (-0.00772503 + (-0.000000467 + 0.0000003337 * t) * t) * t) * t) * t)
	const bpa = arcsec((4.199094 + (0.1939873 + (-0.00022466 + (-0.000000912 + 0.000000012 * t) * t) * t) * t) * t)
	const bqa = arcsec((-46.811015 + (0.0510283 + (0.00052413 + (-0.000000646 - 0.0000000172 * t) * t) * t) * t) * t)
	const pia = arcsec((46.998973 + (-0.0334926 + (-0.00012559 + (0.000000113 - 0.0000000022 * t) * t) * t) * t) * t)
	const bpia = arcsec(629546.7936 + (-867.95758 + (0.157992 + (-0.0005371 + (-0.00004797 + 0.000000072 * t) * t) * t) * t) * t)
	const epsa = eraObl06(date1, date2)
	const chia = arcsec((10.556403 + (-2.3814292 + (-0.00121197 + (0.000170663 - 0.000000056 * t) * t) * t) * t) * t)
	const za = arcsec(-2.650545 + (2306.077181 + (1.0927348 + (0.01826837 + (-0.000028596 - 0.0000002904 * t) * t) * t) * t) * t)
	const zetaa = arcsec(2.650545 + (2306.083227 + (0.2988499 + (0.01801828 + (-0.000005971 - 0.0000003173 * t) * t) * t) * t) * t)
	const thetaa = arcsec((2004.191903 + (-0.4294934 + (-0.04182264 + (-0.000007089 - 0.0000001274 * t) * t) * t) * t) * t)
	const pa = arcsec((5028.796195 + (1.1054348 + (0.00007964 + (-0.000023857 - 0.0000000383 * t) * t) * t) * t) * t)
	const gam = arcsec((10.556403 + (0.4932044 + (-0.00031238 + (-0.000002788 + 0.000000026 * t) * t) * t) * t) * t)
	const phi = eps0 + arcsec((-46.811015 + (0.0511269 + (0.00053289 + (-0.00000044 - 0.0000000176 * t) * t) * t) * t) * t)
	const psi = arcsec((5038.481507 + (1.5584176 + (-0.00018522 + (-0.000026452 - 0.0000000148 * t) * t) * t) * t) * t)
	return [eps0, psia, oma, bpa, bqa, pia, bpia, epsa, chia, za, zetaa, thetaa, pa, gam, phi, psi]
}

// IAU 2006 precession-nutation matrices for supplied nutation components.
export function eraPn06(date1: number, date2: number, dpsi: Angle, deps: Angle): readonly [Angle, MutMat3, MutMat3, MutMat3, MutMat3, MutMat3] {
	const [gamb0, phib0, psib0, eps0] = eraPfw06(MJD0, J2000 - MJD0)
	const rb = eraFw2m(gamb0, phib0, psib0, eps0)
	const [gamb, phib, psib, epsa] = eraPfw06(date1, date2)
	const rbp = eraFw2m(gamb, phib, psib, epsa)
	const rp = matMulTranspose(rbp, rb)
	const rbpn = eraFw2m(gamb, phib, psib + dpsi, epsa + deps)
	const rn = matMulTranspose(rbpn, rbp)
	return [epsa, rb, rp, rbp, rn, rbpn]
}

// IAU 2006 precession and IAU 2000A nutation matrices.
export function eraPn06a(date1: number, date2: number): readonly [Angle, Angle, Angle, MutMat3, MutMat3, MutMat3, MutMat3, MutMat3] {
	const [dpsi, deps] = eraNut06a(date1, date2)
	return [dpsi, deps, ...eraPn06(date1, date2, dpsi, deps)]
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

// Transform geocentric coordinates to geodetic for a reference ellipsoid of specified form.
export function eraGc2Gde(radius: Distance, flattening: number, x: Distance, y: Distance, z: Distance): [Angle, Angle, Distance] {
	// oxlint-disable-next-line oxc/erasing-op
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
	// const [gamb, phib, psib, epsa] = eraPfw06(MJD0, MJD2000)
	// const rb = eraFw2m(gamb, phib, psib, epsa)
	// const rb = eraFw2m(-2.5660218513765524e-7, 0.4090926336600278, -2.0253091528350866e-7, 0.4090926006005829)
	const rb = [0.9999999999999941, -7.078368960971556e-8, 8.056213977613186e-8, 7.078368694637676e-8, 0.9999999999999969, 3.3059437354321375e-8, -8.056214211620057e-8, -3.305943169218395e-8, 0.9999999999999962] as const

	// PxB matrix (temporary).
	const rbpw = eraPmat06(tt1, tt2)

	// P matrix.
	// const rp = matTranspose(rb)
	// matMul(rbpw, rp, rp)
	const rp = matMulTranspose(rbpw, rb)

	return [rb, rp, rbpw] as const
}

// Frame bias and precession, IAU 2000.
export function eraBp00(date1: number, date2: number): readonly [MutMat3, MutMat3, MutMat3] {
	// J2000.0 obliquity and interval from J2000.0, in Julian centuries.
	const eps0 = arcsec(84381.448)
	const t = (date1 - J2000 + date2) / DAYSPERJC

	// Frame bias and precession angles, including IAU 2000 corrections.
	const [dpsibi, depsbi, dra0] = eraBi00()
	const psia77 = (5038.7784 + (-1.07259 - 0.001147 * t) * t) * t * ASEC2RAD
	const oma77 = eps0 + (0.05127 - 0.007726 * t) * t * t * ASEC2RAD
	const chia = (10.5526 + (-2.38064 - 0.001125 * t) * t) * t * ASEC2RAD
	const [dpsipr, depspr] = eraPr00(date1, date2)
	const psia = psia77 + dpsipr
	const oma = oma77 + depspr

	// Frame bias matrix: GCRS to J2000.0.
	const rb = matRotX(-depsbi, matRotY(dpsibi * Math.sin(eps0), matRotZ(dra0)))

	// Precession matrix: J2000.0 to mean of date.
	const rp = matRotZ(chia, matRotX(-oma, matRotZ(-psia, matRotX(eps0))))

	// Bias-precession matrix: GCRS to mean of date.
	return [rb, rp, matMul(rp, rb)]
}

// IAU 2000 precession matrix from J2000.0 to the given date.
export function eraPmat00(date1: number, date2: number): MutMat3 {
	// Obtain the bias-precession matrix.
	return eraBp00(date1, date2)[2]
}

// IAU 2000 precession-nutation matrices for supplied nutation components.
export function eraPn00(date1: number, date2: number, dpsi: Angle, deps: Angle): readonly [Angle, MutMat3, MutMat3, MutMat3, MutMat3, MutMat3] {
	// IAU 2000 precession-rate corrections and mean obliquity.
	const [, depspr] = eraPr00(date1, date2)
	const epsa = eraObl80(date1, date2) + depspr

	// Frame bias, precession, and nutation matrices.
	const [rb, rp, rbp] = eraBp00(date1, date2)
	const rn = eraNumat(epsa, dpsi, deps)
	return [epsa, rb, rp, rbp, rn, matMul(rn, rbp)]
}

// IAU 2000A precession-nutation matrices.
export function eraPn00a(date1: number, date2: number): readonly [Angle, Angle, Angle, MutMat3, MutMat3, MutMat3, MutMat3, MutMat3] {
	const [dpsi, deps] = eraNut00a(date1, date2)
	return [dpsi, deps, ...eraPn00(date1, date2, dpsi, deps)]
}

// IAU 2000B precession-nutation matrices.
export function eraPn00b(date1: number, date2: number): readonly [Angle, Angle, Angle, MutMat3, MutMat3, MutMat3, MutMat3, MutMat3] {
	const [dpsi, deps] = eraNut00b(date1, date2)
	return [dpsi, deps, ...eraPn00(date1, date2, dpsi, deps)]
}

// IAU 2000A bias-precession-nutation matrix.
export function eraPnm00a(date1: number, date2: number): MutMat3 {
	return eraPn00a(date1, date2)[7]
}

// IAU 2000B bias-precession-nutation matrix.
export function eraPnm00b(date1: number, date2: number): MutMat3 {
	return eraPn00b(date1, date2)[7]
}

// IAU 2000A celestial-to-intermediate matrix.
export function eraC2i00a(date1: number, date2: number): MutMat3 {
	return eraC2ibpn(date1, date2, eraPnm00a(date1, date2))
}

// IAU 2000B celestial-to-intermediate matrix.
export function eraC2i00b(date1: number, date2: number): MutMat3 {
	return eraC2ibpn(date1, date2, eraPnm00b(date1, date2))
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
	if (d < DBL_EPSILON || w > 1) return false
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

	if (Math.abs(ret[2]) < DBL_EPSILON) return false

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

	if (rtrue < DBL_EPSILON) {
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

	return vecNormalizeMut(p)
}

// Apply aberration to transform natural direction into proper direction.
export function eraAb(pnat: Vec3, v: Vec3, s: number, bm1: number, o?: MutVec3) {
	const pdv = vecDot(pnat, v)
	const w1 = 1 + pdv / (1 + bm1)
	const w2 = SCHWARZSCHILD_RADIUS_OF_THE_SUN / s
	let r2 = 0

	const p = o ?? [0, 0, 0]

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
export function eraC2t06a(tt1: number, tt2: number, ut11: number, ut12: number, xp: Angle, yp: Angle, sp: Angle) {
	// Form the celestial-to-intermediate matrix for this TT.
	const rc2i = eraC2i06a(tt1, tt2)

	// Predict the Earth rotation angle for this UT1.
	const era = eraEra00(ut11, ut12)

	// Estimate s'.
	if (sp === 0) sp = eraSp00(tt1, tt2)

	// Form the polar motion matrix.
	const rpom = eraPom00(xp, yp, sp)

	// Combine to form the celestial-to-terrestrial matrix.
	return eraC2tcio(rc2i, era, rpom, rc2i)
}

// Form the IAU 2000A celestial-to-terrestrial matrix from TT, UT1, and polar motion.
export function eraC2t00a(tta: number, ttb: number, uta: number, utb: number, xp: Angle, yp: Angle): MutMat3 {
	// Form the celestial-to-intermediate matrix for this TT.
	const rc2i = eraC2i00a(tta, ttb)

	// Predict the Earth rotation angle and estimate s'.
	const era = eraEra00(uta, utb)
	const sp = eraSp00(tta, ttb)

	// Form polar motion and combine the transformations.
	return eraC2tcio(rc2i, era, eraPom00(xp, yp, sp), rc2i)
}

// Form the IAU 2000B celestial-to-terrestrial matrix from TT, UT1, and polar motion.
export function eraC2t00b(tta: number, ttb: number, uta: number, utb: number, xp: Angle, yp: Angle): MutMat3 {
	// Form the celestial-to-intermediate matrix for this TT.
	const rc2i = eraC2i00b(tta, ttb)

	// Predict the Earth rotation angle; IAU 2000B neglects s'.
	const era = eraEra00(uta, utb)

	// Form polar motion and combine the transformations.
	return eraC2tcio(rc2i, era, eraPom00(xp, yp, 0), rc2i)
}

// Form the IAU 2000 celestial-to-terrestrial matrix from TT, UT1, CIP X,Y, and polar motion.
export function eraC2txy(tta: number, ttb: number, uta: number, utb: number, x: Angle, y: Angle, xp: Angle, yp: Angle): MutMat3 {
	const rc2i = eraC2ixy(tta, ttb, x, y)
	const era = eraEra00(uta, utb)
	return eraC2tcio(rc2i, era, eraPom00(xp, yp, eraSp00(tta, ttb)), rc2i)
}

// Form the IAU 2000 celestial-to-terrestrial matrix from TT, UT1, supplied nutation, and polar motion.
export function eraC2tpe(tta: number, ttb: number, uta: number, utb: number, dpsi: Angle, deps: Angle, xp: Angle, yp: Angle): MutMat3 {
	const [epsa, , , , , rbpn] = eraPn00(tta, ttb, dpsi, deps)
	const gmst = eraGmst00(uta, utb, tta, ttb)
	const ee = eraEe00(tta, ttb, epsa, dpsi)
	return eraC2teqx(rbpn, gmst + ee, eraPom00(xp, yp, eraSp00(tta, ttb)))
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

	// Form the matrix.
	return matRotZ(-(e + s), matRotY(d, matRotZ(e, matIdentity(o))))
}

// Form the celestial-to-intermediate matrix from CIP X,Y coordinates.
export function eraC2ixy(date1: number, date2: number, x: Angle, y: Angle, o?: MutMat3): MutMat3 {
	// Compute s and then the matrix.
	return eraC2ixys(x, y, eraS00(date1, date2, x, y), o)
}

// Form the celestial-to-intermediate matrix from a bias-precession-nutation matrix.
export function eraC2ibpn(date1: number, date2: number, rbpn: Mat3, o?: MutMat3): MutMat3 {
	// Extract the X,Y coordinates and form the IAU 2000 matrix.
	const [x, y] = eraBpn2xy(rbpn)
	return eraC2ixy(date1, date2, x, y, o)
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
	astrom.eo = eraEors(r, s)

	return astrom
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

const ZERO_PV = [
	[0, 0, 0],
	[0, 0, 0],
] as const

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
	astrom ??= eraAstrom()

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

	astrom.bm1 = Math.sqrt(1 - v2)

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
	// s[0] = normalize(s[0])
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
	s[0] = normalizeAngle(s[0])
	return s
}

// Quick ICRS to CIRS transformation, given precomputed star-
// independent astrometry parameters, and assuming zero parallax and
// proper motion.
export function eraAtciqz(rc: Angle, dc: Angle, astrom: EraAstrom) {
	// BCRS coordinate direction (unit vector).
	const pco = eraS2c(rc, dc)

	// Light deflection by the Sun, giving BCRS natural direction.
	const pnat = eraLdSun(pco, astrom.eh, astrom.em)

	// Aberration, giving GCRS proper direction.
	const ppr = eraAb(pnat, astrom.v, astrom.em, astrom.bm1)

	// Bias-precession-nutation, giving CIRS proper direction.
	const pi = matMulVec(astrom.bpn, ppr, ppr)

	// CIRS RA,Dec.
	const [w, di] = eraC2s(...pi)
	const ri = normalizeAngle(w)
	return [ri, di] as const
}

// For a terrestrial observer, prepare star-independent astrometry
// parameters for transformations between ICRS and observed
// coordinates. The caller supplies the Earth ephemeris, the Earth
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
	astrom ??= eraAstrom()

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
	astrom.diurab = 0

	// CIO based BPN matrix.
	eraC2ixys(x, y, s, r)

	// Observer's geocentric position and velocity (AU, AU/day, CIRS).
	const pvc = eraPvtob(elong, phi, hm, xp, yp, sp, theta, radius, flattening)

	// Rotate into GCRS.
	matTransposeMulVec(r, pvc[0], pvc[0])
	matTransposeMulVec(r, pvc[1], pvc[1])

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
	const p = matTransposeMulVec(rpm, xyzm, xyzm)
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
	astrom.eo = eraEors(r, s)

	return astrom
}

// Determine the constants A and B in the atmospheric refraction model dZ = A tan Z + B tan^3 Z.
// Z is the "observed" zenith distance (i.e. affected by refraction)
// and dZ is what to add to Z to give the "topocentric" (i.e. in vacuo) zenith distance.
// Pressure in hPa (millibar), temperature in deg C, relative humidity in range (0-1) and wavelengths in microns.
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
// coordinates. The caller supplies UTC, site coordinates, ambient air
// conditions and observing wavelength.
export function eraApio13(tt1: number, tt2: number, ut11: number, ut12: number, elong: Angle, phi: Angle, hm: Distance, xp: Angle, yp: Angle, sp: Angle, phpa: Pressure, tc: Temperature, rh: number, wl: number, astrom?: EraAstrom) {
	// TIO locator s'.
	if (sp === 0) sp = eraSp00(tt1, tt2)

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
// coordinates. The caller supplies the Earth orientation information
// and the refraction constants as well as the site coordinates.
export function eraApio(sp: Angle, theta: Angle, elong: Angle, phi: Angle, hm: Distance, xp: Angle, yp: Angle, refa: number, refb: number, astrom?: EraAstrom) {
	astrom ??= eraAstrom()

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
// Returns observed azimuth, zenith distance, hour angle, right ascension (CIO-based) and declination.
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
	const azobs = xaet !== 0 || yaet !== 0 ? Math.atan2(yaet, -xaet) : 0

	// ----------
	// Refraction
	// ----------

	// Cosine and sine of altitude, with precautions.
	const r = Math.max(1e-6, Math.sqrt(xaet * xaet + yaet * yaet))
	z = Math.max(0.05, zaet)

	// A*tan(z)+B*tan^3(z) model, with Newton-Raphson correction.
	const tz = r / z
	const w = astrom.refb * tz * tz
	const del = ((astrom.refa + w) * tz) / (1 + (astrom.refa + 3 * w) / (z * z))

	// Apply the change, giving observed vector.
	const cosdel = 1 - (del * del) / 2
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
	const aob = normalizeAngle(azobs)
	const zob = zdobs
	const hob = -hmobs
	const dob = dcobs
	const rob = normalizeAngle(raobs)

	// NOTE: rob and dob are swapped in relation to the original erfaAtioq
	return [aob, zob, hob, rob, dob] as const
}

const FRAME_BIAS_IAU2000 = [-0.041775 * ASEC2RAD, -0.0068192 * ASEC2RAD, -0.0146 * ASEC2RAD] as const

// Frame bias components of IAU 2000 precession-nutation models;  part
// of the Mathews-Herring-Buffett (MHB2000) nutation series, with
// additions. Returns longitude and obliquity corrections,
// and the ICRS RA of the J2000.0 mean equinox.
export function eraBi00() {
	return FRAME_BIAS_IAU2000
}

// Quick observed place to CIRS, given the star-independent astrometry parameters.
// Use of this function is appropriate when efficiency is important and
// where many star positions are all to be transformed for one date.
// The star-independent astrometry parameters can be obtained by
// calling eraApio[13] or eraApco[13].
// ob1: observed Az, HA or RA (radians; Az is N=0,E=90)
// ob2: observed ZD or Dec (radians)
export function eraAtoiq(type: 'R' | 'H' | 'A', ob1: Angle, ob2: Angle, astrom: EraAstrom) {
	const { sphi, cphi, eral, diurab, refa, refb, xpl, ypl } = astrom

	let xaeo = 0
	let yaeo = 0
	let zaeo = 0

	// If Az,ZD, convert to Cartesian (S=0,E=90).
	if (type === 'A') {
		const ce = Math.sin(ob2)
		xaeo = -Math.cos(ob1) * ce
		yaeo = Math.sin(ob1) * ce
		zaeo = Math.cos(ob2)
	} else {
		// If RA,Dec, convert to HA,Dec.
		if (type === 'R') ob1 = eral - ob1

		// To Cartesian -HA,Dec.
		const [xmhdo, ymhdo, zmhdo] = eraS2c(-ob1, ob2)

		// To Cartesian Az,El (S=0,E=90).
		xaeo = sphi * xmhdo - cphi * zmhdo
		yaeo = ymhdo
		zaeo = cphi * xmhdo + sphi * zmhdo
	}

	// Azimuth (S=0,E=90).
	const az = xaeo !== 0 || yaeo !== 0 ? Math.atan2(yaeo, xaeo) : 0

	// Sine of observed ZD, and observed ZD.
	const sz = Math.sqrt(xaeo * xaeo + yaeo * yaeo)
	const zdo = Math.atan2(sz, zaeo)

	// Refraction

	// Fast algorithm using two constant model.
	const tz = sz / Math.max(zaeo, 0.05)
	const dref = (refa + refb * tz * tz) * tz
	const zdt = zdo + dref

	// To Cartesian Az,ZD.
	const ce = Math.sin(zdt)
	const xaet = Math.cos(az) * ce
	const yaet = Math.sin(az) * ce
	const zaet = Math.cos(zdt)

	// Cartesian Az,ZD to Cartesian -HA,Dec.
	const xmhda = sphi * xaet + cphi * zaet
	const ymhda = yaet
	const zmhda = -cphi * xaet + sphi * zaet

	// Diurnal aberration.
	const f = 1 + diurab * ymhda
	const xhd = f * xmhda
	const yhd = f * (ymhda - diurab)
	const zhd = f * zmhda

	// Polar motion.
	const sx = Math.sin(xpl)
	const cx = Math.cos(xpl)
	const sy = Math.sin(ypl)
	const cy = Math.cos(ypl)
	const v0 = cx * xhd + sx * sy * yhd - sx * cy * zhd
	const v1 = cy * yhd + sy * zhd
	const v2 = sx * xhd - cx * sy * yhd + cx * cy * zhd

	// To spherical -HA,Dec.
	const [hma, di] = eraC2s(v0, v1, v2)

	// Right ascension.
	const ri = normalizeAngle(eral + hma)

	return [ri, di] as const
}

// Quick CIRS RA,Dec to ICRS astrometric place, given the star-
// independent astrometry parameters.
export function eraAticq(ri: Angle, di: Angle, astrom: EraAstrom) {
	// CIRS RA,Dec to Cartesian.
	const pi = eraS2c(ri, di)

	// Bias-precession-nutation, giving GCRS proper direction.
	const ppr = matTransposeMulVec(astrom.bpn, pi)

	// Aberration, giving GCRS natural direction.
	const d: MutVec3 = [0, 0, 0]
	const before: MutVec3 = [0, 0, 0]
	const after: MutVec3 = [0, 0, 0]
	const pnat: MutVec3 = [0, 0, 0]
	const pco: MutVec3 = [0, 0, 0]

	for (let j = 0; j < 2; j++) {
		let r2 = 0

		for (let i = 0; i < 3; i++) {
			const w = ppr[i] - d[i]
			before[i] = w
			r2 += w * w
		}

		vecDivScalar(before, Math.sqrt(r2), before)

		eraAb(before, astrom.v, astrom.em, astrom.bm1, after)
		r2 = 0

		for (let i = 0; i < 3; i++) {
			d[i] = after[i] - before[i]
			const w = ppr[i] - d[i]
			pnat[i] = w
			r2 += w * w
		}

		vecDivScalar(pnat, Math.sqrt(r2), pnat)
	}

	// Light deflection by the Sun, giving BCRS coordinate direction.
	d.fill(0)

	for (let j = 0; j < 5; j++) {
		let r2 = 0

		for (let i = 0; i < 3; i++) {
			const w = pnat[i] - d[i]
			before[i] = w
			r2 += w * w
		}

		vecDivScalar(before, Math.sqrt(r2), before)

		eraLdSun(before, astrom.eh, astrom.em, after)
		r2 = 0

		for (let i = 0; i < 3; i++) {
			d[i] = after[i] - before[i]
			const w = pnat[i] - d[i]
			pco[i] = w
			r2 += w * w
		}

		vecDivScalar(pco, Math.sqrt(r2), pco)
	}

	// ICRS astrometric RA,Dec.
	const [w, dc] = eraC2s(...pco)
	const rc = normalizeAngle(w)
	return [rc, dc] as const
}

// Transform ICRS star data, epoch J2000.0, to CIRS.
export function eraAtci13(tdb1: number, tdb2: number, rc: Angle, dc: Angle, pr: Angle, pd: Angle, px: Distance, rv: Velocity, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], astrom?: EraAstrom) {
	astrom = eraApci13(tdb1, tdb2, ebpv, ehp, astrom)
	return [...eraAtciq(rc, dc, pr, pd, px, rv, astrom), astrom] as const
}

// Transform an ICRS catalog entry into CIRS, accounting for light
// deflection by the supplied solar-system bodies. The astrometry
// parameters and body positions must describe the observation epoch.
export function eraAtciqn(rc: Angle, dc: Angle, pr: Angle, pd: Angle, px: Distance, rv: Velocity, astrom: EraAstrom, bodies: LdBody[]) {
	// Proper motion and parallax, giving BCRS coordinate direction.
	const pco = eraPmpx(rc, dc, pr, pd, px, rv, astrom.pmt, astrom.eb)

	// Light deflection, giving BCRS natural direction.
	const pnat = eraLdn(bodies, astrom.eb, pco)

	// Aberration, giving GCRS proper direction.
	const ppr = eraAb(pnat, astrom.v, astrom.em, astrom.bm1)

	// Bias-precession-nutation, giving CIRS proper direction.
	const pi = matMulVec(astrom.bpn, ppr)
	const [w, di] = eraC2s(...pi)

	return [normalizeAngle(w), di] as const
}

// ICRS RA,Dec to observed place.
export function eraAtco13(
	tt1: number,
	tt2: number,
	ut11: number,
	ut12: number,
	rc: Angle,
	dc: Angle,
	pr: Angle,
	pd: Angle,
	px: Distance,
	rv: Velocity,
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
	// Star-independent astrometry parameters.
	astrom = eraApco13(tt1, tt2, ut11, ut12, elong, phi, hm, xp, yp, sp, phpa, tc, rh, wl, ebpv, ehp, radius, flattening, astrom)
	// Transform ICRS to CIRS.
	const [ri, di] = eraAtciq(rc, dc, pr, pd, px, rv, astrom)
	// Transform CIRS to observed.
	return [...eraAtioq(ri, di, astrom), astrom] as const
}

// Observed place at a groundbased site to ICRS astrometric RA,Dec.
// The caller supplies UTC, site coordinates, ambient air conditions
// and observing wavelength.
// ob1: observed Az, HA or RA (radians; Az is N=0,E=90)
// ob2: observed ZD or Dec (radians)
export function eraAtoc13(
	type: 'R' | 'H' | 'A',
	ob1: Angle,
	ob2: Angle,
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
	// Star-independent astrometry parameters.
	astrom = eraApco13(tt1, tt2, ut11, ut12, elong, phi, hm, xp, yp, sp, phpa, tc, rh, wl, ebpv, ehp, radius, flattening, astrom)

	// Transform observed to CIRS.
	const [ri, di] = eraAtoiq(type, ob1, ob2, astrom)

	// Transform CIRS to ICRS.
	return eraAticq(ri, di, astrom)
}

// Transform CIRS right ascension and declination into observed
// azimuth, zenith distance, hour angle, declination and CIO-based
// right ascension. TT, UT1 and the TIO locator are supplied by the caller.
export function eraAtio13(ri: Angle, di: Angle, tt1: number, tt2: number, ut11: number, ut12: number, elong: Angle, phi: Angle, hm: Distance, xp: Angle, yp: Angle, sp: Angle, phpa: Pressure, tc: Temperature, rh: number, wl: number, astrom?: EraAstrom) {
	astrom = eraApio13(tt1, tt2, ut11, ut12, elong, phi, hm, xp, yp, sp, phpa, tc, rh, wl, astrom)
	return eraAtioq(ri, di, astrom)
}

// Transform an observed place into CIRS right ascension and declination.
// TT, UT1 and the TIO locator are supplied by the caller.
export function eraAtoi13(type: 'R' | 'H' | 'A', ob1: Angle, ob2: Angle, tt1: number, tt2: number, ut11: number, ut12: number, elong: Angle, phi: Angle, hm: Distance, xp: Angle, yp: Angle, sp: Angle, phpa: Pressure, tc: Temperature, rh: number, wl: number, astrom?: EraAstrom) {
	astrom = eraApio13(tt1, tt2, ut11, ut12, elong, phi, hm, xp, yp, sp, phpa, tc, rh, wl, astrom)
	return eraAtoiq(type, ob1, ob2, astrom)
}

// Transform CIRS coordinates into ICRS astrometric coordinates using
// the supplied light-deflecting bodies and precomputed astrometry.
export function eraAticqn(ri: Angle, di: Angle, astrom: EraAstrom, bodies: LdBody[]) {
	// CIRS RA,Dec to Cartesian and undo bias-precession-nutation.
	const pi = eraS2c(ri, di)
	const ppr = matTransposeMulVec(astrom.bpn, pi)

	// Undo aberration by fixed-point iteration.
	const d: MutVec3 = [0, 0, 0]
	const before: MutVec3 = [0, 0, 0]
	const after: MutVec3 = [0, 0, 0]
	const pnat: MutVec3 = [0, 0, 0]
	const pco: MutVec3 = [0, 0, 0]

	for (let j = 0; j < 2; j++) {
		let r2 = 0

		for (let i = 0; i < 3; i++) {
			const w = ppr[i] - d[i]
			before[i] = w
			r2 += w * w
		}

		vecDivScalar(before, Math.sqrt(r2), before)
		eraAb(before, astrom.v, astrom.em, astrom.bm1, after)
		r2 = 0

		for (let i = 0; i < 3; i++) {
			d[i] = after[i] - before[i]
			const w = ppr[i] - d[i]
			pnat[i] = w
			r2 += w * w
		}

		vecDivScalar(pnat, Math.sqrt(r2), pnat)
	}

	// Undo the light deflection by fixed-point iteration.
	d.fill(0)

	for (let j = 0; j < 5; j++) {
		let r2 = 0

		for (let i = 0; i < 3; i++) {
			const w = pnat[i] - d[i]
			before[i] = w
			r2 += w * w
		}

		vecDivScalar(before, Math.sqrt(r2), before)
		const deflected = eraLdn(bodies, astrom.eb, before)
		r2 = 0

		for (let i = 0; i < 3; i++) {
			d[i] = deflected[i] - before[i]
			const w = pnat[i] - d[i]
			pco[i] = w
			r2 += w * w
		}

		vecDivScalar(pco, Math.sqrt(r2), pco)
	}

	const [w, dc] = eraC2s(...pco)
	return [normalizeAngle(w), dc] as const
}

// Transform CIRS right ascension and declination into ICRS astrometric
// coordinates, preparing geocentric astrometry from caller-supplied
// Earth ephemerides.
export function eraAtic13(ri: Angle, di: Angle, tdb1: number, tdb2: number, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], astrom?: EraAstrom) {
	astrom = eraApci13(tdb1, tdb2, ebpv, ehp, astrom)
	return [...eraAticq(ri, di, astrom), astrom] as const
}

// Transform an ICRS catalog entry into ICRS astrometric coordinates,
// preparing geocentric astrometry from caller-supplied Earth ephemerides.
export function eraAtcc13(rc: Angle, dc: Angle, pr: Angle, pd: Angle, px: Distance, rv: Velocity, tdb1: number, tdb2: number, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], astrom?: EraAstrom) {
	astrom = eraApci13(tdb1, tdb2, ebpv, ehp, astrom)
	return eraAtccq(rc, dc, pr, pd, px, rv, astrom)
}

// Horizon to equatorial coordinates: transform azimuth and altitude to
// local hour angle and declination. Angles are radians; azimuth is N=0,E=90.
export function eraAe2hd(az: Angle, el: Angle, phi: Angle): [Angle, Angle] {
	// Useful trig functions.
	const sa = Math.sin(az)
	const ca = Math.cos(az)
	const se = Math.sin(el)
	const ce = Math.cos(el)
	const sp = Math.sin(phi)
	const cp = Math.cos(phi)

	// HA,Dec unit vector.
	const x = -ca * ce * sp + se * cp
	const y = -sa * ce
	const z = ca * ce * cp + se * sp

	// To spherical.
	const r = Math.sqrt(x * x + y * y)
	return [r !== 0 ? Math.atan2(y, x) : 0, Math.atan2(z, r)]
}

// Equatorial to horizon coordinates: transform local hour angle and
// declination to azimuth and altitude. Angles are radians; azimuth is N=0,E=90.
export function eraHd2ae(ha: Angle, dec: Angle, phi: Angle): [Angle, Angle] {
	// Useful trig functions.
	const sh = Math.sin(ha)
	const ch = Math.cos(ha)
	const sd = Math.sin(dec)
	const cd = Math.cos(dec)
	const sp = Math.sin(phi)
	const cp = Math.cos(phi)

	// Az,Alt unit vector.
	const x = -ch * cd * sp + sd * cp
	const y = -sh * cd
	const z = ch * cd * cp + sd * sp

	// To spherical.
	const r = Math.sqrt(x * x + y * y)
	const a = r !== 0 ? Math.atan2(y, x) : 0
	return [a < 0 ? a + TAU : a, Math.atan2(z, r)]
}

// Parallactic angle for hour angle, declination, and site latitude, in radians.
export function eraHd2pa(ha: Angle, dec: Angle, phi: Angle): Angle {
	const cosPhi = Math.cos(phi)
	const sinQ = cosPhi * Math.sin(ha)
	const cosQ = Math.sin(phi) * Math.cos(dec) - cosPhi * Math.sin(dec) * Math.cos(ha)
	return sinQ !== 0 || cosQ !== 0 ? Math.atan2(sinQ, cosQ) : 0
}

// Extract the Celestial Intermediate Pole X,Y coordinates from a
// celestial-to-true bias-precession-nutation matrix.
export function eraBpn2xy(rbpn: Mat3): [Angle, Angle] {
	// Extract the X,Y coordinates.
	return [rbpn[6], rbpn[7]]
}

// CIP X,Y given Fukushima-Williams bias-precession-nutation angles.
export function eraFw2xy(gamb: Angle, phib: Angle, psi: Angle, eps: Angle): [Angle, Angle] {
	// Form NxPxB matrix.
	const r = eraFw2m(gamb, phib, psi, eps)

	// Extract CIP X,Y.
	return eraBpn2xy(r)
}

// ICRS to Galactic rotation matrix.
const ICRS_TO_GALACTIC_MATRIX = [
	-0.054875560416215368492398900454, -0.873437090234885048760383168409, -0.483835015548713226831774175116, 0.494109427875583673525222371358, -0.444829629960011178146614061616, 0.746982244497218890527388004556, -0.86766614901900470118161653457, -0.198076373431201528180486091412, 0.455983776175066922272100478348,
] as const

// Transform Galactic longitude and latitude to ICRS right ascension and declination.
export function eraG2icrs(dl: Angle, db: Angle): [Angle, Angle] {
	// Spherical to Cartesian, then Galactic to ICRS.
	const v2 = matTransposeMulVec(ICRS_TO_GALACTIC_MATRIX, eraS2c(dl, db))

	// Cartesian to spherical and express conventional ranges.
	const [dr, dd] = eraC2s(v2[0], v2[1], v2[2])
	return [normalizeAngle(dr), eraAnpm(dd)]
}

// Transform ICRS right ascension and declination to Galactic longitude and latitude.
export function eraIcrs2g(dr: Angle, dd: Angle): [Angle, Angle] {
	// Spherical to Cartesian, then ICRS to Galactic.
	const v2 = matMulVec(ICRS_TO_GALACTIC_MATRIX, eraS2c(dr, dd))

	// Cartesian to spherical and express conventional ranges.
	const [dl, db] = eraC2s(v2[0], v2[1], v2[2])
	return [normalizeAngle(dl), eraAnpm(db)]
}

// In the tangent-plane projection, solve for the spherical coordinates of a star.
export function eraTpsts(xi: Angle, eta: Angle, a0: Angle, b0: Angle): [Angle, Angle] {
	// Functions of the tangent point.
	const sb0 = Math.sin(b0)
	const cb0 = Math.cos(b0)
	const d = cb0 - eta * sb0

	// Star spherical coordinates.
	return [normalizeAngle(Math.atan2(xi, d) + a0), Math.atan2(sb0 + eta * cb0, Math.sqrt(xi * xi + d * d))]
}

// In the tangent-plane projection, solve for a star's direction cosines.
export function eraTpstv(xi: Angle, eta: Angle, v0: Vec3, o?: MutVec3): MutVec3 {
	// Tangent point.
	let x = v0[0]
	const y = v0[1]
	const z = v0[2]

	// Deal with polar case.
	let r = Math.sqrt(x * x + y * y)
	if (r === 0) {
		r = 1e-20
		x = r
	}

	// Star vector length to tangent plane.
	const f = Math.sqrt(1 + xi * xi + eta * eta)

	// Apply the transformation and normalize.
	const ox = (x - (xi * y + eta * x * z) / r) / f
	const oy = (y + (xi * x - eta * y * z) / r) / f
	const oz = (z + eta * r) / f

	if (o) return vecFill(o, ox, oy, oz)
	return [ox, oy, oz]
}

// In the tangent-plane projection, solve for the possible tangent points
// from a star's spherical coordinates and rectangular tangent-plane coordinates.
export function eraTpors(xi: Angle, eta: Angle, a: Angle, b: Angle): [number, Angle?, Angle?, Angle?, Angle?] {
	// Functions of the star coordinates and tangent-plane position.
	const xi2 = xi * xi
	const r = Math.sqrt(1 + xi2 + eta * eta)
	const sb = Math.sin(b)
	const cb = Math.cos(b)
	const rsb = r * sb
	const rcb = r * cb
	const w2 = rcb * rcb - xi2
	if (w2 < 0) return [0]

	// First tangent point.
	let w = Math.sqrt(w2)
	let s = rsb - eta * w
	let c = rsb * eta + w
	if (xi === 0 && w === 0) w = 1
	const a01 = normalizeAngle(a - Math.atan2(xi, w))
	const b01 = Math.atan2(s, c)

	// Second tangent point.
	w = -w
	s = rsb - eta * w
	c = rsb * eta + w
	const a02 = normalizeAngle(a - Math.atan2(xi, w))
	const b02 = Math.atan2(s, c)
	return [Math.abs(rsb) < 1 ? 1 : 2, a01, b01, a02, b02]
}

// In the tangent-plane projection, solve for the possible tangent-point
// direction cosines from a star vector and rectangular coordinates.
export function eraTporv(xi: Angle, eta: Angle, v: Vec3): [number, MutVec3?, MutVec3?] {
	// Star vector and tangent-plane position.
	const x = v[0]
	const y = v[1]
	const z = v[2]
	const rxy2 = x * x + y * y
	const xi2 = xi * xi
	const eta2p1 = eta * eta + 1
	const r = Math.sqrt(xi2 + eta2p1)
	const rsb = r * z
	const rcb = r * Math.sqrt(rxy2)
	const w2 = rcb * rcb - xi2
	if (w2 <= 0) return [0]

	// First tangent point.
	let w = Math.sqrt(w2)
	let c = (rsb * eta + w) / (eta2p1 * Math.sqrt(rxy2 * (w2 + xi2)))
	const v01: MutVec3 = [c * (x * w + y * xi), c * (y * w - x * xi), (rsb - eta * w) / eta2p1]

	// Second tangent point.
	w = -w
	c = (rsb * eta + w) / (eta2p1 * Math.sqrt(rxy2 * (w2 + xi2)))
	const v02: MutVec3 = [c * (x * w + y * xi), c * (y * w - x * xi), (rsb - eta * w) / eta2p1]
	return [Math.abs(rsb) < 1 ? 1 : 2, v01, v02]
}

// In the tangent-plane projection, solve for a star's rectangular coordinates.
export function eraTpxes(a: Angle, b: Angle, a0: Angle, b0: Angle): [number, Angle, Angle] {
	// Functions of the spherical coordinates.
	const sb0 = Math.sin(b0)
	const sb = Math.sin(b)
	const cb0 = Math.cos(b0)
	const cb = Math.cos(b)
	const da = a - a0
	const sda = Math.sin(da)
	const cda = Math.cos(da)

	// Reciprocal of star vector length to tangent plane.
	let d = sb * sb0 + cb * cb0 * cda

	// Check for error cases.
	const status = d > 1e-6 ? 0 : d >= 0 ? ((d = 1e-6), 1) : d > -1e-6 ? ((d = -1e-6), 2) : 3

	// Return tangent plane coordinates, even in dubious cases.
	return [status, (cb * sda) / d, (sb * cb0 - cb * sb0 * cda) / d]
}

// In the tangent-plane projection, solve for a star's rectangular coordinates from vectors.
export function eraTpxev(v: Vec3, v0: Vec3): [number, Angle, Angle] {
	// Star and tangent point.
	const x = v[0]
	const y = v[1]
	const z = v[2]
	let x0 = v0[0]
	const y0 = v0[1]
	const z0 = v0[2]

	// Deal with polar case.
	const r2 = x0 * x0 + y0 * y0
	let r = Math.sqrt(r2)
	if (r === 0) {
		r = 1e-20
		x0 = r
	}

	// Reciprocal of star vector length to tangent plane.
	const w = x * x0 + y * y0
	let d = w + z * z0

	// Check for error cases.
	const status = d > 1e-6 ? 0 : d >= 0 ? ((d = 1e-6), 1) : d > -1e-6 ? ((d = -1e-6), 2) : 3

	// Return tangent plane coordinates, even in dubious cases.
	d *= r
	return [status, (y * x0 - x * y0) / d, (z * r2 - z0 * w) / d]
}

// Precession-rate corrections with respect to the IAU 1976/80 models.
export function eraPr00(date1: number, date2: number): [Angle, Angle] {
	// Interval between J2000.0 and the given date, in Julian centuries.
	const t = (date1 - J2000 + date2) / DAYSPERJC

	// Precession and obliquity corrections, in radians.
	return [-0.29965 * ASEC2RAD * t, -0.02524 * ASEC2RAD * t]
}

// IAU 1976 precession Euler angles between two Julian Dates.
export function eraPrec76(date01: number, date02: number, date11: number, date12: number): [Angle, Angle, Angle] {
	// Intervals from J2000.0 to the start date and across the transformation.
	const t0 = (date01 - J2000 + date02) / DAYSPERJC
	const t = (date11 - date01 + date12 - date02) / DAYSPERJC
	const tas2r = t * ASEC2RAD
	const w = 2306.2181 + (1.39656 - 0.000139 * t0) * t0

	// Euler angles.
	const zeta = (w + (0.30188 - 0.000344 * t0 + 0.017998 * t) * t) * tas2r
	const z = (w + (1.09468 + 0.000066 * t0 + 0.018203 * t) * t) * tas2r
	const theta = (2004.3109 + (-0.8533 - 0.000217 * t0) * t0 + (-0.42665 - 0.000217 * t0 - 0.041833 * t) * t) * tas2r
	return [zeta, z, theta]
}

// IAU 1976 precession matrix from J2000.0 to the given date.
export function eraPmat76(date1: number, date2: number, o?: MutMat3): MutMat3 {
	// Precession Euler angles, J2000.0 to specified date.
	const [zeta, z, theta] = eraPrec76(J2000, 0, date1, date2)

	// Form the rotation matrix.
	return matRotZ(-z, matRotY(theta, matRotZ(-zeta, matIdentity(o))))
}

// Precession-nutation matrix using IAU 1976 precession and IAU 1980 nutation.
export function eraPnm80(date1: number, date2: number): MutMat3 {
	const rmatp = eraPmat76(date1, date2)
	return matMul(eraNutm80(date1, date2), rmatp, rmatp)
}

// IAU 2006 Fukushima-Williams bias-precession angles.
export function eraPb06(date1: number, date2: number): [Angle, Angle, Angle] {
	// Precession matrix via Fukushima-Williams angles.
	const r = eraPmat06(date1, date2)

	// Solve for z, choosing the +/- pi alternative.
	let y = r[5]
	let x = -r[2]
	if (x < 0) {
		y = -y
		x = -x
	}

	const bz = x !== 0 || y !== 0 ? -Math.atan2(y, x) : 0

	// Derotate it out of the matrix.
	matRotZ(bz, r)

	// Solve for the remaining two angles.
	y = r[2]
	x = r[8]
	const btheta = x !== 0 || y !== 0 ? -Math.atan2(y, x) : 0
	y = -r[3]
	x = r[4]
	const bzeta = x !== 0 || y !== 0 ? -Math.atan2(y, x) : 0
	return [bzeta, bz, btheta]
}
