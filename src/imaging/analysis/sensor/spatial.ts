import { gaussianElimination, Matrix } from '../../../math/linear-algebra/matrix'
import type { Rect } from '../../../math/numerical/geometry'
import { resolveSensorArea, resolveSensorPlaneGeometry, validateSensorSpatialStack, type SensorPlaneGeometry } from './grid'
import { SensorRobustReservoir } from './reservoir'
import type { SensorFrameSet, SensorPlane, SensorSpatialBuffers, SensorTileOptions } from './types'

// Tiled spatial sensor analysis for fixed-exposure dark and flat stacks. Each tile rereads frames and
// retains only a bounded halo needed by the EMVA 7x7, 11x11, and binomial 3x3 high-pass sequence.
// Population spatial moments, sample temporal variance, profiles, and optional maps are returned fresh.

// Row, column, and residual-pixel spatial RMS components as dimensionless fractions.
export interface SensorSpatialComponents {
	// Overall spatial RMS.
	readonly overall: number
	// Row-correlated spatial RMS.
	readonly rows: number
	// Column-correlated spatial RMS.
	readonly columns: number
	// Residual pixel spatial RMS after row/column decomposition.
	readonly pixels: number
}

// Dark-signal nonuniformity in input-referred electrons RMS.
export interface SensorSpatialNoise {
	// Overall high-pass DSNU, electrons RMS.
	readonly overall: number
	// Row-correlated DSNU, electrons RMS.
	readonly rows: number
	// Column-correlated DSNU, electrons RMS.
	readonly columns: number
	// Residual-pixel DSNU, electrons RMS.
	readonly pixels: number
	// Unfiltered mean-dark profile by plane-grid row, DN.
	readonly rowProfile?: Float64Array
	// Unfiltered mean-dark profile by plane-grid column, DN.
	readonly columnProfile?: Float64Array
	// Optional high-pass DSNU map in electrons on the selected plane grid.
	readonly map?: Float32Array
}

// Photo-response nonuniformity summaries and optional residual map.
export interface SensorPhotoResponse {
	// EMVA high-pass PRNU components.
	readonly emva: SensorSpatialComponents
	// Unfiltered bright-minus-dark spatial components.
	readonly undetrended: SensorSpatialComponents
	// Plane/polynomial-detrended practical PRNU components when requested.
	readonly corrected?: SensorSpatialComponents
	// Unfiltered bright-minus-dark profile by plane-grid row, DN.
	readonly rowProfile?: Float64Array
	// Unfiltered bright-minus-dark profile by plane-grid column, DN.
	readonly columnProfile?: Float64Array
	// Optional selected PRNU residual map as a dimensionless fraction.
	readonly map?: Float32Array
}

// Complete DSNU and PRNU result for one sensor plane.
export interface SensorSpatialCharacterization {
	// Dark-signal nonuniformity.
	readonly dsnu: SensorSpatialNoise
	// Photo-response nonuniformity.
	readonly prnu: SensorPhotoResponse
	// Number of samples in the selected plane/ROI grid.
	readonly sampleCount: number
	// Mean bright-minus-dark signal, DN.
	readonly signal: number
}

// Options controlling tiled spatial analysis and retained maps.
export interface SensorSpatialOptions {
	// Inclusive-exclusive image ROI; defaults to the full frame.
	readonly area?: Readonly<Rect>
	// Mono or CFA plane to analyze.
	readonly plane?: SensorPlane
	// CFA phase offset of image coordinate (0,0), unbinned sensor pixels.
	readonly cfaOffset?: readonly [number, number]
	// Illumination detrending used for optional practical PRNU.
	readonly spatialDetrend?: 'none' | 'emvaHighpass' | 'plane' | 'polynomial'
	// Diagnostic maps to retain; only all retains DSNU/PRNU maps in this phase.
	readonly maps?: 'none' | 'defects' | 'all'
	// Caller-provided buffers validated for the selected plane-grid size.
	readonly spatialBuffers?: SensorSpatialBuffers
	// Target tile size before adding the nine-pixel filter halo.
	readonly tile?: Readonly<SensorTileOptions>
}

// Fixed reusable buffers for one expanded tile and the valid-convolution stages.
interface SpatialWorkspace {
	// Per-pixel stack mean on the expanded tile.
	readonly mean: Float64Array
	// Per-pixel sample temporal variance on the expanded tile.
	readonly variance: Float64Array
	// Horizontal box-filter workspace.
	readonly horizontal: Float64Array
	// Finite-sample counts paired with the active horizontal box-filter workspace.
	readonly horizontalCounts: Uint32Array
	// First valid box-filter output.
	readonly first: Float64Array
	// Second horizontal box-filter workspace.
	readonly secondHorizontal: Float64Array
	// Second valid box-filter output.
	readonly second: Float64Array
	// Final binomial-smoothed target tile.
	readonly smooth: Float64Array
}

// Temporal variance of raw and EMVA-high-pass row/column means for a stack average.
interface TemporalProfileVariances {
	// Variance of each raw row mean after averaging the finite frames, DN².
	readonly rawRows: Float64Array
	// Variance of each raw column mean after averaging the finite frames, DN².
	readonly rawColumns: Float64Array
	// Variance of each high-pass row mean after averaging the finite frames, DN².
	readonly highpassRows: Float64Array
	// Variance of each high-pass column mean after averaging the finite frames, DN².
	readonly highpassColumns: Float64Array
}

// Allocates fixed workspaces sized for the largest requested target tile plus a nine-sample halo.
function createWorkspace(tileWidth: number, tileHeight: number): SpatialWorkspace {
	const expandedWidth = tileWidth + 18
	const expandedHeight = tileHeight + 18
	const expanded = expandedWidth * expandedHeight
	return {
		mean: new Float64Array(expanded),
		variance: new Float64Array(expanded),
		horizontal: new Float64Array((expandedWidth - 6) * expandedHeight),
		horizontalCounts: new Uint32Array((expandedWidth - 6) * expandedHeight),
		first: new Float64Array((expandedWidth - 6) * (expandedHeight - 6)),
		secondHorizontal: new Float64Array((expandedWidth - 16) * (expandedHeight - 6)),
		second: new Float64Array((expandedWidth - 16) * (expandedHeight - 16)),
		smooth: new Float64Array(tileWidth * tileHeight),
	}
}

// Applies an edge-clamped one-dimensional box filter while excluding non-finite samples.
function boxProfile(input: Float64Array, output: Float64Array, radius: number) {
	for (let i = 0; i < input.length; i++) {
		let sum = 0
		let count = 0
		for (let offset = -radius; offset <= radius; offset++) {
			const value = input[Math.max(0, Math.min(input.length - 1, i + offset))]
			if (Number.isFinite(value)) {
				sum += value
				count++
			}
		}
		output[i] = count > 0 ? sum / count : Number.NaN
	}
}

// Applies the final edge-clamped binomial filter used by the EMVA high-pass sequence.
function binomialProfile(input: Float64Array, output: Float64Array) {
	for (let i = 0; i < input.length; i++) {
		let sum = 0
		let weight = 0
		for (let offset = -1; offset <= 1; offset++) {
			const value = input[Math.max(0, Math.min(input.length - 1, i + offset))]
			if (Number.isFinite(value)) {
				const sampleWeight = offset === 0 ? 2 : 1
				sum += value * sampleWeight
				weight += sampleWeight
			}
		}
		output[i] = weight > 0 ? sum / weight : Number.NaN
	}
}

// Updates per-profile online moments with one raw profile and its EMVA high-pass residual.
function updateTemporalProfileMoments(profile: Float64Array, first: Float64Array, second: Float64Array, smooth: Float64Array, rawMeans: Float64Array, rawM2: Float64Array, rawCounts: Uint32Array, highpassMeans: Float64Array, highpassM2: Float64Array, highpassCounts: Uint32Array) {
	boxProfile(profile, first, 3)
	boxProfile(first, second, 5)
	binomialProfile(second, smooth)
	for (let i = 0; i < profile.length; i++) {
		const value = profile[i]
		if (!Number.isFinite(value)) continue
		let count = ++rawCounts[i]
		let delta = value - rawMeans[i]
		rawMeans[i] += delta / count
		rawM2[i] += delta * (value - rawMeans[i])
		const highpass = value - smooth[i]
		if (!Number.isFinite(highpass)) continue
		count = ++highpassCounts[i]
		delta = highpass - highpassMeans[i]
		highpassMeans[i] += delta / count
		highpassM2[i] += delta * (highpass - highpassMeans[i])
	}
}

// Converts temporal profile M2 values to the variance remaining in each finite stack mean.
function finalizeTemporalProfileVariances(m2: Float64Array, counts: Uint32Array) {
	for (let i = 0; i < m2.length; i++) m2[i] = counts[i] > 1 ? m2[i] / (counts[i] - 1) / counts[i] : Number.NaN
}

// Measures temporal contamination of raw and high-pass row/column means without image-sized buffers.
function temporalProfileVariances(set: SensorFrameSet, geometry: SensorPlaneGeometry): TemporalProfileVariances {
	const rawRows = new Float64Array(geometry.height)
	const rawColumns = new Float64Array(geometry.width)
	const highpassRows = new Float64Array(geometry.height)
	const highpassColumns = new Float64Array(geometry.width)
	const rawRowMeans = new Float64Array(geometry.height)
	const rawColumnMeans = new Float64Array(geometry.width)
	const highpassRowMeans = new Float64Array(geometry.height)
	const highpassColumnMeans = new Float64Array(geometry.width)
	const rawRowCounts = new Uint32Array(geometry.height)
	const rawColumnCounts = new Uint32Array(geometry.width)
	const highpassRowCounts = new Uint32Array(geometry.height)
	const highpassColumnCounts = new Uint32Array(geometry.width)
	const rowProfile = new Float64Array(geometry.height)
	const columnProfile = new Float64Array(geometry.width)
	const rowSamples = new Uint32Array(geometry.height)
	const columnSamples = new Uint32Array(geometry.width)
	const rowFirst = new Float64Array(geometry.height)
	const rowSecond = new Float64Array(geometry.height)
	const rowSmooth = new Float64Array(geometry.height)
	const columnFirst = new Float64Array(geometry.width)
	const columnSecond = new Float64Array(geometry.width)
	const columnSmooth = new Float64Array(geometry.width)
	const sourceWidth = set.frames[0].metadata.width
	for (const frame of set.frames) {
		rowProfile.fill(0)
		columnProfile.fill(0)
		rowSamples.fill(0)
		columnSamples.fill(0)
		for (let y = 0; y < geometry.height; y++) {
			const sourceY = geometry.sourceTop + y * geometry.step
			let index = sourceY * sourceWidth + geometry.sourceLeft
			for (let x = 0; x < geometry.width; x++, index += geometry.step) {
				const value = frame.raw[index]
				if (!Number.isFinite(value)) continue
				rowProfile[y] += value
				columnProfile[x] += value
				rowSamples[y]++
				columnSamples[x]++
			}
		}
		for (let y = 0; y < geometry.height; y++) rowProfile[y] = rowSamples[y] > 0 ? rowProfile[y] / rowSamples[y] : Number.NaN
		for (let x = 0; x < geometry.width; x++) columnProfile[x] = columnSamples[x] > 0 ? columnProfile[x] / columnSamples[x] : Number.NaN
		updateTemporalProfileMoments(rowProfile, rowFirst, rowSecond, rowSmooth, rawRowMeans, rawRows, rawRowCounts, highpassRowMeans, highpassRows, highpassRowCounts)
		updateTemporalProfileMoments(columnProfile, columnFirst, columnSecond, columnSmooth, rawColumnMeans, rawColumns, rawColumnCounts, highpassColumnMeans, highpassColumns, highpassColumnCounts)
	}
	finalizeTemporalProfileVariances(rawRows, rawRowCounts)
	finalizeTemporalProfileVariances(rawColumns, rawColumnCounts)
	finalizeTemporalProfileVariances(highpassRows, highpassRowCounts)
	finalizeTemporalProfileVariances(highpassColumns, highpassColumnCounts)
	return { rawRows, rawColumns, highpassRows, highpassColumns }
}

// Fills expanded plane-grid stack mean and unbiased temporal variance, clamping the filter halo to edges.
function fillStackStatistics(set: SensorFrameSet, geometry: SensorPlaneGeometry, tileLeft: number, tileTop: number, targetWidth: number, targetHeight: number, workspace: SpatialWorkspace) {
	const expandedWidth = targetWidth + 18
	const expandedHeight = targetHeight + 18
	const sourceWidth = set.frames[0].metadata.width
	let output = 0
	for (let localY = 0; localY < expandedHeight; localY++) {
		const planeY = Math.max(0, Math.min(geometry.height - 1, tileTop + localY - 9))
		const sourceY = geometry.sourceTop + planeY * geometry.step
		for (let localX = 0; localX < expandedWidth; localX++, output++) {
			const planeX = Math.max(0, Math.min(geometry.width - 1, tileLeft + localX - 9))
			const sourceX = geometry.sourceLeft + planeX * geometry.step
			const index = sourceY * sourceWidth + sourceX
			let count = 0
			let mean = 0
			let m2 = 0
			for (let frameIndex = 0; frameIndex < set.frames.length; frameIndex++) {
				const value = set.frames[frameIndex].raw[index]
				if (!Number.isFinite(value)) continue
				count++
				const delta = value - mean
				mean += delta / count
				m2 += delta * (value - mean)
			}
			workspace.mean[output] = count > 0 ? mean : Number.NaN
			workspace.variance[output] = count > 1 ? m2 / (count - 1) : Number.NaN
		}
	}
}

// Applies a separable valid box filter while excluding non-finite samples from each window.
function boxValid(input: Float64Array, width: number, height: number, radius: number, horizontal: Float64Array, horizontalCounts: Uint32Array, output: Float64Array) {
	const kernel = radius * 2 + 1
	const outputWidth = width - radius * 2
	const outputHeight = height - radius * 2
	for (let y = 0; y < height; y++) {
		const row = y * width
		const targetRow = y * outputWidth
		let sum = 0
		let count = 0
		for (let x = 0; x < kernel; x++) {
			const value = input[row + x]
			if (Number.isFinite(value)) {
				sum += value
				count++
			}
		}
		horizontal[targetRow] = sum
		horizontalCounts[targetRow] = count
		for (let x = 1; x < outputWidth; x++) {
			const removed = input[row + x - 1]
			const added = input[row + x + kernel - 1]
			if (Number.isFinite(removed)) {
				sum -= removed
				count--
			}
			if (Number.isFinite(added)) {
				sum += added
				count++
			}
			horizontal[targetRow + x] = sum
			horizontalCounts[targetRow + x] = count
		}
	}
	for (let x = 0; x < outputWidth; x++) {
		let sum = 0
		let count = 0
		for (let y = 0; y < kernel; y++) {
			const index = y * outputWidth + x
			sum += horizontal[index]
			count += horizontalCounts[index]
		}
		output[x] = count > 0 ? sum / count : Number.NaN
		for (let y = 1; y < outputHeight; y++) {
			const removed = (y - 1) * outputWidth + x
			const added = (y + kernel - 1) * outputWidth + x
			sum -= horizontal[removed]
			count -= horizontalCounts[removed]
			sum += horizontal[added]
			count += horizontalCounts[added]
			output[y * outputWidth + x] = count > 0 ? sum / count : Number.NaN
		}
	}
}

// Applies the final valid binomial 3x3 filter to produce the target tile.
function binomialValid(input: Float64Array, width: number, height: number, output: Float64Array) {
	const outputWidth = width - 2
	const outputHeight = height - 2
	for (let y = 0; y < outputHeight; y++) {
		for (let x = 0; x < outputWidth; x++) {
			const top = y * width + x
			const middle = top + width
			const bottom = middle + width
			let sum = 0
			let weight = 0
			let value = input[top]
			if (Number.isFinite(value)) {
				sum += value
				weight++
			}
			value = input[top + 1]
			if (Number.isFinite(value)) {
				sum += value * 2
				weight += 2
			}
			value = input[top + 2]
			if (Number.isFinite(value)) {
				sum += value
				weight++
			}
			value = input[middle]
			if (Number.isFinite(value)) {
				sum += value * 2
				weight += 2
			}
			value = input[middle + 1]
			if (Number.isFinite(value)) {
				sum += value * 4
				weight += 4
			}
			value = input[middle + 2]
			if (Number.isFinite(value)) {
				sum += value * 2
				weight += 2
			}
			value = input[bottom]
			if (Number.isFinite(value)) {
				sum += value
				weight++
			}
			value = input[bottom + 1]
			if (Number.isFinite(value)) {
				sum += value * 2
				weight += 2
			}
			value = input[bottom + 2]
			if (Number.isFinite(value)) {
				sum += value
				weight++
			}
			output[y * outputWidth + x] = weight > 0 ? sum / weight : Number.NaN
		}
	}
}

// Computes the prescribed sequential high-pass smoothing for the current expanded stack mean.
function smoothTarget(workspace: SpatialWorkspace, targetWidth: number, targetHeight: number) {
	const expandedWidth = targetWidth + 18
	const expandedHeight = targetHeight + 18
	boxValid(workspace.mean, expandedWidth, expandedHeight, 3, workspace.horizontal, workspace.horizontalCounts, workspace.first)
	boxValid(workspace.first, expandedWidth - 6, expandedHeight - 6, 5, workspace.secondHorizontal, workspace.horizontalCounts, workspace.second)
	binomialValid(workspace.second, targetWidth + 2, targetHeight + 2, workspace.smooth)
}

// Adds basis outer products and response products for plane or quadratic detrending.
function accumulateSurface(normal: Float64Array, rhs: Float64Array, basis: Float64Array, terms: number, x: number, y: number, value: number) {
	basis[0] = 1
	basis[1] = x
	basis[2] = y
	if (terms === 6) {
		basis[3] = x * x
		basis[4] = x * y
		basis[5] = y * y
	}
	for (let row = 0; row < terms; row++) {
		rhs[row] += basis[row] * value
		const offset = row * terms
		for (let column = 0; column < terms; column++) normal[offset + column] += basis[row] * basis[column]
	}
}

// Solves accumulated normal equations for a low-frequency response surface.
function solveSurface(normal: Float64Array, rhs: Float64Array, terms: number): Float64Array | undefined {
	try {
		const matrix = Matrix.square(terms)
		for (let i = 0; i < normal.length; i++) matrix.data[i] = normal[i]
		const coefficients = new Float64Array(terms)
		gaussianElimination(matrix, rhs, coefficients)
		for (let i = 0; i < coefficients.length; i++) if (!Number.isFinite(coefficients[i])) return undefined
		return coefficients
	} catch {
		return undefined
	}
}

// Evaluates a fitted plane or quadratic response surface at normalized plane-grid coordinates.
function surfaceValue(coefficients: Float64Array, x: number, y: number): number {
	return coefficients.length === 3 ? coefficients[0] + coefficients[1] * x + coefficients[2] * y : coefficients[0] + coefficients[1] * x + coefficients[2] * y + coefficients[3] * x * x + coefficients[4] * x * y + coefficients[5] * y * y
}

// Converts total/row/column variances into a non-negative RMS decomposition and applies scale.
function components(totalVariance: number, rowVariance: number, columnVariance: number, scale: number): SensorSpatialComponents {
	const total = Math.max(0, totalVariance)
	let rows = Math.max(0, rowVariance)
	let columns = Math.max(0, columnVariance)
	if (rows + columns > total && rows + columns > 0) {
		const factor = total / (rows + columns)
		rows *= factor
		columns *= factor
	}
	const pixels = Math.max(0, total - rows - columns)
	return { overall: Math.sqrt(total) * scale, rows: Math.sqrt(rows) * scale, columns: Math.sqrt(columns) * scale, pixels: Math.sqrt(pixels) * scale }
}

// Computes variance of repeated row or column effects weighted by their sample counts.
function effectVariance(sums: Float64Array, counts: Uint32Array, overallMean: number): number {
	let total = 0
	let count = 0
	for (let i = 0; i < sums.length; i++) {
		if (counts[i] === 0) continue
		const effect = sums[i] / counts[i] - overallMean
		total += effect * effect * counts[i]
		count += counts[i]
	}
	return count > 0 ? total / count : 0
}

// Averages temporal variances with the same spatial weights used by row/column decomposition.
function weightedTemporalVariance(variances: Float64Array, counts: Uint32Array): number {
	let total = 0
	let count = 0
	for (let i = 0; i < variances.length; i++) {
		if (counts[i] === 0 || !Number.isFinite(variances[i])) continue
		total += variances[i] * counts[i]
		count += counts[i]
	}
	return count > 0 ? total / count : 0
}

// Averages additive temporal profile variance after normalization by a fitted response surface.
function weightedNormalizedTemporalVariance(first: Float64Array, second: Float64Array, counts: Uint32Array, coefficients: Float64Array, geometry: SensorPlaneGeometry, rows: boolean): number {
	let total = 0
	let count = 0
	for (let profileIndex = 0; profileIndex < counts.length; profileIndex++) {
		const variance = first[profileIndex] + second[profileIndex]
		if (counts[profileIndex] === 0 || !Number.isFinite(variance)) continue
		const samples = rows ? geometry.width : geometry.height
		let inverseModelMean = 0
		let inverseModelCount = 0
		for (let sample = 0; sample < samples; sample++) {
			const x = rows ? sample : profileIndex
			const y = rows ? profileIndex : sample
			const normalizedX = geometry.width > 1 ? (2 * x) / (geometry.width - 1) - 1 : 0
			const normalizedY = geometry.height > 1 ? (2 * y) / (geometry.height - 1) - 1 : 0
			const model = surfaceValue(coefficients, normalizedX, normalizedY)
			if (!Number.isFinite(model) || Math.abs(model) <= Number.EPSILON) continue
			inverseModelMean += 1 / model
			inverseModelCount++
		}
		if (inverseModelCount === 0) continue
		inverseModelMean /= inverseModelCount
		total += variance * inverseModelMean * inverseModelMean * counts[profileIndex]
		count += counts[profileIndex]
	}
	return count > 0 ? total / count : 0
}

// Measures DSNU and PRNU for matched fixed-exposure dark and bright stacks.
export function measureSensorSpatial(dark: SensorFrameSet, flat: SensorFrameSet, conversionGain: number, options: Partial<SensorSpatialOptions> = {}): SensorSpatialCharacterization {
	if (!Number.isFinite(conversionGain) || conversionGain <= 0) throw new RangeError('spatial conversion gain must be finite and positive')
	if (!Number.isFinite(dark.exposure) || dark.exposure < 0 || !Number.isFinite(flat.exposure) || flat.exposure < 0 || dark.exposure !== flat.exposure) throw new RangeError('spatial dark and flat stacks must have matching finite non-negative exposure')
	if (options.spatialDetrend !== undefined && options.spatialDetrend !== 'none' && options.spatialDetrend !== 'emvaHighpass' && options.spatialDetrend !== 'plane' && options.spatialDetrend !== 'polynomial') throw new RangeError('unsupported spatial detrending mode')
	const reference = dark.frames[0]
	validateSensorSpatialStack(dark, reference)
	validateSensorSpatialStack(flat, reference)
	const area = resolveSensorArea(options.area, reference.metadata.width, reference.metadata.height)
	const geometry = resolveSensorPlaneGeometry(reference, area, options.plane, options.cfaOffset)
	const sampleCapacity = geometry.width * geometry.height
	const tileWidth = options.tile?.width ?? 256
	const tileHeight = options.tile?.height ?? 256
	if (!Number.isInteger(tileWidth) || !Number.isInteger(tileHeight) || tileWidth <= 0 || tileHeight <= 0) throw new RangeError('spatial tile dimensions must be positive integers')
	for (const buffer of [options.spatialBuffers?.mean, options.spatialBuffers?.variance, options.spatialBuffers?.mask]) if (buffer && buffer.length < sampleCapacity) throw new RangeError('spatial buffer is smaller than the selected plane/ROI')

	const workspace = createWorkspace(Math.min(tileWidth, geometry.width), Math.min(tileHeight, geometry.height))
	const darkWorkspace = workspace
	const flatWorkspace = createWorkspace(Math.min(tileWidth, geometry.width), Math.min(tileHeight, geometry.height))
	const darkRow = new Float64Array(geometry.height)
	const darkColumn = new Float64Array(geometry.width)
	const signalRow = new Float64Array(geometry.height)
	const signalColumn = new Float64Array(geometry.width)
	const darkResidualRow = new Float64Array(geometry.height)
	const darkResidualColumn = new Float64Array(geometry.width)
	const brightResidualRow = new Float64Array(geometry.height)
	const brightResidualColumn = new Float64Array(geometry.width)
	const signalSpatialRow = new Float64Array(geometry.height)
	const signalSpatialColumn = new Float64Array(geometry.width)
	const rowCounts = new Uint32Array(geometry.height)
	const columnCounts = new Uint32Array(geometry.width)
	const detrend = options.spatialDetrend ?? 'emvaHighpass'
	const terms = detrend === 'plane' ? 3 : detrend === 'polynomial' ? 6 : 0
	const normal = new Float64Array(terms * terms)
	const rhs = new Float64Array(terms)
	const basis = new Float64Array(terms)
	const dsnuMap = options.maps === 'all' ? new Float32Array(sampleCapacity) : undefined
	const prnuMap = options.maps === 'all' ? new Float32Array(sampleCapacity) : undefined
	const meanBuffer = options.spatialBuffers?.mean
	const varianceBuffer = options.spatialBuffers?.variance
	const maskBuffer = options.spatialBuffers?.mask
	const darkProfileTemporal = temporalProfileVariances(dark, geometry)
	const brightProfileTemporal = temporalProfileVariances(flat, geometry)
	if (dsnuMap) dsnuMap.fill(Number.NaN)
	if (prnuMap) prnuMap.fill(Number.NaN)
	if (meanBuffer) meanBuffer.fill(Number.NaN, 0, sampleCapacity)
	if (varianceBuffer) varianceBuffer.fill(Number.NaN, 0, sampleCapacity)
	if (maskBuffer) maskBuffer.fill(1, 0, sampleCapacity)
	let count = 0
	let darkMean = 0
	let darkM2 = 0
	let brightMean = 0
	let brightM2 = 0
	let signalMean = 0
	let signalM2 = 0
	let darkTemporalSum = 0
	let brightTemporalSum = 0

	for (let tileTop = 0; tileTop < geometry.height; tileTop += tileHeight) {
		const targetHeight = Math.min(tileHeight, geometry.height - tileTop)
		for (let tileLeft = 0; tileLeft < geometry.width; tileLeft += tileWidth) {
			const targetWidth = Math.min(tileWidth, geometry.width - tileLeft)
			const expandedWidth = targetWidth + 18
			fillStackStatistics(dark, geometry, tileLeft, tileTop, targetWidth, targetHeight, darkWorkspace)
			smoothTarget(darkWorkspace, targetWidth, targetHeight)
			fillStackStatistics(flat, geometry, tileLeft, tileTop, targetWidth, targetHeight, flatWorkspace)
			smoothTarget(flatWorkspace, targetWidth, targetHeight)
			for (let localY = 0; localY < targetHeight; localY++) {
				const y = tileTop + localY
				for (let localX = 0; localX < targetWidth; localX++) {
					const x = tileLeft + localX
					const target = localY * targetWidth + localX
					const darkCenter = (localY + 9) * expandedWidth + localX + 9
					const flatCenter = darkCenter
					const meanDark = darkWorkspace.mean[darkCenter]
					const meanFlat = flatWorkspace.mean[flatCenter]
					const temporalDark = darkWorkspace.variance[darkCenter]
					const temporalBright = flatWorkspace.variance[flatCenter]
					const residualDark = meanDark - darkWorkspace.smooth[target]
					const residualBright = meanFlat - flatWorkspace.smooth[target]
					const signal = meanFlat - meanDark
					if (!Number.isFinite(meanDark) || !Number.isFinite(meanFlat) || !Number.isFinite(temporalDark) || !Number.isFinite(temporalBright) || !Number.isFinite(residualDark) || !Number.isFinite(residualBright) || !Number.isFinite(signal)) continue
					count++
					let delta = residualDark - darkMean
					darkMean += delta / count
					darkM2 += delta * (residualDark - darkMean)
					delta = residualBright - brightMean
					brightMean += delta / count
					brightM2 += delta * (residualBright - brightMean)
					delta = signal - signalMean
					signalMean += delta / count
					signalM2 += delta * (signal - signalMean)
					darkTemporalSum += temporalDark
					brightTemporalSum += temporalBright
					darkRow[y] += meanDark
					darkColumn[x] += meanDark
					signalRow[y] += signal
					signalColumn[x] += signal
					darkResidualRow[y] += residualDark
					darkResidualColumn[x] += residualDark
					brightResidualRow[y] += residualBright
					brightResidualColumn[x] += residualBright
					signalSpatialRow[y] += signal
					signalSpatialColumn[x] += signal
					rowCounts[y]++
					columnCounts[x]++
					if (terms > 0) {
						const normalizedX = geometry.width > 1 ? (2 * x) / (geometry.width - 1) - 1 : 0
						const normalizedY = geometry.height > 1 ? (2 * y) / (geometry.height - 1) - 1 : 0
						accumulateSurface(normal, rhs, basis, terms, normalizedX, normalizedY, signal)
					}
					const mapIndex = y * geometry.width + x
					if (dsnuMap) dsnuMap[mapIndex] = residualDark * conversionGain
					if (prnuMap && terms === 0) prnuMap[mapIndex] = detrend === 'none' ? signal : residualBright - residualDark
					if (meanBuffer) meanBuffer[mapIndex] = signal
					if (varianceBuffer) varianceBuffer[mapIndex] = temporalBright + temporalDark
					if (maskBuffer) maskBuffer[mapIndex] = 0
				}
			}
		}
	}

	if (count === 0 || !(signalMean > 0)) throw new RangeError('spatial analysis has no finite positive-signal samples')
	if (prnuMap && terms === 0) {
		const offset = detrend === 'none' ? 1 : 0
		for (let i = 0; i < prnuMap.length; i++) prnuMap[i] = prnuMap[i] / signalMean - offset
	}
	for (let y = 0; y < geometry.height; y++) {
		if (rowCounts[y] > 0) {
			darkRow[y] /= rowCounts[y]
			signalRow[y] /= rowCounts[y]
		} else {
			darkRow[y] = Number.NaN
			signalRow[y] = Number.NaN
		}
	}
	for (let x = 0; x < geometry.width; x++) {
		if (columnCounts[x] > 0) {
			darkColumn[x] /= columnCounts[x]
			signalColumn[x] /= columnCounts[x]
		} else {
			darkColumn[x] = Number.NaN
			signalColumn[x] = Number.NaN
		}
	}

	const darkTemporal = darkTemporalSum / count / dark.frames.length
	const brightTemporal = brightTemporalSum / count / flat.frames.length
	const darkTotalVariance = Math.max(0, darkM2 / count - darkTemporal)
	const brightTotalVariance = Math.max(0, brightM2 / count - brightTemporal)
	const darkRowVariance = Math.max(0, effectVariance(darkResidualRow, rowCounts, darkMean) - weightedTemporalVariance(darkProfileTemporal.highpassRows, rowCounts))
	const darkColumnVariance = Math.max(0, effectVariance(darkResidualColumn, columnCounts, darkMean) - weightedTemporalVariance(darkProfileTemporal.highpassColumns, columnCounts))
	const brightRowVariance = Math.max(0, effectVariance(brightResidualRow, rowCounts, brightMean) - weightedTemporalVariance(brightProfileTemporal.highpassRows, rowCounts))
	const brightColumnVariance = Math.max(0, effectVariance(brightResidualColumn, columnCounts, brightMean) - weightedTemporalVariance(brightProfileTemporal.highpassColumns, columnCounts))
	const signalTotalVariance = Math.max(0, signalM2 / count - darkTemporal - brightTemporal)
	const signalRowVariance = Math.max(0, effectVariance(signalSpatialRow, rowCounts, signalMean) - weightedTemporalVariance(darkProfileTemporal.rawRows, rowCounts) - weightedTemporalVariance(brightProfileTemporal.rawRows, rowCounts))
	const signalColumnVariance = Math.max(0, effectVariance(signalSpatialColumn, columnCounts, signalMean) - weightedTemporalVariance(darkProfileTemporal.rawColumns, columnCounts) - weightedTemporalVariance(brightProfileTemporal.rawColumns, columnCounts))
	const dsnuComponents = components(darkTotalVariance, darkRowVariance, darkColumnVariance, conversionGain)
	const emvaTotal = Math.max(0, brightTotalVariance - darkTotalVariance)
	const emvaRows = Math.max(0, brightRowVariance - darkRowVariance)
	const emvaColumns = Math.max(0, brightColumnVariance - darkColumnVariance)
	const emva = components(emvaTotal, emvaRows, emvaColumns, 1 / signalMean)
	const undetrended = components(signalTotalVariance, signalRowVariance, signalColumnVariance, 1 / signalMean)

	let corrected: SensorSpatialComponents | undefined
	const coefficients = terms > 0 ? solveSurface(normal, rhs, terms) : undefined
	if (coefficients) {
		const correctedRow = new Float64Array(geometry.height)
		const correctedColumn = new Float64Array(geometry.width)
		const correctedRowCounts = new Uint32Array(geometry.height)
		const correctedColumnCounts = new Uint32Array(geometry.width)
		let correctedCount = 0
		let correctedMean = 0
		let correctedM2 = 0
		let correctedTemporalSum = 0
		const correctedResiduals = new SensorRobustReservoir(sampleCapacity)
		for (let tileTop = 0; tileTop < geometry.height; tileTop += tileHeight) {
			const targetHeight = Math.min(tileHeight, geometry.height - tileTop)
			for (let tileLeft = 0; tileLeft < geometry.width; tileLeft += tileWidth) {
				const targetWidth = Math.min(tileWidth, geometry.width - tileLeft)
				const expandedWidth = targetWidth + 18
				fillStackStatistics(dark, geometry, tileLeft, tileTop, targetWidth, targetHeight, darkWorkspace)
				fillStackStatistics(flat, geometry, tileLeft, tileTop, targetWidth, targetHeight, flatWorkspace)
				for (let localY = 0; localY < targetHeight; localY++) {
					const y = tileTop + localY
					const normalizedY = geometry.height > 1 ? (2 * y) / (geometry.height - 1) - 1 : 0
					for (let localX = 0; localX < targetWidth; localX++) {
						const x = tileLeft + localX
						const normalizedX = geometry.width > 1 ? (2 * x) / (geometry.width - 1) - 1 : 0
						const model = surfaceValue(coefficients, normalizedX, normalizedY)
						const darkCenter = (localY + 9) * expandedWidth + localX + 9
						const flatCenter = darkCenter
						const signal = flatWorkspace.mean[flatCenter] - darkWorkspace.mean[darkCenter]
						const temporalDark = darkWorkspace.variance[darkCenter]
						const temporalBright = flatWorkspace.variance[flatCenter]
						if (!Number.isFinite(signal) || !Number.isFinite(model) || Math.abs(model) <= Number.EPSILON || !Number.isFinite(temporalDark) || !Number.isFinite(temporalBright)) continue
						const residual = signal / model - 1
						correctedCount++
						const delta = residual - correctedMean
						correctedMean += delta / correctedCount
						correctedM2 += delta * (residual - correctedMean)
						correctedTemporalSum += (temporalDark / dark.frames.length + temporalBright / flat.frames.length) / (model * model)
						correctedResiduals.push(residual)
						correctedRow[y] += residual
						correctedColumn[x] += residual
						correctedRowCounts[y]++
						correctedColumnCounts[x]++
						if (prnuMap) prnuMap[y * geometry.width + x] = residual
					}
				}
			}
		}
		if (correctedCount > 0) {
			const robustDeviation = correctedResiduals.robustStandardDeviation()
			const correctedVariance = Number.isFinite(robustDeviation) ? Math.max(0, robustDeviation * robustDeviation - correctedTemporalSum / correctedCount) : Math.max(0, correctedM2 / correctedCount - correctedTemporalSum / correctedCount)
			const correctedRowVariance = Math.max(0, effectVariance(correctedRow, correctedRowCounts, correctedMean) - weightedNormalizedTemporalVariance(darkProfileTemporal.rawRows, brightProfileTemporal.rawRows, correctedRowCounts, coefficients, geometry, true))
			const correctedColumnVariance = Math.max(0, effectVariance(correctedColumn, correctedColumnCounts, correctedMean) - weightedNormalizedTemporalVariance(darkProfileTemporal.rawColumns, brightProfileTemporal.rawColumns, correctedColumnCounts, coefficients, geometry, false))
			corrected = components(correctedVariance, correctedRowVariance, correctedColumnVariance, 1)
		}
	}

	return {
		dsnu: { ...dsnuComponents, rowProfile: darkRow, columnProfile: darkColumn, map: dsnuMap },
		prnu: { emva, undetrended, corrected, rowProfile: signalRow, columnProfile: signalColumn, map: prnuMap },
		sampleCount: count,
		signal: signalMean,
	}
}
