import { DEG2RAD } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'

// Parsers for the Minor Planet Center fixed-width orbit formats (MPCORB asteroid lines and CometEls
// comet lines) and the MPC packed-date codec. Angles are converted to radians on parse; distances
// are AU. The structured records feed the KeplerOrbit builders in asteroid.ts.

// https://www.minorplanetcenter.net/iau/info/MPOrbitFormat.html

// MPC comet orbit type marker (CometEls column 5): P periodic, C non-periodic, D defunct/disappeared,
// X uncertain or undetermined orbit, A object on a cometary designation found to be asteroidal,
// I interstellar object.
export type CometOrbitType = 'P' | 'C' | 'D' | 'X' | 'A' | 'I'

// Parsed asteroid orbit record from one MPCORB line.
export interface MPCOrbit {
	// Packed MPC designation.
	readonly designationPacked: string
	// Absolute magnitude H, in mag.
	readonly magnitudeH: number
	// Slope parameter G (dimensionless).
	readonly magnitudeG: number
	// Packed epoch of the osculating elements.
	readonly epochPacked: string
	// Mean anomaly at epoch, radians.
	readonly meanAnomaly: Angle
	// Argument of perihelion, radians.
	readonly argumentOfPerihelion: Angle
	// Longitude of the ascending node, radians.
	readonly longitudeOfAscendingNode: Angle
	// Inclination, radians.
	readonly inclination: Angle
	// Orbital eccentricity.
	readonly eccentricity: number
	// Mean daily motion, degrees/day (as published).
	readonly meanDailyMotion: number
	// Semi-major axis, AU.
	readonly semiMajorAxis: Distance
	// Orbit uncertainty parameter U code.
	readonly uncertainty: string
	// Reference for the orbit.
	readonly reference: string
	// Number of observations used.
	readonly observations: number
	// Number of oppositions.
	readonly oppositions: number
	// Observation arc descriptor (years or day count).
	readonly observationPeriod: string
	// RMS residual of the fit, arcseconds.
	readonly rmsResidual: number
	// Coarse indicator of perturbers.
	readonly coarsePerturbers: string
	// Precise indicator of perturbers.
	readonly precisePerturbers: string
	// Name of the computing program/author.
	readonly computerName: string
	// 4-hex-digit flags field.
	readonly hexFlags: string
	// Readable designation/name.
	readonly designation: string
	// Date of the last observation included.
	readonly lastObservationDate: string
}

// Parsed comet orbit record from one CometEls line.
export interface MPCOrbitComet {
	// Periodic-comet number, if assigned.
	readonly number?: number
	// Orbit type marker.
	readonly orbitType: CometOrbitType
	// Packed MPC designation.
	readonly designationPacked: string
	// Perihelion passage year.
	readonly perihelionYear: number
	// Perihelion passage month (1..12).
	readonly perihelionMonth: number
	// Perihelion passage day (1..31).
	readonly perihelionDay: number
	// Fractional part of the perihelion day.
	readonly perihelionDayFraction: number
	// Perihelion distance, AU.
	readonly perihelionDistance: Distance
	// Orbital eccentricity.
	readonly eccentricity: number
	// Argument of perihelion, radians.
	readonly argumentOfPerihelion: Angle
	// Longitude of the ascending node, radians.
	readonly longitudeOfAscendingNode: Angle
	// Inclination, radians.
	readonly inclination: Angle
	readonly magnitudeG: number // Absolute magnitude
	readonly magnitudeK: number // slope parameter
	// Readable designation/name.
	readonly designation: string
	// readonly reference: string
}

// Extract orbital elements of asteroid given its MPCORB line.
export function mpcorb(line: string): MPCOrbit | undefined {
	if (!line) return undefined

	return {
		designationPacked: parseStringSlice(line, 0, 7),
		magnitudeH: parseNumberSlice(line, 8, 13),
		magnitudeG: parseNumberSlice(line, 14, 19),
		epochPacked: parseStringSlice(line, 20, 25),
		meanAnomaly: parseNumberSlice(line, 26, 35) * DEG2RAD,
		argumentOfPerihelion: parseNumberSlice(line, 37, 46) * DEG2RAD,
		longitudeOfAscendingNode: parseNumberSlice(line, 48, 57) * DEG2RAD,
		inclination: parseNumberSlice(line, 59, 68) * DEG2RAD,
		eccentricity: parseNumberSlice(line, 70, 79),
		meanDailyMotion: parseNumberSlice(line, 80, 91),
		semiMajorAxis: parseNumberSlice(line, 92, 103),
		uncertainty: parseStringSlice(line, 105, 106),
		reference: parseStringSlice(line, 107, 116),
		observations: parseNumberSlice(line, 117, 122),
		oppositions: parseNumberSlice(line, 123, 126),
		observationPeriod: parseStringSlice(line, 127, 136),
		rmsResidual: parseNumberSlice(line, 137, 141),
		coarsePerturbers: parseStringSlice(line, 142, 145),
		precisePerturbers: parseStringSlice(line, 146, 149),
		computerName: parseStringSlice(line, 150, 160),
		hexFlags: parseStringSlice(line, 161, 165),
		designation: parseStringSlice(line, 166, 194),
		lastObservationDate: parseStringSlice(line, 194, 202),
	}
}

// https://www.minorplanetcenter.net/iau/MPCORB/CometEls.txt

// Extract orbital elements of comet given its MPCORB line.
export function mpcorbComet(line: string): MPCOrbitComet | undefined {
	if (!line) return undefined

	return {
		number: parseOptionalNumberSlice(line, 0, 4),
		orbitType: parseCometOrbitType(line),
		designationPacked: parseStringSlice(line, 5, 12),
		perihelionYear: parseNumberSlice(line, 14, 18),
		perihelionMonth: parseNumberSlice(line, 19, 21),
		perihelionDay: parseNumberSlice(line, 22, 24),
		perihelionDayFraction: parseNumberSlice(line, 24, 29),
		perihelionDistance: parseNumberSlice(line, 30, 39),
		eccentricity: parseNumberSlice(line, 41, 49),
		argumentOfPerihelion: parseNumberSlice(line, 51, 59) * DEG2RAD,
		longitudeOfAscendingNode: parseNumberSlice(line, 61, 69) * DEG2RAD,
		inclination: parseNumberSlice(line, 71, 79) * DEG2RAD,
		magnitudeG: parseNumberSlice(line, 91, 95),
		magnitudeK: parseNumberSlice(line, 96, 100),
		designation: parseStringSlice(line, 102, 158),
	}
}

// https://www.minorplanetcenter.net/iau/info/PackedDates.html

// Base-32 alphabet (0-9 then A-V) used by the MPC packed-date encoding.
const PACKED_DATE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUV'
// Number of characters in a packed date (century/decade/year, month, day).
const PACKED_DATE_LENGTH = 5

// Decodes an MPC packed date into [year, month, day]. Throws on malformed input or out-of-range parts.
export function unpackDate(epoch: string) {
	if (epoch.length !== PACKED_DATE_LENGTH) {
		throw new RangeError(`invalid packed date "${epoch}"`)
	}

	const year = 100 * unpackPackedDateChar(epoch.charCodeAt(0)) + 10 * unpackPackedDateDigit(epoch.charCodeAt(1)) + unpackPackedDateDigit(epoch.charCodeAt(2))
	const month = unpackPackedDateChar(epoch.charCodeAt(3))
	const day = unpackPackedDateChar(epoch.charCodeAt(4))

	validatePackedDatePart(month, 1, 12, epoch)
	validatePackedDatePart(day, 1, 31, epoch)

	return [year, month, day] as const
}

// Encodes a Gregorian [year, month, day] into a 5-character MPC packed date. Throws on out-of-range parts.
export function packDate(year: number, month: number, day: number) {
	validatePackedDatePart(year, 0, 3199, `${year}`)
	validatePackedDatePart(month, 1, 12, `${month}`)
	validatePackedDatePart(day, 1, 31, `${day}`)

	const yearInCentury = year % 100
	const a = PACKED_DATE_CHARS[Math.trunc(year / 100)]
	const b = PACKED_DATE_CHARS[Math.trunc(yearInCentury / 10)]
	const c = PACKED_DATE_CHARS[yearInCentury % 10]
	const m = PACKED_DATE_CHARS[month]
	const d = PACKED_DATE_CHARS[day]

	return `${a}${b}${c}${m}${d}`
}

// Parses a fixed-width string field and trims padding.
function parseStringSlice(line: string, start: number, end: number) {
	return line.slice(start, end).trim()
}

// Parses a fixed-width numeric field without allocating a trimmed copy.
function parseNumberSlice(line: string, start: number, end: number) {
	return +line.slice(start, end)
}

// Parses an optional fixed-width numeric field, preserving blanks as undefined.
function parseOptionalNumberSlice(line: string, start: number, end: number) {
	for (let i = start; i < end; i++) {
		if (line.charCodeAt(i) > 32) return +line.slice(start, end)
	}

	return undefined
}

// Parses and validates the comet orbit type marker.
function parseCometOrbitType(line: string): CometOrbitType {
	switch (line.charCodeAt(4)) {
		case 65:
			return 'A'
		case 67:
			return 'C'
		case 68:
			return 'D'
		case 73:
			return 'I'
		case 80:
			return 'P'
		case 88:
			return 'X'
		default:
			throw new RangeError(`invalid comet orbit type "${line.slice(4, 5)}"`)
	}
}

// Decodes a packed-date base-32 character.
function unpackPackedDateChar(code: number) {
	if (code >= 48 && code <= 57) return code - 48
	if (code >= 65 && code <= 86) return code - 55
	throw new RangeError(`invalid packed date character "${String.fromCharCode(code)}"`)
}

// Decodes a decimal year digit from packed-date input.
function unpackPackedDateDigit(code: number) {
	if (code >= 48 && code <= 57) return code - 48
	throw new RangeError(`invalid packed date year digit "${String.fromCharCode(code)}"`)
}

// Validates a packed-date component before encoding/returning it.
function validatePackedDatePart(value: number, min: number, max: number, source: string) {
	if (Number.isInteger(value) && value >= min && value <= max) return
	throw new RangeError(`invalid packed date value "${source}"`)
}
