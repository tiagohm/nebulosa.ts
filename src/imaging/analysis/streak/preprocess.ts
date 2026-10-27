import { validateInRange, validatePositiveInteger } from '../../../core/validation'
import type { Rect } from '../../../math/numerical/geometry'
import type { Image } from '../../model/types'
import { CFA_ANALYSIS_PLANES, imagePlaneGeometry, type ImageAnalysisPlane, type ImagePlaneGeometry, MONO_ANALYSIS_PLANES, resolveAnalysisArea, RGB_ANALYSIS_PLANES } from '../plane'
import { ROBUST_SAMPLE_CAPACITY, type RobustReservoir } from '../robust'
import type { StreakDetectionOptions } from './types'
import { createStreakDetectionWorkspace, MINIMUM_STREAK_BACKGROUND_CELL_SIZE, STREAK_COHERENCE_RADIUS, STREAK_COMPACT_DILATION, type StreakDetectionWorkspace } from './workspace'

// Native-plane extraction and robust coarse background subtraction for normalized astronomical images.
// The input image remains unchanged; one selected plane is copied once and then transformed in place.

// Mask bit marking a non-finite source sample that must not participate in later measurements.
export const STREAK_MASK_INVALID = 1

// Mask bit marking a finite sample at or above a caller-supplied saturation threshold.
export const STREAK_MASK_SATURATED = 2

// Mask bit marking a significant sample of a compact source, such as a star, whose local gradients have no common
// orientation (see markStreakCompactSources); such samples neither vote for lines nor support or measure a streak.
export const STREAK_MASK_COMPACT = 4

// Variance of one Sobel derivative of unit-variance white noise: the kernel weights (1, 2, 1) on both sides square-sum
// to 12. The expected noise energy of the structure tensor per pixel and axis is this times the noise variance.
const SOBEL_NOISE_GAIN = 12

// Mask bit used only while markStreakCompactSources dilates its marks; always clear outside it.
const DILATION_SCRATCH = 128

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
	// Robust full-plane residual-noise sigma after background subtraction, in input image units; zero means unresolved.
	readonly globalNoise: number
	// Precision-scaled residual floor below which deterministic arithmetic residue is ignored.
	readonly residualFloor: number
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
	if (options.maxWidth !== undefined && options.maxWidth < grid.step) throw new RangeError('maxWidth is below the native analysis-plane resolution')

	const precision = image.raw.BYTES_PER_ELEMENT === 8 ? 64 : 32
	const workspace = providedWorkspace ?? createStreakDetectionWorkspace(width, height, { precision, maximumCandidates: options.maxCandidates, angleStep: options.angleStep, distanceStep: options.distanceStep })
	if (workspace.width < width || workspace.height < height || workspace.precision !== precision) throw new RangeError('incompatible streak workspace extent or precision')
	if (options.maxCandidates !== undefined && workspace.maximumCandidates < options.maxCandidates) throw new RangeError('streak workspace candidate capacity is too small')
	const length = grid.width * grid.height
	const statistics = workspace.statistics
	statistics.reset()

	for (let y = 0, index = 0; y < grid.height; y++) {
		let rawIndex = grid.rawStart + y * grid.rawRowStep
		for (let x = 0; x < grid.width; x++, index++, rawIndex += grid.rawColumnStep) {
			const value = image.raw[rawIndex]
			const mask = !Number.isFinite(value) ? STREAK_MASK_INVALID : options.saturationLevel !== undefined && value >= options.saturationLevel ? STREAK_MASK_SATURATED : 0
			workspace.signal[index] = mask & STREAK_MASK_INVALID ? 0 : value
			workspace.mask[index] = mask
			if ((mask & STREAK_MASK_INVALID) === 0) statistics.push(value)
		}
	}

	workspace.mask.fill(0, length, workspace.mask.length)
	const globalBackground = statistics.median()

	const backgroundCellSize = options.backgroundCellSize ?? 64
	validatePositiveInteger(backgroundCellSize)
	validateInRange(backgroundCellSize, MINIMUM_STREAK_BACKGROUND_CELL_SIZE, 32_768)
	const backgroundColumns = Math.ceil(grid.width / backgroundCellSize)
	const backgroundRows = Math.ceil(grid.height / backgroundCellSize)
	const cellCount = backgroundColumns * backgroundRows
	if (workspace.background.length < cellCount) throw new RangeError('streak workspace background-grid capacity is too small')
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
			workspace.background[cell] = Number.isFinite(median) ? median : globalBackground
			workspace.noise[cell] = 0
		}
	}

	for (let y = 0, index = 0; y < grid.height; y++) {
		for (let x = 0; x < grid.width; x++, index++) {
			if (workspace.mask[index] & STREAK_MASK_INVALID) continue
			workspace.signal[index] -= interpolateGrid(workspace.background, backgroundColumns, backgroundRows, backgroundCellSize, grid.width, grid.height, x, y)
		}
	}

	// Measuring after subtraction prevents smooth gradients already represented by the local model
	// from becoming fictitious detector noise. Centered second differences reject residual local slope.
	const noiseFloor = (precision === 32 ? 2 ** -23 * 256 : Number.EPSILON * 64) * Math.max(1, Math.abs(globalBackground))
	let unresolvedNoise = false

	for (let cellY = 0, cell = 0; cellY < backgroundRows; cellY++) {
		const top = cellY * backgroundCellSize
		const bottom = Math.min(grid.height, top + backgroundCellSize)

		for (let cellX = 0; cellX < backgroundColumns; cellX++, cell++) {
			const left = cellX * backgroundCellSize
			const right = Math.min(grid.width, left + backgroundCellSize)
			const measured = measureResidualDifferenceNoisePair(workspace, grid.width, left, top, right, bottom)
			const measuredNoise = Math.max(measured.horizontal, measured.vertical)
			workspace.noise[cell] = Number.isFinite(measuredNoise) && measuredNoise > noiseFloor ? measuredNoise : 0
			unresolvedNoise ||= workspace.noise[cell] === 0
		}
	}

	statistics.reset()
	for (let cell = 0; cell < cellCount; cell++) if (workspace.noise[cell] > 0) statistics.push(workspace.noise[cell])
	const medianCellNoise = statistics.median()
	let globalNoise = Number.isFinite(medianCellNoise) && medianCellNoise > noiseFloor ? medianCellNoise : 0

	if (unresolvedNoise) {
		const measured = measureGlobalResidualDifferenceNoisePair(workspace, grid.width, grid.height)
		const measuredGlobalNoise = Math.max(measured.horizontal, measured.vertical)
		if (Number.isFinite(measuredGlobalNoise) && measuredGlobalNoise > noiseFloor) globalNoise = measuredGlobalNoise
		for (let cell = 0; cell < cellCount; cell++) if (workspace.noise[cell] === 0) workspace.noise[cell] = globalNoise
	}
	prepareStreakNoiseInterpolation(workspace, backgroundColumns, backgroundRows, backgroundCellSize, grid.width, grid.height)

	workspace.state.edgeCount = 0
	workspace.state.candidateCount = 0
	workspace.state.edgesTruncated = false
	workspace.state.houghCoarseEdgeWork = 0
	workspace.state.houghRefinementEdgeWork = 0
	workspace.state.houghActiveAngles = 0
	workspace.state.houghRhoWork = 0
	workspace.state.refinementWork = 0
	workspace.state.supportedRuns = 0
	workspace.state.mergeRefits = 0
	workspace.state.refinementTruncated = false
	return { area, plane, grid, workspace, backgroundCellSize, backgroundColumns, backgroundRows, globalBackground, globalNoise, residualFloor: noiseFloor, saturationLevel: options.saturationLevel }
}

// Marks the compact sources of a prepared plane with STREAK_MASK_COMPACT and returns how many samples were marked. A
// sample is marked when its residual exceeds thresholdSigma local noise sigmas and the coherence of the structure tensor
// of the Sobel gradients in the (2 STREAK_COHERENCE_RADIUS + 1)² window around it is below minCoherence (in [0, 1]):
// the gradients of a star point every way (coherence near 0), those along a straight trail share one normal
// (coherence near 1). The expected isotropic noise energy is removed from the tensor diagonal first, so a faint trail
// keeps the coherence of its signal instead of that of the noise. Gradients touching an invalid sample or the plane
// border are left out. The marks then grow by STREAK_COMPACT_DILATION into the faint wings of each source, and the
// returned count includes them. A minCoherence of 0 marks nothing. Reads the residual and the noise model, and only adds mask
// bits; O(plane pixels) with fixed workspace rows.
export function markStreakCompactSources(prepared: PreparedStreakImage, thresholdSigma: number, minCoherence: number): number {
	if (!(minCoherence > 0)) return 0

	const { workspace } = prepared
	const { width, height } = prepared.grid
	const { signal, mask, coherenceRows: rows, coherenceColumns: columns } = workspace
	const size = 2 * STREAK_COHERENCE_RADIUS + 1
	const numericalFloor = prepared.residualFloor
	const channels = 4
	let marked = 0

	// Writes the gradient products xx, xy, yy, and a validity count of one plane row into its ring slot and adds them to
	// the column sums.
	const enter = (y: number) => {
		const slot = (y % size) * width * channels

		for (let x = 0; x < width; x++) {
			const offset = slot + x * channels
			let xx = 0
			let xy = 0
			let yy = 0
			let count = 0

			if (x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
				const center = y * width + x
				const up = center - width
				const down = center + width

				if (((mask[up - 1] | mask[up] | mask[up + 1] | mask[center - 1] | mask[center] | mask[center + 1] | mask[down - 1] | mask[down] | mask[down + 1]) & STREAK_MASK_INVALID) === 0) {
					const gx = -signal[up - 1] + signal[up + 1] - 2 * signal[center - 1] + 2 * signal[center + 1] - signal[down - 1] + signal[down + 1]
					const gy = -signal[up - 1] - 2 * signal[up] - signal[up + 1] + signal[down - 1] + 2 * signal[down] + signal[down + 1]
					xx = gx * gx
					xy = gx * gy
					yy = gy * gy
					count = 1
				}
			}

			rows[offset] = xx
			rows[offset + 1] = xy
			rows[offset + 2] = yy
			rows[offset + 3] = count
			columns[x * channels] += xx
			columns[x * channels + 1] += xy
			columns[x * channels + 2] += yy
			columns[x * channels + 3] += count
		}
	}

	// Removes the products of a plane row, still in its ring slot, from the column sums.
	const leave = (y: number) => {
		const slot = (y % size) * width * channels
		for (let x = 0; x < width * channels; x++) columns[x] -= rows[slot + x]
	}

	columns.fill(0, 0, width * channels)
	for (let y = 0; y < Math.min(STREAK_COHERENCE_RADIUS, height); y++) enter(y)

	for (let y = 0; y < height; y++) {
		// The slot of the leaving row is the one the entering row reuses, so it is removed first.
		if (y - STREAK_COHERENCE_RADIUS - 1 >= 0) leave(y - STREAK_COHERENCE_RADIUS - 1)
		if (y + STREAK_COHERENCE_RADIUS < height) enter(y + STREAK_COHERENCE_RADIUS)

		let xx = 0
		let xy = 0
		let yy = 0
		let count = 0
		for (let x = 0; x < Math.min(STREAK_COHERENCE_RADIUS, width); x++) {
			xx += columns[x * channels]
			xy += columns[x * channels + 1]
			yy += columns[x * channels + 2]
			count += columns[x * channels + 3]
		}

		for (let x = 0; x < width; x++) {
			const entering = x + STREAK_COHERENCE_RADIUS
			const leaving = x - STREAK_COHERENCE_RADIUS - 1

			if (entering < width) {
				xx += columns[entering * channels]
				xy += columns[entering * channels + 1]
				yy += columns[entering * channels + 2]
				count += columns[entering * channels + 3]
			}

			if (leaving >= 0) {
				xx -= columns[leaving * channels]
				xy -= columns[leaving * channels + 1]
				yy -= columns[leaving * channels + 2]
				count -= columns[leaving * channels + 3]
			}

			const index = y * width + x
			if (mask[index] & STREAK_MASK_INVALID) continue
			const noise = streakLocalNoiseAtPixel(prepared, x, y)
			if (!(signal[index] > (noise > 0 ? thresholdSigma * noise : numericalFloor))) continue

			const noiseEnergy = SOBEL_NOISE_GAIN * noise * noise * count
			const cleanXX = Math.max(0, xx - noiseEnergy)
			const cleanYY = Math.max(0, yy - noiseEnergy)
			const trace = cleanXX + cleanYY
			const coherence = trace > 0 ? ((cleanXX - cleanYY) ** 2 + 4 * xy * xy) / (trace * trace) : 0

			if (coherence < minCoherence) mask[index] |= STREAK_MASK_COMPACT
		}
	}

	// Grows the marks by STREAK_COMPACT_DILATION into the faint wings of each source, below the significance threshold but
	// bright enough to widen a corridor profile or bridge a gap: along rows into a scratch bit, then across rows.
	const radius = STREAK_COMPACT_DILATION

	for (let y = 0; y < height; y++) {
		const row = y * width
		let previous = -radius - 1

		for (let x = 0; x < width; x++) {
			if (mask[row + x] & STREAK_MASK_COMPACT) previous = x
			if (x - previous <= radius) mask[row + x] |= DILATION_SCRATCH
		}

		previous = width + radius
		for (let x = width - 1; x >= 0; x--) {
			if (mask[row + x] & STREAK_MASK_COMPACT) previous = x
			if (previous - x <= radius) mask[row + x] |= DILATION_SCRATCH
		}
	}

	for (let y = 0; y < height; y++) {
		const first = Math.max(0, y - radius)
		const last = Math.min(height - 1, y + radius)

		for (let x = 0; x < width; x++) {
			for (let near = first; near <= last; near++) {
				if (mask[near * width + x] & DILATION_SCRATCH) {
					mask[y * width + x] |= STREAK_MASK_COMPACT
					break
				}
			}
		}
	}

	for (let index = 0; index < width * height; index++) {
		mask[index] &= ~DILATION_SCRATCH
		if (mask[index] & STREAK_MASK_COMPACT) marked++
	}

	return marked
}

// Estimates horizontal and vertical residual sigma in one cell during one pixel traversal.
function measureResidualDifferenceNoisePair(workspace: StreakDetectionWorkspace, width: number, left: number, top: number, right: number, bottom: number): { readonly horizontal: number; readonly vertical: number } {
	const horizontal = workspace.statistics
	const vertical = workspace.noiseStatistics
	horizontal.reset()
	vertical.reset()

	for (let y = top; y < bottom; y++) {
		let index = y * width + left
		for (let x = left; x < right; x++, index++) {
			if (x > left && x + 1 < right && (workspace.mask[index - 1] & STREAK_MASK_INVALID) === 0 && (workspace.mask[index] & STREAK_MASK_INVALID) === 0 && (workspace.mask[index + 1] & STREAK_MASK_INVALID) === 0) horizontal.push(workspace.signal[index - 1] - 2 * workspace.signal[index] + workspace.signal[index + 1])
			if (y > top && y + 1 < bottom && (workspace.mask[index - width] & STREAK_MASK_INVALID) === 0 && (workspace.mask[index] & STREAK_MASK_INVALID) === 0 && (workspace.mask[index + width] & STREAK_MASK_INVALID) === 0)
				vertical.push(workspace.signal[index - width] - 2 * workspace.signal[index] + workspace.signal[index + width])
		}
	}

	return { horizontal: reduceResidualDifferenceNoise(horizontal, workspace.scratch), vertical: reduceResidualDifferenceNoise(vertical, workspace.scratch) }
}

// Estimates global residual noise from at most one spatially stratified sample per capacity slot.
function measureGlobalResidualDifferenceNoisePair(workspace: StreakDetectionWorkspace, width: number, height: number): { readonly horizontal: number; readonly vertical: number } {
	const horizontal = workspace.statistics
	const vertical = workspace.noiseStatistics
	horizontal.reset()
	vertical.reset()
	const interiorWidth = Math.max(0, width - 2)
	const interiorHeight = Math.max(0, height - 2)
	const population = interiorWidth * interiorHeight
	const sampleCount = Math.min(population, ROBUST_SAMPLE_CAPACITY)

	for (let sample = 0; sample < sampleCount; sample++) {
		const position = Math.min(population - 1, Math.floor(((sample + 0.5) * population) / sampleCount))
		const x = 1 + (position % interiorWidth)
		const y = 1 + Math.floor(position / interiorWidth)
		const index = y * width + x
		if ((workspace.mask[index - 1] & STREAK_MASK_INVALID) === 0 && (workspace.mask[index] & STREAK_MASK_INVALID) === 0 && (workspace.mask[index + 1] & STREAK_MASK_INVALID) === 0) horizontal.push(workspace.signal[index - 1] - 2 * workspace.signal[index] + workspace.signal[index + 1])
		if ((workspace.mask[index - width] & STREAK_MASK_INVALID) === 0 && (workspace.mask[index] & STREAK_MASK_INVALID) === 0 && (workspace.mask[index + width] & STREAK_MASK_INVALID) === 0) vertical.push(workspace.signal[index - width] - 2 * workspace.signal[index] + workspace.signal[index + width])
	}

	return { horizontal: reduceResidualDifferenceNoise(horizontal, workspace.scratch), vertical: reduceResidualDifferenceNoise(vertical, workspace.scratch) }
}

// Converts a centered-second-difference population to the equivalent input noise sigma.
function reduceResidualDifferenceNoise(statistics: RobustReservoir, scratch: Float64Array): number {
	if (statistics.retainedCount === 0) return 0
	const center = statistics.median()
	return statistics.madAround(center, true, scratch) / Math.sqrt(6)
}

// Returns conservative local noise at a native-plane coordinate; zero means no measurable noise.
export function streakLocalNoise(prepared: PreparedStreakImage, x: number, y: number): number {
	const { backgroundColumns, backgroundRows, backgroundCellSize } = prepared
	return Math.max(0, interpolateGrid(prepared.workspace.noise, backgroundColumns, backgroundRows, backgroundCellSize, prepared.grid.width, prepared.grid.height, x, y))
}

// Returns local noise at an integer native-plane pixel using preprocessing interpolation tables.
export function streakLocalNoiseAtPixel(prepared: PreparedStreakImage, x: number, y: number): number {
	const { workspace } = prepared
	const x0 = workspace.noiseColumn0[x]
	const x1 = workspace.noiseColumn1[x]
	const fractionX = workspace.noiseColumnFraction[x]
	const row0 = workspace.noiseRowOffset0[y]
	const row1 = workspace.noiseRowOffset1[y]
	const fractionY = workspace.noiseRowFraction[y]
	const top = workspace.noise[row0 + x0] * (1 - fractionX) + workspace.noise[row0 + x1] * fractionX
	const bottom = workspace.noise[row1 + x0] * (1 - fractionX) + workspace.noise[row1 + x1] * fractionX
	return Math.max(0, top * (1 - fractionY) + bottom * fractionY)
}

// Precomputes coarse-grid interpolation geometry for every integer native-plane coordinate.
function prepareStreakNoiseInterpolation(workspace: StreakDetectionWorkspace, columns: number, rows: number, cellSize: number, width: number, height: number): void {
	for (let x = 0; x < width; x++) {
		const cell = interpolationAxisCoordinate(x, cellSize, columns, width)
		const first = columns === 1 ? 0 : Math.max(0, Math.min(columns - 2, Math.floor(cell)))
		workspace.noiseColumn0[x] = first
		workspace.noiseColumn1[x] = Math.min(columns - 1, first + 1)
		workspace.noiseColumnFraction[x] = columns === 1 ? 0 : cell - first
	}

	for (let y = 0; y < height; y++) {
		const cell = interpolationAxisCoordinate(y, cellSize, rows, height)
		const first = rows === 1 ? 0 : Math.max(0, Math.min(rows - 2, Math.floor(cell)))
		workspace.noiseRowOffset0[y] = first * columns
		workspace.noiseRowOffset1[y] = Math.min(rows - 1, first + 1) * columns
		workspace.noiseRowFraction[y] = rows === 1 ? 0 : cell - first
	}
}

// Bilinearly interpolates cell-center values across one native-plane sample position.
function interpolateGrid(background: Float64Array, columns: number, rows: number, cellSize: number, width: number, height: number, x: number, y: number): number {
	const cellX = interpolationAxisCoordinate(x, cellSize, columns, width)
	const cellY = interpolationAxisCoordinate(y, cellSize, rows, height)
	const x0 = columns === 1 ? 0 : Math.max(0, Math.min(columns - 2, Math.floor(cellX)))
	const y0 = rows === 1 ? 0 : Math.max(0, Math.min(rows - 2, Math.floor(cellY)))
	const x1 = Math.min(columns - 1, x0 + 1)
	const y1 = Math.min(rows - 1, y0 + 1)
	const fractionX = columns === 1 ? 0 : cellX - x0
	const fractionY = rows === 1 ? 0 : cellY - y0
	const top = background[y0 * columns + x0] * (1 - fractionX) + background[y0 * columns + x1] * fractionX
	const bottom = background[y1 * columns + x0] * (1 - fractionX) + background[y1 * columns + x1] * fractionX
	return top * (1 - fractionY) + bottom * fractionY
}

// Maps a pixel center to a possibly extrapolated coarse-grid coordinate with a partial final cell.
function interpolationAxisCoordinate(value: number, cellSize: number, count: number, extent: number): number {
	if (count <= 1) return 0
	const firstCenter = (Math.min(cellSize, extent) - 1) * 0.5
	const lastStart = (count - 1) * cellSize
	const lastCenter = (lastStart + extent - 1) * 0.5
	const penultimateStart = (count - 2) * cellSize
	const penultimateCenter = (penultimateStart + Math.min(extent, penultimateStart + cellSize) - 1) * 0.5
	if (value >= penultimateCenter) return count - 2 + (value - penultimateCenter) / (lastCenter - penultimateCenter)
	return (value - firstCenter) / cellSize
}
