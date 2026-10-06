import type { Rect } from '../../../math/numerical/geometry'
import { medianBySelectionOf } from '../../../math/numerical/statistics'
import type { Image } from '../../model/types'
import { CFA_ANALYSIS_PLANES, type ImageAnalysisPlane, type ImagePlaneGeometry, imagePlaneGeometry, MONO_ANALYSIS_PLANES, RGB_ANALYSIS_PLANES } from '../plane'
import { type CorrelationNormalization, matchPatchZNCC, normalizeRegistrationSamples, type PhaseCorrelationSpectrum, phaseCorrelate, phaseCorrelationSpectrum, type RegistrationPlane, type RegistrationRejection, refineTranslationECC, removeLinearTrend, type ZNCCSearchOptions } from './registration'
import type { SurfaceTrackingWorkspace } from './workspace'

// Extended-scene (Lunar, Solar and planetary surface) tracking by multi-patch registration. A reference
// stores one robust-normalized analysis plane (mono, RGB channel or native CFA plane) over a bounded
// image ROI, a distributed set of high-structure patches and a coarse downsampled level with its phase
// spectrum. Current frames are registered by bounded masked ZNCC per patch and a robust weighted rigid
// fit (rotation + translation, Tukey IRLS), with a translation-only fallback when patch geometry cannot
// constrain rotation. Large displacements are recovered by coarse phase correlation.
//
// Public coordinates are received-image pixels with pixel centers at integers, origin at the upper left,
// +X right and +Y down; rotations are radians, positive from +X toward +Y. Analysis sample (u, v) maps to
// image pixel (originX + u·step, originY + v·step). Registration allocates only small per-frame result
// objects; plane buffers come from the caller's workspace and are overwritten by the next call.

// Sample flag for values at or above the saturation level; such samples never enter correlation.
export const SURFACE_SAMPLE_SATURATED = 1

// Sample flag for non-finite or out-of-image samples.
export const SURFACE_SAMPLE_INVALID = 2

// Median norm of a 2D isotropic Gaussian residual divided by its per-axis sigma: sqrt(2·ln 2).
const RAYLEIGH_MEDIAN = Math.sqrt(2 * Math.LN2)

// Number of robust-reweighting passes of the rigid fit.
const RIGID_FIT_ITERATIONS = 6

// Proper rigid image transform q = R(rotation)·p + translation, in received-image pixels.
export interface RigidTransform2D {
	// Rotation in radians, positive from +X toward +Y (clockwise on a displayed image).
	readonly rotation: number
	// Translation [tx, ty] in image pixels, applied after rotation about the image origin.
	readonly translation: readonly [number, number]
}

// Identity rigid transform.
export const IDENTITY_RIGID_TRANSFORM: RigidTransform2D = { rotation: 0, translation: [0, 0] }

// Stable surface-tracking rejection reasons.
export type SurfaceRejection = RegistrationRejection | 'unsupported_plane' | 'low_structure' | 'saturated' | 'consensus_outlier' | 'insufficient_inliers' | 'insufficient_spatial_coverage' | 'reacquisition_failed'

// Configuration of reference creation and frame registration. Sizes are analysis samples unless noted.
export interface SurfaceTrackingOptions {
	// Square patch side in analysis samples; reduced to half the smaller ROI side when necessary.
	readonly patchSize: number
	// Maximum number of distributed reference patches.
	readonly maximumPatches: number
	// Per-axis ZNCC residual search radius around the predicted patch position, in analysis samples.
	readonly searchRadius: number
	// Minimum accepted patch ZNCC peak.
	readonly minimumCorrelation: number
	// Maximum accepted patch secondary-peak/peak ratio; larger values indicate repeated texture.
	readonly maximumSecondPeakRatio: number
	// Minimum valid template overlap fraction for a patch match.
	readonly minimumOverlap: number
	// Minimum Shi-Tomasi smaller eigenvalue in units of the gradient noise variance.
	readonly minimumStructure: number
	// Minimum smaller eigenvalue relative to the strongest candidate, in [0, 1].
	readonly minimumRelativeStructure: number
	// Maximum fraction of saturated samples inside a patch.
	readonly maximumSaturatedFraction: number
	// Minimum fraction of usable samples inside a patch.
	readonly minimumValidFraction: number
	// Samples at or above this level, in source sample units, are excluded as saturated.
	readonly saturationLevel: number
	// Whether a least-squares illumination plane is removed from every ROI.
	readonly detrend: boolean
	// Tukey cutoff in robust residual sigmas.
	readonly outlierThreshold: number
	// Lower bound of the robust residual sigma, in image pixels.
	readonly minimumResidualScale: number
	// Minimum accepted inlier patches.
	readonly minimumInliers: number
	// Minimum fraction of reference coverage cells (3×3 grid) that keep an inlier, in [0, 1].
	readonly minimumSpatialCoverage: number
	// Minimum inlier-spread standard deviation for fitting rotation, in image pixels; undefined uses
	// half the patch size in image pixels.
	readonly minimumRotationBaseline?: number
	// Whether successful ZNCC matches are refined by translation-only ECC.
	readonly refine: boolean
	// Maximum coarse-level side used for phase-correlation reacquisition, in coarse samples.
	readonly coarseSize: number
	// Cross-power normalization of coarse reacquisition.
	readonly coarseNormalization: CorrelationNormalization
	// Largest coarse shift as a fraction of the smaller coarse side, in (0, 0.5).
	readonly coarseShiftFraction: number
}

// Default surface options for 32-sample patches and a ±8-sample residual search.
export const DEFAULT_SURFACE_TRACKING_OPTIONS: SurfaceTrackingOptions = {
	patchSize: 32,
	maximumPatches: 24,
	searchRadius: 8,
	minimumCorrelation: 0.6,
	maximumSecondPeakRatio: 0.9,
	minimumOverlap: 0.6,
	minimumStructure: 2,
	minimumRelativeStructure: 0.02,
	maximumSaturatedFraction: 0.1,
	minimumValidFraction: 0.9,
	saturationLevel: 1,
	detrend: true,
	outlierThreshold: 4,
	minimumResidualScale: 0.1,
	minimumInliers: 2,
	minimumSpatialCoverage: 0.4,
	refine: false,
	coarseSize: 128,
	coarseNormalization: 'phase',
	coarseShiftFraction: 0.35,
}

// One reference patch.
export interface SurfacePatch {
	// Left template column in reference analysis samples.
	readonly left: number
	// Top template row in reference analysis samples.
	readonly top: number
	// Patch center X in image pixels.
	readonly x: number
	// Patch center Y in image pixels.
	readonly y: number
	// Shi-Tomasi smaller eigenvalue in gradient-noise-variance units.
	readonly structure: number
	// Coverage cell index 0..8 on the reference 3×3 grid, row-major.
	readonly cell: number
}

// Downsampled reference level used for coarse phase-correlation reacquisition.
export interface SurfaceCoarseLevel {
	// Fine samples averaged per coarse sample along each axis (power of two).
	readonly factor: number
	// Coarse width in samples.
	readonly width: number
	// Coarse height in samples.
	readonly height: number
	// Largest accepted per-axis coarse shift, in coarse samples.
	readonly maximumShift: number
	// Windowed, zero-padded forward spectrum of the coarse reference.
	readonly spectrum: PhaseCorrelationSpectrum
}

// Immutable surface reference. It retains only bounded preprocessed samples, never the source image.
export interface SurfaceReference {
	// Analysis plane used for every registration against this reference.
	readonly plane: ImageAnalysisPlane
	// Reference ROI in image pixels, left/top inclusive and right/bottom exclusive.
	readonly area: Readonly<Rect>
	// Image X of analysis sample (0, 0).
	readonly originX: number
	// Image Y of analysis sample (0, 0).
	readonly originY: number
	// Image pixels per analysis sample along both axes.
	readonly step: 1 | 2
	// Analysis width in samples.
	readonly width: number
	// Analysis height in samples.
	readonly height: number
	// Robust-normalized (and optionally detrended) samples, row-major.
	readonly data: Float32Array
	// Sample flags; nonzero samples are excluded.
	readonly mask: Uint8Array
	// Effective patch side in analysis samples.
	readonly patchSize: number
	// Selected distributed patches, strongest first.
	readonly patches: readonly SurfacePatch[]
	// Bit set of 3×3 coverage cells containing at least one patch.
	readonly coverageCells: number
	// Gradient noise sigma of the normalized plane, in normalized units.
	readonly noise: number
	// Coarse level for reacquisition, absent when the ROI is too small.
	readonly coarse?: SurfaceCoarseLevel
}

// Reference-creation outcome.
export type SurfaceReferenceOutcome = { readonly success: true; readonly reference: SurfaceReference; readonly candidatePatches: number; readonly rejectedReasons: Record<string, number> } | SurfaceFailure

// Successful frame registration against a surface reference.
export interface SurfaceRegistration {
	// Discriminant for successful registration.
	readonly success: true
	// Reference-to-current image transform.
	readonly transform: RigidTransform2D
	// Fitted model; 'translation' keeps the prediction rotation when patch geometry cannot constrain it.
	readonly model: 'rigid' | 'translation'
	// Reference patches evaluated.
	readonly candidatePatches: number
	// Patches with a successful ZNCC match.
	readonly matchedPatches: number
	// Robust inlier patches of the final fit.
	readonly acceptedPatches: number
	// Fraction of reference coverage cells retaining an inlier, in [0, 1].
	readonly spatialCoverage: number
	// RMS inlier residual, in image pixels.
	readonly rmsResidual: number
	// Robust residual sigma of all matched patches (differential deformation proxy), in image pixels.
	readonly deformationRms: number
	// Median inlier ZNCC peak.
	readonly medianCorrelation: number
	// Median inlier ZNCC peak-to-sidelobe ratio.
	readonly medianPSR: number
	// Heuristic 1-sigma uncertainty of the transform at the patch centroid, in image pixels.
	readonly uncertainty: number
	// Bounded positional reliability in [0, 1].
	readonly confidence: number
	// Whether coarse phase correlation reseeded the prediction.
	readonly reacquired: boolean
	// Stable per-patch rejection counters.
	readonly rejectedReasons: Record<string, number>
}

// Failed surface operation with a stable primary reason and per-patch counters.
export interface SurfaceFailure {
	// Discriminant for failure.
	readonly success: false
	// Primary rejection reason.
	readonly reason: SurfaceRejection
	// Reference patches evaluated, zero when failing before patch registration.
	readonly candidatePatches: number
	// Patches with a successful ZNCC match.
	readonly matchedPatches: number
	// Stable per-patch and stage rejection counters, including the primary reason.
	readonly rejectedReasons: Record<string, number>
}

// Surface registration outcome.
export type SurfaceRegistrationOutcome = SurfaceRegistration | SurfaceFailure

// Unweighted plane score used for automatic plane selection.
export interface SurfacePlaneScore {
	// Scored analysis plane.
	readonly plane: ImageAnalysisPlane
	// validFraction · (1 - saturatedFraction) · contrast / noise; zero when unusable.
	readonly score: number
}

// Maps an image point through a rigid transform. Allocates when out is omitted; returns out.
export function applyRigidTransform(transform: RigidTransform2D, x: number, y: number, out: [number, number] = [0, 0]) {
	const cos = Math.cos(transform.rotation)
	const sin = Math.sin(transform.rotation)
	out[0] = cos * x - sin * y + transform.translation[0]
	out[1] = sin * x + cos * y + transform.translation[1]
	return out
}

// Returns outer∘inner, the transform applying inner first and then outer.
export function composeRigidTransforms(outer: RigidTransform2D, inner: RigidTransform2D): RigidTransform2D {
	const [x, y] = applyRigidTransform(outer, inner.translation[0], inner.translation[1])
	return { rotation: outer.rotation + inner.rotation, translation: [x, y] }
}

// Returns the inverse rigid transform.
export function invertRigidTransform(transform: RigidTransform2D): RigidTransform2D {
	const cos = Math.cos(transform.rotation)
	const sin = Math.sin(transform.rotation)
	const [tx, ty] = transform.translation
	return { rotation: -transform.rotation, translation: [-(cos * tx + sin * ty), sin * tx - cos * ty] }
}

// Returns the rigid transform with the given rotation that maps (x, y) to (x + dx, y + dy).
export function rigidTransformThrough(rotation: number, x: number, y: number, dx: number, dy: number): RigidTransform2D {
	const cos = Math.cos(rotation)
	const sin = Math.sin(rotation)
	return { rotation, translation: [x + dx - (cos * x - sin * y), y + dy - (sin * x + cos * y)] }
}

// Supported analysis planes of a normalized image layout.
export function surfaceAnalysisPlanes(image: Image): readonly ImageAnalysisPlane[] {
	if (image.metadata.bayer !== undefined) return CFA_ANALYSIS_PLANES
	return image.metadata.channels === 3 ? RGB_ANALYSIS_PLANES : MONO_ANALYSIS_PLANES
}

// Copies one analysis plane of an image into a width×height sample grid whose sample (0, 0) is image
// pixel (originX, originY) with the given step. The origin must have the selected CFA plane parity.
// Samples outside the image are flagged invalid, non-finite samples invalid and values at or above
// saturationLevel saturated. out and mask must hold width·height entries. Returns usable/saturated counts.
export function extractSurfaceSamples(image: Image, plane: ImageAnalysisPlane, originX: number, originY: number, step: 1 | 2, width: number, height: number, saturationLevel: number, out: Float32Array, mask: Uint8Array) {
	const count = width * height
	out.fill(0, 0, count)
	mask.fill(SURFACE_SAMPLE_INVALID, 0, count)

	const { metadata, raw } = image
	const left = Math.max(0, originX)
	const top = Math.max(0, originY)
	const right = Math.min(metadata.width, originX + width * step)
	const bottom = Math.min(metadata.height, originY + height * step)
	if (!(left < right && top < bottom)) return { valid: 0, saturated: 0 }

	const geometry = imagePlaneGeometry(metadata, { left, top, right, bottom }, plane)
	if (geometry === undefined) return { valid: 0, saturated: 0 }

	const u0 = Math.round((geometry.sourceLeft - originX) / step)
	const v0 = Math.round((geometry.sourceTop - originY) / step)
	const { rawStart, rawRowStep, rawColumnStep } = geometry
	let valid = 0
	let saturated = 0

	for (let v = 0; v < geometry.height; v++) {
		let source = rawStart + v * rawRowStep
		let index = (v0 + v) * width + u0

		for (let u = 0; u < geometry.width; u++, source += rawColumnStep, index++) {
			const value = raw[source]
			if (!Number.isFinite(value)) continue
			out[index] = value

			if (value >= saturationLevel) {
				mask[index] = SURFACE_SAMPLE_SATURATED
				saturated++
			} else {
				mask[index] = 0
				valid++
			}
		}
	}

	return { valid, saturated }
}

// Robust gradient-noise sigma from the MAD of horizontal second differences of usable samples, in
// sample units. Uses a deterministic stride subsample sized to scratch; zero when unresolved.
function secondDifferenceNoise(data: Readonly<Float32Array>, mask: Readonly<Uint8Array>, width: number, height: number, scratch: Float64Array) {
	const total = Math.max(0, width - 2) * height
	const stride = Math.max(1, Math.ceil(total / scratch.length))
	let n = 0
	let seen = 0

	for (let y = 0; y < height; y++) {
		const row = y * width

		for (let x = 1; x < width - 1; x++) {
			const i = row + x
			if (mask[i - 1] !== 0 || mask[i] !== 0 || mask[i + 1] !== 0) continue
			if (seen++ % stride === 0 && n < scratch.length) scratch[n++] = Math.abs(data[i - 1] - 2 * data[i] + data[i + 1])
		}
	}

	// Var(x[i-1] - 2x[i] + x[i+1]) = 6σ² for white noise; 1.4826·median|d| estimates its sigma.
	return n > 0 ? (1.482602218505602 * medianBySelectionOf(scratch, n)) / Math.sqrt(6) : 0
}

// Scores one analysis plane of an image ROI by usable fraction, saturation and robust contrast over
// second-difference noise. Overwrites workspace raw/mask buffers.
export function scoreSurfacePlane(image: Image, area: Readonly<Rect>, plane: ImageAnalysisPlane, workspace: SurfaceTrackingWorkspace, saturationLevel: number = 1): SurfacePlaneScore {
	const geometry = imagePlaneGeometry(image.metadata, area, plane)
	if (geometry === undefined) return { plane, score: 0 }
	const { width, height } = geometry
	const count = width * height
	const raw = workspace.raw(count)
	const mask = workspace.mask(count)
	const { valid, saturated } = extractSurfaceSamples(image, plane, geometry.sourceLeft, geometry.sourceTop, geometry.step, width, height, saturationLevel, raw, mask)
	if (valid === 0) return { plane, score: 0 }

	const normalized = workspace.normalized(count)
	const statistics = normalizeRegistrationSamples(raw, mask, count, normalized, workspace.statistics)
	const noise = secondDifferenceNoise(raw, mask, width, height, workspace.statistics)
	const contrastToNoise = statistics.scale > 0 ? (noise > 0 ? Math.min(1000, statistics.scale / noise) : 1000) : 0
	return { plane, score: (valid / count) * (1 - saturated / count) * contrastToNoise }
}

// Selects the best-scoring supported plane of an image ROI, or undefined when none has contrast.
export function selectSurfacePlane(image: Image, area: Readonly<Rect>, workspace: SurfaceTrackingWorkspace, saturationLevel: number = 1): ImageAnalysisPlane | undefined {
	let best: SurfacePlaneScore | undefined

	for (const plane of surfaceAnalysisPlanes(image)) {
		const score = scoreSurfacePlane(image, area, plane, workspace, saturationLevel)
		if (score.score > 0 && (best === undefined || score.score > best.score)) best = score
	}

	return best?.plane
}

// Fills raw, mask and normalized workspace buffers for a grid and applies optional detrending.
function prepareSurfaceGrid(image: Image, plane: ImageAnalysisPlane, originX: number, originY: number, step: 1 | 2, width: number, height: number, workspace: SurfaceTrackingWorkspace, options: SurfaceTrackingOptions) {
	const count = width * height
	const raw = workspace.raw(count)
	const mask = workspace.mask(count)
	const counts = extractSurfaceSamples(image, plane, originX, originY, step, width, height, options.saturationLevel, raw, mask)
	const data = workspace.normalized(count)
	normalizeRegistrationSamples(raw, mask, count, data, workspace.statistics)
	const grid: RegistrationPlane & { readonly data: Float32Array; readonly mask: Uint8Array } = { width, height, data, mask }
	if (options.detrend && counts.valid > 0) removeLinearTrend(grid)
	return { grid, valid: counts.valid, saturated: counts.saturated }
}

// Averages factor×factor blocks of usable fine samples into a coarse grid; blocks with fewer than half
// usable samples are masked. out and outMask must hold floor(width/factor)·floor(height/factor) entries.
function downsampleSurface(data: Readonly<Float32Array>, mask: Readonly<Uint8Array>, width: number, factor: number, coarseWidth: number, coarseHeight: number, out: Float32Array, outMask: Uint8Array) {
	const required = (factor * factor) / 2

	for (let cy = 0, k = 0; cy < coarseHeight; cy++) {
		for (let cx = 0; cx < coarseWidth; cx++, k++) {
			let sum = 0
			let n = 0

			for (let j = 0; j < factor; j++) {
				const row = (cy * factor + j) * width + cx * factor

				for (let i = 0; i < factor; i++) {
					if (mask[row + i] !== 0) continue
					sum += data[row + i]
					n++
				}
			}

			out[k] = n >= required ? sum / n : 0
			outMask[k] = n >= required ? 0 : SURFACE_SAMPLE_INVALID
		}
	}
}

// Increments a rejection counter.
function reject(reasons: Record<string, number>, reason: string, count: number = 1) {
	reasons[reason] = (reasons[reason] ?? 0) + count
}

// Builds a failure carrying its primary reason in the counters.
function failure(reason: SurfaceRejection, reasons: Record<string, number>, candidatePatches: number = 0, matchedPatches: number = 0): SurfaceFailure {
	reasons[reason] ??= 1
	return { success: false, reason, candidatePatches, matchedPatches, rejectedReasons: reasons }
}

// Coverage cell 0..8 of a sample position on the 3×3 grid of a width×height plane.
function coverageCell(x: number, y: number, width: number, height: number) {
	return Math.min(2, Math.max(0, Math.floor((3 * x) / width))) + 3 * Math.min(2, Math.max(0, Math.floor((3 * y) / height)))
}

// Number of set bits in a coverage-cell bit set.
function cellCount(bits: number) {
	let count = 0
	for (let b = bits; b !== 0; b &= b - 1) count++
	return count
}

// Creates a surface reference for an image ROI (inside the image, in image pixels). Selects
// high-structure patches distributed over a patch-sized grid with minimum spacing, and caches a coarse
// phase spectrum. Allocates the retained reference buffers; overwrites workspace buffers.
export function createSurfaceReference(image: Image, area: Readonly<Rect>, plane: ImageAnalysisPlane, workspace: SurfaceTrackingWorkspace, options: SurfaceTrackingOptions = DEFAULT_SURFACE_TRACKING_OPTIONS): SurfaceReferenceOutcome {
	const reasons: Record<string, number> = {}
	let geometry: ImagePlaneGeometry | undefined

	try {
		geometry = imagePlaneGeometry(image.metadata, area, plane)
	} catch {
		return failure('unsupported_plane', reasons)
	}

	if (geometry === undefined) return failure('unsupported_plane', reasons)

	const { width, height, step, sourceLeft: originX, sourceTop: originY } = geometry
	const patchSize = Math.min(Math.floor(options.patchSize), Math.floor(Math.min(width, height) / 2))
	if (patchSize < 8) return failure('low_structure', reasons)

	const count = width * height
	const { grid, valid, saturated } = prepareSurfaceGrid(image, plane, originX, originY, step, width, height, workspace, options)
	if (valid < count * 0.25) return failure(saturated > valid ? 'saturated' : 'masked', reasons)

	const data = grid.data.slice(0, count)
	const mask = grid.mask.slice(0, count)
	const noise = secondDifferenceNoise(data, mask, width, height, workspace.statistics)
	const noiseVariance = Math.max(1e-12, 0.5 * noise * noise)
	const stride = Math.max(4, patchSize >>> 1)
	const columns = Math.floor((width - patchSize) / stride) + 1
	const rows = Math.floor((height - patchSize) / stride) + 1
	const candidateScores = new Float64Array(columns * rows)
	const area2 = patchSize * patchSize
	let strongest = 0

	for (let r = 0, c = 0; r < rows; r++) {
		const top = r * stride

		for (let q = 0; q < columns; q++, c++) {
			const left = q * stride
			let usable = 0
			let saturatedSamples = 0

			for (let j = 0; j < patchSize; j++) {
				const row = (top + j) * width + left

				for (let i = 0; i < patchSize; i++) {
					const flag = mask[row + i]
					if (flag === 0) usable++
					else if (flag === SURFACE_SAMPLE_SATURATED) saturatedSamples++
				}
			}

			if (saturatedSamples > options.maximumSaturatedFraction * area2) {
				reject(reasons, 'saturated')
				continue
			}

			if (usable < options.minimumValidFraction * area2) {
				reject(reasons, 'masked')
				continue
			}

			let n = 0
			let gxx = 0
			let gyy = 0
			let gxy = 0

			for (let j = 1; j < patchSize - 1; j++) {
				const row = (top + j) * width + left

				for (let i = 1; i < patchSize - 1; i++) {
					const k = row + i
					if (mask[k - 1] !== 0 || mask[k + 1] !== 0 || mask[k - width] !== 0 || mask[k + width] !== 0) continue
					const gx = (data[k + 1] - data[k - 1]) * 0.5
					const gy = (data[k + width] - data[k - width]) * 0.5
					gxx += gx * gx
					gyy += gy * gy
					gxy += gx * gy
					n++
				}
			}

			if (n === 0) {
				reject(reasons, 'masked')
				continue
			}

			const a = gxx / n
			const b = gxy / n
			const d = gyy / n
			const smaller = (a + d) * 0.5 - Math.sqrt(((a - d) * 0.5) ** 2 + b * b)
			const structure = Math.max(0, smaller) / noiseVariance
			candidateScores[c] = structure
			if (structure > strongest) strongest = structure
		}
	}

	// Best candidate per patch-sized cell keeps support distributed instead of clustered on one feature.
	const cellColumns = Math.ceil(width / patchSize)
	const cellRows = Math.ceil(height / patchSize)
	const cellBest = new Int32Array(cellColumns * cellRows).fill(-1)
	const threshold = Math.max(options.minimumStructure, options.minimumRelativeStructure * strongest)

	for (let r = 0, c = 0; r < rows; r++) {
		for (let q = 0; q < columns; q++, c++) {
			const score = candidateScores[c]
			if (score === 0) continue

			if (!(score >= threshold)) {
				reject(reasons, 'low_structure')
				continue
			}

			const centerX = q * stride + patchSize * 0.5
			const centerY = r * stride + patchSize * 0.5
			const cell = Math.min(cellColumns - 1, Math.floor(centerX / patchSize)) + cellColumns * Math.min(cellRows - 1, Math.floor(centerY / patchSize))
			if (cellBest[cell] < 0 || score > candidateScores[cellBest[cell]]) cellBest[cell] = c
		}
	}

	// Cell winners are placed first; remaining qualifying candidates then fill free space by score.
	const winners: number[] = []
	const others: number[] = []
	const isWinner = new Uint8Array(candidateScores.length)

	for (let i = 0; i < cellBest.length; i++) {
		if (cellBest[i] < 0) continue
		winners.push(cellBest[i])
		isWinner[cellBest[i]] = 1
	}

	for (let c = 0; c < candidateScores.length; c++) if (isWinner[c] === 0 && candidateScores[c] >= threshold) others.push(c)
	const byScore = (a: number, b: number) => candidateScores[b] - candidateScores[a] || a - b
	winners.sort(byScore)
	others.sort(byScore)

	const spacing2 = (0.75 * patchSize) ** 2
	const patches: SurfacePatch[] = []
	let coverageCells = 0

	for (const c of winners.concat(others)) {
		if (patches.length >= options.maximumPatches) break
		const left = (c % columns) * stride
		const top = Math.floor(c / columns) * stride
		let separated = true

		for (const patch of patches) {
			if ((patch.left - left) ** 2 + (patch.top - top) ** 2 < spacing2) {
				separated = false
				break
			}
		}

		if (!separated) continue
		const cell = coverageCell(left + patchSize * 0.5, top + patchSize * 0.5, width, height)
		coverageCells |= 1 << cell
		patches.push({ left, top, x: originX + (left + (patchSize - 1) * 0.5) * step, y: originY + (top + (patchSize - 1) * 0.5) * step, structure: candidateScores[c], cell })
	}

	const candidatePatches = columns * rows
	if (patches.length < Math.max(1, options.minimumInliers)) return failure('low_structure', reasons, candidatePatches)

	let factor = 1
	while (Math.max(width, height) / factor > options.coarseSize) factor *= 2
	const coarseWidth = Math.floor(width / factor)
	const coarseHeight = Math.floor(height / factor)
	let coarse: SurfaceCoarseLevel | undefined

	if (coarseWidth >= 8 && coarseHeight >= 8) {
		const coarseCount = coarseWidth * coarseHeight
		const coarseData = new Float32Array(coarseCount)
		const coarseMask = new Uint8Array(coarseCount)
		downsampleSurface(data, mask, width, factor, coarseWidth, coarseHeight, coarseData, coarseMask)
		const maximumShift = Math.max(1, Math.floor(Math.min(coarseWidth, coarseHeight) * options.coarseShiftFraction))
		const phase = workspace.phaseCorrelation(coarseWidth, coarseHeight, maximumShift)
		const spectrum = phaseCorrelationSpectrum({ width: coarseWidth, height: coarseHeight, data: coarseData, mask: coarseMask }, phase)
		if (spectrum.energy > 0) coarse = { factor, width: coarseWidth, height: coarseHeight, maximumShift, spectrum }
	}

	const reference: SurfaceReference = { plane, area: { left: area.left, top: area.top, right: area.right, bottom: area.bottom }, originX, originY, step, width, height, data, mask, patchSize, patches, coverageCells, noise, coarse }
	return { success: true, reference, candidatePatches, rejectedReasons: reasons }
}

// Robust weighted rigid or translation-only fit result.
export interface RigidFit {
	// Fitted reference-to-current transform.
	readonly transform: RigidTransform2D
	// Number of correspondences inside the final Tukey cutoff.
	readonly inliers: number
	// RMS residual of inliers, in input units.
	readonly rms: number
	// Robust per-axis residual sigma of all correspondences, in input units.
	readonly scale: number
	// Final Tukey cutoff, in input units.
	readonly cutoff: number
}

// Options for the robust rigid fit.
export interface RigidFitOptions {
	// 'rigid' fits rotation and translation; 'translation' keeps rotation fixed.
	readonly model: 'rigid' | 'translation'
	// Fixed rotation for 'translation' and the initialization rotation for 'rigid', in radians.
	readonly rotation: number
	// Tukey cutoff in robust residual sigmas.
	readonly outlierThreshold: number
	// Lower bound of the robust residual sigma, in input units.
	readonly minimumResidualScale: number
}

// Fits q ≈ R·p + t to weighted correspondences by Tukey-reweighted least squares. Initialization uses
// the component median of q - R(rotation)·p (50% breakdown), then alternates residual scaling by the
// median residual norm and weighted Procrustes (or fixed-rotation mean translation). scratch must hold
// 2·count values; inlierOut, when given, receives 1 for inliers and 0 otherwise. Returns undefined when
// no positive weight survives.
export function fitRigidTransform(px: Readonly<Float64Array>, py: Readonly<Float64Array>, qx: Readonly<Float64Array>, qy: Readonly<Float64Array>, weights: Readonly<Float64Array>, count: number, options: RigidFitOptions, scratch: Float64Array, inlierOut?: Uint8Array): RigidFit | undefined {
	if (count === 0) return undefined
	const residuals = scratch.subarray(0, count)
	const temporary = scratch.subarray(count, 2 * count)
	let rotation = options.rotation
	let cos = Math.cos(rotation)
	let sin = Math.sin(rotation)

	for (let i = 0; i < count; i++) temporary[i] = qx[i] - (cos * px[i] - sin * py[i])
	let tx = medianBySelectionOf(temporary, count)
	for (let i = 0; i < count; i++) temporary[i] = qy[i] - (sin * px[i] + cos * py[i])
	let ty = medianBySelectionOf(temporary, count)
	let scale = options.minimumResidualScale
	let cutoff = options.outlierThreshold * scale

	for (let iteration = 0; iteration < RIGID_FIT_ITERATIONS; iteration++) {
		for (let i = 0; i < count; i++) {
			residuals[i] = Math.hypot(qx[i] - (cos * px[i] - sin * py[i] + tx), qy[i] - (sin * px[i] + cos * py[i] + ty))
			temporary[i] = residuals[i]
		}

		scale = Math.max(options.minimumResidualScale, medianBySelectionOf(temporary, count) / RAYLEIGH_MEDIAN)
		cutoff = options.outlierThreshold * scale
		let sw = 0
		let spx = 0
		let spy = 0
		let sqx = 0
		let sqy = 0

		for (let i = 0; i < count; i++) {
			const u = residuals[i] / cutoff
			const w = u < 1 ? weights[i] * (1 - u * u) ** 2 : 0
			temporary[i] = w
			sw += w
			spx += w * px[i]
			spy += w * py[i]
			sqx += w * qx[i]
			sqy += w * qy[i]
		}

		if (!(sw > 0)) return undefined
		const mpx = spx / sw
		const mpy = spy / sw
		const mqx = sqx / sw
		const mqy = sqy / sw

		if (options.model === 'rigid') {
			let cross = 0
			let dot = 0

			for (let i = 0; i < count; i++) {
				const w = temporary[i]
				if (w === 0) continue
				const ax = px[i] - mpx
				const ay = py[i] - mpy
				const bx = qx[i] - mqx
				const by = qy[i] - mqy
				cross += w * (ax * by - ay * bx)
				dot += w * (ax * bx + ay * by)
			}

			if (cross !== 0 || dot !== 0) {
				rotation = Math.atan2(cross, dot)
				cos = Math.cos(rotation)
				sin = Math.sin(rotation)
			}
		}

		tx = mqx - (cos * mpx - sin * mpy)
		ty = mqy - (sin * mpx + cos * mpy)
	}

	let inliers = 0
	let squares = 0

	for (let i = 0; i < count; i++) {
		const residual = Math.hypot(qx[i] - (cos * px[i] - sin * py[i] + tx), qy[i] - (sin * px[i] + cos * py[i] + ty))
		const inlier = residual < cutoff && weights[i] > 0
		if (inlierOut !== undefined) inlierOut[i] = inlier ? 1 : 0
		if (!inlier) continue
		inliers++
		squares += residual * residual
	}

	return { transform: { rotation, translation: [tx, ty] }, inliers, rms: inliers > 0 ? Math.sqrt(squares / inliers) : 0, scale, cutoff }
}

// Weighted standard deviation of points along their least-spread principal axis (sqrt of the smaller
// covariance eigenvalue), in input units. Points with a zero flag are skipped.
function minimumSpread(px: Readonly<Float64Array>, py: Readonly<Float64Array>, flags: Readonly<Uint8Array> | undefined, count: number) {
	let n = 0
	let sx = 0
	let sy = 0

	for (let i = 0; i < count; i++) {
		if (flags !== undefined && flags[i] === 0) continue
		n++
		sx += px[i]
		sy += py[i]
	}

	if (n < 2) return 0
	const mx = sx / n
	const my = sy / n
	let xx = 0
	let yy = 0
	let xy = 0

	for (let i = 0; i < count; i++) {
		if (flags !== undefined && flags[i] === 0) continue
		const dx = px[i] - mx
		const dy = py[i] - my
		xx += dx * dx
		yy += dy * dy
		xy += dx * dy
	}

	xx /= n
	yy /= n
	xy /= n
	return Math.sqrt(Math.max(0, (xx + yy) * 0.5 - Math.sqrt(((xx - yy) * 0.5) ** 2 + xy * xy)))
}

// Registers a frame to a surface reference. prediction maps reference image pixels to the expected
// current position and seeds every patch search; the current ROI follows its translation at the ROI
// center with a search margin, and samples outside the image are masked. Returns the robust
// reference-to-current transform or a stable failure. Overwrites workspace buffers.
export function registerSurface(reference: SurfaceReference, image: Image, prediction: RigidTransform2D, workspace: SurfaceTrackingWorkspace, options: SurfaceTrackingOptions = DEFAULT_SURFACE_TRACKING_OPTIONS, reacquired: boolean = false, reasons: Record<string, number> = {}): SurfaceRegistrationOutcome {
	const { step, patchSize, patches } = reference
	const centerX = reference.originX + (reference.width - 1) * 0.5 * step
	const centerY = reference.originY + (reference.height - 1) * 0.5 * step
	const predictedCenter = applyRigidTransform(prediction, centerX, centerY)
	const radius = Math.max(1, Math.floor(options.searchRadius))
	const margin = radius + 2
	const shiftX = Math.round((predictedCenter[0] - centerX) / step) * step
	const shiftY = Math.round((predictedCenter[1] - centerY) / step) * step
	const originX = reference.originX + shiftX - margin * step
	const originY = reference.originY + shiftY - margin * step
	const width = reference.width + 2 * margin
	const height = reference.height + 2 * margin
	const { grid: current, valid } = prepareSurfaceGrid(image, reference.plane, originX, originY, step, width, height, workspace, options)
	const candidatePatches = patches.length
	if (valid === 0) return failure('masked', reasons, candidatePatches)

	const referencePlane: RegistrationPlane = { width: reference.width, height: reference.height, data: reference.data, mask: reference.mask }
	const search = workspace.search((2 * radius + 1) ** 2)
	const refinement = options.refine ? workspace.refinement(4 * patchSize * patchSize) : undefined
	const searchOptions: ZNCCSearchOptions = { searchRadius: radius, minimumOverlap: options.minimumOverlap, minimumCorrelation: options.minimumCorrelation, maximumSecondPeakRatio: options.maximumSecondPeakRatio }
	const offsetX = originX - reference.originX
	const offsetY = originY - reference.originY
	const fit = workspace.fit(10 * candidatePatches)
	const px = fit.subarray(0, candidatePatches)
	const py = fit.subarray(candidatePatches, 2 * candidatePatches)
	const qx = fit.subarray(2 * candidatePatches, 3 * candidatePatches)
	const qy = fit.subarray(3 * candidatePatches, 4 * candidatePatches)
	const weights = fit.subarray(4 * candidatePatches, 5 * candidatePatches)
	const correlations = fit.subarray(5 * candidatePatches, 6 * candidatePatches)
	const psrs = fit.subarray(6 * candidatePatches, 7 * candidatePatches)
	const uncertainties = fit.subarray(7 * candidatePatches, 8 * candidatePatches)
	const fitScratch = fit.subarray(8 * candidatePatches, 10 * candidatePatches)
	const cells = new Uint8Array(candidatePatches)
	const inliers = new Uint8Array(candidatePatches)
	const predicted: [number, number] = [0, 0]
	let matched = 0

	for (const patch of patches) {
		applyRigidTransform(prediction, patch.x, patch.y, predicted)
		const predictedX = (predicted[0] - patch.x - offsetX) / step
		const predictedY = (predicted[1] - patch.y - offsetY) / step
		const match = matchPatchZNCC(referencePlane, patch.left, patch.top, patchSize, patchSize, current, predictedX, predictedY, searchOptions, search)

		if (!match.success) {
			reject(reasons, match.reason)
			continue
		}

		let [dx, dy] = match.translation

		if (refinement !== undefined) {
			const refined = refineTranslationECC(referencePlane, patch.left, patch.top, patchSize, patchSize, current, dx, dy, {}, refinement)

			if (refined.success) {
				dx = refined.translation[0]
				dy = refined.translation[1]
			}
		}

		const uncertainty = match.uncertainty * step
		px[matched] = patch.x
		py[matched] = patch.y
		qx[matched] = patch.x + offsetX + dx * step
		qy[matched] = patch.y + offsetY + dy * step
		weights[matched] = (match.overlapFraction * Math.max(0, match.correlation) ** 2) / (uncertainty * uncertainty + 0.01)
		correlations[matched] = match.correlation
		psrs[matched] = match.peakToSidelobeRatio
		uncertainties[matched] = uncertainty
		cells[matched] = patch.cell
		matched++
	}

	const minimumInliers = Math.max(1, options.minimumInliers)
	if (matched < minimumInliers) return failure('insufficient_inliers', reasons, candidatePatches, matched)

	const baseline = options.minimumRotationBaseline ?? patchSize * step * 0.5
	const fitOptions: RigidFitOptions = { model: matched >= 3 && minimumSpread(px, py, undefined, matched) >= baseline ? 'rigid' : 'translation', rotation: prediction.rotation, outlierThreshold: options.outlierThreshold, minimumResidualScale: options.minimumResidualScale }
	let model = fitOptions.model
	let result = fitRigidTransform(px, py, qx, qy, weights, matched, fitOptions, fitScratch, inliers)

	// Rotation needs at least three inliers spread across two dimensions; otherwise hold the prediction.
	if (result !== undefined && model === 'rigid' && (result.inliers < 3 || minimumSpread(px, py, inliers, matched) < baseline)) {
		model = 'translation'
		result = fitRigidTransform(px, py, qx, qy, weights, matched, { ...fitOptions, model }, fitScratch, inliers)
	}

	if (result === undefined) return failure('insufficient_inliers', reasons, candidatePatches, matched)
	if (matched > result.inliers) reject(reasons, 'consensus_outlier', matched - result.inliers)
	if (result.inliers < minimumInliers) return failure('insufficient_inliers', reasons, candidatePatches, matched)

	let inlierCells = 0
	let n = 0

	for (let i = 0; i < matched; i++) {
		if (inliers[i] === 0) continue
		inlierCells |= 1 << cells[i]
		// Compact inlier quality samples in place for the medians below.
		correlations[n] = correlations[i]
		psrs[n] = psrs[i]
		uncertainties[n] = uncertainties[i]
		n++
	}

	const spatialCoverage = cellCount(inlierCells) / Math.max(1, cellCount(reference.coverageCells))
	if (!(spatialCoverage >= options.minimumSpatialCoverage)) return failure('insufficient_spatial_coverage', reasons, candidatePatches, matched)

	const medianCorrelation = medianBySelectionOf(correlations, n)
	const medianPSR = medianBySelectionOf(psrs, n)
	const medianUncertainty = medianBySelectionOf(uncertainties, n)
	const uncertainty = Math.sqrt((result.rms * result.rms + medianUncertainty * medianUncertainty) / n)
	const correlationScore = Math.min(1, Math.max(0.05, (medianCorrelation - options.minimumCorrelation) / Math.max(1e-6, 1 - options.minimumCorrelation)))
	const uncertaintyScore = 1 / (1 + (uncertainty / 0.5) ** 2)
	// Weighted geometric mean of bounded evidence; hard gates above already rejected unusable frames.
	const confidence = Math.min(1, Math.max(0, (correlationScore * (n / matched) * spatialCoverage * uncertaintyScore) ** 0.25))

	return {
		success: true,
		transform: result.transform,
		model,
		candidatePatches,
		matchedPatches: matched,
		acceptedPatches: n,
		spatialCoverage,
		rmsResidual: result.rms,
		deformationRms: result.scale,
		medianCorrelation,
		medianPSR,
		uncertainty,
		confidence,
		reacquired,
		rejectedReasons: reasons,
	}
}

// Recovers a large displacement by coarse phase correlation of the reference ROI against the same-size
// ROI displaced by guess, then registers patches from the coarse estimate. The guess rotation is kept
// through the coarse stage. Fails with 'reacquisition_failed' when the reference has no coarse level or
// the coarse peak is rejected. Overwrites workspace buffers.
export function reacquireSurface(reference: SurfaceReference, image: Image, guess: RigidTransform2D, workspace: SurfaceTrackingWorkspace, options: SurfaceTrackingOptions = DEFAULT_SURFACE_TRACKING_OPTIONS): SurfaceRegistrationOutcome {
	const reasons: Record<string, number> = {}
	const coarse = reference.coarse
	if (coarse === undefined) return failure('reacquisition_failed', reasons)

	const { step, width, height } = reference
	const centerX = reference.originX + (width - 1) * 0.5 * step
	const centerY = reference.originY + (height - 1) * 0.5 * step
	const guessed = applyRigidTransform(guess, centerX, centerY)
	const shiftX = Math.round((guessed[0] - centerX) / step) * step
	const shiftY = Math.round((guessed[1] - centerY) / step) * step
	const { grid, valid } = prepareSurfaceGrid(image, reference.plane, reference.originX + shiftX, reference.originY + shiftY, step, width, height, workspace, options)
	if (valid === 0) return failure('reacquisition_failed', reasons)

	const coarseCount = coarse.width * coarse.height
	const coarseData = workspace.coarse(coarseCount)
	const coarseMask = workspace.coarseMask(coarseCount)
	downsampleSurface(grid.data, grid.mask, width, coarse.factor, coarse.width, coarse.height, coarseData, coarseMask)
	const phase = workspace.phaseCorrelation(coarse.width, coarse.height, coarse.maximumShift)
	const spectrum = phaseCorrelationSpectrum({ width: coarse.width, height: coarse.height, data: coarseData, mask: coarseMask }, phase)
	const outcome = phaseCorrelate(coarse.spectrum, spectrum, phase, { maximumShift: coarse.maximumShift, normalization: options.coarseNormalization })

	if (!outcome.success) {
		reject(reasons, outcome.reason)
		return failure('reacquisition_failed', reasons)
	}

	const scale = coarse.factor * step
	const prediction = rigidTransformThrough(guess.rotation, centerX, centerY, shiftX + outcome.translation[0] * scale, shiftY + outcome.translation[1] * scale)
	return registerSurface(reference, image, prediction, workspace, options, true, reasons)
}
