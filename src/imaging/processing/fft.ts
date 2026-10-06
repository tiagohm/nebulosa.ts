import { type FFT2DWorkspace, type FFTPlan, fftComplex2D, fftPaddedSize, fftPlan } from '../../math/numerical/fft'
import { clamp } from '../../math/numerical/math'
import type { Image } from '../model/types'

// Frequency-domain (FFT) radial band filtering of images: a reusable radix-2 workspace and a centered
// low-pass/high-pass Butterworth filter applied in place, with MaxIm-style range restoration for the
// low-pass output.

// FFT frequency-domain filter direction.
export type FFTFilterType = 'lowPass' | 'highPass'

// Cached radial frequency-domain mask, keyed by dimensions, cutoff, and filter type.
interface FFTMaskCache {
	width: number
	height: number
	cutoff: number
	filterType: FFTFilterType
	mask: Float64Array
}

// A fixed second-order Butterworth amplitude response gives a smooth halo roll-off without a near-hard cutoff ring.
const FFT_BUTTERWORTH_ORDER = 2
// Skip MaxIm-style range restoration when the low-pass output is nearly flat, to avoid stretching numerical residue into false texture.
const FFT_MIN_NORMALIZE_RANGE_RATIO = 1e-2

// Clamps padded coordinates to the nearest border pixel to avoid mirrored duplicate stars near image edges.
function fftPadIndex(index: number, size: number) {
	if (size <= 1) return 0
	return index < size ? index : size - 1
}

// Represents a reusable FFT buffers sized for the image dimensions.
export class FFTWorkspace implements FFT2DWorkspace {
	readonly width: number
	readonly height: number
	readonly real: Float64Array
	readonly imaginary: Float64Array
	readonly columnReal: Float64Array
	readonly columnImaginary: Float64Array
	readonly rowPlan: FFTPlan
	readonly columnPlan: FFTPlan

	#mask?: FFTMaskCache

	// Allocates reusable padded FFT buffers for the requested image size.
	constructor(width: number, height: number) {
		width = fftPaddedSize(width)
		height = fftPaddedSize(height)

		this.rowPlan = fftPlan(width)
		this.columnPlan = width === height ? this.rowPlan : fftPlan(height)

		const size = width * height
		const columnSize = Math.max(width, height)

		this.width = width
		this.height = height
		this.real = new Float64Array(size)
		this.imaginary = new Float64Array(size)
		this.columnReal = new Float64Array(columnSize)
		this.columnImaginary = new Float64Array(columnSize)
	}

	// Returns a cached radial mask for the current workspace dimensions.
	mask(filterType: FFTFilterType, cutoff: number) {
		if (this.#mask !== undefined && this.#mask.filterType === filterType && Math.abs(this.#mask.cutoff - cutoff) <= Number.EPSILON) {
			return this.#mask
		}

		this.#mask = fftMask(this.width, this.height, filterType, cutoff)

		return this.#mask
	}
}

// Computes the radial mask gain at normalized radius r for the selected FFT filter.
function fftMaskGain(filterType: FFTFilterType, cutoff: number, radius: number) {
	if (cutoff <= 0) {
		const lowPassGain = radius <= 0 ? 1 : 0
		return filterType === 'lowPass' ? lowPassGain : 1 - lowPassGain
	}

	if (cutoff >= 1) {
		return filterType === 'lowPass' ? 1 : 0
	}

	const radialCutoff2 = cutoff * cutoff
	const radius2 = radius * radius
	let cutoffPow = radialCutoff2
	let radiusPow = radius2

	// cutoff is the normalized -3 dB radius of a Butterworth amplitude mask, matching MaxIm DL's smooth roll-off style.
	for (let i = 1; i < FFT_BUTTERWORTH_ORDER; i++) {
		cutoffPow *= radialCutoff2
		radiusPow *= radius2
	}

	const denominator = cutoffPow + radiusPow
	const lowPassGain = Math.sqrt(cutoffPow / denominator)

	return filterType === 'lowPass' ? lowPassGain : Math.sqrt(radiusPow / denominator)
}

// Returns a cached centered radial mask for the padded FFT grid and slider state.
function fftMask(width: number, height: number, filterType: FFTFilterType, cutoff: number): FFTMaskCache {
	const mask = new Float64Array(width * height)
	const centerX = width >>> 1
	const centerY = height >>> 1
	const radiusScaleX = centerX > 0 ? 1 / centerX : 0
	const radiusScaleY = centerY > 0 ? 1 / centerY : 0

	if (centerX <= 0 && centerY <= 0) {
		mask[0] = filterType === 'lowPass' ? 1 : 0
	} else {
		for (let y = 0, i = 0; y < height; y++) {
			const dy = (y - centerY) * radiusScaleY
			const dy2 = dy * dy

			for (let x = 0; x < width; x++, i++) {
				const dx = (x - centerX) * radiusScaleX
				// r is normalized by each axis Nyquist radius so cutoff tracks MaxIm's percentage slider and stays circular on rectangular grids.
				const radius = Math.sqrt(dx * dx + dy2)

				mask[i] = fftMaskGain(filterType, cutoff, radius)
			}
		}
	}

	return { width, height, filterType, cutoff, mask }
}

// Loads one image channel into the centered FFT plane with replicated-edge power-of-two padding.
function fftLoadChannel(image: Image, channel: number, workspace: FFTWorkspace) {
	const { width, height, channels, stride } = image.metadata
	const { real, imaginary, width: fftWidth, height: fftHeight } = workspace
	const { raw } = image

	for (let y = 0, i = 0; y < fftHeight; y++) {
		const sy = fftPadIndex(y, height)
		const row = sy * stride + channel

		for (let x = 0; x < fftWidth; x++, i++) {
			const sx = fftPadIndex(x, width)
			const pixel = raw[row + sx * channels]
			const value = Number.isFinite(pixel) ? pixel : 0

			// Multiplication by (-1)^(x+y) centers the DC component before masking.
			real[i] = ((x + y) & 1) === 0 ? value : -value
			imaginary[i] = 0
		}
	}
}

// Restores one low-pass output channel to the original channel dynamic range used by MaxIm DL.
function fftNormalizeChannel(image: Image, channel: number, inputMin: number, inputMax: number, outputMin: number, outputMax: number) {
	const inputRange = inputMax - inputMin
	const outputRange = outputMax - outputMin
	if (!(inputRange > 0) || !(outputRange > 0)) return
	if (outputRange <= inputRange * FFT_MIN_NORMALIZE_RANGE_RATIO) return

	const { width, height, channels, stride } = image.metadata
	const { raw } = image
	const scale = inputRange / outputRange

	for (let y = 0; y < height; y++) {
		let oi = y * stride + channel

		for (let x = 0; x < width; x++, oi += channels) {
			raw[oi] = inputMin + (raw[oi] - outputMin) * scale
		}
	}
}

// Stores the inverse FFT plane back into one image channel, applies the weight blend in place, and returns channel ranges.
function fftStoreChannel(image: Image, channel: number, workspace: FFTWorkspace, weight: number) {
	const { width, height, channels, stride } = image.metadata
	const { real, width: fftWidth } = workspace
	const { raw } = image
	const originalWeight = 1 - weight
	let inputMin = Number.POSITIVE_INFINITY
	let inputMax = Number.NEGATIVE_INFINITY
	let outputMin = Number.POSITIVE_INFINITY
	let outputMax = Number.NEGATIVE_INFINITY

	for (let y = 0; y < height; y++) {
		let ii = y * fftWidth
		let oi = y * stride + channel

		for (let x = 0; x < width; x++, ii++, oi += channels) {
			const original = Number.isFinite(raw[oi]) ? raw[oi] : 0
			const unshifted = ((x + y) & 1) === 0 ? real[ii] : -real[ii]
			const filtered = Number.isFinite(unshifted) ? unshifted : original

			// weight blends the original and fully filtered result without moving the cutoff radius.
			const output = originalWeight * original + weight * filtered
			raw[oi] = output

			if (original < inputMin) inputMin = original
			if (original > inputMax) inputMax = original
			if (output < outputMin) outputMin = output
			if (output > outputMax) outputMax = output
		}
	}

	return [inputMin, inputMax, outputMin, outputMax] as const
}

// Applies a centered radial FFT low-pass or high-pass filter in place.
export function fft(image: Image, workspace: FFTWorkspace, filterType: FFTFilterType = 'lowPass', cutoff?: number, weight: number = 1): Image {
	const { width, height, channels } = image.metadata
	const amount = clamp(weight, 0, 1)
	if (amount <= 0 || width <= 0 || height <= 0 || channels <= 0) return image
	if (!(workspace.width >= width) || !(workspace.height >= height)) throw new Error(`FFT workspace ${workspace.width}x${workspace.height} is smaller than image ${width}x${height}`)

	const threshold = clamp(cutoff ?? (filterType === 'lowPass' ? 1 : 0), 0, 1)
	const { mask } = workspace.mask(filterType, threshold)
	const { real, imaginary } = workspace

	for (let channel = 0; channel < channels; channel++) {
		fftLoadChannel(image, channel, workspace)
		fftComplex2D(workspace, false)

		for (let i = 0; i < mask.length; i++) {
			const gain = mask[i]

			real[i] *= gain
			imaginary[i] *= gain
		}

		fftComplex2D(workspace, true)
		const [inputMin, inputMax, outputMin, outputMax] = fftStoreChannel(image, channel, workspace, amount)
		if (filterType === 'lowPass') fftNormalizeChannel(image, channel, inputMin, inputMax, outputMin, outputMax)
	}

	return image
}
