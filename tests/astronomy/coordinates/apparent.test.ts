import { expect, test } from 'bun:test'
import { apparentDirection, deflectStarlight, JUPITER_LIGHT_DEFLECTOR_LIMITER, JUPITER_LIGHT_DEFLECTOR_MASS, SATURN_LIGHT_DEFLECTOR_LIMITER, SATURN_LIGHT_DEFLECTOR_MASS, SUN_LIGHT_DEFLECTOR_LIMITER, SUN_LIGHT_DEFLECTOR_MASS } from '../../../src/astronomy/coordinates/apparent'
import { lightTime, type PositionAndVelocityOverTime, topocentricDirection } from '../../../src/astronomy/coordinates/astrometry'
import { annualAberration, observerState } from '../../../src/astronomy/coordinates/correction'
import { eraEpv00 } from '../../../src/astronomy/coordinates/erfa/earth'
import { eraAb, eraApci13, eraAtciqn, eraC2s, eraLd, eraLdSun, eraLdn, type LdBody, eraPmpx } from '../../../src/astronomy/coordinates/erfa/erfa'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { tdb, Timescale, timeShift, timeYMDHMS, toJulianDay } from '../../../src/astronomy/time/time'
import { SPEED_OF_LIGHT_AU_DAY, SUN_RADIUS_AU } from '../../../src/core/constants'
import { matMulVec } from '../../../src/math/linear-algebra/mat3'
import { type Vec3, vecAngle, vecClone, vecLength, vecNormalize } from '../../../src/math/linear-algebra/vec3'
import { arcsec, deg, toArcsec } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { kilometerPerSecond } from '../../../src/math/units/velocity'

const TIME = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TDB)
const LOCATION = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))

function constantPv(position: Vec3, velocity: Vec3 = [0, 0, 0]): PositionAndVelocityOverTime {
	return () => [vecClone(position), vecClone(velocity)]
}

function farTarget(observerPosition: Vec3, direction: Vec3, distance = 1e9): PositionAndVelocityOverTime {
	const n = vecNormalize(direction)
	return constantPv([observerPosition[0] + n[0] * distance, observerPosition[1] + n[1] * distance, observerPosition[2] + n[2] * distance])
}

test('zero light-time iterations reproduce the geometric same-epoch direction', () => {
	const observer = constantPv([0, 0, 0])
	const target: PositionAndVelocityOverTime = (t) => [
		[1 + t.fraction, 2, 3],
		[0, 0, 0],
	]

	const place = apparentDirection(target, observer, TIME, { lightTimeIterations: 0, aberration: false })!
	const geometric = topocentricDirection(target, observer, TIME, 0)

	expect(place.astrometric[0]).toBeCloseTo(geometric[0] / vecLength(geometric), 15)
	expect(place.astrometric[1]).toBeCloseTo(geometric[1] / vecLength(geometric), 15)
	expect(place.astrometric[2]).toBeCloseTo(geometric[2] / vecLength(geometric), 15)
	expect(place.distance).toBeCloseTo(vecLength(geometric), 15)
})

test('light-time convergence matches topocentricDirection and is internally consistent', () => {
	const observer = constantPv([0.1, -0.2, 0.05], [0.01, 0, 0])
	const target: PositionAndVelocityOverTime = (t) => {
		const dt = toJulianDay(t) - toJulianDay(TIME)
		return [
			[2 + 0.001 * dt, 0.5, -0.3],
			[0.001, 0, 0],
		]
	}

	const place = apparentDirection(target, observer, TIME, { lightTimeIterations: 3, aberration: false })!
	const byDefault = apparentDirection(target, observer, TIME, { aberration: false })!
	const retarded = topocentricDirection(target, observer, TIME, 3)
	const tau = lightTime(retarded)

	expect(place.distance).toBeCloseTo(vecLength(retarded), 15)
	expect(place.lightTime).toBeCloseTo(tau, 15)
	expect(toJulianDay(place.emissionTime)).toBeCloseTo(toJulianDay(timeShift(TIME, -tau)), 15)
	expect(place.astrometric[0]).toBeCloseTo(retarded[0] / vecLength(retarded), 15)
	expect(place.astrometric[1]).toBeCloseTo(retarded[1] / vecLength(retarded), 15)
	expect(place.astrometric[2]).toBeCloseTo(retarded[2] / vecLength(retarded), 15)
	expect(byDefault.distance).toBe(place.distance)
	expect(byDefault.lightTime).toBe(place.lightTime)
	expect(byDefault.astrometric).toEqual(place.astrometric)
})

test('accepts the maximum supported light-time iteration count', () => {
	const observer = constantPv([0, 0, 0])
	const target = constantPv([1, 0.2, -0.1])
	const place = apparentDirection(target, observer, TIME, { lightTimeIterations: 16, aberration: false })!
	const retarded = topocentricDirection(target, observer, TIME, 16)

	expect(place.distance).toBeCloseTo(vecLength(retarded), 15)
	expect(place.astrometric[0]).toBeCloseTo(retarded[0] / vecLength(retarded), 15)
	expect(place.astrometric[1]).toBeCloseTo(retarded[1] / vecLength(retarded), 15)
	expect(place.astrometric[2]).toBeCloseTo(retarded[2] / vecLength(retarded), 15)
})

test('rejects non-finite light-time iteration counts', () => {
	const observer = constantPv([0, 0, 0])
	const target = constantPv([1, 0, 0])
	expect(() => apparentDirection(target, observer, TIME, { aberration: false, lightTimeIterations: Infinity })).toThrow('lightTimeIterations must be an integer in [0, 16]')
	expect(() => apparentDirection(target, observer, TIME, { aberration: false, lightTimeIterations: -Infinity })).toThrow('lightTimeIterations must be an integer in [0, 16]')
	expect(() => apparentDirection(target, observer, TIME, { aberration: false, lightTimeIterations: Number.NaN })).toThrow('lightTimeIterations must be an integer in [0, 16]')
})

test('rejects negative light-time iteration counts', () => {
	const observer = constantPv([0, 0, 0])
	const target = constantPv([1, 0, 0])
	expect(() => apparentDirection(target, observer, TIME, { aberration: false, lightTimeIterations: -1 })).toThrow('lightTimeIterations must be an integer in [0, 16]')
})

test('rejects fractional light-time iteration counts', () => {
	const observer = constantPv([0, 0, 0])
	const target = constantPv([1, 0, 0])
	expect(() => apparentDirection(target, observer, TIME, { aberration: false, lightTimeIterations: 1.5 })).toThrow('lightTimeIterations must be an integer in [0, 16]')
})

test('rejects light-time iteration counts above the supported bound', () => {
	const observer = constantPv([0, 0, 0])
	const target = constantPv([1, 0, 0])
	expect(() => apparentDirection(target, observer, TIME, { aberration: false, lightTimeIterations: 17 })).toThrow('lightTimeIterations must be an integer in [0, 16]')
})

test('zero observer-target distance has no sky direction', () => {
	const origin = constantPv([1, 2, 3])
	expect(apparentDirection(origin, origin, TIME, { aberration: false })).toBeUndefined()
})

test('aberration without a Sun provider fails explicitly', () => {
	const observer = constantPv([1, 0, 0])
	const target = constantPv([2, 0, 0])
	expect(() => apparentDirection(target, observer, TIME)).toThrow('sun barycentric state is required when aberration is enabled')
})

test('disabling aberration leaves the astrometric direction unchanged', () => {
	const observer = constantPv([0, 0, 0], [0.017, 0, 0])
	const target = constantPv([1, 0.2, 0.1])
	const sun = constantPv([0, 0, 0])
	const place = apparentDirection(target, observer, TIME, { aberration: false, sun, deflectors: [] })!

	expect(place.apparent).not.toBe(place.astrometric)
	expect(place.apparent[0]).toBeCloseTo(place.astrometric[0], 15)
	expect(place.apparent[1]).toBeCloseTo(place.astrometric[1], 15)
	expect(place.apparent[2]).toBeCloseTo(place.astrometric[2], 15)
	expect(vecLength(place.apparent)).toBeCloseTo(1, 15)
})

test('aberration matches eraAb and stays on the ~20 arcsec annual scale', () => {
	const tdbTime = tdb(TIME)
	const [heliocentric, barycentric] = eraEpv00(tdbTime.day, tdbTime.fraction)
	const earth = constantPv(barycentric[0], barycentric[1])
	const sun = constantPv([barycentric[0][0] - heliocentric[0][0], barycentric[0][1] - heliocentric[0][1], barycentric[0][2] - heliocentric[0][2]])
	const direction = vecNormalize([0, 1, 0])
	const target = farTarget(barycentric[0], direction)
	const place = apparentDirection(target, earth, TIME, { sun, deflectors: [] })!

	const sunDistance = vecLength(heliocentric[0])
	const expected = annualAberration(place.astrometric, barycentric[1], sunDistance)
	expect(place.apparent[0]).toBeCloseTo(expected[0], 14)
	expect(place.apparent[1]).toBeCloseTo(expected[1], 14)
	expect(place.apparent[2]).toBeCloseTo(expected[2], 14)

	const vOverC: [number, number, number] = [barycentric[1][0] / SPEED_OF_LIGHT_AU_DAY, barycentric[1][1] / SPEED_OF_LIGHT_AU_DAY, barycentric[1][2] / SPEED_OF_LIGHT_AU_DAY]
	const bm1 = Math.sqrt(1 - (vOverC[0] * vOverC[0] + vOverC[1] * vOverC[1] + vOverC[2] * vOverC[2]))
	const era = eraAb(place.astrometric, vOverC, sunDistance, bm1)
	expect(place.apparent[0]).toBeCloseTo(era[0], 14)
	expect(place.apparent[1]).toBeCloseTo(era[1], 14)
	expect(place.apparent[2]).toBeCloseTo(era[2], 14)

	expect(toArcsec(vecAngle(place.astrometric, place.apparent))).toBeGreaterThan(5)
	expect(toArcsec(vecAngle(place.astrometric, place.apparent))).toBeLessThan(20.6)
})

test('a topocentric observer includes the diurnal aberration term', () => {
	const tdbTime = tdb(TIME)
	const [heliocentric, barycentric] = eraEpv00(tdbTime.day, tdbTime.fraction)
	const sun = constantPv([barycentric[0][0] - heliocentric[0][0], barycentric[0][1] - heliocentric[0][1], barycentric[0][2] - heliocentric[0][2]])
	const direction = vecNormalize([0, 1, 0.2])
	const target = farTarget(barycentric[0], direction, 1e6)

	const geocentric = apparentDirection(target, constantPv(barycentric[0], barycentric[1]), TIME, { sun, deflectors: [] })!
	const topocentric = apparentDirection(
		target,
		(t) => {
			const [p, v] = observerState(t, barycentric, LOCATION)
			return [vecClone(p), vecClone(v)]
		},
		TIME,
		{ sun, deflectors: [] },
	)!

	const delta = toArcsec(vecAngle(geocentric.apparent, topocentric.apparent))
	expect(delta).toBeGreaterThan(0.001)
	expect(delta).toBeLessThan(0.5)
})

// Skyfield 1.55 _compute_deflection of a gigaparsec-scale limb star, Sun at the origin,
// observer at 1 AU along +x. Classical 4GM/(c^2 R) is 1.75119 arcsec.
test('solar limb deflection approaches the classical 1.75 arcsec scale', () => {
	const observer = constantPv([1, 0, 0])
	const sunState = constantPv([0, 0, 0])
	const angularRadius = Math.asin(SUN_RADIUS_AU)
	const limb: Vec3 = [-Math.cos(angularRadius), Math.sin(angularRadius), 0]
	const target = farTarget([1, 0, 0], limb)
	const sun = { mass: SUN_LIGHT_DEFLECTOR_MASS, state: sunState, limiter: 1e-6 }

	const none = apparentDirection(target, observer, TIME, { aberration: false, deflectors: [] })!
	const withSun = apparentDirection(target, observer, TIME, { aberration: false, deflectors: [sun] })!
	const shift = toArcsec(vecAngle(none.apparent, withSun.apparent))

	expect(shift).toBeGreaterThan(1.74)
	expect(shift).toBeLessThan(1.76)
	// Skyfield 1.55, same geometry, pmag = 1e9 AU.
	expect(shift).toBeCloseTo(1.75118, 3)

	const e = vecNormalize([1, 0, 0])
	const era = eraLdSun(vecNormalize(limb), e, 1)
	expect(toArcsec(vecAngle(vecNormalize(limb), era))).toBeCloseTo(shift, 3)
})

test('star deflection plus aberration plus BPN matches eraAtciqn', () => {
	const ph: Vec3 = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775]
	const pb: Vec3 = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775]
	const vb: Vec3 = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545]
	const astrom = eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const bodies: LdBody[] = [
		{ bm: 0.00028574, dl: 3e-10, p: [-7.81014427, -5.60956681, -1.98079819], v: [0.0030723249, -0.00406995477, -0.00181335842] },
		{ bm: 0.00095435, dl: 3e-9, p: [0.738098796, 4.63658692, 1.9693136], v: [-0.00755816922, 0.00126913722, 0.000727999001] },
		{ bm: 1, dl: 6e-6, p: [-0.000712174377, -0.00230478303, -0.00105865966], v: [6.29235213e-6, -3.30888387e-7, -2.96486623e-7] },
	]

	const pco = eraPmpx(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), astrom.pmt, astrom.eb)
	const pnat = deflectStarlight(pco, astrom.eb, bodies)
	const observerVelocity: Vec3 = [astrom.v[0] * SPEED_OF_LIGHT_AU_DAY, astrom.v[1] * SPEED_OF_LIGHT_AU_DAY, astrom.v[2] * SPEED_OF_LIGHT_AU_DAY]
	const ppr = annualAberration(pnat, observerVelocity, astrom.em)
	const pi = matMulVec(astrom.bpn, ppr)
	const [w, di] = eraC2s(...pi)
	const [ri, dec] = eraAtciqn(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), astrom, bodies)

	expect(w).toBeCloseTo(ri, 13)
	expect(di).toBeCloseTo(dec, 13)
})

test('multi-body star deflection accumulates Sun, Jupiter, and Saturn incrementally', () => {
	const ob: Vec3 = [-0.974170437, -0.2115201, -0.0917583114]
	const saturn: LdBody = { bm: SATURN_LIGHT_DEFLECTOR_MASS, dl: SATURN_LIGHT_DEFLECTOR_LIMITER, p: [-7.81014427, -5.60956681, -1.98079819], v: [0.0030723249, -0.00406995477, -0.00181335842] }
	const jupiter: LdBody = { bm: JUPITER_LIGHT_DEFLECTOR_MASS, dl: JUPITER_LIGHT_DEFLECTOR_LIMITER, p: [0.738098796, 4.63658692, 1.9693136], v: [-0.00755816922, 0.00126913722, 0.000727999001] }
	const sun: LdBody = { bm: SUN_LIGHT_DEFLECTOR_MASS, dl: SUN_LIGHT_DEFLECTOR_LIMITER, p: [-0.000712174377, -0.00230478303, -0.00105865966], v: [6.29235213e-6, -3.30888387e-7, -2.96486623e-7] }
	// Star 0.1 deg from Jupiter as seen by the observer, so Jupiter's increment is measurable.
	const toJupiter = vecNormalize([jupiter.p[0] - ob[0], jupiter.p[1] - ob[1], jupiter.p[2] - ob[2]])
	const sc = vecNormalize([toJupiter[0], toJupiter[1] + deg(0.1), toJupiter[2]])

	const a0 = vecNormalize(sc)
	const aSun = eraLdn([sun], ob, sc)
	const aSunJupiter = eraLdn([sun, jupiter], ob, sc)
	const aAll = eraLdn([sun, jupiter, saturn], ob, sc)

	const sunShift = toArcsec(vecAngle(a0, aSun))
	const jupiterShift = toArcsec(vecAngle(aSun, aSunJupiter))
	const saturnShift = toArcsec(vecAngle(aSunJupiter, aAll))

	expect(sunShift).toBeCloseTo(0.007222, 5)
	expect(jupiterShift).toBeCloseTo(0.001615, 5)
	expect(saturnShift).toBeGreaterThan(3e-8)
	expect(saturnShift).toBeLessThan(5e-8)
	expect(jupiterShift).toBeGreaterThan(saturnShift)
	expect(deflectStarlight(sc, ob, [sun, jupiter, saturn])).toEqual(aAll)

	const observer = constantPv(ob)
	const target = farTarget(ob, sc)
	const asDeflectors = (bodies: LdBody[]) => bodies.map((b) => ({ mass: b.bm, limiter: b.dl, state: constantPv(b.p, b.v) }))
	const farSun = apparentDirection(target, observer, TIME, { aberration: false, deflectors: asDeflectors([sun]) })!
	const farSJ = apparentDirection(target, observer, TIME, { aberration: false, deflectors: asDeflectors([sun, jupiter]) })!
	const farAll = apparentDirection(target, observer, TIME, { aberration: false, deflectors: asDeflectors([sun, jupiter, saturn]) })!

	expect(toArcsec(vecAngle(farSun.apparent, aSun))).toBeLessThan(1e-6)
	expect(toArcsec(vecAngle(farSJ.apparent, aSunJupiter))).toBeLessThan(1e-6)
	expect(toArcsec(vecAngle(farAll.apparent, aAll))).toBeLessThan(1e-6)
})

test('a deflector beyond a finite target is not treated as a star at infinity', () => {
	const observer = constantPv([0, 0, 0])
	const target = constantPv([1, 0, 0])
	const deflectorPosition: Vec3 = [5, 0.01, 0]
	const deflector = { mass: SUN_LIGHT_DEFLECTOR_MASS, state: constantPv(deflectorPosition), limiter: 1e-6 }

	const finite = apparentDirection(target, observer, TIME, { aberration: false, lightTimeIterations: 0, deflectors: [deflector] })!
	const star = farTarget([0, 0, 0], [1, 0, 0])
	const infinite = apparentDirection(star, observer, TIME, { aberration: false, deflectors: [deflector] })!

	const finiteShift = toArcsec(vecAngle(finite.astrometric, finite.apparent))
	const starShift = toArcsec(vecAngle(infinite.astrometric, infinite.apparent))
	// Skyfield 1.55 _compute_deflection, same geometry: finite ~2e-7 arcsec, star ~0.814 arcsec.
	expect(finiteShift).toBeLessThan(1e-5)
	expect(starShift).toBeGreaterThan(0.5)
	expect(starShift).toBeCloseTo(0.814, 2)

	const body: LdBody = { bm: 1, dl: 1e-6, p: deflectorPosition, v: [0, 0, 0] }
	const naive = eraLdn([body], [0, 0, 0], [1, 0, 0])
	expect(toArcsec(vecAngle(finite.apparent, naive))).toBeGreaterThan(0.5)

	const p: Vec3 = [1, 0, 0]
	const e = vecNormalize([-5, -0.01, 0])
	const q = vecNormalize([-4, -0.01, 0])
	const em = Math.hypot(5, 0.01)
	const expected = eraLd(1, p, q, e, em, 1e-6)
	expect(finite.apparent[0]).toBeCloseTo(expected[0] / vecLength(expected), 12)
	expect(finite.apparent[1]).toBeCloseTo(expected[1] / vecLength(expected), 12)
	expect(finite.apparent[2]).toBeCloseTo(expected[2] / vecLength(expected), 12)
})
