import type { CartesianCoordinate } from './coordinate'
import { eraBp06 } from './erfa'
import { clone, identity, mul, rotX, transposeMut, type Mat3, type MutMat3 } from './matrix'
import { precessionNutation, timeJulian, Timescale, trueObliquity, tt, type Time } from './time'

export type CoordinateFrame = CartesianCoordinate

export interface Frame {
	readonly rotationAt: (time: Time) => Mat3
}

const DEFAULT_EQUINOX_J2000 = timeJulian(2000, Timescale.TT)

export const B1950_MATRIX = [0.99992570795236291, 0.011178938126427691, 0.0048590038414544293, -0.011178938137770135, 0.9999375133499887, -2.715792625851078e-5, -0.0048590038153592712, -2.7162594714247048e-5, 0.9999881946023742] as const
export const ECLIPTIC_B9150_MATRIX = [0.99992570795236291, 0.011178938126427691, 0.0048590038414544293, -0.012189277138214926, 0.91736881787898283, 0.39785157220522011, -9.9405009203520217e-6, -0.3978812427417045, 0.91743692784599817] as const
export const ECLIPTIC_J2000_MATRIX = [1, 0, 0, 0, 0.917482137086962521575615807374, 0.397776982901650696710316869067, 0, -0.397776982901650696710316869067, 0.917482137086962521575615807374] as const
export const FK4_MATRIX = [0.9999256809514446605, 0.011181371756303229, 0.0048589607363144413, -0.011181372206268162, 0.999937486137318374, -0.000027073328547607, -0.0048589597008613673, -0.0000272585320447865, 0.9999881948141177111] as const
export const FK5_MATRIX = [0.9999999999999928638, -0.0000001110223329741, -0.000000044118044981, 0.0000001110223372305, 0.9999999999999891831, 0.0000000964779225408, 0.0000000441180342698, -0.0000000964779274389, 0.9999999999999943728] as const
export const GALACTIC_MATRIX = [-0.0548756577126196781, -0.8734370519557791298, -0.4838350736164183803, 0.4941094371971076412, -0.4448297212220537635, 0.7469821839845094133, -0.8676661375571625615, -0.1980763372750705946, 0.4559838136911523476] as const
export const SUPERGALACTIC_MATRIX = [0.3750155557060191496, 0.3413588718572082374, 0.8618801851666388868, -0.8983204377254853439, -0.0957271002509969235, 0.4287851600069993011, 0.2288749093788964371, -0.9350456902643365859, 0.2707504994914917474] as const

function equinoxFrameByCapitaine(m: Mat3, from: Time, to: Time): Frame {
	const a = precessionMatrixCapitaine(from, to)
	mul(a, m, a)

	return {
		rotationAt: () => {
			return a
		},
	}
}

// Reference frame of the Earth's mean equator and equinox at B1950.
export const B1950_FRAME: Frame = {
	rotationAt: () => B1950_MATRIX,
}

// Ecliptic coordinates based upon the B1950 frame.
export const ECLIPTIC_B1950_FRAME: Frame = {
	rotationAt: () => ECLIPTIC_B9150_MATRIX,
}

// Ecliptic coordinates based upon the J2000 frame.
export const ECLIPTIC_J2000_FRAME: Frame = {
	rotationAt: () => ECLIPTIC_J2000_MATRIX,
}

// The FK4 reference frame is derived from the B1950 frame by
// applying the equinox offset determined by Fricke.
export const FK4_FRAME: Frame = {
	rotationAt: () => FK4_MATRIX,
}

// The FK5 reference frame based on J2000 position.
export const FK5_FRAME: Frame = {
	rotationAt: () => FK5_MATRIX,
}

// The FK5 reference frame based on position at equinox.
export function fk5Frame(equinox: Time): Frame {
	return equinoxFrameByCapitaine(FK5_MATRIX, DEFAULT_EQUINOX_J2000, equinox)
}

// Galactic System reference frame.
export const GALACTIC_FRAME: Frame = {
	rotationAt: () => GALACTIC_MATRIX,
}

// Supergalactic System reference frame.
export const SUPERGALACTIC_FRAME: Frame = {
	rotationAt: () => SUPERGALACTIC_MATRIX,
}

// The dynamical frame of the Earth's true equator and equinox of date.
export const TRUE_EQUATOR_AND_EQUINOX_OF_DATE_FRAME: Frame = {
	rotationAt: (time) => clone(precessionNutation(time)),
}

// The International Celestial Reference System (ICRS).
export const ICRS: Frame = {
	rotationAt: () => identity(),
}

// Ecliptic coordinates at time.
export const ECLIPTIC_FRAME: Frame = {
	rotationAt: (time) => {
		const ecliptic = identity()
		return mul(rotX(-trueObliquity(time), ecliptic), precessionNutation(time), ecliptic)
	},
}

// Computes the precession matrix from one time to another, per IAU 2006.
export function precessionMatrixCapitaine(from: Time, to: Time): MutMat3 {
	const t0 = tt(from)
	const t1 = tt(to)
	if (t0.day === t1.day && t0.fraction === t1.fraction) return identity()
	// Hilton, J. et al., 2006, Celest.Mech.Dyn.Astron. 94, 351
	const a = transposeMut(eraBp06(t0.day, t0.fraction)[1])
	const b = eraBp06(t1.day, t1.fraction)[1]
	return mul(b, a)
}
