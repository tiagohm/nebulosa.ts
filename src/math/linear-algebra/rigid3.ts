import { validateFinite, validateVector } from '../../core/validation'
import type { Angle } from '../units/angle'
import { matIdentity, matMul, matMulVec, matRodriguesRotation, matTranspose, type Mat3 } from './mat3'
import { type MutVec3, vecLength, vecMinus, vecNegate, vecPlus, vecZero, type Vec3 } from './vec3'

// Active three-dimensional rigid transforms represented by a rotation and translation. Transforms
// map points between frames in the same distance unit; directions are rotated without translation.

// An active rigid transform mapping coordinates from a source frame into a destination frame.
export interface RigidTransform3 {
	// Proper orthogonal active rotation from source to destination.
	readonly rotation: Mat3
	// Destination-frame translation applied after rotation, in the unit of transformed points.
	readonly translation: Vec3
}

// Returns a newly allocated identity transform.
export function rigidIdentity(): RigidTransform3 {
	return { rotation: matIdentity(), translation: vecZero() }
}

// Composes transforms so the returned transform applies before, followed by after.
export function rigidCompose(after: Readonly<RigidTransform3>, before: Readonly<RigidTransform3>): RigidTransform3 {
	const rotation = matMul(after.rotation, before.rotation)
	const translation = vecPlus(matMulVec(after.rotation, before.translation), after.translation)
	return { rotation, translation }
}

// Inverts a proper rigid transform using the rotation transpose.
export function rigidInverse(transform: Readonly<RigidTransform3>): RigidTransform3 {
	const rotation = matTranspose(transform.rotation)
	const translation = vecNegate(matMulVec(rotation, transform.translation))
	return { rotation, translation }
}

// Transforms a point and writes into out when supplied; the returned value aliases out, which may
// also alias the input point or transform translation.
export function rigidTransformPoint(transform: Readonly<RigidTransform3>, point: Vec3, out?: MutVec3): MutVec3 {
	const translationX = transform.translation[0]
	const translationY = transform.translation[1]
	const translationZ = transform.translation[2]
	const result = matMulVec(transform.rotation, point, out)
	result[0] += translationX
	result[1] += translationY
	result[2] += translationZ
	return result
}

// Transforms a direction without translation or normalization and writes into out when supplied.
export function rigidTransformDirection(transform: Readonly<RigidTransform3>, direction: Vec3, out?: MutVec3): MutVec3 {
	return matMulVec(transform.rotation, direction, out)
}

// Builds an active right-handed rotation around the line through pivot along axis.
// The pivot uses the caller's distance unit, axis magnitude is ignored, and angle is in radians.
export function rigidRotationAroundAxis(pivot: Vec3, axis: Vec3, angle: Angle): RigidTransform3 {
	validateVector(pivot)
	validateVector(axis)
	validateFinite(angle)

	if (vecLength(axis) === 0) throw new RangeError('axis must be non-zero')

	const rotation = matRodriguesRotation(axis, angle)
	const translation: MutVec3 = [0, 0, 0]
	vecMinus(pivot, matMulVec(rotation, pivot, translation), translation)
	return { rotation, translation }
}
