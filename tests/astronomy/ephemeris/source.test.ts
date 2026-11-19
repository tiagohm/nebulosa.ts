import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { inspectSpk } from '../../../src/astronomy/ephemeris/kernels/spk.inspect'
import { prepareSpkKernelSet } from '../../../src/astronomy/ephemeris/kernels/spk.kernelset'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { io } from '../../../src/astronomy/ephemeris/models/analytical/l12'
import { earth, jupiter, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { analyticalEphemerisSource, computeOnEphemerisSources, type EphemerisSource, EphemerisMiss, interpolatedEphemerisSource, relativeEphemerisState, spkEphemerisSource } from '../../../src/astronomy/ephemeris/source'
import { timeShift, timeYMDHMS, Timescale } from '../../../src/astronomy/time/time'
import { AU_KM } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/file'
import { vecDistance, vecLength, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { downloadPerTag } from '../../download'

await downloadPerTag('spk')

const TIME = timeYMDHMS(2026, 11, 19, 3, 0, 0, Timescale.UTC)

test('the analytical source composes the theories by NAIF code', () => {
	const source = analyticalEphemerisSource
	expect(source.state(10, TIME)).toEqual(sun(TIME))
	expect(source.state(399, TIME)).toEqual(earth(TIME))
	expect(source.state(599, TIME)).toEqual(jupiter(TIME))
	expect(source.state(5, TIME)).toEqual(jupiter(TIME))
	expect(source.state(0, TIME)).toEqual([
		[0, 0, 0],
		[0, 0, 0],
	])

	const geocentric = moon(TIME)
	expect(vecDistance(vecMinus(source.state(301, TIME)[0], earth(TIME)[0]), geocentric[0])).toBeLessThan(1e-15)
	expect(vecDistance(vecMinus(source.state(501, TIME)[0], jupiter(TIME)[0]), io(TIME)[0])).toBeLessThan(1e-15)
	expect(source.centerOf!(501)).toBe(599)
	expect(source.centerOf!(301)).toBe(399)
	expect(source.centerOf!(599)).toBeUndefined()

	// The Earth-Moon barycenter lies on the Earth-Moon line, 1/(1 + EMRAT) of the way to the Moon.
	expect(vecLength(vecMinus(source.state(3, TIME)[0], earth(TIME)[0])) / vecLength(geocentric[0])).toBeCloseTo(1 / 82.3005682214972154, 12)

	// Pluto, with the velocity of a central difference: about 4.7 km/s heliocentric in 2026.
	const plutoState = relativeEphemerisState(source, 999, 10, TIME)
	expect((vecLength(plutoState[1]) * AU_KM) / 86400).toBeGreaterThan(4)
	expect((vecLength(plutoState[1]) * AU_KM) / 86400).toBeLessThan(6)

	expect(source.has(2000004)).toBeFalse()
	expect(() => source.state(2000004, TIME)).toThrow(EphemerisMiss)
	try {
		source.state(2000004, TIME)
	} catch (error) {
		expect(error).toMatchObject({ target: 2000004, body: 2000004, reason: 'noModel' })
	}
})

test('the analytical source returns fresh states', () => {
	const a = analyticalEphemerisSource.state(399, TIME)
	a[0][0] = 99
	expect(analyticalEphemerisSource.state(399, TIME)[0][0]).not.toBe(99)
})

test('the SPK source resolves bodies through a real kernel set and reports the failing link', async () => {
	await using handle = fileHandleSource(await fs.open('data/de440s.bsp'))
	const daf = await readDaf(handle)
	const inspection = inspectSpk(daf, (await fs.stat('data/de440s.bsp')).size)
	if (!inspection.ok) throw new Error(inspection.error)
	const set = await prepareSpkKernelSet([{ id: 'de440s', daf, segments: inspection.segments }])
	const source = spkEphemerisSource(set)

	const resolved = set.stateAt(301, TIME)
	if (!resolved.ok) throw new Error(resolved.reason)
	expect(source.state(301, TIME)).toEqual([[...resolved.state[0]], [...resolved.state[1]]])
	expect([...source.kernelsByBody.get(301)!]).toEqual(['de440s'])
	expect(source.has(599)).toBeFalse()
	expect(() => source.state(599, TIME)).toThrow(EphemerisMiss)

	// The theories agree with DE440 within their own accuracy: about 1″ for the VSOP87E Earth (1100 km at 1 AU),
	// under a kilometre for the ELPMPP02 geocentric Moon.
	expect(vecDistance(source.state(399, TIME)[0], analyticalEphemerisSource.state(399, TIME)[0]) * AU_KM).toBeLessThan(2000)
	expect(vecDistance(relativeEphemerisState(source, 301, 399, TIME)[0], moon(TIME)[0]) * AU_KM).toBeLessThan(1)
})

test('the interpolated source stays within 0.1 km of its source, positions and velocities alike', () => {
	const interpolated = interpolatedEphemerisSource(analyticalEphemerisSource)
	expect(interpolated.kind).toBe('analytical')

	for (let i = 0; i < 12; i++) {
		const time = timeShift(TIME, i * 0.37)

		for (const naif of [10, 399, 301, 599, 501, 606]) {
			const exact = analyticalEphemerisSource.state(naif, time)
			const approximate = interpolated.state(naif, time)
			expect(vecDistance(exact[0], approximate[0]) * AU_KM).toBeLessThan(0.1)
			expect((vecDistance(exact[1], approximate[1]) * AU_KM) / 86400).toBeLessThan(1e-5)
		}
	}
})

test('a computation runs whole on the first source that gives every state it needs', () => {
	const failing: EphemerisSource = {
		kind: 'spk',
		has: () => true,
		state: (naif, time) => {
			throw new EphemerisMiss(naif, naif, 'coverage', time)
		},
	}

	const outcome = computeOnEphemerisSources([failing, analyticalEphemerisSource], (source) => source.state(399, TIME)[0][0])
	expect(outcome.source).toBe(analyticalEphemerisSource)
	expect(outcome.result).toBe(earth(TIME)[0][0])
	expect(outcome.misses.map((miss) => miss.reason)).toEqual(['coverage'])

	expect(() => computeOnEphemerisSources([failing], (source) => source.state(10, TIME))).toThrow(EphemerisMiss)
	expect(() =>
		computeOnEphemerisSources([analyticalEphemerisSource], () => {
			throw new TypeError('not a miss')
		}),
	).toThrow(TypeError)
})
