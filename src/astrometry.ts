import { type Angle, normalizeAngle } from './angle'
import { AU_M, DAYSEC, PIOVERTWO, SPEED_OF_LIGHT } from './constants'
import type { CartesianCoordinate, SphericalCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraApco13, eraAtioq, eraC2s, eraP2s } from './erfa'
import { ELLIPSOID_PARAMETERS } from './location'
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

export interface Observed {
	readonly azimuth: Angle
	readonly altitude: Angle
	readonly hourAngle: Angle
	readonly declination: Angle
	readonly rightAscension: Angle // CIO-based
	readonly equationOfTheOrigins: Angle // ERA-GST
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
export function cirsToObserved(cirs: Vec3 | readonly [Angle, Angle], time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS): Observed {
	if (!time.location) throw new Error('location is required')

	const a = tt(time)
	const b = ut1(time)
	const { longitude, latitude, elevation, ellipsoid } = time.location!
	const [sp, xp, yp] = pmAngles(time)
	const { radius, flattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	const pressure = refraction === false ? 0 : (refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
	const temperature = refraction === false ? 0 : (refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
	const relativeHumidity = refraction === false ? 0 : (refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
	const wl = refraction === false ? 0 : (refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)

	// First set up the astrometry context for ICRS<->observed
	const [astrom, equationOfTheOrigins] = eraApco13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl, ebpv, ehp, radius, flattening)

	const [ri, di] = cirs.length === 2 ? cirs : eraC2s(...cirs)
	const [azimuth, zenith, hourAngle, declination, rightAscension] = eraAtioq(normalizeAngle(ri), di, astrom)

	return { azimuth, altitude: PIOVERTWO - zenith, hourAngle, declination, rightAscension, equationOfTheOrigins } as const
}
