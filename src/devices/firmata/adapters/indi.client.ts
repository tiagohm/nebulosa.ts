import { toMeter } from '../../../math/units/distance'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleSetNumberVector, handleSetSwitchVector, type IndiClientHandler } from '../../indi/client'
import { type Client, DeviceInterfaceType } from '../../indi/device'
import { type DefNumberVector, type EnableBlob, type GetProperties, makeNumberVector, makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector, type SetNumberVector, selectOnSwitch } from '../../indi/types'
import type { FirmataClient, FirmataClientHandler } from '../firmata'
import type { Accelerometer, Altimeter, Ammeter, Barometer, Gyroscope, Hygrometer, ListenablePeripheral, Luxmeter, Magnetometer, Peripheral, PeripheralListener, RealTimeClock, Thermometer } from '../peripheral'

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
	// Optional guard for sources that are not valid immediately after start() (for example an RTC whose
	// start() only queues an I2C read, leaving zeroed calendar fields below the vector's min). When it
	// returns false the vector is published Busy with its declared defaults rather than sampled, and it
	// settles to Idle on the first reading for which this returns true.
	readonly isValid?: (peripheral: D) => boolean
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
	// Monotonic readiness generation used to ignore stale initialization seeds that settle after a
	// reset or close has invalidated the current transport.
	#readyGeneration = 0
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
			// Invalidate and re-derive readiness BEFORE disconnecting the devices. A board reset drops the
			// devices' hardware configuration, so they must disconnect and re-establish it on reconnect.
			// But disconnecting publishes DISCONNECT, and a handler that auto-reconnects from it would
			// otherwise observe whenReady() still true and start the peripheral on the just-reset board,
			// with no further transport-lost pass to tear it down. Reseeding first (which marks the board
			// not-ready until re-derived) gates any such reconnect on the fresh readiness instead.
			this.#reseedReady()
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
		this.#seedReady(this.#readyGeneration)
	}

	// Whether the underlying Firmata board is currently ready (since the last reset/close).
	get ready() {
		return this.#ready
	}

	// Resolves true once the board is ready for the current generation, or false if the configured
	// connection timeout elapses first. A non-positive timeout fails immediately when not ready. This
	// gate is reset-aware: a stale ready from a previous generation cannot satisfy a post-reset connect.
	// An optional cancel signal lets a caller abandon the wait promptly (resolving with the current
	// readiness, i.e. false while unready); racing it here also clears the timeout timer.
	whenReady(cancel?: Promise<unknown>): Promise<boolean> {
		if (this.#ready) return Promise.resolve(true)

		const timeout = this.options?.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT
		if (timeout <= 0) return Promise.resolve(false)

		let timer: ReturnType<typeof setTimeout> | undefined
		// Report the readiness state at settlement, not an unconditional true: #markNotReady() resolves
		// the gate on reset/close to unblock waiters, and they must observe that the board is no longer
		// ready rather than proceeding as if it were usable.
		const ready = this.#readyResolvers.promise.then(() => this.#ready)
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(resolve, timeout, false)
		})

		const candidates = cancel ? [ready, timedOut, cancel.then(() => this.#ready)] : [ready, timedOut]
		return Promise.race(candidates).finally(() => clearTimeout(timer))
	}

	// Marks the board ready and unblocks any pending readiness waiters for this generation. A disposed
	// adapter stays permanently unready: the seed/reseed callbacks are async and may resolve after
	// disposal, but the Firmata handler is detached and new registrations are rejected, so it must never
	// report ready again.
	#markReady() {
		if (this.#ready || this.#disposed) return
		this.#ready = true
		// A new ready generation re-arms close notification: a previous transport close consumed the
		// one-shot guard, but a reconnected transport that closes again must notify consumers (so they
		// remove the second generation's devices/properties). Disposal stays terminal via #disposed.
		const reconnected = this.#closed
		this.#closed = false

		// A transport close prompts consumers (for example DeviceManager.close()) to drop this client's
		// devices and their properties. A fresh ready after such a close must re-announce the registered
		// devices so those consumers rediscover them; otherwise a later device.connect() would route
		// set/measurement messages to handlers that no longer know the device. A systemReset does not
		// drop devices (it leaves #closed false), so it needs no reannounce. Done before waking the
		// readiness waiters so definitions precede any resumed connect.
		if (reconnected) {
			for (const device of this.#devices.values()) device.announce()
		}

		this.#readyResolvers.resolve()
	}

	// Marks the board not ready and arms a fresh gate so waiters require the next `ready` event.
	// Settles the outgoing gate before replacing it: a whenReady() already racing the previous
	// generation would otherwise be orphaned and only unblock at its timeout. Waiters resumed this way
	// re-check cancellation/disposal (a reset/close always cancels in-flight connects), so an unready
	// board is never treated as connectable.
	#markNotReady() {
		this.#readyGeneration++
		this.#ready = false
		this.#readyResolvers.resolve()
		this.#readyResolvers = Promise.withResolvers<void>()
	}

	// Replays the Firmata client's initialization state for a specific readiness generation. If a
	// reset/close advances the generation before this async seed settles, the result is stale and must
	// not mark a closed or reset transport ready again.
	#seedReady(generation: number) {
		void this.firmata.ensureInitializationIsDone(0).then((ok) => {
			if (ok && generation === this.#readyGeneration) this.#markReady()
		})
	}

	// Re-derives readiness from the Firmata client after a board reset. Invalidates the current gate
	// (waking any in-flight waiter) and re-seeds from the client's initialization: a still-initialized
	// client resolves it immediately, keeping the adapter usable, while a board that genuinely
	// re-initializes settles it when its next ready arrives. Either way a reconnect is not stranded.
	#reseedReady() {
		this.#markNotReady()
		this.#seedReady(this.#readyGeneration)
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

		const rtc = isRealTimeClock(peripheral)
		const measurements = sensorMeasurements(peripheral)
		if (!rtc && measurements.length === 0) throw new Error(`peripheral "${peripheral.name}" does not expose supported INDI measurements`)

		const device = rtc ? new RealTimeClockVirtualDevice<D>(this, peripheral.name, peripheral) : new FirmataVirtualDevice(this, peripheral.name, peripheral, sensorInterfaceType(peripheral), measurements)

		this.#devices.set(peripheral.name, device as never)
		this.#peripherals.add(peripheral)

		// Publish the initial definitions only after registration so a handler that auto-connects on the
		// CONNECTION definition can route the command back to this now-registered device.
		device.announce()
		return device
	}

	// Removes a virtual device's registrations. Called by the device's own disposal so a disposed device
	// is no longer announced by getProperties and its name/peripheral become available again. Guarded so
	// it only clears entries that still belong to the given device.
	unregister<D extends ListenablePeripheral<D>>(device: FirmataVirtualDevice<D>) {
		if (this.#devices.get(device.name) === (device as never)) {
			this.#devices.delete(device.name)
			this.#peripherals.delete(device.peripheral)
		}
	}

	// Validates that a peripheral can be registered. Rejects empty names, duplicate device names, reuse
	// of the same peripheral instance, and peripherals bound to a different Firmata client. The last
	// check matters because connect()/readiness are gated on this.firmata while start() writes to
	// peripheral.client: a mismatch would drive one board yet observe another's reset/close, leaving
	// the INDI device logically connected to unavailable hardware.
	#ensureRegistrable(peripheral: Peripheral) {
		const { name } = peripheral
		// A disposed client has detached its Firmata handler and no longer observes board reset/close, so
		// a device registered now could connect and drive hardware the adapter can never clean up.
		if (this.#disposed) throw new Error('client has been disposed')
		if (!name) throw new Error('virtual device name must not be empty')
		if (peripheral.client !== this.firmata) throw new Error(`peripheral "${name}" belongs to a different Firmata client`)
		if (this.#devices.has(name)) throw new Error(`a virtual device named "${name}" is already registered`)
		if (this.#peripherals.has(peripheral)) throw new Error(`peripheral "${name}" is already registered with this client`)
	}

	// Transitions every connected virtual device to a safe disconnected state without removing it,
	// so devices are not left logically connected once the physical transport is unavailable.
	#handleTransportLost() {
		for (const device of this.#devices.values()) device.handleTransportLost()
	}

	// Emits the consumer `close` callback once per ready generation: the guard collapses a close
	// followed by a dispose into a single notification, but a fresh ready (#markReady) re-arms it so a
	// reconnected transport's later close notifies again.
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

		// Each device.dispose() unregisters itself, deleting its own (current) entry; Map iteration
		// tolerates that, and the clear() below covers any that did not.
		for (const device of this.#devices.values()) device.dispose()
		this.#devices.clear()
		this.#peripherals.clear()

		// Unblock any connect still waiting on readiness so it observes disposal and aborts, rather
		// than hanging until its timeout now that the firmata handler is detached. Clearing #ready first
		// makes whenReady() resolve false for those waiters: a disposed client is never usable.
		this.#ready = false
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
	// Set when CONNECT is requested again while a canceled connect is still unwinding, preserving the
	// user's latest command instead of letting the older DISCONNECT cancellation win.
	#reconnectPending = false
	#disposed = false
	// Signal raced against the readiness wait so a cancellation wakes connect() immediately rather than
	// leaving CONNECTION Busy until a later ready event or the full connection timeout.
	#cancel?: ReturnType<typeof Promise.withResolvers<void>>

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
		if (this.isConnected || this.#disposed) return
		if (this.#connecting) {
			if (this.#cancelPending) this.#reconnectPending = true
			return
		}

		this.#connecting = true
		this.#cancelPending = false
		this.#reconnectPending = false
		this.#cancel = Promise.withResolvers<void>()

		try {
			this.#connection.state = 'Busy'
			handleSetSwitchVector(this.client, this.handler, this.#connection)

			// Reset-aware readiness gate: after a systemReset/close this waits for a fresh ready instead
			// of reusing the board's already-resolved one-shot initialization promise. The cancel signal
			// is raced in so a disconnect/dispose wakes this wait at once instead of lingering Busy.
			const ready = await this.client.whenReady(this.#cancel.promise)

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

			// Attach the listener and publish every definition (Busy) before start(). Marking started
			// here also ensures a throw mid-start (several peripherals register their Firmata
			// handler/reports before their first transport write) triggers cleanup in the catch below.
			this.peripheral.addListener(this.#listener)
			this.#started = true

			for (const measurement of this.measurements) {
				// start() only queues asynchronous reads on real peripherals, whose reading fields are
				// still zero until the first reply. Publish every vector Busy and let #onReading settle it
				// to Idle on the first listener event, so a bogus 0 is never announced as a valid reading.
				// Vectors with an isValid guard that is not yet satisfied keep their declared in-range
				// defaults instead of sampling out-of-range zeros (e.g. an RTC's MONTH/DAY).
				if (canSampleMeasurement(measurement, this.peripheral)) {
					for (const { element, read } of measurement.reads) {
						measurement.vector.elements[element].value = read(this.peripheral)
					}
				}

				measurement.vector.state = 'Busy'
				handleDefNumberVector(this.client, this.handler, measurement.vector)
			}

			this.onConnect()

			// A handler reacting to a definition (a measurement or TIME_SYNC) may have already requested
			// disconnect/dispose. Honor it before start() so a canceled device never has its hardware
			// configured. start() has not run, so undo without stopping the peripheral.
			if (this.#cancelPending || this.#disposed) {
				this.#started = false
				this.#teardown(!this.#disposed)
				return
			}

			// Start only after the definitions exist, so a peripheral that emits its first reading
			// synchronously inside start() delivers it to already-defined vectors: #onReading then
			// settles them to Idle (def before set) instead of a set racing ahead of the def and the
			// vector being left stuck Busy.
			this.peripheral.start()

			// A disconnect or dispose may have arrived while publishing definitions or during start()
			// (handlers and synchronous readings can re-enter). Roll the started peripheral back instead
			// of reporting connected, since everything after the await ran synchronously.
			if (this.#cancelPending || this.#disposed) {
				this.#teardown(!this.#disposed)
				return
			}

			selectOnSwitch(this.#connection, 'CONNECT')
			this.#connection.state = 'Idle'
			handleSetSwitchVector(this.client, this.handler, this.#connection)

			// Publishing the connected state can synchronously re-enter via a handler that disconnects or
			// disposes the device. #connecting is still set, so disconnect() only flagged the request;
			// honor it here as the final check rather than leaving the peripheral started and connected.
			if (this.#cancelPending || this.#disposed) {
				this.#teardown(!this.#disposed)
			}
		} catch (e) {
			// Roll back whatever was set up (listener, peripheral, published definitions) when the
			// connect reached the start/definition phase; a pre-start failure (not ready) started none.
			if (this.#started) this.#teardown(false)

			selectOnSwitch(this.#connection, 'DISCONNECT')
			this.#connection.state = 'Alert'
			handleSetSwitchVector(this.client, this.handler, this.#connection)
		} finally {
			const reconnect = this.#reconnectPending && !this.#disposed && !this.isConnected
			this.#connecting = false
			this.#cancel = undefined
			if (reconnect) void this.connect()
		}
	}

	// Disconnects the virtual device. While a connect is in flight (its only await is whenReady(), so
	// everything after runs synchronously, including the definition phase where handlers may re-enter
	// here) it just flags the cancellation and lets connect() roll back consistently at its checks.
	// Otherwise it tears down an established connection.
	disconnect(publishConnection: boolean = true) {
		this.#reconnectPending = false
		if (this.#connecting) {
			this.#cancelPending = true
			this.#cancel?.resolve()
			return
		}

		if (!this.isConnected) return

		this.#teardown(publishConnection)
	}

	// Tears down an active or partially-established connection: detaches the listener, stops the
	// peripheral if it was started, deletes the dynamic measurement properties, runs onDisconnect and
	// returns the connection switch to DISCONNECT/Idle, optionally publishing it.
	#teardown(publishConnection: boolean) {
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

	// Tears the device down completely: disconnects, removes the entire device view and unregisters
	// from the owning client so it is no longer announced and its name/peripheral can be reused.
	// Marking the device disposed also aborts any connect still waiting on board readiness. Idempotent.
	dispose() {
		if (this.#disposed) return
		this.#disposed = true
		this.disconnect(false)
		this.handler.delProperty?.(this.client, { device: this.name })
		this.client.unregister(this)
	}

	// Applies a peripheral reading: updates only changed element values and publishes one
	// setNumberVector per vector that actually changed. No event is emitted when nothing changed.
	#onReading(peripheral: D) {
		for (const measurement of this.measurements) {
			// Ignore any reading a measurement deems invalid, not just while still Busy: before the first
			// valid sample this keeps the vector Busy, and afterwards it rejects a later corrupt frame (for
			// example a DS3231/DS1307 frame decoding month/day as 0, outside the vector range) instead of
			// publishing out-of-range values. The vector keeps its last valid values.
			if (!canSampleMeasurement(measurement, peripheral)) continue

			let changed = false

			for (const { element, read } of measurement.reads) {
				const target = measurement.vector.elements[element]
				const value = read(peripheral)

				if (target.value !== value) {
					target.value = value
					changed = true
				}
			}

			// Settle the vector to Idle on its first reading, confirming the value came from hardware.
			if (measurement.vector.state === 'Busy') {
				measurement.vector.state = 'Idle'
				changed = true
			}

			if (changed) {
				handleSetNumberVector(this.client, this.handler, measurement.vector)
				if (!this.#started || this.#disposed) return
			}
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

	// The single TIME measurement vector owned by this device.
	get #timeVector() {
		return this.measurements[0].vector
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

	// Writes a new date/time to the clock. Omitted elements fall back to the TIME vector's current
	// element values. Once TIME is Idle those are the hardware-confirmed values, so partial writes
	// preserve the rest of the calendar. While TIME is still a Busy placeholder (no read yet) the
	// element values are only zeroed defaults, so any omitted field would overwrite real hardware state
	// with them; in that state every hardware-backed field must be supplied and incomplete writes are
	// ignored. DAY_OF_WEEK is recomputed from the effective date (and MILLISECOND is not stored by these
	// RTCs), so neither is required.
	sendNumber(vector: NewNumberVector) {
		if (!this.isConnected || vector.name !== 'TIME') return

		const e = vector.elements

		// Before the first reading settles TIME, the vector holds placeholder zeros rather than the
		// hardware state, so a partial write would reset the unspecified fields. Require the full set of
		// hardware-backed fields (DAY_OF_WEEK is recomputable, MILLISECOND is not stored) and otherwise
		// ignore the write.
		if (this.#timeVector.state !== 'Idle' && (e.YEAR === undefined || e.MONTH === undefined || e.DAY === undefined || e.HOUR === undefined || e.MINUTE === undefined || e.SECOND === undefined)) return

		const current = this.#timeVector.elements

		const year = e.YEAR ?? current.YEAR.value
		const month = e.MONTH ?? current.MONTH.value
		const day = e.DAY ?? current.DAY.value
		const hour = e.HOUR ?? current.HOUR.value
		const minute = e.MINUTE ?? current.MINUTE.value
		const second = e.SECOND ?? current.SECOND.value
		const millisecond = e.MILLISECOND ?? current.MILLISECOND.value
		if (
			!hasStoredTimeElement(e) ||
			!isValidTimeValue(this.#timeVector, 'YEAR', year) ||
			!isValidTimeValue(this.#timeVector, 'MONTH', month) ||
			!isValidTimeValue(this.#timeVector, 'DAY', day) ||
			!isValidTimeValue(this.#timeVector, 'HOUR', hour) ||
			!isValidTimeValue(this.#timeVector, 'MINUTE', minute) ||
			!isValidTimeValue(this.#timeVector, 'SECOND', second) ||
			!isValidTimeValue(this.#timeVector, 'MILLISECOND', millisecond) ||
			!isValidCalendarDate(year, month, day)
		)
			return

		const dayOfWeek = weekdayOf(year, month, day)

		this.#rtc.update(year, month, day, dayOfWeek, hour, minute, second, millisecond)

		// The DS3231/DS1307 drivers only fire a listener event when a confirmation read changes a cached
		// field, so writing the current time (or any value the next read echoes back) would never settle
		// the submitted vector, which INDI clients hold Busy until a set update arrives. Acknowledge the
		// accepted write directly by adopting the effective values and publishing them. The state settles
		// to Idle (the vector's confirmed steady state, which partial-write logic keys on) since the
		// values are now known; a later differing hardware reading still updates through #onReading.
		current.YEAR.value = year
		current.MONTH.value = month
		current.DAY.value = day
		current.DAY_OF_WEEK.value = dayOfWeek
		current.HOUR.value = hour
		current.MINUTE.value = minute
		current.SECOND.value = second
		current.MILLISECOND.value = millisecond
		this.#timeVector.state = 'Idle'
		handleSetNumberVector(this.client, this.handler, this.#timeVector)
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

// Checks whether every element can be sampled without publishing non-finite or out-of-range values.
// The optional measurement guard handles device-specific validity, while the vector bounds provide a
// final public-output boundary for all sensor and RTC readings.
function canSampleMeasurement<D extends ListenablePeripheral<D>>(measurement: FirmataMeasurement<D>, peripheral: D) {
	if (measurement.isValid && !measurement.isValid(peripheral)) return false

	for (const { element, read } of measurement.reads) {
		const value = read(peripheral)
		const { min, max } = measurement.vector.elements[element]
		if (!Number.isFinite(value) || value < min || value > max) return false
	}

	return true
}

// Computes the day of week (0=Sunday..6=Saturday) for a calendar date, matching Date.getDay() and the
// project's RTC weekday convention. setFullYear avoids the Date constructor remapping years 0..99 into
// 1900..1999. year is the full year, month is 1..12, day is 1..31.
function weekdayOf(year: number, month: number, day: number) {
	const date = new Date(year, month - 1, day)
	date.setFullYear(year)
	return date.getDay()
}

// Whether a TIME write includes at least one field stored by DS3231/DS1307 hardware. DAY_OF_WEEK is
// derived from the date, and MILLISECOND is not stored by these RTCs, so either field alone is a no-op.
function hasStoredTimeElement(elements: NewNumberVector['elements']) {
	return elements.YEAR !== undefined || elements.MONTH !== undefined || elements.DAY !== undefined || elements.HOUR !== undefined || elements.MINUTE !== undefined || elements.SECOND !== undefined
}

// Validates one integer TIME value against the advertised vector bounds before it reaches RTC BCD
// encoding. This rejects non-finite, fractional, and out-of-range client writes.
function isValidTimeValue(vector: DefNumberVector, element: string, value: number) {
	const { min, max } = vector.elements[element]
	return Number.isInteger(value) && value >= min && value <= max
}

// Validates the effective calendar date without allowing JavaScript Date normalization (for example
// February 31 becoming March 2) to turn an invalid client write into a different hardware date.
function isValidCalendarDate(year: number, month: number, day: number) {
	const date = new Date(year, month - 1, day)
	date.setFullYear(year)
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

// Builds the writable TIME measurement (calendar fields). Polled readings keep it current; client
// writes are routed to the peripheral by RtcVirtualDevice.
function timeMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	// oxfmt-ignore
	const vector = makeNumberVector('', 'TIME', 'Time', MAIN_CONTROL, 'rw', ['YEAR', 'Year', 0, 0, 9999, 1, '%.0f'], ['MONTH', 'Month', 1, 1, 12, 1, '%.0f'], ['DAY', 'Day', 1, 1, 31, 1, '%.0f'], ['DAY_OF_WEEK', 'Day of Week', 0, 0, 6, 1, '%.0f'], ['HOUR', 'Hour', 0, 0, 23, 1, '%.0f'], ['MINUTE', 'Minute', 0, 0, 59, 1, '%.0f'], ['SECOND', 'Second', 0, 0, 59, 1, '%.0f'], ['MILLISECOND', 'Millisecond', 0, 0, 999, 1, '%.0f'])
	const reads: FirmataElementRead<D>[] = [
		{ element: 'YEAR', read: (peripheral) => (peripheral as unknown as RealTimeClock).year },
		{ element: 'MONTH', read: (peripheral) => (peripheral as unknown as RealTimeClock).month },
		{ element: 'DAY', read: (peripheral) => (peripheral as unknown as RealTimeClock).day },
		{ element: 'DAY_OF_WEEK', read: (peripheral) => (peripheral as unknown as RealTimeClock).dayOfWeek },
		{ element: 'HOUR', read: (peripheral) => (peripheral as unknown as RealTimeClock).hour },
		{ element: 'MINUTE', read: (peripheral) => (peripheral as unknown as RealTimeClock).minute },
		{ element: 'SECOND', read: (peripheral) => (peripheral as unknown as RealTimeClock).second },
		{ element: 'MILLISECOND', read: (peripheral) => (peripheral as unknown as RealTimeClock).millisecond },
	]

	return {
		vector,
		reads,
		// Accept a frame only when every field is finite and within its declared min/max. The clock
		// fields are zero before the first I2C read (month/day below 1), and a corrupt BCD/register frame
		// can decode an impossible weekday (-1), month (13) or day (45); either way TIME stays at its
		// in-range defaults and Busy rather than publishing out-of-range calendar values.
		isValid: (peripheral) => {
			for (const { element, read } of reads) {
				const value = read(peripheral)
				const { min, max } = vector.elements[element]
				if (!Number.isFinite(value) || value < min || value > max) return false
			}

			return true
		},
	}
}

// Builds the TEMPERATURE measurement (degrees Celsius). The peripheral is read through the marker
// interface; callers gate optional measurements with the runtime guards below.
function temperatureMeasurement<D extends ListenablePeripheral<D>>(): FirmataMeasurement<D> {
	const vector = makeNumberVector('', 'TEMPERATURE', 'Temperature', WEATHER, 'ro', ['TEMPERATURE', 'Temperature', 0, -55, 125, 0.01, '%.2f'])
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
	return (
		typeof p.year === 'number' &&
		typeof p.month === 'number' &&
		typeof p.day === 'number' &&
		typeof p.dayOfWeek === 'number' &&
		typeof p.hour === 'number' &&
		typeof p.minute === 'number' &&
		typeof p.second === 'number' &&
		typeof p.millisecond === 'number' &&
		typeof p.update === 'function' &&
		typeof p.sync === 'function'
	)
}
