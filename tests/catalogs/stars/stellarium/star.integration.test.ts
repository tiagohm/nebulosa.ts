import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { join } from 'path'
import { eraS2c } from '../../../../src/astronomy/coordinates/erfa/erfa'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogQuery } from '../../../../src/catalogs/stars/catalog'
import { stellariumLocalZoneCount, stellariumZoneForPoint, stellariumZoneTriangle } from '../../../../src/catalogs/stars/stellarium/geodesic'
import { decodeStellariumStar, parseStellariumStarHeader, parseStellariumStarZoneTable, readStellariumStarMagnitude, readStellariumStarPosition, type StellariumStarCatalogEntry, type StellariumStarFileHeader, type StellariumStarZoneIndex } from '../../../../src/catalogs/stars/stellarium/star.binary'
import { openStellariumStarCatalog, type StellariumStarCatalog } from '../../../../src/catalogs/stars/stellarium/star.catalog'
import { PI, PIOVERTWO, TAU } from '../../../../src/core/constants'
import type { MutVec2 } from '../../../../src/math/linear-algebra/vec2'
import { type Vec3, vecCross, vecDot, vecNormalize } from '../../../../src/math/linear-algebra/vec3'
import { mulberry32 } from '../../../../src/math/numerical/random'
import { arcsec, deg, toMas } from '../../../../src/math/units/angle'
import { toKilometerPerSecond } from '../../../../src/math/units/velocity'

// Opt-in checks against an installed Stellarium Gaia DR3/Hipparcos star catalog directory (stars/hip_gaia3 of
// Stellarium 25.x, manifest version 27). Set STELLARIUM_STARS_DIR to a directory holding some of the
// stars_<level>_*.cat files; levels 0 to 5 take about 330 MB and are read entirely by these tests.
const ROOT = process.env.STELLARIUM_STARS_DIR ?? ''
const SKIP = ROOT === ''

// Header and table facts of the stars-3.0 files listed by the version 27 manifest, observed in the files.
const KNOWN_FILES: Readonly<Record<string, { readonly level: number; readonly dataType: number; readonly recordCount: number; readonly magnitudeMin: number; readonly globalCount: number }>> = {
	'stars_0_0v0_21.cat': { level: 0, dataType: 0, recordCount: 5046, magnitudeMin: -2, globalCount: 1124 },
	'stars_1_0v0_16.cat': { level: 1, dataType: 0, recordCount: 21612, magnitudeMin: 6, globalCount: 1131 },
	'stars_2_0v0_17.cat': { level: 2, dataType: 0, recordCount: 141738, magnitudeMin: 7.5, globalCount: 12560 },
	'stars_3_0v0_10.cat': { level: 3, dataType: 0, recordCount: 418129, magnitudeMin: 9, globalCount: 0 },
	'stars_4_1v0_6.cat': { level: 4, dataType: 1, recordCount: 1741852, magnitudeMin: 10.5, globalCount: 0 },
	'stars_5_1v0_6.cat': { level: 5, dataType: 1, recordCount: 8051935, magnitudeMin: 12, globalCount: 0 },
}

// Largest angular tolerance between a membership oracle and the exact geometry of BaseStarCatalog, radians.
const ORACLE_TOLERANCE = 1e-9

interface LoadedFile {
	readonly buffer: Buffer
	readonly header: StellariumStarFileHeader
	readonly index: StellariumStarZoneIndex
}

// Angular distance between a unit vector and a position, radians, with the stable atan2 form.
function separation(a: Vec3, ra: number, dec: number) {
	const cosDec = Math.cos(dec)
	const x = cosDec * Math.cos(ra)
	const y = cosDec * Math.sin(ra)
	const z = Math.sin(dec)
	return Math.atan2(Math.hypot(a[1] * z - a[2] * y, a[2] * x - a[0] * z, a[0] * y - a[1] * x), a[0] * x + a[1] * y + a[2] * z)
}

function address(level: number, zone: number, record: number) {
	return `${level}:${zone}:${record}`
}

// Every record of the loaded files decoded and filtered only by BaseStarCatalog.
class FullScanCatalog extends BaseStarCatalog<StellariumStarCatalogEntry> {
	constructor(private readonly files: readonly LoadedFile[]) {
		super()
	}

	protected *streamCandidateEntries(_query: NormalizedStarCatalogQuery) {
		for (const { buffer, header, index } of this.files) {
			for (let zone = 0; zone < header.zoneCount; zone++) {
				for (let record = index.starts[zone]; record < index.starts[zone + 1]; record++) {
					yield decodeStellariumStar(buffer, header.dataOffset + record * header.recordSize, header, zone, record - index.starts[zone])
				}
			}
		}
	}
}

describe.skipIf(SKIP)('installed Stellarium star catalog', () => {
	let catalog: StellariumStarCatalog
	const files: LoadedFile[] = []

	beforeAll(async () => {
		catalog = await openStellariumStarCatalog(ROOT)

		for (const info of catalog.levels) {
			const buffer = await fs.readFile(join(ROOT, info.fileName))
			const header = parseStellariumStarHeader(buffer)
			files.push({ buffer, header, index: parseStellariumStarZoneTable(buffer.subarray(28), header.zoneCount) })
		}
	}, 120000)

	afterAll(async () => {
		await catalog?.close()
	})

	test('headers and record counts', () => {
		expect(catalog.levels.length).toBeGreaterThan(0)

		for (const info of catalog.levels) {
			expect(info.epoch).toBeCloseTo(2016, 12)
			expect(info.majorVersion).toBe(0)
			const known = KNOWN_FILES[info.fileName]
			if (known === undefined) continue
			expect([info.level, info.dataType, info.recordCount, info.magnitudeMin]).toEqual([known.level, known.dataType, known.recordCount, known.magnitudeMin])
			const file = files.find((file) => file.header.level === info.level)!
			const global = stellariumLocalZoneCount(info.level)
			expect(file.index.starts[global + 1] - file.index.starts[global]).toBe(known.globalCount)
		}
	})

	test('zones are sorted by magnitude and their stars lie in their triangles', () => {
		const position: MutVec2 = [0, 0]

		for (const { buffer, header, index } of files) {
			const global = stellariumLocalZoneCount(header.level)
			let maxOutside = 0
			let zoneMismatches = 0
			let unsorted = 0
			let belowHeader = 0

			for (let zone = 0; zone <= global; zone++) {
				const triangle = zone < global ? stellariumZoneTriangle(header.level, zone) : undefined
				const normals = triangle?.map((corner, i) => vecNormalize(vecCross(corner, triangle[(i + 1) % 3])))
				let previous = -Infinity

				for (let record = index.starts[zone]; record < index.starts[zone + 1]; record++) {
					const offset = header.dataOffset + record * header.recordSize
					const magnitude = readStellariumStarMagnitude(buffer, offset, header.dataType)
					if (magnitude < previous) unsorted++
					if (magnitude < header.magnitudeMin) belowHeader++
					previous = magnitude

					if (normals === undefined) continue

					readStellariumStarPosition(buffer, offset, header.dataType, position)
					const v = eraS2c(position[0], position[1])
					const outside = Math.max(-vecDot(normals[0], v), -vecDot(normals[1], v), -vecDot(normals[2], v))
					if (outside > maxOutside) maxOutside = outside
					if (header.dataType === 0 && header.level <= 3 && stellariumZoneForPoint(v, header.level) !== zone) zoneMismatches++
				}
			}

			expect(unsorted).toBe(0)
			expect(belowHeader).toBe(0)
			// Far below the 10″ cover margin: the zone order and geometry are those of the files.
			expect(maxOutside).toBeLessThan(arcsec(0.05))
			expect(zoneMismatches).toBe(0)
		}
	}, 120000)

	test('known bright stars', async () => {
		const sirius = (await catalog.queryRegion({ kind: 'cone', centerRA: deg(101.287), centerDEC: deg(-16.716), radius: deg(0.05), magnitudeMax: 0 }))[0]
		expect(sirius.hipId).toBe(32349)
		expect(sirius.componentId).toBe(1)
		expect(sirius.magnitude).toBe(-1.46)
		expect(toMas(sirius.pmRA!) * Math.cos(sirius.declination)).toBeCloseTo(-546.06, 1)
		expect(toMas(sirius.pmDEC!)).toBeCloseTo(-1223.15, 1)
		expect(toMas(sirius.parallax!)).toBeCloseTo(379.2, 6)
		expect(toKilometerPerSecond(sirius.rv!)).toBeCloseTo(-5.5, 6)

		const polaris = await catalog.queryRegion({ kind: 'cone', centerRA: deg(37.95), centerDEC: deg(89.26), radius: deg(0.1), magnitudeMax: 3 })
		expect(polaris.map((star) => star.hipId)).toEqual([11767])

		// Hipparcos stars without a Gaia counterpart keep their Hipparcos number.
		const level0 = files.find((file) => file.header.level === 0)

		if (level0 !== undefined) {
			const all = await new FullScanCatalog([level0]).queryCone(0, 0, PI)
			const hipOnly = all.filter((star) => star.gaiaId === 0n)
			expect(hipOnly.length).toBeGreaterThan(0)
			for (const star of hipOnly) expect(star.hipId).toBeGreaterThan(0)
		}
	})

	test('pruned cones and boxes find exactly the stars of a full scan', async () => {
		const random = mulberry32(2016)
		const position: MutVec2 = [0, 0]
		const queries: StarCatalogQuery[] = [
			{ kind: 'cone', centerRA: 0, centerDEC: PIOVERTWO, radius: deg(1.5) },
			{ kind: 'cone', centerRA: deg(77), centerDEC: -PIOVERTWO, radius: deg(2) },
			{ kind: 'cone', centerRA: deg(359.95), centerDEC: deg(0.3), radius: deg(1) },
			{ kind: 'cone', centerRA: deg(266.4), centerDEC: deg(-29), radius: deg(0.5) },
			{ kind: 'cone', centerRA: deg(83.8), centerDEC: deg(-5.4), radius: arcsec(30) },
			{ kind: 'cone', centerRA: deg(10), centerDEC: deg(41), radius: deg(8), magnitudeMax: 9 },
			{ kind: 'box', minRA: deg(359), maxRA: deg(1.5), minDEC: deg(-1), maxDEC: deg(1) },
			{ kind: 'box', minRA: 0, maxRA: TAU, minDEC: deg(-90), maxDEC: deg(-88.5) },
			{ kind: 'box', minRA: deg(120), maxRA: deg(121), minDEC: deg(60), maxDEC: deg(62), magnitudeMin: 11, magnitudeMax: 12.5 },
		]

		for (let i = 0; i < 9; i++) {
			const centerRA = random() * TAU
			const centerDEC = Math.asin(2 * random() - 1)
			queries.push({ kind: 'cone', centerRA, centerDEC, radius: deg(0.05 + 2 * random()), magnitudeMax: i % 3 === 0 ? 11 : undefined })
		}

		for (const query of queries) {
			const inner = new Set<string>()
			const outer = new Set<string>()
			const { magnitudeMin, magnitudeMax } = query
			const center = query.kind === 'cone' ? eraS2c(query.centerRA, query.centerDEC) : eraS2c(0, 0)

			for (const { buffer, header, index } of files) {
				for (let zone = 0; zone < header.zoneCount; zone++) {
					for (let record = index.starts[zone]; record < index.starts[zone + 1]; record++) {
						const offset = header.dataOffset + record * header.recordSize
						const magnitude = readStellariumStarMagnitude(buffer, offset, header.dataType)
						if ((magnitudeMin !== undefined && magnitude < magnitudeMin) || (magnitudeMax !== undefined && magnitude > magnitudeMax)) continue

						readStellariumStarPosition(buffer, offset, header.dataType, position)
						const [ra, dec] = position
						let margin: number

						if (query.kind === 'cone') {
							margin = query.radius - separation(center, ra, dec)
						} else if (query.kind === 'box') {
							const decMargin = Math.min(dec - query.minDEC, query.maxDEC - dec)
							const raMargin = query.maxRA - query.minRA >= TAU ? Infinity : query.minRA <= query.maxRA ? Math.min(ra - query.minRA, query.maxRA - ra) : Math.max(ra - query.minRA, query.maxRA - ra)
							margin = Math.min(decMargin, raMargin)
						} else {
							continue
						}

						const key = address(header.level, zone, record - index.starts[zone])
						if (margin >= ORACLE_TOLERANCE) inner.add(key)
						if (margin >= -ORACLE_TOLERANCE) outer.add(key)
					}
				}
			}

			const result = await catalog.queryRegion(query)
			const keys = new Set(result.map((star) => address(star.level, star.zone, star.recordNumber)))
			expect(keys.size).toBe(result.length)
			for (const key of inner) expect(keys.has(key)).toBeTrue()
			for (const key of keys) expect(outer.has(key)).toBeTrue()
		}
	}, 300000)

	test('pruned triangles and polygons match the reference filter', async () => {
		const shallow = files.filter((file) => file.header.level <= 2)
		const reference = new FullScanCatalog(shallow)
		const queries: StarCatalogQuery[] = [
			{ kind: 'triangle', a: [deg(80), deg(-10)], b: [deg(90), deg(-10)], c: [deg(85), deg(0)] },
			{ kind: 'triangle', a: [deg(0), deg(85)], b: [deg(120), deg(85)], c: [deg(240), deg(85)] },
			{
				kind: 'polygon',
				vertices: [
					[deg(355), deg(-20)],
					[deg(5), deg(-20)],
					[deg(5), deg(-10)],
					[deg(355), deg(-10)],
				],
			},
			{
				kind: 'polygon',
				vertices: [
					[deg(10), deg(-80)],
					[deg(100), deg(-80)],
					[deg(190), deg(-80)],
					[deg(280), deg(-80)],
				],
			},
		]

		for (const query of queries) {
			const expected = (await reference.queryRegion(query)).map((star) => address(star.level, star.zone, star.recordNumber)).sort()
			const actual = (await catalog.queryRegion(query))
				.filter((star) => star.level <= 2)
				.map((star) => address(star.level, star.zone, star.recordNumber))
				.sort()
			expect(expected.length).toBeGreaterThan(0)
			expect(actual).toEqual(expected)
		}
	}, 120000)

	test('a small cone reads a tiny part of the files', async () => {
		catalog.resetDiagnostics()
		const stars = await catalog.queryCone(deg(266.4), deg(-29), deg(0.25))
		const total = catalog.levels.reduce((sum, info) => sum + info.fileSize, 0)
		expect(stars.length).toBeGreaterThan(0)
		expect(catalog.diagnostics.bytesRead).toBeLessThan(total / 100)
		expect(catalog.diagnostics.recordsDecoded).toBeLessThan(10 * stars.length + 20000)
	})

	test('manifest checksums', async () => {
		const results = await catalog.verifyChecksums()
		for (const result of results) if (result.expected !== undefined) expect(result.matches).toBeTrue()
	}, 120000)
})
