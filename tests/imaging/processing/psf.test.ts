import { expect, test } from 'bun:test'
import { psf } from '../../../src/imaging/processing/psf'
import { expectImageValues, makeImage, pixelOffset } from './processing.util'

test('psf removes a flat interior while leaving the untouched border unchanged', () => {
	const image = makeImage(11, 11, 1, new Float32Array(121).fill(1))

	psf(image)

	expect(image.raw[pixelOffset(image, 5, 5)]).toBeCloseTo(0, 8)
	expect(image.raw[pixelOffset(image, 5, 4)]).toBeCloseTo(0, 8)
	expect(image.raw[pixelOffset(image, 0, 0)]).toBeCloseTo(1, 8)
	expect(image.raw[pixelOffset(image, 3, 5)]).toBeCloseTo(1, 8)
})

test('psf leaves images smaller than its support unchanged', () => {
	const image = makeImage(8, 8, 1, new Float32Array(64).fill(0.3))
	const before = new Float32Array(image.raw)
	psf(image)
	expectImageValues(image, before, 8)
})
