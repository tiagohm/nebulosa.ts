import type { Angle } from './angle'
import { DAYMIN, DEG2RAD } from './constants'
import { kilometer } from './distance'
import type { OMMJsonObject } from './sgp4/common-types'
import { xpdotp } from './sgp4/constants'
import { twoline2satrec } from './sgp4/io'
import gstime from './sgp4/propagation/gstime'
import { type SatRec, SatRecError, type SatRecInit } from './sgp4/propagation/SatRec'
import propagateSatrec from './sgp4/propagation/sgp4'
import sgp4init from './sgp4/propagation/sgp4init'
import { Timescale, timeYMDHMS, toJulianDay } from './time'
import type { Vec3 } from './vec3'
import { kilometerPerSecond } from './velocity'

// Represents a parsed Two-Line Element set.
export interface TLE {
	readonly name?: string
	readonly line1: string
	readonly line2: string
	readonly satelliteNumber: string
	readonly epochYear: number
	readonly epochDays: number
	readonly epochJulianDay: number
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

// Represents the propagated TEME state in AU and AU/day.
export interface SatelliteState {
	readonly position: Vec3
	readonly velocity: Vec3
}

export type OMM = OMMJsonObject
export type SatelliteRecord = SatRec
export { SatRecError as SatelliteRecordError }

// Parses two TLE lines into a validated structured object.
export function parseTLE(line1: string, line2: string, name?: string) {
	const a = line1.trimEnd().padEnd(69, ' ')
	const b = line2.trimEnd().padEnd(69, ' ')

	if (a[0] !== '1') throw new RangeError('TLE line 1 must start with "1".')
	if (b[0] !== '2') throw new RangeError('TLE line 2 must start with "2".')

	const satelliteNumber = a.substring(2, 7).trim()
	const epochYear = parseInteger(a.substring(18, 20), 'TLE epoch year')
	const epochDays = parseFloatField(a.substring(20, 32), 'TLE epoch day')
	const meanMotionDot = parseFloatField(a.substring(33, 43), 'TLE mean motion dot')
	const meanMotionDdot = parseTleExponent(a.substring(44, 52), 'TLE mean motion ddot')
	const bstar = parseTleExponent(a.substring(53, 61), 'TLE BSTAR')
	const inclination = parseFloatField(b.substring(8, 16), 'TLE inclination') * DEG2RAD
	const rightAscensionOfAscendingNode = parseFloatField(b.substring(17, 25), 'TLE right ascension of ascending node') * DEG2RAD
	const eccentricity = parseFloatField(`0.${b.substring(26, 33).replaceAll(' ', '0')}`, 'TLE eccentricity')
	const argumentOfPerigee = parseFloatField(b.substring(34, 42), 'TLE argument of perigee') * DEG2RAD
	const meanAnomaly = parseFloatField(b.substring(43, 51), 'TLE mean anomaly') * DEG2RAD
	const meanMotion = parseFloatField(b.substring(52, 63), 'TLE mean motion')
	const revolutionNumberAtEpoch = parseOptionalInteger(b.substring(63, 68), 'TLE revolution number at epoch')
	const year = epochYear < 57 ? epochYear + 2000 : epochYear + 1900
	const [month, day, hour, minute, second] = daysToMonthDayHourMinuteSecond(year, epochDays)
	const epochJulianDay = toJulianDay(timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC))

	return {
		name,
		line1: a,
		line2: b,
		satelliteNumber,
		epochYear,
		epochDays,
		epochJulianDay,
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
	} as const
}

// Builds a reusable SGP4 record from parsed TLE elements.
export function recordFromTLE(tle: TLE) {
	return twoline2satrec(tle.line1, tle.line2)
}

// Builds a reusable SGP4 record from an OMM object.
export function recordFromOMM(omm: OMM, opsmode: 'a' | 'i' = 'i') {
	const epoch = parseOmmEpoch(omm.EPOCH)
	const satrec: SatRecInit = {
		error: SatRecError.None,
		satnum: String(omm.NORAD_CAT_ID),
		epochyr: epoch.year % 100,
		epochdays: epoch.epochDays,
		ndot: numericField(omm.MEAN_MOTION_DOT ?? 0, 'OMM mean motion dot'),
		nddot: numericField(omm.MEAN_MOTION_DDOT ?? 0, 'OMM mean motion ddot'),
		bstar: numericField(omm.BSTAR, 'OMM BSTAR'),
		inclo: numericField(omm.INCLINATION, 'OMM inclination') * DEG2RAD,
		nodeo: numericField(omm.RA_OF_ASC_NODE, 'OMM right ascension of ascending node') * DEG2RAD,
		ecco: numericField(omm.ECCENTRICITY, 'OMM eccentricity'),
		argpo: numericField(omm.ARG_OF_PERICENTER, 'OMM argument of pericenter') * DEG2RAD,
		mo: numericField(omm.MEAN_ANOMALY, 'OMM mean anomaly') * DEG2RAD,
		no: numericField(omm.MEAN_MOTION, 'OMM mean motion') / xpdotp,
		jdsatepoch: epoch.julianDay,
	}

	sgp4init(satrec, {
		opsmode,
		satn: satrec.satnum,
		epoch: satrec.jdsatepoch - 2433281.5,
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

// Computes the Vallado GMST used by TEME conversions.
export function temeSiderealTime(julianDayUt1: number) {
	return gstime(julianDayUt1)
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
export function sgp4(julianDay: number, source: TLE | OMM | SatRec) {
	const satrec = isSatRec(source) ? source : isTLE(source) ? recordFromTLE(source) : recordFromOMM(source)
	const result = propagateSatrec(satrec, (julianDay - satrec.jdsatepoch) * DAYMIN)

	if (!result) {
		throw new RangeError(`Satellite propagation failed: ${satelliteRecordErrorMessage(satrec.error)}.`)
	}

	return {
		position: [kilometer(result.position.x), kilometer(result.position.y), kilometer(result.position.z)],
		velocity: [kilometerPerSecond(result.velocity.x), kilometerPerSecond(result.velocity.y), kilometerPerSecond(result.velocity.z)],
	} as const satisfies SatelliteState
}

// Propagates a satellite to the requested Julian day.
export function propagateSatellite(julianDay: number, source: TLE | OMM | SatRec) {
	return sgp4(julianDay, source)
}

function isTLE(source: TLE | OMM | SatRec): source is TLE {
	return 'line1' in source && 'line2' in source
}

function isSatRec(source: TLE | OMM | SatRec): source is SatRec {
	return 'jdsatepoch' in source && 'method' in source
}

function parseInteger(input: string, name: string) {
	const value = Number.parseInt(input.trim(), 10)
	if (!Number.isFinite(value)) throw new RangeError(`Invalid ${name}.`)
	return value
}

function parseOptionalInteger(input: string, name: string) {
	const trimmed = input.trim()
	if (!trimmed) return 0
	return parseInteger(trimmed, name)
}

function parseFloatField(input: string, name: string) {
	const value = Number.parseFloat(input.trim())
	if (!Number.isFinite(value)) throw new RangeError(`Invalid ${name}.`)
	return value
}

function numericField(input: number | string, name: string) {
	if (typeof input === 'number') {
		if (!Number.isFinite(input)) throw new RangeError(`Invalid ${name}.`)
		return input
	}

	const value = Number.parseFloat(input.trim())
	if (!Number.isFinite(value)) throw new RangeError(`Invalid ${name}.`)
	return value
}

function parseTleExponent(input: string, name: string) {
	const trimmed = input.trim()
	if (!trimmed) return 0

	const sign = trimmed[0] === '-' ? '-' : ''
	const mantissaDigits = trimmed.replace(/^[-+]/, '').slice(0, 5)
	const exponent = trimmed.slice(-2)
	const value = Number.parseFloat(`${sign}0.${mantissaDigits}e${exponent}`)
	if (!Number.isFinite(value)) throw new RangeError(`Invalid ${name}.`)
	return value
}

function isLeapYear(year: number) {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
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

function parseOmmEpoch(input: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(?:Z)?$/.exec(input.trim())
	if (!match) throw new RangeError('Invalid OMM epoch.')

	const year = Number.parseInt(match[1]!, 10)
	const month = Number.parseInt(match[2]!, 10)
	const day = Number.parseInt(match[3]!, 10)
	const hour = Number.parseInt(match[4]!, 10)
	const minute = Number.parseInt(match[5]!, 10)
	const second = Number.parseFloat(match[6]!)
	const instant = timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC)
	const julianDay = toJulianDay(instant)
	const startOfYear = toJulianDay(timeYMDHMS(year, 1, 1, 0, 0, 0, Timescale.UTC))

	return {
		year,
		epochDays: julianDay - startOfYear + 1,
		julianDay,
	} as const
}
