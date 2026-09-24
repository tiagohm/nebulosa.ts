import { describe, expect, test } from 'bun:test'
import { estimateBackground } from '../../../src/imaging/analysis/background'
import type { Image } from '../../../src/imaging/model/types'
import { imageQualityScore, measureSubframeQuality, selectSubframes } from '../../../src/imaging/processing/subframe.selector'
import { Bitpix } from '../../../src/io/formats/fits/fits'

// Builds a minimal image used only for deterministic background measurement.
function makeImage(value: number = 0.1): Image {
	const raw = new Float32Array([value])
	return { header: {}, raw, metadata: { width: 1, height: 1, channels: 1, pixelCount: 1, stride: 1, strideInBytes: 4, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined } }
}

// Builds a star carrying the metrics required by the subframe selector.
function star(overrides: Partial<{ snr: number; hfd: number; fwhm: number; eccentricity: number; elongation: number }> = {}) {
	return { x: 0, y: 0, flux: 100, snr: 20, hfd: 2, fwhm: 2.2, eccentricity: 0.1, elongation: 1.01, ...overrides }
}

describe('subframe selector', () => {
	test('measures quality and preserves frame identity and order without thresholds', () => {
		const first = { image: makeImage(0.2), stars: [star(), star({ snr: 30, hfd: 3, fwhm: 2.6, eccentricity: 0.2, elongation: 1.1 })], id: 'first' }
		const second = { image: makeImage(0.3), stars: [star({ snr: 10 })], id: 'second' }
		const selection = selectSubframes([first, second])

		expect(selection.accepted).toEqual([first, second])
		expect(selection.results.map((result) => result.frame)).toEqual([first, second])
		expect(selection.results.every((result) => result.accepted)).toBeTrue()
		expect(selection.results[0].metrics.medianSNR).toBe(25)
		expect(selection.results[0].metrics.medianHFD).toBe(2.5)
		expect(selection.results[0].metrics.medianFWHM).toBeCloseTo(2.4, 12)
		expect(selection.results[0].metrics.estimatedBackground).toBeCloseTo(0.2, 8)
	})

	test('reports every configured threshold failure for a rejected frame', () => {
		const frame = { image: makeImage(), stars: [star({ snr: 3, hfd: 5, fwhm: 5, eccentricity: 0.8, elongation: 2 })] }
		const selection = selectSubframes([frame], { minStars: 2, minMedianSNR: 10, maxMedianHFD: 3, maxMedianFWHM: 3, maxMedianEccentricity: 0.5, maxMedianElongation: 1.5 })

		expect(selection.accepted).toEqual([])
		expect(selection.results[0].reasons).toEqual(['too-few-stars', 'median-snr-too-low', 'median-hfd-too-high', 'median-fwhm-too-high', 'median-eccentricity-too-high', 'median-elongation-too-high'])
	})

	test('only rejects unavailable shape measurements when their thresholds are requested', () => {
		const frame = { image: makeImage(), stars: [{ x: 0, y: 0, flux: 100, snr: 20, hfd: 2 }] }
		expect(selectSubframes([frame]).results[0].accepted).toBeTrue()

		const selection = selectSubframes([frame], { maxMedianFWHM: 3, maxMedianEccentricity: 0.5, maxMedianElongation: 1.5 })
		expect(selection.results[0].reasons).toEqual(['median-fwhm-unavailable', 'median-eccentricity-unavailable', 'median-elongation-unavailable'])
	})

	test('scores a clean sharp field at one and rejects background, noise, and a low score', () => {
		expect(imageQualityScore({ starCount: 100, medianHFD: 2, medianEccentricity: 0, medianSNR: 50, estimatedBackground: 0, noise: 0 })).toBeCloseTo(1, 12)
		expect(imageQualityScore({ starCount: 0 })).toBe(0)
		expect(imageQualityScore({ starCount: 100, medianHFD: 2, medianEccentricity: 0, medianSNR: 50, estimatedBackground: 0, noise: 0 }, { scale: 100 })).toBeCloseTo(100, 8)
		const sharp = imageQualityScore({ starCount: 100, medianHFD: 2, medianEccentricity: 0.1, medianSNR: 50 })
		const trailed = imageQualityScore({ starCount: 100, medianHFD: 2, medianEccentricity: 0.6, medianSNR: 50 })
		expect(trailed).toBeLessThan(sharp)

		const frame = { image: makeImage(0.2), stars: [star()] }
		expect(selectSubframes([frame], { maxBackground: 0.05 }).results[0]?.reasons).toEqual(['background-too-high'])
		expect(selectSubframes([frame], { minNormalizedScore: 1 }).results[0]?.reasons).toEqual(['normalized-score-too-low'])
		const pair = new Float32Array([0, 1])
		const noisyImage = { ...makeImage(), raw: pair, metadata: { ...makeImage().metadata, width: 2, pixelCount: 2, stride: 2, strideInBytes: 8 } }
		expect(selectSubframes([{ image: noisyImage, stars: [star()] }], { maxNoise: 0.01 }).results[0]?.reasons).toContain('noise-too-high')
	})

	test('treats round stars as valid zero eccentricity measurements', () => {
		const metrics = measureSubframeQuality({ image: makeImage(), stars: [star({ eccentricity: 0, elongation: 1 })] })
		expect(metrics.medianEccentricity).toBe(0)
		expect(metrics.medianElongation).toBe(1)
	})

	test('uses the shared stride-aware background estimator for padded mono and RGB rows', () => {
		const mono: Image = {
			header: {},
			raw: new Float32Array([0.2, 9, 0.2, 9]),
			metadata: { width: 1, height: 2, channels: 1, pixelCount: 2, stride: 2, strideInBytes: 8, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
		}
		const rgb: Image = {
			header: {},
			raw: new Float32Array([0.1, 0.2, 0.3, 9, 0.1, 0.2, 0.3, 9]),
			metadata: { width: 1, height: 2, channels: 3, pixelCount: 2, stride: 4, strideInBytes: 16, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
		}

		for (const image of [mono, rgb]) {
			const expected = estimateBackground(image)
			const measured = measureSubframeQuality({ image, stars: [star()] })
			expect(measured.estimatedBackground).toBeCloseTo(expected.background, 12)
			expect(measured.noise).toBeCloseTo(expected.noise, 12)
		}

		expect(selectSubframes([{ image: mono, stars: [star()] }], { maxBackground: 0.3, maxNoise: 0.01 }).results[0]?.accepted).toBeTrue()
	})
})
