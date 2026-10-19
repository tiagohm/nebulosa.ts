import { DAYSEC, DAYSPERJC, DAYSPERJY } from '../../core/constants'
import type { FitsHeader, FitsHeaderKey, FitsHeaderValue } from '../../io/formats/fits/fits'
import { type FitsMetadataDiagnostic, finiteMetadataKeyword, hasKeyword, parseFitsDateTimeFields, textMetadataKeyword } from '../../io/formats/fits/util'
import { roundToNthDecimal } from '../../math/numerical/math'
import { deg, parseAngle, toDeg } from '../../math/units/angle'
import { meter, toMeter } from '../../math/units/distance'
import { eraGd2Gce, eraJdToCal } from '../coordinates/erfa/erfa'
import { itrs } from '../coordinates/itrs'
import { Ellipsoid, type GeographicPosition, geocentricLocation, geodeticLocation } from '../observer/location'
import type { ExposureShutter, ExposureSpan, ExposureTimestamp } from './exposure'
import { type Time, Timescale, tai, time, timeConvert, timeShift, timeSubtract, timeYMDHMS, tt, utc, utcLeapSeconds } from './time'

// FITS observation timing and observatory metadata (FITS Standard 4.0 §4.4.2.2, §8.4.1 and §9): a pure
// parse/serialize layer between header keywords and two-part `Time` instants. The reader resolves the
// time scale (TIMESYS), reference position (TREFPOS), the DATE-xxxx/MJD-xxxx/TSTART/TSTOP instants with
// MJDREF/JDREF/DATEREF, TIMEOFFS and TIMEUNIT, the XPOSURE/EXPTIME/EXPOSURE and TELAPSE durations, the
// TIMSYER/TIMRDER errors and the OBSGEO-X/Y/Z, OBSGEO-B/L/H or SITELAT/SITELONG/SITEELEV location,
// following the Standard's precedence and reporting every default, assumption, invalid value and
// conflict as a diagnostic. Instants are returned in the header's own scale (GPS as TAI) with the
// reference position they were recorded at; nothing is light-time or barycentric corrected here.
// Durations and errors are SI seconds of that scale, distances meters on the header side and AU on the
// library side. The header is never mutated by the reader; the writer updates it in place.

// Time scale code of the TIMESYS keyword (FITS 4.0 Table 30) after resolving deprecated synonyms.
export type FitsTimeSystem = 'UTC' | 'TAI' | 'TT' | 'TDB' | 'TCG' | 'TCB' | 'UT1' | 'GPS' | 'LOCAL'

// Spatial location at which FITS time values are valid (TREFPOS, FITS 4.0 Table 31). The gas giants
// denote the barycenters of their systems.
export type FitsTimeReferencePosition = 'topocenter' | 'geocenter' | 'barycenter' | 'relocatable' | 'custom' | 'heliocenter' | 'galactic' | 'embarycenter' | 'mercury' | 'venus' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune'

// Keyword set that supplied the observatory location: OBSGEO-X/Y/Z (ITRS meters), OBSGEO-B/L/H
// (geodetic on the IAU 1976 ellipsoid), or the non-standard SITELAT/SITELONG/SITEELEV.
export type FitsLocationSource = 'geocentric' | 'geodetic' | 'site'

// One instant read from the header.
export interface FitsTimeValue {
	// The instant, in the library scale of the header (TAI for GPS), carrying the observatory location
	// when the reference position is the topocenter. Freshly allocated and owned by the caller.
	readonly time: Time
	// Keyword that supplied the value, e.g. 'DATE-BEG', 'MJD-OBS' or 'TSTART'.
	readonly keyword: FitsHeaderKey
	// One unit of the last written digit, in seconds: the value may be truncated or rounded to it.
	readonly resolution: number
}

// Typed timing and location metadata of one HDU.
export interface FitsTimeMetadata {
	// TIMESYS after resolving synonyms ('UTC' when absent), or undefined when unrecognized.
	readonly timeSystem?: FitsTimeSystem
	// Realization appended in parentheses to TIMESYS, e.g. 'BIPM08' for 'TT(BIPM08)'.
	readonly realization?: string
	// Library scale of every returned Time: the TIMESYS scale, TAI for GPS (TAI = GPS + 19 s), and
	// undefined for LOCAL or an unrecognized TIMESYS, in which case no instant is returned.
	readonly scale?: Timescale
	// TREFPOS (or the legacy TIMEREF) as declared; when both are absent, the barycenter for TDB and TCB and
	// the geocenter for TCG (FITS 4.0 §4.4.2.2, unlike the TOPOCENTER default of §9.2.3), else the
	// topocenter. Undefined when unrecognized.
	readonly referencePosition?: FitsTimeReferencePosition
	// TREFDIR as written: the keyword names of the longitude and latitude of the light-time reference direction.
	readonly referenceDirection?: string
	// PLEPHEM: Solar System ephemeris used for any light-time correction already applied, e.g. 'DE430'.
	readonly ephemeris?: string
	// DATE-OBS or MJD-OBS, whose role is the start by default (see `start`).
	readonly observation?: FitsTimeValue
	// Start of data acquisition: DATE-BEG/MJD-BEG, else DATE-OBS/MJD-OBS (reported as assumed), else TSTART.
	readonly start?: FitsTimeValue
	// DATE-AVG/MJD-AVG: a mid-observation instant whose averaging method FITS leaves undefined.
	readonly midpoint?: FitsTimeValue
	// End of data acquisition: DATE-END/MJD-END, else TSTOP.
	readonly end?: FitsTimeValue
	// Effective exposure in seconds: XPOSURE (in TIMEUNIT), else EXPTIME, else EXPOSURE.
	readonly exposure?: number
	// Header keyword that supplied `exposure`.
	readonly exposureKeyword?: FitsHeaderKey
	// TELAPSE, elapsed time between start and end, in seconds.
	readonly elapsed?: number
	// Whether start and end bound one continuous exposure. True only with positive evidence: an exposure
	// equal to end - start within their resolutions, and values fine enough to resolve the exposure (the
	// resolutions of start, end and the exposure plus the tolerance are smaller than it, so the span is
	// positive). False when end precedes start or the exposure differs from the span (dead time, co-added
	// frames, or a conflict). Undefined when start, end or the exposure is unknown, or when the
	// resolutions are too coarse to tell (an integer XPOSURE = 1 is known only to 1 s).
	readonly continuous?: boolean
	// TIMSYER, absolute (systematic) time error, in seconds.
	readonly systematicError?: number
	// TIMRDER, relative (random) time error between time stamps, in seconds.
	readonly randomError?: number
	// Observatory location, converted to a position on the IERS 2010 ellipsoid for OBSGEO keywords and on WGS84 for SITE keywords.
	readonly location?: GeographicPosition
	// Keyword set that supplied `location`.
	readonly locationSource?: FitsLocationSource
	// Defaults, assumptions, invalid or unsupported values and conflicts, in reading order.
	readonly diagnostics: readonly FitsMetadataDiagnostic[]
}

// Tolerances of readFitsTime.
export interface FitsTimeReadOptions {
	// Absolute slack in seconds added to the written resolutions when comparing two instants or
	// durations (default 1e-6, the double-precision step of an MJD).
	readonly tolerance?: number
	// Largest distance in meters accepted between two location keyword sets (default 100).
	readonly locationTolerance?: number
}

// Timing and location to serialize with writeFitsTime.
export interface FitsTimeInput {
	// TIMESYS scale; the instants are converted to it (default: scale of the first given instant, else UTC).
	readonly scale?: Timescale
	// Start of acquisition, written to DATE-OBS, DATE-BEG, MJD-OBS and MJD-BEG.
	readonly start?: Time
	// Mid-observation instant, written to DATE-AVG and MJD-AVG.
	readonly midpoint?: Time
	// End of acquisition, written to DATE-END and MJD-END; with `start` it also sets TELAPSE.
	readonly end?: Time
	// Effective exposure in seconds, written to XPOSURE and EXPTIME.
	readonly exposure?: number
	// TREFPOS: where the given instants are valid. Converting to `scale` changes only the clock, never
	// this origin, so 'barycenter' must be given only for instants already light-time corrected. Omitted
	// writes TOPOCENTER for TCG, TDB, and TCB, whose reader default (geocenter, barycenter) would
	// mislabel recorded times, and leaves TREFPOS absent (topocenter) for the other scales.
	readonly referencePosition?: FitsTimeReferencePosition
	// TREFDIR, e.g. 'RA,DEC'.
	readonly referenceDirection?: string
	// PLEPHEM, e.g. 'DE440'.
	readonly ephemeris?: string
	// Observatory, written to OBSGEO-X/Y/Z (meters) and SITELAT/SITELONG/SITEELEV (degrees, east-positive,
	// meters). It is the single location of the output: every instant is evaluated at it for the
	// topocentric TDB-TT term, replacing any other location the instant carries (a TDB or TCB instant is
	// rebased through TT; with a non-topocentric referencePosition it is kept as given and the location is
	// only recorded). Omitted, the location of
	// the first instant that has one (start, midpoint, end) takes its place, so the header always records
	// the site the conversion used.
	readonly location?: GeographicPosition
	// TIMSYER in seconds.
	readonly systematicError?: number
	// TIMRDER in seconds.
	readonly randomError?: number
	// Decimal places of the seconds in DATE-xxxx values, 0..9 (default 6).
	readonly digits?: number
}

// Keywords owned by readFitsTime and rewritten (or removed) by writeFitsTime.
export const FITS_TIME_KEYWORDS: readonly FitsHeaderKey[] = [
	'TIMESYS',
	'TIMEUNIT',
	'TREFPOS',
	'TIMEREF',
	'TREFDIR',
	'PLEPHEM',
	'DATE-OBS',
	'MJD-OBS',
	'DATE-BEG',
	'MJD-BEG',
	'DATE-AVG',
	'MJD-AVG',
	'DATE-END',
	'MJD-END',
	'TSTART',
	'TSTOP',
	'MJDREF',
	'MJDREFI',
	'MJDREFF',
	'JDREF',
	'JDREFI',
	'JDREFF',
	'DATEREF',
	'TIMEOFFS',
	'XPOSURE',
	'EXPTIME',
	'EXPOSURE',
	'TELAPSE',
	'TIMSYER',
	'TIMRDER',
	'OBSGEO-X',
	'OBSGEO-Y',
	'OBSGEO-Z',
	'OBSGEO-B',
	'OBSGEO-L',
	'OBSGEO-H',
	'SITELAT',
	'SITELONG',
	'SITEELEV',
]

// Default absolute slack, in seconds, when comparing values (about the double-precision step of an MJD).
const DEFAULT_TOLERANCE = 1e-6
// Default largest distance, in meters, between two location keyword sets before they conflict.
const DEFAULT_LOCATION_TOLERANCE = 100
// TAI - GPS, in seconds (FITS 4.0 Table 30).
const GPS_TO_TAI = 19
// IAU 1976 ellipsoid of OBSGEO-B/L/H as stated in FITS 4.0 §9.2.3: semi-major axis (m) and inverse flattening.
const IAU1976_RADIUS = 6378140
const IAU1976_INVERSE_FLATTENING = 298.2577
// Plausible geocentric distance range, in meters, of an OBSGEO-X/Y/Z site (rejects values written in km).
const MIN_GEOCENTRIC_RADIUS = 6.3e6
const MAX_GEOCENTRIC_RADIUS = 6.5e6
// Earliest year supported by the ERFA calendar conversion.
const MIN_CALENDAR_YEAR = -4799

// TIMESYS codes and their canonical system; `true` marks a deprecated or unqualified synonym.
const TIME_SYSTEMS: Readonly<Record<string, readonly [FitsTimeSystem, boolean]>> = {
	UTC: ['UTC', false],
	GMT: ['UTC', true],
	TAI: ['TAI', false],
	IAT: ['TAI', true],
	TT: ['TT', false],
	TDT: ['TT', true],
	ET: ['TT', true],
	TDB: ['TDB', false],
	TCG: ['TCG', false],
	TCB: ['TCB', false],
	UT1: ['UT1', false],
	UT: ['UT1', true],
	GPS: ['GPS', false],
	LOCAL: ['LOCAL', false],
}

// Library scale of each FITS time system; GPS instants are carried on TAI and LOCAL has none.
const LIBRARY_SCALES: Readonly<Record<FitsTimeSystem, Timescale | undefined>> = {
	UTC: Timescale.UTC,
	TAI: Timescale.TAI,
	TT: Timescale.TT,
	TDB: Timescale.TDB,
	TCG: Timescale.TCG,
	TCB: Timescale.TCB,
	UT1: Timescale.UT1,
	GPS: Timescale.TAI,
	LOCAL: undefined,
}

// TIMESYS value written for each library scale.
const SCALE_CODES: Readonly<Record<Timescale, FitsTimeSystem>> = {
	[Timescale.UT1]: 'UT1',
	[Timescale.UTC]: 'UTC',
	[Timescale.TAI]: 'TAI',
	[Timescale.TT]: 'TT',
	[Timescale.TCG]: 'TCG',
	[Timescale.TDB]: 'TDB',
	[Timescale.TCB]: 'TCB',
}

// TREFPOS values keyed by their first three characters, the only significant ones (FITS 4.0 §9.2.3).
const REFERENCE_POSITIONS: Readonly<Record<string, FitsTimeReferencePosition>> = {
	TOP: 'topocenter',
	GEO: 'geocenter',
	BAR: 'barycenter',
	REL: 'relocatable',
	CUS: 'custom',
	HEL: 'heliocenter',
	GAL: 'galactic',
	EMB: 'embarycenter',
	MER: 'mercury',
	VEN: 'venus',
	MAR: 'mars',
	JUP: 'jupiter',
	SAT: 'saturn',
	URA: 'uranus',
	NEP: 'neptune',
}

// TREFPOS code written for each reference position.
const REFERENCE_POSITION_CODES: Readonly<Record<FitsTimeReferencePosition, string>> = {
	topocenter: 'TOPOCENTER',
	geocenter: 'GEOCENTER',
	barycenter: 'BARYCENTER',
	relocatable: 'RELOCATABLE',
	custom: 'CUSTOM',
	heliocenter: 'HELIOCENTER',
	galactic: 'GALACTIC',
	embarycenter: 'EMBARYCENTER',
	mercury: 'MERCURY',
	venus: 'VENUS',
	mars: 'MARS',
	jupiter: 'JUPITER',
	saturn: 'SATURN',
	uranus: 'URANUS',
	neptune: 'NEPTUNE',
}

// Legacy OGIP TIMEREF values, read only when TREFPOS is absent.
const LEGACY_REFERENCE_POSITIONS: Readonly<Record<string, FitsTimeReferencePosition>> = {
	LOCAL: 'topocenter',
	GEOCENTRIC: 'geocenter',
	SOLARSYSTEM: 'barycenter',
	HELIOCENTRIC: 'heliocenter',
}

// Seconds per TIMEUNIT (FITS 4.0 Table 34); the variable tropical 'ta' and Besselian 'Ba' years are not supported.
const TIME_UNITS: Readonly<Record<string, number>> = {
	s: 1,
	min: 60,
	h: 3600,
	d: DAYSEC,
	a: DAYSPERJY * DAYSEC,
	yr: DAYSPERJY * DAYSEC,
	cy: DAYSPERJC * DAYSEC,
}

// Splits a TIMESYS value into code and optional realization, e.g. 'TT(BIPM08)'.
const TIME_SYSTEM_PATTERN = /^([A-Z0-9]+)(?:\((.*)\))?$/

// Mutable state shared by the instant parsers of one readFitsTime call.
interface ReadContext {
	readonly header: FitsHeader
	readonly diagnostics: FitsMetadataDiagnostic[]
	readonly system?: FitsTimeSystem
	readonly scale?: Timescale
	readonly tolerance: number
	// Seconds per TIMEUNIT, or undefined when the unit is unsupported.
	readonly unit?: number
	// Observatory attached to every instant at creation, so that cached scale conversions carry it.
	readonly location?: GeographicPosition
	// Lazily resolved MJDREF/JDREF/DATEREF + TIMEOFFS reference instant (null when unusable).
	reference?: FitsTimeValue | null
}

// Reads the timing and observatory metadata of one HDU header, an untrusted external input that is
// validated here. Keyword precedence follows FITS 4.0: TIMESYS defaults to UTC; DATE-xxxx and MJD-xxxx
// of the same instant are compared within their written resolution, the finer one is kept when they
// agree and MJD-xxxx wins (with a conflict) when they do not; DATE-OBS/MJD-OBS are taken as the start
// only when DATE-BEG/MJD-BEG are absent, never as the midpoint; TSTART/TSTOP are relative to MJDREF
// (MJDREFI + MJDREFF), else JDREF (JDREFI + JDREFF), else DATEREF, else MJDREF = 0, plus TIMEOFFS, in
// TIMEUNIT. DATE values outside a UTC leap second cannot read 23:59:60. Relative offsets in UTC are
// counted on TAI, so they include leap seconds; in other scales they are seconds of that scale. The
// DATE keyword (file creation) is not an observation time and is ignored. No light-time, barycentric,
// or shutter correction is applied: a TDB value at the barycenter is returned as such.
export function readFitsTime(header: FitsHeader, options?: FitsTimeReadOptions): FitsTimeMetadata {
	const diagnostics: FitsMetadataDiagnostic[] = []
	const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE
	const { system, realization } = readTimeSystem(header, diagnostics)
	const scale = system === undefined ? undefined : LIBRARY_SCALES[system]
	const referencePosition = readReferencePosition(header, system, diagnostics)
	const unit = readTimeUnit(header, diagnostics)
	const site = readLocation(header, diagnostics, options?.locationTolerance ?? DEFAULT_LOCATION_TOLERANCE)
	const topocentric = referencePosition === 'topocenter'

	if (topocentric && site === undefined) diagnostics.push({ kind: 'missing', keyword: 'OBSGEO-X', message: 'the topocentric times have no observatory location' })

	const context: ReadContext = { header, diagnostics, system, scale, tolerance, unit, location: topocentric ? site?.position : undefined }

	// Instants: the BEG pair is the start; the OBS pair only by the start convention.
	const observation = readInstantPair(context, 'DATE-OBS', 'MJD-OBS')
	const begin = readInstantPair(context, 'DATE-BEG', 'MJD-BEG')?.value
	const relativeStart = readRelativeInstant(context, 'TSTART')
	const midpoint = readInstantPair(context, 'DATE-AVG', 'MJD-AVG')?.value
	const relativeEnd = readRelativeInstant(context, 'TSTOP')
	let end = readInstantPair(context, 'DATE-END', 'MJD-END')?.value

	let start = begin

	if (observation !== undefined && !observation.undefinedRole) {
		if (start === undefined) {
			start = observation.value
			diagnostics.push({ kind: 'assumed', keyword: observation.value.keyword, message: `${observation.value.keyword} is taken as the start of the observation` })
		} else {
			compareInstants(context, start, observation.value)
		}
	}

	if (relativeStart !== undefined) {
		if (start === undefined) start = relativeStart
		else compareInstants(context, start, relativeStart)
	}

	if (relativeEnd !== undefined) {
		if (end === undefined) end = relativeEnd
		else compareInstants(context, end, relativeEnd)
	}

	if (observation === undefined && start === undefined && midpoint === undefined && end === undefined && scale !== undefined) {
		diagnostics.push({ kind: 'missing', keyword: 'DATE-OBS', message: 'no observation time keyword is present' })
	}

	// Durations in seconds.
	const xposure = readDuration(context, 'XPOSURE', true)
	const exptime = readDuration(context, 'EXPTIME', false)
	const exposureAlias = readDuration(context, 'EXPOSURE', false)
	const exposure = xposure ?? exptime ?? exposureAlias

	if (exposure !== undefined) {
		if (exposure !== exptime && exptime !== undefined) compareDurations(context, exposure, exptime)
		if (exposure !== exposureAlias && exposureAlias !== undefined) compareDurations(context, exposure, exposureAlias)
	}

	const elapsed = readDuration(context, 'TELAPSE', true)
	const systematicError = readDuration(context, 'TIMSYER', true)
	const randomError = readDuration(context, 'TIMRDER', true)

	const continuous = checkInterval(context, start, midpoint, end, exposure, elapsed)

	return {
		timeSystem: system,
		realization,
		scale,
		referencePosition,
		referenceDirection: textMetadataKeyword(header, 'TREFDIR'),
		ephemeris: textMetadataKeyword(header, 'PLEPHEM'),
		observation: observation?.value,
		start,
		midpoint,
		end,
		exposure: exposure?.value,
		exposureKeyword: exposure?.keyword,
		elapsed: elapsed?.value,
		continuous,
		systematicError: systematicError?.value,
		randomError: randomError?.value,
		location: site?.position,
		locationSource: site?.source,
		diagnostics,
	}
}

// Builds the exposureInterval input for the metadata: the DATE-BEG/DATE-END style span when start and
// end bound one continuous exposure, else a timestamp labelling the start, midpoint, or end (in that
// order) with the exposure duration. Returns undefined when start and end are known but do not bound a
// proven continuous exposure (`continuous` is false or undefined: an exposure that differs from their
// span, end before start, no exposure keyword, or timestamps too coarse to resolve it): integration
// time and observing window are then distinct or unknown and no single collection interval follows
// from them; the timestamps stay available on the metadata. Also returns undefined when
// neither a span nor a timestamp with an exposure is available. A DATE-AVG next to a span is not used:
// its averaging method is undefined, while the interval midpoint is the temporal one.
//
// The default clock `uncertainty` is the 1σ quadrature sum of TIMSYER and TIMRDER, since the absolute
// error of one timestamp includes both (absent when neither is given), and the default `resolution` is
// the coarsest written resolution of the timestamps used, a quantization bound kept apart from the 1σ
// error (86400 s for a DATE-OBS without time). `shutter` supplies latencies and overrides either
// default. The returned timestamps are the metadata's own Time objects.
export function fitsExposure(metadata: FitsTimeMetadata, shutter?: ExposureShutter): ExposureTimestamp | ExposureSpan | undefined {
	const { start, midpoint, end, exposure, systematicError, randomError } = metadata
	const uncertainty = systematicError === undefined && randomError === undefined ? undefined : Math.hypot(systematicError ?? 0, randomError ?? 0)

	if (start !== undefined && end !== undefined) {
		if (metadata.continuous !== true) return undefined
		return { uncertainty, resolution: Math.max(start.resolution, end.resolution), ...shutter, start: start.time, end: end.time }
	}

	if (exposure === undefined) return undefined

	const timestamp = start ?? midpoint ?? end
	if (timestamp === undefined) return undefined
	const reference = timestamp === start ? 'start' : timestamp === midpoint ? 'midpoint' : 'end'
	return { uncertainty, resolution: timestamp.resolution, ...shutter, time: timestamp.time, reference, duration: exposure }
}

// Writes timing and location metadata into `header` in place and returns it. Every keyword of
// FITS_TIME_KEYWORDS is rewritten when the input defines it and deleted otherwise, so stale or
// contradictory values (another MJD-OBS, a relative TSTART, an OBSGEO-B/L/H set) cannot survive;
// existing keywords keep their position and new ones are appended. Unrelated keywords pass through.
// Instants are converted to `scale` and written as DATE-xxxx with `digits` decimals (rounded, carrying
// into the next day, and reading 23:59:60.x inside a UTC leap second) and as MJD-xxxx with the full
// double precision. TIMEUNIT is written as 's' whenever a duration in TIMEUNIT is written. Derived
// values are rounded to drop conversion noise: TELAPSE to 1 ns, OBSGEO-X/Y/Z and SITEELEV to 1 µm,
// SITELAT and SITELONG to 1e-10 degree. Only the clock scale is converted, never the reference
// position: no light-time correction is applied, and TREFPOS is written so that the reader's scale
// default cannot relabel recorded times as geocentric or barycentric (see FitsTimeInput.referencePosition).
export function writeFitsTime(header: FitsHeader, input: FitsTimeInput) {
	const scale = input.scale ?? input.start?.scale ?? input.midpoint?.scale ?? input.end?.scale ?? Timescale.UTC
	const digits = input.digits ?? 6
	const location = input.location ?? input.start?.location ?? input.midpoint?.location ?? input.end?.location
	const referencePosition = input.referencePosition ?? (scale === Timescale.TCG || scale === Timescale.TDB || scale === Timescale.TCB ? 'topocenter' : undefined)
	const topocentric = referencePosition === undefined || referencePosition === 'topocenter'
	const start = input.start && timeConvert(locate(input.start, location, topocentric), scale)
	const midpoint = input.midpoint && timeConvert(locate(input.midpoint, location, topocentric), scale)
	const end = input.end && timeConvert(locate(input.end, location, topocentric), scale)
	const elapsed = start && end && elapsedSeconds(start, end)
	const position = location && itrs(location)
	const values: Record<FitsHeaderKey, FitsHeaderValue> = {
		TIMESYS: SCALE_CODES[scale],
		TIMEUNIT: input.exposure !== undefined || elapsed !== undefined || input.systematicError !== undefined || input.randomError !== undefined ? 's' : undefined,
		TREFPOS: referencePosition && REFERENCE_POSITION_CODES[referencePosition],
		TREFDIR: input.referenceDirection,
		PLEPHEM: input.ephemeris,
		'DATE-OBS': start && formatFitsDateTime(start, digits),
		'MJD-OBS': start && modifiedJulianDate(start),
		'DATE-BEG': start && formatFitsDateTime(start, digits),
		'MJD-BEG': start && modifiedJulianDate(start),
		'DATE-AVG': midpoint && formatFitsDateTime(midpoint, digits),
		'MJD-AVG': midpoint && modifiedJulianDate(midpoint),
		'DATE-END': end && formatFitsDateTime(end, digits),
		'MJD-END': end && modifiedJulianDate(end),
		XPOSURE: input.exposure,
		EXPTIME: input.exposure,
		TELAPSE: elapsed && roundToNthDecimal(elapsed, 9),
		TIMSYER: input.systematicError,
		TIMRDER: input.randomError,
		'OBSGEO-X': position && roundToNthDecimal(toMeter(position[0]), 6),
		'OBSGEO-Y': position && roundToNthDecimal(toMeter(position[1]), 6),
		'OBSGEO-Z': position && roundToNthDecimal(toMeter(position[2]), 6),
		SITELAT: location && roundToNthDecimal(toDeg(location.latitude), 10),
		SITELONG: location && roundToNthDecimal(toDeg(location.longitude), 10),
		SITEELEV: location && roundToNthDecimal(toMeter(location.elevation), 6),
	}

	for (const key of FITS_TIME_KEYWORDS) {
		const value = values[key]
		if (value === undefined) delete header[key]
		else header[key] = value
	}

	return header
}

// Returns `time` itself when it already carries `location` or none is given, else a fresh uncached copy
// carrying `location` (replacing any other), so that a scale conversion evaluates the topocentric TDB-TT
// term at the observatory written to the header. A TDB or TCB instant already holds the term of its own
// location (none: geocentric), so for `topocentric` output it is first brought back to TT with that
// location and then relocated, giving the value a TT clock reading at `location` would have; for any other
// declared origin it is returned unchanged, since its value is not tied to the observatory. The input is
// never mutated.
function locate(time: Time, location: GeographicPosition | undefined, topocentric: boolean) {
	if (location === undefined || time.location === location) return time
	const coordinate = time.scale === Timescale.TDB || time.scale === Timescale.TCB
	if (coordinate && !topocentric) return time
	const located = timeShift(coordinate ? tt(time) : time, 0)
	located.location = location
	return located
}

// Formats an instant as a FITS datetime in its own scale: '[±C]CCYY-MM-DDThh:mm:ss[.s...]' with `digits`
// decimals (0..9), rounded to the nearest last digit. A UTC instant inside a leap second reads
// 23:59:60.x; other scales always have 86400 s days. Years outside 0..9999 use the signed five-digit form.
export function formatFitsDateTime(time: Time, digits: number = 6) {
	const unitsPerSecond = 10 ** digits
	const calendar = eraJdToCal(time.day, time.fraction)
	const dayLength = DAYSEC + (time.scale === Timescale.UTC ? utcLeapSeconds(calendar[0], calendar[1], calendar[2]) : 0)
	let units = Math.round(calendar[3] * dayLength * unitsPerSecond)

	if (units >= Math.round(dayLength * unitsPerSecond)) {
		// Rounded up to the next midnight.
		eraJdToCal(time.day, time.fraction + 0.5, calendar)
		units = 0
	}

	const [year, month, day] = calendar

	let hour = 23
	let minute = 59
	let second: number

	if (units >= DAYSEC * unitsPerSecond) {
		// Inside an inserted UTC leap second.
		second = 60 * unitsPerSecond + units - DAYSEC * unitsPerSecond
	} else {
		hour = Math.trunc(units / (3600 * unitsPerSecond))
		units -= hour * 3600 * unitsPerSecond
		minute = Math.trunc(units / (60 * unitsPerSecond))
		second = units - minute * 60 * unitsPerSecond
	}

	const whole = Math.trunc(second / unitsPerSecond)
	const decimals = digits > 0 ? `.${`${second - whole * unitsPerSecond}`.padStart(digits, '0')}` : ''
	const yearText = year >= 0 && year <= 9999 ? `${year}`.padStart(4, '0') : `${year < 0 ? '-' : '+'}${`${Math.abs(year)}`.padStart(5, '0')}`
	return `${yearText}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(whole)}${decimals}`
}

// Zero-pads a non-negative integer below 100 to two digits.
function pad2(value: number) {
	return value < 10 ? `0${value}` : `${value}`
}

// Modified Julian Date of an instant in its own scale, JD - 2400000.5, summed from the two parts.
function modifiedJulianDate(time: Time) {
	return time.day - 2400001 + (time.fraction + 0.5)
}

// One unit of the last written decimal digit of a number, from its shortest round-trip text: 0.001 for
// 59959.125, 1 for 30, 1e-12 for 1e-12. Trailing zeros of the original text are not recoverable.
function lastDigitUnit(value: number) {
	const [mantissa, exponent] = `${Math.abs(value)}`.split('e')
	const dot = mantissa.indexOf('.')
	const decimals = (dot < 0 ? 0 : mantissa.length - dot - 1) - (exponent === undefined ? 0 : Number(exponent))
	return 10 ** -decimals
}

// Spacing of doubles at `value` (one unit in the last place), 0 for 0: the representation error of an
// exactly defined number such as a reference epoch.
function doubleStep(value: number) {
	return value === 0 ? 0 : Number.EPSILON * 2 ** Math.floor(Math.log2(Math.abs(value)))
}

// Elapsed seconds from a to b: on TAI for UTC (counting leap seconds), else in the scale of `a`.
function elapsedSeconds(a: Time, b: Time) {
	return timeSubtract(b, a, a.scale === Timescale.UTC ? Timescale.TAI : a.scale) * DAYSEC
}

// Shifts an instant by `seconds`, splitting whole days to keep the two-part precision. UTC is shifted
// on TAI so that leap seconds are counted; other scales are shifted in their own seconds.
function shiftSeconds(time: Time, seconds: number) {
	const days = Math.trunc(seconds / DAYSEC)
	const fraction = (seconds - days * DAYSEC) / DAYSEC
	if (time.scale !== Timescale.UTC) return timeShift(time, fraction, days)
	return utc(timeShift(tai(time), fraction, days))
}

// Reads TIMESYS, applying the UTC default and resolving deprecated synonyms and realizations.
function readTimeSystem(header: FitsHeader, diagnostics: FitsMetadataDiagnostic[]): { system?: FitsTimeSystem; realization?: string } {
	const value = header.TIMESYS

	if (value === undefined) {
		diagnostics.push({ kind: 'defaulted', keyword: 'TIMESYS', message: 'TIMESYS is absent; UTC is assumed' })
		return { system: 'UTC' }
	}

	const match = typeof value === 'string' ? TIME_SYSTEM_PATTERN.exec(value.trim().toUpperCase()) : null
	const entry = match ? TIME_SYSTEMS[match[1]] : undefined

	if (match === null || entry === undefined) {
		diagnostics.push({ kind: 'unsupported', keyword: 'TIMESYS', message: `TIMESYS ${JSON.stringify(value)} is not a recognized time scale; no instant is interpreted` })
		return {}
	}

	const [system, nonStandard] = entry
	const realization = match[2]?.trim() || undefined

	if (nonStandard) diagnostics.push({ kind: 'nonStandard', keyword: 'TIMESYS', message: `TIMESYS ${match[1]} is read as ${system}` })
	if (system === 'LOCAL') diagnostics.push({ kind: 'unsupported', keyword: 'TIMESYS', message: 'LOCAL time has no defined relation to a recognized scale; no instant is interpreted' })

	return { system, realization }
}

// Reads TREFPOS (or the legacy TIMEREF); a declared value always prevails. When both are absent the
// observation-time convention of FITS 4.0 §4.4.2.2 is followed: coordinate times are light-time
// corrected to their spatial origin, the barycenter for TDB and TCB and the geocenter for TCG, and
// other scales are at the topocenter. For coordinate times this departs from the general TREFPOS
// default of §9.2.3 (TOPOCENTER), and the diagnostic says so. No light-time correction is applied.
// Flags the combinations FITS 4.0 Table 32 advises against.
function readReferencePosition(header: FitsHeader, system: FitsTimeSystem | undefined, diagnostics: FitsMetadataDiagnostic[]) {
	const value = textMetadataKeyword(header, 'TREFPOS')
	const legacy = textMetadataKeyword(header, 'TIMEREF')
	let position: FitsTimeReferencePosition | undefined

	if (value !== undefined) {
		position = REFERENCE_POSITIONS[value.toUpperCase().slice(0, 3)]
		if (position === undefined) diagnostics.push({ kind: 'unsupported', keyword: 'TREFPOS', message: `TREFPOS ${JSON.stringify(value)} is not a recognized reference position` })
	} else if (legacy !== undefined) {
		position = LEGACY_REFERENCE_POSITIONS[legacy.toUpperCase()]
		if (position === undefined) diagnostics.push({ kind: 'unsupported', keyword: 'TIMEREF', message: `TIMEREF ${JSON.stringify(legacy)} is not a recognized reference position` })
		else diagnostics.push({ kind: 'nonStandard', keyword: 'TIMEREF', message: `TIMEREF ${legacy} is read as TREFPOS ${REFERENCE_POSITION_CODES[position]}` })
	} else {
		position = system === 'TDB' || system === 'TCB' ? 'barycenter' : system === 'TCG' ? 'geocenter' : 'topocenter'
		const message = position === 'topocenter' ? 'TREFPOS is absent; TOPOCENTER is assumed (FITS 4.0 §9.2.3)' : `TREFPOS is absent; ${REFERENCE_POSITION_CODES[position]} is assumed for the ${system} coordinate time (FITS 4.0 §4.4.2.2), unlike the TOPOCENTER default of §9.2.3`
		diagnostics.push({ kind: 'defaulted', keyword: 'TREFPOS', message })
		return position
	}

	if (position !== undefined && system !== undefined && system !== 'LOCAL') {
		const barycentric = system === 'TDB' || system === 'TCB'
		if ((position === 'barycenter') !== barycentric) diagnostics.push({ kind: 'incompatible', keyword: 'TREFPOS', message: `TIMESYS ${system} with TREFPOS ${REFERENCE_POSITION_CODES[position]} is not a recommended combination` })
	}

	return position
}

// Reads TIMEUNIT as seconds per unit ('s' when absent), or undefined when unsupported.
function readTimeUnit(header: FitsHeader, diagnostics: FitsMetadataDiagnostic[]) {
	const value = textMetadataKeyword(header, 'TIMEUNIT')
	if (value === undefined) return 1
	const unit = TIME_UNITS[value]
	if (unit === undefined) diagnostics.push({ kind: 'unsupported', keyword: 'TIMEUNIT', message: `TIMEUNIT ${JSON.stringify(value)} is not supported; values in TIMEUNIT are ignored` })
	return unit
}

// Builds an instant from a calendar reading in the header's scale, with the topocentric location;
// GPS readings are moved onto TAI.
function calendarInstant(context: ReadContext, year: number, month: number, day: number, hour: number, minute: number, second: number) {
	const instant = timeYMDHMS(year, month, day, hour, minute, second, context.scale)
	if (context.location !== undefined) instant.location = context.location
	return context.system === 'GPS' ? timeShift(instant, GPS_TO_TAI / DAYSEC) : instant
}

// Builds an instant from a two-part Julian Date in the header's scale, with the topocentric location;
// GPS values are moved onto TAI.
function julianInstant(context: ReadContext, day: number, fraction: number) {
	const instant = time(day, fraction, context.scale)
	if (context.location !== undefined) instant.location = context.location
	return context.system === 'GPS' ? timeShift(instant, GPS_TO_TAI / DAYSEC) : instant
}

// Builds an instant from an MJD split exactly into integer and fractional days.
function mjdInstant(context: ReadContext, mjd: number) {
	const integer = Math.floor(mjd)
	return julianInstant(context, 2400000 + integer, 0.5 + (mjd - integer))
}

// Parses a DATE-xxxx keyword. `undefinedRole` marks the two-digit-year form, which FITS does not tie to the start.
function readDateKeyword(context: ReadContext, key: FitsHeaderKey): { value: FitsTimeValue; undefinedRole: boolean } | undefined {
	const raw = context.header[key]
	if (raw === undefined) return undefined

	const fields = typeof raw === 'string' ? parseFitsDateTimeFields(raw) : undefined

	if (fields === undefined) {
		context.diagnostics.push({ kind: 'invalid', keyword: key, message: `${key} is not a FITS datetime` })
		return undefined
	}

	const { year, month, day, hour, minute, second } = fields

	if (fields.twoDigitYear) context.diagnostics.push({ kind: 'nonStandard', keyword: key, message: `${key} uses the two-digit year form, whose role in the observation is undefined` })

	if (fields.zone) {
		if (context.system === 'UTC') context.diagnostics.push({ kind: 'nonStandard', keyword: key, message: `${key} ends with the time-zone designator Z, which FITS does not allow` })
		else context.diagnostics.push({ kind: 'conflict', keyword: key, message: `${key} ends with Z (UTC) but TIMESYS is ${context.system ?? JSON.stringify(context.header.TIMESYS)}; it is read in TIMESYS` })
	}

	if (!(year >= MIN_CALENDAR_YEAR)) {
		context.diagnostics.push({ kind: 'unsupported', keyword: key, message: `${key} is before year ${MIN_CALENDAR_YEAR}` })
		return undefined
	}

	if (second >= 60) {
		// Only the last minute of a UTC day with an inserted leap second reads 23:59:60.x.
		const leap = context.system === 'UTC' && hour === 23 && minute === 59 ? utcLeapSeconds(year, month, day) : 0

		if (!(second < 60 + leap)) {
			context.diagnostics.push({ kind: 'invalid', keyword: key, message: `${key} has a second ${second} outside a UTC leap second` })
			return undefined
		}
	} else if (context.system === 'UTC' && hour === 23 && minute === 59 && !(second < 60 + utcLeapSeconds(year, month, day))) {
		// A negative leap second removes 23:59:59.
		context.diagnostics.push({ kind: 'invalid', keyword: key, message: `${key} falls in a UTC second removed by a negative leap second` })
		return undefined
	}

	if (context.scale === undefined) return undefined

	return { value: { time: calendarInstant(context, year, month, day, hour, minute, second), keyword: key, resolution: fields.resolution }, undefinedRole: fields.twoDigitYear }
}

// Parses an MJD-xxxx keyword.
function readMjdKeyword(context: ReadContext, key: FitsHeaderKey): FitsTimeValue | undefined {
	const mjd = finiteMetadataKeyword(context.header, key, context.diagnostics)
	if (mjd === undefined || context.scale === undefined) return undefined
	return { time: mjdInstant(context, mjd), keyword: key, resolution: lastDigitUnit(mjd) * DAYSEC }
}

// Reads a DATE-xxxx/MJD-xxxx pair of the same instant. When they agree within their resolutions the
// finer one is kept; otherwise MJD-xxxx supersedes (FITS 4.0 §9.5) and a conflict is reported.
function readInstantPair(context: ReadContext, dateKey: FitsHeaderKey, mjdKey: FitsHeaderKey) {
	const date = readDateKeyword(context, dateKey)
	const mjd = readMjdKeyword(context, mjdKey)

	if (date === undefined) return mjd && { value: mjd, undefinedRole: false }
	if (mjd === undefined) return date
	if (!compareInstants(context, mjd, date.value)) return { value: mjd, undefinedRole: false }
	return mjd.resolution < date.value.resolution ? { value: mjd, undefinedRole: false } : { value: date.value, undefinedRole: date.undefinedRole }
}

// Resolves the MJDREF/JDREF/DATEREF reference instant plus TIMEOFFS, once per read. The reference is an
// epoch defined by its keywords, not a measurement: its resolution is only the double-precision step of
// the values (0 for DATEREF), never the unit of their last written digit, so MJDREFF = 0 is exact.
function readReference(context: ReadContext) {
	if (context.reference !== undefined) return context.reference ?? undefined

	const { header, diagnostics } = context
	let reference: FitsTimeValue | undefined

	if (context.scale === undefined) {
		context.reference = null
		return undefined
	}

	if (hasKeyword(header, 'MJDREF') || hasKeyword(header, 'MJDREFI') || hasKeyword(header, 'MJDREFF')) {
		// The split pair supersedes the single value only when both parts are present.
		const single = finiteMetadataKeyword(header, 'MJDREF', diagnostics)
		const integer = finiteMetadataKeyword(header, 'MJDREFI', diagnostics)
		const fraction = finiteMetadataKeyword(header, 'MJDREFF', diagnostics)

		if (integer !== undefined && fraction !== undefined) reference = { time: julianInstant(context, 2400000 + integer, 0.5 + fraction), keyword: 'MJDREFI', resolution: (doubleStep(integer) + doubleStep(fraction)) * DAYSEC }
		else if (single !== undefined) reference = { time: mjdInstant(context, single), keyword: 'MJDREF', resolution: doubleStep(single) * DAYSEC }
		else if ((integer ?? fraction) !== undefined) reference = { time: julianInstant(context, 2400000 + (integer ?? 0), 0.5 + (fraction ?? 0)), keyword: integer === undefined ? 'MJDREFF' : 'MJDREFI', resolution: (doubleStep(integer ?? 0) + doubleStep(fraction ?? 0)) * DAYSEC }
	} else if (hasKeyword(header, 'JDREF') || hasKeyword(header, 'JDREFI') || hasKeyword(header, 'JDREFF')) {
		const single = finiteMetadataKeyword(header, 'JDREF', diagnostics)
		const integer = finiteMetadataKeyword(header, 'JDREFI', diagnostics)
		const fraction = finiteMetadataKeyword(header, 'JDREFF', diagnostics)

		if (integer !== undefined && fraction !== undefined) reference = { time: julianInstant(context, integer, fraction), keyword: 'JDREFI', resolution: (doubleStep(integer) + doubleStep(fraction)) * DAYSEC }
		else if (single !== undefined) reference = { time: julianInstant(context, single, 0), keyword: 'JDREF', resolution: doubleStep(single) * DAYSEC }
		else if (integer !== undefined || fraction !== undefined) diagnostics.push({ kind: 'missing', keyword: integer === undefined ? 'JDREFI' : 'JDREFF', message: 'JDREFI and JDREFF must be given together' })
	} else if (hasKeyword(header, 'DATEREF')) {
		const date = readDateKeyword(context, 'DATEREF')?.value
		if (date !== undefined) reference = { time: date.time, keyword: 'DATEREF', resolution: 0 }
	} else {
		diagnostics.push({ kind: 'defaulted', keyword: 'MJDREF', message: 'no reference time keyword is present; MJDREF = 0 is assumed' })
		reference = { time: julianInstant(context, 2400000, 0.5), keyword: 'MJDREF', resolution: 0 }
	}

	if (reference !== undefined && context.unit !== undefined) {
		const offset = finiteMetadataKeyword(header, 'TIMEOFFS', diagnostics)
		if (offset !== undefined) reference = { time: shiftSeconds(reference.time, offset * context.unit), keyword: reference.keyword, resolution: reference.resolution + doubleStep(offset) * context.unit }
	}

	context.reference = reference ?? null
	return reference
}

// Reads TSTART or TSTOP, in TIMEUNIT relative to the reference instant.
function readRelativeInstant(context: ReadContext, key: FitsHeaderKey): FitsTimeValue | undefined {
	const value = finiteMetadataKeyword(context.header, key, context.diagnostics)
	if (value === undefined || context.unit === undefined) return undefined
	const reference = readReference(context)
	if (reference === undefined) return undefined
	const seconds = value * context.unit
	return { time: shiftSeconds(reference.time, seconds), keyword: key, resolution: reference.resolution + lastDigitUnit(value) * context.unit }
}

// A duration in seconds and its source.
interface Duration {
	readonly value: number
	readonly keyword: FitsHeaderKey
	readonly resolution: number
}

// Reads a non-negative duration in seconds; `inTimeUnit` scales it by TIMEUNIT (EXPTIME and EXPOSURE are always seconds).
function readDuration(context: ReadContext, key: FitsHeaderKey, inTimeUnit: boolean): Duration | undefined {
	const value = finiteMetadataKeyword(context.header, key, context.diagnostics)
	if (value === undefined) return undefined

	if (!(value >= 0)) {
		context.diagnostics.push({ kind: 'invalid', keyword: key, message: `${key} is negative` })
		return undefined
	}

	const unit = inTimeUnit ? context.unit : 1
	if (unit === undefined) return undefined
	return { value: value * unit, keyword: key, resolution: lastDigitUnit(value) * unit }
}

// Compares two instants of the same quantity; reports a conflict on `kept` and returns false when they
// differ by more than their resolutions plus the tolerance.
function compareInstants(context: ReadContext, kept: FitsTimeValue, other: FitsTimeValue) {
	const difference = elapsedSeconds(other.time, kept.time)
	if (Math.abs(difference) <= kept.resolution + other.resolution + context.tolerance) return true
	context.diagnostics.push({ kind: 'conflict', keyword: kept.keyword, message: `${kept.keyword} and ${other.keyword} differ by ${difference} s; ${kept.keyword} is used` })
	return false
}

// Compares two durations of the same quantity and reports a conflict on `kept` when they disagree.
function compareDurations(context: ReadContext, kept: Duration, other: Duration) {
	const difference = kept.value - other.value
	if (Math.abs(difference) <= kept.resolution + other.resolution + context.tolerance) return
	context.diagnostics.push({ kind: 'conflict', keyword: kept.keyword, message: `${kept.keyword} and ${other.keyword} differ by ${difference} s; ${kept.keyword} is used` })
}

// Checks that the instants and durations describe one interval: start <= end, the midpoint inside it,
// TELAPSE equal to its length, and an exposure no longer than it. Returns whether start and end bound
// one continuous exposure (see FitsTimeMetadata.continuous). Two endpoints alone never prove it, since
// FITS 4.0 §9.7 separates the accumulated XPOSURE from the elapsed window. The resolutions (one unit of
// the last written digit, of the timestamps and of the exposure, whose trailing zeros are lost when the
// header is parsed) plus the tolerance bound the representation error: a larger difference is a
// conflict, but a smaller one proves equality only when that bound is smaller than the exposure itself;
// otherwise a window of up to twice the integration time, or of zero length, is just as consistent.
function checkInterval(context: ReadContext, start?: FitsTimeValue, midpoint?: FitsTimeValue, end?: FitsTimeValue, exposure?: Duration, elapsed?: Duration) {
	const { diagnostics, tolerance } = context
	let continuous: boolean | undefined

	if (start !== undefined && end !== undefined) {
		const span = elapsedSeconds(start.time, end.time)
		const slack = start.resolution + end.resolution + tolerance

		if (span < -slack) {
			diagnostics.push({ kind: 'conflict', keyword: end.keyword, message: `${end.keyword} is ${-span} s before ${start.keyword}` })
			continuous = false
		}

		if (elapsed !== undefined && Math.abs(elapsed.value - span) > slack + elapsed.resolution) {
			diagnostics.push({ kind: 'conflict', keyword: elapsed.keyword, message: `${elapsed.keyword} differs from ${end.keyword} - ${start.keyword} = ${span} s` })
		}

		if (exposure !== undefined && exposure.value > span + slack + exposure.resolution) {
			diagnostics.push({ kind: 'conflict', keyword: exposure.keyword, message: `${exposure.keyword} is longer than ${end.keyword} - ${start.keyword} = ${span} s` })
		}

		if (continuous === undefined && exposure !== undefined) {
			const bound = slack + exposure.resolution
			if (Math.abs(exposure.value - span) > bound) continuous = false
			// The bound only rules out a conflict. Equality is proven when it is smaller than the exposure,
			// which also forces a positive span; XPOSURE = 1 (known to 1 s) next to a 0 s window is not.
			else if (bound < exposure.value) continuous = true
		}
	}

	if (midpoint !== undefined) {
		const beforeStart = start !== undefined && elapsedSeconds(start.time, midpoint.time) < -(start.resolution + midpoint.resolution + tolerance)
		const afterEnd = end !== undefined && elapsedSeconds(midpoint.time, end.time) < -(end.resolution + midpoint.resolution + tolerance)
		if (beforeStart || afterEnd) diagnostics.push({ kind: 'conflict', keyword: midpoint.keyword, message: `${midpoint.keyword} lies outside the start-end interval` })
	}

	return continuous
}

// A location candidate and the keyword set it came from.
interface LocationCandidate {
	readonly position: GeographicPosition
	readonly source: FitsLocationSource
	readonly keyword: FitsHeaderKey
}

// Reads the observatory location: OBSGEO-X/Y/Z (preferred by FITS 4.0 §9.2.3), else OBSGEO-B/L/H, else
// SITELAT/SITELONG/SITEELEV. Later sets are compared with the chosen one within `tolerance` meters.
function readLocation(header: FitsHeader, diagnostics: FitsMetadataDiagnostic[], tolerance: number) {
	const candidates: LocationCandidate[] = []

	const geocentric = readGeocentricLocation(header, diagnostics)
	if (geocentric !== undefined) candidates.push({ position: geocentric, source: 'geocentric', keyword: 'OBSGEO-X' })

	const geodetic = readGeodeticLocation(header, diagnostics, 'OBSGEO-B', 'OBSGEO-L', 'OBSGEO-H')
	if (geodetic !== undefined) {
		// OBSGEO-H is relative to the IAU 1976 ellipsoid; move the point to ITRS Cartesian coordinates.
		const [x, y, z] = eraGd2Gce(meter(IAU1976_RADIUS), 1 / IAU1976_INVERSE_FLATTENING, geodetic.longitude, geodetic.latitude, geodetic.elevation)
		candidates.push({ position: geocentricLocation(x, y, z), source: 'geodetic', keyword: 'OBSGEO-B' })
	}

	const site = readGeodeticLocation(header, diagnostics, 'SITELAT', 'SITELONG', 'SITEELEV')
	if (site !== undefined) candidates.push({ position: geodeticLocation(site.longitude, site.latitude, site.elevation, Ellipsoid.WGS84), source: 'site', keyword: 'SITELAT' })

	if (candidates.length === 0) return undefined

	const chosen = candidates[0]

	if (chosen.source === 'site') diagnostics.push({ kind: 'assumed', keyword: 'SITELAT', message: 'SITELAT, SITELONG and SITEELEV are read as WGS84 degrees with east-positive longitude and meters' })

	for (let i = 1; i < candidates.length; i++) {
		const other = candidates[i]
		const a = itrs(chosen.position)
		const b = itrs(other.position)
		const distance = toMeter(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
		if (distance > tolerance) diagnostics.push({ kind: 'conflict', keyword: chosen.keyword, message: `${other.keyword} is ${distance.toFixed(1)} m from ${chosen.keyword}; ${chosen.keyword} is used` })
	}

	return chosen
}

// Reads OBSGEO-X/Y/Z in meters, rejecting incomplete triplets and implausible geocentric distances.
function readGeocentricLocation(header: FitsHeader, diagnostics: FitsMetadataDiagnostic[]) {
	const present = +hasKeyword(header, 'OBSGEO-X') + +hasKeyword(header, 'OBSGEO-Y') + +hasKeyword(header, 'OBSGEO-Z')
	if (present === 0) return undefined

	const x = finiteMetadataKeyword(header, 'OBSGEO-X', diagnostics)
	const y = finiteMetadataKeyword(header, 'OBSGEO-Y', diagnostics)
	const z = finiteMetadataKeyword(header, 'OBSGEO-Z', diagnostics)

	if (x === undefined || y === undefined || z === undefined) {
		if (present < 3) diagnostics.push({ kind: 'missing', keyword: 'OBSGEO-X', message: 'OBSGEO-X, OBSGEO-Y and OBSGEO-Z must be given together' })
		return undefined
	}

	const radius = Math.hypot(x, y, z)

	if (!(radius >= MIN_GEOCENTRIC_RADIUS && radius <= MAX_GEOCENTRIC_RADIUS)) {
		diagnostics.push({ kind: 'invalid', keyword: 'OBSGEO-X', message: `OBSGEO-X/Y/Z is ${radius} m from the geocenter, not a terrestrial site in meters` })
		return undefined
	}

	return geocentricLocation(meter(x), meter(y), meter(z))
}

// Reads a geodetic latitude/longitude in degrees (numbers or sexagesimal text) and an optional height in
// meters (0 when absent). Returns radians and AU, or undefined when incomplete or out of range.
function readGeodeticLocation(header: FitsHeader, diagnostics: FitsMetadataDiagnostic[], latitudeKey: FitsHeaderKey, longitudeKey: FitsHeaderKey, heightKey: FitsHeaderKey) {
	const hasLatitude = hasKeyword(header, latitudeKey)
	const hasLongitude = hasKeyword(header, longitudeKey)
	if (!hasLatitude && !hasLongitude) return undefined

	if (!hasLatitude || !hasLongitude) {
		diagnostics.push({ kind: 'missing', keyword: hasLatitude ? longitudeKey : latitudeKey, message: `${latitudeKey} and ${longitudeKey} must be given together` })
		return undefined
	}

	const latitude = readAngleKeyword(header, latitudeKey, diagnostics)
	const longitude = readAngleKeyword(header, longitudeKey, diagnostics)
	if (latitude === undefined || longitude === undefined) return undefined

	if (!(Math.abs(latitude) <= deg(90))) {
		diagnostics.push({ kind: 'invalid', keyword: latitudeKey, message: `${latitudeKey} is outside -90..90 degrees` })
		return undefined
	}

	let height = finiteMetadataKeyword(header, heightKey, diagnostics)

	if (height === undefined) {
		if (!hasKeyword(header, heightKey)) diagnostics.push({ kind: 'defaulted', keyword: heightKey, message: `${heightKey} is absent; 0 m is assumed` })
		height = 0
	}

	return { latitude, longitude, elevation: meter(height) }
}

// Reads an angle in degrees from a number or a decimal or sexagesimal string, in radians.
function readAngleKeyword(header: FitsHeader, key: FitsHeaderKey, diagnostics: FitsMetadataDiagnostic[]) {
	const value = header[key]
	const angle = typeof value === 'number' || typeof value === 'string' ? parseAngle(value) : undefined
	if (angle !== undefined && Number.isFinite(angle)) return angle
	diagnostics.push({ kind: 'invalid', keyword: key, message: `${key} is not an angle in degrees` })
	return undefined
}
