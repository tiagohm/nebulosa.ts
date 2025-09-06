import { expect, test } from 'bun:test'
import { deg, mas, normalizeAngle, toDeg } from '../src/angle'
import { equatorial } from '../src/astrometry'
import { meter } from '../src/distance'
import { eraC2s } from '../src/erfa'
import { precessFk5FromJ2000 } from '../src/fk5'
import { Ellipsoid, geodeticLocation } from '../src/location'
import { spaceMotion, star } from '../src/star'
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

const EARTH_BARYCENTRIC_POSITION = [0.898130398596482138, -0.433663195905678422, -0.188058184681577339] as const
const EARTH_BARYCENTRIC_VELOCITY = [0.00771448410893727, 0.013933051305241721, 0.006040258849858089] as const
const EARTH_HELIOCENTRIC_POSITION = [0.895306712606649513, -0.430362177777382893, -0.186583142291892129] as const

const TIME = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
TIME.location = geodeticLocation(deg(9.712156), deg(52.385639), meter(200), Ellipsoid.WGS84)
TIME.polarMotion = () => [0.0000012573132091648417, 0.0000020158008827406455]
TIME.delta = () => -0.3495186114062241

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

test('space motion', () => {
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const b = spaceMotion(s, TIME)

	expect(b[0][0]).toBeCloseTo(5448758.569350527599453926, 5)
	expect(b[0][1]).toBeCloseTo(-646839.923422771040350199, 5)
	expect(b[0][2]).toBeCloseTo(7093562.290912019088864326, 5)

	const eq = equatorial(b[0])
	expect(toDeg(normalizeAngle(eq[0]))).toBeCloseTo(353.229915499721528249, 11)
	expect(toDeg(eq[1])).toBeCloseTo(52.277300341846739684, 11)
})

test('hadec', () => {
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const b = spaceMotion(s, TIME)
	const c = b.observeAt(TIME, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)

	expect(toDeg(c.hourAngle)).toBeCloseTo(-0.295079443830661481, 16)
	expect(toDeg(c.declination)).toBeCloseTo(52.295490632814043863, 16)
})

test('altaz', () => {
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const b = spaceMotion(s, TIME)
	const c = b.observeAt(TIME, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)

	expect(toDeg(c.azimuth)).toBeCloseTo(116.449852106047814004, 16)
	expect(toDeg(c.altitude)).toBeCloseTo(89.798433978304871061, 16)
})

test('observed altaz', () => {
	const s = star(STAR.ra, STAR.dec, STAR.pmRa, STAR.pmDec, STAR.parallax, STAR.radialVelocity)
	const b = spaceMotion(s, TIME)
	const c = b.observeAt(TIME, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, undefined)

	expect(toDeg(c.azimuth)).toBeCloseTo(116.449852106047814004, 16)
	expect(toDeg(c.altitude)).toBeCloseTo(89.798489836226210059, 16)
})

test('sirius', () => {
	const sirius = star(deg(101.27724), deg(-16.7225), mas(-415.12), mas(-1163.79), mas(378.932), kilometerPerSecond(-10))
	const time = timeYMDHMS(2025, 7, 27, 15, 0, 0, Timescale.UTC)
	const pv = spaceMotion(sirius, time)
	const [ra, dec] = eraC2s(...precessFk5FromJ2000(pv[0], time))

	expect(toDeg(ra)).toBeCloseTo(101.559918, 5)
	expect(toDeg(dec)).toBeCloseTo(-16.75894, 5)
})
