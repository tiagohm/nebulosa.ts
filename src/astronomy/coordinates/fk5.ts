import { ONE_KILOPARSEC } from '../../core/constants'
import { matMulVec } from '../../math/linear-algebra/mat3'
import type { MutVec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { type Time, Timescale, timeJulianYear } from '../time/time'
import type { CartesianCoordinate } from './coordinate'
import { eraS2p } from './erfa/erfa'
import { precessionMatrixCapitaine } from './frame'

const J2000 = timeJulianYear(2000, Timescale.TT)

// Convert the FK5 spherical coordinate to FK5 cartesian coordinate.
export function fk5(ra: Angle, dec: Angle, distance: Distance = ONE_KILOPARSEC): CartesianCoordinate {
	return eraS2p(ra, dec, distance)
}

// Precess the FK5 cartesian coordinate from equinox to other.
export function precessFk5(p: CartesianCoordinate, from: Time, to: Time, o?: MutVec3): CartesianCoordinate {
	return matMulVec(precessionMatrixCapitaine(from, to), p, o)
}

// Precess the FK5 cartesian coordinate from given equinox to J2000.
export function precessFk5ToJ2000(p: CartesianCoordinate, equinox: Time, o?: MutVec3): CartesianCoordinate {
	return precessFk5(p, equinox, J2000, o)
}

// Precess the FK5 cartesian coordinate from J2000 to given equinox.
export function precessFk5FromJ2000(p: CartesianCoordinate, equinox: Time, o?: MutVec3): CartesianCoordinate {
	return precessFk5(p, J2000, equinox, o)
}
