import { describe, expect, test } from 'bun:test'
import { angularDistance, positionAngleBetween } from '../../../../src/astronomy/coordinates/coordinate'
import { timeUnix } from '../../../../src/astronomy/time/time'
import { PI, PIOVERTWO } from '../../../../src/core/constants'
import { DEFAULT_CAMERA_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/camera.config'
import type { BoresightSource, ExposurePointing } from '../../../../src/devices/indi/simulator/camera.links'
import { exposureTrail, offsetAlongPositionAngle, trailVertexInJ2000 } from '../../../../src/devices/indi/simulator/camera.trail'
import { arcsec, deg, hour, toArcsec } from '../../../../src/math/units/angle'

// Unit coverage of the camera's trail circuit, with a fake mount that replays a scripted boresight.

const CONFIG = DEFAULT_CAMERA_SIMULATOR_CONFIG.trail
const PIXEL_SCALE = arcsec(2)
// J2000.0, where the frame of date and J2000 differ only by the nutation and the frame bias.
const J2000 = timeUnix(946728000, true)

// Mount whose boresight at time t, milliseconds from zero, is `path(t)`.
function scriptedSource(path: (time: number) => readonly [number, number]): BoresightSource {
	return {
		utcTime: 0,
		tubeOrientation: 0,
		sampleBoresightTrajectory: (startTime, endTime, count, out) => {
			for (let i = 0; i < count; i++) {
				const [ra, dec] = path(startTime + ((endTime - startTime) * i) / (count - 1))
				out[i * 2] = ra
				out[i * 2 + 1] = dec
			}

			return count
		},
	}
}

// Pointing of an exposure through `source` at `center`.
function pointing(source: BoresightSource | undefined, center: readonly [number, number] | undefined = [hour(5), deg(20)], orientation = 0): ExposurePointing {
	return { startTime: 0, center, time: J2000, source, orientation }
}

const BUFFER = new Float64Array(CONFIG.vertices * 2)

describe('camera trail', () => {
	test('offsets a point along a position angle, also from a pole', () => {
		const [ra, dec] = offsetAlongPositionAngle(hour(5), deg(20), deg(30), deg(1))
		expect(angularDistance(hour(5), deg(20), ra, dec)).toBeCloseTo(deg(1), 12)
		expect(positionAngleBetween(hour(5), deg(20), ra, dec)).toBeCloseTo(deg(30), 9)

		const [poleRa, poleDec] = offsetAlongPositionAngle(hour(3), PIOVERTWO, 0, deg(1))
		expect(poleDec).toBeCloseTo(deg(89), 12)
		expect(positionAngleBetween(hour(3), PIOVERTWO, poleRa, poleDec)).toBeCloseTo(0, 9)
	})

	test('carries the orientation into J2000, nearly unchanged at the J2000 epoch and turned by precession near the pole', () => {
		const vertex = trailVertexInJ2000(hour(5), deg(20), deg(40), J2000)
		expect(toArcsec(angularDistance(vertex.rightAscension, vertex.declination, hour(5), deg(20)))).toBeLessThan(20)
		expect(toArcsec(Math.abs(vertex.positionAngle - deg(40)))).toBeLessThan(20)

		// A quarter century of precession moves the pole by about a third of a degree, which turns the
		// local north of a point a degree from it by tens of degrees.
		const polar = trailVertexInJ2000(hour(5), deg(89), deg(40), timeUnix(1767225600, true))
		expect(Math.abs(polar.positionAngle - deg(40))).toBeGreaterThan(deg(5))
	})

	test('stands still without a mount, without a recorded trajectory and when the field barely moved', () => {
		const virtual = exposureTrail({ startTime: 0, time: J2000, orientation: 0 }, 1, PIXEL_SCALE, CONFIG, BUFFER)
		expect(virtual.vertices).toEqual([{ rightAscension: 0, declination: 0, positionAngle: 0 }])

		const reported = exposureTrail(pointing(undefined, [hour(5), deg(20)], deg(90)), 1, PIXEL_SCALE, CONFIG, BUFFER)
		expect(reported.vertices).toHaveLength(1)
		expect(toArcsec(Math.abs(reported.vertices[0].positionAngle - deg(90)))).toBeLessThan(20)

		const empty: BoresightSource = { utcTime: 0, tubeOrientation: 0, sampleBoresightTrajectory: () => 0 }
		expect(exposureTrail(pointing(empty), 1, PIXEL_SCALE, CONFIG, BUFFER).vertices).toHaveLength(1)

		const still = exposureTrail(pointing(scriptedSource((t) => [hour(5) + arcsec(0.1) * (t / 1000), deg(20)])), 1, PIXEL_SCALE, CONFIG, BUFFER)
		expect(still.vertices).toHaveLength(1)
		expect(still.extent).toBe(0)
	})

	test('follows a drift out and back over the exposure', () => {
		// Ten seconds east at 20 arcseconds per second, then ten seconds back: the V of a drift alignment.
		const exposure = 20
		const trail = exposureTrail(pointing(scriptedSource((t) => [hour(5) + (arcsec(20) * Math.min(t, exposure * 1000 - t)) / 1000 / Math.cos(deg(20)), deg(20)])), exposure, PIXEL_SCALE, CONFIG, BUFFER)

		expect(trail.vertices).toHaveLength(CONFIG.vertices)
		expect(trail.reference).toBe(trail.vertices[CONFIG.vertices >> 1])
		expect(toArcsec(trail.extent)).toBeCloseTo(200, 0)
		expect(toArcsec(angularDistance(trail.vertices[0].rightAscension, trail.vertices[0].declination, trail.vertices[CONFIG.vertices - 1].rightAscension, trail.vertices[CONFIG.vertices - 1].declination))).toBeLessThan(0.1)
	})

	test('caps the extent of a slew', () => {
		const trail = exposureTrail(pointing(scriptedSource((t) => [hour(5) + deg(1) * (t / 1000), deg(20)])), 10, PIXEL_SCALE, CONFIG, BUFFER)
		expect(trail.extent).toBeCloseTo(CONFIG.maxExtent * PIXEL_SCALE, 12)
	})

	test('keeps a drifting right ascension at the pole a single position', () => {
		const trail = exposureTrail(pointing(scriptedSource((t) => [hour(5) + PI * (t / 1000), PIOVERTWO])), 1, PIXEL_SCALE, CONFIG, BUFFER)
		expect(trail.vertices).toHaveLength(1)
	})
})
