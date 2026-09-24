import { DAYSEC } from '../../core/constants'
import { vecDot } from '../../math/linear-algebra/vec3'
import { type Angle, normalizePI } from '../../math/units/angle'
import { angularDistance, positionAngleBetween } from './coordinate'
import { eraS2c } from './erfa/erfa'

// Angular velocity and acceleration between spherical positions. Longitude and latitude are radians
// (right ascension and declination when the sphere is the sky). Time is in days, matching the
// library's ephemeris velocity convention; per-second rates are the same quantities divided by 86400.
// Longitude differences are unwrapped to (−π, π] before dividing, so a sample that crosses 0h does
// not invent a nearly full-turn rate. The total angular rate is the great-circle rate,
// hypot(Δlongitude · cos(latitude), Δlatitude) / Δt, using the mean latitude of the two endpoints.

// Dot-product distance from -1 treated as numerically antipodal. Thirty-two double-precision ulps
// reject only legs within roughly 0.03 arcsecond of π, where the log-map tangent is ill-conditioned.
const ANTIPODAL_DOT_TOLERANCE = 32 * Number.EPSILON

// One spherical position at a time.
export interface SphericalMotionSample {
	// Longitude, or right ascension, in radians.
	readonly longitude: Angle
	// Latitude, or declination, in radians.
	readonly latitude: Angle
	// Time in days. Only differences matter; the origin is arbitrary.
	readonly timeDays: number
}

// Velocity, and when three or more samples are available, acceleration, of a spherical track.
export interface AngularMotion {
	// Coordinate longitude rate in radians per day. This is dRA/dt, not multiplied by cos(declination).
	readonly longitudeRatePerDay: Angle
	// Coordinate latitude rate in radians per day.
	readonly latitudeRatePerDay: Angle
	// Great-circle angular rate in radians per day.
	readonly angularRatePerDay: Angle
	// Longitude rate in radians per SI second.
	readonly longitudeRatePerSecond: Angle
	// Latitude rate in radians per SI second.
	readonly latitudeRatePerSecond: Angle
	// Great-circle angular rate in radians per SI second.
	readonly angularRatePerSecond: Angle
	// Position angle of the displacement from the first endpoint toward the last, from north toward
	// east, in [0, 2π). Zero when the endpoints coincide.
	readonly positionAngle: Angle
	// Longitude acceleration in radians per day squared. Present when a three-point stencil was formed.
	readonly longitudeAccelerationPerDaySquared?: Angle
	// Latitude acceleration in radians per day squared.
	readonly latitudeAccelerationPerDaySquared?: Angle
	// Magnitude of the tangential acceleration in radians per day squared.
	readonly angularAccelerationPerDaySquared?: Angle
}

// Picks the sample closest to the mid-time of the first and last entries. The endpoints themselves are not candidates.
function middleSample(samples: readonly SphericalMotionSample[]) {
	const first = samples[0]
	const last = samples.at(-1)
	if (first === undefined || last === undefined || samples.length < 3) return undefined

	const midTime = (first.timeDays + last.timeDays) * 0.5
	let middle = samples[1]
	let best = Number.POSITIVE_INFINITY

	for (let i = 1; i < samples.length - 1; i++) {
		const candidate = samples[i]
		if (candidate === undefined) continue
		const distance = Math.abs(candidate.timeDays - midTime)
		if (distance < best) {
			best = distance
			middle = candidate
		}
	}

	return middle
}

// Coordinate rates of one leg. Longitude is unwrapped. Returns undefined when the leg has no duration.
function legRate(from: SphericalMotionSample, to: SphericalMotionSample) {
	const dt = to.timeDays - from.timeDays
	if (!(dt !== 0)) return undefined

	return {
		longitude: normalizePI(to.longitude - from.longitude) / dt,
		latitude: (to.latitude - from.latitude) / dt,
	}
}

// Tangential acceleration of a three-point spherical track at its middle sample. Positions are
// converted to unit vectors; each adjacent great-circle arc becomes a velocity in the middle tangent
// plane, and their non-uniform finite difference is the covariant acceleration. This removes radial
// centripetal acceleration and avoids longitude-chart singularities at the poles. Times are days and
// the result is rad/day². Antipodal legs have no unique tangent and omit the result.
function tangentialAcceleration(first: SphericalMotionSample, middle: SphericalMotionSample, last: SphericalMotionSample): number | undefined {
	const before = middle.timeDays - first.timeDays
	const after = last.timeDays - middle.timeDays
	if (!(before > 0) || !(after > 0)) return undefined
	const a = eraS2c(first.longitude, first.latitude)
	const b = eraS2c(middle.longitude, middle.latitude)
	const c = eraS2c(last.longitude, last.latitude)
	const incomingDot = Math.max(-1, Math.min(1, vecDot(a, b)))
	const incomingX = incomingDot * b[0] - a[0]
	const incomingY = incomingDot * b[1] - a[1]
	const incomingZ = incomingDot * b[2] - a[2]
	const incomingNorm = Math.hypot(incomingX, incomingY, incomingZ)
	const outgoingDot = Math.max(-1, Math.min(1, vecDot(b, c)))
	const outgoingX = c[0] - outgoingDot * b[0]
	const outgoingY = c[1] - outgoingDot * b[1]
	const outgoingZ = c[2] - outgoingDot * b[2]
	const outgoingNorm = Math.hypot(outgoingX, outgoingY, outgoingZ)
	if (incomingDot <= -1 + ANTIPODAL_DOT_TOLERANCE || outgoingDot <= -1 + ANTIPODAL_DOT_TOLERANCE) return undefined

	const incomingScale = incomingNorm === 0 ? 0 : Math.atan2(incomingNorm, incomingDot) / (before * incomingNorm)
	const outgoingScale = outgoingNorm === 0 ? 0 : Math.atan2(outgoingNorm, outgoingDot) / (after * outgoingNorm)
	const accelerationScale = 2 / (before + after)
	return accelerationScale * Math.hypot(outgoingX * outgoingScale - incomingX * incomingScale, outgoingY * outgoingScale - incomingY * incomingScale, outgoingZ * outgoingScale - incomingZ * incomingScale)
}

// Angular velocity between spherical samples, and acceleration when at least three are supplied.
// Parameters: samples holds two or more positions. With exactly two, the rate is the secant between
// them and no acceleration is published. With three or more, the rate is the secant from the earliest
// to the latest, and the acceleration is the change between the leg into the mid-time sample and the
// leg out of it, divided by half the full span: a = 2 (v₁₂ − v₀₁) / (t₂ − t₀). Samples may arrive
// unordered; they are sorted by time. Returns undefined when fewer than two samples are finite in
// time or when the endpoints share a time.
// Differential tracking rate of an ephemeris sampled at two or three equatorial positions.
// Instantaneous curved motion needs the three-sample acceleration; two samples give a constant rate.
export function angularMotionOrDifferentialTrackingRate(samples: readonly SphericalMotionSample[]): AngularMotion | undefined {
	if (samples.length < 2) return undefined
	const ordered = samples.toSorted((a, b) => a.timeDays - b.timeDays)
	const first = ordered[0]
	const last = ordered.at(-1)
	if (first === undefined || last === undefined) return undefined
	const span = last.timeDays - first.timeDays
	if (!(span !== 0)) return undefined

	const longitudeDelta = normalizePI(last.longitude - first.longitude)
	const latitudeDelta = last.latitude - first.latitude
	const longitudeRatePerDay = longitudeDelta / span
	const latitudeRatePerDay = latitudeDelta / span
	const angularRatePerDay = angularDistance(first.longitude, first.latitude, last.longitude, last.latitude) / Math.abs(span)
	const motion: AngularMotion = {
		longitudeRatePerDay,
		latitudeRatePerDay,
		angularRatePerDay,
		longitudeRatePerSecond: longitudeRatePerDay / DAYSEC,
		latitudeRatePerSecond: latitudeRatePerDay / DAYSEC,
		angularRatePerSecond: angularRatePerDay / DAYSEC,
		positionAngle: positionAngleBetween(first.longitude, first.latitude, last.longitude, last.latitude),
	}

	const middle = middleSample(ordered)
	if (middle === undefined) return motion
	const inward = legRate(first, middle)
	const outward = legRate(middle, last)
	if (inward === undefined || outward === undefined) return motion
	const longitudeAccelerationPerDaySquared = (2 * (outward.longitude - inward.longitude)) / span
	const latitudeAccelerationPerDaySquared = (2 * (outward.latitude - inward.latitude)) / span
	const angularAccelerationPerDaySquared = tangentialAcceleration(first, middle, last)
	return { ...motion, longitudeAccelerationPerDaySquared, latitudeAccelerationPerDaySquared, angularAccelerationPerDaySquared }
}
