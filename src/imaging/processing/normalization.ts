import { medianBySelectionOf, medianOf, quickSelect, STANDARD_DEVIATION_SCALE } from '../../core/util'
import { clamp } from '../../math/numerical/math'
import { DEFAULT_GRAYSCALE, type Image, type ImageRawType } from '../model/types'
// oxfmt-ignore
import { createScalarSurfaceEvaluator, createScalarSurfacePointEvaluator, createSurfaceColumnTable, fitScalarSurface, type ScalarSurfaceModel, type SurfaceDomain, type SurfaceModelType, type SurfaceSample } from './surface'

// Photometric normalization of a frame against a reference frame, applied after registration and
// before combination:
//
//   reference(x, y) ~= scale(x, y) * current(x, y) + offset(x, y)
//
// The global solution estimates one scale/offset pair per channel from robust quantiles of the
// overlapping pixels. The local solution keeps that global pair as its anchor and models only the
// smooth spatial residual around it, so a frame with a differential sky gradient (moonlight, drifting
// light pollution, changing transparency across the field) is matched everywhere instead of on
// average. Pixel values carry the image's own units; nothing is clamped, matching the stacker's
// existing semantics.
//
// The local residuals are estimated from PAIRED statistics of the same pixels, never from independent
// per-cell quantiles: the registered frame was resampled, which attenuates its noise by a factor that
// depends on the subpixel phase and therefore varies across the frame under rotation or scaling. A
// span ratio measures that attenuation and would inject a spurious, structured scale field.

// Robust estimator used to match two pixel distributions.
// - `scale`: multiplicative only, from the ratio of medians. No offset.
// - `background-scale`: matches the P25 background level and the P25..P75 span.
// - `percentile`: matches the P10 level and the P10..P90 span; more tolerant of bright structure.
export type GlobalNormalizationMode = 'scale' | 'background-scale' | 'percentile'

// How color images are normalized: each channel independently, or a single model derived from the
// luminance plane and applied to every channel. Falls back to per-channel for non-RGB images.
export type NormalizationColorMode = 'per-channel' | 'luminance'

// What to do with a plane whose local model cannot be fitted.
// - `global`: fall back to the global scale/offset anchor for that plane.
// - `identity`: leave that plane untouched.
// - `reject`: report the failure so the caller can drop the frame entirely.
export type LocalNormalizationFallback = 'global' | 'identity' | 'reject'

// Why a local model could not be produced for a plane.
export type LocalNormalizationFallbackReason =
	// No valid overlapping pixels at all.
	| 'no-valid-overlap'
	// The global anchor is non-finite or has a non-positive scale, so the log-scale model is undefined.
	| 'invalid-global-solution'
	// Too few grid cells produced a usable estimate.
	| 'insufficient-valid-cells'
	// The accepted cells are collinear or confined to a thin strip.
	| 'insufficient-spatial-coverage'
	// The surface solve failed (rank deficient, singular, or an unstable magnitude).
	| 'surface-fit-failed'

// A linear photometric transform: `normalized = scale * value + offset`.
export interface NormalizationParameters {
	// Multiplicative gain applied to the current frame.
	readonly scale: number
	// Additive pedestal applied after the gain, in image units.
	readonly offset: number
}

// Per-channel normalization scales/offsets and the resulting frame weight.
export interface FrameNormalizationSummary {
	// Per-channel multiplicative gain. In local mode these are the global anchor gains.
	readonly scales: readonly number[]
	// Per-channel additive pedestal. In local mode these are the global anchor offsets.
	readonly offsets: readonly number[]
	// Combination weight resolved for the frame.
	readonly weight: number
	// Local model diagnostics, present only when local normalization ran.
	readonly local?: LocalNormalizationSummary
}

// Compact local-model diagnostics retained per frame. Coefficients, control points, node grids, and
// per-cell samples are deliberately excluded: a live stack keeps one summary per frame forever.
export interface LocalNormalizationSummary {
	// Base estimator the local cells used.
	readonly estimator: GlobalNormalizationMode
	// Surface model fitted to the residual fields.
	readonly model: SurfaceModelType
	// One entry per fitted plane: `channelCount` in per-channel mode, one in RGB luminance mode.
	readonly channels: readonly LocalNormalizationChannelDiagnostics[]
	// True when at least one plane fell back.
	readonly fallback: boolean
}

// Fit diagnostics for one plane of the local model.
export interface LocalNormalizationChannelDiagnostics {
	// Grid cells that were examined.
	readonly candidateCells: number
	// Cells that produced a usable estimate and fed the surfaces.
	readonly acceptedCells: number
	// Cells discarded for insufficient valid pixels, too few pairs, or a degenerate estimate.
	readonly rejectedCells: number
	// Accepted cells that also cleared the dynamic-range gate and fed the scale surface. Zero means the
	// plane carries no local scale correction, only a local offset — the normal outcome for a frame
	// whose cells are all background-limited.
	readonly scaleCells: number
	// Robust dispersion of the scale-surface residuals, in log-gain units. 0 when there is no surface.
	readonly scaleResidual: number
	// Robust dispersion of the offset-surface residuals, in image units. Absent for `scale`.
	readonly offsetResidual?: number
	// True when the plane could not be modeled and follows the fallback policy.
	readonly fallback: boolean
	// Why the plane fell back.
	readonly reason?: LocalNormalizationFallbackReason
}

// Spatial confidence of one residual field, one value per grid cell, in [0, 1]. It multiplies that
// field, so an unsupported region converges to the global anchor instead of relying on the
// surface extrapolating there. Interior holes (a cell rejected because a bright object fills it) are
// filled back to full confidence: the surface interpolates them correctly from their neighbors, and
// forcing them back to the anchor would put a step right where the correction should be smoothest.
export interface LocalNormalizationSupportGrid {
	// Number of cells across.
	readonly columns: number
	// Number of cells down.
	readonly rows: number
	// Pixel x of the first cell center.
	readonly originX: number
	// Pixel y of the first cell center.
	readonly originY: number
	// Pixel spacing between cell centers along x.
	readonly stepX: number
	// Pixel spacing between cell centers along y.
	readonly stepY: number
	// Row-major confidence per cell, in [0, 1].
	readonly values: Float32Array
}

// A fitted local normalization model. Self-contained: it carries the anchor, the pivots, both clamp
// ranges, the support geometry, and the evaluation step, so `applyLocalNormalization` needs nothing
// else. Tied to the reference frame's pixel grid and not reusable on another geometry.
export interface LocalNormalizationModel {
	// Width, in pixels, of the grid the model applies to.
	readonly width: number
	// Height, in pixels, of the grid the model applies to.
	readonly height: number
	// Channels of the images the model applies to.
	readonly channelCount: number
	// Color handling used; `luminance` means one shared plane broadcast to all three channels.
	readonly colorMode: NormalizationColorMode
	// Base estimator used per cell.
	readonly estimator: GlobalNormalizationMode
	// Surface model fitted to the residual fields.
	readonly surfaceModel: SurfaceModelType
	// Fallback policy applied to planes that could not be modeled.
	readonly fallback: LocalNormalizationFallback
	// Global anchor, one entry per fitted plane.
	readonly global: readonly NormalizationParameters[]
	// Pivot value in the current frame's domain about which the local gain rotates, one per plane.
	// Undefined for `scale`, which carries no offset field.
	readonly pivots: readonly (number | undefined)[]
	// Residual log-gain surface per plane; undefined when the plane carries no local gain correction.
	readonly scaleSurfaces: readonly (ScalarSurfaceModel | undefined)[]
	// Residual offset surface per plane; undefined for `scale` and for fallen-back planes.
	readonly offsetSurfaces: readonly (ScalarSurfaceModel | undefined)[]
	// Clamp range of the residual log gain per plane, already intersected with `relativeScaleRange` and
	// always containing 0 so a zero residual reproduces the anchor exactly.
	readonly scaleLogRanges: readonly (readonly [number, number] | undefined)[]
	// Clamp range of the residual offset per plane, in image units, always containing 0.
	readonly offsetRanges: readonly (readonly [number, number] | undefined)[]
	// Spatial confidence grid per plane.
	// Spatial confidence of the OFFSET field per plane, from the cells that produced a usable estimate.
	readonly offsetSupportGrids: readonly LocalNormalizationSupportGrid[]
	// Spatial confidence of the GAIN field per plane, from the cells that cleared the dynamic-range gate.
	// Tracked separately because those are a subset: a frame whose texture sits in one region produces
	// gain samples only there, and reusing the offset support would apply the gain surface at full
	// confidence across regions that never constrained it.
	readonly scaleSupportGrids: readonly LocalNormalizationSupportGrid[]
	// Node spacing, in pixels, at which the final fields are materialized before interpolation.
	readonly evaluationStep: number
	// Per-plane fit diagnostics.
	readonly diagnostics: readonly LocalNormalizationChannelDiagnostics[]
}

// Tuning for the local normalization fit.
export interface LocalNormalizationOptions {
	// Robust estimator applied inside each cell. Default `background-scale`.
	readonly estimator?: GlobalNormalizationMode
	// Number of grid cells along the longer axis; the shorter axis scales to keep cells roughly square.
	readonly gridSize?: number
	// Side length in pixels of the sampled box inside each cell. 0 (default) uses the whole cell, so the
	// grid tiles the frame without gaps and every valid pixel can contribute.
	readonly boxSize?: number
	// Upper bound on sampled pixel pairs per cell. The box is strided down to this before any pixel is
	// read, so collection cost is independent of the box area.
	readonly maxSamplesPerCell?: number
	// Minimum pairs a cell needs. The estimators are quantile based, so a low floor feeds the surfaces
	// samples whose own error exceeds the effect being modeled.
	readonly minSamplesPerCell?: number
	// Minimum fraction of the strided pixels that must be valid for the cell to count.
	readonly minValidFraction?: number
	// Minimum cell dynamic range, in multiples of the paired noise, for the cell to contribute a GAIN
	// sample. A background-limited cell carries no gain information: its span is pure noise, and a span
	// ratio there measures the resampling's noise attenuation rather than photometry. Such cells still
	// contribute their offset. Ignored by `scale`, whose location ratio is well determined on flat sky.
	readonly dynamicRangeSigma?: number
	// Surface model fitted to both residual fields. Default `polynomial`; the spline costs O(k^3) per
	// surface per plane and is not advisable for live stacking.
	readonly surfaceModel?: SurfaceModelType
	// Degree of the residual offset surface. The offset field is supported by nearly every cell.
	readonly offsetDegree?: number
	// Degree of the residual gain surface. Kept low because the gain field is supported only by cells
	// with real dynamic range, and a high degree over sparse support overshoots between them.
	readonly scaleDegree?: number
	// Spline smoothing; ignored by the polynomial model.
	readonly smoothing?: number
	// Significance the fitted GAIN field must reach, in multiples of the standard error of its own
	// coefficients, before it is applied at all. A per-cell gain ratio is far noisier than a per-cell
	// offset, so a frame with no real gain variation would otherwise have that noise fitted into a
	// low-degree surface and multiplied back into every pixel — measurably worse than leaving the global
	// anchor alone. Below the threshold the plane keeps the anchor gain and only its offset field.
	// Evaluated from the Chebyshev coefficient bound, so it applies to the polynomial model only.
	readonly scaleSignificance?: number
	// Sigma multiple for symmetric rejection of outlying cells during the surface fit.
	readonly rejectionSigma?: number
	// Number of fit / reject / refit passes over the cells.
	readonly rejectionIterations?: number
	// Bounds on the LOCAL gain relative to the global anchor, as [min, max] ratios around 1. This limits
	// the spatial variation, not the absolute gain, so a legitimate global exposure difference is never
	// truncated. Must satisfy 0 < min <= 1 <= max.
	readonly relativeScaleRange?: readonly [number, number]
	// Node spacing of the materialized fields, as a fraction of the cell side. Evaluating the fields on
	// these nodes and interpolating removes the surface evaluation (and the exponential) from the
	// per-pixel path. The residual-range clamp puts a derivative kink wherever it binds, so the
	// interpolation error falls linearly rather than quadratically with the spacing; nodes cost a
	// fraction of a percent of the pixel count, so the default is set well past the point where the
	// error matters rather than at the coarsest tolerable value.
	readonly evaluationStepFraction?: number
	// What to do with a plane that cannot be modeled. Default `global`.
	readonly fallback?: LocalNormalizationFallback
}

// `LocalNormalizationOptions` plus the inputs the standalone entry points need.
export interface LocalNormalizationFitOptions extends LocalNormalizationOptions {
	// Color handling. Default `per-channel`.
	readonly colorMode?: NormalizationColorMode
	// Per-pixel validity mask of the registered frame, row-major with length width*height. Pixels with a
	// zero value are excluded from the fit and left untouched by the application. All pixels count when
	// omitted.
	readonly validityMask?: Readonly<Uint8Array>
}

// Result of the `localNormalization` convenience entry point.
export interface LocalNormalizationResult {
	// The normalized image; the same instance passed in, mutated in place.
	readonly image: Image
	// The model that was fitted and applied.
	readonly model: LocalNormalizationModel
}

// Default local normalization tuning. These are calibration candidates, not physical constants.
export const DEFAULT_LOCAL_NORMALIZATION_OPTIONS: Required<LocalNormalizationOptions> = {
	estimator: 'background-scale',
	gridSize: 16,
	boxSize: 0,
	maxSamplesPerCell: 1024,
	minSamplesPerCell: 256,
	minValidFraction: 0.25,
	dynamicRangeSigma: 4,
	surfaceModel: 'polynomial',
	offsetDegree: 3,
	scaleDegree: 1,
	smoothing: 0.1,
	scaleSignificance: 3,
	rejectionSigma: 3,
	rejectionIterations: 2,
	relativeScaleRange: [0.8, 1.25],
	evaluationStepFraction: 0.125,
	fallback: 'global',
}

// Maximum pixels sampled when estimating the global normalization scale/offset.
export const NORMALIZATION_SAMPLE_LIMIT = 8192

// Small epsilon guarding divisions and degeneracy tests.
const FLOAT_EPSILON = 1e-12

// Lower quantile each estimator anchors its level and span on; the upper one is its mirror.
const ESTIMATOR_QUANTILE: Readonly<Record<GlobalNormalizationMode, number>> = {
	scale: 0.25,
	'background-scale': 0.25,
	percentile: 0.1,
}

// Replaces non-finite scalars with a stable fallback.
function finiteOr(value: number, fallback: number) {
	return Number.isFinite(value) ? value : fallback
}

// Creates a constant-valued channel array.
function channelArray(channels: number, value: number) {
	const out = new Array<number>(channels)
	for (let i = 0; i < channels; i++) out[i] = value
	return out
}

// Collects paired overlap samples for the global fit, one distribution per plane. Walks a regular grid
// whose stride keeps the total near `NORMALIZATION_SAMPLE_LIMIT`, and keeps only pixels that are valid
// and finite in BOTH frames — a non-finite value would sort to the end of the distribution and poison
// every upper quantile drawn from it.
function collectNormalizationSamples(currentRaw: ImageRawType, valid: Readonly<Uint8Array> | undefined, referenceRaw: ImageRawType, channels: number, width: number, height: number, colorMode: NormalizationColorMode) {
	const step = Math.max(1, Math.floor(Math.sqrt((width * height) / NORMALIZATION_SAMPLE_LIMIT)))
	const luminance = colorMode === 'luminance' && channels === 3
	const planes = luminance ? 1 : channels
	const current: number[][] = new Array<number[]>(planes)
	const reference: number[][] = new Array<number[]>(planes)

	for (let plane = 0; plane < planes; plane++) {
		current[plane] = []
		reference[plane] = []
	}

	const { red, green, blue } = DEFAULT_GRAYSCALE

	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			const pixel = y * width + x
			if (valid !== undefined && valid[pixel] === 0) continue
			const base = pixel * channels

			if (luminance) {
				const currentLum = red * currentRaw[base] + green * currentRaw[base + 1] + blue * currentRaw[base + 2]
				const referenceLum = red * referenceRaw[base] + green * referenceRaw[base + 1] + blue * referenceRaw[base + 2]
				if (!Number.isFinite(currentLum) || !Number.isFinite(referenceLum)) continue
				current[0].push(currentLum)
				reference[0].push(referenceLum)
			} else {
				for (let channel = 0; channel < channels; channel++) {
					const c = currentRaw[base + channel]
					const r = referenceRaw[base + channel]
					if (!Number.isFinite(c) || !Number.isFinite(r)) continue
					current[channel].push(c)
					reference[channel].push(r)
				}
			}
		}
	}

	return { current, reference }
}

// Computes a percentile from an ascending-sorted numeric array by linear interpolation between ranks.
function percentileSorted(values: Float64Array, count: number, percentile: number) {
	if (count <= 0) return Number.NaN
	if (count === 1) return values[0]
	const clamped = clamp(percentile, 0, 1)
	const index = clamped * (count - 1)
	const lower = Math.floor(index)
	const upper = Math.min(lower + 1, count - 1)
	const fraction = index - lower
	return values[lower] + (values[upper] - values[lower]) * fraction
}

// Solves a robust linear normalization `reference ~= scale * current + offset` from two distributions
// of the same size. The distributions are matched by quantile, not by pair, which is the right choice
// globally: it tolerates the residual misregistration that would bias a paired regression over the
// whole frame. Returns identity for an empty input.
export function solveGlobalNormalization(reference: readonly number[], current: readonly number[], mode: GlobalNormalizationMode): NormalizationParameters {
	if (reference.length === 0 || current.length === 0) return { scale: 1, offset: 0 }

	const ref = Float64Array.from(reference).sort()
	const cur = Float64Array.from(current).sort()

	if (mode === 'scale') {
		const refMedian = medianOf(ref)
		const curMedian = medianOf(cur)
		const scale = Math.abs(curMedian) > FLOAT_EPSILON ? refMedian / curMedian : 1
		return { scale: finiteOr(scale, 1), offset: 0 }
	}

	const q = ESTIMATOR_QUANTILE[mode]
	const refBg = percentileSorted(ref, ref.length, q)
	const curBg = percentileSorted(cur, cur.length, q)
	const refSpan = Math.max(percentileSorted(ref, ref.length, 1 - q) - refBg, FLOAT_EPSILON)
	const curSpan = Math.max(percentileSorted(cur, cur.length, 1 - q) - curBg, FLOAT_EPSILON)
	const scale = finiteOr(refSpan / curSpan, 1)
	return { scale, offset: refBg - scale * curBg }
}

// Solves the global normalization for every fitted plane. Planes without usable overlap get identity.
export function solveGlobalNormalizationPlanes(currentRaw: ImageRawType, valid: Readonly<Uint8Array> | undefined, referenceRaw: ImageRawType, channels: number, width: number, height: number, mode: GlobalNormalizationMode, colorMode: NormalizationColorMode): NormalizationParameters[] {
	const overlap = collectNormalizationSamples(currentRaw, valid, referenceRaw, channels, width, height, colorMode)
	const planes = overlap.reference.length
	const out = new Array<NormalizationParameters>(planes)
	for (let plane = 0; plane < planes; plane++) out[plane] = solveGlobalNormalization(overlap.reference[plane], overlap.current[plane], mode)
	return out
}

// Broadcasts per-plane parameters to per-channel scale/offset arrays.
export function broadcastNormalizationPlanes(planes: readonly NormalizationParameters[], channels: number) {
	if (planes.length === 1 && channels > 1) return { scales: channelArray(channels, planes[0].scale), offsets: channelArray(channels, planes[0].offset) }

	const scales = new Array<number>(channels)
	const offsets = new Array<number>(channels)
	for (let channel = 0; channel < channels; channel++) {
		scales[channel] = planes[channel].scale
		offsets[channel] = planes[channel].offset
	}
	return { scales, offsets }
}

// Applies a per-channel linear normalization in place over the valid pixels.
export function applyGlobalNormalizationInPlace(raw: ImageRawType, valid: Readonly<Uint8Array>, channels: number, scales: readonly number[], offsets: readonly number[]) {
	for (let pixel = 0; pixel < valid.length; pixel++) {
		if (valid[pixel] === 0) continue
		const base = pixel * channels
		for (let channel = 0; channel < channels; channel++) raw[base + channel] = raw[base + channel] * scales[channel] + offsets[channel]
	}
}

// Resolves caller overrides into deterministic internal defaults. Non-finite numbers fall back to their
// default before clamping, so a stray NaN cannot silently disable a threshold. `gridSize` is rejected
// when non-finite because it drives the cell loop bounds and would otherwise produce an unbounded grid.
export function resolveLocalNormalizationOptions(options: LocalNormalizationOptions = {}): Required<LocalNormalizationOptions> {
	const gridSize = options.gridSize ?? DEFAULT_LOCAL_NORMALIZATION_OPTIONS.gridSize
	if (!Number.isFinite(gridSize)) throw new TypeError('gridSize must be a finite number')

	const defaults = DEFAULT_LOCAL_NORMALIZATION_OPTIONS
	const range = options.relativeScaleRange ?? defaults.relativeScaleRange
	const rmin = finiteOr(range[0], defaults.relativeScaleRange[0])
	const rmax = finiteOr(range[1], defaults.relativeScaleRange[1])

	// An inverted or non-positive range would invert the clamp and silently pin every local gain to a
	// wrong bound, producing a plausible-looking but wrong correction across the whole frame.
	if (!(rmin > 0 && rmin <= 1 && rmax >= 1)) throw new RangeError('relativeScaleRange must satisfy 0 < min <= 1 <= max')

	return {
		estimator: options.estimator ?? defaults.estimator,
		gridSize: Math.max(2, Math.trunc(gridSize)),
		boxSize: Math.max(0, Math.trunc(finiteOr(options.boxSize ?? defaults.boxSize, defaults.boxSize))),
		maxSamplesPerCell: Math.max(4, Math.trunc(finiteOr(options.maxSamplesPerCell ?? defaults.maxSamplesPerCell, defaults.maxSamplesPerCell))),
		minSamplesPerCell: Math.max(4, Math.trunc(finiteOr(options.minSamplesPerCell ?? defaults.minSamplesPerCell, defaults.minSamplesPerCell))),
		minValidFraction: clamp(finiteOr(options.minValidFraction ?? defaults.minValidFraction, defaults.minValidFraction), 0, 1),
		dynamicRangeSigma: Math.max(0, finiteOr(options.dynamicRangeSigma ?? defaults.dynamicRangeSigma, defaults.dynamicRangeSigma)),
		surfaceModel: options.surfaceModel ?? defaults.surfaceModel,
		offsetDegree: clamp(Math.trunc(finiteOr(options.offsetDegree ?? defaults.offsetDegree, defaults.offsetDegree)), 1, 6),
		scaleDegree: clamp(Math.trunc(finiteOr(options.scaleDegree ?? defaults.scaleDegree, defaults.scaleDegree)), 1, 6),
		smoothing: Math.max(0, finiteOr(options.smoothing ?? defaults.smoothing, defaults.smoothing)),
		scaleSignificance: Math.max(0, finiteOr(options.scaleSignificance ?? defaults.scaleSignificance, defaults.scaleSignificance)),
		rejectionSigma: Math.max(0, finiteOr(options.rejectionSigma ?? defaults.rejectionSigma, defaults.rejectionSigma)),
		rejectionIterations: Math.max(0, Math.trunc(finiteOr(options.rejectionIterations ?? defaults.rejectionIterations, defaults.rejectionIterations))),
		relativeScaleRange: [rmin, rmax],
		evaluationStepFraction: clamp(finiteOr(options.evaluationStepFraction ?? defaults.evaluationStepFraction, defaults.evaluationStepFraction), 0.01, 1),
		fallback: options.fallback ?? defaults.fallback,
	}
}

// Selects the value at quantile `q` from the mutable prefix [0, count) by selection rather than a full
// sort: the estimators need two or three order statistics, so O(n) selection beats O(n log n) sorting.
// The rank is taken to the nearest integer instead of interpolated; with hundreds of samples per cell
// the difference is far below the estimator's own noise.
function selectQuantile(values: Float64Array, count: number, q: number) {
	return quickSelect(values, count, clamp(Math.round(q * (count - 1)), 0, count - 1))
}

// Whether a fitted gain field carries more signal than the scatter of the cells that produced it.
//
// The peak-to-peak amplitude of a Chebyshev surface on [-1, 1]^2 is bounded by twice the L1 norm of its
// non-constant coefficients, since every |T_i| <= 1; at degree 1 that bound is exact. The standard error
// of the fit is its residual dispersion divided by the square root of the sample count. A field whose
// amplitude does not clear `sigma` standard errors is consistent with a constant gain, and applying it
// would multiply per-cell estimation noise into every pixel. The bound is only meaningful for the
// polynomial model, so a spline field is always accepted.
function isSignificantGainField(model: ScalarSurfaceModel, sigma: number) {
	if (sigma <= 0 || model.type !== 'polynomial') return true
	if (!(model.residual > 0) || model.acceptedSamples <= 0) return true

	let amplitude = 0
	for (let k = 1; k < model.coefficients.length; k++) amplitude += Math.abs(model.coefficients[k])

	return 2 * amplitude >= (sigma * model.residual) / Math.sqrt(model.acceptedSamples)
}

// Evaluates the fitted gain at every cell center, so the offset residuals can be rotated onto the gain
// that will actually be applied there. Returns a constant anchor gain when there is no gain field. The
// cell centers form a regular grid, so one column table drives the whole sweep with no allocation per
// cell. Confidence is 1 at an accepted cell by construction, so it is not applied here.
function evaluateGainAtCells(surface: ScalarSurfaceModel | undefined, range: readonly [number, number] | undefined, anchorScale: number, support: LocalNormalizationSupportGrid, cellX: Float64Array, cellY: Float64Array, mask: Uint8Array, cellCount: number) {
	const out = new Float64Array(cellCount)

	if (surface === undefined || range === undefined) {
		out.fill(anchorScale)
		return out
	}

	// Each cell is evaluated at the centroid of its valid pixel pairs, the same position its gain sample
	// was fitted at. A cell clipped by the validity mask — the norm along a registration boundary — sits
	// well off its nominal grid center, and the gain read there is what rotates its offset residual.
	//
	// The gain confidence is applied here for the same reason: this must be the gain the reconstruction
	// will actually use at that cell, and a cell that produced no gain sample of its own gets a faded one.
	const evaluator = createScalarSurfacePointEvaluator(surface)

	for (let cell = 0; cell < cellCount; cell++) {
		if (mask[cell] === 0) {
			out[cell] = anchorScale
			continue
		}

		const x = cellX[cell]
		const y = cellY[cell]
		out[cell] = anchorScale * Math.exp(clamp(sampleSupport(support, x, y) * evaluator.at(x, y), range[0], range[1]))
	}

	return out
}

// Per-cell paired estimate for one plane. The offset residual is deliberately reported at the GLOBAL
// slope: the gain that will actually be applied is only known once the gain field has been fitted and
// tested for significance, so the reconstruction rotates this value to that gain afterwards.
interface CellEstimate {
	// Residual offset at the global slope, in image units: median(ref - ag*cur) - bg.
	readonly offset: number
	// The cell's own gain estimate, or NaN when the cell carries no gain information.
	readonly gain: number
	// Robust level of the cell in the current frame, the point the offset residual is anchored at.
	readonly medianCurrent: number
	// Least-squares weight in (0, 1].
	readonly weight: number
}

// Estimates the local residuals of one cell for one plane from `count` pixel pairs.
//
// The offset comes from the median of the PAIRED difference `ref - ag*cur`, which cancels the
// astronomical signal common to both frames and is far more precise than differencing two independent
// quantiles.
//
// The gain comes from the estimator's own ratio, gated on the cell having real dynamic range: `refSpan`
// must exceed `dynamicRangeSigma` times the paired noise. `scale` skips the gate, since a ratio of
// medians is well determined on flat sky. A cell that fails the gate contributes no gain sample.
//
// `ref` and `cur` must stay paired, so the quantiles are taken on `refSelect`/`curSelect` copies. All
// three scratch buffers must hold at least `count` entries.
function estimateCell(ref: Float64Array, cur: Float64Array, refSelect: Float64Array, curSelect: Float64Array, scratch: Float64Array, count: number, ag: number, bg: number, estimator: GlobalNormalizationMode, dynamicRangeSigma: number, capacity: number, validFraction: number): CellEstimate | undefined {
	for (let k = 0; k < count; k++) scratch[k] = ref[k] - ag * cur[k]
	const center = medianBySelectionOf(scratch, count)
	if (!Number.isFinite(center)) return undefined

	for (let k = 0; k < count; k++) scratch[k] = Math.abs(ref[k] - ag * cur[k] - center)
	const noise = STANDARD_DEVIATION_SCALE * medianBySelectionOf(scratch, count)

	refSelect.set(ref.subarray(0, count))
	curSelect.set(cur.subarray(0, count))

	const q = ESTIMATOR_QUANTILE[estimator]
	const refSpan = selectQuantile(refSelect, count, 1 - q) - selectQuantile(refSelect, count, q)
	const curSpan = selectQuantile(curSelect, count, 1 - q) - selectQuantile(curSelect, count, q)
	const medianCurrent = medianBySelectionOf(curSelect, count)

	let gain = Number.NaN

	if (estimator === 'scale') {
		if (Math.abs(medianCurrent) > FLOAT_EPSILON) {
			const ratio = medianBySelectionOf(refSelect, count) / medianCurrent
			if (ratio > 0 && Number.isFinite(ratio)) gain = ratio
		}
	} else if (refSpan > FLOAT_EPSILON && curSpan > FLOAT_EPSILON && (!(dynamicRangeSigma > 0) || !(noise > 0) || refSpan >= dynamicRangeSigma * noise)) {
		const ratio = refSpan / curSpan
		if (ratio > 0 && Number.isFinite(ratio)) gain = ratio
	}

	// Reliability: how full the cell is, how much of it was valid, and how far its contrast rises above
	// its own noise. The last term saturates toward 1, so a bright cell is never favored without bound.
	const support = Math.sqrt(count / capacity)
	const contrast = noise > 0 && refSpan > 0 ? refSpan / (refSpan + noise) : 1
	const weight = clamp(support * validFraction * contrast, 1e-6, 1)

	return { offset: center - bg, gain, medianCurrent: Number.isFinite(medianCurrent) ? medianCurrent : 0, weight }
}

// Cell geometry of the local grid, precomputed per axis because the box bounds of a cell depend on a
// single axis index.
interface LocalGrid {
	readonly columns: number
	readonly rows: number
	readonly cellW: number
	readonly cellH: number
	readonly x0: Int32Array
	readonly x1: Int32Array
	readonly y0: Int32Array
	readonly y1: Int32Array
	readonly maxBoxW: number
	readonly maxBoxH: number
}

// Fills the per-axis box bounds of the grid. `boxPixels` of 0 makes each box its whole cell, so the
// grid tiles the frame without gaps; an explicit size centers a fixed window on the cell center and
// shifts it inside the frame at the edges.
function fillAxisBounds(n: number, cell: number, extent: number, boxPixels: number, lo: Int32Array, hi: Int32Array) {
	let maxBox = 0

	for (let i = 0; i < n; i++) {
		let a: number
		let b: number

		if (boxPixels > 0) {
			const center = Math.min((i + 0.5) * cell, extent - 1)
			a = clamp(Math.round(center - (boxPixels - 1) / 2), 0, Math.max(0, extent - boxPixels))
			b = Math.min(extent - 1, a + boxPixels - 1)
		} else {
			a = Math.floor(i * cell)
			b = Math.min(extent - 1, Math.ceil((i + 1) * cell) - 1)
			if (b < a) b = a
		}

		lo[i] = a
		hi[i] = b
		if (b - a + 1 > maxBox) maxBox = b - a + 1
	}

	return maxBox
}

// Builds the cell grid: roughly square cells along the longer axis, with a floor of `minCellsPerAxis`
// cells per axis so a high-aspect frame still yields a 2D layout the surface fit can use, and a ceiling
// of one cell per pixel so an extreme `gridSize` cannot blow the cell count up.
function buildLocalGrid(width: number, height: number, gridSize: number, boxSize: number, minCellsPerAxis: number): LocalGrid {
	const longAxis = Math.max(width, height)
	const cell = longAxis / gridSize
	const columns = clamp(Math.round(width / cell), Math.min(minCellsPerAxis, width), width)
	const rows = clamp(Math.round(height / cell), Math.min(minCellsPerAxis, height), height)
	const cellW = width / columns
	const cellH = height / rows
	const boxPixels = boxSize > 0 ? clamp(Math.trunc(boxSize), 1, longAxis) : 0

	const x0 = new Int32Array(columns)
	const x1 = new Int32Array(columns)
	const y0 = new Int32Array(rows)
	const y1 = new Int32Array(rows)
	const maxBoxW = fillAxisBounds(columns, cellW, width, boxPixels, x0, x1)
	const maxBoxH = fillAxisBounds(rows, cellH, height, boxPixels, y0, y1)

	return { columns, rows, cellW, cellH, x0, x1, y0, y1, maxBoxW, maxBoxH }
}

// Bounding box of the samples, used as the fit's normalization domain. Restricting it to the covered
// region keeps a partial overlap well conditioned: normalizing a narrow band against the whole frame
// collapses one axis and the degeneracy guard would reject an otherwise fine layout.
function sampleDomain(samples: readonly SurfaceSample[]): SurfaceDomain {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity

	for (const sample of samples) {
		if (sample.x < x0) x0 = sample.x
		if (sample.x > x1) x1 = sample.x
		if (sample.y < y0) y0 = sample.y
		if (sample.y > y1) y1 = sample.y
	}

	return { x0, y0, x1, y1 }
}

// Fills interior holes of the support mask and smooths it into the [0, 1] confidence grid.
//
// A cell rejected in the middle of a supported region (a bright galaxy filling it) is still correctly
// interpolated by the surface, so it keeps full confidence; only the outside of the covered region
// decays. The fill marks a cell interior when it lies between supported cells along BOTH axes. The
// separable [1, 2, 1] smoothing then removes the hard 0/1 step that a raw bilinear interpolation would
// turn into a visible seam at the cell boundaries.
function buildSupportGrid(mask: Uint8Array, columns: number, rows: number, originX: number, originY: number, stepX: number, stepY: number): LocalNormalizationSupportGrid {
	const rowSpan = new Uint8Array(columns * rows)
	const columnSpan = new Uint8Array(columns * rows)

	for (let r = 0; r < rows; r++) {
		const base = r * columns
		let lo = -1
		let hi = -1
		for (let c = 0; c < columns; c++) {
			if (mask[base + c] === 0) continue
			if (lo < 0) lo = c
			hi = c
		}
		for (let c = lo; c >= 0 && c <= hi; c++) rowSpan[base + c] = 1
	}

	for (let c = 0; c < columns; c++) {
		let lo = -1
		let hi = -1
		for (let r = 0; r < rows; r++) {
			if (mask[r * columns + c] === 0) continue
			if (lo < 0) lo = r
			hi = r
		}
		for (let r = lo; r >= 0 && r <= hi; r++) columnSpan[r * columns + c] = 1
	}

	const filled = new Float32Array(columns * rows)
	for (let i = 0; i < filled.length; i++) filled[i] = mask[i] !== 0 || (rowSpan[i] !== 0 && columnSpan[i] !== 0) ? 1 : 0

	const scratch = new Float32Array(columns * rows)
	for (let r = 0; r < rows; r++) {
		const base = r * columns
		for (let c = 0; c < columns; c++) {
			const left = filled[base + Math.max(0, c - 1)]
			const right = filled[base + Math.min(columns - 1, c + 1)]
			scratch[base + c] = 0.25 * left + 0.5 * filled[base + c] + 0.25 * right
		}
	}

	const values = new Float32Array(columns * rows)
	for (let r = 0; r < rows; r++) {
		const up = Math.max(0, r - 1) * columns
		const down = Math.min(rows - 1, r + 1) * columns
		const base = r * columns
		for (let c = 0; c < columns; c++) values[base + c] = 0.25 * scratch[up + c] + 0.5 * scratch[base + c] + 0.25 * scratch[down + c]
	}

	return { columns, rows, originX, originY, stepX, stepY, values }
}

// Bilinearly samples the support grid at a pixel position, clamped at the border so it never
// extrapolates, then eases it with a smoothstep so the confidence ramp is smooth rather than merely
// continuous. Returns a value in [0, 1].
function sampleSupport(grid: LocalNormalizationSupportGrid, x: number, y: number) {
	const { columns, rows, values } = grid
	const fx = columns > 1 ? (x - grid.originX) / grid.stepX : 0
	const fy = rows > 1 ? (y - grid.originY) / grid.stepY : 0
	const i0 = clamp(Math.floor(fx), 0, Math.max(0, columns - 2))
	const j0 = clamp(Math.floor(fy), 0, Math.max(0, rows - 2))
	const i1 = Math.min(i0 + 1, columns - 1)
	const j1 = Math.min(j0 + 1, rows - 1)
	const tx = clamp(fx - i0, 0, 1)
	const ty = clamp(fy - j0, 0, 1)

	const row0 = j0 * columns
	const row1 = j1 * columns
	const top = values[row0 + i0] + (values[row0 + i1] - values[row0 + i0]) * tx
	const bottom = values[row1 + i0] + (values[row1 + i1] - values[row1 + i0]) * tx
	const w = top + (bottom - top) * ty

	return w * w * (3 - 2 * w)
}

// Fits the local normalization model directly on raw pixel buffers already sharing the reference grid.
// `referenceRaw` is only read. Nothing is validated: both buffers must have the same geometry.
export function fitLocalNormalizationRaw(referenceRaw: ImageRawType, currentRaw: ImageRawType, width: number, height: number, channels: number, colorMode: NormalizationColorMode, valid: Readonly<Uint8Array> | undefined, options: Required<LocalNormalizationOptions>): LocalNormalizationModel {
	const { estimator, maxSamplesPerCell, minSamplesPerCell, minValidFraction, dynamicRangeSigma, surfaceModel, offsetDegree, scaleDegree, smoothing, scaleSignificance, rejectionSigma, rejectionIterations, relativeScaleRange, evaluationStepFraction, fallback } = options
	const luminance = colorMode === 'luminance' && channels === 3
	const planes = luminance ? 1 : channels
	const hasOffset = estimator !== 'scale'

	const global = solveGlobalNormalizationPlanes(currentRaw, valid, referenceRaw, channels, width, height, estimator, colorMode)
	const grid = buildLocalGrid(width, height, options.gridSize, options.boxSize, Math.max(offsetDegree, scaleDegree) + 1)
	const { columns, rows, cellW, cellH } = grid
	const cellCount = columns * rows

	// Stride the box down to the sample budget BEFORE reading any pixel, so collection cost scales with
	// `maxSamplesPerCell` rather than with the box area.
	const stride = Math.max(1, Math.ceil(Math.sqrt((grid.maxBoxW * grid.maxBoxH) / maxSamplesPerCell)))
	const capacity = Math.ceil(grid.maxBoxW / stride) * Math.ceil(grid.maxBoxH / stride)

	const refBuf = new Float64Array(planes * capacity)
	const curBuf = new Float64Array(planes * capacity)
	// Quantile selection permutes its input, so it runs on copies and leaves the paired buffers intact.
	const refSelect = new Float64Array(capacity)
	const curSelect = new Float64Array(capacity)
	const scratchBuf = new Float64Array(capacity)

	// The pivot is needed per cell, so it is drawn from the strided sample grid up front.
	const pivots = collectPivots(currentRaw, valid, channels, width, height, planes, luminance, estimator)

	// Per-cell state kept per plane so the offset residuals can be rotated onto the fitted gain without a
	// second pass over the pixels.
	const cellOffset: Float64Array[] = []
	const cellGain: Float64Array[] = []
	const cellLevel: Float64Array[] = []
	const cellWeight: Float64Array[] = []
	const cellX = new Float64Array(cellCount)
	const cellY = new Float64Array(cellCount)
	const masks: Uint8Array[] = []
	// Cells that also cleared the dynamic-range gate, which is what constrains the gain field.
	const gainMasks: Uint8Array[] = []
	const acceptedCells = new Int32Array(planes)
	const scaleCells = new Int32Array(planes)
	// Per-plane windows into the shared collection buffers, built once instead of per cell. The selection
	// helpers all operate on the [0, count) prefix, so one full-capacity view serves every cell.
	const refViews: Float64Array[] = []
	const curViews: Float64Array[] = []

	for (let plane = 0; plane < planes; plane++) {
		cellOffset.push(new Float64Array(cellCount))
		cellGain.push(new Float64Array(cellCount))
		cellLevel.push(new Float64Array(cellCount))
		cellWeight.push(new Float64Array(cellCount))
		masks.push(new Uint8Array(cellCount))
		gainMasks.push(new Uint8Array(cellCount))
		refViews.push(refBuf.subarray(plane * capacity, (plane + 1) * capacity))
		curViews.push(curBuf.subarray(plane * capacity, (plane + 1) * capacity))
	}

	const { red, green, blue } = DEFAULT_GRAYSCALE
	// Whether any cell saw a valid pixel pair at all, regardless of whether it went on to be usable.
	let observedValidPairs = false

	for (let r = 0; r < rows; r++) {
		const by0 = grid.y0[r]
		const by1 = grid.y1[r]

		for (let c = 0; c < columns; c++) {
			const bx0 = grid.x0[c]
			const bx1 = grid.x1[c]

			let count = 0
			let visited = 0
			let sumX = 0
			let sumY = 0

			for (let y = by0; y <= by1; y += stride) {
				const rowBase = y * width

				for (let x = bx0; x <= bx1; x += stride) {
					visited++
					const pixel = rowBase + x
					if (valid !== undefined && valid[pixel] === 0) continue
					const base = pixel * channels

					if (luminance) {
						const cv = red * currentRaw[base] + green * currentRaw[base + 1] + blue * currentRaw[base + 2]
						const rv = red * referenceRaw[base] + green * referenceRaw[base + 1] + blue * referenceRaw[base + 2]
						if (!Number.isFinite(cv) || !Number.isFinite(rv)) continue
						curBuf[count] = cv
						refBuf[count] = rv
					} else {
						// A pixel contributes to every plane or to none: a per-plane count would desynchronize the
						// pairing, and a non-finite channel marks the whole pixel as unusable in practice.
						let finite = true
						for (let channel = 0; channel < channels; channel++) {
							if (!Number.isFinite(currentRaw[base + channel]) || !Number.isFinite(referenceRaw[base + channel])) {
								finite = false
								break
							}
						}
						if (!finite) continue
						for (let plane = 0; plane < planes; plane++) {
							curBuf[plane * capacity + count] = currentRaw[base + plane]
							refBuf[plane * capacity + count] = referenceRaw[base + plane]
						}
					}

					sumX += x
					sumY += y
					count++
				}
			}

			// Recorded before the cell thresholds so the fallback can tell "the frames do not overlap" from
			// "they overlap but no cell was usable", which are different problems with different fixes.
			if (count > 0) observedValidPairs = true

			if (count < minSamplesPerCell || visited === 0) continue
			const validFraction = count / visited
			if (validFraction < minValidFraction) continue

			const cellIndex = r * columns + c
			cellX[cellIndex] = sumX / count
			cellY[cellIndex] = sumY / count

			for (let plane = 0; plane < planes; plane++) {
				const anchor = global[plane]
				if (!(anchor.scale > 0) || !Number.isFinite(anchor.offset)) continue

				const estimate = estimateCell(refViews[plane], curViews[plane], refSelect, curSelect, scratchBuf, count, anchor.scale, anchor.offset, estimator, dynamicRangeSigma, capacity, validFraction)
				if (estimate === undefined) continue

				const usable = hasOffset ? Number.isFinite(estimate.offset) : Number.isFinite(estimate.gain)
				if (!usable) continue

				masks[plane][cellIndex] = 1
				acceptedCells[plane]++
				cellOffset[plane][cellIndex] = estimate.offset
				cellGain[plane][cellIndex] = estimate.gain
				cellLevel[plane][cellIndex] = estimate.medianCurrent
				cellWeight[plane][cellIndex] = estimate.weight

				if (Number.isFinite(estimate.gain)) {
					gainMasks[plane][cellIndex] = 1
					scaleCells[plane]++
				}
			}
		}
	}

	const rejection = { mode: 'symmetric', low: rejectionSigma, high: rejectionSigma, iterations: rejectionIterations } as const
	const logMin = Math.log(relativeScaleRange[0])
	const logMax = Math.log(relativeScaleRange[1])

	const scaleSurfaces: (ScalarSurfaceModel | undefined)[] = []
	const offsetSurfaces: (ScalarSurfaceModel | undefined)[] = []
	const scaleLogRanges: ([number, number] | undefined)[] = []
	const offsetRanges: ([number, number] | undefined)[] = []
	const offsetSupportGrids: LocalNormalizationSupportGrid[] = []
	const scaleSupportGrids: LocalNormalizationSupportGrid[] = []
	const diagnostics: LocalNormalizationChannelDiagnostics[] = []
	const reportedPivots: (number | undefined)[] = []

	for (let plane = 0; plane < planes; plane++) {
		const anchor = global[plane]
		const accepted = acceptedCells[plane]
		let reason: LocalNormalizationFallbackReason | undefined
		let scaleSurface: ScalarSurfaceModel | undefined
		let offsetSurface: ScalarSurfaceModel | undefined
		let scaleRange: [number, number] | undefined
		let offsetRange: [number, number] | undefined
		// Whether the gain field solved at all, tracked apart from whether it was kept: the significance
		// test clears `scaleSurface` for a perfectly good fit that simply carries no usable signal.
		let scaleFitted = false

		if (!(anchor.scale > 0) || !Number.isFinite(anchor.offset)) reason = 'invalid-global-solution'
		else if (accepted === 0) reason = observedValidPairs ? 'insufficient-valid-cells' : 'no-valid-overlap'

		const mask = masks[plane]
		const gains = cellGain[plane]
		const weights = cellWeight[plane]
		// Built before the fits because stage 2 needs the gain confidence to rotate its residuals onto the
		// gain the reconstruction will actually apply.
		const offsetSupport = buildSupportGrid(mask, columns, rows, cellW / 2, cellH / 2, cellW, cellH)
		const scaleSupport = buildSupportGrid(gainMasks[plane], columns, rows, cellW / 2, cellH / 2, cellW, cellH)

		// Stage 1: the gain field, from the cells that cleared the dynamic-range gate. It is kept only when
		// it is significant against the scatter of those cells; an insignificant field would multiply
		// per-cell estimation noise into every pixel.
		if (reason === undefined && scaleCells[plane] > 0) {
			const samples: SurfaceSample[] = []
			for (let cell = 0; cell < cellCount; cell++) {
				if (mask[cell] === 0 || !Number.isFinite(gains[cell])) continue
				samples.push({ x: cellX[cell], y: cellY[cell], value: Math.log(gains[cell] / anchor.scale), weight: weights[cell] })
			}

			const fit = fitScalarSurface(samples, width, height, { model: surfaceModel, degree: scaleDegree, smoothing, rejection, domain: sampleDomain(samples) })

			if (fit.ok) {
				scaleFitted = true
				scaleSurface = isSignificantGainField(fit.model, scaleSignificance) ? fit.model : undefined
			} else if (!hasOffset) {
				reason = fit.reason === 'too-few-samples' ? 'insufficient-valid-cells' : fit.reason === 'degenerate-layout' ? 'insufficient-spatial-coverage' : 'surface-fit-failed'
			}
		}

		// The gain clamp is the data-supported extent intersected with the policy bound, widened to include
		// 0 so a zero residual — an unsupported region, or a frame that needs no local correction —
		// reproduces the global anchor exactly.
		if (scaleSurface !== undefined) {
			let lo = 0
			let hi = 0
			for (const sample of scaleSurface.samples) {
				if (!sample.accepted) continue
				if (sample.value < lo) lo = sample.value
				if (sample.value > hi) hi = sample.value
			}
			scaleRange = [Math.max(logMin, lo), Math.min(logMax, hi)]
		}

		// Stage 2: the offset field. Each cell's residual was measured at the global slope, so it is
		// rotated onto the gain that will actually be applied there. Holding it at the global slope
		// instead would leave a `(gain - ag) * (pivot - level)` error that varies from cell to cell with
		// the reference's own structure. `median(ref - a*cur)` moves by `-(a - ag) * level` as the slope
		// changes, which makes the rotation exact to first order without re-reading a single pixel.
		if (reason === undefined && hasOffset) {
			const pivot = pivots[plane]
			const levels = cellLevel[plane]
			const offsets = cellOffset[plane]
			const gainAtCell = evaluateGainAtCells(scaleSurface, scaleRange, anchor.scale, scaleSupport, cellX, cellY, mask, cellCount)
			const samples: SurfaceSample[] = []

			for (let cell = 0; cell < cellCount; cell++) {
				if (mask[cell] === 0) continue
				const value = (gainAtCell[cell] - anchor.scale) * (pivot - levels[cell]) + offsets[cell]
				samples.push({ x: cellX[cell], y: cellY[cell], value, weight: weights[cell] })
			}

			const fit = fitScalarSurface(samples, width, height, { model: surfaceModel, degree: offsetDegree, smoothing, rejection, domain: sampleDomain(samples) })
			if (fit.ok) offsetSurface = fit.model
			else reason = fit.reason === 'too-few-samples' ? 'insufficient-valid-cells' : fit.reason === 'degenerate-layout' ? 'insufficient-spatial-coverage' : 'surface-fit-failed'
		}

		// `scale` has no offset field, so the gain field is the whole model and its failure is the plane's
		// failure. A gain field that fitted and was then suppressed as insignificant is NOT a failure: the
		// frame simply needs no local gain correction, and the global anchor is the correct answer. Treating
		// it as one would drop a well-supported frame under `reject`, or discard its valid global exposure
		// correction under `identity`.
		if (reason === undefined && !hasOffset && !scaleFitted) reason = 'insufficient-valid-cells'

		if (offsetSurface !== undefined) {
			let lo = 0
			let hi = 0
			for (const sample of offsetSurface.samples) {
				if (!sample.accepted) continue
				if (sample.value < lo) lo = sample.value
				if (sample.value > hi) hi = sample.value
			}
			offsetRange = [lo, hi]
		}

		const failed = reason !== undefined
		if (failed) {
			scaleSurface = undefined
			offsetSurface = undefined
			scaleRange = undefined
			offsetRange = undefined
		}

		scaleSurfaces.push(scaleSurface)
		offsetSurfaces.push(offsetSurface)
		scaleLogRanges.push(scaleRange)
		offsetRanges.push(offsetRange)
		offsetSupportGrids.push(offsetSupport)
		scaleSupportGrids.push(scaleSupport)
		reportedPivots.push(hasOffset && !failed ? pivots[plane] : undefined)

		diagnostics.push({
			candidateCells: cellCount,
			acceptedCells: accepted,
			rejectedCells: cellCount - accepted,
			scaleCells: scaleCells[plane],
			scaleResidual: scaleSurface?.residual ?? 0,
			offsetResidual: offsetSurface?.residual,
			fallback: failed,
			reason,
		})
	}

	const evaluationStep = Math.max(1, Math.floor(Math.min(cellW, cellH) * evaluationStepFraction))

	return {
		width,
		height,
		channelCount: channels,
		colorMode,
		estimator,
		surfaceModel,
		fallback,
		global,
		pivots: reportedPivots,
		scaleSurfaces,
		offsetSurfaces,
		scaleLogRanges,
		offsetRanges,
		offsetSupportGrids,
		scaleSupportGrids,
		evaluationStep,
		diagnostics,
	}
}

// Robust pivots in the CURRENT frame's value domain, one per plane: the level the estimator anchors on,
// drawn from the same strided sample grid the global fit uses. The local gain rotates the transform
// about this value, so the offset and gain residuals stay decorrelated. Every plane is collected in one
// pass over the grid.
function collectPivots(currentRaw: ImageRawType, valid: Readonly<Uint8Array> | undefined, channels: number, width: number, height: number, planes: number, luminance: boolean, estimator: GlobalNormalizationMode) {
	const step = Math.max(1, Math.floor(Math.sqrt((width * height) / NORMALIZATION_SAMPLE_LIMIT)))
	const values: number[][] = new Array<number[]>(planes)
	for (let plane = 0; plane < planes; plane++) values[plane] = []
	const { red, green, blue } = DEFAULT_GRAYSCALE

	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			const pixel = y * width + x
			if (valid !== undefined && valid[pixel] === 0) continue
			const base = pixel * channels

			if (luminance) {
				const v = red * currentRaw[base] + green * currentRaw[base + 1] + blue * currentRaw[base + 2]
				if (Number.isFinite(v)) values[0].push(v)
			} else {
				for (let plane = 0; plane < planes; plane++) {
					const v = currentRaw[base + plane]
					if (Number.isFinite(v)) values[plane].push(v)
				}
			}
		}
	}

	const q = ESTIMATOR_QUANTILE[estimator]
	const pivots = new Float64Array(planes)
	for (let plane = 0; plane < planes; plane++) {
		if (values[plane].length === 0) continue
		const buffer = Float64Array.from(values[plane])
		pivots[plane] = selectQuantile(buffer, buffer.length, q)
	}
	return pivots
}

// Materialized final fields, sampled on a coarse node grid. Everything the reconstruction needs — the
// residual surfaces, the confidence, both clamps, the exponential, and the pivot term — is resolved
// here, so the per-pixel path only interpolates two numbers and applies them.
interface LocalNormalizationFields {
	readonly columns: number
	readonly rows: number
	readonly stepX: number
	readonly stepY: number
	readonly planes: number
	// Final gain per plane and node, plane-major.
	readonly scale: Float64Array
	// Final offset per plane and node, plane-major.
	readonly offset: Float64Array
}

// Evaluates the model onto its node grid.
function buildLocalNormalizationFields(model: LocalNormalizationModel): LocalNormalizationFields {
	const { width, height, evaluationStep } = model
	const planes = model.global.length
	const hasOffset = model.estimator !== 'scale'
	const identity = model.fallback === 'identity'

	const columns = width <= 2 ? Math.max(1, width) : clamp(Math.ceil((width - 1) / evaluationStep) + 1, 2, width)
	const rows = height <= 2 ? Math.max(1, height) : clamp(Math.ceil((height - 1) / evaluationStep) + 1, 2, height)
	const stepX = columns > 1 ? (width - 1) / (columns - 1) : 1
	const stepY = rows > 1 ? (height - 1) / (rows - 1) : 1

	const nodes = columns * rows
	const scale = new Float64Array(planes * nodes)
	const offset = new Float64Array(planes * nodes)
	const surfaceRow = new Float64Array(columns)

	for (let plane = 0; plane < planes; plane++) {
		const anchor = model.global[plane]
		const base = plane * nodes
		const diagnostics = model.diagnostics[plane]

		// A plane that could not be modeled follows the fallback policy. `reject` is reported to the caller
		// through the diagnostics; if the model is applied anyway, the global anchor is the safe choice.
		if (diagnostics.fallback) {
			scale.fill(identity ? 1 : anchor.scale, base, base + nodes)
			offset.fill(identity ? 0 : anchor.offset, base, base + nodes)
			continue
		}

		const offsetSupport = model.offsetSupportGrids[plane]
		const scaleSupport = model.scaleSupportGrids[plane]
		const scaleSurface = model.scaleSurfaces[plane]
		const offsetSurface = model.offsetSurfaces[plane]
		const scaleRange = model.scaleLogRanges[plane]
		const offsetRange = model.offsetRanges[plane]
		const pivot = model.pivots[plane] ?? 0

		const scaleEvaluator = scaleSurface === undefined ? undefined : createScalarSurfaceEvaluator(scaleSurface, createSurfaceColumnTable(scaleSurface.degree, scaleSurface.domain, columns, 0, stepX))
		const offsetEvaluator = offsetSurface === undefined ? undefined : createScalarSurfaceEvaluator(offsetSurface, createSurfaceColumnTable(offsetSurface.degree, offsetSurface.domain, columns, 0, stepX))

		for (let j = 0; j < rows; j++) {
			const py = j * stepY
			const row = base + j * columns

			// Each field is weighted by its own support: the gain field is constrained only by the cells that
			// cleared the dynamic-range gate, so it must fade to the anchor across the regions that produced
			// an offset but no gain rather than extrapolating over them at full confidence.
			if (scaleEvaluator !== undefined) {
				scaleEvaluator.fillRow(py, surfaceRow, 0, 1)
				for (let i = 0; i < columns; i++) scale[row + i] = anchor.scale * Math.exp(clamp(sampleSupport(scaleSupport, i * stepX, py) * surfaceRow[i], scaleRange![0], scaleRange![1]))
			} else {
				scale.fill(anchor.scale, row, row + columns)
			}

			if (!hasOffset) {
				offset.fill(0, row, row + columns)
				continue
			}

			if (offsetEvaluator !== undefined) {
				offsetEvaluator.fillRow(py, surfaceRow, 0, 1)
				for (let i = 0; i < columns; i++) offset[row + i] = anchor.offset + clamp(sampleSupport(offsetSupport, i * stepX, py) * surfaceRow[i], offsetRange![0], offsetRange![1]) - (scale[row + i] - anchor.scale) * pivot
			} else {
				for (let i = 0; i < columns; i++) offset[row + i] = anchor.offset - (scale[row + i] - anchor.scale) * pivot
			}
		}
	}

	return { columns, rows, stepX, stepY, planes, scale, offset }
}

// Applies a fitted local model in place over the valid pixels of `raw`.
//
// The final gain and offset fields are materialized on the model's node grid and then advanced
// incrementally along each row: between two nodes both fields are linear in x, so the per-pixel cost is
// two additions to advance plus one multiply-add to apply. Bilinearly blending two affine transforms
// yields an affine transform, so the interpolation cannot introduce structure of its own.
export function applyLocalNormalizationInPlace(raw: ImageRawType, valid: Readonly<Uint8Array> | undefined, model: LocalNormalizationModel) {
	const { width, height, channelCount } = model
	const fields = buildLocalNormalizationFields(model)
	const { columns, rows, stepX, stepY, planes } = fields
	const luminance = model.colorMode === 'luminance' && channelCount === 3 && planes === 1
	const nodes = columns * rows

	// Running value and per-pixel increment of both fields, one entry per plane.
	const scaleCurrent = new Float64Array(planes)
	const scaleStep = new Float64Array(planes)
	const offsetCurrent = new Float64Array(planes)
	const offsetStep = new Float64Array(planes)
	// Node row pair interpolated in y, reused for every row.
	const scaleRow = new Float64Array(planes * columns)
	const offsetRow = new Float64Array(planes * columns)

	for (let y = 0; y < height; y++) {
		const fy = rows > 1 ? y / stepY : 0
		const j0 = clamp(Math.floor(fy), 0, Math.max(0, rows - 2))
		const j1 = Math.min(j0 + 1, rows - 1)
		const ty = rows > 1 ? clamp(fy - j0, 0, 1) : 0
		const rowBase = y * width

		for (let plane = 0; plane < planes; plane++) {
			const planeBase = plane * nodes
			const a = planeBase + j0 * columns
			const b = planeBase + j1 * columns
			const out = plane * columns
			for (let i = 0; i < columns; i++) {
				scaleRow[out + i] = fields.scale[a + i] + (fields.scale[b + i] - fields.scale[a + i]) * ty
				offsetRow[out + i] = fields.offset[a + i] + (fields.offset[b + i] - fields.offset[a + i]) * ty
			}
		}

		// Between two nodes both fields are linear in x, so each segment is walked with a running value and
		// a fixed increment. The increment is applied on every pixel, valid or not, so the running value
		// stays aligned with the column.
		const segments = Math.max(1, columns - 1)

		for (let segment = 0; segment < segments; segment++) {
			const xs = columns > 1 ? Math.ceil(segment * stepX) : 0
			const xe = segment === segments - 1 ? width - 1 : Math.min(width - 1, Math.ceil((segment + 1) * stepX) - 1)
			if (xs > xe) continue

			const i0 = Math.min(segment, columns - 1)
			const i1 = Math.min(segment + 1, columns - 1)
			const invStep = columns > 1 ? 1 / stepX : 0
			const t0 = columns > 1 ? (xs - segment * stepX) * invStep : 0

			for (let plane = 0; plane < planes; plane++) {
				const nodes = plane * columns
				const sa = scaleRow[nodes + i0]
				const sb = scaleRow[nodes + i1]
				const oa = offsetRow[nodes + i0]
				const ob = offsetRow[nodes + i1]
				scaleCurrent[plane] = sa + (sb - sa) * t0
				scaleStep[plane] = (sb - sa) * invStep
				offsetCurrent[plane] = oa + (ob - oa) * t0
				offsetStep[plane] = (ob - oa) * invStep
			}

			// RGB luminance shares one plane across the three channels, so it keeps the running pair in
			// scalars instead of touching the per-plane arrays on every pixel.
			if (luminance) {
				let s = scaleCurrent[0]
				let o = offsetCurrent[0]
				const ds = scaleStep[0]
				const doff = offsetStep[0]

				for (let x = xs; x <= xe; x++, s += ds, o += doff) {
					const pixel = rowBase + x
					if (valid !== undefined && valid[pixel] === 0) continue
					const base = pixel * channelCount
					raw[base] = raw[base] * s + o
					raw[base + 1] = raw[base + 1] * s + o
					raw[base + 2] = raw[base + 2] * s + o
				}

				continue
			}

			for (let x = xs; x <= xe; x++) {
				const pixel = rowBase + x

				if (valid === undefined || valid[pixel] !== 0) {
					const base = pixel * channelCount
					for (let plane = 0; plane < planes; plane++) raw[base + plane] = raw[base + plane] * scaleCurrent[plane] + offsetCurrent[plane]
				}

				for (let plane = 0; plane < planes; plane++) {
					scaleCurrent[plane] += scaleStep[plane]
					offsetCurrent[plane] += offsetStep[plane]
				}
			}
		}
	}
}

// Whether any plane of the model failed to fit and is running on the fallback policy.
export function isLocalNormalizationFallback(model: LocalNormalizationModel) {
	for (const diagnostics of model.diagnostics) if (diagnostics.fallback) return true
	return false
}

// First fallback reason reported by the model, if any.
export function localNormalizationFailureReason(model: LocalNormalizationModel) {
	for (const diagnostics of model.diagnostics) if (diagnostics.reason !== undefined) return diagnostics.reason
	return undefined
}

// Compact per-frame diagnostics for a fitted model.
export function localNormalizationSummary(model: LocalNormalizationModel): LocalNormalizationSummary {
	return {
		estimator: model.estimator,
		model: model.surfaceModel,
		channels: model.diagnostics,
		fallback: isLocalNormalizationFallback(model),
	}
}

// Throws when a fitted model's geometry does not match the image it is being applied to. Applying a
// model built on another grid would silently produce a plausible-looking but wrong correction.
function ensureModelMatchesImage(model: LocalNormalizationModel, image: Image) {
	const { width, height, channels } = image.metadata
	if (width !== model.width || height !== model.height || channels !== model.channelCount) {
		throw new Error(`local normalization model geometry (${model.width}x${model.height}x${model.channelCount}) does not match image (${width}x${height}x${channels})`)
	}
}

// Fits a local normalization model matching `current` to `reference`.
//
// Both images must already be registered onto the same grid and share width, height, and channel count;
// this is a documented precondition, not a checked one. `reference` is only read.
export function fitLocalNormalization(reference: Image, current: Image, options: LocalNormalizationFitOptions = {}): LocalNormalizationModel {
	const { width, height, channels } = reference.metadata
	const resolved = resolveLocalNormalizationOptions(options)
	return fitLocalNormalizationRaw(reference.raw, current.raw, width, height, channels, options.colorMode ?? 'per-channel', options.validityMask, resolved)
}

// Applies a fitted model to `image` in place, returning the same instance. Pixels outside
// `validityMask` are left untouched. Throws when the model geometry does not match the image.
export function applyLocalNormalization(image: Image, model: LocalNormalizationModel, validityMask?: Readonly<Uint8Array>): Image {
	ensureModelMatchesImage(model, image)
	applyLocalNormalizationInPlace(image.raw, validityMask, model)
	return image
}

// Fits and applies a local normalization in one step. `current` is mutated in place and returned as
// part of the result; `reference` is only read.
export function localNormalization(reference: Image, current: Image, options: LocalNormalizationFitOptions = {}): LocalNormalizationResult {
	const model = fitLocalNormalization(reference, current, options)
	return { image: applyLocalNormalization(current, model, options.validityMask), model }
}
