import { TAU } from '../../../core/constants'
import type { ImageRawType } from '../../../imaging/model/types'
import { renderSyntheticFlat, type SyntheticDustMote } from '../../../imaging/synthetic/flat'
import { mulberry32 } from '../../../math/numerical/random'
import type { NewNumberVector } from '../types'
import type { CameraFlatConfig } from './camera.config'
import type { CameraReadoutState } from './camera.readout'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, readBoundNumberVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import { applyNumberVectorValues } from './util'

// Flat-field circuit of the simulated camera: the illumination a flat frame records, with vignetting,
// gradients, pixel response non-uniformity, dust shadows and banding, all fixed to the sensor so that
// they survive any subframe and binning. Geometry is in unbinned sensor pixels and angles in radians.

// Illumination, SIMULATOR_FLAT_FIELD.
const FIELD: readonly NumberBinding<'referenceSignal' | 'vignetting' | 'centerOffsetX' | 'centerOffsetY' | 'gradientX' | 'gradientY' | 'prnu'>[] = [
	['REFERENCE_SIGNAL', 'Reference Signal', 'referenceSignal', 0, 10, 0.001, '%.4f'],
	['VIGNETTING', 'Vignetting', 'vignetting', 0, 1, 0.001, '%.4f'],
	['CENTER_OFFSET_X', 'Center Offset X', 'centerOffsetX', -1, 1, 0.001, '%.4f'],
	['CENTER_OFFSET_Y', 'Center Offset Y', 'centerOffsetY', -1, 1, 0.001, '%.4f'],
	['GRADIENT_X', 'Gradient X', 'gradientX', -1, 1, 0.001, '%.4f'],
	['GRADIENT_Y', 'Gradient Y', 'gradientY', -1, 1, 0.001, '%.4f'],
	['PRNU', 'PRNU', 'prnu', 0, 1, 0.0001, '%.5f'],
]

// Dust shadows, SIMULATOR_FLAT_DUST.
const DUST: readonly NumberBinding<'dustCount' | 'dustSigmaX' | 'dustSigmaY' | 'dustAngle' | 'dustContrast'>[] = [
	['COUNT', 'Count', 'dustCount', 0, 256, 1, '%.0f'],
	['SIGMA_X', 'Sigma X (px)', 'dustSigmaX', 0.1, 1000, 0.1, '%.2f'],
	['SIGMA_Y', 'Sigma Y (px)', 'dustSigmaY', 0.1, 1000, 0.1, '%.2f'],
	['ANGLE', 'Angle (rad)', 'dustAngle', -TAU, TAU, 0.01, '%.3f'],
	['CONTRAST', 'Contrast', 'dustContrast', 0, 1, 0.001, '%.4f'],
]

// Row and column banding, SIMULATOR_FLAT_BANDING.
const BANDING: readonly NumberBinding<'rowAmplitude' | 'rowPeriod' | 'rowPhase' | 'columnAmplitude' | 'columnPeriod' | 'columnPhase'>[] = [
	['ROW_AMPLITUDE', 'Row Amplitude', 'rowAmplitude', 0, 0.5, 0.001, '%.4f'],
	['ROW_PERIOD', 'Row Period (px)', 'rowPeriod', 0.1, 10000, 0.1, '%.2f'],
	['ROW_PHASE', 'Row Phase (rad)', 'rowPhase', -TAU, TAU, 0.01, '%.3f'],
	['COLUMN_AMPLITUDE', 'Column Amplitude', 'columnAmplitude', 0, 0.5, 0.001, '%.4f'],
	['COLUMN_PERIOD', 'Column Period (px)', 'columnPeriod', 0.1, 10000, 0.1, '%.2f'],
	['COLUMN_PHASE', 'Column Phase (rad)', 'columnPhase', -TAU, TAU, 0.01, '%.3f'],
]

// Relative response of the red, green and blue channels of an RGB readout to a flat source.
const RGB_FLAT_RESPONSE = [1.02, 1, 0.98] as const

// Renders the flat illumination of a frame into `raw`, which holds `readout.imageWidth` ×
// `readout.imageHeight` × `readout.channels` samples.
//
// `sensorWidth` and `sensorHeight` are unbinned pixels. `seed` fixes the dust positions and the
// response non-uniformity, so a fresh generator with the same seed puts the motes in the same physical
// place on every frame. `signalScale` multiplies the reference signal, e.g. exposure over the
// reference exposure. Adds to `raw` before the noise is generated over it.
export function renderCameraFlat(raw: ImageRawType, flat: CameraFlatConfig, readout: CameraReadoutState, sensorWidth: number, sensorHeight: number, seed: number, signalScale: number) {
	const dustCount = flat.dustContrast > 0 ? Math.round(flat.dustCount) : 0
	let dustMotes: SyntheticDustMote[] | undefined

	if (dustCount > 0) {
		const random = mulberry32(seed >>> 0)
		dustMotes = new Array<SyntheticDustMote>(dustCount)

		for (let i = 0; i < dustCount; i++) {
			dustMotes[i] = { center: { x: random() * (sensorWidth - 1), y: random() * (sensorHeight - 1) }, sigmaX: flat.dustSigmaX, sigmaY: flat.dustSigmaY, angle: flat.dustAngle, contrast: flat.dustContrast }
		}
	}

	renderSyntheticFlat(raw, {
		width: readout.imageWidth,
		height: readout.imageHeight,
		channels: readout.channels,
		channelResponse: readout.channels === 3 ? RGB_FLAT_RESPONSE : undefined,
		sensor: { width: sensorWidth, height: sensorHeight, origin: { x: readout.x, y: readout.y }, binning: [readout.binX, readout.binY], extent: { width: readout.width, height: readout.height } },
		bias: 0,
		signal: flat.referenceSignal * signalScale,
		vignetting: flat.vignetting,
		centerOffset: { x: flat.centerOffsetX, y: flat.centerOffsetY },
		gradient: { x: flat.gradientX, y: flat.gradientY },
		prnu: flat.prnu,
		seed: seed >>> 0,
		dustMotes,
		rowBanding: flat.rowAmplitude > 0 ? { amplitude: flat.rowAmplitude, period: flat.rowPeriod, phase: flat.rowPhase } : undefined,
		columnBanding: flat.columnAmplitude > 0 ? { amplitude: flat.columnAmplitude, period: flat.columnPeriod, phase: flat.columnPhase } : undefined,
	})
}

// Flat-field illumination.
export class CameraFlatField extends SimulatorComponent {
	readonly #field: ReturnType<typeof makeBoundNumberVector>
	readonly #dust: ReturnType<typeof makeBoundNumberVector>
	readonly #banding: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector>[]

	// `config` gives the initial illumination.
	constructor(bus: ComponentBus, config: CameraFlatConfig) {
		super(bus)
		this.#field = makeBoundNumberVector('SIMULATOR_FLAT_FIELD', 'Flat Field', SIMULATION, FIELD, config)
		this.#dust = makeBoundNumberVector('SIMULATOR_FLAT_DUST', 'Flat Dust', SIMULATION, DUST, config)
		this.#banding = makeBoundNumberVector('SIMULATOR_FLAT_BANDING', 'Flat Banding', SIMULATION, BANDING, config)
		this.properties = [this.#field, this.#dust, this.#banding]
	}

	// Current illumination.
	snapshot(): CameraFlatConfig {
		return { ...readBoundNumberVector(this.#field, FIELD), ...readBoundNumberVector(this.#dust, DUST), ...readBoundNumberVector(this.#banding, BANDING) }
	}

	// Handles SIMULATOR_FLAT_FIELD, SIMULATOR_FLAT_DUST and SIMULATOR_FLAT_BANDING.
	handleNumber(vector: NewNumberVector) {
		const property = this.properties.find((e) => e.name === vector.name)
		if (property === undefined) return false
		if (applyNumberVectorValues(property, vector.elements)) this.bus.notify(property)
		return true
	}
}
