import { DEG2RAD, RAD2DEG } from '../../core/constants'
import { type Vec3, vecDot, vecLength } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'

// Apparent visual magnitudes of the planets from the Mallama & Hilton (2018) model, "Computing
// Apparent Planetary Magnitudes for The Astronomical Almanac" (Astronomy and Computing 25, 10). Each
// planet's magnitude is 5*log10(r*delta) plus a per-planet function of the illumination phase angle,
// with extra terms for Saturn's rings and Uranus's polar aspect. The implementation mirrors the
// reference Fortran (Ap_Mag_V3) and the Skyfield port.
//
// Inputs are geometric vectors so the distances and phase angle are computed consistently; angles are
// handled in degrees internally to match the published polynomials. The Mars rotation/season
// correction (+/-0.06 mag) is not modelled, matching the common implementations.

// Planet selector for planetMagnitude.
export enum Planet {
	MERCURY,
	VENUS,
	EARTH,
	MARS,
	JUPITER,
	SATURN,
	URANUS,
	NEPTUNE,
}

// Options for the planets whose magnitude needs more than r, delta and the phase angle.
export interface PlanetMagnitudeOptions {
	// Julian year of the observation, used by Neptune's secular brightness term. Defaults to 2000.
	readonly year?: number
	// Whether to include Saturn's rings in the brightness. Defaults to true.
	readonly rings?: boolean
}

// J2000 ICRF unit north-pole vectors of Saturn and Uranus (from their IAU pole right ascension and
// declination), used to derive the saturnicentric/planetographic sub-solar and sub-Earth latitudes
// that drive the ring and polar-aspect terms. The pole's slow drift has a negligible photometric
// effect, so a fixed direction is used.
const SATURN_POLE: Vec3 = [0.08547883, 0.07323576, 0.99364475]
const URANUS_POLE: Vec3 = [-0.21199958, -0.94155916, -0.26176809]

// Computes the apparent visual magnitude of a planet from the Mallama & Hilton (2018) model.
//
// `sunToPlanet` is the vector from the Sun to the planet and `observerToPlanet` from the observer to
// the planet, both in AU (any consistent frame). The heliocentric distance r, the observer distance
// delta and the phase angle follow from them. Returns the apparent magnitude, or NaN where the model
// is undefined (Saturn with rings beyond a 6.5 deg phase angle, or Neptune beyond 1.9 deg before the
// year 2000).
export function planetMagnitude(planet: Planet, sunToPlanet: Vec3, observerToPlanet: Vec3, options: PlanetMagnitudeOptions = {}): number {
	const r = vecLength(sunToPlanet)
	const delta = vecLength(observerToPlanet)
	const phaseAngle = RAD2DEG * Math.acos(clamp(vecDot(sunToPlanet, observerToPlanet) / (r * delta), -1, 1))

	switch (planet) {
		case Planet.MERCURY:
			return mercuryMagnitude(r, delta, phaseAngle)
		case Planet.VENUS:
			return venusMagnitude(r, delta, phaseAngle)
		case Planet.EARTH:
			return earthMagnitude(r, delta, phaseAngle)
		case Planet.MARS:
			return marsMagnitude(r, delta, phaseAngle)
		case Planet.JUPITER:
			return jupiterMagnitude(r, delta, phaseAngle)
		case Planet.SATURN:
			return saturnMagnitude(r, delta, phaseAngle, subLatitude(SATURN_POLE, sunToPlanet), subLatitude(SATURN_POLE, observerToPlanet), options.rings ?? true)
		case Planet.URANUS:
			return uranusMagnitude(r, delta, phaseAngle, subLatitude(URANUS_POLE, sunToPlanet), subLatitude(URANUS_POLE, observerToPlanet))
		case Planet.NEPTUNE:
			return neptuneMagnitude(r, delta, phaseAngle, options.year ?? 2000)
	}
}

// Sub-point latitude (degrees) of a direction relative to a unit pole: 90 deg minus the angle between
// the pole and the body-to-source direction, i.e. the latitude of the point facing the source.
function subLatitude(pole: Vec3, toBody: Vec3): number {
	const cosAngle = clamp(vecDot(pole, toBody) / vecLength(toBody), -1, 1)
	return RAD2DEG * Math.acos(cosAngle) - 90
}

// Distance modulus 5*log10(r*delta) shared by most of the planet models.
function distanceModulus(r: number, delta: number): number {
	return 5 * Math.log10(r * delta)
}

// Mercury (valid for phase angles 2 deg to 170 deg).
function mercuryMagnitude(r: number, delta: number, phase: number): number {
	const f = 6.328e-2 * phase - 1.6336e-3 * phase ** 2 + 3.3644e-5 * phase ** 3 - 3.4265e-7 * phase ** 4 + 1.6893e-9 * phase ** 5 - 3.0334e-12 * phase ** 6
	return -0.613 + distanceModulus(r, delta) + f
}

// Venus, with separate coefficients below and above a 163.7 deg phase angle.
function venusMagnitude(r: number, delta: number, phase: number): number {
	const low = phase < 163.7
	const a0 = low ? 0 : 236.05828 + 4.384
	const a1 = low ? -1.044e-3 : -2.81914
	const a2 = low ? 3.687e-4 : 8.39034e-3
	const a3 = low ? -2.814e-6 : 0
	const a4 = low ? 8.938e-9 : 0
	const f = (((a4 * phase + a3) * phase + a2) * phase + a1) * phase + a0
	return -4.384 + distanceModulus(r, delta) + f
}

// Earth.
function earthMagnitude(r: number, delta: number, phase: number): number {
	return -3.99 + distanceModulus(r, delta) + (-1.06e-3 * phase + 2.054e-4 * phase ** 2)
}

// Mars, with separate coefficients below and above a 50 deg phase angle. The rotation and orbital
// (season) corrections are not modelled, which can introduce an error up to ~0.06 mag.
function marsMagnitude(r: number, delta: number, phase: number): number {
	const low = phase <= 50
	const a = low ? 2.267e-2 : -0.02573
	const b = low ? -1.302e-4 : 3.445e-4
	const base = low ? -1.601 : -0.367
	return base + distanceModulus(r, delta) + a * phase + b * phase ** 2
}

// Jupiter, with separate coefficients below and above a 12 deg phase angle.
function jupiterMagnitude(r: number, delta: number, phase: number): number {
	if (phase <= 12) {
		return -9.395 + distanceModulus(r, delta) + (6.16e-4 * phase - 3.7e-4) * phase
	}
	const p = phase / 180
	const f = -2.5 * Math.log10(((((-1.876 * p + 2.809) * p - 0.062) * p - 0.363) * p - 1.507) * p + 1)
	return -9.428 + distanceModulus(r, delta) + f
}

// Saturn, including the ring contribution. `sunSubLat` and `earthSubLat` are saturnicentric latitudes
// (degrees) of the Sun and the observer. Returns NaN where the ringed model is undefined (phase angle
// beyond 6.5 deg with the rings included).
function saturnMagnitude(r: number, delta: number, phase: number, sunSubLat: number, earthSubLat: number, rings: boolean): number {
	// Geometric mean of the sub-latitudes, zero when the Sun and the observer face opposite ring faces.
	const product = sunSubLat * earthSubLat
	const subLatGeoc = product >= 0 ? Math.sqrt(product) : 0

	const withinGeocentricBounds = phase <= 6.5 && subLatGeoc <= 27
	const modulus = distanceModulus(r, delta)

	if (withinGeocentricBounds) {
		if (rings) {
			const sinLat = Math.sin(subLatGeoc * DEG2RAD)
			return -8.914 - 1.825 * sinLat + 0.026 * phase - 0.378 * sinLat * Math.exp(-2.25 * phase) + modulus
		}
		return -8.95 - 3.7e-4 * phase + 6.16e-4 * phase ** 2 + modulus
	}

	if (phase > 6.5 && !rings) {
		return -8.94 + 2.446e-4 * phase + 2.672e-4 * phase ** 2 - 1.506e-6 * phase ** 3 + 4.767e-9 * phase ** 4 + modulus
	}

	return Number.NaN
}

// Uranus, with a polar-aspect term from the mean of the absolute sub-solar and sub-Earth planetographic
// latitudes (degrees) and a phase term beyond a 3.1 deg phase angle.
function uranusMagnitude(r: number, delta: number, phase: number, sunSubLat: number, earthSubLat: number): number {
	const subLat = (Math.abs(sunSubLat) + Math.abs(earthSubLat)) / 2
	let mag = -7.11 + distanceModulus(r, delta) - 0.00084 * subLat
	if (phase > 3.1) mag += (1.045e-4 * phase + 6.587e-3) * phase
	return mag
}

// Neptune. `year` is the Julian year; the unit-distance brightness fades secularly and the phase term
// (beyond 1.9 deg) is only defined from the year 2000 onward, returning NaN before then.
function neptuneMagnitude(r: number, delta: number, phase: number, year: number): number {
	let mag = clamp(-6.89 - 0.0054 * (year - 1980), -7, -6.89) + distanceModulus(r, delta)
	if (phase > 1.9) {
		if (year < 2000) return Number.NaN
		mag += 7.944e-3 * phase + 9.617e-5 * phase ** 2
	}
	return mag
}
