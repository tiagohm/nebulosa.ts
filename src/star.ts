import type { Angle } from './angle'
import type { Body } from './astrometry'
import { DAYSPERJY, SPEED_OF_LIGHT_AU_DAY } from './constants'
import type { CartesianCoordinate } from './coordinate'
import { eraPmpx, eraStarpmpv, eraStarpv } from './erfa'
import { subtract, tdb, timeJulian, Timescale, type Time } from './time'
import { dot, minus, mulScalar, plus } from './vector'
import type { Velocity } from './velocity'

const DEFAULT_EPOCH = timeJulian(2000, Timescale.TDB)

export interface Star extends Body {
	readonly position: CartesianCoordinate
	readonly velocity: CartesianCoordinate
}

export function star(ra: Angle, dec: Angle, pmRa: Angle = 0, pmDec: Angle = 0, parallax: Angle = 0, radialVelocity: Velocity = 0, epoch?: Time): Star {
	const pv = eraStarpv(ra, dec, pmRa, pmDec, parallax, radialVelocity)
	const e = epoch ? tdb(epoch) : DEFAULT_EPOCH

	return {
		position: pv[0],
		velocity: pv[1],
		at: (time) => {
			const t = tdb(time)
			return eraStarpmpv(pv, e.day, e.fraction, t.day, t.fraction)
		},
		observedAt: (observer, time) => {
			const t = tdb(time)
			const [opp, opv] = observer.at(t)
			const pmt = subtract(t, e)
			const sp = eraPmpx(ra, dec, pmRa, pmDec, parallax, radialVelocity, pmt / DAYSPERJY, opp)

			// Light-time returned is the projection of vector "op" onto the
			// unit vector "sp", divided by the speed of light.
			const lightTime = dot(sp, opp) / SPEED_OF_LIGHT_AU_DAY
			const vte = mulScalar(pv[1], pmt + lightTime, sp)
			const p = minus(plus(pv[0], vte, vte), opp, vte)
			const v = minus(pv[1], opv)
			return [p, v]
		},
	}
}
