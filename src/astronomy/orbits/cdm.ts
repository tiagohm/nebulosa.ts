import { AU_M, DAYSEC } from '../../core/constants'
import { Matrix } from '../../math/linear-algebra/matrix'
import { type Vec3, vecCrossLength, vecLength } from '../../math/linear-algebra/vec3'
import type { Distance } from '../../math/units/distance'
import { type Time, Timescale, timeYMDHMS } from '../time/time'

// Strict reader for the CCSDS Conjunction Data Message (CDM), Blue Book CCSDS 508.0-B-1 (June 2013,
// with Cor. 1 2018 and Cor. 2 2021), version 1.0, in the KVN (keyword = value) encoding. The XML
// encoding and any other CCSDS_CDM_VERS are rejected with an explicit error code, never guessed.
//
// The reader is a format boundary only: it validates syntax, keyword set and fixed order, obligatory
// items, exact unit designators, value domains and cross-object consistency, then converts the message
// into library units. It performs no orbital or probability computation; collision.ts consumes it.
//
// Units on the returned message: positions, distances and the screening volume are AU, velocities AU/day,
// the 6x6 position/velocity covariance AU², AU²/day and AU²/day², durations (OD spans) days, and all time
// tags are UTC `Time` values. Physical parameters keep their CDM SI units (areas m², mass kg, CD·A/m and
// CR·A/m m²/kg, thrust acceleration m/s², SEDR W/kg). The optional 7th-9th covariance rows (DRG, SRP,
// THR) convert only their position/velocity factor; the consider-parameter factor stays in its CDM unit.
// Covariances are in each object's RTN frame (R radial, T transverse, N along the inertial orbit
// normal), as the standard mandates; state vectors are in REF_FRAME (EME2000, GCRF or ITRF), which must
// be identical for both objects. Relative position/velocity are Object2 minus Object1 in Object1's RTN.
// Every call allocates a fresh message.

// Machine-readable reason a CDM was rejected.
export type CDMParseErrorCode =
	// The text is not a KVN CDM (for example an XML-encoded CDM).
	| 'unsupportedFormat'
	// CCSDS_CDM_VERS is not 1.0.
	| 'unsupportedVersion'
	// A line breaks the KVN line rules (length, characters, keyword = value form).
	| 'syntax'
	// A keyword is not defined by CDM 1.0.
	| 'unknownKeyword'
	// A keyword appears out of the fixed order of the standard.
	| 'order'
	// A keyword is repeated within the same section.
	| 'duplicate'
	// An obligatory keyword, section or covariance row is absent or incomplete.
	| 'missing'
	// A units designator is absent, unexpected or does not exactly match the standard.
	| 'unit'
	// A value is malformed or outside its domain.
	| 'value'
	// The reference frames or orbit centres of the two objects are unsupported or inconsistent.
	| 'frame'

// Error thrown when an untrusted CDM text is rejected.
export class CDMParseError extends Error {
	// Builds the error with its reason code, the 1-based source line (when known) and the keyword involved.
	constructor(
		readonly code: CDMParseErrorCode,
		message: string,
		readonly line?: number,
		readonly keyword?: string,
	) {
		super(line === undefined ? message : `line ${line}: ${message}`)
		this.name = 'CDMParseError'
	}
}

// Reference frame of the state vectors; GCRF and EME2000 are inertial, ITRF is Earth-fixed.
export type CDMReferenceFrame = 'GCRF' | 'EME2000' | 'ITRF'

// Object type classification.
export type CDMObjectType = 'PAYLOAD' | 'ROCKET BODY' | 'DEBRIS' | 'UNKNOWN' | 'OTHER'

// Whether the covariance came from the orbit determination or is an arbitrary default.
export type CDMCovarianceMethod = 'CALCULATED' | 'DEFAULT'

// Maneuver capacity of the object.
export type CDMManeuverable = 'YES' | 'NO' | 'N/A'

// Object1-centred frame of the screening volume.
export type CDMScreenVolumeFrame = 'RTN' | 'TVN'

// Shape of the screening volume.
export type CDMScreenVolumeShape = 'ELLIPSOID' | 'BOX'

// CDM header.
export interface CDMHeader {
	// Format version; only 1.0 is accepted.
	readonly version: '1.0'
	// Message creation instant (UTC).
	readonly creationDate: Time
	// Creating agency or owner/operator.
	readonly originator: string
	// Spacecraft name(s) the message is provided for.
	readonly messageFor?: string
	// Originator-unique message identifier.
	readonly messageId: string
	// Header comment lines, in order.
	readonly comments: readonly string[]
}

// Relative metadata/data describing the conjunction as a whole.
export interface CDMRelativeData {
	// Time of closest approach (UTC); both state vectors and covariances are given at this instant.
	readonly tca: Time
	// Reported norm of the relative position at TCA, AU.
	readonly missDistance: Distance
	// Reported norm of the relative velocity at TCA, AU/day.
	readonly relativeSpeed?: number
	// Object2 minus Object1 position in Object1's RTN frame, AU (present only when all three are given).
	readonly relativePosition?: Vec3
	// Object2 minus Object1 velocity in Object1's RTN frame, AU/day (present only when all three are given).
	readonly relativeVelocity?: Vec3
	// Start of the screening period (UTC).
	readonly startScreenPeriod?: Time
	// Stop of the screening period (UTC).
	readonly stopScreenPeriod?: Time
	// Frame of the screening volume.
	readonly screenVolumeFrame?: CDMScreenVolumeFrame
	// Shape of the screening volume.
	readonly screenVolumeShape?: CDMScreenVolumeShape
	// Screening volume component sizes (R/T or T/V, then N), AU (present only when all three are given).
	readonly screenVolume?: Vec3
	// Instant Object2 enters the screening volume (UTC).
	readonly screenEntryTime?: Time
	// Instant Object2 exits the screening volume (UTC).
	readonly screenExitTime?: Time
	// Originator's collision probability, in [0, 1].
	readonly collisionProbability?: number
	// Originator's probability method (for example FOSTER-1992).
	readonly collisionProbabilityMethod?: string
	// Relative-section comment lines, in order.
	readonly comments: readonly string[]
}

// Metadata and data of one conjunction object.
export interface CDMObject {
	// Which object of the conjunction this segment describes.
	readonly object: 'OBJECT1' | 'OBJECT2'
	// Satellite catalog designator.
	readonly designator: string
	// Satellite catalog name (for example SATCAT).
	readonly catalogName: string
	// Spacecraft name.
	readonly name: string
	// International designator YYYY-NNNP{PP} or UNKNOWN.
	readonly internationalDesignator: string
	// Object type.
	readonly objectType?: CDMObjectType
	// Operator contact position.
	readonly operatorContactPosition?: string
	// Operator organization.
	readonly operatorOrganization?: string
	// Operator phone number.
	readonly operatorPhone?: string
	// Operator email address.
	readonly operatorEmail?: string
	// External ephemeris name, or NONE when the originator's own OD was used.
	readonly ephemerisName: string
	// Covariance provenance; DEFAULT covariances are not orbit-determination results.
	readonly covarianceMethod: CDMCovarianceMethod
	// Maneuver capacity.
	readonly maneuverable: CDMManeuverable
	// Central body; EARTH when the keyword is absent.
	readonly orbitCenter: string
	// Reference frame of the state vector.
	readonly referenceFrame: CDMReferenceFrame
	// Gravity model of the OD.
	readonly gravityModel?: string
	// Atmospheric density model of the OD.
	readonly atmosphericModel?: string
	// N-body perturbations of the OD.
	readonly nBodyPerturbations?: string
	// Whether solar radiation pressure was modelled.
	readonly solarRadiationPressure?: boolean
	// Whether solid Earth and ocean tides were modelled.
	readonly earthTides?: boolean
	// Whether in-track thrust was modelled.
	readonly intrackThrust?: boolean
	// Start of the interval containing the last accepted observation (UTC).
	readonly timeLastObservationStart?: Time
	// End of the interval containing the last accepted observation (UTC).
	readonly timeLastObservationEnd?: Time
	// Recommended OD span, days.
	readonly recommendedOdSpan?: number
	// Actual OD span, days.
	readonly actualOdSpan?: number
	// Observations available for the OD.
	readonly observationsAvailable?: number
	// Observations accepted by the OD.
	readonly observationsUsed?: number
	// Sensor tracks available for the OD.
	readonly tracksAvailable?: number
	// Sensor tracks accepted by the OD.
	readonly tracksUsed?: number
	// Percentage of residuals accepted, in [0, 100].
	readonly residualsAccepted?: number
	// Weighted RMS of the OD residuals (dimensionless).
	readonly weightedRms?: number
	// Actual object area, m².
	readonly areaPc?: number
	// Effective drag area, m².
	readonly areaDrag?: number
	// Effective solar radiation pressure area, m².
	readonly areaSrp?: number
	// Object mass, kg.
	readonly mass?: number
	// CD·A/m used to propagate to TCA, m²/kg.
	readonly cdAreaOverMass?: number
	// CR·A/m used to propagate to TCA, m²/kg.
	readonly crAreaOverMass?: number
	// In-track thrust acceleration used to propagate to TCA, m/s².
	readonly thrustAcceleration?: number
	// Specific energy dissipation rate, W/kg.
	readonly sedr?: number
	// Position at TCA in `referenceFrame`, AU.
	readonly position: Vec3
	// Velocity at TCA in `referenceFrame`, AU/day (Earth-fixed velocity when the frame is ITRF).
	readonly velocity: Vec3
	// Symmetric RTN covariance at TCA, 6x6 to 9x9, ordered [R, T, N, Rdot, Tdot, Ndot, DRG, SRP, THR]: AU²,
	// AU²/day and AU²/day² on the position/velocity block, and the consider-parameter rows mixing that
	// position/velocity unit with CD·A/m (m²/kg), CR·A/m (m²/kg) or thrust acceleration (m/s²).
	readonly covariance: Matrix
	// Metadata and data comment lines of this object, in order.
	readonly comments: readonly string[]
}

// A parsed CDM 1.0 message.
export interface ConjunctionDataMessage {
	// Message header.
	readonly header: CDMHeader
	// Conjunction-level relative metadata/data.
	readonly relative: CDMRelativeData
	// Object1 then Object2.
	readonly objects: readonly [CDMObject, CDMObject]
}

// Value kinds a CDM keyword may carry.
type KeywordKind = 'text' | 'designator' | 'enum' | 'time' | 'double' | 'integer'

// Specification of one CDM keyword in its table.
interface KeywordSpec {
	// The KVN keyword.
	readonly keyword: string
	// Value kind.
	readonly kind: KeywordKind
	// Exact units designator; absent for dimensionless or textual values.
	readonly unit?: string
	// Whether the keyword is obligatory.
	readonly required?: boolean
	// Normative values of an enumeration.
	readonly values?: readonly string[]
}

// Parsed value of one keyword, before mapping to the public shape.
type KeywordValue = string | number | Time

// Normative YES/NO values.
const YES_NO = ['YES', 'NO'] as const

// Table 3-1: header keywords, in order.
const HEADER_KEYWORDS: readonly KeywordSpec[] = [
	{ keyword: 'CCSDS_CDM_VERS', kind: 'text', required: true },
	{ keyword: 'CREATION_DATE', kind: 'time', required: true },
	{ keyword: 'ORIGINATOR', kind: 'text', required: true },
	{ keyword: 'MESSAGE_FOR', kind: 'text' },
	{ keyword: 'MESSAGE_ID', kind: 'text', required: true },
]

// Table 3-2: relative metadata/data keywords, in order.
const RELATIVE_KEYWORDS: readonly KeywordSpec[] = [
	{ keyword: 'TCA', kind: 'time', required: true },
	{ keyword: 'MISS_DISTANCE', kind: 'double', unit: 'm', required: true },
	{ keyword: 'RELATIVE_SPEED', kind: 'double', unit: 'm/s' },
	{ keyword: 'RELATIVE_POSITION_R', kind: 'double', unit: 'm' },
	{ keyword: 'RELATIVE_POSITION_T', kind: 'double', unit: 'm' },
	{ keyword: 'RELATIVE_POSITION_N', kind: 'double', unit: 'm' },
	{ keyword: 'RELATIVE_VELOCITY_R', kind: 'double', unit: 'm/s' },
	{ keyword: 'RELATIVE_VELOCITY_T', kind: 'double', unit: 'm/s' },
	{ keyword: 'RELATIVE_VELOCITY_N', kind: 'double', unit: 'm/s' },
	{ keyword: 'START_SCREEN_PERIOD', kind: 'time' },
	{ keyword: 'STOP_SCREEN_PERIOD', kind: 'time' },
	{ keyword: 'SCREEN_VOLUME_FRAME', kind: 'enum', values: ['RTN', 'TVN'] },
	{ keyword: 'SCREEN_VOLUME_SHAPE', kind: 'enum', values: ['ELLIPSOID', 'BOX'] },
	{ keyword: 'SCREEN_VOLUME_X', kind: 'double', unit: 'm' },
	{ keyword: 'SCREEN_VOLUME_Y', kind: 'double', unit: 'm' },
	{ keyword: 'SCREEN_VOLUME_Z', kind: 'double', unit: 'm' },
	{ keyword: 'SCREEN_ENTRY_TIME', kind: 'time' },
	{ keyword: 'SCREEN_EXIT_TIME', kind: 'time' },
	{ keyword: 'COLLISION_PROBABILITY', kind: 'double' },
	{ keyword: 'COLLISION_PROBABILITY_METHOD', kind: 'text' },
]

// Table 3-3: per-object metadata keywords, in order.
const METADATA_KEYWORDS: readonly KeywordSpec[] = [
	{ keyword: 'OBJECT', kind: 'enum', values: ['OBJECT1', 'OBJECT2'], required: true },
	{ keyword: 'OBJECT_DESIGNATOR', kind: 'text', required: true },
	{ keyword: 'CATALOG_NAME', kind: 'text', required: true },
	{ keyword: 'OBJECT_NAME', kind: 'text', required: true },
	{ keyword: 'INTERNATIONAL_DESIGNATOR', kind: 'designator', required: true },
	{ keyword: 'OBJECT_TYPE', kind: 'enum', values: ['PAYLOAD', 'ROCKET BODY', 'DEBRIS', 'UNKNOWN', 'OTHER'] },
	{ keyword: 'OPERATOR_CONTACT_POSITION', kind: 'text' },
	{ keyword: 'OPERATOR_ORGANIZATION', kind: 'text' },
	{ keyword: 'OPERATOR_PHONE', kind: 'text' },
	{ keyword: 'OPERATOR_EMAIL', kind: 'text' },
	{ keyword: 'EPHEMERIS_NAME', kind: 'text', required: true },
	{ keyword: 'COVARIANCE_METHOD', kind: 'enum', values: ['CALCULATED', 'DEFAULT'], required: true },
	{ keyword: 'MANEUVERABLE', kind: 'enum', values: ['YES', 'NO', 'N/A'], required: true },
	{ keyword: 'ORBIT_CENTER', kind: 'text' },
	{ keyword: 'REF_FRAME', kind: 'enum', values: ['GCRF', 'EME2000', 'ITRF'], required: true },
	{ keyword: 'GRAVITY_MODEL', kind: 'text' },
	{ keyword: 'ATMOSPHERIC_MODEL', kind: 'text' },
	{ keyword: 'N_BODY_PERTURBATIONS', kind: 'text' },
	{ keyword: 'SOLAR_RAD_PRESSURE', kind: 'enum', values: YES_NO },
	{ keyword: 'EARTH_TIDES', kind: 'enum', values: YES_NO },
	{ keyword: 'INTRACK_THRUST', kind: 'enum', values: YES_NO },
]

// Covariance row labels in the [R, T, N, Rdot, Tdot, Ndot, DRG, SRP, THR] order of table 3-4.
const COVARIANCE_LABELS = ['R', 'T', 'N', 'RDOT', 'TDOT', 'NDOT', 'DRG', 'SRP', 'THR'] as const

// CDM SI unit factor of each covariance index: m, m/s, or the consider parameter itself.
const COVARIANCE_SI_UNITS = ['m', 'm', 'm', 'm/s', 'm/s', 'm/s', 'm**2/kg', 'm**2/kg', 'm/s**2'] as const

// Exact table 3-4 units designator of covariance element [row, col] (0-based, col <= row).

const COVARIANCE_UNITS: readonly (readonly string[])[] = [
	['m**2'],
	['m**2', 'm**2'],
	['m**2', 'm**2', 'm**2'],
	['m**2/s', 'm**2/s', 'm**2/s', 'm**2/s**2'],
	['m**2/s', 'm**2/s', 'm**2/s', 'm**2/s**2', 'm**2/s**2'],
	['m**2/s', 'm**2/s', 'm**2/s', 'm**2/s**2', 'm**2/s**2', 'm**2/s**2'],
	['m**3/kg', 'm**3/kg', 'm**3/kg', 'm**3/(kg*s)', 'm**3/(kg*s)', 'm**3/(kg*s)', 'm**4/kg**2'],
	['m**3/kg', 'm**3/kg', 'm**3/kg', 'm**3/(kg*s)', 'm**3/(kg*s)', 'm**3/(kg*s)', 'm**4/kg**2', 'm**4/kg**2'],
	['m**2/s**2', 'm**2/s**2', 'm**2/s**2', 'm**2/s**3', 'm**2/s**3', 'm**2/s**3', 'm**3/(kg*s**2)', 'm**3/(kg*s**2)', 'm**2/s**4'],
]

// KVN keyword of covariance element [row, col]: C<row>_<col>, e.g. CRDOT_T.
function covarianceKeyword(row: number, col: number) {
	return `C${COVARIANCE_LABELS[row]}_${COVARIANCE_LABELS[col]}`
}

// Table 3-4: per-object data keywords, in order (OD parameters, additional parameters, state vector,
// lower-triangular RTN covariance).
const DATA_KEYWORDS: readonly KeywordSpec[] = [
	{ keyword: 'TIME_LASTOB_START', kind: 'time' },
	{ keyword: 'TIME_LASTOB_END', kind: 'time' },
	{ keyword: 'RECOMMENDED_OD_SPAN', kind: 'double', unit: 'd' },
	{ keyword: 'ACTUAL_OD_SPAN', kind: 'double', unit: 'd' },
	{ keyword: 'OBS_AVAILABLE', kind: 'integer' },
	{ keyword: 'OBS_USED', kind: 'integer' },
	{ keyword: 'TRACKS_AVAILABLE', kind: 'integer' },
	{ keyword: 'TRACKS_USED', kind: 'integer' },
	{ keyword: 'RESIDUALS_ACCEPTED', kind: 'double', unit: '%' },
	{ keyword: 'WEIGHTED_RMS', kind: 'double' },
	{ keyword: 'AREA_PC', kind: 'double', unit: 'm**2' },
	{ keyword: 'AREA_DRG', kind: 'double', unit: 'm**2' },
	{ keyword: 'AREA_SRP', kind: 'double', unit: 'm**2' },
	{ keyword: 'MASS', kind: 'double', unit: 'kg' },
	{ keyword: 'CD_AREA_OVER_MASS', kind: 'double', unit: 'm**2/kg' },
	{ keyword: 'CR_AREA_OVER_MASS', kind: 'double', unit: 'm**2/kg' },
	{ keyword: 'THRUST_ACCELERATION', kind: 'double', unit: 'm/s**2' },
	{ keyword: 'SEDR', kind: 'double', unit: 'W/kg' },
	{ keyword: 'X', kind: 'double', unit: 'km', required: true },
	{ keyword: 'Y', kind: 'double', unit: 'km', required: true },
	{ keyword: 'Z', kind: 'double', unit: 'km', required: true },
	{ keyword: 'X_DOT', kind: 'double', unit: 'km/s', required: true },
	{ keyword: 'Y_DOT', kind: 'double', unit: 'km/s', required: true },
	{ keyword: 'Z_DOT', kind: 'double', unit: 'km/s', required: true },
	...COVARIANCE_UNITS.flatMap((units, row) => units.map((unit, col): KeywordSpec => ({ keyword: covarianceKeyword(row, col), kind: 'double', unit, required: row < 6 }))),
]

// Section of a KVN CDM, in message order.
type Section = 'header' | 'relative' | 'metadata1' | 'data1' | 'metadata2' | 'data2'

// Section order and keyword tables.
const SECTIONS: readonly (readonly [Section, readonly KeywordSpec[]])[] = [
	['header', HEADER_KEYWORDS],
	['relative', RELATIVE_KEYWORDS],
	['metadata1', METADATA_KEYWORDS],
	['data1', DATA_KEYWORDS],
	['metadata2', METADATA_KEYWORDS],
	['data2', DATA_KEYWORDS],
]

// Keyword -> owning table kind and position, for order checks.
const KEYWORD_INDEX = new Map<string, { readonly table: 'header' | 'relative' | 'metadata' | 'data'; readonly index: number; readonly spec: KeywordSpec }>()

for (const [table, specs] of [
	['header', HEADER_KEYWORDS],
	['relative', RELATIVE_KEYWORDS],
	['metadata', METADATA_KEYWORDS],
	['data', DATA_KEYWORDS],
] as const) {
	for (const [index, spec] of specs.entries()) KEYWORD_INDEX.set(spec.keyword, { table, index, spec })
}

// Maximum KVN line length, characters excluding terminators (6.2.2.1).
const MAX_LINE_LENGTH = 254

// Printable ASCII and blank only (6.2.2.2).
const PRINTABLE_ASCII = /^[ -~]*$/

// `keyword = value` line with uppercase, blank-free keyword (6.3.1.3-6.3.1.7).
const ASSIGNMENT = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/

// COMMENT line (6.3.4): the keyword followed by at least one space, or alone for an empty comment.
const COMMENT = /^\s*COMMENT(?: (.*))?$/

// Value followed by at least one blank and a bracketed units designator (6.3.3).
const VALUE_WITH_UNIT = /^(.*?)\s+\[([^\]]*)\]$/

// Decimal number with optional exponent and at least one digit on each side of a decimal point
// (6.3.2.1-6.3.2.3); rejects NaN, Infinity, hexadecimal and bare-point forms.
const DOUBLE = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

// Signed decimal integer (6.3.2.1).
const INTEGER = /^[+-]?\d+$/

// Calendar time tag yyyy-mm-ddThh:mm:ss[.d→d][Z] (6.3.2.6).
const CALENDAR_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)Z?$/

// Ordinal time tag yyyy-dddThh:mm:ss[.d→d][Z] (6.3.2.6).
const ORDINAL_TIME = /^(\d{4})-(\d{3})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)Z?$/

// International designator YYYY-NNNP{PP}, or UNKNOWN (table 3-3).
const INTERNATIONAL_DESIGNATOR = /^(?:\d{4}-\d{3}[A-Z]{1,3}|UNKNOWN)$/

// Cumulative day count before each month of a common year.
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365] as const

// Smallest |r×v|/(|r||v|), the cosine of the flight-path angle, for which the RTN normal of a state is
// well defined; below it the state is (numerically) radial and N would be dominated by rounding.
const RTN_DEGENERACY = 1e-10

// Kilometres to AU.
const KM_TO_AU = 1000 / AU_M

// Metres to AU.
const M_TO_AU = 1 / AU_M

// Metres per second to AU per day.
const M_S_TO_AU_DAY = DAYSEC / AU_M

// Kilometres per second to AU per day.
const KM_S_TO_AU_DAY = 1000 * M_S_TO_AU_DAY

// Factor converting each covariance index from its CDM SI unit to the library unit: m to AU, m/s to
// AU/day, and 1 for the consider parameters, which keep their CDM units.
const COVARIANCE_SCALE = COVARIANCE_SI_UNITS.map((unit) => (unit === 'm' ? M_TO_AU : unit === 'm/s' ? M_S_TO_AU_DAY : 1))

// Whether a Gregorian year is a leap year.
function isLeapYear(year: number) {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

// Number of days in a 1-based month.
function daysInMonth(year: number, month: number) {
	return DAYS_BEFORE_MONTH[month] - DAYS_BEFORE_MONTH[month - 1] + (month === 2 && isLeapYear(year) ? 1 : 0)
}

// Parses a CDM UTC time tag in calendar or ordinal form; a 60.x second is accepted only at 23:59, where
// a positive leap second may occur.
function parseTimeTag(value: string, line: number, keyword: string): Time {
	let year: number
	let month: number
	let day: number
	let clock: readonly [string, string, string]
	const calendar = CALENDAR_TIME.exec(value)

	if (calendar) {
		year = +calendar[1]
		month = +calendar[2]
		day = +calendar[3]
		if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= daysInMonth(year, month))) throw new CDMParseError('value', `invalid calendar date "${value}"`, line, keyword)
		clock = [calendar[4], calendar[5], calendar[6]]
	} else {
		const ordinal = ORDINAL_TIME.exec(value)
		if (!ordinal) throw new CDMParseError('value', `invalid time tag "${value}"`, line, keyword)
		year = +ordinal[1]
		const dayOfYear = +ordinal[2]
		const leap = isLeapYear(year) ? 1 : 0
		if (!(dayOfYear >= 1 && dayOfYear <= 365 + leap)) throw new CDMParseError('value', `invalid day of year "${value}"`, line, keyword)
		month = 1
		while (dayOfYear > DAYS_BEFORE_MONTH[month] + (month >= 2 ? leap : 0)) month++
		day = dayOfYear - DAYS_BEFORE_MONTH[month - 1] - (month > 2 ? leap : 0)
		clock = [ordinal[3], ordinal[4], ordinal[5]]
	}

	const hour = +clock[0]
	const minute = +clock[1]
	const second = +clock[2]
	if (!(hour <= 23 && minute <= 59 && (second < 60 || (hour === 23 && minute === 59 && second < 61)))) throw new CDMParseError('value', `invalid time of day "${value}"`, line, keyword)

	return timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC)
}

// Parses and unit-checks one keyword value against its specification.
function parseKeywordValue(spec: KeywordSpec, text: string, line: number): KeywordValue {
	const withUnit = VALUE_WITH_UNIT.exec(text)
	const value = withUnit ? withUnit[1] : text
	const unit = withUnit?.[2]

	if (spec.unit === undefined) {
		if (unit !== undefined) throw new CDMParseError('unit', `${spec.keyword} takes no units designator, found [${unit}]`, line, spec.keyword)
	} else if (unit === undefined) {
		throw new CDMParseError('unit', `${spec.keyword} requires the units designator [${spec.unit}]`, line, spec.keyword)
	} else if (unit !== spec.unit) {
		throw new CDMParseError('unit', `${spec.keyword} units must be [${spec.unit}], found [${unit}]`, line, spec.keyword)
	}

	if (value.length === 0) throw new CDMParseError('value', `${spec.keyword} has an empty value`, line, spec.keyword)

	switch (spec.kind) {
		case 'text':
			return value
		case 'designator':
			if (!INTERNATIONAL_DESIGNATOR.test(value)) throw new CDMParseError('value', `invalid international designator "${value}"`, line, spec.keyword)
			return value
		case 'enum':
			if (!spec.values?.includes(value)) throw new CDMParseError('value', `${spec.keyword} must be one of ${spec.values?.join(', ')}, found "${value}"`, line, spec.keyword)
			return value
		case 'time':
			return parseTimeTag(value, line, spec.keyword)
		case 'double': {
			const number = DOUBLE.test(value) ? +value : Number.NaN
			if (!Number.isFinite(number)) throw new CDMParseError('value', `${spec.keyword} must be a finite number, found "${value}"`, line, spec.keyword)
			return number
		}
		case 'integer': {
			const number = INTEGER.test(value) ? +value : Number.NaN
			if (!(number >= -2147483648 && number <= 2147483647)) throw new CDMParseError('value', `${spec.keyword} must be a 32-bit integer, found "${value}"`, line, spec.keyword)
			return number
		}
	}
}

// One keyword assignment of a section.
interface Assignment {
	// Parsed value.
	readonly value: KeywordValue
	// 1-based source line.
	readonly line: number
}

// Accumulated content of one message section.
interface SectionContent {
	// Assignments by keyword.
	readonly values: Map<string, Assignment>
	// Comment lines, in order.
	readonly comments: string[]
}

// Typed read access to one parsed section.
class SectionReader {
	// Wraps the content of `section`.
	constructor(
		readonly section: Section,
		readonly content: SectionContent,
	) {}

	// Source line of a keyword, if present.
	line(keyword: string) {
		return this.content.values.get(keyword)?.line
	}

	// Whether a keyword is present.
	has(keyword: string) {
		return this.content.values.has(keyword)
	}

	// Textual (text, designator or enum) value of a keyword, if present.
	text(keyword: string) {
		const value = this.content.values.get(keyword)?.value
		return typeof value === 'string' ? value : undefined
	}

	// Numeric value of a keyword, if present.
	number(keyword: string) {
		const value = this.content.values.get(keyword)?.value
		return typeof value === 'number' ? value : undefined
	}

	// Time-tag value of a keyword, if present.
	time(keyword: string) {
		const value = this.content.values.get(keyword)?.value
		return typeof value === 'object' ? value : undefined
	}

	// YES/NO value of a keyword as a boolean, if present.
	flag(keyword: string) {
		const value = this.text(keyword)
		return value === undefined ? undefined : value === 'YES'
	}

	// Obligatory textual value; presence is checked by checkRequired before the section is read.
	requiredText(keyword: string) {
		return this.text(keyword) ?? ''
	}

	// Obligatory numeric value; presence is checked by checkRequired or the caller before reading.
	requiredNumber(keyword: string) {
		return this.number(keyword) ?? Number.NaN
	}

	// Obligatory time-tag value; presence is checked by checkRequired before the section is read.
	requiredTime(keyword: string) {
		const value = this.time(keyword)
		if (value === undefined) throw new CDMParseError('missing', `${this.section} lacks ${keyword}`, undefined, keyword)
		return value
	}

	// Number of present keywords among `keywords`.
	count(keywords: readonly string[]) {
		let count = 0
		for (const keyword of keywords) if (this.has(keyword)) count++
		return count
	}

	// A vector of three optional components scaled by `scale`, present only when all three are given; a
	// partial triplet would be silently incomplete, so it is rejected.
	triplet(keywords: readonly [string, string, string], scale: number): Vec3 | undefined {
		const present = this.count(keywords)
		if (present === 0) return undefined
		if (present !== 3)
			throw new CDMParseError(
				'missing',
				`${keywords.join(', ')} must be given together`,
				undefined,
				keywords.find((keyword) => !this.has(keyword)),
			)
		return [this.requiredNumber(keywords[0]) * scale, this.requiredNumber(keywords[1]) * scale, this.requiredNumber(keywords[2]) * scale]
	}
}

// Rejects a section that lacks an obligatory keyword.
function checkRequired(reader: SectionReader, specs: readonly KeywordSpec[]) {
	for (const spec of specs) {
		if (spec.required && !reader.has(spec.keyword)) throw new CDMParseError('missing', `${reader.section} lacks the obligatory keyword ${spec.keyword}`, undefined, spec.keyword)
	}
}

// Rejects a non-negative quantity reported as negative.
function checkNonNegative(reader: SectionReader, keyword: string) {
	const value = reader.number(keyword)
	if (value !== undefined && !(value >= 0)) throw new CDMParseError('value', `${keyword} must not be negative`, reader.line(keyword), keyword)
}

// Reads the RTN covariance of an object and converts its position/velocity factors to AU and AU/day.
function readCovariance(reader: SectionReader) {
	// Rows 7-9 are optional, but a row may appear only complete and only after every preceding row (5.2.8).
	let size = 6

	for (let row = 6; row < 9; row++) {
		const keywords = COVARIANCE_UNITS[row].map((_, col) => covarianceKeyword(row, col))
		const present = reader.count(keywords)
		if (present === 0) continue
		if (present !== keywords.length || size !== row) throw new CDMParseError('missing', `covariance row ${COVARIANCE_LABELS[row]} must be complete and follow every preceding row`, undefined, keywords.find((keyword) => !reader.has(keyword)) ?? keywords[0])
		size = row + 1
	}

	const covariance = new Matrix(size, size)

	for (let row = 0; row < size; row++) {
		for (let col = 0; col <= row; col++) {
			const keyword = covarianceKeyword(row, col)
			const value = reader.requiredNumber(keyword)
			if (row === col && !(value >= 0)) throw new CDMParseError('value', `${keyword} is a variance and must not be negative`, reader.line(keyword), keyword)
			const converted = value * COVARIANCE_SCALE[row] * COVARIANCE_SCALE[col]
			covariance.set(row, col, converted)
			covariance.set(col, row, converted)
		}
	}

	return covariance
}

// Builds one object from its metadata and data sections.
function readObject(metadata: SectionReader, data: SectionReader, expected: 'OBJECT1' | 'OBJECT2'): CDMObject {
	const object = metadata.requiredText('OBJECT')
	if (object !== expected) throw new CDMParseError('value', `expected OBJECT = ${expected}, found ${object}`, metadata.line('OBJECT'), 'OBJECT')

	const position: Vec3 = [data.requiredNumber('X') * KM_TO_AU, data.requiredNumber('Y') * KM_TO_AU, data.requiredNumber('Z') * KM_TO_AU]
	const velocity: Vec3 = [data.requiredNumber('X_DOT') * KM_S_TO_AU_DAY, data.requiredNumber('Y_DOT') * KM_S_TO_AU_DAY, data.requiredNumber('Z_DOT') * KM_S_TO_AU_DAY]

	// The covariance is defined in the RTN frame of this state; a zero radius or a velocity parallel to the
	// radius (to within RTN_DEGENERACY) leaves R or N undefined, so such a state cannot carry a covariance.
	if (!(vecCrossLength(position, velocity) > RTN_DEGENERACY * vecLength(position) * vecLength(velocity))) throw new CDMParseError('value', `${expected} state vector does not define an RTN frame`, data.line('X'), 'X')

	const residualsAccepted = data.number('RESIDUALS_ACCEPTED')
	if (residualsAccepted !== undefined && !(residualsAccepted >= 0 && residualsAccepted <= 100)) throw new CDMParseError('value', 'RESIDUALS_ACCEPTED must be within [0, 100]', data.line('RESIDUALS_ACCEPTED'), 'RESIDUALS_ACCEPTED')

	return {
		object,
		designator: metadata.requiredText('OBJECT_DESIGNATOR'),
		catalogName: metadata.requiredText('CATALOG_NAME'),
		name: metadata.requiredText('OBJECT_NAME'),
		internationalDesignator: metadata.requiredText('INTERNATIONAL_DESIGNATOR'),
		objectType: metadata.text('OBJECT_TYPE') as CDMObjectType | undefined,
		operatorContactPosition: metadata.text('OPERATOR_CONTACT_POSITION'),
		operatorOrganization: metadata.text('OPERATOR_ORGANIZATION'),
		operatorPhone: metadata.text('OPERATOR_PHONE'),
		operatorEmail: metadata.text('OPERATOR_EMAIL'),
		ephemerisName: metadata.requiredText('EPHEMERIS_NAME'),
		covarianceMethod: metadata.requiredText('COVARIANCE_METHOD') as CDMCovarianceMethod,
		maneuverable: metadata.requiredText('MANEUVERABLE') as CDMManeuverable,
		orbitCenter: metadata.text('ORBIT_CENTER') ?? 'EARTH',
		referenceFrame: metadata.requiredText('REF_FRAME') as CDMReferenceFrame,
		gravityModel: metadata.text('GRAVITY_MODEL'),
		atmosphericModel: metadata.text('ATMOSPHERIC_MODEL'),
		nBodyPerturbations: metadata.text('N_BODY_PERTURBATIONS'),
		solarRadiationPressure: metadata.flag('SOLAR_RAD_PRESSURE'),
		earthTides: metadata.flag('EARTH_TIDES'),
		intrackThrust: metadata.flag('INTRACK_THRUST'),
		timeLastObservationStart: data.time('TIME_LASTOB_START'),
		timeLastObservationEnd: data.time('TIME_LASTOB_END'),
		recommendedOdSpan: data.number('RECOMMENDED_OD_SPAN'),
		actualOdSpan: data.number('ACTUAL_OD_SPAN'),
		observationsAvailable: data.number('OBS_AVAILABLE'),
		observationsUsed: data.number('OBS_USED'),
		tracksAvailable: data.number('TRACKS_AVAILABLE'),
		tracksUsed: data.number('TRACKS_USED'),
		residualsAccepted,
		weightedRms: data.number('WEIGHTED_RMS'),
		areaPc: data.number('AREA_PC'),
		areaDrag: data.number('AREA_DRG'),
		areaSrp: data.number('AREA_SRP'),
		mass: data.number('MASS'),
		cdAreaOverMass: data.number('CD_AREA_OVER_MASS'),
		crAreaOverMass: data.number('CR_AREA_OVER_MASS'),
		thrustAcceleration: data.number('THRUST_ACCELERATION'),
		sedr: data.number('SEDR'),
		position,
		velocity,
		covariance: readCovariance(data),
		comments: [...metadata.content.comments, ...data.content.comments],
	}
}

// Parses an untrusted CCSDS CDM 1.0 KVN text.
//
// Enforces the KVN rules of CCSDS 508.0-B-1: CCSDS_CDM_VERS = 1.0 as the first non-blank line; lines of at
// most 254 printable ASCII characters; one `keyword = value` per line; only the keywords of tables 3-1 to
// 3-4, in their fixed order, within the sections header, relative, Object1 metadata/data and Object2
// metadata/data; every obligatory keyword; exact units designators where units apply and none elsewhere;
// numeric and time-tag syntax; normative enumeration values; complete optional covariance rows; and one
// REF_FRAME and orbit centre shared by both objects (ITRF only about EARTH). Comment lines are kept
// verbatim after their separating blank and attached to the section whose keywords follow them; free-text
// values are kept verbatim, without case or underscore normalization. XML CDMs, other message types and
// other versions are rejected.
//
// Throws CDMParseError with a machine-readable `code` on the first violation. The returned message uses
// the library units described in the module comment.
export function parseCDM(text: string): ConjunctionDataMessage {
	const contents: SectionContent[] = []
	let sectionIndex = -1
	let position = -1
	let pendingComments: string[] = []
	const lines = text.split(/\r\n|\n\r|\r|\n/)

	for (let i = 0; i < lines.length; i++) {
		const lineNumber = i + 1
		const raw = lines[i]

		if (sectionIndex < 0 && raw.trimStart().startsWith('<')) throw new CDMParseError('unsupportedFormat', 'XML-encoded CDMs are not supported; only KVN is', lineNumber)
		if (raw.length > MAX_LINE_LENGTH) throw new CDMParseError('syntax', `line exceeds ${MAX_LINE_LENGTH} characters`, lineNumber)
		if (!PRINTABLE_ASCII.test(raw)) throw new CDMParseError('syntax', 'line contains a control or non-ASCII character', lineNumber)

		const line = raw.trimEnd()
		if (line.trim().length === 0) continue

		const comment = COMMENT.exec(line)

		if (comment) {
			if (sectionIndex < 0) throw new CDMParseError('unsupportedFormat', 'the first non-blank line must be CCSDS_CDM_VERS', lineNumber)
			pendingComments.push(comment[1] ?? '')
			continue
		}

		const assignment = ASSIGNMENT.exec(line)
		if (!assignment) throw new CDMParseError('syntax', 'expected a "keyword = value" line', lineNumber)

		const keyword = assignment[1]
		const value = assignment[2]

		if (sectionIndex < 0) {
			if (keyword !== 'CCSDS_CDM_VERS') throw new CDMParseError('unsupportedFormat', 'the first non-blank line must be CCSDS_CDM_VERS', lineNumber, keyword)
			if (value !== '1.0') throw new CDMParseError('unsupportedVersion', `CCSDS_CDM_VERS ${value} is not supported; only 1.0 is`, lineNumber, keyword)
		}

		const entry = KEYWORD_INDEX.get(keyword)
		if (!entry) throw new CDMParseError('unknownKeyword', `${keyword} is not a CDM 1.0 keyword`, lineNumber, keyword)

		const current = sectionIndex >= 0 ? SECTIONS[sectionIndex][0] : undefined

		if (current === undefined || !current.startsWith(entry.table)) {
			// Entering another section: it must be the immediate successor, so a skipped section is missing
			// and a keyword of an earlier section is out of order.
			const next = SECTIONS.findIndex(([section], index) => index > sectionIndex && section.startsWith(entry.table))
			if (next < 0) throw new CDMParseError('order', `${keyword} is out of order`, lineNumber, keyword)
			if (next !== sectionIndex + 1) throw new CDMParseError('missing', `section ${SECTIONS[sectionIndex + 1][0]} is missing before ${keyword}`, lineNumber, keyword)
			sectionIndex = next
			contents.push({ values: new Map(), comments: [] })
		} else if (entry.index <= position) {
			const repeated = contents[sectionIndex].values.has(keyword)
			throw new CDMParseError(repeated ? 'duplicate' : 'order', `${keyword} is ${repeated ? 'repeated' : 'out of order'} in ${current}`, lineNumber, keyword)
		}

		position = entry.index
		const content = contents[sectionIndex]
		content.comments.push(...pendingComments)
		pendingComments = []
		content.values.set(keyword, { value: parseKeywordValue(entry.spec, value, lineNumber), line: lineNumber })
	}

	if (sectionIndex < 0) throw new CDMParseError('unsupportedFormat', 'the text contains no CDM')
	if (sectionIndex < SECTIONS.length - 1) throw new CDMParseError('missing', `section ${SECTIONS[sectionIndex + 1][0]} is missing`)
	contents[sectionIndex].comments.push(...pendingComments)

	const readers = SECTIONS.map(([section, specs], index) => {
		const reader = new SectionReader(section, contents[index])
		checkRequired(reader, specs)
		return reader
	})

	const [header, relative, metadata1, data1, metadata2, data2] = readers

	checkNonNegative(relative, 'MISS_DISTANCE')
	checkNonNegative(relative, 'RELATIVE_SPEED')
	const collisionProbability = relative.number('COLLISION_PROBABILITY')
	if (collisionProbability !== undefined && !(collisionProbability >= 0 && collisionProbability <= 1)) throw new CDMParseError('value', 'COLLISION_PROBABILITY must be within [0, 1]', relative.line('COLLISION_PROBABILITY'), 'COLLISION_PROBABILITY')

	const objects = [readObject(metadata1, data1, 'OBJECT1'), readObject(metadata2, data2, 'OBJECT2')] as const

	// Both state vectors must share one frame and centre, otherwise their difference is meaningless.
	if (objects[0].referenceFrame !== objects[1].referenceFrame) throw new CDMParseError('frame', `REF_FRAME differs between objects (${objects[0].referenceFrame}, ${objects[1].referenceFrame})`, metadata2.line('REF_FRAME'), 'REF_FRAME')
	if (objects[0].orbitCenter !== objects[1].orbitCenter) throw new CDMParseError('frame', `ORBIT_CENTER differs between objects (${objects[0].orbitCenter}, ${objects[1].orbitCenter})`, metadata2.line('ORBIT_CENTER') ?? metadata1.line('ORBIT_CENTER'), 'ORBIT_CENTER')
	if (objects[0].referenceFrame === 'ITRF' && objects[0].orbitCenter !== 'EARTH') throw new CDMParseError('frame', `ITRF state vectors require ORBIT_CENTER = EARTH, found ${objects[0].orbitCenter}`, metadata1.line('ORBIT_CENTER'), 'ORBIT_CENTER')

	const relativeSpeed = relative.number('RELATIVE_SPEED')

	return {
		header: {
			version: '1.0',
			creationDate: header.requiredTime('CREATION_DATE'),
			originator: header.requiredText('ORIGINATOR'),
			messageFor: header.text('MESSAGE_FOR'),
			messageId: header.requiredText('MESSAGE_ID'),
			comments: header.content.comments,
		},
		relative: {
			tca: relative.requiredTime('TCA'),
			missDistance: relative.requiredNumber('MISS_DISTANCE') * M_TO_AU,
			relativeSpeed: relativeSpeed === undefined ? undefined : relativeSpeed * M_S_TO_AU_DAY,
			relativePosition: relative.triplet(['RELATIVE_POSITION_R', 'RELATIVE_POSITION_T', 'RELATIVE_POSITION_N'], M_TO_AU),
			relativeVelocity: relative.triplet(['RELATIVE_VELOCITY_R', 'RELATIVE_VELOCITY_T', 'RELATIVE_VELOCITY_N'], M_S_TO_AU_DAY),
			startScreenPeriod: relative.time('START_SCREEN_PERIOD'),
			stopScreenPeriod: relative.time('STOP_SCREEN_PERIOD'),
			screenVolumeFrame: relative.text('SCREEN_VOLUME_FRAME') as CDMScreenVolumeFrame | undefined,
			screenVolumeShape: relative.text('SCREEN_VOLUME_SHAPE') as CDMScreenVolumeShape | undefined,
			screenVolume: relative.triplet(['SCREEN_VOLUME_X', 'SCREEN_VOLUME_Y', 'SCREEN_VOLUME_Z'], M_TO_AU),
			screenEntryTime: relative.time('SCREEN_ENTRY_TIME'),
			screenExitTime: relative.time('SCREEN_EXIT_TIME'),
			collisionProbability,
			collisionProbabilityMethod: relative.text('COLLISION_PROBABILITY_METHOD'),
			comments: relative.content.comments,
		},
		objects,
	}
}
