import { clamp } from '../../../math/numerical/math'
import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { makeNumberVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector } from '../types'
import type { ClientSimulator } from './client'
import { FILTER_WHEEL_MOVE_TIME_MS, FILTER_WHEEL_SLOT_NAMES, MAIN_CONTROL } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'
import { applyTextVectorValues } from './util'

// Simulated filter wheel slots, names, and timed movement.

// Simulated filter wheel with a fixed set of slots; models a timed move between slots.
export class WheelSimulator extends DeviceSimulator {
	readonly type = 'wheel'

	readonly #position = makeNumberVector('', 'FILTER_SLOT', 'Slot', MAIN_CONTROL, 'rw', ['FILTER_SLOT_VALUE', 'Slot', 1, 1, FILTER_WHEEL_SLOT_NAMES.length, 1, '%.0f'])
	readonly #names = makeTextVector('', 'FILTER_NAME', 'Filter', MAIN_CONTROL, 'rw', ...FILTER_WHEEL_SLOT_NAMES.map((e, i) => [`FILTER_SLOT_NAME_${i + 1}`, `Slot ${i + 1}`, e] as never))

	protected readonly properties: readonly SimulatorProperty[] = [this.#position, this.#names]
	protected propertiesToNotSave: readonly SimulatorProperty[] = [this.#position]

	#moveTimer?: NodeJS.Timeout

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.FILTER)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'filterwheel.simulator'
	}

	// Handles the filter-name text command (renaming slots).
	sendText(vector: NewTextVector) {
		super.sendText(vector)

		if (vector.name === 'FILTER_NAME' && applyTextVectorValues(this.#names, vector.elements)) {
			this.notify(this.#names)
		}
	}

	// Handles the filter-slot number command (move to slot).
	sendNumber(vector: NewNumberVector) {
		if (vector.name === 'FILTER_SLOT' && vector.elements.FILTER_SLOT_VALUE !== undefined) {
			this.moveTo(vector.elements.FILTER_SLOT_VALUE)
		}
	}

	// Handles the connection switch.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		if (vector.name === 'CONNECTION') {
			if (vector.elements.CONNECT === true) this.connect()
			else if (vector.elements.DISCONNECT === true) this.disconnect()
		}
	}

	// Disconnects the simulated filter wheel and removes its dynamic properties.
	disconnect() {
		if (!this.isConnected) return

		if (this.#moveTimer) {
			clearTimeout(this.#moveTimer)
			this.#moveTimer = undefined
		}

		this.#position.state = 'Idle'

		super.disconnect()
	}

	// Disposes the filter wheel simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts a slot change with a short time-based delay.
	moveTo(slot: number) {
		if (!this.isConnected) return

		slot = clamp(Math.round(slot), this.#position.elements.FILTER_SLOT_VALUE.min, this.#position.elements.FILTER_SLOT_VALUE.max)
		const current = this.#position.elements.FILTER_SLOT_VALUE.value
		if (slot === current) return

		if (this.#moveTimer) {
			clearTimeout(this.#moveTimer)
			this.#moveTimer = undefined
		}

		this.#position.state = 'Busy'
		this.notify(this.#position)

		this.#moveTimer = setTimeout(
			() => {
				this.#moveTimer = undefined
				this.#position.elements.FILTER_SLOT_VALUE.value = slot
				this.#position.state = 'Idle'
				this.notify(this.#position)
			},
			Math.max(150, Math.abs(slot - current) * FILTER_WHEEL_MOVE_TIME_MS),
		)
	}
}
