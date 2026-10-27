import { eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { gcrsToItrsRotationMatrix } from '../../astronomy/time/time'
import { DEG2RAD } from '../../core/constants'
import { matMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecAngleUnit, vecLatitude, vecLength, vecPlane } from '../../math/linear-algebra/vec3'
import { type Angle, normalizePI } from '../../math/units/angle'
import type { PolarAlignmentDirection } from './polaralignment'
import type { ThreePointPolarAlignmentInput } from './tppa'

// Conditioning of the three timestamped plate solves that seed a three-point polar alignment. Each
// sample is expressed in the Earth-fixed ITRS frame at its own exposure epoch, which is the common
// frame of the mechanical axis, so samples taken minutes apart compare without tracking drift.
// The mount's RA rotation is measured about the celestial pole (ITRS +Z): with the small polar
// errors this workflow corrects, it equals the rotation about the mechanical axis to first order.
// The pole recovered from three points on a circle has an error of about 2.4·σ/φ² radians for a
// per-axis astrometric error σ and a rotation φ (radians) between consecutive samples, independent
// of declination, so acceptance is driven by rotation; sky separation and the chord area only
// guard against astrometric noise and non-RA motion. All angles are radians; nothing is mutated.

// Limits that decide whether timestamped samples form a usable three-point geometry.
export interface PolarAlignmentGeometryLimits {
	// Rotation aimed at between consecutive accepted samples, in radians; positive.
	readonly targetRotation: Angle
	// Smallest accepted rotation between consecutive samples, in radians; at most `targetRotation`.
	readonly minimumRotation: Angle
	// Largest rotation from the first sample to any later sample, in radians.
	readonly maximumRotation: Angle
	// Smallest accepted great-circle separation between consecutive samples, in radians.
	readonly minimumSeparation: Angle
	// Smallest accepted sine of the angle between the two chords from the first sample.
	readonly minimumQuality: number
	// Largest accepted change of declination about the celestial pole between samples, in radians.
	readonly maximumDeclinationChange: Angle
	// Smallest accepted angular distance of a sample from the celestial pole, in radians.
	readonly minimumPolarDistance: Angle
	// Rotation in the opposite direction above which the motion is reversed, in radians.
	readonly reversalTolerance: Angle
}

// Default geometry limits. Rotation of 8° (6° minimum) keeps the seed pole within about one
// arcminute for 0.5″ plate solves; 30° bounds the total mechanical motion. The 2° declination
// change tolerates polar errors of about 4° over 30° of rotation and still catches DEC motion.
// Fields within 10° of the pole make the rotation about +Z differ from the mechanical rotation.
export const DEFAULT_POLAR_ALIGNMENT_GEOMETRY_LIMITS: Readonly<PolarAlignmentGeometryLimits> = {
	targetRotation: 8 * DEG2RAD,
	minimumRotation: 6 * DEG2RAD,
	maximumRotation: 30 * DEG2RAD,
	minimumSeparation: 1 * DEG2RAD,
	minimumQuality: 0.05,
	maximumDeclinationChange: 2 * DEG2RAD,
	minimumPolarDistance: 10 * DEG2RAD,
	reversalTolerance: 0.1 * DEG2RAD,
}

// Reason a sample or a three-point geometry was rejected. `insufficientRotation` and
// `insufficientSeparation` can be cured by moving further in the same direction; the others cannot.
export type PolarAlignmentGeometryRejection = 'nearPole' | 'insufficientRotation' | 'insufficientSeparation' | 'reversedRotation' | 'excessiveRotation' | 'declinationChanged' | 'collinear'

// Measured displacement from one sample to another.
export interface PolarAlignmentDisplacement {
	// Signed rotation about the celestial pole, in (-PI, PI] radians; positive towards the west.
	readonly rotation: Angle
	// Great-circle separation of the two plate-solve centers in the Earth-fixed frame, in radians.
	readonly separation: Angle
	// Change of declination about the celestial pole (target minus source), in radians.
	readonly declinationChange: Angle
}

// Outcome of classifying a candidate sample against the previously accepted one.
export type PolarAlignmentCandidateClassification =
	| {
			readonly accepted: true
			// Displacement from the previously accepted sample.
			readonly displacement: Readonly<PolarAlignmentDisplacement>
			// Signed rotation from the first sample, in radians; positive towards the west.
			readonly totalRotation: Angle
	  }
	| {
			readonly accepted: false
			// Displacement from the previously accepted sample.
			readonly displacement: Readonly<PolarAlignmentDisplacement>
			// Signed rotation from the first sample, in radians; positive towards the west.
			readonly totalRotation: Angle
			// Why the candidate was not accepted.
			readonly reason: PolarAlignmentGeometryRejection
			// Whether moving further in the same direction can still produce an acceptable sample.
			readonly retry: boolean
	  }

// Conditioning metrics of three samples and whether they may seed the alignment.
export interface PolarAlignmentGeometryQuality {
	// Separation between the first and second samples, in radians.
	readonly separation12: Angle
	// Separation between the second and third samples, in radians.
	readonly separation23: Angle
	// Separation between the first and third samples, in radians.
	readonly separation13: Angle
	// Signed rotation from the first to the second sample, in radians; positive towards the west.
	readonly rotation12: Angle
	// Signed rotation from the second to the third sample, in radians; positive towards the west.
	readonly rotation23: Angle
	// Signed rotation from the first to the third sample, in radians; positive towards the west.
	readonly rotation13: Angle
	// Length of the cross product of the two chords from the first sample (unit-sphere chords, so
	// dimensionless); reported for diagnostics, it shrinks with cos² of the declination.
	readonly area: number
	// Sine of the angle between the two chords from the first sample, in [0, 1].
	readonly quality: number
	// Whether the three samples may seed the alignment.
	readonly acceptable: boolean
	// Why the samples were rejected; absent when acceptable.
	readonly reason?: PolarAlignmentGeometryRejection
}

// Expresses a timestamped ICRF plate solve as a unit vector of the Earth-fixed ITRS frame at its
// exposure epoch. The returned vector is fresh.
export function polarAlignmentEarthFixedVector(sample: ThreePointPolarAlignmentInput): Vec3 {
	return matMulVec(gcrsToItrsRotationMatrix(sample[2]), eraS2c(sample[0], sample[1]))
}

// Angular distance of an Earth-fixed unit vector from the north or south celestial pole, whichever
// is nearer, in [0, PI/2] radians.
export function polarAlignmentPolarDistance(vector: Vec3): Angle {
	return Math.atan2(Math.hypot(vector[0], vector[1]), Math.abs(vector[2]))
}

// Measures the displacement between two timestamped plate solves in the Earth-fixed frame. The
// rotation is the change of hour angle: a westward motion lowers the Earth-fixed longitude of the
// boresight, so the sign of the longitude change is reversed.
export function polarAlignmentDisplacement(from: ThreePointPolarAlignmentInput, to: ThreePointPolarAlignmentInput): PolarAlignmentDisplacement {
	return displacement(polarAlignmentEarthFixedVector(from), polarAlignmentEarthFixedVector(to))
}

// Classifies a candidate against the first and the previously accepted samples. A candidate is
// accepted once it moved at least the minimum rotation and separation in `direction` without
// exceeding the total rotation or changing declination. `first` and `previous` may be the same
// sample, as when classifying the second sample.
export function classifyPolarAlignmentCandidate(
	first: ThreePointPolarAlignmentInput,
	previous: ThreePointPolarAlignmentInput,
	candidate: ThreePointPolarAlignmentInput,
	direction: PolarAlignmentDirection,
	limits: Readonly<PolarAlignmentGeometryLimits> = DEFAULT_POLAR_ALIGNMENT_GEOMETRY_LIMITS,
): PolarAlignmentCandidateClassification {
	const sign = direction === 'WEST' ? 1 : -1
	const firstVector = polarAlignmentEarthFixedVector(first)
	const previousVector = previous === first ? firstVector : polarAlignmentEarthFixedVector(previous)
	const candidateVector = polarAlignmentEarthFixedVector(candidate)
	const step = displacement(previousVector, candidateVector)
	const total = displacement(firstVector, candidateVector)
	const totalRotation = total.rotation
	const rejected = (reason: PolarAlignmentGeometryRejection, retry: boolean): PolarAlignmentCandidateClassification => ({ accepted: false, displacement: step, totalRotation, reason, retry })

	if (polarAlignmentPolarDistance(candidateVector) < limits.minimumPolarDistance) return rejected('nearPole', false)
	if (!(Math.abs(total.declinationChange) <= limits.maximumDeclinationChange)) return rejected('declinationChanged', false)
	if (sign * step.rotation < -limits.reversalTolerance) return rejected('reversedRotation', false)
	if (!(sign * totalRotation <= limits.maximumRotation)) return rejected('excessiveRotation', false)
	if (sign * step.rotation < limits.minimumRotation) return rejected('insufficientRotation', true)
	if (step.separation < limits.minimumSeparation) return rejected('insufficientSeparation', true)
	return { accepted: true, displacement: step, totalRotation }
}

// Evaluates the conditioning of three timestamped samples taken while rotating only in RA in
// `direction`. The geometry is acceptable when every consecutive rotation and separation reaches
// its minimum in that direction, the total rotation stays within its maximum, no sample is near
// the pole or changed declination, and the chords from the first sample are far from collinear.
export function polarAlignmentGeometryQuality(p1: ThreePointPolarAlignmentInput, p2: ThreePointPolarAlignmentInput, p3: ThreePointPolarAlignmentInput, direction: PolarAlignmentDirection, limits: Readonly<PolarAlignmentGeometryLimits> = DEFAULT_POLAR_ALIGNMENT_GEOMETRY_LIMITS): PolarAlignmentGeometryQuality {
	const sign = direction === 'WEST' ? 1 : -1
	const v1 = polarAlignmentEarthFixedVector(p1)
	const v2 = polarAlignmentEarthFixedVector(p2)
	const v3 = polarAlignmentEarthFixedVector(p3)
	const d12 = displacement(v1, v2)
	const d23 = displacement(v2, v3)
	const d13 = displacement(v1, v3)

	const chord12 = Math.hypot(v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2])
	const chord13 = Math.hypot(v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2])
	const area = vecLength(vecPlane(v1, v2, v3))
	const denominator = chord12 * chord13
	// Coincident samples leave no angle between the chords; report them as collinear.
	const quality = denominator > 0 ? Math.min(1, area / denominator) : 0

	const metrics = { separation12: d12.separation, separation23: d23.separation, separation13: d13.separation, rotation12: d12.rotation, rotation23: d23.rotation, rotation13: d13.rotation, area, quality }
	const rejected = (reason: PolarAlignmentGeometryRejection): PolarAlignmentGeometryQuality => ({ ...metrics, acceptable: false, reason })

	if (polarAlignmentPolarDistance(v1) < limits.minimumPolarDistance || polarAlignmentPolarDistance(v2) < limits.minimumPolarDistance || polarAlignmentPolarDistance(v3) < limits.minimumPolarDistance) return rejected('nearPole')
	if (!(Math.abs(d12.declinationChange) <= limits.maximumDeclinationChange && Math.abs(d13.declinationChange) <= limits.maximumDeclinationChange)) return rejected('declinationChanged')
	if (sign * d12.rotation < -limits.reversalTolerance || sign * d23.rotation < -limits.reversalTolerance) return rejected('reversedRotation')
	if (!(sign * d13.rotation <= limits.maximumRotation)) return rejected('excessiveRotation')
	if (sign * d12.rotation < limits.minimumRotation || sign * d23.rotation < limits.minimumRotation) return rejected('insufficientRotation')
	if (d12.separation < limits.minimumSeparation || d23.separation < limits.minimumSeparation) return rejected('insufficientSeparation')
	if (!(quality >= limits.minimumQuality)) return rejected('collinear')
	return { ...metrics, acceptable: true }
}

// Displacement between two Earth-fixed unit vectors; see `polarAlignmentDisplacement`.
function displacement(from: Vec3, to: Vec3): PolarAlignmentDisplacement {
	const rotation = -normalizePI(Math.atan2(to[1], to[0]) - Math.atan2(from[1], from[0]))
	const declinationChange = vecLatitude(to) - vecLatitude(from)
	return { rotation, separation: vecAngleUnit(from, to), declinationChange }
}
