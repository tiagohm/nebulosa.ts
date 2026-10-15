import { describe, expect, test } from 'bun:test'
import { CDMParseError, type CDMParseErrorCode, parseCDM } from '../../../src/astronomy/orbits/cdm'
import { Timescale, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { AU_KM, AU_M, DAYSEC } from '../../../src/core/constants'
import { toMeter } from '../../../src/math/units/distance'

// CCSDS 508.0-B-1 section 3.6.2 example CDM (obligatory keywords only), transcribed from the Blue Book
// (June 2013 with Cor. 2, October 2021). The two state vectors reproduce MISS_DISTANCE = 715 m and the
// optional-example RELATIVE_SPEED = 14762 m/s, so the example is geometrically self-consistent.
const CDM_EXAMPLE = await Bun.file('data/cdm.kvn').text()

// Replaces the n-th (0-based) line starting with `keyword` by `replacement` lines (none removes it).
function replaceLine(text: string, keyword: string, replacement: readonly string[], occurrence: number = 0) {
	const lines = text.split('\n')
	let seen = -1
	const index = lines.findIndex((line) => new RegExp(`^${keyword}\\s*=`).test(line) && ++seen === occurrence)
	if (index < 0) throw new Error(`no ${keyword}`)
	lines.splice(index, 1, ...replacement)
	return lines.join('\n')
}

// Inserts lines after the n-th (0-based) line starting with `keyword`.
function insertAfter(text: string, keyword: string, insertion: readonly string[], occurrence: number = 0) {
	const lines = text.split('\n')
	let seen = -1
	const index = lines.findIndex((line) => new RegExp(`^${keyword}\\s*=`).test(line) && ++seen === occurrence)
	if (index < 0) throw new Error(`no ${keyword}`)
	lines.splice(index + 1, 0, ...insertion)
	return lines.join('\n')
}

// Asserts that parsing fails with the given code (and keyword, when given).
function expectRejected(text: string, code: CDMParseErrorCode, keyword?: string) {
	try {
		parseCDM(text)
	} catch (e) {
		expect(e).toBeInstanceOf(CDMParseError)
		expect((e as CDMParseError).code).toBe(code)
		if (keyword !== undefined) expect((e as CDMParseError).keyword).toBe(keyword)
		return e as CDMParseError
	}

	throw new Error(`expected a ${code} rejection`)
}

// Rows 7-8 (DRG, SRP) of the Object1 covariance of the CCSDS 508.0-B-1 section 3.6.3 example.
const OBJECT1_DRG_SRP_ROWS = [
	'CDRG_R = -1.862E+00 [m**3/kg]',
	'CDRG_T = 3.530E+00 [m**3/kg]',
	'CDRG_N = -3.100E-01 [m**3/kg]',
	'CDRG_RDOT = -1.214E-04 [m**3/(kg*s)]',
	'CDRG_TDOT = 2.580E-04 [m**3/(kg*s)]',
	'CDRG_NDOT = -6.467E-05 [m**3/(kg*s)]',
	'CDRG_DRG = 3.483E-06 [m**4/kg**2]',
	'CSRP_R = -1.492E+02 [m**3/kg]',
	'CSRP_T = 2.044E+02 [m**3/kg]',
	'CSRP_N = -2.331E+01 [m**3/kg]',
	'CSRP_RDOT = -1.254E-03 [m**3/(kg*s)]',
	'CSRP_TDOT = 2.013E-02 [m**3/(kg*s)]',
	'CSRP_NDOT = -4.700E-03 [m**3/(kg*s)]',
	'CSRP_DRG = 2.210E-04 [m**4/kg**2]',
	'CSRP_SRP = 1.593E-02 [m**4/kg**2]',
]

// The section 3.6.3 example with optional keywords, assembled from its published lines with the two
// published typos (a colon before the milliseconds of the screening times, "TRACKS USED") corrected.
const CDM_OPTIONAL_EXAMPLE = (() => {
	let text = CDM_EXAMPLE
	text = insertAfter(text, 'ORIGINATOR', ['MESSAGE_FOR = SATELLITE A'])
	text = insertAfter(text, 'MESSAGE_ID', ['COMMENT Relative Metadata/Data'])
	text = insertAfter(text, 'MISS_DISTANCE', [
		'RELATIVE_SPEED = 14762 [m/s]',
		'RELATIVE_POSITION_R = 27.4 [m]',
		'RELATIVE_POSITION_T = -70.2 [m]',
		'RELATIVE_POSITION_N = 711.8 [m]',
		'RELATIVE_VELOCITY_R = -7.2 [m/s]',
		'RELATIVE_VELOCITY_T = -14692.0 [m/s]',
		'RELATIVE_VELOCITY_N = -1437.2 [m/s]',
		'START_SCREEN_PERIOD = 2010-03-12T18:29:32.212',
		'STOP_SCREEN_PERIOD = 2010-03-15T18:29:32.212',
		'SCREEN_VOLUME_FRAME = RTN',
		'SCREEN_VOLUME_SHAPE = ELLIPSOID',
		'SCREEN_VOLUME_X = 200 [m]',
		'SCREEN_VOLUME_Y = 1000 [m]',
		'SCREEN_VOLUME_Z = 1000 [m]',
		'SCREEN_ENTRY_TIME = 2010-03-13T22:37:52.222',
		'SCREEN_EXIT_TIME = 2010-03-13T22:37:52.824',
		'COLLISION_PROBABILITY = 4.835E-05',
		'COLLISION_PROBABILITY_METHOD = FOSTER-1992',
		'COMMENT  Object1 Metadata',
	])
	text = insertAfter(text, 'INTERNATIONAL_DESIGNATOR', ['OBJECT_TYPE = PAYLOAD', 'OPERATOR_CONTACT_POSITION  = OSA', 'OPERATOR_ORGANIZATION = EUMETSAT', 'OPERATOR_PHONE = +49615130312', 'OPERATOR_EMAIL  = JOHN.DOE@SOMEWHERE.NET', '', ''])
	text = insertAfter(text, 'REF_FRAME', [
		'GRAVITY_MODEL  = EGM-96: 36D 36O',
		'ATMOSPHERIC_MODEL  = JACCHIA 70 DCA',
		'N_BODY_PERTURBATIONS  = MOON, SUN',
		'SOLAR_RAD_PRESSURE  = NO',
		'EARTH_TIDES  = NO',
		'INTRACK_THRUST = NO',
		'COMMENT Object1 Data',
		'COMMENT Object1 OD Parameters',
		'TIME_LASTOB_START = 2010-03-12T02:14:12.746',
		'TIME_LASTOB_END = 2010-03-12T02:14:12.746',
		'RECOMMENDED_OD_SPAN = 7.88 [d]',
		'ACTUAL_OD_SPAN  = 5.50 [d]',
		'OBS_AVAILABLE  = 592',
		'OBS_USED  = 579',
		'TRACKS_AVAILABLE = 123',
		'TRACKS_USED = 119',
		'RESIDUALS_ACCEPTED  = 97.8                          [%]',
		'WEIGHTED_RMS  = 0.864',
		'COMMENT  Object1 Additional Parameters',
		'COMMENT  Apogee Altitude=779 km',
		'AREA_PC  = 5.2 [m**2]',
		'MASS = 251.6 [kg]',
		'CD_AREA_OVER_MASS = 0.045663 [m**2/kg]',
		'CR_AREA_OVER_MASS = 0.000000 [m**2/kg]',
		'THRUST_ACCELERATION = 0.0 [m/s**2]',
		'SEDR = 4.54570E-05 [W/kg]',
		'COMMENT  Object1 State Vector',
	])
	text = insertAfter(text, 'CNDOT_NDOT', OBJECT1_DRG_SRP_ROWS)
	text = insertAfter(text, 'INTERNATIONAL_DESIGNATOR', ['OBJECT_TYPE = DEBRIS'], 1)
	return text
})()

describe('parseCDM', () => {
	test('obligatory-keyword example of CCSDS 508.0-B-1 section 3.6.2', () => {
		const cdm = parseCDM(CDM_EXAMPLE)

		expect(cdm.header.version).toBe('1.0')
		expect(cdm.header.originator).toBe('JSPOC')
		expect(cdm.header.messageId).toBe('201113719185')
		expect(cdm.header.messageFor).toBeUndefined()
		expect(timeSubtract(cdm.header.creationDate, timeYMDHMS(2010, 3, 12, 22, 31, 12)) * DAYSEC).toBeCloseTo(0, 6)
		expect(timeSubtract(cdm.relative.tca, timeYMDHMS(2010, 3, 13, 22, 37, 52.618)) * DAYSEC).toBeCloseTo(0, 6)
		expect(toMeter(cdm.relative.missDistance)).toBeCloseTo(715, 9)
		expect(cdm.relative.relativePosition).toBeUndefined()

		const [a, b] = cdm.objects
		expect(a.object).toBe('OBJECT1')
		expect(a.name).toBe('SATELLITE A')
		expect(a.internationalDesignator).toBe('1997-030E')
		expect(a.maneuverable).toBe('YES')
		expect(a.orbitCenter).toBe('EARTH')
		expect(a.referenceFrame).toBe('EME2000')
		expect(a.position[0] * AU_KM).toBeCloseTo(2570.097065, 9)
		expect(a.velocity[2] * (AU_KM / DAYSEC)).toBeCloseTo(-3.526774282, 12)
		expect(a.covariance.rows).toBe(6)
		expect(a.covariance.get(0, 0) * AU_M * AU_M).toBeCloseTo(41.42, 10)
		expect(a.covariance.get(1, 0)).toBe(a.covariance.get(0, 1))
		expect(a.covariance.get(4, 3) * ((AU_M * AU_M) / (DAYSEC * DAYSEC))).toBeCloseTo(-1.502e-5, 15)
		expect(a.covariance.get(3, 1) * ((AU_M * AU_M) / DAYSEC)).toBeCloseTo(-5.476, 12)

		expect(b.name).toBe('FENGYUN 1C DEB')
		expect(b.ephemerisName).toBe('NONE')
		expect(b.maneuverable).toBe('NO')
		expect(b.covariance.get(2, 1) * AU_M * AU_M).toBeCloseTo(-758.88, 9)

		// The two state vectors reproduce the reported miss distance.
		const miss = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2])
		expect(toMeter(miss)).toBeCloseTo(715.748, 3)
	})

	test('optional-keyword example of section 3.6.3', () => {
		const cdm = parseCDM(CDM_OPTIONAL_EXAMPLE)
		const { relative } = cdm
		const [a, b] = cdm.objects

		expect(cdm.header.messageFor).toBe('SATELLITE A')
		expect(relative.comments).toEqual(['Relative Metadata/Data'])
		expect(relative.relativeSpeed! * (AU_M / DAYSEC)).toBeCloseTo(14762, 9)
		expect(relative.relativePosition!.map((x) => x * AU_M)).toEqual([expect.closeTo(27.4, 9), expect.closeTo(-70.2, 9), expect.closeTo(711.8, 9)])
		expect(relative.relativeVelocity![1] * (AU_M / DAYSEC)).toBeCloseTo(-14692, 9)
		expect(relative.screenVolumeFrame).toBe('RTN')
		expect(relative.screenVolumeShape).toBe('ELLIPSOID')
		expect(relative.screenVolume!.map((x) => x * AU_M)).toEqual([expect.closeTo(200, 9), expect.closeTo(1000, 9), expect.closeTo(1000, 9)])
		expect(timeSubtract(relative.screenExitTime!, relative.screenEntryTime!) * DAYSEC).toBeCloseTo(0.602, 6)
		expect(relative.collisionProbability).toBe(4.835e-5)
		expect(relative.collisionProbabilityMethod).toBe('FOSTER-1992')

		expect(a.comments).toEqual([' Object1 Metadata', 'Object1 Data', 'Object1 OD Parameters', ' Object1 Additional Parameters', ' Apogee Altitude=779 km', ' Object1 State Vector'])
		expect(a.objectType).toBe('PAYLOAD')
		expect(a.operatorEmail).toBe('JOHN.DOE@SOMEWHERE.NET')
		expect(a.gravityModel).toBe('EGM-96: 36D 36O')
		expect(a.nBodyPerturbations).toBe('MOON, SUN')
		expect(a.solarRadiationPressure).toBe(false)
		expect(a.recommendedOdSpan).toBe(7.88)
		expect(a.observationsUsed).toBe(579)
		expect(a.tracksUsed).toBe(119)
		expect(a.residualsAccepted).toBe(97.8)
		expect(a.areaPc).toBe(5.2)
		expect(a.mass).toBe(251.6)
		expect(a.cdAreaOverMass).toBe(0.045663)
		expect(a.sedr).toBe(4.5457e-5)

		// DRG and SRP rows extend the covariance to 8x8; their consider factor stays in m²/kg.
		expect(a.covariance.rows).toBe(8)
		expect(a.covariance.get(6, 0) * AU_M).toBeCloseTo(-1.862, 12)
		expect(a.covariance.get(0, 6)).toBe(a.covariance.get(6, 0))
		expect(a.covariance.get(6, 4) * (AU_M / DAYSEC)).toBeCloseTo(2.58e-4, 15)
		expect(a.covariance.get(7, 6)).toBe(2.21e-4)
		expect(a.covariance.get(7, 7)).toBe(1.593e-2)
		expect(b.objectType).toBe('DEBRIS')
		expect(b.covariance.rows).toBe(6)
	})

	test('published section 3.6.3 typos are rejected', () => {
		expectRejected(insertAfter(CDM_EXAMPLE, 'MISS_DISTANCE', ['START_SCREEN_PERIOD = 2010-03-12T18:29:32:212']), 'value', 'START_SCREEN_PERIOD')
		expectRejected(insertAfter(CDM_EXAMPLE, 'REF_FRAME', ['TRACKS USED = 119']), 'syntax')
	})

	test('line terminators', () => {
		const lf = parseCDM(CDM_EXAMPLE)
		const crlf = parseCDM(CDM_EXAMPLE.replaceAll('\n', '\r\n'))
		const cr = parseCDM(CDM_EXAMPLE.replaceAll('\n', '\r'))
		expect(crlf.objects[1].position).toEqual(lf.objects[1].position)
		expect(cr.objects[1].covariance.data).toEqual(lf.objects[1].covariance.data)
	})

	test('time tags', () => {
		const ordinal = parseCDM(replaceLine(CDM_EXAMPLE, 'TCA', ['TCA = 2010-072T22:37:52.618']))
		expect(timeSubtract(ordinal.relative.tca, timeYMDHMS(2010, 3, 13, 22, 37, 52.618)) * DAYSEC).toBeCloseTo(0, 6)

		const leapYear = parseCDM(replaceLine(CDM_EXAMPLE, 'TCA', ['TCA = 2012-366T00:00:00']))
		expect(timeSubtract(leapYear.relative.tca, timeYMDHMS(2012, 12, 31)) * DAYSEC).toBeCloseTo(0, 6)

		// 2016-12-31 ends with a positive leap second.
		const leap = parseCDM(replaceLine(CDM_EXAMPLE, 'TCA', ['TCA = 2016-12-31T23:59:60.5Z']))
		expect(timeSubtract(timeYMDHMS(2017, 1, 1), leap.relative.tca, Timescale.TAI) * DAYSEC).toBeCloseTo(0.5, 6)

		// 23:59:60 exists only on a positive leap-second day, in calendar and ordinal form alike.
		const june = parseCDM(replaceLine(CDM_EXAMPLE, 'TCA', ['TCA = 2015-06-30T23:59:60']))
		expect(timeSubtract(timeYMDHMS(2015, 7, 1), june.relative.tca, Timescale.TAI) * DAYSEC).toBeCloseTo(1, 6)
		const ordinalLeap = parseCDM(replaceLine(CDM_EXAMPLE, 'TCA', ['TCA = 2016-366T23:59:60.5']))
		expect(timeSubtract(ordinalLeap.relative.tca, leap.relative.tca, Timescale.TAI) * DAYSEC).toBeCloseTo(0, 6)

		for (const tca of ['2010-03-13T23:59:60.5', '2015-06-29T23:59:60', '2016-12-30T23:59:60', '2016-365T23:59:60', '2016-12-31T23:59:61', '2010-02-29T00:00:00', '2010-13-01T00:00:00', '2010-366T00:00:00', '2010-03-13T24:00:00', '2010-03-13T12:00:60', '2010-03-13 22:37:52', '2010-03-13T22:37']) {
			expectRejected(replaceLine(CDM_EXAMPLE, 'TCA', [`TCA = ${tca}`]), 'value', 'TCA')
		}
	})

	test('unsupported formats and versions', () => {
		expectRejected('<?xml version="1.0" encoding="UTF-8"?>\n<cdm id="CCSDS_CDM_VERS" version="1.0"></cdm>', 'unsupportedFormat')
		expectRejected(replaceLine(CDM_EXAMPLE, 'CCSDS_CDM_VERS', ['CCSDS_CDM_VERS = 2.0']), 'unsupportedVersion')
		expectRejected(replaceLine(CDM_EXAMPLE, 'CCSDS_CDM_VERS', ['CCSDS_OPM_VERS = 2.0']), 'unsupportedFormat')
		expectRejected(`COMMENT leading comment\n${CDM_EXAMPLE}`, 'unsupportedFormat')
		expectRejected('\n  \n', 'unsupportedFormat')
	})

	test('line syntax', () => {
		expectRejected(replaceLine(CDM_EXAMPLE, 'ORIGINATOR', ['ORIGINATOR =\tJSPOC']), 'syntax')
		expectRejected(replaceLine(CDM_EXAMPLE, 'ORIGINATOR', [`ORIGINATOR = ${'A'.repeat(250)}`]), 'syntax')
		expectRejected(replaceLine(CDM_EXAMPLE, 'ORIGINATOR', ['originator = JSPOC']), 'syntax')
		expectRejected(replaceLine(CDM_EXAMPLE, 'ORIGINATOR', ['ORIGINATOR = JSPOC', 'BOGUS = 1']), 'unknownKeyword', 'BOGUS')

		const error = expectRejected(replaceLine(CDM_EXAMPLE, 'X', ['X = 2570.09.7 [km]']), 'value', 'X')
		expect(error.line).toBe(16)
	})

	test('keyword order, duplicates and obligatory items', () => {
		expectRejected(replaceLine(replaceLine(CDM_EXAMPLE, 'CATALOG_NAME', []), 'OBJECT_DESIGNATOR', ['CATALOG_NAME = SATCAT', 'OBJECT_DESIGNATOR = 12345']), 'order', 'OBJECT_DESIGNATOR')
		expectRejected(insertAfter(CDM_EXAMPLE, 'CN_N', ['CN_N = 7.098E+01 [m**2]']), 'duplicate', 'CN_N')
		expectRejected(replaceLine(CDM_EXAMPLE, 'CN_T', []), 'missing', 'CN_T')
		expectRejected(replaceLine(CDM_EXAMPLE, 'MESSAGE_ID', []), 'missing', 'MESSAGE_ID')
		expectRejected(CDM_EXAMPLE.slice(0, CDM_EXAMPLE.indexOf('OBJECT = OBJECT2')), 'missing')
		// A relative keyword after the objects, and an object without its OBJECT line.
		expectRejected(insertAfter(CDM_EXAMPLE, 'CNDOT_NDOT', ['RELATIVE_SPEED = 1 [m/s]'], 1), 'order', 'RELATIVE_SPEED')
		expectRejected(replaceLine(CDM_EXAMPLE, 'OBJECT', [], 1), 'missing', 'OBJECT')
		expectRejected(replaceLine(CDM_EXAMPLE, 'TCA', []), 'missing', 'TCA')
		expectRejected(replaceLine(CDM_EXAMPLE, 'OBJECT', ['OBJECT = OBJECT2']), 'value', 'OBJECT')
	})

	test('units designators', () => {
		expectRejected(replaceLine(CDM_EXAMPLE, 'MISS_DISTANCE', ['MISS_DISTANCE = 715']), 'unit', 'MISS_DISTANCE')
		expectRejected(replaceLine(CDM_EXAMPLE, 'MISS_DISTANCE', ['MISS_DISTANCE = 0.715 [km]']), 'unit', 'MISS_DISTANCE')
		expectRejected(replaceLine(CDM_EXAMPLE, 'CR_R', ['CR_R = 4.142E+01 [M**2]']), 'unit', 'CR_R')
		expectRejected(replaceLine(CDM_EXAMPLE, 'CR_R', ['CR_R = 4.142E+01[m**2]']), 'unit', 'CR_R')
		expectRejected(insertAfter(CDM_EXAMPLE, 'MISS_DISTANCE', ['COLLISION_PROBABILITY = 1E-4 [n/a]']), 'unit', 'COLLISION_PROBABILITY')
	})

	test('value domains', () => {
		for (const value of ['NaN', 'Infinity', '.5', '5.', '0x10', '1e999', '1 .0']) {
			expectRejected(replaceLine(CDM_EXAMPLE, 'Y', [`Y = ${value} [km]`]), 'value', 'Y')
		}

		expect(parseCDM(replaceLine(CDM_EXAMPLE, 'Y', ['Y = +2.244654904e3 [km]'])).objects[0].position[1] * AU_KM).toBeCloseTo(2244.654904, 9)

		expectRejected(insertAfter(CDM_EXAMPLE, 'MISS_DISTANCE', ['COLLISION_PROBABILITY = 1.5']), 'value', 'COLLISION_PROBABILITY')
		expectRejected(replaceLine(CDM_EXAMPLE, 'MISS_DISTANCE', ['MISS_DISTANCE = -1 [m]']), 'value', 'MISS_DISTANCE')
		expectRejected(replaceLine(CDM_EXAMPLE, 'CT_T', ['CT_T = -2.533E+03 [m**2]']), 'value', 'CT_T')
		expectRejected(replaceLine(CDM_EXAMPLE, 'MANEUVERABLE', ['MANEUVERABLE = MAYBE']), 'value', 'MANEUVERABLE')
		expectRejected(replaceLine(CDM_EXAMPLE, 'COVARIANCE_METHOD', ['COVARIANCE_METHOD = calculated']), 'value', 'COVARIANCE_METHOD')
		expectRejected(replaceLine(CDM_EXAMPLE, 'INTERNATIONAL_DESIGNATOR', ['INTERNATIONAL_DESIGNATOR = 97-030E']), 'value', 'INTERNATIONAL_DESIGNATOR')
		expectRejected(replaceLine(CDM_EXAMPLE, 'ORIGINATOR', ['ORIGINATOR =']), 'value', 'ORIGINATOR')
		expectRejected(insertAfter(CDM_EXAMPLE, 'REF_FRAME', ['OBS_USED = 12.5']), 'value', 'OBS_USED')
		expectRejected(insertAfter(CDM_EXAMPLE, 'REF_FRAME', ['RESIDUALS_ACCEPTED = 100.5 [%]']), 'value', 'RESIDUALS_ACCEPTED')

		// A state vector whose velocity is parallel to the radius has no RTN frame for its covariance.
		const radial = replaceLine(replaceLine(replaceLine(CDM_EXAMPLE, 'X_DOT', ['X_DOT = 2.570097065 [km/s]']), 'Y_DOT', ['Y_DOT = 2.244654904 [km/s]']), 'Z_DOT', ['Z_DOT = 6.281497978 [km/s]'])
		expectRejected(radial, 'value', 'X')
	})

	test('incomplete groups', () => {
		expectRejected(insertAfter(CDM_EXAMPLE, 'MISS_DISTANCE', ['RELATIVE_POSITION_R = 27.4 [m]', 'RELATIVE_POSITION_N = 711.8 [m]']), 'missing', 'RELATIVE_POSITION_T')
		expectRejected(insertAfter(CDM_EXAMPLE, 'CNDOT_NDOT', OBJECT1_DRG_SRP_ROWS.slice(0, 6)), 'missing', 'CDRG_DRG')
		// The SRP row without the DRG row that must precede it.
		expectRejected(insertAfter(CDM_EXAMPLE, 'CNDOT_NDOT', OBJECT1_DRG_SRP_ROWS.slice(7)), 'missing', 'CSRP_R')
	})

	test('reference frames and orbit centres', () => {
		expectRejected(replaceLine(CDM_EXAMPLE, 'REF_FRAME', ['REF_FRAME = GCRF'], 1), 'frame', 'REF_FRAME')
		expectRejected(replaceLine(CDM_EXAMPLE, 'REF_FRAME', ['REF_FRAME = TEME']), 'value', 'REF_FRAME')
		expectRejected(insertAfter(CDM_EXAMPLE, 'MANEUVERABLE', ['ORBIT_CENTER = MOON']), 'frame', 'ORBIT_CENTER')

		const itrf = replaceLine(replaceLine(CDM_EXAMPLE, 'REF_FRAME', ['REF_FRAME = ITRF']), 'REF_FRAME', ['REF_FRAME = ITRF'], 1)
		expect(parseCDM(itrf).objects[1].referenceFrame).toBe('ITRF')
		expectRejected(insertAfter(insertAfter(itrf, 'MANEUVERABLE', ['ORBIT_CENTER = MARS']), 'MANEUVERABLE', ['ORBIT_CENTER = MARS'], 1), 'frame', 'ORBIT_CENTER')

		const moon = insertAfter(insertAfter(CDM_EXAMPLE, 'MANEUVERABLE', ['ORBIT_CENTER = MOON']), 'MANEUVERABLE', ['ORBIT_CENTER = MOON'], 1)
		expect(parseCDM(moon).objects[0].orbitCenter).toBe('MOON')
	})
})
