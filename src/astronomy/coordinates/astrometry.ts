import { AU_M, DAYSEC, ELLIPSOID_PARAMETERS, PIOVERTWO, SPEED_OF_LIGHT } from '../../core/constants'
import { type MutVec3, type Vec3, vecAngle, vecLength } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { Pressure } from '../../math/units/pressure'
import type { Temperature } from '../../math/units/temperature'
import type { Velocity } from '../../math/units/velocity'
import type { GeographicCoordinate } from '../observer/location'
import { pmAngles, type Time, timeShift, tt, ut1 } from '../time/time'
import type { CartesianCoordinate, EquatorialCoordinate, SphericalCoordinate } from './coordinate'
import { type EraAstrom, eraApci13, eraApco13, eraApio13, eraAtciqz, eraAticq, eraAtioq, eraAtoiq, eraC2s, eraEo06a, eraP2s, eraRefco } from './erfa/erfa'
import { frameAt, type Frame } from './frame'

// High-level astrometric place transforms built on the ERFA "apc/atio" pipeline: ICRS<->CIRS,
// CIRS<->observed (azimuth/altitude), and ICRS->observed, plus the scalar helpers (distance,
// light time, equatorial coordinates, parallactic angle, angular separation, atmospheric
// refraction, and analytic spherical coordinates with rates). Positions are AU, velocities
// AU/day, and angles radians unless noted; refraction uses pressure in hPa and temperature in
// Celsius. The observed transforms require an EOP-aware Time and an observing location, and
// share ERFA's bounded refraction model so forward/inverse round trips stay consistent.

// Barycentric/heliocentric position (AU) and velocity (AU/day) pair, in ICRS/BCRS axes.
export type PositionAndVelocity = [MutVec3, MutVec3]

// Sampler returning the position and velocity of a body at the given time.
export type PositionAndVelocityOverTime = (time: Time) => PositionAndVelocity

// A fixed-point light-time solution at reception time. All vectors are owned
// snapshots in BCRS/ICRS axes: positions AU, velocity AU/day, and light time days.
export interface LightTimeSolution {
	// Reception epoch at the observer.
	readonly time: Time
	// Retarded epoch inferred from the final observer-to-target vector.
	readonly emissionTime: Time
	// Observer barycentric position at reception, in AU.
	readonly observerPosition: Vec3
	// Observer barycentric velocity at reception, in AU/day.
	readonly observerVelocity: Vec3
	// Target barycentric position from the last emission-epoch sample, in AU.
	readonly targetEmissionPosition: Vec3
	// Target minus observer vector from the last sample, in AU.
	readonly position: Vec3
	// Length of position, in AU.
	readonly distance: Distance
	// One-way light time for the final distance, in days.
	readonly lightTime: number
}

// Default number of fixed-point refinements for finite-distance targets.
export const DEFAULT_LIGHT_TIME_ITERATIONS = 3

// Inclusive iteration cap; 16 refinements exceed normal solar-system needs.
export const MAX_LIGHT_TIME_ITERATIONS = 16

// Validates the bounded fixed-point work budget before sampling providers.
// Non-integers would silently change loop count; infinity can hang the loop.
export function validateLightTimeIterations(iterations: number): void {
	if (!Number.isSafeInteger(iterations) || !(iterations >= 0 && iterations <= MAX_LIGHT_TIME_ITERATIONS)) {
		throw new Error(`lightTimeIterations must be an integer in [0, ${MAX_LIGHT_TIME_ITERATIONS}]`)
	}
}

// Spherical coordinates and first derivatives of a Cartesian position+velocity state,
// expressed in whatever frame that state is already written in. Angular rates are
// omitted at an exact Cartesian pole, where the spherical chart is singular.
export interface SphericalPositionAndVelocity {
	// Longitude around the frame z-axis, in radians, normalized to [0, TAU).
	readonly longitude: Angle
	// Latitude above the frame xy-plane, in radians, in [-PI/2, PI/2].
	readonly latitude: Angle
	// Radial distance from the origin, in AU.
	readonly distance: Distance
	// d(longitude)/dt, in radians/day. Absent when x = y = 0, where longitude is singular.
	readonly longitudeRate?: number
	// d(latitude)/dt, in radians/day. Absent when x = y = 0, where the spherical chart is singular.
	readonly latitudeRate?: number
	// Radial speed, in AU/day. Positive when distance is increasing.
	readonly radialVelocity: Velocity
}

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

// Converts a Cartesian position (AU) and velocity (AU/day) already expressed in the
// desired frame into spherical longitude, latitude, distance, and their analytic
// first derivatives. Returns undefined for the zero position, which has no sky
// direction. At an exact Cartesian pole (x = y = 0, z ≠ 0) longitude uses the
// conventional atan2(0, 0) value 0 and both angular rates are omitted; near a pole
// the true (possibly large) longitude rate is returned rather than clipped.
export function sphericalPositionAndVelocity(pv: readonly [Vec3, Vec3]): SphericalPositionAndVelocity | undefined {
	const [x, y, z] = pv[0]
	const [vx, vy, vz] = pv[1]
	const rho2 = x * x + y * y
	const r2 = rho2 + z * z
	if (!(r2 > 0)) return undefined

	const R = Math.sqrt(r2)
	const rho = Math.sqrt(rho2)
	const xyDotV = x * vx + y * vy

	return {
		longitude: normalizeAngle(Math.atan2(y, x)),
		latitude: Math.atan2(z, rho),
		distance: R,
		longitudeRate: rho2 > 0 ? (x * vy - y * vx) / rho2 : undefined,
		latitudeRate: rho2 > 0 ? (rho2 * vz - z * xyDotV) / (r2 * rho) : undefined,
		radialVelocity: (xyDotV + z * vz) / R,
	}
}

// Transforms the full Cartesian state into `frame` at `time`, then converts the
// result with sphericalPositionAndVelocity. The frame rotation (including any
// rotating-frame drag term W = dR/dt·Rᵀ) is applied before the spherical rates
// are formed, so an ITRS-rest state has near-zero Earth-fixed angular rates.
// Pass `out` to reuse a transformed-state workspace; it may alias `pv`.
export function frameSphericalPositionAndVelocity(pv: readonly [Vec3, Vec3], frame: Frame, time: Time, out?: PositionAndVelocity): SphericalPositionAndVelocity | undefined {
	return sphericalPositionAndVelocity(frameAt(pv, frame, time, out))
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

// Topocentric direction from the observer to a body at reception time `time`, light-time corrected.
//
// The observer is sampled at `time` (reception); the body is sampled at the retarded emission time
// `time - tau`, where tau is the light travel time over the current observer-body distance, refined by
// `iterations` fixed-point steps (0 leaves the geometric, uncorrected direction). `target` and `observer`
// must share one origin (typically barycentric ICRS); the common origin cancels in the difference. Returns a
// freshly allocated non-unit vector whose length is the topocentric distance in AU. Aberration is not applied
// (it nearly cancels in the differential geometry of two bodies close on the sky, e.g. an occultation or
// transit), so this is a geometric line of sight, not an apparent place.
// Iterations must be an integer in [0, 16]; a coincident target returns the zero vector.
export function topocentricDirection(target: PositionAndVelocityOverTime, observer: PositionAndVelocityOverTime, time: Time, iterations: number): Vec3 {
	return lightTimeSolution(target, observer, time, iterations)?.position ?? [0, 0, 0]
}

// Solves retarded target geometry by sampling the observer once at reception and
// the target at emission, then refining emission by the current one-way light time.
// Performs iterations + 1 target samples, matching topocentricDirection's historical
// fixed-point semantics. Returns undefined for coincident observer and target.
// The target-emission snapshot is from the final sample; emissionTime is based on
// the final vector, which may differ slightly from that sample's input epoch.
export function lightTimeSolution(target: PositionAndVelocityOverTime, observer: PositionAndVelocityOverTime, time: Time, iterations: number): LightTimeSolution | undefined {
	validateLightTimeIterations(iterations)
	const [observerPosition, observerVelocity] = observer(time)
	const [ox, oy, oz] = observerPosition
	const [ovx, ovy, ovz] = observerVelocity
	let emission = time
	let px = 0
	let py = 0
	let pz = 0
	let tx = 0
	let ty = 0
	let tz = 0
	for (let k = 0; k <= iterations; k++) {
		const targetPosition = target(emission)[0]
		tx = targetPosition[0]
		ty = targetPosition[1]
		tz = targetPosition[2]
		px = tx - ox
		py = ty - oy
		pz = tz - oz
		emission = timeShift(time, -lightTime([px, py, pz]))
	}
	const position: Vec3 = [px, py, pz]
	const distance = vecLength(position)
	if (!(distance > 0)) return undefined
	const tau = lightTime(position)
	return {
		time,
		emissionTime: timeShift(time, -tau),
		observerPosition: [ox, oy, oz],
		observerVelocity: [ovx, ovy, ovz],
		targetEmissionPosition: [tx, ty, tz],
		position,
		distance,
		lightTime: tau,
	}
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
		// eraApio13 never writes the CIRS-to-equinox equation of the origins.
		astrom.eo = eraEo06a(a.day, a.fraction)
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
		const { radius, flattening } = ELLIPSOID_PARAMETERS[time.location?.ellipsoid ?? 3]

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
// Z ~= 80 deg; this bounded form instead stays finite and well-behaved down to and
// below the horizon (refraction is capped near the horizon, as in ERFA, including
// when the true altitude is negative). Because it shares ERFA's model, it is the
// consistent inverse of observedToCirs/cirsToObserved, so pole and altitude round
// trips do not drift. An object still slightly below the geometric horizon can
// therefore have a positive apparent altitude, as at sunrise and sunset.
export function refractedAltitude(altitude: Angle, refraction?: RefractionParameters): Angle {
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

// Computes the geometric (true) altitude from the apparent (refracted) altitude,
// in radians; the inverse of refractedAltitude using the same ERFA-consistent
// bounded refraction model. Refraction lifts an object, so the returned true
// altitude is the smaller value. The model is monotonic and slowly varying, so a
// few fixed-point iterations (true <- apparent - refraction(true)) converge to
// the level where refractedAltitude(unrefractedAltitude(a)) round-trips back to
// `apparentAltitude`. Apparent altitudes just above the horizon invert to a
// negative true altitude, matching eraAtioq's capped refraction below Z = 90 deg.
export function unrefractedAltitude(apparentAltitude: Angle, refraction?: RefractionParameters): Angle {
	let trueAltitude = apparentAltitude
	for (let i = 0; i < 4; i++) {
		// refractedAltitude(trueAltitude) - trueAltitude is the refraction at that level.
		trueAltitude = apparentAltitude - (refractedAltitude(trueAltitude, refraction) - trueAltitude)
	}

	return trueAltitude
}
