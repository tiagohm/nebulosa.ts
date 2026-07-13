import { medianOf } from '../../core/util'
import type { Rect } from '../../math/numerical/geometry'
import { resolveSensorArea, resolveSensorPlaneGeometry, validateSensorSpatialStack, type SensorPlaneGeometry } from './sensor.grid'
import type { SensorFrameSet, SensorPlane, SensorSpatialBuffers } from './sensor.types'

// Robust fixed-pattern defect classification for matched dark and flat stacks. Caller buffers are
// overwritten and reused between passes; a compact mask is retained only when explicitly requested.

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
	readonly cfaOffset?: Readonly<[number, number]>
	// Median absolute deviation multiplier; defaults to five.
	readonly rejectionSigma?: number
	// Known upper digital clipping code in DN for saturated-pixel flags.
	readonly digitalClip?: number
	// Whether to retain a compact defect mask.
	readonly maps?: 'none' | 'defects' | 'all'
	// Caller-owned buffers overwritten by dark/flat statistics and the defect mask.
	readonly spatialBuffers?: SensorSpatialBuffers
}

// Fills per-pixel stack means and unbiased temporal variances on a dense selected-plane grid.
function fillDefectStatistics(set: SensorFrameSet, geometry: SensorPlaneGeometry, mean: Float64Array, variance: Float64Array): void {
	const sourceWidth = set.frames[0].metadata.width
	for (let y = 0; y < geometry.height; y++) {
		const sourceY = geometry.sourceTop + y * geometry.step
		for (let x = 0; x < geometry.width; x++) {
			const sourceIndex = sourceY * sourceWidth + geometry.sourceLeft + x * geometry.step
			const index = y * geometry.width + x
			let count = 0
			let center = 0
			let m2 = 0
			for (const frame of set.frames) {
				const value = frame.raw[sourceIndex]
				if (!Number.isFinite(value)) continue
				count++
				const delta = value - center
				center += delta / count
				m2 += delta * (value - center)
			}
			mean[index] = count > 0 ? center : Number.NaN
			variance[index] = count > 1 ? m2 / (count - 1) : Number.NaN
		}
	}
}

// Computes robust median and raw MAD using one reusable scratch array.
function robustCenterScale(values: Float64Array, scratch: Float64Array): readonly [number, number] {
	let count = 0
	for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) scratch[count++] = values[i]
	if (count === 0) return [Number.NaN, Number.NaN]
	const selected = scratch.subarray(0, count)
	selected.sort()
	const center = medianOf(selected)
	for (let i = 0; i < count; i++) scratch[i] = Math.abs(scratch[i] - center)
	selected.sort()
	return [center, medianOf(selected)]
}

// Adds hot and noisy flags from dark-stack statistics and returns their counts.
function classifyDark(mean: Float64Array, variance: Float64Array, mask: Uint8Array, scratch: Float64Array, sigma: number): readonly [number, number] {
	const dark = robustCenterScale(mean, scratch)
	const temporal = robustCenterScale(variance, scratch)
	const hotLimit = dark[0] + sigma * dark[1]
	const noisyLimit = temporal[0] + sigma * temporal[1]
	let hot = 0
	let noisy = 0
	for (let i = 0; i < mean.length; i++) {
		if (mean[i] > hotLimit) {
			mask[i] |= SENSOR_DEFECT_HOT
			hot++
		}
		if (variance[i] > noisyLimit) {
			mask[i] |= SENSOR_DEFECT_NOISY
			noisy++
		}
	}
	return [hot, noisy]
}

// Adds an approximate RTS/non-Gaussian flag for already-noisy dark pixels using excess kurtosis.
function classifyUnstable(set: SensorFrameSet, geometry: SensorPlaneGeometry, mean: Float64Array, variance: Float64Array, mask: Uint8Array): number {
	const sourceWidth = set.frames[0].metadata.width
	let unstable = 0
	for (let y = 0; y < geometry.height; y++) {
		const sourceY = geometry.sourceTop + y * geometry.step
		for (let x = 0; x < geometry.width; x++) {
			const index = y * geometry.width + x
			if ((mask[index] & SENSOR_DEFECT_NOISY) === 0) continue
			const sourceIndex = sourceY * sourceWidth + geometry.sourceLeft + x * geometry.step
			let count = 0
			let fourth = 0
			for (const frame of set.frames) {
				const value = frame.raw[sourceIndex]
				if (!Number.isFinite(value)) continue
				const residual = value - mean[index]
				const squared = residual * residual
				fourth += squared * squared
				count++
			}
			const populationVariance = count > 1 ? (variance[index] * (count - 1)) / count : 0
			const excess = populationVariance > 0 ? fourth / count / (populationVariance * populationVariance) - 3 : 0
			if (excess < -0.8 || excess > 2) {
				mask[index] |= SENSOR_DEFECT_UNSTABLE
				unstable++
			}
		}
	}
	return unstable
}

// Adds cold and optional saturated flags from the flat-stack mean.
function classifyFlat(mean: Float64Array, mask: Uint8Array, scratch: Float64Array, sigma: number, digitalClip: number | undefined): number {
	const response = robustCenterScale(mean, scratch)
	const coldLimit = response[0] - sigma * response[1]
	let cold = 0
	for (let i = 0; i < mean.length; i++) {
		if (mean[i] < coldLimit) {
			mask[i] |= SENSOR_DEFECT_COLD
			cold++
		}
		if (digitalClip !== undefined && mean[i] >= digitalClip) mask[i] |= SENSOR_DEFECT_SATURATED
	}
	return cold
}

// Computes dense row/column profiles from the final flat-stack mean.
function fillProfiles(mean: Float64Array, width: number, height: number, rows: Float64Array, columns: Float64Array): void {
	for (let y = 0; y < height; y++) {
		let sum = 0
		for (let x = 0; x < width; x++) sum += mean[y * width + x]
		rows[y] = sum / width
	}
	for (let x = 0; x < width; x++) {
		let sum = 0
		for (let y = 0; y < height; y++) sum += mean[y * width + x]
		columns[x] = sum / height
	}
}

// Detects structural rows and columns from defect density or robust profile deviations.
function classifyStructures(mean: Float64Array, mask: Uint8Array, width: number, height: number, sigma: number): readonly [readonly number[], readonly number[]] {
	const rowProfiles = new Float64Array(height)
	const columnProfiles = new Float64Array(width)
	fillProfiles(mean, width, height, rowProfiles, columnProfiles)
	const scratch = new Float64Array(Math.max(width, height))
	const rowStats = robustCenterScale(rowProfiles, scratch)
	const columnStats = robustCenterScale(columnProfiles, scratch)
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

// Classifies defects in matched fixed-exposure dark and flat stacks. Returns undefined without
// retained maps when the caller did not provide all three reusable spatial buffers.
export function measureSensorDefects(dark: SensorFrameSet, flat: SensorFrameSet, options: Partial<SensorDefectOptions> = {}): SensorDefects | undefined {
	if (dark.exposure !== flat.exposure) throw new RangeError('defect dark and flat stacks must have matching exposure')
	const reference = dark.frames[0]
	validateSensorSpatialStack(dark, reference)
	validateSensorSpatialStack(flat, reference)
	const area = resolveSensorArea(options.area, reference.metadata.width, reference.metadata.height)
	const geometry = resolveSensorPlaneGeometry(reference, area, options.plane, options.cfaOffset)
	const capacity = geometry.width * geometry.height
	const retainMask = options.maps === 'defects' || options.maps === 'all'
	const supplied = options.spatialBuffers?.mean && options.spatialBuffers.variance && options.spatialBuffers.mask
	if (!retainMask && !supplied) return undefined
	const mean = options.spatialBuffers?.mean ?? new Float64Array(capacity)
	const variance = options.spatialBuffers?.variance ?? new Float64Array(capacity)
	const mask = options.spatialBuffers?.mask ?? new Uint8Array(capacity)
	if (mean.length < capacity || variance.length < capacity || mask.length < capacity) throw new RangeError('defect buffer is smaller than the selected plane/ROI')
	const activeMean = mean.subarray(0, capacity)
	const activeVariance = variance.subarray(0, capacity)
	const activeMask = mask.subarray(0, capacity)
	activeMask.fill(0)
	const sigma = options.rejectionSigma ?? 5
	if (!Number.isFinite(sigma) || sigma <= 0) throw new RangeError('defect rejection sigma must be finite and positive')
	const scratch = new Float64Array(capacity)
	fillDefectStatistics(dark, geometry, activeMean, activeVariance)
	const darkCounts = classifyDark(activeMean, activeVariance, activeMask, scratch, sigma)
	const unstable = dark.frames.length >= 8 ? classifyUnstable(dark, geometry, activeMean, activeVariance, activeMask) : 0
	fillDefectStatistics(flat, geometry, activeMean, activeVariance)
	const cold = classifyFlat(activeMean, activeMask, scratch, sigma, options.digitalClip)
	const structures = classifyStructures(activeMean, activeMask, geometry.width, geometry.height, sigma)
	return { mask: retainMask ? activeMask : undefined, hot: darkCounts[0], cold, noisy: darkCounts[1], unstable, rows: structures[0], columns: structures[1] }
}
