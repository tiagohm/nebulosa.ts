import { createSocket, type Socket as DgramSocket, type RemoteInfo } from 'node:dgram'
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os'
import { AlpacaManagementApi } from './alpaca.api'
import type { AlpacaConfiguredDevice } from './alpaca.types'

export const ALPACA_DISCOVERY_PORT = 32227
export const ALPACA_DISCOVERY_DATA = 'alpacadiscovery1'
export const ALPACA_DISCOVERY_IPV6_GROUP = 'ff12::a1:9aca'

export interface AlpacaDiscoveryServerOptions {
	ignoreLocalhost?: boolean
}

export class AlpacaDiscoveryServer {
	#socket?: DgramSocket
	readonly #ports = new Set<number>()

	constructor(readonly options?: AlpacaDiscoveryServerOptions) {}

	// Registers an Alpaca management port to announce in discovery responses.
	addPort(port: number) {
		if (isValidAlpacaPort(port)) this.#ports.add(port)
	}

	// Removes a previously announced Alpaca management port.
	removePort(port: number) {
		this.#ports.delete(port)
	}

	// Returns the bound discovery socket port or -1 when stopped.
	get port() {
		return this.#socket?.address().port ?? -1
	}

	// Returns the bound discovery socket address.
	get host() {
		return this.#socket?.address().address
	}

	// Returns the bound discovery socket IP address.
	get ip() {
		return this.#socket?.address().address
	}

	// Reports whether the discovery server socket is active.
	get running() {
		return !!this.#socket
	}

	// Starts listening for Alpaca discovery probes on the requested hostname and port.
	async start(hostname: string = '0.0.0.0', port: number = ALPACA_DISCOVERY_PORT, ignoreLocalhost = this.options?.ignoreLocalhost ?? true): Promise<boolean> {
		if (this.#socket) return false

		const family = hostname.includes(':') ? 'udp6' : 'udp4'
		// Use node:dgram because Alpaca discovery requires shared binds and Bun.udpSocket still returns EADDRINUSE for same-port servers.
		const socket = createSocket({ type: family, reuseAddr: true })
		this.#socket = socket

		socket.on('message', (data: Buffer, remote: RemoteInfo) => {
			if (ignoreLocalhost && isLoopbackAddress(remote.address)) return
			if (data.toString('utf-8') === ALPACA_DISCOVERY_DATA) this.#send(socket, remote.port, remote.address)
		})

		socket.on('error', (error: Error) => {
			console.error('socket error:', error)
		})

		try {
			await bindSocket(socket, port, hostname)
			if (family === 'udp6') joinIpv6MulticastGroup(socket, ignoreLocalhost)
		} catch (e) {
			this.stop()
			throw e
		}

		return true
	}

	// Stops listening and releases the discovery socket.
	stop() {
		if (this.#socket) {
			this.#socket.close()
			this.#socket = undefined
		}
	}

	// Sends one protocol-compliant JSON response for each announced Alpaca port.
	#send(socket: DgramSocket, port: number, address: string) {
		for (const p of this.#ports) socket.send(`{"AlpacaPort":${p}}`, port, address)
	}
}

// export class BunSocketAlpacaDiscoveryServer {
// 	#socket?: Bun.udp.Socket<'buffer'>
// 	readonly #ports = new Set<number>()

// 	constructor(readonly options?: AlpacaDiscoveryServerOptions) {}

// 	// Registers an Alpaca management port to announce in discovery responses.
// 	addPort(port: number) {
// 		if (isValidAlpacaPort(port)) this.#ports.add(port)
// 	}

// 	// Removes a previously announced Alpaca management port.
// 	removePort(port: number) {
// 		this.#ports.delete(port)
// 	}

// 	// Returns the bound discovery socket port or -1 when stopped.
// 	get port() {
// 		return this.#socket?.port ?? -1
// 	}

// 	// Returns the bound discovery socket address.
// 	get host() {
// 		return this.#socket?.hostname
// 	}

// 	// Returns the bound discovery socket IP address.
// 	get ip() {
// 		return this.#socket?.address.address
// 	}

// 	// Reports whether the discovery server socket is active.
// 	get running() {
// 		return !!this.#socket
// 	}

// 	// Starts listening for Alpaca discovery probes on the requested hostname and port using Bun's UDP socket.
// 	async start(hostname: string = '0.0.0.0', port: number = ALPACA_DISCOVERY_PORT, ignoreLocalhost = this.options?.ignoreLocalhost ?? true): Promise<boolean> {
// 		if (this.#socket) return false

// 		const family = hostname.includes(':') ? 'IPv6' : 'IPv4'
// 		const socket = await Bun.udpSocket({
// 			hostname,
// 			port,
//             socket: {
// 				data: (socket, data, responsePort, address) => {
// 					if (ignoreLocalhost && isLoopbackAddress(address)) return
// 					if (data.toString('utf-8') === ALPACA_DISCOVERY_DATA) this.#send(socket, responsePort, address)
// 				},
// 				error: (_, error) => {
// 					console.error('socket error:', error)
// 				},
// 			},
// 		})

// 		this.#socket = socket

// 		if (family === 'IPv6') joinBunIpv6MulticastGroup(socket, ignoreLocalhost)

// 		return true
// 	}

// 	// Stops listening and releases the discovery socket.
// 	stop() {
// 		if (this.#socket) {
// 			this.#socket.close()
// 			this.#socket = undefined
// 		}
// 	}

// 	// Sends one protocol-compliant JSON response for each announced Alpaca port.
// 	#send(socket: Bun.udp.Socket<'buffer'>, port: number, address: string) {
// 		for (const p of this.#ports) socket.send(`{"AlpacaPort":${p}}`, port, address)
// 	}
// }

// Computes the per-interface IPv4 broadcast or Alpaca IPv6 multicast destination address.
function broadcastAddress(i: NetworkInterfaceInfo, family: NetworkInterfaceInfo['family']) {
	if (family === 'IPv6') return i.internal ? '::1' : ALPACA_DISCOVERY_IPV6_GROUP

	const address = i.address.split('.')
	const netmask = i.netmask.split('.')
	// bitwise OR over the splitted NAND netmask, then glue them back together with a dot character to form an ip
	// we have to do a NAND operation because of the 2-complements; getting rid of all the 'prepended' 1's with & 0xFF
	return address.map((e, i) => (~netmask[i] & 0xff) | +e).join('.')
}

// Selects a protocol-family-compatible local bind address.
function defaultDiscoveryHost(family: NetworkInterfaceInfo['family']) {
	return family === 'IPv6' ? '::' : '0.0.0.0'
}

// Adds the IPv6 scope suffix when the interface provides one.
function interfaceAddress(i: NetworkInterfaceInfo, family: NetworkInterfaceInfo['family']) {
	return family === 'IPv6' && i.scopeid ? `${i.address}%${i.scopeid}` : i.address
}

// Checks whether an address points to a local loopback endpoint.
function isLoopbackAddress(address: string) {
	return address === 'localhost' || address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

// Validates a TCP/UDP port number for Alpaca discovery payloads.
function isValidAlpacaPort(port: number) {
	return Number.isInteger(port) && port > 0 && port <= 65535
}

// Parses a discovery response payload defensively and returns a valid Alpaca port.
function parseDiscoveryPort(data: Buffer) {
	try {
		const json = JSON.parse(data.toString('utf-8')) as unknown
		if (!json || typeof json !== 'object') return undefined

		const port = (json as { readonly AlpacaPort?: unknown }).AlpacaPort
		if (typeof port === 'number') return isValidAlpacaPort(port) ? port : undefined
		if (typeof port === 'string') {
			const parsed = Number.parseInt(port, 10)
			return `${parsed}` === port && isValidAlpacaPort(parsed) ? parsed : undefined
		}
	} catch {
		//
	}

	return undefined
}

// Binds a UDP socket and rejects if the socket emits a bind-time error.
function bindSocket(socket: DgramSocket, port: number, hostname: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			socket.off('error', onError)
			reject(error)
		}

		socket.once('error', onError)
		socket.bind(port, hostname, () => {
			socket.off('error', onError)
			resolve()
		})
	})
}

// Joins the Alpaca IPv6 multicast group on every eligible local interface.
function joinIpv6MulticastGroup(socket: DgramSocket, ignoreLocalhost: boolean) {
	const interfaces = networkInterfaces()
	const names = Object.keys(interfaces)
	let joined = false

	for (const name of names) {
		for (const i of interfaces[name]!) {
			if (i.family !== 'IPv6' || (ignoreLocalhost && i.internal)) continue

			try {
				socket.addMembership(ALPACA_DISCOVERY_IPV6_GROUP, interfaceAddress(i, 'IPv6'))
				joined = true
			} catch {
				//
			}
		}
	}

	if (!joined) {
		try {
			socket.addMembership(ALPACA_DISCOVERY_IPV6_GROUP)
		} catch {
			//
		}
	}
}

// Joins the Alpaca IPv6 multicast group on every eligible local interface through Bun's UDP socket API.
function joinBunIpv6MulticastGroup(socket: Bun.udp.Socket<'buffer'>, ignoreLocalhost: boolean) {
	const interfaces = networkInterfaces()
	const names = Object.keys(interfaces)
	let joined = false

	for (const name of names) {
		for (const i of interfaces[name]!) {
			if (i.family !== 'IPv6' || (ignoreLocalhost && i.internal)) continue

			try {
				socket.addMembership(ALPACA_DISCOVERY_IPV6_GROUP, interfaceAddress(i, 'IPv6'))
				joined = true
			} catch {
				//
			}
		}
	}

	if (!joined) {
		try {
			socket.addMembership(ALPACA_DISCOVERY_IPV6_GROUP)
		} catch {
			//
		}
	}
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
	#socket?: Bun.udp.Socket<'buffer'>
	#timeout?: NodeJS.Timeout
	#wait?: PromiseWithResolvers<boolean>

	// Broadcasts an Alpaca discovery probe and reports every valid server response.
	async discovery(onDiscovery: (server: AlpacaDeviceServer) => void, options: AlpacaDiscoveryOptions = DEFAULT_ALPACA_DISCOVERY_OPTIONS): Promise<boolean> {
		if (this.#socket) return false

		const family = options.family ?? DEFAULT_ALPACA_DISCOVERY_OPTIONS.family
		const host = options.host ?? defaultDiscoveryHost(family)
		const port = options.port ?? DEFAULT_ALPACA_DISCOVERY_OPTIONS.port
		const fetch = options.fetch ?? DEFAULT_ALPACA_DISCOVERY_OPTIONS.fetch

		this.#wait = options.wait ? Promise.withResolvers<boolean>() : undefined

		const socket = await Bun.udpSocket({
			hostname: host,
			socket: {
				data: (_, data, __, address) => {
					const discoveredPort = parseDiscoveryPort(data)
					if (!discoveredPort) return

					void this.#processDiscoveryResponse(address, discoveredPort, fetch, onDiscovery)
				},
				error: (_, error) => {
					console.error('socket error:', error)
				},
			},
		})
		this.#socket = socket

		if (family === 'IPv4') socket.setBroadcast(true)
		else socket.setMulticastLoopback(true)

		if (options.timeout !== 0) {
			this.#timeout = setTimeout(() => this.close(), options.timeout ?? DEFAULT_ALPACA_DISCOVERY_OPTIONS.timeout)
		}

		try {
			const interfaces = networkInterfaces()
			const names = Object.keys(interfaces)

			if (names.length) {
				for (const name of names) {
					for (const i of interfaces[name]!) {
						if (i.family === family) {
							if (family === 'IPv6' && !i.internal) socket.setMulticastInterface(interfaceAddress(i, family))
							socket.send(ALPACA_DISCOVERY_DATA, port, broadcastAddress(i, family))
						}
					}
				}
			}
		} catch (e) {
			this.close()
			console.error(e)
		}

		return this.#wait?.promise ?? true
	}

	// Closes the discovery socket and resolves a pending wait promise.
	close() {
		clearTimeout(this.#timeout)
		this.#timeout = undefined

		this.#socket?.close()
		this.#socket = undefined

		this.#wait?.resolve(true)
		this.#wait = undefined
	}

	// Disposes the discovery socket when used with explicit resource management.
	[Symbol.dispose]() {
		this.close()
	}

	// Fetches the management API details for a discovered server when requested.
	async #processDiscoveryResponse(address: string, port: number, fetch: boolean, onDiscovery: (server: AlpacaDeviceServer) => void): Promise<void> {
		if (fetch) {
			const host = address.includes(':') ? `[${address}]` : address
			const url = `http://${host}:${port}`
			const api = new AlpacaManagementApi(url)

			try {
				const devices = await api.configuredDevices()
				if (devices) onDiscovery({ address, port, devices })
			} catch (e) {
				console.error('failed to fetch configured devices at', url, e)
			}
		} else {
			onDiscovery({ address, port, devices: [] })
		}
	}
}
