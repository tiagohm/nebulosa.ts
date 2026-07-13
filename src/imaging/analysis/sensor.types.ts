import type { Rect, Size } from '../../math/numerical/geometry'
import type { DigitalImage } from '../model/types'

// Shared contracts for EMVA-inspired sensor characterization. Inputs preserve camera digital numbers,
// dimensions use output pixels, exposure uses seconds, and temperature uses degrees Celsius. Analysis
// functions return fresh scalar reports while optional spatial buffers are overwritten in place.

// Tuple containing at least two independently acquired frames.
export type AtLeastTwo<T> = readonly [T, T, ...T[]]

// Mono or individual row-major CFA plane selected before debayering.
export type SensorPlane = 'mono' | 'red' | 'green1' | 'green2' | 'blue'

// Reason a temporal measurement point was excluded from a fit.
export type SensorPointRejectionReason = 'outsideFitRange' | 'nonPositiveSignal' | 'nonPositiveVariance' | 'clipped' | 'unstableIllumination' | 'insufficientSamples'

// Camera configuration under which all measurements were acquired.
export interface SensorOperatingPoint {
	// Device gain setting, distinct from measured conversion gain.
	readonly gain?: number
	// Device black-level or pedestal setting.
	readonly offset?: number
	// Sensor temperature, degrees Celsius.
	readonly temperature?: number
	// Camera-specific readout mode identifier.
	readonly readoutMode?: string
	// Effective ADC or output bit depth when known.
	readonly bitDepth?: number
	// Horizontal and vertical hardware binning factors.
	readonly binning?: Readonly<[number, number]>
	// Sensor-space ROI origin in unbinned pixels.
	readonly sensorOrigin?: Readonly<[number, number]>
	// Acquired ROI size in output pixels.
	readonly size?: Readonly<Size>
	// Descriptive camera identifier.
	readonly camera?: string
}

// Images acquired under identical exposure and illumination conditions.
export interface SensorFrameSet {
	// Two or more independent digital images.
	readonly frames: AtLeastTwo<DigitalImage>
	// Recorded camera configuration for this set.
	readonly operatingPoint?: SensorOperatingPoint
	// Exposure duration, seconds; must be finite and non-negative.
	readonly exposure: number
	// Measured sensor temperature, degrees Celsius.
	readonly temperature?: number
	// Mean calibrated incident photons per output pixel.
	readonly photons?: number
	// Center wavelength of the calibrated band, nanometers.
	readonly wavelength?: number
	// Relative source intensity when exposure alone is not the stimulus.
	readonly intensity?: number
}

// Illuminated level and its optional exposure-matched dark reference.
export interface SensorFlatFrameSet extends SensorFrameSet {
	// Independent dark frames acquired at the flat exposure.
	readonly darkFrames?: AtLeastTwo<DigitalImage>
}

// Complete datasets for one sensor operating point.
export interface SensorCharacterizationInput {
	// Expected camera configuration shared by every dataset.
	readonly operatingPoint: SensorOperatingPoint
	// Shortest reproducible dark exposures used as bias reference.
	readonly bias: SensorFrameSet
	// Uniformly illuminated temporal levels.
	readonly flats: readonly SensorFlatFrameSet[]
	// Dark levels spanning multiple exposure times.
	readonly darks?: readonly SensorFrameSet[]
	// Dedicated fixed-exposure stacks for spatial analysis.
	readonly spatial?: {
		// Dark stack used for DSNU and temporal-noise correction.
		readonly dark: SensorFrameSet
		// Flat stack used for PRNU and defect analysis.
		readonly flat: SensorFrameSet
	}
}

// Reusable full-resolution buffers overwritten by spatial analysis.
export interface SensorSpatialBuffers {
	// Per-pixel mean workspace in DN.
	readonly mean?: Float64Array
	// Per-pixel variance workspace in DN squared.
	readonly variance?: Float64Array
	// Per-pixel defect bit mask workspace.
	readonly mask?: Uint8Array
}

// Tile dimensions used by bounded-memory spatial analysis.
export interface SensorTileOptions {
	// Tile width in output pixels; must be a positive integer.
	readonly width: number
	// Tile height in output pixels; must be a positive integer.
	readonly height: number
}

// Options controlling temporal and spatial sensor measurements.
export interface SensorCharacterizationOptions {
	// Inclusive-exclusive image area used for measurements.
	readonly area?: Readonly<Rect>
	// Mono or CFA planes to analyze; inferred when omitted.
	readonly planes?: readonly SensorPlane[]
	// Known upper digital clipping code in DN.
	readonly digitalClip?: number
	// Fractional saturation range used for PTC gain fitting.
	readonly gainRange?: Readonly<[number, number]>
	// Fractional saturation range used for linearity fitting.
	readonly linearityRange?: Readonly<[number, number]>
	// Maximum allowed temperature spread, degrees Celsius.
	readonly temperatureTolerance?: number
	// Robust outlier-rejection threshold in standard deviations.
	readonly rejectionSigma?: number
	// Large-scale illumination removal used for practical PRNU.
	readonly spatialDetrend?: 'none' | 'emvaHighpass' | 'plane' | 'polynomial'
	// Full-resolution diagnostic maps to retain.
	readonly maps?: 'none' | 'defects' | 'all'
	// Caller-owned full-resolution buffers overwritten by analysis.
	readonly spatialBuffers?: SensorSpatialBuffers
	// Tile size used when full-resolution workspaces are not retained.
	readonly tile?: Readonly<SensorTileOptions>
}

// Default practical ranges and robustness settings for sensor characterization.
export const DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS = {
	gainRange: [0.05, 0.7],
	linearityRange: [0.05, 0.95],
	temperatureTolerance: 0.5,
	rejectionSigma: 5,
	spatialDetrend: 'emvaHighpass',
	maps: 'none',
} as const satisfies Partial<SensorCharacterizationOptions>
