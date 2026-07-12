import { expect, test } from 'bun:test'
import { diagnoseSingleFrameAberration } from '../../../src/imaging/analysis/aberration.diagnostic'
import type { AberrationInspectionQuality, AberrationStar } from '../../../src/imaging/analysis/aberration.types'
import type { StarProfile } from '../../../src/imaging/stars/profile'

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
