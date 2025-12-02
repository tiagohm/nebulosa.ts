import { type Angle, deg, hour, normalizeAngle, toDeg, toHour } from './angle'
import { PI, TAU } from './constants'
import { type Distance, meter, toMeter } from './distance'
import type { CfaPattern } from './image'
import type { DefBlobVector, DefLightVector, DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefTextVector, DefVector, DelProperty, IndiClient, IndiClientHandler, OneNumber, PropertyState, SetBlobVector, SetNumberVector, SetSwitchVector, SetTextVector, SetVector, VectorType } from './indi'
import { formatTemporal, parseTemporal } from './temporal'

export type DeviceType = 'CAMERA' | 'MOUNT' | 'WHEEL' | 'FOCUSER' | 'ROTATOR' | 'GPS' | 'DOME' | 'GUIDE_OUTPUT' | 'FLAT_PANEL' | 'COVER' | 'THERMOMETER' | 'DEW_HEATER'

export type DeviceProperty = (DefTextVector & { type: 'TEXT' }) | (DefNumberVector & { type: 'NUMBER' }) | (DefSwitchVector & { type: 'SWITCH' }) | (DefLightVector & { type: 'LIGHT' }) | (DefBlobVector & { type: 'BLOB' })

export type DeviceProperties = Record<string, DeviceProperty>

export type FrameType = 'LIGHT' | 'DARK' | 'FLAT' | 'BIAS'

export type PierSide = 'EAST' | 'WEST' | 'NEITHER'

export type MountType = 'ALTAZ' | 'EQ_FORK' | 'EQ_GEM'

export type TrackMode = 'SIDEREAL' | 'SOLAR' | 'LUNAR' | 'KING' | 'CUSTOM'

export type MinMaxValueProperty = Pick<DefNumber, 'min' | 'max' | 'value'>

export enum DeviceInterfaceType {
	TELESCOPE = 0x0001, // Telescope interface, must subclass INDI::Telescope.
	CCD = 0x0002, // CCD interface, must subclass INDI::CCD.
	GUIDER = 0x0004, // Guider interface, must subclass INDI::GuiderInterface.
	FOCUSER = 0x0008, // Focuser interface, must subclass INDI::FocuserInterface.
	FILTER = 0x0010, // Filter interface, must subclass INDI::FilterInterface.
	DOME = 0x0020, // Dome interface, must subclass INDI::Dome.
	GPS = 0x0040, // GPS interface, must subclass INDI::GPS.
	WEATHER = 0x0080, // Weather interface, must subclass INDI::Weather.
	AO = 0x0100, // Adaptive Optics Interface.
	DUSTCAP = 0x0200, // Dust Cap Interface.
	LIGHTBOX = 0x0400, // Light Box Interface.
	DETECTOR = 0x0800, // Detector interface, must subclass INDI::Detector.
	ROTATOR = 0x1000, // Rotator interface, must subclass INDI::RotatorInterface.
	SPECTROGRAPH = 0x2000, // Spectrograph interface.
	CORRELATOR = 0x4000, // Correlators (interferometers) interface.
	AUXILIARY = 0x8000, // Auxiliary interface.
	OUTPUT = 0x10000, // Digital Output (e.g. Relay) interface.
	INPUT = 0x20000, // Digital/Analog Input (e.g. GPIO) interface.
	POWER = 0x40000, // Auxiliary interface.
	SENSOR_INTERFACE = SPECTROGRAPH | DETECTOR | CORRELATOR,
}

export function isInterfaceType(value: number, type: DeviceInterfaceType): value is DeviceInterfaceType {
	return (value & type) !== 0
}

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

export interface DriverInfo {
	executable: string
	version: string
}

export interface Device {
	type: DeviceType
	name: string
	connected: boolean
	driver: DriverInfo
}

export interface EquatorialCoordinate<T = Angle> {
	rightAscension: T
	declination: T
}

export interface EquatorialCoordinateJ2000<T = Angle> {
	rightAscensionJ2000: T
	declinationJ2000: T
}

export interface HorizontalCoordinate<T = Angle> {
	azimuth: T
	altitude: T
}

export interface GeographicCoordinate {
	latitude: Angle
	longitude: Angle
	elevation: Distance
}

export interface UTCTime {
	utc: number // milliseconds since epoch
	offset: number // minutes
}

export interface GuideOutput extends Device {
	readonly type: 'GUIDE_OUTPUT' | 'MOUNT' | 'CAMERA'
	canPulseGuide: boolean
	pulseGuiding: boolean
}

export interface Thermometer extends Device {
	readonly type: 'THERMOMETER' | 'CAMERA' | 'FOCUSER'
	hasThermometer: boolean
	temperature: number
}

export interface Camera extends GuideOutput, Thermometer {
	readonly type: 'CAMERA'
	hasCoolerControl: boolean
	coolerPower: number
	cooler: boolean
	hasDewHeater: boolean
	dewHeater: boolean
	frameFormats: string[]
	canAbort: boolean
	readonly cfa: {
		offsetX: number
		offsetY: number
		type: CfaPattern
	}
	readonly exposure: {
		time: number
		min: number
		max: number
		state: PropertyState
	}
	hasCooler: boolean
	canSetTemperature: boolean
	canSubFrame: boolean
	readonly frame: {
		x: number
		minX: number
		maxX: number
		y: number
		minY: number
		maxY: number
		width: number
		minWidth: number
		maxWidth: number
		height: number
		minHeight: number
		maxHeight: number
	}
	canBin: boolean
	readonly bin: {
		maxX: number
		maxY: number
		x: number
		y: number
	}
	readonly gain: MinMaxValueProperty
	readonly offset: MinMaxValueProperty
	readonly pixelSize: {
		x: number
		y: number
	}
}

export interface GPS extends Device {
	readonly type: 'GPS' | 'MOUNT'
	hasGPS: boolean
	readonly geographicCoordinate: GeographicCoordinate
	readonly time: UTCTime
}

export interface Parkable {
	canPark: boolean
	parking: boolean
	parked: boolean
}

export interface SlewRate {
	name: string
	label: string
}

export interface Mount extends GuideOutput, GPS, Parkable {
	readonly type: 'MOUNT'
	slewing: boolean
	tracking: boolean
	canAbort: boolean
	canSync: boolean
	canGoTo: boolean
	canFlip: boolean
	canHome: boolean
	slewRates: SlewRate[]
	slewRate?: SlewRate['name']
	mountType: MountType
	trackModes: TrackMode[]
	trackMode: TrackMode
	pierSide: PierSide
	guideRateWE: number
	guideRateNS: number
	readonly equatorialCoordinate: EquatorialCoordinate
}

export const DEFAULT_CAMERA: Camera = {
	hasCoolerControl: false,
	coolerPower: 0,
	cooler: false,
	hasDewHeater: false,
	dewHeater: false,
	frameFormats: [],
	canAbort: false,
	cfa: {
		offsetX: 0,
		offsetY: 0,
		type: 'RGGB',
	},
	exposure: {
		time: 0,
		min: 0,
		max: 0,
		state: 'Idle',
	},
	hasCooler: false,
	canSetTemperature: false,
	canSubFrame: false,
	frame: {
		x: 0,
		minX: 0,
		maxX: 0,
		y: 0,
		minY: 0,
		maxY: 0,
		width: 0,
		minWidth: 0,
		maxWidth: 0,
		height: 0,
		minHeight: 0,
		maxHeight: 0,
	},
	canBin: false,
	bin: {
		maxX: 0,
		maxY: 0,
		x: 0,
		y: 0,
	},
	gain: {
		value: 0,
		min: 0,
		max: 0,
	},
	offset: {
		value: 0,
		min: 0,
		max: 0,
	},
	pixelSize: {
		x: 0,
		y: 0,
	},
	canPulseGuide: false,
	pulseGuiding: false,
	type: 'CAMERA',
	name: '',
	connected: false,
	driver: {
		executable: '',
		version: '',
	},
	hasThermometer: false,
	temperature: 0,
}

export const DEFAULT_MOUNT: Mount = {
	slewing: false,
	tracking: false,
	canAbort: false,
	canSync: false,
	canGoTo: false,
	canFlip: false,
	canHome: false,
	canPark: false,
	slewRates: [],
	mountType: 'EQ_GEM',
	trackModes: [],
	trackMode: 'SIDEREAL',
	pierSide: 'NEITHER',
	guideRateWE: 0,
	guideRateNS: 0,
	equatorialCoordinate: {
		rightAscension: 0,
		declination: 0,
	},
	canPulseGuide: false,
	pulseGuiding: false,
	type: 'MOUNT',
	name: '',
	connected: false,
	driver: {
		executable: '',
		version: '',
	},
	hasGPS: false,
	geographicCoordinate: {
		latitude: 0,
		longitude: 0,
		elevation: 0,
	},
	time: {
		utc: 0,
		offset: 0,
	},
	parking: false,
	parked: false,
}

export function isCamera(device: Device): device is Camera {
	return device.type === 'CAMERA'
}

// export function isMount(device: Device): device is Mount {
// 	return device.type === 'MOUNT'
// }

export function isThermometer(device: Device): device is Thermometer {
	return 'hasThermometer' in device && device.hasThermometer !== undefined
}

export function isGuideOutput(device: Device): device is GuideOutput {
	return 'canPulseGuide' in device && device.canPulseGuide !== undefined
}

// export function isDewHeater(device: Device): device is DewHeater {
// 	return 'hasDewHeater' in device && device.hasDewHeater !== undefined
// }

export function isGPS(device: Device): device is GPS {
	return 'hasGPS' in device && device.hasGPS !== undefined
}

const DEVICES = {
	[DeviceInterfaceType.TELESCOPE]: DEFAULT_MOUNT,
	[DeviceInterfaceType.CCD]: DEFAULT_CAMERA,
} as const

export class DevicePropertyManager implements IndiClientHandler {
	private readonly properties = new Map<string, DeviceProperties>()

	constructor(readonly handler: DevicePropertyHandler) {}

	get length() {
		return this.properties.size
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

	vector(client: IndiClient, message: DefVector | SetVector, tag: `def${VectorType}Vector` | `set${VectorType}Vector`) {
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
			this.handler.added(device, property)
			return true
		} else {
			let updated = false
			const property = properties[message.name]

			if (property) {
				if (message.state && message.state !== property.state) {
					property.state = message.state
					updated = true
				}

				for (const key in message.elements) {
					const element = property.elements[key]

					if (element) {
						const value = message.elements[key]!.value

						if (value !== element.value) {
							element.value = value
							updated = true
						}
					}
				}

				if (updated) {
					this.handler.updated(device, property)
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
				this.handler.removed(device, property)
				return true
			}
		} else {
			// TODO: should notify once for all properties being removed?
			for (const [_, property] of Object.entries(properties)) this.handler.removed(device, property)
			this.properties.delete(device)
			return true
		}

		return false
	}
}

export interface DeviceProvider<D extends Device> {
	readonly get: (name: string) => D | undefined
}

export abstract class DeviceManager<D extends Device> implements IndiClientHandler, DeviceProvider<D> {
	protected readonly devices = new Map<string, D>()

	constructor(readonly handler: DeviceHandler<D>) {}

	get length() {
		return this.devices.size
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

	switchVector(client: IndiClient, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'CONNECTION':
				if (this.handleConnection(client, device, message)) {
					this.update(client, device, 'connected', message.state)
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

		if (connected !== device.connected) {
			device.connected = connected
			if (connected) this.ask(client, device)
			return true
		}

		return false
	}

	protected handleDriverInfo(client: IndiClient, message: DefTextVector | SetTextVector, interfaceType: DeviceInterfaceType) {
		const type = +message.elements.DRIVER_INTERFACE!.value
		let device = this.get(message.device)

		if (isInterfaceType(type, interfaceType)) {
			if (!device) {
				const executable = message.elements.DRIVER_EXEC!.value
				const version = message.elements.DRIVER_VERSION!.value

				device = structuredClone(DEVICES[interfaceType as never]) as D
				device.name = message.device
				device.driver = { executable, version }

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
			this.handler.added(client, device)
		}
	}

	update(client: IndiClient, device: D, property: keyof D, state?: PropertyState) {
		this.handler.updated(client, device, property, state)
	}

	remove(client: IndiClient, device: D) {
		if (this.has(device.name)) {
			this.devices.delete(device.name)
			this.handler.removed(client, device)
		}
	}

	close(client: IndiClient, server: boolean) {
		for (const [_, device] of this.devices) {
			this.remove(client, device)
		}
	}
}

export class GuideOutputManager extends DeviceManager<GuideOutput> {
	constructor(
		readonly provider: DeviceProvider<GuideOutput>,
		handler: DeviceHandler<GuideOutput>,
	) {
		super(handler)
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE': {
				const device = this.provider.get(message.device)

				if (device && tag[0] === 'd') {
					this.add(client, device)
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'TELESCOPE_TIMED_GUIDE_NS' || message.name === 'TELESCOPE_TIMED_GUIDE_WE') {
			super.delProperty(client, message)
		}
	}
}

export class ThermometerManager extends DeviceManager<Thermometer> {
	constructor(
		readonly provider: DeviceProvider<Thermometer>,
		handler: DeviceHandler<Thermometer>,
	) {
		super(handler)
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'CCD_TEMPERATURE': {
				const device = this.provider.get(message.device)

				if (device && tag[0] === 'd') {
					this.add(client, device)
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'CCD_TEMPERATURE') {
			super.delProperty(client, message)
		}
	}
}

export class CameraManager extends DeviceManager<Camera> {
	constructor(
		readonly propertyManager: DevicePropertyManager,
		handler: DeviceHandler<Camera>,
	) {
		super(handler)
	}

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
		const properties = this.propertyManager.list(camera.name)

		if (properties?.CCD_CONTROLS?.elements.Gain) {
			client.sendNumber({ device: camera.name, name: 'CCD_CONTROLS', elements: { Gain: value } })
		} else if (properties?.CCD_GAIN?.elements.GAIN) {
			client.sendNumber({ device: camera.name, name: 'CCD_GAIN', elements: { GAIN: value } })
		}
	}

	offset(client: IndiClient, camera: Camera, value: number) {
		const properties = this.propertyManager.list(camera.name)

		if (properties?.CCD_CONTROLS?.elements.Offset) {
			client.sendNumber({ device: camera.name, name: 'CCD_CONTROLS', elements: { Offset: value } })
		} else if (properties?.CCD_OFFSET?.elements.OFFSET) {
			client.sendNumber({ device: camera.name, name: 'CCD_OFFSET', elements: { OFFSET: value } })
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
			case 'CCD_COOLER': {
				if (tag[0] === 'd' && !device.hasCoolerControl) {
					device.hasCoolerControl = true
					this.update(client, device, 'hasCoolerControl', message.state)
				}

				const cooler = message.elements.COOLER_ON?.value === true

				if (cooler !== device.cooler) {
					device.cooler = cooler
					this.update(client, device, 'cooler', message.state)
				}

				return
			}
			case 'CCD_CAPTURE_FORMAT':
				if (tag[0] === 'd') {
					device.frameFormats = Object.keys(message.elements)
					this.update(client, device, 'frameFormats', message.state)
				}

				return
			case 'CCD_ABORT_EXPOSURE':
				if (tag[0] === 'd') {
					const canAbort = (message as DefSwitchVector).permission !== 'ro'

					if (device.canAbort !== canAbort) {
						device.canAbort = canAbort
						this.update(client, device, 'canAbort', message.state)
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
				const x = message.elements.CCD_PIXEL_SIZE_X?.value ?? 0
				const y = message.elements.CCD_PIXEL_SIZE_Y?.value ?? 0

				if (device.pixelSize.x !== x || device.pixelSize.y !== y) {
					device.pixelSize.x = x
					device.pixelSize.y = y
					this.update(client, device, 'pixelSize', message.state)
				}

				return
			}
			case 'CCD_EXPOSURE': {
				const value = message.elements.CCD_EXPOSURE_VALUE!

				const { exposure } = device
				let update = false

				if (tag[0] === 'd') {
					const { min, max } = value as DefNumber
					exposure.min = min
					exposure.max = max
					update = max !== 0
				}

				if (message.state && message.state !== exposure.state) {
					exposure.state = message.state
					update = true
				}

				if (exposure.state === 'Busy' || exposure.state === 'Ok') {
					exposure.time = value.value
					update = true
				}

				if (update) {
					this.update(client, device, 'exposure', message.state)
				}

				return
			}
			case 'CCD_COOLER_POWER': {
				const coolerPower = message.elements.CCD_COOLER_POWER?.value ?? 0

				if (device.coolerPower !== coolerPower) {
					device.coolerPower = coolerPower
					this.update(client, device, 'coolerPower', message.state)
				}

				return
			}
			case 'CCD_TEMPERATURE':
				if (tag[0] === 'd') {
					if (!device.hasCooler) {
						device.hasCooler = true
						this.update(client, device, 'hasCooler', message.state)
					}

					const canSetTemperature = (message as DefNumberVector).permission !== 'ro'

					if (device.canSetTemperature !== canSetTemperature) {
						device.canSetTemperature = canSetTemperature
						this.update(client, device, 'canSetTemperature', message.state)
					}

					if (!device.hasThermometer) {
						device.hasThermometer = true
						this.update(client, device, 'hasThermometer', message.state)
					}
				}

				return
			case 'CCD_FRAME': {
				const x = message.elements.X!
				const y = message.elements.Y!
				const width = message.elements.WIDTH!
				const height = message.elements.HEIGHT!

				const { frame } = device
				let update = false

				if (tag[0] === 'd') {
					const canSubFrame = (message as DefNumberVector).permission !== 'ro'

					if (device.canSubFrame !== canSubFrame) {
						device.canSubFrame = canSubFrame
						this.update(client, device, 'canSubFrame', message.state)
					}

					frame.minX = (x as DefNumber).min
					frame.maxX = (x as DefNumber).max
					frame.minY = (y as DefNumber).min
					frame.maxY = (y as DefNumber).max
					frame.minWidth = (width as DefNumber).min
					frame.maxWidth = (width as DefNumber).max
					frame.minHeight = (height as DefNumber).min
					frame.maxHeight = (height as DefNumber).max

					update = frame.maxX !== 0 && frame.maxY !== 0 && frame.maxWidth !== 0 && frame.maxHeight !== 0
				}

				if (update || frame.x !== x.value || frame.y !== y.value || frame.width !== width.value || frame.height !== height.value) {
					frame.x = x.value
					frame.y = y.value
					frame.width = width.value
					frame.height = height.value
					update = true
				}

				if (update) {
					this.update(client, device, 'frame', message.state)
				}

				return
			}
			case 'CCD_BINNING': {
				const binX = message.elements.HOR_BIN!
				const binY = message.elements.VER_BIN!

				const { bin } = device
				let update = false

				if (tag[0] === 'd') {
					const canBin = (message as DefNumberVector).permission !== 'ro'

					if (device.canBin !== canBin) {
						device.canBin = canBin
						this.update(client, device, 'canBin', message.state)
					}

					bin.maxX = (binX as DefNumber).max
					bin.maxY = (binY as DefNumber).max

					update = bin.maxX !== 0 && bin.maxY !== 0
				}

				if (update || bin.x !== binX.value || bin.y !== binY.value) {
					bin.x = binX.value
					bin.y = binY.value
					update = true
				}

				if (update) {
					this.update(client, device, 'bin', message.state)
				}

				return
			}
			// ZWO ASI, SVBony, etc
			case 'CCD_CONTROLS': {
				const gain = message.elements.Gain

				if (gain && handleMinMaxValue(device.gain, gain, tag)) {
					this.update(client, device, 'gain', message.state)
				}

				const offset = message.elements.Offset

				if (offset && handleMinMaxValue(device.offset, offset, tag)) {
					this.update(client, device, 'offset', message.state)
				}

				return
			}
			// CCD Simulator
			case 'CCD_GAIN': {
				const gain = message.elements.GAIN

				if (gain && handleMinMaxValue(device.gain, gain, tag)) {
					this.update(client, device, 'gain', message.state)
				}

				return
			}
			case 'CCD_OFFSET': {
				const offset = message.elements.OFFSET

				if (offset && handleMinMaxValue(device.offset, offset, tag)) {
					this.update(client, device, 'offset', message.state)
				}

				return
			}
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE':
				if (tag[0] === 'd' && !device.canPulseGuide) {
					device.canPulseGuide = true
					this.update(client, device, 'canPulseGuide', message.state)
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
				this.update(client, device, 'cfa', message.state)

				return
		}
	}

	blobVector(client: IndiClient, message: DefBlobVector | SetBlobVector, tag: string) {
		const device = this.get(message.device)

		if (!device) return

		switch (message.name) {
			case 'CCD1':
				if (tag[0] === 's' && this.handler.blobReceived) {
					const data = message.elements.CCD1?.value

					if (data) {
						this.handler.blobReceived(client, device, data)
					} else {
						console.warn(`received empty BLOB for device ${device.name}`)
					}
				}

				return
		}
	}
}

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

	private equatorialCoordinate(client: IndiClient, mount: Mount, rightAscension: Angle, declination: Angle) {
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

		switch (message.name) {
			case 'TELESCOPE_SLEW_RATE':
				if (tag[0] === 'd') {
					const rates: SlewRate[] = []

					for (const key in message.elements) {
						const element = message.elements[key] as DefSwitch
						rates.push({ name: element.name, label: element.label! })
					}

					if (rates.length) {
						device.slewRates = rates
						this.update(client, device, 'slewRates', message.state)
					}
				}

				for (const key in message.elements) {
					const element = message.elements[key]!

					if (element.value) {
						if (device.slewRate !== element.name) {
							device.slewRate = element.name
							this.update(client, device, 'slewRate', message.state)
						}

						break
					}
				}

				return
			case 'TELESCOPE_TRACK_MODE':
				if (tag[0] === 'd') {
					const modes: TrackMode[] = []

					for (const key in message.elements) {
						const element = message.elements[key] as DefSwitch
						modes.push(element.name.replace('TRACK_', '') as TrackMode)
					}

					if (modes.length) {
						device.trackModes = modes
						this.update(client, device, 'trackModes', message.state)
					}
				}

				for (const key in message.elements) {
					const element = message.elements[key]!

					if (element.value) {
						const trackMode = element.name.replace('TRACK_', '') as TrackMode

						if (device.trackMode !== trackMode) {
							device.trackMode = trackMode
							this.update(client, device, 'trackMode', message.state)
						}

						break
					}
				}

				return
			case 'TELESCOPE_TRACK_STATE': {
				const tracking = message.elements.TRACK_ON?.value === true

				if (device.tracking !== tracking) {
					device.tracking = tracking
					this.update(client, device, 'tracking', message.state)
				}

				return
			}
			case 'TELESCOPE_PIER_SIDE': {
				const pierSide = message.elements.PIER_WEST?.value === true ? 'WEST' : message.elements.PIER_EAST?.value === true ? 'EAST' : 'NEITHER'

				if (device.pierSide !== pierSide) {
					device.pierSide = pierSide
					this.update(client, device, 'pierSide', message.state)
				}

				return
			}
			case 'TELESCOPE_PARK': {
				if (tag[0] === 'd') {
					const canPark = (message as DefSwitchVector).permission !== 'ro'

					if (device.canPark !== canPark) {
						device.canPark = canPark
						this.update(client, device, 'canPark', message.state)
					}
				}

				if (message.state) {
					const parking = message.state === 'Busy'

					if (device.parking !== parking) {
						device.parking = parking
						this.update(client, device, 'parking', message.state)
					}
				}

				const parked = message.elements.PARK?.value === true

				if (device.parked !== parked) {
					device.parked = parked
					this.update(client, device, 'parked', message.state)
				}

				return
			}
			case 'TELESCOPE_ABORT_MOTION':
				if (!device.canAbort) {
					device.canAbort = true
					this.update(client, device, 'canAbort', message.state)
				}

				return
			case 'TELESCOPE_HOME':
				if (!device.canHome) {
					device.canHome = true
					this.update(client, device, 'canHome', message.state)
				}

				return
			case 'ON_COORD_SET':
				if (tag[0] === 'd') {
					const canSync = 'SYNC' in message.elements

					if (device.canSync !== canSync) {
						device.canSync = canSync
						this.update(client, device, 'canSync', message.state)
					}

					const canGoTo = 'SLEW' in message.elements

					if (device.canGoTo !== canGoTo) {
						device.canGoTo = canGoTo
						this.update(client, device, 'canGoTo', message.state)
					}

					const canFlip = 'FLIP' in message.elements

					if (device.canFlip !== canFlip) {
						device.canFlip = canFlip
						this.update(client, device, 'canFlip', message.state)
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
				const slewing = message.state === 'Busy'

				if (device.slewing !== slewing) {
					device.slewing = slewing
					this.update(client, device, 'slewing', message.state)
				}

				const rightAscension = hour(message.elements.RA!.value)
				const declination = deg(message.elements.DEC!.value)

				const { equatorialCoordinate } = device
				let updated = false

				if (equatorialCoordinate.rightAscension !== rightAscension) {
					equatorialCoordinate.rightAscension = rightAscension
					updated = true
				}

				if (equatorialCoordinate.declination !== declination) {
					equatorialCoordinate.declination = declination
					updated = true
				}

				if (updated) {
					this.update(client, device, 'equatorialCoordinate', message.state)
				}

				return
			}
			case 'GEOGRAPHIC_COORD': {
				const longitude = deg(message.elements.LONG!.value)
				const latitude = deg(message.elements.LAT!.value)
				const elevation = meter(message.elements.ELEV!.value)

				const { geographicCoordinate } = device
				let updated = false

				if (geographicCoordinate.longitude !== longitude) {
					geographicCoordinate.longitude = longitude >= PI ? longitude - TAU : longitude
					updated = true
				}

				if (geographicCoordinate.latitude !== latitude) {
					geographicCoordinate.latitude = latitude
					updated = true
				}

				if (geographicCoordinate.elevation !== elevation) {
					geographicCoordinate.elevation = elevation
					updated = true
				}

				if (updated) {
					this.update(client, device, 'geographicCoordinate', message.state)
				}

				return
			}
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE':
				if (tag[0] === 'd' && !device.canPulseGuide) {
					device.canPulseGuide = true
					this.update(client, device, 'canPulseGuide', message.state)
				}

				return
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

					if (device.time.utc !== utc || device.time.offset !== offset) {
						device.time.utc = utc
						device.time.offset = offset
						this.update(client, device, 'time', message.state)
					}
				}

				return
			}
		}
	}
}

function handleMinMaxValue(property: MinMaxValueProperty, element: DefNumber | OneNumber, tag: string) {
	let update = false

	if (tag[0] === 'd') {
		property.min = (element as DefNumber).min
		property.max = (element as DefNumber).max
		update = true
	}

	if (update || property.value !== element.value) {
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
