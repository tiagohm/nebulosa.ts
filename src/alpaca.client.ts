import { AlpacaCoverCalibratorApi, type AlpacaDeviceApi, AlpacaFilterWheelApi, AlpacaFocuserApi, AlpacaManagementApi, AlpacaTelescopeApi } from './alpaca.api'
import type { AlpacaAxisRate, AlpacaConfiguredDevice, AlpacaDeviceType, AlpacaStateItem } from './alpaca.types'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetNumberVector, handleSetSwitchVector, handleSetTextVector, type IndiClientHandler } from './indi.client'
import type { Client } from './indi.device'
import type { DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefText, DefTextVector, DefVector, EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector, PropertyPermission, PropertyState, SwitchRule, VectorType } from './indi.types'
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

abstract class AlpacaDevice {
	readonly id: number

	protected readonly properties = new Set<DefVector & { type: Uppercase<VectorType> }>()
	protected hasDeviceState = false

	protected abstract api: AlpacaDeviceApi

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
		handleDelProperty(this.client, this.handler, ...messages)
		for (const message of messages) this.properties.delete(message as never)
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

	protected async onConnect() {
		const state = await this.api.deviceState(this.id)
		this.hasDeviceState = state !== undefined
	}

	protected onDisconnect() {
		this.hasDeviceState = false
	}

	async update() {
		const isConnected = await this.api.isConnected(this.id)

		// Failed
		if (isConnected === undefined) return false

		if (isConnected !== this.isConnected) {
			if (isConnected) {
				this.updatePropertyValue(this.connection, 'CONNECT', true)
				await this.onConnect()
			} else {
				this.updatePropertyValue(this.connection, 'CONNECT', false)
				this.onDisconnect()
			}
		}

		return true
	}

	sendText(vector: NewTextVector) {}

	sendNumber(vector: NewNumberVector) {}

	private async handleConnection(mode: 'connect' | 'disconnect') {
		this.connection.state = 'Busy'
		handleSetSwitchVector(this.client, this.handler, this.connection)

		this.connection.state = (await this.api[mode](this.id)) === true ? 'Ok' : 'Alert'
		handleSetSwitchVector(this.client, this.handler, this.connection)
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

class AlpacaTelescope extends AlpacaDevice {
	protected readonly api: AlpacaTelescopeApi

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

	private canTrack = false
	private canPark = false
	private canPulseGuide = false
	private rates: readonly AlpacaAxisRate[] = []

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
	}

	protected async onConnect() {
		await super.onConnect()

		this.sendDefProperty(this.onCoordSet)
		this.sendDefProperty(this.equatorialCoordinate)
		this.sendDefProperty(this.abort)

		void this.readHome()
		void this.readPark(false)
		void this.readSlewRates()
		void this.readMoveAxis()
		void this.readPulseGuide(false)
		void this.readTracking(false)
		void this.readGeographicCoordinate(false)
	}

	protected onDisconnect() {
		this.sendDelProperty(this.home)
	}

	private async readHome() {
		if (await this.api.canFindHome(this.id)) {
			this.sendDefProperty(this.home)
		}
	}

	private async readPark(update: boolean) {
		if (update) {
			const parked = await this.api.isAtPark(this.id)
			this.updatePropertyValue(this.park, parked ? 'PARK' : 'UNPARK', true) && this.sendSetProperty(this.park)
		} else if (await this.api.canPark(this.id)) {
			this.canPark = true
			this.sendDefProperty(this.park)
		}
	}

	private async readMoveAxis() {
		if ((await this.api.canMoveAxis(this.id, 0)) && (await this.api.canMoveAxis(this.id, 1))) {
			this.sendDefProperty(this.motionNS)
			this.sendDefProperty(this.motionWE)
		}
	}

	private async readPulseGuide(update: boolean) {
		if (update) {
			const pulseGuiding = await this.api.isPulseGuiding(this.id)

			if (this.updatePropertyState(this.guideNS, pulseGuiding ? 'Busy' : 'Idle')) {
				this.guideWE.state = this.guideNS.state
				this.sendSetProperty(this.guideNS)
				this.sendSetProperty(this.guideWE)
			}
		} else if (await this.api.canPulseGuide(this.id)) {
			this.canPulseGuide = true
			this.sendDefProperty(this.guideNS)
			this.sendDefProperty(this.guideWE)
		}
	}

	private async readTracking(update: boolean) {
		if (update) {
			const tracking = await this.api.isTracking(this.id)
			this.updatePropertyValue(this.tracking, tracking ? 'TRACK_ON' : 'TRACK_OFF', true) && this.sendSetProperty(this.tracking)
		} else if (await this.api.canSetTracking(this.id)) {
			this.canTrack = true
			this.sendDefProperty(this.tracking)
		}
	}

	private async readSlewRates() {
		const rates = await this.api.getAxisRates(this.id)

		if (rates?.length) {
			this.rates = rates

			for (let i = 0; i < rates.length; i++) {
				const name = `RATE_${i}`
				this.slewRate.elements[name] = { name, label: rates[i].Maximum.toString(), value: i === 0 }
			}

			this.sendDefProperty(this.slewRate)
		}
	}

	private async readEquatorialCoordinate() {
		const rightAscension = await this.api.getRightAscension(this.id)
		const declination = rightAscension !== undefined ? await this.api.getDeclination(this.id) : undefined

		if (rightAscension !== undefined && declination !== undefined) {
			const slewing = await this.api.isSlewing(this.id)

			let updated = this.updatePropertyState(this.equatorialCoordinate, slewing ? 'Busy' : 'Idle')
			updated = this.updatePropertyValue(this.equatorialCoordinate, 'RA', rightAscension) || updated
			updated = this.updatePropertyValue(this.equatorialCoordinate, 'DEC', declination) || updated
			updated && this.sendSetProperty(this.equatorialCoordinate)
		}
	}

	private async readGeographicCoordinate(update: boolean) {
		const longitude = await this.api.getSiteLongitude(this.id)
		const latitude = longitude !== undefined ? await this.api.getSiteLatitude(this.id) : undefined
		const elevation = longitude !== undefined ? await this.api.getSiteElevation(this.id) : undefined

		if (longitude !== undefined && latitude !== undefined && elevation !== undefined) {
			let updated = this.updatePropertyValue(this.geographicCoordinate, 'LONG', longitude)
			updated = this.updatePropertyValue(this.geographicCoordinate, 'LAT', latitude) || updated
			updated = this.updatePropertyValue(this.geographicCoordinate, 'ELEV', elevation) || updated
			if (update) updated && this.sendSetProperty(this.geographicCoordinate)
			else this.sendDefProperty(this.geographicCoordinate)
		}
	}

	async update() {
		if ((await super.update()) && this.isConnected) {
			if (this.hasDeviceState) {
				const state = await this.api.deviceState(this.id)

				if (state !== undefined) {
					const rightAscension = findStateItem(state, 'RightAscension')
					const declination = findStateItem(state, 'Declination')
					const slewing = findStateItem(state, 'Slewing')

					let updated = this.updatePropertyState(this.equatorialCoordinate, slewing ? 'Busy' : 'Idle')
					updated = this.updatePropertyValue(this.equatorialCoordinate, 'RA', rightAscension as number) || updated
					updated = this.updatePropertyValue(this.equatorialCoordinate, 'DEC', declination as number) || updated
					updated && this.sendSetProperty(this.equatorialCoordinate)

					const pulseGuiding = findStateItem(state, 'IsPulseGuiding')
					if (this.updatePropertyState(this.guideNS, pulseGuiding ? 'Busy' : 'Idle')) {
						this.guideWE.state = this.guideNS.state
						this.sendSetProperty(this.guideNS)
						this.sendSetProperty(this.guideWE)
					}

					const tracking = findStateItem(state, 'Tracking')
					this.updatePropertyValue(this.tracking, tracking ? 'TRACK_ON' : 'TRACK_OFF', true) && this.sendSetProperty(this.tracking)

					const parked = findStateItem(state, 'IsAtPark')
					this.updatePropertyValue(this.park, parked ? 'PARK' : 'UNPARK', true) && this.sendSetProperty(this.park)
				} else {
					this.hasDeviceState = false
				}
			} else {
				void this.readEquatorialCoordinate()
				this.canTrack && void this.readTracking(true)
				this.canPulseGuide && void this.readPulseGuide(true)
				this.canPark && this.readPark(true)
			}
		}

		return true
	}
}

class AlpacaFilterWheel extends AlpacaDevice {
	private readonly position = makeNumberVector('', 'FILTER_SLOT', 'Position', MAIN_CONTROL, 'rw', ['FILTER_SLOT_VALUE', 'Slot', 1, 1, 1, 1, '%.0f'])
	private readonly names = makeTextVector('', 'FILTER_NAME', 'Filter', MAIN_CONTROL, 'ro')

	protected readonly api: AlpacaFilterWheelApi

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaFilterWheelApi(client.url)

		this.position.device = device.DeviceName
		this.names.device = device.DeviceName
	}

	protected async onConnect() {
		await super.onConnect()

		void this.readNames()
	}

	protected onDisconnect() {
		super.onDisconnect()

		this.sendDelProperty(this.position, this.names)
	}

	private async readNames() {
		const names = await this.api.getNames(this.id)

		if (names?.length) {
			this.position.elements.FILTER_SLOT_VALUE.max = names.length

			for (let i = 0, p = 1; i < names.length; i++, p++) {
				const name = `FILTER_SLOT_NAME_${p}`
				this.names.elements[name] = { name, label: `Filter ${p}`, value: names[i] }
			}

			this.sendDefProperty(this.names)
			this.sendDefProperty(this.position)
		}
	}

	private async readState() {
		const state = await this.api.deviceState(this.id)

		if (state !== undefined) {
			const position = findStateItem(state, 'Position') as number
			let updated = this.updatePropertyState(this.position, position === -1 ? 'Busy' : 'Idle')
			if (position >= 0) updated = this.updatePropertyValue(this.position, 'FILTER_SLOT_VALUE', position) || updated
			updated && this.sendSetProperty(this.position)
		} else {
			this.hasDeviceState = false
		}
	}

	private async readPosition() {
		const position = await this.api.getPosition(this.id)

		if (position !== undefined) {
			let updated = this.updatePropertyState(this.position, position === -1 ? 'Busy' : 'Idle')
			if (position >= 0) updated = this.updatePropertyValue(this.position, 'FILTER_SLOT_VALUE', position) || updated
			updated && this.sendSetProperty(this.position)
		}
	}

	async update() {
		if ((await super.update()) && this.isConnected) {
			if (this.hasDeviceState) {
				void this.readState()
			} else {
				void this.readPosition()
			}

			return true
		}

		return false
	}

	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'FILTER_SLOT':
				void this.api.setPosition(this.id, vector.elements.FILTER_SLOT_VALUE - 1)
		}
	}
}

class AlpacaFocuser extends AlpacaDevice {
	private readonly absolutePosition = makeNumberVector('', 'ABS_FOCUS_POSITION', 'Absolute Position', MAIN_CONTROL, 'rw', ['FOCUS_ABSOLUTE_POSITION', 'Position', 0, 0, 0, 1, '%.0f'])
	private readonly relativePosition = makeNumberVector('', 'REL_FOCUS_POSITION', 'Relative Position', MAIN_CONTROL, 'rw', ['FOCUS_RELATIVE_POSITION', 'Steps', 0, 0, 0, 1, '%.0f'])
	private readonly temperature = makeNumberVector('', 'FOCUS_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'ro', ['TEMPERATURE', 'Temperature', 0, -50, 70, 0.1, '%6.2f'])
	private readonly abort = makeSwitchVector('', 'FOCUS_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	private readonly direction = makeSwitchVector('', 'FOCUS_MOTION', 'Direction', MAIN_CONTROL, 'OneOfMany', 'rw', ['FOCUS_INWARD', 'In', true], ['FOCUS_OUTWARD', 'Out', false])

	private position = this.absolutePosition
	private hasTemperature = false

	protected readonly api: AlpacaFocuserApi

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaFocuserApi(client.url)

		this.absolutePosition.device = device.DeviceName
		this.relativePosition.device = device.DeviceName
		this.temperature.device = device.DeviceName
		this.abort.device = device.DeviceName
		this.direction.device = device.DeviceName
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

	protected async onConnect() {
		await super.onConnect()

		void this.readMode()
		void this.readTemperature(false)
	}

	onDisconnect() {
		super.onDisconnect()

		this.sendDelProperty(this.position, this.temperature)
	}

	private async readMode() {
		const absolute = await this.api.isAbsolute(this.id)

		if (absolute !== undefined) {
			const maxStep = await this.api.getMaxStep(this.id)

			if (maxStep) {
				if (absolute) {
					this.absolutePosition.elements.FOCUS_ABSOLUTE_POSITION.max = maxStep
					this.position = this.absolutePosition
				} else {
					this.relativePosition.elements.FOCUS_RELATIVE_POSITION.max = maxStep
					this.position = this.relativePosition
				}

				this.sendDefProperty(this.position)
			}
		}
	}

	private async readState() {
		const state = await this.api.deviceState(this.id)

		if (state !== undefined) {
			const position = this.isAbsolute ? findStateItem(state, 'Position') : undefined
			const moving = findStateItem(state, 'IsMoving')
			let updated = this.updatePropertyState(this.position, moving ? 'Busy' : 'Idle')
			updated = this.updatePropertyValue(this.position, 'FOCUS_ABSOLUTE_POSITION', position as number) || updated
			updated && this.sendSetProperty(this.position)

			if (this.hasTemperature) {
				const temperature = findStateItem(state, 'Temperature')
				this.updatePropertyValue(this.temperature, 'TEMPERATURE', Math.trunc(temperature as number)) && this.sendSetProperty(this.temperature)
			}

			return true
		} else {
			this.hasDeviceState = false
			return false
		}
	}

	private async readTemperature(update: boolean) {
		const temperature = await this.api.getTemperature(this.id)

		if (temperature !== undefined) {
			if (update) {
				this.updatePropertyValue(this.temperature, 'TEMPERATURE', Math.trunc(temperature)) && this.sendSetProperty(this.temperature)
			} else {
				this.temperature.elements.TEMPERATURE.value = Math.trunc(temperature)
				this.sendDefProperty(this.temperature)
				this.hasTemperature = true
			}
		} else {
			this.hasTemperature = false
		}
	}

	private async readAbsolutePosition() {
		const position = await this.api.getPosition(this.id)

		if (position !== undefined) {
			const moving = await this.api.isMoving(this.id)
			let updated = this.updatePropertyState(this.position, moving ? 'Busy' : 'Idle')
			updated = this.updatePropertyValue(this.position, 'FOCUS_ABSOLUTE_POSITION', position) || updated
			updated && this.sendSetProperty(this.position)
		}
	}

	private async readRelativePosition() {
		const moving = await this.api.isMoving(this.id)
		this.updatePropertyState(this.position, moving ? 'Busy' : 'Idle') && this.sendSetProperty(this.position)
	}

	async update() {
		if ((await super.update()) && this.isConnected) {
			if (this.hasDeviceState) {
				void this.readState()
			} else {
				if (this.hasTemperature) {
					void this.readTemperature(true)
				}

				if (this.isAbsolute) {
					void this.readAbsolutePosition()
				} else {
					void this.readRelativePosition()
				}
			}

			return true
		}

		return false
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

class AlpacaCoverCalibrator extends AlpacaDevice {
	private readonly light = makeSwitchVector('', 'FLAT_LIGHT_CONTROL', 'Light', MAIN_CONTROL, 'OneOfMany', 'rw', ['FLAT_LIGHT_ON', 'On', false], ['FLAT_LIGHT_OFF', 'Off', true])
	private readonly brightness = makeNumberVector('', 'FLAT_LIGHT_INTENSITY', 'Brightness', MAIN_CONTROL, 'rw', ['FLAT_LIGHT_INTENSITY_VALUE', 'Brightness', 0, 0, 0, 1, '%.0f'])
	private readonly park = makeSwitchVector('', 'CAP_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	private readonly abort = makeSwitchVector('', 'CAP_ABORT', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	private hasCalibrator = true
	private hasCover = true

	protected readonly api: AlpacaCoverCalibratorApi

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaCoverCalibratorApi(client.url)

		this.light.device = device.DeviceName
		this.brightness.device = device.DeviceName
		this.park.device = device.DeviceName
		this.abort.device = device.DeviceName
	}

	protected async onConnect() {
		await super.onConnect()

		await this.readCoverState(false)
		await this.readCalibratorState(false)

		if (this.hasCover !== this.hasCalibrator) {
			if (this.hasCover) {
				this.driverInfo.elements.DRIVER_INTERFACE.value = '512'
			} else {
				this.driverInfo.elements.DRIVER_INTERFACE.value = '1024'
			}

			this.sendDefProperty(this.driverInfo)
		}

		if (this.hasCover) {
			this.sendDefProperty(this.park)
			this.sendDefProperty(this.abort)
		}

		if (this.hasCalibrator) {
			const maxBrightness = await this.api.getMaxBrightness(this.id)

			if (maxBrightness !== undefined) {
				this.sendDefProperty(this.light)
				this.brightness.elements.FLAT_LIGHT_INTENSITY_VALUE.max = maxBrightness
				this.sendDefProperty(this.brightness)
			}
		}
	}

	protected onDisconnect() {
		super.onDisconnect()

		this.sendDelProperty(this.park, this.light, this.brightness, this.abort)
	}

	private async readCoverState(update: boolean) {
		const state = await this.api.getCoverState(this.id)

		// Cover is not present
		if (state === 0) {
			this.hasCover = false
		} else if (update) {
			const moving = await this.api.isMoving(this.id)
			let updated = this.updatePropertyState(this.park, moving ? 'Busy' : 'Idle')
			updated = this.updatePropertyValue(this.park, state === 1 ? 'PARK' : 'UNPARK', true) || updated
			updated && this.sendSetProperty(this.park)
		}
	}

	private async readCalibratorState(update: boolean) {
		const state = await this.api.getCalibratorState(this.id)

		// Calibrator is not present
		if (state === 0) {
			this.hasCalibrator = false
		} else if (update) {
			this.updatePropertyValue(this.light, state === 1 ? 'FLAT_LIGHT_OFF' : 'FLAT_LIGHT_ON', true) && this.sendSetProperty(this.light)

			if (state === 3) {
				const brightness = await this.api.getBrightness(this.id)
				this.updatePropertyValue(this.brightness, 'FLAT_LIGHT_INTENSITY_VALUE', brightness as number) && this.sendSetProperty(this.brightness)
			}
		}
	}

	private async readState() {
		const items = await this.api.deviceState(this.id)

		if (items === undefined) {
			this.hasDeviceState = false
			return false
		}

		if (this.hasCover) {
			const state = findStateItem(items, 'CoverState') // 1 = Closed, 3 = Open
			const moving = state === 2 || findStateItem(items, 'CoverMoving')
			let updated = this.updatePropertyState(this.park, moving ? 'Busy' : 'Idle')
			updated = this.updatePropertyValue(this.park, state === 1 ? 'PARK' : 'UNPARK', true) || updated
			updated && this.sendSetProperty(this.park)
		}

		if (this.hasCalibrator) {
			const state = findStateItem(items, 'CalibratorState') // 1 = Off, 3 = On

			if (state === 3) {
				this.updatePropertyValue(this.light, 'FLAT_LIGHT_ON', true) && this.sendSetProperty(this.light)

				const brightness = findStateItem(items, 'Brightness')
				this.updatePropertyValue(this.brightness, 'FLAT_LIGHT_INTENSITY_VALUE', brightness as number) && this.sendSetProperty(this.brightness)
			} else if (state === 1) {
				this.updatePropertyValue(this.light, 'FLAT_LIGHT_OFF', true) && this.sendSetProperty(this.light)
			}
		}

		return true
	}

	async update() {
		if ((await super.update()) && this.isConnected) {
			if (this.hasDeviceState) {
				void this.readState()
			} else {
				if (this.hasCover) void this.readCoverState(true)
				if (this.hasCalibrator) void this.readCalibratorState(true)
			}

			return true
		}

		return false
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

function findStateItem(state: readonly AlpacaStateItem[], name: string) {
	for (const item of state) if (item.Name === name) return item.Value
	return undefined
}
