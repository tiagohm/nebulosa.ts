import { expect, test } from 'bun:test'
import { analyzePhysicalCurvature, analyzePhysicalTilt, criticalFocusZone, estimateBackfocusCorrection, focusSurfaceEffect, measureFocusFieldOffset } from '../../../src/imaging/analysis/aberration.physical'

// Converts normalized focus-plane slopes with explicit physical scale and preserves displacement sign.
test('converts focus-plane gradients into physical tilt', () => {
	const tilt = analyzePhysicalTilt({ gradientX: 2, gradientY: -3, effect: 5 }, 101, 201, { pixelSize: 0.004, focusDisplacement: -0.01 })
	expect(tilt.x).toBeCloseTo(Math.atan(-0.05), 12)
	expect(tilt.y).toBeCloseTo(Math.atan(0.0375), 12)
	expect(tilt.magnitude).toBeCloseTo(Math.atan(Math.hypot(-0.05, 0.0375)), 12)
})

// Includes interior extrema so a radially curved surface cannot report a zero effect.
test('measures full quadratic surface effect over the sensor', () => {
	expect(focusSurfaceEffect({ c: 100, ax: 0, ay: 0, qxx: 8, qxy: 0, qyy: 8 })).toBeCloseTo(4, 12)
	expect(focusSurfaceEffect({ c: 100, ax: 2, ay: -3, qxx: 0, qxy: 0, qyy: 0 })).toBeCloseTo(5, 12)
})

// Converts anisotropic normalized curvature independently along physical sensor axes.
test('converts quadratic coefficients into physical principal radii', () => {
	const curvature = analyzePhysicalCurvature({ c: 0, ax: 0, ay: 0, qxx: 2, qxy: 0, qyy: 4 }, 101, 201, { pixelSize: 0.01, focusDisplacement: 0.5 })
	expect(curvature.principalX).toBeCloseTo(2, 12)
	expect(curvature.principalY).toBeCloseTo(1, 12)
	expect(curvature.radiusX).toBeCloseTo(0.5, 12)
	expect(curvature.radiusY).toBeCloseTo(1, 12)
})

// Refuses non-finite public surface coefficients before they can leak into physical radii.
test('rejects non-finite physical curvature coefficients', () => {
	expect(() => analyzePhysicalCurvature({ c: 0, ax: 0, ay: 0, qxx: Number.NaN, qxy: 0, qyy: 1 }, 100, 100, { pixelSize: 0.004, focusDisplacement: 0.001 })).toThrow(RangeError)
})

// Measures a robust center-to-edge offset and applies only an explicit calibration response.
test('measures and calibrates a field focus offset', () => {
	const offset = measureFocusFieldOffset([
		{ u: 0, v: 0, bestFocus: 100, confidence: 1 },
		{ u: 0.5, v: 0.5, bestFocus: 110, confidence: 1 },
		{ u: -0.5, v: -0.5, bestFocus: 112, confidence: 1 },
	])
	expect(offset).toBeDefined()
	if (!offset) return
	expect(offset.centerToEdge).toBe(11)
	expect(estimateBackfocusCorrection(offset, { response: 2 }).correction).toBe(-5.5)
})

// Does not let unsupported middle-field samples inflate center-to-edge confidence.
test('limits field-offset confidence to contributing samples', () => {
	const offset = measureFocusFieldOffset([
		{ u: 0, v: 0, bestFocus: 100, confidence: 0.3 },
		{ u: 0.5, v: 0.5, bestFocus: 110, confidence: 0.3 },
		{ u: 0.3, v: 0, bestFocus: 105, confidence: 1 },
	])

	expect(offset?.confidence).toBeCloseTo(0.2, 12)
})

// Keeps CFZ explicitly as a semi-amplitude for both supported conventions.
test('computes explicit critical focus zone tolerances', () => {
	const diffraction = criticalFocusZone({ focalRatio: 5, wavelength: 0.00055 })
	expect(diffraction.criterion).toBe('diffraction')
	expect(diffraction.tolerance).toBeCloseTo(0.01375, 12)
	expect(criticalFocusZone({ criterion: 'callerProvided', tolerance: 12 })).toEqual({ tolerance: 12, criterion: 'callerProvided' })
})
