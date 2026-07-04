import { PIOVERTWO } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import type { StarCatalogEntry } from './catalog'
// oxfmt-ignore
import { createTiledSkyGeometry, decodeTiledStarDesignation, findTiledStarAreas, findTiledStarRegion, readTiledStarArea, readTiledStarHeader, tiledStarAreaFile, TiledStarCatalog, TILED_STAR_DEC_SCALE, TILED_STAR_RA_SCALE, type TiledStarArea, type TiledStarDesignation, type TiledStarFile, type TiledStarFileHeader, type TiledStarFiles, type TiledStarRawRecord, type TiledStarRecordSize, type TiledStarRegionQuery, type TiledStarSearchResult, type TiledStarSortable } from './tiled.catalog'

// Reader and star-catalog adapter for HNSKY ".290" tiled binary star archives. The sky is split into 290
// declination-band areas. Record decoding, header parsing, and the tiling engine are shared with ASTAP
// ".1476" through tiledStarCatalog; this module only supplies the 290 geometry and the HNSKY entry shape
// (BP-RP color, optional TYC/UCAC4 designation). Angles are radians.

// Catalog epoch fallback for HNSKY entries when the header carries no explicit epoch tag (J2000).
const HNSKY_EPOCH = 2000

// Label used in error messages for this format.
const HNSKY_FORMAT_LABEL = 'HNSKY .290'

// Number of RA cells (tiles) in each of the 18 declination bands.
const HNSKY_290_RING_COUNTS = [1, 4, 8, 12, 16, 20, 24, 28, 32, 32, 28, 24, 20, 16, 12, 8, 4, 1] as const

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

// Precomputed 290-tile sky geometry.
const HNSKY_290_GEOMETRY = createTiledSkyGeometry(HNSKY_290_RING_COUNTS, HNSKY_290_DEC_BOUNDARIES, '.290')

// Supported HNSKY database families (limiting magnitude G14 or G16).
export type Hnsky290Database = 'g14' | 'g16'

// A single .290 archive member: a File-like or a raw buffer source.
export type Hnsky290File = TiledStarFile

// A collection of .290 archive members keyed by database-prefixed file name.
export type Hnsky290Files = TiledStarFiles

// Allowed per-record byte sizes in a .290 tile.
export type HnskyRecordSize = TiledStarRecordSize

// Parsed header of one .290 tile.
export type Hnsky290FileHeader = TiledStarFileHeader

// Descriptor of one .290 sky area (tile).
export type Hnsky290Area = TiledStarArea

// A square-field region query around a center.
export type Hnsky290RegionQuery = TiledStarRegionQuery

// A typed catalog designation decoded from a packed .290 identifier.
export type Hnsky290Designation = TiledStarDesignation

// One star decoded from a .290 tile.
export interface Hnsky290Star extends TiledStarSortable {
	// Gaia BP-RP color index, when present.
	readonly bpRp?: number
	// Decoded catalog designation, when present.
	readonly designation?: Hnsky290Designation
}

// Result of a field search: the touched areas, their headers, and the merged star list.
export type Hnsky290SearchResult = TiledStarSearchResult<Hnsky290Star>

// A star exposed through the generic catalog contract, carrying its tile and record number.
export interface HnskyCatalogEntry extends StarCatalogEntry {
	readonly area: number
	readonly recordNumber: number
	readonly magnitude: number
	readonly bpRp?: number
	readonly designation?: Hnsky290Designation
}

// Computes the HNSKY ring number and file index for a 1-based area number.
export function hnsky290AreaFile(area: number): Hnsky290Area {
	return tiledStarAreaFile(HNSKY_290_GEOMETRY, area)
}

// Decodes a stored .290 designation into a typed catalog identifier.
export function decodeHnsky290Designation(value: number): Hnsky290Designation {
	return decodeTiledStarDesignation(value)
}

// Reads the shared 110-byte .290 header and validates the record size.
export function readHnsky290Header(header: Buffer): Hnsky290FileHeader {
	return readTiledStarHeader(header, HNSKY_EPOCH, HNSKY_FORMAT_LABEL)
}

// Materializes a public .290 tile star, converting packed coordinates to radians and decoding the color
// and designation only for a star that is actually emitted.
function materializeHnsky290Star(area: number, record: Readonly<TiledStarRawRecord>): Hnsky290Star {
	return {
		area,
		rightAscension: record.raRaw * TILED_STAR_RA_SCALE,
		declination: record.decRaw * TILED_STAR_DEC_SCALE,
		magnitude: record.magnitude,
		bpRp: record.hasColor ? record.colorRaw / 10 : undefined,
		designation: record.hasDesignation ? decodeTiledStarDesignation(record.designationValue) : undefined,
	}
}

// Yields all stars from one .290 tile that fall inside the square field query.
export function readHnsky290Area(header: Hnsky290FileHeader, buffer: Buffer, area: number, query: Readonly<Hnsky290RegionQuery>): Generator<Hnsky290Star, void> {
	return readTiledStarArea(header, buffer, area, query, materializeHnsky290Star)
}

// Finds the 1 to 4 .290 tiles intersecting the requested square field.
export function findHnsky290Areas(rightAscension: Angle, declination: Angle, radius: Angle): readonly Hnsky290Area[] {
	return findTiledStarAreas(HNSKY_290_GEOMETRY, rightAscension, declination, radius)
}

// Reads all stars inside the requested field from the intersecting .290 tiles, merged by brightness.
export function findHnsky290Region(files: Hnsky290Files, database: Hnsky290Database, query: Readonly<Hnsky290RegionQuery>): Promise<Hnsky290SearchResult> {
	return findTiledStarRegion(files, database, HNSKY_290_GEOMETRY, query, HNSKY_EPOCH, HNSKY_FORMAT_LABEL, materializeHnsky290Star)
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
export class HnskyCatalog extends TiledStarCatalog<HnskyCatalogEntry, Hnsky290Database> {
	constructor() {
		super(HNSKY_290_GEOMETRY, HNSKY_EPOCH, HNSKY_FORMAT_LABEL, 'g14')
	}

	// Maps a decoded .290 record into the generic catalog entry (BP-RP color, optional designation).
	protected buildEntry(record: Readonly<TiledStarRawRecord>, header: Hnsky290FileHeader, area: number): HnskyCatalogEntry {
		return {
			epoch: header.epoch,
			recordNumber: record.recordNumber,
			area,
			rightAscension: record.raRaw * TILED_STAR_RA_SCALE,
			declination: record.decRaw * TILED_STAR_DEC_SCALE,
			magnitude: record.magnitude,
			bpRp: record.hasColor ? record.colorRaw / 10 : undefined,
			designation: record.hasDesignation ? decodeTiledStarDesignation(record.designationValue) : undefined,
		}
	}
}
