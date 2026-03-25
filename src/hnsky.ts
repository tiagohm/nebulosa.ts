import type { Angle } from './angle'
import { normalizeAngle, normalizePI } from './angle'
import { PIOVERTWO, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogEntry, type StarCatalogRaDecBox } from './star.catalog'
import { NumberComparator } from './util'

const HNSKY_290_HEADER_SIZE = 110
const HNSKY_290_RA_SCALE = TAU / 0xffffff
const HNSKY_290_DEC_SCALE = PIOVERTWO / 0x7fffff
const HNSKY_290_HEADER_MAG_OFFSET = 16
const HNSKY_290_HEADER_DEC_OFFSET = 128
const HNSKY_290_MIN_AREA_FRACTION = 0.01
const HNSKY_290_BUFFER_SIZE = 1024 * 64
const HNSKY_EPOCH = 2000
const HNSKY_ID_PATTERN = /^HNSKY:(g14|g16):(\d{1,3}):(\d+)$/i
const FULL_CIRCLE = TAU
const GEOMETRY_EPSILON = 1e-12

const HNSKY_290_RING_COUNTS = [1, 4, 8, 12, 16, 20, 24, 28, 32, 32, 28, 24, 20, 16, 12, 8, 4, 1] as const

const HNSKY_290_AREA_OFFSETS = [0, 1, 5, 13, 25, 41, 61, 85, 113, 145, 177, 205, 229, 249, 265, 277, 285, 289] as const

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

export type Hnsky290Database = 'g14' | 'g16'

export type Hnsky290File = Pick<File, 'arrayBuffer'> | Buffer

export type Hnsky290Files = Map<string, Hnsky290File> | Record<string, Hnsky290File>

export type HnskyRecordSize = 5 | 6 | 7 | 9 | 10 | 11

export interface Hnsky290FileHeader {
	readonly description: string
	readonly recordSize: HnskyRecordSize
}

export interface Hnsky290Area {
	readonly area: number
	readonly ring: number
	readonly index: number
	readonly fileName: string
	readonly fraction: number
}

export interface Hnsky290RegionQuery extends EquatorialCoordinate {
	radius: Angle
	magnitudeLimit?: number
}

export interface Hnsky290Designation {
	readonly value: number
	readonly catalog: 'TYC' | 'UCAC4'
	readonly region: number
	readonly star: number
	readonly component?: 1 | 2 | 3
	readonly label: string
}

export interface Hnsky290Star extends Readonly<EquatorialCoordinate> {
	readonly area: number
	readonly magnitude: number
	readonly bpRp?: number
	readonly designation?: Hnsky290Designation
}

export interface Hnsky290SearchResult {
	readonly areas: readonly Hnsky290Area[]
	readonly headers: readonly (Hnsky290FileHeader & Hnsky290Area)[]
	readonly stars: readonly Hnsky290Star[]
}

export interface HnskyCatalogEntry extends StarCatalogEntry {
	readonly area: number
	readonly recordNumber: number
	readonly magnitude: number
	readonly bpRp?: number
	readonly designation?: Hnsky290Designation
}

interface Hnsky290BandArea {
	readonly area: number
	readonly spaceEast: number
	readonly spaceWest: number
	readonly spaceNorth: number
	readonly spaceSouth: number
}

interface DecodedHnsky290Star extends Hnsky290Star {
	readonly recordNumber: number
}

interface Hnsky290LoadedArea extends Hnsky290Area {
	readonly header: Hnsky290FileHeader
	readonly buffer: Buffer
}

// Computes the HNSKY ring number and file index for a 1-based area number.
export function hnsky290AreaFile(area: number): Hnsky290Area {
	if (!Number.isInteger(area) || area < 1 || area > 290) {
		throw new RangeError(`invalid HNSKY .290 area: ${area}`)
	}

	let ring = 0
	let offset = 0

	for (; ring < HNSKY_290_RING_COUNTS.length; ring++) {
		const count = HNSKY_290_RING_COUNTS[ring]

		if (area <= offset + count) {
			const index = area - offset
			const fileName = `${(ring + 1).toFixed(0).padStart(2, '0')}${index.toFixed(0).padStart(2, '0')}.290`
			return { area, ring: ring + 1, index, fileName, fraction: 0 }
		}

		offset += count
	}

	throw new RangeError(`invalid HNSKY .290 area: ${area}`)
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

// Formats a stable synthetic HNSKY catalog identifier.
export function formatHnskyId(database: Hnsky290Database, area: number, recordNumber: number) {
	return `HNSKY:${database}:${area}:${recordNumber}`
}

// Parses a synthetic HNSKY catalog identifier.
export function parseHnskyId(id: string): readonly [Hnsky290Database, number, number] {
	const match = HNSKY_ID_PATTERN.exec(id.trim())

	if (!match) {
		throw new Error(`invalid HNSKY identifier: ${id}`)
	}

	const area = +match[2]
	const recordNumber = +match[3]
	return [match[1].toLowerCase() as Hnsky290Database, hnsky290AreaFile(area).area, validateHnskyRecordNumber(recordNumber)] as const
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

	for (const star of decodeHnsky290AreaRecords(header, buffer, area)) {
		if (Number.isFinite(magnitudeLimit) && star.magnitude > magnitudeLimit!) break

		const deltaRa = Math.abs(normalizePI(star.rightAscension - rightAscension))

		// Match the original square-field visibility test used by HNSKY.
		if (Math.abs(deltaRa * cosDeclination) < radius && Math.abs(star.declination - declination) < radius) {
			yield star
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
	const indexByArea = new Map<number, number>()

	for (const { area, fraction } of corners) {
		if (fraction < HNSKY_290_MIN_AREA_FRACTION) continue

		const known = indexByArea.get(area.area)

		if (known === undefined) {
			const file = hnsky290AreaFile(area.area)
			indexByArea.set(area.area, unique.length)
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

	for (const area of areas) {
		const file = get(`${database}_${area.fileName}`)

		if (file === undefined) continue

		const buffer = Buffer.isBuffer(file) ? file : Buffer.from(await file.arrayBuffer())
		const header = readHnsky290Header(buffer)
		headers.push(Object.assign(header, area))

		for (const star of readHnsky290Area(header, buffer, area.area, query)) {
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
export class HnskyCatalog extends BaseStarCatalog {
	readonly #areas = new Map<number, Hnsky290LoadedArea | null>()

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
	async get(id: string): Promise<HnskyCatalogEntry | undefined> {
		this.assertOpen()

		const [database, area, recordNumber] = parseHnskyId(id)
		if (database !== this.#database) return undefined

		const loaded = await this.loadArea(area)
		if (!loaded) return undefined

		for (const star of decodeHnsky290AreaRecords(loaded.header, loaded.buffer, area)) {
			if (star.recordNumber === recordNumber) {
				return toHnskyCatalogEntry(this.#database, star)
			}
		}

		return undefined
	}

	// Streams tile candidates touched by the normalized query boxes.
	protected async *streamCandidateEntries(query: NormalizedStarCatalogQuery): AsyncIterable<StarCatalogEntry> {
		this.assertOpen()

		for (const area of touchedHnsky290Areas(query)) {
			const loaded = await this.loadArea(area)
			if (!loaded) continue

			for (const star of decodeHnsky290AreaRecords(loaded.header, loaded.buffer, area)) {
				if (!matchesPreselectionBoxes(star.rightAscension, star.declination, query.preselectionBoxes)) continue
				yield toHnskyCatalogEntry(this.#database, star)
			}
		}
	}

	// Ensures the catalog was opened before serving queries.
	private assertOpen() {
		if (!this.#opened) {
			throw new Error('HNSKY catalog is not open')
		}
	}

	// Checks whether the source contains at least one tile for the selected database.
	private hasAnyAreaFile() {
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

	// Loads and caches one .290 tile lazily.
	private async loadArea(area: number): Promise<Hnsky290LoadedArea | undefined> {
		const cached = this.#areas.get(area)
		if (cached !== undefined) return cached || undefined

		const file = hnsky290AreaFile(area)
		const source = this.resolveFile(`${this.#database}_${file.fileName}`)

		if (source === undefined) {
			this.#areas.set(area, null)
			return undefined
		}

		const buffer = Buffer.isBuffer(source) ? source : Buffer.from(await source.arrayBuffer())
		const loaded = { ...file, header: readHnsky290Header(buffer), buffer }
		this.#areas.set(area, loaded)
		return loaded
	}

	// Resolves one archive member by its expected database-prefixed key.
	private resolveFile(key: string) {
		if (this.#files instanceof Map) {
			return this.#files.get(key)
		}

		return this.#files?.[key]
	}
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
		return { area: 290, spaceEast: TAU, spaceWest: TAU, spaceNorth: HNSKY_290_DEC_BOUNDARIES[18] - HNSKY_290_DEC_BOUNDARIES[17], spaceSouth: HNSKY_290_DEC_BOUNDARIES[18] - HNSKY_290_DEC_BOUNDARIES[17] }
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
		return { area: band === 0 ? 1 : 290, spaceEast: TAU, spaceWest: TAU, spaceNorth: northBoundary - declination, spaceSouth: declination - southBoundary }
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

// Decodes a compact record that inherits declination high bits and magnitude from a header record.
function decodeCompactStar(area: number, raRaw: number, decLow: number, decMid: number, decHigh: number, magnitude: number, bpRp?: number, designationValue?: number): Hnsky290Star {
	return decodeStar(area, raRaw, decodeSigned24(decLow, decMid, decHigh), magnitude, bpRp, designationValue)
}

// Decodes a full record that stores the complete three-byte declination in the record itself.
function decodeFullStar(area: number, raRaw: number, decLow: number, decMid: number, decHigh: number, magnitude: number, bpRp?: number, designationValue?: number): Hnsky290Star {
	return decodeStar(area, raRaw, decodeSigned24(decLow, decMid, decHigh), magnitude, bpRp, designationValue)
}

// Converts the packed .290 coordinates into an equatorial star entry.
function decodeStar(area: number, raRaw: number, decRaw: number, magnitude: number, bpRp?: number, designationValue?: number): Hnsky290Star {
	const rightAscension = raRaw * HNSKY_290_RA_SCALE
	const declination = decRaw * HNSKY_290_DEC_SCALE
	const designation = designationValue === undefined ? undefined : decodeHnsky290Designation(designationValue)
	return { area, rightAscension, declination, magnitude, bpRp, designation }
}

// Decodes all star records from one tile while preserving their raw record numbers.
function* decodeHnsky290AreaRecords(header: Hnsky290FileHeader, buffer: Buffer, area: number): Generator<DecodedHnsky290Star, void> {
	const { recordSize } = header
	let start = HNSKY_290_HEADER_SIZE
	const end = buffer.byteLength - recordSize
	let currentMagnitude = Number.NaN
	let currentDecHigh = 0

	while (start < end) {
		const offset = start
		const recordNumber = (offset - HNSKY_290_HEADER_SIZE) / recordSize + 1
		const raRaw = buffer.readUIntLE(offset + (recordSize >= 9 ? 4 : 0), 3)
		let star: Hnsky290Star | undefined

		start += recordSize

		switch (recordSize) {
			case 5:
				if (raRaw === 0xffffff) {
					currentDecHigh = buffer[offset + 3] - HNSKY_290_HEADER_DEC_OFFSET
					currentMagnitude = (buffer[offset + 4] - HNSKY_290_HEADER_MAG_OFFSET) / 10
				} else {
					star = decodeCompactStar(area, raRaw, buffer[offset + 3], buffer[offset + 4], currentDecHigh, currentMagnitude)
				}

				break
			case 6:
				if (raRaw === 0xffffff) {
					currentDecHigh = buffer[offset + 3] - HNSKY_290_HEADER_DEC_OFFSET
					currentMagnitude = (buffer[offset + 4] - HNSKY_290_HEADER_MAG_OFFSET) / 10
				} else {
					star = decodeCompactStar(area, raRaw, buffer[offset + 3], buffer[offset + 4], currentDecHigh, currentMagnitude, buffer.readInt8(offset + 5) / 10)
				}

				break
			case 7: {
				star = decodeFullStar(area, raRaw, buffer[offset + 3], buffer[offset + 4], buffer.readInt8(offset + 5), buffer.readInt8(offset + 6) / 10)
				break
			}
			case 9:
				if (raRaw === 0xffffff) {
					currentDecHigh = buffer[offset + 7] - HNSKY_290_HEADER_DEC_OFFSET
					currentMagnitude = (buffer[offset + 8] - HNSKY_290_HEADER_MAG_OFFSET) / 10
				} else {
					star = decodeCompactStar(area, raRaw, buffer[offset + 7], buffer[offset + 8], currentDecHigh, currentMagnitude, undefined, buffer.readInt32LE(offset))
				}

				break
			case 10:
				if (raRaw === 0xffffff) {
					currentMagnitude = buffer.readInt8(offset + 9) / 10
				} else {
					star = decodeFullStar(area, raRaw, buffer[offset + 7], buffer[offset + 8], buffer.readInt8(offset + 9), currentMagnitude, undefined, buffer.readInt32LE(offset))
				}

				break
			case 11: {
				star = decodeFullStar(area, raRaw, buffer[offset + 7], buffer[offset + 8], buffer.readInt8(offset + 9), buffer.readInt8(offset + 10) / 10, undefined, buffer.readInt32LE(offset))
				break
			}
		}

		if (!star) continue

		yield { ...star, recordNumber }
	}
}

// Decodes a signed 24-bit integer from its low, middle, and signed high bytes.
function decodeSigned24(low: number, middle: number, high: number) {
	return (high << 16) | (middle << 8) | low
}

// Maps a decoded tile star into the generic star catalog shape.
function toHnskyCatalogEntry(database: Hnsky290Database, star: DecodedHnsky290Star): HnskyCatalogEntry {
	return {
		id: formatHnskyId(database, star.area, star.recordNumber),
		epoch: HNSKY_EPOCH,
		recordNumber: star.recordNumber,
		area: star.area,
		rightAscension: star.rightAscension,
		declination: star.declination,
		magnitude: star.magnitude,
		bpRp: star.bpRp,
		designation: star.designation,
	}
}

// Computes the set of tiles touched by the query preselection boxes.
function touchedHnsky290Areas(query: NormalizedStarCatalogQuery) {
	const areas = new Set<number>()

	for (const box of query.preselectionBoxes) {
		for (let area = 1; area <= 290; area++) {
			if (areaIntersectsRaDecBox(area, box)) {
				areas.add(area)
			}
		}
	}

	return [...areas].sort(NumberComparator)
}

// Checks whether a star lies inside any coarse preselection box.
function matchesPreselectionBoxes(rightAscension: Angle, declination: Angle, boxes: readonly StarCatalogRaDecBox[]) {
	return boxes.some((box) => matchesRaDecBox(rightAscension, declination, box))
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
	const file = hnsky290AreaFile(area)
	const band = file.ring - 1
	const minDEC = HNSKY_290_DEC_BOUNDARIES[band]!
	const maxDEC = HNSKY_290_DEC_BOUNDARIES[band + 1]!
	const count = HNSKY_290_RING_COUNTS[band]!

	if (count === 1) {
		return { minRA: 0, maxRA: FULL_CIRCLE, minDEC, maxDEC }
	}

	const width = FULL_CIRCLE / count
	const minRA = (file.index - 1) * width
	return { minRA, maxRA: minRA + width, minDEC, maxDEC }
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
