import type { MeteorRadiant } from '../../../astronomy/meteors/types'
import type { Time } from '../../../astronomy/time/time'
import type { FitsHeader } from '../../../io/formats/fits/fits'
import type { Angle } from '../../../math/units/angle'
import type { Image } from '../../model/types'
import type { DetectedStar } from '../../stars/detector'
import type { Streak } from './types'

// Diagnostic contracts for classifying measured streaks and for the inputs a caller may supply.
// Scores are uncalibrated weights in [0, 1], not probabilities fitted to a labeled sample.
// Angles are radians. Pixel positions use received-image coordinates, x right and y down.

// Physical or technical interpretation considered for one streak.
export type StreakClass = 'meteor' | 'satellite' | 'airplane' | 'movingObject' | 'trackingFailure' | 'opticalArtifact' | 'sensorArtifact' | 'unknown'

// Whether a contribution can name a class or only raise a hypothesis.
// Primary cues are geometric or field identifications. Secondary cues are morphology and intensity.
export type StreakEvidenceTier = 'primary' | 'secondary'

// One diagnostic measurement retained with the classification.
export interface StreakClassificationEvidence {
	// Stable metric name, such as `predicted-track` or `intensity-periodic`.
	readonly kind: string
	// Uncalibrated strength of this metric in [0, 1], before tier weighting.
	readonly score: number
	// Short explanation of what the metric measured.
	readonly description?: string
	// Caller-supplied track or radiant identifier when the metric matched one.
	readonly id?: string | number
}

// Aggregated weight of one class after all providers have been combined.
export interface StreakClassScore {
	// Candidate interpretation.
	readonly class: StreakClass
	// Combined uncalibrated weight in [0, 1].
	readonly score: number
}

// Chosen interpretation plus the evidence that produced it.
export interface StreakClassification {
	// `unknown` when no primary cue clears the score and margin gates.
	readonly class: StreakClass
	// Weight of `class`. For `unknown`, the complement of the strongest competing total.
	readonly confidence: number
	// Other classes with a positive total, highest first. `unknown` is never listed here.
	readonly alternatives: readonly StreakClassScore[]
	// Provider metrics in evaluation order. Their scores are not the aggregated class totals.
	readonly evidence: readonly StreakClassificationEvidence[]
}

// Weighted vote from one evidence provider.
export interface StreakEvidenceContribution {
	// Class receiving this vote. Providers do not vote for `unknown`.
	readonly class: Exclude<StreakClass, 'unknown'>
	// Provider metric in [0, 1]. Zero still records `evidence` without adding weight.
	readonly score: number
	// Maximum class-total contribution of this vote when `score` is one.
	readonly weight: number
	// Primary votes can name a class. Secondary votes only move alternatives and confidence.
	readonly tier: StreakEvidenceTier
	// Diagnostics that explain the vote.
	readonly evidence: readonly StreakClassificationEvidence[]
}

// Replaceable source of class votes. `peers` is the streak set passed to `classifyStreaks`.
export interface StreakEvidenceProvider {
	// Stable provider name used by callers that compose their own list.
	readonly id: string
	// Returns zero or more votes. Must be deterministic and must not perform network or catalog IO.
	readonly evaluate: (streak: Streak, context: Readonly<StreakClassificationContext>, peers: readonly Streak[]) => readonly StreakEvidenceContribution[]
}

// Caller-supplied sky segment in the same equatorial frame as the image WCS.
export interface PredictedStreakTrack {
	// Optional identifier copied into matching evidence.
	readonly id?: string | number
	// Segment start as right ascension and declination, in radians.
	readonly start: readonly [Angle, Angle]
	// Segment end as right ascension and declination, in radians.
	readonly end: readonly [Angle, Angle]
	// Optional predicted time of `start`. Compared only with times of the same timescale.
	readonly startTime?: Time
	// Optional predicted time of `end`.
	readonly endTime?: Time
}

// Shower or sporadic radiant candidate in the same equatorial frame as the image WCS.
export interface MeteorRadiantCandidate extends MeteorRadiant {
	// Optional identifier copied into radiant evidence.
	readonly id?: string | number
}

// Star measurement plus the optional major-axis angle and trail length needed for field coherence.
export interface StreakClassificationStar extends DetectedStar {
	// Major-axis orientation in received-image radians in [0, π). `theta` and `theta + π` are the same axis.
	readonly theta?: Angle
	// Measured major-axis trail length, in received-image pixels. Elongation and FWHM are not converted into this length.
	readonly trailLength?: number
}

// Field-wide tracking snapshot consumed as primary evidence.
// Structurally compatible with the tracking-quality measurement: this module does not import it.
export interface StreakTrackingQuality {
	// Stars supplied to the tracking measurement.
	readonly starCount: number
	// Stars that passed that measurement's quality cuts.
	readonly usableStarCount: number
	// Fraction of usable stars that were significantly elongated, in [0, 1].
	readonly elongatedFraction: number
	// Axial coherence of major-axis angles, in [0, 1]. One means a shared axis modulo π.
	readonly directionCoherence: number
	// Dominant major-axis angle in received-image radians in [0, π), when defined.
	readonly angle?: Angle
	// Representative stellar trail length, in received-image pixels, when defined.
	readonly medianTrail?: number
	// Tracking measurement's own bounded score. Retained for callers; classification uses the fields above.
	readonly score: number
}

// One earlier exposure in the same received-image pixel frame.
export interface StreakTemporalFrame {
	// Streaks measured in that exposure.
	readonly streaks: readonly Streak[]
	// Optional exposure start. Persistence matching does not require it; later motion tests can.
	readonly startTime?: Time
}

// Optional context. Missing fields lower confidence; they are not filled by network lookups.
export interface StreakClassificationContext {
	// Frame whose samples supply the intensity profile. Pixel layout matches `Streak` coordinates.
	readonly image?: Image
	// Stars measured in the same received-image pixel frame.
	readonly stars?: readonly StreakClassificationStar[]
	// Exposure duration, in seconds.
	readonly exposure?: number
	// Exposure start. Timescale must match any predicted-track times being compared.
	readonly startTime?: Time
	// TAN or TAN-SIP header for this raster. CRPIX is FITS 1-based; streak pixels are 0-based centers.
	readonly wcs?: FitsHeader
	// Predicted satellite segments. A geometric match is primary evidence and does not propagate TLEs.
	readonly satelliteTracks?: readonly PredictedStreakTrack[]
	// Predicted asteroid, comet, or other ephemeris segments supplied by the caller.
	readonly movingObjectTracks?: readonly PredictedStreakTrack[]
	// Radiant candidates, usually active showers, in the WCS equatorial frame.
	readonly meteorRadiants?: readonly MeteorRadiantCandidate[]
	// Field-wide tracking measurement. An isolated streak is not treated as tracking failure without it or coherent stars.
	readonly tracking?: Readonly<StreakTrackingQuality>
	// Earlier frames used for sensor-coordinate persistence. This is the temporal extension point.
	readonly priorFrames?: readonly StreakTemporalFrame[]
}

// Gates and optional provider replacement. Omitted fields use `DEFAULT_STREAK_CLASSIFIER_OPTIONS`.
export interface StreakClassifierOptions {
	// Minimum primary weight required to name a class.
	readonly minimumScore?: number
	// Minimum primary lead over the next primary vote. A smaller lead stays `unknown`.
	readonly minimumMargin?: number
	// Replaces the built-in providers when set, including when empty.
	readonly providers?: readonly StreakEvidenceProvider[]
}

// Default decision gates. They compare uncalibrated primary weights, not calibrated probabilities.
export const DEFAULT_STREAK_CLASSIFIER_OPTIONS: Required<Pick<StreakClassifierOptions, 'minimumScore' | 'minimumMargin'>> = {
	minimumScore: 0.62,
	minimumMargin: 0.12,
}

// Rises from zero at `low` to one at `high`.
export function rising(value: number, low: number, high: number): number {
	if (!(high > low)) return value >= high ? 1 : 0
	if (value <= low) return 0
	if (value >= high) return 1
	return (value - low) / (high - low)
}

// Falls from one at `low` to zero at `high`.
export function falling(value: number, low: number, high: number): number {
	return 1 - rising(value, low, high)
}
