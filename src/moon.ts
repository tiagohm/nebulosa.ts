import { type Angle, arcsec, deg } from './angle'
import { ASEC2RAD, AU_KM, DEG2RAD, MOON_SYNODIC_DAYS } from './constants'
import { type Distance, kilometer } from './distance'
import { type Time, Timescale, time, timeNormalize, timeToFractionOfYear, toJulianDay, tt } from './time'

export type LunarEclipseType = 'TOTAL' | 'PARTIAL' | 'PENUMBRAL'

export type LunationSystem = 'BROWN' | 'MEEUS' | 'GOLDSTINE' | 'HEBREW' | 'ISLAMIC' | 'THAI'

export type LunarPhase = 'NEW' | 'FIRST_QUARTER' | 'FULL' | 'LAST_QUARTER'

export type LunarApsis = 'PERIGEE' | 'APOGEE'

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
export function lunation(time: Time, system: LunationSystem = 'BROWN') {
	// The first New Moon of 2000 (6th January, ~ 18:14 UTC)
	const LN = Math.round((time.day - 2451550 + (time.fraction - 0.25972)) / MOON_SYNODIC_DAYS - 0.25) || 0

	if (system === 'MEEUS') return LN
	else if (system === 'GOLDSTINE') return LN + 37105
	else if (system === 'HEBREW') return LN + 71234
	else if (system === 'ISLAMIC') return LN + 17038
	else if (system === 'THAI') return LN + 16843
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
	time = tt(time)
	const jd = toJulianDay(time)

	const year = timeToFractionOfYear(time)
	const phaseFraction = phase === 'NEW' ? 0 : phase === 'FIRST_QUARTER' ? 0.25 : phase === 'FULL' ? 0.5 : 0.75
	let k = Math.floor((year - 2000) * 12.3685) + phaseFraction + (next ? 0 : 1)

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

		if (phase === 'NEW') {
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

		if (phase === 'FULL') {
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

		if (phase === 'FIRST_QUARTER' || phase === 'LAST_QUARTER') {
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

			if (phase === 'FIRST_QUARTER') addition += W
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

// Computes the nearest (previous or next) lunar eclipse for a given time
export function nearestLunarEclipse(time: Time, next: boolean): Readonly<LunarEclipse> {
	time = tt(time)
	const jd = toJulianDay(time)
	let k = lunation(time, 'MEEUS') + (next ? 0.5 : 1.5)

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
				const n = 1 / (24 * (0.5458 + 0.04 * Math.cos(MM)))
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

// Computes the nearest lunar apsis for a given time
export function nearestLunarApsis(time: Time, apsis: LunarApsis): readonly [Time, Distance, Angle] {
	time = tt(time)
	const year = timeToFractionOfYear(time)
	let k = Math.floor((year - 1999.97) * 13.2555)
	if (apsis === 'APOGEE') k += 0.5

	const T = k / 1325.55
	const T2 = T * T
	const T3 = T2 * T
	const T4 = T3 * T

	const jdDay = 2451534 + 27 * k
	let jdFraction = 0.6698 + 0.55454989 * k - 0.0006691 * T2 - 0.000001098 * T3 + 0.0000000052 * T4
	const D = deg(171.9179 + 335.9106046 * k - 0.0100383 * T2 - 0.00001156 * T3 + 0.000000055 * T4)
	const M = deg(347.3477 + 27.1577721 * k - 0.000813 * T2 - 0.000001 * T3)
	const F = deg(316.6109 + 364.5287911 * k - 0.0125053 * T2 - 0.0000148 * T3)

	let parallax = 0

	if (apsis === 'PERIGEE') {
		jdFraction +=
			Math.sin(2 * D) * -1.6769 +
			Math.sin(4 * D) * 0.4589 +
			Math.sin(6 * D) * -0.1856 +
			Math.sin(8 * D) * 0.0883 +
			Math.sin(2 * D - M) * (-0.0773 + 0.00019 * T) +
			Math.sin(M) * (0.0502 - 0.00013 * T) +
			Math.sin(10 * D) * -0.046 +
			Math.sin(4 * D - M) * (0.0422 - 0.00011 * T) +
			Math.sin(6 * D - M) * -0.0256 +
			Math.sin(12 * D) * 0.0253 +
			Math.sin(D) * 0.0237 +
			Math.sin(8 * D - M) * 0.0162 +
			Math.sin(14 * D) * -0.0145 +
			Math.sin(2 * F) * 0.0129 +
			Math.sin(3 * D) * -0.0112 +
			Math.sin(10 * D - M) * -0.0104 +
			Math.sin(16 * D) * 0.0086 +
			Math.sin(12 * D - M) * 0.0069 +
			Math.sin(5 * D) * 0.0066 +
			Math.sin(2 * D + 2 * F) * -0.0053 +
			Math.sin(18 * D) * -0.0052 +
			Math.sin(14 * D - M) * -0.0046 +
			Math.sin(7 * D) * -0.0041 +
			Math.sin(2 * D + M) * 0.004 +
			Math.sin(20 * D) * 0.0032 +
			Math.sin(D + M) * -0.0032 +
			Math.sin(16 * D - M) * 0.0031 +
			Math.sin(4 * D + M) * -0.0029 +
			Math.sin(9 * D) * 0.0027 +
			Math.sin(4 * D + 2 * F) * 0.0027 +
			Math.sin(2 * D - 2 * M) * -0.0027 +
			Math.sin(4 * D - 2 * M) * 0.0024 +
			Math.sin(6 * D - 2 * M) * -0.0021 +
			Math.sin(22 * D) * -0.0021 +
			Math.sin(18 * D - M) * -0.0021 +
			Math.sin(6 * D + M) * 0.0019 +
			Math.sin(11 * D) * -0.0018 +
			Math.sin(8 * D + M) * -0.0014 +
			Math.sin(4 * D - 2 * F) * -0.0014 +
			Math.sin(6 * D + 2 * F) * -0.0014 +
			Math.sin(3 * D + M) * 0.0014 +
			Math.sin(5 * D + M) * -0.0014 +
			Math.sin(13 * D) * 0.0013 +
			Math.sin(20 * D - M) * 0.0013 +
			Math.sin(3 * D + 2 * M) * 0.0011 +
			Math.sin(4 * D + 2 * F - 2 * M) * -0.0011 +
			Math.sin(D + 2 * M) * -0.001 +
			Math.sin(22 * D - M) * -0.0009 +
			Math.sin(4 * F) * -0.0008 +
			Math.sin(6 * D - 2 * F) * 0.0008 +
			Math.sin(2 * D - 2 * F + M) * 0.0008 +
			Math.sin(2 * M) * 0.0007 +
			Math.sin(2 * F - M) * 0.0007 +
			Math.sin(2 * D + 4 * F) * 0.0007 +
			Math.sin(2 * F - 2 * M) * -0.0006 +
			Math.sin(2 * D - 2 * F + 2 * M) * -0.0006 +
			Math.sin(24 * D) * 0.0006 +
			Math.sin(4 * D - 4 * F) * 0.0005 +
			Math.sin(2 * D + 2 * M) * 0.0005 +
			Math.sin(D - M) * -0.0004

		parallax =
			3629.215 +
			63.224 * Math.cos(2 * D) -
			6.99 * Math.cos(4 * D) +
			2.834 * Math.cos(2 * D - M) -
			0.0071 * T * Math.cos(2 * D - M) +
			1.927 * Math.cos(6 * D) -
			1.263 * Math.cos(D) -
			0.702 * Math.cos(8 * D) +
			0.696 * Math.cos(M) -
			0.0017 * T * Math.cos(M) -
			0.69 * Math.cos(2 * F) -
			0.629 * Math.cos(4 * D - M) +
			0.0016 * T * Math.cos(4 * D - M) -
			0.392 * Math.cos(2 * D - 2 * F) +
			0.297 * Math.cos(10 * D) +
			0.26 * Math.cos(6 * D - M) +
			0.201 * Math.cos(3 * D) -
			0.161 * Math.cos(2 * D + M) +
			0.157 * Math.cos(D + M) -
			0.138 * Math.cos(12 * D) -
			0.127 * Math.cos(8 * D - M) +
			0.104 * Math.cos(2 * D + 2 * F) +
			0.104 * Math.cos(2 * D - 2 * M) -
			0.079 * Math.cos(5 * D) +
			0.068 * Math.cos(14 * D) +
			0.067 * Math.cos(10 * D - M) +
			0.054 * Math.cos(4 * D + M) -
			0.038 * Math.cos(12 * D - M) -
			0.038 * Math.cos(4 * D - 2 * M) +
			0.037 * Math.cos(7 * D) -
			0.037 * Math.cos(4 * D + 2 * F) -
			0.035 * Math.cos(16 * D) -
			0.03 * Math.cos(3 * D + M) +
			0.029 * Math.cos(D - M) -
			0.025 * Math.cos(6 * D + M) +
			0.023 * Math.cos(2 * M) +
			0.023 * Math.cos(14 * D - M) -
			0.023 * Math.cos(2 * D + 2 * M) +
			0.022 * Math.cos(6 * D - 2 * M) -
			0.021 * Math.cos(2 * D - 2 * F - M) -
			0.02 * Math.cos(9 * D) +
			0.019 * Math.cos(18 * D) +
			0.017 * Math.cos(6 * D + 2 * F) +
			0.014 * Math.cos(2 * F - M) -
			0.014 * Math.cos(16 * D - M) +
			0.013 * Math.cos(4 * D - 2 * F) +
			0.012 * Math.cos(8 * D + M) +
			0.011 * Math.cos(11 * D) +
			0.01 * Math.cos(5 * D + M) -
			0.01 * Math.cos(20 * D)
	} else if (apsis === 'APOGEE') {
		jdFraction +=
			Math.sin(2 * D) * 0.4392 +
			Math.sin(4 * D) * 0.0684 +
			Math.sin(M) * (0.0456 - 0.00011 * T) +
			Math.sin(2 * D - M) * (0.0426 - 0.00011 * T) +
			Math.sin(2 * F) * 0.0212 +
			Math.sin(D) * -0.0189 +
			Math.sin(6 * D) * 0.0144 +
			Math.sin(4 * D - M) * 0.0113 +
			Math.sin(2 * D + 2 * F) * 0.0047 +
			Math.sin(D + M) * 0.0036 +
			Math.sin(8 * D) * 0.0035 +
			Math.sin(6 * D - M) * 0.0034 +
			Math.sin(2 * D - 2 * F) * -0.0034 +
			Math.sin(2 * D - 2 * M) * 0.0022 +
			Math.sin(3 * D) * -0.0017 +
			Math.sin(4 * D + 2 * F) * 0.0013 +
			Math.sin(8 * D - M) * 0.0011 +
			Math.sin(4 * D - 2 * M) * 0.001 +
			Math.sin(10 * D) * 0.0009 +
			Math.sin(3 * D + M) * 0.0007 +
			Math.sin(2 * M) * 0.0006 +
			Math.sin(2 * D + M) * 0.0005 +
			Math.sin(2 * D + 2 * M) * 0.0005 +
			Math.sin(6 * D + 2 * F) * 0.0004 +
			Math.sin(6 * D - 2 * M) * 0.0004 +
			Math.sin(10 * D - M) * 0.0004 +
			Math.sin(5 * D) * -0.0004 +
			Math.sin(4 * D - 2 * F) * -0.0004 +
			Math.sin(2 * F + M) * 0.0003 +
			Math.sin(12 * D) * 0.0003 +
			Math.sin(2 * D + 2 * F - M) * 0.0003 +
			Math.sin(D - M) * -0.0003

		parallax =
			3245.251 -
			9.147 * Math.cos(2 * D) -
			0.841 * Math.cos(D) +
			0.697 * Math.cos(2 * F) -
			0.656 * Math.cos(M) +
			0.0016 * T * Math.cos(M) +
			0.355 * Math.cos(4 * D) +
			0.159 * Math.cos(2 * D - M) +
			0.127 * Math.cos(D + M) +
			0.065 * Math.cos(4 * D - M) +
			0.052 * Math.cos(6 * D) +
			0.043 * Math.cos(2 * D + M) +
			0.031 * Math.cos(2 * D + 2 * F) -
			0.023 * Math.cos(2 * D - 2 * F) +
			0.022 * Math.cos(2 * D - 2 * M) +
			0.019 * Math.cos(2 * D + 2 * M) -
			0.016 * Math.cos(2 * M) +
			0.014 * Math.cos(6 * D - M) +
			0.01 * Math.cos(8 * D)
	}

	const distance = kilometer(6378.14 / Math.sin(arcsec(parallax)))
	const diameter = 2 * moonSemidiameter(distance)

	return [timeNormalize(jdDay, jdFraction, 0, Timescale.TT), distance, diameter]
}
