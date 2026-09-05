import { expect, test } from 'bun:test'
import { createCollimationWorkspace, prepareCollimation, refineCollimationBackground } from '../../../../src/imaging/analysis/collimation/preprocess'
import type { CfaPattern, Image } from '../../../../src/imaging/model/types'
import { mulberry32, normal } from '../../../../src/math/numerical/random'

function image(width = 64, height = 64, channels = 1, bayer?: CfaPattern): Image {
	return {
		header: {},
		metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * channels * 8, pixelSizeInBytes: 8, bitpix: -64, bayer },
		raw: new Float64Array(width * height * channels),
	}
}

test('subtracts a planar background without losing tiny signed Float64 signal', () => {
	const input = image()
	for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) input.raw[y * 64 + x] = 0.5 + x * 1e-5 - y * 2e-5
	input.raw[32 * 64 + 32] += 1e-10
	input.raw[33 * 64 + 32] -= 2e-10
	const copy = input.raw.slice()
	const result = prepareCollimation({ image: input, area: { left: 0, top: 0, right: 64, bottom: 64 } }, { smoothingSigma: 0 })
	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.workspace.signal[32 * 64 + 32]).toBeCloseTo(1e-10, 15)
	expect(result.workspace.signal[33 * 64 + 32]).toBeCloseTo(-2e-10, 15)
	expect(result.background.noise).toBeUndefined()
	expect(input.raw).toEqual(copy)
})

test('estimates background noise without shrinking its residual population', () => {
	const input = image(128, 128)
	const noise = normal(mulberry32(8791), 0, 0.01)
	for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) input.raw[y * 128 + x] = 0.2 + 0.001 * x + noise()
	const result = prepareCollimation({ image: input, area: { left: 0, top: 0, right: 128, bottom: 128 } })
	if (!result.success) throw new Error(result.reason)
	expect(result.background.noise).toBeGreaterThan(0.008)
	expect(result.background.noise).toBeLessThan(0.012)
})

test('selects native CFA parity with different responses and invalid unselected colors', () => {
	for (const bayer of ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG'] as const) {
		for (let parity = 0; parity < 4; parity++) {
			const input = image(80, 80, 1, bayer)
			const slot = bayer.indexOf('G')
			for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) input.raw[y * 80 + x] = (x % 2) + 2 * (y % 2) === slot ? 0.2 + x * 0.001 : Number.NaN
			const area = { left: parity & 1, top: parity >>> 1, right: 79, bottom: 79 }
			const result = prepareCollimation({ image: input, area }, { smoothingSigma: undefined })
			expect(result.success).toBeTrue()
			if (!result.success) continue
			expect(result.plane).toBe('green1')
			expect(result.grid.step).toBe(2)
			expect(result.grid.sourceLeft % 2).toBe(slot & 1)
			expect(result.grid.sourceTop % 2).toBe(slot >>> 1)
			expect(result.workspace.mask.subarray(0, result.grid.width * result.grid.height).some(Boolean)).toBeFalse()
			expect(result.options.smoothingSigma).toBe(1)
		}
	}
})

test('keeps RGB sampling separate and rejects an unsupported plane without mutation', () => {
	const input = image(64, 64, 3)
	input.raw.fill(Number.NaN)
	for (let i = 1; i < input.raw.length; i += 3) input.raw[i] = 0.1
	const workspace = createCollimationWorkspace(64, 64, { precision: 64 })
	const area = { left: 0, top: 0, right: 64, bottom: 64 }
	const result = prepareCollimation({ image: input, area }, { workspace })
	expect(result.success).toBeTrue()
	if (result.success) expect(result.plane).toBe('green')
	const saved = workspace.plane.slice()
	expect(prepareCollimation({ image: input, area }, { workspace, plane: 'green1' })).toMatchObject({ success: false, reason: 'unsupportedPlane' })
	expect(workspace.plane).toEqual(saved)
})

test('dilates full invalid and saturated support before smoothing', () => {
	const input = image()
	input.raw.fill(0.2)
	input.raw[32 * 64 + 32] = Number.NaN
	input.raw[40 * 64 + 40] = 2
	const result = prepareCollimation({ image: input, area: { left: 0, top: 0, right: 64, bottom: 64 } }, { saturationLevel: 1, smoothingSigma: 1 })
	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.workspace.expandedMask[29 * 64 + 29]).toBe(1)
	expect(result.workspace.expandedMask[28 * 64 + 29]).toBe(0)
	expect(result.workspace.expandedMask[43 * 64 + 43]).toBe(2)
	expect(result.workspace.smoothed.every(Number.isFinite)).toBeTrue()
})

test('reuses larger scratch with exact active dimensions and refreshes angular/kernel caches', () => {
	const input = image(96, 80)
	for (let y = 0; y < 80; y++) for (let x = 0; x < 96; x++) input.raw[y * 96 + x] = x * 0.001 + y * 0.002
	const workspace = createCollimationWorkspace(128, 128, { precision: 64, angularSamples: 720 })
	const area = { left: 11, top: 9, right: 80, bottom: 74 }
	const first = prepareCollimation({ image: input, area }, { workspace })
	expect(first.success).toBeTrue()
	const kernel = workspace.cache.kernel
	const second = prepareCollimation({ image: input, area: { left: 14, top: 17, right: 78, bottom: 69 } }, { workspace, angularSamples: 180 })
	expect(second.success).toBeTrue()
	if (!second.success) return
	expect(workspace.cache.kernel).toBe(kernel)
	expect(workspace.sin[45]).toBeCloseTo(1, 14)
	expect(second.metadata.stride).toBe(64)
	expect(second.metadata.height).toBe(52)
	expect(Math.abs(workspace.smoothed[26 * 64 + 32])).toBeLessThan(1e-14)
	const saved = workspace.plane.slice()
	expect(() => prepareCollimation({ image: { ...input, raw: new Float32Array(input.raw) }, area }, { workspace })).toThrow('incompatible')
	expect(workspace.plane).toEqual(saved)
})

test('requires spatial exterior background and rejects structural capacity mistakes', () => {
	const input = image()
	input.raw.fill(Number.NaN)
	for (let y = 20; y < 45; y++) for (let x = 20; x < 45; x++) input.raw[y * 64 + x] = 0
	const area = { left: 0, top: 0, right: 64, bottom: 64 }
	expect(prepareCollimation({ image: input, area })).toMatchObject({ success: false, reason: 'insufficientBackground' })
	input.raw.fill(0.2)
	const result = prepareCollimation({ image: input, area })
	if (!result.success) throw new Error(result.reason)
	expect(refineCollimationBackground(result, { center: { x: 32, y: 32 }, semiMajor: 100, semiMinor: 100, theta: 0 })).toBeFalse()
	expect(() => prepareCollimation({ image: { ...input, metadata: { ...input.metadata, stride: 65 } }, area })).toThrow('layout')
	expect(() => createCollimationWorkspace(1025, 20)).toThrow()
	expect(() => createCollimationWorkspace(64, 64, { angularSamples: Infinity })).toThrow()
	expect(() => prepareCollimation({ image: input, area }, { smoothingSigma: Infinity })).toThrow()
})
