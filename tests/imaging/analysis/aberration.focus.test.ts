import { expect, test } from 'bun:test'
import { fitAberrationFocusCurve } from '../../../src/imaging/analysis/aberration.focus'

// Recovers a normalized robust quadratic minimum in the caller's focus-position unit.
test('fits a quadratic regional focus curve', () => {
	const points = [-2, -1, 0, 1, 2, 3].map((position) => ({ position, value: 2 + (position - 0.5) * (position - 0.5), weight: 1, starCount: 10 }))
	const result = fitAberrationFocusCurve(points)

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.minimum.x).toBeCloseTo(0.5, 10)
	expect(result.minimum.y).toBeCloseTo(2, 10)
	expect(result.used.every(Boolean)).toBeTrue()
})

// Refuses a monotonic sample sequence whose convex minimum lies outside the measured range.
test('rejects a focus minimum outside the sampled range', () => {
	const result = fitAberrationFocusCurve([0, 1, 2, 3, 4].map((position) => ({ position, value: 2 + (position - 8) * (position - 8) })))

	expect(result.success).toBeFalse()
	if (result.success) return
	expect(result.reason).toBe('minimumOutsideRange')
})
