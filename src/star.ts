import type { Mutable } from 'utility-types'
import type { Angle } from './angle'
import type { PositionAndVelocity } from './astrometry'
import { eraStarpmpv, eraStarpv } from './erfa'
import { type Time, Timescale, tdb, timeJulian } from './time'
import type { Velocity } from './velocity'

const DEFAULT_EPOCH = timeJulian(2000, Timescale.TDB)

export type Star = PositionAndVelocity & {
	readonly ra: Angle
	readonly dec: Angle
	readonly pmRa: Angle
	readonly pmDec: Angle
	readonly parallax: Angle
	readonly radialVelocity: Velocity
	readonly epoch: Time
}

export type Barycentric = PositionAndVelocity & {
	readonly star: Star
}

// Compute the ICRS position and velocity of a star.
export function star(ra: Angle, dec: Angle, pmRa: Angle = 0, pmDec: Angle = 0, parallax: Angle = 0, radialVelocity: Velocity = 0, epoch?: Time): Star {
	const s = eraStarpv(ra, dec, pmRa, pmDec, parallax, radialVelocity) as unknown as Mutable<Star>
	s.ra = ra
	s.dec = dec
	s.pmRa = pmRa
	s.pmDec = pmDec
	s.parallax = parallax
	s.radialVelocity = radialVelocity
	s.epoch = epoch ?? DEFAULT_EPOCH
	return s
}

// Compute the BCRS position and velocity of a star.
export function bcrs(star: Star, time: Time): Barycentric {
	const e = tdb(star.epoch)
	const a = tdb(time)
	const p = eraStarpmpv(star, e.day, e.fraction, a.day, a.fraction)
	const b = [p, star[1]] as unknown as Mutable<Barycentric>
	b.star = star
	return b
}
