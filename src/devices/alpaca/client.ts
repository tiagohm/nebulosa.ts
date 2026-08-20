import { AlpacaCameraApi, AlpacaCoverCalibratorApi, AlpacaDomeApi, type AlpacaDeviceApi, AlpacaFilterWheelApi, AlpacaFocuserApi, AlpacaManagementApi, AlpacaObservingConditionsApi, AlpacaRotatorApi, AlpacaSafetyMonitorApi, AlpacaTelescopeApi } from './api'
// oxfmt-ignore
import { type AlpacaAxisRate, type AlpacaCameraSensorType, type AlpacaCameraState, type AlpacaConfiguredDevice, type AlpacaDeviceType, AlpacaDomeShutterState, AlpacaException, type AlpacaRequestResult, type AlpacaStateItem, type AlpacaTelescopeEquatorialCoordinateType, type AlpacaTelescopePierSide, type AlpacaTelescopeTrackingRate, alpacaImageElementTypeToBitpix, type ImageBytesMetadata } from './types'
import { equatorialFromJ2000, equatorialToJ2000 } from '../../astronomy/coordinates/coordinate'
import { SIDEREAL_RATE } from '../../core/constants'
import { computeRemainingBytes, FITS_BLOCK_SIZE, FITS_HEADER_CARD_SIZE, type FitsHeader, FitsKeywordWriter } from '../../io/formats/fits/fits'
import { bitpixInBytes } from '../../io/formats/fits/util'
import { type Angle, formatDEC, formatRA, normalizeAngle, toDeg } from '../../math/units/angle'
import { handleDefLightVector, handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetBlobVector, handleSetLightVector, handleSetNumberVector, handleSetSwitchVector, handleSetTextVector, type IndiClientHandler } from '../indi/client'
import type { Camera, Client, Device, Focuser, Mount, Rotator, WeatherSensor, Wheel } from '../indi/device'
import { type DeviceProvider, WEATHER_SENSORS } from '../indi/manager'
// oxfmt-ignore
import { type DefSwitchVector, type DefVector, type EnableBlob, findOnSwitch, type GetProperties, makeBlobVector, makeLightVector, makeNumberVector, makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector, type PropertyState, type ValueType, type VectorType } from '../indi/types'
import { formatTemporal, TIMEZONE } from '../../astronomy/time/temporal'
import { type Time, timeNow } from '../../astronomy/time/time'
import { roundToNthDecimal } from '../../math/numerical/math'

// Alpaca-to-INDI client adapter: polls an ASCOM Alpaca server over HTTP and presents each device to the
// rest of the app through the same INDI Client/handler interface used by native INDI. Each Alpaca device
// type maps to a device class that translates polled Alpaca state into INDI property vectors and routes
// INDI commands back to Alpaca REST calls. Also converts ImageBytes downloads into FITS.

// Marker handler type; the Alpaca client reuses the INDI client handler contract unchanged.
export interface AlpacaClientHandler extends IndiClientHandler {}

// Options for constructing an AlpacaClient.
export interface AlpacaClientOptions {
	// Receiver of the synthesized INDI property events.
	handler: AlpacaClientHandler
	// Polling period in milliseconds (clamped to a 1000 ms minimum). Misspelled to match existing API.
	poolingInterval?: number
}

// Top-level Alpaca connection: discovers the server's configured devices, builds a device wrapper for
// each, and drives them on a fixed polling interval while exposing the INDI Client surface.
export class AlpacaClient implements Client {
	readonly type = 'ALPACA'
	readonly id: string
	readonly description: string

	readonly remoteHost: string
	readonly remotePort: number

	readonly #devices = new Map<string, AlpacaDevice>()
	readonly #management: AlpacaManagementApi
	#timer?: NodeJS.Timeout

	constructor(
		readonly url: string,
		readonly options: AlpacaClientOptions,
		readonly provider: DeviceProvider<Device>,
	) {
		this.id = Bun.MD5.hash(url, 'hex')
		this.description = `Alpaca Client at ${url}`
		this.#management = new AlpacaManagementApi(url)
		const { protocol, hostname, port } = URL.parse(url)!
		this.remoteHost = hostname
		this.remotePort = +port || (protocol === 'http:' ? 80 : 443)
	}

	// INDI getProperties: replays the definitions of one device (or all) to the handler.
	getProperties(command?: GetProperties) {
		if (command?.device) {
			this.#devices.get(command.device)?.sendProperties(command.name)
		} else {
			for (const device of this.#devices) device[1].sendProperties(command?.name)
		}
	}

	// Alpaca has no BLOB streaming; nothing to enable.
	enableBlob(command: EnableBlob) {}

	// Routes an INDI text/number/switch command to the addressed device wrapper.
	sendText(vector: NewTextVector) {
		this.#devices.get(vector.device)?.sendText(vector)
	}

	sendNumber(vector: NewNumberVector) {
		this.#devices.get(vector.device)?.sendNumber(vector)
	}

	sendSwitch(vector: NewSwitchVector) {
		this.#devices.get(vector.device)?.sendSwitch(vector)
	}

	// Queries the server's configured devices and begins polling. Returns false if already started or the
	// server reports no devices.
	async start() {
		if (this.#timer) return false
		const configuredDevices = await this.#management.configuredDevices()
		if (!configuredDevices.ok || configuredDevices.value.length === 0) return false
		this.#initialize(configuredDevices.value)
		return true
	}

	// Builds a wrapper for each new device, initializes it, and (re)starts the polling timer.
	#initialize(configuredDevices: readonly AlpacaConfiguredDevice[]) {
		for (const configuredDevice of configuredDevices) {
			let device = this.#devices.get(configuredDevice.DeviceName)

			if (!device) {
				const type = configuredDevice.DeviceType

				if (type === 'camera') {
					device = new AlpacaCamera(this, configuredDevice)
				} else if (type === 'telescope') {
					device = new AlpacaTelescope(this, configuredDevice)
				} else if (type === 'filterwheel') {
					device = new AlpacaFilterWheel(this, configuredDevice)
				} else if (type === 'focuser') {
					device = new AlpacaFocuser(this, configuredDevice)
				} else if (type === 'covercalibrator') {
					device = new AlpacaCoverCalibrator(this, configuredDevice)
				} else if (type === 'rotator') {
					device = new AlpacaRotator(this, configuredDevice)
				} else if (type === 'dome') {
					device = new AlpacaDome(this, configuredDevice)
				} else if (type === 'safetymonitor') {
					device = new AlpacaSafetyMonitor(this, configuredDevice)
				} else if (type === 'observingconditions') {
					device = new AlpacaObservingConditions(this, configuredDevice)
				}

				if (device) {
					this.#devices.set(configuredDevice.DeviceName, device)
					device.onInit()
				}
			}
		}

		clearInterval(this.#timer)
		this.#timer = setInterval(this.#update.bind(this), Math.max(1000, this.options?.poolingInterval ?? 1000))
		this.#update()
	}

	// One polling tick: advances every device wrapper.
	#update() {
		for (const device of this.#devices) device[1].update()
	}

	// Stops polling, closes and clears all devices, and notifies the handler. `server` flags whether the
	// stop originated from a server-side disconnect.
	stop(server: boolean = false) {
		if (this.#timer) {
			clearInterval(this.#timer)
			this.#timer = undefined

			for (const device of this.#devices) device[1].close()
			this.#devices.clear()

			this.options?.handler?.close?.(this, server)
		}
	}

	[Symbol.dispose]() {
		this.stop()
	}
}

// INDI DRIVER_INTERFACE bitmask (as a string) advertised for each Alpaca device type, so INDI clients
// recognize the device class. Empty string for types without a corresponding INDI interface bit.
const DRIVER_INTERFACES: Readonly<Record<Uppercase<AlpacaDeviceType>, string>> = {
	SWITCH: '65536',
	CAMERA: '2',
	TELESCOPE: '1',
	FOCUSER: '8',
	FILTERWHEEL: '16',
	ROTATOR: '4096',
	DOME: '32',
	COVERCALIBRATOR: '1536',
	OBSERVINGCONDITIONS: '128',
	SAFETYMONITOR: '',
	VIDEO: '',
}

// INDI property group label for the primary controls tab.
const MAIN_CONTROL = 'Main Control'
// INDI property group label for the read-only driver/general info tab.
const GENERAL_INFO = 'General Info'

// Minimal polled state shared by every device: connection flag, optional bulk DeviceState, and the
// step counter that sequences the initial endpoint-enable handshake.
interface AlpacaClientDeviceState {
	readonly Connected: boolean
	DeviceState?: readonly AlpacaStateItem[]
	Step: number
}

// Base class for all Alpaca device wrappers. Owns the INDI property vectors (connection, driver info,
// snooped devices), the endpoint runner that polls the Alpaca REST API, and the connect/disconnect
// handshake. Subclasses declare their device-specific endpoints and translate polled state into property
// updates via handleEndpointsAfterRun.
abstract class AlpacaDevice {
	// Alpaca device number used in REST paths.
	readonly id: number

	// Schedules and runs the polled REST endpoints.
	protected readonly runner = new AlpacaApiRunner()
	// All INDI property vectors currently defined for this device.
	protected readonly properties = new Set<DefVector & { readonly type: Uppercase<VectorType> }>()
	// Endpoint keys the server answered MethodOrPropertyNotImplemented for, which is the only definitive
	// statement that a member does not exist. Cleared on every (re)connect, since a different driver may
	// answer for the same device number.
	protected readonly unsupported = new Set<string>()

	// REST API wrapper for this device type.
	protected abstract readonly api: AlpacaDeviceApi
	// Mutable polled-state bag populated by the runner endpoints.
	protected abstract readonly state: AlpacaClientDeviceState
	protected abstract readonly initialEndpoints: readonly string[] // Endpoints used by step 1
	protected abstract readonly deviceStateEndpoints: readonly string[] // Used when DeviceState is not supported
	protected readonly runningEndpoints: readonly string[] = [] // Endpoints should run on each update

	// Read-only driver/identification property.
	protected readonly driverInfo = makeTextVector('', 'DRIVER_INFO', 'Driver Info', GENERAL_INFO, 'ro', ['DRIVER_INTERFACE', 'Interface', ''], ['DRIVER_EXEC', 'Exec', ''], ['DRIVER_VERSION', 'Version', '1.0'], ['DRIVER_NAME', 'Name', ''])
	// Connect/disconnect switch property.
	protected readonly connection = makeSwitchVector('', 'CONNECTION', 'Connection', MAIN_CONTROL, 'OneOfMany', 'rw', ['CONNECT', 'Connect', false], ['DISCONNECT', 'Disconnect', true])
	// Names of related devices this one snoops (mount/focuser/wheel/rotator) for cross-device data.
	protected readonly snoopDevices = makeTextVector('', 'ACTIVE_DEVICES', 'Snoop devices', MAIN_CONTROL, 'rw', ['ACTIVE_TELESCOPE', 'Mount', ''], ['ACTIVE_FOCUSER', 'Focuser', ''], ['ACTIVE_FILTER', 'Filter Wheel', ''], ['ACTIVE_ROTATOR', 'Rotator', ''])

	#hasDeviceState: 0 | boolean = 0 // 0 = not checked yet

	constructor(
		readonly client: AlpacaClient,
		readonly device: AlpacaConfiguredDevice,
		readonly handler: AlpacaClientHandler,
	) {
		this.id = device.DeviceNumber

		this.driverInfo.device = device.DeviceName
		this.driverInfo.elements.DRIVER_NAME.value = device.DeviceName
		this.driverInfo.elements.DRIVER_EXEC.value = device.UniqueID
		this.driverInfo.elements.DRIVER_INTERFACE.value = DRIVER_INTERFACES[device.DeviceType.toUpperCase() as never]

		this.connection.device = device.DeviceName
		this.snoopDevices.device = device.DeviceName

		this.runner.registerHandler(this.handleEndpointsAfterRun.bind(this))
	}

	// True when the connection switch reports the device as connected.
	get isConnected() {
		return this.connection.elements.CONNECT.value === true
	}

	// Resolves the currently snooped mount/wheel/focuser/rotator device, or undefined when unset.
	get activeMount() {
		if (!this.snoopDevices.elements.ACTIVE_TELESCOPE.value) return undefined
		return this.client.provider.get(this.client, this.snoopDevices.elements.ACTIVE_TELESCOPE.value, 'mount') as Mount | undefined
	}

	get activeWheel() {
		if (!this.snoopDevices.elements.ACTIVE_FILTER.value) return undefined
		return this.client.provider.get(this.client, this.snoopDevices.elements.ACTIVE_FILTER.value, 'wheel') as Wheel | undefined
	}

	get activeFocuser() {
		if (!this.snoopDevices.elements.ACTIVE_FOCUSER.value) return undefined
		return this.client.provider.get(this.client, this.snoopDevices.elements.ACTIVE_FOCUSER.value, 'focuser') as Focuser | undefined
	}

	get activeRotator() {
		if (!this.snoopDevices.elements.ACTIVE_ROTATOR.value) return undefined
		return this.client.provider.get(this.client, this.snoopDevices.elements.ACTIVE_ROTATOR.value, 'rotator') as Rotator | undefined
	}

	// Emits an INDI def* event for a property (dispatching by vector type) and tracks it as defined.
	protected sendDefProperty(message: DefVector & { type: Uppercase<VectorType> }) {
		if (message.type[0] === 'S') handleDefSwitchVector(this.client, this.handler, message as never)
		else if (message.type[0] === 'N') handleDefNumberVector(this.client, this.handler, message as never)
		else if (message.type[0] === 'T') handleDefTextVector(this.client, this.handler, message as never)
		else if (message.type[0] === 'L') handleDefLightVector(this.client, this.handler, message as never)

		this.properties.add(message)
	}

	// Emits an INDI set* (value/state update) event for a property, dispatching by vector type.
	protected sendSetProperty(message: DefVector & { type: Uppercase<VectorType> }) {
		if (message.type[0] === 'S') handleSetSwitchVector(this.client, this.handler, message as never)
		else if (message.type[0] === 'N') handleSetNumberVector(this.client, this.handler, message as never)
		else if (message.type[0] === 'T') handleSetTextVector(this.client, this.handler, message as never)
		else if (message.type[0] === 'L') handleSetLightVector(this.client, this.handler, message as never)
	}

	// Emits an INDI delProperty event for each currently-defined property and forgets it.
	protected sendDelProperty(...messages: DefVector[]) {
		for (const message of messages) {
			if (this.properties.delete(message as never)) {
				handleDelProperty(this.client, this.handler, message)
			}
		}
	}

	// Updates a property's state in place if it changed; returns whether a change occurred.
	protected updatePropertyState(property: DefVector, state: PropertyState | undefined) {
		if (state !== undefined && property.state !== state) {
			property.state = state
			return true
		}

		return false
	}

	// Updates one element's value if changed. For OneOf* switches, setting an element true clears the
	// siblings. Returns whether a change occurred; undefined/null values are ignored.
	protected updatePropertyValue<T extends Uppercase<VectorType>>(property: DefVector & { type: T }, name: string, value?: T extends 'SWITCH' ? boolean : T extends 'NUMBER' ? number : string) {
		if (value === undefined || value === null) return false

		const { elements, type } = property
		const element = elements[name]

		if (element.value !== value) {
			element.value = value

			if (type[0] === 'S') {
				const { rule } = property as DefSwitchVector

				if (value === true && rule !== 'AnyOfMany') {
					for (const p in elements) {
						if (p !== name) {
							elements[p].value = false
						}
					}
				}
			}

			return true
		}

		return false
	}

	// Re-sends def + set for every property (or just the named one) to replay current state to a client.
	sendProperties(name?: string) {
		for (const property of this.properties) {
			if (!name || property.name === name) {
				this.sendDefProperty(property)
				this.sendSetProperty(property)
			}
		}
	}

	// Defines the baseline properties and registers the connection/device-state polling endpoints.
	onInit() {
		this.sendDefProperty(this.driverInfo)
		this.sendDefProperty(this.connection)

		this.registerEndpoint('Connected', () => this.api.isConnected(this.id), true)
		this.registerEndpoint('DeviceState', () => this.api.deviceState(this.id), false)
	}

	// Clears the handshake step and cached DeviceState so the init sequence runs again.
	protected reset() {
		this.state.Step = 0
		this.#hasDeviceState = 0
		this.state.DeviceState = undefined
		this.unsupported.clear()
	}

	// Hook run when the device transitions to connected; subclasses may extend.
	protected onConnect() {
		this.reset()
	}

	// Hook run on disconnect: resets state, disables all endpoints, and deletes published properties.
	protected onDisconnect() {
		this.reset()
		this.disableEndpoints('DeviceState')
		this.disableEndpoints(...this.initialEndpoints)
		this.disableEndpoints(...this.deviceStateEndpoints)
		this.disableEndpoints(...this.runningEndpoints)
		this.sendDelProperty(...this.properties)
	}

	// One polling tick: runs the enabled endpoints, which then invoke handleEndpointsAfterRun.
	update() {
		void this.runner.run(this.state as never)
	}

	// Hook called once the device is found not to support the bulk DeviceState endpoint; subclasses may
	// enable per-property fallbacks.
	protected deviceStateHasBeenDisabled() {}

	// Post-poll reconciliation: applies the connection transition, runs the staged init handshake (step 0
	// probes DeviceState support, step 1 enables the device endpoints), and spreads bulk DeviceState into
	// the state bag. Returns true once steady-state polling should proceed for this tick.
	protected handleEndpointsAfterRun() {
		const { Connected, Step } = this.state

		if (Connected === undefined) {
			return this.client.stop(true)
		}

		if (Connected !== this.isConnected) {
			let updated = this.updatePropertyState(this.connection, 'Idle')

			if (Connected) {
				updated = this.updatePropertyValue(this.connection, 'CONNECT', true) || updated
				this.onConnect()
			} else {
				updated = this.updatePropertyValue(this.connection, 'DISCONNECT', true) || updated
				this.onDisconnect()
			}

			updated && this.sendSetProperty(this.connection)
		}

		if (Connected) {
			if (Step === 0) {
				if (this.#hasDeviceState === 0) {
					// Step 0 will run again to read the device state
					this.#hasDeviceState = true
					this.enableEndpoints('DeviceState')
					return false
				}

				if (this.#hasDeviceState === true && this.state.DeviceState === undefined) {
					this.#hasDeviceState = false
					this.enableEndpoints(...this.deviceStateEndpoints)
					this.disableEndpoints('DeviceState')
					this.deviceStateHasBeenDisabled()
					console.info(this.device.DeviceName, 'does not support DeviceState')
				}

				this.enableEndpoints(...this.initialEndpoints)
				this.enableEndpoints(...this.runningEndpoints)

				this.state.Step = 1

				return false
			} else if (this.#hasDeviceState === true) {
				// A transient /devicestate failure leaves the bag empty for this tick. Skip it and keep the
				// previous values rather than iterating undefined, which would throw inside the async
				// after-run handler and skip every remaining handler.
				const bulk = this.state.DeviceState

				if (bulk === undefined) return false

				for (const item of bulk) {
					this.state[item.Name as never] = item.Value as never
				}
			}

			return true
		}

		return false
	}

	// Registers a polled endpoint, unwrapping its AlpacaRequestResult into the plain value the state bag
	// holds. `enabled` sets initial polling; `interval` polls every Nth tick (1 = every tick).
	protected registerEndpoint<T>(key: string, call: () => Promise<AlpacaRequestResult<T>>, enabled: boolean, interval: number = 1) {
		this.runner.registerEndpoint(key, () => this.#read(key, call), enabled, interval)
	}

	// Runs one polled call and reduces it to the value, or undefined when it failed.
	//
	// An endpoint the server reports as unimplemented is recorded and disabled for good, which is what
	// keeps an optional member from being re-requested on every tick for the life of the connection.
	// Nothing else is definitive: a timeout, a 5xx, or ValueNotSet leaves the endpoint polling so it can
	// recover on its own.
	async #read<T>(key: string, call: () => Promise<AlpacaRequestResult<T>>) {
		const result = await call()

		if (result.ok) return result.value

		if (result.errorNumber === AlpacaException.MethodOrPropertyNotImplemented) {
			this.unsupported.add(key)
			this.disableEndpoints(key)
		}

		return undefined
	}

	// Enables the named endpoints and clears their cached state values so the next poll refetches them.
	protected enableEndpoints(...keys: string[]) {
		for (const key of keys) {
			;(this.state as unknown as Record<string, undefined>)[key] = undefined
			this.runner.toggleEndpoint(key, true)
		}
	}

	// Disables the named endpoints so the runner stops polling them.
	protected disableEndpoints(...keys: string[]) {
		for (const key of keys) this.runner.toggleEndpoint(key, false)
	}

	// Handles an inbound INDI text command. The base only updates the snooped-device names.
	sendText(vector: NewTextVector) {
		switch (vector.name) {
			case 'ACTIVE_DEVICES':
				for (const type in vector.elements) {
					if (type in this.snoopDevices.elements) this.snoopDevices.elements[type].value = vector.elements[type]
				}

				this.sendSetProperty(this.snoopDevices)
				break
		}
	}

	// Handles an inbound INDI number command. The base device has no numeric controls.
	sendNumber(vector: NewNumberVector) {}

	// Handles an inbound INDI switch command. The base only acts on the connection switch.
	sendSwitch(vector: NewSwitchVector) {
		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true && !this.isConnected) {
					void this.#handleConnection('connect')
				} else if (vector.elements.DISCONNECT === true && this.isConnected) {
					void this.#handleConnection('disconnect')
				}
		}
	}

	// Issues the Alpaca connect/disconnect call, reflecting Busy → Idle/Alert in the connection property.
	async #handleConnection(mode: 'connect' | 'disconnect') {
		this.connection.state = 'Busy'
		this.sendSetProperty(this.connection)

		const { ok } = await this.api[mode](this.id)
		this.connection.state = ok ? 'Idle' : 'Alert'
		this.sendSetProperty(this.connection)
	}

	// Releases device-specific resources on shutdown; the base has none.
	close() {}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indiccd.cpp

// Polled camera state. Fields mirror Alpaca camera properties; optional ones are absent until first
// fetched, mutable ones are written by inbound commands or per-frame logic.
interface AlpacaClientCameraState extends AlpacaClientDeviceState {
	readonly CameraState: AlpacaCameraState
	readonly CCDTemperature: number
	readonly CoolerPower: number
	readonly ImageReady: boolean
	readonly IsPulseGuiding: boolean
	readonly PercentCompleted: number
	readonly BayerOffsetX?: number
	readonly BayerOffsetY?: number
	readonly SensorType?: AlpacaCameraSensorType
	BinX?: number
	BinY?: number
	readonly CameraXSize?: number
	readonly CameraYSize?: number
	IsCoolerOn?: boolean
	readonly ExposureMax?: number
	readonly ExposureMin?: number
	Gain?: number
	readonly GainMax?: number
	readonly GainMin?: number
	readonly Gains?: readonly string[]
	readonly MaxBinX?: number
	readonly MaxBinY?: number
	NumX?: number
	NumY?: number
	Offset?: number
	readonly OffsetMax?: number
	readonly OffsetMin?: number
	readonly Offsets?: readonly string[]
	readonly PixelSizeX?: number
	readonly PixelSizeY?: number
	ReadoutMode?: number
	readonly ReadoutModes?: readonly string[] // Frame format
	StartX?: number
	StartY?: number
	readonly CanAsymmetricBin?: boolean
	readonly CanGetCoolerPower?: boolean
	readonly CanPulseGuide?: boolean
	readonly CanSetCcdTemperature?: boolean
	readonly CanStopExposure?: boolean
	ExposureDuration: number
	ExposureStarted: boolean
	LastCameraState: number
}

// Camera device wrapper: exposes the standard INDI CCD properties (frame, binning, gain/offset, cooler,
// exposure, guiding, image BLOB) and maps polled Alpaca camera state onto them.
class AlpacaCamera extends AlpacaDevice {
	protected readonly api: AlpacaCameraApi
	// https://ascom-standards.org/newdocs/camera.html#Camera.DeviceState
	// oxfmt-ignore
	protected readonly state: AlpacaClientCameraState = { Connected: false, Step: 0, CameraState: 0, CCDTemperature: 0, CoolerPower: 0, ImageReady: false, IsPulseGuiding: false, PercentCompleted: 0, ExposureDuration: 0, ExposureStarted: false, LastCameraState: 0 }
	// oxfmt-ignore
	protected readonly initialEndpoints = ['BayerOffsetX', 'BayerOffsetY', 'SensorType', 'CameraXSize', 'CameraYSize', 'CanGetCoolerPower', 'CanPulseGuide', 'CanSetCcdTemperature', 'CanStopExposure', 'ExposureMax', 'ExposureMin', 'GainMax', 'GainMin', 'Gains', 'MaxBinX', 'MaxBinY', 'OffsetMax', 'OffsetMin', 'Offsets', 'PixelSizeX', 'PixelSizeY', 'ReadoutModes'] as const
	protected readonly deviceStateEndpoints = ['CameraState', 'CCDTemperature', 'CoolerPower', 'ImageReady', 'IsPulseGuiding', 'PercentCompleted'] as const
	protected readonly runningEndpoints = ['BinX', 'BinY', 'IsCoolerOn', 'Gain', 'NumX', 'NumY', 'Offset', 'ReadoutMode', 'StartX', 'StartY'] as const

	// oxfmt-ignore
	readonly #info = makeNumberVector('', 'CCD_INFO', 'CCD Info', GENERAL_INFO, 'ro', ['CCD_MAX_X', 'Max X', 0, 0, 16000, 1, '%.0f'],  ['CCD_MAX_Y', 'Max Y', 0, 0, 16000, 1, '%.0f'],  ['CCD_PIXEL_SIZE_X', 'Pixel size X', 0, 0, 40, 0.01, '%.2f'], ['CCD_PIXEL_SIZE_Y', 'Pixel size Y', 0, 0, 40, 0.01, '%.2f'], ['CCD_BITSPERPIXEL', 'Bits per pixel', 16, 8, 64, 1, '%.0f'])
	readonly #cooler = makeSwitchVector('', 'CCD_COOLER', 'Cooler', MAIN_CONTROL, 'OneOfMany', 'rw', ['COOLER_ON', 'On', false], ['COOLER_OFF', 'Off', true])
	readonly #frameType = makeSwitchVector('', 'CCD_FRAME_TYPE', 'Frame Type', MAIN_CONTROL, 'OneOfMany', 'rw', ['FRAME_LIGHT', 'Light', true], ['FRAME_DARK', 'Dark', false], ['FRAME_FLAT', 'Flat', false], ['FRAME_BIAS', 'Bias', false])
	readonly #frameFormat = makeSwitchVector('', 'CCD_CAPTURE_FORMAT', 'Readout Mode', MAIN_CONTROL, 'OneOfMany', 'rw')
	readonly #abort = makeSwitchVector('', 'CCD_ABORT_EXPOSURE', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #exposure = makeNumberVector('', 'CCD_EXPOSURE', 'Exposure', MAIN_CONTROL, 'rw', ['CCD_EXPOSURE_VALUE', 'Exposure (s)', 0, 0, 0, 1e-6, '%.6f'])
	readonly #coolerPower = makeNumberVector('', 'CCD_COOLER_POWER', 'Cooler Power', MAIN_CONTROL, 'ro', ['CCD_COOLER_POWER', 'Power (%)', 0, 0, 100, 1, '%.0f'])
	readonly #temperature = makeNumberVector('', 'CCD_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'ro', ['CCD_TEMPERATURE_VALUE', 'Temperature', 0, -50, 70, 0.1, '%6.2f'])
	readonly #frame = makeNumberVector('', 'CCD_FRAME', 'Frame', MAIN_CONTROL, 'rw', ['X', 'X', 0, 0, 15999, 1, '%.0f'], ['Y', 'Y', 0, 0, 15999, 1, '%.0f'], ['WIDTH', 'Width', 1, 1, 16000, 1, '%.0f'], ['HEIGHT', 'Height', 1, 1, 16000, 1, '%.0f'])
	readonly #bin = makeNumberVector('', 'CCD_BINNING', 'Bin', MAIN_CONTROL, 'rw', ['HOR_BIN', 'X', 1, 1, 1, 1, '%.0f'], ['VER_BIN', 'Y', 1, 1, 1, 1, '%.0f'])
	readonly #gain = makeNumberVector('', 'CCD_GAIN', 'Gain', MAIN_CONTROL, 'rw', ['GAIN', 'Gain', 0, 0, 0, 1, '%.0f'])
	readonly #offset = makeNumberVector('', 'CCD_OFFSET', 'Offset', MAIN_CONTROL, 'rw', ['OFFSET', 'Offset', 0, 0, 0, 1, '%.0f'])
	readonly #cfa = makeTextVector('', 'CCD_CFA', 'CFA', GENERAL_INFO, 'ro', ['CFA_OFFSET_X', 'Offset X', '0'], ['CFA_OFFSET_Y', 'Offset Y', '0'], ['CFA_TYPE', 'Type', 'RGGB']) // Only RGGB pattern is supported?
	readonly #guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #image = makeBlobVector('', 'CCD1', 'CCD Image', MAIN_CONTROL, 'ro', ['CCD1', 'Image'])

	readonly #now = timeNow() // Used in the conversion from JNOW to J2000. Changes in precession/nutation angles are negligible.

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaCameraApi(client.url)

		this.#info.device = device.DeviceName
		this.#cooler.device = device.DeviceName
		this.#frameType.device = device.DeviceName
		this.#frameFormat.device = device.DeviceName
		this.#abort.device = device.DeviceName
		this.#exposure.device = device.DeviceName
		this.#coolerPower.device = device.DeviceName
		this.#temperature.device = device.DeviceName
		this.#frame.device = device.DeviceName
		this.#bin.device = device.DeviceName
		this.#gain.device = device.DeviceName
		this.#offset.device = device.DeviceName
		this.#cfa.device = device.DeviceName
		this.#guideNS.device = device.DeviceName
		this.#guideWE.device = device.DeviceName
		this.#image.device = device.DeviceName

		this.registerEndpoint('BayerOffsetX', () => api.getBayerOffsetX(this.id), false)
		this.registerEndpoint('BayerOffsetY', () => api.getBayerOffsetY(this.id), false)
		this.registerEndpoint('SensorType', () => api.getSensorType(this.id), false)
		this.registerEndpoint('BinX', () => api.getBinX(this.id), false, 60)
		this.registerEndpoint('BinY', () => api.getBinY(this.id), false, 60)
		this.registerEndpoint('CameraXSize', () => api.getCameraXSize(this.id), false)
		this.registerEndpoint('CameraYSize', () => api.getCameraYSize(this.id), false)
		this.registerEndpoint('CanGetCoolerPower', () => api.canGetCoolerPower(this.id), false)
		this.registerEndpoint('CanPulseGuide', () => api.canPulseGuide(this.id), false)
		this.registerEndpoint('CanSetCcdTemperature', () => api.canSetCcdTemperature(this.id), false)
		this.registerEndpoint('CanStopExposure', () => api.canStopExposure(this.id), false)
		this.registerEndpoint('IsCoolerOn', () => api.isCoolerOn(this.id), false, 60)
		this.registerEndpoint('ExposureMax', () => api.getExposureMax(this.id), false)
		this.registerEndpoint('ExposureMin', () => api.getExposureMin(this.id), false)
		this.registerEndpoint('Gain', () => api.getGain(this.id), false, 60)
		this.registerEndpoint('GainMax', () => api.getGainMax(this.id), false)
		this.registerEndpoint('GainMin', () => api.getGainMin(this.id), false)
		this.registerEndpoint('Gains', () => api.getGains(this.id), false)
		this.registerEndpoint('MaxBinX', () => api.getMaxBinX(this.id), false)
		this.registerEndpoint('MaxBinY', () => api.getMaxBinY(this.id), false)
		this.registerEndpoint('NumX', () => api.getNumX(this.id), false, 60)
		this.registerEndpoint('NumY', () => api.getNumY(this.id), false, 60)
		this.registerEndpoint('Offset', () => api.getOffset(this.id), false, 60)
		this.registerEndpoint('OffsetMax', () => api.getOffsetMax(this.id), false)
		this.registerEndpoint('OffsetMin', () => api.getOffsetMin(this.id), false)
		this.registerEndpoint('Offsets', () => api.getOffsets(this.id), false)
		this.registerEndpoint('PixelSizeX', () => api.getPixelSizeX(this.id), false)
		this.registerEndpoint('PixelSizeY', () => api.getPixelSizeY(this.id), false)
		this.registerEndpoint('ReadoutMode', () => api.getReadoutMode(this.id), false, 60)
		this.registerEndpoint('ReadoutModes', () => api.getReadoutModes(this.id), false)
		this.registerEndpoint('StartX', () => api.getStartX(this.id), false, 60)
		this.registerEndpoint('StartY', () => api.getStartY(this.id), false, 60)
		this.registerEndpoint('CameraState', () => api.getCameraState(this.id), false)
		this.registerEndpoint('CCDTemperature', () => api.getCcdTemperature(this.id), false)
		this.registerEndpoint('CoolerPower', () => api.getCoolerPower(this.id), false)
		this.registerEndpoint('ImageReady', () => api.isImageReady(this.id), false)
		this.registerEndpoint('IsPulseGuiding', () => api.isPulseGuiding(this.id), false)
		this.registerEndpoint('PercentCompleted', () => api.getPercentCompleted(this.id), false)

		this.api = api
	}

	// True when the selected frame type is a light frame.
	get isLight() {
		return this.#frameType.elements.FRAME_LIGHT?.value === true
	}

	// Reconciles polled camera state into the INDI CCD properties: dimensions/pixel size, cooler and
	// temperature, gain/offset/readout ranges, binning, subframe, and exposure progress, emitting the
	// image BLOB and FITS when a frame completes. Returns false until the device is fully initialized.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, CameraState, CCDTemperature, CoolerPower, ImageReady, IsPulseGuiding, PercentCompleted, BayerOffsetX, BayerOffsetY, BinX, BinY, CameraXSize, CameraYSize, IsCoolerOn, ExposureMax, ExposureMin, CanGetCoolerPower } = this.state
		const { Gain, GainMax, GainMin, Gains, MaxBinX, MaxBinY, NumX, NumY, Offset, OffsetMax, OffsetMin, Offsets, PixelSizeX, PixelSizeY, ReadoutMode, ReadoutModes, StartX, StartY, CanPulseGuide, CanSetCcdTemperature, CanStopExposure, SensorType } = this.state
		const { ExposureDuration, ExposureStarted, LastCameraState } = this.state

		// Initial
		if (Step === 1) {
			this.#info.elements.CCD_PIXEL_SIZE_X.value = PixelSizeX ?? 0
			this.#info.elements.CCD_PIXEL_SIZE_Y.value = PixelSizeY ?? 0
			this.#info.elements.CCD_MAX_X.value = CameraXSize!
			this.#info.elements.CCD_MAX_Y.value = CameraYSize!
			this.sendDefProperty(this.#info)

			this.#frame.elements.X.max = CameraXSize! - 1
			this.#frame.elements.X.value = StartX ?? 0
			this.#frame.elements.Y.max = CameraYSize! - 1
			this.#frame.elements.Y.value = StartY ?? 0
			this.#frame.elements.WIDTH.max = CameraXSize!
			this.#frame.elements.WIDTH.value = NumX ?? 0
			this.#frame.elements.HEIGHT.max = CameraYSize!
			this.#frame.elements.HEIGHT.value = NumY ?? 0
			this.sendDefProperty(this.#frame)

			if (CanStopExposure) {
				this.sendDefProperty(this.#abort)
			}

			if (ExposureMax) {
				this.#exposure.elements.CCD_EXPOSURE_VALUE.min = ExposureMin ?? 0
				this.#exposure.elements.CCD_EXPOSURE_VALUE.max = ExposureMax
				this.sendDefProperty(this.#exposure)
			}

			if (IsCoolerOn !== undefined) {
				this.updatePropertyValue(this.#cooler, IsCoolerOn ? 'COOLER_ON' : 'COOLER_OFF', true)
				this.sendDefProperty(this.#cooler)
			} else {
				this.disableEndpoints('IsCoolerOn')
			}

			if (CCDTemperature !== undefined) {
				this.#temperature.elements.CCD_TEMPERATURE_VALUE.value = CCDTemperature

				if (CanSetCcdTemperature) {
					this.#temperature.permission = 'rw'
				}

				this.sendDefProperty(this.#temperature)
			}

			if (CanGetCoolerPower && CoolerPower !== undefined) {
				this.#coolerPower.elements.CCD_COOLER_POWER.value = CoolerPower
				this.sendDefProperty(this.#coolerPower)
			}

			if (MaxBinX) {
				this.#bin.elements.HOR_BIN.max = MaxBinX
				this.#bin.elements.HOR_BIN.value = BinX ?? 1
				this.#bin.elements.VER_BIN.max = MaxBinY ?? MaxBinX
				this.#bin.elements.VER_BIN.value = BinY ?? BinX ?? 1
				this.sendDefProperty(this.#bin)
			} else {
				this.disableEndpoints('BinX', 'BinY')
			}

			if (Gain !== undefined) {
				if (Gains?.length) {
					// Index mode
					this.#gain.elements.GAIN.max = Gains.length - 1
					this.#gain.elements.GAIN.value = Gain
					this.sendDefProperty(this.#gain)
				} else if (GainMax) {
					// Value mode
					this.#gain.elements.GAIN.min = GainMin ?? 0
					this.#gain.elements.GAIN.max = GainMax
					this.#gain.elements.GAIN.value = Gain
					this.sendDefProperty(this.#gain)
				}
			} else {
				this.disableEndpoints('Gain')
			}

			if (Offset !== undefined) {
				if (Offsets?.length) {
					// Index mode
					this.#offset.elements.OFFSET.max = Offsets.length - 1
					this.#offset.elements.OFFSET.value = Offset
					this.sendDefProperty(this.#offset)
				} else if (OffsetMax) {
					// Value mode
					this.#offset.elements.OFFSET.min = OffsetMin ?? 0
					this.#offset.elements.OFFSET.max = OffsetMax
					this.#offset.elements.OFFSET.value = Offset
					this.sendDefProperty(this.#offset)
				}
			} else {
				this.disableEndpoints('Offset')
			}

			if (ReadoutModes?.length) {
				for (let i = 0; i < ReadoutModes.length; i++) {
					const name = `MODE_${i}`
					this.#frameFormat.elements[name] = { name, label: ReadoutModes[i], value: false }
				}

				this.#frameFormat.elements[`MODE_${ReadoutMode ?? 0}`].value = true
				this.sendDefProperty(this.#frameFormat)
			} else {
				this.disableEndpoints('ReadoutMode')
			}

			if (CanPulseGuide) {
				this.sendDefProperty(this.#guideNS)
				this.sendDefProperty(this.#guideWE)
			}

			// RGGB
			if (SensorType === 2) {
				this.#cfa.elements.CFA_OFFSET_X.value = BayerOffsetX?.toFixed(0) ?? '0'
				this.#cfa.elements.CFA_OFFSET_Y.value = BayerOffsetY?.toFixed(0) ?? '0'
				this.#cfa.elements.CFA_TYPE.value = 'RGGB'
				this.sendDefProperty(this.#cfa)
			}

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			if (IsCoolerOn !== undefined) {
				this.updatePropertyValue(this.#cooler, IsCoolerOn ? 'COOLER_ON' : 'COOLER_OFF', true) && this.sendSetProperty(this.#cooler)
				this.state.IsCoolerOn = undefined
			}

			if (CoolerPower !== undefined) {
				this.updatePropertyValue(this.#coolerPower, 'CCD_COOLER_POWER', CoolerPower) && this.sendSetProperty(this.#coolerPower)
			}

			if (Gain !== undefined) {
				this.updatePropertyValue(this.#gain, 'GAIN', Gain) && this.sendSetProperty(this.#gain)
				this.state.Gain = undefined
			}

			if (Offset !== undefined) {
				this.updatePropertyValue(this.#offset, 'OFFSET', Offset) && this.sendSetProperty(this.#offset)
				this.state.Offset = undefined
			}

			if (BinX !== undefined && BinY !== undefined) {
				let updated = this.updatePropertyValue(this.#bin, 'HOR_BIN', BinX)
				updated = this.updatePropertyValue(this.#bin, 'VER_BIN', BinY) || updated
				updated && this.sendSetProperty(this.#bin)
				this.state.BinX = undefined
				this.state.BinY = undefined
			}

			if (CCDTemperature !== undefined) {
				this.updatePropertyValue(this.#temperature, 'CCD_TEMPERATURE_VALUE', Math.trunc(CCDTemperature)) && this.sendSetProperty(this.#temperature)
			}

			if (StartX !== undefined || StartY !== undefined || NumX !== undefined || NumY !== undefined) {
				let updated = false
				if (StartX !== undefined) updated = this.updatePropertyValue(this.#frame, 'X', StartX)
				if (StartY !== undefined) updated = this.updatePropertyValue(this.#frame, 'Y', StartY) || updated
				if (NumX !== undefined) updated = this.updatePropertyValue(this.#frame, 'WIDTH', NumX) || updated
				if (NumY !== undefined) updated = this.updatePropertyValue(this.#frame, 'HEIGHT', NumY) || updated
				updated && this.sendSetProperty(this.#frame)
				this.state.StartX = undefined
				this.state.StartY = undefined
				this.state.NumX = undefined
				this.state.NumY = undefined
			}

			if (ReadoutMode !== undefined) {
				const name = `MODE_${ReadoutMode}`
				name in this.#frameFormat.elements && this.updatePropertyValue(this.#frameFormat, name, true) && this.sendSetProperty(this.#frameFormat)
				this.state.ReadoutMode = undefined
			}

			if (CanPulseGuide && this.updatePropertyState(this.#guideNS, IsPulseGuiding ? 'Busy' : 'Idle')) {
				this.#guideWE.state = this.#guideNS.state
				this.sendSetProperty(this.#guideNS)
				this.sendSetProperty(this.#guideWE)
			}

			if (ImageReady) {
				if (ExposureStarted) {
					void this.#handleImageReady()
					return true
				}
			} else {
				this.#image.elements.CCD1.value = undefined
			}

			if (ExposureStarted || CameraState === 2) {
				let updated = this.updatePropertyState(this.#exposure, 'Busy')
				updated = this.updatePropertyValue(this.#exposure, 'CCD_EXPOSURE_VALUE', ExposureDuration * (1 - PercentCompleted / 100)) || updated
				updated && this.sendSetProperty(this.#exposure)
			} else if ((CameraState === 5 || CameraState === 0) && LastCameraState !== CameraState) {
				let updated = this.updatePropertyState(this.#exposure, CameraState === 5 ? 'Alert' : 'Idle')
				updated = this.updatePropertyValue(this.#exposure, 'CCD_EXPOSURE_VALUE', 0) || updated
				updated && this.sendSetProperty(this.#exposure)
			}

			this.state.LastCameraState = CameraState
		}

		return true
	}

	// Handles camera switch commands (cooler on/off, readout-mode selection, abort, frame type).
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CCD_COOLER':
				if (vector.elements.COOLER_ON === true) void this.api.setCoolerOn(this.id, true)
				else if (vector.elements.COOLER_OFF === true) void this.api.setCoolerOn(this.id, false)
				else break
				this.enableEndpoints('IsCoolerOn')
				break
			case 'CCD_CAPTURE_FORMAT':
				if (this.state.ReadoutModes?.length) {
					for (let i = 0; i < this.state.ReadoutModes.length; i++) {
						const key = `MODE_${i}`

						if (vector.elements[key] === true) {
							void this.api.setReadoutMode(this.id, i)
							this.enableEndpoints('ReadoutMode')
							break
						}
					}
				}

				break
			case 'CCD_ABORT_EXPOSURE':
				if (vector.elements.ABORT === true) void this.api.stopExposure(this.id)
				break
			case 'CCD_FRAME_TYPE':
				for (const key in vector.elements) {
					if (key in this.#frameType.elements && vector.elements[key] === true) {
						this.updatePropertyValue(this.#frameType, key, true) && this.sendSetProperty(this.#frameType)
						break
					}
				}

				break
		}
	}

	// Handles camera number commands: starts/aborts exposures, sets gain/offset/temperature, subframe,
	// binning, and timed pulse-guide pulses. Guide durations are milliseconds.
	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'CCD_EXPOSURE':
				if (vector.elements.CCD_EXPOSURE_VALUE) {
					this.state.ExposureStarted = true
					this.state.ExposureDuration = Math.max(this.#exposure.elements.CCD_EXPOSURE_VALUE.min, Math.min(vector.elements.CCD_EXPOSURE_VALUE, this.#exposure.elements.CCD_EXPOSURE_VALUE.max))

					void this.api.startExposure(this.id, this.state.ExposureDuration, this.isLight).then(({ ok }) => {
						if (ok) {
							this.updatePropertyState(this.#exposure, 'Busy')
							this.updatePropertyValue(this.#exposure, 'CCD_EXPOSURE_VALUE', this.state.ExposureDuration)
						} else {
							this.state.ExposureStarted = false
							this.updatePropertyState(this.#exposure, 'Alert')
							this.updatePropertyValue(this.#exposure, 'CCD_EXPOSURE_VALUE', 0)
						}

						return this.sendSetProperty(this.#exposure)
					}, console.error)
				}

				break
			case 'CCD_GAIN':
				if (vector.elements.GAIN !== undefined) void this.api.setGain(this.id, vector.elements.GAIN)
				this.enableEndpoints('Gain')
				break
			case 'CCD_OFFSET':
				if (vector.elements.OFFSET !== undefined) void this.api.setOffset(this.id, vector.elements.OFFSET)
				this.enableEndpoints('Offset')
				break
			case 'CCD_TEMPERATURE':
				if (this.state.CanSetCcdTemperature && vector.elements.CCD_TEMPERATURE_VALUE !== undefined) {
					void this.api.setSetCcdTemperature(this.id, vector.elements.CCD_TEMPERATURE_VALUE)
				}

				break
			case 'CCD_FRAME':
				if (vector.elements.X !== undefined) void this.api.setStartX(this.id, vector.elements.X)
				if (vector.elements.Y !== undefined) void this.api.setStartY(this.id, vector.elements.Y)
				if (vector.elements.WIDTH !== undefined) void this.api.setNumX(this.id, vector.elements.WIDTH)
				if (vector.elements.HEIGHT !== undefined) void this.api.setNumY(this.id, vector.elements.HEIGHT)
				this.enableEndpoints('StartX', 'StartY', 'NumX', 'NumY')
				break
			case 'CCD_BINNING':
				if (vector.elements.HOR_BIN !== undefined) void this.api.setBinX(this.id, vector.elements.HOR_BIN)
				if (vector.elements.VER_BIN !== undefined) void this.api.setBinY(this.id, vector.elements.VER_BIN)
				this.enableEndpoints('BinX', 'BinY')
				break
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE': {
				if (this.state.CanPulseGuide) {
					const { TIMED_GUIDE_N, TIMED_GUIDE_S, TIMED_GUIDE_W, TIMED_GUIDE_E } = vector.elements

					if (vector.name.endsWith('S')) {
						if (TIMED_GUIDE_N || TIMED_GUIDE_S) {
							void this.api.pulseGuide(this.id, TIMED_GUIDE_N ? 0 : 1, TIMED_GUIDE_N || TIMED_GUIDE_S)
						} else if (TIMED_GUIDE_N === 0 || TIMED_GUIDE_S === 0) {
							void this.api.pulseGuide(this.id, TIMED_GUIDE_N ? 0 : 1, 0)
						}
					} else if (TIMED_GUIDE_W || TIMED_GUIDE_E) {
						void this.api.pulseGuide(this.id, TIMED_GUIDE_W ? 3 : 2, TIMED_GUIDE_W || TIMED_GUIDE_E)
					} else if (TIMED_GUIDE_W === 0 || TIMED_GUIDE_E === 0) {
						void this.api.pulseGuide(this.id, TIMED_GUIDE_W ? 3 : 2, 0)
					}
				}

				break
			}
		}
	}

	// Called when an exposure completes: downloads the image, emits it, and returns the exposure to Ok.
	async #handleImageReady() {
		this.#exposure.state = 'Busy'
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = 0
		this.sendSetProperty(this.#exposure)

		this.state.ExposureStarted = false
		await this.#readImageDataAsFits()

		this.#exposure.state = 'Ok'
		this.sendSetProperty(this.#exposure)
	}

	// Downloads the ImageBytes buffer, converts it to FITS (stamping camera/mount/etc. metadata), and
	// publishes it through the CCD1 BLOB property.
	async #readImageDataAsFits() {
		const buffer = await this.api.getImageArray(this.id)

		if (buffer.ok) {
			this.#image.state = 'Ok'
			const camera = this.client.provider.get(this.client, this.device.DeviceName, 'camera') as Camera
			const lastExposureDuration = this.state.ExposureDuration // await this.api.getLastExposureDuration(this.id)
			const fits = makeFitsFromImageBytes(buffer.value, this.#now, camera, this.activeMount, this.activeWheel, this.activeFocuser, this.activeRotator, lastExposureDuration)
			this.#image.elements.CCD1.value = fits
		} else {
			this.#image.state = 'Alert'
			this.#image.elements.CCD1.value = undefined
		}

		handleSetBlobVector(this.client, this.handler, this.#image)
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/inditelescope.cpp

// Polled mount state mirroring Alpaca telescope properties (capabilities, coordinates, tracking, park,
// pier side, site location, guide rates). Coordinates are stored in Alpaca units (RA hours, Dec degrees).
interface AlpacaClientTelescopeState extends AlpacaClientDeviceState {
	readonly CanHome: boolean
	readonly CanPark: boolean
	readonly CanMoveAxis: boolean
	readonly CanPulseGuide: boolean
	readonly CanTrack: boolean
	readonly CanSlew: boolean
	readonly CanSync: boolean
	readonly CanSetGuideRate: boolean
	readonly Tracking: boolean
	readonly AtPark: boolean
	readonly IsPulseGuiding: boolean
	readonly Slewing: boolean
	readonly RightAscension: number
	readonly Declination: number
	readonly SlewRates?: readonly AlpacaAxisRate[]
	readonly TrackingRates?: readonly AlpacaTelescopeTrackingRate[]
	TrackingRate?: AlpacaTelescopeTrackingRate
	readonly CanSetSideOfPier: boolean
	readonly SideOfPier?: AlpacaTelescopePierSide
	UTCDate?: string
	LastUTCDateUpdate: number
	Latitude?: number
	Longitude?: number
	Elevation?: number
	GuideRateRA?: number
	GuideRateDEC?: number
	EquatorialSystem: AlpacaTelescopeEquatorialCoordinateType
	LastRightAscension?: number
	LastDeclination?: number
}

// Mount device wrapper: exposes the standard INDI telescope properties (coordinates, slew/sync, tracking,
// motion, park/home, site/time, pier side, guiding) and maps polled Alpaca telescope state onto them.
// Converts between the mount's J2000/JNOW equatorial frames as needed.
class AlpacaTelescope extends AlpacaDevice {
	protected readonly api: AlpacaTelescopeApi
	// https://ascom-standards.org/newdocs/telescope.html#Telescope.DeviceState
	// oxfmt-ignore
	protected readonly state: AlpacaClientTelescopeState = { Connected: false, Step: 0, CanTrack: false, CanHome: false, CanPark: false, CanMoveAxis: false, CanPulseGuide: false, CanSlew: false, CanSync: false, CanSetGuideRate: false, CanSetSideOfPier: false, Tracking: false, AtPark: false, IsPulseGuiding: false, Slewing: false, RightAscension: 0, Declination: 0, LastUTCDateUpdate: 0, EquatorialSystem: 1 }
	protected readonly initialEndpoints = ['CanHome', 'CanPark', 'CanMoveAxis', 'CanPulseGuide', 'CanTrack', 'CanSlew', 'CanSync', 'CanSetGuideRate', 'SlewRates', 'TrackingRates', 'CanSetSideOfPier', 'EquatorialSystem'] as const
	protected readonly deviceStateEndpoints = ['AtPark', 'Declination', 'IsPulseGuiding', 'RightAscension', 'SideOfPier', 'Slewing', 'Tracking'] as const
	protected readonly runningEndpoints = ['TrackingRate', 'GuideRateRA', 'GuideRateDEC', 'Latitude', 'Longitude', 'Elevation', 'UTCDate'] as const

	readonly #onCoordSet = makeSwitchVector('', 'ON_COORD_SET', 'On Set', MAIN_CONTROL, 'OneOfMany', 'rw', ['SLEW', 'Slew', false], ['SYNC', 'Sync', false])
	readonly #equatorialCoordinate = makeNumberVector('', 'EQUATORIAL_EOD_COORD', 'Eq. Coordinates', MAIN_CONTROL, 'rw', ['RA', 'RA (hours)', 0, 0, 24, 0.1, '%10.6f'], ['DEC', 'DEC (deg)', 0, -90, 90, 0.1, '%10.6f'])
	readonly #abort = makeSwitchVector('', 'TELESCOPE_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #trackMode = makeSwitchVector('', 'TELESCOPE_TRACK_MODE', 'Track Mode', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_SIDEREAL', 'Sidereal', true], ['TRACK_SOLAR', 'Solar', false], ['TRACK_LUNAR', 'Lunar', false], ['TRACK_KING', 'King', false])
	readonly #tracking = makeSwitchVector('', 'TELESCOPE_TRACK_STATE', 'Tracking', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_ON', 'On', false], ['TRACK_OFF', 'Off', true])
	readonly #home = makeSwitchVector('', 'TELESCOPE_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['GO', 'Go', false])
	readonly #motionNS = makeSwitchVector('', 'TELESCOPE_MOTION_NS', 'Motion N/S', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_NORTH', 'North', false], ['MOTION_SOUTH', 'South', false])
	readonly #motionWE = makeSwitchVector('', 'TELESCOPE_MOTION_WE', 'Motion W/E', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_WEST', 'West', false], ['MOTION_EAST', 'East', false])
	readonly #slewRate = makeSwitchVector('', 'TELESCOPE_SLEW_RATE', 'Slew Rate', MAIN_CONTROL, 'OneOfMany', 'rw')
	readonly #time = makeTextVector('', 'TIME_UTC', 'UTC', MAIN_CONTROL, 'rw', ['UTC', 'UTC Time', formatTemporal(Date.now(), 'YYYY-MM-DDTHH:mm:ss.SSSZ')], ['OFFSET', 'UTC Offset', (TIMEZONE / 60).toFixed(2)])
	readonly #geographicCoordinate = makeNumberVector('', 'GEOGRAPHIC_COORD', 'Location', MAIN_CONTROL, 'rw', ['LAT', 'Latitude (deg)', 0, -90, 90, 0.1, '%12.8f'], ['LONG', 'Longitude (deg)', 0, 0, 360, 0.1, '%12.8f'], ['ELEV', 'Elevation (m)', 0, -200, 10000, 1, '%.1f'])
	readonly #park = makeSwitchVector('', 'TELESCOPE_PARK', 'Parking', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #pierSide = makeSwitchVector('', 'TELESCOPE_PIER_SIDE', 'Pier Side', MAIN_CONTROL, 'AtMostOne', 'ro', ['PIER_EAST', 'East', false], ['PIER_WEST', 'West', false])
	readonly #guideRate = makeNumberVector('', 'GUIDE_RATE', 'Guiding Rate', MAIN_CONTROL, 'ro', ['GUIDE_RATE_WE', 'W/E Rate', 0.5, 0, 1, 0.1, '%.8f'], ['GUIDE_RATE_NS', 'N/E Rate', 0.5, 0, 1, 0.1, '%.0f'])
	readonly #guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])

	readonly #now = timeNow() // Used in the conversion from J2000 to JNOW. Changes in precession/nutation angles are negligible.

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaTelescopeApi(client.url)

		this.#onCoordSet.device = device.DeviceName
		this.#equatorialCoordinate.device = device.DeviceName
		this.#abort.device = device.DeviceName
		this.#trackMode.device = device.DeviceName
		this.#tracking.device = device.DeviceName
		this.#home.device = device.DeviceName
		this.#motionNS.device = device.DeviceName
		this.#motionWE.device = device.DeviceName
		this.#slewRate.device = device.DeviceName
		this.#time.device = device.DeviceName
		this.#geographicCoordinate.device = device.DeviceName
		this.#park.device = device.DeviceName
		this.#pierSide.device = device.DeviceName
		this.#guideRate.device = device.DeviceName
		this.#guideNS.device = device.DeviceName
		this.#guideWE.device = device.DeviceName

		// The mount can be moved by hand when either axis accepts MoveAxis.
		async function canMoveAxis(id: number): Promise<AlpacaRequestResult<boolean>> {
			const primary = await api.canMoveAxis(id, 0)

			if (primary.ok && primary.value) return primary

			const secondary = await api.canMoveAxis(id, 1)

			// Report the first failure rather than a bogus false, so a transient fault is not mistaken for
			// a mount that cannot move.
			if (!primary.ok) return secondary.ok && secondary.value ? secondary : primary

			return secondary
		}

		this.registerEndpoint('CanHome', () => api.canFindHome(this.id), false)
		this.registerEndpoint('CanPark', () => api.canPark(this.id), false)
		this.registerEndpoint('CanMoveAxis', () => canMoveAxis(this.id), false)
		this.registerEndpoint('CanPulseGuide', () => api.canPulseGuide(this.id), false)
		this.registerEndpoint('CanTrack', () => api.canSetTracking(this.id), false)
		this.registerEndpoint('CanSlew', () => api.canSlew(this.id), false)
		this.registerEndpoint('CanSync', () => api.canSync(this.id), false)
		this.registerEndpoint('CanSetGuideRate', () => api.canSetGuideRates(this.id), false)
		this.registerEndpoint('SlewRates', () => api.getAxisRates(this.id, 0), false)
		this.registerEndpoint('TrackingRates', () => api.getTrackingRates(this.id), false)
		this.registerEndpoint('TrackingRate', () => api.getTrackingRate(this.id), false, 60)
		this.registerEndpoint('CanSetSideOfPier', () => api.canSetSideOfPier(this.id), false)
		this.registerEndpoint('Latitude', () => api.getSiteLatitude(this.id), false, 60)
		this.registerEndpoint('Longitude', () => api.getSiteLongitude(this.id), false, 60)
		this.registerEndpoint('Elevation', () => api.getSiteElevation(this.id), false, 60)
		this.registerEndpoint('GuideRateRA', () => api.getGuideRateRightAscension(this.id), false, 60)
		this.registerEndpoint('GuideRateDEC', () => api.getGuideRateDeclination(this.id), false, 60)
		this.registerEndpoint('AtPark', () => api.isAtPark(this.id), false)
		this.registerEndpoint('Declination', () => api.getDeclination(this.id), false)
		this.registerEndpoint('IsPulseGuiding', () => api.isPulseGuiding(this.id), false)
		this.registerEndpoint('RightAscension', () => api.getRightAscension(this.id), false)
		this.registerEndpoint('SideOfPier', () => api.getSideOfPier(this.id), false)
		this.registerEndpoint('Slewing', () => api.isSlewing(this.id), false)
		this.registerEndpoint('Tracking', () => api.isTracking(this.id), false)
		this.registerEndpoint('UTCDate', () => api.getUtcDate(this.id), false, 60)
		this.registerEndpoint('EquatorialSystem', () => api.getEquatorialSystem(this.id), false)

		this.api = api
	}

	// Reconciles polled mount state into the INDI telescope properties: capabilities, equatorial
	// coordinates (converted to JNOW), tracking mode/state, park/home, pier side, site location, UTC time,
	// and guide rates. Returns false until the device is fully initialized.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, CanTrack, CanHome, CanPark, CanSlew, CanSync, CanMoveAxis, CanPulseGuide, CanSetGuideRate, CanSetSideOfPier, Tracking, AtPark, IsPulseGuiding, Slewing } = this.state
		const { RightAscension, Declination, SlewRates, TrackingRates, TrackingRate, SideOfPier, UTCDate, Latitude, Longitude, Elevation, GuideRateRA, GuideRateDEC, EquatorialSystem } = this.state
		const { LastRightAscension, LastDeclination } = this.state

		// Initial
		if (Step === 1) {
			this.sendDefProperty(this.#equatorialCoordinate)
			this.sendDefProperty(this.#abort)

			if (!CanSync) delete this.#onCoordSet.elements.SYNC
			if (!CanSlew) delete this.#onCoordSet.elements.SLEW
			if (CanSlew || CanSync) this.sendDefProperty(this.#onCoordSet)
			if (CanHome) this.sendDefProperty(this.#home)
			if (CanPark) this.sendDefProperty(this.#park)
			if (CanTrack) this.sendDefProperty(this.#tracking)
			if (CanMoveAxis) {
				this.sendDefProperty(this.#motionNS)
				this.sendDefProperty(this.#motionWE)
			}
			if (CanPulseGuide) {
				if (GuideRateRA !== undefined && GuideRateDEC !== undefined) {
					if (CanSetGuideRate) {
						this.#guideRate.permission = 'rw'
					}

					this.#guideRate.elements.GUIDE_RATE_WE.value = roundToNthDecimal(GuideRateRA / (SIDEREAL_RATE / 3600), 6)
					this.#guideRate.elements.GUIDE_RATE_NS.value = roundToNthDecimal(GuideRateDEC / (SIDEREAL_RATE / 3600), 6)

					this.sendDefProperty(this.#guideRate)
				} else {
					this.disableEndpoints('GuideRateRA', 'GuideRateDEC')
				}

				this.sendDefProperty(this.#guideNS)
				this.sendDefProperty(this.#guideWE)
			}

			if (SlewRates?.length) {
				for (let i = 0; i < SlewRates.length; i++) {
					const name = `RATE_${i}`
					this.#slewRate.elements[name] = { name, label: `${SlewRates[i].Maximum.toPrecision(3)} deg/s`, value: i === 0 }
				}

				this.sendDefProperty(this.#slewRate)
				this.sendSetProperty(this.#slewRate)
			}

			if (TrackingRates?.length) {
				if (!TrackingRates.includes(0)) delete this.#trackMode.elements.TRACK_SIDEREAL
				if (!TrackingRates.includes(1)) delete this.#trackMode.elements.TRACK_LUNAR
				if (!TrackingRates.includes(2)) delete this.#trackMode.elements.TRACK_SOLAR
				if (!TrackingRates.includes(3)) delete this.#trackMode.elements.TRACK_KING
				this.sendDefProperty(this.#trackMode)
			} else {
				this.disableEndpoints('TrackingRate')
			}

			if (CanSetSideOfPier) {
				this.#pierSide.permission = 'rw'
			}

			if (UTCDate) {
				const now = Date.now()

				if (now - this.state.LastUTCDateUpdate >= 60000) {
					this.state.LastUTCDateUpdate = now
					this.#time.elements.UTC.value = UTCDate.slice(0, 19)
					this.sendDefProperty(this.#time)
				}
			}

			this.#geographicCoordinate.elements.LAT.value = Latitude ?? 0
			this.#geographicCoordinate.elements.LONG.value = Longitude ?? 0
			this.#geographicCoordinate.elements.ELEV.value = Elevation ?? 0
			this.sendDefProperty(this.#geographicCoordinate)

			this.sendDefProperty(this.#pierSide)

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			CanTrack && this.updatePropertyValue(this.#tracking, Tracking ? 'TRACK_ON' : 'TRACK_OFF', true) && this.sendSetProperty(this.#tracking)
			CanPark && this.updatePropertyValue(this.#park, AtPark ? 'PARK' : 'UNPARK', true) && this.sendSetProperty(this.#park)

			if (SideOfPier !== undefined) {
				if (SideOfPier === -1) {
					let updated = this.updatePropertyValue(this.#pierSide, 'PIER_EAST', false)
					updated = this.updatePropertyValue(this.#pierSide, 'PIER_WEST', false) || updated
					updated && this.sendSetProperty(this.#pierSide)
				} else {
					this.updatePropertyValue(this.#pierSide, SideOfPier === 0 ? 'PIER_EAST' : 'PIER_WEST', true) && this.sendSetProperty(this.#pierSide)
				}
			}

			if (CanPulseGuide && this.updatePropertyState(this.#guideNS, IsPulseGuiding ? 'Busy' : 'Idle')) {
				this.#guideWE.state = this.#guideNS.state
				this.sendSetProperty(this.#guideNS)
				this.sendSetProperty(this.#guideWE)
			}

			if (TrackingRate !== undefined) {
				this.updatePropertyValue(this.#trackMode, TrackingRate === 0 ? 'TRACK_SIDEREAL' : TrackingRate === 1 ? 'TRACK_LUNAR' : TrackingRate === 2 ? 'TRACK_SOLAR' : 'TRACK_KING', true) && this.sendSetProperty(this.#trackMode)
				this.state.TrackingRate = undefined
			}

			if (GuideRateRA !== undefined && GuideRateDEC !== undefined) {
				let updated = this.updatePropertyValue(this.#guideRate, 'GUIDE_RATE_WE', roundToNthDecimal(GuideRateRA / (SIDEREAL_RATE / 3600), 6))
				updated = this.updatePropertyValue(this.#guideRate, 'GUIDE_RATE_NS', roundToNthDecimal(GuideRateDEC / (SIDEREAL_RATE / 3600), 6)) || updated
				updated && this.sendSetProperty(this.#guideRate)
				this.state.GuideRateRA = undefined
				this.state.GuideRateDEC = undefined
			}

			if (Latitude !== undefined && Longitude !== undefined) {
				let updated = this.updatePropertyValue(this.#geographicCoordinate, 'LAT', Latitude)
				updated = this.updatePropertyValue(this.#geographicCoordinate, 'LONG', Longitude) || updated
				if (Elevation !== undefined) updated = this.updatePropertyValue(this.#geographicCoordinate, 'ELEV', Elevation) || updated
				updated && this.sendSetProperty(this.#geographicCoordinate)
				this.state.Latitude = undefined
				this.state.Longitude = undefined
				this.state.Elevation = undefined
			}

			if (UTCDate !== undefined) {
				this.#time.elements.UTC.value = UTCDate.slice(0, 19)
				this.sendSetProperty(this.#time)
				this.state.UTCDate = undefined
			}

			if (RightAscension !== LastRightAscension || Declination !== LastDeclination) {
				this.state.LastRightAscension = RightAscension
				this.state.LastDeclination = Declination

				let rightAscension = RightAscension
				let declination = Declination

				if (EquatorialSystem === 2) {
					;[rightAscension, declination] = equatorialFromJ2000(RightAscension, Declination, this.#now)
				}

				let updated = this.updatePropertyState(this.#equatorialCoordinate, Slewing ? 'Busy' : 'Idle')
				updated = this.updatePropertyValue(this.#equatorialCoordinate, 'RA', rightAscension) || updated
				updated = this.updatePropertyValue(this.#equatorialCoordinate, 'DEC', declination) || updated
				updated && this.sendSetProperty(this.#equatorialCoordinate)
			}
		}

		return true
	}

	// Handles mount switch commands: slew rate, slew/sync mode, abort, track mode/state, home, axis
	// motion, and park/unpark.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'TELESCOPE_SLEW_RATE': {
				if (this.state.SlewRates?.length) {
					const selected = findOnSwitch(vector)[0]
					selected && this.updatePropertyValue(this.#slewRate, selected, true) && this.sendSetProperty(this.#slewRate)
				}

				break
			}
			case 'TELESCOPE_MOTION_NS':
			case 'TELESCOPE_MOTION_WE': {
				if (this.state.CanMoveAxis && this.state.SlewRates?.length) {
					const { MOTION_NORTH, MOTION_SOUTH, MOTION_WEST, MOTION_EAST } = vector.elements
					const { Maximum } = this.state.SlewRates[+findOnSwitch(this.#slewRate)[0].slice(5)]

					if (vector.name.endsWith('S')) {
						if (MOTION_NORTH === true || MOTION_SOUTH === true) {
							void this.api.moveAxis(this.id, 1, MOTION_NORTH === true ? Maximum : -Maximum)
						} else if (MOTION_NORTH === false || MOTION_SOUTH === false) {
							void this.api.moveAxis(this.id, 1, 0)
						}
					} else if (MOTION_WEST === true || MOTION_EAST === true) {
						void this.api.moveAxis(this.id, 0, MOTION_WEST === true ? Maximum : -Maximum)
					} else if (MOTION_WEST === false || MOTION_EAST === false) {
						void this.api.moveAxis(this.id, 0, 0)
					}
				}

				break
			}
			case 'TELESCOPE_TRACK_STATE':
				if (this.state.CanTrack) {
					if (vector.elements.TRACK_ON === true) void this.api.setTracking(this.id, true)
					else if (vector.elements.TRACK_OFF === true) void this.api.setTracking(this.id, false)
				}

				break
			case 'TELESCOPE_TRACK_MODE':
				if (this.state.TrackingRates?.length) {
					if (vector.elements.TRACK_SIDEREAL === true && this.state.TrackingRates.includes(0)) void this.api.setTrackingRate(this.id, 0)
					else if (vector.elements.TRACK_LUNAR === true && this.state.TrackingRates.includes(1)) void this.api.setTrackingRate(this.id, 1)
					else if (vector.elements.TRACK_SOLAR === true && this.state.TrackingRates.includes(2)) void this.api.setTrackingRate(this.id, 2)
					else if (vector.elements.TRACK_KING === true && this.state.TrackingRates.includes(3)) void this.api.setTrackingRate(this.id, 3)
					else break
					this.enableEndpoints('TrackingRate')
				}

				break
			case 'TELESCOPE_PARK':
				if (this.state.CanPark) {
					if (vector.elements.PARK === true) void this.api.park(this.id)
					else if (vector.elements.UNPARK === true) void this.api.unpark(this.id)
				}

				break
			case 'TELESCOPE_HOME':
				if (this.state.CanHome && vector.elements.GO === true) void this.api.findHome(this.id)
				break
			case 'TELESCOPE_ABORT_MOTION':
				if (vector.elements.ABORT === true) void this.api.abortSlew(this.id)
				break
			case 'TELESCOPE_PIER_SIDE':
				if (this.state.CanSetSideOfPier) {
					if (vector.elements.PIER_EAST === true) void this.api.setSideOfPier(this.id, 0)
					else if (vector.elements.PIER_WEST === true) void this.api.setSideOfPier(this.id, 1)
				}

				break
			case 'ON_COORD_SET':
				if (vector.elements.SLEW === true || vector.elements.TRACK === true) this.updatePropertyValue(this.#onCoordSet, 'SLEW', true)
				else if (vector.elements.SYNC === true) this.updatePropertyValue(this.#onCoordSet, 'SYNC', true)
				else break
				this.sendSetProperty(this.#onCoordSet)
				break
		}
	}

	// Handles mount number commands: slew/sync to equatorial target, timed pulse guiding (milliseconds),
	// guide-rate changes, and site location/elevation updates.
	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'EQUATORIAL_EOD_COORD':
				if (vector.elements.RA !== undefined || vector.elements.DEC !== undefined) {
					void this.#moveToTarget(vector.elements.RA, vector.elements.DEC)
				}

				break
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE': {
				if (this.state.CanPulseGuide) {
					const { TIMED_GUIDE_N, TIMED_GUIDE_S, TIMED_GUIDE_W, TIMED_GUIDE_E } = vector.elements

					if (vector.name.endsWith('S')) {
						if (TIMED_GUIDE_N || TIMED_GUIDE_S) {
							void this.api.pulseGuide(this.id, TIMED_GUIDE_N ? 0 : 1, TIMED_GUIDE_N || TIMED_GUIDE_S)
						} else if (TIMED_GUIDE_N === 0 || TIMED_GUIDE_S === 0) {
							void this.api.pulseGuide(this.id, TIMED_GUIDE_N ? 0 : 1, 0)
						}
					} else if (TIMED_GUIDE_W || TIMED_GUIDE_E) {
						void this.api.pulseGuide(this.id, TIMED_GUIDE_W ? 3 : 2, TIMED_GUIDE_W || TIMED_GUIDE_E)
					} else if (TIMED_GUIDE_W === 0 || TIMED_GUIDE_E === 0) {
						void this.api.pulseGuide(this.id, TIMED_GUIDE_W ? 3 : 2, 0)
					}
				}

				break
			}
			case 'GEOGRAPHIC_COORD':
				if (vector.elements.LAT !== undefined && vector.elements.LONG !== undefined) {
					void this.api.setSiteLatitude(this.id, vector.elements.LAT)
					void this.api.setSiteLongitude(this.id, normalizeLongitude(vector.elements.LONG))
					vector.elements.ELEV !== undefined && void this.api.setSiteElevation(this.id, vector.elements.ELEV)
					this.enableEndpoints('Latitude', 'Longitude', 'Elevation')
				}

				break
			case 'GUIDE_RATE':
				if (this.state.CanSetGuideRate) {
					// Guide rate in deg/second
					vector.elements.GUIDE_RATE_WE && void this.api.setGuideRateRightAscension(this.id, vector.elements.GUIDE_RATE_WE * (SIDEREAL_RATE / 3600))
					vector.elements.GUIDE_RATE_NS && void this.api.setGuideRateDeclination(this.id, vector.elements.GUIDE_RATE_NS * (SIDEREAL_RATE / 3600))
					this.enableEndpoints('GuideRateRA', 'GuideRateDEC')
				}

				break
		}
	}

	// Handles mount text commands: sets the mount's UTC date/time and offset.
	sendText(vector: NewTextVector) {
		super.sendText(vector)

		switch (vector.name) {
			case 'TIME_UTC':
				if (vector.elements.UTC && vector.elements.UTC.length >= 19) {
					this.updatePropertyValue(this.#time, 'OFFSET', vector.elements.OFFSET)
					const utc = vector.elements.UTC.slice(0, 19)
					void this.api.setUtcDate(this.id, `${utc}Z`)
					this.state.LastUTCDateUpdate = 0
					this.enableEndpoints('UTCDate')
				}

				break
		}
	}

	close() {}

	// Slews or syncs to the requested equatorial target (RA hours, Dec degrees). Converts JNOW input to
	// J2000 when the mount reports a JNOW equatorial system; the slew/sync choice follows ON_COORD_SET.
	async #moveToTarget(rightAscension?: number, declination?: number) {
		if (rightAscension !== undefined && declination !== undefined) {
			if (this.state.EquatorialSystem === 2) [rightAscension, declination] = equatorialToJ2000(rightAscension, declination, this.#now)
			if (this.#onCoordSet.elements.SLEW?.value === true) await this.api.slewToCoordinatesAsync(this.id, rightAscension, declination)
			else if (this.#onCoordSet.elements.SYNC?.value === true) await this.api.syncToCoordinates(this.id, rightAscension, declination)
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indifilterinterface.cpp

// Polled filter-wheel state: current slot (0-based, -1 while moving) and the slot names.
interface AlpacaClientFilterWheelState extends AlpacaClientDeviceState {
	readonly Position: number
	readonly Names?: string[]
}

// Filter-wheel device wrapper: exposes INDI FILTER_SLOT/FILTER_NAME and maps slot position (Alpaca is
// 0-based; INDI is 1-based) and names from polled state.
class AlpacaFilterWheel extends AlpacaDevice {
	readonly #position = makeNumberVector('', 'FILTER_SLOT', 'Position', MAIN_CONTROL, 'rw', ['FILTER_SLOT_VALUE', 'Slot', 1, 1, 1, 1, '%.0f'])
	readonly #names = makeTextVector('', 'FILTER_NAME', 'Filter', MAIN_CONTROL, 'ro')

	protected readonly api: AlpacaFilterWheelApi
	// https://ascom-standards.org/newdocs/filterwheel.html#FilterWheel.DeviceState
	protected readonly state: AlpacaClientFilterWheelState = { Connected: false, DeviceState: undefined, Step: 0, Position: 0, Names: undefined }
	protected readonly initialEndpoints = ['Names'] as const
	protected readonly deviceStateEndpoints = ['Position'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaFilterWheelApi(client.url)

		this.#position.device = device.DeviceName
		this.#names.device = device.DeviceName

		this.registerEndpoint('Names', () => api.getNames(this.id), false)
		this.registerEndpoint('Position', () => api.getPosition(this.id), false)

		this.api = api
	}

	// Defines the slot/name properties once names are known (step 1), then publishes the current slot
	// (converted to 1-based, Busy while the wheel is moving) each tick. Returns false until initialized.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, Position, Names } = this.state

		// Initial
		if (Step === 1) {
			if (Names?.length) {
				this.#position.elements.FILTER_SLOT_VALUE.max = Names.length

				for (let i = 0, p = 1; i < Names.length; i++, p++) {
					const name = `FILTER_SLOT_NAME_${p}`
					this.#names.elements[name] = { name, label: `Filter ${p}`, value: Names[i] }
				}

				this.sendDefProperty(this.#names)
				this.sendDefProperty(this.#position)
			}

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			let updated = this.updatePropertyState(this.#position, Position === -1 ? 'Busy' : 'Idle')
			if (Position >= 0) updated = this.updatePropertyValue(this.#position, 'FILTER_SLOT_VALUE', Position + 1) || updated
			updated && this.sendSetProperty(this.#position)
		}

		return true
	}

	// Handles the slot-selection command, converting the 1-based INDI slot back to Alpaca's 0-based index.
	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'FILTER_SLOT':
				void this.api.setPosition(this.id, vector.elements.FILTER_SLOT_VALUE - 1)
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indifocuserinterface.cpp

// Polled focuser state: motion flag, current position (steps), optional temperature, absolute-vs-relative
// capability, and travel range.
interface AlpacaClientFocuserState extends AlpacaClientDeviceState {
	readonly IsMoving: boolean
	readonly Position: number
	readonly Temperature?: number
	readonly IsAbsolute: boolean
	readonly MaxStep: number
}

// Focuser device wrapper: exposes INDI absolute/relative position, direction, temperature, and abort,
// adapting relative moves on absolute-only Alpaca focusers.
class AlpacaFocuser extends AlpacaDevice {
	readonly #absolutePosition = makeNumberVector('', 'ABS_FOCUS_POSITION', 'Absolute Position', MAIN_CONTROL, 'rw', ['FOCUS_ABSOLUTE_POSITION', 'Position', 0, 0, 0, 1, '%.0f'])
	readonly #relativePosition = makeNumberVector('', 'REL_FOCUS_POSITION', 'Relative Position', MAIN_CONTROL, 'rw', ['FOCUS_RELATIVE_POSITION', 'Steps', 0, 0, 0, 1, '%.0f'])
	readonly #temperature = makeNumberVector('', 'FOCUS_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'ro', ['TEMPERATURE', 'Temperature', 0, -50, 70, 0.1, '%6.2f'])
	readonly #abort = makeSwitchVector('', 'FOCUS_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #direction = makeSwitchVector('', 'FOCUS_MOTION', 'Direction', MAIN_CONTROL, 'OneOfMany', 'rw', ['FOCUS_INWARD', 'In', true], ['FOCUS_OUTWARD', 'Out', false])

	#position = this.#absolutePosition

	protected readonly api: AlpacaFocuserApi
	// https://ascom-standards.org/newdocs/focuser.html#Focuser.DeviceState
	protected readonly state: AlpacaClientFocuserState = { Connected: false, DeviceState: undefined, Step: 0, IsMoving: false, Position: 0, Temperature: undefined, IsAbsolute: false, MaxStep: 0 }
	protected readonly initialEndpoints = ['MaxStep', 'IsAbsolute'] as const
	protected readonly deviceStateEndpoints = ['IsMoving', 'Position', 'Temperature'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaFocuserApi(client.url)

		this.#absolutePosition.device = device.DeviceName
		this.#relativePosition.device = device.DeviceName
		this.#temperature.device = device.DeviceName
		this.#abort.device = device.DeviceName
		this.#direction.device = device.DeviceName

		this.registerEndpoint('Temperature', () => api.getTemperature(this.id), false)
		this.registerEndpoint('IsAbsolute', () => api.isAbsolute(this.id), false)
		this.registerEndpoint('MaxStep', () => api.getMaxStep(this.id), false)
		this.registerEndpoint('Position', () => api.getPosition(this.id), false)
		this.registerEndpoint('IsMoving', () => api.isMoving(this.id), false)

		this.api = api
	}

	// True when the active position property is the absolute one.
	get isAbsolute() {
		return this.#position === this.#absolutePosition
	}

	// True when the selected relative-move direction is inward.
	get isFocusIn() {
		return this.#direction.elements.FOCUS_INWARD.value === true
	}

	// True when the selected relative-move direction is outward.
	get isFocusOut() {
		return this.#direction.elements.FOCUS_OUTWARD.value === true
	}

	// Defines the position/direction/temperature/abort properties (choosing absolute vs relative from the
	// device's capability) at step 1, then publishes position (Busy while moving) and temperature each
	// tick. Returns false until initialized.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, IsAbsolute, IsMoving, Position, Temperature, MaxStep } = this.state

		// Initial
		if (Step === 1) {
			if (MaxStep) {
				if (IsAbsolute) {
					this.#absolutePosition.elements.FOCUS_ABSOLUTE_POSITION.max = MaxStep
					this.#position = this.#absolutePosition
				} else {
					this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.max = MaxStep
					this.#position = this.#relativePosition
				}

				this.sendDefProperty(this.#position)
			}

			if (Temperature !== undefined) {
				this.#temperature.elements.TEMPERATURE.value = Math.trunc(Temperature)
				this.sendDefProperty(this.#temperature)
			}

			this.sendDefProperty(this.#direction)
			this.sendDefProperty(this.#abort)

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			let updated = this.updatePropertyState(this.#position, IsMoving ? 'Busy' : 'Idle')
			if (IsAbsolute) updated = this.updatePropertyValue(this.#position, 'FOCUS_ABSOLUTE_POSITION', Position) || updated
			updated && this.sendSetProperty(this.#position)

			if (Temperature !== undefined) {
				this.updatePropertyValue(this.#temperature, 'TEMPERATURE', Math.trunc(Temperature)) && this.sendSetProperty(this.#temperature)
			}
		}

		return true
	}

	// Handles focuser switch commands: abort motion and select the relative-move direction.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'FOCUS_ABORT_MOTION':
				if (vector.elements.ABORT === true) void this.api.halt(this.id)
				break
			case 'FOCUS_MOTION':
				if (vector.elements.FOCUS_INWARD === true) this.updatePropertyValue(this.#direction, 'FOCUS_INWARD', true)
				else if (vector.elements.FOCUS_OUTWARD === true) this.updatePropertyValue(this.#direction, 'FOCUS_OUTWARD', true)
				break
		}
	}

	// Handles focuser move commands: relative steps (signed by direction) on relative focusers, or an
	// absolute target on absolute focusers.
	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'REL_FOCUS_POSITION':
				if (!this.isAbsolute) void this.api.move(this.id, this.isFocusOut ? vector.elements.FOCUS_RELATIVE_POSITION : -vector.elements.FOCUS_RELATIVE_POSITION)
				break
			case 'ABS_FOCUS_POSITION':
				if (this.isAbsolute) void this.api.move(this.id, vector.elements.FOCUS_ABSOLUTE_POSITION)
				break
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indidustcapinterface.cpp
// https://github.com/indilib/indi/blob/master/libs/indibase/indilightboxinterface.cpp

// Polled cover-calibrator state: cover open/close state and motion, calibrator state, and brightness.
interface AlpacaClientCoverCalibratorState extends AlpacaClientDeviceState {
	readonly CoverState: number
	readonly CoverMoving: boolean
	readonly CalibratorState: number
	readonly Brightness: number
	readonly MaxBrightness?: number
}

// Cover-calibrator (dust cap + flat panel) device wrapper: exposes INDI light/brightness and cap
// park/abort properties, mapping the Alpaca cover and calibrator states onto them.
class AlpacaCoverCalibrator extends AlpacaDevice {
	protected readonly api: AlpacaCoverCalibratorApi

	readonly #light = makeSwitchVector('', 'FLAT_LIGHT_CONTROL', 'Light', MAIN_CONTROL, 'OneOfMany', 'rw', ['FLAT_LIGHT_ON', 'On', false], ['FLAT_LIGHT_OFF', 'Off', true])
	readonly #brightness = makeNumberVector('', 'FLAT_LIGHT_INTENSITY', 'Brightness', MAIN_CONTROL, 'rw', ['FLAT_LIGHT_INTENSITY_VALUE', 'Brightness', 0, 0, 0, 1, '%.0f'])
	readonly #park = makeSwitchVector('', 'CAP_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #abort = makeSwitchVector('', 'CAP_ABORT', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	// https://ascom-standards.org/newdocs/covercalibrator.html#CoverCalibrator.DeviceState
	protected readonly state: AlpacaClientCoverCalibratorState = { Connected: false, DeviceState: undefined, Step: 0, CoverState: 0, CoverMoving: false, CalibratorState: 0, Brightness: 0, MaxBrightness: undefined }
	protected readonly initialEndpoints = ['MaxBrightness'] as const
	protected readonly deviceStateEndpoints = ['Brightness', 'CalibratorState', 'CoverMoving', 'CoverState'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaCoverCalibratorApi(client.url)

		this.#light.device = device.DeviceName
		this.#brightness.device = device.DeviceName
		this.#park.device = device.DeviceName
		this.#abort.device = device.DeviceName

		this.registerEndpoint('MaxBrightness', () => api.getMaxBrightness(this.id), false)
		this.registerEndpoint('Brightness', () => api.getBrightness(this.id), false)
		// this.registerEndpoint('CalibratorChanging', () => api.isChanging(this.id), false)
		this.registerEndpoint('CalibratorState', () => api.getCalibratorState(this.id), false)
		this.registerEndpoint('CoverMoving', () => api.isMoving(this.id), false)
		this.registerEndpoint('CoverState', () => api.getCoverState(this.id), false)

		this.api = api
	}

	// Detects whether the device is a cover, a calibrator, or both, defines the matching properties at
	// step 1 (adjusting DRIVER_INTERFACE), then publishes cover park state and calibrator on/off and
	// brightness each tick. Alpaca state codes: 0 not present, 1 closed/off, 2 moving, 3 open/on.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, CoverState, CoverMoving, CalibratorState, Brightness, MaxBrightness } = this.state

		// Initial
		if (Step === 1) {
			// 0 = Not present, 1 = Closed/Off, 3 = Open/On
			const hasCover = CoverState !== 0
			const hasCalibrator = CalibratorState !== 0

			if (hasCover !== hasCalibrator) {
				if (hasCover) {
					this.driverInfo.elements.DRIVER_INTERFACE.value = '512'
				} else {
					this.driverInfo.elements.DRIVER_INTERFACE.value = '1024'
				}

				this.sendDefProperty(this.driverInfo)
			}

			if (hasCover) {
				this.sendDefProperty(this.#park)
				this.sendDefProperty(this.#abort)
			}

			if (hasCalibrator) {
				if (MaxBrightness) {
					this.sendDefProperty(this.#light)
					this.#brightness.elements.FLAT_LIGHT_INTENSITY_VALUE.max = MaxBrightness
					this.sendDefProperty(this.#brightness)
				}
			}

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			if (CoverState !== 0) {
				let updated = this.updatePropertyState(this.#park, CoverState === 2 || CoverMoving ? 'Busy' : 'Idle')
				if (CoverState === 1 || CoverState === 2) updated = this.updatePropertyValue(this.#park, CoverState === 1 ? 'PARK' : 'UNPARK', true) || updated
				updated && this.sendSetProperty(this.#park)
			}

			if (CalibratorState !== 0) {
				if (CalibratorState === 3) {
					this.updatePropertyValue(this.#light, 'FLAT_LIGHT_ON', true) && this.sendSetProperty(this.#light)
					this.updatePropertyValue(this.#brightness, 'FLAT_LIGHT_INTENSITY_VALUE', Brightness) && this.sendSetProperty(this.#brightness)
				} else if (CalibratorState === 1) {
					this.updatePropertyValue(this.#light, 'FLAT_LIGHT_OFF', true) && this.sendSetProperty(this.#light)
				}
			}
		}

		return true
	}

	// Handles cover-calibrator switch commands: abort cover motion, park/unpark (close/open) the cover, and
	// turn the calibrator light on/off.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CAP_ABORT':
				if (vector.elements.ABORT === true) void this.api.halt(this.id)
				break
			case 'CAP_PARK':
				if (vector.elements.PARK === true) void this.api.close(this.id)
				else if (vector.elements.UNPARK === true) void this.api.open(this.id)
				break
			case 'FLAT_LIGHT_CONTROL':
				if (vector.elements.FLAT_LIGHT_ON === true) void this.api.on(this.id, Math.max(1, this.#brightness.elements.FLAT_LIGHT_INTENSITY_VALUE.value))
				else if (vector.elements.FLAT_LIGHT_OFF === true) void this.api.off(this.id)
				break
		}
	}

	// Handles the calibrator brightness command: positive values turn the light on at that level, zero off.
	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'FLAT_LIGHT_INTENSITY':
				if (vector.elements.FLAT_LIGHT_INTENSITY_VALUE > 0) void this.api.on(this.id, vector.elements.FLAT_LIGHT_INTENSITY_VALUE)
				else void this.api.off(this.id)
				break
		}
	}
}

// https://github.com/indilib/indi/blob/master/libs/indibase/indirotatorinterface.cpp

// Polled rotator state: motion flag, mechanical angle (degrees), and reverse capability/state.
interface AlpacaClientRotatorState extends AlpacaClientDeviceState {
	readonly IsMoving: boolean
	readonly Position: number
	readonly CanReverse: boolean
	readonly IsReverse: boolean
}

// Rotator device wrapper: exposes INDI goto/sync angle, reverse, and abort, mapping the polled rotator
// position (degrees) and reverse flag.
class AlpacaRotator extends AlpacaDevice {
	protected readonly api: AlpacaRotatorApi

	readonly #angle = makeNumberVector('', 'ABS_ROTATOR_ANGLE', 'Goto', MAIN_CONTROL, 'rw', ['ANGLE', 'Angle', 0, 0, 360, 0.01, '%.2f'])
	readonly #reverse = makeSwitchVector('', 'ROTATOR_REVERSE', 'Reverse', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #abort = makeSwitchVector('', 'ROTATOR_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #sync = makeNumberVector('', 'SYNC_ROTATOR_ANGLE', 'Sync', MAIN_CONTROL, 'rw', ['ANGLE', 'Angle', 0, 0, 360, 0.01, '%.2f'])

	// https://ascom-standards.org/newdocs/rotator.html#Rotator.DeviceState
	protected readonly state: AlpacaClientRotatorState = { Connected: false, DeviceState: undefined, Step: 0, IsMoving: false, Position: 0, CanReverse: false, IsReverse: false }
	protected readonly initialEndpoints = ['CanReverse'] as const
	protected readonly deviceStateEndpoints = ['IsMoving', 'Position'] as const
	protected readonly runningEndpoints = ['IsReverse'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaRotatorApi(client.url)

		this.#angle.device = device.DeviceName
		this.#reverse.device = device.DeviceName
		this.#abort.device = device.DeviceName
		this.#sync.device = device.DeviceName

		this.registerEndpoint('IsMoving', () => api.isMoving(this.id), false)
		this.registerEndpoint('Position', () => api.getPosition(this.id), false)
		this.registerEndpoint('CanReverse', () => api.canReverse(this.id), false)
		this.registerEndpoint('IsReverse', () => api.isReverse(this.id), false, 60)

		this.api = api
	}

	// Defines the goto/abort/sync/reverse properties at step 1, then publishes the mechanical angle (Busy
	// while moving) and reverse state each tick. Returns false until initialized.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, IsMoving, Position, CanReverse, IsReverse } = this.state

		// Initial
		if (Step === 1) {
			this.sendDefProperty(this.#angle)
			this.sendDefProperty(this.#abort)
			this.sendDefProperty(this.#sync)

			if (CanReverse) {
				this.updatePropertyValue(this.#reverse, IsReverse ? 'INDI_ENABLED' : 'INDI_DISABLED', true)
				this.sendDefProperty(this.#reverse)
			}

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			let updated = this.updatePropertyState(this.#angle, IsMoving ? 'Busy' : 'Idle')
			updated = this.updatePropertyValue(this.#angle, 'ANGLE', Position) || updated
			updated && this.sendSetProperty(this.#angle)

			this.state.CanReverse && IsReverse !== undefined && this.updatePropertyValue(this.#reverse, IsReverse ? 'INDI_ENABLED' : 'INDI_DISABLED', true) && this.sendSetProperty(this.#reverse)
		}

		return true
	}

	// Handles rotator switch commands: toggle reverse direction and abort motion.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'ROTATOR_REVERSE':
				if (!this.state.CanReverse) break
				if (vector.elements.INDI_ENABLED === true) void this.api.setReverse(this.id, true)
				if (vector.elements.INDI_DISABLED === true) void this.api.setReverse(this.id, false)
				this.enableEndpoints('IsReverse')
				break
			case 'ROTATOR_ABORT_MOTION':
				if (vector.elements.ABORT === true) void this.api.halt(this.id)
				break
		}
	}

	// Handles rotator number commands: absolute goto and sync to a mechanical angle (degrees).
	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'ABS_ROTATOR_ANGLE':
				if (vector.elements.ANGLE !== undefined) void this.api.moveAbsolute(this.id, vector.elements.ANGLE)
				break
			case 'SYNC_ROTATOR_ANGLE':
				if (vector.elements.ANGLE !== undefined) void this.api.sync(this.id, vector.elements.ANGLE)
				break
		}
	}
}

// Polled Alpaca Dome state, with optional values for properties that the device does not expose.
interface AlpacaClientDomeState extends AlpacaClientDeviceState {
	readonly Altitude?: number
	readonly AtHome?: boolean
	readonly AtPark?: boolean
	readonly Azimuth?: number
	readonly CanFindHome: boolean
	readonly CanPark: boolean
	readonly CanSetAltitude: boolean
	readonly CanSetAzimuth: boolean
	readonly CanSetPark: boolean
	readonly CanSetShutter: boolean
	readonly CanSlave: boolean
	readonly CanSyncAzimuth: boolean
	readonly ShutterStatus?: AlpacaDomeShutterState
	readonly Slaved?: boolean
	readonly Slewing: boolean
}

// Alpaca Dome wrapper: conditionally publishes INDI dome vectors and routes them to REST operations.
class AlpacaDome extends AlpacaDevice {
	protected readonly api: AlpacaDomeApi

	readonly #angle = makeNumberVector('', 'ABS_DOME_POSITION', 'Azimuth', MAIN_CONTROL, 'rw', ['DOME_ABSOLUTE_POSITION', 'Degrees', 0, 0, 360, 0.01, '%.2f'])
	readonly #altitude = makeNumberVector('', 'DOME_ALTITUDE', 'Altitude', MAIN_CONTROL, 'rw', ['DOME_ALTITUDE_VALUE', 'Degrees', 0, 0, 90, 0.01, '%.2f'])
	readonly #goto = makeSwitchVector('', 'DOME_GOTO', 'Home', MAIN_CONTROL, 'OneOfMany', 'rw', ['DOME_HOME', 'Home', false])
	readonly #park = makeSwitchVector('', 'DOME_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false])
	readonly #parkOption = makeSwitchVector('', 'DOME_PARK_OPTION', 'Park option', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK_CURRENT', 'Park current position', false])
	readonly #shutter = makeSwitchVector('', 'DOME_SHUTTER', 'Shutter', MAIN_CONTROL, 'OneOfMany', 'rw', ['SHUTTER_OPEN', 'Open', false], ['SHUTTER_CLOSE', 'Close', true])
	readonly #autoSync = makeSwitchVector('', 'DOME_AUTOSYNC', 'Slaved', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #sync = makeNumberVector('', 'DOME_SYNC', 'Sync', MAIN_CONTROL, 'rw', ['DOME_SYNC_VALUE', 'Degrees', 0, 0, 360, 0.01, '%.2f'])
	readonly #abort = makeSwitchVector('', 'DOME_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	protected readonly state: AlpacaClientDomeState = { Connected: false, DeviceState: undefined, Step: 0, CanFindHome: false, CanPark: false, CanSetAltitude: false, CanSetAzimuth: false, CanSetPark: false, CanSetShutter: false, CanSlave: false, CanSyncAzimuth: false, Slewing: false }
	protected readonly initialEndpoints = ['CanFindHome', 'CanPark', 'CanSetAltitude', 'CanSetAzimuth', 'CanSetPark', 'CanSetShutter', 'CanSlave', 'CanSyncAzimuth'] as const
	protected readonly deviceStateEndpoints = ['Altitude', 'AtHome', 'AtPark', 'Azimuth', 'ShutterStatus', 'Slewing'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaDomeApi(client.url)
		this.#angle.device = device.DeviceName
		this.#altitude.device = device.DeviceName
		this.#goto.device = device.DeviceName
		this.#park.device = device.DeviceName
		this.#parkOption.device = device.DeviceName
		this.#shutter.device = device.DeviceName
		this.#autoSync.device = device.DeviceName
		this.#sync.device = device.DeviceName
		this.#abort.device = device.DeviceName

		this.registerEndpoint('Altitude', () => api.getAltitude(this.id), false)
		this.registerEndpoint('AtHome', () => api.isAtHome(this.id), false)
		this.registerEndpoint('AtPark', () => api.isAtPark(this.id), false)
		this.registerEndpoint('Azimuth', () => api.getAzimuth(this.id), false)
		this.registerEndpoint('CanFindHome', () => api.canFindHome(this.id), false)
		this.registerEndpoint('CanPark', () => api.canPark(this.id), false)
		this.registerEndpoint('CanSetAltitude', () => api.canSetAltitude(this.id), false)
		this.registerEndpoint('CanSetAzimuth', () => api.canSetAzimuth(this.id), false)
		this.registerEndpoint('CanSetPark', () => api.canSetPark(this.id), false)
		this.registerEndpoint('CanSetShutter', () => api.canSetShutter(this.id), false)
		this.registerEndpoint('CanSlave', () => api.canSlave(this.id), false)
		this.registerEndpoint('CanSyncAzimuth', () => api.canSyncAzimuth(this.id), false)
		this.registerEndpoint('ShutterStatus', () => api.getShutterStatus(this.id), false)
		this.registerEndpoint('Slaved', () => api.isSlaved(this.id), false)
		this.registerEndpoint('Slewing', () => api.isSlewing(this.id), false)

		this.api = api
	}

	// Defines supported vectors after capability discovery and publishes all operational state updates.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, Azimuth, Altitude, AtHome, AtPark, CanFindHome, CanPark, CanSetAltitude, CanSetAzimuth, CanSetPark, CanSetShutter, CanSlave, CanSyncAzimuth, ShutterStatus, Slaved, Slewing } = this.state

		if (Step === 1) {
			if (Azimuth !== undefined) {
				this.#angle.permission = CanSetAzimuth ? 'rw' : 'ro'
				this.sendDefProperty(this.#angle)
			}
			if (Altitude !== undefined) {
				this.#altitude.permission = CanSetAltitude ? 'rw' : 'ro'
				this.sendDefProperty(this.#altitude)
			}
			if (CanFindHome) this.sendDefProperty(this.#goto)
			if (CanPark) this.sendDefProperty(this.#park)
			if (CanSetPark) this.sendDefProperty(this.#parkOption)
			if (CanSetShutter) this.sendDefProperty(this.#shutter)
			if (CanSlave) this.sendDefProperty(this.#autoSync)
			if (CanSyncAzimuth) this.sendDefProperty(this.#sync)
			this.sendDefProperty(this.#abort)
			if (CanSlave) this.enableEndpoints('Slaved')
			else this.disableEndpoints('Slaved')

			this.disableEndpoints(...this.initialEndpoints)
			this.state.Step = 2
		} else if (Step === 2) {
			if (this.properties.has(this.#angle)) {
				let updated = this.updatePropertyState(this.#angle, Slewing ? 'Busy' : 'Idle')
				updated = this.updatePropertyValue(this.#angle, 'DOME_ABSOLUTE_POSITION', Azimuth) || updated
				updated && this.sendSetProperty(this.#angle)
			}

			if (this.properties.has(this.#altitude)) {
				let updated = this.updatePropertyState(this.#altitude, Slewing ? 'Busy' : 'Idle')
				updated = this.updatePropertyValue(this.#altitude, 'DOME_ALTITUDE_VALUE', Altitude) || updated
				updated && this.sendSetProperty(this.#altitude)
			}

			if (this.properties.has(this.#goto)) {
				let updated = this.updatePropertyState(this.#goto, Slewing ? 'Busy' : 'Idle')
				updated = this.updatePropertyValue(this.#goto, 'DOME_HOME', AtHome) || updated
				updated && this.sendSetProperty(this.#goto)
			}

			if (this.properties.has(this.#park)) {
				let updated = this.updatePropertyState(this.#park, Slewing ? 'Busy' : 'Idle')
				updated = this.updatePropertyValue(this.#park, 'PARK', AtPark) || updated
				updated && this.sendSetProperty(this.#park)
			}

			if (this.properties.has(this.#shutter) && ShutterStatus !== undefined) {
				const status = alpacaDomeShutterStatus(ShutterStatus)
				let updated = this.updatePropertyState(this.#shutter, status.state)
				updated = this.updatePropertyValue(this.#shutter, 'SHUTTER_OPEN', status.open) || updated
				updated = this.updatePropertyValue(this.#shutter, 'SHUTTER_CLOSE', status.closed) || updated
				updated && this.sendSetProperty(this.#shutter)
			}

			if (this.properties.has(this.#autoSync) && Slaved !== undefined) {
				const updated = this.updatePropertyValue(this.#autoSync, Slaved ? 'INDI_ENABLED' : 'INDI_DISABLED', true)
				updated && this.sendSetProperty(this.#autoSync)
			}
		}

		return true
	}

	// Stops optional slaving polling as part of the regular disconnect cleanup.
	protected onDisconnect() {
		super.onDisconnect()
		this.disableEndpoints('Slaved')
	}

	// Routes synthesized INDI switch commands to Alpaca Dome operations.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'DOME_GOTO':
				if (vector.elements.DOME_HOME === true && this.state.CanFindHome) void this.api.findHome(this.id)
				break
			case 'DOME_PARK':
				if (vector.elements.PARK === true && this.state.CanPark) void this.api.park(this.id)
				break
			case 'DOME_PARK_OPTION':
				if (vector.elements.PARK_CURRENT === true && this.state.CanSetPark) void this.api.setPark(this.id)
				break
			case 'DOME_SHUTTER':
				if (vector.elements.SHUTTER_OPEN === true && this.state.CanSetShutter) void this.api.openShutter(this.id)
				else if (vector.elements.SHUTTER_CLOSE === true && this.state.CanSetShutter) void this.api.closeShutter(this.id)
				break
			case 'DOME_AUTOSYNC':
				if (this.state.CanSlave) {
					if (vector.elements.INDI_ENABLED === true) void this.api.setSlaved(this.id, true)
					else if (vector.elements.INDI_DISABLED === true) void this.api.setSlaved(this.id, false)
					this.enableEndpoints('Slaved')
				}
				break
			case 'DOME_ABORT_MOTION':
				if (vector.elements.ABORT === true) void this.api.abortSlew(this.id)
		}
	}

	// Routes synthesized INDI number commands to Alpaca Dome operations in degrees.
	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'ABS_DOME_POSITION':
				if (vector.elements.DOME_ABSOLUTE_POSITION !== undefined && this.state.CanSetAzimuth) void this.api.slewToAzimuth(this.id, vector.elements.DOME_ABSOLUTE_POSITION)
				break
			case 'DOME_ALTITUDE':
				if (vector.elements.DOME_ALTITUDE_VALUE !== undefined && this.state.CanSetAltitude) void this.api.slewToAltitude(this.id, vector.elements.DOME_ALTITUDE_VALUE)
				break
			case 'DOME_SYNC':
				if (vector.elements.DOME_SYNC_VALUE !== undefined && this.state.CanSyncAzimuth) void this.api.syncToAzimuth(this.id, vector.elements.DOME_SYNC_VALUE)
		}
	}
}

// Converts an Alpaca shutter enum to the corresponding INDI switch selection and state.
function alpacaDomeShutterStatus(status: AlpacaDomeShutterState) {
	switch (status) {
		case AlpacaDomeShutterState.OPEN:
			return { open: true, closed: false, state: 'Idle' } as const
		case AlpacaDomeShutterState.CLOSED:
			return { open: false, closed: true, state: 'Idle' } as const
		case AlpacaDomeShutterState.OPENING:
			return { open: true, closed: false, state: 'Busy' } as const
		case AlpacaDomeShutterState.CLOSING:
			return { open: false, closed: true, state: 'Busy' } as const
		case AlpacaDomeShutterState.ERROR:
			return { open: false, closed: false, state: 'Alert' } as const
	}
}

// Polled SafetyMonitor state. IsSafe remains absent until DeviceState or the individual endpoint returns.
interface AlpacaClientSafetyMonitorState extends AlpacaClientDeviceState {
	IsSafe?: boolean
}

function hasIsSafe(item: AlpacaStateItem) {
	return item.Name === 'IsSafe'
}

// SafetyMonitor wrapper exposing the read-only Alpaca IsSafe property as the standard INDI
// SAFETY_STATUS LightVector. Unknown state is fail-closed until the first successful poll.
class AlpacaSafetyMonitor extends AlpacaDevice {
	readonly #safetyStatus = makeLightVector('', 'SAFETY_STATUS', 'Safety', MAIN_CONTROL, ['SAFETY', 'Safety', 'Idle'])

	protected readonly api: AlpacaSafetyMonitorApi
	protected readonly state: AlpacaClientSafetyMonitorState = { Connected: false, DeviceState: undefined, Step: 0, IsSafe: undefined }
	protected readonly initialEndpoints = [] as const
	protected readonly deviceStateEndpoints = ['IsSafe'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaSafetyMonitorApi(client.url)
		this.#safetyStatus.device = device.DeviceName
		this.registerEndpoint('IsSafe', () => api.isSafe(this.id), false)
		this.api = api
	}

	// Defines a fail-closed LightVector whenever the Alpaca device becomes connected.
	protected onConnect() {
		super.onConnect()
		this.state.IsSafe = undefined
		this.#safetyStatus.state = 'Idle'
		this.#safetyStatus.elements.SAFETY.value = 'Idle'
		this.sendDefProperty(this.#safetyStatus)
	}

	// Clears cached safety state before the base removes all published properties.
	protected onDisconnect() {
		this.state.IsSafe = undefined
		super.onDisconnect()
	}

	// Uses DeviceState when it contains IsSafe, otherwise enables the individual endpoint fallback.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const bulkHasIsSafe = this.state.DeviceState?.some(hasIsSafe) === true

		if (bulkHasIsSafe) {
			if (this.runner.isEndpointEnabled('IsSafe')) this.disableEndpoints('IsSafe')
		} else if (this.state.IsSafe === undefined && !this.runner.isEndpointEnabled('IsSafe')) {
			this.enableEndpoints('IsSafe')
			return false
		}

		const isSafe = this.state.IsSafe
		if (isSafe === undefined) return false

		const state = isSafe ? 'Ok' : 'Alert'
		let updated = this.updatePropertyState(this.#safetyStatus, state)
		updated = this.updatePropertyValue(this.#safetyStatus, 'SAFETY', state) || updated
		if (updated) this.sendSetProperty(this.#safetyStatus)
		return true
	}
}

// Polled ObservingConditions state. The keys are the canonical ASCOM names so a bulk DeviceState
// response spreads straight into the bag, and every sensor stays absent until it is first read.
interface AlpacaClientObservingConditionsState extends AlpacaClientDeviceState {
	AveragePeriod?: number
	CloudCover?: number
	DewPoint?: number
	Humidity?: number
	Pressure?: number
	RainRate?: number
	SkyBrightness?: number
	SkyQuality?: number
	SkyTemperature?: number
	StarFWHM?: number
	Temperature?: number
	WindDirection?: number
	WindGust?: number
	WindSpeed?: number
}

// The thirteen ASCOM sensor names, in the order of the shared mapping table.
const WEATHER_ASCOM_NAMES = WEATHER_SENSORS.map((e) => e.ascom)

// Alpaca getter per sensor, so the polling endpoints are registered straight from the shared table.
const WEATHER_SENSOR_READERS: Readonly<Record<WeatherSensor, (api: AlpacaObservingConditionsApi, id: number) => Promise<AlpacaRequestResult<number>>>> = {
	cloudCover: (api, id) => api.getCloudCover(id),
	dewPoint: (api, id) => api.getDewPoint(id),
	humidity: (api, id) => api.getHumidity(id),
	pressure: (api, id) => api.getPressure(id),
	rainRate: (api, id) => api.getRainRate(id),
	skyBrightness: (api, id) => api.getSkyBrightness(id),
	skyQuality: (api, id) => api.getSkyQuality(id),
	skyTemperature: (api, id) => api.getSkyTemperature(id),
	starFWHM: (api, id) => api.getStarFWHM(id),
	temperature: (api, id) => api.getTemperature(id),
	windDirection: (api, id) => api.getWindDirection(id),
	windGust: (api, id) => api.getWindGust(id),
	windSpeed: (api, id) => api.getWindSpeed(id),
}

// ObservingConditions wrapper exposing an ASCOM weather station as the INDI WEATHER_PARAMETERS vector,
// plus the synthesized WEATHER_AVERAGE_PERIOD and WEATHER_REFRESH controls.
//
// Values are published in the INDI units the WeatherManager expects, which for wind direction means
// degrees: converting to radians here would double-convert once the manager parses the vector.
class AlpacaObservingConditions extends AlpacaDevice {
	protected readonly api: AlpacaObservingConditionsApi
	protected readonly state: AlpacaClientObservingConditionsState = { Connected: false, DeviceState: undefined, Step: 0 }
	protected readonly initialEndpoints = ['AveragePeriod'] as const
	protected readonly deviceStateEndpoints = WEATHER_ASCOM_NAMES

	// Defined once the supported set is known, because a vector whose elements later disappear is worse
	// than one that arrives a tick late.
	#parameters?: ReturnType<typeof makeNumberVector>
	// Element labels from SensorDescription, keyed by the ASCOM sensor name and fetched once per session.
	// Its presence is what marks the capability discovery as settled; a supported sensor still without a
	// reading joins WEATHER_PARAMETERS on a later tick and needs its label then.
	#labels?: ReadonlyMap<string, string>
	#defining = false
	// Bumped on every connect and disconnect. #defineParameters awaits the sensor descriptions and the two
	// command handlers await their PUT, and a disconnect followed by a reconnect inside any of those
	// windows leaves isConnected true again, so the generation is what tells a resolved-too-late run that
	// its session is over.
	#generation = 0

	readonly #averagePeriod = makeNumberVector('', 'WEATHER_AVERAGE_PERIOD', 'Average Period', MAIN_CONTROL, 'rw', ['AVERAGE_PERIOD', 'Period (h)', 0, 0, 24, 0.1, '%.2f'])
	readonly #refresh = makeSwitchVector('', 'WEATHER_REFRESH', 'Refresh', MAIN_CONTROL, 'AtMostOne', 'rw', ['REFRESH', 'Refresh', false])

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaObservingConditionsApi(client.url)
		this.#averagePeriod.device = device.DeviceName
		this.#refresh.device = device.DeviceName

		this.registerEndpoint('AveragePeriod', () => api.getAveragePeriod(this.id), false)

		for (const sensor of WEATHER_SENSORS) {
			this.registerEndpoint(sensor.ascom, () => WEATHER_SENSOR_READERS[sensor.field](api, this.id), false)
		}

		this.api = api
	}

	// Determines the supported sensors, labels them, and publishes WEATHER_PARAMETERS.
	//
	// When the server answers DeviceState, the names it omits are exactly the sensors it does not
	// implement, which settles every capability in one request. Otherwise the per-sensor endpoints have
	// already run once by the time this is reached, so the definitive 1024s are already recorded.
	// SensorDescription is used only for the element label, never as a capability probe: drivers that
	// return an empty string instead of an error would silently drop a working sensor.
	async #defineParameters(generation: number) {
		const bulk = this.state.DeviceState

		if (bulk) {
			const present = new Set(bulk.map((e) => e.Name))
			for (const sensor of WEATHER_SENSORS) if (!present.has(sensor.ascom)) this.unsupported.add(sensor.ascom)
		}

		const supported = WEATHER_SENSORS.filter((e) => !this.unsupported.has(e.ascom))
		const unsupported = WEATHER_SENSORS.filter((e) => this.unsupported.has(e.ascom)).map((e) => e.ascom)

		if (unsupported.length > 0) this.disableEndpoints(...unsupported)

		const labels = await Promise.all(supported.map((e) => this.api.sensorDescription(this.id, e.ascom)))

		// The device may have gone away, or gone away and come back, while the descriptions were in
		// flight. Either way this run belongs to a finished session and must not define anything.
		if (generation !== this.#generation || !this.isConnected) return

		const map = new Map<string, string>()

		for (let i = 0; i < supported.length; i++) {
			const label = labels[i]
			map.set(supported[i].ascom, (label.ok && label.value) || supported[i].ascom)
		}

		this.#labels = map

		this.#publishParameters()
		this.sendDefProperty(this.#refresh)
		this.#applyAveragePeriod()
	}

	// Publishes WEATHER_PARAMETERS with the supported sensors that have a reading, extending an already
	// published vector with the ones that have since produced their first.
	//
	// A supported sensor whose poll failed transiently is correctly not recorded as unsupported, but it
	// has no value either. Declaring its element anyway would publish a fabricated zero as a fresh
	// observation, because #fillParameters skips an undefined reading while the vector is emitted
	// regardless. Such a sensor therefore joins on the tick its first real reading arrives, which INDI
	// expresses as a redefinition of the same property; the endpoint keeps being polled meanwhile.
	#publishParameters() {
		const labels = this.#labels!
		const { state } = this
		let parameters = this.#parameters
		let added = false

		for (const sensor of WEATHER_SENSORS) {
			if (this.unsupported.has(sensor.ascom)) continue
			if (state[sensor.ascom as keyof AlpacaClientObservingConditionsState] === undefined) continue
			if (parameters?.elements[sensor.indi] !== undefined) continue

			if (parameters === undefined) {
				parameters = makeNumberVector(this.device.DeviceName, 'WEATHER_PARAMETERS', 'Parameters', MAIN_CONTROL, 'ro')
				this.#parameters = parameters
			}

			parameters.elements[sensor.indi] = { name: sensor.indi, label: labels.get(sensor.ascom) ?? sensor.ascom, value: 0, min: sensor.min, max: sensor.max, step: sensor.step, format: sensor.format }
			added = true
		}

		if (!added || parameters === undefined) return

		// Seed the elements from the readings already polled, so the definition itself carries real
		// values instead of publishing a zero for one whole tick.
		this.#fillParameters(parameters)
		this.sendDefProperty(parameters)
	}

	// Writes the polled readings into the vector elements, without emitting anything.
	#fillParameters(parameters: ReturnType<typeof makeNumberVector>) {
		const { state } = this

		for (const sensor of WEATHER_SENSORS) {
			if (parameters.elements[sensor.indi] === undefined) continue

			let value = state[sensor.ascom as keyof AlpacaClientObservingConditionsState] as number | undefined

			if (value === undefined) continue

			if (sensor.field === 'windDirection') {
				// ASCOM reports north as 360 and reserves 0 for calm air, so a 0 never carries a direction
				// and the last known one is kept instead. This does not depend on WindSpeed: consulting it
				// would republish the calm sentinel as a northerly wind whenever the speed is
				// unimplemented or not yet read. A real north arrives as 360 and reduces to 0 below, which
				// is 0 radians once the manager converts it.
				if (value === 0) continue
				value %= 360
			}

			this.updatePropertyValue(parameters, sensor.indi, value)
		}
	}

	// Mirrors the polled readings into WEATHER_PARAMETERS.
	//
	// The vector is re-emitted every tick even when no value moved. The property object is reused, so the
	// INDI side treats it as a fresh report of the same values, which is what keeps a downstream
	// TimeSinceLastUpdate advancing while the weather is steady.
	#applyParameters() {
		const parameters = this.#parameters!
		this.#fillParameters(parameters)
		this.sendSetProperty(parameters)
	}

	// Publishes the averaging window, defining the vector the first time a value arrives. A server
	// without AveragePeriod never defines it.
	#applyAveragePeriod() {
		const value = this.state.AveragePeriod

		if (value === undefined) return

		const defined = this.properties.has(this.#averagePeriod)
		const updated = this.updatePropertyValue(this.#averagePeriod, 'AVERAGE_PERIOD', value)

		if (!defined) this.sendDefProperty(this.#averagePeriod)
		else if (updated) this.sendSetProperty(this.#averagePeriod)
	}

	// Forwards an averaging-window change. The endpoint keeps polling, so the effective value returns on
	// the next tick whether or not the server accepted the request.
	async #handleAveragePeriod(hours: number) {
		const generation = this.#generation

		this.#averagePeriod.state = 'Busy'
		this.sendSetProperty(this.#averagePeriod)

		const result = await this.api.setAveragePeriod(this.id, hours)

		// The session ended while the request was in flight, so this answer describes a device that is
		// gone. Emitting it would either set a property that is currently deleted or stamp the outcome of
		// the old session onto the one a reconnect just redefined. #resetCommands has already released the
		// vector, so there is nothing left to undo here.
		if (generation !== this.#generation) return

		this.#averagePeriod.state = result.ok ? 'Ok' : 'Alert'
		this.sendSetProperty(this.#averagePeriod)
	}

	// Forwards a refresh request. A server without Refresh withdraws the switch, so the WeatherManager
	// correctly reports that the device offers no explicit refresh.
	async #handleRefresh() {
		const generation = this.#generation

		this.#refresh.state = 'Busy'
		this.sendSetProperty(this.#refresh)

		const result = await this.api.refresh(this.id)

		// See #handleAveragePeriod. An unimplemented answer is the damaging one: it deletes the property,
		// which for a stale run would withdraw the refresh control the new session just defined.
		if (generation !== this.#generation) return

		this.#refresh.elements.REFRESH.value = false

		if (!result.ok && result.errorNumber === AlpacaException.MethodOrPropertyNotImplemented) {
			this.sendDelProperty(this.#refresh)
			return
		}

		this.#refresh.state = result.ok ? 'Ok' : 'Alert'
		this.sendSetProperty(this.#refresh)
	}

	// Returns the two command vectors to rest. They are single objects reused across sessions, so a
	// command still in flight when the session ends would otherwise leave its Busy state, or a latched
	// momentary switch, on the definition the next session publishes.
	#resetCommands() {
		this.#averagePeriod.state = 'Idle'
		this.#refresh.state = 'Idle'
		this.#refresh.elements.REFRESH.value = false
	}

	protected onConnect() {
		super.onConnect()
		this.#generation++
		this.#parameters = undefined
		this.#labels = undefined
		this.#defining = false
		this.#resetCommands()
	}

	protected onDisconnect() {
		this.#generation++
		this.#parameters = undefined
		this.#labels = undefined
		this.#defining = false
		this.#resetCommands()
		super.onDisconnect()
	}

	// Waits for the capability discovery to settle before mirroring any reading.
	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		if (this.#labels === undefined) {
			if (!this.#defining) {
				this.#defining = true
				void this.#defineParameters(this.#generation)
			}

			return false
		}

		// A supported sensor that had no reading when the vector was published joins it on the tick its
		// first one arrives, so the definition is revisited before every mirror.
		this.#publishParameters()

		if (this.#parameters === undefined) return false

		this.#applyAveragePeriod()
		this.#applyParameters()

		return true
	}

	sendNumber(vector: NewNumberVector) {
		if (vector.name === 'WEATHER_AVERAGE_PERIOD') {
			const hours = vector.elements.AVERAGE_PERIOD
			if (hours !== undefined) void this.#handleAveragePeriod(hours)
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		if (vector.name === 'WEATHER_REFRESH' && vector.elements.REFRESH === true) {
			void this.#handleRefresh()
		}
	}
}

// Wraps a longitude in degrees to the range (-180, 180].
function normalizeLongitude(angle: number) {
	angle = angle % 360
	if (angle > 180) angle -= 360
	return angle
}

// Converts an Alpaca ImageBytes binary buffer into an in-memory FITS, stamping observation metadata
// (J2000 coordinates from the mount, filter, focuser, rotator, exposure). `time` is used for the JNOW→
// J2000 conversion and `lastExposureDuration` is in seconds. Disconnected devices are ignored.
// https://github.com/ASCOMInitiative/ASCOMRemote/blob/main/Documentation/AlpacaImageBytes.pdf
export function makeFitsFromImageBytes(data: ArrayBuffer, time?: Time, camera?: Camera, mount?: Mount, wheel?: Wheel, focuser?: Focuser, rotator?: Rotator, lastExposureDuration: number = 0) {
	const metadataArray = new Int32Array(data, 0, 44)
	const metadata: ImageBytesMetadata = {
		MetadataVersion: metadataArray[0],
		ErrorNumber: metadataArray[1],
		ClientTransactionID: metadataArray[2],
		ServerTransactionID: metadataArray[3],
		DataStart: metadataArray[4],
		ImageElementType: metadataArray[5],
		TransmissionElementType: metadataArray[6],
		Rank: metadataArray[7] as never,
		Dimension1: metadataArray[8],
		Dimension2: metadataArray[9],
		Dimension3: metadataArray[10],
	}

	const NumX = metadata.Dimension1
	const NumY = metadata.Dimension2
	const NumZ = metadata.Dimension3 === 3 ? 3 : 1

	let rightAscension: Angle | undefined
	let declination: Angle | undefined

	// Don't use it if disconnected
	if (!camera?.connected) camera = undefined
	if (!mount?.connected) mount = undefined

	if (mount) {
		;[rightAscension, declination] = equatorialToJ2000(mount.equatorialCoordinate.rightAscension, mount.equatorialCoordinate.declination, time)
	}

	const bitpix = alpacaImageElementTypeToBitpix(metadata.TransmissionElementType)
	const bytesPerPixel = bitpixInBytes(bitpix)

	// https://github.com/indilib/indi/blob/3b0cdcb6caf41c859b77c6460981772fe8d5d22d/libs/indibase/indiccd.cpp#L2028
	const header: FitsHeader = {
		SIMPLE: true,
		BITPIX: bitpix,
		NAXIS: metadata.Rank,
		NAXIS1: NumX,
		NAXIS2: NumY,
		NAXIS3: NumZ === 3 ? 3 : undefined,
		EXTEND: true,
		BZERO: bitpix === 16 ? 32768 : bitpix === 32 ? 2147483648 : undefined,
		BSCALE: bitpix === 16 || bitpix === 32 ? 1 : undefined,
		ROWORDER: 'TOP-DOWN',
		INSTRUME: camera?.name,
		TELESCOP: mount?.name,
		EXPTIME: lastExposureDuration,
		EXPOSURE: lastExposureDuration,
		DARKTIME: camera?.frameType === 'DARK' ? lastExposureDuration : undefined,
		'CCD-TEMP': camera?.hasCooler ? camera.temperature : undefined,
		PIXSIZE1: camera?.pixelSize.x,
		PIXSIZE2: camera?.pixelSize.y,
		XBINNING: camera?.bin.x.value,
		YBINNING: camera?.bin.y.value,
		XPIXSZ: camera ? camera.pixelSize.x * camera.bin.x.value : undefined,
		YPIXSZ: camera ? camera.pixelSize.y * camera.bin.y.value : undefined,
		FRAME: camera?.frameType === 'BIAS' ? 'Bias' : camera?.frameType === 'FLAT' ? 'Flat' : camera?.frameType === 'DARK' ? 'Dark' : 'Light',
		IMAGETYP: camera?.frameType === 'BIAS' ? 'Bias Frame' : camera?.frameType === 'FLAT' ? 'Flat Frame' : camera?.frameType === 'DARK' ? 'Dark Frame' : 'Light Frame',
		FILTER: wheel ? wheel.names[wheel.position] : undefined,
		XBAYROFF: camera?.cfa.offsetX,
		YBAYROFF: camera?.cfa.offsetY,
		BAYERPAT: camera?.cfa.type,
		ROTATANG: rotator ? rotator.angle.value : undefined,
		FOCUSPOS: focuser?.position.value,
		FOCUSTEM: focuser?.hasThermometer ? focuser.temperature : undefined,
		SITELAT: mount ? toDeg(mount.geographicCoordinate.latitude) : undefined,
		SITELONG: mount ? toDeg(mount.geographicCoordinate.longitude) : undefined,
		OBJCTRA: rightAscension !== undefined ? formatRA(rightAscension) : undefined,
		OBJCTDEC: declination !== undefined ? formatDEC(declination) : undefined,
		RA: rightAscension !== undefined ? toDeg(normalizeAngle(rightAscension)) : undefined,
		DEC: declination !== undefined ? toDeg(declination) : undefined,
		EQUINOX: 2000,
		PIERSIDE: mount && mount.pierSide !== 'NEITHER' ? mount.pierSide : undefined,
		'DATE-OBS': formatTemporal(Date.now() - Math.trunc(lastExposureDuration * 1000), 'YYYY-MM-DDTHH:mm:ss.SSS'),
		'DATE-END': formatTemporal(Date.now(), 'YYYY-MM-DDTHH:mm:ss.SSS'),
		GAIN: camera?.gain.value,
		OFFSET: camera?.offset.value,
		COMMENT: "FITS (Flexible Image Transport System) format is defined in 'Astronomy\n and Astrophysics', volume 376, page 359; bibcode: 2001A&A...376..359H\nGenerated by Nebulosa",
	}

	const numberOfPixels = NumX * NumY
	const elementCount = numberOfPixels * NumZ
	const estimatedHeaderSize = Object.keys(header).filter((e) => header[e] !== undefined).length * FITS_HEADER_CARD_SIZE + FITS_BLOCK_SIZE
	const expectedDataSize = elementCount * bytesPerPixel
	const output = Buffer.allocUnsafe(estimatedHeaderSize + computeRemainingBytes(estimatedHeaderSize) + expectedDataSize + computeRemainingBytes(expectedDataSize))

	const writer = new FitsKeywordWriter()
	let headerOffset = writer.writeAll(header, output)
	headerOffset += writer.writeEnd(output, headerOffset)

	const SourceTypedArray = bitpix === 8 ? Uint8Array : bitpix === 16 ? Uint16Array : bitpix === 32 ? Uint32Array : bitpix === -32 ? Float32Array : Float64Array
	const sourceArray = new SourceTypedArray(data, metadata.DataStart, elementCount)
	const byteOffset = headerOffset + computeRemainingBytes(headerOffset)
	const OutputTypedArray = bitpix === 8 ? Uint8Array : bitpix === 16 ? Int16Array : bitpix === 32 ? Int32Array : bitpix === -32 ? Float32Array : Float64Array
	const outputArray = new OutputTypedArray(output.buffer, byteOffset, sourceArray.length)
	const zero = bitpix === 16 ? 32768 : bitpix === 32 ? 2147483648 : 0

	let p = 0

	for (let x = 0; x < NumX; x++) {
		for (let y = 0, n = 0; y < NumY; y++, n += NumX) {
			for (let c = 0, m = n + x; c < NumZ; c++, m += numberOfPixels, p++) {
				outputArray[m] = sourceArray[p] - zero
			}
		}
	}

	p *= bytesPerPixel

	const size = byteOffset + p + computeRemainingBytes(p)
	// FITS is big-endian
	if (bytesPerPixel === 2) output.subarray(byteOffset, size).swap16()
	else if (bytesPerPixel === 4) output.subarray(byteOffset, size).swap32()
	else if (bytesPerPixel === 8) output.subarray(byteOffset, size).swap64()
	return output.subarray(0, size)
}

// A named, awaitable REST call scheduled by the runner.
type AlpacaApiRunnerEndpoint = () => PromiseLike<unknown>

// Callback invoked once after each polling cycle's results have been applied to the state bag.
type AlpacaApiRunnerHandlerAfterRun = () => void

// Polling scheduler backing each device wrapper. Holds a set of named endpoints in parallel arrays
// (key/endpoint/enabled/interval/count/result), runs the enabled ones each tick subject to their
// per-endpoint interval, writes their results into the device state bag, and then fires the after-run
// handlers. Parallel arrays keep object shapes stable and avoid per-tick allocations.
class AlpacaApiRunner {
	readonly #keys: string[] = []
	readonly #endpoints: AlpacaApiRunnerEndpoint[] = []
	readonly #enabled: boolean[] = []
	readonly #interval: number[] = []
	readonly #count: number[] = []
	readonly #result: (PromiseLike<unknown> | undefined)[] = []
	readonly #handlers = new Set<AlpacaApiRunnerHandlerAfterRun>()

	// Registers or replaces an endpoint under `key`. `enabled` sets initial polling; `interval` polls
	// every Nth tick (1 = every tick).
	registerEndpoint(key: string, endpoint: AlpacaApiRunnerEndpoint, enabled: boolean, interval: number = 1) {
		const index = this.#keys.indexOf(key)

		if (index >= 0) {
			this.#keys[index] = key
			this.#endpoints[index] = endpoint
			this.#enabled[index] = enabled
			this.#interval[index] = interval
			this.#count[index] = 0
		} else {
			this.#keys.push(key)
			this.#endpoints.push(endpoint)
			this.#enabled.push(enabled)
			this.#interval.push(interval)
			this.#count.push(0)
		}
	}

	// Removes the endpoint registered under `key`, if any.
	unregisterEndpoint(key: string) {
		const index = this.#keys.indexOf(key)

		if (index >= 0) {
			this.#keys.splice(index, 1)
			this.#endpoints.splice(index, 1)
			this.#enabled.splice(index, 1)
			this.#result.splice(index, 1)
			this.#interval.splice(index, 1)
			this.#count.splice(index, 1)
		}
	}

	// Enables/disables an endpoint (or toggles when `force` is omitted), resetting its tick counter when
	// enabled so it polls immediately.
	toggleEndpoint(key: string, force?: boolean) {
		const index = this.#keys.indexOf(key)
		if (index >= 0) this.#enabled[index] = force ?? !this.#enabled[index]
		else console.warn('endpoint not found:', key)
		if (index >= 0 && this.#enabled[index]) this.#count[index] = 0
	}

	// Returns whether the named endpoint exists and is currently enabled.
	isEndpointEnabled(key: string) {
		const index = this.#keys.indexOf(key)
		return index >= 0 && this.#enabled[index]
	}

	// Registers an after-run handler invoked once per cycle.
	registerHandler(handler: AlpacaApiRunnerHandlerAfterRun) {
		this.#handlers.add(handler)
	}

	// Removes a previously registered after-run handler.
	unregisterHandler(handler: AlpacaApiRunnerHandlerAfterRun) {
		this.#handlers.delete(handler)
	}

	// One polling cycle: fires the due endpoints (respecting their intervals), then applies results and
	// runs the handlers. Returns the promise that resolves once results are applied.
	run(state: Record<string, ValueType>) {
		const n = this.#keys.length

		for (let i = 0; i < n; i++) {
			if (this.#enabled[i] && (this.#interval[i] <= 1 || this.#count[i] % this.#interval[i] === 0)) {
				this.#result[i] = this.#endpoints[i]()
			} else {
				this.#result[i] = undefined
			}

			this.#count[i]++
		}

		return this.#handleEndpointsAfterRun(state)
	}

	// Awaits all in-flight endpoint results, writes each enabled endpoint's value into the state bag under
	// its key, then invokes the after-run handlers.
	async #handleEndpointsAfterRun(state: Record<string, ValueType>) {
		// oxlint-disable-next-line typescript/await-thenable
		const result = await Promise.all(this.#result)
		const n = result.length

		for (let i = 0; i < n; i++) {
			const value = result[i] as never

			if (this.#enabled[i]) {
				state[this.#keys[i]] = value
			}
		}

		for (const handler of this.#handlers) {
			handler()
		}
	}
}
