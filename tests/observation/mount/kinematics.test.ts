import { expect, test } from 'bun:test'
import { PIOVERTWO } from '../../../src/core/constants'
import { matRodriguesRotation } from '../../../src/math/linear-algebra/mat3'
import type { RigidTransform3 } from '../../../src/math/linear-algebra/rigid3'
import { deg } from '../../../src/math/units/angle'
import { createCanonicalEquatorialGeometry, createIdealAltAzGeometry, mountDirectionFromEncoders, mountPoseFromEncoders, solveMountEncoders, type TwoAxisMountGeometry } from '../../../src/observation/mount/kinematics'

// Tests canonical mount conventions, physical serial geometry, and local inverse kinematics.

// Compares one three-component vector at the requested decimal precision.
function expectVectorClose(actual: readonly number[], expected: readonly number[], precision: number = 12): void {
	for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], precision)
}

test('ideal altaz geometry follows north-through-east azimuth and altitude', () => {
	const geometry = createIdealAltAzGeometry()
	const cases = [
		[0, 0, [0, 1, 0]],
		[PIOVERTWO, 0, [1, 0, 0]],
		[Math.PI, 0, [0, -1, 0]],
		[3 * PIOVERTWO, 0, [-1, 0, 0]],
		[0, PIOVERTWO, [0, 0, 1]],
	] as const

	for (const [primary, secondary, expected] of cases) expectVectorClose(mountDirectionFromEncoders(geometry, { primary, secondary }), expected)
})

test('canonical equatorial geometry emits Taki local-equatorial directions', () => {
	const geometry = createCanonicalEquatorialGeometry()
	for (const hourAngle of [deg(-140), deg(-20), 0, deg(75), deg(170)]) {
		for (const declination of [deg(-80), deg(-25), 0, deg(48), deg(85)]) {
			const cosDeclination = Math.cos(declination)
			const expected = [cosDeclination * Math.cos(hourAngle), -cosDeclination * Math.sin(hourAngle), Math.sin(declination)]
			expectVectorClose(mountDirectionFromEncoders(geometry, { primary: hourAngle, secondary: declination }), expected)
		}
	}
})

test('forward pose rotates offset points about transported physical axes', () => {
	const baseToWorld: RigidTransform3 = { rotation: matRodriguesRotation([0, 0, 1], PIOVERTWO), translation: [10, 20, 30] }
	const geometry = createIdealAltAzGeometry({
		baseToWorld,
		primaryPivot: [0, 0, 0],
		secondaryPivot: [0, 0, 1],
		opticalOrigin: [1, 0, 1],
	})
	const pose = mountPoseFromEncoders(geometry, { primary: PIOVERTWO, secondary: 0 })

	expectVectorClose(pose.origin, [11, 20, 31])
	expectVectorClose(pose.direction, [0, 1, 0])
	expectVectorClose(pose.primaryAxis, [0, 0, 1])
	expectVectorClose(pose.secondaryAxis, [1, 0, 0])
	expectVectorClose(pose.secondaryPivot, [10, 20, 31])
})

test('direction-only forward kinematics matches the complete pose with non-orthogonal axes', () => {
	const geometry: TwoAxisMountGeometry = {
		...createIdealAltAzGeometry(),
		primaryAxis: [0.03, -0.02, 1],
		secondaryAxis: [1, 0.04, 0.01],
		opticalDirection: [0.02, 1, -0.03],
		primaryIndex: 0.07,
		secondaryIndex: -0.04,
		primaryDirection: 1,
		secondaryDirection: -1,
	}
	const encoders = { primary: 0.73, secondary: -0.48 }
	expectVectorClose(mountDirectionFromEncoders(geometry, encoders), mountPoseFromEncoders(geometry, encoders).direction)
})

test('inverse kinematics recovers local branches for both canonical geometries', () => {
	const cases = [
		[createIdealAltAzGeometry({ primaryIndex: 0.03, secondaryIndex: -0.02 }), { primary: 1.1, secondary: 0.65 }],
		[createCanonicalEquatorialGeometry({ primaryIndex: -0.04, secondaryIndex: 0.02 }), { primary: -0.9, secondary: 0.4 }],
	] as const

	for (const [geometry, expected] of cases) {
		const target = mountDirectionFromEncoders(geometry, expected)
		const solution = solveMountEncoders(geometry, target, {
			initial: { primary: expected.primary + 0.2, secondary: expected.secondary - 0.15 },
			tolerance: 1e-12,
		})
		expect(solution.converged).toBeTrue()
		expect(solution.residual).toBeLessThanOrEqual(1e-12)
		expect(solution.primary).toBeCloseTo(expected.primary, 10)
		expect(solution.secondary).toBeCloseTo(expected.secondary, 10)
	}
})

test('inverse kinematics respects ranges and returns a finite best effort', () => {
	const geometry = createIdealAltAzGeometry()
	const target = mountDirectionFromEncoders(geometry, { primary: 1, secondary: 0.5 })
	const solution = solveMountEncoders(geometry, target, {
		initial: { primary: 0, secondary: 0 },
		primaryRange: [-0.2, 0.2],
		secondaryRange: [-0.1, 0.1],
	})

	expect(solution.converged).toBeFalse()
	expect(solution.primary).toBeGreaterThanOrEqual(-0.2)
	expect(solution.primary).toBeLessThanOrEqual(0.2)
	expect(solution.secondary).toBeGreaterThanOrEqual(-0.1)
	expect(solution.secondary).toBeLessThanOrEqual(0.1)
	expect(Number.isFinite(solution.residual)).toBeTrue()
})

test('inverse kinematics reports singular seeds without NaN', () => {
	const geometry = createIdealAltAzGeometry()
	const solution = solveMountEncoders(geometry, [1, 0, 0], { initial: { primary: 0, secondary: PIOVERTWO } })
	expect(solution.converged).toBeFalse()
	expect(Number.isFinite(solution.primary)).toBeTrue()
	expect(Number.isFinite(solution.secondary)).toBeTrue()
	expect(Number.isFinite(solution.residual)).toBeTrue()
})

test('invalid geometry, directions, ranges, and solver controls are rejected', () => {
	const geometry = createIdealAltAzGeometry()
	expect(() => mountDirectionFromEncoders({ ...geometry, primaryAxis: [0, 0, 0] }, { primary: 0, secondary: 0 })).toThrow()
	expect(() => solveMountEncoders(geometry, [0, 0, 0])).toThrow()
	expect(() => solveMountEncoders(geometry, [0, 1, 0], { primaryRange: [1, -1] })).toThrow()
	expect(() => solveMountEncoders(geometry, [0, 1, 0], { maxIterations: 0 })).toThrow()
	expect(() => solveMountEncoders(geometry, [0, 1, 0], { maxStep: Number.NaN })).toThrow()
})
