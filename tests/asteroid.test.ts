import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { asteroid, mpcAsteroid } from '../src/asteroid'
import { mpcorb } from '../src/mpcorb'
import { Timescale, time, timeYMDHMS } from '../src/time'

const t = timeYMDHMS(2025, 4, 21, 12, 0, 0, Timescale.TT)

test.skip('ceres', () => {
	const orbit = asteroid(2.769289292143484, 0.07687465013145245, deg(10.59127767086216), deg(80.3011901917491), deg(73.80896808746482), deg(130.3159688200986), time(2458849.5, Timescale.TT))

	// Ecliptic J2000 heliocentric cartesian coordinates (au, au/d):
	expect(orbit.position[0]).toBeCloseTo(1.007608869622793, 12)
	expect(orbit.position[1]).toBeCloseTo(-2.7227298037145053, 12)
	expect(orbit.position[2]).toBeCloseTo(-0.27148738417656254, 12)
	expect(orbit.velocity[0]).toBeCloseTo(0.009201724467239806, 14)
	expect(orbit.velocity[1]).toBeCloseTo(0.0029788843372813506, 14)
	expect(orbit.velocity[2]).toBeCloseTo(-0.001602173934571897, 14)

	const [p, v] = orbit.at(t)

	expect(p[0]).toBeCloseTo(2.718301549186456, 8)
	expect(p[1]).toBeCloseTo(-1.1016121800267031, 8)
	expect(p[2]).toBeCloseTo(-0.5357255299196289, 8)
	expect(v[0]).toBeCloseTo(0.00347876442091968, 12)
	expect(v[1]).toBeCloseTo(0.008911119696072289, 12)
	expect(v[2]).toBeCloseTo(-0.00036047342679280383, 12)
})

const CERES = '00001    3.34  0.15 K2555 188.70269   73.27343   80.25221   10.58780  0.0794013  0.21424651   2.7660512  0 E2024-V47  7330 125 1801-2024 0.80 M-v 30k MPCLINUX   4000      (1) Ceres              20241101'

test('ceres MPC', () => {
	const orbit = mpcAsteroid(mpcorb(CERES)!)

	// Ecliptic J2000 heliocentric cartesian coordinates (au, au/d):
	expect(orbit.position[0]).toBeCloseTo(2.7711317322713196, 16)
	expect(orbit.position[1]).toBeCloseTo(-0.9640727738162009, 16)
	expect(orbit.position[2]).toBeCloseTo(-0.5410254680767607, 16)
	expect(orbit.velocity[0]).toBeCloseTo(0.0029909542981365854, 14)
	expect(orbit.velocity[1]).toBeCloseTo(0.009075787938406748, 14)
	expect(orbit.velocity[2]).toBeCloseTo(-0.00026377621922747067, 14)

	const [p, v] = orbit.at(t)

	// Skyfield
	expect(p[0]).toBeCloseTo(2.727955537227552, 12)
	expect(p[1]).toBeCloseTo(-0.7824234893676645, 6)
	expect(p[2]).toBeCloseTo(-0.9244288479272925, 6)
	expect(v[0]).toBeCloseTo(0.0034043538954961496, 8)
	expect(v[1]).toBeCloseTo(0.008322662957715119, 8)
	expect(v[2]).toBeCloseTo(0.00323249221831575, 8)

	// JPL Horizons Sun(500@10) -> 1 Ceres (A801 AA), 2025-04-21 12:00:00.0000 TDB, x-y axes
	expect(p[0]).toBeCloseTo(2.727955368904768, 6)
	expect(p[1]).toBeCloseTo(-7.824235389148068e-1, 6)
	expect(p[2]).toBeCloseTo(-9.244287343918847e-1, 6)
	expect(v[0]).toBeCloseTo(3.404362861965615e-3, 7)
	expect(v[1]).toBeCloseTo(8.322702821554456e-3, 7)
	expect(v[2]).toBeCloseTo(3.232500291084344e-3, 7)
})
