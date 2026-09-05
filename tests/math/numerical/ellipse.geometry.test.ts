import { expect, test } from 'bun:test'
import { PIOVERTWO, TAU } from '../../../src/core/constants'
import { maximumNormalizedBoundaryRadiusSquared } from '../../../src/math/numerical/ellipse.geometry'

test('continuous containment includes an offset shadow excluding the outer center', () => {
	const outer = { center: { x: 0, y: 0 }, semiMajor: 10, semiMinor: 10, theta: 0 }
	const inner = { center: { x: 5, y: 0 }, semiMajor: 2, semiMinor: 2, theta: 1 }
	expect(maximumNormalizedBoundaryRadiusSquared(outer, inner)).toBeCloseTo(0.49, 14)
	expect(maximumNormalizedBoundaryRadiusSquared(outer, { ...inner, center: { x: 8, y: 0 } })).toBeCloseTo(1, 14)
	expect(maximumNormalizedBoundaryRadiusSquared(outer, { ...inner, center: { x: 8.0001, y: 0 } })).toBeGreaterThan(1)
})

test('handles the singular secular case and preserves unordered axes', () => {
	const outer = { center: { x: 0, y: 0 }, semiMajor: 4, semiMinor: 4, theta: 0 }
	const inner = { center: { x: 0, y: 0.3 }, semiMajor: 3, semiMinor: 1, theta: 0 }
	const maximum = maximumNormalizedBoundaryRadiusSquared(outer, inner)
	let sampled = 0
	for (let i = 0; i < 10000; i++) {
		const t = (i * TAU) / 10000
		sampled = Math.max(sampled, ((3 * Math.cos(t)) ** 2 + (0.3 + Math.sin(t)) ** 2) / 16)
	}
	expect(maximum).toBeCloseTo(sampled, 7)
	expect(maximumNormalizedBoundaryRadiusSquared(outer, { ...inner, semiMajor: 1, semiMinor: 3, theta: PIOVERTWO })).toBeCloseTo(maximum, 14)
})
