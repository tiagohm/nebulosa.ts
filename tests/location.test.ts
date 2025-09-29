import { beforeAll, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { deg, formatDEC, hour, toHour } from '../src/angle'
import { meter } from '../src/distance'
import { eraS2c } from '../src/erfa'
import { iersb } from '../src/iers'
import { fileHandleSource } from '../src/io'
import { Ellipsoid, geocentricLocation, geodeticLocation, localSiderealTime, polarRadius, rhoCosPhi, rhoSinPhi, subpoint } from '../src/location'
import { Timescale, timeYMDHMS } from '../src/time'

beforeAll(async () => {
	const handle = await fs.open('data/eopc04.1962-now.txt')
	await using source = fileHandleSource(handle)
	source.seek(4640029)
	await iersb.load(source)
})

test('lst', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	const p = geodeticLocation(deg(-45), deg(-23), meter(890))
	expect(toHour(localSiderealTime(t, p, false, false))).toBeCloseTo(10.106038262872143463, 14)
	expect(toHour(localSiderealTime(t, p, true, false))).toBeCloseTo(10.106345240224239745, 14)
	expect(toHour(localSiderealTime(t, p, false, 'sp'))).toBeCloseTo(10.106038262691395602, 14)
	expect(toHour(localSiderealTime(t, p, true, 'sp'))).toBeCloseTo(10.10634524004349899, 13)
	expect(toHour(localSiderealTime(t, p, false, true))).toBeCloseTo(10.106038262690191232, 15)
	expect(toHour(localSiderealTime(t, p, true, true))).toBeCloseTo(10.106345240042289291, 14)
})

test('geocentric', () => {
	const p = geocentricLocation(meter(4154201.0724025597), meter(-4154201.072402559), meter(-2477066.8839821406))
	expect(p.longitude).toBeCloseTo(deg(-45), 22)
	expect(p.latitude).toBeCloseTo(deg(-23), 22)
	expect(p.elevation).toBeCloseTo(meter(890), 20)
})

test('polar radius', () => {
	expect(polarRadius(Ellipsoid.IERS2010)).toBeCloseTo(0.000042492261609253282, 20)
	expect(polarRadius(Ellipsoid.WGS84)).toBeCloseTo(0.000042492264659253469, 20)
})

test('rhoCosPhi', () => {
	const p = geodeticLocation(deg(-45), deg(-23), meter(890))
	expect(rhoCosPhi(p)).toBeCloseTo(0.9211040554231795, 8)
})

test('rhoSinPhi', () => {
	const p = geodeticLocation(deg(-45), deg(-23), meter(890))
	expect(rhoSinPhi(p)).toBeCloseTo(-0.388368434808665, 8)
})

test('subpoint', () => {
	const t = timeYMDHMS(2020, 1, 3, 12, 45, 0, Timescale.UTC)
	const p = subpoint(eraS2c(hour(3.79), deg(24.1167)), t)

	expect(formatDEC(p.latitude)).toBe('+24 10 33.80')
	expect(formatDEC(p.longitude)).toBe('+123 16 53.90')
})
