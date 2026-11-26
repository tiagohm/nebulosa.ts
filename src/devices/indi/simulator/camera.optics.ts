import { pixelScale } from '../../../astronomy/formulas'
import { TAU } from '../../../core/constants'
import type { SyntheticAberrationConfig } from '../../../imaging/synthetic/aberration'
import { type Angle, arcsec } from '../../../math/units/angle'
import type { NewNumberVector, NewSwitchVector } from '../types'
import type { CameraOpticsConfig } from './camera.config'
import { type ComponentBus, type FlagBinding, makeBoundNumberVector, makeFlagVector, type NumberBinding, readBoundNumberVector, readFlagVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import { applyMultiSwitchValues, applyNumberVectorValues } from './util'

// Optics circuit of the simulated camera: the telescope in front of the sensor, where it focuses and
// how the image degrades across the field. Lengths are millimetres, focus positions focuser steps and
// angles radians.

// Aberration settings, without the overall flag derived from them.
type AberrationSettings = CameraOpticsConfig['aberration']

// Focal length and aperture, TELESCOPE_INFO, millimetres.
const TELESCOPE: readonly NumberBinding<'focalLength' | 'aperture'>[] = [
	['FOCAL_LENGTH', 'Focal Length (mm)', 'focalLength', 1, 10000, 1, '%.0f'],
	['APERTURE', 'Aperture (mm)', 'aperture', 1, 3000, 1, '%.0f'],
]

// Aberrations switched on, SIMULATOR_ABERRATION_FEATURES.
const FEATURES: readonly FlagBinding<'sensorTiltEnabled' | 'backfocusEnabled' | 'fieldCurvatureEnabled' | 'comaEnabled' | 'astigmatismEnabled' | 'decenterEnabled' | 'collimationEnabled'>[] = [
	['SENSOR_TILT', 'Sensor Tilt', 'sensorTiltEnabled'],
	['BACKFOCUS', 'Backfocus', 'backfocusEnabled'],
	['FIELD_CURVATURE', 'Field Curvature', 'fieldCurvatureEnabled'],
	['COMA', 'Coma', 'comaEnabled'],
	['ASTIGMATISM', 'Astigmatism', 'astigmatismEnabled'],
	['DECENTER', 'Decenter', 'decenterEnabled'],
	['COLLIMATION', 'Collimation', 'collimationEnabled'],
]

// Focus model, SIMULATOR_ABERRATION_FOCUS: best focus, range and the best-focus surface, steps.
const FOCUS: readonly NumberBinding<'bestFocus' | 'focusRange' | 'tilt' | 'tiltAngle' | 'curvature'>[] = [
	['BEST_FOCUS', 'Best Focus (steps)', 'bestFocus', 0, 100000, 1, '%.0f'],
	['FOCUS_RANGE', 'Focus Range (steps)', 'focusRange', 1, 100000, 10, '%.0f'],
	['TILT', 'Sensor Tilt (steps)', 'tilt', -50000, 50000, 10, '%.0f'],
	['TILT_ANGLE', 'Tilt Angle (rad)', 'tiltAngle', -TAU, TAU, 0.01, '%.3f'],
	['CURVATURE', 'Field Curvature (steps)', 'curvature', -50000, 50000, 10, '%.0f'],
]

// Shape of the aberrations, SIMULATOR_ABERRATION_SHAPE: dimensionless coefficients, blurs in unbinned
// pixels, angles in radians and decentering as fractions of the field.
const SHAPE: readonly NumberBinding<'backfocus' | 'backfocusBlur' | 'backfocusEllipticity' | 'coma' | 'astigmatism' | 'astigmatismBlur' | 'astigmatismAngle' | 'decenterX' | 'decenterY' | 'collimation' | 'collimationAngle'>[] = [
	['BACKFOCUS', 'Backfocus', 'backfocus', -1, 1, 0.01, '%.3f'],
	['BACKFOCUS_BLUR', 'Backfocus Blur (px)', 'backfocusBlur', 0, 100, 0.1, '%.2f'],
	['BACKFOCUS_ELLIPTICITY', 'Backfocus Ellipticity', 'backfocusEllipticity', 0, 0.8, 0.01, '%.3f'],
	['COMA', 'Coma', 'coma', 0, 1, 0.01, '%.3f'],
	['ASTIGMATISM', 'Astigmatism', 'astigmatism', -0.8, 0.8, 0.01, '%.3f'],
	['ASTIGMATISM_BLUR', 'Astigmatism Blur (px)', 'astigmatismBlur', 0, 100, 0.1, '%.2f'],
	['ASTIGMATISM_ANGLE', 'Astigmatism Angle (rad)', 'astigmatismAngle', -TAU, TAU, 0.01, '%.3f'],
	['DECENTER_X', 'Decenter X', 'decenterX', -0.5, 0.5, 0.01, '%.3f'],
	['DECENTER_Y', 'Decenter Y', 'decenterY', -0.5, 0.5, 0.01, '%.3f'],
	['COLLIMATION', 'Collimation', 'collimation', 0, 1, 0.01, '%.3f'],
	['COLLIMATION_ANGLE', 'Collimation Angle (rad)', 'collimationAngle', -TAU, TAU, 0.01, '%.3f'],
]

// Optics of one frame, taken when the shutter closes.
export interface CameraOpticsState {
	// Focal length and aperture, millimetres.
	readonly focalLength: number
	readonly aperture: number
	// Angle the camera is mounted at on the tube, radians.
	readonly cameraAngle: Angle
	// Focuser position of best focus, steps; zero disables the focus model.
	readonly bestFocus: number
	// Aberrations, `enabled` when any of them is.
	readonly aberration: SyntheticAberrationConfig
}

// Angular size of one unbinned pixel of pitch `pixelSize` micrometres behind `focalLength`
// millimetres, radians.
export function cameraPixelScale(pixelSize: number, focalLength: number): Angle {
	return arcsec(pixelScale(pixelSize, focalLength))
}

// Telescope, focus model and aberrations.
export class CameraOptics extends SimulatorComponent {
	readonly #telescope: ReturnType<typeof makeBoundNumberVector>
	readonly #features: ReturnType<typeof makeFlagVector>
	readonly #focus: ReturnType<typeof makeBoundNumberVector>
	readonly #shape: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector | typeof makeFlagVector>[]

	// `config` gives the initial optics and fixes the camera angle.
	constructor(
		bus: ComponentBus,
		readonly config: CameraOpticsConfig,
	) {
		super(bus)
		this.#telescope = makeBoundNumberVector('TELESCOPE_INFO', 'Telescope Info', SIMULATION, TELESCOPE, config)
		this.#features = makeFlagVector('SIMULATOR_ABERRATION_FEATURES', 'Aberration Features', SIMULATION, FEATURES, config.aberration)
		this.#focus = makeBoundNumberVector('SIMULATOR_ABERRATION_FOCUS', 'Aberration Focus', SIMULATION, FOCUS, { ...config.aberration, bestFocus: config.bestFocus })
		this.#shape = makeBoundNumberVector('SIMULATOR_ABERRATION_SHAPE', 'Aberration Shape', SIMULATION, SHAPE, config.aberration)
		this.properties = [this.#telescope, this.#features, this.#focus, this.#shape]
	}

	// Focal length, millimetres.
	get focalLength() {
		return this.#telescope.elements.FOCAL_LENGTH.value
	}

	// Aperture, millimetres.
	get aperture() {
		return this.#telescope.elements.APERTURE.value
	}

	// Current optics.
	snapshot(): CameraOpticsState {
		const features = readFlagVector(this.#features, FEATURES)
		const { bestFocus, ...focus } = readBoundNumberVector(this.#focus, FOCUS)
		const aberration: AberrationSettings = { ...features, ...focus, ...readBoundNumberVector(this.#shape, SHAPE) }
		const enabled = Object.values(features).some(Boolean)
		return { focalLength: this.focalLength, aperture: this.aperture, cameraAngle: this.config.cameraAngle, bestFocus, aberration: { ...aberration, enabled } }
	}

	// Handles TELESCOPE_INFO, SIMULATOR_ABERRATION_FOCUS and SIMULATOR_ABERRATION_SHAPE.
	handleNumber(vector: NewNumberVector) {
		const property = vector.name === this.#telescope.name ? this.#telescope : vector.name === this.#focus.name ? this.#focus : vector.name === this.#shape.name ? this.#shape : undefined
		if (property === undefined) return false
		if (applyNumberVectorValues(property, vector.elements)) this.bus.notify(property)
		return true
	}

	// Handles SIMULATOR_ABERRATION_FEATURES.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#features.name) return false
		if (applyMultiSwitchValues(this.#features, vector.elements)) this.bus.notify(this.#features)
		return true
	}
}
