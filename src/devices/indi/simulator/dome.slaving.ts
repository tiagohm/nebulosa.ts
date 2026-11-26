import type { Mount } from '../device'
import { makeSwitchVector, type NewSwitchVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { DomeDrive } from './dome.drive'
import type { DomeGeometry } from './dome.geometry'
import type { DomeParking } from './dome.parking'
import { applyExclusiveSwitchValues, shortestRotatorDelta } from './util'

// Slaving circuit of the simulated dome: while on, it keeps the slit in front of the snooped mount's
// optical ray, turning the dome whenever the slit has to move by more than the threshold. Azimuths are
// degrees. Slaving is a session behavior, off at power-up, and stopping the dome turns it off.

// The dome's autosync.
export class DomeSlaving extends SimulatorComponent {
	readonly #enabled = makeSwitchVector('', 'DOME_AUTOSYNC', 'Auto-sync', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])

	readonly properties = [this.#enabled]
	readonly transient = this.properties

	// `mount` resolves the snooped mount, when connected; `geometry` solves the slit, `parking` gives
	// the threshold and `drive` turns the dome.
	constructor(
		bus: ComponentBus,
		readonly mount: () => Mount | undefined,
		readonly geometry: DomeGeometry,
		readonly parking: DomeParking,
		readonly drive: DomeDrive,
	) {
		super(bus)
	}

	// Whether slaving is on.
	get enabled() {
		return this.#enabled.elements.INDI_ENABLED.value
	}

	// Turns slaving off, publishing it when it was on.
	disable() {
		if (applyExclusiveSwitchValues(this.#enabled, { INDI_DISABLED: true })) this.bus.notify(this.#enabled)
	}

	// Follows the mount at `now`, milliseconds: retargets the dome when the slit has to move by more
	// than the threshold from where it is going, and stops a slaved goto when the mount is gone.
	tick(now: number) {
		if (!this.enabled) return

		const mount = this.mount()
		const target = mount === undefined ? undefined : this.geometry.slitAzimuth(mount)

		if (target === undefined) {
			if (this.drive.move === 'slew') this.drive.stop(false)
			return
		}

		const threshold = this.parking.autoSyncThreshold
		const going = this.drive.target
		if (going !== undefined && Math.abs(shortestRotatorDelta(target, going)) <= threshold) return
		if (Math.abs(shortestRotatorDelta(target, this.drive.azimuth)) <= threshold) return

		this.drive.turnTo(target, 'slew')
	}

	// Turns slaving off when the device disconnects.
	reset() {
		this.disable()
	}

	// Handles DOME_AUTOSYNC: turning it on follows the mount at once, turning it off stops a slaved goto.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#enabled.name) return false

		if (applyExclusiveSwitchValues(this.#enabled, vector.elements)) {
			this.bus.notify(this.#enabled)
			if (this.enabled) this.tick(this.bus.now())
			else if (this.drive.move === 'slew') this.drive.stop(false)
		}

		return true
	}
}
