import { NumberComparator, percentileOf } from '../../core/util'
import { validateFinite } from '../../core/validation'
import type { FitsHeader } from '../../io/formats/fits/fits'
import { heightKeyword, numericKeyword, widthKeyword } from '../../io/formats/fits/util'
import { Matrix, QrDecomposition } from '../../math/linear-algebra/matrix'
import type { NumberArray } from '../../math/numerical/math'
import { DEC_TAN, DEC_TAN_SIP, RA_TAN, RA_TAN_SIP } from './fits.wcs'

// Fits forward SIP (Simple Imaging Polynomial) distortion coefficients from matched measured/reference
// pixel pairs. Solves separable weighted least-squares for the A and B polynomials in centered pixel
// coordinates (u = x − CRPIX1, v = y − CRPIX2) via column-scaled QR, with iterative sigma clipping,
// condition-number and spatial-distribution guards, and rich residual diagnostics. Also writes the
// fitted model back into a FITS header and evaluates/applies the correction. All coordinates are pixels.

// Minimum supported SIP polynomial total order.
const MIN_SIP_ORDER = 2
// Maximum supported SIP polynomial total order.
const MAX_SIP_ORDER = 5
// Default maximum sigma-clipping iterations.
const DEFAULT_MAX_ITERATIONS = 5
// Default sigma-clip threshold in robust-scatter units.
const DEFAULT_SIGMA_CLIP = 3
// Default recommended stars-per-coefficient ratio for a stable fit.
const DEFAULT_RECOMMENDED_STAR_RATIO = 2
// Default spatial occupancy grid side (per axis).
const DEFAULT_SPATIAL_GRID_SIZE = 2
// Default minimum occupied grid cells required for an acceptable distribution.
const DEFAULT_MIN_OCCUPIED_CELLS = 3
// Default minimum occupied image quadrants required for an acceptable distribution.
const DEFAULT_MIN_OCCUPIED_QUADRANTS = 3
// Default maximum acceptable design-matrix condition number.
const DEFAULT_MAX_CONDITION_NUMBER = 1e12
// Scatter values at or below this are treated as effectively zero (converged).
const MIN_SCATTER = 1e-12
// Matches SIP coefficient/order/dmax header keywords for removal before rewriting.
const SIP_HEADER_KEY_PATTERN = /^(?:A|B|AP|BP)(?:_ORDER|_DMAX|_\d+_\d+)$/

// Categorized failure reasons thrown as SipFitError.
export type SipErrorCode = 'invalidOrder' | 'invalidCoordinate' | 'invalidWeight' | 'invalidOption' | 'insufficientStars' | 'poorSpatialDistribution' | 'singularMatrix' | 'illConditionedFit' | 'excessiveOutlierRejection'
// Weighting policy: derive from star weights when present ('auto'), force per-star, or unweighted.
export type SipWeightingMode = 'auto' | 'none' | 'star'
// Robust ('mad') vs classical ('standardDeviation') residual-scatter estimator for sigma clipping.
export type SipScatterMode = 'mad' | 'standardDeviation'
// How a poor spatial distribution is handled: ignored, warned, or treated as a hard failure.
export type SipSpatialDistributionMode = 'off' | 'warn' | 'fail'

// One matched star: measured pixel (x, y), reference pixel (xRef, yRef), and optional fit weight.
export interface MatchedStar {
	readonly x: number
	readonly y: number
	readonly xRef: number
	readonly yRef: number
	readonly weight?: number
}

// Minimal WCS inputs needed for SIP fitting: the reference pixel and optional image size.
export interface SipFitsHeader {
	// Reference pixel x (CRPIX1).
	readonly crpix1: number
	// Reference pixel y (CRPIX2).
	readonly crpix2: number
	// Image width in pixels, used for spatial-distribution checks.
	readonly width?: number
	// Image height in pixels, used for spatial-distribution checks.
	readonly height?: number
}

// Options controlling the SIP fit and its acceptance/robustness guards.
export interface SipFitOptions {
	// Total polynomial order (2..5).
	readonly order: number
	// Maximum sigma-clipping iterations.
	readonly maxIterations?: number
	// Sigma-clip threshold in scatter units.
	readonly sigmaClip?: number
	// Hard minimum star count (defaults to coefficients + 1).
	readonly minStars?: number
	// Recommended stars-per-coefficient ratio.
	readonly minStarRatio?: number
	// Whether to fail (rather than warn) when below the recommended star count.
	readonly requireRecommendedStarCount?: boolean
	// Weighting policy.
	readonly weighting?: SipWeightingMode
	// Residual-scatter estimator.
	readonly scatter?: SipScatterMode
	// Spatial-distribution enforcement policy.
	readonly spatialDistribution?: SipSpatialDistributionMode
	// Convenience flag mapping to 'warn' instead of the default 'fail'.
	readonly allowPoorDistribution?: boolean
	// Occupancy grid side per axis.
	readonly spatialGridSize?: number
	// Minimum occupied grid cells required.
	readonly minOccupiedCells?: number
	// Minimum occupied quadrants required.
	readonly minOccupiedQuadrants?: number
	// Image width in pixels (overrides header width).
	readonly width?: number
	// Image height in pixels (overrides header height).
	readonly height?: number
	// Maximum acceptable design-matrix condition number.
	readonly maxConditionNumber?: number
}

// One SIP polynomial term exponent pair u^i · v^j.
export interface SipTerm {
	readonly i: number
	readonly j: number
}

// Map from coefficient keyword (e.g. 'A_2_0') to its value.
export type SipCoefficientMap = Readonly<Record<string, number>>

// A fitted forward SIP model: per-axis coefficient maps plus the term list and orders.
export interface SipModel {
	readonly order: number
	readonly A_ORDER: number
	readonly B_ORDER: number
	// x-correction polynomial coefficients keyed by 'A_i_j'.
	readonly A: SipCoefficientMap
	// y-correction polynomial coefficients keyed by 'B_i_j'.
	readonly B: SipCoefficientMap
	readonly terms: readonly SipTerm[]
}

// The unweighted least-squares design system for a SIP fit (one row per star).
export interface SipDesignMatrix {
	// Design matrix of term values per star.
	readonly matrix: Matrix
	readonly terms: readonly SipTerm[]
	// Target x corrections (xRef − x).
	readonly residualX: Float64Array
	// Target y corrections (yRef − y).
	readonly residualY: Float64Array
	// Centered pixel x offsets (u).
	readonly centeredX: Float64Array
	// Centered pixel y offsets (v).
	readonly centeredY: Float64Array
}

// Per-star residual record after a fit; all positions and residuals are pixels.
export interface SipResidual {
	// Original index in the input star array.
	readonly index: number
	readonly x: number
	readonly y: number
	readonly xRef: number
	readonly yRef: number
	// Target correction along x (xRef − x).
	readonly dx: number
	// Target correction along y (yRef − y).
	readonly dy: number
	// Model-predicted x correction.
	readonly predDx: number
	// Model-predicted y correction.
	readonly predDy: number
	// x residual (dx − predDx).
	readonly rx: number
	// y residual (dy − predDy).
	readonly ry: number
	// Residual magnitude hypot(rx, ry).
	readonly r: number
	// Whether the star was used in the final fit.
	readonly used: boolean
	// Whether the star was rejected by sigma clipping.
	readonly rejected: boolean
	// Iteration at which the star was rejected, when applicable.
	readonly rejectedIteration?: number
}

// Spatial-distribution check results.
export interface SipSpatialDiagnostics {
	// Whether the check actually ran (needs image size and a non-'off' mode).
	readonly checked: boolean
	readonly width?: number
	readonly height?: number
	readonly gridSize?: number
	readonly occupiedCells?: number
	readonly occupiedQuadrants?: number
	readonly minOccupiedCells?: number
	readonly minOccupiedQuadrants?: number
}

// Diagnostic summary of a completed fit.
export interface SipFitDiagnostics {
	// Number of polynomial coefficients per axis.
	readonly coefficientCount: number
	// Sigma-clipping iterations performed.
	readonly iterations: number
	// Final robust scatter estimate.
	readonly scatter: number
	readonly scatterMode: SipScatterMode
	// Estimated design-matrix condition number.
	readonly conditionNumber: number
	// Whether weighting was applied.
	readonly weighted: boolean
	// Total RMS of the raw (pre-fit) residuals, in pixels.
	readonly rawRmsTotal: number
	// Median used-residual magnitude, in pixels.
	readonly medianResidual: number
	// 90th-percentile used residual, in pixels.
	readonly p90Residual: number
	// 95th-percentile used residual, in pixels.
	readonly p95Residual: number
	// Maximum used residual, in pixels.
	readonly maxResidual: number
	readonly spatialDistribution?: SipSpatialDiagnostics
	readonly warnings: readonly string[]
}

// Complete result of fitSipDistortion: the model, RMS metrics, star accounting, residuals, diagnostics.
export interface SipFitResult {
	readonly order: number
	readonly A_ORDER: number
	readonly B_ORDER: number
	readonly A: SipCoefficientMap
	readonly B: SipCoefficientMap
	readonly model: SipModel
	// Combined RMS residual, in pixels.
	readonly rmsTotal: number
	// x RMS residual, in pixels.
	readonly rmsX: number
	// y RMS residual, in pixels.
	readonly rmsY: number
	// Number of input stars.
	readonly inputStarCount: number
	// Number of stars used in the final fit.
	readonly usedStarCount: number
	// Number of stars rejected by clipping.
	readonly rejectedStarCount: number
	// Indices of rejected stars.
	readonly rejectedStarIndices: readonly number[]
	readonly residuals: readonly SipResidual[]
	readonly diagnostics: SipFitDiagnostics
}

// One input star prepared for fitting: centered pixel coordinates, target deltas, and resolved weight.
interface PreparedStar {
	readonly index: number
	readonly star: MatchedStar
	// Centered pixel x offset (x − CRPIX1).
	readonly u: number
	// Centered pixel y offset (y − CRPIX2).
	readonly v: number
	// Target x correction (xRef − x).
	readonly dx: number
	// Target y correction (yRef − y).
	readonly dy: number
	readonly weight: number
}

// Solved coefficient vectors for the A and B polynomials plus the design condition number.
interface FitState {
	readonly a: Float64Array
	readonly b: Float64Array
	readonly conditionNumber: number
}

// Fully resolved and validated fit options used internally.
interface RuntimeOptions {
	readonly order: number
	readonly maxIterations: number
	readonly sigmaClip: number
	// Hard minimum star count below which the fit fails.
	readonly hardMinStars: number
	// Recommended star count below which a warning (or failure) is raised.
	readonly recommendedMinStars: number
	readonly requireRecommendedStarCount: boolean
	readonly weighted: boolean
	readonly scatter: SipScatterMode
	readonly spatialDistribution: SipSpatialDistributionMode
	readonly spatialGridSize: number
	readonly minOccupiedCells: number
	readonly minOccupiedQuadrants: number
	readonly width?: number
	readonly height?: number
	readonly maxConditionNumber: number
}

// Fits use direct SIP coordinates u = x - CRPIX1 and v = y - CRPIX2. Matrix columns
// are scaled only inside the QR solve and coefficients are unscaled before return.

// Error thrown for any SIP-fit failure, carrying a machine-readable code and optional context details.
export class SipFitError extends Error {
	constructor(
		readonly code: SipErrorCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message)
		this.name = 'SipFitError'
	}
}

// Counts nonlinear SIP polynomial terms for a total polynomial order.
export function countSipTerms(order: number) {
	order = validateSipOrder(order)
	return ((order + 1) * (order + 2)) / 2 - 3
}

// Lists SIP terms in deterministic increasing total degree order.
export function listSipTerms(order: number): readonly SipTerm[] {
	order = validateSipOrder(order)

	const terms: SipTerm[] = []

	for (let degree = 2; degree <= order; degree++) {
		for (let i = degree; i >= 0; i--) {
			terms.push({ i, j: degree - i })
		}
	}

	return terms
}

// Builds the unweighted SIP design matrix and reference residual vectors.
export function buildSipDesignMatrix(stars: readonly MatchedStar[], wcs: SipFitsHeader | FitsHeader, order: number): SipDesignMatrix {
	wcs = extractSipInputWcsFromFitsHeader(wcs)
	validateSipFitsHeader(wcs)
	const terms = listSipTerms(order)
	const prepared = prepareStars(stars, wcs, false)
	const matrix = new Matrix(prepared.length, terms.length)
	const residualX = new Float64Array(prepared.length)
	const residualY = new Float64Array(prepared.length)
	const centeredX = new Float64Array(prepared.length)
	const centeredY = new Float64Array(prepared.length)

	for (let row = 0; row < prepared.length; row++) {
		const star = prepared[row]
		writeTermValues(matrix.data, row * terms.length, terms, star.u, star.v)
		residualX[row] = star.dx
		residualY[row] = star.dy
		centeredX[row] = star.u
		centeredY[row] = star.v
	}

	return { matrix, terms, residualX, residualY, centeredX, centeredY }
}

// Fits a forward SIP distortion model from matched measured/reference pixel pairs.
export function fitSipDistortion(matchedStars: readonly MatchedStar[], wcs: SipFitsHeader | FitsHeader, options: SipFitOptions): SipFitResult {
	wcs = extractSipInputWcsFromFitsHeader(wcs)
	validateSipFitsHeader(wcs)
	const order = validateSipOrder(options.order)
	const terms = listSipTerms(order)
	const coefficientCount = terms.length
	const runtime = normalizeOptions(matchedStars, wcs, options, coefficientCount)
	const prepared = prepareStars(matchedStars, wcs, runtime.weighted)

	validateStarCount(prepared.length, coefficientCount, runtime.hardMinStars)

	const warnings: string[] = []

	if (prepared.length < runtime.recommendedMinStars) {
		const message = `SIP order ${order} has ${coefficientCount} coefficients; ${runtime.recommendedMinStars} stars are recommended for a stable fit`

		if (runtime.requireRecommendedStarCount) {
			throw new SipFitError('insufficientStars', message, { stars: prepared.length, recommended: runtime.recommendedMinStars, coefficients: coefficientCount })
		}

		warnings.push(message)
	}

	const initialSpatial = validateSpatialDistribution(prepared, runtime, warnings)
	const used = new Array<boolean>(prepared.length).fill(true)
	const rejectedIteration = new Int32Array(prepared.length)
	let fit: FitState | undefined
	let scatter = 0
	let iterations = 0

	for (; iterations < runtime.maxIterations; iterations++) {
		const usedIndices = collectUsedIndices(used)
		validateStarCount(usedIndices.length, coefficientCount, runtime.hardMinStars)

		fit = solveSipCoefficients(prepared, usedIndices, terms, runtime)
		const residuals = computeArrayResiduals(prepared, used, terms, fit.a, fit.b)
		const usedResiduals = residuals.filter((residual) => residual.used)
		const scatterStats = residualScatter(usedResiduals, runtime.scatter)
		scatter = scatterStats.scatter

		if (iterations + 1 >= runtime.maxIterations || !(scatter > MIN_SCATTER)) {
			if (iterations + 1 >= runtime.maxIterations && scatter > MIN_SCATTER) {
				const threshold = scatterStats.center + runtime.sigmaClip * scatter
				if (usedResiduals.some((residual) => residual.r > threshold)) warnings.push('sigma clipping reached maxIterations before convergence')
			}

			break
		}

		const threshold = scatterStats.center + runtime.sigmaClip * scatter
		const rejected: number[] = []

		for (let i = 0; i < residuals.length; i++) {
			const residual = residuals[i]
			if (residual.used && residual.r > threshold) rejected.push(i)
		}

		if (rejected.length === 0) break

		const remaining = usedIndices.length - rejected.length

		if (remaining < runtime.hardMinStars) {
			throw new SipFitError('excessiveOutlierRejection', 'sigma clipping would leave too few stars for the SIP fit', { remaining, rejected: rejected.length, minimum: runtime.hardMinStars })
		}

		for (const index of rejected) {
			used[index] = false
			rejectedIteration[index] = iterations + 1
		}
	}

	if (!fit) {
		throw new SipFitError('singularMatrix', 'SIP fit did not produce a solution')
	}

	const usedPrepared = prepared.filter((_, index) => used[index])
	const finalSpatial = validateSpatialDistribution(usedPrepared, runtime, warnings)
	const model = createSipModel(order, terms, fit.a, fit.b)
	const residuals = computeModelResiduals(prepared, used, rejectedIteration, model, wcs)
	const usedResiduals = residuals.filter((residual) => residual.used)
	const rejectedStarIndices = residuals.filter((residual) => residual.rejected).map((residual) => residual.index)
	const rms = residualRms(usedResiduals)
	const sortedResiduals = usedResiduals.map((residual) => residual.r).sort(NumberComparator)
	const rawRmsTotal = rawResidualRms(prepared)

	return {
		order,
		A_ORDER: model.A_ORDER,
		B_ORDER: model.B_ORDER,
		A: model.A,
		B: model.B,
		model,
		rmsTotal: rms.total,
		rmsX: rms.x,
		rmsY: rms.y,
		inputStarCount: matchedStars.length,
		usedStarCount: usedResiduals.length,
		rejectedStarCount: rejectedStarIndices.length,
		rejectedStarIndices,
		residuals,
		diagnostics: {
			coefficientCount,
			iterations: iterations + 1,
			scatter,
			scatterMode: runtime.scatter,
			conditionNumber: fit.conditionNumber,
			weighted: runtime.weighted,
			rawRmsTotal,
			medianResidual: percentileOf(sortedResiduals, 0.5),
			p90Residual: percentileOf(sortedResiduals, 0.9),
			p95Residual: percentileOf(sortedResiduals, 0.95),
			maxResidual: sortedResiduals.at(-1) ?? 0,
			spatialDistribution: finalSpatial ?? initialSpatial,
			warnings,
		},
	}
}

// Inserts forward SIP coefficients into an existing FITS header and removes stale SIP terms.
export function sipModelIntoFitsHeader(sipModel: SipModel, header: FitsHeader) {
	const order = validateSipOrder(sipModel.order)
	const terms = listSipTerms(order)

	for (const key in header) {
		if (SIP_HEADER_KEY_PATTERN.test(key)) delete header[key]
	}

	header.A_ORDER = order
	header.B_ORDER = order

	for (const term of terms) {
		const aKey = `A_${term.i}_${term.j}`
		const bKey = `B_${term.i}_${term.j}`
		const a = sipModel.A[aKey] || 0
		const b = sipModel.B[bKey] || 0

		header[aKey] = a
		header[bKey] = b
	}

	setSipAxisType(header, 'CTYPE1', RA_TAN, RA_TAN_SIP)
	setSipAxisType(header, 'CTYPE2', DEC_TAN, DEC_TAN_SIP)

	return header
}

// Promotes a plain TAN CTYPE to its TAN-SIP form in place, leaving other values untouched.
function setSipAxisType(header: FitsHeader, key: 'CTYPE1' | 'CTYPE2', tan: string, sip: string) {
	const value = header[key]
	if (typeof value !== 'string') return

	const normalized = value.trim().toUpperCase()
	if (normalized === tan || normalized === sip) header[key] = sip
}

// Evaluates the SIP pixel correction at a measured pixel coordinate.
export function evaluateSipCorrection(x: number, y: number, sipModel: SipModel, wcs: SipFitsHeader | FitsHeader) {
	validateFinite(x)
	validateFinite(y)
	wcs = extractSipInputWcsFromFitsHeader(wcs)
	validateSipFitsHeader(wcs)
	const order = validateSipOrder(sipModel.order)
	const u = x - wcs.crpix1
	const v = y - wcs.crpix2
	const terms = sipModel.terms.length === countSipTerms(order) ? sipModel.terms : listSipTerms(order)
	let dx = 0
	let dy = 0
	const powers = termPowers(order, u, v)

	for (const term of terms) {
		const value = powers.u[term.i] * powers.v[term.j]
		dx += (sipModel.A[`A_${term.i}_${term.j}`] ?? 0) * value
		dy += (sipModel.B[`B_${term.i}_${term.j}`] ?? 0) * value
	}

	return { dx, dy } as const
}

// Applies the SIP pixel correction and returns the corrected pixel coordinate.
export function applySipCorrection(x: number, y: number, sipModel: SipModel, wcs: SipFitsHeader | FitsHeader) {
	const correction = evaluateSipCorrection(x, y, sipModel, wcs)
	return { x: x + correction.dx, y: y + correction.dy } as const
}

// Type guard distinguishing a pre-extracted SipFitsHeader from a raw FITS header.
function isSipFitsHeader(header: object): header is SipFitsHeader {
	return 'crpix1' in header && 'crpix2' in header
}

// Normalizes either input form into a SipFitsHeader, reading CRPIX/size keywords from a raw FITS header.
function extractSipInputWcsFromFitsHeader(header: SipFitsHeader | FitsHeader): SipFitsHeader {
	if (isSipFitsHeader(header)) return header
	return { crpix1: numericKeyword(header, 'CRPIX1', Number.NaN), crpix2: numericKeyword(header, 'CRPIX2', Number.NaN), width: widthKeyword(header, undefined), height: heightKeyword(header, undefined) }
}

// Validates and defaults all fit options into RuntimeOptions, deriving the weighting decision and the
// recommended minimum star count from the coefficient count.
function normalizeOptions(matchedStars: readonly MatchedStar[], wcs: SipFitsHeader, options: SipFitOptions, coefficientCount: number): RuntimeOptions {
	const maxIterations = optionalInteger('maxIterations', options.maxIterations, DEFAULT_MAX_ITERATIONS, 1)
	const sigmaClip = optionalPositiveNumber('sigmaClip', options.sigmaClip, DEFAULT_SIGMA_CLIP)
	const minStars = optionalInteger('minStars', options.minStars, coefficientCount + 1, coefficientCount + 1)
	const minStarRatio = optionalPositiveNumber('minStarRatio', options.minStarRatio, DEFAULT_RECOMMENDED_STAR_RATIO)
	const weighting = options.weighting ?? 'auto'
	const scatter = options.scatter ?? 'mad'
	const spatialDistribution = options.spatialDistribution ?? (options.allowPoorDistribution ? 'warn' : 'fail')
	const spatialGridSize = optionalInteger('spatialGridSize', options.spatialGridSize, DEFAULT_SPATIAL_GRID_SIZE, 2)
	const minOccupiedCells = optionalInteger('minOccupiedCells', options.minOccupiedCells, DEFAULT_MIN_OCCUPIED_CELLS, 1)
	const minOccupiedQuadrants = optionalInteger('minOccupiedQuadrants', options.minOccupiedQuadrants, DEFAULT_MIN_OCCUPIED_QUADRANTS, 1)
	const width = optionalImageSize('width', options.width ?? wcs.width)
	const height = optionalImageSize('height', options.height ?? wcs.height)
	const maxConditionNumber = optionalPositiveNumber('maxConditionNumber', options.maxConditionNumber, DEFAULT_MAX_CONDITION_NUMBER)

	if (weighting !== 'auto' && weighting !== 'none' && weighting !== 'star') throw new SipFitError('invalidOption', `unsupported weighting mode: ${weighting}`)
	if (scatter !== 'mad' && scatter !== 'standardDeviation') throw new SipFitError('invalidOption', `unsupported scatter mode: ${scatter}`)
	if (spatialDistribution !== 'off' && spatialDistribution !== 'warn' && spatialDistribution !== 'fail') throw new SipFitError('invalidOption', `unsupported spatial distribution mode: ${spatialDistribution}`)
	if (minStarRatio < 1) throw new SipFitError('invalidOption', 'minStarRatio must be at least 1')

	const weighted = weighting === 'star' || (weighting === 'auto' && matchedStars.some((star) => star.weight !== undefined))
	const recommendedMinStars = Math.ceil(coefficientCount * minStarRatio)

	return {
		order: options.order,
		maxIterations,
		sigmaClip,
		hardMinStars: minStars,
		recommendedMinStars,
		requireRecommendedStarCount: options.requireRecommendedStarCount === true,
		weighted,
		scatter,
		spatialDistribution,
		spatialGridSize,
		minOccupiedCells,
		minOccupiedQuadrants,
		width,
		height,
		maxConditionNumber,
	}
}

// Validates that the SIP order is an integer within [MIN_SIP_ORDER, MAX_SIP_ORDER]; returns it.
function validateSipOrder(order: number) {
	if (!Number.isInteger(order)) throw new SipFitError('invalidOrder', 'SIP order must be an integer')
	if (order < MIN_SIP_ORDER) throw new SipFitError('invalidOrder', `SIP order must be at least ${MIN_SIP_ORDER}`)
	if (order > MAX_SIP_ORDER) throw new SipFitError('invalidOrder', `SIP order greater than ${MAX_SIP_ORDER} is not supported by this fitter`)
	return order
}

// Validates that the WCS has finite reference pixels and valid optional image dimensions.
function validateSipFitsHeader(wcs: SipFitsHeader) {
	if (!wcs) throw new SipFitError('invalidCoordinate', 'basic WCS is required')

	validateFinite(wcs.crpix1)
	validateFinite(wcs.crpix2)
	optionalImageSize('width', wcs.width)
	optionalImageSize('height', wcs.height)
}

// Validates an optional positive-finite image dimension; undefined passes through.
function optionalImageSize(name: string, value: number | undefined) {
	if (value === undefined) return undefined
	if (!Number.isFinite(value) || !(value > 0)) throw new SipFitError('invalidOption', `${name} must be a positive finite number`)
	return value
}

// Returns an optional integer option (>= min) or the default when undefined.
function optionalInteger(name: string, value: number | undefined, defaultValue: number, min: number) {
	if (value === undefined) return defaultValue
	if (!Number.isInteger(value) || value < min) throw new SipFitError('invalidOption', `${name} must be an integer greater than or equal to ${min}`)
	return value
}

// Returns an optional positive-finite number option or the default when undefined.
function optionalPositiveNumber(name: string, value: number | undefined, defaultValue: number) {
	if (value === undefined) return defaultValue
	if (!Number.isFinite(value) || !(value > 0)) throw new SipFitError('invalidOption', `${name} must be a positive finite number`)
	return value
}

// Validates each star and centers it to (u, v) with target deltas and a resolved weight (1 when
// unweighted), producing the PreparedStar list consumed by the solver.
function prepareStars(stars: readonly MatchedStar[], wcs: SipFitsHeader, weighted: boolean) {
	if (!Array.isArray(stars)) throw new SipFitError('insufficientStars', 'matchedStars must be an array')

	const prepared: PreparedStar[] = []

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]

		validateFinite(star.x)
		validateFinite(star.y)
		validateFinite(star.xRef)
		validateFinite(star.yRef)

		if (star.weight !== undefined && (!Number.isFinite(star.weight) || !(star.weight > 0))) {
			throw new SipFitError('invalidWeight', `stars[${i}].weight must be a positive finite number`)
		}

		const u = star.x - wcs.crpix1
		const v = star.y - wcs.crpix2

		prepared.push({
			index: i,
			star,
			u,
			v,
			dx: star.xRef - star.x,
			dy: star.yRef - star.y,
			weight: weighted ? (star.weight ?? 1) : 1,
		})
	}

	return prepared
}

// Throws unless there are strictly more stars than coefficients and at least the hard minimum.
function validateStarCount(stars: number, coefficientCount: number, hardMinStars: number) {
	if (stars <= coefficientCount) {
		throw new SipFitError('insufficientStars', 'SIP fitting requires more stars than coefficients', { stars, coefficients: coefficientCount })
	}

	if (stars < hardMinStars) {
		throw new SipFitError('insufficientStars', 'not enough stars for the configured SIP fit', { stars, minimum: hardMinStars })
	}
}

// Checks that used stars occupy enough grid cells and quadrants; warns or throws per the configured
// mode. Returns the diagnostics, or { checked: false } when the check is disabled or size is unknown.
function validateSpatialDistribution(stars: readonly PreparedStar[], options: RuntimeOptions, warnings: string[]): SipSpatialDiagnostics | undefined {
	if (options.spatialDistribution === 'off') return { checked: false }
	if (options.width === undefined || options.height === undefined) return { checked: false }

	const cells = new Set<number>()
	const quadrants = new Set<number>()

	for (const star of stars) {
		const x = clampCell(star.star.x, options.width, options.spatialGridSize)
		const y = clampCell(star.star.y, options.height, options.spatialGridSize)
		cells.add(y * options.spatialGridSize + x)

		const qx = star.star.x < options.width / 2 ? 0 : 1
		const qy = star.star.y < options.height / 2 ? 0 : 1
		quadrants.add(qy * 2 + qx)
	}

	const diagnostics = {
		checked: true,
		width: options.width,
		height: options.height,
		gridSize: options.spatialGridSize,
		occupiedCells: cells.size,
		occupiedQuadrants: quadrants.size,
		minOccupiedCells: options.minOccupiedCells,
		minOccupiedQuadrants: options.minOccupiedQuadrants,
	}

	if (cells.size >= options.minOccupiedCells && quadrants.size >= options.minOccupiedQuadrants) return diagnostics

	const message = `matched stars are poorly distributed across the image (${cells.size} grid cells and ${quadrants.size} quadrants occupied)`

	if (options.spatialDistribution === 'fail') {
		throw new SipFitError('poorSpatialDistribution', message, diagnostics)
	}

	warnings.push(message)
	return diagnostics
}

// Maps a pixel coordinate to its grid-cell index along one axis, clamped to [0, gridSize − 1].
function clampCell(value: number, size: number, gridSize: number) {
	if (value <= 0) return 0
	if (value >= size) return gridSize - 1
	return Math.min(gridSize - 1, Math.floor((value / size) * gridSize))
}

// Solves the weighted, column-scaled least-squares system for both A and B coefficient vectors via QR,
// guarding against ill-conditioning and rank deficiency, then unscales the coefficients before return.
function solveSipCoefficients(stars: readonly PreparedStar[], usedIndices: readonly number[], terms: readonly SipTerm[], options: RuntimeOptions): FitState {
	const rows = usedIndices.length
	const cols = terms.length
	const matrix = new Matrix(rows, cols)
	const rhsX = new Float64Array(rows)
	const rhsY = new Float64Array(rows)
	const data = matrix.data

	for (let row = 0; row < usedIndices.length; row++) {
		const star = stars[usedIndices[row]]
		const weight = Math.sqrt(star.weight)
		writeTermValues(data, row * cols, terms, star.u, star.v, weight)
		rhsX[row] = star.dx * weight
		rhsY[row] = star.dy * weight
	}

	const scales = scaleColumns(matrix)
	const conditionNumber = estimateConditionNumber(matrix)

	if (!Number.isFinite(conditionNumber) || conditionNumber > options.maxConditionNumber) {
		throw new SipFitError('illConditionedFit', 'SIP design matrix is ill-conditioned', { conditionNumber, maxConditionNumber: options.maxConditionNumber })
	}

	const decomposition = new QrDecomposition(matrix)

	if (!decomposition.isFullRank) {
		throw new SipFitError('singularMatrix', 'SIP design matrix is rank deficient')
	}

	try {
		const scaledA = decomposition.solve(rhsX)
		const scaledB = decomposition.solve(rhsY)
		const a = new Float64Array(cols)
		const b = new Float64Array(cols)

		for (let i = 0; i < cols; i++) {
			a[i] = scaledA[i] / scales[i]
			b[i] = scaledB[i] / scales[i]
		}

		return { a, b, conditionNumber }
	} catch (cause) {
		throw new SipFitError('singularMatrix', 'SIP least-squares solve failed', cause)
	}
}

// Scales each column to unit max-abs magnitude in place, returning the per-column scale factors; throws
// on a zero column. Improves conditioning of the QR solve.
function scaleColumns(matrix: Matrix) {
	const scales = new Float64Array(matrix.cols)
	const data = matrix.data

	for (let col = 0; col < matrix.cols; col++) {
		let scale = 0

		for (let row = 0; row < matrix.rows; row++) {
			scale = Math.max(scale, Math.abs(data[row * matrix.cols + col]))
		}

		if (!(scale > 0)) {
			throw new SipFitError('singularMatrix', 'SIP design matrix has a zero column', { column: col })
		}

		scales[col] = scale

		for (let row = 0; row < matrix.rows; row++) {
			data[row * matrix.cols + col] /= scale
		}
	}

	return scales
}

// Estimates the design matrix's condition number as sqrt(‖AᵀA‖₁ · ‖(AᵀA)⁻¹‖₁); returns +Infinity when
// the Gram matrix is singular.
function estimateConditionNumber(matrix: Matrix) {
	const cols = matrix.cols
	const gram = new Matrix(cols, cols)

	for (let row = 0; row < matrix.rows; row++) {
		const rowOffset = row * cols

		for (let i = 0; i < cols; i++) {
			const a = matrix.data[rowOffset + i]
			if (a === 0) continue

			for (let j = 0; j < cols; j++) {
				gram.data[i * cols + j] += a * matrix.data[rowOffset + j]
			}
		}
	}

	try {
		const inverse = gram.invert()
		const cond = norm1(gram) * norm1(inverse)
		return Math.sqrt(cond)
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

// Returns the 1-norm (maximum absolute column sum) of a matrix.
function norm1(matrix: Matrix) {
	let norm = 0

	for (let col = 0; col < matrix.cols; col++) {
		let sum = 0

		for (let row = 0; row < matrix.rows; row++) {
			sum += Math.abs(matrix.data[row * matrix.cols + col])
		}

		norm = Math.max(norm, sum)
	}

	return norm
}

// Collects the indices currently flagged as used (not yet sigma-clipped).
function collectUsedIndices(used: readonly boolean[]) {
	const indices: number[] = []
	for (let i = 0; i < used.length; i++) if (used[i]) indices.push(i)
	return indices
}

// Writes one design-matrix row: each term's u^i·v^j value (optionally times a row weight) at offset.
function writeTermValues(output: NumberArray, offset: number, terms: readonly SipTerm[], u: number, v: number, scale: number = 1) {
	let maxOrder = 0
	for (const term of terms) maxOrder = Math.max(maxOrder, term.i + term.j)
	const powers = termPowers(maxOrder, u, v)

	for (let i = 0; i < terms.length; i++) {
		const term = terms[i]
		output[offset + i] = powers.u[term.i] * powers.v[term.j] * scale
	}
}

// Precomputes the power tables [u^0..u^order] and [v^0..v^order] for fast term evaluation.
function termPowers(order: number, u: number, v: number) {
	const up = new Float64Array(order + 1)
	const vp = new Float64Array(order + 1)

	up[0] = 1
	vp[0] = 1

	for (let i = 1; i <= order; i++) {
		up[i] = up[i - 1] * u
		vp[i] = vp[i - 1] * v
	}

	return { u: up, v: vp }
}

// Assembles a SipModel by keying the solved coefficient vectors into A_i_j / B_i_j maps.
function createSipModel(order: number, terms: readonly SipTerm[], a: Float64Array, b: Float64Array): SipModel {
	const A: Record<string, number> = {}
	const B: Record<string, number> = {}

	for (let i = 0; i < terms.length; i++) {
		const term = terms[i]
		A[`A_${term.i}_${term.j}`] = a[i]
		B[`B_${term.i}_${term.j}`] = b[i]
	}

	return { order, A_ORDER: order, B_ORDER: order, A, B, terms }
}

// Computes per-star residuals from the raw coefficient vectors during the clipping loop (centered-
// coordinate evaluation, cheaper than reconstructing the model each iteration).
function computeArrayResiduals(stars: readonly PreparedStar[], used: readonly boolean[], terms: readonly SipTerm[], a: Float64Array, b: Float64Array) {
	const residuals = new Array<SipResidual>(stars.length)

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		const correction = evaluateArrayCorrection(star.u, star.v, terms, a, b)
		const rx = star.dx - correction.dx
		const ry = star.dy - correction.dy

		residuals[i] = {
			index: star.index,
			x: star.star.x,
			y: star.star.y,
			xRef: star.star.xRef,
			yRef: star.star.yRef,
			dx: star.dx,
			dy: star.dy,
			predDx: correction.dx,
			predDy: correction.dy,
			rx,
			ry,
			r: Math.hypot(rx, ry),
			used: used[i],
			rejected: !used[i],
		}
	}

	return residuals
}

// Computes final per-star residuals from the assembled model, tagging used/rejected status and the
// rejection iteration for diagnostics.
function computeModelResiduals(stars: readonly PreparedStar[], used: readonly boolean[], rejectedIteration: Int32Array, model: SipModel, wcs: SipFitsHeader) {
	const residuals = new Array<SipResidual>(stars.length)

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		const correction = evaluateSipCorrection(star.star.x, star.star.y, model, wcs)
		const rx = star.dx - correction.dx
		const ry = star.dy - correction.dy
		const rejected = !used[i]

		residuals[i] = {
			index: star.index,
			x: star.star.x,
			y: star.star.y,
			xRef: star.star.xRef,
			yRef: star.star.yRef,
			dx: star.dx,
			dy: star.dy,
			predDx: correction.dx,
			predDy: correction.dy,
			rx,
			ry,
			r: Math.hypot(rx, ry),
			used: used[i],
			rejected,
			rejectedIteration: rejected ? rejectedIteration[i] : undefined,
		}
	}

	return residuals
}

// Evaluates the (dx, dy) correction at centered offset (u, v) directly from coefficient vectors.
function evaluateArrayCorrection(u: number, v: number, terms: readonly SipTerm[], a: Float64Array, b: Float64Array) {
	let maxOrder = 0
	for (const term of terms) maxOrder = Math.max(maxOrder, term.i + term.j)
	const powers = termPowers(maxOrder, u, v)
	let dx = 0
	let dy = 0

	for (let i = 0; i < terms.length; i++) {
		const term = terms[i]
		const value = powers.u[term.i] * powers.v[term.j]
		dx += a[i] * value
		dy += b[i] * value
	}

	return { dx, dy }
}

// Estimates the residual center and scatter for sigma clipping. MAD mode returns the median and
// 1.4826·MAD (falling back to std-dev when MAD is ~0); std-dev mode returns the mean and population
// standard deviation.
function residualScatter(residuals: readonly SipResidual[], mode: SipScatterMode) {
	const values = residuals.map((residual) => residual.r).sort((a, b) => a - b)
	if (values.length === 0) return { center: 0, scatter: 0 }

	if (mode === 'standardDeviation') {
		const mean = values.reduce((sum, value) => sum + value, 0) / values.length
		let variance = 0
		for (const value of values) variance += (value - mean) ** 2
		return { center: mean, scatter: Math.sqrt(variance / values.length) } as const
	}

	const center = percentileOf(values, 0.5)
	const deviations = values.map((value) => Math.abs(value - center)).sort((a, b) => a - b)
	let scatter = percentileOf(deviations, 0.5) * 1.4826

	if (!(scatter > MIN_SCATTER)) {
		const mean = values.reduce((sum, value) => sum + value, 0) / values.length
		let variance = 0
		for (const value of values) variance += (value - mean) ** 2
		scatter = Math.sqrt(variance / values.length)
	}

	return { center, scatter } as const
}

// Computes per-axis and combined RMS of the given residuals, in pixels.
function residualRms(residuals: readonly SipResidual[]) {
	if (residuals.length === 0) return { x: 0, y: 0, total: 0 } as const

	let x = 0
	let y = 0

	for (const residual of residuals) {
		x += residual.rx * residual.rx
		y += residual.ry * residual.ry
	}

	return { x: Math.sqrt(x / residuals.length), y: Math.sqrt(y / residuals.length), total: Math.sqrt((x + y) / residuals.length) } as const
}

// Computes the total RMS of the raw target deltas (pre-fit distortion magnitude), in pixels.
function rawResidualRms(stars: readonly PreparedStar[]) {
	if (stars.length === 0) return 0

	let sum = 0
	for (const star of stars) sum += star.dx * star.dx + star.dy * star.dy
	return Math.sqrt(sum / stars.length)
}
