import { ONE_KILOPARSEC } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { CartesianCoordinate } from './coordinate'
import { eraS2p } from './erfa/erfa'

// Convert the ICRS spherical coordinate to ICRS cartesian coordinate.
export function icrs(ra: Angle, dec: Angle, distance: Distance = ONE_KILOPARSEC): CartesianCoordinate {
	return eraS2p(ra, dec, distance)
}
