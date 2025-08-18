import { type Angle, toDeg } from './angle'
import { type ReadCsvOptions, readCsv } from './csv'
import type { DateTime } from './datetime'
import { type Distance, toKilometer } from './distance'

// https://ssd.jpl.nasa.gov/horizons/manual.html
// https://ssd-api.jpl.nasa.gov/doc/horizons.html

export const HORIZONS_BASE_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api'

const DATE_TIME_FORMAT = 'YYYY-MM-DD HH:mm:ss.SSS'

export type YesNo = 'NO' | 'YES'

export type OutputFormat = 'json' | 'text'

// https://ssd.jpl.nasa.gov/horizons/manual.html#center
export type ObserverSiteCenter = `coord@${number}` | 'coord' | `${string}@${number}` | 'geo' | '@TLE'
export type BodyCenter = 'geo' | `500@${number}`

export type ObserverSiteCoord = readonly [Angle, Angle, Distance] | `${number},${number},${number}` | 0 | false | undefined

export type ReferencePlane = 'ECLIPTIC' | 'FRAME' | 'BODY_EQUATOR'

export type CoordinateType = 'GEODETIC' | 'CILINDRICAL'

export type EphemerisType = 'OBSERVER' | 'VECTOR' | 'ELEMENTS' | 'SPK'

export type TimeDigitPrecision = 'MINUTES' | 'SECONDS' | 'FRACSEC'

export type TimeType = 'UT' | 'TT' | 'TDB'

export type ReferenceSystem = 'ICRF' | 'B1950'

export type ReferenceEclipticFrame = 'J2000' | 'B1950'

export type OutputUnits = 'KM-S' | 'AU-D' | 'KM-D'

export type VectorCorrection = 'NONE' | 'LT' | 'LT+S'

export type CalendarFormat = 'CAL' | 'JD' | 'BOTH'

export type CalendarType = 'GREGORIAN' | 'MIXED'

export type AngleFormat = 'HMS' | 'DEG'

export type RefractionCorrection = 'AIRLESS' | 'REFRACTED'

export type RangeUnit = 'AU' | 'KM'

export type TimeOfPeriapsisType = 'ABSOLUTE' | 'RELATIVE'

export type StepSizeUnit = 'd' | 'm' | 'h' | 'y' | 'mo' | 'days' | 'minutes' | 'hours' | 'years' | 'months' | 'unitless'

export type HorizonsQueryParameterKey = keyof HorizonsEphemerisSpecificParameters | keyof HorizonsSpkFileParameters | keyof HorizonsHeliocentricEclipticOsculatingElementParameters | keyof HorizonsTLEParameters

export type HorizonsQueryParameters = Record<HorizonsQueryParameterKey, unknown>

export interface ObserverVectorElementsOptions extends Pick<ReadCsvOptions, 'skipFirstLine'> {
	stepSize?: number
	stepSizeUnit?: StepSizeUnit
	refractionCorrection?: boolean
	extraPrecision?: boolean
	coordinateType?: CoordinateType
	referenceSystem?: ReferenceSystem
	referencePlane?: ReferencePlane
	calendarFormat?: CalendarFormat
	calendarType?: CalendarType
	timeDigitsPrecision?: TimeDigitPrecision
	angleFormat?: AngleFormat
	skipDaylight?: boolean
	rangeUnits?: RangeUnit
	outputUnits?: OutputUnits
	suppressRangeRate?: boolean
	vectorCorrection?: VectorCorrection
	timeZone?: string | number // +00:00 or UTC offset in minutes
	timeOfPeriapsisType?: TimeOfPeriapsisType
}

export interface PerihelionDistanceAndTime {
	qr: Distance // perihelionDistance
	tp: number // perihelionTime in TDB
}

export interface MeanAnomalyAndSemiMajorAxis {
	ma: Angle // meanAnomaly
	a: Distance // semiMajorAxis
}

export interface MeanAnomalyAndMeanMotion {
	ma: Angle // meanAnomaly
	n: Angle // meanMotion in rad/day
}

export interface ObserverWithOsculatingElements {
	epoch: number
	referenceEclipticFrame?: ReferenceEclipticFrame
	ec: Angle // eccentricity
	tpqr: PerihelionDistanceAndTime | MeanAnomalyAndSemiMajorAxis | MeanAnomalyAndMeanMotion
	om: Angle // longitudeOfAscendingNode
	w: Angle // argumentOfPerihelion
	i: Angle // inclination

	// For asteroids, additional OPTIONAL parameters can be given:
	h?: number // absoluteMagnitude (asteroid)
	g?: number // magnitudeSlope (asteroid)

	// For comets, additional OPTIONAL parameters can be given:
	m1?: number // Total absolute magnitude (comet)
	m2?: number // Nuclear absolute magnitude (comet)
	k1?: number // Total magnitude scaling factor (comet)
	k2?: number // Nuclear magnitude scaling factor (comet)
	phcof?: number // Phase coefficient for k2=5 (comet)

	// Non-gravitational models (allowed for comets OR asteroids)
	a1?: number // Radial non-grav accel (comet), au/d^2
	a2?: number // Transverse non-grav accel (comet),  au/d^2
	a3?: number // Normal non-grav accel (comet), au/d^2
	r0?: number // Non-grav. model constant, normalizing distance, au  [2.808]
	aln?: number // Non-grav. model constant, normalizing factor [0.1112620426]
	nm?: number // Non-grav. model constant, exponent m                 [2.15]
	nn?: number // Non-grav. model constant, exponent n                [5.093]
	nk?: number // Non-grav. model constant, exponent k               [4.6142]
	dt?: number // Non-grav lag/delay parameter (comets only), days
	amrat?: number // Solar pressure model, area/mass ratio, m^2/kg
}

export interface ObserverWithTLE {
	line1: string
	line2: string
	line3: string
}

export interface HorizonsCommonParameters {
	COMMAND?: string // target search, selection, or enter user-input object mode
	OBJ_DATA?: YesNo // [YES]: toggles return of object summary data
	MAKE_EPHEM?: YesNo // [YES]: toggles generation of ephemeris, if possible
	EPHEM_TYPE?: EphemerisType // [OBSERVER]: specifies type of ephemeris to generate
	START_TIME?: string // specifies ephemeris start time
	STOP_TIME?: string // specifies ephemeris stop time
}

export interface HorizonsEphemerisSpecificParameters extends HorizonsCommonParameters {
	CENTER?: string // [OVE]: selects coordinate origin (observing site)
	REF_PLANE?: ReferencePlane // [VE] [ECLIPTIC]: Ephemeris reference plane
	COORD_TYPE?: CoordinateType // [OVE] [GEODETIC]: selects type of user coordinates
	SITE_COORD?: string // [OVE] [0,0,0]: set coordinate triplets for COORD_TYPE
	STEP_SIZE?: string // [OVE] [60 min]: ephemeris output print step
	TIME_DIGITS?: TimeDigitPrecision // [OVE] [MINUTES]: controls output time precision
	TIME_TYPE?: TimeType // [OVE]: specifies input & output timescale. observer: UT or TT; vector: TDB or UT; elements: TDB only
	TIME_ZONE?: string // [O] [+00:00]: specifies local civil time offset relative to UT
	QUANTITIES?: string // [O] [A]: list of desired output quantity option codes
	REF_SYSTEM?: ReferenceSystem // [OVE] [ICRF]: specifies reference frame for any geometric and astrometric quantities
	OUT_UNITS?: OutputUnits // [VE] [KM-S]: selects output units for distance and time
	VEC_TABLE?: number // [V] [3]: selects vector table format (1-6)
	VEC_CORR?: VectorCorrection // [V] [NONE]: selects level of correction to output vectors
	CAL_FORMAT?: CalendarFormat // [O] [CAL]: selects type of date output
	CAL_TYPE?: CalendarType // [OVE] [MIXED]: Selects Gregorian-only calendar input/output, or mixed Julian/Gregorian, switching on 1582-Oct-5. Recognized for close-approach tables also.
	ANG_FORMAT?: AngleFormat // [O] [HMS]: selects RA/DEC output format
	APPARENT?: RefractionCorrection // [O] [AIRLESS]: toggles refraction correction of apparent coordinates (Earth topocentric only)
	RANGE_UNITS?: RangeUnit // [O] [AU]: sets the units on range quantities output
	SUPPRESS_RANGE_RATE?: YesNo // [O] [NO]: turns off output of delta-dot and rdot (range-rate)
	ELEV_CUT?: number // [O] [-90] // skip output when object elevation is less than specified [-90:90]
	SKIP_DAYLT?: YesNo // [O] [NO]: toggles skipping of print-out when daylight at CENTER
	SOLAR_ELONG?: string // [0] [0-180]: sets bounds on output based on solar elongation angle
	AIRMASS?: number // [O] [38.0]: select airmass cutoff; output is skipped if relative optical airmass is greater than the single decimal value specified. Note than 1.0=zenith, 38.0 ~= local-horizon. If value is set >= 38.0, this turns OFF the filtering effect.
	LHA_CUTOFF?: number // [O] [0.0]: skip output when local hour angle exceeds a specified value in the domain 0.0 < X < 12.0. To restore output (turn OFF the cut-off behavior),
	ANG_RATE_CUTOFF?: number // [O] [0.0]: skip output when the total plane-of-sky angular rate exceeds a specified value
	EXTRA_PREC?: YesNo // [O] [NO]: toggles additional output digits on some angles such as RA/DEC
	CSV_FORMAT?: YesNo // [OVE] [NO]: toggles output of table in comma-separated value format
	VEC_LABELS?: YesNo // [V] [YES]: toggles labeling of each vector component
	VEC_DELTA_T?: YesNo // [V] [NO]: toggles output of the time-varying delta-T difference TDB-UT
	ELM_LABELS?: YesNo // [E] [NO]: toggles labeling of each osculating element
	TP_TYPE?: TimeOfPeriapsisType // [E] [ABSOLUTE]: determines what type of periapsis time (Tp) is returned
	R_T_S_ONLY?: YesNo // [O] [NO]: toggles output only at target rise/transit/set
}

export interface HorizonsSpkFileParameters extends HorizonsCommonParameters {}

// can be specified by users when COMMAND=';'
export interface HorizonsHeliocentricEclipticOsculatingElementParameters extends HorizonsCommonParameters {
	OBJECT?: string // Name of user input object
	EPOCH: number // Julian Day number (JDTDB) of osculating elements
	ECLIP: string // Reference ecliptic frame of elements: J2000 or B1950. J2000 assumes the IAU76/80 J2000 obliquity of 84381.448 arcsec relative to the ICRF reference frame. B1950 assumes FK4/B1950 obliquity of 84404.8362512 arcsec.
	EC: string // Eccentricity
	QR?: number // (au) Perihelion distance (see note above)
	TP?: number // Perihelion Julian Day number (see note above)
	OM: number // (deg) Longitude of ascending node wrt ecliptic
	W: number // (deg) Argument of perihelion wrt ecliptic
	IN: number // (deg) Inclination wrt ecliptic
	MA?: number // (deg) Mean anomaly (see note above)
	A?: number // (au) Semi-major axis (see note above)
	N?: number // (deg/d) Mean motion (see note above)

	// Small-body parameters
	RAD?: number // (km) Object radius
	H?: number // Absolute magnitude parameter
	G?: number // Magnitude slope parameter; can be < 0
	M1?: number // Total absolute magnitude
	M2?: number // Nuclear absolute magnitude
	K1?: number // Total magnitude scaling factor
	K2?: number // Nuclear magnitude scaling factor
	PHCOF?: number // Phase coefficient for k2=5 (comet)
	A1?: number // Radial non-grav accel (comet), au/d^2
	A2?: number // Transverse non-grav accel (comet),  au/d^2
	A3?: number // Normal non-grav accel (comet), au/d^2
	R0?: number // Non-grav. model constant, normalizing distance, au  [2.808]
	ALN?: number // Non-grav. model constant, normalizing factor [0.1112620426]
	NM?: number // Non-grav. model constant, exponent m                 [2.15]
	NN?: number // Non-grav. model constant, exponent n                [5.093]
	NK?: number // Non-grav. model constant, exponent k               [4.6142]
	DT?: number // Non-grav lag/delay parameter (comets only), days
	AMRAT?: number // Solar pressure model, area/mass ratio, m^2/kg
}

export interface HorizonsTLEParameters extends HorizonsCommonParameters {
	TLE: string // must be supplied in standard format with starting and ending quote marks enclosing the entire block and encoding new-line and spaces
}

export interface SpkFile {
	readonly spk?: string
	readonly error?: string
}

export enum Quantity {
	ASTROMETRIC_RA_DEC = 1, // Astrometric RA & DEC
	NORTH_POLE_POSITION_ANGLE_DISTANCE = 17, // North Pole position angle & distance
	GALACTIC_LONGITUDE_LATITUDE = 33, // Galactic longitude & latitude
	APPARENT_RA_DEC = 2, // Apparent RA & DEC
	HELIOCENTRIC_ECLIPTIC_LON_LAT = 18, // Heliocentric ecliptic lon. & lat.
	LOCAL_APPARENT_SOLAR_TIME = 34, // Local apparent SOLAR time
	RATES_RA_DEC = 3, // Rates; RA & DEC
	HELIOCENTRIC_RANGE_AND_RANGE_RATE = 19, // Heliocentric range & range-rate
	EARTH_OBS_SITE_LIGHT_TIME = 35, // Earth->obs. site light-time
	APPARENT_AZ_EL = 4, // Apparent AZ & EL
	OBSERVER_RANGE_AND_RANGE_RATE = 20, // Observer range & range-rate
	RA_DEC_UNCERTAINTY = 36, // RA & DEC uncertainty
	RATES_AZ_EL = 5, // Rates; AZ & EL
	ONE_WAY_DOWN_LEG_LIGHT_TIME = 21, // One-way (down-leg) light-time
	PLANE_OF_SKY_ERROR_ELLIPSE = 37, // Plane-of-sky error ellipse
	SATELLITE_X_Y_POS_ANGLE = 6, // Satellite X & Y, pos. angle
	SPEED_WRT_SUN_OBSERVER = 22, // Speed wrt Sun & observer
	PLANE_OF_SKY_UNCERTAINTY_RSS = 38, // POS uncertainty (RSS)
	LOCAL_APPARENT_SIDEREAL_TIME = 7, // Local apparent sidereal time
	SUN_OBSERVER_TARGET_ELONG_ANGLE = 23, // Sun-Observer-Target ELONG angle
	RANGE_RANGE_RATE_3_SIGMAS = 39, // Range & range-rate 3-sigmas
	AIRMASS_EXTINCTION = 8, // Airmass & extinction
	SUN_TARGET_OBSERVER_PHASE_ANGLE = 24, // Sun-Target-Observer ~PHASE angle
	DOPPLER_DELAY_3_SIGMAS = 40, // Doppler & delay 3-sigmas
	VISUAL_MAG_SURFACE_BRGHT = 9, // Visual mag. & Surface Brght
	TARGET_OBSERVER_MOON_ANGLE_ILLUM = 25, // Target-Observer-Moon angle/ Illum%
	TRUE_ANOMALY_ANGLE = 41, // True anomaly angle
	ILLUMINATED_FRACTION = 10, // Illuminated fraction
	OBSERVER_PRIMARY_TARGET_ANGLE = 26, // Observer-Primary-Target angle
	LOCAL_APPARENT_HOUR_ANGLE = 42, // Local apparent hour angle
	DEFECT_OF_ILLUMINATION = 11, // Defect of illumination
	SUN_TARGET_RADIAL_VEL_POS_ANGLE = 27, // Sun-Target radial & -vel pos. angle
	PHASE_ANGLE_BISECTOR = 43, // PHASE angle & bisector
	SATELLITE_ANGULAR_SEPAR_VIS = 12, // Satellite angular separ/vis.
	ORBIT_PLANE_ANGLE = 28, // Orbit plane angle
	APPARENT_LONGITUDE_SUN_L_S = 44, // Apparent longitude Sun (L_s)
	TARGET_ANGULAR_DIAMETER = 13, // Target angular diameter
	CONSTELLATION_ID = 29, // Constellation ID
	INERTIAL_APPARENT_RA_DEC = 45, // Inertial apparent RA & DEC
	OBSERVER_SUB_LON_SUB_LAT = 14, // Observer sub-lon & sub-lat
	DELTA_T_TDB_UT = 30, // Delta-T (TDB - UT)
	RATE_INERTIAL_RA_DEC = 46, // Rate: Inertial RA & DEC
	SUN_SUB_LONGITUDE_SUB_LATITUDE = 15, // Sun sub-longitude & sub-latitude
	OBSERVER_ECLIPTIC_LON_LAT = 31, // Observer ecliptic lon. & lat.
	SKY_MOTION_RATE_ANGLES = 47, // Sky motion: rate & angles
	SUB_SUN_POSITION_ANGLE_DISTANCE = 16, // Sub-Sun position angle & distance
	NORTH_POLE_RA_DEC = 32, // North pole RA & DEC
	LUNAR_SKY_BRIGHTNESS_SKY_SNR = 48, // Lunar sky-brightness & sky SNR
}

const DEFAULT_QUANTITIES: Quantity[] = [1, 9, 20, 23, 24, 47, 48]

const DEFAULT_OVE_OPTIONS: Required<ObserverVectorElementsOptions> = {
	stepSize: 60,
	stepSizeUnit: 'm',
	refractionCorrection: true,
	extraPrecision: false,
	coordinateType: 'GEODETIC',
	referenceSystem: 'ICRF',
	referencePlane: 'FRAME',
	calendarFormat: 'CAL',
	calendarType: 'GREGORIAN',
	timeDigitsPrecision: 'MINUTES',
	angleFormat: 'DEG',
	skipDaylight: false,
	rangeUnits: 'AU',
	suppressRangeRate: true,
	outputUnits: 'AU-D',
	vectorCorrection: 'NONE',
	skipFirstLine: true,
	timeZone: '',
	timeOfPeriapsisType: 'ABSOLUTE',
}

export async function observer(input: string | ObserverWithOsculatingElements | ObserverWithTLE, center: ObserverSiteCenter, coord: ObserverSiteCoord, startTime: DateTime, endTime: DateTime, quantities: Quantity[] = DEFAULT_QUANTITIES, options: ObserverVectorElementsOptions = DEFAULT_OVE_OPTIONS) {
	const parameters = structuredClone(DEFAULT_OBSERVER_PARAMETERS) as HorizonsQueryParameters
	makeParametersFromInput(parameters, input)
	makeParametersFromCenterAndCoordinates(parameters, center, coord, options)
	makeParametersFromStartAndStopTime(parameters, startTime, endTime)
	makeParametersFromQuantities(parameters, quantities)
	makeParametersFromOptions(parameters, options)
	parameters.CSV_FORMAT = 'YES'
	const response = await makeRequestAndGetResponse(parameters, 'text')
	return parseCsvTable(await response.text(), options)
}

export async function vector(input: string | ObserverWithOsculatingElements | ObserverWithTLE, center: ObserverSiteCenter, coord: ObserverSiteCoord, startTime: DateTime, endTime: DateTime, options: ObserverVectorElementsOptions = DEFAULT_OVE_OPTIONS) {
	const parameters = structuredClone(DEFAULT_VECTOR_PARAMETERS) as HorizonsQueryParameters
	makeParametersFromInput(parameters, input)
	makeParametersFromCenterAndCoordinates(parameters, center, coord, options)
	makeParametersFromStartAndStopTime(parameters, startTime, endTime)
	makeParametersFromOptions(parameters, options)
	parameters.CSV_FORMAT = 'YES'
	const response = await makeRequestAndGetResponse(parameters, 'text')
	return parseCsvTable(await response.text(), options)
}

export async function elements(input: string | ObserverWithOsculatingElements | ObserverWithTLE, center: BodyCenter, startTime: DateTime, endTime: DateTime, options: ObserverVectorElementsOptions = DEFAULT_OVE_OPTIONS) {
	const parameters = structuredClone(DEFAULT_ELEMENTS_PARAMETERS) as HorizonsQueryParameters
	makeParametersFromInput(parameters, input)
	makeParametersFromCenterAndCoordinates(parameters, center, undefined, options)
	makeParametersFromStartAndStopTime(parameters, startTime, endTime)
	makeParametersFromOptions(parameters, options)
	parameters.CSV_FORMAT = 'YES'
	const response = await makeRequestAndGetResponse(parameters, 'text')
	return parseCsvTable(await response.text(), options)
}

export async function spkFile(id: number, startTime: DateTime, endTime: DateTime) {
	const parameters = structuredClone(DEFAULT_SPK_PARAMETERS) as HorizonsQueryParameters
	parameters.COMMAND = `DES=${id};`
	makeParametersFromStartAndStopTime(parameters, startTime, endTime)
	const response = await makeRequestAndGetResponse(parameters, 'json')
	return (await response.json()) as SpkFile
}

function makeParametersFromInput(parameters: HorizonsQueryParameters, input: string | ObserverWithOsculatingElements | ObserverWithTLE) {
	// Ephemeris
	if (typeof input === 'string') {
		parameters.COMMAND = input
	}
	// Osculating elements
	else if ('epoch' in input) {
		parameters.COMMAND = ';'
		parameters.EPOCH = input.epoch
		parameters.ECLIP = input.referenceEclipticFrame || 'J2000'
		parameters.EC = input.ec
		parameters.OM = toDeg(input.om)
		parameters.W = toDeg(input.w)
		parameters.IN = toDeg(input.i)
		parameters.H = input.h
		parameters.G = input.g

		const tpqr = input.tpqr

		if ('a' in tpqr) {
			parameters.MA = toDeg(tpqr.ma)
			parameters.A = tpqr.a
		} else if ('tp' in tpqr) {
			parameters.QR = tpqr.qr
			parameters.TP = tpqr.tp
		} else {
			parameters.MA = toDeg(tpqr.ma)
			parameters.N = toDeg(tpqr.n)
		}

		parameters.H = input.h
		parameters.G = input.g
		parameters.M1 = input.m1
		parameters.M2 = input.m2
		parameters.K1 = input.k1
		parameters.K2 = input.k2
		parameters.PHCOF = input.phcof
		parameters.A1 = input.a1
		parameters.A2 = input.a2
		parameters.A3 = input.a3
		parameters.R0 = input.r0
		parameters.ALN = input.aln
		parameters.NM = input.nm
		parameters.NN = input.nn
		parameters.NK = input.nk
		parameters.DT = input.dt
		parameters.AMRAT = input.amrat
	}
	// TLE
	else {
		parameters.COMMAND = 'TLE'
		parameters.TLE = `${input.line1}\n${input.line2}\n${input.line3}`
	}
}

// https://ssd.jpl.nasa.gov/horizons/manual.html#time
function makeParametersFromStartAndStopTime(parameters: HorizonsQueryParameters, startTime: DateTime, endTime: DateTime) {
	parameters.START_TIME = startTime.format(DATE_TIME_FORMAT)
	parameters.STOP_TIME = endTime.format(DATE_TIME_FORMAT)
}

function makeParametersFromCenterAndCoordinates(parameters: HorizonsQueryParameters, center: ObserverSiteCenter, coord?: ObserverSiteCoord, options?: ObserverVectorElementsOptions) {
	parameters.CENTER = center

	if (center.startsWith('coord')) {
		parameters.SITE_COORD = !coord ? '0,0,0' : typeof coord === 'string' ? coord : `${toDeg(coord[0])},${toDeg(coord[1])},${toKilometer(coord[2])}`
		parameters.COORD_TYPE = options?.coordinateType || 'GEODETIC'
	}
}

function makeParametersFromOptions(parameters: HorizonsQueryParameters, options?: ObserverVectorElementsOptions) {
	if (options && parameters.EPHEM_TYPE !== 'SPK') {
		const isObserver = parameters.EPHEM_TYPE === 'OBSERVER'
		const isVector = parameters.EPHEM_TYPE === 'VECTOR'
		const isElements = parameters.EPHEM_TYPE === 'ELEMENTS'

		parameters.REF_SYSTEM = options.referenceSystem || DEFAULT_OVE_OPTIONS.referenceSystem
		if (!isObserver) parameters.REF_PLANE = options.referencePlane || parameters.REF_PLANE || DEFAULT_OVE_OPTIONS.referencePlane
		if (isObserver) parameters.CAL_FORMAT = options.calendarFormat || DEFAULT_OVE_OPTIONS.calendarFormat
		parameters.CAL_TYPE = options.calendarType || DEFAULT_OVE_OPTIONS.calendarType
		if (isObserver) parameters.APPARENT = (options.refractionCorrection ?? DEFAULT_OVE_OPTIONS.refractionCorrection) ? 'REFRACTED' : 'AIRLESS'
		if (isObserver) parameters.EXTRA_PREC = (options.extraPrecision ?? DEFAULT_OVE_OPTIONS.extraPrecision) ? 'YES' : 'NO'
		parameters.TIME_DIGITS = options.timeDigitsPrecision || DEFAULT_OVE_OPTIONS.timeDigitsPrecision
		if (isObserver) parameters.ANG_FORMAT = options.angleFormat || DEFAULT_OVE_OPTIONS.angleFormat
		if (isObserver) parameters.RANGE_UNITS = options.rangeUnits || DEFAULT_OVE_OPTIONS.rangeUnits
		if (isObserver) parameters.SUPPRESS_RANGE_RATE = (options.suppressRangeRate ?? DEFAULT_OVE_OPTIONS.suppressRangeRate) ? 'YES' : 'NO'
		if (isObserver) parameters.SKIP_DAYLT = (options.skipDaylight ?? DEFAULT_OVE_OPTIONS.skipDaylight) ? 'YES' : 'NO'
		if (!isObserver) parameters.OUT_UNITS = options.outputUnits ?? DEFAULT_OVE_OPTIONS.outputUnits
		if (isVector) parameters.VEC_TABLE = '2' // State vector (x, y, z, vx, vy, vz)
		if (isVector) parameters.VEC_CORR = options.vectorCorrection || DEFAULT_OVE_OPTIONS.vectorCorrection
		if (isObserver) parameters.TIME_ZONE = typeof options.timeZone === 'number' ? formatTimeZone(options.timeZone) : options.timeZone
		if (isElements) parameters.TP_TYPE = options.timeOfPeriapsisType || DEFAULT_OVE_OPTIONS.timeOfPeriapsisType
		if (options.stepSize) parameters.STEP_SIZE = formatStepSize(options.stepSize, options.stepSizeUnit)
	}
}

function makeParametersFromQuantities(parameters: HorizonsQueryParameters, quantities?: Quantity[]) {
	if (quantities?.length && parameters.EPHEM_TYPE === 'OBSERVER') {
		parameters.QUANTITIES = quantities.join(',')
	}
}

function formatQueryParameterValue(value: unknown) {
	return `'${encodeURIComponent(`${value}`)}'`
}

function makeQueryFromParameters(parameters: HorizonsQueryParameters) {
	return Object.entries(parameters)
		.filter((e) => e[1] !== undefined && e[1] !== null && e[1] !== '')
		.map(([key, value]) => `${key}=${formatQueryParameterValue(value)}`)
		.join('&')
}

// https://ssd-api.jpl.nasa.gov/doc/horizons.html#stepping
function formatStepSize(stepSize: number = DEFAULT_OVE_OPTIONS.stepSize, unit: StepSizeUnit = DEFAULT_OVE_OPTIONS.stepSizeUnit) {
	return unit === 'unitless' ? stepSize.toFixed(0) : `${stepSize.toFixed(0)} ${unit}`
}

function formatTimeZone(minutes: number) {
	const sign = minutes >= 0 ? '+' : '-'
	const m = Math.abs(minutes)
	const h = Math.floor(m / 60)
	return `${sign}${h.toFixed(0).padStart(2, '0')}:${(m % 60).toFixed(0).padStart(2, '0')}`
}

function makeRequestAndGetResponse(parameters: HorizonsQueryParameters, format: OutputFormat) {
	const query = makeQueryFromParameters(parameters)
	return fetch(`${HORIZONS_BASE_URL}?format=${format}&${query}`)
}

const START_TABLE_PREFIX = '$$SOE'
const END_TABLE_PREFIX = '$$EOE'

function parseCsvTable(text: string, options: ObserverVectorElementsOptions) {
	const lines = text.split('\n')
	const start = lines.findIndex((e) => e.startsWith(START_TABLE_PREFIX))

	if (start >= 3) lines.splice(0, start - 2)
	else return []

	const end = lines.findLastIndex((e) => e.startsWith(END_TABLE_PREFIX))

	if (end > 0) lines.splice(end, lines.length - end)
	else return []

	lines.splice(1, 2)

	return lines.length <= 1 ? [] : readCsv(lines, options)
}

const DEFAULT_COMMON_PARAMETERS: HorizonsCommonParameters = {
	MAKE_EPHEM: 'YES',
	OBJ_DATA: 'NO',
}

const DEFAULT_OBSERVER_PARAMETERS: HorizonsCommonParameters = {
	...DEFAULT_COMMON_PARAMETERS,
	EPHEM_TYPE: 'OBSERVER',
}

const DEFAULT_VECTOR_PARAMETERS: HorizonsCommonParameters = {
	...DEFAULT_COMMON_PARAMETERS,
	EPHEM_TYPE: 'VECTOR',
}

const DEFAULT_ELEMENTS_PARAMETERS: HorizonsEphemerisSpecificParameters = {
	...DEFAULT_COMMON_PARAMETERS,
	EPHEM_TYPE: 'ELEMENTS',
	REF_PLANE: 'ECLIPTIC',
}

const DEFAULT_SPK_PARAMETERS: HorizonsCommonParameters = {
	EPHEM_TYPE: 'SPK',
}
