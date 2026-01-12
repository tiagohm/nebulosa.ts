import type { PickByValue } from 'utility-types'
import { type Angle, deg, hour, normalizeAngle, normalizePI, parseAngle, toDeg, toHour } from './angle'
import { observedToCirs } from './astrometry'
import { TAU } from './constants'
import { eclipticToEquatorial, equatorialFromJ2000, galacticToEquatorial } from './coordinate'
import { meter, toMeter } from './distance'
import type { CfaPattern } from './image.types'
import type { IndiClient, IndiClientHandler } from './indi.client'
// biome-ignore format: too long!
import { type Camera, type CameraTransferFormat, CLIENT, type Cover, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_WHEEL, type Device, DeviceInterfaceType, type DeviceProperties, type DeviceProperty, type DewHeater, type FlatPanel, type Focuser, type FrameType, type GPS, type GuideDirection, type GuideOutput, isFocuser, isInterfaceType, isMount, isRotator, isWheel, type MinMaxValueProperty, type Mount, type MountTargetCoordinate, type Parkable, type Power, type PowerChannel, type PowerChannelType, type Rotator, type SlewRate, type Thermometer, type TrackMode, type Wheel } from './indi.device'
import type { DefBlobVector, DefElement, DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefTextVector, DefVector, DelProperty, OneNumber, PropertyState, SetBlobVector, SetNumberVector, SetSwitchVector, SetTextVector, SetVector } from './indi.types'
import type { GeographicCoordinate } from './location'
import { formatTemporal, parseTemporal } from './temporal'
import { timeNow } from './time'

export interface DeviceHandler<D extends Device> {
	readonly added: (device: D) => void
	readonly updated?: (device: D, property: keyof D & string, state?: PropertyState) => void
	readonly removed: (device: D) => void
	readonly blobReceived?: (device: D, data: string) => void
}

export interface DevicePropertyHandler {
	readonly added: (client: IndiClient, device: string, property: DeviceProperty) => void
	readonly updated: (client: IndiClient, device: string, property: DeviceProperty) => void
	readonly removed: (client: IndiClient, device: string, property: DeviceProperty) => void
}

export interface DeviceProvider<D extends Device> {
	readonly get: (client: IndiClient, name: string) => D | undefined
}

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

export class DevicePropertyManager implements IndiClientHandler, DevicePropertyHandler {
	private readonly clients = new Map<string, IndiClient>()
	private readonly properties = new Map<IndiClient, Map<string, DeviceProperties>>()
	private readonly handlers = new Set<DevicePropertyHandler>()

	get length() {
		return this.properties.size
	}

	addHandler(handler: DevicePropertyHandler) {
		this.handlers.add(handler)
	}

	removeHandler(handler: DevicePropertyHandler) {
		this.handlers.delete(handler)
	}

	added(client: IndiClient, device: string, property: DeviceProperty) {
		this.handlers.forEach((e) => e.added(client, device, property))
	}

	updated(client: IndiClient, device: string, property: DeviceProperty) {
		this.handlers.forEach((e) => e.updated(client, device, property))
	}

	removed(client: IndiClient, device: string, property: DeviceProperty) {
		this.handlers.forEach((e) => e.removed(client, device, property))
	}

	names(client: IndiClient | string) {
		client = typeof client === 'string' ? this.clients.get(client)! : client
		return Array.from(this.properties.get(client)?.keys() ?? [])
	}

	get(client: IndiClient | string, name: string) {
		client = typeof client === 'string' ? this.clients.get(client)! : client
		return this.properties.get(client)?.get(name)
	}

	has(client: IndiClient | string, name: string) {
		client = typeof client === 'string' ? this.clients.get(client)! : client
		return this.properties.get(client)?.has(name) === true
	}

	vector(client: IndiClient, message: DefVector | SetVector, tag: string) {
		const { device } = message
		let map = this.properties.get(client)

		if (!map) {
			map = new Map()
			this.properties.set(client, map)
			this.clients.set(client.id, client)
		}

		let properties = map.get(device)

		if (!properties) {
			properties = {}
			map.set(device, properties)
		}

		if (tag[0] === 'd') {
			const property = message as DeviceProperty
			property.type = tag.includes('Switch') ? 'SWITCH' : tag.includes('Number') ? 'NUMBER' : tag.includes('Text') ? 'TEXT' : tag.includes('BLOB') ? 'BLOB' : 'LIGHT'
			properties[message.name] = property
			this.added(client, device, property)
			return true
		} else {
			let updated = false
			const property = properties[message.name]

			if (property) {
				if (message.state && message.state !== property.state) {
					property.state = message.state
					updated = true
				}

				const { elements } = message

				for (const key in elements) {
					const element = property.elements[key]

					if (element) {
						const value = elements[key]!.value

						if (value !== element.value) {
							element.value = value
							updated = true
						}
					}
				}

				if (updated) {
					this.updated(client, device, property)
				}
			}

			return updated
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		const properties = this.get(client, message.device)

		if (!properties) return false

		const { device, name } = message

		if (name) {
			const property = properties[name]

			if (property) {
				delete properties[name]
				if (Object.keys(properties).length === 0) this.properties.get(client)?.delete(device)
				this.removed(client, device, property)
				return true
			}
		} else {
			// TODO: should notify once for all properties being removed?
			// for (const [_, property] of Object.entries(properties)) this.removed(device, property)
			this.properties.get(client)?.delete(device)
			return true
		}

		return false
	}

	close(client: IndiClient, server: boolean) {
		this.clients.delete(client.id)
	}
}

export abstract class DeviceManager<D extends Device> implements IndiClientHandler, DeviceProvider<D>, DeviceHandler<D> {
	protected readonly clients = new Map<string, IndiClient>()
	protected readonly devices = new Map<IndiClient, Map<string, D>>()
	protected readonly handlers = new Set<DeviceHandler<D>>()

	get length() {
		let n = 0
		this.devices.forEach((e) => void (n += e.size))
		return n
	}

	addHandler(handler: DeviceHandler<D>) {
		this.handlers.add(handler)
	}

	removeHandler(handler: DeviceHandler<D>) {
		this.handlers.delete(handler)
	}

	added(device: D) {
		this.handlers.forEach((e) => e.added(device))
	}

	updated(device: D, property: keyof D & string, state?: PropertyState) {
		this.handlers.forEach((e) => e.updated?.(device, property, state))
	}

	removed(device: D) {
		this.handlers.forEach((e) => e.removed(device))
	}

	blobReceived(device: D, data: string) {
		this.handlers.forEach((e) => e.blobReceived?.(device, data))
	}

	list(client?: IndiClient | string) {
		const devices = new Set<D>()

		if (client) {
			client = typeof client === 'string' ? this.clients.get(client) : client

			if (client) {
				for (const device of this.devices.get(client)!.values()) {
					devices.add(device)
				}
			}
		} else {
			for (const client of this.devices.values()) {
				for (const device of client.values()) {
					devices.add(device)
				}
			}
		}

		return devices
	}

	names(client: IndiClient | string) {
		client = typeof client === 'string' ? this.clients.get(client)! : client
		return Array.from(this.devices.get(client)?.keys() ?? [])
	}

	get(client: IndiClient | string, name: string) {
		client = typeof client === 'string' ? this.clients.get(client)! : client
		return this.devices.get(client)?.get(name)
	}

	has(client: IndiClient | string, name: string) {
		client = typeof client === 'string' ? this.clients.get(client)! : client
		return this.devices.get(client)?.has(name) === true
	}

	ask(device: D, client = device[CLIENT]!) {
		client.getProperties({ device: device.name })
	}

	enableBlob(device: D, client = device[CLIENT]!) {
		client.enableBlob({ device: device.name, value: 'Also' })
	}

	disableBlob(device: D, client = device[CLIENT]!) {
		client.enableBlob({ device: device.name, value: 'Never' })
	}

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

	simulation(device: D, enable: boolean, client = device[CLIENT]!) {
		client.sendSwitch({ device: device.name, name: 'SIMULATION', elements: { [enable ? 'ENABLE' : 'DISABLE']: true } })
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		switch (message.name) {
			case 'CONNECTION':
				if (this.handleConnection(device, message)) {
					this.updated(device, 'connected', message.state)
				}

				return
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (!message.name) {
			const device = this.get(client, message.device)

			if (device) {
				this.remove(device)
			}
		}
	}

	protected handleConnection(device: D, message: DefSwitchVector | SetSwitchVector, client = device[CLIENT]!) {
		const connected = message.elements.CONNECT?.value === true

		if (handleSwitchValue<Device>(device, 'connected', connected, message.state)) {
			if (connected) this.ask(device)
			return true
		}

		return false
	}

	protected handleDriverInfo(client: IndiClient, message: DefTextVector | SetTextVector, interfaceType: DeviceInterfaceType) {
		const { elements } = message
		const type = +elements.DRIVER_INTERFACE!.value
		const name = message.device
		let device = this.get(client, name)

		if (isInterfaceType(type, interfaceType)) {
			if (!device) {
				device = structuredClone<D>(DEVICES[interfaceType as never])
				const id = Bun.MD5.hash(`${client.id}:${device.type}:${name}`, 'hex')
				device = { ...device, id, name, [CLIENT]: client, driver: { executable: elements.DRIVER_EXEC!.value, version: elements.DRIVER_VERSION!.value }, client: { id: client.id, ip: client.remoteIp, port: client.remotePort } }

				this.add(device)
				this.ask(device)
			}
		} else if (device) {
			this.remove(device)
		}
	}

	add(device: D, client = device[CLIENT] as IndiClient) {
		if (!this.has(client, device.name)) {
			const devices = this.devices.get(client) ?? new Map()
			devices.set(device.name, device)
			this.devices.set(client, devices)
			this.clients.set(client.id, client)
			this.added(device)
			return true
		} else {
			return false
		}
	}

	remove(device: D, client = device[CLIENT] as IndiClient) {
		if (this.has(client, device.name)) {
			this.devices.get(client)?.delete(device.name)
			this.removed(device)
			return true
		} else {
			return false
		}
	}

	close(client: IndiClient, server: boolean) {
		const devices = this.devices.get(client)

		if (devices) {
			for (const [_, device] of devices) {
				this.remove(device)
			}
		}

		this.devices.delete(client)
		this.clients.delete(client.id)
	}
}

export class GuideOutputManager extends DeviceManager<GuideOutput> {
	constructor(readonly provider: DeviceProvider<GuideOutput>) {
		super()
	}

	pulseNorth(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_N: duration, TIMED_GUIDE_S: 0 } })
		}
	}

	pulseSouth(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_S: duration, TIMED_GUIDE_N: 0 } })
		}
	}

	pulseWest(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_W: duration, TIMED_GUIDE_E: 0 } })
		}
	}

	pulseEast(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_E: duration, TIMED_GUIDE_W: 0 } })
		}
	}

	pulse(device: GuideOutput, direction: GuideDirection, duration: number, client = device[CLIENT]!) {
		if (direction === 'NORTH') this.pulseNorth(device, duration, client)
		else if (direction === 'SOUTH') this.pulseSouth(device, duration, client)
		else if (direction === 'WEST') this.pulseWest(device, duration, client)
		else if (direction === 'EAST') this.pulseEast(device, duration, client)
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE': {
				const device = this.provider.get(client, message.device)

				if (device) {
					if (tag[0] === 'd') {
						if (handleSwitchValue(device, 'canPulseGuide', true)) {
							if (this.add(device)) {
								this.updated(device, 'canPulseGuide', message.state)
							}
						}
					}

					if (handleSwitchValue(device, 'pulsing', message.state === 'Busy')) {
						this.updated(device, 'pulsing', message.state)
					}
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'TELESCOPE_TIMED_GUIDE_NS' || message.name === 'TELESCOPE_TIMED_GUIDE_WE') {
			const device = this.get(client, message.device)

			if (device) {
				if (handleSwitchValue(device, 'canPulseGuide', false)) {
					this.updated(device, 'canPulseGuide')
				}

				this.remove(device)
			}
		}
	}
}

// TODO: SVBony SV241 Pro has two thermometers!
export class ThermometerManager extends DeviceManager<Thermometer> {
	constructor(readonly provider: DeviceProvider<Thermometer>) {
		super()
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'CCD_TEMPERATURE':
			case 'FOCUS_TEMPERATURE': {
				const device = this.provider.get(client, message.device)

				if (device) {
					if (tag[0] === 'd') {
						if (handleSwitchValue(device, 'hasThermometer', true)) {
							if (this.add(device)) {
								this.updated(device, 'hasThermometer', message.state)
							}
						}
					}

					const { elements } = message

					if (handleNumberValue(device, 'temperature', elements.TEMPERATURE?.value ?? elements.CCD_TEMPERATURE_VALUE?.value, undefined, Math.trunc)) {
						this.updated(device, 'temperature', message.state)
					}
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'CCD_TEMPERATURE' || message.name === 'FOCUS_TEMPERATURE') {
			const device = this.get(client, message.device)

			if (device) {
				if (handleSwitchValue(device, 'hasThermometer', false)) {
					this.updated(device, 'hasThermometer')
				}

				this.remove(device)
			}
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indiccd.cpp

export class CameraManager extends DeviceManager<Camera> {
	private readonly gainProperty = new Map<string, readonly [string, string]>()
	private readonly offsetProperty = new Map<string, readonly [string, string]>()

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
		if (value && camera.frameFormats.includes(value)) {
			client.sendSwitch({ device: camera.name, name: 'CCD_CAPTURE_FORMAT', elements: { [value]: true } })
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
		const property = this.gainProperty.get(camera.name)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: camera.name, name, elements: { [element]: value } })
		}
	}

	offset(camera: Camera, value: number, client = camera[CLIENT]!) {
		const property = this.offsetProperty.get(camera.name)

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

	snoop(camera: Camera, ...devices: Device[]) {
		const mount = devices.find(isMount)
		const focuser = devices.find(isFocuser)
		const wheel = devices.find(isWheel)
		const rotator = devices.find(isRotator)

		camera[CLIENT]!.sendText({ device: camera.name, name: 'ACTIVE_DEVICES', elements: { ACTIVE_TELESCOPE: mount?.name ?? '', ACTIVE_ROTATOR: rotator?.name ?? '', ACTIVE_FOCUSER: focuser?.name ?? '', ACTIVE_FILTER: wheel?.name ?? '' } })
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

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
			case 'CCD_CAPTURE_FORMAT':
				if (tag[0] === 'd') {
					device.frameFormats = Object.keys(message.elements)
					this.updated(device, 'frameFormats', message.state)
				}

				for (const [name, value] of Object.entries(message.elements)) {
					if (value.value) {
						if (handleTextValue(device, 'frameFormat', name, message.state)) {
							this.updated(device, 'frameFormat', message.state)
						}

						break
					}
				}

				return
			case 'CCD_ABORT_EXPOSURE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', (message as DefSwitchVector).permission !== 'ro')) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

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

				if (handleMinMaxValue(device.exposure, message.elements.CCD_EXPOSURE_VALUE, tag) || exposuringHasChanged) {
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
					this.gainProperty.set(device.name, [message.name, 'Gain'])
				}

				if (handleMinMaxValue(device.offset, message.elements.Offset, tag)) {
					this.updated(device, 'offset', message.state)
					this.offsetProperty.set(device.name, [message.name, 'Offset'])
				}

				return
			// CCD Simulator
			case 'CCD_GAIN':
				if (handleMinMaxValue(device.gain, message.elements.GAIN, tag)) {
					this.updated(device, 'gain', message.state)
					this.gainProperty.set(device.name, [message.name, 'GAIN'])
				}

				return
			case 'CCD_OFFSET':
				if (handleMinMaxValue(device.offset, message.elements.OFFSET, tag)) {
					this.updated(device, 'offset', message.state)
					this.offsetProperty.set(device.name, [message.name, 'OFFSET'])
				}

				return
			case 'CCD_FRAME_TYPE':
				if (handleTextValue(device, 'frameType', message.elements.FRAME_BIAS?.value ? 'BIAS' : message.elements.FRAME_FLAT?.value ? 'FLAT' : message.elements.FRAME_DARK?.value ? 'DARK' : 'LIGHT')) {
					this.updated(device, 'frameType', message.state)
				}

				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.CCD)
		}

		const device = this.get(client, message.device)

		if (!device) return

		switch (message.name) {
			case 'CCD_CFA':
				device.cfa.offsetX = +message.elements.CFA_OFFSET_X!.value
				device.cfa.offsetY = +message.elements.CFA_OFFSET_Y!.value
				device.cfa.type = message.elements.CFA_TYPE!.value as CfaPattern
				this.updated(device, 'cfa', message.state)

				return
		}
	}

	blobVector(client: IndiClient, message: DefBlobVector | SetBlobVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		switch (message.name) {
			case 'CCD1':
				if (tag[0] === 's') {
					const data = message.elements.CCD1?.value

					if (data) {
						this.blobReceived(device, data)
					} else {
						console.warn(`received empty BLOB for device ${device.name}`)
					}
				}

				return
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/inditelescope.cpp

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
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { TRACK: true } })
			this.equatorialCoordinate(mount, rightAscension, declination, client)
		}
	}

	flipTo(mount: Mount, rightAscension: Angle, declination: Angle, client = mount[CLIENT]!) {
		if (mount.canFlip) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { FLIP: true } })
			this.equatorialCoordinate(mount, rightAscension, declination, client)
		}
	}

	moveTo(mount: Mount, mode: 'goto' | 'flip' | 'sync', req: MountTargetCoordinate<string | Angle>, client = mount[CLIENT]!) {
		const { type } = req
		const { x, y } = req[type]!
		const equatorial: [number, number] = [typeof x === 'string' ? parseAngle(x, type === 'JNOW' || type === 'J2000' ? true : undefined)! : x, typeof y === 'string' ? parseAngle(y)! : y]

		if (type === 'J2000') {
			Object.assign(equatorial, equatorialFromJ2000(...equatorial))
		} else if (type === 'ALTAZ') {
			Object.assign(equatorial, observedToCirs(...equatorial, timeNow(true), mount.geographicCoordinate))
		} else if (type === 'ECLIPTIC') {
			Object.assign(equatorial, eclipticToEquatorial(...equatorial))
		} else if (type === 'GALACTIC') {
			Object.assign(equatorial, equatorialFromJ2000(...galacticToEquatorial(...equatorial)))
		} else {
			return
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

	slewRate(mount: Mount, rate: SlewRate | string, client = mount[CLIENT]!) {
		client.sendSwitch({ device: mount.name, name: 'TELESCOPE_SLEW_RATE', elements: { [typeof rate === 'string' ? rate : rate.name]: true } })
	}

	moveNorth(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: true, MOTION_SOUTH: false } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: false } })
		}
	}

	moveSouth(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: false, MOTION_SOUTH: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_SOUTH: false } })
		}
	}

	moveWest(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: true, MOTION_EAST: false } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: false } })
		}
	}

	moveEast(mount: Mount, enable: boolean, client = mount[CLIENT]!) {
		if (mount.canMove) {
			if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: false, MOTION_EAST: true } })
			else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_EAST: false } })
		}
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		const { elements } = message

		switch (message.name) {
			case 'TELESCOPE_SLEW_RATE':
				if (tag[0] === 'd') {
					const rates: SlewRate[] = []

					for (const key in elements) {
						const element = elements[key] as DefSwitch
						rates.push({ name: element.name, label: element.label! })
					}

					if (rates.length) {
						device.slewRates = rates
						this.updated(device, 'slewRates', message.state)
					}
				}

				for (const key in elements) {
					const element = elements[key]!

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

					if (modes.length) {
						device.trackModes = modes
						this.updated(device, 'trackModes', message.state)
					}
				}

				for (const key in elements) {
					const element = elements[key]!

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

					if (handleSwitchValue(device, 'canHome', 'FIND' in elements)) {
						this.updated(device, 'canFindHome', message.state)
					}

					if (handleSwitchValue(device, 'canHome', 'SET' in elements)) {
						this.updated(device, 'canSetHome', message.state)
					}
				}

				if (elements.GO?.value) {
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

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

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

				return
			}
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.TELESCOPE)
		}

		const device = this.get(client, message.device)

		if (!device) return

		switch (message.name) {
			case 'TIME_UTC': {
				if (message.elements.UTC?.value) {
					const utc = parseTemporal(message.elements.UTC.value, 'YYYY-MM-DDTHH:mm:ss')
					const offset = parseUTCOffset(message.elements.OFFSET!.value)

					let updated = handleNumberValue(device.time, 'utc', utc)
					updated = handleNumberValue(device.time, 'offset', offset) || updated

					if (updated) {
						this.updated(device, 'time', message.state)
					}
				}

				return
			}
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indifilterwheel.cpp

export class WheelManager extends DeviceManager<Wheel> {
	moveTo(wheel: Wheel, slot: number, client = wheel[CLIENT]!) {
		client.sendNumber({ device: wheel.name, name: 'FILTER_SLOT', elements: { FILTER_SLOT_VALUE: slot + 1 } })
	}

	slots(wheel: Wheel, names: readonly string[], client = wheel[CLIENT]!) {
		const elements: Record<string, string> = {}
		names.forEach((name, index) => (elements[`FILTER_SLOT_NAME_${index + 1}`] = name))
		client.sendText({ device: wheel.name, name: 'FILTER_NAME', elements })
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		switch (message.name) {
			case 'FILTER_SLOT':
				if (handleNumberValue(device, 'position', message.elements.FILTER_SLOT_VALUE.value - 1)) {
					this.updated(device, 'position', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}

				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.FILTER)
		}

		const device = this.get(client, message.device)

		if (!device) return

		switch (message.name) {
			case 'FILTER_NAME': {
				const slots = Object.values(message.elements)

				if (slots.length !== device.slots.length || slots.some((e, index) => e.value !== device.slots[index])) {
					device.slots = slots.map((e) => e.value)
					this.updated(device, 'slots', message.state)
				}

				return
			}
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indifocuserinterface.cpp

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

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

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

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

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

				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.FOCUSER)
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indidustcapinterface.cpp

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

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'CAP_PARK':
				handleParkable(this, device, message, tag)
				return
			case 'CAP_ABORT':
				if (handleSwitchValue(device, 'canAbort', true)) {
					this.updated(device, 'canAbort', message.state)
				}

				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.DUSTCAP)
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indirotatorinterface.cpp

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

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'ROTATOR_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'SYNC_ROTATOR_ANGLE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', true)) {
						this.updated(device, 'canSync', message.state)
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

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		switch (message.name) {
			case 'ABS_ROTATOR_ANGLE':
				if (handleMinMaxValue(device.angle, message.elements.ANGLE, tag)) {
					this.updated(device, 'angle', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}

				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.ROTATOR)
		}
	}
}

export class DewHeaterManager extends DeviceManager<DewHeater> {
	private readonly pwmProperty = new Map<string, readonly [string, string]>()

	constructor(readonly provider: DeviceProvider<DewHeater>) {
		super()
	}

	dutyCycle(heater: DewHeater, value: number, client = heater[CLIENT]!) {
		const property = this.pwmProperty.get(heater.name)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: heater.name, name, elements: { [element]: value } })
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			// WandererCover V4 EC
			case 'Heater': {
				const device = this.provider.get(client, message.device)

				if (device) {
					if (tag[0] === 'd') {
						if (handleSwitchValue(device, 'hasDewHeater', true)) {
							if (this.add(device)) {
								this.updated(device, 'hasDewHeater', message.state)
								this.pwmProperty.set(device.name, [message.name, 'Heater'])
							}
						}
					}

					if (handleMinMaxValue(device.dutyCycle, message.elements.Heater, tag)) {
						this.updated(device, 'dutyCycle', message.state)
					}
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'Heater') {
			const device = this.get(client, message.device)

			if (device) {
				if (handleSwitchValue(device, 'hasDewHeater', false)) {
					this.updated(device, 'hasDewHeater')
				}

				this.remove(device)
			}
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indilightboxinterface.cpp

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

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'FLAT_LIGHT_CONTROL':
				if (handleSwitchValue(device, 'enabled', message.elements.FLAT_LIGHT_ON?.value)) {
					this.updated(device, 'enabled', message.state)
				}

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

		switch (message.name) {
			case 'FLAT_LIGHT_INTENSITY':
				if (handleMinMaxValue(device.intensity, message.elements.FLAT_LIGHT_INTENSITY_VALUE, tag)) {
					this.updated(device, 'intensity', message.state)
				}

				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.LIGHTBOX)
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indipowerinterface.cpp

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

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

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

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (!device) return

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
				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.POWER)
		}

		const device = this.get(client, message.device)

		if (!device) return

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
				return
		}
	}
}

function handlePowerChannel(manager: DeviceManager<Power>, device: Power, message: DefVector | SetVector, tag: string, type: PowerChannelType, property: keyof Omit<PowerChannel, 'type'>, client = device[CLIENT]!) {
	const entries = Object.entries(message.elements) as readonly [string, DefElement][]
	const channels = device[type]
	let updated = false

	entries.forEach(([name, entry], i) => {
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
	})

	if (entries.length < channels.length) {
		channels.splice(entries.length, channels.length - entries.length)
		updated = true
	}

	if (updated) {
		manager.updated(device, type, message.state)
	}

	return updated
}

function handleParkable<D extends Device & Parkable>(manager: DeviceManager<D>, device: D, message: DefSwitchVector | SetSwitchVector, tag: string, client = device[CLIENT]!) {
	if (tag[0] === 'd') {
		if (handleSwitchValue<Device & Parkable>(device, 'canPark', (message as DefSwitchVector).permission !== 'ro')) {
			manager.updated(device, 'canPark', message.state)
		}
	}

	if (handleSwitchValue<Device & Parkable>(device, 'parking', message.state === 'Busy')) {
		manager.updated(device, 'parking', message.state)
	}

	if (handleSwitchValue<Device & Parkable>(device, 'parked', !!message.elements.PARK?.value)) {
		manager.updated(device, 'parked', message.state)
	}
}

function handlePropertyValue<D, T extends string | number | boolean>(device: D, property: keyof PickByValue<D, T>, value: T, state?: PropertyState) {
	if (device[property] !== value) {
		device[property] = value as never
		return true
	}

	return state === 'Alert'
}

function handleSwitchValue<D>(device: D, property: keyof PickByValue<D, boolean>, value?: boolean, state?: PropertyState) {
	return handlePropertyValue<D, boolean>(device, property, value === true, state)
}

function handleNumberValue<D>(device: D, property: keyof PickByValue<D, number>, value?: number, state?: PropertyState, transform?: (value: number) => number) {
	return value !== undefined && handlePropertyValue<D, number>(device, property, transform?.(value) ?? value, state)
}

function handleTextValue<D>(device: D, property: keyof PickByValue<D, string>, value?: string, state?: PropertyState) {
	return value && handlePropertyValue<D, string>(device, property, value, state)
}

function handleMinMaxValue(property: MinMaxValueProperty, element: DefNumber | OneNumber | undefined, tag: string) {
	if (element === undefined) return false

	let update = false

	if (tag[0] === 'd') {
		const { min, max, step } = element as DefNumber

		if (max !== 0) {
			update = min !== property.min || max !== property.max || step !== property.step
			property.min = min
			property.max = max
			property.step = step
		}
	}

	if (property.value !== element.value) {
		property.value = element.value
		update = true
	}

	return update
}

function parseUTCOffset(text: string) {
	const parts = text.split(':')
	const hour = +parts[0] * 60
	const minute = parts.length >= 2 ? +parts[1] : 0
	return hour + minute
}
