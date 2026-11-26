import { ASEC2RAD, PI, PIOVERTWO, TAU } from '../../../core/constants'
import { type Angle, normalizeAngle, normalizePI } from '../../../math/units/angle'
import type { PierSide } from '../device'
import type { AxisDirection } from './types'

// Shaft geometry of a German equatorial mount: how a sky coordinate on one side of the pier maps to the
// physical right-ascension and declination shaft angles, and back. A side change reaches the same sky
// direction through the opposite shaft orientation, so the right-ascension shaft is offset by half a
// turn and the declination shaft mirrored across the pole. All angles are radians; shaft angles are
// continuous and may hold any number of revolutions.

// Maps a reported declination to the equivalent physical shaft angle for one pier side.
// `pierSide` must be EAST or WEST, `declination` is in radians within the celestial range and
// `hemisphere` is 1 for a mount whose polar axis points at the north celestial pole, -1 for the south
// one. The returned angle is in radians, with the EAST representation mirrored across the pole the
// mount's own axis points at, so a flip passes over that pole whatever the target declination.
export function declinationShaftAngle(pierSide: PierSide, declination: Angle, hemisphere: number = 1) {
	if (pierSide === 'WEST') return declination
	return hemisphere < 0 ? -PI - declination : PI - declination
}

// Maps a sky right ascension to the corresponding physical RA shaft angle for one pier side.
// `pierSide` may be NEITHER for pole-neutral moves; `rightAscension` is in radians. EAST is offset by
// PI because the same sky direction is reached from the opposite shaft orientation after a flip.
export function rightAscensionShaftAngle(pierSide: PierSide, rightAscension: Angle) {
	return rightAscension + (pierSide === 'EAST' ? PI : 0)
}

// Maps a physical declination shaft angle back to the celestial declination it points at.
// `declinationShaft` is in radians in the continuous shaft frame used during a coordinate slew.
export function declinationFromShaftAngle(declinationShaft: Angle) {
	return Math.asin(Math.sin(declinationShaft))
}

// Sets the numerical deadband around a declination-shaft pole crossing, in radians.
// Its sub-nanoarcsecond width also bounds the equivalent cosine magnitude under the small-angle
// approximation, and only resolves floating-point noise at the singular boundary.
export const DECLINATION_SHAFT_POLE_TOLERANCE = 64 * Number.EPSILON

// Maps a physical RA shaft angle back to sky right ascension for the declination-shaft branch.
// All shaft angles are radians in the continuous physical frame. `pathOriginDeclinationShaft` is the
// earlier declination shaft pose of the same motion; within numerical noise of a pole, its approach
// direction keeps the pre-crossing RA branch. Without motion, the singular pole uses the unmirrored
// branch, while values away from it follow the periodically folded physical shaft frame.
export function rightAscensionFromShaftPose(rightAscensionShaft: Angle, declinationShaft: Angle, pathOriginDeclinationShaft: Angle = declinationShaft) {
	const cosine = Math.cos(declinationShaft)
	const isAtPole = Math.abs(cosine) <= DECLINATION_SHAFT_POLE_TOLERANCE
	const direction = Math.sign(declinationShaft - pathOriginDeclinationShaft)
	const branchDeclinationShaft = isAtPole && direction !== 0 ? declinationShaft - direction * DECLINATION_SHAFT_POLE_TOLERANCE * 2 : declinationShaft
	const mirrored = isMirroredDeclinationShaftFrame(branchDeclinationShaft)
	return normalizeAngle(mirrored ? rightAscensionShaft - PI : rightAscensionShaft)
}

// Reports whether a continuous declination shaft angle occupies the periodically mirrored RA frame.
// The angle is in radians and may contain any number of revolutions. A singular pole inside the
// numerical deadband is treated as unmirrored; callers that know its direction displace it to the
// approached branch before asking.
export function isMirroredDeclinationShaftFrame(declinationShaft: Angle) {
	const cosine = Math.cos(declinationShaft)
	return Math.abs(cosine) > DECLINATION_SHAFT_POLE_TOLERANCE && cosine < 0
}

// Width of a half-turn direction tie, in radians.
//
// Reconstructing an EAST RA shaft as sky RA plus PI, then folding it back, leaves a one-ulp celestial
// offset for some right ascensions. Composed with a PI-radian frame change that offset overshoots the
// half-turn fold, and only this deadband is large enough to keep the original sign. It is a handful of
// double ulps at magnitude PI and far below any physical slew.
export const SHAFT_HALF_TURN_TIE_TOLERANCE = 64 * Number.EPSILON

// Normalizes physical shaft travel to the nearest half-turn while preserving exact tie direction.
// `delta` is a shaft-angle difference in radians. `normalizePI` maps both +PI and -PI to +PI, and a
// half-turn that overshoots that fold by a rounding ulp lands a fraction away from it. Retaining the
// original sign lets a reverse flip undo the path taken instead of accumulating another revolution.
export function normalizeShaftDelta(delta: Angle) {
	const normalized = normalizePI(delta)
	if (delta < 0 && normalized > 0 && PI - normalized <= SHAFT_HALF_TURN_TIE_TOLERANCE) return normalized - TAU
	if (delta > 0 && normalized < 0 && PI + normalized <= SHAFT_HALF_TURN_TIE_TOLERANCE) return normalized + TAU
	return normalized
}

// Sets the declination band where a slew into the exact pole may keep its current RA shaft frame.
// The value is in radians. Inside these final two degrees the sky RA is already nearly singular, so a
// command to the pole can arrive by finishing the declination motion instead of forcing a cosmetic RA
// half-turn.
export const POLE_RIGHT_ASCENSION_FRAME_RETENTION_DISTANCE = 7200 * ASEC2RAD

// Sets the tolerance for recognizing a pole target after internal pointing offsets.
// The value is in radians and only distinguishes a requested pole from an ordinary near-pole target.
export const POLE_TARGET_TOLERANCE = ASEC2RAD

// Reports whether a pole-neutral target can keep the current RA shaft frame.
// Both declinations are mechanical sky declinations in radians. Only NEITHER targets already within
// two degrees of the pole retain the current frame; near-pole side-changing targets still travel
// through their physical RA half-turn.
export function retainsPoleRightAscensionFrame(targetPierSide: PierSide, targetDeclination: Angle, currentDeclination: Angle) {
	return targetPierSide === 'NEITHER' && Math.abs(Math.abs(targetDeclination) - PIOVERTWO) <= POLE_TARGET_TOLERANCE && Math.abs(Math.abs(currentDeclination) - PIOVERTWO) <= POLE_RIGHT_ASCENSION_FRAME_RETENTION_DISTANCE
}

// Returns the physical RA half-turn needed when moving between declination-shaft branches.
// `fromDeclinationShaft` and `toDeclinationShaft` are continuous shaft angles in radians. Values beyond
// either pole use the mirrored RA frame, so crossing into that branch adds PI and crossing out subtracts
// PI. Moves that stay on the same branch have no RA-frame offset.
export function rightAscensionShaftFrameTravel(fromDeclinationShaft: Angle, toDeclinationShaft: Angle) {
	const fromMirrored = isMirroredDeclinationShaftFrame(fromDeclinationShaft)
	const toMirrored = isMirroredDeclinationShaftFrame(toDeclinationShaft)
	if (fromMirrored === toMirrored) return 0
	return toMirrored ? PI : -PI
}

// Gives the sign converting celestial declination motion to physical shaft motion on one pier side.
// EAST reverses the shaft direction; WEST and the pole-neutral state preserve it.
export function declinationShaftFrameSign(pierSide: PierSide): AxisDirection {
	return pierSide === 'EAST' ? -1 : 1
}
