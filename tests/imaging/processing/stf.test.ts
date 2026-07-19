import { expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { stf } from '../../../src/imaging/processing/stf'
import { Bitpix } from '../../../src/io/formats/fits/fits'
import { expectImageValues, makeImage } from './util'

// Creates a normalized Float64 image for precision-sensitive STF checks.
function makeFloat64Image(values: readonly number[]): Image {
	return {
		header: { NAXIS: 2 },
		metadata: { width: values.length, height: 1, channels: 1, stride: values.length, pixelCount: values.length, strideInBytes: values.length * 8, pixelSizeInBytes: 8, bitpix: Bitpix.DOUBLE, bayer: undefined },
		raw: new Float64Array(values),
	}
}

test('stf applies the transfer function only to the selected RGB channel', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.4, 0.8])
	stf(image, 0.25, 0.2, 0.6, { channel: 'GREEN' })
	expectImageValues(image, [0.2, 0.75, 0.8], 6)
})

test('stf applies the transfer function to every RGB channel by default', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.4, 0.8])
	stf(image, 0.25, 0.2, 0.6)
	expectImageValues(image, [0, 0.75, 1], 6)
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

test('stf evaluates repeated Float64 samples with identical full-precision results', () => {
	const image = makeFloat64Image([0.123456789, 0.123456789])
	stf(image, 0.25, 0.1, 0.9)

	expect(image.raw[0]).toBeCloseTo(0.08309037524959835, 15)
	expect(image.raw[1]).toBe(image.raw[0])
})

test('stf results do not depend on the order of samples with nearby values', () => {
	const low = (20000 + 0.1) / 65535
	const high = (20000 + 0.9) / 65535
	const a = makeFloat64Image([low, high, high])
	const b = makeFloat64Image([high, low, high])

	stf(a, 0.25, 0.1, 0.9)
	stf(b, 0.25, 0.1, 0.9)

	expect(a.raw[0]).toBe(b.raw[1])
	expect(a.raw[1]).toBe(b.raw[0])
	expect(a.raw[1]).toBe(a.raw[2])
	expect(a.raw[2]).toBe(b.raw[2])
})

test('stf handles exact curve boundaries and endpoint midtones without non-finite values', () => {
	const midtoneZero = makeFloat64Image([0.25, 0.5, 0.75])
	const midtoneOne = makeFloat64Image([0.25, 0.5, 0.75])
	const equalBounds = makeFloat64Image([0.25, 0.5, 0.75])

	stf(midtoneZero, 0, 0.25, 0.75)
	stf(midtoneOne, 1, 0.25, 0.75)
	stf(equalBounds, 0.5, 0.5, 0.5)

	expect(midtoneZero.raw).toEqual(new Float64Array([0, 1, 1]))
	expect(midtoneOne.raw).toEqual(new Float64Array([0, 0, 1]))
	expect(equalBounds.raw).toEqual(new Float64Array([0, 0, 1]))
})

test('stf rejects invalid curve parameters before mutating the image', () => {
	const invalidParameters = [
		[Number.NaN, 0, 1],
		[-0.1, 0, 1],
		[0.5, -0.1, 1],
		[0.5, 0, 1.1],
		[0.5, 0.8, 0.2],
	] as const

	for (const parameters of invalidParameters) {
		const image = makeFloat64Image([0.4])
		expect(() => stf(image, ...parameters)).toThrow()
		expect(image.raw[0]).toBe(0.4)
	}
})
