import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { vector } from '../../../../src/adapters/ephemeris/horizons'
import type { PositionAndVelocity } from '../../../../src/astronomy/coordinates/astrometry'
import { itrfToTemeByGmst, temeToItrfByGmst } from '../../../../src/astronomy/coordinates/frame'
import { type DsInitOptions, internal, type MeanElements, parseTLE, recordFromOMM, recordFromTLE, SGP4_WGS72, SGP4_WGS72_OLD, SGP4_WGS84, sgp4, type Sgp4GravityModel } from '../../../../src/astronomy/orbits/propagation/sgp4'
import { Timescale, timeYMDHMS } from '../../../../src/astronomy/time/time'
import { DAYMIN } from '../../../../src/core/constants'
import { fileHandleSource, readLines } from '../../../../src/io/io'
import { toKilometer } from '../../../../src/math/units/distance'
import { toKilometerPerSecond } from '../../../../src/math/units/velocity'

const ISS_TLE = parseTLE('1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996', '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611', 'ISS (ZARYA)')

const ISS_OMM = {
	OBJECT_NAME: 'ISS (ZARYA)',
	OBJECT_ID: '1998-067A',
	EPOCH: '2023-08-19T12:25:27.896736',
	MEAN_MOTION: 15.4947758,
	ECCENTRICITY: 0.0003559,
	INCLINATION: 51.6415,
	RA_OF_ASC_NODE: 14.7889,
	ARG_OF_PERICENTER: 325.3396,
	MEAN_ANOMALY: 149.4637,
	EPHEMERIS_TYPE: 0,
	NORAD_CAT_ID: 25544,
	ELEMENT_SET_NO: 999,
	REV_AT_EPOCH: 41161,
	BSTAR: 0.00025837,
	MEAN_MOTION_DOT: 0.0001405,
	MEAN_MOTION_DDOT: 0,
} as const

const VALLADO_CASES = [
	{
		title: 'SGP4 (LEO) Test TLE',
		tle: parseTLE('1 88888U          80275.98708465  .00073094  13844-3  66816-4 0    8', '2 88888  72.8435 115.9689 0086731  52.6988 110.5714 16.05824518  105'),
		results: [
			{ time: 0, position: [2328.97048951, -5995.22076416, 1719.97067261], velocity: [2.9120723, -0.98341546, -7.09081703] },
			{ time: 360, position: [2456.10705566, -6071.9385376, 1222.89727783], velocity: [2.67938992, -0.44829041, -7.22879231] },
			{ time: 720, position: [2567.56195068, -6112.50384522, 713.963974], velocity: [2.44024599, 0.09810869, -7.31995916] },
			{ time: 1080, position: [2663.0907898, -6115.4822998, 196.39640427], velocity: [2.19611958, 0.65241995, -7.36282432] },
			{ time: 1440, position: [2742.55133057, -6079.67144775, -326.38095856], velocity: [1.94850229, 1.21106251, -7.35619372] },
		],
	},
	{
		title: 'SDP4 (Deep Space) Test TLE',
		tle: parseTLE('1 11801U          80230.29629788  .01431103  00000-0  14311-1        ', '2 11801  46.7916 230.4354 7318036  47.4722  10.4117  2.28537848      '),
		results: [
			{ time: 0, position: [7473.3706665, 428.95261765, 5828.74786377], velocity: [5.10715413, 6.44468284, -0.18613096] },
			{ time: 360, position: [-3305.22537232, 32410.86328125, -24697.17675781], velocity: [-1.30113538, -1.15131518, -0.28333528] },
			{ time: 720, position: [14271.28759766, 24110.46411133, -4725.76837158], velocity: [-0.32050445, 2.67984074, -2.08405289] },
			{ time: 1080, position: [-9990.05883789, 22717.35522461, -23616.89062501], velocity: [-1.01667246, -2.29026759, 0.72892364] },
			{ time: 1440, position: [9787.86975097, 33753.34667969, -15030.81176758], velocity: [-1.09425066, 0.92358845, -1.52230928] },
		],
	},
] as const

const DEEP_SPACE_TLE = VALLADO_CASES[1].tle

// TEME km / km/s from Python sgp4 2.25 (uv run --with sgp4==2.25), Satrec.twoline2rv(..., WGS72OLD|WGS72|WGS84).
const GRAVITY_REFERENCES: ReadonlyArray<{
	title: string
	tle: ReturnType<typeof parseTLE>
	gravity: Sgp4GravityModel
	samples: ReadonlyArray<{ minutes: number; position: readonly [number, number, number]; velocity: readonly [number, number, number] }>
}> = [
	{
		title: 'ISS near-Earth',
		tle: ISS_TLE,
		gravity: SGP4_WGS72_OLD,
		samples: [
			{ minutes: 0, position: [-3737.794176614203, 2970.4634867700756, 4831.152014481082], velocity: [-6.213956426575407, -3.703552589035793, -2.5222412725450534] },
			{ minutes: 1440, position: [3643.2209602572975, -3199.1457144614315, -4765.938600323042], velocity: [6.379289789802434, 3.2644105953747644, 2.6890099860863415] },
			{ minutes: 10080, position: [2999.875528591581, -4527.819934099846, -4088.151691088842], velocity: [6.5572301097308525, 0.8700608091352692, 3.854372125279752] },
			{ minutes: 43200, position: [1975.9433084145687, 5679.9164415182495, -3172.2630546366936], velocity: [-5.90691555034373, -0.6353871027911963, -4.827236749726999] },
		],
	},
	{
		title: 'ISS near-Earth',
		tle: ISS_TLE,
		gravity: SGP4_WGS72,
		samples: [
			{ minutes: 0, position: [-3737.794177725673, 2970.4634876540035, 4831.152015920498], velocity: [-6.213956428421944, -3.7035525901372703, -2.522241273294621] },
			{ minutes: 1440, position: [3643.2209611699077, -3199.1457153966776, -4765.938601883229], velocity: [6.37928979177511, 3.264410596461616, 2.689009986567801] },
			{ minutes: 10080, position: [2999.875523440927, -4527.819935390398, -4088.1516968290384], velocity: [6.557230115816404, 0.8700608050379177, 3.8543721203344137] },
			{ minutes: 43200, position: [1975.9434093512182, 5679.916458100012, -3172.2629663534194], velocity: [-5.906915504752462, -0.6353869790549685, -4.82723682572573] },
		],
	},
	{
		title: 'ISS near-Earth',
		tle: ISS_TLE,
		gravity: SGP4_WGS84,
		samples: [
			{ minutes: 0, position: [-3737.790418092595, 2970.475175787871, 4831.165024943218], velocity: [-6.213946083417224, -3.7035407871182873, -2.5222302001427988] },
			{ minutes: 1440, position: [3643.2560923840606, -3199.1198365721934, -4765.906957316966], velocity: [6.379275636706228, 3.2644324282056845, 2.6890559951784834] },
			{ minutes: 10080, position: [3000.1101340323353, -4527.809463404448, -4087.9684400028236], velocity: [6.557082971439185, 0.8702323275027644, 3.8546072568024567] },
			{ minutes: 43200, position: [1975.0362708031573, 5679.668981464336, -3173.2485260672884], velocity: [-5.9074751063670154, -0.636556217272169, -4.826407972816281] },
		],
	},
	{
		title: 'Vallado SDP4 deep-space',
		tle: DEEP_SPACE_TLE,
		gravity: SGP4_WGS72_OLD,
		samples: [
			{ minutes: 0, position: [7473.371022692968, 428.9474830016233, 5828.748466090225], velocity: [5.107155389343545, 6.444680302711042, -0.1861332972887838] },
			{ minutes: 1440, position: [9787.878271086283, 33753.32250917301, -15030.798829620995], velocity: [-1.094251559291602, 0.9235898878648345, -1.5223110008189658] },
			{ minutes: 10080, position: [-4255.693150348227, 29254.94893152409, -24059.683739189706], velocity: [-1.3765205620842786, -1.336145630565554, -0.14513309463966417] },
			{ minutes: 43200, position: [2036.934059098947, 25748.788561461366, -19522.407541045537], velocity: [-1.7917270375676497, -0.47756450764146285, -0.8339665928615592] },
		],
	},
	{
		title: 'Vallado SDP4 deep-space',
		tle: DEEP_SPACE_TLE,
		gravity: SGP4_WGS72,
		samples: [
			{ minutes: 0, position: [7473.371024914288, 428.9474831243528, 5828.748467826838], velocity: [5.107155390863484, 6.444680304626358, -0.18613329734153358] },
			{ minutes: 1440, position: [9787.878362555224, 33753.32249666768, -15030.798746254333], velocity: [-1.0942515528493595, 0.9235899056171107, -1.52231100767063] },
			{ minutes: 10080, position: [-4255.68835347476, 29254.95392098278, -24059.683465035978], velocity: [-1.3765206562081707, -1.3361448854013243, -0.14513369677043328] },
			{ minutes: 43200, position: [2037.0225334639574, 25748.813350688164, -19522.36727716588], velocity: [-1.791725783091079, -0.47754956278885446, -0.8339778847730721] },
		],
	},
	{
		title: 'Vallado SDP4 deep-space',
		tle: DEEP_SPACE_TLE,
		gravity: SGP4_WGS84,
		samples: [
			{ minutes: 0, position: [7473.3599032879365, 428.90099009406805, 5828.770850028464], velocity: [5.10716775131343, 6.444664842035081, -0.18611269941800382] },
			{ minutes: 1440, position: [9787.757441373433, 33753.339067624205, -15030.91096060269], velocity: [-1.0942645167263871, 0.9235593523204051, -1.5223007481343744] },
			{ minutes: 10080, position: [-4264.666397349324, 29245.598291853137, -24060.19238963709], velocity: [-1.376347766342412, -1.3375412231458663, -0.14400734259580675] },
			{ minutes: 43200, position: [1871.2915881897752, 25701.090883540423, -19596.780359371107], velocity: [-1.7939894401805663, -0.5054996709614675, -0.8127996304024315] },
		],
	},
]

function timeFromEpoch(epoch: { day: number; fraction: number; scale: number }, minutes: number) {
	return { day: epoch.day, fraction: epoch.fraction + minutes / DAYMIN, scale: epoch.scale }
}

test('parse TLE', () => {
	expect(ISS_TLE.name).toBe('ISS (ZARYA)')
	expect(ISS_TLE.satelliteNumber).toBe('25544')
	expect(ISS_TLE.epochYear).toBe(23)
	expect(ISS_TLE.epochDays).toBeCloseTo(231.51768399, 10)
	expect(ISS_TLE.eccentricity).toBeCloseTo(0.0003559, 12)
	expect(ISS_TLE.meanMotion).toBeCloseTo(15.4947758, 7)
})

test('OMM and TLE produce matching state near epoch', () => {
	const tleRecord = recordFromTLE(ISS_TLE)
	const ommRecord = recordFromOMM(ISS_OMM)
	const tleState = sgp4(ISS_TLE.epoch, tleRecord)
	const ommState = sgp4(ISS_TLE.epoch, ommRecord)
	const tlePositionKm = tleState[0].map(toKilometer)
	const ommPositionKm = ommState[0].map(toKilometer)
	const tleVelocityKms = tleState[1].map(toKilometerPerSecond)
	const ommVelocityKms = ommState[1].map(toKilometerPerSecond)

	expectVector(tlePositionKm, ommPositionKm, 5)
	expectVector(tleVelocityKms, ommVelocityKms, 7)
})

test('invalid OMM propagation throws', () => {
	expect(() => sgp4(ISS_TLE.epoch, { ...ISS_OMM, ECCENTRICITY: 1.2 })).toThrow()
})

test('SGP4 gravity models match Vallado getgravconst source constants', () => {
	expect(SGP4_WGS72_OLD.name).toBe('wgs72old')
	expect(SGP4_WGS72_OLD.mu).toBe(398600.79964)
	expect(SGP4_WGS72_OLD.radius).toBe(6378.135)
	expect(SGP4_WGS72_OLD.xke).toBe(0.0743669161)
	expect(SGP4_WGS72_OLD.j2).toBe(0.001082616)
	expect(SGP4_WGS72_OLD.j3).toBe(-0.00000253881)
	expect(SGP4_WGS72_OLD.j4).toBe(-0.00000165597)
	expect(SGP4_WGS72_OLD.tumin).toBeCloseTo(1 / 0.0743669161, 12)
	expect(SGP4_WGS72_OLD.j3OverJ2).toBeCloseTo(-0.00000253881 / 0.001082616, 12)
	expect(SGP4_WGS72_OLD.velocityScale).toBeCloseTo((6378.135 * 0.0743669161) / 60, 12)

	expect(SGP4_WGS72.name).toBe('wgs72')
	expect(SGP4_WGS72.mu).toBe(398600.8)
	expect(SGP4_WGS72.radius).toBe(6378.135)
	expect(SGP4_WGS72.j2).toBe(0.001082616)
	expect(SGP4_WGS72.j3).toBe(-0.00000253881)
	expect(SGP4_WGS72.j4).toBe(-0.00000165597)
	expect(SGP4_WGS72.xke).toBeCloseTo(60 / Math.sqrt((6378.135 * 6378.135 * 6378.135) / 398600.8), 15)

	expect(SGP4_WGS84.name).toBe('wgs84')
	expect(SGP4_WGS84.mu).toBe(398600.5)
	expect(SGP4_WGS84.radius).toBe(6378.137)
	expect(SGP4_WGS84.j2).toBe(0.00108262998905)
	expect(SGP4_WGS84.j3).toBe(-0.00000253215306)
	expect(SGP4_WGS84.j4).toBe(-0.00000161098761)
})

test('recordFromTLE and recordFromOMM default to WGS-72 and retain the selected model', () => {
	expect(recordFromTLE(ISS_TLE).gravity).toBe(SGP4_WGS72)
	expect(recordFromOMM(ISS_OMM).gravity).toBe(SGP4_WGS72)
	expect(recordFromTLE(ISS_TLE, SGP4_WGS72_OLD).gravity).toBe(SGP4_WGS72_OLD)
	expect(recordFromTLE(ISS_TLE, SGP4_WGS84).gravity).toBe(SGP4_WGS84)
	expect(recordFromOMM(ISS_OMM, 'a', SGP4_WGS84).gravity).toBe(SGP4_WGS84)
	expect(recordFromOMM(ISS_OMM, 'a').operationmode).toBe('a')
	expect(recordFromOMM(ISS_OMM, 'i').operationmode).toBe('i')
})

test('direct sgp4(time, tle|omm) keeps WGS-72 behavior', () => {
	const fromTle = sgp4(ISS_TLE.epoch, recordFromTLE(ISS_TLE, SGP4_WGS72))
	const fromOmm = sgp4(ISS_TLE.epoch, recordFromOMM(ISS_OMM, 'i', SGP4_WGS72))
	const directTle = sgp4(ISS_TLE.epoch, ISS_TLE)
	const directOmm = sgp4(ISS_TLE.epoch, ISS_OMM)

	expectVector(directTle[0], fromTle[0], 12)
	expectVector(directTle[1], fromTle[1], 12)
	expectVector(directOmm[0], fromOmm[0], 12)
	expectVector(directOmm[1], fromOmm[1], 12)
})

for (const { title, tle, results } of VALLADO_CASES) {
	for (const sample of results) {
		test(`${title} at ${sample.time} min`, () => {
			const time = { day: tle.epoch.day, fraction: tle.epoch.fraction + sample.time / DAYMIN, scale: 1 }
			const state = sgp4(time, tle)
			const positionKm = state[0].map(toKilometer)
			const velocityKms = state[1].map(toKilometerPerSecond)
			expectVector(positionKm, sample.position, 1)
			expectVector(velocityKms, sample.velocity, 4)
		})
	}
}

for (const { title, tle, gravity, samples } of GRAVITY_REFERENCES) {
	test(`${title} ${gravity.name} record stays on that model`, () => {
		const rec = recordFromTLE(tle, gravity)
		expect(rec.gravity).toBe(gravity)
		expect(rec.method === 'n' || rec.method === 'd').toBe(true)
	})

	for (const sample of samples) {
		test(`${title} ${gravity.name} at ${sample.minutes} min`, () => {
			const rec = recordFromTLE(tle, gravity)
			const state = sgp4(timeFromEpoch(tle.epoch, sample.minutes), rec)
			expectVector(state[0].map(toKilometer), sample.position, 7)
			expectVector(state[1].map(toKilometerPerSecond), sample.velocity, 9)
		})
	}
}

test('WGS-72 and WGS-84 do not collapse after propagation', () => {
	const wgs72 = sgp4(timeFromEpoch(ISS_TLE.epoch, 1440), recordFromTLE(ISS_TLE, SGP4_WGS72))
	const wgs84 = sgp4(timeFromEpoch(ISS_TLE.epoch, 1440), recordFromTLE(ISS_TLE, SGP4_WGS84))
	const dx = toKilometer(wgs72[0][0]) - toKilometer(wgs84[0][0])
	const dy = toKilometer(wgs72[0][1]) - toKilometer(wgs84[0][1])
	const dz = toKilometer(wgs72[0][2]) - toKilometer(wgs84[0][2])
	expect(Math.hypot(dx, dy, dz)).toBeGreaterThan(0.01)
})

test('out-of-order propagation matches independent records for each gravity model', () => {
	for (const gravity of [SGP4_WGS72_OLD, SGP4_WGS72, SGP4_WGS84]) {
		const shared = recordFromTLE(DEEP_SPACE_TLE, gravity)
		const later = sgp4(timeFromEpoch(DEEP_SPACE_TLE.epoch, 10080), shared)
		const earlier = sgp4(timeFromEpoch(DEEP_SPACE_TLE.epoch, 0), shared)
		const mid = sgp4(timeFromEpoch(DEEP_SPACE_TLE.epoch, 1440), shared)

		expectVector(earlier[0], sgp4(timeFromEpoch(DEEP_SPACE_TLE.epoch, 0), recordFromTLE(DEEP_SPACE_TLE, gravity))[0], 12)
		expectVector(mid[0], sgp4(timeFromEpoch(DEEP_SPACE_TLE.epoch, 1440), recordFromTLE(DEEP_SPACE_TLE, gravity))[0], 12)
		expectVector(later[0], sgp4(timeFromEpoch(DEEP_SPACE_TLE.epoch, 10080), recordFromTLE(DEEP_SPACE_TLE, gravity))[0], 12)
	}
})

test('OMM AFSPC and improved modes retain gravity and match WGS-72 at epoch', () => {
	const improved = recordFromOMM(ISS_OMM, 'i', SGP4_WGS72)
	const afspc = recordFromOMM(ISS_OMM, 'a', SGP4_WGS72)
	expect(improved.operationmode).toBe('i')
	expect(afspc.operationmode).toBe('a')
	expect(improved.gravity).toBe(SGP4_WGS72)
	expect(afspc.gravity).toBe(SGP4_WGS72)

	const improvedState = sgp4(ISS_TLE.epoch, improved)
	const afspcState = sgp4(ISS_TLE.epoch, afspc)
	expectVector(improvedState[0].map(toKilometer), [-3737.794177725673, 2970.4634876540035, 4831.152015920498], 7)
	expectVector(afspcState[0].map(toKilometer), [-3737.794177725673, 2970.4634876540035, 4831.152015920498], 7)
})

test('TEME to ITRF by GMST matches reference rotation', () => {
	const itrf = temeToItrfByGmst([6400, 0, 0], 10)
	expectVector(itrf, [-5370.057786089295, 3481.7351096919665, 0], 9)
})

test('ITRF to TEME by GMST matches reference rotation', () => {
	const teme = itrfToTemeByGmst([5555, 3000, 0], 100)
	expectVector(teme, [6309.278258887361, -225.90451950165834, 0], 9)
})

test('TEME and ITRF state conversion round-trips', () => {
	const state: PositionAndVelocity = [
		[7000, -1200, 3400],
		[1.5, 6.9, -2.1],
	]

	const gmst = 1.2345
	const itrf = temeToItrfByGmst(state, gmst)
	const teme = itrfToTemeByGmst(itrf, gmst)

	expectVector(teme[0], state[0], 9)
	expectVector(teme[1], state[1], 9)
})

test('vector elements by JPL Horizons', () => {
	const tle = parseTLE('1 25544U 98067A   26070.19118651  .00009215  00000+0  17770-3 0  9998', '2 25544  51.6325  64.9326 0007932 179.9008 180.1983 15.48575655556567', 'ISS (ZARYA)')
	const time = timeYMDHMS(2026, 3, 11, 0, 0, 0, Timescale.TDB)
	const [p, v] = sgp4(time, tle)

	// JPL Horizons:
	// Output units: AU and AU/day
	// Output type: GEOMETRIC cartesian states
	// Reference frame: ICRF
	expect(p[0]).toBeCloseTo(1.459950950729029e-5, 6)
	expect(p[1]).toBeCloseTo(4.27203155142363e-5, 6)
	expect(p[2]).toBeCloseTo(5.523957827183497e-6, 6)
	expect(v[0]).toBeCloseTo(-2.744523449434552e-3, 4)
	expect(v[1]).toBeCloseTo(4.892062429322461e-4, 4)
	expect(v[2]).toBeCloseTo(3.431067191069624e-3, 4)
})

test('legacy sidereal time', () => {
	const options = {
		ecco: 0.1846988,
		epochday: 25938,
		epochfrac: 0.538312919904,
		inclo: 0,
		method: 'n',
		no: 0.0037028783237264057,
		opsmode: 'a',
		satn: '00001',
	} as const

	const results = internal.initl(options)
	expect(results.ainv).toBeCloseTo(0.1353414893496189, 6)
	expect(results.ao).toBeCloseTo(7.3887172721793, 5)
	expect(results.con41).toBe(2)
	expect(results.con42).toBe(-4)
	expect(results.cosio).toBe(1)
	expect(results.cosio2).toBe(1)
	expect(results.eccsq).toBeCloseTo(0.034113646721439995, 12)
	expect(results.gsto).toBeCloseTo(5.220883431398299, 12)
	expect(results.method).toBe('n')
	expect(results.no).toBeCloseTo(0.003702762286531528, 10)
	expect(results.omeosq).toBeCloseTo(0.96588635327856, 10)
	expect(results.posq).toBeCloseTo(50.931932818552305, 3)
	expect(results.rp).toBeCloseTo(6.02403005846851, 5)
	expect(results.rteosq).toBeCloseTo(0.9827951736137902, 10)
	expect(results.sinio).toBe(0)
})

test('geopotential resonance for 12 hour orbits', () => {
	let options: DsInitOptions = {
		argpm: 0,
		argpo: 3.1731953303556546,
		atime: 0,
		cosim: 0.8265818908073872,
		d2201: 0,
		d2211: 0,
		d3210: 0,
		d3222: 0,
		d4410: 0,
		d4422: 0,
		d5220: 0,
		d5232: 0,
		d5421: 0,
		d5433: 0,
		dedt: 0,
		del1: 0,
		del2: 0,
		del3: 0,
		didt: 0,
		dmdt: 0,
		dnodt: 0,
		domdt: 0,
		ecco: 0.5,
		eccsq: 0.25,
		em: 0.5,
		emsq: 0.25,
		gsto: 5.220883431349307,
		inclm: 0.5977892314420737,
		irez: 0,
		mdot: 0.008289877617360376,
		mm: 0,
		mo: 3.097818050620523,
		nm: 0.00828929401348305,
		no: 0.00828929401348305,
		nodedot: -0.0000010615465631002147,
		nodem: 0,
		nodeo: 5.684425672673404,
		s1: -0.0003758603820133531,
		s2: -0.00003340981173452028,
		s3: 0.000057867491395499995,
		s4: 0.00005011471760178041,
		s5: -0.0814586266145132,
		sinim: 0.5628164690103556,
		ss1: -0.0023400973145719425,
		ss2: -0.0002080086501841727,
		ss3: 0.0003602815505328084,
		ss4: 0.000312012975276259,
		ss5: -0.05506592822076295,
		sz1: 10.0266126658567,
		sz3: 11.96755448889018,
		sz11: -0.26695105200172087,
		sz13: 2.85835691924874,
		sz21: -0.10879395395455185,
		sz23: -0.9817900146669546,
		sz31: 3.2268633174603867,
		sz33: 5.297255866008874,
		t: 0,
		tc: 0,
		xfact: 0,
		xlamo: 0,
		xli: 0,
		xni: 0,
		xpidot: 4.898991347062741e-7,
		z1: 4.101694478238579,
		z3: 16.932733892867283,
		z11: 1.429557720331177,
		z13: 1.9707634473989213,
		z21: -1.4644752902058293,
		z23: 0.2884276608142515,
		z31: -0.8856293737107999,
		z33: 8.908977597159325,
	} as const

	let results: ReturnType<typeof internal.dsInit> = {
		argpm: 0,
		atime: 0,
		d2201: -1.2099438856510436e-11,
		d2211: 1.0011494893832913e-11,
		d3210: -5.086681199981555e-12,
		d3222: -3.9879779675343986e-13,
		d4410: 4.10948324131911e-13,
		d4422: 9.349597736749112e-14,
		d5220: 2.4097823461671757e-13,
		d5232: 1.6478747122823163e-13,
		d5421: -2.1387372659636362e-13,
		d5433: -9.311219761949575e-15,
		dedt: 6.387624124699951e-9,
		del1: 0,
		del2: 0,
		del3: 0,
		didt: -2.4428711570103973e-8,
		dmdt: -7.866458523057076e-8,
		dndt: 0,
		dnodt: -1.5869893761619698e-8,
		domdt: 3.8582690952174514e-8,
		em: 0.5,
		inclm: 0.5977892314420737,
		irez: 2,
		mm: 0,
		nm: 0.00828929401348305,
		nodem: 0,
		xfact: -0.008752188069644229,
		xlamo: 4.024902533268717,
		xli: 4.024902533268717,
		xni: 0.00828929401348305,
	} as const

	expect(internal.dsInit(options)).toEqual(results)

	options = {
		argpm: 0,
		argpo: 3.1731953303556546,
		atime: 0,
		cosim: 0.8265818908073872,
		d2201: 0,
		d2211: 0,
		d3210: 0,
		d3222: 0,
		d4410: 0,
		d4422: 0,
		d5220: 0,
		d5232: 0,
		d5421: 0,
		d5433: 0,
		dedt: 0,
		del1: 0,
		del2: 0,
		del3: 0,
		didt: 0,
		dmdt: 0,
		dnodt: 0,
		domdt: 0,
		ecco: 0.9,
		eccsq: 0.81,
		em: 0.9,
		emsq: 0.81,
		gsto: 5.220883431349307,
		inclm: 0.5977892314420737,
		irez: 0,
		mdot: 0.008289882914214362,
		mm: 0,
		mo: 3.097818050620523,
		nm: 0.008285301381233555,
		no: 0.008285301381233555,
		nodedot: -0.000016615977679572516,
		nodem: 0,
		nodeo: 5.684425672673404,
		s1: -0.00034068613392845755,
		s2: -0.0000664105524227013,
		s3: 0.000057895377359053036,
		s4: 0.000025236009920626485,
		s5: -0.0814586266145132,
		sinim: 0.5628164690103556,
		ss1: -0.0021211033279095576,
		ss2: -0.00041347043429036223,
		ss3: 0.00036045516784271263,
		ss4: 0.0001571187650303376,
		ss5: -0.05506592822076295,
		sz1: 11.833656123634515,
		sz3: 14.934017773855151,
		sz11: -0.559025056566349,
		sz13: 6.1122684947234225,
		sz21: -0.012026488033904603,
		sz23: -0.41905685490385947,
		sz31: 3.2268633174603867,
		sz33: 5.297255866008874,
		t: 0,
		tc: 0,
		xfact: 0,
		xlamo: 0,
		xli: 0,
		xni: 0,
		xpidot: 0.000007654165958004881,
		z1: 3.6057420289605315,
		z3: 21.9217613472765,
		z11: 3.1143324610298544,
		z13: 4.157342147158473,
		z21: -0.4580055602764077,
		z23: -0.042575346093936206,
		z31: -0.8856293737107999,
		z33: 8.908977597159325,
	}

	results = {
		argpm: 0,
		atime: 0,
		d2201: -2.077922237635543e-11,
		d2211: 8.354974473880257e-11,
		d3210: -7.971713322895552e-11,
		d3222: -1.5879563982136425e-11,
		d4410: 1.575743786950506e-11,
		d4422: 7.56868465456182e-12,
		d5220: 3.642159807380104e-11,
		d5232: 6.0905980525896e-11,
		d5421: -4.636775124768956e-11,
		d5433: -5.740323981213709e-12,
		dedt: 5.789849295568645e-9,
		del1: 0,
		del2: 0,
		del3: 0,
		didt: -1.0389979451500435e-7,
		dmdt: -9.517687076400692e-8,
		dndt: 0,
		dnodt: -1.3136567693239499e-8,
		domdt: 2.3681689509031805e-8,
		em: 0.9,
		inclm: 0.5977892314420737,
		irez: 2,
		mm: 0,
		nm: 0.008285301381233555,
		nodem: 0,
		xfact: -0.00877931004840709,
		xlamo: 4.024902533268717,
		xli: 4.024902533268717,
		xni: 0.008285301381233555,
	}

	expect(internal.dsInit(options)).toEqual(results)
})

// https://github.com/shashwatak/satellite-js/tree/develop/test/propagation
test.skip('propagation', async () => {
	// await download('tle.input.txt')
	// await download('tle.result.csv')

	const tleInputFileHandle = await fs.open('data/tle.input.txt')
	const tleInput = readLines(fileHandleSource(tleInputFileHandle), 70)
	const minSinceEpoch = [0, 360, 720, 1080, 1440] as const
	const meanElements: MeanElements = { am: 0, em: 0, im: 0, Om: 0, om: 0, mm: 0, nm: 0 }

	// const result = (await Bun.file('sgp4CatalogResults.json').json()) as {
	// 	position: { x: number; y: number; z: number }
	// 	velocity: { x: number; y: number; z: number }
	// 	meanElements: MeanElements
	// }[][][]

	// const csv = new Array<string>(13)
	// const lines = []
	// const NULL = `${'N'.padEnd(265, ' ')}\n`
	// let maxLineLength = 0 // to compute chunkSize and significantly speed up readLines

	// for (const a of result) {
	// 	for (const b of a) {
	// 		for (const c of b) {
	// 			if (c !== null) {
	// 				csv[0] = c.position.x.toString()
	// 				csv[1] = c.position.y.toString()
	// 				csv[2] = c.position.z.toString()
	// 				csv[3] = c.velocity.x.toString()
	// 				csv[4] = c.velocity.y.toString()
	// 				csv[5] = c.velocity.z.toString()
	// 				csv[6] = c.meanElements.am.toString()
	// 				csv[7] = c.meanElements.em.toString()
	// 				csv[8] = c.meanElements.im.toString()
	// 				csv[9] = c.meanElements.Om.toString()
	// 				csv[10] = c.meanElements.om.toString()
	// 				csv[11] = c.meanElements.mm.toString()
	// 				csv[12] = c.meanElements.nm.toString()
	// 				const line = `${csv.join(',')}`
	// 				lines.push(`${line.padEnd(264)}\n`)
	// 				maxLineLength = Math.max(maxLineLength, line.length)
	// 			} else {
	// 				lines.push(NULL)
	// 			}
	// 		}
	// 	}
	// }

	// console.info(maxLineLength)

	// await Bun.write('tle.result.csv', lines)

	const tleResultFileHandle = await fs.open('data/tle.result.csv')
	const tleResult = readLines(fileHandleSource(tleResultFileHandle), 265)

	let c = 0
	let line1 = ''

	for await (const line of tleInput) {
		if (c % 2 === 0) {
			line1 = line
		} else {
			const satRec = recordFromTLE(parseTLE(line1, line))

			for (const time of minSinceEpoch) {
				const { done, value } = await tleResult.next()

				if (done) return

				try {
					const [p, v] = sgp4({ day: satRec.epoch.day, fraction: satRec.epoch.fraction + time / DAYMIN, scale: 1 }, satRec, meanElements)
					const [px, py, pz, vx, vy, vz, am, em, im, Om, om, mm, nm] = value.split(',')
					// NOTE: using greenwichMeanSiderealTime reduces the number of digits to be matched
					expect(toKilometer(p[0])).toBeCloseTo(+px, 3)
					expect(toKilometer(p[1])).toBeCloseTo(+py, 3)
					expect(toKilometer(p[2])).toBeCloseTo(+pz, 3)
					expect(toKilometerPerSecond(v[0])).toBeCloseTo(+vx, 6)
					expect(toKilometerPerSecond(v[1])).toBeCloseTo(+vy, 6)
					expect(toKilometerPerSecond(v[2])).toBeCloseTo(+vz, 6)
					expect(meanElements.am).toBeCloseTo(+am, 8)
					expect(meanElements.em).toBeCloseTo(+em, 8)
					expect(meanElements.im).toBeCloseTo(+im, 8)
					expect(meanElements.Om).toBeCloseTo(+Om, 8)
					expect(meanElements.om).toBeCloseTo(+om, 8)
					expect(meanElements.mm).toBeCloseTo(+mm, 8)
					expect(meanElements.nm).toBeCloseTo(+nm, 8)
				} catch (e) {
					// console.info(line1)
					// console.info(line)
					// console.info(time)
					// console.info(e)
					expect(value[0]).toBe('N')
				}
			}
		}

		c++
	}
}, 20000)

test.skip('horizons', async () => {
	const tle = parseTLE('1 25544U 98067A   26070.19118651  .00009215  00000+0  17770-3 0  9998', '2 25544  51.6325  64.9326 0007932 179.9008 180.1983 15.48575655556567', 'ISS (ZARYA)')
	const startTime = timeYMDHMS(2026, 3, 11, 0, 0, 0, Timescale.TDB)
	const endTime = timeYMDHMS(2026, 3, 11, 1, 0, 0, Timescale.TDB)
	const v = await vector(tle, '500@399', false, startTime, endTime, { stepSize: 1, stepSizeUnit: 'h', referencePlane: 'FRAME' })

	for (let i = 0; i < 3; i++) {
		console.info(`expect(p[${i}]).toBeCloseTo(${v[0][2 + i]}, 6)`)
	}
	for (let i = 0; i < 3; i++) {
		console.info(`expect(v[${i}]).toBeCloseTo(${v[0][5 + i]}, 4)`)
	}
})

function expectVector(actual: readonly number[], expected: readonly number[], digits: number) {
	for (let i = 0; i < 3; i++) {
		expect(actual[i]).toBeCloseTo(expected[i], digits)
	}
}
