import { equatorialToJ2000 } from '../../../astronomy/coordinates/coordinate'
import { pixelScale } from '../../../astronomy/formulas'
import { localSiderealTime } from '../../../astronomy/observer/location'
import { Gnomonic } from '../../../astronomy/projections/projection'
import { formatTemporal } from '../../../astronomy/time/temporal'
import { timeUnix } from '../../../astronomy/time/time'
import { ASEC2RAD, DAYSEC, DEG2RAD, PIOVERTWO, TAU } from '../../../core/constants'
import { writeImageToFits, writeImageToXisf } from '../../../imaging/model/image'
import type { CfaPattern, Image, ImageRawType } from '../../../imaging/model/types'
import { colorIndexToRgbWeights, gaussianSigmaFromHfd, plotStar, type PlotStarOptions } from '../../../imaging/stars/generator'
import { evaluateSyntheticAberration, type ResolvedSyntheticAberration, resolveSyntheticAberration, type SyntheticAberrationConfig, type SyntheticStarAberration } from '../../../imaging/synthetic/aberration'
import { applySyntheticCollimationBlur, applySyntheticCollimationSaturation, renderSyntheticCollimationPattern, renderValidatedSyntheticCollimationPattern, type SyntheticCollimationPattern } from '../../../imaging/synthetic/collimation'
import { type AstronomicalImageNoiseConfig, type AstronomicalImageStar, DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG, generateNoiseImage, generateStarImage } from '../../../imaging/synthetic/generator'
import type { FitsHeader } from '../../../io/formats/fits/fits'
import { bufferSink } from '../../../io/io'
import type { Point } from '../../../math/numerical/geometry'
import { clamp } from '../../../math/numerical/math'
import { mulberry32 } from '../../../math/numerical/random'
import { type Angle, arcsec, formatDEC, formatRA, normalizeAngle, toDeg, toHour } from '../../../math/units/angle'
import { polarAlignmentError } from '../../../observation/alignment/polaralignment'
import { handleSetBlobVector, type IndiClientHandler } from '../client'
import { DeviceInterfaceType, type FrameType, type GuideDirection } from '../device'
import type { FocuserManager, GuideOutputManager, MountManager, RotatorManager, WheelManager } from '../manager'
import { findOnSwitch, makeBlobVector, makeNumberVector, makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector } from '../types'
import type { ClientSimulator } from './client'
import { CAMERA_AMBIENT_TEMPERATURE, CAMERA_BLOB_PADDING, CAMERA_DEFAULT_TARGET_TEMPERATURE, CAMERA_MAX_BIN, CAMERA_MAX_EXPOSURE, CAMERA_MIN_EXPOSURE, CAMERA_PIXEL_SIZE, CAMERA_SCENE_SEED, CAMERA_SENSOR_HEIGHT, CAMERA_SENSOR_WIDTH, GENERAL_INFO, MAIN_CONTROL, SIMULATION, TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import type { CatalogSource, CatalogSourceStar, CatalogSourceType, DeviceSimulatorOptions, ReadoutMode, SimulatorProperty, TransferFormat } from './types'
import { applyExclusiveSwitchValues, applyMultiSwitchValues, applyNumberVectorValues, fillFlatField } from './util'

// Simulated astronomical camera acquisition, cooling, guiding, and synthetic image generation.

// Camera simulator options: star catalog sources plus the related device managers used to read the
// simulated mount/guider/focuser/rotator/wheel state when rendering a frame.
export interface CameraSimulatorOptions extends DeviceSimulatorOptions {
	readonly catalogSources?: Record<string, CatalogSource | undefined | null>
	readonly mountManager?: MountManager
	readonly guideOutputManager?: GuideOutputManager
	readonly focuserManager?: FocuserManager
	readonly rotatorManager?: RotatorManager
	readonly wheelManager?: WheelManager
}

// Simulated camera. Models cooling toward a target temperature, frame/subframe/binning/gain/offset, and
// timed exposures that render a synthetic star field (from the snooped mount/focuser/wheel/rotator state
// and a catalog or random source) into a FITS/XISF BLOB. Also exposes a pulse-guide output.
export class CameraSimulator extends DeviceSimulator {
	readonly type = 'camera'

	// oxfmt-ignore
	readonly #info = makeNumberVector('', 'CCD_INFO', 'CCD Info', GENERAL_INFO, 'ro', ['CCD_MAX_X', 'Max X', CAMERA_SENSOR_WIDTH, 0, 16000, 1, '%.0f'],  ['CCD_MAX_Y', 'Max Y', CAMERA_SENSOR_HEIGHT, 0, 16000, 1, '%.0f'],  ['CCD_PIXEL_SIZE_X', 'Pixel size X', CAMERA_PIXEL_SIZE, 0, 40, 0.01, '%.2f'], ['CCD_PIXEL_SIZE_Y', 'Pixel size Y', CAMERA_PIXEL_SIZE, 0, 40, 0.01, '%.2f'], ['CCD_BITSPERPIXEL', 'Bits per pixel', 16, 8, 64, 1, '%.0f'])
	readonly #cooler = makeSwitchVector('', 'CCD_COOLER', 'Cooler', MAIN_CONTROL, 'OneOfMany', 'rw', ['COOLER_ON', 'On', false], ['COOLER_OFF', 'Off', true])
	readonly #frameType = makeSwitchVector('', 'CCD_FRAME_TYPE', 'Frame Type', MAIN_CONTROL, 'OneOfMany', 'rw', ['FRAME_LIGHT', 'Light', true], ['FRAME_DARK', 'Dark', false], ['FRAME_FLAT', 'Flat', false], ['FRAME_BIAS', 'Bias', false])
	readonly #frameFormat = makeSwitchVector('', 'CCD_CAPTURE_FORMAT', 'Readout Mode', MAIN_CONTROL, 'OneOfMany', 'rw', ['MONO', 'Mono', true], ['RGB', 'RGB', false])
	readonly #transferFormat = makeSwitchVector('', 'CCD_TRANSFER_FORMAT', 'Transfer Format', MAIN_CONTROL, 'OneOfMany', 'rw', ['FORMAT_FITS', 'FITS', true], ['FORMAT_XISF', 'XISF', false])
	readonly #abort = makeSwitchVector('', 'CCD_ABORT_EXPOSURE', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #exposure = makeNumberVector('', 'CCD_EXPOSURE', 'Exposure', MAIN_CONTROL, 'rw', ['CCD_EXPOSURE_VALUE', 'Exposure (s)', 0, CAMERA_MIN_EXPOSURE, CAMERA_MAX_EXPOSURE, 1e-3, '%.6f'])
	readonly #coolerPower = makeNumberVector('', 'CCD_COOLER_POWER', 'Cooler Power', MAIN_CONTROL, 'ro', ['CCD_COOLER_POWER', 'Power (%)', 0, 0, 100, 1, '%.0f'])
	readonly #temperature = makeNumberVector('', 'CCD_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'rw', ['CCD_TEMPERATURE_VALUE', 'Temperature', CAMERA_AMBIENT_TEMPERATURE, -50, 70, 0.1, '%6.2f'])
	// oxfmt-ignore
	readonly #frame = makeNumberVector('', 'CCD_FRAME', 'Frame', MAIN_CONTROL, 'rw', ['X', 'X', 0, 0, CAMERA_SENSOR_WIDTH - 1, 1, '%.0f'], ['Y', 'Y', 0, 0, CAMERA_SENSOR_HEIGHT - 1, 1, '%.0f'], ['WIDTH', 'Width', CAMERA_SENSOR_WIDTH, 1, CAMERA_SENSOR_WIDTH, 1, '%.0f'], ['HEIGHT', 'Height', CAMERA_SENSOR_HEIGHT, 1, CAMERA_SENSOR_HEIGHT, 1, '%.0f'])
	readonly #bin = makeNumberVector('', 'CCD_BINNING', 'Bin', MAIN_CONTROL, 'rw', ['HOR_BIN', 'X', 1, 1, CAMERA_MAX_BIN, 1, '%.0f'], ['VER_BIN', 'Y', 1, 1, CAMERA_MAX_BIN, 1, '%.0f'])
	readonly #gain = makeNumberVector('', 'CCD_GAIN', 'Gain', MAIN_CONTROL, 'rw', ['GAIN', 'Gain', 0, 0, 400, 1, '%.0f'])
	readonly #offset = makeNumberVector('', 'CCD_OFFSET', 'Offset', MAIN_CONTROL, 'rw', ['OFFSET', 'Offset', 0, 0, 1000, 1, '%.0f'])
	readonly #cfa = makeTextVector('', 'CCD_CFA', 'CFA', GENERAL_INFO, 'ro', ['CFA_OFFSET_X', 'Offset X', '0'], ['CFA_OFFSET_Y', 'Offset Y', '0'], ['CFA_TYPE', 'Type', 'RGGB'])
	readonly #guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #image = makeBlobVector('', 'CCD1', 'CCD Image', MAIN_CONTROL, 'ro', ['CCD1', 'Image'])

	// oxfmt-ignore
	readonly #scene = makeNumberVector('', 'SIMULATOR_SCENE', 'Scene', SIMULATION, 'rw', ['SCENE_SEED', 'Seed', CAMERA_SCENE_SEED, 0, 0xffffffff, 1, '%.0f'], ['STAR_DENSITY', 'Star Density', 0.0006, 0, 0.01, 0.0001, '%.6f'], ['SEEING', 'Seeing (px)', 1.2, 0, 20, 0.1, '%.2f'], ['HFD_MIN', 'HFD Min (px)', 1.2, 0.35, 10, 0.1, '%.2f'], ['HFD_MAX', 'HFD Max (px)', 3.6, 0.35, 20, 0.1, '%.2f'], ['FLUX_MIN', 'Flux Min', 0.002, 0, 10, 0.001, '%.4f'], ['FLUX_MAX', 'Flux Max', 0.85, 0, 100, 0.01, '%.4f'])
	readonly #catalogSource = makeSwitchVector('', 'SIMULATOR_CATALOG_SOURCE', 'Catalog Source', SIMULATION, 'OneOfMany', 'rw', ['RANDOM', 'Random', true], ['VIZIER', 'VizieR', false])
	// oxfmt-ignore
	readonly #noiseQuality = makeSwitchVector('', 'SIMULATOR_NOISE_QUALITY', 'Noise Quality', SIMULATION, 'OneOfMany', 'rw', ['FAST', 'Fast', false], ['BALANCED', 'Balanced', true], ['HIGH_REALISM', 'High Realism', false])
	// oxfmt-ignore
	readonly #noiseFeatures = makeSwitchVector('', 'SIMULATOR_NOISE_FEATURES', 'Noise Features', SIMULATION, 'AnyOfMany', 'rw', ['SKY_ENABLED', 'Sky', true], ['MOON_ENABLED', 'Moon', false], ['LIGHT_POLLUTION_ENABLED', 'Light Pollution', true], ['AMP_GLOW_ENABLED', 'Amp Glow', false], ['OUTPUT_QUANTIZE', 'Quantize', false])
	// oxfmt-ignore
	readonly #noiseExposure = makeNumberVector('', 'SIMULATOR_NOISE_EXPOSURE', 'Noise Exposure', SIMULATION, 'rw', ['EXPOSURE_TIME', 'Exposure Time', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure.exposureTime, CAMERA_MIN_EXPOSURE, CAMERA_MAX_EXPOSURE, 0.1, '%.3f'], ['ANALOG_GAIN', 'Analog Gain', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure.analogGain, 0.01, 20, 0.01, '%.3f'], ['DIGITAL_GAIN', 'Digital Gain', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure.digitalGain, 0.01, 20, 0.01, '%.3f'], ['ELECTRONS_PER_ADU', 'Electrons/ADU', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure.electronsPerAdu, 0.01, 100, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseSky = makeNumberVector('', 'SIMULATOR_NOISE_SKY', 'Sky', SIMULATION, 'rw', ['BASE_RATE', 'Base Rate', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.baseRate, 0, 50, 0.01, '%.3f'], ['GLOBAL_OFFSET', 'Global Offset', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.globalOffset, -10, 10, 0.01, '%.3f'], ['GRADIENT_STRENGTH', 'Gradient Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.gradientStrength, 0, 10, 0.01, '%.3f'], ['GRADIENT_DIRECTION', 'Gradient Direction', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.gradientDirection, -TAU, TAU, 0.01, '%.3f'], ['RADIAL_GRADIENT_STRENGTH', 'Radial Gradient', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.radialGradientStrength, 0, 10, 0.01, '%.3f'], ['LOW_FREQUENCY_VARIATION_STRENGTH', 'Low Freq Variation', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.lowFrequencyVariationStrength, 0, 10, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseMoon = makeNumberVector('', 'SIMULATOR_NOISE_MOON', 'Moon', SIMULATION, 'rw', ['ILLUMINATION_FRACTION', 'Illumination', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.illuminationFraction, 0, 1, 0.01, '%.3f'], ['ALTITUDE', 'Altitude', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.altitude, -PIOVERTWO, PIOVERTWO, 0.01, '%.3f'], ['ANGULAR_DISTANCE', 'Angular Distance', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.angularDistance, 0, TAU, 0.01, '%.3f'], ['POSITION_ANGLE', 'Position Angle', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.positionAngle, -TAU, TAU, 0.01, '%.3f'], ['STRENGTH', 'Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.strength, 0, 10, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseLightPollution = makeNumberVector('', 'SIMULATOR_NOISE_LIGHT_POLLUTION', 'Light Pollution', SIMULATION, 'rw', ['STRENGTH', 'Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.strength, 0, 10, 0.01, '%.3f'], ['DIRECTION', 'Direction', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.direction, -TAU, TAU, 0.01, '%.3f'], ['GRADIENT_STRENGTH', 'Gradient Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.gradientStrength, 0, 10, 0.01, '%.3f'], ['DOME_SHARPNESS', 'Dome Sharpness', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.domeSharpness, 0, 20, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseAtmosphere = makeNumberVector('', 'SIMULATOR_NOISE_ATMOSPHERE', 'Atmosphere', SIMULATION, 'rw', ['AIRGLOW_STRENGTH', 'Airglow', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.airglowStrength, 0, 10, 0.01, '%.3f'], ['TRANSPARENCY', 'Transparency', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.transparency, 0, 2, 0.01, '%.3f'], ['AIRMASS', 'Airmass', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.airmass, 0, 10, 0.01, '%.3f'], ['HAZE', 'Haze', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.haze, 0, 10, 0.01, '%.3f'], ['HUMIDITY', 'Humidity', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.humidity, 0, 1, 0.01, '%.3f'], ['THIN_CLOUD_VEIL', 'Thin Cloud Veil', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.thinCloudVeil, 0, 10, 0.01, '%.3f'], ['TWILIGHT_CONTRIBUTION', 'Twilight', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.twilightContribution, 0, 10, 0.01, '%.3f'], ['HORIZON_GLOW', 'Horizon Glow', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.horizonGlow, 0, 10, 0.01, '%.3f'], ['ZODIACAL_LIGHT_FACTOR', 'Zodiacal Light', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.zodiacalLightFactor, 0, 10, 0.01, '%.3f'], ['MILKY_WAY_BACKGROUND_FACTOR', 'Milky Way', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.milkyWayBackgroundFactor, 0, 10, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseSensor = makeNumberVector('', 'SIMULATOR_NOISE_SENSOR', 'Sensor', SIMULATION, 'rw', ['READ_NOISE', 'Read Noise', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.readNoise, 0, 100, 0.01, '%.3f'], ['BIAS_ELECTRONS', 'Bias Electrons', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.biasElectrons, 0, 10000, 1, '%.0f'], ['BLACK_LEVEL_ELECTRONS', 'Black Level', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.blackLevelElectrons, 0, 10000, 1, '%.0f'], ['DARK_CURRENT_AT_REFERENCE_TEMP', 'Dark Current', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.darkCurrentAtReferenceTemp, 0, 100, 0.001, '%.4f'], ['REFERENCE_TEMPERATURE', 'Reference Temp', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.referenceTemperature, -50, 70, 0.1, '%.2f'], ['TEMPERATURE', 'Sensor Temp', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.temperature, -50, 70, 0.1, '%.2f'], ['TEMPERATURE_DOUBLING_INTERVAL', 'Doubling Interval', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.temperatureDoublingInterval, 0.1, 50, 0.1, '%.2f'], ['DARK_SIGNAL_NON_UNIFORMITY', 'DSNU', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.darkSignalNonUniformity, 0, 10, 0.001, '%.4f'], ['FULL_WELL_CAPACITY', 'Full Well', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.fullWellCapacity, 1, 1000000, 1, '%.0f'], ['CHANNEL_CORRELATION', 'Channel Correlation', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.channelCorrelation, 0, 1, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseAmpGlow = makeNumberVector('', 'SIMULATOR_NOISE_AMP_GLOW', 'Amp Glow', SIMULATION, 'rw', ['STRENGTH', 'Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.strength, 0, 10, 0.001, '%.4f'], ['RADIUS_X', 'Radius X', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.radiusX, 0.01, 2, 0.01, '%.3f'], ['RADIUS_Y', 'Radius Y', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.radiusY, 0.01, 2, 0.01, '%.3f'], ['FALLOFF', 'Falloff', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.falloff, 0.1, 20, 0.1, '%.2f'])
	// oxfmt-ignore
	readonly #noiseAmpGlowPosition = makeSwitchVector('', 'SIMULATOR_NOISE_AMP_GLOW_POSITION', 'Amp Glow Position', SIMULATION, 'OneOfMany', 'rw', ['TOP_LEFT', 'Top Left', false], ['TOP_RIGHT', 'Top Right', false], ['BOTTOM_LEFT', 'Bottom Left', false], ['BOTTOM_RIGHT', 'Bottom Right', false], ['LEFT', 'Left', false], ['RIGHT', 'Right', true], ['TOP', 'Top', false], ['BOTTOM', 'Bottom', false])
	// oxfmt-ignore
	readonly #noiseArtifacts = makeNumberVector('', 'SIMULATOR_NOISE_ARTIFACTS', 'Artifacts', SIMULATION, 'rw', ['FIXED_PATTERN_NOISE_STRENGTH', 'Fixed Pattern', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.fixedPatternNoiseStrength, 0, 10, 0.001, '%.4f'], ['ROW_NOISE_STRENGTH', 'Row Noise', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.rowNoiseStrength, 0, 10, 0.001, '%.4f'], ['COLUMN_NOISE_STRENGTH', 'Column Noise', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.columnNoiseStrength, 0, 10, 0.001, '%.4f'], ['BANDING_STRENGTH', 'Banding', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.bandingStrength, 0, 10, 0.001, '%.4f'], ['BANDING_FREQUENCY', 'Banding Frequency', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.bandingFrequency, 0, 100, 0.1, '%.3f'], ['HOT_PIXEL_RATE', 'Hot Pixel Rate', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.hotPixelRate, 0, 1, 0.00001, '%.5f'], ['WARM_PIXEL_RATE', 'Warm Pixel Rate', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.warmPixelRate, 0, 1, 0.00001, '%.5f'], ['DEAD_PIXEL_RATE', 'Dead Pixel Rate', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.deadPixelRate, 0, 1, 0.00001, '%.5f'], ['HOT_PIXEL_STRENGTH', 'Hot Pixel Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.hotPixelStrength, 0, 10000, 1, '%.0f'], ['WARM_PIXEL_STRENGTH', 'Warm Pixel Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.warmPixelStrength, 0, 10000, 1, '%.0f'], ['DEAD_PIXEL_RESIDUAL', 'Dead Pixel Residual', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.deadPixelResidual, 0, 1, 0.001, '%.4f'])
	readonly #noiseOutput = makeNumberVector('', 'SIMULATOR_NOISE_OUTPUT', 'Output', SIMULATION, 'rw', ['MAX_VALUE', 'Max Value', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.output.maxValue, 1, 4294967295, 1, '%.0f'])
	readonly #noiseClampMode = makeSwitchVector('', 'SIMULATOR_NOISE_CLAMP_MODE', 'Clamp Mode', SIMULATION, 'OneOfMany', 'rw', ['CLAMP', 'Clamp', true], ['NORMALIZE', 'Normalize', false], ['NONE', 'None', false])
	// oxfmt-ignore
	readonly #plotOptions = makeNumberVector('', 'SIMULATOR_STAR_PLOT_OPTIONS', 'Star Plot', SIMULATION, 'rw', ['BACKGROUND', 'Background', 0, 0, 10, 0.001, '%.4f'], ['SATURATION_LEVEL', 'Saturation Level', 1, 0, 10, 0.01, '%.3f'], ['FOCUS_STEP', 'Focus Step', 50000, 0, 100000, 1, '%.0f'], ['BEST_FOCUS', 'Best Focus', 50000, 0, 100000, 1, '%.0f'], ['PEAK_SCALE', 'Peak Scale', 1, 0.01, 20, 0.01, '%.3f'], ['ELLIPTICITY', 'Ellipticity', 0, 0, 0.8, 0.01, '%.3f'], ['THETA', 'Theta', 0, -TAU, TAU, 0.01, '%.3f'], ['SOFT_CORE', 'Soft Core', 0, 0, 10, 0.01, '%.3f'], ['BETA', 'Beta', 2.5, 1.05, 20, 0.01, '%.3f'], ['HALO_STRENGTH', 'Halo Strength', 0, 0, 5, 0.01, '%.3f'], ['HALO_SCALE', 'Halo Scale', 2.8, 1.1, 20, 0.01, '%.3f'], ['JITTER_X', 'Jitter X', 0, -5, 5, 0.01, '%.3f'], ['JITTER_Y', 'Jitter Y', 0, -5, 5, 0.01, '%.3f'], ['GAIN', 'Plot Gain', 1, 0.01, 20, 0.01, '%.3f'], ['GAMMA_COMPENSATION', 'Gamma Compensation', 2.2, 0.1, 10, 0.01, '%.3f'], ['ADDITIVE_NOISE_HINT', 'Additive Noise Hint', 0, 0, 20, 0.01, '%.3f'], ['MIN_PLOT_RADIUS', 'Min Radius', 2, 0, 50, 1, '%.0f'], ['MAX_PLOT_RADIUS', 'Max Radius', 24, 0, 100, 1, '%.0f'], ['CUTOFF_SIGMA', 'Cutoff Sigma', 4.25, 2.5, 10, 0.01, '%.3f'])
	readonly #plotFlags = makeSwitchVector('', 'SIMULATOR_STAR_PLOT_FLAGS', 'Star Plot Flags', SIMULATION, 'AnyOfMany', 'rw', ['SATURATION_ENABLED', 'Saturation', false], ['GAMMA_ENABLED', 'Gamma', false])
	readonly #plotPsfModel = makeSwitchVector('', 'SIMULATOR_STAR_PLOT_PSF_MODEL', 'Star PSF Model', SIMULATION, 'OneOfMany', 'rw', ['GAUSSIAN', 'Gaussian', true], ['MOFFAT', 'Moffat', false], ['ANNULAR', 'Annular', false])
	// oxfmt-ignore
	readonly #collimationPattern = makeNumberVector('', 'SIMULATOR_COLLIMATION_PATTERN', 'Collimation Pattern', SIMULATION, 'rw', ['MAX_RADIUS', 'Maximum Radius (px)', 48, 2, 512, 1, '%.0f'], ['OBSTRUCTION_RATIO', 'Obstruction Ratio', 0.35, 0.05, 0.9, 0.01, '%.3f'], ['EDGE_SOFTNESS', 'Edge Softness (px)', 0.8, 0.05, 20, 0.05, '%.2f'], ['SPIDER_VANES', 'Spider Vanes', 0, 0, 12, 1, '%.0f'], ['SPIDER_WIDTH', 'Spider Width (px)', 1.5, 0, 20, 0.1, '%.2f'], ['SPIDER_ANGLE', 'Spider Angle (rad)', 0, -TAU, TAU, 0.01, '%.3f'], ['SPIDER_ATTENUATION', 'Spider Attenuation', 0.9, 0, 1, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #aberrationFeatures = makeSwitchVector('', 'SIMULATOR_ABERRATION_FEATURES', 'Aberration Features', SIMULATION, 'AnyOfMany', 'rw', ['SENSOR_TILT', 'Sensor Tilt', false], ['BACKFOCUS', 'Backfocus', false], ['FIELD_CURVATURE', 'Field Curvature', false], ['COMA', 'Coma', false], ['ASTIGMATISM', 'Astigmatism', false], ['DECENTER', 'Decenter', false], ['COLLIMATION', 'Collimation', false])
	// oxfmt-ignore
	readonly #aberrationFocus = makeNumberVector('', 'SIMULATOR_ABERRATION_FOCUS', 'Aberration Focus', SIMULATION, 'rw', ['FOCUS_RANGE', 'Focus Range (steps)', 2000, 1, 100000, 10, '%.0f'], ['TILT', 'Sensor Tilt (steps)', 0, -50000, 50000, 10, '%.0f'], ['TILT_ANGLE', 'Tilt Angle (rad)', 0, -TAU, TAU, 0.01, '%.3f'], ['CURVATURE', 'Field Curvature (steps)', 0, -50000, 50000, 10, '%.0f'])
	// oxfmt-ignore
	readonly #aberrationShape = makeNumberVector('', 'SIMULATOR_ABERRATION_SHAPE', 'Aberration Shape', SIMULATION, 'rw', ['BACKFOCUS', 'Backfocus', 0, -1, 1, 0.01, '%.3f'], ['BACKFOCUS_BLUR', 'Backfocus Blur (px)', 4, 0, 100, 0.1, '%.2f'], ['BACKFOCUS_ELLIPTICITY', 'Backfocus Ellipticity', 0.35, 0, 0.8, 0.01, '%.3f'], ['COMA', 'Coma', 0, 0, 1, 0.01, '%.3f'], ['ASTIGMATISM', 'Astigmatism', 0, -0.8, 0.8, 0.01, '%.3f'], ['ASTIGMATISM_BLUR', 'Astigmatism Blur (px)', 4, 0, 100, 0.1, '%.2f'], ['ASTIGMATISM_ANGLE', 'Astigmatism Angle (rad)', 0, -TAU, TAU, 0.01, '%.3f'], ['DECENTER_X', 'Decenter X', 0, -0.5, 0.5, 0.01, '%.3f'], ['DECENTER_Y', 'Decenter Y', 0, -0.5, 0.5, 0.01, '%.3f'], ['COLLIMATION', 'Collimation', 0, 0, 1, 0.01, '%.3f'], ['COLLIMATION_ANGLE', 'Collimation Angle (rad)', 0, -TAU, TAU, 0.01, '%.3f'])
	readonly #telescopeInfo = makeNumberVector('', 'TELESCOPE_INFO', 'Telescope Info', SIMULATION, 'rw', ['FOCAL_LENGTH', 'Focal Length (mm)', 500, 1, 10000, 1, '%.0f'], ['APERTURE', 'Aperture (mm)', 80, 1, 3000, 1, '%.0f'])
	readonly #telescopeEffects = makeNumberVector(
		'',
		'TELESCOPE_EFFECTS',
		'Telescope Effects',
		SIMULATION,
		'rw',
		['PAE_AZ', 'PAE Azimuth (arcsec)', 0, -36000, 36000, 0.1, '%.3f'],
		['PAE_AL', 'PAE Altitude (arcsec)', 0, -36000, 36000, 0.1, '%.3f'],
		['PE_WE_PERIOD', 'PE W/E Period (s)', 0, 0, DAYSEC, 1, '%.0f'],
		['PE_WE_AMPLITUDE', 'PE W/E Amplitude (arcsec)', 0, 0, 3600, 0.1, '%.3f'],
		['PE_NS_PERIOD', 'PE N/S Period (s)', 0, 0, DAYSEC, 1, '%.0f'],
		['PE_NS_AMPLITUDE', 'PE N/S Amplitude (arcsec)', 0, 0, 3600, 0.1, '%.3f'],
	)

	protected readonly properties: readonly SimulatorProperty[] = [
		this.#info,
		this.#cooler,
		this.#frameType,
		this.#frameFormat,
		this.#transferFormat,
		this.#abort,
		this.#exposure,
		this.#coolerPower,
		this.#temperature,
		this.#frame,
		this.#bin,
		this.#gain,
		this.#offset,
		this.#cfa,
		this.#guideNS,
		this.#guideWE,
		this.#image,
		this.#scene,
		this.#catalogSource,
		this.#noiseQuality,
		this.#noiseFeatures,
		this.#noiseExposure,
		this.#noiseSky,
		this.#noiseMoon,
		this.#noiseLightPollution,
		this.#noiseAtmosphere,
		this.#noiseSensor,
		this.#noiseAmpGlow,
		this.#noiseAmpGlowPosition,
		this.#noiseArtifacts,
		this.#noiseOutput,
		this.#noiseClampMode,
		this.#plotOptions,
		this.#plotFlags,
		this.#plotPsfModel,
		this.#collimationPattern,
		this.#aberrationFeatures,
		this.#aberrationFocus,
		this.#aberrationShape,
		this.#telescopeInfo,
		this.#telescopeEffects,
	]

	protected readonly propertiesToNotSave: readonly SimulatorProperty[] = [this.#info, this.#cooler, this.#abort, this.#exposure, this.#coolerPower, this.#temperature, this.#cfa, this.#guideNS, this.#guideWE, this.#image]

	#timer?: NodeJS.Timeout
	#exposureEndTime = 0
	#exposureDuration = 0
	#targetTemperature = CAMERA_DEFAULT_TARGET_TEMPERATURE
	#catalog?: readonly (AstronomicalImageStar | undefined)[]
	#catalogKey = ''
	#catalogDirty = true
	#pulseNorthSouthUntil = 0
	#pulseWestEastUntil = 0
	#mountPeriodicWestEastOffset = 0
	#mountPeriodicNorthSouthOffset = 0

	readonly #mountManager?: MountManager
	readonly #focuserManager?: FocuserManager
	readonly #rotatorManager?: RotatorManager
	readonly #guideOutputManager?: GuideOutputManager
	readonly #wheelManager?: WheelManager

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: CameraSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.CCD | DeviceInterfaceType.GUIDER)

		for (const property of this.properties) {
			property.device = name
		}

		if (options?.catalogSources) {
			for (const name of Object.keys(options.catalogSources)) {
				if (options.catalogSources[name]) {
					this.#catalogSource.elements[name] = { name, label: name, value: name === 'RANDOM' }
				}
			}
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'camera.simulator'

		this.#mountManager = options?.mountManager
		this.#focuserManager = options?.focuserManager
		this.#rotatorManager = options?.rotatorManager
		this.#guideOutputManager = options?.guideOutputManager
		this.#wheelManager = options?.wheelManager
	}

	get activeMount() {
		const mount = this.#mountManager?.get(this.client, this.snoopDevices.elements.ACTIVE_TELESCOPE.value)
		return mount?.connected ? mount : undefined
	}

	get activeFocuser() {
		const focuser = this.#focuserManager?.get(this.client, this.snoopDevices.elements.ACTIVE_FOCUSER.value)
		return focuser?.connected ? focuser : undefined
	}

	get activeRotator() {
		const rotator = this.#rotatorManager?.get(this.client, this.snoopDevices.elements.ACTIVE_ROTATOR.value)
		return rotator?.connected ? rotator : undefined
	}

	get activeFilter() {
		const wheel = this.#wheelManager?.get(this.client, this.snoopDevices.elements.ACTIVE_FILTER.value)
		return wheel?.connected ? wheel : undefined
	}

	// Returns the selected catalog backend for light-frame stars.
	get catalogSourceType(): CatalogSourceType {
		return findOnSwitch(this.#catalogSource)[0]
	}

	get frameType(): FrameType {
		return this.#frameType.elements.FRAME_DARK.value ? 'DARK' : this.#frameType.elements.FRAME_FLAT.value ? 'FLAT' : this.#frameType.elements.FRAME_BIAS.value ? 'BIAS' : 'LIGHT'
	}

	get isExposuring() {
		return this.#exposure.state === 'Busy'
	}

	get isPulsing() {
		return this.#guideNS.state === 'Busy'
	}

	get telescopeFocalLength() {
		return this.#telescopeInfo.elements.FOCAL_LENGTH.value
	}

	get telescopeAperture() {
		return this.#telescopeInfo.elements.APERTURE.value
	}

	// Handles camera text commands: snooped-device changes invalidate the cached star catalog.
	sendText(vector: NewTextVector) {
		super.sendText(vector)

		if (vector.name === 'ACTIVE_DEVICES') {
			this.#catalogDirty = true
		}
	}

	// Handles camera number commands: start exposure, set CCD temperature, subframe, binning, gain/offset,
	// guide rate, timed pulse-guiding, and the synthetic-scene/noise parameters.
	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'CCD_EXPOSURE':
				if (vector.elements.CCD_EXPOSURE_VALUE !== undefined) this.startExposure(vector.elements.CCD_EXPOSURE_VALUE)
				return
			case 'CCD_TEMPERATURE':
				if (vector.elements.CCD_TEMPERATURE_VALUE !== undefined) this.setTargetTemperature(vector.elements.CCD_TEMPERATURE_VALUE)
				return
			case 'CCD_FRAME':
				this.setFrame(vector.elements.X, vector.elements.Y, vector.elements.WIDTH, vector.elements.HEIGHT)
				return
			case 'CCD_BINNING':
				this.setBin(vector.elements.HOR_BIN, vector.elements.VER_BIN)
				return
			case 'CCD_GAIN':
				if (applyNumberVectorValues(this.#gain, vector.elements)) this.notify(this.#gain)
				return
			case 'CCD_OFFSET':
				if (applyNumberVectorValues(this.#offset, vector.elements)) this.notify(this.#offset)
				return
			case 'TELESCOPE_TIMED_GUIDE_NS':
				if ((vector.elements.TIMED_GUIDE_N ?? 0) > 0) this.pulse('NORTH', vector.elements.TIMED_GUIDE_N)
				else if ((vector.elements.TIMED_GUIDE_S ?? 0) > 0) this.pulse('SOUTH', vector.elements.TIMED_GUIDE_S)
				return
			case 'TELESCOPE_TIMED_GUIDE_WE':
				if ((vector.elements.TIMED_GUIDE_W ?? 0) > 0) this.pulse('WEST', vector.elements.TIMED_GUIDE_W)
				else if ((vector.elements.TIMED_GUIDE_E ?? 0) > 0) this.pulse('EAST', vector.elements.TIMED_GUIDE_E)
				return
			case 'SIMULATOR_SCENE':
				if (applyNumberVectorValues(this.#scene, vector.elements)) {
					if (this.catalogSourceType === 'RANDOM') this.#catalogDirty = true
					this.notify(this.#scene)
				}
				return
			case 'SIMULATOR_NOISE_EXPOSURE':
				if (applyNumberVectorValues(this.#noiseExposure, vector.elements)) this.notify(this.#noiseExposure)
				return
			case 'SIMULATOR_NOISE_SKY':
				if (applyNumberVectorValues(this.#noiseSky, vector.elements)) this.notify(this.#noiseSky)
				return
			case 'SIMULATOR_NOISE_MOON':
				if (applyNumberVectorValues(this.#noiseMoon, vector.elements)) this.notify(this.#noiseMoon)
				return
			case 'SIMULATOR_NOISE_LIGHT_POLLUTION':
				if (applyNumberVectorValues(this.#noiseLightPollution, vector.elements)) this.notify(this.#noiseLightPollution)
				return
			case 'SIMULATOR_NOISE_ATMOSPHERE':
				if (applyNumberVectorValues(this.#noiseAtmosphere, vector.elements)) this.notify(this.#noiseAtmosphere)
				return
			case 'SIMULATOR_NOISE_SENSOR':
				if (applyNumberVectorValues(this.#noiseSensor, vector.elements)) this.notify(this.#noiseSensor)
				return
			case 'SIMULATOR_NOISE_AMP_GLOW':
				if (applyNumberVectorValues(this.#noiseAmpGlow, vector.elements)) this.notify(this.#noiseAmpGlow)
				return
			case 'SIMULATOR_NOISE_ARTIFACTS':
				if (applyNumberVectorValues(this.#noiseArtifacts, vector.elements)) this.notify(this.#noiseArtifacts)
				return
			case 'SIMULATOR_NOISE_OUTPUT':
				if (applyNumberVectorValues(this.#noiseOutput, vector.elements)) this.notify(this.#noiseOutput)
				return
			case 'SIMULATOR_STAR_PLOT_OPTIONS':
				if (applyNumberVectorValues(this.#plotOptions, vector.elements)) this.notify(this.#plotOptions)
				return
			case 'SIMULATOR_COLLIMATION_PATTERN':
				if (applyNumberVectorValues(this.#collimationPattern, vector.elements)) this.notify(this.#collimationPattern)
				return
			case 'SIMULATOR_ABERRATION_FOCUS':
				if (applyNumberVectorValues(this.#aberrationFocus, vector.elements)) this.notify(this.#aberrationFocus)
				return
			case 'SIMULATOR_ABERRATION_SHAPE':
				if (applyNumberVectorValues(this.#aberrationShape, vector.elements)) this.notify(this.#aberrationShape)
				return
			case 'TELESCOPE_INFO':
				if (applyNumberVectorValues(this.#telescopeInfo, vector.elements)) this.notify(this.#telescopeInfo)
				return
			case 'TELESCOPE_EFFECTS':
				if (applyNumberVectorValues(this.#telescopeEffects, vector.elements)) this.notify(this.#telescopeEffects)
		}
	}

	// Handles camera switch commands: connection, cooler, capture/transfer format, abort, frame type, and
	// the synthetic-scene/noise toggles.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'CCD_COOLER':
				if (applyExclusiveSwitchValues(this.#cooler, vector.elements)) this.notify(this.#cooler)
				return
			case 'CCD_CAPTURE_FORMAT':
				if (applyExclusiveSwitchValues(this.#frameFormat, vector.elements)) this.notify(this.#frameFormat)
				return
			case 'CCD_TRANSFER_FORMAT':
				if (applyExclusiveSwitchValues(this.#transferFormat, vector.elements)) this.notify(this.#transferFormat)
				return
			case 'CCD_ABORT_EXPOSURE':
				if (vector.elements.ABORT === true) this.abortExposure()
				return
			case 'CCD_FRAME_TYPE':
				if (applyExclusiveSwitchValues(this.#frameType, vector.elements)) this.notify(this.#frameType)
				return
			case 'SIMULATOR_CATALOG_SOURCE':
				if (applyExclusiveSwitchValues(this.#catalogSource, vector.elements)) {
					this.#catalogDirty = true
					this.notify(this.#catalogSource)
				}
				return
			case 'SIMULATOR_NOISE_QUALITY':
				if (applyExclusiveSwitchValues(this.#noiseQuality, vector.elements)) this.notify(this.#noiseQuality)
				return
			case 'SIMULATOR_NOISE_FEATURES':
				if (applyMultiSwitchValues(this.#noiseFeatures, vector.elements)) this.notify(this.#noiseFeatures)
				return
			case 'SIMULATOR_NOISE_AMP_GLOW_POSITION':
				if (applyExclusiveSwitchValues(this.#noiseAmpGlowPosition, vector.elements)) this.notify(this.#noiseAmpGlowPosition)
				return
			case 'SIMULATOR_NOISE_CLAMP_MODE':
				if (applyExclusiveSwitchValues(this.#noiseClampMode, vector.elements)) this.notify(this.#noiseClampMode)
				return
			case 'SIMULATOR_STAR_PLOT_FLAGS':
				if (applyMultiSwitchValues(this.#plotFlags, vector.elements)) this.notify(this.#plotFlags)
				return
			case 'SIMULATOR_ABERRATION_FEATURES':
				if (applyMultiSwitchValues(this.#aberrationFeatures, vector.elements)) this.notify(this.#aberrationFeatures)
				return
			case 'SIMULATOR_STAR_PLOT_PSF_MODEL':
				if (applyExclusiveSwitchValues(this.#plotPsfModel, vector.elements)) this.notify(this.#plotPsfModel)
		}
	}

	// Connects the simulated camera and publishes its supported properties.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Disconnects the simulated camera and removes its dynamic properties.
	disconnect() {
		if (!this.#timer) return

		clearInterval(this.#timer)
		this.#timer = undefined
		this.abortExposure(false)
		this.#clearPulseGuide()
		super.disconnect()
	}

	// Disposes the camera simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts an exposure countdown and schedules image synthesis at completion.
	startExposure(duration: number) {
		if (!this.isConnected || this.isExposuring) return

		duration = clamp(duration, this.#exposure.elements.CCD_EXPOSURE_VALUE.min, this.#exposure.elements.CCD_EXPOSURE_VALUE.max)
		this.#exposureDuration = duration
		this.#exposureEndTime = Date.now() + Math.trunc(duration * 1000)
		this.#exposure.state = 'Busy'
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = duration
		this.#image.state = 'Busy'
		this.#image.elements.CCD1.value = undefined
		this.#image.elements.CCD1.size = '0'
		this.#abort.elements.ABORT.value = false
		this.notify(this.#exposure)
	}

	// Aborts the current exposure without producing a frame.
	abortExposure(alert: boolean = false) {
		if (!this.isExposuring && !this.#exposureEndTime) return
		this.#exposureEndTime = 0
		this.#exposureDuration = 0
		this.#image.state = alert ? 'Alert' : 'Idle'
		this.#exposure.state = alert ? 'Alert' : 'Idle'
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = 0
		this.notify(this.#exposure)
	}

	// Updates the simulated target temperature.
	setTargetTemperature(value: number) {
		value = clamp(value, this.#temperature.elements.CCD_TEMPERATURE_VALUE.min, this.#temperature.elements.CCD_TEMPERATURE_VALUE.max)
		if (this.#targetTemperature === value) return
		this.#targetTemperature = value
		this.#noiseSensor.elements.TEMPERATURE.value = value
		this.notify(this.#noiseSensor)
	}

	// Updates the active subframe within sensor bounds.
	setFrame(x?: number, y?: number, width?: number, height?: number) {
		const maxWidth = this.sensorWidth
		const maxHeight = this.sensorHeight
		const nextX = clamp(Math.trunc(x ?? this.#frame.elements.X.value), 0, maxWidth - 1)
		const nextY = clamp(Math.trunc(y ?? this.#frame.elements.Y.value), 0, maxHeight - 1)
		const nextWidth = clamp(Math.trunc(width ?? this.#frame.elements.WIDTH.value), 1, maxWidth - nextX)
		const nextHeight = clamp(Math.trunc(height ?? this.#frame.elements.HEIGHT.value), 1, maxHeight - nextY)
		let updated = false

		if (this.#frame.elements.X.value !== nextX) {
			this.#frame.elements.X.value = nextX
			updated = true
		}

		if (this.#frame.elements.Y.value !== nextY) {
			this.#frame.elements.Y.value = nextY
			updated = true
		}

		if (this.#frame.elements.WIDTH.value !== nextWidth) {
			this.#frame.elements.WIDTH.value = nextWidth
			updated = true
		}

		if (this.#frame.elements.HEIGHT.value !== nextHeight) {
			this.#frame.elements.HEIGHT.value = nextHeight
			updated = true
		}

		if (updated) {
			this.notify(this.#frame)
		}
	}

	// Updates hardware binning within the simulated camera limits.
	setBin(horizontal?: number, vertical?: number) {
		const nextHorizontal = clamp(Math.trunc(horizontal ?? this.#bin.elements.HOR_BIN.value), 1, this.#bin.elements.HOR_BIN.max)
		const nextVertical = clamp(Math.trunc(vertical ?? this.#bin.elements.VER_BIN.value), 1, this.#bin.elements.VER_BIN.max)
		let updated = false

		if (this.#bin.elements.HOR_BIN.value !== nextHorizontal) {
			this.#bin.elements.HOR_BIN.value = nextHorizontal
			updated = true
		}

		if (this.#bin.elements.VER_BIN.value !== nextVertical) {
			this.#bin.elements.VER_BIN.value = nextVertical
			updated = true
		}

		if (updated) {
			this.notify(this.#bin)
		}
	}

	// Starts a pulse-guiding interval on the requested axis.
	pulse(direction: GuideDirection, duration: number) {
		if (!this.isConnected || duration <= 0) return

		const mount = this.activeMount

		if (mount !== undefined) {
			this.#guideOutputManager?.pulse(mount, direction, duration)
		}

		const until = Date.now() + Math.trunc(duration)

		if (direction === 'NORTH' || direction === 'SOUTH') this.#pulseNorthSouthUntil = until
		else this.#pulseWestEastUntil = until

		this.#setPulsing(true)
	}

	// Advances temperature regulation, exposure progress, and guide-pulse state.
	#tick() {
		const now = Date.now()
		this.#advanceTemperature()
		this.#expirePulseGuide(now)

		if (!this.isExposuring) return

		const remaining = Math.max(0, (this.#exposureEndTime - now) / 1000)
		if (Math.abs(this.#exposure.elements.CCD_EXPOSURE_VALUE.value - remaining) >= 1e-3) {
			this.#exposure.elements.CCD_EXPOSURE_VALUE.value = remaining
			this.notify(this.#exposure)
		}

		if (remaining <= 0) {
			this.#exposureEndTime = 0
			void this.#finishExposure()
		}
	}

	// Applies a simple thermal model based on ambient temperature and cooler power.
	#advanceTemperature() {
		const current = this.#temperature.elements.CCD_TEMPERATURE_VALUE.value
		const coolerEnabled = this.#cooler.elements.COOLER_ON.value
		const target = coolerEnabled ? this.#targetTemperature : CAMERA_AMBIENT_TEMPERATURE
		const delta = target - current
		const step = delta * (coolerEnabled ? 0.12 : 0.04)
		const nextTemperature = Math.abs(delta) < 0.02 ? target : current + step
		const deltaFromAmbient = Math.max(0, CAMERA_AMBIENT_TEMPERATURE - nextTemperature)
		const nextCoolerPower = coolerEnabled ? clamp(deltaFromAmbient * 6.5, 0, 100) : 0
		let updated = false

		if (Math.abs(nextTemperature - current) >= 0.1) {
			this.#temperature.elements.CCD_TEMPERATURE_VALUE.value = nextTemperature
			updated = true
		}

		if (Math.abs(this.#coolerPower.elements.CCD_COOLER_POWER.value - nextCoolerPower) >= 0.5) {
			this.#coolerPower.elements.CCD_COOLER_POWER.value = nextCoolerPower
			this.notify(this.#coolerPower)
		}

		if (updated) {
			this.notify(this.#temperature)
		}
	}

	// Completes the exposure and publishes the encoded synthetic image BLOB.
	async #finishExposure() {
		const exposureTime = this.#exposureDuration || this.#noiseExposure.elements.EXPOSURE_TIME.value
		this.#exposureDuration = 0
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = 0
		this.notify(this.#exposure)

		try {
			this.#image.state = 'Ok'
			this.#exposure.state = 'Ok'
			const blob = await this.#renderImage(exposureTime)
			this.#image.elements.CCD1.size = blob.byteLength.toFixed(0)
			this.#image.elements.CCD1.format = this.transferFormat === 'XISF' ? '.xisf' : '.fits'
			this.#image.elements.CCD1.value = blob
			this.#image.elements.CCD1.encoding = 'raw'
			handleSetBlobVector(this.client, this.handler, this.#image)
		} catch (e) {
			this.#image.state = 'Alert'
			this.#image.elements.CCD1.size = '0'
			this.#image.elements.CCD1.value = undefined
			this.#exposure.state = 'Alert'
			console.error('failed to render image', e)
		}

		this.notify(this.#exposure)
	}

	// Renders the configured frame and encodes it as FITS or XISF.
	async #renderImage(exposureTime: number) {
		const channels = this.channels
		const width = this.imageWidth
		const height = this.imageHeight
		const raw = new Float32Array(width * height * channels)
		const frameType = this.frameType
		const noiseConfig = this.#noiseConfig(frameType, exposureTime)
		const rotatorAngle = (this.activeRotator?.angle.value ?? 0) * DEG2RAD

		if (frameType === 'LIGHT') {
			const stars = await this.#collectFrameStars(exposureTime, rotatorAngle)
			if (this.#plotPsfModel.elements.ANNULAR.value) {
				const saturationLevel = this.#renderAnnularStars(raw, width, height, channels, stars)
				const seeingSigma = gaussianSigmaFromHfd(this.seeing)
				applySyntheticCollimationBlur(raw, width, height, channels, { sigmaX: seeingSigma / this.#bin.elements.HOR_BIN.value, sigmaY: seeingSigma / this.#bin.elements.VER_BIN.value })
				applySyntheticCollimationSaturation(raw, saturationLevel)
				generateNoiseImage(raw, width, height, channels, noiseConfig)
			} else {
				generateStarImage(raw, width, height, channels, stars, this.seeing, noiseConfig, this.#makePlotOptions())
			}
		} else {
			if (frameType === 'FLAT') fillFlatField(raw, width, height, channels, exposureTime, this.#noiseExposure.elements.EXPOSURE_TIME.value)
			generateNoiseImage(raw, width, height, channels, noiseConfig)
		}

		const image = this.#imageModel(raw, width, height, channels, exposureTime)
		const output = Buffer.allocUnsafe(raw.length * 2 + CAMERA_BLOB_PADDING)
		const sink = bufferSink(output)

		if (this.transferFormat === 'XISF') await writeImageToXisf(image, sink)
		else await writeImageToFits(image, sink)

		return output.subarray(0, sink.position)
	}

	// Renders defocused catalog stars as centrally obstructed annuli. Focused stars use the existing
	// Gaussian renderer. Returns the optional frame-wide saturation limit applied after optical blur.
	#renderAnnularStars(raw: ImageRawType, width: number, height: number, channels: 1 | 3, stars: readonly AstronomicalImageStar[]): number | undefined {
		const pattern = this.#collimationPattern.elements
		const shape = this.#aberrationShape.elements
		const focusRange = this.#aberrationFocus.elements.FOCUS_RANGE.value
		const currentFocus = this.activeFocuser?.position.value ?? this.#plotOptions.elements.FOCUS_STEP.value
		const bestFocus = this.#plotOptions.elements.BEST_FOCUS.value
		const globalDefocus = bestFocus === 0 ? 0 : clamp(Math.abs(currentFocus - bestFocus) / focusRange, 0, 1)
		const obstructionRatio = pattern.OBSTRUCTION_RATIO.value
		const collimation = this.#aberrationFeatures.elements.COLLIMATION.value ? shape.COLLIMATION.value : 0
		const collimationAngle = shape.COLLIMATION_ANGLE.value
		const spiderVanes = Math.round(pattern.SPIDER_VANES.value)
		const plotOptions = this.#makePlotOptions()
		const plotGain = plotOptions.gain ?? 1
		const focusedPlotOptions: PlotStarOptions = { ...plotOptions, saturationLevel: undefined, psfModel: 'gaussian', focusStep: bestFocus, bestFocus }
		const channelWeights: [number, number, number] | undefined = channels === 3 ? [1 / 3, 1 / 3, 1 / 3] : undefined
		let annularFixtureValidated = false

		const fixture = {
			width,
			height,
			channels,
			channelWeights,
			outer: { center: { x: 0, y: 0 }, semiMajor: 0, semiMinor: 0, theta: 0, softness: 0 },
			obstruction: { center: { x: 0, y: 0 }, semiMajor: 0, semiMinor: 0, theta: 0, softness: 0 },
			signal: 0,
			background: 0,
			noise: 0,
			spider: spiderVanes > 0 ? { vanes: spiderVanes, angle: pattern.SPIDER_ANGLE.value, width: 0, attenuation: pattern.SPIDER_ATTENUATION.value } : undefined,
		} satisfies SyntheticCollimationPattern

		for (let i = 0; i < stars.length; i++) {
			const star = stars[i]
			const defocus = star.defocus ?? globalDefocus

			if (defocus <= 1e-6) {
				plotStar(raw, width, height, channels, star.x, star.y, star.flux, star.hfd, star.snr, 0, star.colorIndex, focusedPlotOptions, star)
				continue
			}

			const scaleX = star.scaleX ?? 1
			const scaleY = star.scaleY ?? 1
			const sensorRadius = Math.max(pattern.EDGE_SOFTNESS.value * 3, pattern.MAX_RADIUS.value * defocus)
			const sensorObstructionRadius = sensorRadius * obstructionRatio
			const sensorClearance = Math.max(0, sensorRadius - sensorObstructionRadius - pattern.EDGE_SOFTNESS.value * 2)
			const sensorOffset = sensorClearance * collimation
			const offsetX = Math.cos(collimationAngle) * sensorOffset * scaleX
			const offsetY = Math.sin(collimationAngle) * sensorOffset * scaleY
			const softness = pattern.EDGE_SOFTNESS.value * Math.sqrt(scaleX * scaleY)

			fixture.outer.center.x = star.x
			fixture.outer.center.y = star.y
			fixture.outer.semiMajor = sensorRadius * scaleX
			fixture.outer.semiMinor = sensorRadius * scaleY
			fixture.outer.softness = softness
			fixture.obstruction.center.x = star.x + offsetX
			fixture.obstruction.center.y = star.y + offsetY
			fixture.obstruction.semiMajor = sensorObstructionRadius * scaleX
			fixture.obstruction.semiMinor = sensorObstructionRadius * scaleY
			fixture.obstruction.softness = softness
			if (fixture.spider !== undefined) fixture.spider.width = pattern.SPIDER_WIDTH.value * Math.sqrt(scaleX * scaleY)
			fixture.signal = star.flux * plotGain
			if (channelWeights !== undefined) {
				const weights = colorIndexToRgbWeights(star.colorIndex, plotOptions.gammaCompensation)
				channelWeights[0] = weights[0]
				channelWeights[1] = weights[1]
				channelWeights[2] = weights[2]
			}

			if (annularFixtureValidated) renderValidatedSyntheticCollimationPattern(raw, fixture)
			else {
				renderSyntheticCollimationPattern(raw, fixture)
				annularFixtureValidated = true
			}
		}
		return plotOptions.saturationLevel
	}

	// Builds an image model suitable for the FITS/XISF writers.
	#imageModel(raw: ImageRawType, width: number, height: number, channels: 1 | 3, exposureTime: number): Image {
		const pixelSizeInBytes = 2

		return {
			raw,
			header: this.#imageHeader(width, height, channels, exposureTime),
			metadata: {
				width,
				height,
				channels,
				stride: width * channels,
				pixelCount: width * height,
				strideInBytes: width * pixelSizeInBytes,
				pixelSizeInBytes,
				bitpix: 16,
				bayer: channels === 1 ? this.cfaPattern : undefined,
			},
		}
	}

	// Builds a compact astronomical image header for synthetic output.
	#imageHeader(width: number, height: number, channels: 1 | 3, exposureTime: number): FitsHeader {
		const now = Date.now()
		const mount = this.activeMount
		const focuser = this.activeFocuser
		const rotator = this.activeRotator
		const filter = this.activeFilter ? this.activeFilter.names[this.activeFilter.position] : undefined
		const start = now - Math.trunc(exposureTime * 1000)
		let rightAscension: Angle | undefined
		let declination: Angle | undefined

		if (mount) {
			;[rightAscension, declination] = equatorialToJ2000(mount.equatorialCoordinate.rightAscension, mount.equatorialCoordinate.declination)
		}

		return {
			SIMPLE: true,
			BITPIX: 16,
			NAXIS: channels === 1 ? 2 : 3,
			NAXIS1: width,
			NAXIS2: height,
			NAXIS3: channels === 3 ? 3 : undefined,
			INSTRUME: this.name,
			TELESCOP: mount?.name,
			EXPTIME: exposureTime,
			BZERO: 32768,
			BSCALE: 1,
			XBINNING: this.#bin.elements.HOR_BIN.value,
			YBINNING: this.#bin.elements.VER_BIN.value,
			XPIXSZ: this.#info.elements.CCD_PIXEL_SIZE_X.value * this.#bin.elements.HOR_BIN.value,
			YPIXSZ: this.#info.elements.CCD_PIXEL_SIZE_Y.value * this.#bin.elements.VER_BIN.value,
			GAIN: this.#gain.elements.GAIN.value,
			OFFSET: this.#offset.elements.OFFSET.value,
			FRAME: this.frameType,
			IMAGETYP: `${this.frameType === 'LIGHT' ? 'Light' : this.frameType === 'DARK' ? 'Dark' : this.frameType === 'FLAT' ? 'Flat' : 'Bias'} Frame`,
			'CCD-TEMP': this.#temperature.elements.CCD_TEMPERATURE_VALUE.value,
			SITELAT: mount ? toDeg(mount.geographicCoordinate.latitude) : undefined,
			SITELONG: mount ? toDeg(mount.geographicCoordinate.longitude) : undefined,
			OBJCTRA: rightAscension !== undefined ? formatRA(rightAscension) : undefined,
			OBJCTDEC: declination !== undefined ? formatDEC(declination) : undefined,
			RA: rightAscension !== undefined ? toDeg(normalizeAngle(rightAscension)) : undefined,
			DEC: declination !== undefined ? toDeg(declination) : undefined,
			EQUINOX: mount ? 2000 : undefined,
			PIERSIDE: mount && mount.pierSide !== 'NEITHER' ? mount.pierSide : undefined,
			'DATE-OBS': formatTemporal(start, 'YYYY-MM-DDTHH:mm:ss.SSS'),
			'DATE-END': formatTemporal(now, 'YYYY-MM-DDTHH:mm:ss.SSS'),
			XORGSUBF: this.#frame.elements.X.value,
			YORGSUBF: this.#frame.elements.Y.value,
			FOCUSPOS: focuser?.position.value,
			FOCUSTEM: focuser?.hasThermometer ? focuser.temperature : undefined,
			ROTATANG: rotator ? rotator.angle.value : undefined,
			FILTER: filter,
			// BAYERPAT: channels === 1 ? this.#cfa.elements.CFA_TYPE.value : undefined,
		}
	}

	// Builds the active scalar noise configuration from simulator property vectors.
	#noiseConfig(frameType: FrameType, exposureTime: number): AstronomicalImageNoiseConfig {
		const gainFactor = 1 + this.#gain.elements.GAIN.value / 100
		const offsetBias = this.#offset.elements.OFFSET.value * 2
		const lightFrame = frameType === 'LIGHT'
		const flatFrame = frameType === 'FLAT'
		const biasFrame = frameType === 'BIAS'

		return {
			seed: this.#scene.elements.SCENE_SEED.value >>> 0,
			quality: this.noiseQuality,
			exposure: {
				exposureTime: biasFrame ? CAMERA_MIN_EXPOSURE : exposureTime,
				analogGain: this.#noiseExposure.elements.ANALOG_GAIN.value * gainFactor,
				digitalGain: this.#noiseExposure.elements.DIGITAL_GAIN.value,
				electronsPerAdu: this.#noiseExposure.elements.ELECTRONS_PER_ADU.value,
			},
			sky: {
				enabled: lightFrame && this.#noiseFeatures.elements.SKY_ENABLED.value,
				baseRate: this.#noiseSky.elements.BASE_RATE.value,
				globalOffset: flatFrame ? this.#noiseSky.elements.GLOBAL_OFFSET.value + 0.2 : this.#noiseSky.elements.GLOBAL_OFFSET.value,
				gradientStrength: this.#noiseSky.elements.GRADIENT_STRENGTH.value,
				gradientDirection: this.#noiseSky.elements.GRADIENT_DIRECTION.value,
				radialGradientStrength: this.#noiseSky.elements.RADIAL_GRADIENT_STRENGTH.value,
				lowFrequencyVariationStrength: this.#noiseSky.elements.LOW_FREQUENCY_VARIATION_STRENGTH.value,
			},
			moon: {
				enabled: lightFrame && this.#noiseFeatures.elements.MOON_ENABLED.value,
				illuminationFraction: this.#noiseMoon.elements.ILLUMINATION_FRACTION.value,
				altitude: this.#noiseMoon.elements.ALTITUDE.value,
				angularDistance: this.#noiseMoon.elements.ANGULAR_DISTANCE.value,
				positionAngle: this.#noiseMoon.elements.POSITION_ANGLE.value,
				strength: this.#noiseMoon.elements.STRENGTH.value,
			},
			lightPollution: {
				enabled: lightFrame && this.#noiseFeatures.elements.LIGHT_POLLUTION_ENABLED.value,
				strength: this.#noiseLightPollution.elements.STRENGTH.value,
				direction: this.#noiseLightPollution.elements.DIRECTION.value,
				gradientStrength: this.#noiseLightPollution.elements.GRADIENT_STRENGTH.value,
				domeSharpness: this.#noiseLightPollution.elements.DOME_SHARPNESS.value,
			},
			atmosphere: {
				airglowStrength: this.#noiseAtmosphere.elements.AIRGLOW_STRENGTH.value,
				transparency: this.#noiseAtmosphere.elements.TRANSPARENCY.value,
				airmass: this.#noiseAtmosphere.elements.AIRMASS.value,
				haze: this.#noiseAtmosphere.elements.HAZE.value,
				humidity: this.#noiseAtmosphere.elements.HUMIDITY.value,
				thinCloudVeil: this.#noiseAtmosphere.elements.THIN_CLOUD_VEIL.value,
				twilightContribution: flatFrame ? Math.max(this.#noiseAtmosphere.elements.TWILIGHT_CONTRIBUTION.value, 0.3) : this.#noiseAtmosphere.elements.TWILIGHT_CONTRIBUTION.value,
				horizonGlow: this.#noiseAtmosphere.elements.HORIZON_GLOW.value,
				zodiacalLightFactor: this.#noiseAtmosphere.elements.ZODIACAL_LIGHT_FACTOR.value,
				milkyWayBackgroundFactor: this.#noiseAtmosphere.elements.MILKY_WAY_BACKGROUND_FACTOR.value,
			},
			sensor: {
				readNoise: this.#noiseSensor.elements.READ_NOISE.value,
				biasElectrons: this.#noiseSensor.elements.BIAS_ELECTRONS.value + offsetBias,
				blackLevelElectrons: this.#noiseSensor.elements.BLACK_LEVEL_ELECTRONS.value,
				darkCurrentAtReferenceTemp: this.#noiseSensor.elements.DARK_CURRENT_AT_REFERENCE_TEMP.value,
				referenceTemperature: this.#noiseSensor.elements.REFERENCE_TEMPERATURE.value,
				temperature: this.#temperature.elements.CCD_TEMPERATURE_VALUE.value,
				temperatureDoublingInterval: this.#noiseSensor.elements.TEMPERATURE_DOUBLING_INTERVAL.value,
				darkSignalNonUniformity: this.#noiseSensor.elements.DARK_SIGNAL_NON_UNIFORMITY.value,
				fullWellCapacity: this.#noiseSensor.elements.FULL_WELL_CAPACITY.value,
				channelCorrelation: this.#noiseSensor.elements.CHANNEL_CORRELATION.value,
				ampGlow: {
					enabled: frameType !== 'BIAS' && this.#noiseFeatures.elements.AMP_GLOW_ENABLED.value,
					strength: this.#noiseAmpGlow.elements.STRENGTH.value,
					position: this.ampGlowPosition,
					radiusX: this.#noiseAmpGlow.elements.RADIUS_X.value,
					radiusY: this.#noiseAmpGlow.elements.RADIUS_Y.value,
					falloff: this.#noiseAmpGlow.elements.FALLOFF.value,
				},
			},
			artifacts: {
				fixedPatternNoiseStrength: this.#noiseArtifacts.elements.FIXED_PATTERN_NOISE_STRENGTH.value,
				rowNoiseStrength: this.#noiseArtifacts.elements.ROW_NOISE_STRENGTH.value,
				columnNoiseStrength: this.#noiseArtifacts.elements.COLUMN_NOISE_STRENGTH.value,
				bandingStrength: this.#noiseArtifacts.elements.BANDING_STRENGTH.value,
				bandingFrequency: this.#noiseArtifacts.elements.BANDING_FREQUENCY.value,
				hotPixelRate: this.#noiseArtifacts.elements.HOT_PIXEL_RATE.value,
				warmPixelRate: this.#noiseArtifacts.elements.WARM_PIXEL_RATE.value,
				deadPixelRate: this.#noiseArtifacts.elements.DEAD_PIXEL_RATE.value,
				hotPixelStrength: this.#noiseArtifacts.elements.HOT_PIXEL_STRENGTH.value,
				warmPixelStrength: this.#noiseArtifacts.elements.WARM_PIXEL_STRENGTH.value,
				deadPixelResidual: this.#noiseArtifacts.elements.DEAD_PIXEL_RESIDUAL.value,
			},
			output: {
				maxValue: this.#noiseOutput.elements.MAX_VALUE.value,
				clampMode: this.clampMode,
				quantize: this.#noiseFeatures.elements.OUTPUT_QUANTIZE.value,
			},
		}
	}

	// Builds the active plot-star configuration from simulator property vectors.
	#makePlotOptions(): PlotStarOptions {
		return {
			background: this.#plotOptions.elements.BACKGROUND.value,
			saturationLevel: this.#plotFlags.elements.SATURATION_ENABLED.value ? this.#plotOptions.elements.SATURATION_LEVEL.value : undefined,
			focusStep: this.activeFocuser?.position.value ?? this.#plotOptions.elements.FOCUS_STEP.value,
			bestFocus: this.#plotOptions.elements.BEST_FOCUS.value,
			maxFocusStep: this.activeFocuser?.position.max || undefined,
			peakScale: this.#plotOptions.elements.PEAK_SCALE.value,
			ellipticity: this.#plotOptions.elements.ELLIPTICITY.value,
			theta: this.#plotOptions.elements.THETA.value,
			softCore: this.#plotOptions.elements.SOFT_CORE.value,
			psfModel: this.#plotPsfModel.elements.MOFFAT.value ? 'moffat' : 'gaussian',
			beta: this.#plotOptions.elements.BETA.value,
			haloStrength: this.#plotOptions.elements.HALO_STRENGTH.value,
			haloScale: this.#plotOptions.elements.HALO_SCALE.value,
			jitterX: this.#plotOptions.elements.JITTER_X.value,
			jitterY: this.#plotOptions.elements.JITTER_Y.value,
			gain: this.#plotOptions.elements.GAIN.value,
			gammaCompensation: this.#plotFlags.elements.GAMMA_ENABLED.value ? this.#plotOptions.elements.GAMMA_COMPENSATION.value : false,
			additiveNoiseHint: this.#plotOptions.elements.ADDITIVE_NOISE_HINT.value,
			minPlotRadius: this.#plotOptions.elements.MIN_PLOT_RADIUS.value,
			maxPlotRadius: this.#plotOptions.elements.MAX_PLOT_RADIUS.value,
			cutoffSigma: this.#plotOptions.elements.CUTOFF_SIGMA.value,
		}
	}

	// Resolves INDI aberration properties and caches trigonometry for the current frame.
	#makeAberrationConfig(): ResolvedSyntheticAberration {
		const features = this.#aberrationFeatures.elements
		const focus = this.#aberrationFocus.elements
		const shape = this.#aberrationShape.elements
		const config: SyntheticAberrationConfig = {
			enabled: features.SENSOR_TILT.value || features.BACKFOCUS.value || features.FIELD_CURVATURE.value || features.COMA.value || features.ASTIGMATISM.value || features.DECENTER.value || features.COLLIMATION.value,
			sensorTiltEnabled: features.SENSOR_TILT.value,
			fieldCurvatureEnabled: features.FIELD_CURVATURE.value,
			backfocusEnabled: features.BACKFOCUS.value,
			comaEnabled: features.COMA.value,
			astigmatismEnabled: features.ASTIGMATISM.value,
			decenterEnabled: features.DECENTER.value,
			collimationEnabled: features.COLLIMATION.value,
			decenterX: shape.DECENTER_X.value,
			decenterY: shape.DECENTER_Y.value,
			focusRange: focus.FOCUS_RANGE.value,
			tilt: focus.TILT.value,
			tiltAngle: focus.TILT_ANGLE.value,
			curvature: focus.CURVATURE.value,
			backfocus: shape.BACKFOCUS.value,
			backfocusBlur: shape.BACKFOCUS_BLUR.value,
			backfocusEllipticity: shape.BACKFOCUS_ELLIPTICITY.value,
			coma: shape.COMA.value,
			astigmatism: shape.ASTIGMATISM.value,
			astigmatismBlur: shape.ASTIGMATISM_BLUR.value,
			astigmatismAngle: shape.ASTIGMATISM_ANGLE.value,
			collimation: shape.COLLIMATION.value,
			collimationAngle: shape.COLLIMATION_ANGLE.value,
		}
		return resolveSyntheticAberration(config)
	}

	// Rotates the master catalog on the full sensor, then applies aberration, subframe, and binning.
	async #collectFrameStars(exposureTime: number, rotatorAngle: number) {
		const stars = await this.#ensureCatalog()
		const frameX = this.#frame.elements.X.value
		const frameY = this.#frame.elements.Y.value
		const frameWidth = this.#frame.elements.WIDTH.value
		const frameHeight = this.#frame.elements.HEIGHT.value
		const binX = this.#bin.elements.HOR_BIN.value
		const binY = this.#bin.elements.VER_BIN.value
		const gainFactor = 1 + this.#gain.elements.GAIN.value / 100
		const exposureScale = exposureTime / this.#noiseExposure.elements.EXPOSURE_TIME.value
		const projected: AstronomicalImageStar[] = []
		const centerX = (this.sensorWidth - 1) * 0.5
		const centerY = (this.sensorHeight - 1) * 0.5
		const rotate = Math.abs(rotatorAngle) >= 1e-12
		const sinAngle = rotate ? Math.sin(rotatorAngle) : 0
		const cosAngle = rotate ? Math.cos(rotatorAngle) : 1
		const aberration = this.#makeAberrationConfig()
		const currentFocus = this.activeFocuser?.position.value ?? this.#plotOptions.elements.FOCUS_STEP.value
		const bestFocus = this.#plotOptions.elements.BEST_FOCUS.value
		const annularRadius = this.#plotPsfModel.elements.ANNULAR.value ? this.#collimationPattern.elements.MAX_RADIUS.value : 0
		const annularSoftness = this.#plotPsfModel.elements.ANNULAR.value ? this.#collimationPattern.elements.EDGE_SOFTNESS.value * 8 : 0
		const annularPaddingX = annularRadius + annularSoftness * Math.sqrt(binX / binY)
		const annularPaddingY = annularRadius + annularSoftness * Math.sqrt(binY / binX)
		const aberrationResult: SyntheticStarAberration = { defocus: 0, focusOffset: 0, covarianceXX: 0, covarianceXY: 0, covarianceYY: 0, coma: 0, comaTheta: 0 }

		for (let i = 0; i < stars.length; i++) {
			const star = stars[i]

			if (star === undefined) continue
			let sensorX = star.x
			let sensorY = star.y

			if (rotate) {
				const dx = sensorX - centerX
				const dy = sensorY - centerY
				sensorX = centerX + dx * cosAngle - dy * sinAngle
				sensorY = centerY + dx * sinAngle + dy * cosAngle
			}

			if (sensorX < frameX - annularPaddingX || sensorX >= frameX + frameWidth + annularPaddingX || sensorY < frameY - annularPaddingY || sensorY >= frameY + frameHeight + annularPaddingY) continue
			if (aberration.enabled) evaluateSyntheticAberration(sensorX, sensorY, this.sensorWidth, this.sensorHeight, currentFocus, bestFocus, aberration, aberrationResult)
			const comaX = aberration.enabled ? Math.cos(aberrationResult.comaTheta) / binX : 0
			const comaY = aberration.enabled ? Math.sin(aberrationResult.comaTheta) / binY : 0
			const projectedStar: AstronomicalImageStar = {
				x: (sensorX - frameX) / binX,
				y: (sensorY - frameY) / binY,
				flux: star.flux * gainFactor * exposureScale,
				hfd: star.hfd,
				snr: star.snr * Math.sqrt(Math.max(exposureScale, 0.01)),
				colorIndex: star.colorIndex,
				scaleX: 1 / binX,
				scaleY: 1 / binY,
				defocus: aberration.focusEnabled ? aberrationResult.defocus : undefined,
				covarianceXX: aberration.enabled ? aberrationResult.covarianceXX / (binX * binX) : undefined,
				covarianceXY: aberration.enabled ? aberrationResult.covarianceXY / (binX * binY) : undefined,
				covarianceYY: aberration.enabled ? aberrationResult.covarianceYY / (binY * binY) : undefined,
				coma: aberration.enabled ? aberrationResult.coma : undefined,
				comaTheta: aberration.enabled && aberrationResult.coma > 0 ? Math.atan2(comaY, comaX) : undefined,
			}

			projected.push(projectedStar)
		}

		return projected
	}

	// Computes the current local sidereal time from the simulated clock.
	#siderealTime(utcTime: number, longitude: Angle) {
		return localSiderealTime(timeUnix(utcTime / 1000, true), longitude)
	}

	// Rebuilds the deterministic catalog only when scene parameters change.
	async #ensureCatalog() {
		const { elements } = this.#telescopeEffects
		const mount = this.activeMount
		let centerRightAscension = mount?.equatorialCoordinate.rightAscension
		let centerDeclination = mount?.equatorialCoordinate.declination

		if (mount !== undefined) {
			const now = Date.now()
			const latitude = mount.geographicCoordinate.latitude
			const longitude = mount.geographicCoordinate.longitude

			if (elements.PAE_AZ.value !== 0 || elements.PAE_AL.value !== 0) {
				;[centerRightAscension, centerDeclination] = polarAlignmentError(centerRightAscension!, centerDeclination!, latitude, this.#siderealTime(now, longitude), elements.PAE_AZ.value * ASEC2RAD, elements.PAE_AL.value * ASEC2RAD)
			}

			;[centerRightAscension, centerDeclination] = this.#applyTelescopePeriodicError(centerRightAscension!, centerDeclination!, now)
			;[centerRightAscension, centerDeclination] = equatorialToJ2000(centerRightAscension, centerDeclination)
		}

		const ps = arcsec(pixelScale(CAMERA_PIXEL_SIZE, this.telescopeFocalLength))
		const radius = Math.hypot(this.sensorWidth, this.sensorHeight) * ps * 0.5
		const key = this.#makeCatalogKey(centerRightAscension, centerDeclination, radius)
		if (this.#catalog && !this.#catalogDirty && this.#catalogKey === key) return this.#catalog

		const type = this.catalogSourceType
		const catalogSource = this.options?.catalogSources?.[type]
		const stars = catalogSource && centerRightAscension !== undefined && centerDeclination !== undefined && radius > 0 ? this.#mapCatalogCatalogStarsToAstronomicalImageStars(await catalogSource(centerRightAscension, centerDeclination, radius), centerRightAscension, centerDeclination, ps) : this.#randomSource()
		this.#catalog = stars
		this.#catalogKey = key
		this.#catalogDirty = false
		return stars
	}

	#mapCatalogCatalogStarsToAstronomicalImageStars(stars: readonly CatalogSourceStar[], centerRightAscension: Angle, centerDeclination: Angle, pixelScale: Angle): readonly (AstronomicalImageStar | undefined)[] {
		const sensorWidth = this.sensorWidth
		const sensorHeight = this.sensorHeight
		const halfWidth = (sensorWidth - 1) * 0.5
		const halfHeight = (sensorHeight - 1) * 0.5
		const point: Point = { x: 0, y: 0 }
		const projection = new Gnomonic(centerRightAscension, centerDeclination)

		return stars.map((s) => {
			if (projection.project(s.rightAscension, s.declination, point) === undefined) {
				return undefined
			}

			const x = halfWidth - point.x / pixelScale
			const y = halfHeight - point.y / pixelScale
			if (x < 0 || x >= sensorWidth || y < 0 || y >= sensorHeight) return undefined
			point.x = x
			point.y = y
			Object.assign(s, point)
			return s as never
		})
	}

	// Builds a cache key for the currently selected catalog source.
	#makeCatalogKey(centerRightAscension?: Angle, centerDeclination?: Angle, radius?: Angle) {
		const catalogSource = this.catalogSourceType
		if (catalogSource === 'RANDOM' || centerRightAscension === undefined || centerDeclination === undefined || radius === undefined || radius === 0) return `RANDOM:${this.#scene.elements.SCENE_SEED.value}`
		else return `${catalogSource}:${toHour(normalizeAngle(centerRightAscension)).toFixed(6)}:${toDeg(centerDeclination).toFixed(6)}:${toDeg(radius).toFixed(6)}`
	}

	// Generates a deterministic in-memory star field.
	#randomSource() {
		const random = mulberry32(this.#scene.elements.SCENE_SEED.value >>> 0)
		const width = this.sensorWidth
		const height = this.sensorHeight
		const density = this.#scene.elements.STAR_DENSITY.value
		const count = Math.max(1, Math.trunc(width * height * density))
		const minHfd = this.#scene.elements.HFD_MIN.value
		const maxHfd = Math.max(minHfd, this.#scene.elements.HFD_MAX.value)
		const minFlux = this.#scene.elements.FLUX_MIN.value
		const maxFlux = Math.max(minFlux, this.#scene.elements.FLUX_MAX.value)
		const stars = new Array<AstronomicalImageStar>(count)
		const maxWidth = Math.max(0, width - 1)
		const maxHeight = Math.max(0, height - 1)

		for (let i = 0; i < count; i++) {
			const brightness = 1 - random()

			stars[i] = {
				x: random() * maxWidth,
				y: random() * maxHeight,
				flux: minFlux + (maxFlux - minFlux) * brightness ** 6,
				hfd: minHfd + (maxHfd - minHfd) * random(),
				snr: 12 + brightness * 180,
				colorIndex: -0.25 + random() * 1.9,
			}
		}

		return stars
	}

	// Clears pulse-guiding state once all timed pulses have expired.
	#expirePulseGuide(now: number) {
		let pulsing = false
		if (this.#pulseNorthSouthUntil > now) pulsing = true
		else this.#pulseNorthSouthUntil = 0
		if (this.#pulseWestEastUntil > now) pulsing = true
		else this.#pulseWestEastUntil = 0
		this.#setPulsing(pulsing)
	}

	// Updates the guide-pulse busy state.
	// Sets the pulse-guiding Busy/Idle state on the timed-guide vectors and notifies on change.
	#setPulsing(pulsing: boolean) {
		if (this.isPulsing === pulsing) return
		this.#guideNS.state = pulsing ? 'Busy' : 'Idle'
		this.#guideWE.state = this.#guideNS.state
		this.notify(this.#guideNS)
		this.notify(this.#guideWE)
	}

	// Clears all outstanding pulse-guide intervals.
	#clearPulseGuide() {
		this.#pulseNorthSouthUntil = 0
		this.#pulseWestEastUntil = 0
		this.#setPulsing(false)
	}

	// Applies the configurable mount periodic error model.
	#applyTelescopePeriodicError(rightAscension: Angle, declination: Angle, utcTime: number) {
		const { elements } = this.#telescopeEffects

		const westEastPeriodicOffset = this.#periodicErrorOffset(elements.PE_WE_PERIOD.value, elements.PE_WE_AMPLITUDE.value, utcTime)
		const northSouthPeriodicOffset = this.#periodicErrorOffset(elements.PE_NS_PERIOD.value, elements.PE_NS_AMPLITUDE.value, utcTime)

		if (westEastPeriodicOffset !== this.#mountPeriodicWestEastOffset) {
			rightAscension += westEastPeriodicOffset - this.#mountPeriodicWestEastOffset
			this.#mountPeriodicWestEastOffset = westEastPeriodicOffset
		}

		if (northSouthPeriodicOffset !== this.#mountPeriodicNorthSouthOffset) {
			declination += northSouthPeriodicOffset - this.#mountPeriodicNorthSouthOffset
			this.#mountPeriodicNorthSouthOffset = northSouthPeriodicOffset
		}

		return [rightAscension, declination] as const
	}

	// Computes the current periodic offset for one axis in radians.
	#periodicErrorOffset(periodSeconds: number, amplitudeArcsec: number, utcTime: number) {
		if (periodSeconds <= 0 || amplitudeArcsec === 0) return 0
		const periodMilliseconds = periodSeconds * 1000
		const phase = ((utcTime % periodMilliseconds) * TAU) / periodMilliseconds
		return Math.sin(phase) * amplitudeArcsec * ASEC2RAD
	}

	get cfaPattern() {
		return this.#cfa.elements.CFA_TYPE.value as CfaPattern
	}

	// Returns the active sensor width in unbinned pixels.
	get sensorWidth() {
		return this.#info.elements.CCD_MAX_X.value
	}

	// Returns the active sensor height in unbinned pixels.
	get sensorHeight() {
		return this.#info.elements.CCD_MAX_Y.value
	}

	// Returns the transfer format selected by the capture-format vector.
	get transferFormat(): TransferFormat {
		return this.#transferFormat.elements.FORMAT_FITS.value ? 'FITS' : 'XISF'
	}

	// Returns the channel count implied by the current capture format.
	get channels() {
		return this.frameFormat === 'MONO' ? 1 : 3
	}

	// Returns the binned output width for the current frame selection.
	get imageWidth() {
		return Math.max(1, Math.ceil(this.#frame.elements.WIDTH.value / this.#bin.elements.HOR_BIN.value))
	}

	// Returns the binned output height for the current frame selection.
	get imageHeight() {
		return Math.max(1, Math.ceil(this.#frame.elements.HEIGHT.value / this.#bin.elements.VER_BIN.value))
	}

	// Returns the scene seeing in unbinned pixels; each projected star supplies its X/Y bin scale.
	get seeing() {
		return this.#scene.elements.SEEING.value
	}

	// Returns the selected readout-mode descriptor.
	get frameFormat() {
		return findOnSwitch(this.#frameFormat)[0] as ReadoutMode
	}

	// Returns the selected noise quality enum.
	get noiseQuality() {
		return this.#noiseQuality.elements.FAST.value ? 'fast' : this.#noiseQuality.elements.HIGH_REALISM.value ? 'high-realism' : 'balanced'
	}

	// Returns the selected output clamp mode enum.
	get clampMode() {
		return this.#noiseClampMode.elements.NORMALIZE.value ? 'normalize' : this.#noiseClampMode.elements.NONE.value ? 'none' : 'clamp'
	}

	// Returns the selected amp-glow edge or corner.
	get ampGlowPosition() {
		if (this.#noiseAmpGlowPosition.elements.TOP_LEFT.value) return 'top-left'
		if (this.#noiseAmpGlowPosition.elements.TOP_RIGHT.value) return 'top-right'
		if (this.#noiseAmpGlowPosition.elements.BOTTOM_LEFT.value) return 'bottom-left'
		if (this.#noiseAmpGlowPosition.elements.BOTTOM_RIGHT.value) return 'bottom-right'
		if (this.#noiseAmpGlowPosition.elements.LEFT.value) return 'left'
		if (this.#noiseAmpGlowPosition.elements.TOP.value) return 'top'
		if (this.#noiseAmpGlowPosition.elements.BOTTOM.value) return 'bottom'
		return 'right'
	}
}
