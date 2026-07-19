import { validateInRange } from '../../core/validation'
import type { Image, ImageChannel, ImageRawType } from '../model/types'

// Subtractive Chromatic Noise Reduction (SCNR): attenuates a selected color cast in dense RGB
// images using a selectable protection method. Processing is in place on normalized [0,1] samples.

// Highlight and color-cast protection method used by SCNR.
export type SCNRProtectionMethod = 'MAXIMUM_MASK' | 'ADDITIVE_MASK' | 'AVERAGE_NEUTRAL' | 'MAXIMUM_NEUTRAL' | 'MINIMUM_NEUTRAL'

// Verifies the dense mono or interleaved RGB layout required by SCNR.
function validateSCNRImage(image: Image) {
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

// Applies maximum-mask attenuation to the selected interleaved channel.
function applyMaximumMask(raw: ImageRawType, p0: number, p1: number, p2: number, amount: number) {
	const remaining = 1 - amount
	for (let i = 0; i < raw.length; i += 3) {
		const k = i + p0
		const a = raw[k]
		const m = Math.max(raw[i + p1], raw[i + p2])
		raw[k] = a * remaining * (1 - m) + m * a
	}
}

// Applies additive-mask attenuation to the selected interleaved channel.
function applyAdditiveMask(raw: ImageRawType, p0: number, p1: number, p2: number, amount: number) {
	const remaining = 1 - amount
	for (let i = 0; i < raw.length; i += 3) {
		const k = i + p0
		const a = raw[k]
		const m = Math.min(1, raw[i + p1] + raw[i + p2])
		raw[k] = a * remaining * (1 - m) + m * a
	}
}

// Blends dominant selected samples toward the mean of the other two channels.
function applyAverageNeutral(raw: ImageRawType, p0: number, p1: number, p2: number, amount: number) {
	const remaining = 1 - amount
	for (let i = 0; i < raw.length; i += 3) {
		const k = i + p0
		const a = raw[k]
		const m = 0.5 * (raw[i + p1] + raw[i + p2])
		if (a > m) raw[k] = a * remaining + m * amount
	}
}

// Blends dominant selected samples toward the brighter of the other two channels.
function applyMaximumNeutral(raw: ImageRawType, p0: number, p1: number, p2: number, amount: number) {
	const remaining = 1 - amount
	for (let i = 0; i < raw.length; i += 3) {
		const k = i + p0
		const a = raw[k]
		const m = Math.max(raw[i + p1], raw[i + p2])
		if (a > m) raw[k] = a * remaining + m * amount
	}
}

// Blends dominant selected samples toward the dimmer of the other two channels.
function applyMinimumNeutral(raw: ImageRawType, p0: number, p1: number, p2: number, amount: number) {
	const remaining = 1 - amount
	for (let i = 0; i < raw.length; i += 3) {
		const k = i + p0
		const a = raw[k]
		const m = Math.min(raw[i + p1], raw[i + p2])
		if (a > m) raw[k] = a * remaining + m * amount
	}
}

// Applies SCNR in place to one selected RGB channel with an intensity in [0,1]. Monochrome and CFA
// images are validated no-ops. The returned image is the same object supplied by the caller.
export function scnr(image: Image, channel: ImageChannel = 'GREEN', amount: number = 0.5, method: SCNRProtectionMethod = 'MAXIMUM_MASK') {
	validateInRange(amount, 0, 1)
	validateSCNRImage(image)

	let p0: number
	let p1: number
	let p2: number

	switch (channel) {
		case 'RED':
			p0 = 0
			p1 = 1
			p2 = 2
			break
		case 'GREEN':
		default:
			p0 = 1
			p1 = 2
			p2 = 0
			break
		case 'BLUE':
			p0 = 2
			p1 = 0
			p2 = 1
			break
	}

	if (image.metadata.channels === 1 || amount === 0) return image

	const { raw } = image

	// Dispatch once to a compact specialized loop so the JIT can optimize the per-pixel kernel.
	switch (method) {
		case 'ADDITIVE_MASK':
		default:
			applyAdditiveMask(raw, p0, p1, p2, amount)
			break
		case 'MAXIMUM_MASK':
			applyMaximumMask(raw, p0, p1, p2, amount)
			break
		case 'AVERAGE_NEUTRAL':
			applyAverageNeutral(raw, p0, p1, p2, amount)
			break
		case 'MAXIMUM_NEUTRAL':
			applyMaximumNeutral(raw, p0, p1, p2, amount)
			break
		case 'MINIMUM_NEUTRAL':
			applyMinimumNeutral(raw, p0, p1, p2, amount)
			break
	}

	return image
}
