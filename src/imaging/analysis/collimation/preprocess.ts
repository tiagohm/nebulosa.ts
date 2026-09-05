import { TAU } from '../../../core/constants'
import { validateInRange, validatePositiveInteger } from '../../../core/validation'
import type { EllipseGeometry } from '../../../math/numerical/ellipse.geometry'
import type { Point, Rect } from '../../../math/numerical/geometry'
import { robustLinearLeastSquares } from '../../../math/numerical/least.squares'
import { type ImageMetadata, makeImageRawTypedArray } from '../../model/types'
import { separableSmoothing, separableSmoothingKernel } from '../../processing/convolution'
import { CFA_ANALYSIS_PLANES, type ImageAnalysisPlane, type ImagePlaneGeometry, imagePlaneGeometry, MONO_ANALYSIS_PLANES, resolveAnalysisArea, RGB_ANALYSIS_PLANES } from '../plane'
import { ROBUST_SAMPLE_CAPACITY, RobustReservoir } from '../robust'
import type { CollimationAnalysisInput, CollimationAnalysisOptions, CollimationDiagnostic, CollimationFailureReason, CollimationWorkspace, CollimationWorkspaceOptions } from './types'

// Native mono/RGB/CFA ROI preparation for annular geometry. Source samples retain their precision and
// signed normalized scale. Scratch is workspace-owned, background fitting uses bounded spatial samples,
// and convolution excludes the full support of invalid/saturated pixels without reconstructing CFA.

// Fully resolved per-call defaults; saturation and tolerance deliberately remain optional.
export type ResolvedCollimationOptions = Required<Omit<CollimationAnalysisOptions, 'saturationLevel' | 'tolerance' | 'workspace'>> & Pick<CollimationAnalysisOptions, 'saturationLevel' | 'tolerance'>

// Stable local background representation, separating a large pedestal from small fitted differences.
export interface CollimationBackground {
	// Median raw pedestal in normalized full-scale units.
	readonly pedestal: number
	// Constant difference from pedestal and x/y slopes over local coordinates scaled to [-0.5, 0.5].
	readonly coefficients: readonly [number, number, number]
	// Fitted level at the plane midpoint, in normalized full-scale units.
	readonly level: number
	// Normalized-MAD external background noise, absent when numerically or quantization unresolved.
	readonly noise?: number
}

// Prepared frame backed by mutable scratch; internal consumers must finish before workspace reuse.
export interface PreparedCollimation {
	// Preparation succeeded; this is not yet a successful geometry measurement.
	readonly success: true
	// Independent half-open ROI in received-image coordinates.
	readonly area: Readonly<Rect>
	// Selected native color plane.
	readonly plane: ImageAnalysisPlane
	// Mapping from local native grid to received-image pixels.
	readonly grid: ImagePlaneGeometry
	// Mono metadata with exact active dimensions for shared convolution.
	readonly metadata: ImageMetadata
	// Initial point in native plane coordinates.
	readonly center: Readonly<Point>
	// Resolved controls for all later pipeline stages.
	readonly options: ResolvedCollimationOptions
	// Kernel radius plus two native pixels for interpolation and gradient support.
	readonly margin: number
	// One caller-owned scratch workspace.
	readonly workspace: CollimationWorkspace
	// Background replaced only after another bounded exterior fit succeeds.
	background: CollimationBackground
}

// Preparation content failure, without invented image measurements.
export interface CollimationPreprocessFailure {
	// Failure discriminator.
	readonly success: false
	// Observed content limitation.
	readonly reason: CollimationFailureReason
	// Independent ROI in received-image coordinates.
	readonly area: Readonly<Rect>
	// Additional interpretation limits known before extraction.
	readonly diagnostics: readonly CollimationDiagnostic[]
}

// Maximum ROI side in received-image pixels, bounding both storage and radial traversal.
const MAXIMUM_SIDE = 1024
// Background regression population cap; the spatial grid also retains all four quadrants.
const BACKGROUND_CAPACITY = 2048

// Allocates scratch for a maximum ROI in image pixels. Capacity is at most 1024 per side and 2048
// angles; precision defaults to 32 bits. Buffers are distinct and are never returned as image results.
export function createCollimationWorkspace(width: number, height: number, options: CollimationWorkspaceOptions = {}): CollimationWorkspace {
	validatePositiveInteger(width)
	validatePositiveInteger(height)
	validateInRange(width, 1, MAXIMUM_SIDE)
	validateInRange(height, 1, MAXIMUM_SIDE)
	const angularCapacity = options.angularSamples ?? 360
	validatePositiveInteger(angularCapacity)
	validateInRange(angularCapacity, 12, 2048)
	const precision = options.precision ?? 32
	const length = width * height
	const radialCapacity = Math.ceil(2 * Math.hypot(width, height)) + 4
	return {
		width,
		height,
		precision,
		angularCapacity,
		plane: makeImageRawTypedArray(precision, length),
		signal: makeImageRawTypedArray(precision, length),
		smoothed: makeImageRawTypedArray(precision, length),
		temporary: makeImageRawTypedArray(precision, length),
		validity: makeImageRawTypedArray(precision, length),
		support: makeImageRawTypedArray(precision, length),
		mask: new Uint8Array(length),
		horizontalMask: new Uint8Array(length),
		expandedMask: new Uint8Array(length),
		statistics: new RobustReservoir(length),
		scratch: new Float64Array(Math.min(Math.max(length, angularCapacity), ROBUST_SAMPLE_CAPACITY)),
		profile: new Float64Array(radialCapacity),
		innerX: new Float64Array(angularCapacity),
		innerY: new Float64Array(angularCapacity),
		outerX: new Float64Array(angularCapacity),
		outerY: new Float64Array(angularCapacity),
		innerWeight: new Float64Array(angularCapacity),
		outerWeight: new Float64Array(angularCapacity),
		innerReason: new Uint8Array(angularCapacity),
		outerReason: new Uint8Array(angularCapacity),
		sin: new Float64Array(angularCapacity),
		cos: new Float64Array(angularCapacity),
		cache: { angularSamples: 0 },
	}
}

// Resolves native sampling, validates structural relations/capacity before scratch mutation, estimates
// peripheral background and prepares masked smoothing. Content limitations return a discriminated
// failure. The supplied center must be inside the shadow; later extraction verifies that hypothesis.
export function prepareCollimation(input: CollimationAnalysisInput, options: CollimationAnalysisOptions = {}): PreparedCollimation | CollimationPreprocessFailure {
	const { image } = input
	const { width, height, channels, stride, pixelCount, bayer } = image.metadata
	// These relations prevent a plausible measurement of the wrong raw samples, not range policing.
	if ((channels !== 1 && channels !== 3) || (bayer !== undefined && channels !== 1)) throw new RangeError('collimation requires mono, RGB or one-channel CFA layout')
	if (pixelCount !== width * height || stride !== width * channels || image.raw.length < stride * height) throw new RangeError('collimation image has inconsistent raw layout')
	const area = { ...resolveAnalysisArea(input.area, width, height) }
	const roiWidth = area.right - area.left
	const roiHeight = area.bottom - area.top
	const resolved: ResolvedCollimationOptions = {
		plane: options.plane ?? 'auto',
		saturationLevel: options.saturationLevel,
		smoothingSigma: options.smoothingSigma ?? 1,
		angularSamples: options.angularSamples ?? 360,
		minimumCoverage: options.minimumCoverage ?? 0.8,
		maximumGap: options.maximumGap ?? Math.PI / 3,
		maximumEdgeResidual: options.maximumEdgeResidual ?? 0.5,
		minimumSignalToNoise: options.minimumSignalToNoise ?? 8,
		tolerance: options.tolerance,
	}
	// Bounds prevent accidentally huge allocations and kernel/ray traversals, including nonfinite sizes.
	validateInRange(roiWidth, 1, MAXIMUM_SIDE)
	validateInRange(roiHeight, 1, MAXIMUM_SIDE)
	validatePositiveInteger(resolved.angularSamples)
	validateInRange(resolved.angularSamples, 12, 2048)
	validateInRange(resolved.smoothingSigma, 0, 32)
	const precision = image.raw.BYTES_PER_ELEMENT === 8 ? 64 : 32
	const workspace = options.workspace ?? createCollimationWorkspace(roiWidth, roiHeight, { precision, angularSamples: resolved.angularSamples })
	if (workspace.width < roiWidth || workspace.height < roiHeight || workspace.precision !== precision || workspace.angularCapacity < resolved.angularSamples) throw new RangeError('incompatible collimation workspace capacity or precision')
	const planes = bayer !== undefined ? CFA_ANALYSIS_PLANES : channels === 3 ? RGB_ANALYSIS_PLANES : MONO_ANALYSIS_PLANES
	const plane = resolved.plane === 'auto' ? (bayer !== undefined ? 'green1' : channels === 3 ? 'green' : 'mono') : resolved.plane
	const diagnostics: CollimationDiagnostic[] = resolved.saturationLevel === undefined ? ['saturationUnknown'] : []
	if (!planes.includes(plane)) return { success: false, reason: 'unsupportedPlane', area, diagnostics }
	const grid = imagePlaneGeometry(image.metadata, area, plane)
	if (!grid) return { success: false, reason: 'unresolvedEdges', area, diagnostics }
	const length = grid.width * grid.height
	const radius = Math.ceil(3 * resolved.smoothingSigma)
	if (grid.width <= 2 * (radius + 2) || grid.height <= 2 * (radius + 2)) return { success: false, reason: 'insufficientBackground', area, diagnostics }
	for (let y = 0, index = 0; y < grid.height; y++) {
		let raw = grid.rawStart + y * grid.rawRowStep
		for (let x = 0; x < grid.width; x++, index++, raw += grid.rawColumnStep) {
			const value = image.raw[raw]
			const mask = !Number.isFinite(value) ? 1 : resolved.saturationLevel !== undefined && value >= resolved.saturationLevel ? 2 : 0
			workspace.plane[index] = mask ? 0 : value
			workspace.mask[index] = mask
			workspace.validity[index] = mask ? 0 : 1
		}
	}
	const metadata: ImageMetadata = { width: grid.width, height: grid.height, pixelCount: length, stride: grid.width, channels: 1, bayer: undefined, strideInBytes: grid.width * image.raw.BYTES_PER_ELEMENT, pixelSizeInBytes: image.raw.BYTES_PER_ELEMENT, bitpix: precision === 64 ? -64 : -32 }
	const center = {
		x: ((input.center?.x ?? (area.left + area.right - 1) / 2) - grid.sourceLeft) / grid.step,
		y: ((input.center?.y ?? (area.top + area.bottom - 1) / 2) - grid.sourceTop) / grid.step,
	}
	const background = fitBackground(workspace, grid.width, grid.height, radius + 2)
	if (!background) return { success: false, reason: 'insufficientBackground', area, diagnostics }
	const prepared: PreparedCollimation = { success: true, area, plane, grid, metadata, center, options: resolved, margin: radius + 2, workspace, background }
	if (workspace.cache.angularSamples !== resolved.angularSamples) {
		for (let i = 0; i < resolved.angularSamples; i++) {
			workspace.sin[i] = Math.sin((i * TAU) / resolved.angularSamples)
			workspace.cos[i] = Math.cos((i * TAU) / resolved.angularSamples)
		}
		workspace.cache.angularSamples = resolved.angularSamples
	}
	if (workspace.cache.sigma !== resolved.smoothingSigma) {
		const kernel = new Float64Array(2 * radius + 1)
		for (let i = -radius; i <= radius; i++) kernel[i + radius] = Math.exp(-0.5 * (i / resolved.smoothingSigma) ** 2)
		workspace.cache.kernel = radius > 0 ? separableSmoothingKernel(kernel) : undefined
		workspace.cache.sigma = resolved.smoothingSigma
	}
	dilateMask(workspace, grid.width, grid.height, radius)
	applyBackground(prepared)
	return prepared
}

// Refits strictly external background beyond a fitted outer ellipse in plane coordinates. On success
// replaces background and smoothed signal in the same workspace; on failure leaves both unchanged.
export function refineCollimationBackground(prepared: PreparedCollimation, outer: EllipseGeometry) {
	const background = fitBackground(prepared.workspace, prepared.grid.width, prepared.grid.height, prepared.margin + 4, outer)
	if (!background) return false
	prepared.background = background
	applyBackground(prepared)
	return true
}

// Robust planar fit on peripheral (initial) or geometrically external support. At most 2048 regularly
// spaced samples are retained; each quadrant needs at least eight robust inliers and the design must
// have full rank. Pedestal subtraction preserves small Float64 differences before regression.
function fitBackground(workspace: CollimationWorkspace, width: number, height: number, margin: number, outer?: EllipseGeometry): CollimationBackground | undefined {
	const design: Float64Array[] = []
	const target: number[] = []
	const quadrants: number[] = []
	let stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / BACKGROUND_CAPACITY)))
	// Ceilings on narrow rectangles can exceed the population cap despite the area-based estimate.
	for (; stride < MAXIMUM_SIDE && Math.ceil(width / stride) * Math.ceil(height / stride) > BACKGROUND_CAPACITY; stride++) {}
	const border = Math.max(4, Math.floor(Math.min(width, height) * 0.12))
	const cos = Math.cos(outer?.theta ?? 0)
	const sin = Math.sin(outer?.theta ?? 0)
	const limit = outer ? (1 + margin / outer.semiMinor) ** 2 : 0
	workspace.statistics.reset()
	for (let y = 0; y < height; y += stride)
		for (let x = 0; x < width; x += stride) {
			if (workspace.mask[y * width + x]) continue
			if (outer) {
				const dx = x - outer.center.x
				const dy = y - outer.center.y
				if (((dx * cos + dy * sin) / outer.semiMajor) ** 2 + ((dy * cos - dx * sin) / outer.semiMinor) ** 2 <= limit) continue
			} else if (x >= border && y >= border && x < width - border && y < height - border) continue
			const value = workspace.plane[y * width + x]
			design.push(new Float64Array([1, x / (width - 1) - 0.5, y / (height - 1) - 0.5]))
			target.push(value)
			quadrants.push((x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2))
			workspace.statistics.push(value)
		}
	if (target.length < 48) return undefined
	const pedestal = workspace.statistics.median()
	for (let i = 0; i < target.length; i++) target[i] -= pedestal
	const fit = robustLinearLeastSquares(design, target, { method: 'tukey', tuning: 4.685, maxIterations: 8, tolerance: 1e-12 })
	if (fit.rankDeficient || !(fit.conditionNumber < 100)) return undefined
	const counts = [0, 0, 0, 0]
	workspace.statistics.reset()
	for (let i = 0; i < target.length; i++) {
		if (fit.weights[i] > 0.1) counts[quadrants[i]]++
		// MAD is already robust: clipping its population by fit weight would underestimate the noise.
		workspace.statistics.push(fit.residuals[i])
	}
	if (counts.some((count: number) => count < 8)) return undefined
	const coefficients: readonly [number, number, number] = [fit.coefficients[0], fit.coefficients[1], fit.coefficients[2]]
	if (!coefficients.every(Number.isFinite)) return undefined
	const level = pedestal + coefficients[0]
	if (!Number.isFinite(level)) return undefined
	const mad = workspace.statistics.mad(true, workspace.scratch)
	const rounding = (workspace.precision === 64 ? Number.EPSILON : 2 ** -23) * Math.abs(level) * 4
	return { pedestal, coefficients, level, noise: mad > rounding ? mad : undefined }
}

// Subtracts a fitted background without rectification and smooths masked signal and validity with
// separate backing buffers and exact active dimensions. Division does not restore missing support.
function applyBackground(prepared: PreparedCollimation): void {
	const { workspace: w, grid, background, metadata } = prepared
	const length = grid.width * grid.height
	const [b0, bx, by] = background.coefficients
	for (let y = 0, i = 0; y < grid.height; y++)
		for (let x = 0; x < grid.width; x++, i++) {
			w.signal[i] = w.mask[i] ? 0 : w.plane[i] - background.pedestal - (b0 + bx * (x / (grid.width - 1) - 0.5) + by * (y / (grid.height - 1) - 0.5))
		}
	const kernel = w.cache.kernel
	if (!kernel) {
		w.smoothed.set(w.signal.subarray(0, length))
		w.support.set(w.validity.subarray(0, length))
		return
	}
	separableSmoothing(w.signal.subarray(0, length), w.smoothed.subarray(0, length), w.temporary.subarray(0, length), metadata, kernel)
	separableSmoothing(w.validity.subarray(0, length), w.support.subarray(0, length), w.temporary.subarray(0, length), metadata, kernel)
	for (let i = 0; i < length; i++) w.smoothed[i] = w.support[i] > 0 ? w.smoothed[i] / w.support[i] : 0
}

// Propagates both original mask bits through the Gaussian's finite square support. Separable passes
// cost O(P*K); exact bits avoid accepting a tiny missing kernel weight rounded away by Float32.
function dilateMask(w: CollimationWorkspace, width: number, height: number, radius: number): void {
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			let bits = 0
			for (let dx = Math.max(0, x - radius); dx <= Math.min(width - 1, x + radius); dx++) bits |= w.mask[y * width + dx]
			w.horizontalMask[y * width + x] = bits
		}
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			let bits = 0
			for (let dy = Math.max(0, y - radius); dy <= Math.min(height - 1, y + radius); dy++) bits |= w.horizontalMask[dy * width + x]
			w.expandedMask[y * width + x] = bits
		}
}
