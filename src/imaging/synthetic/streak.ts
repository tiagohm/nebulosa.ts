import type { Point } from '../../math/numerical/geometry'
import type { Image } from '../model/types'

// Deterministic analytic rasterizer for synthetic straight astronomical trails. Pixel-center distance
// to a finite segment drives a Gaussian transverse profile; intensity is peak additive image signal.

// One active normalized interval of a segmented longitudinal profile.
export interface SyntheticStreakInterval {
	// Inclusive normalized segment position in [0, 1].
	readonly start: number
	// Inclusive normalized segment position in [0, 1], not less than start.
	readonly end: number
	// Relative peak multiplier within the interval; defaults to one.
	readonly intensity?: number
}

// Longitudinal peak-intensity modulation evaluated along the finite segment.
export type SyntheticStreakProfile = { readonly type: 'constant' } | { readonly type: 'linear'; readonly start: number; readonly end: number } | { readonly type: 'gaussian'; readonly center: number; readonly sigma: number } | { readonly type: 'segments'; readonly intervals: readonly SyntheticStreakInterval[] }

// Analytic trail specification in received-image pixel coordinates.
export interface SyntheticStreak {
	// First subpixel endpoint in received-image pixels.
	readonly start: Readonly<Point>
	// Second subpixel endpoint in received-image pixels.
	readonly end: Readonly<Point>
	// Gaussian transverse FWHM in received-image pixels; must be positive.
	readonly width: number
	// Peak centerline signal added to each native channel, in image units.
	readonly intensity: number
	// Optional longitudinal multiplier; constant one is the default.
	readonly profile?: SyntheticStreakProfile
	// Optional upper clamp applied after addition, in image units.
	readonly saturationLevel?: number
}

// Adds one finite Gaussian-profile trail to mono, RGB, or CFA raw samples in place.
export function renderSyntheticStreak(image: Image, streak: Readonly<SyntheticStreak>): void {
	const { width, height, channels, stride, pixelCount } = image.metadata
	if ((channels !== 1 && channels !== 3) || pixelCount !== width * height || stride !== width * channels || image.raw.length < stride * height) throw new RangeError('synthetic streak image has inconsistent mono/RGB/CFA layout')
	const dx = streak.end.x - streak.start.x
	const dy = streak.end.y - streak.start.y
	const squaredLength = dx * dx + dy * dy
	if (!(squaredLength > 0)) return
	const sigma = streak.width / (2 * Math.sqrt(2 * Math.log(2)))
	const radius = Math.max(1, Math.ceil(4 * sigma))
	const left = Math.max(0, Math.floor(Math.min(streak.start.x, streak.end.x) - radius))
	const right = Math.min(width - 1, Math.ceil(Math.max(streak.start.x, streak.end.x) + radius))
	const top = Math.max(0, Math.floor(Math.min(streak.start.y, streak.end.y) - radius))
	const bottom = Math.min(height - 1, Math.ceil(Math.max(streak.start.y, streak.end.y) + radius))
	const inverseGaussianScale = 1 / (2 * sigma * sigma)
	for (let y = top; y <= bottom; y++) {
		for (let x = left; x <= right; x++) {
			const longitudinal = Math.max(0, Math.min(1, ((x - streak.start.x) * dx + (y - streak.start.y) * dy) / squaredLength))
			const closestX = streak.start.x + longitudinal * dx
			const closestY = streak.start.y + longitudinal * dy
			const distanceSquared = (x - closestX) ** 2 + (y - closestY) ** 2
			const multiplier = syntheticStreakProfileValue(streak.profile, longitudinal)
			const signal = streak.intensity * multiplier * Math.exp(-distanceSquared * inverseGaussianScale)
			if (!(signal > 0)) continue
			let raw = y * stride + x * channels
			for (let channel = 0; channel < channels; channel++, raw++) {
				const value = image.raw[raw] + signal
				image.raw[raw] = streak.saturationLevel === undefined ? value : Math.min(streak.saturationLevel, value)
			}
		}
	}
}

// Evaluates a longitudinal profile at a normalized segment position.
function syntheticStreakProfileValue(profile: SyntheticStreakProfile | undefined, position: number): number {
	if (profile === undefined || profile.type === 'constant') return 1
	if (profile.type === 'linear') return Math.max(0, profile.start + (profile.end - profile.start) * position)
	if (profile.type === 'gaussian') return profile.sigma > 0 ? Math.exp(-0.5 * ((position - profile.center) / profile.sigma) ** 2) : 0
	let multiplier = 0
	for (let index = 0; index < profile.intervals.length; index++) {
		const interval = profile.intervals[index]
		if (position >= interval.start && position <= interval.end) multiplier = Math.max(multiplier, interval.intensity ?? 1)
	}
	return Math.max(0, multiplier)
}
