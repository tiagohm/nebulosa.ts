import { expect, test } from 'bun:test'
import type { Image, ImageChannel } from '../../../src/imaging/model/types'
import { scnr, type SCNRProtectionMethod } from '../../../src/imaging/processing/scnr'
import { expectImageValues, makeImage } from './util'

// Independent scalar definition of the full-strength kernel followed by amount blending.
function referenceSCNR(a: number, b: number, c: number, amount: number, method: SCNRProtectionMethod) {
	let corrected: number
	switch (method) {
		case 'MAXIMUM_MASK':
			corrected = a * Math.max(b, c)
			break
		case 'ADDITIVE_MASK':
			corrected = a * Math.min(1, b + c)
			break
		case 'AVERAGE_NEUTRAL':
			corrected = Math.min(a, 0.5 * (b + c))
			break
		case 'MAXIMUM_NEUTRAL':
			corrected = Math.min(a, Math.max(b, c))
			break
		case 'MINIMUM_NEUTRAL':
			corrected = Math.min(a, Math.min(b, c))
			break
	}
	return a + amount * (corrected - a)
}

// Complete protection-method set used for exhaustive behavioral checks.
const METHODS: readonly SCNRProtectionMethod[] = ['MAXIMUM_MASK', 'ADDITIVE_MASK', 'AVERAGE_NEUTRAL', 'MAXIMUM_NEUTRAL', 'MINIMUM_NEUTRAL']

// Complete selectable RGB-channel set used for offset checks.
const CHANNELS: readonly ImageChannel[] = ['RED', 'GREEN', 'BLUE']

test('scnr matches an independent reference for every method, channel, and precision', () => {
	const values = [0.9, 0.2, 0.4, 0.1, 0.8, 0.3, 0.7, 0.6, 0.95]
	for (const method of METHODS) {
		for (const channel of CHANNELS) {
			for (const precision of [32, 64] as const) {
				const base = makeImage(3, 1, 3, values)
				const image: Image = precision === 32 ? base : { ...base, raw: new Float64Array(values) }
				const expected = Array.from(image.raw)
				const target = channel === 'RED' ? 0 : channel === 'GREEN' ? 1 : 2
				const firstOther = target === 0 ? 1 : target === 1 ? 2 : 0
				const secondOther = target === 0 ? 2 : target === 1 ? 0 : 1
				for (let i = 0; i < expected.length; i += 3) {
					expected[i + target] = referenceSCNR(expected[i + target], expected[i + firstOther], expected[i + secondOther], 0.37, method)
				}

				expect(scnr(image, channel, 0.37, method)).toBe(image)
				expect(image.raw).toBeInstanceOf(precision === 32 ? Float32Array : Float64Array)
				expectImageValues(image, expected, precision === 32 ? 6 : 14)
			}
		}
	}
})

test('scnr neutral methods interpolate continuously with amount', () => {
	const scenarios: readonly [SCNRProtectionMethod, number, number][] = [
		['AVERAGE_NEUTRAL', 0.6, 0.3],
		['MAXIMUM_NEUTRAL', 0.65, 0.4],
		['MINIMUM_NEUTRAL', 0.55, 0.2],
	]
	for (const [method, half, full] of scenarios) {
		const zero = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
		const middle = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
		const one = makeImage(1, 1, 3, [0.2, 0.9, 0.4])

		scnr(zero, 'GREEN', 0, method)
		scnr(middle, 'GREEN', 0.5, method)
		scnr(one, 'GREEN', 1, method)

		expectImageValues(zero, [0.2, 0.9, 0.4], 7)
		expectImageValues(middle, [0.2, half, 0.4], 7)
		expectImageValues(one, [0.2, full, 0.4], 7)
	}
})

test('scnr neutral methods preserve a target channel already below their protection level', () => {
	for (const method of ['AVERAGE_NEUTRAL', 'MAXIMUM_NEUTRAL', 'MINIMUM_NEUTRAL'] as const) {
		const image = makeImage(1, 1, 3, [0.8, 0.1, 0.6])
		scnr(image, 'GREEN', 0.63, method)
		expectImageValues(image, [0.8, 0.1, 0.6], 7)
	}
})

test('scnr maximum-mask and additive-mask retain their defined attenuation', () => {
	const maximum = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
	const additive = makeImage(1, 1, 3, [0.2, 0.9, 0.4])

	scnr(maximum, 'GREEN', 1, 'MAXIMUM_MASK')
	scnr(additive, 'GREEN', 1, 'ADDITIVE_MASK')

	expectImageValues(maximum, [0.2, 0.36, 0.4], 7)
	expectImageValues(additive, [0.2, 0.54, 0.4], 7)
})

test('scnr default arguments preserve the established maximum-mask result', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.9, 0.4])

	scnr(image)

	expectImageValues(image, [0.2, 0.63, 0.4], 7)
})

test('scnr amount zero is an exact no-op for every method', () => {
	for (const method of METHODS) {
		const image = makeImage(2, 1, 3, [0.2, 0.9, 0.4, 0.8, 0.1, 0.6])
		const before = new Float32Array(image.raw)
		expect(scnr(image, 'GREEN', 0, method)).toBe(image)
		expect(image.raw).toEqual(before)
	}
})

test('scnr validates and leaves monochrome and CFA images unchanged', () => {
	const mono = makeImage(3, 1, 1, [0.2, 0.5, 0.7])
	const cfa = makeImage(2, 2, 1, [0.2, 0.5, 0.7, 0.9], { BAYERPAT: 'RGGB' })
	const beforeMono = new Float32Array(mono.raw)
	const beforeCfa = new Float32Array(cfa.raw)

	expect(scnr(mono)).toBe(mono)
	expect(scnr(cfa)).toBe(cfa)
	expect(mono.raw).toEqual(beforeMono)
	expect(cfa.raw).toEqual(beforeCfa)
})

test('scnr rejects amounts outside the unit interval before mutation', () => {
	for (const amount of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const image = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
		const before = new Float32Array(image.raw)
		expect(() => scnr(image, 'GREEN', amount)).toThrow()
		expect(image.raw).toEqual(before)
	}

	const mono = makeImage(1, 1, 1, [0.2])
	expect(() => scnr(mono, 'GREEN', Number.NaN)).toThrow('value must be finite')
})

test('scnr rejects malformed dense image layouts before mutation', () => {
	const valid = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
	const badWidth: Image = { ...valid, metadata: { ...valid.metadata, width: 0 } }
	const badHeight: Image = { ...valid, metadata: { ...valid.metadata, height: 0 } }
	const badPixelCount: Image = { ...valid, metadata: { ...valid.metadata, pixelCount: 2 } }
	const badChannels = makeImage(1, 1, 2, [0.2, 0.9])
	const short = makeImage(2, 1, 3, [0.2, 0.9, 0.4, 0.5, 0.6])
	const long = makeImage(1, 1, 3, [0.2, 0.9, 0.4, 0.5])
	const badCfaChannels = makeImage(1, 1, 3, [0.2, 0.9, 0.4], { BAYERPAT: 'RGGB' })
	const scenarios: readonly [Image, string][] = [
		[badWidth, 'image width must be a positive integer'],
		[badHeight, 'image height must be a positive integer'],
		[badPixelCount, 'image pixelCount does not match geometry'],
		[badChannels, 'image channels must be 1 or 3'],
		[short, 'image raw length does not match metadata'],
		[long, 'image raw length does not match metadata'],
		[badCfaChannels, 'image CFA data must have one channel'],
	]

	for (const [image, message] of scenarios) {
		const before = new Float32Array(image.raw)
		expect(() => scnr(image)).toThrow(message)
		expect(image.raw).toEqual(before)
	}
})
