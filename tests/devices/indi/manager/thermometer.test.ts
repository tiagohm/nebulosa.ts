import { expect, test } from 'bun:test'
import { DEFAULT_CAMERA, DEFAULT_FOCUSER } from '../../../../src/devices/indi/device'
import { CameraManager } from '../../../../src/devices/indi/manager/camera'
import { FocuserManager } from '../../../../src/devices/indi/manager/focuser'
import { ThermometerManager } from '../../../../src/devices/indi/manager/thermometer'
import type { DefNumberVector } from '../../../../src/devices/indi/types'
import { createRecordingClient, defNumber, setupDevice } from './util'

function temperatureVector(device: string, name: 'CCD_TEMPERATURE' | 'FOCUS_TEMPERATURE', element: string, value: number, state: DefNumberVector['state'] = 'Ok'): DefNumberVector {
	return {
		device,
		name,
		permission: 'ro',
		state,
		elements: { [element]: defNumber(element, value, -50, 70, 0.1) },
	}
}

test('preserves fractional camera and focuser temperatures', () => {
	const { recordingClient } = createRecordingClient()

	const cameraManager = new CameraManager()
	const camera = setupDevice(structuredClone(DEFAULT_CAMERA), recordingClient)
	cameraManager.add(camera)
	const cameraThermometerManager = new ThermometerManager(cameraManager)

	cameraThermometerManager.numberVector(recordingClient, temperatureVector(camera.name, 'CCD_TEMPERATURE', 'CCD_TEMPERATURE_VALUE', -10.4), 'defNumberVector')
	const cameraThermometer = cameraThermometerManager.get(recordingClient, camera.name)!

	expect(camera.temperature).toBe(-10.4)
	expect(cameraThermometer.temperature).toBe(-10.4)

	cameraThermometerManager.numberVector(recordingClient, temperatureVector(camera.name, 'CCD_TEMPERATURE', 'CCD_TEMPERATURE_VALUE', 0.4), 'setNumberVector')
	expect(camera.temperature).toBe(0.4)

	cameraThermometerManager.numberVector(recordingClient, temperatureVector(camera.name, 'CCD_TEMPERATURE', 'CCD_TEMPERATURE_VALUE', -10.5), 'setNumberVector')
	expect(camera.temperature).toBe(-10.5)

	const updates: string[] = []
	cameraThermometerManager.addHandler({ added: () => {}, removed: () => {}, updated: (_, property) => updates.push(property) })
	cameraThermometerManager.numberVector(recordingClient, temperatureVector(camera.name, 'CCD_TEMPERATURE', 'CCD_TEMPERATURE_VALUE', -10.5, 'Alert'), 'setNumberVector')
	expect(updates).toEqual(['temperature', 'temperature'])

	const focuserManager = new FocuserManager()
	const focuser = setupDevice(structuredClone(DEFAULT_FOCUSER), recordingClient)
	focuserManager.add(focuser)
	const focuserThermometerManager = new ThermometerManager(focuserManager)

	focuserThermometerManager.numberVector(recordingClient, temperatureVector(focuser.name, 'FOCUS_TEMPERATURE', 'TEMPERATURE', 18.6), 'defNumberVector')
	const focuserThermometer = focuserThermometerManager.get(recordingClient, focuser.name)!

	expect(focuser.temperature).toBe(18.6)
	expect(focuserThermometer.temperature).toBe(18.6)
})
