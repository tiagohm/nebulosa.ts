import type { Cover, Device, FlatPanel } from './indi.device'
import type { CameraManager, CoverManager, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, RotatorManager, WheelManager } from './indi.manager'

export const ALPACA_DISCOVERY_PORT = 32227
export const ALPACA_DISCOVERY_DATA = 'alpacadiscovery1'

export type AlpacaDeviceType = 'Camera' | 'Telescope' | 'Focuser' | 'FilterWheel' | 'Rotator' | 'Dome' | 'Switch' | 'CoverCalibrator' | 'ObservingConditions' | 'SafetyMonitor' | 'Video'

export type AlpacaDeviceNumberAndUniqueIdProvider = (device: Device, type: AlpacaDeviceType) => readonly [number, string]

export type AlpacaServerStartOptions = Omit<Bun.Serve.HostnamePortServeOptions<undefined>, 'hostname' | 'port' | 'routes' | 'error' | 'fetch' | 'development'>

export type CoverCalibrator = Cover & FlatPanel

export enum AlpacaCameraState {
	Idle,
	Waiting,
	Exposing,
	Reading,
	Download,
	Error,
}

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

export interface AlpacaDiscoveryServerOptions {
	ignoreLocalhost?: boolean
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
	deviceNumberAndUniqueIdProvider?: AlpacaDeviceNumberAndUniqueIdProvider
}

export function defaultDeviceNumberAndUniqueIdProvider(device: Device, type: AlpacaDeviceType) {
	const id = `${type}:${device.name}`
	let deviceNumber = Bun.hash.cityHash32(id)
	deviceNumber = (deviceNumber & 0xffff) ^ ((deviceNumber >>> 16) & 0xffff)
	const uniqueId = Bun.MD5.hash(id, 'hex')
	return [deviceNumber, uniqueId] as const
}

export class AlpacaError extends Error {
	constructor(
		readonly code: AlpacaException,
		message: string,
	) {
		super(message)
	}
}
