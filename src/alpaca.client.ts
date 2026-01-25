import { AlpacaApi, type AlpacaDeviceApi, type AlpacaFilterWheelApi } from './alpaca.api'
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
					this.devices.set(configuredDevice.DeviceName, device)
				}

				device?.sendProperties()
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

class AlpacaDevice<A extends AlpacaDeviceApi = AlpacaDeviceApi> {
	readonly id: number

	private readonly driverInfo: DefTextVector = {
		device: '',
		name: 'DRIVER_INFO',
		label: 'Driver Info',
		group: 'Driver Info',
		permission: 'ro',
		state: 'Idle',
		elements: { DRIVER_INTERFACE: { name: 'DRIVER_INTERFACE', label: 'Interface', value: '' }, DRIVER_EXEC: { name: 'DRIVER_EXEC', label: 'Exec', value: '' }, DRIVER_VERSION: { name: 'DRIVER_VERSION', label: 'Version', value: '1.0' } },
	}

	private readonly connection: DefSwitchVector = {
		device: '',
		name: 'CONNECTION',
		label: 'Connection',
		group: 'Main Control',
		state: 'Idle',
		permission: 'rw',
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
	private readonly position: DefNumberVector = {
		device: '',
		name: 'FILTER_SLOT',
		label: 'Position',
		group: 'Main Control',
		state: 'Idle',
		permission: 'rw',
		elements: { FILTER_SLOT_VALUE: { name: 'FILTER_SLOT_VALUE', label: 'Slot', value: 1, min: 0, max: 0, step: 1, format: '%0f' } },
	}

	private readonly names: DefTextVector = {
		device: '',
		name: 'FILTER_NAME',
		label: 'Names',
		group: 'Main Control',
		state: 'Idle',
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
			if (this.position.elements.FILTER_SLOT_VALUE.max === 0) {
				this.api.getNames(this.id).then((names) => {
					if (names?.length) {
						this.position.elements.FILTER_SLOT_VALUE.max = names.length

						for (let i = 0; i < names.length; i++) {
							const name = `FILTER_SLOT_NAME_${i + 1}`
							this.names.elements[name] = { name, label: `Filter ${i + 1}`, value: names[i] }
						}

						handleDefNumberVector(this.client, this.handler, this.position)
						handleDefTextVector(this.client, this.handler, this.names)
					}
				})
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
