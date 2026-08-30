import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import type { GeographicCoordinate } from '../../astronomy/observer/location'
import { PIOVERTWO, SIDEREAL_DAYSEC, TAU } from '../../core/constants'
import type { CfaPattern } from '../../imaging/model/types'
import type { Point } from '../../math/numerical/geometry'
import { type Angle, normalizeAngle, toHour } from '../../math/units/angle'
import type { DefBlobVector, DefLightVector, DefNumber, DefNumberVector, DefSwitchVector, DefTextVector, EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector, PropertyState } from './types'

// Device model shared across all client backends (INDI, Alpaca, simulator, Firmata): the device-type
// union, per-device-type interfaces (camera, mount, focuser, etc.) describing their capabilities and
// state, default-value templates, and type-guard/geometry helpers. Angles are radians; dome speed is
// RPM; dome measurements are metres; dome backlash is controller steps; temperature is degrees Celsius.

// Logical device category.
export type DeviceType = 'camera' | 'mount' | 'wheel' | 'focuser' | 'rotator' | 'gps' | 'dome' | 'guideOutput' | 'flatPanel' | 'cover' | 'power' | 'thermometer' | 'dewHeater' | 'safetyMonitor' | 'weather'

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

// Direction used by a dome's continuous rotation control.
export type DomeDirection = 'CLOCKWISE' | 'COUNTER_CLOCKWISE'

// Shutter state shared by INDI and Alpaca dome adapters.
export type DomeShutterState = 'UNKNOWN' | 'OPEN' | 'CLOSED' | 'OPENING' | 'CLOSING' | 'ERROR'

// OTA side used by optional dome geometry measurements.
export type DomeOTASide = 'EAST' | 'WEST' | 'UNKNOWN'

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
	id: string // MD5(client id + type + name): unique per interface view
	hardwareId: string // MD5(client id + name): the physical device behind every view
	readonly parentId?: string
	readonly type: DeviceType // Main device type
	interfaces: readonly DeviceType[] //  Combination of device types the driver advertises in the interface bitmask
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
	// Whether either timed-guide axis currently reports Busy.
	pulsing: boolean
	// Whether the north/south timed-guide vector currently reports Busy.
	pulsingNS: boolean
	// Whether the west/east timed-guide vector currently reports Busy.
	pulsingWE: boolean
	hasGuideRate: boolean
	canSetGuideRate: boolean
	readonly guideRate: EquatorialCoordinate
}

// Temperature-sensing capability; temperature in degrees Celsius.
export interface Thermometer extends Device {
	readonly type: 'thermometer' | 'camera' | 'focuser' | 'weather'
	hasThermometer: boolean
	temperature: number
}

// Safety-monitoring capability. Unknown, disconnected, warning and alert states are represented as
// false; only an explicit safe status is true.
export interface SafetyMonitor extends Device {
	readonly type: DeviceType
	safe: boolean
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

// Optional geometric measurements reported by an INDI dome. Distances are metres and OTA offset is an
// unsigned distance along the dome convention used by the driver.
export interface DomeMeasurements {
	radius: number
	shutterWidth: number
	northDisplacement: number
	eastDisplacement: number
	upDisplacement: number
	otaOffset: number
	otaSide: DomeOTASide
}

// Dome device: rotational and optional altitude motion, shutter control, parking, slaving, and geometry.
// Angles are radians, speed is RPM, measurements are metres, and backlash is controller steps.
export interface Dome extends Device, Parkable {
	readonly type: 'dome'
	slewing: boolean
	moving: boolean
	homing: boolean
	atHome: boolean
	direction?: DomeDirection
	canAbort: boolean
	canMove: boolean
	canRelativeMove: boolean
	canSetAzimuth: boolean
	canSetAltitude: boolean
	canFindHome: boolean
	canSetSpeed: boolean
	canSync: boolean
	canUnpark: boolean
	hasBacklash: boolean
	hasShutter: boolean
	canSetShutter: boolean
	shutterState: DomeShutterState
	canSlave: boolean
	slaved: boolean
	readonly azimuth: MinMaxValueProperty
	readonly altitude: MinMaxValueProperty
	readonly speed: MinMaxValueProperty
	readonly homePosition: MinMaxValueProperty
	readonly parkPosition: MinMaxValueProperty
	readonly autoSyncThreshold: MinMaxValueProperty
	backlashEnabled: boolean
	readonly backlash: MinMaxValueProperty
	hasMeasurements: boolean
	readonly measurements: DomeMeasurements
}

// Observable state of a mount's INDI Alignment Subsystem. Mirrors only what the driver advertises
// through the ALIGNMENT_* properties; it carries neither the alignment points nor the math model.
export interface MountAlignmentState {
	available: boolean // Driver defined ALIGNMENT_SUBSYSTEM_ACTIVE, i.e. it exposes the subsystem
	active: boolean // Logical state of the ALIGNMENT SUBSYSTEM ACTIVE switch, never the vector state
	plugins: readonly NameAndLabel[] // Math plugins advertised by ALIGNMENT_SUBSYSTEM_MATH_PLUGINS, in driver order
	plugin?: NameAndLabel['name'] // Name of the currently selected math plugin, or undefined when none is on
	pointCount: number // ALIGNMENT_POINTSET_SIZE, normalized to a non-negative integer
}

// Mount/telescope device: slew/sync/goto/track/park/home capabilities, slew rates, track modes, pier
// side, and the current equatorial coordinate (radians). Also a guide output and GPS/site source.
export interface Mount extends GuideOutput, GPS, Parkable {
	readonly type: 'mount'
	slewing: boolean
	moving: boolean
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
	readonly alignment: MountAlignmentState
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

// One of the thirteen ASCOM ObservingConditions sensors, named by its field in Weather. Used as the key
// for per-sensor capability, freshness and name mapping across the INDI and Alpaca backends.
export type WeatherSensor = 'cloudCover' | 'dewPoint' | 'humidity' | 'pressure' | 'rainRate' | 'skyBrightness' | 'skyQuality' | 'skyTemperature' | 'starFWHM' | 'temperature' | 'windDirection' | 'windGust' | 'windSpeed'

// Weather station / ASCOM ObservingConditions device. Every sensor is optional: an absent field means
// the backend does not provide that sensor, never that its value is zero or NaN. Ambient temperature is
// carried by the Thermometer capability instead, gated by `hasThermometer`. Each field documents its own
// unit; readings are whatever the station measured, never clamped to the driver's alarm thresholds.
export interface Weather extends Device, Thermometer {
	readonly type: 'weather'

	// Backend averaging window in hours; 0 means an instantaneous reading. Absent when the backend has
	// no such concept (plain INDI).
	averagePeriod?: number

	// INDI driver re-read period (WEATHER_UPDATE/PERIOD) in seconds. Absent on Alpaca.
	readonly updatePeriod?: MinMaxValueProperty

	// Fraction of the sky covered by cloud, percent in [0, 100].
	cloudCover?: number
	// Temperature at which the ambient air would saturate, degrees Celsius. Never above `temperature`,
	// except by rounding on saturated air. Forms a pair with `humidity`: a backend providing only one of
	// the two lets the other be derived from it and the ambient temperature.
	dewPoint?: number
	// Relative humidity of the ambient air, percent in [0, 100]. Paired with `dewPoint`.
	humidity?: number
	// Atmospheric pressure at the observatory altitude, hPa. Never reduced to sea level.
	pressure?: number
	// Rain falling at the site, mm/h. INDI drivers usually report accumulation over the last hour, which
	// is numerically the same quantity.
	rainRate?: number
	// Sky brightness measured by a photometer, lux.
	skyBrightness?: number
	// Sky darkness measured by a sky-quality meter, magnitudes per square arcsecond. Larger is darker,
	// with a pristine site around 22.
	skyQuality?: number
	// Sky temperature from an infrared sensor, degrees Celsius. Far below ambient under a clear sky and
	// close to ambient under cloud, which is what makes it a cloud indicator.
	skyTemperature?: number
	// Seeing, as the full width at half maximum of a star image, arcsec.
	starFWHM?: number
	// Direction the wind blows *from*, radians normalized to [0, TAU), clockwise from north. The ASCOM
	// boundary convention (north reported as 360°, 0° reserved for calm) is applied only by the Alpaca
	// client and server; it never leaks into this field.
	windDirection?: Angle
	// Peak wind speed over the backend's sampling window, m/s. At least `windSpeed`.
	windGust?: number
	// Mean wind speed, m/s. Zero means calm, in which case `windDirection` carries no information.
	windSpeed?: number
}

// Tests whether an interface bitmask includes a given DeviceInterfaceType bit.
export function isInterfaceType(value: number, type: DeviceInterfaceType): value is DeviceInterfaceType {
	return (value & type) !== 0
}

// Returns all device types from an interface bitmask.
export function findDeviceTypes(value: number) {
	const types: DeviceType[] = []
	if (isInterfaceType(value, DeviceInterfaceType.CCD)) types.push('camera')
	if (isInterfaceType(value, DeviceInterfaceType.TELESCOPE)) types.push('mount')
	if (isInterfaceType(value, DeviceInterfaceType.FILTER)) types.push('wheel')
	if (isInterfaceType(value, DeviceInterfaceType.FOCUSER)) types.push('focuser')
	if (isInterfaceType(value, DeviceInterfaceType.ROTATOR)) types.push('rotator')
	if (isInterfaceType(value, DeviceInterfaceType.LIGHTBOX)) types.push('flatPanel')
	if (isInterfaceType(value, DeviceInterfaceType.DUSTCAP)) types.push('cover')
	if (isInterfaceType(value, DeviceInterfaceType.DOME)) types.push('dome')
	if (isInterfaceType(value, DeviceInterfaceType.POWER)) types.push('power')
	if (isInterfaceType(value, DeviceInterfaceType.WEATHER)) types.push('weather')
	return types
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
	pulsingNS: false,
	pulsingWE: false,
	hasGuideRate: false,
	canSetGuideRate: false,
	guideRate: {
		rightAscension: 0,
		declination: 0,
	},
	type: 'camera',
	interfaces: ['camera'],
	id: '',
	hardwareId: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
	hasThermometer: false,
	temperature: 0,
}

export const DEFAULT_MOUNT: Mount = {
	slewing: false,
	moving: false,
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
	alignment: {
		available: false,
		active: false,
		plugins: [],
		plugin: undefined,
		pointCount: 0,
	},
	canPulseGuide: false,
	pulsing: false,
	pulsingNS: false,
	pulsingWE: false,
	type: 'mount',
	interfaces: ['mount'],
	id: '',
	hardwareId: '',
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

// Default, fully-disconnected dome template with zeroed numeric properties and no advertised capability.
export const DEFAULT_DOME: Dome = {
	type: 'dome',
	interfaces: ['dome'],
	id: '',
	hardwareId: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
	slewing: false,
	moving: false,
	homing: false,
	atHome: false,
	canAbort: false,
	canMove: false,
	canRelativeMove: false,
	canSetAzimuth: false,
	canSetAltitude: false,
	canFindHome: false,
	canSetSpeed: false,
	canSync: false,
	canUnpark: false,
	canPark: false,
	canSetPark: false,
	parking: false,
	parked: false,
	hasBacklash: false,
	hasShutter: false,
	canSetShutter: false,
	shutterState: 'UNKNOWN',
	canSlave: false,
	slaved: false,
	azimuth: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	altitude: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	speed: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	homePosition: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	parkPosition: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	autoSyncThreshold: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	backlashEnabled: false,
	backlash: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	hasMeasurements: false,
	measurements: {
		radius: 0,
		shutterWidth: 0,
		northDisplacement: 0,
		eastDisplacement: 0,
		upDisplacement: 0,
		otaOffset: 0,
		otaSide: 'UNKNOWN',
	},
}

export const DEFAULT_WHEEL: Wheel = {
	type: 'wheel',
	interfaces: ['wheel'],
	id: '',
	hardwareId: '',
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
	interfaces: ['focuser'],
	id: '',
	hardwareId: '',
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
	interfaces: ['cover'],
	id: '',
	hardwareId: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

export const DEFAULT_FLAT_PANEL: FlatPanel = {
	enabled: false,
	intensity: structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY),
	type: 'flatPanel',
	interfaces: ['flatPanel'],
	id: '',
	hardwareId: '',
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
	interfaces: ['rotator'],
	id: '',
	hardwareId: '',
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
	interfaces: ['power'],
	id: '',
	hardwareId: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

// Default weather station template. Only the mandatory Device and Thermometer fields are seeded: the
// optional sensors stay absent so that "not reported yet" is never confused with a real zero reading.
export const DEFAULT_WEATHER: Weather = {
	type: 'weather',
	interfaces: ['weather'],
	id: '',
	hardwareId: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
	hasThermometer: false,
	temperature: 0,
}

export const DEFAULT_THERMOMETER: Thermometer = {
	hasThermometer: false,
	temperature: 0,
	type: 'thermometer',
	interfaces: ['thermometer'],
	id: '',
	hardwareId: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
}

// Default fail-closed safety monitor.
export const DEFAULT_SAFETY_MONITOR: SafetyMonitor = {
	type: 'safetyMonitor',
	interfaces: ['safetyMonitor'],
	id: '',
	hardwareId: '',
	name: '',
	connected: false,
	driver: structuredClone(DEFAULT_DRIVER_INFO),
	client: structuredClone(DEFAULT_CLIENT_INFO),
	safe: false,
}

export const DEFAULT_GUIDE_OUTPUT: GuideOutput = {
	canPulseGuide: false,
	pulsing: false,
	pulsingNS: false,
	pulsingWE: false,
	type: 'guideOutput',
	interfaces: ['guideOutput'],
	id: '',
	hardwareId: '',
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
	interfaces: ['dewHeater'],
	id: '',
	hardwareId: '',
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

export function isDome(device: Device): device is Dome {
	return device.type === 'dome'
}

export function isPower(device: Device): device is Power {
	return device.type === 'power'
}

export function isWeather(device: Device): device is Weather {
	return device.type === 'weather'
}

export function isThermometer(device: Device): device is Thermometer {
	return 'hasThermometer' in device && device.hasThermometer !== undefined
}

// Whether a device exposes the safety-monitoring capability.
export function isSafetyMonitor(device: Device): device is SafetyMonitor {
	return device.type === 'safetyMonitor' || ('safe' in device && device.safe !== undefined)
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

export function isSubDevice<D extends Device>(device: Device): device is SubDevice<D, Device> {
	return 'parent' in device && device.parent !== undefined
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
