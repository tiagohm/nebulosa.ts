import { clamp } from '../../math/numerical/math'
import { grayscaleFromChannel, type Image, type ImageChannelOrGray } from '../model/types'

// In-place tonal adjustments on the normalized [0, 1] raw buffer: brightness, saturation, linear
// (slope/intercept), contrast, and gamma, each clamping the result to the valid range.

// Apply brightness adjustment to image.
export function brightness(image: Image, value: number) {
	if (value >= 0 && value !== 1) {
		const { raw } = image
		const n = raw.length

		for (let i = 0; i < n; i++) {
			raw[i] = Math.min(1, raw[i] * value)
		}
	}

	return image
}

// Apply saturation adjustment to image.
export function saturation(image: Image, value: number, channel: ImageChannelOrGray = 'GRAY') {
	if (value >= 0 && value !== 1 && image.metadata.channels === 3) {
		const { raw } = image
		const { red, green, blue } = grayscaleFromChannel(channel)
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
	}

	return image
}

// Apply linear transformation to image.
export function linear(image: Image, slope: number, intercept: number) {
	if (slope !== 1 || intercept !== 0) {
		const { raw } = image
		const n = raw.length

		for (let i = 0; i < n; i++) {
			raw[i] = Math.max(0, Math.min(1, raw[i] * slope + intercept))
		}
	}

	return image
}

// Apply contrast adjustment to image.
export function contrast(image: Image, value: number) {
	return linear(image, value, 0.5 - 0.5 * value)
}

// Apply gamma correction to image. value between 1.0 and 3.0.
export function gamma(image: Image, value: number) {
	if (value > 1 && value <= 3) {
		const inv = 1 / value
		const { raw } = image
		const n = raw.length

		for (let i = 0; i < n; i++) {
			raw[i] = raw[i] ** inv
		}
	}

	return image
}
