import { TAU } from '../../../core/constants'
import type { PlotStarOptions } from '../../../imaging/stars/generator'
import type { NewNumberVector, NewSwitchVector } from '../types'
import type { CameraBahtinovConfig, CameraCollimationConfig, CameraPsfConfig, CameraPsfModel } from './camera.config'
import { type ChoiceBinding, type ComponentBus, makeBoundNumberVector, makeChoiceVector, type NumberBinding, readBoundNumberVector, readChoiceVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import { applyExclusiveSwitchValues, applyNumberVectorValues } from './util'

// Point-spread-function circuit of the simulated camera: how a star is drawn. Besides a focused
// Gaussian or Moffat profile, a star can be drawn as the defocused annulus a collimation tool reads or
// as the diffraction pattern of a Bahtinov mask. Sizes are unbinned pixels and angles radians unless
// stated.

// Star models, SIMULATOR_STAR_PLOT_PSF_MODEL.
const MODEL: readonly ChoiceBinding<CameraPsfModel>[] = [
	['GAUSSIAN', 'Gaussian', 'gaussian'],
	['MOFFAT', 'Moffat', 'moffat'],
	['ANNULAR', 'Annular', 'annular'],
	['BAHTINOV', 'Bahtinov', 'bahtinov'],
]

// Star shape, SIMULATOR_STAR_PLOT_OPTIONS. A zero saturation level disables saturation.
const SHAPE: readonly NumberBinding<'ellipticity' | 'theta' | 'beta' | 'saturationLevel'>[] = [
	['ELLIPTICITY', 'Ellipticity', 'ellipticity', 0, 0.8, 0.01, '%.3f'],
	['THETA', 'Theta', 'theta', -TAU, TAU, 0.01, '%.3f'],
	['BETA', 'Beta', 'beta', 1.05, 20, 0.01, '%.3f'],
	['SATURATION_LEVEL', 'Saturation Level', 'saturationLevel', 0, 10, 0.01, '%.3f'],
]

// Bahtinov mask pattern, SIMULATOR_BAHTINOV_PATTERN: angles in degrees, sizes in unbinned pixels.
const BAHTINOV: readonly NumberBinding<keyof CameraBahtinovConfig>[] = [
	['NORMAL_ANGLE_1', 'Normal Angle 1 (deg)', 'normalAngle1', -360, 360, 0.1, '%.2f'],
	['NORMAL_ANGLE_2', 'Normal Angle 2 (deg)', 'normalAngle2', -360, 360, 0.1, '%.2f'],
	['NORMAL_ANGLE_3', 'Normal Angle 3 (deg)', 'normalAngle3', -360, 360, 0.1, '%.2f'],
	['FWHM', 'FWHM (sensor px)', 'fwhm', 0.1, 64, 0.1, '%.2f'],
	['HALF_LENGTH', 'Half Length (sensor px)', 'halfLength', 1, 2048, 1, '%.0f'],
	['TAPER_LENGTH', 'Taper Length (sensor px)', 'taperLength', 0, 2048, 1, '%.0f'],
	['STRENGTH_1', 'Strength 1', 'strength1', 0, 10, 0.01, '%.3f'],
	['STRENGTH_2', 'Strength 2', 'strength2', 0, 10, 0.01, '%.3f'],
	['STRENGTH_3', 'Strength 3', 'strength3', 0, 10, 0.01, '%.3f'],
	['SPIKE_FLUX_RATIO', 'Spike Flux Ratio', 'spikeFluxRatio', 0, 10, 0.01, '%.3f'],
	['FOCUS_STEPS_PER_PIXEL', 'Focus Steps/Pixel', 'focusStepsPerPixel', 1, 100000, 1, '%.0f'],
	['CUTOFF_SIGMA', 'Cutoff Sigma', 'cutoffSigma', 1, 10, 0.1, '%.2f'],
]

// Defocused annulus, SIMULATOR_COLLIMATION_PATTERN: sizes in unbinned pixels.
const COLLIMATION: readonly NumberBinding<keyof CameraCollimationConfig>[] = [
	['MAX_RADIUS', 'Maximum Radius (px)', 'maxRadius', 2, 512, 1, '%.0f'],
	['OBSTRUCTION_RATIO', 'Obstruction Ratio', 'obstructionRatio', 0.05, 0.9, 0.01, '%.3f'],
	['EDGE_SOFTNESS', 'Edge Softness (px)', 'edgeSoftness', 0.05, 20, 0.05, '%.2f'],
	['SPIDER_VANES', 'Spider Vanes', 'spiderVanes', 0, 12, 1, '%.0f'],
	['SPIDER_WIDTH', 'Spider Width (px)', 'spiderWidth', 0, 20, 0.1, '%.2f'],
	['SPIDER_ANGLE', 'Spider Angle (rad)', 'spiderAngle', -TAU, TAU, 0.01, '%.3f'],
	['SPIDER_ATTENUATION', 'Spider Attenuation', 'spiderAttenuation', 0, 1, 0.01, '%.3f'],
]

// How the stars of one frame are drawn, taken when the shutter closes.
export interface CameraPsfState {
	readonly model: CameraPsfModel
	// Plotting options of a focused star, without the focus position, which the renderer supplies.
	readonly plot: PlotStarOptions
	readonly bahtinov: CameraBahtinovConfig
	readonly collimation: CameraCollimationConfig
}

// Star drawing model.
export class CameraPsf extends SimulatorComponent {
	readonly #model: ReturnType<typeof makeChoiceVector>
	readonly #shape: ReturnType<typeof makeBoundNumberVector>
	readonly #bahtinov: ReturnType<typeof makeBoundNumberVector>
	readonly #collimation: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector | typeof makeChoiceVector>[]

	// `config` gives the initial model and shape and fixes the remaining plotting options.
	constructor(
		bus: ComponentBus,
		readonly config: CameraPsfConfig,
	) {
		super(bus)
		this.#model = makeChoiceVector('SIMULATOR_STAR_PLOT_PSF_MODEL', 'Star PSF Model', SIMULATION, MODEL, config.model)
		this.#shape = makeBoundNumberVector('SIMULATOR_STAR_PLOT_OPTIONS', 'Star Plot', SIMULATION, SHAPE, config)
		this.#bahtinov = makeBoundNumberVector('SIMULATOR_BAHTINOV_PATTERN', 'Bahtinov Pattern', SIMULATION, BAHTINOV, config.bahtinov)
		this.#collimation = makeBoundNumberVector('SIMULATOR_COLLIMATION_PATTERN', 'Collimation Pattern', SIMULATION, COLLIMATION, config.collimation)
		this.properties = [this.#model, this.#shape, this.#bahtinov, this.#collimation]
	}

	// Current drawing model.
	snapshot(): CameraPsfState {
		const model = readChoiceVector(this.#model, MODEL)
		const { saturationLevel, ...shape } = readBoundNumberVector(this.#shape, SHAPE)
		const plot: PlotStarOptions = { ...this.config.plot, ...shape, saturationLevel: saturationLevel > 0 ? saturationLevel : undefined, psfModel: model === 'moffat' ? 'moffat' : 'gaussian' }
		return { model, plot, bahtinov: readBoundNumberVector(this.#bahtinov, BAHTINOV), collimation: readBoundNumberVector(this.#collimation, COLLIMATION) }
	}

	// Handles SIMULATOR_STAR_PLOT_OPTIONS, SIMULATOR_BAHTINOV_PATTERN and SIMULATOR_COLLIMATION_PATTERN.
	handleNumber(vector: NewNumberVector) {
		const property = vector.name === this.#shape.name ? this.#shape : vector.name === this.#bahtinov.name ? this.#bahtinov : vector.name === this.#collimation.name ? this.#collimation : undefined
		if (property === undefined) return false
		if (applyNumberVectorValues(property, vector.elements)) this.bus.notify(property)
		return true
	}

	// Handles SIMULATOR_STAR_PLOT_PSF_MODEL.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#model.name) return false
		if (applyExclusiveSwitchValues(this.#model, vector.elements)) this.bus.notify(this.#model)
		return true
	}
}
