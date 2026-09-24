import { clamp } from '../../math/numerical/math'
import { geometricMeanOf, medianAbsoluteDeviationOf, medianOf } from '../../math/numerical/statistics'
import type { Image } from '../model/types'
import type { DetectedStar } from '../stars/detector'

// Subframe quality measurement and explicit pre-stacking selection. Metrics are derived from detected
// stars and sparse image samples; all diameters are pixels and shape metrics are dimensionless.

// Minimum public shape required to measure or select a subframe.
export interface SubframeInput {
	// Image used to estimate coarse sky background.
	readonly image: Image
	// Stars measured in the image coordinate system.
	readonly stars: readonly DetectedStar[]
}

// Aggregate quality metrics for one subframe.
export interface SubframeQualityMetrics {
	// Total number of supplied detected stars.
	readonly starCount: number
	// Median finite star signal-to-noise ratio.
	readonly medianSNR: number
	// Median finite half-flux diameter, pixels; Infinity when unavailable.
	readonly medianHFD: number
	// Median finite FWHM, pixels; undefined when no star supplies it.
	readonly medianFWHM?: number
	// Median finite eccentricity, from 0 (round) toward 1 (elongated).
	readonly medianEccentricity?: number
	// Median finite major/minor axis ratio, at least 1.
	readonly medianElongation?: number
	// Combined quality score used for weighting and reference selection. Unbounded; stacking still uses it.
	readonly qualityScore: number
	// Estimated sky background level, normally in the image's sample scale.
	readonly estimatedBackground: number
	// Robust noise of the sparse background samples, as a normalized MAD. Zero when they do not scatter.
	readonly noise: number
	// Quality on 0..1 from star count, sharpness, eccentricity, SNR, background, and noise.
	readonly normalizedScore: number
}

// Optional thresholds applied independently to subframe quality metrics.
export interface SubframeSelectionOptions {
	// Minimum total detected stars.
	readonly minStars?: number
	// Minimum median signal-to-noise ratio.
	readonly minMedianSNR?: number
	// Maximum median half-flux diameter, pixels.
	readonly maxMedianHFD?: number
	// Maximum median FWHM, pixels.
	readonly maxMedianFWHM?: number
	// Maximum median eccentricity.
	readonly maxMedianEccentricity?: number
	// Maximum median major/minor axis ratio.
	readonly maxMedianElongation?: number
	// Maximum estimated background, in the image's sample scale.
	readonly maxBackground?: number
	// Maximum robust background noise.
	readonly maxNoise?: number
	// Minimum normalized score, on 0..1.
	readonly minNormalizedScore?: number
}

// Stable reasons for rejecting a subframe.
export type SubframeRejectionReason =
	| 'too-few-stars'
	| 'median-snr-too-low'
	| 'median-hfd-too-high'
	| 'median-hfd-unavailable'
	| 'median-fwhm-too-high'
	| 'median-fwhm-unavailable'
	| 'median-eccentricity-too-high'
	| 'median-eccentricity-unavailable'
	| 'median-elongation-too-high'
	| 'median-elongation-unavailable'
	| 'background-too-high'
	| 'noise-too-high'
	| 'normalized-score-too-low'

// Defaults of the 0..1 frame score. Sharpness uses HFD when it is finite and FWHM otherwise, with the
// same pixel thresholds. Background and noise are penalties on the normalized sample scale.
export const DEFAULT_IMAGE_QUALITY = {
	// Star count at which the star factor saturates.
	starCount: 100,
	// HFD or FWHM, in pixels, at and below which sharpness saturates.
	targetPixels: 2,
	// HFD or FWHM, in pixels, at and above which sharpness is zero.
	maximumPixels: 8,
	// Eccentricity at and above which the shape factor is zero.
	maximumEccentricity: 0.8,
	// Median SNR at which the SNR factor saturates.
	signalToNoise: 50,
	// Background at and above which the background factor is zero.
	maximumBackground: 0.5,
	// Noise at and above which the noise factor is zero.
	maximumNoise: 0.05,
} as const

// Overrides for imageQualityScore. Every field is optional and falls back to DEFAULT_IMAGE_QUALITY.
export interface ImageQualityOptions {
	// Star count at which the star factor saturates.
	readonly starCount?: number
	// Sharpness width, in pixels, at and below which the factor saturates.
	readonly targetPixels?: number
	// Sharpness width, in pixels, at and above which the factor is zero.
	readonly maximumPixels?: number
	// Eccentricity at and above which the shape factor is zero.
	readonly maximumEccentricity?: number
	// Median SNR at which the SNR factor saturates.
	readonly signalToNoise?: number
	// Background at and above which the background factor is zero.
	readonly maximumBackground?: number
	// Noise at and above which the noise factor is zero.
	readonly maximumNoise?: number
	// 1 returns 0..1. 100 returns a percentage. Defaults to 1.
	readonly scale?: 1 | 100
}

// Quantities imageQualityScore reads. Missing optional metrics are left out of the mean.
export interface ImageQualityInput {
	// Number of detected stars.
	readonly starCount: number
	// Median HFD in pixels.
	readonly medianHFD?: number
	// Median FWHM in pixels, used when HFD is missing or not finite.
	readonly medianFWHM?: number
	// Median eccentricity from 0 toward 1.
	readonly medianEccentricity?: number
	// Median stellar SNR.
	readonly medianSNR?: number
	// Sky background in the image's sample scale.
	readonly estimatedBackground?: number
	// Robust sky noise in the same scale.
	readonly noise?: number
}

// Linear factor that is 1 at and below `good` and 0 at and above `bad`.
function fallingFactor(value: number, good: number, bad: number) {
	if (!(bad > good)) return value <= good ? 1 : 0
	return clamp((bad - value) / (bad - good), 0, 1)
}

// Frame quality on 0..1, or 0..100 when requested.
// Parameters: input carries the aggregate measurements. options overrides the saturation points of
// each factor. The score is the geometric mean of star count, sharpness, eccentricity, SNR,
// background, and noise, omitting any factor whose measurement is absent. Star count and SNR saturate
// upward. Sharpness, eccentricity, background, and noise get worse as they grow. Zero stars score zero.
export function imageQualityScore(input: ImageQualityInput, options: ImageQualityOptions = {}): number {
	const starCount = options.starCount ?? DEFAULT_IMAGE_QUALITY.starCount
	const targetPixels = options.targetPixels ?? DEFAULT_IMAGE_QUALITY.targetPixels
	const maximumPixels = options.maximumPixels ?? DEFAULT_IMAGE_QUALITY.maximumPixels
	const maximumEccentricity = options.maximumEccentricity ?? DEFAULT_IMAGE_QUALITY.maximumEccentricity
	const signalToNoise = options.signalToNoise ?? DEFAULT_IMAGE_QUALITY.signalToNoise
	const maximumBackground = options.maximumBackground ?? DEFAULT_IMAGE_QUALITY.maximumBackground
	const maximumNoise = options.maximumNoise ?? DEFAULT_IMAGE_QUALITY.maximumNoise
	const factors = [starCount > 0 ? clamp(input.starCount / starCount, 0, 1) : 0]
	const sharpness = input.medianHFD !== undefined && Number.isFinite(input.medianHFD) ? input.medianHFD : input.medianFWHM
	if (sharpness !== undefined && Number.isFinite(sharpness)) factors.push(fallingFactor(sharpness, targetPixels, maximumPixels))
	if (input.medianEccentricity !== undefined && Number.isFinite(input.medianEccentricity)) factors.push(fallingFactor(input.medianEccentricity, 0, maximumEccentricity))
	if (input.medianSNR !== undefined && Number.isFinite(input.medianSNR)) factors.push(signalToNoise > 0 ? clamp(input.medianSNR / signalToNoise, 0, 1) : 0)
	if (input.estimatedBackground !== undefined && Number.isFinite(input.estimatedBackground)) factors.push(fallingFactor(input.estimatedBackground, 0, maximumBackground))
	if (input.noise !== undefined && Number.isFinite(input.noise)) factors.push(fallingFactor(input.noise, 0, maximumNoise))

	const score = geometricMeanOf(factors)
	return options.scale === 100 ? score * 100 : score
}

// Selection diagnostic for one input frame.
export interface SubframeSelectionResult<T extends SubframeInput> {
	// Original input frame, preserving caller metadata and identity.
	readonly frame: T
	// Measured quality values used for selection.
	readonly metrics: SubframeQualityMetrics
	// Whether no configured threshold rejected the frame.
	readonly accepted: boolean
	// All configured threshold failures, in evaluation order.
	readonly reasons: readonly SubframeRejectionReason[]
}

// Result of selecting a frame collection before stacking.
export interface SubframeSelection<T extends SubframeInput> {
	// Accepted inputs, preserving their original order and references.
	readonly accepted: readonly T[]
	// One diagnostic entry for every input frame, in input order.
	readonly results: readonly SubframeSelectionResult<T>[]
}

// Maximum sparse samples used for a coarse sky-background estimate.
const BACKGROUND_SAMPLE_LIMIT = 1024

// Measures deterministic quality metrics from stars and a coarse image background.
export function measureSubframeQuality(frame: SubframeInput): SubframeQualityMetrics {
	const { stars } = frame
	const starCount = stars.length
	const medianSNR = finiteMedian(stars, (star) => star.snr) ?? 0
	const medianHFD = finiteMedian(stars, (star) => star.hfd, Number.EPSILON) ?? Infinity
	const medianFWHM = finiteMedian(stars, (star) => star.fwhm, Number.EPSILON)
	const medianEccentricity = finiteMedian(stars, (star) => star.eccentricity)
	const medianElongation = finiteMedian(stars, (star) => star.elongation, 1)
	const { background: estimatedBackground, noise } = estimateImageBackground(frame.image)
	const qualityScore = starCount > 0 && Number.isFinite(medianHFD) ? clamp((Math.sqrt(starCount) * Math.max(medianSNR, 1)) / Math.max(medianHFD, 0.5), 0, 1e6) : 0
	const normalizedScore = imageQualityScore({ starCount, medianHFD, medianFWHM, medianEccentricity, medianSNR, estimatedBackground, noise })
	return { starCount, medianSNR, medianHFD, medianFWHM, medianEccentricity, medianElongation, qualityScore, estimatedBackground, noise, normalizedScore }
}

// Classifies frames against explicitly supplied thresholds without modifying their order or contents.
export function selectSubframes<T extends SubframeInput>(frames: readonly T[], options: SubframeSelectionOptions = {}): SubframeSelection<T> {
	const accepted: T[] = []
	const results = new Array<SubframeSelectionResult<T>>(frames.length)

	for (let i = 0; i < frames.length; i++) {
		const frame = frames[i]
		const metrics = measureSubframeQuality(frame)
		const reasons = rejectionReasons(metrics, options)
		const result = { frame, metrics, accepted: reasons.length === 0, reasons }
		results[i] = result
		if (result.accepted) accepted.push(frame)
	}

	return { accepted, results }
}

// Computes every configured threshold failure in deterministic diagnostic order.
function rejectionReasons(metrics: SubframeQualityMetrics, options: SubframeSelectionOptions): SubframeRejectionReason[] {
	const reasons: SubframeRejectionReason[] = []
	if (options.minStars !== undefined && metrics.starCount < options.minStars) reasons.push('too-few-stars')
	if (options.minMedianSNR !== undefined && metrics.medianSNR < options.minMedianSNR) reasons.push('median-snr-too-low')

	if (options.maxMedianHFD !== undefined) {
		if (!Number.isFinite(metrics.medianHFD)) reasons.push('median-hfd-unavailable')
		else if (metrics.medianHFD > options.maxMedianHFD) reasons.push('median-hfd-too-high')
	}

	if (options.maxMedianFWHM !== undefined) {
		if (metrics.medianFWHM === undefined) reasons.push('median-fwhm-unavailable')
		else if (metrics.medianFWHM > options.maxMedianFWHM) reasons.push('median-fwhm-too-high')
	}

	if (options.maxMedianEccentricity !== undefined) {
		if (metrics.medianEccentricity === undefined) reasons.push('median-eccentricity-unavailable')
		else if (metrics.medianEccentricity > options.maxMedianEccentricity) reasons.push('median-eccentricity-too-high')
	}

	if (options.maxMedianElongation !== undefined) {
		if (metrics.medianElongation === undefined) reasons.push('median-elongation-unavailable')
		else if (metrics.medianElongation > options.maxMedianElongation) reasons.push('median-elongation-too-high')
	}

	if (options.maxBackground !== undefined && metrics.estimatedBackground > options.maxBackground) reasons.push('background-too-high')
	if (options.maxNoise !== undefined && metrics.noise > options.maxNoise) reasons.push('noise-too-high')
	if (options.minNormalizedScore !== undefined && metrics.normalizedScore < options.minNormalizedScore) reasons.push('normalized-score-too-low')

	return reasons
}

// Returns the median finite non-negative measurement projected from a star list.
function finiteMedian(stars: readonly DetectedStar[], valueOf: (star: DetectedStar) => number | undefined, minimum: number = 0) {
	const values = new Float64Array(stars.length)
	let count = 0

	for (let i = 0; i < stars.length; i++) {
		const value = valueOf(stars[i])
		if (value === undefined || !Number.isFinite(value) || value < minimum) continue
		values[count++] = value
	}

	if (count === 0) return undefined

	return medianOf(values.subarray(0, count).sort())
}

// Estimates coarse sky background from sparse luminance samples across an image.
function estimateImageBackground(image: Image) {
	const { raw, metadata } = image
	const { channels, width, height } = metadata
	const step = Math.max(1, Math.floor(Math.sqrt((width * height) / BACKGROUND_SAMPLE_LIMIT)))
	const values: number[] = []

	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			const base = (y * width + x) * channels
			const value = channels === 1 ? raw[base] : 0.2125 * raw[base] + 0.7154 * raw[base + 1] + 0.0721 * raw[base + 2]
			if (Number.isFinite(value)) values.push(value)
		}
	}

	if (values.length === 0) return { background: 0, noise: 0 }
	const sample = Float64Array.from(values)
	sample.sort()
	const background = medianOf(sample)
	const noise = medianAbsoluteDeviationOf(sample, background, true)
	return { background, noise: Number.isFinite(noise) ? noise : 0 }
}
