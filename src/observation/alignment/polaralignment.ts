import { cirsToObserved, DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters, refractedAltitude } from '../../astronomy/coordinates/astrometry'
import type { HorizontalCoordinate } from '../../astronomy/coordinates/coordinate'
import { eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { applyEquatorialPointingError, polarAlignmentPointingModel } from '../../astronomy/coordinates/pointing'
import type { GeographicPosition } from '../../astronomy/observer/location'
import { cirsRotationMatrix, gcrsToItrsRotationMatrix, type Time, Timescale, timeSubtract } from '../../astronomy/time/time'
import { DAYSEC, PI, SIDEREAL_DRIFT_RATE } from '../../core/constants'
import { matMulVec, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecCross, vecDivScalarMut, vecDot, vecLength, vecMinus, vecNegateMut, vecNormalizeMut, vecPlane, vecRotateByRodrigues } from '../../math/linear-algebra/vec3'
import { type Angle, normalizePI } from '../../math/units/angle'
import { applyMountAdjustment } from './polaralignment.util'

// Three-point polar alignment from timestamped ICRF/J2000 plate solves. The mechanical axis is
// fixed to the Earth between base adjustments; samples are transported to a common epoch before
// fitting it. Refreshes remove tracking about that axis before inferring azimuth/altitude adjustments.
// Angles are radians. Geometry allocates vectors and results retain their exposure Time; an unchanged
// same-epoch refresh may reuse its pole. Refraction affects the displayed pole and target altitudes.

export type ThreePointPolarAlignmentInput = readonly [Angle, Angle, Time]

// Result of a three-point polar alignment, with the mount pole in horizontal coordinates and the
// signed azimuth/altitude errors and applied adjustments. All angles are radians.
export interface ThreePointPolarAlignmentResult extends Readonly<HorizontalCoordinate> {
	// Exposure epoch of the ICRF pole and the reference plate solve used by the next refresh.
	readonly time: Time
	// Mount-pole azimuth error relative to the true pole (radians); positive sense per hemisphere.
	readonly azimuthError: Angle
	// Mount-pole altitude error relative to the refracted celestial-pole altitude (radians).
	readonly altitudeError: Angle
	// Unit direction of the above-horizon mechanical pole in ICRF at `time`.
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

// Re-expresses an ICRF direction attached to the Earth from `from` to `to`, preserving its ITRS
// orientation. Returns `vector` itself when the Time object is unchanged, otherwise a fresh vector.
function transportEarthFixed(vector: Vec3, from: Time, to: Time): Vec3 {
	if (from === to) return vector
	const transported = matMulVec(gcrsToItrsRotationMatrix(from), vector)
	return matTransposeMulVec(gcrsToItrsRotationMatrix(to), transported, transported)
}

// Altitude (radians) of the true celestial pole as the alignment target: the absolute latitude,
// optionally raised by atmospheric refraction so it matches the observed pole position.
function referencePoleAltitude(location: GeographicPosition, refraction: RefractionParameters | false) {
	return refraction === false ? Math.abs(location.latitude) : refractedAltitude(Math.abs(location.latitude), refraction)
}

// Converts an ICRF mount-pole direction to observed azimuth/altitude and signed polar-alignment
// errors at `time`. `pole` is a unit vector; the returned `pole` aliases it. `azimuthAdjustment`
// and `altitudeAdjustment` are the last inferred knob deltas in radians, and stay 0 on the
// initial estimate and when no base adjustment is detected.
function observedPolarAlignment(pole: Vec3, time: Time, refraction: RefractionParameters | false, location: GeographicPosition, azimuthAdjustment: Angle = 0, altitudeAdjustment: Angle = 0): ThreePointPolarAlignmentResult {
	const isNorthern = location.latitude >= 0
	const { azimuth, altitude } = cirsToObserved(matMulVec(cirsRotationMatrix(time), pole), time, refraction, location)
	const latitude = referencePoleAltitude(location, refraction)
	const azimuthError = isNorthern ? normalizePI(azimuth) : normalizePI(azimuth + PI)
	const altitudeError = isNorthern ? altitude - latitude : latitude - altitude
	return { time, azimuth, altitude, pole, azimuthError, altitudeError, azimuthAdjustment, altitudeAdjustment }
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
// altitude errors. `time` is the third exposure; `firstTimes` supplies the first two exposure epochs,
// defaulting to `time` for simultaneous samples. Base adjustments and the declination setting must
// remain unchanged; RA slewing and tracking are allowed. Each sample is transported with
// Earth rotation to the third epoch before fitting the plane. The returned ICRF pole is at `time`.
// Returns false when two or more points coincide or the plane normal vanishes, because the mount
// pole is then undefined and a zero normal would become a plausible equatorial direction.
export function threePointPolarAlignmentError(p1: ThreePointPolarAlignmentInput, p2: ThreePointPolarAlignmentInput, p3: ThreePointPolarAlignmentInput, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicPosition = p3[2].location!): ThreePointPolarAlignmentResult | false {
	const time = p3[2]
	const first = transportEarthFixed(eraS2c(p1[0], p1[1]), p1[2], time) as MutVec3
	const second = transportEarthFixed(eraS2c(p2[0], p2[1]), p2[2], time)
	const pole = vecPlane(first, second, eraS2c(p3[0], p3[1]), first)

	// Coincident or collinear plate-solves leave no unique plane; see DEGENERATE_POLE_NORMAL.
	const length = vecLength(pole)
	if (length <= DEGENERATE_POLE_NORMAL) return false

	vecDivScalarMut(pole, length)

	// Compute pole ⋅ Z to ensure the mount pole is pointing "up" (above the horizon)
	const isNorthern = location.latitude >= 0
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
// `from` belongs to `result.time`, `to` to `time`; both are ICRF RA/Dec in radians. Transport the
// Earth-fixed pole and predict the tracked boresight before interpreting any residual as an adjustment.
// `trackingRate` is the constant RA motor speed in radians per SI second: sidereal by default, 0
// with tracking off. Positive follows sidereal tracking in either hemisphere. No DEC motion,
// guiding, dithering, pier-side changes or rate changes are allowed between these exposures.
// Uses small-adjustment least squares; degenerate adjustment geometry retains the transported pole.
// Returns a result at `time`; an unchanged same-epoch refresh may alias `result.pole`. Input results
// and coordinates are not mutated. Measurement error can be amplified near singular adjustment geometry.
export function threePointPolarAlignmentAfterAdjustment(
	result: ThreePointPolarAlignmentResult, // 3rd measurement image alignment result
	from: ThreePointPolarAlignmentInput, // 3rd measurement image solution ICRF coordinates
	to: ThreePointPolarAlignmentInput, // actual measurement image solution ICRF coordinates
	refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS,
	location: GeographicPosition = to[2].location!,
	trackingRate: Angle = SIDEREAL_DRIFT_RATE,
): ThreePointPolarAlignmentResult {
	const time = to[2]
	const elapsedSeconds = timeSubtract(time, result.time, Timescale.TAI) * DAYSEC
	const transportedPole = transportEarthFixed(result.pole, result.time, time)
	const transportedFrom = transportEarthFixed(eraS2c(from[0], from[1]), result.time, time) as MutVec3
	// Tracking turns the boresight westwards in ITRS about a north-pointing RA axis. The reported pole points
	// south in the southern hemisphere, which reverses the Rodrigues angle, not the motor rate.
	const trackingAngle = (location.latitude >= 0 ? -1 : 1) * trackingRate * elapsedSeconds
	const fromVec = trackingAngle === 0 ? transportedFrom : vecRotateByRodrigues(transportedFrom, transportedPole, trackingAngle, transportedFrom)
	const toVec = eraS2c(to[0], to[1])

	// No residual beyond tracking: retain the transported mechanical pole.
	if (vecLength(vecMinus(toVec, fromVec)) <= 1e-12) return observedPolarAlignment(transportedPole, time, refraction, location)

	// Build local mechanical axes and solve the knob deltas that best explain from -> to.
	const { upAxis, eastAxis } = mountAdjustmentAxes(time, location)
	const { azimuthAdjustment, altitudeAdjustment } = solveAzAltAdjustment(fromVec, toVec, upAxis, eastAxis)
	const pole = applyMountAdjustment(transportedPole, upAxis, eastAxis, azimuthAdjustment, altitudeAdjustment)
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
	readonly #points = new Array<ThreePointPolarAlignmentInput>(3)

	// Count of points added so far; the first three seed the estimate, later ones refine it.
	#position = 0
	// Last solved point used as the "from" reference for the next adjustment step, or false before seeding.
	#referencePoint: ThreePointPolarAlignmentInput | false = false
	// Most recent alignment result, or false until three points are collected.
	#currentError: ThreePointPolarAlignmentResult | false = false

	// Starts a session using the given atmospheric model and constant tracking speed (radians per
	// SI second, sidereal by default, 0 when tracking is off). The motor may slew in RA for seeding;
	// only tracking and small base adjustments are allowed after the third exposure.
	constructor(
		readonly refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS,
		readonly trackingRate: Angle = SIDEREAL_DRIFT_RATE,
	) {}

	// Adds a plate-solved point ([RA, Dec] radians) at the given time and returns the current alignment
	// result at that exposure epoch, or false while fewer than three points have been collected or the
	// three transported seed points are coincident or collinear. A degenerate third point leaves no estimate;
	// call `reset` before starting again.
	add(rightAscension: Angle, declination: Angle, time: Time) {
		const point = [rightAscension, declination, time] as const

		if (this.#position < 3) {
			this.#points[this.#position] = point
		}

		this.#position++

		// When we have three points, compute the initial polar alignment error.
		// After that, each new point is used to compute the adjusted error
		if (this.#position === 3) {
			this.#currentError = threePointPolarAlignmentError(this.#points[0], this.#points[1], this.#points[2], this.refraction, time.location)
			if (this.#currentError !== false) this.#referencePoint = this.#points[2]
		} else if (this.#position > 3 && this.#currentError !== false && this.#referencePoint !== false) {
			this.#currentError = threePointPolarAlignmentAfterAdjustment(this.#currentError, this.#referencePoint, point, this.refraction, time.location, this.trackingRate)
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
