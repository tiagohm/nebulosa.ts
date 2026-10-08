import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StellariumStarCatalogEntry } from 'nebulosa/src/catalogs/stars/stellarium.star.binary'
import { PI, PIOVERTWO, TAU } from 'nebulosa/src/core/constants'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogQuery } from '../../../src/catalogs/stars/catalog'
import { stellariumLocalZoneCount, stellariumZoneForPoint } from '../../../src/catalogs/stars/stellarium.geodesic'
import { openStellariumStarCatalog, StellariumStarCatalog } from '../../../src/catalogs/stars/stellarium.star.catalog'
import { type Angle, deg, toMas } from '../../../src/math/units/angle'
import { buildStarFile, encodeStar1, encodeStar2, encodeStar3 } from '../../util/stellarium.star'

function zoneOf(ra: Angle, dec: Angle, level: number) {
	return stellariumZoneForPoint([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)], level)
}

function address(entry: StellariumStarCatalogEntry) {
	return `${entry.level}:${entry.zone}:${entry.recordNumber}`
}

function addresses(entries: readonly StellariumStarCatalogEntry[]) {
	return entries.map(address).sort()
}

// Reference catalog over every entry of a file set, filtered only by BaseStarCatalog.
class ListCatalog extends BaseStarCatalog<StellariumStarCatalogEntry> {
	constructor(private readonly entries: readonly StellariumStarCatalogEntry[]) {
		super()
	}

	protected streamCandidateEntries(_query: NormalizedStarCatalogQuery) {
		return this.entries
	}
}

async function allEntries(catalog: StellariumStarCatalog) {
	const entries: StellariumStarCatalogEntry[] = []

	for (const info of catalog.levels) {
		for (let zone = 0; zone < info.zoneCount; zone++) {
			for (let record = 0; ; record++) {
				const entry = await catalog.get(info.level, zone, record)
				if (entry === undefined) break
				entries.push(entry)
			}
		}
	}

	return entries
}

const ORION_RA = deg(83.8)
const ORION_DEC = deg(-5.4)

let base = ''
let rootA = ''
let rootB = ''
let rootH = ''
let level0 = Buffer.alloc(0)
let level1 = Buffer.alloc(0)
let level2 = Buffer.alloc(0)

beforeAll(async () => {
	base = await fs.mkdtemp(join(tmpdir(), 'nebulosa-stellarium-stars-'))

	// Level 0, Star1: three stars near Orion in one zone, one far away, two in the global zone.
	const orion0 = zoneOf(ORION_RA, ORION_DEC, 0)
	const far0 = zoneOf(deg(200), deg(40), 0)
	expect(far0).not.toBe(orion0)
	level0 = buildStarFile(
		{ dataType: 0, level: 0, minor: 21, magMinMillimag: -2000 },
		new Map([
			[
				orion0,
				[
					encodeStar1({ gaiaId: 3017190546641718144n, ra: deg(83.858), dec: deg(-5.91), vmagMillimag: 2770, hip: 26241, component: 1, plx: 200, rv: 215 }),
					encodeStar1({ gaiaId: 2n, ra: ORION_RA, dec: ORION_DEC, vmagMillimag: 4000 }),
					encodeStar1({ gaiaId: 3n, ra: deg(84.5), dec: deg(-5.4), vmagMillimag: 5000 }),
				],
			],
			[far0, [encodeStar1({ gaiaId: 4n, ra: deg(200), dec: deg(40), vmagMillimag: 3000 })]],
			[stellariumLocalZoneCount(0), [encodeStar1({ gaiaId: 5n, ra: deg(83.9), dec: deg(-5.3), vmagMillimag: 1000, hip: 99 }), encodeStar1({ gaiaId: 6n, ra: deg(10), dec: deg(80), vmagMillimag: 3500 })]],
		]),
	)

	// Level 1, Star2: stars around Orion sorted by magnitude and one star at the south pole.
	const orion1 = zoneOf(ORION_RA, ORION_DEC, 1)
	level1 = buildStarFile(
		{ dataType: 1, level: 1, minor: 16, magMinMillimag: 6000 },
		new Map([
			[orion1, [encodeStar2({ gaiaId: 11n, ra: deg(83.7), dec: deg(-5.5), vmagMillimag: 6500, pmRaUas: 1000, pmDecUas: -2000, plx: 300 }), encodeStar2({ gaiaId: 12n, ra: deg(83.81), dec: deg(-5.39), vmagMillimag: 7000 }), encodeStar2({ gaiaId: 13n, ra: deg(83.9), dec: deg(-5.2), vmagMillimag: 7400 })]],
			[zoneOf(0, deg(-90), 1), [encodeStar2({ gaiaId: 14n, raMas: 0, decMas: -324000000, vmagMillimag: 6100 })]],
		]),
	)

	// Level 2, Star3: one star near Orion and one on RA 359.99°.
	level2 = buildStarFile(
		{ dataType: 2, level: 2, minor: 17, magMinMillimag: 7500 },
		new Map([
			[zoneOf(ORION_RA, ORION_DEC, 2), [encodeStar3({ gaiaId: 21n, ra: deg(83.75), dec: deg(-5.45), vmag: 10 })]],
			[zoneOf(deg(359.99), deg(0.01), 2), [encodeStar3({ gaiaId: 22n, ra: deg(359.99), dec: deg(0.01), vmag: 20 })]],
		]),
	)

	rootA = join(base, 'a')
	await fs.mkdir(rootA)
	await fs.writeFile(join(rootA, 'stars_0_0v0_21.cat'), level0)
	await fs.writeFile(join(rootA, 'stars_1_1v0_16.cat'), level1)
	await fs.writeFile(join(rootA, 'stars_2_2v0_17.cat'), level2)
	// Not a star file of a level: ignored.
	await fs.writeFile(join(rootA, 'stars_hip_sp_0v0_6.cat'), 'text')

	const manifest = {
		catalogs: [
			{ checked: true, checksum: createHash('md5').update(level0).digest('hex').toUpperCase(), count: 0, fileName: 'stars_0_0v0_21.cat', id: 'stars0', magRange: [-2, 6], sizeMb: 0 },
			{ checked: true, checksum: '00000000000000000000000000000000', fileName: 'stars_1_1v0_16.cat', id: 'stars1', magRange: [6, 7.5] },
			{ checked: false, fileName: 'stars_2_2v0_17.cat', id: 'stars2' },
			{ checked: false, checksum: 'c971d04d40606ed889faa8258e8ec640', fileName: 'stars_3_0v0_10.cat', id: 'stars3', magRange: [9, 10.5] },
		],
		hipSpectralFile: 'stars_hip_sp_0v0_6.cat',
		version: 27,
	}
	await fs.writeFile(join(rootA, 'starsConfig.json'), JSON.stringify(manifest))

	rootB = join(base, 'b')
	await fs.mkdir(rootB)
	await fs.writeFile(join(rootB, 'stars_0_any.cat'), level0)
	await fs.writeFile(join(rootB, 'stars_2_any.cat'), level2)

	// Level 5, Star2: one zone with 1000 stars from V = 12.00 to 21.99 and a distant zone with one star.
	rootH = join(base, 'h')
	await fs.mkdir(rootH)
	const dense = zoneOf(deg(150), deg(20), 5)
	const records = Array.from({ length: 1000 }, (_, i) => encodeStar2({ gaiaId: BigInt(1000 + i), ra: deg(150 + (i % 10) * 0.001), dec: deg(20 + Math.floor(i / 10) * 0.0001), vmagMillimag: 12000 + i * 10 }))
	await fs.writeFile(
		join(rootH, 'stars_5_1v0_6.cat'),
		buildStarFile(
			{ dataType: 1, level: 5, magMinMillimag: 12000 },
			new Map([
				[dense, records],
				[zoneOf(deg(150), deg(-20), 5), [encodeStar2({ gaiaId: 9n, ra: deg(150), dec: deg(-20), vmagMillimag: 12500 })]],
			]),
		),
	)
})

afterAll(async () => {
	await fs.rm(base, { recursive: true, force: true })
})

describe('open', () => {
	test('manifest discovery, level metadata and missing levels', async () => {
		await using catalog = await openStellariumStarCatalog(rootA)

		expect(catalog.isOpen).toBeTrue()
		expect(catalog.root).toBe(rootA)
		expect(catalog.missingLevels).toEqual([3])
		expect(catalog.levels.map((level) => [level.level, level.dataType, level.recordSize, level.recordCount, level.zoneCount, level.fileName])).toEqual([
			[0, 0, 48, 6, 21, 'stars_0_0v0_21.cat'],
			[1, 1, 32, 4, 81, 'stars_1_1v0_16.cat'],
			[2, 2, 16, 2, 321, 'stars_2_2v0_17.cat'],
		])

		const info = catalog.levels[0]
		expect(info.epoch).toBe(2016)
		expect(info.epochJD).toBe(2457389)
		expect(info.magnitudeMin).toBe(-2)
		expect(info.minorVersion).toBe(21)
		expect(info.fileSize).toBe(level0.byteLength)
		expect(info.magnitudeRange).toEqual([-2, 6])
		expect(info.checksum).toBe(createHash('md5').update(level0).digest('hex'))
		expect(catalog.levels[2].magnitudeRange).toBeUndefined()
		expect(JSON.parse(JSON.stringify(catalog.levels))).toHaveLength(3)
	})

	test('file name discovery without manifest', async () => {
		await using catalog = await openStellariumStarCatalog(rootB)
		expect(catalog.levels.map((level) => level.level)).toEqual([0, 2])
		expect(catalog.missingLevels).toEqual([])
	})

	test('required levels', async () => {
		expect(openStellariumStarCatalog(rootA, { requiredLevels: [0, 3, 4] })).rejects.toThrow('missing required Stellarium star catalog levels: 3, 4')
		await using catalog = await openStellariumStarCatalog(rootA, { requiredLevels: [0, 1, 2] })
		expect(catalog.isOpen).toBeTrue()
	})

	test('invalid directories and files', async () => {
		const make = async (name: string, files: Record<string, Buffer | string>) => {
			const root = join(base, name)
			await fs.mkdir(root)
			for (const [file, content] of Object.entries(files)) await fs.writeFile(join(root, file), content)
			return root
		}

		expect(openStellariumStarCatalog(join(base, 'missing'))).rejects.toThrow('not readable')
		expect(openStellariumStarCatalog(await make('empty', {}))).rejects.toThrow('no Stellarium star catalog file')
		expect(openStellariumStarCatalog(await make('ambiguous', { 'stars_0_a.cat': level0, 'stars_0_b.cat': level0 }))).rejects.toThrow('ambiguous Stellarium star catalog level 0: stars_0_a.cat, stars_0_b.cat')
		expect(openStellariumStarCatalog(await make('mismatch', { 'stars_1_x.cat': level0 }))).rejects.toThrow('stars_1_x.cat (level 1): header level 0 does not match')
		expect(openStellariumStarCatalog(await make('truncated', { 'stars_1_x.cat': level1.subarray(0, level1.byteLength - 1) }))).rejects.toThrow('stars_1_x.cat (level 1): file size')
		expect(openStellariumStarCatalog(await make('trailing', { 'stars_1_x.cat': Buffer.concat([level1, Buffer.alloc(1)]) }))).rejects.toThrow('file size')
		expect(openStellariumStarCatalog(await make('table', { 'stars_2_x.cat': level2.subarray(0, 100) }))).rejects.toThrow('zone table is truncated')
		expect(openStellariumStarCatalog(await make('header', { 'stars_2_x.cat': level2.subarray(0, 20) }))).rejects.toThrow('smaller than the header')
		expect(openStellariumStarCatalog(await make('valid-and-invalid', { 'stars_0_x.cat': level0, 'stars_1_x.cat': level1.subarray(0, 50) }))).rejects.toThrow('stars_1_x.cat')
		expect(openStellariumStarCatalog(await make('escape', { 'starsConfig.json': JSON.stringify({ catalogs: [{ fileName: '../stars_0_0v0_21.cat', id: 'stars0' }] }) }))).rejects.toThrow('not a plain file name')
		expect(openStellariumStarCatalog(await make('json', { 'defaultStarsConfig.json': '{' }))).rejects.toThrow('malformed JSON')
		expect(openStellariumStarCatalog(await make('duplicate', { 'starsConfig.json': JSON.stringify({ catalogs: [{ fileName: 'stars_0_a.cat' }, { fileName: 'b.cat', id: 'stars0' }] }) }))).rejects.toThrow('level 0 is listed more than once')
		expect(openStellariumStarCatalog(await make('nolevel', { 'starsConfig.json': JSON.stringify({ catalogs: [{ fileName: 'b.cat' }] }) }))).rejects.toThrow('no level for b.cat')
	})

	test('state errors and options', async () => {
		expect(() => new StellariumStarCatalog({ blockBytes: 47 })).toThrow('block size')
		expect(() => new StellariumStarCatalog({ blockBytes: 1000.5 })).toThrow('block size')

		const catalog = new StellariumStarCatalog()
		expect(catalog.isOpen).toBeFalse()
		expect(catalog.levels).toEqual([])
		expect(catalog.queryCone(0, 0, 1)).rejects.toThrow('not open')
		expect(catalog.get(0, 0, 0)).rejects.toThrow('not open')

		const opening = catalog.open(rootA)
		expect(catalog.open(rootA)).rejects.toThrow('already open')
		await opening
		expect(catalog.open(rootA)).rejects.toThrow('already open')
		await catalog.close()
		await catalog.close()
		expect(catalog.isOpen).toBeFalse()

		// A failed open leaves the catalog closed and reusable.
		expect(catalog.open(join(base, 'missing'))).rejects.toThrow()
		await catalog.open(rootB)
		expect(catalog.levels).toHaveLength(2)
		await catalog.close()
	})
})

describe('query', () => {
	let catalog: StellariumStarCatalog
	let reference: ListCatalog

	beforeAll(async () => {
		catalog = await openStellariumStarCatalog(rootA, { blockBytes: 64 })
		reference = new ListCatalog(await allEntries(catalog))
	})

	afterAll(async () => {
		await catalog.close()
	})

	test('get decodes records by physical address', async () => {
		const entries = await allEntries(catalog)
		expect(entries).toHaveLength(12)

		const star = (await catalog.get(0, zoneOf(ORION_RA, ORION_DEC, 0), 0))!
		expect(star.gaiaId).toBe(3017190546641718144n)
		expect(star.hipId).toBe(26241)
		expect(star.magnitude).toBe(2.77)
		expect(star.epoch).toBe(2016)

		const global = (await catalog.get(0, 20, 1))!
		expect(global.gaiaId).toBe(6n)
		expect(global.zone).toBe(20)
		expect(global.recordNumber).toBe(1)

		expect(await catalog.get(0, 21, 0)).toBeUndefined()
		expect(await catalog.get(0, -1, 0)).toBeUndefined()
		expect(await catalog.get(0, 20, 2)).toBeUndefined()
		expect(await catalog.get(0, 20, 0.5)).toBeUndefined()
		expect(await catalog.get(0, 1.5, 0)).toBeUndefined()
		expect(await catalog.get(3, 0, 0)).toBeUndefined()
	})

	test('the four region kinds match the reference filter', async () => {
		const queries: StarCatalogQuery[] = [
			{ kind: 'cone', centerRA: ORION_RA, centerDEC: ORION_DEC, radius: deg(1) },
			{ kind: 'cone', centerRA: ORION_RA, centerDEC: ORION_DEC, radius: deg(0.05) },
			{ kind: 'cone', centerRA: 0, centerDEC: -PIOVERTWO, radius: deg(1) },
			{ kind: 'cone', centerRA: 0, centerDEC: 0, radius: PI },
			{ kind: 'box', minRA: deg(83), maxRA: deg(84), minDEC: deg(-6), maxDEC: deg(-5) },
			{ kind: 'box', minRA: deg(359), maxRA: deg(1), minDEC: deg(-1), maxDEC: deg(1) },
			{ kind: 'box', minRA: 0, maxRA: TAU, minDEC: deg(-90), maxDEC: deg(-89) },
			{ kind: 'triangle', a: [deg(83), deg(-6)], b: [deg(85), deg(-6)], c: [deg(84), deg(-4)] },
			{
				kind: 'polygon',
				vertices: [
					[deg(83), deg(-6.5)],
					[deg(85), deg(-6.5)],
					[deg(85), deg(-4.5)],
					[deg(83), deg(-4.5)],
				],
			},
			{
				kind: 'polygon',
				vertices: [
					[deg(0), deg(-85)],
					[deg(120), deg(-85)],
					[deg(240), deg(-85)],
				],
			},
		]

		for (const query of queries) {
			const expected = addresses(await reference.queryRegion(query))
			expect(addresses(await catalog.queryRegion(query))).toEqual(expected)
		}

		const orion = await catalog.queryRegion(queries[0])
		expect(orion.map((entry) => entry.gaiaId).sort((a, b) => (a < b ? -1 : 1))).toEqual([2n, 3n, 5n, 11n, 12n, 13n, 21n, 3017190546641718144n])
		expect((await catalog.queryRegion(queries[5])).map((entry) => entry.gaiaId)).toEqual([22n])
		expect((await catalog.queryRegion(queries[2])).map((entry) => entry.gaiaId)).toEqual([14n])
		expect(await catalog.queryRegion(queries[3])).toHaveLength(12)
	})

	test('the global zone is scanned even when no local zone matches', async () => {
		const entries = await catalog.queryCone(deg(10), deg(80), deg(0.01))
		expect(entries.map((entry) => [entry.gaiaId, entry.zone])).toEqual([[6n, 20]])
	})

	test('inclusive magnitude bounds skip whole levels', async () => {
		const query = { kind: 'cone', centerRA: ORION_RA, centerDEC: ORION_DEC, radius: deg(2) } as const

		for (const [magnitudeMin, magnitudeMax] of [
			[undefined, 2.77],
			[2.77, 5],
			[4, 6.5],
			[6.5, 7.4],
			[7.5, 15],
			[16.2, 16.2],
			[undefined, -5],
		] as const) {
			const bounded = { ...query, magnitudeMin, magnitudeMax }
			expect(addresses(await catalog.queryRegion(bounded))).toEqual(addresses(await reference.queryRegion(bounded)))
		}

		expect((await catalog.queryRegion({ ...query, magnitudeMax: 2.77 })).map((entry) => entry.magnitude)).toEqual([2.77, 1])

		catalog.resetDiagnostics()
		await catalog.queryRegion({ ...query, magnitudeMax: 5.9 })
		// Levels 1 and 2 have header lower bounds 6 and 7.5: never read.
		expect(catalog.diagnostics.recordsScanned).toBe(5)
	})

	test('limit and streaming', async () => {
		const query = { kind: 'cone', centerRA: ORION_RA, centerDEC: ORION_DEC, radius: deg(2) } as const
		const all = await catalog.queryRegion(query)

		expect(await catalog.queryRegion({ ...query, limit: 0 })).toEqual([])
		expect(await catalog.queryRegion({ ...query, limit: 1 })).toEqual(all.slice(0, 1))
		expect(await catalog.queryRegion({ ...query, limit: 1000 })).toEqual(all)
		expect(await Array.fromAsync(catalog.streamRegion(query))).toEqual(all)
	})

	test('concurrent queries do not share buffers or cursors', async () => {
		const a = { kind: 'cone', centerRA: ORION_RA, centerDEC: ORION_DEC, radius: deg(2) } as const
		const b = { kind: 'cone', centerRA: 0, centerDEC: 0, radius: PI } as const
		const [ra, rb, rc] = await Promise.all([catalog.queryRegion(a), catalog.queryRegion(b), catalog.queryRegion(a)])
		expect(ra).toEqual(await catalog.queryRegion(a))
		expect(rb).toEqual(await catalog.queryRegion(b))
		expect(rc).toEqual(ra)
	})

	test('stopping a stream stops the reads', async () => {
		catalog.resetDiagnostics()

		for await (const entry of catalog.streamRegion({ kind: 'cone', centerRA: 0, centerDEC: 0, radius: PI })) {
			expect(entry.level).toBe(0)
			break
		}

		// One 64-byte block holds one Star1 record.
		expect(catalog.diagnostics.readCalls).toBe(1)
		expect(catalog.diagnostics.recordsDecoded).toBe(1)
	})

	test('checksum verification', async () => {
		const results = await catalog.verifyChecksums()
		expect(results.map((result) => [result.level, result.matches])).toEqual([
			[0, true],
			[1, false],
			[2, undefined],
		])
		expect(results[2].actual).toBe(createHash('md5').update(level2).digest('hex'))
	})
})

describe('scan', () => {
	test('reads only the selected zones and stops at the magnitude limit', async () => {
		await using catalog = await openStellariumStarCatalog(rootH, { blockBytes: 32 * 64 })
		const fileSize = catalog.levels[0].fileSize
		const dataOffset = 28 + 4 * catalog.levels[0].zoneCount

		const bright = await catalog.queryRegion({ kind: 'cone', centerRA: deg(150), centerDEC: deg(20), radius: deg(1), magnitudeMax: 12.05 })
		expect(bright.map((entry) => entry.magnitude)).toEqual([12, 12.01, 12.02, 12.03, 12.04, 12.05])
		// The dense zone stops at the first fainter record; one block of 64 records is read.
		expect(catalog.diagnostics.recordsScanned).toBe(7)
		expect(catalog.diagnostics.bytesRead).toBe(64 * 32)

		catalog.resetDiagnostics()
		const all = await catalog.queryRegion({ kind: 'cone', centerRA: deg(150), centerDEC: deg(20), radius: deg(0.2) })
		expect(all).toHaveLength(1000)
		expect(all.map((entry) => entry.recordNumber)).toEqual(Array.from({ length: 1000 }, (_, i) => i))
		expect(catalog.diagnostics.zonesScanned).toBe(1)
		expect(catalog.diagnostics.bytesRead).toBe(1000 * 32)
		expect(catalog.diagnostics.bytesRead).toBeLessThan(fileSize - dataOffset)
		expect(catalog.diagnostics.coverNodesVisited).toBeLessThan(200)

		catalog.resetDiagnostics()
		expect(await catalog.queryCone(deg(150), deg(-30), deg(0.01))).toHaveLength(0)
		expect(catalog.diagnostics.bytesRead).toBe(0)

		// Records sorted by position inside the zone are selected by the exact geometry.
		const box = await catalog.queryBox(deg(150.0045), deg(150.0095), deg(19.9999), deg(20.00005))
		expect(box.map((entry) => entry.recordNumber)).toEqual([5, 6, 7, 8, 9])
		expect(toMas(box[0].rightAscension - deg(150))).toBeCloseTo(18000, 0)
	})
})

describe('lifecycle', () => {
	test('close during a stream fails the next read and reopen uses the new files', async () => {
		const catalog = await openStellariumStarCatalog(rootA, { blockBytes: 48 })
		const iterator = catalog.streamRegion({ kind: 'cone', centerRA: 0, centerDEC: 0, radius: PI })[Symbol.asyncIterator]()

		const first = await iterator.next()
		expect(first.done).toBeFalse()

		// The handler is attached before close so the rejection is never unobserved.
		const pending = iterator.next().then(
			() => undefined,
			(error: unknown) => error,
		)
		await catalog.close()
		expect(await pending).toEqual(new Error('Stellarium star catalog is closed'))

		await catalog.open(rootB)
		expect(catalog.levels.map((level) => level.level)).toEqual([0, 2])
		expect(await catalog.get(1, 0, 0)).toBeUndefined()
		expect((await catalog.get(2, zoneOf(ORION_RA, ORION_DEC, 2), 0))?.gaiaId).toBe(21n)
		await catalog.close()
	})

	test('a file truncated after open fails with its name', async () => {
		const root = join(base, 'shrinking')
		await fs.mkdir(root)
		await fs.writeFile(join(root, 'stars_1_x.cat'), level1)

		await using catalog = await openStellariumStarCatalog(root)
		await fs.truncate(join(root, 'stars_1_x.cat'), level1.byteLength - 40)

		expect(catalog.queryCone(0, 0, PI)).rejects.toThrow('stars_1_x.cat (level 1)')
		expect(catalog.verifyChecksums()).rejects.toThrow('unexpected end of file')
	})
})
