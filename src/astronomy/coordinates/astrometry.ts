import { AU_M, DAYSEC, ELLIPSOID_PARAMETERS, PIOVERTWO, SPEED_OF_LIGHT } from '../../core/constants'
import { type MutVec3, type Vec3, vecAngle, vecLength } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { Pressure } from '../../math/units/pressure'
import type { Temperature } from '../../math/units/temperature'
import type { GeographicCoordinate } from '../observer/location'
import { pmAngles, type Time, tt, ut1 } from '../time/time'
import type { CartesianCoordinate, EquatorialCoordinate, SphericalCoordinate } from './coordinate'
import { type EraAstrom, eraApci13, eraApco13, eraApio13, eraAtciqz, eraAticq, eraAtioq, eraAtoiq, eraC2s, eraP2s, eraRefco } from './erfa/erfa'

// High-level astrometric place transforms built on the ERFA "apc/atio" pipeline: ICRS<->CIRS,
// CIRS<->observed (azimuth/altitude), and ICRS->observed, plus the scalar helpers (distance,
// light time, equatorial coordinates, parallactic angle, angular separation, and atmospheric
// refraction). Positions are AU and angles are radians unless noted; refraction uses pressure
// in hPa and temperature in Celsius. The observed transforms require an EOP-aware Time and an
// observing location, and share ERFA's bounded refraction model so forward/inverse round trips
// stay consistent.

// Barycentric/heliocentric position (AU) and velocity (AU/day) pair, in ICRS/BCRS axes.
export type PositionAndVelocity = [MutVec3, MutVec3]

// Sampler returning the position and velocity of a body at the given time.
export type PositionAndVelocityOverTime = (time: Time) => PositionAndVelocity

// Atmospheric conditions feeding the refraction model. All fields are optional;
// missing fields fall back to DEFAULT_REFRACTION_PARAMETERS.
export interface RefractionParameters {
	// Ambient pressure at the observer, in millibar (hPa). Zero disables refraction.
	pressure?: Pressure
	// Ambient temperature at the observer, in degrees Celsius.
	temperature?: Temperature
	// Relative humidity as a fraction in 0..1.
	relativeHumidity?: number
	// Effective observing wavelength, in micrometers.
	wl?: number
}

// Observed (topocentric) place of a source, combining horizontal and equatorial angles.
export interface Observed extends Readonly<EquatorialCoordinate> {
	// Azimuth measured from north through east, in radians (0..TAU).
	readonly azimuth: Angle
	// Altitude above the horizon, in radians (negative below the horizon).
	readonly altitude: Angle
	// Local hour angle of the source, in radians.
	readonly hourAngle: Angle
	// Equation of the origins (CIRS-to-equinox offset), in radians.
	readonly equationOfOrigins: Angle
}

// Standard temperature and pressure defaults for refraction, plus mid humidity and
// visible wavelength. Pressure in hPa, temperature in Celsius, wavelength in micrometers.
// https://en.wikipedia.org/wiki/Standard_temperature_and_pressure
export const DEFAULT_REFRACTION_PARAMETERS: Readonly<Required<RefractionParameters>> = {
	pressure: 1013.25,
	temperature: 15,
	relativeHumidity: 0.5,
	wl: 0.55,
}

// Length of position component in AU.
export function distance(p: CartesianCoordinate): Distance {
	return vecLength(p)
}

// Length of position component in days of light travel time.
export function lightTime(p: CartesianCoordinate) {
	return distance(p) * (AU_M / SPEED_OF_LIGHT / DAYSEC)
}

// Computes the equatorial coordinates.
export function equatorial(p: CartesianCoordinate): SphericalCoordinate {
	return eraP2s(...p)
}

// Computes the deviation between zenith angle and north angle.
export function parallacticAngle(ha: Angle, dec: Angle, latitude: Angle): Angle {
	// A rare condition! Object exactly in zenith, avoid undefined result.
	return ha === 0 && dec - latitude === 0 ? 0 : Math.atan2(Math.sin(ha), Math.tan(latitude) * Math.cos(dec) - Math.sin(dec) * Math.cos(ha))
}

// Computes the angle between two positions.
export function separationFrom(a: CartesianCoordinate, b: CartesianCoordinate): Angle {
	return vecAngle(a, b)
}

// Computes the relative position (AU) and velocity (AU/day) of a target body with
// respect to an origin body, both sampled at the same time. This is the geometric
// difference target - origin in the shared BCRS/ICRS axes, with no light-time or
// aberration correction, suitable for forming heliocentric states (origin = Sun),
// geocentric states (origin = Earth) or any body-to-body vector. The returned
// vectors are freshly allocated; pass the resulting position to icrsToObserved or
// equatorial as needed.
export function relativePositionAndVelocity(target: PositionAndVelocityOverTime, origin: PositionAndVelocityOverTime, time: Time): PositionAndVelocity {
	const [tp, tv] = target(time)
	const [op, ov] = origin(time)
	return [
		[tp[0] - op[0], tp[1] - op[1], tp[2] - op[2]],
		[tv[0] - ov[0], tv[1] - ov[1], tv[2] - ov[2]],
	]
}

// Computes the phase angle of a body: the Sun-body-observer angle measured at the
// body, in radians (0 at "full" illumination, PI at "new"). All three positions
// are given in the same frame and origin (typically barycentric AU); the result
// only depends on the directions from the body toward the Sun and toward the
// observer, so any common origin and any consistent length unit work.
export function phaseAngle(body: CartesianCoordinate, sun: CartesianCoordinate, observer: CartesianCoordinate): Angle {
	const toSun: Vec3 = [sun[0] - body[0], sun[1] - body[1], sun[2] - body[2]]
	const toObserver: Vec3 = [observer[0] - body[0], observer[1] - body[1], observer[2] - body[2]]
	return vecAngle(toSun, toObserver)
}

// Computes CIRS coordinates from ICRS cartesian/spherical coordinates (assuming zero parallax and proper motion).
export function icrsToCirs(icrs: Vec3 | readonly [Angle, Angle], time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], astrom?: EraAstrom) {
	const a = tt(time)

	astrom ??= eraApci13(a.day, a.fraction, ebpv, ehp)

	const [rc, dc] = icrs.length === 2 ? icrs : eraC2s(...icrs)
	return eraAtciqz(rc, dc, astrom)
}

// Computes ICRS coordinates from CIRS cartesian/spherical coordinates.
export function cirsToIcrs(cirs: Vec3 | readonly [Angle, Angle], time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], astrom?: EraAstrom) {
	const a = tt(time)

	astrom ??= eraApci13(a.day, a.fraction, ebpv, ehp)

	const [rc, dc] = cirs.length === 2 ? cirs : eraC2s(...cirs)
	return eraAticq(rc, dc, astrom)
}

// Computes observed coordinates from CIRS cartesian/spherical coordinates.
export function cirsToObserved(cirs: Vec3 | readonly [Angle, Angle], time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicCoordinate = time.location!, astrom?: EraAstrom): Observed {
	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = location
		const [sp, xp, yp] = pmAngles(time)
		const pressure = refraction === false ? 0 : (refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
		const temperature = refraction === false ? 0 : (refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
		const relativeHumidity = refraction === false ? 0 : (refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
		const wl = refraction === false ? 0 : (refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)

		// First set up the astrometry context for ICRS<->observed
		astrom = eraApio13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl)
	}

	const [ri, di] = cirs.length === 2 ? cirs : eraC2s(...cirs)

	// Now perform observed conversion
	const [azimuth, zenith, hourAngle, rightAscension, declination] = eraAtioq(normalizeAngle(ri), di, astrom)
	return { azimuth, altitude: PIOVERTWO - zenith, hourAngle, declination, rightAscension, equationOfOrigins: astrom.eo } as const
}

// Computes CIRS coordinates from observed coordinates.
export function observedToCirs(azimuth: Angle, altitude: Angle, time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicCoordinate = time.location!, astrom?: EraAstrom): readonly [Angle, Angle] {
	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = location
		const [sp, xp, yp] = pmAngles(time)
		const pressure = refraction === false ? 0 : (refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
		const temperature = refraction === false ? 0 : (refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
		const relativeHumidity = refraction === false ? 0 : (refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
		const wl = refraction === false ? 0 : (refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)

		// First set up the astrometry context for observed<->CIRS
		astrom = eraApio13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl)
	}

	return eraAtoiq('A', azimuth, PIOVERTWO - altitude, astrom)
}

export function icrsToObserved(icrs: Vec3 | readonly [Angle, Angle], time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicCoordinate = time.location!, astrom?: EraAstrom): Observed {
	if (!astrom) {
		const a = tt(time)
		const b = ut1(time)
		const { longitude, latitude, elevation } = location
		const [sp, xp, yp] = pmAngles(time)
		const pressure = refraction === false ? 0 : (refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
		const temperature = refraction === false ? 0 : (refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
		const relativeHumidity = refraction === false ? 0 : (refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
		const wl = refraction === false ? 0 : (refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)
		const { radius, flattening } = ELLIPSOID_PARAMETERS[time.location!.ellipsoid]

		// First set up the astrometry context for observed<->CIRS
		astrom = eraApco13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl, ebpv, ehp, radius, flattening)
	}

	// Convert to topocentric CIRS
	const [ri, di] = eraAtciqz(...(icrs.length === 2 ? icrs : eraC2s(...icrs)), astrom)

	// Now perform observed conversion
	const [azimuth, zenith, hourAngle, rightAscension, declination] = eraAtioq(normalizeAngle(ri), di, astrom)
	return { azimuth, altitude: PIOVERTWO - zenith, hourAngle, rightAscension, declination, equationOfOrigins: astrom.eo } as const
}

// Computes the apparent (refracted) altitude from the geometric (true) altitude.
// `altitude` is the true altitude in radians; the returned value is the larger,
// apparent altitude, in radians.
//
// Applies exactly the refraction model ERFA uses in the observed-place transform
// (eraAtioq): from the refraction constants A, B (eraRefco) it forms the bounded,
// Newton-corrected deflection
//   dZ = (A + w)*tanZ / (1 + (A + 3w)/cosZ^2),  w = B*tan^2(Z),  Z = true zenith distance
// with cosZ floored at 0.05 (Z <= ~87 deg). The raw A*tanZ + B*tan^3(Z) polynomial
// has a negative cubic term that makes it non-monotonic and unbounded past
// Z ~= 80 deg; this bounded form instead stays finite and well-behaved down to the
// horizon (refraction is capped near the horizon, as in ERFA). Because it shares
// ERFA's model, it is the consistent inverse of observedToCirs/cirsToObserved, so
// pole and altitude round trips do not drift.
//
// Below the horizon (altitude < 0) the model is not applied and the input is
// returned unchanged.
export function refractedAltitude(altitude: Angle, refraction?: RefractionParameters): Angle {
	if (altitude < 0) return altitude

	const pressure = refraction?.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure
	const temperature = refraction?.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature
	const relativeHumidity = refraction?.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity
	const wl = refraction?.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl
	const [refa, refb] = eraRefco(pressure, temperature, relativeHumidity, wl)

	const zd = PIOVERTWO - altitude
	// sin and (floored) cos of the true zenith distance; flooring cos at 0.05 caps
	// the refraction near the horizon exactly as eraAtioq does (Z <= ~87 deg).
	const r = Math.max(1e-6, Math.sin(zd))
	const z = Math.max(0.05, Math.cos(zd))
	const tz = r / z
	const w = refb * tz * tz
	const del = ((refa + w) * tz) / (1 + (refa + 3 * w) / (z * z))
	return altitude + del
}
