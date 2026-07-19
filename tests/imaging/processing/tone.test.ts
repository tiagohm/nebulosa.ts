import { expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { brightness, contrast, gamma, linear, saturation } from '../../../src/imaging/processing/tone'
import { expectImageValues, makeImage } from './util'

test('brightness scales and clips signed or out-of-range samples', () => {
	const image = makeImage(3, 1, 1, [-0.2, 0.5, 1.2])

	expect(brightness(image, 2)).toBe(image)
	expectImageValues(image, [0, 1, 1], 8)
})

test('brightness handles identity and zero factors without changing object identity', () => {
	const identity = makeImage(2, 1, 1, [0.2, 0.8])
	const black = makeImage(2, 1, 1, [0.2, 0.8])

	expect(brightness(identity, 1)).toBe(identity)
	expect(brightness(black, 0)).toBe(black)
	expectImageValues(identity, [0.2, 0.8], 7)
	expectImageValues(black, [0, 0], 8)
})

test('brightness rejects negative and non-finite factors before mutation', () => {
	for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const image = makeImage(2, 1, 1, [0.2, 0.8])
		const before = new Float32Array(image.raw)

		expect(() => brightness(image, value)).toThrow()
		expect(image.raw).toEqual(before)
	}
})

test('saturation processes multiple interleaved RGB pixels independently', () => {
	const image = makeImage(2, 1, 3, [0.9, 0.2, 0.1, 0.1, 0.5, 0.8])

	saturation(image, 0)

	expectImageValues(image, [0.34154, 0.34154, 0.34154, 0.43663, 0.43663, 0.43663], 6)
})

test('saturation accepts normalized custom luminance weights', () => {
	const image = makeImage(1, 1, 3, [0.8, 0.2, 0.1])

	saturation(image, 0, { red: 1, green: 0, blue: 0 })

	expectImageValues(image, [0.8, 0.8, 0.8], 7)
})

test('saturation is a no-op for monochrome data and unity gain', () => {
	const mono = makeImage(2, 1, 1, [0.2, 0.8])
	const color = makeImage(1, 1, 3, [0.7, 0.2, 0.1])
	const beforeColor = new Float32Array(color.raw)

	expect(saturation(mono, 2)).toBe(mono)
	expect(saturation(color, 1)).toBe(color)
	expectImageValues(mono, [0.2, 0.8], 7)
	expect(color.raw).toEqual(beforeColor)
})

test('saturation clips extrapolated channels to the normalized range', () => {
	const image = makeImage(1, 1, 3, [0.1, 0.5, 0.5])

	saturation(image, 2)

	for (const value of image.raw) {
		expect(value).toBeGreaterThanOrEqual(0)
		expect(value).toBeLessThanOrEqual(1)
	}
})

test('saturation rejects invalid gains and luminance weights atomically', () => {
	const invalidWeights = [
		{ red: Number.NaN, green: 0, blue: 1 },
		{ red: -0.1, green: 0.5, blue: 0.6 },
		{ red: 0.2, green: 0.3, blue: 0.4 },
	]
	for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const image = makeImage(1, 1, 3, [0.2, 0.3, 0.4])
		const before = new Float32Array(image.raw)
		expect(() => saturation(image, value)).toThrow()
		expect(image.raw).toEqual(before)
	}
	for (const weights of invalidWeights) {
		const image = makeImage(1, 1, 3, [0.2, 0.3, 0.4])
		const before = new Float32Array(image.raw)
		expect(() => saturation(image, 2, weights)).toThrow()
		expect(image.raw).toEqual(before)
	}
})

test('saturation rejects malformed interleaved RGB layouts before mutation', () => {
	const short = makeImage(2, 1, 3, [0.2, 0.3, 0.4, 0.5])
	const badPixelCount: Image = { ...makeImage(1, 1, 3, [0.2, 0.3, 0.4]), metadata: { ...makeImage(1, 1, 3, [0.2, 0.3, 0.4]).metadata, pixelCount: 2 } }
	const badChannels = makeImage(1, 1, 2, [0.2, 0.3])
	const badCfaChannels = makeImage(1, 1, 3, [0.2, 0.3, 0.4], { BAYERPAT: 'RGGB' })

	expect(() => saturation(short, 2)).toThrow('image raw length does not match metadata: 4 != 6')
	expect(() => saturation(badPixelCount, 2)).toThrow('image pixelCount does not match geometry: 2 != 1')
	expect(() => saturation(badChannels, 2)).toThrow('image channels must be 1 or 3: 2')
	expect(() => saturation(badCfaChannels, 2)).toThrow('image CFA data must have one channel: 3')
})

test('linear applies finite slope and intercept with clipping', () => {
	const image = makeImage(4, 1, 1, [-0.5, 0, 0.5, 1.5])

	linear(image, 2, -0.25)

	expectImageValues(image, [0, 0, 0.75, 1], 8)
})

test('linear handles identity and constant transforms', () => {
	const identity = makeImage(2, 1, 1, [0.2, 0.8])
	const constant = makeImage(2, 1, 1, [0.2, 0.8])

	expect(linear(identity, 1, 0)).toBe(identity)
	expect(linear(constant, 0, 0.25)).toBe(constant)
	expectImageValues(identity, [0.2, 0.8], 7)
	expectImageValues(constant, [0.25, 0.25], 8)
})

test('linear rejects non-finite parameters before mutation', () => {
	for (const [slope, intercept] of [
		[Number.NaN, 0],
		[1, Number.POSITIVE_INFINITY],
	] as const) {
		const image = makeImage(2, 1, 1, [0.2, 0.8])
		const before = new Float32Array(image.raw)
		expect(() => linear(image, slope, intercept)).toThrow('value must be finite')
		expect(image.raw).toEqual(before)
	}
})

test('contrast remaps values around mid-gray and optimizes zero contrast', () => {
	const scaled = makeImage(3, 1, 1, [0, 0.5, 1])
	const flat = makeImage(3, 1, 1, [0.1, 0.5, 0.9])

	contrast(scaled, 0.5)
	contrast(flat, 0)

	expectImageValues(scaled, [0.25, 0.5, 0.75], 8)
	expectImageValues(flat, [0.5, 0.5, 0.5], 8)
})

test('contrast rejects negative and non-finite factors before mutation', () => {
	for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const image = makeImage(2, 1, 1, [0.2, 0.8])
		const before = new Float32Array(image.raw)
		expect(() => contrast(image, value)).toThrow()
		expect(image.raw).toEqual(before)
	}
})

test('gamma clips signed and out-of-range samples before inverse encoding', () => {
	const image = makeImage(3, 1, 1, [-0.2, 0.25, 1.2])

	expect(gamma(image, 2)).toBe(image)
	expectImageValues(image, [0, 0.5, 1], 8)
})

test('gamma supports positive values outside the previous display-only range', () => {
	const darken = makeImage(1, 1, 1, [0.25])
	const lighten = makeImage(1, 1, 1, [0.25])

	gamma(darken, 0.5)
	gamma(lighten, 4)

	expectImageValues(darken, [0.0625], 8)
	expectImageValues(lighten, [Math.SQRT1_2], 7)
})

test('gamma handles identity and non-finite source samples without leaking them', () => {
	const identity = makeImage(2, 1, 1, [0.25, 1])
	const nonFinite = makeImage(3, 1, 1, [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])

	expect(gamma(identity, 1)).toBe(identity)
	gamma(nonFinite, 2)

	expectImageValues(identity, [0.25, 1], 8)
	expectImageValues(nonFinite, [0, 1, 0], 8)
})

test('gamma rejects non-positive and non-finite values before mutation', () => {
	for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const image = makeImage(2, 1, 1, [0.25, 1])
		const before = new Float32Array(image.raw)
		expect(() => gamma(image, value)).toThrow()
		expect(image.raw).toEqual(before)
	}
})
