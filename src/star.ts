import type { Mutable } from 'utility-types'
import { type Angle, normalizeAngle } from './angle'
import { DEFAULT_REFRACTION_PARAMETERS, type Observed, type PositionAndVelocity, type RefractionParameters } from './astrometry'
import { PIOVERTWO } from './constants'
import { eraApco13, eraAtciq, eraAtioq, eraStarpmpv, eraStarpv } from './erfa'
import { ELLIPSOID_PARAMETERS } from './location'
import { pmAngles, type Time, Timescale, timeJulianYear, tt, ut1 } from './time'
import type { Vec3 } from './vec3'
import type { Velocity } from './velocity'

const DEFAULT_EPOCH = timeJulianYear(2000, Timescale.TDB)

export interface Star {
	readonly rightAscension: Angle
	readonly declination: Angle
	readonly pmRa: Angle
	readonly pmDec: Angle
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
export function star(ra: Angle, dec: Angle, pmRa: Angle = 0, pmDec: Angle = 0, parallax: Angle = 0, rv: Velocity = 0, epoch: Time = DEFAULT_EPOCH): StarPositionAndVelocity {
	const s = eraStarpv(ra, dec, pmRa, pmDec, parallax, rv) as unknown as Mutable<StarPositionAndVelocity>
	s.rightAscension = ra
	s.declination = dec
	s.pmRa = pmRa
	s.pmDec = pmDec
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

export function observeStar<T extends Star | StarPositionAndVelocity>(star: T, time: Time, ebpv: readonly [Vec3, Vec3], ehp: Vec3 = ebpv[0], refraction?: RefractionParameters | false): ObservedStar<T> {
	const a = tt(time)
	const b = ut1(time)
	const { longitude, latitude, elevation, ellipsoid } = time.location!
	const [sp, xp, yp] = pmAngles(time)
	const { radius, flattening } = ELLIPSOID_PARAMETERS[ellipsoid]

	// First set up the astrometry context for ICRS<->observed
	const pressure = refraction === false ? 0 : (refraction?.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
	const temperature = refraction === false ? 0 : (refraction?.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
	const relativeHumidity = refraction === false ? 0 : (refraction?.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
	const wl = refraction === false ? 0 : (refraction?.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)
	const astrom = eraApco13(a.day, a.fraction, b.day, b.fraction, longitude, latitude, elevation, xp, yp, sp, pressure, temperature, relativeHumidity, wl, ebpv, ehp, radius, flattening)

	// Convert to topocentric CIRS
	const [ri, di] = eraAtciq(star.rightAscension, star.declination, star.pmRa, star.pmDec, star.parallax, star.rv, astrom)

	// Now perform observed conversion
	const [azimuth, zenith, hourAngle, rightAscensionCIO, declination] = eraAtioq(normalizeAngle(ri), di, astrom)
	return { star, azimuth, altitude: PIOVERTWO - zenith, hourAngle, declination, rightAscensionCIO, rightAscension: normalizeAngle(rightAscensionCIO + astrom.eo) } as const
}
