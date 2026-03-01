import type { BitpixOrZero } from './fits'
import type { Cover, Device, FlatPanel } from './indi.device'
import type { CameraManager, CoverManager, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, RotatorManager, WheelManager } from './indi.manager'

export type AlpacaDeviceType = 'camera' | 'telescope' | 'focuser' | 'filterwheel' | 'rotator' | 'dome' | 'switch' | 'covercalibrator' | 'observingconditions' | 'safetymonitor' | 'video'

export type AlpacaDeviceNumberProvider = (device: Device, type: AlpacaDeviceType) => number

export type AlpacaServerStartOptions = Omit<Bun.Serve.HostnamePortServeOptions<undefined>, 'hostname' | 'port' | 'routes' | 'error' | 'fetch' | 'development'>

export type AlpacaFocuserAction = (typeof SUPPORTED_FOCUSER_ACTIONS)[number]

export type AlpacaWheelAction = (typeof SUPPORTED_WHEEL_ACTIONS)[number]

export type CoverCalibrator = Cover & FlatPanel

// https://ascom-standards.org/newdocs/exceptions.html
export enum AlpacaException {
	MethodNotImplemented = 1024,
	PropertyNotImplemented = 1024,
	InvalidValue = 1025,
	ValueNotSet = 1026,
	NotConnected = 1031,
	Parked = 1032,
	Slaved = 1033,
	InvalidOperation = 1035,
	ActionNotImplemented = 1036,
	OperationCancelled = 1038,
	Driver = 1280,
}

export enum AlpacaImageElementType {
	Unknown = 0, // 0 to 3 are values already used in the Alpaca standard
	Int16 = 1,
	Int32 = 2,
	Double = 3,
	Single = 4, // 4 to 9 are an extension to include other numeric types
	UInt64 = 5,
	Byte = 6,
	Int64 = 7,
	UInt16 = 8,
	UInt32 = 9,
}

// https://ascom-standards.org/newdocs/camera.html#enumerated-constants

export enum AlpacaCameraState {
	IDLE,
	WAITING,
	EXPOSING,
	READING,
	DOWNLOAD,
	ERROR,
}

export enum AlpacaCameraSensorType {
	MONOCHROME,
	COLOR,
	RGGB,
	CMYG,
	CMYG2,
	LRGB,
}

// https://ascom-standards.org/newdocs/telescope.html#enumerated-constants

export enum AlpacaTelescopeAlignmentMode {
	ALTAZ,
	POLAR,
	GERMAN_POLAR,
}

export enum AlpacaTelescopeTrackingRate {
	SIDEREAL,
	LUNAR,
	SOLAR,
	KING,
}

export enum AlpacaTelescopeEquatorialCoordinateType {
	OTHER,
	TOPOCENTRIC,
	J2000,
	J2050,
	B1950,
}

export enum AlpacaGuideDirection {
	NORTH,
	SOUTH,
	EAST,
	WEST,
}

export enum AlpacaTelescopePierSide {
	UNKNOWN = -1,
	EAST,
	WEST,
}

export enum AlpacaTelescopeAxis {
	PRIMARY,
	SECONDARY,
	TERTIARY,
}

export interface ImageBytesMetadata {
	readonly MetadataVersion: number // Bytes 0..3 - Metadata version = 1
	readonly ErrorNumber: number // Bytes 4..7 - Alpaca error number or zero for success
	readonly ClientTransactionID: number // Bytes 8..11 - Client's transaction ID
	readonly ServerTransactionID: number // Bytes 12..15 - Device's transaction ID
	readonly DataStart: number // Bytes 16..19 - Offset of the start of the data bytes
	readonly ImageElementType: AlpacaImageElementType // Bytes 20..23 - Element type of the source image array
	readonly TransmissionElementType: AlpacaImageElementType // Bytes 24..27 - Element type as sent over the network
	readonly Rank: 2 | 3 // Bytes 28..31 - Image array rank (2 or 3)
	readonly Dimension1: number // Bytes 32..35 - Length of image array first dimension
	readonly Dimension2: number // Bytes 36..39 - Length of image array second dimension
	readonly Dimension3: number // Bytes 40..43 - Length of image array third dimension (0 for 2D array)
}

export interface AlpacaResponse<T> {
	readonly Value: T
	readonly ClientTransactionID: number
	readonly ServerTransactionID: number
	readonly ErrorNumber: number
	readonly ErrorMessage: string
}

export interface AlpacaServerDescription {
	readonly ServerName: string
	readonly Manufacturer: string
	readonly ManufacturerVersion: string
	readonly Location: string
}

export interface AlpacaConfiguredDevice {
	readonly DeviceName: string
	readonly DeviceType: AlpacaDeviceType
	readonly DeviceNumber: number
	readonly UniqueID: string
}

export interface AlpacaStateItem {
	readonly Name: string
	readonly Value: boolean | number | string
}

export interface AlpacaAxisRate {
	readonly Maximum: number
	readonly Minimum: number
}

export interface AlpacaImageBytes {
	Type: 2
	Rank: 2 | 3
	Value: Readonly<Readonly<number[]>[]> | Readonly<Readonly<Readonly<number[]>[]>[]>
}

export interface AlpacaServerOptions {
	name?: string
	version?: string
	manufacturer?: string
	camera?: CameraManager
	mount?: MountManager
	focuser?: FocuserManager
	wheel?: WheelManager
	rotator?: RotatorManager
	flatPanel?: FlatPanelManager
	cover?: CoverManager
	guideOutput?: GuideOutputManager
	deviceNumberProvider?: AlpacaDeviceNumberProvider
}

export const SUPPORTED_FOCUSER_ACTIONS = ['ToggleReverse'] as const

export const SUPPORTED_WHEEL_ACTIONS = ['SetNames'] as const

export function defaultDeviceNumberProvider(device: Device, type: AlpacaDeviceType) {
	const id = `${type}:${device.name}`
	let deviceNumber = Bun.hash.cityHash32(id)
	deviceNumber = (deviceNumber & 0xffff) ^ ((deviceNumber >>> 16) & 0xffff)
	return deviceNumber
}

export class AlpacaError extends Error {
	constructor(
		readonly code: AlpacaException,
		message: string,
	) {
		super(message)
	}
}

export function alpacaImageElementTypeToBitpix(type: AlpacaImageElementType): BitpixOrZero {
	return type === 6 ? 8 : type === 1 || type === 8 ? 16 : type === 2 || type === 9 ? 32 : type === 5 ? 64 : type === 4 ? -32 : type === 3 ? -64 : 0
}
