import { beforeAll, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { deg, toHour } from './angle'
import { meter } from './distance'
import { iersb } from './iers'
import { fileHandleSource } from './io'
import { Ellipsoid, geocentric, geodetic, lst, polarRadius } from './location'
import { Timescale, timeYMDHMS } from './time'

beforeAll(async () => {
	const handle = await fs.open('data/eopc04.1962-now.txt')
	await using source = fileHandleSource(handle)
	source.seek(4640029)
	await iersb.load(source)
})

test('lst', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	const p = geodetic(deg(-45), deg(-23), meter(890))
	expect(toHour(lst(p, t, false, false))).toBeCloseTo(10.106038262872143463, 14)
	expect(toHour(lst(p, t, true, false))).toBeCloseTo(10.106345240224239745, 14)
	expect(toHour(lst(p, t, false, 'sp'))).toBeCloseTo(10.106038262691395602, 14)
	expect(toHour(lst(p, t, true, 'sp'))).toBeCloseTo(10.10634524004349899, 13)
	expect(toHour(lst(p, t, false, true))).toBeCloseTo(10.106038262690191232, 15)
	expect(toHour(lst(p, t, true, true))).toBeCloseTo(10.106345240042289291, 14)
})

test('geocentric', () => {
	const p = geocentric(meter(4154201.0724025597), meter(-4154201.072402559), meter(-2477066.8839821406))
	expect(p.longitude).toBeCloseTo(deg(-45), 22)
	expect(p.latitude).toBeCloseTo(deg(-23), 22)
	expect(p.elevation).toBeCloseTo(meter(890), 20)
	expect(p.itrs).not.toBeUndefined()
})

test('polarRadius', () => {
	expect(polarRadius(Ellipsoid.IERS2010)).toBeCloseTo(0.000042492261609253282, 20)
	expect(polarRadius(Ellipsoid.WGS84)).toBeCloseTo(0.000042492264659253469, 20)
})
