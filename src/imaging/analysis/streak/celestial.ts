import { tanUnproject } from '../../../astrometry/wcs/fits.wcs'
import { meteorRadiantVector } from '../../../astronomy/meteors/radiant'
import { meteorTrackGreatCircle, meteorTrackLength, meteorTrackPositionAngle } from '../../../astronomy/meteors/trajectory'
import type { MeteorRadiant, MeteorTrack } from '../../../astronomy/meteors/types'
import type { Time } from '../../../astronomy/time/time'
import type { FitsHeader } from '../../../io/formats/fits/fits'
import { type Vec3, vecCross, vecDot, vecNormalize } from '../../../math/linear-algebra/vec3'
import { sphericalInterpolate } from '../../../math/numerical/geometry'
import { type Angle, arcsec, deg, normalizeAngle } from '../../../math/units/angle'
import { falling, rising, type PredictedStreakTrack } from './classification.types'
import { normalizeStreakAngle } from './geometry'
import type { Streak } from './types'

// Equatorial track of one measured streak and its comparison with a caller-supplied prediction.
// Right ascension and declination are radians in the WCS frame. Great-circle geometry is delegated
// to the meteor trajectory helpers, which already handle right-ascension wrap and high declination.
// Endpoint order follows the streak's canonical pixel order, not a direction of motion.

// FITS pixel centers are 1-based. Received-image streak coordinates are 0-based pixel centers.
const FITS_PIXEL_CENTER_OFFSET = 1
// Cross-track residual, in radians, that still counts as a perfect geometric match.
const CROSS_TRACK_EXCELLENT = arcsec(20)
// Cross-track residual, in radians, beyond which the geometric score is zero.
const CROSS_TRACK_REJECT = deg(1.5)
// Along-track overlap fraction that starts to support a match.
const OVERLAP_LOW = 0.35
// Along-track overlap fraction that saturates the overlap score.
const OVERLAP_HIGH = 0.85
// Axial position-angle error, in radians, that still counts as aligned.
const ORIENTATION_EXCELLENT = deg(8)
// Axial position-angle error, in radians, beyond which the orientation score is zero.
const ORIENTATION_REJECT = deg(30)

// Sky segment derived from the two streak endpoints.
export interface CelestialStreakTrack {
	// Canonical streak start, as right ascension and declination in radians.
	readonly start: readonly [Angle, Angle]
	// Canonical streak end, as right ascension and declination in radians.
	readonly end: readonly [Angle, Angle]
	// Unit equatorial vector of `start`.
	readonly startVector: Vec3
	// Unit equatorial vector of `end`.
	readonly endVector: Vec3
	// Short-arc great-circle length, in radians, in (0, π).
	readonly length: Angle
	// Position angle from `start` to `end`, east of north, in [0, 2π).
	readonly positionAngle: Angle
	// Undirected axis of `positionAngle`, in [0, π). The opposite pixel order is the same axis.
	readonly axialPositionAngle: Angle
	// Unit pole of the oriented arc `start × end`. The opposite endpoint order flips its sign.
	readonly normal: Vec3
}

// Geometric comparison of one observed arc with one predicted arc.
export interface CelestialTrackComparison {
	// Mean absolute great-circle residual of the observed endpoints and midpoint, in radians.
	readonly crossTrack: Angle
	// Fraction of the observed along-track span that lies inside the predicted arc, in [0, 1].
	readonly overlap: number
	// Smallest undirected position-angle difference, in [0, π/2].
	readonly orientation: Angle
	// Fraction of the exposure window inside the predicted time span, when both spans exist.
	readonly temporalOverlap?: number
	// Product of the geometric scores and, when times were compared, the temporal overlap. In [0, 1].
	readonly score: number
}

// Exposure window compared with a prediction. Instants must share a timescale to be used.
export interface PredictedTrackWindow {
	// Exposure start.
	readonly start?: Time
	// Exposure end. An unnormalized fraction is accepted because only `day + fraction` is compared.
	readonly end?: Time
}

// Maps both streak endpoints through the TAN/TAN-SIP header.
// Returns undefined when either pixel is not projectable or the arc does not define a unique plane.
export function celestialStreakTrack(streak: Streak, wcs: FitsHeader): CelestialStreakTrack | undefined {
	const start = unprojectStreakPixel(wcs, streak.start.x, streak.start.y)
	const end = unprojectStreakPixel(wcs, streak.end.x, streak.end.y)
	if (start === undefined || end === undefined) return undefined

	const track = meteorTrack(start, end)
	const length = meteorTrackLength(track)
	const normal = meteorTrackGreatCircle(track)
	if (length === undefined || !(length > 0) || normal === undefined) return undefined

	const positionAngle = meteorTrackPositionAngle(track.start, track.end)

	return {
		start,
		end,
		startVector: meteorRadiantVector(track.start),
		endVector: meteorRadiantVector(track.end),
		length,
		positionAngle,
		axialPositionAngle: normalizeStreakAngle(positionAngle),
		normal: [normal[0], normal[1], normal[2]],
	}
}

// Compares one observed arc with one predicted arc.
// Direction is ignored because a still-image streak has no arrow; a reversed prediction matches the same axis.
// When both the exposure and the prediction carry times of one timescale, cross-track, overlap, and orientation
// use only the predicted sub-arc inside the intersection. A prediction contained in the exposure keeps its whole
// arc and a temporal score of one. An exposure contained in a longer prediction keeps only the arc that occurs
// during the exposure, so a later piece of the same plane does not match. A disjoint window scores zero.
// Returns undefined for a degenerate prediction or for an observed point that falls on the predicted pole.
export function matchPredictedStreakTrack(observed: CelestialStreakTrack, predicted: Readonly<PredictedStreakTrack>, exposure?: Readonly<PredictedTrackWindow>): CelestialTrackComparison | undefined {
	const visibility = predictedVisibility(exposure, predicted)

	if (visibility !== undefined && !(visibility.temporalOverlap > 0)) {
		const rejected = compareTrack(observed, predicted.start, predicted.end)
		if (rejected === undefined) return undefined
		return { crossTrack: rejected.crossTrack, overlap: 0, orientation: rejected.orientation, temporalOverlap: 0, score: 0 }
	}

	let start = predicted.start
	let end = predicted.end

	if (visibility !== undefined) {
		const low = Math.min(visibility.startFraction, visibility.endFraction)
		const high = Math.max(visibility.startFraction, visibility.endFraction)

		if (low > 0 || high < 1) {
			start = sphericalInterpolate(predicted.start[0], predicted.start[1], predicted.end[0], predicted.end[1], low)
			end = sphericalInterpolate(predicted.start[0], predicted.start[1], predicted.end[0], predicted.end[1], high)
		}
	}

	const compared = compareTrack(observed, start, end)
	if (compared === undefined) return undefined
	const temporal = visibility?.temporalOverlap
	return { crossTrack: compared.crossTrack, overlap: compared.overlap, orientation: compared.orientation, temporalOverlap: temporal, score: compared.geometry * (temporal ?? 1) }
}

// Geometric scores of `observed` against the predicted segment `start` → `end`, before the temporal factor.
// `geometry` is the product of the cross-track, overlap, and orientation ramps, in [0, 1].
function compareTrack(observed: CelestialStreakTrack, start: readonly [Angle, Angle], end: readonly [Angle, Angle]): { readonly crossTrack: Angle; readonly overlap: number; readonly orientation: Angle; readonly geometry: number } | undefined {
	const predictedTrack = meteorTrack(start, end)
	const pole = meteorTrackGreatCircle(predictedTrack)
	const predictedLength = meteorTrackLength(predictedTrack)
	if (pole === undefined || predictedLength === undefined || !(predictedLength > 0)) return undefined

	const origin = meteorRadiantVector(predictedTrack.start)
	const destination = meteorRadiantVector(predictedTrack.end)
	const tangent = vecNormalize(vecCross(pole, origin))
	const startAlong = alongTrack(observed.startVector, pole, origin, tangent)
	const endAlong = alongTrack(observed.endVector, pole, origin, tangent)
	const predictedEnd = alongTrack(destination, pole, origin, tangent)
	if (startAlong === undefined || endAlong === undefined || predictedEnd === undefined || !(predictedEnd > 0)) return undefined

	const observedStart = Math.min(startAlong, endAlong)
	const observedEnd = Math.max(startAlong, endAlong)
	const observedSpan = observedEnd - observedStart
	if (!(observedSpan > 0)) return undefined

	const overlapLength = Math.max(0, Math.min(observedEnd, predictedEnd) - Math.max(observedStart, 0))
	const overlap = overlapLength / observedSpan
	const midpoint = sphericalInterpolate(observed.start[0], observed.start[1], observed.end[0], observed.end[1], 0.5)
	const crossTrack = (pointResidual(observed.startVector, pole) + pointResidual(observed.endVector, pole) + pointResidual(meteorRadiantVector({ rightAscension: midpoint[0], declination: midpoint[1] }), pole)) / 3
	const orientation = greatCirclePlaneAngle(observed.normal, pole)
	const geometry = falling(crossTrack, CROSS_TRACK_EXCELLENT, CROSS_TRACK_REJECT) * rising(overlap, OVERLAP_LOW, OVERLAP_HIGH) * falling(orientation, ORIENTATION_EXCELLENT, ORIENTATION_REJECT)
	return { crossTrack, overlap, orientation, geometry }
}

// Converts one received-image pixel center to equatorial radians. The header keeps the raster's axis directions.
function unprojectStreakPixel(wcs: FitsHeader, x: number, y: number): readonly [Angle, Angle] | undefined {
	const sky = tanUnproject(wcs, x + FITS_PIXEL_CENTER_OFFSET, y + FITS_PIXEL_CENTER_OFFSET)
	if (sky === undefined || !Number.isFinite(sky[0]) || !Number.isFinite(sky[1])) return undefined
	return [normalizeAngle(sky[0]), sky[1]]
}

// Builds the meteor great-circle record for two equatorial endpoints.
function meteorTrack(start: readonly [Angle, Angle], end: readonly [Angle, Angle]): MeteorTrack {
	return { start: radiant(start), end: radiant(end) }
}

// Copies one right-ascension/declination pair into a meteor radiant.
function radiant(coordinate: readonly [Angle, Angle]): MeteorRadiant {
	return { rightAscension: coordinate[0], declination: coordinate[1] }
}

// Signed angle from `origin` toward `tangent` after removing the great-circle pole component.
function alongTrack(point: Vec3, pole: Vec3, origin: Vec3, tangent: Vec3): number | undefined {
	const parallel = vecDot(point, pole)
	const x = point[0] - pole[0] * parallel
	const y = point[1] - pole[1] * parallel
	const z = point[2] - pole[2] * parallel
	const length = Math.hypot(x, y, z)
	if (!(length > 1e-15)) return undefined
	const inverse = 1 / length
	return Math.atan2(x * inverse * tangent[0] + y * inverse * tangent[1] + z * inverse * tangent[2], x * inverse * origin[0] + y * inverse * origin[1] + z * inverse * origin[2])
}

// Angle between two undirected great-circle planes, in [0, π/2]. Endpoint reversal flips a pole, so the absolute dot product keeps that reversal on the same axis.
function greatCirclePlaneAngle(observedNormal: Vec3, predictedPole: Vec3): Angle {
	const cosine = Math.abs(vecDot(observedNormal, predictedPole))
	return Math.acos(Math.min(1, Math.max(0, cosine)))
}

// Absolute angular distance from a unit vector to a great-circle plane, in radians.
function pointResidual(point: Vec3, pole: Vec3): Angle {
	return Math.asin(Math.abs(Math.min(1, Math.max(-1, vecDot(point, pole)))))
}

// Visible fraction of a prediction, tying each endpoint coordinate to its own time.
interface PredictedVisibility {
	// Intersection divided by the shorter window, in [0, 1]. Zero when the windows do not meet.
	readonly temporalOverlap: number
	// Overlap start as a fraction from the predicted `start` toward `end`.
	readonly startFraction: number
	// Overlap end as a fraction from the predicted `start` toward `end`. Reversed times make this smaller than `startFraction`.
	readonly endFraction: number
}

// Scores whether the predicted interval occurs during the exposure, or undefined when either span is incomplete.
// The score is the intersection divided by the shorter window, so a fast transit fully inside a long exposure
// scores one, as does an exposure fully inside a longer predicted pass. The fractions locate that intersection
// on the segment whose endpoints are `start` at `startTime` and `end` at `endTime`; they are not swapped when
// the times run backwards. A partial overlap stays proportional to the shorter window. Disjoint windows score
// zero. Distinct timescales are ignored rather than converted.
function predictedVisibility(exposure: Readonly<PredictedTrackWindow> | undefined, predicted: Readonly<PredictedStreakTrack>): PredictedVisibility | undefined {
	if (exposure?.start === undefined || exposure.end === undefined || predicted.startTime === undefined || predicted.endTime === undefined) return undefined

	const scale = exposure.start.scale
	if (exposure.end.scale !== scale || predicted.startTime.scale !== scale || predicted.endTime.scale !== scale) return undefined

	const exposureStart = exposure.start.day + exposure.start.fraction
	const exposureEnd = exposure.end.day + exposure.end.fraction
	const predictedStart = predicted.startTime.day + predicted.startTime.fraction
	const predictedEnd = predicted.endTime.day + predicted.endTime.fraction
	const exposureDuration = exposureEnd - exposureStart
	const predictedSpan = predictedEnd - predictedStart
	if (!(exposureDuration > 0) || !(Math.abs(predictedSpan) > 0)) return undefined

	const overlapStart = Math.max(exposureStart, Math.min(predictedStart, predictedEnd))
	const overlapEnd = Math.min(exposureEnd, Math.max(predictedStart, predictedEnd))
	const overlap = overlapEnd - overlapStart
	if (!(overlap > 0)) return { temporalOverlap: 0, startFraction: 0, endFraction: 0 }

	const temporalOverlap = Math.min(1, overlap / Math.min(exposureDuration, Math.abs(predictedSpan)))
	return {
		temporalOverlap,
		startFraction: Math.min(1, Math.max(0, (overlapStart - predictedStart) / predictedSpan)),
		endFraction: Math.min(1, Math.max(0, (overlapEnd - predictedStart) / predictedSpan)),
	}
}
