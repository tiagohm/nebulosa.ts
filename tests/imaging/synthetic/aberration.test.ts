import { expect, test } from 'bun:test'
import { evaluateSyntheticAberration, resolveSyntheticAberration, type SyntheticAberrationConfig, type SyntheticStarAberration } from '../../../src/imaging/synthetic/aberration'

// Tests the allocation-free synthetic aberration evaluator independently from camera rendering.

// Builds a complete neutral configuration with selected overrides.
function config(overrides: Partial<SyntheticAberrationConfig> = {}): SyntheticAberrationConfig {
	return {
		enabled: true,
		sensorTiltEnabled: false,
		fieldCurvatureEnabled: false,
		backfocusEnabled: false,
		comaEnabled: false,
		astigmatismEnabled: false,
		decenterEnabled: false,
		collimationEnabled: false,
		decenterX: 0,
		decenterY: 0,
		focusRange: 1000,
		tilt: 0,
		tiltAngle: 0,
		curvature: 0,
		backfocus: 0,
		backfocusBlur: 4,
		backfocusEllipticity: 0.4,
		coma: 0,
		astigmatism: 0,
		astigmatismBlur: 4,
		astigmatismAngle: 0,
		collimation: 0,
		collimationAngle: 0,
		...overrides,
	}
}

// Allocates one result for reuse across evaluator calls.
function result(): SyntheticStarAberration {
	return { defocus: 0, focusOffset: 0, covarianceXX: 0, covarianceXY: 0, covarianceYY: 0, coma: 0, comaTheta: 0 }
}

test('disabled or empty aberration produces a neutral result', () => {
	const resolved = resolveSyntheticAberration(config())
	const out = result()

	expect(resolved.enabled).toBeFalse()
	expect(resolved.focusEnabled).toBeFalse()
	expect(evaluateSyntheticAberration(99, 12, 200, 100, 1200, 1000, resolved, out)).toBe(out)
	expect(out).toEqual(result())
})

test('tilt and curvature displace local best focus over the full sensor', () => {
	const tilt = resolveSyntheticAberration(config({ sensorTiltEnabled: true, tilt: 200, tiltAngle: 0 }))
	const curvature = resolveSyntheticAberration(config({ fieldCurvatureEnabled: true, curvature: 300 }))
	const out = result()

	evaluateSyntheticAberration(199, 49.5, 200, 100, 1200, 1000, tilt, out)
	expect(out.focusOffset).toBeCloseTo(200, 9)
	expect(out.defocus).toBeCloseTo(0, 9)

	evaluateSyntheticAberration(99.5, 49.5, 200, 100, 1000, 1000, curvature, out)
	expect(out.focusOffset).toBeCloseTo(0, 9)
	evaluateSyntheticAberration(199, 99, 200, 100, 1300, 1000, curvature, out)
	expect(out.focusOffset).toBeCloseTo(300, 9)
	expect(out.defocus).toBeCloseTo(0, 9)
})

test('backfocus sign swaps radial and tangential covariance', () => {
	const positive = resolveSyntheticAberration(config({ backfocusEnabled: true, backfocus: 1 }))
	const negative = resolveSyntheticAberration(config({ backfocusEnabled: true, backfocus: -1 }))
	const out = result()

	evaluateSyntheticAberration(199, 49.5, 200, 100, 1000, 1000, positive, out)
	expect(out.covarianceXX).toBeGreaterThan(out.covarianceYY)
	evaluateSyntheticAberration(199, 49.5, 200, 100, 1000, 1000, negative, out)
	expect(out.covarianceYY).toBeGreaterThan(out.covarianceXX)
})

test('decenter and collimation move and combine coma vectors without non-finite output', () => {
	const resolved = resolveSyntheticAberration(config({ comaEnabled: true, decenterEnabled: true, collimationEnabled: true, decenterX: 0.25, coma: 0.5, collimation: 0.2, collimationAngle: Math.PI / 2 }))
	const out = result()

	evaluateSyntheticAberration(149.25, 49.5, 200, 100, 1000, 1000, resolved, out)
	expect(out.coma).toBeCloseTo(0.2, 9)
	expect(out.comaTheta).toBeCloseTo(Math.PI / 2, 9)
	for (const value of Object.values(out)) expect(Number.isFinite(value)).toBeTrue()
})
