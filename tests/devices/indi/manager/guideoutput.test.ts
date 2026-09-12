import { expect, test } from 'bun:test'
import { CLIENT, DEFAULT_MOUNT } from '../../../../src/devices/indi/device'
import { GuideOutputManager } from '../../../../src/devices/indi/manager/guideoutput'
import { MountManager } from '../../../../src/devices/indi/manager/mount'
import type { DefNumberVector } from '../../../../src/devices/indi/types'
import { client, createRecordingClient } from './util'

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
