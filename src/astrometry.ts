import { type Angle, arcsec, normalizeAngle } from './angle'
import { AU_M, DAYSEC, ELLIPSOID_PARAMETERS, PI, PIOVERTWO, SPEED_OF_LIGHT, TAU } from './constants'
import type { CartesianCoordinate, EquatorialCoordinate, SphericalCoordinate } from './coordinate'
import type { Distance } from './distance'
import { type EraAstrom, eraApci13, eraApco13, eraApio13, eraAtciqz, eraAticq, eraAtioq, eraAtoiq, eraC2s, eraP2s, eraRefco } from './erfa'
import type { GeographicPosition } from './location'
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

export interface Observed extends Readonly<EquatorialCoordinate> {
	readonly azimuth: Angle
	readonly altitude: Angle
	readonly hourAngle: Angle
	readonly equationOfOrigins: Angle
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

// Computes CIRS coordinates from ICRS cartesian/spherical coordinates (assuming zero parallax and proper motion).
export function icrsToCirs(icrs: Vec3 | readonly [Angle, Angle], time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], astrom?: EraAstrom) {
	const a = tt(time)

	astrom ??= eraApci13(a.day, a.fraction, ebpv, ehp)

	const [rc, dc] = icrs.length === 2 ? icrs : eraC2s(...icrs)
	return eraAtciqz(rc, dc, astrom)
}

// Computes ICRS coordinates from CIRS cartesian/spherical coordinates.
export function cirsToIcrs(cirs: Vec3 | readonly [Angle, Angle], time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], astrom?: EraAstrom) {
	const a = tt(time)

	astrom ??= eraApci13(a.day, a.fraction, ebpv, ehp)

	const [rc, dc] = cirs.length === 2 ? cirs : eraC2s(...cirs)
	return eraAticq(rc, dc, astrom)
}

// Computes observed coordinates from CIRS cartesian/spherical coordinates.
export function cirsToObserved(cirs: Vec3 | readonly [Angle, Angle], time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, astrom?: EraAstrom): Observed {
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

	// Now perform observed conversion
	const [azimuth, zenith, hourAngle, rightAscension, declination] = eraAtioq(normalizeAngle(ri), di, astrom)
	return { azimuth, altitude: PIOVERTWO - zenith, hourAngle, declination, rightAscension, equationOfOrigins: astrom.eo } as const
}

// Computes CIRS coordinates from observed coordinates.
export function observedToCirs(azimuth: Angle, altitude: Angle, time: Time, location: GeographicPosition = time.location!, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, astrom?: EraAstrom): readonly [Angle, Angle] {
	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = location
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

export function icrsToObserved(icrs: Vec3 | readonly [Angle, Angle], time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, astrom?: EraAstrom): Observed {
	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = time.location!
		const [sp, xp, yp] = pmAngles(time)
		const pressure = refraction === false ? 0 : (refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
		const temperature = refraction === false ? 0 : (refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
		const relativeHumidity = refraction === false ? 0 : (refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
		const wl = refraction === false ? 0 : (refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)
		const { radius, flattening } = ELLIPSOID_PARAMETERS[time.location!.ellipsoid]

		// First set up the astrometry context for observed<->CIRS
		astrom = eraApco13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl, ebpv, ehp, radius, flattening)
	}

	// Convert to topocentric CIRS
	const [ri, di] = eraAtciqz(...(icrs.length === 2 ? icrs : eraC2s(...icrs)), astrom)

	// Now perform observed conversion
	const [azimuth, zenith, hourAngle, rightAscension, declination] = eraAtioq(normalizeAngle(ri), di, astrom)
	return { azimuth, altitude: PIOVERTWO - zenith, hourAngle, rightAscension, declination, equationOfOrigins: astrom.eo } as const
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

// https://bitbucket.org/Isbeorn/nina/src/master/NINA.Astrometry/AstroUtil.cs
// Computes the refracted altitude given the true altitude and refraction parameters
export function refractedAltitude(altitude: Angle, refraction: RefractionParameters, iterationIncrementInArcsec = 1, maxIterations = 1000) {
	if (altitude < 0) return altitude

	const pressure = refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure
	const temperature = refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature
	const relativeHumidity = refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity
	const wl = refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl
	const [refa, refb] = eraRefco(pressure, temperature, relativeHumidity, wl)

	const z = PIOVERTWO - altitude
	const increment = arcsec(iterationIncrementInArcsec)
	let roller = increment

	while (maxIterations-- > 0) {
		const refractedZenithDistance = z - roller
		// dZ = A tan Z + B tan^3 Z.
		const dZ = refa * Math.tan(refractedZenithDistance) + refb * Math.tan(refractedZenithDistance) ** 3

		if (Number.isNaN(dZ)) {
			return NaN
		}

		const originalZenithDistance = refractedZenithDistance + dZ

		if (Math.abs(originalZenithDistance - z) < increment) {
			return PIOVERTWO - refractedZenithDistance
		}

		roller += increment
	}

	return NaN
}
