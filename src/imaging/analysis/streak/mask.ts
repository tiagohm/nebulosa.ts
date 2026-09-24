import type { Streak } from './types'

// Binary rejection mask for measured streaks. Each masked pixel is the integer center of a
// received-image pixel whose distance to a segment is within the streak's transverse radius.
// The mask is allocated fresh, clips to the frame, and does not read or modify pixel samples.

// Detection-quality cutoff used only when `includeLowConfidence` is false.
// This is the detector's `Streak.confidence`, not a classification probability.
export const STREAK_MASK_LOW_CONFIDENCE = 0.5
// Largest accepted mask, in pixels. Larger products are rejected before allocation.
const MAX_STREAK_MASK_PIXELS = 268435456

// Controls how far around each measured segment the mask extends.
export interface StreakMaskOptions {
	// Extra radius added after the scaled half-width, in received-image pixels.
	readonly dilation?: number
	// Multiplier applied to the measured full width before taking half of it as a radius.
	readonly widthScale?: number
	// When false, streaks whose detection confidence is below `STREAK_MASK_LOW_CONFIDENCE` are omitted.
	readonly includeLowConfidence?: boolean
}

// Row-major binary mask. Masked pixels are 1 and clear pixels are 0.
export interface StreakMask {
	// Mask width, in received-image pixels.
	readonly width: number
	// Mask height, in received-image pixels.
	readonly height: number
	// Row-major samples, index `y * width + x`.
	readonly raw: Uint8Array
	// Number of pixels whose value is 1. Overlapping streaks are counted once.
	readonly maskedPixels: number
	// `maskedPixels / (width * height)`.
	readonly maskedFraction: number
}

// Rasterizes every supplied segment into a new binary mask.
// The radius is `width * widthScale / 2 + dilation`. A non-positive radius masks nothing.
// Throws when the dimensions are not positive integers or their product would allocate an unbounded buffer.
export function createStreakMask(width: number, height: number, streaks: readonly Streak[], options: Readonly<StreakMaskOptions> = {}): StreakMask {
	// A non-finite or non-integral dimension would either loop forever or allocate a nonsensical buffer.
	if (!(Number.isSafeInteger(width) && width >= 1) || !(Number.isSafeInteger(height) && height >= 1) || !(Number.isSafeInteger(width * height) && width * height <= MAX_STREAK_MASK_PIXELS)) {
		throw new RangeError('streak mask dimensions must be positive integers whose product fits in one bounded buffer')
	}

	const raw = new Uint8Array(width * height)
	const widthScale = options.widthScale ?? 1
	const dilation = options.dilation ?? 0
	const includeLowConfidence = options.includeLowConfidence ?? true
	let maskedPixels = 0

	for (let index = 0; index < streaks.length; index++) {
		const streak = streaks[index]
		if (!includeLowConfidence && !(streak.confidence >= STREAK_MASK_LOW_CONFIDENCE)) continue
		maskedPixels += paintStreak(raw, width, height, streak, streak.width * 0.5 * widthScale + dilation)
	}

	return { width, height, raw, maskedPixels, maskedFraction: maskedPixels / (width * height) }
}

// Paints one capsule and returns how many previously clear pixels it sets.
function paintStreak(raw: Uint8Array, width: number, height: number, streak: Streak, radius: number): number {
	if (!(radius > 0)) return 0
	const minX = Math.min(streak.start.x, streak.end.x)
	const maxX = Math.max(streak.start.x, streak.end.x)
	const minY = Math.min(streak.start.y, streak.end.y)
	const maxY = Math.max(streak.start.y, streak.end.y)
	const left = Math.max(0, Math.floor(minX - radius))
	const top = Math.max(0, Math.floor(minY - radius))
	const right = Math.min(width - 1, Math.ceil(maxX + radius))
	const bottom = Math.min(height - 1, Math.ceil(maxY + radius))
	let added = 0

	for (let y = top; y <= bottom; y++) {
		const row = y * width
		for (let x = left; x <= right; x++) {
			const index = row + x
			if (raw[index] === 1 || distanceToSegment(x, y, streak) > radius) continue
			raw[index] = 1
			added++
		}
	}

	return added
}

// Euclidean distance from an integer pixel center to the closed segment, in pixels.
function distanceToSegment(x: number, y: number, streak: Streak): number {
	const dx = streak.end.x - streak.start.x
	const dy = streak.end.y - streak.start.y
	const lengthSquared = dx * dx + dy * dy
	if (!(lengthSquared > 0)) return Math.hypot(x - streak.start.x, y - streak.start.y)
	const projection = ((x - streak.start.x) * dx + (y - streak.start.y) * dy) / lengthSquared
	const clamped = Math.min(1, Math.max(0, projection))
	return Math.hypot(x - (streak.start.x + clamped * dx), y - (streak.start.y + clamped * dy))
}
