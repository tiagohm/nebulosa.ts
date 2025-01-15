import { normalize, type Angle } from './angle'
import { AU_M, DAYSEC, SPEED_OF_LIGHT } from './constants'
import type { CartesianCoordinate, SphericalCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraP2s } from './erfa'
import { ITRS_FRAME } from './itrs'
import { mulVec } from './matrix'
import { equationOfOrigins, type Time } from './time'
import { angle, length, minus, mulScalar, type Vec3 } from './vector'

export type PositionAndVelocity = readonly [CartesianCoordinate, CartesianCoordinate]

// Computes the position at time.
export type PositionAndVelocityOverTime = (time: Time) => PositionAndVelocity

// Computes the position relative to observer's position at time.
export type ObservedPositionOverTime = (observer: Body, time: Time) => PositionAndVelocity

// Represents a celestial body.
export interface Body {
	readonly at: PositionAndVelocityOverTime
	readonly observedAt: ObservedPositionOverTime
}

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

// Computes the cartesian CIRS coordinates at time.
export function cirs(p: CartesianCoordinate, time: Time): CartesianCoordinate {
	return mulVec(equationOfOrigins(time), p)
}

// Computes the spherical CIRS coordinates at time.
export function sphericalCirs(p: CartesianCoordinate, time: Time): SphericalCoordinate {
	return eraP2s(...cirs(p, time))
}

// Computes the angle between two positions.
export function separationFrom(a: CartesianCoordinate, b: CartesianCoordinate): Angle {
	return angle(a, b)
}

// Apply parallax effect to BCRS cartesian coordinate given observer's barycentric position.
export function parallax(bcrs: CartesianCoordinate, px: Angle, bp: Vec3) {
	const pxbp = mulScalar(bp, px * distance(bcrs))
	return minus(bcrs, pxbp, pxbp)
}
