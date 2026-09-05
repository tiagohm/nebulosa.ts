import { TAU } from '../../../core/constants'
import { medianBySelectionOf } from '../../../core/util'
import type { EllipseGeometry } from '../../../math/numerical/ellipse.geometry'
import type { Point } from '../../../math/numerical/geometry'
import type { PreparedCollimation } from './preprocess'
import type { CollimationFailureReason } from './types'

// Bounded radial sampling of one native image plane. Each sector keeps at most one subpixel point
// per boundary; profiles are reused sequentially, never stored as an angle-by-radius image. Internal
// missing values use NaN only in scratch, and are never published as image geometry.

// Half-plane-pixel spacing resolves the finite-difference gradient without inventing independent data.
export const COLLIMATION_RADIAL_STEP = 0.5
// Observable per-sector rejection codes; zero denotes an accepted edge.
export const COLLIMATION_EDGE_REASON = { accepted: 0, missing: 1, lowContrast: 2, invalid: 3, saturated: 4, cropped: 5, ambiguous: 6, outlier: 7, unresolved: 8 } as const

// First radial initialization, independent of any expected ellipse or hardware obstruction ratio.
export interface CollimationRadialInitialization {
	// Robust annulus plateau above fitted background, in original normalized raw units.
	readonly signal: number
	// Observed content failure when a central depression and complete bright band are not supported.
	readonly reason?: CollimationFailureReason
}

// Internal extraction summary; coordinate, precision and rejection arrays remain workspace-owned.
export interface CollimationEdges {
	// Median signal/gradient width of both transitions, in native-plane pixels.
	readonly edgeWidth: number
	// Smallest resolved paired radial separation, in native-plane pixels.
	readonly minimumSeparation: number
	// Number of sectors where both boundaries are accepted before robust fitting.
	readonly pairedCount: number
}

// Uniform-grid coverage; absent sectors count once regardless of the angular sampling density.
export interface CollimationCoverage {
	// Accepted fraction of the complete requested angular grid.
	readonly coverage: number
	// Largest circular run of missing sectors, radians, including the wrap from last to first.
	readonly maximumGap: number
	// Number of accepted sectors.
	readonly sectors: number
}

// Bilinear sample with complete support for every nonzero-weight neighbor. Original mode samples
// the signed unsmoothed plane for photometry; smoothed mode excludes the full dilated filter mask.
export function sampleCollimationPlane(prepared: PreparedCollimation, x: number, y: number, original = false) {
	const { workspace: w, grid } = prepared
	if (!(x >= 0 && y >= 0 && x <= grid.width - 1 && y <= grid.height - 1)) return Number.NaN
	const ix = Math.floor(x)
	const iy = Math.floor(y)
	const fx = x - ix
	const fy = y - iy
	const index = iy * grid.width + ix
	const mask = original ? w.mask : w.expandedMask
	if (mask[index] || (fx > 0 && mask[index + 1]) || (fy > 0 && mask[index + grid.width]) || (fx > 0 && fy > 0 && mask[index + grid.width + 1])) return Number.NaN
	const source = original ? w.signal : w.smoothed
	const top = fx > 0 ? source[index] * (1 - fx) + source[index + 1] * fx : source[index]
	if (fy === 0) return top
	const bottom = fx > 0 ? source[index + grid.width] * (1 - fx) + source[index + grid.width + 1] * fx : source[index + grid.width]
	return top * (1 - fy) + bottom * fy
}

// Aggregates at most 48 rays by median solely to initialize signal and verify a dark central region.
// A tiny central spot is allowed if a dark interval separates it from a resolved annulus. All loops
// terminate at the ROI diagonal; neither target search nor another star can be substituted.
export function initializeCollimationRadii(prepared: PreparedCollimation): CollimationRadialInitialization {
	const { workspace: w, center, grid, margin } = prepared
	if (!(center.x >= margin && center.y >= margin && center.x < grid.width - margin && center.y < grid.height - margin)) return { signal: 0, reason: 'ambiguousPattern' }
	const rays = Math.min(48, prepared.options.angularSamples)
	const samples = new Float64Array(rays)
	const radialCount = Math.ceil(2 * Math.hypot(grid.width, grid.height))
	let count = 0
	let peak = 0

	for (let i = 0; i < radialCount; i++) {
		const radius = i * COLLIMATION_RADIAL_STEP
		let valid = 0

		for (let j = 0; j < rays; j++) {
			const sector = Math.floor((j * prepared.options.angularSamples) / rays)
			const x = center.x + radius * w.cos[sector]
			const y = center.y + radius * w.sin[sector]
			if (x < margin || y < margin || x > grid.width - 1 - margin || y > grid.height - 1 - margin) continue
			const value = sampleCollimationPlane(prepared, x, y)
			if (Number.isFinite(value)) samples[valid++] = value
		}

		if (valid < Math.ceil(rays * 0.6)) {
			w.profile[i] = Number.NaN
			continue
		}

		const value = medianBySelectionOf(samples, valid)
		w.profile[i] = value
		peak = Math.max(peak, value)
		count = i + 1
	}

	const noise = prepared.background.noise
	const rounding = (w.precision === 64 ? Number.EPSILON : 2 ** -23) * Math.abs(prepared.background.level) * 8
	if (!(peak > rounding)) return { signal: 0, reason: 'patternNotFound' }
	if (noise !== undefined && peak < noise * prepared.options.minimumSignalToNoise) return { signal: peak, reason: 'lowSignal' }

	let start = -1
	let bands = 0
	let shadow = false
	let centralBandWidth = 0
	const minimumWidth = Math.max(3, 2 * prepared.options.smoothingSigma + 2)

	for (let i = 0; i < count; i++) {
		const value = w.profile[i]

		if (!Number.isFinite(value)) continue
		if (value < peak * 0.25 && i * COLLIMATION_RADIAL_STEP >= 1) shadow = true

		if (value >= peak * 0.5) {
			if (start < 0) start = i
		} else if (start >= 0) {
			if (start === 0) centralBandWidth = i * COLLIMATION_RADIAL_STEP
			if ((i - start) * COLLIMATION_RADIAL_STEP >= minimumWidth && start * COLLIMATION_RADIAL_STEP > 1) bands++
			start = -1
		}
	}

	if (bands === 0 && centralBandWidth > 2 * minimumWidth) return { signal: peak, reason: 'ambiguousPattern' }
	if (centralBandWidth > minimumWidth) return { signal: peak, reason: 'unresolvedEdges' }
	if (!shadow) return { signal: peak, reason: 'unresolvedEdges' }
	if (bands > 1) return { signal: peak, reason: 'ambiguousPattern' }
	if (start >= 0 && (count - start) * COLLIMATION_RADIAL_STEP >= minimumWidth) return { signal: peak, reason: 'cropped' }
	if (bands === 0) return { signal: peak, reason: 'unresolvedEdges' }

	return { signal: peak }
}

// Extracts independent gradient extrema around center in native pixels. When ellipses are supplied,
// searches stay within bounded prediction windows, preserving boundary identity across reextractions.
// Missing sectors remain absent; a fixed eight-peak capacity rejects ambiguous diffraction patterns.
export function extractCollimationEdges(prepared: PreparedCollimation, center: Readonly<Point>, signal: number, inner?: EllipseGeometry, outer?: EllipseGeometry): CollimationEdges {
	const { workspace: w, grid, options, margin } = prepared
	const positives = new Float64Array(8)
	const negatives = new Float64Array(8)
	const widths = new Float64Array(options.angularSamples)
	const gradientWindow = Math.max(3, 2 * options.smoothingSigma + 2)
	const contrastWindow = Math.ceil(gradientWindow / COLLIMATION_RADIAL_STEP)
	const threshold = Math.max((signal * 0.035) / Math.max(1, options.smoothingSigma), (prepared.background.noise ?? 0) * 0.5)
	let pairedCount = 0
	let minimumSeparation = Infinity

	w.innerWeight.fill(0, 0, options.angularSamples)
	w.outerWeight.fill(0, 0, options.angularSamples)
	w.innerReason.fill(COLLIMATION_EDGE_REASON.missing, 0, options.angularSamples)
	w.outerReason.fill(COLLIMATION_EDGE_REASON.missing, 0, options.angularSamples)

	// Zero-weight coordinate slots still contain finite values for the generic numerical solver.
	w.innerX.fill(center.x, 0, options.angularSamples)
	w.innerY.fill(center.y, 0, options.angularSamples)
	w.outerX.fill(center.x, 0, options.angularSamples)
	w.outerY.fill(center.y, 0, options.angularSamples)

	for (let sector = 0; sector < options.angularSamples; sector++) {
		const cos = w.cos[sector]
		const sin = w.sin[sector]
		const limit = Math.min(cos > 0 ? (grid.width - 1 - margin - center.x) / cos : cos < 0 ? (margin - center.x) / cos : Infinity, sin > 0 ? (grid.height - 1 - margin - center.y) / sin : sin < 0 ? (margin - center.y) / sin : Infinity)
		const count = Math.max(0, Math.floor(limit / COLLIMATION_RADIAL_STEP) + 1)
		let missingBits = 0

		for (let i = 0; i < count; i++) {
			const x = center.x + i * COLLIMATION_RADIAL_STEP * cos
			const y = center.y + i * COLLIMATION_RADIAL_STEP * sin
			w.profile[i] = sampleCollimationPlane(prepared, x, y)
			const ix = Math.floor(x)
			const iy = Math.floor(y)
			const index = iy * grid.width + ix
			const bits = w.expandedMask[index] | w.expandedMask[index + 1] | w.expandedMask[index + grid.width] | w.expandedMask[index + grid.width + 1]
			missingBits |= bits
		}

		const innerPrediction = inner ? collimationRayRadius(inner, center, cos, sin) : undefined
		const outerPrediction = outer ? collimationRayRadius(outer, center, cos, sin) : undefined
		let positiveCount = 0
		let negativeCount = 0
		let overflow = false

		for (let i = 2; i < count - 2; i++) {
			const left = w.profile[i] - w.profile[i - 2]
			const middle = w.profile[i + 1] - w.profile[i - 1]
			const right = w.profile[i + 2] - w.profile[i]
			if (!Number.isFinite(left + middle + right)) continue

			const sign = middle > 0 ? 1 : -1
			if (!(sign * middle > threshold && sign * middle >= sign * left && sign * middle > sign * right)) continue

			const curvature = left - 2 * middle + right
			if (!(sign * curvature < 0)) continue

			const delta = (0.5 * (left - right)) / curvature
			if (Math.abs(delta) > 1) continue

			const radius = (i + delta) * COLLIMATION_RADIAL_STEP
			const prediction = sign > 0 ? innerPrediction : outerPrediction
			if (prediction !== undefined && Math.abs(radius - prediction) > gradientWindow) continue

			const before = Math.max(0, i - contrastWindow)
			const after = Math.min(count - 1, i + contrastWindow)

			if (!(sign * (w.profile[after] - w.profile[before]) > signal * 0.2)) continue
			const peaks = sign > 0 ? positives : negatives
			const peakCount = sign > 0 ? positiveCount : negativeCount

			if (peakCount > 0 && radius - peaks[peakCount - 1] < 2) {
				const previous = Math.round(peaks[peakCount - 1] / COLLIMATION_RADIAL_STEP)
				if (Math.abs(w.profile[previous + 1] - w.profile[previous - 1]) < Math.abs(middle)) peaks[peakCount - 1] = radius
			} else if (peakCount < peaks.length) {
				peaks[peakCount] = radius
				if (sign > 0) positiveCount++
				else negativeCount++
			} else overflow = true
		}

		let pairs = 0
		let innerRadius = 0
		let outerRadius = 0

		for (let p = 0; p < positiveCount; p++) {
			for (let n = 0; n < negativeCount; n++) {
				const ri = positives[p]
				const ro = negatives[n]
				if (ro - ri < gradientWindow || ri < 1) continue

				const before = w.profile[Math.max(0, Math.floor(ri / COLLIMATION_RADIAL_STEP) - contrastWindow)]
				const afterIndex = Math.ceil(ro / COLLIMATION_RADIAL_STEP) + contrastWindow
				if (afterIndex >= count) continue

				const level = sampleCollimationPlane(prepared, center.x + (ri + ro) * 0.5 * cos, center.y + (ri + ro) * 0.5 * sin)
				// An unavailable plateau is permitted only after previous full pairing established identity.
				if (!Number.isFinite(level) && !(inner && outer)) continue

				const contrast = Number.isFinite(level) ? level : signal
				const after = w.profile[afterIndex]
				if (!(contrast > signal * 0.25 && before < contrast * 0.45 && after < contrast * 0.45)) continue

				pairs++
				innerRadius = ri
				outerRadius = ro
			}
		}

		if (pairs !== 1 || overflow) {
			const reason = overflow || pairs > 1 ? COLLIMATION_EDGE_REASON.ambiguous : missingBits & 2 ? COLLIMATION_EDGE_REASON.saturated : missingBits & 1 ? COLLIMATION_EDGE_REASON.invalid : positiveCount > 0 && negativeCount === 0 ? COLLIMATION_EDGE_REASON.cropped : COLLIMATION_EDGE_REASON.unresolved
			w.innerReason[sector] = reason
			w.outerReason[sector] = reason
			continue
		}

		w.innerX[sector] = center.x + innerRadius * cos
		w.innerY[sector] = center.y + innerRadius * sin
		w.outerX[sector] = center.x + outerRadius * cos
		w.outerY[sector] = center.y + outerRadius * sin

		const ii = Math.round(innerRadius / COLLIMATION_RADIAL_STEP)
		const oi = Math.round(outerRadius / COLLIMATION_RADIAL_STEP)
		const ig = Math.abs(w.profile[ii + 1] - w.profile[ii - 1])
		const og = Math.abs(w.profile[oi + 1] - w.profile[oi - 1])

		w.innerWeight[sector] = Math.min(4, (ig / threshold) ** 2)
		w.outerWeight[sector] = Math.min(4, (og / threshold) ** 2)
		w.innerReason[sector] = 0
		w.outerReason[sector] = 0
		widths[pairedCount++] = signal / Math.min(ig, og)
		minimumSeparation = Math.min(minimumSeparation, outerRadius - innerRadius)
	}

	return { pairedCount, minimumSeparation, edgeWidth: pairedCount > 0 ? medianBySelectionOf(widths, pairedCount) : 0 }
}

// Unique positive exit radius from an ellipse containing center, all in native-plane units. Returns
// undefined if the center is outside/on the boundary; callers must not choose a different root.
export function collimationRayRadius(ellipse: EllipseGeometry, center: Readonly<Point>, dx: number, dy: number): number | undefined {
	const cos = Math.cos(ellipse.theta)
	const sin = Math.sin(ellipse.theta)
	const x = ((center.x - ellipse.center.x) * cos + (center.y - ellipse.center.y) * sin) / ellipse.semiMajor
	const y = ((center.y - ellipse.center.y) * cos - (center.x - ellipse.center.x) * sin) / ellipse.semiMinor
	const u = (dx * cos + dy * sin) / ellipse.semiMajor
	const v = (dy * cos - dx * sin) / ellipse.semiMinor
	const a = u * u + v * v
	const b = x * u + y * v
	const c = x * x + y * y - 1
	if (!(c < 0)) return undefined
	const root = Math.sqrt(b * b - a * c)
	return b >= 0 ? -c / (root + b) : (root - b) / a
}

// Summarizes count active weights over the full circular angular grid, optionally omitting one of
// twelve fixed blocks for paired deletion. More densely sampled angles never increase coverage.
export function collimationCoverage(weights: Float64Array, count: number, omittedBlock = -1): CollimationCoverage {
	let sectors = 0
	let longest = 0
	let run = 0

	for (let i = 0; i < 2 * count; i++) {
		const index = i % count
		const accepted = weights[index] > 0 && Math.floor((index * 12) / count) !== omittedBlock
		if (i < count && accepted) sectors++
		if (accepted) run = 0
		else longest = Math.max(longest, ++run)
	}

	return { sectors, coverage: sectors / count, maximumGap: (Math.min(longest, count) * TAU) / count }
}
