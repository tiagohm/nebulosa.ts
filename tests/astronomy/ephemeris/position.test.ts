import { expect, test } from 'bun:test'
import { topocentricDirection } from '../../../src/astronomy/coordinates/astrometry'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { ephemerisAt, observeEphemeris } from '../../../src/astronomy/ephemeris/position'
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
