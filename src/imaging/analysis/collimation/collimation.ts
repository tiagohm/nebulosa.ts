import { TAU } from '../../../core/constants'
import { medianAbsoluteDeviationOf, medianBySelectionOf } from '../../../core/util'
import { type EllipseFit, fitEllipse } from '../../../math/numerical/ellipse.fit'
import { type EllipseGeometry, maximumNormalizedBoundaryRadiusSquared } from '../../../math/numerical/ellipse.geometry'
import { normalizeAngle } from '../../../math/units/angle'
import { COLLIMATION_EDGE_REASON, collimationCoverage, type CollimationEdges, collimationRayRadius, extractCollimationEdges, initializeCollimationRadii, sampleCollimationPlane } from './edge'
import { type PreparedCollimation, prepareCollimation, refineCollimationBackground } from './preprocess'
import type { CollimationAnalysis, CollimationAnalysisInput, CollimationAnalysisOptions, CollimationAssessment, CollimationBoundaryFit, CollimationDiagnostic, CollimationFailureReason, CollimationGeometry, CollimationPhotometry, CollimationQuality, CollimationStability } from './types'

// Apparent two-ellipse geometry of one complete defocused annulus in a linear image. Native CFA
// coordinates are transformed back exactly once. Fits and twelve paired angular deletions allocate
// independent outputs; workspace buffers never escape. This is not an optical collimation diagnosis.

// Strict dimensionless containment margin, safely above rounding in the normalized continuous solve.
const CONTAINMENT_MARGIN = 1e-10
// Initial extraction followed by at most two recentered reextractions; no open-ended target search.
const MAXIMUM_EXTRACTIONS = 3
// Conservative vector floor in native-plane pixels, checked by the phase/scale/domain regression grid.
// Applies only to the radii, aspect, edge widths, smoothing and sampling tested by resolutionFloor.
const SAMPLING_RESOLUTION_FLOOR = 0.2

// Measures an isolated complete annulus inside input.area. The center must lie in its shadow; raw
// samples must be normalized, linear and unstretched. Returns content failures as values and throws
// only for structural layout/capacity violations. Lengths use received-image pixels (including CFA
// step), angles turn +X toward +Y, and neither input data nor prior results are mutated.
export function analyzeCollimation(input: CollimationAnalysisInput, options?: CollimationAnalysisOptions): CollimationAnalysis {
	const prepared = prepareCollimation(input, options)
	if (!prepared.success) return prepared
	const { workspace: w, options: o } = prepared
	const diagnostics: CollimationDiagnostic[] = []
	if (o.saturationLevel === undefined) diagnostics.push('saturationUnknown')
	const failure = (reason: CollimationFailureReason): CollimationAnalysis => ({ success: false, reason, area: prepared.area, diagnostics })
	const initialization = initializeCollimationRadii(prepared)
	if (initialization.reason) return failure(initialization.reason)
	let outer: EllipseFit | undefined
	let inner: EllipseFit | undefined
	let edges: CollimationEdges | undefined
	let converged = false
	let center = prepared.center
	for (let pass = 0; pass < MAXIMUM_EXTRACTIONS; pass++) {
		edges = extractCollimationEdges(prepared, center, initialization.signal, inner?.ellipse, outer?.ellipse)
		const rejected = coverageFailure(prepared)
		if (rejected) return failure(rejected)
		const nextInner = fitBoundary(prepared, true)
		const nextOuter = fitBoundary(prepared, false)
		if (!nextInner || !nextOuter) return failure('fitFailed')
		const rejectedFit = coverageFailure(prepared)
		if (rejectedFit) return failure(rejectedFit)
		if (nextInner.rms > o.maximumEdgeResidual || nextOuter.rms > o.maximumEdgeResidual) return failure('fitFailed')
		if (!(maximumNormalizedBoundaryRadiusSquared(nextOuter.ellipse, nextInner.ellipse) < 1 - CONTAINMENT_MARGIN)) return failure('inconsistentGeometry')
		if (!hasExternalMargin(prepared, nextOuter.ellipse)) return failure('cropped')
		if (outer && inner) {
			const innerChange = Math.hypot(nextInner.ellipse.center.x - inner.ellipse.center.x, nextInner.ellipse.center.y - inner.ellipse.center.y)
			const outerChange = Math.hypot(nextOuter.ellipse.center.x - outer.ellipse.center.x, nextOuter.ellipse.center.y - outer.ellipse.center.y)
			const shapeChange = Math.max(Math.abs(nextOuter.ellipse.semiMajor - outer.ellipse.semiMajor), Math.abs(nextOuter.ellipse.semiMinor - outer.ellipse.semiMinor), Math.abs(nextInner.ellipse.semiMajor - inner.ellipse.semiMajor), Math.abs(nextInner.ellipse.semiMinor - inner.ellipse.semiMinor))
			converged = innerChange + outerChange <= 0.1 && shapeChange <= 0.15
		}
		outer = nextOuter
		inner = nextInner
		if (converged) break
		if (pass === 0 && !refineCollimationBackground(prepared, outer.ellipse)) return failure('insufficientBackground')
		center = inner.ellipse.center
	}
	if (!outer || !inner || !edges) return failure('fitFailed')
	if (!converged) return failure('ambiguousPattern')
	const boundaryOuter = imageBoundary(prepared, outer, w.outerWeight)
	const boundaryInner = imageBoundary(prepared, inner, w.innerWeight)
	const vx = boundaryInner.ellipse.center.x - boundaryOuter.ellipse.center.x
	const vy = boundaryInner.ellipse.center.y - boundaryOuter.ellipse.center.y
	const distance = Math.hypot(vx, vy)
	const radius = boundaryOuter.equivalentRadius
	const field = input.field ? (Math.hypot(boundaryOuter.ellipse.center.x - input.field.center.x, boundaryOuter.ellipse.center.y - input.field.center.y) <= input.field.maximumDistance ? 'withinReference' : 'outsideReference') : 'unknown'
	if (field === 'unknown') diagnostics.push('fieldReferenceMissing')
	if (field === 'outsideReference') diagnostics.push('outsideFieldReference')
	const noise = prepared.background.noise
	if (noise === undefined) diagnostics.push('noiseUnresolved')
	const ratio = noise === undefined ? undefined : initialization.signal / noise
	const signalToNoise = ratio !== undefined && Number.isFinite(ratio) ? ratio : undefined
	if (signalToNoise !== undefined && signalToNoise < o.minimumSignalToNoise) return failure('lowSignal')
	const masks = patternSupport(prepared, outer.ellipse, inner.ellipse, initialization.signal)
	if (masks[2] > Math.max(24, 0.01 * Math.PI * outer.ellipse.semiMajor * outer.ellipse.semiMinor)) return failure('ambiguousPattern')
	const floor = resolutionFloor(prepared, outer.ellipse, inner.ellipse, edges, signalToNoise)
	const stability = floor === undefined ? undefined : pairedStability(prepared, outer.ellipse, inner.ellipse, floor)
	if (!stability) diagnostics.push('unstableMeasurement')
	const direction = stability && distance > 3 * Math.max(stability.offsetSpread, stability.resolutionFloor) ? normalizeAngle(Math.atan2(vy, vx)) : undefined
	if (direction === undefined) diagnostics.push('directionUnresolved')
	const geometry: CollimationGeometry = { offset: { x: vx, y: vy }, distance, normalizedDistance: distance / radius, obstructionRatio: boundaryInner.equivalentRadius / radius, direction }
	const quality: CollimationQuality = { background: prepared.background.level, backgroundNoise: noise, signal: initialization.signal, signalToNoise, invalidFraction: masks[0], saturatedFraction: o.saturationLevel === undefined ? undefined : masks[1], field }
	const photometry = annulusPhotometry(prepared, inner.ellipse, outer.ellipse, edges.edgeWidth)
	if (!photometry) diagnostics.push('photometryUnavailable')
	const assessment = o.tolerance === undefined ? undefined : assessTolerance(geometry.normalizedDistance, radius, stability, field, o.tolerance)
	return { success: true, area: prepared.area, plane: prepared.plane, outer: boundaryOuter, obstruction: boundaryInner, geometry, quality, photometry, stability, assessment, diagnostics }
}

// Fits one independent native-plane boundary, rejecting gross residual outliers once and refitting
// their remaining original samples. A deficient fit never reaches geometric acceptance through ridge.
function fitBoundary(prepared: PreparedCollimation, inner: boolean): EllipseFit | undefined {
	const { workspace: w, options: o } = prepared
	const x = (inner ? w.innerX : w.outerX).subarray(0, o.angularSamples)
	const y = (inner ? w.innerY : w.outerY).subarray(0, o.angularSamples)
	const weights = (inner ? w.innerWeight : w.outerWeight).subarray(0, o.angularSamples)
	const reasons = inner ? w.innerReason : w.outerReason
	const fit = fitEllipse(x, y, weights)
	if (!fit) return undefined
	const limit = Math.max(4 * fit.rms, 2 * o.maximumEdgeResidual)
	let rejected = false
	for (let i = 0; i < o.angularSamples; i++)
		if (weights[i] > 0 && (fit.weights[i] === 0 || Math.abs(fit.residuals[i]) > limit)) {
			weights[i] = 0
			reasons[i] = COLLIMATION_EDGE_REASON.outlier
			rejected = true
		}
	const finalFit = rejected ? fitEllipse(x, y, weights) : fit
	if (finalFit)
		for (let i = 0; i < o.angularSamples; i++)
			if (weights[i] > 0 && finalFit.weights[i] === 0) {
				weights[i] = 0
				reasons[i] = COLLIMATION_EDGE_REASON.outlier
			}
	return finalFit
}

// Applies angular count, coverage and circular-gap policy to each independent boundary. Failure
// reasons reflect observed rejected sectors; padding the ROI never hides saturation or a missing arc.
function coverageFailure(prepared: PreparedCollimation): CollimationFailureReason | undefined {
	const { workspace: w, options: o } = prepared
	const inner = collimationCoverage(w.innerWeight, o.angularSamples)
	const outer = collimationCoverage(w.outerWeight, o.angularSamples)
	if (inner.sectors >= 12 && outer.sectors >= 12 && inner.coverage >= o.minimumCoverage && outer.coverage >= o.minimumCoverage && inner.maximumGap <= o.maximumGap && outer.maximumGap <= o.maximumGap) return undefined
	const counts = new Uint32Array(9)
	for (let i = 0; i < o.angularSamples; i++) {
		counts[w.innerReason[i]]++
		counts[w.outerReason[i]]++
	}
	if (counts[COLLIMATION_EDGE_REASON.ambiguous] > o.angularSamples * 0.2) return 'ambiguousPattern'
	if (counts[COLLIMATION_EDGE_REASON.saturated] > o.angularSamples * 0.2) return 'saturated'
	if (counts[COLLIMATION_EDGE_REASON.cropped] > o.angularSamples * 0.2) return 'cropped'
	if (counts[COLLIMATION_EDGE_REASON.unresolved] > o.angularSamples) return 'unresolvedEdges'
	return 'insufficientCoverage'
}

// Requires the entire analytic outer ellipse plus real filter/interpolation margin inside the ROI;
// a low residual on the surviving portion cannot turn a cropped optical boundary into success.
function hasExternalMargin(prepared: PreparedCollimation, outer: EllipseGeometry) {
	const cos = Math.cos(outer.theta)
	const sin = Math.sin(outer.theta)
	const rx = Math.hypot(outer.semiMajor * cos, outer.semiMinor * sin) + prepared.margin
	const ry = Math.hypot(outer.semiMajor * sin, outer.semiMinor * cos) + prepared.margin
	return outer.center.x > rx && outer.center.y > ry && outer.center.x + rx < prepared.grid.width - 1 && outer.center.y + ry < prepared.grid.height - 1
}

// Allocates public ellipse geometry in received-image coordinates and scales every length by the
// same native step. CFA angles remain unchanged; pixel aspect and sensor header origins are ignored.
function imageBoundary(prepared: PreparedCollimation, fit: EllipseFit, weights: Float64Array): CollimationBoundaryFit {
	const { grid } = prepared
	const e = fit.ellipse
	const ellipse = { center: { x: grid.sourceLeft + e.center.x * grid.step, y: grid.sourceTop + e.center.y * grid.step }, semiMajor: e.semiMajor * grid.step, semiMinor: e.semiMinor * grid.step, theta: e.theta }
	return { ellipse, equivalentRadius: Math.sqrt(ellipse.semiMajor * ellipse.semiMinor), rms: fit.rms * grid.step, ...collimationCoverage(weights, prepared.options.angularSamples) }
}

// Restricts the sampling floor to the synthetic regression domain: outer equivalent radius 24..100,
// inner minor radius >=8, aspect <=1.5, separation >=8, observed width 2..7 native pixels, Gaussian
// sigma 0.5..1.5, at least 180 rays and measurable SNR >=30. Outside it, geometry can still succeed.
function resolutionFloor(prepared: PreparedCollimation, outer: EllipseGeometry, inner: EllipseGeometry, edges: CollimationEdges, snr?: number): number | undefined {
	const radius = Math.sqrt(outer.semiMajor * outer.semiMinor)
	if (
		radius < 24 ||
		radius > 100 ||
		inner.semiMinor < 8 ||
		outer.semiMajor / outer.semiMinor > 1.5 ||
		inner.semiMajor / inner.semiMinor > 1.5 ||
		edges.minimumSeparation < 8 ||
		edges.edgeWidth < 2 ||
		edges.edgeWidth > 7 ||
		prepared.options.smoothingSigma < 0.5 ||
		prepared.options.smoothingSigma > 1.5 ||
		prepared.options.angularSamples < 180 ||
		(snr !== undefined && snr < 30)
	)
		return undefined
	return SAMPLING_RESOLUTION_FLOOR * prepared.grid.step
}

// Removes each of twelve contiguous blocks from both original boundaries and refits all replicates.
// Every replicate must retain sufficient angular information and strict containment. Offset spread
// is vectorial; each normalized replicate uses its own outer equivalent radius, never the base radius.
function pairedStability(prepared: PreparedCollimation, outer: EllipseGeometry, inner: EllipseGeometry, floor: number): CollimationStability | undefined {
	const { workspace: w, options: o, grid } = prepared
	const count = o.angularSamples
	const outerWeights = new Float64Array(count)
	const innerWeights = new Float64Array(count)
	const ix = w.innerX.subarray(0, count)
	const iy = w.innerY.subarray(0, count)
	const ox = w.outerX.subarray(0, count)
	const oy = w.outerY.subarray(0, count)
	const vx = inner.center.x - outer.center.x
	const vy = inner.center.y - outer.center.y
	const radius = Math.sqrt(outer.semiMajor * outer.semiMinor)
	let offsetSpread = 0
	let normalizedOffsetSpread = 0
	for (let block = 0; block < 12; block++) {
		for (const weights of [w.innerWeight, w.outerWeight]) {
			const coverage = collimationCoverage(weights, count, block)
			if (coverage.coverage < Math.max(0.6, o.minimumCoverage - 1 / 12 - 1 / count) || coverage.maximumGap > o.maximumGap + TAU / 12 || coverage.sectors < 12) return undefined
		}
		for (let i = 0; i < count; i++) {
			const retained = Math.floor((i * 12) / count) !== block
			innerWeights[i] = retained ? w.innerWeight[i] : 0
			outerWeights[i] = retained ? w.outerWeight[i] : 0
		}
		const fi = fitEllipse(ix, iy, innerWeights)
		const fo = fitEllipse(ox, oy, outerWeights)
		if (!fi || !fo || fi.rms > o.maximumEdgeResidual || fo.rms > o.maximumEdgeResidual || !(maximumNormalizedBoundaryRadiusSquared(fo.ellipse, fi.ellipse) < 1 - CONTAINMENT_MARGIN)) return undefined
		for (const fit of [fi, fo]) {
			const coverage = collimationCoverage(fit.weights, count)
			if (coverage.coverage < Math.max(0.6, o.minimumCoverage - 1 / 12 - 1 / count) || coverage.maximumGap > o.maximumGap + TAU / 12 || coverage.sectors < 12) return undefined
		}
		const x = fi.ellipse.center.x - fo.ellipse.center.x
		const y = fi.ellipse.center.y - fo.ellipse.center.y
		const r = Math.sqrt(fo.ellipse.semiMajor * fo.ellipse.semiMinor)
		offsetSpread = Math.max(offsetSpread, Math.hypot(x - vx, y - vy) * grid.step)
		normalizedOffsetSpread = Math.max(normalizedOffsetSpread, Math.hypot(x / r - vx / radius, y / r - vy / radius))
	}
	return { offsetSpread, normalizedOffsetSpread, resolutionFloor: floor }
}

// Integrates original background-subtracted signal per unit area in resolved sectors, away from
// transitions. The radial Jacobian r dr removes the brightness bias from variable annular thickness.
// Photometry needs positive median, at least 80% radial support and the configured angular coverage.
function annulusPhotometry(prepared: PreparedCollimation, inner: EllipseGeometry, outer: EllipseGeometry, edgeWidth: number): CollimationPhotometry | undefined {
	const { workspace: w, options: o } = prepared
	const weights = new Float64Array(o.angularSamples)
	const intensities = new Float64Array(o.angularSamples)
	const inset = Math.max(2, 2 * edgeWidth)
	let count = 0
	for (let sector = 0; sector < o.angularSamples; sector++) {
		if (!(w.innerWeight[sector] > 0 && w.outerWeight[sector] > 0)) continue
		const cos = w.cos[sector]
		const sin = w.sin[sector]
		const ri = collimationRayRadius(inner, inner.center, cos, sin)
		const ro = collimationRayRadius(outer, inner.center, cos, sin)
		if (ri === undefined || ro === undefined) continue
		const start = ri + inset
		const end = ro - inset
		if (end - start < 2) continue
		const samples = Math.ceil(2 * (end - start))
		let sum = 0
		let area = 0
		let retained = 0
		for (let i = 0; i < samples; i++) {
			const r = start + ((i + 0.5) * (end - start)) / samples
			const value = sampleCollimationPlane(prepared, inner.center.x + r * cos, inner.center.y + r * sin, true)
			if (!Number.isFinite(value)) continue
			sum += value * r
			area += r
			retained++
		}
		if (retained < samples * 0.8 || !(area > 0)) continue
		intensities[count++] = sum / area
		weights[sector] = 1
	}
	const coverage = collimationCoverage(weights, o.angularSamples)
	if (count < 12 || coverage.coverage < o.minimumCoverage || coverage.maximumGap > o.maximumGap) return undefined
	const median = medianBySelectionOf(intensities, count)
	if (!(median > 0) || (prepared.background.noise !== undefined && median < prepared.background.noise * o.minimumSignalToNoise)) return undefined
	const mad = medianAbsoluteDeviationOf(intensities, median, false, count, w.scratch)
	return { relativeVariation: (1.4826 * mad) / median, coverage: coverage.coverage, maximumGap: coverage.maximumGap }
}

// Counts original masks only over annulus plus transition support, so unrelated ROI padding neither
// dilutes saturation fractions nor lets nonselected channels contaminate the selected measurement.
// Also counts strong external excess (above 20% of signal and six background MADs), allowing the
// caller to reject an additional extended bright pattern without searching for or selecting it.
function patternSupport(prepared: PreparedCollimation, outer: EllipseGeometry, inner: EllipseGeometry, signal: number): readonly [number, number, number] {
	const { grid, workspace: w, margin } = prepared
	const oc = Math.cos(outer.theta)
	const os = Math.sin(outer.theta)
	const ic = Math.cos(inner.theta)
	const is = Math.sin(inner.theta)
	const outerLimit = (1 + margin / outer.semiMinor) ** 2
	const innerLimit = Math.max(0, 1 - margin / inner.semiMinor) ** 2
	let count = 0
	let invalid = 0
	let saturated = 0
	let exterior = 0
	const exteriorThreshold = Math.max(signal * 0.2, 6 * (prepared.background.noise ?? 0))
	for (let y = 0; y < grid.height; y++)
		for (let x = 0; x < grid.width; x++) {
			const ox = x - outer.center.x
			const oy = y - outer.center.y
			const ix = x - inner.center.x
			const iy = y - inner.center.y
			if (((ox * oc + oy * os) / outer.semiMajor) ** 2 + ((oy * oc - ox * os) / outer.semiMinor) ** 2 > outerLimit) {
				if (!w.mask[y * grid.width + x] && w.signal[y * grid.width + x] > exteriorThreshold) exterior++
				continue
			}
			if (((ix * ic + iy * is) / inner.semiMajor) ** 2 + ((iy * ic - ix * is) / inner.semiMinor) ** 2 < innerLimit) continue
			count++
			const bits = w.mask[y * grid.width + x]
			if (bits & 1) invalid++
			if (bits & 2) saturated++
		}
	return count > 0 ? [invalid / count, saturated / count, exterior] : [0, 0, exterior]
}

// Compares normalized distance plus sensitivity with a caller tolerance. A known off-field position
// or unavailable stability makes the optical-use assessment inconclusive while preserving geometry.
function assessTolerance(distance: number, radius: number, stability: CollimationStability | undefined, field: CollimationQuality['field'], tolerance: number): CollimationAssessment {
	if (!stability || field === 'outsideReference') return 'inconclusive'
	const delta = Math.max(stability.normalizedOffsetSpread, stability.resolutionFloor / radius)
	return distance + delta <= tolerance ? 'withinTolerance' : Math.max(0, distance - delta) > tolerance ? 'outsideTolerance' : 'inconclusive'
}
