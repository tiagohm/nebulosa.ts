import { B1950_MATRIX, ECLIPTIC_B9150_MATRIX, ECLIPTIC_J2000_MATRIX, FK4_MATRIX, FK5_MATRIX, GALACTIC_MATRIX, SUPERGALACTIC_MATRIX } from './constants'
import type { CartesianCoordinate } from './coordinate'
import { eraBp06 } from './erfa'
import { Mat3 } from './matrix'
import { type Time, Timescale, precessionNutationMatrix, timeJulian, trueObliquity, tt } from './time'

export type CoordinateFrame = CartesianCoordinate

export interface Frame {
	readonly rotationAt: (time: Time) => Readonly<Mat3.Matrix>
}

const EQUINOX_J2000 = timeJulian(2000, Timescale.TT)

function equinoxFrameByCapitaine(m: Readonly<Mat3.Matrix>, from: Time, to: Time): Frame {
	const a = precessionMatrixCapitaine(from, to)
	Mat3.mul(a, m, a)

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
	return equinoxFrameByCapitaine(FK5_MATRIX, EQUINOX_J2000, equinox)
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
	rotationAt: (time) => Mat3.clone(precessionNutationMatrix(time)),
}

// The International Celestial Reference System (ICRS).
export const ICRS: Frame = {
	rotationAt: () => Mat3.identity(),
}

// Ecliptic coordinates at time.
export const ECLIPTIC_FRAME: Frame = {
	rotationAt: (time) => {
		const ecliptic = Mat3.identity()
		return Mat3.mul(Mat3.rotX(-trueObliquity(time), ecliptic), precessionNutationMatrix(time), ecliptic)
	},
}

// Computes the precession matrix from one time to another, per IAU 2006.
export function precessionMatrixCapitaine(from: Time, to: Time) {
	const t0 = tt(from)
	const t1 = tt(to)
	if (t0.day === t1.day && t0.fraction === t1.fraction) return Mat3.identity()
	// Hilton, J. et al., 2006, Celest.Mech.Dyn.Astron. 94, 351
	const rp = eraBp06(t0.day, t0.fraction)[1]
	const a = Mat3.transpose(rp, rp)
	const b = eraBp06(t1.day, t1.fraction)[1]
	return Mat3.mul(b, a, b)
}
