import type { Socket, TCPSocketListener } from 'bun'
import { eraAnpm } from '../../astronomy/coordinates/erfa/erfa'
import { PI } from '../../core/constants'
import { SocketWriteQueue } from '../../io/socket'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { type ProtocolClient, type ProtocolClientEntry, ProtocolClients } from './client'

// TCP server for Stellarium's telescope-control protocol. It accepts goto targets and broadcasts the
// current position using radians at the public API boundary. Several clients may connect at once; each goto
// is reported with the client that sent it. A client that does not read skips positions until its socket drains
// instead of receiving a message cut short.

// Callbacks the Stellarium server uses: connect/disconnect notifications and the goto target (radians).
export interface StellariumProtocolHandler {
	// A client connected; runs for every client.
	readonly connect?: (server: StellariumProtocolServer) => void
	// A client connected, with its identity; runs for every client, after connect.
	readonly clientOpen?: (server: StellariumProtocolServer, client: ProtocolClient) => void
	// A client asked to slew to a J2000 target; the protocol has no reply, so a refusal cannot be reported to it.
	readonly goto?: (server: StellariumProtocolServer, ra: Angle, dec: Angle, client: ProtocolClient) => void
	// A client disconnected, with its identity; runs exactly once for every client, before disconnect.
	readonly clientClose?: (server: StellariumProtocolServer, client: ProtocolClient) => void
	// A client disconnected; runs for every client.
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

// Parsing state of one client.
interface StellariumClientState {
	// Bytes of an incomplete message, absent between messages.
	buffer?: Buffer
	// Output not yet taken by the socket: at most the unwritten tail of one position message.
	readonly output: SocketWriteQueue
}

// TCP server speaking the Stellarium telescope protocol. Decodes goto requests and broadcasts the
// current coordinates as the protocol's 24-byte position messages.
// https://free-astro.org/images/b/b7/Stellarium_telescope_protocol.txt
// https://github.com/Stellarium/stellarium/blob/master/plugins/TelescopeControl/src/TelescopeClient.cpp
export class StellariumProtocolServer {
	// Clients of the current run, replaced on every start. The state of each is its accumulation of
	// length-prefixed messages split across TCP data events and its pending output.
	#clients = new ProtocolClients<StellariumClientState>()
	#server?: TCPSocketListener

	constructor(readonly options: Readonly<StellariumProtocolServerOptions>) {}

	// Bound hostname/port, or undefined/-1 when stopped.
	get hostname() {
		return this.#server?.hostname
	}

	get port() {
		return this.#server?.port ?? -1
	}

	// Starts the TCP listener. Returns false if already started; throws the bind error (such as EADDRINUSE) when
	// the address cannot be used.
	start(hostname: string, port: number) {
		if (this.#server) return false

		// Callbacks of this run only ever reach this run's clients, so a socket of a stopped run arriving late
		// cannot touch a server started again meanwhile.
		const clients = new ProtocolClients<StellariumClientState>()

		this.#server = Bun.listen({
			hostname,
			port,
			allowHalfOpen: false,
			socket: {
				data: (socket, data) => {
					const entry = clients.get(socket)
					if (entry) this.#processData(clients, entry, data)
				},
				drain: (socket) => {
					clients.get(socket)?.state.output.drain(socket)
				},
				open: (socket) => {
					console.info('connection open')
					const entry = clients.add(socket, { output: new SocketWriteQueue() })
					this.options.handler.connect?.(this)
					this.options.handler.clientOpen?.(this, entry.client)
				},
				close: (socket) => {
					console.warn('connection closed')
					const entry = clients.delete(socket)
					if (entry) this.#notifyClosed(entry.client)
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

		this.#clients = clients

		return true
	}

	// Stops the listener and closes every client, reporting each one closed. Idempotent.
	stop() {
		const clients = this.#clients
		this.#clients = new ProtocolClients()
		this.#server?.stop(true)
		this.#server = undefined
		for (const entry of Array.from(clients.values())) this.#drop(clients, entry)
	}

	// Connected clients of the current run, in connection order.
	clients(): readonly ProtocolClient[] {
		return this.#clients.list()
	}

	// Closes the connection of one client, leaving the listener and the other clients untouched. The client is
	// reported closed before this returns. Returns false when no such client is connected.
	disconnectClient(id: string) {
		const entry = this.#clients.find(id)
		if (!entry) return false
		this.#drop(this.#clients, entry)
		return true
	}

	// Removes a client, reports it closed, and ends its socket. The close callback that follows finds nothing to
	// remove, so the client is reported once.
	#drop(clients: ProtocolClients<StellariumClientState>, entry: ProtocolClientEntry<StellariumClientState>) {
		if (clients.delete(entry.socket) === undefined) return
		this.#notifyClosed(entry.client)
		entry.socket.end()
	}

	// Reports one client closed.
	#notifyClosed(client: ProtocolClient) {
		this.options.handler.clientClose?.(this, client)
		this.options.handler.disconnect?.(this)
	}

	// Broadcasts the current position to all connected Stellarium clients, encoding RA/Dec (radians) as
	// the protocol's signed fixed-point values in a 24-byte message. A socket still writing the tail of an earlier
	// position skips this one, since the next position supersedes it.
	send(ra: Angle, dec: Angle) {
		if (this.#clients.size > 0) {
			const buffer = Buffer.allocUnsafe(24)
			buffer.writeInt16LE(24, 0) // length
			buffer.writeInt16LE(0, 2) // type
			// buffer.writeBigInt64LE(BigInt(Date.now() * 1000)) // time
			buffer.writeInt32LE(0, 4) // time (unused)
			buffer.writeInt32LE(0, 8) // time (unused)
			buffer.writeInt32LE(Math.trunc((eraAnpm(ra) / PI) * 0x80000000), 12)
			buffer.writeInt32LE(Math.trunc((dec / PI) * 0x80000000), 16)
			buffer.writeInt32LE(0, 20) // status = OK

			for (const { socket, state } of this.#clients.values()) {
				if (state.output.pending > 0) continue
				state.output.write(socket, buffer)
				socket.flush()
			}
		}
	}

	// Accumulates bytes per client and decodes each complete length-prefixed message. Invalid message
	// lengths close the client to prevent its stream from losing synchronization.
	#processData(clients: ProtocolClients<StellariumClientState>, entry: ProtocolClientEntry<StellariumClientState>, data: Buffer) {
		const { state } = entry
		const buffer = state.buffer ? Buffer.concat([state.buffer, data]) : data
		let position = 0

		state.buffer = undefined

		while (buffer.byteLength - position >= 2) {
			// A goto handler may have closed the client.
			if (clients.get(entry.socket) !== entry) return

			const length = buffer.readUInt16LE(position)

			if (length < STELLARIUM_MESSAGE_HEADER_SIZE || length > STELLARIUM_MAX_MESSAGE_SIZE) {
				this.#drop(clients, entry)
				return
			}

			if (buffer.byteLength - position < length) break

			if (length >= STELLARIUM_GOTO_MESSAGE_SIZE && buffer.readUInt16LE(position + 2) === 0 && this.options.handler.goto) {
				const message = buffer.subarray(position, position + length)
				const ra = normalizeAngle((message.readUInt32LE(12) * PI) / 0x80000000)
				const dec = (message.readInt32LE(16) * PI) / 0x80000000
				this.options.handler.goto(this, ra, dec, entry.client)
			}

			position += length
		}

		if (position < buffer.byteLength) state.buffer = buffer.subarray(position)
	}
}
