import { describe, expect, test } from 'bun:test'
import type { GuideDirection } from '../../../../src/devices/indi/device'
import { cameraSimulatorConfig, DEFAULT_CAMERA_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/camera.config'
import { approachTemperature, CameraCooler, coolerPower } from '../../../../src/devices/indi/simulator/camera.cooler'
import { CameraGuidePort } from '../../../../src/devices/indi/simulator/camera.guideport'
import { CameraReadout } from '../../../../src/devices/indi/simulator/camera.readout'
import { CameraSensor } from '../../../../src/devices/indi/simulator/camera.sensor'
import { CameraShutter, type CameraShutterListener } from '../../../../src/devices/indi/simulator/camera.shutter'
import { routeNumber } from '../../../../src/devices/indi/simulator/component'
import { timedGuidePulse } from '../../../../src/devices/indi/simulator/util'
import { TestBus } from '../../../util/bus'

// Unit coverage of the camera's control circuits, driven by a manual clock without a client or timers.

const COOLER = DEFAULT_CAMERA_SIMULATOR_CONFIG.cooler

describe('camera config', () => {
	test('merges an override section by section without touching the defaults', () => {
		const config = cameraSimulatorConfig({ optics: { focalLength: 50 }, noise: { sensor: { readNoise: 0 } } })
		expect(config.optics.focalLength).toBe(50)
		expect(config.optics.aperture).toBe(DEFAULT_CAMERA_SIMULATOR_CONFIG.optics.aperture)
		expect(config.noise.sensor.readNoise).toBe(0)
		expect(config.noise.sensor.biasElectrons).toBe(DEFAULT_CAMERA_SIMULATOR_CONFIG.noise.sensor.biasElectrons)
		expect(DEFAULT_CAMERA_SIMULATOR_CONFIG.optics.focalLength).toBe(500)
		expect(cameraSimulatorConfig()).toBe(DEFAULT_CAMERA_SIMULATOR_CONFIG)
	})
})

describe('camera cooler', () => {
	test('approaches the target independently of how time is split', () => {
		const once = approachTemperature(18, -10, 1, 2)
		const twice = approachTemperature(approachTemperature(18, -10, 0.5, 2), -10, 0.5, 2)
		expect(twice).toBeCloseTo(once, 12)
		expect(approachTemperature(-9.99, -10, 1, 2)).toBe(-10)
		expect(coolerPower(5, 18, 6.5)).toBeCloseTo(84.5, 12)
		expect(coolerPower(-40, 18, 6.5)).toBe(100)
		expect(coolerPower(30, 18, 6.5)).toBe(0)
	})

	test('cools to the target when on and drifts back to ambient when off', () => {
		const bus = new TestBus()
		const cooler = new CameraCooler(bus, COOLER)
		expect(cooler.temperature).toBe(COOLER.ambientTemperature)

		cooler.handleSwitch({ device: '', name: 'CCD_COOLER', elements: { COOLER_ON: true } })
		cooler.setTargetTemperature(5)
		expect(cooler.properties[1].state).toBe('Busy')

		for (let i = 1; i <= 200; i++) {
			bus.time = i * 100
			cooler.tick(bus.time)
		}

		expect(cooler.temperature).toBe(5)
		expect(cooler.properties[1].state).toBe('Ok')
		// Published in steps of half a percent.
		expect(Math.abs(cooler.power - 84.5)).toBeLessThan(0.5)

		cooler.handleSwitch({ device: '', name: 'CCD_COOLER', elements: { COOLER_OFF: true } })

		for (let i = 201; i <= 600; i++) {
			bus.time = i * 100
			cooler.tick(bus.time)
		}

		expect(cooler.temperature).toBe(COOLER.ambientTemperature)
		expect(cooler.properties[1].state).toBe('Idle')
		expect(cooler.power).toBe(0)
	})

	test('integrates the same temperature from ten short ticks as from one long one', () => {
		const fine = new CameraCooler(new TestBus(), COOLER)
		const coarse = new CameraCooler(new TestBus(), COOLER)

		for (const cooler of [fine, coarse]) {
			cooler.handleSwitch({ device: '', name: 'CCD_COOLER', elements: { COOLER_ON: true } })
			cooler.setTargetTemperature(-10)
		}

		for (let i = 1; i <= 10; i++) fine.tick(i * 100)
		coarse.tick(1000)

		expect(fine.temperature).toBeCloseTo(coarse.temperature, 9)
	})

	test('answers a target already reached as Ok', () => {
		const bus = new TestBus()
		const cooler = new CameraCooler(bus, COOLER)
		cooler.setTargetTemperature(COOLER.ambientTemperature + 0.1)
		expect(cooler.properties[1].state).toBe('Ok')
		expect(bus.take()).toEqual(['CCD_TEMPERATURE'])
		cooler.setTargetTemperature(1000)
		expect(cooler.targetTemperature).toBe(70)
	})
})

describe('camera shutter', () => {
	function makeShutter(canOpen = true) {
		const bus = new TestBus(1000)
		const events: string[] = []
		const listener: CameraShutterListener = { canOpen: () => canOpen, opened: (duration, now) => events.push(`opened ${duration} ${now}`), closed: (duration) => events.push(`closed ${duration}`) }
		return { bus, events, shutter: new CameraShutter(bus, DEFAULT_CAMERA_SIMULATOR_CONFIG.shutter, listener) }
	}

	test('counts an exposure down and closes it once', () => {
		const { bus, events, shutter } = makeShutter()

		expect(shutter.open(0.5)).toBeTrue()
		expect(shutter.isExposing).toBeTrue()
		expect(shutter.open(1)).toBeFalse()
		expect(events).toEqual(['opened 0.5 1000'])

		bus.time = 1200
		shutter.tick(bus.time)
		expect(shutter.properties[0].elements.CCD_EXPOSURE_VALUE.value).toBeCloseTo(0.3, 9)
		expect(events).toHaveLength(1)

		bus.time = 1500
		shutter.tick(bus.time)
		shutter.tick(1600)
		expect(events).toEqual(['opened 0.5 1000', 'closed 0.5'])
		expect(shutter.isExposing).toBeFalse()
		// Closed but not complete: the countdown is at zero and the state still the one last published.
		expect(shutter.properties[0].elements.CCD_EXPOSURE_VALUE.value).toBe(0)

		bus.take()
		shutter.complete(true)
		expect(shutter.properties[0].state).toBe('Ok')
		expect(bus.take()).toEqual(['CCD_EXPOSURE'])
	})

	test('clamps the duration and refuses to open when the listener refuses', () => {
		const { shutter } = makeShutter()
		shutter.open(0)
		expect(shutter.properties[0].elements.CCD_EXPOSURE_VALUE.value).toBe(DEFAULT_CAMERA_SIMULATOR_CONFIG.shutter.minExposure)

		const refused = makeShutter(false)
		expect(refused.shutter.open(1)).toBeFalse()
		expect(refused.events).toHaveLength(0)
	})

	test('leaves a newer exposure alone when an older one completes', () => {
		const { bus, shutter } = makeShutter()
		shutter.open(0.1)
		bus.time = 1100
		shutter.tick(bus.time)
		shutter.open(1)
		shutter.complete(false)
		expect(shutter.properties[0].state).toBe('Busy')
		expect(shutter.isExposing).toBeTrue()
	})

	test('aborts an open exposure Idle or Alert and ignores an abort without one', () => {
		const { bus, events, shutter } = makeShutter()
		shutter.abort(true)
		expect(bus.take()).toEqual([])

		shutter.open(1)
		shutter.handleSwitch({ device: '', name: 'CCD_ABORT_EXPOSURE', elements: { ABORT: true } })
		expect(shutter.properties[0].state).toBe('Idle')
		shutter.open(1)
		shutter.abort(true)
		expect(shutter.properties[0].state).toBe('Alert')
		shutter.tick(1e9)
		expect(events.filter((e) => e.startsWith('closed'))).toHaveLength(0)
	})
})

describe('camera guide port', () => {
	test('picks the pulse a timed-guide command asks for', () => {
		expect(timedGuidePulse('NORTH', 100, 'SOUTH', undefined)).toEqual(['NORTH', 100])
		expect(timedGuidePulse('NORTH', 0, 'SOUTH', 250)).toEqual(['SOUTH', 250])
		expect(timedGuidePulse('NORTH', 0, 'SOUTH', 0)).toEqual(['NORTH', 0])
		expect(timedGuidePulse('NORTH', undefined, 'SOUTH', 0)).toEqual(['SOUTH', 0])
		expect(timedGuidePulse('NORTH', undefined, 'SOUTH', undefined)).toBeUndefined()
	})

	test('relays pulses, keeps each axis Busy for its duration and cancels on zero', () => {
		const bus = new TestBus(0)
		const relayed: [GuideDirection, number][] = []
		let enabled = true
		const port = new CameraGuidePort(bus, { enabled: () => enabled, pulse: (direction, duration) => relayed.push([direction, duration]) })
		const [northSouth, westEast] = port.properties

		expect(routeNumber([port], { device: '', name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_N: 0, TIMED_GUIDE_S: 300 } })).toBeTrue()
		port.pulse('EAST', 100)
		expect(relayed).toEqual([
			['SOUTH', 300],
			['EAST', 100],
		])
		expect(northSouth.state).toBe('Busy')
		expect(westEast.state).toBe('Busy')

		port.tick(100)
		expect(northSouth.state).toBe('Busy')
		expect(westEast.state).toBe('Idle')

		port.pulse('NORTH', 0)
		expect(northSouth.state).toBe('Idle')
		expect(port.isPulsing).toBeFalse()

		enabled = false
		port.pulse('WEST', 100)
		expect(relayed).toHaveLength(3)
		expect(port.isPulsing).toBeFalse()
	})
})

describe('camera readout', () => {
	function makeReadout() {
		const bus = new TestBus()
		const sensor = new CameraSensor(bus, { ...DEFAULT_CAMERA_SIMULATOR_CONFIG.sensor, width: 100, height: 80 })
		return { bus, readout: new CameraReadout(bus, sensor, DEFAULT_CAMERA_SIMULATOR_CONFIG.readout) }
	}

	test('keeps the subframe inside the sensor and publishes only changes', () => {
		const { bus, readout } = makeReadout()
		readout.setFrame(90, 70, 50, 50)
		expect(readout.snapshot()).toMatchObject({ x: 90, y: 70, width: 10, height: 10 })
		expect(bus.take()).toEqual(['CCD_FRAME'])
		readout.setFrame(90.7, 70.2)
		expect(bus.take()).toEqual([])
		readout.setFrame(-5, -5, 1000, 1000)
		expect(readout.snapshot()).toMatchObject({ x: 0, y: 0, width: 100, height: 80 })
	})

	test('bins within its limit and rounds the delivered size up', () => {
		const { readout } = makeReadout()
		readout.setFrame(0, 0, 99, 79)
		readout.setBin(2, 9)
		expect(readout.snapshot()).toMatchObject({ binX: 2, binY: 4, imageWidth: 50, imageHeight: 20 })
	})

	test('switches the frame type, readout mode and transfer format', () => {
		const { readout } = makeReadout()
		readout.handleSwitch({ device: '', name: 'CCD_FRAME_TYPE', elements: { FRAME_FLAT: true } })
		readout.handleSwitch({ device: '', name: 'CCD_CAPTURE_FORMAT', elements: { RGB: true } })
		readout.handleSwitch({ device: '', name: 'CCD_TRANSFER_FORMAT', elements: { FORMAT_XISF: true } })
		expect(readout.snapshot()).toMatchObject({ frameType: 'FLAT', readoutMode: 'RGB', channels: 3, transferFormat: 'XISF' })
		expect(readout.handleSwitch({ device: '', name: 'OTHER', elements: {} })).toBeFalse()
	})
})
