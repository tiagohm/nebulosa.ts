import { TAU } from '../../../core/constants'
import type { AmpGlowPosition, AstronomicalImageNoiseConfig, AstronomicalImageNoiseQuality } from '../../../imaging/synthetic/generator'
import type { FrameType } from '../device'
import type { NewNumberVector, NewSwitchVector } from '../types'
import type { CameraNoiseConfig } from './camera.config'
import { type ChoiceBinding, type ComponentBus, type FlagBinding, makeBoundNumberVector, makeChoiceVector, makeFlagVector, type NumberBinding, readBoundNumberVector, readChoiceVector, readFlagVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import { applyExclusiveSwitchValues, applyMultiSwitchValues, applyNumberVectorValues } from './util'

// Noise circuit of the simulated camera: the sensor electronics and the sky background a frame is
// built on, as the synthetic image generator models them. Publishes the parameters an operator tunes
// while imaging; the atmosphere, the moon and light-pollution geometry, and the output stage are fixed
// by the configuration. Exposures are seconds, temperatures °C and angles radians.

// Background components that can be switched on and off.
interface NoiseFeatures {
	// Sky background, light frames only.
	sky: boolean
	// Moonlight, light frames only.
	moon: boolean
	// Light-pollution dome, light frames only.
	lightPollution: boolean
	// Amplifier glow, every frame but a bias.
	ampGlow: boolean
}

// Realism tiers of the generator, SIMULATOR_NOISE_QUALITY.
const QUALITY: readonly ChoiceBinding<AstronomicalImageNoiseQuality>[] = [
	['FAST', 'Fast', 'fast'],
	['BALANCED', 'Balanced', 'balanced'],
	['HIGH_REALISM', 'High Realism', 'high-realism'],
]

// Switchable background components, SIMULATOR_NOISE_FEATURES.
const FEATURES: readonly FlagBinding<keyof NoiseFeatures>[] = [
	['SKY_ENABLED', 'Sky', 'sky'],
	['MOON_ENABLED', 'Moon', 'moon'],
	['LIGHT_POLLUTION_ENABLED', 'Light Pollution', 'lightPollution'],
	['AMP_GLOW_ENABLED', 'Amp Glow', 'ampGlow'],
]

// Exposure and gain chain, SIMULATOR_NOISE_EXPOSURE. The reference exposure is seconds; its range is the shutter's.
const EXPOSURE: readonly NumberBinding<'exposureTime' | 'analogGain' | 'digitalGain' | 'electronsPerAdu'>[] = [
	['EXPOSURE_TIME', 'Exposure Time', 'exposureTime', 0, 0, 0.1, '%.3f'],
	['ANALOG_GAIN', 'Analog Gain', 'analogGain', 0.01, 20, 0.01, '%.3f'],
	['DIGITAL_GAIN', 'Digital Gain', 'digitalGain', 0.01, 20, 0.01, '%.3f'],
	['ELECTRONS_PER_ADU', 'Electrons/ADU', 'electronsPerAdu', 0.01, 100, 0.01, '%.3f'],
]

// Sky background level and gradients, SIMULATOR_NOISE_SKY; rates are electrons per pixel per second and directions radians.
const SKY: readonly NumberBinding<'baseRate' | 'globalOffset' | 'gradientStrength' | 'gradientDirection' | 'radialGradientStrength' | 'lowFrequencyVariationStrength'>[] = [
	['BASE_RATE', 'Base Rate', 'baseRate', 0, 50, 0.01, '%.3f'],
	['GLOBAL_OFFSET', 'Global Offset', 'globalOffset', -10, 10, 0.01, '%.3f'],
	['GRADIENT_STRENGTH', 'Gradient Strength', 'gradientStrength', 0, 10, 0.01, '%.3f'],
	['GRADIENT_DIRECTION', 'Gradient Direction', 'gradientDirection', -TAU, TAU, 0.01, '%.3f'],
	['RADIAL_GRADIENT_STRENGTH', 'Radial Gradient', 'radialGradientStrength', 0, 10, 0.01, '%.3f'],
	['LOW_FREQUENCY_VARIATION_STRENGTH', 'Low Freq Variation', 'lowFrequencyVariationStrength', 0, 10, 0.01, '%.3f'],
]

// Sensor electronics, SIMULATOR_NOISE_SENSOR: noise and bias in electrons, dark current in electrons per pixel per second, temperatures °C.
const SENSOR: readonly NumberBinding<'readNoise' | 'biasElectrons' | 'blackLevelElectrons' | 'darkCurrentAtReferenceTemp' | 'referenceTemperature' | 'temperatureDoublingInterval' | 'darkSignalNonUniformity' | 'fullWellCapacity' | 'channelCorrelation'>[] = [
	['READ_NOISE', 'Read Noise', 'readNoise', 0, 100, 0.01, '%.3f'],
	['BIAS_ELECTRONS', 'Bias Electrons', 'biasElectrons', 0, 10000, 1, '%.0f'],
	['BLACK_LEVEL_ELECTRONS', 'Black Level', 'blackLevelElectrons', 0, 10000, 1, '%.0f'],
	['DARK_CURRENT_AT_REFERENCE_TEMP', 'Dark Current', 'darkCurrentAtReferenceTemp', 0, 100, 0.001, '%.4f'],
	['REFERENCE_TEMPERATURE', 'Reference Temp', 'referenceTemperature', -50, 70, 0.1, '%.2f'],
	['TEMPERATURE_DOUBLING_INTERVAL', 'Doubling Interval', 'temperatureDoublingInterval', 0.1, 50, 0.1, '%.2f'],
	['DARK_SIGNAL_NON_UNIFORMITY', 'DSNU', 'darkSignalNonUniformity', 0, 10, 0.001, '%.4f'],
	['FULL_WELL_CAPACITY', 'Full Well', 'fullWellCapacity', 1, 1000000, 1, '%.0f'],
	['CHANNEL_CORRELATION', 'Channel Correlation', 'channelCorrelation', 0, 1, 0.01, '%.3f'],
]

// Amplifier glow shape, SIMULATOR_NOISE_AMP_GLOW: radii are fractions of the frame.
const AMP_GLOW: readonly NumberBinding<'strength' | 'radiusX' | 'radiusY' | 'falloff'>[] = [
	['STRENGTH', 'Strength', 'strength', 0, 10, 0.001, '%.4f'],
	['RADIUS_X', 'Radius X', 'radiusX', 0.01, 2, 0.01, '%.3f'],
	['RADIUS_Y', 'Radius Y', 'radiusY', 0.01, 2, 0.01, '%.3f'],
	['FALLOFF', 'Falloff', 'falloff', 0.1, 20, 0.1, '%.2f'],
]

// Edge or corner the amplifier glows from, SIMULATOR_NOISE_AMP_GLOW_POSITION.
const AMP_GLOW_POSITION: readonly ChoiceBinding<AmpGlowPosition>[] = [
	['TOP_LEFT', 'Top Left', 'top-left'],
	['TOP_RIGHT', 'Top Right', 'top-right'],
	['BOTTOM_LEFT', 'Bottom Left', 'bottom-left'],
	['BOTTOM_RIGHT', 'Bottom Right', 'bottom-right'],
	['LEFT', 'Left', 'left'],
	['RIGHT', 'Right', 'right'],
	['TOP', 'Top', 'top'],
	['BOTTOM', 'Bottom', 'bottom'],
]

// Structured sensor artifacts, SIMULATOR_NOISE_ARTIFACTS: strengths in electrons, rates as fractions of the pixels.
const ARTIFACTS: readonly NumberBinding<keyof CameraNoiseConfig['artifacts']>[] = [
	['FIXED_PATTERN_NOISE_STRENGTH', 'Fixed Pattern', 'fixedPatternNoiseStrength', 0, 10, 0.001, '%.4f'],
	['ROW_NOISE_STRENGTH', 'Row Noise', 'rowNoiseStrength', 0, 10, 0.001, '%.4f'],
	['COLUMN_NOISE_STRENGTH', 'Column Noise', 'columnNoiseStrength', 0, 10, 0.001, '%.4f'],
	['BANDING_STRENGTH', 'Banding', 'bandingStrength', 0, 10, 0.001, '%.4f'],
	['BANDING_FREQUENCY', 'Banding Frequency', 'bandingFrequency', 0, 100, 0.1, '%.3f'],
	['HOT_PIXEL_RATE', 'Hot Pixel Rate', 'hotPixelRate', 0, 1, 0.00001, '%.5f'],
	['WARM_PIXEL_RATE', 'Warm Pixel Rate', 'warmPixelRate', 0, 1, 0.00001, '%.5f'],
	['DEAD_PIXEL_RATE', 'Dead Pixel Rate', 'deadPixelRate', 0, 1, 0.00001, '%.5f'],
	['HOT_PIXEL_STRENGTH', 'Hot Pixel Strength', 'hotPixelStrength', 0, 10000, 1, '%.0f'],
	['WARM_PIXEL_STRENGTH', 'Warm Pixel Strength', 'warmPixelStrength', 0, 10000, 1, '%.0f'],
	['DEAD_PIXEL_RESIDUAL', 'Dead Pixel Residual', 'deadPixelResidual', 0, 1, 0.001, '%.4f'],
]

// Lowest twilight contribution of a flat frame, normalized: flats are taken against a lit sky or panel.
const FLAT_TWILIGHT = 0.3

// Sky offset added to a flat frame, normalized.
const FLAT_SKY_OFFSET = 0.2

// Electrons of bias added per unit of camera offset.
const BIAS_ELECTRONS_PER_OFFSET = 2

// What a frame's noise depends on besides the published parameters.
export interface CameraNoiseFrame {
	readonly frameType: FrameType
	// Exposure time, seconds.
	readonly exposureTime: number
	// Sensor temperature, °C.
	readonly temperature: number
	// Gain and offset, in the camera's own units.
	readonly gain: number
	readonly offset: number
	// Seed of the frame's noise.
	readonly seed: number
}

// Builds the generator configuration of one frame from the published parameters and the fixed ones.
//
// The frame type shapes it the way real calibration frames differ: only a light frame sees the sky,
// moon and light pollution; a flat sees a brighter, lit sky; a bias integrates the shortest exposure
// and shows no amp glow. Gain multiplies the analog gain by 1 + gain/100, and offset adds
// BIAS_ELECTRONS_PER_OFFSET electrons of bias per unit.
export function cameraNoiseConfig(fixed: CameraNoiseConfig, published: CameraNoisePublished, frame: CameraNoiseFrame, minExposure: number): AstronomicalImageNoiseConfig {
	const { frameType } = frame
	const light = frameType === 'LIGHT'
	const flat = frameType === 'FLAT'
	const { features } = published

	return {
		seed: frame.seed,
		quality: published.quality,
		exposure: { ...published.exposure, exposureTime: frameType === 'BIAS' ? minExposure : frame.exposureTime, analogGain: published.exposure.analogGain * (1 + frame.gain / 100) },
		sky: { ...fixed.sky, ...published.sky, enabled: light && features.sky, globalOffset: published.sky.globalOffset + (flat ? FLAT_SKY_OFFSET : 0) },
		moon: { ...fixed.moon, enabled: light && features.moon },
		lightPollution: { ...fixed.lightPollution, enabled: light && features.lightPollution },
		atmosphere: { ...fixed.atmosphere, twilightContribution: flat ? Math.max(fixed.atmosphere.twilightContribution, FLAT_TWILIGHT) : fixed.atmosphere.twilightContribution },
		sensor: {
			...fixed.sensor,
			...published.sensor,
			biasElectrons: published.sensor.biasElectrons + frame.offset * BIAS_ELECTRONS_PER_OFFSET,
			temperature: frame.temperature,
			ampGlow: { ...fixed.sensor.ampGlow, ...published.ampGlow, position: published.ampGlowPosition, enabled: frameType !== 'BIAS' && features.ampGlow },
		},
		artifacts: published.artifacts,
		output: fixed.output,
	}
}

// Values of the published noise parameters.
export interface CameraNoisePublished {
	readonly quality: AstronomicalImageNoiseQuality
	readonly features: Readonly<NoiseFeatures>
	readonly exposure: Readonly<Record<(typeof EXPOSURE)[number][2], number>>
	readonly sky: Readonly<Record<(typeof SKY)[number][2], number>>
	readonly sensor: Readonly<Record<(typeof SENSOR)[number][2], number>>
	readonly ampGlow: Readonly<Record<(typeof AMP_GLOW)[number][2], number>>
	readonly ampGlowPosition: AmpGlowPosition
	readonly artifacts: Readonly<Record<(typeof ARTIFACTS)[number][2], number>>
}

// Sensor electronics and sky background.
export class CameraNoise extends SimulatorComponent {
	readonly #quality: ReturnType<typeof makeChoiceVector>
	readonly #features: ReturnType<typeof makeFlagVector>
	readonly #exposure: ReturnType<typeof makeBoundNumberVector>
	readonly #sky: ReturnType<typeof makeBoundNumberVector>
	readonly #sensor: ReturnType<typeof makeBoundNumberVector>
	readonly #ampGlow: ReturnType<typeof makeBoundNumberVector>
	readonly #ampGlowPosition: ReturnType<typeof makeChoiceVector>
	readonly #artifacts: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector | typeof makeChoiceVector>[]

	// `config` gives the initial values of the published parameters and fixes the rest; `minExposure`
	// and `maxExposure` bound the reference exposure, seconds.
	constructor(
		bus: ComponentBus,
		readonly config: CameraNoiseConfig,
		readonly minExposure: number,
		maxExposure: number,
	) {
		super(bus)

		const { sky, moon, lightPollution, sensor } = config
		this.#quality = makeChoiceVector('SIMULATOR_NOISE_QUALITY', 'Noise Quality', SIMULATION, QUALITY, config.quality)
		this.#features = makeFlagVector('SIMULATOR_NOISE_FEATURES', 'Noise Features', SIMULATION, FEATURES, { sky: sky.enabled, moon: moon.enabled, lightPollution: lightPollution.enabled, ampGlow: sensor.ampGlow.enabled })
		this.#exposure = makeBoundNumberVector('SIMULATOR_NOISE_EXPOSURE', 'Noise Exposure', SIMULATION, EXPOSURE, config.exposure)
		this.#exposure.elements.EXPOSURE_TIME.min = minExposure
		this.#exposure.elements.EXPOSURE_TIME.max = maxExposure
		this.#sky = makeBoundNumberVector('SIMULATOR_NOISE_SKY', 'Sky', SIMULATION, SKY, sky)
		this.#sensor = makeBoundNumberVector('SIMULATOR_NOISE_SENSOR', 'Sensor', SIMULATION, SENSOR, sensor)
		this.#ampGlow = makeBoundNumberVector('SIMULATOR_NOISE_AMP_GLOW', 'Amp Glow', SIMULATION, AMP_GLOW, sensor.ampGlow)
		this.#ampGlowPosition = makeChoiceVector('SIMULATOR_NOISE_AMP_GLOW_POSITION', 'Amp Glow Position', SIMULATION, AMP_GLOW_POSITION, sensor.ampGlow.position)
		this.#artifacts = makeBoundNumberVector('SIMULATOR_NOISE_ARTIFACTS', 'Artifacts', SIMULATION, ARTIFACTS, config.artifacts)
		this.properties = [this.#quality, this.#features, this.#exposure, this.#sky, this.#sensor, this.#ampGlow, this.#ampGlowPosition, this.#artifacts]
	}

	// Exposure at which stars have the flux of their source and the sky its nominal level, seconds. Both
	// scale linearly with the exposure taken.
	get referenceExposure() {
		return this.#exposure.elements.EXPOSURE_TIME.value
	}

	// Current values of the published parameters.
	snapshot(): CameraNoisePublished {
		return {
			quality: readChoiceVector(this.#quality, QUALITY),
			features: readFlagVector(this.#features, FEATURES),
			exposure: readBoundNumberVector(this.#exposure, EXPOSURE),
			sky: readBoundNumberVector(this.#sky, SKY),
			sensor: readBoundNumberVector(this.#sensor, SENSOR),
			ampGlow: readBoundNumberVector(this.#ampGlow, AMP_GLOW),
			ampGlowPosition: readChoiceVector(this.#ampGlowPosition, AMP_GLOW_POSITION),
			artifacts: readBoundNumberVector(this.#artifacts, ARTIFACTS),
		}
	}

	// Generator configuration of a frame with the current parameters.
	configFor(frame: CameraNoiseFrame) {
		return cameraNoiseConfig(this.config, this.snapshot(), frame, this.minExposure)
	}

	// Handles the published number parameters.
	handleNumber(vector: NewNumberVector) {
		const property = vector.name === this.#exposure.name ? this.#exposure : vector.name === this.#sky.name ? this.#sky : vector.name === this.#sensor.name ? this.#sensor : vector.name === this.#ampGlow.name ? this.#ampGlow : vector.name === this.#artifacts.name ? this.#artifacts : undefined
		if (property === undefined) return false
		if (applyNumberVectorValues(property, vector.elements)) this.bus.notify(property)
		return true
	}

	// Handles the quality, the features and the amp-glow position.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name === this.#features.name) {
			if (applyMultiSwitchValues(this.#features, vector.elements)) this.bus.notify(this.#features)
			return true
		}

		const property = vector.name === this.#quality.name ? this.#quality : vector.name === this.#ampGlowPosition.name ? this.#ampGlowPosition : undefined
		if (property === undefined) return false
		if (applyExclusiveSwitchValues(property, vector.elements)) this.bus.notify(property)
		return true
	}
}
