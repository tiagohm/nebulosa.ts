import { type NetworkInterfaceInfo, networkInterfaces } from 'os'
import { AlpacaManagementApi } from './alpaca.api'
import type { AlpacaConfiguredDevice } from './alpaca.types'

export const ALPACA_DISCOVERY_PORT = 32227
export const ALPACA_DISCOVERY_DATA = 'alpacadiscovery1'

export interface AlpacaDiscoveryServerOptions {
	ignoreLocalhost?: boolean
}

export class AlpacaDiscoveryServer {
	private socket?: Bun.udp.Socket<'buffer'>
	private readonly ports = new Set<number>()

	constructor(private readonly options?: AlpacaDiscoveryServerOptions) {}

	addPort(port: number) {
		this.ports.add(port)
	}

	removePort(port: number) {
		this.ports.delete(port)
	}

	get port() {
		return this.socket?.port ?? -1
	}

	get host() {
		return this.socket?.hostname
	}

	get ip() {
		return this.socket?.address.address
	}

	get running() {
		return !!this.socket
	}

	async start(hostname: string = '0.0.0.0', port: number = ALPACA_DISCOVERY_PORT, ignoreLocalhost = this.options?.ignoreLocalhost ?? true) {
		if (this.socket) return false

		this.socket = await Bun.udpSocket({
			hostname,
			port,
			socket: {
				data: (socket, data, port, address) => {
					if (ignoreLocalhost && (address === '127.0.0.1' || address === 'localhost')) return

					if (data.toString('utf-8') === ALPACA_DISCOVERY_DATA) {
						this.send(socket, port, address)
					}
				},
				error: (_, error) => {
					console.error('socket error:', error)
				},
			},
		})

		return true
	}

	stop() {
		if (this.socket) {
			this.socket.close()
			this.socket = undefined
		}
	}

	private send(socket: Bun.udp.Socket<'buffer'>, port: number, address: string) {
		this.ports.forEach((p) => socket.send(`{"AlpacaPort": ${p.toFixed(0)}}`, port, address))
	}
}

function broadcastAddress(i: NetworkInterfaceInfo, family: NetworkInterfaceInfo['family']) {
	if (family === 'IPv6') return i.internal ? '::1' : 'ff02::1'

	const address = i.address.split('.')
	const netmask = i.netmask.split('.')
	// bitwise OR over the splitted NAND netmask, then glue them back together with a dot character to form an ip
	// we have to do a NAND operation because of the 2-complements; getting rid of all the 'prepended' 1's with & 0xFF
	return address.map((e, i) => (~netmask[i] & 0xff) | +e).join('.')
}

export interface AlpacaDiscoveryOptions {
	family?: NetworkInterfaceInfo['family']
	port?: number
	host?: string
	timeout?: number // ms
	fetch?: boolean
	wait?: boolean
}

export interface AlpacaDeviceServer {
	readonly address: string
	readonly port: number
	readonly devices: readonly AlpacaConfiguredDevice[]
}

const DEFAULT_ALPACA_DISCOVERY_OPTIONS: Required<AlpacaDiscoveryOptions> = {
	family: 'IPv4',
	port: ALPACA_DISCOVERY_PORT,
	host: '0.0.0.0',
	timeout: 15000,
	fetch: true,
	wait: false,
}

export class AlpacaDiscoveryClient implements Disposable {
	private socket?: Bun.udp.Socket<'buffer'>
	private timeout?: NodeJS.Timeout
	private wait?: PromiseWithResolvers<boolean>

	async discovery(onDiscovery: (server: AlpacaDeviceServer) => void, options: AlpacaDiscoveryOptions = DEFAULT_ALPACA_DISCOVERY_OPTIONS) {
		if (this.socket) return false

		this.wait = options.wait ? Promise.withResolvers<boolean>() : undefined

		this.socket = await Bun.udpSocket({
			hostname: options.host || DEFAULT_ALPACA_DISCOVERY_OPTIONS.host,
			socket: {
				data: async (socket, data, _, address) => {
					const port = +JSON.parse(data.toString('utf-8'))?.AlpacaPort

					if (port) {
						if (options.fetch ?? DEFAULT_ALPACA_DISCOVERY_OPTIONS.fetch) {
							const host = address.includes(':') ? `[${address}]` : address
							const url = `http://${host}:${port}`

							try {
								const api = new AlpacaManagementApi(url)
								const devices = await api.configuredDevices()
								devices && onDiscovery({ address, port, devices })
							} catch (e) {
								console.error('failed to fetch configured devices at', url, e)
							}
						} else {
							onDiscovery({ address, port, devices: [] })
						}
					}
				},
				error: (_, error) => {
					console.error('socket error:', error)
				},
			},
		})

		// https://github.com/oven-sh/bun/issues/15746
		this.socket.setBroadcast(true)

		if (options.timeout !== 0) {
			this.timeout = setTimeout(() => this.close(), options.timeout ?? DEFAULT_ALPACA_DISCOVERY_OPTIONS.timeout)
		}

		try {
			const interfaces = networkInterfaces()
			const names = Object.keys(interfaces)
            const family = options.family || DEFAULT_ALPACA_DISCOVERY_OPTIONS.family
			const port = options.port || DEFAULT_ALPACA_DISCOVERY_OPTIONS.port

			if (names.length) {
				for (const name of names) {
					for (const i of interfaces[name]!) {
						if (i.family === family) {
							this.socket.send(ALPACA_DISCOVERY_DATA, port, broadcastAddress(i, family))
						}
					}
				}
			}
		} catch (e) {
			this.close()
			console.error(e)
		}

		return this.wait?.promise ?? true
	}

	close() {
		clearTimeout(this.timeout)
		this.timeout = undefined

		this.socket?.close()
		this.socket = undefined

		this.wait?.resolve(true)
		this.wait = undefined
	}

	[Symbol.dispose]() {
		this.close()
	}
}
