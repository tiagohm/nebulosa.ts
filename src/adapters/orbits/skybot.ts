import type { Temporal } from '../../astronomy/time/temporal'
import type { Time } from '../../astronomy/time/time'
import { ASEC2RAD, DAYSEC, DEG2RAD } from '../../core/constants'
import { type Angle, parseAngle, toDeg } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'

// Thin client for the IMCCE SkyBoT cone search (https://ssp.imcce.fr/webservices/skybot/api/conesearch/), which lists
// the known solar-system objects in a field of view at an epoch. It builds the request of the non-standard interface
// (epoch as a Julian day, center and radius in degrees, observer as an IAU/MPC observatory code, object classes as a
// three-digit filter), asks for the basic JSON output, and converts every record once to radians, AU, and days: the
// positions are astrometric J2000 equatorial (EQJ2000), as the service computes them. The response, a third-party
// payload, is validated when it is parsed; nothing else is.
//
// The service sees the objects from an observatory known by its IAU code only: although its documentation describes a
// geographic observer ("+latitude, longitude, altitude"), every interface of the service refuses one as an unknown
// observer code. A position seen from any other site is the geocentric one moved by the parallax of that site
// (geocentricToTopocentric of astronomy/coordinates/astrometry), from the geocentric distance the service gives.

// Base URL of the SkyBoT web services.
export const SKYBOT_BASE_URL = 'https://ssp.imcce.fr/webservices/skybot/api/'

// Path of the cone search.
export const CONE_SEARCH_PATH = 'conesearch.php'

// Largest cone radius the service accepts in its non-standard interface, radians (10°).
export const SKYBOT_MAX_RADIUS = 10 * DEG2RAD

// Earliest epoch the service accepts, Julian day (1889-11-13 12h UTC).
export const SKYBOT_MIN_EPOCH = 2411320

// Latest epoch the service accepts, Julian day (2060-03-21 12h UTC).
export const SKYBOT_MAX_EPOCH = 2473540

// Observatory code of the geocenter, the service's default observer.
export const GEOCENTER = '500'

// Julian day of the Unix epoch (1970-01-01 0h UTC).
const UNIX_EPOCH_JD = 2440587.5

// Radians per day of one arcsecond per hour, for the sky motions of the service.
const ARCSEC_PER_HOUR = ASEC2RAD * 24

// Classes of objects a search lists.
export interface SkybotObjectClasses {
	// Asteroids, dwarf planets, and other minor planets.
	readonly asteroids: boolean
	// Planets and their natural satellites.
	readonly planets: boolean
	// Comets.
	readonly comets: boolean
}

// Options of a cone search.
export interface SkybotConeSearchOptions {
	// IAU/MPC code of the observatory the positions are seen from; the geocenter (GEOCENTER) by default.
	readonly observer?: string
	// Classes of objects listed; every class by default.
	readonly objects?: SkybotObjectClasses
	// Largest position uncertainty of a listed object, radians; the service's default (120″) when absent, and no limit
	// when 0.
	readonly maxPositionError?: Angle
}

// A solar-system object a cone search lists.
export interface SkybotObject {
	// Number of a numbered object; absent for an unnumbered one.
	readonly number?: number
	// Name, or provisional designation of an unnamed object, such as "Ceres" or "2017 YJ66".
	readonly name: string
	// Dynamical class, such as "MB>Inner", "NEA>Apollo", "Centaur", or "Comet".
	readonly class: string
	// Astrometric right ascension (J2000 equator), radians in [0, 2π).
	readonly rightAscension: Angle
	// Astrometric declination (J2000 equator), radians.
	readonly declination: Angle
	// Predicted visual magnitude; absent when the service gives none.
	readonly magnitude?: number
	// Uncertainty of the position, radians; absent when the service gives none.
	readonly positionError?: Angle
	// Angular distance from the center of the cone, radians; absent when the service gives none.
	readonly distanceFromCenter?: Angle
	// Motion in right ascension times the cosine of the declination, radians per day; absent when not given.
	readonly motionRightAscension?: number
	// Motion in declination, radians per day; absent when not given.
	readonly motionDeclination?: number
	// Distance from the observer, AU; absent when not given.
	readonly distance?: Distance
	// Distance from the Sun, AU; absent when not given.
	readonly heliocentricDistance?: Distance
}

// Returns the Julian day of an instant: Unix milliseconds (UTC) for a Temporal, or the day and fraction of a Time.
function julianDay(time: Temporal | Time): number {
	return typeof time === 'number' ? time / (DAYSEC * 1000) + UNIX_EPOCH_JD : time.day + time.fraction
}

// Returns the three-digit object filter of the service: asteroids, planets, comets.
function objectFilter({ asteroids, planets, comets }: SkybotObjectClasses) {
	return `${+asteroids}${+planets}${+comets}`
}

// Returns the URL of a cone search around a J2000 center at an instant, radius and angles in radians. The radius and
// the epoch are sent as given; the service refuses those beyond SKYBOT_MAX_RADIUS and outside SKYBOT_MIN_EPOCH to
// SKYBOT_MAX_EPOCH.
export function coneSearchUrl(time: Temporal | Time, rightAscension: Angle, declination: Angle, radius: Angle, options: SkybotConeSearchOptions = {}): string {
	const params = new URLSearchParams({
		'-ep': String(julianDay(time)),
		'-ra': String(toDeg(rightAscension)),
		'-dec': String(toDeg(declination)),
		'-rd': String(toDeg(radius)),
		'-mime': 'json',
		'-output': 'basic',
		'-observer': options.observer ?? GEOCENTER,
		'-objFilter': options.objects === undefined ? '111' : objectFilter(options.objects),
		'-from': 'Nebulosa',
	})

	if (options.maxPositionError !== undefined) params.set('-filter', String(options.maxPositionError / ASEC2RAD))
	return `${SKYBOT_BASE_URL}${CONE_SEARCH_PATH}?${params}`
}

// Returns a field of a record as a finite number; absent when missing or null. Throws on any other value, which a
// SkyBoT response never holds.
function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key]
	if (value === undefined || value === null || value === '') return undefined
	const number = typeof value === 'string' ? Number(value) : value
	if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`SkyBoT field ${key} is not a number`)
	return number
}

// Returns a field of a record as a non-empty string. Throws when it is missing or of another type.
function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key]
	if (typeof value !== 'string' || !value) throw new Error(`SkyBoT field ${key} is missing`)
	return value
}

// Parses one record of the basic JSON output. Throws when a required field is missing or malformed.
function parseRecord(value: unknown): SkybotObject {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('SkyBoT record is not an object')

	const record = value as Record<string, unknown>
	const rightAscension = parseAngle(requiredString(record, 'RA (hms)'), true)
	const declination = parseAngle(requiredString(record, 'DEC (dms)'))
	if (rightAscension === undefined || declination === undefined) throw new Error('SkyBoT position is not sexagesimal')

	const number = optionalNumber(record, 'Num')
	const magnitude = optionalNumber(record, 'VMag (mag)')
	const positionError = optionalNumber(record, 'Err (arcsec)')
	const distanceFromCenter = optionalNumber(record, 'd (arcsec)')
	const motionRightAscension = optionalNumber(record, 'dRA (arcsec/h)')
	const motionDeclination = optionalNumber(record, 'dDEC (arcsec/h)')
	const distance = optionalNumber(record, 'dg (ua)')
	const heliocentricDistance = optionalNumber(record, 'dh (ua)')

	return {
		name: requiredString(record, 'Name'),
		class: typeof record.Class === 'string' ? record.Class : '',
		rightAscension,
		declination,
		...(number !== undefined && { number }),
		...(magnitude !== undefined && { magnitude }),
		...(positionError !== undefined && { positionError: positionError * ASEC2RAD }),
		...(distanceFromCenter !== undefined && { distanceFromCenter: distanceFromCenter * ASEC2RAD }),
		...(motionRightAscension !== undefined && { motionRightAscension: motionRightAscension * ARCSEC_PER_HOUR }),
		...(motionDeclination !== undefined && { motionDeclination: motionDeclination * ARCSEC_PER_HOUR }),
		...(distance !== undefined && { distance }),
		...(heliocentricDistance !== undefined && { heliocentricDistance }),
	}
}

// Parses the basic JSON output of a cone search: an array of records, or nothing (an empty body) when the field holds no
// object. Throws an Error naming the problem when the payload is malformed.
export function parseSkybotResponse(body: unknown): readonly SkybotObject[] {
	if (body === undefined || body === null || body === '') return []
	if (!Array.isArray(body)) throw new Error('SkyBoT response is not an array')
	return body.map(parseRecord)
}

// Lists the known solar-system objects within `radius` of a J2000 center at an instant, all angles in radians, as seen
// from an observatory (the geocenter by default). Performs a network request, aborted by `signal`; rejects with an
// Error on an HTTP failure or a malformed response.
export async function coneSearch(time: Temporal | Time, rightAscension: Angle, declination: Angle, radius: Angle, options?: SkybotConeSearchOptions, signal?: AbortSignal): Promise<readonly SkybotObject[]> {
	const response = await fetch(coneSearchUrl(time, rightAscension, declination, radius, options), { signal })
	// The service answers 204 without a body when no object is in the field.
	if (response.status === 204) return []
	if (!response.ok) throw new Error(`SkyBoT answered ${response.status} ${response.statusText}`)
	const text = await response.text()
	return parseSkybotResponse(text.trim() ? (JSON.parse(text) as unknown) : undefined)
}
