import { clamp } from '../../math/numerical/math'
import type { Image } from '../model/types'
import type { DetectStarOptions } from '../stars/detector'
import { type MeasureStarProfileOptions, type StarProfile, detectStarProfiles } from '../stars/profile'
import { diagnoseSingleFrameAberration } from './aberration.diagnostic'
import { assignAberrationRegion, createAberrationRegions, summarizeAberrationRegions } from './aberration.region'
import type { AberrationInspectionResult, AberrationMeasuredQuantity, AberrationMetric, AberrationMetricRejection, AberrationMetricRejectionReason, AberrationRegionOptions, AberrationStar, AberrationStarRejectionReason, AberrationWarning, SpatialStarSelectionOptions } from './aberration.types'

// Deterministic one-image aberration inspection built from robust star profiles and spatial summaries.

// Default maximum profiles retained per balancing cell.
const DEFAULT_MAXIMUM_PER_CELL = 20
// Default maximum profiles retained over one inspection.
const DEFAULT_MAXIMUM_TOTAL = 200
// Default balancing-grid columns.
const DEFAULT_SELECTION_COLUMNS = 3
// Default balancing-grid rows.
const DEFAULT_SELECTION_ROWS = 3
// Default minimum selected profiles required for a supported inspection.
const DEFAULT_MINIMUM_STARS = 10
// Default minimum usable HFD profiles required to call a region occupied.
const DEFAULT_MINIMUM_STARS_PER_REGION = 3
// Default clipping passes once a positive sigma threshold is supplied.
const DEFAULT_MAX_CLIP_ITERATIONS = 2
// Minimum usable axial profiles required to describe a directional field.
const DEFAULT_MINIMUM_ORIENTATION_STARS = 3
// SNR reference that bounds profile weights without allowing bright stars to dominate a region.
const REFERENCE_SNR = 30
// Minimum eccentricity that makes an axial direction meaningful in the single-frame pipeline.
const MINIMUM_ORIENTATION_ECCENTRICITY = 0.05

// Configures profile production, balanced selection, robust regional summaries, and optional supplied profiles.
export interface InspectAberrationOptions {
	// Fast detector options used only when `profiles` is not supplied.
	readonly detection?: Partial<DetectStarOptions>
	// Optical profile options used only when `profiles` is not supplied.
	readonly profile?: MeasureStarProfileOptions
	// Balanced spatial selection options applied after profile eligibility checks.
	readonly selection?: SpatialStarSelectionOptions
	// Generated or custom normalized sensor regions.
	readonly regions?: AberrationRegionOptions
	// Minimum selected profiles required for an inspection to be considered supported.
	readonly minimumStars?: number
	// Minimum usable HFD profiles required to count a region as occupied.
	readonly minimumStarsPerRegion?: number
	// Additional minimum SNR required during spatial selection.
	readonly minimumSNR?: number
	// Optional eccentricity above which HFD and FWHM are excluded as distorted size measurements.
	readonly maximumEccentricityForSize?: number
	// Positive regional sigma-clipping threshold; omit or set non-positive to disable clipping.
	readonly sigmaClip?: number
	// Maximum regional clipping passes when `sigmaClip` is positive.
	readonly maxIterations?: number
	// Pre-measured profiles that bypass image detection and profile measurement.
	readonly profiles?: readonly StarProfile[]
}

// Inspects one image or supplied profile set and returns discriminated spatial aberration diagnostics.
export function inspectAberration(image: Image, options: InspectAberrationOptions = {}): AberrationInspectionResult {
	const { width, height } = image.metadata
	const profiles = options.profiles ?? detectStarProfiles(image, options.detection, options.profile)
	return inspectAberrationProfiles(width, height, profiles, options)
}

// Inspects supplied optical profiles for explicit image dimensions without rerunning detection.
export function inspectAberrationProfiles(width: number, height: number, profiles: readonly StarProfile[], options: Omit<InspectAberrationOptions, 'profiles'> = {}): AberrationInspectionResult {
	const minimumSNR = Math.max(0, finiteNumber(options.minimumSNR, 0))
	const stars = prepareStars(profiles, width, height, minimumSNR, options.maximumEccentricityForSize)
	const selected = selectSpatialStars(stars, options.selection, minimumSNR)
	const regions = createAberrationRegions(options.regions)
	const clipped = applyRegionalOutliers(selected, regions, options.sigmaClip, options.maxIterations)
	const summaries = summarizeAberrationRegions(clipped, regions, { minimumStars: positiveInteger(options.minimumStarsPerRegion, DEFAULT_MINIMUM_STARS_PER_REGION) })
	const quality = inspectionQuality(clipped, summaries, profiles.length, options.minimumStars, options.minimumStarsPerRegion)
	const vectors = buildVectors(summaries, width, height)
	const findings = diagnoseSingleFrameAberration(clipped, summaries, quality)

	return { width, height, stars: clipped, regions: summaries, vectors, quality, findings }
}

// Normalizes input profiles and records profile-level plus metric-level exclusions before spatial selection.
function prepareStars(profiles: readonly StarProfile[], width: number, height: number, minimumSNR: number, maximumEccentricityForSize: number | undefined): AberrationStar[] {
	const stars = new Array<AberrationStar>(profiles.length)
	const maximumEccentricity = maximumEccentricityForSize !== undefined && Number.isFinite(maximumEccentricityForSize) ? clamp(maximumEccentricityForSize, 0, 1) : undefined

	for (let i = 0; i < profiles.length; i++) {
		const profile = profiles[i]
		const u = width > 1 && Number.isFinite(profile.x) ? profile.x / (width - 1) - 0.5 : Number.NaN
		const v = height > 1 && Number.isFinite(profile.y) ? profile.y / (height - 1) - 0.5 : Number.NaN
		const selectionReasons: AberrationStarRejectionReason[] = []
		const rejections: AberrationMetricRejection[] = []

		if (!profile.valid) addSelectionReason(selectionReasons, 'invalidProfile')
		if (!Number.isFinite(u) || !Number.isFinite(v) || u < -0.5 || u > 0.5 || v < -0.5 || v > 0.5) addSelectionReason(selectionReasons, 'nonFiniteCoordinate')
		if (profile.snr === undefined || profile.snr < minimumSNR) addSelectionReason(selectionReasons, 'belowMinimumSNR')
		for (const metric of ['hfd', 'fwhm', 'eccentricity', 'elongation'] as const) {
			if (profileMetric(profile, metric) === undefined) addMetricRejection(rejections, metric, 'unavailable')
		}

		if (profile.theta === undefined || profile.eccentricity === undefined || profile.eccentricity < MINIMUM_ORIENTATION_ECCENTRICITY) addMetricRejection(rejections, 'orientation', 'degenerateShape')
		if (profile.flags.includes('lowSignal') || (profile.snr !== undefined && profile.snr < minimumSNR)) addAllMetricRejections(rejections, 'lowSignal')
		if (profile.flags.includes('saturated') || profile.flags.includes('clipped') || !profile.valid) addAllMetricRejections(rejections, 'unavailable')
		if (profile.flags.includes('blended')) addAllMetricRejections(rejections, 'unavailable')
		if (maximumEccentricity !== undefined && profile.eccentricity !== undefined && profile.eccentricity > maximumEccentricity) {
			addMetricRejection(rejections, 'hfd', 'degenerateShape')
			addMetricRejection(rejections, 'fwhm', 'degenerateShape')
		}

		stars[i] = {
			profile,
			u,
			v,
			weight: profileWeight(profile),
			selected: false,
			selectionReasons,
			rejections,
		}
	}

	return stars
}

// Applies a deterministic per-cell quota and global cap while preserving the input result order.
function selectSpatialStars(stars: readonly AberrationStar[], options: SpatialStarSelectionOptions | undefined, minimumSNR: number): AberrationStar[] {
	const columns = positiveInteger(options?.columns, DEFAULT_SELECTION_COLUMNS)
	const rows = positiveInteger(options?.rows, DEFAULT_SELECTION_ROWS)
	const maximumPerCell = positiveInteger(options?.maximumPerCell, DEFAULT_MAXIMUM_PER_CELL)
	const maximumTotal = positiveInteger(options?.maximumTotal, DEFAULT_MAXIMUM_TOTAL)
	const minSNR = Math.max(minimumSNR, Math.max(0, finiteNumber(options?.minSNR, 0)))
	const rejectSaturated = options?.rejectSaturated ?? true
	const rejectClipped = options?.rejectClipped ?? true
	const rejectBlended = options?.rejectBlended ?? true
	const cells = new Array<number[]>(columns * rows)

	for (let i = 0; i < cells.length; i++) cells[i] = []

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		const reasons = [...star.selectionReasons]
		if (star.profile.snr === undefined || star.profile.snr < minSNR) addSelectionReason(reasons, 'belowMinimumSNR')
		if (rejectSaturated && star.profile.flags.includes('saturated')) addSelectionReason(reasons, 'saturated')
		if (rejectClipped && star.profile.flags.includes('clipped')) addSelectionReason(reasons, 'clipped')
		if (rejectBlended && star.profile.flags.includes('blended')) addSelectionReason(reasons, 'blended')
		if (reasons.length > 0) continue

		const column = Math.min(columns - 1, Math.max(0, Math.floor((star.u + 0.5) * columns)))
		const row = Math.min(rows - 1, Math.max(0, Math.floor((star.v + 0.5) * rows)))
		cells[row * columns + column].push(i)
	}

	const selected = new Uint8Array(stars.length)
	let selectedCount = 0

	for (let cell = 0; cell < cells.length; cell++) cells[cell].sort((a, b) => stars[b].weight - stars[a].weight || a - b)

	for (let rank = 0; rank < maximumPerCell && selectedCount < maximumTotal; rank++) {
		for (let cell = 0; cell < cells.length && selectedCount < maximumTotal; cell++) {
			const index = cells[cell][rank]
			if (index === undefined) continue
			selected[index] = 1
			selectedCount++
		}
	}

	const output = new Array<AberrationStar>(stars.length)
	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		const selectionReasons = [...star.selectionReasons]
		if (star.profile.snr === undefined || star.profile.snr < minSNR) addSelectionReason(selectionReasons, 'belowMinimumSNR')
		if (rejectSaturated && star.profile.flags.includes('saturated')) addSelectionReason(selectionReasons, 'saturated')
		if (rejectClipped && star.profile.flags.includes('clipped')) addSelectionReason(selectionReasons, 'clipped')
		if (rejectBlended && star.profile.flags.includes('blended')) addSelectionReason(selectionReasons, 'blended')
		if (selectionReasons.length === 0 && selected[i] === 0) addSelectionReason(selectionReasons, 'spatialQuota')

		output[i] = { ...star, selected: selected[i] === 1, selectionReasons }
	}

	return output
}

// Applies optional scalar sigma clipping independently inside each assigned spatial region.
function applyRegionalOutliers(stars: readonly AberrationStar[], regions: ReturnType<typeof createAberrationRegions>, sigmaClip: number | undefined, maxIterations: number | undefined): AberrationStar[] {
	if (!(sigmaClip !== undefined && Number.isFinite(sigmaClip) && sigmaClip > 0)) return [...stars]

	const iterations = positiveInteger(maxIterations, DEFAULT_MAX_CLIP_ITERATIONS)
	let output = [...stars]

	for (let iteration = 0; iteration < iterations; iteration++) {
		let changed = false
		const next = output.map((star) => ({ ...star, rejections: [...star.rejections] }))

		for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
			const indices: number[] = []
			for (let i = 0; i < next.length; i++) {
				if (assignAberrationRegion(next[i].u, next[i].v, regions) === regionIndex) indices.push(i)
			}

			for (const metric of ['hfd', 'fwhm', 'eccentricity', 'elongation'] as const) {
				const values = collectMetricIndices(next, indices, metric)
				if (values.length < 3) continue
				const center = median(values.map((value) => value.value))
				const deviation = scaledMad(
					values.map((value) => value.value),
					center,
				)
				const threshold = Math.max(sigmaClip * deviation, Number.EPSILON * Math.max(1, Math.abs(center)))
				for (let i = 0; i < values.length; i++) {
					if (Math.abs(values[i].value - center) <= threshold) continue
					if (!hasMetricRejection(next[values[i].index], metric)) {
						addMetricRejection(next[values[i].index].rejections, metric, 'outlier')
						changed = true
					}
				}
			}
		}

		output = next
		if (!changed) break
	}

	return output
}

// Collects scalar values and owning indices that are currently usable for a metric.
function collectMetricIndices(stars: readonly AberrationStar[], indices: readonly number[], metric: AberrationMetric): { readonly index: number; readonly value: number }[] {
	const output: { index: number; value: number }[] = []

	for (let i = 0; i < indices.length; i++) {
		const index = indices[i]
		const star = stars[index]
		const value = usableMetric(star, metric)
		if (value !== undefined) output.push({ index, value })
	}

	return output
}

// Computes support, per-metric counts, warnings, and bounded overall inspection confidence.
function inspectionQuality(stars: readonly AberrationStar[], regions: ReturnType<typeof summarizeAberrationRegions>, detectedStarCount: number, minimumStarsOption: number | undefined, minimumStarsPerRegionOption: number | undefined) {
	const minimumStars = positiveInteger(minimumStarsOption, DEFAULT_MINIMUM_STARS)
	const minimumStarsPerRegion = positiveInteger(minimumStarsPerRegionOption, DEFAULT_MINIMUM_STARS_PER_REGION)
	const usedStarCountByMetric: Partial<Record<AberrationMeasuredQuantity, number>> = {}

	for (const metric of ['hfd', 'fwhm', 'eccentricity', 'elongation'] as const) {
		let count = 0
		for (let i = 0; i < stars.length; i++) {
			if (usableMetric(stars[i], metric) !== undefined) count++
		}
		usedStarCountByMetric[metric] = count
	}

	let orientationCount = 0
	let selectedStarCount = 0
	let fullyRejectedStarCount = 0
	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		if (star.selected) selectedStarCount++
		if (usableOrientation(star) !== undefined) orientationCount++
		if (!star.selected || (['hfd', 'fwhm', 'eccentricity', 'elongation'] as const).every((metric) => usableMetric(star, metric) === undefined)) fullyRejectedStarCount++
	}
	usedStarCountByMetric.orientation = orientationCount

	let occupiedRegionCount = 0
	for (let i = 0; i < regions.length; i++) {
		if ((regions[i].usedStarCountByMetric.hfd ?? 0) >= minimumStarsPerRegion) occupiedRegionCount++
	}

	const warnings: AberrationWarning[] = []
	if (selectedStarCount < minimumStars) warnings.push({ code: 'insufficientStars', values: { selectedStarCount, minimumStars } })
	if (occupiedRegionCount < 2) warnings.push({ code: 'insufficientCoverage', values: { occupiedRegionCount } })
	if (orientationCount < DEFAULT_MINIMUM_ORIENTATION_STARS) warnings.push({ code: 'insufficientOrientation', values: { orientationCount, minimumOrientationStars: DEFAULT_MINIMUM_ORIENTATION_STARS } })

	const support = clamp(selectedStarCount / minimumStars, 0, 1)
	const coverage = regions.length > 0 ? occupiedRegionCount / regions.length : 0
	const confidence = support * Math.sqrt(coverage)

	return {
		detectedStarCount,
		profiledStarCount: stars.length,
		selectedStarCount,
		usedStarCountByMetric,
		fullyRejectedStarCount,
		occupiedRegionCount,
		confidence,
		warnings,
	}
}

// Converts coherent regional orientation summaries into image-pixel vector samples.
function buildVectors(regions: readonly ReturnType<typeof summarizeAberrationRegions>[number][], width: number, height: number) {
	const vectors = []

	for (let i = 0; i < regions.length; i++) {
		const region = regions[i]
		const count = region.usedStarCountByMetric.orientation ?? 0
		if (region.orientation === undefined) continue
		vectors.push({
			x: width > 1 ? (region.center.x + 0.5) * (width - 1) : 0,
			y: height > 1 ? (region.center.y + 0.5) * (height - 1) : 0,
			theta: region.orientation,
			magnitude: region.medianElongation,
			coherence: region.orientationCoherence,
			count,
		})
	}

	return vectors
}

// Computes a bounded profile aggregation weight without allowing high-SNR stars to dominate a region.
function profileWeight(profile: StarProfile): number {
	const snr = Math.max(0, profile.snr ?? 0)
	const snrWeight = clamp(Math.log1p(snr) / Math.log1p(REFERENCE_SNR), 0, 1)
	const shapeWeight = profile.eccentricity === undefined ? 0.75 : clamp(1 - 0.5 * profile.eccentricity, 0.5, 1)
	return clamp(profile.quality * snrWeight * shapeWeight, 0, 1)
}

// Returns a usable selected scalar metric or undefined when excluded.
function usableMetric(star: AberrationStar, metric: AberrationMetric): number | undefined {
	if (!star.selected || hasMetricRejection(star, metric)) return undefined
	const value = profileMetric(star.profile, metric)
	return value !== undefined && Number.isFinite(value) ? value : undefined
}

// Returns a usable selected orientation when no metric-specific rejection applies.
function usableOrientation(star: AberrationStar): number | undefined {
	if (!star.selected || hasMetricRejection(star, 'orientation')) return undefined
	const { theta, eccentricity } = star.profile
	return theta !== undefined && eccentricity !== undefined && eccentricity >= MINIMUM_ORIENTATION_ECCENTRICITY ? theta : undefined
}

// Returns a profile scalar field by metric name.
function profileMetric(profile: StarProfile, metric: AberrationMetric): number | undefined {
	return metric === 'hfd' ? profile.hfd : metric === 'fwhm' ? profile.fwhm : metric === 'eccentricity' ? profile.eccentricity : profile.elongation
}

// Tests whether a profile has a rejection for a scalar metric or orientation.
function hasMetricRejection(star: AberrationStar, metric: AberrationMeasuredQuantity): boolean {
	for (let i = 0; i < star.rejections.length; i++) {
		if (star.rejections[i].metric === metric) return true
	}

	return false
}

// Adds a profile-level selection reason only once.
function addSelectionReason(reasons: AberrationStarRejectionReason[], reason: AberrationStarRejectionReason): void {
	if (!reasons.includes(reason)) reasons.push(reason)
}

// Adds a metric-specific rejection only once.
function addMetricRejection(rejections: AberrationMetricRejection[], metric: AberrationMeasuredQuantity, reason: AberrationMetricRejectionReason): void {
	if (!rejections.some((rejection) => rejection.metric === metric)) rejections.push({ metric, reason })
}

// Applies one rejection reason to all scalar metrics and orientation without overwriting earlier detail.
function addAllMetricRejections(rejections: AberrationMetricRejection[], reason: AberrationMetricRejectionReason): void {
	for (const metric of ['hfd', 'fwhm', 'eccentricity', 'elongation', 'orientation'] as const) addMetricRejection(rejections, metric, reason)
}

// Computes a median after sorting a fresh scalar array.
function median(values: readonly number[]): number {
	const sorted = Float64Array.from(values)
	sorted.sort()
	const middle = sorted.length >>> 1
	return sorted.length % 2 === 0 ? 0.5 * (sorted[middle - 1] + sorted[middle]) : sorted[middle]
}

// Computes scaled median absolute deviation from scalar values and a known median.
function scaledMad(values: readonly number[], center: number): number {
	const deviations = new Float64Array(values.length)
	for (let i = 0; i < values.length; i++) deviations[i] = Math.abs(values[i] - center)
	deviations.sort()
	const middle = deviations.length >>> 1
	const mad = deviations.length % 2 === 0 ? 0.5 * (deviations[middle - 1] + deviations[middle]) : deviations[middle]
	return 1.4826 * mad
}

// Returns a finite scalar option or fallback.
function finiteNumber(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) ? value : fallback
}

// Returns a positive integer option or fallback.
function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}
