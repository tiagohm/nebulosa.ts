import { medianOf, STANDARD_DEVIATION_SCALE, standardDeviationOf } from '../../core/util'
import { LuDecomposition, Matrix, QrDecomposition } from '../../math/linear-algebra/matrix'
import { clamp, type NumberArray } from '../../math/numerical/math'
import { DEFAULT_GRAYSCALE, type Image, type ImageRawType } from '../model/types'
import type { DetectedStar } from '../stars/detector'

// Automatic Background Extraction (ABE/DBE): models a smooth sky background from a grid of robust
// samples and removes it, correcting gradients, vignetting, and light pollution. The background is
// approximated either by a low-degree 2D polynomial surface (tensor Chebyshev basis, ABE) or by a
// smoothing thin-plate spline through the samples (DBE) for complex non-monotonic backgrounds. The
// grid samples are per-box medians weighted by reliability (low-dispersion boxes count more), with
// structure (stars, nebulae) rejected first by high internal box dispersion and then iteratively by
// polynomial-fit residuals. The fitted surface is either subtracted (additive gradients/light
// pollution) or divided out (multiplicative vignetting). Color images fit each channel independently
// by default, or share a single luminance surface across channels (`colorMode: 'luminance'`).
// An optional exclusion mask (e.g. built from detected stars) keeps large objects out of the sample
// grid. The fit exposes its grid samples (positions, values, weights, acceptance) for inspection.
// https://pixinsight.com/doc/tools/AutomaticBackgroundExtractor/AutomaticBackgroundExtractor.html
// https://pixinsight.com/doc/tools/DynamicBackgroundExtraction/DynamicBackgroundExtraction.html

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

// The surface model used to represent the background.
// - `polynomial`: a global low-degree 2D Chebyshev surface; cheap, best for smooth gradients and
//   vignetting, but cannot follow complex non-monotonic backgrounds without oscillating.
// - `thinPlateSpline`: a smoothing thin-plate spline through the accepted samples; follows arbitrary
//   smooth backgrounds (localized light-pollution domes, irregular gradients) at higher fit and
//   evaluation cost. Outlier rejection still uses the polynomial pre-fit.
export type BackgroundModelType = 'polynomial' | 'thinPlateSpline'

// How color images are modeled.
// - `perChannel`: fit an independent surface per channel; removes differential color gradients such
//   as chromatic light pollution. The right choice for additive (`subtract`) correction.
// - `luminance`: fit a single surface on the luminance plane and apply it to every channel. Removes a
//   shared achromatic component while preserving color, and avoids per-channel fit noise. Best paired
//   with `divide` for achromatic vignetting. Falls back to `perChannel` for non-RGB images.
export type BackgroundColorMode = 'perChannel' | 'luminance'

// Options controlling automatic background extraction. All fields are optional and fall back to
// `DEFAULT_BACKGROUND_EXTRACTION_OPTIONS`.
export interface BackgroundExtractionOptions {
	// Number of sample boxes along the longer image axis; the shorter axis scales to keep boxes
	// roughly square. Higher values capture finer gradients but need more clean sky. Valid range >= 2.
	readonly gridSize?: number
	// Side length in pixels of each square sample box. When 0 (default) it is derived from the grid
	// cell size (half a cell), which trades statistics for lower contamination from nearby structure.
	readonly boxSize?: number
	// Surface model used to represent the background. See `BackgroundModelType`. Default `polynomial`.
	readonly model?: BackgroundModelType
	// How color (RGB) images are modeled. See `BackgroundColorMode`. Default `perChannel`. Ignored for
	// single-channel images.
	readonly colorMode?: BackgroundColorMode
	// Degree of the fitted 2D polynomial surface (also the surface used for outlier rejection in
	// `thinPlateSpline` mode). Clamped to 1..6. Requires at least (degree+1)*(degree+2)/2 accepted
	// samples per channel.
	readonly degree?: number
	// Thin-plate spline smoothing (regularization) applied on the diagonal of the TPS system, scaled by
	// each sample's inverse weight. 0 interpolates every sample exactly (chases box-median noise);
	// larger values relax to a smoother surface. Ignored for the polynomial model.
	readonly smoothing?: number
	// Sigma multiple for rejecting contaminated boxes by internal dispersion: a box is discarded when
	// its normalized MAD exceeds median(MAD) + tolerance*MAD-of-MADs across boxes. Lower is stricter.
	readonly tolerance?: number
	// Optional pixel exclusion mask, row-major with length width*height. Pixels with a nonzero value are
	// skipped during sampling, keeping large objects (bright nebulae, galaxies) or stars out of the
	// background estimate. Build one from detected stars with `backgroundExclusionMaskFromStars`.
	readonly exclusionMask?: Readonly<NumberArray>
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

// One grid sample of the fitted background, in pixel coordinates, exposed for inspection (e.g. drawing
// the sample boxes in a UI) or manual review.
export interface BackgroundSample {
	// Box center x in pixels.
	readonly x: number
	// Box center y in pixels.
	readonly y: number
	// Robust background value (box median) of the channel at this box.
	readonly value: number
	// Least-squares weight in (0, 1]: reliable (low-dispersion) boxes count more.
	readonly weight: number
	// Whether the sample fed the final fit (false when rejected as structure or a residual outlier).
	readonly accepted: boolean
}

// A fitted background surface for one channel: the Chebyshev coefficients plus fit diagnostics.
// Independent of any correction and reusable through `evaluateBackgroundModel`.
export interface BackgroundSurfaceFit {
	// Surface coefficients. For `polynomial`, the tensor Chebyshev coefficients T_i(u)*T_j(v) ordered
	// by ascending total degree (i + j <= degree). For `thinPlateSpline`, [a0, a1, a2, w0..w_{k-1}]:
	// the affine part followed by the RBF weights, one weight per control point in `controlPoints`
	// order. Coordinates u, v are normalized to [-1, 1].
	readonly coefficients: Float64Array
	// Thin-plate spline only: interleaved normalized control-point coordinates [u0, v0, u1, v1, ...],
	// one per accepted sample; undefined for the polynomial model.
	readonly controlPoints?: Float64Array
	// Number of grid samples that survived rejection and fed the final fit.
	readonly acceptedSamples: number
	// Number of grid samples discarded as structure (internal dispersion or residual rejection).
	readonly rejectedSamples: number
	// Robust dispersion (normalized MAD) of the final fit residuals, a quality indicator.
	readonly residual: number
	// All grid samples with their pixel positions, values, weights, and acceptance, for inspection.
	readonly samples: readonly BackgroundSample[]
}

// A fitted background model: the per-channel surfaces plus the geometry and degree they apply to.
// Produced by `fitBackgroundSurface` without touching the source pixels; feed it to
// `evaluateBackgroundModel` to materialize the background image, or reuse it across other frames of
// the same geometry (e.g. local normalization, multi-frame correction).
export interface BackgroundModel {
	// Surface model the fit produced. Determines how `coefficients`/`controlPoints` are interpreted.
	readonly type: BackgroundModelType
	// Color modeling used. `luminance` means a single shared surface (`surfaces` has one entry) applied
	// to every channel; `perChannel` means one surface per channel.
	readonly colorMode: BackgroundColorMode
	// Width, in pixels, of the image the model was fitted to.
	readonly width: number
	// Height, in pixels, of the image the model was fitted to.
	readonly height: number
	// Number of channels the model covers (one surface each).
	readonly channelCount: number
	// Polynomial degree (of the polynomial surface, or the TPS affine-part / rejection pre-fit).
	readonly degree: number
	// Thin-plate spline smoothing used for the fit (0 for the polynomial model). 0 means the spline
	// interpolates the accepted samples exactly, so evaluation must materialize it per pixel rather than
	// through the coarse-grid approximation, which would otherwise break the exact-interpolation contract.
	readonly smoothing: number
	// Fitted surface, one per channel.
	readonly surfaces: readonly BackgroundSurfaceFit[]
}

// Fitted background model for a single channel, extended with the post-correction output range.
export interface BackgroundExtractionChannelModel extends BackgroundSurfaceFit {
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

// Pre-clipping value range produced by a correction on one channel.
export interface BackgroundOutputRange {
	// Minimum corrected value before clipping (NaN when the channel had no finite pixels).
	readonly min: number
	// Maximum corrected value before clipping.
	readonly max: number
}

// Options for `applyBackground`.
export interface BackgroundApplyOptions {
	// How the modeled background is removed from the source. Default `subtract`.
	readonly correction?: Exclude<BackgroundExtractionCorrection, 'none'>
	// How out-of-range corrected values are handled. See `BackgroundExtractionClipping`. Default
	// `truncate`.
	readonly clipping?: BackgroundExtractionClipping
	// Level re-established after correction to preserve overall brightness, in [0, 1]. When undefined
	// the per-channel background mean is used.
	readonly targetBackground?: number
}

// Default automatic background extraction options.
export const DEFAULT_BACKGROUND_EXTRACTION_OPTIONS: Required<Omit<BackgroundExtractionOptions, 'targetBackground' | 'exclusionMask'>> = {
	gridSize: 24,
	boxSize: 0,
	model: 'polynomial',
	colorMode: 'perChannel',
	degree: 4,
	smoothing: 0.1,
	tolerance: 3,
	rejectionHigh: 2.5,
	rejectionLow: 4,
	rejectionIterations: 2,
	correction: 'subtract',
	clipping: 'truncate',
}

// One grid sample used internally by the fit, carrying both pixel and normalized coordinates.
interface SurfaceSample {
	// Box center x in pixels.
	x: number
	// Box center y in pixels.
	y: number
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

// Minimum number of unmasked finite pixels a box must contain for its median to be a usable sample.
// Only bites when an exclusion mask removes most of a box; full boxes always exceed it.
const MIN_BOX_SAMPLES = 4

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

// Robust normalized MAD of the first `count` values in `values`, using `scratch` for sorting and
// absolute deviations. Leaves `values` order intact so residuals can still be mapped to samples.
function computeResidualDispersion(values: Float64Array, scratch: Float64Array, count: number) {
	if (count === 0) return Number.NaN

	scratch.set(values.subarray(0, count))
	scratch.subarray(0, count).sort()
	const median = medianOf(scratch, count)
	for (let i = 0; i < count; i++) scratch[i] = Math.abs(values[i] - median)
	scratch.subarray(0, count).sort()
	return STANDARD_DEVIATION_SCALE * medianOf(scratch, count)
}

// Collects grid samples for one channel. Divides the image into a grid of roughly square cells,
// estimates a robust background per box, and rejects boxes whose internal dispersion marks them as
// contaminated by stars or nebulae. Coordinates are normalized to [-1, 1] for a well-conditioned fit.
// `minCellsPerAxis` is the minimum number of cells kept on each axis so a high-aspect frame (e.g.
// 1000x30) still yields a 2D layout rather than a single row/column that a surface fit would reject.
function collectSamples(raw: ImageRawType, width: number, height: number, channels: number, channel: number, gridSize: number, boxSize: number, tolerance: number, minCellsPerAxis: number, mask?: Readonly<NumberArray>) {
	const longAxis = Math.max(width, height)
	const cell = longAxis / gridSize
	// Square cells come from the long axis, so the short axis of a high-aspect frame can round down to a
	// single cell, collapsing every sample onto one coordinate. Keep at least `minCellsPerAxis` cells per
	// axis (bounded by the pixel count) so the layout stays two-dimensional and the fit is well-posed.
	// The upper bound caps the grid at one cell per pixel: a very large gridSize would otherwise blow the
	// cell count up to unusable sizes and exhaust memory. More cells than pixels is meaningless anyway.
	const nx = clamp(Math.round(width / cell), Math.min(minCellsPerAxis, width), width)
	const ny = clamp(Math.round(height / cell), Math.min(minCellsPerAxis, height), height)
	const cellW = width / nx
	const cellH = height / ny

	// An explicit boxSize is the exact sampled side length in pixels: build an integer window of exactly
	// boxSize pixels per axis, centered on the cell center. A real-valued half-size with inclusive
	// floor/ceil bounds would instead sample boxSize + 1 pixels for fractional centers, weakening small
	// boxes at avoiding stars and letting under-sized boxes slip past MIN_BOX_SAMPLES. When boxSize is
	// not given, fall back to a real-valued half-size derived from the smaller cell edge (about half a
	// cell). boxPixels is capped to the long axis only to keep the centering arithmetic in a sane range;
	// a box larger than the frame is simply clipped to the frame by the sampling loops below.
	const explicitBox = boxSize > 0
	const boxPixels = explicitBox ? clamp(Math.trunc(boxSize), 1, longAxis) : 0
	// Fractional half-extent used to center the integer window on the cell center; each box records its
	// true centroid so the sampled value is attributed to the right position even when the window is
	// nudged inward at the frame edges.
	const halfBox = (boxPixels - 1) / 2
	const boxHalf = explicitBox ? 0 : Math.max(1.5, Math.min(cellW, cellH) * 0.25)

	// Scratch buffers sized to the largest possible CLIPPED box, reused across every box. The sampling
	// loops clip each box to the image bounds, so no box can span more than width pixels across or height
	// pixels down regardless of the requested boxSize. Sizing by the clipped per-axis extents avoids
	// allocating for an oversized request (e.g. boxSize far larger than a narrow frame) that no box could
	// ever fill — the requested side length alone could otherwise imply a multi-gigabyte buffer.
	const spanX = explicitBox ? boxPixels : Math.ceil(2 * boxHalf) + 2
	const maxBoxX = Math.min(spanX, width)
	const maxBoxY = Math.min(spanX, height)
	const buf = new Float64Array(maxBoxX * maxBoxY)
	const dev = new Float64Array(maxBoxX * maxBoxY)

	const invW = width > 1 ? 2 / (width - 1) : 0
	const invH = height > 1 ? 2 / (height - 1) : 0

	// Last valid pixel-center coordinates. The cell center that positions each box is clamped to these:
	// for dense grids whose cells are narrower than ~2 px, the naive (c + 0.5) * cellW center can exceed
	// width - 1 and place the box entirely outside the frame. Clamping is a no-op for normal grids. (The
	// recorded sample coordinate is the box centroid below, which is always within the frame.)
	const maxX = width > 1 ? width - 1 : 0
	const maxY = height > 1 ? height - 1 : 0

	const samples: SurfaceSample[] = []

	for (let r = 0; r < ny; r++) {
		const cy = Math.min((r + 0.5) * cellH, maxY)
		// For an explicit box, take exactly boxPixels rows centered on cy, shifting the window inside the
		// frame at the edges; otherwise use the real-valued half-size with inclusive floor/ceil bounds.
		const y0 = explicitBox ? clamp(Math.round(cy - halfBox), 0, Math.max(0, height - boxPixels)) : Math.max(0, Math.floor(cy - boxHalf))
		const y1 = explicitBox ? Math.min(height - 1, y0 + boxPixels - 1) : Math.min(height - 1, Math.ceil(cy + boxHalf))

		for (let c = 0; c < nx; c++) {
			const cx = Math.min((c + 0.5) * cellW, maxX)
			const x0 = explicitBox ? clamp(Math.round(cx - halfBox), 0, Math.max(0, width - boxPixels)) : Math.max(0, Math.floor(cx - boxHalf))
			const x1 = explicitBox ? Math.min(width - 1, x0 + boxPixels - 1) : Math.min(width - 1, Math.ceil(cx + boxHalf))

			// Accumulate the centroid of the pixels that actually contribute (unmasked and finite) alongside
			// their values. Recording the sample at that centroid rather than the geometric box center keeps
			// the median attributed to the region it was drawn from: at the frame edges the box is clipped,
			// and an exclusion mask can remove part of it, so the contributing region is shifted. For a full,
			// unmasked box the pixel centroid equals the geometric box center, so this is a no-op there.
			let count = 0
			let sumX = 0
			let sumY = 0

			for (let y = y0; y <= y1; y++) {
				let i = (y * width + x0) * channels + channel
				let m = y * width + x0

				for (let x = x0; x <= x1; x++, i += channels, m++) {
					if (mask !== undefined && mask[m] !== 0) continue
					const p = raw[i]
					if (Number.isFinite(p)) {
						buf[count++] = p
						sumX += x
						sumY += y
					}
				}
			}

			// Skip boxes with too few usable pixels (e.g. mostly masked out) so their median is reliable.
			if (count < MIN_BOX_SAMPLES) continue

			const [median, dispersion] = boxStatistics(buf, dev, count)
			if (!Number.isFinite(median)) continue

			const sx = sumX / count
			const sy = sumY / count

			samples.push({
				x: sx,
				y: sy,
				u: sx * invW - 1,
				v: sy * invH - 1,
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

// Minimum 2D spread (RMS extent along the least-covered direction, in the normalized [-1, 1] domain)
// the accepted samples must have for the polynomial system to be well-posed. Samples confined to a thin
// strip give one basis direction almost no variation, so the surface is unconstrained across the rest of
// the frame and extrapolates far outside the image range even though the QR reports full rank (the tiny
// pivot is non-zero only through floating-point noise). Full-frame coverage has a spread near 0.58; a
// thin strip approaches 0. The threshold caps the worst-case extrapolation amplification.
const MIN_SAMPLE_SPREAD = 0.02

// Maximum ratio of the fitted surface's magnitude bound to the largest sampled magnitude. On [-1, 1]^2
// the surface value is bounded by the L1 norm of its Chebyshev coefficients (each |T_i| <= 1), so a
// well-posed fit keeps that bound within a small multiple of the sampled values. A near-rank-deficient
// layout that slips past isFullRank — e.g. samples covering too few distinct coordinate bands for the
// requested degree, where the spread check still passes — instead yields coefficients whose sum dwarfs
// the data and a surface that explodes across the frame. The factor is generous so genuine smooth
// backgrounds are never rejected; only gross blow-ups (orders of magnitude past the data) are caught.
const MAX_SURFACE_MAGNITUDE_FACTOR = 100

// RMS extent of the active samples along their least-covered direction: sqrt of the smaller eigenvalue
// of the (u, v) covariance. About 0.58 for full [-1, 1] coverage, ~0 for a collinear / thin-strip layout
// regardless of orientation. `m` must be the number of active samples and be > 0.
function activeSampleSpread(samples: readonly SurfaceSample[], m: number) {
	let su = 0
	let sv = 0
	for (const sample of samples) {
		if (!sample.active) continue
		su += sample.u
		sv += sample.v
	}
	const mu = su / m
	const mv = sv / m

	let cuu = 0
	let cvv = 0
	let cuv = 0
	for (const sample of samples) {
		if (!sample.active) continue
		const du = sample.u - mu
		const dv = sample.v - mv
		cuu += du * du
		cvv += dv * dv
		cuv += du * dv
	}
	cuu /= m
	cvv /= m
	cuv /= m

	// Smaller eigenvalue of the symmetric 2x2 covariance [[cuu, cuv], [cuv, cvv]].
	const tr = cuu + cvv
	const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (cuu * cvv - cuv * cuv)))
	return Math.sqrt(Math.max(0, tr / 2 - disc))
}

// Fits a 2D Chebyshev surface to the currently active samples by least squares (QR). Returns the
// coefficient vector, or undefined when there are too few samples, the layout is degenerate (a thin
// strip or too few coordinate bands for the degree, so the system is effectively singular), or the
// system is rank deficient.
function fitSurface(samples: readonly SurfaceSample[], degree: number, terms: number, ti: Uint8Array, tj: Uint8Array): Float64Array | undefined {
	let m = 0
	for (const sample of samples) if (sample.active) m++
	if (m < terms) return undefined

	// Reject thin-strip / collinear layouts before trusting the solve: the QR can be nominally full rank
	// yet so ill-conditioned that the surface extrapolates wildly across the unsampled part of the frame.
	if (activeSampleSpread(samples, m) < MIN_SAMPLE_SPREAD) return undefined

	const A = new Matrix(m, terms)
	const b = new Float64Array(m)
	const data = A.data
	const uCheb = new Float64Array(degree + 1)
	const vCheb = new Float64Array(degree + 1)

	let row = 0
	let maxAbsValue = 0

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
		if (Math.abs(sample.value) > maxAbsValue) maxAbsValue = Math.abs(sample.value)
		row++
	}

	try {
		// `A` is a throwaway design matrix used only for this solve, so factorize in place and skip the clone.
		const qr = new QrDecomposition(A, true)
		if (!qr.isFullRank) return undefined
		// solve() returns a vector sized to the sample count (rows); only the first `terms` entries are
		// the least-squares coefficients, the rest are residual internals. Copy just the coefficients.
		const coefficients = qr.solve(b).slice(0, terms)

		// Guard against ill-conditioned layouts that pass isFullRank through floating-point noise (e.g.
		// too few distinct coordinate bands for the degree): the surface value on [-1, 1]^2 is bounded by
		// the L1 norm of the coefficients, so reject when that bound explodes past the sampled value scale.
		let coefficientL1 = 0
		for (let k = 0; k < terms; k++) coefficientL1 += Math.abs(coefficients[k])
		if (coefficientL1 > MAX_SURFACE_MAGNITUDE_FACTOR * maxAbsValue) return undefined

		return coefficients
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

// Thin-plate spline radial basis U(r) = r^2 * ln(r), expressed from the squared distance s = r^2 as
// 0.5 * s * ln(s) with U(0) = 0. Taking the squared distance avoids a sqrt in the hot evaluation loop.
function tpsKernel(sq: number) {
	return sq > 0 ? 0.5 * sq * Math.log(sq) : 0
}

// Upper bound on thin-plate spline control points. The TPS fit solves a dense (k+3)x(k+3) system in
// O(k^3) and, for an exact (zero-smoothing) spline, evaluation costs O(width*height*k) kernel calls, so
// both blow up for very dense grids. This cap keeps the fit and evaluation tractable; the default grid
// (gridSize 24, up to ~576 samples) stays well under it, so normal usage is unaffected. Chosen as a
// perfect square so the spatial buckets below tile evenly.
const TPS_MAX_CONTROL_POINTS = 1024

// Below this ratio of (normalized) MAD to standard deviation, the box medians are treated as a flat
// background plus a distinct outlier mode — a saturated / flat-topped object filling boxes — rather than
// smooth structure. Smooth light pollution (a broad dome) or a gradient keeps MAD/std ~ 0.8-1.3; a flat
// frame with an object collapses it toward 0. Below the threshold the outlier mode is rejected so the TPS
// does not model the object as background; above it, domes and gradients are preserved untouched.
const TPS_BIMODAL_MAD_RATIO = 0.3

// Iteration cap for the flat-topped-structure rejection; it converges in one pass in the common case.
const FLAT_TOP_REJECTION_MAX_ITERATIONS = 4

// Rejects box medians that form a distinct bright/dark outlier mode on an otherwise flat background,
// marking those samples inactive in place. A compact saturated object has near-zero internal dispersion,
// so the box-dispersion prefilter and the smoothing TPS both accept it and would model it as background,
// then subtract it away. Detection is gated on the box-median MAD collapsing relative to their spread:
// smooth structure (a broad dome, a gradient) keeps a healthy ratio and is left untouched, while a
// flat-plus-object distribution collapses it. Rejection is asymmetric like the polynomial path (tight on
// the bright side, loose on the dark). `buffer`/`scratch` are reusable arrays sized to the sample count.
function rejectFlatToppedStructure(samples: readonly SurfaceSample[], buffer: Float64Array, scratch: Float64Array, rejectionHigh: number, rejectionLow: number) {
	for (let iteration = 0; iteration < FLAT_TOP_REJECTION_MAX_ITERATIONS; iteration++) {
		let count = 0
		for (const sample of samples) if (sample.active) buffer[count++] = sample.value
		if (count < 4) return

		// Robust center and scale of the active box medians (scratch holds the sorted values / deviations).
		scratch.set(buffer.subarray(0, count))
		scratch.subarray(0, count).sort()
		const center = medianOf(scratch, count)
		for (let i = 0; i < count; i++) scratch[i] = Math.abs(buffer[i] - center)
		scratch.subarray(0, count).sort()
		const mad = STANDARD_DEVIATION_SCALE * medianOf(scratch, count)
		const spread = standardDeviationOf(buffer, count)

		// Only reject when the distribution is flat-plus-outliers (collapsed MAD), never for smooth structure.
		if (!(spread > 0) || mad > TPS_BIMODAL_MAD_RATIO * spread) return

		// Scale the limits by the collapsed robust scale (MAD of the flat mode), not the ordinary standard
		// deviation: the outlier mode itself inflates `spread`, so once a saturated object fills enough boxes
		// (roughly a quarter of the frame) a spread-scaled bright limit outruns the object and rejects nothing.
		// The MAD reflects the flat mode's dispersion regardless of how many outlier boxes exist, keeping the
		// threshold anchored to the background. When the flat mode is noise-free MAD is 0 and the limit
		// collapses to `center`, which still separates the two modes cleanly.
		const highLimit = rejectionHigh > 0 ? center + rejectionHigh * mad : Infinity
		const lowLimit = rejectionLow > 0 ? center - rejectionLow * mad : -Infinity
		let rejected = 0
		for (const sample of samples) {
			if (!sample.active) continue
			if (sample.value > highLimit || sample.value < lowLimit) {
				sample.active = false
				rejected++
			}
		}
		if (rejected === 0) return
	}
}

// Marks all but one active sample per distinct (u, v) coordinate inactive. Overlapping sample boxes —
// common on small images or dense grids where edge boxes are clamped inward to the same window — can
// produce repeated control-point coordinates; two identical points give the thin-plate spline system two
// identical rows, making it singular (the zero-smoothing diagonal cannot break the tie) so the fit fails.
// Keeping one representative per location leaves the system solvable and keeps the reported accepted set
// consistent with the control points.
function deduplicateActiveSamples(samples: readonly SurfaceSample[]) {
	const seen = new Set<string>()
	for (const sample of samples) {
		if (!sample.active) continue
		const key = `${sample.u},${sample.v}`
		if (seen.has(key)) sample.active = false
		else seen.add(key)
	}
}

// Throws unless the currently active samples span a genuine 2D region rather than a thin strip or a
// collinear set. A TPS fit over collinear control points has its affine component unconstrained
// perpendicular to the line, so it extrapolates wildly across the frame and corrupts the correction. The
// spread test is orientation-agnostic (smallest covariance eigenvalue), so it catches any line direction.
// Must be re-checked after every pass that can deactivate samples (dedup, flat-topped rejection), since a
// layout that started 2D can collapse to collinear once the off-strip samples are rejected.
function assertTpsTwoDimensionalCoverage(samples: readonly SurfaceSample[]) {
	let active = 0
	for (const sample of samples) if (sample.active) active++
	if (active < 3 || activeSampleSpread(samples, active) < MIN_SAMPLE_SPREAD) {
		throw new Error('thin-plate spline fit failed: needs at least 3 clean samples spanning a 2D region, not a thin strip')
	}
}

// Deterministically subsamples the active samples down to at most `maxPoints` control points, preserving
// spatial coverage: the normalized [-1, 1] domain is split into a g x g grid (g = floor(sqrt(maxPoints)))
// and the first active sample landing in each bucket is kept. Returns `samples` unchanged when the active
// count is already within the cap, so the common case allocates nothing. The returned samples are all
// active, so fitThinPlateSpline uses exactly them as control points.
function subsampleControlPoints(samples: readonly SurfaceSample[], maxPoints: number): readonly SurfaceSample[] {
	let active = 0
	for (const sample of samples) if (sample.active) active++
	if (active <= maxPoints) return samples

	const g = Math.max(1, Math.floor(Math.sqrt(maxPoints)))
	const seen = new Uint8Array(g * g)
	const chosen: SurfaceSample[] = []

	for (const sample of samples) {
		if (!sample.active) continue
		// Map u, v in [-1, 1] to a bucket in [0, g); clamp guards the exact +1 edge.
		const bu = Math.min(g - 1, Math.floor(((sample.u + 1) / 2) * g))
		const bv = Math.min(g - 1, Math.floor(((sample.v + 1) / 2) * g))
		const b = bv * g + bu
		if (seen[b]) continue
		seen[b] = 1
		chosen.push(sample)
	}

	return chosen
}

// Fits a smoothing thin-plate spline to the currently active samples. Solves the (k+3)x(k+3)
// saddle-point system [K + s*W^-1, P; P^T, 0] [w; a] = [f; 0], where K_ij = U(|p_i - p_j|), P rows are
// [1, u_i, v_i], `s` is the smoothing term scaled by each sample's inverse weight, and the P^T rows
// enforce the affine side conditions. Returns the packed coefficients [a0, a1, a2, w...] and the
// interleaved control-point coordinates, or undefined when there are fewer than 3 samples or the
// system is singular/non-finite.
function fitThinPlateSpline(samples: readonly SurfaceSample[], smoothing: number): { coefficients: Float64Array; controlPoints: Float64Array } | undefined {
	const us: number[] = []
	const vs: number[] = []
	const fs: number[] = []
	const ws: number[] = []

	for (const sample of samples) {
		if (!sample.active) continue
		us.push(sample.u)
		vs.push(sample.v)
		fs.push(sample.value)
		ws.push(sample.weight)
	}

	const k = us.length
	if (k < 3) return undefined

	const size = k + 3
	const L = new Matrix(size, size)
	const data = L.data

	for (let i = 0; i < k; i++) {
		const ui = us[i]
		const vi = vs[i]
		const rowI = i * size

		for (let j = i + 1; j < k; j++) {
			const du = ui - us[j]
			const dv = vi - vs[j]
			const value = tpsKernel(du * du + dv * dv)
			data[rowI + j] = value
			data[j * size + i] = value
		}

		// Diagonal smoothing: reliable samples (weight ~ 1) get the base smoothing, noisy ones more.
		data[rowI + i] = smoothing > 0 ? smoothing / ws[i] : 0

		// Affine block P (columns k..k+2) and its transpose P^T (rows k..k+2).
		data[rowI + k] = 1
		data[rowI + k + 1] = ui
		data[rowI + k + 2] = vi
		data[k * size + i] = 1
		data[(k + 1) * size + i] = ui
		data[(k + 2) * size + i] = vi
	}

	const b = new Float64Array(size)
	for (let i = 0; i < k; i++) b[i] = fs[i]

	try {
		// `L` is a throwaway system matrix used only for this solve, so factorize in place and skip the clone.
		const x = new LuDecomposition(L, true).solve(b)
		for (let i = 0; i < size; i++) if (!Number.isFinite(x[i])) return undefined

		const coefficients = new Float64Array(size)
		coefficients[0] = x[k]
		coefficients[1] = x[k + 1]
		coefficients[2] = x[k + 2]
		for (let i = 0; i < k; i++) coefficients[3 + i] = x[i]

		const controlPoints = new Float64Array(2 * k)
		for (let i = 0; i < k; i++) {
			controlPoints[2 * i] = us[i]
			controlPoints[2 * i + 1] = vs[i]
		}

		return { coefficients, controlPoints }
	} catch {
		return undefined
	}
}

// Coarse-grid node spacing, as a fraction of the mean control-point spacing. The TPS is smooth at the
// control-point scale, so evaluating it on nodes this much finer and bilinearly upsampling keeps the
// interpolation error well below the fit accuracy (~0.5% of the local amplitude at this fraction).
const TPS_COARSE_FRACTION = 0.2

// Smoothing at or below this is treated as exact interpolation. The regularization added to the TPS
// diagonal is `smoothing / weight`; against the O(1) normalized kernel entries a value this small is
// negligible, so the spline effectively interpolates the samples and can have sharp local structure the
// coarse-grid approximation would miss — the materialized surface would then disagree with the fitted
// coefficients. The default smoothing (0.1) and any genuine regularization stay well above this.
const TPS_EXACT_SMOOTHING_MAX = 1e-6

// Evaluates the fitted thin-plate spline at one normalized point (u, v) in [-1, 1].
function tpsValue(coefficients: Float64Array, controlPoints: Float64Array, k: number, u: number, v: number) {
	let sum = coefficients[0] + coefficients[1] * u + coefficients[2] * v

	for (let c = 0; c < k; c++) {
		const du = u - controlPoints[2 * c]
		const dv = v - controlPoints[2 * c + 1]
		const sq = du * du + dv * dv
		if (sq > 0) sum += coefficients[3 + c] * (0.5 * sq * Math.log(sq))
	}

	return sum
}

// Coarse evaluation step in pixels for a TPS with `k` control points over a width*height image. Nodes
// are spaced a fraction of the mean control-point spacing sqrt(area/k). Returns 1 (evaluate every
// pixel directly) for small images or degenerate axes, where coarsening would not pay off.
function tpsCoarseStep(width: number, height: number, k: number) {
	if (k <= 0 || width < 2 || height < 2) return 1
	const spacing = Math.sqrt((width * height) / k)
	return Math.max(1, Math.floor(spacing * TPS_COARSE_FRACTION))
}

// Evaluates a fitted thin-plate spline over a whole channel, writing into `model` at the channel
// offset. Direct evaluation is O(width * height * controlPoints); since a smoothing surface is smooth,
// this instead evaluates the exact TPS on a coarse grid (spacing from `tpsCoarseStep`) and bilinearly
// upsamples to full resolution, cutting the cost by the squared coarsening factor for a tiny,
// documented interpolation error. Small images fall back to exact per-pixel evaluation. When `exact`
// is set (a zero-smoothing, interpolating spline), coarsening is disabled so the materialized surface
// passes through the accepted samples as the interpolation contract requires.
function evaluateChannelTps(coefficients: Float64Array, controlPoints: Float64Array, model: ImageRawType, width: number, height: number, channels: number, channel: number, exact: boolean) {
	const k = controlPoints.length / 2
	const invW = width > 1 ? 2 / (width - 1) : 0
	const invH = height > 1 ? 2 / (height - 1) : 0
	const step = exact ? 1 : tpsCoarseStep(width, height, k)

	if (step <= 1) {
		for (let y = 0; y < height; y++) {
			const v = y * invH - 1
			let idx = y * width * channels + channel
			for (let x = 0; x < width; x++, idx += channels) model[idx] = tpsValue(coefficients, controlPoints, k, x * invW - 1, v)
		}
		return
	}

	// Coarse node grid spanning the full image (first node at 0, last exactly at the far edge), so
	// bilinear upsampling never extrapolates. Evaluate the exact TPS at each node.
	const ncx = Math.max(2, Math.ceil((width - 1) / step) + 1)
	const ncy = Math.max(2, Math.ceil((height - 1) / step) + 1)
	const sx = (width - 1) / (ncx - 1)
	const sy = (height - 1) / (ncy - 1)
	const coarse = new Float64Array(ncx * ncy)

	for (let jy = 0; jy < ncy; jy++) {
		const v = jy * sy * invH - 1
		const row = jy * ncx
		for (let jx = 0; jx < ncx; jx++) coarse[row + jx] = tpsValue(coefficients, controlPoints, k, jx * sx * invW - 1, v)
	}

	// Bilinear upsample the coarse grid into the channel plane.
	for (let y = 0; y < height; y++) {
		const fy = y / sy
		const j0 = Math.min(ncy - 2, Math.floor(fy))
		const ty = fy - j0
		const row0 = j0 * ncx
		const row1 = row0 + ncx
		let idx = y * width * channels + channel

		for (let x = 0; x < width; x++, idx += channels) {
			const fx = x / sx
			const i0 = Math.min(ncx - 2, Math.floor(fx))
			const tx = fx - i0
			const c00 = coarse[row0 + i0]
			const c01 = coarse[row0 + i0 + 1]
			const c10 = coarse[row1 + i0]
			const c11 = coarse[row1 + i0 + 1]
			const top = c00 + (c01 - c00) * tx
			const bot = c10 + (c11 - c10) * tx
			model[idx] = top + (bot - top) * ty
		}
	}
}

// Fitting-relevant options resolved to concrete numbers (correction/clipping are applied separately).
interface ResolvedFitOptions {
	gridSize: number
	boxSize: number
	model: BackgroundModelType
	colorMode: BackgroundColorMode
	degree: number
	smoothing: number
	tolerance: number
	rejectionHigh: number
	rejectionLow: number
	rejectionIterations: number
	exclusionMask?: Readonly<NumberArray>
}

// Returns `value` when it is a finite number, otherwise `fallback`. Used to normalize numeric options
// so a stray NaN/Infinity falls back to the default instead of poisoning downstream comparisons: a NaN
// threshold would silently disable a feature (e.g. `x > NaN` and `x < -NaN` are both false), and a NaN
// smoothing would make the fit and the evaluation disagree on whether the spline interpolates.
function finiteOr(value: number | undefined, fallback: number) {
	return Number.isFinite(value) ? value! : fallback
}

// Resolves and clamps the fit-relevant subset of the options against the defaults.
function resolveFitOptions(options: BackgroundExtractionOptions): ResolvedFitOptions {
	// gridSize drives the sampling loop bounds in collectSamples; a non-finite value (Infinity/NaN)
	// would collapse the cell size to zero and produce infinite grid dimensions, hanging the fit. Reject
	// it up front so the caller fails fast with a clear error instead of timing out.
	const gridSize = options.gridSize ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.gridSize
	if (!Number.isFinite(gridSize)) throw new TypeError('gridSize must be a finite number')

	// Every other numeric option normalizes a non-finite input to its default before clamping, so NaN
	// cannot silently disable rejection/thresholds or split the smoothing decision (see finiteOr).
	return {
		gridSize: Math.max(2, Math.trunc(gridSize)),
		boxSize: Math.max(0, finiteOr(options.boxSize, DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.boxSize)),
		model: options.model ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.model,
		colorMode: options.colorMode ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.colorMode,
		degree: clamp(Math.trunc(finiteOr(options.degree, DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.degree)), 1, 6),
		smoothing: Math.max(0, finiteOr(options.smoothing, DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.smoothing)),
		tolerance: Math.max(0, finiteOr(options.tolerance, DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.tolerance)),
		rejectionHigh: Math.max(0, finiteOr(options.rejectionHigh, DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.rejectionHigh)),
		rejectionLow: Math.max(0, finiteOr(options.rejectionLow, DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.rejectionLow)),
		rejectionIterations: Math.max(0, Math.trunc(finiteOr(options.rejectionIterations, DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.rejectionIterations))),
		exclusionMask: options.exclusionMask,
	}
}

// Fits the background surface for one channel with iterative asymmetric residual rejection. Returns
// the Chebyshev coefficients and fit diagnostics; does not evaluate the surface into an image.
function fitChannelSurface(raw: ImageRawType, width: number, height: number, channels: number, channel: number, options: ResolvedFitOptions, terms: number, ti: Uint8Array, tj: Uint8Array): BackgroundSurfaceFit {
	const { gridSize, boxSize, model, degree, smoothing, tolerance, rejectionHigh, rejectionLow, rejectionIterations, exclusionMask } = options
	// A degree-d polynomial needs at least d+1 distinct coordinates per axis to be determined; keep that
	// many cell rows/columns so high-aspect frames still produce a 2D sample layout.
	const samples = collectSamples(raw, width, height, channels, channel, gridSize, boxSize, tolerance, degree + 1, exclusionMask)

	const residuals = new Float64Array(samples.length)
	const residualScratch = new Float64Array(samples.length)
	let residualDispersion = 0

	let coefficients: Float64Array
	let controlPoints: Float64Array | undefined

	if (model === 'thinPlateSpline') {
		// Reject strip / collinear layouts before fitting, exactly as the polynomial path does. A TPS whose
		// clean samples lie on a line (e.g. an exclusion mask leaving a single row) has an affine component
		// unconstrained perpendicular to the strip, so it extrapolates wildly across the frame and corrupts
		// the correction.
		assertTpsTwoDimensionalCoverage(samples)

		// Drop duplicate control-point coordinates before fitting: they make the (unregularized) spline
		// system singular. Cheap no-op when boxes do not overlap (large images / coarse grids).
		deduplicateActiveSamples(samples)

		// The thin-plate spline exists to model smooth localized structure such as a light-pollution
		// dome. The polynomial residual rejection below must NOT run for it: a low-degree polynomial (and
		// even a smoothing TPS) cannot match a dome exactly, so its samples would read as high-residual
		// outliers and be rejected, leaving the spline fit only to the surrounding floor. The
		// box-dispersion prefilter in collectSamples still drops star-contaminated boxes, which is the
		// appropriate rejection for a flexible interpolating surface.
		//
		// A saturated flat-topped object fills whole boxes with a near-constant value, so it has near-zero
		// internal dispersion and slips past that prefilter; without rejection the TPS would model it as
		// background and subtract it away. Reject such a distinct outlier mode first, but only when the box
		// medians are flat-plus-outliers rather than smoothly varying, so genuine domes/gradients survive.
		rejectFlatToppedStructure(samples, residuals, residualScratch, rejectionHigh, rejectionLow)

		// Rejection (and the dedup above) can deactivate the only off-strip samples — e.g. a masked horizontal
		// sky strip plus two bright unmasked boxes passes the initial check, then the bright boxes are rejected
		// and the survivors are collinear. Re-check coverage so the fit fails loudly instead of extrapolating a
		// spurious background from a rank-deficient control-point layout.
		assertTpsTwoDimensionalCoverage(samples)

		// The final surface is a smoothing TPS through the surviving samples, capped to a tractable number
		// of control points on dense grids.
		const controlSamples = subsampleControlPoints(samples, TPS_MAX_CONTROL_POINTS)
		const tps = fitThinPlateSpline(controlSamples, smoothing)
		if (tps === undefined) throw new Error('thin-plate spline fit failed (needs at least 3 clean samples and a non-singular system)')
		coefficients = tps.coefficients
		controlPoints = tps.controlPoints

		// An exact (interpolating) spline only passes through its control points. When the cap dropped
		// some active samples, mark those as rejected so the reported accepted set matches the interpolated
		// set: otherwise evaluateBackgroundModel would treat the model as exact while accepted-but-dropped
		// samples fail to reproduce their medians. A genuine smoothing spline interpolates nothing, so its
		// dropped samples legitimately stay accepted and still inform the residual diagnostics below.
		if (controlSamples !== samples && smoothing <= TPS_EXACT_SMOOTHING_MAX) {
			const kept = new Set(controlSamples)
			for (const sample of samples) {
				if (sample.active && !kept.has(sample)) sample.active = false
			}
		}

		const k = controlPoints.length / 2
		let count = 0
		for (const sample of samples) {
			if (!sample.active) continue
			residuals[count++] = sample.value - tpsValue(coefficients, controlPoints, k, sample.u, sample.v)
		}
		residualDispersion = computeResidualDispersion(residuals, residualScratch, count)
	} else {
		const poly = fitSurface(samples, degree, terms, ti, tj)
		if (poly === undefined) throw new Error(`unable to fit a degree-${degree} background surface: need at least ${terms} clean samples spanning a 2D region, not a thin strip`)
		coefficients = poly

		const uCheb = new Float64Array(degree + 1)
		const vCheb = new Float64Array(degree + 1)

		// Samples rejected during the current pass. Tracked so they can be reinstated if the subsequent
		// refit turns out to be unsolvable, keeping the reported accepted set consistent with the kept fit.
		const rejectedThisPass: SurfaceSample[] = []

		// Iteratively reject residual outliers and refit until the iteration budget is spent or nothing is
		// rejected. Rejection is asymmetric: the sky background is the lower envelope of the data, so
		// samples above the surface (contaminating structure) are rejected with a tight sigma while
		// samples below it (usually the cleanest sky) are only dropped when they are gross low outliers.
		for (let iteration = 0; iteration <= rejectionIterations; iteration++) {
			let count = 0
			for (const sample of samples) {
				if (!sample.active) continue
				residuals[count++] = sample.value - evaluateSurface(coefficients, sample.u, sample.v, degree, terms, ti, tj, uCheb, vCheb)
			}

			residualDispersion = computeResidualDispersion(residuals, residualScratch, count)

			if (iteration === rejectionIterations || !Number.isFinite(residualDispersion)) break

			// The robust MAD collapses toward 0 on a nearly flat frame where most residuals are identical,
			// even when a few gross outliers (e.g. sample boxes filling a bright object) remain; floating
			// point can leave it at ~1e-17 rather than exactly 0. Using it directly would make the
			// thresholds ~0, flag every sample, and reinstate them all on the failed refit — leaving the
			// outliers active and the surface pulled up. Compare it to the overall standard deviation
			// (scale-invariant): when the MAD is negligible but real spread exists the bulk is degenerate,
			// so fall back to the non-robust std to keep the thresholds meaningful. When the std is 0 too
			// the residuals are genuinely constant and there is nothing to reject.
			const spread = standardDeviationOf(residuals, count)
			if (spread === 0 || Number.isNaN(spread)) break
			const scale = residualDispersion > 1e-6 * spread ? residualDispersion : spread

			const highLimit = rejectionHigh * scale
			const lowLimit = rejectionLow * scale
			rejectedThisPass.length = 0
			let index = 0
			for (const sample of samples) {
				if (!sample.active) continue
				// residual = sample - surface: positive above the surface (structure), negative below it.
				const residual = residuals[index]
				if (residual > highLimit || residual < -lowLimit) {
					sample.active = false
					rejectedThisPass.push(sample)
				}
				index++
			}

			if (rejectedThisPass.length === 0) break

			const refit = fitSurface(samples, degree, terms, ti, tj)
			if (refit === undefined) {
				// The reduced sample set has fewer rows than terms, so the refit is unsolvable. Reinstate
				// the samples rejected in this pass and keep the previous fit, which matches those samples,
				// so the reported accepted set stays consistent with the evaluated coefficients.
				for (const sample of rejectedThisPass) sample.active = true
				break
			}
			coefficients = refit
		}
	}

	let accepted = 0
	const sampleList: BackgroundSample[] = []
	for (const sample of samples) {
		if (sample.active) accepted++
		sampleList.push({ x: sample.x, y: sample.y, value: sample.value, weight: sample.weight, accepted: sample.active })
	}

	return {
		coefficients,
		controlPoints,
		acceptedSamples: accepted,
		rejectedSamples: samples.length - accepted,
		residual: Number.isFinite(residualDispersion) ? residualDispersion : 0,
		samples: sampleList,
	}
}

// Evaluates a fitted polynomial channel surface at every pixel, writing into `model` at the channel
// offset. `uChebTable` holds T_0..T_degree(u) for every column and depends only on width/degree, so the
// caller builds it once and shares it across channels. The tensor basis T_i(u)*T_j(v) is separable, so
// each row first collapses the 2D terms into per-u-degree coefficients rowCoef[i] = Σ_j coef[i,j]*T_j(v);
// the per-pixel inner loop then costs degree+1 multiplies instead of `terms` (5 vs 15 at degree 4, 7 vs
// 28 at degree 6).
function evaluateChannelSurface(coefficients: Float64Array, model: ImageRawType, width: number, height: number, channels: number, channel: number, degree: number, terms: number, ti: Uint8Array, tj: Uint8Array, uChebTable: Float64Array) {
	const invH = height > 1 ? 2 / (height - 1) : 0
	const stride = degree + 1
	const vRow = new Float64Array(stride)
	const rowCoef = new Float64Array(stride)

	for (let y = 0; y < height; y++) {
		fillChebyshev(vRow, 0, y * invH - 1, degree)

		// Collapse the 2D terms into one coefficient per u-degree for this row.
		rowCoef.fill(0)
		for (let k = 0; k < terms; k++) rowCoef[ti[k]] += coefficients[k] * vRow[tj[k]]

		let idx = y * width * channels + channel

		for (let x = 0; x < width; x++, idx += channels) {
			const base = x * stride
			let sum = 0
			for (let d = 0; d <= degree; d++) sum += rowCoef[d] * uChebTable[base + d]
			model[idx] = sum
		}
	}
}

// Throws when a fitted model's geometry does not match the image it is being evaluated/applied to.
function ensureModelMatchesImage(model: BackgroundModel, image: Image) {
	const { width, height, channels } = image.metadata
	if (width !== model.width || height !== model.height || channels !== model.channelCount) {
		throw new Error(`background model geometry (${model.width}x${model.height}x${model.channelCount}) does not match image (${width}x${height}x${channels})`)
	}
}

// Throws when an image and a background image do not share the same dimensions and channel count.
function ensureSameGeometry(image: Image, background: Image) {
	if (image.metadata.width !== background.metadata.width || image.metadata.height !== background.metadata.height || image.metadata.channels !== background.metadata.channels) {
		throw new Error('image and background must have the same dimensions and channel count')
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

// Fits a background model to an image without modifying it.
//
// Builds a grid of robust per-box background samples, rejects those contaminated by stars or nebulae
// (by internal dispersion and then iterative asymmetric residual rejection), and fits a surface per
// channel: a weighted-least-squares 2D Chebyshev polynomial (`polynomial`) or a smoothing thin-plate
// spline through the surviving samples (`thinPlateSpline`). Coordinates are normalized to [-1, 1].
// The returned model is independent of any correction and can be evaluated or reused across frames of
// the same geometry.
//
// Throws when a channel has fewer clean samples than the chosen model requires.
export function fitBackgroundSurface(image: Image, options: BackgroundExtractionOptions = DEFAULT_BACKGROUND_EXTRACTION_OPTIONS): BackgroundModel {
	const fit = resolveFitOptions(options)
	const { raw, metadata } = image
	const { width, height, channels } = metadata

	if (fit.exclusionMask !== undefined && fit.exclusionMask.length !== width * height) {
		throw new Error(`exclusionMask length must be ${width * height} (width*height), got ${fit.exclusionMask.length}`)
	}

	const terms = basisTermCount(fit.degree)
	const ti = new Uint8Array(terms)
	const tj = new Uint8Array(terms)
	fillBasisExponents(fit.degree, ti, tj)

	const surfaces: BackgroundSurfaceFit[] = []

	// Smoothing only applies to the thin-plate spline; the polynomial model ignores it, so report 0 to
	// keep the metadata honest for callers inspecting or serializing the fit.
	const smoothing = fit.model === 'thinPlateSpline' ? fit.smoothing : 0

	// Luminance mode (RGB only): fit a single surface on the luminance plane; per-channel otherwise.
	if (fit.colorMode === 'luminance' && channels === 3) {
		const n = width * height
		const lum = new Float64Array(n)
		const { red, green, blue } = DEFAULT_GRAYSCALE
		for (let p = 0, i = 0; p < n; p++, i += 3) lum[p] = red * raw[i] + green * raw[i + 1] + blue * raw[i + 2]
		surfaces.push(fitChannelSurface(lum, width, height, 1, 0, fit, terms, ti, tj))
		return { type: fit.model, colorMode: 'luminance', width, height, channelCount: channels, degree: fit.degree, smoothing, surfaces }
	}

	for (let channel = 0; channel < channels; channel++) {
		surfaces.push(fitChannelSurface(raw, width, height, channels, channel, fit, terms, ti, tj))
	}

	return { type: fit.model, colorMode: 'perChannel', width, height, channelCount: channels, degree: fit.degree, smoothing, surfaces }
}

// Materializes a fitted `model` into a fresh background image cloned from `image` (which supplies the
// header/metadata and must match the model geometry). The source pixels are not read; every pixel of
// the returned image is overwritten with the evaluated surface.
export function evaluateBackgroundModel(model: BackgroundModel, image: Image): Image {
	ensureModelMatchesImage(model, image)

	const header = structuredClone(image.header)
	const metadata = structuredClone(image.metadata)
	const out = image.raw instanceof Float32Array ? new Float32Array(image.raw.length) : new Float64Array(image.raw.length)

	const background: Image = { header, metadata, raw: out }
	const { type, width, height, channelCount, degree } = model
	// A TPS with zero (or negligibly small) smoothing interpolates the accepted samples; disable
	// coarse-grid evaluation for it so the materialized surface honors that interpolation contract and
	// matches the fitted coefficients rather than a bilinear approximation.
	const exactTps = type === 'thinPlateSpline' && model.smoothing <= TPS_EXACT_SMOOTHING_MAX

	const terms = basisTermCount(degree)
	const ti = new Uint8Array(terms)
	const tj = new Uint8Array(terms)

	// Precompute the per-column Chebyshev table T_0..T_degree(u) once. It depends only on width/degree,
	// so it is shared across every channel instead of being rebuilt per channel.
	let uChebTable: Float64Array | undefined
	if (type === 'polynomial') {
		fillBasisExponents(degree, ti, tj)
		const stride = degree + 1
		const invW = width > 1 ? 2 / (width - 1) : 0
		uChebTable = new Float64Array(width * stride)
		for (let x = 0; x < width; x++) fillChebyshev(uChebTable, x * stride, x * invW - 1, degree)
	}

	// Shared luminance surface: evaluate once into a scratch plane and broadcast to every channel.
	if (model.colorMode === 'luminance' && model.surfaces.length === 1 && channelCount > 1) {
		const n = width * height
		const lum = new Float64Array(n)
		const surface = model.surfaces[0]

		if (type === 'thinPlateSpline') evaluateChannelTps(surface.coefficients, surface.controlPoints!, lum, width, height, 1, 0, exactTps)
		else evaluateChannelSurface(surface.coefficients, lum, width, height, 1, 0, degree, terms, ti, tj, uChebTable!)

		for (let p = 0, i = 0; p < n; p++, i += channelCount) {
			const v = lum[p]
			for (let c = 0; c < channelCount; c++) out[i + c] = v
		}

		return background
	}

	for (let channel = 0; channel < channelCount; channel++) {
		const surface = model.surfaces[channel]
		if (type === 'thinPlateSpline') evaluateChannelTps(surface.coefficients, surface.controlPoints!, out, width, height, channelCount, channel, exactTps)
		else evaluateChannelSurface(surface.coefficients, out, width, height, channelCount, channel, degree, terms, ti, tj, uChebTable!)
	}

	return background
}

// Removes a modeled `background` from `image` in place, returning the per-channel pre-clipping value
// range.
//
// `subtract` performs additive removal (gradients, light pollution); `divide` performs multiplicative
// removal (vignetting), guarded against division by near-zero model values. The per-channel level is
// restored to `targetBackground` (or the background channel mean when omitted) so overall brightness
// is preserved. Out-of-range values are brought back into [0, 1] per the `clipping` mode. `image` and
// `background` must share the same geometry.
export function applyBackground(image: Image, background: Image, options: BackgroundApplyOptions = {}): BackgroundOutputRange[] {
	ensureSameGeometry(image, background)

	const correction = options.correction ?? 'subtract'
	const clipping = options.clipping ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.clipping
	const targetOverride = options.targetBackground !== undefined && Number.isFinite(options.targetBackground) ? clamp(options.targetBackground, 0, 1) : undefined

	const { raw, metadata } = image
	const model = background.raw
	const { width, height, channels } = metadata
	const n = width * height

	const ranges: BackgroundOutputRange[] = []

	for (let channel = 0; channel < channels; channel++) {
		const target = targetOverride ?? channelMean(model, width, height, channels, channel)

		// First pass: write the unclamped corrected values and track their finite range so the clipping
		// step can rescale instead of blindly truncating out-of-range signal.
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

		ranges.push({ min: Number.isFinite(min) ? min : Number.NaN, max: Number.isFinite(max) ? max : Number.NaN })
	}

	return ranges
}

// Extracts and removes a smooth sky background from an image.
//
// Convenience orchestrator over `fitBackgroundSurface`, `evaluateBackgroundModel`, and
// `applyBackground`: fits the surface per channel, materializes the background image, and removes it
// by subtraction (gradients, light pollution) or division (vignetting).
//
// The source `image` is mutated in place with the corrected pixels unless `correction` is `none`.
// The returned `background` is always a fresh image holding the fitted model. After a
// `subtract`/`divide` correction the per-channel level is restored to `targetBackground` (or the
// background mean when omitted) so overall brightness is preserved, and out-of-range values are
// brought back into [0, 1] per the `clipping` mode. Each channel model reports the pre-clipping value
// range in `outputMin`/`outputMax`.
//
// Throws when a channel has fewer clean samples than the polynomial degree requires.
export function automaticBackgroundExtraction(image: Image, options: BackgroundExtractionOptions = DEFAULT_BACKGROUND_EXTRACTION_OPTIONS): BackgroundExtractionResult {
	const model = fitBackgroundSurface(image, options)
	const background = evaluateBackgroundModel(model, image)
	const correction = options.correction ?? DEFAULT_BACKGROUND_EXTRACTION_OPTIONS.correction

	const channels: BackgroundExtractionChannelModel[] = []

	// In luminance mode a single surface is shared across every channel; report one result per image
	// channel so the array length always matches the channel count.
	const surfaceFor = (c: number) => (model.surfaces.length === 1 ? model.surfaces[0] : model.surfaces[c])

	if (correction === 'none') {
		for (let c = 0; c < model.channelCount; c++) channels.push(surfaceFor(c))
	} else {
		const ranges = applyBackground(image, background, { correction, clipping: options.clipping, targetBackground: options.targetBackground })

		for (let c = 0; c < model.channelCount; c++) {
			const s = surfaceFor(c)
			channels.push({ coefficients: s.coefficients, controlPoints: s.controlPoints, acceptedSamples: s.acceptedSamples, rejectedSamples: s.rejectedSamples, residual: s.residual, samples: s.samples, outputMin: ranges[c].min, outputMax: ranges[c].max })
		}
	}

	return { image, background, channels }
}

// Options for `backgroundExclusionMaskFromStars`.
export interface BackgroundStarExclusionOptions {
	// Multiplier applied to each star's HFD to set the excluded disk radius, in pixels. Default 1.5.
	readonly radiusScale?: number
	// Minimum excluded disk radius in pixels, regardless of star size. Default 4.
	readonly minRadius?: number
}

// Builds a pixel exclusion mask (1 = excluded, 0 = kept), row-major and width*height bytes, covering a
// disk around each detected star sized from its HFD (radius = max(minRadius, radiusScale*hfd)). Feed
// the result as `exclusionMask` to keep star-contaminated pixels out of background sampling. Star
// positions and HFD are in pixels; stars outside the frame contribute only their overlapping pixels.
export function backgroundExclusionMaskFromStars(width: number, height: number, stars: readonly DetectedStar[], options: BackgroundStarExclusionOptions = {}): Uint8Array {
	const radiusScale = options.radiusScale ?? 1.5
	const minRadius = options.minRadius ?? 4
	const mask = new Uint8Array(width * height)

	for (const star of stars) {
		const radius = Math.max(minRadius, radiusScale * star.hfd)
		const r2 = radius * radius
		const x0 = Math.max(0, Math.floor(star.x - radius))
		const x1 = Math.min(width - 1, Math.ceil(star.x + radius))
		const y0 = Math.max(0, Math.floor(star.y - radius))
		const y1 = Math.min(height - 1, Math.ceil(star.y + radius))

		for (let y = y0; y <= y1; y++) {
			const dy = y - star.y
			const dy2 = dy * dy
			let m = y * width + x0

			for (let x = x0; x <= x1; x++, m++) {
				const dx = x - star.x
				if (dx * dx + dy2 <= r2) mask[m] = 1
			}
		}
	}

	return mask
}
