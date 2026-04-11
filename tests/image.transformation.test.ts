import { expect, test } from 'bun:test'
import { Bitpix, type FitsHeader } from '../src/fits'
import { cfaPatternKeyword } from '../src/fits.util'
import { arcsinhStretch, bayer, blur, brightness, calibrate, clone, contrast, convolution, convolutionKernel, debayer, edges, emboss, FFTWorkspace, fft, gamma, gaussianBlur, grayscale, horizontalFlip, invert, linear, mean, psf, saturation, scnr, sharpen, stf, verticalFlip } from '../src/image.transformation'
import type { Image } from '../src/image.types'
import type { NumberArray } from '../src/math'

// Creates a normalized Float32 image with the provided interleaved pixel data.
function makeImage(width: number, height: number, channels: number, values: Readonly<NumberArray>, header?: FitsHeader): Image {
	return {
		header: { NAXIS: channels === 1 ? 2 : 3, NAXIS3: channels === 1 ? undefined : channels, ...header },
		metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * channels * 4, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: header && cfaPatternKeyword(header) },
		raw: values instanceof Float32Array ? values : new Float32Array(values),
	}
}

// Computes the mean absolute horizontal neighbor delta for one-channel images.
function meanHorizontalDelta(image: Image) {
	const { width, height, stride } = image.metadata
	const { raw } = image
	let sum = 0
	let count = 0

	for (let y = 0; y < height; y++) {
		const row = y * stride

		for (let x = 1; x < width; x++) {
			sum += Math.abs(raw[row + x] - raw[row + x - 1])
			count++
		}
	}

	return sum / count
}

// Computes the mean absolute difference between two images of the same shape.
function meanAbsoluteDifference(a: Image, b: Image) {
	let sum = 0
	for (let i = 0; i < a.raw.length; i++) sum += Math.abs(a.raw[i] - b.raw[i])
	return sum / a.raw.length
}

// Computes the arithmetic mean of an image plane.
function imageMean(image: Image) {
	let sum = 0
	for (let i = 0; i < image.raw.length; i++) sum += image.raw[i]
	return sum / image.raw.length
}

// Computes the linear raw offset of a pixel channel.
function pixelOffset(image: Image, x: number, y: number, channel: number = 0) {
	return y * image.metadata.stride + x * image.metadata.channels + channel
}

// Asserts that the raw pixel buffer matches the expected values within tolerance.
function expectImageValues(image: Image, expected: Readonly<NumberArray>, precision: number = 6) {
	expect(image.raw.length).toBe(expected.length)

	for (let i = 0; i < expected.length; i++) {
		expect(image.raw[i]).toBeCloseTo(expected[i], precision)
	}
}

// Returns the first radius where the impulse profile falls below half peak.
function halfMaximumRadius(image: Image, centerX: number, centerY: number, stepX: number, stepY: number) {
	const peak = image.raw[centerY * image.metadata.stride + centerX]
	const threshold = peak * 0.5
	const maxRadius = stepX !== 0 ? image.metadata.width - centerX - 1 : image.metadata.height - centerY - 1

	for (let radius = 1; radius <= maxRadius; radius++) {
		const x = centerX + radius * stepX
		const y = centerY + radius * stepY

		if (image.raw[y * image.metadata.stride + x] <= threshold) return radius
	}

	return maxRadius
}

test('fft keeps the input unchanged when weight is zero', () => {
	const image = makeImage(5, 3, 1, [0.1, 0.2, 0.3, 0.4, 0.5, 0.15, 0.25, 0.35, 0.45, 0.55, 0.12, 0.22, 0.32, 0.42, 0.52])
	const before = new Float32Array(image.raw)
	const workspace = new FFTWorkspace(5, 3)

	const output = fft(image, workspace, 'lowPass', 0.2, 0)

	expect(output).toBe(image)
	expect(output.metadata.width).toBe(5)
	expect(output.metadata.height).toBe(3)

	for (let i = 0; i < before.length; i++) {
		expect(output.raw[i]).toBeCloseTo(before[i], 8)
	}
})

test('fft rejects a workspace smaller than the image', () => {
	const image = makeImage(5, 3, 1, [0.1, 0.2, 0.3, 0.4, 0.5, 0.15, 0.25, 0.35, 0.45, 0.55, 0.12, 0.22, 0.32, 0.42, 0.52])
	const workspace = new FFTWorkspace(2, 2)

	expect(() => fft(image, workspace, 'lowPass', 0.2, 1)).toThrow('FFT workspace 2x2 is smaller than image 5x3')
})

test('fft low-pass with a small cutoff strongly smooths checkerboard detail', () => {
	const width = 16
	const height = 12
	const values = new Array<number>(width * height)

	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++, i++) {
			values[i] = (x + y) & 1
		}
	}

	const image = makeImage(width, height, 1, values)
	const originalDelta = meanHorizontalDelta(image)

	const workspace = new FFTWorkspace(width, height)
	fft(image, workspace, 'lowPass', 0.08, 1)

	const filteredDelta = meanHorizontalDelta(image)
	expect(filteredDelta).toBeLessThan(originalDelta * 0.2)
})

test('fft low-pass with a large cutoff keeps a smooth ramp close to the original', () => {
	const width = 17
	const height = 13
	const values = new Array<number>(width * height)

	for (let y = 0, i = 0; y < height; y++) {
		const fy = y / (height - 1)

		for (let x = 0; x < width; x++, i++) {
			const fx = x / (width - 1)
			values[i] = 0.15 + 0.55 * fx + 0.2 * fy
		}
	}

	const image = makeImage(width, height, 1, values)
	const original = clone(image)

	const workspace = new FFTWorkspace(width, height)
	fft(image, workspace, 'lowPass', 0.95, 1)

	expect(meanAbsoluteDifference(image, original)).toBeLessThan(0.02)
})

test('fft high-pass with high weight suppresses background and keeps local detail', () => {
	const width = 16
	const height = 16
	const values = new Array<number>(width * height)

	for (let y = 0, i = 0; y < height; y++) {
		const fy = y / (height - 1)

		for (let x = 0; x < width; x++, i++) {
			const fx = x / (width - 1)
			values[i] = 0.25 + 0.35 * fx + 0.25 * fy
		}
	}

	values[8 * width + 8] += 0.6

	const image = makeImage(width, height, 1, values)

	const workspace = new FFTWorkspace(width, height)
	fft(image, workspace, 'highPass', 0.2, 1)

	expect(Math.abs(imageMean(image))).toBeLessThan(0.02)
	expect(image.raw[8 * width + 8]).toBeGreaterThan(0.25)
	expect(Math.abs(image.raw[4 * width + 4])).toBeLessThan(0.08)
})

test('fft handles cutoff extremes and non-power-of-two RGB data without NaN or Inf', () => {
	const width = 7
	const height = 5
	const values = new Array<number>(width * height * 3)

	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			values[i++] = 0.1 + 0.05 * x
			values[i++] = 0.2 + 0.03 * y
			values[i++] = ((x + y) & 1) * 0.4
		}
	}

	const workspace = new FFTWorkspace(width, height)
	const lowPass = fft(makeImage(width, height, 3, values), workspace, 'lowPass', 0, 1)
	const highPass = fft(makeImage(width, height, 3, values), workspace, 'highPass', 1, 1)

	expect(lowPass.metadata.width).toBe(width)
	expect(lowPass.metadata.height).toBe(height)
	expect(highPass.metadata.width).toBe(width)
	expect(highPass.metadata.height).toBe(height)

	for (let i = 0; i < lowPass.raw.length; i++) {
		expect(Number.isFinite(lowPass.raw[i])).toBe(true)
		expect(Number.isFinite(highPass.raw[i])).toBe(true)
	}
})

test('fft low-pass keeps impulse halos close to circular on rectangular images', () => {
	const width = 101
	const height = 51
	const centerX = Math.trunc(width / 2)
	const centerY = Math.trunc(height / 2)
	const image = makeImage(width, height, 1, new Float32Array(width * height))

	image.raw[centerY * width + centerX] = 1

	const workspace = new FFTWorkspace(width, height)
	fft(image, workspace, 'lowPass', 0.15, 1)

	const radiusX = halfMaximumRadius(image, centerX, centerY, 1, 0)
	const radiusY = halfMaximumRadius(image, centerX, centerY, 0, 1)

	expect(radiusX / radiusY).toBeGreaterThan(0.8)
	expect(radiusX / radiusY).toBeLessThan(1.25)
})

test('fft low-pass impulse halo decays smoothly from the core', () => {
	const width = 129
	const height = 129
	const centerX = Math.trunc(width / 2)
	const centerY = Math.trunc(height / 2)
	const centerIndex = centerY * width + centerX
	const image = makeImage(width, height, 1, new Float32Array(width * height))

	image.raw[centerIndex] = 1

	const workspace = new FFTWorkspace(width, height)
	fft(image, workspace, 'lowPass', 0.08, 1)

	const center = image.raw[centerIndex]
	const x1 = image.raw[centerIndex + 1]
	const x2 = image.raw[centerIndex + 2]
	const x4 = image.raw[centerIndex + 4]
	const x8 = image.raw[centerIndex + 8]

	expect(x1).toBeLessThan(center * 0.97)
	expect(x1).toBeGreaterThan(x2)
	expect(x2).toBeGreaterThan(x4)
	expect(x4).toBeGreaterThan(x8)
	expect(x4).toBeGreaterThan(center * 0.05)
	expect(x4).toBeGreaterThan(0)
})

test('fft low-pass keeps a visible inner halo gradient at hard cutoff and high weight', () => {
	const width = 257
	const height = 257
	const centerX = Math.trunc(width / 2)
	const centerY = Math.trunc(height / 2)
	const centerIndex = centerY * width + centerX
	const image = makeImage(width, height, 1, new Float32Array(width * height))

	image.raw[centerIndex] = 1

	const workspace = new FFTWorkspace(width, height)
	fft(image, workspace, 'lowPass', 0.015, 0.8)

	const x1 = image.raw[centerIndex + 1]
	const x2 = image.raw[centerIndex + 2]
	const x8 = image.raw[centerIndex + 8]
	const x16 = image.raw[centerIndex + 16]

	expect(x1).toBeGreaterThan(x8 * 2.3)
	expect(x2).toBeGreaterThan(x16 * 3)
	expect(x16).toBeGreaterThan(0)
})

test('arcsinhStretch applies black point normalization on monochrome data', () => {
	const image = makeImage(3, 1, 1, [0.25, 0.5, 1])

	arcsinhStretch(image, { stretchFactor: 1, blackPoint: 0.25 })

	expect(image.raw[0]).toBeCloseTo(0, 8)
	expect(image.raw[1]).toBeCloseTo(1 / 3, 7)
	expect(image.raw[2]).toBeCloseTo(1, 8)
})

test('arcsinhStretch preserves RGB ratios above the black point', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.1, 0.05])

	arcsinhStretch(image, { stretchFactor: 12 })

	expect(image.raw[0] / image.raw[1]).toBeCloseTo(2, 6)
	expect(image.raw[1] / image.raw[2]).toBeCloseTo(2, 6)
})

test('arcsinhStretch protectHighlights rescales instead of clipping saturated channels', () => {
	const input = makeImage(1, 1, 3, [0.98, 0.25, 0.25])
	const unclipped = clone(input)
	const protectedImage = clone(input)

	arcsinhStretch(unclipped, { stretchFactor: 20, protectHighlights: false })
	arcsinhStretch(protectedImage, { stretchFactor: 20, protectHighlights: true })

	expect(unclipped.raw[0]).toBe(1)
	expect(protectedImage.raw[1]).toBeLessThan(unclipped.raw[1])
	expect(protectedImage.raw[0] / protectedImage.raw[1]).toBeCloseTo(input.raw[0] / input.raw[1], 6)
})

test('arcsinhStretch uses RGB working-space weights when requested', () => {
	const equalWeights = makeImage(1, 1, 3, [0.55, 0.1, 0.1])
	const workingSpace = makeImage(1, 1, 3, [0.55, 0.1, 0.1])

	arcsinhStretch(equalWeights, { stretchFactor: 8, useRgbWorkingSpace: false })
	arcsinhStretch(workingSpace, { stretchFactor: 8, useRgbWorkingSpace: true, rgbWorkingSpace: { red: 0.8, green: 0.1, blue: 0.1 } })

	expect(workingSpace.raw[0]).toBeLessThan(equalWeights.raw[0])
	expect(workingSpace.raw[1]).toBeLessThan(equalWeights.raw[1])
})

test('stf applies the transfer function only to the selected RGB channel', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.4, 0.8])
	stf(image, 0.25, 0.2, 0.6, { channel: 'GREEN' })
	expectImageValues(image, [0.2, 0.75, 0.8], 6)
})

test('stf is a no-op with default parameters', () => {
	const image = makeImage(3, 1, 1, [0.1, 0.5, 0.9])
	const before = new Float32Array(image.raw)

	expect(stf(image)).toBe(image)
	expectImageValues(image, before, 8)
})

test('stf clips values outside the shadow and highlight range', () => {
	const image = makeImage(3, 1, 1, [0.1, 0.4, 0.9])
	stf(image, 0.5, 0.2, 0.8)
	expectImageValues(image, [0, 1 / 3, 1], 6)
})

test('bayer converts RGB pixels into a mono CFA frame', () => {
	const image = makeImage(2, 2, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
	const output = bayer(image, 'RGGB')

	expect(output).toBeDefined()
	expect(output!.header.NAXIS).toBe(2)
	expect(output!.header.NAXIS3).toBeUndefined()
	expect(output!.header.BAYERPAT).toBe('RGGB')
	expect(output!.metadata.channels).toBe(1)
	expect(output!.metadata.stride).toBe(2)
	expect(output!.metadata.bayer).toBe('RGGB')
	expectImageValues(output!, [1, 5, 8, 12], 8)
})

test('bayer returns undefined for monochrome input', () => {
	const image = makeImage(2, 2, 1, [1, 2, 3, 4])
	expect(bayer(image, 'RGGB')).toBeUndefined()
})

test('bayer and debayer preserve Float64 storage', () => {
	const color: Image = {
		header: { NAXIS: 3, NAXIS3: 3 },
		metadata: { width: 2, height: 2, channels: 3, stride: 6, pixelCount: 4, strideInBytes: 48, pixelSizeInBytes: 8, bitpix: Bitpix.DOUBLE, bayer: undefined },
		raw: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
	}

	const cfa = bayer(color, 'RGGB')

	expect(cfa).toBeDefined()
	expect(cfa!.raw instanceof Float64Array).toBe(true)

	const output = debayer(cfa!)

	expect(output).toBeDefined()
	expect(output!.raw instanceof Float64Array).toBe(true)
})

test('debayer reconstructs RGB samples from the stored CFA pattern', () => {
	const original = makeImage(3, 3, 3, [11, 12, 13, 21, 22, 23, 31, 32, 33, 41, 42, 43, 51, 52, 53, 61, 62, 63, 71, 72, 73, 81, 82, 83, 91, 92, 93])
	const cfa = bayer(original, 'RGGB')

	expect(cfa).toBeDefined()

	const output = debayer(cfa!)

	expect(output).toBeDefined()
	expect(output!.header.NAXIS).toBe(3)
	expect(output!.header.NAXIS3).toBe(3)
	expect(output!.metadata.channels).toBe(3)
	expect(output!.metadata.stride).toBe(9)
	expectImageValues(output!, [11, 32, 53, 21, 42, 53, 31, 42, 53, 41, 48.66666793823242, 53, 51, 52, 53, 61, 55.33333206176758, 53, 71, 62, 53, 81, 62, 53, 91, 72, 53], 6)
})

test('debayer returns undefined when no CFA pattern is available', () => {
	const image = makeImage(2, 2, 1, [1, 2, 3, 4])
	expect(debayer(image)).toBeUndefined()
})

test('debayer handles small 2x2 CFA images through the border path', () => {
	const image = makeImage(2, 2, 1, [1, 2, 3, 4], { BAYERPAT: 'RGGB' })
	const output = debayer(image)
	expect(output).toBeDefined()
	expectImageValues(output!, [1, 2.5, 4, 1, 2.5, 4, 1, 2.5, 4, 1, 2.5, 4], 6)
})

test('scnr reduces the selected chroma channel while preserving the others', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
	scnr(image, 'GREEN', 1, 'MAXIMUM_MASK')
	expectImageValues(image, [0.2, 0.36, 0.4], 6)
})

test('scnr neutral protection methods limit the target channel independently of amount', () => {
	const image = makeImage(1, 1, 3, [0.8, 0.2, 0.6])
	scnr(image, 'RED', 0.1, 'AVERAGE_NEUTRAL')
	expectImageValues(image, [0.4, 0.2, 0.6], 6)
})

test('scnr leaves monochrome images unchanged', () => {
	const image = makeImage(3, 1, 1, [0.2, 0.5, 0.7])
	const before = new Float32Array(image.raw)
	scnr(image)
	expectImageValues(image, before, 8)
})

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
	expectImageValues(image, [0.5, 0.7071067811865476, 1], 6)
})

test('gamma is a no-op outside the supported range', () => {
	const low = makeImage(2, 1, 1, [0.25, 1])
	const high = makeImage(2, 1, 1, [0.25, 1])

	gamma(low, 1)
	gamma(high, 3.1)

	expectImageValues(low, [0.25, 1], 8)
	expectImageValues(high, [0.25, 1], 8)
})

test('calibrate subtracts dark current and normalizes by a bias-corrected flat', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const dark = makeImage(2, 1, 1, [0.1, 0.1])
	const flat = makeImage(2, 1, 1, [0.4, 0.8])
	const bias = makeImage(2, 1, 1, [0.05, 0.05])

	calibrate(light, dark, flat, bias)

	expectImageValues(light, [0.7857142857142858, 0.22], 6)
})

test('calibrate subtracts only bias when it is the sole calibration frame', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const bias = makeImage(2, 1, 1, [0.1, 0.05])

	calibrate(light, undefined, undefined, bias)

	expectImageValues(light, [0.5, 0.35], 6)
})

test('calibrate subtracts dark frames directly when exposure times match', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const dark = makeImage(2, 1, 1, [0.1, 0.2])

	calibrate(light, dark)

	expectImageValues(light, [0.5, 0.2], 8)
})

test('calibrate applies flat normalization even without dark or bias frames', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const flat = makeImage(2, 1, 1, [0.4, 0.8])

	calibrate(light, undefined, flat)

	expectImageValues(light, [0.9, 0.3], 6)
})

test('calibrate rescales the dark background when exposure times differ', () => {
	const light = makeImage(1, 1, 1, [0.8])
	const dark = makeImage(1, 1, 1, [0.3])
	const bias = makeImage(1, 1, 1, [0.1])

	light.header.EXPTIME = 30
	dark.header.EXPTIME = 15

	calibrate(light, dark, undefined, bias)

	expect(light.raw[0]).toBeCloseTo(0.100008, 6)
})

test('calibrate leaves the image unchanged when no calibration frames are provided', () => {
	const light = makeImage(2, 1, 1, [0.2, 0.8])
	const before = new Float32Array(light.raw)

	expect(calibrate(light)).toBe(light)
	expectImageValues(light, before, 8)
})

test('calibrate propagates dimension mismatches from arithmetic steps', () => {
	const light = makeImage(2, 1, 1, [0.1, 0.2])
	const dark = makeImage(1, 1, 1, [0.1])

	expect(() => calibrate(light, dark)).toThrow('width does not match: 2 != 1')
})
