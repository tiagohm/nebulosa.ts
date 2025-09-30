import type { Angle } from './angle'
import { DEG2RAD } from './constants'
import type { Distance } from './distance'

// https://www.minorplanetcenter.net/iau/info/MPOrbitFormat.html

const MPCORB_COLUMNS: readonly [keyof MPCOrbit, number, number][] = [
	['designationPacked', 0, 7],
	['magnitudeH', 8, 13],
	['magnitudeG', 14, 19],
	['epochPacked', 20, 25],
	['meanAnomaly', 26, 35], // degrees
	['argumentOfPerihelion', 37, 46], // degrees
	['longitudeOfAscendingNode', 48, 57], // degrees
	['inclination', 59, 68], // degrees
	['eccentricity', 70, 79],
	['meanDailyMotion', 80, 91], // degrees
	['semiMajorAxis', 92, 103], // AU
	['uncertainty', 105, 106],
	['reference', 107, 116],
	['observations', 117, 122],
	['oppositions', 123, 126],
	['observationPeriod', 127, 136],
	['rmsResidual', 137, 141], // arcseconds
	['coarsePerturbers', 142, 145],
	['precisePerturbers', 146, 149],
	['computerName', 150, 160],
	['hexFlags', 161, 165],
	['designation', 166, 194],
	['lastObservationDate', 194, 202],
]

const MPCORB_COMET_COLUMNS: readonly [keyof MPCOrbitComet, number, number][] = [
	['number', 0, 4],
	['orbitType', 4, 5],
	['designationPacked', 5, 12],
	['perihelionYear', 14, 18],
	['perihelionMonth', 19, 21],
	['perihelionDay', 22, 24],
	['perihelionDayFraction', 24, 29],
	['perihelionDistance', 30, 39], // AU
	['eccentricity', 41, 49],
	['argumentOfPerihelion', 51, 59], // deg
	['longitudeOfAscendingNode', 61, 69], // deg
	['inclination', 71, 79], // deg
	// ['perturbedEpochYear', 81, 85],
	// ['perturbedEpochMonth', 85, 87],
	// ['perturbedEpochDay', 87, 89],
	['magnitudeG', 91, 95],
	['magnitudeK', 96, 100],
	['designation', 102, 158],
	// ['reference', 159, 168],
]

export type CometOrbitType = 'P' | 'C' | 'D'

export interface MPCOrbit {
	readonly designationPacked: string
	readonly magnitudeH: number
	readonly magnitudeG: number
	readonly epochPacked: string
	readonly meanAnomaly: Angle
	readonly argumentOfPerihelion: Angle
	readonly longitudeOfAscendingNode: Angle
	readonly inclination: Angle
	readonly eccentricity: number
	readonly meanDailyMotion: number
	readonly semiMajorAxis: Distance
	readonly uncertainty: string
	readonly reference: string
	readonly observations: number
	readonly oppositions: number
	readonly observationPeriod: string
	readonly rmsResidual: number
	readonly coarsePerturbers: string
	readonly precisePerturbers: string
	readonly computerName: string
	readonly hexFlags: string
	readonly designation: string
	readonly lastObservationDate: string
}

export interface MPCOrbitComet {
	readonly number?: number
	readonly orbitType: CometOrbitType
	readonly designationPacked: string
	readonly perihelionYear: number
	readonly perihelionMonth: number
	readonly perihelionDay: number
	readonly perihelionDayFraction: number
	readonly perihelionDistance: Distance
	readonly eccentricity: number
	readonly argumentOfPerihelion: Angle
	readonly longitudeOfAscendingNode: Angle
	readonly inclination: Angle
	readonly magnitudeG: number // Absolute magnitude
	readonly magnitudeK: number // slope parameter
	readonly designation: string
	// readonly reference: string
}

// Extract orbital elements of asteroid given its MPCORB line.
export function mpcorb(line: string) {
	if (!line) return undefined

	const data = {} as Record<keyof MPCOrbit, string | number>

	for (const item of MPCORB_COLUMNS) {
		const value = line.substring(item[1], item[2])
		data[item[0]] = value.trim()
	}

	data.magnitudeH = +data.magnitudeH
	data.magnitudeG = +data.magnitudeG
	data.meanAnomaly = +data.meanAnomaly * DEG2RAD
	data.argumentOfPerihelion = +data.argumentOfPerihelion * DEG2RAD
	data.longitudeOfAscendingNode = +data.longitudeOfAscendingNode * DEG2RAD
	data.inclination = +data.inclination * DEG2RAD
	data.eccentricity = +data.eccentricity
	data.meanDailyMotion = +data.meanDailyMotion
	data.semiMajorAxis = +data.semiMajorAxis
	data.observations = +data.observations
	data.oppositions = +data.oppositions
	data.rmsResidual = +data.rmsResidual

	return data as MPCOrbit
}

// https://www.minorplanetcenter.net/iau/MPCORB/CometEls.txt

// Extract orbital elements of comet given its MPCORB line.
export function mpcorbComet(line: string) {
	if (!line) return undefined

	const data = {} as Record<keyof MPCOrbitComet, string | number>

	for (const item of MPCORB_COMET_COLUMNS) {
		const value = line.substring(item[1], item[2])
		data[item[0]] = value.trim()
	}

	data.magnitudeG = +data.magnitudeG
	data.magnitudeK = +data.magnitudeK
	data.perihelionYear = +data.perihelionYear
	data.perihelionMonth = +data.perihelionMonth
	data.perihelionDay = +data.perihelionDay
	data.perihelionDayFraction = +data.perihelionDayFraction || 0
	data.argumentOfPerihelion = +data.argumentOfPerihelion * DEG2RAD
	data.longitudeOfAscendingNode = +data.longitudeOfAscendingNode * DEG2RAD
	data.inclination = +data.inclination * DEG2RAD
	data.eccentricity = +data.eccentricity
	data.perihelionDistance = +data.perihelionDistance

	return data as MPCOrbitComet
}

// https://www.minorplanetcenter.net/iau/info/PackedDates.html

const PACKED_DATE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUV'

export function unpackDate(epoch: string) {
	const year = 100 * n(epoch.charCodeAt(0)) + +epoch.substring(1, 3)
	return [year, n(epoch.charCodeAt(3)), n(epoch.charCodeAt(4))] as const
}

export function packDate(year: number, month: number, day: number) {
	const a = PACKED_DATE_CHARS[Math.trunc(year / 100)]
	const b = `${year % 100}`.padStart(2, '0')
	const m = PACKED_DATE_CHARS[month]
	const d = PACKED_DATE_CHARS[day]
	return `${a}${b}${m}${d}`
}

function n(code: number) {
	return code - (code >= 65 ? 55 : 48)
}
