import type { Stats } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import { join } from 'path'
import { type Angle, mas } from './angle'
import { DEG2RAD, PIOVERTWO } from './constants'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogEntry, type Vertex, validateDeclination } from './star.catalog'

// https://cdsarc.cds.unistra.fr/ftp/I/322A/UCAC4/
// https://irsa.ipac.caltech.edu/data/USNO/UCAC4/ucac4.html
// https://irsa.ipac.caltech.edu/data/USNO/UCAC4/readme_u4.txt

// The main catalog data are contained in binary zone files "z001" to "z900",
// sorted by declination. Each zone is 0.2 degree wide, beginning with z001
// at the south celestial pole. Stars are sorted by RA inside a zone file.

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

const UCAC4_ID_PATTERN = /^(?:4U|UCAC4[:\s]?)(\d{1,3})[-:](\d+)$/i

export interface Ucac4Record extends StarCatalogEntry {
	readonly zone: number
	readonly recordNumber: number
	// readonly modelMagnitudeMillimag: number
	// readonly apertureMagnitudeMillimag: number
	// readonly magnitudeErrorCentimag: number
	// readonly objectType: number
	// readonly combinedDoubleStarFlag: number
	// readonly raSigmaMas: number
	// readonly decSigmaMas: number
	// readonly imageCount: number
	// readonly usedImageCount: number
	// readonly properMotionCatalogCount: number
	// readonly centralEpochRaYear: number
	// readonly centralEpochDecYear: number
	// readonly pmRaCosDecMasYrTenth: number
	// readonly pmDecMasYrTenth: number
	// readonly pmRaErrorMasYr: number | undefined
	// readonly pmDecErrorMasYr: number | undefined
	// readonly twoMassId: number
	// readonly twoMassMagnitudeMillimag: readonly [number, number, number]
	// readonly twoMassQualityFlags: readonly [number, number, number]
	// readonly twoMassErrorCentimag: readonly [number, number, number]
	// readonly apassMagnitudeMillimag: readonly [number, number, number, number, number]
	// readonly apassErrorCentimag: readonly [number, number, number, number, number]
	// readonly yaleSpmFlag: number
	// readonly mergedCatalogFlags: readonly [number, number, number, number, number, number, number, number, number]
	// readonly ledaFlag: number
	// readonly twoMassExtendedSourceFlag: number
	// readonly uniqueStarNumber: number
	// readonly ucac2Zone: number
	// readonly ucac2RecordNumber: number
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
		throw new Error(`invalid UCAC4 identifier: ${id}`)
	}

	const zone = +match[1]
	const recordNumber = +match[2]
	validateZoneNumber(zone)
	validateRecordNumber(recordNumber)
	return [zone, recordNumber] as const
}

// Converts a declination to its native UCAC4 zone number.
export function ucac4ZoneForDec(dec: Angle) {
	const normalizedDec = validateDeclination(dec)
	if (normalizedDec >= PIOVERTWO) return UCAC4_ZONE_COUNT
	return Math.floor((normalizedDec + PIOVERTWO) / UCAC4_ZONE_HEIGHT) + 1
}

// Creates and opens a UCAC4 catalog in one step.
export async function openUcac4Catalog(source: string) {
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

	get root() {
		return this.#root
	}

	// Opens a UCAC4 storage root and eagerly loads the optional native index when available.
	async open(root: string) {
		if (!root) {
			throw new Error('missing UCAC4 root directory')
		}

		try {
			const stat = await fs.stat(root)
			if (!stat.isDirectory()) throw new Error(`UCAC4 root is not a directory: ${root}`)
		} catch (error) {
			throw new Error(`unable to access UCAC4 root: ${root}`)
		}

		this.#root = root
		this.#opened = await this.hasAnyZoneFile()

		if (!this.#opened) {
			throw new Error(`no UCAC4 zone files were found under ${root}`)
		}

		this.#index = await this.loadNativeIndex()

		return this
	}

	// Closes any cached zone handles.
	async close() {
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
	async get(id: string): Promise<Ucac4Record | undefined> {
		const [zone, recordNumber] = parseUcac4Id(id)
		return await this.readRawRecord(zone, recordNumber)
	}

	// Returns a raw UCAC4 record by native zone and record number.
	async readRawRecord(zone: number, recordNumber: number): Promise<Ucac4Record | undefined> {
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
				throw new Error(`short UCAC4 read for zone ${zone}, record ${recordNumber}`)
			}
		} catch (error) {
			if (error instanceof Error) throw error
			else throw new Error(`unable to read UCAC4 zone ${zone}, record ${recordNumber}`)
		}

		return parseUcac4Record(buffer, zone, recordNumber)
	}

	// Streams candidate entries from the zone files touched by the coarse preselection boxes.
	protected async *streamCandidateEntries(query: NormalizedStarCatalogQuery): AsyncIterable<StarCatalogEntry> {
		this.assertOpen()

		const zoneNumbers = touchedZones(query)

		for (const zone of zoneNumbers) {
			const ranges = await this.zoneRangesForQuery(zone, query)

			if (!ranges.length) continue

			for (const [startRecord, endRecord] of ranges) {
				yield* this.streamZoneRange(zone, startRecord, endRecord)
			}
		}
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
			throw new Error('UCAC4 catalog is not open')
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
				throw new Error(`corrupt UCAC4 index file: ${candidate}`)
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
			throw new Error(`unable to stat UCAC4 zone file: ${zonePath}`)
		}

		if (stat.size % UCAC4_RECORD_SIZE !== 0) {
			throw new Error(`invalid UCAC4 zone size for ${zonePath}`)
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
			throw new Error(`missing UCAC4 zone file for zone ${zone}`)
		}

		try {
			const handle = await fs.open(zonePath, 'r')
			this.#zoneHandles.set(zone, handle)
			return handle
		} catch (error) {
			throw new Error(`unable to open UCAC4 zone file: ${zonePath}`)
		}
	}

	// Computes the candidate record ranges touched by a query inside a single zone.
	private async zoneRangesForQuery(zone: number, query: NormalizedStarCatalogQuery): Promise<readonly Vertex[]> {
		if (!zoneIntersectsQuery(zone, query)) return []

		const recordCount = await this.ensureZoneRecordCount(zone)
		if (recordCount <= 0) return []

		if (!this.#index) {
			return [[1, recordCount]] as const
		}

		const ranges: Vertex[] = []

		for (const box of query.preselectionBoxes) {
			if (!zoneIntersectsDecBox(zone, box.minDEC, box.maxDEC)) continue

			const binStart = clampIndex(Math.floor(box.minRA / UCAC4_INDEX_BIN_SIZE), 0, UCAC4_INDEX_BIN_COUNT - 1)
			const binEnd = clampIndex(Math.floor(Math.max(box.maxRA - GEOMETRY_EPSILON, 0) / UCAC4_INDEX_BIN_SIZE), 0, UCAC4_INDEX_BIN_COUNT - 1)

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
	private async *streamZoneRange(zone: number, startRecord: number, endRecord: number): AsyncIterable<StarCatalogEntry> {
		const handle = await this.openZoneHandle(zone)
		const block = Buffer.allocUnsafe(UCAC4_BLOCK_RECORD_COUNT * UCAC4_RECORD_SIZE)

		while (startRecord <= endRecord) {
			const batchCount = Math.min(UCAC4_BLOCK_RECORD_COUNT, endRecord - startRecord + 1)
			const bytesToRead = batchCount * UCAC4_RECORD_SIZE

			let bytesRead: number

			try {
				bytesRead = (await handle.read(block, 0, bytesToRead, (startRecord - 1) * UCAC4_RECORD_SIZE)).bytesRead
			} catch (error) {
				throw new Error(`unable to read UCAC4 zone ${zone}`)
			}

			if (bytesRead !== bytesToRead) {
				throw new Error(`short UCAC4 block read in zone ${zone}`)
			}

			for (let offset = 0; offset < bytesRead; offset += UCAC4_RECORD_SIZE) {
				yield parseUcac4Record(block, zone, startRecord, offset)
				startRecord++
			}
		}
	}
}

// Parses a fixed-length native UCAC4 record from a block buffer.
function parseUcac4Record(buffer: Buffer, zone: number, recordNumber: number, offset: number = 0): Ucac4Record {
	const raMas = buffer.readInt32LE(offset)
	const southPoleDistanceMas = buffer.readInt32LE(offset + 4)

	if (raMas < 0 || raMas >= FULL_CIRCLE_MAS || southPoleDistanceMas < 0 || southPoleDistanceMas > 2 * UCAC4_SPD_OFFSET_MAS) {
		throw new Error(`invalid UCAC4 coordinates in zone ${zone}, record ${recordNumber}`)
	}

	// const mergedCatalogFlags = decodeMergedCatalogFlags(buffer.readInt32LE(offset + 62))
	const declination = mas(southPoleDistanceMas - UCAC4_SPD_OFFSET_MAS)
	const cosDec = Math.cos(declination)
	const pmRaCosDecMasYrTenth = buffer.readInt16LE(offset + 24)
	const pmDecMasYrTenth = buffer.readInt16LE(offset + 26)
	const pmRaErrorMasYr = decodeProperMotionError(decodeOffsetByte(buffer.readInt8(offset + 28)))
	const pmDecErrorMasYr = decodeProperMotionError(decodeOffsetByte(buffer.readInt8(offset + 29)))
	const rawPmRaCosDecMasYr = pmRaCosDecMasYrTenth === UCAC4_PM_SENTINEL ? undefined : pmRaCosDecMasYrTenth / 10
	const rawPmDecMasYr = pmDecMasYrTenth === UCAC4_PM_SENTINEL ? undefined : pmDecMasYrTenth / 10
	const hasPm = pmRaErrorMasYr !== undefined && pmDecErrorMasYr !== undefined && rawPmRaCosDecMasYr !== undefined && rawPmDecMasYr !== undefined
	const pmRA = hasPm && Math.abs(cosDec) > 1e-9 ? mas(rawPmRaCosDecMasYr / cosDec) : undefined
	const pmDEC = hasPm ? mas(rawPmDecMasYr) : undefined
	const modelMagnitudeMillimag = buffer.readInt16LE(offset + 8)
	const apertureMagnitudeMillimag = buffer.readInt16LE(offset + 10)
	const twoMassMagnitudeMillimagJ = buffer.readInt16LE(offset + 34)
	const magnitude = pickPrimaryMagnitude(apertureMagnitudeMillimag, modelMagnitudeMillimag, twoMassMagnitudeMillimagJ)

	return {
		id: formatUcac4Id(zone, recordNumber),
		zone,
		recordNumber,
		epoch: 2000,
		rightAscension: mas(raMas),
		declination,
		magnitude,
		pmRA,
		pmDEC,
		// modelMagnitudeMillimag,
		// apertureMagnitudeMillimag,
		// magnitudeErrorCentimag: buffer.readInt8(offset + 12),
		// objectType: buffer.readUInt8(offset + 13),
		// combinedDoubleStarFlag: buffer.readUInt8(offset + 14),
		// raSigmaMas: decodeOffsetByte(buffer.readInt8(offset + 15)),
		// decSigmaMas: decodeOffsetByte(buffer.readInt8(offset + 16)),
		// imageCount: buffer.readUInt8(offset + 17),
		// usedImageCount: buffer.readUInt8(offset + 18),
		// properMotionCatalogCount: buffer.readUInt8(offset + 19),
		// centralEpochRaYear: 1900 + buffer.readInt16LE(offset + 20) / 100,
		// centralEpochDecYear: 1900 + buffer.readInt16LE(offset + 22) / 100,
		// pmRaCosDecMasYrTenth,
		// pmDecMasYrTenth,
		// pmRaErrorMasYr,
		// pmDecErrorMasYr,
		// twoMassId: buffer.readInt32LE(offset + 30),
		// twoMassMagnitudeMillimag: [buffer.readInt16LE(offset + 34), buffer.readInt16LE(offset + 36), buffer.readInt16LE(offset + 38)] as const,
		// twoMassQualityFlags: [buffer.readUInt8(offset + 40), buffer.readUInt8(offset + 41), buffer.readUInt8(offset + 42)] as const,
		// twoMassErrorCentimag: [buffer.readUInt8(offset + 43), buffer.readUInt8(offset + 44), buffer.readUInt8(offset + 45)] as const,
		// apassMagnitudeMillimag: [buffer.readInt16LE(offset + 46), buffer.readInt16LE(offset + 48), buffer.readInt16LE(offset + 50), buffer.readInt16LE(offset + 52), buffer.readInt16LE(offset + 54)] as const,
		// apassErrorCentimag: [buffer.readInt8(offset + 56), buffer.readInt8(offset + 57), buffer.readInt8(offset + 58), buffer.readInt8(offset + 59), buffer.readInt8(offset + 60)] as const,
		// yaleSpmFlag: buffer.readUInt8(offset + 61),
		// mergedCatalogFlags,
		// ledaFlag: buffer.readUInt8(offset + 66),
		// twoMassExtendedSourceFlag: buffer.readUInt8(offset + 67),
		// uniqueStarNumber: buffer.readInt32LE(offset + 68),
		// ucac2Zone: buffer.readInt16LE(offset + 72),
		// ucac2RecordNumber: buffer.readInt32LE(offset + 74),
	}
}

// Builds the normalized multi-band magnitude map.
// function buildMagnitudeBands(raw: Ucac4Record): Readonly<Record<string, number | undefined>> {
// 	return {
// 		ucacModel: decodeMagnitude(raw.modelMagnitudeMillimag),
// 		ucacAperture: decodeMagnitude(raw.apertureMagnitudeMillimag),
// 		j: decodeMagnitude(raw.twoMassMagnitudeMillimag[0]),
// 		h: decodeMagnitude(raw.twoMassMagnitudeMillimag[1]),
// 		ks: decodeMagnitude(raw.twoMassMagnitudeMillimag[2]),
// 		b: decodeMagnitude(raw.apassMagnitudeMillimag[0]),
// 		v: decodeMagnitude(raw.apassMagnitudeMillimag[1]),
// 		g: decodeMagnitude(raw.apassMagnitudeMillimag[2]),
// 		r: decodeMagnitude(raw.apassMagnitudeMillimag[3]),
// 		i: decodeMagnitude(raw.apassMagnitudeMillimag[4]),
// 	}
// }

// Picks a single primary magnitude for generic consumers.
function pickPrimaryMagnitude(apertureMagnitudeMillimag: number, modelMagnitudeMillimag: number, twoMassMagnitudeMillimagJ: number) {
	const aperture = decodeMagnitude(apertureMagnitudeMillimag)
	if (aperture !== undefined) return aperture

	const model = decodeMagnitude(modelMagnitudeMillimag)
	if (model !== undefined) return model

	const j = decodeMagnitude(twoMassMagnitudeMillimagJ)
	if (j !== undefined) return j

	return undefined
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
		throw new Error(`invalid UCAC4 zone number: ${zone}`)
	}
}

// Validates a native record number.
function validateRecordNumber(recordNumber: number) {
	if (!Number.isInteger(recordNumber) || recordNumber < 1) {
		throw new Error(`invalid UCAC4 record number: ${recordNumber}`)
	}
}

// Returns the native declination range of a zone.
function zoneDecRange(zone: number): readonly [number, number] {
	const minDec = -PIOVERTWO + (zone - 1) * UCAC4_ZONE_HEIGHT
	const maxDec = zone === UCAC4_ZONE_COUNT ? PIOVERTWO : minDec + UCAC4_ZONE_HEIGHT
	return [minDec, maxDec] as const
}

const ZoneComparator = (left: number, right: number) => left - right

// Computes the set of zones touched by the query preselection boxes.
function touchedZones(query: NormalizedStarCatalogQuery) {
	const zones = new Set<number>()

	for (const box of query.preselectionBoxes) {
		const minZone = ucac4ZoneForDec(box.minDEC)
		const maxZone = ucac4ZoneForDec(box.maxDEC)

		for (let zone = minZone; zone <= maxZone; zone++) {
			zones.add(zone)
		}
	}

	return [...zones].sort(ZoneComparator)
}

// Checks whether any part of a zone overlaps the query declination boxes.
function zoneIntersectsQuery(zone: number, query: NormalizedStarCatalogQuery) {
	return query.preselectionBoxes.some((box) => zoneIntersectsDecBox(zone, box.minDEC, box.maxDEC))
}

// Checks whether a zone overlaps a declination interval.
function zoneIntersectsDecBox(zone: number, minDec: Angle, maxDec: Angle) {
	const [zoneMinDec, zoneMaxDec] = zoneDecRange(zone)
	return maxDec >= zoneMinDec - GEOMETRY_EPSILON && minDec <= zoneMaxDec + GEOMETRY_EPSILON
}

// Merges overlapping native record ranges and clamps them to a zone length.
function mergeRanges(ranges: readonly Vertex[], recordCount: number) {
	if (!ranges.length) return []

	const sorted = [...ranges]
		.map((e) => [Math.max(1, e[0]), Math.min(recordCount, e[1])] as const)
		.filter((e) => e[1] >= e[0])
		.sort((left, right) => left[0] - right[0])

	if (!sorted.length) return []

	const merged: Vertex[] = [sorted[0]]

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
