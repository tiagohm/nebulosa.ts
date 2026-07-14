import { expect, test } from 'bun:test'
import { PI, TAU } from '../../../src/core/constants'
import { analyzeFocusCurvature, analyzeFocusPlane, evaluateFocusSurface, fitFocusSurface, focusSurfaceEffect, type FocusSurfaceCoefficients, type FocusSurfaceSample } from '../../../src/math/numerical/surface.fit'

// Creates a regular normalized sensor grid for deterministic surface-fit fixtures.
function grid(step: number = 0.25): FocusSurfaceSample[] {
	const samples: FocusSurfaceSample[] = []
	for (let v = -0.5; v <= 0.5; v += step) {
		for (let u = -0.5; u <= 0.5; u += step) samples.push({ u, v, focus: 0 })
	}
	return samples
}

// Replaces placeholder focus positions with values from a known common surface.
function samplesFor(surface: FocusSurfaceCoefficients): FocusSurfaceSample[] {
	const samples = grid()
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		samples[i] = { u: sample.u, v: sample.v, focus: evaluateFocusSurface(surface, sample.u, sample.v), sourceIndex: i }
	}
	return samples
}

// Recovers an exact planar best-focus field and covariance from an overdetermined grid.
test('fits an exact focus plane', () => {
	const surface = { c: 1000, ax: 12, ay: -8, qxx: 0, qxy: 0, qyy: 0 }
	const result = fitFocusSurface(samplesFor(surface), { model: 'plane' })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.coefficients.c).toBeCloseTo(surface.c, 9)
	expect(result.coefficients.ax).toBeCloseTo(surface.ax, 9)
	expect(result.coefficients.ay).toBeCloseTo(surface.ay, 9)
	expect(result.coefficients.qxx).toBe(0)
	expect(result.degreesOfFreedom).toBeGreaterThan(0)
	expect(result.covariance).toBeDefined()
	expect(result.rms).toBeCloseTo(0, 10)
})

// Maps the radial coefficient into both principal quadratic axes without a mixed term.
test('fits a radial quadratic focus surface', () => {
	const surface = { c: 500, ax: 2, ay: -3, qxx: 14, qxy: 0, qyy: 14 }
	const result = fitFocusSurface(samplesFor(surface), { model: 'radialQuadratic' })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.coefficients.c).toBeCloseTo(surface.c, 9)
	expect(result.coefficients.ax).toBeCloseTo(surface.ax, 9)
	expect(result.coefficients.ay).toBeCloseTo(surface.ay, 9)
	expect(result.coefficients.qxx).toBeCloseTo(surface.qxx, 9)
	expect(result.coefficients.qyy).toBeCloseTo(surface.qyy, 9)
	expect(result.coefficients.qxy).toBe(0)
})

// Recovers anisotropic and mixed curvature from the full quadratic design.
test('fits an anisotropic quadratic focus surface', () => {
	const surface = { c: 250, ax: 5, ay: -7, qxx: 10, qxy: -6, qyy: 4 }
	const result = fitFocusSurface(samplesFor(surface), { model: 'quadratic' })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.coefficients.c).toBeCloseTo(surface.c, 9)
	expect(result.coefficients.ax).toBeCloseTo(surface.ax, 9)
	expect(result.coefficients.ay).toBeCloseTo(surface.ay, 9)
	expect(result.coefficients.qxx).toBeCloseTo(surface.qxx, 9)
	expect(result.coefficients.qxy).toBeCloseTo(surface.qxy, 9)
	expect(result.coefficients.qyy).toBeCloseTo(surface.qyy, 9)
	expect(evaluateFocusSurface(result.coefficients, 0.2, -0.3)).toBeCloseTo(evaluateFocusSurface(surface, 0.2, -0.3), 10)
})

// Downweights a gross outlier while preserving its input-order rejection diagnostics.
test('rejects a gross robust outlier', () => {
	const surface = { c: 100, ax: 4, ay: -2, qxx: 0, qxy: 0, qyy: 0 }
	const samples = samplesFor(surface)
	const outlierIndex = samples.length - 1
	const outlier = samples.at(-1)!
	samples[outlierIndex] = { u: outlier.u, v: outlier.v, focus: 1000, sourceIndex: outlier.sourceIndex }
	const result = fitFocusSurface(samples, { model: 'plane', sigmaClip: 3 })

	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.coefficients.ax).toBeCloseTo(surface.ax, 4)
	expect(result.rejectedIndices).toContain(outlierIndex)
	expect(result.used[outlierIndex]).toBeFalse()
	expect(result.warnings).toContainEqual({ code: 'robustOutliers', values: { rejectedCount: 1 } })
})

// Fails explicitly instead of publishing a regularized-looking plane for collinear sensor samples.
test('rejects rank-deficient surface geometry', () => {
	const samples: FocusSurfaceSample[] = [
		{ u: -0.5, v: -0.5, focus: 1 },
		{ u: 0, v: 0, focus: 2 },
		{ u: 0.5, v: 0.5, focus: 3 },
	]
	const result = fitFocusSurface(samples, { model: 'plane' })

	expect(result.success).toBeFalse()
	if (result.success) return
	expect(result.reason).toBe('rankDeficient')
	expect(result.used).toEqual([false, false, false])
})

// Rejects non-finite, out-of-domain, and invalid statistical inputs at the public numerical boundary.
test('rejects invalid focus-surface samples', () => {
	const result = fitFocusSurface(
		[
			{ u: 0, v: 0, focus: Number.NaN },
			{ u: 0.2, v: 0.2, focus: 1 },
			{ u: -0.2, v: -0.2, focus: 2 },
		],
		{ model: 'plane' },
	)

	expect(result.success).toBeFalse()
	if (result.success) return
	expect(result.reason).toBe('invalidInput')

	const outsideSensor = fitFocusSurface(
		[
			{ u: 0.6, v: 0, focus: 1 },
			{ u: 0.2, v: 0.2, focus: 1 },
			{ u: -0.2, v: -0.2, focus: 2 },
		],
		{ model: 'plane' },
	)
	expect(outsideSensor.success).toBeFalse()
	if (outsideSensor.success) return
	expect(outsideSensor.reason).toBe('invalidInput')
})

// Rejects a numerically valid solution when the caller's conditioning policy is stricter.
test('rejects an ill-conditioned surface by policy', () => {
	const result = fitFocusSurface(samplesFor({ c: 100, ax: 3, ay: 2, qxx: 0, qxy: 0, qyy: 0 }), { model: 'plane', maxConditionNumber: 1 })

	expect(result.success).toBeFalse()
	if (result.success) return
	expect(result.reason).toBe('illConditioned')
	expect(result.conditionNumber).toBeGreaterThan(1)
})

// Derives the exact sensor-corner effect and clockwise image-coordinate gradient direction.
test('analyzes the planar focus component', () => {
	const analysis = analyzeFocusPlane({ c: 100, ax: 12, ay: -8, qxx: 0, qxy: 0, qyy: 0 })

	expect(analysis.gradientX).toBe(12)
	expect(analysis.gradientY).toBe(-8)
	expect(analysis.effect).toBe(20)
	expect(analysis.direction).toBeCloseTo(TAU + Math.atan2(-8, 12), 12)
})

// Derives Hessian eigenstructure, a stationary point, and center-to-edge curvature metrics.
test('analyzes quadratic focus curvature', () => {
	const analysis = analyzeFocusCurvature({ c: 250, ax: 5, ay: -7, qxx: 10, qxy: -6, qyy: 4 })

	expect(analysis.principalX).toBeCloseTo(14 + Math.sqrt(72), 12)
	expect(analysis.principalY).toBeCloseTo(14 - Math.sqrt(72), 12)
	expect(analysis.orientation).toBeCloseTo(0.5 * Math.atan2(-6, 6) + PI, 12)
	expect(analysis.anisotropy).toBeGreaterThan(0)
	expect(analysis.stationaryPoint).toBeDefined()
	expect(analysis.centerToEdge).toBeCloseTo(3.5, 12)
	expect(analysis.effect).toBeCloseTo(5, 12)
})

// Includes edge-interior extrema when a saddle vanishes at all four corners.
test('measures saddle curvature at sensor edges', () => {
	const analysis = analyzeFocusCurvature({ c: 0, ax: 0, ay: 0, qxx: 1, qxy: 0, qyy: -1 })

	expect(analysis.effect).toBeCloseTo(0.5, 12)
})

// Includes interior extrema so a radially curved surface cannot report a zero effect.
test('measures full quadratic surface effect over the sensor', () => {
	expect(focusSurfaceEffect({ c: 100, ax: 0, ay: 0, qxx: 8, qxy: 0, qyy: 8 })).toBeCloseTo(4, 12)
	expect(focusSurfaceEffect({ c: 100, ax: 2, ay: -3, qxx: 0, qxy: 0, qyy: 0 })).toBeCloseTo(5, 12)
})
