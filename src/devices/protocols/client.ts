import type { Socket } from 'bun'

// Clients of the telescope-protocol TCP servers (LX200, Stellarium). Each accepted socket gets an opaque id that
// is never reused, so an endpoint reconnecting from the same address and port is still a different client, and
// keeps the per-socket state its server parses with. The peer address is the one Bun reports for the socket.

// Connected TCP client of a protocol server, as published to its users.
export interface ProtocolClient {
	// Opaque id of this connection, unique for the life of the process.
	readonly id: string
	// Remote IP address, IPv4 dotted or IPv6 without brackets.
	readonly ip: string
	// Remote TCP port, 1..65535.
	readonly port: number
}

// One accepted socket with its public identity and the state its server keeps for it.
export interface ProtocolClientEntry<S> {
	// Public identity of the client.
	readonly client: ProtocolClient
	// Socket the client is connected through.
	readonly socket: Socket<unknown>
	// Parsing state of the server for this client, mutated in place.
	readonly state: S
}

// Milliseconds a connection may stay idle before the operating system starts probing it, so a peer that vanished
// without closing is eventually reported as closed. Probing and its timeout are left to the OS.
export const PROTOCOL_KEEPALIVE_DELAY = 30000

// Clients of one run of a protocol server. A server creates a fresh set on every start, so callbacks of sockets
// from a previous run, arriving after a stop, only ever reach the set of that run.
export class ProtocolClients<S> {
	readonly #entries = new Map<Socket<unknown>, ProtocolClientEntry<S>>()

	// Number of connected clients.
	get size() {
		return this.#entries.size
	}

	// Registers an accepted socket with its initial state, enables TCP keepalive on it, and returns the entry.
	add(socket: Socket<unknown>, state: S): ProtocolClientEntry<S> {
		socket.setKeepAlive(true, PROTOCOL_KEEPALIVE_DELAY)
		const client: ProtocolClient = Object.freeze({ id: crypto.randomUUID(), ip: socket.remoteAddress, port: socket.remotePort })
		const entry: ProtocolClientEntry<S> = { client, socket, state }
		this.#entries.set(socket, entry)
		return entry
	}

	// Returns the entry of a socket, or undefined once it was removed.
	get(socket: Socket<unknown>) {
		return this.#entries.get(socket)
	}

	// Returns the entry of a client id, or undefined when no such client is connected.
	find(id: string) {
		for (const entry of this.#entries.values()) if (entry.client.id === id) return entry
		return undefined
	}

	// Removes a socket and returns its entry; undefined when it was already removed, so a client is reported closed once.
	delete(socket: Socket<unknown>) {
		const entry = this.#entries.get(socket)
		if (entry) this.#entries.delete(socket)
		return entry
	}

	// Returns the connected clients in connection order, as a new array.
	list(): readonly ProtocolClient[] {
		return Array.from(this.#entries.values(), (entry) => entry.client)
	}

	// Iterates the entries in connection order.
	values() {
		return this.#entries.values()
	}
}
