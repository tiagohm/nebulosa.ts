import { associateMeteorTrack } from '../../../astronomy/meteors/trajectory'
import type { MeteorTrack } from '../../../astronomy/meteors/types'
import { DAYSEC, PIOVERTWO } from '../../../core/constants'
import type { NumberArray } from '../../../math/numerical/math'
import { meanOf, medianBySelectionOf, standardDeviationOf } from '../../../math/numerical/statistics'
import { deg } from '../../../math/units/angle'
import type { Image } from '../../model/types'
import { type CelestialStreakTrack, celestialStreakTrack, matchPredictedStreakTrack, type PredictedTrackWindow } from './celestial'
import { falling, rising, type PredictedStreakTrack, type StreakClassificationContext, type StreakClassificationEvidence, type StreakClassificationStar, type StreakEvidenceContribution, type StreakEvidenceProvider, type StreakEvidenceTier } from './classification.types'
import { normalizeStreakAngle, streakAxialAngleDistance, streakLineDistance, streakLineVectors, streakSegmentProjectionRelation } from './geometry'
import type { Streak } from './types'

// Built-in streak evidence. Each vote is an uncalibrated weight: primary votes can name a class,
// while morphology and intensity only raise alternatives. Thresholds are diagnostic gates, not
// physical probabilities. The built-in providers are stateless classes; `evaluate` does not mutate them.

// Primary weight of one saturated geometric, field, or artifact identification.
const PRIMARY_WEIGHT = 0.8
// Secondary weight of a long, narrow, continuous trail. Kept below the default primary gate.
const SATELLITE_MORPHOLOGY_WEIGHT = 0.35
// Secondary weight of a short trail whose width matches the stellar PSF.
const MOVING_MORPHOLOGY_WEIGHT = 0.4
// Secondary weight of a broad or poorly linear trail. It cannot name an aircraft.
const AIRPLANE_MORPHOLOGY_WEIGHT = 0.2
// Secondary weight of a smooth centerline. Morphology plus smoothness still stays unnamed.
const SMOOTH_WEIGHT = 0.15
// Secondary weight of repeated bright knots. A dashed trail is not labeled an aircraft.
const PERIODIC_WEIGHT = 0.55
// Secondary weight of a tapered or flared centerline.
const METEOR_INTENSITY_WEIGHT = 0.55
// Secondary weight of one bright-star alignment. A single spike stays ambiguous.
const OPTICAL_ALIGNMENT_WEIGHT = 0.45
// Minimum SNR of a star that can anchor an optical-artifact vote.
const BRIGHT_STAR_SNR = 25
// Minimum SNR of a star used for field coherence or a PSF-width estimate.
const FIELD_STAR_SNR = 8
// Elongation at which a star joins the coherent-trail sample.
const ELONGATED_STAR = 1.25
// Minimum usable and oriented stars before a star field can vote for tracking failure.
const MIN_FIELD_STARS = 12
// Minimum usable stars in a tracking snapshot before it can name a tracking failure.
const MIN_TRACKING_STARS = 8
// Minimum stars before their FWHM/HFD values define a PSF width.
const MIN_PSF_STARS = 5
// Largest axial separation, in radians, between a streak and a coherent field angle.
const TRACK_ALIGNMENT = deg(12)
// |log(length / medianTrail)| that still counts as the same trail scale.
const TRAIL_SCALE_AGREE = Math.log(2)
// |log(length / medianTrail)| at which the streak is no longer the stellar trail population.
const TRAIL_SCALE_REJECT = Math.log(6)
// Minimum axial separation, in radians, between two spikes of one optical family.
const SPIKE_SEPARATION = deg(20)
// Cross-track residual, in radians, accepted for a radiant association before the score ramps to zero.
const RADIANT_GATE = deg(2)
// Axial tolerance, in radians, for two streaks that occupy the same sensor locus.
const SENSOR_ANGLE = deg(4)
// Extra perpendicular tolerance, in pixels, for a repeated sensor line.
const SENSOR_LOCUS_PIXELS = 1.5
// Along-track sample spacing used for the intensity profile, in pixels.
const SAMPLE_SPACING = 2
// Peak floor, in normalized image units, below which an intensity profile is not interpreted.
const PROFILE_PEAK_FLOOR = 0.02

// Votes from length, width, linearity, coverage, and residual. None of these name a class alone.
export class MorphologyStreakEvidence implements StreakEvidenceProvider {
	// Stable provider name.
	readonly id = 'morphology'

	// Returns secondary votes for a long linear trail, a short PSF-like trail, and a broad or bent trail.
	evaluate(streak: Streak, context: Readonly<StreakClassificationContext>): readonly StreakEvidenceContribution[] {
		const votes: StreakEvidenceContribution[] = []
		const satellite = satelliteMorphology(streak)
		if (satellite > 0) votes.push(vote('satellite', satellite, SATELLITE_MORPHOLOGY_WEIGHT, 'secondary', evidenceItem('morphologyLinear', satellite, 'long, narrow, continuous trail')))
		const moving = movingMorphology(streak, medianStellarWidth(context.stars))
		if (moving > 0) votes.push(vote('movingObject', moving, MOVING_MORPHOLOGY_WEIGHT, 'secondary', evidenceItem('morphologyPsf', moving, 'short trail compatible with the stellar PSF')))
		const airplane = airplaneMorphology(streak)
		if (airplane > 0) votes.push(vote('airplane', airplane, AIRPLANE_MORPHOLOGY_WEIGHT, 'secondary', evidenceItem('morphologyBroad', airplane, 'broad or poorly linear trail')))
		return votes
	}
}

// Votes from the centerline profile. A periodic or tapered profile stays secondary without external identification.
export class IntensityStreakEvidence implements StreakEvidenceProvider {
	// Stable provider name.
	readonly id = 'intensity'

	// Returns secondary votes for a smooth, periodic, tapered, or flared centerline.
	evaluate(streak: Streak, context: Readonly<StreakClassificationContext>): readonly StreakEvidenceContribution[] {
		const profile = centerlineProfile(context.image, streak)
		if (profile === undefined) return []
		const votes: StreakEvidenceContribution[] = []
		const periodic = periodicity(profile)
		const smooth = (1 - rising(variation(profile), 0.15, 0.55)) * (1 - periodic)
		const tapered = taperScore(profile)
		const flared = flareScore(profile)
		if (smooth > 0) votes.push(vote('satellite', smooth, SMOOTH_WEIGHT, 'secondary', evidenceItem('intensitySmooth', smooth, 'slowly varying centerline')))
		if (periodic > 0) votes.push(vote('airplane', periodic, PERIODIC_WEIGHT, 'secondary', evidenceItem('intensityPeriodic', periodic, 'repeated bright knots along the trail')))
		if (tapered > 0) votes.push(vote('meteor', tapered, METEOR_INTENSITY_WEIGHT, 'secondary', evidenceItem('intensityTapered', tapered, 'brightness changes monotonically along the trail')))
		if (flared > 0) votes.push(vote('meteor', flared, METEOR_INTENSITY_WEIGHT, 'secondary', evidenceItem('intensityFlared', flared, 'localized flare above both ends of the trail')))
		return votes
	}
}

// Votes from caller-supplied satellite and moving-object tracks. A strong match is primary evidence.
export class TrajectoryStreakEvidence implements StreakEvidenceProvider {
	// Stable provider name.
	readonly id = 'trajectory'

	// Returns a primary vote for the best satellite track and the best moving-object track.
	evaluate(streak: Streak, context: Readonly<StreakClassificationContext>): readonly StreakEvidenceContribution[] {
		const observed = context.wcs === undefined ? undefined : celestialStreakTrack(streak, context.wcs)
		if (observed === undefined) return []
		const exposure = exposureWindow(context)
		const votes: StreakEvidenceContribution[] = []
		const satellite = bestTrack(observed, context.satelliteTracks, exposure)
		const moving = bestTrack(observed, context.movingObjectTracks, exposure)
		if (satellite !== undefined) votes.push(trackVote('satellite', satellite))
		if (moving !== undefined) votes.push(trackVote('movingObject', moving))
		return votes
	}
}

// Votes from shower-radiant geometry. A single frame has no motion arrow, so only the great-circle residual is primary. A miss is recorded and does not cancel a tapered sporadic.
export class MeteorRadiantStreakEvidence implements StreakEvidenceProvider {
	// Stable provider name.
	readonly id = 'meteorRadiant'

	// Returns a primary meteor vote for the best great-circle match, or incompatible evidence when none match.
	evaluate(streak: Streak, context: Readonly<StreakClassificationContext>): readonly StreakEvidenceContribution[] {
		const radiants = context.meteorRadiants
		if (context.wcs === undefined || radiants === undefined || radiants.length === 0) return []
		const observed = celestialStreakTrack(streak, context.wcs)
		if (observed === undefined) return []
		const track: MeteorTrack = { start: { rightAscension: observed.start[0], declination: observed.start[1] }, end: { rightAscension: observed.end[0], declination: observed.end[1] } }
		let best: RadiantMatch | undefined
		let nearest: RadiantMatch | undefined

		for (let index = 0; index < radiants.length; index++) {
			const radiant = radiants[index]
			const association = associateMeteorTrack(radiant, track, { maximumCrossTrackError: RADIANT_GATE, requireDirectionCompatibility: false })
			const geometry = falling(association.crossTrackError, deg(0.2), RADIANT_GATE)
			const match = { geometry, id: radiant.id, compatible: association.compatible }
			if (match.compatible && (best === undefined || match.geometry > best.geometry)) best = match
			if (nearest === undefined || match.geometry > nearest.geometry) nearest = match
		}

		if (best !== undefined) return [vote('meteor', best.geometry, PRIMARY_WEIGHT, 'primary', evidenceItem('meteorRadiant', best.geometry, 'trail lies on the radiant great circle', best.id))]
		if (nearest === undefined) return []
		return [vote('meteor', 0, 0, 'secondary', evidenceItem('meteorRadiantIncompatible', nearest.geometry, 'no supplied radiant lies on the trail great circle', nearest.id))]
	}
}

// Votes for field-wide tracking. A snapshot is authoritative. Otherwise only elongated stars count toward
// coverage, and a primary vote also requires their measured trail length to match this streak.
export class FieldCoherenceStreakEvidence implements StreakEvidenceProvider {
	// Stable provider name.
	readonly id = 'fieldCoherence'

	// Returns a primary tracking-failure vote only when this streak shares the field axis and trail scale.
	// Star trails without a measured length stay secondary and cannot name the class.
	evaluate(streak: Streak, context: Readonly<StreakClassificationContext>): readonly StreakEvidenceContribution[] {
		if (context.tracking !== undefined) {
			const tracked = trackingSnapshotScore(streak, context)
			if (tracked === undefined) return []
			let description = 'field-wide stellar elongation shares this streak axis and scale'
			if (tracked.tier !== 'primary') description = context.tracking.angle === undefined ? 'field is coherently elongated, but the snapshot has no axis for this streak' : 'field is coherently elongated, but the snapshot has no trail scale for this streak'
			return [vote('trackingFailure', tracked.score, PRIMARY_WEIGHT, tracked.tier, evidenceItem('trackingField', tracked.score, description))]
		}
		const field = starFieldScore(streak, context)
		if (field === undefined) return []
		const description = field.tier === 'primary' ? 'elongated stars share this streak axis and scale across the frame' : 'elongated stars are coherently oriented across the frame, but they have no measured trail length'
		return [vote('trackingFailure', field.score, PRIMARY_WEIGHT, field.tier, evidenceItem('stellarField', field.score, description))]
	}
}

// Votes for diffraction spikes and other star-anchored linear artifacts. One alignment is secondary; a second axis through the same star is primary.
export class OpticalStreakEvidence implements StreakEvidenceProvider {
	// Stable provider name.
	readonly id = 'optical'

	// Returns a secondary alignment vote and, when peers share the star on another axis, a primary family vote.
	evaluate(streak: Streak, context: Readonly<StreakClassificationContext>, peers: readonly Streak[]): readonly StreakEvidenceContribution[] {
		const stars = context.stars
		if (stars === undefined || stars.length === 0) return []
		const aligned = alignedStarIndexes(streak, stars)
		if (aligned.length === 0) return []
		const votes = [vote('opticalArtifact', 1, OPTICAL_ALIGNMENT_WEIGHT, 'secondary', evidenceItem('opticalAlignment', 1, 'trail axis passes through a bright star'))]
		if (sharesStarWithAnotherAxis(streak, peers, stars, aligned)) votes.push(vote('opticalArtifact', 1, PRIMARY_WEIGHT, 'primary', evidenceItem('opticalSpikeFamily', 1, 'two or more axes intersect at the same bright star')))
		return votes
	}
}

// Votes for a full-span axis-aligned defect and for a locus repeated in an earlier frame.
export class SensorStreakEvidence implements StreakEvidenceProvider {
	// Stable provider name.
	readonly id = 'sensor'

	// Returns primary votes for a thin full-span row or column and for a locus repeated in `priorFrames`.
	evaluate(streak: Streak, context: Readonly<StreakClassificationContext>): readonly StreakEvidenceContribution[] {
		const votes: StreakEvidenceContribution[] = []
		const line = sensorLineScore(streak, context)
		if (line > 0) votes.push(vote('sensorArtifact', line, PRIMARY_WEIGHT, 'primary', evidenceItem('sensorLine', line, 'thin axis-aligned line spanning the frame')))
		const persistence = persistenceScore(streak, context)
		if (persistence > 0) votes.push(vote('sensorArtifact', persistence, PRIMARY_WEIGHT, 'primary', evidenceItem('sensorPersistence', persistence, 'the same sensor locus repeats in an earlier frame')))
		return votes
	}
}

// Morphology, intensity, caller-supplied geometry, field coherence, and artifact providers, in evaluation order.
export const defaultStreakEvidenceProviders: readonly StreakEvidenceProvider[] = [new MorphologyStreakEvidence(), new IntensityStreakEvidence(), new TrajectoryStreakEvidence(), new MeteorRadiantStreakEvidence(), new FieldCoherenceStreakEvidence(), new OpticalStreakEvidence(), new SensorStreakEvidence()]

// Saturated score for a long, narrow, straight, well-covered trail. Any weak factor zeroes the vote.
function satelliteMorphology(streak: Streak): number {
	return Math.min(rising(streak.length, 50, 120), falling(streak.width, 2.5, 10), rising(streak.linearity, 0.9, 0.98), rising(streak.coverage, 0.75, 0.95), falling(streak.rmsResidual, 0.6, 2.5))
}

// Score for a short high-SNR trail near the stellar width. Without stars, only a narrow trail scores.
function movingMorphology(streak: Streak, stellarWidth: number | undefined): number {
	const short = Math.min(rising(streak.length, 8, 14), falling(streak.length, 36, 70))
	const linear = rising(streak.linearity, 0.9, 0.98)
	const signal = streak.snr === undefined ? 0.6 : rising(streak.snr, 6, 15)
	return short * psfWidthScore(streak.width, stellarWidth) * linear * signal
}

// Score for a wide or bent trail. A thin linear satellite does not receive it.
function airplaneMorphology(streak: Streak): number {
	const long = rising(streak.length, 40, 100)
	const broad = rising(streak.width, 8, 16) * long * falling(streak.linearity, 0.85, 0.98)
	const bent = rising(streak.length, 20, 60) * falling(streak.linearity, 0.7, 0.92)
	return Math.max(broad, bent * 0.7)
}

// How closely `width` matches the stellar FWHM or HFD. A missing sample only accepts a narrow trail.
function psfWidthScore(width: number, stellarWidth: number | undefined): number {
	if (stellarWidth === undefined) return falling(width, 2, 8)
	if (!(stellarWidth > 0) || !(width > 0)) return 0
	return falling(Math.abs(Math.log(width / stellarWidth)), Math.log(1.5), Math.log(3))
}

// Median FWHM, or HFD when FWHM is absent, of the brighter stars.
function medianStellarWidth(stars: readonly StreakClassificationStar[] | undefined): number | undefined {
	if (stars === undefined) return undefined

	const widths: number[] = []
	for (let index = 0; index < stars.length; index++) {
		const star = stars[index]
		if (!(star.snr >= FIELD_STAR_SNR)) continue
		const width = star.fwhm ?? star.hfd
		if (width > 0) widths.push(width)
	}

	if (widths.length < MIN_PSF_STARS) return undefined
	widths.sort((left, right) => left - right)
	const middle = (widths.length - 1) * 0.5
	const low = Math.floor(middle)
	const high = Math.ceil(middle)
	return (widths[low] + widths[high]) * 0.5
}

// Field score for one streak. A missing angle or median trail length stays secondary. A mismatched angle or scale emits nothing.
function trackingSnapshotScore(streak: Streak, context: Readonly<StreakClassificationContext>): { readonly score: number; readonly tier: StreakEvidenceTier } | undefined {
	const tracking = context.tracking
	if (tracking === undefined || !(tracking.usableStarCount >= MIN_TRACKING_STARS)) return undefined
	const field = rising(tracking.elongatedFraction, 0.4, 0.7) * rising(tracking.directionCoherence, 0.65, 0.9)
	if (!(field > 0)) return undefined
	if (tracking.angle === undefined) return { score: field, tier: 'secondary' }
	if (streakAxialAngleDistance(streak.angle, tracking.angle) > TRACK_ALIGNMENT) return undefined
	if (tracking.medianTrail === undefined) return { score: field, tier: 'secondary' }
	const scale = trailScaleScore(streak.length, tracking.medianTrail)
	if (!(scale > 0)) return undefined
	return { score: field * scale, tier: 'primary' }
}

// One when `length` is within a factor of two of `medianTrail`, falling to zero by a factor of six.
// A non-positive median or length scores zero. Callers keep a missing median as secondary evidence.
function trailScaleScore(length: number, medianTrail: number): number {
	if (!(medianTrail > 0) || !(length > 0)) return 0
	return falling(Math.abs(Math.log(length / medianTrail)), TRAIL_SCALE_AGREE, TRAIL_SCALE_REJECT)
}

// Tracking score from elongated stars spread over at least three image quadrants.
// Round stars do not fill a quadrant. A primary result also requires at least `MIN_FIELD_STARS` measured
// trail lengths whose median matches this streak. Without those lengths the field stays secondary.
function starFieldScore(streak: Streak, context: Readonly<StreakClassificationContext>): { readonly score: number; readonly tier: StreakEvidenceTier } | undefined {
	const stars = context.stars
	const size = frameSize(context.image)
	if (stars === undefined || size === undefined) return undefined

	let usable = 0
	let elongated = 0
	let cosine = 0
	let sine = 0
	let weight = 0
	const quadrants = [false, false, false, false]
	const trailLengths: number[] = []

	for (let index = 0; index < stars.length; index++) {
		const star = stars[index]
		if (!(star.snr >= FIELD_STAR_SNR)) continue
		usable++
		if (!((star.elongation ?? 1) >= ELONGATED_STAR) || star.theta === undefined) continue
		elongated++
		quadrants[(star.x >= size.width * 0.5 ? 1 : 0) + (star.y >= size.height * 0.5 ? 2 : 0)] = true
		if (star.trailLength !== undefined && star.trailLength > 0) trailLengths.push(star.trailLength)
		const sampleWeight = Math.min(star.snr, 50)
		cosine += sampleWeight * Math.cos(2 * star.theta)
		sine += sampleWeight * Math.sin(2 * star.theta)
		weight += sampleWeight
	}

	let occupied = 0
	for (let index = 0; index < quadrants.length; index++) if (quadrants[index]) occupied++
	if (!(usable >= MIN_FIELD_STARS) || !(elongated >= MIN_FIELD_STARS) || !(weight > 0) || occupied < 3) return undefined
	const angle = normalizeStreakAngle(0.5 * Math.atan2(sine / weight, cosine / weight))
	if (streakAxialAngleDistance(streak.angle, angle) > TRACK_ALIGNMENT) return undefined
	const field = rising(elongated / usable, 0.4, 0.7) * rising(Math.min(1, Math.hypot(cosine / weight, sine / weight)), 0.65, 0.9)
	if (!(field > 0)) return undefined
	const medianTrail = medianTrailLength(trailLengths)
	if (medianTrail === undefined) return { score: field, tier: 'secondary' }
	const scale = trailScaleScore(streak.length, medianTrail)
	if (!(scale > 0)) return undefined
	return { score: field * scale, tier: 'primary' }
}

// Median of the supplied trail lengths, in pixels. Undefined until `MIN_FIELD_STARS` lengths are present.
function medianTrailLength(lengths: number[]): number | undefined {
	if (lengths.length < MIN_FIELD_STARS) return undefined
	return medianBySelectionOf(lengths)
}

// Indexes of bright stars whose centers lie on the measured segment.
function alignedStarIndexes(streak: Streak, stars: readonly StreakClassificationStar[]): number[] {
	const indexes: number[] = []
	for (let index = 0; index < stars.length; index++) if (stars[index].snr >= BRIGHT_STAR_SNR && starOnStreak(stars[index], streak)) indexes.push(index)
	return indexes
}

// True when another peer crosses the same bright star on a clearly different axis.
function sharesStarWithAnotherAxis(streak: Streak, peers: readonly Streak[], stars: readonly StreakClassificationStar[], aligned: readonly number[]): boolean {
	for (let peerIndex = 0; peerIndex < peers.length; peerIndex++) {
		const peer = peers[peerIndex]

		if (peer === streak || !(streakAxialAngleDistance(peer.angle, streak.angle) > SPIKE_SEPARATION)) continue

		for (let starIndex = 0; starIndex < aligned.length; starIndex++) {
			if (starOnStreak(stars[aligned[starIndex]], peer)) return true
		}
	}

	return false
}

// True when the star center lies within the transverse tolerance of the finite segment.
// The test uses the endpoints directly, so it does not depend on which way the axial angle points.
function starOnStreak(star: StreakClassificationStar, streak: Streak): boolean {
	const dx = streak.end.x - streak.start.x
	const dy = streak.end.y - streak.start.y
	const lengthSquared = dx * dx + dy * dy
	const tolerance = Math.max(2.5, streak.width)
	if (!(lengthSquared > 0)) return Math.hypot(star.x - streak.start.x, star.y - streak.start.y) <= tolerance
	const projection = ((star.x - streak.start.x) * dx + (star.y - streak.start.y) * dy) / lengthSquared
	const margin = tolerance / Math.sqrt(lengthSquared)
	if (!(projection >= -margin && projection <= 1 + margin)) return false
	const closestX = streak.start.x + Math.min(1, Math.max(0, projection)) * dx
	const closestY = streak.start.y + Math.min(1, Math.max(0, projection)) * dy
	return Math.hypot(star.x - closestX, star.y - closestY) <= tolerance
}

// Score for one thin row or column that reaches both opposite sensor borders. A short, interior, or diagonal trail scores zero.
function sensorLineScore(streak: Streak, context: Readonly<StreakClassificationContext>): number {
	const size = frameSize(context.image)
	if (size === undefined) return 0
	const toHorizontal = streakAxialAngleDistance(streak.angle, 0)
	const toVertical = streakAxialAngleDistance(streak.angle, PIOVERTWO)
	const horizontal = toHorizontal <= toVertical
	if (!reachesOppositeBorders(streak, horizontal, size.width, size.height)) return 0
	const span = streak.length / (horizontal ? size.width : size.height)
	return falling(Math.min(toHorizontal, toVertical), deg(0.4), deg(2)) * falling(streak.width, 1.5, 3.5) * rising(span, 0.75, 0.92) * rising(streak.linearity, 0.9, 0.98) * rising(streak.coverage, 0.85, 0.97)
}

// True when the endpoints reach both borders of the streak's axis, within its width or residual.
function reachesOppositeBorders(streak: Streak, horizontal: boolean, width: number, height: number): boolean {
	const tolerance = Math.max(streak.width, streak.rmsResidual, 1)

	if (horizontal) {
		const minX = Math.min(streak.start.x, streak.end.x)
		const maxX = Math.max(streak.start.x, streak.end.x)
		return minX <= tolerance && maxX >= width - 1 - tolerance
	} else {
		const minY = Math.min(streak.start.y, streak.end.y)
		const maxY = Math.max(streak.start.y, streak.end.y)
		return minY <= tolerance && maxY >= height - 1 - tolerance
	}
}

// Score when at least one earlier frame repeats this sensor locus. Motion between frames scores zero.
function persistenceScore(streak: Streak, context: Readonly<StreakClassificationContext>): number {
	const frames = context.priorFrames
	if (frames === undefined || frames.length === 0) return 0

	let matches = 0
	for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
		const prior = frames[frameIndex].streaks

		for (let streakIndex = 0; streakIndex < prior.length; streakIndex++) {
			if (sameSensorLocus(streak, prior[streakIndex])) {
				matches++
				break
			}
		}
	}

	if (matches === 0) return 0
	return matches >= 2 ? 1 : 0.95
}

// True when two streaks share an axis, a centerline, and most of the shorter segment.
function sameSensorLocus(first: Streak, second: Streak): boolean {
	if (streakAxialAngleDistance(first.angle, second.angle) > SENSOR_ANGLE) return false
	if (streakLineDistance(second.center, first.angle, lineRho(first)) > Math.max(SENSOR_LOCUS_PIXELS, 0.5 * (first.width + second.width))) return false
	const shorter = Math.min(first.length, second.length)
	if (!(shorter > 0)) return false
	return streakSegmentProjectionRelation(first, second, first.angle).overlap >= 0.6 * shorter
}

// Normal-form rho of the streak axis, using its measured center.
function lineRho(streak: Streak): number {
	const { normal } = streakLineVectors(streak.angle)
	return streak.center.x * normal.x + streak.center.y * normal.y
}

// Best geometric match among caller-supplied tracks, ignoring weak scores.
function bestTrack(observed: CelestialStreakTrack, tracks: readonly PredictedStreakTrack[] | undefined, exposure: PredictedTrackWindow | undefined): TrackMatch | undefined {
	if (tracks === undefined || tracks.length === 0) return undefined

	let best: TrackMatch | undefined
	for (let index = 0; index < tracks.length; index++) {
		const comparison = matchPredictedStreakTrack(observed, tracks[index], exposure)
		if (comparison === undefined || !(comparison.score > 0.05)) continue
		if (best === undefined || comparison.score > best.score) best = { score: comparison.score, id: tracks[index].id }
	}

	return best
}

// Exposure window in the start time's timescale. A non-positive duration disables the comparison.
function exposureWindow(context: Readonly<StreakClassificationContext>): PredictedTrackWindow | undefined {
	const start = context.startTime
	if (start === undefined || context.exposure === undefined || !(context.exposure > 0)) return undefined
	return { start, end: { day: start.day, fraction: start.fraction + context.exposure / DAYSEC, scale: start.scale } }
}

// Positive image dimension pair, or undefined when the context has no frame.
function frameSize(image: Image | undefined): { readonly width: number; readonly height: number } | undefined {
	if (image === undefined) return undefined
	const { width, height } = image.metadata
	if (!(width > 0) || !(height > 0)) return undefined
	return { width, height }
}

// Median sample beside the segment. Using the centerline's own percentile would erase a flat trail.
function lateralBaseline(image: Image, streak: Streak): number {
	const dx = streak.end.x - streak.start.x
	const dy = streak.end.y - streak.start.y
	const length = Math.hypot(dx, dy)
	if (!(length > 0)) return 0

	const offset = Math.max(6, streak.width * 3)
	const normalX = -dy / length
	const normalY = dx / length
	const samples: number[] = []

	for (let index = 0; index < 16; index++) {
		const fraction = index / 15
		const x = streak.start.x + dx * fraction
		const y = streak.start.y + dy * fraction
		for (const sign of [-1, 1]) {
			const value = sampleLuminance(image, x + normalX * offset * sign, y + normalY * offset * sign)
			if (value !== undefined && Number.isFinite(value)) samples.push(value)
		}
	}

	if (samples.length === 0) return 0
	samples.sort((left, right) => left - right)
	return samples[Math.floor((samples.length - 1) / 2)]
}

// Baseline-subtracted centerline samples, or undefined when the frame or the peak is unusable.
function centerlineProfile(image: Image | undefined, streak: Streak): Float64Array | undefined {
	if (image === undefined) return undefined
	const { width, height, channels, stride } = image.metadata
	if (channels < 1 || image.raw.length < stride * height) return undefined
	const dx = streak.end.x - streak.start.x
	const dy = streak.end.y - streak.start.y
	const length = Math.hypot(dx, dy)
	if (!(length > 0)) return undefined

	const count = Math.min(128, Math.max(16, Math.round(length / SAMPLE_SPACING)))
	const collected: number[] = []
	for (let index = 0; index < count; index++) {
		const fraction = count === 1 ? 0 : index / (count - 1)
		const value = sampleLuminance(image, streak.start.x + dx * fraction, streak.start.y + dy * fraction)
		if (value !== undefined && Number.isFinite(value)) collected.push(value)
	}

	if (collected.length < 16) return undefined

	const samples = Float64Array.from(collected)
	const baseline = lateralBaseline(image, streak)

	let peak = 0
	for (let index = 0; index < samples.length; index++) {
		samples[index] -= baseline
		if (samples[index] > peak) peak = samples[index]
	}

	return peak > PROFILE_PEAK_FLOOR ? samples : undefined
}

// Bilinear sample. Three-channel frames use green; other frames use the mean of the stored channels.
function sampleLuminance(image: Image, x: number, y: number): number | undefined {
	const { width, height, channels, stride } = image.metadata
	if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return undefined

	const x0 = Math.floor(x)
	const y0 = Math.floor(y)
	const x1 = Math.min(width - 1, x0 + 1)
	const y1 = Math.min(height - 1, y0 + 1)
	const tx = x - x0
	const ty = y - y0

	function sample(px: number, py: number) {
		const index = py * stride + px * channels
		if (channels === 1) return image.raw[index]
		if (channels === 3) return image.raw[index + 1]
		let sum = 0
		for (let channel = 0; channel < channels; channel++) sum += image.raw[index + channel]
		return sum / channels
	}

	const value = sample(x0, y0) * (1 - tx) * (1 - ty) + sample(x1, y0) * tx * (1 - ty) + sample(x0, y1) * (1 - tx) * ty + sample(x1, y1) * tx * ty
	return Number.isFinite(value) ? value : undefined
}

// Regularity of repeated bright runs. A single smooth or tapered trail returns zero.
function periodicity(values: Float64Array): number {
	let peak = 0
	for (let index = 0; index < values.length; index++) if (values[index] > peak) peak = values[index]
	if (!(peak > 0)) return 0

	const high = peak * 0.45
	const gaps: number[] = []
	let runs = 0
	let highCount = 0
	let inRun = false
	let lastStart = -1

	for (let index = 0; index < values.length; index++) {
		if (values[index] >= high) {
			highCount++

			if (!inRun) {
				if (lastStart >= 0) gaps.push(index - lastStart)

				lastStart = index
				runs++
				inRun = true
			}
		} else {
			inRun = false
		}
	}

	const duty = highCount / values.length
	if (runs < 3 || gaps.length < 2 || !(duty >= 0.08 && duty <= 0.75)) return 0
	return falling(variation(gaps), 0.1, 0.5)
}

// Score of a monotonic end-to-end brightness change, as distinct from a central flare.
function taperScore(values: Float64Array): number {
	const third = Math.floor(values.length / 3)
	if (third < 2) return 0
	const start = meanOf(values, 0, third)
	const middle = meanOf(values, third, third * 2)
	const end = meanOf(values, third * 2, values.length)
	const descending = start > middle && middle > end
	const ascending = end > middle && middle > start
	if (!descending && !ascending) return 0
	const high = descending ? start : end
	const low = descending ? end : start
	let peak = 0
	for (let index = 0; index < values.length; index++) if (values[index] > peak) peak = values[index]
	const ratio = high / Math.max(low, peak * 0.05, 1e-6)
	const drop = (high - low) / Math.max(peak, 1e-6)
	return rising(ratio, 1.5, 3) * rising(drop, 0.25, 0.6)
}

// Score of a central peak that exceeds both ends.
function flareScore(values: Float64Array): number {
	const third = Math.floor(values.length / 3)
	if (third < 2) return 0
	const start = meanOf(values, 0, third)
	const middle = meanOf(values, third, third * 2)
	const end = meanOf(values, third * 2, values.length)
	if (!(middle > start && middle > end)) return 0
	let peak = 0
	for (let index = 0; index < values.length; index++) if (values[index] > peak) peak = values[index]
	const ratio = middle / Math.max(Math.max(start, end), peak * 0.05, 1e-6)
	return rising(ratio, 1.6, 3)
}

// Coefficient of variation. A non-positive mean is treated as unstructured.
function variation(values: Readonly<NumberArray>): number {
	return standardDeviationOf(values) / meanOf(values)
}

// One class vote with a single diagnostic.
function vote(kind: StreakEvidenceContribution['class'], score: number, weight: number, tier: StreakEvidenceTier, item: StreakClassificationEvidence): StreakEvidenceContribution {
	return { class: kind, score, weight, tier, evidence: [item] }
}

// Primary vote for one predicted-track match.
function trackVote(kind: 'satellite' | 'movingObject', match: TrackMatch): StreakEvidenceContribution {
	return vote(kind, match.score, PRIMARY_WEIGHT, 'primary', evidenceItem('predictedTrack', match.score, 'caller-supplied track agrees in residual, overlap, and axis', match.id))
}

// Builds one evidence record, omitting an identifier the caller did not supply.
function evidenceItem(kind: string, score: number, description: string, id?: string | number): StreakClassificationEvidence {
	return id === undefined ? { kind, score, description } : { kind, score, description, id }
}

// Best radiant geometry considered while scanning a candidate list.
interface RadiantMatch {
	// Cross-track quality in [0, 1].
	readonly geometry: number
	// Candidate identifier, when the caller supplied one.
	readonly id?: string | number
	// Whether the meteor association accepted the plane and the outward direction.
	readonly compatible: boolean
}

// Best predicted-track score retained for one class.
interface TrackMatch {
	// Combined geometric and temporal score in [0, 1].
	readonly score: number
	// Track identifier, when the caller supplied one.
	readonly id?: string | number
}
