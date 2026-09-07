import { ASEC2RAD, DAYSPERJC, DEG2RAD, J2000, TAU } from '../../core/constants'
import { type Angle, deg, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { greenwichApparentSiderealTime, type Time, Timescale, time, timeNormalize, toJulianDay, tt, ut1 } from '../time/time'
import { lunation } from './moon'

// Solar geometry and almanac helpers from Meeus' "Astronomical Algorithms": Sun parallax and
// semi-diameter, Carrington rotation number, astronomical season instants, and the solar-eclipse
// circumstances (Saros number, nearest eclipse, magnitude/type classification). Distances are AU,
// angles radians, and eclipse-derived times are tagged TT (dynamical) per Meeus.

// The four astronomical seasons, used to select the season-start polynomial.
export type Season = 'spring' | 'summer' | 'autumn' | 'winter'

// Classification of a solar eclipse by shadow geometry.
export type SolarEclipseType = 'total' | 'partial' | 'annular' | 'hybrid'

// Circumstances of a solar eclipse computed from Meeus' eclipse method.
export interface SolarEclipse {
	// Meeus lunation index k of the eclipse new moon.
	lunation: number
	// Instant of maximal eclipse, in TT.
	maximalTime: Time
	// Greatest-eclipse magnitude (Moon/Sun apparent-diameter ratio for central eclipses,
	// partial coverage fraction otherwise); dimensionless.
	magnitude: number
	// Least distance from the axis of the Moon's shadow to the center of the Earth,
	// in units of equatorial radius of the Earth.
	gamma: number
	// Radius of the Moon's umbral cone in the fundamental plane,
	// in units of equatorial radius of the Earth.
	u: number
	p: number // penumbral
	// Geometric type of the eclipse.
	type: SolarEclipseType
	central: boolean
}

// Sentinel TT instant used to initialize SolarEclipse.maximalTime before it is computed.
const DEFAULT_MINIMAL_SOLAR_ECLIPSE_TIME = time(0, 0, Timescale.TT)
// |gamma| below this (Earth radii) means the shadow axis reaches Earth: a central eclipse.
const SOLAR_ECLIPSE_CENTRAL_LIMIT = 0.9972
// |gamma| above this (plus u) means no eclipse touches the Earth surface at all.
const SOLAR_ECLIPSE_SURFACE_LIMIT = 1.5433
// Distance-independent l1-l2 term (~2 lunar radii) used as the magnitude denominator base.
const SOLAR_ECLIPSE_PARTIAL_DENOMINATOR = 0.5461
// Umbral-radius threshold (Earth radii) separating hybrid from annular near gamma=0.
const SOLAR_ECLIPSE_HYBRID_LIMIT = 0.00464
// Sine of the Moon's mean horizontal parallax (mean Earth-Moon distance ~60.27 equatorial radii). Lifts
// the geocentric Moon/Sun diameter ratio to the topocentric magnitude an observer at greatest eclipse
// sees, standing up to one Earth radius nearer the Moon.
const MEAN_LUNAR_PARALLAX = 0.01659

// Computes the parallax of the Sun at a given distance
export function sunParallax(distance: Distance) {
	return (8.794143 * ASEC2RAD) / distance
}

// Computes the semi-diameter of the Sun at a given distance
export function sunSemidiameter(distance: Distance) {
	return (959.63 * ASEC2RAD) / distance
}

// Computes the Carrington rotation number for a given time
export function carringtonRotationNumber(time: Time) {
	return Math.round((time.day - 2398140.10155 + time.fraction) / 27.2752316 - 0.5)
}

// Computes the equation of time at a given instant, in radians: the hour-angle
// difference apparent solar time minus mean solar time, i.e. the offset between a
// sundial and a clock. It is the apparent Sun's Greenwich hour angle (GAST minus
// the apparent right ascension) minus the mean Sun's Greenwich hour angle
// (UT1 fraction of a day expressed as an angle, since the Julian Date fraction is
// zero at noon).
//
// The caller supplies `apparentSunRightAscension`, the apparent geocentric right
// ascension of the Sun in radians. It MUST be referred to the true equator and
// equinox of date (the same reference as GAST), not to ICRS/J2000: precess and
// nutate the Sun direction to the epoch of date first (e.g. equatorialFromJ2000),
// otherwise the result carries a spurious precession term of ~50 arcsec per year
// (~1.4 minutes of time by 2026). Keeping the RA as an argument leaves this
// independent of the ephemeris model used.
//
// The result is normalized to [-PI, PI]; multiply by RAD2DEG * 4 for minutes of
// time (1 hour = 15 deg). It stays within roughly +-16 minutes over a year.
export function equationOfTime(time: Time, apparentSunRightAscension: Angle): Angle {
	return normalizePI(greenwichApparentSiderealTime(time) - apparentSunRightAscension - ut1(time).fraction * TAU)
}

// Computes instant of beginning of astronomical season for given year [1000...3000]
export function season(year: number, name: Season) {
	let jd0 = 0

	const Y = (year - 2000) / 1000

	switch (name) {
		case 'spring':
			jd0 = 2451623.80984 + (((-0.00057 * Y - 0.00411) * Y + 0.05169) * Y + 365242.37404) * Y
			break
		case 'summer':
			jd0 = 2451716.56767 + (((-0.0003 * Y + 0.00888) * Y + 0.00325) * Y + 365241.62603) * Y
			break
		case 'autumn':
			jd0 = 2451810.21715 + (((0.00078 * Y + 0.00337) * Y - 0.11575) * Y + 365242.01767) * Y
			break
		case 'winter':
			jd0 = 2451900.05952 + (((0.00032 * Y - 0.00823) * Y - 0.06223) * Y + 365242.74049) * Y
			break
	}

	const T = (jd0 - J2000) / DAYSPERJC
	const w = 35999.373 * T - 2.47
	const deltaLambda = 1 + 0.0334 * Math.cos(deg(w)) + 0.0007 * Math.cos(deg(2 * w))

	const S =
		485 * Math.cos(deg(324.96 + 1934.136 * T)) +
		203 * Math.cos(deg(337.23 + 32964.467 * T)) +
		199 * Math.cos(deg(342.08 + 20.186 * T)) +
		182 * Math.cos(deg(27.85 + 445267.112 * T)) +
		156 * Math.cos(deg(73.14 + 45036.886 * T)) +
		136 * Math.cos(deg(171.52 + 22518.443 * T)) +
		77 * Math.cos(deg(222.54 + 65928.934 * T)) +
		74 * Math.cos(deg(296.72 + 3034.906 * T)) +
		70 * Math.cos(deg(243.58 + 9037.513 * T)) +
		58 * Math.cos(deg(119.81 + 33718.147 * T)) +
		52 * Math.cos(deg(297.17 + 150.678 * T)) +
		50 * Math.cos(deg(21.02 + 2281.226 * T)) +
		45 * Math.cos(deg(247.54 + 29929.562 * T)) +
		44 * Math.cos(deg(325.15 + 31555.956 * T)) +
		29 * Math.cos(deg(60.93 + 4443.417 * T)) +
		18 * Math.cos(deg(155.12 + 67555.328 * T)) +
		17 * Math.cos(deg(288.79 + 4562.452 * T)) +
		16 * Math.cos(deg(198.04 + 62894.029 * T)) +
		14 * Math.cos(deg(199.76 + 31436.921 * T)) +
		12 * Math.cos(deg(95.39 + 14577.848 * T)) +
		12 * Math.cos(deg(287.11 + 31931.756 * T)) +
		12 * Math.cos(deg(320.81 + 34777.259 * T)) +
		9 * Math.cos(deg(227.73 + 1222.114 * T)) +
		8 * Math.cos(deg(15.45 + 16859.074 * T))

	// Meeus' method yields the JDE (dynamical time), so tag the instant as TT; otherwise a
	// later utc()/tt() conversion would mishandle it by ~ΔT.
	return time(jd0, (0.00001 * S) / deltaLambda, Timescale.TT)
}

// Computes the saros series number for the solar eclipse.
export function solarSaros(time: Time) {
	const nd = lunation(time, 'MEEUS') + 105
	const ns = 136 + 38 * nd
	const nx = -61 * nd
	const nc = Math.floor(nx / 358 + 0.5 - nd / (12 * 358 * 358))
	const s = ns + nc * 223 - 1
	let saros = (s % 223) + 1
	if (s < 0) saros -= 223
	if (saros < -223) saros += 223
	return saros
}

// Computes the nearest (previous or next) solar eclipse for a given time
export function nearestSolarEclipse(time: Time, next: boolean): Readonly<SolarEclipse> {
	const t = tt(time)
	const jd = toJulianDay(t)
	let k = lunation(t, 'MEEUS') + (next ? 0 : 1)

	const eclipse: SolarEclipse = {
		lunation: k,
		maximalTime: DEFAULT_MINIMAL_SOLAR_ECLIPSE_TIME,
		magnitude: 0,
		gamma: 0,
		u: 0,
		p: 0,
		type: 'total',
		central: true,
	}

	let found = false

	while (!found) {
		const T = k / 1236.85
		const T2 = T * T
		const T3 = T2 * T
		const T4 = T3 * T

		// Moon's argument of latitude (mean distance of the Moon from its ascending node)
		const F = deg(160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4)

		found = Math.abs(Math.sin(F)) <= 0.36

		if (found) {
			// Sun's mean anomaly
			const SM = deg(2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3)

			// Moon's mean anomaly
			const MM = deg(201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4)

			// Mean longitude of ascending node
			const omega = deg(124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3)

			// Multiplier related to the eccentricity of the Earth orbit
			const E = 1 - 0.002516 * T - 0.0000074 * T2

			const sinSM = Math.sin(SM)
			const cosSM = Math.cos(SM)
			const sin2SM = Math.sin(2 * SM)
			const cos2SM = Math.cos(2 * SM)
			const sinMM = Math.sin(MM)
			const cosMM = Math.cos(MM)
			const sin2MM = Math.sin(2 * MM)
			const cos2MM = Math.cos(2 * MM)
			const sinOmega = Math.sin(omega)
			const mmPlusSm = MM + SM
			const mmMinusSm = MM - SM
			const sinMMPlusSM = Math.sin(mmPlusSm)
			const cosMMPlusSM = Math.cos(mmPlusSm)
			const sinMMMinusSM = Math.sin(mmMinusSm)
			const cosMMMinusSM = Math.cos(mmMinusSm)
			const F1 = F - 0.02665 * DEG2RAD * sinOmega
			const A1 = deg(299.77 + 0.107408 * k - 0.009173 * T2)
			const sinF1 = Math.sin(F1)
			const cosF1 = Math.cos(F1)
			const sin2F1 = Math.sin(2 * F1)
			const sinMMMinus2F1 = Math.sin(MM - 2 * F1)
			const sinMMPlus2F1 = Math.sin(MM + 2 * F1)
			const sin2MMPlusSM = Math.sin(2 * MM + SM)
			const sin3MM = Math.sin(3 * MM)
			const sinSMPlus2F1 = Math.sin(SM + 2 * F1)
			const sinSMMinus2F1 = Math.sin(SM - 2 * F1)
			const sin2MMMinusSM = Math.sin(2 * MM - SM)

			const P = 0.207 * E * sinSM + 0.0024 * E * sin2SM - 0.0392 * sinMM + 0.0116 * sin2MM - 0.0073 * E * sinMMPlusSM + 0.0067 * E * sinMMMinusSM + 0.0118 * sin2F1
			const Q = 5.2207 - 0.0048 * E * cosSM + 0.002 * E * cos2SM - 0.3299 * cosMM - 0.006 * E * cosMMPlusSM + 0.0041 * E * cosMMMinusSM
			const W = Math.abs(cosF1)
			const gamma = (P * cosF1 + Q * sinF1) * (1 - 0.0048 * W)
			const u = 0.0059 + 0.0046 * E * cosSM - 0.0182 * cosMM + 0.0004 * cos2MM - 0.0005 * cosMMPlusSM
			const absG = Math.abs(gamma)

			// no eclipse visible from the Earth surface
			if (absG > SOLAR_ECLIPSE_SURFACE_LIMIT + u) {
				found = false
				if (next) k++
				else k--
				continue
			}

			const timeOfGreatestEclipseDay = 2451550 + 29 * k
			const timeOfGreatestEclipseFraction = 0.530588861 * k + 0.09766 + 0.00015437 * T - 0.00000015 * T2 + 0.00000000073 * T3
			const timeOfGreatestEclipseCorrection =
				-0.4075 * sinMM +
				0.1721 * E * sinSM +
				0.0161 * sin2MM -
				0.0097 * sin2F1 +
				0.0073 * E * sinMMMinusSM -
				0.005 * E * sinMMPlusSM -
				0.0023 * sinMMMinus2F1 +
				0.0021 * E * sin2SM +
				0.0012 * sinMMPlus2F1 +
				0.0006 * E * sin2MMPlusSM -
				0.0004 * sin3MM -
				0.0003 * E * sinSMPlus2F1 +
				0.0003 * Math.sin(A1) -
				0.0002 * E * sinSMMinus2F1 -
				0.0002 * E * sin2MMMinusSM -
				0.0002 * sinOmega

			const fraction = timeOfGreatestEclipseFraction + timeOfGreatestEclipseCorrection

			if (timeOfGreatestEclipseDay + fraction > jd !== next) {
				found = false
				if (next) k++
				else k--
				continue
			}

			eclipse.u = u
			eclipse.p = u + 0.5461
			eclipse.gamma = gamma
			eclipse.maximalTime = timeNormalize(timeOfGreatestEclipseDay, fraction, 0, Timescale.TT)
			eclipse.lunation = k

			// Rare polar non-central annular/total eclipses still occur when the umbral or antumbral cone grazes Earth.
			if (absG >= SOLAR_ECLIPSE_CENTRAL_LIMIT) {
				eclipse.central = false
				eclipse.magnitude = (SOLAR_ECLIPSE_SURFACE_LIMIT + u - absG) / (SOLAR_ECLIPSE_PARTIAL_DENOMINATOR + 2 * u)
				eclipse.type = absG < SOLAR_ECLIPSE_CENTRAL_LIMIT + Math.abs(u) ? (u < 0 ? 'total' : 'annular') : 'partial'
			}
			// Central eclipse: the shadow axis reaches Earth, so the greatest-eclipse magnitude is the Moon/Sun
			// apparent-diameter ratio, not the partial fraction of formula 54.2 (Meeus leaves it undefined here).
			// Geocentrically that ratio is (l1 - l2)/(l1 + l2); since l1 - l2 ~ 2*k_moon ~ the partial denominator
			// (distance-independent, as the lunar radius and parallax scale together) and l2 = u, it reduces to
			// the form below. The observer at greatest eclipse stands ~sqrt(1 - gamma^2) Earth radii nearer the
			// Moon, scaling the geocentric ratio up to the topocentric magnitude that is reported for eclipses.
			else {
				const diameterRatio = SOLAR_ECLIPSE_PARTIAL_DENOMINATOR / (SOLAR_ECLIPSE_PARTIAL_DENOMINATOR + 2 * u)
				eclipse.magnitude = diameterRatio / (1 - Math.sqrt(1 - gamma * gamma) * MEAN_LUNAR_PARALLAX)

				if (u < 0) {
					eclipse.type = 'total'
				} else if (u > 0.0047) {
					eclipse.type = 'annular'
				} else if (u < SOLAR_ECLIPSE_HYBRID_LIMIT * Math.sqrt(1 - gamma * gamma)) {
					eclipse.type = 'hybrid'
				} else {
					eclipse.type = 'annular'
				}
			}
		} else if (next) {
			k++
		} else {
			k--
		}
	}

	return eclipse
}
