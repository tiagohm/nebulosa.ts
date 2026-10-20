import type { Time, Timescale } from '../../astronomy/time/time'
import { validatePositiveInteger } from '../../core/validation'
import { type RobustRegressionMethod, robustLinearLeastSquares } from '../../math/numerical/least.squares'
import { medianBySelectionOf, STANDARD_DEVIATION_SCALE, standardDeviationOf } from '../../math/numerical/statistics'
import type { AperturePhotometryFlag } from './photometry'

// Weighted ensemble differential photometry and light curves. Combines per-frame flux measurements of
// stars with stable identities into an artificial comparison star (Broeg, Fernández & Neuhäuser 2005,
// AN 326, 134): every comparison is normalized by its own reference flux, so a missing comparison does
// not bias the ensemble, and the normalized fluxes are averaged with inverse-variance weights that add
// each comparison's excess (intrinsic) fractional variance to its measurement variance. The ensemble is
// a per-frame transparency (relative transmission, median 1 over the frames) that absorbs every change
// common to all stars: clouds, extinction, exposure time and gain. The reference fluxes tie the
// transparencies of frames sharing comparisons to one scale, so only frames linked to the reference
// ensemble by a chain of shared comparisons are reported; the transmission of a set of frames observed
// with entirely different comparisons is unmeasured relative to the rest. The reference fluxes, weights and
// excess variances (DerSimonian & Laird 1986 moment estimates) are iterated to convergence; a
// comparison whose robust scatter against the leave-one-out ensemble of the others is significantly
// larger than its errors predict is rejected as variable, and a comparison deviating from the others in
// one frame is clipped from that frame only. The target flux divided by the transparency is normalized
// by its median and expressed as a relative flux and a differential magnitude, with the measurement and
// ensemble uncertainties propagated to first order. An optional robust linear detrending against
// airmass, FWHM or target centroid drift is reported beside the original series, which is never
// modified. Fluxes are in any linear unit consistent for each star across frames; epochs are passed
// through unchanged in their own timescale. Pure function: inputs are never mutated, the epochs in the
// result alias the input Time objects, and the work arrays are O(comparisons * frames) typed arrays
// allocated per call.

// Stable star identity shared by the measurements of the same star in every frame.
export type PhotometryStarId = string | number

// Covariate of the optional detrending. 'airmass' and 'fwhm' come from the frame; 'x' and 'y' are the
// target centroid of the frame, so they model the intrapixel and flat-field response to pointing drift.
export type DifferentialDetrendCovariate = 'airmass' | 'fwhm' | 'x' | 'y'

// Per-epoch quality flags.
// 'targetMissing': the target is absent or unusable in the frame (non-finite flux, non-positive or
// non-finite error, or a rejected photometry flag), so no corrected value is reported.
// 'targetNonPositive': the target flux is zero or negative; the relative flux is kept but no magnitude.
// 'noComparisons': fewer than minComparisons comparisons survived in the frame, so the transparency and
// every corrected value are undefined.
// 'disconnected': the comparisons combined in the frame share no chain of common frames with the
// reference ensemble, so the transmission of the frame relative to the series is unmeasured and the
// transparency and every corrected value are undefined.
// 'comparisonClipped': at least one comparison was clipped as an outlier in this frame.
// 'notDetrended': detrending was requested but the epoch lacks a covariate, the fit is unavailable or
// the model is not positive, so it has no detrended value.
export type DifferentialLightCurveFlag = 'targetMissing' | 'targetNonPositive' | 'noComparisons' | 'disconnected' | 'comparisonClipped' | 'notDetrended'

// Classification of a comparison star after the ensemble iteration.
// 'used': contributes to the ensemble. 'variable': rejected because its scatter against the other
// comparisons exceeds variabilityLimit. 'missing': has no usable measurement in any frame.
// 'disconnected': combined only in frames outside the reference ensemble, so its reference flux is
// unmeasured on the scale of the series and it contributes to no reported transparency.
export type DifferentialComparisonStatus = 'used' | 'variable' | 'missing' | 'disconnected'

// Flux measurement of one star in one frame, compatible with an AperturePhotometry spread with an id.
export interface DifferentialPhotometryStar {
	// Stable identity of the star across frames; unique within a frame.
	readonly id: PhotometryStarId
	// Background-subtracted flux in a linear unit consistent across frames for this star. A comparison
	// needs a positive flux; a target flux may be zero or negative. Undefined or non-finite is unusable.
	readonly flux?: number
	// One-sigma flux uncertainty, same unit, finite and positive; otherwise the measurement is unusable.
	readonly fluxError?: number
	// Centroid, zero-based pixels, used only by the 'x' and 'y' detrending covariates of the target.
	readonly x?: number
	readonly y?: number
	// Aperture photometry quality flags; a flag listed in rejectFlags makes the measurement unusable.
	readonly flags?: readonly AperturePhotometryFlag[]
}

// Measurements of one frame. A dropped frame may be passed with no stars; it keeps its epoch slot.
export interface DifferentialPhotometryFrame {
	// Epoch of the frame (for example the exposure midpoint); every frame must use the same timescale.
	readonly time: Time
	// Star measurements in any order.
	readonly stars: readonly DifferentialPhotometryStar[]
	// Airmass of the target, dimensionless, used only by the 'airmass' detrending covariate.
	readonly airmass?: number
	// Seeing FWHM, pixels, used only by the 'fwhm' detrending covariate.
	readonly fwhm?: number
}

// Optional linear detrending of the relative flux against frame covariates.
export interface DifferentialDetrendOptions {
	// Covariates of the linear model, at least one, without repetition.
	readonly covariates: readonly DifferentialDetrendCovariate[]
	// Robust loss of the iteratively reweighted fit: 'huber' (the default) downweights astrophysical
	// variability such as an eclipse, 'tukey' rejects it, 'none' is ordinary weighted least squares.
	readonly method?: RobustRegressionMethod
}

// Options for differentialLightCurve.
export interface DifferentialLightCurveOptions {
	// Minimum surviving comparisons for a frame to have a transparency, a positive integer. Defaults to 1.
	readonly minComparisons?: number
	// Per-frame clipping threshold, in standard deviations of the difference between a comparison and
	// the mean of the others. Applied only with at least 3 comparisons in the frame. Defaults to 4.
	readonly clipSigma?: number
	// Ratio of observed to expected scatter above which a comparison is rejected as variable. Applied
	// only while at least 3 comparisons are used. Defaults to 3.
	readonly variabilityLimit?: number
	// Maximum ensemble iterations, a positive integer. Defaults to 20.
	readonly maxIterations?: number
	// Photometry flags that make a measurement unusable. Defaults to every AperturePhotometryFlag.
	readonly rejectFlags?: readonly AperturePhotometryFlag[]
	// Linear detrending of the relative flux; omitted for none.
	readonly detrend?: DifferentialDetrendOptions
}

// Relative flux and magnitude after detrending.
export interface DifferentialDetrendedValue {
	// Relative flux divided by the normalized detrending model.
	readonly relativeFlux: number
	// Its one-sigma uncertainty, scaled by the same factor (the model uncertainty is not included).
	readonly relativeFluxError: number
	// Differential magnitude -2.5 log10(relativeFlux), undefined when relativeFlux is not positive.
	readonly magnitude?: number
	// Its one-sigma uncertainty, mag.
	readonly magnitudeError?: number
}

// One epoch of the light curve. Undefined values are explained by the flags.
export interface DifferentialLightCurvePoint {
	// Epoch of the frame, the same object as the input.
	readonly time: Time
	// Raw target flux and its uncertainty, input unit.
	readonly targetFlux?: number
	readonly targetFluxError?: number
	// Ensemble transparency, the relative transmission of the frame (median 1 over the frames of the
	// reference ensemble), and its one-sigma uncertainty.
	readonly transparency?: number
	readonly transparencyError?: number
	// Number of comparisons combined in the frame.
	readonly comparisonCount: number
	// Comparisons clipped as outliers in this frame only.
	readonly clippedComparisonIds: readonly PhotometryStarId[]
	// Target flux corrected by the transparency, input unit, and its uncertainty.
	readonly flux?: number
	readonly fluxError?: number
	// Corrected flux divided by the series normalization, and its uncertainty.
	readonly relativeFlux?: number
	readonly relativeFluxError?: number
	// Differential magnitude -2.5 log10(relativeFlux), zero at the median level, positive when fainter,
	// undefined when relativeFlux is not positive; and its uncertainty, mag.
	readonly magnitude?: number
	readonly magnitudeError?: number
	// Detrended values, present only when detrending was requested and applied to this epoch.
	readonly detrended?: DifferentialDetrendedValue
	// Quality flags, empty for a clean epoch.
	readonly flags: readonly DifferentialLightCurveFlag[]
}

// Diagnostics of one comparison star. The scatter statistics are fractional standard deviations of
// its flux relative to the ensemble of the other used comparisons (the full ensemble when rejected),
// undefined with fewer than 3 frames.
export interface DifferentialComparisonStar {
	// Identity of the comparison.
	readonly id: PhotometryStarId
	// Final classification.
	readonly status: DifferentialComparisonStatus
	// Flux at transparency 1, input unit; undefined when missing or disconnected, or for a variable
	// comparison with no usable measurement in a frame of the reference ensemble.
	readonly referenceFlux?: number
	// Number of frames with a usable measurement.
	readonly frameCount: number
	// Number of frames where it was clipped as an outlier.
	readonly clippedCount: number
	// Mean fractional weight in the ensemble over the frames it contributed to, in [0, 1]; 0 when unused.
	readonly weight: number
	// Robust observed scatter (normalized MAD).
	readonly scatter?: number
	// Scatter expected from the measurement and ensemble uncertainties (median over frames).
	readonly expectedScatter?: number
	// Excess scatter not explained by the uncertainties, the square root of the DerSimonian-Laird moment
	// estimate over the frames where it was combined (every usable frame once rejected); it downweights
	// the comparison. Undefined below 3 frames, where it is taken as 0.
	readonly excessScatter?: number
	// Robust observed over expected scatter, the latter including the median of the robust excess
	// variances max(scatter^2 - expectedScatter^2, 0) of the used comparisons (a common term such as
	// scintillation); compared with variabilityLimit.
	readonly variability?: number
}

// Fitted detrending model relativeFlux = intercept + sum(coefficients[k] * (covariate_k - means[k])).
export interface DifferentialDetrendFit {
	// Model value at the mean covariates, relative flux.
	readonly intercept: number
	// Slope per covariate, relative flux per covariate unit (per airmass or per pixel).
	readonly coefficients: readonly number[]
	// Mean covariate values of the fitted epochs.
	readonly means: readonly number[]
	// Condition number of the weighted design matrix.
	readonly conditionNumber: number
	// Whether the covariates are numerically degenerate (for example a constant FWHM).
	readonly rankDeficient: boolean
	// Standard deviation of the relative flux of the fitted epochs before and after detrending.
	readonly scatterBefore: number
	readonly scatterAfter: number
}

// Detrending diagnostics.
export interface DifferentialDetrending {
	// Covariates in model order.
	readonly covariates: readonly DifferentialDetrendCovariate[]
	// Number of epochs with a relative flux and every covariate.
	readonly pointCount: number
	// Fitted model, undefined when pointCount does not exceed the number of model coefficients.
	readonly fit?: DifferentialDetrendFit
}

// Differential light curve of a target.
export interface DifferentialLightCurve {
	// Identity of the target.
	readonly targetId: PhotometryStarId
	// Timescale of every epoch, undefined for an empty series.
	readonly timescale?: Timescale
	// One point per input frame, in input order.
	readonly points: readonly DifferentialLightCurvePoint[]
	// Comparison diagnostics, in candidate order.
	readonly comparisons: readonly DifferentialComparisonStar[]
	// Comparisons rejected as variable, in rejection order.
	readonly rejectedComparisonIds: readonly PhotometryStarId[]
	// Median corrected target flux dividing the relative flux, input unit; undefined without a positive one.
	readonly normalization?: number
	// Ensemble iterations performed.
	readonly iterations: number
	// Whether the transparencies stabilized, relative to their mean, to 1e-6 of their uncertainty within
	// maxIterations; false when no frame has a transparency, as there is no solution to settle.
	readonly converged: boolean
	// Detrending diagnostics, present only when detrending was requested.
	readonly detrending?: DifferentialDetrending
}

// Default per-frame clipping threshold, standard deviations.
const DEFAULT_CLIP_SIGMA = 4
// Default observed-to-expected scatter ratio rejecting a comparison as variable.
const DEFAULT_VARIABILITY_LIMIT = 3
// Default maximum ensemble iterations; the iteration usually settles in a few.
const DEFAULT_MAX_ITERATIONS = 20
// Every aperture photometry flag: each one biases or invalidates the flux.
const DEFAULT_REJECT_FLAGS: readonly AperturePhotometryFlag[] = ['truncated', 'masked', 'saturated', 'noBackground', 'empty']
// Fewest comparisons that can single out a deviant one by majority.
const MIN_REJECTION_COMPARISONS = 3
// Fewest frames for a robust scatter estimate.
const MIN_SCATTER_FRAMES = 3
// Largest change of a transparency between iterations considered converged, in units of its uncertainty.
const CONVERGENCE_TOLERANCE = 1e-6
// Pogson magnitude per natural-log flux unit, 2.5 / ln(10), converting a relative flux error to mag.
const MAGNITUDE_ERROR_SCALE = 2.5 / Math.LN10
// Huber and Tukey tuning constants for 95% Gaussian efficiency.
const HUBER_TUNING = 1.345
const TUKEY_TUNING = 4.685

// Builds the differential light curve of targetId from frames of flux measurements. comparisonIds lists
// the candidate comparison stars; when omitted every other star of any frame is a candidate, and the
// target is never its own comparison. A measurement is usable when its flux is finite (positive for a
// comparison), its fluxError finite and positive, and it has no flag in rejectFlags. In each frame the
// transparency is the inverse-variance weighted mean of the usable comparisons' flux over reference flux,
// weights 1 / ((fluxError / referenceFlux)^2 + excess^2 transparency^2); its variance is the inverse of
// the weight sum. The corrected flux is targetFlux / transparency with variance
// (targetFluxError / T)^2 + (targetFlux / T^2)^2 var(T), assuming independent target and comparison errors.
// The uncertainty of the median normalization, common to every epoch, is not included. Frames and
// comparisons linked by shared measurements form connected ensembles, each with an independent scale;
// only the one with the most frames (the earliest frame breaking ties) is reported, and the frames of
// the others are flagged 'disconnected'. Connectivity is evaluated after variable rejection and
// clipping. A single shared frame or comparison is enough to link two ensembles, but the reference
// fluxes are treated as exact, so the uncertainty of such a weak link is not included. Supplied errors
// are assumed realistic up to a fractional excess common to the comparisons; underestimated errors make
// faint comparisons look variable. Throws RangeError when the frames mix timescales or a frame repeats a
// star id, TypeError when maxIterations is not a positive integer.
export function differentialLightCurve(frames: readonly DifferentialPhotometryFrame[], targetId: PhotometryStarId, comparisonIds?: readonly PhotometryStarId[], options: DifferentialLightCurveOptions = {}): DifferentialLightCurve {
	const { minComparisons = 1, clipSigma = DEFAULT_CLIP_SIGMA, variabilityLimit = DEFAULT_VARIABILITY_LIMIT, maxIterations = DEFAULT_MAX_ITERATIONS, rejectFlags = DEFAULT_REJECT_FLAGS, detrend } = options
	// An infinite or fractional limit would iterate forever on a series that does not converge.
	validatePositiveInteger(maxIterations)

	const frameCount = frames.length
	const timescale = frameCount > 0 ? frames[0].time.scale : undefined
	const rejected = new Set(rejectFlags)
	const index = new Map<PhotometryStarId, number>()
	const ids: PhotometryStarId[] = []

	if (comparisonIds !== undefined) {
		for (const id of comparisonIds) {
			if (id !== targetId && !index.has(id)) {
				index.set(id, ids.length)
				ids.push(id)
			}
		}
	}

	const seen = new Set<PhotometryStarId>()

	for (const frame of frames) {
		// Mixed timescales would label a misaligned series with one scale.
		if (frame.time.scale !== timescale) throw new RangeError('every frame must use the same timescale')
		seen.clear()

		for (const star of frame.stars) {
			// A repeated id makes the star's flux in that frame ambiguous.
			if (seen.has(star.id)) throw new RangeError('a star id must be unique within a frame')
			seen.add(star.id)

			if (comparisonIds === undefined && star.id !== targetId && !index.has(star.id)) {
				index.set(star.id, ids.length)
				ids.push(star.id)
			}
		}
	}

	// Comparison measurements, comparison-major: entry i * frameCount + j is comparison i in frame j.
	const comparisonCount = ids.length
	const size = comparisonCount * frameCount
	const flux = new Float64Array(size)
	const variance = new Float64Array(size)
	const usable = new Uint8Array(size)
	const targetFlux = new Float64Array(frameCount).fill(Number.NaN)
	const targetError = new Float64Array(frameCount).fill(Number.NaN)
	const targetX = new Float64Array(frameCount).fill(Number.NaN)
	const targetY = new Float64Array(frameCount).fill(Number.NaN)

	for (let j = 0; j < frameCount; j++) {
		for (const star of frames[j].stars) {
			const value = star.flux
			const error = star.fluxError
			if (value === undefined || error === undefined || !Number.isFinite(value) || !(error > 0 && error < Number.POSITIVE_INFINITY)) continue
			if (star.flags !== undefined && star.flags.some((flag) => rejected.has(flag))) continue

			if (star.id === targetId) {
				targetFlux[j] = value
				targetError[j] = error
				targetX[j] = star.x ?? Number.NaN
				targetY[j] = star.y ?? Number.NaN
			} else if (value > 0) {
				const i = index.get(star.id)
				if (i === undefined) continue
				const k = i * frameCount + j
				flux[k] = value
				variance[k] = error * error
				usable[k] = 1
			}
		}
	}

	// Ensemble state. active marks the comparisons still used; accepted marks the measurements combined
	// after per-frame clipping; ratio and weight are the normalized flux and its weight of the last pass.
	const status = new Array<DifferentialComparisonStatus>(comparisonCount)
	const active = new Uint8Array(comparisonCount)
	const reference = new Float64Array(comparisonCount)
	const excess = new Float64Array(comparisonCount)
	const scatter = new Float64Array(comparisonCount).fill(Number.NaN)
	const expected = new Float64Array(comparisonCount).fill(Number.NaN)
	const variability = new Float64Array(comparisonCount).fill(Number.NaN)
	const robustExcess = new Float64Array(comparisonCount).fill(Number.NaN)
	const accepted = new Uint8Array(size)
	const ratio = new Float64Array(size)
	const weight = new Float64Array(size)
	const weightSum = new Float64Array(frameCount)
	const weightedSum = new Float64Array(frameCount)
	const transparency = new Float64Array(frameCount).fill(1)
	const transparencyVariance = new Float64Array(frameCount).fill(Number.NaN)
	const previousTransparency = new Float64Array(frameCount)
	const scratch = new Float64Array(Math.max(frameCount, comparisonCount))
	const scratchVariance = new Float64Array(frameCount)
	const combinedRatio = new Float64Array(frameCount)
	const combinedWeight = new Float64Array(frameCount)
	const rejectedComparisonIds: PhotometryStarId[] = []

	for (let i = 0; i < comparisonCount; i++) {
		let count = 0

		for (let j = 0, k = i * frameCount; j < frameCount; j++, k++) {
			if (usable[k]) scratch[count++] = flux[k]
		}

		status[i] = count > 0 ? 'used' : 'missing'
		active[i] = count > 0 ? 1 : 0
		reference[i] = count > 0 ? medianBySelectionOf(scratch, count) : Number.NaN
	}

	// Combines the active comparisons of every frame with per-frame leave-one-out clipping. The
	// transparencies keep the scale set by the reference fluxes; the unit median is applied on output.
	function ensemble() {
		for (let j = 0; j < frameCount; j++) {
			const previous = Number.isFinite(transparency[j]) ? transparency[j] : 1
			let count = 0
			let sum = 0
			let total = 0

			for (let i = 0, k = j; i < comparisonCount; i++, k += frameCount) {
				accepted[k] = 0
				if (!active[i] || !usable[k]) continue
				const r = flux[k] / reference[i]
				const w = 1 / (variance[k] / (reference[i] * reference[i]) + excess[i] * previous * previous)
				ratio[k] = r
				weight[k] = w
				accepted[k] = 1
				sum += w * r
				total += w
				count++
			}

			// Removes the most deviant comparison while a majority remains to judge it.
			while (count >= MIN_REJECTION_COMPARISONS) {
				let worst = -1
				let worstScore = clipSigma

				for (let i = 0, k = j; i < comparisonCount; i++, k += frameCount) {
					if (!accepted[k]) continue
					const others = total - weight[k]
					if (!(others > 0)) continue
					const score = Math.abs(ratio[k] - (sum - weight[k] * ratio[k]) / others) / Math.sqrt(1 / weight[k] + 1 / others)
					if (score > worstScore) {
						worstScore = score
						worst = k
					}
				}

				if (worst < 0) break
				accepted[worst] = 0
				sum -= weight[worst] * ratio[worst]
				total -= weight[worst]
				count--
			}

			weightSum[j] = count >= minComparisons && count > 0 ? total : 0
			weightedSum[j] = count >= minComparisons && count > 0 ? sum : 0
		}

		for (let j = 0; j < frameCount; j++) {
			if (weightSum[j] > 0) {
				transparency[j] = weightedSum[j] / weightSum[j]
				transparencyVariance[j] = 1 / weightSum[j]
			} else {
				transparency[j] = Number.NaN
				transparencyVariance[j] = Number.NaN
			}
		}
	}

	// Re-derives each reference flux as the weighted least-squares scale of flux = reference * transparency
	// over the frames where the comparison was combined (every usable frame once it is rejected), with
	// the measurement weights. Unlike a median it varies smoothly, so the iteration does not cycle. With
	// rejectedOnly only the rejected comparisons are refitted, and one without a frame with a
	// transparency gets an undefined (NaN) reference instead of keeping a stale one.
	function updateReferences(rejectedOnly: boolean = false) {
		for (let i = 0; i < comparisonCount; i++) {
			if (rejectedOnly && active[i]) continue
			let numerator = 0
			let denominator = 0

			for (let j = 0, k = i * frameCount; j < frameCount; j++, k++) {
				const t = transparency[j]
				if (!usable[k] || !Number.isFinite(t) || (active[i] && !accepted[k])) continue
				numerator += (flux[k] * t) / variance[k]
				denominator += (t * t) / variance[k]
			}

			if (denominator > 0) reference[i] = numerator / denominator
			else if (rejectedOnly) reference[i] = Number.NaN
		}
	}

	// Measures every comparison against the ensemble of the others. The robust scatter statistics over
	// every usable frame decide the rejection; the excess variance weighting the comparison is the
	// DerSimonian-Laird moment estimate over the frames where it was combined (every usable frame once
	// rejected), which varies smoothly
	// with the data, unlike a median, so the iteration settles instead of cycling.
	function measureScatter() {
		for (let i = 0; i < comparisonCount; i++) {
			let count = 0
			let combined = 0

			for (let j = 0, k = i * frameCount; j < frameCount; j++, k++) {
				if (!usable[k] || !(weightSum[j] > 0)) continue
				const own = accepted[k] ? weight[k] : 0
				const others = weightSum[j] - own
				if (!(others > 0)) continue
				const level = (weightedSum[j] - own * ratio[k]) / others
				const d = flux[k] / reference[i] / level
				const relativeVariance = d * d * (variance[k] / (flux[k] * flux[k]) + 1 / (others * level * level))
				scratch[count] = d
				scratchVariance[count++] = relativeVariance

				if (accepted[k] || !active[i]) {
					combinedRatio[combined] = d
					combinedWeight[combined++] = 1 / relativeVariance
				}
			}

			excess[i] = combined >= MIN_SCATTER_FRAMES ? excessVariance(combinedRatio, combinedWeight, combined) : 0

			if (count < MIN_SCATTER_FRAMES) {
				scatter[i] = Number.NaN
				expected[i] = Number.NaN
				robustExcess[i] = Number.NaN
				continue
			}

			const center = medianBySelectionOf(scratch, count)
			for (let n = 0; n < count; n++) scratch[n] = Math.abs(scratch[n] - center)
			const deviation = (STANDARD_DEVIATION_SCALE * medianBySelectionOf(scratch, count)) / center
			const predicted = medianBySelectionOf(scratchVariance, count) / (center * center)
			scatter[i] = deviation
			expected[i] = Math.sqrt(predicted)
			robustExcess[i] = Math.max(deviation * deviation - predicted, 0)
		}

		let count = 0
		for (let i = 0; i < comparisonCount; i++) if (active[i] && Number.isFinite(scatter[i])) scratch[count++] = robustExcess[i]
		const common = count > 0 ? medianBySelectionOf(scratch, count) : 0

		for (let i = 0; i < comparisonCount; i++) {
			variability[i] = Number.isFinite(scatter[i]) ? scatter[i] / Math.sqrt(expected[i] * expected[i] + common) : Number.NaN
		}
	}

	// Rejects the most variable active comparison when it exceeds the limit and a majority remains.
	function rejectVariable() {
		let count = 0
		let worst = -1
		let worstScore = variabilityLimit

		for (let i = 0; i < comparisonCount; i++) {
			if (!active[i] || !Number.isFinite(variability[i])) continue
			count++

			if (variability[i] > worstScore) {
				worstScore = variability[i]
				worst = i
			}
		}

		if (worst < 0 || count < MIN_REJECTION_COMPARISONS) return false
		active[worst] = 0
		status[worst] = 'variable'
		rejectedComparisonIds.push(ids[worst])
		return true
	}

	let iterations = 0
	let converged = false

	while (iterations < maxIterations) {
		if (iterations > 0) updateReferences()
		previousTransparency.set(transparency)
		ensemble()
		measureScatter()
		iterations++
		if (rejectVariable()) continue

		// The common scale of the transparencies and reference fluxes is free and may drift, so the
		// transparencies are compared relative to their mean over the frames.
		const mean = meanTransparency(transparency)
		const previousMean = meanTransparency(previousTransparency)
		let change = 0
		let solved = false

		for (let j = 0; j < frameCount; j++) {
			if (Number.isFinite(transparency[j])) {
				change = Math.max(change, Math.abs(transparency[j] / mean - previousTransparency[j] / previousMean) / (Math.sqrt(transparencyVariance[j]) / mean))
				solved = true
			}
		}

		// Without any transparency there is no solution: further passes cannot change it, and it has not converged.
		if (!solved) break

		if (iterations > 1 && !(change > CONVERGENCE_TOLERANCE)) {
			converged = true
			break
		}
	}

	// The excess variances or the active set changed after the last pass: combine once more.
	if (!converged) {
		updateReferences()
		ensemble()
		measureScatter()
	}

	// Within a set of frames and comparisons linked by shared measurements the reference fluxes fix every
	// transparency to one scale, but two unlinked sets each admit an independent one: multiplying the
	// transparencies of one set by k and dividing its reference fluxes by k leaves every comparison
	// measurement unchanged, so their relative transmission is unmeasured. The connected components of the
	// bipartite graph of frames and active comparisons, joined by every measurement combined in a frame
	// with a transparency, are found by union-find over frameCount + comparisonCount nodes. The reference
	// ensemble is the component with the most such frames, the earliest frame breaking ties; the other
	// frames lose their transparency.
	const parent = new Int32Array(frameCount + comparisonCount)
	for (let n = 0; n < parent.length; n++) parent[n] = n

	// Root of node n, halving the path on the way.
	function root(n: number) {
		while (parent[n] !== n) {
			parent[n] = parent[parent[n]]
			n = parent[n]
		}

		return n
	}

	for (let i = 0; i < comparisonCount; i++) {
		if (!active[i]) continue

		for (let j = 0, k = i * frameCount; j < frameCount; j++, k++) {
			if (accepted[k] && weightSum[j] > 0) parent[root(j)] = root(frameCount + i)
		}
	}

	const componentSize = new Int32Array(frameCount + comparisonCount)
	let referenceRoot = -1

	for (let j = 0; j < frameCount; j++) if (weightSum[j] > 0) componentSize[root(j)]++

	for (let j = 0; j < frameCount; j++) {
		if (weightSum[j] > 0 && (referenceRoot < 0 || componentSize[root(j)] > componentSize[referenceRoot])) referenceRoot = root(j)
	}

	const disconnected = new Uint8Array(frameCount)
	let disconnectedCount = 0

	for (let j = 0; j < frameCount; j++) {
		if (weightSum[j] > 0 && root(j) !== referenceRoot) {
			disconnected[j] = 1
			disconnectedCount++
			weightSum[j] = 0
			weightedSum[j] = 0
			transparency[j] = Number.NaN
			transparencyVariance[j] = Number.NaN
		}
	}

	if (disconnectedCount > 0) {
		// A comparison combined only in the frames of another ensemble has no reference on the series scale.
		for (let i = 0; i < comparisonCount; i++) {
			const r = root(frameCount + i)
			if (active[i] && r !== referenceRoot && componentSize[r] > 0) status[i] = 'disconnected'
		}

		// The rejected comparisons were fitted against every frame; refit them on the reference ensemble.
		updateReferences(true)
	}

	// Fixes the free scale shared by the transparencies and the reference fluxes to a unit median transparency.
	let transparent = 0
	for (let j = 0; j < frameCount; j++) if (weightSum[j] > 0) scratch[transparent++] = transparency[j]
	const scale = transparent > 0 ? medianBySelectionOf(scratch, transparent) : 1

	for (let j = 0; j < frameCount; j++) {
		transparency[j] /= scale
		transparencyVariance[j] /= scale * scale
	}

	// Target series.
	const corrected = new Float64Array(frameCount).fill(Number.NaN)
	const correctedError = new Float64Array(frameCount).fill(Number.NaN)
	let positive = 0

	for (let j = 0; j < frameCount; j++) {
		const t = transparency[j]
		const f = targetFlux[j]
		if (!Number.isFinite(t) || !Number.isFinite(f)) continue
		const value = f / t
		corrected[j] = value
		correctedError[j] = Math.sqrt((targetError[j] / t) ** 2 + (value / t) ** 2 * transparencyVariance[j])
		if (value > 0) scratch[positive++] = value
	}

	const normalization = positive > 0 ? medianBySelectionOf(scratch, positive) : undefined
	const points = new Array<DifferentialLightCurvePoint>(frameCount)

	for (let j = 0; j < frameCount; j++) {
		const flags: DifferentialLightCurveFlag[] = []
		const clippedComparisonIds: PhotometryStarId[] = []
		let combined = 0

		for (let i = 0, k = j; i < comparisonCount; i++, k += frameCount) {
			if (!active[i] || !usable[k]) continue
			if (accepted[k]) combined++
			else clippedComparisonIds.push(ids[i])
		}

		const hasTarget = Number.isFinite(targetFlux[j])
		const hasTransparency = Number.isFinite(transparency[j])
		if (!hasTarget) flags.push('targetMissing')
		else if (!(targetFlux[j] > 0)) flags.push('targetNonPositive')
		if (disconnected[j]) flags.push('disconnected')
		else if (!hasTransparency) flags.push('noComparisons')
		if (clippedComparisonIds.length > 0) flags.push('comparisonClipped')

		const value = corrected[j]
		const error = correctedError[j]
		const relativeFlux = normalization !== undefined && Number.isFinite(value) ? value / normalization : undefined
		const relativeFluxError = relativeFlux !== undefined ? error / normalization! : undefined
		const magnitude = relativeFlux !== undefined && relativeFlux > 0 ? differentialMagnitude(relativeFlux) : undefined
		const magnitudeError = magnitude !== undefined ? (MAGNITUDE_ERROR_SCALE * relativeFluxError!) / relativeFlux! : undefined

		points[j] = {
			time: frames[j].time,
			targetFlux: hasTarget ? targetFlux[j] : undefined,
			targetFluxError: hasTarget ? targetError[j] : undefined,
			transparency: hasTransparency ? transparency[j] : undefined,
			transparencyError: hasTransparency ? Math.sqrt(transparencyVariance[j]) : undefined,
			comparisonCount: hasTransparency ? combined : 0,
			clippedComparisonIds,
			flux: Number.isFinite(value) ? value : undefined,
			fluxError: Number.isFinite(value) ? error : undefined,
			relativeFlux,
			relativeFluxError,
			magnitude,
			magnitudeError,
			flags,
		}
	}

	const comparisons = new Array<DifferentialComparisonStar>(comparisonCount)

	for (let i = 0; i < comparisonCount; i++) {
		let frameCountUsable = 0
		let clippedCount = 0
		let weightTotal = 0
		let weightFrames = 0

		for (let j = 0, k = i * frameCount; j < frameCount; j++, k++) {
			if (!usable[k]) continue
			frameCountUsable++
			if (!active[i]) continue

			if (accepted[k] && weightSum[j] > 0) {
				weightTotal += weight[k] / weightSum[j]
				weightFrames++
			} else if (!accepted[k]) {
				clippedCount++
			}
		}

		const measured = Number.isFinite(scatter[i])

		comparisons[i] = {
			id: ids[i],
			status: status[i],
			referenceFlux: status[i] === 'disconnected' || !Number.isFinite(reference[i]) ? undefined : reference[i] * scale,
			frameCount: frameCountUsable,
			clippedCount,
			weight: weightFrames > 0 ? weightTotal / weightFrames : 0,
			scatter: measured ? scatter[i] : undefined,
			expectedScatter: measured ? expected[i] : undefined,
			excessScatter: measured ? Math.sqrt(excess[i]) : undefined,
			variability: measured ? variability[i] : undefined,
		}
	}

	const detrending = detrend === undefined ? undefined : detrendLightCurve(points, frames, targetX, targetY, detrend)
	return { targetId, timescale, points, comparisons, rejectedComparisonIds, normalization, iterations, converged, detrending }
}

// DerSimonian-Laird (1986) moment estimate of the variance in excess of the measurement variances,
// max((Q - (n - 1)) / (W - sum(w^2) / W), 0), of the first count values with inverse-variance weights,
// where Q is the weighted sum of squared deviations from the weighted mean and W the weight sum.
function excessVariance(values: Readonly<Float64Array>, weights: Readonly<Float64Array>, count: number) {
	let total = 0
	let totalSq = 0
	let mean = 0

	for (let n = 0; n < count; n++) {
		const w = weights[n]
		total += w
		totalSq += w * w
		mean += w * values[n]
	}

	mean /= total
	let q = 0
	for (let n = 0; n < count; n++) q += weights[n] * (values[n] - mean) ** 2
	const denominator = total - totalSq / total
	return denominator > 0 ? Math.max((q - (count - 1)) / denominator, 0) : 0
}

// Differential magnitude -2.5 log10(relativeFlux) of a positive relative flux; adding 0 reports the
// reference level as 0 instead of -0.
function differentialMagnitude(relativeFlux: number) {
	return -2.5 * Math.log10(relativeFlux) + 0
}

// Mean of the finite transparencies, or 1 when there is none.
function meanTransparency(transparency: Readonly<Float64Array>) {
	let sum = 0
	let count = 0

	for (let j = 0; j < transparency.length; j++) {
		const t = transparency[j]

		if (Number.isFinite(t)) {
			sum += t
			count++
		}
	}

	return count > 0 ? sum / count : 1
}

// Fits the relative flux of the epochs with every covariate to a robust weighted linear model and
// replaces each point by a copy carrying its detrended value, relativeFlux * intercept / model, which
// keeps the series level at the mean covariates. Mutates the points array, never the point objects.
function detrendLightCurve(points: DifferentialLightCurvePoint[], frames: readonly DifferentialPhotometryFrame[], targetX: Readonly<Float64Array>, targetY: Readonly<Float64Array>, { covariates, method = 'huber' }: DifferentialDetrendOptions): DifferentialDetrending {
	const covariateCount = covariates.length
	const values = new Float64Array(points.length * covariateCount)
	const included = new Uint8Array(points.length)
	const means = new Float64Array(covariateCount)
	let pointCount = 0

	for (let j = 0; j < points.length; j++) {
		if (points[j].relativeFlux === undefined) continue
		let complete = true

		for (let c = 0; c < covariateCount; c++) {
			const covariate = covariates[c]
			const value = covariate === 'airmass' ? frames[j].airmass : covariate === 'fwhm' ? frames[j].fwhm : covariate === 'x' ? targetX[j] : targetY[j]
			if (value === undefined || !Number.isFinite(value)) complete = false
			else values[j * covariateCount + c] = value
		}

		if (!complete) continue
		included[j] = 1
		pointCount++
		for (let c = 0; c < covariateCount; c++) means[c] += values[j * covariateCount + c]
	}

	let fit: DifferentialDetrendFit | undefined

	if (pointCount > covariateCount + 1) {
		for (let c = 0; c < covariateCount; c++) means[c] /= pointCount
		const design = new Array<Float64Array>(pointCount)
		const target = new Float64Array(pointCount)
		const weights = new Float64Array(pointCount)
		let n = 0

		for (let j = 0; j < points.length; j++) {
			if (!included[j]) continue
			const row = new Float64Array(covariateCount + 1)
			row[0] = 1
			for (let c = 0; c < covariateCount; c++) row[c + 1] = values[j * covariateCount + c] - means[c]
			design[n] = row
			target[n] = points[j].relativeFlux!
			weights[n++] = 1 / points[j].relativeFluxError! ** 2
		}

		const result = robustLinearLeastSquares(design, target, { weights, method, tuning: method === 'tukey' ? TUKEY_TUNING : HUBER_TUNING })
		const intercept = result.coefficients[0]
		const coefficients = Array.from(result.coefficients.slice(1))
		const before = new Float64Array(pointCount)
		const after = new Float64Array(pointCount)
		let detrendedCount = 0

		for (let j = 0, n = 0; j < points.length; j++) {
			if (!included[j]) continue
			const point = points[j]
			const model = result.fitted[n++]
			if (!(model > 0 && intercept > 0)) continue
			const factor = intercept / model
			const relativeFlux = point.relativeFlux! * factor
			const relativeFluxError = point.relativeFluxError! * factor
			const magnitude = relativeFlux > 0 ? differentialMagnitude(relativeFlux) : undefined
			const magnitudeError = magnitude !== undefined ? (MAGNITUDE_ERROR_SCALE * relativeFluxError) / relativeFlux : undefined
			points[j] = { ...point, detrended: { relativeFlux, relativeFluxError, magnitude, magnitudeError } }
			before[detrendedCount] = point.relativeFlux!
			after[detrendedCount++] = relativeFlux
		}

		const scatterBefore = standardDeviationOf(before, detrendedCount)
		const scatterAfter = standardDeviationOf(after, detrendedCount)
		fit = { intercept, coefficients, means: Array.from(means), conditionNumber: result.conditionNumber, rankDeficient: result.rankDeficient, scatterBefore, scatterAfter }
	}

	for (let j = 0; j < points.length; j++) {
		const point = points[j]
		if (point.relativeFlux !== undefined && point.detrended === undefined) points[j] = { ...point, flags: [...point.flags, 'notDetrended'] }
	}

	return { covariates, pointCount, fit }
}
