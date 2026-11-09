import { describe, expect, test } from 'bun:test'
import { BT709_LUMINANCE, blendLuminanceRows, type ChannelMix, type CompositionPlane, collectLuminanceSamples, createCompositionCounters, createLuminanceSamples, type LuminanceMatch, mixChannelRows, solveLuminanceMatch, validateChannelMix } from '../../../src/imaging/processing/channel.composition'
import { mulberry32, normal } from '../../../src/math/numerical/random'

function plane(values: readonly number[], valid?: readonly number[], gain = 1, offset = 0): CompositionPlane {
	return { raw: Float64Array.from(values), valid: Uint8Array.from(valid ?? values.map(() => 1)), gain, offset }
}

function mix(planes: readonly CompositionPlane[], channels: ChannelMix) {
	const pixels = planes[0].raw.length
	const rgb = new Float64Array(pixels * 3)
	const valid = new Uint8Array(pixels)
	const counters = createCompositionCounters()
	expect(validateChannelMix(channels, planes)).toEqual([])
	mixChannelRows(planes, channels, pixels, rgb, valid, counters)
	return { rgb, valid, counters }
}

function luminanceOf(rgb: ArrayLike<number>, pixel: number) {
	return BT709_LUMINANCE[0] * rgb[pixel * 3] + BT709_LUMINANCE[1] * rgb[pixel * 3 + 1] + BT709_LUMINANCE[2] * rgb[pixel * 3 + 2]
}

const IDENTITY: LuminanceMatch = { scale: 1, offset: 0, matched: false, samples: 0, floor: 1e-6 }

describe('channel mixing', () => {
	test('RGB identity reconstructs the channels', () => {
		const { rgb, counters } = mix([plane([0.1, 0.4]), plane([0.2, 0.5]), plane([0.3, 0.6])], { red: [{ plane: 0, weight: 1 }], green: [{ plane: 1, weight: 1 }], blue: [{ plane: 2, weight: 1 }] })
		expect(Array.from(rgb)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
		expect(counters.valid).toBe(2)
	})

	test('HOO drives green and blue from one OIII master', () => {
		const ha = plane([0.5, 0.25])
		const oiii = plane([0.125, 0.375])
		const { rgb } = mix([ha, oiii], { red: [{ plane: 0, weight: 1 }], green: [{ plane: 1, weight: 1 }], blue: [{ plane: 1, weight: 1 }] })
		expect(Array.from(rgb)).toEqual([0.5, 0.125, 0.125, 0.25, 0.375, 0.375])
	})

	test('SHO maps SII to red, Ha to green, and OIII to blue', () => {
		const planes = [plane([0.5]), plane([0.25]), plane([0.125])] // Ha, OIII, SII
		const { rgb } = mix(planes, { red: [{ plane: 2, weight: 1 }], green: [{ plane: 0, weight: 1 }], blue: [{ plane: 1, weight: 1 }] })
		expect(Array.from(rgb)).toEqual([0.125, 0.5, 0.25])
	})

	test('a custom mix averages weighted, corrected terms', () => {
		const red = plane([0.4], undefined, 2, -0.1)
		const ha = plane([0.6])
		const { rgb } = mix([red, ha], {
			red: [
				{ plane: 0, weight: 0.7 },
				{ plane: 1, weight: 0.3 },
			],
			green: [{ plane: 1, weight: 2 }],
			blue: [{ plane: 0, weight: 1 }],
		})
		expect(rgb[0]).toBeCloseTo(0.7 * (2 * 0.4 - 0.1) + 0.3 * 0.6, 6)
		expect(rgb[1]).toBeCloseTo(0.6, 6)
		expect(rgb[2]).toBeCloseTo(2 * 0.4 - 0.1, 6)
	})

	test('a pixel lacking any contributing master is unsupported, while zero-weight terms do not count', () => {
		const a = plane([0.1, 0.2, 0.3], [1, 0, 1])
		const b = plane([0.4, 0.5, Number.NaN], [1, 1, 1])
		const c = plane([0.7, 0.8, 0.9], [0, 0, 0])
		const { rgb, valid, counters } = mix([a, b, c], {
			red: [{ plane: 0, weight: 1 }],
			green: [
				{ plane: 1, weight: 1 },
				{ plane: 2, weight: 0 },
			],
			blue: [{ plane: 1, weight: 1 }],
		})
		expect(Array.from(valid)).toEqual([1, 0, 0])
		expect(rgb[3]).toBeNaN()
		expect(rgb[6]).toBeNaN()
		expect(counters).toEqual({ valid: 1, unsupported: 2, nonFinite: 0, luminanceFallback: 0 })
	})

	test('validation explains every unusable mix', () => {
		const planes = [plane([0]), { ...plane([0]), gain: 0 }, { ...plane([0]), offset: Number.NaN }]
		expect(validateChannelMix({ red: [], green: [{ plane: 0, weight: 0 }], blue: [{ plane: 5, weight: 1 }] }, planes)).toEqual([
			{ code: 'emptyChannel', channel: 'red' },
			{ code: 'emptyChannel', channel: 'green' },
			{ code: 'unknownPlane', channel: 'blue', plane: 5 },
			{ code: 'emptyChannel', channel: 'blue' },
		])
		expect(
			validateChannelMix(
				{
					red: [
						{ plane: 0, weight: -1 },
						{ plane: 1, weight: 1 },
					],
					green: [{ plane: 2, weight: 1 }],
					blue: [
						{ plane: 0, weight: Number.NaN },
						{ plane: 0, weight: 1 },
					],
				},
				planes,
			),
		).toEqual([
			{ code: 'invalidWeight', channel: 'red', plane: 0 },
			{ code: 'invalidWeight', channel: 'blue', plane: 0 },
			{ code: 'invalidGain', plane: 1 },
			{ code: 'invalidOffset', plane: 2 },
		])
	})
})

describe('luminance blending', () => {
	const RGB_MIX: ChannelMix = { red: [{ plane: 0, weight: 1 }], green: [{ plane: 1, weight: 1 }], blue: [{ plane: 2, weight: 1 }] }

	test('alpha zero leaves the RGB composition bit-identical', () => {
		const { rgb, valid, counters } = mix([plane([0.1, 0.4]), plane([0.2, 0.5]), plane([0.3, 0.6])], RGB_MIX)
		const before = rgb.slice()
		blendLuminanceRows(rgb, valid, plane([9, Number.NaN], [0, 0]), IDENTITY, 0, 2, counters)
		expect(rgb).toEqual(before)
		expect(counters.valid).toBe(2)
	})

	test('alpha one reaches the luminance target and preserves channel ratios and neutrality', () => {
		const { rgb, valid, counters } = mix([plane([0.2, 0.3]), plane([0.4, 0.3]), plane([0.1, 0.3])], RGB_MIX)
		const luminance = plane([0.5, 0.6])
		blendLuminanceRows(rgb, valid, luminance, IDENTITY, 1, 2, counters)
		expect(luminanceOf(rgb, 0)).toBeCloseTo(0.5, 10)
		expect(rgb[0] / rgb[1]).toBeCloseTo(0.5, 10)
		expect(rgb[2] / rgb[1]).toBeCloseTo(0.25, 6)
		expect(rgb[3]).toBeCloseTo(0.6, 6)
		expect(rgb[4]).toBeCloseTo(0.6, 6)
		expect(rgb[5]).toBeCloseTo(0.6, 6)
		expect(counters.luminanceFallback).toBe(0)
	})

	test('partial alpha interpolates the luminance', () => {
		const { rgb, valid, counters } = mix([plane([0.2]), plane([0.4]), plane([0.1])], RGB_MIX)
		const y = luminanceOf(rgb, 0)
		blendLuminanceRows(rgb, valid, plane([0.8]), IDENTITY, 0.25, 1, counters)
		expect(luminanceOf(rgb, 0)).toBeCloseTo(0.75 * y + 0.25 * 0.8, 10)
	})

	test('shadows and negative targets blend additively and stay finite', () => {
		const { rgb, valid, counters } = mix([plane([0, -0.01, 0.3]), plane([0, 0.02, 0.3]), plane([0, 0, 0.3])], RGB_MIX)
		const match = { ...IDENTITY, floor: 0.05 }
		blendLuminanceRows(rgb, valid, plane([0.2, 0.1, -0.5]), match, 1, 3, counters)
		expect(luminanceOf(rgb, 0)).toBeCloseTo(0.2, 10)
		expect(luminanceOf(rgb, 1)).toBeCloseTo(0.1, 10)
		expect(luminanceOf(rgb, 2)).toBeCloseTo(-0.5, 10)
		expect(rgb[6]).toBeCloseTo(rgb[7], 12)
		for (const value of rgb) expect(Number.isFinite(value)).toBeTrue()
		expect(counters.luminanceFallback).toBe(3)
	})

	test('a pixel without luminance support becomes unsupported', () => {
		const { rgb, valid, counters } = mix([plane([0.2, 0.3]), plane([0.4, 0.3]), plane([0.1, 0.3])], RGB_MIX)
		blendLuminanceRows(rgb, valid, plane([0.5, 0.6], [1, 0]), IDENTITY, 0.5, 2, counters)
		expect(Array.from(valid)).toEqual([1, 0])
		expect(rgb[3]).toBeNaN()
		expect(counters).toEqual({ valid: 1, unsupported: 1, nonFinite: 0, luminanceFallback: 0 })
	})
})

describe('luminance matching', () => {
	test('robust linear matching recovers a linear relation across strips', () => {
		const random = normal(mulberry32(3), 0, 0.002)
		const width = 64
		const height = 64
		const pixels = width * height
		const red = new Float32Array(pixels)
		const green = new Float32Array(pixels)
		const blue = new Float32Array(pixels)
		const lum = new Float32Array(pixels)

		for (let i = 0; i < pixels; i++) {
			const signal = 0.1 + 0.4 * Math.exp(-(((i % width) - 30) ** 2) / 800 - (Math.floor(i / width) - 28) ** 2 / 1200)
			red[i] = signal * 0.9 + random()
			green[i] = signal + random()
			blue[i] = signal * 1.2 + random()
			// The master is twice the mixed luminance plus a pedestal.
			lum[i] = 2 * (BT709_LUMINANCE[0] * signal * 0.9 + BT709_LUMINANCE[1] * signal + BT709_LUMINANCE[2] * signal * 1.2) + 0.05
		}

		const samples = createLuminanceSamples(pixels)
		const counters = createCompositionCounters()
		const rows = 7

		for (let top = 0; top < height; top += rows) {
			const first = top * width
			const count = Math.min(rows, height - top) * width
			const strip = (raw: Float32Array) => ({ raw: raw.subarray(first, first + count), valid: new Uint8Array(count).fill(1), gain: 1, offset: 0 })
			const rgb = new Float64Array(count * 3)
			const valid = new Uint8Array(count)
			mixChannelRows([strip(red), strip(green), strip(blue)], { red: [{ plane: 0, weight: 1 }], green: [{ plane: 1, weight: 1 }], blue: [{ plane: 2, weight: 1 }] }, count, rgb, valid, counters)
			collectLuminanceSamples(samples, rgb, valid, strip(lum), count)
		}

		expect(samples.position).toBe(pixels)
		expect(samples.rgb.length).toBe(pixels)
		const match = solveLuminanceMatch(samples, 'robustLinear')
		expect(match.matched).toBeTrue()
		expect(match.scale).toBeCloseTo(0.5, 2)
		expect(match.offset).toBeCloseTo(-0.025, 2)
		// The floor follows the pixel noise of the luminance (3 sigma), not the spread of the bright, smooth scene.
		const noise = 0.002 * Math.hypot(...BT709_LUMINANCE)
		expect(Math.abs(match.floor / (3 * noise) - 1)).toBeLessThan(0.1)
		expect(solveLuminanceMatch(samples, 'off')).toMatchObject({ scale: 1, offset: 0, matched: false })
	})

	test('a sparse sample set keeps the identity, and the stride bounds the sample count', () => {
		const samples = createLuminanceSamples(10)
		const rgb = Float64Array.from([0.1, 0.1, 0.1, 0.2, 0.2, 0.2])
		collectLuminanceSamples(samples, rgb, Uint8Array.of(1, 1), plane([0.3, 0.4]), 2)
		expect(solveLuminanceMatch(samples, 'robustLinear')).toMatchObject({ scale: 1, offset: 0, matched: false, samples: 2 })
		expect(createLuminanceSamples(10_000_000).stride).toBeGreaterThan(1)
	})
})
