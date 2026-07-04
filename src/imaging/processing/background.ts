import type { Writable } from '../../core/types'
import { medianOf, STANDARD_DEVIATION_SCALE } from '../../core/util'
import { Matrix, QrDecomposition } from '../../math/linear-algebra/matrix'
import { clamp } from '../../math/numerical/math'
import type { Image, ImageRawType } from '../model/types'
import { clone } from './transformation'

// Automatic Background Extraction (ABE): models a smooth sky background from a grid of robust
// samples and removes it, correcting gradients, vignetting, and light pollution. The background is
// approximated by a low-degree 2D polynomial surface (tensor Chebyshev basis) fitted by weighted
// least squares to per-box median samples (reliable low-dispersion boxes count more), with
// structure (stars, nebulae) rejected first by high internal box dispersion and then
// iteratively by fit residuals. The fitted surface is either subtracted (additive gradients/light
// pollution) or divided out (multiplicative vignetting). Color images fit each channel independently.
// https://pixinsight.com/doc/tools/AutomaticBackgroundExtractor/AutomaticBackgroundExtractor.html

// How the fitted background surface is removed from the source image.
// - `subtract`: additive removal for gradients and light pollution.
// - `divide`: multiplicative removal for vignetting and flat-field residuals.
// - `none`: leave the source untouched and only return the modeled background.
export type BackgroundExtractionCorrection = 'subtract' | 'divide' | 'none'

// How out-of-range corrected values are brought back into [0, 1] after a subtract/divide correction.
// Mirrors the background neutralization modes.
// - `truncate`: clamp to [0, 1]; simplest, but clips signal that overshoots the range.
// - `rescale`: always linearly rescale the channel from its [min, max] to [0, 1].
// - `rescaleAsNeeded`: rescale only when the correction produced values outside [0, 1].
export type BackgroundExtractionClipping = 'truncate' | 'rescale' | 'rescaleAsNeeded'

// Options controlling automatic background extraction. All fields are optional and fall back to
// `DEFAULT_BACKGROUND_EXTRACTION_OPTIONS`.
export interface BackgroundExtractionOptions {
	// Number of sample boxes along the longer image axis; the shorter axis scales to keep boxes
	// roughly square. Higher values capture finer gradients but need more clean sky. Valid range >= 2.
	readonly gridSize?: number
	// Side length in pixels of each square sample box. When 0 (default) it is derived from the grid
	// cell size (half a cell), which trades statistics for lower contamination from nearby structure.
	readonly boxSize?: number
	// Degree of the fitted 2D polynomial surface. Clamped to 1..6. Requires at least
	// (degree+1)*(degree+2)/2 accepted samples per channel.
	readonly degree?: number
	// Sigma multiple for rejecting contaminated boxes by internal dispersion: a box is discarded when
	// its normalized MAD exceeds median(MAD) + tolerance*MAD-of-MADs across boxes. Lower is stricter.
	readonly tolerance?: number
	// Sigma multiple for rejecting samples that sit ABOVE the fitted surface (residual > 0), i.e.
	// structure such as stars, nebulae, or galaxies contaminating a box. Kept tight because the sky
	// background is the lower envelope of the data. Applied per iteration against the residual MAD.
	readonly rejectionHigh?: number
	// Sigma multiple for rejecting samples that sit BELOW the fitted surface (residual < 0). Kept
	// looser than `rejectionHigh` since dark samples are usually the cleanest sky; only gross low
	// outliers (dead/cold pixels) should be dropped. Applied per iteration against the residual MAD.
	readonly rejectionLow?: number
	// Number of fit / reject / refit iterations. 0 disables residual rejection.
	readonly rejectionIterations?: number
	// How the modeled background is removed from the source. See `BackgroundExtractionCorrection`.
	readonly correction?: BackgroundExtractionCorrection
	// How out-of-range corrected values are handled. See `BackgroundExtractionClipping`. Ignored when
	// correction is `none`.
	readonly clipping?: BackgroundExtractionClipping
	// Level re-established after correction to preserve overall brightness, in [0, 1]. For `subtract`
	// it is the background pedestal re-added after removing the surface; for `divide` it is the target
	// flat level the quotient is scaled to. When undefined the per-channel model mean is used.
	readonly targetBackground?: number
}

// Fitted background model for a single channel.
export interface BackgroundExtractionChannelModel {
	// Surface coefficients ordered by ascending total degree, indexing the tensor Chebyshev basis
	// T_i(u) * T_j(v) with i + j <= degree and normalized coordinates u, v in [-1, 1].
	readonly coefficients: Float64Array
	// Number of grid samples that survived rejection and fed the final fit.
	readonly acceptedSamples: number
	// Number of grid samples discarded as structure (internal dispersion or residual rejection).
	readonly rejectedSamples: number
	// Robust dispersion (normalized MAD) of the final fit residuals, a quality indicator.
	readonly residual: number
	// Minimum corrected pixel value of this channel before clipping, or undefined when correction is
	// `none`. With `outputMax` it reveals how far the correction pushed values outside [0, 1].
	readonly outputMin?: number
	// Maximum corrected pixel value of this channel before clipping, or undefined when correction is
	// `none`.
	readonly outputMax?: number
}

// Result of `automaticBackgroundExtraction`.
export interface BackgroundExtractionResult {
	// The corrected image. Same object as the input (mutated in place) unless correction is `none`.
	readonly image: Image
	// The modeled background as a fresh image with the same shape as the input.
	readonly background: Image
	// Per-channel fitted models, one entry per image channel.
	readonly channels: readonly BackgroundExtractionChannelModel[]
}

// Default automatic background extraction options.
export const DEFAULT_BACKGROUND_EXTRACTION_OPTIONS: Required<Omit<BackgroundExtractionOptions, 'targetBackground'>> = {
	gridSize: 24,
	boxSize: 0,
	degree: 4,
	tolerance: 3,
	rejectionHigh: 2.5,
	rejectionLow: 4,
	rejectionIterations: 2,
	correction: 'subtract',
	clipping: 'truncate',
}

// One grid sample: the robust background estimate at a box center, in normalized coordinates.
interface BackgroundSample {
	// Box center x mapped to [-1, 1].
	u: number
	// Box center y mapped to [-1, 1].
	v: number
	// Robust background value (box median) of the sampled channel.
	value: number
	// Internal box dispersion (normalized MAD), used for structure rejection and weighting.
	dispersion: number
	// Least-squares weight in (0, 1]: reliable (low-dispersion) boxes count more than noisy ones.
	weight: number
	// Whether the sample is currently active in the fit (cleared by rejection passes).
	active: boolean
}

// Small epsilon guarding the multiplicative correction from division by a near-zero model value.
const DIVIDE_EPSILON = 1e-6

// Number of polynomial basis terms for a 2D surface of the given total degree: (d+1)*(d+2)/2.
function basisTermCount(degree: number) {
	return ((degree + 1) * (degree + 2)) / 2
}

// Fills `ti`/`tj` with the (i, j) index pairs of the tensor basis T_i(u) * T_j(v) ordered by
// ascending total degree i + j. Returns the number of terms written.
function fillBasisExponents(degree: number, ti: Uint8Array, tj: Uint8Array) {
	let k = 0

	for (let d = 0; d <= degree; d++) {
		for (let i = d; i >= 0; i--) {
			ti[k] = i
			tj[k] = d - i
			k++
		}
	}

	return k
}

// Fills `out[offset..offset+degree]` with Chebyshev polynomials of the first kind T_0..T_degree at
// `x` (expected in [-1, 1]) via the recurrence T_0 = 1, T_1 = x, T_d = 2x*T_{d-1} - T_{d-2}. The
// surface basis is the tensor product T_i(u)*T_j(v); Chebyshev polynomials are orthogonal on
// [-1, 1], so the least-squares design matrix is far better conditioned than with raw monomials
// u^i*v^j, which keeps the fit stable at higher degrees.
function fillChebyshev(out: Float64Array, offset: number, x: number, degree: number) {
	out[offset] = 1
	if (degree >= 1) out[offset + 1] = x
	const x2 = 2 * x
	for (let d = 2; d <= degree; d++) out[offset + d] = x2 * out[offset + d - 1] - out[offset + d - 2]
}

// Robust center and dispersion of the first `count` values in `buf`. Sorts `buf` in place and uses
// `dev` as scratch for absolute deviations. Returns the median and the normalized MAD (comparable to
// a standard deviation). Both are NaN when `count` is 0.
function boxStatistics(buf: Float64Array, dev: Float64Array, count: number) {
	if (count === 0) return [Number.NaN, Number.NaN]

	buf.subarray(0, count).sort()
	const median = medianOf(buf, count)

	for (let i = 0; i < count; i++) dev[i] = Math.abs(buf[i] - median)
	dev.subarray(0, count).sort()

	return [median, STANDARD_DEVIATION_SCALE * medianOf(dev, count)] as const
}

// Collects grid samples for one channel. Divides the image into a grid of roughly square cells,
// estimates a robust background per box, and rejects boxes whose internal dispersion marks them as
// contaminated by stars or nebulae. Coordinates are normalized to [-1, 1] for a well-conditioned fit.
function collectSamples(raw: ImageRawType, width: number, height: number, channels: number, channel: number, gridSize: number, boxSize: number, tolerance: number) {
	const longAxis = Math.max(width, height)
	const cell = longAxis / gridSize
	const nx = Math.max(1, Math.round(width / cell))
	const ny = Math.max(1, Math.round(height / cell))
	const cellW = width / nx
	const cellH = height / ny

	// Derive the box half-size from the smaller cell edge when not given explicitly (half a cell).
	const boxHalf = boxSize > 0 ? boxSize / 2 : Math.max(1.5, Math.min(cellW, cellH) * 0.25)

	// Scratch buffers sized to the largest possible box, reused across every box.
	const maxBox = Math.ceil(2 * boxHalf + 1)
	const buf = new Float64Array(maxBox * maxBox)
	const dev = new Float64Array(maxBox * maxBox)

	const invW = width > 1 ? 2 / (width - 1) : 0
	const invH = height > 1 ? 2 / (height - 1) : 0

	const samples: BackgroundSample[] = []

	for (let r = 0; r < ny; r++) {
		const cy = (r + 0.5) * cellH
		const y0 = Math.max(0, Math.floor(cy - boxHalf))
		const y1 = Math.min(height - 1, Math.ceil(cy + boxHalf))

		for (let c = 0; c < nx; c++) {
			const cx = (c + 0.5) * cellW
			const x0 = Math.max(0, Math.floor(cx - boxHalf))
			const x1 = Math.min(width - 1, Math.ceil(cx + boxHalf))

			let count = 0

			for (let y = y0; y <= y1; y++) {
				let i = (y * width + x0) * channels + channel

				for (let x = x0; x <= x1; x++, i += channels) {
					const p = raw[i]
					if (Number.isFinite(p)) buf[count++] = p
				}
			}

			if (count === 0) continue

			const [median, dispersion] = boxStatistics(buf, dev, count)
			if (!Number.isFinite(median)) continue

			samples.push({
				u: (c + 0.5) * cellW * invW - 1,
				v: (r + 0.5) * cellH * invH - 1,
				value: median,
				dispersion: Number.isFinite(dispersion) ? dispersion : 0,
				weight: 1,
				active: true,
			})
		}
	}

	if (samples.length === 0) return samples

	// Robust statistics of the per-box internal dispersions, used both for weighting and rejection.
	const disp = new Float64Array(samples.length)
	for (let i = 0; i < samples.length; i++) disp[i] = samples[i].dispersion
	const scratch = new Float64Array(samples.length)
	const [medDisp, madDisp] = boxStatistics(disp, scratch, samples.length)

	// Weight each sample by reliability: w = floor^2 / (dispersion^2 + floor^2), bounded to (0, 1].
	// Clean boxes (dispersion << floor) approach 1; noisy boxes are down-weighted. The floor is the
	// median dispersion, so weighting adapts to the image noise; a degenerate all-flat image (median
	// dispersion 0) falls back to equal unit weights.
	const floor = medDisp > 0 && Number.isFinite(medDisp) ? medDisp : 0
	const floorSq = floor * floor
	if (floorSq > 0) {
		for (const sample of samples) {
			const d = sample.dispersion
			sample.weight = floorSq / (d * d + floorSq)
		}
	}

	// Reject contaminated boxes by internal dispersion: structure inflates the box MAD well above the
	// typical sky box. The threshold is itself robust (median + tolerance * MAD of the dispersions), so
	// it adapts to the image noise instead of assuming a fixed level.
	if (tolerance > 0) {
		const limit = medDisp + tolerance * (madDisp > 0 ? madDisp : medDisp)

		if (Number.isFinite(limit)) {
			for (const sample of samples) {
				if (sample.dispersion > limit) sample.active = false
			}
		}
	}

	return samples
}

// Fits a 2D Chebyshev surface to the currently active samples by least squares (QR). Returns the
// coefficient vector, or undefined when there are too few samples or the system is rank deficient.
function fitSurface(samples: readonly BackgroundSample[], degree: number, terms: number, ti: Uint8Array, tj: Uint8Array) {
	let m = 0
	for (const sample of samples) if (sample.active) m++
	if (m < terms) return undefined

	const A = new Matrix(m, terms)
	const b = new Float64Array(m)
	const data = A.data
	const uCheb = new Float64Array(degree + 1)
	const vCheb = new Float64Array(degree + 1)

	let row = 0

	for (const sample of samples) {
		if (!sample.active) continue

		fillChebyshev(uCheb, 0, sample.u, degree)
		fillChebyshev(vCheb, 0, sample.v, degree)

		// Weighted least squares: scaling each equation (design row and right-hand side) by sqrt(weight)
		// makes QR minimize the weighted residual sum, giving reliable low-dispersion boxes more pull.
		const w = Math.sqrt(sample.weight)
		const base = row * terms
		for (let k = 0; k < terms; k++) data[base + k] = w * uCheb[ti[k]] * vCheb[tj[k]]
		b[row] = w * sample.value
		row++
	}

	try {
		const qr = new QrDecomposition(A)
		if (!qr.isFullRank) return undefined
		// solve() returns a vector sized to the sample count (rows); only the first `terms` entries are
		// the least-squares coefficients, the rest are residual internals. Copy just the coefficients.
		return qr.solve(b).slice(0, terms)
	} catch {
		return undefined
	}
}

// Evaluates the Chebyshev surface at a normalized point, using `uCheb`/`vCheb` as reusable scratch.
function evaluateSurface(coefficients: Float64Array, u: number, v: number, degree: number, terms: number, ti: Uint8Array, tj: Uint8Array, uCheb: Float64Array, vCheb: Float64Array) {
	fillChebyshev(uCheb, 0, u, degree)
	fillChebyshev(vCheb, 0, v, degree)

	let sum = 0
	for (let k = 0; k < terms; k++) sum += coefficients[k] * uCheb[ti[k]] * vCheb[tj[k]]
	return sum
}

// Fits the background surface for one channel with iterative residual rejection, then writes the
// evaluated model into `model` at the channel offset and returns the channel fit summary.
function modelChannel(raw: ImageRawType, model: ImageRawType, width: number, height: number, channels: number, channel: number, options: Required<Omit<BackgroundExtractionOptions, 'targetBackground'>>, ti: Uint8Array, tj: Uint8Array): BackgroundExtractionChannelModel {
	const { gridSize, boxSize, degree, tolerance, rejectionHigh, rejectionLow, rejectionIterations } = options
	const terms = basisTermCount(degree)
	const samples = collectSamples(raw, width, height, channels, channel, gridSize, boxSize, tolerance)

	let coefficients = fitSurface(samples, degree, terms, ti, tj)
	if (coefficients === undefined) throw new Error(`not enough clean background samples to fit a degree-${degree} surface (need at least ${terms})`)

	const residuals = new Float64Array(samples.length)
	const residualScratch = new Float64Array(samples.length)
	const uCheb = new Float64Array(degree + 1)
	const vCheb = new Float64Array(degree + 1)
	let residualDispersion = 0

	// Iteratively reject residual outliers and refit until the iteration budget is spent or nothing is
	// rejected. Rejection is asymmetric: the sky background is the lower envelope of the data, so
	// samples above the surface (contaminating structure) are rejected with a tight sigma while samples
	// below it (usually the cleanest sky) are only dropped when they are gross low outliers.
	for (let iteration = 0; iteration <= rejectionIterations; iteration++) {
		let count = 0
		for (const sample of samples) {
			if (!sample.active) continue
			residuals[count++] = sample.value - evaluateSurface(coefficients, sample.u, sample.v, degree, terms, ti, tj, uCheb, vCheb)
		}

		// Robust residual spread; medianOf needs sorted input, so copy before sorting to keep the
		// residual-to-sample correspondence below intact.
		residualScratch.set(residuals.subarray(0, count))
		residualScratch.subarray(0, count).sort()
		const median = medianOf(residualScratch, count)
		for (let i = 0; i < count; i++) residualScratch[i] = Math.abs(residualScratch[i] - median)
		residualScratch.subarray(0, count).sort()
		residualDispersion = STANDARD_DEVIATION_SCALE * medianOf(residualScratch, count)

		if (iteration === rejectionIterations || !Number.isFinite(residualDispersion) || residualDispersion === 0) break

		const highLimit = rejectionHigh * residualDispersion
		const lowLimit = rejectionLow * residualDispersion
		let rejected = 0
		let index = 0
		for (const sample of samples) {
			if (!sample.active) continue
			// residual = sample - surface: positive above the surface (structure), negative below it.
			const residual = residuals[index]
			if (residual > highLimit || residual < -lowLimit) {
				sample.active = false
				rejected++
			}
			index++
		}

		if (rejected === 0) break

		const refit = fitSurface(samples, degree, terms, ti, tj)
		if (refit === undefined) break
		coefficients = refit
	}

	// Evaluate the fitted surface at every pixel of this channel. Precompute per-column Chebyshev
	// values so the inner loop only multiplies against the per-row Chebyshev values.
	const invW = width > 1 ? 2 / (width - 1) : 0
	const invH = height > 1 ? 2 / (height - 1) : 0
	const uChebTable = new Float64Array(width * (degree + 1))

	for (let x = 0; x < width; x++) {
		fillChebyshev(uChebTable, x * (degree + 1), x * invW - 1, degree)
	}

	const vRow = new Float64Array(degree + 1)

	for (let y = 0; y < height; y++) {
		fillChebyshev(vRow, 0, y * invH - 1, degree)

		let i = y * width * channels + channel

		for (let x = 0; x < width; x++, i += channels) {
			const base = x * (degree + 1)
			let sum = 0
			for (let k = 0; k < terms; k++) sum += coefficients[k] * uChebTable[base + ti[k]] * vRow[tj[k]]
			model[i] = sum
		}
	}

	let accepted = 0
	for (const sample of samples) if (sample.active) accepted++

	return {
		coefficients,
		acceptedSamples: accepted,
		rejectedSamples: samples.length - accepted,
		residual: Number.isFinite(residualDispersion) ? residualDispersion : 0,
	}
}

// Mean of one channel plane of a background model.
function channelMean(model: ImageRawType, width: number, height: number, channels: number, channel: number) {
	const n = width * height
	let sum = 0
	for (let p = 0, i = channel; p < n; p++, i += channels) sum += model[i]
	return sum / n
}

// Brings the corrected values of one channel back into [0, 1] according to the clipping mode.
// `min`/`max` are the finite value range the correction produced. A `rescale` (or a needed
// `rescaleAsNeeded`) linearly maps [min, max] to [0, 1]; otherwise, or when the range is degenerate,
// values are simply clamped.
function applyClipping(raw: ImageRawType, channel: number, channels: number, n: number, clipping: BackgroundExtractionClipping, min: number, max: number) {
	const rescale = clipping === 'rescale' || (clipping === 'rescaleAsNeeded' && (min < 0 || max > 1))

	if (rescale && max > min) {
		const inv = 1 / (max - min)
		for (let p = 0, i = channel; p < n; p++, i += channels) raw[i] = clamp((raw[i] - min) * inv, 0, 1)
	} else {
		for (let p = 0, i = channel; p < n; p++, i += channels) raw[i] = clamp(raw[i], 0, 1)
	}
}

// Extracts and removes a smooth sky background from an image.
//
// Builds a grid of robust background samples, rejects those contaminated by stars or nebulae, fits a
// low-degree 2D polynomial surface per channel, and removes it by subtraction (gradients, light
// pollution) or division (vignetting). Samples and the fit use coordinates normalized to [-1, 1].
//
// The source `image` is mutated in place with the corrected pixels unless `correction` is `none`.
// The returned `background` is always a fresh image holding the fitted model. After a
// `subtract`/`divide` correction the per-channel level is restored to `targetBackground` (or the
// channel model mean when omitted) so overall brightness is preserved, and out-of-range values are
// brought back into [0, 1] per the `clipping` mode (truncate or rescale). Each channel model reports
// the pre-clipping value range in `outputMin`/`outputMax`.
//
// Throws when a channel has fewer clean samples than the polynomial degree requires.
export function automaticBackgroundExtraction(image: Image, options: BackgroundExtractionOptions = DEFAULT_BACKGROUND_EXTRACTION_OPTIONS): BackgroundExtractionResult {
	const gridSize = Math.max(2, Math.trunc(options.gridSize ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.gridSize))
	const boxSize = Math.max(0, options.boxSize ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.boxSize)
	const degree = clamp(Math.trunc(options.degree ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.degree), 1, 6)
	const tolerance = Math.max(0, options.tolerance ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.tolerance)
	const rejectionHigh = Math.max(0, options.rejectionHigh ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.rejectionHigh)
	const rejectionLow = Math.max(0, options.rejectionLow ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.rejectionLow)
	const rejectionIterations = Math.max(0, Math.trunc(options.rejectionIterations ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.rejectionIterations))
	const correction = options.correction ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.correction
	const clipping = options.clipping ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.clipping

	const resolved = { gridSize, boxSize, degree, tolerance, rejectionHigh, rejectionLow, rejectionIterations, correction, clipping }

	const { raw, metadata } = image
	const { width, height, channels } = metadata

	const background = clone(image)
	const model = background.raw

	const terms = basisTermCount(degree)
	const ti = new Uint8Array(terms)
	const tj = new Uint8Array(terms)
	fillBasisExponents(degree, ti, tj)

	const channelModels: BackgroundExtractionChannelModel[] = []

	for (let channel = 0; channel < channels; channel++) {
		channelModels.push(modelChannel(raw, model, width, height, channels, channel, resolved, ti, tj))
	}

	if (correction !== 'none') {
		for (let channel = 0; channel < channels; channel++) {
			const target = options.targetBackground !== undefined && Number.isFinite(options.targetBackground) ? clamp(options.targetBackground, 0, 1) : channelMean(model, width, height, channels, channel)
			const n = width * height

			// First pass: write the unclamped corrected values and track their finite range so the
			// clipping step can rescale instead of blindly truncating out-of-range signal.
			let min = Number.POSITIVE_INFINITY
			let max = Number.NEGATIVE_INFINITY

			if (correction === 'subtract') {
				for (let p = 0, i = channel; p < n; p++, i += channels) {
					const v = raw[i] - model[i] + target
					raw[i] = v
					if (Number.isFinite(v)) {
						if (v < min) min = v
						if (v > max) max = v
					}
				}
			} else {
				for (let p = 0, i = channel; p < n; p++, i += channels) {
					const denom = model[i]
					const v = (raw[i] / (Math.abs(denom) < DIVIDE_EPSILON ? (denom < 0 ? -DIVIDE_EPSILON : DIVIDE_EPSILON) : denom)) * target
					raw[i] = v
					if (Number.isFinite(v)) {
						if (v < min) min = v
						if (v > max) max = v
					}
				}
			}

			// Second pass: clamp or rescale into [0, 1] per the clipping mode.
			applyClipping(raw, channel, channels, n, clipping, min, max)

			const channelModel = channelModels[channel] as Writable<BackgroundExtractionChannelModel>
			channelModel.outputMin = Number.isFinite(min) ? min : Number.NaN
			channelModel.outputMax = Number.isFinite(max) ? max : Number.NaN
		}
	}

	return { image, background, channels: channelModels }
}
