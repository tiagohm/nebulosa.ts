import { medianOf } from '../../core/util'
import type { Rect } from '../../math/numerical/geometry'
import { resolveSensorArea, resolveSensorPlaneGeometry, validateSensorSpatialStack } from './sensor.grid'
import { SensorRobustReservoir } from './sensor.reservoir'
import type { SensorFrameSet, SensorPlane, SensorSpatialBuffers } from './sensor.types'

// Bounded-memory fixed-pattern defect classification for matched dark and flat stacks. Statistics
// are reread in three passes; only a compact mask, O(width+height) profiles, and fixed robust samples
// are retained. Caller buffers are overwritten with response and combined temporal variance.

// Defect categories represented by the compact per-pixel bit mask.
export type SensorDefectType = 'hot' | 'cold' | 'noisy' | 'unstable' | 'saturated' | 'row' | 'column'

// Bit marking a persistently elevated dark pixel.
export const SENSOR_DEFECT_HOT = 1 << 0
// Bit marking a persistently weak flat-response pixel.
export const SENSOR_DEFECT_COLD = 1 << 1
// Bit marking excessive temporal variance.
export const SENSOR_DEFECT_NOISY = 1 << 2
// Bit marking non-Gaussian high-variance temporal behavior.
export const SENSOR_DEFECT_UNSTABLE = 1 << 3
// Bit marking a flat-stack pixel at the configured digital clipping code.
export const SENSOR_DEFECT_SATURATED = 1 << 4

// Defect counts, structural row/column indices, and optional dense plane-grid mask.
export interface SensorDefects {
	// Compact bit mask on the selected plane grid when maps are requested.
	readonly mask?: Uint8Array
	// Number of pixels with elevated persistent dark signal.
	readonly hot: number
	// Number of pixels with depressed persistent flat response.
	readonly cold: number
	// Number of pixels with excessive temporal variance.
	readonly noisy: number
	// Number of noisy pixels with non-Gaussian temporal behavior.
	readonly unstable: number
	// Dense plane-grid rows containing an anomalous aggregate or robust profile deviation.
	readonly rows: readonly number[]
	// Dense plane-grid columns containing an anomalous aggregate or robust profile deviation.
	readonly columns: readonly number[]
}

// Options controlling robust thresholds, CFA selection, resources, and retained maps.
export interface SensorDefectOptions {
	// Inclusive-exclusive image ROI; defaults to the full frame.
	readonly area?: Readonly<Rect>
	// Mono or CFA plane to classify.
	readonly plane?: SensorPlane
	// CFA phase offset of image coordinate (0,0), unbinned sensor pixels.
	readonly cfaOffset?: readonly [number, number]
	// Median absolute deviation multiplier; defaults to five.
	readonly rejectionSigma?: number
	// Known upper digital clipping code in DN for saturated-pixel flags.
	readonly digitalClip?: number
	// Whether to retain a compact defect mask.
	readonly maps?: 'none' | 'defects' | 'all'
	// Caller-owned response, variance, and mask buffers overwritten during classification.
	readonly spatialBuffers?: SensorSpatialBuffers
}

// Computes finite stack mean and unbiased temporal variance for one source pixel into output[0..1].
function pixelStatistics(set: SensorFrameSet, sourceIndex: number, output: Float64Array): void {
	let count = 0
	let mean = 0
	let m2 = 0
	for (let frameIndex = 0; frameIndex < set.frames.length; frameIndex++) {
		const value = set.frames[frameIndex].raw[sourceIndex]
		if (!Number.isFinite(value)) continue
		count++
		const delta = value - mean
		mean += delta / count
		m2 += delta * (value - mean)
	}
	output[0] = count > 0 ? mean : Number.NaN
	output[1] = count > 1 ? m2 / (count - 1) : Number.NaN
}

// Computes excess kurtosis around the measured dark mean for one source pixel.
function excessKurtosis(set: SensorFrameSet, sourceIndex: number, mean: number, sampleVariance: number): number {
	let count = 0
	let fourth = 0
	for (let frameIndex = 0; frameIndex < set.frames.length; frameIndex++) {
		const value = set.frames[frameIndex].raw[sourceIndex]
		if (!Number.isFinite(value)) continue
		const residual = value - mean
		const squared = residual * residual
		fourth += squared * squared
		count++
	}
	const populationVariance = count > 1 ? (sampleVariance * (count - 1)) / count : 0
	return populationVariance > 0 ? fourth / count / (populationVariance * populationVariance) - 3 : 0
}

// Computes an exact robust center and MAD for a small row/column profile.
function robustCenterScale(values: Float64Array): readonly [number, number] {
	let count = 0
	const scratch = new Float64Array(values.length)
	for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) scratch[count++] = values[i]
	if (count === 0) return [Number.NaN, Number.NaN]
	const selected = scratch.subarray(0, count)
	const center = medianOf(selected.sort())
	for (let i = 0; i < count; i++) scratch[i] = Math.abs(scratch[i] - center)
	return [center, medianOf(selected.sort())]
}

// Detects structural rows and columns from defect density or robust response-profile deviations.
function classifyStructures(rowProfiles: Float64Array, columnProfiles: Float64Array, mask: Uint8Array, width: number, height: number, sigma: number): readonly [readonly number[], readonly number[]] {
	const rowStats = robustCenterScale(rowProfiles)
	const columnStats = robustCenterScale(columnProfiles)
	const rows: number[] = []
	const columns: number[] = []
	for (let y = 0; y < height; y++) {
		let anomalies = 0
		for (let x = 0; x < width; x++) if ((mask[y * width + x] & 0x0f) !== 0) anomalies++
		if (anomalies >= Math.max(2, Math.ceil(width * 0.25)) || Math.abs(rowProfiles[y] - rowStats[0]) > sigma * rowStats[1]) rows.push(y)
	}
	for (let x = 0; x < width; x++) {
		let anomalies = 0
		for (let y = 0; y < height; y++) if ((mask[y * width + x] & 0x0f) !== 0) anomalies++
		if (anomalies >= Math.max(2, Math.ceil(height * 0.25)) || Math.abs(columnProfiles[x] - columnStats[0]) > sigma * columnStats[1]) columns.push(x)
	}
	return [rows, columns]
}

// Classifies defects in matched fixed-exposure dark and flat stacks using three bounded passes.
export function measureSensorDefects(dark: SensorFrameSet, flat: SensorFrameSet, options: Partial<SensorDefectOptions> = {}): SensorDefects | undefined {
	if (!Number.isFinite(dark.exposure) || dark.exposure < 0 || !Number.isFinite(flat.exposure) || flat.exposure < 0 || dark.exposure !== flat.exposure) throw new RangeError('defect dark and flat stacks must have matching finite non-negative exposure')
	if (options.digitalClip !== undefined && !Number.isFinite(options.digitalClip)) throw new RangeError('defect digital clip must be finite')
	const reference = dark.frames[0]
	validateSensorSpatialStack(dark, reference)
	validateSensorSpatialStack(flat, reference)
	const area = resolveSensorArea(options.area, reference.metadata.width, reference.metadata.height)
	const geometry = resolveSensorPlaneGeometry(reference, area, options.plane, options.cfaOffset)
	const capacity = geometry.width * geometry.height
	const retainMask = options.maps === 'defects' || options.maps === 'all'
	const supplied = options.spatialBuffers?.mean && options.spatialBuffers.variance && options.spatialBuffers.mask
	if (!retainMask && !supplied) return undefined
	const meanBuffer = options.spatialBuffers?.mean
	const varianceBuffer = options.spatialBuffers?.variance
	const mask = options.spatialBuffers?.mask ?? new Uint8Array(capacity)
	if ((meanBuffer && meanBuffer.length < capacity) || (varianceBuffer && varianceBuffer.length < capacity) || mask.length < capacity) throw new RangeError('defect buffer is smaller than the selected plane/ROI')
	const activeMask = mask.subarray(0, capacity)
	activeMask.fill(0)
	if (meanBuffer) meanBuffer.fill(Number.NaN, 0, capacity)
	if (varianceBuffer) varianceBuffer.fill(Number.NaN, 0, capacity)
	const sigma = options.rejectionSigma ?? 5
	if (!Number.isFinite(sigma) || sigma <= 0) throw new RangeError('defect rejection sigma must be finite and positive')

	const darkMeans = new SensorRobustReservoir(capacity)
	const darkVariances = new SensorRobustReservoir(capacity)
	const responses = new SensorRobustReservoir(capacity)
	const sourceWidth = reference.metadata.width
	const darkStatistics = new Float64Array(2)
	const flatStatistics = new Float64Array(2)
	for (let y = 0; y < geometry.height; y++) {
		const sourceY = geometry.sourceTop + y * geometry.step
		for (let x = 0; x < geometry.width; x++) {
			const sourceIndex = sourceY * sourceWidth + geometry.sourceLeft + x * geometry.step
			pixelStatistics(dark, sourceIndex, darkStatistics)
			pixelStatistics(flat, sourceIndex, flatStatistics)
			darkMeans.push(darkStatistics[0])
			darkVariances.push(darkStatistics[1])
			responses.push(flatStatistics[0] - darkStatistics[0])
		}
	}
	const darkCenter = darkMeans.median()
	const varianceCenter = darkVariances.median()
	const responseCenter = responses.median()
	if (!Number.isFinite(darkCenter) || !Number.isFinite(varianceCenter) || !Number.isFinite(responseCenter)) throw new RangeError('defect analysis has no finite stack statistics')

	const darkDeviations = new SensorRobustReservoir(capacity)
	const varianceDeviations = new SensorRobustReservoir(capacity)
	const responseDeviations = new SensorRobustReservoir(capacity)
	for (let y = 0; y < geometry.height; y++) {
		const sourceY = geometry.sourceTop + y * geometry.step
		for (let x = 0; x < geometry.width; x++) {
			const sourceIndex = sourceY * sourceWidth + geometry.sourceLeft + x * geometry.step
			pixelStatistics(dark, sourceIndex, darkStatistics)
			pixelStatistics(flat, sourceIndex, flatStatistics)
			darkDeviations.push(Math.abs(darkStatistics[0] - darkCenter))
			varianceDeviations.push(Math.abs(darkStatistics[1] - varianceCenter))
			responseDeviations.push(Math.abs(flatStatistics[0] - darkStatistics[0] - responseCenter))
		}
	}
	const hotLimit = darkCenter + sigma * darkDeviations.median()
	const noisyLimit = varianceCenter + sigma * varianceDeviations.median()
	const coldLimit = responseCenter - sigma * responseDeviations.median()
	const rowProfiles = new Float64Array(geometry.height)
	const columnProfiles = new Float64Array(geometry.width)
	const rowCounts = new Uint32Array(geometry.height)
	const columnCounts = new Uint32Array(geometry.width)
	let hot = 0
	let cold = 0
	let noisy = 0
	let unstable = 0
	for (let y = 0; y < geometry.height; y++) {
		const sourceY = geometry.sourceTop + y * geometry.step
		for (let x = 0; x < geometry.width; x++) {
			const sourceIndex = sourceY * sourceWidth + geometry.sourceLeft + x * geometry.step
			const index = y * geometry.width + x
			pixelStatistics(dark, sourceIndex, darkStatistics)
			pixelStatistics(flat, sourceIndex, flatStatistics)
			const darkMean = darkStatistics[0]
			const darkVariance = darkStatistics[1]
			const flatMean = flatStatistics[0]
			const response = flatMean - darkMean
			if (darkMean > hotLimit) {
				activeMask[index] |= SENSOR_DEFECT_HOT
				hot++
			}
			if (darkVariance > noisyLimit) {
				activeMask[index] |= SENSOR_DEFECT_NOISY
				noisy++
				if (dark.frames.length >= 8) {
					const excess = excessKurtosis(dark, sourceIndex, darkMean, darkVariance)
					if (excess < -0.8 || excess > 2) {
						activeMask[index] |= SENSOR_DEFECT_UNSTABLE
						unstable++
					}
				}
			}
			if (response < coldLimit) {
				activeMask[index] |= SENSOR_DEFECT_COLD
				cold++
			}
			if (options.digitalClip !== undefined && flatMean >= options.digitalClip) activeMask[index] |= SENSOR_DEFECT_SATURATED
			if (Number.isFinite(response)) {
				rowProfiles[y] += response
				columnProfiles[x] += response
				rowCounts[y]++
				columnCounts[x]++
			}
			if (meanBuffer) meanBuffer[index] = response
			if (varianceBuffer) varianceBuffer[index] = darkVariance + flatStatistics[1]
		}
	}
	for (let y = 0; y < geometry.height; y++) rowProfiles[y] = rowCounts[y] > 0 ? rowProfiles[y] / rowCounts[y] : Number.NaN
	for (let x = 0; x < geometry.width; x++) columnProfiles[x] = columnCounts[x] > 0 ? columnProfiles[x] / columnCounts[x] : Number.NaN
	const structures = classifyStructures(rowProfiles, columnProfiles, activeMask, geometry.width, geometry.height, sigma)
	return { mask: retainMask ? activeMask : undefined, hot, cold, noisy, unstable, rows: structures[0], columns: structures[1] }
}
