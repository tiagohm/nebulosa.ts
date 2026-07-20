import { validateFinite, validatePositiveFinite, validateVector } from '../../core/validation'
import { type Vec3, vecDot, vecLength, vecMinus, vecNormalize, vecPlus, vecMulScalar } from '../../math/linear-algebra/vec3'
import { normalizeAngle, normalizePI, type Angle } from '../../math/units/angle'
import { mountPoseFromEncoders, type MountEncoderPosition, type MountPose, type TwoAxisMountGeometry } from '../mount/kinematics'

// Pure spherical-dome geometry driven by a physical optical ray. Points and distances are metres;
// azimuth is north through east in ENU and rotations contain no device or timing state.

// Forward optical ray in a shared Cartesian frame.
export interface OpticalRay {
	// Ray origin in metres.
	readonly origin: Vec3
	// Non-zero forward direction; magnitude is ignored.
	readonly direction: Vec3
}

// Spherical enclosure and its azimuth-command convention.
export interface SphericalDomeGeometry {
	// Sphere center in the optical ray frame, in metres.
	readonly center: Vec3
	// Positive sphere radius in metres.
	readonly radius: number
	// Command value corresponding to geometric azimuth zero, in radians.
	readonly azimuthOffset?: Angle
	// Sign mapping geometric azimuth to command azimuth; defaults to +1.
	readonly azimuthDirection?: 1 | -1
}

// First strictly forward ray intersection with a sphere.
export interface RaySphereIntersection {
	// Intersection point in the ray frame, in metres.
	readonly point: Vec3
	// Distance from ray origin along the normalized direction, in metres.
	readonly distance: number
}

// Dome slit position and corresponding controller azimuth.
export interface DomeSlitSolution extends RaySphereIntersection {
	// Geometric azimuth north through east around the dome center, in radians.
	readonly azimuth: Angle
	// Geometric altitude above the dome-center horizon, in radians.
	readonly altitude: Angle
	// Offset- and direction-adjusted command azimuth normalized to 0..TAU, in radians.
	readonly commandAzimuth: Angle
}

// Relative tolerance used only to clamp a slightly negative tangency discriminant to zero.
const DISCRIMINANT_RELATIVE_EPSILON = 64 * Number.EPSILON

// Relative distance below which a root is treated as the ray origin rather than a forward hit.
const FORWARD_DISTANCE_RELATIVE_EPSILON = 64 * Number.EPSILON

// Returns the nearest strictly forward intersection of a ray with a sphere, or undefined when the
// line misses or both roots are non-forward. Direction is normalized so distance remains metres.
export function intersectRaySphere(ray: Readonly<OpticalRay>, center: Vec3, radius: number): RaySphereIntersection | undefined {
	validateVector(ray.origin)
	validateVector(ray.direction)
	validateVector(center)
	validatePositiveFinite(radius)
	if (vecLength(ray.direction) === 0) throw new RangeError('ray.direction must be non-zero')
	const direction = vecNormalize(ray.direction)
	const relative = vecMinus(ray.origin, center)
	const b = vecDot(relative, direction)
	const c = vecDot(relative, relative) - radius * radius
	let discriminant = b * b - c
	const discriminantScale = Math.max(b * b, Math.abs(c), radius * radius)
	if (discriminant < -DISCRIMINANT_RELATIVE_EPSILON * discriminantScale) return undefined
	if (discriminant < 0) discriminant = 0
	const root = Math.sqrt(discriminant)
	const near = -b - root
	const far = -b + root
	const minimumDistance = FORWARD_DISTANCE_RELATIVE_EPSILON * Math.max(radius, vecLength(relative))
	let distance: number
	if (near > minimumDistance) distance = near
	else if (far > minimumDistance) distance = far
	else return undefined
	return { point: vecPlus(ray.origin, vecMulScalar(direction, distance)), distance }
}

// Solves the physical slit position from an optical ray and spherical dome geometry.
export function solveDomeSlit(ray: Readonly<OpticalRay>, dome: Readonly<SphericalDomeGeometry>): DomeSlitSolution | undefined {
	validateDome(dome)
	const intersection = intersectRaySphere(ray, dome.center, dome.radius)
	if (!intersection) return undefined
	const relative = vecMinus(intersection.point, dome.center)
	const azimuth = normalizeAngle(Math.atan2(relative[0], relative[1]))
	const altitude = Math.atan2(relative[2], Math.hypot(relative[0], relative[1]))
	const commandAzimuth = normalizeAngle((dome.azimuthDirection ?? 1) * azimuth + (dome.azimuthOffset ?? 0))
	return { ...intersection, azimuth, altitude, commandAzimuth }
}

// Exposes a mount pose's physical optical origin and direction as a ray without copying them.
export function mountPoseToOpticalRay(pose: Readonly<MountPose>): OpticalRay {
	return { origin: pose.origin, direction: pose.direction }
}

// Computes a mount pose and solves its physical optical ray against a spherical dome.
export function solveDomeSlitFromMount(geometry: Readonly<TwoAxisMountGeometry>, encoders: Readonly<MountEncoderPosition>, dome: Readonly<SphericalDomeGeometry>): DomeSlitSolution | undefined {
	return solveDomeSlit(mountPoseToOpticalRay(mountPoseFromEncoders(geometry, encoders)), dome)
}

// Returns the shortest signed command correction target-current in [-PI,PI] radians.
export function domeAzimuthError(current: Angle, target: Angle): Angle {
	validateFinite(current)
	validateFinite(target)
	return normalizePI(target - current)
}

// Returns whether the shortest command correction strictly exceeds a non-negative tolerance.
export function isDomeMoveRequired(current: Angle, target: Angle, tolerance: Angle): boolean {
	validateFinite(tolerance)
	if (tolerance < 0) throw new RangeError('tolerance must be non-negative')
	return Math.abs(domeAzimuthError(current, target)) > tolerance
}

// Validates finite sphere and command-convention fields.
function validateDome(dome: Readonly<SphericalDomeGeometry>): void {
	validateVector(dome.center)
	validatePositiveFinite(dome.radius)
	validateFinite(dome.azimuthOffset ?? 0)
	if (dome.azimuthDirection !== undefined && dome.azimuthDirection !== 1 && dome.azimuthDirection !== -1) throw new RangeError('azimuthDirection must be 1 or -1')
}
