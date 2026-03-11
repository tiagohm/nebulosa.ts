import { expect, test } from 'bun:test'
import type { PositionAndVelocity } from '../src/astrometry'
import { DAYMIN } from '../src/constants'
import { toKilometer } from '../src/distance'
import { itrfToTemeByGmst, temeToItrfByGmst } from '../src/frame'
import { parseTLE, recordFromOMM, recordFromTLE, sgp4 } from '../src/sgp4'
import { toKilometerPerSecond } from '../src/velocity'

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
	const tlePositionKm = tleState.position.map(toKilometer)
	const ommPositionKm = ommState.position.map(toKilometer)
	const tleVelocityKms = tleState.velocity.map(toKilometerPerSecond)
	const ommVelocityKms = ommState.velocity.map(toKilometerPerSecond)

	expectVector(tlePositionKm, ommPositionKm, 5)
	expectVector(tleVelocityKms, ommVelocityKms, 7)
})

test('invalid OMM propagation throws', () => {
	expect(() => sgp4(ISS_TLE.epoch, { ...ISS_OMM, ECCENTRICITY: 1.2 })).toThrow()
})

for (const { title, tle, results } of VALLADO_CASES) {
	for (const sample of results) {
		test(`${title} at ${sample.time} min`, () => {
			const time = { day: tle.epoch.day, fraction: tle.epoch.fraction + sample.time / DAYMIN, scale: 1 }
			const state = sgp4(time, tle)
			const positionKm = state.position.map(toKilometer)
			const velocityKms = state.velocity.map(toKilometerPerSecond)
			expectVector(positionKm, sample.position, 1)
			expectVector(velocityKms, sample.velocity, 4)
		})
	}
}

test('TEME to ITRF by GMST matches reference rotation', () => {
	const itrf = temeToItrfByGmst([6400, 0, 0], 10)
	expectVector(itrf as unknown as number[], [-5370.057786089295, 3481.7351096919665, 0], 9)
})

test('ITRF to TEME by GMST matches reference rotation', () => {
	const teme = itrfToTemeByGmst([5555, 3000, 0], 100)
	expectVector(teme as unknown as number[], [6309.278258887361, -225.90451950165834, 0], 9)
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

function expectVector(actual: readonly number[], expected: readonly number[], digits: number) {
	for (let i = 0; i < 3; i++) {
		expect(actual[i]).toBeCloseTo(expected[i], digits)
	}
}
