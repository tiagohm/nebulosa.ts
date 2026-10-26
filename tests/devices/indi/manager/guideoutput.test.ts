import { expect, test } from 'bun:test'
import { CLIENT, type Client, DEFAULT_MOUNT } from '../../../../src/devices/indi/device'
import { GuideOutputManager } from '../../../../src/devices/indi/manager/guideoutput'
import { MountManager } from '../../../../src/devices/indi/manager/mount'
import type { DefNumberVector, SetSwitchVector } from '../../../../src/devices/indi/types'
import { client, createRecordingClient, defNumber } from './util'

test('clears the opposite timed-guide element for each pulse', () => {
	const { recordingClient, numberCommands } = createRecordingClient()
	const mount = structuredClone(DEFAULT_MOUNT)
	mount.id = Bun.randomUUIDv7()
	mount.name = 'Mount'
	mount.canPulseGuide = true
	Object.defineProperty(mount, CLIENT, { value: recordingClient })

	const manager = new GuideOutputManager(new MountManager())
	manager.pulseNorth(mount, 350)
	manager.pulseSouth(mount, 200)
	manager.pulseWest(mount, 150)
	manager.pulseEast(mount, 100)

	expect(numberCommands.map(({ name, elements }) => ({ name, elements }))).toEqual([
		{ name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_N: 350, TIMED_GUIDE_S: 0 } },
		{ name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_N: 0, TIMED_GUIDE_S: 200 } },
		{ name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_W: 150, TIMED_GUIDE_E: 0 } },
		{ name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_W: 0, TIMED_GUIDE_E: 100 } },
	])
})

test('handles guide-rate definitions before timed-guide definitions', () => {
	const mountManager = new MountManager()
	const mount = structuredClone(DEFAULT_MOUNT)
	mount.id = Bun.randomUUIDv7()
	mount.name = 'Mount'
	Object.defineProperty(mount, CLIENT, { value: client })
	mountManager.add(mount)

	const manager = new GuideOutputManager(mountManager)
	const guideRate: DefNumberVector = {
		device: mount.name,
		name: 'GUIDE_RATE',
		permission: 'rw',
		state: 'Ok',
		elements: {
			GUIDE_RATE_WE: defNumber('GUIDE_RATE_WE', 0.5),
			GUIDE_RATE_NS: defNumber('GUIDE_RATE_NS', 0.3),
		},
	}

	manager.numberVector(client, guideRate, 'defNumberVector')
	manager.numberVector(client, { device: mount.name, name: 'TELESCOPE_TIMED_GUIDE_NS', permission: 'rw', state: 'Ok', elements: {} }, 'defNumberVector')
	manager.numberVector(client, { device: mount.name, name: 'TELESCOPE_TIMED_GUIDE_WE', permission: 'rw', state: 'Ok', elements: {} }, 'defNumberVector')

	const guideOutput = manager.get(client, mount.name)!
	expect(guideOutput.canPulseGuide).toBeTrue()
	expect(guideOutput.hasGuideRate).toBeTrue()
	expect(guideOutput.canSetGuideRate).toBeTrue()
	expect(guideOutput.guideRate).toEqual({ rightAscension: 0.5, declination: 0.3 })
})

test('keeps the remaining timed-guide axis active when one is deleted', () => {
	const mountManager = new MountManager()
	const mount = structuredClone(DEFAULT_MOUNT)
	mount.id = Bun.randomUUIDv7()
	mount.name = 'Mount'
	Object.defineProperty(mount, CLIENT, { value: client })
	mountManager.add(mount)

	const manager = new GuideOutputManager(mountManager)
	const timedGuide = (name: 'TELESCOPE_TIMED_GUIDE_NS' | 'TELESCOPE_TIMED_GUIDE_WE', state: DefNumberVector['state']): DefNumberVector => ({
		device: mount.name,
		name,
		permission: 'rw',
		state,
		elements: {},
	})
	const processTimedGuide = (name: 'TELESCOPE_TIMED_GUIDE_NS' | 'TELESCOPE_TIMED_GUIDE_WE', state: DefNumberVector['state'], tag: 'defNumberVector' | 'setNumberVector') => {
		const message = timedGuide(name, state)
		manager.numberVector(client, message, tag)
		manager.vector(client, message, tag)
	}

	processTimedGuide('TELESCOPE_TIMED_GUIDE_NS', 'Ok', 'defNumberVector')
	processTimedGuide('TELESCOPE_TIMED_GUIDE_WE', 'Busy', 'defNumberVector')
	const guideRate: DefNumberVector = {
		device: mount.name,
		name: 'GUIDE_RATE',
		permission: 'rw',
		state: 'Ok',
		elements: {},
	}
	manager.numberVector(client, guideRate, 'defNumberVector')
	manager.vector(client, guideRate, 'defNumberVector')

	const guideOutput = manager.get(client, mount.name)!
	manager.delProperty(client, { device: mount.name, name: 'TELESCOPE_TIMED_GUIDE_NS' })

	expect(manager.length).toBe(1)
	expect(guideOutput.canPulseGuide).toBeTrue()
	expect(guideOutput.pulsingNS).toBeFalse()
	expect(guideOutput.pulsingWE).toBeTrue()
	expect(guideOutput.pulsing).toBeTrue()

	guideOutput.canPulseGuide = false
	processTimedGuide('TELESCOPE_TIMED_GUIDE_NS', 'Ok', 'defNumberVector')
	expect(guideOutput.canPulseGuide).toBeTrue()
})

test('remains pulsing until both timed-guide axes finish', () => {
	const mountManager = new MountManager()
	const mount = structuredClone(DEFAULT_MOUNT)
	mount.id = Bun.randomUUIDv7()
	mount.name = 'Mount'
	Object.defineProperty(mount, CLIENT, { value: client })
	mountManager.add(mount)

	const manager = new GuideOutputManager(mountManager)
	const timedGuide = (name: 'TELESCOPE_TIMED_GUIDE_NS' | 'TELESCOPE_TIMED_GUIDE_WE', state: DefNumberVector['state']): DefNumberVector => ({
		device: mount.name,
		name,
		permission: 'rw',
		state,
		elements: {},
	})

	manager.numberVector(client, timedGuide('TELESCOPE_TIMED_GUIDE_NS', 'Busy'), 'defNumberVector')

	const guideOutput = manager.get(client, mount.name)!
	expect(guideOutput.pulsing).toBeTrue()
	expect(guideOutput.pulsingNS).toBeTrue()
	expect(guideOutput.pulsingWE).toBeFalse()
	expect(mount.pulsing).toBeTrue()
	expect(mount.pulsingNS).toBeTrue()
	expect(mount.pulsingWE).toBeFalse()

	manager.numberVector(client, timedGuide('TELESCOPE_TIMED_GUIDE_WE', 'Busy'), 'defNumberVector')
	expect(guideOutput.pulsingNS).toBeTrue()
	expect(guideOutput.pulsingWE).toBeTrue()
	expect(mount.pulsingNS).toBeTrue()
	expect(mount.pulsingWE).toBeTrue()

	manager.numberVector(client, timedGuide('TELESCOPE_TIMED_GUIDE_NS', 'Ok'), 'setNumberVector')
	expect(guideOutput.pulsing).toBeTrue()
	expect(guideOutput.pulsingNS).toBeFalse()
	expect(guideOutput.pulsingWE).toBeTrue()
	expect(mount.pulsing).toBeTrue()
	expect(mount.pulsingNS).toBeFalse()
	expect(mount.pulsingWE).toBeTrue()

	manager.numberVector(client, timedGuide('TELESCOPE_TIMED_GUIDE_WE', 'Ok'), 'setNumberVector')
	expect(guideOutput.pulsing).toBeFalse()
	expect(guideOutput.pulsingNS).toBeFalse()
	expect(guideOutput.pulsingWE).toBeFalse()
	expect(mount.pulsing).toBeFalse()
	expect(mount.pulsingNS).toBeFalse()
	expect(mount.pulsingWE).toBeFalse()
})

test('reports every timed-guide definition and update with its state, even when the flag is unchanged', () => {
	const mountManager = new MountManager()
	const mount = structuredClone(DEFAULT_MOUNT)
	mount.id = Bun.randomUUIDv7()
	mount.name = 'Mount'
	Object.defineProperty(mount, CLIENT, { value: client })
	mountManager.add(mount)

	const manager = new GuideOutputManager(mountManager)
	const notifications: [string, string, string | undefined][] = []
	manager.addHandler({ added: () => {}, removed: () => {}, updated: (device, property, state) => notifications.push([device === mount ? 'mount' : 'view', property, state]) })
	const timedGuide = (name: 'TELESCOPE_TIMED_GUIDE_NS' | 'TELESCOPE_TIMED_GUIDE_WE', state: DefNumberVector['state']): DefNumberVector => ({ device: mount.name, name, permission: 'rw', state, elements: {} })

	manager.numberVector(client, timedGuide('TELESCOPE_TIMED_GUIDE_NS', 'Idle'), 'defNumberVector')
	notifications.length = 0

	// The flag is already false, but the published state is evidence and is reported; the aggregate is not.
	manager.numberVector(client, timedGuide('TELESCOPE_TIMED_GUIDE_NS', 'Idle'), 'setNumberVector')
	expect(notifications).toEqual([
		['view', 'pulsingNS', 'Idle'],
		['mount', 'pulsingNS', 'Idle'],
	])

	notifications.length = 0
	manager.numberVector(client, timedGuide('TELESCOPE_TIMED_GUIDE_NS', 'Busy'), 'setNumberVector')
	expect(notifications).toEqual([
		['view', 'pulsingNS', 'Busy'],
		['mount', 'pulsingNS', 'Busy'],
		['view', 'pulsing', 'Busy'],
		['mount', 'pulsing', 'Busy'],
	])

	// A deleted vector resets the flags without any state, which is not a published observation.
	notifications.length = 0
	manager.delProperty(client, { device: mount.name, name: 'TELESCOPE_TIMED_GUIDE_NS' })
	expect(notifications.filter(([, property]) => property === 'pulsingNS').every(([, , state]) => state === undefined)).toBeTrue()
	expect(notifications.some(([, property]) => property === 'pulsingNS')).toBeTrue()
})

test('reports the connection of the guide output whichever manager applies the switch first', () => {
	const asked: string[] = []
	const owner: Client = { ...client, getProperties: (command) => asked.push(command?.device ?? '') }
	const mountManager = new MountManager()
	const mount = structuredClone(DEFAULT_MOUNT)
	mount.id = Bun.randomUUIDv7()
	mount.name = 'Mount'
	Object.defineProperty(mount, CLIENT, { value: owner })
	mountManager.add(mount)

	const manager = new GuideOutputManager(mountManager)
	const notifications: [string, string][] = []
	manager.addHandler({ added: () => {}, removed: () => {}, updated: (device, property) => property === 'connected' && notifications.push([device === mount ? 'mount' : 'view', property]) })
	mountManager.addHandler({ added: () => {}, removed: () => {}, updated: (device, property) => property === 'connected' && notifications.push(['parent', property]) })
	const connection = (connected: boolean): SetSwitchVector => ({ device: mount.name, name: 'CONNECTION', state: 'Ok', elements: { CONNECT: { name: 'CONNECT', value: connected }, DISCONNECT: { name: 'DISCONNECT', value: !connected } } })

	// INDI defines the timed-guide vectors of a connected driver before it replays CONNECTION for the new device.
	manager.numberVector(owner, { device: mount.name, name: 'TELESCOPE_TIMED_GUIDE_NS', permission: 'rw', state: 'Ok', elements: {} }, 'defNumberVector')
	const guideOutput = manager.get(owner, mount.name)!
	expect(guideOutput.connected).toBeFalse()

	mountManager.switchVector(owner, connection(true), 'defSwitchVector')
	manager.switchVector(owner, connection(true), 'defSwitchVector')
	expect(notifications).toEqual([
		['parent', 'connected'],
		['view', 'connected'],
	])
	expect([mount.connected, guideOutput.connected]).toEqual([true, true])
	// Only the manager of the physical device asks for its properties.
	expect(asked).toEqual(['Mount'])

	notifications.length = 0
	manager.switchVector(owner, connection(false), 'setSwitchVector')
	mountManager.switchVector(owner, connection(false), 'setSwitchVector')
	expect(notifications).toEqual([
		['view', 'connected'],
		['parent', 'connected'],
	])
	expect([mount.connected, guideOutput.connected]).toEqual([false, false])
})
