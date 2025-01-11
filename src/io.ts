import type { FileHandle } from 'fs/promises'

export async function* arrayBufferToLines(buffer: AllowSharedBufferSource, charset: string = 'utf-8') {
	const decoder = new TextDecoder(charset)
	const stream = new ReadableStream<AllowSharedBufferSource>({
		start(controller) {
			controller.enqueue(buffer)
			controller.close()
		},
	})

	const reader = stream.getReader()
	let { value, done } = await reader.read()

	let line = ''

	while (!done) {
		// Decode incrementally
		line = decoder.decode(value, { stream: true })

		// Split by newline
		const parts = line.split('\n')

		// Store all complete lines
		for (let i = 0; i < parts.length - 1; i++) {
			if (parts[i]) {
				yield parts[i]
			}
		}

		// Keep the remainder (last part) for the next chunk
		line = parts[parts.length - 1]

		// Read the next chunk
		;({ value, done } = await reader.read())
	}

	if (line) {
		yield line
	}
}

export async function* readableStreamToLines(stream: ReadableStream<Uint8Array>, charset: string = 'utf-8') {
	const decoder = new TextDecoder(charset)

	let line = ''

	for await (const chunk of stream) {
		// Decode incrementally
		line = decoder.decode(chunk, { stream: true })

		// Split by newline
		const parts = line.split('\n')

		// Store all complete lines
		for (let i = 0; i < parts.length - 1; i++) {
			if (parts[i]) {
				yield parts[i]
			}
		}

		// Keep the remainder (last part) for the next chunk
		line = parts[parts.length - 1]
	}

	if (line) {
		yield line
	}
}

export interface Seekable {
	readonly position: number
	readonly exhausted: boolean

	seek(position: number): boolean
}

export function isSeekable(o: object): o is Seekable {
	return 'position' in o
}

export interface Sink {
	write(chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding): Promise<number> | number
}

export class BufferSink implements Sink, Seekable {
	position = 0

	constructor(private readonly buffer: Buffer) {}

	get exhausted() {
		return this.position >= this.buffer.length
	}

	seek(position: number): boolean {
		const length = this.buffer.byteLength
		if (position >= length || position <= -length) return false
		if (position >= 0) this.position = position
		else this.position = length + position
		return true
	}

	write(chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding) {
		offset ??= 0

		if (typeof chunk === 'string')
			if (size === 0) return 0
			else if (size === undefined && !offset) size = this.buffer.write(chunk, this.position, encoding)
			else if (size === undefined) size = this.buffer.write(chunk.substring(offset), this.position, encoding)
			else if (!offset) size = this.buffer.write(chunk.substring(0, size), this.position, encoding)
			else size = this.buffer.write(chunk.substring(offset, offset + size), this.position, encoding)
		else size = chunk.copy(this.buffer, this.position, offset, offset + (size ?? chunk.byteLength))
		this.position += size
		return size
	}
}

export function bufferSink(buffer: Buffer): Sink & Seekable {
	return new BufferSink(buffer)
}

export class FileHandleSink implements Sink, Seekable {
	position = 0
	readonly exhausted = false

	constructor(private readonly handle: FileHandle) {}

	seek(position: number) {
		if (position < 0) return false
		this.position = position
		return true
	}

	async write(chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding) {
		if (typeof chunk === 'string')
			if (size === 0) return 0
			else if (size === undefined && !offset) size = (await this.handle.write(chunk, this.position, encoding)).bytesWritten
			else if (size === undefined) size = (await this.handle.write(chunk.substring(offset!), this.position, encoding)).bytesWritten
			else if (!offset) size = (await this.handle.write(chunk.substring(0, size), this.position, encoding)).bytesWritten
			else size = (await this.handle.write(chunk.substring(offset, offset + size), this.position, encoding)).bytesWritten
		else size = (await this.handle.write(chunk, offset, size, this.position)).bytesWritten
		this.position += size
		return size
	}
}

export function fileHandleSink(handle: FileHandle): Sink & Seekable {
	return new FileHandleSink(handle)
}

export interface Source {
	read(buffer: Buffer, offset?: number, size?: number): Promise<number> | number
}

export class BufferSource implements Source, Seekable {
	position = 0

	constructor(private readonly buffer: Buffer) {}

	get exhausted() {
		return this.position >= this.buffer.length
	}

	seek(position: number): boolean {
		const length = this.buffer.byteLength
		if (position >= length || position <= -length) return false
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

export function bufferSource(buffer: Buffer): Source & Seekable {
	return new BufferSource(buffer)
}

export class FileHandleSource implements Source, Seekable {
	position = 0
	exhausted = false

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
}

export function fileHandleSource(handle: FileHandle): Source & Seekable {
	return new FileHandleSource(handle)
}
