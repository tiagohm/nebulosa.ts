import { type Angle, toDeg } from './angle'
import type { CsvTable } from './csv'
import { type DateTime, formatDate } from './datetime'
import { type Distance, toKilometer } from './distance'

// https://ssd.jpl.nasa.gov/horizons/manual.html

export const BASE_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api'

export const OBSERVER_QUERY = "format=text&MAKE_EPHEM=YES&EPHEM_TYPE=OBSERVER&COORD_TYPE=GEODETIC&REF_SYSTEM='ICRF'&CAL_FORMAT='CAL'&TIME_DIGITS='MINUTES'&ANG_FORMAT='DEG'&RANGE_UNITS='AU'&SUPPRESS_RANGE_RATE='YES'&SKIP_DAYLT='NO'&SOLAR_ELONG='0,180'&OBJ_DATA='NO'&CSV_FORMAT='YES'&ELEV_CUT='-90'"
export const OBSERVER_OSCULATING_QUERY =
	"format=text&COMMAND='%3B'&ECLIP='J2000'&MAKE_EPHEM=YES&EPHEM_TYPE=OBSERVER&CENTER='coord@399'&COORD_TYPE=GEODETIC&REF_SYSTEM='ICRF'&CAL_FORMAT='CAL'&TIME_DIGITS='MINUTES'&ANG_FORMAT='DEG'&RANGE_UNITS='AU'&SUPPRESS_RANGE_RATE='YES'&SKIP_DAYLT='NO'&SOLAR_ELONG='0,180'&OBJ_DATA='NO'&CSV_FORMAT='YES'&ELEV_CUT='-90'"
export const OBSERVER_TLE_QUERY =
	"format=text&COMMAND='TLE'&MAKE_EPHEM=YES&EPHEM_TYPE=OBSERVER&CENTER='coord@399'&COORD_TYPE=GEODETIC&REF_SYSTEM='ICRF'&CAL_FORMAT='CAL'&TIME_DIGITS='MINUTES'&ANG_FORMAT='DEG'&RANGE_UNITS='AU'&SUPPRESS_RANGE_RATE='YES'&SKIP_DAYLT='NO'&SOLAR_ELONG='0,180'&OBJ_DATA='NO'&CSV_FORMAT='YES'&ELEV_CUT='-90'"
export const SPK_QUERY = 'format=json&EPHEM_TYPE=SPK&OBJ_DATA=NO'

export type ApparentRefractionCorrection = 'AIRLESS' | 'REFRACTED'

export type ObserverSiteCenter = `geo@${number}` | `coord@${number}` | 'coord' | `${number}@${number}`

export type ObserverSiteCoord = readonly [Angle, Angle, Distance] | `${number},${number},${number}` | 0 | false | undefined

export interface ObserverOptions {
	stepSizeInMinutes?: number
	apparent?: ApparentRefractionCorrection
	extraPrecision?: boolean
}

export interface PerihelionDistanceAndTime {
	qr: Distance // perihelionDistance
	tp: number // perihelionTime in TDB
}

export interface MeanAnomalyAndSemiMajorAxis {
	ma: Angle // meanAnomaly
	a: Distance // semiMajorAxis
}

export interface MeanAnomalyAnMeanMotion {
	ma: Angle // meanAnomaly
	n: Angle // meanMotion in rad/day
}

export interface ObserverWithOsculatingElementsParameters {
	epoch: number
	ec: Angle // eccentricity
	pdt: PerihelionDistanceAndTime | MeanAnomalyAndSemiMajorAxis | MeanAnomalyAnMeanMotion
	om: Angle // longitudeOfAscendingNode
	w: Angle // argumentOfPerihelion
	i: Angle // inclination
	h?: number // absoluteMagnitude
	g?: number // magnitudeSlope
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

const DEFAULT_OBSERVER_OPTIONS: Required<ObserverOptions> = {
	stepSizeInMinutes: 1,
	apparent: 'REFRACTED',
	extraPrecision: false,
}

export async function observer(command: string, center: ObserverSiteCenter, coord: ObserverSiteCoord, startTime: DateTime, endTime: DateTime, quantities?: Quantity[], options?: ObserverOptions) {
	if (!quantities?.length) quantities = DEFAULT_QUANTITIES
	const siteCoord = !coord ? '0,0,0' : typeof coord === 'string' ? coord : `${toDeg(coord[0])},${toDeg(coord[1])},${toKilometer(coord[2])}`
	const stepSizeInMinutes = options?.stepSizeInMinutes ?? DEFAULT_OBSERVER_OPTIONS.stepSizeInMinutes
	const apparent = options?.apparent ?? DEFAULT_OBSERVER_OPTIONS.apparent
	const extraPrecision = options?.extraPrecision ?? DEFAULT_OBSERVER_OPTIONS.extraPrecision
	const query = `?${OBSERVER_QUERY}&COMMAND='${encodeURIComponent(command)}'&CENTER='${center}'&SITE_COORD='${siteCoord}'&START_TIME='${formatTime(startTime)}'&STOP_TIME='${formatTime(endTime)}'&STEP_SIZE='${stepSizeInMinutes}m'&APPARENT='${apparent}'&EXTRA_PREC='${extraPrecision ? 'YES' : 'NO'}'&QUANTITIES='${quantities.join(',')}'`
	const response = await fetch(`${BASE_URL}${query}`)
	const text = await response.text()
	return parseTable(text)
}

export async function observerWithOsculatingElements(parameters: ObserverWithOsculatingElementsParameters, coord: ObserverSiteCoord, startTime: DateTime, endTime: DateTime, quantities?: Quantity[], options?: ObserverOptions) {
	if (!quantities?.length) quantities = DEFAULT_QUANTITIES
	const siteCoord = !coord ? '0,0,0' : typeof coord === 'string' ? coord : `${toDeg(coord[0])},${toDeg(coord[1])},${toKilometer(coord[2])}`
	const stepSizeInMinutes = options?.stepSizeInMinutes ?? DEFAULT_OBSERVER_OPTIONS.stepSizeInMinutes
	const apparent = options?.apparent ?? DEFAULT_OBSERVER_OPTIONS.apparent
	const extraPrecision = options?.extraPrecision ?? DEFAULT_OBSERVER_OPTIONS.extraPrecision
	const { epoch, pdt, ec, om, w, i, h, g } = parameters
	const tpqr = 'a' in pdt ? `&MA='${toDeg(pdt.ma)}'&A='${pdt.a}'` : 'tp' in pdt ? `&QR='${pdt.qr}'&TP='${pdt.tp}'` : `&MA='${toDeg(pdt.ma)}'&N='${toDeg(pdt.n)}'`
	const query = `?${OBSERVER_OSCULATING_QUERY}&EPOCH='${epoch}'${tpqr}&EC='${ec}'&OM='${toDeg(om)}'&W='${toDeg(w)}'&IN='${toDeg(i)}'${h ? `&H='${h}'` : ''}${g ? `&G='${g}'` : ''}&SITE_COORD='${siteCoord}'&START_TIME='${formatTime(startTime)}'&STOP_TIME='${formatTime(endTime)}'&STEP_SIZE='${stepSizeInMinutes}m'&APPARENT='${apparent}'&EXTRA_PREC='${extraPrecision ? 'YES' : 'NO'}'&QUANTITIES='${quantities.join(',')}'`
	const response = await fetch(`${BASE_URL}${query}`)
	const text = await response.text()
	return parseTable(text)
}

export async function observerWithTle(tle: string, coord: ObserverSiteCoord, startTime: DateTime, endTime: DateTime, quantities?: Quantity[], options?: ObserverOptions) {
	if (!quantities?.length) quantities = DEFAULT_QUANTITIES
	const siteCoord = !coord ? '0,0,0' : typeof coord === 'string' ? coord : `${toDeg(coord[0])},${toDeg(coord[1])},${toKilometer(coord[2])}`
	const stepSizeInMinutes = options?.stepSizeInMinutes ?? DEFAULT_OBSERVER_OPTIONS.stepSizeInMinutes
	const apparent = options?.apparent ?? DEFAULT_OBSERVER_OPTIONS.apparent
	const extraPrecision = options?.extraPrecision ?? DEFAULT_OBSERVER_OPTIONS.extraPrecision
	const query = `?${OBSERVER_TLE_QUERY}&TLE='${encodeURIComponent(tle)}'&SITE_COORD='${siteCoord}'&START_TIME='${formatTime(startTime)}'&STOP_TIME='${formatTime(endTime)}'&STEP_SIZE='${stepSizeInMinutes}m'&APPARENT='${apparent}'&EXTRA_PREC='${extraPrecision ? 'YES' : 'NO'}'&QUANTITIES='${quantities.join(',')}'`
	const response = await fetch(`${BASE_URL}${query}`)
	const text = await response.text()
	return parseTable(text)
}

export async function spkFile(id: number, startTime: DateTime, endTime: DateTime) {
	const query = `?${SPK_QUERY}&COMMAND='DES%3D${id}%3B'&START_TIME='${formatTime(startTime)}'&STOP_TIME='${formatTime(endTime)}'`
	const response = await fetch(`${BASE_URL}${query}`)
	return (await response.json()) as SpkFile
}

function parseTable(text: string): CsvTable | undefined {
	const lines = text.split('\n')
	const startIdx = lines.findIndex((e) => e.startsWith('$$SOE')) + 1
	const endIdx = lines.findLastIndex((e) => e.startsWith('$$EOE')) - 1

	if (startIdx > 3 && endIdx > startIdx) {
		const headers = lines[startIdx - 3].split(',').map((e) => e.trim())
		const indexes = headers.map((_, i) => i).filter((e) => !!headers[e].length)
		const data = new Array<string[]>(endIdx - startIdx + 1)

		for (let i = startIdx, k = 0; i <= endIdx; i++, k++) {
			const parts = lines[i].split(',')
			const item = new Array<string>(indexes.length)
			indexes.forEach((e, m) => (item[m] = parts[e].trim()))
			data[k] = item
		}

		return { header: indexes.map((e) => headers[e]), data }
	}

	return undefined
}

function formatTime(date: DateTime) {
	return formatDate(date, 'YYYY-MM-DD HH:mm')
}
