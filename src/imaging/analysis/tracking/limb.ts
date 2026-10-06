import { PI, TAU } from '../../../core/constants'
import { fitEllipse } from '../../../math/numerical/ellipse.fit'
import type { Rect } from '../../../math/numerical/geometry'
import { medianAbsoluteDeviationOf, medianBySelectionOf, percentileBySelectionOf, STANDARD_DEVIATION_SCALE } from '../../../math/numerical/statistics'
import type { Image } from '../../model/types'
import { collimationCoverage } from '../collimation/edge'
import { type ImageAnalysisPlane, type ImagePlaneGeometry, imagePlaneGeometry } from '../plane'
import { extractSurfaceSamples, SURFACE_SAMPLE_INVALID } from './surface'
import type { SurfaceTrackingWorkspace } from './workspace'

// Disk-limb (outer bright-object edge) measurement for Solar, Lunar and planetary guiding. A coarse
// threshold/moment initializer, used only when no prior geometry exists, bounds the search; radial
// profiles from the prior center then locate the strongest object-to-background transition inside a
// prior window with a parabolic subpixel derivative extremum, a gradient-SNR gate and an ambiguity
// gate. A deterministic circle consensus isolates the dominant limb from terminator, prominence and ring
// edges; the consensus edges (regrown for oblateness) are fitted by the robust weighted ellipse fit and
// validated by angular coverage, largest gap, RMS, axis ratio and optional continuity with the prior.
//
// The object must be brighter than its background. Output coordinates are received-image pixels with
// pixel centers at integers, origin upper left, +X right and +Y down; theta is radians in [0, PI) from
// +X toward +Y. CFA planes are analyzed natively and mapped through their sample step. The analysis
// plane uses workspace buffers; the ellipse fit allocates small per-call arrays.

// Radial profile sampling interval along each ray, in analysis samples.
const PROFILE_STEP = 0.5

// Minimum profile-index separation of a competing derivative minimum (2 analysis samples).
const AMBIGUITY_SEPARATION = 4

// Number of robust outer rejection passes after the first ellipse fit.
const OUTLIER_PASSES = 2

// Absolute edge-residual tolerance of consensus and rejection, in analysis samples.
const CONSENSUS_MINIMUM_TOLERANCE = 0.75

// Circle-consensus tolerance relative to the candidate radius; admits oblateness down to about 0.85.
const CONSENSUS_TOLERANCE_FRACTION = 0.08

// Ray-index spacings (as divisors of the ray count) for consensus triples; all span at least 90 degrees.
const CONSENSUS_DIVISORS = [3, 4, 6, 8] as const

// Ellipse limb geometry in received-image pixels.
export interface LimbGeometry {
	// Ellipse center [x, y] in image pixels.
	readonly center: readonly [number, number]
	// Semi-major axis in image pixels.
	readonly semiMajor: number
	// Semi-minor axis in image pixels, not larger than semiMajor.
	readonly semiMinor: number
	// Major-axis direction in [0, PI), radians from +X toward +Y.
	readonly theta: number
}

// Limb measurement configuration.
export interface LimbTrackingOptions {
	// Number of equally spaced radial rays.
	readonly rays: number
	// Half-width of the radial search window relative to the prior radius along each ray, with a prior.
	readonly searchFraction: number
	// Half-width of the radial search window relative to the coarse radius, without a prior.
	readonly coarseSearchFraction: number
	// Minimum edge gradient over gradient noise for an accepted ray.
	readonly minimumGradientSNR: number
	// A competing transition at least this fraction of the strongest one makes the ray ambiguous.
	readonly ambiguityRatio: number
	// Maximum profile level beyond the edge, as a fraction of object contrast above background.
	readonly maximumOuterLevel: number
	// Minimum level drop across the edge, as a fraction of object contrast above background.
	readonly minimumEdgeContrast: number
	// Minimum object contrast over background noise for detection.
	readonly minimumDetectionSNR: number
	// Minimum fraction of rays with accepted edges, in [0, 1].
	readonly minimumCoverage: number
	// Maximum contiguous angular gap without accepted edges, in radians.
	readonly maximumGap: number
	// Maximum ellipse RMS residual relative to the semi-major axis.
	readonly maximumRmsFraction: number
	// RMS residual always tolerated regardless of size, in image pixels.
	readonly minimumRmsLimit: number
	// Minimum accepted semiMinor / semiMajor.
	readonly minimumAxisRatio: number
	// Minimum accepted semi-major axis, in image pixels.
	readonly minimumRadius: number
	// Maximum center displacement from a continuity prior, relative to its semi-major axis.
	readonly maximumCenterJump: number
	// Maximum relative semi-major-axis change from a continuity prior.
	readonly maximumRadiusChange: number
}

// Default limb options for 96 rays and a ±15% prior window.
export const DEFAULT_LIMB_TRACKING_OPTIONS: LimbTrackingOptions = {
	rays: 96,
	searchFraction: 0.15,
	coarseSearchFraction: 0.5,
	minimumGradientSNR: 5,
	ambiguityRatio: 0.6,
	maximumOuterLevel: 0.25,
	minimumEdgeContrast: 0.15,
	minimumDetectionSNR: 8,
	minimumCoverage: 0.5,
	maximumGap: TAU / 3,
	maximumRmsFraction: 0.01,
	minimumRmsLimit: 0.5,
	minimumAxisRatio: 0.7,
	minimumRadius: 4,
	maximumCenterJump: 0.1,
	maximumRadiusChange: 0.05,
}

// Optional search context.
export interface LimbSearch {
	// Prior limb geometry in image pixels that centers the rays and bounds the radial window.
	readonly prior?: LimbGeometry
	// Whether the prior is a previous accepted limb whose center and size must stay continuous.
	readonly continuity?: boolean
	// Preferred object position in image pixels used by the coarse initializer.
	readonly seed?: readonly [number, number]
}

// Per-ray extraction counters.
export interface LimbRayCounts {
	// Rays with an accepted edge after robust ellipse rejection.
	readonly accepted: number
	// Rays without a significant object-to-background transition.
	readonly lowContrast: number
	// Rays with a competing strong transition.
	readonly ambiguous: number
	// Rays leaving the image or crossing invalid samples.
	readonly cropped: number
	// Rays rejected as geometric outliers of the ellipse fit.
	readonly outliers: number
}

// Accepted limb measurement in received-image pixels.
export interface LimbMeasurement extends LimbGeometry {
	// Weighted normal-distance RMS of the ellipse fit, in image pixels.
	readonly rms: number
	// Fraction of rays with accepted edges, in [0, 1].
	readonly coverage: number
	// Largest contiguous angular gap without accepted edges, in radians.
	readonly maximumGap: number
	// Median gradient SNR of accepted edges.
	readonly gradientSNR: number
	// Bounded geometric reliability in [0, 1].
	readonly confidence: number
	// Per-ray counters.
	readonly rays: LimbRayCounts
}

// Stable limb rejection reasons.
export type LimbRejection = 'limb_not_found' | 'limb_low_coverage' | 'limb_large_gap' | 'limb_high_residual' | 'limb_geometry_jump'

// Failed limb measurement.
export interface LimbFailure {
	// Discriminant for failure.
	readonly success: false
	// Stable rejection reason.
	readonly reason: LimbRejection
	// Per-ray counters when ray extraction ran.
	readonly rays?: LimbRayCounts
}

// Limb measurement outcome.
export type LimbOutcome = { readonly success: true; readonly limb: LimbMeasurement } | LimbFailure

// Bilinear sample of a flagged plane; NaN outside the grid or when any support sample is invalid.
function sampleLimbPlane(data: Readonly<Float32Array>, mask: Readonly<Uint8Array>, width: number, height: number, x: number, y: number) {
	const x0 = Math.floor(x)
	const y0 = Math.floor(y)
	if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) return Number.NaN
	const i = y0 * width + x0
	if ((mask[i] | mask[i + 1] | mask[i + width] | mask[i + width + 1]) & SURFACE_SAMPLE_INVALID) return Number.NaN
	const fx = x - x0
	const fy = y - y0
	const top = data[i] + (data[i + 1] - data[i]) * fx
	const bottom = data[i + width] + (data[i + width + 1] - data[i + width]) * fx
	return top + (bottom - top) * fy
}

// Distance from an ellipse center to its boundary along the unit direction (cos, sin).
function ellipseRadiusAlong(semiMajor: number, semiMinor: number, thetaCos: number, thetaSin: number, cos: number, sin: number) {
	const u = cos * thetaCos + sin * thetaSin
	const v = sin * thetaCos - cos * thetaSin
	return 1 / Math.sqrt((u / semiMajor) ** 2 + (v / semiMinor) ** 2)
}

// Extracted limb analysis plane with robust background statistics; values are in source units.
interface LimbPlane {
	// Workspace view of analysis samples, row-major.
	readonly data: Float32Array
	// Workspace view of sample flags; only invalid samples are flagged.
	readonly mask: Uint8Array
	// Analysis width in samples.
	readonly width: number
	// Analysis height in samples.
	readonly height: number
	// Image pixels per analysis sample.
	readonly step: 1 | 2
	// Image X of analysis sample (0, 0).
	readonly originX: number
	// Image Y of analysis sample (0, 0).
	readonly originY: number
	// Robust median of the ROI border band.
	readonly background: number
	// 99.5th-percentile level above background.
	readonly contrast: number
	// Robust border noise sigma, floored at 1e-3 of contrast so noiseless SNR stays finite.
	readonly noise: number
}

// Extracts one analysis plane and its border background statistics. Returns undefined when the plane is
// unsupported, nearly empty or lacks a bright object above options.minimumDetectionSNR. Overwrites the
// workspace raw/mask/statistics buffers.
function prepareLimbPlane(image: Image, plane: ImageAnalysisPlane, area: Readonly<Rect>, workspace: SurfaceTrackingWorkspace, options: LimbTrackingOptions): LimbPlane | undefined {
	let geometry: ImagePlaneGeometry | undefined

	try {
		geometry = imagePlaneGeometry(image.metadata, area, plane)
	} catch {
		return undefined
	}

	if (geometry === undefined) return undefined

	const { width, height, step, sourceLeft: originX, sourceTop: originY } = geometry
	const count = width * height
	const data = workspace.raw(count)
	const mask = workspace.mask(count)
	// Saturated plateaus still have a geometric edge, so only invalid samples are excluded here.
	const { valid } = extractSurfaceSamples(image, plane, originX, originY, step, width, height, Number.POSITIVE_INFINITY, data, mask)
	if (valid < 16) return undefined

	const statistics = workspace.statistics
	const band = Math.max(2, Math.floor(Math.min(width, height) * 0.03))
	const borderTotal = 2 * band * (width + height)
	const borderStride = Math.max(1, Math.ceil(borderTotal / statistics.length))
	let borderCount = 0
	let seen = 0

	for (let y = 0; y < height; y++) {
		const edgeRow = y < band || y >= height - band

		for (let x = 0; x < width; x++) {
			if (!edgeRow && x >= band && x < width - band) {
				x = width - band - 1
				continue
			}

			const i = y * width + x
			if (mask[i] !== 0) continue
			if (seen++ % borderStride === 0 && borderCount < statistics.length) statistics[borderCount++] = data[i]
		}
	}

	if (borderCount < 8) return undefined
	const background = medianBySelectionOf(statistics, borderCount)
	const backgroundNoise = medianAbsoluteDeviationOf(statistics, background, true, borderCount, statistics)

	const allStride = Math.max(1, Math.ceil(valid / statistics.length))
	let sampled = 0
	seen = 0

	for (let i = 0; i < count; i++) {
		if (mask[i] !== 0) continue
		if (seen++ % allStride === 0 && sampled < statistics.length) statistics[sampled++] = data[i]
	}

	const contrast = percentileBySelectionOf(statistics, 0.995, sampled) - background
	if (!(contrast > 0) || !(contrast >= options.minimumDetectionSNR * backgroundNoise)) return undefined
	return { data, mask, width, height, step, originX, originY, background, contrast, noise: Math.max(backgroundNoise, contrast * 1e-3) }
}

// Threshold-moment object estimate in analysis samples: samples above the half-contrast level are
// averaged, then re-averaged within 1.5 equivalent-area radii. With a seed (analysis samples) the window
// is centered on the seed first, so a brighter unrelated object elsewhere in the ROI is ignored. Brightness
// moments only bound the edge search; they are never a published limb center.
function coarseLimbObject(prepared: LimbPlane, seedX?: number, seedY?: number) {
	const { data, mask, width, height } = prepared
	const threshold = prepared.background + 0.5 * prepared.contrast
	let cx = seedX ?? Number.NaN
	let cy = seedY ?? Number.NaN
	let radius = Number.POSITIVE_INFINITY

	for (let pass = 0; pass < 3; pass++) {
		const limit2 = Number.isFinite(cx) && Number.isFinite(radius) ? (1.5 * radius) ** 2 : Number.POSITIVE_INFINITY
		let n = 0
		let sx = 0
		let sy = 0

		for (let y = 0, i = 0; y < height; y++) {
			for (let x = 0; x < width; x++, i++) {
				if (mask[i] !== 0 || !(data[i] >= threshold)) continue
				if (limit2 !== Number.POSITIVE_INFINITY && (x - cx) ** 2 + (y - cy) ** 2 > limit2) continue
				n++
				sx += x
				sy += y
			}
		}

		if (n === 0) return undefined
		cx = sx / n
		cy = sy / n
		radius = Math.sqrt(n / PI)

		// With a seed the first pass keeps the seed and only measures the bright extent.
		if (pass === 0 && seedX !== undefined && seedY !== undefined) {
			cx = seedX
			cy = seedY
		}
	}

	return { x: cx, y: cy, radius }
}

// Coarse bright-object location in image pixels.
export interface BrightObject {
	// Threshold-moment centroid [x, y] in image pixels; biased by phase, rings and clipping.
	readonly center: readonly [number, number]
	// Equivalent-area radius of the above-half-contrast region, in image pixels.
	readonly radius: number
}

// Locates the dominant bright object of an image ROI by threshold moments near an optional seed (image
// pixels). This is an acquisition bound and apparent-object fallback, not a physical disk center.
// Returns undefined without significant contrast. Overwrites workspace raw/mask/statistics buffers.
export function locateBrightObject(image: Image, plane: ImageAnalysisPlane, area: Readonly<Rect>, workspace: SurfaceTrackingWorkspace, options: LimbTrackingOptions = DEFAULT_LIMB_TRACKING_OPTIONS, seed?: readonly [number, number]): BrightObject | undefined {
	const prepared = prepareLimbPlane(image, plane, area, workspace, options)
	if (prepared === undefined) return undefined
	const { originX, originY, step } = prepared
	const object = seed === undefined ? coarseLimbObject(prepared) : coarseLimbObject(prepared, (seed[0] - originX) / step, (seed[1] - originY) / step)
	return object === undefined ? undefined : { center: [originX + object.x * step, originY + object.y * step], radius: object.radius * step }
}

// Measures the outer limb of the brightest object in an image ROI (inside the image, image pixels).
// Without a prior, a threshold-moment initializer bounds the search near the seed (or the bright-sample
// centroid). Overwrites workspace raw/mask/profile/statistics buffers; never mutates the image.
export function measureLimb(image: Image, plane: ImageAnalysisPlane, area: Readonly<Rect>, workspace: SurfaceTrackingWorkspace, options: LimbTrackingOptions = DEFAULT_LIMB_TRACKING_OPTIONS, search: LimbSearch = {}): LimbOutcome {
	const prepared = prepareLimbPlane(image, plane, area, workspace, options)
	if (prepared === undefined) return { success: false, reason: 'limb_not_found' }

	const { data, mask, width, height, step, originX, originY, background, contrast, noise } = prepared
	const statistics = workspace.statistics
	let centerX: number
	let centerY: number
	let semiMajor: number
	let semiMinor: number
	let theta: number
	let window: number

	if (search.prior !== undefined) {
		centerX = (search.prior.center[0] - originX) / step
		centerY = (search.prior.center[1] - originY) / step
		semiMajor = search.prior.semiMajor / step
		semiMinor = search.prior.semiMinor / step
		theta = search.prior.theta
		window = options.searchFraction
	} else {
		const object = search.seed === undefined ? coarseLimbObject(prepared) : coarseLimbObject(prepared, (search.seed[0] - originX) / step, (search.seed[1] - originY) / step)
		if (object === undefined) return { success: false, reason: 'limb_not_found' }
		centerX = object.x
		centerY = object.y
		semiMajor = object.radius
		semiMinor = object.radius
		theta = 0
		window = options.coarseSearchFraction
	}

	if (!(semiMajor * step >= options.minimumRadius)) return { success: false, reason: 'limb_not_found' }

	const rays = Math.max(12, Math.floor(options.rays))
	const edgeX = new Float64Array(rays)
	const edgeY = new Float64Array(rays)
	const weights = new Float64Array(rays)
	const snrs = new Float64Array(rays)
	const derivativeNoise = noise * Math.SQRT2
	const thetaCos = Math.cos(theta)
	const thetaSin = Math.sin(theta)
	let lowContrast = 0
	let ambiguous = 0
	let cropped = 0

	for (let k = 0; k < rays; k++) {
		const angle = (TAU * k) / rays
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)
		const expected = ellipseRadiusAlong(semiMajor, semiMinor, thetaCos, thetaSin, cos, sin)
		const inner = Math.max(1, expected * (1 - window))
		const outer = expected * (1 + window)
		const requested = Math.ceil((outer - inner) / PROFILE_STEP) + 1
		if (requested < 2 * AMBIGUITY_SEPARATION) {
			lowContrast++
			continue
		}

		const profile = workspace.profile(requested)
		let samples = requested

		// The profile stops at the first invalid or out-of-ROI sample; an edge before it stays usable.
		for (let i = 0; i < requested; i++) {
			const r = inner + i * PROFILE_STEP
			profile[i] = sampleLimbPlane(data, mask, width, height, centerX + cos * r, centerY + sin * r)

			if (Number.isNaN(profile[i])) {
				samples = i
				break
			}
		}

		const truncated = samples < requested

		if (truncated && samples < 4 * AMBIGUITY_SEPARATION) {
			cropped++
			continue
		}

		// Central derivative per analysis sample; the strongest negative value is the outward edge.
		let best = 0
		let bestIndex = -1

		for (let i = 1; i < samples - 1; i++) {
			const derivative = profile[i + 1] - profile[i - 1]
			if (derivative < best) {
				best = derivative
				bestIndex = i
			}
		}

		// A truncated ray needs a complete outside band; otherwise the visible edge may be the ROI border.
		if (truncated && !(bestIndex > 1 && bestIndex + 2 * AMBIGUITY_SEPARATION <= samples)) {
			cropped++
			continue
		}

		if (bestIndex <= 1 || bestIndex >= samples - 2 || !(-best >= options.minimumGradientSNR * derivativeNoise)) {
			lowContrast++
			continue
		}

		const outsideEnd = Math.min(samples, bestIndex + 2 * AMBIGUITY_SEPARATION)
		const insideStart = Math.max(0, bestIndex - 2 * AMBIGUITY_SEPARATION)
		let outside = 0
		let inside = 0
		for (let i = bestIndex + AMBIGUITY_SEPARATION; i < outsideEnd; i++) outside += profile[i]
		for (let i = insideStart; i <= bestIndex - AMBIGUITY_SEPARATION; i++) inside += profile[i]
		const outsideCount = outsideEnd - bestIndex - AMBIGUITY_SEPARATION
		const insideCount = bestIndex - AMBIGUITY_SEPARATION - insideStart + 1
		const outsideLevel = outsideCount > 0 ? outside / outsideCount : profile[samples - 1]
		const insideLevel = insideCount > 0 ? inside / insideCount : profile[0]

		// The transition must reach near-background and drop a meaningful fraction of object contrast.
		if (!(outsideLevel - background <= options.maximumOuterLevel * contrast && insideLevel - outsideLevel >= options.minimumEdgeContrast * contrast)) {
			if (truncated) cropped++
			else lowContrast++
			continue
		}

		let competing = 0

		for (let i = 2; i < samples - 2; i++) {
			if (Math.abs(i - bestIndex) <= AMBIGUITY_SEPARATION) continue
			const derivative = profile[i + 1] - profile[i - 1]
			if (derivative < competing && derivative <= profile[i] - profile[i - 2] && derivative <= profile[i + 2] - profile[i]) competing = derivative
		}

		if (competing <= options.ambiguityRatio * best) {
			ambiguous++
			continue
		}

		const left = profile[bestIndex] - profile[bestIndex - 2]
		const right = profile[bestIndex + 2] - profile[bestIndex]
		const curvature = left - 2 * best + right
		const offset = curvature > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature)) : 0
		const radius = inner + (bestIndex + offset) * PROFILE_STEP
		const snr = -best / derivativeNoise
		edgeX[k] = centerX + cos * radius
		edgeY[k] = centerY + sin * radius
		snrs[k] = snr
		weights[k] = Math.min(4, (snr / options.minimumGradientSNR) ** 2)
	}

	// Terminators, prominences and rings form coherent non-limb edge groups that a least-squares
	// compromise would absorb, so the dominant limb is isolated by consensus before ellipse fitting.
	const extracted = weights.slice()
	circleConsensus(edgeX, edgeY, weights, rays)
	let fitted = fitLimbEllipse(edgeX, edgeY, weights, rays)

	if (fitted !== undefined) {
		// Regrow edges excluded only by the circular consensus model (planetary oblateness).
		const { center, semiMajor: a, semiMinor: b } = fitted.fit.ellipse
		const thetaCos = Math.cos(fitted.fit.ellipse.theta)
		const thetaSin = Math.sin(fitted.fit.ellipse.theta)
		const tolerance = Math.max(CONSENSUS_MINIMUM_TOLERANCE, 3 * fitted.fit.rms)
		let regrown = 0

		for (let k = 0; k < rays; k++) {
			if (!(extracted[k] > 0) || weights[k] > 0) continue
			const dx = edgeX[k] - center.x
			const dy = edgeY[k] - center.y
			const distance = Math.hypot(dx, dy)
			if (!(distance > 0) || !(Math.abs(distance - ellipseRadiusAlong(a, b, thetaCos, thetaSin, dx / distance, dy / distance)) <= tolerance)) continue
			weights[k] = extracted[k]
			regrown++
		}

		if (regrown > 0) fitted = fitLimbEllipse(edgeX, edgeY, weights, rays)
	}

	for (let pass = 0; pass < OUTLIER_PASSES && fitted !== undefined; pass++) {
		const { residuals, indices, count: n } = fitted
		for (let i = 0; i < n; i++) statistics[i] = Math.abs(residuals[i])
		const threshold = Math.max(CONSENSUS_MINIMUM_TOLERANCE, 3 * STANDARD_DEVIATION_SCALE * medianBySelectionOf(statistics, n))
		let removed = 0

		for (let i = 0; i < n; i++) {
			if (Math.abs(residuals[i]) <= threshold) continue
			weights[indices[i]] = 0
			removed++
		}

		if (removed === 0) break
		fitted = fitLimbEllipse(edgeX, edgeY, weights, rays)
	}

	let accepted = 0
	let edges = 0

	for (let k = 0; k < rays; k++) {
		if (weights[k] > 0) accepted++
		if (extracted[k] > 0) edges++
	}

	const counts: LimbRayCounts = { accepted, lowContrast, ambiguous, cropped, outliers: edges - accepted }
	const coverage = collimationCoverage(weights, rays)
	if (!(coverage.coverage >= options.minimumCoverage)) return { success: false, reason: 'limb_low_coverage', rays: counts }
	if (!(coverage.maximumGap <= options.maximumGap)) return { success: false, reason: 'limb_large_gap', rays: counts }
	if (fitted === undefined) return { success: false, reason: 'limb_not_found', rays: counts }

	const ellipse = fitted.fit.ellipse
	const major = ellipse.semiMajor * step
	const minor = ellipse.semiMinor * step
	const rms = fitted.fit.rms * step
	const rmsLimit = Math.max(options.minimumRmsLimit, options.maximumRmsFraction * major)
	if (!(rms <= rmsLimit) || !(minor >= options.minimumAxisRatio * major) || !(major >= options.minimumRadius)) return { success: false, reason: 'limb_high_residual', rays: counts }

	const center: [number, number] = [originX + ellipse.center.x * step, originY + ellipse.center.y * step]

	if (search.continuity && search.prior !== undefined) {
		const prior = search.prior
		const jump = Math.hypot(center[0] - prior.center[0], center[1] - prior.center[1])
		if (!(jump <= options.maximumCenterJump * prior.semiMajor) || !(Math.abs(major - prior.semiMajor) <= options.maximumRadiusChange * prior.semiMajor)) return { success: false, reason: 'limb_geometry_jump', rays: counts }
	}

	let snrCount = 0
	for (let k = 0; k < rays; k++) if (weights[k] > 0) statistics[snrCount++] = snrs[k]
	const gradientSNR = medianBySelectionOf(statistics, snrCount)
	const rmsScore = 1 / (1 + (rms / rmsLimit) ** 2)
	const snrScore = Math.min(1, gradientSNR / (4 * options.minimumGradientSNR))
	const gapScore = 1 - coverage.maximumGap / TAU
	const confidence = Math.min(1, Math.max(0, (coverage.coverage * gapScore * rmsScore * snrScore) ** 0.25))

	return { success: true, limb: { center, semiMajor: major, semiMinor: minor, theta: ellipse.theta, rms, coverage: coverage.coverage, maximumGap: coverage.maximumGap, gradientSNR, confidence, rays: counts } }
}

// Deterministic three-point circle consensus over positively weighted edges. Candidate circles pass
// through rays spaced by fixed fractions of the ray grid; the circle with the most edges inside its
// tolerance (ties by smallest absolute residual sum) wins and every other edge weight is zeroed in place.
// Weights stay unchanged when no candidate gathers six edges.
function circleConsensus(edgeX: Readonly<Float64Array>, edgeY: Readonly<Float64Array>, weights: Float64Array, rays: number) {
	let bestCount = 0
	let bestCost = Number.POSITIVE_INFINITY
	let bestX = 0
	let bestY = 0
	let bestRadius = 0

	for (const divisor of CONSENSUS_DIVISORS) {
		const spacing = Math.max(1, Math.round(rays / divisor))

		for (let i = 0; i < rays; i++) {
			const j = (i + spacing) % rays
			const k = (i + 2 * spacing) % rays
			if (!(weights[i] > 0 && weights[j] > 0 && weights[k] > 0)) continue

			// Circumcenter relative to the first point keeps the determinant well scaled.
			const bx = edgeX[j] - edgeX[i]
			const by = edgeY[j] - edgeY[i]
			const cx = edgeX[k] - edgeX[i]
			const cy = edgeY[k] - edgeY[i]
			const b2 = bx * bx + by * by
			const c2 = cx * cx + cy * cy
			const d = 2 * (bx * cy - by * cx)
			if (!(Math.abs(d) > 1e-3 * (b2 + c2))) continue
			const ux = (cy * b2 - by * c2) / d
			const uy = (bx * c2 - cx * b2) / d
			const x = edgeX[i] + ux
			const y = edgeY[i] + uy
			const radius = Math.hypot(ux, uy)
			const tolerance = Math.max(CONSENSUS_MINIMUM_TOLERANCE, CONSENSUS_TOLERANCE_FRACTION * radius)
			let count = 0
			let cost = 0

			for (let m = 0; m < rays; m++) {
				if (!(weights[m] > 0)) continue
				const residual = Math.abs(Math.hypot(edgeX[m] - x, edgeY[m] - y) - radius)
				if (residual > tolerance) continue
				count++
				cost += residual
			}

			if (count > bestCount || (count === bestCount && cost < bestCost)) {
				bestCount = count
				bestCost = cost
				bestX = x
				bestY = y
				bestRadius = radius
			}
		}
	}

	if (bestCount < 6) return
	const tolerance = Math.max(CONSENSUS_MINIMUM_TOLERANCE, CONSENSUS_TOLERANCE_FRACTION * bestRadius)

	for (let m = 0; m < rays; m++) {
		if (weights[m] > 0 && Math.abs(Math.hypot(edgeX[m] - bestX, edgeY[m] - bestY) - bestRadius) > tolerance) weights[m] = 0
	}
}

// Fits the positively weighted edges; returns the fit, compacted residuals and their ray indices.
function fitLimbEllipse(edgeX: Readonly<Float64Array>, edgeY: Readonly<Float64Array>, weights: Readonly<Float64Array>, rays: number) {
	let n = 0
	for (let k = 0; k < rays; k++) if (weights[k] > 0) n++
	if (n < 6) return undefined
	const x = new Float64Array(n)
	const y = new Float64Array(n)
	const precision = new Float64Array(n)
	const indices = new Int32Array(n)

	for (let k = 0, i = 0; k < rays; k++) {
		if (!(weights[k] > 0)) continue
		x[i] = edgeX[k]
		y[i] = edgeY[k]
		precision[i] = weights[k]
		indices[i++] = k
	}

	const fit = fitEllipse(x, y, precision)
	return fit === undefined ? undefined : { fit, residuals: fit.residuals, indices, count: n }
}
