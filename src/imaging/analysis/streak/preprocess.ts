import { validateInRange, validatePositiveInteger } from '../../../core/validation'
import type { Rect } from '../../../math/numerical/geometry'
import type { Image } from '../../model/types'
import { CFA_ANALYSIS_PLANES, imagePlaneGeometry, type ImageAnalysisPlane, type ImagePlaneGeometry, MONO_ANALYSIS_PLANES, resolveAnalysisArea, RGB_ANALYSIS_PLANES } from '../plane'
import type { StreakDetectionOptions } from './types'
import { createStreakDetectionWorkspace, MINIMUM_STREAK_BACKGROUND_CELL_SIZE, type StreakDetectionWorkspace } from './workspace'

// Native-plane extraction and robust coarse background subtraction for normalized astronomical images.
// The input image remains unchanged; one selected plane is copied once and then transformed in place.

// Mask bit marking a non-finite source sample that must not participate in later measurements.
export const STREAK_MASK_INVALID = 1

// Mask bit marking a finite sample at or above a caller-supplied saturation threshold.
export const STREAK_MASK_SATURATED = 2

// Preprocessed native-plane view and noise model consumed by edge extraction and refinement.
export interface PreparedStreakImage {
	// Validated half-open ROI in received-image pixels.
	readonly area: Readonly<Rect>
	// Selected native plane.
	readonly plane: ImageAnalysisPlane
	// Mapping between dense plane coordinates and received-image/raw coordinates.
	readonly grid: ImagePlaneGeometry
	// Reusable storage containing the residual signal and masks for this call.
	readonly workspace: StreakDetectionWorkspace
	// Background-cell side length in native-plane pixels.
	readonly backgroundCellSize: number
	// Number of populated background-grid columns.
	readonly backgroundColumns: number
	// Number of populated background-grid rows.
	readonly backgroundRows: number
	// Robust full-plane background median in input image units.
	readonly globalBackground: number
	// Robust full-plane noise sigma in input image units; zero means unresolved.
	readonly globalNoise: number
	// Caller-provided saturation threshold, retained for final photometry.
	readonly saturationLevel?: number
}

// Extracts a native plane, builds a robust local median/MAD grid, and subtracts interpolated background.
export function preprocessStreakImage(image: Image, options: Readonly<StreakDetectionOptions> = {}, providedWorkspace?: StreakDetectionWorkspace): PreparedStreakImage {
	const { width, height, channels, stride, pixelCount, bayer } = image.metadata

	// These relations prevent plausible measurements from the wrong raw offsets.
	if ((channels !== 1 && channels !== 3) || (bayer !== undefined && channels !== 1)) throw new RangeError('streak detection requires mono, RGB, or one-channel CFA layout')
	if (pixelCount !== width * height || stride !== width * channels || image.raw.length < stride * height) throw new RangeError('streak image has inconsistent raw layout')

	const area = { ...resolveAnalysisArea(options.area, width, height) }
	const planes = bayer !== undefined ? CFA_ANALYSIS_PLANES : channels === 3 ? RGB_ANALYSIS_PLANES : MONO_ANALYSIS_PLANES
	const plane = options.plane === undefined || options.plane === 'auto' ? (bayer !== undefined ? 'green1' : channels === 3 ? 'green' : 'mono') : options.plane
	if (!planes.includes(plane)) throw new RangeError(`analysis plane ${plane} is incompatible with the image layout`)
	const grid = imagePlaneGeometry(image.metadata, area, plane)
	if (!grid) throw new RangeError('selected CFA plane has no samples inside the analysis area')

	const precision = image.raw.BYTES_PER_ELEMENT === 8 ? 64 : 32
	const workspace = providedWorkspace ?? createStreakDetectionWorkspace(width, height, { precision, maximumCandidates: options.maxCandidates, angleStep: options.angleStep, distanceStep: options.distanceStep })
	if (workspace.width < width || workspace.height < height || workspace.precision !== precision) throw new RangeError('incompatible streak workspace extent or precision')
	if (options.maxCandidates !== undefined && workspace.maximumCandidates < options.maxCandidates) throw new RangeError('streak workspace candidate capacity is too small')
	const length = grid.width * grid.height

	for (let y = 0, index = 0; y < grid.height; y++) {
		let rawIndex = grid.rawStart + y * grid.rawRowStep
		for (let x = 0; x < grid.width; x++, index++, rawIndex += grid.rawColumnStep) {
			const value = image.raw[rawIndex]
			const mask = !Number.isFinite(value) ? STREAK_MASK_INVALID : options.saturationLevel !== undefined && value >= options.saturationLevel ? STREAK_MASK_SATURATED : 0
			workspace.signal[index] = mask & STREAK_MASK_INVALID ? 0 : value
			workspace.mask[index] = mask
		}
	}

	workspace.mask.fill(0, length, workspace.mask.length)

	const backgroundCellSize = options.backgroundCellSize ?? 64
	validatePositiveInteger(backgroundCellSize)
	validateInRange(backgroundCellSize, MINIMUM_STREAK_BACKGROUND_CELL_SIZE, 32_768)
	const backgroundColumns = Math.ceil(grid.width / backgroundCellSize)
	const backgroundRows = Math.ceil(grid.height / backgroundCellSize)
	const cellCount = backgroundColumns * backgroundRows
	if (workspace.background.length < cellCount) throw new RangeError('streak workspace background-grid capacity is too small')
	const statistics = workspace.statistics
	statistics.reset()
	for (let index = 0; index < length; index++) if ((workspace.mask[index] & STREAK_MASK_INVALID) === 0) statistics.push(workspace.signal[index])
	const globalBackground = statistics.median()
	const measuredGlobalNoise = statistics.madAround(globalBackground, true, workspace.scratch)
	const globalNoise = Number.isFinite(measuredGlobalNoise) && measuredGlobalNoise > 0 ? measuredGlobalNoise : 0

	for (let cellY = 0, cell = 0; cellY < backgroundRows; cellY++) {
		const top = cellY * backgroundCellSize
		const bottom = Math.min(grid.height, top + backgroundCellSize)

		for (let cellX = 0; cellX < backgroundColumns; cellX++, cell++) {
			const left = cellX * backgroundCellSize
			const right = Math.min(grid.width, left + backgroundCellSize)
			statistics.reset()

			for (let y = top; y < bottom; y++) {
				let index = y * grid.width + left
				for (let x = left; x < right; x++, index++) if ((workspace.mask[index] & STREAK_MASK_INVALID) === 0) statistics.push(workspace.signal[index])
			}

			const median = statistics.median()
			const measuredNoise = statistics.madAround(median, true, workspace.scratch)
			workspace.background[cell] = Number.isFinite(median) ? median : globalBackground
			workspace.noise[cell] = Number.isFinite(measuredNoise) && measuredNoise > 0 ? measuredNoise : globalNoise
		}
	}

	for (let y = 0, index = 0; y < grid.height; y++) {
		for (let x = 0; x < grid.width; x++, index++) {
			if (workspace.mask[index] & STREAK_MASK_INVALID) continue
			workspace.signal[index] -= interpolateBackground(workspace.background, backgroundColumns, backgroundRows, backgroundCellSize, x, y)
		}
	}

	workspace.state.edgeCount = 0
	workspace.state.candidateCount = 0
	workspace.state.edgesTruncated = false
	return { area, plane, grid, workspace, backgroundCellSize, backgroundColumns, backgroundRows, globalBackground, globalNoise, saturationLevel: options.saturationLevel }
}

// Returns conservative local noise at a native-plane coordinate; zero means no measurable noise.
export function streakLocalNoise(prepared: PreparedStreakImage, x: number, y: number): number {
	const { noise } = prepared.workspace
	const { backgroundColumns, backgroundRows, backgroundCellSize } = prepared
	const cellX = Math.max(0, Math.min(backgroundColumns - 1, Math.floor(x / backgroundCellSize)))
	const cellY = Math.max(0, Math.min(backgroundRows - 1, Math.floor(y / backgroundCellSize)))
	let measured = 0

	for (let offsetY = 0; offsetY <= 1; offsetY++) {
		const row = Math.min(backgroundRows - 1, cellY + offsetY) * backgroundColumns
		for (let offsetX = 0; offsetX <= 1; offsetX++) measured = Math.max(measured, noise[row + Math.min(backgroundColumns - 1, cellX + offsetX)])
	}

	return measured
}

// Bilinearly interpolates cell-center values across one native-plane sample position.
function interpolateBackground(background: Float64Array, columns: number, rows: number, cellSize: number, x: number, y: number): number {
	const cellX = Math.max(0, Math.min(columns - 1, x / cellSize - 0.5))
	const cellY = Math.max(0, Math.min(rows - 1, y / cellSize - 0.5))
	const x0 = Math.floor(cellX)
	const y0 = Math.floor(cellY)
	const x1 = Math.min(columns - 1, x0 + 1)
	const y1 = Math.min(rows - 1, y0 + 1)
	const fractionX = cellX - x0
	const fractionY = cellY - y0
	const top = background[y0 * columns + x0] * (1 - fractionX) + background[y0 * columns + x1] * fractionX
	const bottom = background[y1 * columns + x0] * (1 - fractionX) + background[y1 * columns + x1] * fractionX
	return top * (1 - fractionY) + bottom * fractionY
}
