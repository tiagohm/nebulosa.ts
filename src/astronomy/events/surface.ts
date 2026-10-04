import { ONE_SECOND } from '../../core/constants'
import { vecDot, vecNormalizeMut, vecZero } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import type { Angle } from '../../math/units/angle'
import type { PositionOverTime } from '../coordinates/astrometry'
import { frameAt } from '../coordinates/frame'
import { type BodySurfaceLocation, bodySurfaceNormal } from '../observer/body'
import { type Time, timeShift } from '../time/time'
import { searchRoots, type TimeSearchOptions } from './search'

// Solar illumination on rotating tri-axial reference surfaces. Locations have east-positive
// planetocentric longitude; the local vertical is the reference ellipsoid normal. Angles are
// radians, with no terrain, relief, refraction, or finite solar disk. The explicit body-center-to-Sun
// direction is treated as parallel across the body, so finite-distance surface parallax is omitted.

// A solar-center crossing of a body-surface reference horizon.
export interface BodySurfaceSunEvent {
	// Refined epoch of the crossing.
	readonly time: Time
	// Rising or falling local solar altitude; tangential touches are omitted.
	readonly kind: 'sunrise' | 'sunset'
	// Resolved solar-center altitude above the ellipsoid tangent plane, radians.
	readonly altitude: Angle
}

// Surface horizon and time-scanner controls.
export interface BodySurfaceSunOptions extends TimeSearchOptions {
	// Solar-center altitude in radians that defines sunrise/set; defaults to zero.
	readonly horizon?: Angle
}

// Builds a sampler with one normal and reusable direction workspace for a fixed location.
// sunAt is body-center-to-Sun in library-base axes; it may reuse its output buffer.
function solarAltitudeAt(location: BodySurfaceLocation, sunAt: PositionOverTime) {
	const normal = bodySurfaceNormal(location)
	const direction = vecZero()
	return (time: Time) => {
		frameAt(sunAt(time), location.frame, time, direction)
		return Math.asin(clamp(vecDot(normal, vecNormalizeMut(direction)), -1, 1))
	}
}

// Solar-center altitude in radians at time on a location fixed to its rotating body frame.
// sunAt supplies the body-center-to-Sun direction in library-base axes. Uses a normalized reference
// ellipsoid normal, ignoring terrain, relief, refraction, solar radius and surface parallax.
export function bodySurfaceSolarAltitude(location: BodySurfaceLocation, sunAt: PositionOverTime, time: Time): Angle {
	return solarAltitudeAt(location, sunAt)(time)
}

// Finds chronological sunrise/set crossings inside start/stop at options.horizon (radians).
// sunAt supplies body-center-to-Sun base-frame directions. Uses searchRoots with caller step and
// tolerance; steps must resolve crossings. The local slope across one second (or twice tolerance,
// whichever is greater) classifies each root, requiring providers just beyond window boundaries.
// Tangential touches are omitted. One normal and vector workspace are reused throughout the scan.
export function bodySurfaceSunEvents(location: BodySurfaceLocation, sunAt: PositionOverTime, start: Time, stop: Time, { horizon = 0, ...options }: BodySurfaceSunOptions = {}): BodySurfaceSunEvent[] {
	const altitudeAt = solarAltitudeAt(location, sunAt)
	const events: BodySurfaceSunEvent[] = []
	const halfStep = Math.max(ONE_SECOND, 2 * (options.tolerance ?? 1e-6))
	for (const time of searchRoots((epoch) => altitudeAt(epoch) - horizon, start, stop, options)) {
		const before = altitudeAt(timeShift(time, -halfStep)) - horizon
		const after = altitudeAt(timeShift(time, halfStep)) - horizon
		if (before < 0 && after > 0) events.push({ time, kind: 'sunrise', altitude: altitudeAt(time) })
		else if (before > 0 && after < 0) events.push({ time, kind: 'sunset', altitude: altitudeAt(time) })
	}
	return events
}
