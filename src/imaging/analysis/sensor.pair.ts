import type { Rect } from '../../math/numerical/geometry'
import type { DigitalImage } from '../model/types'
import type { SensorPlane } from './sensor.types'

// Allocation-free paired-frame statistics for temporal sensor analysis. Pixels are traversed directly
// in digital-number scale with population variance, inclusive-exclusive ROI bounds, and optional CFA
// plane/mask selection. Returned reports are fresh scalar objects and input images are never mutated.

// Scalar statistics reduced from one independent frame pair.
export interface SensorPairStatistics {
	// Average of the two frame means, DN.
	readonly mean: number
	// Single-frame temporal population variance, DN squared.
	readonly variance: number
	// Signed first-frame mean minus second-frame mean, DN.
	readonly drift: number
	// Fraction of valid samples where either frame reaches the known upper clip.
	readonly clippedFraction: number
	// Number of finite, unmasked samples in the selected plane.
	readonly sampleCount: number
	// Number of selected samples rejected by mask or non-finite data.
	readonly rejectedCount: number
	// Number of valid samples where either frame reaches the known upper clip.
	readonly saturatedCount: number
}

// Options selecting samples for paired-frame measurement.
export interface SensorPairOptions {
	// Inclusive-exclusive integer ROI; defaults to the complete image.
	readonly area?: Readonly<Rect>
	// Mono or CFA plane; required for CFA mosaics and must be mono otherwise.
	readonly plane?: SensorPlane
	// Known upper clipping code in DN; clipped samples remain in the statistics.
	readonly digitalClip?: number
	// Per-pixel nonzero rejection mask with length width times height.
	readonly mask?: Readonly<Uint8Array>
}

// Weighted aggregate of multiple non-overlapping pair reports.
export interface SensorPairAggregate extends SensorPairStatistics {
	// Number of independent pair reports combined.
	readonly pairCount: number
	// Weighted population scatter of pair means, DN squared.
	readonly meanScatter: number
	// Weighted population scatter of pair variances, DN to the fourth power.
	readonly varianceScatter: number
}

// Validated integer ROI used by the pixel hot path.
function resolveArea(area: Readonly<Rect> | undefined, width: number, height: number): Readonly<Rect> {
	const resolved = area ?? { left: 0, top: 0, right: width, bottom: height }
	if (!Number.isInteger(resolved.left) || !Number.isInteger(resolved.top) || !Number.isInteger(resolved.right) || !Number.isInteger(resolved.bottom)) throw new RangeError('sensor pair area must use integer bounds')
	if (resolved.left < 0 || resolved.top < 0 || resolved.right > width || resolved.bottom > height || resolved.left >= resolved.right || resolved.top >= resolved.bottom) throw new RangeError('sensor pair area must be a non-empty inclusive-exclusive image rectangle')
	return resolved
}

// Returns the row-major 2x2 CFA slot for a named plane, or -1 when absent.
function cfaSlot(pattern: string, plane: Exclude<SensorPlane, 'mono'>): number {
	const channel = plane === 'red' ? 'R' : plane === 'blue' ? 'B' : 'G'
	if (plane === 'green2') return pattern.indexOf(channel, pattern.indexOf(channel) + 1)
	return pattern.indexOf(channel)
}

// Validates frame structure and resolves the selected mono/CFA slot.
function validatePair(first: DigitalImage, second: DigitalImage, plane: SensorPlane | undefined, mask: Readonly<Uint8Array> | undefined): number {
	const a = first.metadata
	const b = second.metadata
	if (first.sampleScale !== 'digital' || second.sampleScale !== 'digital') throw new TypeError('sensor pair requires digital images')
	if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels || a.bayer !== b.bayer) throw new RangeError('sensor pair images must have identical dimensions, channels, and CFA pattern')
	if (a.channels !== 1) throw new RangeError('sensor pair analysis requires an undebayered single-channel image')
	if (first.raw.length < a.pixelCount || second.raw.length < a.pixelCount) throw new RangeError('sensor pair raw buffer is smaller than the declared image')
	if (mask && mask.length !== a.pixelCount) throw new RangeError('sensor pair mask length must equal width times height')

	if (!a.bayer) {
		if (plane !== undefined && plane !== 'mono') throw new RangeError('a non-CFA image supports only the mono sensor plane')
		return -1
	}

	if (plane === undefined || plane === 'mono') throw new RangeError('a CFA image requires an explicit color sensor plane')
	const slot = cfaSlot(a.bayer, plane)
	if (slot < 0) throw new RangeError(`sensor plane ${plane} is absent from CFA pattern ${a.bayer}`)
	return slot
}

// Measures one frame pair in a single pass using Welford population variance of A minus B.
export function measureSensorPair(first: DigitalImage, second: DigitalImage, options: Partial<SensorPairOptions> = {}): SensorPairStatistics {
	const { width, height } = first.metadata
	const slot = validatePair(first, second, options.plane, options.mask)
	const area = resolveArea(options.area, width, height)
	const clip = options.digitalClip
	if (clip !== undefined && !Number.isFinite(clip)) throw new RangeError('sensor pair digital clip must be finite')

	const a = first.raw
	const b = second.raw
	const mask = options.mask
	let meanA = 0
	let meanB = 0
	let meanDifference = 0
	let differenceM2 = 0
	let sampleCount = 0
	let rejectedCount = 0
	let saturatedCount = 0

	for (let y = area.top; y < area.bottom; y++) {
		let index = y * width + area.left
		for (let x = area.left; x < area.right; x++, index++) {
			if (slot >= 0 && (((y & 1) << 1) | (x & 1)) !== slot) continue
			const firstValue = a[index]
			const secondValue = b[index]
			if (mask?.[index] || !Number.isFinite(firstValue) || !Number.isFinite(secondValue)) {
				rejectedCount++
				continue
			}

			sampleCount++
			const inverseCount = 1 / sampleCount
			meanA += (firstValue - meanA) * inverseCount
			meanB += (secondValue - meanB) * inverseCount
			const difference = firstValue - secondValue
			const delta = difference - meanDifference
			meanDifference += delta * inverseCount
			differenceM2 += delta * (difference - meanDifference)
			if (clip !== undefined && (firstValue >= clip || secondValue >= clip)) saturatedCount++
		}
	}

	if (sampleCount === 0) throw new RangeError('sensor pair has no valid samples')
	const variance = differenceM2 / sampleCount / 2
	const mean = (meanA + meanB) / 2
	const drift = meanA - meanB
	if (!Number.isFinite(mean) || !Number.isFinite(variance) || !Number.isFinite(drift)) throw new RangeError('sensor pair statistics are non-finite')

	return { mean, variance, drift, clippedFraction: saturatedCount / sampleCount, sampleCount, rejectedCount, saturatedCount }
}

// Combines independent pair reports by valid-sample count while preserving between-pair scatter.
export function aggregateSensorPairs(pairs: readonly SensorPairStatistics[]): SensorPairAggregate {
	if (pairs.length === 0) throw new RangeError('at least one sensor pair statistic is required')

	let sampleCount = 0
	let rejectedCount = 0
	let saturatedCount = 0
	let mean = 0
	let variance = 0
	let drift = 0
	let meanM2 = 0
	let varianceM2 = 0

	for (const pair of pairs) {
		if (!Number.isFinite(pair.mean) || !Number.isFinite(pair.variance) || !Number.isFinite(pair.drift) || pair.sampleCount <= 0) throw new RangeError('sensor pair statistic must be finite with positive sample count')
		const previousCount = sampleCount
		sampleCount += pair.sampleCount
		const weight = pair.sampleCount / sampleCount
		const meanDelta = pair.mean - mean
		const varianceDelta = pair.variance - variance
		mean += meanDelta * weight
		variance += varianceDelta * weight
		drift += (pair.drift - drift) * weight
		meanM2 += (meanDelta * meanDelta * previousCount * pair.sampleCount) / sampleCount
		varianceM2 += (varianceDelta * varianceDelta * previousCount * pair.sampleCount) / sampleCount
		rejectedCount += pair.rejectedCount
		saturatedCount += pair.saturatedCount
	}

	return {
		mean,
		variance,
		drift,
		clippedFraction: saturatedCount / sampleCount,
		sampleCount,
		rejectedCount,
		saturatedCount,
		pairCount: pairs.length,
		meanScatter: meanM2 / sampleCount,
		varianceScatter: varianceM2 / sampleCount,
	}
}
