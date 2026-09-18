import { expect, test } from 'bun:test'
import { PI } from '../../../../src/core/constants'
import { detectStreaks } from '../../../../src/imaging/analysis/streak/detector'
import { streakAxialAngleDistance } from '../../../../src/imaging/analysis/streak/geometry'
import type { Image } from '../../../../src/imaging/model/types'
import { renderSyntheticStreak } from '../../../../src/imaging/synthetic/streak'

function image(width: number, height: number, background: number = 0.1): Image {
	const raw = new Float32Array(width * height).fill(background)
	return { raw, header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

function addStar(frame: Image, centerX: number, centerY: number, sigma: number, intensity: number): void {
	const radius = Math.ceil(4 * sigma)
	for (let y = Math.max(0, Math.floor(centerY - radius)); y <= Math.min(frame.metadata.height - 1, Math.ceil(centerY + radius)); y++) {
		for (let x = Math.max(0, Math.floor(centerX - radius)); x <= Math.min(frame.metadata.width - 1, Math.ceil(centerX + radius)); x++) frame.raw[y * frame.metadata.width + x] += intensity * Math.exp(-((x - centerX) ** 2 + (y - centerY) ** 2) / (2 * sigma * sigma))
	}
}

test('does not systematically detect stars, isolated hot pixels, or smooth gradients', () => {
	const frame = image(160, 128)
	for (let y = 0; y < 128; y++) for (let x = 0; x < 160; x++) frame.raw[y * 160 + x] += x * 0.0005 + y * 0.0002
	expect(detectStreaks(frame, { minLength: 20, maxWidth: 8, backgroundCellSize: 32 })).toEqual([])
	frame.raw[10 * 160 + 10] = 2
	expect(detectStreaks(frame, { minLength: 20, maxWidth: 8, backgroundCellSize: 32 })).toEqual([])
	let state = 0x9e3779b9
	for (let index = 0; index < 40; index++) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const x = 8 + ((state >>> 0) % 144)
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const y = 8 + ((state >>> 0) % 112)
		addStar(frame, x, y, 1.2, 0.3 + (index % 5) * 0.08)
	}
	const detections = detectStreaks(frame, { minLength: 20, maxWidth: 8, backgroundCellSize: 32 })
	expect(detections.every((streak) => streak.length < 80)).toBeTrue()
	for (const streak of detections) expect(detections.filter((candidate) => streakAxialAngleDistance(streak.angle, candidate.angle) < PI / 90).length).toBeLessThanOrEqual(3)
})

test('keeps geometry stable through a bright crossing star and invalid samples', () => {
	const frame = image(192, 128)
	renderSyntheticStreak(frame, { start: { x: 15.25, y: 72.5 }, end: { x: 175.5, y: 54.25 }, width: 3, intensity: 0.35 })
	addStar(frame, 96, 63, 2, 2)
	for (let x = 70; x < 75; x++) frame.raw[64 * 192 + x] = Number.NaN
	const streaks = detectStreaks(frame, { minLength: 80, maxWidth: 8, backgroundCellSize: 32 })
	expect(streaks.length).toBe(1)
	expect(streakAxialAngleDistance(streaks[0].angle, Math.atan2(54.25 - 72.5, 175.5 - 15.25))).toBeLessThan(PI / 60)
	expect(streaks[0].center.x).toBeCloseTo((15.25 + 175.5) / 2, 0)
})

test('reports known saturation but leaves it absent when unknown', () => {
	const known = image(128, 96)
	renderSyntheticStreak(known, { start: { x: 12, y: 48 }, end: { x: 116, y: 48 }, width: 3, intensity: 2, saturationLevel: 1 })
	const saturated = detectStreaks(known, { minLength: 40, maxWidth: 8, saturationLevel: 1, backgroundCellSize: 32 })
	expect(saturated.length).toBe(1)
	expect(saturated[0].saturationFraction).toBeGreaterThan(0)
	const unknown = image(128, 96)
	renderSyntheticStreak(unknown, { start: { x: 12, y: 48 }, end: { x: 116, y: 48 }, width: 3, intensity: 2, saturationLevel: 1 })
	expect(detectStreaks(unknown, { minLength: 40, maxWidth: 8, backgroundCellSize: 32 })[0].saturationFraction).toBeUndefined()
})

test('detects a long low-surface-brightness segmented trail in deterministic noise', () => {
	const frame = image(256, 128)
	let state = 0x12345678
	for (let index = 0; index < frame.raw.length; index++) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		frame.raw[index] += ((state >>> 0) / 0x1_0000_0000 - 0.5) * 0.02
	}
	renderSyntheticStreak(frame, {
		start: { x: 15, y: 30 },
		end: { x: 240, y: 100 },
		width: 3,
		intensity: 0.055,
		profile: {
			type: 'segments',
			intervals: [
				{ start: 0, end: 0.46 },
				{ start: 0.5, end: 1 },
			],
		},
	})
	const streaks = detectStreaks(frame, { minLength: 120, maxWidth: 8, thresholdSigma: 2, gradientSigma: 1, mergeGap: 16, backgroundCellSize: 32 })
	expect(streaks.length).toBeGreaterThan(0)
	expect(streaks[0].length).toBeGreaterThan(200)
})
