import { DATE_FORMAT, formatTemporal, type Temporal, temporalNow } from '../../astronomy/time/temporal'
import type { Time } from '../../astronomy/time/time'
import { DEG2RAD } from '../../core/constants'
import { type Angle, type FormatAngleOptions, formatAngle, toDeg } from '../../math/units/angle'
import { type Distance, toKilometer } from '../../math/units/distance'

// Thin client for the JPL Solar System Dynamics small-body web services: the SBDB lookup (search),
// the sb_ident field-of-view identification, and the close-approach data (CAD) endpoint. The
// interfaces mirror the JSON response shapes; the functions build the request URLs (converting angles
// to degrees, distances to km, and formatting the FOV/epoch) and return the parsed JSON.

// Base URL of all JPL SSD/CNEOS API endpoints.
export const SBD_BASE_URL = 'https://ssd-api.jpl.nasa.gov/'

// Query path and fixed parameters for the SBDB object/orbit/physical-parameter lookup.
export const SEARCH_PATH = 'sbdb.api?alt-des=1&alt-orbits=1&ca-data=1&ca-time=both&ca-tunc=both&cd-epoch=1&cd-tp=1&discovery=1&full-prec=1&nv-fmt=both&orbit-defs=1&phys-par=1&r-notes=1&r-observer=1&radar-obs=1&sat=1&vi-data=1&www=1'
// Query path for the two-pass small-body identification service.
export const IDENTIFY_PATH = 'sb_ident.api?two-pass=true&suppress-first-pass=true'
// Query path for the close-approach data service.
export const CLOSE_APPROACHES_PATH = 'cad.api?neo=false&diameter=true&fullname=true'

// Angle format for the FOV right-ascension center expected by sb_ident (hours, '-'-separated).
const FOV_RA_FORMAT: FormatAngleOptions = { isHour: true, separators: '-', minusSign: 'M', noSign: true, fractionDigits: 2 }
// Angle format for the FOV declination center expected by sb_ident (degrees, '-'-separated).
const FOV_DEC_FORMAT: FormatAngleOptions = { separators: '-', minusSign: 'M', plusSign: '', fractionDigits: 2 }

// Observation-time format string accepted by the sb_ident endpoint.
const DATE_TIME_FORMAT = 'YYYY-MM-DD_HH:mm:ss'

// Provenance block returned with every API response (API version and source database).
export interface Signature {
	readonly version: string
	readonly source: string
}

// https://ssd-api.jpl.nasa.gov/doc/sbdb.html

// Object-identity block of an SBDB search result.
export interface SmallBodySearchObject {
	readonly orbit_id: string
	readonly orbit_class: {
		readonly name: string
		readonly code: string
	}
	// True if a near-Earth object.
	readonly neo: boolean
	// True if a potentially hazardous asteroid.
	readonly pha: boolean
	readonly des_alt: string[]
	// Object kind: 'a' asteroid / 'c' comet, suffixed 'n' numbered / 'u' unnumbered.
	readonly kind: 'an' | 'au' | 'cn' | 'cu'
	readonly fullname: string
	readonly shortname: string
	readonly prefix: string
	readonly des: string
	// SPICE kernel ID of the body.
	readonly spkid: string
}

// SBDB orbital-element identifiers (e eccentricity, a semi-major axis, q perihelion, i inclination,
// om node, w argument of perihelion, ma mean anomaly, tp time of perihelion, per period, n mean motion, ...).
export type SmallBodySearchOrbitElementName = 'e' | 'a' | 'q' | 'i' | 'om' | 'w' | 'ma' | 'tp' | 'cd_tp' | 'per' | 'n' | 'a_D' | 'dn_dt'

// One published orbital element with its value, 1-sigma uncertainty, and units (all as strings).
export interface SmallBodySearchOrbitElement {
	readonly sigma: string | null
	readonly title: string
	readonly name: SmallBodySearchOrbitElementName
	readonly units: string | null
	readonly value: string | null
	readonly label: string
}

// Orbit-solution block of an SBDB search result (epochs, fit statistics, and the element list).
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

// One measured physical parameter (e.g. diameter, albedo, rotation period) with value and units.
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

// SBDB response when a single body is matched: identity, orbit, physical parameters, and signature.
export interface SmallBodySearchFound {
	readonly object: SmallBodySearchObject
	readonly orbit: SmallBodySearchOrbit
	readonly signature: Signature
	readonly phys_par: SmallBodySearchPhyscalParameter[]
}

// One ambiguous-match entry (packed designation and readable name).
export interface SmallBodySearchListItem {
	readonly pdes: string
	readonly name: string
}

// SBDB response when several bodies match the query string.
export interface SmallBodySearchList {
	readonly list: SmallBodySearchListItem[]
}

// SBDB response carrying an informational/error message instead of a result.
export interface SmallBodySearchMessage {
	readonly message: string
}

// Union of the three possible SBDB search outcomes.
export type SmallBodySearch = SmallBodySearchFound | SmallBodySearchList | SmallBodySearchMessage

// https://ssd-api.jpl.nasa.gov/doc/sb_ident.html

// First-pass identification result: candidate count, column names, and tabular rows.
export interface SmallBodyIdentifyFirstPass {
	readonly n_first_pass: number
	readonly fields_first: readonly string[]
	readonly data_first_pass: readonly string[][]
}

// Second-pass identification result: refined candidate count, column names, and tabular rows.
export interface SmallBodyIdentifySecondPass {
	readonly n_second_pass: number
	readonly fields_second: readonly string[]
	readonly data_second_pass: readonly string[][]
}

// Union of the two sb_ident pass results.
export type SmallBodyIdentify = SmallBodyIdentifyFirstPass | SmallBodyIdentifySecondPass

// https://ssd-api.jpl.nasa.gov/doc/cad.html

// CAD table column identifiers (designation, close-approach epoch, distances in AU, relative/infinite
// velocities in km/s, absolute magnitude h, diameter in km, etc.).
export type SmallBodyCloseApproachField = 'des' | 'orbit_id' | 'jd' | 'cd' | 'dist' | 'dist_min' | 'dist_max' | 'v_rel' | 'v_inf' | 't_sigma_f' | 'h' | 'diameter' | 'diameter_sigma' | 'fullname'

// Close-approach query result: row count, column names, and tabular rows (all values as strings).
export interface SmallBodyCloseApproach {
	readonly signature: Signature
	readonly count: number
	readonly fields: readonly SmallBodyCloseApproachField[]
	readonly data: readonly string[][]
}

// Searches the SBDB for small bodies matching `text` (name or designation). Returns a single match,
// a list of candidates, or a message. Performs a network request.
export async function search(text: string) {
	const uri = `${SBD_BASE_URL}${SEARCH_PATH}&sstr=${encodeURIComponent(text)}`
	const response = await fetch(uri)
	return (await response.json()) as SmallBodySearch
}

// Identifies small bodies within a field of view at a given time and observing site. `longitude`,
// `latitude`, `fovRa`, `fovDec`, and the FOV half-widths are radians; `elevation` is a Distance;
// `magLimit` is the limiting V magnitude. Performs a network request.
export async function identify(dateTime: Temporal | Time, longitude: Angle, latitude: Angle, elevation: Distance, fovRa: Angle, fovDec: Angle, fovRaWidth: number = DEG2RAD, fovDecWidth: number = fovRaWidth, magLimit: number = 18, magRequired: boolean = true) {
	const obsTime = typeof dateTime === 'number' ? formatTemporal(dateTime, DATE_TIME_FORMAT) : dateTime.day + dateTime.fraction
	const uri = `${SBD_BASE_URL}${IDENTIFY_PATH}&obs-time=${obsTime}&lat=${toDeg(latitude)}&lon=${toDeg(longitude)}&alt=${toKilometer(elevation)}&fov-ra-center=${formatAngle(fovRa, FOV_RA_FORMAT)}&fov-dec-center=${formatAngle(fovDec, FOV_DEC_FORMAT)}&fov-ra-hwidth=${toDeg(fovRaWidth)}&fov-dec-hwidth=${toDeg(fovDecWidth)}&vmag-lim=${magLimit}&mag-required=${magRequired && magLimit < 30}`
	const response = await fetch(uri)
	return (await response.json()) as SmallBodyIdentify
}

// Retrieves close approaches of small bodies to Earth between `dateMin` (default now) and `dateMax`
// (a date or a relative `${n}d` span, default 7 days), within `distance` lunar distances (default 10).
// Performs a network request.
export async function closeApproaches(dateMin?: Temporal | 'now', dateMax: Temporal | `${number}d` = '7d', distance: number = 10) {
	dateMin = !dateMin || dateMin === 'now' ? temporalNow() : dateMin
	const uri = `${SBD_BASE_URL}${CLOSE_APPROACHES_PATH}&date-min=${formatTemporal(dateMin, DATE_FORMAT)}&date-max=${typeof dateMax === 'string' ? `%2B${dateMax.slice(0, dateMax.length - 1)}` : formatTemporal(dateMax, DATE_FORMAT)}&dist-max=${distance}LD`
	const response = await fetch(uri)
	return (await response.json()) as SmallBodyCloseApproach
}
