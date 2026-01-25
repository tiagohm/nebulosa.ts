import type { AlpacaConfiguredDevice, AlpacaDeviceType, AlpacaResponse } from './alpaca.types'

// https://ascom-standards.org/api/

export class AlpacaApi {
	readonly management: AlpacaManagementApi
	readonly wheel: AlpacaFilterWheelApi

	constructor(readonly url: string) {
		this.management = new AlpacaManagementApi(url)
		this.wheel = new AlpacaFilterWheelApi(url)
	}
}

export class AlpacaManagementApi {
	constructor(readonly url: string) {}

	configuredDevices() {
		return request<AlpacaConfiguredDevice[]>(this.url, 'management/v1/configureddevices', 'get')
	}
}

export class AlpacaDeviceApi {
	constructor(
		readonly url: string,
		protected readonly type: Lowercase<AlpacaDeviceType>,
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
