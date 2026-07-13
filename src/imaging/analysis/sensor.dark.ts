import { medianOf } from '../../core/util'
import { weightedLinearRegression, weightedLinearRegressionScore } from '../../math/numerical/regression'
import { aggregateSensorPairs, measureSensorPair, type SensorPairOptions, type SensorPairStatistics } from './sensor.pair'
import type { SensorRegressionFit } from './sensor.ptc'
import type { SensorFrameSet, SensorPlane, SensorTileOptions } from './sensor.types'

// Dark-current analysis across multiple exposure times. Mean and temporal-variance slopes are fitted
// independently with unknown intercepts and converted to electrons/pixel/second. Optional tile slopes
// retain localized amp-glow structure without allocating full-resolution maps.

// Tile-resolved dark-current summary used to identify localized amplifier glow.
export interface SensorAmpGlow {
	// Tile width in output pixels.
	readonly tileWidth: number
	// Tile height in output pixels.
	readonly tileHeight: number
	// Number of tile columns.
	readonly columns: number
	// Number of tile rows.
	readonly rows: number
	// Dark-current slope for each row-major tile, electrons/pixel/second.
	readonly current: Float32Array
	// Median tile current, electrons/pixel/second.
	readonly median: number
	// Maximum tile current, electrons/pixel/second.
	readonly maximum: number
	// Maximum minus median tile current, electrons/pixel/second.
	readonly excess: number
	// Maximum-to-median ratio when the median is positive.
	readonly ratio?: number
}

// Dark-current estimates from mean and temporal-variance growth.
export interface SensorDarkCurrent {
	// Current estimated from mean dark signal, electrons/pixel/second.
	readonly mean: number
	// Current estimated independently from temporal variance, electrons/pixel/second.
	readonly variance?: number
	// Weighted mean-signal regression report.
	readonly meanFit: SensorRegressionFit
	// Weighted temporal-variance regression report.
	readonly varianceFit?: SensorRegressionFit
	// Mean recorded sensor temperature, degrees Celsius.
	readonly temperature?: number
	// Tile-resolved localized dark-current summary.
	readonly ampGlow?: SensorAmpGlow
}

// Dark-current options shared with paired and tiled measurements.
export interface SensorDarkCurrentOptions extends SensorPairOptions {
	// Tile dimensions for amp-glow analysis; defaults to 64x64 output pixels.
	readonly tile?: Readonly<SensorTileOptions>
}

// Converts generic weighted score fields into the sensor regression contract.
function sensorFit(regression: ReturnType<typeof weightedLinearRegression>, x: Float64Array, y: Float64Array, weights: Float64Array): SensorRegressionFit {
	const score = weightedLinearRegressionScore(regression, x, y, weights)
	return {
		r: score.r,
		r2: score.r2,
		rss: score.rss,
		rmsd: score.rmsd,
		pointCount: score.pointCount,
		weighted: true,
		slopeStandardError: score.slopeStandardError,
		interceptStandardError: score.interceptStandardError,
	}
}

// Returns the selected 2x2 CFA slot, or -1 for mono.
function planeSlot(pattern: string | undefined, plane: SensorPlane | undefined): number {
	if (!pattern) {
		if (plane !== undefined && plane !== 'mono') throw new RangeError('non-CFA dark analysis supports only the mono plane')
		return -1
	}
	if (plane === undefined || plane === 'mono') throw new RangeError('CFA dark analysis requires an explicit color plane')
	const channel = plane === 'red' ? 'R' : plane === 'blue' ? 'B' : 'G'
	return plane === 'green2' ? pattern.indexOf(channel, pattern.indexOf(channel) + 1) : pattern.indexOf(channel)
}

// Measures and groups non-overlapping dark pairs by exact exposure duration.
function darkLevels(darks: readonly SensorFrameSet[], options: Partial<SensorPairOptions>): readonly { exposure: number; statistics: ReturnType<typeof aggregateSensorPairs> }[] {
	const grouped = new Map<number, SensorPairStatistics[]>()
	for (const set of darks) {
		if (!Number.isFinite(set.exposure) || set.exposure < 0) throw new RangeError('dark exposure must be finite and non-negative')
		let group = grouped.get(set.exposure)
		if (!group) grouped.set(set.exposure, (group = []))
		for (let i = 0; i + 1 < set.frames.length; i += 2) group.push(measureSensorPair(set.frames[i], set.frames[i + 1], options))
	}
	const levels: { exposure: number; statistics: ReturnType<typeof aggregateSensorPairs> }[] = []
	for (const [exposure, pairs] of grouped) {
		if (pairs.length > 0) levels.push({ exposure, statistics: aggregateSensorPairs(pairs) })
	}
	levels.sort((a, b) => a.exposure - b.exposure)
	if (levels.length < 3) throw new RangeError('dark-current regression requires at least three distinct exposure times')
	return levels
}

// Computes the mean of one frame stack for each output tile and selected sensor plane.
function tileMeans(set: SensorFrameSet, tileWidth: number, tileHeight: number, plane: SensorPlane | undefined, cfaOffset: Readonly<[number, number]> | undefined): Float64Array {
	const first = set.frames[0]
	const { width, height, bayer } = first.metadata
	const columns = Math.ceil(width / tileWidth)
	const rows = Math.ceil(height / tileHeight)
	const sums = new Float64Array(columns * rows)
	const counts = new Uint32Array(columns * rows)
	const slot = planeSlot(bayer, plane)
	const offsetX = cfaOffset?.[0] ?? 0
	const offsetY = cfaOffset?.[1] ?? 0

	for (const frame of set.frames) {
		if (frame.metadata.width !== width || frame.metadata.height !== height || frame.metadata.bayer !== bayer) throw new RangeError('amp-glow frames must share dimensions and CFA pattern')
		for (let y = 0; y < height; y++) {
			let index = y * width
			const tileRow = Math.trunc(y / tileHeight) * columns
			for (let x = 0; x < width; x++, index++) {
				if (slot >= 0 && ((((y + offsetY) & 1) << 1) | ((x + offsetX) & 1)) !== slot) continue
				const value = frame.raw[index]
				if (!Number.isFinite(value)) continue
				const tile = tileRow + Math.trunc(x / tileWidth)
				sums[tile] += value
				counts[tile]++
			}
		}
	}

	for (let i = 0; i < sums.length; i++) sums[i] = counts[i] > 0 ? sums[i] / counts[i] : Number.NaN
	return sums
}

// Fits per-tile dark slopes and summarizes localized current above the median tile.
function measureAmpGlow(darks: readonly SensorFrameSet[], conversionGain: number, options: Partial<SensorDarkCurrentOptions>): SensorAmpGlow | undefined {
	const first = darks[0]?.frames[0]
	if (!first) return undefined
	const tileWidth = options.tile?.width ?? 64
	const tileHeight = options.tile?.height ?? 64
	if (!Number.isInteger(tileWidth) || !Number.isInteger(tileHeight) || tileWidth <= 0 || tileHeight <= 0) throw new RangeError('amp-glow tile dimensions must be positive integers')
	const columns = Math.ceil(first.metadata.width / tileWidth)
	const rows = Math.ceil(first.metadata.height / tileHeight)
	const tileCount = columns * rows
	const levels = [...darks].sort((a, b) => a.exposure - b.exposure)
	const unique = new Set(levels.map((level) => level.exposure))
	if (unique.size < 3) return undefined
	const means = levels.map((level) => tileMeans(level, tileWidth, tileHeight, options.plane, options.cfaOffset))
	const x = new Float64Array(levels.length)
	const y = new Float64Array(levels.length)
	const weights = new Float64Array(levels.length)
	for (let i = 0; i < levels.length; i++) {
		x[i] = levels[i].exposure
		weights[i] = levels[i].frames.length
	}

	const current = new Float32Array(tileCount)
	const sorted = new Float64Array(tileCount)
	let maximum = Number.NEGATIVE_INFINITY
	for (let tile = 0; tile < tileCount; tile++) {
		for (let level = 0; level < levels.length; level++) y[level] = means[level][tile]
		let value = 0
		try {
			const regression = weightedLinearRegression(x, y, weights)
			value = Math.max(0, regression.slope * conversionGain)
		} catch {
			value = 0
		}
		current[tile] = value
		sorted[tile] = value
		maximum = Math.max(maximum, value)
	}
	sorted.sort()
	const median = medianOf(sorted)
	const excess = maximum - median
	return { tileWidth, tileHeight, columns, rows, current, median, maximum, excess, ratio: median > 0 ? maximum / median : undefined }
}

// Estimates dark current from mean and temporal-variance growth across exposure times.
export function measureSensorDarkCurrent(darks: readonly SensorFrameSet[], conversionGain: number, options: Partial<SensorDarkCurrentOptions> = {}): SensorDarkCurrent {
	if (!Number.isFinite(conversionGain) || conversionGain <= 0) throw new RangeError('dark-current conversion gain must be finite and positive')
	const levels = darkLevels(darks, options)
	const x = new Float64Array(levels.length)
	const means = new Float64Array(levels.length)
	const variances = new Float64Array(levels.length)
	const weights = new Float64Array(levels.length)
	for (let i = 0; i < levels.length; i++) {
		x[i] = levels[i].exposure
		means[i] = levels[i].statistics.mean
		variances[i] = levels[i].statistics.variance
		weights[i] = levels[i].statistics.sampleCount
	}

	const meanRegression = weightedLinearRegression(x, means, weights)
	if (!(meanRegression.slope > 0)) throw new RangeError('dark mean does not increase with exposure')
	const mean = meanRegression.slope * conversionGain
	const meanFit = sensorFit(meanRegression, x, means, weights)
	const varianceRegression = weightedLinearRegression(x, variances, weights)
	const variance = varianceRegression.slope > 0 ? varianceRegression.slope * conversionGain * conversionGain : undefined
	const varianceFit = variance === undefined ? undefined : sensorFit(varianceRegression, x, variances, weights)
	let temperatureSum = 0
	let temperatureCount = 0
	for (const dark of darks) {
		const temperature = dark.temperature ?? dark.operatingPoint?.temperature
		if (temperature !== undefined && Number.isFinite(temperature)) {
			temperatureSum += temperature
			temperatureCount++
		}
	}

	return {
		mean,
		variance,
		meanFit,
		varianceFit,
		temperature: temperatureCount > 0 ? temperatureSum / temperatureCount : undefined,
		ampGlow: measureAmpGlow(darks, conversionGain, options),
	}
}
