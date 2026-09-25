import { expect, test } from 'bun:test'
import { analyzePhysicalCurvature, analyzePhysicalTilt, criticalFocusZone, estimateBackfocusCorrection, estimatePhysicalSensorTilt, measureFocusFieldOffset } from '../../../../src/imaging/analysis/aberration/physical'

// Converts normalized focus-plane slopes with explicit physical scale and preserves displacement sign.
test('converts focus-plane gradients into physical tilt', () => {
	const tilt = analyzePhysicalTilt({ gradientX: 2, gradientY: -3, effect: 5 }, 101, 201, { pixelSize: 0.004, focusDisplacement: -0.01 })
	expect(tilt.x).toBeCloseTo(Math.atan(0.0375), 12)
	expect(tilt.y).toBeCloseTo(Math.atan(0.05), 12)
	expect(tilt.magnitude).toBeCloseTo(Math.atan(Math.hypot(-0.05, 0.0375)), 12)
})

// Maps a focus gradient to rotation about the orthogonal sensor axis with right-handed signs.
test('maps pure physical tilt gradients to their rotation axes', () => {
	const alongX = analyzePhysicalTilt({ gradientX: 1, gradientY: 0, effect: 1 }, 101, 201, { pixelSize: 0.01, focusDisplacement: 0.1 })
	const alongY = analyzePhysicalTilt({ gradientX: 0, gradientY: 1, effect: 1 }, 101, 201, { pixelSize: 0.01, focusDisplacement: 0.1 })

	expect(alongX.x).toBe(0)
	expect(alongX.y).toBeCloseTo(-Math.atan(0.1), 12)
	expect(alongY.x).toBeCloseTo(Math.atan(0.05), 12)
	expect(alongY.y).toBe(-0)
})

test.each([0.2, -0.2])('propagates correlated gradient covariance with displacement %p', (focusDisplacement) => {
	const tilt = estimatePhysicalSensorTilt({ gradientX: 3, gradientY: -4, effect: 7 }, 101, 201, { pixelSize: 0.01, focusDisplacement }, { x: 0.2, y: 0.3, covarianceXY: 0.04 })
	// Physical spans are 1 and 2; |sx| = 0.6, |sy| = 0.4, with a deliberately non-diagonal covariance.
	const derivativeX = 0.1 / 1.16
	const derivativeY = -0.2 / 1.36
	const magnitude = Math.sqrt(0.52)
	const derivativeAX = 0.12 / (magnitude * 1.52)
	const derivativeAY = -0.04 / (magnitude * 1.52)
	expect(tilt.uncertaintyX).toBeCloseTo(derivativeX * 0.3, 14)
	expect(tilt.uncertaintyY).toBeCloseTo(-derivativeY * 0.2, 14)
	expect(tilt.covarianceXY).toBeCloseTo(derivativeX * derivativeY * 0.04, 14)
	expect(tilt.uncertaintyMagnitude).toBeCloseTo(Math.sqrt(derivativeAX ** 2 * 0.04 + derivativeAY ** 2 * 0.09 + 2 * derivativeAX * derivativeAY * 0.04), 14)
	expect(tilt.x).toBeCloseTo(Math.atan(-2 * focusDisplacement), 14)
	expect(tilt.y).toBeCloseTo(Math.atan(-3 * focusDisplacement), 14)
})

test.each([0, 1e-12])('keeps component covariance but omits magnitude uncertainty near zero tilt %p', (gradient) => {
	const tilt = estimatePhysicalSensorTilt({ gradientX: gradient, gradientY: -gradient, effect: 2 * gradient }, 101, 201, { pixelSize: 0.01, focusDisplacement: 0.1 }, { x: 0.2, y: 0.3, covarianceXY: 0.04 })
	expect(tilt.uncertaintyX).toBeCloseTo(0.015, 14)
	expect(tilt.uncertaintyY).toBeCloseTo(0.02, 14)
	expect(tilt.covarianceXY).toBeCloseTo(-0.0002, 14)
	expect(tilt.uncertaintyMagnitude).toBeUndefined()
})

test('does not invent physical uncertainty without gradient covariance', () => {
	const tilt = estimatePhysicalSensorTilt({ gradientX: 3, gradientY: -4, effect: 7 }, 101, 201, { pixelSize: 0.01, focusDisplacement: 0.1 })
	expect(tilt.x).toBeCloseTo(Math.atan(-0.2), 14)
	expect(tilt.uncertaintyX).toBeUndefined()
	expect(tilt.uncertaintyY).toBeUndefined()
	expect(tilt.covarianceXY).toBeUndefined()
	expect(tilt.uncertaintyMagnitude).toBeUndefined()
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
	expect(offset.center).toBe(100)
	expect(offset.edge).toBe(111)
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
