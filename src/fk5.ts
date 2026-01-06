import type { Angle } from './angle'
import { FK5_MATRIX, ONE_KILOPARSEC } from './constants'
import type { CartesianCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraS2p } from './erfa'
import { precessionMatrixCapitaine } from './frame'
import { matMulVec, matTransposeMulVec } from './mat3'
import { type Time, Timescale, timeJulianYear } from './time'
import type { MutVec3 } from './vec3'

const J2000 = timeJulianYear(2000, Timescale.TT)

// Convert the FK5 spherical coordinate to FK5 cartesian coordinate.
export function fk5(ra: Angle, dec: Angle, distance: Distance = ONE_KILOPARSEC): CartesianCoordinate {
	return eraS2p(ra, dec, distance)
}

// Convert the FK5 cartesian coordinate at equinox to ICRS cartesian coordinate.
export function fk5ToIcrs(p: CartesianCoordinate): CartesianCoordinate {
	return matTransposeMulVec(FK5_MATRIX, p)
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
