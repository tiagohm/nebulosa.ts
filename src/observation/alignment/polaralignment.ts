import { cirsToObserved, DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters, refractedAltitude } from '../../astronomy/coordinates/astrometry'
import type { HorizontalCoordinate } from '../../astronomy/coordinates/coordinate'
import { eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { applyEquatorialPointingError, polarAlignmentPointingModel } from '../../astronomy/coordinates/pointing'
import type { GeographicPosition } from '../../astronomy/observer/location'
import { cirsRotationMatrix, gcrsToItrsRotationMatrix, type Time } from '../../astronomy/time/time'
import { PI } from '../../core/constants'
import { matMulVec, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecCross, vecDivScalarMut, vecDot, vecLength, vecMinus, vecNegateMut, vecNormalizeMut, vecPlane } from '../../math/linear-algebra/vec3'
import { type Angle, normalizePI } from '../../math/units/angle'
import { applyMountAdjustment } from './polaralignment.util'

// Three-Point Polar Alignment Algorithm (ICRF-based)

// This implementation performs polar alignment using a three-point plate solving method entirely in the inertial ICRF (J2000) reference frame.
// All geometric computations are done in ICRF to avoid time-dependent distortions caused by precession, nutation, or Earth rotation.
// Conversion to observed (horizontal) coordinates is performed only at the final stage for user feedback.

// Result of a three-point polar alignment, with the mount pole in horizontal coordinates and the
// signed azimuth/altitude errors and applied adjustments. All angles are radians.
export interface ThreePointPolarAlignmentResult extends Readonly<HorizontalCoordinate> {
	// Mount-pole azimuth error relative to the true pole (radians); positive sense per hemisphere.
	readonly azimuthError: Angle
	// Mount-pole altitude error relative to the refracted celestial-pole altitude (radians).
	readonly altitudeError: Angle
	// Unit normal of the plane through the three ICRF reference points, i.e. the mount pole direction.
	readonly pole: Vec3
	// Azimuth knob delta inferred from the last correction step (radians); 0 on initial estimate.
	readonly azimuthAdjustment: Angle
	// Altitude knob delta inferred from the last correction step (radians); 0 on initial estimate.
	readonly altitudeAdjustment: Angle
}

// Unnormalized plane-normal length below which the three ICRF points are coincident or
// collinear, so the mount pole is undefined. A vanishing normal would otherwise survive
// vecNormalize and become a fake equatorial direction in cirsToObserved.
const DEGENERATE_POLE_NORMAL = 1e-14

// Altitude (radians) of the true celestial pole as the alignment target: the absolute latitude,
// optionally raised by atmospheric refraction so it matches the observed pole position.
function referencePoleAltitude(location: GeographicPosition, refraction: RefractionParameters | false) {
	return refraction === false ? Math.abs(location.latitude) : refractedAltitude(Math.abs(location.latitude), refraction)
}

// Converts an ICRF mount-pole direction to observed azimuth/altitude and signed polar-alignment
// errors at `time`. `pole` is a unit vector; the returned `pole` aliases it. `azimuthAdjustment`
// and `altitudeAdjustment` are the last inferred knob deltas in radians, and stay 0 on the
// initial estimate and when the plate-solve center did not move.
function observedPolarAlignment(pole: Vec3, time: Time, refraction: RefractionParameters | false, location: GeographicPosition, azimuthAdjustment: Angle = 0, altitudeAdjustment: Angle = 0): ThreePointPolarAlignmentResult {
	const isNorthern = location.latitude > 0
	const { azimuth, altitude } = cirsToObserved(matMulVec(cirsRotationMatrix(time), pole), time, refraction, location)
	const latitude = referencePoleAltitude(location, refraction)
	const azimuthError = isNorthern ? normalizePI(azimuth) : normalizePI(azimuth + PI)
	const altitudeError = isNorthern ? altitude - latitude : latitude - altitude
	return { azimuth, altitude, pole, azimuthError, altitudeError, azimuthAdjustment, altitudeAdjustment }
}

// https://sourceforge.net/p/sky-simulator/code/ci/default/tree/sky_annotation.pas#l1189
// Polar error calculation based on two celestial reference points and the error of the telescope mount at these point(s).
// Based on formulas from Ralph Pass documented at https://rppass.com/align.pdf.
// They are based on the book "Telescope Control" by Trueblood and Genet, p.111
// Ralph added sin(latitude) term in the equation for the error in RA.
//
// Expressed through the shared TPoint model in `astronomy/coordinates/pointing`, which carries the
// same terms and clamps the declination away from the pole, where tan diverges and the hour-angle
// error would otherwise come back meaningless.
export function polarAlignmentError(rightAscension: Angle, declination: Angle, latitude: Angle, lst: Angle, azimuthError: Angle, altitudeError: Angle): readonly [Angle, Angle] {
	return applyEquatorialPointingError(rightAscension, declination, lst, polarAlignmentPointingModel(azimuthError, altitudeError, latitude))
}

// Computes the initial polar-alignment error from three plate-solved ICRF points (each [RA, Dec] in
// radians) captured while slewing only in RA. The three points define a small circle whose plane
// normal is the mount's rotation axis; comparing that axis to the true pole yields the azimuth and
// altitude errors. The geometry is done in ICRF and converted to observed coordinates only at the end.
// Returns false when two or more points coincide or the plane normal vanishes, because the mount
// pole is then undefined and a zero normal would become a plausible equatorial direction.
export function threePointPolarAlignmentError(p1: readonly [Angle, Angle], p2: readonly [Angle, Angle], p3: readonly [Angle, Angle], time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicPosition = time.location!): ThreePointPolarAlignmentResult | false {
	const pole = vecPlane(eraS2c(...p1), eraS2c(...p2), eraS2c(...p3))
	// Coincident or collinear plate-solves leave no unique plane; see DEGENERATE_POLE_NORMAL.
	const length = vecLength(pole)
	if (length <= DEGENERATE_POLE_NORMAL) return false

	vecDivScalarMut(pole, length)

	// Compute pole ⋅ Z to ensure the mount pole is pointing "up" (above the horizon)
	const isNorthern = location.latitude > 0
	if ((pole[2] < 0 && isNorthern) || (pole[2] > 0 && !isNorthern)) vecNegateMut(pole)

	return observedPolarAlignment(pole, time, refraction, location)
}

// Recomputes polar alignment after a mechanical correction step.
// We infer how much the user moved azimuth/altitude knobs from the star displacement (from -> to),
// apply that constrained correction to the current pole, then recompute displayed errors.
// The pole is rotated with the same rigid composition as `applyMountAdjustment`: azimuth about
// local up, then altitude about the east axis carried by the rotated base. A generic 3D rotation
// from one star vector is underconstrained and caused systematic drift; applying altitude about
// the original east axis disagrees with the overlay by O(az·alt).
// When the plate-solve center does not move, the previous pole is kept and the observed
// azimuth/altitude are recomputed at `time` so the displayed place follows Earth rotation.
export function threePointPolarAlignmentAfterAdjustment(
	result: ThreePointPolarAlignmentResult, // 3rd measurement image alignment result
	from: readonly [Angle, Angle], // 3rd measurement image solution ICRF coordinates
	to: readonly [Angle, Angle], // actual measurement image solution ICRF coordinates
	time: Time,
	refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS,
	location: GeographicPosition = time.location!,
): ThreePointPolarAlignmentResult {
	// Convert both solved positions to ICRF vectors so we can compare the actual sky displacement.
	const fromVec = eraS2c(from[0], from[1])
	const toVec = eraS2c(to[0], to[1])

	// No meaningful movement in plate-solve center: keep the pole, refresh the observed place.
	if (vecLength(vecMinus(toVec, fromVec)) <= 1e-12) return observedPolarAlignment(result.pole, time, refraction, location)

	// Build local mechanical axes and solve the knob deltas that best explain from -> to.
	const { upAxis, eastAxis } = mountAdjustmentAxes(time, location)
	const { azimuthAdjustment, altitudeAdjustment } = solveAzAltAdjustment(fromVec, toVec, upAxis, eastAxis)
	const pole = applyMountAdjustment(result.pole, upAxis, eastAxis, azimuthAdjustment, altitudeAdjustment)
	return observedPolarAlignment(pole, time, refraction, location, azimuthAdjustment, altitudeAdjustment)
}

// Builds the two mechanical correction axes in ICRF for the given instant/location:
// azimuth knob rotates around local "up", altitude knob around local east-west.
// This was needed because the previous approach inferred a generic 3D rotation from one star vector,
// which is underconstrained and produced systematic azimuth drift after adjustments.
export function mountAdjustmentAxes(time: Time, { longitude, latitude }: GeographicPosition) {
	const cosLat = Math.cos(latitude)
	const sinLat = Math.sin(latitude)
	const cosLon = Math.cos(longitude)
	const sinLon = Math.sin(longitude)

	const upItrs: Vec3 = [cosLat * cosLon, cosLat * sinLon, sinLat]
	const eastItrs: Vec3 = [-sinLon, cosLon, 0]
	const gcrsToItrs = gcrsToItrsRotationMatrix(time)
	const upAxis = vecNormalizeMut(matTransposeMulVec(gcrsToItrs, upItrs))
	const eastAxis = vecNormalizeMut(matTransposeMulVec(gcrsToItrs, eastItrs))

	return { upAxis, eastAxis } as const
}

// Estimates knob deltas (azimuth/altitude) that best explain the observed star displacement.
// We solve a 2x2 least-squares system in the tangent space, constrained to mount mechanics,
// instead of applying an unconstrained Rodrigues rotation from "from -> to".
export function solveAzAltAdjustment(from: Vec3, to: Vec3, upAxis: Vec3, eastAxis: Vec3) {
	// Small-angle least squares in the tangent space around fromVec:
	// d ≈ az * (up × from) + alt * (east × from).
	const azBasis = vecCross(upAxis, from)
	const altBasis = vecCross(eastAxis, from)
	const dx = to[0] - from[0]
	const dy = to[1] - from[1]
	const dz = to[2] - from[2]
	const a11 = vecDot(azBasis, azBasis)
	const a12 = vecDot(azBasis, altBasis)
	const a22 = vecDot(altBasis, altBasis)
	const y1 = azBasis[0] * dx + azBasis[1] * dy + azBasis[2] * dz
	const y2 = altBasis[0] * dx + altBasis[1] * dy + altBasis[2] * dz
	const det = a11 * a22 - a12 * a12

	// Degenerate geometry (nearly collinear basis): keep previous pole to avoid unstable jumps.
	if (Math.abs(det) <= 1e-18) return { azimuthAdjustment: 0, altitudeAdjustment: 0 }

	const azimuthAdjustment = (y1 * a22 - y2 * a12) / det
	const altitudeAdjustment = (-y1 * a12 + y2 * a11) / det

	return { azimuthAdjustment, altitudeAdjustment } as const
}

// Stateful driver for an interactive three-point polar alignment session: collect the first three
// plate solves to seed the error, then feed each subsequent solve to refine it after the user adjusts
// the mount knobs.
export class ThreePointPolarAlignment {
	// The three seed reference points ([RA, Dec] in radians).
	readonly #points = new Array<readonly [Angle, Angle]>(3)

	// Count of points added so far; the first three seed the estimate, later ones refine it.
	#position = 0
	// Last solved point used as the "from" reference for the next adjustment step, or false before seeding.
	#referencePoint: readonly [Angle, Angle] | false = false
	// Most recent alignment result, or false until three points are collected.
	#currentError: ThreePointPolarAlignmentResult | false = false

	constructor(readonly refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS) {}

	// Adds a plate-solved point ([RA, Dec] radians) at the given time and returns the current alignment
	// result, or false while fewer than three points have been collected or the three seed points are
	// coincident or collinear. A degenerate third point leaves the session without an estimate;
	// call `reset` before starting again.
	add(rightAscension: Angle, declination: Angle, time: Time) {
		const point = [rightAscension, declination] as const

		if (this.#position < 3) {
			this.#points[this.#position] = point
		}

		this.#position++

		// When we have three points, compute the initial polar alignment error.
		// After that, each new point is used to compute the adjusted error
		if (this.#position === 3) {
			this.#currentError = threePointPolarAlignmentError(this.#points[0], this.#points[1], this.#points[2], time, this.refraction)
			if (this.#currentError !== false) this.#referencePoint = this.#points[2]
		} else if (this.#position > 3 && this.#currentError !== false && this.#referencePoint !== false) {
			this.#currentError = threePointPolarAlignmentAfterAdjustment(this.#currentError, this.#referencePoint, point, time, this.refraction)
			this.#referencePoint = point
		}

		return this.#currentError
	}

	// Clears all collected points and results to start a fresh alignment session.
	reset() {
		this.#position = 0
		this.#referencePoint = false
		this.#currentError = false
	}
}
