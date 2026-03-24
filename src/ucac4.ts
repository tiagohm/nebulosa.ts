import type { Stats } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import { join } from 'path'
import { type Angle, mas } from './angle'
import { DEG2RAD, PIOVERTWO } from './constants'
import {
	BaseStarCatalog,
	type CatalogQueryResult,
	type CatalogQueryStatsAccumulator,
	type NormalizedStarCatalogQuery,
	type StarCatalogCapabilities,
	StarCatalogDataError,
	type StarCatalogEntry,
	type StarCatalogMetadata,
	type StarCatalogQuery,
	StarCatalogQueryError,
	StarCatalogStorageError,
	validateDec,
} from './star.catalog'

const UCAC4_RECORD_SIZE = 78
const UCAC4_ZONE_COUNT = 900
const UCAC4_ZONE_HEIGHT = 0.2 * DEG2RAD
const UCAC4_INDEX_BIN_COUNT = 1440
const UCAC4_INDEX_BIN_SIZE = 0.25 * DEG2RAD
const UCAC4_SPD_OFFSET_MAS = 324000000
const UCAC4_MISSING_MAG_MMAG = 20000
const UCAC4_MISSING_MAG_ERROR = 99
const UCAC4_PM_SENTINEL = 32767
const UCAC4_PM_NO_DATA = 255
const UCAC4_BLOCK_RECORD_COUNT = 512
const UCAC4_ID_PREFIX = '4U'
const MAS_PER_DEG = 3600000
const GEOMETRY_EPSILON = 1e-12
const FULL_CIRCLE_MAS = 360 * MAS_PER_DEG

const UCAC4_CAPABILITIES: StarCatalogCapabilities = {
	featureNames: ['cone', 'box', 'polygon', 'streaming', 'raw-access', 'magnitude-filter', 'quality-filter', 'projection', 'epoch-propagation'],
	queryTypes: ['cone', 'box', 'polygon'],
	efficientQueryTypes: ['cone', 'box', 'polygon'],
	supportsStreaming: true,
	supportsRawAccess: true,
	supportsMagnitudeFilter: true,
	supportsQualityFilter: true,
	supportsProjection: true,
	supportsEpochPropagation: true,
}

const UCAC4_METADATA: StarCatalogMetadata = {
	catalogName: 'UCAC4',
	catalogVersion: '4',
	referenceEpoch: 2000,
	referenceFrame: 'ICRS',
	magnitudeSystems: ['UCAC', '2MASS', 'APASS'],
	angularUnits: 'rad',
	properMotionAvailability: 'partial',
	photometricFields: ['UCAC model', 'UCAC aperture', '2MASS J/H/Ks', 'APASS B/V/g/r/i'],
	sourceIdentifierFormat: '4U###-record',
	storageLayout: '78-byte fixed-length records split into 900 declination zones',
	zoneIndex: 'Uses native UCAC4 declination zones and optional u4index.unf quarter-degree RA index',
	supportedQueryTypes: ['cone', 'box', 'polygon'],
	normalizedFieldAvailability: {
		always: ['id', 'ra', 'dec', 'epoch', 'sourceCatalog'],
		optional: ['pmRaMasYr', 'pmDecMasYr', 'mag', 'magBand', 'magBands', 'positionErrorMas', 'properMotionError', 'flags', 'raw', 'extras'],
	},
	notes: [
		'Regional queries use zone-based coarse preselection and exact filtering in the generic catalog layer.',
		'RA wrap-around near 0/360 degrees is handled both for box splitting and indexed range lookup.',
		'Cone and box filtering use spherical geometry; polygon filtering uses a documented tangent-plane approximation best suited to smaller fields.',
		'Normalized pmRaMasYr is derived from UCAC4 pmRA*cos(dec) when cos(dec) is numerically stable; the original raw component is preserved in extras.',
		'Without u4index.unf the provider falls back to lazy full-zone streaming with exact rejection, avoiding whole-catalog loading.',
	],
}

const UCAC4_ID_PATTERN = /^(?:4U|UCAC4[:\s]?)(\d{1,3})[-:](\d+)$/i

export interface Ucac4CatalogSource {
	readonly root: string
}

export interface Ucac4RawRecord {
	readonly zone: number
	readonly recordNumber: number
	readonly raMas: number
	readonly southPoleDistanceMas: number
	readonly modelMagnitudeMillimag: number
	readonly apertureMagnitudeMillimag: number
	readonly magnitudeErrorCentimag: number
	readonly objectType: number
	readonly combinedDoubleStarFlag: number
	readonly raSigmaMas: number
	readonly decSigmaMas: number
	readonly imageCount: number
	readonly usedImageCount: number
	readonly properMotionCatalogCount: number
	readonly centralEpochRaYear: number
	readonly centralEpochDecYear: number
	readonly pmRaCosDecMasYrTenth: number
	readonly pmDecMasYrTenth: number
	readonly pmRaErrorMasYr: number | undefined
	readonly pmDecErrorMasYr: number | undefined
	readonly twoMassId: number
	readonly twoMassMagnitudeMillimag: readonly [number, number, number]
	readonly twoMassQualityFlags: readonly [number, number, number]
	readonly twoMassErrorCentimag: readonly [number, number, number]
	readonly apassMagnitudeMillimag: readonly [number, number, number, number, number]
	readonly apassErrorCentimag: readonly [number, number, number, number, number]
	readonly yaleSpmFlag: number
	readonly mergedCatalogFlags: readonly [number, number, number, number, number, number, number, number, number]
	readonly ledaFlag: number
	readonly twoMassExtendedSourceFlag: number
	readonly uniqueStarNumber: number
	readonly ucac2Zone: number
	readonly ucac2RecordNumber: number
}

export interface Ucac4BenchmarkResult {
	readonly iterations: number
	readonly minMs: number
	readonly maxMs: number
	readonly meanMs: number
	readonly resultCount: number
}

interface Ucac4Index {
	readonly starts: Int32Array
	readonly counts: Int32Array
	readonly base: 0 | 1
}

// Formats a stable UCAC4 identifier.
export function formatUcac4Id(zone: number, recordNumber: number) {
	validateZoneNumber(zone)
	validateRecordNumber(recordNumber)
	return `${UCAC4_ID_PREFIX}${`${zone}`.padStart(3, '0')}-${recordNumber}`
}

// Parses a stable UCAC4 identifier into zone and record components.
export function parseUcac4Id(id: string): readonly [number, number] {
	const match = UCAC4_ID_PATTERN.exec(id.trim())

	if (!match) {
		throw new StarCatalogQueryError(`invalid UCAC4 identifier: ${id}`)
	}

	const zone = +match[1]
	const recordNumber = +match[2]
	validateZoneNumber(zone)
	validateRecordNumber(recordNumber)
	return [zone, recordNumber] as const
}

// Converts a declination to its native UCAC4 zone number.
export function ucac4ZoneForDec(dec: Angle) {
	const normalizedDec = validateDec(dec)
	if (normalizedDec >= PIOVERTWO) return UCAC4_ZONE_COUNT
	return Math.floor((normalizedDec + PIOVERTWO) / UCAC4_ZONE_HEIGHT) + 1
}

// Creates and opens a UCAC4 catalog in one step.
export async function openUcac4Catalog(source: string | Ucac4CatalogSource) {
	return await new Ucac4Catalog().open(source)
}

// Reads native UCAC4 zone files lazily and exposes them through the generic catalog contract.
export class Ucac4Catalog extends BaseStarCatalog {
	readonly #zonePaths = new Map<number, string | null>()
	readonly #zoneHandles = new Map<number, FileHandle>()
	readonly #zoneRecordCounts = new Int32Array(UCAC4_ZONE_COUNT)

	#root = ''
	#index?: Ucac4Index
	#opened = false

	constructor() {
		super()
		this.#zoneRecordCounts.fill(-1)
	}

	// Returns the generic UCAC4 metadata block.
	metadata(): StarCatalogMetadata {
		return UCAC4_METADATA
	}

	// Returns the generic UCAC4 capability description.
	capabilities(): StarCatalogCapabilities {
		return UCAC4_CAPABILITIES
	}

	// Opens a UCAC4 storage root and eagerly loads the optional native index when available.
	async open(source: string | Ucac4CatalogSource): Promise<this> {
		const root = typeof source === 'string' ? source : source.root

		if (!root) {
			throw new StarCatalogStorageError('missing UCAC4 root directory')
		}

		try {
			const stat = await fs.stat(root)
			if (!stat.isDirectory()) throw new StarCatalogStorageError(`UCAC4 root is not a directory: ${root}`)
		} catch (error) {
			throw new StarCatalogStorageError(`unable to access UCAC4 root: ${root}`, error)
		}

		this.#root = root
		this.#index = await this.loadNativeIndex()
		this.#opened = await this.hasAnyZoneFile()

		if (!this.#opened) {
			throw new StarCatalogStorageError(`no UCAC4 zone files were found under ${root}`)
		}

		return this
	}

	// Closes any cached zone handles.
	async close(): Promise<void> {
		const handles = [...this.#zoneHandles.values()]
		this.#zoneHandles.clear()
		this.#zonePaths.clear()
		this.#zoneRecordCounts.fill(-1)
		this.#index = undefined
		this.#opened = false

		for (const handle of handles) {
			await handle.close()
		}
	}

	// Returns a raw UCAC4 record by identifier.
	async getRawById(id: string): Promise<Ucac4RawRecord | undefined> {
		const [zone, recordNumber] = parseUcac4Id(id)
		return await this.readRawRecord(zone, recordNumber)
	}

	// Returns a raw UCAC4 record by native zone and record number.
	async readRawRecord(zone: number, recordNumber: number): Promise<Ucac4RawRecord | undefined> {
		this.assertOpen()
		validateZoneNumber(zone)
		validateRecordNumber(recordNumber)

		const recordCount = await this.ensureZoneRecordCount(zone)
		if (recordNumber > recordCount) return undefined

		const handle = await this.openZoneHandle(zone)
		const buffer = Buffer.allocUnsafe(UCAC4_RECORD_SIZE)

		try {
			const { bytesRead } = await handle.read(buffer, 0, UCAC4_RECORD_SIZE, (recordNumber - 1) * UCAC4_RECORD_SIZE)
			if (bytesRead !== UCAC4_RECORD_SIZE) {
				throw new StarCatalogStorageError(`short UCAC4 read for zone ${zone}, record ${recordNumber}`)
			}
		} catch (error) {
			if (error instanceof StarCatalogStorageError) throw error
			throw new StarCatalogStorageError(`unable to read UCAC4 zone ${zone}, record ${recordNumber}`, error)
		}

		return parseUcac4Record(buffer, zone, recordNumber)
	}

	// Streams candidate entries from the zone files touched by the coarse preselection boxes.
	protected async *streamCandidateEntries(query: NormalizedStarCatalogQuery, stats: CatalogQueryStatsAccumulator): AsyncIterable<StarCatalogEntry> {
		this.assertOpen()

		const zoneNumbers = touchedZones(query)

		for (const zone of zoneNumbers) {
			const ranges = await this.zoneRangesForQuery(zone, query, stats)
			if (!ranges.length) continue

			stats.zonesTouched = (stats.zonesTouched ?? 0) + 1

			for (const [startRecord, endRecord] of ranges) {
				yield* this.streamZoneRange(zone, startRecord, endRecord, query.includeRaw, stats)
			}
		}
	}

	// Looks up a normalized entry by native identifier.
	protected async getEntryByIdInternal(catalogObjectId: string, includeRaw: boolean): Promise<StarCatalogEntry | undefined> {
		const raw = await this.getRawById(catalogObjectId)
		return raw ? normalizeUcac4Entry(raw, includeRaw) : undefined
	}

	// Estimates candidate counts using the native index when available.
	protected async estimateCandidateCount(query: NormalizedStarCatalogQuery): Promise<number | undefined> {
		this.assertOpen()

		let total = 0

		for (const zone of touchedZones(query)) {
			if (!(await this.ensureZoneRecordCount(zone))) continue

			if (!this.#index) {
				if (zoneIntersectsQuery(zone, query)) {
					total += await this.ensureZoneRecordCount(zone)
				}

				continue
			}

			for (const [startRecord, endRecord] of await this.zoneRangesForQuery(zone, query)) {
				total += endRecord - startRecord + 1
			}
		}

		return total
	}

	// Ensures the catalog has been opened before any I/O starts.
	private assertOpen() {
		if (!this.#opened) {
			throw new StarCatalogStorageError('UCAC4 catalog is not open')
		}
	}

	// Detects whether at least one zone file exists under the configured root.
	private async hasAnyZoneFile() {
		for (let zone = 1; zone <= UCAC4_ZONE_COUNT; zone++) {
			if (await this.resolveZonePath(zone)) return true
		}

		return false
	}

	// Loads the optional native u4index.unf quarter-degree index.
	private async loadNativeIndex(): Promise<Ucac4Index | undefined> {
		const candidates = [join(this.#root, 'u4index.unf'), join(this.#root, 'u4i', 'u4index.unf')]

		for (const candidate of candidates) {
			let data: Buffer

			try {
				data = await fs.readFile(candidate)
			} catch {
				continue
			}

			const expectedSize = UCAC4_ZONE_COUNT * UCAC4_INDEX_BIN_COUNT * 4 * 2

			if (data.byteLength !== expectedSize) {
				throw new StarCatalogDataError(`corrupt UCAC4 index file: ${candidate}`)
			}

			const totalValues = UCAC4_ZONE_COUNT * UCAC4_INDEX_BIN_COUNT
			const starts = new Int32Array(totalValues)
			const counts = new Int32Array(totalValues)
			let minStart = Number.POSITIVE_INFINITY

			for (let i = 0; i < totalValues; i++) {
				starts[i] = data.readInt32LE(i * 4)
				counts[i] = data.readInt32LE((totalValues + i) * 4)

				if (counts[i] > 0 && starts[i] < minStart) {
					minStart = starts[i]
				}
			}

			return { starts, counts, base: minStart === 0 ? 0 : 1 }
		}

		return undefined
	}

	// Resolves a zone file path across the common UCAC4 directory layouts.
	private async resolveZonePath(zone: number): Promise<string | undefined> {
		const cached = this.#zonePaths.get(zone)
		if (cached !== undefined) return cached || undefined

		const fileName = `z${`${zone}`.padStart(3, '0')}`
		const candidates = [join(this.#root, fileName), join(this.#root, 'u4b', fileName), join(this.#root, 'u4s', fileName), join(this.#root, 'u4n', fileName)]

		for (const candidate of candidates) {
			try {
				const stat = await fs.stat(candidate)

				if (stat.isFile()) {
					this.#zonePaths.set(zone, candidate)
					return candidate
				}
			} catch {
				//
			}
		}

		this.#zonePaths.set(zone, null)
		return undefined
	}

	// Returns the number of 78-byte records in a zone file.
	private async ensureZoneRecordCount(zone: number) {
		const cached = this.#zoneRecordCounts[zone - 1]
		if (cached >= 0) return cached

		const zonePath = await this.resolveZonePath(zone)
		if (!zonePath) {
			this.#zoneRecordCounts[zone - 1] = 0
			return 0
		}

		let stat: Stats

		try {
			stat = await fs.stat(zonePath)
		} catch (error) {
			throw new StarCatalogStorageError(`unable to stat UCAC4 zone file: ${zonePath}`, error)
		}

		if (stat.size % UCAC4_RECORD_SIZE !== 0) {
			throw new StarCatalogDataError(`invalid UCAC4 zone size for ${zonePath}`)
		}

		const count = stat.size / UCAC4_RECORD_SIZE
		this.#zoneRecordCounts[zone - 1] = count
		return count
	}

	// Opens a zone file lazily and caches the handle for future reads.
	private async openZoneHandle(zone: number): Promise<FileHandle> {
		const cached = this.#zoneHandles.get(zone)
		if (cached) return cached

		const zonePath = await this.resolveZonePath(zone)
		if (!zonePath) {
			throw new StarCatalogStorageError(`missing UCAC4 zone file for zone ${zone}`)
		}

		try {
			const handle = await fs.open(zonePath, 'r')
			this.#zoneHandles.set(zone, handle)
			return handle
		} catch (error) {
			throw new StarCatalogStorageError(`unable to open UCAC4 zone file: ${zonePath}`, error)
		}
	}

	// Computes the candidate record ranges touched by a query inside a single zone.
	private async zoneRangesForQuery(zone: number, query: NormalizedStarCatalogQuery, stats?: CatalogQueryStatsAccumulator) {
		if (!zoneIntersectsQuery(zone, query)) return [] as (readonly [number, number])[]

		const recordCount = await this.ensureZoneRecordCount(zone)
		if (recordCount <= 0) return [] as (readonly [number, number])[]

		if (!this.#index) {
			if (stats) {
				stats.coarsePreselection = true
				stats.usedSpatialIndex = false
			}

			return [[1, recordCount]] as const
		}

		if (stats) {
			stats.coarsePreselection = true
			stats.usedSpatialIndex = true
		}

		const ranges: (readonly [number, number])[] = []

		for (const box of query.preselectionBoxes) {
			if (!zoneIntersectsDecBox(zone, box.minDec, box.maxDec)) continue

			const binStart = clampIndex(Math.floor(box.minRa / UCAC4_INDEX_BIN_SIZE), 0, UCAC4_INDEX_BIN_COUNT - 1)
			const binEnd = clampIndex(Math.floor(Math.max(box.maxRa - GEOMETRY_EPSILON, 0) / UCAC4_INDEX_BIN_SIZE), 0, UCAC4_INDEX_BIN_COUNT - 1)

			for (let bin = binStart; bin <= binEnd; bin++) {
				const index = (zone - 1) * UCAC4_INDEX_BIN_COUNT + bin
				const count = this.#index.counts[index]
				if (count <= 0) continue

				const startRecord = this.#index.starts[index] + (this.#index.base === 0 ? 1 : 0)
				ranges.push([startRecord, startRecord + count - 1] as const)
			}
		}

		return mergeRanges(ranges, recordCount)
	}

	// Streams a contiguous zone-record range in fixed-size blocks.
	private async *streamZoneRange(zone: number, startRecord: number, endRecord: number, includeRaw: boolean, stats: CatalogQueryStatsAccumulator): AsyncIterable<StarCatalogEntry> {
		const handle = await this.openZoneHandle(zone)
		const block = Buffer.allocUnsafe(UCAC4_BLOCK_RECORD_COUNT * UCAC4_RECORD_SIZE)

		let recordNumber = startRecord

		while (recordNumber <= endRecord) {
			const batchCount = Math.min(UCAC4_BLOCK_RECORD_COUNT, endRecord - recordNumber + 1)
			const bytesToRead = batchCount * UCAC4_RECORD_SIZE

			let bytesRead: number

			try {
				bytesRead = (await handle.read(block, 0, bytesToRead, (recordNumber - 1) * UCAC4_RECORD_SIZE)).bytesRead
			} catch (error) {
				throw new StarCatalogStorageError(`unable to read UCAC4 zone ${zone}`, error)
			}

			if (bytesRead !== bytesToRead) {
				throw new StarCatalogStorageError(`short UCAC4 block read in zone ${zone}`)
			}

			stats.bytesRead = (stats.bytesRead ?? 0) + bytesRead

			for (let offset = 0; offset < bytesRead; offset += UCAC4_RECORD_SIZE) {
				const raw = parseUcac4Record(block, zone, recordNumber, offset)
				stats.recordsScanned = (stats.recordsScanned ?? 0) + 1
				yield normalizeUcac4Entry(raw, includeRaw)
				recordNumber++
			}
		}
	}
}

// Benchmarks repeated UCAC4 region queries using the current provider state.
export async function benchmarkUcac4Query(catalog: Ucac4Catalog, query: StarCatalogQuery, iterations: number = 5): Promise<Ucac4BenchmarkResult> {
	if (!Number.isInteger(iterations) || iterations < 1) {
		throw new StarCatalogQueryError(`invalid benchmark iteration count: ${iterations}`)
	}

	const durations: number[] = []
	let resultCount = 0

	for (let i = 0; i < iterations; i++) {
		const start = performance.now()
		const result: CatalogQueryResult = await catalog.queryRegion(query)
		durations.push(performance.now() - start)
		resultCount = result.items.length
	}

	return {
		iterations,
		minMs: Math.min(...durations),
		maxMs: Math.max(...durations),
		meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
		resultCount,
	}
}

// Parses a fixed-length native UCAC4 record from a block buffer.
function parseUcac4Record(buffer: Buffer, zone: number, recordNumber: number, offset: number = 0): Ucac4RawRecord {
	const raMas = buffer.readInt32LE(offset)
	const southPoleDistanceMas = buffer.readInt32LE(offset + 4)

	if (raMas < 0 || raMas >= FULL_CIRCLE_MAS || southPoleDistanceMas < 0 || southPoleDistanceMas > 2 * UCAC4_SPD_OFFSET_MAS) {
		throw new StarCatalogDataError(`invalid UCAC4 coordinates in zone ${zone}, record ${recordNumber}`)
	}

	const mergedCatalogFlags = decodeMergedCatalogFlags(buffer.readInt32LE(offset + 62))

	return {
		zone,
		recordNumber,
		raMas,
		southPoleDistanceMas,
		modelMagnitudeMillimag: buffer.readInt16LE(offset + 8),
		apertureMagnitudeMillimag: buffer.readInt16LE(offset + 10),
		magnitudeErrorCentimag: buffer.readInt8(offset + 12),
		objectType: buffer.readUInt8(offset + 13),
		combinedDoubleStarFlag: buffer.readUInt8(offset + 14),
		raSigmaMas: decodeOffsetByte(buffer.readInt8(offset + 15)),
		decSigmaMas: decodeOffsetByte(buffer.readInt8(offset + 16)),
		imageCount: buffer.readUInt8(offset + 17),
		usedImageCount: buffer.readUInt8(offset + 18),
		properMotionCatalogCount: buffer.readUInt8(offset + 19),
		centralEpochRaYear: 1900 + buffer.readInt16LE(offset + 20) / 100,
		centralEpochDecYear: 1900 + buffer.readInt16LE(offset + 22) / 100,
		pmRaCosDecMasYrTenth: buffer.readInt16LE(offset + 24),
		pmDecMasYrTenth: buffer.readInt16LE(offset + 26),
		pmRaErrorMasYr: decodeProperMotionError(decodeOffsetByte(buffer.readInt8(offset + 28))),
		pmDecErrorMasYr: decodeProperMotionError(decodeOffsetByte(buffer.readInt8(offset + 29))),
		twoMassId: buffer.readInt32LE(offset + 30),
		twoMassMagnitudeMillimag: [buffer.readInt16LE(offset + 34), buffer.readInt16LE(offset + 36), buffer.readInt16LE(offset + 38)] as const,
		twoMassQualityFlags: [buffer.readUInt8(offset + 40), buffer.readUInt8(offset + 41), buffer.readUInt8(offset + 42)] as const,
		twoMassErrorCentimag: [buffer.readUInt8(offset + 43), buffer.readUInt8(offset + 44), buffer.readUInt8(offset + 45)] as const,
		apassMagnitudeMillimag: [buffer.readInt16LE(offset + 46), buffer.readInt16LE(offset + 48), buffer.readInt16LE(offset + 50), buffer.readInt16LE(offset + 52), buffer.readInt16LE(offset + 54)] as const,
		apassErrorCentimag: [buffer.readInt8(offset + 56), buffer.readInt8(offset + 57), buffer.readInt8(offset + 58), buffer.readInt8(offset + 59), buffer.readInt8(offset + 60)] as const,
		yaleSpmFlag: buffer.readUInt8(offset + 61),
		mergedCatalogFlags,
		ledaFlag: buffer.readUInt8(offset + 66),
		twoMassExtendedSourceFlag: buffer.readUInt8(offset + 67),
		uniqueStarNumber: buffer.readInt32LE(offset + 68),
		ucac2Zone: buffer.readInt16LE(offset + 72),
		ucac2RecordNumber: buffer.readInt32LE(offset + 74),
	}
}

// Converts a raw UCAC4 record into the normalized cross-catalog entry shape.
function normalizeUcac4Entry(raw: Ucac4RawRecord, includeRaw: boolean): StarCatalogEntry {
	const ra = mas(raw.raMas)
	const dec = mas(raw.southPoleDistanceMas - UCAC4_SPD_OFFSET_MAS)
	const cosDec = Math.cos(dec)
	const rawPmRaCosDecMasYr = raw.pmRaCosDecMasYrTenth === UCAC4_PM_SENTINEL ? undefined : raw.pmRaCosDecMasYrTenth / 10
	const rawPmDecMasYr = raw.pmDecMasYrTenth === UCAC4_PM_SENTINEL ? undefined : raw.pmDecMasYrTenth / 10
	const hasPm = raw.pmRaErrorMasYr !== undefined && raw.pmDecErrorMasYr !== undefined && rawPmRaCosDecMasYr !== undefined && rawPmDecMasYr !== undefined
	const pmRaMasYr = hasPm && Math.abs(cosDec) > 1e-9 ? rawPmRaCosDecMasYr! / cosDec : undefined
	const pmDecMasYr = hasPm ? rawPmDecMasYr : undefined
	const magBands = buildMagnitudeBands(raw)
	const primaryMagnitude = pickPrimaryMagnitude(raw)
	const extras: Record<string, unknown> = {
		ucacModelMagnitude: decodeMagnitude(raw.modelMagnitudeMillimag),
		ucacApertureMagnitude: decodeMagnitude(raw.apertureMagnitudeMillimag),
		centralEpochRaYear: raw.centralEpochRaYear,
		centralEpochDecYear: raw.centralEpochDecYear,
		pmRaCosDecMasYr: rawPmRaCosDecMasYr,
		twoMassId: raw.twoMassId || undefined,
		ucac2Match: raw.ucac2Zone > 0 ? { zone: raw.ucac2Zone, recordNumber: raw.ucac2RecordNumber } : undefined,
		apassErrorCentimag: raw.apassErrorCentimag,
		twoMassQualityFlags: raw.twoMassQualityFlags,
		twoMassErrorCentimag: raw.twoMassErrorCentimag,
		mergedCatalogFlags: raw.mergedCatalogFlags,
	}

	if (!hasPm) {
		extras.missingProperMotion = true
	}

	if (raw.pmRaCosDecMasYrTenth === UCAC4_PM_SENTINEL || raw.pmDecMasYrTenth === UCAC4_PM_SENTINEL) {
		extras.highProperMotionSupplementRequired = true
	}

	return {
		id: formatUcac4Id(raw.zone, raw.recordNumber),
		ra,
		dec,
		epoch: 2000,
		pmRaMasYr,
		pmDecMasYr,
		mag: primaryMagnitude[0],
		magBand: primaryMagnitude[1],
		magBands,
		positionErrorMas: Math.max(raw.raSigmaMas, raw.decSigmaMas),
		properMotionError: raw.pmRaErrorMasYr !== undefined || raw.pmDecErrorMasYr !== undefined ? { raMasYr: raw.pmRaErrorMasYr, decMasYr: raw.pmDecErrorMasYr } : undefined,
		flags: {
			objectType: raw.objectType,
			combinedDoubleStarFlag: raw.combinedDoubleStarFlag,
			yaleSpmFlag: raw.yaleSpmFlag,
			fkSourceFlag: raw.mergedCatalogFlags[0],
			ledaFlag: raw.ledaFlag,
			twoMassExtendedSourceFlag: raw.twoMassExtendedSourceFlag,
		},
		sourceCatalog: 'UCAC4',
		raw: includeRaw ? raw : undefined,
		extras,
	}
}

// Builds the normalized multi-band magnitude map.
function buildMagnitudeBands(raw: Ucac4RawRecord): Readonly<Record<string, number | undefined>> {
	return {
		ucacModel: decodeMagnitude(raw.modelMagnitudeMillimag),
		ucacAperture: decodeMagnitude(raw.apertureMagnitudeMillimag),
		j: decodeMagnitude(raw.twoMassMagnitudeMillimag[0]),
		h: decodeMagnitude(raw.twoMassMagnitudeMillimag[1]),
		ks: decodeMagnitude(raw.twoMassMagnitudeMillimag[2]),
		b: decodeMagnitude(raw.apassMagnitudeMillimag[0]),
		v: decodeMagnitude(raw.apassMagnitudeMillimag[1]),
		g: decodeMagnitude(raw.apassMagnitudeMillimag[2]),
		r: decodeMagnitude(raw.apassMagnitudeMillimag[3]),
		i: decodeMagnitude(raw.apassMagnitudeMillimag[4]),
	}
}

// Picks a single primary magnitude for generic consumers.
function pickPrimaryMagnitude(raw: Ucac4RawRecord): readonly [number | undefined, string | undefined] {
	const aperture = decodeMagnitude(raw.apertureMagnitudeMillimag)
	if (aperture !== undefined) return [aperture, 'ucacAperture'] as const

	const model = decodeMagnitude(raw.modelMagnitudeMillimag)
	if (model !== undefined) return [model, 'ucacModel'] as const

	const j = decodeMagnitude(raw.twoMassMagnitudeMillimag[0])
	if (j !== undefined) return [j, 'j'] as const

	return [undefined, undefined] as const
}

// Decodes the merged 9-digit catalog-flag integer.
function decodeMergedCatalogFlags(value: number) {
	const text = `${Math.abs(value)}`.padStart(9, '0')
	return [...text].map((digit) => +digit) as unknown as readonly [number, number, number, number, number, number, number, number, number]
}

// Decodes an offset-encoded signed byte stored as value-128.
function decodeOffsetByte(value: number) {
	return value + 128
}

// Decodes a proper-motion error byte into mas/yr or no-data.
function decodeProperMotionError(value: number) {
	if (value === UCAC4_PM_NO_DATA) return undefined
	if (value === 251) return 27.5
	if (value === 252) return 32.5
	if (value === 253) return 37.5
	if (value === 254) return 45
	return value / 10
}

// Decodes a millimag field into magnitudes while preserving missing sentinels.
function decodeMagnitude(valueMillimag: number) {
	return valueMillimag === UCAC4_MISSING_MAG_MMAG ? undefined : valueMillimag / 1000
}

// Validates a native zone number.
function validateZoneNumber(zone: number) {
	if (!Number.isInteger(zone) || zone < 1 || zone > UCAC4_ZONE_COUNT) {
		throw new StarCatalogQueryError(`invalid UCAC4 zone number: ${zone}`)
	}
}

// Validates a native record number.
function validateRecordNumber(recordNumber: number) {
	if (!Number.isInteger(recordNumber) || recordNumber < 1) {
		throw new StarCatalogQueryError(`invalid UCAC4 record number: ${recordNumber}`)
	}
}

// Returns the native declination range of a zone.
function zoneDecRange(zone: number): readonly [number, number] {
	const minDec = -PIOVERTWO + (zone - 1) * UCAC4_ZONE_HEIGHT
	const maxDec = zone === UCAC4_ZONE_COUNT ? PIOVERTWO : minDec + UCAC4_ZONE_HEIGHT
	return [minDec, maxDec] as const
}

// Computes the set of zones touched by the query preselection boxes.
function touchedZones(query: NormalizedStarCatalogQuery) {
	const zones = new Set<number>()

	for (const box of query.preselectionBoxes) {
		const minZone = ucac4ZoneForDec(box.minDec)
		const maxZone = ucac4ZoneForDec(box.maxDec)

		for (let zone = minZone; zone <= maxZone; zone++) {
			zones.add(zone)
		}
	}

	return [...zones].sort((left, right) => left - right)
}

// Checks whether any part of a zone overlaps the query declination boxes.
function zoneIntersectsQuery(zone: number, query: NormalizedStarCatalogQuery) {
	return query.preselectionBoxes.some((box) => zoneIntersectsDecBox(zone, box.minDec, box.maxDec))
}

// Checks whether a zone overlaps a declination interval.
function zoneIntersectsDecBox(zone: number, minDec: Angle, maxDec: Angle) {
	const [zoneMinDec, zoneMaxDec] = zoneDecRange(zone)
	return maxDec >= zoneMinDec - GEOMETRY_EPSILON && minDec <= zoneMaxDec + GEOMETRY_EPSILON
}

// Merges overlapping native record ranges and clamps them to a zone length.
function mergeRanges(ranges: readonly (readonly [number, number])[], recordCount: number) {
	if (!ranges.length) return [] as (readonly [number, number])[]

	const sorted = [...ranges]
		.map(([startRecord, endRecord]) => [Math.max(1, startRecord), Math.min(recordCount, endRecord)] as const)
		.filter(([startRecord, endRecord]) => endRecord >= startRecord)
		.sort((left, right) => left[0] - right[0])

	if (!sorted.length) return [] as (readonly [number, number])[]

	const merged: (readonly [number, number])[] = [sorted[0]]

	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i]
		const last = merged[merged.length - 1]

		if (current[0] <= last[1] + 1) {
			merged[merged.length - 1] = [last[0], Math.max(last[1], current[1])] as const
		} else {
			merged.push(current)
		}
	}

	return merged
}

// Clamps an integer index into a closed interval.
function clampIndex(value: number, min: number, max: number) {
	if (value < min) return min
	if (value > max) return max
	return value
}
