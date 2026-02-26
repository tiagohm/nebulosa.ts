import { expect, test } from 'bun:test'
import { deg, formatDEC, hour, toHour } from '../src/angle'
import { meter } from '../src/distance'
import { eraS2c } from '../src/erfa'
import { Ellipsoid, gcrs, geocentricLocation, geodeticLocation, localSiderealTime, polarRadius, rhoCosPhi, rhoSinPhi, subpoint } from '../src/location'
import { matTransposeMul } from '../src/mat3'
import { Timescale, timeYMDHMS } from '../src/time'

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

test('gcrs dRdtTimesRtAt is skew-symmetric', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	const p = geodeticLocation(deg(-45), deg(-23), meter(890))
	const m = gcrs(p).dRdtTimesRtAt!(t)

	expect(m[0]).toBeCloseTo(0, 15)
	expect(m[4]).toBeCloseTo(0, 15)
	expect(m[8]).toBeCloseTo(0, 15)
	expect(m[1]).toBeCloseTo(-m[3], 15)
	expect(m[2]).toBeCloseTo(-m[6], 15)
	expect(m[5]).toBeCloseTo(-m[7], 15)
})

test('gcrs dRdtTimesRtAt varies with time', () => {
	const p = geodeticLocation(deg(-45), deg(-23), meter(890))
	const a = gcrs(p).dRdtTimesRtAt!(timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC))
	const b = gcrs(p).dRdtTimesRtAt!(timeYMDHMS(2020, 7, 1, 0, 0, 0, Timescale.UTC))

	expect(a).not.toEqual(b)
})

test('gcrs rotationAt is orthonormal', () => {
	const p = geodeticLocation(deg(-45), deg(-23), meter(890))
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	const m = gcrs(p).rotationAt(t)
	const mtm = matTransposeMul(m, m)

	expect(mtm[0]).toBeCloseTo(1, 14)
	expect(mtm[4]).toBeCloseTo(1, 14)
	expect(mtm[8]).toBeCloseTo(1, 14)
	expect(mtm[1]).toBeCloseTo(0, 14)
	expect(mtm[2]).toBeCloseTo(0, 14)
	expect(mtm[3]).toBeCloseTo(0, 14)
	expect(mtm[5]).toBeCloseTo(0, 14)
	expect(mtm[6]).toBeCloseTo(0, 14)
	expect(mtm[7]).toBeCloseTo(0, 14)
})
