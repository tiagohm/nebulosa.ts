import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO, TAU } from '../../../../src/core/constants'
import { CLIENT, DEFAULT_DOME, DeviceInterfaceType, isDome } from '../../../../src/devices/indi/device'
import { DomeManager } from '../../../../src/devices/indi/manager/dome'
import type { DefNumberVector, DefSwitchVector, DefText, DefTextVector } from '../../../../src/devices/indi/types'
import { client, createRecordingClient, defNumber, defSwitch } from './util'

const { recordingClient, numberCommands, switchCommands } = createRecordingClient()

function setupDome(manager: DomeManager) {
	const dome = structuredClone(DEFAULT_DOME)
	dome.id = Bun.randomUUIDv7()
	dome.name = 'Dome'
	Object.defineProperty(dome, CLIENT, { value: recordingClient })
	manager.add(dome)
	return dome
}

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
