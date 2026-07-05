import { expect, test } from 'bun:test'
import { clone } from '../../../src/imaging/processing/arithmetic'
import { blur, convolution, convolutionKernel, edges, emboss, gaussianBlur, mean, sharpen } from '../../../src/imaging/processing/convolution'
import { expectImageValues, makeImage, pixelOffset } from './processing.util'

test('convolutionKernel infers the divisor and validates the kernel size', () => {
	expect(convolutionKernel(new Int8Array([1, 2, 3, 4]), 2).divisor).toBe(10)
	expect(() => convolutionKernel(new Int8Array([1, 2, 3]), 2, 2)).toThrow('invalid kernel size')
})

test('convolution keeps the image unchanged with an identity kernel', () => {
	const image = makeImage(3, 3, 1, [0, 1, 2, 3, 4, 5, 6, 7, 8])
	const kernel = convolutionKernel(new Int8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]), 3)
	convolution(image, kernel)
	expectImageValues(image, [0, 1, 2, 3, 4, 5, 6, 7, 8], 8)
})

test('convolution rejects even and out-of-range kernel sizes', () => {
	const image = makeImage(3, 3, 1, [0, 1, 2, 3, 4, 5, 6, 7, 8])
	const evenKernel = convolutionKernel(new Int8Array([1, 1, 1, 1]), 2)
	const smallKernel = convolutionKernel(new Int8Array([1]), 1)

	expect(() => convolution(image, evenKernel)).toThrow('kernel size must be odd')
	expect(() => convolution(image, smallKernel)).toThrow('kernel size bust be in range [3..99]')
})

test('convolution dynamic edge divisors renormalize truncated neighborhoods', () => {
	const kernel = convolutionKernel(new Int8Array([1, 1, 1, 1, 1, 1, 1, 1, 1]), 3)
	const dynamic = makeImage(3, 3, 1, [1, 0, 0, 0, 0, 0, 0, 0, 0])
	const fixed = clone(dynamic)

	convolution(dynamic, kernel)
	convolution(fixed, kernel, { dynamicDivisorForEdges: false })

	expectImageValues(dynamic, [0.25, 1 / 6, 0, 1 / 6, 1 / 9, 0, 0, 0, 0], 6)
	expectImageValues(fixed, [1 / 9, 1 / 9, 0, 1 / 9, 1 / 9, 0, 0, 0, 0], 6)
})

test('edges generates the expected impulse response', () => {
	const image = makeImage(3, 3, 1, [0, 0, 0, 0, 1, 0, 0, 0, 0])
	edges(image)
	expectImageValues(image, [0, -1, 0, -1, 4.5, -1, 0, -1, 0], 8)
})

test('emboss shifts its impulse response around mid-gray', () => {
	const image = makeImage(3, 3, 1, [0, 0, 0, 0, 1, 0, 0, 0, 0])
	emboss(image)
	expectImageValues(image, [1, 0, 0.5, 0, 0.5, 1, 0.5, 1, 0], 8)
})

test('mean spreads a unit impulse uniformly across a 3x3 neighborhood', () => {
	const image = makeImage(5, 5, 1, new Float32Array(25))
	image.raw[12] = 1
	mean(image, 3)
	expectImageValues(image, [0, 0, 0, 0, 0, 0, 0.111111, 0.111111, 0.111111, 0, 0, 0.111111, 0.111111, 0.111111, 0, 0, 0.111111, 0.111111, 0.111111, 0, 0, 0, 0, 0, 0], 6)
})

test('mean rejects invalid kernel sizes', () => {
	const image = makeImage(3, 3, 1, new Float32Array(9))

	expect(() => mean(image, 4)).toThrow('size must be odd')
	expect(() => mean(image, 101)).toThrow('size must be less or equal to 99')
})

test('sharpen amplifies the impulse center and subtracts orthogonal neighbors', () => {
	const image = makeImage(5, 5, 1, new Float32Array(25))
	image.raw[12] = 1
	sharpen(image)
	expectImageValues(image, [0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, -1, 5, -1, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0], 8)
})

test('blur applies the 3x3 Pascal kernel around an impulse', () => {
	const image = makeImage(5, 5, 1, new Float32Array(25))
	image.raw[12] = 1
	blur(image, 3)
	expectImageValues(image, [0, 0, 0, 0, 0, 0, 0.0625, 0.125, 0.0625, 0, 0, 0.125, 0.25, 0.125, 0, 0, 0.0625, 0.125, 0.0625, 0, 0, 0, 0, 0, 0], 8)
})

test('blur rejects invalid kernel sizes', () => {
	const image = makeImage(3, 3, 1, new Float32Array(9))

	expect(() => blur(image, 4)).toThrow('size must be odd')
	expect(() => blur(image, 1)).toThrow('size must be greater or equal to 3')
})

test('gaussianBlur produces a symmetric monotonic halo around an impulse', () => {
	const image = makeImage(7, 7, 1, new Float32Array(49))
	const center = pixelOffset(image, 3, 3)
	const orthogonal = pixelOffset(image, 3, 2)
	const diagonal = pixelOffset(image, 2, 2)
	const outer = pixelOffset(image, 1, 1)

	image.raw[center] = 1

	gaussianBlur(image)

	expect(image.raw[center]).toBeCloseTo(0.093487374, 8)
	expect(image.raw[orthogonal]).toBeCloseTo(0.072437517, 8)
	expect(image.raw[diagonal]).toBeCloseTo(0.056127302, 8)
	expect(image.raw[outer]).toBeCloseTo(0.0153413, 7)
	expect(image.raw[center]).toBeGreaterThan(image.raw[orthogonal])
	expect(image.raw[orthogonal]).toBeGreaterThan(image.raw[diagonal])
	expect(image.raw[diagonal]).toBeGreaterThan(image.raw[outer])
	expect(image.raw[pixelOffset(image, 3, 2)]).toBeCloseTo(image.raw[pixelOffset(image, 3, 4)], 8)
	expect(image.raw[pixelOffset(image, 2, 3)]).toBeCloseTo(image.raw[pixelOffset(image, 4, 3)], 8)
	expect(image.raw[pixelOffset(image, 2, 2)]).toBeCloseTo(image.raw[pixelOffset(image, 4, 4)], 8)
	expect(image.raw[0]).toBeCloseTo(0, 8)
})

test('gaussianBlur preserves constant images', () => {
	const image = makeImage(5, 5, 1, new Float32Array(25).fill(0.25))

	gaussianBlur(image)

	expect(image.raw[0]).toBeCloseTo(0.25, 8)
	expect(image.raw[12]).toBeCloseTo(0.25, 8)
	expect(image.raw[24]).toBeCloseTo(0.25, 8)
})

test('gaussianBlur validates sigma and size', () => {
	const image = makeImage(5, 5, 1, new Float32Array(25))

	expect(() => gaussianBlur(image, { size: 2 })).toThrow('size must be odd and greater or equal to 3')
	expect(() => gaussianBlur(image, { sigma: 0.25 })).toThrow('kernel size bust be in range [0.5..5]')
})
