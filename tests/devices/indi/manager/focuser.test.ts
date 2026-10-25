import { expect, test } from 'bun:test'
import { CLIENT, DEFAULT_FOCUSER } from '../../../../src/devices/indi/device'
import { FocuserManager } from '../../../../src/devices/indi/manager/focuser'
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
