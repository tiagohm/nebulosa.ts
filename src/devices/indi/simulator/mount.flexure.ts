import { applyTubeFlexureError } from '../../../astronomy/coordinates/pointing'
import { ASEC2RAD } from '../../../core/constants'
import type { Angle } from '../../../math/units/angle'
import type { PierSide } from '../device'
import type { NewNumberVector } from '../types'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import type { MountFlexureConfig } from './mount.config'
import { applyNumberVectorValues } from './util'

// Flexure circuit of the simulated mount: effects that depend on where the tube is rather than on the
// geometry of the axes. The tube droops by TUBE_FLEXURE at the horizon, nothing at the zenith, in the
// vertical; the pier terms are the constant offset of the west side relative to the east, as
// right-ascension and declination offsets on the convention of the index errors. Arcseconds configured,
// radians applied.

// Terms of MOUNT_FLEXURE, arcseconds.
const FLEXURE: readonly NumberBinding<keyof MountFlexureConfig>[] = [
	['TUBE_FLEXURE', 'Tube Flexure (arcsec)', 'tubeFlexure', -3600, 3600, 0.1, '%.3f'],
	['PIER_WEST_RA', 'Pier West RA Offset (arcsec)', 'pierWestRightAscension', -3600, 3600, 0.1, '%.3f'],
	['PIER_WEST_DEC', 'Pier West DEC Offset (arcsec)', 'pierWestDeclination', -3600, 3600, 0.1, '%.3f'],
]

// Gravity on the tube.
export class MountFlexure extends SimulatorComponent {
	readonly #flexure: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector>[]

	// Whether the flexure family is simulated; set by the device from SIMULATOR_ERROR_FEATURES.
	enabled = false

	// Scratch tuple of the droop, reused because the boresight is evaluated on every tick.
	readonly #scratch: [Angle, Angle] = [0, 0]

	// `config` gives the initial terms; `changed` runs after a command changed them.
	constructor(
		bus: ComponentBus,
		config: MountFlexureConfig,
		readonly changed: () => void,
	) {
		super(bus)
		this.#flexure = makeBoundNumberVector('MOUNT_FLEXURE', 'Flexure', SIMULATION, FLEXURE, config)
		this.properties = [this.#flexure]
	}

	// Whether any term moves the optical axis.
	get active() {
		const { TUBE_FLEXURE, PIER_WEST_RA, PIER_WEST_DEC } = this.#flexure.elements
		return this.enabled && (TUBE_FLEXURE.value !== 0 || PIER_WEST_RA.value !== 0 || PIER_WEST_DEC.value !== 0)
	}

	// Bends (`rightAscension`, `declination`), radians, at local sidereal time `lst` and `latitude` on
	// `pierSide`, writing the result into `out`.
	//
	// The droop comes after the geometric terms, which are far too small to change the zenith distance
	// it depends on, and follows a great circle near the pole where an hour-angle turn cannot express
	// it. The pier offset applies on one side only, read from the side the mount is actually on: a
	// tracked target crosses the meridian by itself, and predicting the side there would take the
	// offset away from a mount that had not flipped, in one step.
	apply(rightAscension: Angle, declination: Angle, lst: Angle, latitude: Angle, pierSide: PierSide, out: [Angle, Angle]) {
		out[0] = rightAscension
		out[1] = declination
		if (!this.enabled) return out

		const { TUBE_FLEXURE, PIER_WEST_RA, PIER_WEST_DEC } = this.#flexure.elements

		if (TUBE_FLEXURE.value !== 0) {
			const [ra, dec] = applyTubeFlexureError(out[0], out[1], lst, latitude, TUBE_FLEXURE.value * ASEC2RAD, this.#scratch)
			out[0] = ra
			out[1] = dec
		}

		if (pierSide === 'WEST') {
			out[0] += PIER_WEST_RA.value * ASEC2RAD
			out[1] += PIER_WEST_DEC.value * ASEC2RAD
		}

		return out
	}

	// Handles MOUNT_FLEXURE.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#flexure.name) return false

		if (applyNumberVectorValues(this.#flexure, vector.elements)) {
			this.changed()
			this.bus.notify(this.#flexure)
		}

		return true
	}
}
