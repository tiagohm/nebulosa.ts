import { analyzeFocusCurvature, analyzeFocusPlane, fitFocusSurface, type FocusCurvatureAnalysis, type FocusPlaneAnalysis, type FocusSurfaceFitOptions, type FocusSurfaceFitResult } from '../../math/numerical/surface.fit'
import type { Image } from '../model/types'
import { registerStars, type ImageRegistrationOptions } from '../processing/registration'
import type { DetectedStar } from '../stars/detector'
import type { StarProfile } from '../stars/profile'
import { diagnoseFocusScan } from './aberration.diagnostic'
import { fitAberrationFocusCurve, type AberrationFocusCurveOptions, type AberrationFocusCurveResult, type AberrationFocusMetric } from './aberration.focus'
import { measureFocusFieldOffset, type BackfocusCalibration, type FocusFieldOffset } from './aberration.physical'
import { assignAberrationRegion } from './aberration.region'
import { inspectAberration, inspectAberrationProfiles, type InspectAberrationOptions } from './aberration.single'
import type { AberrationFinding, AberrationInspectionResult, AberrationRegionDefinition, AberrationRegionOptions, AberrationWarning } from './aberration.types'

// Sensor-fixed regional focus-scan analysis without image registration or persistent star tracks.

// One captured focus-scan frame, supplied as an image or pre-measured profiles with explicit dimensions.
export interface AberrationFocusFrame {
	// Focuser position in the caller's unit.
	readonly position: number
	// Source image; mutually exclusive with `profiles`.
	readonly image?: Image
	// Pre-measured optical profiles; mutually exclusive with `image`.
	readonly profiles?: readonly StarProfile[]
	// Required dimensions for a profiles-only frame.
	readonly width?: number
	// Required dimensions for a profiles-only frame.
	readonly height?: number
	// Optional caller frame identity preserved in output.
	readonly id?: string
}

// Stable processing status for one focus-scan frame.
export type AberrationFocusFrameStatus = 'used' | 'rejected'

// Stable reason why an input frame did not contribute regional measurements.
export type AberrationFocusFrameRejectionReason = 'invalidInput' | 'inconsistentDimensions' | 'insufficientProfiles' | 'unsupportedPosition' | 'registrationFailed'

// Discriminated frame result that preserves input order and identity.
export interface AberrationFocusFrameResult {
	// Original input index.
	readonly index: number
	// Optional caller identity copied from the input frame.
	readonly id?: string
	// Focuser position in the caller's unit.
	readonly position: number
	// Whether this frame contributes to regional curves.
	readonly status: AberrationFocusFrameStatus
	// Single-frame inspection for used frames.
	readonly inspection?: AberrationInspectionResult
	// Stable reasons for rejection.
	readonly rejectionReasons: readonly AberrationFocusFrameRejectionReason[]
	// Non-fatal processing diagnostics.
	readonly warnings: readonly AberrationWarning[]
}

// One regional curve and its best-focus estimate over a completed scan.
export interface AberrationRegionFocusResult {
	// Fixed sensor region summarized by this curve.
	readonly region: AberrationRegionDefinition
	// Representative normalized sensor X coordinate of the metric observations.
	readonly u: number
	// Representative normalized sensor Y coordinate of the metric observations.
	readonly v: number
	// Discriminated curve result, including failures with input-order diagnostics.
	readonly curve: AberrationFocusCurveResult
	// Best-focus position when the curve succeeds.
	readonly bestFocus?: number
	// Best-focus uncertainty when the curve can estimate it.
	readonly uncertainty?: number
	// Bounded regional curve confidence.
	readonly confidence: number
	// Warnings from aggregation and curve fitting.
	readonly warnings: readonly AberrationWarning[]
}

// One registered profile observation belonging to a persistent reference-frame star.
export interface AberrationStarTrackPoint {
	// Original scan frame index.
	readonly frameIndex: number
	// Focuser position in caller units.
	readonly position: number
	// Original optical profile from this frame.
	readonly profile: StarProfile
	// Registration correspondence residual in pixels.
	readonly residual: number
}

// Registered per-star observations and their optional individual focus curve.
export interface AberrationStarTrack {
	// Profile index in the selected reference frame inspection.
	readonly referenceIndex: number
	// Reference-frame X coordinate in pixels.
	readonly x: number
	// Reference-frame Y coordinate in pixels.
	readonly y: number
	// Reference-frame normalized sensor X coordinate.
	readonly u: number
	// Reference-frame normalized sensor Y coordinate.
	readonly v: number
	// Registered observations ordered by input frame.
	readonly points: readonly AberrationStarTrackPoint[]
	// Individual robust focus curve when enough unique positions are supported.
	readonly curve?: AberrationFocusCurveResult
}

// Configures optional star registration and persistent track construction.
export interface AberrationTrackingOptions {
	// Minimum registered frames required to publish a track.
	readonly minimumFrames?: number
	// Largest accepted per-correspondence residual in pixels.
	readonly maximumResidual?: number
	// Star-matching and transform-acceptance configuration without warp options.
	readonly registration?: Pick<ImageRegistrationOptions, 'matchStarsConfig' | 'acceptance'>
}

// Configures a sensor-fixed regional focus scan; tracking and registration are intentionally absent.
export interface AberrationFocusScanOptions {
	// Single-frame profile and selection configuration.
	readonly inspection?: Omit<InspectAberrationOptions, 'profiles' | 'regions'>
	// Scalar regional metric fitted over focuser position.
	readonly metric?: AberrationFocusMetric
	// Shared fixed sensor regions for every accepted frame.
	readonly regions?: AberrationRegionOptions
	// Robust regional curve-fitting options.
	readonly curve?: AberrationFocusCurveOptions
	// Focus-surface fitting options applied to successful regional minima.
	readonly surface?: FocusSurfaceFitOptions
	// Optional optical-spacing calibration that permits backfocus findings.
	readonly backfocusCalibration?: BackfocusCalibration
	// Optional registration settings that enable per-star tracks.
	readonly tracking?: AberrationTrackingOptions
}

// Summarizes focus-scan support and all non-fatal scan-wide warnings.
export interface AberrationFocusScanQuality {
	// Number of supplied frames.
	readonly inputFrameCount: number
	// Number of frames contributing regional measurements.
	readonly usedFrameCount: number
	// Number of rejected frames.
	readonly rejectedFrameCount: number
	// Bounded aggregate confidence across frames, regional curves, and surface support.
	readonly confidence: number
	// Discriminated confidence inputs; registration is absent for the regional MVP.
	readonly breakdown: AberrationConfidenceBreakdown
	// Stable scan-wide diagnostics.
	readonly warnings: readonly AberrationWarning[]
}

// Exposes independent focus-scan confidence components instead of hiding them in one score.
export interface AberrationConfidenceBreakdown {
	// Fraction of input frames accepted for the requested metric.
	readonly sampleSupport: number
	// Fraction of regions with successful two-sided curves.
	readonly spatialCoverage: number
	// Mean successful regional curve confidence.
	readonly curveQuality: number
	// Robust surface-fit confidence, or zero without a surface.
	readonly surfaceQuality: number
	// Registration quality when star tracking is enabled; unavailable in the regional MVP.
	readonly registrationQuality?: number
	// Mean single-frame inspection confidence.
	readonly stability: number
	// Bounded inverse conditioning penalty for the fitted surface.
	readonly conditioning: number
	// Fraction of regional curve points rejected by robust fitting.
	readonly outlierFraction: number
	// Geometric mean of applicable confidence-like components.
	readonly total: number
}

// Complete regional focus-scan result with optional fitted surface derivatives.
export interface AberrationFocusScanResult {
	// Shared sensor width in pixels when at least one frame was accepted.
	readonly width?: number
	// Shared sensor height in pixels when at least one frame was accepted.
	readonly height?: number
	// One result per input frame in original order.
	readonly frames: readonly AberrationFocusFrameResult[]
	// One regional curve per shared sensor region.
	readonly regions: readonly AberrationRegionFocusResult[]
	// Registered per-star curves when tracking was requested.
	readonly tracks?: readonly AberrationStarTrack[]
	// Surface fit from successful regional minima when enough regions support it.
	readonly surface?: FocusSurfaceFitResult
	// Planar derivative when a focus surface succeeds.
	readonly plane?: FocusPlaneAnalysis
	// Curvature derivative when a focus surface succeeds.
	readonly curvature?: FocusCurvatureAnalysis
	// Robust peripheral-minus-central best-focus offset when both supports are present.
	readonly fieldOffset?: FocusFieldOffset
	// Uncertainty-qualified focus-scan findings.
	readonly findings: readonly AberrationFinding[]
	// Support and warning diagnostics.
	readonly quality: AberrationFocusScanQuality
}

// An accepted regional metric observation before duplicate-position aggregation.
interface RegionObservation {
	// Focuser position in caller units.
	readonly position: number
	// Regional metric value in pixels.
	readonly value: number
	// Bounded inverse-variance-like statistical weight.
	readonly weight: number
	// Number of profiles supporting the regional metric.
	readonly starCount: number
	// Mean normalized sensor X of usable stars in this frame-region measurement.
	readonly u: number
	// Mean normalized sensor Y of usable stars in this frame-region measurement.
	readonly v: number
}

// Inspects a completed scan in fixed sensor coordinates, then fits regional curves and a best-focus surface.
export function inspectAberrationFocusScan(frames: readonly AberrationFocusFrame[], options: AberrationFocusScanOptions = {}): AberrationFocusScanResult {
	const metric = options.metric ?? 'hfd'
	const inspectionOptions = { ...options.inspection, regions: options.regions }
	const frameResults = new Array<AberrationFocusFrameResult>(frames.length)
	let width: number | undefined
	let height: number | undefined
	let usedFrameCount = 0

	for (let index = 0; index < frames.length; index++) {
		const frame = frames[index]
		const dimensions = frame.image ? { width: frame.image.metadata.width, height: frame.image.metadata.height } : frame.profiles ? { width: frame.width, height: frame.height } : undefined
		const validSource = (frame.image === undefined) !== (frame.profiles === undefined)
		if (!validSource || !Number.isFinite(frame.position) || !validDimensions(dimensions)) {
			frameResults[index] = rejectedFrame(index, frame, 'invalidInput')
			continue
		}
		if (width !== undefined && (width !== dimensions.width || height !== dimensions.height)) {
			frameResults[index] = rejectedFrame(index, frame, 'inconsistentDimensions')
			continue
		}

		const inspection = frame.image ? inspectAberration(frame.image, inspectionOptions) : inspectAberrationProfiles(dimensions.width, dimensions.height, frame.profiles!, inspectionOptions)
		if (inspection.quality.selectedStarCount === 0) {
			frameResults[index] = rejectedFrame(index, frame, 'insufficientProfiles', inspection.quality.warnings)
			continue
		}
		if (!inspection.regions.some((region) => (metric === 'hfd' ? region.medianHFD : region.medianFWHM) !== undefined)) {
			frameResults[index] = { index, id: frame.id, position: frame.position, status: 'rejected', inspection, rejectionReasons: ['unsupportedPosition'], warnings: inspection.quality.warnings }
			continue
		}
		width = dimensions.width
		height = dimensions.height
		usedFrameCount++
		frameResults[index] = { index, id: frame.id, position: frame.position, status: 'used', inspection, rejectionReasons: [], warnings: inspection.quality.warnings }
	}

	const tracking = options.tracking ? buildStarTracks(frameResults, metric, width, height, options.tracking, options.curve) : undefined
	if (tracking) {
		for (let i = 0; i < tracking.failedFrames.length; i++) {
			const index = tracking.failedFrames[i]
			const frame = frameResults[index]
			if (frame.status !== 'used') continue
			frameResults[index] = { ...frame, status: 'rejected', rejectionReasons: ['registrationFailed'] }
			usedFrameCount--
		}
	}
	const regions = regionalCurves(frameResults, metric, options.curve)
	const surfaceSamples = []
	for (let i = 0; i < regions.length; i++) {
		const region = regions[i]
		if (region.bestFocus === undefined) continue
		surfaceSamples.push({ u: region.u, v: region.v, focus: region.bestFocus, uncertainty: region.uncertainty !== undefined && region.uncertainty > 0 ? region.uncertainty : undefined, sourceIndex: i })
	}
	if (tracking)
		for (let i = 0; i < tracking.tracks.length; i++) {
			const track = tracking.tracks[i]
			if (!track.curve?.success) continue
			surfaceSamples.push({ u: track.u, v: track.v, focus: track.curve.minimum.x, uncertainty: track.curve.uncertainty !== undefined && track.curve.uncertainty > 0 ? track.curve.uncertainty : undefined, sourceIndex: regions.length + i })
		}
	const surface = surfaceSamples.length > 0 ? fitFocusSurface(surfaceSamples, options.surface) : undefined
	const plane = surface?.success ? analyzeFocusPlane(surface.coefficients) : undefined
	const curvature = surface?.success ? analyzeFocusCurvature(surface.coefficients) : undefined
	const fieldOffset = measureFocusFieldOffset(regions)
	const backfocusCalibrated = options.backfocusCalibration !== undefined && Number.isFinite(options.backfocusCalibration.response) && options.backfocusCalibration.response !== 0
	const findings = diagnoseFocusScan(surface, plane, curvature, fieldOffset, backfocusCalibrated)
	const warnings: AberrationWarning[] = []
	if (usedFrameCount === 0) warnings.push({ code: 'noUsableFrames' })
	if (surface && !surface.success) warnings.push({ code: 'surfaceFitFailed' })
	if (options.backfocusCalibration !== undefined && !backfocusCalibrated) warnings.push({ code: 'invalidBackfocusCalibration' })
	const breakdown = confidenceBreakdown(frameResults, regions, surface, metric, tracking?.quality)
	const confidence = breakdown.total

	return { width, height, frames: frameResults, regions, tracks: tracking?.tracks, surface, plane, curvature, fieldOffset, findings, quality: { inputFrameCount: frames.length, usedFrameCount, rejectedFrameCount: frames.length - usedFrameCount, confidence, breakdown, warnings } }
}

// Computes independent support and model-quality components plus their applicable geometric mean.
function confidenceBreakdown(frames: readonly AberrationFocusFrameResult[], regions: readonly AberrationRegionFocusResult[], surface: FocusSurfaceFitResult | undefined, metric: AberrationFocusMetric, registrationQuality?: number): AberrationConfidenceBreakdown {
	let usedFrames = 0
	let stability = 0
	for (let i = 0; i < frames.length; i++) {
		const frame = frames[i]
		if (frame.status !== 'used' || frame.inspection === undefined) continue
		usedFrames++
		let metricSamples = 0
		for (let j = 0; j < frame.inspection.regions.length; j++) metricSamples += frame.inspection.regions[j].usedStarCountByMetric[metric] ?? 0
		stability += Math.min(1, metricSamples / frame.inspection.quality.selectedStarCount)
	}
	let successfulRegions = 0
	let curveQuality = 0
	let pointCount = 0
	let rejectedPointCount = 0
	for (let i = 0; i < regions.length; i++) {
		const curve = regions[i].curve
		if (curve.success) {
			successfulRegions++
			curveQuality += curve.confidence
		}
		pointCount += curve.used.length
		for (let j = 0; j < curve.used.length; j++) if (!curve.used[j]) rejectedPointCount++
	}
	const sampleSupport = frames.length > 0 ? usedFrames / frames.length : 0
	const spatialCoverage = regions.length > 0 ? successfulRegions / regions.length : 0
	curveQuality = successfulRegions > 0 ? curveQuality / successfulRegions : 0
	const surfaceQuality = surface?.success ? surface.confidence : 0
	const conditioning = surface?.success ? 1 / (1 + Math.log10(Math.max(1, surface.conditionNumber))) : 0
	const stable = usedFrames > 0 ? stability / usedFrames : 0
	const outlierFraction = pointCount > 0 ? rejectedPointCount / pointCount : 0
	const factors = [sampleSupport, spatialCoverage, curveQuality, surfaceQuality, stable, conditioning, 1 - outlierFraction]
	if (registrationQuality !== undefined) factors.push(registrationQuality)
	let logarithm = 0
	for (let i = 0; i < factors.length; i++) {
		if (!(factors[i] > 0)) return { sampleSupport, spatialCoverage, curveQuality, surfaceQuality, registrationQuality, stability: stable, conditioning, outlierFraction, total: 0 }
		logarithm += Math.log(factors[i])
	}
	return { sampleSupport, spatialCoverage, curveQuality, surfaceQuality, registrationQuality, stability: stable, conditioning, outlierFraction, total: Math.exp(logarithm / factors.length) }
}

// Builds registered per-star tracks without allocating warped images.
function buildStarTracks(
	frames: readonly AberrationFocusFrameResult[],
	metric: AberrationFocusMetric,
	width: number | undefined,
	height: number | undefined,
	options: AberrationTrackingOptions,
	curveOptions: AberrationFocusCurveOptions | undefined,
): { readonly tracks: readonly AberrationStarTrack[]; readonly failedFrames: readonly number[]; readonly quality: number } {
	if (width === undefined || height === undefined) return { tracks: [], failedFrames: [], quality: 0 }
	const usedIndices: number[] = []
	for (let i = 0; i < frames.length; i++) if (frames[i].status === 'used' && frames[i].inspection !== undefined) usedIndices.push(i)
	if (usedIndices.length === 0) return { tracks: [], failedFrames: [], quality: 0 }
	usedIndices.sort((a, b) => frames[a].position - frames[b].position || a - b)
	const referenceFrameIndex = usedIndices[usedIndices.length >>> 1]
	const referenceFrame = frames[referenceFrameIndex]
	const reference = trackEntries(referenceFrame.inspection!, metric)
	const builders = new Array<AberrationStarTrackPoint[]>(reference.length)
	for (let i = 0; i < reference.length; i++) builders[i] = [{ frameIndex: referenceFrameIndex, position: referenceFrame.position, profile: reference[i].profile, residual: 0 }]
	const failedFrames: number[] = []
	let registrationQuality = 0
	let registeredFrames = 1
	const maximumResidual = finitePositive(options.maximumResidual, Number.POSITIVE_INFINITY)

	for (let ordered = 0; ordered < usedIndices.length; ordered++) {
		const frameIndex = usedIndices[ordered]
		if (frameIndex === referenceFrameIndex) continue
		const frame = frames[frameIndex]
		const target = trackEntries(frame.inspection!, metric)
		const registration = registerStars(
			reference.map((entry) => entry.star),
			target.map((entry) => entry.star),
			options.registration,
		)
		if (!registration.success) {
			failedFrames.push(frameIndex)
			continue
		}
		registeredFrames++
		registrationQuality += 1 / (1 + registration.transform.summary.rmsError)
		for (let i = 0; i < registration.match.matches.length; i++) {
			const match = registration.match.matches[i]
			if (match.residual > maximumResidual) continue
			builders[match.referenceIndex].push({ frameIndex, position: frame.position, profile: target[match.currentIndex].profile, residual: match.residual })
		}
	}

	const minimumFrames = positiveInteger(options.minimumFrames, 5)
	const tracks: AberrationStarTrack[] = []
	for (let i = 0; i < builders.length; i++) {
		const points = builders[i]
		if (points.length < minimumFrames) continue
		points.sort((a, b) => a.frameIndex - b.frameIndex)
		const curve = fitAberrationFocusCurve(trackCurvePoints(points, metric), curveOptions)
		const profile = reference[i].profile
		tracks.push({ referenceIndex: reference[i].profileIndex, x: profile.x, y: profile.y, u: profile.x / (width - 1) - 0.5, v: profile.y / (height - 1) - 0.5, points, curve })
	}
	return { tracks, failedFrames, quality: registeredFrames > 1 ? registrationQuality / (registeredFrames - 1) : 0 }
}

// Adapts selected optical profiles to the existing detector-star registration contract.
function trackEntries(inspection: AberrationInspectionResult, metric: AberrationFocusMetric): { readonly star: DetectedStar; readonly profile: StarProfile; readonly profileIndex: number }[] {
	const entries: { star: DetectedStar; profile: StarProfile; profileIndex: number }[] = []
	for (let i = 0; i < inspection.stars.length; i++) {
		const inspected = inspection.stars[i]
		const profile = inspected.profile
		const size = metric === 'fwhm' ? profile.fwhm : profile.hfd
		if (!inspected.selected || size === undefined || profile.snr === undefined || profile.flux === undefined || inspected.rejections.some((rejection) => rejection.metric === metric)) continue
		entries.push({ star: { x: profile.x, y: profile.y, hfd: profile.hfd ?? size, fwhm: profile.fwhm, eccentricity: profile.eccentricity, elongation: profile.elongation, snr: profile.snr, flux: profile.flux }, profile, profileIndex: i })
	}
	return entries
}

// Aggregates duplicate exposures in one star track into unique focus-curve positions.
function trackCurvePoints(points: readonly AberrationStarTrackPoint[], metric: AberrationFocusMetric): { readonly position: number; readonly value: number }[] {
	const groups = new Map<number, number[]>()
	for (let i = 0; i < points.length; i++) {
		const value = metric === 'hfd' ? points[i].profile.hfd : points[i].profile.fwhm
		if (value === undefined) continue
		let group = groups.get(points[i].position)
		if (group === undefined) {
			group = []
			groups.set(points[i].position, group)
		}
		group.push(value)
	}
	const curve: { position: number; value: number }[] = []
	for (const [position, values] of groups) {
		values.sort((a, b) => a - b)
		const middle = values.length >>> 1
		curve.push({ position, value: values.length % 2 === 0 ? 0.5 * (values[middle - 1] + values[middle]) : values[middle] })
	}
	curve.sort((a, b) => a.position - b.position)
	return curve
}

// Returns a finite positive option or fallback, allowing Infinity as an explicit disabled limit.
function finitePositive(value: number | undefined, fallback: number): number {
	return value !== undefined && value > 0 && (Number.isFinite(value) || value === Number.POSITIVE_INFINITY) ? value : fallback
}

// Returns a finite positive integer option or fallback.
function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}

// Builds one fixed-sensor regional curve per region from accepted frame inspections.
function regionalCurves(frames: readonly AberrationFocusFrameResult[], metric: AberrationFocusMetric, options: AberrationFocusCurveOptions | undefined): AberrationRegionFocusResult[] {
	let regionCount = 0
	for (let i = 0; i < frames.length; i++)
		if (frames[i].status === 'used' && frames[i].inspection) {
			regionCount = frames[i].inspection!.regions.length
			break
		}
	const output = new Array<AberrationRegionFocusResult>(regionCount)
	const coordinates = new Array<readonly ({ readonly x: number; readonly y: number } | undefined)[] | undefined>(frames.length)
	for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
		if (frames[frameIndex].status !== 'used') continue
		const inspection = frames[frameIndex].inspection
		if (inspection !== undefined) coordinates[frameIndex] = regionalCoordinates(inspection, metric)
	}

	for (let regionIndex = 0; regionIndex < regionCount; regionIndex++) {
		const observations: RegionObservation[] = []
		let definition: AberrationRegionDefinition | undefined
		for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
			const frame = frames[frameIndex]
			if (frame.status !== 'used' || !frame.inspection) continue
			const region = frame.inspection.regions[regionIndex]
			definition ??= region.bounds
			const value = metric === 'hfd' ? region.medianHFD : region.medianFWHM
			const deviation = metric === 'hfd' ? region.deviationHFD : region.deviationFWHM
			const starCount = region.usedStarCountByMetric[metric] ?? 0
			if (value === undefined || !(starCount > 0)) continue
			const coordinate = coordinates[frameIndex]?.[regionIndex]
			if (coordinate === undefined) continue
			observations.push({ position: frame.position, value, weight: regionWeight(value, deviation, starCount), starCount, u: coordinate.x, v: coordinate.y })
		}
		const points = aggregatePositions(observations)
		const curve = fitAberrationFocusCurve(points, options)
		const curveWarnings = curve.warnings
		const coordinate = representativeCoordinate(points, definition!)
		output[regionIndex] = { region: definition!, u: coordinate.x, v: coordinate.y, curve, bestFocus: curve.success ? curve.minimum.x : undefined, uncertainty: curve.success ? curve.uncertainty : undefined, confidence: curve.success ? curve.confidence : 0, warnings: curveWarnings }
	}

	return output
}

// Aggregates repeated exposures at one focuser position into one explicit robust curve point.
function aggregatePositions(observations: readonly RegionObservation[]): { readonly position: number; readonly value: number; readonly weight: number; readonly starCount: number; readonly u: number; readonly v: number }[] {
	const groups = new Map<number, RegionObservation[]>()
	for (let i = 0; i < observations.length; i++) {
		const observation = observations[i]
		let group = groups.get(observation.position)
		if (group === undefined) {
			group = []
			groups.set(observation.position, group)
		}
		group.push(observation)
	}
	const points: { position: number; value: number; weight: number; starCount: number; u: number; v: number }[] = []
	for (const [position, group] of groups) {
		const values = group.map((observation) => observation.value).sort((a, b) => a - b)
		const middle = values.length >>> 1
		const value = values.length % 2 === 0 ? 0.5 * (values[middle - 1] + values[middle]) : values[middle]
		let weight = 0
		let starCount = 0
		let u = 0
		let v = 0
		for (let i = 0; i < group.length; i++) {
			weight += group[i].weight
			starCount += group[i].starCount
			u += group[i].weight * group[i].u
			v += group[i].weight * group[i].v
		}
		points.push({ position, value, weight, starCount, u: u / weight, v: v / weight })
	}
	points.sort((left, right) => left.position - right.position)
	return points
}

// Computes mean usable-star coordinates for every region in one pass over an inspection.
function regionalCoordinates(inspection: AberrationInspectionResult, metric: AberrationFocusMetric): readonly ({ readonly x: number; readonly y: number } | undefined)[] {
	const x = new Float64Array(inspection.regions.length)
	const y = new Float64Array(inspection.regions.length)
	const count = new Uint32Array(inspection.regions.length)
	const bounds = new Array<AberrationRegionDefinition>(inspection.regions.length)
	for (let i = 0; i < bounds.length; i++) bounds[i] = inspection.regions[i].bounds
	for (let i = 0; i < inspection.stars.length; i++) {
		const star = inspection.stars[i]
		const value = metric === 'hfd' ? star.profile.hfd : star.profile.fwhm
		if (!star.selected || value === undefined || hasMetricRejection(star, metric)) continue
		const regionIndex = assignAberrationRegion(star.u, star.v, bounds)
		if (regionIndex < 0) continue
		x[regionIndex] += star.u
		y[regionIndex] += star.v
		count[regionIndex]++
	}
	const coordinates = new Array<{ readonly x: number; readonly y: number } | undefined>(inspection.regions.length)
	for (let i = 0; i < coordinates.length; i++) coordinates[i] = count[i] > 0 ? { x: x[i] / count[i], y: y[i] / count[i] } : undefined
	return coordinates
}

// Tests one inspected star for a metric-specific exclusion without allocating a callback.
function hasMetricRejection(star: AberrationInspectionResult['stars'][number], metric: AberrationFocusMetric): boolean {
	for (let i = 0; i < star.rejections.length; i++) if (star.rejections[i].metric === metric) return true
	return false
}

// Returns the weighted mean measurement coordinate, falling back to the region center only without points.
function representativeCoordinate(points: readonly { readonly weight: number; readonly u: number; readonly v: number }[], region: AberrationRegionDefinition): { readonly x: number; readonly y: number } {
	if (points.length === 0) return regionCenter(region)
	let weight = 0
	let x = 0
	let y = 0
	for (let i = 0; i < points.length; i++) {
		weight += points[i].weight
		x += points[i].weight * points[i].u
		y += points[i].weight * points[i].v
	}
	return { x: x / weight, y: y / weight }
}

// Computes a bounded inverse-variance-like regional weight from robust scatter and support.
function regionWeight(value: number, deviation: number | undefined, starCount: number): number {
	const floor = Math.max(1e-6, value * 1e-6)
	const standardError = deviation === undefined ? Math.max(floor, value * 0.1) : Math.max(floor, deviation / Math.sqrt(starCount))
	return Math.min(1e12, 1 / (standardError * standardError))
}

// Returns normalized center coordinates for a rectangular fixed sensor region.
function regionCenter(region: AberrationRegionDefinition): { readonly x: number; readonly y: number } {
	return { x: 0.5 * (region.left + region.right), y: 0.5 * (region.top + region.bottom) }
}

// Builds a rejected frame result while preserving original identity and position.
function rejectedFrame(index: number, frame: AberrationFocusFrame, reason: AberrationFocusFrameRejectionReason, warnings: readonly AberrationWarning[] = []): AberrationFocusFrameResult {
	return { index, id: frame.id, position: frame.position, status: 'rejected', rejectionReasons: [reason], warnings }
}

// Validates finite positive dimensions before profiles are normalized into sensor coordinates.
function validDimensions(dimensions: { readonly width?: number; readonly height?: number } | undefined): dimensions is { readonly width: number; readonly height: number } {
	return dimensions?.width !== undefined && dimensions.height !== undefined && Number.isInteger(dimensions.width) && Number.isInteger(dimensions.height) && dimensions.width > 1 && dimensions.height > 1
}
