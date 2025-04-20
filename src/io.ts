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
export function bufferSink(buffer: Buffer) {
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
export function fileHandleSink(handle: FileHandle) {
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
export function bufferSource(buffer: Buffer) {
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
export function fileHandleSource(handle: FileHandle) {
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

export function readableStreamSource(stream: ReadableStream<Uint8Array>) {
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

export function rangeHttpSource(uri: string | URL) {
	return new RangeHttpSource(uri)
}

export type Base64Alphabet = 'base64' | 'base64url'

export class Base64Source implements Source {
	private readonly buffer = Buffer.allocUnsafe(1024)
	private readonly decoded = [-1, -1, -1]
	private position = 0
	private n = 0
	private state = -1

	constructor(private readonly source: Source) {}

	async read(buffer: Buffer, offset?: number, size?: number) {
		size ??= buffer.byteLength

		if (size > 0 && this.position >= this.n) {
			this.n = await this.source.read(this.buffer)
			if (!this.n) return 0
			this.position = 0
		}

		offset ??= 0

		for (let i = 0; i < size; i++, offset++) {
			const d = this.decode(this.n)
			if (d === -1) return i
			buffer[offset] = d
		}

		return size
	}

	private decode(limit: number) {
		if (this.state >= 0 && this.state <= 2) {
			return this.decoded[this.state++]
		} else if (this.position >= limit) {
			return -1
		}

		this.decoded.fill(-1)
		this.state = 0

		let inCount = 0
		let word = 0

		while (this.position < limit) {
			const c = this.buffer.readUInt8(this.position++)

			let bits = 0

			// A-Z
			if (c >= 65 && c <= 90) {
				bits = c - 65
			}
			// a-z
			else if (c >= 97 && c <= 122) {
				bits = c - 71
			}
			// 0-9
			else if (c >= 48 && c <= 57) {
				bits = c + 4
			}
			// plus minus
			else if (c === 43 || c === 45) {
				bits = 62
			}
			// slash underscore
			else if (c === 47 || c === 95) {
				bits = 63
			}
			// equal \n \r space tab
			else if (c === 61 || c === 13 || c === 10 || c === 32 || c === 9) {
				continue
			} else {
				throw new Error(`unrecognized input: ${c}`)
			}

			// Append this char's 6 bits to the word.
			word = (word << 6) | bits

			// For every 4 chars of input, we accumulate 24 bits of output. Emit 3 bytes.
			inCount++

			if (inCount % 4 === 0) {
				this.decoded[0] = (word >> 16) & 0xff
				this.decoded[1] = (word >> 8) & 0xff
				this.decoded[2] = word & 0xff
				break
			}
		}

		switch (inCount % 4) {
			case 1:
				// We read 1 char followed by "===". But 6 bits is a truncated byte! Fail.
				throw new Error('truncated byte')
			case 2:
				// We read 2 chars followed by "==". Emit 1 byte with 8 of those 12 bits.
				word = word << 12
				this.decoded[0] = (word >> 16) & 0xff
				break
			case 3:
				// We read 3 chars, followed by "=". Emit 2 bytes for 16 of those 18 bits.
				word = word << 6
				this.decoded[0] = (word >> 16) & 0xff
				this.decoded[1] = (word >> 8) & 0xff
				break
		}

		return this.decoded[this.state++]
	}
}

export function base64Source(source: Source) {
	return new Base64Source(source)
}

const BASE64_ALPHABET = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 'ascii')
const BASE64_URL_SAFE_ALPHABET = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', 'ascii')

const TRAILING = 61 // =

export class Base64Sink implements Sink {
	private readonly map: Buffer
	private readonly buffer = Buffer.allocUnsafe(3)
	private readonly encoded = Buffer.allocUnsafe(128)
	private state = 0
	private position = 0

	private static readonly ENCODED_BUFFER_SIZE = 128

	constructor(
		private readonly sink: Sink,
		alphabet: Base64Alphabet = 'base64',
	) {
		this.map = alphabet === 'base64' ? BASE64_ALPHABET : BASE64_URL_SAFE_ALPHABET
	}

	async write(chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding) {
		if (size === 0) return 0

		let data: Buffer
		let n = 0

		if (typeof chunk === 'string')
			if (size === undefined && !offset) data = Buffer.from(chunk, encoding)
			else if (size === undefined) data = Buffer.from(chunk.substring(offset!), encoding)
			else if (!offset) data = Buffer.from(chunk.substring(0, size), encoding)
			else data = Buffer.from(chunk.substring(offset, offset + size), encoding)
		else data = chunk

		for (let i = 0; i < data.byteLength; i++) {
			this.encode(data.readUInt8(i))

			if (this.position >= Base64Sink.ENCODED_BUFFER_SIZE - 1) {
				n += this.position
				await this.sink.write(this.encoded, 0, this.position)
				this.position = 0
			}
		}

		if (this.position > 0) {
			n += this.position
			await this.sink.write(this.encoded, 0, this.position)
			this.position = 0
		}

		return n
	}

	private encode(b: number) {
		let value = 0

		if (this.state >= 3) {
			value = this.map.readUInt8(this.buffer.readUInt8(2) & 0x3f)
			this.encoded.writeUInt8(value, this.position++)
			this.state = 0
		}

		this.buffer.writeUInt8(b, this.state)

		switch (this.state) {
			case 0:
				value = this.map.readUInt8(b >> 2)
				break
			case 1:
				value = this.map.readUInt8(((this.buffer.readUInt8(0) & 0x03) << 4) | (b >> 4))
				break
			case 2:
				value = this.map.readUInt8(((this.buffer.readUInt8(1) & 0x0f) << 2) | (b >> 6))
				break
		}

		this.encoded.writeUInt8(value, this.position++)
		this.state++
	}

	end() {
		let n = 0

		if (this.state > 0) {
			switch (this.state) {
				case 1:
					this.encoded.writeUInt8(this.map.readUInt8((this.buffer.readUInt8(0) & 0x03) << 4), n++)
					break
				case 2:
					this.encoded.writeUInt8(this.map.readUInt8((this.buffer.readUInt8(1) & 0x0f) << 2), n++)
					break
				case 3:
					this.encoded.writeUInt8(this.map.readUInt8(this.buffer.readUInt8(2) & 0x3f), n++)
					break
			}

			for (let i = 3 - this.state; i > 0; i--) {
				this.encoded.writeUInt8(TRAILING, n++)
			}

			this.sink.write(this.encoded, 0, n)
			this.state = 0
		}

		return n
	}
}

export function base64Sink(sink: Sink, alphabet: Base64Alphabet = 'base64') {
	return new Base64Sink(sink, alphabet)
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
	let read = 0

	while (true) {
		const n = await source.read(buffer)
		const m = n && (await sink.write(buffer, 0, n))
		read += n
		if (!m) break
	}

	return read
}

export class GrowableBuffer {
	private position = 0
	private buffer: Buffer

	constructor(size: number = 1024) {
		this.buffer = Buffer.allocUnsafe(Math.max(1, size))
	}

	get length() {
		return this.position
	}

	writeInt8(value: number) {
		this.ensureCapacity(this.position + 1)
		this.position = this.buffer.writeInt8(value, this.position)
	}

	writeUInt8(value: number) {
		this.ensureCapacity(this.position + 1)
		this.position = this.buffer.writeUInt8(value, this.position)
	}

	writeInt16LE(value: number) {
		this.ensureCapacity(this.position + 2)
		this.position = this.buffer.writeInt16LE(value, this.position)
	}

	writeUInt16LE(value: number) {
		this.ensureCapacity(this.position + 2)
		this.position = this.buffer.writeUInt16LE(value, this.position)
	}

	writeInt16BE(value: number) {
		this.ensureCapacity(this.position + 2)
		this.position = this.buffer.writeInt16BE(value, this.position)
	}

	writeUInt16BE(value: number) {
		this.ensureCapacity(this.position + 2)
		this.position = this.buffer.writeUInt16BE(value, this.position)
	}

	writeInt32LE(value: number) {
		this.ensureCapacity(this.position + 4)
		this.position = this.buffer.writeInt32LE(value, this.position)
	}

	writeUInt32LE(value: number) {
		this.ensureCapacity(this.position + 4)
		this.position = this.buffer.writeUInt32LE(value, this.position)
	}

	writeInt32BE(value: number) {
		this.ensureCapacity(this.position + 4)
		this.position = this.buffer.writeInt32BE(value, this.position)
	}

	writeUInt32BE(value: number) {
		this.ensureCapacity(this.position + 4)
		this.position = this.buffer.writeUInt32BE(value, this.position)
	}

	reset() {
		this.position = 0
	}

	toString(encoding?: BufferEncoding, trim?: boolean) {
		if (this.position <= 0) return ''

		let start = 0
		let end = this.position - 1

		if (trim) {
			while (start <= end && this.buffer.readInt8(start) <= 32) start++
			while (end > start && this.buffer.readInt8(end) <= 32) end--
		}

		return this.buffer.toString(encoding, start, end + 1)
	}

	private ensureCapacity(min: number) {
		if (min - this.buffer.length > 0) {
			this.resize()
		}
	}

	private resize() {
		const buffer = Buffer.allocUnsafe(this.buffer.byteLength * 2)
		this.buffer.copy(buffer, 0, 0, this.position)
		this.buffer = buffer
	}
}
