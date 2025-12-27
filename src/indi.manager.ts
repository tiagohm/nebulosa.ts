import type { PickByValue } from 'utility-types'
import { type Angle, deg, hour, normalizeAngle, normalizePI, PARSE_HOUR_ANGLE, parseAngle, toDeg, toHour } from './angle'
import { observedToCirs } from './astrometry'
import { TAU } from './constants'
import { meter, toMeter } from './distance'
import { eraC2s, eraS2c } from './erfa'
import { precessFk5FromJ2000 } from './fk5'
import type { CfaPattern } from './image.types'
import type { DefBlobVector, DefElement, DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefTextVector, DefVector, DelProperty, IndiClient, IndiClientHandler, OneNumber, PropertyState, SetBlobVector, SetNumberVector, SetSwitchVector, SetTextVector, SetVector } from './indi'
// biome-ignore format: too long!
import { type Camera, type Cover, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_WHEEL, type Device, DeviceInterfaceType, type DeviceProperties, type DeviceProperty, type DewHeater, type FlatPanel, type Focuser, type FrameType, type GPS, type GuideDirection, type GuideOutput, isInterfaceType, type MinMaxValueProperty, type Mount, type MountTargetCoordinate, type Parkable, type Power, type PowerChannel, type PowerChannelType, type Rotator, type SlewRate, type Thermometer, type TrackMode, type Wheel } from './indi.device'
import type { GeographicCoordinate, GeographicPosition } from './location'
import { formatTemporal, parseTemporal } from './temporal'
import { timeNow } from './time'

export interface DeviceHandler<D extends Device> {
	readonly added: (client: IndiClient, device: D) => void
	readonly updated: (client: IndiClient, device: D, property: keyof D, state?: PropertyState) => void
	readonly removed: (client: IndiClient, device: D) => void
	readonly blobReceived?: (client: IndiClient, device: D, data: string) => void
}

export interface DevicePropertyHandler {
	readonly added: (device: string, property: DeviceProperty) => void
	readonly updated: (device: string, property: DeviceProperty) => void
	readonly removed: (device: string, property: DeviceProperty) => void
}

export interface DeviceProvider<D extends Device> {
	readonly get: (name: string) => D | undefined
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
	private readonly properties = new Map<string, DeviceProperties>()
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

	added(device: string, property: DeviceProperty) {
		this.handlers.forEach((e) => e.added(device, property))
	}

	updated(device: string, property: DeviceProperty) {
		this.handlers.forEach((e) => e.updated(device, property))
	}

	removed(device: string, property: DeviceProperty) {
		this.handlers.forEach((e) => e.removed(device, property))
	}

	names() {
		return Array.from(this.properties.keys())
	}

	list(name: string) {
		return this.properties.get(name)
	}

	get(name: string) {
		return this.properties.get(name)
	}

	has(name: string) {
		return this.properties.has(name)
	}

	vector(client: IndiClient, message: DefVector | SetVector, tag: string) {
		const { device } = message
		let properties = this.get(device)

		if (!properties) {
			properties = {}
			this.properties.set(device, properties)
		}

		if (tag[0] === 'd') {
			const property = message as DeviceProperty
			property.type = tag.includes('Switch') ? 'SWITCH' : tag.includes('Number') ? 'NUMBER' : tag.includes('Text') ? 'TEXT' : tag.includes('BLOB') ? 'BLOB' : 'LIGHT'
			properties[message.name] = property
			this.added(device, property)
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
					this.updated(device, property)
				}
			}

			return updated
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		const properties = this.get(message.device)

		if (!properties) return false

		const { device, name } = message

		if (name) {
			const property = properties[name]

			if (property) {
				delete properties[name]
				if (Object.keys(properties).length === 0) this.properties.delete(device)
				this.removed(device, property)
				return true
			}
		} else {
			// TODO: should notify once for all properties being removed?
			// for (const [_, property] of Object.entries(properties)) this.removed(device, property)
			this.properties.delete(device)
			return true
		}

		return false
	}
}

export abstract class DeviceManager<D extends Device> implements IndiClientHandler, DeviceProvider<D>, DeviceHandler<D> {
	protected readonly devices = new Map<string, D>()
	protected readonly handlers = new Set<DeviceHandler<D>>()

	get length() {
		return this.devices.size
	}

	addHandler(handler: DeviceHandler<D>) {
		this.handlers.add(handler)
	}

	removeHandler(handler: DeviceHandler<D>) {
		this.handlers.delete(handler)
	}

	added(client: IndiClient, device: D) {
		this.handlers.forEach((e) => e.added(client, device))
	}

	updated(client: IndiClient, device: D, property: keyof D, state?: PropertyState) {
		this.handlers.forEach((e) => e.updated(client, device, property, state))
	}

	removed(client: IndiClient, device: D) {
		this.handlers.forEach((e) => e.removed(client, device))
	}

	blobReceived(client: IndiClient, device: D, data: string) {
		this.handlers.forEach((e) => e.blobReceived?.(client, device, data))
	}

	list() {
		return Array.from(this.devices.values())
	}

	names() {
		return Array.from(this.devices.keys())
	}

	get(name: string) {
		return this.devices.get(name)
	}

	has(name: string) {
		return this.devices.has(name)
	}

	ask(client: IndiClient, device: D) {
		client.getProperties({ device: device.name })
	}

	enableBlob(client: IndiClient, device: D) {
		client.enableBlob({ device: device.name, value: 'Also' })
	}

	disableBlob(client: IndiClient, device: D) {
		client.enableBlob({ device: device.name, value: 'Never' })
	}

	connect(client: IndiClient, device: D) {
		if (!device.connected) {
			client.sendSwitch({ device: device.name, name: 'CONNECTION', elements: { CONNECT: true } })
		}
	}

	disconnect(client: IndiClient, device: D) {
		if (device.connected) {
			client.sendSwitch({ device: device.name, name: 'CONNECTION', elements: { DISCONNECT: true } })
		}
	}

	simulation(client: IndiClient, device: D, enable: boolean) {
		client.sendSwitch({ device: device.name, name: 'SIMULATION', elements: { [enable ? 'ENABLE' : 'DISABLE']: true } })
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'CONNECTION':
				if (this.handleConnection(client, device, message)) {
					this.updated(client, device, 'connected', message.state)
				}

				return
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (!message.name) {
			const device = this.get(message.device)

			if (device) {
				this.remove(client, device)
			}
		}
	}

	protected handleConnection(client: IndiClient, device: D, message: DefSwitchVector | SetSwitchVector) {
		const connected = message.elements.CONNECT?.value === true

		if (handleSwitchValue<Device>(device, 'connected', connected, message.state)) {
			if (connected) this.ask(client, device)
			return true
		}

		return false
	}

	protected handleDriverInfo(client: IndiClient, message: DefTextVector | SetTextVector, interfaceType: DeviceInterfaceType) {
		const { elements } = message
		const type = +elements.DRIVER_INTERFACE!.value
		let device = this.get(message.device)

		if (isInterfaceType(type, interfaceType)) {
			if (!device) {
				device = structuredClone(DEVICES[interfaceType as never]) as D
				device.name = message.device
				device.driver.executable = elements.DRIVER_EXEC!.value
				device.driver.version = elements.DRIVER_VERSION!.value

				this.add(client, device)
				this.ask(client, device)
			}
		} else if (device) {
			this.remove(client, device)
		}
	}

	add(client: IndiClient, device: D) {
		if (!this.has(device.name)) {
			this.devices.set(device.name, device)
			this.added(client, device)
			return true
		} else {
			return false
		}
	}

	remove(client: IndiClient, device: D) {
		if (this.has(device.name)) {
			this.devices.delete(device.name)
			this.removed(client, device)
			return true
		} else {
			return false
		}
	}

	close(client: IndiClient, server: boolean) {
		for (const [_, device] of this.devices) {
			this.remove(client, device)
		}
	}
}

export class GuideOutputManager extends DeviceManager<GuideOutput> {
	constructor(readonly provider: DeviceProvider<GuideOutput>) {
		super()
	}

	pulseNorth(client: IndiClient, device: GuideOutput, duration: number) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_N: duration, TIMED_GUIDE_S: 0 } })
		}
	}

	pulseSouth(client: IndiClient, device: GuideOutput, duration: number) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_S: duration, TIMED_GUIDE_N: 0 } })
		}
	}

	pulseWest(client: IndiClient, device: GuideOutput, duration: number) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_W: duration, TIMED_GUIDE_E: 0 } })
		}
	}

	pulseEast(client: IndiClient, device: GuideOutput, duration: number) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_E: duration, TIMED_GUIDE_W: 0 } })
		}
	}

	pulse(client: IndiClient, device: GuideOutput, direction: GuideDirection, duration: number) {
		if (direction === 'NORTH') this.pulseNorth(client, device, duration)
		else if (direction === 'SOUTH') this.pulseSouth(client, device, duration)
		else if (direction === 'WEST') this.pulseWest(client, device, duration)
		else if (direction === 'EAST') this.pulseEast(client, device, duration)
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE': {
				const device = this.provider.get(message.device)

				if (device) {
					if (tag[0] === 'd') {
						if (handleSwitchValue(device, 'canPulseGuide', true)) {
							if (this.add(client, device)) {
								this.updated(client, device, 'canPulseGuide', message.state)
							}
						}
					}

					if (handleSwitchValue(device, 'pulsing', message.state === 'Busy')) {
						this.updated(client, device, 'pulsing', message.state)
					}
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'TELESCOPE_TIMED_GUIDE_NS' || message.name === 'TELESCOPE_TIMED_GUIDE_WE') {
			const device = this.get(message.device)

			if (device) {
				if (handleSwitchValue(device, 'canPulseGuide', false)) {
					this.updated(client, device, 'canPulseGuide')
				}

				this.remove(client, device)
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
				const device = this.provider.get(message.device)

				if (device) {
					if (tag[0] === 'd') {
						if (handleSwitchValue(device, 'hasThermometer', true)) {
							if (this.add(client, device)) {
								this.updated(client, device, 'hasThermometer', message.state)
							}
						}
					}

					const { elements } = message

					if (handleNumberValue(device, 'temperature', elements.TEMPERATURE?.value ?? elements.CCD_TEMPERATURE_VALUE?.value, undefined, Math.trunc)) {
						this.updated(client, device, 'temperature', message.state)
					}
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'CCD_TEMPERATURE' || message.name === 'FOCUS_TEMPERATURE') {
			const device = this.get(message.device)

			if (device) {
				if (handleSwitchValue(device, 'hasThermometer', false)) {
					this.updated(client, device, 'hasThermometer')
				}

				this.remove(client, device)
			}
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indiccd.cpp

export class CameraManager extends DeviceManager<Camera> {
	private readonly gainProperty = new Map<string, readonly [string, string]>()
	private readonly offsetProperty = new Map<string, readonly [string, string]>()

	cooler(client: IndiClient, camera: Camera, value: boolean) {
		if (camera.hasCoolerControl && camera.cooler !== value) {
			client.sendSwitch({ device: camera.name, name: 'CCD_COOLER', elements: { [value ? 'COOLER_ON' : 'COOLER_OFF']: true } })
		}
	}

	temperature(client: IndiClient, camera: Camera, value: number) {
		if (camera.canSetTemperature) {
			client.sendNumber({ device: camera.name, name: 'CCD_TEMPERATURE', elements: { CCD_TEMPERATURE_VALUE: value } })
		}
	}

	frameFormat(client: IndiClient, camera: Camera, value: string) {
		if (value && camera.frameFormats.includes(value)) {
			client.sendSwitch({ device: camera.name, name: 'CCD_CAPTURE_FORMAT', elements: { [value]: true } })
		}
	}

	frameType(client: IndiClient, camera: Camera, value: FrameType) {
		client.sendSwitch({ device: camera.name, name: 'CCD_FRAME_TYPE', elements: { [`FRAME_${value}`]: true } })
	}

	frame(client: IndiClient, camera: Camera, X: number, Y: number, WIDTH: number, HEIGHT: number) {
		if (camera.canSubFrame) {
			client.sendNumber({ device: camera.name, name: 'CCD_FRAME', elements: { X, Y, WIDTH, HEIGHT } })
		}
	}

	bin(client: IndiClient, camera: Camera, x: number, y: number) {
		if (camera.canBin) {
			client.sendNumber({ device: camera.name, name: 'CCD_BINNING', elements: { HOR_BIN: x, VER_BIN: y } })
		}
	}

	gain(client: IndiClient, camera: Camera, value: number) {
		const property = this.gainProperty.get(camera.name)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: camera.name, name, elements: { [element]: value } })
		}
	}

	offset(client: IndiClient, camera: Camera, value: number) {
		const property = this.offsetProperty.get(camera.name)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: camera.name, name, elements: { [element]: value } })
		}
	}

	startExposure(client: IndiClient, camera: Camera, exposureTimeInSeconds: number) {
		client.sendSwitch({ device: camera.name, name: 'CCD_COMPRESSION', elements: { INDI_DISABLED: true } })
		client.sendSwitch({ device: camera.name, name: 'CCD_TRANSFER_FORMAT', elements: { FORMAT_FITS: true } })
		client.sendNumber({ device: camera.name, name: 'CCD_EXPOSURE', elements: { CCD_EXPOSURE_VALUE: exposureTimeInSeconds } })
	}

	stopExposure(client: IndiClient, camera: Camera) {
		client.sendSwitch({ device: camera.name, name: 'CCD_ABORT_EXPOSURE', elements: { ABORT: true } })
	}

	snoop(client: IndiClient, camera: Camera, ...devices: Device[]) {
		const mount = devices.find((e) => e.type === 'MOUNT')
		const focuser = devices.find((e) => e.type === 'FOCUSER')
		const wheel = devices.find((e) => e.type === 'WHEEL')

		client.sendText({ device: camera.name, name: 'ACTIVE_DEVICES', elements: { ACTIVE_TELESCOPE: mount?.name ?? '', ACTIVE_ROTATOR: '', ACTIVE_FOCUSER: focuser?.name ?? '', ACTIVE_FILTER: wheel?.name ?? '' } })
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'CCD_COOLER':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasCoolerControl', true)) {
						this.updated(client, device, 'hasCoolerControl', message.state)
					}
				}

				if (handleSwitchValue(device, 'cooler', message.elements.COOLER_ON?.value)) {
					this.updated(client, device, 'cooler', message.state)
				}

				return
			case 'CCD_CAPTURE_FORMAT':
				if (tag[0] === 'd') {
					device.frameFormats = Object.keys(message.elements)
					this.updated(client, device, 'frameFormats', message.state)
				}

				return
			case 'CCD_ABORT_EXPOSURE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', (message as DefSwitchVector).permission !== 'ro')) {
						this.updated(client, device, 'canAbort', message.state)
					}
				}

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'CCD_INFO': {
				const { elements } = message

				let changed = handleNumberValue(device.pixelSize, 'x', elements.CCD_PIXEL_SIZE_X?.value)
				changed = handleNumberValue(device.pixelSize, 'y', elements.CCD_PIXEL_SIZE_Y?.value) || changed

				if (changed) {
					this.updated(client, device, 'pixelSize', message.state)
				}

				return
			}
			case 'CCD_EXPOSURE': {
				let exposuringHasChanged = false

				if (handleSwitchValue(device, 'exposuring', message.state === 'Busy')) {
					this.updated(client, device, 'exposuring', message.state)
					exposuringHasChanged = true
				}

				if (handleMinMaxValue(device.exposure, message.elements.CCD_EXPOSURE_VALUE, tag) || exposuringHasChanged) {
					this.updated(client, device, 'exposure', message.state)
				}

				return
			}
			case 'CCD_COOLER_POWER':
				if (handleNumberValue(device, 'coolerPower', message.elements.CCD_COOLER_POWER?.value)) {
					this.updated(client, device, 'coolerPower', message.state)
				}

				return
			case 'CCD_TEMPERATURE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasCooler', true)) {
						this.updated(client, device, 'hasCooler', message.state)
					}

					if (handleSwitchValue(device, 'canSetTemperature', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(client, device, 'canSetTemperature', message.state)
					}
				}

				return
			case 'CCD_FRAME': {
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSubFrame', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(client, device, 'canSubFrame', message.state)
					}
				}

				const { elements } = message

				let updated = handleMinMaxValue(device.frame.x, elements.X, tag)
				updated = handleMinMaxValue(device.frame.y, elements.Y, tag) || updated
				updated = handleMinMaxValue(device.frame.width, elements.WIDTH, tag) || updated
				updated = handleMinMaxValue(device.frame.height, elements.HEIGHT, tag) || updated

				if (updated) {
					this.updated(client, device, 'frame', message.state)
				}

				return
			}
			case 'CCD_BINNING': {
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canBin', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(client, device, 'canBin', message.state)
					}
				}

				const { elements } = message

				let updated = handleMinMaxValue(device.bin.x, elements.HOR_BIN, tag)
				updated = handleMinMaxValue(device.bin.y, elements.VER_BIN, tag) || updated

				if (updated) {
					this.updated(client, device, 'bin', message.state)
				}

				return
			}
			// ZWO ASI, SVBony, etc
			case 'CCD_CONTROLS':
				if (handleMinMaxValue(device.gain, message.elements.Gain, tag)) {
					this.updated(client, device, 'gain', message.state)
					this.gainProperty.set(device.name, [message.name, 'Gain'])
				}

				if (handleMinMaxValue(device.offset, message.elements.Offset, tag)) {
					this.updated(client, device, 'offset', message.state)
					this.offsetProperty.set(device.name, [message.name, 'Offset'])
				}

				return
			// CCD Simulator
			case 'CCD_GAIN':
				if (handleMinMaxValue(device.gain, message.elements.GAIN, tag)) {
					this.updated(client, device, 'gain', message.state)
					this.gainProperty.set(device.name, [message.name, 'GAIN'])
				}

				return
			case 'CCD_OFFSET':
				if (handleMinMaxValue(device.offset, message.elements.OFFSET, tag)) {
					this.updated(client, device, 'offset', message.state)
					this.offsetProperty.set(device.name, [message.name, 'OFFSET'])
				}

				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.CCD)
		}

		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'CCD_CFA':
				device.cfa.offsetX = +message.elements.CFA_OFFSET_X!.value
				device.cfa.offsetY = +message.elements.CFA_OFFSET_Y!.value
				device.cfa.type = message.elements.CFA_TYPE!.value as CfaPattern
				this.updated(client, device, 'cfa', message.state)

				return
		}
	}

	blobVector(client: IndiClient, message: DefBlobVector | SetBlobVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'CCD1':
				if (tag[0] === 's') {
					const data = message.elements.CCD1?.value

					if (data) {
						this.blobReceived(client, device, data)
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
	tracking(client: IndiClient, mount: Mount, enable: boolean) {
		client.sendSwitch({ device: mount.name, name: 'TELESCOPE_TRACK_STATE', elements: { [enable ? 'TRACK_ON' : 'TRACK_OFF']: true } })
	}

	park(client: IndiClient, mount: Mount) {
		if (mount.canPark) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_PARK', elements: { PARK: true } })
		}
	}

	unpark(client: IndiClient, mount: Mount) {
		if (mount.canPark) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_PARK', elements: { UNPARK: true } })
		}
	}

	stop(client: IndiClient, mount: Mount) {
		if (mount.canAbort) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	home(client: IndiClient, mount: Mount) {
		if (mount.canHome) {
			client.sendSwitch({ device: mount.name, name: 'TELESCOPE_HOME', elements: { GO: true } })
		}
	}

	equatorialCoordinate(client: IndiClient, mount: Mount, rightAscension: Angle, declination: Angle) {
		client.sendNumber({ device: mount.name, name: 'EQUATORIAL_EOD_COORD', elements: { RA: toHour(normalizeAngle(rightAscension)), DEC: toDeg(declination) } })
	}

	geographicCoordinate(client: IndiClient, mount: Mount, { latitude, longitude, elevation }: GeographicCoordinate) {
		longitude = longitude < 0 ? longitude + TAU : longitude
		client.sendNumber({ device: mount.name, name: 'GEOGRAPHIC_COORD', elements: { LAT: toDeg(latitude), LONG: toDeg(longitude), ELEV: toMeter(elevation) } })
	}

	time(client: IndiClient, mount: Mount, time: GPS['time']) {
		const UTC = formatTemporal(time.utc, 'YYYY-MM-DDTHH:mm:ss')
		const OFFSET = (time.offset / 60).toString()
		client.sendText({ device: mount.name, name: 'TIME_UTC', elements: { UTC, OFFSET } })
	}

	syncTo(client: IndiClient, mount: Mount, rightAscension: Angle, declination: Angle) {
		if (mount.canSync) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { SYNC: true } })
			this.equatorialCoordinate(client, mount, rightAscension, declination)
		}
	}

	goTo(client: IndiClient, mount: Mount, rightAscension: Angle, declination: Angle) {
		if (mount.canGoTo) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { TRACK: true } })
			this.equatorialCoordinate(client, mount, rightAscension, declination)
		}
	}

	flipTo(client: IndiClient, mount: Mount, rightAscension: Angle, declination: Angle) {
		if (mount.canFlip) {
			client.sendSwitch({ device: mount.name, name: 'ON_COORD_SET', elements: { FLIP: true } })
			this.equatorialCoordinate(client, mount, rightAscension, declination)
		}
	}

	moveTo(client: IndiClient, mount: Mount, mode: 'goto' | 'flip' | 'sync', req: MountTargetCoordinate<string | Angle>) {
		let rightAscension = 0
		let declination = 0

		const location: GeographicPosition = { ...mount.geographicCoordinate, ellipsoid: 3 }
		const time = timeNow(true)
		time.location = location

		if (!('type' in req) || req.type === 'JNOW') {
			rightAscension = typeof req.rightAscension === 'number' ? req.rightAscension : parseAngle(req.rightAscension, PARSE_HOUR_ANGLE)!
			declination = typeof req.declination === 'number' ? req.declination : parseAngle(req.declination)!
		} else if (req.type === 'J2000') {
			const rightAscensionJ2000 = typeof req.rightAscension === 'number' ? req.rightAscension : parseAngle(req.rightAscension, PARSE_HOUR_ANGLE)!
			const declinationJ2000 = typeof req.declination === 'number' ? req.declination : parseAngle(req.declination)!

			const fk5 = eraS2c(rightAscensionJ2000, declinationJ2000)
			;[rightAscension, declination] = eraC2s(...precessFk5FromJ2000(fk5, timeNow(true)))
		} else if (req.type === 'ALTAZ') {
			const azimuth = typeof req.azimuth === 'number' ? req.azimuth : parseAngle(req.azimuth)!
			const altitude = typeof req.altitude === 'number' ? req.altitude : parseAngle(req.altitude)!

			;[rightAscension, declination] = observedToCirs(azimuth, altitude, timeNow(true))
		}

		if (mode === 'goto') this.goTo(client, mount, rightAscension, declination)
		else if (mode === 'flip') this.flipTo(client, mount, rightAscension, declination)
		else if (mode === 'sync') this.syncTo(client, mount, rightAscension, declination)
	}

	trackMode(client: IndiClient, mount: Mount, mode: TrackMode) {
		client.sendSwitch({ device: mount.name, name: 'TELESCOPE_TRACK_MODE', elements: { [`TRACK_${mode}`]: true } })
	}

	slewRate(client: IndiClient, mount: Mount, rate: SlewRate | string) {
		client.sendSwitch({ device: mount.name, name: 'TELESCOPE_SLEW_RATE', elements: { [typeof rate === 'string' ? rate : rate.name]: true } })
	}

	moveNorth(client: IndiClient, mount: Mount, enable: boolean) {
		if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: true, MOTION_SOUTH: false } })
		else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: false } })
	}

	moveSouth(client: IndiClient, mount: Mount, enable: boolean) {
		if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_NORTH: false, MOTION_SOUTH: true } })
		else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_NS', elements: { MOTION_SOUTH: false } })
	}

	moveWest(client: IndiClient, mount: Mount, enable: boolean) {
		if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: true, MOTION_EAST: false } })
		else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: false } })
	}

	moveEast(client: IndiClient, mount: Mount, enable: boolean) {
		if (enable) client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_WEST: false, MOTION_EAST: true } })
		else client.sendSwitch({ device: mount.name, name: 'TELESCOPE_MOTION_WE', elements: { MOTION_EAST: false } })
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

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
						this.updated(client, device, 'slewRates', message.state)
					}
				}

				for (const key in elements) {
					const element = elements[key]!

					if (element.value) {
						if (device.slewRate !== element.name) {
							device.slewRate = element.name
							this.updated(client, device, 'slewRate', message.state)
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
						this.updated(client, device, 'trackModes', message.state)
					}
				}

				for (const key in elements) {
					const element = elements[key]!

					if (element.value) {
						const trackMode = element.name.replace('TRACK_', '') as TrackMode

						if (device.trackMode !== trackMode) {
							device.trackMode = trackMode
							this.updated(client, device, 'trackMode', message.state)
						}

						break
					}
				}

				return
			case 'TELESCOPE_TRACK_STATE':
				if (handleSwitchValue(device, 'tracking', elements.TRACK_ON?.value)) {
					this.updated(client, device, 'tracking', message.state)
				}

				return
			case 'TELESCOPE_PIER_SIDE':
				if (handleTextValue(device, 'pierSide', elements.PIER_WEST?.value === true ? 'WEST' : message.elements.PIER_EAST?.value === true ? 'EAST' : 'NEITHER')) {
					this.updated(client, device, 'pierSide', message.state)
				}

				return
			case 'TELESCOPE_PARK':
				handleParkable(this, client, device, message, tag)
				return
			case 'TELESCOPE_ABORT_MOTION':
				if (handleSwitchValue(device, 'canAbort', true)) {
					this.updated(client, device, 'canAbort', message.state)
				}

				return
			case 'TELESCOPE_HOME':
				if (handleSwitchValue(device, 'canHome', true)) {
					this.updated(client, device, 'canHome', message.state)
				}

				return
			case 'ON_COORD_SET':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', 'SYNC' in elements)) {
						this.updated(client, device, 'canSync', message.state)
					}

					if (handleSwitchValue(device, 'canGoTo', 'SLEW' in elements)) {
						this.updated(client, device, 'canGoTo', message.state)
					}

					if (handleSwitchValue(device, 'canFlip', 'FLIP' in elements)) {
						this.updated(client, device, 'canFlip', message.state)
					}
				}

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'EQUATORIAL_EOD_COORD': {
				if (handleSwitchValue(device, 'slewing', message.state === 'Busy')) {
					this.updated(client, device, 'slewing', message.state)
				}

				const { equatorialCoordinate } = device

				let updated = handleNumberValue(equatorialCoordinate, 'rightAscension', message.elements.RA?.value, undefined, hour)
				updated = handleNumberValue(equatorialCoordinate, 'declination', message.elements.DEC?.value, undefined, deg) || updated

				if (updated) {
					this.updated(client, device, 'equatorialCoordinate', message.state)
				}

				return
			}
			case 'GEOGRAPHIC_COORD': {
				const { geographicCoordinate } = device

				let updated = handleNumberValue(geographicCoordinate, 'longitude', message.elements.LONG?.value, undefined, (value) => normalizePI(deg(value)))
				updated = handleNumberValue(geographicCoordinate, 'latitude', message.elements.LAT?.value, undefined, deg) || updated
				updated = handleNumberValue(geographicCoordinate, 'elevation', message.elements.ELEV?.value, undefined, meter) || updated

				if (updated) {
					this.updated(client, device, 'geographicCoordinate', message.state)
				}

				return
			}
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.TELESCOPE)
		}

		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'TIME_UTC': {
				if (message.elements.UTC?.value) {
					const utc = parseTemporal(message.elements.UTC.value, 'YYYY-MM-DDTHH:mm:ss')
					const offset = parseUTCOffset(message.elements.OFFSET!.value)

					let updated = handleNumberValue(device.time, 'utc', utc)
					updated = handleNumberValue(device.time, 'offset', offset) || updated

					if (updated) {
						this.updated(client, device, 'time', message.state)
					}
				}

				return
			}
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indifilterwheel.cpp

export class WheelManager extends DeviceManager<Wheel> {
	moveTo(client: IndiClient, wheel: Wheel, slot: number) {
		client.sendNumber({ device: wheel.name, name: 'FILTER_SLOT', elements: { FILTER_SLOT_VALUE: slot + 1 } })
	}

	slots(client: IndiClient, wheel: Wheel, names: string[]) {
		const elements: Record<string, string> = {}
		names.forEach((name, index) => (elements[`FILTER_SLOT_NAME_${index + 1}`] = name))
		client.sendText({ device: wheel.name, name: 'FILTER_NAME', elements })
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'FILTER_SLOT':
				if (handleNumberValue(device, 'position', message.elements.FILTER_SLOT_VALUE.value - 1)) {
					this.updated(client, device, 'position', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(client, device, 'moving', message.state)
				}

				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.FILTER)
		}

		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'FILTER_NAME': {
				const slots = Object.values(message.elements)

				if (slots.length !== device.slots.length || slots.some((e, index) => e.value !== device.slots[index])) {
					device.slots = slots.map((e) => e.value)
					this.updated(client, device, 'slots', message.state)
				}

				return
			}
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indifocuserinterface.cpp

export class FocuserManager extends DeviceManager<Focuser> {
	stop(client: IndiClient, focuser: Focuser) {
		if (focuser.canAbort) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	moveIn(client: IndiClient, focuser: Focuser, steps: number) {
		if (focuser.canRelativeMove) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_INWARD: true } })
			client.sendNumber({ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: steps } })
		}
	}

	moveOut(client: IndiClient, focuser: Focuser, steps: number) {
		if (focuser.canRelativeMove) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_OUTWARD: true } })
			client.sendNumber({ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: steps } })
		}
	}

	moveTo(client: IndiClient, focuser: Focuser, position: number) {
		if (focuser.canAbsoluteMove) {
			client.sendNumber({ device: focuser.name, name: 'ABS_FOCUS_POSITION', elements: { FOCUS_ABSOLUTE_POSITION: position } })
		}
	}

	syncTo(client: IndiClient, focuser: Focuser, position: number) {
		if (focuser.canSync) {
			client.sendNumber({ device: focuser.name, name: 'FOCUS_SYNC', elements: { FOCUS_SYNC_VALUE: position } })
		}
	}

	reverse(client: IndiClient, focuser: Focuser, enabled: boolean) {
		if (focuser.canSync) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_REVERSE_MOTION', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'FOCUS_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(client, device, 'canAbort', message.state)
					}
				}

				return
			case 'FOCUS_REVERSE_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canReverse', true)) {
						this.updated(client, device, 'canReverse', message.state)
					}
				}

				if (handleSwitchValue(device, 'reversed', message.elements.INDI_ENABLED?.value)) {
					this.updated(client, device, 'reversed', message.state)
				}

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'FOCUS_SYNC':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', true)) {
						this.updated(client, device, 'canSync', message.state)
					}
				}

				return
			case 'REL_FOCUS_POSITION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canRelativeMove', true)) {
						this.updated(client, device, 'canRelativeMove', message.state)
					}
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(client, device, 'moving', message.state)
				}

				return
			case 'ABS_FOCUS_POSITION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbsoluteMove', true)) {
						this.updated(client, device, 'canAbsoluteMove', message.state)
					}
				}

				if (handleMinMaxValue(device.position, message.elements.FOCUS_ABSOLUTE_POSITION, tag)) {
					this.updated(client, device, 'position', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(client, device, 'moving', message.state)
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
	unpark(client: IndiClient, device: Cover) {
		if (device.canPark) {
			client.sendSwitch({ device: device.name, name: 'CAP_PARK', elements: { UNPARK: true } })
		}
	}

	park(client: IndiClient, device: Cover) {
		if (device.canPark) {
			client.sendSwitch({ device: device.name, name: 'CAP_PARK', elements: { PARK: true } })
		}
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'CAP_PARK':
				handleParkable(this, client, device, message, tag)
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
	moveTo(client: IndiClient, rotator: Rotator, angle: number) {
		client.sendNumber({ device: rotator.name, name: 'ABS_ROTATOR_ANGLE', elements: { ANGLE: angle } })
	}

	syncTo(client: IndiClient, rotator: Rotator, angle: number) {
		if (rotator.canSync) {
			client.sendNumber({ device: rotator.name, name: 'SYNC_ROTATOR_ANGLE', elements: { ANGLE: angle } })
		}
	}

	home(client: IndiClient, rotator: Rotator) {
		if (rotator.canHome) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_HOME', elements: { HOME: true } })
		}
	}

	reverse(client: IndiClient, rotator: Rotator, enabled: boolean) {
		if (rotator.canReverse) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_REVERSE', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	stop(client: IndiClient, rotator: Rotator) {
		if (rotator.canAbort) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'ROTATOR_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(client, device, 'canAbort', message.state)
					}
				}

				return
			case 'SYNC_ROTATOR_ANGLE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', true)) {
						this.updated(client, device, 'canSync', message.state)
					}
				}

				return
			case 'ROTATOR_HOME':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canHome', true)) {
						this.updated(client, device, 'canHome', message.state)
					}
				}

				return
			case 'ROTATOR_REVERSE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canReverse', true)) {
						this.updated(client, device, 'canReverse', message.state)
					}
				}

				if (handleSwitchValue(device, 'reversed', message.elements.INDI_ENABLED?.value)) {
					this.updated(client, device, 'reversed', message.state)
				}

				return
			case 'ROTATOR_BACKLASH_TOGGLE':
				if (handleSwitchValue(device, 'hasBacklashCompensation', message.elements.INDI_ENABLED?.value)) {
					this.updated(client, device, 'hasBacklashCompensation', message.state)
				}

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'ABS_ROTATOR_ANGLE':
				if (handleMinMaxValue(device.angle, message.elements.ANGLE, tag)) {
					this.updated(client, device, 'angle', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(client, device, 'moving', message.state)
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

	dutyCycle(client: IndiClient, device: DewHeater, value: number) {
		const property = this.pwmProperty.get(device.name)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: device.name, name, elements: { [element]: value } })
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			// WandererCover V4 EC
			case 'Heater': {
				const device = this.provider.get(message.device)

				if (device) {
					if (tag[0] === 'd') {
						if (handleSwitchValue(device, 'hasDewHeater', true)) {
							if (this.add(client, device)) {
								this.updated(client, device, 'hasDewHeater', message.state)
								this.pwmProperty.set(device.name, [message.name, 'Heater'])
							}
						}
					}

					if (handleMinMaxValue(device.dutyCycle, message.elements.Heater, tag)) {
						this.updated(client, device, 'dutyCycle', message.state)
					}
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'Heater') {
			const device = this.get(message.device)

			if (device) {
				if (handleSwitchValue(device, 'hasDewHeater', false)) {
					this.updated(client, device, 'hasDewHeater')
				}

				this.remove(client, device)
			}
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indilightboxinterface.cpp

export class FlatPanelManager extends DeviceManager<FlatPanel> {
	intensity(client: IndiClient, device: FlatPanel, value: number) {
		if (device.enabled) {
			client.sendNumber({ device: device.name, name: 'FLAT_LIGHT_INTENSITY', elements: { FLAT_LIGHT_INTENSITY_VALUE: value } })
		}
	}

	enable(client: IndiClient, device: FlatPanel) {
		client.sendSwitch({ device: device.name, name: 'FLAT_LIGHT_CONTROL', elements: { FLAT_LIGHT_ON: true } })
	}

	disable(client: IndiClient, device: FlatPanel) {
		client.sendSwitch({ device: device.name, name: 'FLAT_LIGHT_CONTROL', elements: { FLAT_LIGHT_OFF: true } })
	}

	toggle(client: IndiClient, device: FlatPanel) {
		device.enabled ? this.disable(client, device) : this.enable(client, device)
	}

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'FLAT_LIGHT_CONTROL':
				if (handleSwitchValue(device, 'enabled', message.elements.FLAT_LIGHT_ON?.value)) {
					this.updated(client, device, 'enabled', message.state)
				}

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'FLAT_LIGHT_INTENSITY':
				if (handleMinMaxValue(device.intensity, message.elements.FLAT_LIGHT_INTENSITY_VALUE, tag)) {
					this.updated(client, device, 'intensity', message.state)
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
	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'POWER_CHANNELS':
				handlePowerChannel(this, client, device, message, tag, 'dc', 'enabled')
				return
			case 'DEW_CHANNELS':
				handlePowerChannel(this, client, device, message, tag, 'dew', 'enabled')
				return
			case 'AUTO_DEW_CONTROL':
				handlePowerChannel(this, client, device, message, tag, 'autoDew', 'enabled')
				return
			case 'VARIABLE_CHANNELS':
				handlePowerChannel(this, client, device, message, tag, 'variableVoltage', 'enabled')
				return
			case 'USB_PORTS':
				handlePowerChannel(this, client, device, message, tag, 'usb', 'enabled')
				return
			case 'POWER_CYCLE_Toggle':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasPowerCycle', true)) {
						this.updated(client, device, 'hasPowerCycle', message.state)
					}
				}

				return
		}
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'POWER_SENSORS':
				if (handleMinMaxValue(device.voltage, message.elements.SENSOR_VOLTAGE, tag)) {
					this.updated(client, device, 'voltage', message.state)
				}

				if (handleMinMaxValue(device.current, message.elements.SENSOR_CURRENT, tag)) {
					this.updated(client, device, 'current', message.state)
				}

				if (handleMinMaxValue(device.power, message.elements.SENSOR_POWER, tag)) {
					this.updated(client, device, 'power', message.state)
				}

				return
			// Power Channel Current (only if per-channel current monitoring is available)
			case 'POWER_CURRENTS':
				handlePowerChannel(this, client, device, message, tag, 'dc', 'value')
				return
			case 'DEW_DUTY_CYCLES':
				handlePowerChannel(this, client, device, message, tag, 'dew', 'value')
				return
			case 'DEW_CURRENTS':
				handlePowerChannel(this, client, device, message, tag, 'autoDew', 'value')
				return
			case 'VARIABLE_VOLTAGES':
				handlePowerChannel(this, client, device, message, tag, 'variableVoltage', 'value')
				return
		}
	}

	textVector(client: IndiClient, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.POWER)
		}

		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'POWER_LABELS':
				handlePowerChannel(this, client, device, message, tag, 'dc', 'label')
				return
			case 'DEW_LABELS':
				handlePowerChannel(this, client, device, message, tag, 'dew', 'label')
				return
			case 'USB_LABELS':
				handlePowerChannel(this, client, device, message, tag, 'usb', 'label')
				return
			case 'VARIABLE_LABELS':
				handlePowerChannel(this, client, device, message, tag, 'variableVoltage', 'label')
				return
		}
	}

	toggle(client: IndiClient, device: Power, channel: PowerChannel, value: boolean) {
		const name = channel.type === 'dc' ? 'POWER_CHANNELS' : channel.type === 'dew' ? 'DEW_CHANNELS' : channel.type === 'autoDew' ? 'AUTO_DEW_CONTROL' : channel.type === 'usb' ? 'USB_PORTS' : 'VARIABLE_CHANNELS'
		client.sendSwitch({ device: device.name, name, elements: { [channel.name]: value } })
	}

	voltage(client: IndiClient, device: Power, channel: PowerChannel, value: number) {
		if (channel.type !== 'variableVoltage') return
		client.sendNumber({ device: device.name, name: 'VARIABLE_VOLTAGES', elements: { [channel.name]: value } })
	}

	dutyCycle(client: IndiClient, device: Power, channel: PowerChannel, value: number) {
		if (channel.type !== 'dew') return
		client.sendNumber({ device: device.name, name: 'DEW_DUTY_CYCLES', elements: { [channel.name]: value } })
	}
}

function handlePowerChannel(manager: DeviceManager<Power>, client: IndiClient, device: Power, message: DefVector | SetVector, tag: string, type: PowerChannelType, property: keyof Omit<PowerChannel, 'type'>) {
	const entries = Object.entries(message.elements) as readonly [string, DefElement][]
	const channels = device[type]
	let updated = false

	entries.forEach(([name, entry], i) => {
		const value = entry.value as never
		const p = channels[i] ?? ({ type, name, label: entry.label ?? '', enabled: false, value: 0, min: 0, max: 0 } satisfies PowerChannel)

		if (tag[0] === 'd' && 'max' in entry) {
			updated ||= handleMinMaxValue(p, entry, tag)
		} else if (p[property] !== value) {
			p[property] = value
			updated = true
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
		manager.updated(client, device, type, message.state)
	}

	return updated
}

function handleParkable<D extends Device & Parkable>(manager: DeviceManager<D>, client: IndiClient, device: D, message: DefSwitchVector | SetSwitchVector, tag: string) {
	if (tag[0] === 'd') {
		if (handleSwitchValue<Device & Parkable>(device, 'canPark', (message as DefSwitchVector).permission !== 'ro')) {
			manager.updated(client, device, 'canPark', message.state)
		}
	}

	if (handleSwitchValue<Device & Parkable>(device, 'parking', message.state === 'Busy')) {
		manager.updated(client, device, 'parking', message.state)
	}

	if (handleSwitchValue<Device & Parkable>(device, 'parked', !!message.elements.PARK?.value)) {
		manager.updated(client, device, 'parked', message.state)
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
		const { min, max } = element as DefNumber

		if (max !== 0) {
			update = min !== property.min || max !== property.max
			property.min = min
			property.max = max
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
