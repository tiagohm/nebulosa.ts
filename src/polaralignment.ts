import { type Angle, normalizePI } from './angle'
import { cirsToObserved, DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters, refractedAltitude } from './astrometry'
import { PI } from './constants'
import type { HorizontalCoordinate } from './coordinate'
import { eraS2c } from './erfa'
import type { GeographicPosition } from './location'
import { matMulVec, matTransposeMulVec } from './mat3'
import { gcrsToItrsRotationMatrix, precessionNutationMatrix, type Time } from './time'
import { type Vec3, vecCross, vecDot, vecLength, vecMinus, vecNegateMut, vecNormalizeMut, vecPlane, vecRotateByRodrigues } from './vec3'

// Three-Point Polar Alignment Algorithm (ICRF-based)

// This implementation performs polar alignment using a three-point plate solving method entirely in the inertial ICRF (J2000) reference frame.
// All geometric computations are done in ICRF to avoid time-dependent distortions caused by precession, nutation, or Earth rotation.
// Conversion to observed (horizontal) coordinates is performed only at the final stage for user feedback.

// Thanks to Codex!

export interface ThreePointPolarAlignmentResult extends Readonly<HorizontalCoordinate> {
	readonly azimuthError: Angle
	readonly altitudeError: Angle
	readonly pole: Vec3 // Normal vector of the plane defined by the three points
	readonly azimuthAdjustment: Angle
	readonly altitudeAdjustment: Angle
}

function referencePoleAltitude(location: GeographicPosition, refraction: RefractionParameters | false) {
	return refraction === false ? Math.abs(location.latitude) : refractedAltitude(Math.abs(location.latitude), refraction)
}

// https://sourceforge.net/p/sky-simulator/code/ci/default/tree/sky_annotation.pas#l1189
// Polar error calculation based on two celestial reference points and the error of the telescope mount at these point(s).
// Based on formulas from Ralph Pass documented at https://rppass.com/align.pdf.
// They are based on the book "Telescope Control" by Trueblood and Genet, p.111
// Ralph added sin(latitude) term in the equation for the error in RA.
export function polarAlignmentError(rightAscension: Angle, declination: Angle, latitude: Angle, lst: Angle, azimuthError: Angle, altitudeError: Angle): readonly [Angle, Angle] {
	const ha = lst - rightAscension
	const cosHA = Math.cos(ha)
	const sinHA = Math.sin(ha)
	const tanDEC = Math.tan(declination)
	const cosLat = Math.cos(latitude)
	const sinLat = Math.sin(latitude)
	const dRA = -altitudeError * (tanDEC * sinHA) + azimuthError * (sinLat - cosLat * tanDEC * cosHA)
	const dDEC = -altitudeError * cosHA + azimuthError * cosLat * sinHA
	return [rightAscension - dRA, declination + dDEC]
}

export function threePointPolarAlignmentError(p1: readonly [Angle, Angle], p2: readonly [Angle, Angle], p3: readonly [Angle, Angle], time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicPosition = time.location!): ThreePointPolarAlignmentResult {
	const isNorthern = location.latitude > 0

	// The normal vector is the direction of the mount pole
	const pole = vecNormalizeMut(vecPlane(eraS2c(...p1), eraS2c(...p2), eraS2c(...p3)))

	// Compute pole ⋅ Z to ensure the mount pole is pointing "up" (above the horizon)
	if ((pole[2] < 0 && isNorthern) || (pole[2] > 0 && !isNorthern)) vecNegateMut(pole)

	// Find the azimuth and altitude of the mount pole (normal to the plane defined by the three reference stars)
	const { azimuth, altitude } = cirsToObserved(matMulVec(precessionNutationMatrix(time), pole), time, refraction, location)

	// Compute the azimuth and altitude error
	const latitude = referencePoleAltitude(location, refraction)
	const azimuthError = isNorthern ? normalizePI(azimuth) : normalizePI(azimuth + PI)
	const altitudeError = isNorthern ? altitude - latitude : latitude - altitude

	return { azimuth, altitude, pole, azimuthError, altitudeError, azimuthAdjustment: 0, altitudeAdjustment: 0 }
}

// Recomputes polar alignment after a mechanical correction step.
// We infer how much the user moved azimuth/altitude knobs from the star displacement (from -> to),
// apply that constrained correction to the current pole, then recompute displayed errors.
// This was needed because mapping one vector displacement to a generic 3D rotation is underconstrained
// and caused systematic drift in the reported azimuth/altitude error.
export function threePointPolarAlignmentAfterAdjustment(
	result: ThreePointPolarAlignmentResult, // 3rd measurement image alignment result
	from: readonly [Angle, Angle], // 3rd measurement image solution ICRF coordinates
	to: readonly [Angle, Angle], // actual measurement image solution ICRF coordinates
	time: Time,
	refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS,
	location: GeographicPosition = time.location!,
): ThreePointPolarAlignmentResult | false {
	const isNorthern = location.latitude > 0

	// Convert both solved positions to ICRF vectors so we can compare the actual sky displacement.
	const fromVec = eraS2c(from[0], from[1])
	const toVec = eraS2c(to[0], to[1])

	// No meaningful movement in plate-solve center: keep the previous estimate.
	if (vecLength(vecMinus(toVec, fromVec)) <= 1e-12) return result

	// Build local mechanical axes and solve the knob deltas that best explain from -> to.
	const { upAxis, eastAxis } = mountAdjustmentAxes(time, location)
	const { azimuthAdjustment, altitudeAdjustment } = solveAzAltAdjustment(fromVec, toVec, upAxis, eastAxis)

	// Apply constrained correction on the current pole: azimuth around local up, altitude around local east-west.
	const newPole = vecRotateByRodrigues(vecRotateByRodrigues(result.pole, upAxis, azimuthAdjustment), eastAxis, altitudeAdjustment)
	const { azimuth, altitude } = cirsToObserved(matMulVec(precessionNutationMatrix(time), newPole), time, refraction, location)

	// Recompute the azimuth and altitude error
	const latitude = referencePoleAltitude(location, refraction)
	const azimuthError = isNorthern ? normalizePI(azimuth) : normalizePI(azimuth + PI)
	const altitudeError = isNorthern ? altitude - latitude : latitude - altitude

	return { azimuth, altitude, pole: newPole, azimuthError, altitudeError, azimuthAdjustment, altitudeAdjustment }
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

export class ThreePointPolarAlignment {
	readonly #points = new Array<readonly [Angle, Angle]>(3)

	#position = 0
	#referencePoint: readonly [Angle, Angle] | false = false
	#currentError: ThreePointPolarAlignmentResult | false = false

	constructor(readonly refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS) {}

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
			this.#referencePoint = this.#points[2]
		} else if (this.#position > 3 && this.#currentError !== false && this.#referencePoint !== false) {
			this.#currentError = threePointPolarAlignmentAfterAdjustment(this.#currentError, this.#referencePoint, point, time, this.refraction)
			if (this.#currentError !== false) this.#referencePoint = point
		}

		return this.#currentError
	}

	reset() {
		this.#position = 0
		this.#referencePoint = false
		this.#currentError = false
	}
}
