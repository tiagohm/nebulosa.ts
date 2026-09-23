import { expect, test } from 'bun:test'
import { relativePositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, mars } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, relativeEphemerisPath, reverseEphemerisPath, sameEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'

const TIME = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TDB)
const EARTH = naifEphemerisEndpoint(Naif.EARTH)
const MOON = naifEphemerisEndpoint(Naif.MOON)

test('endpoint identity uses kind and id, not display name', () => {
	expect(sameEphemerisEndpoint(EARTH, naifEphemerisEndpoint(Naif.EARTH, 'Earth'))).toBe(true)
	expect(sameEphemerisEndpoint(EARTH, MOON)).toBe(false)
	expect(sameEphemerisEndpoint(customEphemerisEndpoint('site'), customEphemerisEndpoint('site', 'observatory'))).toBe(true)
	expect(sameEphemerisEndpoint(EARTH, customEphemerisEndpoint(String(Naif.EARTH)))).toBe(false)
	expect(SOLAR_SYSTEM_BARYCENTER.id).toBe(Naif.SSB)
})

test('path preserves endpoints and provider while reverse owns negated vectors', () => {
	const shared: [number, number, number] = [1, 2, 3]
	const stateAt = () => [shared, shared] as [[number, number, number], [number, number, number]]
	const path = ephemerisPath(EARTH, MOON, stateAt)
	expect(path.center).toBe(EARTH)
	expect(path.target).toBe(MOON)
	expect(path.stateAt).toBe(stateAt)
	const reversed = reverseEphemerisPath(path)
	expect(reversed.center).toBe(MOON)
	expect(reversed.target).toBe(EARTH)
	const [p, v] = reversed.stateAt(TIME)
	expect(p).toEqual([-1, -2, -3])
	expect(v).toEqual([-1, -2, -3])
	expect(p).not.toBe(shared)
	expect(v).not.toBe(shared)
})

test('composition snapshots first provider before shared scratch is reused', () => {
	const scratch: [[number, number, number], [number, number, number]] = [
		[0, 0, 0],
		[0, 0, 0],
	]
	const first = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => {
		scratch[0] = [1, 2, 3]
		scratch[1] = [4, 5, 6]
		return scratch
	})
	const second = ephemerisPath(naifEphemerisEndpoint(Naif.EARTH, 'named'), MOON, () => {
		scratch[0][0] = 7
		scratch[0][1] = 8
		scratch[0][2] = 9
		scratch[1][0] = 10
		scratch[1][1] = 11
		scratch[1][2] = 12
		return scratch
	})
	const combined = composeEphemerisPaths(first, second)
	const [p, v] = combined.stateAt(TIME)
	expect(combined.center).toBe(SOLAR_SYSTEM_BARYCENTER)
	expect(combined.target).toBe(MOON)
	expect(p).toEqual([8, 10, 12])
	expect(v).toEqual([14, 16, 18])
	scratch[0][0] = 99
	expect(p[0]).toBe(8)
})

test('invalid composition and relative centers fail before sampling', () => {
	const earth = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [
		[1, 0, 0],
		[0, 1, 0],
	])
	const moon = ephemerisPath(EARTH, MOON, () => [
		[0, 2, 0],
		[0, 0, 3],
	])
	expect(() => composeEphemerisPaths(moon, earth)).toThrow('first target does not match second center')
	expect(() => relativeEphemerisPath(moon, earth)).toThrow('centers do not match')
	expect(relativeEphemerisPath(composeEphemerisPaths(earth, moon), earth).stateAt(TIME)).toEqual([
		[0, 2, 0],
		[0, 0, 3],
	])
})

test('VSOP relative Earth-to-Mars and ELP barycentric Moon agree with low-level states', () => {
	const earthPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, earth)
	const marsPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.MARS), mars)
	const moonPath = ephemerisPath(EARTH, MOON, moon)
	const relativeMars = relativeEphemerisPath(marsPath, earthPath).stateAt(TIME)
	const expectedMars = relativePositionAndVelocity(mars, earth, TIME)
	const barycentricMoon = composeEphemerisPaths(earthPath, moonPath).stateAt(TIME)
	const earthState = earth(TIME)
	const moonState = moon(TIME)
	for (let axis = 0; axis < 3; axis++) {
		expect(relativeMars[0][axis]).toBeCloseTo(expectedMars[0][axis], 13)
		expect(relativeMars[1][axis]).toBeCloseTo(expectedMars[1][axis], 13)
		expect(barycentricMoon[0][axis]).toBeCloseTo(earthState[0][axis] + moonState[0][axis], 13)
		expect(barycentricMoon[1][axis]).toBeCloseTo(earthState[1][axis] + moonState[1][axis], 13)
	}
})
