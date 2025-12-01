import type { CfaPattern } from './image'
import type { DefBlobVector, DefLightVector, DefNumber, DefNumberVector, DefSwitchVector, DefTextVector, DefVector, DelProperty, IndiClient, IndiClientHandler, OneNumber, PropertyState, SetBlobVector, SetNumberVector, SetSwitchVector, SetTextVector, SetVector, VectorType } from './indi'

export type DeviceType = 'CAMERA' | 'MOUNT' | 'WHEEL' | 'FOCUSER' | 'ROTATOR' | 'GPS' | 'DOME' | 'GUIDE_OUTPUT' | 'FLAT_PANEL' | 'COVER' | 'THERMOMETER' | 'DEW_HEATER'

export type DeviceProperty = (DefTextVector & { type: 'TEXT' }) | (DefNumberVector & { type: 'NUMBER' }) | (DefSwitchVector & { type: 'SWITCH' }) | (DefLightVector & { type: 'LIGHT' }) | (DefBlobVector & { type: 'BLOB' })

export type DeviceProperties = Record<string, DeviceProperty>

export type FrameType = 'LIGHT' | 'DARK' | 'FLAT' | 'BIAS'

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
	id: string
	name: string
	connected: boolean
	driver: DriverInfo
	// properties: DeviceProperties
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
	readonly gain: Pick<DefNumber, 'min' | 'max' | 'value'>
	readonly offset: Pick<DefNumber, 'min' | 'max' | 'value'>
	readonly pixelSize: {
		x: number
		y: number
	}
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
	id: '',
	name: '',
	connected: false,
	driver: {
		executable: '',
		version: '',
	},
	hasThermometer: false,
	temperature: 0,
	// properties: {},
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

// export function isGPS(device: Device): device is GPS {
// 	return 'hasGPS' in device && device.hasGPS !== undefined
// }

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

export abstract class DeviceManager<D extends Device> implements IndiClientHandler {
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
				if (this.connectionFor(client, device, message)) {
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

	protected connectionFor(client: IndiClient, device: D, message: DefSwitchVector | SetSwitchVector) {
		const connected = message.elements.CONNECT?.value === true

		if (connected !== device.connected) {
			device.connected = connected
			if (connected) this.ask(client, device)
			return true
		}

		return false
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
		readonly cameraManager: CameraManager,
		handler: DeviceHandler<GuideOutput>,
	) {
		super(handler)
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE': {
				const device = this.cameraManager.get(message.device)

				if (device && tag[0] === 'd') {
					this.add(client, device)
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'TELESCOPE_TIMED_GUIDE_NS' || message.name === 'TELESCOPE_TIMED_GUIDE_WE') {
			const device = this.get(message.device)
			device && this.remove(client, device)
		}
	}
}

export class ThermometerManager extends DeviceManager<Thermometer> {
	constructor(
		readonly cameraManager: CameraManager,
		handler: DeviceHandler<Thermometer>,
	) {
		super(handler)
	}

	numberVector(client: IndiClient, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'CCD_TEMPERATURE': {
				const device = this.cameraManager.get(message.device)

				if (device && tag[0] === 'd') {
					this.add(client, device)
				}

				return
			}
		}
	}

	delProperty(client: IndiClient, message: DelProperty) {
		if (message.name === 'CCD_TEMPERATURE') {
			const device = this.get(message.device)
			device && this.remove(client, device)
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
		} else if (properties?.CCD_GAIN?.elements?.GAIN) {
			client.sendNumber({ device: camera.name, name: 'CCD_GAIN', elements: { GAIN: value } })
		}
	}

	offset(client: IndiClient, camera: Camera, value: number) {
		const properties = this.propertyManager.list(camera.name)

		if (properties?.CCD_CONTROLS?.elements.Offset) {
			client.sendNumber({ device: camera.name, name: 'CCD_CONTROLS', elements: { Offset: value } })
		} else if (properties?.CCD_OFFSET?.elements?.OFFSET) {
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
				let update = false

				if (tag[0] === 'd') {
					const { min, max } = value as DefNumber
					device.exposure.min = min
					device.exposure.max = max
					update = true
				}

				if (message.state && message.state !== device.exposure.state) {
					device.exposure.state = message.state
					update = true
				}

				if (device.exposure.state === 'Busy' || device.exposure.state === 'Ok') {
					device.exposure.time = value.value
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

				let update = false

				if (tag[0] === 'd') {
					const canSubFrame = (message as DefNumberVector).permission !== 'ro'

					if (device.canSubFrame !== canSubFrame) {
						device.canSubFrame = canSubFrame
						this.update(client, device, 'canSubFrame', message.state)
					}

					device.frame.minX = (x as DefNumber).min
					device.frame.maxX = (x as DefNumber).max
					device.frame.minY = (y as DefNumber).min
					device.frame.maxY = (y as DefNumber).max
					device.frame.minWidth = (width as DefNumber).min
					device.frame.maxWidth = (width as DefNumber).max
					device.frame.minHeight = (height as DefNumber).min
					device.frame.maxHeight = (height as DefNumber).max

					update = true
				}

				if (update || device.frame.x !== x.value || device.frame.y !== y.value || device.frame.width !== width.value || device.frame.height !== height.value) {
					device.frame.x = x.value
					device.frame.y = y.value
					device.frame.width = width.value
					device.frame.height = height.value
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

				if (tag[0] === 'd') {
					const canBin = (message as DefNumberVector).permission !== 'ro'

					if (device.canBin !== canBin) {
						device.canBin = canBin
						this.update(client, device, 'canBin', message.state)
					}

					device.bin.maxX = (binX as DefNumber).max
					device.bin.maxY = (binY as DefNumber).max
				}

				device.bin.x = binX.value
				device.bin.y = binY.value

				this.update(client, device, 'bin', message.state)

				return
			}
			// ZWO ASI, SVBony, etc
			case 'CCD_CONTROLS': {
				const gain = message.elements.Gain

				if (gain && gainFor(device.gain, gain, tag)) {
					this.update(client, device, 'gain', message.state)
				}

				const offset = message.elements.Offset

				if (offset && offsetFor(device.offset, offset, tag)) {
					this.update(client, device, 'offset', message.state)
				}

				return
			}
			// CCD Simulator
			case 'CCD_GAIN': {
				const gain = message.elements.GAIN

				if (gain && gainFor(device.gain, gain, tag)) {
					this.update(client, device, 'gain', message.state)
				}

				return
			}
			case 'CCD_OFFSET': {
				const offset = message.elements.OFFSET

				if (offset && offsetFor(device.offset, offset, tag)) {
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
			const type = +message.elements.DRIVER_INTERFACE!.value

			if (isInterfaceType(type, DeviceInterfaceType.CCD)) {
				if (!this.has(message.device)) {
					const executable = message.elements.DRIVER_EXEC!.value
					const version = message.elements.DRIVER_VERSION!.value

					const camera: Camera = { ...structuredClone(DEFAULT_CAMERA), id: message.device, name: message.device, driver: { executable, version } }
					this.add(client, camera)
					this.ask(client, camera)
				}
			} else if (this.has(message.device)) {
				this.remove(client, this.get(message.device)!)
			}

			return
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

function gainFor(gain: Camera['gain'], element: DefNumber | OneNumber, tag: string) {
	let update = false

	if (tag[0] === 'd') {
		gain.min = (element as DefNumber).min
		gain.max = (element as DefNumber).max
		update = true
	}

	if (update || gain.value !== element.value) {
		gain.value = element.value
		update = true
	}

	return update
}

function offsetFor(offset: Camera['offset'], element: DefNumber | OneNumber, tag: string) {
	let update = false

	if (tag[0] === 'd') {
		offset.min = (element as DefNumber).min
		offset.max = (element as DefNumber).max
		update = true
	}

	if (update || offset.value !== element.value) {
		offset.value = element.value
		update = true
	}

	return update
}
