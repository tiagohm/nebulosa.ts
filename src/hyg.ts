import type { Angle } from './angle'
import type { Constellation } from './constellation'
import { type CsvRow, readCsvStream } from './csv'
import { type Distance, parsec } from './distance'
import type { Source } from './io'
import { kilometerPerSecond, type Velocity } from './velocity'

// https://codeberg.org/astronexus/hyg/src/branch/main/data/hyg/CURRENT

export interface HygDatabaseEntry {
	readonly id: number
	readonly hip: number
	readonly hd: number
	readonly hr: number
	readonly bayer?: string
	readonly flamsteed: number
	readonly name?: string
	readonly rightAscension: Angle
	readonly declination: Angle
	readonly pmRa: Angle
	readonly pmDec: Angle
	readonly px: Angle
	readonly rv: Velocity
	readonly magnitude: number
	readonly distance: Distance
	readonly spType?: string
	readonly constellation: Constellation
}

export async function* readHygCatalog(source: Source) {
	for await (const row of readCsvStream(source)) {
		yield processRow(row)
	}
}

// "id","hip","hd","hr","gl","bf","proper","ra","dec","dist","pmra","pmdec","rv","mag","absmag","spect","ci","x","y","z","vx","vy","vz","rarad","decrad","pmrarad","pmdecrad","bayer","flam","con","comp","comp_primary","base","lum","var","var_min","var_max"
function processRow(row: CsvRow): HygDatabaseEntry {
	const id = +row[0]
	const hip = +row[1]
	const hd = +row[2]
	const hr = +row[3]
	const name = row[6] || undefined
	const dist = +row[9]
	const distance = dist > 0 && dist < 100000 ? parsec(dist) : 0
	const px = distance !== 0 ? 1 / distance : 0
	const rv = kilometerPerSecond(+row[12])
	const magnitude = row[13] ? +row[13] : 99
	const spType = row[15] || undefined
	const rightAscension = +row[23]
	const declination = +row[24]
	const pmRa = +row[25]
	const pmDec = +row[26]
	const bayer = row[27] || undefined
	const flamsteed = +row[28]
	const constellation = row[29].toUpperCase() as Constellation

	return { id, hip, hd, hr, bayer, flamsteed, name, rightAscension, declination, pmRa, pmDec, px, rv, magnitude, distance, spType, constellation }
}
