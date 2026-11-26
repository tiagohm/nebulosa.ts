import type { IndiClientHandler } from '../client'
import type { DeviceInterfaceType } from '../device'
import type { NewNumberVector, NewSwitchVector, NewTextVector } from '../types'
import type { ClientSimulator } from './client'
import { assignComponentDevice, type ComponentBus, componentProperties, routeNumber, routeSwitch, routeText, type SimulatorComponent, transientComponentProperties } from './component'
import { TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'

// Backplane of a simulated device built only from circuits: it defines the circuits' properties,
// routes every command to the circuit that owns it, ticks them all on one clock while connected, returns
// them to rest on disconnection and lets them rebuild after a load. A device whose circuits need more
// coupling than that keeps its own backplane, as the camera and the mount do.

// Options of a device built from circuits.
export interface BoardSimulatorOptions extends DeviceSimulatorOptions {
	// Clock of the device, milliseconds since the Unix epoch. Defaults to Date.now.
	readonly now?: () => number
}

// Simulated device whose behavior lives entirely in its circuits.
export abstract class BoardSimulator extends DeviceSimulator {
	// Where the circuits publish and read the time.
	protected readonly bus: ComponentBus
	// Clock of the device, milliseconds.
	readonly #now: () => number
	#components: readonly SimulatorComponent[] = []
	#properties: readonly SimulatorProperty[] = []
	#transient: readonly SimulatorProperty[] = []
	#timer?: NodeJS.Timeout

	// `interfaceType` and `driverExecutable` describe the driver; `now` is the clock of the device.
	constructor(name: string, client: ClientSimulator, handler: IndiClientHandler, interfaceType: DeviceInterfaceType, driverExecutable: string, now: () => number = Date.now) {
		super(name, client, handler, interfaceType, driverExecutable)
		this.#now = now
		this.bus = { notify: (property) => this.notify(property), now }
	}

	protected get properties() {
		return this.#properties
	}

	protected get propertiesToNotSave() {
		return this.#transient
	}

	// Installs the circuits of the device, in publication and routing order. Called once by the
	// subclass constructor.
	protected install(...components: SimulatorComponent[]) {
		this.#components = components
		assignComponentDevice(components, this.name)
		this.#properties = componentProperties(components)
		this.#transient = transientComponentProperties(components)
	}

	// Publishes a property, except one of the circuits' while disconnected: disconnection deleted those,
	// and a client applies a set vector whether or not it saw the definition, so a command that still
	// reaches a circuit must not repopulate them. The common properties stay defined across a
	// disconnection and keep publishing, so their acknowledgements are never lost.
	protected notify(message: SimulatorProperty) {
		if (this.isConnected || !this.#properties.includes(message)) super.notify(message)
	}

	// Routes a text command to the circuit that owns it.
	sendText(vector: NewTextVector) {
		super.sendText(vector)
		routeText(this.#components, vector)
	}

	// Routes a number command to the circuit that owns it.
	sendNumber(vector: NewNumberVector) {
		routeNumber(this.#components, vector)
	}

	// Handles connection and configuration, then routes the command to the circuit that owns it.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		if (vector.name === 'CONNECTION') {
			if (vector.elements.CONNECT === true) this.connect()
			else if (vector.elements.DISCONNECT === true) this.disconnect()
			return
		}

		routeSwitch(this.#components, vector)
	}

	// Connects the device and starts ticking its circuits.
	connect() {
		if (this.#timer) return
		super.connect()
		if (!this.isConnected) return
		this.#timer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
	}

	// Stops ticking, returns every circuit to rest and disconnects the device.
	disconnect() {
		if (!this.isConnected) return
		clearInterval(this.#timer)
		this.#timer = undefined
		for (const component of this.#components) component.reset()
		super.disconnect()
	}

	// Disconnects and unregisters the device.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Advances every circuit to the clock of the device. Called by the timer while connected, and
	// directly to step a device on a manual clock.
	tick() {
		const now = this.#now()
		for (const component of this.#components) component.tick(now)
	}

	// Lets every circuit rebuild what it derived from the persisted values.
	protected onPropertiesLoaded() {
		for (const component of this.#components) component.loaded()
	}
}
