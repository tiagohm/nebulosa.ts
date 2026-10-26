import { describe, expect, test } from 'bun:test'
import { handleDefNumberVector, handleDefSwitchVector, handleSetNumberVector, handleSetSwitchVector, IndiClientHandlerSet } from '../../../src/devices/indi/client'
import { DEFAULT_CAMERA, DEFAULT_ROTATOR, DeviceInterfaceType, type Rotator } from '../../../src/devices/indi/device'
import { makeDevice, proxyDevice } from '../../../src/devices/indi/manager/device'
import { RotatorManager } from '../../../src/devices/indi/manager/rotator'
import { WheelManager } from '../../../src/devices/indi/manager/wheel'
import { type IndiProperty, type IndiPropertyChange, IndiPropertyRegistry, makeHardwareId } from '../../../src/devices/indi/properties'
import type { DefBlobVector, DefLightVector, DefNumberVector, DefSwitchVector, DefTextVector, SetBlobVector, SetNumberVector, SetSwitchVector } from '../../../src/devices/indi/types'
import { client, defNumber, defSwitch, driverInfo, setupDevice } from './manager/util'

type Event = readonly [string, string, string?, IndiPropertyChange?]

function setup() {
	const registry = new IndiPropertyRegistry()
	const events: Event[] = []

	registry.addListener({
		deviceAdded: (_, device) => events.push(['deviceAdded', device.name]),
		deviceUpdated: (_, device) => events.push(['deviceUpdated', device.name]),
		deviceRemoved: (_, device) => events.push(['deviceRemoved', device.name]),
		propertyDefined: (_, device, property) => events.push(['propertyDefined', device.name, property.name]),
		propertyUpdated: (_, device, property, change) => events.push(['propertyUpdated', device.name, property.name, change]),
		propertyRemoved: (_, device, property) => events.push(['propertyRemoved', device.name, property.name]),
		message: (_, device, message) => events.push(['message', device.name, message.message]),
	})

	return { registry, events }
}

function connection(device: string, connected: boolean): DefSwitchVector {
	return { device, name: 'CONNECTION', label: 'Connection', group: 'Main Control', permission: 'rw', rule: 'OneOfMany', state: 'Ok', timeout: 60, elements: { CONNECT: defSwitch('CONNECT', connected, 'Connect'), DISCONNECT: defSwitch('DISCONNECT', !connected, 'Disconnect') } }
}

function temperature(device: string, value: number): DefNumberVector {
	return { device, name: 'TEMPERATURE', label: 'Temperature', group: 'Sensors', permission: 'rw', state: 'Idle', timeout: Number.NaN, elements: { TEMP: { ...defNumber('TEMP', value, -50, 50, 0.5), label: 'Celsius' }, SETPOINT: defNumber('SETPOINT', 0, -50, 50, 0.5) } }
}

function property(registry: IndiPropertyRegistry, device: string, name: string): IndiProperty & { timeout?: number } {
	return registry.property(client, device, name)!
}

describe('definition', () => {
	test('creates a device of any interface on its first vector', () => {
		const { registry, events } = setup()

		registry.vector(client, connection('Relay Box', false), 'defSwitchVector')
		registry.vector(client, driverInfo('Relay Box', DeviceInterfaceType.AUXILIARY), 'defTextVector')

		const device = registry.device(client, 'Relay Box')!

		expect(device.hardwareId).toBe(makeHardwareId(client, 'Relay Box'))
		expect(device.hardwareId).toBe(makeDevice(DEFAULT_CAMERA, client, 'Relay Box').hardwareId)
		expect(device.connected).toBeFalse()
		expect(device.driver).toEqual({ name: '', executable: 'driver', version: '1.0', interface: DeviceInterfaceType.AUXILIARY })
		expect(registry.length).toBe(1)
		expect(registry.device(client, device.hardwareId)).toBe(device)
		expect(events).toEqual([
			['deviceAdded', 'Relay Box'],
			['propertyDefined', 'Relay Box', 'CONNECTION'],
			['deviceUpdated', 'Relay Box'],
			['propertyDefined', 'Relay Box', 'DRIVER_INFO'],
			['deviceUpdated', 'Relay Box'],
		])
	})

	test('copies the metadata and never keeps the parsed message', () => {
		const { registry } = setup()
		const message = temperature('Sensor', 12.5)

		registry.vector(client, message, 'defNumberVector')
		message.elements.TEMP.value = 99
		message.state = 'Alert'

		const stored = property(registry, 'Sensor', 'TEMPERATURE')

		expect(stored).toMatchObject({ type: 'NUMBER', label: 'Temperature', group: 'Sensors', permission: 'rw', state: 'Idle', elementNames: ['TEMP', 'SETPOINT'] })
		expect(stored).not.toHaveProperty('timeout', Number.NaN)
		expect(stored.timeout).toBeUndefined()
		expect(stored.elements.TEMP).toEqual({ name: 'TEMP', label: 'Celsius', format: '%g', min: -50, max: 50, step: 0.5, value: 12.5 })
	})

	test('keeps the switch rule and leaves lights without permission', () => {
		const { registry } = setup()
		const light: DefLightVector = { device: 'Cam', name: 'STATUS', state: 'Ok', elements: { READY: { name: 'READY', value: 'Busy' } } }

		registry.vector(client, connection('Cam', true), 'defSwitchVector')
		registry.vector(client, light, 'defLightVector')

		expect(property(registry, 'Cam', 'CONNECTION')).toMatchObject({ type: 'SWITCH', rule: 'OneOfMany', timeout: 60 })
		expect(property(registry, 'Cam', 'STATUS')).not.toHaveProperty('permission')
		expect(property(registry, 'Cam', 'STATUS').elements.READY.value).toBe('Busy')
	})

	test('a redefinition replaces the vector with a new revision', () => {
		const { registry, events } = setup()

		registry.vector(client, temperature('Sensor', 1), 'defNumberVector')
		registry.vector(client, connection('Sensor', true), 'defSwitchVector')
		const first = property(registry, 'Sensor', 'TEMPERATURE')
		events.length = 0

		const redefined = temperature('Sensor', 2)
		delete (redefined.elements as Record<string, unknown>).SETPOINT
		registry.vector(client, redefined, 'defNumberVector')

		const second = property(registry, 'Sensor', 'TEMPERATURE')

		expect(second).not.toBe(first)
		expect(second.revision).toBeGreaterThan(first.revision)
		expect(second.elementNames).toEqual(['TEMP'])
		expect(Object.keys(registry.device(client, 'Sensor')!.properties)).toEqual(['CONNECTION', 'TEMPERATURE'])
		expect(events).toEqual([['propertyDefined', 'Sensor', 'TEMPERATURE']])
	})
})

describe('update', () => {
	test('merges a partial set and keeps the other elements', () => {
		const { registry, events } = setup()
		registry.vector(client, temperature('Sensor', 1), 'defNumberVector')
		const before = property(registry, 'Sensor', 'TEMPERATURE').revision
		events.length = 0

		const set: SetNumberVector = { device: 'Sensor', name: 'TEMPERATURE', timeout: Number.NaN, timestamp: '2026-10-26T12:00:00', elements: { TEMP: { name: 'TEMP', value: 2 } } }
		registry.vector(client, set, 'setNumberVector')

		const stored = property(registry, 'Sensor', 'TEMPERATURE')

		expect(stored.elements.TEMP.value).toBe(2)
		expect(stored.elements.SETPOINT.value).toBe(0)
		expect(stored.timestamp).toBe('2026-10-26T12:00:00')
		expect(stored.revision).toBeGreaterThan(before)
		expect(events).toEqual([['propertyUpdated', 'Sensor', 'TEMPERATURE', { kind: 'values', elements: ['TEMP'] }]])
	})

	test('a set that changes nothing is not reported', () => {
		const { registry, events } = setup()
		registry.vector(client, temperature('Sensor', 1), 'defNumberVector')
		const before = property(registry, 'Sensor', 'TEMPERATURE').revision
		events.length = 0

		registry.vector(client, { device: 'Sensor', name: 'TEMPERATURE', state: 'Idle', timestamp: '2026-10-26T12:00:01', elements: { TEMP: { name: 'TEMP', value: 1 } } }, 'setNumberVector')

		expect(events).toBeEmpty()
		expect(property(registry, 'Sensor', 'TEMPERATURE').revision).toBe(before)
		expect(property(registry, 'Sensor', 'TEMPERATURE').timestamp).toBe('2026-10-26T12:00:01')
	})

	test('a state or message change is feedback even with identical values', () => {
		const { registry, events } = setup()
		registry.vector(client, temperature('Sensor', 1), 'defNumberVector')
		events.length = 0

		registry.vector(client, { device: 'Sensor', name: 'TEMPERATURE', state: 'Alert', elements: { TEMP: { name: 'TEMP', value: 1 } } }, 'setNumberVector')
		registry.vector(client, { device: 'Sensor', name: 'TEMPERATURE', message: 'sensor lost', elements: {} }, 'setNumberVector')

		expect(property(registry, 'Sensor', 'TEMPERATURE')).toMatchObject({ state: 'Alert', message: 'sensor lost' })
		expect(events).toEqual([
			['propertyUpdated', 'Sensor', 'TEMPERATURE', { kind: 'feedback', elements: [] }],
			['propertyUpdated', 'Sensor', 'TEMPERATURE', { kind: 'feedback', elements: [] }],
		])
	})

	test('a range or timeout change is metadata', () => {
		const { registry, events } = setup()
		registry.vector(client, temperature('Sensor', 1), 'defNumberVector')
		events.length = 0

		registry.vector(client, { device: 'Sensor', name: 'TEMPERATURE', state: 'Busy', elements: { SETPOINT: { name: 'SETPOINT', value: 0, min: -20, max: 20, step: 1 } } }, 'setNumberVector')
		registry.vector(client, { device: 'Sensor', name: 'TEMPERATURE', timeout: 30, elements: {} }, 'setNumberVector')

		expect(property(registry, 'Sensor', 'TEMPERATURE').elements.SETPOINT).toMatchObject({ min: -20, max: 20, step: 1, value: 0 })
		expect(property(registry, 'Sensor', 'TEMPERATURE').timeout).toBe(30)
		expect(events).toEqual([
			['propertyUpdated', 'Sensor', 'TEMPERATURE', { kind: 'metadata', elements: ['SETPOINT'] }],
			['propertyUpdated', 'Sensor', 'TEMPERATURE', { kind: 'metadata', elements: [] }],
		])
	})

	test('ignores sets of unknown vectors and elements', () => {
		const { registry, events } = setup()
		registry.vector(client, temperature('Sensor', 1), 'defNumberVector')
		events.length = 0

		registry.vector(client, { device: 'Sensor', name: 'HUMIDITY', elements: { H: { name: 'H', value: 1 } } }, 'setNumberVector')
		registry.vector(client, { device: 'Other', name: 'TEMPERATURE', elements: { TEMP: { name: 'TEMP', value: 1 } } }, 'setNumberVector')
		registry.vector(client, { device: 'Sensor', name: 'TEMPERATURE', elements: { EXTRA: { name: 'EXTRA', value: 5 } } }, 'setNumberVector')

		expect(events).toBeEmpty()
		expect(property(registry, 'Sensor', 'TEMPERATURE').elements.EXTRA).toBeUndefined()
	})

	test('merges the same object resent as definition and update', () => {
		const { registry, events } = setup()
		// Simulators and the Alpaca client send one object for the definition and every later update.
		const vector = temperature('Sensor', 1)
		registry.vector(client, vector, 'defNumberVector')
		events.length = 0

		vector.elements.TEMP.value = 3
		registry.vector(client, vector, 'setNumberVector')

		expect(property(registry, 'Sensor', 'TEMPERATURE').elements.TEMP.value).toBe(3)
		expect(events).toEqual([['propertyUpdated', 'Sensor', 'TEMPERATURE', { kind: 'values', elements: ['TEMP'] }]])
	})

	test('a connection change updates the device', () => {
		const { registry, events } = setup()
		registry.vector(client, connection('Cam', false), 'defSwitchVector')
		events.length = 0

		const set: SetSwitchVector = { device: 'Cam', name: 'CONNECTION', state: 'Ok', elements: { CONNECT: { name: 'CONNECT', value: true }, DISCONNECT: { name: 'DISCONNECT', value: false } } }
		registry.vector(client, set, 'setSwitchVector')

		expect(registry.device(client, 'Cam')?.connected).toBeTrue()
		expect(events).toEqual([
			['propertyUpdated', 'Cam', 'CONNECTION', { kind: 'values', elements: ['CONNECT', 'DISCONNECT'] }],
			['deviceUpdated', 'Cam'],
		])
	})

	test('keeps the metadata of a BLOB and never its bytes', () => {
		const { registry, events } = setup()
		const blob: DefBlobVector = { device: 'Cam', name: 'CCD1', label: 'Image', permission: 'ro', state: 'Idle', elements: { CCD1: { name: 'CCD1', label: 'Image' } } }
		registry.vector(client, blob, 'defBLOBVector')
		events.length = 0

		const set: SetBlobVector = { device: 'Cam', name: 'CCD1', state: 'Ok', elements: { CCD1: { name: 'CCD1', size: '5', format: '.fits', value: Buffer.from('hello') } } }
		registry.vector(client, set, 'setBLOBVector')

		const element = property(registry, 'Cam', 'CCD1').elements.CCD1

		expect(element).toEqual({ name: 'CCD1', label: 'Image', format: '.fits', size: 5 })
		expect('value' in element).toBeFalse()
		expect(events).toEqual([['propertyUpdated', 'Cam', 'CCD1', { kind: 'feedback', elements: ['CCD1'] }]])
	})
})

describe('removal', () => {
	test('deletes one vector, then the device with its last one', () => {
		const { registry, events } = setup()
		registry.vector(client, connection('Cam', true), 'defSwitchVector')
		registry.vector(client, temperature('Cam', 1), 'defNumberVector')
		events.length = 0

		registry.delProperty(client, { device: 'Cam', name: 'CONNECTION' })

		expect(registry.device(client, 'Cam')?.connected).toBeUndefined()

		registry.delProperty(client, { device: 'Cam', name: 'TEMPERATURE' })

		expect(registry.device(client, 'Cam')).toBeUndefined()
		expect(registry.length).toBe(0)
		expect(events).toEqual([
			['propertyRemoved', 'Cam', 'CONNECTION'],
			['deviceUpdated', 'Cam'],
			['propertyRemoved', 'Cam', 'TEMPERATURE'],
			['deviceRemoved', 'Cam'],
		])
	})

	test('deletes a whole device at once', () => {
		const { registry, events } = setup()
		registry.vector(client, connection('Cam', true), 'defSwitchVector')
		registry.vector(client, temperature('Cam', 1), 'defNumberVector')
		registry.vector(client, temperature('Focuser', 1), 'defNumberVector')
		events.length = 0

		registry.delProperty(client, { device: 'Cam' })
		registry.delProperty(client, { device: 'Unknown' })

		expect(registry.devices(client).map((device) => device.name)).toEqual(['Focuser'])
		expect(events).toEqual([['deviceRemoved', 'Cam']])
	})

	test('drops every device of a closed client', () => {
		const { registry, events } = setup()
		const other = { ...client, id: 'other' }
		registry.vector(client, temperature('Cam', 1), 'defNumberVector')
		registry.vector(client, temperature('Focuser', 1), 'defNumberVector')
		registry.vector(other, temperature('Cam', 1), 'defNumberVector')
		events.length = 0

		registry.close(client, true)

		expect(registry.devices(client)).toBeEmpty()
		expect(registry.devices(other)).toHaveLength(1)
		expect(registry.device(other, 'Cam')?.hardwareId).not.toBe(makeHardwareId(client, 'Cam'))
		expect(events).toEqual([
			['deviceRemoved', 'Cam'],
			['deviceRemoved', 'Focuser'],
		])
	})
})

test('forwards only the messages of known devices', () => {
	const { registry, events } = setup()
	registry.vector(client, temperature('Cam', 1), 'defNumberVector')
	events.length = 0

	registry.message(client, { id: '1', device: 'Cam', message: 'cooling' })
	registry.message(client, { id: '2', device: 'Unknown', message: 'ignored' })
	registry.message(client, { id: '3', message: 'server' })

	expect(events).toEqual([['message', 'Cam', 'cooling']])
})

test('reads the vectors of a managed device and of its sub-device proxies', () => {
	const { registry } = setup()
	const camera = makeDevice(DEFAULT_CAMERA, client, 'Cam')
	const thermometer = proxyDevice(camera, 'thermometer', 'thermometer')
	registry.vector(client, temperature('Cam', 1), 'defNumberVector')

	expect(registry.get(camera)?.TEMPERATURE.type).toBe('NUMBER')
	expect(registry.get(thermometer)).toBe(registry.get(camera))
	expect(registry.has(makeDevice(DEFAULT_CAMERA, client, 'Other'))).toBeFalse()
})

describe('managers', () => {
	test('a private registry keeps only the managed devices', () => {
		const manager = new WheelManager()
		const wheel = makeDevice({ ...DEFAULT_CAMERA, type: 'wheel' } as never, client, 'Wheel')
		manager.add(wheel)

		manager.vector(client, temperature('Wheel', 1), 'defNumberVector')
		manager.vector(client, temperature('Cam', 1), 'defNumberVector')

		expect(manager.properties.devices(client).map((device) => device.name)).toEqual(['Wheel'])

		manager.delProperty(client, { device: 'Wheel' })

		expect(manager.properties.length).toBe(0)
	})

	test('a shared registry is fed by the handler set, never by the managers', () => {
		const registry = new IndiPropertyRegistry()
		const manager = new WheelManager(registry)

		manager.vector(client, temperature('Wheel', 1), 'defNumberVector')

		expect(registry.length).toBe(0)
		expect(manager.properties).toBe(registry)
	})

	test('a manager reads the other vectors from the shared registry', () => {
		const registry = new IndiPropertyRegistry()
		const manager = new RotatorManager(registry)
		const handler = new IndiClientHandlerSet([registry, manager])
		const rotator = setupDevice<Rotator>(structuredClone(DEFAULT_ROTATOR))
		manager.add(rotator)

		const home: DefSwitchVector = { device: rotator.name, name: 'ROTATOR_HOME', permission: 'rw', rule: 'AtMostOne', state: 'Idle', elements: { HOME: defSwitch('HOME', false) } }
		const angle: DefNumberVector = { device: rotator.name, name: 'ABS_ROTATOR_ANGLE', permission: 'rw', state: 'Idle', elements: { ANGLE: defNumber('ANGLE', 0) } }
		handleDefSwitchVector(client, handler, home)
		handleDefNumberVector(client, handler, angle)

		handleSetNumberVector(client, handler, { device: rotator.name, name: 'ABS_ROTATOR_ANGLE', state: 'Busy', elements: { ANGLE: { name: 'ANGLE', value: 10 } } })
		handleSetSwitchVector(client, handler, { device: rotator.name, name: 'ROTATOR_HOME', state: 'Idle', elements: { HOME: { name: 'HOME', value: false } } })

		expect(rotator.moving).toBeTrue()

		handleSetNumberVector(client, handler, { device: rotator.name, name: 'ABS_ROTATOR_ANGLE', state: 'Ok', elements: { ANGLE: { name: 'ANGLE', value: 10 } } })

		expect(rotator.moving).toBeFalse()
		expect(registry.get(rotator)?.ABS_ROTATOR_ANGLE.state).toBe('Ok')
	})
})

test('text vectors merge values', () => {
	const { registry, events } = setup()
	const info: DefTextVector = driverInfo('Cam', DeviceInterfaceType.CCD)
	registry.vector(client, info, 'defTextVector')
	events.length = 0

	registry.vector(client, { device: 'Cam', name: 'DRIVER_INFO', elements: { DRIVER_VERSION: { name: 'DRIVER_VERSION', value: '2.0' } } }, 'setTextVector')

	expect(registry.device(client, 'Cam')?.driver?.version).toBe('2.0')
	expect(events).toEqual([
		['propertyUpdated', 'Cam', 'DRIVER_INFO', { kind: 'values', elements: ['DRIVER_VERSION'] }],
		['deviceUpdated', 'Cam'],
	])
})
