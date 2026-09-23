import { expect, test } from 'bun:test'
import { type PositionAndVelocity, type PositionAndVelocityOverTime, relativePositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, mars } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, relativeEphemerisPath, reverseEphemerisPath, sameEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER, type EphemerisEndpoint } from '../../../src/astronomy/ephemeris/path'
import { Timescale, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { vecNegate, vecXAxis, vecYAxis, vecZero, type MutVec3 } from '../../../src/math/linear-algebra/vec3'
import { mulberry32 } from '../../../src/math/numerical/random'

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
	const shared: MutVec3 = [1, 2, 3]
	const stateAt: PositionAndVelocityOverTime = () => [shared, shared]
	const path = ephemerisPath(EARTH, MOON, stateAt)
	expect(path.center).toBe(EARTH)
	expect(path.target).toBe(MOON)
	expect(path.stateAt).toBe(stateAt)
	const reversed = reverseEphemerisPath(path)
	expect(reversed.center).toBe(MOON)
	expect(reversed.target).toBe(EARTH)
	const [p, v] = reversed.stateAt(TIME)
	expect(p).toEqual(vecNegate(shared))
	expect(v).toEqual(vecNegate(shared))
	expect(p).not.toBe(shared)
	expect(v).not.toBe(shared)
})

test('composition snapshots first provider before shared scratch is reused', () => {
	const scratch: PositionAndVelocity = [vecZero(), vecZero()]
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
	const earth = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => [vecXAxis(), vecYAxis()])
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

function scratchPath(center: EphemerisEndpoint, target: EphemerisEndpoint, position: readonly [number, number, number], velocity: readonly [number, number, number], scratch: PositionAndVelocity) {
	return ephemerisPath(center, target, () => {
		scratch[0][0] = position[0]
		scratch[0][1] = position[1]
		scratch[0][2] = position[2]
		scratch[1][0] = velocity[0]
		scratch[1][1] = velocity[1]
		scratch[1][2] = velocity[2]
		return scratch
	})
}

function expectStateClose(actual: PositionAndVelocity, expected: PositionAndVelocity, digits: number) {
	for (let axis = 0; axis < 3; axis++) {
		expect(actual[0][axis]).toBeCloseTo(expected[0][axis], digits)
		expect(actual[1][axis]).toBeCloseTo(expected[1][axis], digits)
	}
}

test('reverse is an involution at several epochs', () => {
	const scratch: PositionAndVelocity = [vecZero(), vecZero()]
	const path = scratchPath(EARTH, MOON, [0.2, -0.4, 0.6], [0.01, 0.02, -0.03], scratch)
	const reversed = reverseEphemerisPath(path)
	const restored = reverseEphemerisPath(reversed)
	for (let step = 0; step < 5; step++) {
		const time = timeShift(TIME, step * 0.25)
		const original = path.stateAt(time)
		const back = restored.stateAt(time)
		expect(reversed.center).toBe(MOON)
		expect(reversed.target).toBe(EARTH)
		expectStateClose(
			back,
			[
				[0.2, -0.4, 0.6],
				[0.01, 0.02, -0.03],
			],
			15,
		)
		expect(back[0]).not.toBe(original[0])
		expect(back[1]).not.toBe(original[1])
		expect(back[0]).not.toBe(back[1])
	}
})

test('mismatched endpoint kind is rejected before either provider is sampled', () => {
	let samples = 0
	const first = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, () => {
		samples++
		return [vecXAxis(), vecZero()]
	})
	const second = ephemerisPath(customEphemerisEndpoint(String(Naif.EARTH), 'Earth'), MOON, () => {
		samples++
		return [vecYAxis(), vecZero()]
	})
	expect(sameEphemerisEndpoint(first.target, second.center)).toBe(false)
	expect(() => composeEphemerisPaths(first, second)).toThrow('first target does not match second center')
	expect(samples).toBe(0)
})

test('composition is associative and a zero path is an identity', () => {
	const a = customEphemerisEndpoint('a')
	const b = customEphemerisEndpoint('b')
	const c = customEphemerisEndpoint('c')
	const d = customEphemerisEndpoint('d')
	const ab = ephemerisPath(a, b, () => [
		[0.1, -0.2, 0.3],
		[0.01, 0.02, -0.03],
	])
	const bc = ephemerisPath(b, c, () => [
		[-0.4, 0.5, 0.6],
		[0.004, -0.005, 0.006],
	])
	const cd = ephemerisPath(c, d, () => [
		[0.7, 0.8, -0.9],
		[-0.007, 0.008, 0.009],
	])
	const zero = ephemerisPath(a, a, () => [vecZero(), vecZero()])
	const left = composeEphemerisPaths(composeEphemerisPaths(ab, bc), cd).stateAt(TIME)
	const right = composeEphemerisPaths(ab, composeEphemerisPaths(bc, cd)).stateAt(TIME)
	expectStateClose(left, right, 12)
	expectStateClose(composeEphemerisPaths(zero, ab).stateAt(TIME), ab.stateAt(TIME), 15)
	expectStateClose(composeEphemerisPaths(ab, ephemerisPath(b, b, zero.stateAt)).stateAt(TIME), ab.stateAt(TIME), 15)
})

test('relative path matches manual subtraction over deterministic epochs', () => {
	const earthPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, earth)
	const marsPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.MARS), mars)
	const self = relativeEphemerisPath(earthPath, earthPath).stateAt(TIME)
	expect(self).toEqual([vecZero(), vecZero()])
	for (let step = 0; step < 24; step++) {
		const time = timeShift(TIME, step - 12)
		const actual = relativeEphemerisPath(marsPath, earthPath).stateAt(time)
		const expected = relativePositionAndVelocity(mars, earth, time)
		expectStateClose(actual, expected, 12)
	}
})

test('shared scratch survives a four-segment chain, reverse, and relative evaluation', () => {
	const scratch: PositionAndVelocity = [vecZero(), vecZero()]
	const ids = ['a', 'b', 'c', 'd', 'e'].map((id) => customEphemerisEndpoint(id))
	const offsets = [vecXAxis(), [0, 2, 0], [0, 0, 3], [4, 5, 6]] as const
	const velocities = [
		[0.1, 0, 0],
		[0, 0.2, 0],
		[0, 0, 0.3],
		[0.4, 0.5, 0.6],
	] as const
	const segments = offsets.map((position, index) => scratchPath(ids[index], ids[index + 1], position, velocities[index], scratch))
	let chain = segments[0]
	for (let index = 1; index < segments.length; index++) chain = composeEphemerisPaths(chain, segments[index])
	const first = chain.stateAt(TIME)
	expect(first[0]).toEqual([5, 7, 9])
	expect(first[1][0]).toBeCloseTo(0.5, 12)
	expect(first[1][1]).toBeCloseTo(0.7, 12)
	expect(first[1][2]).toBeCloseTo(0.9, 12)
	scratch[0][0] = 99
	scratch[1][0] = 99
	expect(first[0][0]).toBe(5)
	expect(first[1][0]).toBe(0.5)
	const second = chain.stateAt(timeShift(TIME, 1))
	expect(second).not.toBe(first)
	expect(second[0]).toEqual([5, 7, 9])
	expect(first[0][0]).toBe(5)
	const reversed = reverseEphemerisPath(chain).stateAt(TIME)
	expect(reversed[0]).toEqual([-5, -7, -9])
	expect(reversed[1][0]).toBeCloseTo(-0.5, 12)
	expect(reversed[1][1]).toBeCloseTo(-0.7, 12)
	expect(reversed[1][2]).toBeCloseTo(-0.9, 12)
	const relative = relativeEphemerisPath(chain, chain).stateAt(TIME)
	expect(relative[0]).toEqual(vecZero())
	expect(relative[1]).toEqual(vecZero())
})

test('reverse, composition, and relative subtraction hold for 64 deterministic states', () => {
	const random = mulberry32(0x5eed)
	const center = customEphemerisEndpoint('center')
	for (let sample = 0; sample < 64; sample++) {
		const ab: MutVec3 = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1]
		const bc: MutVec3 = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1]
		const cd: MutVec3 = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1]
		const vab: MutVec3 = [random() * 0.02, random() * 0.02, random() * 0.02]
		const vbc: MutVec3 = [random() * 0.02, random() * 0.02, random() * 0.02]
		const vcd: MutVec3 = [random() * 0.02, random() * 0.02, random() * 0.02]
		const b = customEphemerisEndpoint(`b${sample}`)
		const c = customEphemerisEndpoint(`c${sample}`)
		const d = customEphemerisEndpoint(`d${sample}`)
		const middle = customEphemerisEndpoint(`m${sample}`)
		const first = ephemerisPath(center, middle, () => [ab, vab])
		const second = ephemerisPath(middle, b, () => [bc, vbc])
		const third = ephemerisPath(b, d, () => [cd, vcd])
		const sibling = ephemerisPath(center, c, () => [bc, vbc])
		const forward = first.stateAt(TIME)
		expectStateClose(reverseEphemerisPath(reverseEphemerisPath(first)).stateAt(TIME), forward, 15)
		const left = composeEphemerisPaths(composeEphemerisPaths(first, second), third).stateAt(TIME)
		const right = composeEphemerisPaths(first, composeEphemerisPaths(second, third)).stateAt(TIME)
		expectStateClose(left, right, 12)
		const relative = relativeEphemerisPath(first, sibling)
		const manual: PositionAndVelocity = [
			[ab[0] - bc[0], ab[1] - bc[1], ab[2] - bc[2]],
			[vab[0] - vbc[0], vab[1] - vbc[1], vab[2] - vbc[2]],
		]
		expectStateClose(relative.stateAt(TIME), manual, 12)
		expect(Math.hypot(relative.stateAt(TIME)[0][0], relative.stateAt(TIME)[0][1], relative.stateAt(TIME)[0][2])).toBeGreaterThanOrEqual(0)
	}
})

test('VSOP and ELP paths match their low-level providers across epochs', () => {
	const earthPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, earth)
	const marsPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.MARS), mars)
	const moonPath = ephemerisPath(EARTH, MOON, moon)
	for (const epoch of [timeYMDHMS(2000, 1, 1, 12, 0, 0, Timescale.TDB), TIME, timeYMDHMS(2045, 7, 1, 0, 0, 0, Timescale.TDB)]) {
		expectStateClose(earthPath.stateAt(epoch), earth(epoch), 13)
		expectStateClose(marsPath.stateAt(epoch), mars(epoch), 13)
		expectStateClose(moonPath.stateAt(epoch), moon(epoch), 13)
		const composed = composeEphemerisPaths(earthPath, moonPath).stateAt(epoch)
		const earthState = earth(epoch)
		const moonState = moon(epoch)
		expectStateClose(
			composed,
			[
				[earthState[0][0] + moonState[0][0], earthState[0][1] + moonState[0][1], earthState[0][2] + moonState[0][2]],
				[earthState[1][0] + moonState[1][0], earthState[1][1] + moonState[1][1], earthState[1][2] + moonState[1][2]],
			],
			12,
		)
		expectStateClose(relativeEphemerisPath(marsPath, earthPath).stateAt(epoch), relativePositionAndVelocity(mars, earth, epoch), 12)
	}
})
