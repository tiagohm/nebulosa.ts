import { describe, expect, test } from 'bun:test'
import { elements, type ObserverWithOsculatingElements, type ObserverWithTLE, observer, Quantity, spkFile, vector } from '../../../src/adapters/ephemeris/horizons'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { extendedPermanentAsteroidNumber } from '../../../src/astronomy/ephemeris/kernels/naif'
import { readSpk } from '../../../src/astronomy/ephemeris/kernels/spk'
import { temporalAdd, temporalFromDate } from '../../../src/astronomy/time/temporal'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import type { CsvRow } from '../../../src/io/csv'
import { bufferSource } from '../../../src/io/io'
import { deg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { isNetworkTestSkipped } from '../../util'

const SKIP = isNetworkTestSkipped()

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

	// multipleApparitions, useCap=true
	test('10P/Tempel', async () => {
		const data = await observer('DES=1000094;', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 178.72449, 12.29527, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 178.72149, 12.29906, null])
	})

	// fragmentsAndMultipleApparitions, useCap=true, useNoFrag=true
	test('141P/Machholz 2', async () => {
		const data = await observer('DES=141P;', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2025-Jan-29 13:05', null, null, 251.09106, -22.44842, null])
		expectCsvRow(data[12], ['2025-Jan-29 14:05', null, null, 251.09967, -22.44887, null])
	})

	test('no matches found', async () => {
		const data = await observer('DES=1;CAP;NOFRAG', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 })

		expect(data).toBeEmpty()
	})

	test('abortable', () => {
		const timeout = AbortSignal.timeout(1)
		expect(() => observer('10', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSize: 5 }, timeout)).toThrow('The operation timed out.')
	})
})

describe.skipIf(SKIP)('vector', () => {
	test('heliocentric', async () => {
		const data = await vector('3517;', '500@10', false, START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2460705.045939638', 'A.D. 2025-Jan-29 13:06:09.1847', '-2.149571488738122E+00', '1.018910170931182E+00', '3.615164337174673E-01', '-5.374645864381350E-03', '-8.633704330148255E-03', '-3.234286901867649E-03', null])
		expectCsvRow(data[12], ['2460705.087606304', 'A.D. 2025-Jan-29 14:06:09.1847', '-2.149795392672856E+00', '1.018550414462253E+00', '3.613816650969421E-01', '-5.372742980581967E-03', '-8.634606120106192E-03', '-3.234606861585134E-03', null])
	})

	test('baricentric', async () => {
		const data = await vector('3517;', '500@0', false, START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2460705.045939638', 'A.D. 2025-Jan-29 13:06:09.1847', '-2.155096413961354E+00', '1.014243443167678E+00', '3.596850901595253E-01', '-5.367403925254149E-03', '-8.636690845244856E-03', '-3.235714144763842E-03', null])
		expectCsvRow(data[12], ['2460705.087606304', 'A.D. 2025-Jan-29 14:06:09.1847', '-2.155320016146872E+00', '1.013883562270635E+00', '3.595502620747811E-01', '-5.365500957404396E-03', '-8.637592154495225E-03', '-3.236033901202517E-03', null])
	})

	test('geocentric', async () => {
		const data = await vector('3517;', 'geo', false, START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2460705.045939638', 'A.D. 2025-Jan-29 13:06:09.1847', '-1.522572644407135E+00', '3.218502625660731E-01', '5.934475950606689E-02', '8.180086938999673E-03', '1.477084018080435E-03', '1.149018696280016E-03', null])
		expectCsvRow(data[12], ['2460705.087606304', 'A.D. 2025-Jan-29 14:06:09.1847', '-1.522231937335528E+00', '3.219119772580897E-01', '5.939271036140176E-02', '8.173851227596406E-03', '1.485220263938200E-03', '1.152621943725131E-03', null])
	})

	test('coord', async () => {
		const data = await vector('3517;', 'coord', COORD, START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		expectCsvRow(data[0], ['2460705.045939638', 'A.D. 2025-Jan-29 13:06:09.1847', '-1.522564458470518E+00', '3.218164230069884E-01', '5.932018861328989E-02', '8.393282945422664E-03', '1.529036141711371E-03', '1.148496616690220E-03', null])
		expectCsvRow(data[12], ['2460705.087606304', 'A.D. 2025-Jan-29 14:06:09.1847', '-1.522215252413161E+00', '3.218814369034981E-01', '5.936811861082907E-02', '8.366261021949536E-03', '1.590719454840225E-03', '1.152148605406162E-03', null])
	})

	test('abortable', () => {
		const timeout = AbortSignal.timeout(1)
		expect(() => vector('3517;', '500@10', false, START_TIME, END_TIME, { stepSize: 5 }, timeout)).toThrow('The operation timed out.')
	})
})

describe.skipIf(SKIP)('elements', () => {
	test('geocentric', async () => {
		const data = await elements('3517;', 'geo', START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		// oxfmt-ignore
		expectCsvRow(data[0], ['2460705.045939638', 'A.D. 2025-Jan-29 13:06:09.1847', '5.076151998893912E+04', '6.406955885927493E-01',
    '1.767761817602172E+02', '1.110600628949704E+02', '8.555945784739336E+00', '2.460874201321110E+06',
    '3.809154904180858E+04', '-6.443390509045984E+06', '2.942921662778245E+02', '-1.262192721296706E-05',
    '9.999999999999998E+99', '9.999999999999998E+99', null])
		// oxfmt-ignore
		expectCsvRow(data[12], ['2460705.087606304', 'A.D. 2025-Jan-29 14:06:09.1847', '5.084577224293398E+04', '6.423938229399222E-01',
    '1.767742327022050E+02', '1.111136662482562E+02', '8.540886394421911E+00', '2.460874193403739E+06',
    '3.803510033877300E+04', '-6.431955973292991E+06', '2.943660430689314E+02', '-1.263441244009499E-05',
    '9.999999999999998E+99', '9.999999999999998E+99', null])
	})

	test('heliocentric', async () => {
		const data = await elements('3517;', '500@10', START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		// oxfmt-ignore
		expectCsvRow(data[0], ['2460705.045939638', 'A.D. 2025-Jan-29 13:06:09.1847', '9.626125032156391E-02', '2.024805810384511E+00',
    '3.153931419824746E+00', '1.870973460263747E+02', '1.826155631685617E+02', '2.460240063129224E+06',
    '2.938957881700907E-01', '1.366564895521035E+02', '1.435998950240283E+02', '2.240476920022481E+00',
    '2.456148029660451E+00', '1.224923984931869E+03', null])
		// oxfmt-ignore
		expectCsvRow(data[12], ['2460705.087606304', 'A.D. 2025-Jan-29 14:06:09.1847', '9.626123282326940E-02', '2.024805849180958E+00',
    '3.153931414633486E+00', '1.870973460894901E+02', '1.826155519362571E+02', '2.460240063080776E+06',
    '2.938957882589379E-01', '1.366687494899317E+02', '1.436104742056346E+02', '2.240476919570938E+00',
    '2.456147989960917E+00', '1.224923984561564E+03', null])
	})

	test('baricentric', async () => {
		const data = await elements('3517;', '500@0', START_TIME, END_TIME, { stepSize: 5 })

		expect(data).toHaveLength(13)
		// oxfmt-ignore
		expectCsvRow(data[0], ['2460705.045939638', 'A.D. 2025-Jan-29 13:06:09.1847', '9.790298315636420E-02', '2.022744212209568E+00',
    '3.153227451372054E+00', '1.871371001557924E+02', '1.834551954591608E+02', '2.460243065002398E+06',
    '2.937403949785908E-01', '1.357024629773156E+02', '1.428861264571564E+02', '2.242269040293455E+00',
    '2.461793868377342E+00', '1.225571988579366E+03', null])
		// oxfmt-ignore
		expectCsvRow(data[12], ['2460705.087606304', 'A.D. 2025-Jan-29 14:06:09.1847', '9.790211303213858E-02', '2.022747968182107E+00',
    '3.153227312743624E+00', '1.871371018336123E+02', '1.834554724840192E+02', '2.460243065253885E+06',
    '2.937400018170729E-01', '1.357144466390912E+02', '1.428964017316300E+02', '2.242271041096199E+00',
    '2.461794114010291E+00', '1.225573628967942E+03', null])
	})

	test('abortable', () => {
		const timeout = AbortSignal.timeout(1)
		expect(() => elements('3517;', 'geo', START_TIME, END_TIME, { stepSize: 5 }, timeout)).toThrow('The operation timed out.')
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
	const [[x, y, z], [vx, vy, vz]] = (await s.segment(10, 20003517))!.at(time)

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
