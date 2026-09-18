import { expect, test } from 'bun:test'
import { preprocessStreakImage, STREAK_MASK_INVALID, STREAK_MASK_SATURATED } from '../../../../src/imaging/analysis/streak/preprocess'
import { createStreakDetectionWorkspace } from '../../../../src/imaging/analysis/streak/workspace'
import type { Image } from '../../../../src/imaging/model/types'

function image(raw: Float32Array | Float64Array, width: number, height: number, channels: 1 | 3 = 1, bayer?: Image['metadata']['bayer']): Image {
	const bytes = raw.BYTES_PER_ELEMENT
	return { raw, header: {}, metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * channels * bytes, pixelSizeInBytes: bytes, bitpix: bytes === 8 ? -64 : -32, bayer } }
}

test('subtracts robust local background without mutating the input', () => {
	const raw = new Float32Array(16 * 16)
	for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) raw[y * 16 + x] = 10 + x * 0.1 + y * 0.05
	raw[8 * 16 + 8] += 20
	const before = raw.slice()
	const prepared = preprocessStreakImage(image(raw, 16, 16), { backgroundCellSize: 8 })
	expect(raw).toEqual(before)
	expect(prepared.globalBackground).toBeGreaterThan(10)
	expect(prepared.workspace.signal[8 * 16 + 8]).toBeGreaterThan(18)
	expect(Math.abs(prepared.workspace.signal[0])).toBeLessThan(1)
})

test('marks invalid and known saturated samples while retaining finite signal', () => {
	const raw = new Float64Array(16 * 16).fill(0.25)
	raw[4] = Number.NaN
	raw[5] = 1.5
	const prepared = preprocessStreakImage(image(raw, 16, 16), { backgroundCellSize: 8, saturationLevel: 1 })
	expect(prepared.workspace.mask[4]).toBe(STREAK_MASK_INVALID)
	expect(prepared.workspace.mask[5]).toBe(STREAK_MASK_SATURATED)
	expect(prepared.workspace.signal[4]).toBe(0)
	expect(prepared.workspace.signal[5]).toBeCloseTo(1.25, 14)
})

test('reuses fixed workspace buffers and rejects insufficient capacity', () => {
	const raw = new Float32Array(16 * 16).fill(0.2)
	const workspace = createStreakDetectionWorkspace(16, 16, { maximumEdgePoints: 32 })
	const signal = workspace.signal
	expect(preprocessStreakImage(image(raw, 16, 16), { backgroundCellSize: 8 }, workspace).workspace.signal).toBe(signal)
	expect(() => preprocessStreakImage(image(raw, 16, 16), { maxCandidates: workspace.maximumCandidates + 1 }, workspace)).toThrow(RangeError)
})
