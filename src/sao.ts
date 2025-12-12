import type { Angle } from './angle'
import type { EquatorialCoordinate } from './coordinate'
import { eraC2s, eraS2c } from './erfa'
import { precessFk5ToJ2000 } from './fk5'
import type { Seekable, Source } from './io'
import { Timescale, timeBesselianYear } from './time'

// http://tdc-www.harvard.edu/catalogs/sao.html

const B1950 = timeBesselianYear(1950, Timescale.TT)

export interface SaoCatalogEntry extends Readonly<EquatorialCoordinate> {
	readonly id: number
	readonly spType: string
	readonly magnitude: number
	readonly pmRA: Angle
	readonly pmDec: Angle
}

export async function* readSaoCatalog(source: Source & Seekable, bigEndian: boolean) {
	const buffer = Buffer.allocUnsafe(1024 * 32)
	let position = 0
	let size = 0

	// http://tdc-www.harvard.edu/catalogs/sao.header.html
	let star0 = 0 // Subtract from star number to get sequence number
	let star1 = 0 // First star number in file
	let starn = 0 // Number of stars in file
	let stnum = false // 0 if no star i.d. numbers are present, 1 if star i.d. numbers are in catalog file, 2 if star i.d. numbers are in file
	let mprop = false // If proper motion is included
	let nmag = 0 // Number of magnitudes present
	let nbent = 0 // Number of bytes per star entry

	async function read() {
		position = 0
		size = await source.read(buffer)
		return size > 0
	}

	function readShort() {
		const value = bigEndian ? buffer.readInt16BE(position) : buffer.readInt16LE(position)
		position += 2
		return value
	}

	function readInt() {
		const value = bigEndian ? buffer.readInt32BE(position) : buffer.readInt32LE(position)
		position += 4
		return value
	}

	function readFloat() {
		const value = bigEndian ? buffer.readFloatBE(position) : buffer.readFloatLE(position)
		position += 4
		return value
	}

	function readDouble() {
		const value = bigEndian ? buffer.readDoubleBE(position) : buffer.readDoubleLE(position)
		position += 8
		return value
	}

	function readString(length: number) {
		const value = buffer.toString('ascii', position, position + length)
		position += length
		return value
	}

	function readHeader() {
		star0 = readInt()
		star1 = readInt()
		starn = readInt()
		stnum = readInt() !== 0
		mprop = readInt() === 1
		nmag = readInt()
		nbent = readInt()
	}

	await read()

	readHeader()

	while (true) {
		if (position > 1022 * 32) {
			source.seek(source.position - size + position)
			if (!(await read())) break
		} else if (position >= size) {
			break
		}

		const xno = stnum ? readFloat() : star1++
		const id = xno - star0
		const rightAscensionB1950 = readDouble()
		const declinationB1950 = readDouble()
		const spType = readString(2)
		const magnitude = readShort() / 100
		const pmRA = mprop ? readFloat() : 0
		const pmDec = mprop ? readFloat() : 0

		const [rightAscension, declination] = eraC2s(...precessFk5ToJ2000(eraS2c(rightAscensionB1950, declinationB1950), B1950))

		yield { id, rightAscension, declination, spType, magnitude, pmRA, pmDec } as SaoCatalogEntry
	}
}
