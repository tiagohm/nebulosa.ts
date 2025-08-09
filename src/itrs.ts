import type { CartesianCoordinate } from './coordinate'
import { eraC2teqx, eraGd2Gce } from './erfa'
import type { Frame } from './frame'
import { ELLIPSOID_PARAMETERS, type GeographicPosition } from './location'
import { greenwichApparentSiderealTime, pmMatrix, precessionNutationMatrix, type Time } from './time'

// An |xyz| position in the Earth-centered Earth-fixed (ECEF) ITRS frame.
export function itrs(location: GeographicPosition): Readonly<CartesianCoordinate> {
	if (location.itrs) return location.itrs

	const params = ELLIPSOID_PARAMETERS[location.ellipsoid]
	location.itrs = eraGd2Gce(params.radius, params.flattening, location.longitude, location.latitude, location.elevation)
	return location.itrs
}

// Computes the ITRS rotation matrix at time.
export function itrsRotationAt(time: Time) {
	return eraC2teqx(precessionNutationMatrix(time), greenwichApparentSiderealTime(time), pmMatrix(time))
}

export const ITRS_FRAME: Frame = {
	rotationAt: itrsRotationAt,
}
