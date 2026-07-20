import { expect, test } from 'bun:test'
import { enuVectorToHorizontal } from '../../../src/astronomy/coordinates/frame.local'
import { matDeterminant, matMul, matMulVec, matRodriguesRotation, matTranspose } from '../../../src/math/linear-algebra/mat3'
import { deg } from '../../../src/math/units/angle'
import { applyDirectionAlignment, fitDirectionAlignment, fitMountAlignment, predictMountDirection, predictWorldDirection, type DirectionAlignmentSample } from '../../../src/observation/mount/alignment'
import { createIdealAltAzGeometry, mountDirectionFromEncoders } from '../../../src/observation/mount/kinematics'

// Tests exact, refined, robust, and mount-observation direction alignment on SO(3).

// Compares one three-component vector at the requested decimal precision.
function expectVectorClose(actual: readonly number[], expected: readonly number[], precision: number = 12): void {
	for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], precision)
}

// Measures angular separation between two directions in radians.
function angularSeparation(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	const crossX = a[1] * b[2] - a[2] * b[1]
	const crossY = a[2] * b[0] - a[0] * b[2]
	const crossZ = a[0] * b[1] - a[1] * b[0]
	return Math.atan2(Math.hypot(crossX, crossY, crossZ), Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
}

test('two exact non-collinear directions recover a proper TRIAD rotation', () => {
	const expected = matRodriguesRotation([1, -2, 0.5], 0.73)
	const samples: DirectionAlignmentSample[] = [
		{ mount: [1, 0, 0], world: matMulVec(expected, [1, 0, 0]) },
		{ mount: [0.2, 1, 0.3], world: matMulVec(expected, [0.2, 1, 0.3]) },
	]
	const result = fitDirectionAlignment(samples)

	expect(result.converged).toBeTrue()
	expect(result.iterations).toBe(0)
	expect(result.rms).toBeLessThan(1e-12)
	expect(matDeterminant(result.mountToWorld)).toBeCloseTo(1, 12)
	for (let i = 0; i < 9; i++) expect(matMul(result.mountToWorld, result.worldToMount)[i]).toBeCloseTo(i % 4 === 0 ? 1 : 0, 12)
	expectVectorClose(
		predictWorldDirection(result, [0.3, -0.4, 0.8]),
		matMulVec(expected, [0.3, -0.4, 0.8]).map((value) => value / Math.hypot(0.3, -0.4, 0.8)),
	)
	expectVectorClose(predictMountDirection(result, predictWorldDirection(result, [0.3, -0.4, 0.8])), [0.3 / Math.hypot(0.3, -0.4, 0.8), -0.4 / Math.hypot(0.3, -0.4, 0.8), 0.8 / Math.hypot(0.3, -0.4, 0.8)])
})

test('many exact directions refine to the known rotation', () => {
	const expected = matRodriguesRotation([-0.3, 0.7, 1], deg(17))
	const mounts = [
		[1, 0, 0],
		[0, 1, 0],
		[0, 0, 1],
		[1, 2, 3],
		[-2, 1, 0.4],
	] as const
	const result = fitDirectionAlignment(mounts.map((mount) => ({ mount, world: matMulVec(expected, mount) })))
	for (const mount of mounts)
		expectVectorClose(
			predictWorldDirection(result, mount),
			matMulVec(expected, mount).map((value) => value / Math.hypot(...mount)),
		)
	expect(result.converged).toBeTrue()
	expect(result.rms).toBeLessThan(1e-12)
	expect(result.conditionNumber).toBeLessThan(10)
})

test('Tukey weighting rejects an outlier and protects the clean rotation', () => {
	const expected = matRodriguesRotation([0.4, -0.2, 1], deg(8))
	const mounts = [
		[1, 0, 0],
		[0, 1, 0],
		[0, 0, 1],
		[1, 1, 0],
		[0, 1, 1],
		[1, 0, 1],
	] as const
	const samples: DirectionAlignmentSample[] = mounts.map((mount) => ({ mount, world: matMulVec(expected, mount) }))
	samples.push({ mount: [-1, 2, 0.5], world: [0, 0, -1] })
	const ordinary = fitDirectionAlignment(samples)
	const robust = fitDirectionAlignment(samples, { robust: 'tukey' })
	const probe = [0.2, -0.7, 0.5] as const
	const target = matMulVec(expected, probe)

	expect(angularSeparation(predictWorldDirection(robust, probe), target)).toBeLessThan(angularSeparation(predictWorldDirection(ordinary, probe), target))
	expect(robust.rejectedCount).toBeGreaterThanOrEqual(1)
	expect(robust.maximumResidual).toBeGreaterThan(robust.rms)
})

test('mount observations fit base-to-ENU orientation and preserve translation when applied', () => {
	const expected = matRodriguesRotation([0.2, 0.5, -0.3], deg(11))
	const geometry = createIdealAltAzGeometry({ baseToWorld: { rotation: matRodriguesRotation([1, 0, 0], 0.1), translation: [4, 5, 6] } })
	const encoders = [
		{ primary: deg(10), secondary: deg(20) },
		{ primary: deg(100), secondary: deg(35) },
		{ primary: deg(220), secondary: deg(50) },
		{ primary: deg(310), secondary: deg(15) },
	]
	const baseGeometry = createIdealAltAzGeometry()
	const observations = encoders.map((position) => {
		const horizontal = enuVectorToHorizontal(matMulVec(expected, mountDirectionFromEncoders(baseGeometry, position)))
		return { encoders: position, ...horizontal }
	})
	const result = fitMountAlignment(geometry, observations)
	const aligned = applyDirectionAlignment(geometry, result)

	for (const position of encoders) expectVectorClose(mountDirectionFromEncoders(aligned, position), matMulVec(expected, mountDirectionFromEncoders(baseGeometry, position)))
	expect(aligned.baseToWorld.translation).toBe(geometry.baseToWorld.translation)
	for (let i = 0; i < 9; i++) expect(aligned.baseToWorld.rotation[i]).toBeCloseTo(expected[i], 11)
})

test('zero-weight, collinear, antipodal, and invalid samples are handled explicitly', () => {
	const rotation = matRodriguesRotation([0, 0, 1], 0.2)
	const result = fitDirectionAlignment([
		{ mount: [1, 0, 0], world: matMulVec(rotation, [1, 0, 0]) },
		{ mount: [0, 1, 0], world: matMulVec(rotation, [0, 1, 0]) },
		{ mount: [0, 0, 1], world: [1, 0, 0], weight: 0 },
	])
	expect(result.weights[2]).toBe(0)
	expect(() => fitDirectionAlignment([{ mount: [1, 0, 0], world: [1, 0, 0] }])).toThrow()
	expect(() =>
		fitDirectionAlignment([
			{ mount: [1, 0, 0], world: [1, 0, 0] },
			{ mount: [-1, 0, 0], world: [-1, 0, 0] },
		]),
	).toThrow()
	expect(() =>
		fitDirectionAlignment([
			{ mount: [0, 0, 0], world: [1, 0, 0] },
			{ mount: [0, 1, 0], world: [0, 1, 0] },
		]),
	).toThrow()
	expect(() =>
		fitDirectionAlignment(
			[
				{ mount: [1, 0, 0], world: [1, 0, 0] },
				{ mount: [0, 1, 0], world: [0, 1, 0] },
			],
			{ tuning: 0 },
		),
	).toThrow()
})
