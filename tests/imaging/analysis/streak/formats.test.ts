import { expect, test } from 'bun:test'
import { detectStreaks } from '../../../../src/imaging/analysis/streak/detector'
import { preprocessStreakImage } from '../../../../src/imaging/analysis/streak/preprocess'
import type { Image } from '../../../../src/imaging/model/types'
import { renderSyntheticStreak } from '../../../../src/imaging/synthetic/streak'

function image(raw: Float32Array | Float64Array, width: number, height: number, channels: 1 | 3 = 1, bayer?: Image['metadata']['bayer']): Image {
	const bytes = raw.BYTES_PER_ELEMENT
	return { raw, header: {}, metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * channels * bytes, pixelSizeInBytes: bytes, bitpix: bytes === 8 ? -64 : -32, bayer } }
}

const CFA_PATTERNS: readonly NonNullable<Image['metadata']['bayer']>[] = ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG']

test('auto-selects green from interleaved RGB', () => {
	const raw = new Float32Array(16 * 16 * 3)
	for (let i = 0; i < 16 * 16; i++) {
		raw[i * 3] = 1
		raw[i * 3 + 1] = 4
		raw[i * 3 + 2] = 9
	}
	raw[(8 * 16 + 8) * 3 + 1] = 10
	const prepared = preprocessStreakImage(image(raw, 16, 16, 3), { backgroundCellSize: 8 })
	expect(prepared.plane).toBe('green')
	expect(prepared.workspace.signal[8 * 16 + 8]).toBeCloseTo(6, 6)
})

test('maps native CFA green1 grid with step two and ROI parity', () => {
	const raw = new Float64Array(18 * 18).fill(0.2)
	const prepared = preprocessStreakImage(image(raw, 18, 18, 1, 'RGGB'), { area: { left: 1, top: 1, right: 18, bottom: 18 }, backgroundCellSize: 8 })
	expect(prepared.plane).toBe('green1')
	expect(prepared.grid.sourceLeft).toBe(1)
	expect(prepared.grid.sourceTop).toBe(2)
	expect(prepared.grid.step).toBe(2)
	expect(prepared.grid.width).toBe(9)
	expect(prepared.grid.height).toBe(8)
})

test('supports explicit RGB and CFA planes and both precisions', () => {
	const rgb = new Float64Array(16 * 16 * 3).fill(0.5)
	expect(preprocessStreakImage(image(rgb, 16, 16, 3), { plane: 'red', backgroundCellSize: 8 }).plane).toBe('red')
	const cfa = new Float32Array(16 * 16).fill(0.5)
	expect(preprocessStreakImage(image(cfa, 16, 16, 1, 'BGGR'), { plane: 'green2', backgroundCellSize: 8 }).plane).toBe('green2')
})

for (const [channels, bayer] of [
	[3, undefined],
	[1, 'RGGB'],
] as const) {
	test(`detects${channels === 3 ? ' RGB' : ''}${bayer ? ' CFA' : ''} trails in received-image coordinates without mutating input`, () => {
		const frame = image(new Float32Array(128 * 96 * channels).fill(0.1), 128, 96, channels, bayer)
		renderSyntheticStreak(frame, { start: { x: 15, y: 20 }, end: { x: 112, y: 76 }, width: 4, intensity: 0.8 })
		const before = frame.raw.slice()
		const streaks = detectStreaks(frame, { minLength: 50, maxWidth: 10, backgroundCellSize: 24 })
		expect(frame.raw).toEqual(before)
		expect(streaks.length).toBeGreaterThan(0)
		expect(Math.abs(streaks[0].center.x - 63.5)).toBeLessThanOrEqual(3.1)
		expect(Math.abs(streaks[0].center.y - 48)).toBeLessThanOrEqual(3)
		expect(streaks[0].length).toBeGreaterThan(100)
	}, 2000)
}

for (let index = 0; index < CFA_PATTERNS.length; index++) {
	const bayer = CFA_PATTERNS[index]
	const left = index & 1
	const top = (index >> 1) & 1
	test(`detects ${bayer} through ROI parity ${left},${top} in received-image coordinates`, () => {
		const frame = image(new Float32Array(128 * 96).fill(0.1), 128, 96, 1, bayer)
		renderSyntheticStreak(frame, { start: { x: 14, y: 18 }, end: { x: 114, y: 78 }, width: 4, intensity: 0.8 })
		const streaks = detectStreaks(frame, { area: { left, top, right: 127, bottom: 95 }, minLength: 50, maxWidth: 10, backgroundCellSize: 24 })
		expect(streaks.length).toBeGreaterThan(0)
		expect(Math.abs(streaks[0].center.x - 64)).toBeLessThanOrEqual(4)
		expect(Math.abs(streaks[0].center.y - 48)).toBeLessThanOrEqual(4)
		expect(streaks[0].length).toBeGreaterThan(105)
	})
}
