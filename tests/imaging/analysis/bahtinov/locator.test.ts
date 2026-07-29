import { expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../../../../src/core/constants'
import { locateBahtinovPatterns } from '../../../../src/imaging/analysis/bahtinov/locator'
import type { Image } from '../../../../src/imaging/model/types'
import { plotBahtinovSpikes } from '../../../../src/imaging/stars/bahtinov'
import { plotStar } from '../../../../src/imaging/stars/generator'

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

const ANALYSIS_OPTIONS = {
	transform: 'linear' as const,
	coreRadius: 3,
	ridgeSigma: 2,
	maximumRidgePoints: 2048,
	minimumSignalToNoise: 1,
	minimumCoverage: 0.15,
	minimumBalance: 0.05,
	maximumResidual: 2,
	minimumConfidence: 0.05,
	minimumCandidateSeparation: 0.01,
}

test('locates an off-center pattern from line energy when star seeds are disabled', () => {
	const width = 320
	const height = 192
	const center = { x: 176, y: 96 }
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, center.x, center.y, 180, -3, undefined, {
		normalAngles: [(PI * 5) / 12, PIOVERTWO, (PI * 7) / 12],
		central: 1,
		fwhm: 2,
		halfLength: 44,
		taperLength: 7,
	})
	plotStar(raw, width, height, 1, 45, 45, 20, 3, 50, 0)
	const locations = locateBahtinovPatterns(image(raw, width, height), {
		roiSize: 128,
		gridStep: 48,
		maximumCandidates: 12,
		maximumPatterns: 2,
		minimumStarSignalToNoise: 1e9,
		analysis: ANALYSIS_OPTIONS,
	})
	expect(locations).toHaveLength(1)
	expect(locations[0].source).toBe('lineEnergy')
	expect(locations[0].score).toBeGreaterThan(0)
	expect(Math.hypot(locations[0].analysis.reference.x - center.x, locations[0].analysis.reference.y - center.y)).toBeLessThan(1)
	expect(Math.abs(locations[0].analysis.error + 3)).toBeLessThan(0.3)

	const combined = locateBahtinovPatterns(image(raw, width, height), {
		roiSize: 128,
		gridStep: 48,
		maximumCandidates: 12,
		maximumPatterns: 1,
		analysis: ANALYSIS_OPTIONS,
	})
	expect(combined).toHaveLength(1)
	expect(combined[0].source).toBe('combined')
})

test('returns no fabricated location for a blank frame and validates bounds', () => {
	const source = image(new Float64Array(128 * 128), 128, 128)
	expect(locateBahtinovPatterns(source, { roiSize: 128, analysis: ANALYSIS_OPTIONS })).toEqual([])
	expect(() => locateBahtinovPatterns(source, { roiSize: 16 })).toThrow(RangeError)
	expect(() => locateBahtinovPatterns(source, { maximumCandidates: 1, maximumPatterns: 2 })).toThrow(RangeError)
})
