import { eraS2c } from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { vecMulScalar } from 'nebulosa/src/math/linear-algebra/vec3'
import { type Angle, toMas } from '../../src/math/units/angle'

// Synthetic encoders of the Stellarium star catalog binary layout (Star.hpp, ZoneArray.cpp), shared by the
// binary decoder and catalog tests. They write the documented little-endian fields independently of the decoder.

export const STAR_FILE_MAGIC = 0x835f040a

export interface HeaderFields {
	readonly magic?: number
	readonly dataType: number
	readonly major?: number
	readonly minor?: number
	readonly level: number
	readonly magMinMillimag?: number
	readonly epochJD?: number
}

export function encodeHeader(fields: HeaderFields) {
	const buffer = Buffer.alloc(28)
	buffer.writeUInt32LE(fields.magic ?? STAR_FILE_MAGIC, 0)
	buffer.writeUInt32LE(fields.dataType, 4)
	buffer.writeUInt32LE(fields.major ?? 0, 8)
	buffer.writeUInt32LE(fields.minor ?? 0, 12)
	buffer.writeUInt32LE(fields.level, 16)
	buffer.writeInt32LE(fields.magMinMillimag ?? 0, 20)
	buffer.writeFloatLE(fields.epochJD ?? 2457389, 24)
	return buffer
}

export interface Star1Fields {
	readonly gaiaId?: bigint
	// Raw direction integers (unit vector × 2e9); takes precedence over ra/dec.
	readonly xyz?: readonly [number, number, number]
	readonly ra?: Angle
	readonly dec?: Angle
	// Raw tangential proper motion vector, µas/yr.
	readonly pm?: readonly [number, number, number]
	readonly bvMillimag?: number
	readonly vmagMillimag: number
	readonly plx?: number
	readonly plxErr?: number
	readonly rv?: number
	readonly spInt?: number
	readonly objType?: number
	readonly hip?: number
	readonly component?: number
}

export function encodeStar1(fields: Star1Fields) {
	const buffer = Buffer.alloc(48)
	buffer.writeBigInt64LE(fields.gaiaId ?? 0n, 0)
	const xyz = fields.xyz ?? directionRaw(fields.ra ?? 0, fields.dec ?? 0)
	buffer.writeInt32LE(xyz[0], 8)
	buffer.writeInt32LE(xyz[1], 12)
	buffer.writeInt32LE(xyz[2], 16)
	const pm = fields.pm ?? [0, 0, 0]
	buffer.writeInt32LE(pm[0], 20)
	buffer.writeInt32LE(pm[1], 24)
	buffer.writeInt32LE(pm[2], 28)
	buffer.writeInt16LE(fields.bvMillimag ?? 0, 32)
	buffer.writeInt16LE(fields.vmagMillimag, 34)
	buffer.writeUInt16LE(fields.plx ?? 0, 36)
	buffer.writeUInt16LE(fields.plxErr ?? 0, 38)
	buffer.writeInt16LE(fields.rv ?? 0, 40)
	buffer.writeUInt16LE(fields.spInt ?? 0, 42)
	buffer.writeUInt8(fields.objType ?? 0, 44)
	const hip = ((fields.hip ?? 0) << 5) | (fields.component ?? 0)
	buffer.writeUInt8(hip & 0xff, 45)
	buffer.writeUInt8((hip >>> 8) & 0xff, 46)
	buffer.writeUInt8((hip >>> 16) & 0xff, 47)
	return buffer
}

export interface Star2Fields {
	readonly gaiaId?: bigint
	readonly raMas?: number
	readonly decMas?: number
	readonly ra?: Angle
	readonly dec?: Angle
	readonly pmRaUas?: number
	readonly pmDecUas?: number
	readonly bvMillimag?: number
	readonly vmagMillimag: number
	readonly plx?: number
	readonly plxErr?: number
}

export function encodeStar2(fields: Star2Fields) {
	const buffer = Buffer.alloc(32)
	buffer.writeBigInt64LE(fields.gaiaId ?? 0n, 0)
	buffer.writeInt32LE(fields.raMas ?? Math.round(toMas(fields.ra ?? 0)), 8)
	buffer.writeInt32LE(fields.decMas ?? Math.round(toMas(fields.dec ?? 0)), 12)
	buffer.writeInt32LE(fields.pmRaUas ?? 0, 16)
	buffer.writeInt32LE(fields.pmDecUas ?? 0, 20)
	buffer.writeInt16LE(fields.bvMillimag ?? 0, 24)
	buffer.writeInt16LE(fields.vmagMillimag, 26)
	buffer.writeUInt16LE(fields.plx ?? 0, 28)
	buffer.writeUInt16LE(fields.plxErr ?? 0, 30)
	return buffer
}

export interface Star3Fields {
	readonly gaiaId?: bigint
	// RA in 0.1″ units.
	readonly ra24?: number
	// Dec + 90° in 0.1″ units.
	readonly dec24?: number
	readonly ra?: Angle
	readonly dec?: Angle
	readonly bv?: number
	readonly vmag: number
}

export function encodeStar3(fields: Star3Fields) {
	const buffer = Buffer.alloc(16)
	buffer.writeBigInt64LE(fields.gaiaId ?? 0n, 0)
	const ra = fields.ra24 ?? Math.round(toMas(fields.ra ?? 0) / 100)
	const dec = fields.dec24 ?? Math.round(toMas(fields.dec ?? 0) / 100) + 90 * 36000
	buffer.writeUIntLE(ra, 8, 3)
	buffer.writeUIntLE(dec, 11, 3)
	buffer.writeUInt8(fields.bv ?? 40, 14)
	buffer.writeUInt8(fields.vmag, 15)
	return buffer
}

// Builds a complete file: header, the full zone table of the level and the records of each zone in the given
// order. `zones` maps zone numbers (the global zone is 20 × 4^level) to their encoded records.
export function buildStarFile(header: HeaderFields, zones: ReadonlyMap<number, readonly Buffer[]>) {
	const zoneCount = 20 * 4 ** header.level + 1
	const table = Buffer.alloc(4 * zoneCount)
	const records: Buffer[] = []

	for (let zone = 0; zone < zoneCount; zone++) {
		const list = zones.get(zone)
		if (list === undefined) continue
		table.writeUInt32LE(list.length, 4 * zone)
		records.push(...list)
	}

	return Buffer.concat([encodeHeader(header), table, ...records])
}

// Returns the Star1 raw direction integers of a position.
export function directionRaw(ra: Angle, dec: Angle) {
	const v = eraS2c(ra, dec)
	return vecMulScalar(v, 2e9, v)
}
