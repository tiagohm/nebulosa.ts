import { handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetNumberVector, handleSetSwitchVector, handleSetTextVector, type IndiClientHandler } from '../client'
import { DeviceInterfaceType, type DeviceType } from '../device'
import { makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector, selectOnSwitch } from '../types'
import type { ClientSimulator } from './client'
import { GENERAL_INFO, MAIN_CONTROL } from './constants'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'
import { applyTextVectorValues, sendDefinition } from './util'

// Base lifecycle, persistence, connection, and notification behavior for simulated INDI devices.

// Base class for all device simulators. Owns the common driver-info/connection/snoop/config vectors and
// the connect/disconnect, property save/load, and notify plumbing; subclasses add their own properties
// and tick logic. Disposable to detach from the client.
export abstract class DeviceSimulator implements Disposable {
	abstract readonly type: DeviceType

	// Driver/connection/snoop/config property vectors common to every simulated device.
	protected readonly driverInfo = makeTextVector('', 'DRIVER_INFO', 'Driver Info', GENERAL_INFO, 'ro', ['DRIVER_INTERFACE', 'Interface', ''], ['DRIVER_EXEC', 'Exec', ''], ['DRIVER_VERSION', 'Version', '1.0'], ['DRIVER_NAME', 'Name', ''])
	protected readonly connection = makeSwitchVector('', 'CONNECTION', 'Connection', MAIN_CONTROL, 'OneOfMany', 'rw', ['CONNECT', 'Connect', false], ['DISCONNECT', 'Disconnect', true])
	protected readonly snoopDevices = makeTextVector('', 'ACTIVE_DEVICES', 'Snoop devices', MAIN_CONTROL, 'rw', ['ACTIVE_TELESCOPE', 'Mount', ''], ['ACTIVE_FOCUSER', 'Focuser', ''], ['ACTIVE_FILTER', 'Filter Wheel', ''], ['ACTIVE_ROTATOR', 'Rotator', ''])
	protected readonly config = makeSwitchVector('', 'CONFIG', 'Config', MAIN_CONTROL, 'AtMostOne', 'rw', ['LOAD', 'Load', false], ['SAVE', 'Save', false])

	// Subclass-supplied: all owned properties, those excluded from persistence, and the persistence hooks.
	protected abstract readonly properties: readonly SimulatorProperty[]
	protected abstract readonly propertiesToNotSave: readonly SimulatorProperty[]
	protected abstract readonly options?: DeviceSimulatorOptions

	constructor(
		readonly name: string,
		readonly client: ClientSimulator,
		readonly handler: IndiClientHandler,
		interfaceType: DeviceInterfaceType,
	) {
		this.driverInfo.device = name
		this.driverInfo.elements.DRIVER_INTERFACE.value = interfaceType.toFixed(0)
		this.driverInfo.elements.DRIVER_NAME.value = name
		this.connection.device = name
		this.snoopDevices.device = name
		this.config.device = name
		client.register(this)

		handleDefTextVector(client, handler, this.driverInfo)
		handleDefSwitchVector(client, handler, this.connection)
		handleDefTextVector(client, handler, this.snoopDevices)
		handleDefSwitchVector(client, handler, this.config)
	}

	// Whether the simulated device's connection switch is on.
	get isConnected() {
		return this.connection.elements.CONNECT.value
	}

	// Base text handling: updates the snooped-device names. Subclasses override and call super.
	sendText(vector: NewTextVector) {
		switch (vector.name) {
			case 'ACTIVE_DEVICES':
				applyTextVectorValues(this.snoopDevices, vector.elements) && this.notify(this.snoopDevices)
		}
	}

	abstract sendNumber(vector: NewNumberVector): void

	// Base switch handling: the CONFIG load/save action. Subclasses override and call super.
	sendSwitch(vector: NewSwitchVector) {
		switch (vector.name) {
			case 'CONFIG':
				if (vector.elements.LOAD === true) void this.loadProperties()
				else if (vector.elements.SAVE === true) this.saveProperties()
		}
	}

	// Deletes the device's properties and unregisters from the client.
	dispose() {
		this.handler.delProperty?.(this.client, { device: this.name })
		this.client.unregister(this)
	}

	// Connects the simulated device.
	connect() {
		if (this.isConnected) return
		selectOnSwitch(this.connection, 'CONNECT') && handleSetSwitchVector(this.client, this.handler, this.connection)
		if (!this.isConnected) return

		for (const property of this.properties) {
			sendDefinition(this.client, this.handler, property)
		}

		void this.loadProperties()
	}

	// Disconnects the simulated device.
	disconnect() {
		if (!this.isConnected) return
		selectOnSwitch(this.connection, 'DISCONNECT') && handleSetSwitchVector(this.client, this.handler, this.connection)

		for (const property of this.properties) {
			handleDelProperty(this.client, this.handler, property as never)
		}
	}

	// Emits a set* event for a property, dispatching by its vector type.
	protected notify(message: SimulatorProperty) {
		const type = message.type[0]

		if (type === 'S') handleSetSwitchVector(this.client, this.handler, message as never)
		else if (type === 'N') handleSetNumberVector(this.client, this.handler, message as never)
		else if (type === 'T') handleSetTextVector(this.client, this.handler, message as never)
	}

	// Persists the savable properties via the save hook, if provided.
	saveProperties() {
		if (this.options?.save) {
			const properties = this.properties.filter((e) => !this.propertiesToNotSave.includes(e))
			this.options.save(this.name, properties)
		}
	}

	// Loads persisted property values via the load hook and applies any that changed, skipping
	// non-persisted properties.
	async loadProperties() {
		if (this.options?.load) {
			const properties = await this.options.load(this.name)

			for (const property of properties) {
				const actual = this.properties.find((e) => e.name === property.name)
				if (actual === undefined || this.propertiesToNotSave.includes(actual)) continue
				let updated = false

				for (const key in actual.elements) {
					const value = property.elements[key]
					if (value === undefined) continue
					const actualElement = actual.elements[key]

					if (actualElement.value !== value.value) {
						actualElement.value = value.value
						updated = true
					}
				}

				updated && this.notify(actual)
			}
		}
	}

	[Symbol.dispose]() {
		this.dispose()
	}
}
