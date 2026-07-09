import { describe, expect, test } from 'bun:test'
import type { AffineTransform } from '../../../src/astrometry/matching/star.matching'
import type { Image, ImageRawPrecision } from '../../../src/imaging/model/types'
import { registerImage, warpImage } from '../../../src/imaging/processing/registration'
import type { DetectedStar } from '../../../src/imaging/stars/detector'
import { Bitpix } from '../../../src/io/formats/fits/fits'

// Builds a synthetic image with floating-point samples.
function makeImage(width: number, height: number, channels: number, pixel: (x: number, y: number, channel: number) => number, precision: ImageRawPrecision = 32): Image {
	const raw = precision === 64 ? new Float64Array(width * height * channels) : new Float32Array(width * height * channels)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const base = (y * width + x) * channels
			for (let channel = 0; channel < channels; channel++) raw[base + channel] = pixel(x, y, channel)
		}
	}
	return { header: { OBJECT: 'reference' }, raw, metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * raw.BYTES_PER_ELEMENT, pixelSizeInBytes: raw.BYTES_PER_ELEMENT, bitpix: precision === 64 ? Bitpix.DOUBLE : Bitpix.FLOAT, bayer: undefined } }
}

// Moves a reference image into target coordinates for an integer translation.
function translateImage(reference: Image, tx: number, ty: number): Image {
	return makeImage(reference.metadata.width, reference.metadata.height, reference.metadata.channels, (x, y, channel) => {
		const referenceX = x + tx
		const referenceY = y + ty
		if (referenceX < 0 || referenceY < 0 || referenceX >= reference.metadata.width || referenceY >= reference.metadata.height) return 0
		return reference.raw[(referenceY * reference.metadata.width + referenceX) * reference.metadata.channels + channel]
	})
}

// Builds non-degenerate star coordinates with an optional target-space translation.
function makeStars(tx: number = 0, ty: number = 0): readonly DetectedStar[] {
	return [
		{ x: 3 + tx, y: 3 + ty, flux: 1800, snr: 16, hfd: 2.2 },
		{ x: 10 + tx, y: 4 + ty, flux: 2100, snr: 18, hfd: 2.1 },
		{ x: 5 + tx, y: 9 + ty, flux: 2200, snr: 17, hfd: 2.3 },
		{ x: 12 + tx, y: 8 + ty, flux: 2600, snr: 21, hfd: 2 },
		{ x: 7 + tx, y: 12 + ty, flux: 2400, snr: 19, hfd: 2.4 },
		{ x: 14 + tx, y: 13 + ty, flux: 2800, snr: 23, hfd: 2.2 },
	]
}

// Checks numeric buffers within a floating-point tolerance.
function expectRawClose(actual: ArrayLike<number>, expected: ArrayLike<number>, epsilon: number = 1e-6) {
	expect(actual.length).toBe(expected.length)
	for (let i = 0; i < actual.length; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(epsilon)
}

// Identity affine transform mapping output pixels back to the source grid.
const IDENTITY: AffineTransform = { m00: 1, m01: 0, tx: 0, m10: 0, m11: 1, ty: 0 }

describe('image registration', () => {
	test('warps a translated target onto the reference grid and exposes both transform directions', () => {
		const reference = makeImage(18, 18, 1, (x, y) => ((x * 3 + y * 5) % 17) / 16)
		const target = translateImage(reference, 2, -1)
		const result = registerImage({ image: reference, stars: makeStars() }, { image: target, stars: makeStars(-2, 1) }, { interpolationMode: 'nearest', acceptance: { minInliers: 3, maxRmsError: 0.5 } })

		expect(result.success).toBeTrue()
		if (!result.success) return
		expect(result.transform.summary.translationX).toBeCloseTo(2, 8)
		expect(result.transform.summary.translationY).toBeCloseTo(-1, 8)
		expect(result.transform.inverseTransform.tx).toBeCloseTo(-2, 8)
		expect(result.transform.inverseTransform.ty).toBeCloseTo(1, 8)
		expect(result.coveredPixels).toBeGreaterThan(0)
		expect(result.coveredPixels).toBeLessThan(reference.metadata.pixelCount)
		expect(result.image.header).toEqual(reference.header)
		for (let pixel = 0; pixel < result.validityMask.length; pixel++) {
			if (result.validityMask[pixel] !== 0) expect(result.image.raw[pixel]).toBeCloseTo(reference.raw[pixel], 8)
		}
	})

	test('returns a discriminated failure before matching malformed images', () => {
		const invalid = makeImage(0, 2, 1, () => 0)
		const target = makeImage(2, 2, 1, () => 1)
		const result = registerImage({ image: invalid, stars: makeStars() }, { image: target, stars: makeStars() })
		expect(result).toEqual({ success: false, reason: 'invalid-reference-image' })
	})
})

describe('image warp', () => {
	test('keeps exact samples for nearest and bicubic identity warps', () => {
		const source = makeImage(3, 2, 3, (x, y, channel) => 100 * channel + 10 * y + x)
		const reference = makeImage(3, 2, 3, () => 0)
		for (const interpolationMode of ['nearest', 'bicubic'] as const) {
			const result = warpImage(source, reference, IDENTITY, { interpolationMode })
			expectRawClose(result.image.raw, source.raw)
			expect(Array.from(result.validityMask)).toEqual(Array.from({ length: 6 }, () => 1))
		}
	})

	test('uses bilinear weights and preserves source storage by default', () => {
		const source = makeImage(2, 2, 1, (x, y) => x * 2 + y * 4, 64)
		const reference = makeImage(1, 1, 1, () => 0)
		const result = warpImage(source, reference, { ...IDENTITY, tx: 0.5, ty: 0.5 }, { interpolationMode: 'bilinear' })
		expect(result.image.raw).toBeInstanceOf(Float64Array)
		expect(result.image.metadata.bitpix).toBe(Bitpix.DOUBLE)
		expect(result.image.raw[0]).toBeCloseTo(3, 12)
	})

	test('marks pixels outside the source as invalid', () => {
		const source = makeImage(2, 1, 1, (x) => (x + 1) * 10)
		const reference = makeImage(3, 1, 1, () => 0)
		const result = warpImage(source, reference, { ...IDENTITY, tx: -1 }, { interpolationMode: 'nearest' })
		expect(Array.from(result.validityMask)).toEqual([0, 1, 1])
		expect(Array.from(result.image.raw)).toEqual([0, 10, 20])
		expect(result.coveredPixels).toBe(2)
	})
})
