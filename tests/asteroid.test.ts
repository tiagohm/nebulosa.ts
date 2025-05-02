import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { KeplerOrbit, asteroid, comet, mpcAsteroid, mpcComet, stumpff } from '../src/asteroid'
import type { CartesianCoordinate } from '../src/coordinate'
import { mpcorb, mpcorbComet } from '../src/mpcorb'
import { Timescale, time, timeYMDHMS } from '../src/time'

const t = timeYMDHMS(2025, 4, 21, 12, 0, 0, Timescale.TT)

test('ceres', () => {
	const orbit = asteroid(2.769289292143484, 0.07687465013145245, deg(10.59127767086216), deg(80.3011901917491), deg(73.80896808746482), deg(130.3159688200986), time(2458849, 0.5, Timescale.TT))

	// Skyfield Ecliptic J2000 heliocentric cartesian coordinates (au, au/d):
	expect(orbit.position[0]).toBeCloseTo(1.007608869622793, 12)
	expect(orbit.position[1]).toBeCloseTo(-2.7227298037145053, 12)
	expect(orbit.position[2]).toBeCloseTo(-0.27148738417656254, 12)
	expect(orbit.velocity[0]).toBeCloseTo(0.009201724467239806, 12)
	expect(orbit.velocity[1]).toBeCloseTo(0.0029788843372813506, 12)
	expect(orbit.velocity[2]).toBeCloseTo(-0.001602173934571897, 12)

	const [p, v] = orbit.at(t)

	expect(p[0]).toBeCloseTo(2.718301549186456, 11)
	expect(p[1]).toBeCloseTo(-0.7976102122207983, 11)
	expect(p[2]).toBeCloseTo(-0.9297145733828633, 11)
	expect(v[0]).toBeCloseTo(0.00347876442091968, 11)
	expect(v[1]).toBeCloseTo(0.00831918117471014, 11)
	expect(v[2]).toBeCloseTo(0.003213910376996851, 11)
})

test('ceres MPC', () => {
	const line = '00001    3.34  0.15 K2555 188.70269   73.27343   80.25221   10.58780  0.0794013  0.21424651   2.7660512  0 E2024-V47  7330 125 1801-2024 0.80 M-v 30k MPCLINUX   4000      (1) Ceres              20241101'
	const orbit = mpcAsteroid(mpcorb(line)!)

	// Skyfield Ecliptic J2000 heliocentric cartesian coordinates (au, au/d):
	expect(orbit.position[0]).toBeCloseTo(2.7711317322713196, 16)
	expect(orbit.position[1]).toBeCloseTo(-0.9640727738162009, 16)
	expect(orbit.position[2]).toBeCloseTo(-0.5410254680767607, 16)
	expect(orbit.velocity[0]).toBeCloseTo(0.0029909542981365854, 14)
	expect(orbit.velocity[1]).toBeCloseTo(0.009075787938406748, 14)
	expect(orbit.velocity[2]).toBeCloseTo(-0.00026377621922747067, 14)

	const [p, v] = orbit.at(t)

	// Skyfield. Note: Ecliptic J2000 frame is slighty different.
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

test('halley', () => {
	const orbit = comet(1.1318652519349035, 0.9679221169240834, deg(162.1951462980701), deg(59.07198712310091), deg(112.2128395742619), time(2439907, 0.5, Timescale.TT))

	// Skyfield Ecliptic J2000 heliocentric cartesian coordinates (au, au/d):
	expect(orbit.position[0]).toBeCloseTo(0.3231308648514452, 15)
	expect(orbit.position[1]).toBeCloseTo(-0.4470829350965476, 14)
	expect(orbit.position[2]).toBeCloseTo(0.16281736384355466, 15)
	expect(orbit.velocity[0]).toBeCloseTo(-0.024964863599508818, 13)
	expect(orbit.velocity[1]).toBeCloseTo(-0.019382987089550427, 13)
	expect(orbit.velocity[2]).toBeCloseTo(-0.003678261206234086, 13)

	const [p, v] = orbit.at(t)

	// Skyfield. Note: Ecliptic J2000 frame is slighty different.
	expect(p[0]).toBeCloseTo(-13.670463531815205, 10)
	expect(p[1]).toBeCloseTo(25.768654032179573, 6)
	expect(p[2]).toBeCloseTo(2.6258627038765514, 4)
	expect(v[0]).toBeCloseTo(0.0013772952663454745, 8)
	expect(v[1]).toBeCloseTo(-0.0013430571440847163, 8)
	expect(v[2]).toBeCloseTo(4.942792169321399e-5, 8)
})

test('halley MPC', () => {
	const line = '0001P         2061 08 31.8266  0.583972  0.967311  112.5470   59.6368  162.2146  20250501   4.0  6.0  1P/Halley                                                 98, 1083'
	const orbit = mpcComet(mpcorbComet(line)!)

	// Skyfield Ecliptic J2000 heliocentric cartesian coordinates (au, au/d):
	expect(orbit.position[0]).toBeCloseTo(0.32993281659388435, 15)
	expect(orbit.position[1]).toBeCloseTo(-0.4527999587342976, 15)
	expect(orbit.position[2]).toBeCloseTo(0.16474170901336713, 15)
	expect(orbit.velocity[0]).toBeCloseTo(-0.02468661744861757, 13)
	expect(orbit.velocity[1]).toBeCloseTo(-0.019333342849647606, 13)
	expect(orbit.velocity[2]).toBeCloseTo(-0.00369798043960384, 13)

	const [p, v] = orbit.at(t)

	// Skyfield. Note: Ecliptic J2000 frame is slighty different.
	expect(p[0]).toBeCloseTo(-19.63028062054738, 11)
	expect(p[1]).toBeCloseTo(29.057694647856728, 6)
	expect(p[2]).toBeCloseTo(1.835299573869067, 4)
	expect(v[0]).toBeCloseTo(0.00047867828425305313, 8)
	expect(v[1]).toBeCloseTo(0.000169695439166974, 8)
	expect(v[2]).toBeCloseTo(0.00017795270279699423, 8)

	// JPL Horizons Sun(500@10) -> 1P/Halley [1968] (74) - default, 2025-04-21 12:00:00.0000 TDB, x-y axes
	expect(p[0]).toBeCloseTo(-1.962565156680985e1, 2)
	expect(p[1]).toBeCloseTo(2.906218512875295e1, 2)
	expect(p[2]).toBeCloseTo(1.794376916775462, 1)
	expect(v[0]).toBeCloseTo(4.758928502386304e-4, 4)
	expect(v[1]).toBeCloseTo(1.673641477296569e-4, 4)
	expect(v[2]).toBeCloseTo(1.769586237358669e-4, 4)
})

test('osculating elements', () => {
	// JPL Horizons Sun(500@10) -> 4 Vesta (A807 FA), 2025-04-21 12:00:00.0000 TDB, x-y axes
	const position: CartesianCoordinate = [-1.70317472297052, -1.333843040283118, -3.086709149679688e-1]
	const velocity: CartesianCoordinate = [7.882762615954012e-3, -8.079478592200335e-3, -4.254433056153772e-3]
	const vesta = new KeplerOrbit(position, velocity, time(2460787, 0, Timescale.TDB))

	expect(vesta.apoapsisDistance).toBeCloseTo(2.5741322772196766, 11)
	expect(vesta.argumentOfLatitude).toBeCloseTo(3.5152170741718365, 11)
	expect(vesta.argumentOfPeriapsis).toBeCloseTo(4.163206069737825, 11)
	expect(vesta.eccentricAnomaly).toBeCloseTo(-0.5954010507161356, 11)
	expect(vesta.eccentricityVector[0]).toBeCloseTo(-0.022557010570126906, 12)
	expect(vesta.eccentricityVector[1]).toBeCloseTo(-0.08200292925792708, 12)
	expect(vesta.eccentricityVector[2]).toBeCloseTo(-0.029741309829624623, 12)
	expect(vesta.eccentricity).toBeCloseTo(0.0900990823655998, 12)
	expect(vesta.inclination).toBeCloseTo(0.39738020913353744, 12)
	expect(vesta.longitudeOfAscendingNode).toBeCloseTo(0.3175081502734694, 12)
	expect(vesta.longitudeOfPeriapsis).toBeCloseTo(4.480714220011294, 11)
	expect(vesta.nodeVector[0]).toBeCloseTo(0.9500163228199269, 12)
	expect(vesta.nodeVector[1]).toBeCloseTo(0.3122002344260888, 12)
	expect(vesta.nodeVector[2]).toBeCloseTo(0, 12)
	expect(vesta.meanAnomaly).toBeCloseTo(5.738315501407061, 11)
	expect(vesta.meanLongitude).toBeCloseTo(3.935844414238769, 11)
	expect(vesta.meanMotionPerDay).toBeCloseTo(0.004740608732256189, 11)
	expect(vesta.periapsisDistance).toBeCloseTo(2.1486169092737373, 11)
	expect(vesta.periapsisTime.day + vesta.periapsisTime.fraction).toBeCloseTo(2459576.540368018, 9)
	expect(vesta.periodInDays).toBeCloseTo(1325.3963071086948, 8)
	expect(vesta.semiLatusRectum).toBeCloseTo(2.342205321154512, 11)
	expect(vesta.semiMajorAxis).toBeCloseTo(2.361374593246707, 11)
	expect(vesta.semiMinorAxis).toBeCloseTo(2.3517704261984225, 11)
	expect(vesta.trueAnomaly).toBeCloseTo(5.635196311613598, 11)
	expect(vesta.trueLongitude).toBeCloseTo(3.832725224445305, 11)
})

test('stumpff', () => {
	expect(stumpff(-2)).toEqual([2.178183556608571, 1.368298872008591, 0.5890917783042855, 0.18414943600429545])
	expect(stumpff(0.5)).toEqual([0.7602445970756302, 0.9187253698655684, 0.4795108058487397, 0.16254926026886313])
	expect(stumpff(2)).toEqual([0.15594369476537437, 0.6984559986366083, 0.4220281526173128, 0.15077200068169583])
})
