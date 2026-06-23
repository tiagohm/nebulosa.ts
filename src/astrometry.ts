import { type Angle, normalizeAngle } from './angle'
import { AU_M, DAYSEC, ELLIPSOID_PARAMETERS, PIOVERTWO, SPEED_OF_LIGHT } from './constants'
import type { CartesianCoordinate, EquatorialCoordinate, SphericalCoordinate } from './coordinate'
import type { Distance } from './distance'
import { type EraAstrom, eraApci13, eraApco13, eraApio13, eraAtciqz, eraAticq, eraAtioq, eraAtoiq, eraC2s, eraP2s, eraRefco } from './erfa'
import type { GeographicCoordinate } from './location'
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
export function cirsToObserved(cirs: Vec3 | readonly [Angle, Angle], time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicCoordinate = time.location!, astrom?: EraAstrom): Observed {
	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = location
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
export function observedToCirs(azimuth: Angle, altitude: Angle, time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicCoordinate = time.location!, astrom?: EraAstrom): readonly [Angle, Angle] {
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

export function icrsToObserved(icrs: Vec3 | readonly [Angle, Angle], time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicCoordinate = time.location!, astrom?: EraAstrom): Observed {
	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = location
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

// Computes the apparent (refracted) altitude from the geometric (true) altitude.
// `altitude` is the true altitude in radians; the returned value is the larger,
// apparent altitude, in radians.
//
// Applies exactly the refraction model ERFA uses in the observed-place transform
// (eraAtioq): from the refraction constants A, B (eraRefco) it forms the bounded,
// Newton-corrected deflection
//   dZ = (A + w)*tanZ / (1 + (A + 3w)/cosZ^2),  w = B*tan^2(Z),  Z = true zenith distance
// with cosZ floored at 0.05 (Z <= ~87 deg). The raw A*tanZ + B*tan^3(Z) polynomial
// has a negative cubic term that makes it non-monotonic and unbounded past
// Z ~= 80 deg; this bounded form instead stays finite and well-behaved down to the
// horizon (refraction is capped near the horizon, as in ERFA). Because it shares
// ERFA's model, it is the consistent inverse of observedToCirs/cirsToObserved, so
// pole and altitude round trips do not drift.
//
// Below the horizon (altitude < 0) the model is not applied and the input is
// returned unchanged.
export function refractedAltitude(altitude: Angle, refraction?: RefractionParameters): Angle {
	if (altitude < 0) return altitude

	const pressure = refraction?.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure
	const temperature = refraction?.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature
	const relativeHumidity = refraction?.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity
	const wl = refraction?.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl
	const [refa, refb] = eraRefco(pressure, temperature, relativeHumidity, wl)

	const zd = PIOVERTWO - altitude
	// sin and (floored) cos of the true zenith distance; flooring cos at 0.05 caps
	// the refraction near the horizon exactly as eraAtioq does (Z <= ~87 deg).
	const r = Math.max(1e-6, Math.sin(zd))
	const z = Math.max(0.05, Math.cos(zd))
	const tz = r / z
	const w = refb * tz * tz
	const del = ((refa + w) * tz) / (1 + (refa + 3 * w) / (z * z))
	return altitude + del
}
