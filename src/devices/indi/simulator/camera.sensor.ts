import type { CfaPattern } from '../../../imaging/model/types'
import { makeNumberVector, makeTextVector } from '../types'
import type { CameraSensorConfig } from './camera.config'
import { type ComponentBus, SimulatorComponent } from './component'
import { GENERAL_INFO } from './constants'

// Sensor circuit of the simulated camera: the fixed characteristics of the chip, published read-only.
// Geometry is in unbinned pixels and the pixel pitch in micrometres.

// Sensor chip: geometry, pixel pitch, bit depth and colour filter array.
export class CameraSensor extends SimulatorComponent {
	// oxfmt-ignore
	readonly #info = makeNumberVector('', 'CCD_INFO', 'CCD Info', GENERAL_INFO, 'ro', ['CCD_MAX_X', 'Max X', 0, 0, 16000, 1, '%.0f'], ['CCD_MAX_Y', 'Max Y', 0, 0, 16000, 1, '%.0f'], ['CCD_PIXEL_SIZE_X', 'Pixel size X', 0, 0, 40, 0.01, '%.2f'], ['CCD_PIXEL_SIZE_Y', 'Pixel size Y', 0, 0, 40, 0.01, '%.2f'], ['CCD_BITSPERPIXEL', 'Bits per pixel', 16, 8, 64, 1, '%.0f'])
	readonly #cfa = makeTextVector('', 'CCD_CFA', 'CFA', GENERAL_INFO, 'ro', ['CFA_OFFSET_X', 'Offset X', '0'], ['CFA_OFFSET_Y', 'Offset Y', '0'], ['CFA_TYPE', 'Type', 'RGGB'])

	readonly properties = [this.#info, this.#cfa]
	readonly transient = this.properties

	// `config` fixes the chip; it never changes afterwards.
	constructor(
		bus: ComponentBus,
		readonly config: CameraSensorConfig,
	) {
		super(bus)

		this.#info.elements.CCD_MAX_X.value = config.width
		this.#info.elements.CCD_MAX_Y.value = config.height
		this.#info.elements.CCD_PIXEL_SIZE_X.value = config.pixelSize
		this.#info.elements.CCD_PIXEL_SIZE_Y.value = config.pixelSize
		this.#info.elements.CCD_BITSPERPIXEL.value = config.bitsPerPixel
		this.#cfa.elements.CFA_TYPE.value = config.cfa
	}

	// Sensor width, unbinned pixels.
	get width() {
		return this.config.width
	}

	// Sensor height, unbinned pixels.
	get height() {
		return this.config.height
	}

	// Pixel pitch, micrometres.
	get pixelSize() {
		return this.config.pixelSize
	}

	// Colour filter array layout of a monochrome readout.
	get cfa(): CfaPattern {
		return this.config.cfa
	}
}
