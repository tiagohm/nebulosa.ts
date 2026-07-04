import { DEG2RAD } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import type { StarCatalogEntry } from './catalog'
// oxfmt-ignore
import { createTiledSkyGeometry, findTiledStarAreas, findTiledStarRegion, readTiledStarArea, readTiledStarHeader, tiledStarAreaFile, TiledStarCatalog, TILED_STAR_DEC_SCALE, TILED_STAR_RA_SCALE, type TiledStarArea, type TiledStarFile, type TiledStarFileHeader, type TiledStarFiles, type TiledStarRawRecord, type TiledStarRecordSize, type TiledStarRegionQuery, type TiledStarSearchResult, type TiledStarSortable } from './tiled.catalog'

// Reader and star-catalog adapter for ASTAP ".1476" tiled binary star archives. ASTAP reuses the exact
// HNSKY packed record layout and 110-byte header (the Pascal source names its record types
// "hnskyhdr1476"), so record decoding, header parsing, and the tiling engine come from tiledStarCatalog.
// This module only supplies the finer 1476-tile geometry (36 declination bands) and the ASTAP entry shape
// (Gaia BP magnitude, optional Johnson B-V color). Angles are radians.

// Catalog epoch fallback when a header carries no explicit "Epoch=" tag. ASTAP databases advertise their
// epoch in the header description (e.g. "Epoch=2025"), which is parsed and preferred over this fallback.
const ASTAP_DEFAULT_EPOCH = 2000

// Label used in error messages for this format.
const ASTAP_FORMAT_LABEL = 'ASTAP .1476'

// Header version byte value marking the Gaia variant that carries a B-V color byte in 6-byte records.
const ASTAP_COLOR_VERSION = 2

// Divisor recovering Johnson B-V from the packed signed color byte (stored as B-V * 50).
const ASTAP_BV_SCALE = 50

// Number of RA cells (tiles) in each of the 36 declination bands, from the south to the north pole.
// Confirmed against the shipped d05/d20 databases (palindromic; sums to 1476).
const ASTAP_1476_RING_COUNTS = [1, 3, 9, 15, 21, 27, 33, 38, 43, 48, 52, 56, 60, 63, 65, 67, 68, 69, 69, 68, 67, 65, 63, 60, 56, 52, 48, 43, 38, 33, 27, 21, 15, 9, 3, 1] as const

// Declination boundaries (radians) between the 36 bands, from the south to the north pole. The pole caps
// span 2.571 degrees and the interior bands 5.143 degrees (36/7 deg), matching ASTAP's dec_boundaries1476.
export const ASTAP_1476_DEC_BOUNDARIES = [
	-90 * DEG2RAD,
	-87.42857143 * DEG2RAD,
	-82.28571429 * DEG2RAD,
	-77.14285714 * DEG2RAD,
	-72 * DEG2RAD,
	-66.85714286 * DEG2RAD,
	-61.71428571 * DEG2RAD,
	-56.57142857 * DEG2RAD,
	-51.42857143 * DEG2RAD,
	-46.28571429 * DEG2RAD,
	-41.14285714 * DEG2RAD,
	-36 * DEG2RAD,
	-30.85714286 * DEG2RAD,
	-25.71428571 * DEG2RAD,
	-20.57142857 * DEG2RAD,
	-15.42857143 * DEG2RAD,
	-10.28571429 * DEG2RAD,
	-5.142857143 * DEG2RAD,
	0,
	5.142857143 * DEG2RAD,
	10.28571429 * DEG2RAD,
	15.42857143 * DEG2RAD,
	20.57142857 * DEG2RAD,
	25.71428571 * DEG2RAD,
	30.85714286 * DEG2RAD,
	36 * DEG2RAD,
	41.14285714 * DEG2RAD,
	46.28571429 * DEG2RAD,
	51.42857143 * DEG2RAD,
	56.57142857 * DEG2RAD,
	61.71428571 * DEG2RAD,
	66.85714286 * DEG2RAD,
	72 * DEG2RAD,
	77.14285714 * DEG2RAD,
	82.28571429 * DEG2RAD,
	87.42857143 * DEG2RAD,
	90 * DEG2RAD,
] as const satisfies readonly Angle[]

// Precomputed 1476-tile sky geometry.
const ASTAP_1476_GEOMETRY = createTiledSkyGeometry(ASTAP_1476_RING_COUNTS, ASTAP_1476_DEC_BOUNDARIES, '.1476')

// Supported ASTAP star database families (d05/d20/d50/d80 differ in star density and limiting magnitude).
export type Astap1476Database = 'd05' | 'd20' | 'd50' | 'd80'

// A single .1476 archive member: a File-like or a raw buffer source.
export type Astap1476File = TiledStarFile

// A collection of .1476 archive members keyed by database-prefixed file name.
export type Astap1476Files = TiledStarFiles

// Allowed per-record byte sizes in a .1476 tile.
export type AstapRecordSize = TiledStarRecordSize

// Parsed header of one .1476 tile.
export type Astap1476FileHeader = TiledStarFileHeader

// Descriptor of one .1476 sky area (tile).
export type Astap1476Area = TiledStarArea

// A square-field region query around a center.
export type Astap1476RegionQuery = TiledStarRegionQuery

// One star decoded from a .1476 tile.
export interface Astap1476Star extends TiledStarSortable {
	// Johnson B-V color index, when present (6-byte records of the Gaia color variant).
	readonly bv?: number
}

// Result of a field search: the touched areas, their headers, and the merged star list.
export type Astap1476SearchResult = TiledStarSearchResult<Astap1476Star>

// A star exposed through the generic catalog contract, carrying its tile and record number.
export interface AstapCatalogEntry extends StarCatalogEntry {
	readonly area: number
	readonly recordNumber: number
	readonly magnitude: number
	readonly bv?: number
}

// Recovers Johnson B-V from a decoded record, present only in the Gaia color variant (version 2, 6-byte).
function decodeAstapColor(record: Readonly<TiledStarRawRecord>, header: Astap1476FileHeader): number | undefined {
	return record.hasColor && header.version === ASTAP_COLOR_VERSION ? record.colorRaw / ASTAP_BV_SCALE : undefined
}

// Computes the ASTAP band/index descriptor for a 1-based area number.
export function astap1476AreaFile(area: number): Astap1476Area {
	return tiledStarAreaFile(ASTAP_1476_GEOMETRY, area)
}

// Reads the shared 110-byte .1476 header and validates the record size.
export function readAstap1476Header(header: Buffer): Astap1476FileHeader {
	return readTiledStarHeader(header, ASTAP_DEFAULT_EPOCH, ASTAP_FORMAT_LABEL)
}

// Materializes a public .1476 tile star, converting packed coordinates to radians and decoding the color
// only for a star that is actually emitted.
function materializeAstap1476Star(area: number, record: Readonly<TiledStarRawRecord>, header: Astap1476FileHeader): Astap1476Star {
	return {
		area,
		rightAscension: record.raRaw * TILED_STAR_RA_SCALE,
		declination: record.decRaw * TILED_STAR_DEC_SCALE,
		magnitude: record.magnitude,
		bv: decodeAstapColor(record, header),
	}
}

// Yields all stars from one .1476 tile that fall inside the square field query.
export function readAstap1476Area(header: Astap1476FileHeader, buffer: Buffer, area: number, query: Readonly<Astap1476RegionQuery>): Generator<Astap1476Star, void> {
	return readTiledStarArea(header, buffer, area, query, materializeAstap1476Star)
}

// Finds the 1 to 4 .1476 tiles intersecting the requested square field.
export function findAstap1476Areas(rightAscension: Angle, declination: Angle, radius: Angle): readonly Astap1476Area[] {
	return findTiledStarAreas(ASTAP_1476_GEOMETRY, rightAscension, declination, radius)
}

// Reads all stars inside the requested field from the intersecting .1476 tiles, merged by brightness.
export function findAstap1476Region(files: Astap1476Files, database: Astap1476Database, query: Readonly<Astap1476RegionQuery>): Promise<Astap1476SearchResult> {
	return findTiledStarRegion(files, database, ASTAP_1476_GEOMETRY, query, ASTAP_DEFAULT_EPOCH, ASTAP_FORMAT_LABEL, materializeAstap1476Star)
}

// Returns only the stars from the requested field.
export async function findAstap1476Stars(files: Astap1476Files, database: Astap1476Database, query: Readonly<Astap1476RegionQuery>): Promise<readonly Astap1476Star[]> {
	return (await findAstap1476Region(files, database, query)).stars
}

// Creates and opens an ASTAP catalog in one step.
export function openAstapCatalog(files: Astap1476Files, database: Astap1476Database) {
	return new AstapCatalog().open(files, database)
}

// Exposes ASTAP .1476 archives through the generic star catalog contract.
export class AstapCatalog extends TiledStarCatalog<AstapCatalogEntry, Astap1476Database> {
	constructor() {
		super(ASTAP_1476_GEOMETRY, ASTAP_DEFAULT_EPOCH, ASTAP_FORMAT_LABEL, 'd05')
	}

	// Maps a decoded .1476 record into the generic catalog entry (Gaia BP magnitude, optional B-V color).
	protected buildEntry(record: Readonly<TiledStarRawRecord>, header: Astap1476FileHeader, area: number): AstapCatalogEntry {
		return {
			epoch: header.epoch,
			recordNumber: record.recordNumber,
			area,
			rightAscension: record.raRaw * TILED_STAR_RA_SCALE,
			declination: record.decRaw * TILED_STAR_DEC_SCALE,
			magnitude: record.magnitude,
			bv: decodeAstapColor(record, header),
		}
	}
}
