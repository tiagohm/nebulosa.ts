import { ANGVEL, DAYSEC, SPEED_OF_LIGHT_AU_DAY } from '../../core/constants'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecCross, vecDot, vecPlus } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Velocity } from '../../math/units/velocity'
import type { GeographicPosition } from '../observer/location'
import { gcrsToItrsRotationMatrix, type Time } from '../time/time'
import type { PositionAndVelocity } from './astrometry'
import { eraS2c } from './erfa/erfa'
import { itrs } from './itrs'

// Observer-state and time/velocity corrections for precise timing and spectroscopy: the observer's
// barycentric/heliocentric position and velocity (adding the topocentric offset and diurnal rotation
// when a location is given), the radial-velocity correction projected onto a source direction, and the
// light-travel-time correction for barycentric/heliocentric date (BJD/HJD). Positions are AU, velocities
// AU/day, in ICRS/BCRS axes. The corrections are first-order (Newtonian), not fully relativistic.

// Earth's nominal rotation rate in rad/day (ANGVEL is rad/s).
const ANGVEL_PER_DAY = ANGVEL * DAYSEC

// Computes the observer position (AU) and velocity (AU/day) in BCRS/ICRS axes,
// referred to the solar-system barycenter ('barycentric') or the Sun's center
// ('heliocentric').
//
// When `location` is provided the observer's topocentric offset and diurnal
// rotation are added; when omitted the geocenter is used (no diurnal term),
// matching the location-less behavior of Astropy.
//
//   pos = earthPos + R^T * r_itrs                 (topocentric offset in GCRS)
//   vel = earthVel + (R^T * omega_itrs) x (R^T * r_itrs)
//
// where R = `gcrsToItrsRotationMatrix` maps GCRS->ITRS, so R^T maps ITRS->GCRS,
// and omega_itrs ~ (0, 0, ANGVEL_PER_DAY) is the Earth rotation vector in ITRS.
// Returns freshly allocated vectors; the input `time` cache is not mutated.
export function observerState(time: Time, earth: PositionAndVelocity, location: GeographicPosition | undefined = time.location): readonly [pos: Vec3, vel: Vec3] {
	if (!location) return earth

	const r = gcrsToItrsRotationMatrix(time)
	// Observer offset and Earth rotation vector, rotated from ITRS into GCRS.
	const rGcrs = matTransposeMulVec(r, itrs(location))
	const omegaGcrs = matTransposeMulVec(r, [0, 0, ANGVEL_PER_DAY] as MutVec3)
	const diurnal = vecCross(omegaGcrs, rGcrs)

	return [vecPlus(earth[0], rGcrs), vecPlus(earth[1], diurnal)]
}

// Computes the barycentric/heliocentric radial-velocity correction (AU/day)
// toward an ICRS direction.
//
// The returned value is the velocity to ADD to a measured topocentric radial
// velocity so it is referred to the chosen reference center:
//   rvReferred = rvTopocentric + radialVelocityCorrection(...)
// A positive result means the observer is moving toward the source, so the
// topocentric measurement is blueshifted relative to the referred one.
//
// `ra`/`dec` are the ICRS source direction in radians; `location` is the
// observing site (omit for a geocentric correction without the diurnal term).
//
// This is the first-order (Newtonian) projection of the observer velocity onto
// the line of sight, rv = vObs . nHat, accurate to the cm/s level for the
// combined annual and diurnal terms. A fully relativistic variant would also
// require the source's own velocity and is intentionally not modeled here.
export function radialVelocityCorrection(ra: Angle, dec: Angle, time: Time, earth: PositionAndVelocity, location: GeographicPosition | undefined = time.location): Velocity {
	const n = eraS2c(ra, dec)
	const [, vel] = observerState(time, earth, location)
	return vecDot(vel, n)
}

// Computes the light-travel-time correction (in days) to ADD to an observed time
// so it is referred to the solar-system barycenter ('barycentric') or the Sun's
// center ('heliocentric'):
//   timeReferred = timeShift(tdb(time), lightTravelTime(...))
//
//   ltt = (rObs . nHat) / c
//
// `rObs` is the observer's referred position (AU), `nHat` the ICRS unit vector
// toward the source, and c is in AU/day; the result is positive when the
// observer lies on the same side as the source, so light reaches it before the
// reference center.
//
// `ra`/`dec` are the ICRS source direction in radians; `location` is the
// observing site (omit for a geocentric correction). Accuracy is limited
// earth position and velocity, well within typical BJD/HJD requirements.
export function lightTravelTime(ra: Angle, dec: Angle, time: Time, earth: PositionAndVelocity, location: GeographicPosition | undefined = time.location): number {
	const n = eraS2c(ra, dec)
	const [pos] = observerState(time, earth, location)
	return vecDot(pos, n) / SPEED_OF_LIGHT_AU_DAY
}
