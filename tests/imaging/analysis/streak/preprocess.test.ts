import { expect, test } from 'bun:test'
import { preprocessStreakImage, STREAK_MASK_INVALID, STREAK_MASK_SATURATED, streakLocalNoise, streakLocalNoiseAtPixel } from '../../../../src/imaging/analysis/streak/preprocess'
import { createStreakDetectionWorkspace } from '../../../../src/imaging/analysis/streak/workspace'
import type { Image } from '../../../../src/imaging/model/types'

function image(raw: Float32Array | Float64Array, width: number, height: number, channels: 1 | 3 = 1, bayer?: Image['metadata']['bayer']): Image {
	const bytes = raw.BYTES_PER_ELEMENT
	return { raw, header: {}, metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * channels * bytes, pixelSizeInBytes: bytes, bitpix: bytes === 8 ? -64 : -32, bayer } }
}

function addGaussianNoise(raw: Float32Array, sigmaAt: (x: number, y: number) => number, width: number, seed: number = 0x6d2b79f5): void {
	let state = seed
	for (let index = 0; index < raw.length; index += 2) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const first = Math.max(Number.EPSILON, (state >>> 0) / 0x1_0000_0000)
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const second = (state >>> 0) / 0x1_0000_0000
		const radius = Math.sqrt(-2 * Math.log(first))
		const angle = 2 * Math.PI * second
		const x = index % width
		const y = Math.floor(index / width)
		raw[index] += radius * Math.cos(angle) * sigmaAt(x, y)
		if (index + 1 < raw.length) raw[index + 1] += radius * Math.sin(angle) * sigmaAt((index + 1) % width, Math.floor((index + 1) / width))
	}
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

test('estimates residual Gaussian noise locally after removing a smooth gradient', () => {
	const width = 64
	const height = 32
	const raw = new Float32Array(width * height)
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * width + x] = 0.2 + x * 0.0005 + y * 0.0003
	addGaussianNoise(raw, (x) => (x < width / 2 ? 0.003 : 0.015), width)
	const prepared = preprocessStreakImage(image(raw, width, height), { backgroundCellSize: 16 })
	const quiet = streakLocalNoise(prepared, 12, 16)
	const noisy = streakLocalNoise(prepared, 52, 16)
	expect(quiet).toBeGreaterThan(0.0015)
	expect(quiet).toBeLessThan(0.006)
	expect(noisy).toBeGreaterThan(quiet * 2.5)
	expect(prepared.globalNoise).toBeGreaterThan(quiet)
})

test('uses bounded global fallback for an unresolved cell and ignores invalid samples', () => {
	const width = 32
	const height = 16
	const raw = new Float32Array(width * height).fill(0.2)
	addGaussianNoise(raw, () => 0.01, width, 1234)
	for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) raw[y * width + x] = Number.NaN
	raw[0] = 0.2
	const prepared = preprocessStreakImage(image(raw, width, height), { backgroundCellSize: 8 })
	expect(prepared.globalNoise).toBeGreaterThan(0.005)
	expect(prepared.globalNoise).toBeLessThan(0.02)
	expect(prepared.workspace.noise[0]).toBe(prepared.globalNoise)
	expect(Number.isFinite(streakLocalNoise(prepared, 12, 4))).toBeTrue()
})

test('precomputes integer-pixel noise interpolation without changing its values', () => {
	const width = 35
	const height = 27
	const raw = new Float32Array(width * height).fill(0.2)
	addGaussianNoise(raw, (x, y) => 0.002 + x * 0.0002 + y * 0.0001, width)
	const prepared = preprocessStreakImage(image(raw, width, height), { backgroundCellSize: 8 })
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) expect(streakLocalNoiseAtPixel(prepared, x, y)).toBeCloseTo(streakLocalNoise(prepared, x, y), 14)
	}
})
