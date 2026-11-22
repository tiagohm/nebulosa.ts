import fs from 'fs'
import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { circleToPixels, coordToPixel, pixelToBoundary, pixelToCenter } from '../../astronomy/sky/spatial/healpix'
import { type MutVec3, vecAngleUnit } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { buildQuadBand, healpixCellSize, type QuadBand, type QuadBandOptions, quadCellNside } from './quad.builder'
import { type QuadCode, QUAD_CODE_QUANTIZATION, quantizeQuadCodeComponent, QUAD_CODE_MIN } from './quad.code'
import type { QuadIndex, SkyCone } from './quad.index'
import { buildKdTree, type KdTree, searchKdTree } from './quad.kdtree'

// Nebulosa Quad Index (.nqi): one band of quads, or one HEALPix tile of it, in a flat little-endian file that is read
// without parsing. A 512-byte header holds the band, the builder parameters, the provenance and a table of up to 16
// sections, each aligned to 64 bytes so that it maps directly onto a typed array: the reference stars as float32
// unit vectors (own stars, sorted by uniformization cell, then the margin stars that the quads of the tile borrow from
// neighboring tiles), their magnitudes and brightness sweeps, the occupied cells with the offsets of their stars, the
// optional proper motions and catalog source ids, the quads, and their codes quantized to 16 bits in the leaf order of
// a pointer-free k-d tree whose node boxes follow. A tile owns the quads whose backbone midpoint lies in it, so the
// tiles of a band hold every quad once. NebulosaQuadIndex serves a set of tiles of one band as a QuadIndex: tile ids
// live in the high bits of quad and star ids, tiles are mapped (or read where the runtime cannot map files) when first
// touched and released least recently used first. Angles are radians, epochs Julian years, magnitudes in millimag.

// File signature, 8 bytes.
export const QUAD_INDEX_MAGIC = 'NEBQIDX\0'

// Format version written and accepted.
export const QUAD_INDEX_VERSION = 1

// File name extension.
export const QUAD_INDEX_EXTENSION = '.nqi'

// Header size, bytes.
const HEADER_SIZE = 512

// Offset of the section table in the header, bytes.
const SECTION_TABLE_OFFSET = 128

// Bytes per section table entry: kind, CRC32, offset (two u32), length (two u32).
const SECTION_ENTRY_SIZE = 24

// Maximum sections a header describes: the table spans bytes 128..464.
const MAX_SECTIONS = 14

// Offset and size of the source catalog name, ASCII, NUL padded.
const CATALOG_OFFSET = 464
const CATALOG_SIZE = 32

// Section alignment, bytes.
const SECTION_ALIGNMENT = 64

// Largest NSIDE whose nested cell ids fit the unsigned 32-bit cell section: 12·16384² < 2³².
export const QUAD_INDEX_MAX_NSIDE = 16384

// Multiplier separating the tile ordinal from the local id in quad and star ids of a tiled index.
const TILE_ID_FACTOR = 2 ** 32

// Magnitude stored for a star without one.
const NO_MAGNITUDE = 0x7fff

// Default bytes of tiles kept loaded by a NebulosaQuadIndex.
export const DEFAULT_QUAD_INDEX_MAX_LOADED_BYTES = 1024 * 1024 * 1024

// Flag: quad star ids are 32-bit (else 16-bit).
const FLAG_WIDE_QUAD_STARS = 1

// Section kinds.
const STAR_XYZ = 1
const STAR_MAGNITUDE = 2
const STAR_SWEEP = 3
const CELL_IDS = 4
const CELL_OFFSETS = 5
const STAR_PROPER_MOTION = 6
const STAR_SOURCE = 7
const QUAD_STARS_SECTION = 8
const QUAD_CODES = 9
const KD_LOWER = 10
const KD_UPPER = 11

// Header and arrays of one tile, as written and as read back (typed-array views of the file when read).
export interface QuadIndexTile {
	// Shortest and longest backbone AB, radians.
	readonly scaleLower: Angle
	readonly scaleUpper: Angle
	// Positional error of the stars, radians.
	readonly jitter: Angle
	// Epoch of the positions, Julian year.
	readonly epoch: number
	// NSIDE of the uniformization cells.
	readonly nside: number
	// NSIDE of the tiling, 0 for a whole-sky file, and the nested id of this tile.
	readonly tileNside: number
	readonly tileId: number
	// Builder parameters: stars per cell, passes, reuse limits, dedup distance (radians).
	readonly starsPerCell: number
	readonly passes: number
	readonly maxReuse: number
	readonly maxLoosenReuse: number
	readonly dedup: Angle
	// Faintest magnitude of the source catalog, NaN when unknown.
	readonly magnitudeLimit: number
	// Source catalog name, ASCII, at most 32 characters.
	readonly catalog: string
	// Own stars first, then margin stars.
	readonly ownStarCount: number
	// Unit vectors, 3 per star.
	readonly stars: Float32Array
	// Magnitudes in millimag, NO_MAGNITUDE when unknown.
	readonly magnitudes: Int16Array
	// Brightness rank within the uniformization cell.
	readonly sweeps: Uint8Array
	// Occupied cells, ascending, and the offset of their first own star (cellIds.length + 1 entries).
	readonly cellIds: Uint32Array
	readonly cellOffsets: Uint32Array
	// Proper motion dα/dt and dδ/dt per star, radians per year.
	readonly properMotions?: Float32Array
	// Source catalog ids.
	readonly sources?: BigUint64Array
	// Local star ids of each quad in canonical A, B, C, D order, in code-tree order.
	readonly quadStars: Uint16Array | Uint32Array
	// Code tree over the quantized codes.
	readonly codes: KdTree<Uint16Array>
}

// Provenance and position metadata of the tiles built from a band.
export interface QuadIndexTileOptions {
	// NSIDE of the tiling, a power of two not above the band NSIDE; 0 writes one whole-sky file.
	readonly tileNside: number
	// Only these nested tiles are produced; undefined for every tile holding a quad.
	readonly tiles?: readonly number[]
	// Positional error of the stars, radians.
	readonly jitter: Angle
	// Epoch of the positions, Julian year.
	readonly epoch: number
	// Magnitude of each input star (indexed like the band's source indices).
	readonly magnitudes?: ArrayLike<number>
	// Proper motion of each input star, dα/dt and dδ/dt, radians per year, 2 per star.
	readonly properMotions?: ArrayLike<number>
	// Source catalog id of each input star.
	readonly sources?: BigUint64Array
	// Faintest magnitude of the source catalog.
	readonly magnitudeLimit?: number
	// Source catalog name.
	readonly catalog?: string
}

// Nested tile of a cell, for a cell NSIDE and a tile NSIDE (powers of two, tile ≤ cell).
function tileOfCell(cell: number, nside: number, tileNside: number) {
	if (tileNside === 0) return 0
	return Math.floor(cell / (nside / tileNside) ** 2)
}

// Nested cell of a unit vector.
function cellOf(x: number, y: number, z: number, nside: number) {
	const [ra, dec] = eraC2s(x, y, z)
	return coordToPixel(nside, ra, dec)
}

// Splits a band into tiles: each tile holds the quads whose backbone midpoint lies in it, its own kept stars sorted by
// cell, and the margin stars its quads use from other tiles. Tiles without quads are left out.
export function quadIndexTilesFromBand(band: QuadBand, options: QuadIndexTileOptions): QuadIndexTile[] {
	const { nside } = band
	const tileNside = options.tileNside
	if (nside > QUAD_INDEX_MAX_NSIDE) throw new Error(`the band NSIDE ${nside} exceeds ${QUAD_INDEX_MAX_NSIDE}`)
	if (tileNside > nside) throw new Error('the tile NSIDE must not exceed the band NSIDE')

	const starCount = band.sweeps.length
	const starCells = new Float64Array(starCount)
	for (let s = 0; s < starCount; s++) starCells[s] = cellOf(band.stars[s * 3], band.stars[s * 3 + 1], band.stars[s * 3 + 2], nside)

	// Quads per tile by backbone midpoint.
	const quadCount = band.quads.length / 4
	const tileQuads = new Map<number, number[]>()

	for (let q = 0; q < quadCount; q++) {
		const a = band.quads[q * 4] * 3
		const b = band.quads[q * 4 + 1] * 3
		const cell = cellOf(band.stars[a] + band.stars[b], band.stars[a + 1] + band.stars[b + 1], band.stars[a + 2] + band.stars[b + 2], nside)
		const tile = tileOfCell(cell, nside, tileNside)
		const list = tileQuads.get(tile)
		if (list === undefined) tileQuads.set(tile, [q])
		else list.push(q)
	}

	const wanted = options.tiles === undefined ? undefined : new Set(options.tiles)
	const tiles: QuadIndexTile[] = []

	for (const tile of [...tileQuads.keys()].sort((a, b) => a - b)) {
		if (wanted !== undefined && !wanted.has(tile)) continue
		tiles.push(buildTile(band, options, tile, tileQuads.get(tile)!, starCells))
	}

	return tiles
}

// Assembles one tile of a band.
function buildTile(band: QuadBand, options: QuadIndexTileOptions, tile: number, quads: readonly number[], starCells: Float64Array): QuadIndexTile {
	const { nside } = band
	const tileNside = options.tileNside
	const starCount = band.sweeps.length

	// Own stars sorted by cell, keeping brightness order within a cell; then the margin stars the quads use.
	const own: number[] = []
	for (let s = 0; s < starCount; s++) if (tileOfCell(starCells[s], nside, tileNside) === tile) own.push(s)
	own.sort((a, b) => starCells[a] - starCells[b] || a - b)

	const local = new Map<number, number>()
	for (const s of own) local.set(s, local.size)
	const margin: number[] = []

	for (const q of quads) {
		for (let i = 0; i < 4; i++) {
			const s = band.quads[q * 4 + i]
			if (!local.has(s)) {
				local.set(s, local.size)
				margin.push(s)
			}
		}
	}

	const order = [...own, ...margin]
	const count = order.length
	const stars = new Float32Array(count * 3)
	const magnitudes = new Int16Array(count).fill(NO_MAGNITUDE)
	const sweeps = new Uint8Array(count)
	const properMotions = options.properMotions === undefined ? undefined : new Float32Array(count * 2)
	const sources = options.sources === undefined ? undefined : new BigUint64Array(count)

	for (let k = 0; k < count; k++) {
		const s = order[k]
		const input = band.sourceIndices[s]
		stars[k * 3] = band.stars[s * 3]
		stars[k * 3 + 1] = band.stars[s * 3 + 1]
		stars[k * 3 + 2] = band.stars[s * 3 + 2]
		sweeps[k] = band.sweeps[s]
		const magnitude = options.magnitudes?.[input]
		if (magnitude !== undefined && Number.isFinite(magnitude)) magnitudes[k] = Math.max(-32768, Math.min(32766, Math.round(magnitude * 1000)))
		if (properMotions !== undefined) {
			properMotions[k * 2] = options.properMotions![input * 2]
			properMotions[k * 2 + 1] = options.properMotions![input * 2 + 1]
		}
		if (sources !== undefined) sources[k] = options.sources![input]
	}

	// Occupied cells of the own stars.
	const cellIds: number[] = []
	const cellOffsets: number[] = []
	for (let k = 0; k < own.length; k++) {
		const cell = starCells[own[k]]
		if (cellIds.length === 0 || cellIds.at(-1) !== cell) {
			cellIds.push(cell)
			cellOffsets.push(k)
		}
	}
	cellOffsets.push(own.length)

	// Quantized codes in tree order, with their quads.
	const quantized = new Uint16Array(quads.length * 4)
	for (let k = 0; k < quads.length; k++) for (let i = 0; i < 4; i++) quantized[k * 4 + i] = quantizeQuadCodeComponent(band.codes[quads[k] * 4 + i])
	const codes = buildKdTree(quantized, 4)
	const wide = count > 0xffff
	const quadStars = wide ? new Uint32Array(quads.length * 4) : new Uint16Array(quads.length * 4)

	for (let p = 0; p < quads.length; p++) {
		const q = quads[codes.indices[p]]
		for (let i = 0; i < 4; i++) quadStars[p * 4 + i] = local.get(band.quads[q * 4 + i])!
	}

	return {
		scaleLower: band.scaleLower,
		scaleUpper: band.scaleUpper,
		jitter: options.jitter,
		epoch: options.epoch,
		nside,
		tileNside,
		tileId: tileNside === 0 ? 0 : tile,
		starsPerCell: band.starsPerCell,
		passes: band.passes,
		maxReuse: band.maxReuse,
		maxLoosenReuse: band.maxLoosenReuse,
		dedup: band.dedup,
		magnitudeLimit: options.magnitudeLimit ?? Number.NaN,
		catalog: (options.catalog ?? '').slice(0, 32),
		ownStarCount: own.length,
		stars,
		magnitudes,
		sweeps,
		cellIds: Uint32Array.from(cellIds),
		cellOffsets: Uint32Array.from(cellOffsets),
		properMotions,
		sources,
		quadStars,
		codes: { ...codes, indices: new Uint32Array(0) },
	}
}

// Name of a tile file: band minimum in arcseconds, tiling and tile, for example nqi-480-4-0123.nqi.
export function quadIndexTileFileName(tile: Pick<QuadIndexTile, 'scaleLower' | 'tileNside' | 'tileId'>) {
	const arcsec = Math.round((tile.scaleLower * 180 * 3600) / Math.PI)
	return `nqi-${arcsec}-${tile.tileNside}-${tile.tileId.toString().padStart(4, '0')}${QUAD_INDEX_EXTENSION}`
}

// One section to write: its kind and bytes.
interface SectionData {
	readonly kind: number
	readonly data: ArrayBufferView
}

// Encodes a tile into the bytes of a .nqi file.
export function encodeQuadIndexTile(tile: QuadIndexTile): Uint8Array {
	const sections: SectionData[] = [
		{ kind: STAR_XYZ, data: tile.stars },
		{ kind: STAR_MAGNITUDE, data: tile.magnitudes },
		{ kind: STAR_SWEEP, data: tile.sweeps },
		{ kind: CELL_IDS, data: tile.cellIds },
		{ kind: CELL_OFFSETS, data: tile.cellOffsets },
		{ kind: QUAD_STARS_SECTION, data: tile.quadStars },
		{ kind: QUAD_CODES, data: tile.codes.points },
		{ kind: KD_LOWER, data: tile.codes.lower },
		{ kind: KD_UPPER, data: tile.codes.upper },
	]
	if (tile.properMotions !== undefined) sections.push({ kind: STAR_PROPER_MOTION, data: tile.properMotions })
	if (tile.sources !== undefined) sections.push({ kind: STAR_SOURCE, data: tile.sources })

	let size = HEADER_SIZE
	const offsets: number[] = []
	for (const section of sections) {
		offsets.push(size)
		size = Math.ceil((size + section.data.byteLength) / SECTION_ALIGNMENT) * SECTION_ALIGNMENT
	}

	const bytes = new Uint8Array(size)
	const view = new DataView(bytes.buffer)
	for (let i = 0; i < 8; i++) bytes[i] = QUAD_INDEX_MAGIC.charCodeAt(i)
	view.setUint32(8, QUAD_INDEX_VERSION, true)
	view.setUint32(12, tile.quadStars instanceof Uint32Array ? FLAG_WIDE_QUAD_STARS : 0, true)
	view.setFloat64(16, tile.scaleLower, true)
	view.setFloat64(24, tile.scaleUpper, true)
	view.setFloat64(32, tile.jitter, true)
	view.setFloat64(40, tile.epoch, true)
	view.setUint32(48, tile.nside, true)
	view.setUint32(52, tile.tileNside, true)
	view.setUint32(56, tile.tileId, true)
	view.setUint32(60, 4, true)
	view.setUint32(64, tile.starsPerCell, true)
	view.setUint32(68, tile.passes, true)
	view.setUint32(72, tile.maxReuse, true)
	view.setUint32(76, tile.maxLoosenReuse, true)
	view.setFloat64(80, tile.dedup, true)
	view.setFloat64(88, tile.magnitudeLimit, true)
	view.setUint32(96, tile.ownStarCount, true)
	view.setUint32(100, tile.magnitudes.length, true)
	view.setUint32(104, tile.quadStars.length / 4, true)
	view.setUint32(108, tile.codes.levels, true)
	view.setUint32(112, tile.cellIds.length, true)
	view.setUint32(116, sections.length, true)
	for (let i = 0; i < tile.catalog.length && i < CATALOG_SIZE; i++) bytes[CATALOG_OFFSET + i] = tile.catalog.charCodeAt(i) & 0x7f

	for (let i = 0; i < sections.length; i++) {
		const { kind, data } = sections[i]
		const entry = SECTION_TABLE_OFFSET + i * SECTION_ENTRY_SIZE
		const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		bytes.set(raw, offsets[i])
		view.setUint32(entry, kind, true)
		view.setUint32(entry + 4, Bun.hash.crc32(raw), true)
		view.setUint32(entry + 8, offsets[i] % TILE_ID_FACTOR, true)
		view.setUint32(entry + 12, Math.floor(offsets[i] / TILE_ID_FACTOR), true)
		view.setUint32(entry + 16, data.byteLength % TILE_ID_FACTOR, true)
		view.setUint32(entry + 20, Math.floor(data.byteLength / TILE_ID_FACTOR), true)
	}

	return bytes
}

// Location of a section in a file.
interface SectionEntry {
	readonly crc: number
	readonly offset: number
	readonly length: number
}

// Parsed header fields of a file, without its arrays.
export type QuadIndexTileHeader = Omit<QuadIndexTile, 'stars' | 'magnitudes' | 'sweeps' | 'cellIds' | 'cellOffsets' | 'properMotions' | 'sources' | 'quadStars' | 'codes'> & {
	// Number of stars and quads.
	readonly starCount: number
	readonly quadCount: number
	// Levels of the code tree.
	readonly levels: number
	// Number of occupied cells.
	readonly cellCount: number
	// Whether quad star ids are 32-bit.
	readonly wide: boolean
}

// Reads and checks the 512-byte header of a file. Throws on a wrong signature or version.
export function decodeQuadIndexHeader(bytes: Uint8Array): QuadIndexTileHeader & { readonly sections: ReadonlyMap<number, SectionEntry> } {
	if (bytes.byteLength < HEADER_SIZE) throw new Error('truncated quad index header')
	for (let i = 0; i < 8; i++) if (bytes[i] !== QUAD_INDEX_MAGIC.charCodeAt(i)) throw new Error('not a quad index file')

	const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE)
	const version = view.getUint32(8, true)
	if (version !== QUAD_INDEX_VERSION) throw new Error(`unsupported quad index version ${version}`)

	const sectionCount = Math.min(MAX_SECTIONS, view.getUint32(116, true))
	const sections = new Map<number, SectionEntry>()

	for (let i = 0; i < sectionCount; i++) {
		const entry = SECTION_TABLE_OFFSET + i * SECTION_ENTRY_SIZE
		sections.set(view.getUint32(entry, true), {
			crc: view.getUint32(entry + 4, true),
			offset: view.getUint32(entry + 8, true) + view.getUint32(entry + 12, true) * TILE_ID_FACTOR,
			length: view.getUint32(entry + 16, true) + view.getUint32(entry + 20, true) * TILE_ID_FACTOR,
		})
	}

	let catalog = ''
	for (let i = 0; i < CATALOG_SIZE && bytes[CATALOG_OFFSET + i] !== 0; i++) catalog += String.fromCharCode(bytes[CATALOG_OFFSET + i])

	return {
		scaleLower: view.getFloat64(16, true),
		scaleUpper: view.getFloat64(24, true),
		jitter: view.getFloat64(32, true),
		epoch: view.getFloat64(40, true),
		nside: view.getUint32(48, true),
		tileNside: view.getUint32(52, true),
		tileId: view.getUint32(56, true),
		starsPerCell: view.getUint32(64, true),
		passes: view.getUint32(68, true),
		maxReuse: view.getUint32(72, true),
		maxLoosenReuse: view.getUint32(76, true),
		dedup: view.getFloat64(80, true),
		magnitudeLimit: view.getFloat64(88, true),
		ownStarCount: view.getUint32(96, true),
		starCount: view.getUint32(100, true),
		quadCount: view.getUint32(104, true),
		levels: view.getUint32(108, true),
		cellCount: view.getUint32(112, true),
		wide: (view.getUint32(12, true) & FLAG_WIDE_QUAD_STARS) !== 0,
		catalog,
		sections,
	}
}

// Decodes the bytes of a file into typed-array views of them (no copy). bytes must start at an 8-byte aligned
// offset of its buffer. Throws when the header is invalid or a required section is missing or out of bounds.
export function decodeQuadIndexTile(bytes: Uint8Array): QuadIndexTile {
	if (bytes.byteOffset % 8 !== 0) bytes = bytes.slice()
	const header = decodeQuadIndexHeader(bytes)
	const { sections } = header

	function section<T>(kind: number, type: new (buffer: ArrayBufferLike, offset: number, length: number) => T, elementSize: number, required: true): T
	function section<T>(kind: number, type: new (buffer: ArrayBufferLike, offset: number, length: number) => T, elementSize: number, required: false): T | undefined
	function section<T>(kind: number, type: new (buffer: ArrayBufferLike, offset: number, length: number) => T, elementSize: number, required: boolean) {
		const entry = sections.get(kind)
		if (entry === undefined) {
			if (required) throw new Error(`missing quad index section ${kind}`)
			return undefined
		}
		if (entry.offset + entry.length > bytes.byteLength || entry.length % elementSize !== 0) throw new Error(`quad index section ${kind} is out of bounds`)
		return new type(bytes.buffer, bytes.byteOffset + entry.offset, entry.length / elementSize)
	}

	const points = section(QUAD_CODES, Uint16Array, 2, true)

	return {
		...header,
		stars: section(STAR_XYZ, Float32Array, 4, true),
		magnitudes: section(STAR_MAGNITUDE, Int16Array, 2, true),
		sweeps: section(STAR_SWEEP, Uint8Array, 1, true),
		cellIds: section(CELL_IDS, Uint32Array, 4, true),
		cellOffsets: section(CELL_OFFSETS, Uint32Array, 4, true),
		properMotions: section(STAR_PROPER_MOTION, Float32Array, 4, false),
		sources: section(STAR_SOURCE, BigUint64Array, 8, false),
		quadStars: header.wide ? section(QUAD_STARS_SECTION, Uint32Array, 4, true) : section(QUAD_STARS_SECTION, Uint16Array, 2, true),
		codes: { dimension: 4, count: header.quadCount, levels: header.levels, points, indices: new Uint32Array(0), lower: section(KD_LOWER, Uint16Array, 2, true), upper: section(KD_UPPER, Uint16Array, 2, true) },
	}
}

// Whether every section of a file matches its CRC32. Meant for generators and tests, not for every open.
export function verifyQuadIndexTile(bytes: Uint8Array) {
	const { sections } = decodeQuadIndexHeader(bytes)
	for (const { crc, offset, length } of sections.values()) {
		if (offset + length > bytes.byteLength || Bun.hash.crc32(bytes.subarray(offset, offset + length)) !== crc) return false
	}
	return true
}

// Options of NebulosaQuadIndex.
export interface NebulosaQuadIndexOptions {
	// Identifier used in diagnostics; defaults to the band minimum.
	readonly id?: string
	// Epoch the star positions are carried to by their proper motions, Julian year; undefined keeps the file epoch.
	readonly epoch?: number
	// Bytes of tiles kept loaded before the least recently used are released.
	readonly maxLoadedBytes?: number
}

// A file of the set: its path, header and loaded contents.
interface TileFile {
	readonly path: string
	readonly header: QuadIndexTileHeader
	tile?: QuadIndexTile
	bytes: number
}

// Whether the runtime maps files; Bun has no mmap on Windows.
let MMAP_SUPPORTED: boolean | undefined

// Reads a whole file, mapped when the runtime can.
function loadFileBytes(path: string): Uint8Array {
	if (MMAP_SUPPORTED !== false) {
		try {
			const mapped = Bun.mmap(path)
			MMAP_SUPPORTED = true
			return mapped
		} catch (e) {
			if (MMAP_SUPPORTED === true) throw e
			MMAP_SUPPORTED = false
		}
	}

	return new Uint8Array(fs.readFileSync(path))
}

// Reads the header bytes of a file.
function readHeaderBytes(path: string) {
	const fd = fs.openSync(path, 'r')
	try {
		const bytes = new Uint8Array(HEADER_SIZE)
		fs.readSync(fd, bytes, 0, HEADER_SIZE, 0)
		return bytes
	} finally {
		fs.closeSync(fd)
	}
}

// QuadIndex over the tile files of one band.
export class NebulosaQuadIndex implements QuadIndex {
	readonly id: string
	readonly scaleLower: Angle
	readonly scaleUpper: Angle
	readonly jitter: Angle
	readonly epoch: number
	readonly cellSize: Angle
	readonly #files: TileFile[]
	readonly #byTile = new Map<number, number>()
	readonly #nside: number
	readonly #tileNside: number
	readonly #targetEpoch?: number
	readonly #maxLoadedBytes: number
	// Loaded tile ordinals, least recently used first.
	readonly #loaded = new Set<number>()
	#loadedBytes = 0

	// files are tile files of one band: same band limits, NSIDE and tiling. Throws when they differ or a header is invalid.
	constructor(paths: readonly string[], options: NebulosaQuadIndexOptions = {}) {
		if (paths.length === 0) throw new Error('a quad index needs at least one file')
		this.#files = paths.map((path) => ({ path, header: decodeQuadIndexHeader(readHeaderBytes(path)), bytes: 0 }))
		const first = this.#files[0].header

		for (const [ordinal, { header, path }] of this.#files.entries()) {
			if (header.scaleLower !== first.scaleLower || header.scaleUpper !== first.scaleUpper || header.nside !== first.nside || header.tileNside !== first.tileNside) throw new Error(`${path} belongs to another band`)
			if (this.#byTile.has(header.tileId)) throw new Error(`${path} repeats tile ${header.tileId}`)
			this.#byTile.set(header.tileId, ordinal)
		}

		this.id = options.id ?? `nqi:${Math.round((first.scaleLower * 180 * 3600) / Math.PI)}`
		this.scaleLower = first.scaleLower
		this.scaleUpper = first.scaleUpper
		this.jitter = first.jitter
		this.epoch = options.epoch ?? first.epoch
		this.cellSize = Math.sqrt(Math.PI / 3) / first.nside
		this.#nside = first.nside
		this.#tileNside = first.tileNside
		this.#targetEpoch = options.epoch
		this.#maxLoadedBytes = options.maxLoadedBytes ?? DEFAULT_QUAD_INDEX_MAX_LOADED_BYTES
	}

	// Number of tile files.
	get tileCount() {
		return this.#files.length
	}

	// Returns the tile of an ordinal, loading it and releasing the least recently used ones beyond the byte budget.
	#tile(ordinal: number): QuadIndexTile {
		const file = this.#files[ordinal]

		if (file.tile !== undefined) {
			this.#loaded.delete(ordinal)
			this.#loaded.add(ordinal)
			return file.tile
		}

		const bytes = loadFileBytes(file.path)
		file.tile = decodeQuadIndexTile(bytes)
		file.bytes = bytes.byteLength
		this.#loaded.add(ordinal)
		this.#loadedBytes += file.bytes

		for (const other of this.#loaded) {
			if (this.#loadedBytes <= this.#maxLoadedBytes) break
			if (other === ordinal) continue
			const released = this.#files[other]
			released.tile = undefined
			this.#loadedBytes -= released.bytes
			this.#loaded.delete(other)
		}

		return file.tile
	}

	// Tile ordinals touching a cone, or all of them.
	#ordinals(region?: SkyCone) {
		if (region === undefined || this.#tileNside === 0) return this.#files.keys()
		const [ra, dec] = eraC2s(region.center[0], region.center[1], region.center[2])
		const ordinals: number[] = []
		for (const tile of circleToPixels(this.#tileNside, ra, dec, Math.min(Math.PI, region.radius))) {
			const ordinal = this.#byTile.get(tile)
			if (ordinal !== undefined) ordinals.push(ordinal)
		}
		return ordinals
	}

	// Visits the quads within tolerance of code, in the tiles touching region (all tiles without one).
	readonly searchCodes = (code: QuadCode, tolerance: number, visit: (quad: number) => void, region?: SkyCone) => {
		const query = [(code[0] - QUAD_CODE_MIN) * QUAD_CODE_QUANTIZATION, (code[1] - QUAD_CODE_MIN) * QUAD_CODE_QUANTIZATION, (code[2] - QUAD_CODE_MIN) * QUAD_CODE_QUANTIZATION, (code[3] - QUAD_CODE_MIN) * QUAD_CODE_QUANTIZATION]
		const radius = tolerance * QUAD_CODE_QUANTIZATION

		for (const ordinal of this.#ordinals(region)) {
			const base = ordinal * TILE_ID_FACTOR
			searchKdTree(this.#tile(ordinal).codes, query, radius, (position) => visit(base + position))
		}
	}

	// Writes the star ids of a quad in canonical order into out and returns it; the tile ordinal fills the bits above 32.
	readonly quadStars = (quad: number, out: Float64Array) => {
		const ordinal = Math.floor(quad / TILE_ID_FACTOR)
		const local = quad - ordinal * TILE_ID_FACTOR
		const stars = this.#tile(ordinal).quadStars
		const base = ordinal * TILE_ID_FACTOR
		for (let i = 0; i < 4; i++) out[i] = base + stars[local * 4 + i]
		return out
	}

	// Writes the unit vector of a star into out, carried to the requested epoch when the file has proper motions.
	readonly starVector = (star: number, out: MutVec3) => {
		const ordinal = Math.floor(star / TILE_ID_FACTOR)
		const local = star - ordinal * TILE_ID_FACTOR
		const tile = this.#tile(ordinal)
		const x = tile.stars[local * 3]
		const y = tile.stars[local * 3 + 1]
		const z = tile.stars[local * 3 + 2]
		const length = Math.hypot(x, y, z)
		out[0] = x / length
		out[1] = y / length
		out[2] = z / length

		if (this.#targetEpoch !== undefined && tile.properMotions !== undefined && this.#targetEpoch !== tile.epoch) {
			const years = this.#targetEpoch - tile.epoch
			const [ra, dec] = eraC2s(out[0], out[1], out[2])
			eraS2c(ra + tile.properMotions[local * 2] * years, dec + tile.properMotions[local * 2 + 1] * years, out)
		}

		return out
	}

	// Brightness rank of a star within its uniformization cell.
	readonly starSweep = (star: number) => {
		const ordinal = Math.floor(star / TILE_ID_FACTOR)
		return this.#tile(ordinal).sweeps[star - ordinal * TILE_ID_FACTOR]
	}

	// Visits the own stars of the tiles within the cone (each star once across tiles).
	readonly starsInCone = (cone: SkyCone, visit: (star: number) => void) => {
		const [ra, dec] = eraC2s(cone.center[0], cone.center[1], cone.center[2])
		const radius = Math.min(Math.PI, cone.radius)
		const cells = circleToPixels(this.#nside, ra, dec, radius)
		const cosRadius = Math.cos(radius)
		const center = cone.center

		for (const ordinal of this.#ordinals(cone)) {
			const tile = this.#tile(ordinal)
			const base = ordinal * TILE_ID_FACTOR
			const { cellIds, cellOffsets, stars } = tile

			for (const cell of cells) {
				const k = binarySearch(cellIds, cell)
				if (k < 0) continue

				for (let s = cellOffsets[k]; s < cellOffsets[k + 1]; s++) {
					const x = stars[s * 3]
					const y = stars[s * 3 + 1]
					const z = stars[s * 3 + 2]
					if ((x * center[0] + y * center[1] + z * center[2]) / Math.hypot(x, y, z) >= cosRadius) visit(base + s)
				}
			}
		}
	};

	// Releases every loaded tile.
	[Symbol.dispose]() {
		for (const file of this.#files) file.tile = undefined
		this.#loaded.clear()
		this.#loadedBytes = 0
	}
}

// Index of value in an ascending array, or -1.
function binarySearch(values: Uint32Array, value: number) {
	let lo = 0
	let hi = values.length - 1

	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const current = values[mid]
		if (current === value) return mid
		if (current < value) lo = mid + 1
		else hi = mid - 1
	}

	return -1
}

// Stars handed to buildQuadIndexTile, brightest first.
export interface QuadIndexStars {
	// Unit vectors, 3 per star.
	readonly vectors: Float64Array
	// Magnitude of each star.
	readonly magnitudes?: ArrayLike<number>
	// Proper motion dα/dt and dδ/dt per star, radians per year, 2 per star.
	readonly properMotions?: ArrayLike<number>
	// Source catalog id of each star.
	readonly sources?: BigUint64Array
}

// Cone that holds a tile and every star its quads may use: the tile, widened by the longest quad and one cell.
export function quadIndexTileCone(tileNside: number, tileId: number, scaleUpper: Angle): SkyCone {
	if (tileNside === 0) return { center: [0, 0, 1], radius: Math.PI }
	const [ra, dec] = pixelToCenter(tileNside, tileId)
	const center = eraS2c(ra, dec)
	let bound = 0
	for (const [lon, lat] of pixelToBoundary(tileNside, tileId)) bound = Math.max(bound, vecAngleUnit(center, eraS2c(lon, lat)))
	const nside = quadCellNside(scaleUpper / Math.SQRT2)
	return { center, radius: Math.min(Math.PI, bound + scaleUpper + 2 * healpixCellSize(nside)) }
}

// Builds one tile of a band from the stars of its cone (quadIndexTileCone): the quads are built only for the cells
// of the tile, with the stars around them, so tiles can be built one at a time from a catalog read tile by tile.
// Reuse limits then apply per tile, so a star near a tile edge may join quads of both tiles. Undefined when the
// tile gets no quad.
export function buildQuadIndexTile(stars: QuadIndexStars, band: Omit<QuadBandOptions, 'region' | 'cells'>, tileNside: number, tileId: number, options: Omit<QuadIndexTileOptions, 'tileNside' | 'tiles' | 'magnitudes' | 'properMotions' | 'sources'>): QuadIndexTile | undefined {
	const nside = quadCellNside(band.scaleLower)
	if (tileNside > nside) throw new Error('the tile NSIDE must not exceed the band NSIDE')
	const perTile = tileNside === 0 ? 12 * nside * nside : (nside / tileNside) ** 2
	const first = tileNside === 0 ? 0 : tileId * perTile
	const cells = Array.from({ length: perTile }, (_, i) => first + i)
	const built = buildQuadBand(stars.vectors, { ...band, cells })
	return quadIndexTilesFromBand(built, { ...options, tileNside, tiles: [tileNside === 0 ? 0 : tileId], magnitudes: stars.magnitudes, properMotions: stars.properMotions, sources: stars.sources })[0]
}
