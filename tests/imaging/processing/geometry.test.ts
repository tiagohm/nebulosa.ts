import { expect, test } from 'bun:test'
import { tanUnproject } from '../../../src/astrometry/wcs/fits.wcs'
import { type CfaPattern, type Image, type ImageChannel, shiftCfaPattern } from '../../../src/imaging/model/types'
import { grayscale, horizontalFlip, invert, verticalFlip } from '../../../src/imaging/processing/geometry'
import { expectImageValues, makeImage } from './util'

// All supported repeating 2x2 CFA layouts.
const CFA_PATTERNS: readonly CfaPattern[] = ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG']

test('horizontalFlip mirrors mono and RGB scanlines without mixing channels', () => {
	const mono = makeImage(4, 2, 1, [1, 2, 3, 4, 5, 6, 7, 8])
	const rgb = makeImage(3, 2, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])

	expect(horizontalFlip(mono)).toBe(mono)
	expect(horizontalFlip(rgb)).toBe(rgb)
	expectImageValues(mono, [4, 3, 2, 1, 8, 7, 6, 5], 8)
	expectImageValues(rgb, [7, 8, 9, 4, 5, 6, 1, 2, 3, 16, 17, 18, 13, 14, 15, 10, 11, 12], 8)
})

test('horizontalFlip is a pixel no-op for single-column images', () => {
	const image = makeImage(1, 3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	const before = new Float32Array(image.raw)

	expect(horizontalFlip(image)).toBe(image)
	expect(image.raw).toEqual(before)
})

test('verticalFlip swaps mono and RGB rows without mixing channels', () => {
	const mono = makeImage(2, 3, 1, [1, 2, 3, 4, 5, 6])
	const rgb = makeImage(2, 3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])

	expect(verticalFlip(mono)).toBe(mono)
	expect(verticalFlip(rgb)).toBe(rgb)
	expectImageValues(mono, [5, 6, 3, 4, 1, 2], 8)
	expectImageValues(rgb, [13, 14, 15, 16, 17, 18, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6], 8)
})

test('verticalFlip is a pixel no-op for single-row images', () => {
	const image = makeImage(3, 1, 1, [1, 2, 3])
	const before = new Float32Array(image.raw)

	expect(verticalFlip(image)).toBe(image)
	expect(image.raw).toEqual(before)
})

test('flips keep every raw CFA phase aligned for odd and even dimensions', () => {
	for (const pattern of CFA_PATTERNS) {
		for (const width of [3, 4]) {
			const image = makeImage(width, 2, 1, new Float32Array(width * 2), { BAYERPAT: pattern })
			horizontalFlip(image)
			const expected = shiftCfaPattern(pattern, width - 1, 0)
			expect(image.metadata.bayer).toBe(expected)
			expect(image.header.BAYERPAT).toBe(expected)
		}
		for (const height of [3, 4]) {
			const image = makeImage(2, height, 1, new Float32Array(height * 2), { BAYERPAT: pattern })
			verticalFlip(image)
			const expected = shiftCfaPattern(pattern, 0, height - 1)
			expect(image.metadata.bayer).toBe(expected)
			expect(image.header.BAYERPAT).toBe(expected)
		}
	}
})

test('flips preserve celestial coordinates at mirrored FITS pixel positions', () => {
	const header = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 2, CRPIX2: 2, CRVAL1: 10, CRVAL2: 20, CD1_1: -0.01, CD1_2: 0.001, CD2_1: 0.002, CD2_2: 0.01 }
	const horizontal = makeImage(4, 3, 1, new Float32Array(12), header)
	const vertical = makeImage(4, 3, 1, new Float32Array(12), header)
	const x = 1.25
	const y = 2.4
	const before = tanUnproject(header, x, y)!

	horizontalFlip(horizontal)
	verticalFlip(vertical)
	const afterHorizontal = tanUnproject(horizontal.header, 5 - x, y)!
	const afterVertical = tanUnproject(vertical.header, x, 4 - y)!

	expect(afterHorizontal[0]).toBeCloseTo(before[0], 12)
	expect(afterHorizontal[1]).toBeCloseTo(before[1], 12)
	expect(afterVertical[0]).toBeCloseTo(before[0], 12)
	expect(afterVertical[1]).toBeCloseTo(before[1], 12)
})

test('invert complements normalized mono and RGB samples without changing precision', () => {
	const mono = makeImage(3, 1, 1, [0, 0.25, 1])
	const base = makeImage(1, 1, 3, [0.1, 0.4, 0.9])
	const rgb: Image = { ...base, raw: new Float64Array([0.1, 0.4, 0.9]) }

	expect(invert(mono)).toBe(mono)
	expect(invert(rgb)).toBe(rgb)
	expectImageValues(mono, [1, 0.75, 0], 8)
	expectImageValues(rgb, [0.9, 0.6, 0.1], 14)
	expect(rgb.raw).toBeInstanceOf(Float64Array)
})

test('grayscale converts RGB pixels with built-in and custom normalized weights', () => {
	const bt709 = grayscale(makeImage(2, 1, 3, [0.2, 0.4, 0.8, 0.1, 0.3, 0.5]))
	const custom = grayscale(makeImage(2, 1, 3, [0.2, 0.4, 0.8, 0.1, 0.3, 0.5]), { red: 0.5, green: 0.25, blue: 0.25 })

	expectImageValues(bt709, [0.38634, 0.27192], 6)
	expectImageValues(custom, [0.4, 0.25], 7)
})

test('grayscale extracts every RGB channel exactly', () => {
	const values = [0.2, 0.4, 0.8, 0.1, 0.3, 0.5]
	const scenarios: readonly [ImageChannel, readonly number[]][] = [
		['RED', [0.2, 0.1]],
		['GREEN', [0.4, 0.3]],
		['BLUE', [0.8, 0.5]],
	]
	for (const [channel, expected] of scenarios) expectImageValues(grayscale(makeImage(2, 1, 3, values), channel), expected, 7)
})

test('grayscale returns the original validated image when already monochrome or CFA', () => {
	const mono = makeImage(2, 1, 1, [0.2, 0.4])
	const cfa = makeImage(2, 2, 1, [0.2, 0.4, 0.6, 0.8], { BAYERPAT: 'RGGB' })
	expect(grayscale(mono)).toBe(mono)
	expect(grayscale(cfa)).toBe(cfa)
})

test('grayscale rebuilds mono metadata and removes third-axis and CFA keywords', () => {
	const base = makeImage(2, 1, 3, [0.2, 0.4, 0.8, 0.1, 0.3, 0.5], {
		BAYERPAT: 'RGGB',
		WCSAXES: 3,
		CTYPE3: 'RGB',
		CRPIX3: 1,
		CD1_3: 0,
		PC3_1: 0,
		PV3_0: 1,
	})
	const image: Image = { ...base, raw: new Float64Array([0.2, 0.4, 0.8, 0.1, 0.3, 0.5]) }
	const output = grayscale(image, 'RED')

	expect(output).not.toBe(image)
	expect(output.header).not.toBe(image.header)
	expect(output.header).toMatchObject({ NAXIS: 2, WCSAXES: 2 })
	expect(output.header.NAXIS3).toBeUndefined()
	expect(output.header.BAYERPAT).toBeUndefined()
	expect(output.header.CTYPE3).toBeUndefined()
	expect(output.header.CRPIX3).toBeUndefined()
	expect(output.header.CD1_3).toBeUndefined()
	expect(output.header.PC3_1).toBeUndefined()
	expect(output.header.PV3_0).toBeUndefined()
	expect(output.metadata).toMatchObject({ channels: 1, stride: 2, strideInBytes: 8, bayer: undefined })
	expect(output.raw).toBeInstanceOf(Float64Array)
	expectImageValues(output, [0.2, 0.1], 14)
})

test('grayscale rejects invalid runtime channels and weights before allocating output', () => {
	const invalid = ['CYAN', null, { red: Number.NaN, green: 0, blue: 1 }, { red: -0.1, green: 0.5, blue: 0.6 }, { red: 0.2, green: 0.3, blue: 0.4 }] as const
	for (const channel of invalid) {
		const image = makeImage(1, 1, 3, [0.2, 0.4, 0.8])
		const before = new Float32Array(image.raw)
		expect(() => grayscale(image, channel as never)).toThrow()
		expect(image.raw).toEqual(before)
	}
})

test('geometry operations reject malformed dense layouts before mutation', () => {
	const valid = makeImage(1, 1, 3, [0.2, 0.4, 0.8])
	const badWidth: Image = { ...valid, metadata: { ...valid.metadata, width: 0 } }
	const badHeight: Image = { ...valid, metadata: { ...valid.metadata, height: 0 } }
	const badChannels = makeImage(1, 1, 2, [0.2, 0.4])
	const badPixelCount: Image = { ...valid, metadata: { ...valid.metadata, pixelCount: 2 } }
	const badStride: Image = { ...valid, metadata: { ...valid.metadata, stride: 4 } }
	const short = makeImage(2, 1, 3, [0.2, 0.4, 0.8, 0.1, 0.3])
	const long = makeImage(1, 1, 3, [0.2, 0.4, 0.8, 0.1])
	const malformed = [badWidth, badHeight, badChannels, badPixelCount, badStride, short, long]
	const operations = [horizontalFlip, verticalFlip, invert, grayscale] as const

	for (const operation of operations) {
		for (const image of malformed) {
			const before = new Float32Array(image.raw)
			expect(() => operation(image)).toThrow()
			expect(image.raw).toEqual(before)
		}
	}
})
