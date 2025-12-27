export const ALPACA_DISCOVERY_PORT = 32227
export const ALPACA_DISCOVERY_DATA = 'alpacadiscovery1'

export type AlpacaDiscoverablePorts = readonly number[]

export class AlpacaDiscoveryServer {
	private socket?: Bun.udp.Socket<'buffer'>

	constructor(private readonly discoverablePorts: AlpacaDiscoverablePorts | Promise<AlpacaDiscoverablePorts> | (() => AlpacaDiscoverablePorts | Promise<AlpacaDiscoverablePorts>)) {}

	async start(hostname: string = '0.0.0.0', port: number = ALPACA_DISCOVERY_PORT) {
		if (this.socket) return false

		this.socket = await Bun.udpSocket({
			hostname,
			port,
			socket: {
				data: (socket, data, port, address) => {
					if (data.toString('utf-8') === ALPACA_DISCOVERY_DATA) {
						this.send(socket, port, address)
					}
				},
				error: (socket, error) => {
					console.error(error)
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
		const ports = this.discoverablePorts instanceof Function ? this.discoverablePorts() : this.discoverablePorts
		if (ports instanceof Promise) ports.then((ports) => ports.forEach((p) => socket.send(`{"AlpacaPort": ${p.toFixed(0)}}`, port, address)))
		else ports.forEach((p) => socket.send(`{"AlpacaPort": ${p.toFixed(0)}}`, port, address))
	}
}
