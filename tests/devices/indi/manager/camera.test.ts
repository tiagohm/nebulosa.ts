import { expect, test } from 'bun:test'
import { DEFAULT_CAMERA } from '../../../../src/devices/indi/device'
import { CameraManager } from '../../../../src/devices/indi/manager/camera'
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
