import { expect, test } from 'bun:test'
import { analyzePhysicalTilt, criticalFocusZone, estimateBackfocusCorrection, measureFocusFieldOffset } from '../../../src/imaging/analysis/aberration.physical'

// Converts normalized focus-plane slopes with explicit physical scale and preserves displacement sign.
test('converts focus-plane gradients into physical tilt', () => {
	const tilt = analyzePhysicalTilt({ gradientX: 2, gradientY: -3, effect: 5 }, 101, 201, { pixelSize: 0.004, focusDisplacement: -0.01 })
	expect(tilt.x).toBeCloseTo(-0.05, 12)
	expect(tilt.y).toBeCloseTo(0.0375, 12)
	expect(tilt.magnitude).toBeCloseTo(Math.atan(Math.hypot(-0.05, 0.0375)), 12)
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

// Keeps CFZ explicitly as a semi-amplitude for both supported conventions.
test('computes explicit critical focus zone tolerances', () => {
	const diffraction = criticalFocusZone({ focalRatio: 5, wavelength: 0.00055 })
	expect(diffraction.criterion).toBe('diffraction')
	expect(diffraction.tolerance).toBeCloseTo(0.01375, 12)
	expect(criticalFocusZone({ criterion: 'callerProvided', tolerance: 12 })).toEqual({ tolerance: 12, criterion: 'callerProvided' })
})
