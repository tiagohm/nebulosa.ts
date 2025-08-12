import { type Angle, deg } from './angle'
import { TAU } from './constants'
import { type Time, Timescale, timeNormalize, timeSubtract, timeYMD } from './time'
import { type MutVec3, vecMulScalar } from './vec3'

export interface TLE {
	readonly id: string // Number of satellite in SATCAT database (Satellite Catalog Number)
	readonly inclination: Angle // [i0] Mean inclination at epoch, in degrees
	readonly eccentricity: number // [e0] Eccentricity
	readonly bstar: number // [BStar] BStar drag term
	readonly argumentOfPerigee: Angle // [w0] Argument of perigee at epoch, in degrees
	readonly meanMotion: number // [n0] Mean motion at epoch, in revolutions per day
	readonly meanMotionFirstDerivative: number // First derivative of mean motion; the ballistic coefficient (rev/day, per day)
	readonly meanMotionSecondDerivative: number // Second derivative of mean motion (rev/day³)
	readonly meanAnomaly: Angle // [M0] Mean anomaly at epoch, in degrees
	readonly longitudeOfAscendingNode: Angle // [OMEGA0] Longitude of ascending node, in degrees
	readonly epoch: Time // Epoch of elements, in julian days
	readonly parameters: TLEParameters
}

export interface TLEParameters {
	operationmode: 'a' | 'i'
	init: 'y' | 'n'
	method: 'n' | 'd'

	// Near Earth
	simp: boolean
	aycof: number
	con41: number
	cc1: number
	cc4: number
	cc5: number
	d2: number
	d3: number
	d4: number
	delmo: number
	eta: number
	argpdot: number
	omgcof: number
	sinmao: number
	// The time you gave when you most recently asked SGP4 to compute this satellite’s position,
	// measured in minutes before (negative) or after (positive) the satellite’s epoch.
	t: number
	t2cof: number
	t3cof: number
	t4cof: number
	t5cof: number
	x1mth2: number
	x7thm1: number
	mdot: number
	nodedot: number
	xlcof: number
	xmcof: number
	nodecf: number

	// Deep Space
	irez: number
	d2201: number
	d2211: number
	d3210: number
	d3222: number
	d4410: number
	d4422: number
	d5220: number
	d5232: number
	d5421: number
	d5433: number
	dedt: number
	del1: number
	del2: number
	del3: number
	didt: number
	dmdt: number
	dnodt: number
	domdt: number
	e3: number
	ee2: number
	peo: number
	pgho: number
	pho: number
	pinco: number
	plo: number
	se2: number
	se3: number
	sgh2: number
	sgh3: number
	sgh4: number
	sh2: number
	sh3: number
	si2: number
	si3: number
	sl2: number
	sl3: number
	sl4: number
	gsto: number
	xfact: number
	xgh2: number
	xgh3: number
	xgh4: number
	xh2: number
	xh3: number
	xi2: number
	xi3: number
	xl2: number
	xl3: number
	xl4: number
	xlamo: number
	zmol: number
	zmos: number
	atime: number
	xli: number
	xni: number

	a: number
	altp: number
	alta: number
}

const XPDOTP = 1440 / TAU

const aE = 1.0
const J2 = 1.0826158e-3
const J3 = -2.53881e-6
const J4 = -1.65597e-6
const k2 = 0.5 * J2 * aE * aE
const k4 = (-3 / 8.0) * J4 * aE * aE * aE * aE
const A30 = -J3 * aE * aE * aE

const EARTH_RADIUS = 6378.135 // km
const EARTH_FLATTENING = 1 / 298.26
const SOLAR_RADIUS = 696000 // km
const MU = 398600.8 // in km3 / s2

const KE = 60 / Math.sqrt((EARTH_RADIUS * EARTH_RADIUS * EARTH_RADIUS) / MU)
const VKMS = (EARTH_RADIUS * KE) / 60
const tumin = 1 / KE
const x2o3 = 2 / 3.0
const j2 = 0.001082616
const j3 = -0.00000253881
const j4 = -0.00000165597

// https://en.wikipedia.org/wiki/Two-line_element_set
export function parseTLE(line1: string, line2: string): TLE {
	const id = line1.substring(2, 7).trim()

	const ey = +line1.substring(18, 20) // last two digits of year
	const ed = +line1.substring(20, 32) // day of the year and fractional portion of the day
	const meanMotionFirstDerivative = +line1.substring(33, 43)
	const meanMotionSecondDerivative = +`${line1.substring(44, 45)}.${line1.substring(45, 50)}E${line1.substring(50, 52)}`
	const bstar = +`${line1.substring(53, 54)}.${line1.substring(54, 59)}E${line1.substring(59, 61)}`

	// Standard orbital elements
	const inclination = deg(+line2.substring(8, 16))
	const longitudeOfAscendingNode = deg(+line2.substring(17, 25))
	const eccentricity = +line2.substring(26, 33) * 1e-7
	const argumentOfPerigee = deg(+line2.substring(34, 42))
	const meanAnomaly = deg(+line2.substring(43, 51))
	const meanMotion = +line2.substring(52, 63) / XPDOTP

	let epoch = timeYMD(ey < 57 ? ey + 2000 : ey + 1900, 1, 1)
	epoch = timeNormalize(epoch.day + ed - 1, epoch.fraction, 0, Timescale.TT)

	const parameters = structuredClone(EMPTY_TLE_PARAMETERS)

	const tle: TLE = {
		id,
		meanMotion,
		meanMotionFirstDerivative,
		meanMotionSecondDerivative,
		inclination,
		eccentricity,
		bstar: bstar,
		argumentOfPerigee,
		meanAnomaly,
		longitudeOfAscendingNode,
		epoch,
		parameters,
	}

	return tle
}

export function sgp4(tle: TLE, time: Time) {
	const { method } = tle.parameters
	const T = timeSubtract(time, tle.epoch, Timescale.TT)

	const cosip = 0.6206456691450233
	const am = 1.0652180864612302
	let con41 = 0.15560313988542113
	let x1mth2 = 0.6147989533715263
	let x7thm1 = 1.6964073263993158
	const sinip = 0.7840911639417487
	const nodep = 0.6392758677522207
	const xincp = 0.9012304298645559
	const nm = 0.06764286204121123

	const ep = 0.00018528592768087272
	const argpp = 3.0786559492381915
	const aycof = 0.0009193742231441948
	const xlcof = 0.0017311467046287911
	const mp = -1.5930720884200413

	const axnl = ep * Math.cos(argpp)
	let temp = 1 / (am * (1 - ep * ep))
	const aynl = ep * Math.sin(argpp) + temp * aycof
	const xl = mp + argpp + nodep + temp * xlcof * axnl

	// solve kepler's equation
	const u = (xl - nodep) % TAU
	let eo1 = u
	let tem5 = 9999.9
	let ktr = 1
	let coseo1 = 0
	let sineo1 = 0

	while (Math.abs(tem5) >= 1e-12 && ktr <= 10) {
		sineo1 = Math.sin(eo1)
		coseo1 = Math.cos(eo1)
		tem5 = 1 - coseo1 * axnl - sineo1 * aynl
		tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5

		if (Math.abs(tem5) >= 0.95) {
			tem5 = tem5 > 0 ? 0.95 : -0.95
		}

		eo1 += tem5
		ktr++
	}

	// short period preliminary quantities
	const ecose = axnl * coseo1 + aynl * sineo1
	const esine = axnl * sineo1 - aynl * coseo1
	const el2 = axnl * axnl + aynl * aynl
	const pl = am * (1 - el2)

	if (pl < 0) {
		// satrec.error = SemiLatusRectumBelowZero
		return null
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
	const temp1 = 0.5 * j2 * temp
	const temp2 = temp1 * temp

	// update for short period periodics
	if (method === 'd') {
		const cosisq = cosip * cosip
		con41 = 3 * cosisq - 1
		x1mth2 = 1 - cosisq
		x7thm1 = 7 * cosisq - 1
	}

	const mrt = rl * (1 - 1.5 * temp2 * betal * con41) + 0.5 * temp1 * x1mth2 * cos2u

	// decaying satellites
	if (mrt < 1) {
		// error = Decayed
		return null
	}

	su -= 0.25 * temp2 * x7thm1 * sin2u
	const xnode = nodep + 1.5 * temp2 * cosip * sin2u
	const xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u
	const mvt = rdotl - (nm * temp1 * x1mth2 * sin2u) / KE
	const rvdot = rvdotl + (nm * temp1 * (x1mth2 * cos2u + 1.5 * con41)) / KE

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
	const p: MutVec3 = [mrt * ux, mrt * uy, mrt * uz]
	const v: MutVec3 = [mvt * ux + rvdot * vx, mvt * uy + rvdot * vy, mvt * uz + rvdot * vz]

	vecMulScalar(p, EARTH_RADIUS, p)
	vecMulScalar(v, VKMS, v)

	return [p, v] as const
}

function sgp4Init(tle: TLE) {}

const zns = 1.19459e-5
const zes = 0.01675
const znl = 1.5835218e-4
const zel = 0.0549

function dpper(tle: TLE, t: number, init: boolean) {
	const { e3, ee2, peo, pgho, pho, pinco, plo, se2, se3, sgh2, sgh3, sgh4, sh2, sh3, si2, si3, sl2, sl3, sl4, xgh2, xgh3, xgh4, xh2, xh3, xi2, xi3, xl2, xl3, xl4, zmol, zmos } = tle.parameters
    let inclp = tle.inclination

	// calculate time varying periodics
	let zm = init ? zmos : zmos + zns * t
	let zf = zm + 2 * zes * Math.sin(zm)
	let sinzf = Math.sin(zf)
	let f2 = 0.5 * sinzf * sinzf - 0.25
	let f3 = -0.5 * sinzf * Math.cos(zf)

	const ses = se2 * f2 + se3 * f3
	const sis = si2 * f2 + si3 * f3
	const sls = sl2 * f2 + sl3 * f3 + sl4 * sinzf
	const sghs = sgh2 * f2 + sgh3 * f3 + sgh4 * sinzf
	const shs = sh2 * f2 + sh3 * f3

	zm = init ? zmol : zmol + znl * t
	zf = zm + 2 * zel * Math.sin(zm)
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

	if (!init) {
		pe -= peo
		pinc -= pinco
		pl -= plo
		pgh -= pgho
		ph -= pho
		inclp += pinc
		ep += pe
		sinip = Math.sin(inclp)
		cosip = Math.cos(inclp)

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
			sinop = Math.sin(nodep)
			cosop = Math.cos(nodep)
			alfdp = sinip * sinop
			betdp = sinip * cosop
			dalf = ph * cosop + pinc * cosip * sinop
			dbet = -ph * sinop + pinc * cosip * cosop
			alfdp += dalf
			betdp += dbet
			nodep %= TAU

			//  sgp4fix for afspc written intrinsic functions
			//  nodep used without a trigonometric function ahead
			if (nodep < 0 && opsmode === 'a') {
				nodep += TAU
			}

			xls = mp + argpp + cosip * nodep
			dls = pl + pgh - pinc * nodep * sinip
			xls += dls
			xnoh = nodep
			nodep = Math.atan2(alfdp, betdp)

			//  sgp4fix for afspc written intrinsic functions
			//  nodep used without a trigonometric function ahead
			if (nodep < 0 && opsmode === 'a') {
				nodep += TAU
			}

			if (Math.abs(xnoh - nodep) > pi) {
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

	return { ep, inclp, nodep, argpp, mp }
}

const EMPTY_TLE_PARAMETERS: TLEParameters = {
	operationmode: 'a',
	init: 'n',
	method: 'n',
	simp: false,
	aycof: 0,
	con41: 0,
	cc1: 0,
	cc4: 0,
	cc5: 0,
	d2: 0,
	d3: 0,
	d4: 0,
	delmo: 0,
	eta: 0,
	argpdot: 0,
	omgcof: 0,
	sinmao: 0,
	t: 0,
	t2cof: 0,
	t3cof: 0,
	t4cof: 0,
	t5cof: 0,
	x1mth2: 0,
	x7thm1: 0,
	mdot: 0,
	nodedot: 0,
	xlcof: 0,
	xmcof: 0,
	nodecf: 0,
	irez: 0,
	d2201: 0,
	d2211: 0,
	d3210: 0,
	d3222: 0,
	d4410: 0,
	d4422: 0,
	d5220: 0,
	d5232: 0,
	d5421: 0,
	d5433: 0,
	dedt: 0,
	del1: 0,
	del2: 0,
	del3: 0,
	didt: 0,
	dmdt: 0,
	dnodt: 0,
	domdt: 0,
	e3: 0,
	ee2: 0,
	peo: 0,
	pgho: 0,
	pho: 0,
	pinco: 0,
	plo: 0,
	se2: 0,
	se3: 0,
	sgh2: 0,
	sgh3: 0,
	sgh4: 0,
	sh2: 0,
	sh3: 0,
	si2: 0,
	si3: 0,
	sl2: 0,
	sl3: 0,
	sl4: 0,
	gsto: 0,
	xfact: 0,
	xgh2: 0,
	xgh3: 0,
	xgh4: 0,
	xh2: 0,
	xh3: 0,
	xi2: 0,
	xi3: 0,
	xl2: 0,
	xl3: 0,
	xl4: 0,
	xlamo: 0,
	zmol: 0,
	zmos: 0,
	atime: 0,
	xli: 0,
	xni: 0,
	a: 0,
	altp: 0,
	alta: 0,
}
