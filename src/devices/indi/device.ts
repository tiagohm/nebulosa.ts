import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import type { GeographicCoordinate } from '../../astronomy/observer/location'
import { PIOVERTWO, SIDEREAL_DAYSEC, TAU } from '../../core/constants'
import type { CfaPattern } from '../../imaging/model/types'
import type { Point } from '../../math/numerical/geometry'
import { type Angle, normalizeAngle, toHour } from '../../math/units/angle'
import type { DefBlobVector, DefLightVector, DefNumber, DefNumberVector, DefSwitchVector, DefTextVector, EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector, PropertyState } from './types'

// Device model shared across all client backends (INDI, Alpaca, simulator, Firmata): the device-type
// union, per-device-type interfaces (camera, mount, focuser, etc.) describing their capabilities and
// state, default-value templates, and type-guard/geometry helpers. Angles are radians; temperature is
// degrees Celsius.

// Logical device category.
export type DeviceType = 'camera' | 'mount' | 'wheel' | 'focuser' | 'rotator' | 'gps' | 'dome' | 'guideOutput' | 'flatPanel' | 'cover' | 'power' | 'thermometer' | 'dewHeater'

// A defined property vector tagged with its concrete type.
export type DeviceProperty = (DefTextVector & { type: 'TEXT' }) | (DefNumberVector & { type: 'NUMBER' }) | (DefSwitchVector & { type: 'SWITCH' }) | (DefLightVector & { type: 'LIGHT' }) | (DefBlobVector & { type: 'BLOB' })

// Discriminant tag of a DeviceProperty.
export type DevicePropertyType = DeviceProperty['type']

// A device's properties keyed by property name.
export type DeviceProperties = Record<string, DeviceProperty>

// Exposure frame intent.
export type FrameType = 'LIGHT' | 'DARK' | 'FLAT' | 'BIAS'

// Image transfer/storage format requested from a camera.
export type CameraTransferFormat = 'FITS' | 'XISF' | 'NATIVE'

// Side of the pier a German equatorial mount is on (NEITHER = unknown/not applicable).
export type PierSide = 'EAST' | 'WEST' | 'NEITHER'

// Mount mechanical type.
export type MountType = 'ALTAZ' | 'EQ_FORK' | 'EQ_GEM'

// Sidereal/solar/lunar/King/custom tracking rate selector.
export type TrackMode = 'SIDEREAL' | 'SOLAR' | 'LUNAR' | 'KING' | 'CUSTOM'

// Coordinate frame a mount target is expressed in.
export type MountTargetCoordinateType = 'J2000' | 'JNOW' | 'ALTAZ' | 'ECLIPTIC' | 'GALACTIC'

// A mount target point in one or more frames, tagged with the primary frame.
export type MountTargetCoordinate<T = string> = Partial<Record<MountTargetCoordinateType, Point<T>>> & { type: MountTargetCoordinateType }

// Pulse-guide direction.
export type GuideDirection = 'NORTH' | 'SOUTH' | 'WEST' | 'EAST'

// A numeric property reduced to its value and min/max/step range.
export type MinMaxValueProperty = Pick<DefNumber, 'min' | 'max' | 'value' | 'step'>

// Backend that owns a device.
export type ClientType = 'INDI' | 'ALPACA' | 'SIMULATOR' | 'FIRMATA'

// INDI DRIVER_INTERFACE capability bitmask. Values match the INDI library; combine with bitwise OR.
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

// Minimal identity of the owning client.
export interface ClientInfo {
	readonly type: ClientType
	readonly id: string
}

// Backend-agnostic client contract used to drive devices: query properties and send new target values.
export interface Client extends ClientInfo, Disposable {
	readonly description: string
	readonly getProperties: (command?: GetProperties) => void
	readonly enableBlob: (command: EnableBlob) => void
	readonly sendText: (vector: NewTextVector) => void
	readonly sendNumber: (vector: NewNumberVector) => void
	readonly sendSwitch: (vector: NewSwitchVector) => void
}

// Driver identification reported by a device.
export interface DriverInfo {
	readonly executable: string
	readonly version: string
}

// Hidden property key carrying the owning Client instance on a device object.
export const CLIENT = Symbol('CLIENT')

// Common base shared by every device: identity, type, connection state, and driver/client metadata.
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

// A device that is a sub-interface of a parent device (e.g. a guide output on a camera).
export type SubDevice<D extends Device, P extends Device> = D & {
	readonly parent: P
}

// Wall-clock time as epoch milliseconds plus a UTC offset in minutes.
export interface UTCTime {
	utc: number // milliseconds since epoch
	offset: number // minutes
}

// A switch/option identified by machine name and human label.
export interface NameAndLabel {
	name: string
	label: string
}

// Pulse-guiding capability, optionally with a settable guide rate (radians/second).
export interface GuideOutput extends Device {
	readonly type: 'guideOutput' | 'mount' | 'camera'
	canPulseGuide: boolean
	pulsing: boolean
	hasGuideRate: boolean
	canSetGuideRate: boolean
	readonly guideRate: EquatorialCoordinate
}

// Temperature-sensing capability; temperature in degrees Celsius.
export interface Thermometer extends Device {
	readonly type: 'thermometer' | 'camera' | 'focuser'
	hasThermometer: boolean
	temperature: number
}

// Camera device: cooling, frame format/type, subframe, binning, gain/offset, exposure, plus the guide
// and thermometer capabilities. Pixel sizes are micrometres; temperatures are degrees Celsius.
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

// GPS/site capability: geographic location (radians/metres) and device clock.
export interface GPS extends Device {
	readonly type: 'gps' | 'mount'
	hasGPS: boolean
	readonly geographicCoordinate: GeographicCoordinate
	readonly time: UTCTime
}

// Parking capability shared by mounts, covers, and similar mechanisms.
export interface Parkable {
	canPark: boolean
	canSetPark: boolean
	parking: boolean
	parked: boolean
}

// Mount/telescope device: slew/sync/goto/track/park/home capabilities, slew rates, track modes, pier
// side, and the current equatorial coordinate (radians). Also a guide output and GPS/site source.
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

// Filter-wheel device: slot count, filter names, and current 0-based slot position.
export interface Wheel extends Device {
	readonly type: 'wheel'
	count: number
	names: readonly string[]
	canSetNames: boolean
	moving: boolean
	position: number
}

// Focuser device: absolute/relative move, reverse, sync, backlash, and position (steps); also a
// thermometer.
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

// Dew-heater capability with a duty-cycle property (percent).
export interface DewHeater extends Device {
	readonly type: 'dewHeater' | 'camera' | 'cover'
	hasDewHeater: boolean
	readonly dutyCycle: MinMaxValueProperty
}

// Telescope cover/dust cap: parkable (open/close) with an optional dew heater.
export interface Cover extends Device, Parkable, DewHeater {
	readonly type: 'cover'
	canAbort: boolean
}

// Flat-field light panel with an intensity property.
export interface FlatPanel extends Device {
	readonly type: 'flatPanel'
	enabled: boolean
	readonly intensity: MinMaxValueProperty
}

// Field rotator: angle (degrees), reverse, sync, home, and backlash compensation.
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

// Category of a power-distribution channel.
export type PowerChannelType = 'dc' | 'dew' | 'variableVoltage' | 'autoDew' | 'usb'

// One power-distribution output channel with its value/range and enabled state.
export interface PowerChannel extends MinMaxValueProperty {
	readonly type: PowerChannelType
	name: string
	label: string
	enabled: boolean
}

// Power-distribution device: aggregate voltage/current/power plus the per-type channel lists.
export interface Power extends Device, Record<PowerChannelType, PowerChannel[]> {
	readonly type: 'power'
	readonly voltage: MinMaxValueProperty
	readonly current: MinMaxValueProperty
	readonly power: MinMaxValueProperty
	hasPowerCycle: boolean
}

// Tests whether an interface bitmask includes a given DeviceInterfaceType bit.
export function isInterfaceType(value: number, type: DeviceInterfaceType): value is DeviceInterfaceType {
	return (value & type) !== 0
}

// Empty driver-info template.
export const DEFAULT_DRIVER_INFO: DriverInfo = {
	executable: '',
	version: '',
}

// Default client-info template (INDI, empty id).
export const DEFAULT_CLIENT_INFO: ClientInfo = {
	type: 'INDI',
	id: '',
}

// Zeroed numeric value/range template.
export const DEFAULT_MIN_MAX_VALUE_PROPERTY: MinMaxValueProperty = {
	value: 0,
	min: 0,
	max: 0,
	step: 0,
}

// Default, fully-disconnected templates for each device type, used to seed device state before the
// driver reports its real capabilities.
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

// Type guards narrowing a Device by its discrete `type`.
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

// Capability guards narrowing by the presence of a sub-interface marker rather than the device type, so
// composite devices (e.g. a camera that is also a thermometer/guide output) are recognized.
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

// Predicts the pier side a German equatorial mount would use for the given coordinates and local
// sidereal time. RA, Dec, and LST are radians. Returns NEITHER at the celestial poles where it is
// undefined; otherwise WEST when the target is east of the meridian (hour angle in [0,12)h), else EAST.
export function expectedPierSide(rightAscension: Angle, declination: Angle, lst: Angle): PierSide {
	if (Math.abs(declination) === PIOVERTWO) return 'NEITHER'
	return toHour(normalizeAngle(rightAscension - lst)) < 12 ? 'WEST' : 'EAST'
}

// Remaining clock time, in seconds, until the object next transits the upper meridian.
// The hour angle advances TAU radians per sidereal day (SIDEREAL_DAYSEC seconds), so the
// normalized angle the LST must still advance (RA - LST, wrapped to [0, TAU)) maps to
// seconds by angle / TAU * SIDEREAL_DAYSEC.
export function meridianTimeIn(rightAscension: Angle, lst: Angle) {
	return (normalizeAngle(rightAscension - lst) / TAU) * SIDEREAL_DAYSEC
}
