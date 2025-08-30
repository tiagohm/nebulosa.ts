import { type Angle, type FormatAngleOptions, formatAngle, toDeg } from './angle'
import { DEG2RAD } from './constants'
import { type Distance, toKilometer } from './distance'
import { formatTemporal, type Temporal, temporalNow } from './temporal'
import type { Time } from './time'

export const SBD_BASE_URL = 'https://ssd-api.jpl.nasa.gov/'

export const SEARCH_PATH = 'sbdb.api?alt-des=1&alt-orbits=1&ca-data=1&ca-time=both&ca-tunc=both&cd-epoch=1&cd-tp=1&discovery=1&full-prec=1&nv-fmt=both&orbit-defs=1&phys-par=1&r-notes=1&r-observer=1&radar-obs=1&sat=1&vi-data=1&www=1'
export const IDENTIFY_PATH = 'sb_ident.api?two-pass=true&suppress-first-pass=true'
export const CLOSE_APPROACHES_PATH = 'cad.api?neo=false&diameter=true&fullname=true'

const FOV_RA_FORMAT: FormatAngleOptions = { isHour: true, separators: '-', minusSign: 'M', noSign: true, fractionDigits: 2 }
const FOV_DEC_FORMAT: FormatAngleOptions = { separators: '-', minusSign: 'M', plusSign: '', fractionDigits: 2 }

const DATE_FORMAT = Intl.DateTimeFormat('zu-ZA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: undefined, minute: undefined, second: undefined, fractionalSecondDigits: undefined })
const DATE_TIME_FORMAT = Intl.DateTimeFormat('zu-ZA', { timeZone: 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: undefined })

export interface Signature {
	readonly version: string
	readonly source: string
}

// https://ssd-api.jpl.nasa.gov/doc/sbdb.html

export interface SmallBodySearchObject {
	readonly orbit_id: string
	readonly orbit_class: {
		readonly name: string
		readonly code: string
	}
	readonly neo: boolean
	readonly pha: boolean
	readonly des_alt: string[]
	readonly kind: 'an' | 'au' | 'cn' | 'cu'
	readonly fullname: string
	readonly shortname: string
	readonly prefix: string
	readonly des: string
	readonly spkid: string
}

export type SmallBodySearchOrbitElementName = 'e' | 'a' | 'q' | 'i' | 'om' | 'w' | 'ma' | 'tp' | 'cd_tp' | 'per' | 'n' | 'a_D' | 'dn_dt'

export interface SmallBodySearchOrbitElement {
	readonly sigma: string | null
	readonly title: string
	readonly name: SmallBodySearchOrbitElementName
	readonly units: string | null
	readonly value: string | null
	readonly label: string
}

export interface SmallBodySearchOrbit {
	readonly first_obs: string
	readonly pe_used: string
	// readonly two_body: string
	readonly equinox: string
	readonly cov_epoch: string
	readonly last_obs: string
	readonly soln_date: string
	readonly n_del_obs_used: number | null
	readonly t_jup: string
	readonly epoch: string
	readonly comment: string | null
	readonly rms: string
	readonly n_dop_obs_used: number | null
	readonly orbit_id: string
	readonly moid_jup: string
	readonly n_obs_used: number
	readonly not_valid_after: string | null
	readonly data_arc: string
	readonly producer: string
	readonly moid: string
	readonly sb_used: string
	readonly source: string
	readonly epoch_cd: string
	readonly elements: SmallBodySearchOrbitElement[]
}

export interface SmallBodySearchPhyscalParameter {
	readonly desc: string
	readonly value: string
	readonly notes: string
	readonly ref: string
	readonly title: string
	readonly sigma: string
	readonly units: string | null
	readonly name: string
}

export interface SmallBodySearchFound {
	readonly object: SmallBodySearchObject
	readonly orbit: SmallBodySearchOrbit
	readonly signature: Signature
	readonly phys_par: SmallBodySearchPhyscalParameter[]
}

export interface SmallBodySearchListItem {
	readonly pdes: string
	readonly name: string
}

export interface SmallBodySearchList {
	readonly list: SmallBodySearchListItem[]
}

export interface SmallBodySearchMessage {
	readonly message: string
}

export type SmallBodySearch = SmallBodySearchFound | SmallBodySearchList | SmallBodySearchMessage

// https://ssd-api.jpl.nasa.gov/doc/sb_ident.html

export interface SmallBodyIdentifyFirstPass {
	readonly n_first_pass: number
	readonly fields_first: readonly string[]
	readonly data_first_pass: readonly string[][]
}

export interface SmallBodyIdentifySecondPass {
	readonly n_second_pass: number
	readonly fields_second: readonly string[]
	readonly data_second_pass: readonly string[][]
}

export type SmallBodyIdentify = SmallBodyIdentifyFirstPass | SmallBodyIdentifySecondPass

// https://ssd-api.jpl.nasa.gov/doc/cad.html

export type SmallBodyCloseApproachField = 'des' | 'orbit_id' | 'jd' | 'cd' | 'dist' | 'dist_min' | 'dist_max' | 'v_rel' | 'v_inf' | 't_sigma_f' | 'h' | 'diameter' | 'diameter_sigma' | 'fullname'

export interface SmallBodyCloseApproach {
	readonly signature: Signature
	readonly count: number
	readonly fields: readonly SmallBodyCloseApproachField[]
	readonly data: readonly string[][]
}

// Searches for small bodies by name or designation
export async function search(text: string) {
	const uri = `${SBD_BASE_URL}${SEARCH_PATH}&sstr=${encodeURIComponent(text)}`
	const response = await fetch(uri)
	return (await response.json()) as SmallBodySearch
}

// Identifies small bodies in a given field of view around a specific coordinate, location and time
export async function identify(dateTime: Temporal | Time, longitude: Angle, latitude: Angle, elevation: Distance, fovRa: Angle, fovDec: Angle, fovRaWidth: number = DEG2RAD, fovDecWidth: number = fovRaWidth, magLimit: number = 18, magRequired: boolean = true) {
	const obsTime = typeof dateTime === 'number' ? formatTemporal(dateTime, DATE_TIME_FORMAT).replace(' ', '_') : dateTime.day + dateTime.fraction
	const uri = `${SBD_BASE_URL}${IDENTIFY_PATH}&obs-time=${obsTime}&lat=${toDeg(latitude)}&lon=${toDeg(longitude)}&alt=${toKilometer(elevation)}&fov-ra-center=${formatAngle(fovRa, FOV_RA_FORMAT)}&fov-dec-center=${formatAngle(fovDec, FOV_DEC_FORMAT)}&fov-ra-hwidth=${toDeg(fovRaWidth)}&fov-dec-hwidth=${toDeg(fovDecWidth)}&vmag-lim=${magLimit}&mag-required=${magRequired && magLimit < 30}`
	const response = await fetch(uri)
	return (await response.json()) as SmallBodyIdentify
}

// Retrieves close approaches of small bodies to Earth
export async function closeApproaches(dateMin?: Temporal | 'now', dateMax: Temporal | `${number}d` = '7d', distance: number = 10) {
	dateMin = !dateMin || dateMin === 'now' ? temporalNow() : dateMin
	const uri = `${SBD_BASE_URL}${CLOSE_APPROACHES_PATH}&date-min=${formatTemporal(dateMin, DATE_FORMAT)}&date-max=${typeof dateMax === 'string' ? `%2B${dateMax.substring(0, dateMax.length - 1)}` : formatTemporal(dateMax, DATE_FORMAT)}&dist-max=${distance}LD`
	const response = await fetch(uri)
	return (await response.json()) as SmallBodyCloseApproach
}
