import { toMeter } from './distance'
import type { FirmataClient, FirmataClientHandler } from './firmata'
import type { Altimeter, Barometer, Hygrometer, ListenablePeripheral, Peripheral, PeripheralListener, Thermometer } from './firmata.peripheral'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleSetNumberVector, handleSetSwitchVector, type IndiClientHandler } from './indi.client'
import { type Client, DeviceInterfaceType } from './indi.device'
import { type DefNumberVector, type EnableBlob, type GetProperties, makeNumberVector, makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector, type SetNumberVector, selectOnSwitch } from './indi.types'

// Fixed adapter identifier published in DRIVER_INFO.DRIVER_EXEC for every virtual device.
const DRIVER_EXEC = 'FirmataIndiClient'

// DRIVER_INFO.DRIVER_VERSION value. Mirrors the convention used by the simulator/Alpaca wrappers.
const DRIVER_VERSION = '1.0'

// INDI property groups, matching the names used by AlpacaDevice/DeviceSimulator.
const MAIN_CONTROL = 'Main Control'
const GENERAL_INFO = 'General Info'
const WEATHER = 'Weather'

// Maximum time, in milliseconds, the adapter waits for the Firmata board initialization to complete
// before failing a connection attempt. Prevents a connect from hanging forever on a dead transport.
const DEFAULT_CONNECTION_TIMEOUT = 5000

// A single read-only measurement exposed by a virtual device. Each measurement maps one INDI number
// vector element to a scalar reading sampled from the owned peripheral.
interface FirmataMeasurement<D extends ListenablePeripheral<D>> {
	// Number vector that carries the measurement. Created with an empty device, filled on registration.
	readonly vector: DefNumberVector & SetNumberVector & { type: 'NUMBER' }
	// Name of the single element within `vector` that holds the value.
	readonly element: string
	// Reads the current value from the peripheral in the element's documented unit.
	readonly read: (peripheral: D) => number
}

// Shared, empty handler used when no consumer handler is supplied, so the def*/set* helpers can run
// without per-call null checks. All callbacks are absent and therefore behave as no-ops.
const EMPTY_HANDLER: IndiClientHandler = {}

export interface FirmataIndiClientOptions {
	// Optional consumer of the INDI events emitted by the virtual devices.
	readonly handler?: IndiClientHandler
}

// Local, event-driven INDI adapter that exposes Firmata peripherals as virtual INDI devices.
//
// It implements the INDI `Client` contract without any network transport, XML, or sensor driver
// logic: it reuses the repository's INDI vector helpers and the existing Firmata peripheral APIs.
// The structure mirrors `AlpacaClient` (a device map keyed by INDI device name plus per-device
// wrappers) and the event-driven publication style of `ClientSimulator`/`DeviceSimulator`.
export class FirmataIndiClient implements Client {
	readonly type = 'FIRMATA'
	readonly id: string
	readonly description: string

	readonly #devices = new Map<string, FirmataVirtualDevice<never>>()
	readonly #peripherals = new Set<Peripheral>()
	#ready = false
	#closed = false
	#disposed = false

	// Registered with the Firmata client to track board lifecycle. A reset/close must not leave stale
	// INDI devices or peripheral listeners behind, so both transition connected devices to a safe
	// disconnected state.
	readonly #firmataHandler: FirmataClientHandler = {
		ready: () => {
			this.#ready = true
		},
		systemReset: () => {
			this.#ready = false
			this.#handleTransportLost()
		},
		error: (_, command: number) => {
			console.warn(`Firmata reported an error for command 0x${command.toString(16).padStart(2, '0')}`)
		},
		close: () => {
			this.#ready = false
			this.#handleTransportLost()
			this.#notifyClose(true)
		},
	}

	constructor(
		readonly firmata: FirmataClient,
		readonly name: string,
		readonly options?: FirmataIndiClientOptions,
	) {
		if (!name) throw new Error('Firmata INDI client name must not be empty')

		// Deterministic, transport-agnostic identity derived from the board/client name. Firmata need
		// not be network-based, so no remote host/port metadata is invented.
		this.id = Bun.MD5.hash(`${name}:FIRMATA`, 'hex')
		this.description = `Firmata Client (${name})`

		this.firmata.addHandler(this.#firmataHandler)
	}

	// Whether the underlying Firmata board has finished its initialization handshake.
	get ready() {
		return this.#ready
	}

	// Consumer handler used by the virtual devices, or a no-op handler when none was supplied.
	get handler(): IndiClientHandler {
		return this.options?.handler ?? EMPTY_HANDLER
	}

	getProperties(command?: GetProperties) {
		if (command?.device) {
			this.#devices.get(command.device)?.sendProperties(command.name)
		} else {
			for (const device of this.#devices.values()) device.sendProperties(command?.name)
		}
	}

	// BLOBs are not produced by sensor peripherals; documented no-op required to satisfy `Client`.
	enableBlob(command: EnableBlob) {}

	sendText(vector: NewTextVector) {
		this.#devices.get(vector.device)?.sendText(vector)
	}

	sendNumber(vector: NewNumberVector) {
		this.#devices.get(vector.device)?.sendNumber(vector)
	}

	sendSwitch(vector: NewSwitchVector) {
		this.#devices.get(vector.device)?.sendSwitch(vector)
	}

	// Registers a listenable peripheral as a virtual device.
	createPeripheral<D extends ListenablePeripheral<D>>(peripheral: D) {
		const measurements: FirmataMeasurement<D>[] = []
		if (isThermometer(peripheral)) measurements.push(temperatureMeasurement<D>())
		if (isHygrometer(peripheral)) measurements.push(humidityMeasurement<D>())
		if (isBarometer(peripheral)) measurements.push(pressureMeasurement<D>())
		if (isAltimeter(peripheral)) measurements.push(altitudeMeasurement<D>())
		return this.#register(peripheral, DeviceInterfaceType.AUXILIARY, measurements)
	}

	// Generic registration path. Keeps client routing independent from the concrete peripheral so new
	// adapters can be added without rewriting it. Rejects duplicate device names and reuse of the same
	// peripheral instance to avoid one adapter stopping a peripheral another adapter still needs.
	#register<D extends ListenablePeripheral<D>>(peripheral: D, interfaceType: DeviceInterfaceType, measurements: readonly FirmataMeasurement<D>[]) {
		const { name } = peripheral
		if (!name) throw new Error('virtual device name must not be empty')
		if (this.#devices.has(name)) throw new Error(`a virtual device named "${name}" is already registered`)
		if (this.#peripherals.has(peripheral)) throw new Error(`peripheral "${peripheral.name}" is already registered with this client`)

		const device = new FirmataVirtualDevice(this, name, peripheral, interfaceType, measurements)
		this.#devices.set(name, device as never)
		this.#peripherals.add(peripheral)
		return device
	}

	// Transitions every connected virtual device to a safe disconnected state without removing it,
	// so devices are not left logically connected once the physical transport is unavailable.
	#handleTransportLost() {
		for (const device of this.#devices.values()) device.handleTransportLost()
	}

	// Emits the consumer `close` callback at most once across the whole client lifetime.
	#notifyClose(server: boolean) {
		if (this.#closed) return
		this.#closed = true
		this.options?.handler?.close?.(this, server)
	}

	// Idempotent disposal: detaches the Firmata handler, tears down every virtual device (detaching
	// peripheral listeners, stopping owned peripherals, deleting properties), clears the maps and
	// invokes `handler.close(client, false)` exactly once.
	dispose() {
		if (this.#disposed) return
		this.#disposed = true

		this.firmata.removeHandler(this.#firmataHandler)

		for (const device of this.#devices.values()) device.dispose()
		this.#devices.clear()
		this.#peripherals.clear()

		this.#notifyClose(false)
	}

	[Symbol.dispose]() {
		this.dispose()
	}
}

// Internal base wrapper for a single virtual INDI device. Owns the standard DRIVER_INFO and
// CONNECTION vectors, the dynamic measurement vectors, and the connect/disconnect/routing lifecycle.
// It is generic over the owned peripheral and reusable: future writable peripherals can extend it and
// override `sendNumber`/`sendSwitch`/`sendText` without duplicating connection or routing code.
class FirmataVirtualDevice<D extends ListenablePeripheral<D>> {
	// General Info: identifies the adapter and the virtual device.
	readonly #driverInfo = makeTextVector('', 'DRIVER_INFO', 'Driver Info', GENERAL_INFO, 'ro', ['DRIVER_INTERFACE', 'Interface', ''], ['DRIVER_EXEC', 'Exec', DRIVER_EXEC], ['DRIVER_VERSION', 'Version', DRIVER_VERSION], ['DRIVER_NAME', 'Name', ''])
	// Main Control: standard connection switch. The device starts disconnected.
	readonly #connection = makeSwitchVector('', 'CONNECTION', 'Connection', MAIN_CONTROL, 'OneOfMany', 'rw', ['CONNECT', 'Connect', false], ['DISCONNECT', 'Disconnect', true])

	// Stable listener reference so removeListener removes exactly the callback that was added.
	readonly #listener: PeripheralListener<D>
	#started = false
	#connecting = false

	constructor(
		readonly client: FirmataIndiClient,
		readonly name: string,
		readonly peripheral: D,
		interfaceType: DeviceInterfaceType,
		readonly measurements: readonly FirmataMeasurement<D>[],
	) {
		this.#listener = this.#onReading.bind(this)

		this.#driverInfo.device = name
		this.#driverInfo.elements.DRIVER_NAME.value = name
		this.#driverInfo.elements.DRIVER_INTERFACE.value = interfaceType.toFixed(0)
		this.#connection.device = name

		for (const measurement of this.measurements) {
			measurement.vector.device = name
		}

		// Publish only the general/control vectors before any connection.
		handleDefTextVector(this.client, this.handler, this.#driverInfo)
		handleDefSwitchVector(this.client, this.handler, this.#connection)
	}

	get handler() {
		return this.client.handler
	}

	get isConnected() {
		return this.#connection.elements.CONNECT.value === true
	}

	// Re-emits definitions and current values for the requested property, or all when `name` is
	// omitted, matching the behavior of the other clients.
	sendProperties(name?: string) {
		if (!name || name === this.#driverInfo.name) handleDefTextVector(this.client, this.handler, this.#driverInfo)
		if (!name || name === this.#connection.name) handleDefSwitchVector(this.client, this.handler, this.#connection)

		if (this.#started) {
			for (const measurement of this.measurements) {
				if (name && name !== measurement.vector.name) continue
				handleDefNumberVector(this.client, this.handler, measurement.vector)
				handleSetNumberVector(this.client, this.handler, measurement.vector)
			}
		}
	}

	// Sensor devices expose no writable text properties; unsupported names are ignored without
	// mutating state. Override in subclasses for future writable peripherals.
	sendText(vector: NewTextVector) {}

	// The initial sensors are read-only; unsupported writes are ignored. Override for writable ones.
	sendNumber(vector: NewNumberVector) {}

	sendSwitch(vector: NewSwitchVector) {
		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) void this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
		}
	}

	// Connects the virtual device: verifies the board is ready, starts the peripheral once, attaches
	// the listener before starting so the first reading cannot be lost, defines the measurement
	// vectors with their current values, and returns the connection to Idle. On failure it cleans up
	// partial work, marks the connection Alert and leaves the device safely disconnected.
	async connect() {
		if (this.isConnected || this.#connecting) return
		this.#connecting = true

		this.#connection.state = 'Busy'
		handleSetSwitchVector(this.client, this.handler, this.#connection)

		try {
			if (!this.client.ready) {
				const ready = await this.client.firmata.ensureInitializationIsDone(DEFAULT_CONNECTION_TIMEOUT)
				if (!ready) throw new Error(`Firmata board for "${this.name}" is not ready`)
			}

			this.peripheral.addListener(this.#listener)
			this.peripheral.start()
			this.#started = true

			for (const measurement of this.measurements) {
				measurement.vector.elements[measurement.element].value = measurement.read(this.peripheral)
				measurement.vector.state = 'Idle'
				handleDefNumberVector(this.client, this.handler, measurement.vector)
			}

			selectOnSwitch(this.#connection, 'CONNECT')
			this.#connection.state = 'Idle'
			handleSetSwitchVector(this.client, this.handler, this.#connection)
		} catch (e) {
			this.peripheral.removeListener(this.#listener)

			if (this.#started) {
				this.peripheral.stop()
				this.#started = false
			}

			selectOnSwitch(this.#connection, 'DISCONNECT')
			this.#connection.state = 'Alert'
			handleSetSwitchVector(this.client, this.handler, this.#connection)
		} finally {
			this.#connecting = false
		}
	}

	// Disconnects the virtual device: detaches the listener, stops the peripheral if this adapter
	// started it, deletes the dynamic measurement properties and returns the connection to Idle.
	disconnect(publishConnection: boolean = true) {
		if (!this.isConnected) return

		this.peripheral.removeListener(this.#listener)

		if (this.#started) {
			this.peripheral.stop()
			this.#started = false
		}

		for (const measurement of this.measurements) {
			this.handler.delProperty?.(this.client, { device: this.name, name: measurement.vector.name })
		}

		selectOnSwitch(this.#connection, 'DISCONNECT')
		this.#connection.state = 'Idle'
		if (publishConnection) handleSetSwitchVector(this.client, this.handler, this.#connection)
	}

	// Reacts to a Firmata reset/close by disconnecting if currently connected, keeping the device
	// registered but logically disconnected.
	handleTransportLost() {
		this.disconnect()
	}

	// Tears the device down completely: disconnects and removes the entire device view.
	dispose() {
		this.disconnect(false)
		this.handler.delProperty?.(this.client, { device: this.name })
	}

	// Applies a peripheral reading: updates only changed element values and publishes one
	// setNumberVector per vector that actually changed. No event is emitted when nothing changed.
	#onReading(peripheral: D) {
		for (const measurement of this.measurements) {
			const element = measurement.vector.elements[measurement.element]
			const value = measurement.read(peripheral)

			if (element.value !== value) {
				element.value = value
				handleSetNumberVector(this.client, this.handler, measurement.vector)
			}
		}
	}
}

// Builds the TEMPERATURE measurement (degrees Celsius). The peripheral is read through the marker
// interface; callers gate optional measurements with the runtime guards below.
function temperatureMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'TEMPERATURE', 'Temperature', WEATHER, 'ro', ['TEMPERATURE', 'Temperature', 0, -50, 70, 0.01, '%.2f'])
	return { vector, element: 'TEMPERATURE', read: (peripheral) => (peripheral as unknown as Thermometer).temperature }
}

// Builds the PRESSURE measurement (hPa, the project's Pressure unit).
function pressureMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'PRESSURE', 'Pressure', WEATHER, 'ro', ['PRESSURE', 'Pressure (hPa)', 0, 0, 2000, 0.01, '%.2f'])
	return { vector, element: 'PRESSURE', read: (peripheral) => (peripheral as unknown as Barometer).pressure }
}

// Builds the ALTITUDE measurement (meters, converted from the project's Distance unit in AU).
function altitudeMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'ALTITUDE', 'Altitude', WEATHER, 'ro', ['ALTITUDE', 'Altitude (m)', 0, -1000, 100000, 0.01, '%.2f'])
	return { vector, element: 'ALTITUDE', read: (peripheral) => toMeter((peripheral as unknown as Altimeter).altitude) }
}

// Builds the RELATIVE_HUMIDITY measurement (percent, 0..100).
function humidityMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'RELATIVE_HUMIDITY', 'Relative Humidity', WEATHER, 'ro', ['HUMIDITY', 'Humidity (%)', 0, 0, 100, 0.1, '%.1f'])
	return { vector, element: 'HUMIDITY', read: (peripheral) => (peripheral as unknown as Hygrometer).humidity }
}

// Narrows a peripheral to a thermometer based on its reported reading field.
function isThermometer<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Thermometer {
	return typeof (peripheral as Partial<Thermometer>).temperature === 'number'
}

// Narrows a peripheral to an altimeter based on its reported reading field.
function isAltimeter<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Altimeter {
	return typeof (peripheral as Partial<Altimeter>).altitude === 'number'
}

// Narrows a peripheral to an barometer based on its reported reading field.
function isBarometer<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Barometer {
	return typeof (peripheral as Partial<Barometer>).pressure === 'number'
}

// Narrows a peripheral to an hygrometer based on its reported reading field.
function isHygrometer<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Hygrometer {
	return typeof (peripheral as Partial<Hygrometer>).humidity === 'number'
}
