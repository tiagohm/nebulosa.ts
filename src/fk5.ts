import type { Angle } from './angle'
import type { CartesianCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraS2p } from './erfa'
import { FK5_MATRIX, precessionMatrixCapitaine } from './frame'
import { mulTransposeVec, mulVec } from './matrix'
import { timeJulian, Timescale, type Time } from './time'

const J2000 = timeJulian(2000, Timescale.TT)

// Convert the FK5 spherical coordinate to FK5 cartesian coordinate.
export function fk5(ra: Angle, dec: Angle, distance: Distance = 1): CartesianCoordinate {
	return eraS2p(ra, dec, distance)
}

// Convert the FK5 cartesian coordinate at equinox to ICRS cartesian coordinate.
export function fk5ToIcrs(p: CartesianCoordinate): CartesianCoordinate {
	return mulTransposeVec(FK5_MATRIX, p)
}

// Precess the FK5 cartesian coordinate from equinox to other.
export function precessFk5(p: CartesianCoordinate, from: Time, to: Time): CartesianCoordinate {
	return mulVec(precessionMatrixCapitaine(from, to), p, p)
}

// Precess the FK5 cartesian coordinate from given equinox to J2000.
export function precessFk5ToJ2000(p: CartesianCoordinate, equinox: Time): CartesianCoordinate {
	return precessFk5(p, equinox, J2000)
}

// Precess the FK5 cartesian coordinate from J2000 to given equinox.
export function precessFk5FromJ2000(p: CartesianCoordinate, equinox: Time): CartesianCoordinate {
	return precessFk5(p, J2000, equinox)
}
