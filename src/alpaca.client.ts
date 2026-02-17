import { AlpacaCameraApi, AlpacaCoverCalibratorApi, type AlpacaDeviceApi, AlpacaFilterWheelApi, AlpacaFocuserApi, AlpacaManagementApi, AlpacaTelescopeApi } from './alpaca.api'
import type { AlpacaAxisRate, AlpacaCameraSensorType, AlpacaCameraState, AlpacaConfiguredDevice, AlpacaDeviceType, AlpacaStateItem, AlpacaTelescopePierSide, AlpacaTelescopeTrackingRate, ImageBytesMetadata } from './alpaca.types'
import { type Angle, formatDEC, formatRA, normalizeAngle, toDeg } from './angle'
import { SIDEREAL_RATE } from './constants'
import { equatorialToJ2000 } from './coordinate'
import { computeRemainingBytes, FITS_BLOCK_SIZE, type FitsHeader, FitsKeywordWriter } from './fits'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetBlobVector, handleSetNumberVector, handleSetSwitchVector, handleSetTextVector, type IndiClientHandler } from './indi.client'
import type { Camera, Client, Device, Focuser, Mount, Rotator, Wheel } from './indi.device'
import type { DeviceProvider } from './indi.manager'
// biome-ignore format: too long!
import { type DefBlob, type DefBlobVector, type DefNumber, type DefNumberVector, type DefSwitch, type DefSwitchVector, type DefText, type DefTextVector, type DefVector, type EnableBlob, findOnSwitch, type GetProperties, type NewNumberVector, type NewSwitchVector, type NewTextVector, type OneBlob, type PropertyPermission, type PropertyState, type SetBlobVector, type SwitchRule, type ValueType, type VectorType } from './indi.types'
import { roundToNthDecimal } from './math'
import { formatTemporal, TIMEZONE } from './temporal'

export interface AlpacaClientHandler extends IndiClientHandler {}

export interface AlpacaClientOptions {
	handler: AlpacaClientHandler
	poolingInterval?: number
}

export class AlpacaClient implements Client, Disposable {
	readonly type = 'ALPACA'
	readonly id: string
	readonly description: string

	readonly remoteHost: string
	readonly remotePort: number

	private readonly devices = new Map<string, AlpacaDevice>()
	private readonly management: AlpacaManagementApi
	private timer?: NodeJS.Timeout

	constructor(
		readonly url: string,
		readonly options: AlpacaClientOptions,
		readonly provider: DeviceProvider<Device>,
	) {
		this.id = Bun.MD5.hash(url, 'hex')
		this.description = `Alpaca Client at ${url}`
		this.management = new AlpacaManagementApi(url)
		const { protocol, hostname, port } = URL.parse(url)!
		this.remoteHost = hostname
		this.remotePort = +port || (protocol === 'http:' ? 80 : 443)
	}

	getProperties(command?: GetProperties) {
		if (command?.device) {
			this.devices.get(command.device)?.sendProperties(command.name)
		} else {
			for (const [, device] of this.devices) device.sendProperties(command?.name)
		}
	}

	enableBlob(command: EnableBlob) {}

	sendText(vector: NewTextVector) {
		this.devices.get(vector.device)?.sendText(vector)
	}

	sendNumber(vector: NewNumberVector) {
		this.devices.get(vector.device)?.sendNumber(vector)
	}

	sendSwitch(vector: NewSwitchVector) {
		this.devices.get(vector.device)?.sendSwitch(vector)
	}

	async start() {
		if (this.timer) return false
		const configuredDevices = await this.management.configuredDevices()
		if (!configuredDevices?.length) return false
		this.initialize(configuredDevices)
		return true
	}

	private initialize(configuredDevices: readonly AlpacaConfiguredDevice[]) {
		for (const configuredDevice of configuredDevices) {
			let device = this.devices.get(configuredDevice.DeviceName)

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
				}

				if (device) {
					this.devices.set(configuredDevice.DeviceName, device)
					device.onInit()
				}
			}
		}

		clearInterval(this.timer)
		this.timer = setInterval(this.update.bind(this), Math.max(1000, this.options?.poolingInterval ?? 1000))
		this.update()
	}

	private update() {
		for (const [, device] of this.devices) device.update()
	}

	stop(server: boolean = false) {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined

			for (const [, device] of this.devices) device.close()
			this.devices.clear()

			this.options?.handler?.close?.(this, server)
		}
	}

	[Symbol.dispose]() {
		this.stop()
	}
}

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

const MAIN_CONTROL = 'Main Control'
const GENERAL_INFO = 'General Info'

interface AlpacaClientDeviceState {
	readonly Connected: boolean
	DeviceState?: readonly AlpacaStateItem[]
	Step: number
}

abstract class AlpacaDevice {
	readonly id: number

	protected readonly runner = new AlpacaApiRunner()
	protected readonly properties = new Set<DefVector & { type: Uppercase<VectorType> }>()

	protected abstract readonly api: AlpacaDeviceApi
	protected abstract readonly state: AlpacaClientDeviceState
	protected abstract readonly initialEndpoints: readonly string[] // Endpoints used by step 1
	protected abstract readonly stateEndpoints: readonly string[] // Used when DeviceState is not supported
	protected readonly runningEndpoints: readonly string[] = [] // Endpoints should run on each update

	protected readonly driverInfo = makeTextVector('', 'DRIVER_INFO', 'Driver Info', GENERAL_INFO, 'ro', ['DRIVER_INTERFACE', 'Interface', ''], ['DRIVER_EXEC', 'Exec', ''], ['DRIVER_VERSION', 'Version', '1.0'], ['DRIVER_NAME', 'Name', ''])
	protected readonly connection = makeSwitchVector('', 'CONNECTION', 'Connection', MAIN_CONTROL, 'OneOfMany', 'rw', ['CONNECT', 'Connect', false], ['DISCONNECT', 'Disconnect', true])
	protected readonly snoopDevices = makeTextVector('', 'ACTIVE_DEVICES', 'Snoop devices', MAIN_CONTROL, 'rw', ['ACTIVE_TELESCOPE', 'Mount', ''], ['ACTIVE_FOCUSER', 'Focuser', ''], ['ACTIVE_FILTER', 'Filter Wheel', ''], ['ACTIVE_ROTATOR', 'Rotator', ''])

	private hasDeviceState: 0 | boolean = 0 // 0 = not checked yet

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

	get isConnected() {
		return this.connection.elements.CONNECT.value === true
	}

	get activeMount() {
		if (!this.snoopDevices.elements.ACTIVE_TELESCOPE.value) return undefined
		return this.client.provider.get(this.client, this.snoopDevices.elements.ACTIVE_TELESCOPE.value, 'MOUNT') as Mount | undefined
	}

	get activeWheel() {
		if (!this.snoopDevices.elements.ACTIVE_FILTER.value) return undefined
		return this.client.provider.get(this.client, this.snoopDevices.elements.ACTIVE_FILTER.value, 'WHEEL') as Wheel | undefined
	}

	get activeFocuser() {
		if (!this.snoopDevices.elements.ACTIVE_FOCUSER.value) return undefined
		return this.client.provider.get(this.client, this.snoopDevices.elements.ACTIVE_FOCUSER.value, 'FOCUSER') as Focuser | undefined
	}

	get activeRotator() {
		if (!this.snoopDevices.elements.ACTIVE_ROTATOR.value) return undefined
		return this.client.provider.get(this.client, this.snoopDevices.elements.ACTIVE_ROTATOR.value, 'ROTATOR') as Rotator | undefined
	}

	protected sendDefProperty(message: DefVector & { type: Uppercase<VectorType> }) {
		if (message.type[0] === 'S') handleDefSwitchVector(this.client, this.handler, message as never)
		else if (message.type[0] === 'N') handleDefNumberVector(this.client, this.handler, message as never)
		else handleDefTextVector(this.client, this.handler, message as never)

		this.properties.add(message)
	}

	protected sendSetProperty(message: DefVector & { type: Uppercase<VectorType> }) {
		if (message.type[0] === 'S') handleSetSwitchVector(this.client, this.handler, message as never)
		else if (message.type[0] === 'N') handleSetNumberVector(this.client, this.handler, message as never)
		else handleSetTextVector(this.client, this.handler, message as never)
	}

	protected sendDelProperty(...messages: DefVector[]) {
		for (const message of messages) {
			if (this.properties.delete(message as never)) {
				handleDelProperty(this.client, this.handler, message)
			}
		}
	}

	protected updatePropertyState(property: DefVector, state: PropertyState | undefined) {
		if (state !== undefined && property.state !== state) {
			property.state = state
			return true
		}

		return false
	}

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

	sendProperties(name?: string) {
		for (const property of this.properties) {
			if (!name || property.name === name) {
				this.sendDefProperty(property)
				this.sendSetProperty(property)
			}
		}
	}

	onInit() {
		this.sendDefProperty(this.driverInfo)
		this.sendDefProperty(this.connection)

		this.runner.registerEndpoint('Connected', this.api.isConnected.bind(this.api, this.id), true)
		this.runner.registerEndpoint('DeviceState', this.api.deviceState.bind(this.api, this.id), false)
	}

	protected reset() {
		this.state.Step = 0
		this.hasDeviceState = 0
		this.state.DeviceState = undefined
	}

	protected onConnect() {
		this.reset()
	}

	protected onDisconnect() {
		this.reset()
		this.disableEndpoints('DeviceState')
		this.disableEndpoints(...this.initialEndpoints)
		this.disableEndpoints(...this.stateEndpoints)
		this.disableEndpoints(...this.runningEndpoints)
		this.sendDelProperty(...this.properties)
	}

	update() {
		void this.runner.run(this.state as never)
	}

	protected deviceStateHasBeenDisabled() {}

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
				if (this.hasDeviceState === 0) {
					// Step 0 will run again to read the device state
					this.hasDeviceState = true
					this.enableEndpoints('DeviceState')
					return false
				}

				if (this.hasDeviceState === true && this.state.DeviceState === undefined) {
					this.hasDeviceState = false
					this.enableEndpoints(...this.stateEndpoints)
					this.disableEndpoints('DeviceState')
					this.deviceStateHasBeenDisabled()
					console.info(this.device.DeviceName, 'does not support DeviceState')
				}

				this.enableEndpoints(...this.initialEndpoints)
				this.enableEndpoints(...this.runningEndpoints)

				this.state.Step = 1

				return false
			} else if (this.hasDeviceState === true) {
				for (const item of this.state.DeviceState!) {
					this.state[item.Name as never] = item.Value as never
				}
			}

			return true
		}

		return false
	}

	protected enableEndpoints(...keys: string[]) {
		for (const key of keys) {
			;(this.state as unknown as Record<string, undefined>)[key] = undefined
			this.runner.toggleEndpoint(key, true)
		}
	}

	protected disableEndpoints(...keys: string[]) {
		for (const key of keys) this.runner.toggleEndpoint(key, false)
	}

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

	sendNumber(vector: NewNumberVector) {}

	sendSwitch(vector: NewSwitchVector) {
		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true && !this.isConnected) {
					void this.handleConnection('connect')
				} else if (vector.elements.DISCONNECT === true && this.isConnected) {
					void this.handleConnection('disconnect')
				}
		}
	}

	private async handleConnection(mode: 'connect' | 'disconnect') {
		this.connection.state = 'Busy'
		this.sendSetProperty(this.connection)

		const ok = (await this.api[mode](this.id)) === true
		this.connection.state = ok ? 'Idle' : 'Alert'
		this.sendSetProperty(this.connection)
	}

	close() {}
}

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
}

class AlpacaCamera extends AlpacaDevice {
	protected readonly api: AlpacaCameraApi
	// https://ascom-standards.org/newdocs/camera.html#Camera.DeviceState
	// biome-ignore format: too long!
	protected readonly state: AlpacaClientCameraState = { Connected: false, Step: 0, CameraState: 0, CCDTemperature: 0, CoolerPower: 0, ImageReady: false, IsPulseGuiding: false, PercentCompleted: 0, ExposureDuration: 0, ExposureStarted: false }
	// biome-ignore format: too long!
	protected readonly initialEndpoints = ['BayerOffsetX', 'BayerOffsetY', 'SensorType', 'CameraXSize', 'CameraYSize', 'CanGetCoolerPower', 'CanPulseGuide', 'CanSetCcdTemperature', 'CanStopExposure', 'ExposureMax', 'ExposureMin', 'GainMax', 'GainMin', 'Gains', 'MaxBinX', 'MaxBinY', 'OffsetMax', 'OffsetMin', 'Offsets', 'PixelSizeX', 'PixelSizeY', 'ReadoutModes'] as const
	protected readonly stateEndpoints = ['CameraState', 'CCDTemperature', 'CoolerPower', 'ImageReady', 'IsPulseGuiding', 'PercentCompleted'] as const
	protected readonly runningEndpoints = ['BinX', 'BinY', 'IsCoolerOn', 'Gain', 'NumX', 'NumY', 'Offset', 'ReadoutMode', 'StartX', 'StartY'] as const

	// biome-ignore format: too long!
	private readonly info = makeNumberVector('', 'CCD_INFO', 'CCD Info', GENERAL_INFO, 'ro', ['CCD_MAX_X', 'Max X', 0, 0, 16000, 1, '%.0f'],  ['CCD_MAX_Y', 'Max Y', 0, 0, 16000, 1, '%.0f'],  ['CCD_PIXEL_SIZE_X', 'Pixel size X', 0, 0, 40, 0.01, '%.2f'], ['CCD_PIXEL_SIZE_Y', 'Pixel size Y', 0, 0, 40, 0.01, '%.2f'], ['CCD_BITSPERPIXEL', 'Bits per pixel', 16, 8, 64, 1, '%.0f'])
	private readonly cooler = makeSwitchVector('', 'CCD_COOLER', 'Cooler', MAIN_CONTROL, 'OneOfMany', 'rw', ['COOLER_ON', 'On', false], ['COOLER_OFF', 'Off', true])
	private readonly frameType = makeSwitchVector('', 'CCD_FRAME_TYPE', 'Frame Type', MAIN_CONTROL, 'OneOfMany', 'rw', ['FRAME_LIGHT', 'Light', true], ['FRAME_DARK', 'Dark', false], ['FRAME_FLAT', 'Flat', false], ['FRAME_BIAS', 'Bias', false])
	private readonly frameFormat = makeSwitchVector('', 'CCD_CAPTURE_FORMAT', 'Readout Mode', MAIN_CONTROL, 'OneOfMany', 'rw')
	private readonly abort = makeSwitchVector('', 'CCD_ABORT_EXPOSURE', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	private readonly exposure = makeNumberVector('', 'CCD_EXPOSURE', 'Exposure', MAIN_CONTROL, 'rw', ['CCD_EXPOSURE_VALUE', 'Exposure (s)', 0, 0, 0, 1e-6, '%.6f'])
	private readonly coolerPower = makeNumberVector('', 'CCD_COOLER_POWER', 'Cooler Power', MAIN_CONTROL, 'ro', ['CCD_COOLER_POWER', 'Power (%)', 0, 0, 100, 1, '%.0f'])
	private readonly temperature = makeNumberVector('', 'CCD_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'ro', ['CCD_TEMPERATURE_VALUE', 'Temperature', 0, -50, 70, 0.1, '%6.2f'])
	private readonly frame = makeNumberVector('', 'CCD_FRAME', 'Frame', MAIN_CONTROL, 'rw', ['X', 'X', 0, 0, 15999, 1, '%.0f'], ['Y', 'Y', 0, 0, 15999, 1, '%.0f'], ['WIDTH', 'Width', 1, 1, 16000, 1, '%.0f'], ['HEIGHT', 'Height', 1, 1, 16000, 1, '%.0f'])
	private readonly bin = makeNumberVector('', 'CCD_BINNING', 'Bin', MAIN_CONTROL, 'rw', ['HOR_BIN', 'X', 1, 1, 1, 1, '%.0f'], ['VER_BIN', 'Y', 1, 1, 1, 1, '%.0f'])
	private readonly gain = makeNumberVector('', 'CCD_GAIN', 'Gain', MAIN_CONTROL, 'rw', ['GAIN', 'Gain', 0, 0, 0, 1, '%.0f'])
	private readonly offset = makeNumberVector('', 'CCD_OFFSET', 'Offset', MAIN_CONTROL, 'rw', ['OFFSET', 'Offset', 0, 0, 0, 1, '%.0f'])
	private readonly cfa = makeTextVector('', 'CCD_CFA', 'CFA', GENERAL_INFO, 'ro', ['CFA_OFFSET_X', 'Offset X', '0'], ['CFA_OFFSET_Y', 'Offset Y', '0'], ['CFA_TYPE', 'Type', 'RGGB']) // Only RGGB pattern is supported?
	private readonly guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	private readonly guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])
	private readonly image = makeBlobVector('', 'CCD1', 'CCD Image', MAIN_CONTROL, 'ro', ['CCD1', 'Image'])

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaCameraApi(client.url)

		this.info.device = device.DeviceName
		this.cooler.device = device.DeviceName
		this.frameType.device = device.DeviceName
		this.frameFormat.device = device.DeviceName
		this.abort.device = device.DeviceName
		this.exposure.device = device.DeviceName
		this.coolerPower.device = device.DeviceName
		this.temperature.device = device.DeviceName
		this.frame.device = device.DeviceName
		this.bin.device = device.DeviceName
		this.gain.device = device.DeviceName
		this.offset.device = device.DeviceName
		this.cfa.device = device.DeviceName
		this.guideNS.device = device.DeviceName
		this.guideWE.device = device.DeviceName
		this.image.device = device.DeviceName

		this.runner.registerEndpoint('BayerOffsetX', api.getBayerOffsetX.bind(api, this.id), false)
		this.runner.registerEndpoint('BayerOffsetY', api.getBayerOffsetY.bind(api, this.id), false)
		this.runner.registerEndpoint('SensorType', api.getSensorType.bind(api, this.id), false)
		this.runner.registerEndpoint('BinX', api.getBinX.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('BinY', api.getBinY.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('CameraXSize', api.getCameraXSize.bind(api, this.id), false)
		this.runner.registerEndpoint('CameraYSize', api.getCameraYSize.bind(api, this.id), false)
		this.runner.registerEndpoint('CanGetCoolerPower', api.canGetCoolerPower.bind(api, this.id), false)
		this.runner.registerEndpoint('CanPulseGuide', api.canPulseGuide.bind(api, this.id), false)
		this.runner.registerEndpoint('CanSetCcdTemperature', api.canSetCcdTemperature.bind(api, this.id), false)
		this.runner.registerEndpoint('CanStopExposure', api.canStopExposure.bind(api, this.id), false)
		this.runner.registerEndpoint('IsCoolerOn', api.isCoolerOn.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('ExposureMax', api.getExposureMax.bind(api, this.id), false)
		this.runner.registerEndpoint('ExposureMin', api.getExposureMin.bind(api, this.id), false)
		this.runner.registerEndpoint('Gain', api.getGain.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('GainMax', api.getGainMax.bind(api, this.id), false)
		this.runner.registerEndpoint('GainMin', api.getGainMin.bind(api, this.id), false)
		this.runner.registerEndpoint('Gains', api.getGains.bind(api, this.id), false)
		this.runner.registerEndpoint('MaxBinX', api.getMaxBinX.bind(api, this.id), false)
		this.runner.registerEndpoint('MaxBinY', api.getMaxBinY.bind(api, this.id), false)
		this.runner.registerEndpoint('NumX', api.getNumX.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('NumY', api.getNumY.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('Offset', api.getOffset.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('OffsetMax', api.getOffsetMax.bind(api, this.id), false)
		this.runner.registerEndpoint('OffsetMin', api.getOffsetMin.bind(api, this.id), false)
		this.runner.registerEndpoint('Offsets', api.getOffsets.bind(api, this.id), false)
		this.runner.registerEndpoint('PixelSizeX', api.getPixelSizeX.bind(api, this.id), false)
		this.runner.registerEndpoint('PixelSizeY', api.getPixelSizeY.bind(api, this.id), false)
		this.runner.registerEndpoint('ReadoutMode', api.getReadoutMode.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('ReadoutModes', api.getReadoutModes.bind(api, this.id), false)
		this.runner.registerEndpoint('StartX', api.getStartX.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('StartY', api.getStartY.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('CameraState', api.getCameraState.bind(api, this.id), false)
		this.runner.registerEndpoint('CCDTemperature', api.getCcdTemperature.bind(api, this.id), false)
		this.runner.registerEndpoint('CoolerPower', api.getCoolerPower.bind(api, this.id), false)
		this.runner.registerEndpoint('ImageReady', api.isImageReady.bind(api, this.id), false)
		this.runner.registerEndpoint('IsPulseGuiding', api.isPulseGuiding.bind(api, this.id), false)
		this.runner.registerEndpoint('PercentCompleted', api.getPercentCompleted.bind(api, this.id), false)

		this.api = api
	}

	get isLight() {
		return this.frameType.elements.FRAME_LIGHT?.value === true
	}

	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, CameraState, CCDTemperature, CoolerPower, ImageReady, IsPulseGuiding, PercentCompleted, BayerOffsetX, BayerOffsetY, BinX, BinY, CameraXSize, CameraYSize, IsCoolerOn, ExposureMax, ExposureMin, CanGetCoolerPower } = this.state
		const { Gain, GainMax, GainMin, Gains, MaxBinX, MaxBinY, NumX, NumY, Offset, OffsetMax, OffsetMin, Offsets, PixelSizeX, PixelSizeY, ReadoutMode, ReadoutModes, StartX, StartY, CanPulseGuide, CanSetCcdTemperature, CanStopExposure, SensorType } = this.state
		const { ExposureDuration, ExposureStarted } = this.state

		// Initial
		if (Step === 1) {
			this.info.elements.CCD_PIXEL_SIZE_X.value = PixelSizeX ?? 0
			this.info.elements.CCD_PIXEL_SIZE_Y.value = PixelSizeY ?? 0
			this.info.elements.CCD_MAX_X.value = CameraXSize!
			this.info.elements.CCD_MAX_Y.value = CameraYSize!
			this.sendDefProperty(this.info)

			this.frame.elements.X.max = CameraXSize! - 1
			this.frame.elements.X.value = StartX ?? 0
			this.frame.elements.Y.max = CameraYSize! - 1
			this.frame.elements.Y.value = StartY ?? 0
			this.frame.elements.WIDTH.max = CameraXSize!
			this.frame.elements.WIDTH.value = NumX ?? 0
			this.frame.elements.HEIGHT.max = CameraYSize!
			this.frame.elements.HEIGHT.value = NumY ?? 0
			this.sendDefProperty(this.frame)

			if (CanStopExposure) {
				this.sendDefProperty(this.abort)
			}

			if (ExposureMax) {
				this.exposure.elements.CCD_EXPOSURE_VALUE.min = ExposureMin ?? 0
				this.exposure.elements.CCD_EXPOSURE_VALUE.max = ExposureMax
				this.sendDefProperty(this.exposure)
			}

			if (IsCoolerOn !== undefined) {
				this.updatePropertyValue(this.cooler, IsCoolerOn ? 'COOLER_ON' : 'COOLER_OFF', true)
				this.sendDefProperty(this.cooler)
			} else {
				this.disableEndpoints('IsCoolerOn')
			}

			if (CCDTemperature !== undefined) {
				this.temperature.elements.CCD_TEMPERATURE_VALUE.value = CCDTemperature

				if (CanSetCcdTemperature) {
					this.temperature.permission = 'rw'
				}

				this.sendDefProperty(this.temperature)
			}

			if (CanGetCoolerPower && CoolerPower !== undefined) {
				this.coolerPower.elements.CCD_COOLER_POWER.value = CoolerPower
				this.sendDefProperty(this.temperature)
			}

			if (MaxBinX) {
				this.bin.elements.HOR_BIN.max = MaxBinX
				this.bin.elements.HOR_BIN.value = BinX ?? 1
				this.bin.elements.VER_BIN.max = MaxBinY ?? MaxBinX
				this.bin.elements.VER_BIN.value = BinY ?? BinX ?? 1
				this.sendDefProperty(this.bin)
			} else {
				this.disableEndpoints('BinX', 'BinY')
			}

			if (Gain !== undefined) {
				if (Gains?.length) {
					// Index mode
					this.gain.elements.GAIN.max = Gains.length - 1
					this.gain.elements.GAIN.value = Gain
					this.sendDefProperty(this.gain)
				} else if (GainMax) {
					// Value mode
					this.gain.elements.GAIN.min = GainMin ?? 0
					this.gain.elements.GAIN.max = GainMax
					this.gain.elements.GAIN.value = Gain
					this.sendDefProperty(this.gain)
				}
			} else {
				this.disableEndpoints('Gain')
			}

			if (Offset !== undefined) {
				if (Offsets?.length) {
					// Index mode
					this.offset.elements.OFFSET.max = Offsets.length - 1
					this.offset.elements.OFFSET.value = Offset
					this.sendDefProperty(this.offset)
				} else if (OffsetMax) {
					// Value mode
					this.offset.elements.OFFSET.min = OffsetMin ?? 0
					this.offset.elements.OFFSET.max = OffsetMax
					this.offset.elements.OFFSET.value = Offset
					this.sendDefProperty(this.offset)
				}
			} else {
				this.disableEndpoints('Offset')
			}

			if (ReadoutModes?.length) {
				for (let i = 0; i < ReadoutModes.length; i++) {
					const name = `MODE_${i}`
					this.frameFormat.elements[name] = { name, label: ReadoutModes[i], value: false }
				}

				this.frameFormat.elements[`MODE_${ReadoutMode ?? 0}`].value = true
				this.sendDefProperty(this.frameFormat)
			} else {
				this.disableEndpoints('ReadoutMode')
			}

			if (CanPulseGuide) {
				this.sendDefProperty(this.guideNS)
				this.sendDefProperty(this.guideWE)
			}

			// RGGB
			if (SensorType === 2) {
				this.cfa.elements.CFA_OFFSET_X.value = BayerOffsetX?.toFixed(0) ?? '0'
				this.cfa.elements.CFA_OFFSET_X.value = BayerOffsetY?.toFixed(0) ?? '0'
				this.cfa.elements.CFA_TYPE.value = 'RGGB'
				this.sendDefProperty(this.cfa)
			}

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			if (IsCoolerOn !== undefined) {
				this.updatePropertyValue(this.cooler, IsCoolerOn ? 'COOLER_ON' : 'COOLER_OFF', true) && this.sendSetProperty(this.cooler)
				this.state.IsCoolerOn = undefined
			}

			if (CoolerPower !== undefined) {
				this.updatePropertyValue(this.coolerPower, 'CCD_COOLER_POWER', CoolerPower) && this.sendSetProperty(this.coolerPower)
			}

			if (Gain !== undefined) {
				this.updatePropertyValue(this.gain, 'GAIN', Gain) && this.sendSetProperty(this.gain)
				this.state.Gain = undefined
			}

			if (Offset !== undefined) {
				this.updatePropertyValue(this.offset, 'OFFSET', Offset) && this.sendSetProperty(this.offset)
				this.state.Offset = undefined
			}

			if (BinX !== undefined && BinY !== undefined) {
				let updated = this.updatePropertyValue(this.bin, 'HOR_BIN', BinX)
				updated = this.updatePropertyValue(this.bin, 'VER_BIN', BinY) || updated
				updated && this.sendSetProperty(this.bin)
				this.state.BinX = undefined
				this.state.BinY = undefined
			}

			if (CCDTemperature !== undefined) {
				this.updatePropertyValue(this.temperature, 'CCD_TEMPERATURE_VALUE', Math.trunc(CCDTemperature)) && this.sendSetProperty(this.temperature)
			}

			if (StartX !== undefined || StartY !== undefined || NumX !== undefined || NumY !== undefined) {
				let updated = false
				if (StartX !== undefined) updated = this.updatePropertyValue(this.frame, 'X', StartX)
				if (StartY !== undefined) updated = this.updatePropertyValue(this.frame, 'Y', StartY) || updated
				if (NumX !== undefined) updated = this.updatePropertyValue(this.frame, 'WIDTH', NumX) || updated
				if (NumY !== undefined) updated = this.updatePropertyValue(this.frame, 'HEIGHT', NumY) || updated
				updated && this.sendSetProperty(this.frame)
				this.state.StartX = undefined
				this.state.StartY = undefined
				this.state.NumX = undefined
				this.state.NumY = undefined
			}

			if (ReadoutMode !== undefined) {
				const name = `MODE_${ReadoutMode}`
				name in this.frameFormat.elements && this.updatePropertyValue(this.frameFormat, name, true) && this.sendSetProperty(this.frameFormat)
				this.state.ReadoutMode = undefined
			}

			if (CanPulseGuide && this.updatePropertyState(this.guideNS, IsPulseGuiding ? 'Busy' : 'Idle')) {
				this.guideWE.state = this.guideNS.state
				this.sendSetProperty(this.guideNS)
				this.sendSetProperty(this.guideWE)
			}

			if (ImageReady) {
				if (ExposureStarted) {
					void this.handleImageReady()
					return true
				}
			} else {
				this.image.elements.CCD1.value = ''
			}

			if (ExposureStarted || CameraState === 2) {
				let updated = this.updatePropertyState(this.exposure, 'Busy')
				updated = this.updatePropertyValue(this.exposure, 'CCD_EXPOSURE_VALUE', ExposureDuration * (1 - PercentCompleted / 100)) || updated
				updated && this.sendSetProperty(this.exposure)
			}
		}

		return true
	}

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
					if (key in this.frameType.elements && vector.elements[key] === true) {
						this.updatePropertyValue(this.frameType, key, true) && this.sendSetProperty(this.frameType)
						break
					}
				}

				break
		}
	}

	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'CCD_EXPOSURE':
				if (vector.elements.CCD_EXPOSURE_VALUE) {
					this.state.ExposureStarted = true
					this.state.ExposureDuration = Math.max(this.exposure.elements.CCD_EXPOSURE_VALUE.min, Math.min(vector.elements.CCD_EXPOSURE_VALUE, this.exposure.elements.CCD_EXPOSURE_VALUE.max))

					void this.api.startExposure(this.id, this.state.ExposureDuration, this.isLight).then((ok) => {
						if (ok === true) {
							this.updatePropertyState(this.exposure, 'Busy')
							this.updatePropertyValue(this.exposure, 'CCD_EXPOSURE_VALUE', this.state.ExposureDuration)
						} else {
							this.state.ExposureStarted = false
							this.updatePropertyState(this.exposure, 'Alert')
							this.updatePropertyValue(this.exposure, 'CCD_EXPOSURE_VALUE', 0)
						}

						this.sendSetProperty(this.exposure)
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

	private async handleImageReady() {
		this.exposure.state = 'Busy'
		this.exposure.elements.CCD_EXPOSURE_VALUE.value = 0
		this.sendSetProperty(this.exposure)

		this.state.ExposureStarted = false
		await this.readImageDataAsFits()

		this.exposure.state = 'Ok'
		this.sendSetProperty(this.exposure)
	}

	private async readImageDataAsFits() {
		const buffer = await this.api.getImageArray(this.id)

		if (buffer) {
			this.image.state = 'Ok'
			const camera = this.client.provider.get(this.client, this.device.DeviceName, 'CAMERA') as Camera
			const lastExposureDuration = this.state.ExposureDuration // await this.api.getLastExposureDuration(this.id)
			const fits = makeFitsFromImageBytes(buffer, camera, this.activeMount, this.activeWheel, this.activeFocuser, this.activeRotator, lastExposureDuration)
			this.image.elements.CCD1.value = fits
		} else {
			this.image.state = 'Alert'
			this.image.elements.CCD1.value = ''
		}

		handleSetBlobVector(this.client, this.handler, this.image)
	}
}

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
}

class AlpacaTelescope extends AlpacaDevice {
	protected readonly api: AlpacaTelescopeApi
	// https://ascom-standards.org/newdocs/telescope.html#Telescope.DeviceState
	// biome-ignore format: too long!
	protected readonly state: AlpacaClientTelescopeState = { Connected: false, Step: 0, CanTrack: false, CanHome: false, CanPark: false, CanMoveAxis: false, CanPulseGuide: false, CanSlew: false, CanSync: false, CanSetGuideRate: false, CanSetSideOfPier: false, Tracking: false, AtPark: false, IsPulseGuiding: false, Slewing: false, RightAscension: 0, Declination: 0, LastUTCDateUpdate: 0 }
	protected readonly initialEndpoints = ['CanHome', 'CanPark', 'CanMoveAxis', 'CanPulseGuide', 'CanTrack', 'CanSlew', 'CanSync', 'CanSetGuideRate', 'SlewRates', 'TrackingRates', 'CanSetSideOfPier'] as const
	protected readonly stateEndpoints = ['AtPark', 'Declination', 'IsPulseGuiding', 'RightAscension', 'SideOfPier', 'Slewing', 'Tracking'] as const
	protected readonly runningEndpoints = ['TrackingRate', 'GuideRateRA', 'GuideRateDEC', 'Latitude', 'Longitude', 'Elevation', 'UTCDate'] as const

	private readonly onCoordSet = makeSwitchVector('', 'ON_COORD_SET', 'On Set', MAIN_CONTROL, 'OneOfMany', 'rw', ['SLEW', 'Slew', false], ['SYNC', 'Sync', false])
	private readonly equatorialCoordinate = makeNumberVector('', 'EQUATORIAL_EOD_COORD', 'Eq. Coordinates', MAIN_CONTROL, 'rw', ['RA', 'RA (hours)', 0, 0, 24, 0.1, '%10.6f'], ['DEC', 'DEC (deg)', 0, -90, 90, 0.1, '%10.6f'])
	private readonly abort = makeSwitchVector('', 'TELESCOPE_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	private readonly trackMode = makeSwitchVector('', 'TELESCOPE_TRACK_MODE', 'Track Mode', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_SIDEREAL', 'Sidereal', true], ['TRACK_SOLAR', 'Solar', false], ['TRACK_LUNAR', 'Lunar', false], ['TRACK_KING', 'King', false])
	private readonly tracking = makeSwitchVector('', 'TELESCOPE_TRACK_STATE', 'Tracking', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_ON', 'On', false], ['TRACK_OFF', 'Off', true])
	private readonly home = makeSwitchVector('', 'TELESCOPE_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['GO', 'Go', false])
	private readonly motionNS = makeSwitchVector('', 'TELESCOPE_MOTION_NS', 'Motion N/S', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_NORTH', 'North', false], ['MOTION_SOUTH', 'South', false])
	private readonly motionWE = makeSwitchVector('', 'TELESCOPE_MOTION_WE', 'Motion W/E', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_WEST', 'West', false], ['MOTION_EAST', 'East', false])
	private readonly slewRate = makeSwitchVector('', 'TELESCOPE_SLEW_RATE', 'Slew Rate', MAIN_CONTROL, 'OneOfMany', 'rw')
	private readonly time = makeTextVector('', 'TIME_UTC', 'UTC', MAIN_CONTROL, 'rw', ['UTC', 'UTC Time', formatTemporal(Date.now(), 'YYYY-MM-DDTHH:mm:ss.SSSZ', 0)], ['OFFSET', 'UTC Offset', (TIMEZONE / 60).toFixed(2)])
	private readonly geographicCoordinate = makeNumberVector('', 'GEOGRAPHIC_COORD', 'Location', MAIN_CONTROL, 'rw', ['LAT', 'Latitude (deg)', 0, -90, 90, 0.1, '%12.8f'], ['LONG', 'Longitude (deg)', 0, 0, 360, 0.1, '%12.8f'], ['ELEV', 'Elevation (m)', 0, -200, 10000, 1, '%.1f'])
	private readonly park = makeSwitchVector('', 'TELESCOPE_PARK', 'Parking', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	private readonly pierSide = makeSwitchVector('', 'TELESCOPE_PIER_SIDE', 'Pier Side', MAIN_CONTROL, 'AtMostOne', 'ro', ['PIER_EAST', 'East', false], ['PIER_WEST', 'West', false])
	private readonly guideRate = makeNumberVector('', 'GUIDE_RATE', 'Guiding Rate', MAIN_CONTROL, 'ro', ['GUIDE_RATE_WE', 'W/E Rate', 0.5, 0, 1, 0.1, '%.8f'], ['GUIDE_RATE_NS', 'N/E Rate', 0.5, 0, 1, 0.1, '%.0f'])
	private readonly guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	private readonly guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaTelescopeApi(client.url)

		this.onCoordSet.device = device.DeviceName
		this.equatorialCoordinate.device = device.DeviceName
		this.abort.device = device.DeviceName
		this.trackMode.device = device.DeviceName
		this.tracking.device = device.DeviceName
		this.home.device = device.DeviceName
		this.motionNS.device = device.DeviceName
		this.motionWE.device = device.DeviceName
		this.slewRate.device = device.DeviceName
		this.time.device = device.DeviceName
		this.geographicCoordinate.device = device.DeviceName
		this.park.device = device.DeviceName
		this.pierSide.device = device.DeviceName
		this.guideRate.device = device.DeviceName
		this.guideNS.device = device.DeviceName
		this.guideWE.device = device.DeviceName

		async function canMoveAxis(id: number) {
			return (await api.canMoveAxis(id, 0)) || (await api.canMoveAxis(id, 1))
		}

		this.runner.registerEndpoint('CanHome', api.canFindHome.bind(api, this.id), false)
		this.runner.registerEndpoint('CanPark', api.canPark.bind(api, this.id), false)
		this.runner.registerEndpoint('CanMoveAxis', canMoveAxis.bind(undefined, this.id), false)
		this.runner.registerEndpoint('CanPulseGuide', api.canPulseGuide.bind(api, this.id), false)
		this.runner.registerEndpoint('CanTrack', api.canSetTracking.bind(api, this.id), false)
		this.runner.registerEndpoint('CanSlew', api.canSlew.bind(api, this.id), false)
		this.runner.registerEndpoint('CanSync', api.canSync.bind(api, this.id), false)
		this.runner.registerEndpoint('CanSetGuideRate', api.canSetGuideRates.bind(api, this.id), false)
		this.runner.registerEndpoint('SlewRates', api.getAxisRates.bind(api, this.id, 0), false)
		this.runner.registerEndpoint('TrackingRates', api.getTrackingRates.bind(api, this.id), false)
		this.runner.registerEndpoint('TrackingRate', api.getTrackingRate.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('CanSetSideOfPier', api.canSetSideOfPier.bind(api, this.id), false)
		this.runner.registerEndpoint('Latitude', api.getSiteLatitude.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('Longitude', api.getSiteLongitude.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('Elevation', api.getSiteElevation.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('GuideRateRA', api.getGuideRateRightAscension.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('GuideRateDEC', api.getGuideRateDeclination.bind(api, this.id), false, 60)
		this.runner.registerEndpoint('AtPark', api.isAtPark.bind(api, this.id), false)
		this.runner.registerEndpoint('Declination', api.getDeclination.bind(api, this.id), false)
		this.runner.registerEndpoint('IsPulseGuiding', api.isPulseGuiding.bind(api, this.id), false)
		this.runner.registerEndpoint('RightAscension', api.getRightAscension.bind(api, this.id), false)
		this.runner.registerEndpoint('SideOfPier', api.getSideOfPier.bind(api, this.id), false)
		this.runner.registerEndpoint('Slewing', api.isSlewing.bind(api, this.id), false)
		this.runner.registerEndpoint('Tracking', api.isTracking.bind(api, this.id), false)
		this.runner.registerEndpoint('UTCDate', api.getUtcDate.bind(api, this.id), false, 60)

		this.api = api
	}

	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, CanTrack, CanHome, CanPark, CanSlew, CanSync, CanMoveAxis, CanPulseGuide, CanSetGuideRate, CanSetSideOfPier, Tracking, AtPark, IsPulseGuiding, Slewing } = this.state
		const { RightAscension, Declination, SlewRates, TrackingRates, TrackingRate, SideOfPier, UTCDate, Latitude, Longitude, Elevation, GuideRateRA, GuideRateDEC } = this.state

		// Initial
		if (Step === 1) {
			this.sendDefProperty(this.equatorialCoordinate)
			this.sendDefProperty(this.abort)

			if (!CanSync) delete this.onCoordSet.elements.SYNC
			if (!CanSlew) delete this.onCoordSet.elements.SLEW
			if (CanSlew || CanSync) this.sendDefProperty(this.onCoordSet)
			if (CanHome) this.sendDefProperty(this.home)
			if (CanPark) this.sendDefProperty(this.park)
			if (CanTrack) this.sendDefProperty(this.tracking)
			if (CanMoveAxis) {
				this.sendDefProperty(this.motionNS)
				this.sendDefProperty(this.motionWE)
			}
			if (CanPulseGuide) {
				if (GuideRateRA !== undefined && GuideRateDEC !== undefined) {
					if (CanSetGuideRate) {
						this.guideRate.permission = 'rw'
					}

					this.guideRate.elements.GUIDE_RATE_WE.value = roundToNthDecimal(GuideRateRA / (SIDEREAL_RATE / 3600), 6)
					this.guideRate.elements.GUIDE_RATE_NS.value = roundToNthDecimal(GuideRateDEC / (SIDEREAL_RATE / 3600), 6)

					this.sendDefProperty(this.guideRate)
				} else {
					this.disableEndpoints('GuideRateRA', 'GuideRateDEC')
				}

				this.sendDefProperty(this.guideNS)
				this.sendDefProperty(this.guideWE)
			}

			if (SlewRates?.length) {
				for (let i = 0; i < SlewRates.length; i++) {
					const name = `RATE_${i}`
					this.slewRate.elements[name] = { name, label: `${SlewRates[i].Maximum.toPrecision(3)} deg/s`, value: i === 0 }
				}

				this.sendDefProperty(this.slewRate)
				this.sendSetProperty(this.slewRate)
			}

			if (TrackingRates?.length) {
				if (!TrackingRates.includes(0)) delete this.trackMode.elements.TRACK_SIDEREAL
				if (!TrackingRates.includes(1)) delete this.trackMode.elements.TRACK_LUNAR
				if (!TrackingRates.includes(2)) delete this.trackMode.elements.TRACK_SOLAR
				if (!TrackingRates.includes(3)) delete this.trackMode.elements.TRACK_KING
				this.sendDefProperty(this.trackMode)
			} else {
				this.disableEndpoints('TrackingRate')
			}

			if (CanSetSideOfPier) {
				this.pierSide.permission = 'rw'
			}

			if (UTCDate) {
				const now = Date.now()

				if (now - this.state.LastUTCDateUpdate >= 60000) {
					this.state.LastUTCDateUpdate = now
					this.time.elements.UTC.value = UTCDate.substring(0, 19)
					this.sendDefProperty(this.time)
				}
			}

			this.geographicCoordinate.elements.LAT.value = Latitude ?? 0
			this.geographicCoordinate.elements.LONG.value = Longitude ?? 0
			this.geographicCoordinate.elements.ELEV.value = Elevation ?? 0
			this.sendDefProperty(this.geographicCoordinate)

			this.sendDefProperty(this.pierSide)

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			CanTrack && this.updatePropertyValue(this.tracking, Tracking ? 'TRACK_ON' : 'TRACK_OFF', true) && this.sendSetProperty(this.tracking)
			CanPark && this.updatePropertyValue(this.park, AtPark ? 'PARK' : 'UNPARK', true) && this.sendSetProperty(this.park)

			if (SideOfPier !== undefined) {
				if (SideOfPier === -1) {
					let updated = this.updatePropertyValue(this.pierSide, 'PIER_EAST', false)
					updated = this.updatePropertyValue(this.pierSide, 'PIER_WEST', false) || updated
					updated && this.sendSetProperty(this.pierSide)
				} else {
					this.updatePropertyValue(this.pierSide, SideOfPier === 0 ? 'PIER_EAST' : 'PIER_WEST', true) && this.sendSetProperty(this.pierSide)
				}
			}

			if (CanPulseGuide && this.updatePropertyState(this.guideNS, IsPulseGuiding ? 'Busy' : 'Idle')) {
				this.guideWE.state = this.guideNS.state
				this.sendSetProperty(this.guideNS)
				this.sendSetProperty(this.guideWE)
			}

			if (TrackingRate !== undefined) {
				this.updatePropertyValue(this.trackMode, TrackingRate === 0 ? 'TRACK_SIDEREAL' : TrackingRate === 1 ? 'TRACK_LUNAR' : TrackingRate === 2 ? 'TRACK_SOLAR' : 'TRACK_KING', true) && this.sendSetProperty(this.trackMode)
				this.state.TrackingRate = undefined
			}

			if (GuideRateRA !== undefined && GuideRateDEC !== undefined) {
				let updated = this.updatePropertyValue(this.guideRate, 'GUIDE_RATE_WE', roundToNthDecimal(GuideRateRA / (SIDEREAL_RATE / 3600), 6))
				updated = this.updatePropertyValue(this.guideRate, 'GUIDE_RATE_NS', roundToNthDecimal(GuideRateDEC / (SIDEREAL_RATE / 3600), 6)) || updated
				updated && this.sendSetProperty(this.guideRate)
				this.state.GuideRateRA = undefined
				this.state.GuideRateDEC = undefined
			}

			if (Latitude !== undefined && Longitude !== undefined) {
				let updated = this.updatePropertyValue(this.geographicCoordinate, 'LAT', Latitude)
				updated = this.updatePropertyValue(this.geographicCoordinate, 'LONG', Longitude) || updated
				if (Elevation !== undefined) updated = this.updatePropertyValue(this.geographicCoordinate, 'ELEV', Elevation) || updated
				updated && this.sendSetProperty(this.geographicCoordinate)
				this.state.Latitude = undefined
				this.state.Longitude = undefined
				this.state.Elevation = undefined
			}

			if (UTCDate !== undefined) {
				this.time.elements.UTC.value = UTCDate.substring(0, 19)
				this.sendSetProperty(this.time)
				this.state.UTCDate = undefined
			}

			let updated = this.updatePropertyState(this.equatorialCoordinate, Slewing ? 'Busy' : 'Idle')
			updated = this.updatePropertyValue(this.equatorialCoordinate, 'RA', RightAscension) || updated
			updated = this.updatePropertyValue(this.equatorialCoordinate, 'DEC', Declination) || updated
			updated && this.sendSetProperty(this.equatorialCoordinate)
		}

		return true
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'TELESCOPE_SLEW_RATE': {
				if (this.state.SlewRates?.length) {
					const selected = findOnSwitch(vector)[0]
					selected && this.updatePropertyValue(this.slewRate, selected, true) && this.sendSetProperty(this.slewRate)
				}

				break
			}
			case 'TELESCOPE_MOTION_NS':
			case 'TELESCOPE_MOTION_WE': {
				if (this.state.CanMoveAxis && this.state.SlewRates?.length) {
					const { MOTION_NORTH, MOTION_SOUTH, MOTION_WEST, MOTION_EAST } = vector.elements
					const { Maximum } = this.state.SlewRates[+findOnSwitch(this.slewRate)[0].substring(5)]

					if (vector.name.endsWith('S')) {
						if (MOTION_NORTH === true || MOTION_SOUTH === true) {
							void this.api.moveAxis(this.id, 1, MOTION_NORTH === true ? +Maximum : -Maximum)
						} else if (MOTION_NORTH === false || MOTION_SOUTH === false) {
							void this.api.moveAxis(this.id, 1, 0)
						}
					} else if (MOTION_WEST === true || MOTION_EAST === true) {
						void this.api.moveAxis(this.id, 0, MOTION_WEST === true ? +Maximum : -Maximum)
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
				if (vector.elements.SLEW === true || vector.elements.TRACK === true) this.updatePropertyValue(this.onCoordSet, 'SLEW', true)
				else if (vector.elements.SYNC === true) this.updatePropertyValue(this.onCoordSet, 'SYNC', true)
				else break
				this.sendSetProperty(this.onCoordSet)
				break
		}
	}

	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'EQUATORIAL_EOD_COORD':
				if (vector.elements.RA !== undefined || vector.elements.DEC !== undefined) {
					void this.moveToTarget(vector.elements.RA, vector.elements.DEC)
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

	sendText(vector: NewTextVector) {
		super.sendText(vector)

		switch (vector.name) {
			case 'TIME_UTC':
				if (vector.elements.UTC && vector.elements.UTC.length >= 19) {
					this.updatePropertyValue(this.time, 'OFFSET', vector.elements.OFFSET)
					const utc = vector.elements.UTC.substring(0, 19)
					void this.api.setUtcDate(this.id, `${utc}Z`)
					this.state.LastUTCDateUpdate = 0
					this.enableEndpoints('UTCDate')
				}

				break
		}
	}

	private async moveToTarget(rightAscension?: number, declination?: number) {
		if (rightAscension !== undefined && declination !== undefined) {
			if (this.onCoordSet.elements.SLEW?.value === true) await this.api.slewToCoordinatesAsync(this.id, rightAscension, declination)
			else if (this.onCoordSet.elements.SYNC?.value === true) await this.api.syncToCoordinates(this.id, rightAscension, declination)
		} else if (rightAscension !== undefined) {
			if (this.onCoordSet.elements.SLEW?.value === true) await this.api.slewToCoordinatesAsync(this.id, rightAscension, this.state.Declination)
			else if (this.onCoordSet.elements.SYNC?.value === true) await this.api.syncToCoordinates(this.id, rightAscension, this.state.Declination)
		} else if (declination !== undefined) {
			if (this.onCoordSet.elements.SLEW?.value === true) await this.api.slewToCoordinatesAsync(this.id, this.state.RightAscension, declination)
			else if (this.onCoordSet.elements.SYNC?.value === true) await this.api.syncToCoordinates(this.id, this.state.RightAscension, declination)
		}
	}
}

interface AlpacaClientFilterWheelState extends AlpacaClientDeviceState {
	readonly Position: number
	readonly Names?: string[]
}

class AlpacaFilterWheel extends AlpacaDevice {
	private readonly position = makeNumberVector('', 'FILTER_SLOT', 'Position', MAIN_CONTROL, 'rw', ['FILTER_SLOT_VALUE', 'Slot', 1, 1, 1, 1, '%.0f'])
	private readonly names = makeTextVector('', 'FILTER_NAME', 'Filter', MAIN_CONTROL, 'ro')

	protected readonly api: AlpacaFilterWheelApi
	// https://ascom-standards.org/newdocs/filterwheel.html#FilterWheel.DeviceState
	protected readonly state: AlpacaClientFilterWheelState = { Connected: false, DeviceState: undefined, Step: 0, Position: 0, Names: undefined }
	protected readonly initialEndpoints = ['Names'] as const
	protected readonly stateEndpoints = ['Position'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaFilterWheelApi(client.url)

		this.position.device = device.DeviceName
		this.names.device = device.DeviceName

		this.runner.registerEndpoint('Names', api.getNames.bind(api, this.id), false)
		this.runner.registerEndpoint('Position', api.getPosition.bind(api, this.id), false)

		this.api = api
	}

	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, Position, Names } = this.state

		// Initial
		if (Step === 1) {
			if (Names?.length) {
				this.position.elements.FILTER_SLOT_VALUE.max = Names.length

				for (let i = 0, p = 1; i < Names.length; i++, p++) {
					const name = `FILTER_SLOT_NAME_${p}`
					this.names.elements[name] = { name, label: `Filter ${p}`, value: Names[i] }
				}

				this.sendDefProperty(this.names)
				this.sendDefProperty(this.position)
			}

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			let updated = this.updatePropertyState(this.position, Position === -1 ? 'Busy' : 'Idle')
			if (Position >= 0) updated = this.updatePropertyValue(this.position, 'FILTER_SLOT_VALUE', Position + 1) || updated
			updated && this.sendSetProperty(this.position)
		}

		return true
	}

	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'FILTER_SLOT':
				void this.api.setPosition(this.id, vector.elements.FILTER_SLOT_VALUE - 1)
		}
	}
}

interface AlpacaClientFocuserState extends AlpacaClientDeviceState {
	readonly IsMoving: boolean
	readonly Position: number
	readonly Temperature?: number
	readonly IsAbsolute: boolean
	readonly MaxStep: number
}

class AlpacaFocuser extends AlpacaDevice {
	private readonly absolutePosition = makeNumberVector('', 'ABS_FOCUS_POSITION', 'Absolute Position', MAIN_CONTROL, 'rw', ['FOCUS_ABSOLUTE_POSITION', 'Position', 0, 0, 0, 1, '%.0f'])
	private readonly relativePosition = makeNumberVector('', 'REL_FOCUS_POSITION', 'Relative Position', MAIN_CONTROL, 'rw', ['FOCUS_RELATIVE_POSITION', 'Steps', 0, 0, 0, 1, '%.0f'])
	private readonly temperature = makeNumberVector('', 'FOCUS_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'ro', ['TEMPERATURE', 'Temperature', 0, -50, 70, 0.1, '%6.2f'])
	private readonly abort = makeSwitchVector('', 'FOCUS_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	private readonly direction = makeSwitchVector('', 'FOCUS_MOTION', 'Direction', MAIN_CONTROL, 'OneOfMany', 'rw', ['FOCUS_INWARD', 'In', true], ['FOCUS_OUTWARD', 'Out', false])

	private position = this.absolutePosition

	protected readonly api: AlpacaFocuserApi
	// https://ascom-standards.org/newdocs/focuser.html#Focuser.DeviceState
	protected readonly state: AlpacaClientFocuserState = { Connected: false, DeviceState: undefined, Step: 0, IsMoving: false, Position: 0, Temperature: undefined, IsAbsolute: false, MaxStep: 0 }
	protected readonly initialEndpoints = ['MaxStep', 'IsAbsolute'] as const
	protected readonly stateEndpoints = ['IsMoving', 'Position', 'Temperature'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaFocuserApi(client.url)

		this.absolutePosition.device = device.DeviceName
		this.relativePosition.device = device.DeviceName
		this.temperature.device = device.DeviceName
		this.abort.device = device.DeviceName
		this.direction.device = device.DeviceName

		this.runner.registerEndpoint('Temperature', api.getTemperature.bind(api, this.id), false)
		this.runner.registerEndpoint('IsAbsolute', api.isAbsolute.bind(api, this.id), false)
		this.runner.registerEndpoint('MaxStep', api.getMaxStep.bind(api, this.id), false)
		this.runner.registerEndpoint('Position', api.getPosition.bind(api, this.id), false)
		this.runner.registerEndpoint('IsMoving', api.isMoving.bind(api, this.id), false)

		this.api = api
	}

	get isAbsolute() {
		return this.position === this.absolutePosition
	}

	get isFocusIn() {
		return this.direction.elements.FOCUS_INWARD.value === true
	}

	get isFocusOut() {
		return this.direction.elements.FOCUS_OUTWARD.value === true
	}

	protected handleEndpointsAfterRun() {
		if (!super.handleEndpointsAfterRun()) return false

		const { Step, IsAbsolute, IsMoving, Position, Temperature, MaxStep } = this.state

		// Initial
		if (Step === 1) {
			if (MaxStep) {
				if (IsAbsolute) {
					this.absolutePosition.elements.FOCUS_ABSOLUTE_POSITION.max = MaxStep
					this.position = this.absolutePosition
				} else {
					this.relativePosition.elements.FOCUS_RELATIVE_POSITION.max = MaxStep
					this.position = this.relativePosition
				}

				this.sendDefProperty(this.position)
			}

			if (Temperature !== undefined) {
				this.temperature.elements.TEMPERATURE.value = Math.trunc(Temperature)
				this.sendDefProperty(this.temperature)
			}

			this.sendDefProperty(this.direction)
			this.sendDefProperty(this.abort)

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			let updated = this.updatePropertyState(this.position, IsMoving ? 'Busy' : 'Idle')
			if (IsAbsolute) updated = this.updatePropertyValue(this.position, 'FOCUS_ABSOLUTE_POSITION', Position) || updated
			updated && this.sendSetProperty(this.position)

			if (Temperature !== undefined) {
				this.updatePropertyValue(this.temperature, 'TEMPERATURE', Math.trunc(Temperature)) && this.sendSetProperty(this.temperature)
			}
		}

		return true
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'FOCUS_ABORT_MOTION':
				if (vector.elements.ABORT === true) void this.api.halt(this.id)
				break
			case 'FOCUS_MOTION':
				if (vector.elements.FOCUS_INWARD === true) this.updatePropertyValue(this.direction, 'FOCUS_INWARD', true)
				else if (vector.elements.FOCUS_OUTWARD === true) this.updatePropertyValue(this.direction, 'FOCUS_OUTWARD', true)
				break
		}
	}

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

interface AlpacaClientCoverCalibratorState extends AlpacaClientDeviceState {
	readonly CoverState: number
	readonly CoverMoving: boolean
	readonly CalibratorState: number
	readonly Brightness: number
	readonly MaxBrightness?: number
}

class AlpacaCoverCalibrator extends AlpacaDevice {
	protected readonly api: AlpacaCoverCalibratorApi

	private readonly light = makeSwitchVector('', 'FLAT_LIGHT_CONTROL', 'Light', MAIN_CONTROL, 'OneOfMany', 'rw', ['FLAT_LIGHT_ON', 'On', false], ['FLAT_LIGHT_OFF', 'Off', true])
	private readonly brightness = makeNumberVector('', 'FLAT_LIGHT_INTENSITY', 'Brightness', MAIN_CONTROL, 'rw', ['FLAT_LIGHT_INTENSITY_VALUE', 'Brightness', 0, 0, 0, 1, '%.0f'])
	private readonly park = makeSwitchVector('', 'CAP_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	private readonly abort = makeSwitchVector('', 'CAP_ABORT', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	// https://ascom-standards.org/newdocs/covercalibrator.html#CoverCalibrator.DeviceState
	protected readonly state: AlpacaClientCoverCalibratorState = { Connected: false, DeviceState: undefined, Step: 0, CoverState: 0, CoverMoving: false, CalibratorState: 0, Brightness: 0, MaxBrightness: undefined }
	protected readonly initialEndpoints = ['MaxBrightness'] as const
	protected readonly stateEndpoints = ['Brightness', 'CalibratorState', 'CoverMoving', 'CoverState'] as const

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		const api = new AlpacaCoverCalibratorApi(client.url)

		this.light.device = device.DeviceName
		this.brightness.device = device.DeviceName
		this.park.device = device.DeviceName
		this.abort.device = device.DeviceName

		this.runner.registerEndpoint('MaxBrightness', api.getMaxBrightness.bind(api, this.id), false)
		this.runner.registerEndpoint('Brightness', api.getBrightness.bind(api, this.id), false)
		// this.runner.registerEndpoint('CalibratorChanging', api.isChanging.bind(api, this.id), false)
		this.runner.registerEndpoint('CalibratorState', api.getCalibratorState.bind(api, this.id), false)
		this.runner.registerEndpoint('CoverMoving', api.isMoving.bind(api, this.id), false)
		this.runner.registerEndpoint('CoverState', api.getCoverState.bind(api, this.id), false)

		this.api = api
	}

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
				this.sendDefProperty(this.park)
				this.sendDefProperty(this.abort)
			}

			if (hasCalibrator) {
				if (MaxBrightness) {
					this.sendDefProperty(this.light)
					this.brightness.elements.FLAT_LIGHT_INTENSITY_VALUE.max = MaxBrightness
					this.sendDefProperty(this.brightness)
				}
			}

			this.disableEndpoints(...this.initialEndpoints)

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			if (CoverState !== 0) {
				let updated = this.updatePropertyState(this.park, CoverState === 2 || CoverMoving ? 'Busy' : 'Idle')
				if (CoverState === 1 || CoverState === 2) updated = this.updatePropertyValue(this.park, CoverState === 1 ? 'PARK' : 'UNPARK', true) || updated
				updated && this.sendSetProperty(this.park)
			}

			if (CalibratorState !== 0) {
				if (CalibratorState === 3) {
					this.updatePropertyValue(this.light, 'FLAT_LIGHT_ON', true) && this.sendSetProperty(this.light)
					this.updatePropertyValue(this.brightness, 'FLAT_LIGHT_INTENSITY_VALUE', Brightness as number) && this.sendSetProperty(this.brightness)
				} else if (CalibratorState === 1) {
					this.updatePropertyValue(this.light, 'FLAT_LIGHT_OFF', true) && this.sendSetProperty(this.light)
				}
			}
		}

		return true
	}

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
				if (vector.elements.FLAT_LIGHT_ON === true) void this.api.on(this.id, Math.max(1, this.brightness.elements.FLAT_LIGHT_INTENSITY_VALUE.value))
				else if (vector.elements.FLAT_LIGHT_OFF === true) void this.api.off(this.id)
				break
		}
	}

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

function normalizeLongitude(angle: number) {
	angle = angle % 360
	if (angle > 180) angle -= 360
	return angle
}

function makeSwitchVector(device: string, name: string, label: string, group: string, rule: SwitchRule, permission: PropertyPermission, ...properties: readonly [string, string, boolean][]): DefSwitchVector & { type: 'SWITCH' } {
	const elements: Record<string, DefSwitch> = {}
	for (const [name, label, value] of properties) elements[name] = { name, label, value }
	return { type: 'SWITCH', device, name, label, group, permission, rule, state: 'Idle', timeout: 60, elements }
}

function makeNumberVector(device: string, name: string, label: string, group: string, permission: PropertyPermission, ...properties: readonly [string, string, number, number, number, number, string][]): DefNumberVector & { type: 'NUMBER' } {
	const elements: Record<string, DefNumber> = {}
	for (const [name, label, value, min, max, step, format] of properties) elements[name] = { name, label, value, min, max, step, format }
	return { type: 'NUMBER', device, name, label, group, permission, state: 'Idle', timeout: 60, elements }
}

function makeTextVector(device: string, name: string, label: string, group: string, permission: PropertyPermission, ...properties: readonly [string, string, string][]): DefTextVector & { type: 'TEXT' } {
	const elements: Record<string, DefText> = {}
	for (const [name, label, value] of properties) elements[name] = { name, label, value }
	return { type: 'TEXT', device, name, label, group, permission, state: 'Idle', timeout: 60, elements }
}

function makeBlobVector(device: string, name: string, label: string, group: string, permission: PropertyPermission, ...properties: readonly [string, string][]): Omit<DefBlobVector, 'elements'> & SetBlobVector & { type: 'BLOB' } {
	const elements: Record<string, Omit<DefBlob, 'value'> & OneBlob> = {}
	for (const [name, label] of properties) elements[name] = { name, label, size: '0', format: 'fits', value: '' }
	return { type: 'BLOB', device, name, label, group, permission, state: 'Idle', timeout: 60, elements }
}

export function makeFitsFromImageBytes(data: ArrayBuffer, camera?: Camera, mount?: Mount, wheel?: Wheel, focuser?: Focuser, rotator?: Rotator, lastExposureDuration: number = 0) {
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
		;[rightAscension, declination] = equatorialToJ2000(mount.equatorialCoordinate.rightAscension, mount.equatorialCoordinate.declination)
	}

	// https://github.com/indilib/indi/blob/3b0cdcb6caf41c859b77c6460981772fe8d5d22d/libs/indibase/indiccd.cpp#L2028
	const header: FitsHeader = {
		SIMPLE: true,
		BITPIX: 16,
		NAXIS: metadata.Rank,
		NAXIS1: NumX,
		NAXIS2: NumY,
		NAXIS3: NumZ === 3 ? 3 : undefined,
		EXTEND: true,
		BZERO: 32768,
		BSCALE: 1,
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
		ROTATANG: rotator ? toDeg(rotator.angle.value) : undefined,
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
		END: '',
	}

	const estimatedHeaderSize = Object.keys(header).filter((e) => header[e] !== undefined).length * 80 + FITS_BLOCK_SIZE
	const estimatedDataSize = NumX * NumY * NumZ * 2 // 16-bit
	const fits = Buffer.allocUnsafe(estimatedHeaderSize + computeRemainingBytes(estimatedHeaderSize) + estimatedDataSize + computeRemainingBytes(estimatedDataSize))
	const writer = new FitsKeywordWriter()
	const offset = writer.writeAll(header, fits)
	const dataView = new DataView(data, 44)
	const fitsView = new DataView(fits.buffer, offset + computeRemainingBytes(offset))

	const strideInBytes = NumX * 2
	const planeInBytes = strideInBytes * NumY

	// unsigned 16-bit
	if (metadata.TransmissionElementType === 8) {
		for (let i = 0, a = 0; i < NumX; i++) {
			const p = i * 2

			for (let j = 0; j < NumY; j++) {
				const m = strideInBytes * j + p

				for (let k = 0, b = m; k < NumZ; k++, a += 2, b += planeInBytes) {
					fitsView.setInt16(b, dataView.getUint16(a, true) - 32768, false)
				}
			}
		}
	}

	const fileSize = fitsView.byteOffset + estimatedDataSize

	return fits.subarray(0, fileSize)
}

type AlpacaApiRunnerEndpoint = () => PromiseLike<unknown>

type AlpacaApiRunnerHandlerAfterRun = () => void

class AlpacaApiRunner {
	private readonly keys: string[] = []
	private readonly endpoints: AlpacaApiRunnerEndpoint[] = []
	private readonly enabled: boolean[] = []
	private readonly interval: number[] = []
	private readonly count: number[] = []
	private readonly result: (PromiseLike<unknown> | undefined)[] = []
	private readonly handlers = new Set<AlpacaApiRunnerHandlerAfterRun>()

	registerEndpoint(key: string, endpoint: AlpacaApiRunnerEndpoint, enabled: boolean, interval: number = 1) {
		const index = this.keys.indexOf(key)

		if (index >= 0) {
			this.keys[index] = key
			this.endpoints[index] = endpoint
			this.enabled[index] = enabled
			this.interval[index] = interval
			this.count[index] = 0
		} else {
			this.keys.push(key)
			this.endpoints.push(endpoint)
			this.enabled.push(enabled)
			this.interval.push(interval)
			this.count.push(0)
		}
	}

	unregisterEndpoint(key: string) {
		const index = this.keys.indexOf(key)

		if (index >= 0) {
			this.keys.splice(index, 1)
			this.endpoints.splice(index, 1)
			this.enabled.splice(index, 1)
			this.result.splice(index, 1)
		}
	}

	toggleEndpoint(key: string, force?: boolean) {
		const index = this.keys.indexOf(key)
		if (index >= 0) this.enabled[index] = force ?? !this.enabled[index]
		else console.warn('endpoint not found:', key)
		if (index >= 0 && this.enabled[index]) this.count[index] = 0
	}

	isEndpointEnabled(key: string) {
		const index = this.keys.indexOf(key)
		return index >= 0 && this.enabled[index]
	}

	registerHandler(handler: AlpacaApiRunnerHandlerAfterRun) {
		this.handlers.add(handler)
	}

	unregisterHandler(handler: AlpacaApiRunnerHandlerAfterRun) {
		this.handlers.delete(handler)
	}

	run(state: Record<string, ValueType>) {
		const n = this.keys.length

		for (let i = 0; i < n; i++) {
			if (this.enabled[i] && (this.interval[i] <= 1 || this.count[i] % this.interval[i] === 0)) {
				this.result[i] = this.endpoints[i]()
			} else {
				this.result[i] = undefined
			}

			this.count[i]++
		}

		return this.handleEndpointsAfterRun(state)
	}

	private async handleEndpointsAfterRun(state: Record<string, ValueType>) {
		const result = await Promise.all(this.result)
		const n = result.length

		for (let i = 0; i < n; i++) {
			const value = result[i] as never

			if (this.enabled[i]) {
				state[this.keys[i]] = value
			}
		}

		for (const handler of this.handlers) {
			handler()
		}
	}
}
