import { validateFinite, validateNonNegativeFinite, validatePositiveFinite } from '../../core/validation'
import { clamp } from '../../math/numerical/math'
import { grayscaleFromChannel, type Image, type ImageChannelOrGray } from '../model/types'

// In-place tonal adjustments on normalized images. Every transform validates its parameters and dense
// image layout, clamps output samples to [0,1], and returns the same image object.

// Absolute tolerance accepted when custom luminance weights are normalized from floating-point values.
const GRAYSCALE_WEIGHT_SUM_TOLERANCE = 1e-6

// Verifies the dense mono or interleaved RGB layout required by tonal transforms.
function validateToneImage(image: Image) {
	const { width, height, channels, pixelCount } = image.metadata
	if (!Number.isInteger(width) || width <= 0) throw new Error(`image width must be a positive integer: ${width}`)
	if (!Number.isInteger(height) || height <= 0) throw new Error(`image height must be a positive integer: ${height}`)
	if (channels !== 1 && channels !== 3) throw new Error(`image channels must be 1 or 3: ${channels}`)
	const expectedPixelCount = width * height
	if (pixelCount !== expectedPixelCount) throw new Error(`image pixelCount does not match geometry: ${pixelCount} != ${expectedPixelCount}`)
	const expectedLength = pixelCount * channels
	if (image.raw.length !== expectedLength) throw new Error(`image raw length does not match metadata: ${image.raw.length} != ${expectedLength}`)
	if (image.metadata.bayer && channels !== 1) throw new Error(`image CFA data must have one channel: ${channels}`)
}

// Verifies finite non-negative luminance weights normalized to unit sum.
function validateGrayscaleWeights(red: number, green: number, blue: number) {
	validateNonNegativeFinite(red)
	validateNonNegativeFinite(green)
	validateNonNegativeFinite(blue)
	const sum = red + green + blue
	if (Math.abs(sum - 1) > GRAYSCALE_WEIGHT_SUM_TOLERANCE) throw new RangeError(`grayscale weights must sum to one: ${sum}`)
}

// Multiplies brightness by a finite non-negative factor and clips the result to [0,1].
export function brightness(image: Image, value: number) {
	validateNonNegativeFinite(value)
	validateToneImage(image)
	if (value === 1) return image
	const { raw } = image
	if (value === 0) {
		raw.fill(0)
		return image
	}
	const n = raw.length
	for (let i = 0; i < n; i++) raw[i] = clamp(raw[i] * value, 0, 1)
	return image
}

// Scales RGB chroma around a validated luminance reference and clips each channel to [0,1].
export function saturation(image: Image, value: number, channel: ImageChannelOrGray = 'GRAY') {
	validateNonNegativeFinite(value)
	validateToneImage(image)
	if (image.metadata.channels !== 3) return image
	const { red, green, blue } = grayscaleFromChannel(channel)
	validateGrayscaleWeights(red, green, blue)
	if (value === 1) return image
	const { raw } = image
	const n = raw.length
	for (let i = 0; i < n; i += 3) {
		const r = raw[i]
		const g = raw[i + 1]
		const b = raw[i + 2]
		const gray = red * r + green * g + blue * b
		raw[i] = clamp(gray + (r - gray) * value, 0, 1)
		raw[i + 1] = clamp(gray + (g - gray) * value, 0, 1)
		raw[i + 2] = clamp(gray + (b - gray) * value, 0, 1)
	}
	return image
}

// Applies a finite slope and intercept to every sample and clips the result to [0,1].
export function linear(image: Image, slope: number, intercept: number) {
	validateFinite(slope)
	validateFinite(intercept)
	validateToneImage(image)
	if (slope === 1 && intercept === 0) return image
	const { raw } = image
	if (slope === 0) {
		raw.fill(clamp(intercept, 0, 1))
		return image
	}
	const n = raw.length
	for (let i = 0; i < n; i++) raw[i] = clamp(raw[i] * slope + intercept, 0, 1)
	return image
}

// Scales contrast around normalized mid-gray using a finite non-negative factor.
export function contrast(image: Image, value: number) {
	validateNonNegativeFinite(value)
	return linear(image, value, 0.5 - 0.5 * value)
}

// Applies inverse-gamma encoding for any finite positive gamma and clips input samples to [0,1].
export function gamma(image: Image, value: number) {
	validatePositiveFinite(value)
	validateToneImage(image)
	if (value === 1) return image
	const { raw } = image
	const n = raw.length
	if (value === 2) {
		for (let i = 0; i < n; i++) raw[i] = Math.sqrt(clamp(raw[i], 0, 1))
	} else {
		const inverse = 1 / value
		for (let i = 0; i < n; i++) raw[i] = clamp(raw[i], 0, 1) ** inverse
	}
	return image
}
