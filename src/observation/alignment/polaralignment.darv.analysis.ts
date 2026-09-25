import { imagePlaneGeometry, type ImagePlaneGeometry } from '../../imaging/analysis/plane'
import { detectStreaks } from '../../imaging/analysis/streak/detector'
import type { Streak, StreakDetectionOptions } from '../../imaging/analysis/streak/types'
import type { Image } from '../../imaging/model/types'
import type { Point } from '../../math/numerical/geometry'
import { robustLinearLeastSquares } from '../../math/numerical/least.squares'
import { medianOf } from '../../math/numerical/statistics'
import type { Angle } from '../../math/units/angle'
import type { DarvExposureMode } from './polaralignment.darv'
import { type DarvPolarErrorComponentResult, estimateDarvPolarErrorComponent } from './polaralignment.darv.solve'
import { type DarvImageTransform, DarvMatrixTransform } from './polaralignment.darv.transform'

// Image-based DARV reduction using generic robust streak fits and bounded, DARV-specific pairing.
// Image positions are zero-based pixel centers (+X right, +Y down). Durations are SI seconds;
// celestial offsets are radians. Inputs are never mutated and no device/network IO is performed.
// Model: opposite equal commanded RA speeds, constant local drift, at most one turnaround dwell,
// no DEC guiding, resolved straight legs, and small sky excursions. Curvature/blends are rejected.

// At most 64 segments (2016 pairs) are examined, including caller-supplied detections.
const MAX_SEGMENTS = 64
// Minimum substantial leg length in received-image pixels.
const MIN_LEG_LENGTH = 12
// Minimum accepted measured detection SNR when the generic detector resolves background noise.
const MIN_SNR = 5

// Commanded outbound RA slew direction of the mount. The analyzer converts it to the opposite
// apparent stellar displacement: an eastward mount slew moves a fixed star west in the sky plane.
export type DarvRaDirection = 'east' | 'west'

// Reasons for a partial or inconclusive reduction; useful trails can accompany diagnostics.
export type DarvAnalysisFailureReason =
	| 'noStreaks'
	| 'noCompatibleLegPair'
	| 'trailTooShort'
	| 'trailClipped'
	| 'trailSaturated'
	| 'ambiguousTrails'
	| 'directionUnresolved'
	| 'missingAngularTransform'
	| 'geometryDegenerate'
	| 'insufficientSnr'
	| 'fitFailed'
	| 'invalidTiming'
	| 'candidateLimit'
	| 'unresolvedSeparation'
	| 'outlierTrails'

// One fitted leg; order is temporal only when its parent measurement has directionResolved=true.
export interface DarvTrailLeg {
	// First endpoint in received-image pixels.
	readonly start: Readonly<Point>
	// Last endpoint in received-image pixels.
	readonly end: Readonly<Point>
	// Endpoint distance in pixels.
	readonly length: number
	// Transverse FWHM in pixels.
	readonly width: number
	// Directed angle from +X towards +Y, radians in [-PI, PI].
	readonly angle: Angle
	// Generic robust line-fit RMS residual in pixels.
	readonly rmsResidual: number
}

// One paired trail, retained even when clipping or orientation prevents a polar-error estimate.
export interface DarvTrailMeasurement {
	// Exposure start, or an arbitrary outer endpoint when direction is unresolved, in pixels.
	readonly start: Readonly<Point>
	// End of outbound motion, in pixels.
	readonly turn: Readonly<Point>
	// Start of return motion after any dwell, in pixels; equals turn for zero dwell.
	readonly returnStart: Readonly<Point>
	// Exposure end, or the other arbitrary outer endpoint, in pixels.
	readonly end: Readonly<Point>
	// Fitted first leg in the above endpoint order.
	readonly outbound: DarvTrailLeg
	// Fitted second leg in the above endpoint order.
	readonly inbound: DarvTrailLeg
	// End minus start in source-frame pixels; temporal only when directionResolved is true.
	readonly closure: readonly [number, number]
	// Whether timing or a supplied exposure-start position determines endpoint order.
	readonly directionResolved: boolean
	// Signed stellar north drift in radians/second, only with resolved direction and sky transform.
	readonly drift?: number
	// Unsigned north drift (with transform) or transverse pixel drift (without transform).
	readonly driftMagnitude: number
	// Units of driftMagnitude and uncertainty.
	readonly driftUnit: 'radiansPerSecond' | 'pixelsPerSecond'
	// Conservative width/residual-derived resolution, in driftUnit; not a calibrated statistical sigma.
	readonly uncertainty: number
	// Bounded geometry/fit quality score in [0, 1], not a probability.
	readonly confidence: number
	// Combined line residual RMS in pixels.
	readonly rmsResidual: number
	// Any observed support touches the image/ROI boundary; excluded from aggregation.
	readonly clipped: boolean
	// Detector could not resolve two independent legs; only an upper-limit measurement is available.
	readonly unresolved: boolean
}

// Exposure timing and optional orientation/geometry metadata for one received DARV frame.
export interface DarvAnalysisInput {
	// Normalized mono, interleaved RGB, or native CFA image, never modified.
	readonly image: Image
	// Actual shutter-open duration in seconds, equal to outbound + return + dwell durations.
	readonly exposure: number
	// Nominal per-leg duration, seconds, used only when an actual duration is absent.
	readonly legDuration: number
	// Actual outbound motion duration in seconds, when measured.
	readonly outboundDuration?: number
	// Actual return motion duration in seconds, when measured.
	readonly returnDuration?: number
	// Actual stationary-RA turnaround duration, seconds; defaults to exposure minus both legs.
	readonly turnaroundDuration?: number
	// First commanded mount RA direction; with a transform identifies the turn side, but equal-time
	// exposures still need a start marker to distinguish the two close outer endpoints.
	readonly firstDirection?: DarvRaDirection
	// Exposure-start positions from capture metadata or a previous frame, in source pixels. Each
	// marker must distinguish one outer endpoint within max(3 px, twice its FWHM).
	readonly starts?: readonly Readonly<Point>[]
	// Current oriented angular transform. Without one, only unsigned pixel drift is published.
	readonly transform?: DarvImageTransform
	// Precomputed generic detections; skips detection and uses their existing robust fits unchanged.
	readonly streaks?: readonly Streak[]
	// Generic streak detector options, including saturation threshold and native image plane.
	readonly detection?: Readonly<StreakDetectionOptions>
	// Optional single-component conversion; hour angle is west-positive at the exposure midpoint,
	// latitude is geographic, both radians. The unselected polar error must be negligible.
	readonly geometry?: { readonly latitude: Angle; readonly hourAngle: Angle; readonly mode: DarvExposureMode }
}

// Robust image reduction. A missing signed drift must never be used as zero polar error.
export interface DarvImageAnalysisResult {
	// ok requires a signed aggregate; partial retains unsigned/upper-limit geometry; otherwise inconclusive.
	readonly status: 'ok' | 'partial' | 'inconclusive'
	// All unambiguous pair measurements, including clipped and resolution-limited trails.
	readonly trails: readonly DarvTrailMeasurement[]
	// Signed north drift in radians/second, from usable, time-oriented trails only.
	readonly drift?: number
	// Robust unsigned aggregate in driftUnit, available without temporal orientation.
	readonly driftMagnitude?: number
	// Units of driftMagnitude; signed drift and driftScatter are always radians/second.
	readonly driftUnit: 'radiansPerSecond' | 'pixelsPerSecond'
	// Weighted scatter about the signed mean, radians/second; undefined without a signed estimate.
	readonly driftScatter?: number
	// Number of trails contributing to the signed aggregate.
	readonly inliers: number
	// Mean capped fit quality multiplied by the usable-trail fraction, in [0, 1].
	readonly confidence: number
	// Structured reasons for unavailable or rejected information.
	readonly diagnostics: readonly DarvAnalysisFailureReason[]
	// Optional selected polar error, available only with signed drift and supplied geometry.
	readonly component?: DarvPolarErrorComponentResult
}

// Resolved actual timing; values are positive seconds except non-negative dwell.
interface DarvTiming {
	// Outbound motion interval.
	readonly outbound: number
	// Return motion interval.
	readonly inbound: number
	// Turnaround interval with tracking continuing and commanded RA excursion paused.
	readonly dwell: number
	// Complete shutter-open interval.
	readonly total: number
}

// Pair identity retained to detect competing assignments before selecting trails.
interface DarvCandidate {
	// First detector index.
	readonly first: number
	// Second detector index.
	readonly second: number
	// Measured geometry and optional celestial drift.
	readonly measurement: DarvTrailMeasurement
}

// Reduces an image using existing robust generic streak fits, pairs substantial near-parallel legs,
// and combines independent stars with a median/MAD gate and capped quality weights. Equal-duration
// closure includes the entire dwell; unequal durations cancel RA using the mean leg velocity and
// the actual shutter interval. Saturated/clipped/ambiguous pairs cannot drive the signed aggregate.
// A straight unresolved retrace is an upper limit, not evidence of exact zero polar error.
export function analyzeDarvImage(input: Readonly<DarvAnalysisInput>): DarvImageAnalysisResult {
	const diagnostics = new Set<DarvAnalysisFailureReason>()
	const trails: DarvTrailMeasurement[] = []
	const timing = resolveDarvTiming(input)
	if (!timing) return { status: 'inconclusive', trails, driftUnit: input.transform ? 'radiansPerSecond' : 'pixelsPerSecond', inliers: 0, confidence: 0, diagnostics: ['invalidTiming'] }

	if (input.transform && !localDarvTransform(input.transform, { x: (input.image.metadata.width - 1) / 2, y: (input.image.metadata.height - 1) / 2 })) {
		diagnostics.add('geometryDegenerate')
		input = { ...input, transform: undefined }
	}

	if (!input.transform) diagnostics.add('missingAngularTransform')

	const detected = input.streaks ?? detectStreaks(input.image, { minLength: MIN_LEG_LENGTH, maxStreaks: MAX_SEGMENTS, mergeAngleTolerance: 0.005, mergeDistance: 1, ...input.detection })
	if (detected.length === 0) diagnostics.add('noStreaks')
	if (detected.length > MAX_SEGMENTS) diagnostics.add('candidateLimit')

	const segments: Streak[] = []
	for (let i = 0; i < Math.min(detected.length, MAX_SEGMENTS); i++) {
		const streak = detected[i]
		if (streak.length < MIN_LEG_LENGTH) diagnostics.add('trailTooShort')
		else if ((streak.saturationFraction ?? 0) > 0) diagnostics.add('trailSaturated')
		else if ((streak.snr ?? MIN_SNR) < MIN_SNR || streak.coverage < 0.7) diagnostics.add('insufficientSnr')
		else segments.push(streak)
	}

	const candidates: DarvCandidate[] = []
	for (let i = 0; i < segments.length; i++) {
		for (let j = i + 1; j < segments.length; j++) {
			const measurement = measureDarvPair(segments[i], segments[j], input, timing, diagnostics)
			if (!measurement) continue
			const candidate = { first: i, second: j, measurement }
			const duplicate = candidates.findIndex((existing) => sameDarvTrail(existing.measurement, measurement))
			if (duplicate < 0) candidates.push(candidate)
			else if (measurement.confidence > candidates[duplicate].measurement.confidence) candidates[duplicate] = candidate
		}
	}

	const conflicts = new Uint8Array(candidates.length)
	for (let i = 0; i < candidates.length; i++) {
		const first = candidates[i]
		for (let j = i + 1; j < candidates.length; j++) {
			const second = candidates[j]
			if (
				first.first === second.first ||
				first.first === second.second ||
				first.second === second.first ||
				first.second === second.second ||
				sameDarvLeg(first.measurement.outbound, second.measurement.outbound) ||
				sameDarvLeg(first.measurement.outbound, second.measurement.inbound) ||
				sameDarvLeg(first.measurement.inbound, second.measurement.outbound) ||
				sameDarvLeg(first.measurement.inbound, second.measurement.inbound)
			)
				conflicts[i] = conflicts[j] = 1
		}
	}

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i]
		if (conflicts[i]) diagnostics.add('ambiguousTrails')
		else trails.push(candidate.measurement)
	}

	if (candidates.length === 0 && segments.length === 1) {
		const retrace = measureUnresolvedRetrace(segments[0], input, timing)

		if (retrace) {
			trails.push(retrace)
			diagnostics.add('unresolvedSeparation')
		}
	}

	if (trails.length === 0 && detected.length > 0 && !diagnostics.has('ambiguousTrails')) diagnostics.add('noCompatibleLegPair')

	for (const trail of trails) {
		if (trail.clipped) diagnostics.add('trailClipped')
		if (!trail.directionResolved) diagnostics.add('directionUnresolved')
	}

	const usable = trails.filter((trail) => !trail.clipped && !trail.unresolved)
	const signed = usable.filter((trail) => trail.drift !== undefined)
	const aggregate = aggregateDarvTrails(signed, true)
	const unsigned = aggregateDarvTrails(usable, false)
	if (aggregate.count < signed.length || unsigned.count < usable.length) diagnostics.add('outlierTrails')
	const component = aggregate.mean === undefined || !input.geometry ? undefined : estimateDarvPolarErrorComponent({ ...input.geometry, drift: aggregate.mean }, input.geometry.mode)
	if (component?.status === 'inconclusive') diagnostics.add('geometryDegenerate')

	return {
		status: aggregate.mean !== undefined ? 'ok' : trails.length > 0 ? 'partial' : 'inconclusive',
		trails,
		drift: aggregate.mean,
		driftMagnitude: unsigned.mean,
		driftUnit: input.transform ? 'radiansPerSecond' : 'pixelsPerSecond',
		driftScatter: aggregate.scatter,
		inliers: aggregate.count,
		confidence: aggregate.confidence,
		diagnostics: Array.from(diagnostics),
		component,
	}
}

// Checks the physical relationship between shutter and motion intervals, which otherwise produces
// a plausible but wrongly scaled drift. This is timing consistency, not routine range validation.
function resolveDarvTiming(input: Readonly<DarvAnalysisInput>): DarvTiming | undefined {
	const outbound = input.outboundDuration ?? input.legDuration
	const inbound = input.returnDuration ?? input.legDuration
	const dwell = input.turnaroundDuration ?? Math.max(0, input.exposure - outbound - inbound)
	if (!(outbound > 0 && inbound > 0 && dwell >= 0) || !Number.isFinite(input.exposure) || !(Math.abs(outbound + inbound + dwell - input.exposure) <= 1e-6 * input.exposure)) return undefined
	return { outbound, inbound, dwell, total: input.exposure }
}

// Freezes the local Jacobian for one trail so a dynamic transform is evaluated at analysis time,
// with a common origin for both legs. Rejects unusable external WCS/calibration geometry.
function localDarvTransform(transform: DarvImageTransform | undefined, origin: Readonly<Point>): DarvMatrixTransform | undefined {
	if (!transform) return undefined
	const x = transform.imageOffsetToSky(1, 0, origin)
	const y = transform.imageOffsetToSky(0, 1, origin)
	if (x === undefined || y === undefined) return undefined
	const determinant = x[0] * y[1] - y[0] * x[1]
	if (!Number.isFinite(determinant) || !(Math.abs(determinant) > 1e-12 * Math.hypot(...x) * Math.hypot(...y))) return undefined
	return new DarvMatrixTransform([x[0], y[0], x[1], y[1]])
}

// Fits the relationship between two existing robust segments; returns undefined for incompatible
// endpoints, PSFs, speeds, curvature, or celestial axes. No image rescan or full-frame copy is needed.
function measureDarvPair(first: Streak, second: Streak, input: Readonly<DarvAnalysisInput>, timing: DarvTiming, diagnostics: Set<DarvAnalysisFailureReason>, refined = input.streaks !== undefined): DarvTrailMeasurement | undefined {
	if (Math.max(first.width, second.width) > 2.5 * Math.min(first.width, second.width)) return undefined
	if (Math.max(first.meanSignal, second.meanSignal) > 4 * Math.min(first.meanSignal, second.meanSignal)) return undefined

	const origin = { x: (first.center.x + second.center.x) / 2, y: (first.center.y + second.center.y) / 2 }
	const transform = localDarvTransform(input.transform, origin)

	if (input.transform && transform === undefined) {
		diagnostics.add('geometryDegenerate')
		return undefined
	}

	let near1 = first.end
	let far1 = first.start
	let near2 = second.end
	let far2 = second.start

	if (transform && input.firstDirection) {
		const sign = input.firstDirection === 'east' ? -1 : 1
		if (transform.imageOffsetToSky(near1.x - far1.x, near1.y - far1.y)[0] * sign < 0) [near1, far1] = [far1, near1]
		if (transform.imageOffsetToSky(near2.x - far2.x, near2.y - far2.y)[0] * sign < 0) [near2, far2] = [far2, near2]
	} else {
		let closest = Infinity

		for (const a of [first.start, first.end])
			for (const b of [second.start, second.end]) {
				const distance = Math.hypot(a.x - b.x, a.y - b.y)

				if (distance < closest) {
					closest = distance
					near1 = a
					near2 = b
				}
			}

		far1 = near1 === first.start ? first.end : first.start
		far2 = near2 === second.start ? second.end : second.start
	}

	const width = Math.max(first.width, second.width)
	const tolerance = Math.max(3, 2 * width)
	const closure = Math.hypot(far1.x - far2.x, far1.y - far2.y)
	if (Math.hypot(near1.x - near2.x, near1.y - near2.y) > tolerance * 3 + (closure * timing.dwell) / timing.total) return undefined

	const ux = (near1.x - far1.x) / first.length
	const uy = (near1.y - far1.y) / first.length
	const vx = (near2.x - far2.x) / second.length
	const vy = (near2.y - far2.y) / second.length
	if (ux * vx + uy * vy < 0.85) return undefined

	if (!refined) {
		const refined1 = refineDarvLeg(input, far1, near1, first)
		const refined2 = refineDarvLeg(input, far2, near2, second)

		if (!refined1 || !refined2) {
			diagnostics.add('fitFailed')
			return undefined
		}

		return measureDarvPair(refined1, refined2, input, timing, diagnostics, true)
	}

	// Two Hough hypotheses refined onto one PSF are not independent outbound/return legs.
	if (Math.abs(ux * vy - uy * vx) * Math.min(first.length, second.length) < Math.min(first.width, second.width) * 0.5) return undefined
	if (timing.dwell === 0) {
		const cross = ux * vy - uy * vx
		if (Math.abs(cross) < 1e-6) return undefined
		const distance = ((near2.x - near1.x) * vy - (near2.y - near1.y) * vx) / cross
		const turn = { x: near1.x + distance * ux, y: near1.y + distance * uy }
		if (Math.hypot(turn.x - near1.x, turn.y - near1.y) > tolerance * 3 || Math.hypot(turn.x - near2.x, turn.y - near2.y) > tolerance * 3) return undefined
		near1 = near2 = turn
	}

	let resolved = false
	let swap = false

	for (const marker of input.starts ?? []) {
		const a = Math.hypot(marker.x - far1.x, marker.y - far1.y)
		const b = Math.hypot(marker.x - far2.x, marker.y - far2.y)

		if (Math.min(a, b) <= tolerance && Math.abs(a - b) > tolerance * 0.5) {
			if (resolved && swap !== b < a) return undefined
			resolved = true
			swap = b < a
		}
	}

	const forward = resolved && swap ? undefined : measureDarvAssignment(first, second, far1, near1, near2, far2, timing, transform)
	const reverse = resolved && !swap ? undefined : measureDarvAssignment(second, first, far2, near2, near1, far1, timing, transform)
	if (!forward) return reverse
	if (!reverse) return forward

	// Both temporal assignments satisfy the motion model. Retain only an unsigned estimate when
	// their magnitudes agree within three combined resolution limits, never the detector's order.
	const difference = Math.abs(forward.driftMagnitude - reverse.driftMagnitude)
	if (difference > 3 * Math.hypot(forward.uncertainty, reverse.uncertainty)) {
		diagnostics.add('ambiguousTrails')
		return undefined
	}
	const canonical = far1.x < far2.x || (far1.x === far2.x && far1.y <= far2.y) ? forward : reverse
	return {
		...canonical,
		directionResolved: false,
		drift: undefined,
		driftMagnitude: (forward.driftMagnitude + reverse.driftMagnitude) / 2,
		uncertainty: Math.max(forward.uncertainty, reverse.uncertainty) + difference / 2,
	}
}

// Tests one temporal assignment of two fitted streaks and their outer/turn endpoints in pixels.
// Timing is in seconds; the optional frozen Jacobian selects angular rather than pixel drift.
// Returns a fresh measurement only when slew speed, dwell closure and celestial RA agree.
function measureDarvAssignment(first: Streak, second: Streak, far1: Readonly<Point>, near1: Readonly<Point>, near2: Readonly<Point>, far2: Readonly<Point>, timing: DarvTiming, transform: DarvMatrixTransform | undefined): DarvTrailMeasurement | undefined {
	const width = Math.max(first.width, second.width)
	const tolerance = Math.max(3, 2 * width)
	const length1 = Math.hypot(near1.x - far1.x, near1.y - far1.y)
	const length2 = Math.hypot(near2.x - far2.x, near2.y - far2.y)

	const speed1 = length1 / timing.outbound
	const speed2 = length2 / timing.inbound
	if (Math.abs(speed1 - speed2) > 0.25 * Math.max(speed1, speed2)) return undefined

	const raX = ((near1.x - far1.x) / timing.outbound - (far2.x - near2.x) / timing.inbound) / 2
	const raY = ((near1.y - far1.y) / timing.outbound - (far2.y - near2.y) / timing.inbound) / 2
	const driftX = (far2.x - far1.x - raX * (timing.outbound - timing.inbound)) / timing.total
	const driftY = (far2.y - far1.y - raY * (timing.outbound - timing.inbound)) / timing.total
	if (Math.hypot(near2.x - near1.x - driftX * timing.dwell, near2.y - near1.y - driftY * timing.dwell) > tolerance * 2) return undefined

	if (transform !== undefined) {
		const ra = transform.imageOffsetToSky(raX, raY)
		if (Math.abs(ra[1]) > 0.1 * Math.abs(ra[0])) return undefined
	}

	const north = transform?.imageOffsetToSky(driftX, driftY)[1]
	const magnitude = north === undefined ? Math.abs(raX * driftY - raY * driftX) / Math.hypot(raX, raY) : Math.abs(north)
	const residual = Math.hypot(first.rmsResidual, second.rmsResidual) / Math.SQRT2
	const resolution = (Math.max(0.25, residual, width / 2) * 2) / timing.total
	const skyX = transform?.imageOffsetToSky(resolution, 0)[1]
	const skyY = transform?.imageOffsetToSky(0, resolution)[1]

	return {
		start: far1,
		turn: near1,
		returnStart: near2,
		end: far2,
		outbound: darvLeg(far1, near1, first),
		inbound: darvLeg(near2, far2, second),
		closure: [far2.x - far1.x, far2.y - far1.y],
		directionResolved: true,
		drift: north,
		driftMagnitude: magnitude,
		driftUnit: transform ? 'radiansPerSecond' : 'pixelsPerSecond',
		uncertainty: skyX === undefined || skyY === undefined ? resolution : Math.hypot(skyX, skyY),
		confidence: Math.min(first.confidence, second.confidence) / (1 + residual / width),
		rmsResidual: residual,
		clipped: first.clippedAtBorder || second.clippedAtBorder,
		unresolved: false,
	}
}

// Identifies duplicate pair hypotheses only after both fitted lines coincide to subpixel accuracy.
// Detector endpoint support may differ longitudinally; comparing normal distances avoids treating
// those harmless tail differences as a second star. Distinct blended lines remain ambiguous.
function sameDarvTrail(first: DarvTrailMeasurement, second: DarvTrailMeasurement): boolean {
	return (sameDarvLeg(first.outbound, second.outbound) && sameDarvLeg(first.inbound, second.inbound)) || (sameDarvLeg(first.outbound, second.inbound) && sameDarvLeg(first.inbound, second.outbound))
}

// Tests normal separation and longitudinal overlap of two segment fits in pixels, regardless of
// their endpoint direction. The half-pixel floor allows interpolation noise without merging PSFs.
function sameDarvLeg(first: DarvTrailLeg, second: DarvTrailLeg): boolean {
	const ux = (first.end.x - first.start.x) / first.length
	const uy = (first.end.y - first.start.y) / first.length
	const ax = second.start.x - first.start.x
	const ay = second.start.y - first.start.y
	const bx = second.end.x - first.start.x
	const by = second.end.y - first.start.y
	const tolerance = Math.max(0.5, 2 * Math.hypot(first.rmsResidual, second.rmsResidual))
	if (Math.abs(ax * uy - ay * ux) > tolerance || Math.abs(bx * uy - by * ux) > tolerance) return false
	const a = ax * ux + ay * uy
	const b = bx * ux + by * uy
	const overlap = Math.min(first.length, Math.max(a, b)) - Math.max(0, Math.min(a, b))
	return overlap > 0.8 * Math.min(first.length, second.length)
}

// Refines a detected leg on its outer 65%, where the two PSFs separate. At most 64 transverse
// profiles of 129 samples are read per leg. Local peaks seed subpixel centroids; shared Huber QR
// rejects crossings and hot pixels. Only the selected native mono/RGB/CFA plane is sampled, without
// a full-image conversion. Endpoints retain the detector's longitudinal support convention.
function refineDarvLeg(input: Readonly<DarvAnalysisInput>, far: Readonly<Point>, near: Readonly<Point>, streak: Streak): Streak | undefined {
	const { width, height, channels, bayer } = input.image.metadata
	const plane = input.detection?.plane
	const grid = imagePlaneGeometry(input.image.metadata, { left: 0, top: 0, right: width, bottom: height }, !plane || plane === 'auto' ? (bayer ? 'green1' : channels === 3 ? 'green' : 'mono') : plane)
	if (grid === undefined) return undefined
	const length = Math.hypot(near.x - far.x, near.y - far.y)
	const ux = (near.x - far.x) / length
	const uy = (near.y - far.y) / length
	const radius = Math.min(64, Math.max(4, Math.ceil(streak.width * 1.5)))
	const profile = new Float64Array(2 * radius + 1)
	const design: number[][] = []
	const target: number[] = []

	for (let i = 0; i < 64; i++) {
		const along = length * (0.1 + (0.55 * i) / 63)
		const x = far.x + along * ux
		const y = far.y + along * uy
		let peak = 0
		let background = Infinity

		for (let k = -radius; k <= radius; k++) {
			const value = darvPlaneSample(input.image, grid, x - uy * k, y + ux * k)
			profile[k + radius] = value
			if (value > profile[peak]) peak = k + radius
			background = Math.min(background, value)
		}

		if (!(profile[peak] > background) || peak < 2 || peak > profile.length - 3) continue

		let weight = 0
		let moment = 0
		for (let k = peak - 2; k <= peak + 2; k++) {
			const signal = Math.max(0, profile[k] - background)
			weight += signal
			moment += (k - radius) * signal
		}

		design.push([1, along / length])
		target.push(moment / weight)
	}

	if (target.length < 16) return undefined

	const fit = robustLinearLeastSquares(design, target, { method: 'huber', tolerance: 1e-10 })
	const intercept = fit.coefficients[0]
	const slope = fit.coefficients[1]
	const start = { x: far.x - uy * intercept, y: far.y + ux * intercept }
	const end = { x: near.x - uy * (intercept + slope), y: near.y + ux * (intercept + slope) }

	let residual = 0
	let weight = 0
	for (let i = 0; i < target.length; i++) {
		residual += fit.weights[i] * fit.residuals[i] ** 2
		weight += fit.weights[i]
	}

	const rmsResidual = Math.sqrt(residual / weight)
	if (rmsResidual > Math.max(1, streak.width / 2)) return undefined
	return { ...streak, start, end, center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, length: Math.hypot(end.x - start.x, end.y - start.y), angle: Math.atan2(end.y - start.y, end.x - start.x), rmsResidual }
}

// Bilinear interpolation on a native image plane at zero-based source pixels. Outside support
// returns zero, so a profile truncated at the frame edge cannot pull its centroid outside the image.
function darvPlaneSample(image: Image, grid: ImagePlaneGeometry, x: number, y: number): number {
	const gx = (x - grid.sourceLeft) / grid.step
	const gy = (y - grid.sourceTop) / grid.step
	const ix = Math.floor(gx)
	const iy = Math.floor(gy)
	if (ix < 0 || iy < 0 || ix + 1 >= grid.width || iy + 1 >= grid.height) return 0
	const raw = grid.rawStart + iy * grid.rawRowStep + ix * grid.rawColumnStep
	const dx = gx - ix
	const dy = gy - iy
	const top = image.raw[raw] * (1 - dx) + image.raw[raw + grid.rawColumnStep] * dx
	const bottom = image.raw[raw + grid.rawRowStep] * (1 - dx) + image.raw[raw + grid.rawRowStep + grid.rawColumnStep] * dx
	return top * (1 - dy) + bottom * dy
}

// Returns a fresh time-oriented leg using the generic detector's width and robust residual.
function darvLeg(start: Readonly<Point>, end: Readonly<Point>, streak: Streak): DarvTrailLeg {
	return { start, end, length: Math.hypot(end.x - start.x, end.y - start.y), width: streak.width, angle: Math.atan2(end.y - start.y, end.x - start.x), rmsResidual: streak.rmsResidual }
}

// A single RA-aligned line cannot distinguish an exact retrace from a sub-resolution wedge. Retain
// geometry and a width-derived upper limit, never publish a signed zero. Requires an oriented sky
// axis and equal leg times; otherwise even the retrace hypothesis is not identifiable.
function measureUnresolvedRetrace(streak: Streak, input: Readonly<DarvAnalysisInput>, timing: DarvTiming): DarvTrailMeasurement | undefined {
	const transform = localDarvTransform(input.transform, streak.center)
	if (transform === undefined || timing.outbound !== timing.inbound) return undefined
	const offset = transform.imageOffsetToSky(streak.end.x - streak.start.x, streak.end.y - streak.start.y)
	const x = transform.imageOffsetToSky(streak.width, 0)
	const y = transform.imageOffsetToSky(0, streak.width)
	const resolution = Math.hypot(x[1], y[1])
	if (Math.abs(offset[1]) > resolution) return undefined
	const reverse = input.firstDirection && offset[0] * (input.firstDirection === 'east' ? -1 : 1) < 0
	const start = reverse ? streak.end : streak.start
	const turn = reverse ? streak.start : streak.end

	return {
		start,
		turn,
		returnStart: turn,
		end: start,
		outbound: darvLeg(start, turn, streak),
		inbound: darvLeg(turn, start, streak),
		closure: [0, 0],
		directionResolved: false,
		driftMagnitude: 0,
		driftUnit: 'radiansPerSecond',
		uncertainty: (resolution * 2) / timing.total,
		confidence: streak.confidence * 0.5,
		rmsResidual: streak.rmsResidual,
		clipped: streak.clippedAtBorder,
		unresolved: true,
	}
}

// Combines either signed or unsigned measurements with a four-MAD gate, floored by each trail's
// measured resolution. Weights depend only on capped fit quality, so brightness cannot dominate.
function aggregateDarvTrails(trails: readonly DarvTrailMeasurement[], signed: boolean): { mean?: number; scatter?: number; count: number; confidence: number } {
	if (trails.length === 0) return { count: 0, confidence: 0 }
	const values = trails.map((trail) => (signed ? trail.drift! : trail.driftMagnitude))
	const median = medianOf(values.toSorted((a, b) => a - b))
	const mad = medianOf(values.map((value) => Math.abs(value - median)).sort((a, b) => a - b)) * 1.4826

	let sum = 0
	let weightSum = 0
	let count = 0
	const accepted: number[] = []

	for (let i = 0; i < trails.length; i++) {
		if (Math.abs(values[i] - median) > Math.max(4 * mad, 3 * trails[i].uncertainty)) continue
		const weight = Math.max(0.1, Math.min(1, trails[i].confidence))
		sum += values[i] * weight
		weightSum += weight
		count++
		accepted.push(i)
	}

	if (count === 0) return { count: 0, confidence: 0 }

	const mean = sum / weightSum
	let squared = 0
	for (const i of accepted) squared += Math.max(0.1, Math.min(1, trails[i].confidence)) * (values[i] - mean) ** 2
	return { mean, scatter: Math.sqrt(squared / weightSum), count, confidence: weightSum / trails.length }
}
