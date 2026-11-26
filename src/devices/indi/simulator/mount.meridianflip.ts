import { type Angle, deg } from '../../../math/units/angle'
import type { PierSide } from '../device'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, selectOnSwitch } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import type { MountMeridianConfig } from './mount.config'
import type { SimulatorProperty } from './types'
import { applyNumberVectorValues } from './util'

// Meridian circuit of the simulated mount: the controller's own meridian flip and the meridian limit.
// Hour angles are radians, unwrapped, measured from the reported coordinate since it was last placed;
// published settings are degrees.
//
// The flip is a one-shot latch: once it starts, or is aborted, it does not start again until the target
// is back before the threshold on the west side or the feature is enabled again. The limit is how far
// past the upper meridian the tube may go on its current side, counterweights up: a goto stays on that
// side up to it and tracking on the west side stops beyond it. A zero limit disables it.

// The meridian policy.
export class MountMeridianFlip extends SimulatorComponent {
	// Whether the controller flips by itself. Off by default, so an external sequencer remains the sole
	// owner unless a session deliberately exercises it.
	readonly #enabled = makeSwitchVector('', 'MOUNT_AUTO_MERIDIAN_FLIP', 'Automatic Meridian Flip', SIMULATION, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	// Hour angle past the upper meridian at which the flip starts, and the meridian limit, degrees.
	readonly #settings = makeNumberVector('', 'MOUNT_MERIDIAN_FLIP_SETTINGS', 'Meridian Flip Settings', SIMULATION, 'rw', ['HOUR_ANGLE', 'Hour Angle (deg)', 0, -90, 90, 0.1, '%.2f'], ['LIMIT', 'Meridian Limit (deg)', 0, 0, 90, 0.1, '%.2f'])

	readonly properties: readonly SimulatorProperty[] = [this.#enabled, this.#settings]

	// Whether the next crossing of the threshold may start a flip.
	armed = true
	// Whether the property load in progress itself enabled the feature.
	#enabledByLoad = false
	// Reported hour angle, and the furthest it reached since the last placement, radians.
	hourAngle: Angle = 0
	maximumHourAngle: Angle = 0

	// `config` gives the initial policy.
	constructor(bus: ComponentBus, config: MountMeridianConfig) {
		super(bus)
		if (config.automaticFlip) selectOnSwitch(this.#enabled, 'INDI_ENABLED')
		this.#settings.elements.HOUR_ANGLE.value = config.flipHourAngle
		this.#settings.elements.LIMIT.value = config.limit
	}

	// Whether the controller flips by itself.
	get enabled() {
		return this.#enabled.elements.INDI_ENABLED.value
	}

	// Hour angle at which the flip starts, radians.
	get threshold(): Angle {
		return deg(this.#settings.elements.HOUR_ANGLE.value)
	}

	// Meridian limit, radians past the upper meridian; zero when disabled.
	get limit(): Angle {
		return deg(this.#settings.elements.LIMIT.value)
	}

	// Whether a tube on `pierSide` may point at hour angle `hourAngle`, radians in [-PI, PI): on its
	// normal side always, and past the meridian, counterweights up, by no more than the limit.
	accepts(pierSide: PierSide, hourAngle: Angle) {
		if (pierSide === 'WEST') return hourAngle <= this.limit
		if (pierSide === 'EAST') return hourAngle >= -this.limit
		return true
	}

	// Whether tracking on `pierSide` has run past the limit.
	exceeded(pierSide: PierSide) {
		return this.limit > 0 && pierSide === 'WEST' && this.hourAngle > this.limit
	}

	// Enables or disables the flip, rearming it on every enable.
	setEnabled(enabled: boolean) {
		const changed = selectOnSwitch(this.#enabled, enabled ? 'INDI_ENABLED' : 'INDI_DISABLED')
		if (enabled) this.armed = true
		if (changed) this.bus.notify(this.#enabled)
	}

	// Re-registers the hour angle at `hourAngle`, radians, after a placement, rearming the latch when
	// `rearm`.
	rebase(hourAngle: Angle, rearm: boolean = true) {
		this.hourAngle = hourAngle
		this.maximumHourAngle = hourAngle
		if (rearm) this.armed = true
	}

	// Shifts the hour angle and its maximum by `delta`, radians, when the reported frame changed, which
	// keeps crossings accumulated before it.
	shift(delta: Angle) {
		this.hourAngle += delta
		this.maximumHourAngle += delta
	}

	// Moves the hour angle by `delta`, radians, as the axis or the clock carries the target, keeping
	// the furthest one; a backwards clock resets the maximum when `rewind`.
	advance(delta: Angle, rewind: boolean = false) {
		this.hourAngle += delta
		this.maximumHourAngle = rewind ? this.hourAngle : Math.max(this.maximumHourAngle, this.hourAngle)
	}

	// Whether a flip is due for a mount on `pierSide` that is `idle`: tracking, unparked and not moving
	// under any command. Rearms the latch while the target is back before the threshold on the west.
	due(pierSide: PierSide, idle: boolean) {
		if (!this.enabled) return false

		if (!this.armed) {
			if (pierSide === 'WEST' && this.hourAngle < this.threshold) {
				this.armed = true
				this.maximumHourAngle = this.hourAngle
			}

			return false
		}

		return this.maximumHourAngle >= this.threshold && idle && pierSide === 'WEST'
	}

	// Marks the start of a property load.
	beginLoad() {
		this.#enabledByLoad = false
	}

	// Notes a persisted `property` about to replace `actual`: a load that turns the feature on counts
	// as an explicit enable.
	loading(actual: SimulatorProperty, persisted: SimulatorProperty) {
		if (actual === this.#enabled && !this.enabled && persisted.elements.INDI_ENABLED?.value === true) this.#enabledByLoad = true
	}

	// Ends a property load, arming the latch only when the load itself enabled the feature, so a load
	// that merely rewrote other settings cannot restart an aborted flip.
	endLoad() {
		if (this.#enabledByLoad) this.armed = true
		this.#enabledByLoad = false
	}

	// Handles MOUNT_MERIDIAN_FLIP_SETTINGS.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#settings.name) return false
		if (applyNumberVectorValues(this.#settings, vector.elements)) this.bus.notify(this.#settings)
		return true
	}

	// Handles MOUNT_AUTO_MERIDIAN_FLIP.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#enabled.name) return false
		if (vector.elements.INDI_ENABLED === true) this.setEnabled(true)
		else if (vector.elements.INDI_DISABLED === true) this.setEnabled(false)
		return true
	}
}
