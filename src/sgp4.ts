import type { Angle } from './angle'
import type { PositionAndVelocity } from './astrometry'
import { DAYMIN, DEG2RAD, PI, TAU } from './constants'
import { kilometer } from './distance'
import { isLeapYear, temporalFromFractionOfYear } from './temporal'
import { greenwichMeanSiderealTime, type Time, Timescale, timeSubtract, timeUnix, timeYMDHMS } from './time'
import { kilometerPerSecond } from './velocity'

const MU = 398600.8 // in km3 / s2
const EARTH_RADIUS = 6378.135 // in km
const XKE = 60 / Math.sqrt((EARTH_RADIUS * EARTH_RADIUS * EARTH_RADIUS) / MU)
const VKMPERSEC = (EARTH_RADIUS * XKE) / 60
const tumin = 1 / XKE
const J2 = 0.001082616
const J3 = -0.00000253881
const J4 = -0.00000165597
const J3OJ2 = J3 / J2
const X2O3 = 2 / 3
const XPDOTP = DAYMIN / TAU // 229.1831180523293

// Represents a parsed Two-Line Element set.
export interface TLE {
	readonly name?: string
	readonly line1: string
	readonly line2: string
	readonly satelliteNumber: string
	readonly epochYear: number
	readonly epochDays: number
	readonly epoch: Time
	readonly meanMotionDot: number
	readonly meanMotionDdot: number
	readonly bstar: number
	readonly inclination: Angle
	readonly rightAscensionOfAscendingNode: Angle
	readonly eccentricity: number
	readonly argumentOfPerigee: Angle
	readonly meanAnomaly: Angle
	readonly meanMotion: number
	readonly revolutionNumberAtEpoch: number
}

// A set of "singly averaged mean elements" that describe shape of the
// satellite?s orbit at the propagation date. They are averaged
// with respect to the mean anomaly and include the effects of secular
// gravity, atmospheric drag, and - in Deep Space mode - of those
// pertubations from the Sun and Moon that SGP4 averages over an entire
// revolution of each of those bodies. They omit both the shorter-term
// and longer-term periodic pertubations from the Sun and Moon that
// SGP4 applies right before computing each position.
export interface MeanElements {
	readonly am: number // Average semi-major axis (earth radii).
	readonly em: number // Average eccentricity.
	readonly im: Angle // Average inclination.
	readonly Om: Angle // Average right ascension of ascending node.
	readonly om: Angle // Average argument of perigee.
	readonly mm: Angle // Average mean anomaly.
	readonly nm: Angle // Average mean motion (radians/minute).
}

export type SupportedOMMVersion = `3.${string}`

// This is the base interface for the OMM JSON object as specified in Orbit Data Messages
// recommended standard, version 3.0.
// Note that this is not a 1:1 mapping. Only the fields that are necessary to propagate
// a satellite orbit are made required. For example, CCSDS_OMM_VERS is required by the spec,
// but is not present in Celestrak OMM output, and is not required to propagate the satellite,
// so it is made optional here.
// Numeric fields may be represented as strings or numbers in the original json, depending on
// the source. This is because the spec doesn't specify the type, and different sources use
// different types: at the time of writing, Celestrak uses numbers, while SpaceTrack uses strings.
export interface OMM {
	CCSDS_OMM_VERS?: SupportedOMMVersion
	COMMENT?: string
	CLASSIFICATION?: string
	OBJECT_NAME: string
	OBJECT_ID: string
	CENTER_NAME?: 'EARTH'
	REF_FRAME?: 'TEME'
	REF_FRAME_EPOCH?: string
	TIME_SYSTEM?: 'UTC'
	MEAN_ELEMENT_THEORY?: 'SGP4'
	CREATION_DATE?: string
	ORIGINATOR?: string
	EPOCH: string
	MEAN_MOTION: string | number
	ECCENTRICITY: string | number
	INCLINATION: number | string
	RA_OF_ASC_NODE: number | string
	ARG_OF_PERICENTER: number | string
	MEAN_ANOMALY: number | string
	EPHEMERIS_TYPE?: 0 | '0'
	CLASSIFICATION_TYPE?: 'U' | 'C'
	NORAD_CAT_ID: string | number
	ELEMENT_SET_NO: string | number
	REV_AT_EPOCH?: string | number
	BSTAR: string | number
	MEAN_MOTION_DOT: string | number
	MEAN_MOTION_DDOT: string | number
	[key: string]: unknown // This handles additional metadata, such as OBJECT_TYPE, COUNTRY_CODE etc
}

export enum SatRecError {
	None = 0, // No error, propagation for the last supplied date is successful
	MeanEccentricityOutOfRange = 1, // Mean eccentricity is out of range 0 ? e < 1
	MeanMotionBelowZero = 2, // Mean motion has fallen below zero.
	PerturbedEccentricityOutOfRange = 3, // Perturbed eccentricity is out of range 0 ? e < 1
	SemiLatusRectumBelowZero = 4, // Length of the orbit?s semi-latus rectum has fallen below zero.
	Decayed = 6, // Orbit has decayed: the computed position is underground.
}

// A structure that contains all the information needed to propagate a satellite's orbit using the SGP4 model.
// Mostly you can consider it opaque as you only need to pass it to `propagate` function.
// All properties should be considered read-only as they're used and set by SGP4 model internally.
// This interface is a direct translation of C++ struct `elsetrec` from the source code by David Vallado;
// all changes to the original struct are documented.
export interface SatRec {
	readonly satnum: string
	readonly epochyr: number
	readonly epochtynumrev: number
	error: SatRecError
	// A single character that directs SGP4 to either operate in its modern 'i' improved mode or
	// in its legacy 'a' AFSPC mode.
	operationmode: 'a' | 'i'
	init: 'y' | 'n'
	// A single character, chosen automatically when the orbital elements were loaded, that
	// indicates whether SGP4 has chosen to use its built-in 'n' Near Earth or 'd' Deep Space
	// mode for this satellite.
	method: 'n' | 'd'

	// Near Earth
	isimp: number
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

	// The time you gave when you most recently asked SGP4 to compute this satellite?s position,
	// measured in minutes before (negative) or after (positive) the satellite?s epoch.
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

	epochdays: number // Fractional days into the year of the epoch moment in UTC.
	jdsatepoch: Time // Julian date of the epoch (computed from epochyr and epochdays).
	nddot: number // Second time derivative of the mean motion (ignored by SGP4).
	ndot: number // First time derivative of the mean motion (ignored by SGP4).
	bstar: number // Ballistic drag coefficient B* in inverse earth radii.
	inclo: Angle // Inclination in radians.
	nodeo: Angle // Right ascension of ascending node in radians.
	ecco: number // Eccentricity.
	argpo: Angle // Argument of perigee in radians.
	mo: Angle // Mean anomaly in radians.
	no: Angle // Mean motion in radians per minute.
}

export type SatRecInit = Pick<SatRec, 'error' | 'satnum' | 'epochyr' | 'epochdays' | 'ndot' | 'nddot' | 'bstar' | 'inclo' | 'nodeo' | 'ecco' | 'argpo' | 'mo' | 'no' | 'jdsatepoch'>

// Parses two TLE lines into a validated structured object.
export function parseTLE(line1: string, line2: string, name?: string): TLE {
	const a = line1.trimEnd().padEnd(69, ' ')
	const b = line2.trimEnd().padEnd(69, ' ')

	if (a[0] !== '1') throw new Error('TLE line 1 must start with "1"')
	if (b[0] !== '2') throw new Error('TLE line 2 must start with "2"')

	const satelliteNumber = a.substring(2, 7).trim()
	const epochYear = +a.substring(18, 20)
	const epochDays = +a.substring(20, 32)
	const meanMotionDot = +a.substring(33, 43)
	const meanMotionDdot = parseTleExponent(a.substring(44, 52))
	const bstar = parseTleExponent(a.substring(53, 61))
	const inclination = +b.substring(8, 16) * DEG2RAD
	const rightAscensionOfAscendingNode = +b.substring(17, 25) * DEG2RAD
	const eccentricity = +`0.${b.substring(26, 33).replaceAll(' ', '0')}`
	const argumentOfPerigee = +b.substring(34, 42) * DEG2RAD
	const meanAnomaly = +b.substring(43, 51) * DEG2RAD
	const meanMotion = +b.substring(52, 63)
	const revolutionNumberAtEpoch = +b.substring(63, 68) || 0
	const year = epochYear < 57 ? epochYear + 2000 : epochYear + 1900
	const [month, day, hour, minute, second] = daysToMonthDayHourMinuteSecond(year, epochDays)
	const epoch = timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC)

	return {
		name,
		line1: a,
		line2: b,
		satelliteNumber,
		epochYear,
		epochDays,
		epoch,
		meanMotionDot,
		meanMotionDdot,
		bstar,
		inclination,
		rightAscensionOfAscendingNode,
		eccentricity,
		argumentOfPerigee,
		meanAnomaly,
		meanMotion,
		revolutionNumberAtEpoch,
	}
}

// Builds a reusable SGP4 record from parsed TLE elements.
export function recordFromTLE({ line1, line2 }: TLE) {
	const opsmode = 'i'
	const error = 0

	const satnum = line1.substring(2, 7)

	const epochyr = +line1.substring(18, 20)
	const epochdays = +line1.substring(20, 32)
	const ndot = +line1.substring(33, 43)
	const nddot = +`${line1.substring(44, 45)}.${line1.substring(45, 50)}E${line1.substring(50, 52)}`
	const bstar = +`${line1.substring(53, 54)}.${line1.substring(54, 59)}E${line1.substring(59, 61)}`

	// satrec.satnum = line2.substring(2, 7)
	// Find standard orbital elements
	const inclo = +line2.substring(8, 16) * DEG2RAD
	const nodeo = +line2.substring(17, 25) * DEG2RAD
	const ecco = +`.${line2.substring(26, 33).replace(/\s/g, '0')}`
	const argpo = +line2.substring(34, 42) * DEG2RAD
	const mo = +line2.substring(43, 51) * DEG2RAD

	// Find no, ndot, nddot
	const no = +line2.substring(52, 63) / XPDOTP
	// satrec.nddot = satrec.nddot * Math.pow(10, nexp)
	// satrec.bstar = satrec.bstar * Math.pow(10, ibexp)

	// Convert to sgp4 units
	// satrec.ndot /= (xpdotp * 1440) // ? * minperday
	// satrec.nddot /= (xpdotp * 1440 * 1440)

	// find sgp4epoch time of element set
	// remember that sgp4 uses units of days from 0 jan 1950 (sgp4epoch)
	// and minutes from the epoch (time)
	// correct fix will occur when year is 4-digit in tle
	const year = epochyr < 57 ? epochyr + 2000 : epochyr + 1900
	const jdsatepoch = timeUnix(temporalFromFractionOfYear(year, epochdays) / 1000, undefined, true)

	const satrec: SatRecInit = {
		error,
		satnum,
		epochyr,
		epochdays,
		ndot,
		nddot,
		bstar,
		inclo,
		nodeo,
		ecco,
		argpo,
		mo,
		no,
		jdsatepoch,
	}

	// Initialize the orbit at sgp4epoch
	sgp4Init(satrec, {
		opsmode,
		satn: satrec.satnum,
		epochday: satrec.jdsatepoch.day - 2433281,
		epochfrac: satrec.jdsatepoch.fraction - 0.5,
		xbstar: satrec.bstar,
		xecco: satrec.ecco,
		xargpo: satrec.argpo,
		xinclo: satrec.inclo,
		xmo: satrec.mo,
		xno: satrec.no,
		xnodeo: satrec.nodeo,
	})

	return satrec
}

// Builds a reusable SGP4 record from an OMM object.
export function recordFromOMM(omm: OMM, opsmode: 'a' | 'i' = 'i') {
	const epoch = parseOmmEpoch(omm.EPOCH)
	const satrec: SatRecInit = {
		error: SatRecError.None,
		satnum: omm.NORAD_CAT_ID.toString(),
		epochyr: epoch.year % 100,
		epochdays: epoch.days,
		ndot: +omm.MEAN_MOTION_DOT || 0,
		nddot: +omm.MEAN_MOTION_DDOT || 0,
		bstar: +omm.BSTAR,
		inclo: +omm.INCLINATION * DEG2RAD,
		nodeo: +omm.RA_OF_ASC_NODE * DEG2RAD,
		ecco: +omm.ECCENTRICITY,
		argpo: +omm.ARG_OF_PERICENTER * DEG2RAD,
		mo: +omm.MEAN_ANOMALY * DEG2RAD,
		no: +omm.MEAN_MOTION / XPDOTP,
		jdsatepoch: epoch.jd,
	}

	sgp4Init(satrec, {
		opsmode,
		satn: satrec.satnum,
		epochday: satrec.jdsatepoch.day - 2433281,
		epochfrac: satrec.jdsatepoch.fraction - 0.5,
		xbstar: satrec.bstar,
		xecco: satrec.ecco,
		xargpo: satrec.argpo,
		xinclo: satrec.inclo,
		xmo: satrec.mo,
		xno: satrec.no,
		xnodeo: satrec.nodeo,
	})

	return satrec
}

// Returns a human-readable explanation for an SGP4 propagation error.
export function satelliteRecordErrorMessage(error: SatRecError) {
	if (error === SatRecError.MeanEccentricityOutOfRange) return 'mean eccentricity is outside the valid interval'
	if (error === SatRecError.MeanMotionBelowZero) return 'mean motion is below zero'
	if (error === SatRecError.PerturbedEccentricityOutOfRange) return 'perturbed eccentricity is outside the valid interval'
	if (error === SatRecError.SemiLatusRectumBelowZero) return 'semi-latus rectum is below zero'
	if (error === SatRecError.Decayed) return 'the orbit has decayed below the Earth surface model'
	return 'unknown propagation error'
}

// Propagates a TLE, OMM, or precomputed SGP4 record to a Julian day in TEME.
export function sgp4(time: Time, source: TLE | OMM | SatRec): PositionAndVelocity {
	const satrec = isSatRec(source) ? source : isTLE(source) ? recordFromTLE(source) : recordFromOMM(source)
	const result = sgp4Propagate(satrec, timeSubtract(time, satrec.jdsatepoch) * DAYMIN)

	if (!result) {
		throw new Error(`Satellite propagation failed: ${satelliteRecordErrorMessage(satrec.error)}.`)
	}

	return [
		[kilometer(result.position.x), kilometer(result.position.y), kilometer(result.position.z)],
		[kilometerPerSecond(result.velocity.x), kilometerPerSecond(result.velocity.y), kilometerPerSecond(result.velocity.z)],
	]
}

function isTLE(source: TLE | OMM | SatRec): source is TLE {
	return 'line1' in source && 'line2' in source
}

function isSatRec(source: TLE | OMM | SatRec): source is SatRec {
	return 'jdsatepoch' in source && 'method' in source
}

function parseTleExponent(input: string) {
	const trimmed = input.trim()

	if (!trimmed) return 0

	const sign = trimmed[0] === '-' ? '-' : ''
	const mantissaDigits = trimmed.replace(/^[-+]/, '').slice(0, 5)
	const exponent = trimmed.slice(-2)
	return +`${sign}0.${mantissaDigits}e${exponent}`
}

function daysToMonthDayHourMinuteSecond(year: number, days: number) {
	const monthLength = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
	const dayOfYear = Math.floor(days)
	let month = 1
	let sum = 0

	while (month < 12 && dayOfYear > sum + monthLength[month - 1]!) {
		sum += monthLength[month - 1]!
		month++
	}

	const day = dayOfYear - sum
	let temp = (days - dayOfYear) * 24
	const hour = Math.floor(temp)
	temp = (temp - hour) * 60
	const minute = Math.floor(temp)
	const second = (temp - minute) * 60
	return [month, day, hour, minute, second] as const
}

const OMM_EPOCH_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(?:Z)?$/

function parseOmmEpoch(input: string) {
	const match = OMM_EPOCH_REGEX.exec(input.trim())

	if (!match) throw new Error('invalid OMM epoch')

	const year = +match[1]
	const month = +match[2]
	const day = +match[3]
	const hour = +match[4]
	const minute = +match[5]
	const second = +match[6]
	const jd = timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC)
	const startOfYear = timeYMDHMS(year, 1, 1, 0, 0, 0, Timescale.UTC)

	return {
		year,
		days: timeSubtract(jd, startOfYear) + 1,
		jd,
	} as const
}

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

export interface DscomOptions {
	readonly epochday: number
	readonly epochfrac: number
	readonly ep: number
	readonly argpp: number
	readonly tc: number
	readonly inclp: number
	readonly nodep: number
	readonly np: number
}

// Provides deep space common items used by both the secular
// and periodics subroutines. Input is provided as shown. this routine
// used to be called dpper, but the functions inside weren't well organized.
// author: david vallado 719-573-2600 28 jun 2005
function dscom(options: DscomOptions) {
	const { epochday, epochfrac, ep, argpp, tc, inclp, nodep, np } = options

	// constants
	const zes = 0.01675
	const zel = 0.0549
	const c1ss = 2.9864797e-6
	const c1l = 4.7968065e-7
	const zsinis = 0.39785416
	const zcosis = 0.91744867
	const zcosgs = 0.1945905
	const zsings = -0.98088458

	// local variables
	const nm = np
	const em = ep
	const snodm = Math.sin(nodep)
	const cnodm = Math.cos(nodep)
	const sinomm = Math.sin(argpp)
	const cosomm = Math.cos(argpp)
	const sinim = Math.sin(inclp)
	const cosim = Math.cos(inclp)
	const emsq = em * em
	const betasq = 1 - emsq
	const rtemsq = Math.sqrt(betasq)

	// initialize lunar solar terms
	const peo = 0
	const pinco = 0
	const plo = 0
	const pgho = 0
	const pho = 0
	const day = epochday + 18261.5 + tc / 1440 + epochfrac
	const xnodce = (4.523602 - 9.2422029e-4 * day) % TAU
	const stem = Math.sin(xnodce)
	const ctem = Math.cos(xnodce)
	const zcosil = 0.91375164 - 0.03568096 * ctem
	const zsinil = Math.sqrt(1 - zcosil * zcosil)
	const zsinhl = (0.089683511 * stem) / zsinil
	const zcoshl = Math.sqrt(1 - zsinhl * zsinhl)
	const gam = 5.8351514 + 0.001944368 * day
	let zx = (0.39785416 * stem) / zsinil
	const zy = zcoshl * ctem + 0.91744867 * zsinhl * stem
	zx = Math.atan2(zx, zy)
	zx += gam - xnodce
	const zcosgl = Math.cos(zx)
	const zsingl = Math.sin(zx)

	// do solar terms
	let zcosg = zcosgs
	let zsing = zsings
	let zcosi = zcosis
	let zsini = zsinis
	let zcosh = cnodm
	let zsinh = snodm
	let cc = c1ss
	const xnoi = 1 / nm

	let lsflg = 0

	let ss1 = 0
	let ss2 = 0
	let ss3 = 0
	let ss4 = 0
	let ss5 = 0
	let ss6 = 0
	let ss7 = 0
	let sz1 = 0
	let sz2 = 0
	let sz3 = 0
	let sz11 = 0
	let sz12 = 0
	let sz13 = 0
	let sz21 = 0
	let sz22 = 0
	let sz23 = 0
	let sz31 = 0
	let sz32 = 0
	let sz33 = 0

	let s1 = 0
	let s2 = 0
	let s3 = 0
	let s4 = 0
	let s5 = 0
	let s6 = 0
	let s7 = 0
	let z1 = 0
	let z2 = 0
	let z3 = 0
	let z11 = 0
	let z12 = 0
	let z13 = 0
	let z21 = 0
	let z22 = 0
	let z23 = 0
	let z31 = 0
	let z32 = 0
	let z33 = 0

	while (lsflg < 2) {
		lsflg += 1

		const a1 = zcosg * zcosh + zsing * zcosi * zsinh
		const a3 = -zsing * zcosh + zcosg * zcosi * zsinh
		const a7 = -zcosg * zsinh + zsing * zcosi * zcosh
		const a8 = zsing * zsini
		const a9 = zsing * zsinh + zcosg * zcosi * zcosh
		const a10 = zcosg * zsini
		const a2 = cosim * a7 + sinim * a8
		const a4 = cosim * a9 + sinim * a10
		const a5 = -sinim * a7 + cosim * a8
		const a6 = -sinim * a9 + cosim * a10

		const x1 = a1 * cosomm + a2 * sinomm
		const x2 = a3 * cosomm + a4 * sinomm
		const x3 = -a1 * sinomm + a2 * cosomm
		const x4 = -a3 * sinomm + a4 * cosomm
		const x5 = a5 * sinomm
		const x6 = a6 * sinomm
		const x7 = a5 * cosomm
		const x8 = a6 * cosomm

		z31 = 12 * x1 * x1 - 3 * x3 * x3
		z32 = 24 * x1 * x2 - 6 * x3 * x4
		z33 = 12 * x2 * x2 - 3 * x4 * x4

		z1 = 3 * (a1 * a1 + a2 * a2) + z31 * emsq
		z2 = 6 * (a1 * a3 + a2 * a4) + z32 * emsq
		z3 = 3 * (a3 * a3 + a4 * a4) + z33 * emsq

		z11 = -6 * a1 * a5 + emsq * (-24 * x1 * x7 - 6 * x3 * x5)
		z12 = -6 * (a1 * a6 + a3 * a5) + emsq * (-24 * (x2 * x7 + x1 * x8) + -6 * (x3 * x6 + x4 * x5))

		z13 = -6 * a3 * a6 + emsq * (-24 * x2 * x8 - 6 * x4 * x6)

		z21 = 6 * a2 * a5 + emsq * (24 * x1 * x5 - 6 * x3 * x7)
		z22 = 6 * (a4 * a5 + a2 * a6) + emsq * (24 * (x2 * x5 + x1 * x6) - 6 * (x4 * x7 + x3 * x8))
		z23 = 6 * a4 * a6 + emsq * (24 * x2 * x6 - 6 * x4 * x8)

		z1 = z1 + z1 + betasq * z31
		z2 = z2 + z2 + betasq * z32
		z3 = z3 + z3 + betasq * z33
		s3 = cc * xnoi
		s2 = (-0.5 * s3) / rtemsq
		s4 = s3 * rtemsq
		s1 = -15 * em * s4
		s5 = x1 * x3 + x2 * x4
		s6 = x2 * x3 + x1 * x4
		s7 = x2 * x4 - x1 * x3

		// do lunar terms
		if (lsflg === 1) {
			ss1 = s1
			ss2 = s2
			ss3 = s3
			ss4 = s4
			ss5 = s5
			ss6 = s6
			ss7 = s7
			sz1 = z1
			sz2 = z2
			sz3 = z3
			sz11 = z11
			sz12 = z12
			sz13 = z13
			sz21 = z21
			sz22 = z22
			sz23 = z23
			sz31 = z31
			sz32 = z32
			sz33 = z33
			zcosg = zcosgl
			zsing = zsingl
			zcosi = zcosil
			zsini = zsinil
			zcosh = zcoshl * cnodm + zsinhl * snodm
			zsinh = snodm * zcoshl - cnodm * zsinhl
			cc = c1l
		}
	}

	const zmol = (4.7199672 + (0.2299715 * day - gam)) % TAU
	const zmos = (6.2565837 + 0.017201977 * day) % TAU

	// do solar terms
	const se2 = 2 * ss1 * ss6
	const se3 = 2 * ss1 * ss7
	const si2 = 2 * ss2 * sz12
	const si3 = 2 * ss2 * (sz13 - sz11)
	const sl2 = -2 * ss3 * sz2
	const sl3 = -2 * ss3 * (sz3 - sz1)
	const sl4 = -2 * ss3 * (-21 - 9 * emsq) * zes
	const sgh2 = 2 * ss4 * sz32
	const sgh3 = 2 * ss4 * (sz33 - sz31)
	const sgh4 = -18 * ss4 * zes
	const sh2 = -2 * ss2 * sz22
	const sh3 = -2 * ss2 * (sz23 - sz21)

	// do lunar terms
	const ee2 = 2 * s1 * s6
	const e3 = 2 * s1 * s7
	const xi2 = 2 * s2 * z12
	const xi3 = 2 * s2 * (z13 - z11)
	const xl2 = -2 * s3 * z2
	const xl3 = -2 * s3 * (z3 - z1)
	const xl4 = -2 * s3 * (-21 - 9 * emsq) * zel
	const xgh2 = 2 * s4 * z32
	const xgh3 = 2 * s4 * (z33 - z31)
	const xgh4 = -18 * s4 * zel
	const xh2 = -2 * s2 * z22
	const xh3 = -2 * s2 * (z23 - z21)

	return {
		snodm,
		cnodm,
		sinim,
		cosim,
		sinomm,

		cosomm,
		day,
		e3,
		ee2,
		em,

		emsq,
		gam,
		peo,
		pgho,
		pho,

		pinco,
		plo,
		rtemsq,
		se2,
		se3,

		sgh2,
		sgh3,
		sgh4,
		sh2,
		sh3,

		si2,
		si3,
		sl2,
		sl3,
		sl4,

		s1,
		s2,
		s3,
		s4,
		s5,

		s6,
		s7,
		ss1,
		ss2,
		ss3,

		ss4,
		ss5,
		ss6,
		ss7,
		sz1,

		sz2,
		sz3,
		sz11,
		sz12,
		sz13,

		sz21,
		sz22,
		sz23,
		sz31,
		sz32,

		sz33,
		xgh2,
		xgh3,
		xgh4,
		xh2,

		xh3,
		xi2,
		xi3,
		xl2,
		xl3,

		xl4,
		nm,
		z1,
		z2,
		z3,

		z11,
		z12,
		z13,
		z21,
		z22,

		z23,
		z31,
		z32,
		z33,
		zmol,

		zmos,
	}
}

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
function dsInit(options: DsInitOptions) {
	const { cosim, argpo, s1, s2, s3, s4, s5, sinim, ss1, ss2, ss3, ss4, ss5, sz1, sz3, sz11, sz13, sz21, sz23, sz31, sz33, t, tc, gsto, mo, mdot, no, nodeo, nodedot, xpidot, z1, z3, z11, z13, z21, z23, z31, z33, ecco, eccsq } = options
	let { emsq, em, argpm, inclm, mm, nm, nodem, atime, d2201, d2211, d3210, d3222, d4410, d4422, d5220, d5232, d5421, d5433, dedt, didt, dmdt, dnodt, domdt, del1, del2, del3, xfact, xlamo, xli, xni } = options

	const Q22 = 1.7891679e-6
	const Q31 = 2.1460748e-6
	const Q33 = 2.2123015e-7
	const ROOT22 = 1.7891679e-6
	const ROOT44 = 7.3636953e-9
	const ROOT54 = 2.1765803e-9
	const RPTIM = 4.37526908801129966e-3
	const ROOT32 = 3.7393792e-7
	const ROOT52 = 1.1428639e-7
	const ZNL = 1.5835218e-4
	const ZNS = 1.19459e-5

	// deep space initialization
	let irez = 0

	if (nm < 0.0052359877 && nm > 0.0034906585) {
		irez = 1
	}
	if (nm >= 8.26e-3 && nm <= 9.24e-3 && em >= 0.5) {
		irez = 2
	}

	// do solar terms
	const ses = ss1 * ZNS * ss5
	const sis = ss2 * ZNS * (sz11 + sz13)
	const sls = -ZNS * ss3 * (sz1 + sz3 - 14 - 6 * emsq)
	const sghs = ss4 * ZNS * (sz31 + sz33 - 6.0)
	let shs = -ZNS * ss2 * (sz21 + sz23)

	// sgp4fix for 180 deg incl
	if (inclm < 5.2359877e-2 || inclm > PI - 5.2359877e-2) {
		shs = 0
	}

	if (sinim !== 0) {
		shs /= sinim
	}

	const sgs = sghs - cosim * shs

	// do lunar terms
	dedt = ses + s1 * ZNL * s5
	didt = sis + s2 * ZNL * (z11 + z13)
	dmdt = sls - ZNL * s3 * (z1 + z3 - 14 - 6 * emsq)
	const sghl = s4 * ZNL * (z31 + z33 - 6.0)
	let shll = -ZNL * s2 * (z21 + z23)

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
	const theta = (gsto + tc * RPTIM) % TAU
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
			let temp = temp1 * ROOT22
			d2201 = temp * f220 * g201
			d2211 = temp * f221 * g211
			temp1 *= aonv
			temp = temp1 * ROOT32
			d3210 = temp * f321 * g310
			d3222 = temp * f322 * g322
			temp1 *= aonv
			temp = 2 * temp1 * ROOT44
			d4410 = temp * f441 * g410
			d4422 = temp * f442 * g422
			temp1 *= aonv
			temp = temp1 * ROOT52
			d5220 = temp * f522 * g520
			d5232 = temp * f523 * g532
			temp = 2 * temp1 * ROOT54
			d5421 = temp * f542 * g521
			d5433 = temp * f543 * g533
			xlamo = (mo + nodeo + nodeo - (theta + theta)) % TAU
			xfact = mdot + dmdt + 2 * (nodedot + dnodt - RPTIM) - no
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
			del2 = 2 * del1 * f220 * g200 * Q22
			del3 = 3 * del1 * f330 * g300 * Q33 * aonv
			del1 = del1 * f311 * g310 * Q31 * aonv
			xlamo = (mo + nodeo + argpo - theta) % TAU
			xfact = mdot + xpidot + dmdt + domdt + dnodt - (no + RPTIM)
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
function dspace(options: DspaceOptions) {
	const { irez, d2201, d2211, d3210, d3222, d4410, d4422, d5220, d5232, d5421, d5433, dedt, del1, del2, del3, didt, dmdt, dnodt, domdt, argpo, argpdot, t, tc, gsto, xfact, xlamo, no } = options
	let { atime, em, argpm, inclm, xli, mm, xni, nodem, nm } = options

	const FASX2 = 0.13130908
	const FASX4 = 2.8843198
	const FASX6 = 0.37448087
	const G22 = 5.7686396
	const G32 = 0.95240898
	const G44 = 1.8014998
	const G52 = 1.050833
	const G54 = 4.4108898
	const RPTIM = 4.37526908801129966e-3
	const STEPP = 720
	const STEPN = -720
	const STEP2 = 259200

	let delt = 0
	let dndt = 0
	let ft = 0

	// calculate deep space resonance effects
	const theta = (gsto + tc * RPTIM) % TAU
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
			delt = STEPP
		} else {
			delt = STEPN
		}

		let iretn = 381
		let xndt = 0
		let xnddt = 0
		let xldot = 0

		while (iretn === 381) {
			// dot terms calculated
			// near - synchronous resonance terms
			if (irez !== 2) {
				xndt = del1 * Math.sin(xli - FASX2) + del2 * Math.sin(2 * (xli - FASX4)) + del3 * Math.sin(3 * (xli - FASX6))
				xldot = xni + xfact
				xnddt = del1 * Math.cos(xli - FASX2) + 2 * del2 * Math.cos(2 * (xli - FASX4)) + 3 * del3 * Math.cos(3 * (xli - FASX6))
				xnddt *= xldot
			} else {
				//near - half-day resonance terms
				const xomi = argpo + argpdot * atime
				const x2omi = xomi + xomi
				const x2li = xli + xli
				xndt =
					d2201 * Math.sin(x2omi + xli - G22) +
					d2211 * Math.sin(xli - G22) +
					d3210 * Math.sin(xomi + xli - G32) +
					d3222 * Math.sin(-xomi + xli - G32) +
					d4410 * Math.sin(x2omi + x2li - G44) +
					d4422 * Math.sin(x2li - G44) +
					d5220 * Math.sin(xomi + xli - G52) +
					d5232 * Math.sin(-xomi + xli - G52) +
					d5421 * Math.sin(xomi + x2li - G54) +
					d5433 * Math.sin(-xomi + x2li - G54)
				xldot = xni + xfact
				xnddt =
					d2201 * Math.cos(x2omi + xli - G22) +
					d2211 * Math.cos(xli - G22) +
					d3210 * Math.cos(xomi + xli - G32) +
					d3222 * Math.cos(-xomi + xli - G32) +
					d5220 * Math.cos(xomi + xli - G52) +
					d5232 * Math.cos(-xomi + xli - G52) +
					2 * (d4410 * Math.cos(x2omi + x2li - G44) + d4422 * Math.cos(x2li - G44) + d5421 * Math.cos(xomi + x2li - G54) + d5433 * Math.cos(-xomi + x2li - G54))
				xnddt *= xldot
			}

			// integrator
			// sgp4fix move end checks to end of routine
			if (Math.abs(t - atime) >= STEPP) {
				iretn = 381
			} else {
				ft = t - atime
				iretn = 0
			}

			if (iretn === 381) {
				xli += xldot * delt + xndt * STEP2
				xni += xndt * delt + xnddt * STEP2
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

export interface InitlOptions {
	readonly opsmode: 'a' | 'i'
	readonly ecco: number
	readonly epochday: number
	readonly epochfrac: number
	readonly inclo: number
	readonly no: number
}

// Initializes the sgp4 propagator. all the initialization is
// consolidated here instead of having multiple loops inside other routines.
// author: david vallado 719-573-2600 28 jun 2005
function initl(options: InitlOptions) {
	const { opsmode, ecco, epochday, epochfrac, inclo } = options
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

	let gsto = 0

	if (opsmode === 'a') {
		// sgp4fix use old way of finding gst
		// count integer number of days from 0 jan 1970
		const ts70 = epochday - 7305 + epochfrac
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
		gsto = greenwichMeanSiderealTime({ day: epochday + 2433281, fraction: epochfrac + 0.5, scale: 1 })
	}

	return {
		no,

		method: 'n',

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

// The sgp4 prediction model from space command. This is an
// updated and combined version of sgp4 and sdp4, which were originally
// published separately in spacetrack report //3. This version follows the
// methodology from the aiaa paper (2006) describing the history and
// development of the code.
// author: david vallado 719-573-2600 28 jun 2005
function sgp4Propagate(satrec: SatRec, tsince: number) {
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

		// Persist deep-space integrator state so subsequent calls continue from the previous step.
		satrec.atime = dspaceResult.atime
		satrec.xli = dspaceResult.xli
		satrec.xni = dspaceResult.xni
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
		x: mrt * ux * EARTH_RADIUS,
		y: mrt * uy * EARTH_RADIUS,
		z: mrt * uz * EARTH_RADIUS,
	}
	const velocity = {
		x: (mvt * ux + rvdot * vx) * VKMPERSEC,
		y: (mvt * uy + rvdot * vy) * VKMPERSEC,
		z: (mvt * uz + rvdot * vz) * VKMPERSEC,
	}

	return { position, velocity, meanElements } as const
}

export interface Sgp4InitOptions {
	readonly opsmode: 'a' | 'i'
	readonly satn: string
	readonly epochday: number
	readonly epochfrac: number
	readonly xbstar: number
	readonly xecco: number
	readonly xargpo: number
	readonly xinclo: number
	readonly xmo: number
	readonly xno: number
	readonly xnodeo: number
}

// Initializes variables for sgp4.
function sgp4Init(satrecInit: SatRecInit, options: Sgp4InitOptions): asserts satrecInit is SatRec {
	const { opsmode, satn, epochday, epochfrac, xbstar, xecco, xargpo, xinclo, xmo, xno, xnodeo } = options

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

	const ss = 78 / EARTH_RADIUS + 1
	// sgp4fix use multiply for speed instead of pow
	const qzms2ttemp = (120 - 78) / EARTH_RADIUS
	const qzms2t = qzms2ttemp * qzms2ttemp * qzms2ttemp * qzms2ttemp

	satrec.init = 'y'
	satrec.t = 0

	const initlOptions = {
		satn,
		ecco: satrec.ecco,

		epochday,
		epochfrac,
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

		if (rp < 220 / EARTH_RADIUS + 1) {
			satrec.isimp = 1
		}

		let sfour = ss
		let qzms24 = qzms2t
		const perige = (rp - 1) * EARTH_RADIUS

		// for perigees below 156 km, s and qoms2t are altered
		if (perige < 156) {
			sfour = perige - 78

			if (perige < 98) {
				sfour = 20
			}

			// sgp4fix use multiply for speed instead of pow
			const qzms24temp = (120 - sfour) / EARTH_RADIUS
			qzms24 = qzms24temp * qzms24temp * qzms24temp * qzms24temp
			sfour = sfour / EARTH_RADIUS + 1
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
				epochday,
				epochfrac,
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

	sgp4Propagate(satrec, 0)

	satrec.init = 'n'
}
