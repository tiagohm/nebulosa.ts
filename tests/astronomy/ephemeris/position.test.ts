import { describe, expect, test } from 'bun:test'
import { SUN_LIGHT_DEFLECTOR_LIMITER, SUN_LIGHT_DEFLECTOR_MASS, apparentDirection } from '../../../src/astronomy/coordinates/apparent'
import { topocentricDirection, type PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { annualAberration } from '../../../src/astronomy/coordinates/correction'
import { eraLd } from '../../../src/astronomy/coordinates/erfa/erfa'
import { CIRS, ECLIPTIC_J2000, GALACTIC, ICRS, ITRS, frameAt, frameToBase } from '../../../src/astronomy/coordinates/frame'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { type ApparentPosition, type AstrometricPosition, apparentPosition, directionPositionInFrame, ephemerisAt, equatorialPosition, geometricPositionInFrame, geometricSphericalPositionAndVelocity, observeEphemeris } from '../../../src/astronomy/ephemeris/position'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC, LIGHT_TIME_AU, PI, PIOVERTWO, TAU } from '../../../src/core/constants'
import { type MutVec3, type Vec3, vecAngle, vecClone, vecDistance, vecDivScalar, vecLength, vecZero } from '../../../src/math/linear-algebra/vec3'
import { mulberry32 } from '../../../src/math/numerical/random'
import { normalizeAngle } from '../../../src/math/units/angle'

const TIME = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TDB)
const EARTH = naifEphemerisEndpoint(Naif.EARTH)
const MARS = naifEphemerisEndpoint(Naif.MARS)

test('geometric materialization owns position and velocity from a reusable provider', () => {
	const scratch: PositionAndVelocity = [
		[1, 2, 3],
		[4, 5, 6],
	]
	const path = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => scratch)
	const position = ephemerisAt(path, TIME)
	expect(position.kind).toBe('geometric')
	expect(position.time).toBe(TIME)
	expect(position.center).toBe(SOLAR_SYSTEM_BARYCENTER)
	expect(position.target).toBe(EARTH)
	expect(position.position).toEqual([1, 2, 3])
	expect(position.velocity).toEqual([4, 5, 6])
	scratch[0][0] = 99
	scratch[1][0] = 99
	expect(position.position[0]).toBe(1)
	expect(position.velocity[0]).toBe(4)
})

test('retarded observation uses SSB states and owns every vector', () => {
	const scratch: PositionAndVelocity = [vecZero(), vecZero()]
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => {
		scratch[0] = [0.1, 0, 0]
		scratch[1] = [0.01, 0, 0]
		return scratch
	})
	const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, (time) => {
		scratch[0] = [1 + (time.fraction - TIME.fraction) * 0.001, 0.5, 0]
		scratch[1] = [0.001, 0, 0]
		return scratch
	})
	const position = observeEphemeris(observer, target, TIME)!
	expect(position.kind).toBe('astrometric')
	expect(position.center).toBe(EARTH)
	expect(position.target).toBe(MARS)
	expect(position.position).toEqual(topocentricDirection(target.stateAt, observer.stateAt, TIME, 3))
	expect(vecLength(position.direction)).toBeCloseTo(1, 14)
	expect(position.distance).toBeCloseTo(vecLength(position.position), 14)
	expect(position.observerPosition).toEqual([0.1, 0, 0])
	expect(position.observerVelocity).toEqual([0.01, 0, 0])
	expect(position.targetEmissionPosition[0]).toBeCloseTo(position.position[0] + 0.1, 14)
	scratch[0][0] = 99
	scratch[1][0] = 99
	expect(position.position[0]).toBeLessThan(2)
	expect(position.observerVelocity[0]).toBe(0.01)
	expect(position.targetEmissionPosition[0]).toBeLessThan(2)
})

test('observation rejects moving origins, coincident points, and unbounded work', () => {
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [vecZero(), vecZero()])
	const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [vecZero(), vecZero()])
	const earthOrigin = ephemerisPath(EARTH, MARS, target.stateAt)
	expect(() => observeEphemeris(earthOrigin, target, TIME)).toThrow('observer ephemeris path must be SSB-centered')
	expect(() => observeEphemeris(observer, earthOrigin, TIME)).toThrow('target ephemeris path must be SSB-centered')
	expect(observeEphemeris(observer, target, TIME)).toBeUndefined()
	expect(() => observeEphemeris(observer, target, TIME, { lightTimeIterations: Infinity })).toThrow('lightTimeIterations must be an integer in [0, 16]')
})

test('apparent stage matches the low-level finite-distance correction pipeline', () => {
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [vecZero(), [0, 0.01, 0]])
	const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [[1, 0.1, 0], vecZero()])
	const sun = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.SUN), () => [[-1, 0, 0], vecZero()])
	const deflector = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.JUPITER), () => [
		[0.5, 0.01, 0],
		[0, 0.001, 0],
	])
	const astrometric = observeEphemeris(observer, target, TIME)!
	const apparent = apparentPosition(astrometric, { sun, deflectors: [{ mass: SUN_LIGHT_DEFLECTOR_MASS, limiter: SUN_LIGHT_DEFLECTOR_LIMITER, path: deflector }] })
	const lowLevel = apparentDirection(target.stateAt, observer.stateAt, TIME, { sun: sun.stateAt, deflectors: [{ mass: SUN_LIGHT_DEFLECTOR_MASS, limiter: SUN_LIGHT_DEFLECTOR_LIMITER, state: deflector.stateAt }] })!
	expect(apparent.kind).toBe('apparent')
	expect(apparent.center).toBe(EARTH)
	expect(apparent.target).toBe(MARS)
	expect(apparent.time).toBe(TIME)
	expect(apparent.emissionTime).toEqual(astrometric.emissionTime)
	expect(apparent.distance).toBe(astrometric.distance)
	expect(apparent.lightTime).toBe(astrometric.lightTime)
	for (let i = 0; i < 3; i++) expect(apparent.direction[i]).toBeCloseTo(lowLevel.apparent[i], 15)
	expect(vecLength(apparent.direction)).toBeCloseTo(1, 14)
	expect(apparentPosition(astrometric, { aberration: false }).direction).toEqual(astrometric.direction)
})

test('apparent stage requires barycentric Sun and deflectors', () => {
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [vecZero(), vecZero()])
	const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [[1, 0, 0], vecZero()])
	const astrometric = observeEphemeris(observer, target, TIME)!
	const nonBarycentric = ephemerisPath(EARTH, MARS, target.stateAt)
	expect(() => apparentPosition(astrometric)).toThrow('sun barycentric state is required')
	expect(() => apparentPosition(astrometric, { sun: nonBarycentric })).toThrow('sun ephemeris path must be SSB-centered')
	expect(() => apparentPosition(astrometric, { aberration: false, deflectors: [{ mass: 1, limiter: 6e-6, path: nonBarycentric }] })).toThrow('light deflector ephemeris path must be SSB-centered')
})

test('frame and equatorial helpers preserve stage-specific physical quantities', () => {
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [vecZero(), vecZero()])
	const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [
		[1, 1, 0.5],
		[0, 0.01, 0],
	])
	const geometric = ephemerisAt(target, TIME)
	const astrometric = observeEphemeris(observer, target, TIME)!
	const apparent = apparentPosition(astrometric, { aberration: false })
	const expectedState = frameAt([geometric.position, geometric.velocity] as const, ITRS, TIME)
	const actualState = geometricPositionInFrame(geometric, ITRS)
	for (let axis = 0; axis < 3; axis++) {
		expect(actualState[0][axis]).toBeCloseTo(expectedState[0][axis], 14)
		expect(actualState[1][axis]).toBeCloseTo(expectedState[1][axis], 14)
	}
	const workspace: PositionAndVelocity = [vecZero(), vecZero()]
	expect(geometricPositionInFrame(geometric, ITRS, workspace)).toBe(workspace)
	const rotated = directionPositionInFrame(astrometric, ITRS)
	const expectedDirection = frameAt(astrometric.direction, ITRS, TIME)
	for (let axis = 0; axis < 3; axis++) expect(rotated[axis]).toBeCloseTo(expectedDirection[axis], 14)
	expect(equatorialPosition(geometric)[2]).toBeCloseTo(vecLength(geometric.position), 14)
	expect(equatorialPosition(astrometric)[2]).toBeCloseTo(astrometric.distance, 14)
	expect(equatorialPosition(apparent)[2]).toBeCloseTo(astrometric.distance, 14)
	expect(geometricSphericalPositionAndVelocity(geometric)?.radialVelocity).toBeCloseTo((geometric.position[1] * geometric.velocity[1]) / vecLength(geometric.position), 14)
	expect(geometricSphericalPositionAndVelocity(geometric, ITRS)?.radialVelocity).toBeCloseTo(geometricSphericalPositionAndVelocity(geometric)?.radialVelocity ?? 0, 8)
})

test('equatorial position publishes right ascension in [0, TAU)', () => {
	const geometric = ephemerisAt(
		ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [[0, -1, 0], vecZero()]),
		TIME,
	)
	const [rightAscension, declination, distance] = equatorialPosition(geometric)
	expect(rightAscension).toBeCloseTo((3 * PI) / 2, 14)
	expect(rightAscension).toBeGreaterThanOrEqual(0)
	expect(rightAscension).toBeLessThan(TAU)
	expect(declination).toBeCloseTo(0, 14)
	expect(distance).toBeCloseTo(1, 14)

	const astrometric = observeEphemeris(
		ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [vecZero(), vecZero()]),
		ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [[0, -1, 0], vecZero()]),
		TIME,
	)!
	const apparent = apparentPosition(astrometric, { aberration: false })
	expect(equatorialPosition(astrometric)[0]).toBeCloseTo((3 * PI) / 2, 12)
	expect(equatorialPosition(apparent)[0]).toBeCloseTo((3 * PI) / 2, 12)

	const epsilon = 1e-8
	const nearWrap = equatorialPosition(
		ephemerisAt(
			ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [[Math.cos(-epsilon), Math.sin(-epsilon), 0], vecZero()]),
			TIME,
		),
	)[0]
	expect(nearWrap).toBeCloseTo(normalizeAngle(-epsilon), 12)
	expect(nearWrap).toBeGreaterThan(TAU - 1e-6)
	expect(nearWrap).toBeLessThan(TAU)
})

type NoVelocity<T> = T extends { velocity: unknown } ? never : true

const ASTROMETRIC_HAS_NO_VELOCITY: NoVelocity<AstrometricPosition> = true
const APPARENT_HAS_NO_VELOCITY: NoVelocity<ApparentPosition> = true

function stationary(position: Vec3, velocity?: Vec3): PositionAndVelocity {
	return [vecClone(position), velocity ? vecClone(velocity) : vecZero()]
}

function barycentric(target: ReturnType<typeof naifEphemerisEndpoint>, state: PositionAndVelocity) {
	return ephemerisPath(SOLAR_SYSTEM_BARYCENTER, target, () => state)
}

const SUN = naifEphemerisEndpoint(Naif.SUN)

test('zero and very large geometric states stay finite and owned', () => {
	const zero = ephemerisAt(barycentric(EARTH, stationary(vecZero(), vecZero())), TIME)
	expect(zero.kind).toBe('geometric')
	expect(zero.position).toEqual(vecZero())
	expect(zero.velocity).toEqual(vecZero())
	expect(zero.position).not.toBe(zero.velocity)
	const large = ephemerisAt(barycentric(MARS, stationary([1e8, -1e8, 1e8], [1e3, 0, -1e3])), TIME)
	expect(large.position.every(Number.isFinite)).toBe(true)
	expect(large.velocity.every(Number.isFinite)).toBe(true)
	expect(vecLength(large.position)).toBeCloseTo(Math.hypot(1e8, 1e8, 1e8), 6)
})

test('observation is SSB-only, unit, and has no public velocity', () => {
	const site = ephemerisPath(EARTH, customEphemerisEndpoint('site'), () => stationary([1e-5, 0, 0], [0, 1e-6, 0]))
	const moon = ephemerisPath(EARTH, naifEphemerisEndpoint(Naif.MOON), () => stationary([0.002, 0, 0]))
	expect(() => observeEphemeris(site, moon, TIME)).toThrow('observer ephemeris path must be SSB-centered')
	expect(() => observeEphemeris(barycentric(EARTH, stationary(vecZero())), moon, TIME)).toThrow('target ephemeris path must be SSB-centered')
	const observed = observeEphemeris(barycentric(EARTH, stationary(vecZero(), [0, 0.01, 0])), barycentric(MARS, stationary([2, 0.1, -0.2])), TIME)!
	expect(observed.center).toBe(EARTH)
	expect(observed.target).toBe(MARS)
	expect(observed.kind).toBe('astrometric')
	expect(vecLength(observed.direction)).toBeCloseTo(1, 14)
	expect(observed.distance).toBeCloseTo(vecLength(observed.position), 14)
	expect(observed.distance).toBeGreaterThan(1)
	expect(ASTROMETRIC_HAS_NO_VELOCITY).toBe(true)
	expect(APPARENT_HAS_NO_VELOCITY).toBe(true)
	expect(observed).not.toBeInstanceOf(Promise)
})

test('deflector snapshots, ordering inputs, and the absence of a hidden ephemeris', () => {
	const scratch: PositionAndVelocity = [vecZero(), vecZero()]
	let sunCalls = 0
	const sun = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, SUN, () => {
		sunCalls++
		scratch[0] = [-1, 0.1, 0]
		scratch[1] = [0, 0.001, 0]
		return scratch
	})
	const deflector = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.JUPITER), () => {
		scratch[0] = [0.4, 0.02, 0]
		scratch[1] = [0, 0.002, 0]
		return scratch
	})
	const observed = observeEphemeris(barycentric(EARTH, stationary(vecZero(), [0, 0.017, 0])), barycentric(MARS, stationary([1, 0.05, 0.01])), TIME)!
	const withoutDeflection = apparentPosition(observed, { sun, deflectors: [] })
	const withSun = apparentPosition(observed, { sun, deflectors: [{ mass: SUN_LIGHT_DEFLECTOR_MASS, limiter: SUN_LIGHT_DEFLECTOR_LIMITER, path: sun }] })
	expect(vecAngle(withoutDeflection.direction, observed.direction)).toBeGreaterThan(1e-6)
	expect(vecAngle(withSun.direction, withoutDeflection.direction)).toBeGreaterThan(1e-12)
	scratch[0][0] = 50
	scratch[1][0] = 50
	const again = apparentPosition(observed, { sun, deflectors: [{ mass: SUN_LIGHT_DEFLECTOR_MASS, limiter: SUN_LIGHT_DEFLECTOR_LIMITER, path: deflector }] })
	expect(again.direction.every(Number.isFinite)).toBe(true)
	expect(vecLength(again.direction)).toBeCloseTo(1, 12)
	sunCalls = 0
	apparentPosition(observed, { aberration: false, sun, deflectors: [] })
	expect(sunCalls).toBe(0)
	let samples = 0
	const invalid = ephemerisPath(EARTH, MARS, () => {
		samples++
		return stationary([1, 0, 0])
	})
	expect(() =>
		apparentPosition(observed, {
			aberration: false,
			deflectors: [
				{ mass: 1, limiter: 6e-6, path: sun },
				{ mass: 1, limiter: 6e-6, path: invalid },
			],
		}),
	).toThrow('light deflector ephemeris path must be SSB-centered')
	expect(samples).toBe(0)
	expect(() => apparentPosition(observed)).toThrow('sun barycentric state is required')
	expect(vecAngle(apparentPosition(observed, { sun, deflectors: [] }).direction, apparentPosition(observed, { sun }).direction)).toBeLessThan(1e-15)
})

test('correction order is light deflection then aberration', () => {
	const observerPosition: Vec3 = vecZero()
	const observerVelocity: Vec3 = [0, 0.12, 0]
	const targetPosition: Vec3 = [1, 0, 0]
	const sunPosition: Vec3 = [0.35, 0.004, 0]
	const sunVelocity: Vec3 = vecZero()
	const observed = observeEphemeris(barycentric(EARTH, stationary(observerPosition, observerVelocity)), barycentric(MARS, stationary(targetPosition)), TIME)!
	const sun = barycentric(SUN, stationary(sunPosition, sunVelocity))
	const apparent = apparentPosition(observed, { sun, deflectors: [{ mass: SUN_LIGHT_DEFLECTOR_MASS, limiter: SUN_LIGHT_DEFLECTOR_LIMITER, path: sun }] })
	const lightDays = LIGHT_TIME_AU / DAYSEC
	const deflect = (direction: Vec3): MutVec3 => {
		const out: MutVec3 = [direction[0], direction[1], direction[2]]
		let delay = (out[0] * sunPosition[0] + out[1] * sunPosition[1] + out[2] * sunPosition[2]) * lightDays
		if (!(delay > 0)) delay = 0
		else if (delay > observed.lightTime) delay = observed.lightTime
		const body: Vec3 = [sunPosition[0] - delay * sunVelocity[0], sunPosition[1] - delay * sunVelocity[1], sunPosition[2] - delay * sunVelocity[2]]
		const towardBody: MutVec3 = [-body[0], -body[1], -body[2]]
		const towardTarget: MutVec3 = [targetPosition[0] - body[0], targetPosition[1] - body[1], targetPosition[2] - body[2]]
		const bodyDistance = vecLength(towardBody)
		vecDivScalar(towardBody, bodyDistance, towardBody)
		vecDivScalar(towardTarget, vecLength(towardTarget), towardTarget)
		return eraLd(SUN_LIGHT_DEFLECTOR_MASS, out, towardTarget, towardBody, bodyDistance, SUN_LIGHT_DEFLECTOR_LIMITER)
	}
	const sunDistance = vecDistance(observerPosition, sunPosition)
	const libraryOrder = annualAberration(deflect(observed.direction), observerVelocity, sunDistance)
	const inverted = deflect(annualAberration(observed.direction, observerVelocity, sunDistance))
	const chord = (left: Vec3, right: Vec3) => Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2])
	expect(chord(libraryOrder, apparent.direction)).toBeLessThan(1e-12)
	expect(chord(inverted, apparent.direction)).toBeGreaterThan(1e-12)
})

test('deflector order is observable once motion makes the backtrack depend on direction', () => {
	// Stationary eraLd updates commute. The undeflected ray lies in each observer-mass-target
	// plane, so the second-order commutator is identically zero. Along-track velocity makes the
	// light-time backtrack use the direction left by the previous mass, which is the order
	// apparentPosition has to preserve. The masses and speeds are exaggerated so that chord
	// clears 1e-10; a Solar-System pair stays below a double ulp.
	const observed = observeEphemeris(barycentric(EARTH, stationary(vecZero(), vecZero())), barycentric(MARS, stationary([1, 0, 0])), TIME)!
	const approaching = barycentric(SUN, stationary([0.3, 0.001, 0], [15, 0, 0]))
	const receding = barycentric(naifEphemerisEndpoint(Naif.JUPITER), stationary([0.7, -0.001, 0], [-15, 0, 0]))
	const deflector = (path: ReturnType<typeof barycentric>) => ({ mass: 100, limiter: 1e-18, path })
	const forward = apparentPosition(observed, { aberration: false, deflectors: [deflector(approaching), deflector(receding)] })
	const backward = apparentPosition(observed, { aberration: false, deflectors: [deflector(receding), deflector(approaching)] })
	const separation = Math.hypot(forward.direction[0] - backward.direction[0], forward.direction[1] - backward.direction[1], forward.direction[2] - backward.direction[2])
	expect(separation).toBeGreaterThan(1e-10)
	expect(vecLength(forward.direction)).toBeCloseTo(1, 12)
	expect(vecLength(backward.direction)).toBeCloseTo(1, 12)
	expect(forward.direction.every(Number.isFinite)).toBe(true)
	expect(backward.direction.every(Number.isFinite)).toBe(true)
})

test('singular directions and tiny or huge separations stay finite when defined', () => {
	const observer = barycentric(EARTH, stationary(vecZero()))
	expect(observeEphemeris(observer, barycentric(MARS, stationary(vecZero())), TIME)).toBeUndefined()
	for (const position of [
		[0, 0, 1],
		[0, 0, -1],
		[1e-6, 0, 1],
		[1e-15, 0, 0],
		[1e8, -1e8, 1e7],
		[1e-12, -1e-12, 1e-12],
	] as const) {
		const geometric = ephemerisAt(barycentric(MARS, stationary(position)), TIME)
		const [rightAscension, declination, distance] = equatorialPosition(geometric)
		expect(Number.isFinite(rightAscension)).toBe(true)
		expect(Number.isFinite(declination)).toBe(true)
		expect(Number.isFinite(distance)).toBe(true)
		expect(rightAscension).toBeGreaterThanOrEqual(0)
		expect(rightAscension).toBeLessThan(TAU)
		if (position[2] === 1 && position[0] === 0) expect(declination).toBeCloseTo(PIOVERTWO, 12)
		if (position[2] === -1 && position[0] === 0) expect(declination).toBeCloseTo(-PIOVERTWO, 12)
	}
	const almost = observeEphemeris(observer, barycentric(MARS, stationary([1e-12, -2e-12, 3e-12])), TIME)!
	expect(vecLength(almost.direction)).toBeCloseTo(1, 12)
	expect(Number.isFinite(almost.lightTime)).toBe(true)
})

test('frame helpers own outputs and keep the rotating-frame velocity term', () => {
	const geometric = ephemerisAt(barycentric(MARS, stationary([0.8, -0.4, 0.3], [0.012, -0.007, 0.004])), TIME)
	const observed = observeEphemeris(barycentric(EARTH, stationary(vecZero())), barycentric(MARS, stationary([0.8, -0.4, 0.3])), TIME)!
	const original = [observed.direction[0], observed.direction[1], observed.direction[2]]
	for (const frame of [ICRS, GALACTIC, ECLIPTIC_J2000, CIRS, ITRS]) {
		const directed = directionPositionInFrame(observed, frame)
		const expected = frameAt(observed.direction, frame, TIME)
		expect(directed).not.toBe(observed.direction)
		for (let axis = 0; axis < 3; axis++) expect(directed[axis]).toBeCloseTo(expected[axis], 14)
	}
	expect(observed.direction[0]).toBe(original[0])
	expect(observed.direction[1]).toBe(original[1])
	expect(observed.direction[2]).toBe(original[2])
	const identity = geometricPositionInFrame(geometric, ICRS)
	for (let axis = 0; axis < 3; axis++) {
		expect(identity[0][axis]).toBeCloseTo(geometric.position[axis], 14)
		expect(identity[1][axis]).toBeCloseTo(geometric.velocity[axis], 14)
	}
	const rotated = geometricPositionInFrame(geometric, ITRS)
	const rotationOnly = frameAt(geometric.position, ITRS, TIME)
	for (let axis = 0; axis < 3; axis++) expect(rotated[0][axis]).toBeCloseTo(rotationOnly[axis], 14)
	const velocityOnly = frameAt([geometric.position, geometric.velocity] as const, { rotationAt: ITRS.rotationAt }, TIME)
	expect(Math.hypot(rotated[1][0] - velocityOnly[1][0], rotated[1][1] - velocityOnly[1][1], rotated[1][2] - velocityOnly[1][2])).toBeGreaterThan(1e-6)
	const workspace: PositionAndVelocity = [vecZero(), vecZero()]
	expect(geometricPositionInFrame(geometric, ECLIPTIC_J2000, workspace)).toBe(workspace)
	const position: MutVec3 = [geometric.position[0], geometric.position[1], geometric.position[2]]
	const velocity: MutVec3 = [geometric.velocity[0], geometric.velocity[1], geometric.velocity[2]]
	const aliased = geometricPositionInFrame({ ...geometric, position, velocity }, ICRS, [position, velocity])
	expect(aliased[0]).toBe(position)
	expect(aliased[1]).toBe(velocity)
	const roundTrip = frameToBase(geometricPositionInFrame(ephemerisAt(barycentric(MARS, stationary([0.8, -0.4, 0.3], [0.012, -0.007, 0.004])), TIME), GALACTIC), GALACTIC, TIME)
	for (let axis = 0; axis < 3; axis++) {
		expect(roundTrip[0][axis]).toBeCloseTo(0.8 * (axis === 0 ? 1 : axis === 1 ? -0.5 : 0.375), 12)
	}
	expect(roundTrip[0][0]).toBeCloseTo(0.8, 12)
	expect(roundTrip[0][1]).toBeCloseTo(-0.4, 12)
	expect(roundTrip[0][2]).toBeCloseTo(0.3, 12)
})

describe('equatorial coordinates cover the cardinal axes, poles, and stage distances', () => {
	const cases = [
		{ position: [1, 0, 0], ra: 0, dec: 0 },
		{ position: [0, 1, 0], ra: PIOVERTWO, dec: 0 },
		{ position: [-1, 0, 0], ra: PI, dec: 0 },
		{ position: [0, -1, 0], ra: (3 * PI) / 2, dec: 0 },
		{ position: [1e-8, 0, 1], ra: 0, dec: Math.atan2(1, 1e-8) },
		{ position: [0, 0, 1], ra: 0, dec: PIOVERTWO },
		{ position: [0, 0, -1], ra: 0, dec: -PIOVERTWO },
		{ position: [Math.cos(1e-8), Math.sin(1e-8), 0], ra: 1e-8, dec: 0 },
		{ position: [Math.cos(-1e-8), Math.sin(-1e-8), 0], ra: normalizeAngle(-1e-8), dec: 0 },
	] as const
	for (const item of cases) {
		test(JSON.stringify(item), () => {
			const [rightAscension, declination, distance] = equatorialPosition(ephemerisAt(barycentric(MARS, stationary(item.position)), TIME))
			expect(rightAscension).toBeCloseTo(item.ra, 10)
			expect(declination).toBeCloseTo(item.dec, 10)
			expect(distance).toBeCloseTo(vecLength(item.position), 12)
			expect(rightAscension).toBeGreaterThanOrEqual(0)
			expect(rightAscension).toBeLessThan(TAU)
		})
	}
})

test('spherical geometric state covers motion, poles, and an optional frame', () => {
	const at = (position: Vec3, velocity: Vec3) => ephemerisAt(barycentric(MARS, stationary(position, velocity)), TIME)
	const circular = geometricSphericalPositionAndVelocity(at([1, 0, 0], [0, 1, 0]))!
	expect(circular.longitudeRate).toBeCloseTo(1, 12)
	expect(circular.latitudeRate).toBeCloseTo(0, 12)
	expect(circular.radialVelocity).toBeCloseTo(0, 12)
	const radial = geometricSphericalPositionAndVelocity(at([1, 0, 0], [0.2, 0, 0]))!
	expect(radial.radialVelocity).toBeCloseTo(0.2, 12)
	expect(radial.longitudeRate).toBeCloseTo(0, 12)
	const latitude = geometricSphericalPositionAndVelocity(at([1, 0, 0], [0, 0, 0.3]))!
	expect(latitude.latitudeRate).toBeCloseTo(0.3, 12)
	const mixed = geometricSphericalPositionAndVelocity(at([0.8, -0.4, 0.3], [0.012, -0.007, 0.004]))!
	// Skyfield 1.55 ICRF.frame_latlon_and_rates(ICRS).
	expect(mixed.latitude).toBeCloseTo(0.3236185653039863, 14)
	expect(mixed.longitude).toBeCloseTo(5.81953769817878, 14)
	expect(mixed.distance).toBeCloseTo(0.9433981132056605, 14)
	expect(mixed.latitudeRate).toBeCloseTo(-0.000653233341741511, 12)
	expect(mixed.longitudeRate).toBeCloseTo(-0.001, 12)
	expect(mixed.radialVelocity).toBeCloseTo(0.014415971168086496, 12)
	expect(geometricSphericalPositionAndVelocity(at(vecZero(), [1, 0, 0]))).toBeUndefined()
	expect(geometricSphericalPositionAndVelocity(at([0, 0, 1], [0.1, -0.2, 0.3]))!.longitudeRate).toBeUndefined()
	expect(geometricSphericalPositionAndVelocity(at([0, 0, -2], [0.1, 0.2, 0]))!.latitudeRate).toBeUndefined()
	const nearPole = geometricSphericalPositionAndVelocity(at([1e-8, 0, 1], [0, 1, 0]))!
	expect(nearPole.longitudeRate).toBeGreaterThan(1e6)
	expect(geometricSphericalPositionAndVelocity(at([1, 0.2, 0.3], [0.01, 0.02, 0.03]))).toBeDefined()
	const framed = geometricSphericalPositionAndVelocity(at([0.8, -0.4, 0.3], [0.012, -0.007, 0.004]), GALACTIC)!
	expect(framed.distance).toBeCloseTo(mixed.distance, 12)
	expect(framed.longitude).not.toBeCloseTo(mixed.longitude, 3)
})

test('distances, unit directions, and a galactic round trip stay finite', () => {
	const random = mulberry32(0x91f)

	for (let sample = 0; sample < 64; sample++) {
		const target = [random() + 0.2, random() - 0.5, random() - 0.5] as Vec3
		const velocity = [random() * 0.01, random() * 0.01, random() * 0.01] as Vec3
		const geometric = ephemerisAt(barycentric(MARS, stationary(target, velocity)), TIME)
		expect(vecLength(geometric.position)).toBeGreaterThan(0)
		const observed = observeEphemeris(barycentric(EARTH, stationary(vecZero(), [0, 0.01, 0])), barycentric(MARS, stationary(target, velocity)), TIME)!
		expect(observed.distance).toBeGreaterThan(0)
		expect(vecLength(observed.direction)).toBeCloseTo(1, 12)
		const apparent = apparentPosition(observed, { aberration: false })
		expect(vecLength(apparent.direction)).toBeCloseTo(1, 12)
		const roundTrip = frameToBase(geometricPositionInFrame(geometric, GALACTIC), GALACTIC, TIME)
		for (let axis = 0; axis < 3; axis++) expect(roundTrip[0][axis]).toBeCloseTo(target[axis], 12)
	}
})

test('stage metadata and synchronous evaluation are preserved', () => {
	const observer = barycentric(EARTH, stationary([0.1, 0.2, 0.3], [0.01, 0, 0]))
	const target = barycentric(MARS, stationary([1.4, -0.2, 0.5], [0, 0.001, 0]))
	const geometric = ephemerisAt(target, TIME)
	const astrometric = observeEphemeris(observer, target, TIME)!
	const sun = barycentric(SUN, stationary([-0.5, 0.2, 0.1]))
	const apparent = apparentPosition(astrometric, { sun, deflectors: [] })
	expect(geometric.time).toBe(TIME)
	expect(astrometric.time).toBe(TIME)
	expect(astrometric.emissionTime.day + astrometric.emissionTime.fraction).toBeLessThan(TIME.day + TIME.fraction)
	expect(apparent.time).toBe(astrometric.time)
	expect(apparent.emissionTime).toBe(astrometric.emissionTime)
	expect(apparent.distance).toBe(astrometric.distance)
	expect(apparent.lightTime).toBe(astrometric.lightTime)
	expect(apparent.center).toBe(astrometric.center)
	expect(apparent.target).toBe(astrometric.target)
	expect(geometric).not.toBeInstanceOf(Promise)
	expect(astrometric).not.toBeInstanceOf(Promise)
	expect(apparent).not.toBeInstanceOf(Promise)
	expect(target.stateAt(TIME)).not.toBeInstanceOf(Promise)
})
