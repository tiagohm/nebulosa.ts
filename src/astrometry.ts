import type { Mutable } from 'utility-types'
import { normalize, type Angle } from './angle'
import { AU_M, DAYSEC, SPEED_OF_LIGHT } from './constants'
import type { CartesianCoordinate, SphericalCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraApcg, eraApci13, eraAtciqpmpx, eraP2s } from './erfa'
import { ITRS_FRAME } from './itrs'
import { mulVec } from './matrix'
import { tdb, Timescale, tt, type Time } from './time'
import { angle, length, minus, normalize as normalizeVec } from './vector'

export type PositionAndVelocity = readonly [CartesianCoordinate, CartesianCoordinate]

// Computes the position at time.
export type PositionAndVelocityOverTime = (time: Time) => PositionAndVelocity

// Length of position component in AU.
export function distance(p: CartesianCoordinate): Distance {
	return length(p)
}

// Length of position component in days of light travel time.
export function lightTime(p: CartesianCoordinate) {
	return distance(p) * (AU_M / SPEED_OF_LIGHT / DAYSEC)
}

// Computes the equatorial coordinates.
export function equatorial(p: CartesianCoordinate): SphericalCoordinate {
	return eraP2s(...p)
}

// Computes the hour angle, declination, and distance at time.
// This only works for positions whose center is a geographic location,
// otherwise, there is no local meridian from which to measure the hour angle.
// Because this declination is measured from the plane of the Earth's physical geographic equator,
// it will be slightly different than the declination returned by equatorial.
// The coordinates are not adjusted for atmospheric refraction near the horizon.
export function hourAngle(p: CartesianCoordinate, time: Time): SphericalCoordinate | undefined {
	if (!time.location) return undefined

	const r = ITRS_FRAME.rotationAt(time)
	const [sublongitude, dec, distance] = mulVec(r, p)
	const ha = normalize(time.location.longitude - sublongitude)

	return [ha, dec, distance]
}

// Computes the deviation between zenith angle and north angle.
export function parallacticAngle(p: CartesianCoordinate, time: Time): Angle | undefined {
	const ha = hourAngle(p, time)

	if (ha) {
		const phi = time.location!.latitude
		// A rare condition! Object exactly in zenith, avoid undefined result.
		return ha[0] === 0 && ha[1] - phi === 0 ? 0 : Math.atan2(Math.sin(ha[0]), Math.tan(phi) * Math.cos(ha[1]) - Math.sin(ha[1]) * Math.cos(ha[0]))
	} else {
		return undefined
	}
}

// Computes the angle between two positions.
export function separationFrom(a: CartesianCoordinate, b: CartesianCoordinate): Angle {
	return angle(a, b)
}

// TODO: Use era or vsop87 to compute Earth barycentric and heliocentric position. Make the parameter optional.
export function gcrs(icrs: CartesianCoordinate, time: Time, ebpv: PositionAndVelocity, ehp?: CartesianCoordinate): CartesianCoordinate {
	const t = time.scale === Timescale.TDB ? time : tt(time)
	// TODO: Pass observer position and velocity?
	const astrom = eraApcg(t.day, t.fraction, ebpv, ehp ?? ebpv[0])

	// When there is a distance, we first offset for parallax to get the
	// astrometric coordinate direction and then run the ERFA transform for
	// no parallax/PM. This ensures reversibility and is more sensible for
	// inside solar system objects.
	const nc = minus(icrs, ebpv[0])

	// const d = length(star[0])
	const g = eraAtciqpmpx(normalizeVec(nc), astrom, nc) as unknown as Mutable<CartesianCoordinate>
	// mulScalar(g, d, g as unknown as MutVec3)
	return g
}

// TODO: Use era or vsop87 to compute Earth barycentric and heliocentric position. Make the parameter optional.
export function cirs(icrs: CartesianCoordinate, time: Time, ebpv: PositionAndVelocity, ehp?: CartesianCoordinate): CartesianCoordinate {
	const t = tdb(time)
	// TODO: Pass observer position and velocity?
	const [astrom] = eraApci13(t.day, t.fraction, ebpv, ehp ?? ebpv[0])

	// When there is a distance, we first offset for parallax to get the
	// astrometric coordinate direction and then run the ERFA transform for
	// no parallax/PM. This ensures reversibility and is more sensible for
	// inside solar system objects.
	const nc = minus(icrs, ebpv[0])

	// const d = length(star[0])
	const g = eraAtciqpmpx(normalizeVec(nc), astrom, nc) as unknown as Mutable<CartesianCoordinate>
	// mulScalar(g, d, g as unknown as MutVec3)
	return g
}
