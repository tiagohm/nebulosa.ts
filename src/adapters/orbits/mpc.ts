import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { eraJdToCal } from '../../astronomy/coordinates/erfa/erfa'
import { Ellipsoid, geocentricLocation, type GeographicPosition } from '../../astronomy/observer/location'
import { KeplerOrbit } from '../../astronomy/orbits/asteroid'
import type { OrbitFitObservation } from '../../astronomy/orbits/fit'
import { type Time, Timescale, time, timeMJD, timeYMD, timeYMDHMS } from '../../astronomy/time/time'
import { ASEC2RAD, ELLIPSOID_PARAMETERS, GM_SUN_PITJEVA_2005, PIOVERTWO } from '../../core/constants'
import { validatePositiveInteger } from '../../core/validation'
import { matIdentity } from '../../math/linear-algebra/mat3'
import { Matrix } from '../../math/linear-algebra/matrix'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import { type Angle, deg, formatAngle, type FormatAngleOptions, parseAngle, toDeg } from '../../math/units/angle'
import { type Distance, kilometer, meter, toKilometer, toMeter } from '../../math/units/distance'

// Client for the Minor Planet Center public HTTP APIs and the local ADES/MPC1992 observation codecs.
// Network helpers issue GET requests with a JSON body against `data.minorplanetcenter.net`. Normalized
// models use camelCase, `Time`, radians, AU, and `undefined` for missing values. Observatory ITRS
// positions are geocentric Earth-fixed (not heliocentric, not `OrbitFitObservation.observerPosition`).
// Packed dates live in `mpcorb.ts`; packed designations are implemented here. The module never requests
// or exposes ADES XML.

// Base URL of the MPC public JSON API, including the trailing slash.
export const MPC_BASE_URL = 'https://data.minorplanetcenter.net/api/'

const QUERY_IDENTIFIER_PATH = 'query-identifier'
const OBSCODES_PATH = 'obscodes'
const GET_OBS_PATH = 'get-obs'
const GET_OBS_NEOCP_PATH = 'get-obs-neocp'
const GET_ORB_PATH = 'get-orb'
const LIST_PATH = 'list'

// Maximum number of designations accepted by `query-identifier` in one request.
const MAX_DESIGNATION_IDS = 100
// Default `listAll` page size when the caller does not pass `limit`.
const DEFAULT_LIST_PAGE_SIZE = 1000
// Hard maximum `limit` accepted by the List API.
const MAX_LIST_PAGE_SIZE = 50000
// MPC1992 record width after stripping a trailing CR.
const MPC80_LENGTH = 80
// Packed permanent minor-planet designation width.
const PACKED_PERMANENT_LENGTH = 5
// Packed provisional designation width (minor planet, comet fragment, survey).
const PACKED_PROVISIONAL_LENGTH = 7
// First numbered minor planet stored with a leading letter (A0000).
const PACKED_LETTER_NUMBER_BASE = 100000
// First numbered minor planet stored as `~` plus 4-character base-62.
const PACKED_TILDE_NUMBER_BASE = 620000
// Last representable numbered minor planet in the 5-character packed form.
const PACKED_TILDE_NUMBER_MAX = PACKED_TILDE_NUMBER_BASE + 62 ** 4 - 1
// Maximum cycle count representable in the original 7-character provisional packing.
const MAX_ORIGINAL_PACKED_CYCLE = 619
// First order number that uses the extended `_YHxxxx` packed provisional form.
const EXTENDED_PACKED_ORDER_BASE = 15501
// Natural-satellite `object_type_int` values that must not become a heliocentric `KeplerOrbit`.
const NATURAL_SATELLITE_OBJECT_TYPES = new Set([30, 31, 40])
// Base-62 alphabet used by packed numbered designations and the extended provisional scheme.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
// Order-within-half-month letters A–Z excluding I.
const ORDER_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
// Century encoding for packed years, identical to the MPC packed-date century character (I=18, K=20).
const PACKED_YEAR_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUV'

const ADES_FIELD_ALIASES: Readonly<Record<string, string>> = {
	obstype: 'obsType',
	obstime: 'obsTime',
	permid: 'permID',
	provid: 'provID',
	trksub: 'trkSub',
	trkid: 'trkID',
	trkmpc: 'trkMPC',
	obsid: 'obsID',
	obssubid: 'obsSubID',
	stn: 'stn',
	mode: 'mode',
	ra: 'ra',
	dec: 'dec',
	rmsra: 'rmsRA',
	rmsdec: 'rmsDec',
	rmscorr: 'rmsCorr',
	rmsfit: 'rmsFit',
	rmsmag: 'rmsMag',
	rmstime: 'rmsTime',
	mag: 'mag',
	band: 'band',
	astcat: 'astCat',
	photcat: 'photCat',
	notes: 'notes',
	remarks: 'remarks',
	ref: 'ref',
	disc: 'disc',
	exp: 'exp',
	seeing: 'seeing',
	nstars: 'nStars',
	sys: 'sys',
	ctr: 'ctr',
	pos1: 'pos1',
	pos2: 'pos2',
	pos3: 'pos3',
	vel1: 'vel1',
	vel2: 'vel2',
	vel3: 'vel3',
	precra: 'precRA',
	precdec: 'precDec',
	prectime: 'precTime',
	subfmt: 'subFmt',
	subfrm: 'subFrm',
	prog: 'prog',
	com: 'com',
	delay: 'delay',
	doppler: 'doppler',
	rmsdelay: 'rmsDelay',
	rmsdoppler: 'rmsDoppler',
	dist: 'dist',
	rmsdist: 'rmsDist',
	pa: 'pa',
	rmspa: 'rmsPA',
	frq: 'frq',
	trx: 'trx',
	rcv: 'rcv',
	deltara: 'deltaRA',
	deltadec: 'deltaDec',
	rastar: 'raStar',
	decstar: 'decStar',
	deprecated: 'deprecated',
	logsnr: 'logSNR',
	nucmag: 'nucMag',
	fltr: 'fltr',
	shapeocc: 'shapeOcc',
	artsat: 'artSat',
	obscenter: 'obsCenter',
	localuse: 'localUse',
	photap: 'photAp',
}

const CAR_STATE_NAMES = ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const
const TWO_LINE_NOTE2 = new Set(['S', 's', 'V', 'v', 'W', 'w', 'R', 'r', 'Q', 'q', 'T', 't'])
const SPACECRAFT_SYS = new Set(['ICRF_KM', 'ICRF_AU'])
const GEODETIC_SYS = new Set(['WGS84', 'ITRF', 'IAU'])
const OBSERVATORY_TYPES = new Set(['optical', 'occultation', 'satellite', 'radar', 'roving'])
const OUTPUT_FORMATS = new Set(['ADES_DF', 'OBS_DF', 'OBS80'])
const LIST_TYPES = new Set([
	'minor-planets',
	'neos',
	'inners',
	'middles',
	'outers',
	'binaries',
	'comets',
	'fragments',
	'atiras',
	'atens',
	'apollos',
	'amors',
	'inner-others',
	'mars-crossers',
	'main-belters',
	'jovian-trojans',
	'tnos',
	'hyperbolics',
	'parabolics',
	'unbounded',
	'planet-nat-sats',
	'mp-nat-sats',
	'impacted',
	'retired',
	'dual-status',
	'minor-planet-names',
	'nat-sat-names',
	'comet-names',
	'interstellar-names',
])

const MPC80_RA_FORMAT: FormatAngleOptions = { isHour: true, noSign: true, separators: ' ', fractionDigits: 3, padLength: 2 }
const MPC80_DEC_FORMAT: FormatAngleOptions = { separators: ' ', fractionDigits: 2, padLength: 2, plusSign: '+', minusSign: '-' }

// ADES schema year used by `get-obs` / PSV. XML is not a valid value in this module.
export type MPCADESVersion = '2017' | '2022'
// Observation encodings this client will request. `"XML"` is rejected at the boundary.
export type MPCObservationOutputFormat = 'ADES_DF' | 'OBS_DF' | 'OBS80'
// Observatory geometry class from the obscodes JSON `observations_type` field.
export type MPCObservatoryType = 'optical' | 'occultation' | 'satellite' | 'radar' | 'roving'
// List API category names, matching the 29 documented `list` values.
export type MPCList =
	| 'minor-planets'
	| 'neos'
	| 'inners'
	| 'middles'
	| 'outers'
	| 'binaries'
	| 'comets'
	| 'fragments'
	| 'atiras'
	| 'atens'
	| 'apollos'
	| 'amors'
	| 'inner-others'
	| 'mars-crossers'
	| 'main-belters'
	| 'jovian-trojans'
	| 'tnos'
	| 'hyperbolics'
	| 'parabolics'
	| 'unbounded'
	| 'planet-nat-sats'
	| 'mp-nat-sats'
	| 'impacted'
	| 'retired'
	| 'dual-status'
	| 'minor-planet-names'
	| 'nat-sat-names'
	| 'comet-names'
	| 'interstellar-names'

// One candidate from a fuzzy `query-identifier` match (`found > 1`).
export interface MPCDisambiguation {
	// Human-readable name, if the candidate is named.
	readonly name?: string
	// Permanent numbered id of the candidate.
	readonly permanentId?: string
	// Packed primary provisional designation.
	readonly packedPrimaryProvisionalDesignation?: string
	// Unpacked primary provisional designation.
	readonly unpackedPrimaryProvisionalDesignation?: string
	// Object group used for the name search.
	readonly group?: string
	// Name citation text, when present.
	readonly citation?: string
	// Similarity score returned by the API, dimensionless.
	readonly similarity?: number
}

// Cometary identity attached to a dual-status minor planet (e.g. Chiron / 95P). Not the primary `permanentId`.
export interface MPCDualStatus {
	// Match count for the comet identity (`1` when unique).
	readonly found: number
	// Comet name, if assigned.
	readonly name?: string
	// IAU designation of the comet identity.
	readonly iauDesignation?: string
	// Orbfit-style identifier of the comet identity.
	readonly orbfitName?: string
	// Object-type label of the comet identity.
	readonly objectType?: string
	// Numeric object-type code of the comet identity.
	readonly objectTypeCode?: number
	// Permanent comet id (e.g. `95P`).
	readonly permanentId?: string
	// Packed permanent comet id.
	readonly packedPermanentId?: string
	// New-style packed permanent comet id, when the API supplies one.
	readonly newStylePackedPermanentId?: string
	// Packed primary provisional comet designation.
	readonly packedPrimaryProvisionalDesignation?: string
	// New-style packed primary provisional comet designation.
	readonly newStylePackedPrimaryProvisionalDesignation?: string
	// Unpacked primary provisional comet designation.
	readonly primaryProvisionalDesignation?: string
	// Packed secondary comet designations; empty when absent.
	readonly packedSecondaryProvisionalDesignations: readonly string[]
	// Unpacked secondary comet designations; empty when absent.
	readonly secondaryProvisionalDesignations: readonly string[]
}

// Normalized designation lookup for one input id. `found` is 0, 1, or >1; missing fields are `undefined`.
export interface MPCDesignation {
	// Input string that produced this record.
	readonly query: string
	// 0 = none, 1 = unique, >1 = ambiguous.
	readonly found: number
	// Object name, if assigned.
	readonly name?: string
	// Name citation text.
	readonly citation?: string
	// Permanent numbered id (`"1"` for Ceres).
	readonly permanentId?: string
	// Packed permanent id (`00001`).
	readonly packedPermanentId?: string
	// IAU designation as published (parentheses preserved).
	readonly iauDesignation?: string
	// Orbfit-friendly id (IAU designation without spaces).
	readonly orbfitName?: string
	// Object-type label (`Minor Planet`, ...).
	readonly objectType?: string
	// Numeric object-type code from the API tuple.
	readonly objectTypeCode?: number
	// Packed primary provisional designation.
	readonly packedPrimaryProvisionalDesignation?: string
	// Unpacked primary provisional designation.
	readonly primaryProvisionalDesignation?: string
	// Packed secondary designations; empty when the API sends null.
	readonly packedSecondaryProvisionalDesignations: readonly string[]
	// Unpacked secondary designations; empty when the API sends null.
	readonly secondaryProvisionalDesignations: readonly string[]
	// Ambiguous-match list; omitted when `found` is 0 or 1.
	readonly disambiguation?: readonly MPCDisambiguation[]
	// Dual-status comet identity; omitted when the API sends null.
	readonly dualStatus?: MPCDualStatus
}

// Optional name-search modifiers for `designations()`. Fuzzy search is off unless `comparison` is set.
export interface MPCDesignationQueryOptions {
	// PostgreSQL comparison used only for name searches.
	readonly comparison?: '=' | 'ILIKE' | '%'
	// Restricts a name search to one object group.
	readonly group?: 'Minor Planets' | 'Natural Satellites' | 'Comets' | 'Interstellar'
	// Abort signal for the HTTP request.
	readonly signal?: AbortSignal
}

// Normalized observatory code. Longitude/ρ are omitted for satellites, rovers, and the flatfile when blank.
export interface MPCObservatory {
	// Three-character observatory code.
	readonly code: string
	// ASCII name.
	readonly name: string
	// Unicode name.
	readonly nameUtf8?: string
	// LaTeX name.
	readonly nameLatex?: string
	// Short ASCII name.
	readonly shortName?: string
	// East-positive longitude, radians. Absent when the site has no geocentric geometry.
	readonly longitude?: Angle
	// ρ cos φ′ in equatorial Earth radii.
	readonly rhoCosPhi?: number
	// ρ sin φ′ in equatorial Earth radii.
	readonly rhoSinPhi?: number
	// First observing date `YYYY-MM-DD`.
	readonly firstDate?: string
	// Last observing date `YYYY-MM-DD`.
	readonly lastDate?: string
	// Observatory website URL.
	readonly webLink?: string
	// HTTP-date timestamp of creation in the MPC database.
	readonly createdAt?: string
	// HTTP-date timestamp of last update.
	readonly updatedAt?: string
	// True when the site reports two-line (satellite/roving/radar) observations.
	readonly usesTwoLineObservations?: boolean
	// Geometry class from JSON; omitted by the flatfile parser.
	readonly observationType?: MPCObservatoryType
	// Previous names; empty when the API sends null.
	readonly oldNames: readonly string[]
}

// Fields shared by every normalized MPC observation. Time is UTC.
export interface MPCObservationBase {
	// ADES `Obstype` discriminant, not the observing `mode`.
	readonly type: 'optical' | 'offset' | 'occultation' | 'radar'
	// Mid-time of the observation, UTC.
	readonly time: Time
	// Three-character station / observatory code.
	readonly station: string
	// Permanent object id.
	readonly permanentId?: string
	// Unpacked provisional designation.
	readonly provisionalId?: string
	// Packed tracklet id (`trkID` / `trkMPC`).
	readonly trackletId?: string
	// Submitter tracklet id (`trkSub`).
	readonly trackletSubmissionId?: string
	// ADES observation id.
	readonly observationId?: string
	// Submitter-side observation id.
	readonly submissionObservationId?: string
	// Observing mode (`CCD`, `C`, ...). Not the two-line note-2 letter.
	readonly mode?: string
	// Publication reference.
	readonly reference?: string
	// Observer notes.
	readonly notes?: string
	// Free-text remarks.
	readonly remarks?: string
	// Program code (MPC80 column 14 / ADES `prog`).
	readonly programCode?: string
	// True only when `disc` is `*`.
	readonly discovery?: boolean
	// Deprecation flag as published.
	readonly deprecated?: string
	// Astrometric catalog name when present on the base record.
	readonly catalog?: string
	// Submission format (`subFmt` / `subFrm`).
	readonly submissionFormat?: string
}

// Geocenter-to-spacecraft vector stored on a satellite optical observation. Position is AU, equatorial J2000.
export interface MPCSpacecraftObserver {
	// Discriminant for `MPCEmbeddedObserver`.
	readonly kind: 'spacecraft'
	// Source units of the published vector; converted to AU on parse.
	readonly sys: 'ICRF_KM' | 'ICRF_AU'
	// NAIF center code; omitted for implicit geocenter (MPC80).
	readonly center?: number
	// Position in AU.
	readonly position: Vec3
}

// Geographic observer used by roving/ADES geodetic records. Angles radians, elevation AU.
export interface MPCGeodeticObserver {
	// Discriminant for `MPCEmbeddedObserver`.
	readonly kind: 'geodetic'
	// Ellipsoid / terrestrial frame named in the ADES `sys` field.
	readonly sys: 'WGS84' | 'ITRF' | 'IAU'
	// East-positive longitude, radians.
	readonly longitude: Angle
	// North-positive latitude, radians.
	readonly latitude: Angle
	// Height above the ellipsoid, AU.
	readonly elevation: Distance
}

// Optional embedded observer on an optical/offset/occultation record.
export type MPCEmbeddedObserver = MPCSpacecraftObserver | MPCGeodeticObserver

// Optical astrometry. RA/Dec and rms values are radians; `raError` is already RA·cos(dec).
export interface MPCOpticalObservation extends MPCObservationBase {
	// Optical discriminant.
	readonly type: 'optical'
	// Right ascension, radians.
	readonly rightAscension: Angle
	// Declination, radians.
	readonly declination: Angle
	// 1-sigma RA·cos(dec) uncertainty, radians.
	readonly raError?: Angle
	// 1-sigma declination uncertainty, radians.
	readonly decError?: Angle
	// RA/Dec error correlation in [-1, 1].
	readonly raDecCorrelation?: number
	// Apparent magnitude.
	readonly magnitude?: number
	// Magnitude uncertainty.
	readonly magnitudeError?: number
	// Photometric band.
	readonly band?: string
	// Astrometric catalog.
	readonly astrometricCatalog?: string
	// Photometric catalog.
	readonly photometricCatalog?: string
	// Exposure time, seconds.
	readonly exposure?: number
	// Seeing FWHM, radians.
	readonly seeing?: Angle
	// Residual RMS of the plate fit, radians.
	readonly rmsFit?: Angle
	// Number of reference stars.
	readonly stars?: number
	// Spacecraft or geodetic observer, when present.
	readonly observer?: MPCEmbeddedObserver
}

// Offset observation relative to a reference star. Deltas are radians.
export interface MPCOffsetObservation extends MPCObservationBase {
	// Offset discriminant.
	readonly type: 'offset'
	// ΔRA, radians.
	readonly deltaRightAscension: Angle
	// ΔDec, radians.
	readonly deltaDeclination: Angle
	// Reference-star RA, radians.
	readonly starRightAscension?: Angle
	// Reference-star Dec, radians.
	readonly starDeclination?: Angle
	// Spacecraft or geodetic observer, when present.
	readonly observer?: MPCEmbeddedObserver
}

// Occultation-derived astrometry. RA/Dec optional; angles radians.
export interface MPCOccultationObservation extends MPCObservationBase {
	// Occultation discriminant.
	readonly type: 'occultation'
	// Right ascension, radians, when published.
	readonly rightAscension?: Angle
	// Declination, radians, when published.
	readonly declination?: Angle
	// 1-sigma RA·cos(dec) uncertainty, radians.
	readonly raError?: Angle
	// 1-sigma declination uncertainty, radians.
	readonly decError?: Angle
	// Spacecraft or geodetic observer, when present.
	readonly observer?: MPCEmbeddedObserver
}

// Radar delay/Doppler observation. Delay is seconds, Doppler Hz, transmit frequency Hz.
export interface MPCRadarObservation extends MPCObservationBase {
	// Radar discriminant.
	readonly type: 'radar'
	// Round-trip delay, seconds.
	readonly delay?: number
	// Delay uncertainty, seconds.
	readonly delayError?: number
	// Doppler shift, Hz.
	readonly doppler?: number
	// Doppler uncertainty, Hz.
	readonly dopplerError?: number
	// Transmitter frequency, Hz.
	readonly transmitFrequency?: number
	// Transmitter observatory code.
	readonly transmitterStation?: string
	// Receiver observatory code.
	readonly receiverStation?: string
	// Echo origin: surface or center of mass.
	readonly bounce?: 'surface' | 'com'
}

// Discriminated observation union. Only optical records with RA/Dec feed `fitOrbit`.
export type MPCObservation = MPCOpticalObservation | MPCOffsetObservation | MPCOccultationObservation | MPCRadarObservation

// PSV header context that is not copied onto each observation.
export interface MPCADESContext {
	// Observatory block from `# observatory` / `! mpcCode` lines.
	readonly observatory?: { readonly mpcCode?: string; readonly name?: string }
	// Submitter block from `# submitter`.
	readonly submitter?: { readonly name?: string; readonly institution?: string }
	// Observer names from `# observers`.
	readonly observers?: readonly string[]
	// Measurer names from `# measurers`.
	readonly measurers?: readonly string[]
	// Telescope block; aperture is metres when present.
	readonly telescope?: { readonly aperture?: number; readonly design?: string; readonly detector?: string }
	// Software name from `# software`.
	readonly software?: { readonly name?: string }
	// Free-text `# comment` lines in order.
	readonly comment?: readonly string[]
}

// One PSV context block plus the observations that follow it.
export interface MPCADESBlock {
	// Header context that applies to the following observations.
	readonly context?: MPCADESContext
	// Observations in this block, in file order.
	readonly observations: readonly MPCObservation[]
}

// Parsed ADES PSV document. `observations()` returns `MPCObservation[]`, not this type.
export interface MPCADESDocument {
	// ADES schema year from `# version=`.
	readonly version: MPCADESVersion
	// Sequential context/observation groups.
	readonly blocks: readonly MPCADESBlock[]
}

// Low-level `get-obs` / `get-obs-neocp` query. Defaults to `ADES_DF` and ADES 2022.
export interface MPCObservationQueryOptions {
	// Encodings to request. `"XML"` is rejected.
	readonly outputFormats?: readonly MPCObservationOutputFormat[]
	// ADES schema year when requesting `ADES_DF`.
	readonly adesVersion?: MPCADESVersion
	// Abort signal for the HTTP request.
	readonly signal?: AbortSignal
}

// Raw observation-endpoint payload after discarding any `XML` key.
export interface MPCObservationPayload {
	// Unparsed `ADES_DF` rows.
	readonly ades?: readonly unknown[]
	// Newline-separated 80-column records.
	readonly obs80?: string
	// Parsed `OBS_DF` rows; each entry is one OBS80 line.
	readonly obsDf?: readonly { readonly obs80: string }[]
}

// One of CAR / COM / KEP. CAR coefficients are already AU and AU/day.
export interface MPCOrbitElementSet {
	// Coefficient labels in publication order (`x,y,z,vx,vy,vz` for CAR).
	readonly coefficientNames: readonly string[]
	// Coefficient values matching `coefficientNames`; CAR is AU and AU/day.
	readonly coefficients: readonly number[]
	// Published `covij` terms; 6×6 reconstruction ignores `cov06+`.
	readonly covarianceValues?: Readonly<Record<string, number>>
}

// Osculating epoch of an `mpc_orb` record.
export interface MPCOrbitEpochData {
	// Epoch value in `timeForm` units.
	readonly epoch: number
	// Calendar of `epoch`: modified or full Julian Date.
	readonly timeForm: 'MJD' | 'JD'
	// TDT is mapped to `Timescale.TT`.
	readonly timeSystem: 'TDT' | 'TDB'
}

// Frame metadata. Live responses use `refsys`, not `refplane`.
export interface MPCOrbitSystemData {
	// Coordinate plane of CAR; drives `KeplerOrbit` rotation.
	readonly referenceSystem: 'Ecliptic' | 'Equatorial'
	// Reference frame name, typically `ICRF`.
	readonly referenceFrame: string
	// Planetary ephemeris identifier, when published.
	readonly ephemeris?: string
	// Force-model identifier, when published.
	readonly forceModel?: string
	// Mean ecliptic obliquity used by the solution, arcseconds.
	readonly eclipticObliquityArcseconds?: number
}

// Identity block copied from `mpc_orb` `designation_data`.
export interface MPCOrbitDesignationData {
	// Object name, if assigned.
	readonly name?: string
	// Permanent numbered id.
	readonly permanentId?: string
	// Packed permanent id.
	readonly packedPermanentId?: string
	// Unpacked primary provisional designation.
	readonly primaryProvisionalDesignation?: string
	// Packed primary provisional designation.
	readonly packedPrimaryProvisionalDesignation?: string
}

// Object-class metadata. Natural-satellite types must not become a heliocentric `KeplerOrbit`.
export interface MPCOrbitCategorization {
	// Object-type label.
	readonly objectType?: string
	// 30/31/40 are natural satellites and cannot become a heliocentric `KeplerOrbit`.
	readonly objectTypeInt?: number
}

// Absolute magnitude and slope from `magnitude_data`.
export interface MPCOrbitMagnitudeData {
	// Absolute magnitude H.
	readonly h?: number
	// Slope parameter G.
	readonly g?: number
}

// Minimum orbit intersection distances from `moid_data`, AU.
export interface MPCOrbitMoidData {
	// Earth MOID, AU.
	readonly earth?: number
	// Jupiter MOID, AU.
	readonly jupiter?: number
}

// Published fit-quality statistics from `orbit_fit_statistics`.
export interface MPCOrbitFitStatistics {
	// Number of observations used.
	readonly nObs?: number
	// Number of oppositions used.
	readonly nOpp?: number
	// Observed arc length, days.
	readonly arcLength?: number
	// Residual RMS of the published fit.
	readonly rms?: number
}

// Non-gravitational-force flags from `nongrav_booleans`.
export interface MPCOrbitNonGravBooleans {
	// True when a non-gravitational model is present.
	readonly nongravs?: boolean
}

// Software provenance from `software_data`.
export interface MPCOrbitSoftwareData {
	// Orbit-fit software identifier.
	readonly software?: string
}

// Normalized `mpc_orb[0]` record. Extra published keys are ignored.
export interface MPCOrbitSolution {
	// Cartesian state in AU and AU/day when published.
	readonly car?: MPCOrbitElementSet
	// Cometary elements, unused by `orbitToKeplerOrbit`.
	readonly com?: MPCOrbitElementSet
	// Keplerian elements, unused by `orbitToKeplerOrbit`.
	readonly kep?: MPCOrbitElementSet
	// Identity copied from `designation_data`.
	readonly designationData?: MPCOrbitDesignationData
	// Osculating epoch; required to build a `KeplerOrbit`.
	readonly epochData?: MPCOrbitEpochData
	// Frame metadata; live `refsys` is typically `Ecliptic`.
	readonly systemData?: MPCOrbitSystemData
	// Absolute magnitude and slope.
	readonly magnitudeData?: MPCOrbitMagnitudeData
	// Earth/Jupiter MOIDs, AU.
	readonly moidData?: MPCOrbitMoidData
	// Object class; satellite types skip `KeplerOrbit`.
	readonly categorization?: MPCOrbitCategorization
	// Published residual statistics.
	readonly orbitFitStatistics?: MPCOrbitFitStatistics
	// Non-gravitational model flags.
	readonly nonGravBooleans?: MPCOrbitNonGravBooleans
	// Fitting software identifier.
	readonly softwareData?: MPCOrbitSoftwareData
}

// Heliocentric Cartesian state extracted from CAR. Position AU, velocity AU/day.
export interface MPCOrbitCartesianState {
	// Osculating epoch on `Timescale.TT` (TDT) or `Timescale.TDB`.
	readonly epoch: Time
	// Heliocentric position, AU, in `referenceSystem`.
	readonly position: Vec3
	// Heliocentric velocity, AU/day, in `referenceSystem`.
	readonly velocity: Vec3
	// 6×6 covariance reconstructed from `cov00`…`cov55` when present.
	readonly covariance?: Matrix
	// Coordinate plane of the stored state.
	readonly referenceSystem: 'Ecliptic' | 'Equatorial'
	// Reference frame name, typically `ICRF`.
	readonly referenceFrame: string
	// Epoch timescale as published.
	readonly timeSystem: 'TDT' | 'TDB'
	// Planetary ephemeris identifier, when published.
	readonly ephemeris?: string
}

// One List API item. Shape varies by list; all fields are optional.
export interface MPCListItem {
	// Object name, if assigned.
	readonly name?: string
	// Permanent numbered id of a minor planet.
	readonly permanentId?: string
	// Permanent comet id on dual-status lists.
	readonly permanentIdComet?: string
	// Unpacked primary provisional designation.
	readonly unpackedPrimaryProvisionalDesignation?: string
	// Unpacked primary provisional comet designation on dual-status lists.
	readonly unpackedPrimaryProvisionalDesignationComet?: string
	// Name citation text.
	readonly citation?: string
	// Object group label.
	readonly group?: string
	// Publication reference.
	readonly reference?: string
	// True when the object has been published.
	readonly published?: boolean
	// Retirement or removal reason.
	readonly reason?: string
	// Additional publication references.
	readonly publicationReferences?: readonly string[]
	// Impact epoch as a Julian Date; timescale is unpublished so this is not a `Time`.
	readonly impactJulianDate?: number
	// Impact latitude, radians.
	readonly impactLatitude?: Angle
	// Impact longitude, radians.
	readonly impactLongitude?: Angle
	// Extra orbital parameters as published strings/numbers.
	readonly orbitalParameters?: Readonly<Record<string, string | number>>
}

// Pagination and filter options for `list()` / `listAll()`.
export interface MPCListOptions {
	// Sort direction of the list; default is API default.
	readonly order?: 'ASC' | 'DESC'
	// Page size 1..50000; forwarded as-is by `list()`.
	readonly limit?: number
	// Zero-based offset of the first returned item.
	readonly offset?: number
	// PostgreSQL LIKE pattern on the unpacked primary provisional designation.
	readonly like?: string
	// Abort signal for the HTTP request.
	readonly signal?: AbortSignal
}

// One page of List API results plus the echoed request.
export interface MPCListResult {
	// Items in this page, in API order.
	readonly items: readonly MPCListItem[]
	// Request parameters as returned or reconstructed.
	readonly request: {
		// List category that was queried.
		readonly list: MPCList
		// Sort direction used by the server.
		readonly order: 'ASC' | 'DESC'
		// Page size used by the server.
		readonly limit: number
		// Offset used by the server.
		readonly offset: number
		// LIKE filter, when present.
		readonly like?: string
	}
}

// Maps an optical observation to the heliocentric/barycentric observer position `fitOrbit` needs.
export type MPCObserverPositionResolver = (time: Time, observation: MPCOpticalObservation) => Vec3 | undefined

// Split of observations that can be fitted versus those skipped (non-optical or unresolved observer).
export interface MPCOrbitFitInput {
	// Optical observations with a resolved heliocentric observer position.
	readonly observations: readonly OrbitFitObservation[]
	// Non-optical records and optical records whose observer could not be resolved.
	readonly rejected: readonly MPCObservation[]
}

// Spec-style ADES fields after case canonicalization. Numeric strings are still strings until `optionalNumber`.
interface MPCADESCanonicalObservation {
	readonly [key: string]: string | number | undefined
}

// Raw HTTP outcome used by lookup helpers that map known misses to `undefined` / `[]`.
interface MpcHttpResult {
	readonly ok: boolean
	readonly status: number
	readonly statusText: string
	readonly body: unknown
}

// Issues GET with a JSON body. Bun's `fetch` rejects GET bodies, so this uses `node:https` to match the MPC API.
async function mpcFetch(path: string, payload: unknown, signal?: AbortSignal): Promise<MpcHttpResult> {
	if (signal?.aborted) throw abortError(signal)

	const url = new URL(path, MPC_BASE_URL)
	const bodyText = JSON.stringify(payload ?? {})
	const bodyBuffer = Buffer.from(bodyText)

	return await new Promise((resolve, reject) => {
		const req = httpsRequest(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || 443,
				path: `${url.pathname}${url.search}`,
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
					'Content-Length': bodyBuffer.length,
				},
			},
			(response: IncomingMessage) => {
				const chunks: Buffer[] = []

				response.on('data', (chunk: Buffer) => {
					chunks.push(chunk)
				})

				response.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8')
					let body: unknown

					try {
						body = text ? JSON.parse(text) : undefined
					} catch {
						body = undefined
					}

					const status = response.statusCode ?? 0

					resolve({
						ok: status >= 200 && status < 300,
						status,
						statusText: response.statusMessage ?? '',
						body,
					})
				})

				response.on('error', reject)
			},
		)

		const onAbort = () => {
			req.destroy()
			reject(abortError(signal))
		}

		if (signal) {
			signal.addEventListener('abort', onAbort, { once: true })
			req.on('close', () => signal.removeEventListener('abort', onAbort))
		}

		req.on('error', reject)
		req.write(bodyBuffer)
		req.end()
	})
}

function abortError(signal?: AbortSignal) {
	return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}

function mpcHttpError(path: string, result: MpcHttpResult): Error {
	const detail = mpcErrorMessage(result.body)
	return new Error(`MPC ${path}: ${result.status} ${result.statusText}${detail ? `: ${detail}` : ''}`)
}

async function mpcRequest(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
	const result = await mpcFetch(path, payload, signal)
	if (!result.ok) throw mpcHttpError(path, result)
	return result.body
}

function unwrapMpcEnvelope(json: unknown): unknown {
	if (!Array.isArray(json) || json.length !== 2) throw new Error('MPC response is not a [payload, status] envelope')
	return json[0]
}

function isMpcLookupMiss(status: number, body: unknown): boolean {
	if (status === 501 && mpcErrorCode(body) === 'input_error') return true

	if (status === 500) {
		const message = mpcErrorMessage(body)
		return message.includes('found=0') || message.includes('Bad Label')
	}

	return false
}

function mpcErrorMessage(body: unknown) {
	if (!isRecord(body)) return ''
	const message = body.message
	return typeof message === 'string' ? message : ''
}

function mpcErrorCode(body: unknown) {
	if (!isRecord(body)) return undefined
	const error = body.error
	return typeof error === 'string' ? error : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined

	if (typeof value !== 'string') {
		if (typeof value === 'number' && Number.isFinite(value)) return String(value)
		throw new Error('expected a string')
	}

	return value === '' ? undefined : value
}

function optionalIdentity(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	if (typeof value !== 'string') throw new Error('expected an identifier string')
	return value === '' ? undefined : value
}

function optionalNumber(value: unknown): number | undefined {
	if (value === null || value === undefined || value === '') return undefined
	const number = typeof value === 'number' ? value : typeof value === 'string' ? +value : Number.NaN
	if (!Number.isFinite(number)) throw new Error(`expected a finite number, got ${JSON.stringify(value)}`)
	return number
}

function optionalBoolean(value: unknown): boolean | undefined {
	if (value === null || value === undefined) return undefined
	if (typeof value !== 'boolean') throw new Error('expected a boolean')
	return value
}

function optionalStringArray(value: unknown): readonly string[] {
	if (value === null || value === undefined) return []
	if (!Array.isArray(value)) throw new Error('expected a string array')

	const items: string[] = []

	for (const item of value) {
		const text = optionalIdentity(item)
		if (text !== undefined) items.push(text)
	}

	return items
}

function optionalAngleDeg(value: unknown): Angle | undefined {
	const number = optionalNumber(value)
	return number === undefined ? undefined : deg(number)
}

function optionalArcsec(value: unknown): Angle | undefined {
	const number = optionalNumber(value)
	return number === undefined ? undefined : number * ASEC2RAD
}

// Looks up up to 100 designations, preserving input order. Empty `ids` returns `[]` without a network call.
export async function designations(ids: readonly string[], options?: MPCDesignationQueryOptions): Promise<readonly MPCDesignation[]> {
	if (ids.length === 0) return []
	if (ids.length > MAX_DESIGNATION_IDS) throw new RangeError(`designations() accepts at most ${MAX_DESIGNATION_IDS} ids`)

	const payload: Record<string, unknown> = { ids }
	if (options?.comparison !== undefined) payload.comparison = options.comparison
	if (options?.group !== undefined) payload.group = options.group

	const body = await mpcRequest(QUERY_IDENTIFIER_PATH, payload, options?.signal)
	if (!isRecord(body)) throw new Error('MPC designation response is not an object')

	return ids.map((id) => parseDesignation(id, body[id]))
}

// Unique designation lookup. Returns `undefined` when `found !== 1` (miss or ambiguous).
export async function designation(id: string, options?: MPCDesignationQueryOptions): Promise<MPCDesignation | undefined> {
	const [result] = await designations([id], options)
	return result?.found === 1 ? result : undefined
}

// Best identity string: permanent id, then primary provisional, IAU designation, then name.
export function primaryDesignation(designation: MPCDesignation): string | undefined {
	return designation.permanentId ?? designation.primaryProvisionalDesignation ?? designation.iauDesignation ?? designation.name
}

// Deduplicated packed/unpacked ids and names. Disambiguation candidates are other objects and are omitted.
export function designationAliases(designation: MPCDesignation): readonly string[] {
	const aliases = new Set<string>()

	const push = (value?: string) => {
		value && aliases.add(value)
	}

	push(designation.permanentId)
	push(designation.packedPermanentId)
	push(designation.primaryProvisionalDesignation)
	push(designation.packedPrimaryProvisionalDesignation)
	push(designation.iauDesignation)
	push(designation.orbfitName)
	push(designation.name)
	for (const item of designation.secondaryProvisionalDesignations) push(item)
	for (const item of designation.packedSecondaryProvisionalDesignations) push(item)
	return [...aliases]
}

function parseDesignation(query: string, raw: unknown): MPCDesignation {
	if (raw === undefined) {
		return { query, found: 0, packedSecondaryProvisionalDesignations: [], secondaryProvisionalDesignations: [] }
	}

	if (!isRecord(raw)) throw new Error(`MPC designation for "${query}" is not an object`)

	const objectType = parseObjectType(raw.object_type)
	const found = optionalNumber(raw.found) ?? 0
	const disambiguation = parseDisambiguationList(raw.disambiguation_list)
	const dualStatus = raw.dual_status_info === null || raw.dual_status_info === undefined ? undefined : parseDualStatus(raw.dual_status_info)

	return {
		query,
		found,
		name: optionalString(raw.name),
		citation: optionalString(raw.citation),
		permanentId: optionalIdentity(raw.permid),
		packedPermanentId: optionalIdentity(raw.packed_permid),
		iauDesignation: optionalIdentity(raw.iau_designation),
		orbfitName: optionalIdentity(raw.orbfit_name),
		objectType: objectType?.[0],
		objectTypeCode: objectType?.[1],
		packedPrimaryProvisionalDesignation: optionalIdentity(raw.packed_primary_provisional_designation),
		primaryProvisionalDesignation: optionalIdentity(raw.unpacked_primary_provisional_designation),
		packedSecondaryProvisionalDesignations: optionalStringArray(raw.packed_secondary_provisional_designations),
		secondaryProvisionalDesignations: optionalStringArray(raw.unpacked_secondary_provisional_designations),
		disambiguation,
		dualStatus,
	}
}

function parseObjectType(value: unknown): readonly [string, number] | undefined {
	if (value === null || value === undefined || typeof value === 'string') return undefined
	if (!Array.isArray(value) || value.length < 2) throw new Error('object_type must be a [name, code] pair')
	const name = optionalString(value[0])
	const code = optionalNumber(value[1])
	if (name === undefined || code === undefined) return undefined
	return [name, code]
}

function parseDisambiguationList(value: unknown): readonly MPCDisambiguation[] | undefined {
	if (value === null || value === undefined) return undefined
	if (!Array.isArray(value)) throw new Error('disambiguation_list must be an array')
	return value.map(parseDisambiguation)
}

function parseDisambiguation(value: unknown): MPCDisambiguation {
	if (!isRecord(value)) throw new Error('disambiguation entry must be an object')

	return {
		name: optionalString(value.name),
		permanentId: optionalIdentity(value.permid),
		packedPrimaryProvisionalDesignation: optionalIdentity(value.packed_primary_provisional_designation),
		unpackedPrimaryProvisionalDesignation: optionalIdentity(value.unpacked_primary_provisional_designation),
		group: optionalString(value.group),
		citation: optionalString(value.citation),
		similarity: optionalNumber(value.similarity),
	}
}

function parseDualStatus(value: unknown): MPCDualStatus {
	if (!isRecord(value)) throw new Error('dual_status_info must be an object')

	const objectType = parseObjectType(value.object_type)

	return {
		found: optionalNumber(value.found) ?? 0,
		name: optionalString(value.name),
		iauDesignation: optionalIdentity(value.iau_designation),
		orbfitName: optionalIdentity(value.orbfit_name),
		objectType: objectType?.[0] ?? optionalString(value.object_type),
		objectTypeCode: objectType?.[1] ?? optionalNumber(value.object_type_code),
		permanentId: optionalIdentity(value.permid),
		packedPermanentId: optionalIdentity(value.packed_permid),
		newStylePackedPermanentId: optionalIdentity(value.new_style_packed_permid),
		packedPrimaryProvisionalDesignation: optionalIdentity(value.packed_primary_provisional_designation),
		newStylePackedPrimaryProvisionalDesignation: optionalIdentity(value.new_style_packed_primary_provisional_designation),
		primaryProvisionalDesignation: optionalIdentity(value.primary_provisional_designation) ?? optionalIdentity(value.unpacked_primary_provisional_designation),
		packedSecondaryProvisionalDesignations: optionalStringArray(value.packed_secondary_provisional_designations),
		secondaryProvisionalDesignations: optionalStringArray(value.secondary_provisional_designations) ?? optionalStringArray(value.unpacked_secondary_provisional_designations),
	}
}

// Fetches one observatory code. Known 501 misses return `undefined`.
export async function observatory(code: string, signal?: AbortSignal): Promise<MPCObservatory | undefined> {
	const result = await mpcFetch(OBSCODES_PATH, { obscode: code }, signal)

	if (!result.ok) {
		if (isMpcLookupMiss(result.status, result.body)) return undefined
		throw mpcHttpError(OBSCODES_PATH, result)
	}

	if (!isRecord(result.body)) throw new Error('MPC observatory response is not an object')
	if (isRecord(result.body) && result.body[code] !== undefined && isRecord(result.body[code])) return parseObservatory(result.body[code])
	return parseObservatory(result.body)
}

// Fetches every observatory code. Order follows the API dict keys and is not sorted.
export async function observatories(signal?: AbortSignal): Promise<readonly MPCObservatory[]> {
	const body = await mpcRequest(OBSCODES_PATH, {}, signal)
	if (!isRecord(body)) throw new Error('MPC observatories response is not an object')
	const items: MPCObservatory[] = []
	for (const value of Object.values(body)) items.push(parseObservatory(value))
	return items
}

// Parses one ObsCodes.html line. Geometry fields are omitted when blank; type/two-line flags are not invented.
export function parseObservatoryCode(line: string): MPCObservatory {
	if (line.length < 3) throw new Error('observatory code line is missing a 3-character code')

	const code = line.slice(0, 3)
	if (code.trim().length !== 3) throw new Error(`invalid observatory code "${code}"`)

	const longitude = parseOptionalFlatNumber(line, 4, 13)
	const rhoCosPhi = parseOptionalFlatNumber(line, 13, 21)
	const rhoSinPhi = parseOptionalFlatNumber(line, 21, 30)
	const name = line.length > 30 ? line.slice(30).trim() : ''

	return { code, name, longitude: longitude === undefined ? undefined : deg(longitude), rhoCosPhi, rhoSinPhi, oldNames: [] }
}

// Parses a multi-line ObsCodes.html body, skipping blank lines.
export function parseObservatoryCodes(text: string): readonly MPCObservatory[] {
	const items: MPCObservatory[] = []

	for (const raw of text.split(/\r?\n/)) {
		if (raw.trim() === '') continue
		items.push(parseObservatoryCode(raw))
	}

	return items
}

// Writes one ObsCodes.html line. Throws `RangeError` when longitude/ρ are missing (does not write zeros).
export function writeObservatoryCode(observatory: MPCObservatory): string {
	if (observatory.longitude === undefined || observatory.rhoCosPhi === undefined || observatory.rhoSinPhi === undefined) {
		throw new RangeError(`observatory ${observatory.code} is missing longitude/ρ and cannot be written as a flatfile line`)
	}
	const lon = padNumeric(toDeg(observatory.longitude), 9, 5)
	const rhoCos = padNumeric(observatory.rhoCosPhi, 8, 6)
	const rhoSin = padSignedNumeric(observatory.rhoSinPhi, 9, 6)
	return `${observatory.code.padEnd(3)} ${lon}${rhoCos}${rhoSin}${observatory.name}`
}

// Geocentric ITRS position in AU. Returns `undefined` when geometry is missing or the vector is the origin (code 500).
export function observatoryItrsPosition(observatory: MPCObservatory, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): Vec3 | undefined {
	if (observatory.longitude === undefined || observatory.rhoCosPhi === undefined || observatory.rhoSinPhi === undefined) return undefined
	const radius = ELLIPSOID_PARAMETERS[ellipsoid].radius
	const x = observatory.rhoCosPhi * Math.cos(observatory.longitude) * radius
	const y = observatory.rhoCosPhi * Math.sin(observatory.longitude) * radius
	const z = observatory.rhoSinPhi * radius
	if (x === 0 && y === 0 && z === 0) return undefined
	return [x, y, z]
}

// Geodetic position from the ITRS vector via `geocentricLocation`. Not a heliocentric `observerPosition`.
export function observatoryLocation(observatory: MPCObservatory, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition | undefined {
	const itrs = observatoryItrsPosition(observatory, ellipsoid)
	if (!itrs) return undefined
	return geocentricLocation(itrs[0], itrs[1], itrs[2], ellipsoid)
}

function parseObservatory(raw: unknown): MPCObservatory {
	if (!isRecord(raw)) throw new Error('observatory record is not an object')

	const code = optionalIdentity(raw.obscode)
	if (!code) throw new Error('observatory record is missing obscode')

	const observationType = optionalString(raw.observations_type)
	if (observationType !== undefined && !OBSERVATORY_TYPES.has(observationType)) throw new Error(`unknown observatory observations_type "${observationType}"`)

	return {
		code,
		name: optionalString(raw.name) ?? '',
		nameUtf8: optionalString(raw.name_utf8),
		nameLatex: optionalString(raw.name_latex),
		shortName: optionalString(raw.short_name),
		longitude: optionalAngleDeg(raw.longitude),
		rhoCosPhi: optionalNumber(raw.rhocosphi),
		rhoSinPhi: optionalNumber(raw.rhosinphi),
		firstDate: optionalString(raw.firstdate),
		lastDate: optionalString(raw.lastdate),
		webLink: optionalString(raw.web_link),
		createdAt: optionalString(raw.created_at),
		updatedAt: optionalString(raw.updated_at),
		usesTwoLineObservations: optionalBoolean(raw.uses_two_line_observations),
		observationType: observationType as MPCObservatoryType | undefined,
		oldNames: optionalStringArray(raw.old_names),
	}
}

function parseOptionalFlatNumber(line: string, start: number, end: number): number | undefined {
	if (line.length <= start) return undefined
	const field = line.slice(start, Math.min(end, line.length)).trim()
	if (!field) return undefined
	return optionalNumber(field)
}

function padNumeric(value: number, width: number, decimals: number) {
	const text = Math.abs(value).toFixed(decimals)
	if (text.length > width) throw new RangeError(`value ${value} does not fit in a ${width}-character field`)
	return text.padStart(width, ' ')
}

function padSignedNumeric(value: number, width: number, decimals: number) {
	const sign = value < 0 || Object.is(value, -0) ? '-' : '+'
	const text = `${sign}${Math.abs(value).toFixed(decimals)}`
	if (text.length > width) throw new RangeError(`value ${value} does not fit in a ${width}-character field`)
	return text.padStart(width, ' ')
}

function canonicalADESFields(raw: unknown): MPCADESCanonicalObservation {
	if (!isRecord(raw)) throw new Error('ADES observation is not an object')
	const canonical: Record<string, string | number | undefined> = {}

	for (const [key, value] of Object.entries(raw)) {
		const canonicalKey = ADES_FIELD_ALIASES[key.toLowerCase()]
		if (!canonicalKey) continue
		if (value === null) continue
		if (typeof value === 'string' || typeof value === 'number') canonical[canonicalKey] = value
	}

	return canonical
}

function parseADESTime(value: string): Time {
	const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})$/.exec(value.trim())
	if (!match) throw new Error(`invalid ADES obsTime "${value}"`)
	const year = +match[1]
	const month = +match[2]
	const day = +match[3]
	const hour = +match[4]
	const minute = +match[5]
	let second = +match[6]
	const offset = match[7]

	if (offset !== 'Z') {
		const sign = offset.startsWith('-') ? -1 : 1
		const digits = offset.slice(1).replace(':', '')
		const offsetHours = +(digits.slice(0, 2) || '0')
		const offsetMinutes = +(digits.slice(2, 4) || '0')
		second -= sign * (offsetHours * 3600 + offsetMinutes * 60)
	}

	return timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC)
}

function formatADESTime(time: Time): string {
	const [year, month, day, fraction] = eraJdToCal(time.day, time.fraction)
	let seconds = fraction * 86400
	if (seconds < 0) seconds = 0
	if (seconds >= 86400) seconds = 86399.999
	const hour = Math.floor(seconds / 3600)
	const minute = Math.floor((seconds - hour * 3600) / 60)
	const second = seconds - hour * 3600 - minute * 60
	const whole = Math.floor(second)
	const milli = Math.round((second - whole) * 1000)
	const carry = milli === 1000
	const s = carry ? whole + 1 : whole
	const ms = carry ? 0 : milli
	return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(s)}.${String(ms).padStart(3, '0')}Z`
}

// Canonicalizes one ADES JSON or PSV record and converts units to radians/AU/UTC.
export function parseADESObservation(raw: unknown): MPCObservation {
	const fields = canonicalADESFields(raw)
	const obsTime = fields.obsTime
	const stn = fields.stn
	if (typeof obsTime !== 'string' || !obsTime) throw new Error('ADES observation is missing obsTime')
	if (typeof stn !== 'string' || !stn) throw new Error('ADES observation is missing stn')

	const obsType = inferObsType(fields)
	const base = parseObservationBase(fields, obsTime, stn, obsType)
	const observer = parseEmbeddedObserver(fields)

	if (obsType === 'radar') {
		return {
			...base,
			type: 'radar',
			delay: microsecondsToSeconds(optionalNumber(fields.delay)),
			delayError: microsecondsToSeconds(optionalNumber(fields.rmsDelay)),
			doppler: optionalNumber(fields.doppler),
			dopplerError: optionalNumber(fields.rmsDoppler),
			transmitFrequency: megahertzToHertz(optionalNumber(fields.frq)),
			transmitterStation: optionalIdentity(fields.trx),
			receiverStation: optionalIdentity(fields.rcv),
			bounce: parseBounce(fields.com),
		}
	}

	if (obsType === 'offset') {
		const deltaRightAscension = optionalAngleDeg(fields.deltaRA)
		const deltaDeclination = optionalAngleDeg(fields.deltaDec)
		if (deltaRightAscension === undefined || deltaDeclination === undefined) throw new Error('offset ADES observation is missing deltaRA/deltaDec')

		return {
			...base,
			type: 'offset',
			deltaRightAscension,
			deltaDeclination,
			starRightAscension: optionalAngleDeg(fields.raStar),
			starDeclination: optionalAngleDeg(fields.decStar),
			observer,
		}
	}

	if (obsType === 'occultation') {
		return {
			...base,
			type: 'occultation',
			rightAscension: optionalAngleDeg(fields.ra),
			declination: optionalAngleDeg(fields.dec),
			raError: optionalArcsec(fields.rmsRA),
			decError: optionalArcsec(fields.rmsDec),
			observer,
		}
	}

	const rightAscension = optionalAngleDeg(fields.ra)
	const declination = optionalAngleDeg(fields.dec)
	if (rightAscension === undefined || declination === undefined) throw new Error('optical ADES observation is missing finite ra/dec')

	return {
		...base,
		type: 'optical',
		rightAscension,
		declination,
		raError: optionalArcsec(fields.rmsRA),
		decError: optionalArcsec(fields.rmsDec),
		raDecCorrelation: optionalNumber(fields.rmsCorr),
		magnitude: optionalNumber(fields.mag),
		magnitudeError: optionalNumber(fields.rmsMag),
		band: optionalString(fields.band) ?? optionalString(fields.fltr),
		astrometricCatalog: optionalString(fields.astCat),
		photometricCatalog: optionalString(fields.photCat),
		exposure: optionalNumber(fields.exp),
		seeing: optionalArcsec(fields.seeing),
		rmsFit: optionalArcsec(fields.rmsFit),
		stars: optionalNumber(fields.nStars),
		observer,
	}
}

function parseObservationBase(fields: MPCADESCanonicalObservation, obsTime: string, stn: string, type: MPCObservation['type']): MPCObservationBase {
	return {
		type,
		time: parseADESTime(obsTime),
		station: stn,
		permanentId: optionalIdentity(fields.permID),
		provisionalId: optionalIdentity(fields.provID),
		trackletId: optionalIdentity(fields.trkID) ?? optionalIdentity(fields.trkMPC),
		trackletSubmissionId: optionalIdentity(fields.trkSub),
		observationId: optionalIdentity(fields.obsID),
		submissionObservationId: optionalIdentity(fields.obsSubID),
		mode: optionalString(fields.mode),
		reference: optionalString(fields.ref),
		notes: optionalString(fields.notes),
		remarks: optionalString(fields.remarks),
		programCode: optionalString(fields.prog),
		discovery: fields.disc === '*',
		deprecated: optionalString(fields.deprecated),
		catalog: optionalString(fields.astCat),
		submissionFormat: optionalString(fields.subFmt) ?? optionalString(fields.subFrm),
	}
}

function inferObsType(fields: MPCADESCanonicalObservation): MPCObservation['type'] {
	const raw = fields.obsType

	if (typeof raw === 'string' && raw.length > 0) {
		const type = raw.toLowerCase()
		if (type === 'optical' || type === 'offset' || type === 'occultation' || type === 'radar') return type
		throw new Error(`unknown ADES obsType "${raw}"`)
	}

	if (fields.ra !== undefined && fields.dec !== undefined) return 'optical'
	if (fields.delay !== undefined || fields.doppler !== undefined) return 'radar'
	if (fields.deltaRA !== undefined) return 'offset'
	throw new Error('ADES observation is missing obsType and cannot be inferred')
}

function parseEmbeddedObserver(fields: MPCADESCanonicalObservation): MPCEmbeddedObserver | undefined {
	const sys = optionalString(fields.sys)
	if (!sys) return undefined

	if (SPACECRAFT_SYS.has(sys)) {
		const pos1 = optionalNumber(fields.pos1)
		const pos2 = optionalNumber(fields.pos2)
		const pos3 = optionalNumber(fields.pos3)
		if (pos1 === undefined || pos2 === undefined || pos3 === undefined) throw new Error('spacecraft ADES observation is missing pos1/pos2/pos3')
		const position: Vec3 = sys === 'ICRF_KM' ? [kilometer(pos1), kilometer(pos2), kilometer(pos3)] : [pos1, pos2, pos3]
		return { kind: 'spacecraft', sys: sys as 'ICRF_KM' | 'ICRF_AU', center: optionalNumber(fields.ctr), position }
	}

	if (GEODETIC_SYS.has(sys)) {
		const longitude = optionalAngleDeg(fields.pos1)
		const latitude = optionalAngleDeg(fields.pos2)
		const elevationMeters = optionalNumber(fields.pos3)
		if (longitude === undefined || latitude === undefined || elevationMeters === undefined) throw new Error('geodetic ADES observation is missing pos1/pos2/pos3')
		return { kind: 'geodetic', sys: sys as 'WGS84' | 'ITRF' | 'IAU', longitude, latitude, elevation: meter(elevationMeters) }
	}

	throw new Error(`unknown ADES observer sys "${sys}"`)
}

function parseBounce(value: unknown): 'surface' | 'com' | undefined {
	if (value === null || value === undefined || value === '') return undefined
	if (value === true || value === 'C' || value === 'c' || value === 'COM' || value === 'com') return 'com'
	if (value === false || value === 'S' || value === 's' || value === 'surface') return 'surface'
	return undefined
}

function microsecondsToSeconds(value: number | undefined) {
	return value === undefined ? undefined : value * 1e-6
}

function megahertzToHertz(value: number | undefined) {
	return value === undefined ? undefined : value * 1e6
}

const ADES_PSV_SPLIT_REGEX = /\r?\n/

// Parses ADES PSV text (LF or CRLF). Context blocks are kept separate from the observation rows.
export function parseADESPSV(text: string): MPCADESDocument {
	const lines = text.split(ADES_PSV_SPLIT_REGEX)
	let version: MPCADESVersion = '2022'
	let section: string | undefined
	let context: Record<string, unknown> = {}
	let header: string[] | undefined
	const blocks: MPCADESBlock[] = []
	let observations: MPCObservation[] = []

	const flush = () => {
		if (!header && observations.length === 0 && !hasContext(context)) return

		blocks.push({
			context: hasContext(context) ? normalizeContext(context) : undefined,
			observations,
		})

		observations = []
	}

	for (const rawLine of lines) {
		const line = rawLine.trimEnd()

		if (!line) continue

		if (line.startsWith('# version=')) {
			const value = line.slice('# version='.length).trim()
			if (value !== '2017' && value !== '2022') throw new Error(`unsupported ADES PSV version "${value}"`)
			version = value
			continue
		}

		if (line.startsWith('#')) {
			if (header) {
				flush()
				header = undefined
				context = {}
			}

			section = line.slice(1).trim()

			continue
		}

		if (line.startsWith('!')) {
			if (!section) throw new Error(`ADES PSV metadata line has no section: ${line}`)
			const rest = line.slice(1).trim()
			const space = rest.indexOf(' ')
			const key = space === -1 ? rest : rest.slice(0, space)
			const value = space === -1 ? '' : rest.slice(space + 1)
			appendContext(context, section, key, value)
			continue
		}

		if (line.includes('|') && !header) {
			header = line.split('|').map((part) => part.trim())
			continue
		}

		if (header) {
			const values = splitPsv(line, header.length)
			const record: Record<string, string> = {}

			for (let i = 0; i < header.length; i++) {
				const value = values[i]?.trim() ?? ''
				if (value) record[header[i]] = value
			}

			observations.push(parseADESObservation(record))
		}
	}

	flush()

	if (blocks.length === 0) return { version, blocks: [{ observations: [] }] }
	return { version, blocks }
}

// Serializes a PSV document with LF line endings. Omitted fields stay empty; unmodeled comments are not invented.
export function writeADESPSV(document: MPCADESDocument): string {
	const lines: string[] = [`# version=${document.version}`]

	for (const block of document.blocks) {
		if (block.context) writeContext(lines, block.context)
		if (block.observations.length === 0) continue
		const rows = block.observations.map(observationToAdesRecord)
		const columns = collectPsvColumns(rows)
		lines.push(columns.join('|'))
		for (const row of rows) lines.push(columns.map((column) => row[column] ?? '').join('|'))
	}

	return `${lines.join('\n')}\n`
}

function splitPsv(line: string, count: number) {
	const parts = line.split('|')
	if (parts.length < count) while (parts.length < count) parts.push('')
	return parts
}

function hasContext(context: Record<string, unknown>) {
	return Object.keys(context).length > 0
}

function appendContext(context: Record<string, unknown>, section: string, key: string, value: string) {
	if (section === 'observers' || section === 'measurers' || section === 'comment') {
		const list = (context[section] as string[] | undefined) ?? []
		list.push(value)
		context[section] = list
		return
	}

	const current = (context[section] as Record<string, string> | undefined) ?? {}
	current[key] = value
	context[section] = current
}

function normalizeContext(context: Record<string, unknown>): MPCADESContext {
	const observatory = isRecord(context.observatory) ? context.observatory : undefined
	const submitter = isRecord(context.submitter) ? context.submitter : undefined
	const telescope = isRecord(context.telescope) ? context.telescope : undefined
	const software = isRecord(context.software) ? context.software : undefined

	return {
		observatory: observatory ? { mpcCode: optionalString(observatory.mpcCode), name: optionalString(observatory.name) } : undefined,
		submitter: submitter ? { name: optionalString(submitter.name), institution: optionalString(submitter.institution) } : undefined,
		observers: Array.isArray(context.observers) ? context.observers.map(String) : undefined,
		measurers: Array.isArray(context.measurers) ? context.measurers.map(String) : undefined,
		telescope: telescope
			? {
					aperture: optionalNumber(telescope.aperture),
					design: optionalString(telescope.design),
					detector: optionalString(telescope.detector),
				}
			: undefined,
		software: software ? { name: optionalString(software.name) } : undefined,
		comment: Array.isArray(context.comment) ? context.comment.map(String) : undefined,
	}
}

function writeContext(lines: string[], context: MPCADESContext) {
	if (context.observatory) {
		lines.push('# observatory')
		if (context.observatory.mpcCode) lines.push(`! mpcCode ${context.observatory.mpcCode}`)
		if (context.observatory.name) lines.push(`! name ${context.observatory.name}`)
	}
	if (context.submitter) {
		lines.push('# submitter')
		if (context.submitter.name) lines.push(`! name ${context.submitter.name}`)
		if (context.submitter.institution) lines.push(`! institution ${context.submitter.institution}`)
	}
	if (context.telescope) {
		lines.push('# telescope')
		if (context.telescope.aperture !== undefined) lines.push(`! aperture ${context.telescope.aperture}`)
		if (context.telescope.design) lines.push(`! design ${context.telescope.design}`)
		if (context.telescope.detector) lines.push(`! detector ${context.telescope.detector}`)
	}
	if (context.observers?.length) {
		lines.push('# observers')
		for (const name of context.observers) lines.push(`! name ${name}`)
	}
	if (context.measurers?.length) {
		lines.push('# measurers')
		for (const name of context.measurers) lines.push(`! name ${name}`)
	}
	if (context.software?.name) {
		lines.push('# software')
		lines.push(`! name ${context.software.name}`)
	}
	if (context.comment?.length) {
		lines.push('# comment')
		for (const line of context.comment) lines.push(`! line ${line}`)
	}
}

function observationToAdesRecord(observation: MPCObservation): Record<string, string> {
	const record: Record<string, string> = {
		obsType: observation.type,
		obsTime: formatADESTime(observation.time),
		stn: observation.station,
	}

	put(record, 'permID', observation.permanentId)
	put(record, 'provID', observation.provisionalId)
	put(record, 'trkSub', observation.trackletSubmissionId)
	put(record, 'trkID', observation.trackletId)
	put(record, 'obsID', observation.observationId)
	put(record, 'obsSubID', observation.submissionObservationId)
	put(record, 'mode', observation.mode)
	put(record, 'ref', observation.reference)
	put(record, 'notes', observation.notes)
	put(record, 'remarks', observation.remarks)
	put(record, 'prog', observation.programCode)
	put(record, 'deprecated', observation.deprecated)
	put(record, 'subFmt', observation.submissionFormat)
	if (observation.discovery) record.disc = '*'

	if (observation.type === 'optical') {
		record.ra = String(toDeg(observation.rightAscension))
		record.dec = String(toDeg(observation.declination))
		putNumber(record, 'rmsRA', observation.raError === undefined ? undefined : observation.raError / ASEC2RAD)
		putNumber(record, 'rmsDec', observation.decError === undefined ? undefined : observation.decError / ASEC2RAD)
		putNumber(record, 'rmsCorr', observation.raDecCorrelation)
		putNumber(record, 'mag', observation.magnitude)
		putNumber(record, 'rmsMag', observation.magnitudeError)
		put(record, 'band', observation.band)
		put(record, 'astCat', observation.astrometricCatalog)
		put(record, 'photCat', observation.photometricCatalog)
		putNumber(record, 'exp', observation.exposure)
		putNumber(record, 'seeing', observation.seeing === undefined ? undefined : observation.seeing / ASEC2RAD)
		putNumber(record, 'rmsFit', observation.rmsFit === undefined ? undefined : observation.rmsFit / ASEC2RAD)
		putNumber(record, 'nStars', observation.stars)
		writeObserver(record, observation.observer)
	} else if (observation.type === 'offset') {
		record.deltaRA = String(toDeg(observation.deltaRightAscension))
		record.deltaDec = String(toDeg(observation.deltaDeclination))
		putNumber(record, 'raStar', observation.starRightAscension === undefined ? undefined : toDeg(observation.starRightAscension))
		putNumber(record, 'decStar', observation.starDeclination === undefined ? undefined : toDeg(observation.starDeclination))
		writeObserver(record, observation.observer)
	} else if (observation.type === 'occultation') {
		putNumber(record, 'ra', observation.rightAscension === undefined ? undefined : toDeg(observation.rightAscension))
		putNumber(record, 'dec', observation.declination === undefined ? undefined : toDeg(observation.declination))
		putNumber(record, 'rmsRA', observation.raError === undefined ? undefined : observation.raError / ASEC2RAD)
		putNumber(record, 'rmsDec', observation.decError === undefined ? undefined : observation.decError / ASEC2RAD)
		writeObserver(record, observation.observer)
	} else {
		putNumber(record, 'delay', observation.delay === undefined ? undefined : observation.delay * 1e6)
		putNumber(record, 'rmsDelay', observation.delayError === undefined ? undefined : observation.delayError * 1e6)
		putNumber(record, 'doppler', observation.doppler)
		putNumber(record, 'rmsDoppler', observation.dopplerError)
		putNumber(record, 'frq', observation.transmitFrequency === undefined ? undefined : observation.transmitFrequency / 1e6)
		put(record, 'trx', observation.transmitterStation)
		put(record, 'rcv', observation.receiverStation)
		if (observation.bounce === 'com') record.com = 'C'
		if (observation.bounce === 'surface') record.com = 'S'
	}

	return record
}

function writeObserver(record: Record<string, string>, observer?: MPCEmbeddedObserver) {
	if (!observer) return

	record.sys = observer.sys

	if (observer.kind === 'spacecraft') {
		putNumber(record, 'ctr', observer.center)
		const [x, y, z] = observer.sys === 'ICRF_KM' ? observer.position.map(toKilometer) : observer.position
		record.pos1 = String(x)
		record.pos2 = String(y)
		record.pos3 = String(z)
		return
	}

	record.pos1 = String(toDeg(observer.longitude))
	record.pos2 = String(toDeg(observer.latitude))
	record.pos3 = String(toMeter(observer.elevation))
}

function collectPsvColumns(rows: Record<string, string>[]) {
	const columns = new Set<string>()

	for (const row of rows) {
		for (const key of Object.keys(row)) {
			columns.add(key)
		}
	}

	return [...columns]
}

function put(record: Record<string, string>, key: string, value?: string) {
	if (value !== undefined) record[key] = value
}

function putNumber(record: Record<string, string>, key: string, value?: number) {
	if (value !== undefined) record[key] = String(value)
}

const PACKED_DESIGNATION_REGEX = /^[A-Za-z0-9~_]{5,12}$/

// Packs a numbered, provisional, comet, satellite, or survey designation. Throws `RangeError` when it cannot be represented.
export function packMPCDesignation(value: string): string {
	const trimmed = value.trim()
	if (!trimmed) throw new RangeError('empty designation cannot be packed')
	if (PACKED_DESIGNATION_REGEX.test(trimmed) && looksPacked(trimmed)) return trimmed

	const numbered = parseNumberedDesignation(trimmed)
	if (numbered !== undefined) return packNumberedMinorPlanet(numbered)

	const satellite = parseSatelliteDesignation(trimmed)
	if (satellite) return satellite

	const comet = packCometDesignation(trimmed)
	if (comet) return comet

	const survey = packSurveyDesignation(trimmed)
	if (survey) return survey

	const provisional = packProvisionalMinorPlanet(trimmed)
	if (provisional) return provisional

	throw new RangeError(`designation "${value}" cannot be packed`)
}

const PACKED_PCDXAI_12_REGEX = /^[\d ]{4}[PCDXAI]/

// Unpacks a 5/7/8/12-character MPC packed designation, including the extended `_YHxxxx` scheme.
export function unpackMPCDesignation(value: string): string {
	const trimmed = value.trim()
	if (!trimmed) throw new RangeError('empty packed designation')

	if (trimmed.length === PACKED_PERMANENT_LENGTH) {
		if (trimmed.startsWith('~')) return String(PACKED_TILDE_NUMBER_BASE + fromBase62(trimmed.slice(1)))
		if (/^[A-Za-z][0-9]{4}$/.test(trimmed)) return String(base62Value(trimmed[0]) * 10000 + +trimmed.slice(1))
		if (/^\d{5}$/.test(trimmed)) return String(+trimmed)
		if (/^[JSUN]\d{3}S$/.test(trimmed)) return `${trimmed[0]} ${+trimmed.slice(1, 4)}`
		if (/^\d{4}[PCDXAI]$/.test(trimmed)) return `${+trimmed.slice(0, 4)}${trimmed[4]}`
	}

	if (trimmed.length === 8 && /^[PCDXAI]_/.test(trimmed)) return `${trimmed[0]}/${unpackMPCDesignation(trimmed.slice(1))}`
	if (trimmed.length === 8 && /^[PCDXAI][IJKL_]/.test(trimmed)) return `${trimmed[0]}/${unpackMPCDesignation(trimmed.slice(1))}`

	if (trimmed.length === 12 && PACKED_PCDXAI_12_REGEX.test(trimmed)) {
		const number = trimmed.slice(0, 4).trim()
		const type = trimmed[4]
		const rest = unpackMPCDesignation(trimmed.slice(5))
		return number ? `${+number}${type}/${rest}` : `${type}/${rest}`
	}

	if (trimmed.length === PACKED_PROVISIONAL_LENGTH) {
		if (trimmed.startsWith('PLS') || /^T[123]S/.test(trimmed)) {
			const survey = trimmed.startsWith('PLS') ? 'P-L' : `T-${trimmed[1]}`
			return `${trimmed.slice(3)} ${survey}`
		}
		if (trimmed.startsWith('_')) return unpackExtendedProvisional(trimmed)
		return unpackProvisional7(trimmed)
	}

	if (trimmed.startsWith('_') && trimmed.length === PACKED_PROVISIONAL_LENGTH) {
		return unpackExtendedProvisional(trimmed)
	}

	throw new RangeError(`packed designation "${value}" cannot be unpacked`)
}

const PACKED_PERMANENT_REGEX = /^(\d{5}|[A-Za-z]\d{4}|~[0-9A-Za-z]{4}|[JSUN]\d{3}S|\d{4}[PCDXAI])$/
const PACKED_PROVISIONAL_PLST_REGEX = /^(PLS|T[123]S)\d{4}$/
const PACKED_PROVISIONAL_IL_REGEX = /^[I-L]\d{2}/
const PACKED_PCDXAI_8_REGEX = /^[PCDXAI]/

function looksPacked(value: string) {
	if (value.length === PACKED_PERMANENT_LENGTH) {
		return PACKED_PERMANENT_REGEX.test(value)
	}
	if (value.length === PACKED_PROVISIONAL_LENGTH) {
		return PACKED_PROVISIONAL_PLST_REGEX.test(value) || value.startsWith('_') || PACKED_PROVISIONAL_IL_REGEX.test(value)
	}
	if (value.length === 8) return PACKED_PCDXAI_8_REGEX.test(value)
	if (value.length === 12) return PACKED_PCDXAI_12_REGEX.test(value)
	return false
}

const NUMBERED_DESIGNATION_REGEX = /^\(?(\d+)\)?$/

function parseNumberedDesignation(value: string) {
	const match = NUMBERED_DESIGNATION_REGEX.exec(value)
	if (!match) return undefined
	return +match[1]
}

function packNumberedMinorPlanet(n: number) {
	if (!Number.isInteger(n) || n < 0) throw new RangeError(`invalid numbered designation ${n}`)
	if (n < PACKED_LETTER_NUMBER_BASE) return String(n).padStart(PACKED_PERMANENT_LENGTH, '0')
	if (n < PACKED_TILDE_NUMBER_BASE) {
		const hi = Math.trunc(n / 10000)
		const lo = n % 10000
		return `${BASE62[hi]}${String(lo).padStart(4, '0')}`
	}
	if (n > PACKED_TILDE_NUMBER_MAX) throw new RangeError(`numbered designation ${n} exceeds the packed form`)
	return `~${toBase62(n - PACKED_TILDE_NUMBER_BASE, 4)}`
}

const PACKED_SATELLITE_DESIGNATION_REGEX = /^([JSUN])(\d{1,3})S$/
const READABLE_SATELLITE_DESIGNATION_REGEX = /^([JSUN])\s*(\d+)$/

function parseSatelliteDesignation(value: string) {
	const packed = PACKED_SATELLITE_DESIGNATION_REGEX.exec(value)
	if (packed) return `${packed[1]}${packed[2].padStart(3, '0')}S`
	const readable = READABLE_SATELLITE_DESIGNATION_REGEX.exec(value)
	if (readable) return `${readable[1]}${readable[2].padStart(3, '0')}S`
	return undefined
}

const SURVEY_DESIGNATION_REGEX = /^(\d+)\s+(P-L|T-1|T-2|T-3)$/

function packSurveyDesignation(value: string) {
	const match = SURVEY_DESIGNATION_REGEX.exec(value)
	if (!match) return undefined
	const survey = match[2] === 'P-L' ? 'PLS' : `T${match[2][2]}S`
	return `${survey}${match[1].padStart(4, '0')}`
}

const NUMBERED_COMET_DESIGNATION = /^(\d+)([PCDXAI])(?:\/(.+))?$/
const PREFIXED_COMET_DESIGNATION = /^([PCDXAI])\/(.+)$/

function packCometDesignation(value: string) {
	const numbered = NUMBERED_COMET_DESIGNATION.exec(value)

	if (numbered) {
		const head = `${numbered[1].padStart(4, '0')}${numbered[2]}`
		if (!numbered[3]) return head
		return `${head}${packProvisionalMinorPlanet(numbered[3]) ?? packCometProvisional(numbered[3])}`
	}

	const prefixed = PREFIXED_COMET_DESIGNATION.exec(value)

	if (prefixed) {
		const rest = packProvisionalMinorPlanet(prefixed[2]) ?? packCometProvisional(prefixed[2])
		if (!rest) throw new RangeError(`comet designation "${value}" cannot be packed`)
		return `${prefixed[1]}${rest}`
	}

	return packCometProvisional(value)
}

const PACKED_PROVISIONAL_COMET_REGEX = /^(A?\d{3,4})\s+([A-Y])(\d+)(?:-([A-Za-z]))?$/

function packCometProvisional(value: string) {
	const match = PACKED_PROVISIONAL_COMET_REGEX.exec(value)
	if (!match) return undefined
	const year = parseUnpackedYear(match[1])
	const order = +match[3]
	const fragment = match[4] ? match[4].toLowerCase() : '0'
	return `${packYear(year)}${match[2]}${packCycle(order)}${fragment}`
}

const PACKED_PROVISIONAL_MINOR_PLANET_REGEX = /^(A?\d{3,4})\s+([A-Y])([A-HJ-Z])(\d*)$/

function packProvisionalMinorPlanet(value: string) {
	const extended = packExtendedIfNeeded(value)
	if (extended) return extended
	const match = PACKED_PROVISIONAL_MINOR_PLANET_REGEX.exec(value)
	if (!match) return undefined
	const year = parseUnpackedYear(match[1])
	const cycle = match[4] ? +match[4] : 0
	if (cycle > MAX_ORIGINAL_PACKED_CYCLE) return packExtendedProvisional(year, match[2], orderFromLetters(match[3], cycle))
	return `${packYear(year)}${match[2]}${packCycle(cycle)}${match[3]}`
}

const PACKED_EXTENDED_REGEX = /^(20\d{2})\s+([A-Y])([A-HJ-Z])(\d+)$/

function packExtendedIfNeeded(value: string) {
	const match = PACKED_EXTENDED_REGEX.exec(value)
	if (!match) return undefined
	const cycle = +match[4]
	if (cycle <= MAX_ORIGINAL_PACKED_CYCLE) return undefined
	return packExtendedProvisional(+match[1], match[2], orderFromLetters(match[3], cycle))
}

function packExtendedProvisional(year: number, halfMonth: string, order: number) {
	if (year < 2010 || year > 2035) throw new RangeError(`extended packed designation year ${year} is out of range`)
	if (order < EXTENDED_PACKED_ORDER_BASE) throw new RangeError(`order ${order} does not use the extended packed form`)
	const yearChar = PACKED_YEAR_CHARS[year % 100]
	if (!yearChar || yearChar < 'A') throw new RangeError(`extended packed designation year ${year} is out of range`)
	return `_${yearChar}${halfMonth}${toBase62(order - EXTENDED_PACKED_ORDER_BASE, 4)}`
}

function unpackExtendedProvisional(value: string) {
	if (value.length !== 7 || value[0] !== '_') throw new RangeError(`invalid extended packed designation "${value}"`)
	const year = 2000 + base62Value(value[1])
	const halfMonth = value[2]
	const order = EXTENDED_PACKED_ORDER_BASE + fromBase62(value.slice(3))
	const { letter, cycle } = lettersFromOrder(order)
	return `${year} ${halfMonth}${letter}${cycle}`
}

function unpackProvisional7(value: string) {
	const year = unpackYear(value[0], value.slice(1, 3))
	const halfMonth = value[3]
	const last = value[6]

	if (last === '0' || (last >= 'a' && last <= 'z')) {
		const order = unpackCycle(value[4], value[5])
		const fragment = last === '0' ? '' : `-${last.toUpperCase()}`
		return `${formatUnpackedYear(year)} ${halfMonth}${order}${fragment}`
	}

	const cycle = unpackCycle(value[4], value[5])
	return `${formatUnpackedYear(year)} ${halfMonth}${last}${cycle || ''}`
}

function parseUnpackedYear(value: string) {
	if (value.startsWith('A') && value.length === 4) return 1000 + +value.slice(1)
	const year = +value
	if (!Number.isInteger(year)) throw new RangeError(`invalid designation year "${value}"`)
	return year
}

function formatUnpackedYear(year: number) {
	if (year < 1925) return `A${String(year).slice(-3)}`
	return String(year)
}

function packYear(year: number) {
	const century = PACKED_YEAR_CHARS[Math.trunc(year / 100)]
	if (!century) throw new RangeError(`year ${year} cannot be packed`)
	return `${century}${String(year % 100).padStart(2, '0')}`
}

function unpackYear(century: string, yy: string) {
	return base62Value(century) * 100 + +yy
}

function packCycle(cycle: number) {
	if (!Number.isInteger(cycle) || cycle < 0 || cycle > MAX_ORIGINAL_PACKED_CYCLE) throw new RangeError(`cycle ${cycle} cannot be packed in the original 7-character form`)
	if (cycle < 100) return String(cycle).padStart(2, '0')
	return `${BASE62[Math.trunc(cycle / 10)]}${cycle % 10}`
}

function unpackCycle(a: string, b: string) {
	if (a >= '0' && a <= '9' && b >= '0' && b <= '9') return +a * 10 + +b
	return base62Value(a) * 10 + +b
}

function orderFromLetters(letter: string, cycle: number) {
	const index = ORDER_LETTERS.indexOf(letter)
	if (index < 0) throw new RangeError(`invalid order letter "${letter}"`)
	return cycle * 25 + index + 1
}

function lettersFromOrder(order: number) {
	const index = (order - 1) % 25
	const cycle = Math.trunc((order - 1) / 25)
	return { letter: ORDER_LETTERS[index], cycle }
}

function toBase62(value: number, width: number) {
	if (value < 0) throw new RangeError('base-62 value must be non-negative')
	let remaining = value
	let text = ''
	for (let i = 0; i < width; i++) {
		text = BASE62[remaining % 62] + text
		remaining = Math.trunc(remaining / 62)
	}
	if (remaining !== 0) throw new RangeError(`value ${value} does not fit in ${width} base-62 characters`)
	return text
}

function fromBase62(text: string) {
	let value = 0
	for (const char of text) value = value * 62 + base62Value(char)
	return value
}

function base62Value(char: string) {
	const index = BASE62.indexOf(char)
	if (index < 0) throw new RangeError(`invalid base-62 character "${char}"`)
	return index
}

// Parses one 80-column MPC1992 line. Orphan second-line records throw.
export function parseMPC80(line: string): MPCObservation {
	const record = normalizeMpc80Line(line)
	const note2 = record[14]
	if (note2 === 's' || note2 === 'v' || note2 === 'w' || note2 === 'r' || note2 === 'q' || note2 === 't') throw new Error('orphan MPC80 second line')
	return parseMpc80FirstLine(record)
}

function flatMPC80Lines(line: string) {
	const trimmed = line.replace(/\r$/, '')
	return trimmed.trim() === '' ? [] : [normalizeMpc80Line(trimmed)]
}

// Parses MPC1992 text, consuming two-line satellite/roving/radar pairs when note 2 requires it.
export function parseMPC80Lines(text: string): readonly MPCObservation[] {
	const lines = text.split(/\r?\n/).flatMap(flatMPC80Lines)
	const observations: MPCObservation[] = []

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const note2 = line[14]

		if (note2 === 's' || note2 === 'v' || note2 === 'w' || note2 === 'r' || note2 === 'q' || note2 === 't') throw new Error('orphan MPC80 second line')

		if (TWO_LINE_NOTE2.has(note2)) {
			const second = lines[i + 1]
			if (!second) throw new Error('MPC80 two-line observation is missing its second record')
			observations.push(parseMpc80Pair(line, second))
			i++
			continue
		}

		observations.push(parseMpc80FirstLine(line))
	}

	return observations
}

// Writes one or two 80-column lines. `|dec| > 90°` throws `RangeError`.
export function writeMPC80(observation: MPCObservation): string {
	if (observation.type === 'radar' || observation.observer) return writeMpc80Pair(observation).join('\n')
	return writeMpc80OpticalLine(observation, note2For(observation))
}

// Writes MPC1992 records joined by LF, including a trailing newline.
export function writeMPC80Lines(observations: readonly MPCObservation[]): string {
	return `${observations.map(writeMPC80).join('\n')}\n`
}

function normalizeMpc80Line(line: string) {
	const record = line.replace(/\r$/, '')
	if (record.length !== MPC80_LENGTH) throw new Error(`MPC80 line must be ${MPC80_LENGTH} characters`)
	return record
}

function parseMpc80FirstLine(line: string, observer?: MPCEmbeddedObserver): MPCObservation {
	const note2 = line[14]
	const ids = parseMpc80Ids(line)
	const time = parseMpc80Time(line)
	const station = line.slice(77, 80)
	const discovery = line[12] === '*'
	const programCode = emptyToUndefined(line[13].trim())
	const notes = programCode
	const magnitudeField = line.slice(65, 70).trim()
	const band = emptyToUndefined(line[70].trim())

	const base: MPCObservationBase = {
		type: note2 === 'E' ? 'occultation' : note2 === 'O' ? 'offset' : note2 === 'R' || note2 === 'Q' ? 'radar' : 'optical',
		time,
		station,
		permanentId: ids.permanentId,
		provisionalId: ids.provisionalId,
		trackletSubmissionId: ids.temporaryId,
		mode: modeFromNote2(note2),
		programCode,
		notes,
		discovery: discovery || undefined,
		reference: emptyToUndefined(line.slice(71, 77).trim()),
	}

	if (base.type === 'radar') {
		return {
			...base,
			type: 'radar',
			delay: microsecondsToSeconds(parseImplicitDecimal(line.slice(32, 47), 11)),
			doppler: parseSignedImplicitDecimal(line.slice(47, 62), 11),
			transmitFrequency: megahertzToHertz(parseImplicitDecimal(line.slice(62, 68), 5)),
			transmitterStation: emptyToUndefined(line.slice(68, 71).trim()),
			receiverStation: station,
		}
	}

	const rightAscension = parseAngle(line.slice(32, 44), true)
	const declination = parseAngle(line.slice(44, 56))

	if (base.type === 'offset') {
		if (rightAscension === undefined || declination === undefined) throw new Error('offset MPC80 observation is missing RA/Dec')
		return { ...base, type: 'offset', deltaRightAscension: rightAscension, deltaDeclination: declination, observer }
	}

	if (base.type === 'occultation') {
		return { ...base, type: 'occultation', rightAscension, declination, observer }
	}

	if (rightAscension === undefined || declination === undefined) throw new Error('optical MPC80 observation is missing RA/Dec')

	return {
		...base,
		type: 'optical',
		rightAscension,
		declination,
		magnitude: magnitudeField ? optionalNumber(magnitudeField) : undefined,
		band,
		observer,
	}
}

function parseMpc80Pair(first: string, second: string): MPCObservation {
	const expected = first[14].toLowerCase()

	if (second[14].toLowerCase() !== expected && !(expected === 'w' && second[14] === 'v') && !(expected === 'q' && second[14] === 'r') && !(expected === 't' && second[14] === 's')) {
		if (second[14] !== expected.toLowerCase() && second[14] !== 's' && second[14] !== 'v' && second[14] !== 'r') {
			throw new Error('MPC80 two-line observation has a misaligned second record')
		}
	}

	if (first.slice(0, 12) !== second.slice(0, 12) || first.slice(15, 32) !== second.slice(15, 32)) {
		throw new Error('MPC80 two-line observation has a misaligned second record')
	}

	const note2 = first[14]

	if (note2 === 'S' || note2 === 's' || note2 === 'T' || note2 === 't') {
		return parseMpc80FirstLine(first, parseSatelliteSecondLine(second))
	}
	if (note2 === 'V' || note2 === 'v' || note2 === 'W' || note2 === 'w') {
		return parseMpc80Roving(first, second)
	}
	if (note2 === 'R' || note2 === 'r' || note2 === 'Q' || note2 === 'q') {
		return parseRadarPair(first, second)
	}

	throw new Error(`unsupported MPC80 two-line note "${note2}"`)
}

function parseMpc80Roving(first: string, second: string): MPCOpticalObservation {
	const optical = parseMpc80FirstLine(`${first.slice(0, 14)}C${first.slice(15)}`) as MPCOpticalObservation
	return { ...optical, type: 'optical', observer: parseRovingSecondLine(second), mode: optical.mode }
}

function parseSatelliteSecondLine(line: string): MPCSpacecraftObserver {
	const kind = line[32]
	if (kind !== '1' && kind !== '2') throw new Error(`unknown satellite parallax type "${kind}"`)
	const x = parseMpc80Number(line.slice(34, 45))
	const y = parseMpc80Number(line.slice(46, 57))
	const z = parseMpc80Number(line.slice(58, 69))
	if (x === undefined || y === undefined || z === undefined) throw new Error('satellite MPC80 second line is missing the position vector')
	const sys = kind === '1' ? 'ICRF_KM' : 'ICRF_AU'
	const position: Vec3 = sys === 'ICRF_KM' ? [kilometer(x), kilometer(y), kilometer(z)] : [x, y, z]
	return { kind: 'spacecraft', sys, position }
}

function parseRovingSecondLine(line: string): MPCGeodeticObserver {
	const longitude = optionalAngleDeg(parseMpc80Number(line.slice(34, 44)))
	const latitude = optionalAngleDeg(parseMpc80Number(line.slice(45, 55)))
	const elevation = parseMpc80Number(line.slice(56, 61))
	if (longitude === undefined || latitude === undefined || elevation === undefined) throw new Error('roving MPC80 second line is missing lon/lat/alt')
	return { kind: 'geodetic', sys: 'WGS84', longitude, latitude, elevation: meter(elevation) }
}

function parseRadarPair(first: string, second: string): MPCRadarObservation {
	const firstParsed = parseMpc80FirstLine(first) as MPCRadarObservation
	const bounce = second[32] === 'C' ? 'com' : second[32] === 'S' ? 'surface' : undefined

	return {
		...firstParsed,
		delayError: microsecondsToSeconds(parseImplicitDecimal(second.slice(32, 47), 11)),
		dopplerError: parseImplicitDecimal(second.slice(47, 62), 11),
		bounce,
	}
}

function parseMpc80Ids(line: string) {
	const packedPermanent = emptyToUndefined(line.slice(0, 5).trim())
	const packedProvisional = emptyToUndefined(line.slice(5, 12).trim())
	let permanentId: string | undefined
	let provisionalId: string | undefined
	let temporaryId: string | undefined

	if (packedPermanent) {
		const packed = packedPermanent.length < 5 && /^\d+$/.test(packedPermanent) ? packedPermanent.padStart(5, '0') : packedPermanent
		try {
			permanentId = unpackMPCDesignation(packed)
		} catch {
			permanentId = packedPermanent
		}
	}

	if (packedProvisional) {
		try {
			provisionalId = unpackMPCDesignation(packedProvisional)
		} catch {
			temporaryId = packedProvisional
		}
	}

	return { permanentId, provisionalId, temporaryId }
}

function parseMpc80Number(field: string) {
	return optionalNumber(field.replaceAll(' ', '') || undefined)
}

function parseMpc80Time(line: string): Time {
	const year = optionalNumber(line.slice(15, 19))
	const month = optionalNumber(line.slice(20, 22))
	const day = optionalNumber(line.slice(23, 32).trim())
	if (year === undefined || month === undefined || day === undefined) throw new Error('MPC80 observation is missing a date')
	const dayInt = Math.trunc(day)
	return timeYMD(year, month, dayInt, day - dayInt, Timescale.UTC)
}

function parseImplicitDecimal(field: string, integerWidth: number): number | undefined {
	const trimmed = field.trim()
	if (!trimmed || trimmed === '-' || trimmed === '+') return undefined
	if (trimmed.includes('.')) return optionalNumber(trimmed)
	const intPart = field.slice(0, integerWidth).replaceAll(/[+\- ]/g, '') || '0'
	const fracPart = field.slice(integerWidth).replaceAll(' ', '')
	const value = +(fracPart ? `${intPart}.${fracPart}` : intPart)
	if (!Number.isFinite(value)) return undefined
	return trimmed.startsWith('-') ? -Math.abs(value) : value
}

function parseSignedImplicitDecimal(field: string, integerWidth: number) {
	if (field.trim() === '-' || field.trim() === '') return undefined
	return parseImplicitDecimal(field, integerWidth)
}

function modeFromNote2(note2: string) {
	if (!note2.trim() || TWO_LINE_NOTE2.has(note2) || note2 === 'A' || note2 === 'E' || note2 === 'O') return undefined
	return note2
}

function note2For(observation: MPCObservation) {
	if (observation.type === 'radar') return 'R'
	if (observation.type === 'offset') return 'O'
	if (observation.type === 'occultation') return 'E'
	if (observation.observer?.kind === 'spacecraft') return 'S'
	if (observation.observer?.kind === 'geodetic') return 'V'
	if (observation.mode && observation.mode.length === 1) return observation.mode
	return 'C'
}

function writeMpc80OpticalLine(observation: MPCObservation, note2: string) {
	if (observation.type === 'radar') throw new RangeError('radar observations require the two-line MPC80 form')
	const ra = observation.type === 'offset' ? observation.deltaRightAscension : observation.rightAscension
	const dec = observation.type === 'offset' ? observation.deltaDeclination : observation.declination
	if (ra === undefined || dec === undefined) throw new RangeError('MPC80 optical/offset write requires RA and Dec')
	if (Math.abs(dec) > PIOVERTWO) throw new RangeError('declination exceeds 90 degrees')
	const ids = formatMpc80Ids(observation)
	const discovery = observation.discovery ? '*' : ' '
	const note1 = (observation.programCode ?? ' ').padEnd(1).slice(0, 1)
	const date = formatMpc80Date(observation.time)
	const raText = padField(formatAngle(ra, MPC80_RA_FORMAT), 12)
	const decText = padField(formatAngle(dec, MPC80_DEC_FORMAT), 12)
	const mag = formatMagnitude(observation.type === 'optical' ? observation.magnitude : undefined, observation.type === 'optical' ? observation.band : undefined)
	const reference = (observation.reference ?? '').padEnd(6).slice(0, 6)
	return `${ids}${discovery}${note1}${note2}${date}${raText}${decText}${' '.repeat(9)}${mag}${reference}${observation.station.padEnd(3).slice(0, 3)}`
}

function writeMpc80Pair(observation: MPCObservation) {
	if (observation.type === 'radar') return writeRadarPair(observation)
	const first = writeMpc80OpticalLine(observation, observation.observer?.kind === 'spacecraft' ? 'S' : 'V')
	if (observation.observer?.kind === 'spacecraft') return [first, writeSatelliteSecondLine(first, observation.observer, observation.station)]
	if (observation.observer?.kind === 'geodetic') return [first, writeRovingSecondLine(first, observation.observer, observation.station)]
	throw new RangeError('two-line MPC80 write requires a spacecraft, geodetic, or radar observation')
}

function writeSatelliteSecondLine(first: string, observer: MPCSpacecraftObserver, station: string) {
	const type = observer.sys === 'ICRF_KM' ? '1' : '2'
	const [x, y, z] = observer.sys === 'ICRF_KM' ? observer.position.map(toKilometer) : observer.position
	const vector = type === '1' ? `${formatSatelliteKm(x)} ${formatSatelliteKm(y)} ${formatSatelliteKm(z)}` : `${formatSatelliteAu(x)} ${formatSatelliteAu(y)} ${formatSatelliteAu(z)}`
	return `${first.slice(0, 12)} ${first[13]}s${first.slice(15, 32)}${type} ${vector}${' '.repeat(Math.max(0, 8))}${station}`.slice(0, 80).padEnd(80)
}

function writeRovingSecondLine(first: string, observer: MPCGeodeticObserver, station: string) {
	const lon = padNumeric(toDeg(observer.longitude), 10, 6)
	const lat = padSignedNumeric(toDeg(observer.latitude), 10, 6)
	const alt = String(Math.round(toMeter(observer.elevation))).padStart(5, ' ')
	return `${first.slice(0, 12)} ${first[13]}v${first.slice(15, 32)}1 ${lon} ${lat} ${alt}${' '.repeat(16)}${station}`.slice(0, 80).padEnd(80)
}

function writeRadarPair(observation: MPCRadarObservation): readonly [string, string] {
	const ids = formatMpc80Ids(observation)
	const date = formatMpc80Date(observation.time)
	const delay = formatImplicitDecimal((observation.delay ?? 0) * 1e6, 15, 4, 11)
	const doppler = formatSignedImplicitDecimal(observation.doppler ?? 0, 15, 4, 11)
	const freq = formatImplicitDecimal((observation.transmitFrequency ?? 0) / 1e6, 6, 1, 5)
	const trx = (observation.transmitterStation ?? observation.station).padEnd(3).slice(0, 3)
	const rcv = (observation.receiverStation ?? observation.station).padEnd(3).slice(0, 3)
	const first = `${ids}  R${date}${delay}${doppler}${freq}${trx}${' '.repeat(6)}${rcv}`
	const bounce = observation.bounce === 'com' ? 'C' : 'S'
	const delayErr = formatImplicitDecimal((observation.delayError ?? 0) * 1e6, 14, 4, 11)
	const dopplerErr = formatImplicitDecimal(observation.dopplerError ?? 0, 15, 4, 11)
	const second = `${ids}  r${date}${bounce}${delayErr}${dopplerErr}${' '.repeat(6)}${trx}${' '.repeat(6)}${rcv}`
	return [first.padEnd(80).slice(0, 80), second.padEnd(80).slice(0, 80)]
}

function formatMpc80Ids(observation: MPCObservation) {
	const permanent = observation.permanentId ? packMPCDesignation(observation.permanentId).padEnd(5).slice(0, 5) : '     '
	const packedPermanent = permanent.length === 5 ? permanent : permanent.padStart(5, ' ')
	let provisional = '       '
	const source = observation.provisionalId ?? observation.trackletSubmissionId

	if (source) {
		try {
			const packed = packMPCDesignation(source)
			provisional = packed.length === 7 ? packed : source.padEnd(7).slice(0, 7)
		} catch {
			provisional = source.padEnd(7).slice(0, 7)
		}
	}

	const ids = `${packedPermanent}${provisional}`
	if (ids.length !== 12) throw new RangeError('MPC80 designation fields must occupy columns 1-12')
	return ids
}

function formatMpc80Date(time: Time) {
	const [year, month, day, fraction] = eraJdToCal(time.day, time.fraction)
	let frac = fraction
	const d = frac >= 1 ? day + 1 : day
	if (frac >= 1) frac -= 1
	return `${pad4(year)} ${pad2(month)} ${pad2(d)}${frac.toFixed(6).slice(1)}`
}

function formatMagnitude(magnitude?: number, band?: string) {
	if (magnitude === undefined) return '      '
	const mag = magnitude.toFixed(2).padStart(5, ' ')
	return `${mag}${(band ?? ' ').slice(0, 1)}`
}

function formatSatelliteKm(value: number) {
	return padSignedNumeric(value, 11, value >= 100000 || value <= -100000 ? 2 : 4)
}

function formatSatelliteAu(value: number) {
	return padSignedNumeric(value, 11, 8)
}

function formatImplicitDecimal(value: number, width: number, decimals: number, integerWidth: number) {
	const scaled = Math.round(Math.abs(value) * 10 ** decimals)
	const digits = String(scaled).padStart(integerWidth + decimals, '0')
	const text = digits.padStart(width, ' ')
	return text.slice(-width)
}

function formatSignedImplicitDecimal(value: number, width: number, decimals: number, integerWidth: number) {
	const sign = value < 0 ? '-' : '+'
	const body = formatImplicitDecimal(Math.abs(value), width - 1, decimals, integerWidth)
	return `${sign}${body}`.slice(-width).padStart(width, ' ')
}

function padField(value: string, width: number) {
	if (value.length > width) return value.slice(0, width)
	return value.padEnd(width, ' ')
}

function emptyToUndefined(value: string) {
	return value ? value : undefined
}

function pad2(value: number) {
	return String(value).padStart(2, '0')
}

function pad4(value: number) {
	return String(value).padStart(4, '0')
}

// Low-level `get-obs` for a single designation. Throws on HTTP error, including a missing object.
export async function queryObservations(designation: string, options?: MPCObservationQueryOptions): Promise<MPCObservationPayload> {
	const body = await mpcRequest(GET_OBS_PATH, observationQueryPayload(designation, options), options?.signal)
	return parseObservationPayload(unwrapMpcEnvelope(body))
}

// High-level ADES_DF observations. Known misses (`found=0` / `Bad Label`) return `[]`.
export async function observations(designation: string, adesVersion: MPCADESVersion = '2022', signal?: AbortSignal): Promise<readonly MPCObservation[]> {
	const result = await mpcFetch(GET_OBS_PATH, observationQueryPayload(designation, { adesVersion, outputFormats: ['ADES_DF'] }), signal)

	if (!result.ok) {
		if (isMpcLookupMiss(result.status, result.body)) return []
		throw mpcHttpError(GET_OBS_PATH, result)
	}

	const payload = parseObservationPayload(unwrapMpcEnvelope(result.body))
	return (payload.ades ?? []).map(parseADESObservation)
}

// Low-level NEOCP `get-obs-neocp` for one tracklet. Empty `ADES_DF` is a successful miss, not an HTTP error.
export async function queryNEOCPObservations(tracklet: string, options?: MPCObservationQueryOptions): Promise<MPCObservationPayload> {
	const body = await mpcRequest(GET_OBS_NEOCP_PATH, { trksubs: [tracklet], ...observationFormatFields(options) }, options?.signal)
	return parseObservationPayload(unwrapMpcEnvelope(body))
}

// High-level NEOCP observations. Empty payload and known misses return `[]`.
export async function neocpObservations(tracklet: string, adesVersion: MPCADESVersion = '2022', signal?: AbortSignal): Promise<readonly MPCObservation[]> {
	const result = await mpcFetch(GET_OBS_NEOCP_PATH, { trksubs: [tracklet], output_format: ['ADES_DF'], ades_version: adesVersion }, signal)

	if (!result.ok) {
		if (isMpcLookupMiss(result.status, result.body)) return []
		throw mpcHttpError(GET_OBS_NEOCP_PATH, result)
	}

	const payload = parseObservationPayload(unwrapMpcEnvelope(result.body))
	return (payload.ades ?? []).map(parseADESObservation)
}

function observationQueryPayload(designation: string, options?: MPCObservationQueryOptions) {
	return { desigs: [designation], ...observationFormatFields(options) }
}

function observationFormatFields(options?: MPCObservationQueryOptions) {
	const formats = options?.outputFormats?.length ? options.outputFormats : (['ADES_DF'] as const)
	for (const format of formats) if (!OUTPUT_FORMATS.has(format)) throw new Error(`unsupported observation output format "${format}"`)
	const version = options?.adesVersion ?? '2022'
	if (version !== '2017' && version !== '2022') throw new Error(`unsupported ADES version "${version}"`)
	return { output_format: formats, ades_version: version }
}

function parseObservationPayload(raw: unknown): MPCObservationPayload {
	if (!isRecord(raw)) throw new Error('MPC observation payload is not an object')

	return {
		ades: Array.isArray(raw.ADES_DF) ? raw.ADES_DF : undefined,
		obs80: typeof raw.OBS80 === 'string' ? raw.OBS80 : undefined,
		obsDf: parseObsDf(raw.OBS_DF),
	}
}

function parseObsDf(value: unknown): readonly { readonly obs80: string }[] | undefined {
	if (value === null || value === undefined) return undefined
	if (!Array.isArray(value)) throw new Error('OBS_DF must be an array')

	return value.map((item) => {
		if (!isRecord(item) || typeof item.obs80 !== 'string') throw new Error('OBS_DF entries must be { obs80: string }')
		return { obs80: item.obs80 }
	})
}

// Fetches `mpc_orb[0]` for one object. Empty `mpc_orb` (unknown body or natural satellite without a heliocentric orbit) is `undefined`.
export async function orbit(designation: string, signal?: AbortSignal): Promise<MPCOrbitSolution | undefined> {
	const result = await mpcFetch(GET_ORB_PATH, { desig: designation }, signal)

	if (!result.ok) {
		if (isMpcLookupMiss(result.status, result.body)) return undefined
		throw mpcHttpError(GET_ORB_PATH, result)
	}

	const payload = unwrapMpcEnvelope(result.body)
	if (!isRecord(payload)) throw new Error('MPC orbit payload is not an object')
	const records = payload.mpc_orb
	if (!Array.isArray(records) || records.length === 0) return undefined
	return parseOrbitSolution(records[0])
}

// Extracts the 6-parameter heliocentric CAR state. Returns `undefined` when names, epoch, or frame are unrecognized.
export function orbitCartesianState(orbit: MPCOrbitSolution): MPCOrbitCartesianState | undefined {
	const car = orbit.car
	const epochData = orbit.epochData
	const systemData = orbit.systemData
	if (!car || !epochData || !systemData) return undefined
	if (car.coefficientNames.length < 6) return undefined
	for (let i = 0; i < 6; i++) if (car.coefficientNames[i] !== CAR_STATE_NAMES[i]) return undefined
	const position: Vec3 = [car.coefficients[0], car.coefficients[1], car.coefficients[2]]
	const velocity: Vec3 = [car.coefficients[3], car.coefficients[4], car.coefficients[5]]
	if (![...position, ...velocity].every(Number.isFinite)) return undefined
	const scale = epochData.timeSystem === 'TDT' ? Timescale.TT : Timescale.TDB
	const epoch = epochData.timeForm === 'MJD' ? timeMJD(epochData.epoch, scale) : time(epochData.epoch, 0, scale)

	return {
		epoch,
		position,
		velocity,
		covariance: reconstructCovariance(car.covarianceValues),
		referenceSystem: systemData.referenceSystem,
		referenceFrame: systemData.referenceFrame,
		timeSystem: epochData.timeSystem,
		ephemeris: systemData.ephemeris,
	}
}

// Builds a `KeplerOrbit` from CAR. Ecliptic states use the class default rotation; equatorial states use identity. Satellites return `undefined`.
export function orbitToKeplerOrbit(orbit: MPCOrbitSolution): KeplerOrbit | undefined {
	const objectType = orbit.categorization?.objectTypeInt
	if (objectType !== undefined && NATURAL_SATELLITE_OBJECT_TYPES.has(objectType)) return undefined
	const state = orbitCartesianState(orbit)
	if (!state) return undefined
	const rotation = state.referenceSystem === 'Equatorial' ? matIdentity() : undefined
	return rotation ? new KeplerOrbit(state.position, state.velocity, state.epoch, GM_SUN_PITJEVA_2005, rotation) : new KeplerOrbit(state.position, state.velocity, state.epoch, GM_SUN_PITJEVA_2005)
}

function parseOrbitSolution(raw: unknown): MPCOrbitSolution {
	if (!isRecord(raw)) throw new Error('mpc_orb record is not an object')

	return {
		car: parseElementSet(raw.CAR),
		com: parseElementSet(raw.COM),
		kep: parseElementSet(raw.KEP),
		designationData: parseOrbitDesignation(raw.designation_data),
		epochData: parseEpochData(raw.epoch_data),
		systemData: parseSystemData(raw.system_data),
		magnitudeData: parseMagnitudeData(raw.magnitude_data),
		moidData: parseMoidData(raw.moid_data),
		categorization: parseCategorization(raw.categorization),
		orbitFitStatistics: parseFitStatistics(raw.orbit_fit_statistics),
		nonGravBooleans: parseNonGrav(raw.non_grav_booleans),
		softwareData: parseSoftware(raw.software_data),
	}
}

function parseElementSet(value: unknown): MPCOrbitElementSet | undefined {
	if (value === null || value === undefined) return undefined
	if (!isRecord(value)) throw new Error('orbit element set is not an object')
	const names = value.coefficient_names
	const coefficients = value.coefficients ?? value.coefficient_values
	if (!Array.isArray(names) || !Array.isArray(coefficients)) return undefined
	const covarianceValues: Record<string, number> = {}
	const covarianceSource = isRecord(value.covariance) ? value.covariance : value
	for (const [key, entry] of Object.entries(covarianceSource)) {
		if (!key.startsWith('cov')) continue
		const number = optionalNumber(entry)
		if (number !== undefined) covarianceValues[key] = number
	}
	return {
		coefficientNames: names.map(String),
		coefficients: coefficients.map((item) => {
			const number = optionalNumber(item)
			if (number === undefined) throw new Error('orbit coefficient is not finite')
			return number
		}),
		covarianceValues: Object.keys(covarianceValues).length > 0 ? covarianceValues : undefined,
	}
}

function parseEpochData(value: unknown): MPCOrbitEpochData | undefined {
	if (!isRecord(value)) return undefined
	const epoch = optionalNumber(value.epoch)
	const timeForm = optionalString(value.timeform)
	const timeSystem = optionalString(value.timesystem)
	if (epoch === undefined || (timeForm !== 'MJD' && timeForm !== 'JD') || (timeSystem !== 'TDT' && timeSystem !== 'TDB')) return undefined
	return { epoch, timeForm, timeSystem }
}

function parseSystemData(value: unknown): MPCOrbitSystemData | undefined {
	if (!isRecord(value)) return undefined
	const referenceSystemRaw = optionalString(value.refsys) ?? optionalString(value.refplane)
	if (referenceSystemRaw !== 'Ecliptic' && referenceSystemRaw !== 'Equatorial') return undefined
	const referenceFrame = optionalString(value.refframe)
	if (!referenceFrame) return undefined

	return {
		referenceSystem: referenceSystemRaw,
		referenceFrame,
		ephemeris: optionalString(value.eph),
		forceModel: optionalString(value.force_model),
		eclipticObliquityArcseconds: optionalNumber(value.EclipticObliquityArcseconds),
	}
}

function parseOrbitDesignation(value: unknown): MPCOrbitDesignationData | undefined {
	if (!isRecord(value)) return undefined

	return {
		name: optionalString(value.name),
		permanentId: optionalIdentity(value.permid),
		packedPermanentId: optionalIdentity(value.packed_permid),
		primaryProvisionalDesignation: optionalIdentity(value.unpacked_primary_provisional_designation),
		packedPrimaryProvisionalDesignation: optionalIdentity(value.packed_primary_provisional_designation),
	}
}

function parseMagnitudeData(value: unknown): MPCOrbitMagnitudeData | undefined {
	if (!isRecord(value)) return undefined
	return { h: optionalNumber(value.H) ?? optionalNumber(value.h), g: optionalNumber(value.G) ?? optionalNumber(value.g) }
}

function parseMoidData(value: unknown): MPCOrbitMoidData | undefined {
	if (!isRecord(value)) return undefined
	return { earth: optionalNumber(value.Earth) ?? optionalNumber(value.earth), jupiter: optionalNumber(value.Jupiter) ?? optionalNumber(value.jupiter) }
}

function parseCategorization(value: unknown): MPCOrbitCategorization | undefined {
	if (!isRecord(value)) return undefined

	return {
		objectType: optionalString(value.object_type) ?? optionalString(value.object_type_str),
		objectTypeInt: optionalNumber(value.object_type_int),
	}
}

function parseFitStatistics(value: unknown): MPCOrbitFitStatistics | undefined {
	if (!isRecord(value)) return undefined

	return {
		nObs: optionalNumber(value.n_obs) ?? optionalNumber(value.nobs),
		nOpp: optionalNumber(value.n_opp) ?? optionalNumber(value.nopp),
		arcLength: optionalNumber(value.arc_length),
		rms: optionalNumber(value.rms),
	}
}

function parseNonGrav(value: unknown): MPCOrbitNonGravBooleans | undefined {
	if (!isRecord(value)) return undefined
	return { nongravs: optionalBoolean(value.nongravs) ?? optionalBoolean(value.non_gravs) }
}

function parseSoftware(value: unknown): MPCOrbitSoftwareData | undefined {
	if (!isRecord(value)) return undefined
	return { software: optionalString(value.software) ?? optionalString(value.name) }
}

function reconstructCovariance(values?: Readonly<Record<string, number>>) {
	if (!values) return undefined
	const data = new Float64Array(36)

	for (let i = 0; i < 6; i++) {
		for (let j = i; j < 6; j++) {
			const value = values[`cov${i}${j}`]
			if (value === undefined) continue
			data[i * 6 + j] = value
			data[j * 6 + i] = value
		}
	}

	return new Matrix(6, 6, data)
}

// Queries one List API page. `limit` is forwarded unchanged when provided.
export async function list(type: MPCList, options?: MPCListOptions): Promise<MPCListResult> {
	if (!LIST_TYPES.has(type)) throw new Error(`unknown MPC list "${type}"`)
	const payload: Record<string, unknown> = { list: type }
	if (options?.order !== undefined) payload.order = options.order
	if (options?.limit !== undefined) payload.limit = options.limit
	if (options?.offset !== undefined) payload.offset = options.offset
	if (options?.like !== undefined) payload.like = options.like
	const body = await mpcRequest(LIST_PATH, payload, options?.signal)
	return parseListResult(body, type)
}

// Pages the List API until `maxItems` (required, ≥ 1) or a short page. Default page size 1000, capped at 50000.
export async function listAll(type: MPCList, options: Omit<MPCListOptions, 'offset'> & { readonly maxItems: number }): Promise<readonly MPCListItem[]> {
	// A non-finite maxItems would page the List API without bound.
	const maxItems = validatePositiveInteger(options.maxItems)
	const pageSize = Math.min(options.limit ?? DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE)
	if (pageSize < 1) throw new RangeError('listAll page size must be >= 1')
	const items: MPCListItem[] = []
	let offset = 0

	while (items.length < maxItems) {
		const page = await list(type, { ...options, limit: pageSize, offset })
		items.push(...page.items)
		if (page.items.length < pageSize) break
		offset += page.items.length
	}

	return items.slice(0, maxItems)
}

function parseListResult(raw: unknown, fallback: MPCList): MPCListResult {
	if (!isRecord(raw)) throw new Error('MPC list response is not an object')
	const items = raw.items
	if (!Array.isArray(items)) throw new Error('MPC list response is missing items')
	const requestRaw = isRecord(raw.request) ? raw.request : {}
	const listType = optionalString(requestRaw.list)

	return {
		items: items.map(parseListItem),
		request: {
			list: LIST_TYPES.has(listType ?? '') ? (listType as MPCList) : fallback,
			order: optionalString(requestRaw.order) === 'DESC' ? 'DESC' : 'ASC',
			limit: optionalNumber(requestRaw.limit) ?? MAX_LIST_PAGE_SIZE,
			offset: optionalNumber(requestRaw.offset) ?? 0,
			like: optionalString(requestRaw.like),
		},
	}
}

function parseListItem(raw: unknown): MPCListItem {
	if (!isRecord(raw)) throw new Error('MPC list item is not an object')
	const orbital = parseOrbitalParameters(raw.orbital_parameters)
	return {
		name: optionalString(raw.name),
		permanentId: optionalIdentity(raw.permid),
		permanentIdComet: optionalIdentity(raw.permid_comet),
		unpackedPrimaryProvisionalDesignation: optionalIdentity(raw.unpacked_primary_provisional_designation),
		unpackedPrimaryProvisionalDesignationComet: optionalIdentity(raw.unpacked_primary_provisional_designation_comet),
		citation: optionalString(raw.citation),
		group: optionalString(raw.group),
		reference: optionalString(raw.reference),
		published: optionalBoolean(raw.published),
		reason: optionalString(raw.reason),
		publicationReferences: raw.publication_references === null || raw.publication_references === undefined ? undefined : optionalStringArray(raw.publication_references),
		impactJulianDate: optionalNumber(raw.impact_date),
		impactLatitude: optionalAngleDeg(raw.impact_lat),
		impactLongitude: optionalAngleDeg(raw.impact_lon),
		orbitalParameters: orbital,
	}
}

function parseOrbitalParameters(value: unknown): Readonly<Record<string, string | number>> | undefined {
	if (value === null || value === undefined) return undefined
	if (!isRecord(value)) throw new Error('orbital_parameters must be an object')
	const result: Record<string, string | number> = {}
	for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string' || typeof entry === 'number') result[key] = entry
	return result
}

// Type guard for optical astrometry.
export function isOpticalObservation(observation: MPCObservation): observation is MPCOpticalObservation {
	return observation.type === 'optical'
}

// Permanent id, else provisional, else submitter tracklet id.
export function observationDesignation(observation: MPCObservation): string | undefined {
	return observation.permanentId ?? observation.provisionalId ?? observation.trackletSubmissionId
}

// `obsID`, else submission id. Does not synthesize a hash.
export function observationIdentifier(observation: MPCObservation): string | undefined {
	return observation.observationId ?? observation.submissionObservationId
}

// Maps optical RA/Dec and `rmsRA` (already RA·cos(dec), radians) into `OrbitFitObservation`. Does not fill observer position from the station.
export function observationToOrbitFitObservation(observation: MPCOpticalObservation, observerPosition: Vec3): OrbitFitObservation {
	return { rightAscension: observation.rightAscension, declination: observation.declination, time: observation.time, raErr: observation.raError, decErr: observation.decError, observerPosition }
}

// Converts optical observations with a resolved observer position; non-optical or unresolved rows go to `rejected`.
export function observationsToOrbitFit(observations: readonly MPCObservation[], resolveObserverPosition: MPCObserverPositionResolver): MPCOrbitFitInput {
	const fitted: OrbitFitObservation[] = []
	const rejected: MPCObservation[] = []

	for (const observation of observations) {
		if (!isOpticalObservation(observation)) {
			rejected.push(observation)
			continue
		}
		const observerPosition = resolveObserverPosition(observation.time, observation)
		if (!observerPosition) {
			rejected.push(observation)
			continue
		}
		fitted.push(observationToOrbitFitObservation(observation, observerPosition))
	}

	return { observations: fitted, rejected }
}
