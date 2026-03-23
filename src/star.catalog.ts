import fs from 'fs/promises'
import { type Angle, normalizeAngle } from './angle'
import { PI, PIOVERTWO, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import type { Sink, Source } from './io'

export const STAR_CATALOG_INDEX_MAGIC = 'NSTARIDX'
export const STAR_CATALOG_INDEX_VERSION = 1

const HEADER_SIZE = 160
const DIRECTORY_ENTRY_SIZE = 56
const RECORD_SIZE = 48

const HEADER_MAGIC_OFFSET = 0
const HEADER_VERSION_OFFSET = 8
const HEADER_STRATEGY_OFFSET = 10
const HEADER_FLAGS_OFFSET = 11
const HEADER_DECLINATION_BIN_COUNT_OFFSET = 12
const HEADER_RIGHT_ASCENSION_BIN_COUNT_OFFSET = 16
const HEADER_TOTAL_CELL_COUNT_OFFSET = 20
const HEADER_POPULATED_CELL_COUNT_OFFSET = 24
const HEADER_TOTAL_ROW_COUNT_OFFSET = 28
const HEADER_INDEXED_ROW_COUNT_OFFSET = 32
const HEADER_SKIPPED_ROW_COUNT_OFFSET = 36
const HEADER_DIRECTORY_OFFSET = 40
const HEADER_DIRECTORY_LENGTH_OFFSET = 44
const HEADER_RECORDS_OFFSET = 48
const HEADER_RECORDS_LENGTH_OFFSET = 52
const HEADER_STRINGS_OFFSET = 56
const HEADER_STRINGS_LENGTH_OFFSET = 60
const HEADER_PAYLOAD_OFFSET = 64
const HEADER_PAYLOAD_LENGTH_OFFSET = 68
const HEADER_FINGERPRINT_OFFSET = 72
const HEADER_MIN_RIGHT_ASCENSION_OFFSET = 80
const HEADER_MAX_RIGHT_ASCENSION_OFFSET = 88
const HEADER_MIN_DECLINATION_OFFSET = 96
const HEADER_MAX_DECLINATION_OFFSET = 104
const HEADER_OCCUPANCY_MIN_OFFSET = 112
const HEADER_OCCUPANCY_MAX_OFFSET = 116
const HEADER_OCCUPANCY_AVERAGE_OFFSET = 120
const HEADER_EMPTY_CELL_RATIO_OFFSET = 128
const HEADER_BUILD_ELAPSED_MS_OFFSET = 136

const DIRECTORY_CELL_ID_OFFSET = 0
const DIRECTORY_COUNT_OFFSET = 4
const DIRECTORY_FIRST_RECORD_INDEX_OFFSET = 8
const DIRECTORY_RECORD_OFFSET_OFFSET = 12
const DIRECTORY_RECORD_LENGTH_OFFSET = 16
const DIRECTORY_MIN_RIGHT_ASCENSION_OFFSET = 24
const DIRECTORY_MAX_RIGHT_ASCENSION_OFFSET = 32
const DIRECTORY_MIN_DECLINATION_OFFSET = 40
const DIRECTORY_MAX_DECLINATION_OFFSET = 48

const RECORD_ROW_INDEX_OFFSET = 0
const RECORD_ID_KIND_OFFSET = 4
const RECORD_ID_STRING_OFFSET = 8
const RECORD_ID_STRING_LENGTH_OFFSET = 12
const RECORD_ID_NUMBER_OFFSET = 16
const RECORD_RIGHT_ASCENSION_OFFSET = 24
const RECORD_DECLINATION_OFFSET = 32
const RECORD_PAYLOAD_OFFSET = 40
const RECORD_PAYLOAD_LENGTH_OFFSET = 44

const FLAG_PAYLOAD_STORED = 1 << 0
const FLAG_SORTED_BY_RIGHT_ASCENSION = 1 << 1

const STRATEGY_DECLINATION_BINS = 1
const STRATEGY_EQUIRECTANGULAR_GRID = 2

const RECORD_ID_KIND_NUMBER = 1
const RECORD_ID_KIND_STRING = 2

const DECLINATION_EPSILON = 1e-12
const HASH_BASIS = 0x811c9dc5
const HASH_PRIME = 0x01000193

export type StarCatalogSpatialIndexStrategyType = 'declination-bins' | 'equirectangular-grid' | 'healpix' | 'htm'

export type StarCatalogInvalidCoordinateMode = 'throw' | 'skip'

export interface StarCatalogInputRecord<T = unknown> extends Readonly<EquatorialCoordinate> {
	readonly id: number | string
	readonly payload?: T
}

export interface StarCatalogPayloadCodec<T> {
	readonly encode: (payload: T) => Buffer | Uint8Array
	readonly decode: (payload: Buffer) => T
}

export interface StarCatalogDeclinationBinsStrategyConfig {
	readonly type: 'declination-bins'
	readonly declinationBinCount?: number
}

export interface StarCatalogEquirectangularGridStrategyConfig {
	readonly type: 'equirectangular-grid'
	readonly declinationBinCount?: number
	readonly rightAscensionBinCount?: number
}

export interface StarCatalogHealpixStrategyConfig {
	readonly type: 'healpix'
	readonly order: number
}

export interface StarCatalogHtmStrategyConfig {
	readonly type: 'htm'
	readonly depth: number
}

export type StarCatalogIndexStrategyConfig = StarCatalogDeclinationBinsStrategyConfig | StarCatalogEquirectangularGridStrategyConfig | StarCatalogHealpixStrategyConfig | StarCatalogHtmStrategyConfig

export interface StarCatalogIndexBuildConfig<T = unknown> {
	readonly strategy?: StarCatalogIndexStrategyConfig
	readonly invalidCoordinateMode?: StarCatalogInvalidCoordinateMode
	readonly includePayload?: boolean
	readonly payloadCodec?: StarCatalogPayloadCodec<T>
}

export interface StarCatalogIndexDestination {
	readonly path?: string
	readonly sink?: Sink
}

export interface StarCatalogCoordinateRange {
	readonly minRightAscension: Angle
	readonly maxRightAscension: Angle
	readonly minDeclination: Angle
	readonly maxDeclination: Angle
}

export interface StarCatalogIndexStrategyMetadata {
	readonly type: StarCatalogSpatialIndexStrategyType
	readonly declinationBinCount: number
	readonly rightAscensionBinCount: number
}

export interface StarCatalogIndexMetadata {
	readonly magic: string
	readonly formatVersion: number
	readonly strategy: StarCatalogIndexStrategyMetadata
	readonly coordinatePrecision: 'float64'
	readonly endianness: 'little-endian'
	readonly totalCellCount: number
	readonly populatedCellCount: number
	readonly totalRowCount: number
	readonly indexedRowCount: number
	readonly skippedRowCount: number
	readonly occupancyMin: number
	readonly occupancyMax: number
	readonly occupancyAverage: number
	readonly emptyCellRatio: number
	readonly coordinateRange: StarCatalogCoordinateRange
	readonly payloadStored: boolean
	readonly sortedByRightAscension: boolean
	readonly fingerprint: string
}

export interface StarCatalogCellDirectoryEntry {
	readonly cellId: number
	readonly count: number
	readonly firstRecordIndex: number
	readonly recordOffset: number
	readonly recordLength: number
	readonly minRightAscension: Angle
	readonly maxRightAscension: Angle
	readonly minDeclination: Angle
	readonly maxDeclination: Angle
}

export interface StarCatalogIndexedRecord<T = unknown> extends Readonly<EquatorialCoordinate> {
	readonly id: number | string
	readonly rowIndex: number
	readonly payload?: T
}

export interface StarCatalogBuildSummary {
	readonly totalRowCount: number
	readonly indexedRowCount: number
	readonly skippedRowCount: number
	readonly populatedCellCount: number
	readonly bytesWritten: number
	readonly buildElapsedMs: number
	readonly fingerprint: string
}

export interface StarCatalogBuildResult<T = unknown> {
	readonly summary: StarCatalogBuildSummary
	readonly metadata: StarCatalogIndexMetadata
	readonly buffer: Buffer
	readonly index: StarCatalogSpatialIndex<T>
	readonly path?: string
}

export interface StarCatalogLoadOptions<T = unknown> {
	readonly payloadCodec?: StarCatalogPayloadCodec<T>
	readonly validateIntegrity?: boolean
}

interface ResolvedStrategy {
	readonly code: number
	readonly metadata: StarCatalogIndexStrategyMetadata
	readonly totalCellCount: number
	readonly cellIdFor: (rightAscension: Angle, declination: Angle) => number
	readonly enumerateConeCells: (rightAscension: Angle, declination: Angle, radius: Angle) => number[]
	readonly enumerateRectangleCells: (rightAscensionWindows: readonly RightAscensionWindow[], minDeclination: Angle, maxDeclination: Angle) => number[]
	readonly cellBoundsFor: (cellId: number) => StarCatalogCoordinateRange
}

interface RightAscensionWindow {
	readonly min: Angle
	readonly max: Angle
}

interface NormalizedBuildConfig<T> {
	readonly strategy: ResolvedStrategy
	readonly invalidCoordinateMode: StarCatalogInvalidCoordinateMode
	readonly includePayload: boolean
	readonly payloadCodec?: StarCatalogPayloadCodec<T>
}

interface BuildRecord<T> {
	readonly id: number | string
	readonly rowIndex: number
	readonly rightAscension: Angle
	readonly declination: Angle
	readonly cellId: number
	readonly payload?: T
}

interface SerializedIndexSections {
	readonly directoryEntries: readonly StarCatalogCellDirectoryEntry[]
	readonly stringOffsets: Uint32Array
	readonly stringLengths: Uint32Array
	readonly payloadOffsets: Uint32Array
	readonly payloadLengths: Uint32Array
	readonly strings: Buffer
	readonly payload: Buffer
}

const FULL_RIGHT_ASCENSION_WINDOWS = [{ min: 0, max: TAU }] as const

// Builds an in-memory spatial index and optionally persists it to a sink or path.
export async function buildStarCatalogIndex<T>(catalog: Iterable<StarCatalogInputRecord<T>> | AsyncIterable<StarCatalogInputRecord<T>>, config: StarCatalogIndexBuildConfig<T> = {}, destination?: StarCatalogIndexDestination): Promise<StarCatalogBuildResult<T>> {
	const resolved = normalizeBuildConfig(config)
	const startedAt = performance.now()
	const records: BuildRecord<T>[] = []
	let totalRowCount = 0
	let skippedRowCount = 0
	let minRightAscension = Infinity
	let maxRightAscension = -Infinity
	let minDeclination = Infinity
	let maxDeclination = -Infinity

	for await (const record of catalog) {
		const normalized = normalizeInputRecord(record, totalRowCount, resolved)
		totalRowCount++

		if (normalized === undefined) {
			skippedRowCount++
			continue
		}

		records.push(normalized)

		if (normalized.rightAscension < minRightAscension) minRightAscension = normalized.rightAscension
		if (normalized.rightAscension > maxRightAscension) maxRightAscension = normalized.rightAscension
		if (normalized.declination < minDeclination) minDeclination = normalized.declination
		if (normalized.declination > maxDeclination) maxDeclination = normalized.declination
	}

	records.sort(BuildRecordComparator)

	const sections = serializeIndexSections(records, resolved)
	const directoryLength = sections.directoryEntries.length * DIRECTORY_ENTRY_SIZE
	const recordsLength = records.length * RECORD_SIZE
	const directoryOffset = HEADER_SIZE
	const recordsOffset = directoryOffset + directoryLength
	const stringsOffset = recordsOffset + recordsLength
	const payloadOffset = stringsOffset + sections.strings.byteLength
	const occupancyMin = sections.directoryEntries.length ? Math.min(...sections.directoryEntries.map((entry) => entry.count)) : 0
	const occupancyMax = sections.directoryEntries.length ? Math.max(...sections.directoryEntries.map((entry) => entry.count)) : 0
	const buildElapsedMs = performance.now() - startedAt
	const buffer = Buffer.allocUnsafe(payloadOffset + sections.payload.byteLength)

	writeIndexBuffer(
		buffer,
		{
			directoryOffset,
			directoryLength,
			recordsOffset,
			recordsLength,
			stringsOffset,
			stringsLength: sections.strings.byteLength,
			payloadOffset,
			payloadLength: sections.payload.byteLength,
			totalRowCount,
			indexedRowCount: records.length,
			skippedRowCount,
			populatedCellCount: sections.directoryEntries.length,
			buildElapsedMs: 0,
			minRightAscension: records.length ? minRightAscension : 0,
			maxRightAscension: records.length ? maxRightAscension : 0,
			minDeclination: records.length ? minDeclination : 0,
			maxDeclination: records.length ? maxDeclination : 0,
			occupancyMin,
			occupancyMax,
			occupancyAverage: sections.directoryEntries.length ? records.length / sections.directoryEntries.length : 0,
			emptyCellRatio: resolved.strategy.totalCellCount === 0 ? 0 : (resolved.strategy.totalCellCount - sections.directoryEntries.length) / resolved.strategy.totalCellCount,
			strategy: resolved.strategy,
			payloadStored: resolved.includePayload,
		},
		sections.directoryEntries,
		records,
		sections,
		resolved,
	)

	const fingerprint = hashCatalogBuffer(buffer)
	buffer.writeUInt32LE(fingerprint, HEADER_FINGERPRINT_OFFSET)

	if (destination?.sink) {
		await destination.sink.write(buffer, 0, buffer.byteLength)
	}

	if (destination?.path) {
		await fs.writeFile(destination.path, buffer)
	}

	const index = new StarCatalogSpatialIndex(buffer, {
		payloadCodec: resolved.payloadCodec,
		validateIntegrity: true,
	})

	return {
		summary: {
			totalRowCount,
			indexedRowCount: records.length,
			skippedRowCount,
			populatedCellCount: sections.directoryEntries.length,
			bytesWritten: buffer.byteLength,
			buildElapsedMs,
			fingerprint: index.metadata.fingerprint,
		},
		metadata: index.metadata,
		buffer,
		index,
		path: destination?.path,
	}
}

// Stores a built index directly to a file path.
export function buildStarCatalogIndexFile<T>(catalog: Iterable<StarCatalogInputRecord<T>> | AsyncIterable<StarCatalogInputRecord<T>>, path: string, config: StarCatalogIndexBuildConfig<T> = {}): Promise<StarCatalogBuildResult<T>> {
	return buildStarCatalogIndex(catalog, config, { path })
}

// Loads a persisted star catalog index from a path, buffer, or generic source.
export async function loadStarCatalogIndex<T = unknown>(input: Buffer | Uint8Array | ArrayBuffer | Source | string, options: StarCatalogLoadOptions<T> = {}): Promise<StarCatalogSpatialIndex<T>> {
	const buffer = typeof input === 'string' ? await fs.readFile(input) : await toBuffer(input)
	return new StarCatalogSpatialIndex(buffer, options)
}

// Represents a loaded spatial index over a persisted star catalog.
export class StarCatalogSpatialIndex<T = unknown> {
	readonly metadata: StarCatalogIndexMetadata
	readonly directory: readonly StarCatalogCellDirectoryEntry[]
	readonly buildElapsedMs: number

	private readonly buffer: Buffer
	private readonly payloadCodec?: StarCatalogPayloadCodec<T>
	private readonly strategy: ResolvedStrategy
	private readonly recordsOffset: number
	private readonly stringsOffset: number
	private readonly payloadOffset: number

	constructor(buffer: Buffer, options: StarCatalogLoadOptions<T> = {}) {
		this.buffer = buffer
		this.payloadCodec = options.payloadCodec
		const header = validateAndReadHeader(buffer, options.validateIntegrity ?? true)
		this.strategy = resolvePersistedStrategy(header.strategyType, header.declinationBinCount, header.rightAscensionBinCount)
		this.recordsOffset = header.recordsOffset
		this.stringsOffset = header.stringsOffset
		this.payloadOffset = header.payloadOffset
		this.directory = readDirectory(buffer, header.directoryOffset, header.directoryLength)
		this.buildElapsedMs = header.buildElapsedMs
		this.metadata = {
			magic: STAR_CATALOG_INDEX_MAGIC,
			formatVersion: STAR_CATALOG_INDEX_VERSION,
			strategy: this.strategy.metadata,
			coordinatePrecision: 'float64',
			endianness: 'little-endian',
			totalCellCount: header.totalCellCount,
			populatedCellCount: header.populatedCellCount,
			totalRowCount: header.totalRowCount,
			indexedRowCount: header.indexedRowCount,
			skippedRowCount: header.skippedRowCount,
			occupancyMin: header.occupancyMin,
			occupancyMax: header.occupancyMax,
			occupancyAverage: header.occupancyAverage,
			emptyCellRatio: header.emptyCellRatio,
			coordinateRange: {
				minRightAscension: header.minRightAscension,
				maxRightAscension: header.maxRightAscension,
				minDeclination: header.minDeclination,
				maxDeclination: header.maxDeclination,
			},
			payloadStored: (header.flags & FLAG_PAYLOAD_STORED) !== 0,
			sortedByRightAscension: (header.flags & FLAG_SORTED_BY_RIGHT_ASCENSION) !== 0,
			fingerprint: toHexFingerprint(header.fingerprint),
		}
	}

	// Returns the populated cells in persisted order.
	getCellDirectory(): readonly StarCatalogCellDirectoryEntry[] {
		return this.directory
	}

	// Decodes all records belonging to one populated cell.
	getCellRecords(cellId: number): readonly StarCatalogIndexedRecord<T>[] {
		const entry = findDirectoryEntry(this.directory, cellId)
		if (entry === undefined) return []
		const records = new Array<StarCatalogIndexedRecord<T>>(entry.count)

		for (let i = 0; i < entry.count; i++) {
			records[i] = this.decodeRecord(entry.firstRecordIndex + i)
		}

		return records
	}

	// Decodes the entire persisted catalog in deterministic order.
	getAllRecords(): readonly StarCatalogIndexedRecord<T>[] {
		const records = new Array<StarCatalogIndexedRecord<T>>(this.metadata.indexedRowCount)

		for (let i = 0; i < records.length; i++) {
			records[i] = this.decodeRecord(i)
		}

		return records
	}

	// Enumerates populated cells that can intersect a cone search.
	enumerateCandidateCellsForCone(rightAscension: Angle, declination: Angle, radius: Angle): readonly StarCatalogCellDirectoryEntry[] {
		validateQueryCoordinate(rightAscension, declination)
		validateSearchRadius(radius)
		const cellIds = this.strategy.enumerateConeCells(normalizeAngle(rightAscension), declination, radius)
		return materializeCandidateCells(this.directory, cellIds)
	}

	// Enumerates populated cells that can intersect a RA/Dec rectangle.
	enumerateCandidateCellsForRectangle(minRightAscension: Angle, maxRightAscension: Angle, minDeclination: Angle, maxDeclination: Angle): readonly StarCatalogCellDirectoryEntry[] {
		validateDeclinationRange(minDeclination, maxDeclination)
		const windows = normalizeRightAscensionWindows(minRightAscension, maxRightAscension)
		const cellIds = this.strategy.enumerateRectangleCells(windows, minDeclination, maxDeclination)
		return materializeCandidateCells(this.directory, cellIds)
	}

	// Executes an exact cone search using the persisted cell layout plus spherical filtering.
	queryCone(rightAscension: Angle, declination: Angle, radius: Angle): readonly StarCatalogIndexedRecord<T>[] {
		validateQueryCoordinate(rightAscension, declination)
		validateSearchRadius(radius)
		const normalizedRightAscension = normalizeAngle(rightAscension)
		const windows = radius >= PI ? FULL_RIGHT_ASCENSION_WINDOWS : coneRightAscensionWindows(normalizedRightAscension, radius)
		const minDeclination = Math.max(-PIOVERTWO, declination - radius)
		const maxDeclination = Math.min(PIOVERTWO, declination + radius)
		const cells = this.enumerateCandidateCellsForCone(normalizedRightAscension, declination, radius)
		const matches: StarCatalogIndexedRecord<T>[] = []

		for (let i = 0; i < cells.length; i++) {
			this.collectConeMatches(cells[i], windows, minDeclination, maxDeclination, normalizedRightAscension, declination, radius, matches)
		}

		return matches
	}

	// Executes an exact RA/Dec rectangle search, including wraparound at 0/2π.
	queryRectangle(minRightAscension: Angle, maxRightAscension: Angle, minDeclination: Angle, maxDeclination: Angle): readonly StarCatalogIndexedRecord<T>[] {
		validateDeclinationRange(minDeclination, maxDeclination)
		const windows = normalizeRightAscensionWindows(minRightAscension, maxRightAscension)
		const cells = this.enumerateCandidateCellsForRectangle(minRightAscension, maxRightAscension, minDeclination, maxDeclination)
		const matches: StarCatalogIndexedRecord<T>[] = []

		for (let i = 0; i < cells.length; i++) {
			this.collectRectangleMatches(cells[i], windows, minDeclination, maxDeclination, matches)
		}

		return matches
	}

	private decodeRecord(recordIndex: number): StarCatalogIndexedRecord<T> {
		const offset = this.recordsOffset + recordIndex * RECORD_SIZE
		const rowIndex = this.buffer.readUInt32LE(offset + RECORD_ROW_INDEX_OFFSET)
		const idKind = this.buffer.readUInt8(offset + RECORD_ID_KIND_OFFSET)
		const rightAscension = this.buffer.readDoubleLE(offset + RECORD_RIGHT_ASCENSION_OFFSET)
		const declination = this.buffer.readDoubleLE(offset + RECORD_DECLINATION_OFFSET)
		let id: number | string

		if (idKind === RECORD_ID_KIND_NUMBER) {
			id = this.buffer.readDoubleLE(offset + RECORD_ID_NUMBER_OFFSET)
		} else if (idKind === RECORD_ID_KIND_STRING) {
			const stringOffset = this.buffer.readUInt32LE(offset + RECORD_ID_STRING_OFFSET)
			const stringLength = this.buffer.readUInt32LE(offset + RECORD_ID_STRING_LENGTH_OFFSET)
			id = this.buffer.toString('utf8', this.stringsOffset + stringOffset, this.stringsOffset + stringOffset + stringLength)
		} else {
			throw new Error(`unsupported star catalog record id kind: ${idKind}`)
		}

		const payloadLength = this.buffer.readUInt32LE(offset + RECORD_PAYLOAD_LENGTH_OFFSET)

		if (!payloadLength || this.payloadCodec === undefined) {
			return { id, rowIndex, rightAscension, declination }
		}

		const payloadOffset = this.buffer.readUInt32LE(offset + RECORD_PAYLOAD_OFFSET)
		const payload = this.payloadCodec.decode(this.buffer.subarray(this.payloadOffset + payloadOffset, this.payloadOffset + payloadOffset + payloadLength))
		return { id, rowIndex, rightAscension, declination, payload }
	}

	private collectConeMatches(entry: StarCatalogCellDirectoryEntry, windows: readonly RightAscensionWindow[], minDeclination: Angle, maxDeclination: Angle, centerRightAscension: Angle, centerDeclination: Angle, radius: Angle, out: StarCatalogIndexedRecord<T>[]) {
		for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
			const window = windows[windowIndex]
			const first = this.lowerBoundRightAscension(entry, window.min)
			const last = this.upperBoundRightAscension(entry, window.max)

			for (let i = first; i < last; i++) {
				const recordOffset = this.recordsOffset + (entry.firstRecordIndex + i) * RECORD_SIZE
				const declination = this.buffer.readDoubleLE(recordOffset + RECORD_DECLINATION_OFFSET)
				if (declination < minDeclination || declination > maxDeclination) continue
				const rightAscension = this.buffer.readDoubleLE(recordOffset + RECORD_RIGHT_ASCENSION_OFFSET)
				if (!coneContains(centerRightAscension, centerDeclination, rightAscension, declination, radius)) continue
				out.push(this.decodeRecord(entry.firstRecordIndex + i))
			}
		}
	}

	private collectRectangleMatches(entry: StarCatalogCellDirectoryEntry, windows: readonly RightAscensionWindow[], minDeclination: Angle, maxDeclination: Angle, out: StarCatalogIndexedRecord<T>[]) {
		for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
			const window = windows[windowIndex]
			const first = this.lowerBoundRightAscension(entry, window.min)
			const last = this.upperBoundRightAscension(entry, window.max)

			for (let i = first; i < last; i++) {
				const recordOffset = this.recordsOffset + (entry.firstRecordIndex + i) * RECORD_SIZE
				const declination = this.buffer.readDoubleLE(recordOffset + RECORD_DECLINATION_OFFSET)
				if (declination < minDeclination || declination > maxDeclination) continue
				out.push(this.decodeRecord(entry.firstRecordIndex + i))
			}
		}
	}

	private lowerBoundRightAscension(entry: StarCatalogCellDirectoryEntry, value: Angle) {
		let lo = 0
		let hi = entry.count

		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const rightAscension = this.buffer.readDoubleLE(this.recordsOffset + (entry.firstRecordIndex + mid) * RECORD_SIZE + RECORD_RIGHT_ASCENSION_OFFSET)
			if (rightAscension < value) lo = mid + 1
			else hi = mid
		}

		return lo
	}

	private upperBoundRightAscension(entry: StarCatalogCellDirectoryEntry, value: Angle) {
		let lo = 0
		let hi = entry.count

		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const rightAscension = this.buffer.readDoubleLE(this.recordsOffset + (entry.firstRecordIndex + mid) * RECORD_SIZE + RECORD_RIGHT_ASCENSION_OFFSET)
			if (rightAscension <= value) lo = mid + 1
			else hi = mid
		}

		return lo
	}
}

// Normalizes build-time configuration and resolves the selected strategy.
function normalizeBuildConfig<T>(config: StarCatalogIndexBuildConfig<T>): NormalizedBuildConfig<T> {
	return {
		strategy: resolveStrategy(config.strategy),
		invalidCoordinateMode: config.invalidCoordinateMode ?? 'throw',
		includePayload: config.includePayload ?? false,
		payloadCodec: config.payloadCodec,
	}
}

// Converts one caller record into a validated and normalized build record.
function normalizeInputRecord<T>(record: StarCatalogInputRecord<T>, rowIndex: number, config: NormalizedBuildConfig<T>): BuildRecord<T> | undefined {
	const rightAscension = normalizeCoordinateValue(record.rightAscension)
	const declination = normalizeDeclinationValue(record.declination)
	const validIdentifier = typeof record.id === 'string' ? true : Number.isFinite(record.id)

	if (rightAscension === undefined || declination === undefined || !validIdentifier) {
		if (config.invalidCoordinateMode === 'skip') return undefined
		throw new Error(`invalid star catalog record at row ${rowIndex}`)
	}

	return {
		id: record.id,
		rowIndex,
		rightAscension,
		declination,
		cellId: config.strategy.cellIdFor(rightAscension, declination),
		payload: config.includePayload ? record.payload : undefined,
	}
}

// Resolves a strategy config into executable cell-mapping and candidate-enumeration logic.
function resolveStrategy(config?: StarCatalogIndexStrategyConfig): ResolvedStrategy {
	const type = config?.type ?? 'declination-bins'

	switch (type) {
		case 'declination-bins': {
			const declinationConfig = config as StarCatalogDeclinationBinsStrategyConfig | undefined
			const declinationBinCount = clampPositiveInteger(declinationConfig?.declinationBinCount ?? 180, 1, 8192, 'declinationBinCount')
			return createDeclinationBinsStrategy(declinationBinCount)
		}
		case 'equirectangular-grid': {
			const gridConfig = config as StarCatalogEquirectangularGridStrategyConfig | undefined
			const declinationBinCount = clampPositiveInteger(gridConfig?.declinationBinCount ?? 180, 1, 8192, 'declinationBinCount')
			const rightAscensionBinCount = clampPositiveInteger(gridConfig?.rightAscensionBinCount ?? 360, 1, 16384, 'rightAscensionBinCount')
			return createEquirectangularGridStrategy(declinationBinCount, rightAscensionBinCount)
		}
		case 'healpix':
			throw new Error(`unsupported star catalog strategy type: ${type}`)
		case 'htm':
			throw new Error(`unsupported star catalog strategy type: ${type}`)
		default:
			throw new Error(`unsupported star catalog strategy type: ${type}`)
	}
}

// Rehydrates a runtime strategy from persisted header metadata.
function resolvePersistedStrategy(type: StarCatalogSpatialIndexStrategyType, declinationBinCount: number, rightAscensionBinCount: number): ResolvedStrategy {
	return type === 'equirectangular-grid' ? resolveStrategy({ type, declinationBinCount, rightAscensionBinCount }) : resolveStrategy({ type: 'declination-bins', declinationBinCount })
}

// Creates the simple declination-band baseline strategy.
function createDeclinationBinsStrategy(declinationBinCount: number): ResolvedStrategy {
	const step = PI / declinationBinCount

	return {
		code: STRATEGY_DECLINATION_BINS,
		metadata: {
			type: 'declination-bins',
			declinationBinCount,
			rightAscensionBinCount: 1,
		},
		totalCellCount: declinationBinCount,
		cellIdFor(_rightAscension: Angle, declination: Angle) {
			return declinationBin(declination, declinationBinCount)
		},
		enumerateConeCells(_rightAscension: Angle, declination: Angle, radius: Angle) {
			const minBin = declinationBin(Math.max(-PIOVERTWO, declination - radius), declinationBinCount)
			const maxBin = declinationBin(Math.min(PIOVERTWO, declination + radius), declinationBinCount)
			const cells = new Array<number>(maxBin - minBin + 1)

			for (let i = 0; i < cells.length; i++) cells[i] = minBin + i

			return cells
		},
		enumerateRectangleCells(_windows: readonly RightAscensionWindow[], minDeclination: Angle, maxDeclination: Angle) {
			const minBin = declinationBin(minDeclination, declinationBinCount)
			const maxBin = declinationBin(maxDeclination, declinationBinCount)
			const cells = new Array<number>(maxBin - minBin + 1)

			for (let i = 0; i < cells.length; i++) cells[i] = minBin + i

			return cells
		},
		cellBoundsFor(cellId: number) {
			const minDeclination = -PIOVERTWO + cellId * step
			return {
				minRightAscension: 0,
				maxRightAscension: TAU,
				minDeclination,
				maxDeclination: Math.min(PIOVERTWO, minDeclination + step),
			}
		},
	}
}

// Creates a fixed-resolution spherical grid strategy over normalized RA and Dec.
function createEquirectangularGridStrategy(declinationBinCount: number, rightAscensionBinCount: number): ResolvedStrategy {
	const declinationStep = PI / declinationBinCount
	const rightAscensionStep = TAU / rightAscensionBinCount

	return {
		code: STRATEGY_EQUIRECTANGULAR_GRID,
		metadata: {
			type: 'equirectangular-grid',
			declinationBinCount,
			rightAscensionBinCount,
		},
		totalCellCount: declinationBinCount * rightAscensionBinCount,
		cellIdFor(rightAscension: Angle, declination: Angle) {
			const decBin = declinationBin(declination, declinationBinCount)
			const raBin = rightAscensionBin(normalizeAngle(rightAscension), rightAscensionBinCount)
			return decBin * rightAscensionBinCount + raBin
		},
		enumerateConeCells(rightAscension: Angle, declination: Angle, radius: Angle) {
			const minBin = declinationBin(Math.max(-PIOVERTWO, declination - radius), declinationBinCount)
			const maxBin = declinationBin(Math.min(PIOVERTWO, declination + radius), declinationBinCount)
			const cells: number[] = []

			for (let decBin = minBin; decBin <= maxBin; decBin++) {
				const minDec = -PIOVERTWO + decBin * declinationStep
				const maxDec = Math.min(PIOVERTWO, minDec + declinationStep)
				const halfWidth = coneRightAscensionHalfWidth(radius, minDec, maxDec)
				pushWindowCells(cells, decBin, rightAscensionBinCount, coneRightAscensionWindows(rightAscension, halfWidth))
			}

			return uniqueSortedCells(cells)
		},
		enumerateRectangleCells(windows: readonly RightAscensionWindow[], minDeclination: Angle, maxDeclination: Angle) {
			const minBin = declinationBin(minDeclination, declinationBinCount)
			const maxBin = declinationBin(maxDeclination, declinationBinCount)
			const cells: number[] = []

			for (let decBin = minBin; decBin <= maxBin; decBin++) {
				pushWindowCells(cells, decBin, rightAscensionBinCount, windows)
			}

			return uniqueSortedCells(cells)
		},
		cellBoundsFor(cellId: number) {
			const decBin = Math.trunc(cellId / rightAscensionBinCount)
			const raBin = cellId % rightAscensionBinCount
			const minDeclination = -PIOVERTWO + decBin * declinationStep
			const minRightAscension = raBin * rightAscensionStep
			return {
				minRightAscension,
				maxRightAscension: minRightAscension + rightAscensionStep,
				minDeclination,
				maxDeclination: Math.min(PIOVERTWO, minDeclination + declinationStep),
			}
		},
	}
}

// Groups sorted records into populated cells and serializes optional string/payload sections.
function serializeIndexSections<T>(records: readonly BuildRecord<T>[], config: NormalizedBuildConfig<T>): SerializedIndexSections {
	const directoryEntries: StarCatalogCellDirectoryEntry[] = []
	const stringOffsets = new Uint32Array(records.length)
	const stringLengths = new Uint32Array(records.length)
	const payloadOffsets = new Uint32Array(records.length)
	const payloadLengths = new Uint32Array(records.length)
	const stringBuffers: Buffer[] = []
	const payloadBuffers: Buffer[] = []
	let stringLength = 0
	let payloadLength = 0

	for (let i = 0; i < records.length; i++) {
		const record = records[i]

		if (typeof record.id === 'string') {
			const bytes = Buffer.from(record.id, 'utf8')
			stringOffsets[i] = stringLength
			stringLengths[i] = bytes.byteLength
			stringBuffers.push(bytes)
			stringLength += bytes.byteLength
		}

		if (config.includePayload && record.payload !== undefined) {
			if (config.payloadCodec === undefined) {
				throw new Error('payload codec is required when includePayload is enabled and payloads are present')
			}

			const bytes = toOwnedBuffer(config.payloadCodec.encode(record.payload))
			payloadOffsets[i] = payloadLength
			payloadLengths[i] = bytes.byteLength
			payloadBuffers.push(bytes)
			payloadLength += bytes.byteLength
		}
	}

	for (let start = 0; start < records.length; ) {
		const first = records[start]
		let end = start + 1
		let minDeclination = first.declination
		let maxDeclination = first.declination

		while (end < records.length && records[end].cellId === first.cellId) {
			if (records[end].declination < minDeclination) minDeclination = records[end].declination
			if (records[end].declination > maxDeclination) maxDeclination = records[end].declination
			end++
		}

		directoryEntries.push({
			cellId: first.cellId,
			count: end - start,
			firstRecordIndex: start,
			recordOffset: start * RECORD_SIZE,
			recordLength: (end - start) * RECORD_SIZE,
			minRightAscension: first.rightAscension,
			maxRightAscension: records[end - 1].rightAscension,
			minDeclination,
			maxDeclination,
		})

		start = end
	}

	return {
		directoryEntries,
		stringOffsets,
		stringLengths,
		payloadOffsets,
		payloadLengths,
		strings: Buffer.concat(stringBuffers, stringLength),
		payload: Buffer.concat(payloadBuffers, payloadLength),
	}
}

// Writes the header, directory, records, and variable-length sections into the final buffer.
function writeIndexBuffer<T>(
	buffer: Buffer,
	header: {
		readonly directoryOffset: number
		readonly directoryLength: number
		readonly recordsOffset: number
		readonly recordsLength: number
		readonly stringsOffset: number
		readonly stringsLength: number
		readonly payloadOffset: number
		readonly payloadLength: number
		readonly totalRowCount: number
		readonly indexedRowCount: number
		readonly skippedRowCount: number
		readonly populatedCellCount: number
		readonly buildElapsedMs: number
		readonly minRightAscension: Angle
		readonly maxRightAscension: Angle
		readonly minDeclination: Angle
		readonly maxDeclination: Angle
		readonly occupancyMin: number
		readonly occupancyMax: number
		readonly occupancyAverage: number
		readonly emptyCellRatio: number
		readonly strategy: ResolvedStrategy
		readonly payloadStored: boolean
	},
	directoryEntries: readonly StarCatalogCellDirectoryEntry[],
	records: readonly BuildRecord<T>[],
	sections: SerializedIndexSections,
	config: NormalizedBuildConfig<T>,
) {
	buffer.fill(0)
	buffer.write(STAR_CATALOG_INDEX_MAGIC, HEADER_MAGIC_OFFSET, 'ascii')
	buffer.writeUInt16LE(STAR_CATALOG_INDEX_VERSION, HEADER_VERSION_OFFSET)
	buffer.writeUInt8(header.strategy.code, HEADER_STRATEGY_OFFSET)
	buffer.writeUInt8((header.payloadStored ? FLAG_PAYLOAD_STORED : 0) | FLAG_SORTED_BY_RIGHT_ASCENSION, HEADER_FLAGS_OFFSET)
	buffer.writeUInt32LE(header.strategy.metadata.declinationBinCount, HEADER_DECLINATION_BIN_COUNT_OFFSET)
	buffer.writeUInt32LE(header.strategy.metadata.rightAscensionBinCount, HEADER_RIGHT_ASCENSION_BIN_COUNT_OFFSET)
	buffer.writeUInt32LE(header.strategy.totalCellCount, HEADER_TOTAL_CELL_COUNT_OFFSET)
	buffer.writeUInt32LE(header.populatedCellCount, HEADER_POPULATED_CELL_COUNT_OFFSET)
	buffer.writeUInt32LE(header.totalRowCount, HEADER_TOTAL_ROW_COUNT_OFFSET)
	buffer.writeUInt32LE(header.indexedRowCount, HEADER_INDEXED_ROW_COUNT_OFFSET)
	buffer.writeUInt32LE(header.skippedRowCount, HEADER_SKIPPED_ROW_COUNT_OFFSET)
	buffer.writeUInt32LE(header.directoryOffset, HEADER_DIRECTORY_OFFSET)
	buffer.writeUInt32LE(header.directoryLength, HEADER_DIRECTORY_LENGTH_OFFSET)
	buffer.writeUInt32LE(header.recordsOffset, HEADER_RECORDS_OFFSET)
	buffer.writeUInt32LE(header.recordsLength, HEADER_RECORDS_LENGTH_OFFSET)
	buffer.writeUInt32LE(header.stringsOffset, HEADER_STRINGS_OFFSET)
	buffer.writeUInt32LE(header.stringsLength, HEADER_STRINGS_LENGTH_OFFSET)
	buffer.writeUInt32LE(header.payloadOffset, HEADER_PAYLOAD_OFFSET)
	buffer.writeUInt32LE(header.payloadLength, HEADER_PAYLOAD_LENGTH_OFFSET)
	buffer.writeDoubleLE(header.minRightAscension, HEADER_MIN_RIGHT_ASCENSION_OFFSET)
	buffer.writeDoubleLE(header.maxRightAscension, HEADER_MAX_RIGHT_ASCENSION_OFFSET)
	buffer.writeDoubleLE(header.minDeclination, HEADER_MIN_DECLINATION_OFFSET)
	buffer.writeDoubleLE(header.maxDeclination, HEADER_MAX_DECLINATION_OFFSET)
	buffer.writeUInt32LE(header.occupancyMin, HEADER_OCCUPANCY_MIN_OFFSET)
	buffer.writeUInt32LE(header.occupancyMax, HEADER_OCCUPANCY_MAX_OFFSET)
	buffer.writeDoubleLE(header.occupancyAverage, HEADER_OCCUPANCY_AVERAGE_OFFSET)
	buffer.writeDoubleLE(header.emptyCellRatio, HEADER_EMPTY_CELL_RATIO_OFFSET)
	buffer.writeDoubleLE(header.buildElapsedMs, HEADER_BUILD_ELAPSED_MS_OFFSET)

	for (let i = 0; i < directoryEntries.length; i++) {
		const entryOffset = header.directoryOffset + i * DIRECTORY_ENTRY_SIZE
		const entry = directoryEntries[i]
		buffer.writeUInt32LE(entry.cellId, entryOffset + DIRECTORY_CELL_ID_OFFSET)
		buffer.writeUInt32LE(entry.count, entryOffset + DIRECTORY_COUNT_OFFSET)
		buffer.writeUInt32LE(entry.firstRecordIndex, entryOffset + DIRECTORY_FIRST_RECORD_INDEX_OFFSET)
		buffer.writeUInt32LE(entry.recordOffset, entryOffset + DIRECTORY_RECORD_OFFSET_OFFSET)
		buffer.writeUInt32LE(entry.recordLength, entryOffset + DIRECTORY_RECORD_LENGTH_OFFSET)
		buffer.writeDoubleLE(entry.minRightAscension, entryOffset + DIRECTORY_MIN_RIGHT_ASCENSION_OFFSET)
		buffer.writeDoubleLE(entry.maxRightAscension, entryOffset + DIRECTORY_MAX_RIGHT_ASCENSION_OFFSET)
		buffer.writeDoubleLE(entry.minDeclination, entryOffset + DIRECTORY_MIN_DECLINATION_OFFSET)
		buffer.writeDoubleLE(entry.maxDeclination, entryOffset + DIRECTORY_MAX_DECLINATION_OFFSET)
	}

	if (sections.strings.byteLength) sections.strings.copy(buffer, header.stringsOffset)
	if (sections.payload.byteLength) sections.payload.copy(buffer, header.payloadOffset)

	for (let i = 0; i < records.length; i++) {
		const recordOffset = header.recordsOffset + i * RECORD_SIZE
		const record = records[i]
		buffer.writeUInt32LE(record.rowIndex, recordOffset + RECORD_ROW_INDEX_OFFSET)
		buffer.writeDoubleLE(record.rightAscension, recordOffset + RECORD_RIGHT_ASCENSION_OFFSET)
		buffer.writeDoubleLE(record.declination, recordOffset + RECORD_DECLINATION_OFFSET)

		if (typeof record.id === 'string') {
			buffer.writeUInt8(RECORD_ID_KIND_STRING, recordOffset + RECORD_ID_KIND_OFFSET)
			buffer.writeUInt32LE(sections.stringOffsets[i], recordOffset + RECORD_ID_STRING_OFFSET)
			buffer.writeUInt32LE(sections.stringLengths[i], recordOffset + RECORD_ID_STRING_LENGTH_OFFSET)
		} else {
			buffer.writeUInt8(RECORD_ID_KIND_NUMBER, recordOffset + RECORD_ID_KIND_OFFSET)
			buffer.writeDoubleLE(record.id, recordOffset + RECORD_ID_NUMBER_OFFSET)
		}

		if (config.includePayload && record.payload !== undefined) {
			buffer.writeUInt32LE(sections.payloadOffsets[i], recordOffset + RECORD_PAYLOAD_OFFSET)
			buffer.writeUInt32LE(sections.payloadLengths[i], recordOffset + RECORD_PAYLOAD_LENGTH_OFFSET)
		}
	}
}

// Reads the fixed-size directory table from a validated buffer.
function readDirectory(buffer: Buffer, offset: number, length: number): readonly StarCatalogCellDirectoryEntry[] {
	const count = length / DIRECTORY_ENTRY_SIZE
	const entries = new Array<StarCatalogCellDirectoryEntry>(count)
	let previousCellId = -1
	let previousRecordIndex = -1

	for (let i = 0; i < count; i++) {
		const entryOffset = offset + i * DIRECTORY_ENTRY_SIZE
		const entry: StarCatalogCellDirectoryEntry = {
			cellId: buffer.readUInt32LE(entryOffset + DIRECTORY_CELL_ID_OFFSET),
			count: buffer.readUInt32LE(entryOffset + DIRECTORY_COUNT_OFFSET),
			firstRecordIndex: buffer.readUInt32LE(entryOffset + DIRECTORY_FIRST_RECORD_INDEX_OFFSET),
			recordOffset: buffer.readUInt32LE(entryOffset + DIRECTORY_RECORD_OFFSET_OFFSET),
			recordLength: buffer.readUInt32LE(entryOffset + DIRECTORY_RECORD_LENGTH_OFFSET),
			minRightAscension: buffer.readDoubleLE(entryOffset + DIRECTORY_MIN_RIGHT_ASCENSION_OFFSET),
			maxRightAscension: buffer.readDoubleLE(entryOffset + DIRECTORY_MAX_RIGHT_ASCENSION_OFFSET),
			minDeclination: buffer.readDoubleLE(entryOffset + DIRECTORY_MIN_DECLINATION_OFFSET),
			maxDeclination: buffer.readDoubleLE(entryOffset + DIRECTORY_MAX_DECLINATION_OFFSET),
		}

		if (entry.count <= 0) throw new Error('corrupted star catalog index: empty populated cell entry')
		if (entry.cellId <= previousCellId) throw new Error('corrupted star catalog index: cell directory is not strictly ordered')
		if (entry.firstRecordIndex < previousRecordIndex) throw new Error('corrupted star catalog index: record directory is not ordered')

		previousCellId = entry.cellId
		previousRecordIndex = entry.firstRecordIndex
		entries[i] = entry
	}

	return entries
}

// Validates the persisted buffer and extracts the fixed header fields.
function validateAndReadHeader(buffer: Buffer, validateIntegrity: boolean) {
	if (buffer.byteLength < HEADER_SIZE) throw new Error('corrupted star catalog index: buffer is smaller than header')
	if (buffer.toString('ascii', HEADER_MAGIC_OFFSET, HEADER_MAGIC_OFFSET + STAR_CATALOG_INDEX_MAGIC.length) !== STAR_CATALOG_INDEX_MAGIC) {
		throw new Error('corrupted star catalog index: invalid magic header')
	}

	const version = buffer.readUInt16LE(HEADER_VERSION_OFFSET)
	if (version !== STAR_CATALOG_INDEX_VERSION) throw new Error(`unsupported star catalog index version: ${version}`)

	const strategyCode = buffer.readUInt8(HEADER_STRATEGY_OFFSET)
	const flags = buffer.readUInt8(HEADER_FLAGS_OFFSET)
	const declinationBinCount = buffer.readUInt32LE(HEADER_DECLINATION_BIN_COUNT_OFFSET)
	const rightAscensionBinCount = buffer.readUInt32LE(HEADER_RIGHT_ASCENSION_BIN_COUNT_OFFSET)
	const totalCellCount = buffer.readUInt32LE(HEADER_TOTAL_CELL_COUNT_OFFSET)
	const populatedCellCount = buffer.readUInt32LE(HEADER_POPULATED_CELL_COUNT_OFFSET)
	const totalRowCount = buffer.readUInt32LE(HEADER_TOTAL_ROW_COUNT_OFFSET)
	const indexedRowCount = buffer.readUInt32LE(HEADER_INDEXED_ROW_COUNT_OFFSET)
	const skippedRowCount = buffer.readUInt32LE(HEADER_SKIPPED_ROW_COUNT_OFFSET)
	const directoryOffset = buffer.readUInt32LE(HEADER_DIRECTORY_OFFSET)
	const directoryLength = buffer.readUInt32LE(HEADER_DIRECTORY_LENGTH_OFFSET)
	const recordsOffset = buffer.readUInt32LE(HEADER_RECORDS_OFFSET)
	const recordsLength = buffer.readUInt32LE(HEADER_RECORDS_LENGTH_OFFSET)
	const stringsOffset = buffer.readUInt32LE(HEADER_STRINGS_OFFSET)
	const stringsLength = buffer.readUInt32LE(HEADER_STRINGS_LENGTH_OFFSET)
	const payloadOffset = buffer.readUInt32LE(HEADER_PAYLOAD_OFFSET)
	const payloadLength = buffer.readUInt32LE(HEADER_PAYLOAD_LENGTH_OFFSET)
	const fingerprint = buffer.readUInt32LE(HEADER_FINGERPRINT_OFFSET)
	const minRightAscension = buffer.readDoubleLE(HEADER_MIN_RIGHT_ASCENSION_OFFSET)
	const maxRightAscension = buffer.readDoubleLE(HEADER_MAX_RIGHT_ASCENSION_OFFSET)
	const minDeclination = buffer.readDoubleLE(HEADER_MIN_DECLINATION_OFFSET)
	const maxDeclination = buffer.readDoubleLE(HEADER_MAX_DECLINATION_OFFSET)
	const occupancyMin = buffer.readUInt32LE(HEADER_OCCUPANCY_MIN_OFFSET)
	const occupancyMax = buffer.readUInt32LE(HEADER_OCCUPANCY_MAX_OFFSET)
	const occupancyAverage = buffer.readDoubleLE(HEADER_OCCUPANCY_AVERAGE_OFFSET)
	const emptyCellRatio = buffer.readDoubleLE(HEADER_EMPTY_CELL_RATIO_OFFSET)
	const buildElapsedMs = buffer.readDoubleLE(HEADER_BUILD_ELAPSED_MS_OFFSET)

	if (directoryLength !== populatedCellCount * DIRECTORY_ENTRY_SIZE) throw new Error('corrupted star catalog index: directory length does not match cell count')
	if (recordsLength !== indexedRowCount * RECORD_SIZE) throw new Error('corrupted star catalog index: record length does not match record count')
	if (directoryOffset !== HEADER_SIZE) throw new Error('corrupted star catalog index: directory offset is invalid')
	if (recordsOffset !== directoryOffset + directoryLength) throw new Error('corrupted star catalog index: records section offset is invalid')
	if (stringsOffset !== recordsOffset + recordsLength) throw new Error('corrupted star catalog index: string section offset is invalid')
	if (payloadOffset !== stringsOffset + stringsLength) throw new Error('corrupted star catalog index: payload section offset is invalid')
	if (payloadOffset + payloadLength !== buffer.byteLength) throw new Error('corrupted star catalog index: file length does not match sections')
	if (indexedRowCount + skippedRowCount !== totalRowCount) throw new Error('corrupted star catalog index: row accounting does not match')
	if (totalCellCount < populatedCellCount) throw new Error('corrupted star catalog index: populated cells exceed total cells')
	if (validateIntegrity && hashCatalogBuffer(buffer) !== fingerprint) throw new Error('corrupted star catalog index: fingerprint mismatch')

	return {
		flags,
		totalCellCount,
		populatedCellCount,
		totalRowCount,
		indexedRowCount,
		skippedRowCount,
		directoryOffset,
		directoryLength,
		recordsOffset,
		recordsLength,
		stringsOffset,
		stringsLength,
		payloadOffset,
		payloadLength,
		fingerprint,
		minRightAscension,
		maxRightAscension,
		minDeclination,
		maxDeclination,
		occupancyMin,
		occupancyMax,
		occupancyAverage,
		emptyCellRatio,
		buildElapsedMs,
		declinationBinCount,
		rightAscensionBinCount,
		strategyType: strategyTypeFromCode(strategyCode),
	}
}

// Hashes the persisted buffer while treating the fingerprint field as zero.
function hashCatalogBuffer(buffer: Buffer) {
	let hash = HASH_BASIS

	for (let i = 0; i < buffer.byteLength; i++) {
		const value = i >= HEADER_FINGERPRINT_OFFSET && i < HEADER_FINGERPRINT_OFFSET + 4 ? 0 : buffer[i]
		hash ^= value
		hash = Math.imul(hash, HASH_PRIME) >>> 0
	}

	return hash >>> 0
}

// Collects only populated directory entries for a sorted list of candidate cell ids.
function materializeCandidateCells(directory: readonly StarCatalogCellDirectoryEntry[], cellIds: readonly number[]): readonly StarCatalogCellDirectoryEntry[] {
	const matches: StarCatalogCellDirectoryEntry[] = []

	for (let i = 0; i < cellIds.length; i++) {
		const entry = findDirectoryEntry(directory, cellIds[i])
		if (entry !== undefined) matches.push(entry)
	}

	return matches
}

// Locates one cell entry through binary search.
function findDirectoryEntry(directory: readonly StarCatalogCellDirectoryEntry[], cellId: number): StarCatalogCellDirectoryEntry | undefined {
	let lo = 0
	let hi = directory.length - 1

	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const entry = directory[mid]
		if (entry.cellId === cellId) return entry
		if (entry.cellId < cellId) lo = mid + 1
		else hi = mid - 1
	}

	return undefined
}

// Normalizes raw RA values to [0, 2π).
function normalizeCoordinateValue(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? normalizeAngle(value) : undefined
}

// Validates declination while tolerating microscopic pole-rounding errors.
function normalizeDeclinationValue(value: unknown) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
	if (value < -PIOVERTWO - DECLINATION_EPSILON || value > PIOVERTWO + DECLINATION_EPSILON) return undefined
	if (value <= -PIOVERTWO) return -PIOVERTWO
	if (value >= PIOVERTWO) return PIOVERTWO
	return value
}

// Maps declination into a stable inclusive band index.
function declinationBin(declination: Angle, count: number) {
	const normalized = Math.min(PI - Number.EPSILON, Math.max(0, declination + PIOVERTWO))
	return Math.min(count - 1, Math.floor((normalized / PI) * count))
}

// Maps right ascension into a stable grid bin.
function rightAscensionBin(rightAscension: Angle, count: number) {
	const normalized = normalizeAngle(rightAscension)
	return Math.min(count - 1, Math.floor((normalized / TAU) * count))
}

// Computes a conservative RA half-width for a cone intersecting a declination span.
function coneRightAscensionHalfWidth(radius: Angle, minDeclination: Angle, maxDeclination: Angle) {
	if (radius >= PI) return PI
	const limit = Math.min(PIOVERTWO, Math.max(Math.abs(minDeclination), Math.abs(maxDeclination)))
	const cosLimit = Math.cos(limit)
	const sinRadius = Math.sin(radius)
	if (cosLimit <= sinRadius) return PI
	return Math.min(PI, Math.asin(Math.min(1, sinRadius / Math.max(1e-15, cosLimit))))
}

// Converts a center RA plus half-width into one or two normalized windows.
function coneRightAscensionWindows(center: Angle, halfWidth: Angle): readonly RightAscensionWindow[] {
	if (halfWidth >= PI) return FULL_RIGHT_ASCENSION_WINDOWS
	const min = center - halfWidth
	const max = center + halfWidth

	if (min < 0) {
		return [
			{ min: 0, max },
			{ min: TAU + min, max: TAU },
		]
	}

	if (max > TAU) {
		return [
			{ min: 0, max: max - TAU },
			{ min, max: TAU },
		]
	}

	return [{ min, max }]
}

// Normalizes a rectangular RA range into one or two windows.
function normalizeRightAscensionWindows(minRightAscension: Angle, maxRightAscension: Angle): readonly RightAscensionWindow[] {
	const normalizedMin = normalizeAngle(minRightAscension)
	const normalizedMax = normalizeAngle(maxRightAscension)
	if (Math.abs(maxRightAscension - minRightAscension) >= TAU) return FULL_RIGHT_ASCENSION_WINDOWS
	if (normalizedMin <= normalizedMax) return [{ min: normalizedMin, max: normalizedMax }]
	return [
		{ min: 0, max: normalizedMax },
		{ min: normalizedMin, max: TAU },
	]
}

// Appends all grid cells overlapped by normalized RA windows for one declination band.
function pushWindowCells(out: number[], declinationBinIndex: number, rightAscensionBinCount: number, windows: readonly RightAscensionWindow[]) {
	for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
		const window = windows[windowIndex]
		const first = rightAscensionBin(window.min, rightAscensionBinCount)
		const inclusiveMax = window.max >= TAU ? TAU - 1e-12 : Math.max(window.min, window.max - 1e-12)
		const last = rightAscensionBin(inclusiveMax, rightAscensionBinCount)

		for (let raBin = first; raBin <= last; raBin++) {
			out.push(declinationBinIndex * rightAscensionBinCount + raBin)
		}
	}
}

// Sorts and deduplicates candidate cell ids.
function uniqueSortedCells(cells: readonly number[]) {
	if (cells.length <= 1) return [...cells]
	const sorted = [...cells].sort(NumberComparator)
	const unique = new Array<number>(sorted.length)
	let used = 0
	let previous = -1

	for (let i = 0; i < sorted.length; i++) {
		const value = sorted[i]
		if (i > 0 && value === previous) continue
		previous = value
		unique[used++] = value
	}

	unique.length = used
	return unique
}

// Evaluates exact spherical cone inclusion with the haversine formula.
function coneContains(centerRightAscension: Angle, centerDeclination: Angle, rightAscension: Angle, declination: Angle, radius: Angle) {
	const deltaDeclination = (declination - centerDeclination) * 0.5
	const deltaRightAscension = angularDifference(rightAscension, centerRightAscension) * 0.5
	const sinDeclination = Math.sin(deltaDeclination)
	const sinRightAscension = Math.sin(deltaRightAscension)
	const hav = sinDeclination * sinDeclination + Math.cos(centerDeclination) * Math.cos(declination) * sinRightAscension * sinRightAscension
	const limit = Math.sin(radius * 0.5)
	return hav <= limit * limit + 1e-15
}

// Normalizes an angular difference into [-π, π].
function angularDifference(a: Angle, b: Angle) {
	let delta = normalizeAngle(a) - normalizeAngle(b)
	if (delta > PI) delta -= TAU
	else if (delta < -PI) delta += TAU
	return delta
}

// Validates a user-provided query coordinate.
function validateQueryCoordinate(rightAscension: Angle, declination: Angle) {
	if (!Number.isFinite(rightAscension) || !Number.isFinite(declination)) throw new Error('invalid query coordinate')
	if (declination < -PIOVERTWO || declination > PIOVERTWO) throw new Error('declination is outside [-π/2, +π/2]')
}

// Validates a non-negative cone radius.
function validateSearchRadius(radius: Angle) {
	if (!Number.isFinite(radius) || radius < 0) throw new Error('cone radius must be a finite non-negative angle')
}

// Validates an inclusive declination range.
function validateDeclinationRange(minDeclination: Angle, maxDeclination: Angle) {
	if (!Number.isFinite(minDeclination) || !Number.isFinite(maxDeclination)) throw new Error('declination range must be finite')
	if (minDeclination > maxDeclination) throw new Error('declination range is inverted')
	if (minDeclination < -PIOVERTWO || maxDeclination > PIOVERTWO) throw new Error('declination range is outside [-π/2, +π/2]')
}

// Converts supported binary inputs into an owned buffer.
function toBuffer(input: Buffer | Uint8Array | ArrayBuffer | Source) {
	if (Buffer.isBuffer(input)) return input
	if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
	if (input instanceof ArrayBuffer) return Buffer.from(input)
	return readSourceFully(input)
}

// Reads an entire generic source into memory.
async function readSourceFully(source: Source) {
	const chunks: Buffer[] = []
	const scratch = Buffer.allocUnsafe(65536)
	let total = 0

	while (true) {
		const read = await source.read(scratch)
		if (!read) break
		const chunk = Buffer.from(scratch.subarray(0, read))
		chunks.push(chunk)
		total += chunk.byteLength
	}

	return Buffer.concat(chunks, total)
}

// Normalizes a payload buffer so persisted writes are deterministic.
function toOwnedBuffer(buffer: Buffer | Uint8Array) {
	return Buffer.isBuffer(buffer) ? Buffer.from(buffer) : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

// Maps persisted strategy codes back to public strategy names.
function strategyTypeFromCode(code: number): StarCatalogSpatialIndexStrategyType {
	switch (code) {
		case STRATEGY_DECLINATION_BINS:
			return 'declination-bins'
		case STRATEGY_EQUIRECTANGULAR_GRID:
			return 'equirectangular-grid'
		default:
			throw new Error(`unsupported persisted star catalog strategy code: ${code}`)
	}
}

// Renders the persisted fingerprint in stable hexadecimal form.
function toHexFingerprint(fingerprint: number) {
	return fingerprint.toString(16).padStart(8, '0')
}

// Sorts build records by cell and then by normalized sky position.
function BuildRecordComparator<T>(a: BuildRecord<T>, b: BuildRecord<T>) {
	if (a.cellId !== b.cellId) return a.cellId - b.cellId
	if (a.rightAscension !== b.rightAscension) return a.rightAscension - b.rightAscension
	if (a.declination !== b.declination) return a.declination - b.declination
	if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex
	if (typeof a.id === 'number' && typeof b.id === 'number') return a.id - b.id
	return `${a.id}`.localeCompare(`${b.id}`)
}

function NumberComparator(a: number, b: number) {
	return a - b
}

// Validates and clamps positive integer configuration values.
function clampPositiveInteger(value: number, min: number, max: number, name: string) {
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
	const integer = Math.trunc(value)
	if (integer < min || integer > max) throw new Error(`${name} must be in [${min}, ${max}]`)
	return integer
}
