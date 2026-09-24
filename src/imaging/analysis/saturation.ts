import type { Image } from '../model/types'

// Saturation of one frame: how many pixels reach the ceiling, how many supplied stars sit on a
// saturated pixel, and a mask of those pixels. A pixel counts as saturated when any of its channels
// is at or above the level. The default level is 1, the top of the normalized sample scale. The image
// is not modified.

// A star position in image pixels. Only the rounded pixel is tested.
export interface SaturationStar {
	// Horizontal centroid in pixels, origin at the left.
	readonly x: number
	// Vertical centroid in pixels, origin at the top.
	readonly y: number
}

// Controls for one saturation measurement.
export interface SaturationOptions {
	// Sample value at and above which a channel is saturated. Defaults to 1.
	readonly level?: number
	// Stars whose nearest pixel is tested for a saturated core.
	readonly stars?: readonly SaturationStar[]
}

// Saturation of one frame.
export interface SaturationAnalysis {
	// Number of pixels with at least one saturated channel.
	readonly saturatedPixels: number
	// Saturated pixels divided by the number of pixels. Zero for an empty frame.
	readonly fraction: number
	// Number of supplied stars whose nearest pixel is saturated.
	readonly saturatedStars: number
	// Row-major mask, length width times height. 1 marks a saturated pixel.
	readonly mask: Uint8Array
}

// Measures saturated pixels, saturated star cores, and the saturation mask.
// Parameters: image is the frame. options.level is the saturation ceiling and options.stars are the
// centroids to test. A star outside the frame is not saturated. Returns the counts, the fraction, and
// the mask.
export function analyzeSaturation(image: Image, options: SaturationOptions = {}): SaturationAnalysis {
	const { raw, metadata } = image
	const { width, height, channels, pixelCount, stride } = metadata
	const level = options.level ?? 1
	const mask = new Uint8Array(width * height)

	let saturatedPixels = 0

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const pixel = y * width + x
			const base = y * stride + x * channels

			let saturated = false

			for (let channel = 0; channel < channels; channel++) {
				const value = raw[base + channel]
				if (value !== undefined && value >= level) {
					saturated = true
					break
				}
			}

			if (!saturated) continue

			mask[pixel] = 1
			saturatedPixels++
		}
	}

	let saturatedStars = 0
	const stars = options.stars ?? []

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		if (star === undefined) continue
		const x = Math.round(star.x)
		const y = Math.round(star.y)
		if (x < 0 || y < 0 || x >= width || y >= height) continue
		if (mask[y * width + x] === 1) saturatedStars++
	}

	return { saturatedPixels, fraction: pixelCount > 0 ? saturatedPixels / pixelCount : 0, saturatedStars, mask }
}
