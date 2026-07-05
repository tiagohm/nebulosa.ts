import { expect, test } from 'bun:test'
import { grayscale, horizontalFlip, invert, verticalFlip } from '../../../src/imaging/processing/geometry'
import { expectImageValues, makeImage } from './processing.util'

test('horizontalFlip mirrors scanlines without mixing RGB channels', () => {
	const image = makeImage(3, 2, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
	horizontalFlip(image)
	expectImageValues(image, [7, 8, 9, 4, 5, 6, 1, 2, 3, 16, 17, 18, 13, 14, 15, 10, 11, 12], 8)
})

test('horizontalFlip is a no-op for single-column images', () => {
	const image = makeImage(1, 3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	const before = new Float32Array(image.raw)

	expect(horizontalFlip(image)).toBe(image)
	expectImageValues(image, before, 8)
})

test('verticalFlip swaps image rows in place', () => {
	const image = makeImage(2, 3, 1, [1, 2, 3, 4, 5, 6])
	verticalFlip(image)
	expectImageValues(image, [5, 6, 3, 4, 1, 2], 8)
})

test('verticalFlip is a no-op for single-row images', () => {
	const image = makeImage(3, 1, 1, [1, 2, 3])
	const before = new Float32Array(image.raw)

	expect(verticalFlip(image)).toBe(image)
	expectImageValues(image, before, 8)
})

test('invert complements normalized pixels', () => {
	const image = makeImage(3, 1, 1, [0, 0.25, 1])
	invert(image)
	expectImageValues(image, [1, 0.75, 0], 8)
})

test('grayscale converts RGB pixels using BT.709 weights', () => {
	const image = makeImage(2, 1, 3, [0.2, 0.4, 0.8, 0.1, 0.3, 0.5])
	const output = grayscale(image)

	expect(output.header.NAXIS).toBe(2)
	expect(output.header.NAXIS3).toBeUndefined()
	expect(output.metadata.channels).toBe(1)
	expect(output.metadata.stride).toBe(2)
	expectImageValues(output, [0.38634, 0.27192], 6)
})

test('grayscale returns the original image when already monochrome', () => {
	const image = makeImage(2, 1, 1, [0.2, 0.4])
	expect(grayscale(image)).toBe(image)
})

test('grayscale can extract a single RGB channel and clears CFA metadata', () => {
	const image = makeImage(2, 1, 3, [0.2, 0.4, 0.8, 0.1, 0.3, 0.5], { BAYERPAT: 'RGGB' })
	const output = grayscale(image, 'RED')

	expect(output.header.BAYERPAT).toBeUndefined()
	expect(output.metadata.bayer).toBeUndefined()
	expectImageValues(output, [0.2, 0.1], 8)
})
