import type { IndiClientHandler } from '../client'
import type { Client } from '../device'
import type { EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector } from '../types'
import type { DeviceSimulator } from './device'

// In-process INDI client routing manager commands to registered device simulators.

// Minimal in-process Client that routes manager commands to the registered device simulators by name and
// owns their lifecycle. Property definitions are pushed by the simulators rather than pulled.
// Routes MountManager commands back into the simulator.
export class ClientSimulator implements Client {
	readonly type = 'SIMULATOR'

	readonly #devices = new Map<string, DeviceSimulator>()

	constructor(
		readonly id: string,
		readonly handler: IndiClientHandler,
		readonly description: string = 'Client Simulator',
	) {}

	// Simulators push their definitions; there is nothing to pull.
	getProperties(command?: GetProperties) {}

	// BLOB streaming is always on in the simulator.
	enableBlob(command: EnableBlob) {}

	// Routes a text/number/switch command to the matching device simulator by name.
	sendText(vector: NewTextVector) {
		for (const device of this.#devices.values()) device.name === vector.device && device.sendText(vector)
	}

	sendNumber(vector: NewNumberVector) {
		for (const device of this.#devices.values()) device.name === vector.device && device.sendNumber(vector)
	}

	sendSwitch(vector: NewSwitchVector) {
		for (const device of this.#devices.values()) device.name === vector.device && device.sendSwitch(vector)
	}

	// Returns the simulator registered under a device name, when available.
	get(name: string) {
		return this.#devices.get(name)
	}

	// Registers/unregisters a device simulator under its name.
	register(device: DeviceSimulator) {
		this.#devices.set(device.name, device)
	}

	unregister(device: DeviceSimulator) {
		this.#devices.delete(device.name)
	}

	[Symbol.dispose]() {
		for (const device of this.#devices.values()) device.dispose()
		this.#devices.clear()
	}
}
