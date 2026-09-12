import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { openUcac4Catalog, type Ucac4Catalog, type Ucac4CatalogEntry } from '../../../src/catalogs/stars/ucac4'
import { type Angle, deg, toMas } from '../../../src/math/units/angle'

const RECORD_SIZE = 78
const ZONE_COUNT = 900
const BIN_COUNT = 1440
const INDEX_BYTES = ZONE_COUNT * BIN_COUNT * 4 * 2

interface FixtureRecord {
	readonly zone: number
	readonly ra: Angle
	readonly dec: Angle
	readonly apertureMag?: number
	readonly modelMag?: number
	readonly pmRaCosDecMasYr?: number
	readonly pmDecMasYr?: number
	readonly objectType?: number
	readonly includeProperMotion?: boolean
	readonly uniqueStarNumber?: number
}

const FIXTURE_RECORDS: readonly FixtureRecord[] = [
	{ zone: 450, ra: deg(350), dec: deg(-0.25), apertureMag: 13.2, modelMag: 13.1, pmRaCosDecMasYr: 3, pmDecMasYr: 2 },
	{ zone: 451, ra: deg(0.1), dec: deg(0.05), apertureMag: 12.1, modelMag: 12, includeProperMotion: false },
	{ zone: 451, ra: deg(10), dec: deg(0.1), apertureMag: 14.5, modelMag: 14.3, pmRaCosDecMasYr: 4, pmDecMasYr: -1, objectType: 1 },
	{ zone: 451, ra: deg(359.9), dec: 0, apertureMag: 9.5, modelMag: 9.3, pmRaCosDecMasYr: 20, pmDecMasYr: -10 },
	{ zone: 452, ra: deg(0.25), dec: deg(0.25), apertureMag: 10.8, modelMag: 10.7, pmRaCosDecMasYr: 1, pmDecMasYr: 1 },
	{ zone: 452, ra: deg(15), dec: deg(0.25), apertureMag: 11.2, modelMag: 11.1, pmRaCosDecMasYr: -5, pmDecMasYr: 3 },
] as const

let catalog: Ucac4Catalog

beforeAll(async () => {
	catalog = await createCatalog()
})

afterAll(async () => {
	await catalog.close()
	await fs.rm(catalog.root, { recursive: true, force: true })
})

test('queries a cone with RA wrap-around and native index use', async () => {
	const result = await catalog.queryCone(0, 0, deg(0.3))
	expect(idsOf(result)).toEqual(['451-1', '451-3'])
})

test('queries a box that crosses RA 0', async () => {
	const result = await catalog.queryBox(deg(359.7), deg(0.3), deg(-0.1), deg(0.1))
	expect(idsOf(result)).toEqual(['451-1', '451-3'])
})

test('reads zone 451 from the first RA bin in the native Fortran index', async () => {
	const result = await catalog.queryBox(0, deg(0.25), 0, deg(0.2))
	expect(idsOf(result)).toEqual(['451-1'])
})

test('includes stars when maxRA falls exactly on a UCAC4 index bin boundary', async () => {
	const result = await catalog.queryBox(0, deg(0.25), deg(0.2), deg(0.3))
	expect(idsOf(result)).toEqual(['452-1'])
})

test('queries a polygon with tangent-plane filtering', async () => {
	const result = await catalog.queryPolygon([
		[deg(9.7), deg(-0.1)],
		[deg(10.3), deg(-0.1)],
		[deg(10.3), deg(0.3)],
		[deg(9.7), deg(0.3)],
	])

	expect(idsOf(result)).toEqual(['451-2'])
})

test('supports streaming and compact projection', async () => {
	const ids: string[] = []

	for await (const entry of catalog.streamRegion({ kind: 'box', minRA: deg(349), maxRA: deg(360), minDEC: deg(-1), maxDEC: deg(1) })) {
		ids.push(`${entry.zone}-${entry.recordNumber}`)
	}

	expect(ids.sort()).toEqual(['450-1', '451-3'])
})

test('fails cleanly when no UCAC4 zone files exist', async () => {
	const root = await fs.mkdtemp(join(tmpdir(), 'nebulosa-ucac4-empty-'))

	try {
		expect(openUcac4Catalog(root)).rejects.toThrow()
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test('detects malformed records with invalid coordinates', async () => {
	const root = await fs.mkdtemp(join(tmpdir(), 'nebulosa-ucac4-bad-'))

	try {
		await fs.mkdir(join(root, 'u4b'), { recursive: true })
		const bad = Buffer.alloc(RECORD_SIZE)
		bad.writeInt32LE(-1, 0)
		bad.writeInt32LE(324000000, 4)
		await fs.writeFile(join(root, 'u4b', 'z451'), bad)

		const catalog = await openUcac4Catalog(root)

		try {
			expect(catalog.queryCone(0, 0, deg(1))).rejects.toThrow()
		} finally {
			await catalog.close()
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test('preserves ordinary proper motion and its no-data flags without a supplement', async () => {
	const entry = (await catalog.get(451, 2))!
	expect(toMas(entry.pmRA!) * Math.cos(entry.declination)).toBeCloseTo(4, 10)
	expect(toMas(entry.pmDEC!)).toBeCloseTo(-1, 10)
	const missing = (await catalog.get(451, 1))!
	expect(missing.pmRA).toBeUndefined()
	expect(missing.pmDEC).toBeUndefined()
})

test.each([
	['', 3276.7, 3276.7],
	['u4i', 3276.7, 3141.3],
	['u4i', 1099, 3276.7],
] as const)('loads high proper motion from "%s" with stored components %s/%s', async (directory: string, pmRA: number, pmDEC: number) => {
	const root = await fs.mkdtemp(join(tmpdir(), 'nebulosa-ucac4-hpm-'))
	let localCatalog: Ucac4Catalog | undefined

	try {
		await fs.mkdir(join(root, directory), { recursive: true })
		const tablePath = join(root, directory, 'u4hpm.dat')
		// USNO readme_u4 section 5c: retain the sample IDs and motions, with synthetic local record numbers.
		await fs.writeFile(tablePath, '          1 644 101666   41087   31413 1140226325  463469832 20000\r\n  113038183 494  48937   10990  -51230  442763714  355581607 12513\r\n\r\n')
		const decOnly = pmRA !== 3276.7
		const record: FixtureRecord = {
			zone: decOnly ? 494 : 644,
			ra: deg(10),
			dec: deg(decOnly ? 8.7 : 38.7),
			pmRaCosDecMasYr: pmRA,
			pmDecMasYr: pmDEC,
			uniqueStarNumber: decOnly ? 113038183 : 1,
		}
		const records = Buffer.alloc(RECORD_SIZE * 3)
		writeRecord(records, 0, record, 1)
		writeRecord(records, RECORD_SIZE, { ...record, uniqueStarNumber: 999 }, 2)
		writeRecord(records, RECORD_SIZE * 2, record, 3)
		records.writeInt8(127, RECORD_SIZE * 2 + 28)
		await fs.writeFile(join(root, `z${record.zone}`), records)
		localCatalog = await openUcac4Catalog(root)

		const expectedRA = decOnly ? 1099 : 4108.7
		const expectedDEC = decOnly ? -5123 : 3141.3
		const entry = (await localCatalog.get(record.zone, 1))!
		expect(toMas(entry.pmRA!) * Math.cos(entry.declination)).toBeCloseTo(expectedRA, 8)
		expect(toMas(entry.pmDEC!)).toBeCloseTo(expectedDEC, 8)
		const result = await localCatalog.queryCone(record.ra, record.dec, deg(0.01))
		expect(result).toHaveLength(3)
		expect(result[0]).toEqual(entry)
		for (const missing of result.slice(1)) {
			expect(missing.pmRA).toBeUndefined()
			expect(missing.pmDEC).toBeUndefined()
		}

		await localCatalog.close()
		await fs.rm(tablePath)
		await localCatalog.open(root)
		const withoutTable = (await localCatalog.get(record.zone, 1))!
		expect(withoutTable.pmRA).toBeUndefined()
		expect(withoutTable.pmDEC).toBeUndefined()
	} finally {
		await localCatalog?.close()
		await fs.rm(root, { recursive: true, force: true })
	}
})

test.each(['1 644 1 NaN 31413 1140226325 463469832 20000', '1 644 1 41087', '1 644 1 41087 31413 1140226325 463469832 20000\n1 644 2 41087 31413 1140226325 463469832 20000'])('rejects malformed high proper motion data: %s', async (data: string) => {
	const root = await fs.mkdtemp(join(tmpdir(), 'nebulosa-ucac4-hpm-bad-'))

	try {
		await fs.writeFile(join(root, 'z644'), Buffer.alloc(RECORD_SIZE))
		await fs.writeFile(join(root, 'u4hpm.dat'), data)
		expect(openUcac4Catalog(root)).rejects.toThrow('corrupt UCAC4 high proper motion file')
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

function idsOf(items: readonly Ucac4CatalogEntry[]) {
	return items.map((item) => `${item.zone}-${item.recordNumber}`).sort()
}

async function createCatalog() {
	const root = await fs.mkdtemp(join(tmpdir(), 'nebulosa-ucac4-'))
	const zoneDirectory = join(root, 'u4b')
	const indexDirectory = join(root, 'u4i')

	await fs.mkdir(zoneDirectory, { recursive: true })
	await fs.mkdir(indexDirectory, { recursive: true })

	const byZone = new Map<number, FixtureRecord[]>()

	for (const record of FIXTURE_RECORDS) {
		const bucket = byZone.get(record.zone) ?? []
		bucket.push(record)
		byZone.set(record.zone, bucket)
	}

	let totalBytes = 0
	const starts = new Int32Array(ZONE_COUNT * BIN_COUNT)
	const counts = new Int32Array(ZONE_COUNT * BIN_COUNT)

	for (const [zone, records] of byZone) {
		records.sort((left, right) => left.ra - right.ra)
		const zonePath = join(zoneDirectory, `z${`${zone}`.padStart(3, '0')}`)
		const output = Buffer.allocUnsafe(records.length * RECORD_SIZE)

		for (let i = 0; i < records.length; i++) {
			writeRecord(output, i * RECORD_SIZE, records[i], i + 1)
			const bin = Math.min(BIN_COUNT - 1, Math.floor(records[i].ra / deg(0.25)))
			// USNO readme_u4 section 5c: n0(900,1440), with n0 the predecessor record number.
			const index = bin * ZONE_COUNT + zone - 1
			if (counts[index] === 0) starts[index] = i
			counts[index]++
		}

		totalBytes += output.byteLength
		await fs.writeFile(zonePath, output)
	}

	const index = Buffer.allocUnsafe(INDEX_BYTES)

	for (let i = 0; i < starts.length; i++) {
		index.writeInt32LE(starts[i], i * 4)
		index.writeInt32LE(counts[i], (starts.length + i) * 4)
	}

	await fs.writeFile(join(indexDirectory, 'u4index.unf'), index)

	return await openUcac4Catalog(root)
}

function writeRecord(buffer: Buffer, offset: number, record: FixtureRecord, recordNumber: number) {
	buffer.writeInt32LE(Math.round(toMas(record.ra)), offset)
	buffer.writeInt32LE(Math.round(toMas(record.dec) + 324000000), offset + 4)
	buffer.writeInt16LE(Math.round((record.modelMag ?? 20) * 1000), offset + 8)
	buffer.writeInt16LE(Math.round((record.apertureMag ?? 20) * 1000), offset + 10)
	buffer.writeInt8(5, offset + 12)
	buffer.writeUInt8(record.objectType ?? 0, offset + 13)
	buffer.writeUInt8(0, offset + 14)
	buffer.writeInt8(15 - 128, offset + 15)
	buffer.writeInt8(16 - 128, offset + 16)
	buffer.writeUInt8(3, offset + 17)
	buffer.writeUInt8(3, offset + 18)
	buffer.writeUInt8(2, offset + 19)
	buffer.writeInt16LE(10000, offset + 20)
	buffer.writeInt16LE(10000, offset + 22)
	buffer.writeInt16LE(record.includeProperMotion === false ? 0 : Math.round((record.pmRaCosDecMasYr ?? 0) * 10), offset + 24)
	buffer.writeInt16LE(record.includeProperMotion === false ? 0 : Math.round((record.pmDecMasYr ?? 0) * 10), offset + 26)
	buffer.writeInt8((record.includeProperMotion === false ? 255 : 30) - 128, offset + 28)
	buffer.writeInt8((record.includeProperMotion === false ? 255 : 40) - 128, offset + 29)
	buffer.writeInt32LE(recordNumber * 10, offset + 30)
	buffer.writeInt16LE(11000, offset + 34)
	buffer.writeInt16LE(10800, offset + 36)
	buffer.writeInt16LE(10700, offset + 38)
	buffer.writeUInt8(5, offset + 40)
	buffer.writeUInt8(5, offset + 41)
	buffer.writeUInt8(5, offset + 42)
	buffer.writeUInt8(3, offset + 43)
	buffer.writeUInt8(3, offset + 44)
	buffer.writeUInt8(3, offset + 45)
	buffer.writeInt16LE(12000, offset + 46)
	buffer.writeInt16LE(11900, offset + 48)
	buffer.writeInt16LE(11800, offset + 50)
	buffer.writeInt16LE(11700, offset + 52)
	buffer.writeInt16LE(11600, offset + 54)
	buffer.writeInt8(2, offset + 56)
	buffer.writeInt8(2, offset + 57)
	buffer.writeInt8(2, offset + 58)
	buffer.writeInt8(2, offset + 59)
	buffer.writeInt8(2, offset + 60)
	buffer.writeUInt8(0, offset + 61)
	buffer.writeInt32LE(300000000, offset + 62)
	buffer.writeUInt8(0, offset + 66)
	buffer.writeUInt8(0, offset + 67)
	buffer.writeInt32LE(record.uniqueStarNumber ?? record.zone * 100000 + recordNumber, offset + 68)
	buffer.writeInt16LE(0, offset + 72)
	buffer.writeInt32LE(0, offset + 74)
}
