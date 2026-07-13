import { expect, test } from 'bun:test'
import { STANDARD_DEVIATION_SCALE } from '../../../src/core/util'
import type { Image, ImageRawType } from '../../../src/imaging/model/types'
import { type MultiscaleLinearTransformOptions, multiscaleLinearTransform } from '../../../src/imaging/processing/mlt'
import { Bitpix } from '../../../src/io/formats/fits/fits'
import type { NumberArray } from '../../../src/math/numerical/math'
import { makeImage, pixelOffset } from './util'

// B3-spline weights used only by the independent direct 2D test reference.
const REFERENCE_B3_SPLINE = new Int8Array([1, 4, 6, 4, 1])

// Builds a test image whose metadata and raw storage agree with the selected precision.
function makeTypedImage(width: number, height: number, channels: number, values: Readonly<NumberArray>, precision: 32 | 64): Image {
	const base = makeImage(width, height, channels, new Float32Array(width * height * channels))
	const raw = precision === 64 ? new Float64Array(values) : new Float32Array(values)
	const pixelSizeInBytes = precision / 8

	return {
		...base,
		metadata: { ...base.metadata, strideInBytes: base.metadata.stride * pixelSizeInBytes, pixelSizeInBytes, bitpix: precision === 64 ? Bitpix.DOUBLE : Bitpix.FLOAT },
		raw,
	}
}

// Applies one dilated B3-spline layer as a direct normalized 2D convolution.
function directB3Spline(source: ImageRawType, image: Image, step: number): ImageRawType {
	const { width, height, channels, stride } = image.metadata
	const output = source instanceof Float64Array ? new Float64Array(source.length) : new Float32Array(source.length)
	const radius = REFERENCE_B3_SPLINE.length >>> 1

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (let channel = 0; channel < channels; channel++) {
				let sum = 0
				let divisor = 0

				for (let tapY = 0; tapY < REFERENCE_B3_SPLINE.length; tapY++) {
					const sampleY = y + (tapY - radius) * step
					if (sampleY < 0 || sampleY >= height) continue

					for (let tapX = 0; tapX < REFERENCE_B3_SPLINE.length; tapX++) {
						const sampleX = x + (tapX - radius) * step
						if (sampleX < 0 || sampleX >= width) continue

						const weight = REFERENCE_B3_SPLINE[tapY] * REFERENCE_B3_SPLINE[tapX]
						sum += weight * source[sampleY * stride + sampleX * channels + channel]
						divisor += weight
					}
				}

				output[y * stride + x * channels + channel] = sum / divisor
			}
		}
	}

	return output
}

// Returns the median of an ascending-sorted non-empty test array.
function sortedMedian(values: number[]) {
	values.sort((a, b) => a - b)
	const middle = values.length >>> 1
	return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) * 0.5
}

// Estimates per-channel absolute-coefficient scales with the production contract's RMS fallback.
function referenceDetailScales(current: ImageRawType, filtered: ImageRawType, channels: number) {
	const pixelCount = current.length / channels
	const scales = new Float64Array(channels)

	for (let channel = 0; channel < channels; channel++) {
		const samples = new Array<number>(pixelCount)
		let sumSquares = 0

		for (let i = channel, sample = 0; i < current.length; i += channels, sample++) {
			const value = current[i] - filtered[i]
			samples[sample] = Math.abs(value)
			sumSquares += value * value
		}

		let scale = STANDARD_DEVIATION_SCALE * sortedMedian(samples)
		if (!(scale > 0)) scale = Math.sqrt(sumSquares / pixelCount)
		scales[channel] = scale
	}

	return scales
}

// Executes a complete MLT using the direct 2D layer reference and independent option resolution.
function referenceMlt(image: Image, options: Partial<MultiscaleLinearTransformOptions> = {}): ImageRawType {
	const configuredLayers = options.layers
	const requestedLayers = configuredLayers !== undefined && Number.isFinite(configuredLayers) ? Math.max(0, Math.trunc(configuredLayers)) : 3
	const maxDimension = Math.max(image.metadata.width, image.metadata.height)
	const layers = Math.min(requestedLayers, maxDimension > 1 ? Math.ceil(Math.log2(maxDimension)) : 0)
	const configuredResidualGain = options.residualGain
	const residualGain = configuredResidualGain !== undefined && Number.isFinite(configuredResidualGain) ? configuredResidualGain : 1
	const reconstructed = image.raw instanceof Float64Array ? new Float64Array(image.raw.length) : new Float32Array(image.raw.length)
	let current: ImageRawType = image.raw.slice()
	if (layers === 0) return current

	for (let layer = 0; layer < layers; layer++) {
		const filtered = directB3Spline(current, image, 2 ** layer)
		const configured = options.detailLayers?.[layer]
		const configuredThreshold = configured?.threshold
		const threshold = configuredThreshold !== undefined && Number.isFinite(configuredThreshold) ? Math.max(0, configuredThreshold) : 0
		const configuredAmount = configured?.amount
		const amount = configuredAmount !== undefined && Number.isFinite(configuredAmount) ? Math.min(1, Math.max(0, configuredAmount)) : 1
		const configuredBias = configured?.bias
		const bias = configuredBias !== undefined && Number.isFinite(configuredBias) ? configuredBias : 0
		const scales = threshold > 0 && amount > 0 ? referenceDetailScales(current, filtered, image.metadata.channels) : undefined

		for (let i = 0; i < reconstructed.length; i++) {
			let value = current[i] - filtered[i]

			if (scales !== undefined && Math.abs(value) <= threshold * scales[i % image.metadata.channels]) {
				value *= 1 - amount
			}

			reconstructed[i] += value * (1 + bias)
		}

		current = filtered
	}

	if (residualGain !== 0) {
		for (let i = 0; i < reconstructed.length; i++) reconstructed[i] += current[i] * residualGain
	}

	return reconstructed
}

// Produces deterministic structured samples spanning negative values and values above one.
function structuredValues(length: number) {
	const values = new Float64Array(length)
	let state = 0x12345678

	for (let i = 0; i < length; i++) {
		state = (1664525 * state + 1013904223) >>> 0
		values[i] = (state / 0x100000000) * 1.8 - 0.4 + (i % 7) * 0.015
	}

	return values
}

// Asserts an absolute per-sample tolerance without decimal-place rounding semantics.
function expectRawClose(actual: ImageRawType, expected: Readonly<NumberArray>, tolerance: number) {
	expect(actual.length).toBe(expected.length)

	for (let i = 0; i < actual.length; i++) {
		expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance)
	}
}

test('multiscaleLinearTransform reconstructs neutral mono and RGB images in both precisions', () => {
	for (const precision of [32, 64] as const) {
		for (const channels of [1, 3] as const) {
			for (const layers of [1, 3, 6]) {
				const values = structuredValues(9 * 7 * channels)
				const image = makeTypedImage(9, 7, channels, values, precision)
				const before = image.raw.slice()

				expect(multiscaleLinearTransform(image, { layers })).toBe(image)
				expect(image.raw.constructor).toBe(before.constructor)
				expectRawClose(image.raw, before, precision === 64 ? 1e-12 : 1e-6)
			}
		}
	}
})

test('multiscaleLinearTransform with zero layers returns the same untouched image', () => {
	const image = makeTypedImage(4, 3, 1, structuredValues(12), 32)
	const before = image.raw.slice()

	expect(multiscaleLinearTransform(image, { layers: 0, residualGain: 0 })).toBe(image)
	expect(image.raw).toEqual(before)
})

test('multiscaleLinearTransform suppresses detail and residual layers independently', () => {
	const values = new Float64Array(49)
	values[24] = 1
	const detailSuppressed = makeTypedImage(7, 7, 1, values, 64)
	const residualSuppressed = makeTypedImage(7, 7, 1, values, 64)
	const smooth = directB3Spline(detailSuppressed.raw, detailSuppressed, 1)
	const detailOnly = new Float64Array(values.length)

	for (let i = 0; i < values.length; i++) detailOnly[i] = values[i] - smooth[i]

	multiscaleLinearTransform(detailSuppressed, { layers: 1, detailLayers: [{ bias: -1 }] })
	multiscaleLinearTransform(residualSuppressed, { layers: 1, residualGain: 0 })

	expectRawClose(detailSuppressed.raw, smooth, 1e-12)
	expectRawClose(residualSuppressed.raw, detailOnly, 1e-12)
})

test('multiscaleLinearTransform detail gain can exceed the normalized image range', () => {
	const values = new Float64Array(49)
	values[24] = 1
	const image = makeTypedImage(7, 7, 1, values, 64)

	multiscaleLinearTransform(image, { layers: 1, detailLayers: [{ bias: 1 }] })

	expect(Math.max(...image.raw)).toBeGreaterThan(1)
	expect(Math.min(...image.raw)).toBeLessThan(0)
})

test('multiscaleLinearTransform denoise reduces weak coefficients and preserves strong ones', () => {
	const values = new Float64Array(81)
	values[2 * 9 + 2] = 0.05
	values[6 * 9 + 6] = 1
	const image = makeTypedImage(9, 9, 1, values, 64)
	const expected = referenceMlt(image, { layers: 1, detailLayers: [{ threshold: 30, amount: 1 }] })

	multiscaleLinearTransform(image, { layers: 1, detailLayers: [{ threshold: 30, amount: 1 }] })

	expectRawClose(image.raw, expected, 1e-12)
	expect(image.raw[2 * 9 + 2]).toBeLessThan(0.025)
	expect(image.raw[6 * 9 + 6]).toBeCloseTo(1, 12)
})

test('multiscaleLinearTransform preserves constant borders and interleaved channels', () => {
	const values = new Float64Array(5 * 4 * 3)
	for (let i = 0; i < values.length; i++) values[i] = [0.2, 0.5, 0.8][i % 3]
	const image = makeTypedImage(5, 4, 3, values, 64)

	multiscaleLinearTransform(image, { layers: 6 })

	expectRawClose(image.raw, values, 1e-12)
})

test('multiscaleLinearTransform keeps degenerate and undersized images finite', () => {
	for (const [width, height] of [
		[1, 1],
		[1, 7],
		[8, 1],
		[2, 2],
	] as const) {
		const values = structuredValues(width * height * 3)
		const image = makeTypedImage(width, height, 3, values, 64)
		const before = image.raw.slice()

		multiscaleLinearTransform(image, { layers: 20, detailLayers: [{ bias: 0.5 }], residualGain: width === 1 && height === 1 ? 0 : 1.25 })

		for (let i = 0; i < image.raw.length; i++) expect(Number.isFinite(image.raw[i])).toBe(true)
		if (width === 1 && height === 1) expect(image.raw).toEqual(before)
	}
})

test('multiscaleLinearTransform resolves invalid and out-of-range options like MMT', () => {
	const scenarios: readonly Partial<MultiscaleLinearTransformOptions>[] = [
		{ layers: Number.NaN, residualGain: Number.POSITIVE_INFINITY, detailLayers: [{ threshold: Number.NaN, amount: Number.NEGATIVE_INFINITY, bias: Number.NaN }] },
		{
			layers: 2.9,
			residualGain: -0.5,
			detailLayers: [
				{ threshold: -2, amount: 4, bias: -1.5 },
				{ threshold: 0.8, amount: -1, bias: 0.75 },
			],
		},
		{ layers: -4, residualGain: 8, detailLayers: [{ threshold: 2, amount: 1, bias: 3 }] },
	]

	for (const options of scenarios) {
		const image = makeTypedImage(6, 5, 3, structuredValues(90), 64)
		const expected = referenceMlt(image, options)
		multiscaleLinearTransform(image, options)
		expectRawClose(image.raw, expected, 1e-12)
	}
})

test('multiscaleLinearTransform matches a naive MLT for varied layer controls', () => {
	const options: Partial<MultiscaleLinearTransformOptions> = {
		layers: 4,
		detailLayers: [{ threshold: 0.7, amount: 0.35, bias: 0.5 }, { threshold: 1.25, amount: 1, bias: -0.25 }, { bias: -1 }, { threshold: 0.4, amount: 0.6, bias: -1.2 }],
		residualGain: 0.65,
	}

	for (const precision of [32, 64] as const) {
		const image = makeTypedImage(10, 7, 3, structuredValues(210), precision)
		const expected = referenceMlt(image, options)
		multiscaleLinearTransform(image, options)
		expectRawClose(image.raw, expected, precision === 64 ? 1e-12 : 2e-6)
	}
})
