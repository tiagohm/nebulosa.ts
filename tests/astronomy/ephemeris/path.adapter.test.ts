import { expect, test } from 'bun:test'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { frameToFrame, ICRS, TEME } from '../../../src/astronomy/coordinates/frame'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import type { Spk, SpkSegment } from '../../../src/astronomy/ephemeris/kernels/spk'
import { customEphemerisEndpoint, naifEphemerisEndpoint } from '../../../src/astronomy/ephemeris/path'
import { bodySurfaceEphemerisPath, earthObserverEphemerisPath, sgp4EphemerisPath, spkEphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { ephemerisAt } from '../../../src/astronomy/ephemeris/position'
import { bodySurfaceLocation, bodySurfaceState } from '../../../src/astronomy/observer/body'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { parseTLE, sgp4 } from '../../../src/astronomy/orbits/propagation/sgp4'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { deg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'

const TIME = timeYMDHMS(2023, 8, 19, 12, 25, 28, Timescale.UTC)

test('SPK adapter waits for the prepared segment and then evaluates synchronously', async () => {
	let prepared = false
	const segment: SpkSegment = {
		start: 0,
		end: 1,
		center: Naif.SSB,
		target: Naif.EARTH,
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
