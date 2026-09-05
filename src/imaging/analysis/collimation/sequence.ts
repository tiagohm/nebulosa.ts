import { medianBySelectionOf } from '../../../core/util'
import type { Point } from '../../../math/numerical/geometry'
import { normalizeAngle } from '../../../math/units/angle'
import type { ImageAnalysisPlane } from '../plane'
import type { CollimationAnalysis, CollimationSequence, CollimationSequenceEntry, CollimationSequenceOptions } from './types'

// Pure summaries of caller-grouped short annular measurement sequences. All offsets use one image
// frame and pixel metric; no target identity, rotation, binning or focus-side provenance is inferred.
// Inputs are preserved, scratch is local, and result arrays/points own their storage.

// Bounded short-sequence population prevents accidentally huge result allocation and median work.
const MAXIMUM_FRAMES = 1024
// Modified Weiszfeld iterations; every accepted result also passes a convex subgradient criterion.
const MEDIAN_ITERATIONS = 512
// Dimensionless near-coincidence threshold after centering/scaling; it prevents singular weights.
const COINCIDENT_TOLERANCE = 1e-12
// Sum-of-unit-vectors stationarity tolerance per sample, independent of pixel and radius units.
const MEDIAN_GRADIENT_TOLERANCE = 1e-9
// Bounded backtracking for smooth Newton acceleration; rejected steps fall back to Weiszfeld.
const MEDIAN_LINE_SEARCH_STEPS = 24

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

// Modified Weiszfeld geometric median of count paired finite x/y offsets, accelerated by damped
// Newton steps away from data points. Centering and isotropic scaling preserve the pixel metric.
// At data coincidences, multiplicity supplies the subgradient ball; explicit nearest-point checks
// avoid asymptotic convergence to a data-point optimum. Smooth steps require objective decrease.
// Vardi & Zhang (2000), https://doi.org/10.1073/pnas.97.4.1423. Returns independent coordinates or
// undefined after the fixed budget if the subgradient norm still exceeds n*1e-9.
function geometricMedian(x: Float64Array, y: Float64Array, count: number): Point | undefined {
	const anchorX = medianBySelectionOf(x.slice(0, count))
	const anchorY = medianBySelectionOf(y.slice(0, count))
	let scale = 0
	for (let i = 0; i < count; i++) scale = Math.max(scale, Math.hypot(x[i] - anchorX, y[i] - anchorY))
	if (scale === 0) return { x: anchorX, y: anchorY }
	const nx = new Float64Array(count)
	const ny = new Float64Array(count)
	for (let i = 0; i < count; i++) {
		nx[i] = (x[i] - anchorX) / scale
		ny[i] = (y[i] - anchorY) / scale
	}
	let cx = 0
	let cy = 0
	let checkedPoint = -1
	for (let iteration = 0; iteration < MEDIAN_ITERATIONS; iteration++) {
		let inverseSum = 0
		let rx = 0
		let ry = 0
		let coincident = 0
		let hxx = 0
		let hxy = 0
		let hyy = 0
		let closestPoint = 0
		let closestDistance = Infinity
		for (let i = 0; i < count; i++) {
			const dx = nx[i] - cx
			const dy = ny[i] - cy
			const distance = Math.hypot(dx, dy)
			if (distance < closestDistance) {
				closestPoint = i
				closestDistance = distance
			}
			if (distance <= COINCIDENT_TOLERANCE) {
				coincident++
				continue
			}
			const ux = dx / distance
			const uy = dy / distance
			inverseSum += 1 / distance
			rx += ux
			ry += uy
			hxx += (uy * uy) / distance
			hxy -= (ux * uy) / distance
			hyy += (ux * ux) / distance
		}
		const norm = Math.hypot(rx, ry)
		if (norm <= coincident + MEDIAN_GRADIENT_TOLERANCE * count) return { x: anchorX + cx * scale, y: anchorY + cy * scale }
		if (closestPoint !== checkedPoint) {
			checkedPoint = closestPoint
			if (medianAtPoint(nx, ny, count, closestPoint)) return { x: x[closestPoint], y: y[closestPoint] }
		}
		const hscale = hxx + hyy
		const a = hxx / hscale
		const b = hxy / hscale
		const c = hyy / hscale
		const determinant = a * c - b * b
		let accelerated = false
		if (coincident === 0 && determinant > 1e-15) {
			let sx = (c * rx - b * ry) / (determinant * hscale)
			let sy = (a * ry - b * rx) / (determinant * hscale)
			const length = Math.hypot(sx, sy)
			if (length > 2) {
				sx *= 2 / length
				sy *= 2 / length
			}
			for (let step = 0; step < MEDIAN_LINE_SEARCH_STEPS; step++) {
				if (medianObjectiveChange(nx, ny, count, cx, cy, sx, sy) <= -1e-4 * (rx * sx + ry * sy)) {
					cx += sx
					cy += sy
					accelerated = true
					break
				}
				sx *= 0.5
				sy *= 0.5
			}
		}
		if (accelerated) continue
		const fraction = 1 - coincident / norm
		cx += (fraction * rx) / inverseSum
		cy += (fraction * ry) / inverseSum
	}
	return undefined
}

// Tests the convex subgradient ball at one data index in centered, isotropically scaled offsets.
// Multiplicity includes coincident points; no distances or inputs are mutated.
function medianAtPoint(x: Float64Array, y: Float64Array, count: number, index: number) {
	let rx = 0
	let ry = 0
	let coincident = 0
	for (let i = 0; i < count; i++) {
		const dx = x[i] - x[index]
		const dy = y[i] - y[index]
		const distance = Math.hypot(dx, dy)
		if (distance <= COINCIDENT_TOLERANCE) coincident++
		else {
			rx += dx / distance
			ry += dy / distance
		}
	}
	return Math.hypot(rx, ry) <= coincident + MEDIAN_GRADIENT_TOLERANCE * count
}

// Sum-of-distances change from candidate (cx,cy) by step (sx,sy), all in normalized offset units.
// Rationalized distance differences preserve small decreases near a smooth stationary solution.
function medianObjectiveChange(x: Float64Array, y: Float64Array, count: number, cx: number, cy: number, sx: number, sy: number) {
	let change = 0
	const squaredStep = sx * sx + sy * sy
	for (let i = 0; i < count; i++) {
		const dx = x[i] - cx
		const dy = y[i] - cy
		const denominator = Math.hypot(dx - sx, dy - sy) + Math.hypot(dx, dy)
		if (denominator > 0) change += (squaredStep - 2 * (dx * sx + dy * sy)) / denominator
	}
	return change
}
