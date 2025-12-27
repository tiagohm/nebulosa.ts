import type { EquatorialCoordinate, HorizontalCoordinate } from './coordinate'
import type { CfaPattern } from './image.types'
import type { DefBlobVector, DefLightVector, DefNumber, DefNumberVector, DefSwitchVector, DefTextVector } from './indi'
import type { GeographicCoordinate } from './location'

export type DeviceType = 'CAMERA' | 'MOUNT' | 'WHEEL' | 'FOCUSER' | 'ROTATOR' | 'GPS' | 'DOME' | 'GUIDE_OUTPUT' | 'FLAT_PANEL' | 'COVER' | 'POWER' | 'THERMOMETER' | 'DEW_HEATER'

export type DeviceProperty = (DefTextVector & { type: 'TEXT' }) | (DefNumberVector & { type: 'NUMBER' }) | (DefSwitchVector & { type: 'SWITCH' }) | (DefLightVector & { type: 'LIGHT' }) | (DefBlobVector & { type: 'BLOB' })

export type DevicePropertyType = DeviceProperty['type']

export type DeviceProperties = Record<string, DeviceProperty>

export type FrameType = 'LIGHT' | 'DARK' | 'FLAT' | 'BIAS'

export type PierSide = 'EAST' | 'WEST' | 'NEITHER'

export type MountType = 'ALTAZ' | 'EQ_FORK' | 'EQ_GEM'

export type TrackMode = 'SIDEREAL' | 'SOLAR' | 'LUNAR' | 'KING' | 'CUSTOM'

export type MountTargetCoordinateType = 'J2000' | 'JNOW' | 'ALTAZ'

export type MountTargetCoordinate<T = string> = (EquatorialCoordinate<T> & { type: 'J2000' | 'JNOW' }) | (HorizontalCoordinate<T> & { type: 'ALTAZ' })

export type GuideDirection = 'NORTH' | 'SOUTH' | 'WEST' | 'EAST'

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

export interface UTCTime {
	utc: number // milliseconds since epoch
	offset: number // minutes
}

export interface GuideOutput extends Device {
	readonly type: 'GUIDE_OUTPUT' | 'MOUNT' | 'CAMERA'
	canPulseGuide: boolean
	pulsing: boolean
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
	readonly exposure: MinMaxValueProperty
	exposuring: boolean
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

export interface Wheel extends Device {
	readonly type: 'WHEEL'
	moving: boolean
	slots: string[]
	position: number
}

export interface Focuser extends Device, Thermometer {
	readonly type: 'FOCUSER'
	moving: boolean
	readonly position: MinMaxValueProperty
	canAbsoluteMove: boolean
	canRelativeMove: boolean
	canAbort: boolean
	canReverse: boolean
	reversed: boolean
	canSync: boolean
	hasBacklash: boolean
}

export interface DewHeater extends Device {
	readonly type: 'DEW_HEATER' | 'CAMERA' | 'COVER'
	hasDewHeater: boolean
	readonly pwm: MinMaxValueProperty
}

export interface Cover extends Device, Parkable, DewHeater {
	readonly type: 'COVER'
}

export interface FlatPanel extends Device {
	readonly type: 'FLAT_PANEL'
	enabled: boolean
	readonly intensity: MinMaxValueProperty
}

export type PowerChannelType = 'dc' | 'dew' | 'variableVoltage' | 'autoDew' | 'usb'

export interface PowerChannel extends MinMaxValueProperty {
	readonly type: PowerChannelType
	name: string
	label: string
	enabled: boolean
}

export interface Power extends Device, Record<PowerChannelType, PowerChannel[]> {
	readonly type: 'POWER'
	voltage: number
	current: number
	power: number
	hasPowerCycle: boolean
}

export function isInterfaceType(value: number, type: DeviceInterfaceType): value is DeviceInterfaceType {
	return (value & type) !== 0
}

export const DEFAULT_DRIVER_INFO: DriverInfo = {
	executable: '',
	version: '',
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
		value: 0,
		min: 0,
		max: 0,
	},
	exposuring: false,
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
	pulsing: false,
	type: 'CAMERA',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
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
	pulsing: false,
	type: 'MOUNT',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
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

export const DEFAULT_WHEEL: Wheel = {
	type: 'WHEEL',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
	moving: false,
	slots: [],
	position: 0,
}

export const DEFAULT_FOCUSER: Focuser = {
	type: 'FOCUSER',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
	moving: false,
	position: {
		value: 0,
		min: 0,
		max: 100,
	},
	canAbsoluteMove: false,
	canRelativeMove: false,
	canAbort: false,
	canReverse: false,
	reversed: false,
	canSync: false,
	hasBacklash: false,
	hasThermometer: false,
	temperature: 0,
}

export const DEFAULT_COVER: Cover = {
	canPark: false,
	parking: false,
	parked: false,
	hasDewHeater: false,
	pwm: {
		value: 0,
		min: 0,
		max: 100,
	},
	type: 'COVER',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
}

export const DEFAULT_FLAT_PANEL: FlatPanel = {
	enabled: false,
	intensity: {
		value: 0,
		min: 0,
		max: 100,
	},
	type: 'FLAT_PANEL',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
}

export const DEFAULT_POWER: Power = {
	voltage: 0,
	current: 0,
	power: 0,
	dc: [],
	dew: [],
	autoDew: [],
	variableVoltage: [],
	usb: [],
	hasPowerCycle: false,
	type: 'POWER',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
}

export const DEFAULT_THERMOMETER: Thermometer = {
	hasThermometer: true,
	temperature: 0,
	type: 'THERMOMETER',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
}

export const DEFAULT_GUIDE_OUTPUT: GuideOutput = {
	canPulseGuide: false,
	pulsing: false,
	type: 'GUIDE_OUTPUT',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
}

export const DEFAULT_DEW_HEATER: DewHeater = {
	hasDewHeater: false,
	pwm: {
		value: 0,
		min: 0,
		max: 100,
	},
	type: 'DEW_HEATER',
	name: '',
	connected: false,
	driver: DEFAULT_DRIVER_INFO,
}

export function isCamera(device: Device): device is Camera {
	return device.type === 'CAMERA'
}

export function isMount(device: Device): device is Mount {
	return device.type === 'MOUNT'
}

export function isFocuser(device: Device): device is Focuser {
	return device.type === 'FOCUSER'
}

export function isWheel(device: Device): device is Wheel {
	return device.type === 'WHEEL'
}

export function isCover(device: Device): device is Cover {
	return device.type === 'COVER'
}

export function isFlatPanel(device: Device): device is FlatPanel {
	return device.type === 'FLAT_PANEL'
}

export function isPower(device: Device): device is Power {
	return device.type === 'POWER'
}

export function isThermometer(device: Device): device is Thermometer {
	return 'hasThermometer' in device && device.hasThermometer !== undefined
}

export function isGuideOutput(device: Device): device is GuideOutput {
	return 'canPulseGuide' in device && device.canPulseGuide !== undefined
}

export function isDewHeater(device: Device): device is DewHeater {
	return 'hasDewHeater' in device && device.hasDewHeater !== undefined
}

export function isGPS(device: Device): device is GPS {
	return device.type === 'GPS' || ('hasGPS' in device && device.hasGPS !== undefined)
}
