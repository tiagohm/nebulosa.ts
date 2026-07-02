import { TAU } from '../../core/constants'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { JUPITER_ROTATION, JUPITER_SYSTEM_I, JUPITER_SYSTEM_II, type RotationElements, subObserverPoint } from '../bodies/orientation'
import type { Time } from '../time/time'
import { searchRoots, type TimeSearchOptions } from './search'

// Jupiter central-meridian longitude and Great Red Spot transit prediction, layered on the IAU
// body-orientation model and the time-domain event scanner. The central meridian is the sub-observer
// point projected into one of Jupiter's three conventional rotation systems (I equatorial, II temperate,
// III magnetic); the Great Red Spot sits at a slowly drifting System II longitude and transits the
// central meridian whenever the System II central-meridian longitude sweeps past it. All angles are
// radians.

// Jupiter's rotation system for central-meridian longitude: 'I' (equatorial jet), 'II' (temperate
// latitudes, the Great Red Spot frame) or 'III' (magnetic/radio, the IAU System III).
export type JovianSystem = 'I' | 'II' | 'III'

// Selects the rotation elements for a Jovian system.
function systemElements(system: JovianSystem): RotationElements {
	return system === 'I' ? JUPITER_SYSTEM_I : system === 'II' ? JUPITER_SYSTEM_II : JUPITER_ROTATION
}

// Computes the central-meridian longitude of Jupiter in the given rotation system as seen by an observer.
//
// `jupiterToObserver` is the vector from Jupiter's centre to the observer (AU, ICRF), e.g.
// `earth(t)[0] - jupiter(t)[0]`; its length sets the light-time delay and its direction the sub-observer
// point. The return is the conventional west-positive Jovian longitude of the central meridian, in
// [0, TAU): it increases with time as the planet rotates and matches the System I/II longitudes quoted by
// almanacs (validated against PyEphem to ~0.001 deg). Because the underlying sub-observer point is a
// planetocentric east longitude, this is its complement, TAU - longitude.
export function jupiterCentralMeridian(system: JovianSystem, time: Time, jupiterToObserver: Vec3): Angle {
	return normalizeAngle(TAU - subObserverPoint(systemElements(system), time, jupiterToObserver).longitude)
}

// Predicts the instants the Great Red Spot transits Jupiter's central meridian over a time window.
//
// The Great Red Spot drifts in System II longitude and its position is an observed quantity, so the
// caller supplies its current System II longitude `grsLongitude` (west-positive radians, e.g. from the
// ALPO/JUPOS bulletins); the drift is under ~1 deg per month, so a single value is adequate for a
// prediction window of a few weeks. `jupiterToObserverAt` returns the Jupiter->observer vector (AU, ICRF)
// at a time. A transit occurs when the System II central-meridian longitude equals the spot's longitude
// with the spot on the near side of the planet.
//
// The objective sin(centralMeridian - grsLongitude) is continuous (no 0/TAU seam) and has one zero per
// System II rotation (~9h55m) for the transit and one for the anti-transit half a rotation away; the
// anti-transits, where cos(centralMeridian - grsLongitude) < 0, are discarded. The coarse `step` must
// stay well under half a rotation so consecutive zeros fall in separate brackets; it defaults to the
// scanner's one hour, which is ample.
export function greatRedSpotTransits(grsLongitude: Angle, jupiterToObserverAt: (time: Time) => Vec3, start: Time, stop: Time, options?: TimeSearchOptions): Time[] {
	const crossings = searchRoots((time) => Math.sin(jupiterCentralMeridian('II', time, jupiterToObserverAt(time)) - grsLongitude), start, stop, options)
	// Keep the transits (spot facing the observer); drop the anti-transits on the far side.
	return crossings.filter((time) => Math.cos(jupiterCentralMeridian('II', time, jupiterToObserverAt(time)) - grsLongitude) > 0)
}
