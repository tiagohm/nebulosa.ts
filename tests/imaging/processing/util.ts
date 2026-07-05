import { expect } from 'bun:test'
import { medianOf } from '../../../src/core/util'
import type { Image } from '../../../src/imaging/model/types'
import { Bitpix, type FitsHeader } from '../../../src/io/formats/fits/fits'
import { cfaPatternKeyword } from '../../../src/io/formats/fits/util'
import type { NumberArray } from '../../../src/math/numerical/math'

// Creates a normalized Float32 image with the provided interleaved pixel data.
export function makeImage(width: number, height: number, channels: number, values: Readonly<NumberArray>, header?: FitsHeader): Image {
	return {
		header: { NAXIS: channels === 1 ? 2 : 3, NAXIS3: channels === 1 ? undefined : channels, ...header },
		metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * channels * 4, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: header && cfaPatternKeyword(header) },
		raw: values instanceof Float32Array ? values : new Float32Array(values),
	}
}

// Computes the mean absolute horizontal neighbor delta for one-channel images.
export function meanHorizontalDelta(image: Image) {
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
export function meanAbsoluteDifference(a: Image, b: Image) {
	let sum = 0
	for (let i = 0; i < a.raw.length; i++) sum += Math.abs(a.raw[i] - b.raw[i])
	return sum / a.raw.length
}

// Computes the arithmetic mean of an image plane.
export function imageMean(image: Image) {
	let sum = 0
	for (let i = 0; i < image.raw.length; i++) sum += image.raw[i]
	return sum / image.raw.length
}

// Computes the linear raw offset of a pixel channel.
export function pixelOffset(image: Image, x: number, y: number, channel: number = 0) {
	return y * image.metadata.stride + x * image.metadata.channels + channel
}

// Asserts that the raw pixel buffer matches the expected values within tolerance.
export function expectImageValues(image: Image, expected: Readonly<NumberArray>, precision: number = 6) {
	expect(image.raw.length).toBe(expected.length)

	for (let i = 0; i < expected.length; i++) {
		expect(image.raw[i]).toBeCloseTo(expected[i], precision)
	}
}

// Returns the first radius where the impulse profile falls below half peak.
export function halfMaximumRadius(image: Image, centerX: number, centerY: number, stepX: number, stepY: number) {
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

// Computes the exact monochrome square-window median with truncated borders.
export function exactMedianFilter(width: number, height: number, values: Readonly<NumberArray>, radius: number) {
	const output = new Float32Array(width * height)
	const samples = new Float64Array((2 * radius + 1) ** 2)

	for (let y = 0, i = 0; y < height; y++) {
		const y0 = Math.max(0, y - radius)
		const y1 = Math.min(height - 1, y + radius)

		for (let x = 0; x < width; x++, i++) {
			const x0 = Math.max(0, x - radius)
			const x1 = Math.min(width - 1, x + radius)
			let count = 0

			for (let yy = y0; yy <= y1; yy++) {
				let k = yy * width + x0
				const end = yy * width + x1 + 1

				for (; k < end; k++) {
					samples[count++] = values[k]
				}
			}

			output[i] = medianOf(samples.subarray(0, count).sort())
		}
	}

	return output
}
