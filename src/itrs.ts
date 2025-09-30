import { ELLIPSOID_PARAMETERS } from './constants'
import type { CartesianCoordinate } from './coordinate'
import { eraGd2Gce } from './erfa'
import type { GeographicPosition } from './location'

// An |xyz| position in the Earth-centered Earth-fixed (ECEF) ITRS frame.
export function itrs(location: GeographicPosition): Readonly<CartesianCoordinate> {
	if (location.itrs) return location.itrs
	const params = ELLIPSOID_PARAMETERS[location.ellipsoid]
	location.itrs = eraGd2Gce(params.radius, params.flattening, location.longitude, location.latitude, location.elevation)
	return location.itrs
}
