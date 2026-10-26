import type { IndiClientHandler } from './client'
import { CLIENT, type Client, type Device } from './device'
// oxfmt-ignore
import type { DefBlobVector, DefLight, DefLightVector, DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefText, DefTextVector, DefVector, DelProperty, Message, PropertyPermission, PropertyState, SetBlobVector, SetLightVector, SetNumberVector, SetSwitchVector, SetTextVector, SetVector, SwitchRule, VectorType } from './types'

// Registry of the raw INDI property vectors of every device a client reports, whether or not a device
// manager supports its type. As an IndiClientHandler it consumes def*/set* vectors, delProperty, messages,
// and close once per client, and keeps for each device (client + driver-reported name) a copy of every
// vector with its definition metadata, the latest state, values, ranges, message, and timestamp, so the
// device managers and a generic property view read one store. Parsed messages are copied, never kept,
// because other handlers of the same client may mutate them. BLOB bytes are never retained: a BLOB element
// keeps only the format and size of its latest delivery. Records are mutated in place and handed to
// listeners and readers as live objects; a reader that keeps a snapshot copies it. Vector and element maps
// follow definition order, which holds for names that are not integer-like, the INDI convention; element
// order is also kept explicitly in elementNames.

// Driver identification of a device, from its DRIVER_INFO vector.
export interface IndiDriver {
	// Human-readable driver name (DRIVER_NAME), empty when not reported.
	readonly name: string
	// Driver executable (DRIVER_EXEC), empty when not reported.
	readonly executable: string
	// Driver version (DRIVER_VERSION), empty when not reported.
	readonly version: string
	// DRIVER_INTERFACE bit mask (DeviceInterfaceType), 0 when not reported or unreadable.
	readonly interface: number
}

// Metadata shared by every vector kind.
interface IndiPropertyBase {
	// Driver-reported device name.
	readonly device: string
	// Vector name, unique within the device.
	readonly name: string
	// Human-readable label, as the driver defined it.
	readonly label?: string
	// Group the driver places the vector in.
	readonly group?: string
	// Latest vector state.
	state: PropertyState
	// Latest message the driver attached to the vector.
	message?: string
	// Latest timestamp the driver attached to the vector, as sent (ISO 8601 UTC without zone).
	timestamp?: string
	// Element names in definition order.
	readonly elementNames: readonly string[]
	// Registry-wide revision of the last change of this vector; a redefinition gets a new one, so it never
	// repeats for a vector name.
	revision: number
}

// Metadata of a vector the client may write.
interface IndiWritablePropertyBase extends IndiPropertyBase {
	// Access permission.
	readonly permission: PropertyPermission
	// Worst-case time the driver expects to apply a change, in seconds, when it declared one.
	timeout?: number
}

// One element of a text vector.
export type IndiTextElement = DefText

// One element of a number vector, in the driver's own units, with its printf or %m format.
export type IndiNumberElement = DefNumber

// One element of a switch vector.
export type IndiSwitchElement = DefSwitch

// One element of a light vector.
export type IndiLightElement = DefLight

// One element of a BLOB vector: the metadata of its latest delivery, never its bytes.
export interface IndiBlobElement {
	// Element name.
	readonly name: string
	// Human-readable label.
	readonly label?: string
	// File name suffixes of the latest delivery, such as .fits or .fits.z.
	format?: string
	// Size of the latest delivery after decoding and decompression, in bytes.
	size?: number
	// Never present: the bytes are not kept. Declared, as on DefBlob, so every element kind reads value alike.
	readonly value?: never
}

// A text vector.
export interface IndiTextProperty extends IndiWritablePropertyBase {
	readonly type: 'TEXT'
	readonly elements: Record<string, IndiTextElement>
}

// A number vector.
export interface IndiNumberProperty extends IndiWritablePropertyBase {
	readonly type: 'NUMBER'
	readonly elements: Record<string, IndiNumberElement>
}

// A switch vector.
export interface IndiSwitchProperty extends IndiWritablePropertyBase {
	readonly type: 'SWITCH'
	// Selection rule the driver declared.
	readonly rule: SwitchRule
	readonly elements: Record<string, IndiSwitchElement>
}

// A light vector; read-only by definition.
export interface IndiLightProperty extends IndiPropertyBase {
	readonly type: 'LIGHT'
	readonly elements: Record<string, IndiLightElement>
}

// A BLOB vector.
export interface IndiBlobProperty extends IndiWritablePropertyBase {
	readonly type: 'BLOB'
	readonly elements: Record<string, IndiBlobElement>
}

// A defined property vector, discriminated by its kind.
export type IndiProperty = IndiTextProperty | IndiNumberProperty | IndiSwitchProperty | IndiLightProperty | IndiBlobProperty

// Kind of a property vector.
export type IndiPropertyType = IndiProperty['type']

// The vectors of one device keyed by name, in definition order.
export type IndiProperties = Record<string, IndiProperty>

// One device of a client as the driver reports it.
export interface IndiDevice {
	// Driver-reported device name, unique within the client.
	readonly name: string
	// Physical identity, the same hardware id the device managers give every interface of this device.
	readonly hardwareId: string
	// Vectors of the device.
	readonly properties: IndiProperties
	// Driver identification, once DRIVER_INFO is defined.
	driver?: IndiDriver
	// Whether the device reports being connected to its hardware (CONNECTION.CONNECT), when it defines
	// a CONNECTION vector.
	connected?: boolean
}

// What a set vector changed, by decreasing significance:
// - metadata: a numeric range or the timeout changed (values may have changed too);
// - feedback: the state or the message changed (values may have changed too);
// - values: only element values (or a BLOB's format and size) changed.
export type IndiPropertyChangeKind = 'metadata' | 'feedback' | 'values'

// Description of one merged set vector.
export interface IndiPropertyChange {
	// Most significant kind of change.
	readonly kind: IndiPropertyChangeKind
	// Names of the elements whose value, range, or BLOB metadata changed, in the order received.
	readonly elements: readonly string[]
}

// Receiver of the registry's changes. Every callback runs synchronously inside the client handler that
// caused it, after the registry state is updated.
export interface IndiPropertyListener {
	// A device was seen for the first time, with its first vector already stored.
	readonly deviceAdded?: (client: Client, device: IndiDevice) => void
	// The driver identification or the connection flag of a device changed.
	readonly deviceUpdated?: (client: Client, device: IndiDevice) => void
	// A device was removed: deleted whole, its last vector deleted, or its client closed.
	readonly deviceRemoved?: (client: Client, device: IndiDevice) => void
	// A vector was defined or redefined.
	readonly propertyDefined?: (client: Client, device: IndiDevice, property: IndiProperty) => void
	// A set vector changed a vector; a set that changed nothing is not reported.
	readonly propertyUpdated?: (client: Client, device: IndiDevice, property: IndiProperty, change: IndiPropertyChange) => void
	// One vector was deleted by name.
	readonly propertyRemoved?: (client: Client, device: IndiDevice, property: IndiProperty) => void
	// The driver sent a message addressed to a known device.
	readonly message?: (client: Client, device: IndiDevice, message: Message) => void
}

// Returns the hardware id of a device: the MD5 hex digest of its client id and driver-reported name, shared
// by every interface the driver exposes for that device and stable across reconnects to the same endpoint.
export function makeHardwareId(client: Client, name: string) {
	return Bun.MD5.hash(`${client.id}:${name}`, 'hex')
}

// Kind of the vector a def tag defines, keyed by the vector type of the tag.
const PROPERTY_TYPES: Readonly<Record<VectorType, IndiPropertyType>> = { Text: 'TEXT', Number: 'NUMBER', Switch: 'SWITCH', Light: 'LIGHT', BLOB: 'BLOB' }

// Registry of the raw property vectors of the devices of every client it handles. One instance can serve
// many clients; each client's devices are dropped when it closes.
export class IndiPropertyRegistry implements IndiClientHandler {
	// Devices of each client, keyed by driver-reported name.
	readonly #clients = new Map<Client, Map<string, IndiDevice>>()
	// Receivers of the changes.
	readonly #listeners = new Set<IndiPropertyListener>()
	// Last revision given to a vector; increases on every change of any vector.
	#revision = 0

	// Number of devices of every client.
	get length() {
		let length = 0
		for (const devices of this.#clients.values()) length += devices.size
		return length
	}

	// Registers a listener of the changes; returns a function that removes it.
	addListener(listener: IndiPropertyListener): VoidFunction {
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	// Lists the devices of a client, in the order they were first seen.
	devices(client: Client): readonly IndiDevice[] {
		const devices = this.#clients.get(client)
		return devices === undefined ? [] : Array.from(devices.values())
	}

	// Returns the device of a client with this driver-reported name or hardware id.
	device(client: Client, id: string): IndiDevice | undefined {
		const devices = this.#clients.get(client)
		if (devices === undefined) return undefined

		const named = devices.get(id)
		if (named !== undefined) return named

		for (const device of devices.values()) {
			if (device.hardwareId === id) return device
		}

		return undefined
	}

	// Returns the vector of a device of a client by name.
	property(client: Client, device: string, name: string): IndiProperty | undefined {
		return this.device(client, device)?.properties[name]
	}

	// Returns the vectors of the physical device behind a managed device (or a sub-device proxy, which
	// carries the client and name of its parent).
	get(device: Device): IndiProperties | undefined {
		const client = device[CLIENT]
		return client === undefined ? undefined : this.#clients.get(client)?.get(device.name)?.properties
	}

	// Whether the physical device behind a managed device has vectors.
	has(device: Device) {
		return this.get(device) !== undefined
	}

	// Stores a def vector or merges a set vector. A def creates its device on first sight and replaces a
	// vector of the same name. A set for an unknown vector or element is ignored.
	vector(client: Client, message: DefVector | SetVector, tag: `def${VectorType}Vector` | `set${VectorType}Vector`) {
		if (tag[0] === 'd') this.#define(client, message as DefVector, PROPERTY_TYPES[tag.slice(3, -6) as VectorType])
		else this.#update(client, message as SetVector)
	}

	// Deletes one vector, removing its device when it was the last one, or the whole device when no name
	// is given.
	delProperty(client: Client, message: DelProperty) {
		const devices = this.#clients.get(client)
		const device = devices?.get(message.device)

		if (devices === undefined || device === undefined) return

		if (!message.name) {
			this.#remove(client, devices, device)
			return
		}

		const property = device.properties[message.name]

		if (property === undefined) return

		delete device.properties[message.name]
		this.#emit((listener) => listener.propertyRemoved?.(client, device, property))

		if (Object.keys(device.properties).length === 0) {
			this.#remove(client, devices, device)
		} else if (property.name === 'DRIVER_INFO' || property.name === 'CONNECTION') {
			this.#derive(client, device)
		}
	}

	// Forwards a message addressed to a known device; system-wide messages and unknown devices are ignored.
	message(client: Client, message: Message) {
		if (!message.device) return
		const device = this.#clients.get(client)?.get(message.device)
		if (device !== undefined) this.#emit((listener) => listener.message?.(client, device, message))
	}

	// Removes every device of a closed client.
	close(client: Client, server: boolean) {
		const devices = this.#clients.get(client)

		if (devices === undefined) return

		this.#clients.delete(client)

		for (const device of devices.values()) {
			this.#emit((listener) => listener.deviceRemoved?.(client, device))
		}
	}

	// Stores a copy of a def vector, creating the device on first sight.
	#define(client: Client, message: DefVector, type: IndiPropertyType) {
		let devices = this.#clients.get(client)

		if (devices === undefined) {
			devices = new Map()
			this.#clients.set(client, devices)
		}

		let device = devices.get(message.device)
		const added = device === undefined

		if (device === undefined) {
			device = { name: message.device, hardwareId: makeHardwareId(client, message.device), properties: Object.create(null) as IndiProperties }
			devices.set(device.name, device)
		}

		const property = copyProperty(message, type, ++this.#revision)
		// A redefinition moves the vector to the end, where the driver now places it.
		delete device.properties[property.name]
		device.properties[property.name] = property

		if (added) this.#emit((listener) => listener.deviceAdded?.(client, device))
		this.#emit((listener) => listener.propertyDefined?.(client, device, property))
		if (property.name === 'DRIVER_INFO' || property.name === 'CONNECTION') this.#derive(client, device)
	}

	// Merges a set vector into its stored vector and reports what changed.
	#update(client: Client, message: SetVector) {
		const device = this.#clients.get(client)?.get(message.device)
		const property = device?.properties[message.name]

		if (device === undefined || property === undefined) return

		const change = mergeProperty(property, message)

		if (change === undefined) return

		property.revision = ++this.#revision
		this.#emit((listener) => listener.propertyUpdated?.(client, device, property, change))
		if (property.name === 'DRIVER_INFO' || property.name === 'CONNECTION') this.#derive(client, device)
	}

	// Drops a device and reports it.
	#remove(client: Client, devices: Map<string, IndiDevice>, device: IndiDevice) {
		devices.delete(device.name)
		if (devices.size === 0) this.#clients.delete(client)
		this.#emit((listener) => listener.deviceRemoved?.(client, device))
	}

	// Recomputes the driver identification and the connection flag, reporting the device when either changed.
	#derive(client: Client, device: IndiDevice) {
		const info = device.properties.DRIVER_INFO
		const connection = device.properties.CONNECTION
		const driver = info?.type === 'TEXT' ? driverOf(info) : undefined
		const connected = connection?.type === 'SWITCH' ? connection.elements.CONNECT?.value === true : undefined

		if (connected === device.connected && isSameDriver(driver, device.driver)) return

		device.driver = driver
		device.connected = connected
		this.#emit((listener) => listener.deviceUpdated?.(client, device))
	}

	// Calls every listener.
	#emit(call: (listener: IndiPropertyListener) => void) {
		for (const listener of this.#listeners) call(listener)
	}
}

// Copies a def vector into a new record of its kind, with the given revision. A missing or unreadable
// timeout (NaN from the parser) is left out.
function copyProperty(message: DefVector, type: IndiPropertyType, revision: number): IndiProperty {
	const base = { device: message.device, name: message.name, label: message.label, group: message.group, state: message.state, message: message.message, timestamp: message.timestamp, elementNames: Object.keys(message.elements), revision }
	const timeout = 'timeout' in message && message.timeout !== undefined && Number.isFinite(message.timeout) ? message.timeout : undefined

	switch (type) {
		case 'TEXT': {
			const { permission, elements } = message as DefTextVector
			return { ...base, type, permission, timeout, elements: copyElements(elements, ({ name, label, value }) => ({ name, label, value })) }
		}
		case 'NUMBER': {
			const { permission, elements } = message as DefNumberVector
			return { ...base, type, permission, timeout, elements: copyElements(elements, ({ name, label, format, min, max, step, value }) => ({ name, label, format, min, max, step, value })) }
		}
		case 'SWITCH': {
			const { permission, rule, elements } = message as DefSwitchVector
			return { ...base, type, permission, rule, timeout, elements: copyElements(elements, ({ name, label, value }) => ({ name, label, value })) }
		}
		case 'LIGHT': {
			const { elements } = message as DefLightVector
			return { ...base, type, elements: copyElements(elements, ({ name, label, value }) => ({ name, label, value })) }
		}
		case 'BLOB': {
			const { permission, elements } = message as DefBlobVector
			return { ...base, type, permission, timeout, elements: copyElements(elements, ({ name, label }): IndiBlobElement => ({ name, label })) }
		}
	}
}

// Copies every element of a record into a new prototype-less record, in the same order.
function copyElements<S, T>(elements: Readonly<Record<string, S>>, copy: (element: S) => T) {
	const copied = Object.create(null) as Record<string, T>
	for (const name in elements) copied[name] = copy(elements[name])
	return copied
}

// Merges a set vector into a stored vector in place, ignoring elements the definition does not have.
// Returns what changed, or undefined when nothing did. A timestamp alone is stored but is not a change.
function mergeProperty(property: IndiProperty, message: SetVector): IndiPropertyChange | undefined {
	const changed: string[] = []
	let metadata = false
	let feedback = false

	switch (property.type) {
		case 'NUMBER':
			for (const [name, { value, min, max, step }] of Object.entries((message as SetNumberVector).elements)) {
				const element = property.elements[name]
				if (element === undefined) continue

				let updated = false

				if (!Object.is(value, element.value)) {
					element.value = value
					updated = true
				}

				// A set vector may carry an updated range (INDI's IUUpdateMinMax).
				if ((min !== undefined && !Object.is(min, element.min)) || (max !== undefined && !Object.is(max, element.max)) || (step !== undefined && !Object.is(step, element.step))) {
					if (min !== undefined) element.min = min
					if (max !== undefined) element.max = max
					if (step !== undefined) element.step = step
					metadata = updated = true
				}

				if (updated) changed.push(name)
			}
			break
		case 'BLOB':
			for (const [name, { format, size }] of Object.entries((message as SetBlobVector).elements)) {
				const element = property.elements[name]
				if (element === undefined) continue

				// Only the metadata of the delivery is kept; the bytes stay with the handler that consumes them.
				const bytes = size ? +size : Number.NaN
				const length = Number.isFinite(bytes) ? bytes : undefined

				if (format !== element.format || length !== element.size) {
					element.format = format
					element.size = length
					changed.push(name)
				}
			}
			break
		case 'TEXT':
			mergeValues(property.elements, (message as SetTextVector).elements, changed)
			break
		case 'SWITCH':
			mergeValues(property.elements, (message as SetSwitchVector).elements, changed)
			break
		case 'LIGHT':
			mergeValues(property.elements, (message as SetLightVector).elements, changed)
	}

	if (message.state && message.state !== property.state) {
		property.state = message.state
		feedback = true
	}

	if (message.message !== undefined && message.message !== property.message) {
		property.message = message.message
		feedback = true
	}

	if (message.timestamp !== undefined) property.timestamp = message.timestamp

	if (property.type !== 'LIGHT' && 'timeout' in message && message.timeout !== undefined && Number.isFinite(message.timeout) && message.timeout !== property.timeout) {
		property.timeout = message.timeout
		metadata = true
	}

	if (metadata) return { kind: 'metadata', elements: changed }
	if (feedback) return { kind: 'feedback', elements: changed }
	return changed.length > 0 ? { kind: 'values', elements: changed } : undefined
}

// Copies the values of the elements of a set vector that the definition has, recording the changed names.
function mergeValues<T extends string | boolean>(elements: Record<string, { value: T }>, received: Readonly<Record<string, { readonly value: T }>>, changed: string[]) {
	for (const name in received) {
		const element = elements[name]

		if (element !== undefined && element.value !== received[name].value) {
			element.value = received[name].value
			changed.push(name)
		}
	}
}

// Reads the driver identification of a DRIVER_INFO vector.
function driverOf(info: IndiTextProperty): IndiDriver {
	const { DRIVER_NAME, DRIVER_EXEC, DRIVER_VERSION, DRIVER_INTERFACE } = info.elements
	const mask = DRIVER_INTERFACE === undefined ? 0 : +DRIVER_INTERFACE.value
	return { name: DRIVER_NAME?.value ?? '', executable: DRIVER_EXEC?.value ?? '', version: DRIVER_VERSION?.value ?? '', interface: Number.isInteger(mask) ? mask : 0 }
}

// Whether two driver identifications are equal, field by field.
function isSameDriver(a: IndiDriver | undefined, b: IndiDriver | undefined) {
	return a === b || (a !== undefined && b !== undefined && a.name === b.name && a.executable === b.executable && a.version === b.version && a.interface === b.interface)
}
