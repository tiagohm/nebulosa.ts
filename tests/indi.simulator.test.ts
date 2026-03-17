import { describe, expect, onTestFinished, test } from 'bun:test'
import { deg, hour, normalizePI } from '../src/angle'
import { GuideOutputManager, MountManager } from '../src/indi.manager'
import { ClientSimulator, MountSimulator } from '../src/indi.simulator'

const client = new ClientSimulator('0')

describe.skip('mount simulator', () => {
	test('integrates with MountManager for sync, goto, home and park', async () => {
		const manager = new MountManager()
		const mount = new MountSimulator(client, manager, 'Mount Simulator', 'sim-mount')

		onTestFinished(() => mount.dispose())

		expect(mount.start()).toBeTrue()
		expect(Array.from(manager.list())).toHaveLength(1)

		manager.connect(mount)
		await waitUntil(() => mount.connected)

		manager.syncTo(mount, hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(5), 1e-9))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		manager.setHome(mount)
		manager.setPark(mount)
		manager.goTo(mount, hour(5.25), deg(24))
		await waitUntil(() => mount.slewing)
		await waitUntil(() => !mount.slewing, 3000)
		expect(closeTo(mount.equatorialCoordinate.rightAscension, hour(5.25), 5e-3)).toBeTrue()
		expect(closeTo(mount.equatorialCoordinate.declination, deg(24), 5e-3)).toBeTrue()

		manager.home(mount)
		await waitUntil(() => mount.homing)
		await waitUntil(() => !mount.homing, 3000)
		expect(closeTo(normalizePI(mount.equatorialCoordinate.rightAscension - hour(5)), 0, 5e-3)).toBeTrue()
		expect(closeTo(mount.equatorialCoordinate.declination, deg(20), 5e-3)).toBeTrue()

		manager.goTo(mount, hour(5.12), deg(22))
		await waitUntil(() => !mount.slewing, 3000)
		manager.park(mount)
		await waitUntil(() => mount.parking)
		await waitUntil(() => mount.parked, 3000)
		expect(mount.tracking).toBeFalse()

		manager.unpark(mount)
		await waitUntil(() => !mount.parked)
	})

	test('applies tracking drift for disabled, sidereal, solar and lunar modes', async () => {
		const manager = new MountManager()
		const mount = new MountSimulator(client, manager, 'Mount Simulator', 'sim-tracking')

		onTestFinished(() => mount.dispose())

		mount.start()
		manager.connect(mount)
		await waitUntil(() => mount.connected)

		manager.syncTo(mount, hour(2), deg(5))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(2), 1e-9))

		const stoppedRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(700)
		const noTrackingDrift = normalizePI(mount.equatorialCoordinate.rightAscension - stoppedRightAscension)
		expect(noTrackingDrift).toBeGreaterThan(2e-5)

		manager.tracking(mount, true)
		await waitUntil(() => mount.tracking)
		manager.trackMode(mount, 'SIDEREAL')
		await waitUntil(() => mount.trackMode === 'SIDEREAL')

		const siderealRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(700)
		const siderealDrift = Math.abs(normalizePI(mount.equatorialCoordinate.rightAscension - siderealRightAscension))
		expect(siderealDrift).toBeLessThan(1e-6)

		manager.trackMode(mount, 'KING')
		const kingRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(700)
		const kingDrift = Math.abs(normalizePI(mount.equatorialCoordinate.rightAscension - kingRightAscension))
		expect(kingDrift).toBeGreaterThan(siderealDrift)

		manager.trackMode(mount, 'SOLAR')
		await waitUntil(() => mount.trackMode === 'SOLAR')
		const solarRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(2500)
		const solarDrift = normalizePI(mount.equatorialCoordinate.rightAscension - solarRightAscension)
		expect(solarDrift).toBeGreaterThan(0)

		manager.trackMode(mount, 'LUNAR')
		await waitUntil(() => mount.trackMode === 'LUNAR')
		const lunarRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(2500)
		const lunarDrift = normalizePI(mount.equatorialCoordinate.rightAscension - lunarRightAscension)
		expect(lunarDrift).toBeGreaterThan(solarDrift * 5)
	}, 15000)

	test('supports manual move and pulse guiding over time', async () => {
		const manager = new MountManager()
		const guide = new GuideOutputManager(manager)
		const mount = new MountSimulator(client, manager, 'Mount Simulator', 'sim-guide')

		onTestFinished(() => mount.dispose())

		mount.start()
		manager.connect(mount)
		await waitUntil(() => mount.connected)

		manager.syncTo(mount, hour(3), deg(0))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(3), 1e-9))

		const manualRightAscension = mount.equatorialCoordinate.rightAscension
		manager.moveEast(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(350)
		manager.moveEast(mount, false)
		await waitUntil(() => !mount.slewing)
		const manualDrift = normalizePI(mount.equatorialCoordinate.rightAscension - manualRightAscension)
		expect(manualDrift).toBeGreaterThan(5e-3)

		const pulseDeclination = mount.equatorialCoordinate.declination
		guide.pulseNorth(mount, 500)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1500)
		const pulseDrift = mount.equatorialCoordinate.declination - pulseDeclination
		expect(pulseDrift).toBeGreaterThan(0)
		expect(pulseDrift).toBeLessThan(manualDrift)
	})
})

async function waitUntil(predicate: () => boolean, timeout: number = 5000, step: number = 100): Promise<void> {
	while (!predicate()) {
		if (timeout <= 0) throw new Error('timeout waiting for condition')
		await Bun.sleep(step)
		timeout -= step
	}
}

function closeTo(a: number, b: number, tolerance: number) {
	return Math.abs(a - b) <= tolerance
}
