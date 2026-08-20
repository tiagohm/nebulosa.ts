import { expect, describe, test } from 'bun:test'
// oxfmt-ignore
import { CLIENT, type Client, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_DOME, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_WEATHER, DEFAULT_WHEEL, type Cover, type Device, type FlatPanel, type Focuser, type Power, type Rotator, type Wheel, DeviceInterfaceType, type Camera, isDome, isWeather, type SafetyMonitor } from '../../../src/devices/indi/device'
import { PI, PIOVERFOUR, PIOVERTWO, TAU } from '../../../src/core/constants'
import { CameraManager, CoverManager, DomeManager, FlatPanelManager, FocuserManager, MountManager, PowerManager, RotatorManager, SafetyMonitorManager, WeatherManager, WheelManager, type DeviceHandler } from '../../../src/devices/indi/manager'
import type { DefLightVector, DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefText, DefTextVector, SetLightVector } from '../../../src/devices/indi/types'

const client: Client = {
	type: 'INDI',
	id: 'client',
	description: '',
	getProperties() {},
	enableBlob() {},
	sendText() {},
	sendNumber() {},
	sendSwitch() {},
	[Symbol.dispose]() {},
}

const numberCommands: Parameters<Client['sendNumber']>[0][] = []
const switchCommands: Parameters<Client['sendSwitch']>[0][] = []
const recordingClient: Client = {
	...client,
	id: 'recording',
	sendNumber(vector) {
		numberCommands.push(vector)
	},
	sendSwitch(vector) {
		switchCommands.push(vector)
	},
}

function setupDome(manager: DomeManager) {
	const dome = structuredClone(DEFAULT_DOME)
	dome.id = Bun.randomUUIDv7()
	dome.name = 'Dome'
	Object.defineProperty(dome, CLIENT, { value: recordingClient })
	manager.add(dome)
	return dome
}

function defSwitch(name: string, value: boolean): DefSwitch {
	return { name, value }
}

function defNumber(name: string, value: number, min = 0, max = 360, step = 1): DefNumber {
	return { name, format: '%g', min, max, step, value }
}

function driverInfo(device: string, interfaceType: DeviceInterfaceType): DefTextVector {
	return {
		device,
		name: 'DRIVER_INFO',
		permission: 'ro',
		state: 'Ok',
		elements: {
			DRIVER_INTERFACE: { name: 'DRIVER_INTERFACE', value: interfaceType.toFixed(0) },
			DRIVER_EXEC: { name: 'DRIVER_EXEC', value: 'driver' },
			DRIVER_VERSION: { name: 'DRIVER_VERSION', value: '1.0' },
		},
	}
}

function safetyStatus(device: string, state: DefLightVector['state']): DefLightVector {
	return { device, name: 'SAFETY_STATUS', state, elements: { SAFETY: { name: 'SAFETY', value: state } } }
}

test('SafetyMonitorManager creates only AUXILIARY native INDI standalones', () => {
	const manager = new SafetyMonitorManager({ get: () => undefined })

	manager.lightVector(client, safetyStatus('Safety', 'Ok'), 'defLightVector')
	expect(manager.get(client, 'Safety')).toBeUndefined()

	manager.textVector(client, driverInfo('Safety', DeviceInterfaceType.AUXILIARY), 'defTextVector')
	expect(manager.get(client, 'Safety')).toBeDefined()

	manager.textVector(client, driverInfo('Not Auxiliary', DeviceInterfaceType.CCD), 'defTextVector')
	manager.lightVector(client, safetyStatus('Not Auxiliary', 'Ok'), 'defLightVector')
	expect(manager.get(client, 'Not Auxiliary')).toBeUndefined()
})

test('SafetyMonitorManager creates a proxy without replacing parent interfaces', () => {
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

test('dome interface bit is discovered as a dome device type', () => {
	const manager = new DomeManager()
	const DRIVER_INTERFACE: DefText = { name: 'DRIVER_INTERFACE', value: (DeviceInterfaceType.DOME | DeviceInterfaceType.TELESCOPE).toFixed(0) }
	const message: DefTextVector = { device: 'Dome', name: 'DRIVER_INFO', permission: 'ro', state: 'Ok', elements: { DRIVER_INTERFACE } }
	manager.textVector(client, message, 'defTextVector')
	const dome = manager.get(client, 'Dome')

	expect(dome).toBeDefined()
	expect(dome!.interfaces).toEqual(['mount', 'dome'])
})

test('DomeManager discovers and maps dome properties', () => {
	const manager = new DomeManager()
	const DRIVER_INTERFACE: DefText = { name: 'DRIVER_INTERFACE', value: DeviceInterfaceType.DOME.toFixed(0) }
	const message: DefTextVector = { device: 'Dome', name: 'DRIVER_INFO', permission: 'ro', state: 'Ok', elements: { DRIVER_INTERFACE } }
	manager.textVector(client, message, 'defTextVector')

	const dome = manager.get(client, 'Dome')
	expect(dome).toBeDefined()
	expect(isDome(dome!)).toBeTrue()
	expect(dome!.interfaces).toEqual(['dome'])
})

test('DomeManager maps motion, angular ranges, shutter, and measurements', () => {
	const manager = new DomeManager()
	const dome = setupDome(manager)

	const motion: DefSwitchVector = {
		device: dome.name,
		name: 'DOME_MOTION',
		permission: 'rw',
		rule: 'OneOfMany',
		state: 'Busy',
		elements: { DOME_CW: defSwitch('DOME_CW', true), DOME_CCW: defSwitch('DOME_CCW', false) },
	}
	manager.switchVector(recordingClient, motion, 'defSwitchVector')

	expect(dome.canMove).toBeTrue()
	expect(dome.moving).toBeTrue()
	expect(dome.slewing).toBeTrue()
	expect(dome.direction).toBe('CLOCKWISE')

	const position: DefNumberVector = {
		device: dome.name,
		name: 'ABS_DOME_POSITION',
		permission: 'rw',
		state: 'Ok',
		elements: { DOME_ABSOLUTE_POSITION: defNumber('DOME_ABSOLUTE_POSITION', 90) },
	}
	manager.numberVector(recordingClient, position, 'defNumberVector')

	expect(dome.canSetAzimuth).toBeTrue()
	expect(dome.azimuth.value).toBeCloseTo(PIOVERTWO)
	expect(dome.azimuth.min).toBe(0)
	expect(dome.azimuth.max).toBeCloseTo(TAU)
	expect(dome.moving).toBeFalse()
	expect(dome.slewing).toBeFalse()

	const shutter: DefSwitchVector = {
		device: dome.name,
		name: 'DOME_SHUTTER',
		permission: 'rw',
		rule: 'OneOfMany',
		state: 'Busy',
		elements: { SHUTTER_OPEN: defSwitch('SHUTTER_OPEN', true), SHUTTER_CLOSE: defSwitch('SHUTTER_CLOSE', false) },
	}
	manager.switchVector(recordingClient, shutter, 'defSwitchVector')

	expect(dome.hasShutter).toBeTrue()
	expect(dome.canSetShutter).toBeTrue()
	expect(dome.shutterState).toBe('OPENING')
	expect(dome.slewing).toBeFalse()

	manager.switchVector(recordingClient, { ...shutter, state: 'Ok', elements: { SHUTTER_OPEN: defSwitch('SHUTTER_OPEN', true), SHUTTER_CLOSE: defSwitch('SHUTTER_CLOSE', false) } }, 'setSwitchVector')
	expect(dome.shutterState).toBe('OPEN')
	expect(dome.slewing).toBeFalse()

	const measurements: DefNumberVector = {
		device: dome.name,
		name: 'DOME_MEASUREMENTS',
		permission: 'ro',
		state: 'Ok',
		elements: {
			DOME_RADIUS: defNumber('DOME_RADIUS', 4, 0, 10),
			DOME_SHUTTER_WIDTH: defNumber('DOME_SHUTTER_WIDTH', 1, 0, 10),
			DOME_NORTH_DISPLACEMENT: defNumber('DOME_NORTH_DISPLACEMENT', 2, -10, 10),
			DOME_EAST_DISPLACEMENT: defNumber('DOME_EAST_DISPLACEMENT', 3, -10, 10),
			DOME_UP_DISPLACEMENT: defNumber('DOME_UP_DISPLACEMENT', 5, -10, 10),
			DOME_OTA_OFFSET: defNumber('DOME_OTA_OFFSET', 0.5, -10, 10),
		},
	}
	manager.numberVector(recordingClient, measurements, 'defNumberVector')

	expect(dome.hasMeasurements).toBeTrue()
	expect(dome.measurements).toMatchObject({ radius: 4, shutterWidth: 1, northDisplacement: 2, eastDisplacement: 3, upDisplacement: 5, otaOffset: 0.5 })
})

test('DomeManager sends capability-gated commands in INDI units', () => {
	numberCommands.length = 0
	switchCommands.length = 0

	const manager = new DomeManager()
	const dome = setupDome(manager)
	dome.canSetAzimuth = true
	dome.canSetAltitude = true
	dome.canRelativeMove = true
	dome.canMove = true
	dome.canSync = true
	dome.canFindHome = true
	dome.canPark = true
	dome.canUnpark = true
	dome.canSetPark = true
	dome.canSetShutter = true
	dome.canSlave = true
	dome.canAbort = true
	dome.canSetSpeed = true
	dome.hasBacklash = true
	dome.azimuth.value = PIOVERTWO
	manager.switchVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_AUTOSYNC',
			permission: 'rw',
			rule: 'OneOfMany',
			state: 'Ok',
			elements: { INDI_ENABLED: defSwitch('INDI_ENABLED', false), INDI_DISABLED: defSwitch('INDI_DISABLED', true) },
		},
		'defSwitchVector',
	)

	manager.numberVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_SPEED',
			permission: 'rw',
			state: 'Ok',
			elements: { DOME_SPEED_VALUE: defNumber('DOME_SPEED_VALUE', 2, 0, 10, 0.1) },
		},
		'defNumberVector',
	)
	manager.numberVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_BACKLASH_STEPS',
			permission: 'rw',
			state: 'Ok',
			elements: { DOME_BACKLASH_VALUE: defNumber('DOME_BACKLASH_VALUE', 0, 0, 100, 1) },
		},
		'defNumberVector',
	)
	manager.switchVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_PARK_OPTION',
			permission: 'rw',
			rule: 'AtMostOne',
			state: 'Ok',
			elements: { PARK_CURRENT: defSwitch('PARK_CURRENT', false) },
		},
		'defSwitchVector',
	)

	manager.moveTo(dome, PI * 3)
	manager.moveToAltitude(dome, PI / 6)
	manager.moveBy(dome, -PI / 6)
	manager.syncTo(dome, PIOVERFOUR)
	manager.speed(dome, 2)
	manager.backlashSteps(dome, 12)
	manager.move(dome, 'CLOCKWISE', true)
	manager.home(dome)
	manager.park(dome)
	manager.unpark(dome)
	manager.setPark(dome)
	manager.openShutter(dome)
	manager.closeShutter(dome)
	manager.slave(dome, true)
	manager.stop(dome)

	expect(numberCommands.map(({ name }) => name)).toEqual(['ABS_DOME_POSITION', 'DOME_ALTITUDE', 'REL_DOME_POSITION', 'DOME_SYNC', 'DOME_SPEED', 'DOME_BACKLASH_STEPS'])
	expect(numberCommands[0].elements.DOME_ABSOLUTE_POSITION).toBeCloseTo(180)
	expect(numberCommands[1].elements.DOME_ALTITUDE_VALUE).toBeCloseTo(30)
	expect(numberCommands[2].elements.DOME_RELATIVE_POSITION).toBeCloseTo(-30)
	expect(numberCommands[3].elements.DOME_SYNC_VALUE).toBeCloseTo(45)
	expect(switchCommands.map(({ name }) => name)).toEqual(['DOME_MOTION', 'DOME_GOTO', 'DOME_PARK', 'DOME_PARK', 'DOME_PARK_OPTION', 'DOME_SHUTTER', 'DOME_SHUTTER', 'DOME_AUTOSYNC', 'DOME_ABORT_MOTION'])
})

test('DomeManager preserves driver-specific slaving element names', () => {
	numberCommands.length = 0
	switchCommands.length = 0

	const manager = new DomeManager()
	const dome = setupDome(manager)
	manager.switchVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_AUTOSYNC',
			permission: 'rw',
			rule: 'OneOfMany',
			state: 'Ok',
			elements: { ENABLE: defSwitch('ENABLE', false), DISABLE: defSwitch('DISABLE', true) },
		},
		'defSwitchVector',
	)

	manager.slave(dome, true)
	manager.slave(dome, false)

	expect(switchCommands.map(({ elements }) => elements)).toEqual([{ ENABLE: true }, { DISABLE: true }])
})

test('DomeManager does not complete failed home or park operations', () => {
	const manager = new DomeManager()
	const dome = setupDome(manager)

	manager.switchVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_GOTO',
			permission: 'rw',
			rule: 'OneOfMany',
			state: 'Busy',
			elements: { DOME_HOME: defSwitch('DOME_HOME', true), DOME_PARK: defSwitch('DOME_PARK', false) },
		},
		'defSwitchVector',
	)
	manager.switchVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_GOTO',
			permission: 'rw',
			rule: 'OneOfMany',
			state: 'Alert',
			elements: { DOME_HOME: defSwitch('DOME_HOME', true), DOME_PARK: defSwitch('DOME_PARK', false) },
		},
		'setSwitchVector',
	)

	expect(dome.homing).toBeFalse()
	expect(dome.atHome).toBeFalse()

	manager.switchVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_PARK',
			permission: 'rw',
			rule: 'OneOfMany',
			state: 'Busy',
			elements: { PARK: defSwitch('PARK', true), UNPARK: defSwitch('UNPARK', false) },
		},
		'defSwitchVector',
	)
	manager.switchVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_PARK',
			permission: 'rw',
			rule: 'OneOfMany',
			state: 'Alert',
			elements: { PARK: defSwitch('PARK', true), UNPARK: defSwitch('UNPARK', false) },
		},
		'setSwitchVector',
	)

	expect(dome.parking).toBeFalse()
	expect(dome.parked).toBeFalse()

	manager.switchVector(
		recordingClient,
		{
			device: dome.name,
			name: 'DOME_PARK',
			permission: 'rw',
			rule: 'OneOfMany',
			state: 'Busy',
			elements: { PARK: defSwitch('PARK', false), UNPARK: defSwitch('UNPARK', true) },
		},
		'setSwitchVector',
	)

	expect(dome.parking).toBeFalse()
})

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

describe('del property', () => {
	function setupDevice<D extends Device>(device: D, owner: Client = client) {
		device.id = Bun.randomUUIDv7()
		device.name = device.type
		Object.defineProperty(device, CLIENT, { value: owner })
		return device
	}

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

	test('CameraManager resets deleted INDI properties to defaults', () => {
		const manager = new CameraManager()
		const device = setupDevice(structuredClone(DEFAULT_CAMERA))

		manager.add(device)

		device.frameFormats = [{ name: 'FITS', label: 'FITS' }]
		device.frameFormat = 'FITS'
		device.frame.width.max = 1280
		device.gain.max = 300
		device.gain.value = 60
		device.exposure.max = 3600
		device.exposure.value = 10
		device.exposuring = true

		manager.delProperty(client, { device: device.name, name: 'CCD_CAPTURE_FORMAT' })
		manager.delProperty(client, { device: device.name, name: 'CCD_FRAME' })
		manager.delProperty(client, { device: device.name, name: 'CCD_GAIN' })
		manager.delProperty(client, { device: device.name, name: 'CCD_EXPOSURE' })

		expect(device.frameFormats).toEqual(DEFAULT_CAMERA.frameFormats)
		expect(device.frameFormat).toBe(DEFAULT_CAMERA.frameFormat)
		expect(device.frame).toEqual(DEFAULT_CAMERA.frame)
		expect(device.gain).toEqual(DEFAULT_CAMERA.gain)
		expect(device.exposure).toEqual(DEFAULT_CAMERA.exposure)
		expect(device.exposuring).toBe(DEFAULT_CAMERA.exposuring)
	})

	test('MountManager resets deleted INDI properties to defaults', () => {
		const manager = new MountManager()
		const device = setupDevice(structuredClone(DEFAULT_MOUNT))

		manager.add(device)

		device.slewRates = [{ name: '4x', label: '4x' }]
		device.slewRate = '4x'
		device.trackModes = ['SIDEREAL', 'SOLAR']
		device.trackMode = 'SOLAR'
		device.pierSide = 'WEST'
		device.hasPierSide = true
		device.canPark = true
		device.parking = true
		device.parked = true
		device.equatorialCoordinate.rightAscension = 1
		device.time.utc = 1

		manager.delProperty(client, { device: device.name, name: 'TELESCOPE_SLEW_RATE' })
		manager.delProperty(client, { device: device.name, name: 'TELESCOPE_TRACK_MODE' })
		manager.delProperty(client, { device: device.name, name: 'TELESCOPE_PIER_SIDE' })
		manager.delProperty(client, { device: device.name, name: 'TELESCOPE_PARK' })
		manager.delProperty(client, { device: device.name, name: 'EQUATORIAL_EOD_COORD' })
		manager.delProperty(client, { device: device.name, name: 'TIME_UTC' })

		expect(device.slewRates).toEqual(DEFAULT_MOUNT.slewRates)
		expect(device.slewRate).toBeUndefined()
		expect(device.trackModes).toEqual(DEFAULT_MOUNT.trackModes)
		expect(device.trackMode === DEFAULT_MOUNT.trackMode).toBeTrue()
		expect(device.pierSide === DEFAULT_MOUNT.pierSide).toBeTrue()
		expect(device.hasPierSide).toBe(DEFAULT_MOUNT.hasPierSide)
		expect(device.canPark).toBe(DEFAULT_MOUNT.canPark)
		expect(device.parking).toBe(DEFAULT_MOUNT.parking)
		expect(device.parked).toBe(DEFAULT_MOUNT.parked)
		expect(device.equatorialCoordinate).toEqual(DEFAULT_MOUNT.equatorialCoordinate)
		expect(device.time).toEqual(DEFAULT_MOUNT.time)
	})

	test('device managers reset deleted device-specific properties to defaults', () => {
		const wheelManager = new WheelManager()
		const wheel = setupDevice<Wheel>(structuredClone(DEFAULT_WHEEL))
		wheelManager.add(wheel)
		wheel.count = 8
		wheel.names = ['L']
		wheel.position = 3
		wheel.moving = true
		wheel.canSetNames = false
		wheelManager.delProperty(client, { device: wheel.name, name: 'FILTER_SLOT' })
		wheelManager.delProperty(client, { device: wheel.name, name: 'FILTER_NAME' })

		const focuserManager = new FocuserManager()
		const focuser = setupDevice<Focuser>(structuredClone(DEFAULT_FOCUSER))
		focuserManager.add(focuser)
		focuser.canAbsoluteMove = true
		focuser.moving = true
		focuser.position.max = 100000
		focuserManager.delProperty(client, { device: focuser.name, name: 'ABS_FOCUS_POSITION' })

		const coverManager = new CoverManager()
		const cover = setupDevice<Cover>(structuredClone(DEFAULT_COVER))
		coverManager.add(cover)
		cover.canAbort = true
		coverManager.delProperty(client, { device: cover.name, name: 'CAP_ABORT' })

		const flatPanelManager = new FlatPanelManager()
		const flatPanel = setupDevice<FlatPanel>(structuredClone(DEFAULT_FLAT_PANEL))
		flatPanelManager.add(flatPanel)
		flatPanel.enabled = true
		flatPanel.intensity.max = 255
		flatPanelManager.delProperty(client, { device: flatPanel.name, name: 'FLAT_LIGHT_CONTROL' })
		flatPanelManager.delProperty(client, { device: flatPanel.name, name: 'FLAT_LIGHT_INTENSITY' })

		const rotatorManager = new RotatorManager()
		const rotator = setupDevice<Rotator>(structuredClone(DEFAULT_ROTATOR))
		rotatorManager.add(rotator)
		rotator.canReverse = true
		rotator.reversed = true
		rotator.angle.max = 360
		rotatorManager.delProperty(client, { device: rotator.name, name: 'ROTATOR_REVERSE' })
		rotatorManager.delProperty(client, { device: rotator.name, name: 'ABS_ROTATOR_ANGLE' })

		const powerManager = new PowerManager()
		const power = setupDevice<Power>(structuredClone(DEFAULT_POWER))
		powerManager.add(power)
		power.dc = [{ type: 'dc', name: 'DC1', label: 'DC1', enabled: true, value: 1, min: 0, max: 10, step: 1 }]
		power.hasPowerCycle = true
		power.voltage.max = 20
		powerManager.delProperty(client, { device: power.name, name: 'POWER_CHANNELS' })
		powerManager.delProperty(client, { device: power.name, name: 'POWER_CYCLE_Toggle' })
		powerManager.delProperty(client, { device: power.name, name: 'POWER_SENSORS' })

		expect(wheel).toMatchObject({ count: DEFAULT_WHEEL.count, names: DEFAULT_WHEEL.names, position: DEFAULT_WHEEL.position, moving: DEFAULT_WHEEL.moving, canSetNames: DEFAULT_WHEEL.canSetNames })
		expect(focuser).toMatchObject({ canAbsoluteMove: DEFAULT_FOCUSER.canAbsoluteMove, moving: DEFAULT_FOCUSER.moving })
		expect(focuser.position).toEqual(DEFAULT_FOCUSER.position)
		expect(cover.canAbort).toBe(DEFAULT_COVER.canAbort)
		expect(flatPanel.enabled).toBe(DEFAULT_FLAT_PANEL.enabled)
		expect(flatPanel.intensity).toEqual(DEFAULT_FLAT_PANEL.intensity)
		expect(rotator).toMatchObject({ canReverse: DEFAULT_ROTATOR.canReverse, reversed: DEFAULT_ROTATOR.reversed })
		expect(rotator.angle).toEqual(DEFAULT_ROTATOR.angle)
		expect(power.dc).toEqual(DEFAULT_POWER.dc)
		expect(power.hasPowerCycle).toBe(DEFAULT_POWER.hasPowerCycle)
		expect(power.voltage).toEqual(DEFAULT_POWER.voltage)
	})
})

function weatherDevice(manager: WeatherManager, name: string = 'Weather', interfaceType: DeviceInterfaceType = DeviceInterfaceType.WEATHER) {
	manager.textVector(recordingClient, driverInfo(name, interfaceType), 'defTextVector')
	return manager.get(recordingClient, name)!
}

function weatherParameters(device: string, elements: Record<string, DefNumber>): DefNumberVector {
	return { device, name: 'WEATHER_PARAMETERS', permission: 'ro', state: 'Ok', elements }
}

describe('WeatherManager', () => {
	test('creates the device from the interface bit alone, before any parameter', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		expect(weather).toBeDefined()
		expect(weather.type).toBe('weather')
		expect(isWeather(weather)).toBeTrue()
		expect(weather.interfaces).toEqual(['weather'])
		expect(manager.properties.get(weather)?.WEATHER_PARAMETERS).toBeUndefined()
		expect(weather).not.toContainKey('cloudCover')
		expect(manager.lastUpdatedAt(weather)).toBeUndefined()
	})

	test('reports weather alongside the other interfaces of a multi-interface driver', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager, 'Station', DeviceInterfaceType.WEATHER | DeviceInterfaceType.DOME)

		expect(weather.interfaces).toEqual(['dome', 'weather'])
		expect(weather.hardwareId).toBe(Bun.MD5.hash(`${recordingClient.id}:Station`, 'hex'))
	})

	test('maps every sensor and leaves unreported ones absent', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		manager.numberVector(
			recordingClient,
			weatherParameters(weather.name, {
				WEATHER_CLOUD_COVER: defNumber('WEATHER_CLOUD_COVER', 42, 0, 100),
				WEATHER_DEW_POINT: defNumber('WEATHER_DEW_POINT', 4.5, -60, 60),
				WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 61, 0, 100),
				WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1008.4, 0, 2000),
				WEATHER_RAIN_HOUR: defNumber('WEATHER_RAIN_HOUR', 1.5, 0, 500),
				WEATHER_SKY_BRIGHTNESS: defNumber('WEATHER_SKY_BRIGHTNESS', 0.01, 0, 1000),
				WEATHER_SKY_QUALITY: defNumber('WEATHER_SKY_QUALITY', 20.8, 0, 25),
				WEATHER_SKY_TEMPERATURE: defNumber('WEATHER_SKY_TEMPERATURE', -18.2, -100, 60),
				WEATHER_STAR_FWHM: defNumber('WEATHER_STAR_FWHM', 3.1, 0, 60),
				WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 12.25, -60, 60),
				WEATHER_WIND_GUST: defNumber('WEATHER_WIND_GUST', 9.4, 0, 100),
				WEATHER_WIND_SPEED: defNumber('WEATHER_WIND_SPEED', 5.2, 0, 100),
			}),
			'defNumberVector',
		)

		expect(weather.cloudCover).toBe(42)
		expect(weather.dewPoint).toBe(4.5)
		expect(weather.humidity).toBe(61)
		expect(weather.pressure).toBe(1008.4)
		expect(weather.rainRate).toBe(1.5)
		expect(weather.skyBrightness).toBe(0.01)
		expect(weather.skyQuality).toBe(20.8)
		expect(weather.skyTemperature).toBe(-18.2)
		expect(weather.starFWHM).toBe(3.1)
		expect(weather.temperature).toBe(12.25)
		expect(weather.hasThermometer).toBeTrue()
		expect(weather.windGust).toBe(9.4)
		expect(weather.windSpeed).toBe(5.2)

		// Not reported by this driver.
		expect(weather).not.toContainKey('windDirection')
	})

	test('accepts the alias element names used by common drivers', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		const parameters = weatherParameters(weather.name, {
			WEATHER_CLOUD: defNumber('WEATHER_CLOUD', 33, 0, 100),
			WEATHER_DEWPOINT: defNumber('WEATHER_DEWPOINT', 2.5, -60, 60),
			WEATHER_RELATIVE_HUMIDITY: defNumber('WEATHER_RELATIVE_HUMIDITY', 70, 0, 100),
			WEATHER_RAIN_RATE: defNumber('WEATHER_RAIN_RATE', 12, 0, 500),
			WEATHER_SQM: defNumber('WEATHER_SQM', 19.5, 0, 25),
			WEATHER_SEEING: defNumber('WEATHER_SEEING', 4.2, 0, 60),
			WEATHER_UNMAPPED: defNumber('WEATHER_UNMAPPED', 7, 0, 100),
		})

		manager.vector(recordingClient, parameters, 'defNumberVector')
		manager.numberVector(recordingClient, parameters, 'defNumberVector')

		expect(weather.cloudCover).toBe(33)
		expect(weather.dewPoint).toBe(2.5)
		expect(weather.humidity).toBe(70)
		expect(weather.rainRate).toBe(12)
		expect(weather.skyQuality).toBe(19.5)
		expect(weather.starFWHM).toBe(4.2)

		// An unmapped element stays reachable as a raw property but never reaches the typed interface.
		expect(manager.properties.get(weather)!.WEATHER_PARAMETERS.elements.WEATHER_UNMAPPED.value).toBe(7)
	})

	test('converts wind direction from degrees to normalized radians', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_WIND_DIRECTION: defNumber('WEATHER_WIND_DIRECTION', 90) }), 'defNumberVector')
		expect(weather.windDirection).toBeCloseTo(PIOVERTWO, 12)

		manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_WIND_DIRECTION: defNumber('WEATHER_WIND_DIRECTION', 360) }), 'setNumberVector')
		expect(weather.windDirection).toBe(0)

		manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_WIND_DIRECTION: defNumber('WEATHER_WIND_DIRECTION', -90) }), 'setNumberVector')
		expect(weather.windDirection).toBeCloseTo(TAU - PIOVERTWO, 12)
	})

	test('never clamps a reading to the alarm thresholds carried by min/max', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		// INDI addParameter(name, label, min, max, percentWarning): min/max are the alarm limits, so a
		// reading outside them is exactly the one that must survive intact.
		manager.numberVector(
			recordingClient,
			weatherParameters(weather.name, {
				WEATHER_WIND_SPEED: defNumber('WEATHER_WIND_SPEED', 34.5, 0, 20),
				WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', -12, 0, 40),
			}),
			'defNumberVector',
		)

		expect(weather.windSpeed).toBe(34.5)
		expect(weather.temperature).toBe(-12)
	})

	test('notifies only the field that changed', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)
		const updates: string[] = []

		manager.addHandler({ added: () => {}, removed: () => {}, updated: (_, property) => updates.push(property) })

		manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 50, 0, 100), WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1000, 0, 2000) }), 'defNumberVector')
		expect(updates).toEqual(['humidity', 'pressure'])

		updates.length = 0
		manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 50, 0, 100), WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1001, 0, 2000) }), 'setNumberVector')
		expect(updates).toEqual(['pressure'])
	})

	test('ignores the placeholder values of a Busy definition', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		// The Firmata adapter defines its weather vector Busy with zero placeholders before the first
		// hardware reply, then settles it to Idle on the first real sample.
		const placeholders = weatherParameters(weather.name, {
			WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 0, -55, 125),
			WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 0, 0, 100),
			WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 0, 0, 2000),
		})

		placeholders.state = 'Busy'
		manager.numberVector(recordingClient, placeholders, 'defNumberVector')

		expect(weather).not.toContainKey('humidity')
		expect(weather).not.toContainKey('pressure')
		expect(weather.hasThermometer).toBeFalse()
		expect(manager.updatedAt(weather, 'temperature')).toBeUndefined()
		expect(manager.lastUpdatedAt(weather)).toBeUndefined()

		const readings = weatherParameters(weather.name, {
			WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 21.5, -55, 125),
			WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 47, 0, 100),
			WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1011.8, 0, 2000),
		})

		readings.state = 'Idle'
		manager.numberVector(recordingClient, readings, 'setNumberVector')

		expect(weather.temperature).toBe(21.5)
		expect(weather.humidity).toBe(47)
		expect(weather.pressure).toBe(1011.8)
		expect(weather.hasThermometer).toBeTrue()
		expect(manager.updatedAt(weather, 'temperature')).toBeGreaterThan(0)
	})

	test('advances freshness even when the driver repeats a value', async () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)
		const parameters = weatherParameters(weather.name, { WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 10, -60, 60) })

		manager.numberVector(recordingClient, parameters, 'defNumberVector')
		const first = manager.updatedAt(weather, 'temperature')!
		expect(first).toBeGreaterThan(0)
		expect(manager.updatedAt(weather, 'humidity')).toBeUndefined()
		expect(manager.lastUpdatedAt(weather)).toBe(first)

		await Bun.sleep(5)
		manager.numberVector(recordingClient, parameters, 'setNumberVector')

		expect(weather.temperature).toBe(10)
		expect(manager.updatedAt(weather, 'temperature')!).toBeGreaterThan(first)
	})

	test('accepts a partial parameter vector from an auxiliary sensor board', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager, 'Sensor', DeviceInterfaceType.WEATHER | DeviceInterfaceType.AUXILIARY)

		manager.numberVector(
			recordingClient,
			weatherParameters(weather.name, {
				WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 21.5, -55, 125),
				WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 44.5, 0, 100),
				WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1002.25, 0, 2000),
			}),
			'defNumberVector',
		)

		expect(weather.interfaces).toEqual(['weather'])
		expect(weather.temperature).toBe(21.5)
		expect(weather.hasThermometer).toBeTrue()
		expect(weather.humidity).toBe(44.5)
		expect(weather.pressure).toBe(1002.25)
		expect(weather).not.toContainKey('windSpeed')
	})

	test('reflects and commands the update and average periods', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		expect(weather.updatePeriod).toBeUndefined()
		expect(manager.setUpdatePeriod(weather, 30)).toBeFalse()
		expect(manager.setAveragePeriod(weather, 1)).toBeFalse()

		manager.numberVector(recordingClient, { device: weather.name, name: 'WEATHER_UPDATE', permission: 'rw', state: 'Ok', elements: { PERIOD: defNumber('PERIOD', 60, 1, 3600) } }, 'defNumberVector')
		expect(weather.updatePeriod).toEqual({ value: 60, min: 1, max: 3600, step: 1 })

		manager.numberVector(recordingClient, { device: weather.name, name: 'WEATHER_AVERAGE_PERIOD', permission: 'rw', state: 'Ok', elements: { AVERAGE_PERIOD: defNumber('AVERAGE_PERIOD', 0.5, 0, 24) } }, 'defNumberVector')
		expect(weather.averagePeriod).toBe(0.5)

		numberCommands.length = 0
		expect(manager.setUpdatePeriod(weather, 30)).toBeTrue()
		expect(manager.setAveragePeriod(weather, 2)).toBeTrue()
		expect(numberCommands).toEqual([
			{ device: weather.name, name: 'WEATHER_UPDATE', elements: { PERIOD: 30 } },
			{ device: weather.name, name: 'WEATHER_AVERAGE_PERIOD', elements: { AVERAGE_PERIOD: 2 } },
		])

		// A read-only redefinition withdraws the command.
		manager.numberVector(recordingClient, { device: weather.name, name: 'WEATHER_UPDATE', permission: 'ro', state: 'Ok', elements: { PERIOD: defNumber('PERIOD', 60, 1, 3600) } }, 'defNumberVector')
		expect(manager.setUpdatePeriod(weather, 30)).toBeFalse()
	})

	test('commands refresh only when the driver offers a writable switch', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		expect(manager.refresh(weather)).toBeFalse()

		manager.switchVector(recordingClient, { device: weather.name, name: 'WEATHER_REFRESH', permission: 'rw', rule: 'AtMostOne', state: 'Idle', elements: { REFRESH: defSwitch('REFRESH', false) } }, 'defSwitchVector')

		switchCommands.length = 0
		expect(manager.refresh(weather)).toBeTrue()
		expect(switchCommands).toEqual([{ device: weather.name, name: 'WEATHER_REFRESH', elements: { REFRESH: true } }])
	})

	test('clears the sensors on a named deletion but keeps the device', () => {
		const manager = new WeatherManager()
		const weather = weatherDevice(manager)

		manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 9, -60, 60), WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 80, 0, 100) }), 'defNumberVector')
		manager.numberVector(recordingClient, { device: weather.name, name: 'WEATHER_UPDATE', permission: 'rw', state: 'Ok', elements: { PERIOD: defNumber('PERIOD', 60, 1, 3600) } }, 'defNumberVector')

		manager.delProperty(recordingClient, { device: weather.name, name: 'WEATHER_PARAMETERS' })

		expect(manager.has(recordingClient, weather.name)).toBeTrue()
		expect(weather.humidity).toBeUndefined()
		expect(weather.temperature).toBe(DEFAULT_WEATHER.temperature)
		expect(weather.hasThermometer).toBeFalse()
		expect(manager.lastUpdatedAt(weather)).toBeUndefined()
		expect(weather.updatePeriod).toBeDefined()

		manager.delProperty(recordingClient, { device: weather.name, name: 'WEATHER_UPDATE' })
		expect(weather.updatePeriod).toBeUndefined()
		expect(manager.setUpdatePeriod(weather, 30)).toBeFalse()

		manager.delProperty(recordingClient, { device: weather.name })
		expect(manager.has(recordingClient, weather.name)).toBeFalse()
	})

	test('does not turn a weather status light into a safety monitor', () => {
		const manager = new WeatherManager()
		const safetyManager = new SafetyMonitorManager(manager)
		const weather = weatherDevice(manager)

		const status: DefLightVector = { device: weather.name, name: 'WEATHER_STATUS', state: 'Alert', elements: { WEATHER_TEMPERATURE: { name: 'WEATHER_TEMPERATURE', value: 'Alert' } } }
		safetyManager.lightVector(recordingClient, status, 'defLightVector')

		expect(safetyManager.get(recordingClient, weather.name)).toBeUndefined()
		expect(weather).not.toContainKey('safe')
	})
})
