import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { readDaf } from '../src/daf'
import { dateFrom } from '../src/datetime'
import { meter } from '../src/distance'
import { type ObserverWithOsculatingElements, type ObserverWithTLE, observer, Quantity, spkFile, vector } from '../src/horizons'
import { bufferSource } from '../src/io'
import { extendedPermanentAsteroidNumber } from '../src/naif'
import { readSpk } from '../src/spk'
import { Timescale, timeYMDHMS } from '../src/time'

const START_TIME = dateFrom('2025-01-29T13:05:00Z')
const END_TIME = dateFrom('2025-01-29T14:05:00Z')
const COORD = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const

describe.skip('observer', () => {
	test('sun', async () => {
		const data = await observer('10', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '311.97007', '-17.86472', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '312.01347', '-17.85339', ''])
	})

	test('ceres using spk id', async () => {
		const data = await observer('DES=2000001;', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '324.49915', '-21.67686', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '324.51584', '-21.67183', ''])
	})

	test('ceres using iau number', async () => {
		const data = await observer('1;', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '324.49915', '-21.67686', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '324.51584', '-21.67183', ''])
	})

	test('103P/Hartley 2', async () => {
		const data = await observer('DES=1000041;CAP;NOFRAG', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '196.45927', '-15.59045', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '196.45822', '-15.59074', ''])
	})

	test('heliocentric', async () => {
		const data = await observer('3517;', '500@10', false, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '154.63538', '8.64237', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '154.64552', '8.63902', ''])
	})

	test('baricentric', async () => {
		const data = await observer('3517;', '500@0', false, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '154.79375', '8.58857', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '154.80387', '8.58523', ''])
	})

	test('geocentric', async () => {
		const data = await observer('3517;', 'geo', false, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '168.06103', '2.18497', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '168.05621', '2.18718', ''])
	})

	test('osculating elements', async () => {
		const input: ObserverWithOsculatingElements = { epoch: 2460049.5, ec: 0.6183399929327511, om: deg(30.04427847488657), w: deg(30.56835826458952), i: deg(19.84449491210952), tpqr: { qr: 0.3107780828530178, tp: 2459989.479453452084 } }
		const data = await observer(input, 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '283.27736', '-32.07919', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '283.31593', '-32.07911', ''])
	})

	test('tle', async () => {
		const input: ObserverWithTLE = { line1: 'ISS (ZARYA)', line2: '1 25544U 98067A   25029.70562785  .00020566  00000+0  35850-3 0  9990', line3: '2 25544  51.6387 272.9482 0002126 142.5311 315.5480 15.50695229493684' }
		const data = await observer(input, 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '246.97075', '-50.81172', ''])
		expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '22.50027', '-17.81843', ''])
	})

	test('multiple matches', async () => {
		const data = await observer('DES=1000041;', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toBeEmpty()
	})

	test('no matches found', async () => {
		const data = await observer('DES=1;CAP;NOFRAG', 'coord', COORD, START_TIME, END_TIME, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

		expect(data).toBeEmpty()
	})
})

describe.skip('vector', () => {
	test('heliocentric', async () => {
		const data = await vector('3517;', '500@10', false, START_TIME, END_TIME, { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', '-2.149567184894454E+00', '1.018917084516906E+00', '3.615190236263389E-01', '-5.374682433448360E-03', '-8.633686995748143E-03', '-3.234280751454736E-03', ''])
		expect(data[12]).toEqual(['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', '-2.149791090352952E+00', '1.018557328770104E+00', '3.613842552620288E-01', '-5.372779552205708E-03', '-8.634588792419016E-03', '-3.234600713675118E-03', ''])
	})

	test('baricentric', async () => {
		const data = await vector('3517;', '500@0', false, START_TIME, END_TIME, { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', '-2.155092115916659E+00', '1.014250359144854E+00', '3.596876812112615E-01', '-5.367440495937387E-03', '-8.636673520083184E-03', '-3.235707998257602E-03', ''])
		expect(data[12]).toEqual(['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', '-2.155315719626009E+00', '1.013890478969553E+00', '3.595528533825696E-01', '-5.365537530642501E-03', '-8.637574836046069E-03', '-3.236027757199044E-03', ''])
	})

	test('geocentric', async () => {
		const data = await vector('3517;', 'geo', false, START_TIME, END_TIME, { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', '-1.522579194562664E+00', '3.218490800192935E-01', '5.934383951825029E-02', '8.180206701248126E-03', '1.476927601421201E-03', '1.148949424888624E-03', ''])
		expect(data[12]).toEqual(['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', '-1.522238482497910E+00', '3.219107881961943E-01', '5.939178748827646E-02', '8.173971136358307E-03', '1.485063955077576E-03', '1.152552720314612E-03', ''])
	})

	test('coord', async () => {
		const data = await vector('3517;', 'coord', COORD, START_TIME, END_TIME, { stepSizeInMinutes: 5 })

		expect(data).toHaveLength(13)
		expect(data[0]).toEqual(['2460705.045138889', 'A.D. 2025-Jan-29 13:05:00.0000', '-1.522571179446716E+00', '3.218151992904175E-01', '5.931926904376639E-02', '8.393662092679492E-03', '1.527803485374843E-03', '1.148426752101660E-03', ''])
		expect(data[12]).toEqual(['2460705.086805556', 'A.D. 2025-Jan-29 14:05:00.0000', '-1.522221951859907E+00', '3.218801637522551E-01', '5.936719611723293E-02', '8.366910724741850E-03', '1.589591091720874E-03', '1.152078125220753E-03', ''])
	})
})

test.skip('spkFile', async () => {
	const file = await spkFile(extendedPermanentAsteroidNumber(3517), START_TIME, END_TIME)

	expect(file.spk).not.toBeEmpty()

	const buffer = Buffer.from(file.spk!, 'base64')
	const daf = await readDaf(bufferSource(buffer))
	const s = readSpk(daf)

	expect(s.segments).toHaveLength(1)
	expect(s.segment(10, 20003517)).not.toBeUndefined()

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
