import { type Angle, normalizeAngle } from './angle'
import { AU_M, DAYSEC, PIOVERTWO, SPEED_OF_LIGHT } from './constants'
import type { CartesianCoordinate, SphericalCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraApcg, eraApci13, eraApco13, eraAtciqpmpx, eraAtioq, eraC2s, eraP2s } from './erfa'
import { ELLIPSOID_PARAMETERS } from './location'
import type { Pressure } from './pressure'
import type { Temperature } from './temperature'
import { pmAngles, type Time, Timescale, tdb, tt, ut1 } from './time'
import { type MutVec3, type Vec3, vecAngle, vecLength, vecMinus, vecNormalize } from './vec3'

export type PositionAndVelocity = [MutVec3, MutVec3]

// Computes the position at time.
export type PositionAndVelocityOverTime = (time: Time) => PositionAndVelocity

export interface RefractionParameters {
	pressure?: Pressure
	temperature?: Temperature
	relativeHumidity?: number
	wl?: number
}

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

// TODO: Use era or vsop87 to compute Earth barycentric and heliocentric position. Make the parameter optional.
export function gcrs(icrs: CartesianCoordinate, time: Time, ebpv: readonly [Vec3, Vec3], ehp?: CartesianCoordinate): CartesianCoordinate {
	const t = time.scale === Timescale.TDB ? time : tt(time)
	// TODO: Pass observer position and velocity?
	const astrom = eraApcg(t.day, t.fraction, ebpv, ehp ?? ebpv[0])

	// When there is a distance, we first offset for parallax to get the
	// astrometric coordinate direction and then run the ERFA transform for
	// no parallax/PM. This ensures reversibility and is more sensible for
	// inside solar system objects.
	const nc = vecMinus(icrs, astrom.eb)

	return eraAtciqpmpx(vecNormalize(nc, nc), astrom, nc)
}

// TODO: Use era or vsop87 to compute Earth barycentric and heliocentric position. Make the parameter optional.
export function cirs(icrs: CartesianCoordinate, time: Time, ebpv: readonly [Vec3, Vec3], ehp?: Vec3) {
	const t = tdb(time)
	// TODO: Pass observer position and velocity?
	const [astrom] = eraApci13(t.day, t.fraction, ebpv, ehp ?? ebpv[0])

	// When there is a distance, we first offset for parallax to get the
	// astrometric coordinate direction and then run the ERFA transform for
	// no parallax/PM. This ensures reversibility and is more sensible for
	// inside solar system objects.
	const nc = vecMinus(icrs, astrom.eb)

	return eraAtciqpmpx(vecNormalize(nc, nc), astrom, nc)
}

function observed(icrs: Vec3, time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], refraction?: RefractionParameters | false) {
	if (!time.location) return undefined

	const a = tt(time)
	const b = ut1(time)
	const { longitude, latitude, elevation, ellipsoid } = time.location
	const [sp, xp, yp] = pmAngles(time)
	const { radius, flattening } = ELLIPSOID_PARAMETERS[ellipsoid]

	// First set up the astrometry context for ICRS<->observed
	const pressure = refraction === false ? 0 : (refraction?.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
	const temperature = refraction === false ? 0 : (refraction?.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
	const relativeHumidity = refraction === false ? 0 : (refraction?.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
	const wl = refraction === false ? 0 : (refraction?.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)
	const [astrom] = eraApco13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl, ebpv, ehp, radius, flattening)
	// Correct for parallax to find BCRS direction from observer (as in erfa.pmpx)
	const nc = vecMinus(icrs, astrom.eb)
	// Convert to topocentric CIRS
	const [ri, di] = eraC2s(...eraAtciqpmpx(vecNormalize(nc, nc), astrom, nc))
	// Now perform observed conversion
	return eraAtioq(normalizeAngle(ri), di, astrom)
}

// https://en.wikipedia.org/wiki/Standard_temperature_and_pressure

export function hadec(icrs: Vec3, time: Time, ebpv: readonly [Vec3, Vec3], ehp?: Vec3, refraction?: RefractionParameters | false) {
	const r = observed(icrs, time, ebpv, ehp, refraction)
	if (!r) return r
	return [r[2], r[3]] as const
}

export function altaz(icrs: Vec3, time: Time, ebpv: readonly [Vec3, Vec3], ehp?: Vec3, refraction?: RefractionParameters | false) {
	const r = observed(icrs, time, ebpv, ehp, refraction)
	if (!r) return r
	return [r[0], PIOVERTWO - r[1]] as const
}
