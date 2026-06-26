import { FK5_MATRIX, ONE_KILOPARSEC } from '../../core/constants'
import { matMulVec } from '../../math/linear-algebra/mat3'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { CartesianCoordinate } from './coordinate'
import { eraS2p } from './erfa/erfa'

// Convert the ICRS spherical coordinate to ICRS cartesian coordinate.
export function icrs(ra: Angle, dec: Angle, distance: Distance = ONE_KILOPARSEC): CartesianCoordinate {
	return eraS2p(ra, dec, distance)
}

// Convert the ICRS cartesian coordinate to FK5 cartesian coordinate.
export function icrsToFk5(p: CartesianCoordinate): CartesianCoordinate {
	return matMulVec(FK5_MATRIX, p)
}
