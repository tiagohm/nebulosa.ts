import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { type Angle, deg, toMas } from '../src/angle'
import { BaseStarCatalog, type CatalogQueryStatsAccumulator, type NormalizedStarCatalogQuery, type StarCatalogCapabilities, type StarCatalogEntry, type StarCatalogMetadata } from '../src/star.catalog'
import { benchmarkUcac4Query, formatUcac4Id, openUcac4Catalog, type Ucac4Catalog, type Ucac4CatalogSource } from '../src/ucac4'

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

interface FixtureState {
	readonly root: string
	readonly catalog: Ucac4Catalog
	readonly totalBytes: number
}

const FIXTURE_RECORDS: readonly FixtureRecord[] = [
	{ zone: 450, ra: deg(350), dec: deg(-0.25), apertureMag: 13.2, modelMag: 13.1, pmRaCosDecMasYr: 3, pmDecMasYr: 2 },
	{ zone: 451, ra: deg(0.1), dec: deg(0.05), apertureMag: 12.1, modelMag: 12, includeProperMotion: false },
	{ zone: 451, ra: deg(10), dec: deg(0.1), apertureMag: 14.5, modelMag: 14.3, pmRaCosDecMasYr: 4, pmDecMasYr: -1, objectType: 1 },
	{ zone: 451, ra: deg(359.9), dec: 0, apertureMag: 9.5, modelMag: 9.3, pmRaCosDecMasYr: 20, pmDecMasYr: -10 },
	{ zone: 452, ra: deg(15), dec: deg(0.25), apertureMag: 11.2, modelMag: 11.1, pmRaCosDecMasYr: -5, pmDecMasYr: 3 },
] as const

const MOCK_METADATA: StarCatalogMetadata = {
	catalogName: 'mock',
	catalogVersion: '1',
	referenceEpoch: 2000,
	referenceFrame: 'ICRS',
	magnitudeSystems: ['test'],
	angularUnits: 'rad',
	properMotionAvailability: 'partial',
	photometricFields: ['test'],
	sourceIdentifierFormat: 'mock-id',
	storageLayout: 'in-memory array',
	zoneIndex: 'none',
	supportedQueryTypes: ['cone', 'box', 'polygon'],
	normalizedFieldAvailability: {
		always: ['id', 'ra', 'dec', 'epoch', 'sourceCatalog'],
		optional: ['pmRaMasYr', 'pmDecMasYr', 'mag', 'flags', 'extras'],
	},
}

const MOCK_CAPABILITIES: StarCatalogCapabilities = {
	featureNames: ['cone', 'box', 'polygon', 'streaming', 'projection', 'epoch-propagation'],
	queryTypes: ['cone', 'box', 'polygon'],
	efficientQueryTypes: ['cone', 'box', 'polygon'],
	supportsStreaming: true,
	supportsRawAccess: false,
	supportsMagnitudeFilter: true,
	supportsQualityFilter: true,
	supportsProjection: true,
	supportsEpochPropagation: true,
}

let fixture: FixtureState

beforeAll(async () => {
	fixture = await createFixture()
})

afterAll(async () => {
	await fixture.catalog.close()
	await fs.rm(fixture.root, { recursive: true, force: true })
})

test('opens metadata and capabilities', () => {
	expect(fixture.catalog.metadata().catalogName).toBe('UCAC4')
	expect(fixture.catalog.capabilities().supportsStreaming).toBeTrue()
	expect(fixture.catalog.supports('raw-access')).toBeTrue()
})

test('reads a raw UCAC4 record and preserves native fields', async () => {
	const raw = await fixture.catalog.getRawById(formatUcac4Id(451, 3))

	expect(raw).toBeDefined()
	expect(raw?.zone).toBe(451)
	expect(raw?.recordNumber).toBe(3)
	expect(raw?.apertureMagnitudeMillimag).toBe(9500)
})

test('queries a cone with RA wrap-around and native index use', async () => {
	const result = await fixture.catalog.queryCone(0, 0, deg(0.3), { sortMode: 'ra' })

	expect(idsOf(result.items)).toEqual([formatUcac4Id(451, 1), formatUcac4Id(451, 3)])
	expect(result.queryStats.usedSpatialIndex).toBeTrue()
	expect(result.queryStats.bytesRead).toBeLessThan(fixture.totalBytes)
})

test('queries a box that crosses RA 0', async () => {
	const result = await fixture.catalog.queryBox(deg(359.7), deg(0.3), deg(-0.1), deg(0.1), { sortMode: 'id' })
	expect(idsOf(result.items)).toEqual([formatUcac4Id(451, 1), formatUcac4Id(451, 3)])
})

test('queries a polygon with tangent-plane filtering', async () => {
	const result = await fixture.catalog.queryPolygon(
		[
			[deg(9.7), deg(-0.1)],
			[deg(10.3), deg(-0.1)],
			[deg(10.3), deg(0.3)],
			[deg(9.7), deg(0.3)],
		],
		{ sortMode: 'id' },
	)

	expect(idsOf(result.items)).toEqual([formatUcac4Id(451, 2)])
	expect(result.queryStats.geometryMode).toBe('planar-tangent')
})

test('filters by magnitude, truncates, and sorts', async () => {
	const result = await fixture.catalog.queryBox(0, deg(20), deg(-1), deg(1), { magnitudeMin: 11, magnitudeMax: 15, sortMode: 'mag', limit: 2 })

	expect(result.truncated).toBeTrue()
	expect(result.items).toHaveLength(2)
	expect(result.items[0]?.mag).toBeCloseTo(11.2, 6)
	expect(result.items[1]?.mag).toBeCloseTo(12.1, 6)
})

test('propagates proper motion and keeps missing motion unchanged by default', async () => {
	const propagated = await fixture.catalog.getById(formatUcac4Id(451, 3), { epochPropagation: { targetEpoch: 2010 } })
	const missing = await fixture.catalog.getById(formatUcac4Id(451, 1), { epochPropagation: { targetEpoch: 2010 } })

	expect(propagated?.epoch).toBe(2010)
	expect(propagated?.ra).toBeCloseTo(deg(359.9000555556), 11)
	expect(missing?.epoch).toBe(2000)
})

test('can exclude missing proper motion during propagation', async () => {
	const missing = await fixture.catalog.getById(formatUcac4Id(451, 1), { epochPropagation: { targetEpoch: 2010, onMissingProperMotion: 'exclude' } })
	expect(missing).toBeUndefined()
})

test('supports streaming and compact projection', async () => {
	const ids: string[] = []

	for await (const entry of fixture.catalog.streamRegion({ kind: 'box', minRa: deg(349), maxRa: deg(360), minDec: deg(-1), maxDec: deg(1), requestedFields: ['mag'] })) {
		ids.push(entry.id)
		expect(entry.sourceCatalog).toBe('UCAC4')
	}

	expect(ids.sort()).toEqual([formatUcac4Id(450, 1), formatUcac4Id(451, 3)])
})

test('estimates candidate counts and benchmarks query execution', async () => {
	expect(await fixture.catalog.estimateCount({ kind: 'cone', centerRa: 0, centerDec: 0, radius: deg(0.3) })).toBeGreaterThanOrEqual(2)

	const benchmark = await benchmarkUcac4Query(fixture.catalog, { kind: 'cone', centerRa: 0, centerDec: 0, radius: deg(0.3) }, 2)

	expect(benchmark.iterations).toBe(2)
	expect(benchmark.resultCount).toBe(2)
	expect(benchmark.minMs).toBeGreaterThanOrEqual(0)
})

test('rejects invalid epoch propagation inputs', () => {
	expect(fixture.catalog.queryCone(0, 0, deg(1), { epochPropagation: { targetEpoch: Number.NaN } })).rejects.toThrow()
})

test('fails cleanly when no UCAC4 zone files exist', async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'nebulosa-ucac4-empty-'))

	try {
		expect(openUcac4Catalog({ root })).rejects.toThrow()
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test('detects malformed records with invalid coordinates', async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'nebulosa-ucac4-bad-'))

	try {
		await fs.mkdir(path.join(root, 'u4b'), { recursive: true })
		const bad = Buffer.alloc(RECORD_SIZE)
		bad.writeInt32LE(-1, 0)
		bad.writeInt32LE(324000000, 4)
		await fs.writeFile(path.join(root, 'u4b', 'z451'), bad)

		const catalog = await openUcac4Catalog({ root })

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
	await assertGenericCatalogContract(fixture.catalog)

	const mock = await new MockCatalog([
		{ id: 'm1', ra: deg(359.9), dec: 0, epoch: 2000, mag: 9.5, sourceCatalog: 'mock', pmRaMasYr: 20, pmDecMasYr: -10 },
		{ id: 'm2', ra: deg(0.1), dec: deg(0.05), epoch: 2000, mag: 12.1, sourceCatalog: 'mock' },
		{ id: 'm3', ra: deg(10), dec: deg(0.1), epoch: 2000, mag: 14.5, sourceCatalog: 'mock' },
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

	metadata(): StarCatalogMetadata {
		return MOCK_METADATA
	}

	open(_source: unknown): Promise<this> {
		return Promise.resolve(this)
	}

	close(): Promise<void> {
		return Promise.resolve()
	}

	capabilities(): StarCatalogCapabilities {
		return MOCK_CAPABILITIES
	}

	// biome-ignore lint/suspicious/useAwait: <explanation>
	protected async *streamCandidateEntries(_query: NormalizedStarCatalogQuery, _stats: CatalogQueryStatsAccumulator): AsyncIterable<StarCatalogEntry> {
		for (const entry of this.entries) {
			yield entry
		}
	}

	protected getEntryByIdInternal(catalogObjectId: string): Promise<StarCatalogEntry | undefined> {
		return Promise.resolve(this.entries.find((entry) => entry.id === catalogObjectId))
	}

	protected estimateCandidateCount(): Promise<number | undefined> {
		return Promise.resolve(this.entries.length)
	}
}

async function assertGenericCatalogContract(catalog: BaseStarCatalog) {
	const cone = await catalog.queryCone(0, 0, deg(0.3), { sortMode: 'distance' })
	expect(cone.items).toHaveLength(2)

	const box = await catalog.queryBox(deg(359.7), deg(0.3), deg(-0.2), deg(0.2))
	expect(box.items).toHaveLength(2)

	const propagated = await catalog.getById(cone.items[0]!.id, { epochPropagation: { targetEpoch: 2005 } })
	expect(propagated).toBeDefined()
}

function idsOf(items: readonly StarCatalogEntry[]) {
	return items.map((item) => item.id).sort()
}

async function createFixture(): Promise<FixtureState> {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'nebulosa-ucac4-'))
	const source: Ucac4CatalogSource = { root }
	const zoneDirectory = path.join(root, 'u4b')
	const indexDirectory = path.join(root, 'u4i')
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
		const zonePath = path.join(zoneDirectory, `z${`${zone}`.padStart(3, '0')}`)
		const output = Buffer.alloc(records.length * RECORD_SIZE)

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

	const index = Buffer.alloc(INDEX_BYTES)

	for (let i = 0; i < starts.length; i++) {
		index.writeInt32LE(starts[i]!, i * 4)
		index.writeInt32LE(counts[i]!, (starts.length + i) * 4)
	}

	await fs.writeFile(path.join(indexDirectory, 'u4index.unf'), index)

	const catalog = await openUcac4Catalog(source)

	return { root, catalog, totalBytes }
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
