import { expect, test } from 'bun:test'
import { DEFAULT_CAMERA } from '../../../../src/devices/indi/device'
import { CameraManager } from '../../../../src/devices/indi/manager/camera'
import type { PropertyState, SetNumberVector } from '../../../../src/devices/indi/types'
import { client, setupDevice } from './util'

test('resets deleted INDI properties to defaults', () => {
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

test('reports the transfer formats the driver defines', () => {
	const manager = new CameraManager()
	const device = setupDevice(structuredClone(DEFAULT_CAMERA))

	manager.add(device)

	manager.switchVector(
		client,
		{
			device: device.name,
			name: 'CCD_TRANSFER_FORMAT',
			label: 'Transfer Format',
			group: 'Main Control',
			state: 'Idle',
			permission: 'rw',
			rule: 'OneOfMany',
			timeout: 0,
			elements: { FORMAT_FITS: { name: 'FORMAT_FITS', value: true }, FORMAT_XISF: { name: 'FORMAT_XISF', value: false }, FORMAT_RAW: { name: 'FORMAT_RAW', value: false } },
		},
		'defSwitchVector',
	)
	expect(device.transferFormats).toEqual(['FITS', 'XISF'])

	manager.delProperty(client, { device: device.name, name: 'CCD_TRANSFER_FORMAT' })
	expect(device.transferFormats).toEqual(DEFAULT_CAMERA.transferFormats)
})

test('ignores a countdown tick published after the exposure ended', () => {
	const manager = new CameraManager()
	const device = setupDevice(structuredClone(DEFAULT_CAMERA))
	manager.add(device)

	const exposure = (state: PropertyState, value: number): SetNumberVector => ({ device: device.name, name: 'CCD_EXPOSURE', state, elements: { CCD_EXPOSURE_VALUE: { name: 'CCD_EXPOSURE_VALUE', value } } })

	manager.startExposure(device, 5)
	manager.numberVector(client, exposure('Busy', 5), 'setNumberVector')
	expect(device.exposuring).toBeTrue()

	manager.stopExposure(device)
	manager.numberVector(client, exposure('Idle', 0), 'setNumberVector')
	manager.numberVector(client, exposure('Busy', 0), 'setNumberVector')
	expect(device.exposuring).toBeFalse()
	expect(device.exposure.state).toBe('Idle')

	// A Busy with time left is an exposure, whoever started it.
	manager.numberVector(client, exposure('Busy', 3), 'setNumberVector')
	expect(device.exposuring).toBeTrue()

	// A Busy with no time left is the readout of the running exposure.
	manager.numberVector(client, exposure('Busy', 0), 'setNumberVector')
	expect(device.exposuring).toBeTrue()
	expect(device.exposure.state).toBe('Busy')
	manager.numberVector(client, exposure('Ok', 0), 'setNumberVector')
	expect(device.exposuring).toBeFalse()
	expect(device.exposure.state).toBe('Ok')
	manager.numberVector(client, exposure('Alert', 0), 'setNumberVector')
	expect(device.exposuring).toBeFalse()
	expect(device.exposure.state).toBe('Alert')
})

test('reports every answer to the cooling target with the reading published with it', () => {
	const manager = new CameraManager()
	const device = setupDevice(structuredClone(DEFAULT_CAMERA))
	manager.add(device)
	const answers: [string, PropertyState, number | undefined][] = []
	manager.addHandler({ added() {}, removed() {}, vectorState: (_, vector) => answers.push([vector.name, vector.state, (vector as SetNumberVector).elements.CCD_TEMPERATURE_VALUE?.value]) })

	const temperature = (state: PropertyState, value: number): SetNumberVector => ({ device: device.name, name: 'CCD_TEMPERATURE', state, elements: { CCD_TEMPERATURE_VALUE: { name: 'CCD_TEMPERATURE_VALUE', value } } })
	manager.numberVector(client, temperature('Busy', 12.5), 'setNumberVector')
	manager.numberVector(client, temperature('Busy', 12.5), 'setNumberVector')
	manager.numberVector(client, temperature('Ok', -10), 'setNumberVector')

	expect(answers).toEqual([
		['CCD_TEMPERATURE', 'Busy', 12.5],
		['CCD_TEMPERATURE', 'Busy', 12.5],
		['CCD_TEMPERATURE', 'Ok', -10],
	])
})
