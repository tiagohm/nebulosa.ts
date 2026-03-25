import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { type Angle, deg, toMas } from '../src/angle'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogEntry } from '../src/star.catalog'
import { formatUcac4Id, openUcac4Catalog, type Ucac4Catalog } from '../src/ucac4'

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
}

const FIXTURE_RECORDS: readonly FixtureRecord[] = [
	{ zone: 450, ra: deg(350), dec: deg(-0.25), apertureMag: 13.2, modelMag: 13.1, pmRaCosDecMasYr: 3, pmDecMasYr: 2 },
	{ zone: 451, ra: deg(0.1), dec: deg(0.05), apertureMag: 12.1, modelMag: 12, includeProperMotion: false },
	{ zone: 451, ra: deg(10), dec: deg(0.1), apertureMag: 14.5, modelMag: 14.3, pmRaCosDecMasYr: 4, pmDecMasYr: -1, objectType: 1 },
	{ zone: 451, ra: deg(359.9), dec: 0, apertureMag: 9.5, modelMag: 9.3, pmRaCosDecMasYr: 20, pmDecMasYr: -10 },
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
	expect(idsOf(result)).toEqual([formatUcac4Id(451, 1), formatUcac4Id(451, 3)])
})

test('queries a box that crosses RA 0', async () => {
	const result = await catalog.queryBox(deg(359.7), deg(0.3), deg(-0.1), deg(0.1))
	expect(idsOf(result)).toEqual([formatUcac4Id(451, 1), formatUcac4Id(451, 3)])
})

test('queries a polygon with tangent-plane filtering', async () => {
	const result = await catalog.queryPolygon([
		[deg(9.7), deg(-0.1)],
		[deg(10.3), deg(-0.1)],
		[deg(10.3), deg(0.3)],
		[deg(9.7), deg(0.3)],
	])

	expect(idsOf(result)).toEqual([formatUcac4Id(451, 2)])
})

test('supports streaming and compact projection', async () => {
	const ids: string[] = []

	for await (const entry of catalog.streamRegion({ kind: 'box', minRA: deg(349), maxRA: deg(360), minDEC: deg(-1), maxDEC: deg(1) })) {
		ids.push(entry.id)
	}

	expect(ids.sort()).toEqual([formatUcac4Id(450, 1), formatUcac4Id(451, 3)])
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

test('generic consumers can swap UCAC4 and a mock provider without changing query code', async () => {
	await assertGenericCatalogContract(catalog)

	const mock = await new MockCatalog([
		{ id: 'm1', rightAscension: deg(359.9), declination: 0, epoch: 2000, magnitude: 9.5, pmRA: 20, pmDEC: -10 },
		{ id: 'm2', rightAscension: deg(0.1), declination: deg(0.05), epoch: 2000, magnitude: 12.1 },
		{ id: 'm3', rightAscension: deg(10), declination: deg(0.1), epoch: 2000, magnitude: 14.5 },
	]).open({})

	try {
		await assertGenericCatalogContract(mock)
	} finally {
		await mock.close()
	}
})

class MockCatalog extends BaseStarCatalog {
	constructor(private readonly entries: readonly StarCatalogEntry[]) {
		super()
	}

	open(_source: unknown): Promise<this> {
		return Promise.resolve(this)
	}

	close(): Promise<void> {
		return Promise.resolve()
	}

	// biome-ignore lint/suspicious/useAwait: false positive
	protected async *streamCandidateEntries(_query: NormalizedStarCatalogQuery): AsyncIterable<StarCatalogEntry> {
		for (const entry of this.entries) {
			yield entry
		}
	}

	get(id: string): Promise<StarCatalogEntry | undefined> {
		return Promise.resolve(this.entries.find((entry) => entry.id === id))
	}
}

async function assertGenericCatalogContract(catalog: BaseStarCatalog) {
	const cone = await catalog.queryCone(0, 0, deg(0.3))
	expect(cone).toHaveLength(2)

	const box = await catalog.queryBox(deg(359.7), deg(0.3), deg(-0.2), deg(0.2))
	expect(box).toHaveLength(2)
}

function idsOf(items: readonly StarCatalogEntry[]) {
	return items.map((item) => item.id).sort()
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
			const index = (zone - 1) * BIN_COUNT + bin
			if (counts[index] === 0) starts[index] = i + 1
			counts[index]++
		}

		totalBytes += output.byteLength
		await fs.writeFile(zonePath, output)
	}

	const index = Buffer.allocUnsafe(INDEX_BYTES)

	for (let i = 0; i < starts.length; i++) {
		index.writeInt32LE(starts[i]!, i * 4)
		index.writeInt32LE(counts[i]!, (starts.length + i) * 4)
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
	buffer.writeInt32LE(record.zone * 100000 + recordNumber, offset + 68)
	buffer.writeInt16LE(0, offset + 72)
	buffer.writeInt32LE(0, offset + 74)
}
