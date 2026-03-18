import { describe, expect, test } from 'bun:test'
import { type AstronomicalImageNoiseConfig, generateAstronomicalImageNoise } from '../src/image.generator'
import { meanOf, standardDeviationOf } from '../src/util'

function baseConfig(overrides: AstronomicalImageNoiseConfig = {}): AstronomicalImageNoiseConfig {
	return {
		channels: overrides.channels ?? 1,
		seed: overrides.seed ?? 123456,
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
		debug: overrides.debug,
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

		generateAstronomicalImageNoise(raw, 2, 2, baseConfig())

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
			debug: { enabled: true, maps: ['skyBackgroundField', 'moonGradientMap', 'darkCurrentMap', 'ampGlowMap', 'readNoiseSampleMap'] },
		})

		const ra = generateAstronomicalImageNoise(a, width, height, config)
		const rb = generateAstronomicalImageNoise(b, width, height, config)

		expect(a).toEqual(b)
		expect(ra.debug?.skyBackgroundField?.length).toBe(width * height)
		expect(ra.debug?.moonGradientMap?.length).toBe(width * height)
		expect(ra.debug?.darkCurrentMap?.length).toBe(width * height)
		expect(ra.debug?.ampGlowMap?.length).toBe(width * height)
		expect(ra.debug?.readNoiseSampleMap?.length).toBe(width * height)
		expect(ra.stats).toEqual(rb.stats)
	})

	test('validates the buffer length against dimensions and layout', () => {
		expect(() => generateAstronomicalImageNoise(new Float64Array(3), 2, 2, baseConfig())).toThrow()
		expect(() => generateAstronomicalImageNoise(new Float64Array(4), 2, 2, { ...baseConfig(), channels: 3 })).toThrow()
	})

	test('keeps RGB channel means aligned under neutral channel settings', () => {
		const width = 96
		const height = 64
		const raw = new Float64Array(width * height * 3)
		const config = baseConfig({ channels: 3, sky: { enabled: true, baseRate: 0.8, perChannelMultipliers: [1, 1, 1], colorBias: [1, 1, 1], filterTransmission: [1, 1, 1] } })

		generateAstronomicalImageNoise(raw, width, height, config)

		const red = channelMean(raw, 0)
		const green = channelMean(raw, 1)
		const blue = channelMean(raw, 2)
		expect(Math.abs(red - green)).toBeLessThan(4e-4)
		expect(Math.abs(green - blue)).toBeLessThan(4e-4)
	})

	test('matches the configured read-noise scale approximately', () => {
		const width = 128
		const height = 128
		const raw = new Float64Array(width * height)
		const result = generateAstronomicalImageNoise(raw, width, height, baseConfig({ sensor: { readNoise: 4, fullWellCapacity: 60000 } }))

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

		generateAstronomicalImageNoise(low, width, height, baseConfig({ sky: { enabled: true, baseRate: 0.05 } }))
		generateAstronomicalImageNoise(high, width, height, baseConfig({ sky: { enabled: true, baseRate: 0.8 } }))

		expect(standardDeviationOf(high)).toBeGreaterThan(standardDeviationOf(low) * 2.5)
		expect(meanOf(high)).toBeGreaterThan(meanOf(low))
	})

	test('increases dark current with hotter sensors and longer exposures', () => {
		const width = 128
		const height = 128
		const cool = new Float64Array(width * height)
		const hot = new Float64Array(width * height)

		generateAstronomicalImageNoise(cool, width, height, baseConfig({ exposure: { exposureTime: 60 }, sensor: { darkCurrentAtReferenceTemp: 0.05, temperature: -10, referenceTemperature: -10 } }))
		generateAstronomicalImageNoise(hot, width, height, baseConfig({ exposure: { exposureTime: 240 }, sensor: { darkCurrentAtReferenceTemp: 0.05, temperature: 14, referenceTemperature: -10 } }))

		expect(meanOf(hot)).toBeGreaterThan(meanOf(cool) * 8)
	})

	test('produces approximately the configured hot-pixel rate', () => {
		const width = 200
		const height = 200
		const pixelCount = width * height
		const raw = new Float64Array(pixelCount)
		const config = baseConfig({ artifacts: { hotPixelRate: 0.001, hotPixelStrength: 150, warmPixelRate: 0, deadPixelRate: 0 }, debug: { enabled: true, maps: ['hotPixelMap'] } })
		const result = generateAstronomicalImageNoise(raw, width, height, config)
		const expected = pixelCount * 0.001

		expect(result.stats.hotPixelCount).toBeGreaterThan(expected * 0.7)
		expect(result.stats.hotPixelCount).toBeLessThan(expected * 1.35)
		expect(result.debug?.hotPixelMap?.length).toBe(pixelCount)
	})

	test('row and column structured noise affect the intended axes', () => {
		const width = 128
		const height = 96
		const rows = new Float64Array(width * height)
		const columns = new Float64Array(width * height)

		generateAstronomicalImageNoise(rows, width, height, baseConfig({ artifacts: { rowNoiseStrength: 4, columnNoiseStrength: 0 } }))
		generateAstronomicalImageNoise(columns, width, height, baseConfig({ artifacts: { rowNoiseStrength: 0, columnNoiseStrength: 4 } }))

		expect(rowMeanStd(rows, width, height)).toBeGreaterThan(columnMeanStd(rows, width, height) * 3)
		expect(columnMeanStd(columns, width, height)).toBeGreaterThan(rowMeanStd(columns, width, height) * 3)
	})

	test('clamps and quantizes output when requested', () => {
		const raw = new Float64Array([0.95])

		generateAstronomicalImageNoise(raw, 1, 1, baseConfig({ sensor: { biasElectrons: 100000, fullWellCapacity: 1000 }, output: { bitDepth: 8, clampMode: 'clamp', quantize: true } }))

		expect(raw[0]).toBeGreaterThanOrEqual(0)
		expect(raw[0]).toBeLessThanOrEqual(1)
		expect(raw[0] * 255).toBeCloseTo(Math.round(raw[0] * 255), 12)
	})
})
