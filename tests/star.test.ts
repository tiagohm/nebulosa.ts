import { expect, test } from 'bun:test'
import { deg, mas, normalizeAngle, toDeg } from '../src/angle'
import { altaz, cirs, equatorial, gcrs, hadec } from '../src/astrometry'
import { ONE_ATM } from '../src/constants'
import type { CartesianCoordinate } from '../src/coordinate'
import { meter } from '../src/distance'
import { eraC2s } from '../src/erfa'
import { precessFk5FromJ2000 } from '../src/fk5'
import { Ellipsoid, geodeticLocation } from '../src/location'
import { bcrs, star } from '../src/star'
import { Timescale, timeYMDHMS } from '../src/time'
import { kilometerPerSecond } from '../src/velocity'

const STAR = {
	ra: deg(353.22987757),
	dec: deg(52.27730247),
	// astropy works with pm_ra * cos(dec)
	pmRa: mas(22.9) / Math.cos(deg(52.27730247)),
	pmDec: mas(-2.1),
	parallax: mas(23),
	radialVelocity: kilometerPerSecond(25),
}

const EARTH_BARYCENTRIC_POSITION: CartesianCoordinate = [0.898130398596, -0.433663195906, -0.188058184682]
const EARTH_BARYCENTRIC_VELOCITY: CartesianCoordinate = [0.007714484109, 0.013933051305, 0.00604025885]
const EARTH_HELIOCENTRIC_POSITION: CartesianCoordinate = [0.895306712607, -0.430362177777, -0.186583142292]

test('icrs', () => {
	const i = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)

	expect(i[0][0]).toBeCloseTo(5448746.190298263914883137, 12)
	expect(i[0][1]).toBeCloseTo(-646842.111761026666499674, 12)
	expect(i[0][2]).toBeCloseTo(7093547.2769207460805773, 12)
	// astropy is less accurate?
	expect(i[1][0]).toBeCloseTo(0.009290286063694588, 6)
	expect(i[1][1]).toBeCloseTo(0.001642201835270349, 6)
	expect(i[1][2]).toBeCloseTo(0.011267800512088356, 6)

	const eq = equatorial(i[0])
	expect(toDeg(normalizeAngle(eq[0]))).toBeCloseTo(353.229877569999985099, 18)
	expect(toDeg(eq[1])).toBeCloseTo(52.277302470000002188, 18)
})

test('bcrs', () => {
	const time = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const b = bcrs(s, time)

	expect(b[0][0]).toBeCloseTo(5448758.569350527599453926, 5)
	expect(b[0][1]).toBeCloseTo(-646839.923422771040350199, 5)
	expect(b[0][2]).toBeCloseTo(7093562.290912019088864326, 5)

	const eq = equatorial(b[0])
	expect(toDeg(normalizeAngle(eq[0]))).toBeCloseTo(353.229915499721528249, 11)
	expect(toDeg(eq[1])).toBeCloseTo(52.277300341846739684, 11)
})

test('gcrs', () => {
	const time = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const g = gcrs(s[0], time, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION)

	const d = 1 // distance(s[0])

	expect(g[0]).toBeCloseTo(d * 0.6075889443530471, 10)
	expect(g[1]).toBeCloseTo(d * -0.07204348576104898, 11)
	expect(g[2]).toBeCloseTo(d * 0.7909775033838493, 10)

	const eq = equatorial(g)
	expect(toDeg(normalizeAngle(eq[0]))).toBeCloseTo(353.237855279679308751, 11)
	expect(toDeg(eq[1])).toBeCloseTo(52.276954755952054654, 11)
})

test('cirs', () => {
	const time = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const c = cirs(s[0], time, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION)

	const d = 1 // distance(s[0])

	expect(c[0]).toBeCloseTo(d * 0.6073279222993754, 10)
	expect(c[1]).toBeCloseTo(d * -0.07206511093641904, 11)
	expect(c[2]).toBeCloseTo(d * 0.7911759694159357, 10)

	const eq = equatorial(c)
	expect(toDeg(normalizeAngle(eq[0]))).toBeCloseTo(353.232964105577707414, 11)
	expect(toDeg(eq[1])).toBeCloseTo(52.295543854747897683, 11)
})

test('hadec', () => {
	const time = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	time.location = geodeticLocation(deg(9.712156), deg(52.385639), meter(200), Ellipsoid.WGS84)
	time.polarMotion = () => [0.0000012573132091648417, 0.0000020158008827406455]
	time.delta = () => -0.3495186114062241
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const c = hadec(s[0], time, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)!

	expect(toDeg(c[0])).toBeCloseTo(-0.295041500325083861, 11)
	expect(toDeg(c[1])).toBeCloseTo(52.295492760874715543, 11)
})

test('altaz', () => {
	const time = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	time.location = geodeticLocation(deg(9.712156), deg(52.385639), meter(200), Ellipsoid.WGS84)
	time.polarMotion = () => [0.0000012573132091648417, 0.0000020158008827406455]
	time.delta = () => -0.3495186114062241
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const c = altaz(s[0], time, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)!

	expect(toDeg(c[0])).toBeCloseTo(116.452274040350133077, 9)
	expect(toDeg(c[1])).toBeCloseTo(89.798455668201469848, 11)
})

test('observed altaz', () => {
	const time = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	time.location = geodeticLocation(deg(9.712156), deg(52.385639), meter(200), Ellipsoid.WGS84)
	time.polarMotion = () => [0.0000012573132091648417, 0.0000020158008827406455]
	time.delta = () => -0.3495186114062241
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const c = altaz(s[0], time, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, { pressure: ONE_ATM, relativeHumidity: 0 })!

	expect(toDeg(c[0])).toBeCloseTo(116.452274040350133077, 9)
	expect(toDeg(c[1])).toBeCloseTo(89.798511588010399009, 11)
})

test('sirius', () => {
	const sirius = star(deg(101.27724), deg(-16.7225), mas(-415.12), mas(-1163.79), mas(378.932), kilometerPerSecond(-10))
	const time = timeYMDHMS(2025, 7, 27, 15, 0, 0, Timescale.UTC)
	const pv = bcrs(sirius, time)
	const [ra, dec] = eraC2s(...precessFk5FromJ2000(pv[0], time))

	expect(toDeg(ra)).toBeCloseTo(101.559918, 5)
	expect(toDeg(dec)).toBeCloseTo(-16.75894, 5)
})
