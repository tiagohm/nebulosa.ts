import { HealpixIndex, type HealpixIndexOptions } from '../../astronomy/sky/spatial/healpix'
import { readCsvStream, type CsvRow } from '../../io/csv'
import type { Source } from '../../io/io'
import { deg, mas, type Angle } from '../../math/units/angle'
import type { StarCatalogEntry } from './catalog'

// Streaming reader and HEALPix index for the ESA Hipparcos main catalog (I/239/hip_main.dat).
// Positions are ICRS at J1991.25 in radians; proper motions are radians per Julian year.
// The reader allocates one entry per usable row and does not retain source rows.

// A Hipparcos main-catalog star with its measured astrometry at J1991.25.
export interface HipparcosCatalogEntry extends StarCatalogEntry {
	// Hipparcos identifier.
	readonly id: number
	// Reference Julian epoch for the catalog position and proper motion.
	readonly epoch: 1991.25
}

// Column offsets in the CDS pipe-delimited hip_main.dat record, starting at zero.
const HIP = 1
const V_MAGNITUDE = 5
const RA_DEGREES = 8
const DEC_DEGREES = 9
const PARALLAX_MAS = 11
const PM_RA_COS_DEC_MAS_PER_YEAR = 12
const PM_DEC_MAS_PER_YEAR = 13

// Reads a finite optional number; blank and non-finite catalog fields have no measurement.
function optionalNumber(value: string | undefined): number | undefined {
	if (!value) return undefined
	const number = Number(value)
	return Number.isFinite(number) ? number : undefined
}

// Converts one source row into a catalog entry, omitting rows without usable sky coordinates.
// Hipparcos publishes μ_α* = dα/dt cos(δ); the generic stellar API uses dα/dt.
// At a mathematical pole that direction is undefined, so pmRA remains absent.
function parseRow(row: CsvRow): HipparcosCatalogEntry | undefined {
	const id = optionalNumber(row[HIP])
	const ra = optionalNumber(row[RA_DEGREES])
	const dec = optionalNumber(row[DEC_DEGREES])
	if (id === undefined || !Number.isInteger(id) || !(id > 0) || ra === undefined || dec === undefined || !(ra >= 0 && ra < 360) || !(dec >= -90 && dec <= 90)) return undefined

	const declination = deg(dec)
	const pmRaCosDec = optionalNumber(row[PM_RA_COS_DEC_MAS_PER_YEAR])
	const pmDec = optionalNumber(row[PM_DEC_MAS_PER_YEAR])
	const parallax = optionalNumber(row[PARALLAX_MAS])
	const cosDec = pmRaCosDec === undefined ? 0 : Math.cos(declination)
	const pmRA: Angle | undefined = pmRaCosDec !== undefined && Math.abs(cosDec) > 1e-9 ? mas(pmRaCosDec / cosDec) : undefined

	return {
		id,
		epoch: 1991.25,
		rightAscension: deg(ra),
		declination,
		magnitude: optionalNumber(row[V_MAGNITUDE]),
		parallax: parallax === undefined ? undefined : mas(parallax),
		pmRA,
		pmDEC: pmDec === undefined ? undefined : mas(pmDec),
	}
}

// Streams usable astrometric records from a provided Source in constant reader memory.
// Blank optional measurements stay undefined; malformed or absent positions are skipped.
export async function* readHipparcosCatalog(source: Source): AsyncIterable<HipparcosCatalogEntry> {
	for await (const row of readCsvStream(source, { delimiter: '|', skipFirstLine: false, quote: false, forceTrim: true })) {
		const entry = parseRow(row)
		if (entry !== undefined) yield entry
	}
}

// Spatial index of Hipparcos positions at J1991.25, with the generic region-query surface.
export class HipparcosCatalog extends HealpixIndex<HipparcosCatalogEntry> {
	// Creates an all-sky index; NSIDE 8 follows the neighboring star catalogs.
	constructor({ nside = 8, ordering }: Partial<HealpixIndexOptions> = {}) {
		super({ nside, ordering })
	}

	// Streams and inserts usable entries, keyed by HIP identifier at their catalog positions.
	async load(source: Source) {
		for await (const entry of readHipparcosCatalog(source)) {
			this.add(entry.id, entry.rightAscension, entry.declination, entry)
		}
	}
}
