import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { readDaf } from '../src/daf'
import { dateFrom } from '../src/datetime'
import { meter } from '../src/distance'
import { type ObserverWithOsculatingElementsParameters, Quantity, observer, observerWithOsculatingElements, observerWithTle, spkFile } from '../src/horizons'
import { bufferSource } from '../src/io'
import { extendedPermanentAsteroidNumber } from '../src/naif'
import { readSpk } from '../src/spk'
import { Timescale, timeYMDHMS } from '../src/time'

test.skip('observer', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const coord = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const
	const [header, ...data] = await observer('10', 'coord', coord, startTime, endTime, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

	expect(header).toHaveLength(5)
	expect(header).toEqual(['Date__(UT)__HR:MN', '', '', 'R.A._(ICRF)', 'DEC_(ICRF)'])
	expect(data).toHaveLength(13)
	expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '311.97007', '-17.86472'])
	expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '312.01347', '-17.85339'])
})

test.skip('observerBySpkId', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const coord = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const
	const [header, ...data] = await observer('DES=2000001;', 'coord', coord, startTime, endTime, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

	expect(header).toHaveLength(5)
	expect(header).toEqual(['Date__(UT)__HR:MN', '', '', 'R.A._(ICRF)', 'DEC_(ICRF)'])
	expect(data).toHaveLength(13)
	expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '324.49915', '-21.67686'])
	expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '324.51584', '-21.67183'])
}, 1000000)

test.skip('observerByIauNumber', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const coord = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const
	const [header, ...data] = await observer('1;', 'coord', coord, startTime, endTime, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

	expect(header).toHaveLength(5)
	expect(header).toEqual(['Date__(UT)__HR:MN', '', '', 'R.A._(ICRF)', 'DEC_(ICRF)'])
	expect(data).toHaveLength(13)
	expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '324.49915', '-21.67686'])
	expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '324.51584', '-21.67183'])
})

test.skip('observerBySpkIdAndCapAndNoFrag', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const coord = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const
	const [header, ...data] = await observer('DES=1000041;CAP;NOFRAG', 'coord', coord, startTime, endTime, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

	expect(header).toHaveLength(5)
	expect(header).toEqual(['Date__(UT)__HR:MN', '', '', 'R.A._(ICRF)', 'DEC_(ICRF)'])
	expect(data).toHaveLength(13)
	expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '196.45927', '-15.59045'])
	expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '196.45822', '-15.59074'])
})

test.skip('observerWithNonUniqueObject', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const coord = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const
	const data = await observer('DES=1000041;', 'coord', coord, startTime, endTime, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })
	expect(data).toBeEmpty()
})

test.skip('observerWithNoMatchFound', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const coord = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const
	const data = await observer('DES=1;CAP;NOFRAG', 'coord', coord, startTime, endTime, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })
	expect(data).toBeEmpty()
})

test.skip('observerWithOsculatingElements', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const coord = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const
	const parameters: ObserverWithOsculatingElementsParameters = { epoch: 2460049.5, ec: 0.6183399929327511, om: deg(30.04427847488657), w: deg(30.56835826458952), i: deg(19.84449491210952), pdt: { qr: 0.3107780828530178, tp: 2459989.479453452084 } }
	const [header, ...data] = await observerWithOsculatingElements(parameters, coord, startTime, endTime, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

	expect(header).toHaveLength(5)
	expect(header).toEqual(['Date__(UT)__HR:MN', '', '', 'R.A._(ICRF)', 'DEC_(ICRF)'])
	expect(data).toHaveLength(13)
	expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '283.27736', '-32.07919'])
	expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '283.31593', '-32.07911'])
})

test.skip('observerWithTle', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const coord = [deg(138.73119026648095), deg(35.36276754848444), meter(3776)] as const
	const tle = 'ISS (ZARYA)\n1 25544U 98067A   25029.70562785  .00020566  00000+0  35850-3 0  9990\n2 25544  51.6387 272.9482 0002126 142.5311 315.5480 15.50695229493684'
	const [header, ...data] = await observerWithTle(tle, coord, startTime, endTime, [Quantity.ASTROMETRIC_RA_DEC], { stepSizeInMinutes: 5 })

	expect(header).toHaveLength(5)
	expect(header).toEqual(['Date__(UT)__HR:MN', '', '', 'R.A._(ICRF)', 'DEC_(ICRF)'])
	expect(data).toHaveLength(13)
	expect(data[0]).toEqual(['2025-Jan-29 13:05', '', '', '246.97075', '-50.81172'])
	expect(data[12]).toEqual(['2025-Jan-29 14:05', '', '', '22.50027', '-17.81843'])
})

test.skip('spkFile', async () => {
	const startTime = dateFrom('2025-01-29T13:05:00Z')
	const endTime = dateFrom('2025-01-29T14:05:00Z')
	const file = await spkFile(extendedPermanentAsteroidNumber(3517), startTime, endTime)

	expect(file.spk).not.toBeEmpty()

	const buffer = Buffer.from(file.spk!, 'base64')
	const daf = await readDaf(bufferSource(buffer))
	const s = readSpk(daf)

	expect(s.segments).toHaveLength(1)
	expect(s.segment(10, 20003517)).not.toBeUndefined()

	const time = timeYMDHMS(2025, 1, 29, 13, 30, 0, Timescale.TDB)
	const [[x, y, z], [vx, vy, vz]] = await s.segment(10, 20003517)!.compute(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	// Target body name: 3517 Tatianicheva (1976 SE1)    {source: JPL#59}
	// Center body name: Sun (10)                        {source: DE441}
	expect(x).toBeCloseTo(-2.149660487697748, 9)
	expect(y).toBeCloseTo(1.018767192134325, 9)
	expect(z).toBeCloseTo(3.614628721866353e-1, 9)
	expect(vx).toBeCloseTo(-5.373889588848743e-3, 11)
	expect(vy).toBeCloseTo(-8.634062784008313e-3, 11)
	expect(vz).toBeCloseTo(-3.234414083822303e-3, 11)
})
