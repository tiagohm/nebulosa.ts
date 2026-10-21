import type { Image } from '../model/types'
import { adf, DEFAULT_CLIPPING_POINT, DEFAULT_MEAN_BACKGROUND, histogram, type HistogramOptions } from './computation'

// Named automatic screen stretch profiles that estimate the [midtone, shadow, highlight] arguments of
// stf() from the normalized [0, 1] samples of an image without modifying them. The sky profiles reuse
// the adaptive display function (median and normalized MAD) with fixed coefficients; the Moon and
// planet profiles anchor the same midtones transfer function on histogram quantiles of the sampled
// pixels and solve the midtone so that a pivot quantile maps exactly to a target display level. Every
// call builds the histograms of the selected channel/region once per statistic and allocates only the
// returned tuple, a few three-element scratch arrays and the bin buffer when one is not supplied.

// Named automatic stretch profile. 'low', 'medium' and 'high' suit sky frames; 'moon' and 'planet'
// expect a region or mask that mostly covers the target.
export type AutoStfPreset = 'low' | 'medium' | 'high' | 'moon' | 'planet'

// Profile driven by the adaptive display function statistics of the sampled pixels.
export interface AutoStfAdaptivePreset {
	// Discriminant selecting the adaptive display function estimator.
	readonly strategy: 'adf'
	// Display level targeted by the median, in [0, 1]; larger brightens the background.
	readonly meanBackground: number
	// Shadow clipping point in normalized MAD units from the median, usually negative; closer to zero clips more.
	readonly clippingPoint: number
}

// Profile anchored on histogram quantiles of the sampled pixels.
export interface AutoStfQuantilePreset {
	// Discriminant selecting the quantile and pivot estimator.
	readonly strategy: 'quantile'
	// Cumulative probability of the shadow (black point) quantile, in [0, 1) and below pivot.
	readonly black: number
	// Cumulative probability of the pivot quantile, strictly between black and white.
	readonly pivot: number
	// Cumulative probability of the highlight (white point) quantile, in (0, 1] and above pivot.
	readonly white: number
	// Display level, in (0, 1), that the stretched pivot quantile takes.
	readonly target: number
}

// Parameters of one named automatic stretch profile.
export type AutoStfPresetParameters = AutoStfAdaptivePreset | AutoStfQuantilePreset

// Options for parameter estimation; the image samples are never modified.
export interface AutoStfOptions {
	// Color channel or grayscale weighting to sample; the default grayscale reduction gives a linked curve.
	readonly channel?: HistogramOptions['channel']
	// Inclusive pixel rectangle to sample, clamped to the image; whole image when omitted.
	readonly area?: HistogramOptions['area']
	// Histogram bit depth in 1..24 (16 by default) or a caller-owned bin buffer that is cleared and reused.
	readonly bits?: HistogramOptions['bits']
	// One byte per spatial pixel (width * height); nonzero entries are excluded from the statistics.
	readonly sigmaClip?: HistogramOptions['sigmaClip']
}

// Starting coefficients of each profile, to be calibrated with representative frames. 'medium' is the
// default adaptive display function; 'low' clips less and keeps the background darker, 'high' clips
// more and lifts faint signal. 'moon' clips the darkest 1 % and the brightest 0.5 % of the samples and
// sends the median to mid-gray; 'planet' clips the darkest 2 % and the brightest 0.2 % and sends the
// 55th percentile to 0.45.
export const AUTO_STF_PRESETS: Readonly<Record<AutoStfPreset, AutoStfPresetParameters>> = {
	low: { strategy: 'adf', meanBackground: 0.13, clippingPoint: -3.5 },
	medium: { strategy: 'adf', meanBackground: DEFAULT_MEAN_BACKGROUND, clippingPoint: DEFAULT_CLIPPING_POINT },
	high: { strategy: 'adf', meanBackground: 0.35, clippingPoint: -2 },
	moon: { strategy: 'quantile', black: 0.01, pivot: 0.5, white: 0.995, target: 0.5 },
	planet: { strategy: 'quantile', black: 0.02, pivot: 0.55, white: 0.998, target: 0.45 },
}

// Estimates the [midtone, shadow, highlight] arguments of stf() for a named profile, all in [0, 1]
// with shadow <= highlight. The image is only read: apply the result to a display copy so that the
// scientific samples are kept and a later estimate never reads an already stretched buffer.
// options.channel selects a color channel or the grayscale reduction (default), so a color image gets
// one linked curve for all channels; options.area restricts sampling to an inclusive pixel rectangle;
// options.sigmaClip is one byte per spatial pixel whose nonzero entries are excluded (intersected with
// the area); options.bits is the histogram depth (16 by default) or a reusable bin buffer. Raw CFA
// mosaics are treated as one mono plane that mixes the filter phases.
export function autoStf(image: Image, preset: AutoStfPreset = 'medium', options: AutoStfOptions = {}): readonly [midtone: number, shadow: number, highlight: number] {
	const parameters = AUTO_STF_PRESETS[preset]

	if (parameters.strategy === 'adf') {
		return adf(image, { ...options, meanBackground: parameters.meanBackground, clippingPoint: parameters.clippingPoint })
	}

	return quantileStf(image, parameters, options)
}

// Anchors the shadow, pivot and highlight on the histogram quantiles c0 < v < c1 and solves the midtone
// m analytically so that stf() maps v exactly to the target: with u = (v - c0) / (c1 - c0), the
// midtones transfer function T_m(u) = (m - 1) u / ((2m - 1) u - m) equals t for m = T_t(u), which lies
// in (0, 1) for u and t in (0, 1). The three quantiles come from one cumulative scan with the same
// in-bin linear interpolation as Histogram.quantile(), so they are exact only to the bin width. The
// identity [0.5, 0, 1] is returned when no sample is accepted, when the black and white anchors fall in
// the same occupied bin (interpolation would invent a spread inside it, even if outliers occupy other
// bins) or when the anchors collapse, typically a pivot that reaches the saturated top bin.
function quantileStf(image: Image, parameters: AutoStfQuantilePreset, options: AutoStfOptions) {
	const h = histogram(image, options)
	const total = h.count[0]

	if (total > 0) {
		const { histogram: bins, max } = h
		const thresholds = [parameters.black * total, parameters.pivot * total, parameters.white * total]
		const quantiles = [0, 0, 0]
		const anchorBins = [0, 0, 0]
		const n = bins.length
		let k = 0
		let cumulative = 0

		for (let i = 0; i < n && k < 3; i++) {
			const frequency = bins[i]
			if (frequency === 0) continue
			const previous = cumulative
			cumulative += frequency

			// Probabilities are increasing, so several anchors may be resolved by the same bin.
			for (; k < 3 && cumulative >= thresholds[k]; k++) {
				const position = i + (thresholds[k] - previous) / frequency
				quantiles[k] = position >= max ? 1 : position / max
				anchorBins[k] = i
			}
		}

		const [shadow, pivot, highlight] = quantiles

		if (anchorBins[0] !== anchorBins[2] && shadow < pivot && pivot < highlight) {
			const u = (pivot - shadow) / (highlight - shadow)
			const t = parameters.target
			return [((t - 1) * u) / ((2 * t - 1) * u - t), shadow, highlight] as const
		}
	}

	return [0.5, 0, 1] as const
}
