import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { readDaf } from '../src/daf'
import { meter } from '../src/distance'
import { elements, type ObserverWithOsculatingElements, type ObserverWithTLE, observer, Quantity, spkFile, vector } from '../src/horizons'
import { bufferSource } from '../src/io'
import { extendedPermanentAsteroidNumber } from '../src/naif'
import { readSpk } from '../src/spk'
import { temporalAdd, temporalFromDate } from '../src/temporal'
import { Timescale, timeYMDHMS } from '../src/time'
import type { CsvRow } from '../src/csv'

const SKIP = Bun.env.RUN_SKIPPED_TESTS !== 'true'

const START_TIME = temporalFromDate(2025, 1, 29, 13, 5, 0, 0)
const END_TIME = temporalFromDate(2025, 1, 29, 14, 5, 0, 0)
const COORD = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const

describe.skipIf(SKIP)('observer', () => {
	test('sun', async () => {
		const data = await observer('10', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 311.97007, -17.86472, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 312.01347, -17.85339, null])
	})

	test('ceres using spk id', async () => {
		const data = await observer('DES=2000001;', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 324.49915, -21.67686, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 324.51584, -21.67183, null])
	})

	test('ceres using iau number', async () => {
		const data = await observer('1;', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 324.49915, -21.67686, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 324.51584, -21.67183, null])
	})

	test('103P/Hartley 2', async () => {
		const data = await observer('DES=1000041;CAP;NOFRAG', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 196.45927, -15.59045, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 196.45822, -15.59074, null])
	})

	test('heliocentric', async () => {
		const data = await observer('3517;', '500@10', false, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 154.63538, 8.64237, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 154.64552, 8.63902, null])
	})

	test('baricentric', async () => {
		const data = await observer('3517;', '500@0', false, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 154.79375, 8.58857, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 154.80387, 8.58523, null])
	})

	test('geocentric', async () => {
		const data = await observer('3517;', 'geo', false, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 168.06103, 2.18497, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 168.05621, 2.18718, null])
	})

	test('osculating elements', async () => {
		const input: ObserverWithOsculatingElements = { epoch: 2460049.5, ec: 0.6183399929327511, om: deg(30.04427847488657), w: deg(30.56835826458952), i: deg(19.84449491210952), tpqr: { qr: 0.3107780828530178, tp: 2459989.479453452084 } }
		const data = await observer(input, 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 283.27736, -32.07919, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 283.31593, -32.07911, null])
	})

	test('tle', async () => {
		const input: ObserverWithTLE = { name: 'ISS (ZARYA)', line1: '1 25544U 98067A   25029.70562785  .00020566  00000+0  35850-3 0  9990', line2: '2 25544  51.6387 272.9482 0002126 142.5311 315.5480 15.50695229493684' }
		const data = await observer(input, 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 246.97075, -50.81172, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 22.50027, -17.81843, null])
	})

	test('timezone', async () => {
		const data = await observer('10', 'coord', COORD, temporalAdd(START_TIME, -3, 'h'), temporalAdd(END_TIME, -3, 'h'), [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5, timeZone: -180 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 10:05', null, null, 311.97007, -17.86472, null])
		expectCsvRow(data[12], ['2025-Jan-29 11:05', null, null, 312.01347, -17.85339, null])
	})

	test('multiple matches', async () => {
		const data = await observer('DES=1000041;', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toBeEmpty()
	})

	test('no matches found', async () => {
		const data = await observer('DES=1;CAP;NOFRAG', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toBeEmpty()
	})
})

describe.skipIf(SKIP)('vector', () => {
	test('heliocentric', async () => {
		const data = await vector('3517;', '500@10', false, START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', -2.149567184894454, 1.018917084516906, 3.615190236263389e-1, -5.37468243344836e-3, -8.633686995748143e-3, -3.234280751454736e-3, null])
		expectCsvRow(data[12], ['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', -2.149791090352952, 1.018557328770104, 3.613842552620288e-1, -5.372779552205708e-3, -8.634588792419016e-3, -3.234600713675118e-3, null])
	})

	test('baricentric', async () => {
		const data = await vector('3517;', '500@0', false, START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', -2.155092115916659, 1.014250359144854, 3.596876812112615e-1, -5.367440495937387e-3, -8.636673520083184e-3, -3.235707998257602e-3, null])
		expectCsvRow(data[12], ['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', -2.155315719626009, 1.013890478969553, 3.595528533825696e-1, -5.365537530642501e-3, -8.637574836046069e-3, -3.236027757199044e-3, null])
	})

	test('geocentric', async () => {
		const data = await vector('3517;', 'geo', false, START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', -1.522579194562664, 3.218490800192935e-1, 5.934383951825029e-2, 8.180206701248126e-3, 1.476927601421201e-3, 1.148949424888624e-3, null])
		expectCsvRow(data[12], ['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', -1.52223848249791, 3.219107881961943e-1, 5.939178748827646e-2, 8.173971136358307e-3, 1.485063955077576e-3, 1.152552720314612e-3, null])
	})

	test('coord', async () => {
		const data = await vector('3517;', 'coord', COORD, START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', -1.522571179446716, 3.218151992904175e-1, 5.931926904376639e-2, 8.393662092679492e-3, 1.527803485374843e-3, 1.14842675210166e-3, null])
		expectCsvRow(data[12], ['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', -1.522221951859907, 3.218801637522551e-1, 5.936719611723293e-2, 8.36691072474185e-3, 1.589591091720874e-3, 1.152078125220753e-3, null])
	})
})

describe.skipIf(SKIP)('elements', () => {
	test('geocentric', async () => {
		const data = await elements('3517;', 'geo', START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		// oxfmt-ignore
		expectCsvRow(data[0], ['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', 5.075989856598472e+04, 6.406629484159172e-01, 1.767762192320328e+02, 1.110590308148978e+02, 8.556232886619721e+00, 2.460874201469467e+06, 3.80926348432509e+04, -6.443610332109937e+06, 2.942907470343795e+02, -1.262168735956867e-05, 9.999999999999998e+99, 9.999999999999998e+99, null])
		// oxfmt-ignore
		expectCsvRow(data[12], ['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', 5.084415528751679e+04, 6.423611902514889e-01, 1.767742701450048e+02, 1.111126379080121e+02, 8.541177967401689e+00, 2.460874193559542e+06, 3.803618421497873e+04, -6.432175646621299e+06, 2.943646228293845e+02, -1.263417241945257e-05, 9.999999999999998e+99, 9.999999999999998e+99, null])
	})

	test('heliocentric', async () => {
		const data = await elements('3517;', '500@10', START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		// oxfmt-ignore
		expectCsvRow(data[0], ['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', 9.626125065683018e-02, 2.024805809650671e+00, 3.153931420013101e+00, 1.870973460247965e+02, 1.8261556338372e+02, 2.460240063130166e+06, 2.938957881663205e-01, 1.366562539368875e+02, 1.435996917076657e+02, 2.240476920041642e+00, 2.456148030432614e+00, 1.224923984947583e+03, null])
		// oxfmt-ignore
		expectCsvRow(data[12], ['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', 9.626123315860895e-02, 2.0248058484467e+00, 3.153931414822223e+00, 1.870973460879077e+02, 1.826155521514409e+02, 2.460240063081718e+06, 2.938957882552231e-01, 1.366685138746856e+02, 1.43610270893889e+02, 2.240476919589817e+00, 2.456147990732935e+00, 1.224923984577047e+03, null])
	})

	test('baricentric', async () => {
		const data = await elements('3517;', '500@0', START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		// oxfmt-ignore
		expectCsvRow(data[0], ['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', 9.790299987687517e-02, 2.022744140036757e+00, 3.153227454124507e+00, 1.871371001231866e+02, 1.834551901325484e+02, 2.460243064997569e+06, 2.937404025330726e-01, 1.357022326736086e+02, 1.428859289833058e+02, 2.242269001848668e+00, 2.461793863660579e+00, 1.22557195705983e+03, null])
		// oxfmt-ignore
		expectCsvRow(data[12], ['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', 9.790212975450596e-02, 2.022747896009554e+00, 3.153227315497593e+00, 1.871371018010009e+02, 1.834554671611777e+02, 2.46024306524907e+06, 2.937400093705607e-01, 1.357142163316099e+02, 1.428962042586936e+02, 2.242271002656385e+00, 2.461794109303217e+00, 1.225573597452469e+03, null])
	})
})

test.skipIf(SKIP)('spkFile', async () => {
	const file = await spkFile(extendedPermanentAsteroidNumber(3517), START_TIME, END_TIME)

	expect(file.spk).not.toBeEmpty()

	const buffer = Buffer.from(file.spk!, 'base64')
	const daf = await readDaf(bufferSource(buffer))
	const s = readSpk(daf)

	expect(s.segments).toHaveLength(1)
	expect(s.segment(10, 20003517)).toBeDefined()

	const time = timeYMDHMS(2025, 1, 29, 13, 30, 0, Timescale.TDB)
	const [[x, y, z], [vx, vy, vz]] = await s.segment(10, 20003517)!.at(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	// Target body name: 3517 Tatianicheva (1976 SE1)    {source: JPL#59}
	// Center body name: Sun (10)                        {source: DE441}
	expect(x).toBeCloseTo(-2.149660487697748, 8)
	expect(y).toBeCloseTo(1.018767192134325, 8)
	expect(z).toBeCloseTo(3.614628721866353e-1, 9)
	expect(vx).toBeCloseTo(-5.373889588848743e-3, 10)
	expect(vy).toBeCloseTo(-8.634062784008313e-3, 10)
	expect(vz).toBeCloseTo(-3.234414083822303e-3, 10)
})

function expectCsvRow(row: CsvRow, expected: readonly (string | number | null)[]) {
	for (let i = 0; i < expected.length; i++) {
		const a = row[i]
		const b = expected[i]

		if (b === null) continue
		if (typeof b === 'string') expect(a).toBe(b)
		else expect(+a).toBeCloseTo(b, 8 - numberOfDigits(b))
	}
}

function numberOfDigits(n: number) {
	let i = 1
	for (n = Math.abs(Math.trunc(n / 10)); n > 0; i++, n = Math.trunc(n / 10));
	return i
}
