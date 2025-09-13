import { type Angle, normalizeAngle } from './angle'
import { AU_M, DAYSEC, PI, PIOVERTWO, SPEED_OF_LIGHT, TAU } from './constants'
import type { CartesianCoordinate, SphericalCoordinate } from './coordinate'
import type { Distance } from './distance'
import { type EraAstrom, eraApio13, eraAtioq, eraAtoiq, eraC2s, eraP2s } from './erfa'
import type { Pressure } from './pressure'
import type { Temperature } from './temperature'
import { pmAngles, type Time, tt, ut1 } from './time'
import { type MutVec3, type Vec3, vecAngle, vecLength } from './vec3'

export type PositionAndVelocity = [MutVec3, MutVec3]

// Computes the position at time.
export type PositionAndVelocityOverTime = (time: Time) => PositionAndVelocity

export interface RefractionParameters {
	pressure?: Pressure
	temperature?: Temperature
	relativeHumidity?: number
	wl?: number
}

// https://en.wikipedia.org/wiki/Standard_temperature_and_pressure
export const DEFAULT_REFRACTION_PARAMETERS: Readonly<Required<RefractionParameters>> = {
	pressure: 1013.25,
	temperature: 15,
	relativeHumidity: 0.5,
	wl: 0.55,
}

// Length of position component in AU.
export function distance(p: CartesianCoordinate): Distance {
	return vecLength(p)
}

// Length of position component in days of light travel time.
export function lightTime(p: CartesianCoordinate) {
	return distance(p) * (AU_M / SPEED_OF_LIGHT / DAYSEC)
}

// Computes the equatorial coordinates.
export function equatorial(p: CartesianCoordinate): SphericalCoordinate {
	return eraP2s(...p)
}

// Computes the deviation between zenith angle and north angle.
export function parallacticAngle(ha: Angle, dec: Angle, latitude: Angle): Angle {
	// A rare condition! Object exactly in zenith, avoid undefined result.
	return ha === 0 && dec - latitude === 0 ? 0 : Math.atan2(Math.sin(ha), Math.tan(latitude) * Math.cos(dec) - Math.sin(dec) * Math.cos(ha))
}

// Computes the angle between two positions.
export function separationFrom(a: CartesianCoordinate, b: CartesianCoordinate): Angle {
	return vecAngle(a, b)
}

// Computes observed coordinates from CIRS cartesian/spherical coordinates.
export function cirsToObserved(cirs: Vec3 | readonly [Angle, Angle], time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, astrom?: EraAstrom) {
	if (!time.location) throw new Error('location is required')

	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = time.location!
		const [sp, xp, yp] = pmAngles(time)
		const pressure = refraction === false ? 0 : (refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
		const temperature = refraction === false ? 0 : (refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
		const relativeHumidity = refraction === false ? 0 : (refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
		const wl = refraction === false ? 0 : (refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)

		// First set up the astrometry context for ICRS<->observed
		astrom = eraApio13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl)
	}

	const [ri, di] = cirs.length === 2 ? cirs : eraC2s(...cirs)
	// Return azimuth, altitude, hour angle, right ascension, declination
	const ret = eraAtioq(normalizeAngle(ri), di, astrom)
	;(ret as unknown as number[])[1] = PIOVERTWO - ret[1] // Convert from zenith angle to altitude
	return ret
}

export function observedToCirs(azimuth: Angle, altitude: Angle, time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, astrom?: EraAstrom): readonly [Angle, Angle] {
	if (!time.location) throw new Error('location is required')

	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = time.location!
		const [sp, xp, yp] = pmAngles(time)
		const pressure = refraction === false ? 0 : (refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
		const temperature = refraction === false ? 0 : (refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
		const relativeHumidity = refraction === false ? 0 : (refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
		const wl = refraction === false ? 0 : (refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)

		// First set up the astrometry context for observed<->CIRS
		astrom = eraApio13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl)
	}

	return eraAtoiq('A', azimuth, PIOVERTWO - altitude, astrom)
}

// Converts equatorial coordinates (right ascension and declination) to horizontal coordinates (azimuth and altitude) using just trigonometry (no refraction).
export function equatorialToHorizontal(rightAscension: Angle, declination: Angle, latitude: Angle, lst: Angle): readonly [Angle, Angle] {
	const ha = lst - rightAscension
	const sinDec = Math.sin(declination)
	const cosDec = Math.cos(declination)
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)
	const cosHA = Math.cos(ha)
	const sinHA = Math.sin(ha)
	const sinAlt = sinDec * sinLat + cosDec * cosLat * cosHA
	const altitude = Math.asin(sinAlt)
	// Avoid trigonometric function. Return value of asin is always in [-pi/2, pi/2] and in this domain cosine is always non-negative, so we can use this.
	const cosAlt = Math.sqrt(1 - sinAlt * sinAlt)
	const a = (sinDec - sinLat * sinAlt) / (cosLat * (cosAlt === 0 ? Math.cos(altitude) : cosAlt))
	let azimuth = a <= -1 ? PI : a >= 1 ? 0 : Math.acos(a)
	if (sinHA > 0 && azimuth !== 0) azimuth = TAU - azimuth
	return [azimuth, altitude]
}
