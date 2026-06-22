import { type Angle, normalizeAngle, toHour } from './angle'
import { SIDEREAL_DAYSEC, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import type { Point } from './geometry'
import type { CfaPattern } from './image.types'
import type { DefBlobVector, DefLightVector, DefNumber, DefNumberVector, DefSwitchVector, DefTextVector, EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector, PropertyState } from './indi.types'
import type { GeographicCoordinate } from './location'

export type DeviceType = 'camera' | 'mount' | 'wheel' | 'focuser' | 'rotator' | 'gps' | 'dome' | 'guideOutput' | 'flatPanel' | 'cover' | 'power' | 'thermometer' | 'dewHeater'

export type DeviceProperty = (DefTextVector & { type: 'TEXT' }) | (DefNumberVector & { type: 'NUMBER' }) | (DefSwitchVector & { type: 'SWITCH' }) | (DefLightVector & { type: 'LIGHT' }) | (DefBlobVector & { type: 'BLOB' })

export type DevicePropertyType = DeviceProperty['type']

export type DeviceProperties = Record<string, DeviceProperty>

export type FrameType = 'LIGHT' | 'DARK' | 'FLAT' | 'BIAS'

export type CameraTransferFormat = 'FITS' | 'XISF' | 'NATIVE'

export type PierSide = 'EAST' | 'WEST' | 'NEITHER'

export type MountType = 'ALTAZ' | 'EQ_FORK' | 'EQ_GEM'

export type TrackMode = 'SIDEREAL' | 'SOLAR' | 'LUNAR' | 'KING' | 'CUSTOM'

export type MountTargetCoordinateType = 'J2000' | 'JNOW' | 'ALTAZ' | 'ECLIPTIC' | 'GALACTIC'

export type MountTargetCoordinate<T = string> = Partial<Record<MountTargetCoordinateType, Point<T>>> & { type: MountTargetCoordinateType }

export type GuideDirection = 'NORTH' | 'SOUTH' | 'WEST' | 'EAST'

export type MinMaxValueProperty = Pick<DefNumber, 'min' | 'max' | 'value' | 'step'>

export type ClientType = 'INDI' | 'ALPACA' | 'SIMULATOR' | 'FIRMATA'

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
	SENSOR = SPECTROGRAPH | DETECTOR | CORRELATOR,
}

export interface ClientInfo {
	readonly type: ClientType
	readonly id: string
}

export interface Client extends ClientInfo, Disposable {
	readonly description: string
	readonly getProperties: (command?: GetProperties) => void
	readonly enableBlob: (command: EnableBlob) => void
	readonly sendText: (vector: NewTextVector) => void
	readonly sendNumber: (vector: NewNumberVector) => void
	readonly sendSwitch: (vector: NewSwitchVector) => void
}

export interface DriverInfo {
	readonly executable: string
	readonly version: string
}

export const CLIENT = Symbol('CLIENT')

export interface Device {
	id: string // MD5(client ip address + client port + type + name)
	readonly parentId?: string
	type: DeviceType
	name: string
	connected: boolean
	readonly driver: Readonly<DriverInfo>
	readonly client: Readonly<ClientInfo>
	readonly [CLIENT]?: Client
}

export type SubDevice<D extends Device, P extends Device> = D & {
	readonly parent: P
}

export interface UTCTime {
	utc: number // milliseconds since epoch
	offset: number // minutes
}

export interface NameAndLabel {
	name: string
	label: string
}

export interface GuideOutput extends Device {
	readonly type: 'guideOutput' | 'mount' | 'camera'
	canPulseGuide: boolean
	pulsing: boolean
	hasGuideRate: boolean
	canSetGuideRate: boolean
	readonly guideRate: EquatorialCoordinate
}

export interface Thermometer extends Device {
	readonly type: 'thermometer' | 'camera' | 'focuser'
	hasThermometer: boolean
	temperature: number
}

export interface Camera extends GuideOutput, Thermometer {
	readonly type: 'camera'
	hasCoolerControl: boolean
	coolerPower: number
	cooler: boolean
	hasDewHeater: boolean
	dewHeater: boolean
	frameFormats: readonly NameAndLabel[]
	frameFormat: NameAndLabel['name']
	frameType: FrameType
	canAbort: boolean
	readonly cfa: {
		offsetX: number
		offsetY: number
		type?: CfaPattern
	}
	readonly exposure: MinMaxValueProperty & { state: PropertyState }
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
	readonly type: 'gps' | 'mount'
	hasGPS: boolean
	readonly geographicCoordinate: GeographicCoordinate
	readonly time: UTCTime
}

export interface Parkable {
	canPark: boolean
	canSetPark: boolean
	parking: boolean
	parked: boolean
}

export interface Mount extends GuideOutput, GPS, Parkable {
	readonly type: 'mount'
	slewing: boolean
	tracking: boolean
	homing: boolean
	canAbort: boolean
	canSync: boolean
	canGoTo: boolean
	canFlip: boolean
	canHome: boolean
	canFindHome: boolean
	canSetHome: boolean
	canTracking: boolean
	canMove: boolean
	slewRates: readonly NameAndLabel[]
	slewRate?: NameAndLabel['name']
	mountType: MountType
	trackModes: readonly TrackMode[]
	trackMode: TrackMode
	hasPierSide: boolean
	canSetPierSide: boolean
	pierSide: PierSide
	readonly equatorialCoordinate: EquatorialCoordinate
}

export interface Wheel extends Device {
	readonly type: 'wheel'
	count: number
	names: readonly string[]
	canSetNames: boolean
	moving: boolean
	position: number
}

export interface Focuser extends Device, Thermometer {
	readonly type: 'focuser'
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
	readonly type: 'dewHeater' | 'camera' | 'cover'
	hasDewHeater: boolean
	readonly dutyCycle: MinMaxValueProperty
}

export interface Cover extends Device, Parkable, DewHeater {
	readonly type: 'cover'
	canAbort: boolean
}

export interface FlatPanel extends Device {
	readonly type: 'flatPanel'
	enabled: boolean
	readonly intensity: MinMaxValueProperty
}

export interface Rotator extends Device {
	readonly type: 'rotator'
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
	readonly type: 'power'
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

export const DEFAULT_CLIENT_INFO: ClientInfo = {
	type: 'INDI',
	id: '',
}

export const DEFAULT_MIN_MAX_VALUE_PROPERTY: MinMaxValueProperty = {
	value: 0,
	min: 0,
	max: 0,
	step: 0,
}

export const DEFAULT_CAMERA: Camera = {
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
	exposure: {
		...DEFAULT_MIN_MAX_VALUE_PROPERTY,
		state: 'Idle',
	},
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
	hasGuideRate: false,
	canSetGuideRate: false,
	guideRate: {
		rightAscension: 0,
		declination: 0,
	},
	type: 'camera',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
	hasThermometer: false,
	temperature: 0,
}

export const DEFAULT_MOUNT: Mount = {
	slewing: false,
	tracking: false,
	homing: false,
	canAbort: false,
	canSync: false,
	canGoTo: false,
	canFlip: false,
	canHome: false,
	canFindHome: false,
	canSetHome: false,
	canPark: false,
	canSetPark: false,
	canTracking: false,
	canMove: false,
	slewRates: [],
	mountType: 'EQ_GEM',
	trackModes: [],
	trackMode: 'SIDEREAL',
	hasPierSide: false,
	canSetPierSide: false,
	pierSide: 'NEITHER',
	hasGuideRate: false,
	canSetGuideRate: false,
	guideRate: {
		rightAscension: 0,
		declination: 0,
	},
	equatorialCoordinate: {
		rightAscension: 0,
		declination: 0,
	},
	canPulseGuide: false,
	pulsing: false,
	type: 'mount',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
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
	type: 'wheel',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
	count: 0,
	names: [],
	canSetNames: true,
	moving: false,
	position: 0,
}

export const DEFAULT_FOCUSER: Focuser = {
	type: 'focuser',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
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

export const DEFAULT_COVER: Cover = {
	canPark: false,
	canSetPark: false,
	canAbort: false,
	parking: false,
	parked: false,
	hasDewHeater: false,
	dutyCycle: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	type: 'cover',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

export const DEFAULT_FLAT_PANEL: FlatPanel = {
	enabled: false,
	intensity: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	type: 'flatPanel',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

export const DEFAULT_ROTATOR: Rotator = {
	moving: false,
	angle: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	canAbort: false,
	canReverse: false,
	reversed: false,
	canSync: false,
	canHome: false,
	hasBacklashCompensation: false,
	type: 'rotator',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

export const DEFAULT_POWER: Power = {
	voltage: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	current: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	power: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	dc: [],
	dew: [],
	autoDew: [],
	variableVoltage: [],
	usb: [],
	hasPowerCycle: false,
	type: 'power',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

export const DEFAULT_THERMOMETER: Thermometer = {
	hasThermometer: false,
	temperature: 0,
	type: 'thermometer',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

export const DEFAULT_GUIDE_OUTPUT: GuideOutput = {
	canPulseGuide: false,
	pulsing: false,
	type: 'guideOutput',
	id: '',
	name: '',
	connected: false,
	hasGuideRate: false,
	canSetGuideRate: false,
	guideRate: {
		rightAscension: 0,
		declination: 0,
	},
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

export const DEFAULT_DEW_HEATER: DewHeater = {
	hasDewHeater: false,
	dutyCycle: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	type: 'dewHeater',
	id: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

export function isCamera(device: Device): device is Camera {
	return device.type === 'camera'
}

export function isMount(device: Device): device is Mount {
	return device.type === 'mount'
}

export function isFocuser(device: Device): device is Focuser {
	return device.type === 'focuser'
}

export function isWheel(device: Device): device is Wheel {
	return device.type === 'wheel'
}

export function isCover(device: Device): device is Cover {
	return device.type === 'cover'
}

export function isFlatPanel(device: Device): device is FlatPanel {
	return device.type === 'flatPanel'
}

export function isRotator(device: Device): device is Rotator {
	return device.type === 'rotator'
}

export function isPower(device: Device): device is Power {
	return device.type === 'power'
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
	return device.type === 'gps' || ('hasGPS' in device && device.hasGPS !== undefined)
}

export function expectedPierSide(rightAscension: Angle, declination: Angle, lst: Angle): PierSide {
	if (Math.abs(declination) === Math.PI / 2) return 'NEITHER'
	return (toHour(rightAscension - lst) + 24) % 24 < 12 ? 'WEST' : 'EAST'
}

// Remaining clock time, in seconds, until the object next transits the upper meridian.
// The hour angle advances TAU radians per sidereal day (SIDEREAL_DAYSEC seconds), so the
// normalized angle the LST must still advance (RA - LST, wrapped to [0, TAU)) maps to
// seconds by angle / TAU * SIDEREAL_DAYSEC.
export function meridianTimeIn(rightAscension: Angle, lst: Angle) {
	return (normalizeAngle(rightAscension - lst) / TAU) * SIDEREAL_DAYSEC
}
