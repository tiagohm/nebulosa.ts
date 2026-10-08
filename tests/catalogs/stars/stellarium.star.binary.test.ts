import { describe, expect, test } from 'bun:test'
import { PIOVERTWO } from 'nebulosa/src/core/constants'
import { decodeStellariumStar, parseStellariumStarHeader, parseStellariumStarZoneTable, readStellariumStarMagnitude, readStellariumStarPosition, type StellariumStarDataType, stellariumStarZoneCount } from '../../../src/catalogs/stars/stellarium.star.binary'
import type { MutVec2 } from '../../../src/math/linear-algebra/vec2'
import { deg, mas, toDeg, toMas } from '../../../src/math/units/angle'
import { toKilometerPerSecond } from '../../../src/math/units/velocity'
import { encodeHeader, encodeStar1, encodeStar2, encodeStar3 } from '../../util/stellarium.star'

const CONTEXT0 = { dataType: 0, epoch: 2016, level: 0 } as const
const CONTEXT1 = { dataType: 1, epoch: 2016, level: 4 } as const
const CONTEXT2 = { dataType: 2, epoch: 2016, level: 8 } as const

describe('header', () => {
	test('canonical little-endian header', () => {
		const header = parseStellariumStarHeader(encodeHeader({ dataType: 0, level: 0, minor: 21, magMinMillimag: -2000, epochJD: 2457389 }))

		expect(header.dataType).toBe(0)
		expect(header.recordSize).toBe(48)
		expect(header.majorVersion).toBe(0)
		expect(header.minorVersion).toBe(21)
		expect(header.level).toBe(0)
		expect(header.magnitudeMin).toBe(-2)
		expect(header.epochJD).toBe(2457389)
		expect(header.epoch).toBe(2016)
		expect(header.zoneCount).toBe(21)
		expect(header.dataOffset).toBe(28 + 4 * 21)
	})

	test('record sizes and zone counts', () => {
		expect(parseStellariumStarHeader(encodeHeader({ dataType: 1, level: 5 })).recordSize).toBe(32)
		expect(parseStellariumStarHeader(encodeHeader({ dataType: 2, level: 8 })).recordSize).toBe(16)
		expect(parseStellariumStarHeader(encodeHeader({ dataType: 2, level: 8 })).zoneCount).toBe(1310721)
		for (let level = 0; level <= 8; level++) expect(stellariumStarZoneCount(level)).toBe(20 * 4 ** level + 1)
	})

	test('header inside a subarray', () => {
		const padded = Buffer.concat([Buffer.alloc(13, 0xff), encodeHeader({ dataType: 1, level: 3, magMinMillimag: 9000 })])
		expect(parseStellariumStarHeader(padded.subarray(13)).magnitudeMin).toBe(9)
		expect(parseStellariumStarHeader(padded, 13).level).toBe(3)
	})

	test('rejects unknown and unsupported magic', () => {
		expect(() => parseStellariumStarHeader(encodeHeader({ dataType: 0, level: 0, magic: 0x0a045f83 }))).toThrow('byte-swapped')
		expect(() => parseStellariumStarHeader(encodeHeader({ dataType: 0, level: 0, magic: 0x835f040b }))).toThrow('native-endian')
		expect(() => parseStellariumStarHeader(encodeHeader({ dataType: 0, level: 0, magic: 0x12345678 }))).toThrow('magic')
	})

	test('rejects unsupported type, version, level and epoch', () => {
		expect(() => parseStellariumStarHeader(encodeHeader({ dataType: 3, level: 0 }))).toThrow('data type 3')
		expect(() => parseStellariumStarHeader(encodeHeader({ dataType: 0, level: 0, major: 1 }))).toThrow('major version 1')
		expect(() => parseStellariumStarHeader(encodeHeader({ dataType: 0, level: 11 }))).toThrow('level 11')
		expect(() => parseStellariumStarHeader(encodeHeader({ dataType: 0, level: 0xffffffff }))).toThrow('level')
		expect(() => parseStellariumStarHeader(encodeHeader({ dataType: 0, level: 0, epochJD: Number.NaN }))).toThrow('epoch')
		expect(() => parseStellariumStarHeader(Buffer.alloc(27))).toThrow('truncated')
	})
})

describe('zone table', () => {
	test('prefix sums', () => {
		const table = Buffer.alloc(16)
		table.writeUInt32LE(3, 0)
		table.writeUInt32LE(0, 4)
		table.writeUInt32LE(5, 8)
		table.writeUInt32LE(1, 12)
		const index = parseStellariumStarZoneTable(table, 4)
		expect([...index.starts]).toEqual([0, 3, 3, 8, 9])
		expect(index.recordCount).toBe(9)
	})

	test('rejects truncated tables and record counts that overflow 32 bits', () => {
		expect(() => parseStellariumStarZoneTable(Buffer.alloc(7), 2)).toThrow('truncated')
		const table = Buffer.alloc(8)
		table.writeUInt32LE(0xffffffff, 0)
		table.writeUInt32LE(1, 4)
		expect(() => parseStellariumStarZoneTable(table, 2)).toThrow('too many records')
	})
})

describe('star1', () => {
	test('position from the absolute direction vector', () => {
		const cases = [
			[0, 0],
			[90, 0],
			[180, 45],
			[270, -60],
			[359.99, 10],
			[101.287, -16.716],
		] as const

		for (const [ra, dec] of cases) {
			const entry = decodeStellariumStar(encodeStar1({ ra: deg(ra), dec: deg(dec), vmagMillimag: 1000 }), 0, CONTEXT0, 3, 0)
			expect(toDeg(entry.rightAscension)).toBeCloseTo(ra, 7)
			expect(toDeg(entry.declination)).toBeCloseTo(dec, 7)
			expect(entry.rightAscension).toBeGreaterThanOrEqual(0)
		}
	})

	test('quantized vector that is not exactly unit length', () => {
		// 1.000001 times the unit vector, as the int32 rounding of real files may produce.
		const entry = decodeStellariumStar(encodeStar1({ xyz: [0, 1414214976, 1414214976], vmagMillimag: 0 }), 0, CONTEXT0, 0, 0)
		expect(toDeg(entry.rightAscension)).toBeCloseTo(90, 12)
		expect(toDeg(entry.declination)).toBeCloseTo(45, 12)
	})

	test('vector proper motion projected on east and north', () => {
		const ra = deg(40)
		const dec = deg(30)
		// μα* = 100 mas/yr, μδ = -50 mas/yr expressed as a tangential vector, µas/yr.
		const p = [-Math.sin(ra), Math.cos(ra), 0]
		const q = [-Math.cos(ra) * Math.sin(dec), -Math.sin(ra) * Math.sin(dec), Math.cos(dec)]
		const pm = [0, 1, 2].map((i) => Math.round(100000 * p[i] - 50000 * q[i])) as unknown as [number, number, number]
		const entry = decodeStellariumStar(encodeStar1({ ra, dec, pm, vmagMillimag: 5000 }), 0, CONTEXT0, 0, 0)

		expect(toMas(entry.pmRA!) * Math.cos(entry.declination)).toBeCloseTo(100, 2)
		expect(toMas(entry.pmRA!)).toBeCloseTo(100 / Math.cos(dec), 2)
		expect(toMas(entry.pmDEC!)).toBeCloseTo(-50, 2)
	})

	test('proper motion near and on the pole', () => {
		const near = decodeStellariumStar(encodeStar1({ xyz: [1, 0, 2000000000], pm: [0, 0, 0], vmagMillimag: 2000 }), 0, CONTEXT0, 0, 0)
		expect(near.pmRA).toBeUndefined()
		expect(near.pmDEC).toBeUndefined()

		const moving = decodeStellariumStar(encodeStar1({ xyz: [1, 0, 2000000000], pm: [-30000, 20000, 0], vmagMillimag: 2000 }), 0, CONTEXT0, 0, 0)
		// cos δ = 5e-10: the RA rate is undefined, the declination rate along -x is finite.
		expect(moving.pmRA).toBeUndefined()
		expect(toMas(moving.pmDEC!)).toBeCloseTo(30, 6)

		const pole = decodeStellariumStar(encodeStar1({ xyz: [0, 0, 2000000000], pm: [10000, 0, 0], vmagMillimag: 2000 }), 0, CONTEXT0, 0, 0)
		expect(pole.declination).toBe(PIOVERTWO)
		expect(pole.pmRA).toBeUndefined()
		expect(pole.pmDEC).toBeUndefined()
	})

	test('photometry, parallax, radial velocity and identifiers', () => {
		const buffer = encodeStar1({ gaiaId: 2947050466531873024n, ra: deg(101.28), dec: deg(-16.72), bvMillimag: -123, vmagMillimag: -1460, plx: 18960, plxErr: 2345, rv: -55, spInt: 513, objType: 7, hip: 32349, component: 1 })
		const entry = decodeStellariumStar(buffer, 0, CONTEXT0, 7, 2)

		expect(entry.gaiaId).toBe(2947050466531873024n)
		expect(entry.magnitude).toBe(-1.46)
		expect(entry.bv).toBe(-0.123)
		expect(toMas(entry.parallax!)).toBeCloseTo(379.2, 10)
		expect(toMas(entry.parallaxError!)).toBeCloseTo(23.45, 10)
		expect(toKilometerPerSecond(entry.rv!)).toBeCloseTo(-5.5, 10)
		expect(entry.spectralIndex).toBe(513)
		expect(entry.objectTypeIndex).toBe(7)
		expect(entry.hipId).toBe(32349)
		expect(entry.componentId).toBe(1)
		expect(entry.epoch).toBe(2016)
		expect(entry.level).toBe(0)
		expect(entry.zone).toBe(7)
		expect(entry.recordNumber).toBe(2)

		const positive = decodeStellariumStar(encodeStar1({ vmagMillimag: 0, rv: 1234 }), 0, CONTEXT0, 0, 0)
		expect(toKilometerPerSecond(positive.rv!)).toBeCloseTo(123.4, 10)
	})

	test('zero values are missing data', () => {
		const entry = decodeStellariumStar(encodeStar1({ ra: deg(10), dec: deg(10), vmagMillimag: 3000 }), 0, CONTEXT0, 0, 0)
		expect(entry.parallax).toBeUndefined()
		expect(entry.parallaxError).toBeUndefined()
		expect(entry.rv).toBeUndefined()
		expect(entry.pmRA).toBeUndefined()
		expect(entry.pmDEC).toBeUndefined()
		expect(entry.hipId).toBeUndefined()
		expect(entry.componentId).toBeUndefined()
		expect(entry.gaiaId).toBe(0n)
		// Every key is present so all entries share one object shape.
		expect(Object.keys(entry)).toHaveLength(18)
	})

	test('hipparcos number and component packing', () => {
		const a = decodeStellariumStar(encodeStar1({ vmagMillimag: 0, hip: 131071, component: 31 }), 0, CONTEXT0, 0, 0)
		expect(a.hipId).toBe(131071)
		expect(a.componentId).toBe(31)

		const b = decodeStellariumStar(encodeStar1({ vmagMillimag: 0, hip: 1, component: 0 }), 0, CONTEXT0, 0, 0)
		expect(b.hipId).toBe(1)
		expect(b.componentId).toBe(0)
	})
})

describe('star2', () => {
	test('position, rates without cos δ, photometry and parallax', () => {
		const buffer = encodeStar2({ gaiaId: 9007199254740993n, raMas: 301766400, decMas: -19440000, pmRaUas: 123456, pmDecUas: -7890, bvMillimag: 1234, vmagMillimag: 11234, plx: 1234, plxErr: 56 })
		const entry = decodeStellariumStar(buffer, 0, CONTEXT1, 100, 5)

		expect(entry.gaiaId).toBe(9007199254740993n)
		expect(toDeg(entry.rightAscension)).toBeCloseTo(83.824, 12)
		expect(toDeg(entry.declination)).toBeCloseTo(-5.4, 12)
		// dα/dt is stored directly: no division by cos δ.
		expect(toMas(entry.pmRA!)).toBeCloseTo(123.456, 10)
		expect(toMas(entry.pmDEC!)).toBeCloseTo(-7.89, 10)
		expect(entry.bv).toBe(1.234)
		expect(entry.magnitude).toBe(11.234)
		expect(toMas(entry.parallax!)).toBeCloseTo(12.34, 10)
		expect(toMas(entry.parallaxError!)).toBeCloseTo(0.56, 10)
		expect(entry.rv).toBeUndefined()
		expect(entry.hipId).toBeUndefined()
		expect(entry.spectralIndex).toBeUndefined()
		expect(entry.level).toBe(4)
	})

	test('missing motion and parallax', () => {
		const entry = decodeStellariumStar(encodeStar2({ raMas: 0, decMas: 324000000, vmagMillimag: 12000 }), 0, CONTEXT1, 0, 0)
		expect(entry.pmRA).toBeUndefined()
		expect(entry.pmDEC).toBeUndefined()
		expect(entry.parallax).toBeUndefined()
		expect(entry.declination).toBe(PIOVERTWO)

		const onlyDec = decodeStellariumStar(encodeStar2({ raMas: 0, decMas: 0, pmDecUas: 5, vmagMillimag: 12000 }), 0, CONTEXT1, 0, 0)
		expect(onlyDec.pmRA).toBe(0)
		expect(toMas(onlyDec.pmDEC!)).toBeCloseTo(0.005, 12)
	})
})

describe('star3', () => {
	test('position offsets and 0.1″ resolution', () => {
		const zero = decodeStellariumStar(encodeStar3({ ra24: 0, dec24: 0, vmag: 0 }), 0, CONTEXT2, 0, 0)
		expect(zero.rightAscension).toBe(0)
		expect(toDeg(zero.declination)).toBeCloseTo(-90, 12)

		const north = decodeStellariumStar(encodeStar3({ ra24: 12959999, dec24: 6480000, vmag: 0 }), 0, CONTEXT2, 0, 0)
		expect(toDeg(north.rightAscension)).toBeCloseTo(360 - 0.1 / 3600, 10)
		expect(toDeg(north.declination)).toBeCloseTo(90, 12)

		const equator = decodeStellariumStar(encodeStar3({ ra24: 1, dec24: 3240001, vmag: 0 }), 0, CONTEXT2, 0, 0)
		expect(equator.rightAscension).toBeCloseTo(mas(100), 15)
		expect(equator.declination).toBeCloseTo(mas(100), 15)
	})

	test('B−V in 0.025 mag steps and V offset by 16 mag', () => {
		const low = decodeStellariumStar(encodeStar3({ bv: 0, vmag: 0 }), 0, CONTEXT2, 0, 0)
		expect(low.bv).toBe(-1)
		expect(low.magnitude).toBe(16)

		const high = decodeStellariumStar(encodeStar3({ bv: 255, vmag: 255 }), 0, CONTEXT2, 0, 0)
		expect(high.bv).toBeCloseTo(5.375, 12)
		expect(high.magnitude).toBe(21.1)
		expect(high.pmRA).toBeUndefined()
		expect(high.parallax).toBeUndefined()
		expect(high.rv).toBeUndefined()
	})

	test('64-bit identifier limits', () => {
		expect(decodeStellariumStar(encodeStar3({ gaiaId: 9223372036854775807n, vmag: 0 }), 0, CONTEXT2, 0, 0).gaiaId).toBe(9223372036854775807n)
		expect(decodeStellariumStar(encodeStar3({ gaiaId: -9223372036854775808n, vmag: 0 }), 0, CONTEXT2, 0, 0).gaiaId).toBe(-9223372036854775808n)
	})
})

test('raw readers match the decoded entry for every layout and buffer offset', () => {
	const records: [StellariumStarDataType, Buffer][] = [
		[0, encodeStar1({ ra: deg(123.4), dec: deg(-56.7), vmagMillimag: 6543 })],
		[1, encodeStar2({ ra: deg(359.999), dec: deg(12.3), vmagMillimag: 10501 })],
		[2, encodeStar3({ ra: deg(0.5), dec: deg(-89.9), vmag: 77 })],
	]

	const position: MutVec2 = [0, 0]

	for (const [dataType, record] of records) {
		const context = { dataType, epoch: 2016, level: 0 }
		const padded = Buffer.concat([Buffer.alloc(9), record, Buffer.alloc(3)])
		// A view with a non-zero byteOffset over a larger allocation.
		const view = padded.subarray(5)
		const direct = decodeStellariumStar(record, 0, context, 1, 2)
		const shifted = decodeStellariumStar(view, 4, context, 1, 2)

		expect(shifted).toEqual(direct)
		expect(readStellariumStarMagnitude(view, 4, dataType)).toBe(direct.magnitude)
		readStellariumStarPosition(view, 4, dataType, position)
		expect(position[0]).toBe(direct.rightAscension)
		expect(position[1]).toBe(direct.declination)
	}
})
