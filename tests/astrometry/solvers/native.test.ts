import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { nativeNearbyPlateSolve, nativePlateSolve, nativeSolutionHeader } from '../../../src/astrometry/solvers/native'
import { fitLinearTanWcs, fitSimilarityTanWcs, type TanWcs, tanPixelToSky, tanSkyToPixel } from '../../../src/astrometry/solvers/native.fit'
import * as tweak from '../../../src/astrometry/solvers/native.tweak'
import { radiusOfRelevanceSq, verifyStarLists } from '../../../src/astrometry/solvers/native.verify'
import type { Parity } from '../../../src/astrometry/solvers/platesolver'
import { buildQuadBand } from '../../../src/astrometry/solvers/quad.builder'
import type { QuadIndex } from '../../../src/astrometry/solvers/quad.index'
import { catalogStarVectors, EphemeralQuadIndex } from '../../../src/astrometry/solvers/quad.index.ephemeral'
import { encodeQuadIndexTile, NebulosaQuadIndex, quadIndexTileFileName, quadIndexTilesFromBand } from '../../../src/astrometry/solvers/quad.index.file'
import { tanProject, tanUnproject } from '../../../src/astrometry/wcs/fits.wcs'
import * as sipFit from '../../../src/astrometry/wcs/sip.fit'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import type { StarCatalog, StarCatalogEntry } from '../../../src/catalogs/stars/catalog'
import { HnskyCatalog } from '../../../src/catalogs/stars/hnsky'
import { ASEC2RAD, DEG2RAD } from '../../../src/core/constants'
import { type DetectedStar, detectStars } from '../../../src/imaging/stars/detector'
import { Bitpix } from '../../../src/io/formats/fits/fits'
import { type MutVec3, vecAngleUnit } from '../../../src/math/linear-algebra/vec3'
import { gaussian, mulberry32 } from '../../../src/math/numerical/random'
import { arcsec, deg, hour, toArcsec, toDeg } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'
import { readImage } from '../../imaging/util'

await downloadPerTag('starmatching')

// A synthetic sky: stars uniformly spread in a cap, with magnitudes from a power law (brighter stars rarer).
interface Sky {
	readonly vectors: Float64Array // brightest first
	readonly magnitudes: Float64Array
}

function syntheticSky(seed: number, ra: number, dec: number, radius: number, density: number): Sky {
	const random = mulberry32(seed)
	const area = 2 * Math.PI * (1 - Math.cos(radius))
	const count = Math.round((density * area) / (DEG2RAD * DEG2RAD))
	const stars: { v: MutVec3; mag: number }[] = []
	const center = eraS2c(ra, dec)
	const theta = Math.PI / 2 - dec

	for (let i = 0; i < count; i++) {
		const z = 1 - random() * (1 - Math.cos(radius))
		const phi = random() * 2 * Math.PI
		const r = Math.sqrt(1 - z * z)
		const lx = r * Math.cos(phi)
		const ly = r * Math.sin(phi)
		const x1 = lx * Math.cos(theta) + z * Math.sin(theta)
		const z1 = -lx * Math.sin(theta) + z * Math.cos(theta)
		const v: MutVec3 = [x1 * Math.cos(ra) - ly * Math.sin(ra), x1 * Math.sin(ra) + ly * Math.cos(ra), z1]
		// Cumulative counts grow ~10^(0.35 m): m = log10(u)/0.35 + limit.
		stars.push({ v, mag: 14 + Math.log10(Math.max(1e-9, random())) / 0.35 })
	}

	expect(vecAngleUnit(stars[0].v, center)).toBeLessThanOrEqual(radius + 1e-9)
	stars.sort((a, b) => a.mag - b.mag)
	const vectors = new Float64Array(stars.length * 3)
	const magnitudes = new Float64Array(stars.length)
	for (const [i, star] of stars.entries()) {
		vectors.set(star.v, i * 3)
		magnitudes[i] = star.mag
	}
	return { vectors, magnitudes }
}

// A WCS of the given scale (radians per pixel), rotation (radians) and parity, centered on (ra, dec).
function wcsOf(ra: number, dec: number, scale: number, rotation: number, parity: Parity, width: number, height: number): TanWcs {
	const cos = Math.cos(rotation) * scale
	const sin = Math.sin(rotation) * scale
	// plateSolutionFrom calls a non-negative CD determinant NORMAL: a rotation, or a mirrored rotation for FLIPPED.
	const sign = parity === 'NORMAL' ? 1 : -1
	return { crval: eraS2c(ra, dec), crpix1: (width + 1) / 2, crpix2: (height + 1) / 2, cd11: cos * sign, cd12: -sin * sign, cd21: sin, cd22: cos }
}

interface ImageOptions {
	readonly seed: number
	readonly width: number
	readonly height: number
	readonly limit: number // faintest magnitude detected
	readonly noise?: number // centroid noise, pixels
	readonly missing?: number // fraction of detectable stars not detected
	readonly distractors?: number // fraction of extra false detections
	readonly distortion?: number // radial pixel distortion coefficient (pixels at the corner)
}

// Renders the stars of a sky through a WCS into detections (zero-based centroids, flux from magnitude).
function detect(sky: Sky, wcs: TanWcs, { seed, width, height, limit, noise = 0.2, missing = 0, distractors = 0, distortion = 0 }: ImageOptions): DetectedStar[] {
	const random = mulberry32(seed)
	const jitter = gaussian(random, noise)
	const stars: DetectedStar[] = []
	const pixel: [number, number] = [0, 0]
	const v: MutVec3 = [0, 0, 0]
	const corner = Math.hypot(width, height) / 2

	for (let i = 0; i < sky.magnitudes.length; i++) {
		if (sky.magnitudes[i] > limit) break
		v[0] = sky.vectors[i * 3]
		v[1] = sky.vectors[i * 3 + 1]
		v[2] = sky.vectors[i * 3 + 2]
		if (!tanSkyToPixel(wcs, v, pixel)) continue
		let x = pixel[0] - 1
		let y = pixel[1] - 1
		if (distortion !== 0) {
			const dx = x - width / 2
			const dy = y - height / 2
			const k = (distortion * (dx * dx + dy * dy)) / (corner * corner * corner)
			x += dx * k
			y += dy * k
		}
		if (x < 0 || y < 0 || x > width - 1 || y > height - 1) continue
		if (random() < missing) continue
		const flux = 10 ** (-0.4 * (sky.magnitudes[i] - 10))
		stars.push({ x: x + jitter(), y: y + jitter(), flux, snr: 100, hfd: 3 })
	}

	const extra = Math.round(stars.length * distractors)
	for (let i = 0; i < extra; i++) stars.push({ x: random() * (width - 1), y: random() * (height - 1), flux: 10 ** (-0.4 * (limit - 10)) * (0.5 + random() * 20), snr: 50, hfd: 3 })
	return stars
}

// Quad indexes over a sky for bands of the shorter image side.
function indexesFor(sky: Sky, shortSide: number, fractions: readonly number[] = [0.2, 0.28, 0.4], region?: { center: MutVec3; radius: number }) {
	return fractions.map((fraction) => EphemeralQuadIndex.fromVectors(sky.vectors, { scaleLower: fraction * shortSide, scaleUpper: fraction * shortSide * Math.SQRT2, region, id: `test:${fraction}` }))
}

function expectSolution(header: Readonly<Record<string, unknown>>, truth: TanWcs, width: number, height: number, tolerance: number = 1.5 * ASEC2RAD) {
	// Every image corner and the center map to the same sky point in both WCS within the tolerance.
	for (const [x, y] of [
		[(width + 1) / 2, (height + 1) / 2],
		[1, 1],
		[width, 1],
		[1, height],
		[width, height],
	]) {
		const solved = tanUnproject(header as never, x, y)!
		const expected = eraC2s(...tanPixelToSky(truth, x, y))
		expect(vecAngleUnit(eraS2c(solved[0], solved[1]), eraS2c(expected[0], expected[1]))).toBeLessThan(tolerance)
	}
}

describe('TAN fit', () => {
	test('projection agrees with the FITS WCS reader', () => {
		const truth = wcsOf(2.5, -0.7, 1.7 * ASEC2RAD, 0.6, 'NORMAL', 3000, 2000)
		const header = nativeSolutionHeader({ wcs: truth }, 3000, 2000)
		const pixel: [number, number] = [0, 0]

		for (const [x, y] of [
			[1, 1],
			[3000, 2000],
			[700, 1600],
		]) {
			const v = tanPixelToSky(truth, x, y)
			const [ra, dec] = eraC2s(v[0], v[1], v[2])
			const fits = tanProject(header, ra, dec)!
			expect(tanSkyToPixel(truth, v, pixel)).toBeTrue()
			expect(pixel[0]).toBeCloseTo(x, 6)
			expect(pixel[1]).toBeCloseTo(y, 6)
			expect(fits[0]).toBeCloseTo(x, 6)
			expect(fits[1]).toBeCloseTo(y, 6)
		}
	})

	test('projection and deprojection agree with the tangent point exactly at a pole', () => {
		for (const dec of [Math.PI / 2, -Math.PI / 2]) {
			// eraS2c(1, ±PI/2) has a z of exactly ±1 with tiny nonzero x and y.
			const wcs = wcsOf(1, dec, 2 * ASEC2RAD, 0.4, 'NORMAL', 2000, 1500)
			expect(Math.abs(wcs.crval[2])).toBe(1)
			const pixel: [number, number] = [0, 0]
			expect(tanSkyToPixel(wcs, tanPixelToSky(wcs, 1700, 200), pixel)).toBeTrue()
			expect(pixel[0]).toBeCloseTo(1700, 6)
			expect(pixel[1]).toBeCloseTo(200, 6)
		}
	})

	for (const parity of ['NORMAL', 'FLIPPED'] as const) {
		for (const [ra, dec] of [
			[0.0001, 0.2],
			[3, Math.PI / 2 - 0.0002],
			[5, -1.2],
		]) {
			test(`similarity and linear fits recover a ${parity} WCS at (${ra}, ${dec})`, () => {
				const truth = wcsOf(ra, dec, 2 * ASEC2RAD, 2.1, parity, 2000, 1500)
				const points = [
					[100, 200],
					[1900, 150],
					[1000, 1400],
					[400, 900],
					[1700, 1100],
				]
				const vectors = new Float64Array(points.length * 3)
				for (const [i, [x, y]] of points.entries()) vectors.set(tanPixelToSky(truth, x, y), i * 3)
				const pairs = { count: points.length, x: points.map((p) => p[0]), y: points.map((p) => p[1]), vectors }
				const fit = fitSimilarityTanWcs(pairs, undefined, [1000.5, 750.5])!
				expect(fit.flipped).toBe(parity === 'FLIPPED')
				const header = nativeSolutionHeader({ wcs: fit.wcs }, 2000, 1500)
				expectSolution(header, truth, 2000, 1500, 1e-3 * ASEC2RAD)
				const linear = fitLinearTanWcs(pairs, fit.wcs)!
				expectSolution(nativeSolutionHeader({ wcs: linear.wcs }, 2000, 1500), truth, 2000, 1500, 1e-3 * ASEC2RAD)
			})
		}
	}
})

describe('verification', () => {
	test('a true hypothesis passes 1e9 and a shifted one bails', () => {
		const random = mulberry32(5)
		const n = 60
		const refX = Float64Array.from({ length: n }, () => 1 + random() * 1999)
		const refY = Float64Array.from({ length: n }, () => 1 + random() * 1499)
		const noise = gaussian(random, 0.5)
		const testX = Float64Array.from(refX, (x) => x + noise())
		const testY = Float64Array.from(refY, (y) => y + noise())
		const sigma2 = new Float64Array(n).fill(2)
		const good = verifyStarLists({ testCount: n, testX, testY, testSigma2: sigma2, refCount: n, refX, refY, effectiveArea: 2000 * 1500 })
		expect(good.logOdds).toBeGreaterThan(Math.log(1e9))
		expect(good.matchCount).toBeGreaterThan(50)

		const shiftedX = Float64Array.from(testX, (x) => x + 40)
		const bad = verifyStarLists({ testCount: n, testX: shiftedX, testY, testSigma2: sigma2, refCount: n, refX, refY, effectiveArea: 2000 * 1500 })
		expect(bad.logOdds).toBeLessThan(Math.log(1e6))
	})

	test('a reference claimed twice keeps one owner', () => {
		// Switching would turn the first star into a distractor, which costs more than the closer match gains.
		const result = verifyStarLists({ testCount: 2, testX: [100.8, 100.1], testY: [100, 100], testSigma2: [1, 1], refCount: 1, refX: [100], refY: [100], effectiveArea: 1e6 })
		expect(result.theta[0]).toBe(0)
		expect(result.theta[1]).toBe(-2)
		expect(result.matchCount).toBe(1)
	})

	test('the radius of relevance is at least the quad radius', () => {
		expect(radiusOfRelevanceSq(100, 10, 0.25, 50, 1)).toBe(100)
		expect(radiusOfRelevanceSq(100, 4e6, 0.25, 50, 1)).toBeGreaterThan(100)
	})
})

describe('solve', () => {
	const width = 1600
	const height = 1200
	const scale = 2 * ASEC2RAD
	const ra = 1.2
	const dec = 0.4
	const sky = syntheticSky(11, ra, dec, 2 * DEG2RAD, 400)
	const shortSide = height * scale

	for (const parity of ['NORMAL', 'FLIPPED'] as const) {
		test(`hinted ${parity} field with noise, missing stars and distractors`, async () => {
			const truth = wcsOf(ra + 0.003, dec - 0.002, scale, 0.7, parity, width, height)
			const stars = detect(sky, truth, { seed: 3, width, height, limit: 13, noise: 0.3, missing: 0.15, distractors: 0.2 })
			const indexes = indexesFor(sky, shortSide)
			const result = await nativePlateSolve(stars, indexes, { width, height, scale: { lower: scale * 0.9, upper: scale * 1.1 }, rightAscension: ra, declination: dec, radius: DEG2RAD, sipOrder: 0 })
			expect(result).toBeDefined()
			expect(result!.solution.parity).toBe(parity)
			expect(result!.logOdds).toBeGreaterThan(Math.log(1e9))
			expect(result!.solution.scale / scale).toBeCloseTo(1, 3)
			expectSolution(result!.header, truth, width, height)
		})
	}

	test('blind field without scale or position', async () => {
		const truth = wcsOf(ra - 0.004, dec + 0.003, scale, 2.5, 'NORMAL', width, height)
		const stars = detect(sky, truth, { seed: 4, width, height, limit: 13, missing: 0.1, distractors: 0.1 })
		const indexes = indexesFor(sky, shortSide, [0.14, 0.2, 0.28, 0.4, 0.56])
		const result = await nativePlateSolve(stars, indexes, { width, height })
		expect(result).toBeDefined()
		expectSolution(result!.header, truth, width, height)
	})

	test('blind field over tiled index files', async () => {
		const directory = fs.mkdtempSync(join(os.tmpdir(), 'nqi-solve-'))

		try {
			const indexes = [0.14, 0.2, 0.28, 0.4].map((fraction) => {
				const band = buildQuadBand(sky.vectors, { scaleLower: fraction * shortSide, scaleUpper: fraction * shortSide * Math.SQRT2 })
				const paths = quadIndexTilesFromBand(band, { tileNside: 16, jitter: ASEC2RAD, epoch: 2000, magnitudes: sky.magnitudes }).map((tile) => {
					const path = join(directory, quadIndexTileFileName(tile))
					fs.writeFileSync(path, encodeQuadIndexTile(tile))
					return path
				})
				return new NebulosaQuadIndex(paths)
			})

			const truth = wcsOf(ra + 0.005, dec - 0.004, scale, 5.1, 'FLIPPED', width, height)
			const stars = detect(sky, truth, { seed: 15, width, height, limit: 13, missing: 0.1, distractors: 0.1 })
			const result = await nativePlateSolve(stars, indexes, { width, height })
			for (const index of indexes) index[Symbol.dispose]()
			expect(result).toBeDefined()
			expect(result!.indexId.startsWith('nqi:')).toBeTrue()
			// The refined solution, not the unrefined hypothesis: the refinement matches stars whose tiled ids exceed 32 bits.
			expect(result!.header.CTYPE1).toBe('RA---TAN-SIP')
			expect(result!.matchCount).toBeGreaterThan(40)
			expectSolution(result!.header, truth, width, height)
		} finally {
			fs.rmSync(directory, { recursive: true, force: true })
		}
	})

	test('distorted field gains a SIP solution with reverse terms', async () => {
		const truth = wcsOf(ra, dec, scale, 1.1, 'NORMAL', width, height)
		const stars = detect(sky, truth, { seed: 6, width, height, limit: 13.5, noise: 0.1, distortion: 6 })
		const indexes = indexesFor(sky, shortSide)
		const linear = await nativePlateSolve(stars, indexes, { width, height, scale: { lower: scale * 0.9, upper: scale * 1.1 }, sipOrder: 0 })
		const sip = await nativePlateSolve(stars, indexes, { width, height, scale: { lower: scale * 0.9, upper: scale * 1.1 }, sipOrder: 3 })
		expect(linear).toBeDefined()
		expect(sip).toBeDefined()
		expect(sip!.header.CTYPE1).toBe('RA---TAN-SIP')
		expect(sip!.header.AP_ORDER).toBe(4)
		expect(sip!.rms).toBeLessThan(linear!.rms)
		expect(sip!.rms).toBeLessThan(0.5)
	})

	test('a parity hint keeps only the matching parity', async () => {
		const truth = wcsOf(ra, dec, scale, 1.9, 'FLIPPED', width, height)
		const stars = detect(sky, truth, { seed: 12, width, height, limit: 13 })
		const indexes = indexesFor(sky, shortSide)
		const options = { width, height, scale: { lower: scale * 0.9, upper: scale * 1.1 }, sipOrder: 0 }
		const right = await nativePlateSolve(stars, indexes, { ...options, parity: 'FLIPPED' })
		expect(right?.solution.parity).toBe('FLIPPED')
		expect(await nativePlateSolve(stars, indexes, { ...options, parity: 'NORMAL' })).toBeUndefined()
	})

	test('a later SIP failure keeps the previous distortion', async () => {
		const truth = wcsOf(ra, dec, scale, 1.1, 'NORMAL', width, height)
		const stars = detect(sky, truth, { seed: 6, width, height, limit: 13.5, noise: 0.1, distortion: 6 })
		const fitSipDistortion = sipFit.fitSipDistortion
		let calls = 0
		const spy = spyOn(sipFit, 'fitSipDistortion').mockImplementation((...args: Parameters<typeof fitSipDistortion>) => {
			if (calls++ === 0) return fitSipDistortion(...args)
			throw new sipFit.SipFitError('illConditionedFit', 'forced')
		})

		try {
			const result = await nativePlateSolve(stars, indexesFor(sky, shortSide), { width, height, scale: { lower: scale * 0.9, upper: scale * 1.1 }, sipOrder: 3 })
			expect(calls).toBeGreaterThan(1)
			expect(result!.header.CTYPE1).toBe('RA---TAN-SIP')
			expect(result!.rms).toBeLessThan(1)
		} finally {
			spy.mockRestore()
		}
	})

	test('a refinement worse than the hypothesis keeps the hypothesis', async () => {
		const truth = wcsOf(ra, dec, scale, 0.9, 'NORMAL', width, height)
		const stars = detect(sky, truth, { seed: 13, width, height, limit: 13, noise: 0.2 })
		const tweakSolution = tweak.tweakSolution
		const spy = spyOn(tweak, 'tweakSolution').mockImplementation((input) => {
			const refined = tweakSolution(input)
			// A refinement that moved the solution by 50 pixels and verifies badly.
			return { solution: { wcs: { ...refined.solution.wcs, crpix1: refined.solution.wcs.crpix1 + 50 } }, verification: { ...refined.verification, logOdds: 0 } }
		})

		try {
			const result = await nativePlateSolve(stars, indexesFor(sky, shortSide), { width, height, scale: { lower: scale * 0.9, upper: scale * 1.1 } })
			expect(spy).toHaveBeenCalled()
			expect(result).toBeDefined()
			// The four-star similarity extrapolates to the corners within a few arcseconds; the shifted one is 100" off.
			expectSolution(result!.header, truth, width, height, 15 * ASEC2RAD)
		} finally {
			spy.mockRestore()
		}
	})

	test('hypotheses of indexes sharing an id are tried for each index', async () => {
		const truth = wcsOf(ra, dec, scale, 2.2, 'NORMAL', width, height)
		const stars = detect(sky, truth, { seed: 14, width, height, limit: 13 })
		const [real] = indexesFor(sky, shortSide, [0.2])
		// Same quads and id, but no reference stars: every hypothesis it produces fails verification.
		const empty: QuadIndex = {
			id: real.id,
			scaleLower: real.scaleLower,
			scaleUpper: real.scaleUpper,
			jitter: real.jitter,
			epoch: real.epoch,
			cellSize: real.cellSize,
			searchCodes: real.searchCodes,
			quadStars: real.quadStars,
			starVector: real.starVector,
			starSweep: real.starSweep,
			starsInCone: () => {},
			[Symbol.dispose]: () => {},
		}
		expect(empty.id).toBe(real.id)
		const result = await nativePlateSolve(stars, [empty, real], { width, height, scale: { lower: scale * 0.9, upper: scale * 1.1 }, sipOrder: 0 })
		expect(result?.indexId).toBe(real.id)
		expectSolution(result!.header, truth, width, height)
	})

	test('a field from another sky does not solve', async () => {
		const other = syntheticSky(99, ra, dec, 2 * DEG2RAD, 400)
		const truth = wcsOf(ra, dec, scale, 0.3, 'NORMAL', width, height)
		const stars = detect(other, truth, { seed: 8, width, height, limit: 13 })
		const result = await nativePlateSolve(stars, indexesFor(sky, shortSide), { width, height, scale: { lower: scale * 0.9, upper: scale * 1.1 } })
		expect(result).toBeUndefined()
	})

	test('aborts with a PlateSolveError', async () => {
		const truth = wcsOf(ra, dec, scale, 0.3, 'NORMAL', width, height)
		const stars = detect(sky, truth, { seed: 9, width, height, limit: 13 })
		const controller = new AbortController()
		controller.abort()
		await expect(nativePlateSolve(stars, indexesFor(sky, shortSide), { width, height }, controller.signal)).rejects.toMatchObject({ code: 'aborted' })
	})

	test('nearby tiling of a wide hint at a pole stays bounded', async () => {
		for (const declination of [Math.PI / 2, deg(89.9), -Math.PI / 2]) {
			let queries = 0
			const catalog = {
				queryCone: () => {
					queries++
					return []
				},
			} as unknown as StarCatalog

			const started = performance.now()
			const result = await nativeNearbyPlateSolve([], catalog, { width, height, rightAscension: 1, declination, radius: 5 * DEG2RAD, scale: { lower: scale * 0.9, upper: scale * 1.1 } })
			expect(result).toBeUndefined()
			// About 100 field-sized positions cover a 5° cap, tried at three densities.
			expect(queries).toBeGreaterThan(100)
			expect(queries).toBeLessThan(1500)
			expect(performance.now() - started).toBeLessThan(20000)
		}
	})

	test('nearby over a star catalog', async () => {
		const entries: StarCatalogEntry[] = []
		for (let i = 0; i < sky.magnitudes.length; i++) {
			const [r, d] = eraC2s(sky.vectors[i * 3], sky.vectors[i * 3 + 1], sky.vectors[i * 3 + 2])
			entries.push({ rightAscension: r, declination: d, magnitude: sky.magnitudes[i] })
		}

		const catalog = {
			queryCone: (r: number, d: number, radius: number) => entries.filter((entry) => vecAngleUnit(eraS2c(entry.rightAscension, entry.declination), eraS2c(r, d)) <= radius),
		} as unknown as StarCatalog

		const vectors = await catalogStarVectors(catalog, { center: eraS2c(ra, dec), radius: 0.1 * DEG2RAD })
		expect(vectors.length).toBeGreaterThan(0)

		const truth = wcsOf(ra + 0.002, dec, scale, 4, 'FLIPPED', width, height)
		const stars = detect(sky, truth, { seed: 10, width, height, limit: 13, missing: 0.1 })
		const result = await nativeNearbyPlateSolve(stars, catalog, { width, height, rightAscension: ra, declination: dec, radius: 0.5 * DEG2RAD, scale: { lower: scale * 0.95, upper: scale * 1.05 } })
		expect(result).toBeDefined()
		expectSolution(result!.header, truth, width, height)
	})
})

test('real image near a hint over the HNSKY g14 catalog', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const stars = detectStars(image, { maxStars: 300 })
	const catalog = new HnskyCatalog()
	const archive = new Bun.Archive(await Bun.file('data/HNSKY_g14.tar').arrayBuffer())
	catalog.open(await archive.files(), 'g14')

	const result = await nativeNearbyPlateSolve(stars, catalog, { width: image.metadata.width, height: image.metadata.height, rightAscension: deg(161.0177548315), declination: deg(-59.6022705034), radius: deg(1), scale: { lower: arcsec(2.735 * 0.9), upper: arcsec(2.735 * 1.1) } })

	// ASTAP solves this frame at 10.7345h -59.6022°, 2.7"/px, 110.1° and NORMAL parity (astap.test.ts).
	expect(result).toBeDefined()
	const { solution } = result!
	expect(vecAngleUnit(eraS2c(solution.rightAscension, solution.declination), eraS2c(hour(10.7345), deg(-59.6022)))).toBeLessThan(arcsec(3))
	expect(toArcsec(solution.scale)).toBeCloseTo(2.736, 2)
	expect(toDeg(solution.orientation)).toBeCloseTo(110.1, 1)
	expect(solution.parity).toBe('NORMAL')
	expect(result!.matchCount).toBeGreaterThan(50)
	expect(result!.rms).toBeLessThan(1)
})
