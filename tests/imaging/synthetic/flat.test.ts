import { expect, test } from 'bun:test'
import type { CfaPattern } from '../../../src/imaging/model/types'
import { generateSyntheticFlatImage, renderSyntheticFlat, type SyntheticFlatModel } from '../../../src/imaging/synthetic/flat'

// Deterministic flat fixtures exercise digital scale, full-sensor geometry, and spatial artifacts.

// Returns a small uniform monochrome model with all optional effects disabled.
function fixture(overrides: Partial<SyntheticFlatModel> = {}): SyntheticFlatModel {
	return { width: 5, height: 5, bias: 100, signal: 1000, vignetting: 0, ...overrides }
}

test('generates a digital flat with pedestal, clipping, and quantization metadata', () => {
	const image = generateSyntheticFlatImage(fixture({ width: 2, height: 2, bias: 2.4, signal: 10.2, quantizationStep: 2, lowerClip: 0, upperClip: 11 }))
	expect(image.sampleScale).toBe('digital')
	expect(image.digitalRange).toEqual([0, 11])
	expect(image.quantizationStep).toBe(2)
	expect(image.raw).toEqual(new Float64Array([11, 11, 11, 11]))
	expect(image.metadata.stride).toBe(2)
	expect(image.header.BITPIX).toBe(-64)

	const lower = generateSyntheticFlatImage(fixture({ width: 1, height: 1, bias: -3, signal: 0, quantizationStep: 2, lowerClip: 0, upperClip: 10 }))
	expect(lower.raw[0]).toBe(0)
})

test('models exact quadratic vignetting and signed edge-to-edge gradients', () => {
	const vignetted = generateSyntheticFlatImage(fixture({ width: 3, height: 3, bias: 0, signal: 100, vignetting: 0.5 }))
	expect(vignetted.raw[4]).toBeCloseTo(100, 12)
	expect(vignetted.raw[0]).toBeCloseTo(50, 12)
	expect(vignetted.raw[8]).toBeCloseTo(50, 12)

	const gradient = generateSyntheticFlatImage(fixture({ width: 3, height: 1, bias: 0, signal: 100, gradient: { x: 0.4, y: 0 } }))
	expect(gradient.raw[0]).toBeCloseTo(80, 12)
	expect(gradient.raw[1]).toBeCloseTo(100, 12)
	expect(gradient.raw[2]).toBeCloseTo(120, 12)

	const shifted = generateSyntheticFlatImage(fixture({ width: 3, height: 3, bias: 0, signal: 100, vignetting: 0.5, centerOffset: { x: 1, y: 0 } }))
	expect(shifted.raw[5]).toBeCloseTo(100, 12)
	expect(shifted.raw[3]).toBeLessThan(shifted.raw[5])
})

test('keeps PRNU fixed while changing only temporal noise by frame index', () => {
	const fixedA = generateSyntheticFlatImage(fixture({ prnu: 0.1, seed: 42, frameIndex: 0 }))
	const fixedB = generateSyntheticFlatImage(fixture({ prnu: 0.1, seed: 42, frameIndex: 99 }))
	expect(fixedA.raw).toEqual(fixedB.raw)

	const noiseA = generateSyntheticFlatImage(fixture({ prnu: 0.1, noise: 2, seed: 42, frameIndex: 0 }))
	const noiseB = generateSyntheticFlatImage(fixture({ prnu: 0.1, noise: 2, seed: 42, frameIndex: 1 }))
	expect(noiseA.raw).not.toEqual(noiseB.raw)
	expect(generateSyntheticFlatImage(fixture({ prnu: 0.1, noise: 2, seed: 42, frameIndex: 1 })).raw).toEqual(noiseB.raw)
})

test('combines circular, elliptical, overlapping, and edge dust shadows', () => {
	const image = generateSyntheticFlatImage(
		fixture({
			width: 9,
			height: 9,
			bias: 0,
			signal: 100,
			dustMotes: [
				{ center: { x: 4, y: 4 }, sigmaX: 2, sigmaY: 2, contrast: 0.5 },
				{ center: { x: 4, y: 4 }, sigmaX: 3, sigmaY: 1, angle: Math.PI / 2, contrast: 0.2 },
				{ center: { x: 0, y: 0 }, sigmaX: 1, sigmaY: 1, contrast: 0.4 },
			],
		}),
	)
	expect(image.raw[4 * 9 + 4]).toBeCloseTo(40, 5)
	expect(image.raw[0]).toBeLessThan(61)
	expect(image.raw[8 * 9 + 8]).toBeGreaterThan(99)
	expect(image.raw[2 * 9 + 4]).toBeLessThan(image.raw[4 * 9 + 2])
})

test('produces independent row and column banding with known periods', () => {
	const row = generateSyntheticFlatImage(fixture({ width: 3, height: 4, bias: 0, signal: 100, rowBanding: { amplitude: 0.25, period: 4, phase: Math.PI / 2 } }))
	expect(Array.from(row.raw.subarray(0, 3))).toEqual([125, 125, 125])
	expect(Array.from(row.raw.subarray(3, 6))).toEqual([100, 100, 100])
	expect(Array.from(row.raw.subarray(6, 9))).toEqual([75, 75, 75])

	const mixed = generateSyntheticFlatImage(fixture({ width: 4, height: 4, bias: 0, signal: 100, rowBanding: { amplitude: 0.1, period: 4 }, columnBanding: { amplitude: 0.2, period: 4, phase: Math.PI / 2 } }))
	expect(mixed.raw[0]).toBeCloseTo(120, 12)
	expect(mixed.raw[1]).toBeCloseTo(100, 12)
	expect(mixed.raw[4]).toBeCloseTo(130, 12)
})

test('applies RGB response and every CFA pattern in absolute sensor phase', () => {
	const rgb = generateSyntheticFlatImage(fixture({ width: 1, height: 1, channels: 3, bias: 0, signal: 100, channelResponse: [1, 0.5, 0.25] }))
	expect(rgb.raw).toEqual(new Float64Array([100, 50, 25]))
	expect(rgb.metadata.stride).toBe(3)

	const patterns: readonly CfaPattern[] = ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG']
	for (const bayer of patterns) {
		const image = generateSyntheticFlatImage(fixture({ width: 2, height: 2, bayer, bias: 0, signal: 100, channelResponse: [1, 0.5, 0.25] }))
		const expected = new Array<number>(4)
		for (let i = 0; i < expected.length; i++) expected[i] = bayer[i] === 'R' ? 100 : bayer[i] === 'G' ? 50 : 25
		expect(Array.from(image.raw)).toEqual(expected)
		expect(image.metadata.bayer).toBe(bayer)
	}

	const crop = generateSyntheticFlatImage(fixture({ width: 2, height: 2, bayer: 'RGGB', bias: 0, signal: 100, channelResponse: [1, 0.5, 0.25], sensor: { width: 4, height: 4, origin: { x: 1, y: 1 } } }))
	expect(Array.from(crop.raw)).toEqual([25, 50, 50, 100])
	expect(crop.header.XORGSUBF).toBe(1)
	expect(crop.header.YORGSUBF).toBe(1)
})

test('makes subframes identical to full-frame crops for fixed and temporal fields', () => {
	const effects = {
		bias: 10,
		signal: 100,
		vignetting: 0.3,
		gradient: { x: 0.2, y: -0.1 },
		prnu: 0.05,
		noise: 1,
		seed: 17,
		frameIndex: 3,
		dustMotes: [{ center: { x: 3, y: 4 }, sigmaX: 1.5, sigmaY: 2, contrast: 0.3 }],
		rowBanding: { amplitude: 0.05, period: 3 },
	} as const
	const full = generateSyntheticFlatImage({ width: 8, height: 6, sensor: { width: 8, height: 6 }, ...effects })
	const crop = generateSyntheticFlatImage({ width: 3, height: 2, sensor: { width: 8, height: 6, origin: { x: 2, y: 3 } }, ...effects })
	for (let y = 0; y < 2; y++) {
		for (let x = 0; x < 3; x++) expect(crop.raw[y * 3 + x]).toBe(full.raw[(y + 3) * 8 + x + 2])
	}
})

test('maps anisotropic binning through separate sensor axes', () => {
	const image = generateSyntheticFlatImage(
		fixture({
			width: 4,
			height: 9,
			bias: 0,
			signal: 100,
			sensor: { width: 9, height: 9, binning: [2, 1] },
			dustMotes: [{ center: { x: 4.5, y: 4 }, sigmaX: 2, sigmaY: 2, contrast: 0.5 }],
		}),
	)
	expect(image.raw[4 * 4 + 2]).toBeCloseTo(50, 12)
	expect(image.raw[4 * 4 + 1]).toBeCloseTo(image.raw[2 * 4 + 2], 12)

	const partial = generateSyntheticFlatImage(fixture({ width: 3, height: 1, bias: 0, signal: 100, sensor: { width: 5, height: 1, binning: [2, 1], extent: { width: 5, height: 1 } }, dustMotes: [{ center: { x: 4, y: 0 }, sigmaX: 0.5, sigmaY: 1, contrast: 0.5 }] }))
	expect(partial.raw[2]).toBeCloseTo(50, 12)
})

test('validates geometry, factors, artifacts, clipping, and caller buffers', () => {
	expect(() => renderSyntheticFlat(new Float64Array(3), fixture({ width: 2, height: 2 }))).toThrow('buffer length')
	expect(() => generateSyntheticFlatImage(fixture({ vignetting: 1.1 }))).toThrow('vignetting')
	expect(() => generateSyntheticFlatImage(fixture({ gradient: { x: 2, y: 1 } }))).toThrow('gradient')
	expect(() => generateSyntheticFlatImage(fixture({ channels: 3, channelResponse: [1] as unknown as readonly [number, number, number] }))).toThrow('exactly three')
	expect(() => generateSyntheticFlatImage(fixture({ lowerClip: 10, upperClip: 10 }))).toThrow('lower clip')
	expect(() => generateSyntheticFlatImage(fixture({ bayer: 'RGGB', sensor: { width: 10, height: 10, binning: [2, 1] } }))).toThrow('CFA output requires unit binning')
	expect(() => generateSyntheticFlatImage(fixture({ dustMotes: [{ center: { x: 1, y: 1 }, sigmaX: 0, sigmaY: 1, contrast: 0.2 }] }))).toThrow('dust sigmas')
	expect(() => generateSyntheticFlatImage(fixture({ rowBanding: { amplitude: 0.5, period: 0 } }))).toThrow('banding period')
})
