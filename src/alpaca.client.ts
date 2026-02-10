import { AlpacaCoverCalibratorApi, type AlpacaDeviceApi, AlpacaFilterWheelApi, AlpacaFocuserApi, AlpacaManagementApi, AlpacaTelescopeApi } from './alpaca.api'
import type { AlpacaAxisRate, AlpacaConfiguredDevice, AlpacaDeviceType, AlpacaStateItem } from './alpaca.types'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetNumberVector, handleSetSwitchVector, handleSetTextVector, type IndiClientHandler } from './indi.client'
import type { Client } from './indi.device'
import type { DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefText, DefTextVector, DefVector, EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector, PropertyPermission, PropertyState, SwitchRule, ValueType, VectorType } from './indi.types'
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
			this.devices.get(command.device)?.sendProperties()
		} else {
			this.devices.forEach((e) => e.sendProperties())
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

				if (type === 'telescope') {
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
		this.devices.forEach((e) => e.update())
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined

			this.devices.forEach((e) => e.close())
			this.devices.clear()

			this.options?.handler?.close?.(this, false)
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

interface AlpacaDeviceState {
	Connected: boolean
	DeviceState?: readonly AlpacaStateItem[]
	Step: number
}

abstract class AlpacaDevice {
	readonly id: number

	protected readonly runner = new AlpacaApiRunner()
	protected readonly properties = new Set<DefVector & { type: Uppercase<VectorType> }>()

	protected abstract api: AlpacaDeviceApi
	protected abstract state: { Connected: boolean; DeviceState?: readonly AlpacaStateItem[]; Step: number }

	protected readonly driverInfo = makeTextVector('', 'DRIVER_INFO', 'Driver Info', GENERAL_INFO, 'ro', ['DRIVER_INTERFACE', 'Interface', ''], ['DRIVER_EXEC', 'Exec', ''], ['DRIVER_VERSION', 'Version', '1.0'], ['DRIVER_NAME', 'Name', ''])
	protected readonly connection = makeSwitchVector('', 'CONNECTION', 'Connection', MAIN_CONTROL, 'OneOfMany', 'rw', ['CONNECT', 'Connect', false], ['DISCONNECT', 'Disconnect', true])

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

		this.runner.registerHandler(this.handleEndpointsAfterRun.bind(this))

		this.runner.registerEndpoint('Connected', () => this.api.isConnected(this.id), true)
		this.runner.registerEndpoint('DeviceState', () => this.api.deviceState(this.id), false)
	}

	get isConnected() {
		return this.connection.elements.CONNECT.value === true
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
			if (type[0] === 'S') {
				const { rule } = property as DefSwitchVector

				if (rule === 'OneOfMany') {
					if (value === true) {
						element.value = value

						for (const p in elements) {
							if (p !== name) {
								elements[p].value = false
							}
						}

						return true
					}
				} else if (rule !== 'AtMostOne') {
					element.value = value
					return true
				}
			} else {
				element.value = value
				return true
			}
		}

		return false
	}

	sendProperties() {
		for (const property of this.properties) {
			this.sendDefProperty(property)
			this.sendSetProperty(property)
		}
	}

	onInit() {
		this.sendDefProperty(this.driverInfo)
		this.sendDefProperty(this.connection)
	}

	protected onConnect() {
		this.state.Step = 0
		this.runner.toggleEndpoint('DeviceState', true)
	}

	protected onDisconnect() {
		this.state.Step = 0
		this.state.DeviceState = undefined
		this.runner.toggleEndpoint('DeviceState', false)
	}

	update() {
		this.runner.run(this.state as never)
	}

	protected handleEndpointsAfterRun() {
		const { Connected, DeviceState } = this.state

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

		if (DeviceState?.length) {
			this.state.Step = 1 // Initial
			mapDeviceStateInto(DeviceState, this.state as never)
		}
	}

	protected enableEndpoints(...keys: string[]) {
		for (const key of keys) this.runner.toggleEndpoint(key, true)
	}

	protected disableEndpoints(...keys: string[]) {
		for (const key of keys) this.runner.toggleEndpoint(key, false)
	}

	sendText(vector: NewTextVector) {}

	sendNumber(vector: NewNumberVector) {}

	private async handleConnection(mode: 'connect' | 'disconnect') {
		this.connection.state = 'Busy'
		this.sendSetProperty(this.connection)

		const ok = (await this.api[mode](this.id)) === true
		this.connection.state = ok ? 'Idle' : 'Alert'
		this.sendSetProperty(this.connection)
	}

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

	close() {}
}

interface AlpacaTelescopeState extends AlpacaDeviceState {
	CanHome: boolean
	CanPark: boolean
	CanMoveAxis: boolean
	CanPulseGuide: boolean
	CanTrack: boolean
	Tracking: boolean
	AtPark: boolean
	IsPulseGuiding: boolean
	Slewing: boolean
	RightAscension: number
	Declination: number
	SlewRates?: readonly AlpacaAxisRate[]
}

class AlpacaTelescope extends AlpacaDevice {
	protected readonly api: AlpacaTelescopeApi
	// https://ascom-standards.org/newdocs/telescope.html#Telescope.DeviceState
	protected readonly state: AlpacaTelescopeState = { Connected: false, Step: 0, CanTrack: false, CanHome: false, CanPark: false, CanMoveAxis: false, CanPulseGuide: false, Tracking: false, AtPark: false, IsPulseGuiding: false, Slewing: false, RightAscension: 0, Declination: 0 }

	private readonly onCoordSet = makeSwitchVector('', 'ON_COORD_SET', 'On Set', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK', 'Track', true], ['SLEW', 'Slew', false], ['SYNC', 'Sync', false])
	private readonly equatorialCoordinate = makeNumberVector('', 'EQUATORIAL_EOD_COORD', 'Eq. Coordinates', MAIN_CONTROL, 'rw', ['RA', 'RA (hours)', 0, 0, 24, 0.1, '%10.6f'], ['DEC', 'DEC (deg)', 0, -90, 90, 0.1, '%10.6f'])
	private readonly abort = makeSwitchVector('', 'TELESCOPE_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	private readonly trackMode = makeSwitchVector('', 'TELESCOPE_TRACK_MODE', 'Track Mode', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_SIDEREAL', 'Sidereal', true], ['TRACK_SOLAR', 'Solar', false], ['TRACK_LUNAR', 'Lunar', false], ['TRACK_KING', 'King', false])
	private readonly tracking = makeSwitchVector('', 'TELESCOPE_TRACK_STATE', 'Tracking', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_ON', 'On', false], ['TRACK_OFF', 'Off', true])
	private readonly home = makeSwitchVector('', 'TELESCOPE_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['GO', 'Go', false])
	private readonly motionNS = makeSwitchVector('', 'TELESCOPE_MOTION_NS', 'Motion N/S', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_NORTH', 'North', false], ['MOTION_SOUTH', 'South', false])
	private readonly motionWE = makeSwitchVector('', 'TELESCOPE_MOTION_WE', 'Motion W/E', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_WEST', 'West', false], ['MOTION_EAST', 'East', false])
	private readonly slewRate = makeSwitchVector('', 'TELESCOPE_SLEW_RATE', 'Slew Rate', MAIN_CONTROL, 'OneOfMany', 'rw')
	private readonly time = makeTextVector('', 'TIME_UTC', 'UTC', MAIN_CONTROL, 'rw', ['UTC', 'UTC Time', formatTemporal(Date.now(), 'YYYY-MM-DDTHH:mm:ss', 0)], ['OFFSET', 'UTC Offset', (TIMEZONE / 60).toFixed(2)])
	private readonly geographicCoordinate = makeNumberVector('', 'GEOGRAPHIC_COORD', 'Location', MAIN_CONTROL, 'rw', ['LAT', 'Latitude (deg)', 0, -90, 90, 0.1, '%12.8f'], ['LONG', 'Longitude (deg)', 0, 0, 360, 0.1, '%12.8f'], ['ELEV', 'Elevation (m)', 0, -200, 10000, 1, '%.1f'])
	private readonly park = makeSwitchVector('', 'TELESCOPE_PARK', 'Parking', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	private readonly pierSide = makeSwitchVector('', 'TELESCOPE_PIER_SIDE', 'Pier Side', MAIN_CONTROL, 'AtMostOne', 'ro', ['PIER_EAST', 'East', false], ['PIER_WEST', 'West', false])
	private readonly guideRate = makeNumberVector('', 'GUIDE_RATE', 'Guiding Rate', MAIN_CONTROL, 'rw', ['GUIDE_RATE_WE', 'W/E Rate', 0.5, 0, 1, 0.1, '%.8f'], ['GUIDE_RATE_NS', 'N/E Rate', 0.5, 0, 1, 0.1, '%.0f'])
	private readonly guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	private readonly guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaTelescopeApi(client.url)

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

		this.runner.registerEndpoint('CanHome', () => this.api.canFindHome(this.id), false)
		this.runner.registerEndpoint('CanPark', () => this.api.canPark(this.id), false)
		this.runner.registerEndpoint('CanMoveAxis', async () => (await this.api.canMoveAxis(this.id, 0)) || (await this.api.canMoveAxis(this.id, 1)), false)
		this.runner.registerEndpoint('CanPulseGuide', () => this.api.canPulseGuide(this.id), false)
		this.runner.registerEndpoint('CanTrack', () => this.api.canSetTracking(this.id), false)
		this.runner.registerEndpoint('SlewRates', () => this.api.getAxisRates(this.id), false)
		// this.runner.registerEndpoint('RightAscension', () => this.api.getRightAscension(this.id), false)
		// this.runner.registerEndpoint('Declination', () => this.api.getDeclination(this.id), false)
		// this.runner.registerEndpoint('Slewing', () => this.api.isSlewing(this.id), false)
		// this.runner.registerEndpoint('Tracking', () => this.api.isTracking(this.id), false)
		// this.runner.registerEndpoint('AtPark', () => this.api.isAtPark(this.id), false)
		// this.runner.registerEndpoint('IsPulseGuiding', () => this.api.isPulseGuiding(this.id), false)
	}

	protected onConnect() {
		super.onConnect()

		this.sendDefProperty(this.onCoordSet)
		this.sendDefProperty(this.equatorialCoordinate)
		this.sendDefProperty(this.abort)

		this.enableEndpoints('CanHome', 'CanPark', 'CanMoveAxis', 'CanPulseGuide', 'CanTrack', 'SlewRates')
	}

	protected onDisconnect() {
		this.sendDelProperty(this.home)

		this.disableEndpoints('CanHome', 'CanPark', 'CanMoveAxis', 'CanPulseGuide', 'CanTrack', 'SlewRates')
	}

	protected handleEndpointsAfterRun() {
		super.handleEndpointsAfterRun()

		const { Connected, Step, CanTrack, CanHome, CanPark, CanMoveAxis, CanPulseGuide, Tracking, AtPark, IsPulseGuiding, Slewing, RightAscension, Declination, SlewRates } = this.state

		if (!Connected) return

		// Initial
		if (Step === 1) {
			if (CanHome) this.sendDefProperty(this.home)
			if (CanPark) this.sendDefProperty(this.park)
			if (CanTrack) this.sendDefProperty(this.tracking)
			if (CanMoveAxis) {
				this.sendDefProperty(this.motionNS)
				this.sendDefProperty(this.motionWE)
			}
			if (CanPulseGuide) {
				this.sendDefProperty(this.guideNS)
				this.sendDefProperty(this.guideWE)
			}

			if (SlewRates?.length) {
				for (let i = 0; i < SlewRates.length; i++) {
					const name = `RATE_${i}`
					this.slewRate.elements[name] = { name, label: SlewRates[i].Maximum.toString(), value: i === 0 }
				}

				this.sendDefProperty(this.slewRate)
			}

			this.disableEndpoints('CanHome', 'CanPark', 'CanMoveAxis', 'CanPulseGuide', 'CanTrack', 'SlewRates')

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			CanTrack && this.updatePropertyValue(this.tracking, Tracking ? 'TRACK_ON' : 'TRACK_OFF', true) && this.sendSetProperty(this.tracking)
			CanPark && this.updatePropertyValue(this.park, AtPark ? 'PARK' : 'UNPARK', true) && this.sendSetProperty(this.park)

			if (this.updatePropertyState(this.guideNS, IsPulseGuiding ? 'Busy' : 'Idle')) {
				this.guideWE.state = this.guideNS.state
				this.sendSetProperty(this.guideNS)
				this.sendSetProperty(this.guideWE)
			}

			let updated = this.updatePropertyState(this.equatorialCoordinate, Slewing ? 'Busy' : 'Idle')
			updated = this.updatePropertyValue(this.equatorialCoordinate, 'RA', RightAscension) || updated
			updated = this.updatePropertyValue(this.equatorialCoordinate, 'DEC', Declination) || updated
			updated && this.sendSetProperty(this.equatorialCoordinate)
		}
	}
}

interface AlpacaFilterWheelState extends AlpacaDeviceState {
	Position: number
	Names?: string[]
}

class AlpacaFilterWheel extends AlpacaDevice {
	private readonly position = makeNumberVector('', 'FILTER_SLOT', 'Position', MAIN_CONTROL, 'rw', ['FILTER_SLOT_VALUE', 'Slot', 1, 1, 1, 1, '%.0f'])
	private readonly names = makeTextVector('', 'FILTER_NAME', 'Filter', MAIN_CONTROL, 'ro')

	protected readonly api: AlpacaFilterWheelApi
	// https://ascom-standards.org/newdocs/filterwheel.html#FilterWheel.DeviceState
	protected readonly state: AlpacaFilterWheelState = { Connected: false, DeviceState: undefined, Step: 0, Position: 0, Names: undefined }

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaFilterWheelApi(client.url)

		this.position.device = device.DeviceName
		this.names.device = device.DeviceName

		this.runner.registerEndpoint('Names', () => this.api.getNames(this.id), false)
		// this.runner.registerEndpoint('Position', () => this.api.getPosition(this.id), false)
	}

	protected onConnect() {
		super.onConnect()

		this.enableEndpoints('Names')
	}

	protected onDisconnect() {
		super.onDisconnect()

		this.sendDelProperty(this.position, this.names)

		this.disableEndpoints('Names')
	}

	protected handleEndpointsAfterRun() {
		super.handleEndpointsAfterRun()

		const { Connected, Step, Position, Names } = this.state

		if (!Connected) return

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

			this.disableEndpoints('Names')

			this.state.Step = 2
		}
		// State
		else if (Step === 2) {
			let updated = this.updatePropertyState(this.position, Position === -1 ? 'Busy' : 'Idle')
			if (Position >= 0) updated = this.updatePropertyValue(this.position, 'FILTER_SLOT_VALUE', Position) || updated
			updated && this.sendSetProperty(this.position)
		}
	}

	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'FILTER_SLOT':
				void this.api.setPosition(this.id, vector.elements.FILTER_SLOT_VALUE - 1)
		}
	}
}

interface AlpacaFocuserState extends AlpacaDeviceState {
	IsMoving: boolean
	Position: number
	Temperature?: number
	IsAbsolute: boolean
	MaxStep: number
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
	protected readonly state: AlpacaFocuserState = { Connected: false, DeviceState: undefined, Step: 0, IsMoving: false, Position: 0, Temperature: undefined, IsAbsolute: false, MaxStep: 0 }

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaFocuserApi(client.url)

		this.absolutePosition.device = device.DeviceName
		this.relativePosition.device = device.DeviceName
		this.temperature.device = device.DeviceName
		this.abort.device = device.DeviceName
		this.direction.device = device.DeviceName

		// this.runner.registerEndpoint('IsMoving', () => this.api.isMoving(this.id), false)
		// this.runner.registerEndpoint('Position', () => this.api.getPosition(this.id), false)
		this.runner.registerEndpoint('Temperature', () => this.api.getTemperature(this.id), false)
		this.runner.registerEndpoint('IsAbsolute', () => this.api.isAbsolute(this.id), false)
		this.runner.registerEndpoint('MaxStep', () => this.api.getMaxStep(this.id), false)
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

	onInit() {
		super.onInit()

		this.sendDefProperty(this.direction)
		this.sendDefProperty(this.abort)
	}

	protected onConnect() {
		super.onConnect()

		this.enableEndpoints('MaxStep', 'IsAbsolute', 'Temperature')
	}

	onDisconnect() {
		super.onDisconnect()

		this.sendDelProperty(this.position, this.temperature)

		this.disableEndpoints('MaxStep', 'IsAbsolute', 'Temperature')
	}

	protected handleEndpointsAfterRun() {
		super.handleEndpointsAfterRun()

		const { Connected, Step, IsAbsolute, IsMoving, Position, Temperature, MaxStep } = this.state

		if (!Connected) return

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

			this.disableEndpoints('MaxStep', 'IsAbsolute', 'Temperature')

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

			return true
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'FOCUS_ABORT_MOTION':
				if (vector.elements.ABORT === true) void this.api.halt(this.id)
				break
			case 'FOCUS_MOTION':
				if (vector.elements.FOCUS_INWARD) this.updatePropertyValue(this.direction, 'FOCUS_INWARD', true)
				else if (vector.elements.FOCUS_OUTWARD) this.updatePropertyValue(this.direction, 'FOCUS_OUTWARD', true)
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

interface AlpacaCoverCalibratorState extends AlpacaDeviceState {
	CoverState: number
	CoverMoving: boolean
	CalibratorState: number
	Brightness: number
	MaxBrightness?: number
}

class AlpacaCoverCalibrator extends AlpacaDevice {
	protected readonly api: AlpacaCoverCalibratorApi

	private readonly light = makeSwitchVector('', 'FLAT_LIGHT_CONTROL', 'Light', MAIN_CONTROL, 'OneOfMany', 'rw', ['FLAT_LIGHT_ON', 'On', false], ['FLAT_LIGHT_OFF', 'Off', true])
	private readonly brightness = makeNumberVector('', 'FLAT_LIGHT_INTENSITY', 'Brightness', MAIN_CONTROL, 'rw', ['FLAT_LIGHT_INTENSITY_VALUE', 'Brightness', 0, 0, 0, 1, '%.0f'])
	private readonly park = makeSwitchVector('', 'CAP_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	private readonly abort = makeSwitchVector('', 'CAP_ABORT', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	// https://ascom-standards.org/newdocs/covercalibrator.html#CoverCalibrator.DeviceState
	protected readonly state: AlpacaCoverCalibratorState = { Connected: false, DeviceState: undefined, Step: 0, CoverState: 0, CoverMoving: false, CalibratorState: 0, Brightness: 0, MaxBrightness: undefined }

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaCoverCalibratorApi(client.url)

		this.light.device = device.DeviceName
		this.brightness.device = device.DeviceName
		this.park.device = device.DeviceName
		this.abort.device = device.DeviceName

		this.runner.registerEndpoint('MaxBrightness', () => this.api.getMaxBrightness(this.id), false)
		// this.runner.registerEndpoint('Brightness', () => this.api.getBrightness(this.id), false)
		// this.runner.registerEndpoint('CoverState', () => this.api.getCoverState(this.id), false)
		// this.runner.registerEndpoint('CalibratorState', () => this.api.getCalibratorState(this.id), false)
		// this.runner.registerEndpoint('Moving', () => this.api.isMoving(this.id), false)
	}

	protected onConnect() {
		super.onConnect()

		this.enableEndpoints('MaxBrightness')
	}

	protected onDisconnect() {
		super.onDisconnect()

		this.sendDelProperty(this.park, this.light, this.brightness, this.abort)

		this.disableEndpoints('MaxBrightness')
	}

	protected handleEndpointsAfterRun() {
		super.handleEndpointsAfterRun()

		const { Connected, Step, CoverState, CoverMoving, CalibratorState, Brightness, MaxBrightness } = this.state

		if (!Connected) return

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

			this.disableEndpoints('MaxBrightness')

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
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CAP_ABORT':
				if (vector.elements.ABORT === true) void this.api.halt(this.id)
				break
			case 'CAP_PARK':
				if (vector.elements.PARK) void this.api.close(this.id)
				else if (vector.elements.UNPARK) void this.api.open(this.id)
				break
			case 'FLAT_LIGHT_CONTROL':
				if (vector.elements.FLAT_LIGHT_ON) void this.api.on(this.id, Math.max(1, this.brightness.elements.FLAT_LIGHT_INTENSITY_VALUE.value))
				else if (vector.elements.FLAT_LIGHT_OFF) void this.api.off(this.id)
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

function mapDeviceStateInto(items: readonly AlpacaStateItem[], state: Record<string, ValueType>) {
	for (const item of items) {
		state[item.Name] = item.Value
	}
}

type AlpacaApiRunnerEndpoint = () => PromiseLike<unknown>

type AlpacaApiRunnerHandlerAfterRun = () => void

class AlpacaApiRunner {
	private readonly keys: string[] = []
	private readonly endpoints: AlpacaApiRunnerEndpoint[] = []
	private readonly enabled: boolean[] = []
	private readonly result: PromiseLike<unknown>[] = []
	private readonly handlers = new Set<AlpacaApiRunnerHandlerAfterRun>()

	registerEndpoint(key: string, endpoint: AlpacaApiRunnerEndpoint, enabled: boolean) {
		this.keys.push(key)
		this.endpoints.push(endpoint)
		this.enabled.push(enabled)
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

		if (index >= 0) {
			this.enabled[index] = force ?? !this.enabled[index]
		}
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
			if (this.enabled[i]) {
				this.result[i] = this.endpoints[i]()
			}
		}

		void this.handleEndpointsAfterRun(state)
	}

	private async handleEndpointsAfterRun(state: Record<string, ValueType>) {
		const result = await Promise.all(this.result)

		const n = this.keys.length

		for (let i = 0; i < n; i++) {
			const value = result[i] as never

			if (this.enabled[i] && value !== undefined) {
				state[this.keys[i]] = value
			}
		}

		for (const handler of this.handlers) {
			handler()
		}
	}
}
