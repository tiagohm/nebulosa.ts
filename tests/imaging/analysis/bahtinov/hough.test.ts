import { expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../../../../src/core/constants'
import { bahtinovAxialAngleDistance } from '../../../../src/imaging/analysis/bahtinov/geometry'
import { detectBahtinovHoughCandidates } from '../../../../src/imaging/analysis/bahtinov/hough'
import { preprocessBahtinov } from '../../../../src/imaging/analysis/bahtinov/preprocess'
import type { Image } from '../../../../src/imaging/model/types'
import { plotBahtinovSpikes } from '../../../../src/imaging/stars/bahtinov'

function image(raw: Float64Array, width: number, height: number): Image {
	return {
		raw,
		header: {},
		metadata: {
			width,
			height,
			channels: 1,
			stride: width,
			pixelCount: width * height,
			strideInBytes: width * 8,
			pixelSizeInBytes: 8,
			bitpix: -64,
			bayer: undefined,
		},
	}
}

test('detects and refines the three synthetic spike orientations', () => {
	const width = 96
	const height = 96
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	const expected = [PI / 12, 0, (PI * 11) / 12] as const
	plotBahtinovSpikes(raw, width, height, 1, 48, 48, 120, 2, undefined, { normalAngles: expected, halfLength: 34, taperLength: 5, fwhm: 1.7 })
	const preprocessed = preprocessBahtinov({ image: image(raw, width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 48, y: 48 } }, { transform: 'linear', coreRadius: 3, ridgeSigma: 2, maximumRidgePoints: 2048 })
	expect(preprocessed.success).toBeTrue()
	if (!preprocessed.success) return

	const candidates = detectBahtinovHoughCandidates(preprocessed.ridgePoints, width, height, preprocessed.workspace, {
		maximumCandidates: 8,
		minimumAxialSeparation: PI / 36,
		refinementRange: PI / 180,
		refinementStep: PI / 1800,
	})
	expect(candidates.length).toBeGreaterThanOrEqual(3)
	for (const angle of expected) {
		let best = Number.POSITIVE_INFINITY
		for (const candidate of candidates) best = Math.min(best, bahtinovAxialAngleDistance(candidate.normalAngle, angle))
		expect(best).toBeLessThan(PI / 360)
	}
	expect(candidates.every((candidate) => candidate.coverage > 0 && candidate.balance > 0 && Number.isFinite(candidate.distance))).toBeTrue()
})

test('handles axial NMS across zero and PI', () => {
	const width = 80
	const height = 80
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 40, 40, 100, 0, undefined, {
		normalAngles: [0.01, PIOVERTWO, PI - 0.01],
		central: 1,
		halfLength: 28,
		taperLength: 4,
	})
	const preprocessed = preprocessBahtinov({ image: image(raw, width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 40, y: 40 } }, { coreRadius: 2, ridgeSigma: 2 })
	expect(preprocessed.success).toBeTrue()
	if (!preprocessed.success) return
	const candidates = detectBahtinovHoughCandidates(preprocessed.ridgePoints, width, height, preprocessed.workspace, { minimumAxialSeparation: PI / 18 })
	const boundaryCandidates = candidates.filter((candidate) => bahtinovAxialAngleDistance(candidate.normalAngle, 0) < PI / 36)
	expect(boundaryCandidates.length).toBe(1)
})
