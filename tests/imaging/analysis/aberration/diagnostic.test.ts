import { expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../../../../src/core/constants'
import { diagnoseFocusScan, diagnoseSingleFrameAberration } from '../../../../src/imaging/analysis/aberration/diagnostic'
import type { AberrationInspectionQuality, AberrationStar } from '../../../../src/imaging/analysis/aberration/types'
import type { StarProfile } from '../../../../src/imaging/stars/profile'
import { gaussian, mulberry32 } from '../../../../src/math/numerical/random'
import { analyzeFocusCurvature, analyzeFocusPlane, fitFocusSurface, type FocusSurfaceSample } from '../../../../src/math/numerical/surface.fit'

// Creates a valid selected profile with a prescribed axial direction in normalized sensor coordinates.
function star(u: number, v: number, theta: number): AberrationStar {
	const profile: StarProfile = {
		x: u,
		y: v,
		valid: true,
		flux: 1,
		snr: 30,
		hfd: 2,
		fwhm: 2,
		major: 2.4,
		minor: 2,
		eccentricity: 0.4,
		elongation: 1.2,
		theta,
		background: 0,
		deviation: 0.01,
		peak: 0.5,
		quality: 1,
		model: 'moments',
		flags: [],
	}

	return { profile, u, v, weight: 1, selected: true, selectionReasons: [], rejections: [] }
}

// Creates sufficient support diagnostics for direct pattern tests.
function quality(count: number): AberrationInspectionQuality {
	return {
		detectedStarCount: count,
		profiledStarCount: count,
		selectedStarCount: count,
		usedStarCountByMetric: { hfd: count, fwhm: count, eccentricity: count, elongation: count, orientation: count },
		fullyRejectedStarCount: 0,
		occupiedRegionCount: 2,
		confidence: 1,
		warnings: [],
	}
}

// Recognizes radial and tangential axial patterns without emitting definitive optical diagnoses.
test('reports radial and tangential elongation findings from axial orientation', () => {
	const coordinates = [
		[-0.5, 0],
		[0.5, 0],
		[0, -0.5],
		[0, 0.5],
		[-0.35, -0.35],
		[0.35, 0.35],
	] as const
	const radial = coordinates.map(([u, v]) => {
		let theta = Math.atan2(v, u)
		if (theta < 0) theta += PI
		return star(u, v, theta)
	})
	const tangential = coordinates.map(([u, v]) => {
		let theta = Math.atan2(v, u) + PIOVERTWO
		if (theta >= PI) theta -= PI
		return star(u, v, theta)
	})

	expect(diagnoseSingleFrameAberration(radial, [], quality(radial.length)).some((finding) => finding.kind === 'radialElongation')).toBeTrue()
	expect(diagnoseSingleFrameAberration(tangential, [], quality(tangential.length)).some((finding) => finding.kind === 'tangentialElongation')).toBeTrue()
})

// Keeps supported scalar findings decisive when round profiles provide no usable orientation.
test('does not append inconclusive to supported size findings', () => {
	const samples = [
		[-0.1, 0, 2],
		[0.1, 0, 2],
		[-0.5, 0, 3],
		[0.5, 0, 3],
		[0, -0.5, 3],
		[0, 0.5, 3],
	] as const
	const stars: AberrationStar[] = []
	for (let i = 0; i < samples.length; i++) {
		const [u, v, hfd] = samples[i]
		const sample = star(u, v, 0)
		stars.push({ ...sample, profile: { ...sample.profile, hfd, fwhm: hfd, eccentricity: 0, elongation: 1, theta: undefined } })
	}
	const support = quality(stars.length)
	const findings = diagnoseSingleFrameAberration(stars, [], { ...support, usedStarCountByMetric: { ...support.usedStarCountByMetric, orientation: 0 } })

	expect(findings.some((finding) => finding.kind === 'fieldDegradation')).toBeTrue()
	expect(findings.some((finding) => finding.kind === 'inconclusive')).toBeFalse()
})

// Refuses significance-based scan findings when the exact-fit surface has no residual degrees of freedom.
test('keeps focus-scan findings inconclusive without covariance', () => {
	const fit = fitFocusSurface(
		[
			{ u: -0.5, v: -0.5, focus: 90 },
			{ u: 0.5, v: -0.5, focus: 100 },
			{ u: 0, v: 0.5, focus: 95 },
		],
		{ model: 'plane' },
	)
	expect(fit.success).toBeTrue()
	if (!fit.success) return
	const findings = diagnoseFocusScan(fit, analyzeFocusPlane(fit.coefficients), analyzeFocusCurvature(fit.coefficients), undefined)
	expect(findings).toHaveLength(1)
	expect(findings[0].kind).toBe('inconclusive')
	expect(findings[0].limitations).toContain('modelUncertaintyUnavailable')
})

// Noisy z=100 + N(0,1) 3x3 grid from LCG seed 1; the old 3σ delta-method gate published tilt and curvature.
const NOISY_FLAT_3X3: readonly FocusSurfaceSample[] = [
	{ u: -0.4, v: -0.4, focus: 98.84316564655502 },
	{ u: 0, v: -0.4, focus: 99.67269690520615 },
	{ u: 0.4, v: -0.4, focus: 98.33282674378123 },
	{ u: -0.4, v: 0, focus: 99.32964171470479 },
	{ u: 0, v: 0, focus: 98.16318824383922 },
	{ u: 0.4, v: 0, focus: 98.52998936899165 },
	{ u: -0.4, v: 0.4, focus: 100.53303078585172 },
	{ u: 0, v: 0.4, focus: 101.68936531324222 },
	{ u: 0.4, v: 0.4, focus: 99.74578212901984 },
]

// Builds a regular normalized-sensor grid with an optional additive noise sampler.
function focusGrid(size: number, focus: (u: number, v: number) => number): FocusSurfaceSample[] {
	const samples: FocusSurfaceSample[] = []
	const step = size === 1 ? 0 : 0.8 / (size - 1)
	for (let row = 0; row < size; row++) {
		const v = -0.4 + step * row
		for (let col = 0; col < size; col++) {
			const u = -0.4 + step * col
			samples.push({ u, v, focus: focus(u, v) })
		}
	}
	return samples
}

// Diagnoses a surface fit with the public scan entry point, returning no findings when the fit fails.
function scanFindings(samples: readonly FocusSurfaceSample[], model: 'plane' | 'radialQuadratic' | 'quadratic' = 'quadratic') {
	const fit = fitFocusSurface(samples, { model })
	if (!fit.success) return { fit, findings: [] as ReturnType<typeof diagnoseFocusScan> }
	return { fit, findings: diagnoseFocusScan(fit, analyzeFocusPlane(fit.coefficients), analyzeFocusCurvature(fit.coefficients), undefined) }
}

// Refuses tilt/curvature claims on a low-df quadratic interpolant of a noisy flat field.
test('keeps a noisy flat 3x3 quadratic scan inconclusive', () => {
	const { fit, findings } = scanFindings(NOISY_FLAT_3X3)
	expect(fit.success).toBeTrue()
	if (!fit.success) return
	expect(fit.covariance).toBeDefined()
	expect(fit.degreesOfFreedom).toBeLessThan(10)
	expect(findings.some((finding) => finding.kind === 'sensorTiltPattern' || finding.kind === 'fieldCurvature' || finding.kind === 'astigmaticCurvature')).toBeFalse()
	expect(findings.some((finding) => finding.kind === 'inconclusive')).toBeTrue()
})

// Wald/F 3σ budget is ~0.27%; 5% is a loose Monte Carlo ceiling that still fails the old ~50% rate.
test('keeps false tilt and curvature rare on noisy flat quadratic grids', () => {
	const noise = gaussian(mulberry32(20260912), 1)
	let used = 0
	let tilt = 0
	let curvature = 0
	for (let trial = 0; trial < 250; trial++) {
		const { fit, findings } = scanFindings(focusGrid(3, () => 100 + noise()))
		if (!fit.success || !('covariance' in fit) || fit.covariance === undefined) continue
		used++
		if (findings.some((finding) => finding.kind === 'sensorTiltPattern')) tilt++
		if (findings.some((finding) => finding.kind === 'fieldCurvature')) curvature++
	}
	expect(used).toBeGreaterThan(200)
	expect(tilt / used).toBeLessThan(0.05)
	expect(curvature / used).toBeLessThan(0.05)
})

// A large planar gradient remains detectable under measurement noise on an overdetermined grid.
test('reports sensor tilt from a noisy planar 5x5 quadratic fit', () => {
	const noise = gaussian(mulberry32(7), 0.5)
	const { fit, findings } = scanFindings(focusGrid(5, (u, v) => 100 + 18 * u - 7 * v + noise()))
	expect(fit.success).toBeTrue()
	expect(findings.some((finding) => finding.kind === 'sensorTiltPattern')).toBeTrue()
})

// Exact planar field on the default quadratic still has infinite Wald significance when residuals vanish.
test('reports sensor tilt from an exact planar 3x3 quadratic fit', () => {
	const { fit, findings } = scanFindings(focusGrid(3, (u, v) => 100 + 20 * u - 8 * v))
	expect(fit.success).toBeTrue()
	expect(findings.some((finding) => finding.kind === 'sensorTiltPattern')).toBeTrue()
	expect(findings.some((finding) => finding.kind === 'fieldCurvature')).toBeFalse()
})

// Overdetermined noiseless bowl must remain detectable after the Wald/F gate.
test('reports field curvature from an exact quadratic bowl', () => {
	const samples: FocusSurfaceSample[] = []
	for (let v = -0.5; v <= 0.5; v += 0.25) {
		for (let u = -0.5; u <= 0.5; u += 0.25) samples.push({ u, v, focus: 100 + 40 * (u * u + v * v) })
	}
	const { fit, findings } = scanFindings(samples)
	expect(fit.success).toBeTrue()
	expect(findings.some((finding) => finding.kind === 'fieldCurvature')).toBeTrue()
})
