import { expect, describe, test } from 'bun:test'
import { CLIENT, type Client, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_WHEEL, type Cover, type Device, type FlatPanel, type Focuser, type Power, type Rotator, type Wheel } from '../src/indi.device'
import { CameraManager, CoverManager, FlatPanelManager, FocuserManager, MountManager, PowerManager, RotatorManager, WheelManager } from '../src/indi.manager'

describe('del property', () => {
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

	function setupDevice<D extends Device>(device: D) {
		device.id = Bun.randomUUIDv7()
		device.name = device.type
		Object.defineProperty(device, CLIENT, { value: client })
		return device
	}

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
