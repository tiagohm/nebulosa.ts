import { PI, TAU } from '../../constants'
import { X2O3, XKE } from '../constants'

export interface DsInitOptions {
	readonly cosim: number
	readonly emsq: number
	readonly argpo: number
	readonly s1: number
	readonly s2: number
	readonly s3: number
	readonly s4: number
	readonly s5: number
	readonly sinim: number
	readonly ss1: number
	readonly ss2: number
	readonly ss3: number
	readonly ss4: number
	readonly ss5: number
	readonly sz1: number
	readonly sz3: number
	readonly sz11: number
	readonly sz13: number
	readonly sz21: number
	readonly sz23: number
	readonly sz31: number
	readonly sz33: number
	readonly t: number
	readonly tc: number
	readonly gsto: number
	readonly mo: number
	readonly mdot: number
	readonly no: number
	readonly nodeo: number
	readonly nodedot: number
	readonly xpidot: number
	readonly z1: number
	readonly z3: number
	readonly z11: number
	readonly z13: number
	readonly z21: number
	readonly z23: number
	readonly z31: number
	readonly z33: number
	readonly ecco: number
	readonly eccsq: number
	readonly em: number
	readonly argpm: number
	readonly inclm: number
	readonly mm: number
	readonly nm: number
	readonly nodem: number
	readonly irez: number
	readonly atime: number
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
	readonly didt: number
	readonly dmdt: number
	readonly dnodt: number
	readonly domdt: number
	readonly del1: number
	readonly del2: number
	readonly del3: number
	readonly xfact: number
	readonly xlamo: number
	readonly xli: number
	readonly xni: number
}

// Provides deep space contributions to mean motion dot dueto geopotential resonance with half day and one day orbits.
// author: david vallado 719-573-2600 28 jun 2005
export default function dsInit(options: DsInitOptions) {
	const { cosim, argpo, s1, s2, s3, s4, s5, sinim, ss1, ss2, ss3, ss4, ss5, sz1, sz3, sz11, sz13, sz21, sz23, sz31, sz33, t, tc, gsto, mo, mdot, no, nodeo, nodedot, xpidot, z1, z3, z11, z13, z21, z23, z31, z33, ecco, eccsq } = options
	let { emsq, em, argpm, inclm, mm, nm, nodem, atime, d2201, d2211, d3210, d3222, d4410, d4422, d5220, d5232, d5421, d5433, dedt, didt, dmdt, dnodt, domdt, del1, del2, del3, xfact, xlamo, xli, xni } = options

	const q22 = 1.7891679e-6
	const q31 = 2.1460748e-6
	const q33 = 2.2123015e-7
	const root22 = 1.7891679e-6
	const root44 = 7.3636953e-9
	const root54 = 2.1765803e-9
	const rptim = 4.37526908801129966e-3
	const root32 = 3.7393792e-7
	const root52 = 1.1428639e-7
	const znl = 1.5835218e-4
	const zns = 1.19459e-5

	// deep space initialization
	let irez = 0

	if (nm < 0.0052359877 && nm > 0.0034906585) {
		irez = 1
	}
	if (nm >= 8.26e-3 && nm <= 9.24e-3 && em >= 0.5) {
		irez = 2
	}

	// do solar terms
	const ses = ss1 * zns * ss5
	const sis = ss2 * zns * (sz11 + sz13)
	const sls = -zns * ss3 * (sz1 + sz3 - 14 - 6 * emsq)
	const sghs = ss4 * zns * (sz31 + sz33 - 6.0)
	let shs = -zns * ss2 * (sz21 + sz23)

	// sgp4fix for 180 deg incl
	if (inclm < 5.2359877e-2 || inclm > PI - 5.2359877e-2) {
		shs = 0
	}

	if (sinim !== 0) {
		shs /= sinim
	}

	const sgs = sghs - cosim * shs

	// do lunar terms
	dedt = ses + s1 * znl * s5
	didt = sis + s2 * znl * (z11 + z13)
	dmdt = sls - znl * s3 * (z1 + z3 - 14 - 6 * emsq)
	const sghl = s4 * znl * (z31 + z33 - 6.0)
	let shll = -znl * s2 * (z21 + z23)

	// sgp4fix for 180 deg incl
	if (inclm < 5.2359877e-2 || inclm > PI - 5.2359877e-2) {
		shll = 0
	}

	domdt = sgs + sghl
	dnodt = shs

	if (sinim !== 0) {
		domdt -= (cosim / sinim) * shll
		dnodt += shll / sinim
	}

	// calculate deep space resonance effects
	const dndt = 0
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

	let g211 = 0
	let g310 = 0
	let g322 = 0
	let g410 = 0
	let g422 = 0
	let g520 = 0
	let g521 = 0
	let g532 = 0
	let g533 = 0

	// initialize the resonance terms
	if (irez !== 0) {
		const aonv = (nm / XKE) ** X2O3

		// geopotential resonance for 12 hour orbits
		if (irez === 2) {
			const cosisq = cosim * cosim
			const emo = em
			em = ecco
			const emsqo = emsq
			emsq = eccsq
			const eoc = em * emsq
			const g201 = -0.306 - (em - 0.64) * 0.44

			if (em <= 0.65) {
				g211 = 3.616 - 13.247 * em + 16.29 * emsq
				g310 = -19.302 + 117.39 * em - 228.419 * emsq + 156.591 * eoc
				g322 = -18.9068 + 109.7927 * em - 214.6334 * emsq + 146.5816 * eoc
				g410 = -41.122 + 242.694 * em - 471.094 * emsq + 313.953 * eoc
				g422 = -146.407 + 841.88 * em - 1629.014 * emsq + 1083.435 * eoc
				g520 = -532.114 + 3017.977 * em - 5740.032 * emsq + 3708.276 * eoc
			} else {
				g211 = -72.099 + 331.819 * em - 508.738 * emsq + 266.724 * eoc
				g310 = -346.844 + 1582.851 * em - 2415.925 * emsq + 1246.113 * eoc
				g322 = -342.585 + 1554.908 * em - 2366.899 * emsq + 1215.972 * eoc
				g410 = -1052.797 + 4758.686 * em - 7193.992 * emsq + 3651.957 * eoc
				g422 = -3581.69 + 16178.11 * em - 24462.77 * emsq + 12422.52 * eoc

				if (em > 0.715) {
					g520 = -5149.66 + 29936.92 * em - 54087.36 * emsq + 31324.56 * eoc
				} else {
					g520 = 1464.74 - 4664.75 * em + 3763.64 * emsq
				}
			}
			if (em < 0.7) {
				g533 = -919.2277 + 4988.61 * em - 9064.77 * emsq + 5542.21 * eoc
				g521 = -822.71072 + 4568.6173 * em - 8491.4146 * emsq + 5337.524 * eoc
				g532 = -853.666 + 4690.25 * em - 8624.77 * emsq + 5341.4 * eoc
			} else {
				g533 = -37995.78 + 161616.52 * em - 229838.2 * emsq + 109377.94 * eoc
				g521 = -51752.104 + 218913.95 * em - 309468.16 * emsq + 146349.42 * eoc
				g532 = -40023.88 + 170470.89 * em - 242699.48 * emsq + 115605.82 * eoc
			}

			const sini2 = sinim * sinim
			const f220 = 0.75 * (1 + 2 * cosim + cosisq)
			const f221 = 1.5 * sini2
			const f321 = 1.875 * sinim * (1 - 2 * cosim - 3 * cosisq)
			const f322 = -1.875 * sinim * (1 + 2 * cosim - 3 * cosisq)
			const f441 = 35 * sini2 * f220
			const f442 = 39.375 * sini2 * sini2

			const f522 = 9.84375 * sinim * (sini2 * (1 - 2 * cosim - 5 * cosisq) + 0.33333333 * (-2 + 4 * cosim + 6 * cosisq))
			const f523 = sinim * (4.92187512 * sini2 * (-2 - 4 * cosim + 10 * cosisq) + 6.56250012 * (1 + 2 * cosim - 3 * cosisq))
			const f542 = 29.53125 * sinim * (2 - 8 * cosim + cosisq * (-12 + 8 * cosim + 10 * cosisq))
			const f543 = 29.53125 * sinim * (-2 - 8 * cosim + cosisq * (12 + 8 * cosim - 10 * cosisq))

			const xno2 = nm * nm
			const ainv2 = aonv * aonv
			let temp1 = 3 * xno2 * ainv2
			let temp = temp1 * root22
			d2201 = temp * f220 * g201
			d2211 = temp * f221 * g211
			temp1 *= aonv
			temp = temp1 * root32
			d3210 = temp * f321 * g310
			d3222 = temp * f322 * g322
			temp1 *= aonv
			temp = 2 * temp1 * root44
			d4410 = temp * f441 * g410
			d4422 = temp * f442 * g422
			temp1 *= aonv
			temp = temp1 * root52
			d5220 = temp * f522 * g520
			d5232 = temp * f523 * g532
			temp = 2 * temp1 * root54
			d5421 = temp * f542 * g521
			d5433 = temp * f543 * g533
			xlamo = (mo + nodeo + nodeo - (theta + theta)) % TAU
			xfact = mdot + dmdt + 2 * (nodedot + dnodt - rptim) - no
			em = emo
			emsq = emsqo
		}

		// synchronous resonance terms
		if (irez === 1) {
			const g200 = 1 + emsq * (-2.5 + 0.8125 * emsq)
			const g310 = 1 + 2 * emsq
			const g300 = 1 + emsq * (-6 + 6.60937 * emsq)
			const f220 = 0.75 * (1 + cosim) * (1 + cosim)
			const f311 = 0.9375 * sinim * sinim * (1 + 3 * cosim) - 0.75 * (1 + cosim)
			let f330 = 1 + cosim
			f330 *= 1.875 * (f330 * f330)
			del1 = 3 * nm * nm * aonv * aonv
			del2 = 2 * del1 * f220 * g200 * q22
			del3 = 3 * del1 * f330 * g300 * q33 * aonv
			del1 = del1 * f311 * g310 * q31 * aonv
			xlamo = (mo + nodeo + argpo - theta) % TAU
			xfact = mdot + xpidot + dmdt + domdt + dnodt - (no + rptim)
		}

		// for sgp4, initialize the integrator
		xli = xlamo
		xni = no
		atime = 0
		nm = no + dndt
	}

	return {
		em,
		argpm,
		inclm,
		mm,
		nm,
		nodem,

		irez,
		atime,

		d2201,
		d2211,
		d3210,
		d3222,
		d4410,

		d4422,
		d5220,
		d5232,
		d5421,
		d5433,

		dedt,
		didt,
		dmdt,
		dndt,
		dnodt,
		domdt,

		del1,
		del2,
		del3,

		xfact,
		xlamo,
		xli,
		xni,
	} as const
}
