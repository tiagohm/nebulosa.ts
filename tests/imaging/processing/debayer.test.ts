import { expect, describe, test } from 'bun:test'
import type { CfaPattern, Image } from '../../../src/imaging/model/types'
import { bayer, debayer } from '../../../src/imaging/processing/debayer'
import { Bitpix } from '../../../src/io/formats/fits/fits'
import { expectImageValues, makeImage } from './util'

test('bayer converts RGB pixels into a mono CFA frame', () => {
	const image = makeImage(2, 2, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
	const output = bayer(image, 'RGGB')

	expect(output).toBeDefined()
	expect(output!.header.NAXIS).toBe(2)
	expect(output!.header.NAXIS3).toBeUndefined()
	expect(output!.header.BAYERPAT).toBe('RGGB')
	expect(output!.metadata.channels).toBe(1)
	expect(output!.metadata.stride).toBe(2)
	expect(output!.metadata.strideInBytes).toBe(output!.metadata.width * output!.metadata.channels * output!.metadata.pixelSizeInBytes)
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
	expect(cfa!.metadata.strideInBytes).toBe(16)

	const output = debayer(cfa!)

	expect(output).toBeDefined()
	expect(output!.raw instanceof Float64Array).toBe(true)
	expect(output!.metadata.strideInBytes).toBe(48)
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
	expect(output!.metadata.strideInBytes).toBe(output!.metadata.width * output!.metadata.channels * output!.metadata.pixelSizeInBytes)
	expectImageValues(output!, [11, 32, 53, 21, 42, 53, 31, 42, 53, 41, 48.66666793823242, 53, 51, 52, 53, 61, 55.33333206176758, 53, 71, 62, 53, 81, 62, 53, 91, 72, 53], 6)
})

describe('bayer and debayer handle every CFA pattern and odd image dimensions', () => {
	const patterns: readonly CfaPattern[] = ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG']
	const pixel = [0.125, 0.5, 0.875]
	const values = Array.from({ length: 5 * 5 }, () => pixel).flat()
	const expected = Array.from({ length: 5 * 5 }, () => pixel).flat()
	const image = makeImage(5, 5, 3, values)

	for (const pattern of patterns) {
		test(pattern, () => {
			const cfa = bayer(image, pattern)
			const output = cfa && debayer(cfa)

			expect(cfa).toBeDefined()
			expect(output).toBeDefined()
			expectImageValues(output!, expected, 8)
		})
	}
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

test('debayer rejects CFA images that cannot contain a complete 2x2 pattern', () => {
	expect(debayer(makeImage(1, 1, 1, [1], { BAYERPAT: 'RGGB' }))).toBeUndefined()
	expect(debayer(makeImage(1, 2, 1, [1, 2], { BAYERPAT: 'RGGB' }))).toBeUndefined()
	expect(debayer(makeImage(2, 1, 1, [1, 2], { BAYERPAT: 'RGGB' }))).toBeUndefined()
})
