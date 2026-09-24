import { expect, test } from 'bun:test'
import { estimateBackground } from '../../../src/imaging/analysis/background'
import type { Image } from '../../../src/imaging/model/types'
import { Bitpix } from '../../../src/io/formats/fits/fits'
import { STANDARD_DEVIATION_SCALE } from '../../../src/math/numerical/statistics'

function image(width: number, height: number, values: readonly number[], channels = 1): Image {
	const raw = Float64Array.from(values)
	return { header: {}, raw, metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * 8, pixelSizeInBytes: 8, bitpix: Bitpix.DOUBLE, bayer: undefined } }
}

test('a constant frame has that background, no noise, and no contrast', () => {
	const estimate = estimateBackground(image(4, 4, new Array(16).fill(0.25)))
	expect(estimate.background).toBeCloseTo(0.25, 12)
	expect(estimate.noise).toBe(0)
	expect(estimate.snr).toBe(0)
	expect(estimateBackground(image(0, 0, []))).toEqual({ background: 0, noise: 0, snr: 0 })
})

test('cell medians set the background and the brightest cell sets the snr', () => {
	const estimate = estimateBackground(image(2, 2, [0, 1, 2, 3]))
	const noise = STANDARD_DEVIATION_SCALE
	expect(estimate.background).toBeCloseTo(1.5, 12)
	expect(estimate.noise).toBeCloseTo(noise, 12)
	expect(estimate.snr).toBeCloseTo(1.5 / noise, 12)
})

test('row padding is not sampled as image data', () => {
	const base = image(2, 2, [0.25, 0.25, 9, 0.25, 0.25, 9])
	const padded = { ...base, metadata: { ...base.metadata, stride: 3, strideInBytes: 24 } }
	expect(estimateBackground(padded)).toEqual({ background: 0.25, noise: 0, snr: 0 })
})
