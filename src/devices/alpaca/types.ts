import type { BitpixOrZero } from '../../io/formats/fits/fits'
import type { Cover, Device, FlatPanel } from '../indi/device'

// Shared type definitions for the ASCOM Alpaca protocol: device-type tags, error codes, the enumerated
// constants for cameras/telescopes, the JSON envelope shapes, and the ImageBytes binary-transfer layout.
// Used by both the Alpaca client and the embedded Alpaca server.

// ASCOM Alpaca device category, as it appears in REST endpoint paths.
export type AlpacaDeviceType = 'camera' | 'telescope' | 'focuser' | 'filterwheel' | 'rotator' | 'dome' | 'switch' | 'covercalibrator' | 'observingconditions' | 'safetymonitor' | 'video'

// Strategy for assigning a stable Alpaca device number to an INDI device of a given type.
export type AlpacaDeviceNumberProvider = (device: Device, type: AlpacaDeviceType) => number

// Bun.serve options the Alpaca server exposes to callers, with the fields it controls itself removed.
export type AlpacaServerStartOptions = Omit<Bun.Serve.HostnamePortServeOptions<undefined>, 'hostname' | 'port' | 'routes' | 'error' | 'fetch' | 'development'>

// Vendor-specific focuser action name supported by the server.
export type AlpacaFocuserAction = (typeof SUPPORTED_FOCUSER_ACTIONS)[number]

// Vendor-specific filter-wheel action name supported by the server.
export type AlpacaWheelAction = (typeof SUPPORTED_WHEEL_ACTIONS)[number]

// Combined cover + flat-panel device, matching the Alpaca CoverCalibrator interface.
export type CoverCalibrator = Cover & FlatPanel

// ASCOM Alpaca error numbers returned in the ErrorNumber field of responses.
// https://ascom-standards.org/newdocs/exceptions.html
export enum AlpacaException {
	MethodOrPropertyNotImplemented = 1024,
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

// Numeric element type of an ImageBytes array, both as stored on the device and as transmitted.
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

// Camera operational state reported by CameraState.
// https://ascom-standards.org/newdocs/camera.html#enumerated-constants

// Current camera activity from idle through exposing, reading, and download, plus error.
export enum AlpacaCameraState {
	IDLE,
	WAITING,
	EXPOSING,
	READING,
	DOWNLOAD,
	ERROR,
}

// Color-filter array / sensor color layout reported by SensorType.
export enum AlpacaCameraSensorType {
	MONOCHROME,
	COLOR,
	RGGB,
	CMYG,
	CMYG2,
	LRGB,
}

// Telescope enumerated constants.
// https://ascom-standards.org/newdocs/telescope.html#enumerated-constants

// Mount alignment geometry: alt-az, polar, or German equatorial.
export enum AlpacaTelescopeAlignmentMode {
	ALTAZ,
	POLAR,
	GERMAN_POLAR,
}

// Sidereal/lunar/solar/King tracking rate selector.
export enum AlpacaTelescopeTrackingRate {
	SIDEREAL,
	LUNAR,
	SOLAR,
	KING,
}

// Equatorial coordinate reference frame for target coordinates.
export enum AlpacaTelescopeEquatorialCoordinateType {
	OTHER,
	TOPOCENTRIC,
	J2000,
	J2050,
	B1950,
}

// Pulse-guide direction.
export enum AlpacaGuideDirection {
	NORTH,
	SOUTH,
	EAST,
	WEST,
}

// Pier (side-of-mount) state for a German equatorial mount; UNKNOWN when not determinable.
export enum AlpacaTelescopePierSide {
	UNKNOWN = -1,
	EAST,
	WEST,
}

// Mechanical axis selector for MoveAxis and axis-rate queries.
export enum AlpacaTelescopeAxis {
	PRIMARY,
	SECONDARY,
	TERTIARY,
}

// Fixed-layout header preceding the pixel data in an Alpaca ImageBytes binary response. Byte offsets
// are noted per field; all values are little-endian 32-bit integers.
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

// Standard JSON envelope wrapping every Alpaca REST response value with transaction and error metadata.
export interface AlpacaResponse<T> {
	// The actual returned value.
	readonly Value: T
	// Echoed client transaction id.
	readonly ClientTransactionID: number
	// Server-assigned transaction id.
	readonly ServerTransactionID: number
	// Alpaca error number; 0 on success.
	readonly ErrorNumber: number
	// Human-readable error text; empty on success.
	readonly ErrorMessage: string
}

// Server identity returned by the management API.
export interface AlpacaServerDescription {
	readonly ServerName: string
	readonly Manufacturer: string
	readonly ManufacturerVersion: string
	readonly Location: string
}

// One device entry from the management /configureddevices listing.
export interface AlpacaConfiguredDevice {
	readonly DeviceName: string
	readonly DeviceType: AlpacaDeviceType
	readonly DeviceNumber: number
	// Globally unique device identifier.
	readonly UniqueID: string
}

// One name/value pair from a DeviceState bulk-property response.
export interface AlpacaStateItem {
	readonly Name: string
	readonly Value: boolean | number | string
}

// Allowed slew-rate range for one mount axis, device units per second.
export interface AlpacaAxisRate {
	readonly Maximum: number
	readonly Minimum: number
}

// Image data decoded from an ImageBytes transfer as a 2D or 3D nested numeric array.
export interface AlpacaImageBytes {
	// ImageArray type tag (2 = numeric array).
	Type: 2
	// Array rank: 2 for mono, 3 for color planes.
	Rank: 2 | 3
	Value: Readonly<Readonly<number[]>[]> | Readonly<Readonly<Readonly<number[]>[]>[]>
}

// Vendor focuser actions advertised and handled by the embedded server.
export const SUPPORTED_FOCUSER_ACTIONS = ['ToggleReverse'] as const

// Vendor filter-wheel actions advertised and handled by the embedded server.
export const SUPPORTED_WHEEL_ACTIONS = ['SetNames'] as const

// Derives a stable 16-bit Alpaca device number by hashing the device type and name (CityHash32 folded
// down to 16 bits). Deterministic so the same INDI device keeps its number across restarts.
export function defaultDeviceNumberProvider(device: Device, type: AlpacaDeviceType) {
	const id = `${type}:${device.name}`
	let deviceNumber = Bun.hash.cityHash32(id)
	deviceNumber = (deviceNumber & 0xffff) ^ ((deviceNumber >>> 16) & 0xffff)
	return deviceNumber
}

// Error carrying an Alpaca exception code alongside the message.
export class AlpacaError extends Error {
	constructor(
		readonly code: AlpacaException,
		message: string,
	) {
		super(message)
	}
}

// Maps an Alpaca image element type to the corresponding FITS BITPIX value (negative = floating point),
// or 0 when the type has no FITS equivalent.
export function alpacaImageElementTypeToBitpix(type: AlpacaImageElementType): BitpixOrZero {
	return type === 6 ? 8 : type === 1 || type === 8 ? 16 : type === 2 || type === 9 ? 32 : type === 5 ? 64 : type === 4 ? -32 : type === 3 ? -64 : 0
}
