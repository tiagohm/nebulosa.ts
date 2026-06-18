import { toMeter } from './distance'
import type { FirmataClient, FirmataClientHandler } from './firmata'
import type { Accelerometer, Altimeter, Ammeter, Barometer, Gyroscope, Hygrometer, ListenablePeripheral, Luxmeter, Magnetometer, Peripheral, PeripheralListener, RealTimeClock, Thermometer } from './firmata.peripheral'
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
const SENSORS = 'Sensors'

// Maximum time, in milliseconds, the adapter waits for the Firmata board to become ready before
// failing a connection attempt. Prevents a connect from hanging forever on a dead transport. A
// non-positive timeout fails immediately when the board is not currently ready.
const DEFAULT_CONNECTION_TIMEOUT = 5000

// One element of a measurement vector, bound to the peripheral reading that fills it.
interface FirmataElementRead<D extends ListenablePeripheral<D>> {
	// Name of the element within the owning vector.
	readonly element: string
	// Reads the current value from the peripheral in the element's documented unit.
	readonly read: (peripheral: D) => number
}

// A read-only measurement exposed by a virtual device. Each measurement maps one INDI number vector
// (single- or multi-element) to scalar readings sampled from the owned peripheral.
interface FirmataMeasurement<D extends ListenablePeripheral<D>> {
	// Number vector that carries the measurement. Created with an empty device, filled on registration.
	readonly vector: DefNumberVector & SetNumberVector & { type: 'NUMBER' }
	// Element readers, one per element of `vector`.
	readonly reads: readonly FirmataElementRead<D>[]
}

// Shared, empty handler used when no consumer handler is supplied, so the def*/set* helpers can run
// without per-call null checks. All callbacks are absent and therefore behave as no-ops.
const EMPTY_HANDLER: IndiClientHandler = {}

export interface FirmataIndiClientOptions {
	// Optional consumer of the INDI events emitted by the virtual devices.
	readonly handler?: IndiClientHandler
	// Time, in milliseconds, a connect waits for the board to become ready. Defaults to
	// DEFAULT_CONNECTION_TIMEOUT. A non-positive value fails immediately when not currently ready.
	readonly connectionTimeout?: number
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
	// Resolves when the board becomes ready for the current generation. Replaced on every reset/close
	// so a connect after a reset waits for a fresh `ready` rather than reusing a stale resolution.
	#readyResolvers = Promise.withResolvers<void>()
	#closed = false
	#disposed = false

	// Registered with the Firmata client to track board lifecycle. A reset/close must not leave stale
	// INDI devices or peripheral listeners behind, so both transition connected devices to a safe
	// disconnected state and invalidate the readiness gate.
	readonly #firmataHandler: FirmataClientHandler = {
		ready: () => {
			this.#markReady()
		},
		systemReset: () => {
			this.#markNotReady()
			this.#handleTransportLost()
		},
		error: (_, command: number) => {
			console.warn(`Firmata reported an error for command 0x${command.toString(16).padStart(2, '0')}`)
		},
		close: () => {
			this.#markNotReady()
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

		// Seed readiness from the board's one-shot initialization, covering a board that became ready
		// before this adapter attached its handler. All later transitions come from the ready,
		// systemReset and close events, which keep the gate reset-aware.
		void this.firmata.ensureInitializationIsDone(0).then((ok) => ok && this.#markReady())
	}

	// Whether the underlying Firmata board is currently ready (since the last reset/close).
	get ready() {
		return this.#ready
	}

	// Resolves true once the board is ready for the current generation, or false if the configured
	// connection timeout elapses first. A non-positive timeout fails immediately when not ready. This
	// gate is reset-aware: a stale ready from a previous generation cannot satisfy a post-reset connect.
	whenReady(): Promise<boolean> {
		if (this.#ready) return Promise.resolve(true)

		const timeout = this.options?.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT
		if (timeout <= 0) return Promise.resolve(false)

		let timer: ReturnType<typeof setTimeout> | undefined
		const ready = this.#readyResolvers.promise.then(() => true)
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(resolve, timeout, false)
		})

		return Promise.race([ready, timedOut]).finally(() => clearTimeout(timer))
	}

	// Marks the board ready and unblocks any pending readiness waiters for this generation.
	#markReady() {
		if (this.#ready) return
		this.#ready = true
		this.#readyResolvers.resolve()
	}

	// Marks the board not ready and arms a fresh gate so waiters require the next `ready` event.
	#markNotReady() {
		this.#ready = false
		this.#readyResolvers = Promise.withResolvers<void>()
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

	// Registers a listenable peripheral as a virtual device, auto-detecting which vectors to publish
	// from the interfaces the peripheral implements. A real-time clock yields a writable virtual
	// device; sensors yield read-only measurement vectors.
	createPeripheral<D extends ListenablePeripheral<D>>(peripheral: D) {
		this.#ensureRegistrable(peripheral)

		const device = isRealTimeClock(peripheral) ? new RealTimeClockVirtualDevice<D>(this, peripheral.name, peripheral) : new FirmataVirtualDevice(this, peripheral.name, peripheral, sensorInterfaceType(peripheral), sensorMeasurements(peripheral))

		this.#devices.set(peripheral.name, device as never)
		this.#peripherals.add(peripheral)

		// Publish the initial definitions only after registration so a handler that auto-connects on the
		// CONNECTION definition can route the command back to this now-registered device.
		device.announce()
		return device
	}

	// Validates that a peripheral can be registered. Rejects empty names, duplicate device names and
	// reuse of the same peripheral instance, so one adapter cannot stop a peripheral another needs.
	#ensureRegistrable(peripheral: Peripheral) {
		const { name } = peripheral
		if (!name) throw new Error('virtual device name must not be empty')
		if (this.#devices.has(name)) throw new Error(`a virtual device named "${name}" is already registered`)
		if (this.#peripherals.has(peripheral)) throw new Error(`peripheral "${name}" is already registered with this client`)
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

		// Unblock any connect still waiting on readiness so it observes disposal and aborts, rather
		// than hanging until its timeout now that the firmata handler is detached.
		this.#readyResolvers.resolve()

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
	// Set when a disconnect or dispose arrives while a connect is awaiting board readiness, so the
	// in-flight connect aborts instead of starting the peripheral after the user cancelled.
	#cancelPending = false
	#disposed = false

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
	}

	get handler() {
		return this.client.handler
	}

	// Publishes the standard general/control vectors that exist before any connection. Called by the
	// client after the device is registered, so a handler that reacts to the CONNECTION definition by
	// routing a command back to this device finds it already present in the client's device map.
	announce() {
		handleDefTextVector(this.client, this.handler, this.#driverInfo)
		handleDefSwitchVector(this.client, this.handler, this.#connection)
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

			this.sendExtraProperties(name)
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

	// Hook for subclasses to define extra device-specific vectors once the device is connected.
	protected onConnect() {}

	// Hook for subclasses to delete the vectors they defined in onConnect on disconnect.
	protected onDisconnect() {}

	// Hook for subclasses to re-emit their extra vectors from getProperties while connected.
	protected sendExtraProperties(name?: string) {}

	// Connects the virtual device: verifies the board is ready, starts the peripheral once, attaches
	// the listener before starting so the first reading cannot be lost, defines the measurement
	// vectors with their current values, and returns the connection to Idle. On failure it cleans up
	// partial work, marks the connection Alert and leaves the device safely disconnected.
	async connect() {
		if (this.isConnected || this.#connecting || this.#disposed) return
		this.#connecting = true
		this.#cancelPending = false

		this.#connection.state = 'Busy'
		handleSetSwitchVector(this.client, this.handler, this.#connection)

		try {
			// Reset-aware readiness gate: after a systemReset/close this waits for a fresh ready instead
			// of reusing the board's already-resolved one-shot initialization promise.
			const ready = await this.client.whenReady()

			// A disconnect or dispose may have arrived while waiting. Honor the cancellation before
			// touching the peripheral so a late readiness resolution cannot start a cancelled device.
			if (this.#cancelPending || this.#disposed) {
				if (!this.#disposed) {
					selectOnSwitch(this.#connection, 'DISCONNECT')
					this.#connection.state = 'Idle'
					handleSetSwitchVector(this.client, this.handler, this.#connection)
				}

				return
			}

			if (!ready) throw new Error(`Firmata board for "${this.name}" is not ready`)

			this.peripheral.addListener(this.#listener)
			this.peripheral.start()
			this.#started = true

			for (const measurement of this.measurements) {
				for (const { element, read } of measurement.reads) {
					measurement.vector.elements[element].value = read(this.peripheral)
				}

				measurement.vector.state = 'Idle'
				handleDefNumberVector(this.client, this.handler, measurement.vector)
			}

			this.onConnect()

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
		// A connect awaiting board readiness is not yet connected; flag the cancellation so the pending
		// connect settles disconnected instead of starting the peripheral once it resumes.
		if (this.#connecting && !this.isConnected) {
			this.#cancelPending = true
			return
		}

		if (!this.isConnected) return

		this.peripheral.removeListener(this.#listener)

		if (this.#started) {
			this.peripheral.stop()
			this.#started = false
		}

		for (const measurement of this.measurements) {
			this.handler.delProperty?.(this.client, { device: this.name, name: measurement.vector.name })
		}

		this.onDisconnect()

		selectOnSwitch(this.#connection, 'DISCONNECT')
		this.#connection.state = 'Idle'
		if (publishConnection) handleSetSwitchVector(this.client, this.handler, this.#connection)
	}

	// Reacts to a Firmata reset/close by disconnecting if currently connected, keeping the device
	// registered but logically disconnected.
	handleTransportLost() {
		this.disconnect()
	}

	// Tears the device down completely: disconnects and removes the entire device view. Marking the
	// device disposed also aborts any connect still waiting on board readiness.
	dispose() {
		this.#disposed = true
		this.disconnect(false)
		this.handler.delProperty?.(this.client, { device: this.name })
	}

	// Applies a peripheral reading: updates only changed element values and publishes one
	// setNumberVector per vector that actually changed. No event is emitted when nothing changed.
	#onReading(peripheral: D) {
		for (const measurement of this.measurements) {
			let changed = false

			for (const { element, read } of measurement.reads) {
				const target = measurement.vector.elements[element]
				const value = read(peripheral)

				if (target.value !== value) {
					target.value = value
					changed = true
				}
			}

			if (changed) handleSetNumberVector(this.client, this.handler, measurement.vector)
		}
	}
}

// Writable virtual device for a real-time clock. Reuses the base lifecycle and exposes the clock as a
// writable TIME number vector plus a momentary TIME_SYNC switch. Writes route to the peripheral's
// update()/sync() methods; the polled readings keep TIME current through the base change detection.
class RealTimeClockVirtualDevice<D extends ListenablePeripheral<D>> extends FirmataVirtualDevice<D> {
	// Main Control: momentary switch that writes the host clock to the device.
	readonly #sync = makeSwitchVector('', 'TIME_SYNC', 'Sync', MAIN_CONTROL, 'AtMostOne', 'rw', ['SYNC', 'Sync to host clock', false])

	constructor(client: FirmataIndiClient, name: string, peripheral: D) {
		super(client, name, peripheral, DeviceInterfaceType.AUXILIARY, [timeMeasurement<D>()])
		this.#sync.device = name
	}

	// Returns the owned peripheral as a real-time clock for write routing.
	get #rtc() {
		return this.peripheral as unknown as RealTimeClock
	}

	protected onConnect() {
		handleDefSwitchVector(this.client, this.handler, this.#sync)
	}

	protected onDisconnect() {
		this.handler.delProperty?.(this.client, { device: this.name, name: this.#sync.name })
	}

	protected sendExtraProperties(name?: string) {
		if (!name || name === this.#sync.name) handleDefSwitchVector(this.client, this.handler, this.#sync)
	}

	// Writes a new date/time to the clock. Missing elements fall back to the peripheral's current
	// values through update()'s own defaults.
	sendNumber(vector: NewNumberVector) {
		if (!this.isConnected || vector.name !== 'TIME') return
		const e = vector.elements
		this.#rtc.update(e.YEAR, e.MONTH, e.DAY, e.DAY_OF_WEEK, e.HOUR, e.MINUTE, e.SECOND, e.MILLISECOND)
	}

	// Syncs the clock to the host date when TIME_SYNC is selected, then resets the momentary switch.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		if (this.isConnected && vector.name === this.#sync.name && vector.elements.SYNC === true) {
			this.#rtc.sync()
			this.#sync.elements.SYNC.value = false
			this.#sync.state = 'Ok'
			handleSetSwitchVector(this.client, this.handler, this.#sync)
		}
	}
}

// Builds the read-only sensor measurements implied by the interfaces a peripheral implements.
function sensorMeasurements<D extends ListenablePeripheral<D>>(peripheral: D): FirmataMeasurement<D>[] {
	const measurements: FirmataMeasurement<D>[] = []
	if (isThermometer(peripheral)) measurements.push(temperatureMeasurement<D>())
	if (isHygrometer(peripheral)) measurements.push(humidityMeasurement<D>())
	if (isBarometer(peripheral)) measurements.push(pressureMeasurement<D>())
	if (isAltimeter(peripheral)) measurements.push(altitudeMeasurement<D>())
	if (isAmmeter(peripheral)) measurements.push(currentMeasurement<D>())
	if (isLuxmeter(peripheral)) measurements.push(illuminanceMeasurement<D>())
	if (isAccelerometer(peripheral)) measurements.push(accelerationMeasurement<D>())
	if (isGyroscope(peripheral)) measurements.push(angularVelocityMeasurement<D>())
	if (isMagnetometer(peripheral)) measurements.push(magneticFieldMeasurement<D>())
	return measurements
}

// Picks the closest INDI interface for a sensor: WEATHER for weather-oriented quantities, otherwise AUXILIARY.
function sensorInterfaceType<D extends ListenablePeripheral<D>>(peripheral: D) {
	return isThermometer(peripheral) || isHygrometer(peripheral) || isBarometer(peripheral) || isAltimeter(peripheral) ? DeviceInterfaceType.WEATHER | DeviceInterfaceType.AUXILIARY : DeviceInterfaceType.AUXILIARY
}

// Builds the writable TIME measurement (calendar fields). Polled readings keep it current; client
// writes are routed to the peripheral by RtcVirtualDevice.
function timeMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	// oxfmt-ignore
	const vector = makeNumberVector('', 'TIME', 'Time', MAIN_CONTROL, 'rw', ['YEAR', 'Year', 0, 0, 9999, 1, '%.0f'], ['MONTH', 'Month', 1, 1, 12, 1, '%.0f'], ['DAY', 'Day', 1, 1, 31, 1, '%.0f'], ['DAY_OF_WEEK', 'Day of Week', 0, 0, 6, 1, '%.0f'], ['HOUR', 'Hour', 0, 0, 23, 1, '%.0f'], ['MINUTE', 'Minute', 0, 0, 59, 1, '%.0f'], ['SECOND', 'Second', 0, 0, 59, 1, '%.0f'], ['MILLISECOND', 'Millisecond', 0, 0, 999, 1, '%.0f'])
	return {
		vector,
		reads: [
			{ element: 'YEAR', read: (peripheral) => (peripheral as unknown as RealTimeClock).year },
			{ element: 'MONTH', read: (peripheral) => (peripheral as unknown as RealTimeClock).month },
			{ element: 'DAY', read: (peripheral) => (peripheral as unknown as RealTimeClock).day },
			{ element: 'DAY_OF_WEEK', read: (peripheral) => (peripheral as unknown as RealTimeClock).dayOfWeek },
			{ element: 'HOUR', read: (peripheral) => (peripheral as unknown as RealTimeClock).hour },
			{ element: 'MINUTE', read: (peripheral) => (peripheral as unknown as RealTimeClock).minute },
			{ element: 'SECOND', read: (peripheral) => (peripheral as unknown as RealTimeClock).second },
			{ element: 'MILLISECOND', read: (peripheral) => (peripheral as unknown as RealTimeClock).millisecond },
		],
	}
}

// Builds the TEMPERATURE measurement (degrees Celsius). The peripheral is read through the marker
// interface; callers gate optional measurements with the runtime guards below.
function temperatureMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'TEMPERATURE', 'Temperature', WEATHER, 'ro', ['TEMPERATURE', 'Temperature', 0, -50, 70, 0.01, '%.2f'])
	return { vector, reads: [{ element: 'TEMPERATURE', read: (peripheral) => (peripheral as unknown as Thermometer).temperature }] }
}

// Builds the PRESSURE measurement (hPa, the project's Pressure unit).
function pressureMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'PRESSURE', 'Pressure', WEATHER, 'ro', ['PRESSURE', 'Pressure (hPa)', 0, 0, 2000, 0.01, '%.2f'])
	return { vector, reads: [{ element: 'PRESSURE', read: (peripheral) => (peripheral as unknown as Barometer).pressure }] }
}

// Builds the ALTITUDE measurement (meters, converted from the project's Distance unit in AU).
function altitudeMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'ALTITUDE', 'Altitude', WEATHER, 'ro', ['ALTITUDE', 'Altitude (m)', 0, -1000, 100000, 0.01, '%.2f'])
	return { vector, reads: [{ element: 'ALTITUDE', read: (peripheral) => toMeter((peripheral as unknown as Altimeter).altitude) }] }
}

// Builds the RELATIVE_HUMIDITY measurement (percent, 0..100).
function humidityMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'RELATIVE_HUMIDITY', 'Relative Humidity', WEATHER, 'ro', ['HUMIDITY', 'Humidity (%)', 0, 0, 100, 0.1, '%.1f'])
	return { vector, reads: [{ element: 'HUMIDITY', read: (peripheral) => (peripheral as unknown as Hygrometer).humidity }] }
}

// Builds the CURRENT measurement (amperes).
function currentMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'CURRENT', 'Current', SENSORS, 'ro', ['CURRENT', 'Current (A)', 0, -1000, 1000, 0.001, '%.3f'])
	return { vector, reads: [{ element: 'CURRENT', read: (peripheral) => (peripheral as unknown as Ammeter).current }] }
}

// Builds the ILLUMINANCE measurement (lux).
function illuminanceMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'ILLUMINANCE', 'Illuminance', SENSORS, 'ro', ['LUX', 'Illuminance (lx)', 0, 0, 200000, 0.1, '%.1f'])
	return { vector, reads: [{ element: 'LUX', read: (peripheral) => (peripheral as unknown as Luxmeter).lux }] }
}

// Builds the ACCELERATION measurement (m/s^2 on three axes).
function accelerationMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'ACCELERATION', 'Acceleration', SENSORS, 'ro', ['ACCEL_X', 'X (m/s²)', 0, -160, 160, 0.0001, '%.4f'], ['ACCEL_Y', 'Y (m/s²)', 0, -160, 160, 0.0001, '%.4f'], ['ACCEL_Z', 'Z (m/s²)', 0, -160, 160, 0.0001, '%.4f'])
	return {
		vector,
		reads: [
			{ element: 'ACCEL_X', read: (peripheral) => (peripheral as unknown as Accelerometer).ax },
			{ element: 'ACCEL_Y', read: (peripheral) => (peripheral as unknown as Accelerometer).ay },
			{ element: 'ACCEL_Z', read: (peripheral) => (peripheral as unknown as Accelerometer).az },
		],
	}
}

// Builds the ANGULAR_VELOCITY measurement (rad/s on three axes).
function angularVelocityMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'ANGULAR_VELOCITY', 'Angular Velocity', SENSORS, 'ro', ['GYRO_X', 'X (rad/s)', 0, -40, 40, 0.00001, '%.5f'], ['GYRO_Y', 'Y (rad/s)', 0, -40, 40, 0.00001, '%.5f'], ['GYRO_Z', 'Z (rad/s)', 0, -40, 40, 0.00001, '%.5f'])
	return {
		vector,
		reads: [
			{ element: 'GYRO_X', read: (peripheral) => (peripheral as unknown as Gyroscope).gx },
			{ element: 'GYRO_Y', read: (peripheral) => (peripheral as unknown as Gyroscope).gy },
			{ element: 'GYRO_Z', read: (peripheral) => (peripheral as unknown as Gyroscope).gz },
		],
	}
}

// Builds the MAGNETIC_FIELD measurement (gauss on three axes).
function magneticFieldMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'MAGNETIC_FIELD', 'Magnetic Field', SENSORS, 'ro', ['MAG_X', 'X (G)', 0, -100, 100, 0.00001, '%.5f'], ['MAG_Y', 'Y (G)', 0, -100, 100, 0.00001, '%.5f'], ['MAG_Z', 'Z (G)', 0, -100, 100, 0.00001, '%.5f'])
	return {
		vector,
		reads: [
			{ element: 'MAG_X', read: (peripheral) => (peripheral as unknown as Magnetometer).x },
			{ element: 'MAG_Y', read: (peripheral) => (peripheral as unknown as Magnetometer).y },
			{ element: 'MAG_Z', read: (peripheral) => (peripheral as unknown as Magnetometer).z },
		],
	}
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

// Narrows a peripheral to an ammeter based on its reported reading field.
function isAmmeter<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Ammeter {
	return typeof (peripheral as Partial<Ammeter>).current === 'number'
}

// Narrows a peripheral to a luxmeter based on its reported reading field.
function isLuxmeter<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Luxmeter {
	return typeof (peripheral as Partial<Luxmeter>).lux === 'number'
}

// Narrows a peripheral to an accelerometer based on its reported reading fields.
function isAccelerometer<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Accelerometer {
	const p = peripheral as Partial<Accelerometer>
	return typeof p.ax === 'number' && typeof p.ay === 'number' && typeof p.az === 'number'
}

// Narrows a peripheral to a gyroscope based on its reported reading fields.
function isGyroscope<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Gyroscope {
	const p = peripheral as Partial<Gyroscope>
	return typeof p.gx === 'number' && typeof p.gy === 'number' && typeof p.gz === 'number'
}

// Narrows a peripheral to a magnetometer based on its reported reading fields.
function isMagnetometer<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & Magnetometer {
	const p = peripheral as Partial<Magnetometer>
	return typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number'
}

// Narrows a peripheral to a real-time clock based on its write/sync methods.
function isRealTimeClock<D extends ListenablePeripheral<D>>(peripheral: D): peripheral is D & RealTimeClock {
	const p = peripheral as Partial<RealTimeClock>
	return typeof p.year === 'number' && typeof p.month === 'number' && typeof p.day === 'number' && typeof p.dayOfWeek === 'number' && typeof p.hour === 'number' && typeof p.minute === 'number' && typeof p.second === 'number' && typeof p.update === 'function' && typeof p.sync === 'function'
}
