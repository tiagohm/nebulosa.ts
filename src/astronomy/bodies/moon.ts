import { ASEC2RAD, AU_KM, DAYSPERJY, DEG2RAD, EARTH_RADIUS_KM, J2000, MOON_SYNODIC_DAYS, PI } from '../../core/constants'
import { type Angle, arcsec, deg } from '../../math/units/angle'
import { type Distance, kilometer } from '../../math/units/distance'
import { type Time, Timescale, time, timeNormalize, timeShift, toJulianDay, tt } from '../time/time'

// Lunar almanac helpers from Meeus' "Astronomical Algorithms": Moon parallax and semi-diameter,
// lunation numbering across calendar systems, Saros number, nearest lunar phase, nearest lunar
// eclipse with full contact circumstances, and nearest perigee/apogee with parallax-derived
// distance. Distances are AU (or km internally), angles radians, and all derived times are TT.

// Classification of a lunar eclipse by how deeply the Moon enters Earth's shadow.
export type LunarEclipseType = 'TOTAL' | 'PARTIAL' | 'PENUMBRAL'

// Lunation-numbering convention; each shifts Meeus' index k by a constant offset.
export type LunationSystem = 'BROWN' | 'MEEUS' | 'GOLDSTINE' | 'HEBREW' | 'ISLAMIC' | 'THAI'

// The four principal lunar phases.
export type LunarPhase = 'NEW' | 'FIRST_QUARTER' | 'FULL' | 'LAST_QUARTER'

// The two lunar apsides (closest/farthest points of the Moon's orbit).
export type LunarApsis = 'PERIGEE' | 'APOGEE'

export type LunarDeclination = 'NORTH' | 'SOUTH'

// Classification of a lunar standstill by the amplitude of the Moon's monthly declination extremes over the
// 18.6-year nodal cycle: a major standstill is the phase of largest monthly maxima (~28.6 deg), a minor
// standstill the phase of smallest ones (~18.3 deg).
export type LunarStandstill = 'MAJOR' | 'MINOR'

// Circumstances of a lunar eclipse, including the standard contact instants (all in TT).
export interface LunarEclipse {
	// Meeus lunation index of the eclipse full moon.
	lunation: number
	// Geometric type of the eclipse.
	type: LunarEclipseType
	// Instant of maximal eclipse.
	maximalTime: Time
	// First contact with the penumbra (P1).
	firstContactPenumbraTime: Time
	// First contact with the umbra (U1); unset when there is no umbral phase.
	firstContactUmbraTime: Time
	// Beginning of totality (U2); unset unless total.
	totalBeginTime: Time
	// End of totality (U3); unset unless total.
	totalEndTime: Time
	// Last contact with the umbra (U4); unset when there is no umbral phase.
	lastContactUmbraTime: Time
	// Last contact with the penumbra (P4).
	lastContactPenumbraTime: Time
	// Eclipse magnitude (umbral if positive type, else penumbral); dimensionless.
	magnitude: number
	// Radius of umbra, in equatorial Earth radii, at eclipse plane.
	sigma: number
	// Least distance from the center of the Moon to the axis of the Earth shadow,
	// in units of equatorial radius of the Earth.
	gamma: number
	// Radius of penumbra, in equatorial Earth radii, at eclipse plane.
	rho: number
	// Radius of the Earth umbral cone in the eclipse plane,
	// in units of equatorial radius of the Earth.
	u: number
	p: number
	sdPartial: number // Fraction of day
	sdTotal: number // Fraction of day
	sdPenumbra: number // Fraction of day
}

// Sentinel TT instant used to initialize the LunarEclipse contact times.
const DEFAULT_MINIMAL_LUNAR_ECLIPSE_TIME = time(0, 0, Timescale.TT)
// |gamma| boundary (Earth radii) for an umbral (partial/total) eclipse versus penumbral-only.
const LUNAR_ECLIPSE_UMBRA_LIMIT = 1.0128
// |gamma| boundary (Earth radii) beyond which not even the penumbra is touched: no eclipse.
const LUNAR_ECLIPSE_PENUMBRA_LIMIT = 1.5573
// Half-width of the shadow magnitude scale (Earth radii); divides the gamma margin into magnitude.
const LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR = 0.545

// Computes the parallax of the Moon at a given distance
export function moonParallax(distance: Distance) {
	return Math.asin(EARTH_RADIUS_KM / AU_KM / distance)
}

// Computes the semi-diameter of the Moon at a given distance
export function moonSemidiameter(distance: Distance) {
	return ((358473400 / AU_KM) * ASEC2RAD) / distance
}

// Computes the angular width of the illuminated lunar crescent (radians): the span
// from the bright limb to the terminator across the disk along the line through both
// cusps' midpoint, width = diameter * k = 2 * semidiameter * k. `semidiameter` is the
// Moon's angular radius (radians) and `illuminatedFraction` k is in [0, 1] (e.g. from
// Meeus' illuminated()). First-order geometric estimate, most accurate for the thin
// crescent near new moon.
export function crescentWidth(semidiameter: Angle, illuminatedFraction: number) {
	return 2 * semidiameter * illuminatedFraction
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

// Converts a Time to the fractional Julian year used to seed Meeus' k indices.
function timeToMeeusApproxYear(time: Time) {
	return 2000 + (time.day - J2000 + time.fraction) / DAYSPERJY
}

// Computes the nearest (previous or next) lunar phase for a given time
export function nearestLunarPhase(time: Time, phase: LunarPhase, next: boolean): Time {
	time = tt(time)
	const jd = toJulianDay(time)

	const year = timeToMeeusApproxYear(time)
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
		const E2 = E * E
		const sinSM = Math.sin(SM)
		const cosSM = Math.cos(SM)
		const sin2SM = Math.sin(2 * SM)
		const sin3SM = Math.sin(3 * SM)
		const sinMM = Math.sin(MM)
		const cosMM = Math.cos(MM)
		const sin2MM = Math.sin(2 * MM)
		const sin3MM = Math.sin(3 * MM)
		const sin4MM = Math.sin(4 * MM)
		const twoF = 2 * F
		const sin2F = Math.sin(twoF)
		const cos2F = Math.cos(twoF)
		const mmPlusSm = MM + SM
		const mmMinusSm = MM - SM
		const sinMMPlusSM = Math.sin(mmPlusSm)
		const sinMMMinusSM = Math.sin(mmMinusSm)
		const cosMMPlusSM = Math.cos(mmPlusSm)
		const cosMMMinusSM = Math.cos(mmMinusSm)
		const mmMinus2F = MM - twoF
		const mmPlus2F = MM + twoF
		const sinMMMinus2F = Math.sin(mmMinus2F)
		const sinMMPlus2F = Math.sin(mmPlus2F)
		const smPlus2F = SM + twoF
		const smMinus2F = SM - twoF
		const sinSMPlus2F = Math.sin(smPlus2F)
		const sinSMMinus2F = Math.sin(smMinus2F)
		const sinMMPlus2SM = Math.sin(MM + 2 * SM)
		const sin2MMMinus2F = Math.sin(2 * MM - twoF)
		const sinMMPlusSMMinus2F = Math.sin(mmPlusSm - twoF)
		const sin2MMPlus2F = Math.sin(2 * MM + twoF)
		const sinMMPlusSMPlus2F = Math.sin(mmPlusSm + twoF)
		const sinMMMinusSMPlus2F = Math.sin(mmMinusSm + twoF)
		const sinMMMinusSMMinus2F = Math.sin(mmMinusSm - twoF)
		const sin3MMPlusSM = Math.sin(3 * MM + SM)
		const sin2MMPlusSM = Math.sin(2 * MM + SM)
		const sin2MMMinusSM = Math.sin(2 * MM - SM)
		const sinMMMinus2SM = Math.sin(MM - 2 * SM)

		let addition = 0

		if (phase === 'NEW') {
			addition =
				-0.4072 * sinMM +
				0.17241 * E * sinSM +
				0.01608 * sin2MM +
				0.01039 * sin2F +
				0.00739 * E * sinMMMinusSM -
				0.00514 * E * sinMMPlusSM +
				0.00208 * E2 * sin2SM -
				0.00111 * sinMMMinus2F -
				0.00057 * sinMMPlus2F +
				0.00056 * E * sin2MMPlusSM -
				0.00042 * sin3MM +
				0.00042 * E * sinSMPlus2F +
				0.00038 * E * sinSMMinus2F -
				0.00024 * E * sin2MMMinusSM -
				0.00017 * Math.sin(omega) -
				0.00007 * sinMMPlus2SM +
				0.00004 * sin2MMMinus2F +
				0.00004 * sin3SM +
				0.00003 * sinMMPlusSMMinus2F +
				0.00003 * sin2MMPlus2F -
				0.00003 * sinMMPlusSMPlus2F +
				0.00003 * sinMMMinusSMPlus2F -
				0.00002 * sinMMMinusSMMinus2F -
				0.00002 * sin3MMPlusSM +
				0.00002 * sin4MM
		} else if (phase === 'FULL') {
			addition =
				-0.40614 * sinMM +
				0.17302 * E * sinSM +
				0.01614 * sin2MM +
				0.01043 * sin2F +
				0.00734 * E * sinMMMinusSM -
				0.00515 * E * sinMMPlusSM +
				0.00209 * E2 * sin2SM -
				0.00111 * sinMMMinus2F -
				0.00057 * sinMMPlus2F +
				0.00056 * E * sin2MMPlusSM -
				0.00042 * sin3MM +
				0.00042 * E * sinSMPlus2F +
				0.00038 * E * sinSMMinus2F -
				0.00024 * E * sin2MMMinusSM -
				0.00017 * Math.sin(omega) -
				0.00007 * sinMMPlus2SM +
				0.00004 * sin2MMMinus2F +
				0.00004 * sin3SM +
				0.00003 * sinMMPlusSMMinus2F +
				0.00003 * sin2MMPlus2F -
				0.00003 * sinMMPlusSMPlus2F +
				0.00003 * sinMMMinusSMPlus2F -
				0.00002 * sinMMMinusSMMinus2F -
				0.00002 * sin3MMPlusSM +
				0.00002 * sin4MM
		} else {
			addition =
				-0.62801 * sinMM +
				0.17172 * E * sinSM -
				0.01183 * E * sinMMPlusSM +
				0.00862 * sin2MM +
				0.00804 * sin2F +
				0.00454 * E * sinMMMinusSM +
				0.00204 * E2 * sin2SM -
				0.0018 * sinMMMinus2F -
				0.0007 * sinMMPlus2F -
				0.0004 * sin3MM -
				0.00034 * E * sin2MMMinusSM +
				0.00032 * E * sinSMPlus2F +
				0.00032 * E * sinSMMinus2F -
				0.00028 * E2 * sinMMPlus2SM +
				0.00027 * E * sin2MMPlusSM -
				0.00017 * Math.sin(omega) -
				0.00005 * sinMMMinusSMMinus2F +
				0.00004 * sin2MMPlus2F -
				0.00004 * sinMMPlusSMPlus2F +
				0.00004 * sinMMMinus2SM +
				0.00003 * sinMMPlusSMMinus2F +
				0.00003 * sin3SM +
				0.00002 * sin2MMMinus2F +
				0.00002 * sinMMMinusSMPlus2F -
				0.00002 * sin3MMPlusSM

			const W = 0.00306 - 0.00038 * E * cosSM + 0.00026 * cosMM - 0.00002 * cosMMMinusSM + 0.00002 * cosMMPlusSM + 0.00002 * cos2F

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
		p: 0,
		sdTotal: 0,
		sdPartial: 0,
		sdPenumbra: 0,
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
			const rho = 1.2848 + u
			const sigma = 0.7403 - u
			const absGamma = Math.abs(gamma)
			let mag = (LUNAR_ECLIPSE_UMBRA_LIMIT - u - absGamma) / LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR

			const timeOfGreatestEclipseDay = 2451550 + 29 * k
			const timeOfGreatestEclipseFraction = 0.530588861 * k + 0.09766 + 0.00015437 * T - 0.00000015 * T2 + 0.00000000073 * T3
			const timeOfGreatestEclipseCorrection =
				-0.4065 * sinMM +
				0.1727 * E * sinSM +
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

			if (mag >= 1) {
				eclipse.type = 'TOTAL'
			} else if (mag > 0) {
				eclipse.type = 'PARTIAL'
			}

			// Check if elipse is penumbral only
			else {
				eclipse.type = 'PENUMBRAL'
				mag = (LUNAR_ECLIPSE_PENUMBRA_LIMIT + u - absGamma) / LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR
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

				const p = LUNAR_ECLIPSE_UMBRA_LIMIT - u
				const t = 0.4678 - u
				const n = 1 / (24 * (0.5458 + 0.04 * Math.cos(MM)))
				const h = LUNAR_ECLIPSE_PENUMBRA_LIMIT + u
				const g2 = gamma * gamma

				eclipse.p = p

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
				eclipse.sdPartial = sdPartial
				eclipse.sdTotal = sdTotal
				eclipse.sdPenumbra = sdPenumbra

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

// Computes the nearest (previous or next) lunar perigee or apogee for a given time.
// Returns the instant (TT), the geocentric Earth-Moon distance (AU), and the Moon's
// apparent diameter (radians) at that apsis.
export function nearestLunarApsis(time: Time, apsis: LunarApsis, next: boolean): readonly [Time, Distance, Angle] {
	time = tt(time)
	const jd = toJulianDay(time)
	const year = timeToMeeusApproxYear(time)
	let k = Math.floor((year - 1999.97) * 13.2555)
	if (apsis === 'APOGEE') k += 0.5

	let jdDay = 0
	let jdFraction = 0
	let parallax = 0

	while (true) {
		const T = k / 1325.55
		const T2 = T * T
		const T3 = T2 * T
		const T4 = T3 * T

		jdDay = 2451534 + 27 * k
		jdFraction = 0.6698 + 0.55454989 * k - 0.0006691 * T2 - 0.000001098 * T3 + 0.0000000052 * T4
		const D = deg(171.9179 + 335.9106046 * k - 0.0100383 * T2 - 0.00001156 * T3 + 0.000000055 * T4)
		const M = deg(347.3477 + 27.1577721 * k - 0.000813 * T2 - 0.000001 * T3)
		const F = deg(316.6109 + 364.5287911 * k - 0.0125053 * T2 - 0.0000148 * T3)

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
		} else {
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
		}

		if (jdDay + jdFraction > jd !== next) {
			if (next) k++
			else k--
		} else {
			if (apsis === 'PERIGEE') {
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
			} else {
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

			break
		}
	}

	const distance = kilometer(EARTH_RADIUS_KM / Math.sin(arcsec(parallax)))
	const diameter = 2 * moonSemidiameter(distance)

	return [timeNormalize(jdDay, jdFraction, 0, Timescale.TT), distance, diameter]
}

// Finds the instant of the nearest maximal declination (northern or southern) of the Moon, searching
// forward (`next` = true) or backward (`next` = false) from `time`. Implements Meeus' "Astronomical
// Algorithms" Chapter 52.
//
// Returns the instant (TT) and the Moon's geocentric declination at that extremum (radians): positive at a
// northern maximum, negative at a southern one (the Moon's most southerly declination). The declination is
// the mean geocentric value of the truncated series (a few arcminutes accurate); nutation and the observer's
// topocentric parallax are not applied. Northern and southern maxima alternate about every 13.66 days, and
// their amplitude swings between ~18.3 deg and ~28.6 deg over the 18.6-year nodal cycle.
//
// The southern series reuses the northern periodic coefficients with the argument of latitude F shifted by
// 180 deg: this is Meeus' southern table, which is the northern one with the signs of the odd-F terms
// reversed. `k` is iterated from the seed year until the passage lands on the requested side of `time`.
export function nearestMaxDeclination(time: Time, declination: LunarDeclination, next: boolean): readonly [Time, Angle] {
	time = tt(time)
	const jd = toJulianDay(time)
	const year = timeToMeeusApproxYear(time)
	const isNorthern = declination === 'NORTH'
	let k = Math.floor((year - 2000.03) * 13.3686)

	let jdDay = 0
	let jdFraction = 0
	let delta = 0

	while (true) {
		const T = k / 1336.86
		const T2 = T * T
		const T3 = T2 * T

		const D = deg((isNorthern ? 152.2029 : 345.6676) + 333.0705546 * k - 0.0004214 * T2 + 0.00000011 * T3)
		const M = deg((isNorthern ? 14.8591 : 1.3951) + 26.9281592 * k - 0.00003555 * T2 - 0.0000001 * T3)
		const M_ = deg((isNorthern ? 4.6881 : 186.21) + 356.9562794 * k + 0.0103066 * T2 + 0.00001251 * T3)
		// Argument of latitude; the southern series shifts it by 180 deg to flip the odd-F terms' signs.
		const F = deg((isNorthern ? 325.8867 : 145.1633) + 1.4467807 * k - 0.002069 * T2 - 0.00000215 * T3) + (isNorthern ? 0 : PI)
		// Multiplier related to the eccentricity of the Earth orbit.
		const E = 1 - 0.002516 * T - 0.0000047 * T2

		jdDay = (isNorthern ? 2451562 : 2451548) + 27 * k
		jdFraction = (isNorthern ? 0.5897 : 0.9289) + 0.321582247 * k + 0.000119804 * T2 - 0.000000141 * T3
		jdFraction +=
			0.8975 * Math.cos(F) +
			-0.4726 * Math.sin(M_) +
			-0.103 * Math.sin(2 * F) +
			-0.0976 * Math.sin(2 * D - M_) +
			-0.0462 * Math.cos(M_ - F) +
			-0.0461 * Math.cos(M_ + F) +
			-0.0438 * Math.sin(2 * D) +
			0.0162 * E * Math.sin(M) +
			-0.0157 * Math.cos(3 * F) +
			0.0145 * Math.sin(M_ + 2 * F) +
			0.0136 * Math.cos(2 * D - F) +
			-0.0095 * Math.cos(2 * D - M_ - F) +
			-0.0091 * Math.cos(2 * D - M_ + F) +
			-0.0089 * Math.cos(2 * D + F) +
			0.0075 * Math.sin(2 * M_) +
			-0.0068 * Math.sin(M_ - 2 * F) +
			0.0061 * Math.cos(2 * M_ - F) +
			-0.0047 * Math.sin(M_ + 3 * F) +
			-0.0043 * E * Math.sin(2 * D - M - M_) +
			-0.004 * Math.cos(M_ - 2 * F) +
			-0.0037 * Math.sin(2 * D - 2 * M_) +
			0.0031 * Math.sin(F) +
			0.003 * Math.sin(2 * D + M_) +
			-0.0029 * Math.cos(M_ + 2 * F) +
			-0.0029 * E * Math.sin(2 * D - M) +
			-0.0027 * Math.sin(M_ + F) +
			0.0024 * E * Math.sin(M - M_) +
			-0.0021 * Math.sin(M_ - 3 * F) +
			0.0019 * Math.sin(2 * M_ + F) +
			0.0018 * Math.cos(2 * D - 2 * M_ - F) +
			0.0018 * Math.sin(3 * F) +
			0.0017 * Math.cos(M_ + 3 * F) +
			0.0017 * Math.cos(2 * M_) +
			-0.0014 * Math.cos(2 * D - M_) +
			0.0013 * Math.cos(2 * D + M_ + F) +
			0.0013 * Math.cos(M_) +
			0.0012 * Math.sin(3 * M_ + F) +
			0.0011 * Math.sin(2 * D - M_ + F) +
			-0.0011 * Math.cos(2 * D - 2 * M_) +
			0.001 * Math.cos(D + F) +
			0.001 * E * Math.sin(M + M_) +
			-0.0009 * Math.sin(2 * D - 2 * F) +
			0.0007 * Math.cos(2 * M_ + F) +
			-0.0007 * Math.cos(3 * M_ + F)

		if (jdDay + jdFraction > jd !== next) {
			if (next) k++
			else k--
		} else {
			delta = 23.6961 - 0.013004 * T
			delta +=
				5.1093 * Math.sin(F) +
				0.2658 * Math.cos(2 * F) +
				0.1448 * Math.sin(2 * D - F) +
				-0.0322 * Math.sin(3 * F) +
				0.0133 * Math.cos(2 * D - 2 * F) +
				0.0125 * Math.cos(2 * D) +
				-0.0124 * Math.sin(M_ - F) +
				-0.0101 * Math.sin(M_ + 2 * F) +
				0.0097 * Math.cos(F) +
				-0.0087 * E * Math.sin(2 * D + M - F) +
				0.0074 * Math.sin(M_ + 3 * F) +
				0.0067 * Math.sin(D + F) +
				0.0063 * Math.sin(M_ - 2 * F) +
				0.006 * E * Math.sin(2 * D - M - F) +
				-0.0057 * Math.sin(2 * D - M_ - F) +
				-0.0056 * Math.cos(M_ + F) +
				0.0052 * Math.cos(M_ + 2 * F) +
				0.0041 * Math.cos(2 * M_ + F) +
				-0.004 * Math.cos(M_ - 3 * F) +
				0.0038 * Math.cos(2 * M_ - F) +
				-0.0034 * Math.cos(M_ - 2 * F) +
				-0.0029 * Math.sin(2 * M_) +
				0.0029 * Math.sin(3 * M_ + F) +
				-0.0028 * E * Math.cos(2 * D + M - F) +
				-0.0028 * Math.cos(M_ - F) +
				-0.0023 * Math.cos(3 * F) +
				-0.0021 * Math.sin(2 * D + F) +
				0.0019 * Math.cos(M_ + 3 * F) +
				0.0018 * Math.cos(D + F) +
				0.0017 * Math.sin(2 * M_ - F) +
				0.0015 * Math.cos(3 * M_ + F) +
				0.0014 * Math.cos(2 * D + 2 * M_ + F) +
				-0.0012 * Math.sin(2 * D - 2 * M_ - F) +
				-0.0012 * Math.cos(2 * M_) +
				-0.001 * Math.cos(M_) +
				-0.001 * Math.sin(2 * F) +
				0.0006 * Math.sin(M_ + F)

			break
		}
	}

	// Southern maxima are the Moon's most southerly declination, reported as a negative angle.
	return [timeNormalize(jdDay, jdFraction, 0, Timescale.TT), deg(isNorthern ? delta : -delta)] as const
}

// Nodal regression period of the Moon's orbit, days (~18.61 years): the interval between successive major
// (or minor) standstills.
const NODAL_PERIOD_DAYS = 6798.383

// Mean regression rate of the ascending node, degrees per day (1934.1362891 deg/century divided by 36525):
// the node longitude decreases at this rate, used to place the node crossing that anchors a standstill season.
const NODE_RATE_DEG_PER_DAY = 1934.1362891 / 36525

// Days used to hop just past a monthly declination maximum before searching for the following one of the same
// hemisphere. Consecutive same-hemisphere maxima are one draconic month (~27.3 days) apart, so a few days is
// enough to clear the current extremum without skipping the next.
const MAX_DECLINATION_STEP_DAYS = 5

// Half-width, in days, of the search window centered on the node crossing. Wider than half the ~206-day
// semiannual modulation of the monthly declination extremes (~103 days), so the window always contains the
// cycle's extreme monthly maximum, yet far shorter than the nodal period so it never reaches the neighboring
// standstill.
const STANDSTILL_WINDOW_DAYS = 150

// Mean longitude of the Moon's ascending node (Meeus 47.7), degrees reduced to [0, 360), from Julian centuries
// T (TT) since J2000. Used only to locate the standstill season (its node crossing), so the leading terms
// suffice; not accurate enough for a precise node position.
function meanAscendingNode(T: number): number {
	const T2 = T * T
	const T3 = T2 * T
	const T4 = T3 * T
	const omega = 125.0445479 - 1934.1362891 * T + 0.0020754 * T2 + T3 / 467441 - T4 / 60616000
	return ((omega % 360) + 360) % 360
}

// Finds the extreme monthly maximum declination of one hemisphere within +/- STANDSTILL_WINDOW_DAYS of
// `center`, walking the same-hemisphere monthly maxima and keeping the largest |declination| (`major` = true,
// a major standstill) or the smallest (`major` = false, a minor standstill). Returns the instant (TT) and
// signed declination (radians). Because the window brackets the extreme of the slow nodal envelope, the picked
// value is the cycle's true extreme despite the superimposed semiannual wobble.
function extremeMonthlyMaximum(center: Time, declination: LunarDeclination, major: boolean): readonly [Time, Angle] {
	const stop = toJulianDay(timeShift(center, STANDSTILL_WINDOW_DAYS))
	let cursor = nearestMaxDeclination(timeShift(center, -STANDSTILL_WINDOW_DAYS), declination, true)
	let best = cursor

	while (toJulianDay(cursor[0]) <= stop) {
		if (major ? Math.abs(cursor[1]) > Math.abs(best[1]) : Math.abs(cursor[1]) < Math.abs(best[1])) best = cursor
		cursor = nearestMaxDeclination(timeShift(cursor[0], MAX_DECLINATION_STEP_DAYS), declination, true)
	}

	return best
}

// Finds the nearest (previous or next) major or minor lunar standstill for one hemisphere, searching forward
// (`next` = true) or backward (`next` = false) from `time`.
//
// A standstill is the extreme of the ~18.6-year envelope of the Moon's monthly declination extremes: at a
// major standstill the monthly maxima reach their largest amplitude (~28.6 deg, obliquity plus lunar orbital
// inclination), at a minor standstill their smallest (~18.3 deg, obliquity minus inclination). The season is
// anchored by the ascending node: the major standstill occurs with the node at the vernal equinox (node = 0),
// the minor with the node at the autumnal equinox (node = 180). This locates that node crossing, then returns
// the cycle's extreme same-hemisphere monthly maximum in a window around it -- a robust global extremum rather
// than a local one, since the monthly maxima carry a ~206-day wobble on top of the slow nodal envelope.
//
// Returns the instant (TT) and the signed geocentric declination (radians) at that standstill: positive for
// `declination` = 'NORTH', negative for 'SOUTH'. Northern and southern standstills of the same cycle fall a
// couple of weeks apart, so query each hemisphere separately. Accuracy follows `nearestMaxDeclination` (mean
// geocentric, a few arcminutes; no nutation or topocentric parallax).
export function nearestLunarStandstill(time: Time, standstill: LunarStandstill, declination: LunarDeclination, next: boolean): readonly [Time, Angle] {
	time = tt(time)
	const jd = toJulianDay(time)
	const major = standstill === 'MAJOR'
	// Node longitude that anchors the season: vernal equinox for a major standstill, autumnal for a minor one.
	const target = major ? 0 : 180

	// Signed node offset reduced to (-180, 180]; positive means the node still has to regress (the crossing lies
	// ahead in time) to reach the target.
	const node = meanAscendingNode((jd - 2451545) / 36525)
	const offset = ((((node - target + 180) % 360) + 360) % 360) - 180

	// Node crossing nearest `time`, then the cycle's extreme monthly maximum around it.
	let crossing = timeShift(time, offset / NODE_RATE_DEG_PER_DAY)
	let best = extremeMonthlyMaximum(crossing, declination, major)

	// When the nearest standstill lands on the wrong side of `time` for the requested direction, step one nodal
	// period so `next`/previous select strictly by the standstill instant.
	if (next ? toJulianDay(best[0]) <= jd : toJulianDay(best[0]) >= jd) {
		crossing = timeShift(crossing, next ? NODAL_PERIOD_DAYS : -NODAL_PERIOD_DAYS)
		best = extremeMonthlyMaximum(crossing, declination, major)
	}

	return best
}
