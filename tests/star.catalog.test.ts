import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { deg, normalizeAngle } from '../src/angle'
import { PI, PIOVERTWO, TAU } from '../src/constants'
import { buildStarCatalogIndex, buildStarCatalogIndexFile, loadStarCatalogIndex, type StarCatalogInputRecord, type StarCatalogPayloadCodec } from '../src/star.catalog'

type SyntheticStar = StarCatalogInputRecord<number>

const NUMBER_PAYLOAD_CODEC: StarCatalogPayloadCodec<number> = {
	encode(payload: number) {
		const buffer = Buffer.allocUnsafe(8)
		buffer.writeDoubleLE(payload, 0)
		return buffer
	},
	decode(payload: Buffer) {
		return payload.readDoubleLE(0)
	},
}

const SYNTHETIC_CATALOG: readonly SyntheticStar[] = [
	{ id: 'wrap-west', rightAscension: deg(359.4), declination: deg(0.1), payload: 1.1 },
	{ id: 'wrap-east', rightAscension: deg(0.4), declination: deg(-0.15), payload: 2.2 },
	{ id: 'mid-a', rightAscension: deg(45), declination: deg(10), payload: 3.3 },
	{ id: 'mid-b', rightAscension: deg(47), declination: deg(10.5), payload: 4.4 },
	{ id: 'north', rightAscension: deg(120), declination: deg(89.95), payload: 5.5 },
	{ id: 'south', rightAscension: deg(250), declination: deg(-89.95), payload: 6.6 },
] as const

describe('star catalog spatial index', () => {
	test('builds deterministically and matches brute-force cone search across RA wrap', async () => {
		const config = { strategy: { type: 'declination-bins', declinationBinCount: 12 } } as const
		const first = await buildStarCatalogIndex(SYNTHETIC_CATALOG, config)
		const second = await buildStarCatalogIndex(SYNTHETIC_CATALOG, config)
		const queryRightAscension = deg(359.8)
		const queryDeclination = deg(0)
		const radius = deg(1.1)
		const expected = SYNTHETIC_CATALOG.filter((record) => coneContains(queryRightAscension, queryDeclination, record.rightAscension, record.declination, radius))
			.map((record) => record.id)
			.sort()
		const actual = [...first.index.queryCone(queryRightAscension, queryDeclination, radius).map((record) => record.id)].sort()

		expect(first.buffer).toEqual(second.buffer)
		expect(first.metadata.fingerprint).toBe(second.metadata.fingerprint)
		expect(actual).toEqual(expected)
	})

	test('persists and reloads a grid index with payload preservation', async () => {
		const path = `data/star-catalog-${Date.now()}.bin`

		try {
			const built = await buildStarCatalogIndexFile(SYNTHETIC_CATALOG, path, { strategy: { type: 'equirectangular-grid', declinationBinCount: 8, rightAscensionBinCount: 16 }, includePayload: true, payloadCodec: NUMBER_PAYLOAD_CODEC })
			const loaded = await loadStarCatalogIndex(path, { payloadCodec: NUMBER_PAYLOAD_CODEC })
			const all = loaded.queryRectangle(0, TAU, -PIOVERTWO, PIOVERTWO)

			expect(loaded.metadata).toEqual(built.metadata)
			expect(all).toHaveLength(SYNTHETIC_CATALOG.length)
			expect(all.find((record) => record.id === 'mid-b')?.payload).toBeCloseTo(4.4, 12)
		} finally {
			await fs.rm(path, { force: true })
		}
	})

	test('skips invalid coordinates when configured and throws otherwise', async () => {
		const invalidCatalog: readonly SyntheticStar[] = [...SYNTHETIC_CATALOG, { id: 'invalid-dec', rightAscension: deg(10), declination: PI, payload: 9.9 }, { id: 'invalid-ra', rightAscension: Number.NaN, declination: deg(5), payload: 8.8 }]
		const skipped = await buildStarCatalogIndex(invalidCatalog, { invalidCoordinateMode: 'skip', strategy: { type: 'declination-bins', declinationBinCount: 10 } })

		expect(skipped.metadata.indexedRowCount).toBe(SYNTHETIC_CATALOG.length)
		expect(skipped.metadata.skippedRowCount).toBe(2)
		expect(buildStarCatalogIndex(invalidCatalog, { invalidCoordinateMode: 'throw', strategy: { type: 'declination-bins', declinationBinCount: 10 } })).rejects.toThrow('invalid star catalog record')
	})

	test('rejects corrupted persisted buffers and unsupported strategy configs', async () => {
		const built = await buildStarCatalogIndex(SYNTHETIC_CATALOG, { strategy: { type: 'declination-bins', declinationBinCount: 6 } })
		const corrupted = Buffer.from(built.buffer)
		corrupted[corrupted.byteLength - 1] ^= 0xff

		expect(loadStarCatalogIndex(corrupted)).rejects.toThrow('fingerprint mismatch')
		expect(buildStarCatalogIndex(SYNTHETIC_CATALOG, { strategy: { type: 'healpix', order: 4 } })).rejects.toThrow('unsupported star catalog strategy type')
	})

	test('handles the empty catalog without producing false positives', async () => {
		const built = await buildStarCatalogIndex([], { strategy: { type: 'equirectangular-grid', declinationBinCount: 4, rightAscensionBinCount: 8 } })

		expect(built.metadata.indexedRowCount).toBe(0)
		expect(built.metadata.populatedCellCount).toBe(0)
		expect(built.index.queryCone(0, 0, deg(1))).toEqual([])
		expect(built.index.queryRectangle(0, TAU, -PIOVERTWO, PIOVERTWO)).toEqual([])
	})
})

function coneContains(centerRightAscension: number, centerDeclination: number, rightAscension: number, declination: number, radius: number) {
	const deltaDeclination = (declination - centerDeclination) * 0.5
	const deltaRightAscension = angularDifference(rightAscension, centerRightAscension) * 0.5
	const sinDeclination = Math.sin(deltaDeclination)
	const sinRightAscension = Math.sin(deltaRightAscension)
	const hav = sinDeclination * sinDeclination + Math.cos(centerDeclination) * Math.cos(declination) * sinRightAscension * sinRightAscension
	const limit = Math.sin(radius * 0.5)
	return hav <= limit * limit + 1e-15
}

function angularDifference(a: number, b: number) {
	let delta = normalizeAngle(a) - normalizeAngle(b)
	if (delta > PI) delta -= TAU
	else if (delta < -PI) delta += TAU
	return delta
}
