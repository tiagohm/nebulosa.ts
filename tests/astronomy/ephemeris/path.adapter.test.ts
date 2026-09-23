import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { frameToFrame, ICRS, TEME } from '../../../src/astronomy/coordinates/frame'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { readSpk, SPK_FRAME_J2000, type Spk, type SpkSegment } from '../../../src/astronomy/ephemeris/kernels/spk'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { bodySurfaceEphemerisPath, earthObserverEphemerisPath, sgp4EphemerisPath, spkEphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { ephemerisAt } from '../../../src/astronomy/ephemeris/position'
import { bodySurfaceLocation, bodySurfaceState } from '../../../src/astronomy/observer/body'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { parseTLE, sgp4 } from '../../../src/astronomy/orbits/propagation/sgp4'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { fileHandleSource } from '../../../src/io/io'
import { deg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { downloadPerTag } from '../../download'

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
		at: () => [
			[1, 0, 0],
			[0, 0, 0],
		],
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
	expect(path.stateAt(TIME)).toEqual([
		[1, 0, 0],
		[0, 0, 0],
	])
	let message = ''
	try {
		await spkEphemerisPath(spkFor(17), Naif.SSB, Naif.EARTH)
	} catch (error) {
		message = error instanceof Error ? error.message : ''
	}
	expect(message).toBe('SPK frame 17 is not the library base frame')
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
	const [expectedPosition, expectedVelocity] = observerState(
		TIME,
		[
			[0, 0, 0],
			[0, 0, 0],
		],
		location,
	)
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
	await downloadPerTag('frame.kernel')
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
	const earthState: [[number, number, number], [number, number, number]] = [
		[1, 2, 3],
		[0.01, 0.02, 0.03],
	]
	const earth = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.EARTH), () => earthState)
	const location = geodeticLocation(deg(-70), deg(-30), meter(2400))
	const site = earthObserverEphemerisPath(location, customEphemerisEndpoint('site'))
	const composed = composeEphemerisPaths(earth, site).stateAt(TIME)
	const expected = observerState(TIME, earthState, location)
	for (let axis = 0; axis < 3; axis++) {
		expect(composed[0][axis]).toBeCloseTo(expected[0][axis], 14)
		expect(composed[1][axis]).toBeCloseTo(expected[1][axis], 14)
	}
})
