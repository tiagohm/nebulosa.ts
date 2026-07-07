import { observedToCirs } from '../../astronomy/coordinates/astrometry'
import { eclipticToEquatorial, equatorialFromJ2000, galacticToEquatorial } from '../../astronomy/coordinates/coordinate'
import { TAU } from '../../core/constants'
import type { CfaPattern } from '../../imaging/model/types'
import { type Angle, deg, hour, normalizeAngle, normalizePI, parseAngle, toDeg, toHour } from '../../math/units/angle'
import { meter, toMeter } from '../../math/units/distance'
import type { IndiClientHandler } from './client'
// oxfmt-ignore
import { type Camera, type CameraTransferFormat, CLIENT, type Client, type Cover, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_DEW_HEATER, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_GUIDE_OUTPUT, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_THERMOMETER, DEFAULT_WHEEL, type Device, DeviceInterfaceType, type DeviceProperties, type DeviceProperty, type DeviceType, type DewHeater, type FlatPanel, type Focuser, type FrameType, type GPS, type GuideDirection, type GuideOutput, isInterfaceType, type MinMaxValueProperty, type Mount, type MountTargetCoordinate, type NameAndLabel, type Parkable, type Power, type PowerChannel, type PowerChannelType, type Rotator, type SubDevice, type Thermometer, type TrackMode, type Wheel } from './device'
import type { GeographicCoordinate } from '../../astronomy/observer/location'
import { formatTemporal, parseTemporal } from '../../astronomy/time/temporal'
import { type Time, timeNow } from '../../astronomy/time/time'
import type { PickByValue } from '../../core/types'
import type { BlobEncoding, DefBlobVector, DefElement, DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefTextVector, DefVector, DelProperty, OneNumber, PropertyState, SetBlobVector, SetNumberVector, SetSwitchVector, SetTextVector, SetVector, ValueType } from './types'

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
const DEVICES = {
	[DeviceInterfaceType.TELESCOPE]: DEFAULT_MOUNT,
	[DeviceInterfaceType.CCD]: DEFAULT_CAMERA,
	[DeviceInterfaceType.FOCUSER]: DEFAULT_FOCUSER,
	[DeviceInterfaceType.FILTER]: DEFAULT_WHEEL,
	[DeviceInterfaceType.DUSTCAP]: DEFAULT_COVER,
	[DeviceInterfaceType.LIGHTBOX]: DEFAULT_FLAT_PANEL,
	[DeviceInterfaceType.ROTATOR]: DEFAULT_ROTATOR,
	[DeviceInterfaceType.POWER]: DEFAULT_POWER,
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

	// Resolves a managed device by id or, scoped to a client, by name.
	get(client: Client | string | undefined, id: string) {
		client = typeof client === 'string' ? this.#clients.get(client) : client

		for (const device of this.#devices.values()) {
			if (device.id === id) return device
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
		let device = this.get(client, name)

		if (isInterfaceType(type, interfaceType)) {
			if (device === undefined) {
				device = structuredClone<D>(DEVICES[interfaceType as never])
				const id = Bun.MD5.hash(`${client.id}:${device.type}:${name}`, 'hex')
				device = { ...device, id, name, [CLIENT]: client, driver: { executable: elements.DRIVER_EXEC.value, version: elements.DRIVER_VERSION.value }, client: { type: client.type, id: client.id } }

				this.add(device)
				this.ask(device)
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
		const id = Bun.MD5.hash(`${client.id}:guideOutput:${parent.name}`, 'hex')

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
					if (handleSwitchValue(device, 'pulsing', message.state === 'Busy')) {
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
		const id = Bun.MD5.hash(`${client.id}:thermometer:${parent.name}`, 'hex')

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
						this.blobReceived(device, data, 'base64')
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

// Manager for mounts/telescopes. Command methods slew/sync/goto (converting target frames to the mount's
// equatorial frame), track, park/home, move axes, and pulse-guide; property handling maps coordinate,
// tracking, pier-side, site/time, and capability vectors onto the Mount state. Angles are radians.
export class MountManager extends DeviceManager<Mount> {
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

	// Applies mount switch vectors: slew rate, track mode/state, pier side, park/park-option, abort, home,
	// slew-vs-sync mode, and axis motion.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		const { elements } = message

		switch (message.name) {
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

				if (elements.GO) {
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
		}
	}

	// Applies mount number vectors: the equatorial (JNOW) coordinate and slewing state, and the site
	// geographic coordinate.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
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
		const id = Bun.MD5.hash(`${client.id}:dewHeater:${parent.name}`, 'hex')

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

// Parses an INDI UTC offset string ("HH" or "HH:MM") into minutes.
function parseUTCOffset(text: string) {
	const parts = text.split(':')
	const hour = +parts[0] * 60
	const minute = parts.length >= 2 ? +parts[1] : 0
	return hour + minute
}

// Wraps a parent device in a proxy presenting a distinct id/type and a `parent`/`parentId` link, so a
// sub-interface (e.g. a guide output of a mount) appears as its own device while sharing the parent's
// fields. parentId is made enumerable so it survives Object.keys()/JSON.stringify.
function proxyDevice<D extends Device>(parent: D, id: string, type: DeviceType) {
	return new Proxy(parent, {
		get(target, prop) {
			if (prop === 'id') return id
			if (prop === 'parentId') return parent.id
			if (prop === 'type') return type
			if (prop === 'parent') return parent
			return Reflect.get(target, prop)
		},
		// Used to make parentId show up in Object.keys() and similar functions, which is useful for debugging and serialization
		// JSON.stringify ignores properties that don't show up in Object.keys()
		ownKeys(target) {
			return [...Reflect.ownKeys(target), 'parentId']
		},
		getOwnPropertyDescriptor(target, prop) {
			if (prop === 'parentId') {
				return { enumerable: true, configurable: true }
			}

			return Reflect.getOwnPropertyDescriptor(target, prop)
		},
	})
}
