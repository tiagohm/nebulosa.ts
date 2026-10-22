import { expect, test } from 'bun:test'
import { type SocketWriter, SocketWriteQueue } from '../../src/io/socket'
import { listenPaused } from '../util/socket'

// Socket that takes at most `capacity` bytes per write, recording them, like a Bun socket under backpressure.
function fakeSocket(capacity: number) {
	const received: number[] = []

	const socket = {
		capacity,
		received,
		write(data: string | Bun.BufferSource, byteOffset: number = 0, byteLength?: number) {
			const bytes = typeof data === 'string' ? Buffer.from(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
			const range = bytes.subarray(byteOffset, byteLength === undefined ? undefined : byteOffset + byteLength)
			const n = Math.min(range.byteLength, socket.capacity)
			for (let i = 0; i < n; i++) received.push(range[i])
			socket.capacity -= n
			return n
		},
	} satisfies SocketWriter & { capacity: number; received: number[] }

	return socket
}

test('writes straight through while the socket takes everything', () => {
	const socket = fakeSocket(100)
	const queue = new SocketWriteQueue()

	expect(queue.write(socket, 'abc')).toBeTrue()
	expect(queue.write(socket, new Uint8Array([100, 101]))).toBeTrue()
	expect(queue.pending).toBe(0)
	expect(Buffer.from(socket.received).toString()).toBe('abcde')
})

test('queues the bytes a partial write left and keeps later writes in order', () => {
	const socket = fakeSocket(2)
	const queue = new SocketWriteQueue()

	queue.write(socket, 'héllo')
	queue.write(socket, Buffer.from(' world'))
	expect(queue.pending).toBe(10)
	expect(socket.received).toHaveLength(2)

	socket.capacity = 4
	queue.drain(socket)
	expect(queue.pending).toBe(6)

	socket.capacity = 100
	queue.drain(socket)
	expect(queue.pending).toBe(0)
	expect(Buffer.from(socket.received).toString()).toBe('héllo world')

	// Drained: writes go straight through again.
	queue.write(socket, '!')
	expect(Buffer.from(socket.received).toString()).toBe('héllo world!')
})

test('honors the byte range of a buffer source and copies what it queues', () => {
	const socket = fakeSocket(1)
	const queue = new SocketWriteQueue()
	const data = new Uint8Array([1, 2, 3, 4, 5, 6])

	queue.write(socket, data.subarray(1), 1, 3)
	queue.write(socket, data.buffer, 4, 2)
	// The caller reuses its buffer; the queued bytes must not change.
	data.fill(0)

	socket.capacity = 100
	queue.drain(socket)

	expect(socket.received).toEqual([3, 4, 5, 5, 6])
})

test('coalesces many small queued writes', () => {
	const socket = fakeSocket(0)
	const queue = new SocketWriteQueue()

	for (let i = 0; i < 50000; i++) queue.write(socket, new Uint8Array([i & 0xff]))
	expect(queue.pending).toBe(50000)

	// Each write takes one block view, so the whole queue drains in a handful of writes.
	let writes = 0
	socket.capacity = 100000
	queue.drain({
		write: (data, byteOffset, byteLength) => {
			writes++
			return socket.write(data, byteOffset, byteLength)
		},
	})

	expect(writes).toBeLessThanOrEqual(4)
	expect(socket.received).toHaveLength(50000)
	expect(socket.received.every((value, i) => value === (i & 0xff))).toBeTrue()
})

test('reports a queue beyond its bound and clears it', () => {
	const socket = fakeSocket(0)
	const queue = new SocketWriteQueue(4)

	expect(queue.write(socket, 'abcd')).toBeTrue()
	expect(queue.write(socket, 'e')).toBeFalse()
	expect(queue.pending).toBe(5)

	queue.clear()
	socket.capacity = 100
	queue.drain(socket)
	expect(queue.pending).toBe(0)
	expect(socket.received).toHaveLength(0)
})

test('keeps whole messages over a real socket whose peer stops reading', async () => {
	using peer = listenPaused()
	const queue = new SocketWriteQueue()
	const client = await Bun.connect({ hostname: '127.0.0.1', port: peer.port, socket: { data: () => {}, drain: (socket) => queue.drain(socket) } })

	try {
		// 8 MiB in 1000-byte messages overflows the loopback buffers, so some writes are partial.
		const message = Buffer.alloc(1000)
		const count = 8192

		for (let i = 0; i < count; i++) {
			message.writeUInt32LE(i, 0)
			expect(queue.write(client, message)).toBeTrue()
		}

		expect(queue.pending).toBeGreaterThan(0)

		const stream = await peer.resume(count * 1000)

		expect(stream.byteLength).toBe(count * 1000)
		for (let i = 0; i < count; i++) expect(stream.readUInt32LE(i * 1000)).toBe(i)
		expect(queue.pending).toBe(0)
	} finally {
		client.close()
	}
})
