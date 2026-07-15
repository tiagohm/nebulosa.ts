import { expect, test } from 'bun:test'
import type { ImageMetadata, ImageRawType } from '../../../src/imaging/model/types'
import { clone } from '../../../src/imaging/processing/arithmetic'
import { blur, convolution, convolutionKernel, edges, emboss, gaussianBlur, mean, separableSmoothingKernel, separableSmoothing, sharpen } from '../../../src/imaging/processing/convolution'
import { expectImageValues, makeImage, pixelOffset } from './util'

// Applies the separable kernel as one direct 2D convolution for an independent small-image reference.
function directSeparableReference(source: ImageRawType, metadata: ImageMetadata, weights: Readonly<Int8Array>, divisor: number, step: number, dynamicDivisorForEdges: boolean) {
	const { width, height, channels, stride } = metadata
	const radius = weights.length >>> 1
	const output = new Float64Array(source.length)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (let channel = 0; channel < channels; channel++) {
				let sum = 0
				let effectiveDivisor = dynamicDivisorForEdges ? 0 : divisor * divisor

				for (let tapY = 0; tapY < weights.length; tapY++) {
					const sampleY = y + (tapY - radius) * step
					if (sampleY < 0 || sampleY >= height) continue

					for (let tapX = 0; tapX < weights.length; tapX++) {
						const sampleX = x + (tapX - radius) * step
						if (sampleX < 0 || sampleX >= width) continue

						const weight = weights[tapY] * weights[tapX]
						sum += weight * source[sampleY * stride + sampleX * channels + channel]
						if (dynamicDivisorForEdges) effectiveDivisor += weight
					}
				}

				if (effectiveDivisor === 0) effectiveDivisor = divisor * divisor
				output[y * stride + x * channels + channel] = sum / effectiveDivisor
			}
		}
	}

	return output
}

// Runs raw separable convolution with fresh same-precision output and intermediate buffers.
function runSeparable(source: ImageRawType, metadata: ImageMetadata, step: number, dynamicDivisorForEdges: boolean = true) {
	const output = source instanceof Float64Array ? new Float64Array(source.length) : new Float32Array(source.length)
	const intermediate = source instanceof Float64Array ? new Float64Array(source.length) : new Float32Array(source.length)
	const kernel = separableSmoothingKernel(new Int8Array([1, 4, 6, 4, 1]), 16)
	separableSmoothing(source, output, intermediate, metadata, kernel, { step, dynamicDivisorForEdges })
	return output
}

test('convolutionKernel infers the divisor and validates the kernel size', () => {
	expect(convolutionKernel(new Int8Array([1, 2, 3, 4]), 2).divisor).toBe(10)
	expect(() => convolutionKernel(new Int8Array([1, 2, 3]), 2, 2)).toThrow('invalid kernel size')
})

test('separableSmoothingKernel validates odd non-negative smoothing kernels and divisors', () => {
	expect(separableSmoothingKernel(new Int8Array([1, 2, 1])).divisor).toBe(4)
	expect(() => separableSmoothingKernel(new Int8Array([1, 1]))).toThrow('length must be odd')
	expect(() => separableSmoothingKernel(new Int8Array([1]))).toThrow('at least 3')
	expect(() => separableSmoothingKernel([1, Number.NaN, 1])).toThrow('value must be finite')
	expect(() => separableSmoothingKernel([1, -1, 1])).toThrow('value must be non-negative')
	expect(() => separableSmoothingKernel(new Int8Array([1, 2, 1]), 0)).toThrow('value must be positive')
	expect(() => separableSmoothingKernel(new Int8Array([1, 2, 1]), Number.POSITIVE_INFINITY)).toThrow('value must be finite')
})

test('separableSmoothing validates steps, layouts, precision, and buffer aliases', () => {
	const metadata = makeImage(3, 2, 1, new Float32Array(6)).metadata
	const source = new Float32Array(6)
	const output = new Float32Array(6)
	const intermediate = new Float32Array(6)
	const kernel = separableSmoothingKernel(new Int8Array([1, 2, 1]))
	const wideKernel = separableSmoothingKernel(new Int8Array([1, 1, 1, 1, 1]))

	expect(() => separableSmoothing(source, output, intermediate, metadata, kernel, { step: 0 })).toThrow('positive integer')
	expect(() => separableSmoothing(source, output, intermediate, metadata, kernel, { step: 1.5 })).toThrow('positive integer')
	expect(() => separableSmoothing(source, output, intermediate, metadata, kernel, { step: Number.POSITIVE_INFINITY })).toThrow('positive integer')
	expect(() => separableSmoothing(source, output, intermediate, metadata, wideKernel, { step: Number.MAX_VALUE })).toThrow('effective radius must be finite')
	expect(() => separableSmoothing(source.subarray(0, 5), output, intermediate, metadata, kernel)).toThrow('match image metadata')
	expect(() => separableSmoothing(source, new Float64Array(6), intermediate, metadata, kernel)).toThrow('same precision')
	expect(() => separableSmoothing(source, source, intermediate, metadata, kernel)).toThrow('must not alias')
	expect(() => separableSmoothing(source, output, new Float32Array(output.buffer), metadata, kernel)).toThrow('must not alias')
	expect(() => separableSmoothing(source, output, intermediate, { ...metadata, stride: 4 }, kernel)).toThrow('invalid image metadata')
})

test('separableSmoothing preserves mono and RGB constants at every border and large steps', () => {
	for (const precision of [32, 64] as const) {
		for (const channels of [1, 3] as const) {
			const metadata = makeImage(4, 3, channels, new Float32Array(4 * 3 * channels)).metadata
			const values = new Array<number>(metadata.stride * metadata.height)

			for (let i = 0; i < values.length; i++) values[i] = channels === 1 ? 0.25 : [0.2, 0.5, 0.8][i % channels]

			const source = precision === 64 ? new Float64Array(values) : new Float32Array(values)

			for (const step of [1, 9]) {
				const output = runSeparable(source, metadata, step)
				expect(output.constructor).toBe(source.constructor)

				for (let i = 0; i < output.length; i++) expect(output[i]).toBeCloseTo(values[i], precision === 64 ? 12 : 6)
			}
		}
	}
})

test('separableSmoothing produces the B3-spline impulse response without expanded kernels', () => {
	const image = makeImage(9, 9, 1, new Float32Array(81))
	image.raw[pixelOffset(image, 4, 4)] = 1
	const output = runSeparable(image.raw, image.metadata, 1)

	expect(output[pixelOffset(image, 4, 4)]).toBeCloseTo(36 / 256, 8)
	expect(output[pixelOffset(image, 5, 4)]).toBeCloseTo(24 / 256, 8)
	expect(output[pixelOffset(image, 5, 5)]).toBeCloseTo(16 / 256, 8)
})

test('separableSmoothing dilates taps at exact multiples of the requested step', () => {
	const image = makeImage(13, 13, 1, new Float32Array(169))
	image.raw[pixelOffset(image, 6, 6)] = 1
	const output = runSeparable(image.raw, image.metadata, 2)

	expect(output[pixelOffset(image, 6, 6)]).toBeCloseTo(36 / 256, 8)
	expect(output[pixelOffset(image, 7, 6)]).toBe(0)
	expect(output[pixelOffset(image, 8, 6)]).toBeCloseTo(24 / 256, 8)
	expect(output[pixelOffset(image, 8, 8)]).toBeCloseTo(16 / 256, 8)
})

test('separableSmoothing matches independent direct 2D references for edge modes and steps', () => {
	const weights = new Int8Array([1, 4, 6, 4, 1])
	const metadata = makeImage(5, 4, 3, new Float32Array(60)).metadata

	for (const precision of [32, 64] as const) {
		const values = new Array<number>(60)
		for (let i = 0; i < values.length; i++) values[i] = ((i * 37 + 11) % 101) / 37 - 0.6
		const source = precision === 64 ? new Float64Array(values) : new Float32Array(values)

		for (const dynamicDivisorForEdges of [true, false]) {
			for (const step of [1, 2, 7]) {
				const expected = directSeparableReference(source, metadata, weights, 16, step, dynamicDivisorForEdges)
				const output = runSeparable(source, metadata, step, dynamicDivisorForEdges)

				for (let i = 0; i < output.length; i++) expect(Math.abs(output[i] - expected[i])).toBeLessThanOrEqual(precision === 64 ? 1e-12 : 1e-6)
			}
		}
	}
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
