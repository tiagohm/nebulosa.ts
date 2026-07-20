import { PI } from '../../core/constants'
import { validateFinite, validateVector } from '../../core/validation'
import { matMulVec, matRodriguesRotation } from '../../math/linear-algebra/mat3'
import { rigidIdentity, rigidRotationAroundAxis, rigidTransformDirection, rigidTransformPoint, type RigidTransform3 } from '../../math/linear-algebra/rigid3'
import { type MutVec3, vecClone, vecCross, vecCrossLength, vecDot, vecLength, vecMinus, vecNormalize, type Vec3, vecNegateMut } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'

// Forward and inverse kinematics for a serial two-axis telescope mount. Geometry is expressed in a
// mount base frame at encoder zero, points are metres, and active rotations map into a world frame.

// Physical zero-state geometry and encoder conventions of a serial two-axis mount.
export interface TwoAxisMountGeometry {
	// Absolute active rigid transform from the mount base frame to the world frame.
	readonly baseToWorld: RigidTransform3
	// Primary-axis pivot in the base frame, in metres.
	readonly primaryPivot: Vec3
	// Non-zero primary-axis direction in the base frame.
	readonly primaryAxis: Vec3
	// Secondary-axis pivot in the base frame before primary rotation, in metres.
	readonly secondaryPivot: Vec3
	// Non-zero secondary-axis direction in the base frame before primary rotation.
	readonly secondaryAxis: Vec3
	// Optical-ray origin in the base frame at encoder zero, in metres.
	readonly opticalOrigin: Vec3
	// Non-zero optical direction in the base frame at encoder zero.
	readonly opticalDirection: Vec3
	// Primary physical zero offset in radians.
	readonly primaryIndex?: Angle
	// Secondary physical zero offset in radians.
	readonly secondaryIndex?: Angle
	// Sign mapping the primary encoder angle to its physical right-handed rotation.
	readonly primaryDirection?: 1 | -1
	// Sign mapping the secondary encoder angle to its physical right-handed rotation.
	readonly secondaryDirection?: 1 | -1
}

// Two encoder angles in radians, kept unwrapped around the selected mechanical branch.
export interface MountEncoderPosition {
	// Primary encoder angle in radians.
	readonly primary: Angle
	// Secondary encoder angle in radians.
	readonly secondary: Angle
}

// World-frame pose of the mount optical ray and both physical axes.
export interface MountPose {
	// Optical-ray origin in the world frame, in metres.
	readonly origin: Vec3
	// Unit optical direction in the world frame.
	readonly direction: Vec3
	// Unit primary-axis direction in the world frame.
	readonly primaryAxis: Vec3
	// Unit secondary-axis direction in the world frame at the requested primary angle.
	readonly secondaryAxis: Vec3
	// Secondary-axis pivot in the world frame at the requested primary angle, in metres.
	readonly secondaryPivot: Vec3
}

// Optional constraints and numerical controls for inverse kinematics.
export interface MountEncoderSolveOptions {
	// Seed selecting the local encoder branch; defaults to both encoders at zero.
	readonly initial?: MountEncoderPosition
	// Maximum Gauss-Newton iterations; defaults to 32.
	readonly maxIterations?: number
	// Required angular residual in radians; defaults to 1e-10.
	readonly tolerance?: Angle
	// Inclusive unwrapped primary encoder range in radians.
	readonly primaryRange?: readonly [Angle, Angle]
	// Inclusive unwrapped secondary encoder range in radians.
	readonly secondaryRange?: readonly [Angle, Angle]
	// Maximum Euclidean encoder step per iteration in radians; defaults to PI/12.
	readonly maxStep?: Angle
}

// Best encoder position returned by inverse kinematics, including convergence diagnostics.
export interface MountEncoderSolution extends MountEncoderPosition {
	// Whether residual is no greater than the requested tolerance.
	readonly converged: boolean
	// Number of accepted or attempted Gauss-Newton iterations.
	readonly iterations: number
	// Smallest angular separation found between current and target directions, in radians.
	readonly residual: Angle
}

// Optional locations and encoder conventions shared by ideal canonical mount factories.
export interface CanonicalMountGeometryOptions {
	// Absolute active rigid transform from the canonical base frame to the world frame.
	readonly baseToWorld?: RigidTransform3
	// Primary pivot in the base frame, in metres; defaults to the origin.
	readonly primaryPivot?: Vec3
	// Secondary pivot in the base frame, in metres; defaults to the origin.
	readonly secondaryPivot?: Vec3
	// Optical-ray origin in the base frame, in metres; defaults to the origin.
	readonly opticalOrigin?: Vec3
	// Primary physical zero offset in radians; defaults to zero.
	readonly primaryIndex?: Angle
	// Secondary physical zero offset in radians; defaults to zero.
	readonly secondaryIndex?: Angle
	// Primary encoder sign overriding the canonical convention.
	readonly primaryDirection?: 1 | -1
	// Secondary encoder sign overriding the canonical convention.
	readonly secondaryDirection?: 1 | -1
}

// Default maximum number of inverse-kinematics iterations.
const DEFAULT_MAX_ITERATIONS = 32

// Default inverse-kinematics angular convergence threshold in radians.
const DEFAULT_TOLERANCE = 1e-10

// Default maximum Euclidean encoder update in radians.
const DEFAULT_MAX_STEP = PI / 12

// Relative determinant threshold used to reject a locally rank-deficient 3x2 Jacobian.
const JACOBIAN_RELATIVE_EPSILON = 64 * Number.EPSILON

// Maximum number of step halvings used when a full Gauss-Newton update increases residual.
const MAX_BACKTRACKING_STEPS = 16

// Computes the complete world-frame pose for finite encoder angles.
export function mountPoseFromEncoders(geometry: Readonly<TwoAxisMountGeometry>, encoders: Readonly<MountEncoderPosition>): MountPose {
	validateGeometry(geometry)
	validateEncoders(encoders)
	return mountPoseFromEncodersUnchecked(geometry, encoders)
}

// Computes a pose after the public boundary has validated stable geometry and encoder values.
function mountPoseFromEncodersUnchecked(geometry: Readonly<TwoAxisMountGeometry>, encoders: Readonly<MountEncoderPosition>): MountPose {
	const primaryAngle = physicalPrimaryAngle(geometry, encoders.primary)
	const secondaryAngle = physicalSecondaryAngle(geometry, encoders.secondary)
	const primaryTransform = rigidRotationAroundAxis(geometry.primaryPivot, geometry.primaryAxis, primaryAngle)
	const secondaryPivotBase = rigidTransformPoint(primaryTransform, geometry.secondaryPivot)
	const secondaryAxisBase = rigidTransformDirection(primaryTransform, geometry.secondaryAxis)
	const opticalOriginBase = rigidTransformPoint(primaryTransform, geometry.opticalOrigin)
	const opticalDirectionBase = rigidTransformDirection(primaryTransform, geometry.opticalDirection)
	const secondaryTransform = rigidRotationAroundAxis(secondaryPivotBase, secondaryAxisBase, secondaryAngle)
	const origin = rigidTransformPoint(geometry.baseToWorld, rigidTransformPoint(secondaryTransform, opticalOriginBase))
	const direction = vecNormalize(rigidTransformDirection(geometry.baseToWorld, rigidTransformDirection(secondaryTransform, opticalDirectionBase)))
	const primaryAxis = vecNormalize(rigidTransformDirection(geometry.baseToWorld, geometry.primaryAxis))
	const secondaryAxis = vecNormalize(rigidTransformDirection(geometry.baseToWorld, secondaryAxisBase))
	const secondaryPivot = rigidTransformPoint(geometry.baseToWorld, secondaryPivotBase)
	return { origin, direction, primaryAxis, secondaryAxis, secondaryPivot }
}

// Computes only the unit world-frame optical direction and writes into out when supplied.
export function mountDirectionFromEncoders(geometry: Readonly<TwoAxisMountGeometry>, encoders: Readonly<MountEncoderPosition>, out?: MutVec3): MutVec3 {
	validateGeometry(geometry)
	validateEncoders(encoders)
	const primaryRotation = matRodriguesRotation(geometry.primaryAxis, physicalPrimaryAngle(geometry, encoders.primary))
	const secondaryAxis = matMulVec(primaryRotation, geometry.secondaryAxis)
	const direction = matMulVec(primaryRotation, geometry.opticalDirection, out)
	matMulVec(matRodriguesRotation(secondaryAxis, physicalSecondaryAngle(geometry, encoders.secondary)), direction, direction)
	rigidTransformDirection(geometry.baseToWorld, direction, direction)
	return vecNormalize(direction, direction)
}

// Solves locally for encoder angles whose optical direction matches a non-zero world direction.
// Multiple mechanical branches may exist; callers should provide and compare admissible seeds.
export function solveMountEncoders(geometry: Readonly<TwoAxisMountGeometry>, worldDirection: Vec3, options: Readonly<MountEncoderSolveOptions> = {}): MountEncoderSolution {
	validateGeometry(geometry)
	validateVector(worldDirection)
	if (vecLength(worldDirection) === 0) throw new RangeError('worldDirection must be non-zero')
	const target = vecNormalize(worldDirection)
	const controls = solveControls(options)
	let primary = clampToRange(options.initial?.primary ?? 0, controls.primaryRange)
	let secondary = clampToRange(options.initial?.secondary ?? 0, controls.secondaryRange)
	let pose = mountPoseFromEncodersUnchecked(geometry, { primary, secondary })
	let residual = directionResidual(pose.direction, target)
	let bestPrimary = primary
	let bestSecondary = secondary
	let bestResidual = residual
	let iterations = 0
	if (residual <= controls.tolerance) return makeSolution(primary, secondary, true, 0, residual)

	for (let iteration = 0; iteration < controls.maxIterations; iteration++) {
		iterations = iteration + 1
		const primaryJacobian = vecCross(pose.primaryAxis, pose.direction)
		const secondaryJacobian = vecCross(pose.secondaryAxis, pose.direction)
		if ((geometry.primaryDirection ?? 1) < 0) vecNegateMut(primaryJacobian)
		if ((geometry.secondaryDirection ?? 1) < 0) vecNegateMut(secondaryJacobian)
		const error = vecMinus(target, pose.direction)
		const aa = vecDot(primaryJacobian, primaryJacobian)
		const ab = vecDot(primaryJacobian, secondaryJacobian)
		const bb = vecDot(secondaryJacobian, secondaryJacobian)
		const determinant = aa * bb - ab * ab
		const determinantScale = Math.max(aa * bb, ab * ab)
		if (!(determinantScale > 0) || determinant <= JACOBIAN_RELATIVE_EPSILON * determinantScale) break

		const ar = vecDot(primaryJacobian, error)
		const br = vecDot(secondaryJacobian, error)
		let primaryStep = (ar * bb - br * ab) / determinant
		let secondaryStep = (br * aa - ar * ab) / determinant
		const stepLength = Math.hypot(primaryStep, secondaryStep)
		if (!Number.isFinite(stepLength) || stepLength === 0) break
		if (stepLength > controls.maxStep) {
			const scale = controls.maxStep / stepLength
			primaryStep *= scale
			secondaryStep *= scale
		}

		let accepted = false
		let candidatePrimary = primary
		let candidateSecondary = secondary
		let candidatePose = pose
		let candidateResidual = residual

		for (let backtracking = 0; backtracking <= MAX_BACKTRACKING_STEPS; backtracking++) {
			candidatePrimary = clampToRange(primary + primaryStep, controls.primaryRange)
			candidateSecondary = clampToRange(secondary + secondaryStep, controls.secondaryRange)
			if (candidatePrimary === primary && candidateSecondary === secondary) break
			candidatePose = mountPoseFromEncodersUnchecked(geometry, { primary: candidatePrimary, secondary: candidateSecondary })
			candidateResidual = directionResidual(candidatePose.direction, target)
			if (candidateResidual < residual) {
				accepted = true
				break
			}
			primaryStep *= 0.5
			secondaryStep *= 0.5
		}

		if (!accepted) break

		primary = candidatePrimary
		secondary = candidateSecondary
		pose = candidatePose
		residual = candidateResidual

		if (residual < bestResidual) {
			bestPrimary = primary
			bestSecondary = secondary
			bestResidual = residual
		}

		if (residual <= controls.tolerance) return makeSolution(primary, secondary, true, iteration + 1, residual)
	}

	return makeSolution(bestPrimary, bestSecondary, false, iterations, bestResidual)
}

// Creates an ideal altitude-azimuth geometry in ENU: azimuth is north through east and altitude is
// elevation above the horizon. Custom pivots and optical origins are expressed in metres.
export function createIdealAltAzGeometry(options: Readonly<CanonicalMountGeometryOptions> = {}): TwoAxisMountGeometry {
	return createCanonicalGeometry(options, [0, 0, 1], [1, 0, 0], [0, 1, 0], -1, 1)
}

// Creates a canonical equatorial geometry in the Taki frame. The primary encoder is west-positive
// hour angle and the secondary encoder is declination, both in radians.
export function createCanonicalEquatorialGeometry(options: Readonly<CanonicalMountGeometryOptions> = {}): TwoAxisMountGeometry {
	return createCanonicalGeometry(options, [0, 0, 1], [0, 1, 0], [1, 0, 0], -1, -1)
}

// Parsed and validated controls used internally by the inverse solver.
interface MountEncoderSolveControls {
	// Positive iteration cap.
	readonly maxIterations: number
	// Non-negative target residual in radians.
	readonly tolerance: Angle
	// Positive maximum encoder step in radians.
	readonly maxStep: Angle
	// Optional inclusive primary range in radians.
	readonly primaryRange?: readonly [Angle, Angle]
	// Optional inclusive secondary range in radians.
	readonly secondaryRange?: readonly [Angle, Angle]
}

// Validates and materializes inverse-solver defaults.
function solveControls(options: Readonly<MountEncoderSolveOptions>): MountEncoderSolveControls {
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE
	const maxStep = options.maxStep ?? DEFAULT_MAX_STEP
	if (!Number.isInteger(maxIterations) || maxIterations <= 0) throw new RangeError('maxIterations must be a positive integer')
	validateFinite(tolerance)
	validateFinite(maxStep)
	if (tolerance < 0) throw new RangeError('tolerance must be non-negative')
	if (maxStep <= 0) throw new RangeError('maxStep must be positive')
	validateRange(options.primaryRange, 'primaryRange')
	validateRange(options.secondaryRange, 'secondaryRange')
	if (options.initial) validateEncoders(options.initial)
	return { maxIterations, tolerance, maxStep, primaryRange: options.primaryRange, secondaryRange: options.secondaryRange }
}

// Validates one optional finite inclusive encoder range.
function validateRange(range: readonly [Angle, Angle] | undefined, name: string): void {
	if (!range) return
	validateFinite(range[0])
	validateFinite(range[1])
	if (range[0] > range[1]) throw new RangeError(`${name} must be ordered`)
}

// Validates all finite geometry fields and non-zero physical directions.
function validateGeometry(geometry: Readonly<TwoAxisMountGeometry>): void {
	validateVector(geometry.baseToWorld.translation)
	for (let i = 0; i < 9; i++) validateFinite(geometry.baseToWorld.rotation[i])
	validateVector(geometry.primaryPivot)
	validateVector(geometry.primaryAxis)
	validateVector(geometry.secondaryPivot)
	validateVector(geometry.secondaryAxis)
	validateVector(geometry.opticalOrigin)
	validateVector(geometry.opticalDirection)
	if (vecLength(geometry.primaryAxis) === 0 || vecLength(geometry.secondaryAxis) === 0 || vecLength(geometry.opticalDirection) === 0) throw new RangeError('mount axes and optical direction must be non-zero')
	validateFinite(geometry.primaryIndex ?? 0)
	validateFinite(geometry.secondaryIndex ?? 0)
	if (geometry.primaryDirection !== undefined && geometry.primaryDirection !== 1 && geometry.primaryDirection !== -1) throw new RangeError('primaryDirection must be 1 or -1')
	if (geometry.secondaryDirection !== undefined && geometry.secondaryDirection !== 1 && geometry.secondaryDirection !== -1) throw new RangeError('secondaryDirection must be 1 or -1')
}

// Validates one finite pair of encoder angles.
function validateEncoders(encoders: Readonly<MountEncoderPosition>): void {
	validateFinite(encoders.primary)
	validateFinite(encoders.secondary)
}

// Converts a primary encoder angle into its physical active rotation in radians.
function physicalPrimaryAngle(geometry: Readonly<TwoAxisMountGeometry>, encoder: Angle): Angle {
	return (geometry.primaryDirection ?? 1) * encoder + (geometry.primaryIndex ?? 0)
}

// Converts a secondary encoder angle into its physical active rotation in radians.
function physicalSecondaryAngle(geometry: Readonly<TwoAxisMountGeometry>, encoder: Angle): Angle {
	return (geometry.secondaryDirection ?? 1) * encoder + (geometry.secondaryIndex ?? 0)
}

// Computes stable angular separation between unit directions in radians.
function directionResidual(current: Vec3, target: Vec3): Angle {
	return Math.atan2(vecCrossLength(current, target), Math.max(-1, Math.min(1, vecDot(current, target))))
}

// Restricts an unwrapped encoder angle to an optional inclusive range.
function clampToRange(value: Angle, range?: readonly [Angle, Angle]): Angle {
	return range ? Math.max(range[0], Math.min(range[1], value)) : value
}

// Constructs one immutable-shaped inverse-solver result.
function makeSolution(primary: Angle, secondary: Angle, converged: boolean, iterations: number, residual: Angle): MountEncoderSolution {
	return { primary, secondary, converged, iterations, residual }
}

// Creates one canonical geometry while copying mutable point inputs.
function createCanonicalGeometry(options: Readonly<CanonicalMountGeometryOptions>, primaryAxis: Vec3, secondaryAxis: Vec3, opticalDirection: Vec3, primaryDirection: 1 | -1, secondaryDirection: 1 | -1): TwoAxisMountGeometry {
	const geometry: TwoAxisMountGeometry = {
		baseToWorld: options.baseToWorld ?? rigidIdentity(),
		primaryPivot: vecClone(options.primaryPivot ?? [0, 0, 0]),
		primaryAxis,
		secondaryPivot: vecClone(options.secondaryPivot ?? [0, 0, 0]),
		secondaryAxis,
		opticalOrigin: vecClone(options.opticalOrigin ?? [0, 0, 0]),
		opticalDirection,
		primaryIndex: options.primaryIndex,
		secondaryIndex: options.secondaryIndex,
		primaryDirection: options.primaryDirection ?? primaryDirection,
		secondaryDirection: options.secondaryDirection ?? secondaryDirection,
	}
	validateGeometry(geometry)
	return geometry
}
