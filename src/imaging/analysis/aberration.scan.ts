import { analyzeFocusCurvature, analyzeFocusPlane, fitFocusSurface, type FocusCurvatureAnalysis, type FocusPlaneAnalysis, type FocusSurfaceFitOptions, type FocusSurfaceFitResult } from '../../math/numerical/surface.fit'
import type { Image } from '../model/types'
import type { StarProfile } from '../stars/profile'
import { fitAberrationFocusCurve, type AberrationFocusCurveOptions, type AberrationFocusCurveResult, type AberrationFocusMetric } from './aberration.focus'
import { inspectAberration, inspectAberrationProfiles, type InspectAberrationOptions } from './aberration.single'
import type { AberrationInspectionResult, AberrationRegionDefinition, AberrationRegionOptions, AberrationWarning } from './aberration.types'

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
export type AberrationFocusFrameRejectionReason = 'invalidInput' | 'inconsistentDimensions' | 'insufficientProfiles' | 'unsupportedPosition'

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
	// Stable scan-wide diagnostics.
	readonly warnings: readonly AberrationWarning[]
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
	// Surface fit from successful regional minima when enough regions support it.
	readonly surface?: FocusSurfaceFitResult
	// Planar derivative when a focus surface succeeds.
	readonly plane?: FocusPlaneAnalysis
	// Curvature derivative when a focus surface succeeds.
	readonly curvature?: FocusCurvatureAnalysis
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
		width = dimensions.width
		height = dimensions.height
		usedFrameCount++
		frameResults[index] = { index, id: frame.id, position: frame.position, status: 'used', inspection, rejectionReasons: [], warnings: inspection.quality.warnings }
	}

	const regions = regionalCurves(frameResults, metric, options.curve)
	const surfaceSamples = []
	for (let i = 0; i < regions.length; i++) {
		const region = regions[i]
		if (region.bestFocus === undefined) continue
		surfaceSamples.push({ u: region.u, v: region.v, focus: region.bestFocus, uncertainty: region.uncertainty !== undefined && region.uncertainty > 0 ? region.uncertainty : undefined, sourceIndex: i })
	}
	const surface = surfaceSamples.length > 0 ? fitFocusSurface(surfaceSamples, options.surface) : undefined
	const plane = surface?.success ? analyzeFocusPlane(surface.coefficients) : undefined
	const curvature = surface?.success ? analyzeFocusCurvature(surface.coefficients) : undefined
	const warnings: AberrationWarning[] = []
	if (usedFrameCount === 0) warnings.push({ code: 'noUsableFrames' })
	if (surface && !surface.success) warnings.push({ code: 'surfaceFitFailed' })
	const curveConfidence = regions.length > 0 ? regions.reduce((sum, region) => sum + region.confidence, 0) / regions.length : 0
	const confidence = Math.sqrt((frames.length > 0 ? usedFrameCount / frames.length : 0) * curveConfidence * (surface?.success ? surface.confidence : 0))

	return { width, height, frames: frameResults, regions, surface, plane, curvature, quality: { inputFrameCount: frames.length, usedFrameCount, rejectedFrameCount: frames.length - usedFrameCount, confidence, warnings } }
}

// Builds one fixed-sensor regional curve per region from accepted frame inspections.
function regionalCurves(frames: readonly AberrationFocusFrameResult[], metric: AberrationFocusMetric, options: AberrationFocusCurveOptions | undefined): AberrationRegionFocusResult[] {
	let regionCount = 0
	for (let i = 0; i < frames.length; i++)
		if (frames[i].inspection) {
			regionCount = frames[i].inspection!.regions.length
			break
		}
	const output = new Array<AberrationRegionFocusResult>(regionCount)

	for (let regionIndex = 0; regionIndex < regionCount; regionIndex++) {
		const observations: RegionObservation[] = []
		let definition: AberrationRegionDefinition | undefined
		for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
			const frame = frames[frameIndex]
			if (!frame.inspection) continue
			const region = frame.inspection.regions[regionIndex]
			definition ??= region.bounds
			const value = metric === 'hfd' ? region.medianHFD : region.medianFWHM
			const deviation = metric === 'hfd' ? region.deviationHFD : region.deviationFWHM
			const starCount = region.usedStarCountByMetric[metric] ?? 0
			if (value === undefined || !(starCount > 0)) continue
			const coordinate = regionalCoordinate(frame.inspection, regionIndex, metric)
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

// Computes the mean sensor coordinate of selected stars usable for one regional scalar metric.
function regionalCoordinate(inspection: AberrationInspectionResult, regionIndex: number, metric: AberrationFocusMetric): { readonly x: number; readonly y: number } | undefined {
	const bounds = inspection.regions[regionIndex].bounds
	let x = 0
	let y = 0
	let count = 0
	for (let i = 0; i < inspection.stars.length; i++) {
		const star = inspection.stars[i]
		const value = metric === 'hfd' ? star.profile.hfd : star.profile.fwhm
		if (!star.selected || value === undefined || !containsRegion(bounds, star.u, star.v) || star.rejections.some((rejection) => rejection.metric === metric)) continue
		x += star.u
		y += star.v
		count++
	}
	return count > 0 ? { x: x / count, y: y / count } : undefined
}

// Applies the same half-open normalized-region boundary convention as the single-frame inspector.
function containsRegion(region: AberrationRegionDefinition, u: number, v: number): boolean {
	return u >= region.left && (u < region.right || (region.right === 0.5 && u <= region.right)) && v >= region.top && (v < region.bottom || (region.bottom === 0.5 && v <= region.bottom))
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
