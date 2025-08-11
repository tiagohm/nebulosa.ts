import type { Angle } from './angle'
import { FK5_MATRIX } from './constants'
import type { CartesianCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraS2p } from './erfa'
import { precessionMatrixCapitaine } from './frame'
import { matMulTransposeVec, matMulVec } from './mat3'
import { type Time, Timescale, timeJulianYear } from './time'

const J2000 = timeJulianYear(2000, Timescale.TT)

// Convert the FK5 spherical coordinate to FK5 cartesian coordinate.
export function fk5(ra: Angle, dec: Angle, distance: Distance = 1): CartesianCoordinate {
	return eraS2p(ra, dec, distance)
}

// Convert the FK5 cartesian coordinate at equinox to ICRS cartesian coordinate.
export function fk5ToIcrs(p: CartesianCoordinate): CartesianCoordinate {
	return matMulTransposeVec(FK5_MATRIX, p)
}

// Precess the FK5 cartesian coordinate from equinox to other.
export function precessFk5(p: CartesianCoordinate, from: Time, to: Time): CartesianCoordinate {
	return matMulVec(precessionMatrixCapitaine(from, to), p)
}

// Precess the FK5 cartesian coordinate from given equinox to J2000.
export function precessFk5ToJ2000(p: CartesianCoordinate, equinox: Time): CartesianCoordinate {
	return precessFk5(p, equinox, J2000)
}

// Precess the FK5 cartesian coordinate from J2000 to given equinox.
export function precessFk5FromJ2000(p: CartesianCoordinate, equinox: Time): CartesianCoordinate {
	return precessFk5(p, J2000, equinox)
}
