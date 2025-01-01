import type { Angle } from './angle'
import type { Body } from './astrometry'
import { SPEED_OF_LIGHT_AU_DAY } from './constants'
import { eraStarpmpv, eraStarpv } from './erfa'
import { tdb, timeJulian, Timescale, type Time } from './time'
import { dot, minus, mulScalar, normalize, plus } from './vector'
import type { Velocity } from './velocity'

const DEFAULT_EPOCH = timeJulian(2000, Timescale.TDB)

export function star(ra: Angle, dec: Angle, pmRa: Angle = 0, pmDec: Angle = 0, parallax: Angle = 0, radialVelocity: Velocity = 0, epoch?: Time): Body {
	const pv = eraStarpv(ra, dec, pmRa, pmDec, parallax, radialVelocity)
	const e = epoch ? tdb(epoch) : DEFAULT_EPOCH

	return {
		position: pv[0],
		// velocity: pv[1],
		at: (time) => {
			const t = tdb(time)
			const ret = eraStarpmpv(pv, e.day, e.fraction, t.day, t.fraction)

			if (ret) {
				return ret[0]
			} else {
				const vte = mulScalar(pv[1], t.day - e.day + t.fraction - e.fraction)
				return plus(pv[0], vte, vte)
			}
		},
		observedAt: (observer, time) => {
			const t = tdb(time)
			// Form unit vector 'u1' in direction of star.
			const u1 = normalize(pv[0])
			// Light-time returned is the projection of vector "pos_obs" onto the
			// unit vector "u1", divided by the speed of light.
			const lightTime = dot(u1, observer) / SPEED_OF_LIGHT_AU_DAY
			const vte = mulScalar(pv[1], t.day - e.day + lightTime + t.fraction - e.fraction, u1)
			return minus(plus(pv[0], vte, vte), observer, vte)
		},
	}
}
