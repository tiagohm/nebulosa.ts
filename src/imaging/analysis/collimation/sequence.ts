import { geometricMedian, medianBySelectionOf } from '../../../core/util'
import { normalizeAngle } from '../../../math/units/angle'
import type { ImageAnalysisPlane } from '../plane'
import type { CollimationAnalysis, CollimationSequence, CollimationSequenceEntry, CollimationSequenceOptions } from './types'

// Pure summaries of caller-grouped short annular measurement sequences. All offsets use one image
// frame and pixel metric; no target identity, rotation, binning or focus-side provenance is inferred.
// Inputs are preserved, scratch is local, and result arrays/points own their storage.

// Bounded short-sequence population prevents accidentally huge result allocation and median work.
const MAXIMUM_FRAMES = 1024

// Aggregates at most 1024 measurements of the same target, optical configuration, native plane,
// orientation, sampling, focus side and defocus regime, without intervening mechanical adjustment.
// These are caller grouping preconditions. ROI changes in one frame are allowed; new image crops
// with another coordinate frame need external registration. Requires five successful stable frames
// not outside a known field reference, equal planes and every radius within 5% of the median.
// Returns eligibility for all inputs, Cartesian dispersion and optional normalized dispersion
// comparison. Plane/radius mismatch or an unsupported bounded median returns incompatibleMeasurements.
export function summarizeCollimationSequence(analyses: readonly CollimationAnalysis[], options: CollimationSequenceOptions = {}): CollimationSequence {
	if (analyses.length > MAXIMUM_FRAMES) throw new RangeError('collimation sequences must not exceed 1024 frames')
	const entries = new Array<CollimationSequenceEntry>(analyses.length)
	const x = new Float64Array(analyses.length)
	const y = new Float64Array(analyses.length)
	const radii = new Float64Array(analyses.length)
	let usableCount = 0
	let plane: ImageAnalysisPlane | undefined
	let incompatible = false
	let resolutionFloor = 0

	for (let index = 0; index < analyses.length; index++) {
		const analysis = analyses[index]

		if (!analysis.success) {
			entries[index] = { index, usable: false, reason: 'analysisFailed', analysisReason: analysis.reason }
			continue
		}
		if (analysis.quality.field === 'outsideReference') {
			entries[index] = { index, usable: false, reason: 'outsideFieldReference' }
			continue
		}
		if (!analysis.stability) {
			entries[index] = { index, usable: false, reason: 'stabilityUnavailable' }
			continue
		}

		entries[index] = { index, usable: true }
		plane ??= analysis.plane
		if (analysis.plane !== plane) incompatible = true
		x[usableCount] = analysis.geometry.offset.x
		y[usableCount] = analysis.geometry.offset.y
		radii[usableCount++] = analysis.outer.equivalentRadius
		resolutionFloor = Math.max(resolutionFloor, analysis.stability.resolutionFloor)
	}

	if (usableCount < 5 || plane === undefined) return { success: false, reason: 'insufficientFrames', usableCount, entries }

	const referenceRadius = medianBySelectionOf(radii, usableCount)
	for (let i = 0; i < usableCount; i++) if (Math.abs(radii[i] - referenceRadius) > referenceRadius * 0.05) incompatible = true
	if (incompatible) return { success: false, reason: 'incompatibleMeasurements', usableCount, entries }

	const offset = geometricMedian(x, y, usableCount)
	if (!offset) return { success: false, reason: 'incompatibleMeasurements', usableCount, entries }

	let dispersion = 0
	for (let i = 0; i < usableCount; i++) dispersion = Math.max(dispersion, Math.hypot(x[i] - offset.x, y[i] - offset.y))

	const distance = Math.hypot(offset.x, offset.y)
	const normalizedDispersion = dispersion / referenceRadius
	const direction = distance > 3 * Math.max(dispersion, resolutionFloor) ? normalizeAngle(Math.atan2(offset.y, offset.x)) : undefined

	return {
		success: true,
		usableCount,
		entries,
		plane,
		offset,
		referenceRadius,
		normalizedOffset: { x: offset.x / referenceRadius, y: offset.y / referenceRadius },
		distance,
		normalizedDistance: distance / referenceRadius,
		dispersion,
		normalizedDispersion,
		resolutionFloor,
		direction,
		dispersionExceedsTolerance: options.tolerance === undefined ? undefined : normalizedDispersion > options.tolerance,
	}
}
