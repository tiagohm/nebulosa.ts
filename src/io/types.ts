// Shared byte-stream contracts and capability guards for sources, sinks, and cursor operations.
// Read and write counts and seek positions are in bytes; transports may expose async operations.

// A target that can flush buffered output.
export interface Flushable {
	// Flushes any buffered bytes to the underlying target.
	readonly flush: () => void
}

// Runtime type guard for Flushable.
export function isFlushable(o: object): o is Flushable {
	return 'flush' in o && o.flush instanceof Function
}

// A stream that reports when no more data remains.
export interface Exhaustible {
	// True once the stream has been fully consumed.
	readonly exhausted: boolean
}

// Runtime type guard for Exhaustible.
export function isExhaustible(o: object): o is Exhaustible {
	return 'exhausted' in o && typeof o.exhausted === 'boolean'
}

// A stream whose read/write cursor can be repositioned.
export interface Seekable {
	// Current byte offset of the cursor.
	readonly position: number

	// Moves the cursor to `position` (negative offsets count from the end where supported); returns false if rejected.
	readonly seek: (position: number) => boolean
}

// Runtime type guard for Seekable.
export function isSeekable(o: object): o is Seekable {
	return 'seek' in o && o.seek instanceof Function
}

// A sequential byte target with async-compatible and synchronous write methods.
export interface Sink {
	// Writes `size` bytes of `chunk` starting at `offset`, decoding strings with `encoding`; returns source bytes consumed.
	readonly write: (chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding) => Promise<number> | number
	// Synchronous counterpart of `write`. Shares the same logical cursor. Not safe to call concurrently with `write`.
	readonly writeSync: (chunk: string | Buffer, offset?: number, size?: number, encoding?: BufferEncoding) => number
}

// A sequential byte source. Returns the number of bytes actually read (0 at end of input).
// Sources backed by asynchronous transports expose readSync but throw when it is called.
export interface Source {
	// Reads up to `size` bytes into `buffer` at `offset`; returns the byte count read (0 when exhausted).
	readonly read: (buffer: Buffer, offset?: number, size?: number) => Promise<number> | number
	// Synchronous counterpart of `read` when supported. Shares the logical cursor and cannot run concurrently with `read`.
	readonly readSync: (buffer: Buffer, offset?: number, size?: number) => number
}
