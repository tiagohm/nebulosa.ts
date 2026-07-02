import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import { PIOVERTWO, TAU } from '../../core/constants'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogEntry, type StarCatalogRaDecBox } from './catalog'

// Shared reader and star-catalog engine for the HNSKY-lineage tiled binary star archives (HNSKY ".290"
// and ASTAP ".1476"). Both formats use the identical 110-byte header and packed record layout (variable
// record sizes, header-relative magnitude/declination deltas, a 0xffffff sentinel record); they differ
// only in their sky tiling (declination bands and RA-cell counts), file naming, and a few per-catalog
// conventions (epoch, color scaling). This module decodes records, resolves which tiles a query touches
// for an arbitrary tiling, and drives the generic BaseStarCatalog contract; concrete formats supply a
// TiledSkyGeometry plus an entry/star materializer. Angles are radians; positions are packed as 24-bit
// RA and signed 24-bit declination.

// Size of the shared 110-byte per-tile header.
const TILED_STAR_HEADER_SIZE = 110
// Scale from the packed 24-bit right ascension to radians (full circle over 2^24-1).
export const TILED_STAR_RA_SCALE = TAU / 0xffffff
// Scale from the packed signed 24-bit declination to radians (PI/2 over 2^23-1).
export const TILED_STAR_DEC_SCALE = PIOVERTWO / 0x7fffff
// Bias subtracted from a header record's packed magnitude byte.
const TILED_STAR_HEADER_MAG_OFFSET = 16
// Bias subtracted from a header record's packed declination high byte.
const TILED_STAR_HEADER_DEC_OFFSET = 128
// Minimum overlap fraction for a tile to be considered touched by a square field query.
const TILED_STAR_MIN_AREA_FRACTION = 0.01
// Angular tolerance for tile/box intersection tests, radians.
const GEOMETRY_EPSILON = 1e-12

// Allowed per-record byte sizes shared by both formats.
export type TiledStarRecordSize = 5 | 6 | 7 | 9 | 10 | 11

// A single archive member: a File-like or a raw buffer source.
export type TiledStarFile = Pick<File, 'arrayBuffer'> | Bun.BufferSource

// A collection of archive members keyed by database-prefixed file name.
export type TiledStarFiles = Map<string, TiledStarFile> | Record<string, TiledStarFile>

// Parsed 110-byte header of one tile.
export interface TiledStarFileHeader {
	// Free-text tile description (bytes 0..107, trailing padding trimmed).
	readonly description: string
	// Bytes per star record in this tile.
	readonly recordSize: TiledStarRecordSize
	// Database version byte (108); 2 marks the Gaia color-carrying variant used by ASTAP.
	readonly version: number
	// Catalog epoch as a Julian year, parsed from an "Epoch=YYYY" tag in the description or a fallback.
	readonly epoch: number
}

// A square-field region query around a center.
export interface TiledStarRegionQuery extends EquatorialCoordinate {
	// Half-field size (square half-width), radians.
	radius: Angle
	// Optional faintest magnitude to include.
	magnitudeLimit?: number
}

// A typed catalog designation decoded from a packed identifier (HNSKY formats only).
export interface TiledStarDesignation {
	// Raw packed value.
	readonly value: number
	// Source catalog the identifier belongs to.
	readonly catalog: 'TYC' | 'UCAC4'
	// Catalog region/zone number.
	readonly region: number
	// Star number within the region.
	readonly star: number
	// Tycho component (1/2/3), when applicable.
	readonly component?: 1 | 2 | 3
	// Human-readable label.
	readonly label: string
}

// Descriptor of one sky area (tile).
export interface TiledStarArea {
	// 1-based area number.
	readonly area: number
	// 1-based declination band (ring) number.
	readonly ring: number
	// 1-based RA cell index within the ring.
	readonly index: number
	// File name of the tile (without the database prefix), including the extension.
	readonly fileName: string
	// Fraction of the query field this tile covers (0 when not part of a query).
	readonly fraction: number
}

// Minimal sortable star shape shared by the per-format field-search results.
export interface TiledStarSortable extends Readonly<EquatorialCoordinate> {
	// Area (tile) the star belongs to.
	readonly area: number
	// Magnitude.
	readonly magnitude: number
}

// A precomputed sky-tiling descriptor: the declination bands, per-band RA-cell counts, and derived tables.
export interface TiledSkyGeometry {
	// Total number of tiles.
	readonly areaCount: number
	// Number of RA cells in each declination band, from the south to the north pole.
	readonly ringCounts: readonly number[]
	// Declination boundaries (radians) between the bands; length is ringCounts.length + 1.
	readonly decBoundaries: readonly Angle[]
	// File-name extension, including the dot (e.g. ".290", ".1476").
	readonly extension: string
	// Cumulative area-number offset at the start of each band.
	readonly areaOffsets: readonly number[]
	// Precomputed area descriptors for all tiles, indexed by area-1.
	readonly areas: readonly TiledStarArea[]
	// Precomputed coarse RA/Dec bounds for all tiles, indexed by area-1.
	readonly areaBounds: readonly StarCatalogRaDecBox[]
}

// Internal: a tile plus the distances from a query point to its band/cell borders.
interface TiledStarBandArea {
	readonly area: number
	// Angular space (radians) to the eastern cell border.
	readonly spaceEast: number
	// Angular space (radians) to the western cell border.
	readonly spaceWest: number
	// Angular space (radians) to the northern band border.
	readonly spaceNorth: number
	// Angular space (radians) to the southern band border.
	readonly spaceSouth: number
}

// A reusable scan cursor holding one record's packed fields. It is mutated in place while a tile is
// scanned so per-record decoding allocates nothing; a star object is created only when one is emitted.
// The `has*` flags mark which optional fields the record format actually carries.
export interface TiledStarRawRecord {
	// 1-based physical record index within the tile (header records included in the count).
	recordNumber: number
	// Packed 24-bit right ascension, range [0, 2^24).
	raRaw: number
	// Packed signed 24-bit declination.
	decRaw: number
	// Magnitude in magnitude units.
	magnitude: number
	// Packed catalog designation identifier; meaningful only when hasDesignation is true.
	designationValue: number
	// True when the record format carries a catalog designation.
	hasDesignation: boolean
	// Raw signed color byte; the per-format materializer applies the scale. Meaningful only when hasColor.
	colorRaw: number
	// True when the record format carries a color byte.
	hasColor: boolean
}

// A lazily loaded tile with its parsed header and raw buffer.
export interface TiledStarLoadedArea extends TiledStarArea {
	readonly header: TiledStarFileHeader
	readonly buffer: Buffer
}

// Builds a sky-tiling descriptor from its per-band RA-cell counts and declination boundaries. The area
// descriptors, bounds, and cumulative offsets are precomputed once. `extension` is the file suffix.
export function createTiledSkyGeometry(ringCounts: readonly number[], decBoundaries: readonly Angle[], extension: string): TiledSkyGeometry {
	if (decBoundaries.length !== ringCounts.length + 1) {
		throw new Error(`invalid tiling: ${ringCounts.length} bands need ${ringCounts.length + 1} boundaries, got ${decBoundaries.length}`)
	}

	const areas: TiledStarArea[] = []
	const areaOffsets: number[] = []
	let offset = 0

	for (let ring = 0; ring < ringCounts.length; ring++) {
		areaOffsets.push(offset)
		const count = ringCounts[ring]

		for (let index = 1; index <= count; index++) {
			const area = offset + index
			const fileName = `${(ring + 1).toFixed(0).padStart(2, '0')}${index.toFixed(0).padStart(2, '0')}${extension}`
			areas.push({ area, ring: ring + 1, index, fileName, fraction: 0 })
		}

		offset += count
	}

	const areaBounds = areas.map((file) => {
		const band = file.ring - 1
		const minDEC = decBoundaries[band]
		const maxDEC = decBoundaries[band + 1]
		const count = ringCounts[band]

		if (count === 1) {
			return { minRA: 0, maxRA: TAU, minDEC, maxDEC }
		}

		const width = TAU / count
		const minRA = (file.index - 1) * width
		return { minRA, maxRA: minRA + width, minDEC, maxDEC }
	})

	return { areaCount: areas.length, ringCounts, decBoundaries, extension, areaOffsets, areas, areaBounds }
}

// Returns the descriptor for a 1-based area number, throwing if out of range.
export function lookupTiledStarArea(geometry: TiledSkyGeometry, area: number) {
	if (!Number.isInteger(area) || area < 1 || area > geometry.areaCount) {
		throw new RangeError(`invalid ${geometry.extension} area: ${area}`)
	}

	return geometry.areas[area - 1]
}

// Returns a fresh copy of the descriptor for a 1-based area number.
export function tiledStarAreaFile(geometry: TiledSkyGeometry, area: number): TiledStarArea {
	return { ...lookupTiledStarArea(geometry, area) }
}

// Decodes a stored designation into a typed catalog identifier (HNSKY 9/10/11 records).
export function decodeTiledStarDesignation(value: number): TiledStarDesignation {
	if (value >= 0) {
		const region = (value >>> 20) & 0xfff
		const star = value & 0x000fffff
		return { value, catalog: 'UCAC4', region, star, label: `UCAC4 ${region}-${star}` }
	}

	const raw = -value
	const region = (raw >>> 16) & 0x3fff
	const star = raw & 0x7fff
	const component = (raw & 0x00008000) !== 0 ? 3 : (raw & 0x40000000) !== 0 ? 2 : 1
	return { value, catalog: 'TYC', region, star, component, label: `TYC ${region}-${star}-${component}` }
}

// Parses a Julian-year epoch from an "Epoch=YYYY(.y)" tag in a header description, else undefined.
function parseTiledStarEpoch(description: string): number | undefined {
	const match = /Epoch\s*=\s*([0-9]+(?:\.[0-9]+)?)/i.exec(description)
	if (!match) return undefined
	const value = Number(match[1])
	return Number.isFinite(value) ? value : undefined
}

// Reads and validates the shared 110-byte header. `defaultEpoch` is used when the description carries no
// "Epoch=" tag; `formatLabel` is only used to phrase the error for an unsupported record size.
export function readTiledStarHeader(buffer: Buffer, defaultEpoch: number, formatLabel: string): TiledStarFileHeader {
	const recordSizeByte = buffer[TILED_STAR_HEADER_SIZE - 1]
	const recordSize = recordSizeByte === 0x20 ? 11 : recordSizeByte

	if (recordSize !== 5 && recordSize !== 6 && recordSize !== 7 && recordSize !== 9 && recordSize !== 10 && recordSize !== 11) {
		throw new Error(`unsupported ${formatLabel} record size: ${recordSize}`)
	}

	const version = buffer[TILED_STAR_HEADER_SIZE - 2]
	const description = buffer
		.toString('latin1', 0, TILED_STAR_HEADER_SIZE - 2)
		.replaceAll('\0', '')
		.trimEnd()

	return { description, recordSize, version, epoch: parseTiledStarEpoch(description) ?? defaultEpoch }
}

// Creates a fresh, fully-initialized scan cursor. A stable object shape keeps the reused cursor
// monomorphic for the JIT while it is mutated in place across every record of a tile.
export function createTiledStarRawRecord(): TiledStarRawRecord {
	return { recordNumber: 0, raRaw: 0, decRaw: 0, magnitude: 0, designationValue: 0, hasDesignation: false, colorRaw: 0, hasColor: false }
}

// Selects the format-specialized record scanner once per tile, avoiding a per-record recordSize switch.
// Each scanner yields the shared `out` cursor filled with the current record's packed fields; the cursor
// is reused across yields, so callers must materialize a star before advancing the iterator.
export function scanTiledStarRecords(header: TiledStarFileHeader, buffer: Buffer, out: TiledStarRawRecord): Generator<TiledStarRawRecord, void> {
	switch (header.recordSize) {
		case 5:
			return scanTiledStarRecords5(buffer, out)
		case 6:
			return scanTiledStarRecords6(buffer, out)
		case 7:
			return scanTiledStarRecords7(buffer, out)
		case 9:
			return scanTiledStarRecords9(buffer, out)
		case 10:
			return scanTiledStarRecords10(buffer, out)
		case 11:
			return scanTiledStarRecords11(buffer, out)
	}
}

// Reads a packed unsigned 24-bit little-endian value with direct indexed byte access.
function readUint24(buffer: Buffer, offset: number) {
	return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

// Reads a signed 8-bit value with direct indexed byte access.
function readInt8(buffer: Buffer, offset: number) {
	return (buffer[offset] << 24) >> 24
}

// Reads a signed 32-bit little-endian value with direct indexed byte access.
function readInt32(buffer: Buffer, offset: number) {
	return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)
}

// Decodes a signed 24-bit integer from its low, middle, and signed high bytes.
function decodeSigned24(low: number, middle: number, high: number) {
	return (high << 16) | (middle << 8) | low
}

// Scans 5-byte compact records: RA at +0, declination low/mid at +3/+4, magnitude and dec-high inherited
// from the preceding 0xffffff header record. No color or designation.
function* scanTiledStarRecords5(buffer: Buffer, out: TiledStarRawRecord): Generator<TiledStarRawRecord, void> {
	const end = buffer.byteLength - 5
	let recordNumber = 1
	let magnitude = Number.NaN
	let decHigh = 0
	out.hasDesignation = false
	out.hasColor = false

	for (let offset = TILED_STAR_HEADER_SIZE; offset <= end; offset += 5, recordNumber++) {
		const raRaw = readUint24(buffer, offset)

		if (raRaw === 0xffffff) {
			decHigh = buffer[offset + 3] - TILED_STAR_HEADER_DEC_OFFSET
			magnitude = (buffer[offset + 4] - TILED_STAR_HEADER_MAG_OFFSET) / 10
			continue
		}

		out.recordNumber = recordNumber
		out.raRaw = raRaw
		out.decRaw = decodeSigned24(buffer[offset + 3], buffer[offset + 4], decHigh)
		out.magnitude = magnitude
		yield out
	}
}

// Scans 6-byte compact records: like the 5-byte format plus a signed color byte at +5.
function* scanTiledStarRecords6(buffer: Buffer, out: TiledStarRawRecord): Generator<TiledStarRawRecord, void> {
	const end = buffer.byteLength - 6
	let recordNumber = 1
	let magnitude = Number.NaN
	let decHigh = 0
	out.hasDesignation = false
	out.hasColor = true

	for (let offset = TILED_STAR_HEADER_SIZE; offset <= end; offset += 6, recordNumber++) {
		const raRaw = readUint24(buffer, offset)

		if (raRaw === 0xffffff) {
			decHigh = buffer[offset + 3] - TILED_STAR_HEADER_DEC_OFFSET
			magnitude = (buffer[offset + 4] - TILED_STAR_HEADER_MAG_OFFSET) / 10
			continue
		}

		out.recordNumber = recordNumber
		out.raRaw = raRaw
		out.decRaw = decodeSigned24(buffer[offset + 3], buffer[offset + 4], decHigh)
		out.magnitude = magnitude
		out.colorRaw = readInt8(buffer, offset + 5)
		yield out
	}
}

// Scans 7-byte full records: RA at +0, full signed declination at +3/+4/+5, magnitude at +6. Every record
// is a star (no inherited header records).
function* scanTiledStarRecords7(buffer: Buffer, out: TiledStarRawRecord): Generator<TiledStarRawRecord, void> {
	const end = buffer.byteLength - 7
	let recordNumber = 1
	out.hasDesignation = false
	out.hasColor = false

	for (let offset = TILED_STAR_HEADER_SIZE; offset <= end; offset += 7, recordNumber++) {
		out.recordNumber = recordNumber
		out.raRaw = readUint24(buffer, offset)
		out.decRaw = decodeSigned24(buffer[offset + 3], buffer[offset + 4], readInt8(buffer, offset + 5))
		out.magnitude = readInt8(buffer, offset + 6) / 10
		yield out
	}
}

// Scans 9-byte compact records: signed designation at +0, RA at +4, declination low/mid at +7/+8, with
// magnitude and dec-high inherited from the preceding 0xffffff header record.
function* scanTiledStarRecords9(buffer: Buffer, out: TiledStarRawRecord): Generator<TiledStarRawRecord, void> {
	const end = buffer.byteLength - 9
	let recordNumber = 1
	let magnitude = Number.NaN
	let decHigh = 0
	out.hasDesignation = true
	out.hasColor = false

	for (let offset = TILED_STAR_HEADER_SIZE; offset <= end; offset += 9, recordNumber++) {
		const raRaw = readUint24(buffer, offset + 4)

		if (raRaw === 0xffffff) {
			decHigh = buffer[offset + 7] - TILED_STAR_HEADER_DEC_OFFSET
			magnitude = (buffer[offset + 8] - TILED_STAR_HEADER_MAG_OFFSET) / 10
			continue
		}

		out.recordNumber = recordNumber
		out.raRaw = raRaw
		out.decRaw = decodeSigned24(buffer[offset + 7], buffer[offset + 8], decHigh)
		out.magnitude = magnitude
		out.designationValue = readInt32(buffer, offset)
		yield out
	}
}

// Scans 10-byte full records: signed designation at +0, RA at +4, full signed declination at +7/+8/+9.
// The magnitude is inherited from a preceding 0xffffff magnitude-section header record (which does not
// carry a dec-high update).
function* scanTiledStarRecords10(buffer: Buffer, out: TiledStarRawRecord): Generator<TiledStarRawRecord, void> {
	const end = buffer.byteLength - 10
	let recordNumber = 1
	let magnitude = Number.NaN
	out.hasDesignation = true
	out.hasColor = false

	for (let offset = TILED_STAR_HEADER_SIZE; offset <= end; offset += 10, recordNumber++) {
		const raRaw = readUint24(buffer, offset + 4)

		if (raRaw === 0xffffff) {
			magnitude = readInt8(buffer, offset + 9) / 10
			continue
		}

		out.recordNumber = recordNumber
		out.raRaw = raRaw
		out.decRaw = decodeSigned24(buffer[offset + 7], buffer[offset + 8], readInt8(buffer, offset + 9))
		out.magnitude = magnitude
		out.designationValue = readInt32(buffer, offset)
		yield out
	}
}

// Scans 11-byte full records: signed designation at +0, RA at +4, full signed declination at +7/+8/+9,
// magnitude at +10. Every record is a star (no inherited header records).
function* scanTiledStarRecords11(buffer: Buffer, out: TiledStarRawRecord): Generator<TiledStarRawRecord, void> {
	const end = buffer.byteLength - 11
	let recordNumber = 1
	out.hasDesignation = true
	out.hasColor = false

	for (let offset = TILED_STAR_HEADER_SIZE; offset <= end; offset += 11, recordNumber++) {
		out.recordNumber = recordNumber
		out.raRaw = readUint24(buffer, offset + 4)
		out.decRaw = decodeSigned24(buffer[offset + 7], buffer[offset + 8], readInt8(buffer, offset + 9))
		out.magnitude = readInt8(buffer, offset + 10) / 10
		out.designationValue = readInt32(buffer, offset)
		yield out
	}
}

// A per-record materializer: turns the raw scan cursor into a concrete star/entry. Called once per emitted
// candidate so coordinate conversion and designation/color decoding happen only for kept records.
export type TiledStarMaterializer<T> = (area: number, record: Readonly<TiledStarRawRecord>, header: TiledStarFileHeader) => T

// Yields all stars from one tile that fall inside the square field query, materializing (and decoding
// color/designation) only for a star that actually lies inside the field.
export function* readTiledStarArea<T>(header: TiledStarFileHeader, buffer: Buffer, area: number, query: Readonly<TiledStarRegionQuery>, materialize: TiledStarMaterializer<T>): Generator<T, void> {
	const { rightAscension, declination, radius, magnitudeLimit } = query
	const cosDeclination = Math.cos(declination)
	const maxMagnitude = Number.isFinite(magnitudeLimit) ? magnitudeLimit! : Number.POSITIVE_INFINITY
	const cursor = createTiledStarRawRecord()

	for (const record of scanTiledStarRecords(header, buffer, cursor)) {
		// Records are stored in ascending magnitude order, so once the limit is exceeded none remain.
		if (record.magnitude > maxMagnitude) break

		const rightAscensionOfStar = record.raRaw * TILED_STAR_RA_SCALE
		const declinationOfStar = record.decRaw * TILED_STAR_DEC_SCALE
		const deltaRa = Math.abs(normalizePI(rightAscensionOfStar - rightAscension))

		// Match the original square-field visibility test used by HNSKY/ASTAP.
		if (Math.abs(deltaRa * cosDeclination) < radius && Math.abs(declinationOfStar - declination) < radius) {
			yield materialize(area, record, header)
		}
	}
}

// Result of a field search: the touched areas, their headers, and the merged star list.
export interface TiledStarSearchResult<T> {
	readonly areas: readonly TiledStarArea[]
	readonly headers: readonly (TiledStarFileHeader & TiledStarArea)[]
	readonly stars: readonly T[]
}

// Reads all stars inside the requested field from the intersecting tiles, merged in brightness order.
export async function findTiledStarRegion<T extends TiledStarSortable>(files: TiledStarFiles, database: string, geometry: TiledSkyGeometry, query: Readonly<TiledStarRegionQuery>, defaultEpoch: number, formatLabel: string, materialize: TiledStarMaterializer<T>): Promise<TiledStarSearchResult<T>> {
	const areas = findTiledStarAreas(geometry, query.rightAscension, query.declination, query.radius)
	const headers: Array<TiledStarFileHeader & TiledStarArea> = []
	const stars: T[] = []

	const get = files instanceof Map ? (key: string) => files.get(key) : (key: string) => files[key]

	// Resolve and parse every intersecting tile in parallel so a first query does not serialize File I/O.
	// A square field touches at most four tiles, so the fan-out is bounded and needs no concurrency limit.
	const loaded = await Promise.all(
		areas.map(async (area) => {
			const file = get(`${database}_${area.fileName}`)
			if (file === undefined) return undefined
			const buffer = await bufferFromTiledStarFile(file)
			return { area, header: readTiledStarHeader(buffer, defaultEpoch, formatLabel), buffer }
		}),
	)

	for (const tile of loaded) {
		if (tile === undefined) continue

		headers.push(Object.assign(tile.header, tile.area))

		for (const star of readTiledStarArea(tile.header, tile.buffer, tile.area.area, query, materialize)) {
			stars.push(star)
		}
	}

	stars.sort(compareStarsByMagnitude)

	return { areas, headers, stars }
}

// Finds the 1 to 4 tiles intersecting the requested square field.
export function findTiledStarAreas(geometry: TiledSkyGeometry, rightAscension: Angle, declination: Angle, radius: Angle): readonly TiledStarArea[] {
	const diameter = radius * 2
	const northDeclination = declination + radius
	const southDeclination = declination - radius
	const eastNorth = normalizeAngle(rightAscension + projectRaHalfSpan(radius, northDeclination))
	const westNorth = normalizeAngle(rightAscension - projectRaHalfSpan(radius, northDeclination))
	const eastSouth = normalizeAngle(rightAscension + projectRaHalfSpan(radius, southDeclination))
	const westSouth = normalizeAngle(rightAscension - projectRaHalfSpan(radius, southDeclination))

	const corners = [
		{ area: areaAndBoundaries(geometry, eastNorth, northDeclination), fraction: 0 },
		{ area: areaAndBoundaries(geometry, westNorth, northDeclination), fraction: 0 },
		{ area: areaAndBoundaries(geometry, eastSouth, southDeclination), fraction: 0 },
		{ area: areaAndBoundaries(geometry, westSouth, southDeclination), fraction: 0 },
	]

	const diameter2 = diameter * diameter
	corners[0].fraction = (Math.min(corners[0].area.spaceWest, diameter) * Math.min(corners[0].area.spaceSouth, diameter)) / diameter2
	corners[1].fraction = (Math.min(corners[1].area.spaceEast, diameter) * Math.min(corners[1].area.spaceSouth, diameter)) / diameter2
	corners[2].fraction = (Math.min(corners[2].area.spaceWest, diameter) * Math.min(corners[2].area.spaceNorth, diameter)) / diameter2
	corners[3].fraction = (Math.min(corners[3].area.spaceEast, diameter) * Math.min(corners[3].area.spaceNorth, diameter)) / diameter2

	const unique: TiledStarArea[] = []

	for (const { area, fraction } of corners) {
		if (fraction < TILED_STAR_MIN_AREA_FRACTION) continue

		let known = -1

		for (let i = 0; i < unique.length; i++) {
			if (unique[i].area === area.area) {
				known = i
				break
			}
		}

		if (known < 0) {
			const file = lookupTiledStarArea(geometry, area.area)
			unique.push({ ...file, fraction })
		} else {
			const actual = unique[known]

			if (actual.fraction < 1) {
				;(actual as { fraction: number }).fraction = Math.min(1, actual.fraction + fraction)
			}
		}
	}

	return unique
}

// Projects the square half-field from declination space into RA.
function projectRaHalfSpan(halfField: Angle, declination: Angle) {
	const cosDeclination = Math.cos(declination)
	return Math.abs(cosDeclination) < 1e-12 ? 0 : halfField / cosDeclination
}

// Locates the containing area and the distances to its borders for a given tiling.
function areaAndBoundaries(geometry: TiledSkyGeometry, rightAscension: Angle, declination: Angle): TiledStarBandArea {
	const { decBoundaries, ringCounts, areaOffsets, areaCount } = geometry
	const bandCount = ringCounts.length

	if (declination <= decBoundaries[0]) {
		return { area: 1, spaceEast: TAU, spaceWest: TAU, spaceNorth: decBoundaries[1] - decBoundaries[0], spaceSouth: decBoundaries[1] - decBoundaries[0] }
	}

	if (declination >= decBoundaries[bandCount]) {
		return { area: areaCount, spaceEast: TAU, spaceWest: TAU, spaceNorth: decBoundaries[bandCount] - decBoundaries[bandCount - 1], spaceSouth: decBoundaries[bandCount] - decBoundaries[bandCount - 1] }
	}

	let band = 0

	for (let i = bandCount - 1; i >= 0; i--) {
		if (declination > decBoundaries[i]) {
			band = i
			break
		}
	}

	const count = ringCounts[band]
	const southBoundary = decBoundaries[band]
	const northBoundary = decBoundaries[band + 1]

	if (count === 1) {
		return { area: band === 0 ? 1 : areaCount, spaceEast: TAU, spaceWest: TAU, spaceNorth: northBoundary - declination, spaceSouth: declination - southBoundary }
	}

	const rotation = (normalizeAngle(rightAscension) * count) / TAU
	const cell = Math.trunc(rotation)
	const fraction = rotation - cell
	const width = (TAU / count) * Math.cos(declination)

	return {
		area: areaOffsets[band] + cell + 1,
		spaceEast: width * (1 - fraction),
		spaceWest: width * fraction,
		spaceNorth: northBoundary - declination,
		spaceSouth: declination - southBoundary,
	}
}

// Computes the set of tiles touched by the query preselection boxes.
export function touchedTiledStarAreas(geometry: TiledSkyGeometry, query: NormalizedStarCatalogQuery) {
	const touched = new Uint8Array(geometry.areaCount + 1)

	for (const box of query.preselectionBoxes) {
		for (let area = 1; area <= geometry.areaCount; area++) {
			if (!touched[area] && areaIntersectsRaDecBox(geometry, area, box)) {
				touched[area] = 1
			}
		}
	}

	const areas: number[] = []

	for (let area = 1; area <= geometry.areaCount; area++) {
		if (touched[area]) {
			areas.push(area)
		}
	}

	return areas
}

// Checks whether a star lies inside any coarse preselection box.
export function matchesPreselectionBoxes(rightAscension: Angle, declination: Angle, boxes: readonly StarCatalogRaDecBox[]) {
	for (const box of boxes) {
		if (matchesRaDecBox(rightAscension, declination, box)) {
			return true
		}
	}

	return false
}

// Checks whether one tile overlaps a non-wrapping RA/Dec box.
function areaIntersectsRaDecBox(geometry: TiledSkyGeometry, area: number, box: StarCatalogRaDecBox) {
	const bounds = geometry.areaBounds[area - 1]

	if (box.maxDEC < bounds.minDEC - GEOMETRY_EPSILON || box.minDEC > bounds.maxDEC + GEOMETRY_EPSILON) {
		return false
	}

	if (bounds.maxRA - bounds.minRA >= TAU - GEOMETRY_EPSILON) {
		return true
	}

	return box.maxRA >= bounds.minRA - GEOMETRY_EPSILON && box.minRA <= bounds.maxRA + GEOMETRY_EPSILON
}

// Checks whether one point lies inside a non-wrapping RA/Dec box.
function matchesRaDecBox(rightAscension: Angle, declination: Angle, box: StarCatalogRaDecBox) {
	return rightAscension + GEOMETRY_EPSILON >= box.minRA && rightAscension <= box.maxRA + GEOMETRY_EPSILON && declination + GEOMETRY_EPSILON >= box.minDEC && declination <= box.maxDEC + GEOMETRY_EPSILON
}

// Provides a stable merged ordering across tiles.
function compareStarsByMagnitude(a: TiledStarSortable, b: TiledStarSortable) {
	return a.magnitude - b.magnitude || a.area - b.area || normalizePI(a.rightAscension - b.rightAscension)
}

// Validates a synthetic per-tile record number.
export function validateTiledStarRecordNumber(recordNumber: number) {
	if (!Number.isInteger(recordNumber) || recordNumber < 1) {
		throw new RangeError(`invalid record number: ${recordNumber}`)
	}

	return recordNumber
}

// Normalizes any supported file source (Buffer, File-like, or BufferSource) into a Buffer.
export async function bufferFromTiledStarFile(file: TiledStarFile) {
	return Buffer.isBuffer(file) ? file : 'arrayBuffer' in file ? Buffer.from(await file.arrayBuffer()) : ArrayBuffer.isView(file) ? Buffer.from(file.buffer, file.byteOffset, file.byteLength) : Buffer.from(file)
}

// Generic tiled-archive catalog: lazily loads and decodes per-declination tiles and exposes them through
// the generic BaseStarCatalog contract. Concrete formats supply their tiling geometry, the epoch/error
// labels, and an entry builder. T is the emitted entry type; DB is the database-prefix union.
export abstract class TiledStarCatalog<T extends StarCatalogEntry, DB extends string = string> extends BaseStarCatalog<T> implements Disposable {
	// Per-area load cache keyed by area number. Stores the in-flight (or settled) load promise so that
	// concurrent requests for the same tile share one read and one parse. A resolved `undefined` is a
	// cached negative result (the tile file is absent); a rejected promise is evicted so a retry is possible.
	readonly #areas = new Map<number, Promise<TiledStarLoadedArea | undefined>>()

	#files?: TiledStarFiles
	#database: DB
	#opened = false

	protected constructor(
		protected readonly geometry: TiledSkyGeometry,
		protected readonly defaultEpoch: number,
		protected readonly formatLabel: string,
		defaultDatabase: DB,
	) {
		super()
		this.#database = defaultDatabase
	}

	get database() {
		return this.#database
	}

	// Builds one concrete catalog entry from a decoded record and its tile header.
	protected abstract buildEntry(record: Readonly<TiledStarRawRecord>, header: TiledStarFileHeader, area: number): T

	// Opens an in-memory file collection for one database family.
	open(files: TiledStarFiles, database: DB = this.#database): this {
		if (!files) {
			throw new Error('missing file collection')
		}

		this.#files = files
		this.#database = database
		this.#opened = this.hasAnyAreaFile()

		if (!this.#opened) {
			throw new Error(`no ${this.geometry.extension} files were found for ${database}`)
		}

		return this
	}

	// Clears cached tile buffers and resets the open state.
	close() {
		this.#areas.clear()
		this.#files = undefined
		this.#opened = false
	}

	[Symbol.dispose]() {
		this.close()
	}

	// Returns a normalized entry from its synthetic identifier, or undefined when absent.
	async get(database: DB, area: number, recordNumber: number): Promise<T | undefined> {
		this.#assertOpen()

		if (database !== this.#database) return undefined
		validateTiledStarRecordNumber(recordNumber)

		const loaded = await this.loadArea(area)
		if (!loaded) return undefined

		const cursor = createTiledStarRawRecord()

		// Walk records tracking only the raw cursor; materialize a single entry for the matching record.
		for (const record of scanTiledStarRecords(loaded.header, loaded.buffer, cursor)) {
			if (record.recordNumber === recordNumber) {
				return this.buildEntry(record, loaded.header, area)
			}
		}

		return undefined
	}

	// Streams tile candidates touched by the normalized query boxes.
	protected async *streamCandidateEntries(query: NormalizedStarCatalogQuery) {
		this.#assertOpen()

		const cursor = createTiledStarRawRecord()

		for (const area of touchedTiledStarAreas(this.geometry, query)) {
			const loaded = await this.loadArea(area)
			if (!loaded) continue

			for (const record of scanTiledStarRecords(loaded.header, loaded.buffer, cursor)) {
				const rightAscension = record.raRaw * TILED_STAR_RA_SCALE
				const declination = record.decRaw * TILED_STAR_DEC_SCALE

				// Reject on raw-derived coordinates before allocating; only survivors become entries.
				if (!matchesPreselectionBoxes(rightAscension, declination, query.preselectionBoxes)) continue
				yield this.buildEntry(record, loaded.header, area)
			}
		}
	}

	// Ensures the catalog was opened before serving queries.
	#assertOpen() {
		if (!this.#opened) {
			throw new Error(`${this.formatLabel} catalog is not open`)
		}
	}

	// Checks whether the source contains at least one tile for the selected database.
	hasAnyAreaFile() {
		const prefix = `${this.#database}_`
		const suffix = this.geometry.extension

		if (this.#files instanceof Map) {
			for (const key of this.#files.keys()) {
				if (key.startsWith(prefix) && key.endsWith(suffix)) return true
			}
		} else if (this.#files) {
			for (const key of Object.keys(this.#files)) {
				if (key.startsWith(prefix) && key.endsWith(suffix)) return true
			}
		}

		return false
	}

	// Loads and caches one tile lazily. Concurrent calls for the same area share a single in-flight
	// promise, so the tile is read and parsed only once. A rejected load is evicted so a later call can retry.
	loadArea(area: number): Promise<TiledStarLoadedArea | undefined> {
		const cached = this.#areas.get(area)
		if (cached !== undefined) return cached

		const promise = this.#readArea(area)
		this.#areas.set(area, promise)
		promise.catch(() => {
			// Drop a failed load so the failure is not cached permanently.
			if (this.#areas.get(area) === promise) {
				this.#areas.delete(area)
			}
		})

		return promise
	}

	// Resolves and parses one tile buffer, returning undefined when the tile file is absent.
	async #readArea(area: number): Promise<TiledStarLoadedArea | undefined> {
		const file = lookupTiledStarArea(this.geometry, area)
		const source = this.#resolveFile(`${this.#database}_${file.fileName}`)

		if (source === undefined) return undefined

		const buffer = await bufferFromTiledStarFile(source)
		return { ...file, header: readTiledStarHeader(buffer, this.defaultEpoch, this.formatLabel), buffer }
	}

	// Resolves one archive member by its expected database-prefixed key.
	#resolveFile(key: string) {
		if (this.#files instanceof Map) {
			return this.#files.get(key)
		}

		return this.#files?.[key]
	}
}
