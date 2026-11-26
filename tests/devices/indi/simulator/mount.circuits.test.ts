import { describe, expect, test } from 'bun:test'
import { applyPolarAxisRotation } from '../../../../src/astronomy/coordinates/pointing'
import { PIOVERTWO, SIDEREAL_DRIFT_RATE } from '../../../../src/core/constants'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import type { UTCTime } from '../../../../src/devices/indi/device'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { MountSimulator } from '../../../../src/devices/indi/simulator/mount'
import { MountAlignment } from '../../../../src/devices/indi/simulator/mount.alignment'
import { MountClock } from '../../../../src/devices/indi/simulator/mount.clock'
import { DEFAULT_MOUNT_SIMULATOR_CONFIG, type MountSimulatorConfigOverride } from '../../../../src/devices/indi/simulator/mount.config'
import { MountMeridianFlip } from '../../../../src/devices/indi/simulator/mount.meridianflip'
import { declinationFromShaftAngle, declinationShaftAngle } from '../../../../src/devices/indi/simulator/mount.shaft'
import { MountSite } from '../../../../src/devices/indi/simulator/mount.site'
import { type Angle, deg, hour, normalizeAngle, normalizePI, toArcsec, toDeg } from '../../../../src/math/units/angle'
import { TestBus } from '../../../util/bus'

describe('clock', () => {
	test('carries the fraction of a millisecond a step leaves', () => {
		const clock = new MountClock(new TestBus(), 1000, () => undefined)

		expect(clock.step(0.0004)).toEqual([1000, 1000.4])
		expect(clock.utc).toBe(1000)
		const [start, end] = clock.step(0.0007)
		expect(start).toBe(1000.4)
		expect(end).toBeCloseTo(1001.1, 9)
		expect(clock.utc).toBe(1001)
	})

	test('returns how far a set moved the clock and drops the carried fraction', () => {
		const bus = new TestBus()
		const clock = new MountClock(bus, 1000, () => undefined)
		clock.step(0.0005)

		expect(clock.apply({ utc: 4000, offset: 60 })).toBe(3000)
		expect(clock.exact).toBe(4000)
		expect(clock.offset).toBe(60)
		expect(bus.take()).toEqual(['TIME_UTC'])

		// The offset alone is a timezone for display and moves nothing.
		expect(clock.apply({ utc: 4000, offset: 120 })).toBe(0)
	})

	test('catches up with the wall time spent suspended', () => {
		const bus = new TestBus()
		const clock = new MountClock(bus, 1000, () => undefined)

		expect(clock.resume(50)).toBe(0)
		clock.suspend(10000)
		// A second suspension keeps the first instant.
		clock.suspend(12000)
		expect(clock.resume(15000)).toBe(5000)
		expect(clock.utc).toBe(6000)
		expect(bus.take()).toEqual(['TIME_UTC'])
	})

	test('parses TIME_UTC as UTC unless it carries a timezone', () => {
		const set: UTCTime[] = []
		const clock = new MountClock(new TestBus(), 0, (value) => set.push(value))

		clock.handleText({ device: '', name: 'TIME_UTC', elements: { UTC: '2026-01-01T00:00:00', OFFSET: '-3' } })
		clock.handleText({ device: '', name: 'TIME_UTC', elements: { UTC: '2026-01-01T00:00:00-03:00' } })

		expect(set).toEqual([
			{ utc: Date.UTC(2026, 0, 1), offset: -180 },
			{ utc: Date.UTC(2026, 0, 1, 3), offset: clock.offset },
		])
	})
})

describe('site', () => {
	test('publishes a west-negative longitude normalized east', () => {
		const calls: string[] = []
		const bus = new TestBus()
		const site = new MountSite(bus, { latitude: -22, longitude: -45, elevation: 800 }, { changing: () => calls.push('changing'), changed: () => calls.push('changed') })

		expect(toDeg(site.longitude)).toBeCloseTo(315, 12)
		expect(site.hemisphere).toBe(-1)

		site.handleNumber({ device: '', name: 'GEOGRAPHIC_COORD', elements: { LAT: 40, LONG: -8 } })
		expect(toDeg(site.longitude)).toBeCloseTo(352, 12)
		expect(site.hemisphere).toBe(1)
		expect(calls).toEqual(['changing', 'changed'])
		expect(bus.take()).toEqual(['GEOGRAPHIC_COORD'])
	})

	test('counts the equator as north', () => {
		const site = new MountSite(new TestBus(), { latitude: 0, longitude: 0, elevation: 0 }, { changing: () => undefined, changed: () => undefined })
		expect(site.hemisphere).toBe(1)
	})
})

describe('shaft', () => {
	test('mirrors the east side across the pole the mount points at', () => {
		expect(toDeg(declinationShaftAngle('WEST', deg(-30), 1))).toBeCloseTo(-30, 12)
		expect(toDeg(declinationShaftAngle('EAST', deg(-30), 1))).toBeCloseTo(210, 12)
		expect(toDeg(declinationShaftAngle('EAST', deg(30), -1))).toBeCloseTo(-210, 12)
		expect(toDeg(declinationShaftAngle('EAST', deg(-30), -1))).toBeCloseTo(-150, 12)
	})

	test('maps every east shaft angle back to its declination', () => {
		for (const hemisphere of [1, -1]) {
			for (const declination of [-89, -45, 0, 45, 89]) {
				expect(toDeg(declinationFromShaftAngle(declinationShaftAngle('EAST', deg(declination), hemisphere)))).toBeCloseTo(declination, 9)
			}
		}
	})
})

describe('alignment', () => {
	// Altitude and eastward offset of where the mount's own axis points, relative to the visible pole,
	// degrees, for a site at `latitude`.
	function axisOffset(latitude: Angle, azimuthError: number, altitudeError: number) {
		const alignment = new MountAlignment(new TestBus(), { ...DEFAULT_MOUNT_SIMULATOR_CONFIG.alignment, polarAzimuthError: azimuthError, polarAltitudeError: altitudeError }, () => undefined)
		alignment.enabled = true
		const pole = latitude < 0 ? -PIOVERTWO : PIOVERTWO
		const lst = 1
		const [rightAscension, declination] = applyPolarAxisRotation(0, pole, lst, alignment.polarRotation(latitude)!)
		const hourAngle = lst - rightAscension
		const altitude = Math.asin(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle))
		const east = -Math.cos(declination) * Math.sin(hourAngle)
		return [toDeg(altitude) - Math.abs(toDeg(latitude)), toDeg(east)] as const
	}

	test('puts a positive altitude error above the visible pole in both hemispheres', () => {
		for (const latitude of [deg(40), deg(-22)]) {
			const [altitude, east] = axisOffset(latitude, 0, 3600)
			expect(altitude).toBeCloseTo(1, 3)
			expect(east).toBeCloseTo(0, 3)
		}
	})

	test('puts a positive azimuth error east of the visible pole in both hemispheres', () => {
		for (const latitude of [deg(40), deg(-22)]) {
			const [altitude, east] = axisOffset(latitude, 3600, 0)
			expect(altitude).toBeCloseTo(0, 3)
			expect(east).toBeCloseTo(Math.cos(latitude), 3)
		}
	})
})

describe('meridian policy', () => {
	test('accepts a side up to the limit past the meridian', () => {
		const meridian = new MountMeridianFlip(new TestBus(), { automaticFlip: false, flipHourAngle: 0, limit: 10 })

		expect(meridian.accepts('WEST', deg(-30))).toBeTrue()
		expect(meridian.accepts('WEST', deg(9))).toBeTrue()
		expect(meridian.accepts('WEST', deg(11))).toBeFalse()
		expect(meridian.accepts('EAST', deg(-9))).toBeTrue()
		expect(meridian.accepts('EAST', deg(-11))).toBeFalse()

		meridian.rebase(deg(11))
		expect(meridian.exceeded('WEST')).toBeTrue()
		expect(meridian.exceeded('EAST')).toBeFalse()
	})

	test('never stops tracking without a limit', () => {
		const meridian = new MountMeridianFlip(new TestBus(), { automaticFlip: false, flipHourAngle: 0, limit: 0 })
		meridian.rebase(deg(80))
		expect(meridian.exceeded('WEST')).toBeFalse()
	})

	test('fires once, and rearms only once the target is back before the threshold', () => {
		const meridian = new MountMeridianFlip(new TestBus(), { automaticFlip: true, flipHourAngle: 1, limit: 0 })
		meridian.rebase(deg(0.5))
		expect(meridian.due('WEST', true)).toBeFalse()

		meridian.advance(deg(1))
		expect(meridian.due('WEST', false)).toBeFalse()
		expect(meridian.due('EAST', true)).toBeFalse()
		expect(meridian.due('WEST', true)).toBeTrue()

		meridian.armed = false
		expect(meridian.due('WEST', true)).toBeFalse()
		meridian.advance(deg(-1))
		expect(meridian.due('WEST', true)).toBeFalse()
		expect(meridian.armed).toBeTrue()
	})
})

// Connected mount simulator stepped by hand, built from `config`.
function makeSimulator(id: string, config?: MountSimulatorConfigOverride) {
	const client = new ClientSimulator(id, new IndiClientHandlerSet())
	const simulator = new MountSimulator('Mount Simulator', client, { config })
	simulator.connect()
	simulator.pauseAutomaticTicking()
	simulator.setSlewRate('SPEED_7')
	return simulator
}

// Steps `simulator` until its slew ends.
function arrive(simulator: MountSimulator, step: number = 0.05) {
	for (let i = 0; i < 100000 && simulator.isSlewing; i++) simulator.advance(step)
}

// Reported hour angle of `simulator`, radians.
function hourAngle(simulator: MountSimulator) {
	return normalizePI(simulator.siderealTimeAt(simulator.utcTime) - simulator.rightAscension)
}

const SITES = [
	['north', 40],
	['south', -22],
] as const

describe('startup pose', () => {
	test('powers up, homes and parks at the visible pole', () => {
		for (const [name, latitude] of SITES) {
			const simulator = makeSimulator(`mount.pose.${name}`, { site: { latitude } })
			const pole = Math.sign(latitude) * 90

			try {
				expect(toDeg(simulator.mechanical.declination)).toBeCloseTo(pole, 9)
				expect(simulator.pierSide).toBe('NEITHER')

				simulator.goTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + hour(1)), deg(20))
				arrive(simulator)
				simulator.park()
				arrive(simulator)
				expect(simulator.isParked).toBeTrue()
				expect(toDeg(simulator.mechanical.declination)).toBeCloseTo(pole, 6)

				simulator.unpark()
				simulator.goTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + hour(1)), deg(20))
				arrive(simulator)
				simulator.home()
				arrive(simulator)
				expect(toDeg(simulator.mechanical.declination)).toBeCloseTo(pole, 6)
			} finally {
				simulator.dispose()
			}
		}
	})

	test('moves to the visible pole of a site given after the connection while untouched', () => {
		const simulator = makeSimulator('mount.pose.late')

		try {
			simulator.sendNumber({ device: simulator.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: -22, LONG: -45 } })
			expect(toDeg(simulator.mechanical.declination)).toBeCloseTo(-90, 9)

			// Once something placed the axes, a change of site no longer moves them.
			simulator.syncTo(hour(5), deg(-30))
			simulator.sendNumber({ device: simulator.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: 40 } })
			expect(toDeg(simulator.declination)).toBeCloseTo(-30, 9)
		} finally {
			simulator.dispose()
		}
	})

	test('keeps the park pose fixed on the mount as the sky turns', () => {
		const simulator = makeSimulator('mount.park.hourangle', { site: { latitude: -22 } })

		try {
			simulator.goTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + hour(2)), deg(-40))
			arrive(simulator)
			const parkHourAngle = hourAngle(simulator)
			simulator.setPark()

			simulator.goTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) - hour(2)), deg(-10))
			arrive(simulator)
			simulator.advance(1800)

			simulator.park()
			arrive(simulator)
			expect(simulator.isParked).toBeTrue()
			expect(toDeg(normalizePI(hourAngle(simulator) - parkHourAngle))).toBeCloseTo(0, 3)
			expect(toDeg(simulator.declination)).toBeCloseTo(-40, 6)
		} finally {
			simulator.dispose()
		}
	})
})

describe('pier side', () => {
	test('flips over the pole the mount points at', () => {
		for (const [name, latitude] of SITES) {
			const simulator = makeSimulator(`mount.flip.pole.${name}`, { site: { latitude } })
			const h = Math.sign(latitude)
			const declination = deg(-30 * h)

			try {
				simulator.syncTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + hour(1)), declination)
				expect(simulator.pierSide).toBe('WEST')

				simulator.flipTo(simulator.rightAscension, simulator.declination)
				let furthest = 0

				while (simulator.isSlewing) {
					simulator.advance(0.05)
					furthest = Math.max(furthest, h * simulator.mechanical.declination)
				}

				// The tube swings up through the visible pole, never down through the other one.
				expect(furthest).toBeGreaterThan(deg(89))
				expect(simulator.pierSide).toBe('EAST')
				expect(toDeg(simulator.declination)).toBeCloseTo(toDeg(declination), 6)
			} finally {
				simulator.dispose()
			}
		}
	})

	test('keeps the side while tracking through the meridian', () => {
		for (const [name, latitude] of SITES) {
			const simulator = makeSimulator(`mount.track.meridian.${name}`, { site: { latitude } })

			try {
				simulator.syncTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + deg(0.1)), deg(10))
				expect(simulator.pierSide).toBe('WEST')
				simulator.setTrackingEnabled(true)
				for (let i = 0; i < 120; i++) simulator.advance(1)

				expect(hourAngle(simulator)).toBeGreaterThan(0)
				expect(simulator.pierSide).toBe('WEST')
				expect(simulator.isTracking).toBeTrue()
			} finally {
				simulator.dispose()
			}
		}
	})

	test('stays on its side for a goto within the meridian limit and changes beyond it', () => {
		for (const [name, latitude] of SITES) {
			for (const [limit, target, expected] of [
				[10, 5, 'WEST'],
				[10, 15, 'EAST'],
				[0, 5, 'EAST'],
			] as const) {
				const simulator = makeSimulator(`mount.limit.goto.${name}.${limit}.${target}`, { site: { latitude }, meridian: { limit } })

				try {
					simulator.syncTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + hour(1)), deg(10))
					expect(simulator.pierSide).toBe('WEST')

					simulator.goTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) - deg(target)), deg(10))
					arrive(simulator)
					expect(simulator.pierSide).toBe(expected)
				} finally {
					simulator.dispose()
				}
			}
		}
	})

	test('stops tracking on the west side at the meridian limit', () => {
		for (const [name, latitude] of SITES) {
			const simulator = makeSimulator(`mount.limit.track.${name}`, { site: { latitude }, meridian: { limit: 1 } })

			try {
				simulator.syncTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + deg(0.5)), deg(10))
				expect(simulator.pierSide).toBe('WEST')
				simulator.setTrackingEnabled(true)
				// 1.5 degrees of hour angle in steps of a second.
				for (let i = 0; i < 360 && simulator.isTracking; i++) simulator.advance(1)

				expect(simulator.isTracking).toBeFalse()
				expect(toDeg(hourAngle(simulator))).toBeCloseTo(1, 2)

				// A stopped drive no longer carries the target further past the limit.
				simulator.advance(600)
				expect(toDeg(hourAngle(simulator))).toBeCloseTo(1, 2)
			} finally {
				simulator.dispose()
			}
		}
	})
})

test('refuses a flip at a pole, which has no side', () => {
	const simulator = makeSimulator('mount.flip.pole.refused')

	try {
		simulator.flipTo(0, PIOVERTWO)
		expect(simulator.isSlewing).toBeFalse()
		expect(simulator.pierSide).toBe('NEITHER')
	} finally {
		simulator.dispose()
	}
})

test('moves the queued pulses and the meridian policy along with a clock set', () => {
	const simulator = makeSimulator('mount.clock.set', { errors: { guiding: true }, guiding: { latency: 1000, latencyJitter: 0, minimumPulse: 0, quantization: 0, gainNorth: 1, gainSouth: 1, gainEast: 1, gainWest: 1 } })

	try {
		simulator.syncTo(normalizeAngle(simulator.siderealTimeAt(simulator.utcTime) + hour(1)), deg(10))
		simulator.setGuideRate(1, 1)
		simulator.pulse('NORTH', 500)
		const start = simulator.declination
		simulator.setTime({ utc: simulator.utcTime + 3600000, offset: 0 })

		// The pulse still waits for its latency and runs for its own duration on the new clock.
		simulator.advance(0.9)
		expect(simulator.declination).toBe(start)
		simulator.advance(1)
		expect(toArcsec(simulator.declination - start)).toBeCloseTo(toArcsec(0.5 * SIDEREAL_DRIFT_RATE), 3)
	} finally {
		simulator.dispose()
	}
})
