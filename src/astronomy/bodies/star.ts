import { ELLIPSOID_PARAMETERS, PIOVERTWO } from '../../core/constants'
import type { Writable } from '../../core/types'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Velocity } from '../../math/units/velocity'
import { DEFAULT_REFRACTION_PARAMETERS, type Observed, type PositionAndVelocity, type RefractionParameters } from '../coordinates/astrometry'
import type { EquatorialCoordinate } from '../coordinates/coordinate'
import { eraAtco13, eraStarpm, eraStarpmpv, eraStarpv } from '../coordinates/erfa/erfa'
import { pmAngles, type Time, Timescale, timeJulianYear, tt, ut1 } from '../time/time'

const DEFAULT_EPOCH = timeJulianYear(2000, Timescale.TDB)

// J2000.0 expressed on the TT scale. `eraAtco13` measures its internal
// proper-motion baseline (astrom.pmt) from J2000.0, so a star whose catalog
// epoch differs from J2000.0 must first be propagated to this reference.
const J2000_TT = tt(DEFAULT_EPOCH)

export interface Star extends Readonly<EquatorialCoordinate> {
	readonly pmRA: Angle
	readonly pmDEC: Angle
	readonly parallax: Angle
	readonly rv: Velocity
}

export type StarPositionAndVelocity = (Star & PositionAndVelocity) & {
	readonly epoch: Time
}

export interface ObservedStar<T extends Star | StarPositionAndVelocity> extends Observed {
	readonly star: T
}

// Computes the BCRS position and velocity of a star.
export function star(ra: Angle, dec: Angle, pmRA: Angle = 0, pmDEC: Angle = 0, parallax: Angle = 0, rv: Velocity = 0, epoch: Time = DEFAULT_EPOCH): StarPositionAndVelocity {
	const s = eraStarpv(ra, dec, pmRA, pmDEC, parallax, rv) as unknown as Writable<StarPositionAndVelocity>
	s.rightAscension = ra
	s.declination = dec
	s.pmRA = pmRA
	s.pmDEC = pmDEC
	s.parallax = parallax
	s.rv = rv
	s.epoch = epoch
	return s
}

// Computes the BCRS position and velocity of a star at time applying space motion.
export function spaceMotion(star: StarPositionAndVelocity, time: Time): PositionAndVelocity {
	// Use TT instead of TDB for speed without any significant impact on accuracy
	const e = tt(star.epoch)
	const a = tt(time)
	const p = eraStarpmpv(star, e.day, e.fraction, a.day, a.fraction)
	return [p, star[1]]
}

// Computes the observed place (azimuth/altitude, hour angle, apparent RA/Dec)
// of a star for the given time and Earth ephemeris.
// `ebpv` is the barycentric position+velocity of the Earth (AU, AU/day) and
// `ehp` its heliocentric position (AU). `refraction` selects the atmospheric
// model: `false` disables refraction, `undefined` uses the default parameters.
// The catalog data is assumed to be referenced to J2000.0; a star carrying a
// different epoch is propagated to J2000.0 first so the internal proper-motion
// baseline stays consistent.
export function observeStar<T extends Star | StarPositionAndVelocity>(star: T, time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], refraction?: RefractionParameters | false): ObservedStar<T> {
	if (!time.location) throw new Error('time.location is required')
	const a = tt(time)
	const b = ut1(time)
	const { longitude, latitude, elevation, ellipsoid } = time.location
	const [sp, xp, yp] = pmAngles(time)
	const { radius, flattening } = ELLIPSOID_PARAMETERS[ellipsoid]

	// eraAtco13 expects the catalog referenced to J2000.0. When the star carries
	// a different epoch, propagate its catalog data (position, proper motion,
	// parallax, radial velocity) to J2000.0 before the transform; otherwise the
	// proper motion would be applied over the wrong interval.
	let { rightAscension, declination, pmRA, pmDEC, parallax, rv } = star
	if ('epoch' in star && star.epoch !== DEFAULT_EPOCH) {
		const e = tt(star.epoch)
		const pm = eraStarpm(rightAscension, declination, pmRA, pmDEC, parallax, rv, e.day, e.fraction, J2000_TT.day, J2000_TT.fraction)
		if (pm) [rightAscension, declination, pmRA, pmDEC, parallax, rv] = pm
	}

	// First set up the astrometry context for ICRS<->observed
	const pressure = refraction === false ? 0 : (refraction?.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
	const temperature = refraction === false ? 0 : (refraction?.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
	const relativeHumidity = refraction === false ? 0 : (refraction?.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
	const wl = refraction === false ? 0 : (refraction?.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)

	const [azimuth, zenith, hourAngle, observedRA, observedDEC, astrom] = eraAtco13(a.day, a.fraction, b.day, b.fraction, rightAscension, declination, pmRA, pmDEC, parallax, rv, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl, ebpv, ehp, radius, flattening)

	return { star, azimuth, altitude: PIOVERTWO - zenith, hourAngle, declination: observedDEC, rightAscension: observedRA, equationOfOrigins: astrom.eo } as const
}
