import { expect, describe, test } from 'bun:test'
// oxfmt-ignore
import { CLIENT, type Client, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_DOME, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_WHEEL, type Cover, type Device, type Dome, type FlatPanel, type Focuser, type Power, type Rotator, type Wheel, DeviceInterfaceType, type Camera, isDome } from '../../../src/devices/indi/device'
import { CameraManager, CoverManager, DomeManager, FlatPanelManager, FocuserManager, MountManager, PowerManager, RotatorManager, WheelManager } from '../../../src/devices/indi/manager'
import type { DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefText, DefTextVector } from '../../../src/devices/indi/types'

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

test('manager sets all combinated types from interface bitmask', () => {
	const manager = new CameraManager()
	const DRIVER_INTERFACE: DefText = { name: 'DRIVER_INTERFACE', value: (DeviceInterfaceType.CCD | DeviceInterfaceType.TELESCOPE).toFixed(0) }
	const message: DefTextVector = { device: 'Camera', name: 'DRIVER_INFO', permission: 'ro', state: 'Ok', elements: { DRIVER_INTERFACE } }
	manager.textVector(client, message, 'defTextVector')
	const camera = manager.get(client, 'Camera')

	expect(camera).toBeDefined()
	expect(camera!.interfaces).toEqual(['camera', 'mount'])
})

test('dome defaults expose a disconnected, capability-free model', () => {
	const dome = structuredClone(DEFAULT_DOME)

	expect(dome.type).toBe('dome')
	expect(dome.connected).toBeFalse()
	expect(dome.slewing).toBeFalse()
	expect(dome.parked).toBeFalse()
	expect(dome.shutterState).toBe('UNKNOWN')
	expect(dome.measurements.otaSide).toBe('UNKNOWN')
	expect(isDome(dome)).toBeTrue()
	expect(isDome(DEFAULT_CAMERA)).toBeFalse()
	expect(dome).toEqual(DEFAULT_DOME)
})

test('dome interface bit is discovered as a dome device type', () => {
	const manager = new CameraManager()
	const DRIVER_INTERFACE: DefText = { name: 'DRIVER_INTERFACE', value: (DeviceInterfaceType.CCD | DeviceInterfaceType.DOME).toFixed(0) }
	const message: DefTextVector = { device: 'Camera', name: 'DRIVER_INFO', permission: 'ro', state: 'Ok', elements: { DRIVER_INTERFACE } }
	manager.textVector(client, message, 'defTextVector')

	expect(manager.get(client, 'Camera')!.interfaces).toEqual(['camera', 'dome'])
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
	expect(dome.azimuth.value).toBeCloseTo(Math.PI / 2)
	expect(dome.azimuth.min).toBe(0)
	expect(dome.azimuth.max).toBeCloseTo(Math.PI * 2)
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
	expect(dome.slewing).toBeTrue()

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
	dome.azimuth.value = Math.PI / 2

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

	manager.moveTo(dome, Math.PI * 3)
	manager.moveBy(dome, -Math.PI / 6)
	manager.syncTo(dome, Math.PI / 4)
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

	expect(numberCommands.map(({ name }) => name)).toEqual(['ABS_DOME_POSITION', 'REL_DOME_POSITION', 'DOME_SYNC', 'DOME_SPEED', 'DOME_BACKLASH_STEPS'])
	expect(numberCommands[0].elements.DOME_ABSOLUTE_POSITION).toBeCloseTo(180)
	expect(numberCommands[1].elements.DOME_RELATIVE_POSITION).toBeCloseTo(-30)
	expect(numberCommands[2].elements.DOME_SYNC_VALUE).toBeCloseTo(45)
	expect(switchCommands.map(({ name }) => name)).toEqual(['DOME_MOTION', 'DOME_GOTO', 'DOME_PARK', 'DOME_PARK', 'DOME_PARK_OPTION', 'DOME_SHUTTER', 'DOME_SHUTTER', 'DOME_AUTOSYNC', 'DOME_ABORT_MOTION'])
})

test('manager sets the combinated type after interface bitmask be updated', () => {
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
