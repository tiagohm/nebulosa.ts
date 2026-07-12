import { expect, test } from 'bun:test'
import { diagnoseFocusScan, diagnoseSingleFrameAberration } from '../../../src/imaging/analysis/aberration.diagnostic'
import type { AberrationInspectionQuality, AberrationStar } from '../../../src/imaging/analysis/aberration.types'
import type { StarProfile } from '../../../src/imaging/stars/profile'
import { analyzeFocusCurvature, analyzeFocusPlane, fitFocusSurface } from '../../../src/math/numerical/surface.fit'

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
		if (theta < 0) theta += Math.PI
		return star(u, v, theta)
	})
	const tangential = coordinates.map(([u, v]) => {
		let theta = Math.atan2(v, u) + Math.PI / 2
		if (theta >= Math.PI) theta -= Math.PI
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
