import { expect, test } from 'bun:test'
import { analyzeSaturation } from '../../../src/imaging/analysis/saturation'
import type { Image } from '../../../src/imaging/model/types'
import { Bitpix } from '../../../src/io/formats/fits/fits'

function image(width: number, height: number, channels: number, values: readonly number[]): Image {
	return { header: {}, raw: Float64Array.from(values), metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * 8, pixelSizeInBytes: 8, bitpix: Bitpix.DOUBLE, bayer: undefined } }
}

test('saturated pixels, their fraction, star cores, and the mask agree', () => {
	const frame = image(2, 2, 1, [0.2, 1, 0.4, 1.2])
	const analysis = analyzeSaturation(frame, {
		stars: [
			{ x: 1, y: 0 },
			{ x: 0.2, y: 0.2 },
			{ x: 9, y: 9 },
		],
	})
	expect(analysis.saturatedPixels).toBe(2)
	expect(analysis.fraction).toBeCloseTo(0.5, 12)
	expect(analysis.saturatedStars).toBe(1)
	expect(Array.from(analysis.mask)).toEqual([0, 1, 0, 1])

	const color = image(1, 1, 3, [0.2, 1, 0.2])
	expect(analyzeSaturation(color).saturatedPixels).toBe(1)
	expect(analyzeSaturation(frame, { level: 2 }).saturatedPixels).toBe(0)
})

test('row padding does not count as a saturated pixel', () => {
	const base = image(2, 2, 1, [0.2, 0.2, 9, 0.2, 0.2, 9])
	const padded = { ...base, metadata: { ...base.metadata, stride: 3, strideInBytes: 24 } }
	expect(analyzeSaturation(padded).saturatedPixels).toBe(0)
})
