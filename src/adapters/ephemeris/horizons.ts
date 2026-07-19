import { formatTemporal, temporalGet, type Temporal } from '../../astronomy/time/temporal'
import { toJulianDay, type Time } from '../../astronomy/time/time'
import { type ReadCsvOptions, readCsv } from '../../io/csv'
import { type Angle, toDeg } from '../../math/units/angle'
import { type Distance, toKilometer } from '../../math/units/distance'

// Client for the JPL Horizons ephemeris API: builds and submits observer, vector, osculating-element,
// and SPK-file requests for a named target or user-supplied osculating elements / TLE, and parses the
// returned CSV ephemeris table. The interfaces mirror the Horizons query parameters (most properties
// carry the manual's per-parameter notes inline). Angles are radians on the public surface and
// formatted into the API's degree/HMS conventions in the request.

// https://ssd.jpl.nasa.gov/horizons/manual.html
// https://ssd-api.jpl.nasa.gov/doc/horizons.html

// Horizons API endpoint URL.
export const HORIZONS_BASE_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api'

// Boolean-as-string toggle expected by the API.
export type YesNo = 'NO' | 'YES'

// Response encoding requested from the API.
export type OutputFormat = 'json' | 'text'

// https://ssd.jpl.nasa.gov/horizons/manual.html#center
// Observing-site center code for observer/vector ephemerides.
export type ObserverSiteCenter = `coord@${number}` | 'coord' | `${string}@${number}` | 'geo' | '@TLE'
// Center body code for element ephemerides.
export type BodyCenter = 'geo' | `500@${number}`

// Observing-site coordinates as [longitude, latitude, elevation], a comma string, or a falsy default.
export type ObserverSiteCoord = readonly [Angle, Angle, Distance] | `${number},${number},${number}` | 0 | false | undefined

// Reference plane for the ephemeris frame.
export type ReferencePlane = 'ECLIPTIC' | 'FRAME' | 'BODY_EQUATOR'

// User coordinate type for the observing site.
export type CoordinateType = 'GEODETIC' | 'CILINDRICAL'

// Kind of ephemeris to generate.
export type EphemerisType = 'OBSERVER' | 'VECTOR' | 'ELEMENTS' | 'SPK'

// Output time precision.
export type TimeDigitPrecision = 'MINUTES' | 'SECONDS' | 'FRACSEC'

// Input/output timescale.
export type TimeType = 'UT' | 'TT' | 'TDB'

// Reference frame for geometric/astrometric quantities.
export type ReferenceSystem = 'ICRF' | 'B1950'

// Reference ecliptic frame of user osculating elements.
export type ReferenceEclipticFrame = 'J2000' | 'B1950'

// Output units for distance and time.
export type OutputUnits = 'KM-S' | 'AU-D' | 'KM-D'

// Light-time/aberration correction level for vector output.
export type VectorCorrection = 'NONE' | 'LT' | 'LT+S'

// Date output format.
export type CalendarFormat = 'CAL' | 'JD' | 'BOTH'

// Calendar system for date input/output.
export type CalendarType = 'GREGORIAN' | 'MIXED'

// RA/Dec output format.
export type AngleFormat = 'HMS' | 'DEG'

// Refraction handling for apparent coordinates.
export type RefractionCorrection = 'AIRLESS' | 'REFRACTED'

// Units for range quantities.
export type RangeUnit = 'AU' | 'KM'

// Whether the returned time of periapsis is absolute or relative.
export type TimeOfPeriapsisType = 'ABSOLUTE' | 'RELATIVE'

// Unit suffix for the ephemeris step size.
export type StepSizeUnit = 'd' | 'm' | 'h' | 'y' | 'mo' | 'days' | 'minutes' | 'hours' | 'years' | 'months' | 'unitless'

// Union of all valid Horizons query parameter keys.
export type HorizonsQueryParameterKey = keyof HorizonsEphemerisSpecificParameters | keyof HorizonsSpkFileParameters | keyof HorizonsHeliocentricEclipticOsculatingElementParameters | keyof HorizonsTLEParameters

// A bag of Horizons query parameters keyed by parameter name.
export type HorizonsQueryParameters = Record<HorizonsQueryParameterKey, unknown>

// High-level options shared by the observer/vector/elements helpers, mapped into Horizons parameters.
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

// Orbit anomaly specified by perihelion distance and time.
export interface PerihelionDistanceAndTime {
	qr: Distance // perihelionDistance
	tp: number // perihelionTime in TDB
}

// Orbit anomaly specified by mean anomaly and semi-major axis.
export interface MeanAnomalyAndSemiMajorAxis {
	ma: Angle // meanAnomaly
	a: Distance // semiMajorAxis
}

// Orbit anomaly specified by mean anomaly and mean motion.
export interface MeanAnomalyAndMeanMotion {
	ma: Angle // meanAnomaly
	n: Angle // meanMotion in rad/day
}

// User-supplied osculating elements (with optional small-body/non-gravitational parameters) to define
// a target instead of a name lookup.
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

// User-supplied two-line element set defining an Earth-satellite target.
export interface ObserverWithTLE {
	line1: string
	line2: string
	name?: string
}

// Horizons query parameters common to every ephemeris type.
export interface HorizonsCommonParameters {
	COMMAND?: string // target search, selection, or enter user-input object mode
	OBJ_DATA?: YesNo // [YES]: toggles return of object summary data
	MAKE_EPHEM?: YesNo // [YES]: toggles generation of ephemeris, if possible
	EPHEM_TYPE?: EphemerisType // [OBSERVER]: specifies type of ephemeris to generate
	START_TIME?: string // specifies ephemeris start time
	STOP_TIME?: string // specifies ephemeris stop time
}

// Horizons query parameters for observer/vector/element ephemeris requests.
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

// Horizons query parameters for an SPK-file request (no extra fields beyond the common ones).
export interface HorizonsSpkFileParameters extends HorizonsCommonParameters {}

// Heliocentric ecliptic osculating-element parameters, supplied directly when COMMAND=';'.
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

// Horizons query parameters carrying a user-supplied TLE block.
export interface HorizonsTLEParameters extends HorizonsCommonParameters {
	TLE: string // must be supplied in standard format with starting and ending quote marks enclosing the entire block and encoding new-line and spaces
}

// Result of an SPK-file request: the base64 SPK content or an error message.
export interface SpkFile {
	readonly spk?: string
	readonly error?: string
}

// Observer-table output quantity codes (the QUANTITIES parameter); each selects one column group.
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

// Default observer-table quantities requested when the caller does not specify any.
const DEFAULT_QUANTITIES: Quantity[] = [1, 9, 20, 23, 24, 47, 48]

// Default observer/vector/elements options.
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

// Requests an observer-table ephemeris (apparent/astrometric quantities) for `input` (a target name,
// osculating elements, or TLE) over [startTime, endTime] and returns the parsed CSV rows.
export async function observer(input: string | ObserverWithOsculatingElements | ObserverWithTLE, center: ObserverSiteCenter, coord: ObserverSiteCoord, startTime: Temporal | Time, endTime: Temporal | Time, quantities: Quantity[] = DEFAULT_QUANTITIES, options: ObserverVectorElementsOptions = DEFAULT_OVE_OPTIONS) {
	const parameters = structuredClone(DEFAULT_OBSERVER_PARAMETERS) as HorizonsQueryParameters
	makeParametersFromInput(parameters, input)
	makeParametersFromCenterAndCoordinates(parameters, center, coord, options)
	makeParametersFromStartAndStopTime(parameters, startTime, endTime)
	makeParametersFromQuantities(parameters, quantities)
	makeParametersFromOptions(parameters, options)
	parameters.CSV_FORMAT = 'YES'
	return await makeRequestAndGetResponseWithRetry(input, startTime, parameters, options)
}

// Requests a state-vector ephemeris for `input` over [startTime, endTime] and returns the parsed CSV rows.
export async function vector(input: string | ObserverWithOsculatingElements | ObserverWithTLE, center: ObserverSiteCenter, coord: ObserverSiteCoord, startTime: Temporal | Time, endTime: Temporal | Time, options: ObserverVectorElementsOptions = DEFAULT_OVE_OPTIONS) {
	const parameters = structuredClone(DEFAULT_VECTOR_PARAMETERS) as HorizonsQueryParameters
	makeParametersFromInput(parameters, input)
	makeParametersFromCenterAndCoordinates(parameters, center, coord, options)
	makeParametersFromStartAndStopTime(parameters, startTime, endTime)
	makeParametersFromOptions(parameters, options)
	parameters.CSV_FORMAT = 'YES'
	const response = await makeRequestAndGetResponse(parameters, 'text')
	const identification = identifyTable(await response.text())
	if (identification?.kind === 'ephemeris') return parseEphemerisTable(identification, options)
	return await makeRequestAndGetResponseWithRetry(input, startTime, parameters, options)
}

// Requests an osculating-elements ephemeris for `input` over [startTime, endTime] and returns the parsed CSV rows.
export async function elements(input: string | ObserverWithOsculatingElements | ObserverWithTLE, center: BodyCenter, startTime: Temporal | Time, endTime: Temporal | Time, options: ObserverVectorElementsOptions = DEFAULT_OVE_OPTIONS) {
	const parameters = structuredClone(DEFAULT_ELEMENTS_PARAMETERS) as HorizonsQueryParameters
	makeParametersFromInput(parameters, input)
	makeParametersFromCenterAndCoordinates(parameters, center, undefined, options)
	makeParametersFromStartAndStopTime(parameters, startTime, endTime)
	makeParametersFromOptions(parameters, options)
	parameters.CSV_FORMAT = 'YES'
	return await makeRequestAndGetResponseWithRetry(input, startTime, parameters, options)
}

// Requests an SPK binary kernel for the small body designation `id` over [startTime, endTime].
export async function spkFile(id: number, startTime: Temporal | Time, endTime: Temporal | Time) {
	const parameters = structuredClone(DEFAULT_SPK_PARAMETERS) as HorizonsQueryParameters
	parameters.COMMAND = `DES=${id};`
	makeParametersFromStartAndStopTime(parameters, startTime, endTime)
	const response = await makeRequestAndGetResponse(parameters, 'json')
	return (await response.json()) as SpkFile
}

async function makeRequestAndGetResponseWithRetry(input: string | ObserverWithOsculatingElements | ObserverWithTLE, time: Temporal | Time, parameters: HorizonsQueryParameters, options: ObserverVectorElementsOptions) {
	const response = await makeRequestAndGetResponse(parameters, 'text')
	const identification = identifyTable(await response.text())

	if (identification?.kind === 'ephemeris') return parseEphemerisTable(identification, options)
	else if (typeof input === 'string' && identification?.kind === 'smallBodyMatch') {
		const retryPlan = analyzeSmallBodyMatches(identification.matches)

		if (retryPlan !== undefined) {
			if (retryPlan.useNoFrag && !input.includes(';NOFRAG')) input += 'NOFRAG;'
			if (retryPlan.useCap && !input.includes(';CAP')) {
				if (typeof time === 'number') input += `CAP<${temporalGet(time, 'y')};`
				else input += `CAP<${toJulianDay(time).toFixed(1)};`
			}
			makeParametersFromInput(parameters, input)
			const response = await makeRequestAndGetResponse(parameters, 'text')
			const identification = identifyTable(await response.text())
			if (identification?.kind === 'ephemeris') return parseEphemerisTable(identification, options)
		}
	}

	return []
}

// Sets the COMMAND/target parameters from a target name, TLE, or osculating-element input.
function makeParametersFromInput(parameters: HorizonsQueryParameters, input: string | ObserverWithOsculatingElements | ObserverWithTLE) {
	// Ephemeris
	if (typeof input === 'string') {
		parameters.COMMAND = input
	}
	// TLE
	else if ('line1' in input) {
		parameters.COMMAND = 'TLE'
		parameters.TLE = `${input.name ? `${input.name}\n` : ''}${input.line1}\n${input.line2}`
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
}

// https://ssd.jpl.nasa.gov/horizons/manual.html#time
function makeParametersFromStartAndStopTime(parameters: HorizonsQueryParameters, startTime: Temporal | Time, endTime: Temporal | Time) {
	if (typeof startTime === 'number') {
		parameters.START_TIME = formatTemporal(startTime, undefined, 0)
	} else {
		parameters.START_TIME = `JD ${startTime.day + startTime.fraction}`
	}

	if (typeof endTime === 'number') {
		parameters.STOP_TIME = formatTemporal(endTime, undefined, 0)
	} else {
		parameters.STOP_TIME = `JD ${endTime.day + endTime.fraction}`
	}
}

// Sets the CENTER and, for coordinate centers, the SITE_COORD/COORD_TYPE parameters.
function makeParametersFromCenterAndCoordinates(parameters: HorizonsQueryParameters, center: ObserverSiteCenter, coord?: ObserverSiteCoord, options?: ObserverVectorElementsOptions) {
	parameters.CENTER = center

	if (center.startsWith('coord')) {
		parameters.SITE_COORD = !coord ? '0,0,0' : typeof coord === 'string' ? coord : `${toDeg(coord[0])},${toDeg(coord[1])},${toKilometer(coord[2])}`
		parameters.COORD_TYPE = options?.coordinateType || 'GEODETIC'
	}
}

// Maps the high-level options onto the per-ephemeris-type Horizons output parameters.
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

// Sets the QUANTITIES parameter for observer ephemerides from the requested quantity codes.
function makeParametersFromQuantities(parameters: HorizonsQueryParameters, quantities?: Quantity[]) {
	if (quantities?.length && parameters.EPHEM_TYPE === 'OBSERVER') {
		parameters.QUANTITIES = quantities.join(',')
	}
}

// URL-encodes and single-quotes one parameter value as Horizons expects.
function formatQueryParameterValue(value: unknown) {
	return `'${encodeURIComponent(`${value}`)}'`
}

// Joins the defined parameters into a Horizons query string, dropping empty/undefined values.
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

// Formats a UTC offset in minutes as a "+HH:MM" / "-HH:MM" time-zone string.
function formatTimeZone(minutes: number) {
	const sign = minutes >= 0 ? '+' : '-'
	const m = Math.abs(minutes)
	const h = Math.floor(m / 60)
	return `${sign}${h.toFixed(0).padStart(2, '0')}:${(m % 60).toFixed(0).padStart(2, '0')}`
}

// Builds the request URL from the parameters and fetches the response in the given format.
function makeRequestAndGetResponse(parameters: HorizonsQueryParameters, format: OutputFormat) {
	const query = makeQueryFromParameters(parameters)
	return fetch(`${HORIZONS_BASE_URL}?format=${format}&${query}`)
}

// Marker line beginning the ephemeris data block in the text response.
const START_TABLE_PREFIX = '$$SOE'
// Marker line ending the ephemeris data block.
const END_TABLE_PREFIX = '$$EOE'

interface EphemerisTable {
	readonly kind: 'ephemeris'
	// start and end index of ephemeris data block prefixes.
	readonly startIndex: number
	readonly endIndex: number
	readonly lines: string[]
}

interface SmallBodyMatch {
	readonly record: number
	readonly epochYear?: number
	readonly matchDesignation: string
	readonly primaryDesignation: string
	readonly name: string
}

interface SmallBodyMatchTable {
	readonly kind: 'smallBodyMatch'
	readonly matches: readonly SmallBodyMatch[]
}

function identifyTable(text: string): EphemerisTable | SmallBodyMatchTable | undefined {
	const lines = text.split('\n')

	// Ephemeris start/end blocks
	const startIndex = lines.findIndex((e) => e.startsWith(START_TABLE_PREFIX))
	const endIndex = lines.findLastIndex((e) => e.startsWith(END_TABLE_PREFIX))

	if (startIndex >= 0 && endIndex > startIndex) {
		if (startIndex >= 3) {
			const content = lines.slice(startIndex + 1, endIndex)
			content.splice(0, 0, lines[startIndex - 2]) // Add the header line
			return { kind: 'ephemeris', startIndex, endIndex, lines: content } as const
		}
	} else if (lines.some((e) => e.includes('Small-body Index Search Results')) && !lines.some((e) => e.includes('No matches found'))) {
		const headerIndex = lines.findIndex((line) => line.includes('Record #') && line.includes('Epoch-yr') && line.includes('>MATCH DESIG<') && line.includes('Primary Desig') && line.includes('Name'))

		if (headerIndex >= 0) {
			const header = lines[headerIndex].trim()
			const recordStart = header.indexOf('Record #')
			const epochStart = header.indexOf('Epoch-yr')
			const matchStart = header.indexOf('>MATCH DESIG<')
			const primaryStart = header.indexOf('Primary Desig')
			const nameStart = header.indexOf('Name', primaryStart + 13)
			const matches: SmallBodyMatch[] = []

			if (recordStart >= 0 && epochStart > recordStart && matchStart > recordStart && primaryStart > recordStart && nameStart > primaryStart) {
				for (let i = headerIndex + 2; i < lines.length; i++) {
					const line = lines[i].trim()

					if (line.length === 0) continue

					const footer = line.includes(' matches')

					if (footer) break

					const recordText = line.slice(recordStart, epochStart).trim()
					const epochText = line.slice(epochStart, matchStart).trim()
					const matchDesignation = line.slice(matchStart, primaryStart).trim()
					const primaryDesignation = line.slice(primaryStart, nameStart).trim()
					const name = line.slice(nameStart).trim()

					matches.push({
						record: Math.trunc(Number(recordText)),
						epochYear: Math.trunc(Number(epochText)) || undefined,
						matchDesignation,
						primaryDesignation,
						name,
					})
				}

				return { kind: 'smallBodyMatch', matches }
			}
		}
	}
}

interface HorizonsRetryPlan {
	readonly reason: 'multipleApparitions' | 'fragments' | 'fragmentsAndMultipleApparitions'
	readonly useCap: boolean
	readonly useNoFrag: boolean
	readonly parentDesignation: string
}

function analyzeSmallBodyMatches(matches: readonly SmallBodyMatch[]): HorizonsRetryPlan | undefined {
	const groups = groupByPrimaryDesignation(matches)
	const designations = [...groups.keys()]

	if (designations.length === 1) {
		const designation = designations[0]
		const group = groups.get(designation)!

		if (group.length > 1 && isCometDesignation(designation)) {
			return { reason: 'multipleApparitions', useCap: true, useNoFrag: false, parentDesignation: designation }
		}

		return undefined
	}

	const familyCandidates = designations
		.map((parent) => {
			const members = designations.filter((candidate) => candidate === parent || isFragmentOf(candidate, parent))
			return { parent, members }
		})
		.filter((family) => family.members.length > 1 && family.members.length === designations.length && isCometDesignation(family.parent))

	if (familyCandidates.length !== 1) {
		return undefined
	}

	const family = familyCandidates[0]
	const parentMatches = groups.get(family.parent)!

	const multipleParentApparitions = parentMatches.length > 1

	return {
		reason: multipleParentApparitions ? 'fragmentsAndMultipleApparitions' : 'fragments',
		useCap: multipleParentApparitions,
		useNoFrag: true,
		parentDesignation: family.parent,
	}
}

function canonicalDesignation(value: string) {
	return value.trim().replaceAll(/\s+/g, ' ').toUpperCase()
}

function isCometDesignation(value: string) {
	const designation = canonicalDesignation(value)

	// 1P, 10P, 3D, 73P-B, 73P-BB...
	if (/^\d+[PD](?:-[A-Z0-9]+)?$/.test(designation)) {
		return true
	}

	// C/2023 A3, P/2010 A2, D/1993 F2-C...
	if (/^[PCDX]\/\d{4}\s+[A-Z]\d+(?:-[A-Z0-9]+)?$/.test(designation)) {
		return true
	}

	return false
}

function isFragmentOf(candidate: string, parent: string): boolean {
	const normalizedCandidate = canonicalDesignation(candidate)
	const normalizedParent = canonicalDesignation(parent)
	return normalizedCandidate.startsWith(`${normalizedParent}-`)
}

function groupByPrimaryDesignation(matches: readonly SmallBodyMatch[]) {
	const groups = new Map<string, SmallBodyMatch[]>()

	for (const match of matches) {
		const designation = canonicalDesignation(match.primaryDesignation)
		const group = groups.get(designation)

		if (group) {
			group.push(match)
		} else {
			groups.set(designation, [match])
		}
	}

	return groups
}

// Extracts the CSV rows between the $$SOE/$$EOE markers (with their header) from a Horizons text response.
function parseEphemerisTable(table: EphemerisTable, options: ObserverVectorElementsOptions) {
	return readCsv(table.lines, options)
}

// Base parameters shared by every request (generate ephemeris, no object summary).
const DEFAULT_COMMON_PARAMETERS: HorizonsCommonParameters = {
	MAKE_EPHEM: 'YES',
	OBJ_DATA: 'NO',
}

// Default parameters for an observer-table request.
const DEFAULT_OBSERVER_PARAMETERS: HorizonsCommonParameters = {
	...DEFAULT_COMMON_PARAMETERS,
	EPHEM_TYPE: 'OBSERVER',
}

// Default parameters for a state-vector request.
const DEFAULT_VECTOR_PARAMETERS: HorizonsCommonParameters = {
	...DEFAULT_COMMON_PARAMETERS,
	EPHEM_TYPE: 'VECTOR',
}

// Default parameters for an osculating-elements request (ecliptic reference plane).
const DEFAULT_ELEMENTS_PARAMETERS: HorizonsEphemerisSpecificParameters = {
	...DEFAULT_COMMON_PARAMETERS,
	EPHEM_TYPE: 'ELEMENTS',
	REF_PLANE: 'ECLIPTIC',
}

// Default parameters for an SPK-file request.
const DEFAULT_SPK_PARAMETERS: HorizonsCommonParameters = {
	EPHEM_TYPE: 'SPK',
}
