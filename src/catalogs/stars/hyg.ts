import type { Constellation } from '../../astronomy/coordinates/constellation'
import { HealpixIndex, type HealpixIndexOptions } from '../../astronomy/sky/spatial/healpix'
import { type CsvRow, readCsvStream } from '../../io/csv'
import type { Source } from '../../io/io'
import { type Distance, parsec } from '../../math/units/distance'
import { kilometerPerSecond, type Velocity } from '../../math/units/velocity'
import type { StarCatalogEntry } from './catalog'

// Reader and HEALPix-indexed catalog for the HYG star database (CSV). Parses each row into a
// StarCatalogEntry enriched with cross-identifiers and physical data, converting proper motion from
// the catalog's on-sky convention to ERFA's dα/dt. Angles are radians (J2000), distances parsecs,
// velocities km/s.

// https://codeberg.org/astronexus/hyg/src/branch/main/data/hyg/CURRENT

// One parsed HYG catalog star with its cross-identifiers and physical parameters.
export interface HygCatalogEntry extends Required<StarCatalogEntry> {
	// HYG internal record id.
	readonly id: number
	// Hipparcos catalog number (0 if none).
	readonly hip: number
	// Henry Draper catalog number (0 if none).
	readonly hd: number
	// Harvard Revised / Bright Star number (0 if none).
	readonly hr: number
	// Bayer designation, if any.
	readonly bayer?: string
	// Flamsteed number (0 if none).
	readonly flamsteed: number
	// Proper name, if any.
	readonly name?: string
	// Radial velocity, km/s.
	readonly rv: Velocity
	// Distance from the Sun, parsecs (0 when unknown or out of range).
	readonly distance: Distance
	// Spectral type, if any.
	readonly spType?: string
	// IAU constellation the star lies in.
	readonly constellation: Constellation
}

// Reads the HYG catalog from a CSV source
export async function* readHygCatalog(source: Source) {
	for await (const row of readCsvStream(source)) {
		yield processRow(row)
	}
}

// Parses one HYG CSV row (columns listed below) into a HygCatalogEntry, in J2000 radians.
// "id","hip","hd","hr","gl","bf","proper","ra","dec","dist","pmra","pmdec","rv","mag","absmag","spect","ci","x","y","z","vx","vy","vz","rarad","decrad","pmrarad","pmdecrad","bayer","flam","con","comp","comp_primary","base","lum","var","var_min","var_max"
function processRow(row: CsvRow): HygCatalogEntry {
	const id = +row[0]
	const hip = +row[1]
	const hd = +row[2]
	const hr = +row[3]
	const name = row[6] || undefined
	const dist = +row[9]
	const distance = dist > 0 && dist < 100000 ? parsec(dist) : 0
	const rv = kilometerPerSecond(+row[12])
	const magnitude = row[13] ? +row[13] : 99
	const spType = row[15] || undefined
	const rightAscension = +row[23]
	const declination = +row[24]
	// HYG's pmrarad is μα·cosδ (proper motion on the sky), but StarCatalogEntry.pmRA and ERFA's star
	// routines expect dα/dt, so divide out cosδ as ucac4 and simbad do. Guard the pole where cosδ → 0.
	const cosDec = Math.cos(declination)
	const pmRA = Math.abs(cosDec) > 1e-9 ? +row[25] / cosDec : 0
	const pmDEC = +row[26]
	const bayer = row[27] || undefined
	const flamsteed = +row[28]
	const constellation = row[29].toUpperCase() as Constellation

	return { id, epoch: 2000, hip, hd, hr, bayer, flamsteed, name, rightAscension, declination, pmRA, pmDEC, rv, magnitude, distance, spType, constellation }
}

// HEALPix spatial index over HYG entries, queryable by region. Default NSIDE 8.
export class HygCatalog extends HealpixIndex<HygCatalogEntry> {
	constructor({ nside = 8, ordering }: Partial<HealpixIndexOptions> = {}) {
		super({ nside, ordering })
	}

	// Streams the HYG CSV from `source` and inserts every entry into the index.
	async load(source: Source) {
		for await (const entry of readHygCatalog(source)) {
			this.add(entry.id, entry.rightAscension, entry.declination, entry)
		}
	}
}
