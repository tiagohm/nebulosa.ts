import { expect, test } from 'bun:test'
import { PIOVERTWO } from '../../../src/core/constants'
import { matRodriguesRotation } from '../../../src/math/linear-algebra/mat3'
import { rigidCompose, rigidIdentity, rigidInverse, rigidRotationAroundAxis, rigidTransformDirection, rigidTransformPoint, type RigidTransform3 } from '../../../src/math/linear-algebra/rigid3'
import type { MutVec3 } from '../../../src/math/linear-algebra/vec3'

// Tests active rigid-transform composition, inversion, point/direction semantics, and aliasing.

// Compares one three-component vector at the requested decimal precision.
function expectVectorClose(actual: readonly number[], expected: readonly number[], precision: number = 12): void {
	for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], precision)
}

test('identity preserves points and directions', () => {
	const transform = rigidIdentity()
	expect(rigidTransformPoint(transform, [1, -2, 3])).toEqual([1, -2, 3])
	expect(rigidTransformDirection(transform, [1, -2, 3])).toEqual([1, -2, 3])
})

test('translation affects points but not directions', () => {
	const transform: RigidTransform3 = {
		rotation: matRodriguesRotation([0, 0, 1], PIOVERTWO),
		translation: [3, 4, 5],
	}

	expectVectorClose(rigidTransformPoint(transform, [1, 0, 0]), [3, 5, 5])
	expectVectorClose(rigidTransformDirection(transform, [1, 0, 0]), [0, 1, 0])
})

test('composition applies before and then after', () => {
	const before: RigidTransform3 = { rotation: matRodriguesRotation([0, 0, 1], PIOVERTWO), translation: [1, 0, 0] }
	const after: RigidTransform3 = { rotation: matRodriguesRotation([1, 0, 0], PIOVERTWO), translation: [0, 2, 0] }
	const point = [2, 3, 4] as const
	const sequential = rigidTransformPoint(after, rigidTransformPoint(before, point))
	expectVectorClose(rigidTransformPoint(rigidCompose(after, before), point), sequential)
})

test('inverse round-trips points and directions', () => {
	const transform: RigidTransform3 = {
		rotation: matRodriguesRotation([1, -2, 3], 0.73),
		translation: [4, -5, 6],
	}
	const inverse = rigidInverse(transform)
	const point = [2, 3, -7] as const
	const direction = [-0.2, 0.4, 0.7] as const

	expectVectorClose(rigidTransformPoint(inverse, rigidTransformPoint(transform, point)), point)
	expectVectorClose(rigidTransformDirection(inverse, rigidTransformDirection(transform, direction)), direction)
})

test('rotation around a non-zero pivot keeps the pivot fixed', () => {
	const transform = rigidRotationAroundAxis([2, 3, 4], [0, 0, 1], PIOVERTWO)
	expectVectorClose(rigidTransformPoint(transform, [2, 3, 4]), [2, 3, 4])
	expectVectorClose(rigidTransformPoint(transform, [3, 3, 4]), [2, 4, 4])
})

test('point and direction outputs may alias their inputs', () => {
	const transform: RigidTransform3 = {
		rotation: matRodriguesRotation([0, 0, 1], PIOVERTWO),
		translation: [3, 4, 5],
	}
	const point: MutVec3 = [1, 0, 0]
	const direction: MutVec3 = [1, 0, 0]

	expect(rigidTransformPoint(transform, point, point)).toBe(point)
	expectVectorClose(point, [3, 5, 5])
	expect(rigidTransformDirection(transform, direction, direction)).toBe(direction)
	expectVectorClose(direction, [0, 1, 0])
})

test('rotation around an invalid axis is rejected', () => {
	expect(() => rigidRotationAroundAxis([0, 0, 0], [0, 0, 0], 1)).toThrow()
	expect(() => rigidRotationAroundAxis([0, 0, 0], [Number.NaN, 0, 1], 1)).toThrow()
	expect(() => rigidRotationAroundAxis([0, 0, 0], [0, 0, 1], Number.POSITIVE_INFINITY)).toThrow()
})
