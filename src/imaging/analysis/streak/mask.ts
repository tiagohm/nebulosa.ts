import type { Streak } from './types'

// Binary rejection mask for measured streaks. Each masked pixel is the integer center of a
// received-image pixel whose distance to a segment is within the streak's transverse radius.
// Painting walks the dominant axis and tests only that column or row's capsule span, so a long
// diagonal costs about its length times its mask width. The mask is allocated fresh, clips to
// the frame, and does not read or modify pixel samples.

// Detection-quality cutoff used only when `includeLowConfidence` is false.
// This is the detector's `Streak.confidence`, not a classification probability.
export const STREAK_MASK_LOW_CONFIDENCE = 0.5
// Largest accepted mask, in pixels. Larger products are rejected before allocation.
const MAX_STREAK_MASK_PIXELS = 268435456
// Extra pixels around the analytic capsule. Rounding in the span must not drop a center that
// the distance test would keep; the distance test still rejects every center outside the radius.
const CAPSULE_SPAN_SLACK = 1

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
// The scan axis is whichever endpoint delta is larger. A zero-length streak is a disk.
// Pixels already set by an earlier streak stay set and are not counted again.
function paintStreak(raw: Uint8Array, width: number, height: number, streak: Streak, radius: number): number {
	if (!(radius > 0)) return 0
	const dx = streak.end.x - streak.start.x
	const dy = streak.end.y - streak.start.y
	return paintAlongDominant(raw, width, height, streak, radius, Math.abs(dx) >= Math.abs(dy))
}

// Walks integer positions on the dominant axis and fills the transverse capsule interval.
// `alongX` is true when the segment runs at least as far in x as in y, including a point streak.
// `radius` is in received-image pixels. A center is written only when its distance to the closed
// segment is within that radius, so the span is a superset and the predicate stays exact.
function paintAlongDominant(raw: Uint8Array, width: number, height: number, streak: Streak, radius: number, alongX: boolean): number {
	const ax = alongX ? streak.start.x : streak.start.y
	const ay = alongX ? streak.start.y : streak.start.x
	const bx = alongX ? streak.end.x : streak.end.y
	const by = alongX ? streak.end.y : streak.end.x
	const majorCount = alongX ? width : height
	const minorCount = alongX ? height : width
	const first = Math.max(0, Math.floor(Math.min(ax, bx) - radius))
	const last = Math.min(majorCount - 1, Math.ceil(Math.max(ax, bx) + radius))
	let added = 0

	for (let major = first; major <= last; major++) {
		const span = capsuleSpan(major, ax, ay, bx, by, radius)
		if (!span) continue
		const minorStart = Math.max(0, Math.floor(span[0]))
		const minorEnd = Math.min(minorCount - 1, Math.ceil(span[1]))
		for (let minor = minorStart; minor <= minorEnd; minor++) {
			const x = alongX ? major : minor
			const y = alongX ? minor : major
			const index = y * width + x
			if (raw[index] === 1 || distanceToSegment(x, y, streak) > radius) continue
			raw[index] = 1
			added++
		}
	}

	return added
}

// Transverse bounds of a capsule superset on the line whose dominant coordinate is `major`.
// Endpoint coordinates are in that frame, in received-image pixels: dominant first, then transverse.
// The body is the infinite strip of radius `radius` wherever the line can meet the segment, union the
// endpoint disks. Bounds are expanded by `CAPSULE_SPAN_SLACK` pixels. Undefined means the line misses.
function capsuleSpan(major: number, ax: number, ay: number, bx: number, by: number, radius: number): readonly [number, number] | undefined {
	const dx = bx - ax
	const dy = by - ay
	const lengthSquared = dx * dx + dy * dy
	let span = mergeSpan(diskSpan(major, ax, ay, radius), diskSpan(major, bx, by, radius))

	// The caller scans the longer endpoint delta, so a positive length has a non-zero dominant component.
	if (lengthSquared > 0 && dx !== 0) {
		const length = Math.sqrt(lengthSquared)
		const bodyReach = (radius * Math.abs(dy)) / length + CAPSULE_SPAN_SLACK
		const minMajor = Math.min(ax, bx)
		const maxMajor = Math.max(ax, bx)
		if (major >= minMajor - bodyReach && major <= maxMajor + bodyReach) {
			const transverse = ay + ((major - ax) * dy) / dx
			const half = (radius * length) / Math.abs(dx)
			span = mergeSpan(span, [transverse - half, transverse + half])
		}
	}

	if (!span) return undefined
	return [span[0] - CAPSULE_SPAN_SLACK, span[1] + CAPSULE_SPAN_SLACK]
}

// Closed interval of a disk on the transverse axis, or undefined when `major` misses the disk.
// `centerMajor` and `centerMinor` are the disk center in the dominant frame, in pixels.
function diskSpan(major: number, centerMajor: number, centerMinor: number, radius: number): readonly [number, number] | undefined {
	const offset = major - centerMajor
	const reach = radius * radius - offset * offset
	if (!(reach >= 0)) return undefined
	const half = Math.sqrt(reach)
	return [centerMinor - half, centerMinor + half]
}

// Union of two closed intervals. Either side may be absent.
function mergeSpan(current: readonly [number, number] | undefined, next: readonly [number, number] | undefined): readonly [number, number] | undefined {
	if (!next) return current
	if (!current) return next
	return [Math.min(current[0], next[0]), Math.max(current[1], next[1])]
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
