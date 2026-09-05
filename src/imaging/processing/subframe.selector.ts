import { medianOf } from '../../core/util'
import { clamp } from '../../math/numerical/math'
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
	// Combined quality score used for weighting and reference selection.
	readonly qualityScore: number
	// Estimated sky background level, normally in the image's sample scale.
	readonly estimatedBackground: number
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
}

// Stable reasons for rejecting a subframe.
export type SubframeRejectionReason = 'too-few-stars' | 'median-snr-too-low' | 'median-hfd-too-high' | 'median-hfd-unavailable' | 'median-fwhm-too-high' | 'median-fwhm-unavailable' | 'median-eccentricity-too-high' | 'median-eccentricity-unavailable' | 'median-elongation-too-high' | 'median-elongation-unavailable'

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
	const estimatedBackground = estimateImageBackground(frame.image)
	const qualityScore = starCount > 0 && Number.isFinite(medianHFD) ? clamp((Math.sqrt(starCount) * Math.max(medianSNR, 1)) / Math.max(medianHFD, 0.5), 0, 1e6) : 0
	return { starCount, medianSNR, medianHFD, medianFWHM, medianEccentricity, medianElongation, qualityScore, estimatedBackground }
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

	if (values.length === 0) return 0
	const sample = Float64Array.from(values)
	sample.sort()
	return medianOf(sample)
}
