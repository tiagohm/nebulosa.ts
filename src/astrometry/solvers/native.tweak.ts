import type { MutVec3, Vec3 } from '../../math/linear-algebra/vec3'
import { evaluateSipCorrection, fitInverseSip, fitSipDistortion, type InverseSipModel, type MatchedStar, SipFitError, type SipModel } from '../wcs/sip.fit'
import type { SolverField } from './native.field'
import { fitLinearTanWcs, type TanWcs, tanPixelToSky, tanSkyToPixel, tanWcsScale } from './native.fit'
import { DEFAULT_DISTRACTOR_FRACTION, verifyHypothesis, type VerifyHypothesisResult } from './native.verify'
import type { QuadIndex, SkyCone } from './quad.index'

// Refinement of an accepted hypothesis over individual stars, after Astrometry.net's tweak2.c (BSD-3,
// re-implemented): the matches come from the verification itself, whose positional variance σ0²·(1 + γ·r²/Q²)
// is annealed with γ = 0.9^k so that the matched region grows from the quad outward while the matching tightens;
// each step weights the pairs by the sigmoid of their log-odds, moves the variance center to their centroid and
// refits the linear TAN WCS with CRPIX fixed at the image center. A SIP distortion of the requested order is then
// fitted on the final pairs, alternating with the linear refit on SIP-corrected pixels, and its reverse
// polynomials are fitted for readers that do not invert the forward ones. As in Astrometry.net's verify_hit, the
// stars of the matched quad never count in the log-odds, since the hypothesis was fitted to them; they join the
// fits as fully weighted pairs. Pixels are FITS 1-based.

// Default number of annealing steps.
export const DEFAULT_TWEAK_STEPS = 20

// Annealing factor of the variance growth per step.
const TWEAK_GAMMA_FACTOR = 0.9

// Alternations of the linear and SIP fits.
const SIP_ITERATIONS = 3

// Log-odds above which a match weighs fully (Astrometry.net's verify_logodds_to_weight).
const FULL_WEIGHT_LOG_ODDS = 40

// Fixed-point iterations of the SIP inversion of projectNativeSolution.
const SIP_INVERSION_ITERATIONS = 20

// Change of both pixel offsets below which the SIP inversion has converged, pixels.
const SIP_INVERSION_TOLERANCE = 1e-6

// A native solution: the linear TAN WCS and an optional SIP distortion with its reverse polynomials.
export interface NativeSolution {
	// Linear TAN WCS, CRPIX at the image center.
	readonly wcs: TanWcs
	// Forward SIP distortion from raw to corrected pixels, relative to the CRPIX of wcs.
	readonly sip?: SipModel
	// Reverse SIP polynomials of sip, when they could be fitted.
	readonly inverseSip?: InverseSipModel
}

// Maps a unit vector to its FITS pixel under a solution, written to out; false on the far hemisphere or when the
// SIP inversion diverges. With a SIP distortion, the raw pixel is found by fixed-point iteration from the linear
// one, stopping when both offsets change by less than SIP_INVERSION_TOLERANCE or after SIP_INVERSION_ITERATIONS
// steps, in which case the last iterate is returned.
export function projectNativeSolution(solution: NativeSolution, v: Vec3, out: [number, number]) {
	if (!tanSkyToPixel(solution.wcs, v, out)) return false
	const { sip, wcs } = solution
	if (sip === undefined) return true

	const U = out[0] - wcs.crpix1
	const V = out[1] - wcs.crpix2
	const header = { crpix1: wcs.crpix1, crpix2: wcs.crpix2 }
	let u = U
	let w = V

	for (let i = 0; i < SIP_INVERSION_ITERATIONS; i++) {
		const { dx, dy } = evaluateSipCorrection(wcs.crpix1 + u, wcs.crpix2 + w, sip, header)
		const nextU = U - dx
		const nextV = V - dy
		if (!Number.isFinite(nextU) || !Number.isFinite(nextV)) return false
		const converged = Math.abs(nextU - u) < SIP_INVERSION_TOLERANCE && Math.abs(nextV - w) < SIP_INVERSION_TOLERANCE
		u = nextU
		w = nextV
		if (converged) break
	}

	out[0] = wcs.crpix1 + u
	out[1] = wcs.crpix2 + w
	return true
}

// Maps a FITS pixel to its unit vector under a solution.
export function unprojectNativeSolution(solution: NativeSolution, x: number, y: number, out: MutVec3 = [0, 0, 0]) {
	const { sip, wcs } = solution
	if (sip === undefined) return tanPixelToSky(wcs, x, y, out)
	const { dx, dy } = evaluateSipCorrection(x, y, sip, { crpix1: wcs.crpix1, crpix2: wcs.crpix2 })
	return tanPixelToSky(wcs, x + dx, y + dy, out)
}

// Cone holding the whole image under a solution, with a 10% margin.
export function nativeSolutionCone(solution: NativeSolution, width: number, height: number): SkyCone {
	const center = unprojectNativeSolution(solution, (width + 1) / 2, (height + 1) / 2)
	return { center, radius: 1.1 * (Math.hypot(width, height) / 2) * tanWcsScale(solution.wcs) }
}

// Inputs of tweakSolution.
export interface TweakInput {
	// Prepared field stars.
	readonly field: SolverField
	// Index of the hypothesis.
	readonly index: QuadIndex
	// Similarity WCS of the accepted hypothesis, referenced at the image center.
	readonly wcs: TanWcs
	// Center of the matched quad, pixels, and its radius squared, pixels².
	readonly quadX: number
	readonly quadY: number
	readonly quadRadiusSq: number
	// Field star indices and index star ids of the matched quad, in the same A, B, C, D order: left out of every
	// verification and added to every fit with full weight.
	readonly quadFieldStars?: ArrayLike<number>
	readonly quadIndexStars?: ArrayLike<number>
	// Centroid error of the field stars, pixels.
	readonly pixelError: number
	// Final SIP order; below 2 keeps the linear WCS.
	readonly sipOrder: number
	// Annealing steps, at least 1; DEFAULT_TWEAK_STEPS when absent.
	readonly steps?: number
	// Prior fraction of field stars missing from the index.
	readonly distractorFraction?: number
}

// A refined solution with its final verification.
export interface TweakResult {
	// Refined solution.
	readonly solution: NativeSolution
	// Verification of the solution without variance growth, the quad stars left out.
	readonly verification: VerifyHypothesisResult
}

// Pairs of a verification: matched field stars and their references, with weights.
interface MatchPairs {
	// Number of pairs.
	readonly count: number
	// FITS pixel of the field star of each pair.
	readonly x: Float64Array
	readonly y: Float64Array
	// ICRS unit vector of the reference of each pair, 3 per pair.
	readonly vectors: Float64Array
	// Weight of each pair in (0, 1].
	readonly weights: Float64Array
}

// Base positional variance of a verification, pixels²: the centroid error and the index jitter at the plate scale.
export function verificationSigma2(pixelError: number, index: QuadIndex, wcs: TanWcs) {
	return pixelError * pixelError + (index.jitter / tanWcsScale(wcs)) ** 2
}

// Runs a verification of a solution with the given variance growth.
function verifySolution(input: TweakInput, solution: NativeSolution, gamma: number, quadX: number, quadY: number) {
	const { field, index } = input
	const scale = tanWcsScale(solution.wcs)
	return verifyHypothesis({
		field,
		index,
		project: (v, out) => projectNativeSolution(solution, v, out),
		cone: nativeSolutionCone(solution, field.width, field.height),
		quadX,
		quadY,
		quadRadiusSq: input.quadRadiusSq,
		gamma,
		sigma2: verificationSigma2(input.pixelError, index, solution.wcs),
		quadFieldStars: input.quadFieldStars,
		quadIndexStars: input.quadIndexStars,
		binSize: index.cellSize / scale,
		distractorFraction: input.distractorFraction ?? DEFAULT_DISTRACTOR_FRACTION,
	})
}

// Collects the matches of the best prefix of a verification, preceded by the quad stars with full weight.
function matchPairs(verification: VerifyHypothesisResult, input: TweakInput): MatchPairs {
	const { field, index, quadFieldStars, quadIndexStars } = input
	const quadCount = quadFieldStars === undefined || quadIndexStars === undefined ? 0 : Math.min(quadFieldStars.length, quadIndexStars.length)
	const limit = verification.bestIndex + 1
	let count = quadCount
	for (let i = 0; i < limit; i++) if (verification.theta[i] >= 0) count++

	const x = new Float64Array(count)
	const y = new Float64Array(count)
	const vectors = new Float64Array(count * 3)
	const weights = new Float64Array(count)
	const vector: MutVec3 = [0, 0, 0]
	let k = 0

	for (; k < quadCount; k++) {
		const star = quadFieldStars![k]
		x[k] = field.x[star]
		y[k] = field.y[star]
		index.starVector(quadIndexStars![k], vector)
		vectors.set(vector, k * 3)
		weights[k] = 1
	}

	for (let i = 0; i < limit; i++) {
		const ref = verification.theta[i]
		if (ref < 0) continue
		const star = verification.testStars[i]
		x[k] = field.x[star]
		y[k] = field.y[star]
		index.starVector(verification.refStars[ref], vector)
		vectors.set(vector, k * 3)
		const odds = verification.starLogOdds[i]
		weights[k] = odds > FULL_WEIGHT_LOG_ODDS ? 1 : 1 / (1 + Math.exp(-odds))
		k++
	}

	return { count, x, y, vectors, weights }
}

// Refines an accepted hypothesis; returns the solution and its final verification without variance growth.
export function tweakSolution(input: TweakInput): TweakResult {
	const { field } = input
	const crpix = [(field.width + 1) / 2, (field.height + 1) / 2] as const
	const steps = Math.max(1, input.steps ?? DEFAULT_TWEAK_STEPS)
	let solution: NativeSolution = { wcs: input.wcs }
	let quadX = input.quadX
	let quadY = input.quadY

	for (let step = 0; step < steps; step++) {
		const gamma = step === steps - 1 ? 0 : TWEAK_GAMMA_FACTOR ** step
		const pairs = matchPairs(verifySolution(input, solution, gamma, quadX, quadY), input)
		if (pairs.count < 3) break

		let sw = 0
		let sx = 0
		let sy = 0
		for (let i = 0; i < pairs.count; i++) {
			sw += pairs.weights[i]
			sx += pairs.weights[i] * pairs.x[i]
			sy += pairs.weights[i] * pairs.y[i]
		}
		quadX = sx / sw
		quadY = sy / sw

		const fit = fitLinearTanWcs(pairs, solution.wcs, crpix)
		if (fit === undefined) break
		solution = { wcs: fit.wcs }
	}

	if (input.sipOrder >= 2) solution = fitSolutionSip(input, solution, crpix)

	return { solution, verification: verifySolution(input, solution, 0, quadX, quadY) }
}

// Alternates the linear fit on SIP-corrected pixels and the SIP fit on the residuals of the linear one.
function fitSolutionSip(input: TweakInput, solution: NativeSolution, crpix: readonly [number, number]): NativeSolution {
	const { field } = input
	const header = { crpix1: crpix[0], crpix2: crpix[1], width: field.width, height: field.height }
	const linear: [number, number] = [0, 0]
	let best = solution

	for (let iteration = 0; iteration < SIP_ITERATIONS; iteration++) {
		const pairs = matchPairs(verifySolution(input, best, 0, crpix[0], crpix[1]), input)
		if (pairs.count < 3) break

		// Linear refit on pixels corrected by the current distortion.
		const corrected = { ...pairs, x: Float64Array.from(pairs.x), y: Float64Array.from(pairs.y) }
		if (best.sip !== undefined) {
			for (let i = 0; i < pairs.count; i++) {
				const { dx, dy } = evaluateSipCorrection(pairs.x[i], pairs.y[i], best.sip, header)
				corrected.x[i] += dx
				corrected.y[i] += dy
			}
		}

		const fit = fitLinearTanWcs(corrected, best.wcs, crpix)
		if (fit === undefined) break

		const stars: MatchedStar[] = []
		for (let i = 0; i < pairs.count; i++) {
			if (!tanSkyToPixel(fit.wcs, [pairs.vectors[i * 3], pairs.vectors[i * 3 + 1], pairs.vectors[i * 3 + 2]], linear)) continue
			stars.push({ x: pairs.x[i], y: pairs.y[i], xRef: linear[0], yRef: linear[1], weight: pairs.weights[i] })
		}

		try {
			const sip = fitSipDistortion(stars, header, { order: input.sipOrder, weighting: 'star', spatialDistribution: 'warn', requireRecommendedStarCount: false })
			best = { wcs: fit.wcs, sip: sip.model }
		} catch (e) {
			if (!(e instanceof SipFitError)) throw e
			// The fit failed for this order. A linear fit made on SIP-corrected pixels is only valid with that SIP,
			// so a later failure keeps the previous solution; a first failure keeps the linear fit of the raw pixels.
			if (best.sip !== undefined) break
			return { wcs: fit.wcs }
		}
	}

	if (best.sip === undefined) return best

	try {
		return { ...best, inverseSip: fitInverseSip(best.sip, header) }
	} catch (e) {
		if (!(e instanceof SipFitError)) throw e
		return best
	}
}
