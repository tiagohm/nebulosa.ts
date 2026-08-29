import { observedToCirs } from '../../astronomy/coordinates/astrometry'
import { eclipticToEquatorial, equatorialFromJ2000, galacticToEquatorial } from '../../astronomy/coordinates/coordinate'
import { TAU } from '../../core/constants'
import type { CfaPattern } from '../../imaging/model/types'
import { type Angle, deg, hour, normalizeAngle, normalizePI, parseAngle, toDeg, toHour } from '../../math/units/angle'
import { meter, toMeter } from '../../math/units/distance'
import type { IndiClientHandler } from './client'
// oxfmt-ignore
import { type Camera, type CameraTransferFormat, CLIENT, type Client, type Cover, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_DEW_HEATER, DEFAULT_DOME, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_GUIDE_OUTPUT, DEFAULT_MIN_MAX_VALUE_PROPERTY, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_SAFETY_MONITOR, DEFAULT_THERMOMETER, DEFAULT_WEATHER, DEFAULT_WHEEL, type Device, DeviceInterfaceType, type DeviceProperties, type DeviceProperty, type DeviceType, type DewHeater, type Dome, type DomeDirection, type DomeOTASide, type DomeShutterState, findDeviceTypes, type FlatPanel, type Focuser, type FrameType, type GPS, type GuideDirection, type GuideOutput, isInterfaceType, isSafetyMonitor, isSubDevice, type MinMaxValueProperty, type Mount, type MountTargetCoordinate, type NameAndLabel, type Parkable, type Power, type PowerChannel, type PowerChannelType, type Rotator, type SafetyMonitor, type SubDevice, type Thermometer, type TrackMode, type Weather, type WeatherSensor, type Wheel } from './device'
import type { GeographicCoordinate } from '../../astronomy/observer/location'
import { formatTemporal, parseTemporal } from '../../astronomy/time/temporal'
import { type Time, timeNow } from '../../astronomy/time/time'
import type { PickByValue, Writable } from '../../core/types'
// oxfmt-ignore
import { findOnSwitch, type BlobEncoding, type DefBlobVector, type DefElement, type DefLightVector, type DefNumber, type DefNumberVector, type DefSwitch, type DefSwitchVector, type DefText, type DefTextVector, type DefVector, type DelProperty, type OneNumber, type PropertyState, type SetBlobVector, type SetLightVector, type SetNumberVector, type SetSwitchVector, type SetTextVector, type SetVector, type ValueType } from './types'

// Device managers that turn the raw INDI property stream into typed device state. A DeviceManager per
// device type consumes def*/set* vectors as an IndiClientHandler, maintains the device objects, applies
// each relevant property to the device's fields (with unit conversions), and notifies DeviceHandlers of
// add/update/remove/BLOB events. Shared low-level value/range/parking helpers live at the bottom.

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

// Alternate INDI property names used for dome home and park actions.
type DomeParkProperties = {
	park?: 'DOME_PARK' | 'DOME_GOTO'
	hasHome?: boolean
}

// Element names used by a dome driver's autosync switch vector.
type DomeSlavingProperties = readonly [enabled: string, disabled: string]

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

// Manager for stand-alone or embedded guide outputs. Command methods send pulse-guide (durations in
// milliseconds) and guide-rate commands; property handling reflects pulse-guiding capability/state.
export class GuideOutputManager extends DeviceManager<GuideOutput> {
	// Busy state reported independently by the north/south and west/east timed-guide vectors.
	readonly #pulseStates = new WeakMap<GuideOutput, { northSouth: boolean; westEast: boolean }>()

	constructor(readonly provider: DeviceProvider<GuideOutput>) {
		super()
	}

	// Issues a timed pulse-guide in one direction; duration is milliseconds. No-op without the capability.
	pulseNorth(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_N: duration } })
		}
	}

	pulseSouth(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_S: duration } })
		}
	}

	pulseWest(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_W: duration } })
		}
	}

	pulseEast(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_E: duration } })
		}
	}

	pulse(device: GuideOutput, direction: GuideDirection, duration: number, client = device[CLIENT]!) {
		if (direction === 'NORTH') this.pulseNorth(device, duration, client)
		else if (direction === 'SOUTH') this.pulseSouth(device, duration, client)
		else if (direction === 'WEST') this.pulseWest(device, duration, client)
		else if (direction === 'EAST') this.pulseEast(device, duration, client)
	}

	guideRate(device: GuideOutput, rightAscension: number, declination: number, client = device[CLIENT]!) {
		if (device.canSetGuideRate) {
			client.sendNumber({ device: device.name, name: 'GUIDE_RATE', elements: { GUIDE_RATE_WE: rightAscension, GUIDE_RATE_NS: declination } })
		}
	}

	#addProxy(client: Client, parent: GuideOutput) {
		const id = makeDeviceId(client, 'guideOutput', parent.name)
		const device = proxyDevice(parent, id, 'guideOutput')

		if (this.add(device)) {
			this.updated(device, 'canPulseGuide')
			this.updated(parent, 'canPulseGuide')
		}

		return device
	}

	// Forwards only the vectors relevant to a guide output (driver/connection and the timed-guide/guide-
	// rate properties) to the base property tracking.
	vector(client: Client, message: DefVector | SetVector, tag: string) {
		switch (message.name) {
			case 'DRIVER_INFO':
			case 'CONNECTION':
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE':
			case 'GUIDE_RATE':
				return super.vector(client, message, tag)
		}
	}

	// Applies the timed-guide (pulsing state) and guide-rate number vectors, lazily creating a guide-output
	// proxy over a parent mount/camera that advertises pulse-guiding.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE': {
				let device = this.get(client, message.device)

				if (device === undefined && tag[0] === 'd') {
					const parent = this.provider.get(client, message.device, 'mount') ?? this.provider.get(client, message.device, 'camera')

					if (parent !== undefined && handleSwitchValue(parent, 'canPulseGuide', true)) {
						device = this.#addProxy(client, parent)
					}
				}

				if (device !== undefined) {
					const pulseState = this.#pulseStates.get(device) ?? { northSouth: false, westEast: false }

					if (message.name === 'TELESCOPE_TIMED_GUIDE_NS') pulseState.northSouth = message.state === 'Busy'
					else pulseState.westEast = message.state === 'Busy'

					this.#pulseStates.set(device, pulseState)

					if (handleSwitchValue(device, 'pulsing', pulseState.northSouth || pulseState.westEast)) {
						this.updated(device, 'pulsing', message.state)

						const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
						this.updated(parent, 'pulsing', message.state)
					}
				}

				return
			}
			case 'GUIDE_RATE': {
				const device = this.get(client, message.device)

				if (device !== undefined) {
					if (tag[0] === 'd') {
						if (handleSwitchValue(device, 'hasGuideRate', true)) {
							this.updated(device, 'hasGuideRate', message.state)

							const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
							this.updated(parent, 'hasGuideRate', message.state)

							if (handleSwitchValue(device, 'canSetGuideRate', (message as DefNumberVector).permission !== 'ro')) {
								this.updated(device, 'canSetGuideRate', message.state)
								this.updated(parent, 'canSetGuideRate', message.state)
							}
						}
					}

					let updated = handleNumberValue(device.guideRate, 'rightAscension', message.elements.GUIDE_RATE_WE?.value)
					updated = handleNumberValue(device.guideRate, 'declination', message.elements.GUIDE_RATE_NS?.value) || updated

					if (updated) {
						this.updated(device, 'guideRate', message.state)

						const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
						this.updated(parent, 'guideRate', message.state)
					}
				}
			}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'TELESCOPE_TIMED_GUIDE_NS' || name === 'TELESCOPE_TIMED_GUIDE_WE') {
			this.#pulseStates.delete(device)
			resetDeviceValue(this, device, 'canPulseGuide', DEFAULT_GUIDE_OUTPUT.canPulseGuide)
			resetDeviceValue(this, device, 'pulsing', DEFAULT_GUIDE_OUTPUT.pulsing)

			const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
			this.updated(parent, 'canPulseGuide')
			this.updated(parent, 'pulsing')
		}
		if (full || name === 'GUIDE_RATE') {
			resetDeviceValue(this, device, 'hasGuideRate', DEFAULT_GUIDE_OUTPUT.hasGuideRate)
			resetDeviceValue(this, device, 'canSetGuideRate', DEFAULT_GUIDE_OUTPUT.canSetGuideRate)
			resetDeviceValue(this, device, 'guideRate', DEFAULT_GUIDE_OUTPUT.guideRate)

			const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
			this.updated(parent, 'hasGuideRate')
			this.updated(parent, 'canSetGuideRate')
			this.updated(parent, 'guideRate')
		}

		// When both properties are removed, remove the device too passing name as undefined.
		if (!device.canPulseGuide && !device.hasGuideRate) {
			super.delProperty(client, full ? message : { ...message, name: undefined })
		} else {
			super.delProperty(client, message)
		}
	}
}

// Manager for temperature sensors; reflects the device temperature (degrees Celsius) from its properties.
export class ThermometerManager extends DeviceManager<Thermometer> {
	constructor(readonly provider: DeviceProvider<Thermometer>) {
		super()
	}

	#addProxy(client: Client, parent: Thermometer) {
		const id = makeDeviceId(client, 'thermometer', parent.name)

		const device = proxyDevice(parent, id, 'thermometer')

		if (this.add(device)) {
			this.updated(device, 'hasThermometer')
			this.updated(parent, 'hasThermometer')
		}

		return device
	}

	// Forwards only the driver/connection and temperature vectors to the base property tracking.
	vector(client: Client, message: DefVector | SetVector, tag: string) {
		switch (message.name) {
			case 'DRIVER_INFO':
			case 'CONNECTION':
			case 'CCD_TEMPERATURE':
			case 'FOCUS_TEMPERATURE':
				return super.vector(client, message, tag)
		}
	}

	// Applies the camera/focuser temperature vectors (degrees Celsius), lazily creating a thermometer proxy
	// over a parent camera/focuser that reports a temperature.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'CCD_TEMPERATURE':
			case 'FOCUS_TEMPERATURE': {
				let device = this.get(client, message.device)

				if (device === undefined && tag[0] === 'd') {
					const parent = this.provider.get(client, message.device, message.name[0] === 'C' ? 'camera' : 'focuser')

					if (parent !== undefined && handleSwitchValue(parent, 'hasThermometer', true)) {
						device = this.#addProxy(client, parent)
					}
				}

				if (device !== undefined) {
					const { elements } = message

					if (handleNumberValue(device, 'temperature', elements.TEMPERATURE?.value ?? elements.CCD_TEMPERATURE_VALUE?.value, undefined, Math.round)) {
						this.updated(device, 'temperature', message.state)

						const parent = (device as SubDevice<Thermometer, Thermometer>).parent
						this.updated(parent, 'temperature', message.state)
					}
				}
			}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'CCD_TEMPERATURE' || name === 'FOCUS_TEMPERATURE') {
			resetDeviceValue(this, device, 'hasThermometer', DEFAULT_THERMOMETER.hasThermometer)
			resetDeviceValue(this, device, 'temperature', DEFAULT_THERMOMETER.temperature)

			const parent = (device as SubDevice<Thermometer, Thermometer>).parent
			this.updated(parent, 'hasThermometer')
			this.updated(parent, 'temperature')

			// Force remove the device passing name as undefined.
			super.delProperty(client, full ? message : { ...message, name: undefined })
			return
		}

		super.delProperty(client, message)
	}
}

// Cached discovery vectors used when a safety property arrives before driver identity or connection.
interface PendingSafetyMonitor {
	// Latest driver metadata used to classify INDI standalone devices and populate identity.
	driverInfo?: DefTextVector | SetTextVector
	// Latest connection vector used to seed standalone connection state.
	connection?: DefSwitchVector | SetSwitchVector
	// Latest safety vector used to seed the fail-closed domain state.
	safetyStatus?: DefLightVector | SetLightVector
}

// Manager for the transversal INDI SAFETY_STATUS light property. Known primary devices are exposed through
// a safety-monitor proxy; a native INDI standalone is created only for an AUXILIARY driver.
export class SafetyMonitorManager extends DeviceManager<SafetyMonitor> {
	// Discovery state is isolated by client and released when that client closes.
	readonly #pendingByClient = new WeakMap<Client, Map<string, PendingSafetyMonitor>>()

	// Parent provider must cover the primary device managers and must not resolve this manager itself.
	constructor(readonly provider: DeviceProvider<Device>) {
		super()
	}

	// Returns the cached discovery state for one physical device, creating it when requested.
	#pending(client: Client, name: string, create: boolean = true) {
		let devices = this.#pendingByClient.get(client)

		if (devices === undefined) {
			if (!create) return undefined
			devices = new Map()
			this.#pendingByClient.set(client, devices)
		}

		let pending = devices.get(name)

		if (pending === undefined && create) {
			pending = {}
			devices.set(name, pending)
		}

		return pending
	}

	// Whether the cached driver identity authorizes a parentless standalone for this backend.
	#canCreateStandalone(client: Client, pending: PendingSafetyMonitor) {
		if (client.type === 'ALPACA') return true
		const value = pending.driverInfo?.elements.DRIVER_INTERFACE?.value
		return value !== undefined && isInterfaceType(+value, DeviceInterfaceType.AUXILIARY)
	}

	// Creates a proxy or authorized standalone, or migrates a standalone when its primary parent appears.
	// TODO: SafetyMonitorManager.#materialize() exige que SAFETY_STATUS já tenha sido recebido.
	// Porém, tanto o driver INDI quanto AlpacaSafetyMonitor publicam essa propriedade somente depois da conexão.
	// Assim, o dispositivo não entra no manager, e o consumidor não consegue obter o dispositivo para chamar connect() — um ciclo impossível.
	// A documentação do driver confirma que SAFETY_STATUS é definido em updateProperties() apenas quando conectado.
	// Solução: criar um Auxiliary e AuxiliaryManager e fazer a conexão dele em vez do SafetyMonitor (pois não existe ainda no SafetyMonitorManager)
	#materialize(client: Client, name: string) {
		const parent = this.provider.get(client, name)
		let device = this.get(client, name)

		if (device !== undefined && parent !== undefined && device.parentId === undefined) {
			this.remove(device)
			device = undefined
		}

		if (device !== undefined) return device

		const pending = this.#pending(client, name)!
		if (pending.safetyStatus === undefined) return undefined

		const state = pending.safetyStatus?.state

		if (parent !== undefined) {
			const id = makeDeviceId(client, 'safetyMonitor', parent.name)
			device = proxyDevice(parent, id, 'safetyMonitor') as SubDevice<SafetyMonitor, Device>
			device.safe = state === 'Ok'
		} else if (this.#canCreateStandalone(client, pending)) {
			const standalone = makeDevice(DEFAULT_SAFETY_MONITOR, client, name, pending.driverInfo?.elements)
			standalone.connected = pending.connection?.elements.CONNECT?.value === true
			standalone.safe = state === 'Ok'
			device = standalone
		} else {
			return undefined
		}

		this.add(device, client)

		return device
	}

	// Caches driver identity, materializes pending devices, and refreshes standalone driver metadata.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name !== 'DRIVER_INFO') return

		this.#pending(client, message.device)!.driverInfo = message
		this.#materialize(client, message.device)
	}

	// Caches and applies the common CONNECTION switch after a safety device can be materialized.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		if (message.name !== 'CONNECTION') return

		this.#pending(client, message.device)!.connection = message
		const device = this.#materialize(client, message.device)

		if (device !== undefined) {
			super.switchVector(client, message, tag)
		}
	}

	// Applies the aggregate SAFETY_STATUS state; omitted set-vector states preserve the previous value.
	lightVector(client: Client, message: DefLightVector | SetLightVector, tag: string) {
		if (message.name !== 'SAFETY_STATUS') return

		this.#pending(client, message.device)!.safetyStatus = message
		const device = this.#materialize(client, message.device)

		if (device === undefined) return

		if (message.state !== undefined) {
			const safe = message.state === 'Ok'

			if (device.safe !== safe) {
				device.safe = safe
				this.updated(device, 'safe', message.state)

				if (isSubDevice<SafetyMonitor>(device) && isSafetyMonitor(device.parent)) {
					this.updated(device.parent, 'safe', message.state)
				}
			}
		}
	}

	// Removes a safety capability fail-closed while retaining driver metadata for a later redefinition.
	delProperty(client: Client, message: DelProperty) {
		if (message.name && message.name !== 'SAFETY_STATUS') {
			super.delProperty(client, message)
			return
		}

		const device = this.get(client, message.device)

		if (device !== undefined) {
			device.safe = false
			this.updated(device, 'safe', 'Idle')

			if (isSubDevice<SafetyMonitor>(device) && isSafetyMonitor(device.parent)) {
				this.updated(device.parent, 'safe', 'Idle')
			}

			super.delProperty(client, message.name ? { ...message, name: undefined } : message)
		}

		const devices = this.#pendingByClient.get(client)

		if (message.name) {
			const pending = devices?.get(message.device)
			if (pending !== undefined) pending.safetyStatus = undefined
		} else {
			devices?.delete(message.device)
		}
	}

	// Drops all managed devices, raw properties, and discovery vectors belonging to a closed client.
	close(client: Client, server: boolean) {
		super.close(client, server)
		this.#pendingByClient.delete(client)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indiccd.cpp

// Manager for cameras. Command methods drive exposure, cooling, frame/subframe, binning, gain/offset and
// frame type; property handling maps the corresponding INDI vectors (including the CCD image BLOB) onto
// the Camera state. Temperatures are degrees Celsius, exposures seconds, pixel sizes micrometres.
export class CameraManager extends DeviceManager<Camera> {
	readonly #gain = new WeakMap<Camera, readonly [string, string]>()
	readonly #offset = new WeakMap<Camera, readonly [string, string]>()

	cooler(camera: Camera, value: boolean, client = camera[CLIENT]!) {
		if (camera.hasCoolerControl) {
			client.sendSwitch({ device: camera.name, name: 'CCD_COOLER', elements: { [value ? 'COOLER_ON' : 'COOLER_OFF']: true } })
		}
	}

	temperature(camera: Camera, value: number, client = camera[CLIENT]!) {
		if (camera.canSetTemperature) {
			client.sendNumber({ device: camera.name, name: 'CCD_TEMPERATURE', elements: { CCD_TEMPERATURE_VALUE: value } })
		}
	}

	frameFormat(camera: Camera, value: string, client = camera[CLIENT]!) {
		if (value) {
			const index = camera.frameFormats.findIndex((e) => e.name === value)
			index >= 0 && client.sendSwitch({ device: camera.name, name: 'CCD_CAPTURE_FORMAT', elements: { [camera.frameFormats[index].name]: true } })
		}
	}

	frameType(camera: Camera, value: FrameType, client = camera[CLIENT]!) {
		client.sendSwitch({ device: camera.name, name: 'CCD_FRAME_TYPE', elements: { [`FRAME_${value}`]: true } })
	}

	frame(camera: Camera, X: number, Y: number, WIDTH: number, HEIGHT: number, client = camera[CLIENT]!) {
		if (camera.canSubFrame) {
			client.sendNumber({ device: camera.name, name: 'CCD_FRAME', elements: { X, Y, WIDTH, HEIGHT } })
		}
	}

	bin(camera: Camera, x: number, y: number, client = camera[CLIENT]!) {
		if (camera.canBin) {
			client.sendNumber({ device: camera.name, name: 'CCD_BINNING', elements: { HOR_BIN: x, VER_BIN: y } })
		}
	}

	gain(camera: Camera, value: number, client = camera[CLIENT]!) {
		const property = this.#gain.get(camera)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: camera.name, name, elements: { [element]: value } })
		}
	}

	offset(camera: Camera, value: number, client = camera[CLIENT]!) {
		const property = this.#offset.get(camera)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: camera.name, name, elements: { [element]: value } })
		}
	}

	compression(camera: Camera, enabled: boolean, client = camera[CLIENT]!) {
		client.sendSwitch({ device: camera.name, name: 'CCD_COMPRESSION', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
	}

	transferFormat(camera: Camera, format: CameraTransferFormat, client = camera[CLIENT]!) {
		client.sendSwitch({ device: camera.name, name: 'CCD_TRANSFER_FORMAT', elements: { [`FORMAT_${format}`]: true } })
	}

	startExposure(camera: Camera, exposureTimeInSeconds: number, client = camera[CLIENT]!) {
		client.sendNumber({ device: camera.name, name: 'CCD_EXPOSURE', elements: { CCD_EXPOSURE_VALUE: exposureTimeInSeconds } })
	}

	stopExposure(camera: Camera, client = camera[CLIENT]!) {
		client.sendSwitch({ device: camera.name, name: 'CCD_ABORT_EXPOSURE', elements: { ABORT: true } })
	}

	snoop(camera: Camera, mount?: Mount, focuser?: Focuser, wheel?: Wheel, rotator?: Rotator) {
		camera[CLIENT]!.sendText({ device: camera.name, name: 'ACTIVE_DEVICES', elements: { ACTIVE_TELESCOPE: mount?.name ?? '', ACTIVE_ROTATOR: rotator?.name ?? '', ACTIVE_FOCUSER: focuser?.name ?? '', ACTIVE_FILTER: wheel?.name ?? '' } })
	}

	// Applies camera switch vectors: cooler on/off, capture/readout format, abort exposure, and frame type.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'CCD_COOLER':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasCoolerControl', true)) {
						this.updated(device, 'hasCoolerControl', message.state)
					}
				}

				if (handleSwitchValue(device, 'cooler', message.elements.COOLER_ON?.value)) {
					this.updated(device, 'cooler', message.state)
				}

				return
			case 'CCD_CAPTURE_FORMAT': {
				const entries = Object.values((message as DefSwitchVector).elements)

				if (tag[0] === 'd') {
					device.frameFormats = entries.map((e) => ({ name: e.name, label: e.label! }))
					this.updated(device, 'frameFormats', message.state)
				}

				for (const { name, value } of entries) {
					if (value) {
						if (handleTextValue(device, 'frameFormat', name, message.state)) {
							this.updated(device, 'frameFormat', message.state)
						}

						break
					}
				}

				return
			}
			case 'CCD_ABORT_EXPOSURE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', (message as DefSwitchVector).permission !== 'ro')) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'CCD_FRAME_TYPE':
				if (handleTextValue(device, 'frameType', message.elements.FRAME_BIAS?.value ? 'BIAS' : message.elements.FRAME_FLAT?.value ? 'FLAT' : message.elements.FRAME_DARK?.value ? 'DARK' : 'LIGHT')) {
					this.updated(device, 'frameType', message.state)
				}
		}
	}

	// Applies camera number vectors: sensor/pixel info, exposure progress, cooler power and temperature,
	// subframe, binning, controls, and gain/offset.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'CCD_INFO': {
				const { elements } = message

				let changed = handleNumberValue(device.pixelSize, 'x', elements.CCD_PIXEL_SIZE_X?.value)
				changed = handleNumberValue(device.pixelSize, 'y', elements.CCD_PIXEL_SIZE_Y?.value) || changed

				if (changed) {
					this.updated(device, 'pixelSize', message.state)
				}

				return
			}
			case 'CCD_EXPOSURE': {
				let exposuringHasChanged = false

				if (handleSwitchValue(device, 'exposuring', message.state === 'Busy')) {
					this.updated(device, 'exposuring', message.state)
					exposuringHasChanged = true
				}

				if (tag[0] === 'd') {
					if (handleMinMaxValue(device.exposure, message.elements.CCD_EXPOSURE_VALUE, tag)) {
						this.updated(device, 'exposure', message.state)
					}
				} else if (handleNumberValue(device.exposure, 'value', message.elements.CCD_EXPOSURE_VALUE?.value, message.state) || exposuringHasChanged || (message.state !== undefined && device.exposure.state !== message.state)) {
					device.exposure.state = message.state ?? device.exposure.state
					this.updated(device, 'exposure', message.state)
				}

				return
			}
			case 'CCD_COOLER_POWER':
				if (handleNumberValue(device, 'coolerPower', message.elements.CCD_COOLER_POWER?.value)) {
					this.updated(device, 'coolerPower', message.state)
				}

				return
			case 'CCD_TEMPERATURE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasCooler', true)) {
						this.updated(device, 'hasCooler', message.state)
					}

					if (handleSwitchValue(device, 'canSetTemperature', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(device, 'canSetTemperature', message.state)
					}
				}

				return
			case 'CCD_FRAME': {
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSubFrame', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(device, 'canSubFrame', message.state)
					}
				}

				const { elements } = message

				let updated = handleMinMaxValue(device.frame.x, elements.X, tag)
				updated = handleMinMaxValue(device.frame.y, elements.Y, tag) || updated
				updated = handleMinMaxValue(device.frame.width, elements.WIDTH, tag) || updated
				updated = handleMinMaxValue(device.frame.height, elements.HEIGHT, tag) || updated

				if (updated) {
					this.updated(device, 'frame', message.state)
				}

				return
			}
			case 'CCD_BINNING': {
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canBin', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(device, 'canBin', message.state)
					}
				}

				const { elements } = message

				let updated = handleMinMaxValue(device.bin.x, elements.HOR_BIN, tag)
				updated = handleMinMaxValue(device.bin.y, elements.VER_BIN, tag) || updated

				if (updated) {
					this.updated(device, 'bin', message.state)
				}

				return
			}
			// ZWO ASI, SVBony, etc
			case 'CCD_CONTROLS':
				if (handleMinMaxValue(device.gain, message.elements.Gain, tag)) {
					this.updated(device, 'gain', message.state)
					this.#gain.set(device, [message.name, 'Gain'])
				}

				if (handleMinMaxValue(device.offset, message.elements.Offset, tag)) {
					this.updated(device, 'offset', message.state)
					this.#offset.set(device, [message.name, 'Offset'])
				}

				return
			// CCD Simulator & Alpaca
			case 'CCD_GAIN':
				if (handleMinMaxValue(device.gain, message.elements.GAIN, tag)) {
					this.updated(device, 'gain', message.state)
					this.#gain.set(device, [message.name, 'GAIN'])
				}

				return
			case 'CCD_OFFSET':
				if (handleMinMaxValue(device.offset, message.elements.OFFSET, tag)) {
					this.updated(device, 'offset', message.state)
					this.#offset.set(device, [message.name, 'OFFSET'])
				}
		}
	}

	// Creates/updates the camera from DRIVER_INFO and applies the color-filter-array (Bayer) text vector.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.CCD)
		}

		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'CCD_CFA':
				device.cfa.offsetX = +message.elements.CFA_OFFSET_X.value
				device.cfa.offsetY = +message.elements.CFA_OFFSET_Y.value
				device.cfa.type = message.elements.CFA_TYPE.value as CfaPattern
				this.updated(device, 'cfa', message.state)
		}
	}

	// Receives the CCD image BLOB and forwards its data to handlers.
	blobVector(client: Client, message: DefBlobVector | SetBlobVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'CCD1':
				if (tag[0] === 's') {
					const data = message.elements.CCD1?.value

					if (data) {
						this.blobReceived(device, data, message.elements.CCD1.encoding ?? 'base64')
					} else {
						console.warn(`received empty BLOB for device ${device.name}`)
					}
				}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'CCD_COOLER') {
			resetDeviceValue(this, device, 'hasCoolerControl', DEFAULT_CAMERA.hasCoolerControl)
			resetDeviceValue(this, device, 'cooler', DEFAULT_CAMERA.cooler)
		}
		if (full || name === 'CCD_CAPTURE_FORMAT') {
			resetDeviceValue(this, device, 'frameFormats', DEFAULT_CAMERA.frameFormats)
			resetDeviceValue(this, device, 'frameFormat', DEFAULT_CAMERA.frameFormat)
		}
		if (full || name === 'CCD_ABORT_EXPOSURE') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_CAMERA.canAbort)
		}
		if (full || name === 'CCD_FRAME_TYPE') {
			resetDeviceValue(this, device, 'frameType', DEFAULT_CAMERA.frameType)
		}
		if (full || name === 'CCD_INFO') {
			resetDeviceValue(this, device, 'pixelSize', DEFAULT_CAMERA.pixelSize)
		}
		if (full || name === 'CCD_EXPOSURE') {
			resetDeviceValue(this, device, 'exposure', DEFAULT_CAMERA.exposure)
			resetDeviceValue(this, device, 'exposuring', DEFAULT_CAMERA.exposuring)
		}
		if (full || name === 'CCD_COOLER_POWER') {
			resetDeviceValue(this, device, 'coolerPower', DEFAULT_CAMERA.coolerPower)
		}
		if (full || name === 'CCD_TEMPERATURE') {
			resetDeviceValue(this, device, 'hasCooler', DEFAULT_CAMERA.hasCooler)
			resetDeviceValue(this, device, 'canSetTemperature', DEFAULT_CAMERA.canSetTemperature)
		}
		if (full || name === 'CCD_FRAME') {
			resetDeviceValue(this, device, 'canSubFrame', DEFAULT_CAMERA.canSubFrame)
			resetDeviceValue(this, device, 'frame', DEFAULT_CAMERA.frame)
		}
		if (full || name === 'CCD_BINNING') {
			resetDeviceValue(this, device, 'canBin', DEFAULT_CAMERA.canBin)
			resetDeviceValue(this, device, 'bin', DEFAULT_CAMERA.bin)
		}
		// ZWO ASI, SVBony, etc
		if (full || name === 'CCD_CONTROLS') {
			resetDeviceValue(this, device, 'gain', DEFAULT_CAMERA.gain)
			resetDeviceValue(this, device, 'offset', DEFAULT_CAMERA.offset)
			this.#gain.delete(device)
			this.#offset.delete(device)
		}
		// CCD Simulator & Alpaca
		if (full || name === 'CCD_GAIN') {
			resetDeviceValue(this, device, 'gain', DEFAULT_CAMERA.gain)
			this.#gain.delete(device)
		}
		if (full || name === 'CCD_OFFSET') {
			resetDeviceValue(this, device, 'offset', DEFAULT_CAMERA.offset)
			this.#offset.delete(device)
		}
		if (full || name === 'CCD_CFA') {
			resetDeviceValue(this, device, 'cfa', DEFAULT_CAMERA.cfa)
		}

		super.delProperty(client, message)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/inditelescope.cpp

// ALIGNMENT_POINTSET_ACTION members supported by the manager. The vector is OneOfMany and the driver
// keeps the last selection, so every commit must be preceded by its own action.
type AlignmentPointSetAction = 'DELETE' | 'CLEAR' | 'LOAD DATABASE' | 'SAVE DATABASE'

// Element name of the ALIGNMENT_SUBSYSTEM_ACTIVE switch. INDI declares it with spaces, unlike every
// other alignment element, so it must be spelled exactly like this.
const ALIGNMENT_SUBSYSTEM_ACTIVE = 'ALIGNMENT SUBSYSTEM ACTIVE'

// Manager for mounts/telescopes. Command methods slew/sync/goto (converting target frames to the mount's
// equatorial frame), track, park/home, move axes, and pulse-guide; property handling maps coordinate,
// tracking, pier-side, site/time, and capability vectors onto the Mount state. Angles are radians.
// The INDI Alignment Subsystem is exposed as administrative commands over Mount.alignment.
export class MountManager extends DeviceManager<Mount> {
	// Tracks the driver's actual element name for the alignment subsystem's active switch. The read path
	// tolerates a driver that renamed it, so the write path must target the name really defined instead of
	// the INDI constant, which such a driver would ignore.
	readonly #alignmentActiveElements = new WeakMap<Mount, string>()

	tracking(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		client.sendSwitch({ device: mount.name, name: 'TELESCOPE_TRACK_STATE', elements: { [enable ? 'TRACK_ON' : 'TRACK_OFF']: true } })
	}

	park(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canPark) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_PARK', elements: { PARK: true } })
		}
	}

	unpark(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canPark) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_PARK', elements: { UNPARK: true } })
		}
	}

	setPark(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canSetPark) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_PARK_OPTION', elements: { PARK_CURRENT: true } })
		}
	}

	stop(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canAbort) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	home(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canHome) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_HOME', elements: { GO: true } })
		}
	}

	findHome(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canFindHome) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_HOME', elements: { FIND: true } })
		}
	}

	setHome(mount: Mount, client = mount[CLIENT]!) {
		if (mount.canSetHome) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_HOME', elements: { SET: true } })
		}
	}

	equatorialCoordinate(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		client.sendNumber({ device: mount.name, name: 'EQUATORIAL_EOD_COORD', elements: { RA: toHour(normalizeAngle(rightAscension)), DEC: toDeg(declination) } })
	}

	geographicCoordinate(mount: Mount, { latitude, longitude, elevation }: GeographicCoordinate, client = mount[CLIENT]!) {
		longitude = longitude < 0 ? longitude + TAU : longitude
		client.sendNumber({ device: mount.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: toDeg(latitude), LONG: toDeg(longitude), ELEV: toMeter(elevation) } })
	}

	time(mount: Mount, time: GPS['time'], client = mount[CLIENT]!) {
		const UTC = formatTemporal(time.utc, 'YYYY-MM-DDTHH:mm:ss')
		const OFFSET = (time.offset / 60).toString()
		client.sendText({ device: mount.name, name: 'TIME_UTC', elements: { UTC, OFFSET } })
	}

	syncTo(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		if (mount.canSync) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { SYNC: true } })
			this.equatorialCoordinate(mount, rightAscension, declination, client)
		}
	}

	goTo(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		if (mount.canGoTo) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { SLEW: true } })
			this.equatorialCoordinate(mount, rightAscension, declination, client)
		}
	}

	flipTo(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		if (mount.canFlip) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { FLIP: true } })
			this.equatorialCoordinate(mount, rightAscension, declination, client)
		}
	}

	moveTo(mount: Mount, mode: 'goto' | 'flip' | 'sync', req: MountTargetCoordinate<string | Angle>, client = mount[CLIENT]!, time?: Time) {
		const { type } = req
		const { x, y } = req[type]!
		const equatorial: [number, number] = [typeof x === 'string' ? parseAngle(x, type === 'JNOW' || type === 'J2000' ? true : undefined)! : x, typeof y === 'string' ? parseAngle(y)! : y]

		if (type === 'J2000') {
			Object.assign(equatorial, equatorialFromJ2000(...equatorial))
		} else if (type === 'ALTAZ') {
			Object.assign(equatorial, observedToCirs(...equatorial, time ?? timeNow(true), undefined, mount.geographicCoordinate))
		} else if (type === 'ECLIPTIC') {
			Object.assign(equatorial, eclipticToEquatorial(...equatorial, time ?? timeNow(true)))
		} else if (type === 'GALACTIC') {
			Object.assign(equatorial, equatorialFromJ2000(...galacticToEquatorial(...equatorial)))
		}

		if (mode === 'goto') this.goTo(mount, ...equatorial, client)
		else if (mode === 'flip') this.flipTo(mount, ...equatorial, client)
		else if (mode === 'sync') this.syncTo(mount, ...equatorial, client)
	}

	trackMode(mount: Mount, mode: TrackMode, client = mount[CLIENT]!) {
		if (mount.canTracking) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_TRACK_MODE', elements: { [`TRACK_${mode}`]: true } })
		}
	}

	slewRate(mount: Mount, rate: NameAndLabel | string, client = mount[CLIENT]!) {
		client.sendSwitch({ device: mount.name, name: 'TELESCOPE_SLEW_RATE', elements: { [typeof rate === 'string' ? rate : rate.name]: true } })
	}

	moveNorth(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: false } })
		}
	}

	moveSouth(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_SOUTH: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_SOUTH: false } })
		}
	}

	moveWest(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: false } })
		}
	}

	moveEast(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_EAST: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_EAST: false } })
		}
	}

	// Enables or disables the INDI Alignment Subsystem. No-op when the mount does not expose it or the
	// switch is read-only. Targets the element name the driver actually defined, so a driver that renamed
	// the INDI member — the same case the read path tolerates — is commanded instead of silently ignoring
	// an unknown member. The local `alignment.active` is not changed optimistically: it only follows the
	// driver's own set vector, since the driver may refuse the change.
	alignmentActive(mount: Mount, active: boolean, client = mount[CLIENT]!) {
		if (mount.alignment.available) {
			const element = this.#alignmentActiveElements.get(mount) ?? ALIGNMENT_SUBSYSTEM_ACTIVE
			client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_ACTIVE', elements: { [element]: active } })
		}
	}

	// Selects one of the math plugins advertised in `alignment.plugins`. Accepts the element itself or its
	// name. No-op for an unknown plugin, or when the vector is absent/read-only. The driver initialises the
	// newly loaded plugin with the current database, so no explicit initialize is issued here; a driver
	// that refuses the plugin reverts to its inbuilt one, which is why `alignment.plugin` is not set
	// optimistically.
	alignmentPlugin(mount: Mount, plugin: NameAndLabel | string, client = mount[CLIENT]!) {
		if (!mount.alignment.available) return

		const name = typeof plugin === 'string' ? plugin : plugin.name
		const { plugins } = mount.alignment

		for (let i = 0; i < plugins.length; i++) {
			if (plugins[i].name === name) {
				client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS', elements: { [name]: true } })
				return
			}
		}
	}

	// Re-initialises the current math plugin against the current alignment database. No-op when the mount
	// does not expose the subsystem or the momentary switch is absent/read-only. Used as the best-effort
	// tail of every database-mutating sequence, where its absence must not undo the action already sent.
	alignmentInitialize(mount: Mount, client = mount[CLIENT]!) {
		if (mount.alignment.available) {
			client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE', elements: { ALIGNMENT_SUBSYSTEM_MATH_PLUGIN_INITIALISE: true } })
		}
	}

	// Deletes the alignment point at `index` (0-based) and re-initialises the math plugin. No-op when the
	// index is not an integer within [0, pointCount), when the subsystem is unavailable, or when any of the
	// pointer/action/commit properties is absent or read-only. The bounds check is required: an index past
	// the end makes the driver delete a different entry or leave its pointer displaced, producing a
	// plausible-looking but wrong database. `pointCount` is not decremented locally; it follows the
	// driver's ALIGNMENT_POINTSET_SIZE.
	alignmentDeletePoint(mount: Mount, index: number, client = mount[CLIENT]!) {
		if (!Number.isInteger(index) || index < 0 || index >= mount.alignment.pointCount) return
		this.#alignmentAction(mount, 'DELETE', true, client, index)
	}

	// Deletes the last alignment point, if any. This is the primitive an application can use to undo a
	// mistaken SYNC, but only after confirming that the SYNC actually appended a point: not every driver
	// routes SYNC through the alignment database.
	alignmentDeleteLastPoint(mount: Mount, client = mount[CLIENT]!) {
		const { pointCount } = mount.alignment
		if (pointCount > 0) this.alignmentDeletePoint(mount, pointCount - 1, client)
	}

	// Deletes every alignment point and re-initialises the math plugin. `pointCount` is not zeroed locally.
	alignmentClear(mount: Mount, client = mount[CLIENT]!) {
		this.#alignmentAction(mount, 'CLEAR', true, client)
	}

	// Persists the in-memory alignment database to the driver's local storage. The math plugin is not
	// re-initialised because the in-memory database did not change.
	alignmentSave(mount: Mount, client = mount[CLIENT]!) {
		this.#alignmentAction(mount, 'SAVE DATABASE', false, client)
	}

	// Reloads the alignment database from the driver's local storage and re-initialises the math plugin.
	// The explicit initialize is idempotent and keeps the outcome deterministic across driver versions that
	// may or may not re-initialise on their own. The point count is not assumed to be preserved; it follows
	// the driver's ALIGNMENT_POINTSET_SIZE.
	alignmentLoad(mount: Mount, client = mount[CLIENT]!) {
		this.#alignmentAction(mount, 'LOAD DATABASE', true, client)
	}

	// Sends one pointset action followed by its commit, optionally preceded by the entry pointer and
	// followed by a math plugin re-initialisation. Every gate is evaluated before the first send, so the
	// sequence is all-or-nothing: sending the pointer before knowing the action is writable would leave the
	// driver's current entry displaced with no matching operation. `index` is assumed already validated by
	// the caller.
	#alignmentAction(mount: Mount, action: AlignmentPointSetAction, reinitialize: boolean, client: Client, index?: number) {
		if (!mount.alignment.available) return

		if (index !== undefined) {
			client.sendNumber({ device: mount.name, name: 'ALIGNMENT_POINTSET_CURRENT_ENTRY', elements: { ALIGNMENT_POINTSET_CURRENT_ENTRY: index } })
		}

		client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_POINTSET_ACTION', elements: { [action]: true } })
		client.sendSwitch({ device: mount.name, name: 'ALIGNMENT_POINTSET_COMMIT', elements: { ALIGNMENT_POINTSET_COMMIT: true } })

		if (reinitialize) this.alignmentInitialize(mount, client)
	}

	// Applies mount switch vectors: slew rate, track mode/state, pier side, park/park-option, abort, home,
	// slew-vs-sync mode, axis motion, and the alignment subsystem's active/math-plugin switches.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		const { elements } = message

		switch (message.name) {
			case 'ALIGNMENT_SUBSYSTEM_ACTIVE': {
				const { alignment } = device
				let updated = tag[0] === 'd' && handleSwitchValue(alignment, 'available', true, message.state)

				// Only a definition carries the driver's element names. The vector is AtMostOne with a single
				// member, so a renamed member is the first (and only) key.
				if (tag[0] === 'd') {
					const defined = ALIGNMENT_SUBSYSTEM_ACTIVE in elements ? ALIGNMENT_SUBSYSTEM_ACTIVE : Object.keys(elements)[0]
					if (defined !== undefined) this.#alignmentActiveElements.set(device, defined)
				}

				// The known element wins whenever it is present: an explicit Off must never be overridden by
				// the any-switch-on fallback, which only covers a driver that renamed the element.
				const element = elements[ALIGNMENT_SUBSYSTEM_ACTIVE]
				const active = element !== undefined ? element.value === true : findOnSwitch(message).length > 0

				updated = handleSwitchValue(alignment, 'active', active, message.state) || updated

				if (updated) this.updated(device, 'alignment', message.state)

				return
			}
			case 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS': {
				const { alignment } = device
				let updated = false

				if (tag[0] === 'd') {
					const plugins: NameAndLabel[] = []

					for (const key in elements) {
						const element = elements[key] as DefSwitch
						plugins.push({ name: element.name, label: element.label ?? element.name })
					}

					alignment.plugins = plugins
					updated = true
				}

				// The vector is OneOfMany and INDI always echoes every member, so "none on" really means no
				// plugin is selected. Assigned directly because handleTextValue cannot clear a field.
				const plugin = findOnSwitch(message)[0]

				if (alignment.plugin !== plugin) {
					alignment.plugin = plugin
					updated = true
				}

				if (updated || message.state === 'Alert') this.updated(device, 'alignment', message.state)

				return
			}
			case 'TELESCOPE_SLEW_RATE':
				if (tag[0] === 'd') {
					const rates: NameAndLabel[] = []

					for (const key in elements) {
						const element = elements[key] as DefSwitch
						rates.push({ name: element.name, label: element.label! })
					}

					if (rates.length > 0) {
						device.slewRates = rates
						this.updated(device, 'slewRates', message.state)
					}
				}

				for (const key in elements) {
					const element = elements[key]

					if (element.value) {
						if (device.slewRate !== element.name) {
							device.slewRate = element.name
							this.updated(device, 'slewRate', message.state)
						}

						break
					}
				}

				return
			case 'TELESCOPE_TRACK_MODE':
				if (tag[0] === 'd') {
					const modes: TrackMode[] = []

					for (const key in elements) {
						const element = elements[key] as DefSwitch
						modes.push(element.name.replace('TRACK_', '') as TrackMode)
					}

					if (modes.length > 0) {
						device.trackModes = modes
						this.updated(device, 'trackModes', message.state)
					}
				}

				for (const key in elements) {
					const element = elements[key]

					if (element.value) {
						const trackMode = element.name.replace('TRACK_', '') as TrackMode

						if (device.trackMode !== trackMode) {
							device.trackMode = trackMode
							this.updated(device, 'trackMode', message.state)
						}

						break
					}
				}

				return
			case 'TELESCOPE_TRACK_STATE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canTracking', (message as DefSwitchVector).permission !== 'ro')) {
						this.updated(device, 'canTracking', message.state)
					}
				}

				if (handleSwitchValue(device, 'tracking', elements.TRACK_ON?.value)) {
					this.updated(device, 'tracking', message.state)
				}

				return
			case 'TELESCOPE_PIER_SIDE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasPierSide', true)) {
						this.updated(device, 'hasPierSide', message.state)

						if (handleSwitchValue(device, 'canSetPierSide', (message as DefSwitchVector).permission !== 'ro')) {
							this.updated(device, 'canSetPierSide', message.state)
						}
					}
				}

				if (handleTextValue(device, 'pierSide', elements.PIER_WEST?.value === true ? 'WEST' : message.elements.PIER_EAST?.value === true ? 'EAST' : 'NEITHER')) {
					this.updated(device, 'pierSide', message.state)
				}

				return
			case 'TELESCOPE_PARK':
				handleParkable(this, device, message, tag)
				return
			case 'TELESCOPE_PARK_OPTION':
				if (tag[0] === 'd' && 'PARK_CURRENT' in elements) {
					if (handleSwitchValue(device, 'canSetPark', true)) {
						this.updated(device, 'canSetPark', message.state)
					}
				}

				return
			case 'TELESCOPE_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'TELESCOPE_HOME':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canHome', 'GO' in elements)) {
						this.updated(device, 'canHome', message.state)
					}

					if (handleSwitchValue(device, 'canFindHome', 'FIND' in elements)) {
						this.updated(device, 'canFindHome', message.state)
					}

					if (handleSwitchValue(device, 'canSetHome', 'SET' in elements)) {
						this.updated(device, 'canSetHome', message.state)
					}
				}

				if (elements.GO || elements.FIND) {
					if (handleSwitchValue(device, 'homing', message.state === 'Busy')) {
						this.updated(device, 'homing', message.state)
					}
				}

				return
			case 'ON_COORD_SET':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', 'SYNC' in elements)) {
						this.updated(device, 'canSync', message.state)
					}

					if (handleSwitchValue(device, 'canGoTo', 'SLEW' in elements)) {
						this.updated(device, 'canGoTo', message.state)
					}

					if (handleSwitchValue(device, 'canFlip', 'FLIP' in elements)) {
						this.updated(device, 'canFlip', message.state)
					}
				}

				return
			case 'TELESCOPE_MOTION_NS':
			case 'TELESCOPE_MOTION_WE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canMove', true)) {
						this.updated(device, 'canMove', message.state)
					}
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy' || findOnSwitch(message)[0] !== undefined)) {
					this.updated(device, 'moving', message.state)
				}
		}
	}

	// Applies mount number vectors: the equatorial (JNOW) coordinate and slewing state, the site geographic
	// coordinate, and the alignment point count.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'ALIGNMENT_POINTSET_SIZE': {
				const value = message.elements.ALIGNMENT_POINTSET_SIZE?.value

				// Protocol decoding boundary: Infinity would survive the clamp and leak into the public
				// state, and a NaN sample must be ignored rather than reset a known count to zero.
				if (value !== undefined && Number.isFinite(value)) {
					if (handleNumberValue(device.alignment, 'pointCount', value, message.state, alignmentPointCount)) {
						this.updated(device, 'alignment', message.state)
					}
				}

				return
			}
			case 'EQUATORIAL_EOD_COORD': {
				if (handleSwitchValue(device, 'slewing', message.state === 'Busy')) {
					this.updated(device, 'slewing', message.state)
				}

				const { equatorialCoordinate } = device

				let updated = handleNumberValue(equatorialCoordinate, 'rightAscension', message.elements.RA?.value, undefined, hour)
				updated = handleNumberValue(equatorialCoordinate, 'declination', message.elements.DEC?.value, undefined, deg) || updated

				if (updated) {
					this.updated(device, 'equatorialCoordinate', message.state)
				}

				return
			}
			case 'GEOGRAPHIC_COORD': {
				const { geographicCoordinate } = device

				let updated = handleNumberValue(geographicCoordinate, 'longitude', message.elements.LONG?.value, undefined, (value) => normalizePI(deg(value)))
				updated = handleNumberValue(geographicCoordinate, 'latitude', message.elements.LAT?.value, undefined, deg) || updated
				updated = handleNumberValue(geographicCoordinate, 'elevation', message.elements.ELEV?.value, undefined, meter) || updated

				if (updated) {
					this.updated(device, 'geographicCoordinate', message.state)
				}
			}
		}
	}

	// Creates/updates the mount from DRIVER_INFO and applies its UTC time/offset text vector.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.TELESCOPE)
		}

		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'TIME_UTC': {
				if (message.elements.UTC?.value) {
					const utc = parseTemporal(message.elements.UTC.value, 'YYYY-MM-DDTHH:mm:ss')
					const offset = parseUTCOffset(message.elements.OFFSET.value)

					let updated = handleNumberValue(device.time, 'utc', utc)
					updated = handleNumberValue(device.time, 'offset', offset) || updated

					if (updated) {
						this.updated(device, 'time', message.state)
					}
				}
			}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full) this.clearWritableProperty(device)
		else this.removeWritableProperty(device, name)

		if (full || name === 'ALIGNMENT_SUBSYSTEM_ACTIVE') this.#alignmentActiveElements.delete(device)

		if (full) {
			resetDeviceValue(this, device, 'alignment', DEFAULT_MOUNT.alignment)
		} else {
			// Partial resets cannot go through resetDeviceValue, which only replaces top-level device fields.
			const { alignment } = device
			let updated = false

			if (name === 'ALIGNMENT_SUBSYSTEM_ACTIVE') {
				updated = handleSwitchValue(alignment, 'available', false) || updated
				updated = handleSwitchValue(alignment, 'active', false) || updated
			}
			if (name === 'ALIGNMENT_SUBSYSTEM_MATH_PLUGINS') {
				if (alignment.plugins.length > 0) {
					alignment.plugins = DEFAULT_MOUNT.alignment.plugins
					updated = true
				}
				if (alignment.plugin !== undefined) {
					alignment.plugin = undefined
					updated = true
				}
			}
			if (name === 'ALIGNMENT_POINTSET_SIZE') {
				updated = handleNumberValue(alignment, 'pointCount', DEFAULT_MOUNT.alignment.pointCount) || updated
			}

			if (updated) this.updated(device, 'alignment')
		}

		if (full || name === 'TELESCOPE_SLEW_RATE') {
			resetDeviceValue(this, device, 'slewRates', DEFAULT_MOUNT.slewRates)
			resetDeviceValue(this, device, 'slewRate', undefined)
		}
		if (full || name === 'TELESCOPE_TRACK_MODE') {
			resetDeviceValue(this, device, 'trackModes', DEFAULT_MOUNT.trackModes)
			resetDeviceValue(this, device, 'trackMode', DEFAULT_MOUNT.trackMode)
		}
		if (full || name === 'TELESCOPE_TRACK_STATE') {
			resetDeviceValue(this, device, 'canTracking', DEFAULT_MOUNT.canTracking)
			resetDeviceValue(this, device, 'tracking', DEFAULT_MOUNT.tracking)
		}
		if (full || name === 'TELESCOPE_PIER_SIDE') {
			resetDeviceValue(this, device, 'hasPierSide', DEFAULT_MOUNT.hasPierSide)
			resetDeviceValue(this, device, 'canSetPierSide', DEFAULT_MOUNT.canSetPierSide)
			resetDeviceValue(this, device, 'pierSide', DEFAULT_MOUNT.pierSide)
		}
		if (full || name === 'TELESCOPE_PARK') {
			resetDeviceValue(this, device, 'canPark', DEFAULT_MOUNT.canPark)
			resetDeviceValue(this, device, 'parking', DEFAULT_MOUNT.parking)
			resetDeviceValue(this, device, 'parked', DEFAULT_MOUNT.parked)
		}
		if (full || name === 'TELESCOPE_PARK_OPTION') {
			resetDeviceValue(this, device, 'canSetPark', DEFAULT_MOUNT.canSetPark)
		}
		if (full || name === 'TELESCOPE_ABORT_MOTION') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_MOUNT.canAbort)
		}
		if (full || name === 'TELESCOPE_HOME') {
			resetDeviceValue(this, device, 'canHome', DEFAULT_MOUNT.canHome)
			resetDeviceValue(this, device, 'canFindHome', DEFAULT_MOUNT.canFindHome)
			resetDeviceValue(this, device, 'canSetHome', DEFAULT_MOUNT.canSetHome)
			resetDeviceValue(this, device, 'homing', DEFAULT_MOUNT.homing)
		}
		if (full || name === 'ON_COORD_SET') {
			resetDeviceValue(this, device, 'canSync', DEFAULT_MOUNT.canSync)
			resetDeviceValue(this, device, 'canGoTo', DEFAULT_MOUNT.canGoTo)
			resetDeviceValue(this, device, 'canFlip', DEFAULT_MOUNT.canFlip)
		}
		if (full || name === 'TELESCOPE_MOTION_NS' || name === 'TELESCOPE_MOTION_WE') {
			resetDeviceValue(this, device, 'moving', DEFAULT_MOUNT.moving)
			resetDeviceValue(this, device, 'canMove', DEFAULT_MOUNT.canMove)
		}
		if (full || name === 'EQUATORIAL_EOD_COORD') {
			resetDeviceValue(this, device, 'slewing', DEFAULT_MOUNT.slewing)
			resetDeviceValue(this, device, 'equatorialCoordinate', DEFAULT_MOUNT.equatorialCoordinate)
		}
		if (full || name === 'GEOGRAPHIC_COORD') {
			resetDeviceValue(this, device, 'geographicCoordinate', DEFAULT_MOUNT.geographicCoordinate)
		}
		if (full || name === 'TIME_UTC') {
			resetDeviceValue(this, device, 'time', DEFAULT_MOUNT.time)
		}

		super.delProperty(client, message)
	}
}

// INDI dome manager: maps heterogeneous dome properties into the shared dome model and sends commands
// in INDI units. Angles are converted between model radians and property degrees at this boundary.
export class DomeManager extends DeviceManager<Dome> {
	// Tracks park aliases for each dome without adding backend details to the model.
	readonly #parkProperties = new WeakMap<Dome, DomeParkProperties>()
	// Tracks the driver's actual element names for enabling and disabling slaving.
	readonly #slavingProperties = new WeakMap<Dome, DomeSlavingProperties>()

	// Slews to an absolute azimuth in radians, normalized to [0, TAU).
	moveTo(dome: Dome, azimuth: Angle, client = dome[CLIENT]!) {
		if (dome.canSetAzimuth && !dome.slaved) {
			client.sendNumber({ device: dome.name, name: 'ABS_DOME_POSITION', elements: { DOME_ABSOLUTE_POSITION: toDeg(normalizeAngle(azimuth)) } })
		}
	}

	// Slews to an absolute altitude in radians when the driver exposes the optional altitude vector.
	moveToAltitude(dome: Dome, altitude: Angle, client = dome[CLIENT]!) {
		if (dome.canSetAltitude && !dome.slaved) {
			client.sendNumber({ device: dome.name, name: 'DOME_ALTITUDE', elements: { DOME_ALTITUDE_VALUE: toDeg(altitude) } })
		}
	}

	// Moves the dome by a signed relative azimuth in radians without normalizing the delta.
	moveBy(dome: Dome, delta: Angle, client = dome[CLIENT]!) {
		if (dome.canRelativeMove && !dome.slaved) {
			client.sendNumber({ device: dome.name, name: 'REL_DOME_POSITION', elements: { DOME_RELATIVE_POSITION: toDeg(delta) } })
		}
	}

	// Starts or stops continuous clockwise/counter-clockwise dome motion.
	move(dome: Dome, direction: DomeDirection, enabled: boolean, client = dome[CLIENT]!) {
		if (dome.canMove && !dome.slaved) {
			client.sendSwitch({ device: dome.name, name: 'DOME_MOTION', elements: { [direction === 'CLOCKWISE' ? 'DOME_CW' : 'DOME_CCW']: enabled } })
		}
	}

	// Sets the dome rotation speed in RPM when the driver exposes a writable speed property.
	speed(dome: Dome, value: number, client = dome[CLIENT]!) {
		if (dome.canSetSpeed) {
			client.sendNumber({ device: dome.name, name: 'DOME_SPEED', elements: { DOME_SPEED_VALUE: value } })
		}
	}

	// Synchronizes the dome's reported azimuth in radians without starting a move.
	syncTo(dome: Dome, azimuth: Angle, client = dome[CLIENT]!) {
		if (dome.canSync && !dome.slaved) {
			client.sendNumber({ device: dome.name, name: 'DOME_SYNC', elements: { DOME_SYNC_VALUE: toDeg(normalizeAngle(azimuth)) } })
		}
	}

	// Starts a move to the configured home position.
	home(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canFindHome) {
			client.sendSwitch({ device: dome.name, name: 'DOME_GOTO', elements: { DOME_HOME: true } })
		}
	}

	// Starts a move to the configured park position using the driver's advertised park property.
	park(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canPark && !dome.slaved) {
			const name = this.#parkProperties.get(dome)?.park ?? 'DOME_PARK'
			client.sendSwitch({ device: dome.name, name, elements: { [name === 'DOME_PARK' ? 'PARK' : 'DOME_PARK']: true } })
		}
	}

	// Unparks only when the driver exposes an explicit writable UNPARK element.
	unpark(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canUnpark) {
			client.sendSwitch({ device: dome.name, name: 'DOME_PARK', elements: { UNPARK: true } })
		}
	}

	// Stores the current azimuth as the park position using the driver's preferred compatible mechanism.
	setPark(dome: Dome, client = dome[CLIENT]!) {
		if (!dome.canSetPark) return

		const azimuth = toDeg(normalizeAngle(dome.azimuth.value))

		if (this.hasWritableProperty(dome, 'DOME_PARK_OPTION')) {
			client.sendSwitch({ device: dome.name, name: 'DOME_PARK_OPTION', elements: { PARK_CURRENT: true } })
		} else if (this.hasWritableProperty(dome, 'DOME_PARK_POSITION')) {
			client.sendNumber({ device: dome.name, name: 'DOME_PARK_POSITION', elements: { PARK_AZ: azimuth } })
		} else if (this.hasWritableProperty(dome, 'DOME_PARAMS')) {
			client.sendNumber({ device: dome.name, name: 'DOME_PARAMS', elements: { PARK_POSITION: azimuth } })
		}
	}

	// Starts an asynchronous shutter opening operation.
	openShutter(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canSetShutter) {
			client.sendSwitch({ device: dome.name, name: 'DOME_SHUTTER', elements: { SHUTTER_OPEN: true } })
		}
	}

	// Starts an asynchronous shutter closing operation.
	closeShutter(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canSetShutter) {
			client.sendSwitch({ device: dome.name, name: 'DOME_SHUTTER', elements: { SHUTTER_CLOSE: true } })
		}
	}

	// Enables or disables driver-side slaving.
	slave(dome: Dome, enabled: boolean, client = dome[CLIENT]!) {
		const properties = this.#slavingProperties.get(dome)
		if (dome.canSlave && properties) {
			client.sendSwitch({ device: dome.name, name: 'DOME_AUTOSYNC', elements: { [enabled ? properties[0] : properties[1]]: true } })
		}
	}

	// Aborts any motion supported by the dome driver.
	stop(dome: Dome, client = dome[CLIENT]!) {
		if (dome.canAbort) {
			client.sendSwitch({ device: dome.name, name: 'DOME_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	// Enables or disables controller backlash compensation.
	backlash(dome: Dome, enabled: boolean, client = dome[CLIENT]!) {
		if (dome.hasBacklash) {
			client.sendSwitch({ device: dome.name, name: 'DOME_BACKLASH_TOGGLE', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	// Sets controller backlash in raw driver steps.
	backlashSteps(dome: Dome, steps: number, client = dome[CLIENT]!) {
		if (dome.hasBacklash) {
			client.sendNumber({ device: dome.name, name: 'DOME_BACKLASH_STEPS', elements: { DOME_BACKLASH_VALUE: steps } })
		}
	}

	// Applies dome switch vectors: motion, abort, shutter, home/park, slaving, backlash, and OTA side.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const dome = this.get(client, message.device)

		if (dome === undefined) return

		super.switchVector(client, message, tag)

		const definition = tag[0] === 'd' ? (message as DefSwitchVector) : undefined

		if (definition) {
			if (definition.permission !== 'ro') this.addWritableProperty(dome, message.name)
			else this.removeWritableProperty(dome, message.name)
		}

		switch (message.name) {
			case 'DOME_MOTION': {
				if (definition && handleSwitchValue(dome, 'canMove', definition.permission !== 'ro')) this.updated(dome, 'canMove', message.state)

				const selected = findOnSwitch(message).find((name) => name === 'DOME_CW' || name === 'DOME_CCW')
				const direction: DomeDirection | undefined = selected === 'DOME_CW' ? 'CLOCKWISE' : selected === 'DOME_CCW' ? 'COUNTER_CLOCKWISE' : undefined

				if (dome.direction !== direction || message.state === 'Alert') {
					dome.direction = direction
					this.updated(dome, 'direction', message.state)
				}

				if (handleSwitchValue(dome, 'moving', message.state === 'Busy')) this.updated(dome, 'moving', message.state)
				updateDomeSlewing(this, dome, message.state)
				return
			}
			case 'DOME_ABORT_MOTION':
				if (definition && handleSwitchValue(dome, 'canAbort', definition.permission !== 'ro')) this.updated(dome, 'canAbort', message.state)
				return
			case 'DOME_SHUTTER': {
				if (definition && handleSwitchValue(dome, 'hasShutter', true)) this.updated(dome, 'hasShutter', message.state)
				if (definition && handleSwitchValue(dome, 'canSetShutter', definition.permission !== 'ro')) this.updated(dome, 'canSetShutter', message.state)

				const shutterState = domeShutterState(message)
				if (dome.shutterState !== shutterState || message.state === 'Alert') {
					dome.shutterState = shutterState
					this.updated(dome, 'shutterState', message.state)
				}

				updateDomeSlewing(this, dome, message.state)
				return
			}
			case 'DOME_GOTO': {
				const hasHome = message.elements.DOME_HOME !== undefined
				const hasPark = message.elements.DOME_PARK !== undefined

				if (definition) {
					const parkProperties = this.#parkProperties.get(dome) ?? {}
					parkProperties.hasHome = hasHome
					if (hasPark && parkProperties.park === undefined) parkProperties.park = 'DOME_GOTO'
					this.#parkProperties.set(dome, parkProperties)
				}

				if (definition && handleSwitchValue(dome, 'canFindHome', hasHome && definition.permission !== 'ro')) this.updated(dome, 'canFindHome', message.state)
				if (definition && hasPark && handleSwitchValue(dome, 'canPark', definition.permission !== 'ro')) this.updated(dome, 'canPark', message.state)

				const home = message.elements.DOME_HOME?.value === true
				const parked = message.elements.DOME_PARK?.value === true
				const completed = message.state !== 'Busy' && message.state !== 'Alert'
				if (handleSwitchValue(dome, 'homing', home && message.state === 'Busy')) this.updated(dome, 'homing', message.state)
				if (handleSwitchValue(dome, 'atHome', home && completed)) this.updated(dome, 'atHome', message.state)

				if (hasPark) {
					if (handleSwitchValue(dome, 'parking', parked && message.state === 'Busy')) this.updated(dome, 'parking', message.state)
					if (handleSwitchValue(dome, 'parked', parked && completed)) this.updated(dome, 'parked', message.state)
				}

				updateDomeSlewing(this, dome, message.state)
				return
			}
			case 'DOME_PARK': {
				const hasPark = message.elements.PARK !== undefined
				const hasUnpark = message.elements.UNPARK !== undefined

				if (definition) {
					this.#parkProperties.set(dome, { park: 'DOME_PARK', hasHome: this.#parkProperties.get(dome)?.hasHome })
				}

				if (definition && handleSwitchValue(dome, 'canPark', hasPark && definition.permission !== 'ro')) this.updated(dome, 'canPark', message.state)
				if (definition && handleSwitchValue(dome, 'canUnpark', hasUnpark && definition.permission !== 'ro')) this.updated(dome, 'canUnpark', message.state)

				const parked = message.elements.PARK?.value === true
				const completed = message.state !== 'Busy' && message.state !== 'Alert'
				if (handleSwitchValue(dome, 'parking', parked && message.state === 'Busy')) this.updated(dome, 'parking', message.state)
				if (handleSwitchValue(dome, 'parked', parked && completed)) this.updated(dome, 'parked', message.state)

				updateDomeSlewing(this, dome, message.state)
				return
			}
			case 'DOME_AUTOSYNC': {
				if (definition) {
					const enabled = message.elements.INDI_ENABLED !== undefined ? 'INDI_ENABLED' : message.elements.ENABLE !== undefined ? 'ENABLE' : undefined
					const disabled = message.elements.INDI_DISABLED !== undefined ? 'INDI_DISABLED' : message.elements.DISABLE !== undefined ? 'DISABLE' : undefined

					if (enabled !== undefined && disabled !== undefined) this.#slavingProperties.set(dome, [enabled, disabled])
					else this.#slavingProperties.delete(dome)

					if (handleSwitchValue(dome, 'canSlave', enabled !== undefined && disabled !== undefined && definition.permission !== 'ro')) this.updated(dome, 'canSlave', message.state)
				}

				const enabled = this.#slavingProperties.get(dome)?.[0]
				const slaved = enabled === undefined ? (message.elements.INDI_ENABLED?.value ?? message.elements.ENABLE?.value) : message.elements[enabled]?.value
				if (slaved !== undefined && handleSwitchValue(dome, 'slaved', slaved)) this.updated(dome, 'slaved', message.state)
				return
			}
			case 'DOME_PARK_OPTION':
				if (definition && handleSwitchValue(dome, 'canSetPark', message.elements.PARK_CURRENT !== undefined && definition.permission !== 'ro')) this.updated(dome, 'canSetPark', message.state)
				return
			case 'DOME_BACKLASH_TOGGLE':
				if (definition && handleSwitchValue(dome, 'hasBacklash', definition.permission !== 'ro')) this.updated(dome, 'hasBacklash', message.state)
				if (handleSwitchValue(dome, 'backlashEnabled', message.elements.INDI_ENABLED?.value ?? message.elements.ENABLE?.value)) this.updated(dome, 'backlashEnabled', message.state)
				return
			case 'DM_OTA_SIDE': {
				const side = domeOTASide(message)
				if (dome.measurements.otaSide !== side || message.state === 'Alert') {
					dome.measurements.otaSide = side
					this.updated(dome, 'measurements', message.state)
				}
			}
		}
	}

	// Applies dome number vectors, converting angular values from degrees into model radians.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const dome = this.get(client, message.device)

		if (dome === undefined) return

		const definition = tag[0] === 'd' ? (message as DefNumberVector) : undefined

		if (definition) {
			if (definition.permission !== 'ro') this.addWritableProperty(dome, message.name)
			else this.removeWritableProperty(dome, message.name)
		}

		switch (message.name) {
			case 'ABS_DOME_POSITION':
				if (definition && handleSwitchValue(dome, 'canSetAzimuth', definition.permission !== 'ro')) this.updated(dome, 'canSetAzimuth', message.state)
				if (handleMinMaxValue(dome.azimuth, domeAngleNumber(message.elements.DOME_ABSOLUTE_POSITION), tag)) this.updated(dome, 'azimuth', message.state)
				if (handleSwitchValue(dome, 'moving', message.state === 'Busy')) this.updated(dome, 'moving', message.state)
				updateDomeSlewing(this, dome, message.state)
				return
			case 'REL_DOME_POSITION':
				if (definition && handleSwitchValue(dome, 'canRelativeMove', definition.permission !== 'ro')) this.updated(dome, 'canRelativeMove', message.state)
				return
			case 'DOME_SPEED':
				if (definition && handleSwitchValue(dome, 'canSetSpeed', definition.permission !== 'ro')) this.updated(dome, 'canSetSpeed', message.state)
				if (handleMinMaxValue(dome.speed, message.elements.DOME_SPEED_VALUE, tag)) this.updated(dome, 'speed', message.state)
				return
			case 'DOME_SYNC':
				if (definition && handleSwitchValue(dome, 'canSync', definition.permission !== 'ro')) this.updated(dome, 'canSync', message.state)
				return
			case 'DOME_ALTITUDE':
				if (definition && handleSwitchValue(dome, 'canSetAltitude', definition.permission !== 'ro')) this.updated(dome, 'canSetAltitude', message.state)
				if (handleMinMaxValue(dome.altitude, domeAngleNumber(message.elements.DOME_ALTITUDE_VALUE), tag)) this.updated(dome, 'altitude', message.state)
				if (handleSwitchValue(dome, 'moving', message.state === 'Busy')) this.updated(dome, 'moving', message.state)
				updateDomeSlewing(this, dome, message.state)
				return
			case 'DOME_PARK_POSITION':
				if (definition && message.elements.PARK_AZ && handleSwitchValue(dome, 'canSetPark', definition.permission !== 'ro')) this.updated(dome, 'canSetPark', message.state)
				if (handleMinMaxValue(dome.parkPosition, domeAngleNumber(message.elements.PARK_AZ), tag)) this.updated(dome, 'parkPosition', message.state)
				return
			case 'DOME_PARAMS': {
				const home = message.elements.HOME_POSITION
				const park = message.elements.PARK_POSITION
				const threshold = message.elements.AUTOSYNC_THRESHOLD

				if (definition && park && handleSwitchValue(dome, 'canSetPark', definition.permission !== 'ro')) this.updated(dome, 'canSetPark', message.state)
				if (handleMinMaxValue(dome.homePosition, domeAngleNumber(home), tag)) this.updated(dome, 'homePosition', message.state)
				if (handleMinMaxValue(dome.parkPosition, domeAngleNumber(park), tag)) this.updated(dome, 'parkPosition', message.state)
				if (handleMinMaxValue(dome.autoSyncThreshold, domeAngleNumber(threshold), tag)) this.updated(dome, 'autoSyncThreshold', message.state)
				return
			}
			case 'DOME_BACKLASH_STEPS':
				if (handleMinMaxValue(dome.backlash, message.elements.DOME_BACKLASH_VALUE, tag)) this.updated(dome, 'backlash', message.state)
				return
			case 'DOME_MEASUREMENTS': {
				const fields: readonly [keyof Omit<Dome['measurements'], 'otaSide'>, string][] = [
					['radius', 'DOME_RADIUS'],
					['shutterWidth', 'DOME_SHUTTER_WIDTH'],
					['northDisplacement', 'DOME_NORTH_DISPLACEMENT'],
					['eastDisplacement', 'DOME_EAST_DISPLACEMENT'],
					['upDisplacement', 'DOME_UP_DISPLACEMENT'],
					['otaOffset', 'DOME_OTA_OFFSET'],
				]
				let updated = false

				for (const [field, elementName] of fields) {
					const element = message.elements[elementName]
					if (element !== undefined && dome.measurements[field] !== element.value) {
						dome.measurements[field] = element.value
						updated = true
					}
				}

				if (definition && handleSwitchValue(dome, 'hasMeasurements', true)) updated = true
				if (updated || message.state === 'Alert') this.updated(dome, 'measurements', message.state)
			}
		}
	}

	// Creates or updates a dome when its DRIVER_INFO advertises the DOME interface.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') this.handleDriverInfo(client, message, DeviceInterfaceType.DOME)
	}

	// Resets dome fields affected by a deleted INDI property and removes the device on full deletion.
	delProperty(client: Client, message: DelProperty) {
		const dome = this.get(client, message.device)

		if (dome === undefined) return

		const name = message.name
		const full = !name

		if (full) {
			this.#parkProperties.delete(dome)
			this.#slavingProperties.delete(dome)
			this.clearWritableProperty(dome)
		} else {
			this.removeWritableProperty(dome, name)

			const parkProperties = this.#parkProperties.get(dome)
			if (name === 'DOME_PARK' && parkProperties?.park === 'DOME_PARK') parkProperties.park = undefined
			if (name === 'DOME_GOTO' && parkProperties?.park === 'DOME_GOTO') parkProperties.park = undefined
			if (name === 'DOME_GOTO' && parkProperties) parkProperties.hasHome = false
			if (name === 'DOME_AUTOSYNC') this.#slavingProperties.delete(dome)
		}

		if (full || name === 'DOME_MOTION') {
			resetDeviceValue(this, dome, 'canMove', DEFAULT_DOME.canMove)
			resetDeviceValue(this, dome, 'moving', DEFAULT_DOME.moving)
			resetDeviceValue(this, dome, 'direction', DEFAULT_DOME.direction)
		}
		if (full || name === 'REL_DOME_POSITION') resetDeviceValue(this, dome, 'canRelativeMove', DEFAULT_DOME.canRelativeMove)
		if (full || name === 'ABS_DOME_POSITION') {
			resetDeviceValue(this, dome, 'canSetAzimuth', DEFAULT_DOME.canSetAzimuth)
			resetDeviceValue(this, dome, 'azimuth', DEFAULT_DOME.azimuth)
			resetDeviceValue(this, dome, 'moving', DEFAULT_DOME.moving)
		}
		if (full || name === 'DOME_SPEED') {
			resetDeviceValue(this, dome, 'canSetSpeed', DEFAULT_DOME.canSetSpeed)
			resetDeviceValue(this, dome, 'speed', DEFAULT_DOME.speed)
		}
		if (full || name === 'DOME_ABORT_MOTION') resetDeviceValue(this, dome, 'canAbort', DEFAULT_DOME.canAbort)
		if (full || name === 'DOME_SHUTTER') {
			resetDeviceValue(this, dome, 'hasShutter', DEFAULT_DOME.hasShutter)
			resetDeviceValue(this, dome, 'canSetShutter', DEFAULT_DOME.canSetShutter)
			resetDeviceValue(this, dome, 'shutterState', DEFAULT_DOME.shutterState)
		}
		if (full || name === 'DOME_GOTO') {
			resetDeviceValue(this, dome, 'canFindHome', DEFAULT_DOME.canFindHome)
			resetDeviceValue(this, dome, 'homing', DEFAULT_DOME.homing)
			resetDeviceValue(this, dome, 'atHome', DEFAULT_DOME.atHome)
			if (this.#parkProperties.get(dome)?.park === undefined) {
				resetDeviceValue(this, dome, 'canPark', DEFAULT_DOME.canPark)
				resetDeviceValue(this, dome, 'parking', DEFAULT_DOME.parking)
				resetDeviceValue(this, dome, 'parked', DEFAULT_DOME.parked)
			}
		}
		if (full || name === 'DOME_PARK') {
			resetDeviceValue(this, dome, 'canUnpark', DEFAULT_DOME.canUnpark)
			if (this.#parkProperties.get(dome)?.park !== 'DOME_GOTO') {
				resetDeviceValue(this, dome, 'canPark', DEFAULT_DOME.canPark)
				resetDeviceValue(this, dome, 'parking', DEFAULT_DOME.parking)
				resetDeviceValue(this, dome, 'parked', DEFAULT_DOME.parked)
			}
		}
		if (full || name === 'DOME_PARK_OPTION' || name === 'DOME_PARK_POSITION' || name === 'DOME_PARAMS') resetDeviceValue(this, dome, 'canSetPark', DEFAULT_DOME.canSetPark)
		if (full || name === 'DOME_PARK_POSITION' || name === 'DOME_PARAMS') resetDeviceValue(this, dome, 'parkPosition', DEFAULT_DOME.parkPosition)
		if (full || name === 'DOME_PARAMS') {
			resetDeviceValue(this, dome, 'homePosition', DEFAULT_DOME.homePosition)
			resetDeviceValue(this, dome, 'autoSyncThreshold', DEFAULT_DOME.autoSyncThreshold)
		}
		if (full || name === 'DOME_SYNC') resetDeviceValue(this, dome, 'canSync', DEFAULT_DOME.canSync)
		if (full || name === 'DOME_ALTITUDE') {
			resetDeviceValue(this, dome, 'canSetAltitude', DEFAULT_DOME.canSetAltitude)
			resetDeviceValue(this, dome, 'altitude', DEFAULT_DOME.altitude)
		}
		if (full || name === 'DOME_AUTOSYNC') {
			resetDeviceValue(this, dome, 'canSlave', DEFAULT_DOME.canSlave)
			resetDeviceValue(this, dome, 'slaved', DEFAULT_DOME.slaved)
		}
		if (full || name === 'DOME_BACKLASH_TOGGLE') {
			resetDeviceValue(this, dome, 'hasBacklash', DEFAULT_DOME.hasBacklash)
			resetDeviceValue(this, dome, 'backlashEnabled', DEFAULT_DOME.backlashEnabled)
		}
		if (full || name === 'DOME_BACKLASH_STEPS') resetDeviceValue(this, dome, 'backlash', DEFAULT_DOME.backlash)
		if (full || name === 'DOME_MEASUREMENTS') {
			resetDeviceValue(this, dome, 'hasMeasurements', DEFAULT_DOME.hasMeasurements)
			resetDeviceValue(this, dome, 'measurements', DEFAULT_DOME.measurements)
		}
		if (full || name === 'DM_OTA_SIDE') {
			resetDeviceValue(this, dome, 'measurements', { ...dome.measurements, otaSide: DEFAULT_DOME.measurements.otaSide })
		}

		updateDomeSlewing(this, dome)
		super.delProperty(client, message)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indifilterwheel.cpp

// Manager for filter wheels; moves to a slot and edits filter names, reflecting slot count/position.
export class WheelManager extends DeviceManager<Wheel> {
	moveTo(wheel: Wheel, slot: number, client = wheel[CLIENT]!) {
		client.sendNumber({ device: wheel.name, name: 'FILTER_SLOT', elements: { FILTER_SLOT_VALUE: slot + 1 } })
	}

	slots(wheel: Wheel, names: readonly string[], client = wheel[CLIENT]!) {
		const elements: Record<string, string> = {}
		for (let i = 0; i < names.length; i++) elements[`FILTER_SLOT_NAME_${i + 1}`] = names[i]
		client.sendText({ device: wheel.name, name: 'FILTER_NAME', elements })
	}

	// Applies the filter-slot number vector: slot count, current position (converted to 0-based), and
	// moving state.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FILTER_SLOT':
				if (tag[0] === 'd') {
					if (handleNumberValue(device, 'count', (message as DefNumberVector).elements.FILTER_SLOT_VALUE.max)) {
						this.updated(device, 'count', message.state)
					}
				}

				if (handleNumberValue(device, 'position', message.elements.FILTER_SLOT_VALUE.value - 1)) {
					this.updated(device, 'position', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}
		}
	}

	// Creates/updates the wheel from DRIVER_INFO and applies its filter-name list text vector.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.FILTER)
		}

		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FILTER_NAME': {
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSetNames', (message as DefTextVector).permission !== 'ro')) {
						this.updated(device, 'canSetNames', message.state)
					}
				}

				const names = Object.values(message.elements)

				if (names.length !== device.names.length || names.some((e, index) => e.value !== device.names[index])) {
					device.names = names.map((e) => e.value)
					this.updated(device, 'names', message.state)
				}
			}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'FILTER_SLOT') {
			resetDeviceValue(this, device, 'count', DEFAULT_WHEEL.count)
			resetDeviceValue(this, device, 'position', DEFAULT_WHEEL.position)
			resetDeviceValue(this, device, 'moving', DEFAULT_WHEEL.moving)
		}
		if (full || name === 'FILTER_NAME') {
			resetDeviceValue(this, device, 'canSetNames', DEFAULT_WHEEL.canSetNames)
			resetDeviceValue(this, device, 'names', DEFAULT_WHEEL.names)
		}

		super.delProperty(client, message)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indifocuserinterface.cpp

// Manager for focusers; absolute/relative move, sync, reverse, and abort, reflecting position (steps),
// motion, and temperature.
export class FocuserManager extends DeviceManager<Focuser> {
	stop(focuser: Focuser, client = focuser[CLIENT]!) {
		if (focuser.canAbort) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	moveIn(focuser: Focuser, steps: number, client = focuser[CLIENT]!) {
		if (focuser.canRelativeMove) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_INWARD: true } })
			client.sendNumber({ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: steps } })
		}
	}

	moveOut(focuser: Focuser, steps: number, client = focuser[CLIENT]!) {
		if (focuser.canRelativeMove) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_OUTWARD: true } })
			client.sendNumber({ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: steps } })
		}
	}

	moveTo(focuser: Focuser, position: number, client = focuser[CLIENT]!) {
		if (focuser.canAbsoluteMove) {
			client.sendNumber({ device: focuser.name, name: 'ABS_FOCUS_POSITION', elements: { FOCUS_ABSOLUTE_POSITION: position } })
		}
	}

	syncTo(focuser: Focuser, position: number, client = focuser[CLIENT]!) {
		if (focuser.canSync) {
			client.sendNumber({ device: focuser.name, name: 'FOCUS_SYNC', elements: { FOCUS_SYNC_VALUE: position } })
		}
	}

	reverse(focuser: Focuser, enabled: boolean, client = focuser[CLIENT]!) {
		if (focuser.canReverse) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_REVERSE_MOTION', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	// Applies focuser switch vectors: abort capability and reverse capability/state.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'FOCUS_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'FOCUS_REVERSE_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canReverse', true)) {
						this.updated(device, 'canReverse', message.state)
					}
				}

				if (handleSwitchValue(device, 'reversed', message.elements.INDI_ENABLED?.value)) {
					this.updated(device, 'reversed', message.state)
				}
		}
	}

	// Applies focuser number vectors: sync/relative/absolute capabilities, the absolute position (steps),
	// and moving state.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FOCUS_SYNC':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', true)) {
						this.updated(device, 'canSync', message.state)
					}
				}

				return
			case 'REL_FOCUS_POSITION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canRelativeMove', true)) {
						this.updated(device, 'canRelativeMove', message.state)
					}
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}

				return
			case 'ABS_FOCUS_POSITION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbsoluteMove', true)) {
						this.updated(device, 'canAbsoluteMove', message.state)
					}
				}

				if (handleMinMaxValue(device.position, message.elements.FOCUS_ABSOLUTE_POSITION, tag)) {
					this.updated(device, 'position', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}
		}
	}

	// Creates/updates the focuser from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.FOCUSER)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'FOCUS_ABORT_MOTION') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_FOCUSER.canAbort)
		}
		if (full || name === 'FOCUS_REVERSE_MOTION') {
			resetDeviceValue(this, device, 'canReverse', DEFAULT_FOCUSER.canReverse)
			resetDeviceValue(this, device, 'reversed', DEFAULT_FOCUSER.reversed)
		}
		if (full || name === 'FOCUS_SYNC') {
			resetDeviceValue(this, device, 'canSync', DEFAULT_FOCUSER.canSync)
		}
		if (full || name === 'REL_FOCUS_POSITION') {
			resetDeviceValue(this, device, 'canRelativeMove', DEFAULT_FOCUSER.canRelativeMove)
			resetDeviceValue(this, device, 'moving', DEFAULT_FOCUSER.moving)
		}
		if (full || name === 'ABS_FOCUS_POSITION') {
			resetDeviceValue(this, device, 'canAbsoluteMove', DEFAULT_FOCUSER.canAbsoluteMove)
			resetDeviceValue(this, device, 'position', DEFAULT_FOCUSER.position)
			resetDeviceValue(this, device, 'moving', DEFAULT_FOCUSER.moving)
		}

		super.delProperty(client, message)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indidustcapinterface.cpp

// Manager for telescope covers/dust caps; park (close)/unpark (open) and abort, reflecting cover state.
export class CoverManager extends DeviceManager<Cover> {
	unpark(cover: Cover, client = cover[CLIENT]!) {
		if (cover.canPark) {
			client.sendSwitch({ device: cover.name, name: 'CAP_PARK', elements: { UNPARK: true } })
		}
	}

	park(cover: Cover, client = cover[CLIENT]!) {
		if (cover.canPark) {
			client.sendSwitch({ device: cover.name, name: 'CAP_PARK', elements: { PARK: true } })
		}
	}

	stop(cover: Cover, client = cover[CLIENT]!) {
		if (cover.canAbort) {
			client.sendSwitch({ device: cover.name, name: 'CAP_ABORT', elements: { ABORT: true } })
		}
	}

	// Applies cover switch vectors: park (open/close) state and abort capability.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'CAP_PARK':
				handleParkable(this, device, message, tag)
				return
			case 'CAP_ABORT':
				if (handleSwitchValue(device, 'canAbort', true)) {
					this.updated(device, 'canAbort', message.state)
				}
		}
	}

	// Creates/updates the cover from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.DUSTCAP)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'CAP_PARK') {
			resetDeviceValue(this, device, 'canPark', DEFAULT_COVER.canPark)
			resetDeviceValue(this, device, 'parking', DEFAULT_COVER.parking)
			resetDeviceValue(this, device, 'parked', DEFAULT_COVER.parked)
		}
		if (full || name === 'CAP_ABORT') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_COVER.canAbort)
		}

		super.delProperty(client, message)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indirotatorinterface.cpp

// Manager for field rotators; goto/sync angle (degrees), reverse, home, and abort, reflecting angle/motion.
export class RotatorManager extends DeviceManager<Rotator> {
	moveTo(rotator: Rotator, angle: number, client = rotator[CLIENT]!) {
		client.sendNumber({ device: rotator.name, name: 'ABS_ROTATOR_ANGLE', elements: { ANGLE: angle } })
	}

	syncTo(rotator: Rotator, angle: number, client = rotator[CLIENT]!) {
		if (rotator.canSync) {
			client.sendNumber({ device: rotator.name, name: 'SYNC_ROTATOR_ANGLE', elements: { ANGLE: angle } })
		}
	}

	home(rotator: Rotator, client = rotator[CLIENT]!) {
		if (rotator.canHome) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_HOME', elements: { HOME: true } })
		}
	}

	reverse(rotator: Rotator, enabled: boolean, client = rotator[CLIENT]!) {
		if (rotator.canReverse) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_REVERSE', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	stop(rotator: Rotator, client = rotator[CLIENT]!) {
		if (rotator.canAbort) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	// Applies rotator switch vectors: abort, home, and reverse capabilities/state, and backlash compensation.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'ROTATOR_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'ROTATOR_HOME':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canHome', true)) {
						this.updated(device, 'canHome', message.state)
					}
				}

				return
			case 'ROTATOR_REVERSE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canReverse', true)) {
						this.updated(device, 'canReverse', message.state)
					}
				}

				if (handleSwitchValue(device, 'reversed', message.elements.INDI_ENABLED?.value)) {
					this.updated(device, 'reversed', message.state)
				}

				return
			case 'ROTATOR_BACKLASH_TOGGLE':
				if (handleSwitchValue(device, 'hasBacklashCompensation', message.elements.INDI_ENABLED?.value)) {
					this.updated(device, 'hasBacklashCompensation', message.state)
				}
		}
	}

	// Applies rotator number vectors: the absolute angle (degrees)/moving state and sync capability.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'ABS_ROTATOR_ANGLE':
				if (handleMinMaxValue(device.angle, message.elements.ANGLE, tag)) {
					this.updated(device, 'angle', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}

				return
			case 'SYNC_ROTATOR_ANGLE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', true)) {
						this.updated(device, 'canSync', message.state)
					}
				}
		}
	}

	// Creates/updates the rotator from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.ROTATOR)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'ROTATOR_ABORT_MOTION') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_ROTATOR.canAbort)
		}
		if (full || name === 'ROTATOR_HOME') {
			resetDeviceValue(this, device, 'canHome', DEFAULT_ROTATOR.canHome)
		}
		if (full || name === 'ROTATOR_REVERSE') {
			resetDeviceValue(this, device, 'canReverse', DEFAULT_ROTATOR.canReverse)
			resetDeviceValue(this, device, 'reversed', DEFAULT_ROTATOR.reversed)
		}
		if (full || name === 'ROTATOR_BACKLASH_TOGGLE') {
			resetDeviceValue(this, device, 'hasBacklashCompensation', DEFAULT_ROTATOR.hasBacklashCompensation)
		}
		if (full || name === 'ABS_ROTATOR_ANGLE') {
			resetDeviceValue(this, device, 'angle', DEFAULT_ROTATOR.angle)
			resetDeviceValue(this, device, 'moving', DEFAULT_ROTATOR.moving)
		}
		if (full || name === 'SYNC_ROTATOR_ANGLE') {
			resetDeviceValue(this, device, 'canSync', DEFAULT_ROTATOR.canSync)
		}

		super.delProperty(client, message)
	}
}

// Manager for dew heaters; sets and reflects the heater duty cycle (percent).
export class DewHeaterManager extends DeviceManager<DewHeater> {
	readonly #pwm = new WeakMap<DewHeater, readonly [string, string]>()

	constructor(readonly provider: DeviceProvider<DewHeater>) {
		super()
	}

	dutyCycle(heater: DewHeater, value: number, client = heater[CLIENT]!) {
		const property = this.#pwm.get(heater)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: heater.name, name, elements: { [element]: value } })
		}
	}

	#addProxy(client: Client, parent: DewHeater, message: DefSwitchVector | SetNumberVector) {
		const id = makeDeviceId(client, 'dewHeater', parent.name)
		const device = proxyDevice(parent, id, 'dewHeater')

		if (this.add(device)) {
			this.updated(device, 'hasDewHeater', message.state)
			this.updated(parent, 'hasDewHeater', message.state)
			this.#pwm.set(device, [message.name, 'Heater'])
		}

		return device
	}

	// Forwards only the driver/connection and heater vectors to the base property tracking.
	vector(client: Client, message: DefVector | SetVector, tag: string) {
		switch (message.name) {
			case 'DRIVER_INFO':
			case 'CONNECTION':
			case 'Heater':
				return super.vector(client, message, tag)
		}
	}

	// Applies the heater duty-cycle number vector, lazily creating a dew-heater proxy over a parent device
	// that exposes a heater channel.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			// WandererCover V4 EC
			case 'Heater': {
				let device = this.get(client, message.device)

				if (device === undefined && tag[0] === 'd') {
					const parent = this.provider.get(client, message.device)

					if (parent !== undefined && handleSwitchValue(parent, 'hasDewHeater', true)) {
						device = this.#addProxy(client, parent, message)
					}
				}

				if (device !== undefined) {
					if (handleMinMaxValue(device.dutyCycle, message.elements.Heater, tag)) {
						this.updated(device, 'dutyCycle', message.state)

						const parent = (device as SubDevice<DewHeater, DewHeater>).parent
						this.updated(parent, 'dutyCycle', message.state)
					}
				}
			}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'Heater') {
			resetDeviceValue(this, device, 'hasDewHeater', DEFAULT_DEW_HEATER.hasDewHeater)
			resetDeviceValue(this, device, 'dutyCycle', DEFAULT_DEW_HEATER.dutyCycle)

			const parent = (device as SubDevice<DewHeater, DewHeater>).parent
			this.updated(parent, 'hasDewHeater')
			this.updated(parent, 'dutyCycle')

			this.#pwm.delete(device)

			// Force remove the device passing name as undefined.
			super.delProperty(client, full ? message : { ...message, name: undefined })
			return
		}

		super.delProperty(client, message)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indilightboxinterface.cpp

// Manager for flat-field light panels; enable/disable and set intensity, reflecting panel state.
export class FlatPanelManager extends DeviceManager<FlatPanel> {
	intensity(panel: FlatPanel, value: number, client = panel[CLIENT]!) {
		client.sendNumber({ device: panel.name, name: 'FLAT_LIGHT_INTENSITY', elements: { FLAT_LIGHT_INTENSITY_VALUE: value } })
	}

	enable(panel: FlatPanel, client = panel[CLIENT]!) {
		client.sendSwitch({ device: panel.name, name: 'FLAT_LIGHT_CONTROL', elements: { FLAT_LIGHT_ON: true } })
	}

	disable(panel: FlatPanel, client = panel[CLIENT]!) {
		client.sendSwitch({ device: panel.name, name: 'FLAT_LIGHT_CONTROL', elements: { FLAT_LIGHT_OFF: true } })
	}

	toggle(panel: FlatPanel, client = panel[CLIENT]!) {
		panel.enabled ? this.disable(panel, client) : this.enable(panel, client)
	}

	// Applies the flat-panel light on/off switch vector (enabled state).
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'FLAT_LIGHT_CONTROL':
				if (handleSwitchValue(device, 'enabled', message.elements.FLAT_LIGHT_ON?.value)) {
					this.updated(device, 'enabled', message.state)
				}
		}
	}

	// Applies the flat-panel brightness/intensity number vector.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FLAT_LIGHT_INTENSITY':
				if (handleMinMaxValue(device.intensity, message.elements.FLAT_LIGHT_INTENSITY_VALUE, tag)) {
					this.updated(device, 'intensity', message.state)
				}
		}
	}

	// Creates/updates the flat panel from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.LIGHTBOX)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'FLAT_LIGHT_CONTROL') {
			resetDeviceValue(this, device, 'enabled', DEFAULT_FLAT_PANEL.enabled)
		}
		if (full || name === 'FLAT_LIGHT_INTENSITY') {
			resetDeviceValue(this, device, 'intensity', DEFAULT_FLAT_PANEL.intensity)
		}

		super.delProperty(client, message)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indipowerinterface.cpp

// Manager for power-distribution devices; toggles/sets DC, dew, variable-voltage, USB, and auto-dew
// channels and reflects aggregate voltage/current/power plus per-channel state.
export class PowerManager extends DeviceManager<Power> {
	toggle(power: Power, channel: PowerChannel, value: boolean, client = power[CLIENT]!) {
		const name = channel.type === 'dc' ? 'POWER_CHANNELS' : channel.type === 'dew' ? 'DEW_CHANNELS' : channel.type === 'autoDew' ? 'AUTO_DEW_CONTROL' : channel.type === 'usb' ? 'USB_PORTS' : 'VARIABLE_CHANNELS'
		client.sendSwitch({ device: power.name, name, elements: { [channel.name]: value } })
	}

	voltage(power: Power, channel: PowerChannel, value: number, client = power[CLIENT]!) {
		if (channel.type !== 'variableVoltage') return
		client.sendNumber({ device: power.name, name: 'VARIABLE_VOLTAGES', elements: { [channel.name]: value } })
	}

	dutyCycle(power: Power, channel: PowerChannel, value: number, client = power[CLIENT]!) {
		if (channel.type !== 'dew') return
		client.sendNumber({ device: power.name, name: 'DEW_DUTY_CYCLES', elements: { [channel.name]: value } })
	}

	// Applies power switch vectors: per-channel enabled state for DC/dew/auto-dew/variable/USB channels and
	// the power-cycle capability.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'POWER_CHANNELS':
				handlePowerChannel(this, device, message, tag, 'dc', 'enabled')
				return
			case 'DEW_CHANNELS':
				handlePowerChannel(this, device, message, tag, 'dew', 'enabled')
				return
			case 'AUTO_DEW_CONTROL':
				handlePowerChannel(this, device, message, tag, 'autoDew', 'enabled')
				return
			case 'VARIABLE_CHANNELS':
				handlePowerChannel(this, device, message, tag, 'variableVoltage', 'enabled')
				return
			case 'USB_PORTS':
				handlePowerChannel(this, device, message, tag, 'usb', 'enabled')
				return
			case 'POWER_CYCLE_Toggle':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasPowerCycle', true)) {
						this.updated(device, 'hasPowerCycle', message.state)
					}
				}
		}
	}

	// Applies power number vectors: aggregate voltage/current/power sensors and per-channel current/duty
	// values for DC/dew/auto-dew/variable channels.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'POWER_SENSORS':
				if (handleMinMaxValue(device.voltage, message.elements.SENSOR_VOLTAGE, tag)) {
					this.updated(device, 'voltage', message.state)
				}

				if (handleMinMaxValue(device.current, message.elements.SENSOR_CURRENT, tag)) {
					this.updated(device, 'current', message.state)
				}

				if (handleMinMaxValue(device.power, message.elements.SENSOR_POWER, tag)) {
					this.updated(device, 'power', message.state)
				}

				return
			// Power Channel Current (only if per-channel current monitoring is available)
			case 'POWER_CURRENTS':
				handlePowerChannel(this, device, message, tag, 'dc', 'value')
				return
			case 'DEW_DUTY_CYCLES':
				handlePowerChannel(this, device, message, tag, 'dew', 'value')
				return
			case 'DEW_CURRENTS':
				handlePowerChannel(this, device, message, tag, 'autoDew', 'value')
				return
			case 'VARIABLE_VOLTAGES':
				handlePowerChannel(this, device, message, tag, 'variableVoltage', 'value')
		}
	}

	// Creates/updates the power device from DRIVER_INFO and applies the per-channel label text vectors.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.POWER)
		}

		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'POWER_LABELS':
				handlePowerChannel(this, device, message, tag, 'dc', 'label')
				return
			case 'DEW_LABELS':
				handlePowerChannel(this, device, message, tag, 'dew', 'label')
				return
			case 'USB_LABELS':
				handlePowerChannel(this, device, message, tag, 'usb', 'label')
				return
			case 'VARIABLE_LABELS':
				handlePowerChannel(this, device, message, tag, 'variableVoltage', 'label')
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'POWER_CHANNELS' || name === 'POWER_CURRENTS' || name === 'POWER_LABELS') {
			resetDeviceValue(this, device, 'dc', DEFAULT_POWER.dc)
		}
		if (full || name === 'DEW_CHANNELS' || name === 'DEW_DUTY_CYCLES' || name === 'DEW_LABELS') {
			resetDeviceValue(this, device, 'dew', DEFAULT_POWER.dew)
		}
		if (full || name === 'AUTO_DEW_CONTROL' || name === 'DEW_CURRENTS') {
			resetDeviceValue(this, device, 'autoDew', DEFAULT_POWER.autoDew)
		}
		if (full || name === 'VARIABLE_CHANNELS' || name === 'VARIABLE_VOLTAGES' || name === 'VARIABLE_LABELS') {
			resetDeviceValue(this, device, 'variableVoltage', DEFAULT_POWER.variableVoltage)
		}
		if (full || name === 'USB_PORTS' || name === 'USB_LABELS') {
			resetDeviceValue(this, device, 'usb', DEFAULT_POWER.usb)
		}
		if (full || name === 'POWER_CYCLE_Toggle') {
			resetDeviceValue(this, device, 'hasPowerCycle', DEFAULT_POWER.hasPowerCycle)
		}
		if (full || name === 'POWER_SENSORS') {
			resetDeviceValue(this, device, 'voltage', DEFAULT_POWER.voltage)
			resetDeviceValue(this, device, 'current', DEFAULT_POWER.current)
			resetDeviceValue(this, device, 'power', DEFAULT_POWER.power)
		}

		super.delProperty(client, message)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indiweatherinterface.cpp

// One ObservingConditions sensor with its canonical name in each backend. `indi` is the element name the
// Alpaca client emits inside WEATHER_PARAMETERS; `aliases` are extra element names accepted when reading,
// because the INDI Weather interface does not standardize parameter names - every driver declares its own
// through addParameter(). `degrees` marks a value that arrives in degrees and is stored as radians.
export interface WeatherSensorMapping {
	readonly field: WeatherSensor
	readonly ascom: string
	readonly indi: string
	readonly aliases: readonly string[]
	readonly degrees: boolean
	// Neutral presentation range and format used when a vector has to be synthesized for this sensor,
	// as the Alpaca client does. These are the physically plausible bounds of the quantity, never alarm
	// thresholds, and WeatherManager never reads them back.
	readonly min: number
	readonly max: number
	readonly step: number
	readonly format: string
}

// The thirteen ObservingConditions sensors, shared by WeatherManager, the Alpaca client and the Alpaca
// server so the three name mappings cannot drift apart. Aliases cover the widespread drivers
// (OpenWeatherMap, weatherradio, AAG CloudWatcher, Weather Meta). WEATHER_RAIN_HOUR is precipitation over
// the last hour, which is numerically mm/h and is therefore published as RainRate.
export const WEATHER_SENSORS: readonly WeatherSensorMapping[] = [
	{ field: 'cloudCover', ascom: 'CloudCover', indi: 'WEATHER_CLOUD_COVER', aliases: ['WEATHER_CLOUD'], degrees: false, min: 0, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'dewPoint', ascom: 'DewPoint', indi: 'WEATHER_DEW_POINT', aliases: ['WEATHER_DEWPOINT'], degrees: false, min: -100, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'humidity', ascom: 'Humidity', indi: 'WEATHER_HUMIDITY', aliases: ['WEATHER_RELATIVE_HUMIDITY'], degrees: false, min: 0, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'pressure', ascom: 'Pressure', indi: 'WEATHER_PRESSURE', aliases: ['WEATHER_BAROMETER'], degrees: false, min: 0, max: 2000, step: 0.1, format: '%.1f' },
	{ field: 'rainRate', ascom: 'RainRate', indi: 'WEATHER_RAIN_HOUR', aliases: ['WEATHER_RAIN_RATE', 'WEATHER_RAIN'], degrees: false, min: 0, max: 1000, step: 0.1, format: '%.1f' },
	{ field: 'skyBrightness', ascom: 'SkyBrightness', indi: 'WEATHER_SKY_BRIGHTNESS', aliases: ['WEATHER_BRIGHTNESS'], degrees: false, min: 0, max: 200000, step: 0.001, format: '%.3f' },
	{ field: 'skyQuality', ascom: 'SkyQuality', indi: 'WEATHER_SKY_QUALITY', aliases: ['WEATHER_SQM'], degrees: false, min: 0, max: 30, step: 0.01, format: '%.2f' },
	{ field: 'skyTemperature', ascom: 'SkyTemperature', indi: 'WEATHER_SKY_TEMPERATURE', aliases: ['WEATHER_IR_SKY_TEMPERATURE'], degrees: false, min: -300, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'starFWHM', ascom: 'StarFWHM', indi: 'WEATHER_STAR_FWHM', aliases: ['WEATHER_SEEING'], degrees: false, min: 0, max: 100, step: 0.01, format: '%.2f' },
	{ field: 'temperature', ascom: 'Temperature', indi: 'WEATHER_TEMPERATURE', aliases: [], degrees: false, min: -100, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'windDirection', ascom: 'WindDirection', indi: 'WEATHER_WIND_DIRECTION', aliases: [], degrees: true, min: 0, max: 360, step: 0.1, format: '%.1f' },
	{ field: 'windGust', ascom: 'WindGust', indi: 'WEATHER_WIND_GUST', aliases: [], degrees: false, min: 0, max: 200, step: 0.1, format: '%.1f' },
	{ field: 'windSpeed', ascom: 'WindSpeed', indi: 'WEATHER_WIND_SPEED', aliases: [], degrees: false, min: 0, max: 200, step: 0.1, format: '%.1f' },
]

// Lookup by INDI element name (preferred name and every alias), built once so parsing a vector never
// scans the table.
const WEATHER_SENSORS_BY_INDI_NAME = new Map<string, WeatherSensorMapping>()

for (const sensor of WEATHER_SENSORS) {
	WEATHER_SENSORS_BY_INDI_NAME.set(sensor.indi, sensor)
	for (const alias of sensor.aliases) WEATHER_SENSORS_BY_INDI_NAME.set(alias, sensor)
}

// Freshness bookkeeping for one device, on the two clocks it needs.
//
// `at` is the epoch millisecond of the last report of each sensor, which is what a wall-clock timestamp
// such as Alpaca's DeviceState.TimeStamp has to carry. Zero means never reported, which is unambiguous
// because the Unix epoch cannot be a real observation time.
//
// `elapsed` is the performance.now() millisecond of the same report, and every age is measured from it:
// a system clock corrected backward would otherwise make a sensor look updated in the future, and a
// forward correction would make a fresh one look arbitrarily stale. It is only meaningful where the
// matching `at` is non-zero, because performance.now() may legitimately read 0 in the first millisecond
// of the process.
//
// Every key of both records is present so the objects keep a stable shape.
interface WeatherUpdatedAt {
	readonly at: Record<WeatherSensor, number>
	readonly elapsed: Record<WeatherSensor, number>
}

// Manager for weather stations (INDI Weather interface / ASCOM ObservingConditions). Reflects
// WEATHER_PARAMETERS onto the typed sensor fields, tracks per-sensor freshness, and drives the driver's
// update period, average period and refresh controls. Ambient temperature also feeds the Thermometer
// capability. Angles are radians; see Weather for the remaining units.
export class WeatherManager extends DeviceManager<Weather> {
	// Per-device freshness stamps. A WeakMap keeps them out of the device object, which is serialized.
	readonly #updatedAt = new WeakMap<Weather, WeatherUpdatedAt>()

	// Epoch milliseconds of the last report of `sensor`, or undefined when it was never reported. A
	// repeated identical reading still advances this, unlike the `updated` event. Use elapsedSince for a
	// duration: this stamp is wall-clock and moves with the system clock.
	updatedAt(device: Weather, sensor: WeatherSensor) {
		const at = this.#updatedAt.get(device)?.at[sensor]
		return at ? at : undefined
	}

	// Epoch milliseconds of the most recent report of any sensor, or undefined when none was reported.
	//
	// Which report is the most recent is decided on the monotonic clock and only its wall-clock stamp is
	// returned: after the system clock is corrected backward, a sensor reported before the correction
	// carries the numerically larger epoch, and picking that one would answer an instant older than the
	// reading that just arrived - possibly one still in the future.
	lastUpdatedAt(device: Weather) {
		const stamps = this.#updatedAt.get(device)

		if (stamps === undefined) return undefined

		let last: number | undefined
		let at: number | undefined

		for (const sensor of WEATHER_SENSORS) {
			const { field } = sensor
			const elapsed = stamps.elapsed[field]

			if (stamps.at[field] && (last === undefined || elapsed > last)) {
				last = elapsed
				at = stamps.at[field]
			}
		}

		return at
	}

	// Milliseconds since the last report of `sensor`, or undefined when it was never reported. Measured
	// on the monotonic clock, so a system clock adjustment cannot make the age negative or stale.
	elapsedSince(device: Weather, sensor: WeatherSensor) {
		const stamps = this.#updatedAt.get(device)

		if (stamps === undefined || !stamps.at[sensor]) return undefined

		return performance.now() - stamps.elapsed[sensor]
	}

	// Milliseconds since the most recent report of any sensor, or undefined when none was reported. Also
	// monotonic; see elapsedSince.
	lastElapsedSince(device: Weather) {
		const stamps = this.#updatedAt.get(device)

		if (stamps === undefined) return undefined

		// A zero `at` marks a sensor that was never reported, and only those are skipped: a real
		// performance.now() stamp can be 0 and still be a genuine reading.
		let last: number | undefined

		for (const sensor of WEATHER_SENSORS) {
			const { field } = sensor
			const elapsed = stamps.elapsed[field]
			if (stamps.at[field] && (last === undefined || elapsed > last)) last = elapsed
		}

		return last === undefined ? undefined : performance.now() - last
	}

	// Sets the driver's hardware re-read period, in seconds. Returns false when the driver has no
	// writable WEATHER_UPDATE. The value is sent as-is; the driver enforces its own range.
	setUpdatePeriod(device: Weather, period: number, client = device[CLIENT]!) {
		if (!this.hasWritableProperty(device, 'WEATHER_UPDATE')) return false
		client.sendNumber({ device: device.name, name: 'WEATHER_UPDATE', elements: { PERIOD: period } })
		return true
	}

	// Sets the averaging window, in hours; 0 means an instantaneous reading. Returns false when the
	// backend cannot configure averaging (no writable WEATHER_AVERAGE_PERIOD).
	setAveragePeriod(device: Weather, hours: number, client = device[CLIENT]!) {
		if (!this.hasWritableProperty(device, 'WEATHER_AVERAGE_PERIOD')) return false
		client.sendNumber({ device: device.name, name: 'WEATHER_AVERAGE_PERIOD', elements: { AVERAGE_PERIOD: hours } })
		return true
	}

	// Triggers an immediate re-read. Returns false when the driver offers no explicit refresh, which the
	// Alpaca server maps to MethodOrPropertyNotImplemented.
	refresh(device: Weather, client = device[CLIENT]!) {
		if (!this.hasWritableProperty(device, 'WEATHER_REFRESH')) return false
		client.sendSwitch({ device: device.name, name: 'WEATHER_REFRESH', elements: { REFRESH: true } })
		return true
	}

	// Returns the device's freshness stamps, creating them on first use.
	#stamps(device: Weather) {
		let stamps = this.#updatedAt.get(device)

		if (stamps === undefined) {
			stamps = { at: {}, elapsed: {} } as WeatherUpdatedAt
			for (const sensor of WEATHER_SENSORS) stamps.at[sensor.field] = stamps.elapsed[sensor.field] = 0
			this.#updatedAt.set(device, stamps)
		}

		return stamps
	}

	// Applies one sensor reading. Notifies only on a real change, but refreshes the freshness stamp on
	// every report, so TimeSinceLastUpdate advances even when the driver repeats a value. `stamps` is
	// undefined for a report that is not an observation, which applies the value without dating it.
	//
	// Deliberately does not use handleMinMaxValue: the min/max of a WEATHER_PARAMETERS element are the
	// driver's alarm thresholds from addParameter(name, label, min, max, percentWarning), not a display
	// range, and clamping to them would truncate exactly the out-of-range reading that matters.
	#handleSensor(device: Weather, mapping: WeatherSensorMapping, element: DefNumber | OneNumber | undefined, state: PropertyState | undefined, stamps: WeatherUpdatedAt | undefined, now: number, elapsed: number) {
		if (element === undefined) return

		const { field } = mapping

		if (field === 'temperature' && handleSwitchValue<Device & Thermometer>(device, 'hasThermometer', true)) {
			this.updated(device, 'hasThermometer', state)
		}

		if (handleWeatherNumber(device, field, mapping.degrees ? weatherAngle(element.value) : element.value, state)) {
			this.updated(device, field, state)
		}

		if (stamps !== undefined) {
			stamps.at[field] = now
			stamps.elapsed[field] = elapsed
		}
	}

	// Applies every mapped element of a WEATHER_PARAMETERS vector. Unmapped elements stay reachable
	// through the raw property view but never reach the typed interface.
	//
	// `definition` marks a defNumberVector. A definition published Busy carries the driver's declared
	// defaults rather than a reading: the Firmata adapter defines every measurement Busy with zero
	// placeholders and settles it to Idle on the first hardware sample. Storing those would announce
	// 0 °C, 0 % and 0 hPa as freshly observed and start TimeSinceLastUpdate on values no sensor ever
	// produced, so a Busy definition declares the property and nothing else.
	#handleParameters(device: Weather, message: DefNumberVector | SetNumberVector, definition: boolean) {
		const { elements } = message

		// A definition replaces the whole element set, as the raw property manager does with the vector
		// itself, so a sensor the driver no longer declares has to leave the typed view as well. Without
		// this the field and its freshness stamp would survive indefinitely and advertise a parameter the
		// current definition does not provide. A set vector is a partial update and never removes
		// anything: drivers legitimately report a subset of their parameters.
		if (definition) {
			const declared = new Set<WeatherSensor>()

			for (const key in elements) {
				const mapping = WEATHER_SENSORS_BY_INDI_NAME.get(key)
				if (mapping !== undefined) declared.add(mapping.field)
			}

			for (const sensor of WEATHER_SENSORS) {
				if (!declared.has(sensor.field)) this.#resetSensor(device, sensor.field)
			}

			if (message.state === 'Busy') return
		}

		// An Alert vector is the driver reporting that its hardware read failed. The INDI Weather
		// interface applies WEATHER_PARAMETERS unchanged in that case and retries every five seconds, so
		// its elements are the previous readings restated rather than new observations - the alarm status
		// of a reading lives in WEATHER_STATUS, not in this state. The values are still applied, because a
		// driver that sampled part of them before failing did observe those, but their freshness must not
		// advance: a station whose sensor died would otherwise keep reporting a near-zero
		// TimeSinceLastUpdate for the whole outage and hide it from every safety check.
		const stamps = message.state === 'Alert' ? undefined : this.#stamps(device)
		// Both clocks are read once per vector: the wall-clock stamp is what a timestamp reports, the
		// monotonic one is what every age is measured from.
		const now = Date.now()
		const elapsed = performance.now()

		for (const key in elements) {
			const mapping = WEATHER_SENSORS_BY_INDI_NAME.get(key)
			if (mapping !== undefined) this.#handleSensor(device, mapping, elements[key], message.state, stamps, now, elapsed)
		}
	}

	// Clears one sensor back to "not reported" and forgets its freshness.
	#resetSensor(device: Weather, field: WeatherSensor) {
		if (field === 'temperature') {
			resetDeviceValue(this, device, 'hasThermometer', DEFAULT_WEATHER.hasThermometer)
			resetDeviceValue(this, device, 'temperature', DEFAULT_WEATHER.temperature)
		} else {
			resetDeviceValue(this, device, field, undefined)
		}

		const stamps = this.#updatedAt.get(device)

		if (stamps !== undefined) {
			stamps.at[field] = 0
			stamps.elapsed[field] = 0
		}
	}

	// Creates/updates the weather device from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.WEATHER)
		}
	}

	// Tracks writability of the refresh control on top of the common CONNECTION handling.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		if (tag[0] === 'd') {
			if ((message as DefSwitchVector).permission !== 'ro') this.addWritableProperty(device, message.name)
			else this.removeWritableProperty(device, message.name)
		}
	}

	// Applies the weather number vectors: the sensor parameters, the driver update period, the averaging
	// window.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const definition = tag[0] === 'd' ? (message as DefNumberVector) : undefined

		if (definition) {
			if (definition.permission !== 'ro') this.addWritableProperty(device, message.name)
			else this.removeWritableProperty(device, message.name)
		}

		switch (message.name) {
			case 'WEATHER_PARAMETERS':
				this.#handleParameters(device, message, definition !== undefined)
				return
			case 'WEATHER_UPDATE': {
				// The property is absent until the driver defines it, so `updatePeriod` doubles as the
				// "driver has an update period" flag and is created on first sight.
				const updatePeriod = device.updatePeriod ?? structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY)

				if (handleMinMaxValue(updatePeriod, message.elements.PERIOD, tag) || device.updatePeriod === undefined) {
					;(device as Writable<Weather>).updatePeriod = updatePeriod
					this.updated(device, 'updatePeriod', message.state)
				}

				return
			}
			case 'WEATHER_AVERAGE_PERIOD': {
				const hours = message.elements.AVERAGE_PERIOD?.value

				if (hours !== undefined && handleWeatherNumber(device, 'averagePeriod', hours, message.state)) {
					this.updated(device, 'averagePeriod', message.state)
				}
			}
		}
	}

	// Resets the fields backed by a deleted property. The device itself survives a named deletion: it is
	// identified by DRIVER_INTERFACE, not by its properties. Only an unnamed delProperty removes it.
	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full) this.clearWritableProperty(device)
		else this.removeWritableProperty(device, name)

		if (full || name === 'WEATHER_PARAMETERS') {
			for (const sensor of WEATHER_SENSORS) this.#resetSensor(device, sensor.field)
		}

		if (full || name === 'WEATHER_UPDATE') resetDeviceValue(this, device, 'updatePeriod', DEFAULT_WEATHER.updatePeriod)
		if (full || name === 'WEATHER_AVERAGE_PERIOD') resetDeviceValue(this, device, 'averagePeriod', DEFAULT_WEATHER.averagePeriod)

		super.delProperty(client, message)
	}
}

// Converts an INDI wind direction from degrees to radians normalized to [0, TAU).
function weatherAngle(value: number) {
	return normalizeAngle(deg(value))
}

// Assigns an optional numeric weather field when the reading differs, returning whether the caller
// should notify (also true on Alert, so error states are re-emitted without a value change).
//
// handleNumberValue cannot be used here: PickByValue keeps a key only when `T[K] extends number`, and an
// optional sensor is typed `number | undefined`, so every sensor except the mandatory `temperature` is
// filtered out of its property parameter.
function handleWeatherNumber(device: Weather, field: WeatherSensor | 'averagePeriod', value: number, state?: PropertyState) {
	if (device[field] !== value) {
		device[field] = value
		return true
	}

	return state === 'Alert'
}

// Resets a device field to a default (deep-cloned) value and notifies, when it actually differs.
function resetDeviceValue<D extends Device, K extends keyof D & string>(manager: DeviceManager<D>, device: D, property: K, value: D[K]) {
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

// Reconciles one power-channel list (dc/dew/usb/variable) against an incoming vector: updates each
// channel's label/value/enabled or min/max range, appends new channels, trims removed ones, and notifies
// on any change. Returns whether anything changed.
function handlePowerChannel(manager: DeviceManager<Power>, device: Power, message: DefVector | SetVector, tag: string, type: PowerChannelType, property: keyof Omit<PowerChannel, 'type'>, client = device[CLIENT]!) {
	const entries = Object.entries(message.elements) as readonly [string, DefElement][]
	const channels = device[type]
	let updated = false

	for (let i = 0; i < entries.length; i++) {
		const [name, entry] = entries[i]
		const p = channels[i] ?? ({ type, name, label: entry.label ?? '', enabled: false, value: 0, min: 0, max: 0, step: 0 } satisfies PowerChannel)

		if (tag[0] === 'd' && 'max' in entry) {
			updated ||= handleMinMaxValue(p, entry, tag)
		} else {
			const value = entry.value as never

			if (p[property] !== value) {
				p[property] = value
				updated = true
			}
		}

		if (channels[i] === undefined) {
			channels[i] = p
			updated = true
		}
	}

	if (entries.length < channels.length) {
		channels.splice(entries.length, channels.length - entries.length)
		updated = true
	}

	if (updated) {
		manager.updated(device, type, message.state)
	}

	return updated
}

// Applies a PARK switch vector to a parkable device's canPark/parking/parked fields and notifies on each
// change. `parking` is inferred from a Busy state.
function handleParkable<D extends Device & Parkable>(manager: DeviceManager<D>, device: D, message: DefSwitchVector | SetSwitchVector, tag: string) {
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

// Normalizes ALIGNMENT_POINTSET_SIZE into a non-negative integer count. The property is declared as a
// float by INDI, so a driver may report a fractional or (after a failed commit) negative value.
function alignmentPointCount(value: number) {
	return value > 0 ? Math.trunc(value) : 0
}

// Typed wrappers over handlePropertyValue: switch coerces undefined to false; number applies an optional
// transform (e.g. unit conversion) and ignores undefined; text ignores empty/undefined values.
function handleSwitchValue<D>(device: D, property: keyof PickByValue<D, boolean>, value?: boolean, state?: PropertyState) {
	return handlePropertyValue<D, boolean>(device, property, value === true, state)
}

function handleNumberValue<D>(device: D, property: keyof PickByValue<D, number>, value?: number, state?: PropertyState, transform?: (value: number) => number) {
	return value !== undefined && handlePropertyValue<D, number>(device, property, transform?.(value) ?? value, state)
}

function handleTextValue<D>(device: D, property: keyof PickByValue<D, string>, value?: string, state?: PropertyState) {
	return value && handlePropertyValue<D, string>(device, property, value, state)
}

// Applies a number element to a value+range property: updates min/max/step when a real range is present
// (def vectors, or set vectors carrying IUUpdateMinMax bounds with max !== 0) and the value, clamping it
// only once a meaningful range is known. Returns whether anything changed.
function handleMinMaxValue(property: MinMaxValueProperty, element: DefNumber | OneNumber | undefined, tag: string) {
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

// Converts an INDI angular number from degrees to radians, including its optional range metadata.
function domeAngleNumber(element: DefNumber | OneNumber | undefined): DefNumber | OneNumber | undefined {
	if (element === undefined) return

	if ('format' in element) {
		return { ...element, min: deg(element.min), max: deg(element.max), step: deg(element.step), value: deg(element.value) }
	}

	return {
		...element,
		min: element.min === undefined ? undefined : deg(element.min),
		max: element.max === undefined ? undefined : deg(element.max),
		step: element.step === undefined ? undefined : deg(element.step),
		value: deg(element.value),
	}
}

// Derives the shared shutter state from the selected INDI shutter command and property state.
function domeShutterState(message: DefSwitchVector | SetSwitchVector): DomeShutterState {
	if (message.state === 'Alert') return 'ERROR'

	const selected = findOnSwitch(message)
	const opening = selected.some((name) => name.endsWith('OPEN'))
	const closing = selected.some((name) => name.endsWith('CLOSE'))

	if (opening) return message.state === 'Busy' ? 'OPENING' : 'OPEN'
	if (closing) return message.state === 'Busy' ? 'CLOSING' : 'CLOSED'
	return 'UNKNOWN'
}

// Converts the driver's selected OTA-side switch into the normalized shared measurement value.
function domeOTASide(message: DefSwitchVector | SetSwitchVector): DomeOTASide {
	const selected = findOnSwitch(message)

	if (selected.some((name) => name.endsWith('EAST'))) return 'EAST'
	if (selected.some((name) => name.endsWith('WEST'))) return 'WEST'
	return 'UNKNOWN'
}

// Recomputes the aggregate rotational/home/park motion flag after a related property update.
function updateDomeSlewing(manager: DeviceManager<Dome>, dome: Dome, state?: PropertyState) {
	const slewing = dome.moving || dome.homing || dome.parking

	if (handleSwitchValue(dome, 'slewing', slewing, state)) manager.updated(dome, 'slewing', state)
}

// Parses an INDI UTC offset string ("HH" or "HH:MM") into minutes.
function parseUTCOffset(text: string) {
	const parts = text.split(':')
	const hour = +parts[0] * 60
	const minute = parts.length >= 2 ? +parts[1] : 0
	return hour + minute
}

export function makeDeviceId(client: Client, type: DeviceType, name: string) {
	return Bun.MD5.hash(`${client.id}:${type}:${name}`, 'hex')
}

function makeDevice<D extends Device>(model: D, client: Client, name: string, driver?: Record<string, DefText>, id?: string) {
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
function proxyDevice<D extends Device>(parent: D, id: string, type: DeviceType) {
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
