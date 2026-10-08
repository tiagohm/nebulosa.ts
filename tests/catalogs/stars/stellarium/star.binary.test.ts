import { describe, expect, test } from 'bun:test'
import { decodeStellariumStar, parseStellariumStarHeader, parseStellariumStarZoneTable, readStellariumStarMagnitude, readStellariumStarPosition, type StellariumStarDataType, stellariumStarZoneCount } from '../../../../src/catalogs/stars/stellarium/star.binary'
import { PIOVERTWO } from '../../../../src/core/constants'
import type { MutVec2 } from '../../../../src/math/linear-algebra/vec2'
import { deg, mas, toDeg, toMas } from '../../../../src/math/units/angle'
import { toKilometerPerSecond } from '../../../../src/math/units/velocity'
import { encodeHeader, encodeStar1, encodeStar2, encodeStar3 } from '../../../util/stellarium.star'

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

// Real headers and records copied byte for byte from the Stellarium 25.x hip_gaia3 files (manifest version 27):
// stars_0_0v0_21.cat (MD5 0e8b8bb5d177c5caad433569140597e9), stars_2_0v0_17.cat (23d59734215dcbc539d9bf13eb4ed7f8),
// stars_3_0v0_10.cat (39c82706afb12b1a3d08eee92ddef5e5), stars_4_1v0_6.cat (f5e57f400291d3d0c247ec669b1a4a07) and
// stars_5_1v0_6.cat (eb2834985d5885ac03695084cded6897). The records derive from Gaia DR3 (ESA/Gaia/DPAC) and the
// Hipparcos catalogue (ESA). The references are independent of the Stellarium processing and of the synthetic
// encoders: gaiadr3.gaia_source at its J2016.0 reference epoch and gaiadr3.hipparcos2_best_neighbour (ESA Gaia
// archive TAP, queried 2026-10-07) and, for Sirius, the Hipparcos new reduction (VizieR I/311, J1991.25) propagated
// to J2016.0 with astropy 6.1.7 SkyCoord.apply_space_motion and RV -5.5 km/s. Tolerances are the storage
// quantization: Star1 positions 0.1 mas (unit vector x 2e9), motions 0.001 mas/yr, parallax 0.01 mas (0.02 mas
// steps); Star2 α and δ 0.5 mas (integer mas), dα/dt and dδ/dt 0.5 µas/yr, parallax 0.005 mas (0.01 mas steps).
// No Star3 file (level 6 and above) was available, so Star3 is covered by the synthetic tests only.
describe('real records', () => {
	const HEADER0 = '0a045f830000000000000000150000000000000030f8ffffb4fc154a'
	const HEADER2 = '0a045f83000000000000000011000000020000004c1d0000b4fc154a'
	const HEADER3 = '0a045f8300000000000000000a0000000300000028230000b4fc154a'
	const HEADER4 = '0a045f830100000000000000060000000400000004290000b4fc154a'
	const HEADER5 = '0a045f8301000000000000000600000005000000e02e0000b4fc154a'

	function decode(header: string, record: string, zone: number, recordNumber: number) {
		return decodeStellariumStar(Buffer.from(record, 'hex'), 0, parseStellariumStarHeader(Buffer.from(header, 'hex')), zone, recordNumber)
	}

	// Asserts the on-sky offsets Δα cos δ and Δδ from a reference in degrees, mas.
	function expectPosition(entry: { readonly rightAscension: number; readonly declination: number }, ra: number, dec: number, tolerance: number) {
		expect(Math.abs(toMas(entry.rightAscension - deg(ra)) * Math.cos(entry.declination))).toBeLessThanOrEqual(tolerance)
		expect(Math.abs(toMas(entry.declination - deg(dec)))).toBeLessThanOrEqual(tolerance)
	}

	// Asserts μα* = dα/dt cos δ and μδ against a reference in mas/yr.
	function expectMotion(entry: { readonly declination: number; readonly pmRA?: number; readonly pmDEC?: number }, pmra: number, pmdec: number, tolerance: number) {
		expect(Math.abs(toMas(entry.pmRA!) * Math.cos(entry.declination) - pmra)).toBeLessThanOrEqual(tolerance)
		expect(Math.abs(toMas(entry.pmDEC!) - pmdec)).toBeLessThanOrEqual(tolerance)
	}

	test('headers', () => {
		const expected = [
			[HEADER0, 0, 48, 21, 0, -2],
			[HEADER2, 0, 48, 17, 2, 7.5],
			[HEADER3, 0, 48, 10, 3, 9],
			[HEADER4, 1, 32, 6, 4, 10.5],
			[HEADER5, 1, 32, 6, 5, 12],
		] as const

		for (const [hex, dataType, recordSize, minor, level, magnitudeMin] of expected) {
			const header = parseStellariumStarHeader(Buffer.from(hex, 'hex'))
			expect([header.dataType, header.recordSize, header.majorVersion, header.minorVersion, header.level, header.magnitudeMin]).toEqual([dataType, recordSize, 0, minor, level, magnitudeMin])
			expect(header.epochJD).toBe(2457389)
			expect(header.epoch).toBe(2016)
			expect(header.zoneCount).toBe(stellariumStarZoneCount(level))
		}
	})

	test('star1 Sirius, a Hipparcos star without Gaia source in the global zone', () => {
		const entry = decode(HEADER0, '000000000000000044c0a8e99814f66f5c75b3ddd4380900465dfcff1f20eeff00004cfa104a9e00c9ffd10521a1cb0f', 20, 0)

		expect(entry.gaiaId).toBe(0n)
		expect(entry.hipId).toBe(32349)
		expect(entry.componentId).toBe(1)
		expect(entry.magnitude).toBe(-1.46)
		expect(entry.bv).toBe(0)
		expect(entry.spectralIndex).toBe(1489)
		expect(entry.objectTypeIndex).toBe(33)
		expect(toKilometerPerSecond(entry.rv!)).toBeCloseTo(-5.5, 12)
		// HIP2: parallax 379.21 ± 1.58 mas.
		expect(Math.abs(toMas(entry.parallax!) - 379.21)).toBeLessThanOrEqual(0.01)
		expect(toMas(entry.parallaxError!)).toBeCloseTo(1.58, 12)
		// The propagation of the HIP2 astrometry to J2016.0 bounds the Stellarium one to about 1 mas and 0.1 mas/yr.
		expectPosition(entry, 101.28462128322414, -16.72155207305028, 1)
		expectMotion(entry, -546.0917125161423, -1223.1883710241416, 0.1)
	})

	test('star1 Barnard star with Gaia source, Hipparcos number and radial velocity', () => {
		const entry = decode(HEADER2, '0025c90020b1123e7a43dbfe5b2d3489737dd90947e5f3ff742e0d00b3939d00c1062725d56a0400b3fbb2102920f02a', 320, 7762)

		expect(entry.gaiaId).toBe(4472832130942575872n)
		// gaiadr3.hipparcos2_best_neighbour of the source.
		expect(entry.hipId).toBe(87937)
		expect(entry.componentId).toBe(0)
		expect(entry.magnitude).toBe(9.511)
		expect(entry.bv).toBe(1.729)
		expect(entry.spectralIndex).toBe(4274)
		expect(entry.objectTypeIndex).toBe(41)
		expect([entry.level, entry.zone, entry.recordNumber]).toEqual([2, 320, 7762])
		expectPosition(entry, 269.44850252543836, 4.739420051112412, 0.1)
		expectMotion(entry, -801.5509783684709, 10362.394206546573, 0.001)
		expect(Math.abs(toMas(entry.parallax!) - 546.975939730948)).toBeLessThanOrEqual(0.01)
		expect(Math.abs(toMas(entry.parallaxError!) - 0.040116355)).toBeLessThanOrEqual(0.005)
		// Not the Gaia DR3 radial velocity (-110.47 km/s): Stellarium takes it from another source.
		expect(toKilometerPerSecond(entry.rv!)).toBeCloseTo(-110.1, 12)
	})

	test('star1 Gaia source without Hipparcos number', () => {
		const entry = decode(HEADER3, '00fbf416001b1f4264538b1010df674005770f9dab15030021a408000e2406004f05f528cc0801001900000017000000', 801, 252)

		expect(entry.gaiaId).toBe(4764556617980377856n)
		expect(entry.hipId).toBeUndefined()
		expect(entry.componentId).toBeUndefined()
		expect(entry.magnitude).toBe(10.485)
		expect(entry.bv).toBe(1.359)
		expectPosition(entry, 75.59361064924794, -56.095187764521555, 0.1)
		expectMotion(entry, -54.90248719211675, 721.4683244862313, 0.001)
		expect(Math.abs(toMas(entry.parallax!) - 45.048700628755284)).toBeLessThanOrEqual(0.01)
		expect(Math.abs(toKilometerPerSecond(entry.rv!) - 2.4832761)).toBeLessThanOrEqual(0.05)
	})

	test('star2 records near the poles, on RA 360° and with a large proper motion', () => {
		const cases = [
			// Northernmost record of level 4: μα* is dα/dt × cos δ with cos δ ≈ 0.003.
			[HEADER4, '801a1e00e1fcff0fa59d671a66a346132295f5ff4e100000c104662c8e000100', 4885, 71, 1152918072929950336n, 11.366, 1.217, 123.05505036795934, 89.83234830529616, -1.9976801193438884, 4.173698783266151, 1.424114118739336],
			// RA 359.9999°, just before the wrap to 0.
			[HEADER4, '80381a00e119182675623f4d7e1b1e015bedffff60e1fffff901f82c19010300', 491, 97, 2744972427042371712n, 11.512, 0.505, 359.99989015231387, 5.208426104846906, -4.753515943026849, -7.840295972872681, 2.8118095128296563],
			// Fastest record of level 5, 5.2″/yr.
			[HEADER5, '808f41001179ff2ab94c641a85ace0012b841000b444b2ffc8068232b4390900', 14906, 137, 3098328182579892096n, 12.93, 1.736, 122.99468256110134, 8.750401522062495, 1069.811738087307, -5094.220103378359, 147.72184850183513],
			// Southernmost record of level 5.
			[HEADER5, '805f2c005900004885889117fe0cb3ec1ba63f00b220000005032232c7000100', 13226, 117, 5188147152985808768n, 12.834, 0.773, 109.83712126245663, -89.94723600961412, 3.8413636557018354, 8.370251942981383, 1.987918207684147],
		] as const

		for (const [header, record, zone, recordNumber, gaiaId, magnitude, bv, ra, dec, pmra, pmdec, parallax] of cases) {
			const entry = decode(header, record, zone, recordNumber)

			expect(entry.gaiaId).toBe(gaiaId)
			expect(entry.magnitude).toBe(magnitude)
			expect(entry.bv).toBe(bv)
			expect(entry.hipId).toBeUndefined()
			expect(entry.rv).toBeUndefined()
			// Integer mas in α and δ: 0.5 mas each, compared as coordinates rather than on the sky.
			expect(Math.abs(toMas(entry.rightAscension - deg(ra)))).toBeLessThanOrEqual(0.5)
			expect(Math.abs(toMas(entry.declination - deg(dec)))).toBeLessThanOrEqual(0.5)
			expectMotion(entry, pmra, pmdec, 0.001)
			expect(Math.abs(toMas(entry.parallax!) - parallax)).toBeLessThanOrEqual(0.005)
		}
	})
})
