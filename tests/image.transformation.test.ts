import { expect, test } from 'bun:test'
import { Bitpix } from '../src/fits'
import { clone, FFTWorkspace, fft } from '../src/image.transformation'
import type { Image } from '../src/image.types'
import type { NumberArray } from '../src/math'

// Creates a normalized Float32 image with the provided interleaved pixel data.
function makeImage(width: number, height: number, channels: number, values: Readonly<NumberArray>): Image {
	return {
		header: { NAXIS: channels === 1 ? 2 : 3, NAXIS3: channels === 1 ? undefined : channels },
		metadata: {
			width,
			height,
			channels,
			stride: width * channels,
			pixelCount: width * height,
			strideInBytes: width * channels * 4,
			pixelSizeInBytes: 4,
			bitpix: Bitpix.FLOAT,
			bayer: undefined,
		},
		raw: new Float32Array(values),
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
