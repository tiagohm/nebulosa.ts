import { DATE_FORMAT, formatTemporal, temporalAdd, type Temporal, temporalNow } from '../../astronomy/time/temporal'
import type { Time } from '../../astronomy/time/time'
import { DEG2RAD } from '../../core/constants'
import { type Angle, type FormatAngleOptions, formatAngle, toDeg } from '../../math/units/angle'
import { type Distance, toKilometer } from '../../math/units/distance'

// Thin client for the JPL Solar System Dynamics small-body web services: the SBDB lookup (search),
// the sb_ident field-of-view identification, and the close-approach data (CAD) endpoint. The
// interfaces mirror the JSON response shapes; the functions build the request URLs (converting angles
// to degrees, distances to km, and formatting the FOV/epoch) and return the parsed JSON. A caller that
// owns its transport pairs closeApproachesUrl with parseCloseApproaches, which reads the CAD table by
// column name and rejects a payload it cannot trust.

// Base URL of all JPL SSD/CNEOS API endpoints.
export const SBD_BASE_URL = 'https://ssd-api.jpl.nasa.gov/'

// Query path and fixed parameters for the SBDB object/orbit/physical-parameter lookup.
export const SEARCH_PATH = 'sbdb.api?alt-des=1&alt-orbits=1&ca-data=1&ca-time=both&ca-tunc=both&cd-epoch=1&cd-tp=1&discovery=1&full-prec=1&nv-fmt=both&orbit-defs=1&phys-par=1&r-notes=1&r-observer=1&radar-obs=1&sat=1&vi-data=1&www=1'
// Query path for the two-pass small-body identification service.
export const IDENTIFY_PATH = 'sb_ident.api?two-pass=true&suppress-first-pass=true'
// Query path for the close-approach data service.
export const CLOSE_APPROACHES_PATH = 'cad.api?neo=false&diameter=true&fullname=true'
// Query path of a paged close-approach query, with the optional columns every row needs.
const CLOSE_APPROACH_QUERY_PATH = 'cad.api?diameter=true&fullname=true'

// Major version of the CAD and SBDB formats this module reads; a minor version only adds to them.
const SUPPORTED_MAJOR_VERSION = '1'

// CAD columns without which a row cannot be read.
const REQUIRED_CLOSE_APPROACH_FIELDS: readonly SmallBodyCloseApproachField[] = ['des', 'orbit_id', 'jd', 'cd', 'dist', 'v_rel']

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

// One alternate designation entry returned by SBDB, with one designation kind per object.
export interface SmallBodySearchAlternateDesignation {
	// Standard designation for the body.
	readonly des?: string
	// Primary designation for the body.
	readonly pri?: string
	// Component designation for the body.
	readonly com?: string
	// Related name for the body.
	readonly rn?: string
	// Year-letter designation for the body.
	readonly yl?: string
}

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
	readonly des_alt: SmallBodySearchAlternateDesignation[]
	// Object kind: 'a' asteroid / 'c' comet, suffixed 'n' numbered / 'u' unnumbered.
	readonly kind: 'an' | 'au' | 'cn' | 'cu'
	readonly fullname: string
	readonly shortname: string
	readonly prefix: string | null
	readonly des: string
	// SPICE kernel ID of the body.
	readonly spkid: string
	// Osculating elements of the current epoch as packed text, used by the SBDB viewer; absent for some bodies.
	readonly ov_par?: string
}

// SBDB orbital-element identifiers (e eccentricity, a semi-major axis, q perihelion, i inclination,
// om node, w argument of perihelion, ma mean anomaly, tp time of perihelion, tp_cd calendar date of
// perihelion, per period, n mean motion, and ad aphelion distance).
export type SmallBodySearchOrbitElementName = 'e' | 'a' | 'q' | 'i' | 'om' | 'w' | 'ma' | 'tp' | 'tp_cd' | 'per' | 'n' | 'ad'

// One published orbital element with its value, 1-sigma uncertainty, and units (all as strings).
export interface SmallBodySearchOrbitElement {
	readonly sigma: string | null
	readonly title: string
	readonly name: SmallBodySearchOrbitElementName
	readonly units: string | null
	readonly value: string | null
	readonly label: string
}

// One fitted or assumed force-model parameter of an orbit solution, such as a non-gravitational acceleration.
export interface SmallBodySearchModelParameter {
	readonly name: string
	readonly title: string
	readonly desc: string
	// EST for an estimated parameter, otherwise how it was set.
	readonly kind: string
	readonly units: string | null
	readonly value: string | null
	// 1-sigma uncertainty; null when the parameter was not estimated.
	readonly sigma: string | null
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
	// JPL orbit condition code, 0 (best determined) to 9; absent for some solutions.
	readonly condition_code?: string | null
	// First valid date of a solution with a limited validity; null when it has none.
	readonly not_valid_before?: string | null
	// Force-model parameters of the solution; absent or empty when it has none.
	readonly model_pars?: readonly SmallBodySearchModelParameter[]
}

// One measured physical parameter (e.g. diameter, albedo, rotation period) with value and units.
export interface SmallBodySearchPhyscalParameter {
	readonly desc: string
	readonly value: string
	readonly notes: string | null
	readonly ref: string | null
	readonly title: string
	readonly sigma: string | null
	readonly units: string | null
	readonly name: string
}

// Discovery circumstances of a body, each field as published when known.
export interface SmallBodySearchDiscovery {
	readonly date?: string | null
	readonly location?: string | null
	readonly site?: string | null
	readonly who?: string | null
	readonly name?: string | null
	// Narrative of the discovery.
	readonly discovery?: string | null
	// Citation of the name.
	readonly citation?: string | null
	readonly ref?: string | null
	readonly cref?: string | null
}

// One radar astrometry measurement, as published: a delay or a Doppler shift, by its units.
export interface SmallBodySearchRadarObservation {
	// UTC epoch of the measurement.
	readonly epoch: string
	readonly value: string
	// 1-sigma uncertainty.
	readonly sigma: string | null
	// Units of the value and sigma: us for a delay, Hz for a Doppler shift.
	readonly units: string
	// Transmitter frequency in MHz.
	readonly freq: string | null
	// Point on the body measured: C center of mass, otherwise the peak of the echo.
	readonly bp: string | null
	readonly observer: string | null
	readonly rcvr: string | null
	readonly xmit: string | null
	readonly notes: string | null
}

// One known satellite of a body; the orbits of the satellite are not read.
export interface SmallBodySearchSatellite {
	readonly fullname: string | null
	readonly iau_name: string | null
	readonly iau_num: number | null
	readonly prov_des: string | null
	readonly year: string | null
	// Y when the satellite is confirmed.
	readonly confirmed: string | null
	readonly ref: string | null
	readonly notes: string | null
}

// One virtual impactor of the JPL Sentry risk table, as published through SBDB; every value is text and may be null.
export interface SmallBodySearchVirtualImpactor {
	// Date of the potential impact (TDB calendar day with a decimal fraction).
	readonly date: string
	// Impact probability.
	readonly ip: string
	// Palermo scale.
	readonly ps: string | null
	// Torino scale.
	readonly ts: string | null
	// Impact energy in megatons of TNT.
	readonly energy: string | null
	// Mass in kg.
	readonly mass: string | null
	// Diameter in km.
	readonly diam: string | null
	readonly h: string | null
	// Velocities at infinity and at impact in km/s.
	readonly v_inf: string | null
	readonly v_imp: string | null
	// Search method of the Sentry solution.
	readonly method: string | null
}

// Definition of one orbit field: its title, description, and units.
export interface SmallBodySearchOrbitDefinition {
	readonly title: string
	readonly description: string
	readonly units: string | null
}

// SBDB response when a single body is matched: identity, orbit, physical parameters, and signature.
// The ancillary blocks are present when the query asks for them, as SEARCH_PATH does, and empty when the body has none.
export interface SmallBodySearchFound {
	readonly object: SmallBodySearchObject
	readonly orbit: SmallBodySearchOrbit
	readonly signature: Signature
	readonly phys_par: SmallBodySearchPhyscalParameter[]
	readonly discovery?: SmallBodySearchDiscovery
	// Earlier orbit solutions of a comet, sorted by epoch.
	readonly alt_orbits?: readonly SmallBodySearchOrbit[]
	readonly radar_obs?: readonly SmallBodySearchRadarObservation[]
	readonly sat?: readonly SmallBodySearchSatellite[]
	readonly vi_data?: readonly SmallBodySearchVirtualImpactor[]
	readonly orbit_defs?: Readonly<Record<string, SmallBodySearchOrbitDefinition>>
	// Every close approach of the body, as published; cad.api gives them paged and filtered.
	readonly ca_data?: readonly Readonly<Record<string, string | number | null>>[]
}

// One ambiguous-match entry (packed designation and readable name).
export interface SmallBodySearchListItem {
	readonly pdes: string
	readonly name: string
}

// SBDB response when several bodies match the query string.
export interface SmallBodySearchList {
	readonly list: SmallBodySearchListItem[]
	// Optional message returned when the query matches multiple bodies.
	readonly message?: string
	// Optional status code associated with the response.
	readonly code?: string
	// Optional number of matching bodies reported by the service.
	readonly count?: number
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
export type SmallBodyCloseApproachField = 'des' | 'orbit_id' | 'jd' | 'cd' | 'dist' | 'dist_min' | 'dist_max' | 'v_rel' | 'v_inf' | 't_sigma_f' | 'body' | 'h' | 'diameter' | 'diameter_sigma' | 'fullname'

// Close-approach query result: row count, column names, and tabular rows (all values as strings).
export interface SmallBodyCloseApproach {
	readonly signature: Signature
	readonly count: number
	readonly fields: readonly SmallBodyCloseApproachField[]
	readonly data: readonly string[][]
}

// Wire-level CAD response, whose table fields are omitted when count is zero.
type SmallBodyCloseApproachResponse = Omit<SmallBodyCloseApproach, 'fields' | 'data'> & Partial<Pick<SmallBodyCloseApproach, 'fields' | 'data'>>

// CAD target body selector: Earth, the Moon, a planet, Pluto, or every body.
export type CloseApproachBody = 'Earth' | 'Moon' | 'Merc' | 'Venus' | 'Mars' | 'Juptr' | 'Satrn' | 'Urnus' | 'Neptn' | 'Pluto' | 'ALL'

// CAD sort column.
export type CloseApproachSortField = 'date' | 'dist' | 'dist-min' | 'v-inf' | 'v-rel' | 'h' | 'object'

// CAD sort order: a column, descending with a leading '-'.
export type CloseApproachSort = CloseApproachSortField | `-${CloseApproachSortField}`

// Parameters of every paged close-approach query.
interface CloseApproachQueryBase {
	// First day, YYYY-MM-DD. CAD reads it as TDB at 00:00, as probed; its documentation does not state the scale.
	readonly dateMin: string
	// Last day, YYYY-MM-DD, included whole.
	readonly dateMax: string
	// Target body.
	readonly body: CloseApproachBody
	// Largest nominal distance, in `distanceUnit`. CAD filters by 0.05 au when told nothing, even for one object.
	readonly distanceMax: number
	// Unit of `distanceMax`: au, or LD (1 LD = 384400 km for JPL).
	readonly distanceUnit: 'au' | 'LD'
	// Order of the rows.
	readonly sort: CloseApproachSort
	// Rows of the page, positive.
	readonly limit: number
	// Rows skipped before the page, 0 for the first one. CAD documents limit-from as a record number, but it is an offset.
	readonly offset: number
}

// Query of the close approaches of every object. A boolean filter only narrows the result when true: neoOnly false
// lifts the NEO filter CAD applies by default, it does not select the bodies that are not NEOs.
export interface CloseApproachCatalogQuery extends CloseApproachQueryBase {
	// Selects the query.
	readonly selector: 'catalog'
	// Only near-Earth objects.
	readonly neoOnly?: boolean
	// Only potentially hazardous asteroids.
	readonly phaOnly?: boolean
	// Only asteroids (a) or comets (c).
	readonly kind?: 'a' | 'c'
	// Smallest absolute magnitude H.
	readonly hMin?: number
	// Largest absolute magnitude H.
	readonly hMax?: number
}

// Query of the close approaches of one object. CAD refuses the NEO filter here, with a 400.
export interface CloseApproachObjectQuery extends CloseApproachQueryBase {
	// Selects the query.
	readonly selector: 'spk'
	// SPK-ID of the object.
	readonly spkId: string
}

// Paged close-approach query.
export type CloseApproachQuery = CloseApproachCatalogQuery | CloseApproachObjectQuery

// One close approach read from CAD. Numbers are parsed; a value CAD does not publish is absent, never 0.
export interface CloseApproachRow {
	// Designation; CAD rows carry no SPK-ID.
	readonly designation: string
	// Full name, without the alignment spaces of the source.
	readonly fullName?: string
	// CAD orbit solution id, not an SPK-ID.
	readonly orbitId: string
	// Target body; absent unless the query asked for every body.
	readonly body?: string
	// Julian date TDB of the approach, as published, so no digit is lost.
	readonly jd: string
	// Calendar date of the approach in TDB as published, such as 2029-Apr-13 21:46; not UTC.
	readonly calendarDate: string
	// Nominal distance in AU.
	readonly distance: number
	// Lower bound of the distance in AU (3-sigma).
	readonly distanceMin?: number
	// Upper bound of the distance in AU (3-sigma).
	readonly distanceMax?: number
	// Velocity relative to the target at the approach in km/s.
	readonly relativeVelocity: number
	// Velocity relative to a massless target at infinity in km/s.
	readonly infiniteVelocity?: number
	// 3-sigma uncertainty of the time as published, such as < 00:01 or 2_03:17 (days_hours:minutes).
	readonly timeUncertainty?: string
	// Absolute magnitude H; absent for most comets.
	readonly absoluteMagnitude?: number
	// Measured diameter in km.
	readonly diameter?: number
	// 1-sigma uncertainty of the diameter in km.
	readonly diameterSigma?: number
}

// One page of a close-approach query.
export interface CloseApproachPage {
	// Version and source of the response.
	readonly signature: Signature
	// Rows matching the query, beyond this page.
	readonly total: number
	// Rows of the page; empty past the last page, while `total` still counts the matches.
	readonly rows: readonly CloseApproachRow[]
}

// Reason an SSD response cannot be read: a format of another major version, or a payload that breaks its own format.
export type SmallBodyResponseErrorKind = 'unsupportedVersion' | 'malformed'

// An SSD response this module does not trust, rejected rather than read as a plausible wrong value.
export class SmallBodyResponseError extends Error {
	// Creates the error; `version` is the signature version of the response, when it has one.
	constructor(
		readonly kind: SmallBodyResponseErrorKind,
		message: string,
		readonly version?: string,
	) {
		super(message)
		this.name = 'SmallBodyResponseError'
	}
}

// Rejects with SmallBodyResponseError a signature absent or of a major version this module does not read.
export function assertSupportedSignature(signature: Partial<Signature> | undefined) {
	const version = signature?.version
	if (typeof version !== 'string') throw new SmallBodyResponseError('malformed', 'the response has no signature')
	if (version.split('.')[0] !== SUPPORTED_MAJOR_VERSION) throw new SmallBodyResponseError('unsupportedVersion', `format ${version} is not supported`, version)
}

// Parses a published number; undefined when absent, empty, or not finite.
function publishedNumber(value: string | null | undefined) {
	if (value === null || value === undefined || value === '') return undefined
	const number = Number(value)
	return Number.isFinite(number) ? number : undefined
}

// Builds the URL of a paged close-approach query. Every default of CAD that would change the result is sent
// explicitly: the target body, the distance limit, and for a catalog query the NEO filter.
export function closeApproachesUrl(query: CloseApproachQuery) {
	const distance = `${query.distanceMax}${query.distanceUnit === 'LD' ? 'LD' : ''}`
	const page = `${SBD_BASE_URL}${CLOSE_APPROACH_QUERY_PATH}&date-min=${query.dateMin}&date-max=${query.dateMax}T23:59:59&body=${query.body}&dist-max=${distance}&sort=${query.sort}&limit=${query.limit}${query.offset > 0 ? `&limit-from=${query.offset}` : ''}`
	if (query.selector === 'spk') return `${page}&spk=${query.spkId}`

	const filters = [`neo=${query.neoOnly === true}`]
	if (query.phaOnly) filters.push('pha=true')
	if (query.kind) filters.push(`kind=${query.kind}`)
	if (query.hMin !== undefined) filters.push(`h-min=${query.hMin}`)
	if (query.hMax !== undefined) filters.push(`h-max=${query.hMax}`)
	return `${page}&${filters.join('&')}`
}

// Reads the JSON of a close-approach query, by column name, since the columns depend on the query. `fields` and `data`
// are omitted past the last page or with no match. Rejects with SmallBodyResponseError a format of another major
// version, a required column that is missing, a row of the wrong length, and a required value that is not a number.
export function parseCloseApproaches(payload: Partial<SmallBodyCloseApproachResponse> & { readonly total?: number }): CloseApproachPage {
	assertSupportedSignature(payload.signature)

	const signature = payload.signature!
	const fields = payload.fields ?? []
	const data = payload.data ?? []
	const total = payload.total ?? payload.count ?? data.length
	if (data.length === 0) return { signature, total, rows: [] }

	const columns = new Map(fields.map((field, index) => [field, index]))
	const missing = REQUIRED_CLOSE_APPROACH_FIELDS.find((field) => !columns.has(field))
	if (missing) throw new SmallBodyResponseError('malformed', `the response has no ${missing} column`, signature.version)

	const rows = data.map((row): CloseApproachRow => {
		if (row.length !== fields.length) throw new SmallBodyResponseError('malformed', 'a row does not match the columns of the response', signature.version)

		const cell = (field: SmallBodyCloseApproachField) => {
			const index = columns.get(field)
			return index === undefined ? undefined : (row[index] as string | null)
		}

		const distance = publishedNumber(cell('dist'))
		const relativeVelocity = publishedNumber(cell('v_rel'))
		if (publishedNumber(cell('jd')) === undefined || distance === undefined || relativeVelocity === undefined) throw new SmallBodyResponseError('malformed', 'a row has no time, distance, or velocity', signature.version)

		return {
			designation: cell('des')!,
			fullName: cell('fullname')?.trim() || undefined,
			orbitId: cell('orbit_id')!,
			body: cell('body') ?? undefined,
			jd: cell('jd')!,
			calendarDate: cell('cd')!,
			distance,
			distanceMin: publishedNumber(cell('dist_min')),
			distanceMax: publishedNumber(cell('dist_max')),
			relativeVelocity,
			infiniteVelocity: publishedNumber(cell('v_inf')),
			timeUncertainty: cell('t_sigma_f') ?? undefined,
			absoluteMagnitude: publishedNumber(cell('h')),
			diameter: publishedNumber(cell('diameter')),
			diameterSigma: publishedNumber(cell('diameter_sigma')),
		}
	})

	return { signature, total, rows }
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
	dateMin = dateMin === undefined || dateMin === 'now' ? temporalNow() : dateMin
	const maxDate = typeof dateMax === 'string' ? temporalAdd(dateMin, Number(dateMax.slice(0, dateMax.length - 1)), 'd') : dateMax
	const uri = `${SBD_BASE_URL}${CLOSE_APPROACHES_PATH}&date-min=${formatTemporal(dateMin, DATE_FORMAT)}&date-max=${formatTemporal(maxDate, DATE_FORMAT)}&dist-max=${distance}LD`
	const response = await fetch(uri)
	const data = (await response.json()) as SmallBodyCloseApproachResponse
	return { ...data, fields: data.fields ?? [], data: data.data ?? [] }
}
