import type { DetectedStar } from '../../imaging/stars/detector'
import type { VerifyField } from './native.verify'
import { insideQuadCircle, type MutQuadCode, quadCode } from './quad.code'

// Field side of the native solver: the detected stars prepared for matching and the enumeration of their quads.
// Stars are ordered brightest first, merged when closer than a pixel and a half, capped, converted to FITS 1-based
// pixels and reordered round-robin over a coarse grid so that a bright cluster cannot fill the first quads
// (Astrometry.net's uniformize.py). Quads are enumerated in depth order, as Astrometry.net's solver does: every
// quad of the first n stars is tried before star n + 1 enters, either as the newest backbone star B or as the
// newest inner star C, so no quad is tried twice and the brightest, most reliable stars decide first; triangles
// (three-star patterns of some Astrometry.net indexes) are enumerated the same way without D. A backbone
// pair is kept only when its length lies in the pixel range of the indexes, and C and D must lie in the circle of
// diameter AB widened by the code tolerance.

// Default maximum number of field stars used.
export const DEFAULT_FIELD_MAX_STARS = 300

// Default number of uniformization bins of the field order.
export const DEFAULT_FIELD_UNIFORMIZE_BINS = 10

// Detections closer than this, pixels, are merged into the brighter one.
const FIELD_MERGE_DISTANCE = 1.5

// Prepared field stars, in test order; x and y are FITS 1-based pixels.
export interface SolverField extends VerifyField {
	// Flux of each star, in the detector's scale.
	readonly flux: Float64Array
	// Index of each star in the caller's detection list.
	readonly sourceIndices: Int32Array
}

// Prepares detections of a width × height image (zero-based centroids) for solving.
export function prepareSolverField(stars: readonly DetectedStar[], width: number, height: number, maxStars: number = DEFAULT_FIELD_MAX_STARS, bins: number = DEFAULT_FIELD_UNIFORMIZE_BINS): SolverField {
	const order = stars.map((_, i) => i).sort((a, b) => stars[b].flux - stars[a].flux || a - b)
	const kept: number[] = []
	const mergeSq = FIELD_MERGE_DISTANCE * FIELD_MERGE_DISTANCE

	for (const i of order) {
		if (kept.length >= maxStars) break
		const star = stars[i]
		if (!Number.isFinite(star.x) || !Number.isFinite(star.y)) continue
		if (kept.some((k) => (stars[k].x - star.x) ** 2 + (stars[k].y - star.y) ** 2 < mergeSq)) continue
		kept.push(i)
	}

	// Round-robin over an nw × nh grid of about `bins` cells, brightest first within each round.
	const nw = Math.max(1, Math.round(Math.sqrt((bins * width) / height)))
	const nh = Math.max(1, Math.round(bins / nw))
	const lists = new Map<number, number[]>()

	for (const i of kept) {
		const bx = Math.max(0, Math.min(nw - 1, Math.floor((stars[i].x * nw) / width)))
		const by = Math.max(0, Math.min(nh - 1, Math.floor((stars[i].y * nh) / height)))
		const bin = by * nw + bx
		const list = lists.get(bin)
		if (list === undefined) lists.set(bin, [i])
		else list.push(i)
	}

	const rank = new Map<number, number>()
	for (const [position, star] of kept.entries()) rank.set(star, position)
	const uniform: number[] = []

	for (let round = 0; uniform.length < kept.length; round++) {
		const roundStars: number[] = []
		for (const list of lists.values()) if (round < list.length) roundStars.push(list[round])
		roundStars.sort((a, b) => rank.get(a)! - rank.get(b)!)
		uniform.push(...roundStars)
	}

	const count = uniform.length
	const x = new Float64Array(count)
	const y = new Float64Array(count)
	const flux = new Float64Array(count)
	const sourceIndices = new Int32Array(count)

	for (let k = 0; k < count; k++) {
		const star = stars[uniform[k]]
		x[k] = star.x + 1
		y[k] = star.y + 1
		flux[k] = star.flux
		sourceIndices[k] = uniform[k]
	}

	return { count, x, y, flux, sourceIndices, width, height }
}

// Receives one field quad: star indices A, B, C, D (D is -1 for a triangle), the backbone length in pixels and the
// code. Returns true to stop the enumeration. The code array is reused between calls.
export type FieldQuadVisitor = (a: number, b: number, c: number, d: number, backbone: number, code: MutQuadCode) => boolean

// Enumerates the quads of a prepared field in depth order, star block by star block.
export class FieldQuadEnumerator {
	readonly #count: number
	readonly #minSq: number
	readonly #maxSq: number
	readonly #slack: number
	// Pair state: 0 unknown, 1 valid backbone, 2 invalid; with cos and sin of the backbone similarity.
	readonly #state: Uint8Array
	readonly #cos: Float64Array
	readonly #sin: Float64Array
	readonly #code: MutQuadCode = quadCode()
	// Number of stars already entered.
	#entered = 0

	// minBackbone and maxBackbone bound |AB| in pixels; tolerance is the code tolerance; size is 4 for quads or 3
	// for triangles, whose D is passed as -1.
	constructor(
		readonly field: SolverField,
		minBackbone: number,
		maxBackbone: number,
		tolerance: number,
		readonly size: 3 | 4 = 4,
	) {
		this.#count = field.count
		this.#minSq = minBackbone * minBackbone
		this.#maxSq = maxBackbone * maxBackbone
		this.#slack = tolerance * (Math.SQRT2 + tolerance)
		this.#state = new Uint8Array(this.#count * this.#count)
		this.#cos = new Float64Array(this.#count * this.#count)
		this.#sin = new Float64Array(this.#count * this.#count)
	}

	// Number of stars entered so far.
	get entered() {
		return this.#entered
	}

	// Whether every star has entered.
	get done() {
		return this.#entered >= this.#count
	}

	// Enters up to `block` more stars, visiting the quads each new star completes. Returns true when visit stopped.
	advance(block: number, visit: FieldQuadVisitor) {
		const end = Math.min(this.#count, this.#entered + block)

		for (let n = this.#entered; n < end; n++) {
			this.#entered = n + 1

			// n as the newest backbone star B.
			for (let a = 0; a < n; a++) {
				if (!this.#backbone(a, n)) continue
				const pair = a * this.#count + n

				for (let c = 0; c < n; c++) {
					if (c === a || !this.#inside(pair, a, c)) continue

					if (this.size === 3) {
						if (visit(a, n, c, -1, Math.sqrt(this.#scaleSq(a, n)), this.#code)) return true
						continue
					}

					const cx = this.#code[0]
					const cy = this.#code[1]

					for (let d = c + 1; d < n; d++) {
						if (d === a || !this.#inside(pair, a, d)) continue
						const code = this.#code
						code[2] = code[0]
						code[3] = code[1]
						code[0] = cx
						code[1] = cy
						if (visit(a, n, c, d, Math.sqrt(this.#scaleSq(a, n)), code)) return true
					}
				}
			}

			// n as the newest inner star C, with an older D.
			for (let b = 1; b < n; b++) {
				for (let a = 0; a < b; a++) {
					if (this.#state[a * this.#count + b] !== 1) continue
					const pair = a * this.#count + b
					if (!this.#inside(pair, a, n)) continue

					if (this.size === 3) {
						if (visit(a, b, n, -1, Math.sqrt(this.#scaleSq(a, b)), this.#code)) return true
						continue
					}

					const cx = this.#code[0]
					const cy = this.#code[1]

					for (let d = 0; d < n; d++) {
						if (d === a || d === b || !this.#inside(pair, a, d)) continue
						const code = this.#code
						code[2] = code[0]
						code[3] = code[1]
						code[0] = cx
						code[1] = cy
						if (visit(a, b, n, d, Math.sqrt(this.#scaleSq(a, b)), code)) return true
					}
				}
			}
		}

		return false
	}

	// Squared length of the pair (a, b), pixels².
	#scaleSq(a: number, b: number) {
		const { x, y } = this.field
		return (x[b] - x[a]) ** 2 + (y[b] - y[a]) ** 2
	}

	// Classifies the pair (a, b), a < b, as a backbone in range and caches its similarity.
	#backbone(a: number, b: number) {
		const pair = a * this.#count + b
		const state = this.#state[pair]
		if (state !== 0) return state === 1

		const { x, y } = this.field
		const abx = x[b] - x[a]
		const aby = y[b] - y[a]
		const scale = abx * abx + aby * aby
		const valid = scale >= this.#minSq && scale <= this.#maxSq
		this.#state[pair] = valid ? 1 : 2

		if (valid) {
			this.#cos[pair] = (aby + abx) / scale
			this.#sin[pair] = (aby - abx) / scale
		}

		return valid
	}

	// Writes the code point of star c relative to the backbone pair into code[0..1] and tells whether it lies in the
	// widened circle of diameter AB.
	#inside(pair: number, a: number, c: number) {
		const { x, y } = this.field
		const cos = this.#cos[pair]
		const sin = this.#sin[pair]
		const acx = x[c] - x[a]
		const acy = y[c] - y[a]
		const px = acx * cos + acy * sin
		const py = -acx * sin + acy * cos
		this.#code[0] = px
		this.#code[1] = py
		return insideQuadCircle(px, py, this.#slack)
	}
}
