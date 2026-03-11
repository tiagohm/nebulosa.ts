import { PI, TAU } from '../../constants'
import type { SatRec } from './SatRec'

export interface DpperOptions {
	readonly init: 'y' | 'n'
	readonly opsmode: 'a' | 'i'
	readonly ep: number
	readonly inclp: number
	readonly nodep: number
	readonly argpp: number
	readonly mp: number
}

// Provides deep space long period periodic contributions
// to the mean elements. By design, these periodics are zero at epoch.
// this used to be dscom which included initialization, but it's really a
// recurring function.
// author: david vallado 719-573-2600 28 jun 2005
export default function dpper(satrec: SatRec, options: DpperOptions) {
	const { e3, ee2, peo, pgho, pho, pinco, plo, se2, se3, sgh2, sgh3, sgh4, sh2, sh3, si2, si3, sl2, sl3, sl4, t, xgh2, xgh3, xgh4, xh2, xh3, xi2, xi3, xl2, xl3, xl4, zmol, zmos } = satrec
	const { init, opsmode } = options
	let { ep, inclp, nodep, argpp, mp } = options

	// constants
	const zns = 1.19459e-5
	const zes = 0.01675
	const znl = 1.5835218e-4
	const zel = 0.0549

	// calculate time varying periodics
	let zm = zmos + zns * t

	// be sure that the initial call has time set to zero
	if (init === 'y') {
		zm = zmos
	}

	let zf = zm + 2.0 * zes * Math.sin(zm)
	let sinzf = Math.sin(zf)
	let f2 = 0.5 * sinzf * sinzf - 0.25
	let f3 = -0.5 * sinzf * Math.cos(zf)

	const ses = se2 * f2 + se3 * f3
	const sis = si2 * f2 + si3 * f3
	const sls = sl2 * f2 + sl3 * f3 + sl4 * sinzf
	const sghs = sgh2 * f2 + sgh3 * f3 + sgh4 * sinzf
	const shs = sh2 * f2 + sh3 * f3

	zm = zmol + znl * t

	if (init === 'y') {
		zm = zmol
	}

	zf = zm + 2.0 * zel * Math.sin(zm)
	sinzf = Math.sin(zf)
	f2 = 0.5 * sinzf * sinzf - 0.25
	f3 = -0.5 * sinzf * Math.cos(zf)

	const sel = ee2 * f2 + e3 * f3
	const sil = xi2 * f2 + xi3 * f3
	const sll = xl2 * f2 + xl3 * f3 + xl4 * sinzf
	const sghl = xgh2 * f2 + xgh3 * f3 + xgh4 * sinzf
	const shll = xh2 * f2 + xh3 * f3

	let pe = ses + sel
	let pinc = sis + sil
	let pl = sls + sll
	let pgh = sghs + sghl
	let ph = shs + shll

	if (init === 'n') {
		pe -= peo
		pinc -= pinco
		pl -= plo
		pgh -= pgho
		ph -= pho
		inclp += pinc
		ep += pe

		const sinip = Math.sin(inclp)
		const cosip = Math.cos(inclp)

		// apply periodics directly
		// sgp4fix for lyddane choice
		// strn3 used original inclination - this is technically feasible
		// gsfc used perturbed inclination - also technically feasible
		// probably best to readjust the 0.2 limit value and limit discontinuity
		// 0.2 rad = 11.45916 deg
		// use next line for original strn3 approach and original inclination
		// if (inclo >= 0.2)
		// use next line for gsfc version and perturbed inclination
		if (inclp >= 0.2) {
			ph /= sinip
			pgh -= cosip * ph
			argpp += pgh
			nodep += ph
			mp += pl
		} else {
			// apply periodics with lyddane modification
			const sinop = Math.sin(nodep)
			const cosop = Math.cos(nodep)
			let alfdp = sinip * sinop
			let betdp = sinip * cosop
			const dalf = ph * cosop + pinc * cosip * sinop
			const dbet = -ph * sinop + pinc * cosip * cosop
			alfdp += dalf
			betdp += dbet
			nodep %= TAU

			// sgp4fix for afspc written intrinsic functions
			// nodep used without a trigonometric function ahead
			if (nodep < 0 && opsmode === 'a') {
				nodep += TAU
			}

			let xls = mp + argpp + cosip * nodep
			const dls = pl + pgh - pinc * nodep * sinip
			xls += dls
			const xnoh = nodep
			nodep = Math.atan2(alfdp, betdp)

			// sgp4fix for afspc written intrinsic functions
			// nodep used without a trigonometric function ahead
			if (nodep < 0 && opsmode === 'a') {
				nodep += TAU
			}

			if (Math.abs(xnoh - nodep) > PI) {
				if (nodep < xnoh) {
					nodep += TAU
				} else {
					nodep -= TAU
				}
			}

			mp += pl
			argpp = xls - mp - cosip * nodep
		}
	}

	return { ep, inclp, nodep, argpp, mp } as const
}
