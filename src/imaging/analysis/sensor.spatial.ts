import { gaussianElimination, Matrix } from '../../math/linear-algebra/matrix'
import type { Rect } from '../../math/numerical/geometry'
import type { DigitalImage } from '../model/types'
import type { SensorFrameSet, SensorPlane, SensorSpatialBuffers, SensorTileOptions } from './sensor.types'

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
	readonly cfaOffset?: Readonly<[number, number]>
	// Illumination detrending used for optional practical PRNU.
	readonly spatialDetrend?: 'none' | 'emvaHighpass' | 'plane' | 'polynomial'
	// Diagnostic maps to retain; only all retains DSNU/PRNU maps in this phase.
	readonly maps?: 'none' | 'defects' | 'all'
	// Caller-provided buffers validated for the selected plane-grid size.
	readonly spatialBuffers?: SensorSpatialBuffers
	// Target tile size before adding the nine-pixel filter halo.
	readonly tile?: Readonly<SensorTileOptions>
}

// Selected plane-grid geometry mapped back to source image coordinates.
interface PlaneGeometry {
	// First selected source x coordinate.
	readonly sourceLeft: number
	// First selected source y coordinate.
	readonly sourceTop: number
	// Source-coordinate step between plane samples.
	readonly step: number
	// Plane-grid width.
	readonly width: number
	// Plane-grid height.
	readonly height: number
}

// Fixed reusable buffers for one expanded tile and the valid-convolution stages.
interface SpatialWorkspace {
	// Per-pixel stack mean on the expanded tile.
	readonly mean: Float64Array
	// Per-pixel sample temporal variance on the expanded tile.
	readonly variance: Float64Array
	// Horizontal box-filter workspace.
	readonly horizontal: Float64Array
	// First valid box-filter output.
	readonly first: Float64Array
	// Second horizontal box-filter workspace.
	readonly secondHorizontal: Float64Array
	// Second valid box-filter output.
	readonly second: Float64Array
	// Final binomial-smoothed target tile.
	readonly smooth: Float64Array
}

// Resolves a validated image ROI.
function resolveArea(area: Readonly<Rect> | undefined, width: number, height: number): Readonly<Rect> {
	const roi = area ?? { left: 0, top: 0, right: width, bottom: height }
	if (!Number.isInteger(roi.left) || !Number.isInteger(roi.top) || !Number.isInteger(roi.right) || !Number.isInteger(roi.bottom) || roi.left < 0 || roi.top < 0 || roi.right > width || roi.bottom > height || roi.left >= roi.right || roi.top >= roi.bottom)
		throw new RangeError('spatial sensor area must be a non-empty inclusive-exclusive integer rectangle')
	return roi
}

// Returns the selected row-major CFA slot, or -1 for mono.
function planeSlot(pattern: string | undefined, plane: SensorPlane | undefined): number {
	if (!pattern) {
		if (plane !== undefined && plane !== 'mono') throw new RangeError('non-CFA spatial analysis supports only the mono plane')
		return -1
	}
	if (plane === undefined || plane === 'mono') throw new RangeError('CFA spatial analysis requires an explicit color plane')
	const channel = plane === 'red' ? 'R' : plane === 'blue' ? 'B' : 'G'
	const slot = plane === 'green2' ? pattern.indexOf(channel, pattern.indexOf(channel) + 1) : pattern.indexOf(channel)
	if (slot < 0) throw new RangeError(`sensor plane ${plane} is absent from CFA pattern ${pattern}`)
	return slot
}

// Maps an image ROI to the dense mono or CFA-plane grid used by spatial filters.
function planeGeometry(image: DigitalImage, area: Readonly<Rect>, plane: SensorPlane | undefined, cfaOffset: Readonly<[number, number]> | undefined): PlaneGeometry {
	const slot = planeSlot(image.metadata.bayer, plane)
	if (slot < 0) return { sourceLeft: area.left, sourceTop: area.top, step: 1, width: area.right - area.left, height: area.bottom - area.top }
	const offsetX = cfaOffset?.[0]
	const offsetY = cfaOffset?.[1]
	if (!Number.isInteger(offsetX) || !Number.isInteger(offsetY)) throw new RangeError('CFA spatial analysis requires an integer sensor origin')
	const xParity = slot & 1
	const yParity = slot >>> 1
	let sourceLeft = area.left
	let sourceTop = area.top
	if (((sourceLeft + offsetX!) & 1) !== xParity) sourceLeft++
	if (((sourceTop + offsetY!) & 1) !== yParity) sourceTop++
	const width = sourceLeft < area.right ? Math.floor((area.right - 1 - sourceLeft) / 2) + 1 : 0
	const height = sourceTop < area.bottom ? Math.floor((area.bottom - 1 - sourceTop) / 2) + 1 : 0
	if (width <= 0 || height <= 0) throw new RangeError('selected CFA plane has no samples inside the spatial ROI')
	return { sourceLeft, sourceTop, step: 2, width, height }
}

// Validates a stack against reference image structure and selected plane-grid storage.
function validateStack(set: SensorFrameSet, reference: DigitalImage): void {
	if (set.frames.length < 2) throw new RangeError('spatial stack requires at least two frames')
	for (const frame of set.frames) {
		if (frame.sampleScale !== 'digital') throw new TypeError('spatial analysis requires digital images')
		if (frame.metadata.width !== reference.metadata.width || frame.metadata.height !== reference.metadata.height || frame.metadata.channels !== 1 || frame.metadata.bayer !== reference.metadata.bayer) throw new RangeError('spatial stack frames must share dimensions and CFA pattern')
		if (frame.raw.length < frame.metadata.pixelCount) throw new RangeError('spatial frame buffer is smaller than declared geometry')
	}
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
		first: new Float64Array((expandedWidth - 6) * (expandedHeight - 6)),
		secondHorizontal: new Float64Array((expandedWidth - 16) * (expandedHeight - 6)),
		second: new Float64Array((expandedWidth - 16) * (expandedHeight - 16)),
		smooth: new Float64Array(tileWidth * tileHeight),
	}
}

// Fills expanded plane-grid stack mean and unbiased temporal variance, clamping the filter halo to edges.
function fillStackStatistics(set: SensorFrameSet, geometry: PlaneGeometry, tileLeft: number, tileTop: number, targetWidth: number, targetHeight: number, workspace: SpatialWorkspace): readonly [number, number] {
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
			for (const frame of set.frames) {
				const value = frame.raw[index]
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
	return [expandedWidth, expandedHeight]
}

// Applies a separable valid box filter without allocating per pass.
function boxValid(input: Float64Array, width: number, height: number, radius: number, horizontal: Float64Array, output: Float64Array): readonly [number, number] {
	const kernel = radius * 2 + 1
	const outputWidth = width - radius * 2
	const outputHeight = height - radius * 2
	for (let y = 0; y < height; y++) {
		const row = y * width
		const targetRow = y * outputWidth
		let sum = 0
		for (let x = 0; x < kernel; x++) sum += input[row + x]
		horizontal[targetRow] = sum / kernel
		for (let x = 1; x < outputWidth; x++) {
			sum += input[row + x + kernel - 1] - input[row + x - 1]
			horizontal[targetRow + x] = sum / kernel
		}
	}
	for (let x = 0; x < outputWidth; x++) {
		let sum = 0
		for (let y = 0; y < kernel; y++) sum += horizontal[y * outputWidth + x]
		output[x] = sum / kernel
		for (let y = 1; y < outputHeight; y++) {
			sum += horizontal[(y + kernel - 1) * outputWidth + x] - horizontal[(y - 1) * outputWidth + x]
			output[y * outputWidth + x] = sum / kernel
		}
	}
	return [outputWidth, outputHeight]
}

// Applies the final valid binomial 3x3 filter to produce the target tile.
function binomialValid(input: Float64Array, width: number, height: number, output: Float64Array): void {
	const outputWidth = width - 2
	const outputHeight = height - 2
	for (let y = 0; y < outputHeight; y++) {
		for (let x = 0; x < outputWidth; x++) {
			const top = y * width + x
			const middle = top + width
			const bottom = middle + width
			output[y * outputWidth + x] = (input[top] + 2 * input[top + 1] + input[top + 2] + 2 * input[middle] + 4 * input[middle + 1] + 2 * input[middle + 2] + input[bottom] + 2 * input[bottom + 1] + input[bottom + 2]) / 16
		}
	}
}

// Computes the prescribed sequential high-pass smoothing for the current expanded stack mean.
function smoothTarget(workspace: SpatialWorkspace, expandedWidth: number, expandedHeight: number): void {
	const firstSize = boxValid(workspace.mean, expandedWidth, expandedHeight, 3, workspace.horizontal, workspace.first)
	const secondSize = boxValid(workspace.first, firstSize[0], firstSize[1], 5, workspace.secondHorizontal, workspace.second)
	binomialValid(workspace.second, secondSize[0], secondSize[1], workspace.smooth)
}

// Adds basis outer products and response products for plane or quadratic detrending.
function accumulateSurface(normal: Float64Array, rhs: Float64Array, basis: Float64Array, terms: number, x: number, y: number, value: number): void {
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
	const rows = Math.max(0, Math.min(total, rowVariance))
	const columns = Math.max(0, Math.min(total - rows, columnVariance))
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

// Measures DSNU and PRNU for matched fixed-exposure dark and bright stacks.
export function measureSensorSpatial(dark: SensorFrameSet, flat: SensorFrameSet, conversionGain: number, options: Partial<SensorSpatialOptions> = {}): SensorSpatialCharacterization {
	if (!Number.isFinite(conversionGain) || conversionGain <= 0) throw new RangeError('spatial conversion gain must be finite and positive')
	if (dark.exposure !== flat.exposure) throw new RangeError('spatial dark and flat stacks must have matching exposure')
	const reference = dark.frames[0]
	validateStack(dark, reference)
	validateStack(flat, reference)
	const area = resolveArea(options.area, reference.metadata.width, reference.metadata.height)
	const geometry = planeGeometry(reference, area, options.plane, options.cfaOffset)
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
			const darkExpanded = fillStackStatistics(dark, geometry, tileLeft, tileTop, targetWidth, targetHeight, darkWorkspace)
			smoothTarget(darkWorkspace, darkExpanded[0], darkExpanded[1])
			const flatExpanded = fillStackStatistics(flat, geometry, tileLeft, tileTop, targetWidth, targetHeight, flatWorkspace)
			smoothTarget(flatWorkspace, flatExpanded[0], flatExpanded[1])
			for (let localY = 0; localY < targetHeight; localY++) {
				const y = tileTop + localY
				for (let localX = 0; localX < targetWidth; localX++) {
					const x = tileLeft + localX
					const target = localY * targetWidth + localX
					const darkCenter = (localY + 9) * darkExpanded[0] + localX + 9
					const flatCenter = (localY + 9) * flatExpanded[0] + localX + 9
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
					if (prnuMap && terms === 0) prnuMap[mapIndex] = residualBright - residualDark
					if (meanBuffer) meanBuffer[mapIndex] = signal
					if (varianceBuffer) varianceBuffer[mapIndex] = temporalBright + temporalDark
					if (maskBuffer) maskBuffer[mapIndex] = 0
				}
			}
		}
	}

	if (count === 0 || !(signalMean > 0)) throw new RangeError('spatial analysis has no finite positive-signal samples')
	if (prnuMap && terms === 0) for (let i = 0; i < prnuMap.length; i++) prnuMap[i] /= signalMean
	for (let y = 0; y < geometry.height; y++) {
		if (rowCounts[y] > 0) {
			darkRow[y] /= rowCounts[y]
			signalRow[y] /= rowCounts[y]
		}
	}
	for (let x = 0; x < geometry.width; x++) {
		if (columnCounts[x] > 0) {
			darkColumn[x] /= columnCounts[x]
			signalColumn[x] /= columnCounts[x]
		}
	}

	const darkTemporal = darkTemporalSum / count / dark.frames.length
	const brightTemporal = brightTemporalSum / count / flat.frames.length
	const darkTotalVariance = Math.max(0, darkM2 / count - darkTemporal)
	const brightTotalVariance = Math.max(0, brightM2 / count - brightTemporal)
	const darkRowVariance = effectVariance(darkResidualRow, rowCounts, darkMean)
	const darkColumnVariance = effectVariance(darkResidualColumn, columnCounts, darkMean)
	const brightRowVariance = effectVariance(brightResidualRow, rowCounts, brightMean)
	const brightColumnVariance = effectVariance(brightResidualColumn, columnCounts, brightMean)
	const signalTotalVariance = signalM2 / count
	const signalRowVariance = effectVariance(signalSpatialRow, rowCounts, signalMean)
	const signalColumnVariance = effectVariance(signalSpatialColumn, columnCounts, signalMean)
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
		for (let tileTop = 0; tileTop < geometry.height; tileTop += tileHeight) {
			const targetHeight = Math.min(tileHeight, geometry.height - tileTop)
			for (let tileLeft = 0; tileLeft < geometry.width; tileLeft += tileWidth) {
				const targetWidth = Math.min(tileWidth, geometry.width - tileLeft)
				const darkExpanded = fillStackStatistics(dark, geometry, tileLeft, tileTop, targetWidth, targetHeight, darkWorkspace)
				const flatExpanded = fillStackStatistics(flat, geometry, tileLeft, tileTop, targetWidth, targetHeight, flatWorkspace)
				for (let localY = 0; localY < targetHeight; localY++) {
					const y = tileTop + localY
					const normalizedY = geometry.height > 1 ? (2 * y) / (geometry.height - 1) - 1 : 0
					for (let localX = 0; localX < targetWidth; localX++) {
						const x = tileLeft + localX
						const normalizedX = geometry.width > 1 ? (2 * x) / (geometry.width - 1) - 1 : 0
						const model = surfaceValue(coefficients, normalizedX, normalizedY)
						const darkCenter = (localY + 9) * darkExpanded[0] + localX + 9
						const flatCenter = (localY + 9) * flatExpanded[0] + localX + 9
						const signal = flatWorkspace.mean[flatCenter] - darkWorkspace.mean[darkCenter]
						if (!Number.isFinite(signal) || !Number.isFinite(model) || Math.abs(model) <= Number.EPSILON) continue
						const residual = signal / model - 1
						correctedCount++
						const delta = residual - correctedMean
						correctedMean += delta / correctedCount
						correctedM2 += delta * (residual - correctedMean)
						correctedRow[y] += residual
						correctedColumn[x] += residual
						correctedRowCounts[y]++
						correctedColumnCounts[x]++
						if (prnuMap) prnuMap[y * geometry.width + x] = residual
					}
				}
			}
		}
		if (correctedCount > 0) corrected = components(correctedM2 / correctedCount, effectVariance(correctedRow, correctedRowCounts, correctedMean), effectVariance(correctedColumn, correctedColumnCounts, correctedMean), 1)
	}

	return {
		dsnu: { ...dsnuComponents, rowProfile: darkRow, columnProfile: darkColumn, map: dsnuMap },
		prnu: { emva, undetrended, corrected, rowProfile: signalRow, columnProfile: signalColumn, map: prnuMap },
		sampleCount: count,
		signal: signalMean,
	}
}
