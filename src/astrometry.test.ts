import { expect, test } from 'bun:test'
import { deg, mas, normalize, toDeg } from './angle'
import { astrometric, equatorial } from './astrometry'
import { meter } from './distance'
import { geodetic } from './location'
import { star } from './star'
import { Timescale, timeYMDHMS } from './time'
import { kilometerPerSecond } from './velocity'

// https://syrte.obspm.fr/iau/iauWGnfa/ExPW04.html
test('patrickWallace', () => {
	const site = geodetic(deg(9.712156), deg(52.385639), meter(200))
	const body = star(deg(353.22987757), deg(52.27730247), mas(22.9) / Math.cos(deg(52.27730247)), mas(-2.1), mas(23), kilometerPerSecond(25))
	const time = timeYMDHMS(2003, 8, 26, 0, 37, 38.97381, Timescale.UTC)
	time.location = site
	time.ut1MinusUtc = () => -0.349535

	// ICRS epoch 2000
	const icrs = body.position
	let eq = equatorial(icrs)
	expect(toDeg(normalize(eq[0]))).toBeCloseTo(353.22987757, 10)
	expect(toDeg(eq[1])).toBeCloseTo(52.27730247, 10)

	// BCRS
	const bcrs = body.at(time)
	eq = equatorial(bcrs)
	expect(toDeg(normalize(eq[0]))).toBeCloseTo(353.22991549972, 10)
	expect(toDeg(eq[1])).toBeCloseTo(52.27730034185, 10)

	// Astrometric
	const astrom = astrometric(bcrs, mas(23), [0.898130398596, -0.433663195906, -0.188058184682])
	eq = equatorial(astrom)
	expect(toDeg(normalize(eq[0]))).toBeCloseTo(353.22991889091, 10)
	expect(toDeg(eq[1])).toBeCloseTo(52.27730584235, 10)
})