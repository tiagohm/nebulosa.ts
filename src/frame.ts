import type { PositionAndVelocity } from './astrometry'
import { EARTH_ANGULAR_VELOCITY_MATRIX, ECLIPTIC_B9150_MATRIX, ECLIPTIC_J2000_MATRIX, FK4_MATRIX, FK5_MATRIX, GALACTIC_MATRIX, ICRS_MATRIX, MEAN_EQUATOR_AND_EQUINOX_AT_B1950_MATRIX, SUPERGALACTIC_MATRIX } from './constants'
import type { CartesianCoordinate } from './coordinate'
import { eraBp06 } from './erfa'
import { type Mat3, matIdentity, matMul, matMulTranspose, matMulVec, matRotX } from './mat3'
import { gcrsToItrsRotationMatrix, precessionNutationMatrix, type Time, Timescale, timeJulianYear, trueObliquity, tt } from './time'
import { type Vec3, vecPlus } from './vec3'

export type CoordinateFrame = CartesianCoordinate

export interface Frame {
	readonly rotationAt: (time: Time) => Mat3
	readonly dRdtTimesRtAt?: (time: Time) => Mat3
}

const EQUINOX_J2000 = timeJulianYear(2000, Timescale.TT)

function equinoxFrameByCapitaine(m: Mat3, from: Time, to: Time): Frame {
	const a = precessionMatrixCapitaine(from, to)
	matMul(a, m, a)
	return { rotationAt: () => a }
}

// Reference frame of the Earth's mean equator and equinox at B1950.
export const MEAN_EQUATOR_AND_EQUINOX_AT_B1950: Frame = {
	rotationAt: () => MEAN_EQUATOR_AND_EQUINOX_AT_B1950_MATRIX,
}

// Ecliptic coordinates based upon the B1950 frame.
export const ECLIPTIC_B1950: Frame = {
	rotationAt: () => ECLIPTIC_B9150_MATRIX,
}

// Ecliptic coordinates based upon the J2000 frame.
export const ECLIPTIC_J2000: Frame = {
	rotationAt: () => ECLIPTIC_J2000_MATRIX,
}

// The FK4 reference frame is derived from the B1950 frame by
// applying the equinox offset determined by Fricke.
export const FK4: Frame = {
	rotationAt: () => FK4_MATRIX,
}

// The FK5 reference frame based on J2000 position.
export const FK5: Frame = {
	rotationAt: () => FK5_MATRIX,
}

// The FK5 reference frame based on position at equinox.
export function fk5Frame(equinox: Time): Frame {
	return equinoxFrameByCapitaine(FK5_MATRIX, EQUINOX_J2000, equinox)
}

// Galactic System reference frame.
export const GALACTIC: Frame = {
	rotationAt: () => GALACTIC_MATRIX,
}

// Supergalactic System reference frame.
export const SUPERGALACTIC: Frame = {
	rotationAt: () => SUPERGALACTIC_MATRIX,
}

// The dynamical frame of the Earth's true equator and equinox of date.
export const TRUE_EQUATOR_AND_EQUINOX_OF_DATE: Frame = {
	rotationAt: (time) => precessionNutationMatrix(time),
}

// The International Celestial Reference System (ICRS).
export const ICRS: Frame = {
	rotationAt: () => ICRS_MATRIX,
}

// Ecliptic coordinates at time.
export const ECLIPTIC: Frame = {
	rotationAt: (time) => {
		const m = matIdentity()
		return matMul(matRotX(trueObliquity(time), m), precessionNutationMatrix(time), m)
	},
}

// Computes the precession matrix from one time to another, per IAU 2006.
export function precessionMatrixCapitaine(from: Time, to: Time) {
	const t0 = tt(from)
	const t1 = tt(to)
	if (t0.day === t1.day && t0.fraction === t1.fraction) return matIdentity()
	// Hilton, J. et al., 2006, Celest.Mech.Dyn.Astron. 94, 351
	const rp = eraBp06(t0.day, t0.fraction)[1]
	const b = eraBp06(t1.day, t1.fraction)[1]
	return matMulTranspose(b, rp, b)
}

// The International Terrestrial Reference System (ITRS).
// This is the IAU standard for an Earth-centered Earth-fixed (ECEF)
// coordinate system, anchored to the Earth’s crust and continents.
// This reference frame combines three other reference frames: the
// Earth’s true equator and equinox of date, the Earth’s rotation with
// respect to the stars, and the polar wobble of the crust with respect
// to the Earth’s pole of rotation.
export const ITRS: Frame = {
	rotationAt: gcrsToItrsRotationMatrix,
	dRdtTimesRtAt: () => EARTH_ANGULAR_VELOCITY_MATRIX,
}

// Applies a frame rotation to a position and velocity at time.
export function frameAt<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, frame: Frame, time: Time): T extends Vec3 ? Vec3 : PositionAndVelocity {
	const r = frame.rotationAt(time)

	if (pv.length === 3) {
		return matMulVec(r, pv) as never
	} else {
		const p = matMulVec(r, pv[0])
		const v = matMulVec(r, pv[1])

		if (frame.dRdtTimesRtAt) {
			const w = frame.dRdtTimesRtAt(time)
			vecPlus(v, matMulVec(w, p), v)
		}

		return [p, v] as never
	}
}

const NO_TIME: Time = { day: 0, fraction: 0, scale: 0 }

export function galactic<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T): T extends Vec3 ? Vec3 : PositionAndVelocity {
	return frameAt(pv, GALACTIC, NO_TIME)
}

export function supergalactic<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T): T extends Vec3 ? Vec3 : PositionAndVelocity {
	return frameAt(pv, SUPERGALACTIC, NO_TIME)
}

export function eclipticJ2000<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T): T extends Vec3 ? Vec3 : PositionAndVelocity {
	return frameAt(pv, ECLIPTIC_J2000, NO_TIME)
}

export function ecliptic<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, time: Time): T extends Vec3 ? Vec3 : PositionAndVelocity {
	return frameAt(pv, ECLIPTIC, time)
}
