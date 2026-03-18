import type { DeepRequired } from 'utility-types'
import { PIOVERTWO, TAU } from './constants'
import { clamp } from './math'
import { mulberry32, type Random } from './random'

export type AstronomicalImageNoiseQuality = 'fast' | 'balanced' | 'high-realism'

export type AstronomicalImageClampMode = 'clamp' | 'normalize' | 'none'

export type AmpGlowPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'left' | 'right' | 'top' | 'bottom'

export interface AstronomicalImageNoiseConfig {
	readonly channels?: 1 | 3
	readonly seed?: number
	readonly quality?: AstronomicalImageNoiseQuality
	readonly exposure?: AstronomicalExposureConfig
	readonly sky?: AstronomicalSkyConfig
	readonly moon?: AstronomicalMoonConfig
	readonly lightPollution?: AstronomicalLightPollutionConfig
	readonly atmosphere?: AstronomicalAtmosphereConfig
	readonly sensor?: AstronomicalSensorConfig
	readonly artifacts?: AstronomicalStructuredArtifactsConfig
	readonly output?: AstronomicalOutputConfig
}

// Exposure controls are in seconds, unitless gain factors, and electrons per ADU.
export interface AstronomicalExposureConfig {
	readonly exposureTime?: number
	readonly analogGain?: number
	readonly digitalGain?: number
	readonly electronsPerAdu?: number
}

// Sky background rates are in electrons / pixel / second and angular values are in radians.
export interface AstronomicalSkyConfig {
	readonly enabled?: boolean
	readonly baseRate?: number
	readonly globalOffset?: number
	readonly gradientStrength?: number
	readonly gradientDirection?: number
	readonly radialGradientStrength?: number
	readonly lowFrequencyVariationStrength?: number
	readonly perChannelMultipliers?: readonly [number, number, number]
	readonly colorBias?: readonly [number, number, number]
	readonly filterTransmission?: readonly [number, number, number]
}

// Moon controls use radians for altitude, angular distance, and position angle.
export interface AstronomicalMoonConfig {
	readonly enabled?: boolean
	readonly illuminationFraction?: number
	readonly altitude?: number
	readonly angularDistance?: number
	readonly positionAngle?: number
	readonly tint?: readonly [number, number, number]
	readonly strength?: number
}

// Light-pollution direction is expressed in radians in image coordinates.
export interface AstronomicalLightPollutionConfig {
	readonly enabled?: boolean
	readonly strength?: number
	readonly direction?: number
	readonly gradientStrength?: number
	readonly domeSharpness?: number
	readonly tint?: readonly [number, number, number]
}

// Atmospheric factors are unitless multipliers.
export interface AstronomicalAtmosphereConfig {
	readonly airglowStrength?: number
	readonly transparency?: number
	readonly airmass?: number
	readonly haze?: number
	readonly humidity?: number
	readonly thinCloudVeil?: number
	readonly twilightContribution?: number
	readonly horizonGlow?: number
	readonly zodiacalLightFactor?: number
	readonly milkyWayBackgroundFactor?: number
}

// Sensor-domain signal terms are modeled in electrons.
export interface AstronomicalSensorConfig {
	readonly readNoise?: number
	readonly channelReadNoise?: readonly [number, number, number]
	readonly channelGain?: readonly [number, number, number]
	readonly biasElectrons?: number
	readonly blackLevelElectrons?: number
	readonly channelBiasElectrons?: readonly [number, number, number]
	readonly darkCurrentAtReferenceTemp?: number
	readonly referenceTemperature?: number
	readonly temperature?: number
	readonly temperatureDoublingInterval?: number
	readonly darkSignalNonUniformity?: number
	readonly fullWellCapacity?: number
	readonly channelCorrelation?: number
	readonly ampGlow?: AstronomicalAmpGlowConfig
}

// Amp-glow shape is a single smooth region near an edge or a corner.
export interface AstronomicalAmpGlowConfig {
	readonly enabled?: boolean
	readonly strength?: number
	readonly position?: AmpGlowPosition
	readonly radiusX?: number
	readonly radiusY?: number
	readonly falloff?: number
	readonly tint?: readonly [number, number, number]
}

// Structured artifacts are low-amplitude unless configured otherwise.
export interface AstronomicalStructuredArtifactsConfig {
	readonly fixedPatternNoiseStrength?: number
	readonly rowNoiseStrength?: number
	readonly columnNoiseStrength?: number
	readonly bandingStrength?: number
	readonly bandingFrequency?: number
	readonly hotPixelRate?: number
	readonly warmPixelRate?: number
	readonly deadPixelRate?: number
	readonly hotPixelStrength?: number
	readonly warmPixelStrength?: number
	readonly deadPixelResidual?: number
}

// Output controls stay in normalized image space while quantization uses ADU-like steps.
export interface AstronomicalOutputConfig {
	readonly bitDepth?: number
	readonly maxValue?: number
	readonly clampMode?: AstronomicalImageClampMode
	readonly quantize?: boolean
}

export interface AstronomicalImageNoiseStats {
	readonly seed: number
	readonly expectedLength: number
	readonly saturationElectrons: number
	readonly normalizationScale: number
	readonly maxValueBeforeOutput: number
	readonly saturatedPixels: number
	readonly hotPixelCount: number
	readonly warmPixelCount: number
	readonly deadPixelCount: number
}

export interface AstronomicalImageNoiseResult {
	readonly stats: AstronomicalImageNoiseStats
}

interface ResolvedAstronomicalImageNoiseConfig {
	readonly width: number
	readonly height: number
	readonly channels: 1 | 3
	readonly expectedLength: number
	readonly seed: number
	readonly quality: AstronomicalImageNoiseQuality
	readonly poissonThreshold: number
	readonly exposureTime: number
	readonly analogGain: number
	readonly digitalGain: number
	readonly totalGain: number
	readonly electronsPerAdu: number
	readonly normalizedPerElectron: number
	readonly saturationElectrons: number
	readonly outputLevels: number
	readonly quantize: boolean
	readonly clampMode: AstronomicalImageClampMode
	readonly skyEnabled: boolean
	readonly skyBaseRate: number
	readonly skyGlobalOffset: number
	readonly skyGradientStrength: number
	readonly skyGradientCos: number
	readonly skyGradientSin: number
	readonly skyRadialGradientStrength: number
	readonly skyLowFrequencyVariationStrength: number
	readonly skyPerChannelMultipliers: readonly [number, number, number]
	readonly skyColorBias: readonly [number, number, number]
	readonly skyFilterTransmission: readonly [number, number, number]
	readonly moonEnabled: boolean
	readonly moonIlluminationFraction: number
	readonly moonAltitude: number
	readonly moonAngularDistance: number
	readonly moonPositionCos: number
	readonly moonPositionSin: number
	readonly moonTint: readonly [number, number, number]
	readonly moonStrength: number
	readonly lightPollutionEnabled: boolean
	readonly lightPollutionStrength: number
	readonly lightPollutionGradientStrength: number
	readonly lightPollutionDirectionCos: number
	readonly lightPollutionDirectionSin: number
	readonly lightPollutionDomeSharpness: number
	readonly lightPollutionTint: readonly [number, number, number]
	readonly airglowStrength: number
	readonly transparency: number
	readonly airmass: number
	readonly haze: number
	readonly humidity: number
	readonly thinCloudVeil: number
	readonly twilightContribution: number
	readonly horizonGlow: number
	readonly zodiacalLightFactor: number
	readonly milkyWayBackgroundFactor: number
	readonly readNoise: number
	readonly channelReadNoise: readonly [number, number, number]
	readonly channelGain: readonly [number, number, number]
	readonly biasElectrons: number
	readonly blackLevelElectrons: number
	readonly channelBiasElectrons: readonly [number, number, number]
	readonly darkCurrentAtReferenceTemp: number
	readonly referenceTemperature: number
	readonly temperature: number
	readonly temperatureDoublingInterval: number
	readonly darkSignalNonUniformity: number
	readonly channelCorrelation: number
	readonly ampGlowEnabled: boolean
	readonly ampGlowStrength: number
	readonly ampGlowPosition: AmpGlowPosition
	readonly ampGlowRadiusX: number
	readonly ampGlowRadiusY: number
	readonly ampGlowFalloff: number
	readonly ampGlowTint: readonly [number, number, number]
	readonly fixedPatternNoiseStrength: number
	readonly rowNoiseStrength: number
	readonly columnNoiseStrength: number
	readonly bandingStrength: number
	readonly bandingFrequency: number
	readonly hotPixelRate: number
	readonly warmPixelRate: number
	readonly deadPixelRate: number
	readonly hotPixelStrength: number
	readonly warmPixelStrength: number
	readonly deadPixelResidual: number
	readonly lowFrequencyPhase0: number
	readonly lowFrequencyPhase1: number
	readonly lowFrequencyPhase2: number
	readonly lowFrequencyPhase3: number
}

interface GaussianSamplerState {
	spare: number
	hasSpare: boolean
}

interface SensorDefect {
	signalScale: number
	extraSignalElectrons: number
	kind: 0 | 1 | 2 | 3
}

interface SkySpatialFields {
	sharedSkyElectrons: number
	lightPollutionElectrons: number
	moonElectrons: number
	ampGlowElectrons: number
}

const DEFAULT_RGB: readonly [number, number, number] = [1, 1, 1]

export const DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG: Readonly<DeepRequired<AstronomicalImageNoiseConfig>> = {
	channels: 1,
	seed: 0x5f3759df,
	quality: 'balanced',
	exposure: {
		exposureTime: 60,
		analogGain: 1,
		digitalGain: 1,
		electronsPerAdu: 0.85,
	},
	sky: {
		enabled: true,
		baseRate: 0.22,
		globalOffset: 0,
		gradientStrength: 0.08,
		gradientDirection: -PIOVERTWO,
		radialGradientStrength: 0.05,
		lowFrequencyVariationStrength: 0.03,
		perChannelMultipliers: DEFAULT_RGB,
		colorBias: DEFAULT_RGB,
		filterTransmission: DEFAULT_RGB,
	},
	moon: {
		enabled: false,
		illuminationFraction: 0.5,
		altitude: 0.55,
		angularDistance: 1.1,
		positionAngle: -0.65,
		tint: [0.94, 0.98, 1.08],
		strength: 1,
	},
	lightPollution: {
		enabled: true,
		strength: 0.2,
		direction: -PIOVERTWO,
		gradientStrength: 0.2,
		domeSharpness: 1.2,
		tint: [1.12, 1.0, 0.82],
	},
	atmosphere: {
		airglowStrength: 0.08,
		transparency: 0.9,
		airmass: 1.15,
		haze: 0.06,
		humidity: 0.18,
		thinCloudVeil: 0,
		twilightContribution: 0,
		horizonGlow: 0.04,
		zodiacalLightFactor: 0.05,
		milkyWayBackgroundFactor: 0.02,
	},
	sensor: {
		readNoise: 1.6,
		channelReadNoise: DEFAULT_RGB,
		channelGain: DEFAULT_RGB,
		biasElectrons: 280,
		blackLevelElectrons: 0,
		channelBiasElectrons: [0, 0, 0],
		darkCurrentAtReferenceTemp: 0.02,
		referenceTemperature: -10,
		temperature: -10,
		temperatureDoublingInterval: 6,
		darkSignalNonUniformity: 0.02,
		fullWellCapacity: 50000,
		channelCorrelation: 0.3,
		ampGlow: {
			enabled: false,
			strength: 0.01,
			position: 'right',
			radiusX: 0.2,
			radiusY: 0.35,
			falloff: 3.5,
			tint: [1.18, 0.78, 0.65],
		},
	},
	artifacts: {
		fixedPatternNoiseStrength: 0.006,
		rowNoiseStrength: 0.12,
		columnNoiseStrength: 0.1,
		bandingStrength: 0.1,
		bandingFrequency: 3,
		hotPixelRate: 0.00004,
		warmPixelRate: 0.00012,
		deadPixelRate: 0.00002,
		hotPixelStrength: 120,
		warmPixelStrength: 28,
		deadPixelResidual: 0.02,
	},
	output: {
		bitDepth: 16,
		clampMode: 'clamp',
		quantize: false,
		maxValue: 65535,
	},
}

// Adds realistic sky background and camera noise into a normalized image buffer in place.
export function generateAstronomicalImageNoise(raw: Float64Array, width: number, height: number, config: AstronomicalImageNoiseConfig = DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG): AstronomicalImageNoiseResult {
	const resolved = resolveAstronomicalImageNoiseConfig(raw, width, height, config)
	const { channels, expectedLength, height: imageHeight, width: imageWidth, seed } = resolved

	if (expectedLength === 0) {
		return {
			stats: {
				seed,
				expectedLength,
				saturationElectrons: resolved.saturationElectrons,
				normalizationScale: 1,
				maxValueBeforeOutput: 0,
				saturatedPixels: 0,
				hotPixelCount: 0,
				warmPixelCount: 0,
				deadPixelCount: 0,
			},
		}
	}

	const random = mulberry32(seed)
	const gaussianState: GaussianSamplerState = { spare: 0, hasSpare: false }
	const xCentered = createCenteredAxis(imageWidth)
	const yCentered = createCenteredAxis(imageHeight)
	const rowNoise = createNoiseAxis(imageHeight, resolved.rowNoiseStrength, random, gaussianState)
	const columnNoise = createNoiseAxis(imageWidth, resolved.columnNoiseStrength, random, gaussianState)
	const rowBanding = createBandingAxis(imageHeight, resolved.bandingStrength, resolved.bandingFrequency, random)
	const columnBanding = createBandingAxis(imageWidth, resolved.bandingStrength * 0.75, resolved.bandingFrequency * 1.13, random)

	let maxValueBeforeOutput = -Infinity
	let saturatedPixels = 0
	let hotPixelCount = 0
	let warmPixelCount = 0
	let deadPixelCount = 0

	const sharedReadNoiseSigma = Math.sqrt(clamp(resolved.channelCorrelation, 0, 1))
	const independentReadNoiseSigma = Math.sqrt(Math.max(0, 1 - sharedReadNoiseSigma * sharedReadNoiseSigma))

	const spatial: SkySpatialFields = { sharedSkyElectrons: 0, lightPollutionElectrons: 0, moonElectrons: 0, ampGlowElectrons: 0 }
	const defect: SensorDefect = { signalScale: 0, extraSignalElectrons: 0, kind: 0 }

	for (let y = 0; y < imageHeight; y++) {
		const yc = yCentered[y]
		const rowBase = y * imageWidth
		const rowStructuredElectrons = rowNoise[y] + rowBanding[y]

		for (let x = 0; x < imageWidth; x++) {
			const pixelIndex = rowBase + x
			const xc = xCentered[x]
			const columnStructuredElectrons = columnNoise[x] + columnBanding[x]
			evaluateSkySpatialFields(xc, yc, resolved, spatial)
			sampleSensorDefect(resolved, random, defect)

			if (defect.kind === 1) hotPixelCount++
			else if (defect.kind === 2) warmPixelCount++
			else if (defect.kind === 3) deadPixelCount++

			const fixedPatternGain = 1 + resolved.fixedPatternNoiseStrength * sampleGaussian(random, gaussianState)
			const dsnuGain = 1 + resolved.darkSignalNonUniformity * sampleGaussian(random, gaussianState)
			const skyElectrons = Math.max(0, spatial.sharedSkyElectrons)
			const darkElectrons = Math.max(0, evaluateDarkCurrentElectrons(resolved) * dsnuGain)
			const ampGlowElectrons = spatial.ampGlowElectrons
			const sharedReadNoise = sampleGaussian(random, gaussianState) * sharedReadNoiseSigma

			if (channels === 1) {
				const readNoiseElectrons = resolved.readNoise * resolved.channelReadNoise[0] * (sharedReadNoise + sampleGaussian(random, gaussianState) * independentReadNoiseSigma)
				const signalElectrons = sampleSignalElectrons(skyElectrons * resolved.channelGain[0], random, gaussianState, resolved.poissonThreshold) * fixedPatternGain
				const darkSignalElectrons = sampleSignalElectrons(darkElectrons, random, gaussianState, resolved.poissonThreshold)
				const totalElectrons = (signalElectrons + darkSignalElectrons + ampGlowElectrons + defect.extraSignalElectrons) * defect.signalScale + resolved.biasElectrons + resolved.blackLevelElectrons + resolved.channelBiasElectrons[0] + rowStructuredElectrons + columnStructuredElectrons + readNoiseElectrons
				const next = raw[pixelIndex] + totalElectrons * resolved.normalizedPerElectron
				raw[pixelIndex] = next
				if (next > maxValueBeforeOutput) maxValueBeforeOutput = next
				if (next >= 1) saturatedPixels++
			} else {
				const baseIndex = pixelIndex * 3
				let readNoiseAverage = 0

				for (let channel = 0; channel < 3; channel++) {
					const readNoiseElectrons = resolved.readNoise * resolved.channelReadNoise[channel] * (sharedReadNoise + sampleGaussian(random, gaussianState) * independentReadNoiseSigma)
					const channelSkyElectrons = Math.max(0, skyElectrons * resolved.skyPerChannelMultipliers[channel] * resolved.skyColorBias[channel] * resolved.skyFilterTransmission[channel] + spatial.lightPollutionElectrons * resolved.lightPollutionTint[channel] + spatial.moonElectrons * resolved.moonTint[channel])
					const signalElectrons = sampleSignalElectrons(channelSkyElectrons * resolved.channelGain[channel], random, gaussianState, resolved.poissonThreshold) * fixedPatternGain
					const darkSignalElectrons = sampleSignalElectrons(darkElectrons, random, gaussianState, resolved.poissonThreshold)
					const ampGlowTintedElectrons = ampGlowElectrons * resolved.ampGlowTint[channel]
					const totalElectrons =
						(signalElectrons + darkSignalElectrons + ampGlowTintedElectrons + defect.extraSignalElectrons) * defect.signalScale + resolved.biasElectrons + resolved.blackLevelElectrons + resolved.channelBiasElectrons[channel] + rowStructuredElectrons + columnStructuredElectrons + readNoiseElectrons
					const next = raw[baseIndex + channel] + totalElectrons * resolved.normalizedPerElectron
					raw[baseIndex + channel] = next
					if (next > maxValueBeforeOutput) maxValueBeforeOutput = next
					if (next >= 1) saturatedPixels++
					readNoiseAverage += readNoiseElectrons
				}
			}
		}
	}

	const normalizationScale = finalizeOutput(raw, expectedLength, resolved, maxValueBeforeOutput)

	return {
		stats: {
			seed,
			expectedLength,
			saturationElectrons: resolved.saturationElectrons,
			normalizationScale,
			maxValueBeforeOutput,
			saturatedPixels,
			hotPixelCount,
			warmPixelCount,
			deadPixelCount,
		},
	}
}

// Validates user parameters and derives a fast execution context.
function resolveAstronomicalImageNoiseConfig(raw: Float64Array, width: number, height: number, config: AstronomicalImageNoiseConfig): ResolvedAstronomicalImageNoiseConfig {
	if (!Number.isInteger(width) || width < 0) throw new RangeError('width must be a non-negative integer')
	if (!Number.isInteger(height) || height < 0) throw new RangeError('height must be a non-negative integer')

	const channels = config.channels ?? 1
	const expectedLength = width * height * channels
	if (raw.length < expectedLength) throw new RangeError(`buffer length mismatch: expected ${expectedLength}, received ${raw.length}`)

	const exposure = config.exposure ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure!
	const sky = config.sky ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky!
	const moon = config.moon ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon!
	const lightPollution = config.lightPollution ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution!
	const atmosphere = config.atmosphere ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere!
	const sensor = config.sensor ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor!
	const artifacts = config.artifacts ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts!
	const output = config.output ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.output!
	const ampGlow = sensor.ampGlow ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor!.ampGlow!

	const quality = config.quality ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.quality!
	const poissonThreshold = quality === 'fast' ? 16 : quality === 'high-realism' ? 64 : 32
	const exposureTime = requirePositiveFinite('exposure.exposureTime', exposure.exposureTime ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure!.exposureTime!)
	const analogGain = requirePositiveFinite('exposure.analogGain', exposure.analogGain ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure!.analogGain!)
	const digitalGain = requirePositiveFinite('exposure.digitalGain', exposure.digitalGain ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure!.digitalGain!)
	const electronsPerAdu = requirePositiveFinite('exposure.electronsPerAdu', exposure.electronsPerAdu ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure!.electronsPerAdu!)
	const totalGain = analogGain * digitalGain
	const bitDepth = requireIntegerInRange('output.bitDepth', output.bitDepth ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.output!.bitDepth!, 1, 32)
	const outputLevels = output.maxValue === undefined ? 2 ** bitDepth - 1 : requirePositiveFinite('output.maxValue', output.maxValue)
	const fullWellCapacity = requirePositiveFinite('sensor.fullWellCapacity', sensor.fullWellCapacity ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor!.fullWellCapacity!)
	const adcSaturationElectrons = (outputLevels * electronsPerAdu) / totalGain
	const saturationElectrons = Math.max(1, Math.min(fullWellCapacity, adcSaturationElectrons))
	const normalizedPerElectron = 1 / saturationElectrons
	const seed = normalizeSeed(config.seed ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.seed!)

	return {
		width,
		height,
		channels,
		expectedLength,
		seed,
		quality,
		poissonThreshold,
		exposureTime,
		analogGain,
		digitalGain,
		totalGain,
		electronsPerAdu,
		normalizedPerElectron,
		saturationElectrons,
		outputLevels,
		quantize: output.quantize ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.output.quantize,
		clampMode: output.clampMode ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.output.clampMode,
		skyEnabled: sky.enabled ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.enabled,
		skyBaseRate: requireNonNegativeFinite('sky.baseRate', sky.baseRate ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.baseRate),
		skyGlobalOffset: requireFinite('sky.globalOffset', sky.globalOffset ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.globalOffset),
		skyGradientStrength: requireNonNegativeFinite('sky.gradientStrength', sky.gradientStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.gradientStrength),
		skyGradientCos: Math.cos(sky.gradientDirection ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.gradientDirection),
		skyGradientSin: Math.sin(sky.gradientDirection ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.gradientDirection),
		skyRadialGradientStrength: requireNonNegativeFinite('sky.radialGradientStrength', sky.radialGradientStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.radialGradientStrength),
		skyLowFrequencyVariationStrength: requireNonNegativeFinite('sky.lowFrequencyVariationStrength', sky.lowFrequencyVariationStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.lowFrequencyVariationStrength),
		skyPerChannelMultipliers: resolveTriplet('sky.perChannelMultipliers', sky.perChannelMultipliers ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.perChannelMultipliers),
		skyColorBias: resolveTriplet('sky.colorBias', sky.colorBias ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.colorBias),
		skyFilterTransmission: resolveTriplet('sky.filterTransmission', sky.filterTransmission ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.filterTransmission),
		moonEnabled: moon.enabled ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.enabled,
		moonIlluminationFraction: requireFraction('moon.illuminationFraction', moon.illuminationFraction ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.illuminationFraction),
		moonAltitude: requireFinite('moon.altitude', moon.altitude ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.altitude),
		moonAngularDistance: requireNonNegativeFinite('moon.angularDistance', moon.angularDistance ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.angularDistance),
		moonPositionCos: Math.cos(moon.positionAngle ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.positionAngle),
		moonPositionSin: Math.sin(moon.positionAngle ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.positionAngle),
		moonTint: resolveTriplet('moon.tint', moon.tint ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.tint),
		moonStrength: requireNonNegativeFinite('moon.strength', moon.strength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.strength),
		lightPollutionEnabled: lightPollution.enabled ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.enabled,
		lightPollutionStrength: requireNonNegativeFinite('lightPollution.strength', lightPollution.strength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.strength),
		lightPollutionGradientStrength: requireNonNegativeFinite('lightPollution.gradientStrength', lightPollution.gradientStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.gradientStrength),
		lightPollutionDirectionCos: Math.cos(lightPollution.direction ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.direction),
		lightPollutionDirectionSin: Math.sin(lightPollution.direction ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.direction),
		lightPollutionDomeSharpness: requirePositiveFinite('lightPollution.domeSharpness', lightPollution.domeSharpness ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.domeSharpness),
		lightPollutionTint: resolveTriplet('lightPollution.tint', lightPollution.tint ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.tint),
		airglowStrength: requireNonNegativeFinite('atmosphere.airglowStrength', atmosphere.airglowStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.airglowStrength),
		transparency: requirePositiveFinite('atmosphere.transparency', atmosphere.transparency ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.transparency),
		airmass: requirePositiveFinite('atmosphere.airmass', atmosphere.airmass ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.airmass),
		haze: requireNonNegativeFinite('atmosphere.haze', atmosphere.haze ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.haze),
		humidity: requireNonNegativeFinite('atmosphere.humidity', atmosphere.humidity ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.humidity),
		thinCloudVeil: requireNonNegativeFinite('atmosphere.thinCloudVeil', atmosphere.thinCloudVeil ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.thinCloudVeil),
		twilightContribution: requireNonNegativeFinite('atmosphere.twilightContribution', atmosphere.twilightContribution ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.twilightContribution),
		horizonGlow: requireNonNegativeFinite('atmosphere.horizonGlow', atmosphere.horizonGlow ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.horizonGlow),
		zodiacalLightFactor: requireNonNegativeFinite('atmosphere.zodiacalLightFactor', atmosphere.zodiacalLightFactor ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.zodiacalLightFactor),
		milkyWayBackgroundFactor: requireNonNegativeFinite('atmosphere.milkyWayBackgroundFactor', atmosphere.milkyWayBackgroundFactor ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.milkyWayBackgroundFactor),
		readNoise: requireNonNegativeFinite('sensor.readNoise', sensor.readNoise ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.readNoise),
		channelReadNoise: resolveTriplet('sensor.channelReadNoise', sensor.channelReadNoise ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.channelReadNoise),
		channelGain: resolveTriplet('sensor.channelGain', sensor.channelGain ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.channelGain),
		biasElectrons: requireNonNegativeFinite('sensor.biasElectrons', sensor.biasElectrons ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.biasElectrons),
		blackLevelElectrons: requireNonNegativeFinite('sensor.blackLevelElectrons', sensor.blackLevelElectrons ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.blackLevelElectrons),
		channelBiasElectrons: resolveTriplet('sensor.channelBiasElectrons', sensor.channelBiasElectrons ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.channelBiasElectrons),
		darkCurrentAtReferenceTemp: requireNonNegativeFinite('sensor.darkCurrentAtReferenceTemp', sensor.darkCurrentAtReferenceTemp ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.darkCurrentAtReferenceTemp),
		referenceTemperature: requireFinite('sensor.referenceTemperature', sensor.referenceTemperature ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.referenceTemperature),
		temperature: requireFinite('sensor.temperature', sensor.temperature ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.temperature),
		temperatureDoublingInterval: requirePositiveFinite('sensor.temperatureDoublingInterval', sensor.temperatureDoublingInterval ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.temperatureDoublingInterval),
		darkSignalNonUniformity: requireNonNegativeFinite('sensor.darkSignalNonUniformity', sensor.darkSignalNonUniformity ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.darkSignalNonUniformity),
		channelCorrelation: requireFraction('sensor.channelCorrelation', sensor.channelCorrelation ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.channelCorrelation),
		ampGlowEnabled: ampGlow.enabled ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.enabled,
		ampGlowStrength: requireNonNegativeFinite('sensor.ampGlow.strength', ampGlow.strength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.strength),
		ampGlowPosition: ampGlow.position ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.position,
		ampGlowRadiusX: requirePositiveFinite('sensor.ampGlow.radiusX', ampGlow.radiusX ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.radiusX),
		ampGlowRadiusY: requirePositiveFinite('sensor.ampGlow.radiusY', ampGlow.radiusY ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.radiusY),
		ampGlowFalloff: requirePositiveFinite('sensor.ampGlow.falloff', ampGlow.falloff ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.falloff),
		ampGlowTint: resolveTriplet('sensor.ampGlow.tint', ampGlow.tint ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.tint),
		fixedPatternNoiseStrength: requireNonNegativeFinite('artifacts.fixedPatternNoiseStrength', artifacts.fixedPatternNoiseStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.fixedPatternNoiseStrength),
		rowNoiseStrength: requireNonNegativeFinite('artifacts.rowNoiseStrength', artifacts.rowNoiseStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.rowNoiseStrength),
		columnNoiseStrength: requireNonNegativeFinite('artifacts.columnNoiseStrength', artifacts.columnNoiseStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.columnNoiseStrength),
		bandingStrength: requireNonNegativeFinite('artifacts.bandingStrength', artifacts.bandingStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.bandingStrength),
		bandingFrequency: requirePositiveFinite('artifacts.bandingFrequency', artifacts.bandingFrequency ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.bandingFrequency),
		hotPixelRate: requireFraction('artifacts.hotPixelRate', artifacts.hotPixelRate ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.hotPixelRate),
		warmPixelRate: requireFraction('artifacts.warmPixelRate', artifacts.warmPixelRate ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.warmPixelRate),
		deadPixelRate: requireFraction('artifacts.deadPixelRate', artifacts.deadPixelRate ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.deadPixelRate),
		hotPixelStrength: requireNonNegativeFinite('artifacts.hotPixelStrength', artifacts.hotPixelStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.hotPixelStrength),
		warmPixelStrength: requireNonNegativeFinite('artifacts.warmPixelStrength', artifacts.warmPixelStrength ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.warmPixelStrength),
		deadPixelResidual: requireFraction('artifacts.deadPixelResidual', artifacts.deadPixelResidual ?? DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.deadPixelResidual),
		lowFrequencyPhase0: TAU * mulberry32(seed ^ 0x13579bdf)(),
		lowFrequencyPhase1: TAU * mulberry32(seed ^ 0x2468ace0)(),
		lowFrequencyPhase2: TAU * mulberry32(seed ^ 0x89abcdef)(),
		lowFrequencyPhase3: TAU * mulberry32(seed ^ 0x10203040)(),
	}
}

// Evaluates the smooth sky, moon, light-pollution, and amp-glow fields for a pixel.
function evaluateSkySpatialFields(xc: number, yc: number, config: ResolvedAstronomicalImageNoiseConfig, out: SkySpatialFields): SkySpatialFields {
	const radius2 = xc * xc + yc * yc
	const linearGradient = (xc * config.skyGradientCos + yc * config.skyGradientSin) * 2
	const lowFrequency = evaluateLowFrequencyVariation(xc, yc, config)
	const horizonFactor = clamp(1 - (yc + 0.5), 0, 1)
	const atmosphericPathScale = Math.max(0.35, config.airmass) ** 0.38
	const transparencyScale = 0.35 + 0.65 * clamp(config.transparency, 0, 1.5)
	const naturalSkyScale = 1 + config.airglowStrength + config.zodiacalLightFactor * 0.55 + config.milkyWayBackgroundFactor * 0.35 + config.humidity * 0.12
	const diffuseBoost = 1 + config.haze * 0.9 + config.humidity * 0.35 + config.thinCloudVeil * 1.6
	const baseSkyElectrons = config.skyEnabled ? config.skyBaseRate * config.exposureTime * atmosphericPathScale * transparencyScale * naturalSkyScale : 0
	const skyField = Math.max(0, 1 + config.skyGlobalOffset + config.skyGradientStrength * linearGradient + config.skyRadialGradientStrength * radius2 + config.skyLowFrequencyVariationStrength * lowFrequency)
	const sharedNaturalSkyElectrons = Math.max(0, baseSkyElectrons * skyField)

	out.lightPollutionElectrons = config.lightPollutionEnabled ? evaluateLightPollutionElectrons(xc, yc, horizonFactor, baseSkyElectrons, diffuseBoost, config) : 0
	out.moonElectrons = config.moonEnabled ? evaluateMoonElectrons(xc, yc, baseSkyElectrons, diffuseBoost, config) : 0
	const twilightElectrons = baseSkyElectrons * config.twilightContribution * 18 * horizonFactor
	const horizonGlowElectrons = baseSkyElectrons * config.horizonGlow * (0.45 + 0.55 * horizonFactor) * diffuseBoost
	out.ampGlowElectrons = config.ampGlowEnabled ? evaluateAmpGlowElectrons(xc, yc, config) : 0
	out.sharedSkyElectrons = sharedNaturalSkyElectrons + twilightElectrons + horizonGlowElectrons + out.lightPollutionElectrons * (0.3 + 0.7 * config.lightPollutionGradientStrength)

	return out
}

// Uses low-frequency sinusoids instead of a large 2D map for smooth background variation.
function evaluateLowFrequencyVariation(xc: number, yc: number, config: ResolvedAstronomicalImageNoiseConfig) {
	const x = xc + 0.5
	const y = yc + 0.5
	const c0 = Math.sin(TAU * (x * 0.85 + y * 0.18) + config.lowFrequencyPhase0)
	const c1 = Math.sin(TAU * (x * 0.17 + y * 0.73) + config.lowFrequencyPhase1)
	const c2 = Math.sin(TAU * (x * 0.41 - y * 0.29) + config.lowFrequencyPhase2)
	if (config.quality === 'fast') return (c0 + 0.65 * c1) / 1.65
	const c3 = Math.sin(TAU * (x * 0.93 + y * 1.12) + config.lowFrequencyPhase3)
	return (c0 + 0.65 * c1 + 0.4 * c2 + (config.quality === 'high-realism' ? 0.28 : 0.16) * c3) / (config.quality === 'high-realism' ? 2.33 : 2.21)
}

// Approximates the urban light dome with a smooth directional field near the horizon.
function evaluateLightPollutionElectrons(xc: number, yc: number, horizonFactor: number, baseSkyElectrons: number, diffuseBoost: number, config: ResolvedAstronomicalImageNoiseConfig) {
	const sourceX = 0.72 * config.lightPollutionDirectionCos
	const sourceY = 0.72 * config.lightPollutionDirectionSin
	const dx = xc - sourceX
	const dy = yc - sourceY
	const d2 = dx * dx + dy * dy
	const axis = (xc * config.lightPollutionDirectionCos + yc * config.lightPollutionDirectionSin) * 1.5
	const domeWidth = 0.08 + 0.22 / config.lightPollutionDomeSharpness + config.haze * 0.1 + config.thinCloudVeil * 0.08
	const domeProfile = Math.exp(-d2 / domeWidth)
	const gradient = 1 + config.lightPollutionGradientStrength * axis
	return baseSkyElectrons * 5.5 * config.lightPollutionStrength * diffuseBoost * Math.max(0, gradient) * domeProfile * (0.45 + 0.55 * horizonFactor)
}

// Approximates moonlight using illumination, altitude, target separation, and a smooth field direction.
function evaluateMoonElectrons(xc: number, yc: number, baseSkyElectrons: number, diffuseBoost: number, config: ResolvedAstronomicalImageNoiseConfig) {
	const altitudeFactor = clamp(Math.sin(config.moonAltitude) * 0.75 + 0.25, 0, 1.5)
	const separationFactor = 1 / (1 + (config.moonAngularDistance / 0.9) ** 2)
	const sourceX = 0.66 * config.moonPositionCos
	const sourceY = 0.66 * config.moonPositionSin
	const dx = xc - sourceX
	const dy = yc - sourceY
	const d2 = dx * dx + dy * dy
	const moonWidth = 0.12 + 0.18 * (1 - separationFactor) + config.haze * 0.08 + config.thinCloudVeil * 0.06
	const moonProfile = Math.exp(-d2 / moonWidth)
	return baseSkyElectrons * 9 * config.moonStrength * config.moonIlluminationFraction ** 0.85 * altitudeFactor * separationFactor * diffuseBoost * moonProfile
}

// Models one localized amp-glow region that strengthens with exposure and temperature.
function evaluateAmpGlowElectrons(xc: number, yc: number, config: ResolvedAstronomicalImageNoiseConfig) {
	const [sourceX, sourceY] = ampGlowSource(config.ampGlowPosition)
	const dx = (xc - sourceX) / config.ampGlowRadiusX
	const dy = (yc - sourceY) / config.ampGlowRadiusY
	const distance = Math.sqrt(dx * dx + dy * dy)
	const temperatureFactor = 1 + Math.max(0, config.temperature - config.referenceTemperature) * 0.08
	return config.ampGlowStrength * config.exposureTime * config.saturationElectrons * 0.01 * temperatureFactor * Math.exp(-config.ampGlowFalloff * distance * distance)
}

// Applies the dark-current temperature law with a configurable doubling interval.
function evaluateDarkCurrentElectrons(config: ResolvedAstronomicalImageNoiseConfig) {
	const temperatureSteps = (config.temperature - config.referenceTemperature) / config.temperatureDoublingInterval
	return config.darkCurrentAtReferenceTemp * 2 ** temperatureSteps * config.exposureTime
}

// Draws photon counts with exact Poisson sampling for low counts and a Gaussian approximation for high counts.
function sampleSignalElectrons(meanElectrons: number, random: Random, gaussianState: GaussianSamplerState, poissonThreshold: number) {
	if (meanElectrons <= 0) return 0
	if (meanElectrons < poissonThreshold) return samplePoissonExact(meanElectrons, random)
	return Math.max(0, Math.round(meanElectrons + Math.sqrt(meanElectrons) * sampleGaussian(random, gaussianState)))
}

// Uses Knuth inversion because low-count background and dark-current regimes matter visually.
function samplePoissonExact(lambda: number, random: Random) {
	const limit = Math.exp(-lambda)
	let product = 1
	let count = 0

	do {
		product *= random()
		count++
	} while (product > limit)

	return count - 1
}

// Uses a cached Box-Muller transform for fast repeated Gaussian samples.
function sampleGaussian(random: Random, state: GaussianSamplerState) {
	if (state.hasSpare) {
		state.hasSpare = false
		return state.spare
	}

	let u = 0
	let v = 0
	let s = 0

	do {
		u = random() * 2 - 1
		v = random() * 2 - 1
		s = u * u + v * v
	} while (s <= 1e-12 || s >= 1)

	const factor = Math.sqrt((-2 * Math.log(s)) / s)
	state.spare = v * factor
	state.hasSpare = true
	return u * factor
}

// Samples sparse hot, warm, and dead pixels deterministically from the configured rates.
function sampleSensorDefect(config: ResolvedAstronomicalImageNoiseConfig, random: Random, out: SensorDefect): SensorDefect {
	const deadRate = config.deadPixelRate
	const hotRate = config.hotPixelRate
	const warmRate = config.warmPixelRate
	const r = random()

	if (r < deadRate) {
		out.signalScale = config.deadPixelResidual
		out.extraSignalElectrons = 0
		out.kind = 3
	} else if (r < deadRate + hotRate) {
		out.signalScale = 1
		out.extraSignalElectrons = config.hotPixelStrength * config.exposureTime * (0.85 + 0.3 * random())
		out.kind = 1
	} else if (r < deadRate + hotRate + warmRate) {
		out.signalScale = 1
		out.extraSignalElectrons = config.warmPixelStrength * config.exposureTime * (0.85 + 0.3 * random())
		out.kind = 2
	} else {
		out.signalScale = 1
		out.extraSignalElectrons = 0
		out.kind = 0
	}

	return out
}

// Precomputes centered coordinates once to avoid repeated normalization work.
function createCenteredAxis(length: number) {
	const axis = new Float64Array(length)
	if (length === 0) return axis
	if (length === 1) {
		axis[0] = 0
		return axis
	}

	const inv = 1 / (length - 1)
	for (let i = 0; i < length; i++) axis[i] = i * inv - 0.5
	return axis
}

// Precomputes correlated row or column noise in electrons.
function createNoiseAxis(length: number, sigma: number, random: Random, gaussianState: GaussianSamplerState) {
	const axis = new Float64Array(length)
	if (sigma <= 0) return axis
	for (let i = 0; i < length; i++) axis[i] = sigma * sampleGaussian(random, gaussianState)
	return axis
}

// Precomputes low-frequency banding along one axis.
function createBandingAxis(length: number, strength: number, frequency: number, random: Random) {
	const axis = new Float64Array(length)
	if (strength <= 0 || length === 0) return axis
	const phase = TAU * random()
	const secondaryPhase = TAU * random()
	const inv = length > 1 ? 1 / (length - 1) : 0

	for (let i = 0; i < length; i++) {
		const t = i * inv
		axis[i] = strength * (Math.sin(TAU * frequency * t + phase) * 0.7 + Math.sin(TAU * (frequency * 0.47 + 0.35) * t + secondaryPhase) * 0.3)
	}

	return axis
}

// Applies the requested clamp and quantization policy after all noise has been accumulated.
function finalizeOutput(raw: Float64Array, length: number, config: ResolvedAstronomicalImageNoiseConfig, maxValueBeforeOutput: number) {
	let normalizationScale = 1

	if (config.clampMode === 'normalize' && Number.isFinite(maxValueBeforeOutput) && maxValueBeforeOutput > 1) {
		normalizationScale = 1 / maxValueBeforeOutput
		for (let i = 0; i < length; i++) raw[i] *= normalizationScale
	}

	if (config.clampMode === 'clamp') {
		for (let i = 0; i < length; i++) raw[i] = clamp(raw[i], 0, 1)
	} else if (config.clampMode === 'normalize') {
		for (let i = 0; i < length; i++) raw[i] = Math.max(0, raw[i])
	}

	if (config.quantize) {
		const maxLevel = Math.max(1, Math.round(config.outputLevels))
		const inv = 1 / maxLevel
		for (let i = 0; i < length; i++) raw[i] = Math.round(raw[i] * maxLevel) * inv
	}

	return normalizationScale
}

// Maps an amp-glow anchor label to a point just outside the normalized frame center.
function ampGlowSource(position: AmpGlowPosition): readonly [number, number] {
	switch (position) {
		case 'top-left':
			return [-0.58, -0.58]
		case 'top-right':
			return [0.58, -0.58]
		case 'bottom-left':
			return [-0.58, 0.58]
		case 'bottom-right':
			return [0.58, 0.58]
		case 'left':
			return [-0.62, 0]
		case 'right':
			return [0.62, 0]
		case 'top':
			return [0, -0.62]
		case 'bottom':
			return [0, 0.62]
	}
}

// Normalizes user triplets and rejects invalid channel scalars early.
function resolveTriplet(name: string, value: readonly [number, number, number]) {
	return [requireFinite(`${name}[0]`, value[0]), requireFinite(`${name}[1]`, value[1]), requireFinite(`${name}[2]`, value[2])] as const
}

// Keeps seeds stable in 32-bit space for the project RNGs.
function normalizeSeed(seed: number) {
	if (!Number.isFinite(seed)) throw new RangeError('seed must be finite')
	return seed >>> 0
}

// Requires any finite numeric parameter.
function requireFinite(name: string, value: number) {
	if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`)
	return value
}

// Requires a positive finite numeric parameter.
function requirePositiveFinite(name: string, value: number) {
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be greater than zero`)
	return value
}

// Requires a non-negative finite numeric parameter.
function requireNonNegativeFinite(name: string, value: number) {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`)
	return value
}

// Requires a unit interval parameter.
function requireFraction(name: string, value: number) {
	if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be in the [0, 1] range`)
	return value
}

// Requires an integer in a bounded range.
function requireIntegerInRange(name: string, value: number, min: number, max: number) {
	if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in the [${min}, ${max}] range`)
	return value
}
