import { DEFAULT_REFRACTION_PARAMETERS, observedToCirs, type RefractionParameters, refractedAltitude } from '../../astronomy/coordinates/astrometry'
import { eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import type { GeographicPosition } from '../../astronomy/observer/location'
import { cirsRotationMatrix, type Time } from '../../astronomy/time/time'
import { PI } from '../../core/constants'
import { validateFinite, validateVector } from '../../core/validation'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecAngleUnit, vecCross, vecDot, vecLength, vecNormalize, vecNormalizeMut, vecRotateByRodrigues } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'

// Shared polar-alignment geometry in the inertial frame used by plate solutions. The module locates
// the refracted observing target, applies the two physical mount-base rotations, and decomposes a
// spherical error into signed mechanical tangent components. All angles are radians and returned
// vectors are newly allocated unit vectors.

// Minimum usable vector or tangent-axis length for public polar-alignment geometry.
const VECTOR_EPSILON = 1e-14

// Maximum accepted absolute dot product between normalized mount adjustment axes.
const AXIS_ORTHOGONALITY_TOLERANCE = 1e-10

// Angular distance from the antipode below which the spherical logarithm is undefined.
const ANTIPODAL_EPSILON = 1e-10

// Exact signed decomposition of a polar error in the mount's local tangent directions.
export interface PolarAlignmentErrorComponents {
	// Great-circle separation between the current and target poles, in radians.
	readonly total: Angle
	// Signed component along positive azimuth adjustment, in radians.
	readonly azimuth: Angle
	// Signed component along positive altitude adjustment, in radians.
	readonly altitude: Angle
}

// Computes the celestial-pole direction in the inertial J2000/ICRS frame used by plate solutions.
// `location` is geodetic and angles are radians. Refraction changes the observed target altitude;
// passing `false` selects the geometric pole. The returned vector is normalized and newly allocated.
export function celestialPoleVector(time: Time, location: GeographicPosition = time.location!, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS): Vec3 {
	const azimuth = location.latitude >= 0 ? 0 : PI
	const trueAltitude = Math.abs(location.latitude)
	const altitude = refraction === false ? trueAltitude : refractedAltitude(trueAltitude, refraction)
	const [rightAscension, declination] = observedToCirs(azimuth, altitude, time, refraction, location)
	return vecNormalizeMut(matTransposeMulVec(cirsRotationMatrix(time), eraS2c(rightAscension, declination)))
}

// Applies azimuth about local up, then altitude about the east axis carried by the rotated mount
// base. Inputs are inertial vectors and angles are radians. The returned unit vector is fresh.
export function applyMountAdjustment(vector: Vec3, upAxis: Vec3, eastAxis: Vec3, azimuth: Angle, altitude: Angle): Vec3 {
	validateAdjustmentGeometry(vector, upAxis, eastAxis, azimuth, altitude)
	const afterAzimuth = vecRotateByRodrigues(vector, upAxis, azimuth)
	const altitudeAxis = vecRotateByRodrigues(eastAxis, upAxis, azimuth)
	return vecNormalizeMut(vecRotateByRodrigues(afterAzimuth, altitudeAxis, altitude))
}

// Applies the inverse of `applyMountAdjustment`. Inputs are inertial vectors and angles are radians;
// rotations are undone in reverse order and the returned unit vector is fresh.
export function applyInverseMountAdjustment(vector: Vec3, upAxis: Vec3, eastAxis: Vec3, azimuth: Angle, altitude: Angle): Vec3 {
	validateAdjustmentGeometry(vector, upAxis, eastAxis, azimuth, altitude)
	const altitudeAxis = vecRotateByRodrigues(eastAxis, upAxis, azimuth)
	const beforeAltitude = vecRotateByRodrigues(vector, altitudeAxis, -altitude)
	return vecNormalizeMut(vecRotateByRodrigues(beforeAltitude, upAxis, -azimuth))
}

// Decomposes `currentPole -> targetPole` with the exact spherical logarithm at the target. The
// tangent basis follows positive azimuth (`up × target`) and altitude (`east × target`) mount
// rotations. Returns undefined for zero, antipodal, or mechanically singular geometry.
export function decomposePolarErrorGeodesic(currentPole: Vec3, targetPole: Vec3, upAxis: Vec3, eastAxis: Vec3): PolarAlignmentErrorComponents | undefined {
	if (!isFiniteNonZeroVector(currentPole) || !isFiniteNonZeroVector(targetPole) || !isFiniteNonZeroVector(upAxis) || !isFiniteNonZeroVector(eastAxis)) return undefined

	const current = vecNormalize(currentPole)
	const target = vecNormalize(targetPole)
	const total = vecAngleUnit(target, current)
	if (!Number.isFinite(total) || PI - total <= ANTIPODAL_EPSILON) return undefined
	if (total <= VECTOR_EPSILON) return { total: 0, azimuth: 0, altitude: 0 }

	const azimuthTangent = vecCross(upAxis, target)
	const azimuthLength = vecLength(azimuthTangent)
	if (!Number.isFinite(azimuthLength) || azimuthLength <= VECTOR_EPSILON) return undefined
	azimuthTangent[0] /= azimuthLength
	azimuthTangent[1] /= azimuthLength
	azimuthTangent[2] /= azimuthLength

	const altitudeDerivative = vecCross(eastAxis, target)
	const projection = vecDot(altitudeDerivative, azimuthTangent)
	const altitudeTangent: [number, number, number] = [altitudeDerivative[0] - projection * azimuthTangent[0], altitudeDerivative[1] - projection * azimuthTangent[1], altitudeDerivative[2] - projection * azimuthTangent[2]]
	const altitudeLength = vecLength(altitudeTangent)
	if (!Number.isFinite(altitudeLength) || altitudeLength <= VECTOR_EPSILON) return undefined
	altitudeTangent[0] /= altitudeLength
	altitudeTangent[1] /= altitudeLength
	altitudeTangent[2] /= altitudeLength

	const dot = Math.max(-1, Math.min(1, vecDot(target, current)))
	const sin = Math.sin(total)
	const scale = total < 1e-6 ? 1 + (total * total) / 6 : total / sin
	const tangentX = scale * (current[0] - dot * target[0])
	const tangentY = scale * (current[1] - dot * target[1])
	const tangentZ = scale * (current[2] - dot * target[2])
	const azimuth = tangentX * azimuthTangent[0] + tangentY * azimuthTangent[1] + tangentZ * azimuthTangent[2]
	const altitude = tangentX * altitudeTangent[0] + tangentY * altitudeTangent[1] + tangentZ * altitudeTangent[2]

	if (!Number.isFinite(azimuth) || !Number.isFinite(altitude)) return undefined
	return { total, azimuth, altitude }
}

// Validates vectors and angles used by the public rigid mount transformations. The axes may be
// unnormalized but must be finite, non-zero, and mutually orthogonal within the documented tolerance.
function validateAdjustmentGeometry(vector: Vec3, upAxis: Vec3, eastAxis: Vec3, azimuth: Angle, altitude: Angle): void {
	validateVector(vector)
	validateVector(upAxis)
	validateVector(eastAxis)
	validateFinite(azimuth)
	validateFinite(altitude)

	const vectorLength = vecLength(vector)
	const upLength = vecLength(upAxis)
	const eastLength = vecLength(eastAxis)
	if (!Number.isFinite(vectorLength) || !Number.isFinite(upLength) || !Number.isFinite(eastLength) || vectorLength <= VECTOR_EPSILON || upLength <= VECTOR_EPSILON || eastLength <= VECTOR_EPSILON) throw new RangeError('polar-alignment vectors and axes must be finite and non-zero')
	const normalizedDot = vecDot(upAxis, eastAxis) / (upLength * eastLength)
	if (!Number.isFinite(normalizedDot) || Math.abs(normalizedDot) > AXIS_ORTHOGONALITY_TOLERANCE) throw new RangeError('mount adjustment axes must be orthogonal')
}

// Reports whether a vector is finite and has a numerically meaningful direction.
function isFiniteNonZeroVector(vector: Vec3): boolean {
	const length = vecLength(vector)
	return Number.isFinite(vector[0]) && Number.isFinite(vector[1]) && Number.isFinite(vector[2]) && Number.isFinite(length) && length > VECTOR_EPSILON
}
