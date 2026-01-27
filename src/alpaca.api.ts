import type { AlpacaConfiguredDevice, AlpacaDeviceType, AlpacaResponse, AlpacaStateItem } from './alpaca.types'

// https://ascom-standards.org/api/

export class AlpacaApi {
	readonly management: AlpacaManagementApi
	readonly wheel: AlpacaFilterWheelApi
	readonly focuser: AlpacaFocuserApi

	constructor(readonly url: string) {
		this.management = new AlpacaManagementApi(url)
		this.wheel = new AlpacaFilterWheelApi(url)
		this.focuser = new AlpacaFocuserApi(url)
	}
}

export class AlpacaManagementApi {
	constructor(readonly url: string) {}

	async configuredDevices() {
		const devices = await request<AlpacaConfiguredDevice[]>(this.url, 'management/v1/configureddevices', 'get')
		if (devices) for (const device of devices) (device as unknown as Record<string, string>).DeviceType = device.DeviceType.toLowerCase()
		return devices
	}
}

export class AlpacaDeviceApi {
	constructor(
		readonly url: string,
		protected readonly type: AlpacaDeviceType,
	) {}

	isConnected(id: number) {
		return request<boolean>(this.url, `api/v1/${this.type}/${id}/connected`, 'get')
	}

	connect(id: number) {
		return request(this.url, `api/v1/${this.type}/${id}/connected`, 'put', { Connected: true })
	}

	disconnect(id: number) {
		return request(this.url, `api/v1/${this.type}/${id}/connected`, 'put', { Connected: false })
	}

	deviceState(id: number) {
		return request<readonly AlpacaStateItem[]>(this.url, `api/v1/${this.type}/${id}/devicestate`, 'get')
	}
}

export class AlpacaFilterWheelApi extends AlpacaDeviceApi {
	constructor(url: string) {
		super(url, 'filterwheel')
	}

	getNames(id: number) {
		return request<string[]>(this.url, `api/v1/filterwheel/${id}/names`, 'get')
	}

	getPosition(id: number) {
		return request<number>(this.url, `api/v1/filterwheel/${id}/position`, 'get')
	}

	setPosition(id: number, Position: number) {
		return request(this.url, `api/v1/filterwheel/${id}/position`, 'put', { Position })
	}
}

export class AlpacaFocuserApi extends AlpacaDeviceApi {
	constructor(url: string) {
		super(url, 'focuser')
	}

	isAbsolute(id: number) {
		return request<boolean>(this.url, `api/v1/focuser/${id}/absolute`, 'get')
	}

	isMoving(id: number) {
		return request<boolean>(this.url, `api/v1/focuser/${id}/ismoving`, 'get')
	}

	getMaxStep(id: number) {
		return request<number>(this.url, `api/v1/focuser/${id}/maxstep`, 'get')
	}

	getPosition(id: number) {
		return request<number>(this.url, `api/v1/focuser/${id}/position`, 'get')
	}

	getTemperature(id: number) {
		return request<number>(this.url, `api/v1/focuser/${id}/temperature`, 'get')
	}

	halt(id: number) {
		return request<void>(this.url, `api/v1/focuser/${id}/halt`, 'put')
	}

	move(id: number, Position: number) {
		return request<void>(this.url, `api/v1/focuser/${id}/move`, 'put', { Position })
	}
}

export class AlpacaCoverCalibratorApi extends AlpacaDeviceApi {
	constructor(url: string) {
		super(url, 'covercalibrator')
	}

	getBrightness(id: number) {
		return request<number>(this.url, `api/v1/covercalibrator/${id}/brightness`, 'get')
	}

	getCalibratorState(id: number) {
		return request<number>(this.url, `api/v1/covercalibrator/${id}/calibratorstate`, 'get')
	}

	getCoverState(id: number) {
		return request<number>(this.url, `api/v1/covercalibrator/${id}/coverstate`, 'get')
	}

	isChanging(id: number) {
		return request<boolean>(this.url, `api/v1/covercalibrator/${id}/calibratorchanging`, 'get')
	}

	isMoving(id: number) {
		return request<boolean>(this.url, `api/v1/covercalibrator/${id}/covermoving`, 'get')
	}

	getMaxBrightness(id: number) {
		return request<number>(this.url, `api/v1/covercalibrator/${id}/maxbrightness`, 'get')
	}

	off(id: number) {
		return request<void>(this.url, `api/v1/covercalibrator/${id}/calibratoroff`, 'put')
	}

	on(id: number, Brightness: number) {
		return request<void>(this.url, `api/v1/covercalibrator/${id}/calibratoron`, 'put', { Brightness })
	}

	close(id: number) {
		return request<void>(this.url, `api/v1/covercalibrator/${id}/closecover`, 'put')
	}

	halt(id: number) {
		return request<void>(this.url, `api/v1/covercalibrator/${id}/haltcover`, 'put')
	}

	open(id: number) {
		return request<void>(this.url, `api/v1/covercalibrator/${id}/opencover`, 'put')
	}
}

const CLIENT_ID = (Date.now() & 0x7fffffff).toFixed(0)

function makeFormDataFromParams(params: Record<string, string | number | boolean>) {
	const body = new FormData()

	body.set('ClientID', CLIENT_ID)
	body.set('ClientTransactionID', '0')

	for (const [name, value] of Object.entries(params)) {
		body.set(name, typeof value === 'string' ? value : typeof value === 'number' ? `${value}` : value ? 'True' : 'False')
	}

	return body
}

async function request<T>(url: string, path: string, method: 'get' | 'put', body?: Record<string, string | number | boolean>, headers?: HeadersInit) {
	try {
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
		} else {
			console.error('request failed', path, text)
		}
	} catch (e) {
		console.error('failed to fetch', e)
	}

	return undefined
}
