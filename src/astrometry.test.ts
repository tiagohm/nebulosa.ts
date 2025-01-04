import { expect, test } from 'bun:test'
import { deg, mas, normalize, toDeg } from './angle'
import { equatorial, parallax, sphericalCirs } from './astrometry'
import type { CartesianCoordinate } from './coordinate'
import { meter } from './distance'
import { geodetic } from './location'
import { at, observedAt, star } from './star'
import { Timescale, timeYMDHMS } from './time'
import { kilometerPerSecond } from './velocity'

const EARTH_BARYCENTRIC_POSITION: CartesianCoordinate = [0.898130398596, -0.433663195906, -0.188058184682]
const EARTH_BARYCENTRIC_VELOCITY: CartesianCoordinate = [0.007714484109, 0.013933051305, 0.00604025885]

// https://syrte.obspm.fr/iau/iauWGnfa/ExPW04.html
test('patrickWallace', () => {
	const site = geodetic(deg(9.712156), deg(52.385639), meter(200))
	const body = star(deg(353.22987757), deg(52.27730247), mas(22.9) / Math.cos(deg(52.27730247)), mas(-2.1), mas(23), kilometerPerSecond(25))
	const time = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	time.location = site
	time.ut1MinusUtc = () => -0.349535

	// The ICRS RA,Dec at the catalog epoch (2000.0) is:
	const icrs = body[0]
	let eq = equatorial(icrs)
	expect(toDeg(normalize(eq[0]))).toBeCloseTo(353.22987757, 10)
	expect(toDeg(eq[1])).toBeCloseTo(52.27730247, 10)

	// BCRS
	const bcrs = at(body, time)
	eq = equatorial(bcrs[0])
	expect(toDeg(normalize(eq[0]))).toBeCloseTo(353.22991549972, 10)
	expect(toDeg(eq[1])).toBeCloseTo(52.27730034185, 10)

	// Applying space motion and parallax, we obtain the astrometric place:
	const astrom = parallax(bcrs[0], mas(23), EARTH_BARYCENTRIC_POSITION)
	eq = equatorial(astrom)
	expect(toDeg(normalize(eq[0]))).toBeCloseTo(353.22991889091, 10)
	expect(toDeg(eq[1])).toBeCloseTo(52.27730584235, 10)

	// With the light deflection from the Sun and
	// annual aberration produces the proper direction, which is the GCRS:
	const gcrs = observedAt(body, time, [EARTH_BARYCENTRIC_POSITION, EARTH_BARYCENTRIC_VELOCITY])
	eq = equatorial(gcrs)
	expect(toDeg(normalize(eq[0]))).toBeCloseTo(353.23789320667, 9)
	expect(toDeg(eq[1])).toBeCloseTo(52.27695262534, 8)

	// We are now ready to apply the IAU 2000 celestial-to-terrestrial transformations.

	eq = sphericalCirs(gcrs, time)
	expect(toDeg(normalize(eq[0]))).toBeCloseTo(353.23300208264, 7)
	expect(toDeg(eq[1])).toBeCloseTo(52.2955417396, 7)

	// We are now ready to move from coordinates on the celestial sphere into coordinates on the Earth.
	// This involves Earth rotation together with three small effects: diurnal aberration, s' and polar motion.
})
