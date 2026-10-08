import { eraS2c } from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { MILLIASEC2RAD } from '../../core/constants'
import type { MutVec2 } from '../../math/linear-algebra/vec2'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogRaDecBox } from './catalog'
import { stellariumBoxesClassifier, stellariumConeClassifier, stellariumLocalZoneCount, stellariumZoneCover, type StellariumZoneRange } from './stellarium.geodesic'
import { decodeStellariumStar, readStellariumStarMagnitude, readStellariumStarPosition, type StellariumStarCatalogEntry, type StellariumStarDataType, type StellariumStarRecordSize } from './stellarium.star.binary'
import { closeStellariumStarFiles, computeStellariumStarChecksum, openStellariumStarFiles, readStellariumStarBytes, type StellariumStarFileSet, type StellariumStarLevelFile } from './stellarium.star.storage'

// Star catalog provider for the Stellarium Gaia DR3/Hipparcos star files (`stars_<level>_*.cat`, Stellarium
// 25.1+). It reads the original files in place: opening keeps one read-only handle, the header and the
// Uint32Array zone prefix sums per level, and a query selects the candidate geodesic zones of every available
// level (plus each level's global zone), reads only their records in fixed-size blocks with positional reads,
// rejects records by their encoded magnitude and coarse position before decoding, and lets BaseStarCatalog
// apply the exact geometry, the inclusive magnitude bounds and the limit. Positions are astrometric ICRS at the
// catalog epoch of each file (J2016.0 for the Gaia DR3 files), angles are radians, and the emission order is
// level by level and zone by zone, which is not a global brightness order. Memory per query is one block
// buffer and the zone cover; queryRegion materializes every match, so streamRegion suits dense regions.
// This provider is unrelated to the deep-sky StellariumCatalog of `stellarium.ts`.

// Default block size of the record reads, bytes.
const DEFAULT_BLOCK_BYTES = 128 * 1024
// Smallest block size, bytes: one record of the largest layout, so every read makes progress.
const MIN_BLOCK_BYTES = 48
// Largest block size, bytes; bounds the per-query buffer allocation.
const MAX_BLOCK_BYTES = 64 * 1024 * 1024
// Coarse-prefilter slack, radians (1 mas). Far above the exact-geometry tolerance, so a record that passes the
// exact test is never dropped by the prefilter, which uses the same decoded coordinates.
const PRESELECTION_TOLERANCE = MILLIASEC2RAD

// Options of a Stellarium star catalog.
export interface StellariumStarCatalogOptions {
	// Size of the per-query record buffer, bytes; an integer in 48..64 MiB, default 128 KiB.
	readonly blockBytes?: number
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
}

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
}

// Creates a Stellarium star catalog and opens the catalog directory `root` in one step.
export async function openStellariumStarCatalog(root: string, options?: StellariumStarCatalogOptions) {
	return await new StellariumStarCatalog(options).open(root)
}

// Reads the Stellarium star files of a directory through the generic star catalog contract.
export class StellariumStarCatalog extends BaseStarCatalog<StellariumStarCatalogEntry> implements AsyncDisposable {
	readonly #blockBytes: number
	readonly #requiredLevels: readonly number[]
	#state?: OpenState
	#opening = false
	// Incremented by close; reads and yields of an older generation fail instead of using closed handles.
	#generation = 0
	// Reads in flight, awaited by close before the handles are released.
	readonly #pending = new Set<Promise<void>>()
	readonly #diagnostics = { bytesRead: 0, readCalls: 0, coverNodesVisited: 0, zonesScanned: 0, recordsScanned: 0, recordsDecoded: 0 }

	// Creates a closed catalog. Throws when blockBytes is not an integer in 48..64 MiB, since a smaller block
	// could not hold a record and a larger one would be an oversized per-query allocation.
	constructor(options: StellariumStarCatalogOptions = {}) {
		super()

		const blockBytes = options.blockBytes ?? DEFAULT_BLOCK_BYTES
		if (!(Number.isInteger(blockBytes) && blockBytes >= MIN_BLOCK_BYTES && blockBytes <= MAX_BLOCK_BYTES)) throw new Error(`invalid Stellarium star catalog block size: ${blockBytes}`)

		this.#blockBytes = blockBytes
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

	// Snapshot of the cumulative counters.
	get diagnostics(): StellariumStarCatalogDiagnostics {
		return { ...this.#diagnostics }
	}

	// Resets the cumulative counters to zero.
	resetDiagnostics() {
		const d = this.#diagnostics
		d.bytesRead = d.readCalls = d.coverNodesVisited = d.zonesScanned = d.recordsScanned = d.recordsDecoded = 0
	}

	// Opens a catalog directory (see openStellariumStarFiles for the discovery rules) and returns this catalog.
	// Throws when the catalog is already open or opening, when the directory has no valid star file, when any
	// file is invalid, or when a required level is absent; a failed open leaves the catalog closed.
	async open(root: string) {
		if (this.#state !== undefined || this.#opening) throw new Error('Stellarium star catalog is already open')

		this.#opening = true

		try {
			const set = await openStellariumStarFiles(root)
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

			this.#state = { set, byLevel, levels }
			return this
		} finally {
			this.#opening = false
		}
	}

	// Closes the catalog: queries of the current generation fail on their next read or yield, reads in flight
	// are awaited, and then the handles are closed. Closing a closed catalog does nothing.
	async close() {
		const state = this.#state
		if (state === undefined) return

		this.#state = undefined
		this.#generation++

		await Promise.allSettled(this.#pending)
		await closeStellariumStarFiles(state.set.files)
	}

	// Closes the catalog at the end of an `await using` scope.
	async [Symbol.asyncDispose]() {
		await this.close()
	}

	// Reads one record by its physical address: zero-based `recordNumber` inside `zone` (the global zone is
	// 20 × 4^level) of `level`. Returns undefined for an absent level or an address outside the file; throws
	// when the catalog is closed.
	async get(level: number, zone: number, recordNumber: number) {
		const state = this.#requireOpen()
		const generation = this.#generation
		const file = state.byLevel[level]
		if (file === undefined) return undefined

		const { header, index } = file
		if (!Number.isInteger(zone) || !(zone >= 0 && zone < header.zoneCount)) return undefined

		const first = index.starts[zone]
		if (!Number.isInteger(recordNumber) || !(recordNumber >= 0 && recordNumber < index.starts[zone + 1] - first)) return undefined

		const buffer = Buffer.allocUnsafe(header.recordSize)
		await this.#read(generation, file, buffer, header.recordSize, header.dataOffset + (first + recordNumber) * header.recordSize)
		this.#diagnostics.recordsDecoded++
		return decodeStellariumStar(buffer, 0, header, zone, recordNumber)
	}

	// Streams every opened file through MD5 and compares it with the manifest checksum. Reads the whole files,
	// so it is an explicit integrity audit, never part of open. Throws when the catalog is closed.
	async verifyChecksums() {
		const state = this.#requireOpen()
		const generation = this.#generation
		const results: StellariumStarChecksumResult[] = []

		for (const file of state.set.files) {
			const actual = await computeStellariumStarChecksum(file.fileSize, (buffer, length, position) => this.#read(generation, file, buffer, length, position))
			const expected = file.manifest?.checksum
			results.push({ level: file.header.level, fileName: file.fileName, expected, actual, matches: expected === undefined ? undefined : expected === actual })
		}

		return results
	}

	// Streams the candidate stars of a normalized query: the records of the covered zones of every level whose
	// header magnitude lower bound does not exceed magnitudeMax, stopping each zone at the first record fainter
	// than magnitudeMax (zones are sorted by ascending magnitude), skipping records brighter than magnitudeMin
	// and, outside zones fully inside the query, records outside the preselection boxes.
	protected async *streamCandidateEntries(query: NormalizedStarCatalogQuery) {
		const state = this.#requireOpen()
		const generation = this.#generation
		const { magnitudeMin, magnitudeMax, preselectionBoxes } = query
		const files = magnitudeMax === undefined ? state.set.files : state.set.files.filter((file) => !(file.header.magnitudeMin > magnitudeMax))
		if (files.length === 0) return

		const classify = query.kind === 'cone' ? stellariumConeClassifier(eraS2c(query.centerRA, query.centerDEC), query.radius) : stellariumBoxesClassifier(preselectionBoxes)
		const cover = stellariumZoneCover(
			classify,
			files.map((file) => file.header.level),
		)
		const diagnostics = this.#diagnostics
		diagnostics.coverNodesVisited += cover.visited

		const buffer = Buffer.allocUnsafe(this.#blockBytes)
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
						if (generation !== this.#generation) throw new Error('Stellarium star catalog is closed')
						yield entry
					}
				}
			}
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
		if (generation !== this.#generation) throw new Error('Stellarium star catalog is closed')

		const read = readStellariumStarBytes(file.handle, buffer, length, position)
		this.#pending.add(read)

		try {
			await read
		} catch (cause) {
			if (generation !== this.#generation) throw new Error('Stellarium star catalog is closed', { cause })
			const reason = cause instanceof Error ? cause.message : String(cause)
			throw new Error(`failed to read Stellarium star file ${file.fileName} (level ${file.header.level}) at byte ${position}: ${reason}`, { cause })
		} finally {
			this.#pending.delete(read)
		}

		if (generation !== this.#generation) throw new Error('Stellarium star catalog is closed')

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
