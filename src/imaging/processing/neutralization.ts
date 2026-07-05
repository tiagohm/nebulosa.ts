import { medianOf } from '../../core/util'
import { clamp } from '../../math/numerical/math'
import type { Image, ImageRawType } from '../model/types'

// Background neutralization for RGB images: removes a color cast by matching per-channel medians on a
// reference region, then optionally rescales or truncates the result back into the normalized [0, 1]
// range. Operates in place.

// Strategy for remapping the neutralized background level.
export type BackgroundNeutralizationMode = 'targetBackground' | 'rescale' | 'rescaleAsNeeded' | 'truncate'

// Options for background neutralization (removing a color cast from the sky background).
export interface BackgroundNeutralizationOptions {
	// Lower reference level (background floor), 0..1.
	lowerLimit: number
	// Upper reference level, 0..1.
	upperLimit: number
	// Desired background level after neutralization, 0..1.
	targetBackground: number
	// How the neutralized values are remapped.
	mode: BackgroundNeutralizationMode
}

// Default background neutralization options.
export const DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS: Readonly<BackgroundNeutralizationOptions> = {
	lowerLimit: 0,
	upperLimit: 1,
	targetBackground: 0.05,
	mode: 'rescaleAsNeeded',
}

// Computes the median of all significant reference samples for one RGB channel.
function backgroundNeutralizationMedian(raw: ImageRawType, lowerLimit: number, upperLimit: number, channel: number, samples: Float64Array, tolerance: number) {
	let count = 0

	const n = raw.length

	lowerLimit += tolerance
	upperLimit += tolerance

	for (let i = channel; i < n; i += 3) {
		const value = raw[i]

		if (value > lowerLimit && value <= upperLimit) {
			samples[count++] = value
		}
	}

	if (count === 0) return Number.NaN
	if (count === 1) return samples[0]

	return medianOf(samples.subarray(0, count).sort())
}

// Affinely rescales the current image range to [0,1].
function backgroundNeutralizationRescale(image: Image, minValue: number, maxValue: number) {
	const { raw } = image
	const n = raw.length
	const span = maxValue - minValue

	if (!(span > 0) || !Number.isFinite(span)) {
		for (let i = 0; i < n; i++) raw[i] = clamp(raw[i], 0, 1)
		return image
	}

	const scale = 1 / span

	for (let i = 0; i < n; i++) {
		raw[i] = (raw[i] - minValue) * scale
	}

	return image
}

// Clamps all pixels to the normalized floating-point image range.
function backgroundNeutralizationTruncate(image: Image) {
	const { raw } = image
	const n = raw.length

	for (let i = 0; i < n; i++) {
		raw[i] = clamp(raw[i], 0, 1)
	}

	return image
}

// Neutralizes the RGB background by matching per-channel medians on a reference region.
// PixInsight's classic BackgroundNeutralization works additively: v1 = v0 + M1 - M0.
export function backgroundNeutralization(image: Image, options: Partial<BackgroundNeutralizationOptions> = DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS) {
	if (image.metadata.channels !== 3) return image

	const mode = options.mode ?? DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS.mode
	const targetBackground = Number.isFinite(options.targetBackground) ? clamp(options.targetBackground!, 0, 1) : DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS.targetBackground
	const lowerInput = Number.isFinite(options.lowerLimit) ? options.lowerLimit! : DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS.lowerLimit
	const upperInput = Number.isFinite(options.upperLimit) ? options.upperLimit! : DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS.upperLimit
	const lowerLimit = Math.min(lowerInput, upperInput)
	const upperLimit = Math.max(lowerInput, upperInput)

	const { raw, metadata } = image
	const samples = new Float64Array(metadata.pixelCount)
	const medians = new Float64Array(3)
	const limitTolerance = raw instanceof Float32Array ? 1e-7 : 1e-12

	for (let channel = 0; channel < 3; channel++) {
		const median = backgroundNeutralizationMedian(raw, lowerLimit, upperLimit, channel, samples, limitTolerance)

		if (!Number.isFinite(median)) {
			throw new TypeError(`background neutralization requires at least one significant ${channel === 0 ? 'RED' : channel === 1 ? 'GREEN' : 'BLUE'} sample in the reference area`)
		}

		medians[channel] = median
	}

	const targetMedian = mode === 'targetBackground' ? targetBackground : 0
	const redShift = targetMedian - medians[0]
	const greenShift = targetMedian - medians[1]
	const blueShift = targetMedian - medians[2]
	let minValue = Number.POSITIVE_INFINITY
	let maxValue = Number.NEGATIVE_INFINITY

	for (let i = 0; i < raw.length; i += 3) {
		const red = raw[i] + redShift
		const green = raw[i + 1] + greenShift
		const blue = raw[i + 2] + blueShift

		raw[i] = red
		raw[i + 1] = green
		raw[i + 2] = blue

		if (Number.isFinite(red)) {
			if (red < minValue) minValue = red
			if (red > maxValue) maxValue = red
		}

		if (Number.isFinite(green)) {
			if (green < minValue) minValue = green
			if (green > maxValue) maxValue = green
		}

		if (Number.isFinite(blue)) {
			if (blue < minValue) minValue = blue
			if (blue > maxValue) maxValue = blue
		}
	}

	if (mode === 'rescale') return backgroundNeutralizationRescale(image, minValue, maxValue)
	if (mode === 'rescaleAsNeeded' && (minValue < 0 || maxValue > 1)) return backgroundNeutralizationRescale(image, minValue, maxValue)
	if (mode === 'truncate' || mode === 'targetBackground') return backgroundNeutralizationTruncate(image)

	return image
}
