import { clamp } from '../../../math/numerical/math'
import { makeNumberVector, type NewNumberVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { WheelSimulatorConfig } from './wheel.config'

// Carousel circuit of the simulated filter wheel: the motor that turns the slots past the light path.
// Slots are numbered from 1; times are milliseconds on the clock of the bus. The carousel turns the
// short way round, so going from the last slot to the first is a one-slot move.

// The turning carousel.
export class WheelCarousel extends SimulatorComponent {
	readonly #slot: ReturnType<typeof makeNumberVector>

	readonly properties: readonly ReturnType<typeof makeNumberVector>[]
	// The slot is reported by the wheel itself at power-up, never restored.
	readonly transient: readonly ReturnType<typeof makeNumberVector>[]

	// Slot being moved to, while a move runs.
	#target?: number
	// Instant the running move ends, milliseconds.
	#endsAt = 0

	// `config` gives the slot count and the move times; `connected` says whether the device accepts
	// commands.
	constructor(
		bus: ComponentBus,
		readonly config: WheelSimulatorConfig,
		readonly connected: () => boolean,
	) {
		super(bus)
		this.#slot = makeNumberVector('', 'FILTER_SLOT', 'Slot', MAIN_CONTROL, 'rw', ['FILTER_SLOT_VALUE', 'Slot', 1, 1, config.slots.length, 1, '%.0f'])
		this.properties = [this.#slot]
		this.transient = this.properties
	}

	// Slot in the light path, from 1.
	get slot() {
		return this.#slot.elements.FILTER_SLOT_VALUE.value
	}

	// Whether the carousel is turning.
	get isMoving() {
		return this.#target !== undefined
	}

	// Number of slots the carousel turns past going from `from` to `to`, the short way round.
	distance(from: number, to: number) {
		const count = this.config.slots.length
		const forward = (((to - from) % count) + count) % count
		return Math.min(forward, count - forward)
	}

	// Starts turning to `slot`, rounded and clamped to the slots; a move already running is replaced,
	// from where the carousel was, and a move to the current slot stops it there.
	moveTo(slot: number) {
		if (!this.connected()) return

		slot = clamp(Math.round(slot), 1, this.config.slots.length)

		if (slot === this.slot) {
			if (this.#target !== undefined) this.#finish(this.slot)
			return
		}

		this.#target = slot
		this.#endsAt = this.bus.now() + Math.max(this.config.minimumMoveTime, this.distance(this.slot, slot) * this.config.slotTime)
		this.#slot.state = 'Busy'
		this.bus.notify(this.#slot)
	}

	// Ends the running move once its time has passed, at `now`, milliseconds.
	tick(now: number) {
		if (this.#target !== undefined && now >= this.#endsAt) this.#finish(this.#target)
	}

	// Stops the carousel where it is when the device disconnects.
	reset() {
		this.#target = undefined
		this.#slot.state = 'Idle'
	}

	// Handles FILTER_SLOT.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#slot.name) return false
		if (vector.elements.FILTER_SLOT_VALUE !== undefined) this.moveTo(vector.elements.FILTER_SLOT_VALUE)
		return true
	}

	// Settles the carousel at `slot` and publishes it Idle.
	#finish(slot: number) {
		this.#target = undefined
		this.#slot.elements.FILTER_SLOT_VALUE.value = slot
		this.#slot.state = 'Idle'
		this.bus.notify(this.#slot)
	}
}
