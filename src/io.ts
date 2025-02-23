import type { FileHandle } from 'fs/promises'

export interface Flushable {
	readonly flush: () => void
}

export function isFlushable(o: object): o is Flushable {
	return 'flush' in o
}

export interface Exhaustible {
	readonly exhausted: boolean
}

export function isExhaustible(o: object): o is Exhaustible {
	return 'exhausted' in o
}

export interface Seekable {
	readonly position: number

	readonly seek: (position: number) => boolean
}

export function isSeekable(o: object): o is Seekable {
	return 'seek' in o
}

export interface Sink {
	readonly write: (chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding) => Promise<number> | number
}

export class BufferSink implements Sink, Seekable, Exhaustible {
	position = 0

	constructor(private readonly buffer: Buffer) {}

	get exhausted() {
		return this.position >= this.buffer.byteLength
	}

	seek(position: number): boolean {
		const length = this.buffer.byteLength
		position = Math.max(-length, Math.min(position, length))
		if (position >= 0) this.position = position
		else this.position = length + position
		return true
	}

	write(chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding) {
		if (size === 0) return 0

		offset ??= 0

		if (typeof chunk === 'string')
			if (size === undefined && !offset) size = this.buffer.write(chunk, this.position, encoding)
			else if (size === undefined) size = this.buffer.write(chunk.substring(offset), this.position, encoding)
			else if (!offset) size = this.buffer.write(chunk.substring(0, size), this.position, encoding)
			else size = this.buffer.write(chunk.substring(offset, offset + size), this.position, encoding)
		else size = chunk.copy(this.buffer, this.position, offset, offset + (size ?? chunk.byteLength))
		this.position += size
		return size
	}
}

// Create a seekable sink from Buffer.
export function bufferSink(buffer: Buffer): Sink & Seekable & Exhaustible {
	return new BufferSink(buffer)
}

export class FileHandleSink implements Sink, Seekable, AsyncDisposable {
	position = 0

	constructor(private readonly handle: FileHandle) {}

	seek(position: number) {
		if (position < 0) return false
		this.position = position
		return true
	}

	async write(chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding) {
		if (size === 0) return 0

		if (typeof chunk === 'string')
			if (size === undefined && !offset) size = (await this.handle.write(chunk, this.position, encoding)).bytesWritten
			else if (size === undefined) size = (await this.handle.write(chunk.substring(offset!), this.position, encoding)).bytesWritten
			else if (!offset) size = (await this.handle.write(chunk.substring(0, size), this.position, encoding)).bytesWritten
			else size = (await this.handle.write(chunk.substring(offset, offset + size), this.position, encoding)).bytesWritten
		else size = (await this.handle.write(chunk, offset, size, this.position)).bytesWritten
		this.position += size
		return size
	}

	[Symbol.asyncDispose]() {
		return this.handle.close()
	}
}

// Create a seekable sink from FileHandle.
export function fileHandleSink(handle: FileHandle): Sink & Seekable & AsyncDisposable {
	return new FileHandleSink(handle)
}

export interface Source {
	readonly read: (buffer: Buffer, offset?: number, size?: number) => Promise<number> | number
}

export class BufferSource implements Source, Seekable {
	position = 0

	constructor(private readonly buffer: Buffer) {}

	get exhausted() {
		return this.position >= this.buffer.byteLength
	}

	seek(position: number): boolean {
		const length = this.buffer.byteLength
		position = Math.max(-length, Math.min(position, length))
		if (position >= 0) this.position = position
		else this.position = length + position
		return true
	}

	read(buffer: Buffer, offset?: number, size?: number) {
		size = Math.min(size ?? buffer.byteLength - (offset ?? 0), this.buffer.byteLength - this.position)
		if (!size) return 0
		size = this.buffer.copy(buffer, offset, this.position, this.position + size)
		this.position += size
		return size
	}
}

// Create a seekable source from Buffer.
export function bufferSource(buffer: Buffer): Source & Seekable & Exhaustible {
	return new BufferSource(buffer)
}

export class FileHandleSource implements Source, Seekable, AsyncDisposable {
	position = 0

	constructor(private readonly handle: FileHandle) {}

	seek(position: number) {
		if (position < 0) return false
		this.position = position
		return true
	}

	async read(buffer: Buffer, offset?: number, size?: number) {
		const ret = await this.handle.read(buffer, offset ?? 0, size, this.position)
		this.position += ret.bytesRead
		return ret.bytesRead
	}

	[Symbol.asyncDispose]() {
		return this.handle.close()
	}
}

// Create a seekable source from FileHandle.
export function fileHandleSource(handle: FileHandle): Source & Seekable & AsyncDisposable {
	return new FileHandleSource(handle)
}

export class ReadableStreamSource implements Source, AsyncDisposable {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>
	private buffer?: Buffer
	private position = 0

	constructor(private readonly stream: ReadableStream<Uint8Array>) {
		this.reader = stream.getReader()
	}

	async read(buffer: Buffer, offset?: number, size?: number) {
		if (size === 0) return 0

		offset ??= 0

		if (!this.buffer || this.position >= this.buffer.byteLength) {
			const { done, value } = await this.reader.read()

			if (done || value.byteLength === 0) return 0

			this.buffer = Buffer.from(value)
			this.position = 0
		}

		size = Math.min(size ?? buffer.byteLength - offset, this.buffer.byteLength - this.position)

		size = this.buffer.copy(buffer, offset, this.position, this.position + size)
		this.position += size
		return size
	}

	[Symbol.asyncDispose]() {
		this.reader.releaseLock()
		return this.stream.cancel()
	}
}

export function readableStreamSource(stream: ReadableStream<Uint8Array>): Source & AsyncDisposable {
	return new ReadableStreamSource(stream)
}

export class RangeHttpSource implements Source, Seekable {
	position = 0

	constructor(private readonly uri: string | URL) {}

	seek(position: number) {
		if (position < 0) return false
		this.position = position
		return true
	}

	async read(buffer: Buffer, offset?: number, size?: number) {
		size ??= buffer.byteLength - (offset ?? 0)

		if (size === 0) return 0

		const response = await fetch(this.uri, { headers: { 'Accept-Encoding': 'identity', Range: `bytes=${this.position}-${this.position + size - 1}` } })

		if (size > 0x10000) {
			await using source = readableStreamSource(response.body!)
			return await source.read(buffer, offset, size)
		} else {
			const data = Buffer.from(await response.arrayBuffer())
			return data.copy(buffer, offset)
		}
	}
}

export function rangeHttpSource(uri: string | URL): Source & Seekable {
	return new RangeHttpSource(uri)
}

// Reads the source until it reaches size or be exhausted.
export async function readUntil(source: Source, buffer: Buffer, size: number = buffer.byteLength, offset: number = 0) {
	let remaining = size

	while (remaining > 0) {
		const n = await source.read(buffer, offset, remaining)

		if (!n) break

		remaining -= n
		offset += n
	}

	return size - remaining
}

export interface ReadLinesOptions {
	encoding?: 'ascii' | 'utf8' | 'utf-8'
	emptyLines?: boolean
}

export async function* readLines(source: Source, chunkSize: number, options?: ReadLinesOptions) {
	const buffer = Buffer.allocUnsafe(chunkSize)
	const emptyLines = options?.emptyLines ?? true
	const encoding = options?.encoding

	let line = Buffer.allocUnsafe(0)

	while (true) {
		const n = await readUntil(source, buffer)

		if (!n) break

		let start = 0

		while (start < n) {
			const slice = buffer.subarray(start, n)
			const index = slice.indexOf(10)

			if (index >= 0) {
				start += index + 1
				const found = slice.subarray(0, index)
				line = !line.byteLength ? found : Buffer.concat([line, found])
				if (line.byteLength || emptyLines) yield line.toString(encoding)
				line = Buffer.allocUnsafe(0)
			} else {
				line = Buffer.concat([line, slice])
				break
			}
		}
	}

	if (line.byteLength || emptyLines) yield line.toString(encoding)
}

export async function sourceTransferToSink(source: Source, sink: Sink, size: number | Buffer = 1024) {
	const buffer = Buffer.isBuffer(size) ? size : Buffer.allocUnsafe(size)

	while (true) {
		const n = await source.read(buffer)
		const m = n && (await sink.write(buffer, 0, n))
		if (!m) break
	}
}
