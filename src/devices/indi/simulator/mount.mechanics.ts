import { ASEC2RAD } from '../../../core/constants'
import { mulberry32, normal, type Random } from '../../../math/numerical/random'
import type { Angle } from '../../../math/units/angle'
import type { NewNumberVector } from '../types'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, readBoundNumberVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import { clearMechanicalAxis, IDENTITY_MECHANICAL_AXIS_CONFIG, type MechanicalAxisConfig, mechanicalAxisState, reconcileMechanicalAxis } from './mount.axis'
import type { MountMechanicsConfig } from './mount.config'
import { applyNumberVectorValues } from './util'

// Mechanics circuit of the simulated mount: the transmission between each motor and its axis, with
// backlash and stiction, and the repeatability of the home sensor. Configured in arcseconds, held in
// radians. The axis state itself is driven by the device through the functions of mount.axis.ts.

// Terms of MOUNT_MECHANICS, arcseconds except the take-up rate.
const MECHANICS: readonly NumberBinding<keyof MountMechanicsConfig>[] = [
	['BACKLASH_RA', 'RA Backlash (arcsec)', 'backlashRightAscension', 0, 3600, 0.1, '%.3f'],
	['BACKLASH_DEC', 'DEC Backlash (arcsec)', 'backlashDeclination', 0, 3600, 0.1, '%.3f'],
	['TAKE_UP_RATE', 'Backlash Take-up Rate', 'takeUpRate', 0.01, 1, 0.01, '%.3f'],
	['STICTION_RA', 'RA Stiction (arcsec)', 'stictionRightAscension', 0, 60, 0.01, '%.3f'],
	['STICTION_DEC', 'DEC Stiction (arcsec)', 'stictionDeclination', 0, 60, 0.01, '%.3f'],
	['HOME_SCATTER', 'Home Repeatability (arcsec)', 'homeScatter', 0, 600, 0.1, '%.3f'],
]

// Transmissions of both axes and the home sensor.
export class MountMechanics extends SimulatorComponent {
	readonly #mechanics: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector>[]

	// Whether the mechanics family is simulated; set through `refresh`.
	enabled = false
	// Live transmission state of each axis: open slack, loaded flank and whether it is stuck.
	readonly rightAscensionAxis = mechanicalAxisState()
	readonly declinationAxis = mechanicalAxisState()
	// Transmission configuration in effect per axis, the identity while the family is off.
	rightAscensionTransmission: MechanicalAxisConfig = IDENTITY_MECHANICAL_AXIS_CONFIG
	declinationTransmission: MechanicalAxisConfig = IDENTITY_MECHANICAL_AXIS_CONFIG
	// Residual of the home sensor from the last successful FIND, radians per axis.
	homeScatterRightAscension: Angle = 0
	homeScatterDeclination: Angle = 0
	// Standard normal source of the sensor residual.
	readonly #normal: Random

	// `config` gives the initial terms and `seed` the generator of the sensor residual.
	constructor(bus: ComponentBus, config: MountMechanicsConfig, seed: number) {
		super(bus)
		this.#mechanics = makeBoundNumberVector('MOUNT_MECHANICS', 'Mechanics', SIMULATION, MECHANICS, config)
		this.properties = [this.#mechanics]
		this.#normal = normal(mulberry32(seed))
	}

	// Rebuilds the transmissions for the family being `enabled` or not. Switching it off also throws
	// away the live slack, flank, stiction and sensor residual, so the mount it leaves is ideal rather
	// than frozen wherever the transmission had carried it.
	refresh(enabled: boolean) {
		this.enabled = enabled

		if (!enabled) {
			this.rightAscensionTransmission = IDENTITY_MECHANICAL_AXIS_CONFIG
			this.declinationTransmission = IDENTITY_MECHANICAL_AXIS_CONFIG
			this.clearHomeScatter()
			clearMechanicalAxis(this.rightAscensionAxis)
			clearMechanicalAxis(this.declinationAxis)
			return
		}

		const terms = readBoundNumberVector(this.#mechanics, MECHANICS)
		this.rightAscensionTransmission = { backlash: terms.backlashRightAscension * ASEC2RAD, takeUpRate: terms.takeUpRate, staticThreshold: terms.stictionRightAscension * ASEC2RAD }
		this.declinationTransmission = { backlash: terms.backlashDeclination * ASEC2RAD, takeUpRate: terms.takeUpRate, staticThreshold: terms.stictionDeclination * ASEC2RAD }
		// Slack opened under a larger backlash shrinks with it.
		reconcileMechanicalAxis(this.rightAscensionAxis, this.rightAscensionTransmission)
		reconcileMechanicalAxis(this.declinationAxis, this.declinationTransmission)
	}

	// Draws the sensor residual of a successful FIND: Gaussian per axis with the configured
	// repeatability as its standard deviation, none when it is zero or the family is off.
	scatterHome() {
		const scatter = this.enabled ? this.#mechanics.elements.HOME_SCATTER.value * ASEC2RAD : 0

		if (scatter > 0) {
			this.homeScatterRightAscension = this.#normal() * scatter
			this.homeScatterDeclination = this.#normal() * scatter
		} else {
			this.clearHomeScatter()
		}
	}

	// Forgets the sensor residual, as a sync re-registers the bookkeeping.
	clearHomeScatter() {
		this.homeScatterRightAscension = 0
		this.homeScatterDeclination = 0
	}

	// Handles MOUNT_MECHANICS.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#mechanics.name) return false

		if (applyNumberVectorValues(this.#mechanics, vector.elements)) {
			this.refresh(this.enabled)
			this.bus.notify(this.#mechanics)
		}

		return true
	}
}
