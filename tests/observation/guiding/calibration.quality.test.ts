import { expect, test } from 'bun:test'
import { DEG2RAD } from '../../../src/core/constants'
import { assessGuidingCalibration, GUIDING_CALIBRATION_QUALITY_VERSION } from '../../../src/observation/guiding/calibration.quality'
import type { GuidingCalibrationAxisSolution, GuidingCalibrationResult, GuidingCalibrationSample } from '../../../src/observation/guiding/calibrator'

function axis(angle: number, travel: number, residual: number, negative = 0): GuidingCalibrationAxisSolution {
	return { unitX: Math.cos(angle), unitY: Math.sin(angle), ratePxPerMs: 0.01, totalTravelPx: travel, totalPulse: travel / 0.01, angle, rmsOrthogonalResidualPx: residual, negativeProjectionCount: negative }
}

function samples(count: number) {
	return Array.from({ length: count }, (_, i) => ({ leg: 'raForward', step: i + 1 }) as GuidingCalibrationSample)
}

function calibration(patch: { ra?: GuidingCalibrationAxisSolution; dec?: GuidingCalibrationAxisSolution; steps?: number; orthogonalityError?: number; backlash?: number; warnings?: string[] } = {}): GuidingCalibrationResult {
	const ra = patch.ra ?? axis(0, 25, 0.2)
	const dec = patch.dec ?? axis(Math.PI / 2, 25, 0.2)
	const steps = samples(patch.steps ?? 8)
	return {
		ra: { ...ra, direction: 'WEST' },
		dec: { ...dec, direction: 'NORTH' },
		imageMotion: [0.01, 0, 0, 0.01],
		imageToAxis: [100, 0, 0, 100],
		determinant: 1e-4,
		backlash: patch.backlash ?? 0,
		startX: 0,
		startY: 0,
		decStartX: 0,
		decStartY: 0,
		clearingSteps: 0,
		decReturnSteps: 0,
		warnings: patch.warnings ?? [],
		orthogonalAssumed: false,
		review: { raSamples: steps, clearingSamples: [], decSamples: steps, decReturnSamples: [], excludedSamples: [], phaseHistory: [], measuredDec: dec, orthogonalityError: patch.orthogonalityError ?? 0 },
	}
}

test('grades a clean calibration as good', () => {
	expect(assessGuidingCalibration(calibration())).toEqual({ version: GUIDING_CALIBRATION_QUALITY_VERSION, quality: 'good', findings: [] })
})

test('warns about few steps, short travel, reverse steps, backlash and a short DEC return', () => {
	const assessment = assessGuidingCalibration(calibration({ steps: 3, ra: axis(0, 10, 0.1, 1), backlash: 4000, warnings: ['dec_return_short'] }))
	expect(assessment.quality).toBe('warning')
	expect(assessment.findings.map((finding) => [finding.code, finding.axis, finding.severity])).toEqual([
		['fewSteps', 'ra', 'warning'],
		['shortTravel', 'ra', 'warning'],
		['reverseSteps', 'ra', 'warning'],
		['fewSteps', 'dec', 'warning'],
		['largeBacklash', 'dec', 'warning'],
		['decReturnShort', undefined, 'warning'],
	])
})

test('grades scattered steps and skewed axes by severity', () => {
	// 8 steps over 25 px: a mean step of 3.125 px.
	const scattered = assessGuidingCalibration(calibration({ dec: axis(Math.PI / 2, 25, 1.25) }))
	expect(scattered.findings).toEqual([{ code: 'highResidual', severity: 'warning', axis: 'dec', value: 0.4, limit: 0.3 }])
	expect(scattered.quality).toBe('warning')

	expect(assessGuidingCalibration(calibration({ dec: axis(Math.PI / 2, 25, 2.5) })).quality).toBe('poor')
	expect(assessGuidingCalibration(calibration({ orthogonalityError: 15 * DEG2RAD })).findings[0]).toMatchObject({ code: 'orthogonalityError', severity: 'warning' })
	expect(assessGuidingCalibration(calibration({ orthogonalityError: 35 * DEG2RAD })).quality).toBe('poor')
})
