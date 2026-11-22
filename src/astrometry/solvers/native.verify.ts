import type { MutVec3, Vec3 } from '../../math/linear-algebra/vec3'
import type { QuadIndex, SkyCone } from './quad.index'

// Bayesian verification of a plate-solution hypothesis, after Astrometry.net's verify.c (BSD-3, re-implemented;
// Lang et al. 2010). The field stars, tested brightest first, are explained either by a reference star of the
// index under a Gaussian positional error or by a uniform background of distractors; the sum of the per-star
// log likelihood ratios against pure background is the log-odds that the hypothesis is right, and its best prefix
// is kept. The variance grows with the distance r from the matched quad, σ² = σ0²·(1 + γ·r²/Q²), because a
// four-star fit extrapolates poorly; a radius of relevance drops the bins where a Gaussian peak can no longer beat
// the background, and the effective area shrinks with them. A reference claimed twice keeps the assignment with
// the larger log-odds. Pixels are FITS 1-based coordinates; distances and variances are in pixels.

// Prior fraction of field stars that are not in the index (Astrometry.net's distractor default).
export const DEFAULT_DISTRACTOR_FRACTION = 0.25

// Log-odds at which a hypothesis is accepted as solved (odds of 1e9).
export const LOG_ODDS_ACCEPT = Math.log(1e9)

// Log-odds above which a hypothesis is refined and verified again (odds of 1e6).
export const LOG_ODDS_TUNE = Math.log(1e6)

// Log-odds below which a hypothesis is abandoned (odds of 1e-100).
export const LOG_ODDS_BAIL = Math.log(1e-100)

// Test-star label: explained by the background.
export const THETA_DISTRACTOR = -1

// Test-star label: its reference was taken by another test star.
export const THETA_CONFLICT = -2

// Test-star label: not evaluated (after the bail-out or outside the radius of relevance).
export const THETA_UNTESTED = -3

// Search radius of the nearest reference, in standard deviations (Astrometry.net uses 5σ).
const MATCH_RADIUS_SIGMAS = 5

// Inputs of the sequential log-odds over prepared lists.
export interface VerifyStarListsInput {
	// Number of test stars, in test order.
	readonly testCount: number
	readonly testX: ArrayLike<number>
	readonly testY: ArrayLike<number>
	// Positional variance of each test star, pixels².
	readonly testSigma2: ArrayLike<number>
	// Number of reference stars, in reference order.
	readonly refCount: number
	readonly refX: ArrayLike<number>
	readonly refY: ArrayLike<number>
	// Effective field area, pixels².
	readonly effectiveArea: number
	// Prior distractor fraction in (0, 1).
	readonly distractorFraction?: number
	// Bail-out log-odds.
	readonly bail?: number
}

// Outcome of the sequential log-odds.
export interface VerifyStarListsResult {
	// Best-prefix log-odds; -Infinity when there is nothing to test.
	readonly logOdds: number
	// Last test position of the best prefix, -1 for none.
	readonly bestIndex: number
	// Per test position: the matched reference index, or a THETA_* label.
	readonly theta: Int32Array
	// Per test position: the log likelihood ratio it added.
	readonly starLogOdds: Float64Array
	// Matches, distractors and conflicts within the best prefix.
	readonly matchCount: number
	readonly distractorCount: number
	readonly conflictCount: number
}

// Log density of the distractor term once mu of nr references are matched.
function logDistractor(distractor: number, mu: number, nr: number, logBackground: number) {
	return Math.log(distractor + ((1 - distractor) * mu) / nr) + logBackground
}

// Runs the sequential log-odds of test stars against reference stars, as Astrometry.net's real_verify_star_lists.
export function verifyStarLists(input: VerifyStarListsInput): VerifyStarListsResult {
	const { testCount, refCount, testX, testY, testSigma2 } = input
	const distractor = input.distractorFraction ?? DEFAULT_DISTRACTOR_FRACTION
	const bail = input.bail ?? LOG_ODDS_BAIL
	const theta = new Int32Array(testCount).fill(THETA_UNTESTED)
	const starLogOdds = new Float64Array(testCount)

	if (testCount === 0 || refCount === 0) return { logOdds: -Infinity, bestIndex: -1, theta, starLogOdds, matchCount: 0, distractorCount: 0, conflictCount: 0 }

	const grid = new PointGrid(input.refX, input.refY, refCount)
	const refOwner = new Int32Array(refCount).fill(-1)
	const refLogForeground = new Float64Array(refCount)
	const logBackground = -Math.log(input.effectiveArea)
	let logOdds = 0
	let best = -Infinity
	let bestIndex = -1
	let mu = 0

	for (let i = 0; i < testCount; i++) {
		const sigma2 = testSigma2[i]
		const logD = logDistractor(distractor, mu, refCount, logBackground)
		const nearest = grid.nearest(testX[i], testY[i], MATCH_RADIUS_SIGMAS * MATCH_RADIUS_SIGMAS * sigma2)
		let logF = -Infinity

		if (nearest >= 0) {
			logF = Math.log((1 - distractor) / (2 * Math.PI * sigma2 * refCount)) - grid.lastDistanceSq / (2 * sigma2)
		}

		if (logF < logD) {
			logF = logD
			theta[i] = THETA_DISTRACTOR
		} else if (refOwner[nearest] !== -1) {
			// The reference is taken: keep the old owner (this star is a distractor) or switch to this star.
			const old = refOwner[nearest]
			let muj = 0
			let j = 0
			for (; j < old; j++) if (theta[j] >= 0) muj++
			let switched = logF + (logDistractor(distractor, muj, refCount, logBackground) - refLogForeground[nearest])
			for (; j < i; j++) {
				if (theta[j] < 0) switched += logDistractor(distractor, muj, refCount, logBackground) - logDistractor(distractor, muj + 1, refCount, logBackground)
				else muj++
			}

			if (switched > logD) {
				theta[old] = THETA_CONFLICT
				theta[i] = nearest
				refOwner[nearest] = i
				refLogForeground[nearest] = logF
				logF = switched
			} else {
				logF = logD
				theta[i] = THETA_CONFLICT
			}
		} else {
			refOwner[nearest] = i
			refLogForeground[nearest] = logF
			theta[i] = nearest
			mu++
		}

		starLogOdds[i] = logF - logBackground
		logOdds += starLogOdds[i]

		if (logOdds > best) {
			best = logOdds
			bestIndex = i
		}

		if (logOdds < bail) break
	}

	let matchCount = 0
	let distractorCount = 0
	let conflictCount = 0

	for (let i = 0; i <= bestIndex; i++) {
		if (theta[i] >= 0) matchCount++
		else if (theta[i] === THETA_DISTRACTOR) distractorCount++
		else if (theta[i] === THETA_CONFLICT) conflictCount++
	}

	return { logOdds: best, bestIndex, theta, starLogOdds, matchCount, distractorCount, conflictCount }
}

// Radius of relevance squared, pixels²: beyond it a Gaussian peak of variance σ0²·(1 + r²/Q²) no longer beats the
// uniform background (Astrometry.net's verify_get_ror2).
export function radiusOfRelevanceSq(quadRadiusSq: number, area: number, distractorFraction: number, refCount: number, sigma2: number) {
	return quadRadiusSq * Math.max(1, (area * (1 - distractorFraction)) / (4 * Math.PI * refCount * sigma2) - 1)
}

// A field of detected stars in FITS pixels, ordered as they should be tested (brightest first, uniformized).
export interface VerifyField {
	readonly count: number
	readonly x: Float64Array
	readonly y: Float64Array
	// Image size, pixels.
	readonly width: number
	readonly height: number
}

// Hypothesis-level inputs of verifyHypothesis.
export interface VerifyHypothesisInput {
	readonly field: VerifyField
	readonly index: QuadIndex
	// Maps a unit vector to its FITS pixel, written to out; false when it cannot.
	readonly project: (v: Vec3, out: [number, number]) => boolean
	// Cone holding the whole image on the sky.
	readonly cone: SkyCone
	// Center of the matched quad, pixels, and its radius squared (|AB|²/4), pixels².
	readonly quadX: number
	readonly quadY: number
	readonly quadRadiusSq: number
	// Weight of the variance growth with distance from the quad, 1 for a fresh hypothesis, 0 for a refined solution.
	readonly gamma: number
	// Base positional variance σ0², pixels².
	readonly sigma2: number
	// Field star indices and index star ids of the quad, left out of the test.
	readonly quadFieldStars?: ArrayLike<number>
	readonly quadIndexStars?: ArrayLike<number>
	// Side of the uniformization bins, pixels.
	readonly binSize: number
	readonly distractorFraction?: number
	readonly bail?: number
}

// Outcome of verifyHypothesis: the log-odds and the matched pairs.
export interface VerifyHypothesisResult extends VerifyStarListsResult {
	// Field star index of each test position.
	readonly testStars: Int32Array
	// Index star id of each reference; tiled indexes use ids above 32 bits, held exactly as doubles.
	readonly refStars: Float64Array
	// Pixel of each reference under the hypothesis.
	readonly refX: Float64Array
	readonly refY: Float64Array
	// Variance of each test position, pixels².
	readonly testSigma2: Float64Array
}

// Scratch buffers; never escape.
const VECTOR: MutVec3 = [0, 0, 0]
const PIXEL: [number, number] = [0, 0]

// Verifies a hypothesis against the reference stars of an index: projects the references that fall in the image,
// orders them by brightness sweep, applies the radius of relevance and runs the sequential log-odds.
export function verifyHypothesis(input: VerifyHypothesisInput): VerifyHypothesisResult {
	const { field, index, gamma, quadX, quadY, quadRadiusSq } = input
	const distractor = input.distractorFraction ?? DEFAULT_DISTRACTOR_FRACTION
	const width = field.width
	const height = field.height
	const excludedRefs = new Set<number>()
	if (input.quadIndexStars) for (let i = 0; i < input.quadIndexStars.length; i++) excludedRefs.add(input.quadIndexStars[i])
	const excludedTests = new Set<number>()
	if (input.quadFieldStars) for (let i = 0; i < input.quadFieldStars.length; i++) excludedTests.add(input.quadFieldStars[i])

	// References inside the image, ordered by sweep then id.
	const refs: { star: number; sweep: number; x: number; y: number }[] = []
	index.starsInCone(input.cone, (star) => {
		if (excludedRefs.has(star)) return
		if (!input.project(index.starVector(star, VECTOR), PIXEL)) return
		const x = PIXEL[0]
		const y = PIXEL[1]
		if (x < 0.5 || y < 0.5 || x > width + 0.5 || y > height + 0.5) return
		refs.push({ star, sweep: index.starSweep(star), x, y })
	})
	refs.sort((a, b) => a.sweep - b.sweep || a.star - b.star)

	// Uniformization bins, at most 100 per axis.
	const nw = Math.max(1, Math.min(100, Math.round(width / input.binSize)))
	const nh = Math.max(1, Math.min(100, Math.round(height / input.binSize)))
	const binOf = (x: number, y: number) => Math.max(0, Math.min(nh - 1, Math.floor(((y - 0.5) * nh) / height))) * nw + Math.max(0, Math.min(nw - 1, Math.floor(((x - 0.5) * nw) / width)))
	const goodBins = new Uint8Array(nw * nh).fill(1)
	let effectiveArea = width * height

	if (gamma > 0) {
		const ror2 = radiusOfRelevanceSq(quadRadiusSq, width * height, distractor, Math.max(1, refs.length), input.sigma2)
		let good = 0

		for (let by = 0; by < nh; by++) {
			for (let bx = 0; bx < nw; bx++) {
				const cx = 0.5 + ((bx + 0.5) * width) / nw
				const cy = 0.5 + ((by + 0.5) * height) / nh
				const inside = (cx - quadX) ** 2 + (cy - quadY) ** 2 < ror2
				goodBins[by * nw + bx] = inside ? 1 : 0
				if (inside) good++
			}
		}

		effectiveArea *= Math.max(1, good) / (nw * nh)
	}

	const keptRefs = refs.filter((ref) => goodBins[binOf(ref.x, ref.y)] === 1)
	const refCount = keptRefs.length
	const refStars = new Float64Array(refCount)
	const refX = new Float64Array(refCount)
	const refY = new Float64Array(refCount)

	for (let i = 0; i < refCount; i++) {
		refStars[i] = keptRefs[i].star
		refX[i] = keptRefs[i].x
		refY[i] = keptRefs[i].y
	}

	// Test stars in good bins, uniformized round-robin over the bins in field order.
	const binLists = new Map<number, number[]>()
	for (let i = 0; i < field.count; i++) {
		if (excludedTests.has(i)) continue
		const bin = binOf(field.x[i], field.y[i])
		if (goodBins[bin] === 0) continue
		const list = binLists.get(bin)
		if (list === undefined) binLists.set(bin, [i])
		else list.push(i)
	}

	const lists = [...binLists.values()].sort((a, b) => a[0] - b[0])
	const order: number[] = []
	for (let round = 0; order.length < field.count; round++) {
		let any = false
		const roundStars: number[] = []
		for (const list of lists) {
			if (round < list.length) {
				roundStars.push(list[round])
				any = true
			}
		}
		if (!any) break
		roundStars.sort((a, b) => a - b)
		order.push(...roundStars)
	}

	const testCount = order.length
	const testStars = Int32Array.from(order)
	const testX = new Float64Array(testCount)
	const testY = new Float64Array(testCount)
	const testSigma2 = new Float64Array(testCount)

	for (let i = 0; i < testCount; i++) {
		const star = testStars[i]
		testX[i] = field.x[star]
		testY[i] = field.y[star]
		const r2 = (testX[i] - quadX) ** 2 + (testY[i] - quadY) ** 2
		testSigma2[i] = input.sigma2 * (1 + (gamma * r2) / quadRadiusSq)
	}

	const result = verifyStarLists({ testCount, testX, testY, testSigma2, refCount, refX, refY, effectiveArea, distractorFraction: distractor, bail: input.bail })
	return { ...result, testStars, refStars, refX, refY, testSigma2 }
}

// Uniform bucket grid over 2D points for nearest-neighbor queries within a radius.
class PointGrid {
	readonly #cell: number
	readonly #nx: number
	readonly #ny: number
	readonly #minX: number
	readonly #minY: number
	readonly #head: Int32Array
	readonly #next: Int32Array
	// Squared distance of the last nearest() hit.
	lastDistanceSq = Infinity

	// Buckets count points (x[i], y[i]), pixels, into cells holding about two points each.
	constructor(
		readonly x: ArrayLike<number>,
		readonly y: ArrayLike<number>,
		readonly count: number,
	) {
		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity

		for (let i = 0; i < count; i++) {
			minX = Math.min(minX, x[i])
			minY = Math.min(minY, y[i])
			maxX = Math.max(maxX, x[i])
			maxY = Math.max(maxY, y[i])
		}

		// About two points per cell.
		const area = Math.max(1, (maxX - minX) * (maxY - minY))
		this.#cell = Math.max(1, Math.sqrt((2 * area) / Math.max(1, count)))
		this.#nx = Math.max(1, Math.ceil((maxX - minX) / this.#cell) + 1)
		this.#ny = Math.max(1, Math.ceil((maxY - minY) / this.#cell) + 1)
		this.#minX = minX
		this.#minY = minY
		this.#head = new Int32Array(this.#nx * this.#ny).fill(-1)
		this.#next = new Int32Array(count)

		for (let i = count - 1; i >= 0; i--) {
			const cell = this.#cellOf(x[i], y[i])
			this.#next[i] = this.#head[cell]
			this.#head[cell] = i
		}
	}

	// Index of the cell holding (x, y), clamped to the grid.
	#cellOf(x: number, y: number) {
		const cx = Math.max(0, Math.min(this.#nx - 1, Math.floor((x - this.#minX) / this.#cell)))
		const cy = Math.max(0, Math.min(this.#ny - 1, Math.floor((y - this.#minY) / this.#cell)))
		return cy * this.#nx + cx
	}

	// Index of the nearest point within sqrt(radiusSq) of (x, y), ties to the lowest index, or -1.
	nearest(x: number, y: number, radiusSq: number) {
		const radius = Math.sqrt(radiusSq)
		const x0 = Math.max(0, Math.floor((x - radius - this.#minX) / this.#cell))
		const x1 = Math.min(this.#nx - 1, Math.floor((x + radius - this.#minX) / this.#cell))
		const y0 = Math.max(0, Math.floor((y - radius - this.#minY) / this.#cell))
		const y1 = Math.min(this.#ny - 1, Math.floor((y + radius - this.#minY) / this.#cell))
		let best = -1
		let bestDistanceSq = radiusSq

		for (let cy = y0; cy <= y1; cy++) {
			for (let cx = x0; cx <= x1; cx++) {
				for (let i = this.#head[cy * this.#nx + cx]; i >= 0; i = this.#next[i]) {
					const distanceSq = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2
					if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && best >= 0 && i < best) || (distanceSq <= bestDistanceSq && best < 0)) {
						best = i
						bestDistanceSq = distanceSq
					}
				}
			}
		}

		this.lastDistanceSq = bestDistanceSq
		return best
	}
}
