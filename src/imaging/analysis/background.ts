import { medianAbsoluteDeviationOf, medianBySelectionOf } from '../../math/numerical/statistics'
import type { Image } from '../model/types'

// Robust global background of one image. The frame is split into a grid of at most 8 by 8 cells.
// Each cell contributes its median, the background is the median of those cell medians, and the noise
// is the normalized MAD of the sampled pixels about that background. The signal-to-noise ratio is the
// brightest cell's excess over the background, in units of that noise. At most 4096 pixels are
// sampled. Color frames use BT.709 luminance. A Bayer mosaic is sampled as raw photosite values.

// Largest number of pixels retained for the median and the MAD.
const MAX_BACKGROUND_SAMPLES = 4096
// Largest number of cells along one axis.
const MAX_BACKGROUND_CELLS = 8

// Robust sky level of one image.
export interface BackgroundEstimate {
	// Median of the cell medians, in the image's sample scale.
	readonly background: number
	// Normalized MAD of the sampled pixels about `background`. Zero when the samples do not scatter.
	readonly noise: number
	// Brightest cell median minus the background, divided by the noise. Zero when that excess is not
	// positive. +Infinity when the excess is positive and the noise is zero.
	readonly snr: number
}

// BT.709 luminance of one interleaved pixel, or the raw value of a single-channel pixel.
function luminance(raw: Image['raw'], index: number, channels: number) {
	if (channels === 1) return raw[index] ?? Number.NaN
	const red = raw[index] ?? Number.NaN
	const green = raw[index + 1] ?? Number.NaN
	const blue = raw[index + 2] ?? Number.NaN
	return 0.2125 * red + 0.7154 * green + 0.0721 * blue
}

// Estimates a robust background, its noise, and the brightest cell's signal-to-noise ratio.
// Parameters: image is the frame. An empty frame returns zeros. The grid tracks the image when the
// image is smaller than 8 by 8, so a tiny frame is estimated from all of its finite pixels.
export function estimateBackground(image: Image): BackgroundEstimate {
	const { raw, metadata } = image
	const { width, height, channels, stride } = metadata
	if (!(width > 0) || !(height > 0)) return { background: 0, noise: 0, snr: 0 }

	const columns = Math.min(MAX_BACKGROUND_CELLS, width)
	const rows = Math.min(MAX_BACKGROUND_CELLS, height)
	const cellCount = columns * rows
	const perCell = Math.max(1, Math.floor(MAX_BACKGROUND_SAMPLES / cellCount))
	const cellValues = new Float64Array(perCell)
	const cellMedians = new Float64Array(cellCount)
	const samples = new Float64Array(MAX_BACKGROUND_SAMPLES)
	let usedCells = 0
	let sampleCount = 0
	let brightest = Number.NEGATIVE_INFINITY

	for (let row = 0; row < rows; row++) {
		const y0 = Math.floor((row * height) / rows)
		const y1 = Math.floor(((row + 1) * height) / rows)

		for (let column = 0; column < columns; column++) {
			const x0 = Math.floor((column * width) / columns)
			const x1 = Math.floor(((column + 1) * width) / columns)
			const cellWidth = x1 - x0
			const cellHeight = y1 - y0
			const area = cellWidth * cellHeight
			if (!(area > 0)) continue

			const step = Math.max(1, Math.floor(Math.sqrt(area / perCell)))
			let count = 0

			for (let y = y0; y < y1 && count < perCell; y += step) {
				for (let x = x0; x < x1 && count < perCell; x += step) {
					const value = luminance(raw, y * stride + x * channels, channels)
					if (!Number.isFinite(value)) continue
					cellValues[count++] = value
					if (sampleCount < samples.length) samples[sampleCount++] = value
				}
			}

			if (count === 0) continue

			const median = medianBySelectionOf(cellValues, count)
			cellMedians[usedCells++] = median
			if (median > brightest) brightest = median
		}
	}

	if (usedCells === 0 || sampleCount === 0) return { background: 0, noise: 0, snr: 0 }
	const background = medianBySelectionOf(cellMedians, usedCells)
	const noise = medianAbsoluteDeviationOf(samples, background, true, sampleCount)
	const excess = brightest - background
	const finiteNoise = Number.isFinite(noise) ? noise : 0
	const snr = finiteNoise > 0 ? excess / finiteNoise : excess > 0 ? Number.POSITIVE_INFINITY : 0
	return { background, noise: finiteNoise, snr }
}
