import type { Constellation } from './constellation'
import { type CsvRow, readCsvStream } from './csv'
import { type Distance, parsec } from './distance'
import { HealpixIndex, type HealpixIndexOptions } from './healpix'
import type { Source } from './io'
import type { StarCatalogEntry } from './star.catalog'
import { kilometerPerSecond, type Velocity } from './velocity'

// https://codeberg.org/astronexus/hyg/src/branch/main/data/hyg/CURRENT

export interface HygCatalogEntry extends Required<StarCatalogEntry> {
	readonly hip: number
	readonly hd: number
	readonly hr: number
	readonly bayer?: string
	readonly flamsteed: number
	readonly name?: string
	readonly rv: Velocity
	readonly distance: Distance
	readonly spType?: string
	readonly constellation: Constellation
}

// Reads the HYG catalog from a CSV source
export async function* readHygCatalog(source: Source) {
	for await (const row of readCsvStream(source)) {
		yield processRow(row)
	}
}

// "id","hip","hd","hr","gl","bf","proper","ra","dec","dist","pmra","pmdec","rv","mag","absmag","spect","ci","x","y","z","vx","vy","vz","rarad","decrad","pmrarad","pmdecrad","bayer","flam","con","comp","comp_primary","base","lum","var","var_min","var_max"
function processRow(row: CsvRow): HygCatalogEntry {
	const id = row[0]
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
	const pmRA = +row[25]
	const pmDEC = +row[26]
	const bayer = row[27] || undefined
	const flamsteed = +row[28]
	const constellation = row[29].toUpperCase() as Constellation

	return { id, epoch: 2000, hip, hd, hr, bayer, flamsteed, name, rightAscension, declination, pmRA, pmDEC, rv, magnitude, distance, spType, constellation }
}

export class HygCatalog extends HealpixIndex<string, HygCatalogEntry> {
	constructor({ nside = 8, ordering }: Partial<HealpixIndexOptions> = {}) {
		super({ nside, ordering })
	}

	async load(source: Source) {
		for await (const entry of readHygCatalog(source)) {
			this.add(entry.id, entry.rightAscension, entry.declination, entry)
		}
	}
}
