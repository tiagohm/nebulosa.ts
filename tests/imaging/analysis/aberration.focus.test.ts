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

// Recovers a noisy minimum while rejecting one gross metric outlier.
test('fits a noisy focus curve with a gross outlier', () => {
	const positions = [-4, -3, -2, -1, 0, 1, 2, 3, 4]
	const points = positions.map((position, index) => ({ position, value: 3 + (position - 0.75) * (position - 0.75) + (index % 2 === 0 ? 0.03 : -0.02) }))
	points[0] = { position: -4, value: 100 }
	const result = fitAberrationFocusCurve(points, { sigmaClip: 3 })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.minimum.x).toBeCloseTo(0.75, 1)
	expect(result.used[0]).toBeFalse()
	expect(result.uncertainty).toBeGreaterThan(0)
})

// Rejects degenerate input and non-convex focus curves with discriminated reasons.
test('rejects duplicate positions and concave curves', () => {
	const duplicate = fitAberrationFocusCurve([
		{ position: -1, value: 2 },
		{ position: 0, value: 1 },
		{ position: 0, value: 1.1 },
		{ position: 1, value: 2 },
		{ position: 2, value: 5 },
	])
	expect(duplicate.success).toBeFalse()
	if (!duplicate.success) expect(duplicate.reason).toBe('invalidInput')

	const concave = fitAberrationFocusCurve([-2, -1, 0, 1, 2].map((position) => ({ position, value: 10 - position * position })))
	expect(concave.success).toBeFalse()
	if (!concave.success) expect(concave.reason).toBe('nonConvex')
})
