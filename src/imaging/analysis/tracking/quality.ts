import { tanUnproject } from '../../../astrometry/wcs/fits.wcs'
import { PI } from '../../../core/constants'
import { medianBySelectionOf, percentileBySelectionOf } from '../../../math/numerical/statistics'
import type { Image } from '../../model/types'
import { STAR_SIGNAL_RADIUS, type DetectedStar } from '../../stars/detector'
import { streakAxialAngleDistance } from '../streak/geometry'
import type { Streak } from '../streak/types'
import type { TrackingQuality, TrackingQualityContext, TrackingQualityOptions, TrackingSkyQuality } from './types'

// Measures coherent stellar elongation from already detected moments. A uniform line convolved with
// a roughly symmetric Gaussian PSF contributes L²/12 to the major variance, so the reported trail
// is sqrt(12 * max(majorVariance - minorVariance, 0)) pixels. This is a shape proxy, not a precise
// subpixel tracking displacement; undersampling, asymmetric optics and truncated apertures bias it.

// Maximum streaks considered for star contamination. The streak detector's default cap is 32;
// this bound keeps the optional overlap pass linear in the number of stars and supplied streaks.
const MAX_TRACKING_STREAKS = 32
// Gaussian FWHM divided by sigma, used to report the minor-axis cross width in pixels.
const GAUSSIAN_FWHM_FACTOR = 2 * Math.sqrt(2 * Math.LN2)
// Minimum field score and maximum axial separation for recognizing measured stellar streaks.
const STELLAR_STREAK_FIELD_SCORE = 0.6
const STELLAR_STREAK_ALIGNMENT = PI / 15
// Maximum ratio between local moment proxies, also applied to full trails within the aperture.
const STELLAR_STREAK_SCALE_RATIO = 2

// Returns whether the star's shape aperture intersects the streak's measured half-width corridor.
function overlapsStreak(star: DetectedStar, streak: Streak): boolean {
	const dx = streak.end.x - streak.start.x
	const dy = streak.end.y - streak.start.y
	const squaredLength = dx * dx + dy * dy
	const fraction = squaredLength > 0 ? Math.max(0, Math.min(1, ((star.x - streak.start.x) * dx + (star.y - streak.start.y) * dy) / squaredLength)) : 0
	const x = streak.start.x + fraction * dx - star.x
	const y = streak.start.y + fraction * dy - star.y
	const radius = STAR_SIGNAL_RADIUS + Math.max(0, streak.width * 0.5)
	return x * x + y * y <= radius * radius
}

const EMPTY_TRACKING_QUALITY_OPTIONS: Readonly<TrackingQualityOptions> = {}
const EMPTY_TRACKING_QUALITY_CONTEXT: Readonly<TrackingQualityContext> = {}

// Returns one bit per compatible star/streak pair and a per-streak membership flag. A field that
// already meets the public threshold may preserve multiple stars along a merged stellar streak;
// relaxed support restores only one. Local moments cannot bound a full detector-truncated streak.
function fieldCompatibleStreaks(image: Image, stars: readonly DetectedStar[], options: Readonly<TrackingQualityOptions>, streaks: readonly Streak[], streakCount: number): readonly [Uint32Array, Uint8Array] {
	const starMasks = new Uint32Array(stars.length)
	const members = new Uint8Array(streakCount)
	const minElongatedStars = options.minElongatedStars ?? 5
	const independentMinimum = Math.max(1, minElongatedStars - 1)
	for (let i = 0; i < streakCount; i++) {
		const streak = streaks[i]
		const independentStars: DetectedStar[] = []
		const associatedIndices: number[] = []
		for (let starIndex = 0; starIndex < stars.length; starIndex++) {
			if (overlapsStreak(stars[starIndex], streak)) associatedIndices.push(starIndex)
			else independentStars.push(stars[starIndex])
		}
		if (associatedIndices.length === 0) continue
		const fullField = independentStars.length >= minElongatedStars ? measureTrackingQualityCore(image, independentStars, options, EMPTY_TRACKING_QUALITY_CONTEXT, minElongatedStars, 2) : undefined
		const fullySupported = fullField !== undefined && fullField.score >= STELLAR_STREAK_FIELD_SCORE
		const field = fullySupported ? fullField : measureTrackingQualityCore(image, independentStars, options, EMPTY_TRACKING_QUALITY_CONTEXT, independentMinimum, 1)
		const angle = field.angle
		const trail = field.medianTrail
		if (!(field.score >= STELLAR_STREAK_FIELD_SCORE) || angle === undefined || trail === undefined || !(trail > 0)) continue
		if (streakAxialAngleDistance(streak.angle, angle) > STELLAR_STREAK_ALIGNMENT || !(streak.length >= trail / STELLAR_STREAK_SCALE_RATIO)) continue
		if (streak.length <= 2 * STAR_SIGNAL_RADIUS && !(streak.length <= trail * STELLAR_STREAK_SCALE_RATIO)) continue

		for (const starIndex of associatedIndices) {
			const star = stars[starIndex]
			const major = star.majorVariance
			const minor = star.minorVariance
			if (!(star.snr >= (options.minSNR ?? 2)) || major === undefined || minor === undefined || star.theta === undefined || !Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(star.theta) || !(major >= minor && minor > 0)) continue
			const localTrail = Math.sqrt(12 * (major - minor))
			const crossWidth = GAUSSIAN_FWHM_FACTOR * Math.sqrt(minor)
			if (localTrail < (options.minTrail ?? 0.75) || localTrail < (options.minTrailToCrossWidth ?? 0.25) * crossWidth || !(localTrail >= trail / STELLAR_STREAK_SCALE_RATIO && localTrail <= trail * STELLAR_STREAK_SCALE_RATIO)) continue
			if (streakAxialAngleDistance(star.theta, angle) > STELLAR_STREAK_ALIGNMENT) continue
			if (options.saturationLevel !== undefined) {
				const x = Math.round(star.x)
				const y = Math.round(star.y)
				if (x >= 0 && x < image.metadata.width && y >= 0 && y < image.metadata.height) {
					const offset = y * image.metadata.stride + x * image.metadata.channels
					let saturated = false
					for (let channel = 0; channel < image.metadata.channels; channel++) if (image.raw[offset + channel] >= options.saturationLevel) saturated = true
					if (saturated) continue
				}
			}
			starMasks[starIndex] |= 1 << i
			members[i] = 1
			if (!fullySupported) break
		}
	}

	return [starMasks, members]
}

// Converts the positive image-axis direction to a local east/north sky vector at the image center.
// WCS uses two nearby unprojections to retain rotation, parity, SIP distortion and RA wrap.
function skyQuality(image: Image, angle: number, trail: number, context: Readonly<TrackingQualityContext>): TrackingSkyQuality | undefined {
	const dx = Math.cos(angle)
	const dy = Math.sin(angle)

	let east: number
	let north: number

	if (context.wcs) {
		const x = (image.metadata.width - 1) * 0.5 + 1
		const y = (image.metadata.height - 1) * 0.5 + 1
		const center = tanUnproject(context.wcs, x, y)
		const end = tanUnproject(context.wcs, x + dx, y + dy)
		if (!center || !end) return undefined
		const deltaRa = end[0] - center[0]
		const cosine = Math.cos(end[1])
		const sine = Math.sin(end[1])
		const centerCosine = Math.cos(center[1])
		const centerSine = Math.sin(center[1])
		const tangentEast = cosine * Math.sin(deltaRa)
		const tangentNorth = centerCosine * sine - centerSine * cosine * Math.cos(deltaRa)
		const tangentLength = Math.hypot(tangentEast, tangentNorth)
		const separation = Math.atan2(tangentLength, centerSine * sine + centerCosine * cosine * Math.cos(deltaRa))
		if (!(tangentLength > 0) || !Number.isFinite(separation)) return undefined
		east = (separation * tangentEast) / tangentLength
		north = (separation * tangentNorth) / tangentLength
	} else if (context.pixelToSky) {
		const [eastX, eastY, northX, northY] = context.pixelToSky
		east = eastX * dx + eastY * dy
		north = northX * dx + northY * dy
	} else {
		return undefined
	}

	const pixelScale = Math.hypot(east, north)
	if (!(pixelScale > 0) || !Number.isFinite(pixelScale * trail)) return undefined

	let skyAngle = Math.atan2(north, east)
	if (skyAngle < 0) skyAngle += PI
	else if (skyAngle >= PI) skyAngle -= PI

	return { angle: skyAngle, medianTrail: trail * pixelScale, east: trail * east, north: trail * north }
}

// Measures one completed frame. Shape inputs use squared pixels and axial radians; the image is
// read only for dimensions and an optional saturation sample. Missing shape fields are skipped.
// Work is linear in stars plus streaks because the optional streak pass is capped at 32 detections.
export function measureTrackingQuality(image: Image, stars: readonly DetectedStar[], options: Readonly<TrackingQualityOptions> = EMPTY_TRACKING_QUALITY_OPTIONS, context: Readonly<TrackingQualityContext> = EMPTY_TRACKING_QUALITY_CONTEXT): TrackingQuality {
	return measureTrackingQualityCore(image, stars, options, context, options.minElongatedStars ?? 5, 2)
}

// Computes field statistics with the required significant-star count and stars per supported
// quadrant. Candidate calls permit one later-validated stellar contribution without weakening the
// final public threshold; neither the image nor its star detections are mutated.
function measureTrackingQualityCore(image: Image, stars: readonly DetectedStar[], options: Readonly<TrackingQualityOptions>, context: Readonly<TrackingQualityContext>, minElongatedStars: number, minStarsPerQuadrant: number): TrackingQuality {
	const minSNR = options.minSNR ?? 2
	const minTrail = options.minTrail ?? 0.75
	const minTrailToCrossWidth = options.minTrailToCrossWidth ?? 0.25
	const streaks = context.streaks ?? []
	const streakCount = Math.min(streaks.length, MAX_TRACKING_STREAKS)
	const [stellarStarMasks, stellarStreaks] = fieldCompatibleStreaks(image, stars, options, streaks, streakCount)
	const streakSupport = new Uint8Array(streakCount)
	const n = stars.length
	const candidateTrails = new Float64Array(n)
	const candidateAngles = new Float64Array(n)
	const candidateQuadrants = new Uint8Array(n)
	const candidateCentral = new Uint8Array(n)
	const crossWidths = new Float64Array(n)
	const halfWidth = image.metadata.width * 0.5
	const halfHeight = image.metadata.height * 0.5
	let usableStarCount = 0
	let centralUsableCount = 0
	let candidateCount = 0

	for (let starIndex = 0; starIndex < n; starIndex++) {
		const star = stars[starIndex]
		let contaminated = false
		for (let i = 0; i < streakCount; i++) {
			if (!overlapsStreak(star, streaks[i])) continue
			if (streakSupport[i] < 3) streakSupport[i]++
			if ((stellarStarMasks[starIndex] & (1 << i)) === 0) contaminated = true
		}

		if (contaminated) continue

		const major = star.majorVariance
		const minor = star.minorVariance
		const theta = star.theta
		if (!(star.snr >= minSNR) || major === undefined || minor === undefined || theta === undefined || !Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(theta) || !(major >= minor && minor > 0) || !Number.isFinite(star.x) || !Number.isFinite(star.y)) continue

		if (options.saturationLevel !== undefined) {
			const x = Math.round(star.x)
			const y = Math.round(star.y)

			if (x >= 0 && x < image.metadata.width && y >= 0 && y < image.metadata.height) {
				const offset = y * image.metadata.stride + x * image.metadata.channels

				let saturated = false
				for (let channel = 0; channel < image.metadata.channels; channel++) {
					if (image.raw[offset + channel] >= options.saturationLevel) saturated = true
				}

				if (saturated) continue
			}
		}

		const crossWidth = GAUSSIAN_FWHM_FACTOR * Math.sqrt(minor)
		const trail = Math.sqrt(12 * Math.max(0, major - minor))
		if (!Number.isFinite(crossWidth) || !Number.isFinite(trail)) continue
		crossWidths[usableStarCount++] = crossWidth
		const central = Math.abs(star.x - halfWidth) <= halfWidth * 0.5 && Math.abs(star.y - halfHeight) <= halfHeight * 0.5
		if (central) centralUsableCount++
		if (trail < minTrail || trail < minTrailToCrossWidth * crossWidth) continue
		candidateTrails[candidateCount] = trail
		candidateAngles[candidateCount] = theta
		candidateQuadrants[candidateCount] = (star.x >= halfWidth ? 1 : 0) + (star.y >= halfHeight ? 2 : 0)
		candidateCentral[candidateCount] = central ? 1 : 0
		candidateCount++
	}

	let isolatedStreakCount = 0
	for (let i = 0; i < streakCount; i++) if (!stellarStreaks[i] && streakSupport[i] < 3) isolatedStreakCount++
	const medianCrossWidth = usableStarCount > 0 ? medianBySelectionOf(crossWidths, usableStarCount) : undefined
	const rawMedian = candidateCount > 0 ? medianBySelectionOf(candidateTrails.slice(0, candidateCount)) : 0
	const deviations = new Float64Array(candidateCount)
	for (let i = 0; i < candidateCount; i++) deviations[i] = Math.abs(candidateTrails[i] - rawMedian)
	const mad = candidateCount > 0 ? medianBySelectionOf(deviations) : 0
	// A very long isolated track should not set the stellar field's trail scale.
	const trailLimit = rawMedian + Math.max(4 * mad, 0.75 * rawMedian, 1)

	let elongatedCount = 0
	let centralElongatedCount = 0
	let cosine = 0
	let sine = 0

	for (let i = 0; i < candidateCount; i++) {
		if (candidateTrails[i] > trailLimit) continue
		const doubled = 2 * candidateAngles[i]
		cosine += Math.cos(doubled)
		sine += Math.sin(doubled)
		elongatedCount++
		centralElongatedCount += candidateCentral[i]
	}

	const preliminaryCoherence = elongatedCount > 0 ? Math.hypot(cosine, sine) / elongatedCount : 0
	const preliminaryAngle = 0.5 * Math.atan2(sine, cosine)
	const rejectAngleOutliers = elongatedCount >= 6 && preliminaryCoherence >= 0.65
	const acceptedTrails = new Float64Array(elongatedCount)
	const quadrantCounts = new Uint32Array(4)

	let acceptedCount = 0
	let acceptedCosine = 0
	let acceptedSine = 0
	let maxTrail = 0

	for (let i = 0; i < candidateCount; i++) {
		const trail = candidateTrails[i]
		if (trail > trailLimit) continue
		const doubled = 2 * candidateAngles[i]
		if (rejectAngleOutliers && Math.abs(Math.atan2(Math.sin(doubled - 2 * preliminaryAngle), Math.cos(doubled - 2 * preliminaryAngle))) > PI / 3) continue
		acceptedCosine += Math.cos(doubled)
		acceptedSine += Math.sin(doubled)
		acceptedTrails[acceptedCount++] = trail
		quadrantCounts[candidateQuadrants[i]]++
		if (trail > maxTrail) maxTrail = trail
	}

	const directionCoherence = acceptedCount > 0 ? Math.min(1, Math.hypot(acceptedCosine, acceptedSine) / acceptedCount) : 0
	let angle = acceptedCount >= 2 && directionCoherence > 0.2 ? 0.5 * Math.atan2(acceptedSine, acceptedCosine) : undefined
	if (angle !== undefined && angle < 0) angle += PI
	const medianTrail = acceptedCount > 0 ? medianBySelectionOf(acceptedTrails, acceptedCount) : undefined
	const p90Trail = acceptedCount > 0 ? percentileBySelectionOf(acceptedTrails, 0.9, acceptedCount) : undefined
	let coveredQuadrants = 0
	for (const count of quadrantCounts) if (count >= minStarsPerQuadrant) coveredQuadrants++
	const quadrantCoverage = coveredQuadrants / 4
	const elongatedFraction = usableStarCount > 0 ? elongatedCount / usableStarCount : 0
	const angleDispersion = acceptedCount > 0 ? 0.5 * Math.sqrt(-2 * Math.log(Math.max(directionCoherence, Number.EPSILON))) : undefined
	const edgeUsableCount = usableStarCount - centralUsableCount
	const edgeElongatedCount = elongatedCount - centralElongatedCount
	const edgeOnlyElongation = centralUsableCount >= 3 && edgeUsableCount >= 3 && edgeElongatedCount >= minElongatedStars && centralElongatedCount / centralUsableCount < 0.5 * (edgeElongatedCount / edgeUsableCount)
	const opticalPatternSuspected = elongatedCount >= minElongatedStars && (directionCoherence < 0.45 || quadrantCoverage < 0.75 || edgeOnlyElongation)
	const coverageStrength = Math.min(1, quadrantCoverage / 0.75)
	const trailStrength = medianTrail !== undefined && medianCrossWidth !== undefined && medianCrossWidth > 0 ? Math.min(1, medianTrail / (0.75 * medianCrossWidth)) : 0
	const score = elongatedCount >= minElongatedStars ? elongatedFraction * directionCoherence * coverageStrength * trailStrength * (edgeOnlyElongation ? 0.25 : 1) : 0
	const sky = angle !== undefined && medianTrail !== undefined ? skyQuality(image, angle, medianTrail, context) : undefined

	return {
		starCount: n,
		usableStarCount,
		elongatedFraction,
		directionCoherence,
		angle,
		medianTrail,
		p90Trail,
		maxTrail: acceptedCount > 0 ? maxTrail : undefined,
		medianCrossWidth,
		score,
		sky,
		diagnostics: { quadrantCoverage, angleDispersion, rejectedStars: n - usableStarCount, opticalPatternSuspected, isolatedStreakCount },
	}
}
