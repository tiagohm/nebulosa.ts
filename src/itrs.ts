import { ANGVEL } from './angle'
import { DAYSEC } from './constants'
import type { CartesianCoordinate } from './coordinate'
import { eraC2teqx, eraGd2Gce } from './erfa'
import type { Frame } from './frame'
import { xy } from './iers'
import { ELLIPSOID_PARAMETERS, type GeographicPosition } from './location'
import type { MutMat3 } from './matrix'
import { gast, pmMatrix, precessionNutation, type Time } from './time'

export const ANGVEL_PER_DAY = DAYSEC * ANGVEL
export const EARTH_ANGULAR_VELOCITY_VECTOR = [0, 0, ANGVEL_PER_DAY] as const
export const EARTH_ANGULAR_VELOCITY_MATRIX = [0, ANGVEL_PER_DAY, 0, -ANGVEL_PER_DAY, 0, 0, 0, 0, 0] as const

// An |xyz| position in the Earth-centered Earth-fixed (ECEF) ITRS frame.
export function itrs(location: GeographicPosition): Readonly<CartesianCoordinate> {
	if (location.itrs) return location.itrs

	const params = ELLIPSOID_PARAMETERS[location.ellipsoid]
	location.itrs = eraGd2Gce(params.radius, params.flattening, location.longitude, location.latitude, location.elevation)
	return location.itrs
}

// Computes the ITRS rotation matrix at time.
export function rotationAt(time: Time): MutMat3 {
	return eraC2teqx(precessionNutation(time), gast(time), pmMatrix(xy, time))
}

export const ITRS_FRAME: Frame = {
	rotationAt,
}
