import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { DomeManager } from '../../../../src/devices/indi/manager/dome'
import { MountManager } from '../../../../src/devices/indi/manager/mount'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { DomeSimulator } from '../../../../src/devices/indi/simulator/dome'
import { MountSimulator } from '../../../../src/devices/indi/simulator/mount'
import { deg, hour } from '../../../../src/math/units/angle'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

const SKIP = isTimeConsumingTestSkipped()

describe.skipIf(SKIP)('dome simulator', () => {
	test('integrates dome movement, shutter, park, slaving, and abort controls', async () => {
		const handler = new IndiClientHandlerSet()
		const manager = new DomeManager()
		const mountManager = new MountManager()
		handler.add(manager)
		handler.add(mountManager)

		using client = new ClientSimulator('dome', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using simulator = new DomeSimulator('Dome Simulator', client, { mountManager })
		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)
		client.sendText({ device: simulator.name, name: 'ACTIVE_DEVICES', elements: { ACTIVE_TELESCOPE: mount.name } })
		const dome = manager.get(client, simulator.name)!

		manager.connect(dome)
		await waitUntil(() => dome.connected)

		expect(manager.properties.length).toBe(1)
		expect(dome.canMove).toBeTrue()
		expect(dome.canSetAzimuth).toBeTrue()
		expect(dome.canFindHome).toBeTrue()
		expect(dome.canPark).toBeTrue()
		expect(dome.canUnpark).toBeTrue()
		expect(dome.canSetShutter).toBeTrue()
		expect(dome.canSlave).toBeTrue()
		expect(dome.autoSyncThreshold.value).toBeCloseTo(deg(1))
		expect(dome.canAbort).toBeTrue()
		expect(dome.hasMeasurements).toBeTrue()

		manager.speed(dome, 12)
		await waitUntil(() => dome.speed.value === 12)

		manager.moveTo(dome, deg(350))
		await waitUntil(() => dome.moving)
		await waitUntil(() => !dome.moving)
		expect(dome.azimuth.value).toBeCloseTo(deg(350), 2)

		manager.moveBy(dome, deg(20))
		await waitUntil(() => dome.moving)
		await waitUntil(() => !dome.moving)
		expect(dome.azimuth.value).toBeCloseTo(deg(10), 2)

		manager.moveBy(dome, deg(-30))
		await waitUntil(() => dome.moving)
		await waitUntil(() => !dome.moving)
		expect(dome.azimuth.value).toBeCloseTo(deg(340), 2)

		manager.move(dome, 'CLOCKWISE', true)
		await waitUntil(() => dome.moving)
		await Bun.sleep(250)
		expect(dome.slewing).toBeTrue()
		manager.move(dome, 'CLOCKWISE', false)
		await waitUntil(() => !dome.moving)

		manager.syncTo(dome, deg(100))
		expect(dome.azimuth.value).toBeCloseTo(deg(100), 8)
		expect(dome.slewing).toBeFalse()

		manager.home(dome)
		await waitUntil(() => dome.homing)
		await waitUntil(() => dome.atHome)
		expect(dome.azimuth.value).toBeCloseTo(0, 2)

		manager.park(dome)
		await waitUntil(() => dome.parking)
		await waitUntil(() => dome.parked)
		expect(dome.azimuth.value).toBeCloseTo(deg(180), 2)
		manager.unpark(dome)
		await waitUntil(() => !dome.parked)

		manager.moveTo(dome, deg(90))
		await waitUntil(() => dome.moving)
		await waitUntil(() => !dome.moving)
		manager.setPark(dome)
		await waitUntil(() => dome.parkPosition.value > deg(89) && dome.parkPosition.value < deg(91))
		manager.backlash(dome, true)
		await waitUntil(() => dome.backlashEnabled)
		manager.backlashSteps(dome, 14)
		await waitUntil(() => dome.backlash.value === 14)
		client.sendSwitch({ device: dome.name, name: 'DM_OTA_SIDE', elements: { DM_OTA_EAST: true } })
		await waitUntil(() => dome.measurements.otaSide === 'EAST')

		manager.openShutter(dome)
		await waitUntil(() => dome.shutterState === 'OPENING')
		expect(dome.slewing).toBeFalse()
		await waitUntil(() => dome.shutterState === 'OPEN', 2500)
		await waitUntil(() => !dome.slewing)

		manager.closeShutter(dome)
		await waitUntil(() => dome.shutterState === 'CLOSING')
		await waitUntil(() => dome.shutterState === 'CLOSED', 2500)

		mountManager.syncTo(mount, hour(4), deg(20))
		manager.slave(dome, true)
		await waitUntil(() => dome.slaved)
		await waitUntil(() => dome.moving, 2500)
		mountManager.syncTo(mount, hour(10), deg(20))
		await waitUntil(() => dome.moving, 2500)
		manager.stop(dome)
		await waitUntil(() => !dome.slaved)

		manager.moveTo(dome, deg(200))
		await waitUntil(() => dome.moving)
		manager.stop(dome)
		await waitUntil(() => !dome.moving)

		manager.openShutter(dome)
		await waitUntil(() => dome.shutterState === 'OPENING')
		manager.stop(dome)
		await waitUntil(() => dome.shutterState === 'ERROR')

		simulator.dispose()
		expect(manager.has(client, simulator.name)).toBeFalse()
		expect(manager.properties.length).toBe(0)
	}, 15000)

	test('persists dome configuration but excludes transient operations', () => {
		const saved: string[] = []
		const handler = new IndiClientHandlerSet()
		using client = new ClientSimulator('dome.persistence', handler)
		const mountManager = new MountManager()
		using simulator = new DomeSimulator('Dome Simulator', client, {
			mountManager,
			save(name, properties) {
				expect(name).toBe('Dome Simulator')
				saved.push(...properties.map(({ name: propertyName }) => propertyName))
			},
		})

		simulator.saveProperties()

		expect(saved).toEqual(['DOME_SPEED', 'DOME_PARAMS', 'DOME_AUTOSYNC', 'DOME_PARK_POSITION', 'DOME_BACKLASH_TOGGLE', 'DOME_BACKLASH_STEPS', 'DOME_MEASUREMENTS', 'DM_OTA_SIDE'])
	})
})
