import { expect, test } from 'bun:test'
import { observeStar, type Star, spaceMotion, star } from '../../../src/astronomy/bodies/star'
import { equatorial } from '../../../src/astronomy/coordinates/astrometry'
import { eraC2s, eraStarpm } from '../../../src/astronomy/coordinates/erfa/erfa'
import { precessFk5FromJ2000 } from '../../../src/astronomy/coordinates/fk5'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { Timescale, timeJulianYear, timeYMDHMS, tt } from '../../../src/astronomy/time/time'
import { deg, mas, normalizeAngle, toDeg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { kilometerPerSecond } from '../../../src/math/units/velocity'

const STAR = {
	rightAscension: deg(353.22987757),
	declination: deg(52.27730247),
	// astropy works with pm_ra * cos(dec)
	pmRA: mas(22.9) / Math.cos(deg(52.27730247)),
	pmDEC: mas(-2.1),
	parallax: mas(23),
	rv: kilometerPerSecond(25),
} as Star

const EARTH_BARYCENTRIC_POSITION = [0.898130398596482138, -0.433663195905678422, -0.188058184681577339] as const
const EARTH_BARYCENTRIC_VELOCITY = [0.00771448410893727, 0.013933051305241721, 0.006040258849858089] as const
const EARTH_HELIOCENTRIC_POSITION = [0.895306712606649513, -0.430362177777382893, -0.186583142291892129] as const

const TIME = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
TIME.location = geodeticLocation(deg(9.712156), deg(52.385639), meter(200), Ellipsoid.WGS84)
TIME.providers = {
	pm: () => [0.0000012573132091648417, 0.0000020158008827406455],
	dut1: () => -0.3495186114062241,
}

test('icrs', () => {
	const i = star(STAR.rightAscension, STAR.declination, STAR.pmRA, STAR.pmDEC, STAR.parallax, STAR.rv)

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
	const s = star(STAR.rightAscension, STAR.declination, STAR.pmRA, STAR.pmDEC, STAR.parallax, STAR.rv)
	const b = spaceMotion(s, TIME)

	expect(b[0][0]).toBeCloseTo(5448758.569350527599453926, 5)
	expect(b[0][1]).toBeCloseTo(-646839.923422771040350199, 5)
	expect(b[0][2]).toBeCloseTo(7093562.290912019088864326, 5)
	expect(b[1]).toEqual(s[1])

	const eq = equatorial(b[0])
	expect(toDeg(normalizeAngle(eq[0]))).toBeCloseTo(353.229915499721528249, 11)
	expect(toDeg(eq[1])).toBeCloseTo(52.277300341846739684, 11)
})

test('hadec', () => {
	const c = observeStar(STAR, TIME, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)

	expect(toDeg(c.hourAngle)).toBeCloseTo(-0.295079443830661481, 16)
	expect(toDeg(c.declination)).toBeCloseTo(52.295490632814043863, 16)
})

test('altaz', () => {
	const c = observeStar(STAR, TIME, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)

	expect(toDeg(c.azimuth)).toBeCloseTo(116.449852106047814004, 16)
	expect(toDeg(c.altitude)).toBeCloseTo(89.798433978304871061, 16)
})

test('observed altaz', () => {
	const c = observeStar(STAR, TIME, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, undefined)

	expect(toDeg(c.azimuth)).toBeCloseTo(116.449852106047814004, 16)
	expect(toDeg(c.altitude)).toBeCloseTo(89.798489836226210059, 16)
})

test('observe propagates non-J2000 epoch to J2000', () => {
	// Reference: observe the J2000 catalog directly.
	const ref = observeStar(STAR, TIME, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)

	// Propagate the same catalog forward from J2000.0 to epoch 1991.25 (TDB).
	const epoch = timeYMDHMS(1991, 4, 2, 13, 30, 0, Timescale.TDB)
	const j = tt(timeJulianYear(2000, Timescale.TDB))
	const e = tt(epoch)
	const pm = eraStarpm(STAR.rightAscension, STAR.declination, STAR.pmRA, STAR.pmDEC, STAR.parallax, STAR.rv, j.day, j.fraction, e.day, e.fraction)
	expect(pm).not.toBe(false)
	if (!pm) return

	// A star whose catalog is referenced to 1991.25 must be propagated back to
	// J2000.0 by observeStar, recovering the reference observed place.
	const moved = star(pm[0], pm[1], pm[2], pm[3], pm[4], pm[5], epoch)
	const c = observeStar(moved, TIME, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)

	expect(toDeg(c.hourAngle)).toBeCloseTo(toDeg(ref.hourAngle), 9)
	expect(toDeg(c.declination)).toBeCloseTo(toDeg(ref.declination), 9)
})

test('star defaults to a static J2000 catalog entry', () => {
	const s = star(STAR.rightAscension, STAR.declination)

	expect(s.pmRA).toBe(0)
	expect(s.pmDEC).toBe(0)
	expect(s.parallax).toBe(0)
	expect(s.rv).toBe(0)
	expect(s.rightAscension).toBe(STAR.rightAscension)
	expect(s.declination).toBe(STAR.declination)

	// With no proper motion, parallax, or radial velocity the BCRS position is
	// time-invariant: space motion over decades leaves it unchanged.
	const moved = spaceMotion(s, timeYMDHMS(2050, 1, 1, 0, 0, 0, Timescale.TDB))
	expect(moved[0][0]).toBeCloseTo(s[0][0], 9)
	expect(moved[0][1]).toBeCloseTo(s[0][1], 9)
	expect(moved[0][2]).toBeCloseTo(s[0][2], 9)
})

test('observeStar requires a location on the time', () => {
	const noLocation = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	expect(() => observeStar(STAR, noLocation, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY], EARTH_HELIOCENTRIC_POSITION, false)).toThrow('time.location is required')
})

test('sirius', () => {
	const sirius = star(deg(101.27724), deg(-16.7225), mas(-415.12), mas(-1163.79), mas(378.932), kilometerPerSecond(-10))
	const time = timeYMDHMS(2025, 7, 27, 15, 0, 0, Timescale.UTC)
	const pv = spaceMotion(sirius, time)
	const [ra, dec] = eraC2s(...precessFk5FromJ2000(pv[0], time))

	expect(toDeg(ra)).toBeCloseTo(101.559918, 5)
	expect(toDeg(dec)).toBeCloseTo(-16.75894, 5)
})
