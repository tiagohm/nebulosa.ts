import { eraC2s } from '../../astronomy/coordinates/erfa/erfa'
import { circleToPixels, coordToPixel, pixelToBoundary, pixelToCenter } from '../../astronomy/sky/spatial/healpix'
import { PI } from '../../core/constants'
import { NumberComparator } from '../../core/util'
import { type MutVec3, vecAngleUnit } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { canonicalizeQuadCode, insideQuadCircle, type MutQuadCode, type MutQuadStars, QUAD_STARS, quadCode, skyQuadCode, starCoordinates } from './quad.code'
import type { SkyCone } from './quad.index'
import { buildKdTree, type KdTree, searchKdTree } from './quad.kdtree'

// Builds one band of sky quads from a star list, after the idea of Astrometry.net's uniformize-catalog and
// hpquads (BSD-3, re-implemented): the stars are spread over HEALPix cells about one band-minimum wide, keeping
// the brightest few per cell, and then each cell receives up to one quad per pass, made of the brightest usable
// stars around it, whose backbone AB spans the band and whose AB midpoint lies in the cell. The midpoint rule
// gives every quad exactly one owner cell while its stars may come from neighboring cells, so no quad is lost
// at cell edges. A star joins at most maxReuse quads, loosened to maxLoosenReuse for a cell that found none.
// HEALPix nested ordering needs a power-of-two NSIDE, so the cells are up to twice the band minimum wide and the
// per-cell star and pass counts grow with the cell area to keep the requested density. The result is
// deterministic. Positions are ICRS unit vectors; angles are radians.

// Default number of stars kept per uniformization cell (Astrometry.net's nsweeps).
export const DEFAULT_QUAD_STARS_PER_CELL = 10

// Default number of passes over the cells, each adding at most one quad per cell (Astrometry.net's passes).
export const DEFAULT_QUAD_PASSES = 16

// Default number of quads a star may join (Astrometry.net's Nreuse).
export const DEFAULT_QUAD_MAX_REUSE = 8

// Reuse limit for a cell that found no quad under the default one (Astrometry.net's Nloosen).
export const DEFAULT_QUAD_MAX_LOOSEN_REUSE = 20

// Maximum candidate stars a cell enumerates, brightest first; bounds the O(n⁴) worst case of a crowded cell.
const MAX_CELL_CANDIDATES = 48

// Maximum candidate stars cached per cell, brightest first; the usable ones are taken from them as reuse grows.
const MAX_CACHED_CANDIDATES = 64

// Default largest number of cells built pass after pass over all of them; more are built in groups.
export const DEFAULT_QUAD_MAX_PASS_MAJOR_CELLS = 65536

// Nested HEALPix levels of a cell group: a group is the 4^6 = 4096 cells that share a parent six levels up.
const QUAD_CELL_GROUP_LEVELS = 6

// Options of a band.
export interface QuadBandOptions {
	// Shortest backbone AB, radians.
	readonly scaleLower: Angle
	// Longest backbone AB, radians, above scaleLower.
	readonly scaleUpper: Angle
	// Stars kept per cell of side scaleLower.
	readonly starsPerCell?: number
	// Passes over the cells for cells of side scaleLower.
	readonly passes?: number
	// Quads a star may join.
	readonly maxReuse?: number
	// Reuse limit for a cell that found no quad.
	readonly maxLoosenReuse?: number
	// A star closer than this to a brighter kept star is dropped, radians; 0 keeps all.
	readonly dedup?: Angle
	// Only cells in this cone receive quads; undefined for every cell holding a kept star.
	readonly region?: SkyCone
	// Only these nested cells, at the NSIDE of quadCellNside(scaleLower), receive quads; overrides region.
	readonly cells?: readonly number[]
	// Largest number of cells built pass after pass over all of them; more are built group by group.
	readonly maxPassMajorCells?: number
}

// One built band: the kept stars in brightness order and the quads in creation order.
export interface QuadBand {
	// Shortest backbone AB, radians.
	readonly scaleLower: Angle
	// Longest backbone AB, radians.
	readonly scaleUpper: Angle
	// NSIDE of the uniformization cells.
	readonly nside: number
	// Side of the uniformization cells, radians.
	readonly cellSize: Angle
	// Stars kept per cell and passes, both scaled to the cell size, and the reuse limits and dedup distance (radians) used.
	readonly starsPerCell: number
	readonly passes: number
	readonly maxReuse: number
	readonly maxLoosenReuse: number
	readonly dedup: Angle
	// Unit vectors of the kept stars, 3 per star, brightest first.
	readonly stars: Float64Array
	// Index of each kept star in the input list.
	readonly sourceIndices: Uint32Array
	// Brightness rank of each kept star within its cell, 0 for the brightest.
	readonly sweeps: Uint8Array
	// Kept-star indices of each quad in canonical A, B, C, D order, 4 per quad.
	readonly quads: Uint32Array
	// Canonical code of each quad, 4 per quad.
	readonly codes: Float64Array
}

// NSIDE whose cells are at least size wide: the largest power of two not above sqrt(PI/3)/size.
export function quadCellNside(size: Angle) {
	const exact = Math.sqrt(PI / 3) / size
	return 2 ** Math.max(0, Math.min(24, Math.floor(Math.log2(Math.max(1, exact)))))
}

// Side of a HEALPix cell, radians.
export function healpixCellSize(nside: number) {
	return Math.sqrt(PI / 3) / nside
}

// Builds a band from unit vectors (3 per star) ordered brightest first. stars is not mutated.
export function buildQuadBand(stars: Float64Array, options: QuadBandOptions): QuadBand {
	const { scaleLower, scaleUpper, region, dedup = 0 } = options
	const nside = quadCellNside(scaleLower)
	const cellSize = healpixCellSize(nside)
	// Cells larger than the band minimum hold proportionally more stars and quads.
	const areaRatio = (cellSize / scaleLower) ** 2
	const starsPerCell = Math.max(1, Math.round((options.starsPerCell ?? DEFAULT_QUAD_STARS_PER_CELL) * areaRatio))
	const passes = Math.max(1, Math.round((options.passes ?? DEFAULT_QUAD_PASSES) * areaRatio))
	const maxReuse = options.maxReuse ?? DEFAULT_QUAD_MAX_REUSE
	const maxLoosenReuse = Math.max(maxReuse, options.maxLoosenReuse ?? DEFAULT_QUAD_MAX_LOOSEN_REUSE)

	const kept = uniformizeStars(stars, nside, Math.min(255, starsPerCell), dedup)
	const tree = buildKdTree(kept.stars, 3)
	const cells = options.cells !== undefined ? [...options.cells].sort(NumberComparator) : region === undefined ? kept.cells : circleToPixels(nside, ...eraC2s(...region.center), Math.min(PI, region.radius)).sort(NumberComparator)
	const builder = new CellQuadBuilder(kept.stars, tree, nside, scaleLower, scaleUpper)
	const reuse = new Uint16Array(kept.sourceIndices.length)
	const quads: number[] = []
	const codes: number[] = []

	// Few cells run pass after pass over all of them, as Astrometry.net does. Many cells (a whole-sky band) run the
	// passes group by group of 4^QUAD_CELL_GROUP_LEVELS nested cells, so the candidate caches and the duplicate set
	// stay bounded; a quad duplicated across groups is then possible, and harmless.
	const groupDivisor = cells.length > (options.maxPassMajorCells ?? DEFAULT_QUAD_MAX_PASS_MAJOR_CELLS) ? 4 ** QUAD_CELL_GROUP_LEVELS : Infinity
	let start = 0

	while (start < cells.length) {
		let end = start + 1
		if (groupDivisor !== Infinity) {
			const group = Math.floor(cells[start] / groupDivisor)
			while (end < cells.length && Math.floor(cells[end] / groupDivisor) === group) end++
		} else {
			end = cells.length
		}

		buildCellGroup(builder, cells, start, end, passes, reuse, maxReuse, maxLoosenReuse, quads, codes)
		start = end
	}

	return {
		scaleLower,
		scaleUpper,
		nside,
		cellSize,
		starsPerCell: Math.min(255, starsPerCell),
		passes,
		maxReuse,
		maxLoosenReuse,
		dedup,
		stars: kept.stars,
		sourceIndices: kept.sourceIndices,
		sweeps: kept.sweeps,
		quads: Uint32Array.from(quads),
		codes: Float64Array.from(codes),
	}
}

// Runs the passes over cells[start, end), appending the accepted quads and their codes.
function buildCellGroup(builder: CellQuadBuilder, cells: readonly number[], start: number, end: number, passes: number, reuse: Uint16Array, maxReuse: number, maxLoosenReuse: number, quads: number[], codes: number[]) {
	const seen = new Set<string>()
	const active = new Uint8Array(end - start).fill(1)

	for (let pass = 0; pass < passes; pass++) {
		let any = false

		for (let k = start; k < end; k++) {
			if (active[k - start] === 0) continue

			let found = builder.build(cells[k], reuse, maxReuse, seen)
			if (found === undefined && maxLoosenReuse > maxReuse) found = builder.build(cells[k], reuse, maxLoosenReuse, seen)

			if (found === undefined) {
				// A cell that cannot form a quad now never will: reuse only grows.
				active[k - start] = 0
				builder.release(cells[k])
				continue
			}

			any = true
			for (let i = 0; i < QUAD_STARS; i++) {
				reuse[found.stars[i]]++
				quads.push(found.stars[i])
				codes.push(found.code[i])
			}
		}

		if (!any) break
	}

	for (let k = start; k < end; k++) builder.release(cells[k])
}

// Kept stars of a band.
interface UniformizedStars {
	// Unit vectors of the kept stars, 3 per star, brightest first.
	readonly stars: Float64Array
	// Cells holding at least one kept star, in increasing order.
	readonly cells: number[]
	// Index of each kept star in the input list.
	readonly sourceIndices: Uint32Array
	// Brightness rank of each kept star within its cell.
	readonly sweeps: Uint8Array
}

// Keeps, in brightness order, at most starsPerCell stars per cell and no star within dedup of a kept one.
function uniformizeStars(stars: Float64Array, nside: number, starsPerCell: number, dedup: Angle): UniformizedStars {
	const count = Math.floor(stars.length / 3)
	const perCell = new Map<number, number>()
	const sourceIndices: number[] = []
	const sweeps: number[] = []
	const grid = dedup > 0 ? new DedupGrid(2 * Math.sin(dedup / 2)) : undefined

	for (let i = 0; i < count; i++) {
		const x = stars[i * 3]
		const y = stars[i * 3 + 1]
		const z = stars[i * 3 + 2]
		const [ra, dec] = eraC2s(x, y, z)
		const cell = coordToPixel(nside, ra, dec)
		const used = perCell.get(cell) ?? 0
		if (used >= starsPerCell) continue
		if (grid !== undefined && !grid.add(x, y, z)) continue

		perCell.set(cell, used + 1)
		sourceIndices.push(i)
		sweeps.push(used)
	}

	const kept = new Float64Array(sourceIndices.length * 3)

	for (let k = 0; k < sourceIndices.length; k++) {
		const i = sourceIndices[k]
		kept[k * 3] = stars[i * 3]
		kept[k * 3 + 1] = stars[i * 3 + 1]
		kept[k * 3 + 2] = stars[i * 3 + 2]
	}

	const cells = [...perCell.keys()].sort((a, b) => a - b)
	return { stars: kept, cells, sourceIndices: Uint32Array.from(sourceIndices), sweeps: Uint8Array.from(sweeps) }
}

// Smallest bucket side of DedupGrid: 2/2^17, so that the span³ bucket keys stay exact integers below 2^53 (about 3″).
const DEDUP_MIN_BUCKET = 2 / 2 ** 17

// Spatial hash over unit vectors that refuses a point closer than a chord to an accepted one.
class DedupGrid {
	readonly #buckets = new Map<number, number[]>()
	readonly #size: number
	readonly #chordSq: number
	// Bucket coordinate span per axis: unit vectors lie in [-1, 1].
	readonly #span: number

	// chord is the refusal distance between unit vectors, a positive chord length. The buckets are at least that wide,
	// and never narrower than DEDUP_MIN_BUCKET, since the neighbors searched must cover the chord.
	constructor(readonly chord: number) {
		this.#size = Math.max(chord, DEDUP_MIN_BUCKET)
		this.#chordSq = chord * chord
		this.#span = Math.ceil(2 / this.#size) + 3
	}

	// Accepts and stores the point unless a stored one lies within the chord.
	add(x: number, y: number, z: number) {
		const span = this.#span
		const ix = Math.floor((x + 1) / this.#size) + 1
		const iy = Math.floor((y + 1) / this.#size) + 1
		const iz = Math.floor((z + 1) / this.#size) + 1

		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					const bucket = this.#buckets.get(((ix + dx) * span + iy + dy) * span + iz + dz)
					if (bucket === undefined) continue

					for (let k = 0; k < bucket.length; k += 3) {
						if ((bucket[k] - x) ** 2 + (bucket[k + 1] - y) ** 2 + (bucket[k + 2] - z) ** 2 < this.#chordSq) return false
					}
				}
			}
		}

		const key = (ix * span + iy) * span + iz
		const bucket = this.#buckets.get(key)
		if (bucket === undefined) this.#buckets.set(key, [x, y, z])
		else bucket.push(x, y, z)
		return true
	}
}

// A quad accepted for a cell: kept-star indices and code in canonical order.
interface CellQuad {
	// Kept-star indices in canonical A, B, C, D order.
	readonly stars: MutQuadStars
	// Canonical code.
	readonly code: MutQuadCode
}

// Candidate stars of a cell, cached across passes: kept-star ids brightest first, their tangent-plane positions
// around the cell center, and the backbone state of each pair (0 unknown, 1 valid, 2 invalid).
interface CellCandidates {
	// Kept-star ids, brightest first.
	readonly ids: Uint32Array
	// Tangent-plane position of each candidate around the cell center, radians.
	readonly x: Float64Array
	readonly y: Float64Array
	// Backbone state of each candidate pair (a, b), a < b, at a · ids.length + b.
	readonly pairs: Uint8Array
}

// Finds the first acceptable quad of a cell, enumerating its usable candidate stars brightest first so that every
// quad of the n brightest is tried before the (n + 1)-th star enters. The candidates of a cell are searched and
// projected once and kept until the cell is released.
class CellQuadBuilder {
	readonly #chordLowerSq: number
	readonly #chordUpperSq: number
	readonly #searchMargin: number
	readonly #cache = new Map<number, CellCandidates>()
	// Cache positions of the usable candidates of the current call.
	readonly #usable = new Int32Array(MAX_CELL_CANDIDATES)
	readonly #projected: [number, number] = [0, 0]
	readonly #found: CellQuad = { stars: [0, 0, 0, 0], code: quadCode() }
	readonly #vectors: MutVec3[] = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	]
	// Cell being built.
	#cell = 0
	// Candidates of the cell being built.
	#current: CellCandidates = { ids: new Uint32Array(0), x: new Float64Array(0), y: new Float64Array(0), pairs: new Uint8Array(0) }

	// stars are the kept unit vectors and tree their k-d tree; the band spans [scaleLower, scaleUpper] radians.
	constructor(
		readonly stars: Float64Array,
		readonly tree: KdTree<Float64Array>,
		readonly nside: number,
		readonly scaleLower: Angle,
		readonly scaleUpper: Angle,
	) {
		this.#chordLowerSq = (2 * Math.sin(scaleLower / 2)) ** 2
		this.#chordUpperSq = (2 * Math.sin(scaleUpper / 2)) ** 2
		this.#searchMargin = scaleUpper / 2
	}

	// Drops the cached candidates of a cell that will not be built again.
	release(cell: number) {
		this.#cache.delete(cell)
	}

	// Returns the first new quad of the cell whose stars joined fewer than maxReuse quads, or undefined.
	build(cell: number, reuse: Uint16Array, maxReuse: number, seen: Set<string>) {
		this.#cell = cell
		const candidates = this.#candidatesOf(cell)
		this.#current = candidates
		const usable = this.#usable
		let m = 0

		for (let i = 0; i < candidates.ids.length && m < MAX_CELL_CANDIDATES; i++) {
			if (reuse[candidates.ids[i]] < maxReuse) usable[m++] = i
		}

		if (m < QUAD_STARS) return undefined

		for (let n = 1; n < m; n++) {
			const pn = usable[n]

			// n as the newest backbone star B.
			for (let a = 0; a < n; a++) {
				const pa = usable[a]
				if (!this.#backbone(pa, pn)) continue

				for (let c = 0; c < n; c++) {
					const pc = usable[c]
					if (c === a || !this.#inside(pa, pn, pc)) continue

					for (let d = c + 1; d < n; d++) {
						const pd = usable[d]
						if (d !== a && this.#inside(pa, pn, pd) && this.#accept(pa, pn, pc, pd, seen)) return this.#found
					}
				}
			}

			// n as the newest inner star C, with D older.
			for (let b = 1; b < n; b++) {
				const pb = usable[b]

				for (let a = 0; a < b; a++) {
					const pa = usable[a]
					if (!this.#backbone(pa, pb) || !this.#inside(pa, pb, pn)) continue

					for (let d = 0; d < n; d++) {
						const pd = usable[d]
						if (d !== a && d !== b && this.#inside(pa, pb, pd) && this.#accept(pa, pb, pn, pd, seen)) return this.#found
					}
				}
			}
		}

		return undefined
	}

	// Searches, sorts and projects the candidates of a cell once.
	#candidatesOf(cell: number) {
		const cached = this.#cache.get(cell)
		if (cached !== undefined) return cached

		const [ra, dec] = pixelToCenter(this.nside, cell)
		const center: MutVec3 = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]
		let bound = 0

		for (const [lon, lat] of pixelToBoundary(this.nside, cell)) {
			bound = Math.max(bound, vecAngleUnit(center, [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]))
		}

		const radius = Math.min(PI, 1.01 * (bound + this.#searchMargin))
		const found: number[] = []
		searchKdTree(this.tree, center, 2 * Math.sin(radius / 2), (position) => found.push(this.tree.indices[position]))
		found.sort((a, b) => a - b)
		if (found.length > MAX_CACHED_CANDIDATES) found.length = MAX_CACHED_CANDIDATES

		const m = found.length
		const x = new Float64Array(m)
		const y = new Float64Array(m)

		for (let i = 0; i < m; i++) {
			starCoordinates(this.#vector(0, found[i]), center, this.#projected)
			x[i] = this.#projected[0]
			y[i] = this.#projected[1]
		}

		const candidates: CellCandidates = { ids: Uint32Array.from(found), x, y, pairs: new Uint8Array(m * m) }
		this.#cache.set(cell, candidates)
		return candidates
	}

	// Copies the unit vector of a kept star into scratch slot k and returns it.
	#vector(k: number, star: number) {
		const out = this.#vectors[k]
		out[0] = this.stars[star * 3]
		out[1] = this.stars[star * 3 + 1]
		out[2] = this.stars[star * 3 + 2]
		return out
	}

	// Whether cached candidates a < b form a backbone of the band whose midpoint lies in the current cell.
	#backbone(a: number, b: number) {
		const candidates = this.#current
		const key = a * candidates.ids.length + b
		const state = candidates.pairs[key]
		if (state !== 0) return state === 1

		const stars = this.stars
		const sa = candidates.ids[a] * 3
		const sb = candidates.ids[b] * 3
		const dx = stars[sa] - stars[sb]
		const dy = stars[sa + 1] - stars[sb + 1]
		const dz = stars[sa + 2] - stars[sb + 2]
		const chordSq = dx * dx + dy * dy + dz * dz
		let valid = chordSq >= this.#chordLowerSq && chordSq <= this.#chordUpperSq

		if (valid) {
			const [ra, dec] = eraC2s(stars[sa] + stars[sb], stars[sa + 1] + stars[sb + 1], stars[sa + 2] + stars[sb + 2])
			valid = coordToPixel(this.nside, ra, dec) === this.#cell
		}

		candidates.pairs[key] = valid ? 1 : 2
		return valid
	}

	// Whether cached candidate c lies in the circle whose diameter is the backbone (a, b), on the tangent plane of the cell.
	#inside(a: number, b: number, c: number) {
		const { x, y } = this.#current
		const abx = x[b] - x[a]
		const aby = y[b] - y[a]
		const scale = abx * abx + aby * aby
		const cos = (aby + abx) / scale
		const sin = (aby - abx) / scale
		const acx = x[c] - x[a]
		const acy = y[c] - y[a]
		// A small slack absorbs the tangent-plane approximation; the exact sky code is checked on acceptance.
		return insideQuadCircle(acx * cos + acy * sin, -acx * sin + acy * cos, 1e-3)
	}

	// Computes the exact code of the quad of cached candidates and accepts it when it is valid and new.
	#accept(a: number, b: number, c: number, d: number, seen: Set<string>) {
		const ids = this.#current.ids
		const found = this.#found
		found.stars[0] = ids[a]
		found.stars[1] = ids[b]
		found.stars[2] = ids[c]
		found.stars[3] = ids[d]

		if (!skyQuadCode(this.#vector(0, found.stars[0]), this.#vector(1, found.stars[1]), this.#vector(2, found.stars[2]), this.#vector(3, found.stars[3]), found.code)) return false

		const code = found.code
		if (!insideQuadCircle(code[0], code[1]) || !insideQuadCircle(code[2], code[3])) return false

		const key = [...found.stars].sort((p, q) => p - q).join(',')
		if (seen.has(key)) return false

		canonicalizeQuadCode(code, found.stars)
		seen.add(key)
		return true
	}
}
