import { describe, expect, test } from 'bun:test'
import { equatorialToJ2000 } from '../../../../src/astronomy/coordinates/coordinate'
import { timeNow, timeUnix } from '../../../../src/astronomy/time/time'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import type { GuideOutput, Thermometer } from '../../../../src/devices/indi/device'
import { CameraManager, type DeviceProvider, FocuserManager, GuideOutputManager, MountManager, RotatorManager, ThermometerManager } from '../../../../src/devices/indi/manager'
import { CameraSimulator } from '../../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { FocuserSimulator } from '../../../../src/devices/indi/simulator/focuser'
import { MountSimulator } from '../../../../src/devices/indi/simulator/mount'
import { RotatorSimulator } from '../../../../src/devices/indi/simulator/rotator'
import type { CatalogSource } from '../../../../src/devices/indi/simulator/types'
import { readImageFromBuffer } from '../../../../src/imaging/model/image'
import type { ImageRawType } from '../../../../src/imaging/model/types'
import { mulberry32 } from '../../../../src/math/numerical/random'
import { arcsec, deg, formatDEC, formatRA, hour, normalizePI, toArcsec, toDeg } from '../../../../src/math/units/angle'
import { CameraFrameReceiver, isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated camera acquisition, rendering, metadata, and related devices.

const SKIP = isTimeConsumingTestSkipped()

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
		expect(cameraManager.properties.get(camera)?.SIMULATOR_FLAT_FIELD).toBeDefined()
		expect(cameraManager.properties.get(camera)?.SIMULATOR_FLAT_DUST).toBeDefined()
		expect(cameraManager.properties.get(camera)?.SIMULATOR_FLAT_BANDING).toBeDefined()
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

	test('scales configured flat fields and preserves artifacts through crop and binning', async () => {
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
		const seed = 17.5
		const random = mulberry32(seed >>> 0)
		random()
		random()
		const secondDustX = random() * (cameraSimulator.sensorWidth - 1)
		const secondDustY = random() * (cameraSimulator.sensorHeight - 1)
		const frameX = Math.max(0, Math.min(cameraSimulator.sensorWidth - 64, Math.round(secondDustX) - 32))
		const frameY = Math.max(0, Math.min(cameraSimulator.sensorHeight - 64, Math.round(secondDustY) - 32))
		cameraManager.frame(camera, frameX, frameY, 64, 64)
		await waitUntil(() => camera.frame.x.value === frameX && camera.frame.y.value === frameY && camera.frame.width.value === 64 && camera.frame.height.value === 64)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, MOON_ENABLED: false, LIGHT_POLLUTION_ENABLED: false, AMP_GLOW_ENABLED: false } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { SCENE_SEED: seed } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_EXPOSURE', elements: { EXPOSURE_TIME: 1 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_FLAT_FIELD', elements: { REFERENCE_SIGNAL: 0.5, VIGNETTING: 0, CENTER_OFFSET_X: 0, CENTER_OFFSET_Y: 0, GRADIENT_X: 0, GRADIENT_Y: 0, PRNU: 0 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_FLAT_DUST', elements: { COUNT: 0, SIGMA_X: 8, SIGMA_Y: 8, ANGLE: 0, CONTRAST: 0.5 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_FLAT_BANDING', elements: { ROW_AMPLITUDE: 0, ROW_PERIOD: 16, ROW_PHASE: Math.PI / 2, COLUMN_AMPLITUDE: 0 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_SENSOR', elements: { READ_NOISE: 0, BIAS_ELECTRONS: 0, BLACK_LEVEL_ELECTRONS: 0, DARK_CURRENT_AT_REFERENCE_TEMP: 0, DARK_SIGNAL_NON_UNIFORMITY: 0 } })
		client.sendNumber({
			device: camera.name,
			name: 'SIMULATOR_NOISE_ARTIFACTS',
			elements: { FIXED_PATTERN_NOISE_STRENGTH: 0, ROW_NOISE_STRENGTH: 0, COLUMN_NOISE_STRENGTH: 0, BANDING_STRENGTH: 0, HOT_PIXEL_RATE: 0, WARM_PIXEL_RATE: 0, DEAD_PIXEL_RATE: 0, HOT_PIXEL_STRENGTH: 0, WARM_PIXEL_STRENGTH: 0, DEAD_PIXEL_RESIDUAL: 0 },
		})

		await waitUntil(
			() =>
				cameraManager.properties.get(camera)?.SIMULATOR_NOISE_EXPOSURE?.elements.EXPOSURE_TIME.value === 1 &&
				cameraManager.properties.get(camera)?.SIMULATOR_SCENE?.elements.SCENE_SEED.value === seed &&
				cameraManager.properties.get(camera)?.SIMULATOR_FLAT_FIELD?.elements.REFERENCE_SIGNAL.value === 0.5 &&
				cameraManager.properties.get(camera)?.SIMULATOR_FLAT_DUST?.elements.COUNT.value === 0 &&
				cameraManager.properties.get(camera)?.SIMULATOR_FLAT_DUST?.elements.CONTRAST.value === 0.5 &&
				cameraManager.properties.get(camera)?.SIMULATOR_FLAT_BANDING?.elements.ROW_AMPLITUDE.value === 0,
		)

		cameraManager.startExposure(camera, 0.1)
		await waitUntil(() => frameReceiver.length > 0, 5000, 50)
		const neutralFlat = await readImageFromBuffer(frameReceiver.lastFrame, { sampleScale: 'digital' })
		expect(neutralFlat!.raw[0] / 65535).toBeCloseTo(0.05, 3)

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_FLAT_DUST', elements: { COUNT: 2 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_FLAT_BANDING', elements: { ROW_AMPLITUDE: 0.1 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_FLAT_DUST?.elements.COUNT.value === 2 && cameraManager.properties.get(camera)?.SIMULATOR_FLAT_BANDING?.elements.ROW_AMPLITUDE.value === 0.1)
		cameraManager.startExposure(camera, 0.1)
		await waitUntil(() => frameReceiver.length > 1, 5000, 50)
		const shortFlat = await readImageFromBuffer(frameReceiver.lastFrame, { sampleScale: 'digital' })

		cameraManager.startExposure(camera, 0.2)
		await waitUntil(() => frameReceiver.length > 2, 5000, 50)
		const longFlat = await readImageFromBuffer(frameReceiver.lastFrame, { sampleScale: 'digital' })

		expect(shortFlat).toBeDefined()
		expect(longFlat).toBeDefined()
		expect(sumPixels(longFlat!.raw)).toBeGreaterThan(sumPixels(shortFlat!.raw) * 1.8)
		const dustX = Math.round(secondDustX) - frameX
		const dustY = Math.round(secondDustY) - frameY
		const dustIndex = dustY * 64 + dustX
		expect(shortFlat!.raw[dustIndex]).toBeLessThan(shortFlat!.raw[32])
		expect(shortFlat!.raw[0]).not.toBe(shortFlat!.raw[4 * 64])

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_FLAT_DUST', elements: { COUNT: 1 } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_FLAT_DUST?.elements.COUNT.value === 1)
		cameraManager.startExposure(camera, 0.1)
		await waitUntil(() => frameReceiver.length > 3, 5000, 50)
		const singleDustFlat = await readImageFromBuffer(frameReceiver.lastFrame, { sampleScale: 'digital' })
		expect(singleDustFlat!.raw[dustIndex]).toBeGreaterThan(shortFlat!.raw[dustIndex] * 1.5)

		client.sendNumber({ device: camera.name, name: 'SIMULATOR_FLAT_DUST', elements: { COUNT: 2 } })
		cameraManager.frame(camera, frameX + 16, frameY + 16, 32, 32)
		cameraManager.bin(camera, 2, 1)
		await waitUntil(() => camera.frame.x.value === frameX + 16 && camera.frame.y.value === frameY + 16 && camera.bin.x.value === 2 && camera.bin.y.value === 1 && cameraManager.properties.get(camera)?.SIMULATOR_FLAT_DUST?.elements.COUNT.value === 2)
		cameraManager.startExposure(camera, 0.1)
		await waitUntil(() => frameReceiver.length > 4, 5000, 50)
		const binnedFlat = await readImageFromBuffer(frameReceiver.lastFrame, { sampleScale: 'digital' })
		expect(binnedFlat!.metadata.width).toBe(16)
		expect(binnedFlat!.metadata.height).toBe(32)
		const binnedDustX = Math.round((secondDustX - frameX - 16 - 0.5) / 2)
		const binnedDustY = Math.round(secondDustY) - frameY - 16
		expect(binnedFlat!.raw[binnedDustY * 16 + binnedDustX]).toBeLessThan(binnedFlat!.raw[binnedDustX])

		cameraSimulator.dispose()
		expect(cameraManager.has(client, camera.name)).toBeFalse()
	}, 10000)

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

	test('displaces the synthetic scene by the configured pointing error', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.pointing.error.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)

		cameraManager.addHandler(frameReceiver)

		// A single star exactly at the queried centre lands on the sensor centre when the mount points
		// perfectly, so any displacement of the brightest pixel is the pointing error itself.
		const catalogProvider: CatalogSource = (rightAscension, declination) => [{ snr: 200, hfd: 2, flux: 4000, rightAscension, declination }]

		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { CENTERED: catalogProvider } })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		// Away from the pole, where the polar-alignment model is well conditioned.
		mountSimulator.syncTo(hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })

		try {
			// Baseline with perfect pointing: the star sits at the centre of the sensor.
			client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { CENTERED: true } })
			await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.CENTERED.value === true)

			cameraSimulator.startExposure(0.05)
			await waitUntil(() => frameReceiver.length > 0, 10000, 50)
			const centered = await readImageFromBuffer(frameReceiver.lastFrame)
			const [centeredX, centeredY] = brightestPixel(centered!.raw, centered!.header.NAXIS1 as number, centered!.metadata.channels)

			expect(centeredX).toBeCloseTo((1280 - 1) * 0.5, -1)
			expect(centeredY).toBeCloseTo((1024 - 1) * 0.5, -1)

			// A large polar-alignment error must move the star measurably. The exact displacement
			// depends on the hour angle at render time, so only its presence and bound are asserted.
			client.sendSwitch({ device: mount.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { ALIGNMENT: true } })
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_AZIMUTH_ERROR: 1800, POLAR_ALTITUDE_ERROR: 1800, CONE_ERROR: 0, AXIS_NON_ORTHOGONALITY: 0, RA_INDEX_ERROR: 0, DEC_INDEX_ERROR: 0 } })
			await waitUntil(() => mountSimulator.pointingErrorBound > 0)

			cameraSimulator.startExposure(0.05)
			await waitUntil(() => frameReceiver.length > 1, 10000, 50)
			const shifted = await readImageFromBuffer(frameReceiver.lastFrame)
			const [shiftedX, shiftedY] = brightestPixel(shifted!.raw, shifted!.header.NAXIS1 as number, shifted!.metadata.channels)

			const displacement = Math.hypot(shiftedX - centeredX, shiftedY - centeredY)
			expect(displacement).toBeGreaterThan(5)
			expect(displacement).toBeLessThan(1400)

			// The built-in RANDOM scene must react to the same error. It generates stars directly in
			// pixel space and ignores the catalog centre, so before the displacement moved to the
			// projection stage it was the one source the pointing errors could not reach at all.
			client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { RANDOM: true } })
			await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.RANDOM.value === true)
			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_AZIMUTH_ERROR: 0, POLAR_ALTITUDE_ERROR: 0, CONE_ERROR: 0, AXIS_NON_ORTHOGONALITY: 0, RA_INDEX_ERROR: 0, DEC_INDEX_ERROR: 0 } })
			await waitUntil(() => mountSimulator.pointingErrorBound === 0)

			cameraSimulator.startExposure(0.05)
			await waitUntil(() => frameReceiver.length > 2, 10000, 50)
			const randomAligned = await readImageFromBuffer(frameReceiver.lastFrame)

			client.sendNumber({ device: mount.name, name: 'MOUNT_ALIGNMENT', elements: { POLAR_AZIMUTH_ERROR: 1800, POLAR_ALTITUDE_ERROR: 1800, CONE_ERROR: 0, AXIS_NON_ORTHOGONALITY: 0, RA_INDEX_ERROR: 0, DEC_INDEX_ERROR: 0 } })
			await waitUntil(() => mountSimulator.pointingErrorBound > 0)

			cameraSimulator.startExposure(0.05)
			await waitUntil(() => frameReceiver.length > 3, 10000, 50)
			const randomShifted = await readImageFromBuffer(frameReceiver.lastFrame)

			let changed = 0
			for (let i = 0; i < randomAligned!.raw.length; i++) {
				if (randomAligned!.raw[i] !== randomShifted!.raw[i]) changed++
			}

			expect(changed).toBeGreaterThan(0)

			// The scene margin is derived from the configured error, so the displaced field keeps stars
			// across the whole frame instead of sweeping its trailing edge clean. Compare the mean
			// signal of the two halves along each axis: a scene generated only over the sensor would
			// leave one side markedly darker.
			const width = randomShifted!.header.NAXIS1 as number
			const height = randomShifted!.header.NAXIS2 as number
			const channels = randomShifted!.metadata.channels
			const raw = randomShifted!.raw
			let left = 0
			let right = 0
			let top = 0
			let bottom = 0

			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					let value = 0
					for (let c = 0; c < channels; c++) value += raw[(y * width + x) * channels + c]
					if (x < width / 2) left += value
					else right += value
					if (y < height / 2) top += value
					else bottom += value
				}
			}

			expect(Math.min(left, right) / Math.max(left, right)).toBeGreaterThan(0.5)
			expect(Math.min(top, bottom) / Math.max(top, bottom)).toBeGreaterThan(0.5)
		} finally {
			cameraSimulator.dispose()
			mountSimulator.dispose()
		}
	}, 15000)

	test('keeps stars on the leading edge when the field sweeps during the exposure', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.travel.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		cameraManager.addHandler(frameReceiver)

		// One star at the queried centre and one on each side, just outside the sensor. The outer pair is
		// only reachable because the field sweeps during the exposure, so whether either survives the
		// catalog is exactly the question the margin decides.
		const outerPixels = 700
		const catalogProvider: CatalogSource = (rightAscension, declination) => {
			const offset = arcsec(outerPixels * 2.145) / Math.cos(declination)
			return [
				{ snr: 200, hfd: 2, flux: 40000, rightAscension, declination },
				{ snr: 200, hfd: 2, flux: 40000, rightAscension: rightAscension + offset, declination },
				{ snr: 200, hfd: 2, flux: 40000, rightAscension: rightAscension - offset, declination },
			]
		}

		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { SPREAD: catalogProvider } })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		mountSimulator.syncTo(hour(5), deg(20))
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { SPREAD: true } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.SPREAD.value === true)

		try {
			// The mount points perfectly, so the pointing error contributes no margin at all. What sweeps
			// the field is commanded motion, which the error bound knows nothing about.
			expect(mountSimulator.pointingErrorBound).toBe(0)

			// Half a degree per second for a fifth of a second is a couple of hundred pixels of travel,
			// enough to pull one of the outer stars onto a sensor it started sixty pixels clear of.
			mountSimulator.setSlewRate('SPEED_1')
			mountSimulator.moveWest(true)
			cameraSimulator.startExposure(0.2)
			await waitUntil(() => frameReceiver.length > 0, 10000, 50)
			mountSimulator.moveWest(false)

			const frame = await readImageFromBuffer(frameReceiver.lastFrame)
			const width = frame!.header.NAXIS1 as number
			const height = frame!.header.NAXIS2 as number
			const channels = frame!.metadata.channels
			const raw = frame!.raw
			// Measured against the brightest pixel in the frame rather than an absolute level, since the
			// background sits well above zero even with the sky and light pollution switched off. Every
			// star carries the same flux, so a core anywhere reaches a comparable peak.
			let peak = 0
			for (let i = 0; i < raw.length; i += channels) {
				let value = 0
				for (let c = 0; c < channels; c++) value += raw[i + c]
				peak = Math.max(peak, value)
			}

			let outerLit = 0

			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					if (x >= 200 && x < width - 200) continue
					let value = 0
					for (let c = 0; c < channels; c++) value += raw[(y * width + x) * channels + c]
					if (value > peak * 0.5) outerLit++
				}
			}

			// A scene sized to the sensor alone drops both outer stars before the trail can translate
			// them, so the edges come out with nothing but background.
			expect(outerLit).toBeGreaterThan(0)
		} finally {
			cameraSimulator.dispose()
			mountSimulator.dispose()
		}
	}, 15000)

	test('renders the same frame whether the catalog resolves at once or slowly', async () => {
		// A CatalogSource is explicitly allowed to be asynchronous and network-backed, and the mount
		// keeps ticking while one resolves. Reading the trajectory after the query came back would end
		// the trail at the wrong instant and measure it against a coordinate the mount had since left,
		// so a slow provider would place the field somewhere a fast one did not.
		async function centreOfStar(disturb: boolean, name: string) {
			const handler = new IndiClientHandlerSet()
			const mountManager = new MountManager()
			const cameraManager = new CameraManager()
			using client = new ClientSimulator(name, handler)
			const frameReceiver = new CameraFrameReceiver()

			handler.add(mountManager)
			handler.add(cameraManager)
			cameraManager.addHandler(frameReceiver)

			// Slews the mount while the query is in flight, which is what makes the two readings differ:
			// the interval that follows the query is nothing like the one the exposure covered.
			const catalogProvider: CatalogSource = async (rightAscension, declination) => {
				if (disturb) {
					mountSimulator.setSlewRate('SPEED_6')
					mountSimulator.goTo(mountSimulator.rightAscension + deg(60), mountSimulator.declination)
					await Bun.sleep(600)
				}

				return [{ snr: 200, hfd: 2, flux: 400, rightAscension, declination }]
			}

			using mountSimulator = new MountSimulator('Mount Simulator', client)
			using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { CENTERED: catalogProvider } })
			const mount = mountManager.get(client, mountSimulator.name)!
			const camera = cameraManager.get(client, cameraSimulator.name)!

			mountSimulator.connect()
			cameraSimulator.connect()
			await waitUntil(() => mount.connected && camera.connected)

			mountSimulator.syncTo(hour(5), deg(20))
			await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

			cameraManager.snoop(camera, mount)
			await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

			client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
			client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { CENTERED: true } })
			await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.CENTERED.value === true)

			cameraSimulator.startExposure(0.05)
			await waitUntil(() => frameReceiver.length > 0, 10000, 50)
			const frame = await readImageFromBuffer(frameReceiver.lastFrame)
			const [x, y, v] = brightestPixel(frame!.raw, frame!.header.NAXIS1 as number, frame!.metadata.channels)

			cameraSimulator.dispose()
			mountSimulator.dispose()
			return [x, y, v] as const
		}

		const immediate = await centreOfStar(false, 'camera.catalog.fast')
		const delayed = await centreOfStar(true, 'camera.catalog.slow')

		// The exposure was over before either query went out, so what the mount did afterwards must not
		// reach the frame. Reading the trajectory after the await measured a slew that was still running
		// when the query came back, smearing a star that had in fact been sitting still, so the peak
		// collapsed and the point source left the middle of the sensor.
		expect(delayed[0]).toBe(immediate[0])
		expect(delayed[1]).toBe(immediate[1])
		// The peak is compared in relative terms: the two runs open their shutters at different points of
		// the sidereal drift, so the trail falls on slightly different sub-pixel positions. The failure
		// this guards against collapsed the peak by orders of magnitude.
		expect(Math.abs(delayed[2] / immediate[2] - 1)).toBeLessThan(1e-3)
	}, 20000)

	test('leaves the seeded star field where it was when the scene margin grows', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.margin.stability', handler)
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

		mountSimulator.syncTo(hour(5), deg(20))
		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
		// Bright enough that the brightest pixel of the frame is the brightest star rather than the read
		// noise, and spread over a wide flux range so that one star stands well clear of the rest.
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { FLUX_MIN: 0.05, FLUX_MAX: 100 } })

		// Tracking, so the field holds still between the two frames and any difference between them is
		// the scene changing rather than the sky turning.
		mountSimulator.setTrackingEnabled(true)

		// A periodic error sizes the scene margin, and a worm a day long barely turns over the couple of
		// seconds this takes: the curve stays within a thousandth of a pixel of where it started, so
		// changing its amplitude changes how far beyond the sensor the scene reaches and nothing else.
		client.sendSwitch({ device: mountSimulator.name, name: 'SIMULATOR_ERROR_FEATURES', elements: { PERIODIC_ERROR: true } })
		client.sendNumber({ device: mountSimulator.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_PERIOD: 86400, RA_AMPLITUDE: 30, RA_PHASE: 0, RA_AMPLITUDE_2: 0, RA_AMPLITUDE_3: 0 } })

		async function frameOfStars() {
			const seen = frameReceiver.length
			cameraSimulator.startExposure(0.5)
			await waitUntil(() => frameReceiver.length > seen, 10000, 20)
			const frame = await readImageFromBuffer(frameReceiver.lastFrame)
			return frame!.raw
		}

		const narrow = await frameOfStars()

		// Twenty times the margin, and the field itself must not move.
		client.sendNumber({ device: mountSimulator.name, name: 'MOUNT_PERIODIC_ERROR', elements: { RA_AMPLITUDE: 600 } })

		const wide = await frameOfStars()

		// However far the worm did turn, it is nothing beside a pixel.
		expect(toArcsec(Math.abs(normalizePI(mountSimulator.boresight.rightAscension - mountSimulator.mechanical.rightAscension)))).toBeLessThan(0.2)

		// Compared over the whole frame rather than by the brightest pixel, which several saturated stars
		// can tie for. A star core stands far above the read noise, so a pixel that differs by a quarter
		// of the peak between the two frames is one where a star is present in one and absent in the
		// other. Deriving the layout from the margin rescaled every coordinate, so widening the scene
		// rearranged the sky instead of extending it and every core showed up here.
		let peak = 0
		for (let i = 0; i < narrow.length; i++) peak = Math.max(peak, narrow[i])

		let moved = 0
		for (let i = 0; i < narrow.length; i++) if (Math.abs(narrow[i] - wide[i]) > peak * 0.25) moved++

		expect(peak).toBeGreaterThan(0.1)
		expect(moved).toBe(0)
	}, 15000)

	test('keeps integrating the mount the exposure began on', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.mount.switch', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		cameraManager.addHandler(frameReceiver)

		const catalogProvider: CatalogSource = (rightAscension, declination) => [{ snr: 200, hfd: 2, flux: 400, rightAscension, declination }]

		using first = new MountSimulator('Mount A', client)
		using second = new MountSimulator('Mount B', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { CENTERED: catalogProvider } })
		const mountA = mountManager.get(client, first.name)!
		const mountB = mountManager.get(client, second.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		first.connect()
		second.connect()
		cameraSimulator.connect()
		await waitUntil(() => mountA.connected && mountB.connected && camera.connected)

		// Two mounts at two sites, so the header can be checked to describe one of them and not the other.
		client.sendNumber({ device: first.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: -22, LONG: 315, ELEV: 0 } })
		client.sendNumber({ device: second.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: 40, LONG: 250, ELEV: 0 } })
		await waitUntil(() => mountA.geographicCoordinate.latitude !== 0 && mountB.geographicCoordinate.latitude !== 0)

		// An hour of right ascension apart: fifteen degrees, hundreds of sensors' worth.
		first.syncTo(hour(5), deg(20))
		first.setTrackingEnabled(true)
		second.syncTo(hour(6), deg(20))
		second.setTrackingEnabled(true)

		cameraManager.snoop(camera, mountA)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === first.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { CENTERED: true } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.CENTERED.value === true)

		// The shutter opens on A, and the telescope is switched under it before the camera has noticed
		// the exposure finished.
		cameraSimulator.startExposure(0.001)
		cameraManager.snoop(camera, mountB)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === second.name)

		await waitUntil(() => frameReceiver.length > 0, 10000, 20)
		const frame = await readImageFromBuffer(frameReceiver.lastFrame)
		const [x, y] = brightestPixel(frame!.raw, frame!.header.NAXIS1 as number, frame!.metadata.channels)

		// Looking the mount up again at render time drew B's trajectory around A's catalog centre, which
		// is fifteen degrees of offset and throws the star clean off the sensor.
		expect(Math.abs(x - (1280 - 1) * 0.5)).toBeLessThan(5)
		expect(Math.abs(y - (1024 - 1) * 0.5)).toBeLessThan(5)

		// And the header names the mount whose sky this is. Stamping A's geometry with B's name and site
		// would leave nothing in the file to reveal the mismatch.
		expect(frame!.header.TELESCOP).toBe(first.name)
		expect(frame!.header.SITELAT).toBeCloseTo(toDeg(mountA.geographicCoordinate.latitude), 6)
		expect(frame!.header.SITELONG).toBeCloseTo(toDeg(mountA.geographicCoordinate.longitude), 6)
	}, 15000)

	test('integrates the interval the shutter was open, not the one before the frame arrived', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.deadline', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		cameraManager.addHandler(frameReceiver)

		// One star, pinned to wherever the very first query was centred and then never moving again, so
		// where it lands on the sensor reports which coordinate the frame was built around. It has to be
		// learnt from a query rather than written down here, because a catalog is queried and projected
		// in J2000 while the mount reports the frame of date.
		let anchor: readonly [number, number] | undefined
		const catalogProvider: CatalogSource = (rightAscension, declination) => {
			anchor ??= [rightAscension, declination]
			return [{ snr: 200, hfd: 2, flux: 400, rightAscension: anchor[0], declination: anchor[1] }]
		}

		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { CENTERED: catalogProvider } })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		mountSimulator.syncTo(hour(5), deg(20))
		mountSimulator.setTrackingEnabled(true)
		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { CENTERED: true } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.CENTERED.value === true)

		// A first frame, taken with the mount still, teaches the provider where the field is.
		cameraSimulator.startExposure(0.001)
		await waitUntil(() => frameReceiver.length > 0, 10000, 20)
		expect(anchor).toBeDefined()

		// A millisecond of exposure, and then the mount is driven while the camera has not yet noticed
		// that the shutter closed: its tick is a hundred times the exposure. None of that motion belongs
		// in the frame.
		cameraSimulator.startExposure(0.001)
		mountSimulator.setSlewRate('SPEED_1')
		mountSimulator.moveEast(true)

		await waitUntil(() => frameReceiver.length > 1, 10000, 20)
		mountSimulator.moveEast(false)

		const frame = await readImageFromBuffer(frameReceiver.lastFrame)
		const [x, y] = brightestPixel(frame!.raw, frame!.header.NAXIS1 as number, frame!.metadata.channels)

		// Measuring the window back from the moment the frame was rendered put it entirely after the
		// exposure, so the star was drawn along a slew it never saw: it ended up 583 pixels away, most of
		// the way to the edge of the sensor.
		//
		// A dozen pixels of leakage survive, and are the resolution of the simulation rather than of the
		// anchoring: the mount records its trajectory once per tick, so a one-millisecond exposure is a
		// one per cent slice of a tick through which the mount is interpolated as having moved evenly.
		expect(Math.abs(x - (1280 - 1) * 0.5)).toBeLessThan(20)
		expect(Math.abs(y - (1024 - 1) * 0.5)).toBeLessThan(20)
	}, 15000)

	test('queries the catalog at the epoch the mount believes in', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.epoch', handler)

		handler.add(mountManager)
		handler.add(cameraManager)

		const frameReceiver = new CameraFrameReceiver()
		cameraManager.addHandler(frameReceiver)

		let queried: readonly [number, number] | undefined

		const catalogProvider: CatalogSource = (rightAscension, declination) => {
			queried = [rightAscension, declination]
			return [{ snr: 200, hfd: 2, flux: 400, rightAscension, declination }]
		}

		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { EPOCH: catalogProvider } })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		mountSimulator.syncTo(hour(5), deg(20))
		// Tracking holds the reported coordinate at exactly the synced one, so the query can be compared
		// against a conversion of that coordinate rather than of wherever the sky had carried it.
		mountSimulator.setTrackingEnabled(true)
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { EPOCH: true } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.EPOCH.value === true)

		// The mount is told it is 2000, a quarter century before the wall clock.
		const utc = Date.parse('2000-01-01T12:00:00Z')
		mountSimulator.setTime({ utc, offset: 0 })

		cameraSimulator.startExposure(0.001)
		await waitUntil(() => queried !== undefined, 10000, 20)

		// The coordinate the mount reports belongs to the frame of its own date, so that is the epoch the
		// rotation into J2000 has to use. Nutation still moves it by a few arcseconds at this epoch, which
		// is why the query is compared against the conversion rather than against the coordinate itself.
		const [atMountEpoch, atMountEpochDeclination] = equatorialToJ2000(hour(5), deg(20), timeUnix(utc / 1000, true))
		expect(toArcsec(Math.abs(normalizePI(queried![0] - atMountEpoch)))).toBeLessThan(0.1)
		expect(toArcsec(Math.abs(queried![1] - atMountEpochDeclination))).toBeLessThan(0.1)

		// Rotating by today's precession instead lands about twenty arcminutes away, on a field the mount
		// is not pointing at, in a frame stamped with the mount's own timestamp.
		const [atWallClock] = equatorialToJ2000(hour(5), deg(20), timeNow(true))
		expect(toArcsec(Math.abs(normalizePI(atWallClock - atMountEpoch)))).toBeGreaterThan(300)

		// And the header has to name the field that was drawn, on the same epoch: a frame whose RA/DEC
		// keywords disagree with its own pixels is worse than one with none at all.
		await waitUntil(() => frameReceiver.length > 0, 10000, 20)
		const frame = await readImageFromBuffer(frameReceiver.lastFrame)
		expect(toArcsec(Math.abs(normalizePI(deg(frame!.header.RA as number) - atMountEpoch)))).toBeLessThan(0.1)
		expect(toArcsec(Math.abs(deg(frame!.header.DEC as number) - atMountEpochDeclination))).toBeLessThan(0.1)
	}, 15000)

	test('centres the catalog on the coordinate the trajectory is measured against', async () => {
		// The catalog is projected around the reported coordinate and the trajectory offsets are measured
		// from it, so the two have to be the same reading. Taking the catalog centre from the snooped INDI
		// state instead lets it lag by up to a notification interval, which puts the whole star field at
		// an offset from a centre it was never projected around.
		async function centreOfStar(notifyInterval: number, name: string) {
			const handler = new IndiClientHandlerSet()
			const mountManager = new MountManager()
			const cameraManager = new CameraManager()
			using client = new ClientSimulator(name, handler)
			const frameReceiver = new CameraFrameReceiver()

			handler.add(mountManager)
			handler.add(cameraManager)
			cameraManager.addHandler(frameReceiver)

			// A star fixed on the sky rather than at whatever the query asks for, so where it lands on the
			// sensor reports which coordinate the scene was built around.
			const catalogProvider: CatalogSource = () => [{ snr: 200, hfd: 2, flux: 400, rightAscension: hour(5), declination: deg(20) }]

			using mountSimulator = new MountSimulator('Mount Simulator', client)
			using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { FIXED: catalogProvider } })
			const mount = mountManager.get(client, mountSimulator.name)!
			const camera = cameraManager.get(client, cameraSimulator.name)!

			mountSimulator.connect()
			cameraSimulator.connect()
			await waitUntil(() => mount.connected && camera.connected)

			mountSimulator.syncTo(hour(5), deg(20))
			await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

			cameraManager.snoop(camera, mount)
			await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

			client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
			client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { FIXED: true } })
			await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.FIXED.value === true)

			// Moved by the sky rather than by a command, because starting and finishing a slew publishes
			// the coordinate vector on its own and would refresh the snooped copy no matter the throttle.
			// Run back to back with no await between them, so the simulation timer cannot fire in the
			// middle and both runs see exactly the same twenty seconds of drift; tracking then freezes the
			// coordinate so the frame does not depend on when the exposure is taken.
			mountSimulator.minimumNotifyCoordinateInterval = notifyInterval
			mountSimulator.setTrackingEnabled(false)
			mountSimulator.syncTo(hour(5), deg(20))
			mountSimulator.advance(20)
			mountSimulator.setTrackingEnabled(true)

			cameraSimulator.startExposure(0.001)
			await waitUntil(() => frameReceiver.length > 0, 10000, 20)
			const frame = await readImageFromBuffer(frameReceiver.lastFrame)
			const [x, y] = brightestPixel(frame!.raw, frame!.header.NAXIS1 as number, frame!.metadata.channels)

			cameraSimulator.dispose()
			mountSimulator.dispose()
			return [x, y] as const
		}

		// Twenty seconds of sidereal drift is five arcminutes, and at about two arcseconds per pixel that
		// is well over a hundred pixels: a star fixed on the sky has to land far from the middle of a
		// sensor centred where the mount now points, and lands in the middle of one centred where the
		// snooped copy still thinks it does.
		const published = await centreOfStar(1, 'camera.centre.fresh')
		const lagging = await centreOfStar(60000, 'camera.centre.stale')

		expect(Math.abs(published[0] - 639)).toBeGreaterThan(100)

		// Compared to within a pixel rather than exactly: which pixel of a star core comes out brightest
		// depends on the noise, and the sensor temperature moves with the wall clock between the two runs.
		expect(Math.abs(lagging[0] - published[0])).toBeLessThanOrEqual(1)
		expect(Math.abs(lagging[1] - published[1])).toBeLessThanOrEqual(1)
	}, 30000)

	test('keeps its own trajectory when a second exposure starts while the catalog is pending', async () => {
		// An exposure is marked complete before its frame has been rendered, so a client is free to start
		// the next one while the first is still waiting on a network-backed catalog. The second exposure
		// then computes its own offsets, and the first must not be rendered with them.
		async function centreOfStar(disturb: boolean, name: string) {
			const handler = new IndiClientHandlerSet()
			const mountManager = new MountManager()
			const cameraManager = new CameraManager()
			using client = new ClientSimulator(name, handler)
			const frameReceiver = new CameraFrameReceiver()

			handler.add(mountManager)
			handler.add(cameraManager)
			cameraManager.addHandler(frameReceiver)

			let queries = 0

			// Only the first query is slow, which is what leaves the first frame pending while the second
			// exposure runs to completion.
			const catalogProvider: CatalogSource = async (rightAscension, declination) => {
				if (++queries === 1) await Bun.sleep(600)
				return [{ snr: 200, hfd: 2, flux: 400, rightAscension, declination }]
			}

			using mountSimulator = new MountSimulator('Mount Simulator', client)
			using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { CENTERED: catalogProvider } })
			const mount = mountManager.get(client, mountSimulator.name)!
			const camera = cameraManager.get(client, cameraSimulator.name)!

			mountSimulator.connect()
			cameraSimulator.connect()
			await waitUntil(() => mount.connected && camera.connected)

			mountSimulator.syncTo(hour(5), deg(20))
			await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

			cameraManager.snoop(camera, mount)
			await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

			client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
			client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { CENTERED: true } })
			await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.CENTERED.value === true)

			cameraSimulator.startExposure(0.05)
			await waitUntil(() => queries > 0, 5000, 5)

			if (disturb) {
				// A second exposure taken over a long slew, so its trail sweeps the field right across the
				// sensor and is nothing like the still field the first exposure saw.
				mountSimulator.setSlewRate('SPEED_6')
				mountSimulator.goTo(mountSimulator.rightAscension + deg(60), mountSimulator.declination)
				cameraSimulator.startExposure(0.3)
				await waitUntil(() => frameReceiver.length > 0, 5000, 10)
			}

			// The first frame resolves last, since only its query was slow.
			await waitUntil(() => frameReceiver.length > (disturb ? 1 : 0), 10000, 50)
			const frame = await readImageFromBuffer(frameReceiver.lastFrame)
			const [x, y] = brightestPixel(frame!.raw, frame!.header.NAXIS1 as number, frame!.metadata.channels)

			cameraSimulator.dispose()
			mountSimulator.dispose()
			return [x, y] as const
		}

		const alone = await centreOfStar(false, 'camera.offsets.alone')
		const overlapped = await centreOfStar(true, 'camera.offsets.overlapped')

		// Handing back a view of the shared trajectory buffer let the second exposure rewrite the first
		// exposure's offsets under it, so the still field was drawn along the slew the second one covered.
		expect(overlapped[0]).toBe(alone[0])
		expect(overlapped[1]).toBe(alone[1])
	}, 30000)

	test('conserves flux and trails the stars when the field moves during the exposure', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.trailing.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)

		cameraManager.addHandler(frameReceiver)

		// Faint enough that no pixel saturates even when the whole exposure lands on one spot, so the
		// totals stay linear and the two frames are comparable.
		const catalogProvider: CatalogSource = (rightAscension, declination) => [{ snr: 200, hfd: 2, flux: 0.05, rightAscension, declination }]

		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { CENTERED: catalogProvider } })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		mountSimulator.syncTo(hour(5), deg(20))
		mountSimulator.setTrackingEnabled(true)
		await waitUntil(() => closeTo(mount.equatorialCoordinate.declination, deg(20), 1e-9))

		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		// A bare, unclipped star field: any change in the total signal then comes from the star itself
		// rather than from noise or from saturation flattening the peak.
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_SENSOR', elements: { READ_NOISE: 0, BIAS_ELECTRONS: 0, BLACK_LEVEL_ELECTRONS: 0, DARK_CURRENT_AT_REFERENCE_TEMP: 0 } })
		// Without this the brightest pixel of a thinly spread trail is a hot pixel rather than the star.
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_ARTIFACTS', elements: { FIXED_PATTERN_NOISE_STRENGTH: 0, ROW_NOISE_STRENGTH: 0, COLUMN_NOISE_STRENGTH: 0, BANDING_STRENGTH: 0, HOT_PIXEL_RATE: 0, WARM_PIXEL_RATE: 0, DEAD_PIXEL_RATE: 0 } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_CLAMP_MODE', elements: { NONE: true } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { CENTERED: true } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.CENTERED.value === true)

		try {
			// Both frames run for the same time, so the expected ratio of their totals is exactly one and
			// the comparison isolates the trajectory split from any exposure scaling.
			const exposure = 2

			// Matching the reference exposure makes the flux scale exactly one, leaving the trajectory
			// split as the only thing that can change the total.
			client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_EXPOSURE', elements: { EXPOSURE_TIME: exposure } })
			await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_NOISE_EXPOSURE?.elements.EXPOSURE_TIME.value === exposure)

			// A long focal length so the sidereal drift of this exposure spans many times the width of
			// the point spread function. At the default 500 mm the trail is comparable to the star and
			// only shows as a slight elongation.
			client.sendNumber({ device: camera.name, name: 'TELESCOPE_INFO', elements: { FOCAL_LENGTH: 2000 } })
			await waitUntil(() => cameraManager.properties.get(camera)?.TELESCOPE_INFO?.elements.FOCAL_LENGTH.value === 2000)

			// Stationary reference: the mount tracks, so the field barely moves and one sample is used.
			cameraSimulator.startExposure(exposure)
			await waitUntil(() => frameReceiver.length > 0, 20000, 50)
			const stationary = await readImageFromBuffer(frameReceiver.lastFrame)
			const stationaryFlux = sumPixels(stationary!.raw)
			const [, , stationaryPeak] = brightestPixel(stationary!.raw, stationary!.header.NAXIS1 as number, stationary!.metadata.channels)

			expect(stationaryFlux).toBeGreaterThan(0)

			// With tracking off the sky runs at the sidereal rate, which over this exposure is several
			// pixels of drift and therefore a trail spread over many samples.
			mountSimulator.setTrackingEnabled(false)
			await waitUntil(() => !mount.tracking)

			cameraSimulator.startExposure(exposure)
			await waitUntil(() => frameReceiver.length > 1, 20000, 50)
			const trailed = await readImageFromBuffer(frameReceiver.lastFrame)
			const trailedFlux = sumPixels(trailed!.raw)
			const [, , trailedPeak] = brightestPixel(trailed!.raw, trailed!.header.NAXIS1 as number, trailed!.metadata.channels)

			// Spread along a trail, the same light no longer piles onto one pixel, so the peak drops.
			expect(trailedPeak).toBeLessThan(stationaryPeak * 0.5)

			// Yet it is only redistributed, never created or lost. Without dividing each sample's flux by
			// the sample count this would come out multiplied by the number of samples, so the bound is
			// wide enough for the rounding and still nowhere near that.
			//
			// The residual excess is quantization: spread along a trail, faint wing pixels that rounded
			// down to zero when concentrated now sit above half a count and round up instead.
			const ratio = trailedFlux / stationaryFlux
			expect(ratio).toBeGreaterThan(0.85)
			expect(ratio).toBeLessThan(1.2)
		} finally {
			cameraSimulator.dispose()
			mountSimulator.dispose()
		}
	}, 30000)

	test('does not draw the field it left back at the centre of the frame', async () => {
		const handler = new IndiClientHandlerSet()
		const mountManager = new MountManager()
		const cameraManager = new CameraManager()
		using client = new ClientSimulator('camera.offdomain.simulator', handler)
		const frameReceiver = new CameraFrameReceiver()

		handler.add(mountManager)
		handler.add(cameraManager)
		cameraManager.addHandler(frameReceiver)

		const catalogProvider: CatalogSource = (rightAscension, declination) => [{ snr: 200, hfd: 2, flux: 0.05, rightAscension, declination }]

		using mountSimulator = new MountSimulator('Mount Simulator', client)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { mountManager, catalogSources: { CENTERED: catalogProvider } })
		const mount = mountManager.get(client, mountSimulator.name)!
		const camera = cameraManager.get(client, cameraSimulator.name)!

		mountSimulator.connect()
		cameraSimulator.connect()
		await waitUntil(() => mount.connected && camera.connected)

		// On the equator, so a difference of right ascension is the same angle on the sky.
		mountSimulator.syncTo(hour(5), 0)
		mountSimulator.setTrackingEnabled(true)
		mountSimulator.setSlewRate('SPEED_7')
		await waitUntil(() => closeTo(mount.equatorialCoordinate.rightAscension, hour(5), 1e-9))

		cameraManager.snoop(camera, mount)
		await waitUntil(() => cameraManager.properties.get(camera)?.ACTIVE_DEVICES?.elements.ACTIVE_TELESCOPE.value === mount.name)

		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_SENSOR', elements: { READ_NOISE: 0, BIAS_ELECTRONS: 0, BLACK_LEVEL_ELECTRONS: 0, DARK_CURRENT_AT_REFERENCE_TEMP: 0 } })
		client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_ARTIFACTS', elements: { FIXED_PATTERN_NOISE_STRENGTH: 0, ROW_NOISE_STRENGTH: 0, COLUMN_NOISE_STRENGTH: 0, BANDING_STRENGTH: 0, HOT_PIXEL_RATE: 0, WARM_PIXEL_RATE: 0, DEAD_PIXEL_RATE: 0 } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_CLAMP_MODE', elements: { NONE: true } })
		client.sendSwitch({ device: camera.name, name: 'SIMULATOR_CATALOG_SOURCE', elements: { CENTERED: true } })
		await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_CATALOG_SOURCE?.elements.CENTERED.value === true)

		try {
			const exposure = 2
			client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_EXPOSURE', elements: { EXPOSURE_TIME: exposure } })
			await waitUntil(() => cameraManager.properties.get(camera)?.SIMULATOR_NOISE_EXPOSURE?.elements.EXPOSURE_TIME.value === exposure)

			// All of the light, in the field the scene is built around: the scale the slewed frame below is
			// measured against.
			cameraSimulator.startExposure(exposure)
			await waitUntil(() => frameReceiver.length > 0, 20000, 50)
			const stationary = await readImageFromBuffer(frameReceiver.lastFrame)
			const stationaryFlux = sumPixels(stationary!.raw)
			expect(stationaryFlux).toBeGreaterThan(0)

			// The shutter opens and the mount is sent a hundred and fifty degrees away, well outside the
			// gnomonic domain of the field it started in, where it then sits for the rest of the exposure.
			cameraSimulator.startExposure(exposure)
			mountSimulator.goTo(hour(15), 0)
			await waitUntil(() => frameReceiver.length > 1, 20000, 50)
			const slewed = await readImageFromBuffer(frameReceiver.lastFrame)

			// This field crossed the sensor in the first few milliseconds of the goto and was gone. Mapping
			// the samples the projection could not answer for onto the centre of the sensor instead put it
			// back, at the weight of the whole stretch the mount spent parked at the far end.
			expect(sumPixels(slewed!.raw)).toBeLessThan(stationaryFlux * 0.05)
		} finally {
			cameraSimulator.dispose()
			mountSimulator.dispose()
		}
	}, 30000)

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
