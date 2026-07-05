import { expect, test } from 'bun:test'
import { brightness, contrast, gamma, linear, saturation } from '../../../src/imaging/processing/tone'
import { expectImageValues, makeImage } from './processing.util'

test('brightness scales pixel values and clamps them to one', () => {
	const image = makeImage(1, 3, 1, [0.2, 0.5, 0.8])
	brightness(image, 1.5)
	expectImageValues(image, [0.3, 0.75, 1], 6)
})

test('brightness is a no-op for unity and negative factors', () => {
	const unity = makeImage(2, 1, 1, [0.2, 0.8])
	const negative = makeImage(2, 1, 1, [0.2, 0.8])

	brightness(unity, 1)
	brightness(negative, -1)

	expectImageValues(unity, [0.2, 0.8], 6)
	expectImageValues(negative, [0.2, 0.8], 6)
})

test('saturation with zero amount collapses RGB pixels to grayscale', () => {
	const image = makeImage(1, 1, 3, [0.9, 0.2, 0.1])
	saturation(image, 0)
	expectImageValues(image, [0.34154, 0.34154, 0.34154], 6)
})

test('saturation is a no-op for monochrome data and unity gain', () => {
	const mono = makeImage(2, 1, 1, [0.2, 0.8])
	const color = makeImage(1, 1, 3, [0.7, 0.2, 0.1])
	const beforeColor = new Float32Array(color.raw)

	saturation(mono, 2)
	saturation(color, 1)

	expectImageValues(mono, [0.2, 0.8], 6)
	expectImageValues(color, beforeColor, 6)
})

test('saturation clamps oversaturated channels to the normalized range', () => {
	// A channel darker than the luminance extrapolates below 0 when value > 1.
	const image = makeImage(1, 1, 3, [0.1, 0.5, 0.5])
	saturation(image, 2)

	for (const value of image.raw) {
		expect(value).toBeGreaterThanOrEqual(0)
		expect(value).toBeLessThanOrEqual(1)
	}
})

test('linear applies slope and intercept with clamping', () => {
	const image = makeImage(3, 1, 1, [0, 0.5, 1])
	linear(image, 2, -0.25)
	expectImageValues(image, [0, 0.75, 1], 8)
})

test('linear is a no-op with identity parameters', () => {
	const image = makeImage(2, 1, 1, [0.2, 0.8])
	expect(linear(image, 1, 0)).toBe(image)
	expectImageValues(image, [0.2, 0.8], 6)
})

test('contrast remaps values around mid-gray', () => {
	const image = makeImage(3, 1, 1, [0, 0.5, 1])
	contrast(image, 0.5)
	expectImageValues(image, [0.25, 0.5, 0.75], 8)
})

test('contrast with zero amount collapses the image to mid-gray', () => {
	const image = makeImage(3, 1, 1, [0.1, 0.5, 0.9])
	contrast(image, 0)
	expectImageValues(image, [0.5, 0.5, 0.5], 8)
})

test('gamma applies the inverse power to each pixel', () => {
	const image = makeImage(3, 1, 1, [0.25, 0.5, 1])
	gamma(image, 2)
	expectImageValues(image, [0.5, Math.SQRT1_2, 1], 6)
})

test('gamma is a no-op outside the supported range', () => {
	const low = makeImage(2, 1, 1, [0.25, 1])
	const high = makeImage(2, 1, 1, [0.25, 1])

	gamma(low, 1)
	gamma(high, 3.1)

	expectImageValues(low, [0.25, 1], 8)
	expectImageValues(high, [0.25, 1], 8)
})
