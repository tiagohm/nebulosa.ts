import { describe, expect, test } from 'bun:test'
import { adf } from '../src/image.computation'
import { type AstronomicalImageNoiseConfig, type AstronomicalImageStar, generateNoiseImage, generateStarImage } from '../src/image.generator'
import { stf } from '../src/image.transformation'
import type { Image } from '../src/image.types'
import { mulberry32 } from '../src/random'
import { meanOf, standardDeviationOf } from '../src/util'
import { saveImageAndCompareHash } from './image.util'

interface GenerateImageScenario {
	readonly name: string
	readonly channels: 1 | 3
	readonly config: AstronomicalImageNoiseConfig
	readonly hash?: string
}

function baseConfig(overrides: AstronomicalImageNoiseConfig = {}): AstronomicalImageNoiseConfig {
	return {
		seed: overrides.seed ?? 0x5f3759df,
		quality: overrides.quality ?? 'balanced',
		exposure: {
			exposureTime: 60,
			analogGain: 1,
			digitalGain: 1,
			electronsPerAdu: 1,
			...overrides.exposure,
		},
		sky: {
			enabled: false,
			baseRate: 0,
			globalOffset: 0,
			gradientStrength: 0,
			radialGradientStrength: 0,
			lowFrequencyVariationStrength: 0,
			perChannelMultipliers: [1, 1, 1],
			colorBias: [1, 1, 1],
			filterTransmission: [1, 1, 1],
			...overrides.sky,
		},
		moon: {
			enabled: false,
			illuminationFraction: 0,
			altitude: 0.5,
			angularDistance: 1,
			positionAngle: 0,
			tint: [1, 1, 1],
			strength: 1,
			...overrides.moon,
		},
		lightPollution: {
			enabled: false,
			strength: 0,
			direction: 0,
			gradientStrength: 0,
			domeSharpness: 1,
			tint: [1, 1, 1],
			...overrides.lightPollution,
		},
		atmosphere: {
			airglowStrength: 0,
			transparency: 1,
			airmass: 1,
			haze: 0,
			humidity: 0,
			thinCloudVeil: 0,
			twilightContribution: 0,
			horizonGlow: 0,
			zodiacalLightFactor: 0,
			milkyWayBackgroundFactor: 0,
			...overrides.atmosphere,
		},
		sensor: {
			readNoise: 0,
			channelReadNoise: [1, 1, 1],
			channelGain: [1, 1, 1],
			biasElectrons: 0,
			blackLevelElectrons: 0,
			channelBiasElectrons: [0, 0, 0],
			darkCurrentAtReferenceTemp: 0,
			referenceTemperature: -10,
			temperature: -10,
			temperatureDoublingInterval: 6,
			darkSignalNonUniformity: 0,
			fullWellCapacity: 60000,
			channelCorrelation: 0,
			ampGlow: {
				enabled: false,
				strength: 0,
				position: 'right',
				radiusX: 0.2,
				radiusY: 0.3,
				falloff: 3.5,
				tint: [1, 1, 1],
			},
			...overrides.sensor,
		},
		artifacts: {
			fixedPatternNoiseStrength: 0,
			rowNoiseStrength: 0,
			columnNoiseStrength: 0,
			bandingStrength: 0,
			bandingFrequency: 2,
			hotPixelRate: 0,
			warmPixelRate: 0,
			deadPixelRate: 0,
			hotPixelStrength: 0,
			warmPixelStrength: 0,
			deadPixelResidual: 0,
			...overrides.artifacts,
		},
		output: {
			bitDepth: 16,
			clampMode: 'none',
			quantize: false,
			...overrides.output,
		},
	}
}

function channelMean(values: Float64Array, channel: number) {
	let sum = 0
	let count = 0

	for (let i = channel; i < values.length; i += 3) {
		sum += values[i]
		count++
	}

	return sum / Math.max(1, count)
}

function rowMeanStd(values: Float64Array, width: number, height: number) {
	const rows = new Float64Array(height)

	for (let y = 0; y < height; y++) {
		let sum = 0
		const offset = y * width
		for (let x = 0; x < width; x++) sum += values[offset + x]
		rows[y] = sum / width
	}

	return standardDeviationOf(rows)
}

function columnMeanStd(values: Float64Array, width: number, height: number) {
	const columns = new Float64Array(width)

	for (let x = 0; x < width; x++) {
		let sum = 0
		for (let y = 0; y < height; y++) sum += values[y * width + x]
		columns[x] = sum / height
	}

	return standardDeviationOf(columns)
}

describe('generate astronomical image noise', () => {
	test('keeps the image unchanged when all components are disabled', () => {
		const raw = new Float64Array([0.1, 0.3, 0.5, 0.7])
		const before = new Float64Array(raw)

		generateNoiseImage(raw, 2, 2, 1, baseConfig())

		expect(raw).toEqual(before)
	})

	test('is deterministic for a fixed seed and exposes requested debug maps', () => {
		const width = 16
		const height = 12
		const a = new Float64Array(width * height)
		const b = new Float64Array(width * height)
		const config = baseConfig({
			sky: { enabled: true, baseRate: 0.4, gradientStrength: 0.2, radialGradientStrength: 0.1, lowFrequencyVariationStrength: 0.08 },
			moon: { enabled: true, illuminationFraction: 0.75, altitude: 0.8, angularDistance: 0.35, positionAngle: 0.7 },
			sensor: { readNoise: 2.2, darkCurrentAtReferenceTemp: 0.05, ampGlow: { enabled: true, strength: 0.08, position: 'bottom-right', radiusX: 0.25, radiusY: 0.3, falloff: 4, tint: [1.1, 0.9, 0.7] } },
		})

		const ra = generateNoiseImage(a, width, height, 1, config)
		const rb = generateNoiseImage(b, width, height, 1, config)

		expect(a).toEqual(b)
		expect(ra.stats).toEqual(rb.stats)
	})

	test('validates the buffer length against dimensions and layout', () => {
		expect(() => generateNoiseImage(new Float64Array(3), 2, 2, 1, baseConfig())).toThrow()
		expect(() => generateNoiseImage(new Float64Array(4), 2, 2, 3, { ...baseConfig() })).toThrow()
	})

	test('keeps RGB channel means aligned under neutral channel settings', () => {
		const width = 96
		const height = 64
		const raw = new Float64Array(width * height * 3)
		const config = baseConfig({ sky: { enabled: true, baseRate: 0.8, perChannelMultipliers: [1, 1, 1], colorBias: [1, 1, 1], filterTransmission: [1, 1, 1] } })

		generateNoiseImage(raw, width, height, 3, config)

		const red = channelMean(raw, 0)
		const green = channelMean(raw, 1)
		const blue = channelMean(raw, 2)
		expect(Math.abs(red - green)).toBeLessThan(4e-4)
		expect(Math.abs(green - blue)).toBeLessThan(4e-4)
	})

	test('applies moonlight and first-channel sky scaling in monochrome mode', () => {
		const width = 192
		const height = 128
		const base = new Float64Array(width * height)
		const moonlit = new Float64Array(width * height)
		const filtered = new Float64Array(width * height)

		generateNoiseImage(base, width, height, 1, baseConfig({ sky: { enabled: true, baseRate: 0.2, perChannelMultipliers: [1, 1, 1], colorBias: [1, 1, 1], filterTransmission: [1, 1, 1] } }))
		generateNoiseImage(
			moonlit,
			width,
			height,
			1,
			baseConfig({ sky: { enabled: true, baseRate: 0.2, perChannelMultipliers: [1, 1, 1], colorBias: [1, 1, 1], filterTransmission: [1, 1, 1] }, moon: { enabled: true, illuminationFraction: 0.9, altitude: 0.85, angularDistance: 0.35, positionAngle: 0.65, tint: [1.08, 1, 0.92], strength: 1.2 } }),
		)
		generateNoiseImage(filtered, width, height, 1, baseConfig({ sky: { enabled: true, baseRate: 0.2, perChannelMultipliers: [0.55, 1, 1], colorBias: [0.9, 1, 1], filterTransmission: [0.35, 1, 1] } }))

		expect(meanOf(moonlit)).toBeGreaterThan(meanOf(base) * 1.2)
		expect(meanOf(filtered)).toBeLessThan(meanOf(base) * 0.35)
	})

	test('matches the configured read-noise scale approximately', () => {
		const width = 128
		const height = 128
		const raw = new Float64Array(width * height)
		const result = generateNoiseImage(raw, width, height, 1, baseConfig({ sensor: { readNoise: 4, fullWellCapacity: 60000 } }))

		const expected = 4 / result.stats.saturationElectrons
		const measured = standardDeviationOf(raw)
		expect(measured).toBeGreaterThan(expected * 0.8)
		expect(measured).toBeLessThan(expected * 1.2)
	})

	test('increases background shot noise with stronger sky signal', () => {
		const width = 160
		const height = 120
		const low = new Float64Array(width * height)
		const high = new Float64Array(width * height)

		generateNoiseImage(low, width, height, 1, baseConfig({ sky: { enabled: true, baseRate: 0.05 } }))
		generateNoiseImage(high, width, height, 1, baseConfig({ sky: { enabled: true, baseRate: 0.8 } }))

		expect(standardDeviationOf(high)).toBeGreaterThan(standardDeviationOf(low) * 2.5)
		expect(meanOf(high)).toBeGreaterThan(meanOf(low))
	})

	test('increases dark current with hotter sensors and longer exposures', () => {
		const width = 128
		const height = 128
		const cool = new Float64Array(width * height)
		const hot = new Float64Array(width * height)

		generateNoiseImage(cool, width, height, 1, baseConfig({ exposure: { exposureTime: 60 }, sensor: { darkCurrentAtReferenceTemp: 0.05, temperature: -10, referenceTemperature: -10 } }))
		generateNoiseImage(hot, width, height, 1, baseConfig({ exposure: { exposureTime: 240 }, sensor: { darkCurrentAtReferenceTemp: 0.05, temperature: 14, referenceTemperature: -10 } }))

		expect(meanOf(hot)).toBeGreaterThan(meanOf(cool) * 8)
	})

	test('produces approximately the configured hot-pixel rate', () => {
		const width = 200
		const height = 200
		const pixelCount = width * height
		const raw = new Float64Array(pixelCount)
		const config = baseConfig({ artifacts: { hotPixelRate: 0.001, hotPixelStrength: 150, warmPixelRate: 0, deadPixelRate: 0 } })
		const result = generateNoiseImage(raw, width, height, 1, config)
		const expected = pixelCount * 0.001

		expect(result.stats.hotPixelCount).toBeGreaterThan(expected * 0.7)
		expect(result.stats.hotPixelCount).toBeLessThan(expected * 1.35)
	})

	test('row and column structured noise affect the intended axes', () => {
		const width = 128
		const height = 96
		const rows = new Float64Array(width * height)
		const columns = new Float64Array(width * height)

		generateNoiseImage(rows, width, height, 1, baseConfig({ artifacts: { rowNoiseStrength: 4, columnNoiseStrength: 0 } }))
		generateNoiseImage(columns, width, height, 1, baseConfig({ artifacts: { rowNoiseStrength: 0, columnNoiseStrength: 4 } }))

		expect(rowMeanStd(rows, width, height)).toBeGreaterThan(columnMeanStd(rows, width, height) * 3)
		expect(columnMeanStd(columns, width, height)).toBeGreaterThan(rowMeanStd(columns, width, height) * 3)
	})

	test('clamps and quantizes output when requested', () => {
		const raw = new Float64Array([0.95])

		generateNoiseImage(raw, 1, 1, 1, baseConfig({ sensor: { biasElectrons: 100000, fullWellCapacity: 1000 }, output: { bitDepth: 8, clampMode: 'clamp', quantize: true } }))

		expect(raw[0]).toBeGreaterThanOrEqual(0)
		expect(raw[0]).toBeLessThanOrEqual(1)
		expect(raw[0] * 255).toBeCloseTo(Math.round(raw[0] * 255), 12)
	})

	test('counts saturated RGB samples per pixel instead of per channel', () => {
		const raw = new Float64Array(3)
		const result = generateNoiseImage(raw, 1, 1, 3, baseConfig({ sensor: { biasElectrons: 100000, fullWellCapacity: 1000, channelGain: [1.2, 1, 1.1], channelBiasElectrons: [5000, 7000, 9000] }, output: { clampMode: 'none', quantize: false } }))

		expect(raw[0]).toBeGreaterThanOrEqual(1)
		expect(raw[1]).toBeGreaterThanOrEqual(1)
		expect(raw[2]).toBeGreaterThanOrEqual(1)
		expect(result.stats.saturatedPixels).toBe(1)
	})

	test('generates star images through the same normalization path as the noise model', () => {
		const width = 64
		const height = 64
		const raw = new Float64Array(width * height)
		const result = generateStarImage(
			raw,
			width,
			height,
			1,
			[
				{ x: 32, y: 32, hfd: 2.1, snr: 40, flux: 8 },
				{ x: 18.4, y: 21.7, hfd: 3.6, snr: 12, flux: 0.35 },
			],
			0.8,
			baseConfig({ output: { clampMode: 'normalize', quantize: false } }),
		)

		expect(result.stats.normalizationScale).toBeLessThan(1)
		expect(result.stats.maxValueBeforeOutput).toBeGreaterThan(1)
		expect(Math.max(...raw)).toBeLessThanOrEqual(1)
		expect(raw[32 * width + 32]).toBeGreaterThan(raw[0])
	})
})

describe('generate image', () => {
	const width = 500
	const height = 350

	const scenarios: readonly GenerateImageScenario[] = [
		{ name: 'mono without noise', channels: 1, config: baseConfig(), hash: '08a82bc9f44858eb81cae2e78a4d5b12' },
		{
			name: 'mono read noise only',
			channels: 1,
			hash: '7c62fd378defa43245bc0eb9403f8a67',
			config: baseConfig({ sensor: { readNoise: 3.5 } }),
		},
		{
			name: 'mono cooled dark current only',
			channels: 1,
			hash: '258860cb697cfbfa407422f25d1a63e9',
			config: baseConfig({ exposure: { exposureTime: 300 }, sensor: { darkCurrentAtReferenceTemp: 0.01, temperature: -15, referenceTemperature: -10 } }),
		},
		{
			name: 'mono warm sensor dark current',
			channels: 1,
			hash: '1471a75f58b46c1c7db97e78bd61d96e',
			config: baseConfig({ exposure: { exposureTime: 300 }, sensor: { darkCurrentAtReferenceTemp: 0.04, temperature: 18, referenceTemperature: -10 } }),
		},
		{
			name: 'mono moonlit gradient',
			channels: 1,
			hash: 'cbacdbe66b26c15b0ec04bd097be4af9',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.18, gradientStrength: 0.08, radialGradientStrength: 0.04, lowFrequencyVariationStrength: 0.02 },
				moon: { enabled: true, illuminationFraction: 0.85, altitude: 0.9, angularDistance: 0.35, positionAngle: -0.5, strength: 1.2 },
			}),
		},
		{
			name: 'mono urban light dome',
			channels: 1,
			hash: '82e2607417e8007d01023e5efe121e99',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.16, gradientStrength: 0.06 },
				lightPollution: { enabled: true, strength: 0.55, direction: -1.2, gradientStrength: 0.55, domeSharpness: 1.4 },
				atmosphere: { haze: 0.18, humidity: 0.28, thinCloudVeil: 0.04, horizonGlow: 0.12 },
			}),
		},
		{
			name: 'mono twilight haze',
			channels: 1,
			hash: '976b3c84d9c212d9a2f331fb421e2391',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.14, gradientStrength: 0.12 },
				atmosphere: { haze: 0.25, humidity: 0.32, thinCloudVeil: 0.12, twilightContribution: 0.18, horizonGlow: 0.2 },
			}),
		},
		{
			name: 'mono amp glow and structure',
			channels: 1,
			hash: 'c7b699160063961b748dd57723a37f26',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.08 },
				sensor: { readNoise: 2.5, ampGlow: { enabled: true, strength: 0.12, position: 'right', radiusX: 0.22, radiusY: 0.35, falloff: 4.2, tint: [1, 1, 1] } },
				artifacts: { rowNoiseStrength: 0.6, columnNoiseStrength: 0.3, bandingStrength: 0.28, bandingFrequency: 3.5 },
			}),
		},
		{
			name: 'mono hot pixel defect map',
			channels: 1,
			hash: 'b5db8d17892c6b99580676b763cc2f2c',
			config: baseConfig({
				sensor: { readNoise: 1.4, biasElectrons: 120 },
				artifacts: { hotPixelRate: 0.0008, warmPixelRate: 0.0015, deadPixelRate: 0.0003, hotPixelStrength: 180, warmPixelStrength: 42, deadPixelResidual: 0.01 },
			}),
		},
		{
			name: 'mono realistic cooled camera',
			channels: 1,
			hash: '9748001c4ceafe6ca24b05dfddfe5c8b',
			config: baseConfig({
				quality: 'high-realism',
				exposure: { exposureTime: 180, electronsPerAdu: 0.75 },
				sky: { enabled: true, baseRate: 0.12, gradientStrength: 0.04, radialGradientStrength: 0.03, lowFrequencyVariationStrength: 0.015 },
				moon: { enabled: true, illuminationFraction: 0.22, altitude: 0.45, angularDistance: 1.4, positionAngle: 0.6, strength: 0.45 },
				lightPollution: { enabled: true, strength: 0.12, direction: -0.9, gradientStrength: 0.16, domeSharpness: 1.15 },
				atmosphere: { airglowStrength: 0.08, transparency: 0.92, airmass: 1.12, zodiacalLightFactor: 0.05, milkyWayBackgroundFactor: 0.03 },
				sensor: { readNoise: 1.3, biasElectrons: 220, darkCurrentAtReferenceTemp: 0.008, temperature: -12, referenceTemperature: -10, fullWellCapacity: 65000 },
				artifacts: { fixedPatternNoiseStrength: 0.004, rowNoiseStrength: 0.08, columnNoiseStrength: 0.05, bandingStrength: 0.04, hotPixelRate: 0.00004, warmPixelRate: 0.00012, deadPixelRate: 0.00002, hotPixelStrength: 120, warmPixelStrength: 24, deadPixelResidual: 0.02 },
			}),
		},
		{
			name: 'rgb neutral sky background',
			channels: 3,
			hash: '9ebb8b48b9fbab38b380848bcba58b81',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.16, gradientStrength: 0.05, radialGradientStrength: 0.03, lowFrequencyVariationStrength: 0.02, perChannelMultipliers: [1, 1, 1], colorBias: [1, 1, 1], filterTransmission: [1, 1, 1] },
			}),
		},
		{
			name: 'rgb moonlight cool tint',
			channels: 3,
			hash: '4bffda72bf41aa8efe7ab0b6daf71180',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.14, gradientStrength: 0.06, radialGradientStrength: 0.03, perChannelMultipliers: [1, 1, 1], colorBias: [0.98, 1, 1.04] },
				moon: { enabled: true, illuminationFraction: 0.92, altitude: 0.95, angularDistance: 0.28, positionAngle: 0.8, tint: [0.92, 0.98, 1.1], strength: 1.25 },
			}),
		},
		{
			name: 'rgb urban sodium cast',
			channels: 3,
			hash: '60946f21bdb83548a040ce48aa2d4801',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.15, perChannelMultipliers: [1.05, 1, 0.88], colorBias: [1.06, 1, 0.9] },
				lightPollution: { enabled: true, strength: 0.62, direction: -1.15, gradientStrength: 0.62, domeSharpness: 1.45, tint: [1.2, 1, 0.68] },
				atmosphere: { haze: 0.22, humidity: 0.36, thinCloudVeil: 0.08, horizonGlow: 0.14 },
			}),
		},
		{
			name: 'rgb broadband realistic',
			channels: 3,
			hash: '23cb7b107e4ecde245b3ed787b22fbab',
			config: baseConfig({
				quality: 'high-realism',
				exposure: { exposureTime: 180, electronsPerAdu: 0.8 },
				sky: { enabled: true, baseRate: 0.13, gradientStrength: 0.05, radialGradientStrength: 0.03, lowFrequencyVariationStrength: 0.02, perChannelMultipliers: [1.03, 1, 0.96], colorBias: [1.01, 1, 0.98], filterTransmission: [1, 1, 1] },
				moon: { enabled: true, illuminationFraction: 0.35, altitude: 0.5, angularDistance: 1.1, positionAngle: -0.4, tint: [0.94, 0.98, 1.05], strength: 0.55 },
				lightPollution: { enabled: true, strength: 0.16, direction: -1.0, gradientStrength: 0.2, domeSharpness: 1.15, tint: [1.08, 1, 0.9] },
				atmosphere: { airglowStrength: 0.1, transparency: 0.9, airmass: 1.2, haze: 0.08, humidity: 0.16, zodiacalLightFactor: 0.06, milkyWayBackgroundFactor: 0.03 },
				sensor: { readNoise: 1.5, channelReadNoise: [1.02, 1, 1.05], channelGain: [1.02, 1, 0.98], biasElectrons: 260, darkCurrentAtReferenceTemp: 0.012, temperature: -10, referenceTemperature: -10, channelCorrelation: 0.35 },
				artifacts: { fixedPatternNoiseStrength: 0.004, rowNoiseStrength: 0.08, columnNoiseStrength: 0.05, bandingStrength: 0.05, hotPixelRate: 0.00003, warmPixelRate: 0.00008, deadPixelRate: 0.00001, hotPixelStrength: 110, warmPixelStrength: 20, deadPixelResidual: 0.02 },
			}),
		},
		{
			name: 'rgb narrowband-like filtered background',
			channels: 3,
			hash: 'db18c0dcd4ef2ce0e65afb596bf0278a',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.09, perChannelMultipliers: [0.38, 1.18, 0.42], colorBias: [0.86, 1.08, 0.88], filterTransmission: [0.34, 1.0, 0.36] },
				moon: { enabled: true, illuminationFraction: 0.18, altitude: 0.4, angularDistance: 1.4, positionAngle: 0.2, tint: [0.9, 1, 1.04], strength: 0.25 },
				lightPollution: { enabled: true, strength: 0.08, gradientStrength: 0.1, tint: [1.04, 1, 0.94] },
			}),
		},
		{
			name: 'rgb amp glow sensor tint',
			channels: 3,
			hash: '733a9a41b1f51ebdc50aeaa3bc88fd48',
			config: baseConfig({
				sky: { enabled: true, baseRate: 0.08, perChannelMultipliers: [1, 1, 1] },
				sensor: {
					readNoise: 2.4,
					channelReadNoise: [1.05, 1, 1.08],
					ampGlow: { enabled: true, strength: 0.14, position: 'bottom-right', radiusX: 0.24, radiusY: 0.3, falloff: 4.4, tint: [1.2, 0.86, 0.68] },
				},
				artifacts: { rowNoiseStrength: 0.42, columnNoiseStrength: 0.22, bandingStrength: 0.24, bandingFrequency: 3.2 },
			}),
		},
		{
			name: 'rgb warm noisy one shot color',
			channels: 3,
			hash: 'a7d4b64830dc1b85926407c5a8821473',
			config: baseConfig({
				exposure: { exposureTime: 90, analogGain: 1.6, digitalGain: 1.15, electronsPerAdu: 0.9 },
				sky: { enabled: true, baseRate: 0.22, gradientStrength: 0.08, radialGradientStrength: 0.05, lowFrequencyVariationStrength: 0.03, perChannelMultipliers: [1.04, 1, 0.94], colorBias: [1.02, 1, 0.96] },
				moon: { enabled: true, illuminationFraction: 0.68, altitude: 0.62, angularDistance: 0.55, positionAngle: -0.85, tint: [0.93, 0.98, 1.07], strength: 0.9 },
				lightPollution: { enabled: true, strength: 0.3, direction: -1.05, gradientStrength: 0.36, domeSharpness: 1.25, tint: [1.14, 1, 0.82] },
				atmosphere: { haze: 0.16, humidity: 0.24, thinCloudVeil: 0.04, horizonGlow: 0.08 },
				sensor: { readNoise: 3.1, channelReadNoise: [1.08, 1, 1.12], biasElectrons: 320, darkCurrentAtReferenceTemp: 0.05, temperature: 10, referenceTemperature: -10, channelCorrelation: 0.45 },
				artifacts: { fixedPatternNoiseStrength: 0.007, rowNoiseStrength: 0.16, columnNoiseStrength: 0.12, bandingStrength: 0.1, hotPixelRate: 0.00012, warmPixelRate: 0.0004, deadPixelRate: 0.00004, hotPixelStrength: 150, warmPixelStrength: 28, deadPixelResidual: 0.02 },
			}),
		},
	]

	for (const scenario of scenarios) {
		const { name, channels, hash, config } = scenario
		const slug = name.replaceAll(' ', '-')

		test(
			name,
			async () => {
				const raw = new Float64Array(width * height * channels)
				generateNoiseImage(raw, width, height, channels, config)
				const image: Image = { raw, header: {}, metadata: { width, height, channels, pixelCount: width * height, pixelSizeInBytes: 8, bitpix: -64, stride: width * channels, strideInBytes: width * channels * 8, bayer: undefined } }
				await saveImageAndCompareHash(stf(image, ...adf(image)), `generate-image-${slug}`, hash)
			},
			5000,
		)
	}
})

describe('generate image with stars', () => {
	const width = 500
	const height = 350
	const stars = new Array<AstronomicalImageStar>(200)
	const raw = new Float64Array(width * height * 3)
	const random = mulberry32(1)

	for (let i = 0; i < stars.length; i++) {
		const x = random() * width
		const y = random() * height
		const hfd = 0.5 + random() * 1.5
		const snr = 1 + random() * 99
		const flux = 0.01 + random() * 0.1
		const colorIndex = -0.4 + random() * 2.4
		stars[i] = { x, y, hfd, snr, flux, colorIndex }
	}

	test('mono', async () => {
		const config = baseConfig({
			quality: 'high-realism',
			exposure: { exposureTime: 180, electronsPerAdu: 0.75 },
			sky: { enabled: true, baseRate: 0.12, gradientStrength: 0.04, radialGradientStrength: 0.03, lowFrequencyVariationStrength: 0.015 },
			moon: { enabled: true, illuminationFraction: 0.22, altitude: 0.45, angularDistance: 1.4, positionAngle: 0.6, strength: 0.45 },
			lightPollution: { enabled: true, strength: 0.12, direction: -0.9, gradientStrength: 0.16, domeSharpness: 1.15 },
			atmosphere: { airglowStrength: 0.08, transparency: 0.92, airmass: 1.12, zodiacalLightFactor: 0.05, milkyWayBackgroundFactor: 0.03 },
			sensor: { readNoise: 1.3, biasElectrons: 220, darkCurrentAtReferenceTemp: 0.008, temperature: -12, referenceTemperature: -10, fullWellCapacity: 65000 },
			artifacts: { fixedPatternNoiseStrength: 0.004, rowNoiseStrength: 0.08, columnNoiseStrength: 0.05, bandingStrength: 0.04, hotPixelRate: 0.00004, warmPixelRate: 0.00012, deadPixelRate: 0.00002, hotPixelStrength: 120, warmPixelStrength: 24, deadPixelResidual: 0.02 },
		})

		generateStarImage(raw, width, height, 1, stars, 0.2, config, { psfModel: 'gaussian', jitterX: 0.18, jitterY: -0.22, softCore: 1.8, additiveNoiseHint: 1.5, haloStrength: 0.2 })
		const image: Image = { raw, header: {}, metadata: { width, height, channels: 1, pixelCount: width * height, pixelSizeInBytes: 8, bitpix: -64, stride: width * 1, strideInBytes: width * 1 * 8, bayer: undefined } }
		await saveImageAndCompareHash(stf(image, ...adf(image)), 'generate-image-with-stars-mono', '50b5b6a448fa12089d697a731de274bb')
	})

	test('color', async () => {
		const config = baseConfig({
			sky: { enabled: true, baseRate: 0.16, gradientStrength: 0.05, radialGradientStrength: 0.03, lowFrequencyVariationStrength: 0.02, perChannelMultipliers: [1, 1, 1], colorBias: [1, 1, 1], filterTransmission: [1, 1, 1] },
		})

		generateStarImage(raw, width, height, 3, stars, 0.2, config, { psfModel: 'gaussian', jitterX: 0.18, jitterY: -0.22, softCore: 1.8, additiveNoiseHint: 1.5, haloStrength: 0.2 })
		const image: Image = { raw, header: {}, metadata: { width, height, channels: 3, pixelCount: width * height, pixelSizeInBytes: 8, bitpix: -64, stride: width * 3, strideInBytes: width * 3 * 8, bayer: undefined } }
		await saveImageAndCompareHash(stf(image, ...adf(image)), 'generate-image-with-stars-color', '196f77132bc3c82529bb8869e82a9991')
	})
})
