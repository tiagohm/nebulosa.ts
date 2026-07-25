import { describe, expect, test } from 'bun:test'
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

	test('reports a boresight equal to the coordinate when no error is configured', () => {
		const { mount } = makeMount('mount.boresight.identity')

		try {
			expect(mount.pointingErrorBound).toBe(0)
			expect(mount.boresight.rightAscension).toBe(mount.rightAscension)
			expect(mount.boresight.declination).toBe(mount.declination)
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

	test('applies the periodic error as an absolute offset on the simulated clock', () => {
		const { client, mount } = makeMount('mount.boresight.periodic')

		try {
			// A quarter period past the epoch puts the sine at its positive peak.
			const period = 400
			const amplitude = 8
			client.sendNumber({ device: mount.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_PERIOD: period, RA_AMPLITUDE: amplitude } })

			const peak = mount.boresightAt(period * 250)
			expect(toArcsec(normalizePI(peak.rightAscension - mount.rightAscension))).toBeCloseTo(amplitude, 6)

			// Absolute, not incremental: evaluating twice at the same instant gives the same answer.
			const again = mount.boresightAt(period * 250)
			expect(again.rightAscension).toBe(peak.rightAscension)

			const trough = mount.boresightAt(period * 750)
			expect(toArcsec(normalizePI(trough.rightAscension - mount.rightAscension))).toBeCloseTo(-amplitude, 6)

			const zero = mount.boresightAt(period * 500)
			expect(toArcsec(normalizePI(zero.rightAscension - mount.rightAscension))).toBeCloseTo(0, 6)
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
