import { deg } from './angle'
import { ASEC2RAD, AU_KM, DEG2RAD, MOON_SINODIC_DAYS } from './constants'
import type { Distance } from './distance'
import { type Time, Timescale, time, timeNormalize, toJulianDay, tt } from './time'

export type LunarEclipseType = 'TOTAL' | 'PARTIAL' | 'PENUMBRAL'

export enum LunationSystem {
	BROWN,
	MEEUS,
	GOLDSTINE,
	HEBREW,
	ISLAMIC,
	THAI,
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
	const LN = Math.round((time.day - 2451550 + (time.fraction - 0.25972)) / MOON_SINODIC_DAYS - 0.25) || 0

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
	const LN = Math.round((time.day - 2452656 + (time.fraction - 0.94931)) / MOON_SINODIC_DAYS)
	const SNL = ((192 + LN * 38 - 1) % 223) + 1
	return SNL < 0 ? SNL + 223 : SNL
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
				if (timeOfGreatestEclipseDay + timeOfGreatestEclipseFraction + timeOfGreatestEclipseCorrection > jd !== next) {
					found = false
					if (next) k++
					else k--
					continue
				}

				eclipse.maximalTime = timeNormalize(timeOfGreatestEclipseDay, timeOfGreatestEclipseFraction + timeOfGreatestEclipseCorrection, 0, Timescale.TT)
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
