import type { Socket, TCPSocketListener } from 'bun'
import { eraAnpm } from '../../astronomy/coordinates/erfa/erfa'
import { PI } from '../../core/constants'
import { type Angle, normalizeAngle } from '../../math/units/angle'

// TCP server for Stellarium's telescope-control protocol. It accepts goto targets and broadcasts the
// current position using radians at the public API boundary.

// Callbacks the Stellarium server uses: connect/disconnect notifications and the goto target (radians).
export interface StellariumProtocolHandler {
	readonly connect?: (server: StellariumProtocolServer) => void
	readonly goto?: (server: StellariumProtocolServer, ra: Angle, dec: Angle) => void
	readonly disconnect?: (server: StellariumProtocolServer) => void
}

// Server options: the handler.
export interface StellariumProtocolServerOptions {
	handler: StellariumProtocolHandler
}

// Minimum valid message size: two-byte length and two-byte type fields.
const STELLARIUM_MESSAGE_HEADER_SIZE = 4
// Size of a client-to-server goto message, including its four-byte header.
const STELLARIUM_GOTO_MESSAGE_SIZE = 20
// Maximum message size accepted from Stellarium's telescope-control client.
const STELLARIUM_MAX_MESSAGE_SIZE = 120

// TCP server speaking the Stellarium telescope protocol. Decodes goto requests and broadcasts the
// current coordinates as the protocol's 24-byte position messages.
// https://free-astro.org/images/b/b7/Stellarium_telescope_protocol.txt
// https://github.com/Stellarium/stellarium/blob/master/plugins/TelescopeControl/src/TelescopeClient.cpp
export class StellariumProtocolServer {
	readonly #sockets: Socket<unknown>[] = []
	// Per-socket accumulation of length-prefixed messages split across TCP data events.
	readonly #buffers = new Map<Socket<unknown>, Buffer>()
	#server?: TCPSocketListener

	constructor(readonly options: Readonly<StellariumProtocolServerOptions>) {}

	// Bound hostname/port, or undefined/-1 when stopped.
	get hostname() {
		return this.#server?.hostname
	}

	get port() {
		return this.#server?.port ?? -1
	}

	// Starts the TCP listener. Returns false if already started.
	start(hostname: string, port: number) {
		if (this.#server) return false

		this.#server = Bun.listen({
			hostname,
			port,
			allowHalfOpen: false,
			socket: {
				data: (socket, data) => {
					this.#processData(socket, data)
				},
				open: (socket) => {
					console.info('connection open')
					this.#sockets.push(socket)
					this.options.handler.connect?.(this)
				},
				close: (socket) => {
					console.warn('connection closed')
					const index = this.#sockets.indexOf(socket)
					if (index >= 0) this.#sockets.splice(index, 1)
					this.#buffers.delete(socket)
					this.options.handler.disconnect?.(this)
				},
				error: (_, error) => {
					console.error('socket error:', error)
				},
				connectError: (_, error) => {
					console.error('connection failed:', error)
				},
				timeout: () => {
					console.warn('connection timed out')
				},
			},
		})

		return true
	}

	// Stops the listener and drops all clients.
	stop() {
		this.#server?.stop(true)
		this.#server = undefined
		this.#sockets.length = 0
		this.#buffers.clear()
	}

	// Broadcasts the current position to all connected Stellarium clients, encoding RA/Dec (radians) as
	// the protocol's signed fixed-point values in a 24-byte message.
	send(ra: Angle, dec: Angle) {
		if (this.#sockets.length > 0) {
			const buffer = Buffer.allocUnsafe(24)
			buffer.writeInt16LE(24, 0) // length
			buffer.writeInt16LE(0, 2) // type
			// buffer.writeBigInt64LE(BigInt(Date.now() * 1000)) // time
			buffer.writeInt32LE(0, 4) // time (unused)
			buffer.writeInt32LE(0, 8) // time (unused)
			buffer.writeInt32LE(Math.trunc((eraAnpm(ra) / PI) * 0x80000000), 12)
			buffer.writeInt32LE(Math.trunc((dec / PI) * 0x80000000), 16)
			buffer.writeInt32LE(0, 20) // status = OK

			for (const socket of this.#sockets) {
				socket.write(buffer)
				socket.flush()
			}
		}
	}

	// Accumulates bytes per socket and decodes each complete length-prefixed message. Invalid message
	// lengths close the connection to prevent the stream from losing synchronization.
	#processData(socket: Socket<unknown>, data: Buffer) {
		const previous = this.#buffers.get(socket)
		const buffer = previous ? Buffer.concat([previous, data]) : data
		let position = 0

		while (buffer.byteLength - position >= 2) {
			const length = buffer.readUInt16LE(position)

			if (length < STELLARIUM_MESSAGE_HEADER_SIZE || length > STELLARIUM_MAX_MESSAGE_SIZE) {
				this.#buffers.delete(socket)
				socket.close()
				return
			}

			if (buffer.byteLength - position < length) break

			if (length >= STELLARIUM_GOTO_MESSAGE_SIZE && buffer.readUInt16LE(position + 2) === 0 && this.options.handler.goto) {
				const message = buffer.subarray(position, position + length)
				const ra = normalizeAngle((message.readUInt32LE(12) * PI) / 0x80000000)
				const dec = (message.readInt32LE(16) * PI) / 0x80000000
				this.options.handler.goto(this, ra, dec)
			}

			position += length
		}

		if (position === buffer.byteLength) this.#buffers.delete(socket)
		else this.#buffers.set(socket, buffer.subarray(position))
	}
}
