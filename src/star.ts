import { type Angle } from './angle'
import { distance, type PositionAndVelocity } from './astrometry'
import { DAYSEC, DAYSPERJY, LIGHT_TIME_AU, SPEED_OF_LIGHT_AU_DAY } from './constants'
import { eraAb, eraLdSun, eraPmpx, eraStarpmpv, eraStarpv } from './erfa'
import { subtract, tdb, timeJulian, Timescale, type Time } from './time'
import { divScalar } from './vector'
import type { Velocity } from './velocity'

const DEFAULT_EPOCH = timeJulian(2000, Timescale.TDB)

export type Star = PositionAndVelocity & {
	ra: Angle
	dec: Angle
	pmRa: Angle
	pmDec: Angle
	parallax: Angle
	radialVelocity: Velocity
	epoch?: Time
}

export function star(ra: Angle, dec: Angle, pmRa: Angle = 0, pmDec: Angle = 0, parallax: Angle = 0, radialVelocity: Velocity = 0, epoch?: Time): Star {
	const pv = eraStarpv(ra, dec, pmRa, pmDec, parallax, radialVelocity)
	const s = pv as unknown as Star
	s.ra = ra
	s.dec = dec
	s.pmRa = pmRa
	s.pmDec = pmDec
	s.parallax = parallax
	s.radialVelocity = radialVelocity
	s.epoch = epoch
	return s
}

// Calculate the BCSR position of a star at a specific time.
export function at(star: Star, time: Time) {
	const t = tdb(time)
	const e = star.epoch ? tdb(star.epoch) : DEFAULT_EPOCH
	return eraStarpmpv(star, e.day, e.fraction, t.day, t.fraction)
}

// Calculate the GCRS position of a star at a specific time given observer's barycentric position and velocity.
export function observedAt(star: Star, time: Time, opv: PositionAndVelocity) {
	const t = tdb(time)
	const e = star.epoch ? tdb(star.epoch) : DEFAULT_EPOCH
	const pmt = subtract(t, e)

	// Proper motion and parallax, giving BCRS coordinate direction.
	const pco = eraPmpx(star.ra, star.dec, star.pmRa, star.pmDec, star.parallax, star.radialVelocity, pmt / DAYSPERJY, opv[0])

	// Light deflection, giving BCRS natural direction.
	const em = distance(opv[0])
	const pnat = eraLdSun(pco, divScalar(opv[0], em), em)

	// Aberration, giving GCRS proper direction.
	let v2 = 0

	for (let i = 0; i < 3; i++) {
		const w = opv[1][i] * (LIGHT_TIME_AU / DAYSEC)
		v2 += w * w
	}

	return eraAb(pnat, divScalar(opv[1], SPEED_OF_LIGHT_AU_DAY), em, Math.sqrt(1 - v2))
}
