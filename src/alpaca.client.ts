import { AlpacaApi, type AlpacaDeviceApi, type AlpacaFilterWheelApi, type AlpacaFocuserApi } from './alpaca.api'
import type { AlpacaConfiguredDevice, AlpacaDeviceType } from './alpaca.types'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleSetNumberVector, handleSetSwitchVector, type IndiClientHandler } from './indi.client'
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
	readonly api: AlpacaApi

	readonly remoteHost: string
	readonly remotePort: number

	private readonly devices = new Map<string, AlpacaDevice>()
	private timer?: NodeJS.Timeout
	private tickCount = 0

	constructor(
		readonly url: string,
		readonly options: AlpacaClientOptions,
	) {
		this.id = Bun.MD5.hash(url, 'hex')
		this.description = `Alpaca Client at ${url}`
		this.api = new AlpacaApi(url)
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
		const configuredDevices = await this.api.management.configuredDevices()
		if (!configuredDevices?.length) return false
		this.initialize(configuredDevices)
		return true
	}

	private initialize(configuredDevices: readonly AlpacaConfiguredDevice[]) {
		for (const configuredDevice of configuredDevices) {
			let device = this.devices.get(configuredDevice.DeviceName)

			if (!device) {
				if (configuredDevice.DeviceType === 'FilterWheel') {
					device = new AlpacaFilterWheel(this, configuredDevice)
				} else if (configuredDevice.DeviceType === 'Focuser') {
					device = new AlpacaFocuser(this, configuredDevice)
				}

				if (device) {
					this.devices.set(configuredDevice.DeviceName, device)
					device.sendProperties()
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

const DRIVER_INTERFACES: Readonly<Record<AlpacaDeviceType, string>> = {
	Switch: '65536',
	Camera: '2',
	Telescope: '1',
	Focuser: '8',
	FilterWheel: '16',
	Rotator: '4096',
	Dome: '32',
	CoverCalibrator: '1536',
	ObservingConditions: '128',
	SafetyMonitor: '',
	Video: '',
}

const DEFAULT_DEF_VECTOR = {
	device: '',
	group: 'Main Control',
	state: 'Idle',
	permission: 'rw',
} as const

class AlpacaDevice<A extends AlpacaDeviceApi = AlpacaDeviceApi> {
	readonly id: number

	private readonly driverInfo: DefTextVector = {
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
		readonly api: A,
		readonly handler: AlpacaClientHandler,
	) {
		this.id = device.DeviceNumber

		this.driverInfo.device = device.DeviceName
		this.driverInfo.elements.DRIVER_INTERFACE.value = DRIVER_INTERFACES[device.DeviceType]

		this.connection.device = device.DeviceName
	}

	get isConnected() {
		return this.connection.elements.CONNECT.value === true
	}

	protected updateSwitchVector(property: DefSwitchVector, name: string, value: boolean, state?: PropertyState) {
		const { rule, elements } = property

		let updated = false

		if (state !== undefined && property.state !== state) {
			property.state = state
			updated = true
		}

		if (rule !== 'AtMostOne' && elements[name].value !== value) {
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

	sendProperties() {
		handleDefTextVector(this.client, this.handler, this.driverInfo)
		handleDefSwitchVector(this.client, this.handler, this.connection)

		handleSetSwitchVector(this.client, this.handler, this.connection)
	}

	async update(tickCount: number) {
		if (tickCount % 2 === 0) {
			const isConnected = await this.api.isConnected(this.id)

			// Failed to fetch
			if (isConnected === undefined) return

			const state = this.connection.state === 'Busy' && isConnected !== this.isConnected ? 'Idle' : undefined

			if (isConnected) {
				this.updateSwitchVector(this.connection, 'CONNECT', true, state)
			} else {
				this.updateSwitchVector(this.connection, 'CONNECT', false, state)
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

class AlpacaFilterWheel extends AlpacaDevice<AlpacaFilterWheelApi> {
	private initialized = false

	private readonly position: DefNumberVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'FILTER_SLOT',
		label: 'Position',
		elements: { FILTER_SLOT_VALUE: { name: 'FILTER_SLOT_VALUE', label: 'Slot', value: 1, min: 0, max: 0, step: 1, format: '%0f' } },
	}

	private readonly names: DefTextVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'FILTER_NAME',
		label: 'Names',
		permission: 'ro',
		elements: {},
	}

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.api.wheel, client.options.handler)

		this.position.device = device.DeviceName
		this.names.device = device.DeviceName
	}

	async update(tickCount: number) {
		await super.update(tickCount)

		if (this.isConnected) {
			if (!this.initialized) {
				this.api.getNames(this.id).then((names) => {
					if (names?.length) {
						this.position.elements.FILTER_SLOT_VALUE.max = names.length

						for (let i = 0; i < names.length; i++) {
							const name = `FILTER_SLOT_NAME_${i + 1}`
							this.names.elements[name] = { name, label: `Filter ${i + 1}`, value: names[i] }
						}

						handleDefNumberVector(this.client, this.handler, this.position)
						handleDefTextVector(this.client, this.handler, this.names)

						this.initialized = true
					}
				})

				return
			}

			this.api.getPosition(this.id).then((position) => {
				if (position !== undefined) {
					this.updateNumberVector(this.position, 'FILTER_SLOT_VALUE', position === -1 ? undefined : position + 1, position === -1 ? 'Busy' : 'Idle')
				}
			})
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

class AlpacaFocuser extends AlpacaDevice<AlpacaFocuserApi> {
	private initialized = false
	private hasTemperature = false

	private readonly absolutePosition: DefNumberVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'ABS_FOCUS_POSITION',
		label: 'Absolute Position',
		elements: { FOCUS_ABSOLUTE_POSITION: { name: 'FOCUS_ABSOLUTE_POSITION', label: 'Position', value: 0, min: 0, max: 0, step: 1, format: '%0f' } },
	}

	private readonly relativePosition: DefNumberVector = {
		...DEFAULT_DEF_VECTOR,
		name: 'REL_FOCUS_POSITION',
		label: 'Relative Position',
		elements: { FOCUS_RELATIVE_POSITION: { name: 'FOCUS_RELATIVE_POSITION', label: 'Steps', value: 0, min: 0, max: 0, step: 1, format: '%0f' } },
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

	constructor(client: AlpacaClient, device: AlpacaConfiguredDevice) {
		super(client, device, client.api.focuser, client.options.handler)

		this.absolutePosition.device = device.DeviceName
		this.relativePosition.device = device.DeviceName
		this.temperature.device = device.DeviceName
		this.abort.device = device.DeviceName
	}

	get isAbsolute() {
		return this.position === this.absolutePosition
	}

	sendProperties() {
		super.sendProperties()

		handleDefSwitchVector(this.client, this.handler, this.abort)
	}

	async update(tickCount: number) {
		await super.update(tickCount)

		if (this.isConnected) {
			if (!this.initialized) {
				const isAbsolute = await this.api.isAbsolute(this.id)

				this.api.getMaxStep(this.id).then((maxStep) => {
					if (maxStep) {
						if (isAbsolute) {
							this.absolutePosition.elements.FOCUS_ABSOLUTE_POSITION.max = maxStep
							this.position = this.absolutePosition
						} else {
							this.relativePosition.elements.FOCUS_RELATIVE_POSITION.max = maxStep
							this.position = this.relativePosition
						}

						handleDefNumberVector(this.client, this.handler, this.position)
					}

					this.initialized = true
				})

				this.api.getTemperature(this.id).then((temperature) => {
					if (temperature !== undefined) {
						this.temperature.elements.TEMPERATURE.value = Math.trunc(temperature)
						handleDefNumberVector(this.client, this.handler, this.temperature)
						this.hasTemperature = true
					}

					this.initialized = true
				})

				return
			}

			if (this.isAbsolute) {
				this.api.getPosition(this.id).then((position) => {
					if (position !== undefined) {
						this.api.isMoving(this.id).then((moving) => {
							this.updateNumberVector(this.position, 'FOCUS_ABSOLUTE_POSITION', position, moving ? 'Busy' : 'Idle')
						})
					}
				})
			} else {
				this.api.isMoving(this.id).then((moving) => {
					this.updateNumberVector(this.position, 'FOCUS_RELATIVE_POSITION', undefined, moving ? 'Busy' : 'Idle')
				})
			}

			if (this.hasTemperature) {
				this.api.getTemperature(this.id).then((temperature) => {
					temperature !== undefined && this.updateNumberVector(this.temperature, 'TEMPERATURE', Math.trunc(temperature))
				})
			}
		}
	}

	sendSwitch(vector: NewSwitchVector) {
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
		switch (vector.name) {
			case 'REL_FOCUS_POSITION':
				if (!this.isAbsolute) this.api.move(this.id, vector.elements.FOCUS_RELATIVE_POSITION * this.direction)
				break
			case 'ABS_FOCUS_POSITION':
				if (this.isAbsolute) this.api.move(this.id, vector.elements.FOCUS_ABSOLUTE_POSITION)
				break
		}
	}
}
