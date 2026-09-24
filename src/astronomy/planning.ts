import { DEG2RAD, PIOVERTWO } from '../core/constants'
import { clamp } from '../math/numerical/math'
import { geometricMeanOf } from '../math/numerical/statistics'
import { type Angle, normalizePI } from '../math/units/angle'
import { airmassKastenYoung } from './formulas'

// Pure observing scores for a target that has already been reduced to altitudes, airmass, and a lunar
// geometry. Nothing here evaluates an ephemeris. Scores are dimensionless on 0..1 unless a caller
// asks for the 0..100 scale. Angles are radians.

// Width of the lunar separation kernel. At this separation from a zenith full Moon the interference
// has fallen to exp(−1/2).
const MOON_SEPARATION_SIGMA = 30 * DEG2RAD
// Altitude at which the altitude factor saturates. Higher targets do not score any better.
const GOOD_ALTITUDE = 60 * DEG2RAD
// Airmass at which the airmass factor reaches zero.
const MAXIMUM_AIRMASS = 3
// Solar altitude of the start of the twilight ramp (nautical twilight, score zero at and above it).
const NAUTICAL_SUN = -12 * DEG2RAD
// Solar altitude at which the twilight factor saturates (astronomical twilight).
const ASTRONOMICAL_SUN = -18 * DEG2RAD

// Inputs of one target score. Omitted optional fields are left out of the mean rather than treated
// as a failure, except altitude, which is always scored, and airmass, which is derived from altitude
// when it is omitted.
export interface ObservationScoreInput {
	// Geometric altitude of the target, in radians.
	readonly altitude: Angle
	// Kasten–Young airmass. Derived from altitude when omitted. Ignored when the target is not above
	// the horizon, where the factor is zero.
	readonly airmass?: number
	// Geometric solar altitude, in radians. Omitted means twilight is not part of this score.
	readonly sunAltitude?: Angle
	// Moon interference on 0..1, as returned by moonInterference. Omitted means the Moon is not part
	// of this score.
	readonly moonInterference?: number
	// Hours the target remains observable. Scored only together with requiredDurationHours.
	readonly availableDurationHours?: number
	// Hours the observation needs. A zero requirement scores as fully satisfied.
	readonly requiredDurationHours?: number
}

// Overrides for the ramps inside observationScore.
export interface ObservationScoreOptions {
	// Altitude at and below which the altitude factor is zero. Defaults to the horizon.
	readonly minimumAltitude?: Angle
	// Altitude at and above which the altitude factor is one. Defaults to 60°.
	readonly goodAltitude?: Angle
	// Airmass at and above which the airmass factor is zero. Defaults to 3.
	readonly maximumAirmass?: number
	// 1 returns the unit interval. 100 returns a percentage. Defaults to 1.
	readonly scale?: 1 | 100
}

// Linear ramp from 0 at `start` to 1 at `end`. The ends may arrive in either order.
function ramp(value: number, start: number, end: number) {
	if (start === end) return value >= end ? 1 : 0
	return clamp((value - start) / (end - start), 0, 1)
}

// Simple lunar interference on 0..1.
// Parameters: illumination is the illuminated fraction of the lunar disk, from 0 to 1.
// moonAltitude is the geometric lunar altitude in radians. separation is the angular distance from
// the Moon to the target, in radians; values outside (−π, π] are wrapped before use. Returns 0 when
// the Moon is on or below the horizon or the illumination is not positive. A full Moon at the zenith
// sitting on the target scores 1. The separation weight is a Gaussian of width 30°.
export function moonInterference(illumination: number, moonAltitude: Angle, separation: Angle): number {
	const altitudeWeight = Math.sin(moonAltitude)
	if (!(altitudeWeight > 0) || !(illumination > 0)) return 0
	const wrapped = Math.abs(normalizePI(separation))
	const kernel = Math.exp(-0.5 * (wrapped / MOON_SEPARATION_SIGMA) ** 2)
	return clamp(illumination * altitudeWeight * kernel, 0, 1)
}

// Observing score of one target from altitude, airmass, twilight, lunar interference, and duration.
// Parameters: input carries the already-reduced quantities. options changes the altitude and airmass
// ramps and the output scale. The score is the geometric mean of the altitude factor, the airmass
// factor, and whichever of twilight, Moon, and duration were supplied. Altitude rises from 0 at the
// horizon to 1 at 60°. Airmass falls from 1 at zenith to 0 at airmass 3. Twilight rises from 0 at
// solar altitude −12° to 1 at −18°. Duration is the capped ratio of available hours to required
// hours. Returns a value in 0..1, or 0..100 when scale is 100.
export function observationScore(input: ObservationScoreInput, options: ObservationScoreOptions = {}): number {
	const minimumAltitude = options.minimumAltitude ?? 0
	const goodAltitude = options.goodAltitude ?? GOOD_ALTITUDE
	const maximumAirmass = options.maximumAirmass ?? MAXIMUM_AIRMASS
	const factors = [ramp(input.altitude, minimumAltitude, goodAltitude)]

	if (!(input.altitude > 0)) {
		factors.push(0)
	} else {
		const airmass = input.airmass ?? airmassKastenYoung(Math.min(input.altitude, PIOVERTWO))
		factors.push(1 - ramp(airmass, 1, maximumAirmass))
	}

	if (input.sunAltitude !== undefined) factors.push(ramp(input.sunAltitude, NAUTICAL_SUN, ASTRONOMICAL_SUN))
	if (input.moonInterference !== undefined) factors.push(1 - clamp(input.moonInterference, 0, 1))
	if (input.availableDurationHours !== undefined && input.requiredDurationHours !== undefined) {
		factors.push(!(input.requiredDurationHours > 0) ? 1 : clamp(input.availableDurationHours / input.requiredDurationHours, 0, 1))
	}

	const score = geometricMeanOf(factors)
	return options.scale === 100 ? score * 100 : score
}
