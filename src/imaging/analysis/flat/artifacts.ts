import { STANDARD_DEVIATION_SCALE } from '../../../core/util'
import type { ImageMetadata } from '../../model/types'
import { gaussianBlurKernel, separableSmoothing, type SeparableSmoothingKernel } from '../../processing/convolution'
import { createScalarSurfaceEvaluator, createSurfaceColumnTable, type ScalarSurfaceModel } from '../../processing/surface'
import { resolveImagePlaneGeometry } from '../plane'
import { RobustReservoir } from '../robust'
import type { FlatSpatialInput } from './spatial'
import { DEFAULT_FLAT_DUST_DETECTION_OPTIONS, type FlatAxisProfile, type FlatDustCandidate, type FlatDustDetectionOptions, type FlatProfiles } from './types'

// Optional non-causal flat inspection. Profiles stream directly from the selected plane; smooth dark
// candidates use a bounded selected-plane grid, multiscale Difference of Gaussians, and connected
// moments in output image coordinates. Neither path changes flat acceptance.

// Maximum selected-plane cells retained by the optional full-grid artifact workspace.
const MAXIMUM_ARTIFACT_GRID_PIXELS = 2_097_152

// Maximum aspect ratio accepted as a compact smooth-depression candidate rather than a line.
const MAXIMUM_DUST_ASPECT_RATIO = 6

// Minimum normalized smoothing support accepted after edge and mask renormalization.
const MINIMUM_SMOOTHING_SUPPORT = 1e-6

// Five-tap one-dimensional Gaussian extracted from the existing normalized 2D kernel builder.
const ARTIFACT_GAUSSIAN_KERNEL = artifactGaussianKernel()

// Resolved caller or default settings for one dust-candidate pass.
interface ResolvedDustOptions {
	// Strictly increasing scales in output image pixels.
	readonly scales: readonly [number, number, number]
	// Minimum fractional attenuation.
	readonly minimumContrast: number
	// Minimum connected area in square output pixels.
	readonly minimumArea: number
	// Maximum retained candidates.
	readonly maximumCandidates: number
}

// Reduced selected-plane residual grid with image-coordinate lookup tables.
interface ArtifactGrid {
	// Mean residual per supported grid cell; unsupported cells are zero.
	readonly source: Float32Array
	// One for supported grid cells and zero otherwise.
	readonly support: Float32Array
	// Grid width.
	readonly width: number
	// Grid height.
	readonly height: number
	// Image X coordinate represented by each grid column.
	readonly x: Float64Array
	// Image Y coordinate represented by each grid row.
	readonly y: Float64Array
	// Approximate image-pixel spacing between adjacent grid cells.
	readonly spacing: number
}

// Mutable moment summary for one connected candidate component.
interface ComponentMoments {
	// Candidate grid-cell count.
	count: number
	// Sum of positive multiscale response weights.
	weight: number
	// Weighted first X moment.
	x: number
	// Weighted first Y moment.
	y: number
	// Weighted second X moment.
	xx: number
	// Weighted cross moment.
	xy: number
	// Weighted second Y moment.
	yy: number
	// Most negative residual in the component.
	minimumResidual: number
	// Inclusive grid bounds.
	minX: number
	maxX: number
	minY: number
	maxY: number
}

// Measures surface-detrended row and column profiles without allocating an image-sized residual.
export function measureFlatProfiles(input: FlatSpatialInput, model: ScalarSurfaceModel): FlatProfiles {
	const geometry = resolveImagePlaneGeometry(input.image, input.area, input.plane, input.cfaOffset)
	const referenceGeometry = input.reference ? resolveImagePlaneGeometry(input.reference, input.area, input.plane, input.referenceCfaOffset) : undefined
	const rowSums = new Float64Array(geometry.height)
	const columnSums = new Float64Array(geometry.width)
	const rowCounts = new Uint32Array(geometry.height)
	const columnCounts = new Uint32Array(geometry.width)
	const surfaceRow = new Float64Array(geometry.width)
	const columns = createSurfaceColumnTable(model.degree, model.domain, geometry.width, geometry.sourceLeft, geometry.step)
	const evaluator = createScalarSurfaceEvaluator(model, columns)

	for (let planeY = 0; planeY < geometry.height; planeY++) {
		const sourceY = geometry.sourceTop + planeY * geometry.step
		evaluator.fillRow(sourceY, surfaceRow, 0, 1)
		let rawIndex = geometry.rawStart + planeY * geometry.rawRowStep
		let referenceIndex = referenceGeometry ? referenceGeometry.rawStart + planeY * referenceGeometry.rawRowStep : 0
		let maskIndex = sourceY * input.image.metadata.width + geometry.sourceLeft
		for (let planeX = 0; planeX < geometry.width; planeX++, rawIndex += geometry.rawColumnStep, maskIndex += geometry.step) {
			if (!input.mask?.[maskIndex] && surfaceRow[planeX] > 0) {
				const observed = input.image.raw[rawIndex]
				const sample = referenceGeometry ? observed - input.reference!.raw[referenceIndex] : observed
				const residual = sample / surfaceRow[planeX] - 1
				if (Number.isFinite(residual)) {
					rowSums[planeY] += residual
					columnSums[planeX] += residual
					rowCounts[planeY]++
					columnCounts[planeX]++
				}
			}
			if (referenceGeometry) referenceIndex += referenceGeometry.rawColumnStep
		}
	}

	return { row: finishAxisProfile(rowSums, rowCounts), column: finishAxisProfile(columnSums, columnCounts) }
}

// Detects compact smooth dark candidates from one already materialized full-area residual and mask.
export function detectFlatDustCandidates(input: FlatSpatialInput, residual: Float32Array, validity: Uint8Array, configured: true | Partial<FlatDustDetectionOptions>): readonly FlatDustCandidate[] {
	const options = resolveDustOptions(configured === true ? {} : configured)
	const grid = buildArtifactGrid(input, residual, validity)
	if (grid.width < 3 || grid.height < 3) return []
	const length = grid.width * grid.height
	const metadata = artifactMetadata(grid.width, grid.height)
	const small = new Float32Array(length)
	const medium = new Float32Array(length)
	const large = new Float32Array(length)
	const intermediate = new Float32Array(length)
	const supportOutput = new Float32Array(length)
	const steps = resolveGridScales(options.scales, grid.spacing)
	normalizedSmooth(grid.source, grid.support, small, supportOutput, intermediate, metadata, steps[0])
	normalizedSmooth(grid.source, grid.support, medium, supportOutput, intermediate, metadata, steps[1])
	normalizedSmooth(grid.source, grid.support, large, supportOutput, intermediate, metadata, steps[2])

	const firstResponse = new RobustReservoir(length)
	const secondResponse = new RobustReservoir(length)
	for (let index = 0; index < length; index++) {
		small[index] = medium[index] - small[index]
		large[index] -= medium[index]
		if (grid.support[index] > 0) {
			firstResponse.push(small[index])
			secondResponse.push(large[index])
		}
	}
	const sigma = input.options.rejectionSigma ?? 4
	const firstThreshold = responseThreshold(firstResponse, sigma, options.minimumContrast)
	const secondThreshold = responseThreshold(secondResponse, sigma, options.minimumContrast)
	if (firstThreshold === undefined || secondThreshold === undefined) return []

	const candidate = new Uint8Array(length)
	let candidateCount = 0
	for (let index = 0; index < length; index++) {
		if (grid.support[index] > 0 && grid.source[index] <= -options.minimumContrast * 0.25 && small[index] > firstThreshold && large[index] > secondThreshold) {
			candidate[index] = 1
			candidateCount++
		}
	}
	if (candidateCount === 0) return []

	const queue = new Int32Array(candidateCount)
	const margin = (ARTIFACT_GAUSSIAN_KERNEL.kernel.length >>> 1) * steps[2]
	const candidates: FlatDustCandidate[] = []
	const retentionWindow = Math.max(1024, options.maximumCandidates * 2)
	for (let seed = 0; seed < length; seed++) {
		if (candidate[seed] === 0) continue
		const moments = collectComponent(seed, candidate, queue, grid, small, large)
		const resolved = resolveCandidate(moments, grid, margin, options)
		if (resolved) {
			candidates.push(resolved)
			if (candidates.length >= retentionWindow) {
				candidates.sort(compareDustCandidates)
				candidates.length = options.maximumCandidates
			}
		}
	}

	candidates.sort(compareDustCandidates)
	return candidates.slice(0, options.maximumCandidates)
}

// Converts supported row or column means into a finite public profile and bounded robust strength.
function finishAxisProfile(sums: Float64Array, counts: Uint32Array): FlatAxisProfile {
	const values = new Float32Array(sums.length)
	const validity = new Uint8Array(sums.length)
	const robust = new RobustReservoir(sums.length)
	for (let index = 0; index < sums.length; index++) {
		if (counts[index] === 0) continue
		const value = Math.fround(sums[index] / counts[index])
		if (!Number.isFinite(value)) continue
		values[index] = value
		validity[index] = 1
		robust.push(value)
	}
	const mad = robust.mad()
	const strength = Number.isFinite(mad) ? mad * STANDARD_DEVIATION_SCALE : undefined
	return { values, validity, strength, retainedSamples: robust.retainedCount, approximate: robust.approximate }
}

// Resolves optional dust settings after flat.ts has validated their domains.
function resolveDustOptions(options: Partial<FlatDustDetectionOptions>): ResolvedDustOptions {
	return {
		scales: options.scales ?? DEFAULT_FLAT_DUST_DETECTION_OPTIONS.scales,
		minimumContrast: options.minimumContrast ?? DEFAULT_FLAT_DUST_DETECTION_OPTIONS.minimumContrast,
		minimumArea: options.minimumArea ?? DEFAULT_FLAT_DUST_DETECTION_OPTIONS.minimumArea,
		maximumCandidates: options.maximumCandidates ?? DEFAULT_FLAT_DUST_DETECTION_OPTIONS.maximumCandidates,
	}
}

// Builds a bounded dense grid from valid selected-plane residual positions, averaging only on demand.
function buildArtifactGrid(input: FlatSpatialInput, residual: Float32Array, validity: Uint8Array): ArtifactGrid {
	const geometry = resolveImagePlaneGeometry(input.image, input.area, input.plane, input.cfaOffset)
	let reduction = Math.max(1, Math.ceil(Math.sqrt((geometry.width * geometry.height) / MAXIMUM_ARTIFACT_GRID_PIXELS)))
	while (Math.ceil(geometry.width / reduction) * Math.ceil(geometry.height / reduction) > MAXIMUM_ARTIFACT_GRID_PIXELS) reduction++
	const width = Math.ceil(geometry.width / reduction)
	const height = Math.ceil(geometry.height / reduction)
	const source = new Float32Array(width * height)
	const support = new Float32Array(width * height)
	const xCoordinates = new Float64Array(width)
	const yCoordinates = new Float64Array(height)
	const mapWidth = input.area.right - input.area.left

	for (let gridX = 0; gridX < width; gridX++) {
		const first = gridX * reduction
		const last = Math.min(geometry.width, first + reduction) - 1
		xCoordinates[gridX] = geometry.sourceLeft + ((first + last) * geometry.step) / 2
	}
	for (let gridY = 0; gridY < height; gridY++) {
		const first = gridY * reduction
		const last = Math.min(geometry.height, first + reduction) - 1
		yCoordinates[gridY] = geometry.sourceTop + ((first + last) * geometry.step) / 2
		for (let gridX = 0; gridX < width; gridX++) {
			const firstX = gridX * reduction
			const lastX = Math.min(geometry.width, firstX + reduction)
			const firstY = gridY * reduction
			const lastY = Math.min(geometry.height, firstY + reduction)
			let sum = 0
			let count = 0
			for (let planeY = firstY; planeY < lastY; planeY++) {
				const sourceY = geometry.sourceTop + planeY * geometry.step
				let mapIndex = (sourceY - input.area.top) * mapWidth + geometry.sourceLeft + firstX * geometry.step - input.area.left
				for (let planeX = firstX; planeX < lastX; planeX++, mapIndex += geometry.step) {
					if (validity[mapIndex] === 0) continue
					const value = residual[mapIndex]
					if (!Number.isFinite(value)) continue
					sum += value
					count++
				}
			}
			const index = gridY * width + gridX
			if (count > 0) {
				const value = Math.fround(sum / count)
				if (Number.isFinite(value)) {
					source[index] = value
					support[index] = 1
				}
			}
		}
	}

	return { source, support, width, height, x: xCoordinates, y: yCoordinates, spacing: geometry.step * reduction }
}

// Constructs single-channel Float32 metadata accepted by the shared separable smoothing primitive.
function artifactMetadata(width: number, height: number): ImageMetadata {
	return { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined }
}

// Converts output-pixel scales to distinct positive dilation steps on the reduced selected-plane grid.
function resolveGridScales(scales: readonly [number, number, number], spacing: number): readonly [number, number, number] {
	const small = Math.max(1, Math.ceil(scales[0] / spacing))
	const medium = Math.max(small + 1, Math.ceil(scales[1] / spacing))
	const large = Math.max(medium + 1, Math.ceil(scales[2] / spacing))
	return [small, medium, large]
}

// Smooths values and validity separately, then divides out truncated or masked kernel support.
function normalizedSmooth(source: Float32Array, support: Float32Array, output: Float32Array, supportOutput: Float32Array, intermediate: Float32Array, metadata: ImageMetadata, step: number): void {
	separableSmoothing(source, output, intermediate, metadata, ARTIFACT_GAUSSIAN_KERNEL, { step, dynamicDivisorForEdges: true })
	separableSmoothing(support, supportOutput, intermediate, metadata, ARTIFACT_GAUSSIAN_KERNEL, { step, dynamicDivisorForEdges: true })
	for (let index = 0; index < output.length; index++) output[index] = supportOutput[index] > MINIMUM_SMOOTHING_SUPPORT ? output[index] / supportOutput[index] : 0
}

// Derives a robust positive DoG threshold with a small floor tied to requested candidate contrast.
function responseThreshold(response: RobustReservoir, sigma: number, minimumContrast: number): number | undefined {
	const center = response.median()
	const mad = response.mad()
	if (!Number.isFinite(center) || !Number.isFinite(mad)) return undefined
	return Math.max(minimumContrast * 0.02, center + sigma * mad * STANDARD_DEVIATION_SCALE)
}

// Flood-fills one eight-connected candidate component and accumulates response-weighted moments.
function collectComponent(seed: number, candidate: Uint8Array, queue: Int32Array, grid: ArtifactGrid, firstResponse: Float32Array, secondResponse: Float32Array): ComponentMoments {
	let head = 0
	let tail = 1
	queue[0] = seed
	candidate[seed] = 0
	const moments: ComponentMoments = { count: 0, weight: 0, x: 0, y: 0, xx: 0, xy: 0, yy: 0, minimumResidual: 0, minX: grid.width, maxX: -1, minY: grid.height, maxY: -1 }

	while (head < tail) {
		const index = queue[head++]
		const gridX = index % grid.width
		const gridY = Math.floor(index / grid.width)
		const x = grid.x[gridX]
		const y = grid.y[gridY]
		const weight = Math.max(Number.EPSILON, firstResponse[index] + secondResponse[index])
		moments.count++
		moments.weight += weight
		moments.x += weight * x
		moments.y += weight * y
		moments.xx += weight * x * x
		moments.xy += weight * x * y
		moments.yy += weight * y * y
		moments.minimumResidual = Math.min(moments.minimumResidual, grid.source[index])
		moments.minX = Math.min(moments.minX, gridX)
		moments.maxX = Math.max(moments.maxX, gridX)
		moments.minY = Math.min(moments.minY, gridY)
		moments.maxY = Math.max(moments.maxY, gridY)

		for (let offsetY = -1; offsetY <= 1; offsetY++) {
			const neighborY = gridY + offsetY
			if (neighborY < 0 || neighborY >= grid.height) continue
			for (let offsetX = -1; offsetX <= 1; offsetX++) {
				if (offsetX === 0 && offsetY === 0) continue
				const neighborX = gridX + offsetX
				if (neighborX < 0 || neighborX >= grid.width) continue
				const neighbor = neighborY * grid.width + neighborX
				if (candidate[neighbor] === 0) continue
				candidate[neighbor] = 0
				queue[tail++] = neighbor
			}
		}
	}

	return moments
}

// Converts connected moments into a compact interior candidate or rejects edge, line, and point shapes.
function resolveCandidate(moments: ComponentMoments, grid: ArtifactGrid, margin: number, options: ResolvedDustOptions): FlatDustCandidate | undefined {
	const supportArea = moments.count * grid.spacing * grid.spacing
	if (supportArea < options.minimumArea || moments.weight <= 0 || moments.minX <= margin || moments.maxX >= grid.width - 1 - margin || moments.minY <= margin || moments.maxY >= grid.height - 1 - margin) return undefined
	const centerX = moments.x / moments.weight
	const centerY = moments.y / moments.weight
	const covarianceX = Math.max(0, moments.xx / moments.weight - centerX * centerX)
	const covarianceY = Math.max(0, moments.yy / moments.weight - centerY * centerY)
	const covarianceXY = moments.xy / moments.weight - centerX * centerY
	const trace = covarianceX + covarianceY
	const difference = Math.hypot(covarianceX - covarianceY, 2 * covarianceXY)
	const majorVariance = Math.max(0, (trace + difference) * 0.5)
	const minorVariance = Math.max(0, (trace - difference) * 0.5)
	const semiMajor = Math.sqrt(majorVariance)
	const semiMinor = Math.sqrt(minorVariance)
	if (!(semiMinor >= grid.spacing * 0.35) || !Number.isFinite(semiMajor) || semiMajor / semiMinor > MAXIMUM_DUST_ASPECT_RATIO) return undefined
	let angle = 0.5 * Math.atan2(2 * covarianceXY, covarianceX - covarianceY)
	if (angle < 0) angle += Math.PI
	const contrast = -moments.minimumResidual
	if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(angle) || !Number.isFinite(contrast) || contrast < options.minimumContrast) return undefined
	return { center: { x: centerX, y: centerY }, semiMajor, semiMinor, angle, contrast, supportArea }
}

// Orders candidates by descending attenuation and then descending connected support.
function compareDustCandidates(first: FlatDustCandidate, second: FlatDustCandidate): number {
	return second.contrast - first.contrast || second.supportArea - first.supportArea
}

// Extracts a separable five-tap Gaussian while reusing the established Gaussian kernel definition.
function artifactGaussianKernel(): SeparableSmoothingKernel {
	const gaussian = gaussianBlurKernel(1.4, 5)
	const size = gaussian.width
	const radius = size >>> 1
	const weights = new Float32Array(size)
	let divisor = 0
	for (let index = 0; index < size; index++) {
		const weight = gaussian.kernel[radius * size + index]
		weights[index] = weight
		divisor += weight
	}
	return { kernel: weights, divisor }
}
