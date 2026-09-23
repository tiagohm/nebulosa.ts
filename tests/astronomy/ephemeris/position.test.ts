import { expect, test } from 'bun:test'
import { apparentDirection, SUN_LIGHT_DEFLECTOR_LIMITER, SUN_LIGHT_DEFLECTOR_MASS } from '../../../src/astronomy/coordinates/apparent'
import { topocentricDirection } from '../../../src/astronomy/coordinates/astrometry'
import { frameAt, ITRS } from '../../../src/astronomy/coordinates/frame'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { apparentPosition, directionPositionInFrame, ephemerisAt, equatorialPosition, geometricPositionInFrame, geometricSphericalPositionAndVelocity, observeEphemeris } from '../../../src/astronomy/ephemeris/position'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { vecLength } from '../../../src/math/linear-algebra/vec3'

const TIME = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TDB)
const EARTH = naifEphemerisEndpoint(Naif.EARTH)
const MARS = naifEphemerisEndpoint(Naif.MARS)

test('geometric materialization owns position and velocity from a reusable provider', () => {
	const scratch: [[number, number, number], [number, number, number]] = [
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
	const scratch: [[number, number, number], [number, number, number]] = [
		[0, 0, 0],
		[0, 0, 0],
	]
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
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [
		[0, 0, 0],
		[0, 0, 0],
	])
	const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [
		[0, 0, 0],
		[0, 0, 0],
	])
	const earthOrigin = ephemerisPath(EARTH, MARS, target.stateAt)
	expect(() => observeEphemeris(earthOrigin, target, TIME)).toThrow('observer ephemeris path must be SSB-centered')
	expect(() => observeEphemeris(observer, earthOrigin, TIME)).toThrow('target ephemeris path must be SSB-centered')
	expect(observeEphemeris(observer, target, TIME)).toBeUndefined()
	expect(() => observeEphemeris(observer, target, TIME, { lightTimeIterations: Infinity })).toThrow('lightTimeIterations must be an integer in [0, 16]')
})

test('apparent stage matches the low-level finite-distance correction pipeline', () => {
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [
		[0, 0, 0],
		[0, 0.01, 0],
	])
	const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [
		[1, 0.1, 0],
		[0, 0, 0],
	])
	const sun = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.SUN), () => [
		[-1, 0, 0],
		[0, 0, 0],
	])
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
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [
		[0, 0, 0],
		[0, 0, 0],
	])
	const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, MARS, () => [
		[1, 0, 0],
		[0, 0, 0],
	])
	const astrometric = observeEphemeris(observer, target, TIME)!
	const nonBarycentric = ephemerisPath(EARTH, MARS, target.stateAt)
	expect(() => apparentPosition(astrometric)).toThrow('sun barycentric state is required')
	expect(() => apparentPosition(astrometric, { sun: nonBarycentric })).toThrow('sun ephemeris path must be SSB-centered')
	expect(() => apparentPosition(astrometric, { aberration: false, deflectors: [{ mass: 1, limiter: 6e-6, path: nonBarycentric }] })).toThrow('light deflector ephemeris path must be SSB-centered')
})

test('frame and equatorial helpers preserve stage-specific physical quantities', () => {
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [
		[0, 0, 0],
		[0, 0, 0],
	])
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
	const workspace: [[number, number, number], [number, number, number]] = [
		[0, 0, 0],
		[0, 0, 0],
	]
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
