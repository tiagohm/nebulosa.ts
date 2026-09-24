import { expect, test } from 'bun:test'
import { BAD_PIXEL_COLD, BAD_PIXEL_HOT, detectBadPixels } from '../../../src/imaging/analysis/badpixel'
import type { Image } from '../../../src/imaging/model/types'
import { Bitpix } from '../../../src/io/formats/fits/fits'

function image(values: number[]): Image {
	const width = 5
	const height = 5
	return { header: {}, raw: Float64Array.from(values), metadata: { width, height, channels: 1, pixelCount: width * height, stride: width, strideInBytes: width * 8, pixelSizeInBytes: 8, bitpix: Bitpix.DOUBLE, bayer: undefined } }
}

test('an isolated hot pixel and an isolated cold pixel are masked, and a peaked star is not', () => {
	const flat = new Array(25).fill(0.2)
	const defects = image(flat.slice())
	defects.raw[12] = 1
	defects.raw[6] = 0
	const detected = detectBadPixels(defects)
	expect(detected.hot).toBe(1)
	expect(detected.cold).toBe(1)
	expect(detected.mask[12]).toBe(BAD_PIXEL_HOT)
	expect(detected.mask[6]).toBe(BAD_PIXEL_COLD)
	expect(detectBadPixels(image(flat)).hot).toBe(0)
	expect(detectBadPixels(image(flat)).cold).toBe(0)

	const star = image(flat.slice())
	star.raw[12] = 1
	star.raw[11] = 0.8
	star.raw[13] = 0.8
	expect(detectBadPixels(star).hot).toBe(0)
})
