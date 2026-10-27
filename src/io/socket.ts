import type { Socket } from 'bun'

// Output queue for one Bun TCP socket. Bun's `write` returns how many bytes the socket took and drops the
// rest instead of buffering it, so a peer that reads slower than it is written to would otherwise receive a
// stream truncated in the middle of a message. The queue writes straight through while it is empty and
// otherwise keeps the bytes the socket did not take, in order, until the socket's `drain` event flushes
// them. Queued bytes are copied into blocks of at least `SOCKET_WRITE_QUEUE_BLOCK_SIZE` bytes, so a caller may
// reuse its buffer as soon as `write` returns and many small messages do not cost one allocation each;
// nothing is allocated while the socket keeps up.

// The part of a Bun socket a queue writes to.
export type SocketWriter = Pick<Socket<unknown>, 'write'>

// Default most bytes queued for a socket that does not read: 16 MiB.
export const DEFAULT_MAX_PENDING_WRITE = 16 * 1024 * 1024

// Smallest block allocated to hold queued bytes: 16 KiB.
const SOCKET_WRITE_QUEUE_BLOCK_SIZE = 16 * 1024

// Ordered output queue of one socket. Create one per connection and clear it when the connection ends.
export class SocketWriteQueue {
	// Views of the bytes the socket has not taken yet, oldest first. The last one lies at the start of
	// `#block` when that is defined, and grows into its free capacity.
	readonly #chunks: Buffer[] = []
	#block?: Buffer
	#pending = 0

	// `maxPendingWrite` is the most queued bytes, beyond which `write` reports the socket as stalled.
	constructor(readonly maxPendingWrite: number = DEFAULT_MAX_PENDING_WRITE) {}

	// Bytes queued and not yet taken by the socket.
	get pending() {
		return this.#pending
	}

	// Writes `data` (a string as UTF-8, or the bytes of a buffer source), or its `byteOffset`/`byteLength` byte
	// range, after the queued bytes. Writes directly while the queue is empty and queues a copy of whatever the
	// socket did not take. Returns false when the queue now holds more than `maxPendingWrite` bytes: the data is
	// still queued, and the caller is expected to close the socket of a peer that stopped reading.
	write(socket: SocketWriter, data: string | Bun.BufferSource, byteOffset: number = 0, byteLength?: number) {
		const size = byteLength ?? (typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength) - byteOffset
		let written = 0

		if (this.#chunks.length === 0) {
			written = Math.max(0, socket.write(data, byteOffset, size))
			if (written >= size) return true
		}

		this.#append(sourceBytes(data, byteOffset + written, size - written))

		return this.#pending <= this.maxPendingWrite
	}

	// Writes the queued bytes the socket takes, keeping the rest for the next `drain` event.
	drain(socket: SocketWriter) {
		const chunks = this.#chunks

		while (chunks.length > 0) {
			const head = chunks[0]
			const written = Math.max(0, socket.write(head))
			this.#pending -= written

			if (written < head.byteLength) {
				chunks[0] = head.subarray(written)
				return
			}

			chunks.shift()
		}

		this.#block = undefined
	}

	// Discards the queued bytes, for a connection that ended.
	clear() {
		this.#chunks.length = 0
		this.#block = undefined
		this.#pending = 0
	}

	// Copies `bytes` after the queued ones, into the free capacity of the current block when it fits.
	#append(bytes: Uint8Array) {
		const chunks = this.#chunks
		const block = this.#block
		const n = bytes.byteLength
		const last = chunks.at(-1)

		if (block !== undefined && last !== undefined) {
			const start = last.byteOffset - block.byteOffset
			const end = start + last.byteLength

			if (end + n <= block.byteLength) {
				block.set(bytes, end)
				chunks[chunks.length - 1] = block.subarray(start, end + n)
				this.#pending += n
				return
			}
		}

		const next = Buffer.allocUnsafe(Math.max(n, SOCKET_WRITE_QUEUE_BLOCK_SIZE))
		next.set(bytes)
		chunks.push(next.subarray(0, n))
		this.#block = next
		this.#pending += n
	}
}

// View of the `length` bytes at `offset` of a string's UTF-8 encoding or of a buffer source.
function sourceBytes(data: string | Bun.BufferSource, offset: number, length: number) {
	if (typeof data === 'string') return Buffer.from(data).subarray(offset, offset + length)
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset + offset, length)
	return new Uint8Array(data, offset, length)
}
