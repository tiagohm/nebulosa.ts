import { readSync, writeSync, closeSync } from 'fs'
import type { FileHandle } from 'fs/promises'
import type { Sink, Source } from './types'

// FileHandle-backed byte-stream source and sink adapters using Node fs operations.
// Async and sync calls share a positional byte cursor and must run sequentially; disposal closes
// the supplied handle. Each factory allocates an adapter around the caller's FileHandle.

// A seekable sink writing to a FileHandle over a shared logical cursor. Sequential async and sync
// writes may be interleaved. Closes the handle on async or sync disposal.
export class FileHandleSink implements Sink, AsyncDisposable, Disposable {
	position = 0

	constructor(readonly handle: FileHandle) {}

	seek(position: number) {
		if (position < 0) return false
		this.position = position
		return true
	}

	async write(chunk: string | Buffer, offset: number = 0, size?: number, encoding?: BufferEncoding) {
		if (size === 0) return 0

		if (typeof chunk === 'string')
			if (size === undefined && offset === 0) size = (await this.handle.write(chunk, this.position, encoding)).bytesWritten
			else if (size === undefined) size = (await this.handle.write(chunk.slice(offset), this.position, encoding)).bytesWritten
			else if (offset === 0) size = (await this.handle.write(chunk.slice(0, size), this.position, encoding)).bytesWritten
			else size = (await this.handle.write(chunk.slice(offset, offset + size), this.position, encoding)).bytesWritten
		else size = (await this.handle.write(chunk, offset, size, this.position)).bytesWritten
		this.position += size
		return size
	}

	writeSync(chunk: string | Buffer, offset: number = 0, size?: number, encoding?: BufferEncoding) {
		if (size === 0) return 0

		if (typeof chunk === 'string')
			if (size === undefined && offset === 0) size = writeSync(this.handle.fd, chunk, this.position, encoding)
			else if (size === undefined) size = writeSync(this.handle.fd, chunk.slice(offset), this.position, encoding)
			else if (offset === 0) size = writeSync(this.handle.fd, chunk.slice(0, size), this.position, encoding)
			else size = writeSync(this.handle.fd, chunk.slice(offset, offset + size), this.position, encoding)
		else size = writeSync(this.handle.fd, chunk, offset ?? 0, size ?? chunk.byteLength - (offset ?? 0), this.position)
		this.position += size
		return size
	}

	async close() {
		return await this.handle.close()
	}

	closeSync() {
		this.handle.fd >= 0 && closeSync(this.handle.fd)
	}

	async [Symbol.asyncDispose]() {
		return await this.close()
	}

	[Symbol.dispose]() {
		this.closeSync()
	}
}

// Create a seekable sink from FileHandle.
export function fileHandleSink(handle: FileHandle) {
	return new FileHandleSink(handle)
}

// A seekable source reading from a FileHandle over a shared logical cursor; `read`
// and `readSync` may be interleaved sequentially but are not concurrency-safe. Closes the handle
// on async or sync disposal.
export class FileHandleSource implements Source, AsyncDisposable, Disposable {
	position = 0

	constructor(readonly handle: FileHandle) {}

	seek(position: number) {
		if (position < 0) return false
		this.position = position
		return true
	}

	async read(buffer: Buffer, offset: number = 0, size: number = buffer.byteLength - offset) {
		if (size <= 0) return 0
		const ret = await this.handle.read(buffer, offset, size, this.position)
		this.position += ret.bytesRead
		return ret.bytesRead
	}

	readSync(buffer: Buffer, offset: number = 0, size: number = buffer.byteLength - offset) {
		if (size <= 0) return 0
		const n = readSync(this.handle.fd, buffer, offset, size, this.position)
		this.position += n
		return n
	}

	async close() {
		return await this.handle.close()
	}

	closeSync() {
		this.handle.fd >= 0 && closeSync(this.handle.fd)
	}

	async [Symbol.asyncDispose]() {
		return await this.close()
	}

	[Symbol.dispose]() {
		this.closeSync()
	}
}

// Create a seekable source from FileHandle.
export function fileHandleSource(handle: FileHandle) {
	return new FileHandleSource(handle)
}
