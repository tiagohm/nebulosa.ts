import { describe, expect, test } from 'bun:test'
import { DEFAULT_CAMERA_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/camera.config'
import { CameraNoise, cameraNoiseConfig, type CameraNoiseFrame } from '../../../../src/devices/indi/simulator/camera.noise'
import { TestBus } from '../../../util/bus'

// Unit coverage of how the camera's noise circuit shapes the generator configuration of each frame.

const NOISE = DEFAULT_CAMERA_SIMULATOR_CONFIG.noise
const LIGHT: CameraNoiseFrame = { frameType: 'LIGHT', exposureTime: 30, temperature: -5, gain: 100, offset: 10, seed: 42 }

describe('camera noise', () => {
	test('applies gain, offset, temperature and seed to a light frame', () => {
		const noise = new CameraNoise(new TestBus(), NOISE, 0.001, 3600)
		const config = noise.configFor(LIGHT)
		expect(config.seed).toBe(42)
		expect(config.exposure?.exposureTime).toBe(30)
		expect(config.exposure?.analogGain).toBeCloseTo(NOISE.exposure.analogGain * 2, 12)
		expect(config.sensor?.biasElectrons).toBe(NOISE.sensor.biasElectrons + 20)
		expect(config.sensor?.temperature).toBe(-5)
		expect(config.sky?.enabled).toBe(NOISE.sky.enabled)
		expect(config.lightPollution?.enabled).toBe(NOISE.lightPollution.enabled)
		expect(config.atmosphere).toEqual(NOISE.atmosphere)
		expect(config.output).toEqual(NOISE.output)
	})

	test('shapes calibration frames like real ones', () => {
		const noise = new CameraNoise(new TestBus(), { ...NOISE, sensor: { ...NOISE.sensor, ampGlow: { ...NOISE.sensor.ampGlow, enabled: true } } }, 0.001, 3600)
		const published = noise.snapshot()

		const bias = cameraNoiseConfig(noise.config, published, { ...LIGHT, frameType: 'BIAS' }, 0.001)
		expect(bias.exposure?.exposureTime).toBe(0.001)
		expect(bias.sky?.enabled).toBeFalse()
		expect(bias.sensor?.ampGlow?.enabled).toBeFalse()

		const dark = cameraNoiseConfig(noise.config, published, { ...LIGHT, frameType: 'DARK' }, 0.001)
		expect(dark.sky?.enabled).toBeFalse()
		expect(dark.moon?.enabled).toBeFalse()
		expect(dark.sensor?.ampGlow?.enabled).toBeTrue()

		const flat = cameraNoiseConfig(noise.config, published, { ...LIGHT, frameType: 'FLAT' }, 0.001)
		expect(flat.sky?.globalOffset).toBeCloseTo(NOISE.sky.globalOffset + 0.2, 12)
		expect(flat.atmosphere?.twilightContribution).toBe(0.3)
	})

	test('publishes the tuned parameters and keeps the rest fixed', () => {
		const bus = new TestBus()
		const noise = new CameraNoise(bus, NOISE, 0.001, 3600)
		expect(noise.properties.map((e) => e.name)).toEqual(['SIMULATOR_NOISE_QUALITY', 'SIMULATOR_NOISE_FEATURES', 'SIMULATOR_NOISE_EXPOSURE', 'SIMULATOR_NOISE_SKY', 'SIMULATOR_NOISE_SENSOR', 'SIMULATOR_NOISE_AMP_GLOW', 'SIMULATOR_NOISE_AMP_GLOW_POSITION', 'SIMULATOR_NOISE_ARTIFACTS'])

		noise.handleNumber({ device: '', name: 'SIMULATOR_NOISE_EXPOSURE', elements: { EXPOSURE_TIME: 2 } })
		noise.handleSwitch({ device: '', name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false } })
		noise.handleSwitch({ device: '', name: 'SIMULATOR_NOISE_QUALITY', elements: { FAST: true } })
		noise.handleSwitch({ device: '', name: 'SIMULATOR_NOISE_AMP_GLOW_POSITION', elements: { TOP: true } })
		expect(bus.take()).toEqual(['SIMULATOR_NOISE_EXPOSURE', 'SIMULATOR_NOISE_FEATURES', 'SIMULATOR_NOISE_QUALITY', 'SIMULATOR_NOISE_AMP_GLOW_POSITION'])

		const config = noise.configFor(LIGHT)
		expect(noise.referenceExposure).toBe(2)
		expect(config.quality).toBe('fast')
		expect(config.sky?.enabled).toBeFalse()
		expect(config.sensor?.ampGlow?.position).toBe('top')
		expect(noise.handleNumber({ device: '', name: 'SIMULATOR_NOISE_MOON', elements: {} })).toBeFalse()
	})
})
