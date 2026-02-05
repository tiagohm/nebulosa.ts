import { AlpacaCoverCalibratorApi, type AlpacaDeviceApi, AlpacaFilterWheelApi, AlpacaFocuserApi, AlpacaManagementApi, AlpacaTelescopeApi } from './alpaca.api'
import type { AlpacaConfiguredDevice, AlpacaDeviceType, AlpacaStateItem } from './alpaca.types'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetNumberVector, handleSetSwitchVector, type IndiClientHandler } from './indi.client'
import type { Client } from './indi.device'
import type { DefNumber, DefNumberVector, DefSwitch, DefSwitchVector, DefText, DefTextVector, EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector, PropertyPermission, PropertyState, SwitchRule } from './indi.types'
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

	protected updateSwitchVector(property: DefSwitchVector, name: string, value?: boolean, state?: PropertyState) {
		const { rule, elements } = property

		let updated = false

		if (state !== undefined && property.state !== state) {
			property.state = state
			updated = true
		}

		if (value !== undefined && rule !== 'AtMostOne' && elements[name].value !== value) {
			elements[name].value = value
			updated = true

			if (rule === 'OneOfMany') {
				for (const p in elements) {
					if (p !== name) {
						elements[p].value = !value
					}
				}
			}
		}

		updated && handleSetSwitchVector(this.client, this.handler, property)

		return updated
	}

	protected updateNumberVector(property: DefNumberVector, name: string, value: number | undefined, state?: PropertyState) {
		const { elements } = property

		let updated = false

		if (state !== undefined && property.state !== state) {
			property.state = state
			updated = true
		}

		if (value !== undefined && elements[name].value !== value) {
			elements[name].value = value
			updated = true
		}

		updated && handleSetNumberVector(this.client, this.handler, property)

		return updated
	}

	sendProperties() {}

	onInit() {
		handleDefTextVector(this.client, this.handler, this.driverInfo)
		handleDefSwitchVector(this.client, this.handler, this.connection)
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
				this.updateSwitchVector(this.connection, 'CONNECT', true, 'Idle')
				await this.onConnect()
			} else {
				this.updateSwitchVector(this.connection, 'CONNECT', false, 'Idle')
				this.onDisconnect()
			}
		}

		return true
	}

	sendText(vector: NewTextVector) {}

	sendNumber(vector: NewNumberVector) {}

	sendSwitch(vector: NewSwitchVector) {
		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true && !this.isConnected) {
					this.connection.state = 'Busy'
					handleSetSwitchVector(this.client, this.handler, this.connection)
					void this.api.connect(this.id)
				} else if (vector.elements.DISCONNECT === true && this.isConnected) {
					this.connection.state = 'Busy'
					handleSetSwitchVector(this.client, this.handler, this.connection)
					void this.api.disconnect(this.id)
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
	private readonly home = makeSwitchVector('', 'TELESCOPE_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['FIND', 'Find', false], ['SET', 'Set', false], ['GO', 'Go', false])
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
	}

	protected async onConnect() {
		await super.onConnect()

		void this.readHome()
	}

	protected onDisconnect() {
		handleDelProperty(this.client, this.handler, this.home)
	}

	private async readHome() {
		if (await this.api.canFindHome(this.id)) {
			handleDefSwitchVector(this.client, this.handler, this.home)
		}
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

		handleDelProperty(this.client, this.handler, this.position, this.names)
	}

	private async readNames() {
		const names = await this.api.getNames(this.id)

		if (names?.length) {
			this.position.elements.FILTER_SLOT_VALUE.max = names.length

			for (let i = 0, p = 1; i < names.length; i++, p++) {
				const name = `FILTER_SLOT_NAME_${p}`
				this.names.elements[name] = { name, label: `Filter ${p}`, value: names[i] }
			}

			handleDefTextVector(this.client, this.handler, this.names)
			handleDefNumberVector(this.client, this.handler, this.position)
		}
	}

	private async readState() {
		const state = await this.api.deviceState(this.id)

		if (state !== undefined) {
			const position = findStateItem(state, 'Position') as number
			this.updateNumberVector(this.position, 'FILTER_SLOT_VALUE', position === -1 ? undefined : position + 1, position === -1 ? 'Busy' : 'Idle')
		} else {
			this.hasDeviceState = false
		}
	}

	private async readPosition() {
		const position = await this.api.getPosition(this.id)

		if (position !== undefined) {
			this.updateNumberVector(this.position, 'FILTER_SLOT_VALUE', position === -1 ? undefined : position + 1, position === -1 ? 'Busy' : 'Idle')
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

		handleDefSwitchVector(this.client, this.handler, this.direction)
		handleDefSwitchVector(this.client, this.handler, this.abort)
	}

	protected async onConnect() {
		await super.onConnect()

		void this.readMode()
		void this.readTemperature(false)
	}

	onDisconnect() {
		super.onDisconnect()

		handleDelProperty(this.client, this.handler, this.position, this.temperature)
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

				handleDefNumberVector(this.client, this.handler, this.position)
			}
		}
	}

	private async readState() {
		const state = await this.api.deviceState(this.id)

		if (state !== undefined) {
			const position = this.isAbsolute ? findStateItem(state, 'Position') : undefined
			const moving = findStateItem(state, 'IsMoving')
			this.updateNumberVector(this.position, 'FOCUS_ABSOLUTE_POSITION', position as never, moving ? 'Busy' : 'Idle')

			if (this.hasTemperature) {
				const temperature = findStateItem(state, 'Temperature')
				this.updateNumberVector(this.temperature, 'TEMPERATURE', Math.trunc(temperature as number))
			}

			return true
		} else {
			this.hasDeviceState = false
		}
	}

	private async readTemperature(update: boolean) {
		const temperature = await this.api.getTemperature(this.id)

		if (temperature !== undefined) {
			if (update) {
				this.updateNumberVector(this.temperature, 'TEMPERATURE', Math.trunc(temperature))
			} else {
				this.temperature.elements.TEMPERATURE.value = Math.trunc(temperature)
				handleDefNumberVector(this.client, this.handler, this.temperature)
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
			this.updateNumberVector(this.position, 'FOCUS_ABSOLUTE_POSITION', position, moving ? 'Busy' : 'Idle')
		}
	}

	private async readRelativePosition() {
		const moving = await this.api.isMoving(this.id)
		this.position.state = moving ? 'Busy' : 'Idle'
		handleSetNumberVector(this.client, this.handler, this.position)
	}

	async update() {
		if ((await super.update()) && this.isConnected) {
			if (this.hasDeviceState) {
				void this.readState()
			}

			if (this.hasTemperature) {
				void this.readTemperature(true)
			}

			if (this.isAbsolute) {
				void this.readAbsolutePosition()
			} else {
				void this.readRelativePosition()
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
				if (vector.elements.FOCUS_INWARD) this.updateSwitchVector(this.direction, 'FOCUS_INWARD', true)
				else if (vector.elements.FOCUS_OUTWARD) this.updateSwitchVector(this.direction, 'FOCUS_OUTWARD', true)
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

			handleDefTextVector(this.client, this.handler, this.driverInfo)
		}

		if (this.hasCover) {
			handleDefSwitchVector(this.client, this.handler, this.park)
			handleDefSwitchVector(this.client, this.handler, this.abort)
		}

		if (this.hasCalibrator) {
			const maxBrightness = await this.api.getMaxBrightness(this.id)

			if (maxBrightness !== undefined) {
				handleDefSwitchVector(this.client, this.handler, this.light)
				this.brightness.elements.FLAT_LIGHT_INTENSITY_VALUE.max = maxBrightness
				handleDefNumberVector(this.client, this.handler, this.brightness)
			}
		}
	}

	protected onDisconnect() {
		super.onDisconnect()

		handleDelProperty(this.client, this.handler, this.park, this.light, this.brightness, this.abort)
	}

	private async readCoverState(update: boolean) {
		const state = await this.api.getCoverState(this.id)

		// Cover is not present
		if (state === 0) {
			this.hasCover = false
		} else if (update) {
			const moving = await this.api.isMoving(this.id)
			this.updateSwitchVector(this.park, 'PARK', state === 1 ? true : state === 3 ? false : undefined, moving ? 'Busy' : 'Idle')
		}
	}

	private async readCalibratorState(update: boolean) {
		const state = await this.api.getCalibratorState(this.id)

		// Calibrator is not present
		if (state === 0) {
			this.hasCalibrator = false
		} else if (update) {
			this.updateSwitchVector(this.light, 'FLAT_LIGHT_ON', state === 1 ? false : state === 3 ? true : undefined)

			if (state === 3) {
				const brightness = await this.api.getBrightness(this.id)
				this.updateNumberVector(this.brightness, 'FLAT_LIGHT_INTENSITY_VALUE', brightness)
			}
		}
	}

	private async readState() {
		const items = await this.api.deviceState(this.id)

		if (items === undefined) {
			this.hasDeviceState = false
			return
		}

		if (this.hasCover) {
			const state = findStateItem(items, 'CoverState') // 1 = Closed, 3 = Open
			const moving = state === 2 || findStateItem(items, 'CoverMoving')
			this.updateSwitchVector(this.park, 'PARK', state === 1 ? true : state === 3 ? false : undefined, moving ? 'Busy' : 'Idle')
		}

		if (this.hasCalibrator) {
			const state = findStateItem(items, 'CalibratorState') // 1 = Off, 3 = On
			this.updateSwitchVector(this.light, 'FLAT_LIGHT_ON', state === 1 ? false : state === 3 ? true : undefined)

			if (state === 3) {
				const brightness = findStateItem(items, 'Brightness')
				this.updateNumberVector(this.brightness, 'FLAT_LIGHT_INTENSITY_VALUE', brightness as number)
			}
		}
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

function makeSwitchVector(device: string, name: string, label: string, group: string, rule: SwitchRule, permission: PropertyPermission, ...properties: readonly [string, string, boolean][]): DefSwitchVector {
	const elements: Record<string, DefSwitch> = {}
	for (const [name, label, value] of properties) elements[name] = { name, label, value }
	return { device, name, label, group, permission, rule, state: 'Idle', timeout: 60, elements }
}

function makeNumberVector(device: string, name: string, label: string, group: string, permission: PropertyPermission, ...properties: readonly [string, string, number, number, number, number, string][]): DefNumberVector {
	const elements: Record<string, DefNumber> = {}
	for (const [name, label, value, min, max, step, format] of properties) elements[name] = { name, label, value, min, max, step, format }
	return { device, name, label, group, permission, state: 'Idle', timeout: 60, elements }
}

function makeTextVector(device: string, name: string, label: string, group: string, permission: PropertyPermission, ...properties: readonly [string, string, string][]): DefTextVector {
	const elements: Record<string, DefText> = {}
	for (const [name, label, value] of properties) elements[name] = { name, label, value }
	return { device, name, label, group, permission, state: 'Idle', timeout: 60, elements }
}

function findStateItem(state: readonly AlpacaStateItem[], name: string) {
	for (const item of state) if (item.Name === name) return item.Value
	return undefined
}
