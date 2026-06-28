import { DEG2RAD, GALACTIC_MATRIX, ICRS_MATRIX, ONE_KILOPARSEC, ONE_PARSEC } from '../../core/constants'
import { type Mat3, matMul, matMulVec, matRotX, matRotY, matRotZ, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecMinus, vecNegate, vecPlus } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { kilometerPerSecond } from '../../math/units/velocity'
import type { Time } from '../time/time'
import type { PositionAndVelocity } from './astrometry'
import { eraS2p } from './erfa/erfa'
import { ECLIPTIC_J2000, type CoordinateFrame, type CoordinateFrameOutput, type Frame } from './frame'

// A frame that may sit at a shifted, possibly moving origin relative to the
// base (GCRS/ICRS-oriented) frame. It inherits the orientation members from
// Frame and adds the origin position and velocity, both optional, so every
// plain Frame is already a valid AffineFrame with no translation.
//
// Unlike a pure rotation Frame, an affine transform is meaningful only on an
// absolute position in AU (with a real distance): translating a unit direction
// vector is nonsense. Pass full positions/states, never normalized directions.
export interface AffineFrame extends Frame {
	// Position of this frame's origin, expressed in the base frame, in AU. Absent
	// means the origin coincides with the base origin (no translation).
	readonly originAt?: (time: Time) => Vec3
	// Velocity of this frame's origin in the base frame, in AU/day. Absent means a
	// fixed origin (no velocity offset). Used by frames such as the LSR.
	readonly originVelocityAt?: (time: Time) => Vec3
}

// Applies an affine transform (base -> frame) to a position or full state at
// time. Pass `o` to write the result into an existing vector or state and avoid
// allocation; `o` may alias `pv` for an in-place transform.
//
//   p_f = R · (p − O)
//   v_f = R · (v − Ȯ) + W · p_f      (W = dRdtTimesRtAt, only for rotating frames)
//
// O is originAt, Ȯ is originVelocityAt; both default to zero when absent.
export function affineFromBase<T extends CoordinateFrame>(pv: T, frame: AffineFrame, time: Time, o?: CoordinateFrameOutput<T>): CoordinateFrameOutput<T> {
	const r = frame.rotationAt(time)
	const origin = frame.originAt?.(time)

	if (pv.length === 3) {
		if (origin) return matMulVec(r, vecMinus(pv, origin), o as MutVec3 | undefined) as never
		return matMulVec(r, pv, o as MutVec3 | undefined) as never
	}

	const out = o as PositionAndVelocity | undefined
	const originVelocity = frame.originVelocityAt?.(time)
	// Subtract the origin offsets first; these produce fresh vectors, so writing p
	// into out[0] afterwards is safe even when `o` aliases `pv`.
	const dp = origin ? vecMinus(pv[0], origin) : pv[0]
	const dv = originVelocity ? vecMinus(pv[1], originVelocity) : pv[1]

	const p = matMulVec(r, dp, out?.[0])
	const v = matMulVec(r, dv, out?.[1])

	if (frame.dRdtTimesRtAt) {
		vecPlus(v, matMulVec(frame.dRdtTimesRtAt(time), p), v)
	}

	if (out) {
		out[0] = p
		out[1] = v
		return out as never
	}

	return [p, v] as never
}

// Rotates and shifts a position or full state from `frame` back into the base
// frame. This is the exact inverse of affineFromBase. Pass `o` to avoid
// allocation; `o` may alias `pv` for an in-place transform.
//
//   p = Rᵀ · p_f + O
//   v = Rᵀ · (v_f − W · p_f) + Ȯ
export function affineToBase<T extends CoordinateFrame>(pv: T, frame: AffineFrame, time: Time, o?: CoordinateFrameOutput<T>): CoordinateFrameOutput<T> {
	const r = frame.rotationAt(time)
	const origin = frame.originAt?.(time)

	if (pv.length === 3) {
		const p = matTransposeMulVec(r, pv, o as MutVec3 | undefined)
		return (origin ? vecPlus(p, origin, p) : p) as never
	}

	const out = o as PositionAndVelocity | undefined

	// Build the drag-corrected velocity from the original position first, since
	// computing p may overwrite pv[0] when `o` aliases `pv`.
	const dv = frame.dRdtTimesRtAt ? vecMinus(pv[1], matMulVec(frame.dRdtTimesRtAt(time), pv[0])) : pv[1]
	const v = matTransposeMulVec(r, dv, out?.[1])
	const originVelocity = frame.originVelocityAt?.(time)
	if (originVelocity) vecPlus(v, originVelocity, v)

	const p = matTransposeMulVec(r, pv[0], out?.[0])
	if (origin) vecPlus(p, origin, p)

	if (out) {
		out[0] = p
		out[1] = v
		return out as never
	}

	return [p, v] as never
}

// Transforms a position or full state from one (affine) frame into another,
// composing through the common base. Accepts plain Frames too, since every Frame
// is an AffineFrame with no origin; when neither frame has an origin or velocity
// offset this reduces exactly to frameToFrame. Pass `o` to avoid allocation.
export function affineToAffine<T extends CoordinateFrame>(pv: T, from: AffineFrame, to: AffineFrame, time: Time, o?: CoordinateFrameOutput<T>): CoordinateFrameOutput<T> {
	// Stage the intermediate base state in `o` (when given), then transform in place.
	const base = affineToBase(pv, from, time, o)
	return affineFromBase(base, to, time, o as never) as never
}

// The barycentric ecliptic frame is just ECLIPTIC_J2000 used as an AffineFrame
// (its origin coincides with the base origin). It is re-exported for symmetry
// with the heliocentric frame below.
export const BARYCENTRIC_ECLIPTIC: AffineFrame = ECLIPTIC_J2000

// Builds the heliocentric ecliptic (J2000) frame: the same orientation as
// ECLIPTIC_J2000 but with its origin at the Sun. The Sun ephemeris is injected
// so this module stays in the coordinates layer without importing ephemerides;
// `sunAt` must return the Sun's barycentric position (AU) and velocity (AU/day)
// in the base (ICRS/BCRS) frame at time.
export function heliocentricEclipticFrame(sunAt: (time: Time) => readonly [Vec3, Vec3]): AffineFrame {
	return {
		rotationAt: ECLIPTIC_J2000.rotationAt,
		originAt: (time) => sunAt(time)[0],
		originVelocityAt: (time) => sunAt(time)[1],
	}
}

// The roll that aligns the Galactic plane with the Galactocentric x-z plane,
// matching Astropy's Galactocentric.get_roll0 (Reid & Brunthaler 2004).
const GALACTOCENTRIC_ROLL0 = 58.5986320306 * DEG2RAD

// Parameters defining the Galactocentric frame. Angles are radians; distances AU.
export interface GalactocentricParameters {
	// ICRS right ascension and declination of the Galactic center.
	galcen: readonly [Angle, Angle]
	// Distance from the Sun to the Galactic center.
	galcenDistance: Distance
	// Height of the Sun above the Galactic midplane (positive toward the north pole).
	zSun: Distance
	// Extra roll about the Sun–Galactic-center line.
	roll: Angle
}

// Astropy "latest" (v4.0) Galactocentric defaults: GRAVITY Collaboration 2018
// distance, Reid & Brunthaler 2004 Galactic-center direction, and Bennett & Bovy
// 2019 Sun height.
export const GALACTOCENTRIC_DEFAULTS: GalactocentricParameters = {
	galcen: [266.4051 * DEG2RAD, -28.936175 * DEG2RAD],
	galcenDistance: 8.122 * ONE_KILOPARSEC,
	zSun: 20.8 * ONE_PARSEC,
	roll: 0,
}

// Builds the Galactocentric frame: origin at the Galactic center, x toward the
// center, z toward the north Galactic pole. The construction mirrors Astropy:
// rotate ICRS so x lines up with the center (Rz(ra) then Ry(−dec)), roll about
// that axis, then tilt about y by arcsin(zSun/distance) for the Sun's height.
// Requires absolute AU positions, as with every affine frame. Constant in time.
export function galactocentricFrame(params: GalactocentricParameters = GALACTOCENTRIC_DEFAULTS): AffineFrame {
	const [ra, dec] = params.galcen
	const d = params.galcenDistance
	// ICRS -> Galactic-aligned axes, with the extra roll about the center line.
	const r = matMul(matMul(matRotX(GALACTOCENTRIC_ROLL0 - params.roll), matRotY(-dec)), matRotZ(ra))
	// Tilt for the Sun's height above the midplane.
	const a: Mat3 = matMul(matRotY(-Math.asin(params.zSun / d)), r)
	// Galactic center position in the base (ICRS) frame: distance along its direction.
	const origin = eraS2p(ra, dec, d)
	return { rotationAt: () => a, originAt: () => origin }
}

// The Sun's peculiar velocity relative to the Local Standard of Rest, as the
// Galactic Cartesian (U, V, W) components in AU/day. Default from Schönrich,
// Binney & Dehnen (2010): (11.1, 12.24, 7.25) km/s.
export const LSR_DEFAULT_SOLAR_VELOCITY: Vec3 = [kilometerPerSecond(11.1), kilometerPerSecond(12.24), kilometerPerSecond(7.25)]

// Builds the Local Standard of Rest frame: same orientation and origin as ICRS,
// but a velocity offset so that a star's LSR velocity is its barycentric
// velocity plus the Sun's peculiar motion. `solarVelocity` is the Sun's peculiar
// velocity relative to the LSR in Galactic Cartesian (U, V, W), AU/day. Positions
// are unchanged; only velocities are affected.
export function lsrFrame(solarVelocity: Vec3 = LSR_DEFAULT_SOLAR_VELOCITY): AffineFrame {
	// v_lsr = v_icrs + v_bary, so the origin velocity is −v_bary expressed in ICRS.
	const offset = vecNegate(matTransposeMulVec(GALACTIC_MATRIX, solarVelocity))
	return { rotationAt: () => ICRS_MATRIX, originVelocityAt: () => offset }
}

// Kinematic LSR (LSRK) solar motion as ICRS Cartesian components, AU/day. This is
// the standard ~20 km/s solar-apex motion; the value matches Astropy's LSRK and
// is kept in ICRS axes because the apex is not a round Galactic-UVW triple.
export const LSRK_SOLAR_VELOCITY_ICRS: Vec3 = [kilometerPerSecond(0.28999706839034606), kilometerPerSecond(-17.317264789717928), kilometerPerSecond(10.00141199546947)]
const LSRK_SOLAR_VELOCITY_ICRS_OFFSET = vecNegate(LSRK_SOLAR_VELOCITY_ICRS)

// The kinematic Local Standard of Rest (LSRK): ICRS orientation and origin, with
// the standard solar-apex velocity offset. Positions are unchanged.
export function lsrkFrame(): AffineFrame {
	return { rotationAt: () => ICRS_MATRIX, originVelocityAt: () => LSRK_SOLAR_VELOCITY_ICRS_OFFSET }
}

// Dynamical LSR (LSRD) solar motion as Galactic Cartesian (U, V, W), AU/day.
// Delhaye (1965): (9, 12, 7) km/s.
export const LSRD_SOLAR_VELOCITY: Vec3 = [kilometerPerSecond(9), kilometerPerSecond(12), kilometerPerSecond(7)]

// The dynamical Local Standard of Rest (LSRD): like lsrFrame but with the
// Delhaye (1965) solar motion. ICRS orientation and origin; positions unchanged.
export function lsrdFrame(): AffineFrame {
	return lsrFrame(LSRD_SOLAR_VELOCITY)
}

// The Local Standard of Rest expressed in Galactic axes (GalacticLSR): Galactic
// orientation with the same velocity offset as the LSR. `solarVelocity` is the
// Sun's peculiar velocity in Galactic Cartesian (U, V, W), AU/day. Positions are
// rotated into Galactic axes; velocities also gain the solar motion.
export function galacticLsrFrame(solarVelocity: Vec3 = LSR_DEFAULT_SOLAR_VELOCITY): AffineFrame {
	const offset = vecNegate(matTransposeMulVec(GALACTIC_MATRIX, solarVelocity))
	return { rotationAt: () => GALACTIC_MATRIX, originVelocityAt: () => offset }
}
