import { describe, expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../../../../src/core/constants'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { GuideOutputManager, MountManager } from '../../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { MountSimulator } from '../../../../src/devices/indi/simulator/mount'
import { arcsec, deg, hour, normalizePI, toArcsec } from '../../../../src/math/units/angle'
import { polarAlignmentError } from '../../../../src/observation/alignment/polaralignment'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated mount slewing, tracking, manual motion, and guiding.

const SKIP = isTimeConsumingTestSkipped()

describe.skipIf(SKIP)('mount simulator', () => {
	test('integrates with mount manager for sync, goto, home and park', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		const client = new ClientSimulator('mount', handler)
		const mountSimulator = new MountSimulator('Mount Simulator', client)

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		expect(mount.canAbort).toBeTrue()
		expect(mount.canSync).toBeTrue()
		expect(mount.canGoTo).toBeTrue()
		expect(mount.canHome).toBeTrue()
		expect(mount.canSetHome).toBeTrue()
		expect(mount.canPark).toBeTrue()
		expect(mount.canSetPark).toBeTrue()
		expect(mount.canTracking).toBeTrue()
		expect(mount.canMove).toBeTrue()

		mountManager.slewRate(mount, 'SPEED_6')

		mountManager.syncTo(mount, hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(5), 1e-9))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		mountManager.setHome(mount)
		mountManager.setPark(mount)

		mountManager.goTo(mount, hour(5.25), deg(24))
		await waitUntil(() => mount.slewing)
		await waitUntil(() => !mount.slewing, 3000)
		expect(closeTo(mount.equatorialCoordinate.rightAscension, hour(5.25), 5e-3)).toBeTrue()
		expect(closeTo(mount.equatorialCoordinate.declination, deg(24), 5e-3)).toBeTrue()

		mountManager.home(mount)
		await waitUntil(() => mount.homing)
		await waitUntil(() => !mount.homing, 3000)
		expect(closeTo(normalizePI(mount.equatorialCoordinate.rightAscension - hour(5)), 0, 5e-3)).toBeTrue()
		expect(closeTo(mount.equatorialCoordinate.declination, deg(20), 5e-3)).toBeTrue()

		mountManager.goTo(mount, hour(5.12), deg(22))
		await waitUntil(() => !mount.slewing, 3000)
		mountManager.park(mount)
		await waitUntil(() => mount.parking)
		await waitUntil(() => mount.parked, 3000)
		expect(mount.tracking).toBeFalse()

		mountManager.unpark(mount)
		await waitUntil(() => !mount.parked)

		mountSimulator.disconnect()
		await waitUntil(() => !mount.connected)

		mountSimulator.connect()
		await waitUntil(() => mount.connected)

		mountSimulator.dispose()
		expect(mountManager.has(client, mountSimulator.name)).toBeFalse()
	})

	test('applies tracking drift for disabled, sidereal, king, solar and lunar modes', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		mountSimulator.minimumNotifyCoordinateInterval = 100

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(2), deg(5))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(2), 1e-9))

		const stoppedRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const noTrackingDrift = normalizePI(mount.equatorialCoordinate.rightAscension - stoppedRightAscension)
		expect(noTrackingDrift).toBeGreaterThan(5e-6)

		mountManager.tracking(mount, true)
		await waitUntil(() => mount.tracking)
		mountManager.trackMode(mount, 'SIDEREAL')
		await waitUntil(() => mount.trackMode === 'SIDEREAL')

		const siderealRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const siderealDrift = Math.abs(normalizePI(mount.equatorialCoordinate.rightAscension - siderealRightAscension))
		expect(siderealDrift).toBeLessThan(1e-6)

		mountManager.trackMode(mount, 'SOLAR')
		await waitUntil(() => mount.trackMode === 'SOLAR')
		const solarRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const solarDrift = normalizePI(mount.equatorialCoordinate.rightAscension - solarRightAscension)
		expect(solarDrift).toBeGreaterThan(0)

		mountManager.trackMode(mount, 'KING')
		await waitUntil(() => mount.trackMode === 'KING')
		const kingRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const kingDrift = normalizePI(mount.equatorialCoordinate.rightAscension - kingRightAscension)
		expect(kingDrift).toBeGreaterThan(0)
		expect(kingDrift).toBeLessThan(solarDrift)

		mountManager.trackMode(mount, 'LUNAR')
		await waitUntil(() => mount.trackMode === 'LUNAR')
		const lunarRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const lunarDrift = normalizePI(mount.equatorialCoordinate.rightAscension - lunarRightAscension)
		expect(lunarDrift).toBeGreaterThan(solarDrift * 5)
	}, 2000)

	test('supports manual move over time', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(3), deg(0))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(3), 1e-9))

		let manualRightAscension = mount.equatorialCoordinate.rightAscension
		mountManager.moveEast(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveEast(mount, false)
		await waitUntil(() => !mount.slewing)
		let manualDrift = normalizePI(mount.equatorialCoordinate.rightAscension - manualRightAscension)
		expect(manualDrift).toBeGreaterThan(1e-3)

		manualRightAscension = mount.equatorialCoordinate.rightAscension
		mountManager.moveWest(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveWest(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.rightAscension - manualRightAscension)
		expect(manualDrift).toBeLessThan(-1e-3)

		let manualDeclination = mount.equatorialCoordinate.declination
		mountManager.moveNorth(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveNorth(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.declination - manualDeclination)
		expect(manualDrift).toBeGreaterThan(1e-3)

		manualDeclination = mount.equatorialCoordinate.declination
		mountManager.moveSouth(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveSouth(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.declination - manualDeclination)
		expect(manualDrift).toBeLessThan(-1e-3)
	}, 2000)

	test('supports manual pulse guiding over time', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		mountSimulator.minimumNotifyCoordinateInterval = 100

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(3), deg(0))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(3), 1e-9))

		// Guiding is only meaningful while tracking. With the motors stopped the sky keeps turning, so
		// the sidereal drift would swamp a guide pulse instead of the pulse showing up on its own.
		mountManager.tracking(mount, true)
		await waitUntil(() => mount.tracking)

		let pulseDeclination = mount.equatorialCoordinate.declination
		guideOutputManager.pulseNorth(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		let pulseDrift = mount.equatorialCoordinate.declination - pulseDeclination
		expect(pulseDrift).toBeGreaterThan(0)
		expect(pulseDrift).toBeLessThan(5e-5)

		pulseDeclination = mount.equatorialCoordinate.declination
		guideOutputManager.pulseSouth(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.declination - pulseDeclination
		expect(pulseDrift).toBeLessThan(0)
		expect(pulseDrift).toBeGreaterThan(-5e-5)

		let pulseRightAscension = mount.equatorialCoordinate.rightAscension
		guideOutputManager.pulseEast(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.rightAscension - pulseRightAscension
		expect(pulseDrift).toBeGreaterThan(0)
		expect(pulseDrift).toBeLessThan(1e-4)

		pulseRightAscension = mount.equatorialCoordinate.rightAscension
		guideOutputManager.pulseWest(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.rightAscension - pulseRightAscension
		expect(pulseDrift).toBeLessThan(5e-6)
		expect(pulseDrift).toBeGreaterThan(-1e-4)

		const guideOutput = guideOutputManager.get(client, mount.name)
		expect(guideOutput).toBeDefined()
		expect(guideOutput!.type).toBe('guideOutput')
		expect(guideOutput!.id).not.toBe(mount.id)
		expect(guideOutput!.parentId).toBe(mount.id)
		expect(mount.parentId).toBeUndefined()
		expect(JSON.stringify(guideOutput)).toContain('parentId')
	}, 3000)
})

// The error model needs no timers, so it is covered without the time-consuming gate.
describe('mount simulator pointing errors', () => {
	// Builds a disconnected simulator parked at a well-conditioned coordinate and site.
	function makeMount(name: string) {
		const handler = new IndiClientHandlerSet()
		const client = new ClientSimulator(name, handler)
		const mount = new MountSimulator('Mount Simulator', client)
		mount.connect()
		client.sendNumber({ device: mount.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: -22, LONG: -45, ELEV: 0 } })
		mount.syncTo(hour(5), deg(20))
		return { client, mount }
	}

	test('collapses the three directions onto one another when no error is configured', () => {
		const { mount } = makeMount('mount.boresight.identity')

		try {
			const { reported, mechanical, boresight } = mount.pointingState

			expect(mount.pointingErrorBound).toBe(0)

			// With perfect geometry the boresight is the mechanical orientation itself, exactly.
			expect(boresight.rightAscension).toBe(mechanical.rightAscension)
			expect(boresight.declination).toBe(mechanical.declination)

			// The reported coordinate round-trips through the hours/degrees INDI vector, so it agrees to
			// the resolution of that encoding rather than bit for bit.
			expect(reported.rightAscension).toBeCloseTo(mechanical.rightAscension, 12)
			expect(reported.declination).toBeCloseTo(mechanical.declination, 12)
		} finally {
			mount.dispose()
		}
	})

	test('delays declination guiding after a reversal by the configured backlash', () => {
		const { client, mount } = makeMount('mount.backlash.declination')

		try {
			// Thirty arcseconds of slack. The declination guide rate is half sidereal, so about
			// 7.5 arcsec/s, and taking up that slack costs roughly four seconds of motor travel.
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { BACKLASH_DEC: 30 } })
			mount.setTrackingEnabled(true)

			// Load the transmission northwards first, so the reversal below has slack to open.
			mount.pulse('NORTH', 4000)
			for (let i = 0; i < 8; i++) mount.advance(0.5)

			const afterNorth = mount.mechanical.declination

			// Two seconds of reversal is only half the slack, so the axis must not move at all.
			mount.pulse('SOUTH', 2000)
			for (let i = 0; i < 4; i++) mount.advance(0.5)
			expect(mount.mechanical.declination).toBe(afterNorth)

			// Four more seconds take up the rest and the axis finally follows.
			mount.pulse('SOUTH', 4000)
			for (let i = 0; i < 8; i++) mount.advance(0.5)
			expect(mount.mechanical.declination).toBeLessThan(afterNorth)
		} finally {
			mount.dispose()
		}
	})

	test('holds a stuck declination axis until the accumulated pulses break it free', () => {
		const { client, mount } = makeMount('mount.stiction.declination')

		try {
			// Two arcseconds of stiction. The declination guide rate is half sidereal, about
			// 7.5 arcsec/s, so a tenth of a second of travel is well under the threshold.
			client.sendNumber({ device: mount.name, name: 'MOUNT_MECHANICS', elements: { STICTION_DEC: 2 } })
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination

			// Each pulse runs to completion inside its step, so it contributes its whole 100 ms of
			// travel, about 0.75 arcsec. Two of those stay under the two-arcsecond threshold.
			mount.pulse('NORTH', 100)
			mount.advance(0.15)
			expect(mount.mechanical.declination).toBe(start)

			mount.pulse('NORTH', 100)
			mount.advance(0.15)
			expect(mount.mechanical.declination).toBe(start)

			// The third crosses it, and everything held back arrives at once.
			mount.pulse('NORTH', 100)
			mount.advance(0.15)
			expect(mount.mechanical.declination).toBeGreaterThan(start)
		} finally {
			mount.dispose()
		}
	})

	test.skipIf(SKIP)('overshoots and rings after a slew, then lands exactly on target', () => {
		const { client, mount } = makeMount('mount.settling.slew')

		try {
			// A springy mount: half an arcminute of overshoot at two hertz, lightly damped.
			client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
			mount.setSlewRate('SPEED_7')

			const target = mount.declination + deg(10)
			mount.goTo(mount.rightAscension, target)

			let overshoot = 0
			let arrived = false

			// Stepped finely enough to resolve a two hertz ring-down.
			for (let i = 0; i < 2000; i++) {
				mount.advance(0.01)
				if (!mount.isSlewing) {
					arrived = true
					overshoot = Math.max(overshoot, Math.abs(mount.mechanical.declination - target))
				}
			}

			expect(arrived).toBeTrue()

			// It went past the target on the way in.
			expect(toArcsec(overshoot)).toBeGreaterThan(5)

			// And came back to it: the excursion is borrowed and paid back, so a goto still lands where
			// it was told to once the ringing dies away.
			expect(toArcsec(Math.abs(mount.mechanical.declination - target))).toBeLessThan(0.01)
		} finally {
			mount.dispose()
		}
	})

	test.skipIf(SKIP)('settles more gently after a slow slew than a fast one', () => {
		function overshootAt(rate: string, name: string) {
			const { client, mount } = makeMount(name)

			try {
				client.sendNumber({ device: mount.name, name: 'MOUNT_SETTLING', elements: { OVERSHOOT: 30, FREQUENCY: 2, DAMPING_RATIO: 0.15 } })
				mount.setSlewRate(rate)

				const target = mount.declination + deg(1)
				mount.goTo(mount.rightAscension, target)

				let overshoot = 0

				for (let i = 0; i < 2000; i++) {
					mount.advance(0.01)
					if (!mount.isSlewing) overshoot = Math.max(overshoot, Math.abs(mount.mechanical.declination - target))
				}

				return overshoot
			} finally {
				mount.dispose()
			}
		}

		// The excitation scales with the speed the axes were running at, not with how far they went.
		expect(overshootAt('SPEED_1', 'mount.settling.slow')).toBeLessThan(overshootAt('SPEED_7', 'mount.settling.fast'))
	})

	test('separates the reported coordinate from the axes by the encoder index errors', () => {
		const { client, mount } = makeMount('mount.index.error')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { RA_INDEX_ERROR: 120, DEC_INDEX_ERROR: -90 } })

			// Syncing places the axes so the controller reports what was asked, which with a non-zero
			// index error is a different orientation.
			mount.syncTo(hour(5), deg(20))

			const { reported, mechanical, boresight } = mount.pointingState

			expect(toArcsec(normalizePI(reported.rightAscension - hour(5)))).toBeCloseTo(0, 3)
			expect(toArcsec(reported.declination - deg(20))).toBeCloseTo(0, 3)

			// The axes sit one index error away from what is reported.
			expect(toArcsec(normalizePI(reported.rightAscension - mechanical.rightAscension))).toBeCloseTo(120, 3)
			expect(toArcsec(reported.declination - mechanical.declination)).toBeCloseTo(-90, 3)

			// An index error is bookkeeping, not optics: it must not move the boresight off the axes.
			expect(boresight.rightAscension).toBe(mechanical.rightAscension)
			expect(boresight.declination).toBe(mechanical.declination)
		} finally {
			mount.dispose()
		}
	})

	test('drives a goto to the orientation that makes the controller report the target', () => {
		const { client, mount } = makeMount('mount.index.goto')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { RA_INDEX_ERROR: 120, DEC_INDEX_ERROR: -90 } })
			mount.setSlewRate('SPEED_7')
			mount.goTo(hour(6), deg(25))

			for (let i = 0; i < 20 && mount.isSlewing; i++) mount.advance(1)

			expect(mount.isSlewing).toBeFalse()
			expect(toArcsec(normalizePI(mount.rightAscension - hour(6)))).toBeCloseTo(0, 3)
			expect(toArcsec(mount.declination - deg(25))).toBeCloseTo(0, 3)
		} finally {
			mount.dispose()
		}
	})

	test('scales the cone error as the secant of the declination', () => {
		const { client, mount } = makeMount('mount.cone.error')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { CONE_ERROR: 60 } })

			// The hour-angle error grows as sec of the declination, but converting it to an on-sky angle
			// multiplies by cos, so the displacement of the boresight is the coefficient itself.
			for (const declination of [deg(0), deg(45), deg(60)]) {
				mount.syncTo(hour(5), declination)
				const { mechanical, boresight } = mount.pointingState
				const onSky = normalizePI(boresight.rightAscension - mechanical.rightAscension) * Math.cos(declination)
				expect(toArcsec(onSky)).toBeCloseTo(-60, 3)
				expect(boresight.declination).toBe(mechanical.declination)
			}
		} finally {
			mount.dispose()
		}
	})

	test('scales the axis non-orthogonality as the tangent of the declination', () => {
		const { client, mount } = makeMount('mount.axis.orthogonality')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { AXIS_NON_ORTHOGONALITY: 90 } })

			// Vanishes at the equator and equals the coefficient at 45 degrees, where tan is one.
			mount.syncTo(hour(5), 0)
			expect(toArcsec(normalizePI(mount.boresight.rightAscension - mount.mechanical.rightAscension))).toBeCloseTo(0, 6)

			mount.syncTo(hour(5), deg(45))
			expect(toArcsec(normalizePI(mount.boresight.rightAscension - mount.mechanical.rightAscension))).toBeCloseTo(-90, 3)
		} finally {
			mount.dispose()
		}
	})

	test('delivers a guide pulse shorter than the simulation step', () => {
		const { mount } = makeMount('mount.guiding.subtick')

		try {
			mount.setTrackingEnabled(true)
			const start = mount.mechanical.declination

			// Thirty milliseconds at half the sidereal rate is about 0.23 arcsec. Stepping a whole second
			// must still deliver exactly that, not a second's worth and not nothing.
			mount.pulse('NORTH', 30)
			mount.advance(1)

			const moved = mount.mechanical.declination - start
			expect(toArcsec(moved)).toBeCloseTo(0.03 * 0.5 * 15.041, 3)
		} finally {
			mount.dispose()
		}
	})

	test('discards pulses below the minimum and rounds the rest', () => {
		const { client, mount } = makeMount('mount.guiding.admission')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { MINIMUM_PULSE: 100, QUANTIZATION: 100 } })
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination

			mount.pulse('NORTH', 50)
			mount.advance(1)
			expect(mount.mechanical.declination).toBe(start)

			// 120 ms survives the minimum and rounds to 100 ms.
			mount.pulse('NORTH', 120)
			mount.advance(1)
			expect(toArcsec(mount.mechanical.declination - start)).toBeCloseTo(0.1 * 0.5 * 15.041, 3)
		} finally {
			mount.dispose()
		}
	})

	test('delays a pulse by the configured latency', () => {
		const { client, mount } = makeMount('mount.guiding.latency')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { LATENCY: 500 } })
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination

			// Nothing happens while the command is still in flight.
			mount.pulse('NORTH', 200)
			mount.advance(0.4)
			expect(mount.mechanical.declination).toBe(start)

			// Past the latency the pulse runs in full.
			mount.advance(0.4)
			expect(toArcsec(mount.mechanical.declination - start)).toBeCloseTo(0.2 * 0.5 * 15.041, 3)
		} finally {
			mount.dispose()
		}
	})

	test('applies asymmetric gains per direction', () => {
		const { client, mount } = makeMount('mount.guiding.gain')

		try {
			// A declination axis that responds at half strength going south.
			client.sendNumber({ device: mount.name, name: 'MOUNT_GUIDING', elements: { GAIN_SOUTH: 0.5 } })
			mount.setTrackingEnabled(true)

			const start = mount.mechanical.declination
			mount.pulse('NORTH', 400)
			mount.advance(0.5)
			const north = mount.mechanical.declination - start

			const beforeSouth = mount.mechanical.declination
			mount.pulse('SOUTH', 400)
			mount.advance(0.5)
			const south = mount.mechanical.declination - beforeSouth

			expect(north).toBeGreaterThan(0)
			expect(south).toBeLessThan(0)
			expect(-south / north).toBeCloseTo(0.5, 6)
		} finally {
			mount.dispose()
		}
	})

	test('adds overlapping pulses on the same axis instead of replacing them', () => {
		const { mount } = makeMount('mount.guiding.overlap')

		try {
			mount.setTrackingEnabled(true)
			const start = mount.mechanical.declination

			// Two 400 ms pulses issued 200 ms apart overlap for 200 ms, so the axis is driven for a total
			// of 800 ms of pulse time even though only 600 ms of wall time passes.
			mount.pulse('NORTH', 400)
			mount.advance(0.2)
			mount.pulse('NORTH', 400)
			mount.advance(0.6)

			expect(toArcsec(mount.mechanical.declination - start)).toBeCloseTo(0.8 * 0.5 * 15.041, 3)
		} finally {
			mount.dispose()
		}
	})

	test('keeps guiding on the mechanical axes while the polar error stays in the boresight', () => {
		const { client, mount } = makeMount('mount.boresight.guiding')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_AZIMUTH_ERROR: 600, POLAR_ALTITUDE_ERROR: 400 } })

			const before = mount.pointingState
			const residualBefore = before.boresight.declination - before.mechanical.declination
			expect(Math.abs(residualBefore)).toBeGreaterThan(arcsec(1))

			// A guide pulse moves the axes. This is the invariant the separation exists for: the
			// correction lands on the mechanical orientation, and the polar error keeps reappearing in
			// the boresight instead of being cancelled by it.
			// Stepped finely rather than in one jump: expiry runs before the motion, so a step longer
			// than the pulse would retire it without ever applying it. Integrating the overlap instead
			// of sampling it is what removes that quantization, and it belongs with the guide-response
			// model.
			mount.pulse('NORTH', 2000)
			for (let i = 0; i < 4; i++) mount.advance(0.5)

			const after = mount.pointingState
			expect(after.mechanical.declination).not.toBe(before.mechanical.declination)

			const residualAfter = after.boresight.declination - after.mechanical.declination
			expect(Math.abs(residualAfter)).toBeGreaterThan(arcsec(1))
			expect(residualAfter).toBeCloseTo(residualBefore, 6)
		} finally {
			mount.dispose()
		}
	})

	test('reproduces polarAlignmentError for the configured polar axis errors', () => {
		const { client, mount } = makeMount('mount.boresight.polar')

		try {
			const azimuthError = 900
			const altitudeError = -600
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_AZIMUTH_ERROR: azimuthError, POLAR_ALTITUDE_ERROR: altitudeError } })

			const utcTime = mount.utcTime
			const lst = mount.siderealTimeAt(utcTime)
			const [expectedRightAscension, expectedDeclination] = polarAlignmentError(mount.rightAscension, mount.declination, mount.latitude, lst, arcsec(azimuthError), arcsec(altitudeError))
			const boresight = mount.boresightAt(utcTime)

			expect(normalizePI(boresight.rightAscension - expectedRightAscension)).toBeCloseTo(0, 12)
			expect(boresight.declination - expectedDeclination).toBeCloseTo(0, 12)
			expect(mount.pointingErrorBound).toBeGreaterThan(0)
		} finally {
			mount.dispose()
		}
	})

	test('advances the worm phase with the axis, not with the clock', () => {
		const { client, mount } = makeMount('mount.worm.phase')

		try {
			const period = 400
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_PERIOD: period, RA_AMPLITUDE: 8 } })

			expect(mount.wormPhase).toBe(0)

			// Tracking at the sidereal rate turns the worm exactly once per configured period.
			mount.setTrackingEnabled(true)
			mount.advance(period / 4)
			expect(mount.wormPhase).toBeCloseTo(PIOVERTWO, 9)

			mount.advance(period / 4)
			expect(mount.wormPhase).toBeCloseTo(PI, 9)

			// A full revolution brings it back to where it started.
			mount.advance(period / 2)
			expect(normalizePI(mount.wormPhase)).toBeCloseTo(0, 9)

			// With tracking off and nothing commanded the axis is still, so the worm must not move even
			// though time keeps passing. This is the regression against a clock-driven phase.
			mount.setTrackingEnabled(false)
			const parked = mount.wormPhase
			mount.advance(period)
			expect(mount.wormPhase).toBe(parked)
		} finally {
			mount.dispose()
		}
	})

	test('applies the periodic error as an absolute offset of the worm phase', () => {
		const { client, mount } = makeMount('mount.boresight.periodic')

		try {
			const period = 400
			const amplitude = 8
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_PERIOD: period, RA_AMPLITUDE: amplitude } })
			mount.setTrackingEnabled(true)

			// A quarter of a revolution puts the sine at its positive peak.
			mount.advance(period / 4)
			const peak = mount.boresightAt(mount.utcTime)
			expect(toArcsec(normalizePI(peak.rightAscension - mount.rightAscension))).toBeCloseTo(amplitude, 6)

			// Absolute, not incremental: evaluating twice at the same instant gives the same answer.
			expect(mount.boresightAt(mount.utcTime).rightAscension).toBe(peak.rightAscension)

			mount.advance(period / 2)
			const trough = mount.boresightAt(mount.utcTime)
			expect(toArcsec(normalizePI(trough.rightAscension - mount.rightAscension))).toBeCloseTo(-amplitude, 6)
		} finally {
			mount.dispose()
		}
	})

	test('spins the worm faster during a slew than while tracking', () => {
		const { client, mount } = makeMount('mount.worm.slew')

		try {
			const period = 400
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_PERIOD: period, RA_AMPLITUDE: 8 } })
			mount.setTrackingEnabled(true)

			mount.advance(1)
			const trackingStep = mount.wormPhase

			// A goto far to the east runs the axis at the slew rate, orders of magnitude above sidereal.
			mount.setSlewRate('SPEED_6')
			mount.goTo(mount.rightAscension + deg(20), mount.declination)
			mount.advance(1)
			const slewStep = mount.wormPhase - trackingStep

			expect(Math.abs(slewStep)).toBeGreaterThan(Math.abs(trackingStep) * 100)
		} finally {
			mount.dispose()
		}
	})

	test('drives the boresight from the simulated clock, not the wall clock', () => {
		const { client, mount } = makeMount('mount.boresight.clock')

		try {
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_AZIMUTH_ERROR: 1800, POLAR_ALTITUDE_ERROR: 1800 } })

			const before = mount.boresight

			// Six hours of hour angle later the polar error projects very differently.
			mount.setTime({ utc: mount.utcTime + 6 * 3600 * 1000, offset: 0 })
			const after = mount.boresight

			expect(Math.abs(normalizePI(after.rightAscension - before.rightAscension))).toBeGreaterThan(arcsec(1))
			expect(Math.abs(after.declination - before.declination)).toBeGreaterThan(arcsec(1))
		} finally {
			mount.dispose()
		}
	})
})

function closeTo(a: number, b: number, tolerance: number) {
	return Math.abs(a - b) <= tolerance
}
