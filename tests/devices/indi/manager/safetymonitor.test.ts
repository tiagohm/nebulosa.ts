import { expect, test } from 'bun:test'
import { DeviceInterfaceType, type SafetyMonitor } from '../../../../src/devices/indi/device'
import { CameraManager } from '../../../../src/devices/indi/manager/camera'
import type { DeviceHandler } from '../../../../src/devices/indi/manager/device'
import { SafetyMonitorManager } from '../../../../src/devices/indi/manager/safetymonitor'
import type { DefLightVector, SetLightVector } from '../../../../src/devices/indi/types'
import { client, driverInfo } from './util'

function safetyStatus(device: string, state: DefLightVector['state']): DefLightVector {
	return { device, name: 'SAFETY_STATUS', state, elements: { SAFETY: { name: 'SAFETY', value: state } } }
}

test('creates only AUXILIARY native INDI standalones', () => {
	const manager = new SafetyMonitorManager({ get: () => undefined })

	manager.lightVector(client, safetyStatus('Safety', 'Ok'), 'defLightVector')
	expect(manager.get(client, 'Safety')).toBeUndefined()

	manager.textVector(client, driverInfo('Safety', DeviceInterfaceType.AUXILIARY), 'defTextVector')
	expect(manager.get(client, 'Safety')).toBeDefined()

	manager.textVector(client, driverInfo('Not Auxiliary', DeviceInterfaceType.CCD), 'defTextVector')
	manager.lightVector(client, safetyStatus('Not Auxiliary', 'Ok'), 'defLightVector')
	expect(manager.get(client, 'Not Auxiliary')).toBeUndefined()
})

test('creates a proxy without replacing parent interfaces', () => {
	let cameraUpdated = 0

	const handler: DeviceHandler<SafetyMonitor> = {
		added: function (device: SafetyMonitor) {},
		updated: function (device: SafetyMonitor, property: string) {
			if (property === 'safe' && device.type === 'camera') cameraUpdated++
		},
		removed: function (device: SafetyMonitor) {},
	}

	const cameraManager = new CameraManager()
	cameraManager.textVector(client, driverInfo('Camera', DeviceInterfaceType.CCD), 'defTextVector')
	const camera = cameraManager.get(client, 'Camera')!
	const manager = new SafetyMonitorManager(cameraManager)
	manager.addHandler(handler)

	manager.lightVector(client, safetyStatus('Camera', 'Ok'), 'defLightVector')
	const safety = manager.get(client, 'Camera')!
	expect(safety).toBeDefined()
	expect(safety.safe).toBeTrue()

	expect(camera).not.toContainKey('safe')

	const partial: SetLightVector = { device: 'Camera', name: 'SAFETY_STATUS', elements: { SAFETY: { name: 'SAFETY', value: 'Alert' } } }
	manager.lightVector(client, partial, 'setLightVector')
	expect(safety.safe).toBeTrue()

	manager.lightVector(client, { ...partial, state: 'Alert' }, 'setLightVector')
	expect(safety.safe).toBeFalse()

	manager.delProperty(client, { device: 'Camera', name: 'SAFETY_STATUS' })
	expect(manager.get(client, 'Camera')).toBeUndefined()
	expect(camera).not.toContainKey('safe')

	expect(cameraUpdated).toBe(0)
})
