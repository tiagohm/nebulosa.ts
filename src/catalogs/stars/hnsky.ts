import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import { PIOVERTWO, TAU } from '../../core/constants'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogEntry, type StarCatalogRaDecBox } from './catalog'

// Reader and star-catalog adapter for HNSKY ".290" tiled binary star archives. The sky is split into
// 290 declination-band areas; this module decodes the per-area packed records (variable record sizes,
// header-relative magnitude/declination deltas), resolves which tiles a query touches, and exposes the
// data through both a direct field search and the generic BaseStarCatalog contract. Angles are J2000
// radians; record numbers are synthetic per-tile identifiers.

// Size of the shared 110-byte per-tile header.
const HNSKY_290_HEADER_SIZE = 110
// Scale from the packed 24-bit right ascension to radians (full circle over 2^24-1).
const HNSKY_290_RA_SCALE = TAU / 0xffffff
// Scale from the packed signed 24-bit declination to radians (PI/2 over 2^23-1).
const HNSKY_290_DEC_SCALE = PIOVERTWO / 0x7fffff
// Bias subtracted from a header record's packed magnitude byte.
const HNSKY_290_HEADER_MAG_OFFSET = 16
// Bias subtracted from a header record's packed declination high byte.
const HNSKY_290_HEADER_DEC_OFFSET = 128
// Minimum overlap fraction for a tile to be considered touched by a square field query.
const HNSKY_290_MIN_AREA_FRACTION = 0.01
// Read-buffer size, in bytes.
const HNSKY_290_BUFFER_SIZE = 1024 * 64
// Catalog epoch for all HNSKY entries (J2000).
const HNSKY_EPOCH = 2000
// Full-circle angle (TAU), for whole-band tiles.
const FULL_CIRCLE = TAU
// Angular tolerance for tile/box intersection tests, radians.
const GEOMETRY_EPSILON = 1e-12
// Total number of .290 sky areas.
const HNSKY_290_AREA_COUNT = 290

// Number of RA cells (tiles) in each of the 18 declination bands.
const HNSKY_290_RING_COUNTS = [1, 4, 8, 12, 16, 20, 24, 28, 32, 32, 28, 24, 20, 16, 12, 8, 4, 1] as const

// Cumulative area-number offset at the start of each declination band.
const HNSKY_290_AREA_OFFSETS = [0, 1, 5, 13, 25, 41, 61, 85, 113, 145, 177, 205, 229, 249, 265, 277, 285, 289] as const

// Declination boundaries (radians) between the 18 bands, from the south to the north pole.
export const HNSKY_290_DEC_BOUNDARIES = [
	-PIOVERTWO,
	-1.4875825298262766,
	-1.3205739884259363,
	-1.151794878239301,
	-0.9799125667090463,
	-0.8034034496024828,
	-0.6203423859368793,
	-0.4281907604698024,
	-0.2233034646423629,
	0,
	0.2233034646423629,
	0.4281907604698024,
	0.6203423859368793,
	0.8034034496024828,
	0.9799125667090463,
	1.151794878239301,
	1.3205739884259363,
	1.4875825298262766,
	PIOVERTWO,
] as const satisfies readonly Angle[]

// Precomputed area descriptors (ring/index/file name) for all 290 tiles.
const HNSKY_290_AREAS = buildHnsky290Areas()
// Precomputed coarse RA/Dec bounds for all 290 tiles.
const HNSKY_290_AREA_BOUNDS = buildHnsky290AreaBounds()

// Supported HNSKY database families (limiting magnitude G14 or G16).
export type Hnsky290Database = 'g14' | 'g16'

// A single .290 archive member: a File-like or a raw buffer source.
export type Hnsky290File = Pick<File, 'arrayBuffer'> | Bun.BufferSource

// A collection of .290 archive members keyed by database-prefixed file name.
export type Hnsky290Files = Map<string, Hnsky290File> | Record<string, Hnsky290File>

// Allowed per-record byte sizes in a .290 tile.
export type HnskyRecordSize = 5 | 6 | 7 | 9 | 10 | 11

// Parsed header of one .290 tile.
export interface Hnsky290FileHeader {
	// Free-text tile description.
	readonly description: string
	// Bytes per star record in this tile.
	readonly recordSize: HnskyRecordSize
}

// Descriptor of one .290 sky area (tile).
export interface Hnsky290Area {
	// 1-based area number.
	readonly area: number
	// 1-based declination band (ring) number.
	readonly ring: number
	// 1-based RA cell index within the ring.
	readonly index: number
	// File name of the tile (without the database prefix).
	readonly fileName: string
	// Fraction of the query field this tile covers (0 when not part of a query).
	readonly fraction: number
}

// A square-field region query around a center.
export interface Hnsky290RegionQuery extends EquatorialCoordinate {
	// Half-field size (square half-width), radians.
	radius: Angle
	// Optional faintest magnitude to include.
	magnitudeLimit?: number
}

// A typed catalog designation decoded from a packed .290 identifier.
export interface Hnsky290Designation {
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

// One star decoded from a .290 tile.
export interface Hnsky290Star extends Readonly<EquatorialCoordinate> {
	// Area (tile) the star belongs to.
	readonly area: number
	// Magnitude.
	readonly magnitude: number
	// Gaia BP-RP color index, when present.
	readonly bpRp?: number
	// Decoded catalog designation, when present.
	readonly designation?: Hnsky290Designation
}

// Result of a field search: the touched areas, their headers, and the merged star list.
export interface Hnsky290SearchResult {
	readonly areas: readonly Hnsky290Area[]
	readonly headers: readonly (Hnsky290FileHeader & Hnsky290Area)[]
	readonly stars: readonly Hnsky290Star[]
}

// A star exposed through the generic catalog contract, carrying its tile and record number.
export interface HnskyCatalogEntry extends StarCatalogEntry {
	readonly area: number
	readonly recordNumber: number
	readonly magnitude: number
	readonly bpRp?: number
	readonly designation?: Hnsky290Designation
}

// Internal: a tile plus the distances from a query point to its band/cell borders.
interface Hnsky290BandArea {
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

// Internal: a decoded star retaining its 1-based record number within the tile.
interface DecodedHnsky290Star extends Hnsky290Star {
	readonly recordNumber: number
}

// Internal: a reusable scan cursor holding one record's packed fields. It is mutated in place while a tile
// is scanned so per-record decoding allocates nothing; a star object is created only when one is emitted.
// The `has*` flags mark which optional fields the record format actually carries.
interface Hnsky290RawRecord {
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
	// Gaia BP-RP color index; meaningful only when hasBpRp is true.
	bpRp: number
	// True when the record format carries a color index.
	hasBpRp: boolean
}

// Internal: a lazily loaded tile with its parsed header and raw buffer.
interface Hnsky290LoadedArea extends Hnsky290Area {
	readonly header: Hnsky290FileHeader
	readonly buffer: Buffer
}

// Computes the HNSKY ring number and file index for a 1-based area number.
export function hnsky290AreaFile(area: number): Hnsky290Area {
	return { ...lookupHnsky290Area(area) }
}

// Returns the descriptor for a 1-based area number, throwing if out of range.
function lookupHnsky290Area(area: number) {
	if (!Number.isInteger(area) || area < 1 || area > HNSKY_290_AREA_COUNT) {
		throw new RangeError(`invalid HNSKY .290 area: ${area}`)
	}

	return HNSKY_290_AREAS[area - 1]
}

// Builds the 290 area descriptors (ring, index, file name) by walking the band ring counts.
function buildHnsky290Areas(): readonly Hnsky290Area[] {
	const areas: Hnsky290Area[] = []
	let offset = 0

	for (let ring = 0; ring < HNSKY_290_RING_COUNTS.length; ring++) {
		const count = HNSKY_290_RING_COUNTS[ring]

		for (let index = 1; index <= count; index++) {
			const area = offset + index
			const fileName = `${(ring + 1).toFixed(0).padStart(2, '0')}${index.toFixed(0).padStart(2, '0')}.290`
			areas.push({ area, ring: ring + 1, index, fileName, fraction: 0 })
		}

		offset += count
	}

	return areas
}

// Builds the coarse RA/Dec bounding box of every tile from its band and RA-cell position.
function buildHnsky290AreaBounds(): readonly StarCatalogRaDecBox[] {
	return HNSKY_290_AREAS.map((file) => {
		const band = file.ring - 1
		const minDEC = HNSKY_290_DEC_BOUNDARIES[band]
		const maxDEC = HNSKY_290_DEC_BOUNDARIES[band + 1]
		const count = HNSKY_290_RING_COUNTS[band]

		if (count === 1) {
			return { minRA: 0, maxRA: FULL_CIRCLE, minDEC, maxDEC }
		}

		const width = FULL_CIRCLE / count
		const minRA = (file.index - 1) * width
		return { minRA, maxRA: minRA + width, minDEC, maxDEC }
	})
}

// Decodes a stored .290 designation into a typed catalog identifier.
export function decodeHnsky290Designation(value: number): Hnsky290Designation {
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

// Reads the shared 110-byte .290 header and validates the record size.
export function readHnsky290Header(header: Buffer): Hnsky290FileHeader {
	const size = header[HNSKY_290_HEADER_SIZE - 1] === 0x20 ? 11 : header[HNSKY_290_HEADER_SIZE - 1]

	if (size !== 5 && size !== 6 && size !== 7 && size !== 9 && size !== 10 && size !== 11) {
		throw new Error(`unsupported HNSKY .290 record size: ${size}`)
	}

	const description = header
		.toString('latin1', 0, HNSKY_290_HEADER_SIZE - 1)
		.replaceAll('\0', '')
		.trimEnd()

	return { description, recordSize: size }
}

// Yields all stars from one .290 tile that fall inside the square field query.
export function* readHnsky290Area(header: Hnsky290FileHeader, buffer: Buffer, area: number, query: Readonly<Hnsky290RegionQuery>): Generator<Hnsky290Star, void> {
	const { rightAscension, declination, radius, magnitudeLimit } = query
	const cosDeclination = Math.cos(declination)
	const maxMagnitude = Number.isFinite(magnitudeLimit) ? magnitudeLimit! : Number.POSITIVE_INFINITY
	const cursor = createHnsky290RawRecord()

	for (const record of scanHnsky290Records(header, buffer, cursor)) {
		// Records are stored in ascending magnitude order, so once the limit is exceeded none remain.
		if (record.magnitude > maxMagnitude) break

		const rightAscensionOfStar = record.raRaw * HNSKY_290_RA_SCALE
		const declinationOfStar = record.decRaw * HNSKY_290_DEC_SCALE
		const deltaRa = Math.abs(normalizePI(rightAscensionOfStar - rightAscension))

		// Match the original square-field visibility test used by HNSKY. Materialize (and decode the
		// designation) only for a star that actually falls inside the field.
		if (Math.abs(deltaRa * cosDeclination) < radius && Math.abs(declinationOfStar - declination) < radius) {
			yield materializeHnsky290Star(area, record)
		}
	}
}

// Finds the 1 to 4 .290 tiles intersecting the requested square field.
export function findHnsky290Areas(rightAscension: Angle, declination: Angle, radius: Angle): readonly Hnsky290Area[] {
	const diameter = radius * 2
	const northDeclination = declination + radius
	const southDeclination = declination - radius
	const eastNorth = normalizeAngle(rightAscension + projectRaHalfSpan(radius, northDeclination))
	const westNorth = normalizeAngle(rightAscension - projectRaHalfSpan(radius, northDeclination))
	const eastSouth = normalizeAngle(rightAscension + projectRaHalfSpan(radius, southDeclination))
	const westSouth = normalizeAngle(rightAscension - projectRaHalfSpan(radius, southDeclination))

	const corners = [
		{ area: areaAndBoundaries(eastNorth, northDeclination), fraction: 0 },
		{ area: areaAndBoundaries(westNorth, northDeclination), fraction: 0 },
		{ area: areaAndBoundaries(eastSouth, southDeclination), fraction: 0 },
		{ area: areaAndBoundaries(westSouth, southDeclination), fraction: 0 },
	]

	const diameter2 = diameter * diameter
	corners[0].fraction = (Math.min(corners[0].area.spaceWest, diameter) * Math.min(corners[0].area.spaceSouth, diameter)) / diameter2
	corners[1].fraction = (Math.min(corners[1].area.spaceEast, diameter) * Math.min(corners[1].area.spaceSouth, diameter)) / diameter2
	corners[2].fraction = (Math.min(corners[2].area.spaceWest, diameter) * Math.min(corners[2].area.spaceNorth, diameter)) / diameter2
	corners[3].fraction = (Math.min(corners[3].area.spaceEast, diameter) * Math.min(corners[3].area.spaceNorth, diameter)) / diameter2

	const unique: Hnsky290Area[] = []

	for (const { area, fraction } of corners) {
		if (fraction < HNSKY_290_MIN_AREA_FRACTION) continue

		let known = -1

		for (let i = 0; i < unique.length; i++) {
			if (unique[i].area === area.area) {
				known = i
				break
			}
		}

		if (known < 0) {
			const file = lookupHnsky290Area(area.area)
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

// Reads all stars inside the requested field from the intersecting .290 tiles.
export async function findHnsky290Region(files: Hnsky290Files, database: Hnsky290Database, query: Readonly<Hnsky290RegionQuery>): Promise<Hnsky290SearchResult> {
	const areas = findHnsky290Areas(query.rightAscension, query.declination, query.radius)
	const headers: Array<Hnsky290FileHeader & Hnsky290Area> = []
	const stars: Hnsky290Star[] = []

	const get = files instanceof Map ? (key: string) => files.get(key) : (key: string) => files[key]

	// Resolve and parse every intersecting tile in parallel so a first query does not serialize File I/O.
	// A square field touches at most four tiles, so the fan-out is bounded and needs no concurrency limit.
	const loaded = await Promise.all(
		areas.map(async (area) => {
			const file = get(`${database}_${area.fileName}`)
			if (file === undefined) return undefined
			const buffer = await bufferFromHnsky290File(file)
			return { area, header: readHnsky290Header(buffer), buffer }
		}),
	)

	for (const tile of loaded) {
		if (tile === undefined) continue

		headers.push(Object.assign(tile.header, tile.area))

		for (const star of readHnsky290Area(tile.header, tile.buffer, tile.area.area, query)) {
			stars.push(star)
		}
	}

	// Return merged results in brightness order across all intersecting tiles.
	stars.sort(compareStarsByMagnitude)

	return { areas, headers, stars }
}

// Returns only the stars from the requested field.
export async function findHnsky290Stars(files: Hnsky290Files, database: Hnsky290Database, query: Readonly<Hnsky290RegionQuery>): Promise<readonly Hnsky290Star[]> {
	return (await findHnsky290Region(files, database, query)).stars
}

// Creates and opens an HNSKY catalog in one step.
export function openHnskyCatalog(files: Hnsky290Files, database: Hnsky290Database) {
	return new HnskyCatalog().open(files, database)
}

// Exposes HNSKY .290 archives through the generic star catalog contract.
export class HnskyCatalog extends BaseStarCatalog<HnskyCatalogEntry> {
	// Per-area load cache keyed by area number. Stores the in-flight (or settled) load promise so that
	// concurrent requests for the same tile share one read and one parse. A resolved `undefined` is a
	// cached negative result (the tile file is absent); a rejected promise is evicted so a retry is possible.
	readonly #areas = new Map<number, Promise<Hnsky290LoadedArea | undefined>>()

	#files?: Hnsky290Files
	#database: Hnsky290Database = 'g14'
	#opened = false

	get database() {
		return this.#database
	}

	// Opens an in-memory HNSKY file collection for one database family.
	open(files: Hnsky290Files, database: Hnsky290Database = 'g14') {
		if (!files) {
			throw new Error('missing HNSKY file collection')
		}

		this.#files = files
		this.#database = database
		this.#opened = this.hasAnyAreaFile()

		if (!this.#opened) {
			throw new Error(`no HNSKY .290 files were found for ${database}`)
		}

		return this
	}

	// Clears cached tile buffers and resets the open state.
	close() {
		this.#areas.clear()
		this.#files = undefined
		this.#opened = false
	}

	// Returns a normalized HNSKY entry from its synthetic identifier.
	async get(database: Hnsky290Database, area: number, recordNumber: number): Promise<HnskyCatalogEntry | undefined> {
		this.#assertOpen()

		if (database !== this.#database) return undefined
		validateHnskyRecordNumber(recordNumber)

		const loaded = await this.loadArea(area)
		if (!loaded) return undefined

		const cursor = createHnsky290RawRecord()

		// Walk records tracking only the raw cursor; materialize a single entry for the matching record.
		for (const record of scanHnsky290Records(loaded.header, loaded.buffer, cursor)) {
			if (record.recordNumber === recordNumber) {
				return materializeHnskyCatalogEntry(area, record)
			}
		}

		return undefined
	}

	// Streams tile candidates touched by the normalized query boxes.
	protected async *streamCandidateEntries(query: NormalizedStarCatalogQuery) {
		this.#assertOpen()

		const cursor = createHnsky290RawRecord()

		for (const area of touchedHnsky290Areas(query)) {
			const loaded = await this.loadArea(area)
			if (!loaded) continue

			for (const record of scanHnsky290Records(loaded.header, loaded.buffer, cursor)) {
				const rightAscension = record.raRaw * HNSKY_290_RA_SCALE
				const declination = record.decRaw * HNSKY_290_DEC_SCALE

				// Reject on raw-derived coordinates before allocating; only survivors become entries.
				if (!matchesPreselectionBoxes(rightAscension, declination, query.preselectionBoxes)) continue
				yield materializeHnskyCatalogEntry(area, record)
			}
		}
	}

	// Ensures the catalog was opened before serving queries.
	#assertOpen() {
		if (!this.#opened) {
			throw new Error('HNSKY catalog is not open')
		}
	}

	// Checks whether the source contains at least one tile for the selected database.
	hasAnyAreaFile() {
		const prefix = `${this.#database}_`
		const suffix = '.290'

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

	// Loads and caches one .290 tile lazily. Concurrent calls for the same area share a single in-flight
	// promise, so the tile is read and parsed only once. A rejected load is evicted so a later call can retry.
	loadArea(area: number): Promise<Hnsky290LoadedArea | undefined> {
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
	async #readArea(area: number): Promise<Hnsky290LoadedArea | undefined> {
		const file = lookupHnsky290Area(area)
		const source = this.#resolveFile(`${this.#database}_${file.fileName}`)

		if (source === undefined) return undefined

		const buffer = await bufferFromHnsky290File(source)
		return { ...file, header: readHnsky290Header(buffer), buffer }
	}

	// Resolves one archive member by its expected database-prefixed key.
	#resolveFile(key: string) {
		if (this.#files instanceof Map) {
			return this.#files.get(key)
		}

		return this.#files?.[key]
	}
}

// Normalizes any supported .290 file source (Buffer, File-like, or BufferSource) into a Buffer.
async function bufferFromHnsky290File(file: Hnsky290File) {
	return Buffer.isBuffer(file) ? file : 'arrayBuffer' in file ? Buffer.from(await file.arrayBuffer()) : ArrayBuffer.isView(file) ? Buffer.from(file.buffer, file.byteOffset, file.byteLength) : Buffer.from(file)
}

// Projects the square half-field from declination space into RA.
function projectRaHalfSpan(halfField: Angle, declination: Angle) {
	const cosDeclination = Math.cos(declination)
	return Math.abs(cosDeclination) < 1e-12 ? 0 : halfField / cosDeclination
}

// Locates the containing .290 area and the distances to its borders.
function areaAndBoundaries(rightAscension: Angle, declination: Angle): Hnsky290BandArea {
	if (declination <= HNSKY_290_DEC_BOUNDARIES[0]) {
		return { area: 1, spaceEast: TAU, spaceWest: TAU, spaceNorth: HNSKY_290_DEC_BOUNDARIES[1] - HNSKY_290_DEC_BOUNDARIES[0], spaceSouth: HNSKY_290_DEC_BOUNDARIES[1] - HNSKY_290_DEC_BOUNDARIES[0] }
	}

	if (declination >= HNSKY_290_DEC_BOUNDARIES[18]) {
		return { area: HNSKY_290_AREA_COUNT, spaceEast: TAU, spaceWest: TAU, spaceNorth: HNSKY_290_DEC_BOUNDARIES[18] - HNSKY_290_DEC_BOUNDARIES[17], spaceSouth: HNSKY_290_DEC_BOUNDARIES[18] - HNSKY_290_DEC_BOUNDARIES[17] }
	}

	let band = 0

	for (let i = 17; i >= 0; i--) {
		if (declination > HNSKY_290_DEC_BOUNDARIES[i]) {
			band = i
			break
		}
	}

	const count = HNSKY_290_RING_COUNTS[band]
	const southBoundary = HNSKY_290_DEC_BOUNDARIES[band]
	const northBoundary = HNSKY_290_DEC_BOUNDARIES[band + 1]

	if (count === 1) {
		return { area: band === 0 ? 1 : HNSKY_290_AREA_COUNT, spaceEast: TAU, spaceWest: TAU, spaceNorth: northBoundary - declination, spaceSouth: declination - southBoundary }
	}

	const rotation = (normalizeAngle(rightAscension) * count) / TAU
	const cell = Math.trunc(rotation)
	const fraction = rotation - cell
	const width = (TAU / count) * Math.cos(declination)

	return {
		area: HNSKY_290_AREA_OFFSETS[band] + cell + 1,
		spaceEast: width * (1 - fraction),
		spaceWest: width * fraction,
		spaceNorth: northBoundary - declination,
		spaceSouth: declination - southBoundary,
	}
}

// Creates a fresh, fully-initialized scan cursor. A stable object shape keeps the reused cursor
// monomorphic for the JIT while it is mutated in place across every record of a tile.
function createHnsky290RawRecord(): Hnsky290RawRecord {
	return { recordNumber: 0, raRaw: 0, decRaw: 0, magnitude: 0, designationValue: 0, hasDesignation: false, bpRp: 0, hasBpRp: false }
}

// Selects the format-specialized record scanner once per tile, avoiding a per-record recordSize switch.
// Each scanner yields the shared `out` cursor filled with the current record's packed fields; the cursor
// is reused across yields, so callers must materialize a star before advancing the iterator.
function scanHnsky290Records(header: Hnsky290FileHeader, buffer: Buffer, out: Hnsky290RawRecord): Generator<Hnsky290RawRecord, void> {
	switch (header.recordSize) {
		case 5:
			return scanHnsky290Records5(buffer, out)
		case 6:
			return scanHnsky290Records6(buffer, out)
		case 7:
			return scanHnsky290Records7(buffer, out)
		case 9:
			return scanHnsky290Records9(buffer, out)
		case 10:
			return scanHnsky290Records10(buffer, out)
		case 11:
			return scanHnsky290Records11(buffer, out)
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

// Scans 5-byte compact records: RA at +0, declination low/mid at +3/+4, magnitude and dec-high inherited
// from the preceding 0xffffff header record. No color or designation.
function* scanHnsky290Records5(buffer: Buffer, out: Hnsky290RawRecord): Generator<Hnsky290RawRecord, void> {
	const end = buffer.byteLength - 5
	let recordNumber = 1
	let magnitude = Number.NaN
	let decHigh = 0
	out.hasDesignation = false
	out.hasBpRp = false

	for (let offset = HNSKY_290_HEADER_SIZE; offset <= end; offset += 5, recordNumber++) {
		const raRaw = readUint24(buffer, offset)

		if (raRaw === 0xffffff) {
			decHigh = buffer[offset + 3] - HNSKY_290_HEADER_DEC_OFFSET
			magnitude = (buffer[offset + 4] - HNSKY_290_HEADER_MAG_OFFSET) / 10
			continue
		}

		out.recordNumber = recordNumber
		out.raRaw = raRaw
		out.decRaw = decodeSigned24(buffer[offset + 3], buffer[offset + 4], decHigh)
		out.magnitude = magnitude
		yield out
	}
}

// Scans 6-byte compact records: like the 5-byte format plus a signed color byte at +5 (BP-RP / 10).
function* scanHnsky290Records6(buffer: Buffer, out: Hnsky290RawRecord): Generator<Hnsky290RawRecord, void> {
	const end = buffer.byteLength - 6
	let recordNumber = 1
	let magnitude = Number.NaN
	let decHigh = 0
	out.hasDesignation = false
	out.hasBpRp = true

	for (let offset = HNSKY_290_HEADER_SIZE; offset <= end; offset += 6, recordNumber++) {
		const raRaw = readUint24(buffer, offset)

		if (raRaw === 0xffffff) {
			decHigh = buffer[offset + 3] - HNSKY_290_HEADER_DEC_OFFSET
			magnitude = (buffer[offset + 4] - HNSKY_290_HEADER_MAG_OFFSET) / 10
			continue
		}

		out.recordNumber = recordNumber
		out.raRaw = raRaw
		out.decRaw = decodeSigned24(buffer[offset + 3], buffer[offset + 4], decHigh)
		out.magnitude = magnitude
		out.bpRp = readInt8(buffer, offset + 5) / 10
		yield out
	}
}

// Scans 7-byte full records: RA at +0, full signed declination at +3/+4/+5, magnitude at +6. Every record
// is a star (no inherited header records).
function* scanHnsky290Records7(buffer: Buffer, out: Hnsky290RawRecord): Generator<Hnsky290RawRecord, void> {
	const end = buffer.byteLength - 7
	let recordNumber = 1
	out.hasDesignation = false
	out.hasBpRp = false

	for (let offset = HNSKY_290_HEADER_SIZE; offset <= end; offset += 7, recordNumber++) {
		out.recordNumber = recordNumber
		out.raRaw = readUint24(buffer, offset)
		out.decRaw = decodeSigned24(buffer[offset + 3], buffer[offset + 4], readInt8(buffer, offset + 5))
		out.magnitude = readInt8(buffer, offset + 6) / 10
		yield out
	}
}

// Scans 9-byte compact records: signed designation at +0, RA at +4, declination low/mid at +7/+8, with
// magnitude and dec-high inherited from the preceding 0xffffff header record.
function* scanHnsky290Records9(buffer: Buffer, out: Hnsky290RawRecord): Generator<Hnsky290RawRecord, void> {
	const end = buffer.byteLength - 9
	let recordNumber = 1
	let magnitude = Number.NaN
	let decHigh = 0
	out.hasDesignation = true
	out.hasBpRp = false

	for (let offset = HNSKY_290_HEADER_SIZE; offset <= end; offset += 9, recordNumber++) {
		const raRaw = readUint24(buffer, offset + 4)

		if (raRaw === 0xffffff) {
			decHigh = buffer[offset + 7] - HNSKY_290_HEADER_DEC_OFFSET
			magnitude = (buffer[offset + 8] - HNSKY_290_HEADER_MAG_OFFSET) / 10
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
function* scanHnsky290Records10(buffer: Buffer, out: Hnsky290RawRecord): Generator<Hnsky290RawRecord, void> {
	const end = buffer.byteLength - 10
	let recordNumber = 1
	let magnitude = Number.NaN
	out.hasDesignation = true
	out.hasBpRp = false

	for (let offset = HNSKY_290_HEADER_SIZE; offset <= end; offset += 10, recordNumber++) {
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
function* scanHnsky290Records11(buffer: Buffer, out: Hnsky290RawRecord): Generator<Hnsky290RawRecord, void> {
	const end = buffer.byteLength - 11
	let recordNumber = 1
	out.hasDesignation = true
	out.hasBpRp = false

	for (let offset = HNSKY_290_HEADER_SIZE; offset <= end; offset += 11, recordNumber++) {
		out.recordNumber = recordNumber
		out.raRaw = readUint24(buffer, offset + 4)
		out.decRaw = decodeSigned24(buffer[offset + 7], buffer[offset + 8], readInt8(buffer, offset + 9))
		out.magnitude = readInt8(buffer, offset + 10) / 10
		out.designationValue = readInt32(buffer, offset)
		yield out
	}
}

// Decodes a signed 24-bit integer from its low, middle, and signed high bytes.
function decodeSigned24(low: number, middle: number, high: number) {
	return (high << 16) | (middle << 8) | low
}

// Materializes a public tile star from the raw scan cursor, converting packed coordinates to J2000
// radians and decoding the catalog designation only when the record format carries one.
function materializeHnsky290Star(area: number, record: Hnsky290RawRecord): DecodedHnsky290Star {
	return {
		area,
		recordNumber: record.recordNumber,
		rightAscension: record.raRaw * HNSKY_290_RA_SCALE,
		declination: record.decRaw * HNSKY_290_DEC_SCALE,
		magnitude: record.magnitude,
		bpRp: record.hasBpRp ? record.bpRp : undefined,
		designation: record.hasDesignation ? decodeHnsky290Designation(record.designationValue) : undefined,
	}
}

// Materializes a generic catalog entry from the raw scan cursor, decoding the designation lazily. Used by
// the streaming/query path so a candidate is turned into an object exactly once, only when it is emitted.
function materializeHnskyCatalogEntry(area: number, record: Hnsky290RawRecord): HnskyCatalogEntry {
	return {
		epoch: HNSKY_EPOCH,
		recordNumber: record.recordNumber,
		area,
		rightAscension: record.raRaw * HNSKY_290_RA_SCALE,
		declination: record.decRaw * HNSKY_290_DEC_SCALE,
		magnitude: record.magnitude,
		bpRp: record.hasBpRp ? record.bpRp : undefined,
		designation: record.hasDesignation ? decodeHnsky290Designation(record.designationValue) : undefined,
	}
}

// Computes the set of tiles touched by the query preselection boxes.
function touchedHnsky290Areas(query: NormalizedStarCatalogQuery) {
	const touched = new Uint8Array(HNSKY_290_AREA_COUNT + 1)

	for (const box of query.preselectionBoxes) {
		for (let area = 1; area <= HNSKY_290_AREA_COUNT; area++) {
			if (!touched[area] && areaIntersectsRaDecBox(area, box)) {
				touched[area] = 1
			}
		}
	}

	const areas: number[] = []

	for (let area = 1; area <= HNSKY_290_AREA_COUNT; area++) {
		if (touched[area]) {
			areas.push(area)
		}
	}

	return areas
}

// Checks whether a star lies inside any coarse preselection box.
function matchesPreselectionBoxes(rightAscension: Angle, declination: Angle, boxes: readonly StarCatalogRaDecBox[]) {
	for (const box of boxes) {
		if (matchesRaDecBox(rightAscension, declination, box)) {
			return true
		}
	}

	return false
}

// Checks whether one HNSKY tile overlaps a non-wrapping RA/Dec box.
function areaIntersectsRaDecBox(area: number, box: StarCatalogRaDecBox) {
	const bounds = hnsky290AreaBounds(area)

	if (box.maxDEC < bounds.minDEC - GEOMETRY_EPSILON || box.minDEC > bounds.maxDEC + GEOMETRY_EPSILON) {
		return false
	}

	if (bounds.maxRA - bounds.minRA >= FULL_CIRCLE - GEOMETRY_EPSILON) {
		return true
	}

	return box.maxRA >= bounds.minRA - GEOMETRY_EPSILON && box.minRA <= bounds.maxRA + GEOMETRY_EPSILON
}

// Computes the coarse RA/Dec bounds of one HNSKY tile.
function hnsky290AreaBounds(area: number): StarCatalogRaDecBox {
	lookupHnsky290Area(area)
	return HNSKY_290_AREA_BOUNDS[area - 1]
}

// Checks whether one point lies inside a non-wrapping RA/Dec box.
function matchesRaDecBox(rightAscension: Angle, declination: Angle, box: StarCatalogRaDecBox) {
	return rightAscension + GEOMETRY_EPSILON >= box.minRA && rightAscension <= box.maxRA + GEOMETRY_EPSILON && declination + GEOMETRY_EPSILON >= box.minDEC && declination <= box.maxDEC + GEOMETRY_EPSILON
}

// Validates a synthetic HNSKY record number.
function validateHnskyRecordNumber(recordNumber: number) {
	if (!Number.isInteger(recordNumber) || recordNumber < 1) {
		throw new RangeError(`invalid HNSKY record number: ${recordNumber}`)
	}

	return recordNumber
}

// Provides a stable merged ordering across tiles.
function compareStarsByMagnitude(a: Hnsky290Star, b: Hnsky290Star) {
	return a.magnitude - b.magnitude || a.area - b.area || normalizePI(a.rightAscension - b.rightAscension)
}
