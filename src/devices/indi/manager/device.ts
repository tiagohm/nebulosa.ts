import type { PickByValue, Writable } from '../../../core/types'
import type { IndiClientHandler } from '../client'
// oxfmt-ignore
import { CLIENT, type Client, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_DOME, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_WEATHER, DEFAULT_WHEEL, type Device, DeviceInterfaceType, type DeviceProperties, type DeviceProperty, type DeviceType, findDeviceTypes, isInterfaceType, type MinMaxValueProperty, type Parkable } from '../device'
import type { BlobEncoding, DefNumber, DefSwitchVector, DefText, DefTextVector, DefVector, DelProperty, OneNumber, PropertyState, SetSwitchVector, SetTextVector, SetVector, ValueType } from '../types'

// Device managers that turn the raw INDI property stream into typed device state. A DeviceManager per
// device type consumes def*/set* vectors as an IndiClientHandler, maintains the device objects, applies
// each relevant property to the device's fields (with unit conversions), and notifies DeviceHandlers of
// add/update/remove/BLOB events. Shared low-level value/range/parking helpers live here.

// Subscriber to device lifecycle events for a device type.
export interface DeviceHandler<D extends Device> {
	readonly added: (device: D) => void
	// Notified when a device property field changes; `property` is the device field name.
	readonly updated?: (device: D, property: keyof D & string, state?: PropertyState) => void
	readonly removed: (device: D) => void
	// Notified when an image/data BLOB arrives for the device.
	readonly blobReceived?: (device: D, data: Buffer, encoding: BlobEncoding) => void
}

// Subscriber to raw INDI property add/update/remove events for a device type.
export interface DevicePropertyHandler<D extends Device> {
	readonly added: (device: D, property: DeviceProperty) => void
	readonly updated: (device: D, property: DeviceProperty) => void
	readonly removed: (device: D, property: DeviceProperty) => void
}

// Resolves a device by client and id (optionally constrained to a type).
export interface DeviceProvider<D extends Device> {
	readonly get: (client: Client | string | undefined, id: string, type?: DeviceType) => D | undefined
}

// Maps an INDI DRIVER_INTERFACE bit to the default device template used to seed a newly seen device.
const MODEL_DEVICES = {
	[DeviceInterfaceType.TELESCOPE]: DEFAULT_MOUNT,
	[DeviceInterfaceType.CCD]: DEFAULT_CAMERA,
	[DeviceInterfaceType.FOCUSER]: DEFAULT_FOCUSER,
	[DeviceInterfaceType.FILTER]: DEFAULT_WHEEL,
	[DeviceInterfaceType.DUSTCAP]: DEFAULT_COVER,
	[DeviceInterfaceType.LIGHTBOX]: DEFAULT_FLAT_PANEL,
	[DeviceInterfaceType.ROTATOR]: DEFAULT_ROTATOR,
	[DeviceInterfaceType.DOME]: DEFAULT_DOME,
	[DeviceInterfaceType.POWER]: DEFAULT_POWER,
	[DeviceInterfaceType.WEATHER]: DEFAULT_WEATHER,
} as const

// Tracks the raw INDI property vectors per device and notifies property-level handlers on
// define/update/delete. Backs each DeviceManager's `properties` view.
export class DevicePropertyManager<D extends Device> implements IndiClientHandler, DevicePropertyHandler<D> {
	readonly #properties = new Map<Device, DeviceProperties>()
	readonly #handlers = new Set<DevicePropertyHandler<D>>()

	constructor(readonly deviceProvider: DeviceProvider<D>) {}

	// Number of devices currently holding properties.
	get length() {
		return this.#properties.size
	}

	// Registers/unregisters a property-event handler.
	addHandler(handler: DevicePropertyHandler<D>) {
		this.#handlers.add(handler)
	}

	removeHandler(handler: DevicePropertyHandler<D>) {
		this.#handlers.delete(handler)
	}

	// Fan-out of property add/update/remove events to all registered handlers.
	added(device: D, property: DeviceProperty) {
		for (const e of this.#handlers) e.added(device, property)
	}

	updated(device: D, property: DeviceProperty) {
		for (const e of this.#handlers) e.updated(device, property)
	}

	removed(device: D, property: DeviceProperty) {
		for (const e of this.#handlers) e.removed(device, property)
	}

	// Returns the property map for a device, if any.
	get(device: D) {
		return this.#properties.get(device)
	}

	// Whether the device has any tracked properties.
	has(device: D) {
		return this.#properties.has(device) === true
	}

	// Applies a def*/set* vector: a def tags and stores the property (added); a set merges changed state
	// and element values into the existing property (updated). BLOB vectors are skipped here. Returns
	// whether anything changed.
	vector(client: Client, message: DefVector | SetVector, tag: string) {
		const device = this.deviceProvider.get(client, message.device)

		if (device === undefined) return false

		let properties = this.#properties.get(device)

		if (properties === undefined) {
			properties = Object.create(null) as DeviceProperties
			this.#properties.set(device, properties)
		}

		if (tag[0] === 'd') {
			const property = message as DeviceProperty
			property.type = tag.includes('Switch') ? 'SWITCH' : tag.includes('Number') ? 'NUMBER' : tag.includes('Text') ? 'TEXT' : tag.includes('BLOB') ? 'BLOB' : 'LIGHT'
			properties[message.name] = property
			this.added(device, property)
			return true
		} else if (message === properties[message.name]) {
			// Alpaca always send the same message (object)
			this.updated(device, message as DeviceProperty)
		} else {
			const property = properties[message.name]

			if (property === undefined) return false

			let updated = false

			// Skip BLOB type
			if (property.type[0] !== 'B') {
				if (message.state && message.state !== property.state) {
					property.state = message.state
					updated = true
				}

				const { elements } = message

				for (const key in elements) {
					const element = property.elements[key]

					if (element) {
						const value = elements[key].value

						if (value !== element.value) {
							element.value = value as ValueType
							updated = true
						}
					}
				}

				if (updated) {
					this.updated(device, property)
				}
			}

			return updated
		}

		return false
	}

	// Removes one named property (or all of a device's properties when no name is given) and notifies.
	delProperty(client: Client, message: DelProperty) {
		const device = this.deviceProvider.get(client, message.device)

		if (device === undefined) return false

		const properties = this.get(device)

		if (properties === undefined) return false

		const { name } = message

		if (name) {
			const property = properties[name]

			if (property) {
				delete properties[name]
				if (Object.keys(properties).length === 0) this.#properties.delete(device)
				this.removed(device, property)
				return true
			}
		} else {
			// TODO: should notify for all properties being removed?
			// for (const [_, property] of Object.entries(properties)) this.removed(device, property)
			this.#properties.delete(device)
			return true
		}

		return false
	}

	// Drops all properties belonging to a disconnected client.
	close(client: Client, server: boolean) {
		for (const device of this.#properties.keys()) {
			if (device[CLIENT] === client) {
				this.#properties.delete(device)
			}
		}
	}
}

// Base class for per-type device managers. As an IndiClientHandler it ingests the property stream, owns
// the device objects of its type, exposes them as a DeviceProvider, and re-emits typed lifecycle events
// to DeviceHandlers. Subclasses implement the per-type vector handling that maps properties to fields.
export abstract class DeviceManager<D extends Device> implements IndiClientHandler, DeviceProvider<D>, DeviceHandler<D> {
	readonly #clients = new Map<string, Client>()
	readonly #devices = new Map<string, D>()
	readonly #handlers = new Set<DeviceHandler<D>>()
	// Per-device raw property view.
	readonly properties = new DevicePropertyManager(this)
	// Track writable properties for each device.
	readonly #writableProperties = new WeakMap<Device, Set<string>>()

	protected hasWritableProperty(device: Device, name: string) {
		return this.#writableProperties.get(device)?.has(name) === true
	}

	protected addWritableProperty(device: Device, name: string) {
		let writable = this.#writableProperties.get(device)

		if (writable === undefined) {
			writable = new Set()
			this.#writableProperties.set(device, writable)
		}

		writable.add(name)
	}

	protected removeWritableProperty(device: Device, name: string) {
		const writable = this.#writableProperties.get(device)

		if (writable !== undefined) {
			writable.delete(name)

			if (writable.size === 0) {
				this.#writableProperties.delete(device)
			}
		}
	}

	protected clearWritableProperty(device: Device) {
		return this.#writableProperties.delete(device)
	}

	// Number of managed devices.
	get length() {
		return this.#devices.size
	}

	// Registers/unregisters a device lifecycle handler.
	addHandler(handler: DeviceHandler<D>) {
		this.#handlers.add(handler)
	}

	removeHandler(handler: DeviceHandler<D>) {
		this.#handlers.delete(handler)
	}

	// Fan-out of device lifecycle events to all registered handlers.
	added(device: D) {
		for (const handler of this.#handlers) handler.added(device)
	}

	updated(device: D, property: keyof D & string, state?: PropertyState) {
		for (const handler of this.#handlers) handler.updated?.(device, property, state)
	}

	removed(device: D) {
		for (const handler of this.#handlers) handler.removed(device)
	}

	blobReceived(device: D, data: Buffer, encoding: BlobEncoding) {
		for (const handler of this.#handlers) handler.blobReceived?.(device, data, encoding)
	}

	// Lists managed devices, optionally filtered to a single client.
	list(client?: Client | string) {
		const devices = new Set<D>()

		client = typeof client === 'string' ? this.#clients.get(client) : client

		for (const device of this.#devices.values()) {
			if (client === undefined || device[CLIENT] === client) devices.add(device)
		}

		return devices
	}

	// Resolves a managed device by id or hardware id or, scoped to a client, by name.
	get(client: Client | string | undefined, id: string) {
		client = typeof client === 'string' ? this.#clients.get(client) : client

		for (const device of this.#devices.values()) {
			if (device.id === id) return device
			if (device.hardwareId === id) return device
			if (device[CLIENT] === client && device.name === id) return device
		}

		return undefined
	}

	// Whether a matching device exists.
	has(client: Client | string | undefined, id: string) {
		return this.get(client, id) !== undefined
	}

	// Requests (re)definition of a device's properties from its client.
	ask(device: D, name?: string, client = device[CLIENT]!) {
		client.getProperties({ device: device.name, name })
	}

	// Enables/disables BLOB delivery for a device.
	enableBlob(device: D, client = device[CLIENT]!) {
		client.enableBlob({ device: device.name, value: 'Also' })
	}

	disableBlob(device: D, client = device[CLIENT]!) {
		client.enableBlob({ device: device.name, value: 'Never' })
	}

	// Connects/disconnects a device via its CONNECTION switch (no-op if already in the target state).
	connect(device: D, client = device[CLIENT]!) {
		if (!device.connected) {
			client.sendSwitch({ device: device.name, name: 'CONNECTION', elements: { CONNECT: true } })
		}
	}

	disconnect(device: D, client = device[CLIENT]!) {
		if (device.connected) {
			client.sendSwitch({ device: device.name, name: 'CONNECTION', elements: { DISCONNECT: true } })
		}
	}

	// Toggles a driver's SIMULATION switch.
	simulation(device: D, enable: boolean, client = device[CLIENT]!) {
		client.sendSwitch({ device: device.name, name: 'SIMULATION', elements: { [enable ? 'ENABLE' : 'DISABLE']: true } })
	}

	// Base switch handling: applies the CONNECTION switch. Subclasses override to add device-specific
	// switch properties and call super.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'CONNECTION':
				if (this.handleConnection(device, message)) {
					this.updated(device, 'connected', message.state)
				}
		}
	}

	// Removes the device when an unnamed delProperty arrives (whole-device deletion); always forwards to
	// the property manager.
	delProperty(client: Client, message: DelProperty) {
		this.properties.delProperty(client, message)

		if (!message.name) {
			const device = this.get(client, message.device)

			if (device !== undefined) {
				this.remove(device)
			}
		}
	}

	// Forwards every vector to the property manager; subclasses override to additionally apply fields.
	vector(client: Client, message: DefVector | SetVector, tag: string) {
		this.properties.vector(client, message, tag)
	}

	// Applies the CONNECTION switch to the device's `connected` flag, asking for properties on connect.
	protected handleConnection(device: D, message: DefSwitchVector | SetSwitchVector, client = device[CLIENT]!) {
		const connected = message.elements.CONNECT?.value === true

		if (handleSwitchValue<Device>(device, 'connected', connected, message.state)) {
			if (connected) this.ask(device)
			return true
		}

		return false
	}

	// Creates the device from its DRIVER_INFO when the driver advertises the manager's interface bit
	// (seeding from the matching default template and a stable MD5 id), or removes it if the interface is
	// no longer present.
	protected handleDriverInfo(client: Client, message: DefTextVector | SetTextVector, interfaceType: DeviceInterfaceType) {
		const { elements } = message
		const type = +elements.DRIVER_INTERFACE.value
		const name = message.device
		let device: Writable<D> | undefined = this.get(client, name)

		if (isInterfaceType(type, interfaceType)) {
			const modelDevice = MODEL_DEVICES[interfaceType as keyof typeof MODEL_DEVICES] as unknown as D | undefined

			if (!modelDevice) return

			const interfaces = findDeviceTypes(type)

			if (device === undefined) {
				device = makeDevice(modelDevice, client, name, elements)
				device.interfaces = interfaces

				this.add(device)
				this.ask(device)
			} else if (device.interfaces.length !== interfaces.length) {
				device.interfaces = interfaces
				this.updated(device, 'interfaces', undefined)
			}
		} else if (device !== undefined) {
			this.remove(device)
		}
	}

	// Registers a new device and emits `added`; no-op if already present.
	add(device: D, client = device[CLIENT]!) {
		if (!this.has(client, device.id)) {
			this.#devices.set(device.id, device)
			this.#clients.set(client.id, client)
			this.added(device)
			return true
		} else {
			return false
		}
	}

	// Unregisters a device and emits `removed`.
	remove(device: D) {
		if (this.#devices.delete(device.id)) {
			this.removed(device)
			return true
		} else {
			return false
		}
	}

	// Drops all devices/properties of a disconnected client.
	close(client: Client, server: boolean) {
		this.properties.close(client, server)
		const devices = this.list(client)
		for (const device of devices) this.remove(device)
		this.#clients.delete(client.id)
	}
}

// Resets a device field to a default (deep-cloned) value and notifies, when it actually differs.
export function resetDeviceValue<D extends Device, K extends keyof D & string>(manager: DeviceManager<D>, device: D, property: K, value: D[K]) {
	if (!isSamePropertyValue(device[property], value)) {
		device[property] = structuredClone(value)
		manager.updated(device, property)
	}
}

// Cheap equality check used before a reset: identity only, treating any object as different to avoid
// expensive deep comparisons (drivers usually send fresh objects anyway).
function isSamePropertyValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	// Don't look deeper if the value is an object, since in most cases the driver will send a new object, and we want to avoid expensive deep comparisons
	return false
}

// Applies a PARK switch vector to a parkable device's canPark/parking/parked fields and notifies on each
// change. `parking` is inferred from a Busy state.
export function handleParkable<D extends Device & Parkable>(manager: DeviceManager<D>, device: D, message: DefSwitchVector | SetSwitchVector, tag: string) {
	if (tag[0] === 'd') {
		if (handleSwitchValue<Device & Parkable>(device, 'canPark', (message as DefSwitchVector).permission !== 'ro')) {
			manager.updated(device, 'canPark', message.state)
		}
	}

	if (handleSwitchValue<Device & Parkable>(device, 'parking', message.state === 'Busy')) {
		manager.updated(device, 'parking', message.state)
	}

	if (handleSwitchValue<Device & Parkable>(device, 'parked', message.elements.PARK?.value)) {
		manager.updated(device, 'parked', message.state)
	}
}

// Assigns a scalar field on a device when it changed. Returns true on change, or when the state is Alert
// (so callers still re-notify on error states even without a value change). Underlies the typed helpers.
function handlePropertyValue<D, T extends string | number | boolean>(device: D, property: keyof PickByValue<D, T>, value: T, state?: PropertyState) {
	if (device[property] !== value) {
		device[property] = value as never
		return true
	}

	return state === 'Alert'
}

// Typed wrappers over handlePropertyValue: switch coerces undefined to false; number applies an optional
// transform (e.g. unit conversion) and ignores undefined; text ignores empty/undefined values.
export function handleSwitchValue<D>(device: D, property: keyof PickByValue<D, boolean>, value?: boolean, state?: PropertyState) {
	return handlePropertyValue<D, boolean>(device, property, value === true, state)
}

export function handleNumberValue<D>(device: D, property: keyof PickByValue<D, number>, value?: number, state?: PropertyState, transform?: (value: number) => number) {
	return value !== undefined && handlePropertyValue<D, number>(device, property, transform?.(value) ?? value, state)
}

export function handleTextValue<D>(device: D, property: keyof PickByValue<D, string>, value?: string, state?: PropertyState) {
	return value && handlePropertyValue<D, string>(device, property, value, state)
}

// Applies a number element to a value+range property: updates min/max/step when a real range is present
// (def vectors, or set vectors carrying IUUpdateMinMax bounds with max !== 0) and the value, clamping it
// only once a meaningful range is known. Returns whether anything changed.
export function handleMinMaxValue(property: MinMaxValueProperty, element: DefNumber | OneNumber | undefined, tag: string) {
	if (element === undefined) return false

	let update = false

	// Bounds arrive on a def vector and, per INDI's IUUpdateMinMax, may also arrive on a set
	// vector's oneNumber. Read them whenever the range is present and meaningful (max !== 0).
	const { min, max, step } = element as DefNumber

	if ((tag[0] === 'd' || max !== undefined) && max !== 0) {
		if (min !== property.min || max !== property.max || step !== property.step) {
			property.min = min
			property.max = max
			property.step = step
			update = true
		}
	}

	if (property.value !== element.value) {
		// Clamp only when a real range is known; otherwise keep the reported value as-is so a
		// still-unbounded property (max === 0) is not forced to zero.
		property.value = property.max > property.min ? Math.max(property.min, Math.min(element.value, property.max)) : element.value
		update = true
	}

	return update
}

export function makeDeviceId(client: Client, type: DeviceType, name: string) {
	return Bun.MD5.hash(`${client.id}:${type}:${name}`, 'hex')
}

export function makeDevice<D extends Device>(model: D, client: Client, name: string, driver?: Record<string, DefText>, id?: string) {
	const device = structuredClone<D>(model) as Writable<D>

	device.id = id || makeDeviceId(client, device.type, name)
	device.hardwareId = Bun.MD5.hash(`${client.id}:${name}`, 'hex')
	device.name = name
	device[CLIENT] = client
	device.driver = { executable: driver?.DRIVER_EXEC?.value ?? '', version: driver?.DRIVER_VERSION?.value ?? '' }
	device.client = { type: client.type, id: client.id }

	return device
}

// Wraps a parent device in a proxy presenting a distinct id/type and a `parent`/`parentId` link, so a
// sub-interface (e.g. a guide output of a mount) appears as its own device while sharing the parent's
// fields. parentId is made enumerable so it survives Object.keys()/JSON.stringify.
export function proxyDevice<D extends Device>(parent: D, id: string, type: DeviceType) {
	const current = Object.create(null)

	return new Proxy(parent, {
		get(target, prop) {
			if (prop === 'id') return id
			if (prop === 'parentId') return parent.id
			if (prop === 'type') return type
			if (prop === 'parent') return parent
			if (prop in current) return current[prop]
			return Reflect.get(target, prop)
		},
		set(target, p, newValue, receiver) {
			if (Reflect.has(target, p)) {
				return Reflect.set(target, p, newValue, receiver)
			} else {
				current[p] = newValue
				return true
			}
		},
		deleteProperty(target, p) {
			if (p in current) delete current[p]
			return Reflect.deleteProperty(target, p)
		},
		// parentId is never set, so this is used show up in Object.keys() and similar functions, which is useful for debugging and serialization
		// JSON.stringify ignores properties that don't show up in Object.keys()
		ownKeys(target) {
			const keys = Reflect.ownKeys(target)
			keys.push('parentId')
			for (const key of Reflect.ownKeys(current)) keys.push(key)
			return keys
		},
		has(target, p) {
			return p === 'parent' || p in current || Reflect.has(target, p)
		},
		getOwnPropertyDescriptor(target, prop) {
			if (prop === 'parentId' || prop in current) {
				return { enumerable: true, configurable: true }
			}

			return Reflect.getOwnPropertyDescriptor(target, prop)
		},
	})
}
