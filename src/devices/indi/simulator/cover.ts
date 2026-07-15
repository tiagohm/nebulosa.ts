import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { makeSwitchVector, type NewNumberVector, type NewSwitchVector, selectOnSwitch } from '../types'
import type { ClientSimulator } from './client'
import { COVER_MOVE_TIME_MS, MAIN_CONTROL } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'

// Simulated telescope cover parking, unparking, and abort behavior.

// Simulated telescope cover/dust cap; models a timed open (unpark)/close (park) with abort.
export class CoverSimulator extends DeviceSimulator {
	readonly type = 'cover'

	readonly #park = makeSwitchVector('', 'CAP_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #abort = makeSwitchVector('', 'CAP_ABORT', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	protected readonly properties: readonly SimulatorProperty[] = [this.#park, this.#abort]
	protected propertiesToNotSave: readonly SimulatorProperty[] = this.properties

	#moveTimer?: NodeJS.Timeout

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.DUSTCAP)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'dustcap.simulator'
	}

	// The cover has no number properties.
	sendNumber(vector: NewNumberVector) {}

	// Handles cover switch commands: connection, park (close)/unpark (open), and abort.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'CAP_PARK':
				if (vector.elements.PARK === true) this.park()
				else if (vector.elements.UNPARK === true) this.unpark()
				return
			case 'CAP_ABORT':
				if (vector.elements.ABORT === true) this.stop()
		}
	}

	// Disconnects the simulated dust cap and removes its dynamic properties.
	disconnect() {
		if (!this.isConnected) return

		this.stop(false)
		super.disconnect()
	}

	// Disposes the dust-cap simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts closing the dust cap.
	park() {
		if (!this.isConnected || this.#park.state === 'Busy' || this.#park.elements.PARK.value) return
		this.#startParkTransition(true)
	}

	// Starts opening the dust cap.
	unpark() {
		if (!this.isConnected || this.#park.state === 'Busy' || this.#park.elements.UNPARK.value) return
		this.#startParkTransition(false)
	}

	// Stops any active cap transition.
	stop(alert: boolean = true) {
		const wasMoving = this.#moveTimer !== undefined
		if (this.#moveTimer) {
			clearTimeout(this.#moveTimer)
			this.#moveTimer = undefined
		}

		if (this.#park.state !== 'Idle') {
			this.#park.state = alert && wasMoving ? 'Alert' : 'Idle'
			this.notify(this.#park)
		}

		if (alert && wasMoving) {
			this.#abort.elements.ABORT.value = true
			this.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Schedules the cap open or close transition.
	#startParkTransition(parked: boolean) {
		this.stop(false)
		this.#park.state = 'Busy'
		this.notify(this.#park)

		this.#moveTimer = setTimeout(() => {
			this.#moveTimer = undefined
			selectOnSwitch(this.#park, parked ? 'PARK' : 'UNPARK')
			this.#park.state = 'Idle'
			this.notify(this.#park)
		}, COVER_MOVE_TIME_MS)
	}
}
