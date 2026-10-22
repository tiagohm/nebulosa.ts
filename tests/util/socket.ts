import type { Socket, TCPSocketListener } from 'bun'
import { waitUntil } from '../util'

// TCP peer that does not read until resumed, so whoever writes to it hits Bun's socket backpressure. Every byte
// it receives after resuming is accumulated in order.
export interface PausedPeer extends Disposable {
	// Local port of a listening peer, or the remote port of a connected one.
	readonly port: number
	// Bytes received so far.
	readonly received: () => Buffer
	// Starts reading and waits until at least `byteLength` bytes arrived.
	readonly resume: (byteLength: number, timeout?: number) => Promise<Buffer>
}

// Listens on a free loopback port and pauses the first socket that connects.
export function listenPaused(): PausedPeer {
	const chunks: Buffer[] = []
	const peer = Promise.withResolvers<Socket<unknown>>()
	const server: TCPSocketListener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open: (socket) => {
				socket.pause()
				peer.resolve(socket)
			},
			data: (_, data) => {
				chunks.push(Buffer.from(data))
			},
		},
	})

	return makePeer(server.port, chunks, peer.promise, () => server.stop(true))
}

// Paused peer that connected out and can still write to the other end.
export interface PausedClient extends PausedPeer {
	// Writes to the other end, returning the bytes the socket took.
	readonly write: (data: Buffer) => number
}

// Connects to `port` on loopback, paused from the start.
export async function connectPaused(port: number): Promise<PausedClient> {
	const chunks: Buffer[] = []
	const socket = await Bun.connect({
		hostname: '127.0.0.1',
		port,
		socket: {
			open: (socket) => socket.pause(),
			data: (_, data) => {
				chunks.push(Buffer.from(data))
			},
		},
	})

	return { ...makePeer(port, chunks, Promise.resolve(socket), () => socket.end()), write: (data) => socket.write(data) }
}

function makePeer(port: number, chunks: Buffer[], socket: Promise<Socket<unknown>>, stop: () => void): PausedPeer {
	const received = () => Buffer.concat(chunks)
	const length = () => chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)

	return {
		port,
		received,
		resume: async (byteLength: number, timeout: number = 10000) => {
			;(await socket).resume()
			await waitUntil(() => length() >= byteLength, timeout, 5)
			return received()
		},
		[Symbol.dispose]: stop,
	}
}
