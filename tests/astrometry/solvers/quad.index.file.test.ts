import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import { basename, join } from 'path'
import { buildQuadBand } from '../../../src/astrometry/solvers/quad.builder'
import { dequantizeQuadCodeComponent, quadCode, skyQuadCode } from '../../../src/astrometry/solvers/quad.code'
import { buildQuadIndexTile, decodeQuadIndexTile, encodeQuadIndexTile, NebulosaQuadIndex, quadIndexTileCone, quadIndexTileFileName, quadIndexTilesFromBand, verifyQuadIndexTile } from '../../../src/astrometry/solvers/quad.index.file'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { DEG2RAD } from '../../../src/core/constants'
import { type MutVec3, vecAngleUnit } from '../../../src/math/linear-algebra/vec3'
import { mulberry32 } from '../../../src/math/numerical/random'

const DIR = fs.mkdtempSync(join(os.tmpdir(), 'nqi-'))
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }))

// Uniform random stars in a cap, brightest first, with magnitudes, proper motions and source ids.
function sky(seed: number, count: number, ra: number, dec: number, radius: number) {
	const random = mulberry32(seed)
	const vectors = new Float64Array(count * 3)
	const theta = Math.PI / 2 - dec

	for (let i = 0; i < count; i++) {
		const z = 1 - random() * (1 - Math.cos(radius))
		const phi = random() * 2 * Math.PI
		const r = Math.sqrt(1 - z * z)
		const lx = r * Math.cos(phi)
		const ly = r * Math.sin(phi)
		const x1 = lx * Math.cos(theta) + z * Math.sin(theta)
		const z1 = -lx * Math.sin(theta) + z * Math.cos(theta)
		vectors.set([x1 * Math.cos(ra) - ly * Math.sin(ra), x1 * Math.sin(ra) + ly * Math.cos(ra), z1], i * 3)
	}

	const magnitudes = Float64Array.from({ length: count }, (_, i) => 6 + (8 * i) / count)
	const properMotions = Float64Array.from({ length: count * 2 }, () => (random() - 0.5) * 1e-7)
	const sources = BigUint64Array.from({ length: count }, (_, i) => 4000000000000000000n + BigInt(i))
	return { vectors, magnitudes, properMotions, sources }
}

const stars = sky(1, 6000, 2, 0.5, 3 * DEG2RAD)
const band = buildQuadBand(stars.vectors, { scaleLower: 0.2 * DEG2RAD, scaleUpper: 0.2 * DEG2RAD * Math.SQRT2 })
const tiles = quadIndexTilesFromBand(band, { tileNside: 32, jitter: 1e-5, epoch: 2016, magnitudes: stars.magnitudes, properMotions: stars.properMotions, sources: stars.sources, magnitudeLimit: 14, catalog: 'synthetic Gaia DR3' })
const paths = tiles.map((tile) => {
	const path = join(DIR, quadIndexTileFileName(tile))
	fs.writeFileSync(path, encodeQuadIndexTile(tile))
	return path
})

describe('tiles', () => {
	test('hold every quad once and only quads whose backbone midpoint lies in them', () => {
		expect(tiles.length).toBeGreaterThan(3)
		expect(tiles.reduce((sum, tile) => sum + tile.quadStars.length / 4, 0)).toBe(band.quads.length / 4)
		expect(new Set(tiles.map((tile) => tile.tileId)).size).toBe(tiles.length)
	})

	test('round-trip through the file bytes', () => {
		for (const tile of tiles) {
			const bytes = encodeQuadIndexTile(tile)
			expect(bytes.byteLength % 64).toBe(0)
			expect(verifyQuadIndexTile(bytes)).toBeTrue()
			const read = decodeQuadIndexTile(bytes)
			expect(read.scaleLower).toBe(tile.scaleLower)
			expect(read.scaleUpper).toBe(tile.scaleUpper)
			expect(read.epoch).toBe(2016)
			expect(read.jitter).toBe(1e-5)
			expect(read.nside).toBe(band.nside)
			expect(read.tileNside).toBe(32)
			expect(read.tileId).toBe(tile.tileId)
			expect(read.catalog).toBe('synthetic Gaia DR3')
			expect(read.magnitudeLimit).toBe(14)
			expect(read.ownStarCount).toBe(tile.ownStarCount)
			expect(read.stars).toEqual(tile.stars)
			expect(read.magnitudes).toEqual(tile.magnitudes)
			expect(read.sweeps).toEqual(tile.sweeps)
			expect(read.cellIds).toEqual(tile.cellIds)
			expect(read.cellOffsets).toEqual(tile.cellOffsets)
			expect(read.properMotions).toEqual(tile.properMotions)
			expect(read.sources).toEqual(tile.sources)
			expect(read.quadStars).toEqual(tile.quadStars)
			expect(read.codes.points).toEqual(tile.codes.points)
			expect(read.codes.lower).toEqual(tile.codes.lower)
			expect(read.codes.levels).toBe(tile.codes.levels)
		}
	})

	test('stored codes are the codes of the stored stars', () => {
		const code = quadCode()
		const vectors = [0, 1, 2, 3].map((): MutVec3 => [0, 0, 0])

		for (const tile of tiles.slice(0, 3)) {
			for (let q = 0; q < tile.quadStars.length / 4; q += 5) {
				for (let i = 0; i < 4; i++) {
					const s = tile.quadStars[q * 4 + i]
					vectors[i][0] = tile.stars[s * 3]
					vectors[i][1] = tile.stars[s * 3 + 1]
					vectors[i][2] = tile.stars[s * 3 + 2]
				}
				expect(skyQuadCode(vectors[0], vectors[1], vectors[2], vectors[3], code)).toBeTrue()
				// float32 positions and 16-bit codes agree far below the matching tolerance of 0.01.
				for (let i = 0; i < 4; i++) expect(Math.abs(code[i] - dequantizeQuadCodeComponent(tile.codes.points[q * 4 + i]))).toBeLessThan(1e-3)
			}
		}
	})

	test('a corrupted section fails the checksum and a wrong signature is refused', () => {
		const bytes = encodeQuadIndexTile(tiles[0])
		bytes[bytes.byteLength - 70] ^= 0xff
		expect(verifyQuadIndexTile(bytes)).toBeFalse()
		const signature = encodeQuadIndexTile(tiles[0])
		signature[0] = 0
		expect(() => decodeQuadIndexTile(signature)).toThrow('not a quad index file')
	})
})

describe('NebulosaQuadIndex', () => {
	test('finds each quad by its code across the tiles, also with a one-tile byte budget', () => {
		for (const maxLoadedBytes of [undefined, 1]) {
			using index = new NebulosaQuadIndex(paths, { maxLoadedBytes })
			expect(index.tileCount).toBe(tiles.length)
			const out = new Float64Array(4)
			const vectors = [0, 1, 2, 3].map((): MutVec3 => [0, 0, 0])
			const code = quadCode()
			let checked = 0

			for (let q = 0; q < band.quads.length / 4; q += 11) {
				for (let i = 0; i < 4; i++) vectors[i].splice(0, 3, ...band.stars.subarray(band.quads[q * 4 + i] * 3, band.quads[q * 4 + i] * 3 + 3))
				skyQuadCode(vectors[0], vectors[1], vectors[2], vectors[3], code)
				let found = false

				index.searchCodes(code, 1e-3, (quad) => {
					index.quadStars(quad, out)
					const a = index.starVector(out[0], [0, 0, 0])
					if (vecAngleUnit(a, vectors[0]) < 1e-6) found = true
				})

				expect(found).toBeTrue()
				checked++
			}

			expect(checked).toBeGreaterThan(20)
		}
	})

	test('a region restricts the code search to nearby tiles', () => {
		using index = new NebulosaQuadIndex(paths)
		let all = 0
		let near = 0
		const code = [0.3, 0.4, 0.5, 0.2] as const
		index.searchCodes(code, 0.3, () => all++)
		index.searchCodes(code, 0.3, () => near++, { center: eraS2c(2, 0.5), radius: 0.3 * DEG2RAD })
		expect(near).toBeGreaterThan(0)
		expect(near).toBeLessThan(all)
	})

	test('cone queries return every own star in the cone once', () => {
		using index = new NebulosaQuadIndex(paths)
		const center = eraS2c(2.01, 0.49)
		const radius = 0.8 * DEG2RAD
		const found: number[] = []
		index.starsInCone({ center, radius }, (star) => found.push(star))
		const vectors = found.map((star) => index.starVector(star, [0, 0, 0]))

		let expected = 0
		for (let s = 0; s < band.sweeps.length; s++) {
			if (vecAngleUnit(band.stars.subarray(s * 3, s * 3 + 3) as unknown as MutVec3, center) <= radius - 1e-6) expected++
		}

		expect(new Set(found).size).toBe(found.length)
		for (const v of vectors) expect(vecAngleUnit(v, center)).toBeLessThanOrEqual(radius + 1e-6)
		expect(Math.abs(found.length - expected)).toBeLessThanOrEqual(2)
	})

	test('carries positions by proper motion to the requested epoch', () => {
		using atEpoch = new NebulosaQuadIndex(paths)
		using later = new NebulosaQuadIndex(paths, { epoch: 2116 })
		const ids: number[] = []
		atEpoch.starsInCone({ center: eraS2c(2, 0.5), radius: 0.2 * DEG2RAD }, (star) => ids.push(star))
		const star = ids[0]
		const tile = tiles.find((t) => t.tileId === decodeTileId(star))!
		const local = star % 2 ** 32
		const [ra0, dec0] = eraC2s(...atEpoch.starVector(star, [0, 0, 0]))
		const [ra1, dec1] = eraC2s(...later.starVector(star, [0, 0, 0]))
		expect(ra1 - ra0).toBeCloseTo(tile.properMotions![local * 2] * 100, 9)
		expect(dec1 - dec0).toBeCloseTo(tile.properMotions![local * 2 + 1] * 100, 9)
	})

	test('refuses files of different bands', () => {
		const other = quadIndexTilesFromBand(buildQuadBand(stars.vectors, { scaleLower: 0.3 * DEG2RAD, scaleUpper: 0.42 * DEG2RAD }), { tileNside: 32, jitter: 1e-5, epoch: 2016 })[0]
		const path = join(DIR, `other${quadIndexTileFileName(other)}`)
		fs.writeFileSync(path, encodeQuadIndexTile(other))
		expect(() => new NebulosaQuadIndex([paths[0], path])).toThrow('belongs to another band')
	})

	test('a damaged header throws when a section is loaded instead of hanging a search', () => {
		const bytes = encodeQuadIndexTile(tiles[0])
		const view = new DataView(bytes.buffer)
		const write = (name: string, patch: (copy: DataView) => void) => {
			const copy = bytes.slice()
			patch(new DataView(copy.buffer))
			const path = join(DIR, `${name}.nqi`)
			fs.writeFileSync(path, copy)
			return path
		}

		// Zero levels: the search would never reach a leaf.
		using levels = new NebulosaQuadIndex([write('levels', (copy) => copy.setUint32(108, 0, true))])
		expect(() => levels.searchCodes([0.3, 0.4, 0.5, 0.2], 0.01, () => {})).toThrow('inconsistent quad code tree')
		expect(() => decodeQuadIndexTile(fs.readFileSync(join(DIR, 'levels.nqi')))).toThrow('inconsistent quad code tree')

		// A star section claiming 1.5 GB: refused against the file size before anything that large is allocated.
		for (let i = 0; i < view.getUint32(116, true); i++) {
			const entry = 128 + i * 24
			if (view.getUint32(entry, true) !== 1) continue
			using huge = new NebulosaQuadIndex([write('huge', (copy) => copy.setUint32(entry + 16, 1.5 * 2 ** 30, true))])
			expect(() => huge.starVector(0, [0, 0, 0])).toThrow('out of bounds')
		}

		// Cell offsets past the stars: a cone query would read past them.
		const cellOffsets = tiles[0].cellOffsets
		using offsets = new NebulosaQuadIndex([
			write('offsets', (copy) => {
				for (let i = 0; i < copy.getUint32(116, true); i++) {
					const entry = 128 + i * 24
					if (copy.getUint32(entry, true) === 5) copy.setUint32(copy.getUint32(entry + 8, true) + (cellOffsets.length - 1) * 4, 0xffffffff, true)
				}
			}),
		])
		expect(() => offsets.starVector(0, [0, 0, 0])).toThrow('inconsistent cell offsets')

		// A file shorter than its header.
		const short = join(DIR, 'short.nqi')
		fs.writeFileSync(short, bytes.subarray(0, 100))
		expect(() => new NebulosaQuadIndex([short])).toThrow('truncated')
	})
})

// Tile id of a global star id, through the tile order of the paths.
function decodeTileId(star: number) {
	return tiles[Math.floor(star / 2 ** 32)].tileId
}

test('a tile built alone from its cone holds the quads of its cells only', () => {
	const options = { scaleLower: 0.2 * DEG2RAD, scaleUpper: 0.2 * DEG2RAD * Math.SQRT2 }
	const target = tiles[Math.floor(tiles.length / 2)]
	const cone = quadIndexTileCone(32, target.tileId, options.scaleUpper)
	const inside: number[] = []
	for (let s = 0; s < stars.magnitudes.length; s++) if (vecAngleUnit(stars.vectors.subarray(s * 3, s * 3 + 3) as unknown as MutVec3, cone.center) <= cone.radius) inside.push(s)
	const subset = {
		vectors: Float64Array.from(inside.flatMap((s) => [...stars.vectors.subarray(s * 3, s * 3 + 3)])),
		magnitudes: inside.map((s) => stars.magnitudes[s]),
	}

	const alone = buildQuadIndexTile(subset, options, 32, target.tileId, { jitter: 1e-5, epoch: 2016 })!
	expect(alone.tileId).toBe(target.tileId)
	expect(alone.quadStars.length).toBeGreaterThan(0.8 * target.quadStars.length)
	expect(alone.quadStars.length).toBeLessThan(1.2 * target.quadStars.length)
	expect(verifyQuadIndexTile(encodeQuadIndexTile(alone))).toBeTrue()
})

test('code sections stay loaded under any star budget', () => {
	const moved = join(DIR, 'moved')
	fs.mkdirSync(moved, { recursive: true })
	const copies = paths.map((path) => {
		const copy = join(moved, basename(path))
		fs.copyFileSync(path, copy)
		return copy
	})

	using index = new NebulosaQuadIndex(copies, { maxLoadedBytes: 1 })
	let before = 0
	index.searchCodes([0.3, 0.4, 0.5, 0.2], 0.3, () => before++)
	index[Symbol.dispose]()
	// Disposal releases everything; a fresh pass loads the codes again, then the files go away.
	let first = 0
	index.searchCodes([0.3, 0.4, 0.5, 0.2], 0.3, () => first++)
	fs.rmSync(moved, { recursive: true, force: true })

	if (process.platform === 'win32') {
		// Read sections, not mappings: the codes are still searchable without the files; the stars are not.
		let after = 0
		index.searchCodes([0.3, 0.4, 0.5, 0.2], 0.3, () => after++)
		expect(after).toBe(before)
		expect(() => index.starsInCone({ center: eraS2c(2, 0.5), radius: 0.2 * DEG2RAD }, () => {})).toThrow()
	}

	expect(first).toBe(before)
})

test('the epoch is the file epoch when the files have no proper motions', () => {
	const tile = quadIndexTilesFromBand(band, { tileNside: 32, jitter: 1e-5, epoch: 2016 })[0]
	const path = join(DIR, `still${quadIndexTileFileName(tile)}`)
	fs.writeFileSync(path, encodeQuadIndexTile(tile))
	using still = new NebulosaQuadIndex([path], { epoch: 2030 })
	expect(still.epoch).toBe(2016)
	using moving = new NebulosaQuadIndex([paths[0]], { epoch: 2030 })
	expect(moving.epoch).toBe(2030)
})
