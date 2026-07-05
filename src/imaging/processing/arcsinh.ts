import { clamp } from '../../math/numerical/math'
import { BT709_GRAYSCALE, GRAYSCALES, type GrayscaleAlgorithm, type Image } from '../model/types'

// Fitted parameters approximating an arcsinh stretch.
export interface ApproximateArcsinhStretchParameters {
	readonly stretchFactor: number
	readonly blackPoint: number
}

// Options for the arcsinh stretch.
export interface ArcsinhStretchOptions {
	// Strength of the arcsinh stretch.
	stretchFactor: number
	// Black point clipped before stretching, 0..1.
	blackPoint: number
	// Preserve highlight color ratios while stretching.
	protectHighlights: boolean
	// Stretch luminance in an RGB working space rather than per channel.
	useRgbWorkingSpace: boolean
	// Grayscale weighting defining the RGB working space.
	rgbWorkingSpace: GrayscaleAlgorithm
}

// Default arcsinh stretch options (no stretch, no highlight protection).
export const DEFAULT_ARCSINH_STRETCH_OPTIONS: Readonly<ArcsinhStretchOptions> = {
	stretchFactor: 1,
	blackPoint: 0,
	protectHighlights: false,
	useRgbWorkingSpace: false,
	rgbWorkingSpace: BT709_GRAYSCALE,
}

// Solves beta/asinh(beta)=stretchFactor for the PixInsight-compatible softening factor.
function arcsinhStretchBeta(stretchFactor: number) {
	if (!(stretchFactor > 1)) return 0

	let low = 0
	let high = 1

	while (high / Math.asinh(high) < stretchFactor) {
		high *= 2
	}

	for (let i = 0; i < 56; i++) {
		const mid = 0.5 * (low + high)
		if (mid / Math.asinh(mid) < stretchFactor) low = mid
		else high = mid
	}

	return 0.5 * (low + high)
}

// Clips the black point and renormalizes the remaining range back to [0,1].
function normalizeArcsinhStretchPixel(value: number, blackPoint: number, inverseSpan: number) {
	if (value <= blackPoint) return 0
	return inverseSpan === 0 ? 1 : Math.min(1, (value - blackPoint) * inverseSpan)
}

// Apply a PixInsight-style arcsinh stretch while preserving RGB ratios above the black point.
// https://pixinsight.com/doc/tools/ArcsinhStretch/ArcsinhStretch.html
export function arcsinhStretch(image: Image, options: Partial<ArcsinhStretchOptions> = DEFAULT_ARCSINH_STRETCH_OPTIONS) {
	const stretchFactor = options.stretchFactor ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.stretchFactor
	const blackPoint = options.blackPoint ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.blackPoint
	const protectHighlights = options.protectHighlights ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.protectHighlights
	const useRgbWorkingSpace = options.useRgbWorkingSpace ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.useRgbWorkingSpace
	const rgbWorkingSpace = options.rgbWorkingSpace ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.rgbWorkingSpace

	const resolvedStretchFactor = Number.isFinite(stretchFactor) ? Math.max(1, stretchFactor) : DEFAULT_ARCSINH_STRETCH_OPTIONS.stretchFactor
	const resolvedBlackPoint = Number.isFinite(blackPoint) ? clamp(blackPoint, 0, 1) : DEFAULT_ARCSINH_STRETCH_OPTIONS.blackPoint

	if (resolvedStretchFactor === 1 && resolvedBlackPoint === 0) return image

	const inverseSpan = resolvedBlackPoint === 1 ? 0 : 1 / (1 - resolvedBlackPoint)

	const beta = arcsinhStretchBeta(resolvedStretchFactor)
	const betaScale = beta === 0 ? 0 : 1 / Math.asinh(beta)
	const { raw, metadata } = image

	if (metadata.channels === 1) {
		const n = raw.length

		for (let i = 0; i < n; i++) {
			const value = normalizeArcsinhStretchPixel(raw[i], resolvedBlackPoint, inverseSpan)
			raw[i] = beta === 0 ? value : Math.asinh(beta * value) * betaScale
		}

		return image
	}

	let redWeight = 1 / 3
	let greenWeight = 1 / 3
	let blueWeight = 1 / 3

	if (useRgbWorkingSpace) {
		const grayscale = typeof rgbWorkingSpace === 'object' ? rgbWorkingSpace : GRAYSCALES[rgbWorkingSpace]
		const sum = grayscale.red + grayscale.green + grayscale.blue

		if (Number.isFinite(sum) && sum > 0) {
			redWeight = grayscale.red / sum
			greenWeight = grayscale.green / sum
			blueWeight = grayscale.blue / sum
		}
	}

	let maxValue = 1
	const n = raw.length

	for (let i = 0; i < n; i += 3) {
		const r = normalizeArcsinhStretchPixel(raw[i], resolvedBlackPoint, inverseSpan)
		const g = normalizeArcsinhStretchPixel(raw[i + 1], resolvedBlackPoint, inverseSpan)
		const b = normalizeArcsinhStretchPixel(raw[i + 2], resolvedBlackPoint, inverseSpan)
		const luminance = r * redWeight + g * greenWeight + b * blueWeight

		if (luminance === 0 || beta === 0) {
			raw[i] = r
			raw[i + 1] = g
			raw[i + 2] = b
		} else {
			const multiplier = (Math.asinh(beta * luminance) * betaScale) / luminance
			raw[i] = r * multiplier
			raw[i + 1] = g * multiplier
			raw[i + 2] = b * multiplier
		}

		if (protectHighlights) {
			if (raw[i] > maxValue) maxValue = raw[i]
			if (raw[i + 1] > maxValue) maxValue = raw[i + 1]
			if (raw[i + 2] > maxValue) maxValue = raw[i + 2]
		} else {
			raw[i] = Math.min(1, raw[i])
			raw[i + 1] = Math.min(1, raw[i + 1])
			raw[i + 2] = Math.min(1, raw[i + 2])
		}
	}

	if (protectHighlights && maxValue > 1) {
		const scale = 1 / maxValue
		for (let i = 0; i < n; i++) raw[i] *= scale
	}

	return image
}

// Evaluates the monochrome arcsinh stretch curve for one normalized sample.
function arcsinhStretchCurve(value: number, beta: number, blackPoint: number) {
	const normalized = normalizeArcsinhStretchPixel(value, blackPoint, blackPoint === 1 ? 0 : 1 / (1 - blackPoint))
	return beta === 0 ? normalized : Math.asinh(beta * normalized) / Math.asinh(beta)
}

// Solves beta so that arcsinh(normalizedMidpoint)=0.5 whenever the midpoint is stretchable.
function approximateArcsinhStretchBeta(normalizedMidpoint: number) {
	if (!(normalizedMidpoint > 0 && normalizedMidpoint < 0.5)) return 0

	let low = 0
	let high = 1

	while (Math.asinh(high * normalizedMidpoint) / Math.asinh(high) < 0.5) {
		high *= 2
	}

	for (let i = 0; i < 56; i++) {
		const mid = 0.5 * (low + high)
		if (Math.asinh(mid * normalizedMidpoint) / Math.asinh(mid) < 0.5) low = mid
		else high = mid
	}

	return 0.5 * (low + high)
}

// Measures the RMS curve error between STF and monochrome arcsinh over normalized samples.
function approximateArcsinhStretchError(midtone: number, shadow: number, highlight: number, beta: number, blackPoint: number) {
	let sum = 0

	// Evaluates the STF transfer curve for one normalized sample.
	function stfCurve(value: number) {
		if (value <= shadow) return 0
		if (value >= highlight) return 1

		const factor = 1 / (highlight - shadow)
		const d = value - shadow
		const k1 = (midtone - 1) * factor
		const k2 = (2 * midtone - 1) * factor
		return (d * k1) / (d * k2 - midtone)
	}

	for (let i = 0; i <= 128; i++) {
		const value = i / 128
		const delta = stfCurve(value) - arcsinhStretchCurve(value, beta, blackPoint)
		sum += delta * delta
	}

	return Math.sqrt(sum / 129)
}

// Approximates arcsinh parameters that best match an STF curve over [0,1].
// searches blackPoint in [0, shadow]
// for each candidate, solves the arcsinh strength so the STF midpoint lands near 0.5
// picks the pair with the lowest RMS curve error over sampled [0,1]
export function approximateArcsinhStretchParameters(midtone: number = 0.5, shadow: number = 0, highlight: number = 1): ApproximateArcsinhStretchParameters {
	const resolvedMidtone = Number.isFinite(midtone) ? clamp(midtone, 1e-6, 1 - 1e-6) : 0.5
	const a = Number.isFinite(shadow) ? clamp(shadow, 0, 1) : 0
	const b = Number.isFinite(highlight) ? clamp(highlight, 0, 1) : 1
	shadow = Math.min(a, b)
	highlight = Math.max(b, shadow + 1e-6)

	if (resolvedMidtone === 0.5 && shadow === 0 && highlight === 1) {
		return { stretchFactor: 1, blackPoint: 0 }
	}

	const midpoint = shadow + resolvedMidtone * (highlight - shadow)
	const maxBlackPoint = Math.min(shadow, midpoint - 1e-6)

	let bestBlackPoint = Math.max(0, maxBlackPoint)
	let bestBeta = approximateArcsinhStretchBeta(normalizeArcsinhStretchPixel(midpoint, bestBlackPoint, bestBlackPoint === 1 ? 0 : 1 / (1 - bestBlackPoint)))
	let bestError = approximateArcsinhStretchError(resolvedMidtone, shadow, highlight, bestBeta, bestBlackPoint)
	let low = 0
	let high = Math.max(0, maxBlackPoint)

	for (let pass = 0; pass < 4; pass++) {
		const span = high - low
		const steps = 24

		for (let i = 0; i <= steps; i++) {
			const blackPoint = span === 0 ? low : low + (span * i) / steps
			const normalizedMidpoint = normalizeArcsinhStretchPixel(midpoint, blackPoint, blackPoint === 1 ? 0 : 1 / (1 - blackPoint))
			const beta = approximateArcsinhStretchBeta(normalizedMidpoint)
			const error = approximateArcsinhStretchError(resolvedMidtone, shadow, highlight, beta, blackPoint)

			if (error < bestError) {
				bestError = error
				bestBlackPoint = blackPoint
				bestBeta = beta
			}
		}

		const radius = span === 0 ? 0 : (2 * span) / steps
		low = Math.max(0, bestBlackPoint - radius)
		high = Math.max(low, Math.min(maxBlackPoint, bestBlackPoint + radius))
	}

	return {
		stretchFactor: bestBeta === 0 ? 1 : bestBeta / Math.asinh(bestBeta),
		blackPoint: bestBlackPoint,
	}
}
