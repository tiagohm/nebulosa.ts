import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import type { StarCatalog, StarCatalogEntry } from '../../catalogs/stars/catalog'
import { ASEC2RAD } from '../../core/constants'
import type { MutVec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { buildQuadBand, type QuadBand, type QuadBandOptions } from './quad.builder'
import type { QuadCode } from './quad.code'
import type { QuadIndex, SkyCone } from './quad.index'
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
	readonly quadStars = (quad: number, out: Uint32Array) => {
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
	const [ra, dec] = eraC2s(cone.center[0], cone.center[1], cone.center[2])
	const entries = [...(await catalog.queryCone(ra, dec, cone.radius))]
	entries.sort(StarCatalogEntryMagnitudeComparator)
	const vectors = new Float64Array(entries.length * 3)
	const vector: MutVec3 = [0, 0, 0]

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		let rightAscension = entry.rightAscension
		let declination = entry.declination

		if (epoch !== undefined && entry.epoch !== undefined) {
			const years = epoch - entry.epoch
			if (entry.pmRA !== undefined) rightAscension += entry.pmRA * years
			if (entry.pmDEC !== undefined) declination += entry.pmDEC * years
		}

		eraS2c(rightAscension, declination, vector)
		vectors[i * 3] = vector[0]
		vectors[i * 3 + 1] = vector[1]
		vectors[i * 3 + 2] = vector[2]
	}

	return vectors
}

// Orders catalog entries brightest first, entries without a magnitude last.
function StarCatalogEntryMagnitudeComparator(a: StarCatalogEntry, b: StarCatalogEntry) {
	if (a.magnitude === undefined) return b.magnitude === undefined ? 0 : 1
	if (b.magnitude === undefined) return -1
	return a.magnitude - b.magnitude
}
