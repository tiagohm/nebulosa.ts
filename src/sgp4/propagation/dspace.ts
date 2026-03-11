import { PI, TAU } from '../../constants'

export interface DspaceOptions {
	readonly irez: number
	readonly d2201: number
	readonly d2211: number
	readonly d3210: number
	readonly d3222: number
	readonly d4410: number
	readonly d4422: number
	readonly d5220: number
	readonly d5232: number
	readonly d5421: number
	readonly d5433: number
	readonly dedt: number
	readonly del1: number
	readonly del2: number
	readonly del3: number
	readonly didt: number
	readonly dmdt: number
	readonly dnodt: number
	readonly domdt: number
	readonly argpo: number
	readonly argpdot: number
	readonly t: number
	readonly tc: number
	readonly gsto: number
	readonly xfact: number
	readonly xlamo: number
	readonly no: number
	readonly atime: number
	readonly em: number
	readonly argpm: number
	readonly inclm: number
	readonly xli: number
	readonly mm: number
	readonly xni: number
	readonly nodem: number
	readonly nm: number
}

// Provides deep space contributions to mean elements for
// perturbing third body. These effects have been averaged over one
// revolution of the sun and moon. For earth resonance effects, the
// effects have been averaged over no revolutions of the satellite.
// author: david vallado 719-573-2600 28 jun 2005
export default function dspace(options: DspaceOptions) {
	const { irez, d2201, d2211, d3210, d3222, d4410, d4422, d5220, d5232, d5421, d5433, dedt, del1, del2, del3, didt, dmdt, dnodt, domdt, argpo, argpdot, t, tc, gsto, xfact, xlamo, no } = options
	let { atime, em, argpm, inclm, xli, mm, xni, nodem, nm } = options

	const fasx2 = 0.13130908
	const fasx4 = 2.8843198
	const fasx6 = 0.37448087
	const g22 = 5.7686396
	const g32 = 0.95240898
	const g44 = 1.8014998
	const g52 = 1.050833
	const g54 = 4.4108898
	const rptim = 4.37526908801129966e-3
	const stepp = 720
	const stepn = -720
	const step2 = 259200

	let delt = 0
	let dndt = 0
	let ft = 0

	// calculate deep space resonance effects
	const theta = (gsto + tc * rptim) % TAU
	em += dedt * t

	inclm += didt * t
	argpm += domdt * t
	nodem += dnodt * t
	mm += dmdt * t

	// sgp4fix for negative inclinations
	if (inclm < 0) {
		inclm = -inclm
		argpm = argpm - PI
		nodem = nodem + PI
	}

	if (irez !== 0) {
		// sgp4fix streamline check
		if (atime === 0 || t * atime <= 0 || Math.abs(t) < Math.abs(atime)) {
			atime = 0
			xni = no
			xli = xlamo
		}

		// sgp4fix move check outside loop
		if (t > 0) {
			delt = stepp
		} else {
			delt = stepn
		}

		let iretn = 381
		let xndt = 0
		let xnddt = 0
		let xldot = 0

		while (iretn === 381) {
			// dot terms calculated
			// near - synchronous resonance terms
			if (irez !== 2) {
				xndt = del1 * Math.sin(xli - fasx2) + del2 * Math.sin(2 * (xli - fasx4)) + del3 * Math.sin(3 * (xli - fasx6))
				xldot = xni + xfact
				xnddt = del1 * Math.cos(xli - fasx2) + 2 * del2 * Math.cos(2 * (xli - fasx4)) + 3 * del3 * Math.cos(3 * (xli - fasx6))
				xnddt *= xldot
			} else {
				//near - half-day resonance terms
				const xomi = argpo + argpdot * atime
				const x2omi = xomi + xomi
				const x2li = xli + xli
				xndt =
					d2201 * Math.sin(x2omi + xli - g22) +
					d2211 * Math.sin(xli - g22) +
					d3210 * Math.sin(xomi + xli - g32) +
					d3222 * Math.sin(-xomi + xli - g32) +
					d4410 * Math.sin(x2omi + x2li - g44) +
					d4422 * Math.sin(x2li - g44) +
					d5220 * Math.sin(xomi + xli - g52) +
					d5232 * Math.sin(-xomi + xli - g52) +
					d5421 * Math.sin(xomi + x2li - g54) +
					d5433 * Math.sin(-xomi + x2li - g54)
				xldot = xni + xfact
				xnddt =
					d2201 * Math.cos(x2omi + xli - g22) +
					d2211 * Math.cos(xli - g22) +
					d3210 * Math.cos(xomi + xli - g32) +
					d3222 * Math.cos(-xomi + xli - g32) +
					d5220 * Math.cos(xomi + xli - g52) +
					d5232 * Math.cos(-xomi + xli - g52) +
					2 * (d4410 * Math.cos(x2omi + x2li - g44) + d4422 * Math.cos(x2li - g44) + d5421 * Math.cos(xomi + x2li - g54) + d5433 * Math.cos(-xomi + x2li - g54))
				xnddt *= xldot
			}

			// integrator
			// sgp4fix move end checks to end of routine
			if (Math.abs(t - atime) >= stepp) {
				iretn = 381
			} else {
				ft = t - atime
				iretn = 0
			}

			if (iretn === 381) {
				xli += xldot * delt + xndt * step2
				xni += xndt * delt + xnddt * step2
				atime += delt
			}
		}

		nm = xni + xndt! * ft + xnddt! * ft * ft * 0.5
		const xl = xli + xldot! * ft + xndt! * ft * ft * 0.5

		if (irez !== 1) {
			mm = xl - 2 * nodem + 2 * theta
			dndt = nm - no
		} else {
			mm = xl - nodem - argpm + theta
			dndt = nm - no
		}

		nm = no + dndt
	}

	return { atime, em, argpm, inclm, xli, mm, xni, nodem, dndt, nm } as const
}
