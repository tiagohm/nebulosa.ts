import { PI, PIOVERTWO } from '../../../core/constants'
import { medianBySelectionOf, quickSelect, STANDARD_DEVIATION_SCALE } from '../../../core/util'
import type { Rect } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'
import { grayscaleFromChannel, makeImageRawTypedArray, type Image, type ImageMetadata, type ImageRawType } from '../../model/types'
import { separableSmoothing, separableSmoothingKernel, type SeparableSmoothingKernel } from '../../processing/convolution'
import type { BahtinovAnalysisInput, BahtinovAnalysisOptions, BahtinovBackground, BahtinovFailureReason, BahtinovPlane, BahtinovRidgePoints, BahtinovWorkspace, BahtinovWorkspaceOptions } from './types'

// Bahtinov ROI extraction and preprocessing. The module converts normalized mono/RGB samples into
// one reusable mono plane, masks invalid/core/saturated support, computes a signed DoG response, and
// spatially samples ridge points without allocating buffers proportional to the ROI per analysis.

// Default square ROI side in pixels when only an approximate center is provided.
const DEFAULT_ROI_SIZE = 256
// Smallest ROI side that can support the initial kernels and three line segments.
const MINIMUM_ROI_SIDE = 16
// Default upper quantile retained for robust background statistics.
const DEFAULT_BACKGROUND_UPPER_QUANTILE = 0.8
// Default normalized source level considered saturated.
const DEFAULT_SATURATION_LEVEL = 0.995
// Default saturation-mask dilation in pixels.
const DEFAULT_SATURATION_DILATION = 1
// Default circular exclusion radius around the approximate star center, in pixels.
const DEFAULT_CORE_RADIUS = 6
// Default narrow Gaussian sigma in pixels.
const DEFAULT_SMALL_BLUR_SIGMA = 1
// Default wide Gaussian sigma in pixels.
const DEFAULT_LARGE_BLUR_SIGMA = 4
// Default signed-DoG threshold in robust sigma units.
const DEFAULT_RIDGE_SIGMA = 3
// Default maximum ridge-point capacity.
const DEFAULT_MAXIMUM_RIDGE_POINTS = 4096
// Default coarse Hough angle step in radians.
const DEFAULT_ANGLE_STEP = PI / 180
// Default Hough normal-distance bin size in pixels.
const DEFAULT_DISTANCE_STEP = 0.5
// Saturated source sample bit in the reusable mask.
const MASK_SATURATED = 1
// Dilated saturation-support bit in the reusable mask.
const MASK_DILATED = 2
// Connected or initial stellar-core bit in the reusable mask.
const MASK_CORE = 4
// Non-finite source sample bit in the reusable mask.
const MASK_INVALID = 8

// Cached small kernels associated weakly with reusable workspaces.
const WORKSPACE_KERNELS = new WeakMap<BahtinovWorkspace, BahtinovKernelCache>()

// Resolved finite preprocessing output backed by one caller-owned workspace.
export interface BahtinovPreprocessSuccess {
	// Success discriminator.
	readonly success: true
	// Resolved half-open ROI in full-image coordinates.
	readonly area: Readonly<Rect>
	// Robust source-plane background estimate.
	readonly background: BahtinovBackground
	// Median signed DoG response over finite unmasked samples.
	readonly responseCenter: number
	// Normalized-MAD signed DoG scale.
	readonly responseDeviation: number
	// Minimum positive DoG response retained as a ridge.
	readonly threshold: number
	// Fraction of finite ROI samples at or above the saturation level.
	readonly saturationFraction: number
	// Whether an original saturated sample belongs to the connected or initial stellar core.
	readonly coreSaturated: boolean
	// Fraction of finite ROI samples saturated outside the core mask.
	readonly spikeSaturationFraction: number
	// Fraction of ROI samples remaining finite and unmasked.
	readonly retainedFraction: number
	// Local spatially sampled ridge points backed by the workspace.
	readonly ridgePoints: BahtinovRidgePoints
	// Workspace containing the extracted plane, response, mask, and ridge arrays.
	readonly workspace: BahtinovWorkspace
}

// Content-level preprocessing failure with the resolved ROI when available.
export interface BahtinovPreprocessFailure {
	// Failure discriminator.
	readonly success: false
	// Stable content-level failure reason.
	readonly reason: BahtinovFailureReason
	// Resolved half-open ROI when resolution succeeded.
	readonly area?: Readonly<Rect>
}

// Discriminated result of ROI extraction and signed-ridge preprocessing.
export type BahtinovPreprocessResult = BahtinovPreprocessSuccess | BahtinovPreprocessFailure

// Small Gaussian kernels cached per reusable workspace and sigma pair.
interface BahtinovKernelCache {
	// Narrow Gaussian sigma in pixels.
	readonly smallSigma: number
	// Wide Gaussian sigma in pixels.
	readonly largeSigma: number
	// Narrow normalized separable kernel.
	readonly small: SeparableSmoothingKernel
	// Wide normalized separable kernel.
	readonly large: SeparableSmoothingKernel
}

// Resolved mono, RGB, or reconstructed CFA plane used by ROI extraction.
type ResolvedBahtinovPlane = Exclude<BahtinovPlane, 'auto'> | 'greenBoth'

// Allocates reusable buffers and Hough capacity for a maximum ROI.
// Dimensions are pixels, `angleStep` is radians, and `distanceStep` is pixels.
export function createBahtinovWorkspace(width: number, height: number, options: BahtinovWorkspaceOptions = {}): BahtinovWorkspace {
	if (!Number.isInteger(width) || width < MINIMUM_ROI_SIDE) throw new RangeError(`width must be an integer at least ${MINIMUM_ROI_SIDE}`)
	if (!Number.isInteger(height) || height < MINIMUM_ROI_SIDE) throw new RangeError(`height must be an integer at least ${MINIMUM_ROI_SIDE}`)
	const precision = options.precision ?? 32
	if (precision !== 32 && precision !== 64) throw new RangeError('precision must be 32 or 64')
	const pixelCount = width * height
	const maximumRidgePoints = options.maximumRidgePoints ?? Math.min(DEFAULT_MAXIMUM_RIDGE_POINTS, pixelCount)
	if (!Number.isInteger(maximumRidgePoints) || maximumRidgePoints < 3 || maximumRidgePoints > pixelCount) throw new RangeError('maximumRidgePoints must be an integer from 3 to width * height')
	const angleStep = options.angleStep ?? DEFAULT_ANGLE_STEP
	const distanceStep = options.distanceStep ?? DEFAULT_DISTANCE_STEP
	if (!Number.isFinite(angleStep) || angleStep <= 0 || angleStep > PIOVERTWO) throw new RangeError('angleStep must be finite and in (0, PI / 2]')
	if (!Number.isFinite(distanceStep) || distanceStep <= 0) throw new RangeError('distanceStep must be finite and positive')

	const angleCount = Math.ceil(PI / angleStep)
	const rhoMax = Math.hypot(width - 1, height - 1)
	const distanceBinCount = Math.ceil((2 * rhoMax) / distanceStep) + 1
	if (!Number.isSafeInteger(distanceBinCount)) throw new RangeError('Bahtinov accumulator capacity is too large')

	const source = makeImageRawTypedArray(precision, pixelCount)
	return {
		width,
		height,
		maximumRidgePoints,
		angleStep,
		distanceStep,
		angleCount,
		distanceBinCount,
		rhoMax,
		source,
		intermediate: makeImageRawTypedArray(source, pixelCount),
		blurredSmall: makeImageRawTypedArray(source, pixelCount),
		blurredLarge: makeImageRawTypedArray(source, pixelCount),
		response: makeImageRawTypedArray(source, pixelCount),
		statistics: makeImageRawTypedArray(source, pixelCount),
		mask: new Uint8Array(pixelCount),
		ridgeX: new Float32Array(maximumRidgePoints),
		ridgeY: new Float32Array(maximumRidgePoints),
		ridgeWeight: new Float32Array(maximumRidgePoints),
		accumulator: new Float64Array(distanceBinCount),
		angleScore: new Float64Array(angleCount),
		angleDistance: new Float64Array(angleCount),
		angleSin: createAngleLookup(angleCount, angleStep, true),
		angleCos: createAngleLookup(angleCount, angleStep, false),
	}
}

// Resolves and validates the half-open full-image ROI for one analysis input.
// `defaultSize` is a positive integer side in pixels used when the input omits `size`.
export function resolveBahtinovArea(input: BahtinovAnalysisInput, defaultSize: number = DEFAULT_ROI_SIZE): Readonly<Rect> {
	const { width, height } = input.image.metadata
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new RangeError('image dimensions must be positive integers')
	if (!Number.isInteger(defaultSize) || defaultSize < MINIMUM_ROI_SIDE) throw new RangeError(`defaultSize must be an integer at least ${MINIMUM_ROI_SIDE}`)
	const center = input.center
	if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y) || center.x < 0 || center.x > width - 1 || center.y < 0 || center.y > height - 1) throw new RangeError('Bahtinov center must be finite and inside the image pixel-center domain')

	if (input.area) {
		const { left, top, right, bottom } = input.area
		if (!Number.isInteger(left) || !Number.isInteger(top) || !Number.isInteger(right) || !Number.isInteger(bottom)) throw new RangeError('Bahtinov area edges must be integers')
		if (left < 0 || top < 0 || right > width || bottom > height || right - left < MINIMUM_ROI_SIDE || bottom - top < MINIMUM_ROI_SIDE) throw new RangeError(`Bahtinov area must be in bounds and at least ${MINIMUM_ROI_SIDE} x ${MINIMUM_ROI_SIDE}`)
		validateCenterInArea(center.x, center.y, input.area)
		return { left, top, right, bottom }
	}

	const { x, y } = center
	const requestedSize = input.size ?? defaultSize
	if (!Number.isInteger(requestedSize) || requestedSize < MINIMUM_ROI_SIDE) throw new RangeError(`Bahtinov size must be an integer at least ${MINIMUM_ROI_SIDE}`)
	const side = Math.min(requestedSize, width, height)
	if (side < MINIMUM_ROI_SIDE) throw new RangeError('image is too small for a Bahtinov ROI')
	const left = Math.min(width - side, Math.max(0, Math.round(x - (side - 1) * 0.5)))
	const top = Math.min(height - side, Math.max(0, Math.round(y - (side - 1) * 0.5)))
	return { left, top, right: left + side, bottom: top + side }
}

// Extracts, masks, filters, and spatially samples one Bahtinov ROI.
// The result aliases reusable workspace arrays and remains valid only until that workspace is reused.
export function preprocessBahtinov(input: BahtinovAnalysisInput, options: BahtinovAnalysisOptions = {}): BahtinovPreprocessResult {
	validateImageLayout(input.image)
	const area = resolveBahtinovArea(input)
	const width = area.right - area.left
	const height = area.bottom - area.top
	const workspace = options.workspace ?? createBahtinovWorkspace(width, height, { precision: input.image.raw.BYTES_PER_ELEMENT === 8 ? 64 : 32, maximumRidgePoints: Math.min(options.maximumRidgePoints ?? DEFAULT_MAXIMUM_RIDGE_POINTS, width * height), angleStep: options.angleStep, distanceStep: options.distanceStep })
	validateWorkspaceCapacity(workspace, width, height, options)

	const plane = resolvePlane(input.image, options.plane ?? 'auto')
	if (!plane) return { success: false, reason: 'unsupportedPlane', area }

	const pixelCount = width * height
	const source = workspace.source.subarray(0, pixelCount)
	const mask = workspace.mask.subarray(0, pixelCount)
	mask.fill(0)
	const finiteCount = fillSourcePlane(input.image, area, plane, source, mask)
	if (finiteCount < Math.max(16, pixelCount >>> 3)) return { success: false, reason: 'insufficientSupport', area }

	const saturationLevel = options.saturationLevel ?? DEFAULT_SATURATION_LEVEL
	const saturationDilation = options.saturationDilation ?? DEFAULT_SATURATION_DILATION
	const coreRadius = options.coreRadius ?? DEFAULT_CORE_RADIUS
	const backgroundUpperQuantile = options.backgroundUpperQuantile ?? DEFAULT_BACKGROUND_UPPER_QUANTILE
	const smallBlurSigma = options.smallBlurSigma ?? DEFAULT_SMALL_BLUR_SIGMA
	const largeBlurSigma = options.largeBlurSigma ?? DEFAULT_LARGE_BLUR_SIGMA
	const ridgeSigma = options.ridgeSigma ?? DEFAULT_RIDGE_SIGMA
	validatePreprocessOptions(saturationLevel, saturationDilation, coreRadius, backgroundUpperQuantile, smallBlurSigma, largeBlurSigma, ridgeSigma)

	let saturatedCount = 0
	for (let index = 0; index < pixelCount; index++) {
		if ((mask[index] & MASK_INVALID) === 0 && source[index] >= saturationLevel) {
			mask[index] |= MASK_SATURATED
			saturatedCount++
		}
	}
	dilateSaturation(mask, width, height, saturationDilation, workspace.statistics)

	const centerX = input.center.x - area.left
	const centerY = input.center.y - area.top
	markCore(mask, width, height, centerX, centerY, coreRadius, options.autoCoreRadius !== false, workspace.statistics)
	let coreSaturated = false
	let spikeSaturatedCount = 0
	for (let index = 0; index < pixelCount; index++) {
		if ((mask[index] & MASK_SATURATED) === 0) continue
		if ((mask[index] & MASK_CORE) !== 0) coreSaturated = true
		else spikeSaturatedCount++
	}

	const background = estimateBackground(source, mask, workspace.statistics, pixelCount, backgroundUpperQuantile)
	if (!background) return { success: false, reason: 'lowSignal', area }
	transformSource(source, mask, background.level, options.transform ?? 'sqrt')

	const kernels = resolveKernels(workspace, smallBlurSigma, largeBlurSigma)
	const metadata = roiMetadata(width, height, source.BYTES_PER_ELEMENT)
	const intermediate = workspace.intermediate.subarray(0, pixelCount)
	const blurredSmall = workspace.blurredSmall.subarray(0, pixelCount)
	const blurredLarge = workspace.blurredLarge.subarray(0, pixelCount)
	const response = workspace.response.subarray(0, pixelCount)
	separableSmoothing(source, blurredSmall, intermediate, metadata, kernels.small)
	separableSmoothing(source, blurredLarge, intermediate, metadata, kernels.large)

	for (let index = 0; index < pixelCount; index++) response[index] = blurredSmall[index] - blurredLarge[index]
	const responseStatistics = estimateMedianAndDeviation(response, mask, workspace.statistics, pixelCount)
	if (!responseStatistics) return { success: false, reason: 'lowSignal', area }
	const threshold = Math.max(0, responseStatistics.center + ridgeSigma * responseStatistics.deviation)
	const maximumRidgePoints = Math.min(options.maximumRidgePoints ?? workspace.maximumRidgePoints, workspace.maximumRidgePoints)
	const ridgePoints = selectRidgePoints(response, mask, width, height, threshold, maximumRidgePoints, workspace)
	if (ridgePoints.count < 3) return { success: false, reason: 'insufficientSupport', area }

	let retainedCount = 0
	for (let index = 0; index < pixelCount; index++) if (mask[index] === 0) retainedCount++
	return {
		success: true,
		area,
		background,
		responseCenter: responseStatistics.center,
		responseDeviation: responseStatistics.deviation,
		threshold,
		saturationFraction: saturatedCount / finiteCount,
		coreSaturated,
		spikeSaturationFraction: spikeSaturatedCount / finiteCount,
		retainedFraction: retainedCount / pixelCount,
		ridgePoints,
		workspace,
	}
}

// Builds one sine or cosine lookup for coarse axial Hough angles.
function createAngleLookup(angleCount: number, angleStep: Angle, sine: boolean): Float64Array {
	const lookup = new Float64Array(angleCount)
	for (let index = 0; index < angleCount; index++) lookup[index] = sine ? Math.sin(index * angleStep) : Math.cos(index * angleStep)
	return lookup
}

// Validates normalized image storage before any buffer mutation.
function validateImageLayout(image: Image): void {
	if ((image as { sampleScale?: string }).sampleScale === 'digital') throw new TypeError('Bahtinov analysis requires a normalized Image')
	const { width, height, channels, stride, pixelCount } = image.metadata
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || (channels !== 1 && channels !== 3) || stride !== width * channels || pixelCount !== width * height || image.raw.length < stride * height) {
		throw new RangeError('invalid image layout for Bahtinov analysis')
	}
}

// Validates a finite center against one half-open ROI.
function validateCenterInArea(x: number, y: number, area: Readonly<Rect>): void {
	if (!Number.isFinite(x) || !Number.isFinite(y) || x < area.left || x > area.right - 1 || y < area.top || y > area.bottom - 1) throw new RangeError('Bahtinov center must be finite and inside the area pixel-center domain')
}

// Resolves a supported mono, RGB, or green-lattice CFA plane.
function resolvePlane(image: Image, plane: BahtinovPlane): ResolvedBahtinovPlane | undefined {
	if (image.metadata.bayer) {
		if (image.metadata.channels !== 1) return undefined
		if (plane === 'auto' || plane === 'GRAY') return 'greenBoth'
		return plane === 'green1' || plane === 'green2' ? plane : undefined
	}
	if (image.metadata.channels === 1) return plane === 'auto' || plane === 'GRAY' ? 'GRAY' : undefined
	if (plane === 'green1' || plane === 'green2' || plane === 'GRAY') return undefined
	return plane === 'auto' ? 'BT709' : plane
}

// Copies only the selected full-image ROI into a dense local mono plane.
function fillSourcePlane(image: Image, area: Readonly<Rect>, plane: ResolvedBahtinovPlane, output: ImageRawType, mask: Uint8Array): number {
	if (image.metadata.bayer) return fillCfaGreenPlane(image, area, plane, output, mask)
	if (plane === 'green1' || plane === 'green2' || plane === 'greenBoth') throw new RangeError('CFA green planes require Bayer metadata')
	const { channels, stride } = image.metadata
	const weights = channels === 3 ? grayscaleFromChannel(plane) : undefined
	let target = 0
	let finiteCount = 0
	for (let y = area.top; y < area.bottom; y++) {
		let source = y * stride + area.left * channels
		for (let x = area.left; x < area.right; x++, target++, source += channels) {
			const value = channels === 1 ? image.raw[source] : image.raw[source] * weights!.red + image.raw[source + 1] * weights!.green + image.raw[source + 2] * weights!.blue
			if (Number.isFinite(value)) {
				output[target] = value
				finiteCount++
			} else {
				output[target] = 0
				mask[target] |= MASK_INVALID
			}
		}
	}
	return finiteCount
}

// Row-major `(x, y)` offsets of the two green samples in one CFA `2 x 2` tile.
const CFA_GREEN_OFFSETS = {
	RGGB: [
		[1, 0],
		[0, 1],
	],
	BGGR: [
		[1, 0],
		[0, 1],
	],
	GBRG: [
		[0, 0],
		[1, 1],
	],
	GRBG: [
		[0, 0],
		[1, 1],
	],
	GRGB: [
		[0, 0],
		[0, 1],
	],
	GBGR: [
		[0, 0],
		[0, 1],
	],
	RGBG: [
		[1, 0],
		[1, 1],
	],
	BGRG: [
		[1, 0],
		[1, 1],
	],
} as const

// Reconstructs one or both physical green sublattices densely over the full-resolution sensor ROI.
function fillCfaGreenPlane(image: Image, area: Readonly<Rect>, plane: ResolvedBahtinovPlane, output: ImageRawType, mask: Uint8Array): number {
	const offsets = CFA_GREEN_OFFSETS[image.metadata.bayer!]
	const { width, height, stride } = image.metadata
	const firstLastX = width - 1 < offsets[0][0] ? -1 : width - 1 - ((width - 1 - offsets[0][0]) & 1)
	const firstLastY = height - 1 < offsets[0][1] ? -1 : height - 1 - ((height - 1 - offsets[0][1]) & 1)
	const secondLastX = width - 1 < offsets[1][0] ? -1 : width - 1 - ((width - 1 - offsets[1][0]) & 1)
	const secondLastY = height - 1 < offsets[1][1] ? -1 : height - 1 - ((height - 1 - offsets[1][1]) & 1)
	const useFirst = plane !== 'green2'
	const useSecond = plane !== 'green1'
	let target = 0
	let finiteCount = 0
	for (let y = area.top; y < area.bottom; y++) {
		for (let x = area.left; x < area.right; x++, target++) {
			const first = useFirst ? interpolateCfaLattice(image.raw, stride, x, y, offsets[0][0], offsets[0][1], firstLastX, firstLastY) : Number.NaN
			const second = useSecond ? interpolateCfaLattice(image.raw, stride, x, y, offsets[1][0], offsets[1][1], secondLastX, secondLastY) : Number.NaN
			const value = useFirst && useSecond ? (Number.isFinite(first) && Number.isFinite(second) ? Math.sqrt(Math.max(0, first) * Math.max(0, second)) : Number.NaN) : useFirst ? first : second
			if (Number.isFinite(value)) {
				output[target] = value
				finiteCount++
			} else {
				output[target] = 0
				mask[target] |= MASK_INVALID
			}
		}
	}
	return finiteCount
}

// Interpolates one period-two CFA lattice using only parity-selected nearest samples.
function interpolateCfaLattice(raw: ImageRawType, stride: number, x: number, y: number, offsetX: number, offsetY: number, lastX: number, lastY: number): number {
	if (lastX < offsetX || lastY < offsetY) return Number.NaN
	let lowerX: number
	let upperX: number
	if ((x & 1) === offsetX) lowerX = upperX = x
	else if (x < offsetX) lowerX = upperX = offsetX
	else if (x > lastX) lowerX = upperX = lastX
	else {
		lowerX = x - 1
		upperX = x + 1
	}
	let lowerY: number
	let upperY: number
	if ((y & 1) === offsetY) lowerY = upperY = y
	else if (y < offsetY) lowerY = upperY = offsetY
	else if (y > lastY) lowerY = upperY = lastY
	else {
		lowerY = y - 1
		upperY = y + 1
	}

	let sum = 0
	let count = 0
	const topLeft = raw[lowerY * stride + lowerX]
	if (Number.isFinite(topLeft)) {
		sum += topLeft
		count++
	}
	if (upperX !== lowerX) {
		const topRight = raw[lowerY * stride + upperX]
		if (Number.isFinite(topRight)) {
			sum += topRight
			count++
		}
	}
	if (upperY !== lowerY) {
		const bottomLeft = raw[upperY * stride + lowerX]
		if (Number.isFinite(bottomLeft)) {
			sum += bottomLeft
			count++
		}
		if (upperX !== lowerX) {
			const bottomRight = raw[upperY * stride + upperX]
			if (Number.isFinite(bottomRight)) {
				sum += bottomRight
				count++
			}
		}
	}
	return count > 0 ? sum / count : Number.NaN
}

// Validates preprocessing thresholds whose relationships affect finite filtering.
function validatePreprocessOptions(saturationLevel: number, saturationDilation: number, coreRadius: number, backgroundUpperQuantile: number, smallBlurSigma: number, largeBlurSigma: number, ridgeSigma: number): void {
	if (!Number.isFinite(saturationLevel) || saturationLevel <= 0 || saturationLevel > 1) throw new RangeError('saturationLevel must be in (0, 1]')
	if (!Number.isInteger(saturationDilation) || saturationDilation < 0) throw new RangeError('saturationDilation must be a non-negative integer')
	if (!Number.isFinite(coreRadius) || coreRadius < 0) throw new RangeError('coreRadius must be finite and non-negative')
	if (!Number.isFinite(backgroundUpperQuantile) || backgroundUpperQuantile <= 0 || backgroundUpperQuantile > 1) throw new RangeError('backgroundUpperQuantile must be in (0, 1]')
	if (!Number.isFinite(smallBlurSigma) || !Number.isFinite(largeBlurSigma) || smallBlurSigma <= 0 || largeBlurSigma <= smallBlurSigma) throw new RangeError('blur sigmas must satisfy largeBlurSigma > smallBlurSigma > 0')
	if (!Number.isFinite(ridgeSigma) || ridgeSigma <= 0) throw new RangeError('ridgeSigma must be finite and positive')
}

// Ensures one reusable workspace can represent the requested ROI and search settings.
function validateWorkspaceCapacity(workspace: BahtinovWorkspace, width: number, height: number, options: BahtinovAnalysisOptions): void {
	if (width > workspace.width || height > workspace.height) throw new RangeError('Bahtinov workspace is smaller than the resolved ROI')
	if ((options.maximumRidgePoints ?? workspace.maximumRidgePoints) > workspace.maximumRidgePoints) throw new RangeError('Bahtinov workspace ridge capacity is too small')
	if ((options.angleStep ?? workspace.angleStep) < workspace.angleStep) throw new RangeError('Bahtinov workspace angular grid is too coarse')
	if ((options.distanceStep ?? workspace.distanceStep) < workspace.distanceStep) throw new RangeError('Bahtinov workspace distance grid is too coarse')
}

// Dilates original saturated samples with a separable square window in linear time.
function dilateSaturation(mask: Uint8Array, width: number, height: number, radius: number, scratch: ImageRawType): void {
	if (radius === 0) return
	const horizontalRadius = Math.min(radius, width - 1)
	const verticalRadius = Math.min(radius, height - 1)
	for (let y = 0; y < height; y++) {
		const row = y * width
		let saturated = 0
		for (let x = 0; x <= horizontalRadius; x++) {
			if ((mask[row + x] & MASK_SATURATED) !== 0) saturated++
		}
		for (let x = 0; x < width; x++) {
			scratch[row + x] = saturated > 0 ? 1 : 0
			const leaving = x - horizontalRadius
			if (leaving >= 0 && (mask[row + leaving] & MASK_SATURATED) !== 0) saturated--
			const entering = x + horizontalRadius + 1
			if (entering < width && (mask[row + entering] & MASK_SATURATED) !== 0) saturated++
		}
	}
	for (let x = 0; x < width; x++) {
		let saturated = 0
		for (let y = 0; y <= verticalRadius; y++) saturated += scratch[y * width + x]
		for (let y = 0; y < height; y++) {
			if (saturated > 0) mask[y * width + x] |= MASK_DILATED
			const leaving = y - verticalRadius
			if (leaving >= 0) saturated -= scratch[leaving * width + x]
			const entering = y + verticalRadius + 1
			if (entering < height) saturated += scratch[entering * width + x]
		}
	}
}

// Marks the initial circular core and optionally floods connected saturated support from it.
function markCore(mask: Uint8Array, width: number, height: number, centerX: number, centerY: number, radius: number, autoExpand: boolean, queue: ImageRawType): void {
	const radiusSquared = radius * radius
	let queueLength = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - centerX
			const dy = y - centerY
			if (dx * dx + dy * dy >= radiusSquared) continue
			const index = y * width + x
			mask[index] |= MASK_CORE
			if (autoExpand && (mask[index] & (MASK_SATURATED | MASK_DILATED)) !== 0) queue[queueLength++] = index
		}
	}
	if (!autoExpand) return

	for (let head = 0; head < queueLength; head++) {
		const index = queue[head]
		const x = index % width
		const y = Math.floor(index / width)
		if (x > 0) queueConnectedCore(index - 1, mask, queue, queueLength) && queueLength++
		if (x + 1 < width) queueConnectedCore(index + 1, mask, queue, queueLength) && queueLength++
		if (y > 0) queueConnectedCore(index - width, mask, queue, queueLength) && queueLength++
		if (y + 1 < height) queueConnectedCore(index + width, mask, queue, queueLength) && queueLength++
	}
}

// Marks and appends one not-yet-core saturated neighbor to the flood queue.
function queueConnectedCore(index: number, mask: Uint8Array, queue: ImageRawType, queueLength: number): boolean {
	if ((mask[index] & MASK_CORE) !== 0 || (mask[index] & (MASK_SATURATED | MASK_DILATED)) === 0) return false
	mask[index] |= MASK_CORE
	queue[queueLength] = index
	return true
}

// Estimates background median and normalized MAD from finite unmasked lower-quantile samples.
function estimateBackground(source: ImageRawType, mask: Uint8Array, scratch: ImageRawType, pixelCount: number, upperQuantile: number): BahtinovBackground | undefined {
	let count = copyEligibleSamples(source, mask, scratch, pixelCount, Number.POSITIVE_INFINITY)
	if (count < 8) return undefined
	const cutoff = selectedQuantile(scratch, count, upperQuantile)
	count = copyEligibleSamples(source, mask, scratch, pixelCount, cutoff)
	if (count < 8) return undefined
	const level = medianBySelectionOf(scratch, count)
	for (let index = 0; index < count; index++) scratch[index] = Math.abs(scratch[index] - level)
	const deviation = medianBySelectionOf(scratch, count) * STANDARD_DEVIATION_SCALE
	if (!Number.isFinite(level) || !Number.isFinite(deviation)) return undefined
	return { level, deviation, sampleCount: count }
}

// Copies finite unmasked source samples not exceeding one inclusive cutoff.
function copyEligibleSamples(source: ImageRawType, mask: Uint8Array, scratch: ImageRawType, pixelCount: number, cutoff: number): number {
	let count = 0
	for (let index = 0; index < pixelCount; index++) {
		const value = source[index]
		if (mask[index] === 0 && Number.isFinite(value) && value <= cutoff) scratch[count++] = value
	}
	return count
}

// Applies the resolved monotonic transform after subtracting the background pedestal.
function transformSource(source: ImageRawType, mask: Uint8Array, background: number, transform: NonNullable<BahtinovAnalysisOptions['transform']>): void {
	for (let index = 0; index < source.length; index++) {
		if (mask[index] !== 0) {
			source[index] = 0
			continue
		}
		const value = Math.max(0, source[index] - background)
		source[index] = transform === 'linear' ? value : transform === 'log' ? Math.log1p(value) : Math.sqrt(value)
	}
}

// Resolves or refreshes the small Gaussian kernels cached for one workspace.
function resolveKernels(workspace: BahtinovWorkspace, smallSigma: number, largeSigma: number): BahtinovKernelCache {
	const cached = WORKSPACE_KERNELS.get(workspace)
	if (cached?.smallSigma === smallSigma && cached.largeSigma === largeSigma) return cached
	const next = {
		smallSigma,
		largeSigma,
		small: gaussianSeparableKernel(smallSigma),
		large: gaussianSeparableKernel(largeSigma),
	}
	WORKSPACE_KERNELS.set(workspace, next)
	return next
}

// Builds one normalized odd Gaussian kernel truncated at three sigma.
function gaussianSeparableKernel(sigma: number): SeparableSmoothingKernel {
	const radius = Math.max(1, Math.ceil(sigma * 3))
	const weights = new Float64Array(radius * 2 + 1)
	const inverseTwoSigmaSquared = 0.5 / (sigma * sigma)
	for (let offset = -radius; offset <= radius; offset++) weights[offset + radius] = Math.exp(-(offset * offset) * inverseTwoSigmaSquared)
	return separableSmoothingKernel(weights)
}

// Builds dense one-channel metadata matching the active ROI buffer views.
function roiMetadata(width: number, height: number, bytesPerElement: number): ImageMetadata {
	return {
		width,
		height,
		channels: 1,
		stride: width,
		pixelCount: width * height,
		strideInBytes: width * bytesPerElement,
		pixelSizeInBytes: bytesPerElement,
		bitpix: bytesPerElement === 8 ? -64 : -32,
		bayer: undefined,
	}
}

// Estimates median and normalized MAD of the signed unmasked response.
function estimateMedianAndDeviation(response: ImageRawType, mask: Uint8Array, scratch: ImageRawType, pixelCount: number): { readonly center: number; readonly deviation: number } | undefined {
	const count = copyEligibleSamples(response, mask, scratch, pixelCount, Number.POSITIVE_INFINITY)
	if (count < 8) return undefined
	const center = medianBySelectionOf(scratch, count)
	for (let index = 0; index < count; index++) scratch[index] = Math.abs(scratch[index] - center)
	const deviation = medianBySelectionOf(scratch, count) * STANDARD_DEVIATION_SCALE
	if (!Number.isFinite(center) || !Number.isFinite(deviation)) return undefined
	return { center, deviation }
}

// Spatially keeps the strongest positive ridge response in each bounded grid cell.
function selectRidgePoints(response: ImageRawType, mask: Uint8Array, width: number, height: number, threshold: number, maximumPoints: number, workspace: BahtinovWorkspace): BahtinovRidgePoints {
	const columns = Math.max(1, Math.min(width, Math.floor(Math.sqrt((maximumPoints * width) / height))))
	const rows = Math.max(1, Math.min(height, Math.floor(maximumPoints / columns)))
	const cellCount = columns * rows
	workspace.ridgeWeight.fill(0, 0, cellCount)

	for (let y = 0; y < height; y++) {
		const cellY = Math.min(rows - 1, Math.floor((y * rows) / height))
		for (let x = 0; x < width; x++) {
			const index = y * width + x
			if (mask[index] !== 0) continue
			const excess = response[index] - threshold
			if (!(excess > 0)) continue
			const weight = Math.sqrt(excess)
			const cellX = Math.min(columns - 1, Math.floor((x * columns) / width))
			const cell = cellY * columns + cellX
			if (weight <= workspace.ridgeWeight[cell]) continue
			workspace.ridgeX[cell] = x
			workspace.ridgeY[cell] = y
			workspace.ridgeWeight[cell] = weight
		}
	}

	let count = 0
	for (let cell = 0; cell < cellCount; cell++) {
		const weight = workspace.ridgeWeight[cell]
		if (!(weight > 0)) continue
		workspace.ridgeX[count] = workspace.ridgeX[cell]
		workspace.ridgeY[count] = workspace.ridgeY[cell]
		workspace.ridgeWeight[count] = weight
		count++
	}
	return { x: workspace.ridgeX, y: workspace.ridgeY, weight: workspace.ridgeWeight, count }
}

// Selects one linearly interpolated quantile while rearranging only the active scratch prefix.
function selectedQuantile(values: ImageRawType, count: number, quantile: number): number {
	const position = (count - 1) * quantile
	const lower = Math.floor(position)
	const upper = Math.ceil(position)
	const fraction = position - lower
	const lowerValue = quickSelect(values, count, lower)
	if (lower === upper) return lowerValue
	const upperValue = quickSelect(values, count, upper)
	return lowerValue + (upperValue - lowerValue) * fraction
}
