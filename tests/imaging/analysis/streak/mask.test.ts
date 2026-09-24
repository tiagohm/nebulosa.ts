import { expect, test } from 'bun:test'
import { normalizeStreakAngle } from '../../../../src/imaging/analysis/streak/geometry'
import { createStreakMask, STREAK_MASK_LOW_CONFIDENCE } from '../../../../src/imaging/analysis/streak/mask'
import type { Streak } from '../../../../src/imaging/analysis/streak/types'

function streak(startX: number, startY: number, endX: number, endY: number, overrides: Partial<Streak> = {}): Streak {
	const start = { x: startX, y: startY }
	const end = { x: endX, y: endY }
	const length = Math.hypot(endX - startX, endY - startY)
	return {
		start,
		end,
		center: { x: (startX + endX) / 2, y: (startY + endY) / 2 },
		length,
		width: 1,
		angle: normalizeStreakAngle(Math.atan2(endY - startY, endX - startX)),
		linearity: 0.99,
		rmsResidual: 0.1,
		coverage: 1,
		supportPixels: Math.max(1, Math.round(length)),
		clippedAtBorder: false,
		flux: 1,
		meanSignal: 0.2,
		peakSignal: 0.8,
		confidence: 0.9,
		...overrides,
	}
}

function maskedCount(raw: Uint8Array): number {
	let count = 0
	for (let index = 0; index < raw.length; index++) {
		expect(raw[index] === 0 || raw[index] === 1).toBeTrue()
		if (raw[index] === 1) count++
	}
	return count
}

test('rasterizes the measured width, dilation, and width scale', () => {
	const segment = streak(2, 5, 10, 5)
	const tight = createStreakMask(21, 11, [segment])
	expect(tight.maskedPixels).toBe(9)
	expect(tight.maskedFraction).toBeCloseTo(9 / (21 * 11), 12)
	expect(maskedCount(tight.raw)).toBe(9)
	expect(tight.raw[5 * 21 + 2]).toBe(1)
	expect(tight.raw[5 * 21 + 10]).toBe(1)
	expect(tight.raw[4 * 21 + 6]).toBe(0)

	const dilated = createStreakMask(21, 11, [segment], { dilation: 1 })
	expect(dilated.maskedPixels).toBe(33)
	expect(dilated.maskedPixels).toBeGreaterThan(tight.maskedPixels)
	const scaled = createStreakMask(21, 11, [segment], { widthScale: 3 })
	expect(scaled.maskedPixels).toBe(dilated.maskedPixels)
})

test('clips at the frame and counts overlapping streaks once', () => {
	const segment = streak(-3, 2, 2, 2)
	const clipped = createStreakMask(6, 5, [segment])
	expect(clipped.maskedPixels).toBe(3)
	expect(clipped.raw[2 * 6 + 0]).toBe(1)
	expect(clipped.raw[2 * 6 + 1]).toBe(1)
	expect(clipped.raw[2 * 6 + 2]).toBe(1)
	expect(clipped.raw[0]).toBe(0)
	expect(createStreakMask(6, 5, [segment, streak(-3, 2, 2, 2)]).maskedPixels).toBe(3)
	expect(createStreakMask(8, 8, [streak(-10, -10, -4, -4)]).maskedPixels).toBe(0)
})

// Independent of `paintStreak`. Same closed-segment distance the mask claims to rasterize.
function segmentDistance(x: number, y: number, sample: Streak): number {
	const dx = sample.end.x - sample.start.x
	const dy = sample.end.y - sample.start.y
	const lengthSquared = dx * dx + dy * dy
	if (!(lengthSquared > 0)) return Math.hypot(x - sample.start.x, y - sample.start.y)
	const projection = ((x - sample.start.x) * dx + (y - sample.start.y) * dy) / lengthSquared
	const clamped = Math.min(1, Math.max(0, projection))
	return Math.hypot(x - (sample.start.x + clamped * dx), y - (sample.start.y + clamped * dy))
}

function referenceMask(width: number, height: number, streaks: readonly Streak[], widthScale: number, dilation: number): Uint8Array {
	const raw = new Uint8Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (let index = 0; index < streaks.length; index++) {
				const sample = streaks[index]
				const radius = sample.width * 0.5 * widthScale + dilation
				if (!(radius > 0) || segmentDistance(x, y, sample) > radius) continue
				raw[y * width + x] = 1
				break
			}
		}
	}
	return raw
}

test('diagonal, vertical, point, and clipped capsules match the distance predicate', () => {
	const frameWidth = 64
	const frameHeight = 48
	const cases: readonly { readonly streaks: readonly Streak[]; readonly widthScale: number; readonly dilation: number }[] = [
		{ streaks: [streak(1.2, 2.4, 60.5, 44.8, { width: 2.5 })], widthScale: 1, dilation: 0 },
		{ streaks: [streak(58, 1.5, 3.2, 46, { width: 1.25 })], widthScale: 1.5, dilation: 1 },
		{ streaks: [streak(4, 1, 4, 46, { width: 2 })], widthScale: 1, dilation: 0 },
		{ streaks: [streak(7.5, 20, 7.5, 20, { width: 5 })], widthScale: 1, dilation: 0.5 },
		{ streaks: [streak(-6, -3, 18, 14, { width: 3 })], widthScale: 2, dilation: 0 },
		{ streaks: [streak(0.4, 40.2, 63, 6.5, { width: 0.8 }), streak(2, 2, 50, 40, { width: 1.5 })], widthScale: 1, dilation: 1 },
	]

	for (let index = 0; index < cases.length; index++) {
		const sample = cases[index]
		const mask = createStreakMask(frameWidth, frameHeight, sample.streaks, { widthScale: sample.widthScale, dilation: sample.dilation })
		const expected = referenceMask(frameWidth, frameHeight, sample.streaks, sample.widthScale, sample.dilation)
		expect(mask.raw).toEqual(expected)
		expect(mask.maskedPixels).toBe(maskedCount(expected))
	}

	const diagonal = createStreakMask(frameWidth, frameHeight, [streak(0, 0, frameWidth - 1, frameHeight - 1, { width: 1 })])
	expect(diagonal.maskedPixels).toBeGreaterThan(0)
	expect(diagonal.maskedPixels).toBeLessThan((frameWidth * frameHeight) / 8)
})

test('omits low detection confidence only when asked', () => {
	const faint = streak(2, 4, 8, 4, { confidence: STREAK_MASK_LOW_CONFIDENCE - 0.01 })
	const kept = streak(2, 4, 8, 4, { confidence: STREAK_MASK_LOW_CONFIDENCE })
	expect(createStreakMask(12, 9, [faint]).maskedPixels).toBeGreaterThan(0)
	expect(createStreakMask(12, 9, [faint], { includeLowConfidence: false }).maskedPixels).toBe(0)
	expect(createStreakMask(12, 9, [kept], { includeLowConfidence: false }).maskedPixels).toBeGreaterThan(0)
	const empty = createStreakMask(4, 3, [])
	expect(empty.maskedPixels).toBe(0)
	expect(empty.maskedFraction).toBe(0)
	expect(empty.raw.length).toBe(12)
})
