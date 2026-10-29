import { expect, test } from 'bun:test'
import { CLIENT, DEFAULT_FOCUSER, type Focuser } from '../../../../src/devices/indi/device'
import { FocuserManager } from '../../../../src/devices/indi/manager/focuser'
import type { PropertyState } from '../../../../src/devices/indi/types'
import { createRecordingClient, defNumber, defSwitch } from './util'

const { recordingClient, numberCommands, switchCommands } = createRecordingClient()

function setupFocuser(manager: FocuserManager) {
	const focuser = structuredClone(DEFAULT_FOCUSER)
	focuser.id = Bun.randomUUIDv7()
	focuser.name = 'Focuser'
	focuser.connected = true
	Object.defineProperty(focuser, CLIENT, { value: recordingClient })
	manager.add(focuser)
	return focuser
}

test('FocuserManager reads the backlash compensation of the driver', () => {
	const manager = new FocuserManager()
	const focuser = setupFocuser(manager)
	const updates: string[] = []
	manager.addHandler({ added() {}, updated: (_, property) => updates.push(property), removed() {} })

	manager.switchVector(recordingClient, { device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE', permission: 'rw', rule: 'OneOfMany', state: 'Ok', elements: { INDI_ENABLED: defSwitch('INDI_ENABLED', false), INDI_DISABLED: defSwitch('INDI_DISABLED', true) } }, 'defSwitchVector')
	manager.numberVector(recordingClient, { device: focuser.name, name: 'FOCUS_BACKLASH_STEPS', permission: 'rw', state: 'Ok', elements: { FOCUS_BACKLASH_VALUE: defNumber('FOCUS_BACKLASH_VALUE', 40, 0, 1000) } }, 'defNumberVector')

	expect(focuser.hasBacklash).toBeTrue()
	expect(focuser.backlashEnabled).toBeFalse()
	expect(focuser.backlash).toMatchObject({ value: 40, min: 0, max: 1000 })

	manager.switchVector(recordingClient, { device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE', state: 'Ok', elements: { INDI_ENABLED: { name: 'INDI_ENABLED', value: true }, INDI_DISABLED: { name: 'INDI_DISABLED', value: false } } }, 'setSwitchVector')
	manager.numberVector(recordingClient, { device: focuser.name, name: 'FOCUS_BACKLASH_STEPS', state: 'Ok', elements: { FOCUS_BACKLASH_VALUE: { name: 'FOCUS_BACKLASH_VALUE', value: 75 } } }, 'setNumberVector')

	expect(focuser.backlashEnabled).toBeTrue()
	expect(focuser.backlash.value).toBe(75)
	expect(updates).toEqual(['hasBacklash', 'backlash', 'backlashEnabled', 'backlash'])
	expect(numberCommands).toBeEmpty()
	expect(switchCommands).toBeEmpty()

	manager.backlash(focuser, false)
	manager.backlash(focuser, true)
	expect(switchCommands).toEqual([
		{ device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE', elements: { INDI_DISABLED: true } },
		{ device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE', elements: { INDI_ENABLED: true } },
	])
	switchCommands.length = 0

	manager.delProperty(recordingClient, { device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE' })
	manager.delProperty(recordingClient, { device: focuser.name, name: 'FOCUS_BACKLASH_STEPS' })

	expect(focuser.hasBacklash).toBeFalse()
	expect(focuser.backlashEnabled).toBeFalse()
	expect(focuser.backlash).toEqual(DEFAULT_FOCUSER.backlash)
})

test('FocuserManager reports a read-only driver backlash as enabled and never switches it', () => {
	const manager = new FocuserManager()
	const focuser = setupFocuser(manager)

	manager.switchVector(recordingClient, { device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE', permission: 'ro', rule: 'OneOfMany', state: 'Ok', elements: { INDI_ENABLED: defSwitch('INDI_ENABLED', true), INDI_DISABLED: defSwitch('INDI_DISABLED', false) } }, 'defSwitchVector')

	expect(focuser.hasBacklash).toBeFalse()
	expect(focuser.backlashEnabled).toBeTrue()

	manager.backlash(focuser, false)
	expect(switchCommands).toBeEmpty()
})

function clearCommands() {
	numberCommands.length = 0
	switchCommands.length = 0
}

function defineAbsolute(manager: FocuserManager, focuser: Focuser, value = 500, max = 1000) {
	manager.numberVector(recordingClient, { device: focuser.name, name: 'ABS_FOCUS_POSITION', permission: 'rw', state: 'Idle', elements: { FOCUS_ABSOLUTE_POSITION: defNumber('FOCUS_ABSOLUTE_POSITION', value, 0, max) } }, 'defNumberVector')
}

function defineRelative(manager: FocuserManager, focuser: Focuser) {
	manager.numberVector(recordingClient, { device: focuser.name, name: 'REL_FOCUS_POSITION', permission: 'rw', state: 'Idle', elements: { FOCUS_RELATIVE_POSITION: defNumber('FOCUS_RELATIVE_POSITION', 0, 0, 10000) } }, 'defNumberVector')
}

function setRelative(manager: FocuserManager, focuser: Focuser, state: PropertyState) {
	manager.numberVector(recordingClient, { device: focuser.name, name: 'REL_FOCUS_POSITION', state, elements: { FOCUS_RELATIVE_POSITION: { name: 'FOCUS_RELATIVE_POSITION', value: 0 } } }, 'setNumberVector')
}

test('FocuserManager sends relative moves of an absolute-only focuser as absolute targets', () => {
	const manager = new FocuserManager()
	const focuser = setupFocuser(manager)
	clearCommands()

	defineAbsolute(manager, focuser)

	expect(focuser).toMatchObject({ canAbsoluteMove: true, canRelativeMove: true, emulatedAbsoluteMove: false, emulatedRelativeMove: true, canSync: false })

	manager.moveIn(focuser, 100)
	manager.moveOut(focuser, 100)
	// Targets beyond the range are clamped to it.
	manager.moveIn(focuser, 800)
	manager.moveOut(focuser, 800)

	expect(numberCommands.map((command) => command.elements.FOCUS_ABSOLUTE_POSITION)).toEqual([400, 600, 0, 1000])
	expect(numberCommands.every((command) => command.name === 'ABS_FOCUS_POSITION')).toBeTrue()
	expect(switchCommands).toBeEmpty()
})

test('FocuserManager keeps a virtual position for a relative-only focuser', () => {
	const manager = new FocuserManager(undefined, { virtualRange: 1000 })
	const focuser = setupFocuser(manager)
	const updates: string[] = []
	clearCommands()

	defineRelative(manager, focuser)
	manager.switchVector(recordingClient, { device: focuser.name, name: 'FOCUS_ABORT_MOTION', permission: 'rw', rule: 'AtMostOne', state: 'Idle', elements: { ABORT: defSwitch('ABORT', false) } }, 'defSwitchVector')

	expect(focuser).toMatchObject({ canAbsoluteMove: true, canRelativeMove: true, emulatedAbsoluteMove: true, emulatedRelativeMove: false, canSync: true })
	expect(focuser.position).toEqual({ value: 1000, min: 0, max: 2000, step: 1 })

	manager.addHandler({ added() {}, updated: (_, property) => updates.push(property), removed() {} })

	// An absolute move is commanded as the relative move that reaches it, and applied once the driver finishes it.
	manager.moveTo(focuser, 1200)
	expect(switchCommands).toEqual([{ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_OUTWARD: true } }])
	expect(numberCommands).toEqual([{ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: 200 } }])
	setRelative(manager, focuser, 'Busy')
	expect(focuser.moving).toBeTrue()
	expect(focuser.position.value).toBe(1000)
	setRelative(manager, focuser, 'Ok')
	expect(focuser.moving).toBeFalse()
	expect(focuser.position.value).toBe(1200)
	expect(updates).toEqual(['moving', 'position', 'moving'])
	clearCommands()

	// Idle after Busy also finishes a move, as an Alpaca focuser reports it.
	manager.moveIn(focuser, 300)
	expect(switchCommands).toEqual([{ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_INWARD: true } }])
	expect(numberCommands).toEqual([{ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: 300 } }])
	setRelative(manager, focuser, 'Idle')
	expect(focuser.position.value).toBe(1200)
	setRelative(manager, focuser, 'Busy')
	setRelative(manager, focuser, 'Idle')
	expect(focuser.position.value).toBe(900)

	// A move the driver refuses leaves the position, and a later Ok without a pending move changes nothing.
	manager.moveOut(focuser, 50)
	setRelative(manager, focuser, 'Alert')
	setRelative(manager, focuser, 'Ok')
	expect(focuser.position.value).toBe(900)
	clearCommands()

	// A move beyond the virtual range is commanded only up to its end.
	manager.moveIn(focuser, 5000)
	expect(numberCommands).toEqual([{ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: 900 } }])
	setRelative(manager, focuser, 'Ok')
	expect(focuser.position.value).toBe(0)
	clearCommands()

	// A target already reached and a sync send nothing; the sync redefines the virtual position.
	manager.moveTo(focuser, 0)
	manager.syncTo(focuser, 1500)
	expect(numberCommands).toBeEmpty()
	expect(switchCommands).toBeEmpty()
	expect(focuser.position.value).toBe(1500)

	// An aborted move travelled an unknown distance and leaves the position where it started.
	manager.moveOut(focuser, 100)
	setRelative(manager, focuser, 'Busy')
	manager.stop(focuser)
	setRelative(manager, focuser, 'Idle')
	expect(switchCommands.at(-1)).toEqual({ device: focuser.name, name: 'FOCUS_ABORT_MOTION', elements: { ABORT: true } })
	expect(focuser.position.value).toBe(1500)
	expect(focuser.moving).toBeFalse()
})

test('FocuserManager uses the native moves when the driver publishes both', () => {
	const manager = new FocuserManager()
	const focuser = setupFocuser(manager)
	clearCommands()

	// A driver defining the relative vector first starts emulated until the absolute one arrives.
	defineRelative(manager, focuser)
	expect(focuser.emulatedAbsoluteMove).toBeTrue()
	expect(focuser.position).toEqual({ value: 50000, min: 0, max: 100000, step: 1 })

	defineAbsolute(manager, focuser)
	expect(focuser).toMatchObject({ canAbsoluteMove: true, canRelativeMove: true, emulatedAbsoluteMove: false, emulatedRelativeMove: false, canSync: false })
	expect(focuser.position).toMatchObject({ value: 500, min: 0, max: 1000 })

	manager.moveIn(focuser, 100)
	manager.moveTo(focuser, 700)
	manager.syncTo(focuser, 600)
	expect(switchCommands).toEqual([{ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_INWARD: true } }])
	expect(numberCommands).toEqual([
		{ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: 100 } },
		{ device: focuser.name, name: 'ABS_FOCUS_POSITION', elements: { FOCUS_ABSOLUTE_POSITION: 700 } },
	])

	// Losing the absolute vector falls back to a virtual position, and losing both to no move at all.
	manager.delProperty(recordingClient, { device: focuser.name, name: 'ABS_FOCUS_POSITION' })
	expect(focuser).toMatchObject({ canAbsoluteMove: true, canRelativeMove: true, emulatedAbsoluteMove: true, canSync: true })
	expect(focuser.position).toEqual({ value: 50000, min: 0, max: 100000, step: 1 })

	manager.delProperty(recordingClient, { device: focuser.name, name: 'REL_FOCUS_POSITION' })
	expect(focuser).toMatchObject({ canAbsoluteMove: false, canRelativeMove: false, emulatedAbsoluteMove: false, emulatedRelativeMove: false, canSync: false })
	expect(focuser.position).toEqual(DEFAULT_FOCUSER.position)
})
