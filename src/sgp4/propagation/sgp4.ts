import { PI, TAU } from '../../constants'
import { earthRadius, J2, J3OJ2, vkmpersec, X2O3, XKE } from '../constants'

import dpper from './dpper'
import dspace from './dspace'
import { type SatRec, SatRecError } from './SatRec'

// The sgp4 prediction model from space command. This is an
// updated and combined version of sgp4 and sdp4, which were originally
// published separately in spacetrack report //3. This version follows the
// methodology from the aiaa paper (2006) describing the history and
// development of the code.
// author: david vallado 719-573-2600 28 jun 2005
export default function sgp4(satrec: SatRec, tsince: number) {
	// set mathematical constants
	// sgp4fix divisor for divide by zero check on inclination
	// the old check used 1.0 + cos(pi-1.0e-9), but then compared it to
	// 1.5 e-12, so the threshold was changed to 1.5e-12 for consistency
	const temp4 = 1.5e-12

	// clear sgp4 error flag
	satrec.t = tsince
	satrec.error = SatRecError.None

	// update for secular gravity and atmospheric drag
	const xmdf = satrec.mo + satrec.mdot * satrec.t
	const argpdf = satrec.argpo + satrec.argpdot * satrec.t
	const nodedf = satrec.nodeo + satrec.nodedot * satrec.t
	let argpm = argpdf
	let mm = xmdf
	const t2 = satrec.t * satrec.t
	let nodem = nodedf + satrec.nodecf * t2
	let tempa = 1.0 - satrec.cc1 * satrec.t
	let tempe = satrec.bstar * satrec.cc4 * satrec.t
	let templ = satrec.t2cof * t2

	if (satrec.isimp !== 1) {
		const delomg = satrec.omgcof * satrec.t
		// sgp4fix use mutliply for speed instead of pow
		const delmtemp = 1.0 + satrec.eta * Math.cos(xmdf)
		const delm = satrec.xmcof * (delmtemp * delmtemp * delmtemp - satrec.delmo)
		const temp = delomg + delm
		mm = xmdf + temp
		argpm = argpdf - temp
		const t3 = t2 * satrec.t
		const t4 = t3 * satrec.t
		tempa = tempa - satrec.d2 * t2 - satrec.d3 * t3 - satrec.d4 * t4
		tempe += satrec.bstar * satrec.cc5 * (Math.sin(mm) - satrec.sinmao)
		templ = templ + satrec.t3cof * t3 + t4 * (satrec.t4cof + satrec.t * satrec.t5cof)
	}

	let nm = satrec.no
	let em = satrec.ecco
	let inclm = satrec.inclo

	if (satrec.method === 'd') {
		const dspaceOptions = {
			irez: satrec.irez,
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
			del1: satrec.del1,
			del2: satrec.del2,
			del3: satrec.del3,
			didt: satrec.didt,
			dmdt: satrec.dmdt,
			dnodt: satrec.dnodt,
			domdt: satrec.domdt,
			argpo: satrec.argpo,
			argpdot: satrec.argpdot,
			t: satrec.t,
			tc: satrec.t,
			gsto: satrec.gsto,
			xfact: satrec.xfact,
			xlamo: satrec.xlamo,
			no: satrec.no,
			atime: satrec.atime,
			em,
			argpm,
			inclm,
			xli: satrec.xli,
			mm,
			xni: satrec.xni,
			nodem,
			nm,
		}

		const dspaceResult = dspace(dspaceOptions)

		;({ em, argpm, inclm, mm, nodem, nm } = dspaceResult)
	}

	if (nm <= 0) {
		satrec.error = SatRecError.MeanMotionBelowZero
		return undefined
	}

	const am = (XKE / nm) ** X2O3 * tempa * tempa
	nm = XKE / am ** 1.5
	em -= tempe

	// fix tolerance for error recognition
	// sgp4fix am is fixed from the previous nm check
	if (em >= 1 || em < -0.001) {
		// || (am < 0.95)
		satrec.error = SatRecError.MeanEccentricityOutOfRange
		// sgp4fix to return if there is an error in eccentricity
		return undefined
	}

	//  sgp4fix fix tolerance to avoid a divide by zero
	if (em < 1e-6) {
		em = 1e-6
	}

	mm += satrec.no * templ
	let xlm = mm + argpm + nodem

	nodem %= TAU
	argpm %= TAU
	xlm %= TAU
	mm = (xlm - argpm - nodem) % TAU

	const meanElements = {
		am: am,
		em: em,
		im: inclm,
		Om: nodem,
		om: argpm,
		mm: mm,
		nm: nm,
	} as const

	// compute extra mean quantities
	const sinim = Math.sin(inclm)
	const cosim = Math.cos(inclm)

	// add lunar-solar periodics
	let ep = em
	let xincp = inclm
	let argpp = argpm
	let nodep = nodem
	let mp = mm
	let sinip = sinim
	let cosip = cosim

	if (satrec.method === 'd') {
		const dpperParameters = {
			inclo: satrec.inclo,
			init: 'n' as const,
			ep,
			inclp: xincp,
			nodep,
			argpp,
			mp,
			opsmode: satrec.operationmode,
		}

		const dpperResult = dpper(satrec, dpperParameters)

		;({ ep, nodep, argpp, mp } = dpperResult)

		xincp = dpperResult.inclp

		if (xincp < 0) {
			xincp = -xincp
			nodep += PI
			argpp -= PI
		}
		if (ep < 0 || ep > 1) {
			satrec.error = SatRecError.PerturbedEccentricityOutOfRange
			return undefined
		}
	}

	// long period periodics
	if (satrec.method === 'd') {
		sinip = Math.sin(xincp)
		cosip = Math.cos(xincp)
		satrec.aycof = -0.5 * J3OJ2 * sinip

		// sgp4fix for divide by zero for xincp = 180 deg
		if (Math.abs(cosip + 1) > 1.5e-12) {
			satrec.xlcof = (-0.25 * J3OJ2 * sinip * (3 + 5 * cosip)) / (1 + cosip)
		} else {
			satrec.xlcof = (-0.25 * J3OJ2 * sinip * (3 + 5 * cosip)) / temp4
		}
	}

	const axnl = ep * Math.cos(argpp)
	let temp = 1 / (am * (1 - ep * ep))
	const aynl = ep * Math.sin(argpp) + temp * satrec.aycof
	const xl = mp + argpp + nodep + temp * satrec.xlcof * axnl

	// solve kepler's equation
	const u = (xl - nodep) % TAU
	let eo1 = u
	let tem5 = 9999.9
	let ktr = 1
	let sineo1 = 0
	let coseo1 = 0

	// sgp4fix for kepler iteration
	// the following iteration needs better limits on corrections
	while (Math.abs(tem5) >= 1e-12 && ktr <= 10) {
		sineo1 = Math.sin(eo1)
		coseo1 = Math.cos(eo1)
		tem5 = 1 - coseo1 * axnl - sineo1 * aynl
		tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5

		if (Math.abs(tem5) >= 0.95) {
			if (tem5 > 0) {
				tem5 = 0.95
			} else {
				tem5 = -0.95
			}
		}

		eo1 += tem5
		ktr += 1
	}

	// short period preliminary quantities
	const ecose = axnl * coseo1 + aynl * sineo1
	const esine = axnl * sineo1 - aynl * coseo1
	const el2 = axnl * axnl + aynl * aynl
	const pl = am * (1 - el2)

	if (pl < 0) {
		satrec.error = SatRecError.SemiLatusRectumBelowZero
		return undefined
	}

	const rl = am * (1 - ecose)
	const rdotl = (Math.sqrt(am) * esine) / rl
	const rvdotl = Math.sqrt(pl) / rl
	const betal = Math.sqrt(1 - el2)
	temp = esine / (1 + betal)
	const sinu = (am / rl) * (sineo1 - aynl - axnl * temp)
	const cosu = (am / rl) * (coseo1 - axnl + aynl * temp)
	let su = Math.atan2(sinu, cosu)
	const sin2u = (cosu + cosu) * sinu
	const cos2u = 1 - 2 * sinu * sinu
	temp = 1 / pl
	const temp1 = 0.5 * J2 * temp
	const temp2 = temp1 * temp

	// update for short period periodics
	if (satrec.method === 'd') {
		const cosisq = cosip * cosip
		satrec.con41 = 3 * cosisq - 1
		satrec.x1mth2 = 1 - cosisq
		satrec.x7thm1 = 7 * cosisq - 1
	}

	const mrt = rl * (1 - 1.5 * temp2 * betal * satrec.con41) + 0.5 * temp1 * satrec.x1mth2 * cos2u

	// sgp4fix for decaying satellites
	if (mrt < 1) {
		satrec.error = SatRecError.Decayed
		return undefined
	}

	su -= 0.25 * temp2 * satrec.x7thm1 * sin2u
	const xnode = nodep + 1.5 * temp2 * cosip * sin2u
	const xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u
	const mvt = rdotl - (nm * temp1 * satrec.x1mth2 * sin2u) / XKE
	const rvdot = rvdotl + (nm * temp1 * (satrec.x1mth2 * cos2u + 1.5 * satrec.con41)) / XKE

	// orientation vectors
	const sinsu = Math.sin(su)
	const cossu = Math.cos(su)
	const snod = Math.sin(xnode)
	const cnod = Math.cos(xnode)
	const sini = Math.sin(xinc)
	const cosi = Math.cos(xinc)
	const xmx = -snod * cosi
	const xmy = cnod * cosi
	const ux = xmx * sinsu + cnod * cossu
	const uy = xmy * sinsu + snod * cossu
	const uz = sini * sinsu
	const vx = xmx * cossu - cnod * sinsu
	const vy = xmy * cossu - snod * sinsu
	const vz = sini * cossu

	// position and velocity (in km and km/sec)
	const position = {
		x: mrt * ux * earthRadius,
		y: mrt * uy * earthRadius,
		z: mrt * uz * earthRadius,
	}
	const velocity = {
		x: (mvt * ux + rvdot * vx) * vkmpersec,
		y: (mvt * uy + rvdot * vy) * vkmpersec,
		z: (mvt * uz + rvdot * vz) * vkmpersec,
	}

	return { position, velocity, meanElements } as const
}
