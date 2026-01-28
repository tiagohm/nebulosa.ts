import { AlpacaCoverCalibratorApi, type AlpacaDeviceApi, AlpacaFilterWheelApi, AlpacaFocuserApi, AlpacaManagementApi } from './alpaca.api'
import type { AlpacaConfiguredDevice, AlpacaDeviceType, AlpacaStateItem } from './alpaca.types'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetNumberVector, handleSetSwitchVector, type IndiClientHandler } from './indi.client'
import type { Client } from './indi.device'
import type { DefNumberVector, DefSwitchVector, DefTextVector, EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector, PropertyState } from './indi.types'

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
	private tickCount = 0

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

				if (type === 'filterwheel') {
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
		const tickCount = this.tickCount++
		this.devices.forEach((e) => e.update(tickCount))
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

const DEFAULT_DEF_VECTOR = {
	device: '',
	group: 'Main Control',
	state: 'Idle',
	permission: 'rw',
} as const

abstract class AlpacaDevice {
	readonly id: number

	protected hasDeviceState = false

	protected abstract api: AlpacaDeviceApi

	protected readonly driverInfo: DefTextVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'DRIVER_INFO',
		label: 'Driver Info',
		group: 'Driver Info',
		permission: 'ro',
		elements: { DRIVER_INTERFACE: { name: 'DRIVER_INTERFACE', label: 'Interface', value: '' }, DRIVER_EXEC: { name: 'DRIVER_EXEC', label: 'Exec', value: '' }, DRIVER_VERSION: { name: 'DRIVER_VERSION', label: 'Version', value: '1.0' } },
	}

	private readonly connection: DefSwitchVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'CONNECTION',
		label: 'Connection',
		rule: 'OneOfMany',
		elements: { CONNECT: { name: 'CONNECT', label: 'Connect', value: false }, DISCONNECT: { name: 'DISCONNECT', label: 'Connect', value: true } },
	}

	constructor(
		readonly client: AlpacaClient,
		readonly device: AlpacaConfiguredDevice,
		readonly handler: AlpacaClientHandler,
	) {
		this.id = device.DeviceNumber

		this.driverInfo.device = device.DeviceName
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

	async update(tickCount: number) {
		if (tickCount % 2 === 0) {
			const isConnected = await this.api.isConnected(this.id)

			// Failed
			if (isConnected === undefined) return

			if (isConnected !== this.isConnected) {
				if (isConnected) {
					this.updateSwitchVector(this.connection, 'CONNECT', true, 'Idle')
					await this.onConnect()
				} else {
					this.updateSwitchVector(this.connection, 'CONNECT', false, 'Idle')
					this.onDisconnect()
				}
			}
		}
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

class AlpacaFilterWheel extends AlpacaDevice {
	private readonly position: DefNumberVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'FILTER_SLOT',
		label: 'Position',
		elements: { FILTER_SLOT_VALUE: { name: 'FILTER_SLOT_VALUE', label: 'Slot', value: 1, min: 0, max: 0, step: 1, format: '%.0f' } },
	}

	private readonly names: DefTextVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'FILTER_NAME',
		label: 'Names',
		permission: 'ro',
		elements: {},
	}

	protected readonly api: AlpacaFilterWheelApi

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaFilterWheelApi(client.url)

		this.position.device = device.DeviceName
		this.names.device = device.DeviceName
	}

	protected async onConnect() {
		await super.onConnect()

		const names = await this.api.getNames(this.id)

		if (names?.length) {
			this.position.elements.FILTER_SLOT_VALUE.max = names.length

			for (let i = 0; i < names.length; i++) {
				const name = `FILTER_SLOT_NAME_${i + 1}`
				this.names.elements[name] = { name, label: `Filter ${i + 1}`, value: names[i] }
			}

			handleDefNumberVector(this.client, this.handler, this.position)
			handleDefTextVector(this.client, this.handler, this.names)
		}
	}

	protected onDisconnect() {
		super.onDisconnect()

		handleDelProperty(this.client, this.handler, this.position, this.names)
	}

	async update(tickCount: number) {
		await super.update(tickCount)

		if (this.isConnected) {
			if (this.hasDeviceState) {
				const state = await this.api.deviceState(this.id)

				if (state !== undefined) {
					const position = findAlpacaStateItem(state, 'Position') as number
					this.updateNumberVector(this.position, 'FILTER_SLOT_VALUE', position === -1 ? undefined : position + 1, position === -1 ? 'Busy' : 'Idle')
					return
				} else {
					this.hasDeviceState = false
				}
			}

			const position = await this.api.getPosition(this.id)

			if (position !== undefined) {
				this.updateNumberVector(this.position, 'FILTER_SLOT_VALUE', position === -1 ? undefined : position + 1, position === -1 ? 'Busy' : 'Idle')
			}
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

class AlpacaFocuser extends AlpacaDevice {
	private readonly absolutePosition: DefNumberVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'ABS_FOCUS_POSITION',
		label: 'Absolute Position',
		elements: { FOCUS_ABSOLUTE_POSITION: { name: 'FOCUS_ABSOLUTE_POSITION', label: 'Position', value: 0, min: 0, max: 0, step: 1, format: '%.0f' } },
	}

	private readonly relativePosition: DefNumberVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'REL_FOCUS_POSITION',
		label: 'Relative Position',
		elements: { FOCUS_RELATIVE_POSITION: { name: 'FOCUS_RELATIVE_POSITION', label: 'Steps', value: 0, min: 0, max: 0, step: 1, format: '%.0f' } },
	}

	private readonly temperature: DefNumberVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'FOCUS_TEMPERATURE',
		label: 'Temperature',
		permission: 'ro',
		elements: { TEMPERATURE: { name: 'TEMPERATURE', label: 'Temperature', value: 0, min: -50, max: 50, step: 0.1, format: '%0.1f' } },
	}

	private readonly abort: DefSwitchVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'FOCUS_ABORT_MOTION',
		label: 'Abort',
		rule: 'AtMostOne',
		elements: { ABORT: { name: 'ABORT', label: 'Abort', value: false } },
	}

	private position = this.absolutePosition
	private direction = 0
	private hasTemperature = false

	protected readonly api: AlpacaFocuserApi

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.options.handler)

		this.api = new AlpacaFocuserApi(client.url)

		this.absolutePosition.device = device.DeviceName
		this.relativePosition.device = device.DeviceName
		this.temperature.device = device.DeviceName
		this.abort.device = device.DeviceName
	}

	get isAbsolute() {
		return this.position === this.absolutePosition
	}

	onInit() {
		super.onInit()

		handleDefSwitchVector(this.client, this.handler, this.abort)
	}

	protected async onConnect() {
		await super.onConnect()

		const temperature = await this.api.getTemperature(this.id)

		if (temperature !== undefined) {
			this.temperature.elements.TEMPERATURE.value = Math.trunc(temperature)
			handleDefNumberVector(this.client, this.handler, this.temperature)
			this.hasTemperature = true
		}

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
		} else {
			// TODO: Failed?
		}
	}

	onDisconnect() {
		super.onDisconnect()

		handleDelProperty(this.client, this.handler, this.position, this.temperature)
	}

	async update(tickCount: number) {
		await super.update(tickCount)

		if (this.isConnected) {
			if (this.hasDeviceState) {
				const state = await this.api.deviceState(this.id)

				if (state !== undefined) {
					const position = this.isAbsolute ? findAlpacaStateItem(state, 'Position') : undefined
					const moving = findAlpacaStateItem(state, 'IsMoving')
					this.updateNumberVector(this.position, 'FOCUS_ABSOLUTE_POSITION', position as never, moving ? 'Busy' : 'Idle')

					if (this.hasTemperature) {
						const temperature = findAlpacaStateItem(state, 'Temperature')
						this.updateNumberVector(this.temperature, 'TEMPERATURE', Math.trunc(temperature as number))
					}

					return
				} else {
					this.hasDeviceState = false
				}
			}

			if (this.hasTemperature) {
				void this.api.getTemperature(this.id).then((temperature) => {
					temperature !== undefined && this.updateNumberVector(this.temperature, 'TEMPERATURE', Math.trunc(temperature))
				})
			}

			if (this.isAbsolute) {
				const position = await this.api.getPosition(this.id)

				if (position !== undefined) {
					const moving = await this.api.isMoving(this.id)
					this.updateNumberVector(this.position, 'FOCUS_ABSOLUTE_POSITION', position, moving ? 'Busy' : 'Idle')
				}
			} else {
				const moving = await this.api.isMoving(this.id)
				this.position.state = moving ? 'Busy' : 'Idle'
				handleSetNumberVector(this.client, this.handler, this.position)
			}
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'FOCUS_ABORT_MOTION':
				if (vector.elements.ABORT === true) void this.api.halt(this.id)
				break
			case 'FOCUS_MOTION':
				if (vector.elements.FOCUS_INWARD) this.direction = -1
				else if (vector.elements.FOCUS_OUTWARD) this.direction = 1
				break
		}
	}

	sendNumber(vector: NewNumberVector) {
		super.sendNumber(vector)

		switch (vector.name) {
			case 'REL_FOCUS_POSITION':
				if (!this.isAbsolute) void this.api.move(this.id, vector.elements.FOCUS_RELATIVE_POSITION * this.direction)
				break
			case 'ABS_FOCUS_POSITION':
				if (this.isAbsolute) void this.api.move(this.id, vector.elements.FOCUS_ABSOLUTE_POSITION)
				break
		}
	}
}

class AlpacaCoverCalibrator extends AlpacaDevice {
	private readonly light: DefSwitchVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'FLAT_LIGHT_CONTROL',
		label: 'Light',
		rule: 'OneOfMany',
		elements: { FLAT_LIGHT_ON: { name: 'FLAT_LIGHT_ON', label: 'On', value: false }, FLAT_LIGHT_OFF: { name: 'FLAT_LIGHT_OFF', label: 'Off', value: true } },
	}

	private readonly brightness: DefNumberVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'FLAT_LIGHT_INTENSITY',
		label: 'Brightness',
		elements: { FLAT_LIGHT_INTENSITY_VALUE: { name: 'FLAT_LIGHT_INTENSITY_VALUE', label: 'Brightness', value: 0, min: 0, max: 0, step: 1, format: '%.0f' } },
	}

	private readonly park: DefSwitchVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'CAP_PARK',
		label: 'Park',
		rule: 'OneOfMany',
		elements: { PARK: { name: 'PARK', label: 'Park', value: false }, UNPARK: { name: 'UNPARK', label: 'Unpark', value: true } },
	}

	private readonly abort: DefSwitchVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'CAP_ABORT',
		label: 'Abort',
		rule: 'AtMostOne',
		elements: { ABORT: { name: 'ABORT', label: 'Abort', value: false } },
	}

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

		let state = await this.api.getCoverState(this.id)

		// Cover is not present
		if (state === 0) {
			this.hasCover = false
		}

		state = await this.api.getCalibratorState(this.id)

		// Calibrator is not present
		if (state === 0) {
			this.hasCalibrator = false
		}

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
			handleDefSwitchVector(this.client, this.handler, this.light)

			const maxBrightness = await this.api.getMaxBrightness(this.id)

			if (maxBrightness !== undefined) {
				this.brightness.elements.FLAT_LIGHT_INTENSITY_VALUE.max = maxBrightness
				handleDefNumberVector(this.client, this.handler, this.brightness)
			}
		}
	}

	protected onDisconnect() {
		super.onDisconnect()

		handleDelProperty(this.client, this.handler, this.park, this.light, this.brightness, this.abort)
	}

	async update(tickCount: number) {
		await super.update(tickCount)

		if (this.isConnected) {
			let state: readonly AlpacaStateItem[] | undefined

			if (this.hasDeviceState) {
				state = await this.api.deviceState(this.id)

				if (state === undefined) {
					this.hasDeviceState = false
				}
			}

			if (this.hasCover) void this.updateCover(state)
			if (this.hasCalibrator) void this.updateCalibrator(state)
		}
	}

	private async updateCover(items?: readonly AlpacaStateItem[]) {
		if (items !== undefined) {
			const state = findAlpacaStateItem(items, 'CoverState') // 1 = Closed, 3 = Open
			const moving = state === 2 || findAlpacaStateItem(items, 'CoverMoving')
			this.updateSwitchVector(this.park, 'PARK', state === 1 ? true : state === 3 ? false : undefined, moving ? 'Busy' : 'Idle')
		} else {
			const state = await this.api.getCoverState(this.id)
			const moving = await this.api.isMoving(this.id)
			this.updateSwitchVector(this.park, 'PARK', state === 1 ? true : state === 3 ? false : undefined, moving ? 'Busy' : 'Idle')
		}
	}

	private async updateCalibrator(items?: readonly AlpacaStateItem[]) {
		if (items !== undefined) {
			const state = findAlpacaStateItem(items, 'CalibratorState') // 1 = Off, 3 = On
			this.updateSwitchVector(this.light, 'FLAT_LIGHT_ON', state === 1 ? false : state === 3 ? true : undefined)

			if (state === 3) {
				const brightness = findAlpacaStateItem(items, 'Brightness')
				this.updateNumberVector(this.brightness, 'FLAT_LIGHT_INTENSITY_VALUE', brightness as number)
			}
		} else {
			const state = await this.api.getCalibratorState(this.id)
			this.updateSwitchVector(this.light, 'FLAT_LIGHT_ON', state === 1 ? false : state === 3 ? true : undefined)

			if (state === 3) {
				const brightness = await this.api.getBrightness(this.id)
				this.updateNumberVector(this.brightness, 'FLAT_LIGHT_INTENSITY_VALUE', brightness)
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

function findAlpacaStateItem(state: readonly AlpacaStateItem[], name: string) {
	for (const item of state) if (item.Name === name) return item.Value
	return undefined
}
