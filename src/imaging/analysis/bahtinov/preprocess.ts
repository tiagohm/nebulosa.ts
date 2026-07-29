import { PI, PIOVERTWO } from '../../../core/constants'
import { medianBySelectionOf, quickSelect, STANDARD_DEVIATION_SCALE } from '../../../core/util'
import type { Point, Rect } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'
import { channelIndex, grayscaleFromChannel, makeImageRawTypedArray, type Image, type ImageMetadata, type ImageRawType } from '../../model/types'
import { separableSmoothing, separableSmoothingKernel, type SeparableSmoothingKernel } from '../../processing/convolution'
import { DEFAULT_BAHTINOV_ANALYSIS_OPTIONS, type BahtinovAnalysisInput, type BahtinovAnalysisOptions, type BahtinovBackground, type BahtinovFailureReason, type BahtinovLine, type BahtinovPlane, type BahtinovRidgePoints, type BahtinovWorkspace, type BahtinovWorkspaceOptions } from './types'

// Bahtinov ROI extraction and preprocessing. The module converts normalized mono/RGB samples into
// one reusable mono plane, masks invalid/core/saturated support, computes a signed DoG response, and
// spatially samples ridge points without allocating buffers proportional to the ROI per analysis.

// Default square ROI side in pixels when only an approximate center is provided.
const DEFAULT_ROI_SIZE = 256
// Smallest ROI side that can support the initial kernels and three line segments.
const MINIMUM_ROI_SIDE = 16
// Maximum coarse angular samples retained across the four angle work arrays.
const MAXIMUM_HOUGH_ANGLE_COUNT = 65536
// Maximum normal-distance bins retained in the reusable accumulator.
const MAXIMUM_HOUGH_DISTANCE_BIN_COUNT = 1048576
// Connected saturated samples outside the initial core that indicate erased spike support.
const MINIMUM_CONNECTED_SATURATED_SPIKE_SAMPLES = 32
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
	// Approximate star center in local ROI pixel coordinates.
	readonly center: Readonly<Point>
	// Robust source-plane background estimate.
	readonly background: BahtinovBackground
	// Median signed DoG response over finite unmasked samples.
	readonly responseCenter: number
	// Normalized-MAD signed DoG scale.
	readonly responseDeviation: number
	// Minimum positive DoG response retained as a ridge.
	readonly threshold: number
	// Narrow Gaussian sigma applied to the transverse source profile, in pixels.
	readonly profileBlurSigma: number
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
	const maximumRidgePoints = options.maximumRidgePoints ?? Math.min(DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.maximumRidgePoints, pixelCount)
	if (!Number.isInteger(maximumRidgePoints) || maximumRidgePoints < 3 || maximumRidgePoints > pixelCount) throw new RangeError('maximumRidgePoints must be an integer from 3 to width * height')
	const angleStep = options.angleStep ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.angleStep
	const distanceStep = options.distanceStep ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.distanceStep
	if (!Number.isFinite(angleStep) || angleStep <= 0 || angleStep > PIOVERTWO) throw new RangeError('angleStep must be finite and in (0, PI / 2]')
	if (!Number.isFinite(distanceStep) || distanceStep <= 0) throw new RangeError('distanceStep must be finite and positive')

	const angleCount = Math.ceil(PI / angleStep)
	if (angleCount < 3) throw new RangeError('angleStep must produce at least three Hough angle bins')
	if (!Number.isSafeInteger(angleCount) || angleCount > MAXIMUM_HOUGH_ANGLE_COUNT) throw new RangeError(`Bahtinov angle grid must not exceed ${MAXIMUM_HOUGH_ANGLE_COUNT} samples`)
	const rhoMax = Math.hypot(width - 1, height - 1)
	const distanceBinCount = Math.ceil((2 * rhoMax) / distanceStep) + 1
	if (!Number.isSafeInteger(distanceBinCount) || distanceBinCount > MAXIMUM_HOUGH_DISTANCE_BIN_COUNT) throw new RangeError(`Bahtinov distance grid must not exceed ${MAXIMUM_HOUGH_DISTANCE_BIN_COUNT} bins`)

	const source = makeImageRawTypedArray(precision, pixelCount)
	const blurredLarge = makeImageRawTypedArray(source, pixelCount)
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
		blurredLarge,
		profile: blurredLarge,
		response: source,
		statistics: makeImageRawTypedArray(source, pixelCount),
		mask: new Uint8Array(pixelCount),
		coreQueue: new Uint32Array(pixelCount),
		cfaX: new Int32Array(width * 4),
		cfaY: new Int32Array(height * 4),
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
export function preprocessBahtinov(input: BahtinovAnalysisInput, workspace: BahtinovWorkspace, options: BahtinovAnalysisOptions = {}): BahtinovPreprocessResult {
	validateImageLayout(input.image)
	const area = resolveBahtinovArea(input)
	const width = area.right - area.left
	const height = area.bottom - area.top
	validateWorkspaceCapacity(workspace, width, height, options)
	const saturationLevel = options.saturationLevel ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.saturationLevel
	const saturationDilation = options.saturationDilation ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.saturationDilation
	const coreRadius = options.coreRadius ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.coreRadius
	const backgroundUpperQuantile = options.backgroundUpperQuantile ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.backgroundUpperQuantile
	const smallBlurSigma = options.smallBlurSigma ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.smallBlurSigma
	const largeBlurSigma = options.largeBlurSigma ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.largeBlurSigma
	const ridgeSigma = options.ridgeSigma ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.ridgeSigma
	validatePreprocessOptions(saturationLevel, saturationDilation, coreRadius, backgroundUpperQuantile, smallBlurSigma, largeBlurSigma, ridgeSigma)
	validateGaussianKernelSupport(smallBlurSigma, width, height, 'smallBlurSigma')
	validateGaussianKernelSupport(largeBlurSigma, width, height, 'largeBlurSigma')

	const plane = resolvePlane(input.image, options.plane ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.plane)
	if (!plane) return { success: false, reason: 'unsupportedPlane', area }

	const pixelCount = width * height
	const source = workspace.source.subarray(0, pixelCount)
	const mask = workspace.mask.subarray(0, pixelCount)
	mask.fill(0)
	const finiteCount = fillSourcePlane(input.image, area, plane, saturationLevel, source, mask, workspace)
	if (finiteCount < Math.max(16, pixelCount >>> 3)) return { success: false, reason: 'insufficientSupport', area }

	let saturatedCount = 0
	for (let index = 0; index < pixelCount; index++) {
		if ((mask[index] & MASK_INVALID) === 0 && (source[index] >= saturationLevel || (mask[index] & MASK_SATURATED) !== 0)) {
			mask[index] |= MASK_SATURATED
			saturatedCount++
		}
	}
	dilateSaturation(mask, width, height, saturationDilation, workspace.statistics)

	const centerX = input.center.x - area.left
	const centerY = input.center.y - area.top
	markCore(mask, width, height, centerX, centerY, coreRadius, options.autoCoreRadius ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.autoCoreRadius, workspace.coreQueue)
	let coreSaturated = false
	let spikeSaturatedCount = 0
	let connectedSpikeSaturatedCount = 0
	const coreRadiusSquared = coreRadius * coreRadius
	for (let index = 0; index < pixelCount; index++) {
		if ((mask[index] & MASK_SATURATED) === 0) continue
		const x = index % width
		const y = Math.floor(index / width)
		const dx = x - centerX
		const dy = y - centerY
		if ((mask[index] & MASK_CORE) !== 0) {
			coreSaturated = true
			if (dx * dx + dy * dy >= coreRadiusSquared) connectedSpikeSaturatedCount++
		} else spikeSaturatedCount++
	}
	if (connectedSpikeSaturatedCount >= MINIMUM_CONNECTED_SATURATED_SPIKE_SAMPLES) return { success: false, reason: 'saturated', area }

	const background = estimateBackground(source, mask, workspace.statistics, pixelCount, backgroundUpperQuantile)
	if (!background) return { success: false, reason: 'lowSignal', area }
	transformSource(source, mask, background.level, options.transform ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.transform)

	const kernels = resolveKernels(workspace, smallBlurSigma, largeBlurSigma)
	const metadata = roiMetadata(width, height, source.BYTES_PER_ELEMENT)
	const intermediate = workspace.intermediate.subarray(0, pixelCount)
	const blurredSmall = workspace.blurredSmall.subarray(0, pixelCount)
	const blurredLarge = workspace.blurredLarge.subarray(0, pixelCount)
	const response = workspace.response.subarray(0, pixelCount)
	const normalization = workspace.statistics.subarray(0, pixelCount)
	separableSmoothing(source, blurredSmall, intermediate, metadata, kernels.small)
	fillValidity(blurredLarge, mask)
	separableSmoothing(blurredLarge, normalization, intermediate, metadata, kernels.small)
	normalizeBlurredSupport(blurredSmall, normalization)
	separableSmoothing(source, blurredLarge, intermediate, metadata, kernels.large)
	fillValidity(response, mask)
	separableSmoothing(response, normalization, intermediate, metadata, kernels.large)
	normalizeBlurredSupport(blurredLarge, normalization)

	for (let index = 0; index < pixelCount; index++) response[index] = blurredSmall[index] - blurredLarge[index]
	const responseStatistics = estimateMedianAndDeviation(response, mask, workspace.statistics, pixelCount)
	if (!responseStatistics) return { success: false, reason: 'lowSignal', area }
	const threshold = Math.max(0, responseStatistics.center + ridgeSigma * responseStatistics.deviation)
	const maximumRidgePoints = Math.min(options.maximumRidgePoints ?? workspace.maximumRidgePoints, workspace.maximumRidgePoints)
	const ridgePoints = selectRidgePoints(response, mask, width, height, threshold, maximumRidgePoints, workspace)
	if (ridgePoints.count < 3) return { success: false, reason: 'insufficientSupport', area }
	prepareLinearProfile(input.image, area, plane, saturationLevel, background.level, mask, metadata, kernels.small, workspace)

	let retainedCount = 0
	for (let index = 0; index < pixelCount; index++) if (mask[index] === 0) retainedCount++
	return {
		success: true,
		area,
		center: { x: centerX, y: centerY },
		background,
		responseCenter: responseStatistics.center,
		responseDeviation: responseStatistics.deviation,
		threshold,
		profileBlurSigma: smallBlurSigma,
		saturationFraction: saturatedCount / finiteCount,
		coreSaturated,
		spikeSaturationFraction: spikeSaturatedCount / finiteCount,
		retainedFraction: retainedCount / pixelCount,
		ridgePoints,
		workspace,
	}
}

// Rebuilds the background-subtracted linear narrow-blur profile after DoG ridge extraction.
// The wide-blur buffer is reused because its transformed response is no longer needed.
function prepareLinearProfile(image: Image, area: Readonly<Rect>, plane: ResolvedBahtinovPlane, saturationLevel: number, background: number, mask: Uint8Array, metadata: ImageMetadata, kernel: SeparableSmoothingKernel, workspace: BahtinovWorkspace): void {
	const pixelCount = metadata.pixelCount
	const source = workspace.blurredSmall.subarray(0, pixelCount)
	const profile = workspace.profile.subarray(0, pixelCount)
	const intermediate = workspace.intermediate.subarray(0, pixelCount)
	const normalization = workspace.statistics.subarray(0, pixelCount)
	fillSourcePlane(image, area, plane, saturationLevel, source, mask, workspace)
	transformSource(source, mask, background, 'linear')
	separableSmoothing(source, profile, intermediate, metadata, kernel)
	fillValidity(source, mask)
	separableSmoothing(source, normalization, intermediate, metadata, kernel)
	normalizeBlurredSupport(profile, normalization)
}

// Measures the clean longitudinal fraction of one selected spike's saturation-support band.
export function bahtinovLineSaturationRetention(line: BahtinovLine, preprocessed: BahtinovPreprocessSuccess): number {
	const first = line.segment[0]
	const second = line.segment[1]
	const deltaX = second.x - first.x
	const deltaY = second.y - first.y
	const segmentLength = Math.hypot(deltaX, deltaY)
	if (!(segmentLength > 0) || !Number.isFinite(segmentLength)) return 0
	const tangentX = deltaX / segmentLength
	const tangentY = deltaY / segmentLength
	const centerX = preprocessed.area.left + preprocessed.center.x
	const centerY = preprocessed.area.top + preprocessed.center.y
	const centerTangent = Math.max(0, Math.min(segmentLength, (centerX - first.x) * tangentX + (centerY - first.y) * tangentY))
	const supportLength = segmentLength * Math.max(0, Math.min(1, line.coverage))
	const firstTangent = Math.max(0, centerTangent - supportLength * 0.5)
	const lastTangent = Math.min(segmentLength, centerTangent + supportLength * 0.5)
	const sampleCount = Math.max(1, Math.ceil(lastTangent - firstTangent))
	const normalX = Math.cos(line.normalAngle)
	const normalY = Math.sin(line.normalAngle)
	const supportRadius = Math.max(1, Math.ceil(line.fwhm * 0.5))
	const width = preprocessed.area.right - preprocessed.area.left
	const height = preprocessed.area.bottom - preprocessed.area.top
	let retained = 0

	for (let sample = 0; sample <= sampleCount; sample++) {
		const tangent = firstTangent + ((lastTangent - firstTangent) * sample) / sampleCount
		const x = first.x + tangent * tangentX
		const y = first.y + tangent * tangentY
		let saturated = false
		for (let offset = -supportRadius; offset <= supportRadius; offset++) {
			const localX = Math.round(x + offset * normalX) - preprocessed.area.left
			const localY = Math.round(y + offset * normalY) - preprocessed.area.top
			if (localX < 0 || localX >= width || localY < 0 || localY >= height) continue
			if ((preprocessed.workspace.mask[localY * width + localX] & (MASK_SATURATED | MASK_DILATED)) !== 0) {
				saturated = true
				break
			}
		}
		if (!saturated) retained++
	}
	return retained / (sampleCount + 1)
}

// Writes a unit weight except where saturation masking removed source support.
function fillValidity(output: ImageRawType, mask: Uint8Array): void {
	for (let index = 0; index < output.length; index++) output[index] = (mask[index] & (MASK_SATURATED | MASK_DILATED)) === 0 ? 1 : 0
}

// Renormalizes a Gaussian result by its convolved valid-support weight.
function normalizeBlurredSupport(output: ImageRawType, normalization: ImageRawType): void {
	for (let index = 0; index < output.length; index++) {
		const weight = normalization[index]
		output[index] = weight > Number.EPSILON ? output[index] / weight : 0
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
	if (image.metadata.channels === 1 && image.metadata.bayer) {
		if (plane === 'auto' || plane === 'GRAY') return 'greenBoth'
		return plane === 'green1' || plane === 'green2' ? plane : undefined
	}
	if (image.metadata.channels === 1) return plane === 'auto' || plane === 'GRAY' ? 'GRAY' : undefined
	if (plane === 'green1' || plane === 'green2') return undefined
	return plane === 'auto' ? 'BT709' : plane
}

// Copies only the selected full-image ROI into a dense local mono plane.
function fillSourcePlane(image: Image, area: Readonly<Rect>, plane: ResolvedBahtinovPlane, saturationLevel: number, output: ImageRawType, mask: Uint8Array, workspace: BahtinovWorkspace): number {
	if (image.metadata.channels === 1 && image.metadata.bayer) return fillCfaGreenPlane(image, area, plane, saturationLevel, output, mask, workspace)
	if (plane === 'green1' || plane === 'green2' || plane === 'greenBoth') throw new RangeError('CFA green planes require Bayer metadata')
	const { channels, stride } = image.metadata
	const selectedChannel = channels === 3 && (plane === 'RED' || plane === 'GREEN' || plane === 'BLUE') ? channelIndex(plane) : -1
	const weights = channels === 3 && selectedChannel < 0 ? grayscaleFromChannel(plane) : undefined
	let target = 0
	let finiteCount = 0
	for (let y = area.top; y < area.bottom; y++) {
		let source = y * stride + area.left * channels
		for (let x = area.left; x < area.right; x++, target++, source += channels) {
			const value = channels === 1 ? image.raw[source] : selectedChannel >= 0 ? image.raw[source + selectedChannel] : image.raw[source] * weights!.red + image.raw[source + 1] * weights!.green + image.raw[source + 2] * weights!.blue
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
function fillCfaGreenPlane(image: Image, area: Readonly<Rect>, plane: ResolvedBahtinovPlane, saturationLevel: number, output: ImageRawType, mask: Uint8Array, workspace: BahtinovWorkspace): number {
	const offsets = CFA_GREEN_OFFSETS[image.metadata.bayer!]
	const { width, height, stride } = image.metadata
	const firstLastX = width - 1 < offsets[0][0] ? -1 : width - 1 - ((width - 1 - offsets[0][0]) & 1)
	const firstLastY = height - 1 < offsets[0][1] ? -1 : height - 1 - ((height - 1 - offsets[0][1]) & 1)
	const secondLastX = width - 1 < offsets[1][0] ? -1 : width - 1 - ((width - 1 - offsets[1][0]) & 1)
	const secondLastY = height - 1 < offsets[1][1] ? -1 : height - 1 - ((height - 1 - offsets[1][1]) & 1)
	const roiWidth = area.right - area.left
	const roiHeight = area.bottom - area.top
	fillCfaAxisNeighbors(workspace.cfaX, area.left, roiWidth, offsets[0][0], firstLastX, offsets[1][0], secondLastX)
	fillCfaAxisNeighbors(workspace.cfaY, area.top, roiHeight, offsets[0][1], firstLastY, offsets[1][1], secondLastY)
	const useFirst = plane !== 'green2'
	const useSecond = plane !== 'green1'
	let target = 0
	let finiteCount = 0
	for (let localY = 0; localY < roiHeight; localY++) {
		const yBounds = localY * 4
		const firstLowerY = workspace.cfaY[yBounds]
		const firstUpperY = workspace.cfaY[yBounds + 1]
		const secondLowerY = workspace.cfaY[yBounds + 2]
		const secondUpperY = workspace.cfaY[yBounds + 3]
		for (let localX = 0; localX < roiWidth; localX++, target++) {
			const xBounds = localX * 4
			const firstLowerX = workspace.cfaX[xBounds]
			const firstUpperX = workspace.cfaX[xBounds + 1]
			const secondLowerX = workspace.cfaX[xBounds + 2]
			const secondUpperX = workspace.cfaX[xBounds + 3]
			const first = useFirst ? interpolateCfaLattice(image.raw, stride, firstLowerX, firstUpperX, firstLowerY, firstUpperY) : Number.NaN
			const second = useSecond ? interpolateCfaLattice(image.raw, stride, secondLowerX, secondUpperX, secondLowerY, secondUpperY) : Number.NaN
			const value = useFirst && useSecond ? (Number.isFinite(first) && Number.isFinite(second) ? Math.sqrt(Math.max(0, first) * Math.max(0, second)) : Number.NaN) : useFirst ? first : second
			if (Number.isFinite(value)) {
				output[target] = value
				if ((useFirst && cfaLatticeAtOrAbove(image.raw, stride, firstLowerX, firstUpperX, firstLowerY, firstUpperY, saturationLevel)) || (useSecond && cfaLatticeAtOrAbove(image.raw, stride, secondLowerX, secondUpperX, secondLowerY, secondUpperY, saturationLevel))) mask[target] |= MASK_SATURATED
				finiteCount++
			} else {
				output[target] = 0
				mask[target] |= MASK_INVALID
			}
		}
	}
	return finiteCount
}

// Reports whether any finite native sample contributing to one CFA interpolation reaches a threshold.
function cfaLatticeAtOrAbove(raw: ImageRawType, stride: number, lowerX: number, upperX: number, lowerY: number, upperY: number, threshold: number): boolean {
	if (lowerX < 0 || lowerY < 0) return false
	const topLeft = raw[lowerY * stride + lowerX]
	if (Number.isFinite(topLeft) && topLeft >= threshold) return true
	if (upperX !== lowerX) {
		const topRight = raw[lowerY * stride + upperX]
		if (Number.isFinite(topRight) && topRight >= threshold) return true
	}
	if (upperY !== lowerY) {
		const bottomLeft = raw[upperY * stride + lowerX]
		if (Number.isFinite(bottomLeft) && bottomLeft >= threshold) return true
		if (upperX !== lowerX) {
			const bottomRight = raw[upperY * stride + upperX]
			if (Number.isFinite(bottomRight) && bottomRight >= threshold) return true
		}
	}
	return false
}

// Pre-resolves lower and upper sensor coordinates for both period-two CFA lattices on one ROI axis.
function fillCfaAxisNeighbors(output: Int32Array, origin: number, count: number, firstOffset: number, firstLast: number, secondOffset: number, secondLast: number): void {
	for (let index = 0; index < count; index++) {
		const coordinate = origin + index
		const target = index * 4
		fillCfaAxisBounds(output, target, coordinate, firstOffset, firstLast)
		fillCfaAxisBounds(output, target + 2, coordinate, secondOffset, secondLast)
	}
}

// Stores the clamped nearest lattice coordinates for one sensor-axis position.
function fillCfaAxisBounds(output: Int32Array, target: number, coordinate: number, offset: number, last: number): void {
	if (last < offset) {
		output[target] = -1
		output[target + 1] = -1
	} else if ((coordinate & 1) === offset) {
		output[target] = coordinate
		output[target + 1] = coordinate
	} else if (coordinate < offset) {
		output[target] = offset
		output[target + 1] = offset
	} else if (coordinate > last) {
		output[target] = last
		output[target + 1] = last
	} else {
		output[target] = coordinate - 1
		output[target + 1] = coordinate + 1
	}
}

// Interpolates one CFA lattice from pre-resolved x and y neighbor bounds.
function interpolateCfaLattice(raw: ImageRawType, stride: number, lowerX: number, upperX: number, lowerY: number, upperY: number): number {
	if (lowerX < 0 || lowerY < 0) return Number.NaN
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

// Bounds a three-sigma Gaussian radius to safe integer support no larger than the active ROI.
function validateGaussianKernelSupport(sigma: number, width: number, height: number, name: string): void {
	const radius = Math.ceil(sigma * 3)
	const maximumRadius = Math.max(width, height) - 1
	if (!Number.isSafeInteger(radius) || radius < 1 || radius > maximumRadius || !Number.isSafeInteger(radius * 2 + 1)) throw new RangeError(`${name} produces Gaussian support larger than the active ROI`)
}

// Ensures one reusable workspace can represent the requested ROI and search settings.
function validateWorkspaceCapacity(workspace: BahtinovWorkspace, width: number, height: number, options: BahtinovAnalysisOptions): void {
	if (width > workspace.width || height > workspace.height) throw new RangeError('Bahtinov workspace is smaller than the resolved ROI')
	if (workspace.coreQueue.length < width * height) throw new RangeError('Bahtinov workspace core queue is smaller than the resolved ROI')
	const maximumRidgePoints = options.maximumRidgePoints ?? workspace.maximumRidgePoints
	if (!Number.isInteger(maximumRidgePoints) || maximumRidgePoints < 3 || maximumRidgePoints > workspace.maximumRidgePoints) throw new RangeError('maximumRidgePoints must be an integer from 3 to the workspace ridge capacity')
	if (options.angleStep !== undefined && options.angleStep !== workspace.angleStep) throw new RangeError('Bahtinov analysis angleStep must match the workspace grid')
	if (options.distanceStep !== undefined && options.distanceStep !== workspace.distanceStep) throw new RangeError('Bahtinov analysis distanceStep must match the workspace grid')
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
function markCore(mask: Uint8Array, width: number, height: number, centerX: number, centerY: number, radius: number, autoExpand: boolean, queue: Uint32Array): void {
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
function queueConnectedCore(index: number, mask: Uint8Array, queue: Uint32Array, queueLength: number): boolean {
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
	const columns = Math.max(1, Math.min(width, maximumPoints, Math.floor(Math.sqrt((maximumPoints * width) / height))))
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
