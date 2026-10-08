import { eraS2c } from '../../../astronomy/coordinates/erfa/erfa'
import { MILLIASEC2RAD } from '../../../core/constants'
import type { Writable } from '../../../core/types'
import type { MutVec2 } from '../../../math/linear-algebra/vec2'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogRaDecBox } from '../catalog'
import { stellariumBoxesClassifier, stellariumConeClassifier, stellariumLocalZoneCount, stellariumZoneCover, type StellariumZoneRange } from './geodesic'
import { decodeStellariumStar, readStellariumStarMagnitude, readStellariumStarPosition, type StellariumStarCatalogEntry, type StellariumStarDataType, type StellariumStarRecordSize } from './star.binary'
import { closeStellariumStarFiles, computeStellariumStarChecksum, openStellariumStarFiles, readStellariumStarBytes, type StellariumStarFileSet, type StellariumStarLevelFile } from './star.storage'

// Star catalog provider for the Stellarium Gaia DR3/Hipparcos star files (`stars_<level>_*.cat`, Stellarium
// 25.1+). It reads the original files in place: opening keeps one read-only handle, the header and the
// Uint32Array zone prefix sums per level, and a query selects the candidate geodesic zones of every available
// level (plus each level's global zone), reads only their records in fixed-size blocks with positional reads,
// rejects records by their encoded magnitude and coarse position before decoding, and lets BaseStarCatalog
// apply the exact geometry, the inclusive magnitude bounds and the limit. Positions are astrometric ICRS at the
// catalog epoch of each file (J2016.0 for the Gaia DR3 files), angles are radians, and the emission order is
// level by level and zone by zone, which is not a global brightness order. Reads go through a FIFO pool of at
// most maxConcurrentReads block buffers per open catalog, allocated lazily: an operation holds a buffer only
// while it reads and decodes, never while a stream consumer is paused, so the buffers and the reads in flight
// stay bounded however many queries run, and nested queries cannot deadlock. At most maxActiveStreams queries
// run at once (a running query keeps its place, but no buffer, while its consumer is paused) and at most
// maxPendingReads new operations wait for a buffer; beyond either, an operation is rejected at once, before a
// query builds its zone cover. Resumed queries wait without that limit, so the whole queue stays under
// maxPendingReads + maxActiveStreams and an admitted query is never rejected for saturation. The checksum
// audit streams with its own 1 MiB buffer, one audit at a time. Memory per running query is the zone cover;
// queryRegion materializes every match, so streamRegion suits dense regions.
// This provider is unrelated to the deep-sky StellariumNebulaeCatalog of `nebulae.ts`.

// Default block size of the record reads, bytes.
const DEFAULT_BLOCK_BYTES = 128 * 1024
// Smallest block size, bytes: one record of the largest layout, so every read makes progress.
const MIN_BLOCK_BYTES = 48
// Largest block size, bytes; bounds the per-buffer allocation.
const MAX_BLOCK_BYTES = 64 * 1024 * 1024
// Default maximum of buffers and positional reads in flight per open catalog: 1 MiB of buffers with the
// default block size and a short I/O queue. A conservative bound, not tuned by benchmark.
const DEFAULT_MAX_CONCURRENT_READS = 8
// Default maximum of new operations waiting for a read buffer per open catalog. A waiting operation holds a
// promise and a suspended frame (a query has not built its cover yet), a few hundred bytes, so the queue stays
// well under 1 MiB while absorbing bursts of 128 times the default concurrency. Not tuned by benchmark.
const DEFAULT_MAX_PENDING_READS = 1024
// Default maximum of queries running at once per open catalog. A running query holds its zone cover and, when
// resumed, at most one buffer wait, so this also bounds the resumed queries in the queue. Not tuned by benchmark.
const DEFAULT_MAX_ACTIVE_STREAMS = 256
// Chunk size of the checksum audit, bytes: large sequential reads, independent of blockBytes.
const CHECKSUM_CHUNK_BYTES = 1024 * 1024
// Message of the operations that fail because the catalog was closed under them.
const CLOSED_MESSAGE = 'Stellarium star catalog is closed'
// Message of the new operations refused because maxPendingReads operations already wait for a buffer.
const SATURATED_MESSAGE = 'Stellarium star catalog read queue is full'
// Message of the queries refused because maxActiveStreams queries are already running.
const STREAMS_MESSAGE = 'Stellarium star catalog has too many active streams'
// Coarse-prefilter slack, radians (1 mas). Far above the exact-geometry tolerance, so a record that passes the
// exact test is never dropped by the prefilter, which uses the same decoded coordinates.
const PRESELECTION_TOLERANCE = MILLIASEC2RAD

// Options of a Stellarium star catalog.
export interface StellariumStarCatalogOptions {
	// Size of each read buffer, bytes; an integer in 48..64 MiB, default 128 KiB.
	readonly blockBytes?: number
	// Maximum number of operations (query scan steps, get) reading at once, and so of block buffers and of their
	// positional reads in flight; an integer >= 1, default 8. Further operations wait in request order.
	readonly maxConcurrentReads?: number
	// Maximum number of new queries and get calls waiting for a read buffer; an integer >= 0, default 1024. A new
	// operation beyond it is rejected at once with "Stellarium star catalog read queue is full". A query already
	// admitted is never rejected for saturation: when its consumer resumes it, it waits for a buffer regardless,
	// and these waits are bounded by maxActiveStreams.
	readonly maxPendingReads?: number
	// Maximum number of queries running at once, each from its first entry request until it completes, fails or
	// is returned; an integer >= 1, default 256. A query started beyond it is rejected at once with "Stellarium
	// star catalog has too many active streams"; it never waits, so a query nested in a running stream cannot
	// deadlock. A paused stream holds no buffer but keeps its place: finish it, leave its for await loop (break
	// and throw return the iterator), or call return() on an iterator that is abandoned.
	readonly maxActiveStreams?: number
	// Levels that must be present; open throws naming the absent ones. By default any subset of levels is accepted.
	readonly requiredLevels?: readonly number[]
}

// Description of one opened level, serializable (no bigint).
export interface StellariumStarCatalogLevelInfo {
	// Geodesic level.
	readonly level: number
	// Record layout code: 0 = Star1, 1 = Star2, 2 = Star3.
	readonly dataType: StellariumStarDataType
	// Bytes per record.
	readonly recordSize: StellariumStarRecordSize
	// Major format version.
	readonly majorVersion: number
	// Minor format version.
	readonly minorVersion: number
	// Catalog epoch, Julian Date.
	readonly epochJD: number
	// Catalog epoch, Julian year.
	readonly epoch: number
	// Lower bound of the V magnitudes of the file, mag, from the header.
	readonly magnitudeMin: number
	// Number of star records.
	readonly recordCount: number
	// Number of zones, including the global zone.
	readonly zoneCount: number
	// File name inside the catalog directory.
	readonly fileName: string
	// File size, bytes.
	readonly fileSize: number
	// Descriptive [bright, faint] magnitude range from the manifest, mag, when present.
	readonly magnitudeRange?: readonly [number, number]
	// Expected MD5 checksum from the manifest, when present.
	readonly checksum?: string
}

// Cumulative I/O and scan counters of a catalog instance.
export interface StellariumStarCatalogDiagnostics {
	// Bytes read from the star files by queries, get and checksum verification.
	readonly bytesRead: number
	// Positional read requests issued.
	readonly readCalls: number
	// Geodesic tree nodes classified by the zone covers.
	readonly coverNodesVisited: number
	// Zones whose records were scanned, global zones included.
	readonly zonesScanned: number
	// Records whose magnitude was examined.
	readonly recordsScanned: number
	// Records decoded into entries.
	readonly recordsDecoded: number
	// Largest number of read buffers held at once; never above maxConcurrentReads.
	readonly peakBuffersInUse: number
	// Largest number of positional reads in flight at once; never above maxConcurrentReads + 1 (the checksum audit).
	readonly peakConcurrentReads: number
	// Largest number of operations waiting for a read buffer at once, new and resumed; never above
	// maxPendingReads + maxActiveStreams.
	readonly peakQueuedOperations: number
	// Largest number of queries running at once; never above maxActiveStreams.
	readonly peakActiveStreams: number
	// New operations rejected because the read queue was full or maxActiveStreams queries were running.
	readonly rejectedOperations: number
	// Operations waiting for a read buffer now; 0 when closed. Not affected by resetDiagnostics.
	readonly queuedOperations: number
	// Queries running now; 0 when closed. Not affected by resetDiagnostics.
	readonly activeStreams: number
}

// Cumulative counters and peaks behind StellariumStarCatalogDiagnostics, without the current values.
type CumulativeDiagnostics = Writable<Omit<StellariumStarCatalogDiagnostics, 'queuedOperations' | 'activeStreams'>>

// Result of the checksum verification of one level file.
export interface StellariumStarChecksumResult {
	// Geodesic level.
	readonly level: number
	// File name.
	readonly fileName: string
	// Expected MD5 from the manifest, when present.
	readonly expected?: string
	// Computed lowercase MD5 of the file.
	readonly actual: string
	// Whether the checksums match; undefined when the manifest has no checksum.
	readonly matches?: boolean
}

// State of an opened catalog.
interface OpenState {
	// Opened file set.
	readonly set: StellariumStarFileSet
	// Files indexed by level.
	readonly byLevel: readonly (StellariumStarLevelFile | undefined)[]
	// Public level descriptions.
	readonly levels: readonly StellariumStarCatalogLevelInfo[]
	// Read buffers of this open generation.
	readonly pool: ReadSlotPool
	// Checksum audit in progress, shared by concurrent verifyChecksums calls.
	audit?: Promise<readonly StellariumStarChecksumResult[]>
}

// One read buffer of the pool.
interface ReadSlot {
	// Buffer of blockBytes bytes.
	readonly buffer: Buffer
	// Operation whose block the buffer holds; any other holder must treat the content as stale.
	owner?: object
}

// Operation waiting for a read buffer.
interface ReadSlotWaiter {
	// Hands over a buffer.
	readonly resolve: (slot: ReadSlot) => void
	// Fails the wait when the pool is aborted.
	readonly reject: (error: Error) => void
	// Whether it is a new operation, counted against maxPendingReads.
	readonly admission: boolean
}

// FIFO pool of the read buffers of one open generation. At most `capacity` buffers exist, allocated lazily,
// so the buffers held and the positional reads issued at once never exceed it. Requests are served in arrival
// order; a request prefers the free buffer it released last (keeping its block valid), then a new buffer, then
// any free one. At most `maxStreams` streams are active and at most `maxPending` new operations wait;
// continuations of active streams always wait, one per stream at most, so the waiters never exceed
// maxPending + maxStreams. abort rejects every waiter and later request; buffers released and streams ended
// afterwards just update the counts.
class ReadSlotPool {
	#allocated = 0
	#aborted = false
	// Waiting new operations, never above maxPending.
	#queuedAdmissions = 0
	// Streams started and not yet ended, never above maxStreams.
	#activeStreams = 0
	readonly #free: ReadSlot[] = []
	readonly #waiters: ReadSlotWaiter[] = []

	// Creates an empty pool of at most `capacity` buffers of `blockBytes` bytes, `maxPending` waiting new operations
	// and `maxStreams` active streams; `diagnostics` receives the peaks and rejections.
	constructor(
		readonly capacity: number,
		readonly maxPending: number,
		readonly maxStreams: number,
		readonly blockBytes: number,
		private readonly diagnostics: CumulativeDiagnostics,
	) {}

	// Operations waiting for a buffer now.
	get queued() {
		return this.#waiters.length
	}

	// Streams active now.
	get activeStreams() {
		return this.#activeStreams
	}

	// Registers a starting stream. Returns false, counting a rejection, when maxStreams streams are active; the
	// caller must then fail without acquiring, and otherwise call endStream exactly once when the stream ends.
	startStream() {
		if (this.#activeStreams >= this.maxStreams) {
			this.diagnostics.rejectedOperations++
			return false
		}

		if (++this.#activeStreams > this.diagnostics.peakActiveStreams) this.diagnostics.peakActiveStreams = this.#activeStreams
		return true
	}

	// Unregisters an ended stream.
	endStream() {
		this.#activeStreams--
	}

	// Returns a buffer for `owner` immediately when one is free or allocatable and nobody waits, else a promise
	// of one. A new operation (`admission`) is refused with a rejected promise, without queuing, when maxPending
	// new operations already wait; a continuation (an active stream resuming) always queues. The promise also
	// rejects when the pool is or gets aborted. The caller must release the buffer.
	acquire(owner: object, admission: boolean): ReadSlot | Promise<ReadSlot> {
		if (this.#aborted) return Promise.reject(new Error(CLOSED_MESSAGE))

		if (this.#waiters.length === 0) {
			const slot = this.#take(owner)
			if (slot !== undefined) return slot
		}

		if (admission) {
			if (this.#queuedAdmissions >= this.maxPending) {
				this.diagnostics.rejectedOperations++
				return Promise.reject(new Error(SATURATED_MESSAGE))
			}

			this.#queuedAdmissions++
		}

		const queued = this.#waiters.length + 1
		if (queued > this.diagnostics.peakQueuedOperations) this.diagnostics.peakQueuedOperations = queued

		return new Promise((resolve, reject) => {
			this.#waiters.push({ resolve, reject, admission })
		})
	}

	// Returns a buffer to the pool, handing it to the oldest waiter if any.
	release(slot: ReadSlot) {
		const waiter = this.#waiters.shift()

		if (waiter === undefined) {
			this.#free.push(slot)
		} else {
			if (waiter.admission) this.#queuedAdmissions--
			waiter.resolve(slot)
		}
	}

	// Rejects every waiter and every later request.
	abort() {
		this.#aborted = true
		this.#queuedAdmissions = 0
		for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error(CLOSED_MESSAGE))
	}

	// Takes a buffer without waiting, or undefined when all `capacity` buffers are held.
	#take(owner: object) {
		const free = this.#free
		let slot: ReadSlot | undefined

		for (let i = free.length - 1; i >= 0; i--) {
			if (free[i].owner === owner) {
				slot = free[i]
				free.splice(i, 1)
				break
			}
		}

		if (slot === undefined) {
			if (this.#allocated < this.capacity) {
				this.#allocated++
				slot = { buffer: Buffer.allocUnsafe(this.blockBytes), owner: undefined }
			} else {
				slot = free.pop()
				if (slot === undefined) return undefined
			}
		}

		const inUse = this.#allocated - free.length
		if (inUse > this.diagnostics.peakBuffersInUse) this.diagnostics.peakBuffersInUse = inUse
		return slot
	}
}

// Creates a Stellarium star catalog and opens the catalog directory `root` in one step.
export async function openStellariumStarCatalog(root: string, options?: StellariumStarCatalogOptions) {
	return await new StellariumStarCatalog(options).open(root)
}

// Reads the Stellarium star files of a directory through the generic star catalog contract.
export class StellariumStarCatalog extends BaseStarCatalog<StellariumStarCatalogEntry> implements AsyncDisposable {
	readonly #blockBytes: number
	readonly #maxConcurrentReads: number
	readonly #maxPendingReads: number
	readonly #maxActiveStreams: number
	readonly #requiredLevels: readonly number[]
	#state?: OpenState
	// Open in progress; cleared when it settles or when close invalidates it.
	#opening?: Promise<this>
	// Close in progress, shared by concurrent close calls.
	#closing?: Promise<void>
	// Incremented by close; opens, reads and yields of an older generation fail instead of publishing state or
	// using closed handles.
	#generation = 0
	// Reads in flight, awaited by close before the handles are released.
	readonly #pending = new Set<Promise<void>>()
	readonly #diagnostics: CumulativeDiagnostics = { bytesRead: 0, readCalls: 0, coverNodesVisited: 0, zonesScanned: 0, recordsScanned: 0, recordsDecoded: 0, peakBuffersInUse: 0, peakConcurrentReads: 0, peakQueuedOperations: 0, peakActiveStreams: 0, rejectedOperations: 0 }

	// Creates a closed catalog. Throws when blockBytes is not an integer in 48..64 MiB, since a smaller block
	// could not hold a record and a larger one would be an oversized buffer allocation, when maxConcurrentReads
	// is not an integer >= 1, since a pool without buffers would make every query wait forever, and when
	// maxPendingReads is not an integer >= 0 or maxActiveStreams not an integer >= 1, since NaN would silently
	// disable the bound.
	constructor(options: StellariumStarCatalogOptions = {}) {
		super()

		const blockBytes = options.blockBytes ?? DEFAULT_BLOCK_BYTES
		if (!(Number.isInteger(blockBytes) && blockBytes >= MIN_BLOCK_BYTES && blockBytes <= MAX_BLOCK_BYTES)) throw new Error(`invalid Stellarium star catalog block size: ${blockBytes}`)

		const maxConcurrentReads = options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS
		if (!(Number.isInteger(maxConcurrentReads) && maxConcurrentReads >= 1)) throw new Error(`invalid Stellarium star catalog read concurrency: ${maxConcurrentReads}`)

		const maxPendingReads = options.maxPendingReads ?? DEFAULT_MAX_PENDING_READS
		if (!(Number.isInteger(maxPendingReads) && maxPendingReads >= 0)) throw new Error(`invalid Stellarium star catalog read queue size: ${maxPendingReads}`)

		const maxActiveStreams = options.maxActiveStreams ?? DEFAULT_MAX_ACTIVE_STREAMS
		if (!(Number.isInteger(maxActiveStreams) && maxActiveStreams >= 1)) throw new Error(`invalid Stellarium star catalog active stream limit: ${maxActiveStreams}`)

		this.#blockBytes = blockBytes
		this.#maxConcurrentReads = maxConcurrentReads
		this.#maxPendingReads = maxPendingReads
		this.#maxActiveStreams = maxActiveStreams
		this.#requiredLevels = options.requiredLevels ?? []
	}

	// Whether the catalog is open.
	get isOpen() {
		return this.#state !== undefined
	}

	// Opened catalog directory, or undefined when closed.
	get root() {
		return this.#state?.set.root
	}

	// Opened levels in ascending order; empty when closed.
	get levels(): readonly StellariumStarCatalogLevelInfo[] {
		return this.#state?.levels ?? []
	}

	// Ascending levels listed by the manifest but absent from the directory; empty when closed or without manifest.
	get missingLevels(): readonly number[] {
		return this.#state?.set.missingLevels ?? []
	}

	// Snapshot of the cumulative counters and of the current queue and stream counts.
	get diagnostics(): StellariumStarCatalogDiagnostics {
		const pool = this.#state?.pool
		return { ...this.#diagnostics, queuedOperations: pool?.queued ?? 0, activeStreams: pool?.activeStreams ?? 0 }
	}

	// Resets the cumulative counters and peaks to zero.
	resetDiagnostics() {
		const d = this.#diagnostics
		d.bytesRead = d.readCalls = d.coverNodesVisited = d.zonesScanned = d.recordsScanned = d.recordsDecoded = d.peakBuffersInUse = d.peakConcurrentReads = d.peakQueuedOperations = d.peakActiveStreams = d.rejectedOperations = 0
	}

	// Opens a catalog directory (see openStellariumStarFiles for the discovery rules) and returns this catalog.
	// Throws when the catalog is already open or opening, when the directory has no valid star file, when any
	// file is invalid, when a required level is absent, or when close is called before the open completes; a
	// failed open leaves the catalog closed and its handles released.
	async open(root: string) {
		if (this.#state !== undefined || this.#opening !== undefined) throw new Error('Stellarium star catalog is already open')

		const opening = this.#open(root, this.#generation)
		this.#opening = opening

		try {
			return await opening
		} finally {
			if (this.#opening === opening) this.#opening = undefined
		}
	}

	// Opens the files for `generation` and publishes the state, unless close started a newer generation
	// meanwhile: then the new handles are closed and the open throws.
	async #open(root: string, generation: number) {
		const set = await openStellariumStarFiles(root)

		if (generation !== this.#generation) {
			await closeStellariumStarFiles(set.files)
			throw new Error('Stellarium star catalog was closed while opening')
		}

		const byLevel: (StellariumStarLevelFile | undefined)[] = []

		for (const file of set.files) byLevel[file.header.level] = file

		const missing = this.#requiredLevels.filter((level) => byLevel[level] === undefined)

		if (missing.length > 0) {
			await closeStellariumStarFiles(set.files)
			throw new Error(`missing required Stellarium star catalog levels: ${missing.join(', ')}`)
		}

		const levels = set.files.map((file): StellariumStarCatalogLevelInfo => {
			const { header } = file
			return {
				level: header.level,
				dataType: header.dataType,
				recordSize: header.recordSize,
				majorVersion: header.majorVersion,
				minorVersion: header.minorVersion,
				epochJD: header.epochJD,
				epoch: header.epoch,
				magnitudeMin: header.magnitudeMin,
				recordCount: file.index.recordCount,
				zoneCount: header.zoneCount,
				fileName: file.fileName,
				fileSize: file.fileSize,
				magnitudeRange: file.manifest?.magnitudeRange,
				checksum: file.manifest?.checksum,
			}
		})

		this.#state = { set, byLevel, levels, pool: new ReadSlotPool(this.#maxConcurrentReads, this.#maxPendingReads, this.#maxActiveStreams, this.#blockBytes, this.#diagnostics) }
		return this
	}

	// Closes the catalog, including one still opening: an open in progress fails and releases its handles,
	// operations waiting for a read buffer fail, queries of the current generation fail on their next read or
	// yield, reads in flight are awaited, and then the handles are closed. When it resolves, nothing opened
	// before the call holds a handle. Concurrent calls share the same work; closing a closed catalog only waits
	// for a close still in progress.
	async close() {
		const state = this.#state
		const opening = this.#opening

		if (state !== undefined || opening !== undefined) {
			this.#state = undefined
			this.#opening = undefined
			this.#generation++
			state?.pool.abort()

			const closing = this.#release(state, opening, [...this.#pending], this.#closing)
			this.#closing = closing
			void closing.then(() => {
				if (this.#closing === closing) this.#closing = undefined
			})
		}

		await this.#closing
	}

	// Waits for the previous close, the invalidated open (which closes its own handles) and the reads of the
	// closed generation, then closes the handles of `state`. Never rejects.
	async #release(state: OpenState | undefined, opening: Promise<unknown> | undefined, pending: readonly Promise<void>[], previous: Promise<void> | undefined) {
		await previous
		if (opening !== undefined) await Promise.allSettled([opening])
		await Promise.allSettled(pending)
		if (state !== undefined) await closeStellariumStarFiles(state.set.files)
	}

	// Closes the catalog at the end of an `await using` scope.
	async [Symbol.asyncDispose]() {
		await this.close()
	}

	// Reads one record by its physical address: zero-based `recordNumber` inside `zone` (the global zone is
	// 20 × 4^level) of `level`. Returns undefined for an absent level or an address outside the file; throws
	// when the catalog is closed or the read queue is full.
	async get(level: number, zone: number, recordNumber: number) {
		const state = this.#requireOpen()
		const generation = this.#generation
		const file = state.byLevel[level]
		if (file === undefined) return undefined

		const { header, index } = file
		if (!Number.isInteger(zone) || !(zone >= 0 && zone < header.zoneCount)) return undefined

		const first = index.starts[zone]
		if (!Number.isInteger(recordNumber) || !(recordNumber >= 0 && recordNumber < index.starts[zone + 1] - first)) return undefined

		const slot = await state.pool.acquire(state, true)
		slot.owner = undefined

		try {
			await this.#read(generation, file, slot.buffer, header.recordSize, header.dataOffset + (first + recordNumber) * header.recordSize)
			this.#diagnostics.recordsDecoded++
			return decodeStellariumStar(slot.buffer, 0, header, zone, recordNumber)
		} finally {
			state.pool.release(slot)
		}
	}

	// Streams every opened file through MD5 and compares it with the manifest checksum. Reads the whole files,
	// so it is an explicit integrity audit, never part of open. One audit runs at a time per open catalog, with
	// its own buffer of at most 1 MiB (independent of blockBytes and outside the read pool) and one read in
	// flight; concurrent calls share it and each get a fresh result array. Throws when the catalog is closed.
	async verifyChecksums() {
		const state = this.#requireOpen()
		let audit = state.audit

		if (audit === undefined) {
			const started = this.#audit(state, this.#generation)
			const clear = () => {
				if (state.audit === started) state.audit = undefined
			}
			state.audit = audit = started
			void started.then(clear, clear)
		}

		return [...(await audit)]
	}

	// Hashes the files of `state` sequentially for `generation` with one CHECKSUM_CHUNK_BYTES buffer.
	async #audit(state: OpenState, generation: number) {
		const results: StellariumStarChecksumResult[] = []
		let largest = 1
		for (const file of state.set.files) largest = Math.max(largest, file.fileSize)
		const buffer = Buffer.allocUnsafe(Math.min(CHECKSUM_CHUNK_BYTES, largest))

		for (const file of state.set.files) {
			const actual = await computeStellariumStarChecksum(file.fileSize, buffer, (chunk, length, position) => this.#read(generation, file, chunk, length, position))
			const expected = file.manifest?.checksum
			results.push({ level: file.header.level, fileName: file.fileName, expected, actual, matches: expected === undefined ? undefined : expected === actual })
		}

		return results
	}

	// Streams the candidate stars of a normalized query: the records of the covered zones of every level whose
	// header magnitude lower bound does not exceed magnitudeMax, stopping each zone at the first record fainter
	// than magnitudeMax (zones are sorted by ascending magnitude), skipping records brighter than magnitudeMin
	// and, outside zones fully inside the query, records outside the preselection boxes. The query takes an
	// active-stream place (failing at once when maxActiveStreams queries run) and is admitted to the read pool
	// (taking a buffer, waiting, or failing at once when the queue is full) before its zone cover is built. A
	// buffer is then held until the next yield and released before it; when the consumer resumes, the scan waits
	// for a buffer without the queue limit, and if another operation used it meanwhile, the current block is read
	// again. The place is released when the scan completes, fails or is returned.
	protected async *streamCandidateEntries(query: NormalizedStarCatalogQuery) {
		const state = this.#requireOpen()
		const generation = this.#generation
		const { magnitudeMin, magnitudeMax, preselectionBoxes } = query
		const files = magnitudeMax === undefined ? state.set.files : state.set.files.filter((file) => !(file.header.magnitudeMin > magnitudeMax))
		if (files.length === 0) return

		const { pool } = state
		if (!pool.startStream()) throw new Error(STREAMS_MESSAGE)

		// Identity of this scan in the pool: a buffer it gets back still owned by it holds its current block.
		const owner = {}
		let slot: ReadSlot | undefined

		try {
			const admitted = pool.acquire(owner, true)
			slot = admitted instanceof Promise ? await admitted : admitted
			slot.owner = owner

			const classify = query.kind === 'cone' ? stellariumConeClassifier(eraS2c(query.centerRA, query.centerDEC), query.radius) : stellariumBoxesClassifier(preselectionBoxes)
			const cover = stellariumZoneCover(
				classify,
				files.map((file) => file.header.level),
			)
			const diagnostics = this.#diagnostics
			diagnostics.coverNodesVisited += cover.visited
			const position: MutVec2 = [0, 0]

			for (const file of files) {
				const { header, index } = file
				const { dataType, recordSize, dataOffset, level } = header
				const { starts } = index
				const capacity = Math.floor(this.#blockBytes / recordSize)
				const globalZone = stellariumLocalZoneCount(level)
				const runs: StellariumZoneRange[] = [...(cover.ranges.get(level) ?? []), { start: globalZone, end: globalZone + 1, inside: false }]
				// Records [windowStart, windowEnd) of the file currently held by the buffer.
				let windowStart = 0
				let windowEnd = 0

				for (const run of runs) {
					const runEnd = starts[run.end]

					for (let zone = run.start; zone < run.end; zone++) {
						const zoneStart = starts[zone]
						const zoneEnd = starts[zone + 1]
						if (zoneStart === zoneEnd) continue

						diagnostics.zonesScanned++

						for (let record = zoneStart; record < zoneEnd; record++) {
							if (slot === undefined) {
								const acquired = pool.acquire(owner, false)
								slot = acquired instanceof Promise ? await acquired : acquired

								if (slot.owner !== owner) {
									slot.owner = owner
									windowStart = windowEnd = 0
								}
							}

							const { buffer } = slot

							if (record < windowStart || record >= windowEnd) {
								windowStart = record
								windowEnd = Math.min(runEnd, record + capacity)
								await this.#read(generation, file, buffer, (windowEnd - windowStart) * recordSize, dataOffset + windowStart * recordSize)
							}

							const offset = (record - windowStart) * recordSize
							const magnitude = readStellariumStarMagnitude(buffer, offset, dataType)
							diagnostics.recordsScanned++

							if (magnitudeMax !== undefined && !(magnitude <= magnitudeMax)) break
							if (magnitudeMin !== undefined && !(magnitude >= magnitudeMin)) continue

							if (!run.inside) {
								readStellariumStarPosition(buffer, offset, dataType, position)
								if (!insideBoxes(position[0], position[1], preselectionBoxes)) continue
							}

							diagnostics.recordsDecoded++
							const entry = decodeStellariumStar(buffer, offset, header, zone, record - zoneStart)
							if (generation !== this.#generation) throw new Error(CLOSED_MESSAGE)
							pool.release(slot)
							slot = undefined
							yield entry
						}
					}
				}
			}
		} finally {
			if (slot !== undefined) pool.release(slot)
			pool.endStream()
		}
	}

	// Returns the open state or throws when the catalog is closed.
	#requireOpen() {
		const state = this.#state
		if (state === undefined) throw new Error('Stellarium star catalog is not open')
		return state
	}

	// Reads `length` bytes at `position` of a file into `buffer` for the given generation, tracking the read so
	// close can await it. Throws when the generation was closed before or during the read, and names the file
	// and position on I/O failure or truncation.
	async #read(generation: number, file: StellariumStarLevelFile, buffer: Buffer, length: number, position: number) {
		if (generation !== this.#generation) throw new Error(CLOSED_MESSAGE)

		const read = readStellariumStarBytes(file.handle, buffer, length, position)
		this.#pending.add(read)
		if (this.#pending.size > this.#diagnostics.peakConcurrentReads) this.#diagnostics.peakConcurrentReads = this.#pending.size

		try {
			await read
		} catch (cause) {
			if (generation !== this.#generation) throw new Error(CLOSED_MESSAGE, { cause })
			const reason = cause instanceof Error ? cause.message : String(cause)
			throw new Error(`failed to read Stellarium star file ${file.fileName} (level ${file.header.level}) at byte ${position}: ${reason}`, { cause })
		} finally {
			this.#pending.delete(read)
		}

		if (generation !== this.#generation) throw new Error(CLOSED_MESSAGE)

		this.#diagnostics.readCalls++
		this.#diagnostics.bytesRead += length
	}
}

// Whether a position (radians) lies in any preselection box, widened by PRESELECTION_TOLERANCE.
function insideBoxes(rightAscension: number, declination: number, boxes: readonly StarCatalogRaDecBox[]) {
	for (const box of boxes) {
		if (rightAscension >= box.minRA - PRESELECTION_TOLERANCE && rightAscension <= box.maxRA + PRESELECTION_TOLERANCE && declination >= box.minDEC - PRESELECTION_TOLERANCE && declination <= box.maxDEC + PRESELECTION_TOLERANCE) return true
	}

	return false
}
