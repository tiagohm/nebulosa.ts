import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { coordToPixel } from '../../astronomy/sky/spatial/healpix'
import type { StarCatalog } from '../../catalogs/stars/catalog'
import { ASEC2RAD } from '../../core/constants'
import type { MutVec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { buildQuadBand, type QuadBand, type QuadBandOptions } from './quad.builder'
import type { QuadCode } from './quad.code'
import type { QuadIndex, SkyCone } from './quad.index'
import type { QuadIndexStars } from './quad.index.file'
import { buildKdTree, type KdTree, searchKdTree } from './quad.kdtree'

// In-memory QuadIndex built on demand from a star list or any StarCatalog, by the same band builder the index
// files use. It serves the nearby search over catalogs that hold stars but no quads (ASTAP, HNSKY, UCAC4,
// Stellarium): the cone around the hint is queried once, the positions are carried by proper motion to the
// image epoch when the entries have one, and each requested band is built over the cone. Codes and stars live
// in k-d trees for the code search and the cone queries of the verification. Angles are radians.

// Default positional error assumed for catalog stars, radians (Astrometry.net's index jitter default of 1 arcsec).
export const DEFAULT_EPHEMERAL_INDEX_JITTER = ASEC2RAD

// Options of an ephemeral index.
export interface EphemeralQuadIndexOptions extends Omit<QuadBandOptions, 'region'> {
	// Identifier used in diagnostics.
	readonly id?: string
	// Positional error of the stars, radians.
	readonly jitter?: Angle
	// Epoch of the positions, Julian year.
	readonly epoch?: number
	// Region that receives quads; undefined for every cell holding stars.
	readonly region?: SkyCone
}

// QuadIndex over one band built in memory.
export class EphemeralQuadIndex implements QuadIndex {
	readonly id: string
	readonly scaleLower: Angle
	readonly scaleUpper: Angle
	readonly jitter: Angle
	readonly epoch: number
	readonly coverage?: SkyCone
	readonly cellSize: Angle
	readonly dimquads = 4
	readonly #band: QuadBand
	readonly #codes: KdTree<Float64Array>
	readonly #stars: KdTree<Float64Array>

	// Indexes a built band: a k-d tree over its codes and one over its stars. Defaults: 1 arcsec jitter, epoch 2000.
	constructor(band: QuadBand, options: Pick<EphemeralQuadIndexOptions, 'id' | 'jitter' | 'epoch' | 'region'> = {}) {
		this.#band = band
		this.id = options.id ?? `ephemeral:${band.scaleLower}`
		this.scaleLower = band.scaleLower
		this.scaleUpper = band.scaleUpper
		this.jitter = options.jitter ?? DEFAULT_EPHEMERAL_INDEX_JITTER
		this.epoch = options.epoch ?? 2000
		this.coverage = options.region
		this.cellSize = band.cellSize
		this.#codes = buildKdTree(band.codes, 4)
		this.#stars = buildKdTree(band.stars, 3)
	}

	// Builds a band over unit vectors (3 per star) ordered brightest first.
	static fromVectors(stars: Float64Array, options: EphemeralQuadIndexOptions) {
		return new EphemeralQuadIndex(buildQuadBand(stars, options), options)
	}

	// Number of quads.
	get quadCount() {
		return this.#codes.count
	}

	// Number of reference stars.
	get starCount() {
		return this.#stars.count
	}

	// Visits the quads whose code lies within tolerance of code; the whole band is in memory, so no region applies.
	readonly searchCodes = (code: QuadCode, tolerance: number, visit: (quad: number) => void) => {
		const tree = this.#codes
		searchKdTree(tree, code, tolerance, (position) => visit(tree.indices[position]))
	}

	// Writes the kept-star ids of a quad in canonical A, B, C, D order into out and returns it.
	readonly quadStars = (quad: number, out: Float64Array) => {
		const quads = this.#band.quads
		out[0] = quads[quad * 4]
		out[1] = quads[quad * 4 + 1]
		out[2] = quads[quad * 4 + 2]
		out[3] = quads[quad * 4 + 3]
		return out
	}

	// Writes the unit vector of a kept star into out and returns it.
	readonly starVector = (star: number, out: MutVec3) => {
		const stars = this.#band.stars
		out[0] = stars[star * 3]
		out[1] = stars[star * 3 + 1]
		out[2] = stars[star * 3 + 2]
		return out
	}

	// Brightness rank of a kept star within its uniformization cell.
	readonly starSweep = (star: number) => this.#band.sweeps[star]

	// Visits the kept stars within the cone, in no particular order.
	readonly starsInCone = (cone: SkyCone, visit: (star: number) => void) => {
		const tree = this.#stars
		searchKdTree(tree, cone.center, 2 * Math.sin(Math.min(Math.PI, cone.radius) / 2), (position) => visit(tree.indices[position]))
	};

	// Holds no external resource: the arrays are released with the object.
	[Symbol.dispose]() {}
}

// Queries a catalog cone and returns its stars as unit vectors (3 per star) ordered brightest first, carried
// linearly by proper motion from each entry's epoch to epoch (Julian year) when both are known. Entries without
// a magnitude sort last.
export async function catalogStarVectors(catalog: StarCatalog, cone: SkyCone, epoch?: number) {
	return (await catalogQuadIndexStars(catalog, cone, { epoch })).vectors
}

// Options of catalogQuadIndexStars.
export interface CatalogQuadIndexStarsOptions {
	// Epoch the positions are carried to by proper motion, Julian year; undefined uses the first entry's epoch.
	readonly epoch?: number
	// Faintest magnitude streamed; entries without a magnitude are then left out.
	readonly magnitudeMax?: number
	// NSIDE of the cells that bound the stars kept, with perCell.
	readonly nside?: number
	// Brightest stars kept per cell of nside; undefined keeps every star.
	readonly perCell?: number
}

// Stars of a catalog cone for building quads, with their epoch.
export interface CatalogQuadIndexStars extends QuadIndexStars {
	// Magnitude of each star, NaN when the catalog has none.
	readonly magnitudes: Float64Array
	// Epoch the positions were carried to, Julian year: the requested one, else the first entry's; undefined when no
	// entry states one. Entries without proper motion or epoch stay where the catalog puts them.
	readonly epoch?: number
}

// One streamed catalog star kept for the result.
interface KeptStar {
	readonly magnitude: number
	readonly ra: Angle
	readonly dec: Angle
	readonly pmRA: number
	readonly pmDEC: number
}

// Orders kept stars brightest first; the sort is stable, so equal magnitudes keep the catalog order.
function KeptStarComparator(a: KeptStar, b: KeptStar) {
	return a.magnitude === b.magnitude ? 0 : a.magnitude - b.magnitude
}

// Streams a catalog cone into the stars of a quad index (quadIndexTilesFromBand, buildQuadIndexTile): unit vectors
// brightest first with their magnitudes, and their proper motions (dα/dt, dδ/dt, radians per year) when any entry has
// one. Positions are carried by proper motion to one epoch, the requested one or else the first entry's, so a catalog
// whose entries have different epochs gives positions of a single epoch. With nside and perCell only the brightest
// perCell stars of each HEALPix cell are kept as the stream goes, so a cone as wide as the whole sky needs memory for the
// kept stars only. Entries without a magnitude sort last.
export async function catalogQuadIndexStars(catalog: StarCatalog, cone: SkyCone, options: CatalogQuadIndexStarsOptions = {}): Promise<CatalogQuadIndexStars> {
	const { nside, perCell, magnitudeMax } = options
	const [centerRA, centerDEC] = eraC2s(cone.center[0], cone.center[1], cone.center[2])
	const bounded = nside !== undefined && perCell !== undefined && perCell > 0
	const byCell = new Map<number, KeptStar[]>()
	let epoch = options.epoch
	let moving = false

	for await (const entry of catalog.streamRegion({ kind: 'cone', centerRA, centerDEC, radius: Math.min(Math.PI, cone.radius), magnitudeMax })) {
		epoch ??= entry.epoch
		let ra = entry.rightAscension
		let dec = entry.declination

		if (epoch !== undefined && entry.epoch !== undefined) {
			const years = epoch - entry.epoch
			if (entry.pmRA !== undefined) ra += entry.pmRA * years
			if (entry.pmDEC !== undefined) dec += entry.pmDEC * years
		}

		if (entry.pmRA !== undefined || entry.pmDEC !== undefined) moving = true
		const star: KeptStar = { magnitude: entry.magnitude ?? Infinity, ra, dec, pmRA: entry.pmRA ?? 0, pmDEC: entry.pmDEC ?? 0 }
		const cell = bounded ? coordToPixel(nside, ra, dec) : 0
		let list = byCell.get(cell)
		if (list === undefined) byCell.set(cell, (list = []))
		list.push(star)

		if (bounded && list.length > 4 * perCell) {
			list.sort(KeptStarComparator)
			list.length = perCell
		}
	}

	const kept = [...byCell.values()].flatMap((list) => (bounded ? list.sort(KeptStarComparator).slice(0, perCell) : list))
	kept.sort(KeptStarComparator)

	const n = kept.length
	const vectors = new Float64Array(n * 3)
	const magnitudes = new Float64Array(n)
	const properMotions = moving ? new Float64Array(n * 2) : undefined
	const vector: MutVec3 = [0, 0, 0]

	for (let i = 0; i < n; i++) {
		const star = kept[i]
		eraS2c(star.ra, star.dec, vector)
		vectors.set(vector, i * 3)
		magnitudes[i] = star.magnitude === Infinity ? Number.NaN : star.magnitude

		if (properMotions !== undefined) {
			properMotions[i * 2] = star.pmRA
			properMotions[i * 2 + 1] = star.pmDEC
		}
	}

	return { vectors, magnitudes, properMotions, epoch }
}
