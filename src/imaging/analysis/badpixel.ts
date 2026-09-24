import { medianBySelectionOf } from '../../math/numerical/statistics'
import { grayscaleFromChannel, type Grayscale, type Image, type ImageChannelOrGray } from '../model/types'
import { estimateBackground } from './background'

// Single-frame hot and cold pixel mask. Each pixel is compared with the median of its neighborhood,
// and the threshold is a multiple of the frame's robust noise from estimateBackground. A pixel is
// kept only when it is isolated: no neighbor reaches halfway from the local median to the pixel, which
// is what separates a one-pixel defect from a star. The mask is reusable and the image is not modified.
// Color frames are judged on BT.709 luminance. A Bayer mosaic is judged per color phase so neighboring
// photosites of another color are not treated as defects.

// Mask value of a hot pixel.
export const BAD_PIXEL_HOT = 1
// Mask value of a cold pixel.
export const BAD_PIXEL_COLD = 2

// Controls for one detection pass.
export interface BadPixelOptions {
	// Hot pixels must exceed the local median by this many noise sigmas. Zero disables hot detection.
	// Defaults to 5.
	readonly hotSigma?: number
	// Cold pixels must fall below the local median by this many noise sigmas. Zero disables cold
	// detection. Defaults to 5.
	readonly coldSigma?: number
	// Neighborhood radius in pixels of the same phase. Defaults to 1.
	readonly radius?: number
	// Channel or grayscale weighting to compute the luminance of one pixel.
	readonly channel?: ImageChannelOrGray
}

// Reusable defect mask for one frame.
export interface BadPixelMap {
	// Row-major mask, length width times height. 0 is clean, BAD_PIXEL_HOT is hot, BAD_PIXEL_COLD is cold.
	readonly mask: Uint8Array
	// Number of hot pixels.
	readonly hot: number
	// Number of cold pixels.
	readonly cold: number
}

// Luminance of one pixel, matching the background estimator.
function luminance(raw: Image['raw'], index: number, channels: number, grayscale: Grayscale) {
	if (channels === 1) return raw[index]
	return grayscale.red * raw[index] + grayscale.green * raw[index + 1] + grayscale.blue * raw[index + 2]
}

// Phase step. A Bayer frame steps by two photosites so each pass stays on one color.
function phaseStep(image: Image) {
	return image.metadata.bayer === undefined ? 1 : 2
}

// Detects isolated hot and cold pixels and returns a mask.
// Parameters: image is the frame, and it is not modified. options sets the sigma thresholds and the
// neighborhood radius. A pixel needs at least four finite neighbors; corners of a radius-1 window are
// therefore left clean. Returns the mask and the two counts. A zero sigma disables that class. The
// noise is the robust frame noise, so a smooth gradient, which sits on its local median, is not flagged.
export function detectBadPixels(image: Image, options?: BadPixelOptions): BadPixelMap {
	const { raw, metadata } = image
	const { width, height, channels, stride } = metadata
	const mask = new Uint8Array(width * height)
	const hotSigma = options?.hotSigma ?? 5
	const coldSigma = options?.coldSigma ?? 5
	const radius = Math.max(1, Math.trunc(options?.radius ?? 1))
	const grayscale = grayscaleFromChannel(options?.channel)
	const step = phaseStep(image)
	const noise = estimateBackground(image).noise
	const values = new Float64Array((radius * 2 + 1) * (radius * 2 + 1))

	let hot = 0
	let cold = 0

	for (let originY = 0; originY < step; originY++) {
		for (let originX = 0; originX < step; originX++) {
			for (let y = originY; y < height; y += step) {
				for (let x = originX; x < width; x += step) {
					const value = luminance(raw, y * stride + x * channels, channels, grayscale)
					if (!Number.isFinite(value)) continue

					let count = 0
					let neighborExtremeHot = Number.NEGATIVE_INFINITY
					let neighborExtremeCold = Number.POSITIVE_INFINITY

					for (let dy = -radius; dy <= radius; dy++) {
						const ny = y + dy * step
						if (ny < 0 || ny >= height) continue

						for (let dx = -radius; dx <= radius; dx++) {
							if (dx === 0 && dy === 0) continue
							const nx = x + dx * step
							if (nx < 0 || nx >= width) continue
							const neighbor = luminance(raw, ny * stride + nx * channels, channels, grayscale)
							if (!Number.isFinite(neighbor)) continue
							values[count++] = neighbor
							if (neighbor > neighborExtremeHot) neighborExtremeHot = neighbor
							if (neighbor < neighborExtremeCold) neighborExtremeCold = neighbor
						}
					}

					if (count < 4) continue

					const median = medianBySelectionOf(values, count)
					const index = y * width + x

					if (hotSigma > 0 && value > median + hotSigma * noise) {
						const halfway = median + 0.5 * (value - median)

						if (!(neighborExtremeHot > halfway)) {
							mask[index] = BAD_PIXEL_HOT
							hot++
							continue
						}
					}

					if (coldSigma > 0 && value < median - coldSigma * noise) {
						const halfway = median + 0.5 * (value - median)

						if (!(neighborExtremeCold < halfway)) {
							mask[index] = BAD_PIXEL_COLD
							cold++
						}
					}
				}
			}
		}
	}

	return { mask, hot, cold }
}
