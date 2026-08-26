import { medianBySelectionOf, medianOf, quickSelect, STANDARD_DEVIATION_SCALE } from '../../core/util'
import { clamp } from '../../math/numerical/math'
import { DEFAULT_GRAYSCALE, type Image, type ImageRawType } from '../model/types'
// oxfmt-ignore
import { createScalarSurfaceEvaluator, createScalarSurfacePointEvaluator, createSurfaceColumnTable, fitScalarSurface, type ScalarSurfaceModel, type ScalarSurfacePointEvaluator, type SurfaceDomain, type SurfaceModelType, type SurfaceSample } from './surface'

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
	// Cells that produced a usable estimate and were submitted to the surfaces. The surfaces then apply
	// their own residual rejection, so this is not the count that fed the final fit; that one lives on
	// each `ScalarSurfaceModel` as `acceptedSamples`.
	readonly acceptedCells: number
	// Cells discarded for insufficient valid pixels, too few pairs, or a degenerate estimate. Cells the
	// surface fit later rejected as residual outliers are not counted here.
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
	// read, so collection cost is independent of the box area. Clamped to `MAX_SAMPLES_PER_CELL`, which is
	// what keeps the collection buffers - sized by this, not by the image - bounded.
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
	// The image that was passed in. Mutated in place when the model was applied, untouched otherwise.
	readonly image: Image
	// The model that was fitted.
	readonly model: LocalNormalizationModel
	// Whether the model was applied to `image`. False only under `fallback: 'reject'` with a plane that
	// could not be modeled, which is the caller's signal to drop the frame; `model.diagnostics` says why.
	readonly applied: boolean
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

// Minimum strided global samples trusted for percentile spans. A handful of lattice hits can identify
// overlap but not a robust lower/upper quantile pair, so those planes retry with the bounded dense scan.
const MIN_GLOBAL_NORMALIZATION_LATTICE_SAMPLES = 32

// Upper bound on grid cells, over all axes combined. Every cell carries several `Float64Array` entries
// per plane plus its coordinates, mask, and support value, and each accepted cell also becomes a surface
// sample object, so the cell count sets the fit's whole memory footprint. `gridSize` is a caller-supplied
// number and a large frame makes even one cell per pixel ruinous, so the grid is scaled back to this
// budget instead. It is 256 times the default 16x16 grid, well past any density a smooth residual field
// can use, and its per-plane state stays in the low megabytes.
const MAX_LOCAL_NORMALIZATION_CELLS = 65536

// Ceiling on materialized field nodes, summed over planes. Each node carries a gain and an offset in
// plane-major `Float64Array`s, so this bounds that pair at about 16 MB. The node grid exists to be a
// cheap intermediate between the fitted surfaces and the pixels; past this it stops being one.
const MAX_LOCAL_NORMALIZATION_NODES = 1_048_576

// Ceiling on pixel pairs collected from one cell. The collection buffers are sized by this times the
// plane count, so without it a caller raising `boxSize` and `maxSamplesPerCell` together sizes them by
// the image instead: a 4096x4096 RGB frame asking for a full-frame box reserves about 1.2 GB and then
// rescans that whole box for every cell. The estimators are quantile based and 1024 pairs already put
// their precision near a few percent, so this ceiling sits far past anything a cell can use.
const MAX_SAMPLES_PER_CELL = 65536

// Sampled pixels the whole cell scan may read per plane, as a multiple of the frame's own pixel count.
//
// The cell ceiling and the per-cell ceiling bound their factors separately and their product not at all.
// Boxes only tile the frame while `boxSize` stays within the cell; a larger one is centred on each cell
// and overlaps its neighbours, so the same pixels are re-read once per cell. A 4096x4096 frame with
// `gridSize: 4096` and `boxSize: 4096` sits inside both ceilings and still asks for 65536 cells of
// 65536 pairs — 4.3 billion sampled pixels per plane, and as many quantile-selection steps after them.
// A 128x128 frame scaled the same way already takes 17 seconds.
//
// Two frame areas leave the tiling case untouched (its total is the frame area at most, before striding)
// and give a modestly oversized box room to overlap, while turning the pathological grid into a scan
// proportional to the image. Cells thinned below `minSamplesPerCell` by this simply drop out, which is
// what the same grid already does when its boxes tile.
const LOCAL_NORMALIZATION_SAMPLING_OVERLAP = 2

// Sparse phase retries per cell. A product of 64 covers every residue pair for strides up to 8x8, which
// is enough for the common budgeted boxes that otherwise miss whole parity classes, while keeping
// adversarial masks from turning every rejected cell into an unbounded dense scan.
const MAX_LOCAL_NORMALIZATION_CELL_PHASES = 64

// Maximum dense-retry visits relative to the per-cell estimator reservoir. This keeps the fallback that
// escapes adversarial residue masks bounded even when a box is much larger than the useful sample count.
const LOCAL_NORMALIZATION_DENSE_RETRY_FACTOR = 16

// Ceiling on spline field work, as nodes times control points summed over planes. A spline evaluates
// every node against every control with a logarithm each, so the node count alone does not bound it.
// Kept well below the materialization budget in `surface.ts` because this runs per frame in a stack,
// not once per image.
const MAX_LOCAL_NORMALIZATION_FIELD_WORK = 1e8

// Fraction of a final local-normalization field's fitted range that a coarse TPS probe may deviate by.
// Probed cells beyond this are evaluated directly, so the known TPS error does not reach the output.
const LOCAL_NORMALIZATION_TPS_FIELD_TOLERANCE = 0.005

// Kernel evaluations spent probing TPS field accuracy before falling back to direct cells. Every control
// is always checked; this caps only the supplemental coarse-cell centre probes.
const MAX_LOCAL_NORMALIZATION_TPS_FIELD_VERIFICATION_WORK = 2e6

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
// whose stride keeps the total near `NORMALIZATION_SAMPLE_LIMIT`, falling back to a dense bounded scan
// over each underfilled plane's usable pairs when that grid finds too little for robust quantiles.
function collectNormalizationSamples(currentRaw: ImageRawType, valid: Readonly<Uint8Array> | undefined, referenceRaw: ImageRawType, channels: number, width: number, height: number, colorMode: NormalizationColorMode) {
	const step = Math.max(1, Math.floor(Math.sqrt((width * height) / NORMALIZATION_SAMPLE_LIMIT)))
	const lattice = scanNormalizationSamples(currentRaw, valid, referenceRaw, channels, width, height, colorMode, step, 1)

	// The strided lattice is anchored at the origin, so a mask — or a channel that happens to be
	// non-finite exactly there — can miss it while leaving almost the whole plane usable. Clearing exactly
	// the sampled positions of a 512x512 frame leaves 96% of the pixels and every grid cell working, yet
	// the anchor that plane's residuals are measured against comes back as identity with nothing marking
	// it. A few lattice hits are not enough either: they prove overlap but cannot estimate the quantile
	// span. Each plane is judged on its own; one channel finding samples says nothing about another.
	let underfilled = false
	for (const plane of lattice.reference) if (plane.length < MIN_GLOBAL_NORMALIZATION_LATTICE_SAMPLES) underfilled = true
	if (!underfilled) return lattice

	// Striding over the valid pixels themselves is what no mask geometry can defeat. Only the planes that
	// came back underfilled take it, so a plane the lattice already covered keeps exactly the samples it
	// had. The stride is derived from usable pairs per plane, not mask-valid pixels, so sparse finite
	// overlap is not thinned below the sample limit before the solver ever sees it.
	const denseKeepEvery = normalizationKeepEveryByPlane(countNormalizationPairs(currentRaw, valid, referenceRaw, channels, width, height, colorMode))
	const dense = scanNormalizationSamples(currentRaw, valid, referenceRaw, channels, width, height, colorMode, 1, denseKeepEvery)

	for (let plane = 0; plane < lattice.reference.length; plane++) {
		if (lattice.reference[plane].length >= MIN_GLOBAL_NORMALIZATION_LATTICE_SAMPLES) continue
		if (dense.reference[plane].length <= lattice.reference[plane].length) continue
		lattice.reference[plane] = dense.reference[plane]
		lattice.current[plane] = dense.current[plane]
	}

	return lattice
}

// Counts finite current/reference pairs in each fitted plane.
function countNormalizationPairs(currentRaw: ImageRawType, valid: Readonly<Uint8Array> | undefined, referenceRaw: ImageRawType, channels: number, width: number, height: number, colorMode: NormalizationColorMode) {
	const luminance = colorMode === 'luminance' && channels === 3
	const planes = luminance ? 1 : channels
	const counts = new Array<number>(planes)
	for (let plane = 0; plane < planes; plane++) counts[plane] = 0
	const { red, green, blue } = DEFAULT_GRAYSCALE

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const pixel = y * width + x
			if (valid !== undefined && valid[pixel] === 0) continue
			const base = pixel * channels

			if (luminance) {
				const currentLum = red * currentRaw[base] + green * currentRaw[base + 1] + blue * currentRaw[base + 2]
				const referenceLum = red * referenceRaw[base] + green * referenceRaw[base + 1] + blue * referenceRaw[base + 2]
				if (Number.isFinite(currentLum) && Number.isFinite(referenceLum)) counts[0]++
			} else {
				for (let channel = 0; channel < channels; channel++) if (Number.isFinite(currentRaw[base + channel]) && Number.isFinite(referenceRaw[base + channel])) counts[channel]++
			}
		}
	}

	return counts
}

// How many usable pairs to skip per plane so a dense fallback keeps up to the global sample limit.
function normalizationKeepEveryByPlane(counts: readonly number[]) {
	const keepEvery = new Array<number>(counts.length)
	for (let plane = 0; plane < counts.length; plane++) keepEvery[plane] = Math.max(1, Math.floor(counts[plane] / NORMALIZATION_SAMPLE_LIMIT))
	return keepEvery
}

// Walks the frame at `step` pixels and keeps every `keepEvery`-th usable pair, one distribution per
// fitted plane. Keeps only pixels finite in BOTH frames — a non-finite value would sort to the end of
// the distribution and poison every upper quantile drawn from it.
//
// The thinning counter is per plane and advances only on pairs that plane can actually use. Counting
// visited pixels instead would put every plane on the same lattice of kept positions, which a channel
// non-finite exactly there can miss entirely: the dense fallback would then come back empty for it and
// the plane would take an identity transform with nothing marking it. Counting usable pairs makes the
// kept set a fixed fraction of whatever each plane has, whatever the geometry of the damage.
function scanNormalizationSamples(currentRaw: ImageRawType, valid: Readonly<Uint8Array> | undefined, referenceRaw: ImageRawType, channels: number, width: number, height: number, colorMode: NormalizationColorMode, step: number, keepEvery: number | readonly number[]) {
	const luminance = colorMode === 'luminance' && channels === 3
	const planes = luminance ? 1 : channels
	const current: number[][] = new Array<number[]>(planes)
	const reference: number[][] = new Array<number[]>(planes)
	const planeKeepEvery = typeof keepEvery === 'number' ? undefined : keepEvery
	const sharedKeepEvery = typeof keepEvery === 'number' ? keepEvery : 1

	for (let plane = 0; plane < planes; plane++) {
		current[plane] = []
		reference[plane] = []
	}

	const { red, green, blue } = DEFAULT_GRAYSCALE
	// Usable pairs seen so far, per plane, which is what the thinning counts down.
	const seen = new Int32Array(planes)

	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			const pixel = y * width + x
			if (valid !== undefined && valid[pixel] === 0) continue
			const base = pixel * channels

			if (luminance) {
				const currentLum = red * currentRaw[base] + green * currentRaw[base + 1] + blue * currentRaw[base + 2]
				const referenceLum = red * referenceRaw[base] + green * referenceRaw[base + 1] + blue * referenceRaw[base + 2]
				if (!Number.isFinite(currentLum) || !Number.isFinite(referenceLum)) continue
				if (seen[0]++ % (planeKeepEvery?.[0] ?? sharedKeepEvery) !== 0) continue
				current[0].push(currentLum)
				reference[0].push(referenceLum)
			} else {
				for (let channel = 0; channel < channels; channel++) {
					const c = currentRaw[base + channel]
					const r = referenceRaw[base + channel]
					if (!Number.isFinite(c) || !Number.isFinite(r)) continue
					if (seen[channel]++ % (planeKeepEvery?.[channel] ?? sharedKeepEvery) !== 0) continue
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
	const refSpan = percentileSorted(ref, ref.length, 1 - q) - refBg
	const curSpan = percentileSorted(cur, cur.length, 1 - q) - curBg
	// A collapsed distribution contains no scale information. Matching only its background level avoids
	// turning the epsilon denominator into an enormous gain that amplifies insignificant variation.
	if (refSpan <= FLOAT_EPSILON || curSpan <= FLOAT_EPSILON) return { scale: 1, offset: refBg - curBg }
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
		maxSamplesPerCell: clamp(Math.trunc(finiteOr(options.maxSamplesPerCell ?? defaults.maxSamplesPerCell, defaults.maxSamplesPerCell)), 4, MAX_SAMPLES_PER_CELL),
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
// This is the only thing standing between the output and a resampling artifact, so the comparison has to
// be calibrated properly. Registration resamples the current frame, which attenuates its high-frequency
// content by an amount that depends on the subpixel phase and therefore varies across a rotated or
// scaled frame. Every second-moment gain estimator — the quantile span used here, an ordinary
// least-squares slope on the pairs, orthogonal regression — reads that spectral change as a gain, and
// the dynamic-range gate does not prevent it, because a star profile is attenuated just as a noise
// sample is. What separates the artifact from a real gain field is coherence: a real field agrees from
// cell to cell, while the artifact scatters wildly and only survives as a low-amplitude fit through very
// noisy samples.
//
// So each non-constant coefficient must clear `sigma` standard errors on its own. The comparison is made
// on the mean absolute coefficient against the per-coefficient standard error, which is the residual
// dispersion over the square root of the sample count. Comparing the surface's whole peak-to-peak
// amplitude against a single standard error instead — twice the L1 norm of the non-constant Chebyshev
// coefficients, since every |T_i| <= 1 — asks each coefficient to clear only `sigma / (2 * terms)`, well
// under one sigma at the default, which is how a rotation with no photometric difference at all produced
// a 4% gain field. The bound is only meaningful for the polynomial model, so a spline field is always
// accepted.
function isSignificantGainField(model: ScalarSurfaceModel, sigma: number) {
	if (sigma <= 0 || model.type !== 'polynomial') return true

	// With no residual degrees of freedom the fit passes exactly through its samples and reports a zero
	// residual, which says nothing about their scatter. Reading that as "no noise" would let a field
	// supported by as few samples as it has coefficients through at any threshold, and that is precisely
	// the case where per-cell ratio noise becomes the whole field. The standard error is unavailable, so
	// the field is suppressed and the plane keeps the global anchor.
	if (model.acceptedSamples <= model.coefficients.length) return false

	if (!(model.residual > 0)) return true

	let amplitude = 0
	let terms = 0

	for (let k = 1; k < model.coefficients.length; k++) {
		amplitude += Math.abs(model.coefficients[k])
		terms++
	}

	// A surface with no non-constant term carries no spatial correction at all.
	if (terms === 0) return false

	return amplitude / terms >= (sigma * model.residual) / Math.sqrt(model.acceptedSamples)
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
		out[cell] = anchorScale * Math.exp(sampleSupport(support, x, y) * clamp(evaluator.at(x, y), range[0], range[1]))
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

// Per-axis sampling strides that keep a box of `boxW` x `boxH` pixels within `maxSamples` pairs while
// preserving its aspect ratio, plus the exact number of pairs the strided scan can yield.
//
// The x budget is `sqrt(maxSamples * boxW / boxH)`, capped by the box width and by the budget itself so
// an extremely wide box cannot claim more columns than the whole budget. Whatever the x pass leaves is
// then spent on y, which keeps `columns * rows <= maxSamples` exactly.
function resolveCellStride(boxW: number, boxH: number, maxSamples: number) {
	if (boxW * boxH <= maxSamples) return { strideX: 1, strideY: 1, capacity: boxW * boxH }

	const targetX = clamp(Math.floor(Math.sqrt((maxSamples * boxW) / boxH)), 1, Math.min(boxW, maxSamples))
	const strideX = Math.max(1, Math.ceil(boxW / targetX))
	const columns = Math.ceil(boxW / strideX)
	const targetY = Math.max(1, Math.floor(maxSamples / columns))
	const strideY = Math.max(1, Math.ceil(boxH / targetY))
	const rows = Math.ceil(boxH / strideY)

	return { strideX, strideY, capacity: columns * rows }
}

// Greatest common divisor for positive integer scan lengths.
function integerGcd(a: number, b: number) {
	while (b !== 0) {
		const r = a % b
		a = b
		b = r
	}
	return a
}

// A row-major step coprime to `count`, so a bounded retry walks a deterministic permutation prefix
// instead of falling onto one residue class of a wide box.
function coprimeSamplingStep(count: number, target: number) {
	if (count <= 1) return 1
	let step = Math.max(1, Math.floor(count / target))
	if (step >= count) step = count - 1
	while (integerGcd(step, count) !== 1) {
		step++
		if (step >= count) step = 1
	}
	return step
}

// Whether a pixel coordinate in the current cell was already visited by one of the sparse sampling
// phases. Dense retries use this to supplement the sparse reservoir with new coordinates instead of
// recounting the same finite pair twice.
function sparseCellPhasesVisited(x: number, y: number, bx0: number, bx1: number, by0: number, by1: number, strideX: number, strideY: number, phaseOffsetsX: Int32Array, phaseOffsetsY: Int32Array, phases: number) {
	for (let phase = 0; phase < phases; phase++) {
		const originX = Math.min(bx0 + phaseOffsetsX[phase], bx1)
		if (x < originX || (x - originX) % strideX !== 0) continue

		const originY = Math.min(by0 + phaseOffsetsY[phase], by1)
		if (y >= originY && (y - originY) % strideY === 0) return true
	}

	return false
}

// Adds one unique sparse-scan phase residue in [0, stride). Returns the updated count.
function addCellPhaseOffset(offsets: Int32Array, count: number, stride: number, offset: number) {
	const bounded = clamp(offset, 0, Math.max(0, stride - 1))
	for (let i = 0; i < count; i++) if (offsets[i] === bounded) return count
	offsets[count] = bounded
	return count + 1
}

// Sparse-scan residues for one axis. The origin keeps the common path unchanged; half and quarter
// residues reach masks aligned to even/odd classes while keeping the phase product bounded.
function buildCellPhaseOffsets(stride: number, offsets: Int32Array) {
	let count = 1
	offsets[0] = 0
	if (stride > 1) count = addCellPhaseOffset(offsets, count, stride, stride >> 1)
	if (stride > 2) count = addCellPhaseOffset(offsets, count, stride, stride >> 2)
	if (stride > 3) count = addCellPhaseOffset(offsets, count, stride, Math.floor((3 * stride) / 4))
	return count
}

// Adds one unique sparse-scan phase pair. Returns the updated count.
function addCellPhasePair(offsetsX: Int32Array, offsetsY: Int32Array, count: number, offsetX: number, offsetY: number) {
	for (let i = 0; i < count; i++) if (offsetsX[i] === offsetX && offsetsY[i] === offsetY) return count
	if (count >= offsetsX.length) return count
	offsetsX[count] = offsetX
	offsetsY[count] = offsetY
	return count + 1
}

// Sparse-scan phase pairs for a cell, preserving the historical zero/half-stride order before adding
// the quarter residues. That keeps cells whose first alternate lattice already clears the thresholds
// from visiting later phases that would only dilute the measured valid fraction. When the full residue
// product fits the phase budget, every phase pair is then visited so wider strides cannot hide a whole
// parity class behind the sparse lattice.
function buildCellPhasePairs(strideX: number, strideY: number, offsetsX: Int32Array, offsetsY: Int32Array) {
	const axisX = new Int32Array(4)
	const axisY = new Int32Array(4)
	const countX = buildCellPhaseOffsets(strideX, axisX)
	const countY = buildCellPhaseOffsets(strideY, axisY)
	let count = addCellPhasePair(offsetsX, offsetsY, 0, 0, 0)

	if (countX > 1 || countY > 1) count = addCellPhasePair(offsetsX, offsetsY, count, axisX[Math.min(1, countX - 1)], axisY[Math.min(1, countY - 1)])
	if (countX > 1) count = addCellPhasePair(offsetsX, offsetsY, count, axisX[1], 0)
	if (countY > 1) count = addCellPhasePair(offsetsX, offsetsY, count, 0, axisY[1])

	for (let y = 0; y < countY; y++) {
		for (let x = 0; x < countX; x++) count = addCellPhasePair(offsetsX, offsetsY, count, axisX[x], axisY[y])
	}

	if (strideX * strideY <= offsetsX.length) {
		for (let y = 0; y < strideY; y++) {
			for (let x = 0; x < strideX; x++) count = addCellPhasePair(offsetsX, offsetsY, count, x, y)
		}
	} else {
		for (let residue = 1; residue < Math.max(strideX, strideY) && count < offsetsX.length; residue++) {
			if (residue < strideX) count = addCellPhasePair(offsetsX, offsetsY, count, residue, 0)
			if (residue < strideY) count = addCellPhasePair(offsetsX, offsetsY, count, 0, residue)
			if (residue < strideX && residue < strideY) count = addCellPhasePair(offsetsX, offsetsY, count, residue, residue)
		}
	}

	return count
}

// Builds the cell grid: roughly square cells along the longer axis, with a floor of `minCellsPerAxis`
// cells per axis so a high-aspect frame still yields a 2D layout the surface fit can use, and a
// caller-provided ceiling so an extreme `gridSize` cannot blow up the per-plane state.
function buildLocalGrid(width: number, height: number, gridSize: number, boxSize: number, minCellsPerAxis: number, maxCells: number): LocalGrid {
	const longAxis = Math.max(width, height)
	const cell = longAxis / gridSize
	const minColumns = Math.min(minCellsPerAxis, width)
	const minRows = Math.min(minCellsPerAxis, height)
	let columns = clamp(Math.round(width / cell), minColumns, width)
	let rows = clamp(Math.round(height / cell), minRows, height)

	// One cell per pixel is not a usable ceiling on a large frame: a 4096x4096 RGB frame at
	// `gridSize: 4096` asks for 16.7 million cells, whose per-plane state alone is about 1.6 GB before
	// any sample object exists. The grid is scaled back to a tractable cell budget, keeping its aspect
	// ratio.
	if (columns * rows > maxCells) {
		const factor = Math.sqrt(maxCells / (columns * rows))
		columns = clamp(Math.round(columns * factor), minColumns, width)
		rows = clamp(Math.round(rows * factor), minRows, height)

		// A per-axis floor can push the product back over the budget on a high-aspect frame. Absorb the
		// excess on the longer axis: the shorter one is at its floor because the surface degree needs that
		// many coordinate bands, and taking them away trades a memory problem for an unfittable layout.
		if (columns * rows > maxCells) {
			if (columns >= rows) columns = Math.max(minColumns, Math.floor(maxCells / rows))
			else rows = Math.max(minRows, Math.floor(maxCells / columns))
		}
	}

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

	// The smoothing exists to soften the step OUTSIDE the supported region, so a supported cell is
	// restored to full confidence afterwards. Left blurred, the last accepted cell along a boundary would
	// drop to 0.75 — 0.59 where two boundaries meet — and the correction would be attenuated by 16 to 41%
	// inside valid overlap, putting a photometric seam exactly along the registration edge, on cells that
	// constrained the surface directly.
	const values = new Float32Array(columns * rows)
	for (let r = 0; r < rows; r++) {
		const up = Math.max(0, r - 1) * columns
		const down = Math.min(rows - 1, r + 1) * columns
		const base = r * columns
		for (let c = 0; c < columns; c++) values[base + c] = filled[base + c] !== 0 ? 1 : 0.25 * scratch[up + c] + 0.5 * scratch[base + c] + 0.25 * scratch[down + c]
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
	const effectiveColorMode: NormalizationColorMode = luminance ? 'luminance' : 'per-channel'
	const planes = luminance ? 1 : channels
	const hasOffset = estimator !== 'scale'
	const minCellsPerAxis = Math.max(offsetDegree, scaleDegree) + 1
	const maxCells = Math.max(minCellsPerAxis * minCellsPerAxis, Math.floor(MAX_LOCAL_NORMALIZATION_CELLS / Math.max(1, planes)))

	const global = solveGlobalNormalizationPlanes(currentRaw, valid, referenceRaw, channels, width, height, estimator, effectiveColorMode)
	const grid = buildLocalGrid(width, height, options.gridSize, options.boxSize, minCellsPerAxis, maxCells)
	const { columns, rows, cellW, cellH } = grid
	const cellCount = columns * rows

	// Stride the box down to the sample budget BEFORE reading any pixel, so collection cost scales with
	// the budget rather than with the box area. The budget is `maxSamplesPerCell` narrowed by each cell's
	// share of `LOCAL_NORMALIZATION_SAMPLING_OVERLAP`, which is what keeps overlapping boxes from
	// multiplying the two ceilings into a scan the frame size no longer bounds. The two axes are strided independently: one
	// stride derived from the box area only honors the budget for a roughly square box, and overshoots it
	// by the aspect ratio otherwise — a 1-pixel-wide cell of a very tall frame would collect thousands of
	// pairs against a budget of 1024, sizing every buffer and the whole pixel scan accordingly. For a
	// square box the split reproduces the single stride exactly.
	const cellBudget = Math.max(1, Math.floor((width * height * LOCAL_NORMALIZATION_SAMPLING_OVERLAP) / cellCount))
	const { strideX, strideY, capacity } = resolveCellStride(grid.maxBoxW, grid.maxBoxH, Math.min(maxSamplesPerCell, cellBudget))
	// Offsets of the alternate sampling phases inside a cell. The strided scan reads one pixel out of
	// `strideX * strideY`, so a validity mask aligned to that same lattice can hide every valid pixel from
	// a scan anchored at the box origin: a frame three quarters valid then reports no overlap at all.
	// A cell that collected too little is rescanned from alternate sparse phases, which costs bounded extra
	// passes over exactly the cells that have no result to lose, unlike a dense rescan that would cost the
	// full box area on every genuinely empty cell. A bounded residue sweep covers all phase pairs for
	// strides up to 8 and falls back to representative residues past that budget.
	const phaseOffsetsX = new Int32Array(MAX_LOCAL_NORMALIZATION_CELL_PHASES)
	const phaseOffsetsY = new Int32Array(MAX_LOCAL_NORMALIZATION_CELL_PHASES)
	const phases = buildCellPhasePairs(strideX, strideY, phaseOffsetsX, phaseOffsetsY)
	// Actual phase origins after edge clamping, reused per cell so short edge cells cannot rescan an
	// origin pair reached by an earlier sparse phase.
	const cellPhaseOriginsX = new Int32Array(MAX_LOCAL_NORMALIZATION_CELL_PHASES)
	const cellPhaseOriginsY = new Int32Array(MAX_LOCAL_NORMALIZATION_CELL_PHASES)

	const refBuf = new Float64Array(planes * capacity)
	const curBuf = new Float64Array(planes * capacity)
	// Quantile selection permutes its input, so it runs on copies and leaves the paired buffers intact.
	const refSelect = new Float64Array(capacity)
	const curSelect = new Float64Array(capacity)
	const scratchBuf = new Float64Array(capacity)

	// The pivot is needed per cell, so it is drawn from the strided sample grid up front.
	const pivots = collectPivots(referenceRaw, currentRaw, valid, channels, width, height, planes, luminance, estimator)

	// Per-cell state kept per plane so the offset residuals can be rotated onto the fitted gain without a
	// second pass over the pixels.
	const cellOffset: Float64Array[] = []
	const cellGain: Float64Array[] = []
	const cellLevel: Float64Array[] = []
	const cellWeight: Float64Array[] = []
	const cellX: Float64Array[] = []
	const cellY: Float64Array[] = []
	// Per-cell scan state, reset for each cell and kept per plane so a damaged channel cannot drop the
	// pixel for the healthy ones.
	const counts = new Int32Array(planes)
	const validPairs = new Int32Array(planes)
	const sumX = new Float64Array(planes)
	const sumY = new Float64Array(planes)
	// Strided pixels the phase that filled each plane walked, which is what its valid fraction is measured
	// against. Phases visit different pixel counts near the box edge, so one shared total would misreport
	// the fraction for a plane the retry filled.
	const visited = new Int32Array(planes)
	// Planes still looking for pairs, as a compact list of plane indices. Iterating the list rather than
	// testing a per-plane flag keeps the inner loop free of a branch it would take on every pixel of the
	// common single-phase case.
	const pending = new Int32Array(planes)
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
		cellX.push(new Float64Array(cellCount))
		cellY.push(new Float64Array(cellCount))
		masks.push(new Uint8Array(cellCount))
		gainMasks.push(new Uint8Array(cellCount))
		refViews.push(refBuf.subarray(plane * capacity, (plane + 1) * capacity))
		curViews.push(curBuf.subarray(plane * capacity, (plane + 1) * capacity))
	}

	const { red, green, blue } = DEFAULT_GRAYSCALE
	// Whether each plane saw a valid pixel pair at all, regardless of whether it went on to be usable. It
	// is per plane because it selects a per-plane fallback reason: a channel with no overlapping finite
	// pixel has a different problem from one whose cells were all too sparse, and a sibling plane finding
	// pairs says nothing about either.
	const observedValidPairs = new Uint8Array(planes)

	for (let r = 0; r < rows; r++) {
		const by0 = grid.y0[r]
		const by1 = grid.y1[r]

		for (let c = 0; c < columns; c++) {
			const bx0 = grid.x0[c]
			const bx1 = grid.x1[c]

			// Counted per plane. A pixel non-finite in one channel says nothing about the others, and the
			// global solve already treats planes independently, so letting one damaged channel drop the
			// pixel everywhere would lose the spatial correction on the healthy ones too. Each plane
			// therefore keeps its own pair count, its own buffer prefix, and its own sample centroid.
			//
			// The phases are also per plane: a plane that has not reached the cell thresholds is retried on
			// alternate lattices while the planes that already cleared them are dropped from the scan and
			// keep what they collected. One shared flag would let a healthy channel cancel the retry the
			// damaged one needs, and retiring a plane merely because it found SOMETHING would strand a cell
			// that caught one stray pair on the first lattice while the alternate one covers it entirely.
			//
			// A retried plane adds to what it already has instead of starting over. The phases sample
			// disjoint positions of the same box, so their union is simply a denser sample of it, and a cell
			// whose valid pixels are split across sparse lattices clears the thresholds on none of them alone
			// while the union clears them comfortably. Writes stop at the per-cell capacity the
			// buffers are sized by, which two full phases would otherwise overrun. Valid-pair totals keep
			// counting after that so a full estimator reservoir cannot make the cell look less valid.
			counts.fill(0)
			validPairs.fill(0)
			sumX.fill(0)
			sumY.fill(0)
			visited.fill(0)

			let pendingCount = planes
			for (let plane = 0; plane < planes; plane++) pending[plane] = plane

			let cellPhaseCount = 0
			for (let phase = 0; phase < phases; phase++) {
				const originX = Math.min(bx0 + phaseOffsetsX[phase], bx1)
				const originY = Math.min(by0 + phaseOffsetsY[phase], by1)
				let duplicateOrigin = false

				for (let i = 0; i < cellPhaseCount; i++) {
					if (cellPhaseOriginsX[i] === originX && cellPhaseOriginsY[i] === originY) {
						duplicateOrigin = true
						break
					}
				}

				if (duplicateOrigin) continue
				cellPhaseOriginsX[cellPhaseCount] = originX
				cellPhaseOriginsY[cellPhaseCount] = originY
				cellPhaseCount++
				let phaseVisited = 0

				for (let y = originY; y <= by1; y += strideY) {
					const rowBase = y * width

					for (let x = originX; x <= bx1; x += strideX) {
						phaseVisited++
						const pixel = rowBase + x
						if (valid !== undefined && valid[pixel] === 0) continue
						const base = pixel * channels

						if (luminance) {
							const cv = red * currentRaw[base] + green * currentRaw[base + 1] + blue * currentRaw[base + 2]
							const rv = red * referenceRaw[base] + green * referenceRaw[base + 1] + blue * referenceRaw[base + 2]
							if (!Number.isFinite(cv) || !Number.isFinite(rv)) continue
							validPairs[0]++

							const count = counts[0]
							if (count < capacity) {
								counts[0] = count + 1
								curBuf[count] = cv
								refBuf[count] = rv
								sumX[0] += x
								sumY[0] += y
							}
						} else {
							for (let i = 0; i < pendingCount; i++) {
								const plane = pending[i]
								const cv = currentRaw[base + plane]
								const rv = referenceRaw[base + plane]
								if (!Number.isFinite(cv) || !Number.isFinite(rv)) continue
								validPairs[plane]++

								const count = counts[plane]
								if (count < capacity) {
									const at = plane * capacity + count
									counts[plane] = count + 1
									curBuf[at] = cv
									refBuf[at] = rv
									sumX[plane] += x
									sumY[plane] += y
								}
							}
						}
					}
				}

				// A plane leaves the scan once its running totals clear both cell thresholds, measured against
				// every pixel the phases it took have visited. The rest stay for the next lattice.
				let remaining = 0

				for (let i = 0; i < pendingCount; i++) {
					const plane = pending[i]
					const count = counts[plane]
					const finite = validPairs[plane]
					const seen = visited[plane] + phaseVisited
					visited[plane] = seen
					if (finite > 0) observedValidPairs[plane] = 1
					if (count < minSamplesPerCell || finite < minValidFraction * seen) pending[remaining++] = plane
				}

				pendingCount = remaining
				if (pendingCount === 0) break
			}

			if (pendingCount > 0 && strideX * strideY > phases) {
				const denseW = bx1 - bx0 + 1
				const denseH = by1 - by0 + 1
				const densePixels = denseW * denseH
				const validFractionBudget = minValidFraction > 0 ? Math.ceil(minSamplesPerCell / minValidFraction) : minSamplesPerCell
				const denseBudget = Math.min(densePixels, Math.max(capacity, Math.min(capacity * LOCAL_NORMALIZATION_DENSE_RETRY_FACTOR, validFractionBudget)))
				const denseStep = coprimeSamplingStep(densePixels, denseBudget)
				const denseStart = (((r + 1) * 73856093 + (c + 1) * 19349663) >>> 0) % densePixels
				let denseVisited = 0

				for (let i = 0; i < pendingCount; i++) {
					const plane = pending[i]
					if (validPairs[plane] === 0) visited[plane] = 0
				}

				for (let sample = 0; sample < densePixels && denseVisited < denseBudget; sample++) {
					const denseIndex = (denseStart + sample * denseStep) % densePixels
					const x = bx0 + (denseIndex % denseW)
					const y = by0 + Math.floor(denseIndex / denseW)
					if (sparseCellPhasesVisited(x, y, bx0, bx1, by0, by1, strideX, strideY, phaseOffsetsX, phaseOffsetsY, phases)) continue
					denseVisited++

					const pixel = y * width + x
					if (valid !== undefined && valid[pixel] === 0) continue
					const base = pixel * channels

					if (luminance) {
						const cv = red * currentRaw[base] + green * currentRaw[base + 1] + blue * currentRaw[base + 2]
						const rv = red * referenceRaw[base] + green * referenceRaw[base + 1] + blue * referenceRaw[base + 2]
						if (!Number.isFinite(cv) || !Number.isFinite(rv)) continue
						validPairs[0]++

						const count = counts[0]
						if (count < capacity) {
							counts[0] = count + 1
							curBuf[count] = cv
							refBuf[count] = rv
							sumX[0] += x
							sumY[0] += y
						}
					} else {
						for (let i = 0; i < pendingCount; i++) {
							const plane = pending[i]
							const cv = currentRaw[base + plane]
							const rv = referenceRaw[base + plane]
							if (!Number.isFinite(cv) || !Number.isFinite(rv)) continue
							validPairs[plane]++

							const count = counts[plane]
							if (count < capacity) {
								const at = plane * capacity + count
								counts[plane] = count + 1
								curBuf[at] = cv
								refBuf[at] = rv
								sumX[plane] += x
								sumY[plane] += y
							}
						}
					}
				}

				for (let i = 0; i < pendingCount; i++) {
					const plane = pending[i]
					visited[plane] += denseVisited
					if (validPairs[plane] > 0) observedValidPairs[plane] = 1
				}
			}

			const cellIndex = r * columns + c

			for (let plane = 0; plane < planes; plane++) {
				const count = counts[plane]
				if (count < minSamplesPerCell || visited[plane] === 0) continue
				const validFraction = validPairs[plane] / visited[plane]
				if (validFraction < minValidFraction) continue

				cellX[plane][cellIndex] = sumX[plane] / count
				cellY[plane][cellIndex] = sumY[plane] / count

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
		else if (accepted === 0) reason = observedValidPairs[plane] === 1 ? 'insufficient-valid-cells' : 'no-valid-overlap'

		const mask = masks[plane]
		const gains = cellGain[plane]
		const weights = cellWeight[plane]
		const xs = cellX[plane]
		const ys = cellY[plane]
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
				samples.push({ x: xs[cell], y: ys[cell], value: Math.log(gains[cell] / anchor.scale), weight: weights[cell] })
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
			const gainAtCell = evaluateGainAtCells(scaleSurface, scaleRange, anchor.scale, scaleSupport, xs, ys, mask, cellCount)
			const samples: SurfaceSample[] = []

			for (let cell = 0; cell < cellCount; cell++) {
				if (mask[cell] === 0) continue
				const value = (gainAtCell[cell] - anchor.scale) * (pivot - levels[cell]) + offsets[cell]
				samples.push({ x: xs[cell], y: ys[cell], value, weight: weights[cell] })
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
		colorMode: effectiveColorMode,
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
function collectPivots(referenceRaw: ImageRawType, currentRaw: ImageRawType, valid: Readonly<Uint8Array> | undefined, channels: number, width: number, height: number, planes: number, luminance: boolean, estimator: GlobalNormalizationMode) {
	const step = Math.max(1, Math.floor(Math.sqrt((width * height) / NORMALIZATION_SAMPLE_LIMIT)))
	const values = scanPivotValues(referenceRaw, currentRaw, valid, channels, width, height, planes, luminance, step, 1)

	// The pivot rides the same lattice the global solve does and is missed the same way, plane by plane.
	// A handful of values is as unsafe as none because the lower quantile can collapse onto one
	// unrepresentative pixel and couple the offset field around the wrong level.
	let underfilled = false
	for (const plane of values) if (plane.length < MIN_GLOBAL_NORMALIZATION_LATTICE_SAMPLES) underfilled = true

	if (underfilled) {
		const colorMode = luminance ? 'luminance' : 'per-channel'
		const denseKeepEvery = normalizationKeepEveryByPlane(countNormalizationPairs(currentRaw, valid, referenceRaw, channels, width, height, colorMode))
		const dense = scanPivotValues(referenceRaw, currentRaw, valid, channels, width, height, planes, luminance, 1, denseKeepEvery)
		for (let plane = 0; plane < planes; plane++) {
			if (values[plane].length >= MIN_GLOBAL_NORMALIZATION_LATTICE_SAMPLES) continue
			if (dense[plane].length > values[plane].length) values[plane] = dense[plane]
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

// Walks the frame at `step` pixels and keeps every `keepEvery`-th usable value, one list per plane.
//
// The thinning counter is per plane and advances only on values that plane can use, for the same reason
// the global sampler's does: a shared counter puts every plane on one lattice of kept positions, and a
// channel non-finite exactly there comes back empty from the dense fallback too. Its pivot would then
// stay at zero while its global anchor is fine, which leaves the offset field measured about a level the
// gain never rotates through — the two residuals stop being decorrelated and the reconstruction can end
// up worse than the anchor it started from.
//
// Only pixels that are finite in BOTH frames count, which is the rule the global solve and the cell
// estimates already use. A pixel finite here but not in the reference contributes to nothing else, so
// letting it move the pivot would anchor the reconstruction on a level the fit never saw — and the pivot
// enters the offset as `(gain - anchor) * pivot`, a term nothing downstream can undo.
function scanPivotValues(referenceRaw: ImageRawType, currentRaw: ImageRawType, valid: Readonly<Uint8Array> | undefined, channels: number, width: number, height: number, planes: number, luminance: boolean, step: number, keepEvery: number | readonly number[]) {
	const values: number[][] = new Array<number[]>(planes)
	for (let plane = 0; plane < planes; plane++) values[plane] = []
	const { red, green, blue } = DEFAULT_GRAYSCALE
	const planeKeepEvery = typeof keepEvery === 'number' ? undefined : keepEvery
	const sharedKeepEvery = typeof keepEvery === 'number' ? keepEvery : 1
	// Usable values seen so far, per plane, which is what the thinning counts down.
	const seen = new Int32Array(planes)

	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			const pixel = y * width + x
			if (valid !== undefined && valid[pixel] === 0) continue
			const base = pixel * channels

			if (luminance) {
				const v = red * currentRaw[base] + green * currentRaw[base + 1] + blue * currentRaw[base + 2]
				const r = red * referenceRaw[base] + green * referenceRaw[base + 1] + blue * referenceRaw[base + 2]
				if (Number.isFinite(v) && Number.isFinite(r) && seen[0]++ % (planeKeepEvery?.[0] ?? sharedKeepEvery) === 0) values[0].push(v)
			} else {
				for (let plane = 0; plane < planes; plane++) {
					const v = currentRaw[base + plane]
					if (Number.isFinite(v) && Number.isFinite(referenceRaw[base + plane]) && seen[plane]++ % (planeKeepEvery?.[plane] ?? sharedKeepEvery) === 0) values[plane].push(v)
				}
			}
		}
	}

	return values
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
	// Cells where the materialized TPS field failed verification and must be evaluated directly.
	readonly direct?: LocalNormalizationDirectFields
}

// Direct-evaluation metadata for every plane that has verified failing TPS cells.
interface LocalNormalizationDirectFields {
	// Number of coarse field cells across.
	readonly cellColumns: number
	// Number of coarse field cells down.
	readonly cellRows: number
	// Per-plane direct-evaluation data. Undefined planes use the interpolated field everywhere.
	readonly planes: readonly (LocalNormalizationDirectPlane | undefined)[]
}

// Per-plane state needed to evaluate the final gain/offset transform directly at one pixel.
interface LocalNormalizationDirectPlane {
	// Coarse cells where direct evaluation is required, row-major over `cellColumns * cellRows`.
	readonly cells: Uint8Array
	// Whether this plane carries an offset field. `scale` normalization always applies zero offset.
	readonly hasOffset: boolean
	// Global scale/offset anchor for the plane.
	readonly anchor: NormalizationParameters
	// Direct point evaluator for the scale surface, if this plane fitted one.
	readonly scaleEvaluator?: ScalarSurfacePointEvaluator
	// Direct point evaluator for the offset surface, if this plane fitted one.
	readonly offsetEvaluator?: ScalarSurfacePointEvaluator
	// Support grid for the gain field.
	readonly scaleSupport: LocalNormalizationSupportGrid
	// Support grid for the offset field.
	readonly offsetSupport: LocalNormalizationSupportGrid
	// Clamp range for residual log gain, in log units.
	readonly scaleRange?: readonly [number, number]
	// Clamp range for residual offset, in image units.
	readonly offsetRange?: readonly [number, number]
	// Current-frame pivot that decorrelates gain and offset for this plane.
	readonly pivot: number
}

// Node spacing the fields are actually materialized at, which is the model's own step widened whenever
// that step would price the node grid out of its budgets.
//
// The step is derived from the cell side, so a very fine grid drives it toward 1 and the node grid stops
// being the cheap intermediate it exists to be: a 4096x4096 RGB frame at `gridSize: 256` asks for 4.2
// million nodes, whose two plane-major arrays alone are about 190 MB. Worse, a spline field evaluates
// each node against every control point, so those nodes would run to billions of kernel evaluations with
// a logarithm each — a stall inside what is meant to be the cheap path, and the bounded materialization
// in `evaluateScalarSurfaceInto` is not on this route to catch it.
//
// Two ceilings therefore apply: a node count, which bounds the memory, and for a spline the product of
// nodes and control points, which bounds the work. A polynomial field costs `degree + 1` per node and is
// never the constraint. Both are far above any realistic configuration - the default grid on a large
// frame asks for a few thousand nodes - so widening only ever happens at extreme settings, and it costs
// resolution in the support ramp rather than correctness.
function resolveEvaluationStep(model: LocalNormalizationModel, planes: number) {
	const { width, height, evaluationStep } = model
	const pixels = width * height
	let step = evaluationStep

	// Widening the step by `f` divides the node count by `f * f`, so each ceiling gives a factor directly.
	const nodesAtStep = (pixels / (step * step)) * planes
	if (nodesAtStep > MAX_LOCAL_NORMALIZATION_NODES) step = Math.ceil(step * Math.sqrt(nodesAtStep / MAX_LOCAL_NORMALIZATION_NODES))

	let controls = 0
	for (const surface of model.scaleSurfaces) if (surface?.controlPoints !== undefined) controls = Math.max(controls, surface.controlPoints.length / 2)
	for (const surface of model.offsetSurfaces) if (surface?.controlPoints !== undefined) controls = Math.max(controls, surface.controlPoints.length / 2)

	if (controls > 0) {
		const workAtStep = (pixels / (step * step)) * planes * controls
		if (workAtStep > MAX_LOCAL_NORMALIZATION_FIELD_WORK) step = Math.ceil(step * Math.sqrt(workAtStep / MAX_LOCAL_NORMALIZATION_FIELD_WORK))
	}

	return Math.max(1, step)
}

// Absolute gain-field tolerance implied by the fitted log-gain range around `anchorScale`.
function localNormalizationScaleTolerance(anchorScale: number, range: readonly [number, number] | undefined) {
	if (range === undefined) return 0
	const low = anchorScale * Math.exp(range[0])
	const high = anchorScale * Math.exp(range[1])
	const span = Math.abs(high - low)
	return LOCAL_NORMALIZATION_TPS_FIELD_TOLERANCE * (span > 0 && Number.isFinite(span) ? span : Math.max(1, Math.abs(anchorScale)))
}

// Absolute offset-field tolerance implied by the fitted residual-offset range.
function localNormalizationOffsetTolerance(range: readonly [number, number] | undefined) {
	if (range === undefined) return 0
	const span = Math.abs(range[1] - range[0])
	return LOCAL_NORMALIZATION_TPS_FIELD_TOLERANCE * (span > 0 && Number.isFinite(span) ? span : 1)
}

// Pixel coordinate of a spline control point on one axis, clamped to the field grid it verifies.
function localNormalizationTpsControlPixel(surface: ScalarSurfaceModel, control: number, axisX: boolean) {
	const point = surface.controlPoints![2 * control + (axisX ? 0 : 1)]
	const domain = surface.domain
	return axisX ? clamp(domain.x0 + 0.5 * (point + 1) * (domain.x1 - domain.x0), 0, surface.width - 1) : clamp(domain.y0 + 0.5 * (point + 1) * (domain.y1 - domain.y0), 0, surface.height - 1)
}

// Bilinearly samples one plane of a materialized local-normalization field at pixel coordinates.
function sampleLocalNormalizationField(values: Float64Array, plane: number, columns: number, rows: number, stepX: number, stepY: number, x: number, y: number) {
	const fx = columns > 1 ? x / stepX : 0
	const fy = rows > 1 ? y / stepY : 0
	const i0 = clamp(Math.floor(fx), 0, Math.max(0, columns - 2))
	const j0 = clamp(Math.floor(fy), 0, Math.max(0, rows - 2))
	const i1 = Math.min(i0 + 1, columns - 1)
	const j1 = Math.min(j0 + 1, rows - 1)
	const tx = columns > 1 ? clamp(fx - i0, 0, 1) : 0
	const ty = rows > 1 ? clamp(fy - j0, 0, 1) : 0
	const planeBase = plane * columns * rows
	const row0 = planeBase + j0 * columns
	const row1 = planeBase + j1 * columns
	const top = values[row0 + i0] + (values[row0 + i1] - values[row0 + i0]) * tx
	const bottom = values[row1 + i0] + (values[row1 + i1] - values[row1 + i0]) * tx
	return top + (bottom - top) * ty
}

// Coarse field cell containing a pixel coordinate.
function localNormalizationFieldCell(columns: number, rows: number, stepX: number, stepY: number, x: number, y: number, cellColumns: number) {
	const i = columns > 1 ? clamp(Math.floor(x / stepX), 0, cellColumns - 1) : 0
	const j = rows > 1 ? clamp(Math.floor(y / stepY), 0, Math.max(0, rows - 2)) : 0
	return j * cellColumns + i
}

// Marks one coarse field cell for direct evaluation, returning 1 only when it was newly marked.
function markLocalNormalizationDirectCell(cells: Uint8Array, cell: number) {
	if (cells[cell] !== 0) return 0
	cells[cell] = 1
	return 1
}

// Marks a cell and its immediate neighbors because a failing control can sit on a coarse-cell boundary.
function markLocalNormalizationDirectCellNeighborhood(cells: Uint8Array, cell: number, cellColumns: number, cellRows: number) {
	const row = Math.floor(cell / cellColumns)
	const column = cell - row * cellColumns
	let count = 0

	for (let y = Math.max(0, row - 1); y <= Math.min(cellRows - 1, row + 1); y++) {
		const base = y * cellColumns
		for (let x = Math.max(0, column - 1); x <= Math.min(cellColumns - 1, column + 1); x++) count += markLocalNormalizationDirectCell(cells, base + x)
	}

	return count
}

// Stride for supplemental centre probes that keeps verification bounded by kernel-evaluation work.
function localNormalizationFieldProbeStride(cellColumns: number, cellRows: number, controls: number) {
	const work = cellColumns * cellRows * controls
	return work > MAX_LOCAL_NORMALIZATION_TPS_FIELD_VERIFICATION_WORK ? Math.ceil(Math.sqrt(work / MAX_LOCAL_NORMALIZATION_TPS_FIELD_VERIFICATION_WORK)) : 1
}

// Evaluates the final gain field directly at a pixel, including support, clamp, and anchor scaling.
function evaluateDirectLocalNormalizationScale(plane: LocalNormalizationDirectPlane, x: number, y: number) {
	const evaluator = plane.scaleEvaluator
	const range = plane.scaleRange
	if (evaluator === undefined || range === undefined) return plane.anchor.scale
	return plane.anchor.scale * Math.exp(sampleSupport(plane.scaleSupport, x, y) * clamp(evaluator.at(x, y), range[0], range[1]))
}

// Evaluates the final offset field directly at a pixel, including support, clamp, and pivot coupling.
function evaluateDirectLocalNormalizationOffset(plane: LocalNormalizationDirectPlane, x: number, y: number, scale: number) {
	if (!plane.hasOffset) return 0
	const evaluator = plane.offsetEvaluator
	const range = plane.offsetRange
	const residual = evaluator === undefined || range === undefined ? 0 : sampleSupport(plane.offsetSupport, x, y) * clamp(evaluator.at(x, y), range[0], range[1])
	return plane.anchor.offset + residual - (scale - plane.anchor.scale) * plane.pivot
}

// Whether the materialized field agrees with the direct transform at a verification point.
function localNormalizationFieldAgrees(fields: LocalNormalizationFields, plane: number, direct: LocalNormalizationDirectPlane, x: number, y: number, scaleTolerance: number, offsetTolerance: number) {
	const directScale = evaluateDirectLocalNormalizationScale(direct, x, y)
	const sampledScale = sampleLocalNormalizationField(fields.scale, plane, fields.columns, fields.rows, fields.stepX, fields.stepY, x, y)
	if (Math.abs(sampledScale - directScale) > scaleTolerance) return false

	if (!direct.hasOffset) return true

	const directOffset = evaluateDirectLocalNormalizationOffset(direct, x, y, directScale)
	const sampledOffset = sampleLocalNormalizationField(fields.offset, plane, fields.columns, fields.rows, fields.stepX, fields.stepY, x, y)
	return Math.abs(sampledOffset - directOffset) <= offsetTolerance
}

// Marks verification failures at the controls of one TPS surface.
function markLocalNormalizationTpsControlCells(fields: LocalNormalizationFields, plane: number, direct: LocalNormalizationDirectPlane, surface: ScalarSurfaceModel | undefined, scaleTolerance: number, offsetTolerance: number, cellColumns: number, cellRows: number) {
	if (surface?.type !== 'thinPlateSpline') return 0

	const controlCount = surface.controlPoints!.length / 2
	let count = 0
	for (let control = 0; control < controlCount; control++) {
		const x = localNormalizationTpsControlPixel(surface, control, true)
		const y = localNormalizationTpsControlPixel(surface, control, false)
		if (localNormalizationFieldAgrees(fields, plane, direct, x, y, scaleTolerance, offsetTolerance)) continue
		count += markLocalNormalizationDirectCellNeighborhood(direct.cells, localNormalizationFieldCell(fields.columns, fields.rows, fields.stepX, fields.stepY, x, y, cellColumns), cellColumns, cellRows)
	}

	return count
}

// Builds direct-evaluation masks for TPS cells whose coarse field does not reproduce direct evaluation.
function buildLocalNormalizationDirectFields(model: LocalNormalizationModel, fields: LocalNormalizationFields): LocalNormalizationDirectFields | undefined {
	const { columns, rows, stepX, stepY } = fields
	if (columns <= 1 && rows <= 1) return undefined

	const cellColumns = Math.max(1, columns - 1)
	const cellRows = Math.max(1, rows - 1)
	const planes = new Array<LocalNormalizationDirectPlane | undefined>(fields.planes)
	let any = false

	for (let plane = 0; plane < fields.planes; plane++) {
		if (model.diagnostics[plane].fallback) continue

		const scaleSurface = model.scaleSurfaces[plane]
		const offsetSurface = model.offsetSurfaces[plane]
		if (scaleSurface?.type !== 'thinPlateSpline' && offsetSurface?.type !== 'thinPlateSpline') continue

		const anchor = model.global[plane]
		const direct: LocalNormalizationDirectPlane = {
			cells: new Uint8Array(cellColumns * cellRows),
			hasOffset: model.estimator !== 'scale',
			anchor,
			scaleEvaluator: scaleSurface === undefined ? undefined : createScalarSurfacePointEvaluator(scaleSurface),
			offsetEvaluator: offsetSurface === undefined ? undefined : createScalarSurfacePointEvaluator(offsetSurface),
			scaleSupport: model.scaleSupportGrids[plane],
			offsetSupport: model.offsetSupportGrids[plane],
			scaleRange: model.scaleLogRanges[plane],
			offsetRange: model.offsetRanges[plane],
			pivot: model.pivots[plane] ?? 0,
		}
		const scaleTolerance = localNormalizationScaleTolerance(anchor.scale, model.scaleLogRanges[plane])
		const offsetTolerance = localNormalizationOffsetTolerance(model.offsetRanges[plane])
		const controls = Math.max(scaleSurface?.controlPoints?.length ?? 0, offsetSurface?.controlPoints?.length ?? 0) / 2
		const probeStride = localNormalizationFieldProbeStride(cellColumns, cellRows, controls)
		let count = 0

		count += markLocalNormalizationTpsControlCells(fields, plane, direct, scaleSurface, scaleTolerance, offsetTolerance, cellColumns, cellRows)
		count += markLocalNormalizationTpsControlCells(fields, plane, direct, offsetSurface, scaleTolerance, offsetTolerance, cellColumns, cellRows)

		for (let j = Math.floor(probeStride / 2); j < cellRows; j += probeStride) {
			const y = rows > 1 ? (j + 0.5) * stepY : 0
			for (let i = Math.floor(probeStride / 2); i < cellColumns; i += probeStride) {
				const x = columns > 1 ? (i + 0.5) * stepX : 0
				if (localNormalizationFieldAgrees(fields, plane, direct, x, y, scaleTolerance, offsetTolerance)) continue
				count += markLocalNormalizationDirectCell(direct.cells, j * cellColumns + i)
			}
		}

		if (count > 0) {
			planes[plane] = direct
			any = true
		}
	}

	return any ? { cellColumns, cellRows, planes } : undefined
}

// Evaluates the model onto its node grid.
function buildLocalNormalizationFields(model: LocalNormalizationModel): LocalNormalizationFields {
	const { width, height } = model
	const planes = model.global.length
	const hasOffset = model.estimator !== 'scale'
	const identity = model.fallback === 'identity'

	const evaluationStep = resolveEvaluationStep(model, planes)
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

		// A plane that could not be modeled follows the fallback policy. `reject` is a decision for the
		// caller, not something a field can encode, so a rejected plane materializes the global anchor here
		// and the entry points decline to apply it; the anchor is the safe choice for a caller that applies
		// the model anyway.
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
			//
			// The surface is clamped BEFORE the confidence scales it. Clamping the product instead lets a
			// large extrapolation cancel a low confidence — a valid pixel just outside the fitted domain,
			// where the surface overshoots most and the support has already decayed, would still receive a
			// correction as large as the clamp allows. Scaling the clamped value keeps the correction bounded
			// by `support * range`, so it genuinely fades toward the anchor.
			if (scaleEvaluator !== undefined) {
				scaleEvaluator.fillRow(py, surfaceRow, 0, 1)
				for (let i = 0; i < columns; i++) scale[row + i] = anchor.scale * Math.exp(sampleSupport(scaleSupport, i * stepX, py) * clamp(surfaceRow[i], scaleRange![0], scaleRange![1]))
			} else {
				scale.fill(anchor.scale, row, row + columns)
			}

			if (!hasOffset) {
				offset.fill(0, row, row + columns)
				continue
			}

			if (offsetEvaluator !== undefined) {
				offsetEvaluator.fillRow(py, surfaceRow, 0, 1)
				for (let i = 0; i < columns; i++) offset[row + i] = anchor.offset + sampleSupport(offsetSupport, i * stepX, py) * clamp(surfaceRow[i], offsetRange![0], offsetRange![1]) - (scale[row + i] - anchor.scale) * pivot
			} else {
				for (let i = 0; i < columns; i++) offset[row + i] = anchor.offset - (scale[row + i] - anchor.scale) * pivot
			}
		}
	}

	const fields = { columns, rows, stepX, stepY, planes, scale, offset } satisfies LocalNormalizationFields
	const direct = buildLocalNormalizationDirectFields(model, fields)
	return direct === undefined ? fields : { ...fields, direct }
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
	const direct = fields.direct

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
		const directCellRow = direct === undefined ? 0 : Math.min(direct.cellRows - 1, rows > 1 ? Math.floor(y / stepY) : 0) * direct.cellColumns

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
			const directCell = direct === undefined ? 0 : directCellRow + Math.min(direct.cellColumns - 1, segment)

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
				const directPlane = direct?.planes[0]
				const directCellMarked = directPlane !== undefined && directPlane.cells[directCell] !== 0

				for (let x = xs; x <= xe; x++, s += ds, o += doff) {
					const pixel = rowBase + x
					if (valid !== undefined && valid[pixel] === 0) continue
					const base = pixel * channelCount
					const scale = directCellMarked ? evaluateDirectLocalNormalizationScale(directPlane, x, y) : s
					const offset = directCellMarked ? evaluateDirectLocalNormalizationOffset(directPlane, x, y, scale) : o
					raw[base] = raw[base] * scale + offset
					raw[base + 1] = raw[base + 1] * scale + offset
					raw[base + 2] = raw[base + 2] * scale + offset
				}

				continue
			}

			for (let x = xs; x <= xe; x++) {
				const pixel = rowBase + x

				if (valid === undefined || valid[pixel] !== 0) {
					const base = pixel * channelCount
					for (let plane = 0; plane < planes; plane++) {
						const directPlane = direct?.planes[plane]
						if (directPlane !== undefined && directPlane.cells[directCell] !== 0) {
							const scale = evaluateDirectLocalNormalizationScale(directPlane, x, y)
							raw[base + plane] = raw[base + plane] * scale + evaluateDirectLocalNormalizationOffset(directPlane, x, y, scale)
						} else {
							raw[base + plane] = raw[base + plane] * scaleCurrent[plane] + offsetCurrent[plane]
						}
					}
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
//
// Under `fallback: 'reject'` a plane that could not be modeled means the frame is meant to be dropped,
// so nothing is applied and `current` comes back untouched with `applied: false`. Applying anyway would
// destroy the input the caller still needs in order to drop it, or to retry under another policy.
export function localNormalization(reference: Image, current: Image, options: LocalNormalizationFitOptions = {}): LocalNormalizationResult {
	const model = fitLocalNormalization(reference, current, options)
	if (model.fallback === 'reject' && isLocalNormalizationFallback(model)) return { image: current, model, applied: false }
	return { image: applyLocalNormalization(current, model, options.validityMask), model, applied: true }
}
