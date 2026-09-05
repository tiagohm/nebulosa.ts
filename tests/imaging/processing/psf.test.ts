import { expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { psf } from '../../../src/imaging/processing/psf'
import { expectImageValues, makeImage, pixelOffset } from './util'

// Direct KStars 9x9 PSF kernel used as an independent numerical reference.
const PSF_KERNEL = [
	-0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.074, -0.064, -0.074, -0.094, -0.094, -0.094, -0.094, -0.094, -0.05, 0.049, 0.117, 0.049, -0.05, -0.094, -0.094, -0.094, -0.074, 0.049, 0.365, 0.584, 0.365, 0.049, -0.074, -0.094, -0.094, -0.064, 0.117, 0.584, 0.906,
	0.584, 0.117, -0.064, -0.094, -0.094, -0.074, 0.049, 0.365, 0.584, 0.365, 0.049, -0.074, -0.094, -0.094, -0.094, -0.05, 0.049, 0.117, 0.049, -0.05, -0.094, -0.094, -0.094, -0.094, -0.094, -0.074, -0.064, -0.074, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094, -0.094,
] as const

// Applies the literal PSF kernel out of place, subtracting the independently accumulated local mean.
function referencePsf(image: Image) {
	const { width, height, channels, stride } = image.metadata
	const source = image.raw
	const output = source.slice()

	for (let y = 4; y < height - 4; y++) {
		for (let x = 4; x < width - 4; x++) {
			for (let channel = 0; channel < channels; channel++) {
				let sum = 0
				for (let dy = -4; dy <= 4; dy++) {
					const row = (y + dy) * stride + (x - 4) * channels + channel
					for (let dx = 0; dx < 9; dx++) sum += source[row + dx * channels]
				}

				const mean = sum / 81
				let value = 0
				let k = 0
				for (let dy = -4; dy <= 4; dy++) {
					const row = (y + dy) * stride + (x - 4) * channels + channel
					for (let dx = 0; dx < 9; dx++, k++) value += PSF_KERNEL[k] * (source[row + dx * channels] - mean)
				}
				output[y * stride + x * channels + channel] = value
			}
		}
	}

	return output
}

// Creates deterministic mono or RGB input in the requested floating-point precision.
function randomImage(width: number, height: number, channels: 1 | 3, precision: 32 | 64) {
	const length = width * height * channels
	const raw = precision === 64 ? new Float64Array(length) : new Float32Array(length)
	let state = 0x12345678
	for (let i = 0; i < length; i++) raw[i] = ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000) * 0.9
	const image = makeImage(width, height, channels, raw)
	return precision === 64 ? ({ ...image, metadata: { ...image.metadata, pixelSizeInBytes: 8, strideInBytes: image.metadata.stride * 8 }, raw } satisfies Image) : image
}

test('psf removes a flat interior while leaving the untouched border unchanged', () => {
	const image = makeImage(11, 11, 1, new Float32Array(121).fill(1))

	expect(psf(image)).toBe(image)

	expect(image.raw[pixelOffset(image, 5, 5)]).toBeCloseTo(0, 8)
	expect(image.raw[pixelOffset(image, 5, 4)]).toBeCloseTo(0, 8)
	expect(image.raw[pixelOffset(image, 0, 0)]).toBeCloseTo(1, 8)
	expect(image.raw[pixelOffset(image, 3, 5)]).toBeCloseTo(1, 8)
})

test('psf matches the literal KStars kernel for mono and RGB in both precisions', () => {
	for (const channels of [1, 3] as const) {
		for (const precision of [32, 64] as const) {
			const image = randomImage(13, 12, channels, precision)
			const expected = referencePsf(image)

			psf(image)

			const digits = precision === 64 ? 13 : 6
			for (let i = 0; i < expected.length; i++) expect(image.raw[i]).toBeCloseTo(expected[i], digits)
		}
	}
})

test('psf accepts RGB intensity data with residual Bayer metadata', () => {
	const image = randomImage(9, 9, 3, 32)
	const expected = referencePsf(image)
	const rgbWithResidualBayer: Image = { ...image, metadata: { ...image.metadata, bayer: 'RGGB' } }

	expect(psf(rgbWithResidualBayer)).toBe(rgbWithResidualBayer)
	for (let i = 0; i < expected.length; i++) expect(rgbWithResidualBayer.raw[i]).toBeCloseTo(expected[i], 6)
})

test('psf treats an empty mono Bayer keyword as absent', () => {
	const image = randomImage(9, 9, 1, 32)
	const expected = referencePsf(image)
	const monoWithEmptyBayer: Image = { ...image, metadata: { ...image.metadata, bayer: '' as never } }

	expect(psf(monoWithEmptyBayer)).toBe(monoWithEmptyBayer)
	for (let i = 0; i < expected.length; i++) expect(monoWithEmptyBayer.raw[i]).toBeCloseTo(expected[i], 6)
})

test('psf preserves double-precision coefficients for an impulse response', () => {
	const image = randomImage(9, 9, 1, 64)
	image.raw.fill(0)
	image.raw[40] = 1

	psf(image)

	expect(image.raw[40]).toBeCloseTo(0.9013333333333333, 14)
})

test('psf leaves valid images smaller than its support unchanged without changing precision', () => {
	for (const precision of [32, 64] as const) {
		const image = randomImage(8, 8, 1, precision)
		const before = image.raw.slice()
		expect(psf(image)).toBe(image)
		expectImageValues(image, before, precision === 64 ? 14 : 8)
		expect(image.raw).toBeInstanceOf(precision === 64 ? Float64Array : Float32Array)
	}
})

test('psf rejects CFA data and malformed layouts before mutation', () => {
	const valid = randomImage(9, 9, 3, 32)
	const malformed: Image[] = [
		{ ...valid, metadata: { ...valid.metadata, width: 0 } },
		{ ...valid, metadata: { ...valid.metadata, height: 0 } },
		makeImage(9, 9, 2, new Float32Array(9 * 9 * 2)),
		{ ...valid, metadata: { ...valid.metadata, pixelCount: 80 } },
		{ ...valid, metadata: { ...valid.metadata, stride: 9 } },
		makeImage(9, 9, 3, new Float32Array(9 * 9 * 3 - 1)),
		makeImage(9, 9, 1, new Float32Array(81), { BAYERPAT: 'RGGB' }),
	]

	for (const image of malformed) {
		const before = image.raw.slice()
		expect(() => psf(image)).toThrow()
		expect(image.raw).toEqual(before)
	}
})
