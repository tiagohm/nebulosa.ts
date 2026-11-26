import type { DeepPartial, DeepRequired } from '../../../core/types'
import type { CfaPattern } from '../../../imaging/model/types'
import type { PlotStarOptions } from '../../../imaging/stars/generator'
import type { SyntheticAberrationConfig } from '../../../imaging/synthetic/aberration'
import { type AstronomicalImageNoiseConfig, DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG } from '../../../imaging/synthetic/generator'
import type { Angle } from '../../../math/units/angle'
import { mergeConfig } from './component'
import type { CatalogSourceType, ReadoutMode, TransferFormat } from './types'

// Configuration of the simulated camera, one section per circuit. Every section holds the initial
// values of the properties its circuit publishes and the fixed parameters that are not published at
// all. A simulator is built from DEFAULT_CAMERA_SIMULATOR_CONFIG merged with the partial override its
// options carry; the merged result is a fresh object and the defaults are never mutated.

// Sensor characteristics: geometry, pixel size, colour filter array and binning limit.
export interface CameraSensorConfig {
	// Sensor width, unbinned pixels, at least 1.
	readonly width: number
	// Sensor height, unbinned pixels, at least 1.
	readonly height: number
	// Square pixel pitch, micrometres.
	readonly pixelSize: number
	// Bits per pixel the camera reports.
	readonly bitsPerPixel: number
	// Colour filter array layout reported for monochrome readouts.
	readonly cfa: CfaPattern
	// Largest hardware binning factor on either axis, at least 1.
	readonly maxBin: number
}

// Readout settings a client changes per frame.
export interface CameraReadoutConfig {
	// Initial gain, in the camera's own units within [0, 400].
	readonly gain: number
	// Initial offset, in the camera's own units within [0, 1000].
	readonly offset: number
	// Initial readout mode.
	readonly readoutMode: ReadoutMode
	// Initial transfer format.
	readonly transferFormat: TransferFormat
}

// Thermoelectric cooler and its thermal model.
export interface CameraCoolerConfig {
	// Ambient temperature the sensor drifts to with the cooler off, °C.
	readonly ambientTemperature: number
	// Initial cooling target, °C.
	readonly targetTemperature: number
	// Time constant of the approach to the target with the cooler on, seconds, positive.
	readonly coolingTimeConstant: number
	// Time constant of the drift back to ambient with the cooler off, seconds, positive.
	readonly warmingTimeConstant: number
	// Cooler power drawn per degree below ambient, percent per °C.
	readonly powerPerDegree: number
	// Distance from the target within which the temperature counts as reached, °C.
	readonly threshold: number
}

// Exposure limits of the shutter.
export interface CameraShutterConfig {
	// Shortest exposure, seconds, positive.
	readonly minExposure: number
	// Longest exposure, seconds.
	readonly maxExposure: number
}

// Synthetic star field.
export interface CameraSceneConfig {
	// Seed of the random field, the noise and the flat-field dust, within [0, 2³²).
	readonly seed: number
	// Random-field stars per square unbinned pixel.
	readonly starDensity: number
	// Seeing, unbinned pixels of half-flux diameter.
	readonly seeing: number
	// Range of the random-field half-flux diameters, unbinned pixels.
	readonly hfdMin: number
	readonly hfdMax: number
	// Range of the random-field fluxes, at the reference exposure.
	readonly fluxMin: number
	readonly fluxMax: number
	// Star source selected when the camera is created: 'RANDOM' or a key of the catalog sources whose
	// source is present. Anything else selects 'RANDOM'.
	readonly catalogSource: CatalogSourceType
}

// Optical train: the telescope, the focus model and the aberrations of the field.
export interface CameraOpticsConfig {
	// Focal length, millimetres within [1, 10000].
	readonly focalLength: number
	// Aperture, millimetres within [1, 3000].
	readonly aperture: number
	// Angle the camera is mounted at on the tube, radians, measured like a position angle: the sensor's
	// up direction this far east of the direction the tube's own orientation points at.
	readonly cameraAngle: Angle
	// Focuser position of best focus, steps. Zero disables the focus model.
	readonly bestFocus: number
	// Aberration flags and coefficients; the overall `enabled` flag is derived from the others.
	readonly aberration: Omit<SyntheticAberrationConfig, 'enabled'>
}

// Star point spread function model.
export type CameraPsfModel = 'gaussian' | 'moffat' | 'annular' | 'bahtinov'

// Bahtinov mask diffraction pattern, in sensor pixels.
export interface CameraBahtinovConfig {
	// Normals of the three spikes, degrees.
	readonly normalAngle1: number
	readonly normalAngle2: number
	readonly normalAngle3: number
	// Full width at half maximum of a spike, unbinned pixels.
	readonly fwhm: number
	// Half length of a spike, unbinned pixels.
	readonly halfLength: number
	// Length of the taper at each spike end, unbinned pixels.
	readonly taperLength: number
	// Relative strength of each spike.
	readonly strength1: number
	readonly strength2: number
	readonly strength3: number
	// Flux of the spikes relative to the star.
	readonly spikeFluxRatio: number
	// Focuser steps that move the central spike by one unbinned pixel.
	readonly focusStepsPerPixel: number
	// Gaussian cutoff of a spike profile, sigmas.
	readonly cutoffSigma: number
}

// Defocused annular (collimation) pattern of an obstructed telescope, in sensor pixels.
export interface CameraCollimationConfig {
	// Radius of the pattern at the far end of the focus range, unbinned pixels.
	readonly maxRadius: number
	// Secondary obstruction diameter over primary diameter, within (0, 1).
	readonly obstructionRatio: number
	// Width of the soft edge, unbinned pixels.
	readonly edgeSoftness: number
	// Number of spider vanes; zero for none.
	readonly spiderVanes: number
	// Width of a vane, unbinned pixels.
	readonly spiderWidth: number
	// Orientation of the first vane, radians.
	readonly spiderAngle: Angle
	// Fraction of light a vane blocks, within [0, 1].
	readonly spiderAttenuation: number
}

// Star rendering.
export interface CameraPsfConfig {
	// Initial point spread function model.
	readonly model: CameraPsfModel
	// Initial ellipticity, within [0, 0.8].
	readonly ellipticity: number
	// Initial orientation of the ellipse, radians.
	readonly theta: Angle
	// Initial Moffat beta, above 1.
	readonly beta: number
	// Initial saturation level, normalized signal; zero disables saturation.
	readonly saturationLevel: number
	// Fixed plotting parameters that are not published. Overrides the generator defaults.
	readonly plot: Omit<PlotStarOptions, 'saturationLevel' | 'focusStep' | 'bestFocus' | 'maxFocusStep' | 'ellipticity' | 'theta' | 'beta' | 'psfModel'>
	readonly bahtinov: CameraBahtinovConfig
	readonly collimation: CameraCollimationConfig
}

// Illumination of a flat frame.
export interface CameraFlatConfig {
	// Signal at the reference exposure, normalized.
	readonly referenceSignal: number
	// Vignetting depth at the corners, within [0, 1].
	readonly vignetting: number
	// Optical centre offset, fractions of the half sensor, within [-1, 1].
	readonly centerOffsetX: number
	readonly centerOffsetY: number
	// Linear illumination gradient across the sensor, within [-1, 1].
	readonly gradientX: number
	readonly gradientY: number
	// Photo-response non-uniformity, relative standard deviation.
	readonly prnu: number
	// Dust motes: count, Gaussian shape in unbinned pixels, rotation in radians and contrast in [0, 1].
	readonly dustCount: number
	readonly dustSigmaX: number
	readonly dustSigmaY: number
	readonly dustAngle: Angle
	readonly dustContrast: number
	// Sinusoidal row and column banding: fractional amplitude, period in unbinned pixels, phase in radians.
	readonly rowAmplitude: number
	readonly rowPeriod: number
	readonly rowPhase: Angle
	readonly columnAmplitude: number
	readonly columnPeriod: number
	readonly columnPhase: Angle
}

// Noise model of the sensor and the sky background, as the image generator takes it. The seed is the
// scene's; the sensor temperature is the cooler's reading.
export type CameraNoiseConfig = Omit<DeepRequired<AstronomicalImageNoiseConfig>, 'seed'>

// Integration of the field's motion over an exposure.
export interface CameraTrailConfig {
	// Instants the boresight is read at, evenly spaced over the exposure, at least 2.
	readonly vertices: number
	// Largest distance between consecutive points a trail is drawn from, unbinned pixels, positive.
	readonly spacing: number
	// Most points a single star is drawn from inside the frame, at least 1. Bounds the cost of a trail.
	readonly maxPoints: number
	// Longest trail the scene is built to cover, unbinned pixels.
	readonly maxExtent: number
}

// Full configuration of a simulated camera.
export interface CameraSimulatorConfig {
	readonly sensor: CameraSensorConfig
	readonly readout: CameraReadoutConfig
	readonly cooler: CameraCoolerConfig
	readonly shutter: CameraShutterConfig
	readonly scene: CameraSceneConfig
	readonly optics: CameraOpticsConfig
	readonly psf: CameraPsfConfig
	readonly flat: CameraFlatConfig
	readonly noise: CameraNoiseConfig
	readonly trail: CameraTrailConfig
}

// Partial override of a camera configuration, merged section by section into the defaults.
export type CameraSimulatorConfigOverride = DeepPartial<CameraSimulatorConfig>

// Defaults of every simulated camera: a 1280 × 1024 sensor of 5.2 µm pixels behind an 80 mm f/6.25
// refractor, a sky and noise model tuned for a 60 s reference exposure.
export const DEFAULT_CAMERA_SIMULATOR_CONFIG: CameraSimulatorConfig = {
	sensor: { width: 1280, height: 1024, pixelSize: 5.2, bitsPerPixel: 16, cfa: 'RGGB', maxBin: 4 },
	readout: { gain: 0, offset: 0, readoutMode: 'MONO', transferFormat: 'FITS' },
	cooler: { ambientTemperature: 18, targetTemperature: 0, coolingTimeConstant: 0.8, warmingTimeConstant: 2.5, powerPerDegree: 6.5, threshold: 0.2 },
	shutter: { minExposure: 0.001, maxExposure: 3600 },
	scene: { seed: 0x1d0f3a57, starDensity: 0.0006, seeing: 1.2, hfdMin: 1.2, hfdMax: 3.6, fluxMin: 0.002, fluxMax: 0.85, catalogSource: 'RANDOM' },
	optics: {
		focalLength: 500,
		aperture: 80,
		cameraAngle: 0,
		bestFocus: 50000,
		aberration: {
			sensorTiltEnabled: false,
			fieldCurvatureEnabled: false,
			backfocusEnabled: false,
			comaEnabled: false,
			astigmatismEnabled: false,
			decenterEnabled: false,
			collimationEnabled: false,
			decenterX: 0,
			decenterY: 0,
			focusRange: 2000,
			tilt: 0,
			tiltAngle: 0,
			curvature: 0,
			backfocus: 0,
			backfocusBlur: 4,
			backfocusEllipticity: 0.35,
			coma: 0,
			astigmatism: 0,
			astigmatismBlur: 4,
			astigmatismAngle: 0,
			collimation: 0,
			collimationAngle: 0,
		},
	},
	psf: {
		model: 'gaussian',
		ellipticity: 0,
		theta: 0,
		beta: 2.5,
		saturationLevel: 0,
		plot: { background: 0, peakScale: 1, softCore: 0, haloStrength: 0, haloScale: 2.8, jitterX: 0, jitterY: 0, gain: 1, gammaCompensation: false, additiveNoiseHint: 0, minPlotRadius: 2, maxPlotRadius: 24, cutoffSigma: 4.25 },
		bahtinov: { normalAngle1: 15, normalAngle2: 0, normalAngle3: -15, fwhm: 2, halfLength: 60, taperLength: 12, strength1: 1, strength2: 1, strength3: 1, spikeFluxRatio: 1, focusStepsPerPixel: 200, cutoffSigma: 4 },
		collimation: { maxRadius: 48, obstructionRatio: 0.35, edgeSoftness: 0.8, spiderVanes: 0, spiderWidth: 1.5, spiderAngle: 0, spiderAttenuation: 0.9 },
	},
	flat: {
		referenceSignal: 0.72,
		vignetting: 0.4,
		centerOffsetX: 0,
		centerOffsetY: 0,
		gradientX: 0.08,
		gradientY: 0.08,
		prnu: 0,
		dustCount: 1,
		dustSigmaX: 24,
		dustSigmaY: 24,
		dustAngle: 0,
		dustContrast: 0,
		rowAmplitude: 0,
		rowPeriod: 32,
		rowPhase: 0,
		columnAmplitude: 0,
		columnPeriod: 32,
		columnPhase: 0,
	},
	noise: (({ seed, ...noise }) => noise)(DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG),
	trail: { vertices: 33, spacing: 0.5, maxPoints: 16384, maxExtent: 1024 },
}

// Builds the configuration of a camera from the defaults and an optional override.
export function cameraSimulatorConfig(override?: CameraSimulatorConfigOverride, base: CameraSimulatorConfig = DEFAULT_CAMERA_SIMULATOR_CONFIG): CameraSimulatorConfig {
	return mergeConfig(base, override)
}
