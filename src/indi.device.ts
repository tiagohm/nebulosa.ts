import type { DeepReadonly } from 'utility-types'
import type { EquatorialCoordinate, HorizontalCoordinate } from './coordinate'
import type { CfaPattern } from './image.types'
import type { IndiClient } from './indi'
import type { DefBlobVector, DefLightVector, DefNumber, DefNumberVector, DefSwitchVector, DefTextVector } from './indi.types'
import type { GeographicCoordinate } from './location'

export type DeviceType = 'CAMERA' | 'MOUNT' | 'WHEEL' | 'FOCUSER' | 'ROTATOR' | 'GPS' | 'DOME' | 'GUIDE_OUTPUT' | 'FLAT_PANEL' | 'COVER' | 'POWER' | 'THERMOMETER' | 'DEW_HEATER'

export type DeviceProperty = (DefTextVector & { type: 'TEXT' }) | (DefNumberVector & { type: 'NUMBER' }) | (DefSwitchVector & { type: 'SWITCH' }) | (DefLightVector & { type: 'LIGHT' }) | (DefBlobVector & { type: 'BLOB' })

export type DevicePropertyType = DeviceProperty['type']

export type DeviceProperties = Record<string, DeviceProperty>

export type FrameType = 'LIGHT' | 'DARK' | 'FLAT' | 'BIAS'

export type CameraTransferFormat = 'FITS' | 'XISF' | 'NATIVE'

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

export const CLIENT = Symbol('INDI_CLIENT')

export interface Device {
	type: DeviceType
	name: string
	connected: boolean
	readonly driver: Readonly<DriverInfo>
	readonly [CLIENT]?: IndiClient
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
	frameFormat: string
	frameType: FrameType
	canAbort: boolean
	readonly cfa: {
		offsetX: number
		offsetY: number
		type?: CfaPattern
	}
	readonly exposure: MinMaxValueProperty
	exposuring: boolean
	hasCooler: boolean
	canSetTemperature: boolean
	canSubFrame: boolean
	readonly frame: {
		readonly x: MinMaxValueProperty
		readonly y: MinMaxValueProperty
		readonly width: MinMaxValueProperty
		readonly height: MinMaxValueProperty
	}
	canBin: boolean
	readonly bin: {
		readonly x: MinMaxValueProperty
		readonly y: MinMaxValueProperty
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
	readonly dutyCycle: MinMaxValueProperty
}

export interface Cover extends Device, Parkable, DewHeater {
	readonly type: 'COVER'
}

export interface FlatPanel extends Device {
	readonly type: 'FLAT_PANEL'
	enabled: boolean
	readonly intensity: MinMaxValueProperty
}

export interface Rotator extends Device {
	moving: boolean
	angle: MinMaxValueProperty
	canAbort: boolean
	canReverse: boolean
	reversed: boolean
	canSync: boolean
	canHome: boolean
	hasBacklashCompensation: boolean
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
	readonly voltage: MinMaxValueProperty
	readonly current: MinMaxValueProperty
	readonly power: MinMaxValueProperty
	hasPowerCycle: boolean
}

export function isInterfaceType(value: number, type: DeviceInterfaceType): value is DeviceInterfaceType {
	return (value & type) !== 0
}

export const DEFAULT_DRIVER_INFO: DriverInfo = {
	executable: '',
	version: '',
}

export const DEFAULT_MIN_MAX_VALUE_PROPERTY: MinMaxValueProperty = {
	value: 0,
	min: 0,
	max: 0,
}

export const DEFAULT_CAMERA: DeepReadonly<Camera> = {
	hasCoolerControl: false,
	coolerPower: 0,
	cooler: false,
	hasDewHeater: false,
	dewHeater: false,
	frameFormats: [],
	frameFormat: '',
	frameType: 'LIGHT',
	canAbort: false,
	cfa: {
		offsetX: 0,
		offsetY: 0,
	},
	exposure: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	exposuring: false,
	hasCooler: false,
	canSetTemperature: false,
	canSubFrame: false,
	frame: {
		x: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
		y: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
		width: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
		height: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	},
	canBin: false,
	bin: {
		x: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
		y: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	},
	gain: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	offset: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	pixelSize: {
		x: 0,
		y: 0,
	},
	canPulseGuide: false,
	pulsing: false,
	type: 'CAMERA',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	hasThermometer: false,
	temperature: 0,
}

export const DEFAULT_MOUNT: DeepReadonly<Mount> = {
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
	driver: structuredClone(DEFAULT_DRIVER_INFO),
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

export const DEFAULT_WHEEL: DeepReadonly<Wheel> = {
	type: 'WHEEL',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	moving: false,
	slots: [],
	position: 0,
}

export const DEFAULT_FOCUSER: DeepReadonly<Focuser> = {
	type: 'FOCUSER',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	moving: false,
	position: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
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

export const DEFAULT_COVER: DeepReadonly<Cover> = {
	canPark: false,
	parking: false,
	parked: false,
	hasDewHeater: false,
	dutyCycle: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	type: 'COVER',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
}

export const DEFAULT_FLAT_PANEL: DeepReadonly<FlatPanel> = {
	enabled: false,
	intensity: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	type: 'FLAT_PANEL',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
}

export const DEFAULT_ROTATOR: DeepReadonly<Rotator> = {
	moving: false,
	angle: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	canAbort: false,
	canReverse: false,
	reversed: false,
	canSync: false,
	canHome: false,
	hasBacklashCompensation: false,
	type: 'ROTATOR',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
}

export const DEFAULT_POWER: DeepReadonly<Power> = {
	voltage: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	current: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	power: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	dc: [],
	dew: [],
	autoDew: [],
	variableVoltage: [],
	usb: [],
	hasPowerCycle: false,
	type: 'POWER',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
}

export const DEFAULT_THERMOMETER: DeepReadonly<Thermometer> = {
	hasThermometer: true,
	temperature: 0,
	type: 'THERMOMETER',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
}

export const DEFAULT_GUIDE_OUTPUT: DeepReadonly<GuideOutput> = {
	canPulseGuide: false,
	pulsing: false,
	type: 'GUIDE_OUTPUT',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
}

export const DEFAULT_DEW_HEATER: DeepReadonly<DewHeater> = {
	hasDewHeater: false,
	dutyCycle: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	type: 'DEW_HEATER',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
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

export function isRotator(device: Device): device is Rotator {
	return device.type === 'ROTATOR'
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
