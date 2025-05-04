import type { Angle } from './angle'
import { FK5_MATRIX } from './constants'
import type { CartesianCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraS2p } from './erfa'
import { mulMatVec } from './matrix'

// Convert the ICRS spherical coordinate to ICRS cartesian coordinate.
export function icrs(ra: Angle, dec: Angle, distance: Distance = 1): CartesianCoordinate {
	return eraS2p(ra, dec, distance)
}

// Convert the ICRS cartesian coordinate to FK5 cartesian coordinate.
export function icrsToFk5(p: CartesianCoordinate): CartesianCoordinate {
	return mulMatVec(FK5_MATRIX, p)
}
