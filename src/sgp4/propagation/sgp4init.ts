import { TAU } from '../../constants'
import { earthRadius, J2, J3OJ2, J4, tumin, X2O3 } from '../constants'
import dpper from './dpper'
import dscom from './dscom'
import dsInit from './dsinit'
import initl from './initl'
import type { SatRec, SatRecInit } from './SatRec'
import sgp4 from './sgp4'

export interface Sgp4InitOptions {
	readonly opsmode: 'a' | 'i'
	readonly satn: string
	readonly epoch: number
	readonly xbstar: number
	readonly xecco: number
	readonly xargpo: number
	readonly xinclo: number
	readonly xmo: number
	readonly xno: number
	readonly xnodeo: number
}

// Initializes variables for sgp4.
export default function sgp4init(satrecInit: SatRecInit, options: Sgp4InitOptions): asserts satrecInit is SatRec {
	const { opsmode, satn, epoch, xbstar, xecco, xargpo, xinclo, xmo, xno, xnodeo } = options

	// initialization
	// sgp4fix divisor for divide by zero check on inclination
	// the old check used 1 + Math.cos(pi-1.0e-9), but then compared it to
	// 1.5 e-12, so the threshold was changed to 1.5e-12 for consistency
	const temp4 = 1.5e-12

	const satrec = satrecInit as SatRec

	// set all near earth variables to zero
	satrec.isimp = 0
	satrec.method = 'n'
	satrec.aycof = 0
	satrec.con41 = 0
	satrec.cc1 = 0
	satrec.cc4 = 0
	satrec.cc5 = 0
	satrec.d2 = 0
	satrec.d3 = 0
	satrec.d4 = 0
	satrec.delmo = 0
	satrec.eta = 0
	satrec.argpdot = 0
	satrec.omgcof = 0
	satrec.sinmao = 0
	satrec.t = 0
	satrec.t2cof = 0
	satrec.t3cof = 0
	satrec.t4cof = 0
	satrec.t5cof = 0
	satrec.x1mth2 = 0
	satrec.x7thm1 = 0
	satrec.mdot = 0
	satrec.nodedot = 0
	satrec.xlcof = 0
	satrec.xmcof = 0
	satrec.nodecf = 0

	// set all deep space variables to zero
	satrec.irez = 0
	satrec.d2201 = 0
	satrec.d2211 = 0
	satrec.d3210 = 0
	satrec.d3222 = 0
	satrec.d4410 = 0
	satrec.d4422 = 0
	satrec.d5220 = 0
	satrec.d5232 = 0
	satrec.d5421 = 0
	satrec.d5433 = 0
	satrec.dedt = 0
	satrec.del1 = 0
	satrec.del2 = 0
	satrec.del3 = 0
	satrec.didt = 0
	satrec.dmdt = 0
	satrec.dnodt = 0
	satrec.domdt = 0
	satrec.e3 = 0
	satrec.ee2 = 0
	satrec.peo = 0
	satrec.pgho = 0
	satrec.pho = 0
	satrec.pinco = 0
	satrec.plo = 0
	satrec.se2 = 0
	satrec.se3 = 0
	satrec.sgh2 = 0
	satrec.sgh3 = 0
	satrec.sgh4 = 0
	satrec.sh2 = 0
	satrec.sh3 = 0
	satrec.si2 = 0
	satrec.si3 = 0
	satrec.sl2 = 0
	satrec.sl3 = 0
	satrec.sl4 = 0
	satrec.gsto = 0
	satrec.xfact = 0
	satrec.xgh2 = 0
	satrec.xgh3 = 0
	satrec.xgh4 = 0
	satrec.xh2 = 0
	satrec.xh3 = 0
	satrec.xi2 = 0
	satrec.xi3 = 0
	satrec.xl2 = 0
	satrec.xl3 = 0
	satrec.xl4 = 0
	satrec.xlamo = 0
	satrec.zmol = 0
	satrec.zmos = 0
	satrec.atime = 0
	satrec.xli = 0
	satrec.xni = 0

	// sgp4fix - note the following variables are also passed directly via satrec.
	// it is possible to streamline the sgp4init call by deleting the "x"
	// variables, but the user would need to set the satrec.* values first. we
	// include the additional assignments in case twoline2rv is not used.

	satrec.bstar = xbstar
	satrec.ecco = xecco
	satrec.argpo = xargpo
	satrec.inclo = xinclo
	satrec.mo = xmo
	satrec.no = xno
	satrec.nodeo = xnodeo

	// sgp4fix add opsmode
	satrec.operationmode = opsmode

	// earth constants
	// sgp4fix identify constants and allow alternate values

	const ss = 78 / earthRadius + 1
	// sgp4fix use multiply for speed instead of pow
	const qzms2ttemp = (120 - 78) / earthRadius
	const qzms2t = qzms2ttemp * qzms2ttemp * qzms2ttemp * qzms2ttemp

	satrec.init = 'y'
	satrec.t = 0

	const initlOptions = {
		satn,
		ecco: satrec.ecco,

		epoch,
		inclo: satrec.inclo,
		no: satrec.no,

		method: satrec.method,
		opsmode: satrec.operationmode,
	}

	const initlResult = initl(initlOptions)

	const { ao, con42, cosio, cosio2, eccsq, omeosq, posq, rp, rteosq, sinio } = initlResult

	satrec.no = initlResult.no
	satrec.con41 = initlResult.con41
	satrec.gsto = initlResult.gsto
	satrec.a = (satrec.no * tumin) ** (-2 / 3)
	satrec.alta = satrec.a * (1 + satrec.ecco) - 1
	satrec.altp = satrec.a * (1 - satrec.ecco) - 1
	satrec.error = 0

	if (omeosq >= 0 || satrec.no >= 0) {
		satrec.isimp = 0

		if (rp < 220 / earthRadius + 1) {
			satrec.isimp = 1
		}

		let sfour = ss
		let qzms24 = qzms2t
		const perige = (rp - 1) * earthRadius

		// for perigees below 156 km, s and qoms2t are altered
		if (perige < 156) {
			sfour = perige - 78

			if (perige < 98) {
				sfour = 20
			}

			// sgp4fix use multiply for speed instead of pow
			const qzms24temp = (120 - sfour) / earthRadius
			qzms24 = qzms24temp * qzms24temp * qzms24temp * qzms24temp
			sfour = sfour / earthRadius + 1
		}

		const pinvsq = 1 / posq
		const tsi = 1 / (ao - sfour)
		satrec.eta = ao * satrec.ecco * tsi
		const etasq = satrec.eta * satrec.eta
		const eeta = satrec.ecco * satrec.eta
		const psisq = Math.abs(1 - etasq)
		const coef = qzms24 * tsi ** 4
		const coef1 = coef / psisq ** 3.5
		const cc2 = coef1 * satrec.no * (ao * (1 + 1.5 * etasq + eeta * (4 + etasq)) + ((0.375 * J2 * tsi) / psisq) * satrec.con41 * (8 + 3 * etasq * (8 + etasq)))
		satrec.cc1 = satrec.bstar * cc2
		let cc3 = 0

		if (satrec.ecco > 1e-4) {
			cc3 = (-2 * coef * tsi * J3OJ2 * satrec.no * sinio) / satrec.ecco
		}

		satrec.x1mth2 = 1 - cosio2
		satrec.cc4 = 2 * satrec.no * coef1 * ao * omeosq * (satrec.eta * (2 + 0.5 * etasq) + satrec.ecco * (0.5 + 2 * etasq) - ((J2 * tsi) / (ao * psisq)) * (-3 * satrec.con41 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) + 0.75 * satrec.x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * satrec.argpo)))
		satrec.cc5 = 2 * coef1 * ao * omeosq * (1 + 2.75 * (etasq + eeta) + eeta * etasq)
		const cosio4 = cosio2 * cosio2
		const temp1 = 1.5 * J2 * pinvsq * satrec.no
		const temp2 = 0.5 * temp1 * J2 * pinvsq
		const temp3 = -0.46875 * J4 * pinvsq * pinvsq * satrec.no
		satrec.mdot = satrec.no + 0.5 * temp1 * rteosq * satrec.con41 + 0.0625 * temp2 * rteosq * (13 - 78 * cosio2 + 137 * cosio4)
		satrec.argpdot = -0.5 * temp1 * con42 + 0.0625 * temp2 * (7 - 114 * cosio2 + 395 * cosio4) + temp3 * (3 - 36 * cosio2 + 49 * cosio4)
		const xhdot1 = -temp1 * cosio
		satrec.nodedot = xhdot1 + (0.5 * temp2 * (4 - 19 * cosio2) + 2 * temp3 * (3 - 7 * cosio2)) * cosio
		const xpidot = satrec.argpdot + satrec.nodedot
		satrec.omgcof = satrec.bstar * cc3 * Math.cos(satrec.argpo)
		satrec.xmcof = 0

		if (satrec.ecco > 1e-4) {
			satrec.xmcof = (-X2O3 * coef * satrec.bstar) / eeta
		}

		satrec.nodecf = 3.5 * omeosq * xhdot1 * satrec.cc1
		satrec.t2cof = 1.5 * satrec.cc1

		// sgp4fix for divide by zero with xinco = 180 deg
		if (Math.abs(cosio + 1) > 1.5e-12) {
			satrec.xlcof = (-0.25 * J3OJ2 * sinio * (3 + 5 * cosio)) / (1 + cosio)
		} else {
			satrec.xlcof = (-0.25 * J3OJ2 * sinio * (3 + 5 * cosio)) / temp4
		}

		satrec.aycof = -0.5 * J3OJ2 * sinio

		// sgp4fix use multiply for speed instead of pow
		const delmotemp = 1 + satrec.eta * Math.cos(satrec.mo)
		satrec.delmo = delmotemp * delmotemp * delmotemp
		satrec.sinmao = Math.sin(satrec.mo)
		satrec.x7thm1 = 7 * cosio2 - 1.0

		// deep space initialization
		if (TAU / satrec.no >= 225) {
			satrec.method = 'd'
			satrec.isimp = 1
			const inclm = satrec.inclo

			const dscomOptions = {
				epoch,
				ep: satrec.ecco,
				argpp: satrec.argpo,
				tc: 0,
				inclp: satrec.inclo,
				nodep: satrec.nodeo,

				np: satrec.no,

				e3: satrec.e3,
				ee2: satrec.ee2,

				peo: satrec.peo,
				pgho: satrec.pgho,
				pho: satrec.pho,
				pinco: satrec.pinco,

				plo: satrec.plo,
				se2: satrec.se2,
				se3: satrec.se3,

				sgh2: satrec.sgh2,
				sgh3: satrec.sgh3,
				sgh4: satrec.sgh4,

				sh2: satrec.sh2,
				sh3: satrec.sh3,
				si2: satrec.si2,
				si3: satrec.si3,

				sl2: satrec.sl2,
				sl3: satrec.sl3,
				sl4: satrec.sl4,

				xgh2: satrec.xgh2,
				xgh3: satrec.xgh3,
				xgh4: satrec.xgh4,
				xh2: satrec.xh2,

				xh3: satrec.xh3,
				xi2: satrec.xi2,
				xi3: satrec.xi3,
				xl2: satrec.xl2,

				xl3: satrec.xl3,
				xl4: satrec.xl4,

				zmol: satrec.zmol,
				zmos: satrec.zmos,
			}

			const dscomResult = dscom(dscomOptions)

			satrec.e3 = dscomResult.e3
			satrec.ee2 = dscomResult.ee2

			satrec.peo = dscomResult.peo
			satrec.pgho = dscomResult.pgho
			satrec.pho = dscomResult.pho

			satrec.pinco = dscomResult.pinco
			satrec.plo = dscomResult.plo
			satrec.se2 = dscomResult.se2
			satrec.se3 = dscomResult.se3

			satrec.sgh2 = dscomResult.sgh2
			satrec.sgh3 = dscomResult.sgh3
			satrec.sgh4 = dscomResult.sgh4
			satrec.sh2 = dscomResult.sh2
			satrec.sh3 = dscomResult.sh3

			satrec.si2 = dscomResult.si2
			satrec.si3 = dscomResult.si3
			satrec.sl2 = dscomResult.sl2
			satrec.sl3 = dscomResult.sl3
			satrec.sl4 = dscomResult.sl4

			const { sinim, cosim, em, emsq, s1, s2, s3, s4, s5, ss1, ss2, ss3, ss4, ss5, sz1, sz3, sz11, sz13, sz21, sz23, sz31, sz33 } = dscomResult

			satrec.xgh2 = dscomResult.xgh2
			satrec.xgh3 = dscomResult.xgh3
			satrec.xgh4 = dscomResult.xgh4
			satrec.xh2 = dscomResult.xh2
			satrec.xh3 = dscomResult.xh3
			satrec.xi2 = dscomResult.xi2
			satrec.xi3 = dscomResult.xi3
			satrec.xl2 = dscomResult.xl2
			satrec.xl3 = dscomResult.xl3
			satrec.xl4 = dscomResult.xl4
			satrec.zmol = dscomResult.zmol
			satrec.zmos = dscomResult.zmos

			const { nm, z1, z3, z11, z13, z21, z23, z31, z33 } = dscomResult

			const dpperOptions = {
				inclo: inclm,
				init: satrec.init,
				ep: satrec.ecco,
				inclp: satrec.inclo,
				nodep: satrec.nodeo,
				argpp: satrec.argpo,
				mp: satrec.mo,
				opsmode: satrec.operationmode,
			}

			const dpperResult = dpper(satrec, dpperOptions)

			satrec.ecco = dpperResult.ep
			satrec.inclo = dpperResult.inclp
			satrec.nodeo = dpperResult.nodep
			satrec.argpo = dpperResult.argpp
			satrec.mo = dpperResult.mp

			const dsinitOptions = {
				cosim,
				emsq,
				argpo: satrec.argpo,
				s1: s1!,
				s2: s2!,
				s3: s3!,
				s4: s4!,
				s5: s5!,
				sinim: sinim!,
				ss1: ss1!,
				ss2: ss2!,
				ss3: ss3!,
				ss4: ss4!,
				ss5: ss5!,
				sz1: sz1!,
				sz3: sz3!,
				sz11: sz11!,
				sz13: sz13!,
				sz21: sz21!,
				sz23: sz23!,
				sz31: sz31!,
				sz33: sz33!,
				t: satrec.t,
				tc: 0,
				gsto: satrec.gsto,
				mo: satrec.mo,
				mdot: satrec.mdot,
				no: satrec.no,
				nodeo: satrec.nodeo,
				nodedot: satrec.nodedot,
				xpidot: xpidot!,
				z1: z1!,
				z3: z3!,
				z11: z11!,
				z13: z13!,
				z21: z21!,
				z23: z23!,
				z31: z31!,
				z33: z33!,
				ecco: satrec.ecco,
				eccsq,
				em,
				argpm: 0,
				inclm,
				mm: 0,
				nm,
				nodem: 0,
				irez: satrec.irez,
				atime: satrec.atime,
				d2201: satrec.d2201,
				d2211: satrec.d2211,
				d3210: satrec.d3210,
				d3222: satrec.d3222,
				d4410: satrec.d4410,
				d4422: satrec.d4422,
				d5220: satrec.d5220,
				d5232: satrec.d5232,
				d5421: satrec.d5421,
				d5433: satrec.d5433,
				dedt: satrec.dedt,
				didt: satrec.didt,
				dmdt: satrec.dmdt,
				dnodt: satrec.dnodt,
				domdt: satrec.domdt,
				del1: satrec.del1,
				del2: satrec.del2,
				del3: satrec.del3,
				xfact: satrec.xfact,
				xlamo: satrec.xlamo,
				xli: satrec.xli,
				xni: satrec.xni,
			}

			const dsinitResult = dsInit(dsinitOptions)

			satrec.irez = dsinitResult.irez
			satrec.atime = dsinitResult.atime
			satrec.d2201 = dsinitResult.d2201
			satrec.d2211 = dsinitResult.d2211

			satrec.d3210 = dsinitResult.d3210
			satrec.d3222 = dsinitResult.d3222
			satrec.d4410 = dsinitResult.d4410
			satrec.d4422 = dsinitResult.d4422
			satrec.d5220 = dsinitResult.d5220

			satrec.d5232 = dsinitResult.d5232
			satrec.d5421 = dsinitResult.d5421
			satrec.d5433 = dsinitResult.d5433
			satrec.dedt = dsinitResult.dedt
			satrec.didt = dsinitResult.didt

			satrec.dmdt = dsinitResult.dmdt
			satrec.dnodt = dsinitResult.dnodt
			satrec.domdt = dsinitResult.domdt
			satrec.del1 = dsinitResult.del1

			satrec.del2 = dsinitResult.del2
			satrec.del3 = dsinitResult.del3
			satrec.xfact = dsinitResult.xfact
			satrec.xlamo = dsinitResult.xlamo
			satrec.xli = dsinitResult.xli

			satrec.xni = dsinitResult.xni
		}

		// set variables if not deep space
		if (satrec.isimp !== 1) {
			const cc1sq = satrec.cc1 * satrec.cc1
			satrec.d2 = 4 * ao * tsi * cc1sq
			const temp = (satrec.d2 * tsi * satrec.cc1) / 3.0
			satrec.d3 = (17 * ao + sfour) * temp
			satrec.d4 = 0.5 * temp * ao * tsi * (221 * ao + 31 * sfour) * satrec.cc1
			satrec.t3cof = satrec.d2 + 2 * cc1sq
			satrec.t4cof = 0.25 * (3 * satrec.d3 + satrec.cc1 * (12 * satrec.d2 + 10 * cc1sq))
			satrec.t5cof = 0.2 * (3 * satrec.d4 + 12 * satrec.cc1 * satrec.d3 + 6 * satrec.d2 * satrec.d2 + 15 * cc1sq * (2 * satrec.d2 + cc1sq))
		}
	}

	sgp4(satrec, 0)

	satrec.init = 'n'
}
