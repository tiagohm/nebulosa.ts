import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { measureSubframeQuality, selectSubframes } from '../../../src/imaging/processing/subframe.selector'
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

	test('treats round stars as valid zero eccentricity measurements', () => {
		const metrics = measureSubframeQuality({ image: makeImage(), stars: [star({ eccentricity: 0, elongation: 1 })] })
		expect(metrics.medianEccentricity).toBe(0)
		expect(metrics.medianElongation).toBe(1)
	})
})
