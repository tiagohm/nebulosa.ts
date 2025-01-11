import type { Socket, TCPSocketListener } from 'bun'
import { normalize, type Angle } from './angle'
import { PI } from './constants'
import { eraAnpm } from './erfa'

export interface StellariumProtocolServerOptions {
	onConnect: () => void
	onGoto?: (ra: Angle, dec: Angle) => void
	onClose?: () => void
}

// https://free-astro.org/images/b/b7/Stellarium_telescope_protocol.txt
// https://github.com/Stellarium/stellarium/blob/master/plugins/TelescopeControl/src/TelescopeClient.cpp

export class StellariumProtocolServer {
	private readonly sockets: Socket<unknown>[] = []
	private server?: TCPSocketListener

	constructor(
		private readonly host: string,
		private readonly port: number,
		private readonly options?: StellariumProtocolServerOptions,
	) {}

	start() {
		if (this.server) return

		this.server = Bun.listen({
			hostname: this.host,
			port: this.port,
			allowHalfOpen: false,
			socket: {
				data: (_, data) => {
					this.handleData(data)
				},
				open: (socket) => {
					console.info('connection open')
					this.sockets.push(socket)
					this.options?.onConnect()
				},
				close: (socket) => {
					console.warn('connection closed')
					const index = this.sockets.indexOf(socket)
					if (index >= 0) this.sockets.splice(index, 1)
					this.options?.onClose?.()
				},
				error: (_, error) => {
					console.error('connection failed', error)
				},
				timeout: () => {
					console.warn('connection timed out')
				},
			},
		})
	}

	close() {
		this.server?.stop(true)
		this.server = undefined
		this.sockets.length = 0
	}

	send(ra: Angle, dec: Angle) {
		if (this.sockets.length) {
			const buffer = Buffer.alloc(24)
			buffer.writeInt16LE(24, 0) // length
			buffer.writeInt16LE(0, 2) // type
			// buffer.writeBigInt64LE(BigInt(Date.now() * 1000)) // time
			buffer.writeInt32LE(0, 4) // time (unused)
			buffer.writeInt32LE(0, 8) // time (unused)
			buffer.writeInt32LE(Math.trunc((eraAnpm(ra) / PI) * 0x80000000), 12)
			buffer.writeInt32LE(Math.trunc((dec / PI) * 0x80000000), 16)
			buffer.writeInt32LE(0, 20) // status = OK

			for (const socket of this.sockets) {
				socket.write(buffer)
				socket.flush()
			}
		}
	}

	private handleData(buffer: Buffer) {
		if (buffer.byteLength >= 20 && this.options?.onGoto) {
			const ra = normalize((buffer.readUInt32LE(12) * PI) / 0x80000000)
			const dec = (buffer.readInt32LE(16) * PI) / 0x80000000
			this.options.onGoto(ra, dec)
		}
	}
}
