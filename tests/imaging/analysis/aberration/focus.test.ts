import { expect, test } from 'bun:test'
import { fitAberrationFocusCurve } from '../../../../src/imaging/analysis/aberration/focus'

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

// Refuses a positive metric sweep whose leveraged endpoint would drive the fitted metric below zero.
test('rejects a non-positive quadratic metric minimum', () => {
	const points = [-2, -1, 0, 1, 2].map((position) => ({ position, value: 2 + position * position }))
	points[4] = { position: 2, value: 50 }
	const result = fitAberrationFocusCurve(points, { sigmaClip: 1e6 })

	expect(result.success).toBeFalse()
	if (result.success) return
	expect(result.reason).toBe('nonConvergent')
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

// Recovers a weighted nonlinear focus minimum without treating weights as replicated samples.
test('fits a weighted hyperbolic focus curve', () => {
	const positions = [-4, -3, -2, -1, 0, 1, 2, 3, 4]
	const points = positions.map((position) => ({ position, value: 2.5 * Math.sqrt(1 + ((position - 0.4) / 1.7) ** 2), weight: 1 }))
	points[0] = { position: -4, value: 80, weight: 1e-12 }
	const result = fitAberrationFocusCurve(points, { model: 'hyperbolic' })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.model).toBe('hyperbolic')
	expect(result.minimum.x).toBeCloseTo(0.4, 5)
	expect(result.minimum.y).toBeCloseTo(2.5, 5)
})

// Rejects a gross endpoint before it can bias nonlinear fit statistics and side support.
test('robustly rejects a hyperbolic focus outlier', () => {
	const positions = [-4, -3, -2, -1, 0, 1, 2, 3, 4]
	const points = positions.map((position) => ({ position, value: 2.5 * Math.sqrt(1 + ((position - 0.4) / 1.7) ** 2) }))
	points[0] = { position: -4, value: 80 }
	const result = fitAberrationFocusCurve(points, { model: 'hyperbolic', sigmaClip: 3 })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.minimum.x).toBeCloseTo(0.4, 4)
	expect(result.used[0]).toBeFalse()
	expect(result.warnings.some((warning) => warning.code === 'robustOutliers')).toBeTrue()
})

// Returns a discriminated failure when an extreme Tukey cutoff removes every nonlinear sample.
test('rejects a hyperbolic curve after excessive clipping', () => {
	const values = [5, 3, 2, 3.2, 5]
	const points = [-2, -1, 0, 1, 2].map((position, index) => ({ position, value: values[index] }))
	const result = fitAberrationFocusCurve(points, { model: 'hyperbolic', sigmaClip: 1e-12 })

	expect(result.success).toBeFalse()
	if (result.success) return
	expect(result.reason).toBe('excessiveRejection')
})

// Recovers the intersection of two asymmetric robust branches.
test('fits a trend-lines focus curve', () => {
	const positions = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]
	const points = positions.map((position) => ({ position, value: position < 0.5 ? 2 + 1.2 * (0.5 - position) : 2 + 1.8 * (position - 0.5) }))
	points[0] = { position: -5, value: 80 }
	const result = fitAberrationFocusCurve(points, { model: 'trendLines', sigmaClip: 3 })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.model).toBe('trendLines')
	expect(result.minimum.x).toBeCloseTo(0.5, 8)
	expect(result.minimum.y).toBeCloseTo(2, 8)
	expect(result.used[0]).toBeFalse()
})

// Prevents a spuriously low endpoint from defining an unsupported initial branch partition.
test('fits trend lines with a low endpoint outlier', () => {
	const positions = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]
	const points = positions.map((position) => ({ position, value: position < 0.5 ? 2 + 1.2 * (0.5 - position) : 2 + 1.8 * (position - 0.5) }))
	points[0] = { position: -5, value: 0.1 }
	const result = fitAberrationFocusCurve(points, { model: 'trendLines', sigmaClip: 3 })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.minimum.x).toBeCloseTo(0.5, 8)
	expect(result.used[0]).toBeFalse()
})

// Uses corrected AIC to distinguish smooth hyperbolic, parabolic, and piecewise-linear sweeps.
test('selects a focus curve model automatically', () => {
	const positions = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]
	const hyperbolic = fitAberrationFocusCurve(
		positions.map((position) => ({ position, value: 2 * Math.sqrt(1 + ((position - 0.3) / 1.4) ** 2) })),
		{ model: 'auto' },
	)
	const quadratic = fitAberrationFocusCurve(
		positions.map((position) => ({ position, value: 2 + 0.25 * (position + 0.4) ** 2 })),
		{ model: 'auto' },
	)
	const trendLines = fitAberrationFocusCurve(
		positions.map((position) => ({ position, value: position < 0.2 ? 2 + 0.7 * (0.2 - position) : 2 + 1.1 * (position - 0.2) })),
		{ model: 'auto' },
	)

	expect(hyperbolic.success && hyperbolic.model).toBe('hyperbolic')
	expect(quadratic.success && quadratic.model).toBe('quadratic')
	expect(trendLines.success && trendLines.model).toBe('trendLines')
})
