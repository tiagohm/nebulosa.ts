import { type Angle, normalizeAngle } from './angle'
import { ASEC2RAD, PI, PIOVERTWO } from './constants'
import { type Size, sphericalSeparation } from './geometry'
import { clamp } from './math'
import { gnomonicProject, gnomonicUnproject } from './projection'
import type { StarCatalog, StarCatalogEntry } from './star.catalog'
import type { DetectedStar } from './star.detector'
import { type AffineTransform, applyTransformToPoint, matchStars, type SimilarityTransform, type StarMatchingConfig, type StarMatchingResult } from './star.matching'
import { medianOf } from './util'

const DEFAULT_CENTER_TOLERANCE = 1 * ASEC2RAD
const DEFAULT_MAX_CATALOG_STARS = 256
const DEFAULT_PROJECTION_PADDING_FACTOR = 1
const GEOMETRY_EPSILON = 1e-12

const DEFAULT_STAR_CROSSMATCH_CONFIG: Readonly<Required<StarMatchingConfig>> = {
	maxStars: DEFAULT_MAX_CATALOG_STARS,
	minStars: 6,
	allowMirror: true,
	initialMatchRadius: 18,
	finalMatchRadius: 3.5,
	maxScaleRatio: 64,
	minScaleRatio: 0.01,
	maxRotation: null,
	ransacIterations: 128,
	minInliers: 6,
	maxResidual: 4,
	useWeightedFit: true,
	refineIterations: 5,
	descriptorTolerance: 0.03,
	localNeighborCount: 8,
	preferCompactPatterns: true,
	modelPreference: 'similarity',
	allowAffineFallback: false,
	dedupeDistance: 2,
	minPatternSide: 4,
	minPatternAreaRatio: 0.01,
	symmetricPatternTolerance: 0.02,
	maxPatternMatchesPerPattern: 4,
	maxHypotheses: 128,
}

export type StarCrossmatchStatus = 'matched' | 'unmatched'

export interface StarCrossmatchCameraInfo extends Size {
	pixelSize?: number // µm
	focalLength?: number // mm
}

export interface StarCrossmatchOptions {
	centerRA: Angle
	centerDEC: Angle
	radius: Angle
	camera: StarCrossmatchCameraInfo
	refinementIterations?: number
	centerTolerance?: Angle
	maxCatalogStars?: number
	projectionPaddingFactor?: number
	matchingConfig?: StarMatchingConfig
}

export interface StarCrossmatchSolution {
	readonly rightAscension: Angle
	readonly declination: Angle
	readonly scale: Angle // radians per pixel
	readonly rotation: Angle
	readonly mirrored: boolean
	readonly fieldRadius: Angle
}

export interface StarCrossmatchRecord<S extends StarCatalogEntry> {
	readonly detectedStar: DetectedStar
	readonly detectedIndex: number
	readonly status: StarCrossmatchStatus
	readonly catalogStar?: S
	readonly catalogIndex?: number
	readonly residual?: number // px
	readonly skySeparation?: Angle
}

export interface StarCrossmatchSummary {
	readonly totalDetected: number
	readonly matchedCount: number
	readonly unmatchedCount: number
	readonly catalogCount: number
	readonly projectedCatalogCount: number
	readonly inlierCount: number
	readonly averageResidual?: number
	readonly medianResidual?: number
	readonly averageSkySeparation?: Angle
	readonly medianSkySeparation?: Angle
}

export interface StarCrossmatchResult<S extends StarCatalogEntry> {
	readonly success: boolean
	readonly solution?: StarCrossmatchSolution
	readonly catalogStars: readonly S[]
	readonly matches: readonly StarCrossmatchRecord<S>[]
	readonly summary: StarCrossmatchSummary
	readonly starMatch?: StarMatchingResult
	readonly failureReason?: string
}

interface ResolvedStarCrossmatchOptions {
	readonly centerRA: Angle
	readonly centerDEC: Angle
	readonly radius: Angle
	readonly camera: StarCrossmatchCameraInfo
	readonly refinementIterations: number
	readonly centerTolerance: Angle
	readonly maxCatalogStars: number
	readonly projectionPadding: number
	readonly nominalPixelsPerRadian: number
	readonly matchingConfig: Required<StarMatchingConfig>
}

interface ProjectedCatalogStar<S extends StarCatalogEntry> {
	readonly catalogStar: S
	readonly catalogIndex: number
	readonly detectedStar: DetectedStar
	readonly planeX: number
	readonly planeY: number
	readonly projectedRadius: number
}

interface MatchAttempt<S extends StarCatalogEntry> {
	readonly projectionCenterRA: Angle
	readonly projectionCenterDEC: Angle
	readonly projectedCatalogStars: readonly ProjectedCatalogStar<S>[]
	readonly starMatch: StarMatchingResult
	readonly transform: SimilarityTransform | AffineTransform
	readonly imageCenterX: number
	readonly imageCenterY: number
	readonly nominalPixelsPerRadian: number
	readonly solution: StarCrossmatchSolution
}

interface MatchAttemptResolution<S extends StarCatalogEntry> {
	readonly projectedCatalogCount: number
	readonly attempt?: MatchAttempt<S>
}

// Matches detected image stars against a queried catalog region and returns an approximate image-center RA/Dec.
export async function crossMatchStars<S extends StarCatalogEntry>(detectedStars: readonly DetectedStar[], catalog: StarCatalog<S>, options: StarCrossmatchOptions): Promise<StarCrossmatchResult<S>> {
	const resolved = resolveStarCrossmatchOptions(options)

	if (detectedStars.length === 0) {
		return failureStarCrossmatchResult(detectedStars, [], 0, 'no detected stars')
	}

	const catalogStars = await catalog.queryCone(resolved.centerRA, resolved.centerDEC, resolved.radius)

	if (catalogStars.length === 0) {
		return failureStarCrossmatchResult(detectedStars, catalogStars, 0, 'no catalog stars in query region')
	}

	let centerRA = resolved.centerRA
	let centerDEC = resolved.centerDEC
	let bestAttempt: MatchAttempt<S> | undefined
	let lastProjectedCatalogCount = 0

	for (let iteration = 0; iteration <= resolved.refinementIterations; iteration++) {
		const resolution = solveProjectedCatalogMatch(detectedStars, catalogStars, centerRA, centerDEC, resolved)
		const attempt = resolution.attempt
		lastProjectedCatalogCount = resolution.projectedCatalogCount
		if (attempt === undefined) break
		if (bestAttempt === undefined || isBetterMatchAttempt(attempt, bestAttempt)) bestAttempt = attempt

		const centerOffset = sphericalSeparation(centerRA, centerDEC, attempt.solution.rightAscension, attempt.solution.declination)
		centerRA = attempt.solution.rightAscension
		centerDEC = attempt.solution.declination
		if (centerOffset <= resolved.centerTolerance) break
	}

	if (bestAttempt === undefined) {
		return failureStarCrossmatchResult(detectedStars, catalogStars, lastProjectedCatalogCount, 'no geometric catalog match found')
	}

	const matches = materializeStarCrossmatchRecords(detectedStars, bestAttempt)

	return {
		success: true,
		solution: bestAttempt.solution,
		catalogStars,
		matches,
		summary: summarizeStarCrossmatch(catalogStars.length, bestAttempt.projectedCatalogStars.length, bestAttempt.starMatch.inlierCount, matches),
		starMatch: bestAttempt.starMatch,
	}
}

// Validates inputs and resolves defaults for the image-based crossmatcher.
function resolveStarCrossmatchOptions(options: StarCrossmatchOptions): ResolvedStarCrossmatchOptions {
	const centerRA = normalizeCoordinateRightAscension(options.centerRA)
	const centerDEC = validateDeclination(options.centerDEC)
	const radius = validateQueryRadius(options.radius)
	const camera = validateCameraInfo(options.camera)
	const maxCatalogStars = Math.max(6, Math.trunc(options.maxCatalogStars ?? DEFAULT_MAX_CATALOG_STARS))
	const matchingConfig = resolveStarMatchingConfig(options.matchingConfig, maxCatalogStars)

	return {
		centerRA,
		centerDEC,
		radius,
		camera,
		refinementIterations: Math.max(0, Math.trunc(options.refinementIterations ?? 2)),
		centerTolerance: options.centerTolerance === undefined ? DEFAULT_CENTER_TOLERANCE : validatePositiveAngle(options.centerTolerance, 'center tolerance'),
		maxCatalogStars,
		projectionPadding: Math.max(camera.width, camera.height) * Math.max(0, options.projectionPaddingFactor ?? DEFAULT_PROJECTION_PADDING_FACTOR),
		nominalPixelsPerRadian: nominalPixelsPerRadian(camera, radius),
		matchingConfig,
	}
}

// Merges the geometric matcher defaults with caller overrides.
function resolveStarMatchingConfig(config: StarMatchingConfig | undefined, maxCatalogStars: number): Required<StarMatchingConfig> {
	return {
		...DEFAULT_STAR_CROSSMATCH_CONFIG,
		...config,
		maxStars: Math.max(6, Math.trunc(config?.maxStars ?? maxCatalogStars)),
		minStars: Math.max(3, Math.trunc(config?.minStars ?? DEFAULT_STAR_CROSSMATCH_CONFIG.minStars)),
		localNeighborCount: Math.max(3, Math.trunc(config?.localNeighborCount ?? DEFAULT_STAR_CROSSMATCH_CONFIG.localNeighborCount)),
		ransacIterations: Math.max(8, Math.trunc(config?.ransacIterations ?? DEFAULT_STAR_CROSSMATCH_CONFIG.ransacIterations)),
		minInliers: Math.max(3, Math.trunc(config?.minInliers ?? DEFAULT_STAR_CROSSMATCH_CONFIG.minInliers)),
		refineIterations: Math.max(1, Math.trunc(config?.refineIterations ?? DEFAULT_STAR_CROSSMATCH_CONFIG.refineIterations)),
		maxPatternMatchesPerPattern: Math.max(1, Math.trunc(config?.maxPatternMatchesPerPattern ?? DEFAULT_STAR_CROSSMATCH_CONFIG.maxPatternMatchesPerPattern)),
		maxHypotheses: Math.max(8, Math.trunc(config?.maxHypotheses ?? DEFAULT_STAR_CROSSMATCH_CONFIG.maxHypotheses)),
	}
}

// Solves one geometric match attempt around the given projection center.
function solveProjectedCatalogMatch<S extends StarCatalogEntry>(detectedStars: readonly DetectedStar[], catalogStars: readonly S[], projectionCenterRA: Angle, projectionCenterDEC: Angle, options: ResolvedStarCrossmatchOptions): MatchAttemptResolution<S> {
	const projectedCatalogStars = projectCatalogStars(catalogStars, projectionCenterRA, projectionCenterDEC, options)
	if (projectedCatalogStars.length < options.matchingConfig.minStars) return { projectedCatalogCount: projectedCatalogStars.length }

	const referenceStars = new Array<DetectedStar>(projectedCatalogStars.length)
	for (let index = 0; index < projectedCatalogStars.length; index++) referenceStars[index] = projectedCatalogStars[index].detectedStar
	const starMatch = matchStars(referenceStars, detectedStars, options.matchingConfig)
	if (!starMatch.success) return { projectedCatalogCount: projectedCatalogStars.length }

	const transform = starMatchingTransform(starMatch)
	if (transform === undefined) return { projectedCatalogCount: projectedCatalogStars.length }

	return {
		projectedCatalogCount: projectedCatalogStars.length,
		attempt: {
			projectionCenterRA,
			projectionCenterDEC,
			projectedCatalogStars,
			starMatch,
			transform,
			imageCenterX: options.camera.width * 0.5,
			imageCenterY: options.camera.height * 0.5,
			nominalPixelsPerRadian: options.nominalPixelsPerRadian,
			solution: buildStarCrossmatchSolution(transform, projectionCenterRA, projectionCenterDEC, options),
		},
	}
}

// Projects query-region catalog stars into an image-like tangent plane around the current center estimate.
function projectCatalogStars<S extends StarCatalogEntry>(catalogStars: readonly S[], projectionCenterRA: Angle, projectionCenterDEC: Angle, options: ResolvedStarCrossmatchOptions): ProjectedCatalogStar<S>[] {
	const imageCenterX = options.camera.width * 0.5
	const imageCenterY = options.camera.height * 0.5
	const projectedCatalogStars: ProjectedCatalogStar<S>[] = []

	for (let catalogIndex = 0; catalogIndex < catalogStars.length; catalogIndex++) {
		const catalogStar = catalogStars[catalogIndex]
		const projected = gnomonicProject(catalogStar.rightAscension, catalogStar.declination, projectionCenterRA, projectionCenterDEC)
		if (projected === false) continue

		const x = imageCenterX + projected.x * options.nominalPixelsPerRadian
		const y = imageCenterY - projected.y * options.nominalPixelsPerRadian
		if (x < -options.projectionPadding || x > options.camera.width + options.projectionPadding || y < -options.projectionPadding || y > options.camera.height + options.projectionPadding) continue

		projectedCatalogStars.push({
			catalogStar,
			catalogIndex,
			detectedStar: syntheticCatalogPatternStar(x, y, catalogStar.magnitude),
			planeX: projected.x,
			planeY: projected.y,
			projectedRadius: Math.hypot(projected.x, projected.y),
		})
	}

	projectedCatalogStars.sort(ProjectedCatalogStarComparator)
	if (projectedCatalogStars.length > options.maxCatalogStars) projectedCatalogStars.length = options.maxCatalogStars
	return projectedCatalogStars
}

// Synthesizes positive photometry so the triangle matcher can rank catalog stars deterministically.
function syntheticCatalogPatternStar(x: number, y: number, magnitude?: number): DetectedStar {
	const brightness = magnitude === undefined ? 1 : Math.max(1, 16 - magnitude)
	return { x, y, flux: brightness * brightness, snr: brightness, hfd: 1.5 }
}

// Sorts projected catalog stars by brightness when available, then by projected radius.
function ProjectedCatalogStarComparator<S extends StarCatalogEntry>(left: ProjectedCatalogStar<S>, right: ProjectedCatalogStar<S>) {
	if (left.catalogStar.magnitude !== right.catalogStar.magnitude) return compareOptionalAscending(left.catalogStar.magnitude, right.catalogStar.magnitude)
	if (left.projectedRadius !== right.projectedRadius) return left.projectedRadius - right.projectedRadius
	return left.catalogStar.id.localeCompare(right.catalogStar.id)
}

// Builds the approximate sky solution from the fitted image-to-tangent transform.
function buildStarCrossmatchSolution(transform: SimilarityTransform | AffineTransform, projectionCenterRA: Angle, projectionCenterDEC: Angle, options: ResolvedStarCrossmatchOptions): StarCrossmatchSolution {
	const imageCenter = { x: options.camera.width * 0.5, y: options.camera.height * 0.5 }
	const projectedCenter = applyTransformToPoint(imageCenter.x, imageCenter.y, transform)
	const planeX = (projectedCenter.x - imageCenter.x) / options.nominalPixelsPerRadian
	const planeY = -(projectedCenter.y - imageCenter.y) / options.nominalPixelsPerRadian
	const skyCenter = gnomonicUnproject(planeX, planeY, projectionCenterRA, projectionCenterDEC)

	if (skyCenter === false) {
		throw new Error('failed to unproject the fitted image center')
	}

	const scale = transformAngularScale(transform, options.nominalPixelsPerRadian)
	const fieldRadius = 0.5 * Math.hypot(options.camera.width, options.camera.height) * scale

	return {
		rightAscension: skyCenter[0],
		declination: skyCenter[1],
		scale,
		rotation: transformRotation(transform),
		mirrored: transformMirrored(transform),
		fieldRadius,
	}
}

// Materializes per-detection associations from the best geometric solution.
function materializeStarCrossmatchRecords<S extends StarCatalogEntry>(detectedStars: readonly DetectedStar[], attempt: MatchAttempt<S>): StarCrossmatchRecord<S>[] {
	const records = new Array<StarCrossmatchRecord<S>>(detectedStars.length)

	for (let detectedIndex = 0; detectedIndex < detectedStars.length; detectedIndex++) {
		records[detectedIndex] = { detectedStar: detectedStars[detectedIndex], detectedIndex, status: 'unmatched' }
	}

	for (let matchIndex = 0; matchIndex < attempt.starMatch.matches.length; matchIndex++) {
		const match = attempt.starMatch.matches[matchIndex]
		const projectedCatalogStar = attempt.projectedCatalogStars[match.referenceIndex]
		if (projectedCatalogStar === undefined) continue

		const skyPosition = approximateDetectedSkyPosition(detectedStars[match.currentIndex], attempt)
		const skySeparation = skyPosition === undefined ? undefined : sphericalSeparation(skyPosition[0], skyPosition[1], projectedCatalogStar.catalogStar.rightAscension, projectedCatalogStar.catalogStar.declination)

		records[match.currentIndex] = {
			detectedStar: detectedStars[match.currentIndex],
			detectedIndex: match.currentIndex,
			status: 'matched',
			catalogStar: projectedCatalogStar.catalogStar,
			catalogIndex: projectedCatalogStar.catalogIndex,
			residual: match.residual,
			skySeparation,
		}
	}

	return records
}

// Converts one detected image star into an approximate sky coordinate from the solved transform.
function approximateDetectedSkyPosition<S extends StarCatalogEntry>(detectedStar: DetectedStar, attempt: MatchAttempt<S>) {
	const projected = applyTransformToPoint(detectedStar.x, detectedStar.y, attempt.transform)
	const planeX = (projected.x - attempt.imageCenterX) / attempt.nominalPixelsPerRadian
	const planeY = -(projected.y - attempt.imageCenterY) / attempt.nominalPixelsPerRadian
	const skyPosition = gnomonicUnproject(planeX, planeY, attempt.projectionCenterRA, attempt.projectionCenterDEC)
	return skyPosition === false ? undefined : skyPosition
}

// Builds failure payloads while keeping per-detection status explicit.
function failureStarCrossmatchResult<S extends StarCatalogEntry>(detectedStars: readonly DetectedStar[], catalogStars: readonly S[], projectedCatalogCount: number, failureReason: string): StarCrossmatchResult<S> {
	const matches = new Array<StarCrossmatchRecord<S>>(detectedStars.length)

	for (let detectedIndex = 0; detectedIndex < detectedStars.length; detectedIndex++) {
		matches[detectedIndex] = { detectedStar: detectedStars[detectedIndex], detectedIndex, status: 'unmatched' }
	}

	return {
		success: false,
		catalogStars,
		matches,
		summary: summarizeStarCrossmatch(catalogStars.length, projectedCatalogCount, 0, matches),
		failureReason,
	}
}

// Summarizes residual and sky-separation statistics for matched detections.
function summarizeStarCrossmatch<S extends StarCatalogEntry>(catalogCount: number, projectedCatalogCount: number, inlierCount: number, matches: readonly StarCrossmatchRecord<S>[]): StarCrossmatchSummary {
	let matchedCount = 0
	let residualSum = 0
	let skySeparationSum = 0
	const residuals = new Float64Array(matches.length)
	const skySeparations = new Float64Array(matches.length)
	let skySeparationCount = 0

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]
		if (match.status !== 'matched' || match.residual === undefined) continue
		residuals[matchedCount] = match.residual
		residualSum += match.residual

		if (match.skySeparation !== undefined) {
			skySeparations[skySeparationCount] = match.skySeparation
			skySeparationSum += match.skySeparation
			skySeparationCount++
		}

		matchedCount++
	}

	const matchedResiduals = residuals.subarray(0, matchedCount).sort()
	const matchedSkySeparations = skySeparations.subarray(0, skySeparationCount).sort()

	return {
		totalDetected: matches.length,
		matchedCount,
		unmatchedCount: matches.length - matchedCount,
		catalogCount,
		projectedCatalogCount,
		inlierCount,
		averageResidual: matchedCount === 0 ? undefined : residualSum / matchedCount,
		medianResidual: matchedCount === 0 ? undefined : medianOf(matchedResiduals),
		averageSkySeparation: skySeparationCount === 0 ? undefined : skySeparationSum / skySeparationCount,
		medianSkySeparation: skySeparationCount === 0 ? undefined : medianOf(matchedSkySeparations),
	}
}

// Chooses the strongest successful iterative attempt.
function isBetterMatchAttempt<S extends StarCatalogEntry>(left: MatchAttempt<S>, right: MatchAttempt<S>) {
	if (left.starMatch.score !== right.starMatch.score) return left.starMatch.score > right.starMatch.score
	if (left.starMatch.inlierCount !== right.starMatch.inlierCount) return left.starMatch.inlierCount > right.starMatch.inlierCount
	return (left.starMatch.rmsError ?? Number.POSITIVE_INFINITY) < (right.starMatch.rmsError ?? Number.POSITIVE_INFINITY)
}

// Extracts the fitted image-to-reference transform from a successful star match.
function starMatchingTransform(result: StarMatchingResult) {
	if (!result.success) return undefined
	if (result.model === 'similarity' && result.similarity !== undefined) return result.similarity
	if (result.model === 'affine' && result.affine !== undefined) return result.affine
	return undefined
}

// Returns the angular scale represented by one image pixel.
function transformAngularScale(transform: SimilarityTransform | AffineTransform, nominalPixelsPerRadian: number) {
	return nominalPixelsPerRadian <= 0 ? 0 : transformScale(transform) / nominalPixelsPerRadian
}

// Returns the linear scale of the fitted transform in projected pixels per image pixel.
function transformScale(transform: SimilarityTransform | AffineTransform) {
	if ('mirrored' in transform) return Math.hypot(transform.a, transform.b)
	const determinant = transform.m00 * transform.m11 - transform.m01 * transform.m10
	return Math.sqrt(Math.abs(determinant))
}

// Returns the approximate image rotation carried by the fitted transform.
function transformRotation(transform: SimilarityTransform | AffineTransform) {
	return 'mirrored' in transform ? Math.atan2(transform.b, transform.a) : Math.atan2(transform.m10, transform.m00)
}

// Returns whether the fitted transform includes a parity flip.
function transformMirrored(transform: SimilarityTransform | AffineTransform) {
	return 'mirrored' in transform ? transform.mirrored : transform.m00 * transform.m11 - transform.m01 * transform.m10 < 0
}

// Computes a nominal tangent-plane scale from optics when available or from the query footprint otherwise.
function nominalPixelsPerRadian(camera: StarCrossmatchCameraInfo, queryRadius: Angle) {
	if (camera.pixelSize !== undefined && camera.focalLength !== undefined) {
		const pixelSize = validatePositiveScalar(camera.pixelSize, 'pixel size')
		const focalLength = validatePositiveScalar(camera.focalLength, 'focal length')
		return (focalLength * 1000) / pixelSize
	}

	return Math.max(1, Math.min(camera.width, camera.height) / (2 * Math.max(queryRadius, GEOMETRY_EPSILON)))
}

// Validates the camera geometry needed to convert the solved transform into a center coordinate.
function validateCameraInfo(camera: StarCrossmatchCameraInfo): StarCrossmatchCameraInfo {
	const width = validatePositiveScalar(camera.width, 'camera width')
	const height = validatePositiveScalar(camera.height, 'camera height')
	if (camera.pixelSize !== undefined) validatePositiveScalar(camera.pixelSize, 'pixel size')
	if (camera.focalLength !== undefined) validatePositiveScalar(camera.focalLength, 'focal length')
	return { ...camera, width, height }
}

// Validates the query radius used for the catalog retrieval and tangent-plane approximation.
function validateQueryRadius(queryRadius: Angle) {
	if (!Number.isFinite(queryRadius) || queryRadius <= 0 || queryRadius >= PIOVERTWO) {
		throw new Error(`invalid query radius: ${queryRadius}`)
	}

	return queryRadius
}

// Validates a positive angular input in radians.
function validatePositiveAngle(value: Angle, label: string) {
	if (!Number.isFinite(value) || value <= 0 || value > PI) {
		throw new Error(`invalid ${label}: ${value}`)
	}

	return value
}

// Validates a positive scalar input.
function validatePositiveScalar(value: number, label: string) {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`invalid ${label}: ${value}`)
	}

	return value
}

// Normalizes required right ascension input or throws on invalid values.
function normalizeCoordinateRightAscension(value: Angle) {
	if (!Number.isFinite(value)) {
		throw new Error(`invalid right ascension: ${value}`)
	}

	return normalizeAngle(value)
}

// Validates a declination value in radians.
function validateDeclination(declination: Angle) {
	if (!Number.isFinite(declination) || declination < -PIOVERTWO - GEOMETRY_EPSILON || declination > PIOVERTWO + GEOMETRY_EPSILON) {
		throw new Error(`invalid declination: ${declination}`)
	}

	return clamp(declination, -PIOVERTWO, PIOVERTWO)
}

// Orders optional numeric values with undefined consistently placed last.
function compareOptionalAscending(left: number | undefined, right: number | undefined) {
	if (left === right) return 0
	if (left === undefined) return 1
	if (right === undefined) return -1
	return left - right
}
