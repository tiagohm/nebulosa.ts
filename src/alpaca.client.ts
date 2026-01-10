import type { AlpacaConfiguredDevice, AlpacaDeviceType, AlpacaResponse } from './alpaca.types'
import { CLIENT, type Client, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_POWER, DEFAULT_ROTATOR, DEFAULT_WHEEL, type Device, type Wheel } from './indi.device'
import type { DeviceHandler } from './indi.manager'
import type { EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector } from './indi.types'

export interface AlpacaClientHandler {
	wheel?: DeviceHandler<Wheel>
}

export interface AlpacaClientOptions {
	poolingInterval?: number
	handler?: AlpacaClientHandler
}

const DEVICES = {
	MOUNT: DEFAULT_MOUNT,
	CAMERA: DEFAULT_CAMERA,
	FOCUSER: DEFAULT_FOCUSER,
	WHEEL: DEFAULT_WHEEL,
	COVER: DEFAULT_COVER,
	FLAT_PANEL: DEFAULT_FLAT_PANEL,
	ROTATOR: DEFAULT_ROTATOR,
	POWER: DEFAULT_POWER,
} as const

export class AlpacaClient implements Client {
	private timer?: NodeJS.Timeout
	private readonly wheel = new Map<number, AlpacaWheel>()

	readonly id: string

	constructor(
		readonly url: string,
		private readonly options: AlpacaClientOptions = {},
	) {
		this.id = Bun.MD5.hash(url, 'hex')
	}

	async start() {
		if (this.timer) return false
		const devices = await configuredDevices(this.url)
		if (!devices?.length) return false
		this.initialize(devices)
		return true
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}

		this.wheel.clear()
	}

	list(type: AlpacaDeviceType) {
		if (type === 'FilterWheel') return Array.from(this.wheel.values())
		return []
	}

	get(type: AlpacaDeviceType, id: number) {
		if (type === 'FilterWheel') return this.wheel.get(id)
	}

	has(type: AlpacaDeviceType, id: number) {
		if (type === 'FilterWheel') return this.wheel.has(id)
		return false
	}

	getProperties(command?: GetProperties) {}

	enableBlob(command: EnableBlob) {}

	sendNumber(vector: NewNumberVector) {
		for (const device of this.wheel.values()) if (vector.device === device.name) device.sendNumber(vector)
	}

	sendSwitch(vector: NewSwitchVector) {
		for (const device of this.wheel.values()) if (vector.device === device.name) device.sendSwitch(vector)
	}

	sendText(vector: NewTextVector) {
		for (const device of this.wheel.values()) if (vector.device === device.name) device.sendText(vector)
	}

	private createDevice<T extends keyof typeof DEVICES>({ UniqueID, DeviceName }: AlpacaConfiguredDevice, type: T) {
		return { ...structuredClone(DEVICES[type]), id: UniqueID, name: DeviceName, client: { type: 'ALPACA', id: this.id, ip: '', port: 0 }, [CLIENT]: this } as (typeof DEVICES)[T]
	}

	private initialize(configuredDevices: readonly AlpacaConfiguredDevice[]) {
		for (const configuredDevice of configuredDevices) {
			if (configuredDevice.DeviceType === 'FilterWheel') {
				const device = this.createDevice(configuredDevice, 'WHEEL')
				this.wheel.set(configuredDevice.DeviceNumber, new AlpacaWheel(this, configuredDevice, device))
				this.options.handler?.wheel?.added(device)
			}
		}

		clearInterval(this.timer)
		this.timer = setInterval(() => this.update(), Math.max(1000, this.options.poolingInterval ?? 1000))
		this.update()
	}

	private update() {
		const { handler } = this.options

		for (const device of this.wheel.values()) void device.update(handler?.wheel)
	}
}

function handleValueChange<D extends Device, P extends keyof D>(handler: DeviceHandler<D> | undefined, device: D, property: P & string, updated: D[P] | undefined) {
	if (updated !== undefined && device[property] !== updated) {
		device[property] = updated as never
		handler?.updated?.(device, property)
	}
}

// https://ascom-standards.org/api/

const CLIENT_ID = (Date.now() & 0x7fffffff).toFixed(0)

function makeFormDataFromParams(params: Record<string, string | number | boolean>) {
	const body = new FormData()

	body.set('ClientID', CLIENT_ID)
	body.set('ClientTransactionID', '0')

	for (const [name, value] of Object.entries(params)) {
		body.set(name, typeof value === 'string' ? value : typeof value === 'number' ? value.toString() : value ? 'True' : 'False')
	}

	return body
}

async function request<T>(url: string, path: string, method: 'get' | 'put', body?: Record<string, string | number | boolean>, headers?: HeadersInit) {
	const response = await fetch(`${url}/${path}`, { method, headers, body: body && method === 'put' ? makeFormDataFromParams(body) : undefined })

	const text = await response.text()

	if (response.ok) {
		if (text) {
			const json = JSON.parse(text) as AlpacaResponse<T>

			if (json.ErrorNumber === 0) {
				return json.Value
			}

			console.error(path, json.ErrorNumber, json.ErrorMessage)
		} else {
			console.error(path, text)
		}

		// throw new AlpacaError(json.ErrorNumber, json.ErrorMessage)
	} else {
		console.error('request failed', path, text)
	}

	// throw new AlpacaError(response.status, await response.text())
	return undefined
}

// Management API

export function configuredDevices(url: string) {
	return request<AlpacaConfiguredDevice[]>(url, 'management/v1/configureddevices', 'get')
}

// General API

export class AlpacaDevice<D extends Device> {
	protected readonly url: string
	protected readonly type: Lowercase<AlpacaDeviceType>

	readonly id: number
	readonly name: string

	constructor(
		client: AlpacaClient,
		readonly configuredDevice: AlpacaConfiguredDevice,
		readonly device: D,
	) {
		this.url = client.url
		this.id = configuredDevice.DeviceNumber
		this.name = configuredDevice.DeviceName
		this.type = configuredDevice.DeviceType.toLowerCase() as never
	}

	isConnected() {
		return request<boolean>(this.url, `api/v1/${this.type}/${this.id}/connected`, 'get')
	}

	connect() {
		return request(this.url, `api/v1/${this.type}/${this.id}/connected`, 'put', { Connected: true })
	}

	disconnect() {
		return request(this.url, `api/v1/${this.type}/${this.id}/connected`, 'put', { Connected: false })
	}

	async update(handler: DeviceHandler<D> | undefined) {
		handleValueChange(handler, this.device, 'connected', await this.isConnected())
	}

	sendNumber(vector: NewNumberVector) {}

	sendSwitch(vector: NewSwitchVector) {}

	sendText(vector: NewTextVector) {}
}

export class AlpacaWheel extends AlpacaDevice<Wheel> {
	getNames() {
		return request<string[]>(this.url, `api/v1/filterwheel/${this.id}/names`, 'get')
	}

	getPosition() {
		return request<number>(this.url, `api/v1/filterwheel/${this.id}/position`, 'get')
	}

	setPosition(Position: number) {
		return request(this.url, `api/v1/filterwheel/${this.id}/position`, 'put', { Position })
	}

	async update(handler: DeviceHandler<Wheel> | undefined) {
		await super.update(handler)

		const { device } = this

		if (device.connected) {
			if (device.slots.length === 0) void this.getNames().then((value) => handleValueChange(handler, device, 'slots', value))
			void this.getPosition().then((value) => handleValueChange(handler, device, 'position', value))
		} else {
		}
	}
}
