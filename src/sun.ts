import { deg } from './angle'
import { ASEC2RAD, DAYSPERJC, DEG2RAD, J2000 } from './constants'
import type { Distance } from './distance'
import { LunationSystem, lunation } from './moon'
import { type Time, Timescale, time, timeNormalize, toJulianDay, tt } from './time'

export type Season = 'SPRING' | 'SUMMER' | 'AUTUMN' | 'WINTER'

export type SolarEclipseType = 'TOTAL' | 'PARTIAL' | 'ANNULAR' | 'HYBRID'

export interface SolarEclipse {
	lunation: number
	maximalTime: Time // Instant of maximal eclipse
	magnitude: number
	// Least distance from the axis of the Moon's shadow to the center of the Earth,
	// in units of equatorial radius of the Earth.
	gamma: number
	// Radius of the Moon's umbral cone in the fundamental plane,
	// in units of equatorial radius of the Earth.
	u: number
	type: SolarEclipseType
}

const DEFAULT_MINIMAL_SOLAR_ECLIPSE_TIME = time(0, 0, Timescale.TT, false)

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

// Computes instant of beginning of astronomical season for given year [1000...3000]
export function season(year: number, name: Season) {
	let jd0 = 0

	const Y = (year - 2000) / 1000

	switch (name) {
		case 'SPRING':
			jd0 = 2451623.80984 + (((-0.00057 * Y - 0.00411) * Y + 0.05169) * Y + 365242.37404) * Y
			break
		case 'SUMMER':
			jd0 = 2451716.56767 + (((-0.0003 * Y + 0.00888) * Y + 0.00325) * Y + 365241.62603) * Y
			break
		case 'AUTUMN':
			jd0 = 2451810.21715 + (((0.00078 * Y + 0.00337) * Y - 0.11575) * Y + 365242.01767) * Y
			break
		case 'WINTER':
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

	return time(jd0, (0.00001 * S) / deltaLambda)
}

// Computes the saros series number for the solar eclipse.
export function solarSaros(time: Time) {
	const nd = lunation(time, LunationSystem.MEEUS) + 105
	const ns = 136 + 38 * nd
	const nx = -61 * nd
	const nc = Math.floor(nx / 358.0 + 0.5 - nd / (12.0 * 358 * 358))
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
	let k = lunation(t, LunationSystem.MEEUS) + (next ? 0 : 1)

	const eclipse: SolarEclipse = {
		lunation: k,
		maximalTime: DEFAULT_MINIMAL_SOLAR_ECLIPSE_TIME,
		magnitude: 0,
		gamma: 0,
		u: 0,
		type: 'TOTAL',
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

			const F1 = F - 0.02665 * DEG2RAD * Math.sin(omega)
			const A1 = deg(299.77 + 0.107408 * k - 0.009173 * T2)

			const P = 0.207 * E * Math.sin(SM) + 0.0024 * E * Math.sin(2 * SM) - 0.0392 * Math.sin(MM) + 0.0116 * Math.sin(2 * MM) - 0.0073 * E * Math.sin(MM + SM) + 0.0067 * E * Math.sin(MM - SM) + 0.0118 * Math.sin(2 * F1)
			const Q = 5.2207 - 0.0048 * E * Math.cos(SM) + 0.002 * E * Math.cos(2 * SM) - 0.3299 * Math.cos(MM) - 0.006 * E * Math.cos(MM + SM) + 0.0041 * E * Math.cos(MM - SM)
			const W = Math.abs(Math.cos(F1))
			const gamma = (P * Math.cos(F1) + Q * Math.sin(F1)) * (1 - 0.0048 * W)
			const u = 0.0059 + 0.0046 * E * Math.cos(SM) - 0.0182 * Math.cos(MM) + 0.0004 * Math.cos(2 * MM) - 0.0005 * Math.cos(SM + MM)
			const absG = Math.abs(gamma)

			// no eclipse visible from the Earth surface
			if (absG > 1.5433 + u) {
				found = false
				if (next) k++
				else k--
				continue
			}

			const timeOfGreatestEclipseDay = 2451550 + 29 * k
			const timeOfGreatestEclipseFraction = 0.530588861 * k + 0.09766 + 0.00015437 * T - 0.00000015 * T2 + 0.00000000073 * T3
			const timeOfGreatestEclipseCorrection =
				-0.4075 * Math.sin(MM) +
				0.1721 * E * Math.sin(SM) +
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

			if (timeOfGreatestEclipseDay + timeOfGreatestEclipseFraction + timeOfGreatestEclipseCorrection > jd !== next) {
				found = false
				if (next) k++
				else k--
				continue
			}

			eclipse.u = u
			eclipse.gamma = gamma
			eclipse.maximalTime = timeNormalize(timeOfGreatestEclipseDay, timeOfGreatestEclipseFraction + timeOfGreatestEclipseCorrection, 0, Timescale.TT)
			eclipse.lunation = k

			// non-central eclipse
			if (absG >= 0.9972) {
				eclipse.type = 'PARTIAL'
				eclipse.magnitude = (1.5433 + u - absG) / (0.5461 + 2 * u)
			}
			// central eclipse
			else if (u < 0) {
				eclipse.type = 'TOTAL'
			} else if (u > 0.0047) {
				eclipse.type = 'ANNULAR'
			} else if (u < 0.00464 * Math.sqrt(1 - gamma * gamma)) {
				eclipse.type = 'HYBRID'
			} else {
				eclipse.type = 'ANNULAR'
			}
		} else if (next) {
			k++
		} else {
			k--
		}
	}

	return eclipse
}
