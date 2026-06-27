import { EARTH_DRDT_TIMES_RT_MATRIX, ECLIPTIC_B1950_MATRIX, ECLIPTIC_J2000_MATRIX, FK4_MATRIX, FK5_MATRIX, GALACTIC_MATRIX, ICRS_MATRIX, MEAN_EQUATOR_AND_EQUINOX_AT_B1950_MATRIX, SUPERGALACTIC_MATRIX } from '../../core/constants'
import { type Mat3, matIdentity, matMul, matMulTranspose, matMulVec, type MutMat3, matRotX, matRotZ, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecMinus, vecPlus } from '../../math/linear-algebra/vec3'
import { cirsRotationMatrix, gcrsToItrsRotationMatrix, greenwichApparentSiderealTime, greenwichMeanSiderealTime, pmMatrix, precessionNutationMatrix, type Time, Timescale, timeJulianYear, trueObliquity, tt } from '../time/time'
import type { PositionAndVelocity } from './astrometry'
import type { CartesianCoordinate } from './coordinate'
import { eraBp06 } from './erfa/erfa'

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
	rotationAt: () => ECLIPTIC_B1950_MATRIX,
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
export function fk5Frame(equinox: Time) {
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

// The dynamical frame of the Earth's mean equator and equinox of date
// (precession only, no nutation), measured from the base via the IAU 2006
// bias-precession matrix (eraBp06 rbp). Use TRUE_EQUATOR_AND_EQUINOX_OF_DATE
// when nutation is required.
export const MEAN_EQUATOR_AND_EQUINOX_OF_DATE: Frame = {
	rotationAt: (time) => {
		const t = tt(time)
		return eraBp06(t.day, t.fraction)[2]
	},
}

// The Celestial Intermediate Reference System (CIRS): the geometric, CIO-based
// equator-of-date frame, given by the celestial-to-intermediate rotation
// (eraC2i06a, cached per Time via cirsRotationMatrix). This is the pure rotation
// from the base to CIRS and does NOT include aberration, light deflection,
// parallax, or refraction; for the apparent place use the transforms in
// astrometry.ts.
export const CIRS: Frame = {
	rotationAt: cirsRotationMatrix,
}

// The Terrestrial Intermediate Reference System (TIRS): Earth-fixed apart from
// polar motion (true equator and equinox of date rotated by GAST about the
// pole). ITRS adds the polar-motion wobble on top of this.
export const TIRS: Frame = {
	rotationAt: (time) => {
		const m = matRotZ(greenwichApparentSiderealTime(time))
		return matMul(m, precessionNutationMatrix(time), m)
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
	dRdtTimesRtAt: () => EARTH_DRDT_TIMES_RT_MATRIX,
}

// Applies a TEME-to-ITRF rotation using a supplied GMST angle and optional polar-motion matrix.
export function temeToItrfByGmst<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, gmst: number, polarMotion?: Mat3): T extends Vec3 ? Vec3 : PositionAndVelocity {
	const r = matRotZ(gmst)

	if (pv.length === 3) {
		const p = matMulVec(r, pv)
		return (polarMotion ? matMulVec(polarMotion, p, p) : p) as never
	}

	const pPef = matMulVec(r, pv[0])
	const vPef = matMulVec(r, pv[1])
	vecPlus(vPef, matMulVec(EARTH_DRDT_TIMES_RT_MATRIX, pPef), vPef)

	if (polarMotion) {
		return [matMulVec(polarMotion, pPef, pPef), matMulVec(polarMotion, vPef, vPef)] as never
	}

	return [pPef, vPef] as never
}

// Applies an ITRF-to-TEME rotation using a supplied GMST angle and optional polar-motion matrix.
export function itrfToTemeByGmst<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, gmst: number, polarMotion?: Mat3): T extends Vec3 ? Vec3 : PositionAndVelocity {
	const r = matRotZ(gmst)

	if (pv.length === 3) {
		const pPef = polarMotion ? matTransposeMulVec(polarMotion, pv) : ([pv[0], pv[1], pv[2]] as MutVec3)
		return matTransposeMulVec(r, pPef, pPef) as never
	}

	const pPef = polarMotion ? matTransposeMulVec(polarMotion, pv[0]) : ([pv[0][0], pv[0][1], pv[0][2]] as MutVec3)
	const vPef = polarMotion ? matTransposeMulVec(polarMotion, pv[1]) : ([pv[1][0], pv[1][1], pv[1][2]] as MutVec3)
	vecMinus(vPef, matMulVec(EARTH_DRDT_TIMES_RT_MATRIX, pPef), vPef)
	return [matTransposeMulVec(r, pPef, pPef), matTransposeMulVec(r, vPef, vPef)] as never
}

// Converts a TEME vector or state into ITRF at the requested time.
export function temeToItrf<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, time: Time, polarMotion: boolean = true): T extends Vec3 ? Vec3 : PositionAndVelocity {
	return temeToItrfByGmst(pv, greenwichMeanSiderealTime(time), polarMotion ? pmMatrix(time) : undefined)
}

// Converts an ITRF vector or state into TEME at the requested time.
export function itrfToTeme<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, time: Time, polarMotion: boolean = true): T extends Vec3 ? Vec3 : PositionAndVelocity {
	return itrfToTemeByGmst(pv, greenwichMeanSiderealTime(time), polarMotion ? pmMatrix(time) : undefined)
}

// Applies a frame rotation (base -> frame) to a position or full state at time.
// Pass `o` to write the result into an existing vector or state and avoid
// allocation; `o` may alias `pv` for an in-place transform.
export function frameAt<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, frame: Frame, time: Time, o?: T extends Vec3 ? MutVec3 : PositionAndVelocity): T extends Vec3 ? Vec3 : PositionAndVelocity {
	const r = frame.rotationAt(time)

	if (pv.length === 3) {
		return matMulVec(r, pv, o as MutVec3 | undefined) as never
	}

	const out = o as PositionAndVelocity | undefined
	const p = matMulVec(r, pv[0], out?.[0])
	const v = matMulVec(r, pv[1], out?.[1])

	if (frame.dRdtTimesRtAt) {
		// p is already the transformed (frame) position, so W · p adds the drag term.
		vecPlus(v, matMulVec(frame.dRdtTimesRtAt(time), p), v)
	}

	if (out) {
		out[0] = p
		out[1] = v
		return out as never
	}

	return [p, v] as never
}

// Rotates a position or full state from `frame` back into the base
// (GCRS/ICRS-oriented) frame. This is the exact inverse of `frameAt`. Pass `o`
// to avoid allocation; `o` may alias `pv` for an in-place transform.
//
// For position:  p_base = Rᵀ · p_frame.
// For a rotating frame (R = R(t)) the velocity must undo the drag term first:
//   v_frame = R · v_base + (dR/dt) · p_base = R · v_base + W · p_frame,
//   so v_base = Rᵀ · (v_frame − W · p_frame),  with W = dRdtTimesRtAt.
export function frameToBase<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, frame: Frame, time: Time, o?: T extends Vec3 ? MutVec3 : PositionAndVelocity): T extends Vec3 ? Vec3 : PositionAndVelocity {
	const r = frame.rotationAt(time)

	if (pv.length === 3) {
		return matTransposeMulVec(r, pv, o as MutVec3 | undefined) as never
	}

	const out = o as PositionAndVelocity | undefined

	if (frame.dRdtTimesRtAt) {
		// Build the drag-corrected velocity from the original position first, since
		// computing p may overwrite pv[0] when `o` aliases `pv`.
		const v = vecMinus(pv[1], matMulVec(frame.dRdtTimesRtAt(time), pv[0]), out?.[1])
		matTransposeMulVec(r, v, v)
		const p = matTransposeMulVec(r, pv[0], out?.[0])

		if (out) {
			out[0] = p
			out[1] = v
			return out as never
		}

		return [p, v] as never
	}

	const p = matTransposeMulVec(r, pv[0], out?.[0])
	const v = matTransposeMulVec(r, pv[1], out?.[1])

	if (out) {
		out[0] = p
		out[1] = v
		return out as never
	}

	return [p, v] as never
}

// Transforms a position or full state from one frame into another, composing
// through the common base:  pv_to = R_to · R_fromᵀ · pv_from. Rotating frames
// (e.g. ITRS) contribute their angular-velocity term on both legs. Pass `o` to
// avoid allocation. Handles only orientation; origin shifts (barycentric/
// geocentric/topocentric) and the non-linear apparent-place transforms
// (aberration, light deflection, refraction) are not frame rotations and live
// elsewhere. To transform many states between the same pair at one time,
// precompute the matrix once with `frameRotationAt`.
export function frameToFrame<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T, from: Frame, to: Frame, time: Time, o?: T extends Vec3 ? MutVec3 : PositionAndVelocity): T extends Vec3 ? Vec3 : PositionAndVelocity {
	// Stage the intermediate base state in `o` (when given), then rotate in place.
	const base = frameToBase(pv, from, time, o)
	return frameAt(base, to, time, o as never) as never
}

// Computes the single orientation matrix that maps `from` into `to` at time:
// R = R_to · R_fromᵀ. Apply it with `matMulVec` to transform many vectors
// between the same pair at one instant without recomputing the rotations.
// This is the rotation only; for rotating frames (e.g. ITRS) the velocity drag
// term is not captured, so use it for position, or for the velocity of
// non-rotating (inertial) frame pairs. Pass `o` to avoid allocation.
export function frameRotationAt(from: Frame, to: Frame, time: Time, o?: MutMat3): Mat3 {
	return matMulTranspose(to.rotationAt(time), from.rotationAt(time), o)
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

// Converts an ICRS cartesian coordinate (or state) to FK5 (J2000) by applying
// the constant frame bias.
export function icrsToFk5<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T): T extends Vec3 ? Vec3 : PositionAndVelocity {
	return frameToFrame(pv, ICRS, FK5, NO_TIME)
}

// Converts an FK5 (J2000) cartesian coordinate (or state) to ICRS by removing
// the constant frame bias. Precess to J2000 first for coordinates at another
// equinox.
export function fk5ToIcrs<T extends Readonly<PositionAndVelocity> | Vec3>(pv: T): T extends Vec3 ? Vec3 : PositionAndVelocity {
	return frameToFrame(pv, FK5, ICRS, NO_TIME)
}
