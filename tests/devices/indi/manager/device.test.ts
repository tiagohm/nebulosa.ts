import { describe, expect, test } from 'bun:test'
import { DEFAULT_CAMERA, type Camera, type Client, type Device, DeviceInterfaceType } from '../../../../src/devices/indi/device'
import { CameraManager } from '../../../../src/devices/indi/manager/camera'
import { handleMinMaxValue } from '../../../../src/devices/indi/manager/device'
import type { DefText, DefTextVector, OneNumber } from '../../../../src/devices/indi/types'
import { client, setupDevice } from './util'

test('dome interface bit is rediscovered as a dome device type after interface bitmask be updated', () => {
	let updated = false
	const manager = new CameraManager()
	manager.addHandler({
		added: function (device: Camera) {},
		updated(device, property, state) {
			if (property === 'interfaces' && device.interfaces.length >= 2) updated = true
		},
		removed: function (device: Camera) {},
	})
	const DRIVER_INTERFACE: DefText = { name: 'DRIVER_INTERFACE', value: DeviceInterfaceType.CCD.toFixed(0) }
	const elements = { DRIVER_INTERFACE }
	const message: DefTextVector = { device: 'Camera', name: 'DRIVER_INFO', permission: 'ro', state: 'Ok', elements }
	manager.textVector(client, message, 'defTextVector')
	const camera = manager.get(client, 'Camera')

	expect(camera).toBeDefined()
	expect(camera!.interfaces).toEqual(['camera'])

	DRIVER_INTERFACE.value = (DeviceInterfaceType.CCD | DeviceInterfaceType.FILTER).toFixed(0)
	manager.textVector(client, message, 'defTextVector')

	expect(camera!.interfaces).toEqual(['camera', 'wheel'])
	expect(updated).toBeTrue()

	updated = false

	DRIVER_INTERFACE.value = (DeviceInterfaceType.CCD | DeviceInterfaceType.FOCUSER).toFixed(0)
	manager.textVector(client, message, 'setTextVector')

	expect(camera!.interfaces).toEqual(['camera', 'focuser'])
	expect(updated).toBeTrue()

	updated = false

	DRIVER_INTERFACE.value = (DeviceInterfaceType.CCD | DeviceInterfaceType.FILTER | DeviceInterfaceType.FOCUSER).toFixed(0)
	manager.textVector(client, message, 'setTextVector')

	expect(camera!.interfaces).toEqual(['camera', 'wheel', 'focuser'])
	expect(updated).toBeTrue()

	updated = false

	DRIVER_INTERFACE.value = (DeviceInterfaceType.CCD | DeviceInterfaceType.ROTATOR).toFixed(0)
	manager.textVector(client, message, 'setTextVector')

	expect(camera!.interfaces).toEqual(['camera', 'rotator'])
	expect(updated).toBeTrue()
})

test('clamps a value when an updated range changes without changing the value', () => {
	const property = { value: 80, min: 0, max: 100, step: 1 }
	const element = { name: 'Gain', value: 80, min: 0, max: 50, step: 1 } satisfies OneNumber

	expect(handleMinMaxValue(property, element, 'setNumberVector')).toBeTrue()
	expect(property).toEqual({ value: 50, min: 0, max: 50, step: 1 })
})

describe('del property', () => {
	test('add registers a device for lookup and close clears it', () => {
		const manager = new CameraManager()
		const device = setupDevice(structuredClone(DEFAULT_CAMERA))

		let added: Device | undefined
		let removed: Device | undefined
		manager.addHandler({ added: (d) => (added = d), removed: (d) => (removed = d), updated: () => {} })

		manager.add(device)

		expect(manager).toHaveLength(1)
		expect(manager.get(client, device.name)).toBe(device)
		expect(manager.get(client, device.id)).toBe(device)
		expect(manager.get(client, device.hardwareId)).toBe(device)
		expect(added).toBe(device)

		manager.close(client, true)

		expect(manager).toHaveLength(0)
		expect(manager.get(client, device.name)).toBeUndefined()
		expect(removed).toBe(device)
	})

	test('close clears only devices owned by the closing client', () => {
		const otherClient: Client = { ...client, id: 'other' }
		const manager = new CameraManager()
		const closing = setupDevice(structuredClone(DEFAULT_CAMERA))
		const remaining = setupDevice(structuredClone(DEFAULT_CAMERA), otherClient)
		remaining.name = 'other camera'

		manager.add(closing)
		manager.add(remaining)
		manager.close(client, true)

		expect(manager).toHaveLength(1)
		expect(manager.get(client, closing.name)).toBeUndefined()
		expect(manager.get(otherClient, remaining.name)).toBe(remaining)
	})

	test('list returns no devices for unknown or closed client IDs', () => {
		const otherClient: Client = { ...client, id: 'other' }
		const manager = new CameraManager()
		const first = setupDevice(structuredClone(DEFAULT_CAMERA))
		const second = setupDevice(structuredClone(DEFAULT_CAMERA), otherClient)

		manager.add(first)
		manager.add(second)

		expect(manager.list('missing').size).toBe(0)
		expect(manager.list(otherClient.id)).toEqual(new Set([second]))

		manager.close(otherClient, true)

		expect(manager.list(otherClient.id).size).toBe(0)
		expect(manager.list(client)).toEqual(new Set([first]))
	})
})
