import { SocketWriteQueue } from '../../io/socket'
import { FirmataClient } from './client'
import type { Board } from './types'

// Bun TCP transport for Firmata with reconnection and stale-socket isolation. Output the socket does not take
// at once is queued until it drains, so a board that reads slowly receives whole messages; a board that stops
// reading for more than the queue bound is disconnected.

// FirmataClient bound to a Bun TCP socket. Connects, pumps received bytes into the parser, and triggers
// the firmware request once connected.
export class FirmataClientOverTcp extends FirmataClient {
	#socket?: Bun.Socket
	#connectionId = 0
	// Output of the current connection not yet taken by its socket.
	readonly #output = new SocketWriteQueue()

	constructor(board: Board) {
		super(
			{
				write: (data, byteOffset, byteLength) => {
					const socket = this.#socket
					if (socket !== undefined && !this.#output.write(socket, data, byteOffset, byteLength)) {
						console.warn('firmata socket output queue full')
						this.#closeConnection(this.#connectionId)
						socket.close()
					}
				},
				flush: () => {
					this.#socket?.flush()
				},
				close: () => {
					this.close()
				},
			},
			board,
		)
	}

	// Opens the TCP connection and starts the handshake by requesting firmware. Returns false if already
	// connected.
	async connect(hostname: string, port: number, options?: Omit<Bun.TCPSocketConnectOptions, 'hostname' | 'port' | 'socket'>) {
		if (this.#socket) return false

		const connectionId = ++this.#connectionId
		const socket = await Bun.connect({
			...options,
			hostname,
			port,
			socket: {
				data: (_, buffer) => {
					if (connectionId === this.#connectionId) this.process(buffer)
				},
				drain: (socket) => {
					if (connectionId === this.#connectionId) this.#output.drain(socket)
				},
				error: (_, error) => {
					console.error('firmata socket error:', error)
					this.#closeConnection(connectionId)
				},
				connectError: (_, error) => {
					console.error('firmata connection failed:', error)
					if (connectionId === this.#connectionId) {
						this.#connectionId++
						this.#socket = undefined
						this.reset()
					}
				},
				end: () => {
					console.info('firmata socket ended')
					this.#closeConnection(connectionId)
				},
				open(socket) {
					console.info('firmata socket open at %s:%s', socket.remoteAddress, socket.localPort)
				},
				timeout() {
					console.info('firmata socket timed out')
				},
				close: (_, error) => {
					console.info('firmata socket closed:', error)
					this.#closeConnection(connectionId)
				},
			},
		})

		if (connectionId !== this.#connectionId) {
			socket.close()
			return false
		}

		this.#output.clear()
		this.#socket = socket

		this.requestFirmware()

		return true
	}

	// Closes and clears the underlying socket.
	close() {
		const socket = this.#socket
		this.#socket = undefined
		this.#connectionId++
		this.#output.clear()
		socket?.close()
	}

	// Invalidates one TCP connection, clears its socket, emits close, and ignores later callbacks from it.
	#closeConnection(connectionId: number) {
		if (connectionId !== this.#connectionId) return

		this.#connectionId++
		this.#socket = undefined
		this.#output.clear()
		super.close()
	}
}
