import { describe, expect, test } from 'bun:test'
import { PI } from '../../../src/core/constants'
import { matDeterminant, matMulVec, matRodriguesRotation, matTransposeMul } from '../../../src/math/linear-algebra/mat3'
import { fitRotation } from '../../../src/math/linear-algebra/rotation.fit'
import { type Vec3, vecAngle, vecNormalize } from '../../../src/math/linear-algebra/vec3'
import { arcsec, deg } from '../../../src/math/units/angle'

// Deterministic directions spread over a cone of the given half-angle about +z.
function cone(radius: number, count: number = 25): Vec3[] {
	const directions: Vec3[] = []
	for (let i = 0; i < count; i++) {
		const r = radius * Math.sqrt((i + 0.5) / count)
		const a = i * 2.399963229728653
		directions.push(vecNormalize([Math.sin(r) * Math.cos(a), Math.sin(r) * Math.sin(a), Math.cos(r)]))
	}
	return directions
}

function rotate(directions: readonly Vec3[], axis: Vec3, angle: number) {
	const rotation = matRodriguesRotation(axis, angle)
	return directions.map((e) => matMulVec(rotation, e))
}

// Angle of the rotation between two rotations, from ‖A − B‖F = 2√2·sin(θ/2), exact near zero.
function rotationDistance(a: Parameters<typeof matTransposeMul>[0], b: Parameters<typeof matTransposeMul>[0]) {
	let sum = 0
	for (let i = 0; i < 9; i++) sum += (a[i] - b[i]) ** 2
	return 2 * Math.asin(Math.min(1, Math.sqrt(sum) / (2 * Math.SQRT2)))
}

describe('exact rotations', () => {
	for (const angle of [deg(1e-4), deg(0.5), deg(20), deg(90), deg(179.9)]) {
		test(`recovers a rotation of ${((angle * 180) / PI).toFixed(4)}°`, () => {
			const axis = vecNormalize([0.3, -0.5, 0.8])
			const from = cone(deg(30))
			const fit = fitRotation(from, rotate(from, axis, angle))!
			expect(fit).toBeDefined()
			expect(rotationDistance(fit.rotation, matRodriguesRotation(axis, angle))).toBeLessThan(1e-12)
			expect(matDeterminant(fit.rotation)).toBeCloseTo(1, 12)
			expect(fit.residual).toBeLessThan(1e-12)
			expect(fit.maximumResidual).toBeLessThan(1e-12)
		})
	}

	test('is orthonormal', () => {
		const from = cone(deg(5))
		const fit = fitRotation(from, rotate(from, [1, 0, 0], deg(33)))!
		const product = matTransposeMul(fit.rotation, fit.rotation)
		for (let i = 0; i < 9; i++) expect(product[i]).toBeCloseTo(i % 4 === 0 ? 1 : 0, 12)
	})

	test('maps a reflected set to the best proper rotation, never a reflection', () => {
		const from = cone(deg(40))
		const mirrored = from.map(([x, y, z]) => [-x, y, z] as Vec3)
		const fit = fitRotation(from, mirrored)!
		expect(matDeterminant(fit.rotation)).toBeCloseTo(1, 12)
		expect(fit.residual).toBeGreaterThan(deg(1))
	})
})

describe('conditioning', () => {
	test('shrinks with the square of the radius of a small cluster', () => {
		const wide = fitRotation(cone(deg(2)), rotate(cone(deg(2)), [0, 1, 0], deg(10)))!
		const narrow = fitRotation(cone(deg(1)), rotate(cone(deg(1)), [0, 1, 0], deg(10)))!
		expect(wide.conditioning / narrow.conditioning).toBeCloseTo(4, 1)
		const sphere = fitRotation(
			[
				[1, 0, 0],
				[0, 1, 0],
				[0, 0, 1],
			],
			[
				[1, 0, 0],
				[0, 1, 0],
				[0, 0, 1],
			],
		)!
		expect(sphere.conditioning).toBeCloseTo(1, 12)
	})

	test('leaves undetermined and malformed sets undefined', () => {
		expect(fitRotation([[0, 0, 1]], [[0, 0, 1]])).toBeUndefined()
		expect(
			fitRotation(
				[
					[0, 0, 1],
					[0, 0, -1],
					[0, 0, 1],
				],
				[
					[1, 0, 0],
					[-1, 0, 0],
					[1, 0, 0],
				],
			),
		).toBeUndefined()
		expect(
			fitRotation(
				[
					[0, 0, 1],
					[1, 0, 0],
				],
				[[0, 0, 1]],
			),
		).toBeUndefined()
		expect(
			fitRotation(
				[
					[0, 0, 1],
					[1, 0, 0],
				],
				[
					[0, 0, 1],
					[1, 0, 0],
				],
				[0, 0],
			),
		).toBeUndefined()
		expect(
			fitRotation(
				[
					[0, 0, 1],
					[Number.NaN, 0, 0],
				],
				[
					[0, 0, 1],
					[1, 0, 0],
				],
			),
		).toBeUndefined()
	})
})

describe('noise', () => {
	test('averages perturbed directions and reports their residual', () => {
		const axis: Vec3 = [0, 0, 1]
		const from = cone(deg(3), 49)
		const exact = rotate(from, axis, deg(25))
		const noise = arcsec(1)
		const to = exact.map(([x, y, z], i) => vecNormalize([x + noise * Math.sin(i * 1.7), y + noise * Math.cos(i * 2.3), z]))
		const fit = fitRotation(from, to)!
		expect(rotationDistance(fit.rotation, matRodriguesRotation(axis, deg(25)))).toBeLessThan(arcsec(30))
		expect(fit.residual).toBeGreaterThan(arcsec(0.3))
		expect(fit.residual).toBeLessThan(arcsec(1.5))
		for (let i = 0; i < from.length; i++) expect(vecAngle(matMulVec(fit.rotation, from[i]), to[i])).toBeLessThanOrEqual(fit.maximumResidual + 1e-15)
	})

	test('weights pull the fit towards the trusted pairs', () => {
		const from = cone(deg(10), 10)
		const to = rotate(from, [0, 0, 1], deg(5))
		to[0] = rotate([from[0]], [0, 0, 1], deg(15))[0]
		const weights = from.map((_, i) => (i === 0 ? 0 : 1))
		const fit = fitRotation(from, to, weights)!
		expect(rotationDistance(fit.rotation, matRodriguesRotation([0, 0, 1], deg(5)))).toBeLessThan(1e-12)
	})
})
