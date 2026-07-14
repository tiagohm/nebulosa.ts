import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Camera, GuideOutput, Thermometer } from '../../../src/devices/indi/device'
import { CameraManager, CoverManager, type DeviceHandler, type DeviceProvider, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, RotatorManager, ThermometerManager, WheelManager } from '../../../src/devices/indi/manager'
import { CameraSimulator, type CatalogSource, ClientSimulator, CoverSimulator, FlatPanelSimulator, FocuserSimulator, MountSimulator, RotatorSimulator, WheelSimulator } from '../../../src/devices/indi/simulator'
import type { BlobEncoding, PropertyState } from '../../../src/devices/indi/types'
import { readImageFromBuffer } from '../../../src/imaging/model/image'
import type { ImageRawType } from '../../../src/imaging/model/types'
import { deg, formatDEC, formatRA, hour, normalizePI } from '../../../src/math/units/angle'
import { isTimeConsumingTestSkipped } from '../../util'

const SKIP = isTimeConsumingTestSkipped()

class CameraFrameReceiver implements DeviceHandler<Camera> {
	readonly #frames: Buffer[] = []

	added(device: Camera) {}
	updated(device: Camera, property: keyof Camera & string, state?: PropertyState) {}
	removed(device: Camera) {}

	blobReceived(device: Camera, data: Buffer, encoding: BlobEncoding) {
		this.#frames.push(data)
	}

	get length() {
		return this.#frames.length
	}

	get lastFrame() {
		return this.#frames.at(-1)!
	}
}

describe.skipIf(SKIP)('mount simulator', () => {
	test('integrates with mount manager for sync, goto, home and park', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		const client = new ClientSimulator('mount', handler)
		const mountSimulator = new MountSimulator('Mount Simulator', client)

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		expect(mount.canAbort).toBeTrue()
		expect(mount.canSync).toBeTrue()
		expect(mount.canGoTo).toBeTrue()
		expect(mount.canHome).toBeTrue()
		expect(mount.canSetHome).toBeTrue()
		expect(mount.canPark).toBeTrue()
		expect(mount.canSetPark).toBeTrue()
		expect(mount.canTracking).toBeTrue()
		expect(mount.canMove).toBeTrue()

		mountManager.slewRate(mount, 'SPEED_6')

		mountManager.syncTo(mount, hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(5), 1e-9))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		mountManager.setHome(mount)
		mountManager.setPark(mount)

		mountManager.goTo(mount, hour(5.25), deg(24))
		await waitUntil(() => mount.slewing)
		await waitUntil(() => !mount.slewing, 3000)
		expect(closeTo(mount.equatorialCoordinate.rightAscension, hour(5.25), 5e-3)).toBeTrue()
		expect(closeTo(mount.equatorialCoordinate.declination, deg(24), 5e-3)).toBeTrue()

		mountManager.home(mount)
		await waitUntil(() => mount.homing)
		await waitUntil(() => !mount.homing, 3000)
		expect(closeTo(normalizePI(mount.equatorialCoordinate.rightAscension - hour(5)), 0, 5e-3)).toBeTrue()
		expect(closeTo(mount.equatorialCoordinate.declination, deg(20), 5e-3)).toBeTrue()

		mountManager.goTo(mount, hour(5.12), deg(22))
		await waitUntil(() => !mount.slewing, 3000)
		mountManager.park(mount)
		await waitUntil(() => mount.parking)
		await waitUntil(() => mount.parked, 3000)
		expect(mount.tracking).toBeFalse()

		mountManager.unpark(mount)
		await waitUntil(() => !mount.parked)

		mountSimulator.disconnect()
		await waitUntil(() => !mount.connected)

		mountSimulator.connect()
		await waitUntil(() => mount.connected)

		mountSimulator.dispose()
		expect(mountManager.has(client, mountSimulator.name)).toBeFalse()
	})

	test('applies tracking drift for disabled, sidereal, king, solar and lunar modes', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		mountSimulator.minimumNotifyCoordinateInterval = 100

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(2), deg(5))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(2), 1e-9))

		const stoppedRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const noTrackingDrift = normalizePI(mount.equatorialCoordinate.rightAscension - stoppedRightAscension)
		expect(noTrackingDrift).toBeGreaterThan(5e-6)

		mountManager.tracking(mount, true)
		await waitUntil(() => mount.tracking)
		mountManager.trackMode(mount, 'SIDEREAL')
		await waitUntil(() => mount.trackMode === 'SIDEREAL')

		const siderealRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const siderealDrift = Math.abs(normalizePI(mount.equatorialCoordinate.rightAscension - siderealRightAscension))
		expect(siderealDrift).toBeLessThan(1e-6)

		mountManager.trackMode(mount, 'SOLAR')
		await waitUntil(() => mount.trackMode === 'SOLAR')
		const solarRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const solarDrift = normalizePI(mount.equatorialCoordinate.rightAscension - solarRightAscension)
		expect(solarDrift).toBeGreaterThan(0)

		mountManager.trackMode(mount, 'KING')
		await waitUntil(() => mount.trackMode === 'KING')
		const kingRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const kingDrift = normalizePI(mount.equatorialCoordinate.rightAscension - kingRightAscension)
		expect(kingDrift).toBeGreaterThan(0)
		expect(kingDrift).toBeLessThan(solarDrift)

		mountManager.trackMode(mount, 'LUNAR')
		await waitUntil(() => mount.trackMode === 'LUNAR')
		const lunarRightAscension = mount.equatorialCoordinate.rightAscension
		await Bun.sleep(200)
		const lunarDrift = normalizePI(mount.equatorialCoordinate.rightAscension - lunarRightAscension)
		expect(lunarDrift).toBeGreaterThan(solarDrift * 5)
	}, 2000)

	test('supports manual move over time', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(3), deg(0))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(3), 1e-9))

		let manualRightAscension = mount.equatorialCoordinate.rightAscension
		mountManager.moveEast(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveEast(mount, false)
		await waitUntil(() => !mount.slewing)
		let manualDrift = normalizePI(mount.equatorialCoordinate.rightAscension - manualRightAscension)
		expect(manualDrift).toBeGreaterThan(1e-3)

		manualRightAscension = mount.equatorialCoordinate.rightAscension
		mountManager.moveWest(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveWest(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.rightAscension - manualRightAscension)
		expect(manualDrift).toBeLessThan(-1e-3)

		let manualDeclination = mount.equatorialCoordinate.declination
		mountManager.moveNorth(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveNorth(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.declination - manualDeclination)
		expect(manualDrift).toBeGreaterThan(1e-3)

		manualDeclination = mount.equatorialCoordinate.declination
		mountManager.moveSouth(mount, true)
		await waitUntil(() => mount.slewing)
		await Bun.sleep(200)
		mountManager.moveSouth(mount, false)
		await waitUntil(() => !mount.slewing)
		manualDrift = normalizePI(mount.equatorialCoordinate.declination - manualDeclination)
		expect(manualDrift).toBeLessThan(-1e-3)
	}, 2000)

	test('supports manual pulse guiding over time', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)

		handler.add(mountManager)
		handler.add(guideOutputManager)

		using client = new ClientSimulator('mount', handler)
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		mountSimulator.minimumNotifyCoordinateInterval = 100

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)

		mountManager.syncTo(mount, hour(3), deg(0))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(3), 1e-9))

		let pulseDeclination = mount.equatorialCoordinate.declination
		guideOutputManager.pulseNorth(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		let pulseDrift = mount.equatorialCoordinate.declination - pulseDeclination
		expect(pulseDrift).toBeGreaterThan(0)
		expect(pulseDrift).toBeLessThan(5e-5)

		pulseDeclination = mount.equatorialCoordinate.declination
		guideOutputManager.pulseSouth(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.declination - pulseDeclination
		expect(pulseDrift).toBeLessThan(0)
		expect(pulseDrift).toBeGreaterThan(-5e-5)

		let pulseRightAscension = mount.equatorialCoordinate.rightAscension
		guideOutputManager.pulseEast(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.rightAscension - pulseRightAscension
		expect(pulseDrift).toBeGreaterThan(0)
		expect(pulseDrift).toBeLessThan(1e-4)

		pulseRightAscension = mount.equatorialCoordinate.rightAscension
		guideOutputManager.pulseWest(mount, 350)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		pulseDrift = mount.equatorialCoordinate.rightAscension - pulseRightAscension
		expect(pulseDrift).toBeLessThan(5e-6)
		expect(pulseDrift).toBeGreaterThan(-1e-4)

		const guideOutput = guideOutputManager.get(client, mount.name)
		expect(guideOutput).toBeDefined()
		expect(guideOutput!.type).toBe('guideOutput')
		expect(guideOutput!.id).not.toBe(mount.id)
		expect(guideOutput!.parentId).toBe(mount.id)
		expect(mount.parentId).toBeUndefined()
		expect(JSON.stringify(guideOutput)).toContain('parentId')
	}, 3000)
})

describe.skipIf(SKIP)('camera simulator', () => {
	test('integrates with camera manager and exposes synthetic image controls', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		const guideOutputManager = new GuideOutputManager(cameraManager)
		const thermometerManager = new ThermometerManager(cameraManager)
		using client = new ClientSimulator('camera', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		handler.add(guideOutputManager)
		handler.add(thermometerManager)

		cameraManager.addHandler(frameReceiver)

		let savedCollimationRadius: unknown
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, {
			mountManager,
			save: (_name, properties) => {
				savedCollimationRadius = properties.find((property) => property.name === 'SIMULATOR_COLLIMATION_PATTERN')?.elements.MAX_RADIUS?.value
			},
		})
		const camera = cameraManager.get(client, cameraSimulator.name)!

		expect(camera).toBeDefined()

		cameraManager.connect(camera)
		await waitUntil(() => camera.connected)

		expect(camera.canAbort).toBeTrue()
		expect(camera.canBin).toBeTrue()
		expect(camera.canSubFrame).toBeTrue()
		expect(camera.hasCooler).toBeTrue()
		expect(camera.hasCoolerControl).toBeTrue()
		expect(camera.canSetTemperature).toBeTrue()
		expect(camera.canPulseGuide).toBeTrue()
		expect(camera.hasThermometer).toBeTrue()
		expect(camera.frameFormats.map((e) => e.name)).toEqual(['MONO', 'RGB'])
		expect(camera.pixelSize.x).toBeCloseTo(5.2, 6)
		expect(camera.pixelSize.y).toBeCloseTo(5.2, 6)
		expect(cameraManager.properties.get(camera)?.SIMULATOR_NOISE_EXPOSURE).toBeDefined()
		expect(cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE).toBeDefined()
		expect(cameraManager.properties.get(camera)?.SIMULATOR_STAR_PLOT_OPTIONS).toBeDefined()
		expect(cameraManager.properties.get(camera)?.SIMULATOR_COLLIMATION_PATTERN).toBeDefined()
		expect(cameraManager.properties.get(camera)?.SIMULATOR_ABERRATION_FEATURES).toBeDefined()
		expect(cameraManager.properties.get(camera)?.SIMULATOR_ABERRATION_FOCUS).toBeDefined()
		expect(cameraManager.properties.get(camera)?.SIMULATOR_ABERRATION_SHAPE).toBeDefined()

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_FLAGS', elements: { GAMMA_ENABLED: true } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_STAR_PLOT_FLAGS?.elements.GAMMA_ENABLED.value === true)
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_COLLIMATION_PATTERN', elements: { MAX_RADIUS: 64 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_COLLIMATION_PATTERN?.elements.MAX_RADIUS.value === 64)
		cameraSimulator.saveProperties()
		expect(savedCollimationRadius).toBe(64)
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_ABERRATION_FEATURES', elements: { SENSOR_TILT: true } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_ABERRATION_FOCUS', elements: { TILT: 200, TILT_ANGLE: 0 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_ABERRATION_FEATURES?.elements.SENSOR_TILT.value === true)
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_ABERRATION_FOCUS?.elements.TILT.value === 200)

		cameraManager.frame(camera, 32, 16, 160, 120)
		await waitUntil(() => camera.frame.x.value === 32 && camera.frame.y.value === 16 && camera.frame.width.value === 160 && camera.frame.height.value === 120)

		cameraManager.bin(camera, 2, 2)
		await waitUntil(() => camera.bin.x.value === 2 && camera.bin.y.value === 2)

		cameraManager.frameFormat(camera, 'RGB')
		await waitUntil(() => camera.frameFormat === 'RGB')

		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => camera.exposuring)
		await waitUntil(() => frameReceiver.length > 0, 10000, 50)
		await waitUntil(() => !camera.exposuring, 10000, 50)

		const image = await readImageFromBuffer(frameReceiver.lastFrame)

		expect(image).toBeDefined()
		expect(image!.metadata.width).toBe(80)
		expect(image!.metadata.height).toBe(60)
		expect(image!.metadata.channels).toBe(3)
		expect(sumPixels(image!.raw)).toBeGreaterThan(0)

		cameraSimulator.disconnect()
		await waitUntil(() => !camera.connected)

		cameraSimulator.connect()
		await waitUntil(() => camera.connected)

		cameraSimulator.dispose()
		expect(cameraManager.has(client, camera.name)).toBeFalse()
	}, 5000)

	test('adds mount FITS headers when snooping a connected mount', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.header.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)

		cameraManager.addHandler(frameReceiver)

		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		mountManager.geographicCoordinate(mount, { latitude: deg(-22), longitude: deg(-45), elevation: 900 })
		await waitUntil(() => closeTo(mount.geographicCoordinate.latitude, deg(-22), 1e-9))
		await waitUntil(() => closeTo(mount.geographicCoordinate.longitude, deg(-45), 1e-9))

		mountManager.syncTo(mount, hour(22), deg(-60))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(22), 1e-9))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(-60), 1e-9))

		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => frameReceiver.length > 0, 5000, 50)
		const image = await readImageFromBuffer(frameReceiver.lastFrame)
		const header = image!.header

		expect(image).toBeDefined()
		expect(header.TELESCOP).toBe('Mount Simulator')
		expect(header.SITELAT).toBeCloseTo(-22, 6)
		expect(header.SITELONG).toBeCloseTo(-45, 6)
		expect(header.RA).toBeCloseTo(329.52, 2)
		expect(header.DEC).toBeCloseTo(-60.125, 2)
		expect(header.OBJCTRA).toBe(formatRA(deg(header.RA as number)))
		expect(header.OBJCTDEC).toBe(formatDEC(deg(header.DEC as number)))
		expect(header.EQUINOX).toBe(2000)

		cameraSimulator.dispose()
		mountSimulator.dispose()
		expect(cameraManager.has(client, camera.name)).toBeFalse()
		expect(mountManager.has(client, mount.name)).toBeFalse()
	}, 5000)

	test('rotates on the full sensor before extracting a subframe', async () => {
		const handler = new IndiClientHandlerSet()
		const cameraManager = new CameraManager()
		const rotatorManager = new RotatorManager()
		using client = new ClientSimulator('camera.rotator.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(cameraManager)
		handler.add(rotatorManager)

		cameraManager.addHandler(frameReceiver)

		using rotatorSimulator = new RotatorSimulator('Rotator Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { rotatorManager })
		const rotator = rotatorManager.get(client, rotatorSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		rotatorSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => rotator.connected && camera.connected)

		cameraManager.snoop(camera, undefined, undefined, undefined, rotator)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_ROTATOR.value === rotator.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, MOON_ENABLED: false, LIGHT_POLLUTION_ENABLED: false, AMP_GLOW_ENABLED: false } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_EXPOSURE', elements: { EXPOSURE_TIME: 1 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { SCENE_SEED: 7, STAR_DENSITY: 0.0001, HFD_MIN: 1.2, HFD_MAX: 1.2, FLUX_MIN: 0.01, FLUX_MAX: 24 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_SENSOR', elements: { READ_NOISE: 0, BIAS_ELECTRONS: 0, BLACK_LEVEL_ELECTRONS: 0, DARK_CURRENT_AT_REFERENCE_TEMP: 0, DARK_SIGNAL_NON_UNIFORMITY: 0 } })
		client.sendNumber({
			device: camera.name,
			name: 'SIMULATOR_NOISE_ARTIFACTS',
			elements: { FIXED_PATTERN_NOISE_STRENGTH: 0, ROW_NOISE_STRENGTH: 0, COLUMN_NOISE_STRENGTH: 0, BANDING_STRENGTH: 0, HOT_PIXEL_RATE: 0, WARM_PIXEL_RATE: 0, DEAD_PIXEL_RATE: 0, HOT_PIXEL_STRENGTH: 0, WARM_PIXEL_STRENGTH: 0, DEAD_PIXEL_RESIDUAL: 0 },
		})

		cameraManager.startExposure(camera, 0.1)
		await waitUntil(() => frameReceiver.length > 0, 5000, 50)
		const fullFrameImage = await readImageFromBuffer(frameReceiver.lastFrame)

		rotatorManager.syncTo(rotator, 90)
		await waitUntil(() => Math.abs(rotator.angle.value - 90) < 1e-9)

		cameraManager.startExposure(camera, 0.1)
		await waitUntil(() => frameReceiver.length > 1, 5000, 50)
		const rotatedFullFrame = await readImageFromBuffer(frameReceiver.lastFrame)
		const [rotatedFullX, rotatedFullY] = brightestPixel(rotatedFullFrame!.raw, rotatedFullFrame!.metadata.width, rotatedFullFrame!.metadata.channels)
		const frameX = Math.max(0, Math.min(fullFrameImage!.metadata.width - 64, rotatedFullX - 32))
		const frameY = Math.max(0, Math.min(fullFrameImage!.metadata.height - 64, rotatedFullY - 32))

		cameraManager.frame(camera, frameX, frameY, 64, 64)
		await waitUntil(() => camera.frame.x.value === frameX && camera.frame.y.value === frameY && camera.frame.width.value === 64 && camera.frame.height.value === 64)
		cameraManager.startExposure(camera, 0.1)
		await waitUntil(() => frameReceiver.length > 2, 5000, 50)
		const rotatedSubframe = await readImageFromBuffer(frameReceiver.lastFrame)
		const [subframeX, subframeY] = brightestPixel(rotatedSubframe!.raw, rotatedSubframe!.metadata.width, rotatedSubframe!.metadata.channels)

		expect(Math.abs(subframeX - (rotatedFullX - frameX))).toBeLessThanOrEqual(2)
		expect(Math.abs(subframeY - (rotatedFullY - frameY))).toBeLessThanOrEqual(2)

		cameraSimulator.dispose()
		rotatorSimulator.dispose()
		expect(cameraManager.has(client, camera.name)).toBeFalse()
		expect(rotatorManager.has(client, rotator.name)).toBeFalse()
	}, 5000)

	test('scales flat frames with exposure time', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.flat.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)

		cameraManager.addHandler(frameReceiver)

		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager })
		const camera = cameraManager.get(client, cameraSimulator.name)!

		cameraManager.connect(camera)
		await waitUntil(() => camera.connected)

		cameraManager.frameType(camera, 'FLAT')
		await waitUntil(() => camera.frameType === 'FLAT')
		cameraManager.frame(camera, 0, 0, 64, 64)
		await waitUntil(() => camera.frame.width.value === 64 && camera.frame.height.value === 64)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, MOON_ENABLED: false, LIGHT_POLLUTION_ENABLED: false, AMP_GLOW_ENABLED: false } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_EXPOSURE', elements: { EXPOSURE_TIME: 1 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_SENSOR', elements: { READ_NOISE: 0, BIAS_ELECTRONS: 0, BLACK_LEVEL_ELECTRONS: 0, DARK_CURRENT_AT_REFERENCE_TEMP: 0, DARK_SIGNAL_NON_UNIFORMITY: 0 } })
		client.sendNumber({
			device: camera.name,
			name: 'SIMULATOR_NOISE_ARTIFACTS',
			elements: { FIXED_PATTERN_NOISE_STRENGTH: 0, ROW_NOISE_STRENGTH: 0, COLUMN_NOISE_STRENGTH: 0, BANDING_STRENGTH: 0, HOT_PIXEL_RATE: 0, WARM_PIXEL_RATE: 0, DEAD_PIXEL_RATE: 0, HOT_PIXEL_STRENGTH: 0, WARM_PIXEL_STRENGTH: 0, DEAD_PIXEL_RESIDUAL: 0 },
		})

		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_NOISE_EXPOSURE?.elements.EXPOSURE_TIME.value === 1)

		cameraManager.startExposure(camera, 0.1)
		await waitUntil(() => frameReceiver.length > 0, 5000, 50)
		const shortFlat = await readImageFromBuffer(frameReceiver.lastFrame)

		cameraManager.startExposure(camera, 0.2)
		await waitUntil(() => frameReceiver.length > 1, 5000, 50)
		const longFlat = await readImageFromBuffer(frameReceiver.lastFrame)

		expect(shortFlat).toBeDefined()
		expect(longFlat).toBeDefined()
		expect(sumPixels(longFlat!.raw)).toBeGreaterThan(sumPixels(shortFlat!.raw) * 1.8)

		cameraSimulator.dispose()
		expect(cameraManager.has(client, camera.name)).toBeFalse()
	}, 5000)

	test('projects catalog provider stars from the active mount pointing', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.catalog.provider.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)

		cameraManager.addHandler(frameReceiver)

		const catalogProvider: CatalogSource = () => [{ snr: 10, hfd: 4, flux: 30, rightAscension: hour(4.97409), declination: deg(19.95913) }]

		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { HNSKY: catalogProvider } })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		mountSimulator.syncTo(hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(5), 1e-9))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { FLUX_MIN: 12, FLUX_MAX: 48 } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { HNSKY: true } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.HNSKY.value === true)

		try {
			cameraSimulator.startExposure(0.05)
			await waitUntil(() => frameReceiver.length > 0, 10000, 50)
			const image = await readImageFromBuffer(frameReceiver.lastFrame)
			expect(image).toBeDefined()
			expect(sumPixels(image!.raw)).toBeGreaterThan(0)
		} finally {
			cameraSimulator.dispose()
			mountSimulator.dispose()
		}
	}, 5000)

	test('renders a defocused annular collimation pattern with anisotropic binning', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.collimation.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		cameraManager.addHandler(frameReceiver)

		const catalogProvider: CatalogSource = (rightAscension, declination) => [{ snr: 100, hfd: 2, flux: 1000, rightAscension, declination }]
		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { COLLIMATION: catalogProvider } })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)
		mountSimulator.syncTo(hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(5), 1e-9))
		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { COLLIMATION: true } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_PSF_MODEL', elements: { ANNULAR: true } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_ABERRATION_FEATURES', elements: { COLLIMATION: true } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, MOON_ENABLED: false, LIGHT_POLLUTION_ENABLED: false, AMP_GLOW_ENABLED: false } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_SENSOR', elements: { READ_NOISE: 0, BIAS_ELECTRONS: 0, BLACK_LEVEL_ELECTRONS: 0, DARK_CURRENT_AT_REFERENCE_TEMP: 0, DARK_SIGNAL_NON_UNIFORMITY: 0 } })
		client.sendNumber({
			device: camera.name,
			name: 'SIMULATOR_NOISE_ARTIFACTS',
			elements: { FIXED_PATTERN_NOISE_STRENGTH: 0, ROW_NOISE_STRENGTH: 0, COLUMN_NOISE_STRENGTH: 0, BANDING_STRENGTH: 0, HOT_PIXEL_RATE: 0, WARM_PIXEL_RATE: 0, DEAD_PIXEL_RATE: 0 },
		})
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { SEEING: 0 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_COLLIMATION_PATTERN', elements: { MAX_RADIUS: 40, OBSTRUCTION_RATIO: 0.35, EDGE_SOFTNESS: 0.6, SPIDER_VANES: 4 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_ABERRATION_SHAPE', elements: { COLLIMATION: 0.5, COLLIMATION_ANGLE: 0 } })
		cameraManager.frame(camera, 512, 384, 256, 256)
		cameraManager.bin(camera, 2, 1)

		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_STAR_PLOT_PSF_MODEL?.elements.ANNULAR.value === true)
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_COLLIMATION_PATTERN?.elements.MAX_RADIUS.value === 40)
		await waitUntil(() => camera.frame.x.value === 512 && camera.bin.x.value === 2 && camera.bin.y.value === 1)

		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => frameReceiver.length > 0, 10000, 50)
		const focusedImage = await readImageFromBuffer(frameReceiver.lastFrame)
		expect(focusedImage).toBeDefined()
		expect(focusedImage!.raw[128 * focusedImage!.metadata.stride + 64]).toBeGreaterThan(focusedImage!.raw[128 * focusedImage!.metadata.stride + 80])

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_OPTIONS', elements: { FOCUS_STEP: 52000, BEST_FOCUS: 50000 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_STAR_PLOT_OPTIONS?.elements.FOCUS_STEP.value === 52000)
		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => frameReceiver.length > 1, 10000, 50)
		const image = await readImageFromBuffer(frameReceiver.lastFrame)
		expect(image).toBeDefined()
		expect(image!.metadata.width).toBe(128)
		expect(image!.metadata.height).toBe(256)

		const centerX = 64
		const centerY = 128
		const obstructionX = 70
		const obstructionSample = image!.raw[centerY * image!.metadata.stride + obstructionX]
		let maximum = 0
		for (let i = 0; i < image!.raw.length; i++) maximum = Math.max(maximum, image!.raw[i])
		expect(maximum).toBeGreaterThan(0)
		expect(obstructionSample).toBeLessThan(maximum * 0.35)
		expect(image!.raw[centerY * image!.metadata.stride + centerX]).toBeLessThan(maximum * 0.5)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_FLAGS', elements: { SATURATION_ENABLED: true } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_OPTIONS', elements: { SATURATION_LEVEL: 0.1 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { SEEING: 1.2 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_STAR_PLOT_FLAGS?.elements.SATURATION_ENABLED.value === true && cameraManager.properties.get(camera)?.SIMULATOR_SCENE?.elements.SEEING.value === 1.2)
		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => frameReceiver.length > 2, 10000, 50)
		const saturatedImage = await readImageFromBuffer(frameReceiver.lastFrame)
		expect(saturatedImage).toBeDefined()
		expect(Math.max(...saturatedImage!.raw)).toBeLessThanOrEqual(0.1)
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_FLAGS', elements: { SATURATION_ENABLED: false } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { SEEING: 0 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_STAR_PLOT_FLAGS?.elements.SATURATION_ENABLED.value === false && cameraManager.properties.get(camera)?.SIMULATOR_SCENE?.elements.SEEING.value === 0)

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_OPTIONS', elements: { BEST_FOCUS: 0 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_STAR_PLOT_OPTIONS?.elements.BEST_FOCUS.value === 0)
		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => frameReceiver.length > 3, 10000, 50)
		const disabledFocusImage = await readImageFromBuffer(frameReceiver.lastFrame)
		expect(disabledFocusImage).toBeDefined()
		expect(disabledFocusImage!.raw[centerY * disabledFocusImage!.metadata.stride + centerX]).toBeGreaterThan(disabledFocusImage!.raw[centerY * disabledFocusImage!.metadata.stride + 80])

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_OPTIONS', elements: { BEST_FOCUS: 50000 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_STAR_PLOT_OPTIONS?.elements.BEST_FOCUS.value === 50000)

		cameraManager.frame(camera, 660, 384, 256, 256)
		await waitUntil(() => camera.frame.x.value === 660)
		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => frameReceiver.length > 4, 10000, 50)
		const clippedImage = await readImageFromBuffer(frameReceiver.lastFrame)
		expect(clippedImage).toBeDefined()
		expect(sumPixels(clippedImage!.raw)).toBeGreaterThan(0)

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_COLLIMATION_PATTERN', elements: { EDGE_SOFTNESS: 10 } })
		cameraManager.bin(camera, 4, 1)
		cameraManager.frame(camera, 790, 384, 256, 256)
		await waitUntil(() => camera.frame.x.value === 790 && camera.bin.x.value === 4 && camera.bin.y.value === 1 && cameraManager.properties.get(camera)?.SIMULATOR_COLLIMATION_PATTERN?.elements.EDGE_SOFTNESS.value === 10)
		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => frameReceiver.length > 5, 10000, 50)
		const asymmetricEdgeImage = await readImageFromBuffer(frameReceiver.lastFrame)
		expect(asymmetricEdgeImage).toBeDefined()
		expect(sumPixels(asymmetricEdgeImage!.raw)).toBeGreaterThan(0)
	}, 5000)

	test('camera sends guiding pulse to mount', async () => {
		const handler = new IndiClientHandlerSet()
		const cameraManager = new CameraManager()
		const mountManager = new MountManager()
		const guideOutputProvider: DeviceProvider<GuideOutput> = { get: (client, name) => mountManager.get(client, name) ?? cameraManager.get(client, name) }
		const thermometerProvider: DeviceProvider<Thermometer> = { get: (client, name) => cameraManager.get(client, name) }
		const guideOutputManager = new GuideOutputManager(guideOutputProvider)
		const thermometerManager = new ThermometerManager(thermometerProvider)

		handler.add(cameraManager)
		handler.add(mountManager)
		handler.add(guideOutputManager)
		handler.add(thermometerManager)

		using client = new ClientSimulator('mount', handler)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, guideOutputManager })
		using mountSimulator = new MountSimulator('Mount Simulator', client)

		const mount = mountManager.get(client, mountSimulator.name)!
		mountManager.connect(mount)
		await waitUntil(() => mount.connected)
		expect(mount.canPulseGuide).toBeTrue()

		const camera = cameraManager.get(client, cameraSimulator.name)!
		cameraManager.connect(camera)
		await waitUntil(() => camera.connected)
		expect(camera.canPulseGuide).toBeTrue()

		cameraManager.snoop(camera, mount)

		guideOutputManager.pulseNorth(camera, 350)
		await waitUntil(() => camera.pulsing)
		await waitUntil(() => mount.pulsing)
		await waitUntil(() => !mount.pulsing, 1000)
		await waitUntil(() => !camera.pulsing, 1000)

		const guideOutput = guideOutputManager.get(client, camera.name)
		expect(guideOutput).toBeDefined()
		expect(guideOutput!.type).toBe('guideOutput')
		expect(guideOutput!.id).not.toBe(camera.id)
		expect(guideOutput!.parentId).toBe(camera.id)
		expect(mount.parentId).toBeUndefined()
		expect(JSON.stringify(guideOutput)).toContain('parentId')

		const thermometer = thermometerManager.get(client, camera.name)
		expect(thermometer).toBeDefined()
		expect(thermometer!.type).toBe('thermometer')
		expect(thermometer!.id).not.toBe(camera.id)
		expect(thermometer!.parentId).toBe(camera.id)
		expect(JSON.stringify(thermometer)).toContain('parentId')
	}, 1000)
})

describe.skipIf(SKIP)('accessory simulators', () => {
	test('integrates with focuser, filter wheel, rotator, light box and dust cap managers', async () => {
		const handler = new IndiClientHandlerSet()
		const focuserManager = new FocuserManager()
		const wheelManager = new WheelManager()
		const rotatorManager = new RotatorManager()
		const flatPanelManager = new FlatPanelManager()
		const coverManager = new CoverManager()
		const thermometerManager = new ThermometerManager(focuserManager)

		handler.add(focuserManager)
		handler.add(wheelManager)
		handler.add(rotatorManager)
		handler.add(flatPanelManager)
		handler.add(coverManager)
		handler.add(thermometerManager)

		using client = new ClientSimulator('accessories', handler)
		using focuserSimulator = new FocuserSimulator('Focuser Simulator', client)
		using wheelSimulator = new WheelSimulator('Wheel Simulator', client)
		using rotatorSimulator = new RotatorSimulator('Rotator Simulator', client)
		using lightBoxSimulator = new FlatPanelSimulator('Light Box Simulator', client)
		using dustCapSimulator = new CoverSimulator('Dust Cap Simulator', client)

		const focuser = focuserManager.get(client, focuserSimulator.name)!
		const wheel = wheelManager.get(client, wheelSimulator.name)!
		const rotator = rotatorManager.get(client, rotatorSimulator.name)!
		const flatPanel = flatPanelManager.get(client, lightBoxSimulator.name)!
		const cover = coverManager.get(client, dustCapSimulator.name)!

		focuserManager.connect(focuser)
		wheelManager.connect(wheel)
		rotatorManager.connect(rotator)
		flatPanelManager.connect(flatPanel)
		coverManager.connect(cover)

		await waitUntil(() => focuser.connected && wheel.connected && rotator.connected && flatPanel.connected && cover.connected)

		expect(focuserManager.properties.length).toBe(1)
		expect(wheelManager.properties.length).toBe(1)
		expect(rotatorManager.properties.length).toBe(1)
		expect(flatPanelManager.properties.length).toBe(1)
		expect(coverManager.properties.length).toBe(1)
		expect(thermometerManager.properties.length).toBe(1)

		expect(focuser.hasThermometer).toBeTrue()
		expect(focuser.canAbsoluteMove).toBeTrue()
		expect(focuser.canRelativeMove).toBeTrue()
		expect(focuser.canAbort).toBeTrue()
		expect(focuser.canReverse).toBeTrue()
		expect(focuser.canSync).toBeTrue()
		expect(focuser.position.value).toBe(50000)
		expect(focuserManager.properties.get(focuser)?.FOCUS_TEMPERATURE).toBeDefined()
		expect(focuserManager.properties.get(focuser)?.FOCUS_TEMPERATURE_COMPENSATION).toBeDefined()

		const initialFocuserTemperature = Number(focuserManager.properties.get(focuser)?.FOCUS_TEMPERATURE?.elements.TEMPERATURE.value ?? 0)
		await waitUntil(() => Math.abs(Number(focuserManager.properties.get(focuser)?.FOCUS_TEMPERATURE?.elements.TEMPERATURE.value ?? initialFocuserTemperature) - initialFocuserTemperature) >= 0.05, 3000)

		const compensatedStart = focuser.position.value
		client.sendSwitch({ device: focuser.name, name: 'FOCUS_TEMPERATURE_COMPENSATION', elements: { INDI_ENABLED: true } })
		await waitUntil(() => focuserManager.properties.get(focuser)?.FOCUS_TEMPERATURE_COMPENSATION?.elements.INDI_ENABLED.value === true)
		await waitUntil(() => focuser.position.value !== compensatedStart, 4000)
		await waitUntil(() => !focuser.moving, 3000)

		client.sendSwitch({ device: focuser.name, name: 'FOCUS_TEMPERATURE_COMPENSATION', elements: { INDI_DISABLED: true } })
		await waitUntil(() => focuserManager.properties.get(focuser)?.FOCUS_TEMPERATURE_COMPENSATION?.elements.INDI_DISABLED.value === true)

		focuserManager.moveTo(focuser, 62000)
		await waitUntil(() => focuser.moving)
		await waitUntil(() => !focuser.moving, 3000)
		expect(focuser.position.value).toBeCloseTo(62000, 6)

		focuserManager.moveIn(focuser, 2000)
		await waitUntil(() => focuser.moving)
		await waitUntil(() => !focuser.moving, 3000)
		expect(focuser.position.value).toBeCloseTo(60000, 6)

		focuserManager.reverse(focuser, true)
		await waitUntil(() => focuser.reversed)
		focuserManager.moveIn(focuser, 1000)
		await waitUntil(() => focuser.moving)
		await waitUntil(() => !focuser.moving, 3000)
		expect(focuser.position.value).toBeCloseTo(61000, 6)

		focuserManager.syncTo(focuser, 12345)
		await waitUntil(() => focuser.position.value === 12345)

		expect(wheel.count).toBe(8)
		expect(wheel.position).toBe(0)
		expect(wheel.names).toEqual(['L', 'R', 'G', 'B', 'Ha', 'SII', 'OIII', 'Dark'])
		expect(wheel.canSetNames).toBeTrue()

		wheelManager.moveTo(wheel, 3)
		await waitUntil(() => wheel.moving)
		await waitUntil(() => !wheel.moving, 3000)
		expect(wheel.position).toBe(3)

		wheelManager.slots(wheel, ['Lum', 'Red', 'Green', 'Blue', 'OIII'])
		await waitUntil(() => wheel.names[4] === 'OIII')
		expect(wheel.names).toEqual(['Lum', 'Red', 'Green', 'Blue', 'OIII', 'SII', 'OIII', 'Dark'])

		expect(rotator.canAbort).toBeTrue()
		expect(rotator.canReverse).toBeTrue()
		expect(rotator.canSync).toBeTrue()
		expect(rotator.canHome).toBeTrue()
		expect(rotator.hasBacklashCompensation).toBeFalse()

		rotatorManager.moveTo(rotator, 42.5)
		await waitUntil(() => rotator.moving)
		await waitUntil(() => !rotator.moving, 3000)
		expect(rotator.angle.value).toBeCloseTo(42.5, 2)

		rotatorManager.reverse(rotator, true)
		await waitUntil(() => rotator.reversed)
		client.sendSwitch({ device: rotator.name, name: 'ROTATOR_BACKLASH_TOGGLE', elements: { INDI_ENABLED: true } })
		await waitUntil(() => rotator.hasBacklashCompensation)

		rotatorManager.syncTo(rotator, 90)
		await waitUntil(() => Math.abs(rotator.angle.value - 90) < 1e-9)
		rotatorManager.home(rotator)
		await waitUntil(() => rotator.moving)
		await waitUntil(() => !rotator.moving, 3000)
		expect(rotator.angle.value).toBeCloseTo(0, 2)

		expect(flatPanel.enabled).toBeFalse()
		expect(flatPanel.intensity.max).toBe(255)
		flatPanelManager.enable(flatPanel)
		await waitUntil(() => flatPanel.enabled)
		flatPanelManager.intensity(flatPanel, 99)
		await waitUntil(() => flatPanel.intensity.value === 99)
		flatPanelManager.disable(flatPanel)
		await waitUntil(() => !flatPanel.enabled)

		expect(cover.canPark).toBeTrue()
		expect(cover.canAbort).toBeTrue()
		expect(cover.parked).toBeFalse()
		coverManager.park(cover)
		await waitUntil(() => cover.parking)
		await waitUntil(() => cover.parked, 3000)
		coverManager.unpark(cover)
		await waitUntil(() => cover.parking)
		await waitUntil(() => !cover.parked, 3000)

		const thermometer = thermometerManager.get(client, focuser.name)
		expect(thermometer).toBeDefined()
		expect(thermometer!.type).toBe('thermometer')
		expect(thermometer!.id).not.toBe(focuser.id)
		expect(thermometer!.parentId).toBe(focuser.id)
		expect(JSON.stringify(thermometer)).toContain('parentId')

		focuserSimulator.dispose()
		wheelSimulator.dispose()
		rotatorSimulator.dispose()
		lightBoxSimulator.dispose()
		dustCapSimulator.dispose()

		expect(focuserManager.has(client, focuser.name)).toBeFalse()
		expect(wheelManager.has(client, wheel.name)).toBeFalse()
		expect(rotatorManager.has(client, rotator.name)).toBeFalse()
		expect(flatPanelManager.has(client, flatPanel.name)).toBeFalse()
		expect(coverManager.has(client, cover.name)).toBeFalse()
		expect(thermometerManager.has(client, focuser.name)).toBeFalse()
		expect(focuserManager.properties.length).toBe(0)
		expect(wheelManager.properties.length).toBe(0)
		expect(rotatorManager.properties.length).toBe(0)
		expect(flatPanelManager.properties.length).toBe(0)
		expect(coverManager.properties.length).toBe(0)
		expect(thermometerManager.properties.length).toBe(0)
	}, 7000)

	test('camera uses focuser position', async () => {
		const handler = new IndiClientHandlerSet()
		const cameraManager = new CameraManager()
		const focuserManager = new FocuserManager()
		const frameReceiver = new CameraFrameReceiver()

		handler.add(cameraManager)
		handler.add(focuserManager)

		cameraManager.addHandler(frameReceiver)

		using client = new ClientSimulator('mount', handler)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { focuserManager })
		using focuserSimulator = new FocuserSimulator('Focuser Simulator', client)

		const focuser = focuserManager.get(client, focuserSimulator.name)!
		focuserManager.connect(focuser)
		await waitUntil(() => focuser.connected)
		expect(focuser.position.max).toBe(100000)
		expect(focuser.position.value).toBe(50000)

		const camera = cameraManager.get(client, cameraSimulator.name)!
		cameraManager.connect(camera)
		await waitUntil(() => camera.connected)

		cameraManager.snoop(camera, undefined, focuser)

		cameraSimulator.startExposure(0.05)
		await waitUntil(() => frameReceiver.length > 0, 10000, 50)
		const focusedImage = await readImageFromBuffer(frameReceiver.lastFrame)
		const focusedSumPixel = sumPixels(focusedImage!.raw)
		expect(focusedSumPixel).toBeGreaterThan(0)

		focuserManager.moveTo(focuser, 80000)
		await waitUntil(() => focuser.moving)
		await waitUntil(() => !focuser.moving, 3000)
		expect(focuser.position.value).toBeCloseTo(80000, 6)

		cameraSimulator.startExposure(0.05)
		await waitUntil(() => frameReceiver.length > 1, 10000, 50)
		const defocusedImage = await readImageFromBuffer(frameReceiver.lastFrame)
		const defocusedSumPixel = sumPixels(defocusedImage!.raw)
		expect(defocusedSumPixel).toBeGreaterThan(0)

		expect(defocusedSumPixel).toBeLessThan(focusedSumPixel)
	}, 5000)
})

async function waitUntil(predicate: () => boolean, timeout: number = 5000, step: number = 100): Promise<void> {
	while (!predicate()) {
		if (timeout <= 0) throw new Error('timeout waiting for condition')
		await Bun.sleep(step)
		timeout -= step
	}
}

function closeTo(a: number, b: number, tolerance: number) {
	return Math.abs(a - b) <= tolerance
}

function sumPixels(raw: ImageRawType) {
	let total = 0
	for (let i = 0; i < raw.length; i++) {
		total += raw[i]
		if (raw[i] < 0) console.info(raw[i])
	}
	return total
}

function brightestPixel(raw: ImageRawType, width: number, channels: number) {
	let brightestX = 0
	let brightestY = 0
	let brightestValue = -Infinity

	if (channels === 1) {
		for (let i = 0; i < raw.length; i++) {
			if (raw[i] <= brightestValue) continue
			brightestValue = raw[i]
			brightestX = i % width
			brightestY = Math.trunc(i / width)
		}
	} else {
		const pixelCount = Math.trunc(raw.length / channels)

		for (let i = 0; i < pixelCount; i++) {
			const index = i * channels
			const value = raw[index] + raw[index + 1] + raw[index + 2]
			if (value <= brightestValue) continue
			brightestValue = value
			brightestX = i % width
			brightestY = Math.trunc(i / width)
		}
	}

	return [brightestX, brightestY, brightestValue] as const
}
