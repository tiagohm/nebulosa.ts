import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { nativePlateSolve } from '../../../src/astrometry/solvers/native'
import { flipQuadCodeParity, forEachQuadCodeVariant, planarQuadCode, quadCode, skyQuadCode } from '../../../src/astrometry/solvers/quad.code'
import { AstrometryNetQuadIndex, libkdTree } from '../../../src/astrometry/solvers/quad.index.astrometrynet'
import { searchKdTree } from '../../../src/astrometry/solvers/quad.kdtree'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { readImageFromJpeg } from '../../../src/imaging/model/image'
import { detectStars } from '../../../src/imaging/stars/detector'
import { type MutVec3, vecAngleUnit } from '../../../src/math/linear-algebra/vec3'
import { arcmin, deg, hour, toArcsec } from '../../../src/math/units/angle'
import { downloadAll } from '../../download'

await downloadAll('index-4116.fits', 'apod4.jpg')

const index = new AstrometryNetQuadIndex('data/index-4116.fits')

describe('index-4116', () => {
	test('reads the band, the pattern size and the arrays', () => {
		expect(index.indexId).toBe(4116)
		expect(index.dimquads).toBe(3)
		expect(index.quadCount).toBe(9408)
		expect(index.starCount).toBe(5880)
		expect(index.scaleLower).toBeCloseTo(0.13962634016, 11)
		expect(index.scaleUpper).toBeCloseTo(0.197803981893, 11)
		expect(index.coverage).toBeUndefined()
		// CUTNSIDE = 7.
		expect(index.cellSize).toBeCloseTo(Math.sqrt(Math.PI / 3) / 7, 12)
	})

	test('every stored code is the code of its stars, as quad.code computes it', () => {
		const out = new Float64Array(4)
		const v: MutVec3[] = [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		]
		const code = quadCode()
		const flipped = quadCode()
		let same = 0
		let swapped = 0

		for (let q = 0; q < index.quadCount; q++) {
			index.quadStars(q, out)
			for (let i = 0; i < 3; i++) index.starVector(out[i], v[i])
			expect(skyQuadCode(v[0], v[1], v[2], v[2], code)).toBeTrue()
			flipQuadCodeParity(code, flipped)
			let found = false
			let foundFlipped = false
			index.searchCodes(code, 1e-4, (quad) => (found ||= quad === q))
			index.searchCodes(flipped, 1e-4, (quad) => (foundFlipped ||= quad === q))
			if (found) same++
			if (foundFlipped) swapped++
		}

		// Bit-compatible codes find their own pattern; with north and east swapped almost none do.
		expect(same).toBe(index.quadCount)
		expect(swapped).toBeLessThan(index.quadCount / 100)
	})

	test('cone queries return the stars within the cone', () => {
		const center = eraS2c(hour(12.5), deg(56.7))
		const radius = deg(10)
		const found = new Set<number>()
		index.starsInCone({ center, radius }, (star) => found.add(star))
		const v: MutVec3 = [0, 0, 0]
		let expected = 0
		for (let s = 0; s < index.starCount; s++) if (vecAngleUnit(index.starVector(s, v), center) <= radius) expected++
		expect(found.size).toBe(expected)
		expect(expected).toBeGreaterThan(10)
	})

	test('sweeps rank the stars within their cells', () => {
		let first = 0
		for (let s = 0; s < index.starCount; s++) if (index.starSweep(s) === 0) first++
		expect(first).toBeGreaterThan(0)
		expect(first).toBeLessThan(index.starCount)
	})

	test('solves a wide field blindly', async () => {
		const image = readImageFromJpeg(Buffer.from(await Bun.file('data/apod4.jpg').arrayBuffer()), undefined, 'GRAY')!
		const stars = detectStars(image, { maxStars: 200 })
		const result = await nativePlateSolve(stars, [index], { width: image.metadata.width, height: image.metadata.height })

		// libastrometry solves this frame with the same index at 12.4786163 h, 56.7126013°, 170.84"/pixel.
		expect(result).toBeDefined()
		expect(vecAngleUnit(eraS2c(result!.solution.rightAscension, result!.solution.declination), eraS2c(hour(12.4786163), deg(56.7126013)))).toBeLessThan(arcmin(1))
		expect(toArcsec(result!.solution.scale)).toBeCloseTo(170.84, 0)
		expect(result!.solution.parity).toBe('NORMAL')
		expect(result!.matchCount).toBeGreaterThan(30)
		expect(result!.rms).toBeLessThan(1)
	})
})

test('refuses a FITS file that is not an index', () => {
	expect(() => new AstrometryNetQuadIndex('data/LIGHT.fit')).toThrow('is not an Astrometry.net index')
})

test('a triangle labeling keeps only cx <= 1/2', () => {
	const code = planarQuadCode(0, 0, 1, 1, 0.8, 0.2, 0.8, 0.2)
	const labelings: number[][] = []
	forEachQuadCodeVariant(code, [0, 1, 2, -1], 0.01, false, (variant) => labelings.push([...variant.stars, variant.code[0]]))
	// cx = 0.8 fails, its swapped backbone (1 - 0.8 = 0.2) passes.
	expect(labelings).toEqual([[1, 0, 2, -1, expect.closeTo(0.2, 12)]])
})

describe('libkd trees', () => {
	// Last point of each leaf of a tree split by count, as quad.kdtree splits (left child floor(n / 2)).
	function countSplitEnds(count: number, levels: number) {
		const ends: number[] = []
		const visit = (lo: number, hi: number, level: number) => {
			if (level === levels - 1) ends.push(hi - 1)
			else {
				const mid = lo + ((hi - lo) >> 1)
				visit(lo, mid, level + 1)
				visit(mid, hi, level + 1)
			}
		}
		visit(0, count, 0)
		return ends
	}

	test('leaves split by count and evenly end where Astrometry.net puts them', () => {
		for (const [count, levels] of [
			[9408, 10],
			[580800, 16],
			[17, 3],
			[5, 4],
		]) {
			const points = new Uint16Array(count * 2)
			const byCount = libkdTree(points, 2, count, levels, undefined, false)
			expect([...byCount.leafEnds!]).toEqual(countSplitEnds(count, levels))
			const leaves = 2 ** (levels - 1)
			const evenly = libkdTree(points, 2, count, levels, undefined, true)
			// Astrometry.net's linear_lr: leaf L starts at L·N / leaves.
			for (let leaf = 0; leaf < leaves; leaf++) expect(evenly.leafEnds![leaf]).toBe(Math.floor(((leaf + 1) * count) / leaves) - 1)
		}
	})

	test('a tree with stored leaf ends is searched exactly', () => {
		const count = 1000
		const levels = 6
		const points = new Uint16Array(count * 2)
		for (let i = 0; i < points.length; i++) points[i] = (i * 7919) % 65536
		// Uneven leaves, one of them empty.
		const lr = Int32Array.from({ length: 32 }, (_, leaf) => Math.min(count - 1, (leaf + 1) * 31 + 3))
		lr[5] = lr[4]
		lr[31] = count - 1
		const tree = libkdTree(points, 2, count, levels, lr, false)

		for (let k = 0; k < 50; k++) {
			const query = [(k * 1301) % 65536, (k * 2903) % 65536]
			const radius = 3000 + k * 100
			const found: number[] = []
			searchKdTree(tree, query, radius, (p) => found.push(p))
			const expected: number[] = []
			for (let p = 0; p < count; p++) if ((points[p * 2] - query[0]) ** 2 + (points[p * 2 + 1] - query[1]) ** 2 <= radius * radius) expected.push(p)
			expect(found.sort((a, b) => a - b)).toEqual(expected)
		}
	})
})

describe('index-4110', () => {
	test('stores quads whose codes are those of quad.code', async () => {
		await downloadAll('index-4110.fits')
		using quads = new AstrometryNetQuadIndex('data/index-4110.fits')
		expect(quads.dimquads).toBe(4)
		expect(quads.quadCount).toBe(580800)
		expect(quads.starCount).toBe(362959)

		const out = new Float64Array(4)
		const v: MutVec3[] = [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		]
		const code = quadCode()
		let checked = 0
		let same = 0

		for (let q = 0; q < quads.quadCount; q += 97) {
			quads.quadStars(q, out)
			for (let i = 0; i < 4; i++) quads.starVector(out[i], v[i])
			skyQuadCode(v[0], v[1], v[2], v[3], code)
			let found = false
			quads.searchCodes(code, 1e-4, (quad) => (found ||= quad === q))
			if (found) same++
			checked++
		}

		expect(same).toBe(checked)
	})
})

describe('byte order', () => {
	const DIR = fs.mkdtempSync(join(os.tmpdir(), 'anidx-'))
	afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }))

	// Copies index-4116 with its primary ENDIAN card replaced.
	function withEndian(card: string) {
		const bytes = new Uint8Array(fs.readFileSync('data/index-4116.fits'))
		const text = new TextDecoder('latin1').decode(bytes.subarray(0, 8640))
		const at = text.indexOf('ENDIAN  =')
		for (let i = 0; i < 80; i++) bytes[at + i] = card.padEnd(80).charCodeAt(i)
		const path = join(DIR, `${Bun.hash(card)}.fits`)
		fs.writeFileSync(path, bytes)
		return path
	}

	test('a file without ENDIAN is read when its ranges are plausible', () => {
		using read = new AstrometryNetQuadIndex(withEndian('COMMENT no byte order stated'))
		expect(read.quadCount).toBe(9408)
	})

	test('a big-endian file is refused', () => {
		expect(() => new AstrometryNetQuadIndex(withEndian("ENDIAN  = '01:02:03:04'"))).toThrow('unsupported byte order')
	})
})
