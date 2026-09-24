import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { ECLIPTIC_J2000, frameAt, frameToFrame, ICRS, TEME } from '../../../src/astronomy/coordinates/frame'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { MultipleSpkSegment, readSpk, SPK_FRAME_J2000, type Spk, type SpkSegment } from '../../../src/astronomy/ephemeris/kernels/spk'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { bodySurfaceEphemerisPath, earthObserverEphemerisPath, sgp4EphemerisPath, spkEphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { ephemerisAt } from '../../../src/astronomy/ephemeris/position'
import { bodyShape, bodySurfaceLocation, bodySurfaceState } from '../../../src/astronomy/observer/body'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { parseTLE, recordFromTLE, SGP4_WGS72, SGP4_WGS84, sgp4 } from '../../../src/astronomy/orbits/propagation/sgp4'
import { Timescale, timeFromEpoch, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC, J2000, TAU, WGS84_RADIUS } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/io'
import { vecAngle, vecClone, vecLength, vecXAxis, vecYAxis, vecZAxis, vecZero } from '../../../src/math/linear-algebra/vec3'
import { deg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { downloadPerTag } from '../../download'

await Promise.all([downloadPerTag('spk'), downloadPerTag('frame.kernel')])

const TIME = timeYMDHMS(2023, 8, 19, 12, 25, 28, Timescale.UTC)

test('SPK adapter waits for the prepared segment and then evaluates synchronously', async () => {
	let prepared = false
	const segment: SpkSegment = {
		start: 0,
		end: 1,
		center: Naif.SSB,
		target: Naif.EARTH,
		frame: SPK_FRAME_J2000,
		startIndex: 1,
		endIndex: 1,
		initialize: () => {
			prepared = true
			return Promise.resolve()
		},
		at: () => {
			if (!prepared) throw new Error('uninitialized segment')
			return [
				[1, 2, 3],
				[4, 5, 6],
			]
		},
	}
	const spk: Spk = {
		segments: [[Naif.SSB, Naif.EARTH, segment]],
		segment: async (center, target) => {
			if (center !== Naif.SSB || target !== Naif.EARTH) return undefined
			await segment.initialize()
			return segment
		},
	}
	const path = (await spkEphemerisPath(spk, Naif.SSB, Naif.EARTH))!
	expect(prepared).toBe(true)
	expect(path.center).toEqual(naifEphemerisEndpoint(Naif.SSB))
	expect(path.target).toEqual(naifEphemerisEndpoint(Naif.EARTH))
	expect(path.stateAt(TIME)).toEqual([
		[1, 2, 3],
		[4, 5, 6],
	])
	expect(ephemerisAt(path, TIME)).not.toBeInstanceOf(Promise)
	expect(path.stateAt(TIME)).toEqual([
		[1, 2, 3],
		[4, 5, 6],
	])
	expect(await spkEphemerisPath(spk, Naif.SSB, Naif.MARS)).toBeUndefined()
})

test('SPK adapter accepts J2000 and rejects any other reference frame', async () => {
	// NAIF frame 17 is ECLIPJ2000. Treating it as ICRS would rotate the state by the obliquity.
	const segmentFor = (frame: number): SpkSegment => ({
		start: 0,
		end: 1,
		center: Naif.SSB,
		target: Naif.EARTH,
		frame,
		startIndex: 1,
		endIndex: 1,
		initialize: () => Promise.resolve(),
		at: () => [vecXAxis(), vecZero()],
	})
	const spkFor = (frame: number): Spk => {
		const segment = segmentFor(frame)
		return {
			segments: [[Naif.SSB, Naif.EARTH, segment]],
			segment: (center, target) => Promise.resolve(center === Naif.SSB && target === Naif.EARTH ? segment : undefined),
		}
	}

	const path = (await spkEphemerisPath(spkFor(SPK_FRAME_J2000), Naif.SSB, Naif.EARTH))!
	expect(path.center).toEqual(naifEphemerisEndpoint(Naif.SSB))
	expect(path.target).toEqual(naifEphemerisEndpoint(Naif.EARTH))
	expect(path.stateAt(TIME)).toEqual([vecXAxis(), vecZero()])
	expect(spkEphemerisPath(spkFor(17), Naif.SSB, Naif.EARTH)).rejects.toThrow('SPK frame 17 is not the library base frame')
})

test('SGP4 adapter uses a stable NORAD target and full TEME-to-ICRS state conversion', () => {
	const tle = parseTLE('1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996', '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611')
	const path = sgp4EphemerisPath(tle)
	const actual = path.stateAt(TIME)
	const expected = frameToFrame(sgp4(TIME, tle), TEME, ICRS, TIME)
	expect(path.center).toEqual(naifEphemerisEndpoint(Naif.EARTH))
	expect(path.target).toEqual(customEphemerisEndpoint('norad:25544'))
	for (let axis = 0; axis < 3; axis++) {
		expect(actual[0][axis]).toBeCloseTo(expected[0][axis], 14)
		expect(actual[1][axis]).toBeCloseTo(expected[1][axis], 14)
	}
})

test('Earth observer and generic surface adapters reuse existing geometry', () => {
	const site = customEphemerisEndpoint('observatory')
	const location = geodeticLocation(deg(-70), deg(-30), meter(2400))
	const earthSite = earthObserverEphemerisPath(location, site)
	const [sitePosition, siteVelocity] = earthSite.stateAt(TIME)
	const [expectedPosition, expectedVelocity] = observerState(TIME, [vecZero(), vecZero()], location)
	expect(earthSite.center).toEqual(naifEphemerisEndpoint(Naif.EARTH))
	expect(earthSite.target).toBe(site)
	for (let axis = 0; axis < 3; axis++) {
		expect(sitePosition[axis]).toBeCloseTo(expectedPosition[axis], 14)
		expect(siteVelocity[axis]).toBeCloseTo(expectedVelocity[axis], 14)
	}
	const moon = naifEphemerisEndpoint(Naif.MOON)
	const crater = customEphemerisEndpoint('aristarchus')
	const surface = bodySurfaceLocation(deg(10), deg(20), 0, { radii: [1, 1, 1] }, ICRS)
	const moonSite = bodySurfaceEphemerisPath(moon, crater, surface)
	expect(moonSite.center).toBe(moon)
	expect(moonSite.target).toBe(crater)
	expect(moonSite.stateAt(TIME)).toEqual(bodySurfaceState(surface, TIME))
})

test('local DE421 paths remain synchronous after setup and compose EMB-to-Earth/Moon', async () => {
	await using source = fileHandleSource(await fs.open('data/de421.bsp'))
	const spk = readSpk(await readDaf(source))
	const emb = (await spkEphemerisPath(spk, Naif.SSB, Naif.EMB))!
	const earth = (await spkEphemerisPath(spk, Naif.EMB, Naif.EARTH))!
	const moon = (await spkEphemerisPath(spk, Naif.EMB, Naif.MOON))!
	const t0 = timeYMDHMS(2019, 12, 20, 11, 5, 0, Timescale.UTC)
	const t1 = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC)
	for (const time of [t0, t1]) {
		const embState = (await spk.segment(Naif.SSB, Naif.EMB))!.at(time)
		const actualEmb = ephemerisAt(emb, time)
		expect(actualEmb).not.toBeInstanceOf(Promise)
		for (let axis = 0; axis < 3; axis++) {
			expect(actualEmb.position[axis]).toBeCloseTo(embState[0][axis], 14)
			expect(actualEmb.velocity[axis]).toBeCloseTo(embState[1][axis], 14)
		}
		for (const relative of [earth, moon]) {
			const direct = relative.stateAt(time)
			const composed = composeEphemerisPaths(emb, relative).stateAt(time)
			for (let axis = 0; axis < 3; axis++) {
				expect(composed[0][axis]).toBeCloseTo(embState[0][axis] + direct[0][axis], 14)
				expect(composed[1][axis]).toBeCloseTo(embState[1][axis] + direct[1][axis], 14)
			}
		}
	}
})

test('Earth observer path composes with a barycentric Earth provider', () => {
	const earthState: PositionAndVelocity = [
		[1, 2, 3],
		[0.01, 0.02, 0.03],
	]
	const earth = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.EARTH), () => [vecClone(earthState[0]), vecClone(earthState[1])])
	const location = geodeticLocation(deg(-70), deg(-30), meter(2400))
	const site = earthObserverEphemerisPath(location, customEphemerisEndpoint('site'))
	const composed = composeEphemerisPaths(earth, site).stateAt(TIME)
	const expected = observerState(TIME, earthState, location)
	for (let axis = 0; axis < 3; axis++) {
		expect(composed[0][axis]).toBeCloseTo(expected[0][axis], 14)
		expect(composed[1][axis]).toBeCloseTo(expected[1][axis], 14)
	}
})

const ISS_LINE1 = '1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996'
const ISS_LINE2 = '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611'
const ISS_OMM = {
	OBJECT_NAME: 'ISS (ZARYA)',
	OBJECT_ID: '1998-067A',
	EPOCH: '2023-08-19T12:25:27.896736',
	MEAN_MOTION: 15.4947758,
	ECCENTRICITY: 0.0003559,
	INCLINATION: 51.6415,
	RA_OF_ASC_NODE: 14.7889,
	ARG_OF_PERICENTER: 325.3396,
	MEAN_ANOMALY: 149.4637,
	EPHEMERIS_TYPE: 0,
	NORAD_CAT_ID: 25544,
	ELEMENT_SET_NO: 999,
	REV_AT_EPOCH: 41161,
	BSTAR: 0.00025837,
	MEAN_MOTION_DOT: 0.0001405,
	MEAN_MOTION_DDOT: 0,
} as const

function fakeSegment(center: number, target: number, start: number, end: number, position: readonly [number, number, number], frame = SPK_FRAME_J2000): SpkSegment {
	return {
		start,
		end,
		center,
		target,
		frame,
		startIndex: 1,
		endIndex: 1,
		initialize: () => Promise.resolve(),
		at: () => [vecClone(position), vecYAxis()],
	}
}

test('repeated evaluation does not initialize the segment again', async () => {
	let initializations = 0
	const segment = fakeSegment(Naif.SSB, Naif.EARTH, -1e12, 1e12, [1, 2, 3])
	const counted: SpkSegment = {
		...segment,
		initialize: () => {
			initializations++
			return Promise.resolve()
		},
	}
	const spk: Spk = {
		segments: [[Naif.SSB, Naif.EARTH, counted]],
		segment: async () => {
			await counted.initialize()
			return counted
		},
	}
	const path = (await spkEphemerisPath(spk, Naif.SSB, Naif.EARTH))!
	expect(initializations).toBe(1)
	expect(path.stateAt(TIME)).not.toBeInstanceOf(Promise)
	path.stateAt(TIME)
	path.stateAt(timeShift(TIME, 1))
	expect(initializations).toBe(1)
	expect(spkEphemerisPath(spk, Naif.SSB, Naif.EARTH)).toBeInstanceOf(Promise)
})

test('an open SPK source serves the path, and a cold record fails after disposal', async () => {
	const source = fileHandleSource(await fs.open('data/de421.bsp'))
	const spk = readSpk(await readDaf(source))
	const path = (await spkEphemerisPath(spk, Naif.SSB, Naif.EMB))!
	const warm = path.stateAt(TIME)
	expect(warm[0].every(Number.isFinite)).toBe(true)
	const again = path.stateAt(TIME)
	for (let axis = 0; axis < 3; axis++) expect(again[0][axis]).toBeCloseTo(warm[0][axis], 14)
	await source.close()
	const cached = path.stateAt(TIME)
	expect(cached[0][0]).toBeCloseTo(warm[0][0], 14)
	expect(() => path.stateAt(timeShift(TIME, 40))).toThrow()
})

test('segment coverage and latest-in-file priority are preserved', async () => {
	await using source = fileHandleSource(await fs.open('data/de421.bsp'))
	const spk = readSpk(await readDaf(source))
	const direct = (await spk.segment(Naif.SSB, Naif.EMB))!
	const path = (await spkEphemerisPath(spk, Naif.SSB, Naif.EMB))!
	const start = timeFromEpoch(direct.start, DAYSEC, J2000, 0, Timescale.TDB)
	const end = timeFromEpoch(direct.end, DAYSEC, J2000, 0, Timescale.TDB)
	for (const time of [start, end, timeShift(start, 1 / DAYSEC), timeShift(end, -1 / DAYSEC)]) {
		const actual = path.stateAt(time)
		const expected = direct.at(time)
		for (let axis = 0; axis < 3; axis++) {
			expect(actual[0][axis]).toBeCloseTo(expected[0][axis], 14)
			expect(actual[1][axis]).toBeCloseTo(expected[1][axis], 14)
		}
	}
	expect(() => path.stateAt(timeShift(start, -1))).toThrow('cannot find a segment that covers the date')
	expect(() => path.stateAt(timeShift(end, 1))).toThrow('cannot find a segment that covers the date')

	const early = fakeSegment(Naif.SSB, Naif.EARTH, -1e8, 0, vecXAxis())
	const late = fakeSegment(Naif.SSB, Naif.EARTH, 0, 1e8, [2, 0, 0])
	const merged = new MultipleSpkSegment([early, late])
	const overlapped: Spk = {
		segments: [[Naif.SSB, Naif.EARTH, merged]],
		segment: async () => {
			await merged.initialize()
			return merged
		},
	}
	const resolved = (await spkEphemerisPath(overlapped, Naif.SSB, Naif.EARTH))!
	const boundary = timeFromEpoch(0, DAYSEC, J2000, 0, Timescale.TDB)
	expect(resolved.stateAt(boundary)[0]).toEqual([2, 0, 0])
	expect(resolved.stateAt(timeShift(boundary, -1))[0]).toEqual(vecXAxis())
	expect(resolved.stateAt(boundary)).toEqual(merged.at(boundary))
})

test('a non-J2000 segment would rotate both position and velocity', () => {
	const raw: PositionAndVelocity = [vecYAxis(), vecZAxis()]
	const rotated = frameAt(raw, ECLIPTIC_J2000, TIME)
	expect(vecAngle(rotated[0], raw[0])).toBeGreaterThan(0.3)
	expect(vecAngle(rotated[1], raw[1])).toBeGreaterThan(0.3)
	expect(Math.hypot(rotated[1][0] - raw[1][0], rotated[1][1] - raw[1][1], rotated[1][2] - raw[1][2])).toBeGreaterThan(0.1)
})

test('site position scale follows latitude and every boundary state is finite', () => {
	const equator = earthObserverEphemerisPath(geodeticLocation(0, 0, 0, Ellipsoid.WGS84), customEphemerisEndpoint('equator'))
	const high = earthObserverEphemerisPath(geodeticLocation(deg(30), deg(80), meter(100), Ellipsoid.WGS84), customEphemerisEndpoint('high'))
	const [equatorPosition, equatorVelocity] = equator.stateAt(TIME)
	const [highPosition, highVelocity] = high.stateAt(TIME)
	expect(Math.abs(vecLength(equatorPosition) - WGS84_RADIUS)).toBeLessThan(1e-11)
	expect(vecLength(equatorVelocity)).toBeGreaterThan(vecLength(highVelocity))
	const cases = [
		geodeticLocation(0, 0, 0, Ellipsoid.WGS84),
		geodeticLocation(TAU - 1e-8, 0, 0, Ellipsoid.WGS84),
		geodeticLocation(deg(-20), 0, 0, Ellipsoid.WGS84),
		geodeticLocation(deg(340), 0, 0, Ellipsoid.WGS84),
		geodeticLocation(0, deg(80), meter(100), Ellipsoid.WGS84),
		geodeticLocation(0, deg(-80), meter(100), Ellipsoid.WGS84),
		geodeticLocation(deg(15), deg(-29), 0, Ellipsoid.WGS84),
		geodeticLocation(deg(15), deg(-29), meter(2400), Ellipsoid.WGS84),
	] as const
	const negative = earthObserverEphemerisPath(cases[2], customEphemerisEndpoint('west')).stateAt(TIME)
	const wrapped = earthObserverEphemerisPath(cases[3], customEphemerisEndpoint('wrapped')).stateAt(TIME)
	for (let axis = 0; axis < 3; axis++) {
		expect(negative[0][axis]).toBeCloseTo(wrapped[0][axis], 12)
		expect(negative[1][axis]).toBeCloseTo(wrapped[1][axis], 12)
	}
	for (const location of cases) {
		const [position, velocity] = earthObserverEphemerisPath(location, customEphemerisEndpoint('site')).stateAt(TIME)
		expect(position.every(Number.isFinite)).toBe(true)
		expect(velocity.every(Number.isFinite)).toBe(true)
		expect(vecLength(position)).toBeGreaterThan(WGS84_RADIUS * 0.99)
		expect(vecLength(position)).toBeLessThan(WGS84_RADIUS * 1.01)
	}
})

test('TLE, OMM, and SatRec paths agree, including a caller gravity model', () => {
	const tle = parseTLE(ISS_LINE1, ISS_LINE2, 'ISS (ZARYA)')
	const explicit = customEphemerisEndpoint('iss')
	const fromTle = sgp4EphemerisPath(tle)
	const fromOmm = sgp4EphemerisPath(ISS_OMM)
	const fromRecord = sgp4EphemerisPath(recordFromTLE(tle))
	const named = sgp4EphemerisPath(tle, explicit)
	expect(fromTle.center).toEqual(naifEphemerisEndpoint(Naif.EARTH))
	expect(fromTle.target).toEqual(customEphemerisEndpoint('norad:25544'))
	expect(named.target).toBe(explicit)
	const epochs = [TIME, timeShift(TIME, -1), timeShift(TIME, 1), timeShift(TIME, 3 / 24)] as const
	for (const time of epochs) {
		const expected = frameToFrame(sgp4(time, recordFromTLE(tle, SGP4_WGS72)), TEME, ICRS, time)
		for (const path of [fromTle, fromOmm, fromRecord] as const) {
			const actual = path.stateAt(time)
			for (let axis = 0; axis < 3; axis++) {
				expect(actual[0][axis]).toBeCloseTo(expected[0][axis], 12)
				expect(actual[1][axis]).toBeCloseTo(expected[1][axis], 12)
			}
		}
	}
	const wgs84 = recordFromTLE(tle, SGP4_WGS84)
	const customGravity = sgp4EphemerisPath(wgs84)
	const customExpected = frameToFrame(sgp4(TIME, wgs84), TEME, ICRS, TIME)
	const defaultState = fromTle.stateAt(TIME)
	for (let axis = 0; axis < 3; axis++) {
		expect(customGravity.stateAt(TIME)[0][axis]).toBeCloseTo(customExpected[0][axis], 14)
		expect(customGravity.stateAt(TIME)[1][axis]).toBeCloseTo(customExpected[1][axis], 14)
	}
	expect(Math.abs(customGravity.stateAt(TIME)[0][0] - defaultState[0][0])).toBeGreaterThan(0)
})

test('a surface path keeps its endpoints and composes with the body', () => {
	const body = naifEphemerisEndpoint(Naif.MARS)
	const site = customEphemerisEndpoint('landing-site')
	const shape = bodyShape([2, 1.5, 1])
	const location = bodySurfaceLocation(deg(370), deg(-80), 0.01, shape, ICRS)
	const surface = bodySurfaceEphemerisPath(body, site, location)
	expect(surface.center).toBe(body)
	expect(surface.target).toBe(site)
	expect(location.longitude).toBeGreaterThanOrEqual(0)
	expect(location.longitude).toBeLessThan(TAU)
	const state = surface.stateAt(TIME)
	expect(state[0].every(Number.isFinite)).toBe(true)
	expect(state[1].every(Number.isFinite)).toBe(true)
	expect(state).toEqual(bodySurfaceState(location, TIME))
	const center = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, body, () => [
		[1, 2, 3],
		[0.1, 0.2, 0.3],
	])
	const composed = composeEphemerisPaths(center, surface).stateAt(TIME)
	for (let axis = 0; axis < 3; axis++) {
		expect(composed[0][axis]).toBeCloseTo([1, 2, 3][axis] + state[0][axis], 14)
		expect(composed[1][axis]).toBeCloseTo([0.1, 0.2, 0.3][axis] + state[1][axis], 14)
	}
})
