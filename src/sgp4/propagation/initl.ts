import { TAU } from '../../constants'
import { greenwichMeanSiderealTime } from '../../time'
import { J2, X2O3, XKE } from '../constants'

export interface InitlOptions {
	opsmode: 'a' | 'i'
	ecco: number
	epoch: number
	inclo: number
	no: number
}

// Initializes the sgp4 propagator. all the initialization is
// consolidated here instead of having multiple loops inside other routines.
// author: david vallado 719-573-2600 28 jun 2005
export default function initl(options: InitlOptions) {
	const { ecco, epoch, inclo, opsmode } = options
	let { no } = options

	// earth constants
	const eccsq = ecco * ecco
	const omeosq = 1 - eccsq
	const rteosq = Math.sqrt(omeosq)
	const cosio = Math.cos(inclo)
	const cosio2 = cosio * cosio

	// un-kozai the mean motion
	const ak = (XKE / no) ** X2O3
	const d1 = (0.75 * J2 * (3 * cosio2 - 1)) / (rteosq * omeosq)
	let delPrime = d1 / (ak * ak)
	const adel = ak * (1 - delPrime * delPrime - delPrime * (1 / 3 + (134 * delPrime * delPrime) / 81))
	delPrime = d1 / (adel * adel)
	no /= 1 + delPrime

	const ao = (XKE / no) ** X2O3
	const sinio = Math.sin(inclo)
	const po = ao * omeosq
	const con42 = 1 - 5 * cosio2
	const con41 = -con42 - cosio2 - cosio2
	const ainv = 1 / ao
	const posq = po * po
	const rp = ao * (1 - ecco)
	const method = 'n'

	// sgp4fix modern approach to finding sidereal time
	let gsto = 0

	if (opsmode === 'a') {
		// sgp4fix use old way of finding gst
		// count integer number of days from 0 jan 1970
		const ts70 = epoch - 7305
		const ds70 = Math.floor(ts70 + 1e-8)
		const tfrac = ts70 - ds70

		// find greenwich location at epoch
		const c1 = 1.72027916940703639e-2
		const thgr70 = 1.7321343856509374
		const fk5r = 5.07551419432269442e-15
		const c1p2p = c1 + TAU
		gsto = (thgr70 + c1 * ds70 + c1p2p * tfrac + ts70 * ts70 * fk5r) % TAU

		if (gsto < 0) {
			gsto += TAU
		}
	} else {
		gsto = greenwichMeanSiderealTime({ day: epoch + 2433281, fraction: 0.5, scale: 1 })
	}

	return {
		no,

		method,

		ainv,
		ao,
		con41,
		con42,
		cosio,

		cosio2,
		eccsq,
		omeosq,
		posq,

		rp,
		rteosq,
		sinio,
		gsto,
	}
}
