import { type Angle, deg, normalizeAngle } from './angle'
import { ASEC2RAD, AU_KM, DAYSPERJY, DEG2RAD, MOON_SYNODIC_DAYS } from './constants'
import type { Distance } from './distance'
import { temporalFromTime, temporalGet } from './temporal'
import { greenwichApparentSiderealTime, type Time, Timescale, time, timeNormalize, timeSubtract, timeYMD, toJulianDay, tt } from './time'

export type LunarEclipseType = 'TOTAL' | 'PARTIAL' | 'PENUMBRAL'

export enum LunationSystem {
	BROWN,
	MEEUS,
	GOLDSTINE,
	HEBREW,
	ISLAMIC,
	THAI,
}

export enum LunarPhase {
	NEW = 0, // 0
	FIRST_QUARTER = 1, // 25
	FULL = 2, // 50
	LAST_QUARTER = 3, // 75
}

export interface LunarEclipse {
	lunation: number
	type: LunarEclipseType
	maximalTime: Time // Instant of maximal eclipse
	firstContactPenumbraTime: Time // P1
	firstContactUmbraTime: Time // U1
	totalBeginTime: Time // U2
	totalEndTime: Time // U3
	lastContactUmbraTime: Time // U4
	lastContactPenumbraTime: Time // P4
	magnitude: number
	sigma: number // Radius of umbra, in equatorial Earth radii, at eclipse plane
	gamma: number // Least distance from the center of the Moon to the axis of the Earth shadow, in units of equatorial radius of the Earth.
	rho: number // Radius of penumbra, in equatorial Earth radii, at eclipse plane
	u: number // Radius of the Earth umbral cone in the eclipse plane, in units of equatorial radius of the Earth.
}

const DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME = time(0, 0, Timescale.TT, false)

// Computes the parallax of the Moon at a given distance
export function moonParallax(distance: Distance) {
	return Math.asin(6378.14 / AU_KM / distance)
}

// Computes the semi-diameter of the Moon at a given distance
export function moonSemidiameter(distance: Distance) {
	return ((358473400 / AU_KM) * ASEC2RAD) / distance
}

// Computes the lunation number for a given time and system
export function lunation(time: Time, system: LunationSystem = LunationSystem.BROWN) {
	// The first New Moon of 2000 (6th January, ~ 18:14 UTC)
	const LN = Math.round((time.day - 2451550 + (time.fraction - 0.25972)) / MOON_SYNODIC_DAYS - 0.25) || 0

	if (system === LunationSystem.MEEUS) return LN
	else if (system === LunationSystem.GOLDSTINE) return LN + 37105
	else if (system === LunationSystem.HEBREW) return LN + 71234
	else if (system === LunationSystem.ISLAMIC) return LN + 17038
	else if (system === LunationSystem.THAI) return LN + 16843
	else return LN + 953
}

// Computes the saros series number for the lunar eclipse.
export function lunarSaros(time: Time) {
	// Full moon 18 Jan 2003
	const LN = Math.round((time.day - 2452656 + (time.fraction - 0.94931)) / MOON_SYNODIC_DAYS)
	const SNL = ((192 + LN * 38 - 1) % 223) + 1
	return SNL < 0 ? SNL + 223 : SNL
}

// Computes the nearest (previous or next) lunar phase for a given time
export function nearestLunarPhase(time: Time, phase: LunarPhase, next: boolean): Time {
	const t = tt(time)
	const jd = toJulianDay(t)

	let year = temporalGet(temporalFromTime(t), 'year')
	year += timeSubtract(t, timeYMD(year)) / DAYSPERJY
	let k = Math.floor((year - 2000) * 12.3685) + phase / 4 + (next ? 0 : 1)

	while (true) {
		const T = k / 1236.85
		const T2 = T * T
		const T3 = T2 * T
		const T4 = T3 * T

		const timeOfEclipseDay = 2451550 + 29 * k
		const timeOfEclipseFraction = 0.530588861 * k + 0.09766 + 0.00015437 * T - 0.00000015 * T2 + 0.00000000073 * T3

		// Sun's mean anomaly
		const SM = deg(2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3)

		// Moon's mean anomaly
		const MM = deg(201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4)

		// Moon's argument of latitude (mean distance of the Moon from its ascending node)
		const F = deg(160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4)

		// Mean longitude of ascending node
		const omega = deg(124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3)

		const A1 = 299.77 * DEG2RAD + 0.107408 * DEG2RAD * k - 0.009173 * DEG2RAD * T2
		const A2 = 251.88 * DEG2RAD + 0.016321 * DEG2RAD * k
		const A3 = 251.83 * DEG2RAD + 26.651866 * DEG2RAD * k
		const A4 = 349.42 * DEG2RAD + 36.412478 * DEG2RAD * k
		const A5 = 84.66 * DEG2RAD + 18.206239 * DEG2RAD * k
		const A6 = 141.74 * DEG2RAD + 53.303771 * DEG2RAD * k
		const A7 = 207.14 * DEG2RAD + 2.453732 * DEG2RAD * k
		const A8 = 154.84 * DEG2RAD + 7.30686 * DEG2RAD * k
		const A9 = 34.52 * DEG2RAD + 27.261239 * DEG2RAD * k
		const A10 = 207.19 * DEG2RAD + 0.121824 * DEG2RAD * k
		const A11 = 291.34 * DEG2RAD + 1.844379 * DEG2RAD * k
		const A12 = 161.72 * DEG2RAD + 24.198154 * DEG2RAD * k
		const A13 = 239.56 * DEG2RAD + 25.513099 * DEG2RAD * k
		const A14 = 331.55 * DEG2RAD + 3.592518 * DEG2RAD * k

		// Multiplier related to the eccentricity of the Earth orbit
		const E = 1 - 0.002516 * T - 0.0000074 * T2

		let addition = 0

		if (phase === LunarPhase.NEW) {
			addition =
				-0.4072 * Math.sin(MM) +
				0.17241 * E * Math.sin(SM) +
				0.01608 * Math.sin(2 * MM) +
				0.01039 * Math.sin(2 * F) +
				0.00739 * E * Math.sin(MM - SM) -
				0.00514 * E * Math.sin(MM + SM) +
				0.00208 * E * E * Math.sin(2 * SM) -
				0.00111 * Math.sin(MM - 2 * F) -
				0.00057 * Math.sin(MM + 2 * F) +
				0.00056 * E * Math.sin(2 * MM + SM) -
				0.00042 * Math.sin(3 * MM) +
				0.00042 * E * Math.sin(SM + 2 * F) +
				0.00038 * E * Math.sin(SM - 2 * F) -
				0.00024 * E * Math.sin(2 * MM - SM) -
				0.00017 * Math.sin(omega) -
				0.00007 * Math.sin(MM + 2 * SM) +
				0.00004 * Math.sin(2 * MM - 2 * F) +
				0.00004 * Math.sin(3 * SM) +
				0.00003 * Math.sin(MM + SM - 2 * F) +
				0.00003 * Math.sin(2 * MM + 2 * F) -
				0.00003 * Math.sin(MM + SM + 2 * F) +
				0.00003 * Math.sin(MM - SM + 2 * F) -
				0.00002 * Math.sin(MM - SM - 2 * F) -
				0.00002 * Math.sin(3 * MM + SM) +
				0.00002 * Math.sin(4 * MM)
		}

		if (phase === LunarPhase.FULL) {
			addition =
				-0.40614 * Math.sin(MM) +
				0.17302 * E * Math.sin(SM) +
				0.01614 * Math.sin(2 * MM) +
				0.01043 * Math.sin(2 * F) +
				0.00734 * E * Math.sin(MM - SM) -
				0.00515 * E * Math.sin(MM + SM) +
				0.00209 * E * E * Math.sin(2 * SM) -
				0.00111 * Math.sin(MM - 2 * F) -
				0.00057 * Math.sin(MM + 2 * F) +
				0.00056 * E * Math.sin(2 * MM + SM) -
				0.00042 * Math.sin(3 * MM) +
				0.00042 * E * Math.sin(SM + 2 * F) +
				0.00038 * E * Math.sin(SM - 2 * F) -
				0.00024 * E * Math.sin(2 * MM - SM) -
				0.00017 * Math.sin(omega) -
				0.00007 * Math.sin(MM + 2 * SM) +
				0.00004 * Math.sin(2 * MM - 2 * F) +
				0.00004 * Math.sin(3 * SM) +
				0.00003 * Math.sin(MM + SM - 2 * F) +
				0.00003 * Math.sin(2 * MM + 2 * F) -
				0.00003 * Math.sin(MM + SM + 2 * F) +
				0.00003 * Math.sin(MM - SM + 2 * F) -
				0.00002 * Math.sin(MM - SM - 2 * F) -
				0.00002 * Math.sin(3 * MM + SM) +
				0.00002 * Math.sin(4 * MM)
		}

		if (phase === LunarPhase.FIRST_QUARTER || phase === LunarPhase.LAST_QUARTER) {
			addition =
				-0.62801 * Math.sin(MM) +
				0.17172 * E * Math.sin(SM) -
				0.01183 * E * Math.sin(MM + SM) +
				0.00862 * Math.sin(2 * MM) +
				0.00804 * Math.sin(2 * F) +
				0.00454 * E * Math.sin(MM - SM) +
				0.00204 * E * E * Math.sin(2 * SM) -
				0.0018 * Math.sin(MM - 2 * F) -
				0.0007 * Math.sin(MM + 2 * F) -
				0.0004 * Math.sin(3 * MM) -
				0.00034 * E * Math.sin(2 * MM - SM) +
				0.00032 * E * Math.sin(SM + 2 * F) +
				0.00032 * E * Math.sin(SM - 2 * F) -
				0.00028 * E * E * Math.sin(MM + 2 * SM) +
				0.00027 * E * Math.sin(2 * MM + SM) -
				0.00017 * Math.sin(omega) -
				0.00005 * Math.sin(MM - SM - 2 * F) +
				0.00004 * Math.sin(2 * MM + 2 * F) -
				0.00004 * Math.sin(MM + SM + 2 * F) +
				0.00004 * Math.sin(MM - 2 * SM) +
				0.00003 * Math.sin(MM + SM - 2 * F) +
				0.00003 * Math.sin(3 * SM) +
				0.00002 * Math.sin(2 * MM - 2 * F) +
				0.00002 * Math.sin(MM - SM + 2 * F) -
				0.00002 * Math.sin(3 * MM + SM)

			const W = 0.00306 - 0.00038 * E * Math.cos(SM) + 0.00026 * Math.cos(MM) - 0.00002 * Math.cos(MM - SM) + 0.00002 * Math.cos(MM + SM) + 0.00002 * Math.cos(2 * F)

			if (phase === LunarPhase.FIRST_QUARTER) addition += W
			else addition -= W
		}

		const timeOfEclipseCorrection =
			0.000325 * Math.sin(A1) +
			0.000165 * Math.sin(A2) +
			0.000164 * Math.sin(A3) +
			0.000126 * Math.sin(A4) +
			0.00011 * Math.sin(A5) +
			0.000062 * Math.sin(A6) +
			0.00006 * Math.sin(A7) +
			0.000056 * Math.sin(A8) +
			0.000047 * Math.sin(A9) +
			0.000042 * Math.sin(A10) +
			0.00004 * Math.sin(A11) +
			0.000037 * Math.sin(A12) +
			0.000035 * Math.sin(A13) +
			0.000023 * Math.sin(A14)

		const fraction = timeOfEclipseFraction + timeOfEclipseCorrection + addition

		if (timeOfEclipseDay + fraction > jd !== next) {
			if (next) k++
			else k--
			continue
		}

		return timeNormalize(timeOfEclipseDay, fraction, 0, Timescale.TT)
	}
}

// Computes the nearest (previous or next) solar eclipse for a given time
export function nearestLunarEclipse(time: Time, next: boolean): Readonly<LunarEclipse> {
	const t = tt(time)
	const jd = toJulianDay(t)
	let k = lunation(t, LunationSystem.MEEUS) + (next ? 0.5 : 1.5)

	let found = false

	const eclipse: LunarEclipse = {
		lunation: k,
		type: 'TOTAL',
		maximalTime: DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME,
		firstContactPenumbraTime: DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME,
		firstContactUmbraTime: DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME,
		totalBeginTime: DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME,
		totalEndTime: DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME,
		lastContactUmbraTime: DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME,
		lastContactPenumbraTime: DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME,
		magnitude: 0,
		sigma: 0,
		gamma: 0,
		rho: 0,
		u: 0,
	}

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

			const F1 = F - 0.02665 * DEG2RAD * Math.sin(omega)
			const A1 = deg(299.77 + 0.107408 * k - 0.009173 * T2)

			const P = 0.207 * E * Math.sin(SM) + 0.0024 * E * Math.sin(2 * SM) - 0.0392 * Math.sin(MM) + 0.0116 * Math.sin(2 * MM) - 0.0073 * E * Math.sin(MM + SM) + 0.0067 * E * Math.sin(MM - SM) + 0.0118 * Math.sin(2 * F1)
			const Q = 5.2207 - 0.0048 * E * Math.cos(SM) + 0.002 * E * Math.cos(2 * SM) - 0.3299 * Math.cos(MM) - 0.006 * E * Math.cos(MM + SM) + 0.0041 * E * Math.cos(MM - SM)
			const W = Math.abs(Math.cos(F1))
			const gamma = (P * Math.cos(F1) + Q * Math.sin(F1)) * (1 - 0.0048 * W)
			const u = 0.0059 + 0.0046 * E * Math.cos(SM) - 0.0182 * Math.cos(MM) + 0.0004 * Math.cos(2 * MM) - 0.0005 * E * Math.cos(SM + MM)
			const rho = 1.2848 + u
			const sigma = 0.7403 - u
			let mag = (1.0128 - u - Math.abs(gamma)) / 0.545

			const timeOfGreatestEclipseDay = 2451550 + 29 * k
			const timeOfGreatestEclipseFraction = 0.530588861 * k + 0.09766 + 0.00015437 * T - 0.00000015 * T2 + 0.00000000073 * T3
			const timeOfGreatestEclipseCorrection =
				-0.4065 * Math.sin(MM) +
				0.1727 * E * Math.sin(SM) +
				0.0161 * Math.sin(2 * MM) -
				0.0097 * Math.sin(2 * F1) +
				0.0073 * E * Math.sin(MM - SM) -
				0.005 * E * Math.sin(MM + SM) -
				0.0023 * Math.sin(MM - 2 * F1) +
				0.0021 * E * Math.sin(2 * SM) +
				0.0012 * Math.sin(MM + 2 * F1) +
				0.0006 * E * Math.sin(2 * MM + SM) -
				0.0004 * Math.sin(3 * MM) -
				0.0003 * E * Math.sin(SM + 2 * F1) +
				0.0003 * Math.sin(A1) -
				0.0002 * E * Math.sin(SM - 2 * F1) -
				0.0002 * E * Math.sin(2 * MM - SM) -
				0.0002 * Math.sin(omega)

			if (mag >= 1) {
				eclipse.type = 'TOTAL'
			} else if (mag > 0) {
				eclipse.type = 'PARTIAL'
			}

			// Check if elipse is penumbral only
			else {
				eclipse.type = 'PENUMBRAL'
				mag = (1.5573 + u - Math.abs(gamma)) / 0.545
			}

			// No eclipse, if both phases is less than 0.
			// Examine other lunation
			if (mag < 0) {
				found = false
			}
			// Eclipse found
			else {
				const fraction = timeOfGreatestEclipseFraction + timeOfGreatestEclipseCorrection

				if (timeOfGreatestEclipseDay + fraction > jd !== next) {
					found = false
					if (next) k++
					else k--
					continue
				}

				eclipse.maximalTime = timeNormalize(timeOfGreatestEclipseDay, fraction, 0, Timescale.TT)
				eclipse.magnitude = mag
				eclipse.rho = rho
				eclipse.gamma = gamma
				eclipse.sigma = sigma
				eclipse.u = u

				const p = 1.0128 - u
				const t = 0.4678 - u
				const n = 1.0 / (24 * (0.5458 + 0.04 * Math.cos(MM)))
				const h = 1.5573 + u
				const g2 = gamma * gamma

				const sdPartial = n * Math.sqrt(p * p - g2)
				const sdTotal = n * Math.sqrt(t * t - g2)
				const sdPenumbra = n * Math.sqrt(h * h - g2)

				eclipse.firstContactPenumbraTime = timeNormalize(eclipse.maximalTime.day - sdPenumbra, eclipse.maximalTime.fraction, 0, Timescale.TT)
				if (!Number.isNaN(sdPartial)) eclipse.firstContactUmbraTime = timeNormalize(eclipse.maximalTime.day - sdPartial, eclipse.maximalTime.fraction, 0, Timescale.TT)
				if (!Number.isNaN(sdTotal)) eclipse.totalBeginTime = timeNormalize(eclipse.maximalTime.day - sdTotal, eclipse.maximalTime.fraction, 0, Timescale.TT)
				if (!Number.isNaN(sdTotal)) eclipse.totalEndTime = timeNormalize(eclipse.maximalTime.day + sdTotal, eclipse.maximalTime.fraction, 0, Timescale.TT)
				if (!Number.isNaN(sdPartial)) eclipse.lastContactUmbraTime = timeNormalize(eclipse.maximalTime.day + sdPartial, eclipse.maximalTime.fraction, 0, Timescale.TT)
				eclipse.lastContactPenumbraTime = timeNormalize(eclipse.maximalTime.day + sdPenumbra, eclipse.maximalTime.fraction, 0, Timescale.TT)
				eclipse.lunation = Math.round(k - 0.5)

				break
			}
		}

		if (!found) {
			if (next) k++
			else k--
		}
	}

	return eclipse
}

export interface PolynomialLunarEclipseElements {
	readonly time: Time
	readonly maximumTime: Time
	readonly step: number // Step, in days, between each item in instant Besselian elements series used to produce this polynomial coefficients.
	readonly X: number[] // Coefficients of X (X-coordinate of center of the Moon in fundamental plane), index is a power of t.
	readonly Y: number[] // Coefficients of Y (Y-coordinate of center of the Moon in fundamental plane), index is a power of t.
	readonly F1: Angle[] // Coefficients of F1 (Earth penumbra radius, in radians), index is a power of t.
	readonly F2: Angle[] // Coefficients of F2 (Earth umbra radius, in radians), index is a power of t.
	readonly F3: Angle[] // Coefficients of F3 (Lunar radius (semidiameter), in radians), index is a power of t.
	readonly A: Angle[] // Coefficients of Alpha (Geocentric right ascension of the Moon, in radians), index is a power of t.
	readonly D: Angle[] // Coefficients of Delta (Geocentric declination of the Moon, in radians), index is a power of t.
}

export interface InstantLunarEclipseElements {
	readonly time: Time // Instant of the elements.
	readonly X: number // X-coordinate of center of the Moon in fundamental plane.
	readonly Y: number // Y-coordinate of center of the Moon in fundamental plane.
	readonly F1: Angle // Earth penumbra radius, in radians.
	readonly F2: Angle // Earth umbra radius, in radians.
	readonly F3: Angle // Lunar radius (semidiameter), in radians.
	readonly A: Angle // Geocentric right ascension of the Moon, in radians.
	readonly D: Angle // Geocentric declination of the Moon, in radians.
}

export function instantBesselianElements(p: PolynomialLunarEclipseElements, time: Time): InstantLunarEclipseElements {
	// Difference, with t0, in step units
	const t = timeSubtract(time, p.time) / p.step
	const n = p.X.length

	let X = 0
	let Y = 0
	let F1 = 0
	let F2 = 0
	let F3 = 0
	let A = 0
	let D = 0

	for (let i = 0; i < n; i++) {
		const e = t ** i
		X += p.X[i] * e
		Y += p.Y[i] * e
		F1 += p.F1[i] * e
		F2 += p.F2[i] * e
		F3 += p.F3[i] * e
		A += p.A[i] * e
		D += p.D[i] * e
	}

	return { time, X, Y, F1, F2, F3, A: normalizeAngle(A), D }
}

export function besselianElements() {}

// Finds horizon circle point for a given geographical longitude
// for an instant of lunar eclipse, where Moon has zero altitude.
// Geographical longitude is positive west, negative east, from -180 to +180 degrees.
// The method core is based on formulae from the book:
// Seidelmann, P. K.: Explanatory Supplement to The Astronomical Almanac,
// University Science Book, Mill Valley (California), 1992,
// Chapter 8 "Eclipses of the Sun and Moon"
// https://archive.org/download/131123ExplanatorySupplementAstronomicalAlmanac/131123-explanatory-supplement-astronomical-almanac.pdf
function project(e: InstantLunarEclipseElements, longitude: Angle) {
	// Greenwich apparent sidereal time
	const siderealTime = greenwichApparentSiderealTime(e.time)

	// Geocentric distance to the Moon, in km
	const dist = (358473400 * ASEC2RAD) / e.F3

	// Horizontal parallax of the Moon
	const parallax = moonParallax(dist)

	// Equatorial coordinates of the Moon, initial value is geocentric
	const eq = [e.A, e.D]

	// two iterations:
	// 1st: find geo location needed to perform topocentric correction
	// 2nd: correct sublunar point with topocentric position and find true geoposition
	for (let i = 0; i < 2; i++) {
		// sublunar point latitude, preserve sign!
		const phi0 = Math.sign(e.D) * Math.abs(eq.D)

		// sublunar point longitude (formula 8.426-1)
		const lambda0 = siderealTime - eq.A

		// sublunar point latitude (formula 8.426-2)
		const tanPhi = (-1 / Math.tan(phi0)) * Math.cos(lambda0 - longitude)
		const phi = Math.atan(tanPhi)

		g = new CrdsGeographical(longitude, phi)

		if (i === 0) {
			// correct to topocentric
			eq = eq.ToTopocentric(g, siderealTime, parallax)
		}
	}
}
