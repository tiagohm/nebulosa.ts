import { expect } from 'bun:test'
import { TAU } from '../../../src/core/constants'
import { vecAngle, type Vec3 } from '../../../src/math/linear-algebra/vec3'
import { normalizeAngle } from '../../../src/math/units/angle'

export function expectVecClose(actual: readonly number[], expected: readonly number[], tolerance: number) {
	expect(actual.length).toBeGreaterThanOrEqual(expected.length)
	for (let index = 0; index < expected.length; index++) {
		const delta = Math.abs(actual[index] - expected[index])
		expect(delta).toBeLessThanOrEqual(tolerance)
	}
}

export function expectAngularSeparationBelow(actual: Vec3, expected: Vec3, maxRadians: number) {
	expect(vecAngle(actual, expected)).toBeLessThanOrEqual(maxRadians)
}

export function expectWrappedAngle(actual: number, expected: number, tolerance: number) {
	const delta = Math.abs(normalizeAngle(actual - expected))
	expect(Math.min(delta, TAU - delta)).toBeLessThanOrEqual(tolerance)
}
