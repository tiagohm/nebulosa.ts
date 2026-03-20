import { describe, expect, test } from 'bun:test'
import { deg, formatDEC, formatRA, hour, normalizePI } from '../src/angle'
import { readImageFromBuffer } from '../src/image'
import type { ImageRawType } from '../src/image.types'
import { IndiClientHandlerSet } from '../src/indi.client'
import type { Camera, GuideOutput } from '../src/indi.device'
import { CameraManager, CoverManager, type DeviceHandler, DevicePropertyManager, type DeviceProvider, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, RotatorManager, ThermometerManager, WheelManager } from '../src/indi.manager'
import { CameraSimulator, ClientSimulator, DustCapSimulator, FilterWheelSimulator, FocuserSimulator, LightBoxSimulator, MountSimulator, RotatorSimulator } from '../src/indi.simulator'
import type { PropertyState } from '../src/indi.types'

const SKIP = Bun.env.RUN_SKIPPED_TESTS !== 'true'

class CameraFrameReceiver implements DeviceHandler<Camera> {
	private readonly frames: Buffer<ArrayBuffer>[] = []

	added(device: Camera) {}
	updated(device: Camera, property: keyof Camera & string, state?: PropertyState) {}
	removed(device: Camera) {}

	blobReceived(device: Camera, data: string | Buffer<ArrayBuffer>) {
		Buffer.isBuffer(data) && this.frames.push(data)
	}

	get length() {
		return this.frames.length
	}

	get lastFrame() {
		return this.frames[this.frames.length - 1]
	}
}

describe.skipIf(SKIP)('mount simulator', () => {
	test('integrates with mount manager for sync, goto, home and park', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const guideOutputManager = new GuideOutputManager(mountManager)
		const propertyManager = new DevicePropertyManager()

		handler.add(mountManager)
		handler.add(guideOutputManager)
		handler.add(propertyManager)

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
		const propertyManager = new DevicePropertyManager()

		handler.add(mountManager)
		handler.add(guideOutputManager)
		handler.add(propertyManager)

		const client = new ClientSimulator('mount', handler)
		const mountSimulator = new MountSimulator('Mount Simulator', client)

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
		const propertyManager = new DevicePropertyManager()

		handler.add(mountManager)
		handler.add(guideOutputManager)
		handler.add(propertyManager)

		const client = new ClientSimulator('mount', handler)
		const mountSimulator = new MountSimulator('Mount Simulator', client)

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
		const propertyManager = new DevicePropertyManager()

		handler.add(mountManager)
		handler.add(guideOutputManager)
		handler.add(propertyManager)

		const client = new ClientSimulator('mount', handler)
		const mountSimulator = new MountSimulator('Mount Simulator', client)

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
	}, 3000)
})

describe.skipIf(SKIP)('camera simulator', () => {
	test('integrates with camera manager and exposes synthetic image controls', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		const guideOutputManager = new GuideOutputManager(cameraManager)
		const thermometerManager = new ThermometerManager(cameraManager)
		const propertyManager = new DevicePropertyManager()
		const client = new ClientSimulator('camera', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		handler.add(guideOutputManager)
		handler.add(thermometerManager)
		handler.add(propertyManager)

		cameraManager.addHandler(frameReceiver)

		const cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager })
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
		expect(propertyManager.get(client, camera.name)?.SIMULATOR_NOISE_EXPOSURE).toBeDefined()
		expect(propertyManager.get(client, camera.name)?.SIMULATOR_CATALOG_SOURCE).toBeDefined()
		expect(propertyManager.get(client, camera.name)?.SIMULATOR_STAR_PLOT_OPTIONS).toBeDefined()

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_FLAGS', elements: { GAMMA_ENABLED: true } })
		await waitUntil(() => propertyManager.get(client, camera.name)?.SIMULATOR_STAR_PLOT_FLAGS?.elements.GAMMA_ENABLED.value === true)

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
		const propertyManager = new DevicePropertyManager()
		const client = new ClientSimulator('camera.header.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		handler.add(propertyManager)

		cameraManager.addHandler(frameReceiver)

		const mountSimulator = new MountSimulator('Mount Simulator', client)
		const cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager })
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
		await waitUntil(() => propertyManager.get(client, camera.name)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		cameraManager.startExposure(camera, 0.05)
		await waitUntil(() => frameReceiver.length > 0, 5000, 50)
		const image = await readImageFromBuffer(frameReceiver.lastFrame)
		const header = image!.header

		expect(image).toBeDefined()
		expect(header.TELESCOP).toBe('Mount Simulator')
		expect(header.SITELAT).toBeCloseTo(-22, 6)
		expect(header.SITELONG).toBeCloseTo(-45, 6)
		expect(header.RA).toBeCloseTo(329.53, 2)
		expect(header.DEC).toBeCloseTo(-60.125, 2)
		expect(header.OBJCTRA).toBe(formatRA(deg(header.RA as number)))
		expect(header.OBJCTDEC).toBe(formatDEC(deg(header.DEC as number)))
		expect(header.EQUINOX).toBe(2000)

		cameraSimulator.dispose()
		mountSimulator.dispose()
		expect(cameraManager.has(client, camera.name)).toBeFalse()
		expect(mountManager.has(client, mount.name)).toBeFalse()
	}, 5000)

	test('scales flat frames with exposure time', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		const propertyManager = new DevicePropertyManager()
		const client = new ClientSimulator('camera.flat.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		handler.add(propertyManager)

		cameraManager.addHandler(frameReceiver)

		const cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager })
		const camera = cameraManager.get(client, cameraSimulator.name)!

		cameraManager.connect(camera)
		await waitUntil(() => camera.connected)

		cameraManager.frameType(camera, 'FLAT')
		await waitUntil(() => camera.frameType === 'FLAT')
		cameraManager.frame(camera, 0, 0, 64, 64)
		await waitUntil(() => camera.frame.width.value === 64 && camera.frame.height.value === 64)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, MOON_ENABLED: false, LIGHT_POLLUTION_ENABLED: false, AMP_GLOW_ENABLED: false } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_EXPOSURE', elements: { EXPOSURE_TIME: 1 } })
		client.sendNumber({
			device: camera.name,
			name: 'SIMULATOR_NOISE_SENSOR',
			elements: {
				READ_NOISE: 0,
				BIAS_ELECTRONS: 0,
				BLACK_LEVEL_ELECTRONS: 0,
				DARK_CURRENT_AT_REFERENCE_TEMP: 0,
				DARK_SIGNAL_NON_UNIFORMITY: 0,
			},
		})
		client.sendNumber({
			device: camera.name,
			name: 'SIMULATOR_NOISE_ARTIFACTS',
			elements: {
				FIXED_PATTERN_NOISE_STRENGTH: 0,
				ROW_NOISE_STRENGTH: 0,
				COLUMN_NOISE_STRENGTH: 0,
				BANDING_STRENGTH: 0,
				HOT_PIXEL_RATE: 0,
				WARM_PIXEL_RATE: 0,
				DEAD_PIXEL_RATE: 0,
				HOT_PIXEL_STRENGTH: 0,
				WARM_PIXEL_STRENGTH: 0,
				DEAD_PIXEL_RESIDUAL: 0,
			},
		})

		await waitUntil(() => propertyManager.get(client, camera.name)?.SIMULATOR_NOISE_EXPOSURE?.elements.EXPOSURE_TIME.value === 1)

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

	test('projects VizieR stars from the active mount pointing', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		const propertyManager = new DevicePropertyManager()
		const client = new ClientSimulator('camera.vizier.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		handler.add(propertyManager)

		cameraManager.addHandler(frameReceiver)

		const mountSimulator = new MountSimulator('Mount Simulator', client)
		const cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		mountSimulator.syncTo(hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(5), 1e-9))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		cameraManager.snoop(camera, mount)
		await waitUntil(() => propertyManager.get(client, camera.name)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { FLUX_MIN: 12, FLUX_MAX: 48 } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { VIZIER: true } })
		await waitUntil(() => propertyManager.get(client, camera.name)?.SIMULATOR_CATALOG_SOURCE?.elements.VIZIER.value === true)

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

	test('camera sends guiding pulse to mount', async () => {
		const handler = new IndiClientHandlerSet()
		const cameraManager = new CameraManager()
		const mountManager = new MountManager()
		const guideOutputProvider: DeviceProvider<GuideOutput> = { get: (client, name) => mountManager.get(client, name) ?? cameraManager.get(client, name) }
		const guideOutputManager = new GuideOutputManager(guideOutputProvider)

		handler.add(cameraManager)
		handler.add(mountManager)
		handler.add(guideOutputManager)

		const client = new ClientSimulator('mount', handler)
		const cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, guideOutputManager })
		const mountSimulator = new MountSimulator('Mount Simulator', client)

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
		const propertyManager = new DevicePropertyManager()

		handler.add(focuserManager)
		handler.add(wheelManager)
		handler.add(rotatorManager)
		handler.add(flatPanelManager)
		handler.add(coverManager)
		handler.add(thermometerManager)
		handler.add(propertyManager)

		const client = new ClientSimulator('accessories', handler)
		const focuserSimulator = new FocuserSimulator('Focuser Simulator', client)
		const wheelSimulator = new FilterWheelSimulator('Filter Wheel Simulator', client)
		const rotatorSimulator = new RotatorSimulator('Rotator Simulator', client)
		const lightBoxSimulator = new LightBoxSimulator('Light Box Simulator', client)
		const dustCapSimulator = new DustCapSimulator('Dust Cap Simulator', client)

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

		expect(focuser.hasThermometer).toBeTrue()
		expect(focuser.canAbsoluteMove).toBeTrue()
		expect(focuser.canRelativeMove).toBeTrue()
		expect(focuser.canAbort).toBeTrue()
		expect(focuser.canReverse).toBeTrue()
		expect(focuser.canSync).toBeTrue()
		expect(focuser.position.value).toBe(50000)
		expect(propertyManager.get(client, focuser.name)?.FOCUS_TEMPERATURE).toBeDefined()
		expect(propertyManager.get(client, focuser.name)?.FOCUS_TEMPERATURE_COMPENSATION).toBeDefined()

		const initialFocuserTemperature = Number(propertyManager.get(client, focuser.name)?.FOCUS_TEMPERATURE?.elements.TEMPERATURE.value ?? 0)
		await waitUntil(() => Math.abs(Number(propertyManager.get(client, focuser.name)?.FOCUS_TEMPERATURE?.elements.TEMPERATURE.value ?? initialFocuserTemperature) - initialFocuserTemperature) >= 0.05, 3000)

		const compensatedStart = focuser.position.value
		client.sendSwitch({ device: focuser.name, name: 'FOCUS_TEMPERATURE_COMPENSATION', elements: { INDI_ENABLED: true } })
		await waitUntil(() => propertyManager.get(client, focuser.name)?.FOCUS_TEMPERATURE_COMPENSATION?.elements.INDI_ENABLED.value === true)
		await waitUntil(() => focuser.position.value !== compensatedStart, 4000)
		await waitUntil(() => !focuser.moving, 3000)

		client.sendSwitch({ device: focuser.name, name: 'FOCUS_TEMPERATURE_COMPENSATION', elements: { INDI_DISABLED: true } })
		await waitUntil(() => propertyManager.get(client, focuser.name)?.FOCUS_TEMPERATURE_COMPENSATION?.elements.INDI_DISABLED.value === true)

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
	}, 7000)

	test('camera uses focuser position', async () => {
		const handler = new IndiClientHandlerSet()
		const cameraManager = new CameraManager()
		const focuserManager = new FocuserManager()
		const frameReceiver = new CameraFrameReceiver()

		handler.add(cameraManager)
		handler.add(focuserManager)

		cameraManager.addHandler(frameReceiver)

		const client = new ClientSimulator('mount', handler)
		const cameraSimulator = new CameraSimulator('Camera Simulator', client, { focuserManager })
		const focuserSimulator = new FocuserSimulator('Focuser Simulator', client)

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
