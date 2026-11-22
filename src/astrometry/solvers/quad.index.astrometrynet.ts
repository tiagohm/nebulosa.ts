import fs from 'fs'
import { ASEC2RAD, PI } from '../../core/constants'
import { FITS_BLOCK_SIZE as FITS_BLOCK, FITS_HEADER_CARD_SIZE as FITS_CARD, FitsKeywordReader } from '../../io/formats/fits/fits'
import { type MutVec3, vecAngleUnit } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { QuadCode } from './quad.code'
import type { QuadIndex, SkyCone } from './quad.index'
import { mapQuadIndexFile } from './quad.index.file'
import { type KdTree, type KdTreeArray, searchKdTree } from './quad.kdtree'

// Reader of Astrometry.net index files (the 4100 and 5200 series and indexes built by its build-index), served as a
// QuadIndex so that the native solver searches them like its own. An index file is FITS: its primary header holds
// the band of quad sizes (SCALE_L, SCALE_U, radians) and the pattern size (DIMQUADS, 3 for the triangles of the widest
// 4100 indexes, 4 for quads), and binary-table extensions hold, as raw arrays in the byte order of the machine that
// wrote them (checked through the ENDIAN keyword), the quads' star ids, the libkd k-d tree of the codes (unsigned
// 16-bit, with the range that maps them back to code units) and the k-d tree of the stars (unsigned 32-bit unit
// vectors), plus the brightness sweep of each star. libkd stores its points in tree order with the same implicit node
// numbering as quad.kdtree but splits at median values, so the data are searched in place with the stored leaf ends
// (lr): only the bounding box of every node is computed on open. The codes follow Astrometry.net's convention, which quad.code reproduces bit for
// bit. The HDU sizes, tree shapes and leaf ends read from the file are checked before use, so a damaged file throws
// instead of hanging. Positions are taken at J2000.0 unless told otherwise; the jitter is the file's JITTER when it
// states one; angles are radians.

// ENDIAN value of a file written on a little-endian machine.
const LITTLE_ENDIAN = '04:03:02:01'

// Positional error assumed for index stars when the file states none (Astrometry.net's default jitter, 1 arcsec).
export const DEFAULT_ASTROMETRY_NET_INDEX_JITTER = ASEC2RAD

// Default epoch of the star positions of an index, Julian year.
export const DEFAULT_ASTROMETRY_NET_INDEX_EPOCH = 2000

// One HDU of a FITS file: its header cards and the location of its data.
interface FitsUnit {
	// Header values by keyword, the first card of a keyword winning: strings without quotes, numbers as written in
	// decimal, logical values as T or F.
	readonly cards: ReadonlyMap<string, string>
	// Offset of the data from the start of the file, bytes.
	readonly offset: number
	// Size of the data, bytes, without the block padding.
	readonly size: number
}

// ASCII code of '=', the value indicator of a header card in column 9.
const VALUE_INDICATOR = 0x3d

// Walks the HDUs of a FITS file held in bytes, parsing the value cards of each header with the FITS keyword reader.
function readFitsUnits(bytes: Uint8Array): FitsUnit[] {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const reader = new FitsKeywordReader()
	const units: FitsUnit[] = []
	let offset = 0

	while (offset + FITS_BLOCK <= bytes.byteLength) {
		const cards = new Map<string, string>()
		let ended = false

		while (!ended) {
			if (offset + FITS_BLOCK > bytes.byteLength) throw new Error('truncated FITS header')

			for (let card = offset; card < offset + FITS_BLOCK; card += FITS_CARD) {
				const [key, value] = reader.read(buffer, card)
				if (key === 'END') {
					ended = true
					break
				}
				if (bytes[card + 8] === VALUE_INDICATOR && value !== undefined && !cards.has(key)) cards.set(key, typeof value === 'boolean' ? (value ? 'T' : 'F') : String(value))
			}

			offset += FITS_BLOCK
		}

		const naxis = Number(cards.get('NAXIS') ?? 0)
		let size = 0
		if (naxis > 0) {
			size = Math.abs(Number(cards.get('BITPIX') ?? 8)) / 8
			for (let n = 1; n <= naxis; n++) size *= Number(cards.get(`NAXIS${n}`) ?? 0)
		}
		size += Number(cards.get('PCOUNT') ?? 0)
		// A negative or non-integer size would move the walk backwards or nowhere, and it would never end.
		if (!(Number.isSafeInteger(size) && size >= 0)) throw new Error('invalid FITS data size')
		units.push({ cards, offset, size })
		offset += Math.ceil(size / FITS_BLOCK) * FITS_BLOCK
	}

	return units
}

// Options of an Astrometry.net index.
export interface AstrometryNetQuadIndexOptions {
	// Identifier used in diagnostics; defaults to the file's INDEXID.
	readonly id?: string
	// Epoch of the star positions, Julian year.
	readonly epoch?: number
	// Positional error of the stars, radians.
	readonly jitter?: Angle
}

// Typed array constructor of a libkd data type.
function kdArrayType(type: string | undefined): (new (buffer: ArrayBufferLike, offset: number, length: number) => KdTreeArray) & { readonly BYTES_PER_ELEMENT: number } {
	if (type === 'u16') return Uint16Array
	if (type === 'u32') return Uint32Array
	if (type === 'double') return Float64Array
	throw new Error(`unsupported Astrometry.net k-d tree data type ${type}`)
}

// A libkd tree read from an index: its points in place, the range mapping them to external units, and computed boxes.
interface IndexTree {
	// Tree over the stored points, with the leaf ends of the file.
	readonly tree: KdTree
	// External minimum per dimension; external = minval + internal / scale.
	readonly minval: Float64Array
	// Internal units per external unit (isotropic).
	readonly scale: number
}

// QuadIndex over one Astrometry.net index file.
export class AstrometryNetQuadIndex implements QuadIndex {
	readonly id: string
	readonly scaleLower: Angle
	readonly scaleUpper: Angle
	readonly jitter: Angle
	readonly epoch: number
	readonly coverage?: SkyCone
	readonly cellSize: Angle
	readonly dimquads: 3 | 4
	// Index id of the file (INDEXID), for example 4116.
	readonly indexId: number
	readonly #quads: Uint32Array
	readonly #codes: IndexTree
	readonly #stars: IndexTree
	readonly #sweeps: Uint8Array

	// Opens an index file, mapping it privately where the runtime can, else reading it whole (on Windows, or for a file
	// the runtime cannot map, such as a read-only one). Throws on a file that is not an index, has an unsupported or
	// inconsistent layout, or was written on a big-endian machine. A file without the ENDIAN keyword is read as
	// little-endian when its code and star ranges are plausible in that order.
	constructor(
		readonly path: string,
		options: AstrometryNetQuadIndexOptions = {},
	) {
		const bytes = mapQuadIndexFile(path) ?? alignedFileBytes(path)
		const units = readFitsUnits(bytes)
		const primary = units[0]?.cards
		if (primary?.get('AN_FILE') !== 'QUAD') throw new Error(`${path} is not an Astrometry.net index`)
		const endian = primary.get('ENDIAN')
		if (endian !== undefined && endian !== LITTLE_ENDIAN) throw new Error(`${path} was written with an unsupported byte order`)

		// Astrometry.net's quadfile reads a missing DIMQUADS as 4.
		const dimquads = Number(primary.get('DIMQUADS') ?? 4)
		if (dimquads !== 3 && dimquads !== 4) throw new Error(`${path} has unsupported patterns of ${dimquads} stars`)

		// Extensions by the name of their first column.
		const byName = new Map<string, FitsUnit>()
		for (const unit of units.slice(1)) {
			const name = unit.cards.get('TTYPE1')
			if (name !== undefined) byName.set(name, unit)
		}

		// Typed view of the data of the binary table whose first column is name, in place.
		const table = <T extends KdTreeArray | Uint8Array | Int32Array>(name: string, type: new (buffer: ArrayBufferLike, offset: number, length: number) => T, elementSize: number) => {
			const unit = byName.get(name)
			if (unit === undefined) throw new Error(`${path} misses the ${name} table`)
			if (unit.offset + unit.size > bytes.byteLength || unit.size % elementSize !== 0) throw new Error(`${path} has a malformed ${name} table`)
			return new type(bytes.buffer, bytes.byteOffset + unit.offset, unit.size / elementSize)
		}

		// The libkd tree of the codes or the stars: its points in place, its range, and the boxes of its nodes.
		const tree = (name: 'codes' | 'stars'): IndexTree => {
			const header = byName.get(`kdtree_header_${name}`)?.cards
			if (header === undefined) throw new Error(`${path} misses the ${name} k-d tree`)
			if (header.get('ENDIAN') !== undefined && header.get('ENDIAN') !== LITTLE_ENDIAN) throw new Error(`${path} was written with an unsupported byte order`)
			const dimension = Number(header.get('KDT_NDIM'))
			const count = Number(header.get('KDT_NDAT'))
			const nodes = Number(header.get('KDT_NNOD'))
			const type = kdArrayType(header.get('KDT_DATA'))
			const points = table(`kdtree_data_${name}`, type, type.BYTES_PER_ELEMENT)
			// A tree stored as doubles holds external coordinates, as libkd converts no double data: its range, when there
			// is one, only bounds them (with a zero scale), so minval 0 and scale 1.
			const double = type === Float64Array
			const range = double ? Float64Array.from({ length: 2 * dimension + 1 }, (_, i) => (i === 2 * dimension ? 1 : 0)) : table(`kdtree_range_${name}`, Float64Array, 8)
			if (points.length !== count * dimension || range.length < 2 * dimension + 1) throw new Error(`${path} has an inconsistent ${name} k-d tree`)
			if (endian === undefined && !double && !plausibleRange(range, dimension, name)) throw new Error(`${path} was written with an unsupported byte order`)

			// A tree without nodes has no leaf level, so a search would never end.
			const levels = Math.round(Math.log2(nodes + 1))
			if (!(nodes >= 1) || 2 ** levels - 1 !== nodes) throw new Error(`${path} has an unsupported ${name} k-d tree shape`)
			const linear = header.get('KDT_LINL') === 'T'
			const lr = linear || !byName.has(`kdtree_lr_${name}`) ? undefined : table(`kdtree_lr_${name}`, Int32Array, 4)
			if (lr !== undefined && !validLeafEnds(lr, 2 ** (levels - 1), count)) throw new Error(`${path} has an inconsistent ${name} k-d tree`)
			return { tree: libkdTree(points, dimension, count, levels, lr, linear), minval: Float64Array.from(range.subarray(0, dimension)), scale: range[2 * dimension] }
		}

		this.indexId = Number(primary.get('INDEXID') ?? 0)
		this.id = options.id ?? `astrometry.net:${this.indexId}`
		this.scaleLower = Number(primary.get('SCALE_L'))
		this.scaleUpper = Number(primary.get('SCALE_U'))
		this.dimquads = dimquads
		// build-index -j writes the star jitter, arcseconds, into the header of the star tree (util/starkd.c).
		const fileJitter = Number(byName.get('kdtree_header_stars')?.cards.get('JITTER') ?? 0)
		this.jitter = options.jitter ?? (fileJitter > 0 ? fileJitter * ASEC2RAD : DEFAULT_ASTROMETRY_NET_INDEX_JITTER)
		this.epoch = options.epoch ?? DEFAULT_ASTROMETRY_NET_INDEX_EPOCH
		this.#quads = table('quads', Uint32Array, 4)
		this.#codes = tree('codes')
		this.#stars = tree('stars')
		this.#sweeps = table('sweep', Uint8Array, 1)

		if (this.#codes.tree.dimension !== 2 * (dimquads - 2)) throw new Error(`${path} has codes of an unexpected dimension`)
		if (this.#quads.length !== this.#codes.tree.count * dimquads) throw new Error(`${path} has quads and codes of different counts`)
		if (this.#sweeps.length !== this.#stars.tree.count) throw new Error(`${path} has a sweep per star missing`)

		const cutNside = Number(byName.get('kdtree_header_stars')?.cards.get('CUTNSIDE') ?? 0)
		this.cellSize = cutNside > 0 ? Math.sqrt(PI / 3) / cutNside : this.scaleLower
		this.coverage = primary.get('ALLSKY') === 'T' ? undefined : this.#starCoverage()
	}

	// Number of quads (or triangles).
	get quadCount() {
		return this.#codes.tree.count
	}

	// Number of stars.
	get starCount() {
		return this.#stars.tree.count
	}

	// Smallest cap holding every star: their mean direction and the farthest star from it.
	#starCoverage(): SkyCone {
		const center: MutVec3 = [0, 0, 0]
		const v: MutVec3 = [0, 0, 0]
		for (let s = 0; s < this.starCount; s++) {
			this.starVector(s, v)
			center[0] += v[0]
			center[1] += v[1]
			center[2] += v[2]
		}
		const length = Math.hypot(center[0], center[1], center[2])
		center[0] /= length
		center[1] /= length
		center[2] /= length

		let radius = 0
		for (let s = 0; s < this.starCount; s++) radius = Math.max(radius, vecAngleUnit(center, this.starVector(s, v)))
		return { center, radius }
	}

	// Visits the patterns whose code lies within tolerance of code (its first 2·(dimquads − 2) components).
	readonly searchCodes = (code: QuadCode, tolerance: number, visit: (quad: number) => void) => {
		const { tree, minval, scale } = this.#codes
		const query = new Float64Array(tree.dimension)
		for (let d = 0; d < tree.dimension; d++) query[d] = (code[d] - minval[d]) * scale
		searchKdTree(tree, query, tolerance * scale, visit)
	}

	// Writes the star ids of a pattern in canonical order into out and returns it; out[3] is left unchanged for a triangle.
	readonly quadStars = (quad: number, out: Float64Array) => {
		const n = this.dimquads
		for (let i = 0; i < n; i++) out[i] = this.#quads[quad * n + i]
		return out
	}

	// Writes the unit vector of a star into out.
	readonly starVector = (star: number, out: MutVec3) => {
		const { tree, minval, scale } = this.#stars
		const points = tree.points
		const x = minval[0] + points[star * 3] / scale
		const y = minval[1] + points[star * 3 + 1] / scale
		const z = minval[2] + points[star * 3 + 2] / scale
		const length = Math.hypot(x, y, z)
		out[0] = x / length
		out[1] = y / length
		out[2] = z / length
		return out
	}

	// Brightness sweep of a star: its rank in the uniformization, 0 for the brightest of its cell.
	readonly starSweep = (star: number) => this.#sweeps[star]

	// Visits the stars within the cone.
	readonly starsInCone = (cone: SkyCone, visit: (star: number) => void) => {
		const { tree, minval, scale } = this.#stars
		const query = [(cone.center[0] - minval[0]) * scale, (cone.center[1] - minval[1]) * scale, (cone.center[2] - minval[2]) * scale]
		const chord = 2 * Math.sin(Math.min(PI, cone.radius) / 2)
		const v: MutVec3 = [0, 0, 0]
		// The quantization of the stored vectors can move a star across the edge; the exact angle decides.
		searchKdTree(tree, query, chord * scale + 2, (star) => {
			if (vecAngleUnit(this.starVector(star, v), cone.center) <= cone.radius) visit(star)
		})
	};

	// Releases nothing: the file's arrays are owned by this object.
	[Symbol.dispose]() {}
}

// Reads a whole file into bytes whose offset is 8-byte aligned, without copying it again when it already is.
function alignedFileBytes(path: string): Uint8Array {
	const buffer = fs.readFileSync(path)
	return buffer.byteOffset % 8 === 0 ? buffer : new Uint8Array(buffer)
}

// Whether the range of a tree read as little-endian is sensible: finite, with a positive scale, and within the code
// square [-0.21, 1.21] or the unit cube. A file written in the other byte order gives absurd or non-finite values.
function plausibleRange(range: Float64Array, dimension: number, name: 'codes' | 'stars') {
	const limit = name === 'codes' ? 1.25 : 1.0001
	const low = name === 'codes' ? -0.25 : -1.0001
	for (let d = 0; d < 2 * dimension; d++) if (!(range[d] >= low && range[d] <= limit)) return false
	const scale = range[2 * dimension]
	return Number.isFinite(scale) && scale > 0
}

// Whether libkd leaf ends (the last point of each leaf) describe leaves count points split into: one per leaf,
// non-decreasing, within [-1, count - 1] and ending at the last point. Others would read past the points or loop
// over billions of positions.
function validLeafEnds(lr: Int32Array, leaves: number, count: number) {
	if (lr.length !== leaves || lr[leaves - 1] !== count - 1) return false
	let previous = -1
	for (let leaf = 0; leaf < leaves; leaf++) {
		if (lr[leaf] < previous) return false
		previous = lr[leaf]
	}
	return true
}

// Builds a KdTree over the points of a libkd tree, already in tree order: its leaves end where lr says (the last point
// of each leaf), else evenly (KDT_LINL, linear) or by count (Astrometry.net's calculate_R), and every internal node's
// box is the union of its children's. An empty leaf keeps an inverted box, which no search enters.
export function libkdTree(points: KdTreeArray, dimension: number, count: number, levels: number, lr: Int32Array | undefined, linear: boolean): KdTree {
	const nodes = 2 ** levels - 1
	const leaves = 2 ** (levels - 1)
	const firstLeaf = leaves - 1
	const leafEnds = new Int32Array(leaves)

	for (let leaf = 0; leaf < leaves; leaf++) {
		if (lr !== undefined) leafEnds[leaf] = lr[leaf]
		else if (linear) leafEnds[leaf] = Math.floor(((leaf + 1) * count) / leaves) - 1
		else leafEnds[leaf] = countSplitEnd(leaf, count, levels)
	}

	const type = points.constructor as new (length: number) => KdTreeArray
	const lower = new type(nodes * dimension)
	const upper = new type(nodes * dimension)

	for (let leaf = 0; leaf < leaves; leaf++) {
		const box = (firstLeaf + leaf) * dimension
		const first = leaf === 0 ? 0 : leafEnds[leaf - 1] + 1
		const end = leafEnds[leaf] + 1

		for (let d = 0; d < dimension; d++) {
			let min = Infinity
			let max = -Infinity
			for (let p = first; p < end; p++) {
				const value = points[p * dimension + d]
				if (value < min) min = value
				if (value > max) max = value
			}
			lower[box + d] = min === Infinity ? 1 : min
			upper[box + d] = max === -Infinity ? 0 : max
		}
	}

	for (let node = firstLeaf - 1; node >= 0; node--) {
		const box = node * dimension
		const left = (2 * node + 1) * dimension
		const right = (2 * node + 2) * dimension
		for (let d = 0; d < dimension; d++) {
			// An inverted (empty) child adds nothing to the union.
			const leftEmpty = lower[left + d] > upper[left + d]
			const rightEmpty = lower[right + d] > upper[right + d]
			lower[box + d] = leftEmpty ? lower[right + d] : rightEmpty ? lower[left + d] : Math.min(lower[left + d], lower[right + d])
			upper[box + d] = leftEmpty ? upper[right + d] : rightEmpty ? upper[left + d] : Math.max(upper[left + d], upper[right + d])
		}
	}

	return { dimension, count, levels, points, indices: new Uint32Array(0), lower, upper, leafEnds }
}

// Last point of a leaf of a tree split by count, as Astrometry.net's calculate_R: left children get floor(n / 2).
function countSplitEnd(leaf: number, count: number, levels: number) {
	const next = leaf + 1
	if (next === 2 ** (levels - 1)) return count - 1
	let mask = 2 ** (levels - 1)
	let n = count
	let left = 0
	for (let l = 0; l < levels - 1; l++) {
		mask /= 2
		if ((next & mask) !== 0) {
			left += Math.floor(n / 2)
			n = Math.floor((n + 1) / 2)
		} else {
			n = Math.floor(n / 2)
		}
	}
	return left - 1
}
