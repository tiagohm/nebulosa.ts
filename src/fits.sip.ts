import { Matrix, QrDecomposition } from './matrix'
import type { NumberArray } from './math'
import { NumberComparator, percentileOf } from './util'
import type { FitsHeader } from './fits'
import { heightKeyword, numericKeyword, widthKeyword } from './fits.util'
import { DEC_TAN, DEC_TAN_SIP, RA_TAN, RA_TAN_SIP } from './fits.wcs'

const MIN_SIP_ORDER = 2
const MAX_SIP_ORDER = 5
const DEFAULT_MAX_ITERATIONS = 5
const DEFAULT_SIGMA_CLIP = 3
const DEFAULT_RECOMMENDED_STAR_RATIO = 2
const DEFAULT_SPATIAL_GRID_SIZE = 2
const DEFAULT_MIN_OCCUPIED_CELLS = 3
const DEFAULT_MIN_OCCUPIED_QUADRANTS = 3
const DEFAULT_MAX_CONDITION_NUMBER = 1e12
const MIN_SCATTER = 1e-12
const SIP_HEADER_KEY_PATTERN = /^(?:A|B|AP|BP)(?:_ORDER|_DMAX|_\d+_\d+)$/

export type SipErrorCode = 'invalidOrder' | 'invalidCoordinate' | 'invalidWeight' | 'invalidOption' | 'insufficientStars' | 'poorSpatialDistribution' | 'singularMatrix' | 'illConditionedFit' | 'excessiveOutlierRejection'
export type SipWeightingMode = 'auto' | 'none' | 'star'
export type SipScatterMode = 'mad' | 'standardDeviation'
export type SipSpatialDistributionMode = 'off' | 'warn' | 'fail'

export interface MatchedStar {
	readonly x: number
	readonly y: number
	readonly xRef: number
	readonly yRef: number
	readonly weight?: number
}

export interface SipFitsHeader {
	readonly crpix1: number
	readonly crpix2: number
	readonly width?: number
	readonly height?: number
}

export interface SipFitOptions {
	readonly order: number
	readonly maxIterations?: number
	readonly sigmaClip?: number
	readonly minStars?: number
	readonly minStarRatio?: number
	readonly requireRecommendedStarCount?: boolean
	readonly weighting?: SipWeightingMode
	readonly scatter?: SipScatterMode
	readonly spatialDistribution?: SipSpatialDistributionMode
	readonly allowPoorDistribution?: boolean
	readonly spatialGridSize?: number
	readonly minOccupiedCells?: number
	readonly minOccupiedQuadrants?: number
	readonly width?: number
	readonly height?: number
	readonly maxConditionNumber?: number
}

export interface SipTerm {
	readonly i: number
	readonly j: number
}

export type SipCoefficientMap = Readonly<Record<string, number>>

export interface SipModel {
	readonly order: number
	readonly A_ORDER: number
	readonly B_ORDER: number
	readonly A: SipCoefficientMap
	readonly B: SipCoefficientMap
	readonly terms: readonly SipTerm[]
}

export interface SipDesignMatrix {
	readonly matrix: Matrix
	readonly terms: readonly SipTerm[]
	readonly residualX: Float64Array
	readonly residualY: Float64Array
	readonly centeredX: Float64Array
	readonly centeredY: Float64Array
}

export interface SipResidual {
	readonly index: number
	readonly x: number
	readonly y: number
	readonly xRef: number
	readonly yRef: number
	readonly dx: number
	readonly dy: number
	readonly predDx: number
	readonly predDy: number
	readonly rx: number
	readonly ry: number
	readonly r: number
	readonly used: boolean
	readonly rejected: boolean
	readonly rejectedIteration?: number
}

export interface SipSpatialDiagnostics {
	readonly checked: boolean
	readonly width?: number
	readonly height?: number
	readonly gridSize?: number
	readonly occupiedCells?: number
	readonly occupiedQuadrants?: number
	readonly minOccupiedCells?: number
	readonly minOccupiedQuadrants?: number
}

export interface SipFitDiagnostics {
	readonly coefficientCount: number
	readonly iterations: number
	readonly scatter: number
	readonly scatterMode: SipScatterMode
	readonly conditionNumber: number
	readonly weighted: boolean
	readonly rawRmsTotal: number
	readonly medianResidual: number
	readonly p90Residual: number
	readonly p95Residual: number
	readonly maxResidual: number
	readonly spatialDistribution?: SipSpatialDiagnostics
	readonly warnings: readonly string[]
}

export interface SipFitResult {
	readonly order: number
	readonly A_ORDER: number
	readonly B_ORDER: number
	readonly A: SipCoefficientMap
	readonly B: SipCoefficientMap
	readonly model: SipModel
	readonly rmsTotal: number
	readonly rmsX: number
	readonly rmsY: number
	readonly inputStarCount: number
	readonly usedStarCount: number
	readonly rejectedStarCount: number
	readonly rejectedStarIndices: readonly number[]
	readonly residuals: readonly SipResidual[]
	readonly diagnostics: SipFitDiagnostics
}

interface PreparedStar {
	readonly index: number
	readonly star: MatchedStar
	readonly u: number
	readonly v: number
	readonly dx: number
	readonly dy: number
	readonly weight: number
}

interface FitState {
	readonly a: Float64Array
	readonly b: Float64Array
	readonly conditionNumber: number
}

interface RuntimeOptions {
	readonly order: number
	readonly maxIterations: number
	readonly sigmaClip: number
	readonly hardMinStars: number
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

function setSipAxisType(header: FitsHeader, key: 'CTYPE1' | 'CTYPE2', tan: string, sip: string) {
	const value = header[key]
	if (typeof value !== 'string') return

	const normalized = value.trim().toUpperCase()
	if (normalized === tan || normalized === sip) header[key] = sip
}

// Evaluates the SIP pixel correction at a measured pixel coordinate.
export function evaluateSipCorrection(x: number, y: number, sipModel: SipModel, wcs: SipFitsHeader | FitsHeader) {
	validateFinite('x', x)
	validateFinite('y', y)
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

function isSipFitsHeader(header: object): header is SipFitsHeader {
	return 'crpix1' in header && 'crpix2' in header
}

function extractSipInputWcsFromFitsHeader(header: SipFitsHeader | FitsHeader): SipFitsHeader {
	if (isSipFitsHeader(header)) return header
	return { crpix1: numericKeyword(header, 'CRPIX1', Number.NaN), crpix2: numericKeyword(header, 'CRPIX2', Number.NaN), width: widthKeyword(header, undefined), height: heightKeyword(header, undefined) }
}

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

function validateSipOrder(order: number) {
	if (!Number.isInteger(order)) throw new SipFitError('invalidOrder', 'SIP order must be an integer')
	if (order < MIN_SIP_ORDER) throw new SipFitError('invalidOrder', `SIP order must be at least ${MIN_SIP_ORDER}`)
	if (order > MAX_SIP_ORDER) throw new SipFitError('invalidOrder', `SIP order greater than ${MAX_SIP_ORDER} is not supported by this fitter`)
	return order
}

function validateSipFitsHeader(wcs: SipFitsHeader) {
	if (!wcs) throw new SipFitError('invalidCoordinate', 'basic WCS is required')

	validateFinite('crpix1', wcs.crpix1)
	validateFinite('crpix2', wcs.crpix2)
	optionalImageSize('width', wcs.width)
	optionalImageSize('height', wcs.height)
}

function validateFinite(name: string, value: number) {
	if (!Number.isFinite(value)) throw new SipFitError('invalidCoordinate', `${name} must be a finite number`)
}

function optionalImageSize(name: string, value: number | undefined) {
	if (value === undefined) return undefined
	if (!Number.isFinite(value) || !(value > 0)) throw new SipFitError('invalidOption', `${name} must be a positive finite number`)
	return value
}

function optionalInteger(name: string, value: number | undefined, defaultValue: number, min: number) {
	if (value === undefined) return defaultValue
	if (!Number.isInteger(value) || value < min) throw new SipFitError('invalidOption', `${name} must be an integer greater than or equal to ${min}`)
	return value
}

function optionalPositiveNumber(name: string, value: number | undefined, defaultValue: number) {
	if (value === undefined) return defaultValue
	if (!Number.isFinite(value) || !(value > 0)) throw new SipFitError('invalidOption', `${name} must be a positive finite number`)
	return value
}

function prepareStars(stars: readonly MatchedStar[], wcs: SipFitsHeader, weighted: boolean) {
	if (!Array.isArray(stars)) throw new SipFitError('insufficientStars', 'matchedStars must be an array')

	const prepared: PreparedStar[] = []

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]

		validateFinite(`stars[${i}].x`, star.x)
		validateFinite(`stars[${i}].y`, star.y)
		validateFinite(`stars[${i}].xRef`, star.xRef)
		validateFinite(`stars[${i}].yRef`, star.yRef)

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

function validateStarCount(stars: number, coefficientCount: number, hardMinStars: number) {
	if (stars <= coefficientCount) {
		throw new SipFitError('insufficientStars', 'SIP fitting requires more stars than coefficients', { stars, coefficients: coefficientCount })
	}

	if (stars < hardMinStars) {
		throw new SipFitError('insufficientStars', 'not enough stars for the configured SIP fit', { stars, minimum: hardMinStars })
	}
}

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

function clampCell(value: number, size: number, gridSize: number) {
	if (value <= 0) return 0
	if (value >= size) return gridSize - 1
	return Math.min(gridSize - 1, Math.floor((value / size) * gridSize))
}

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

function collectUsedIndices(used: readonly boolean[]) {
	const indices: number[] = []
	for (let i = 0; i < used.length; i++) if (used[i]) indices.push(i)
	return indices
}

function writeTermValues(output: NumberArray, offset: number, terms: readonly SipTerm[], u: number, v: number, scale: number = 1) {
	let maxOrder = 0
	for (const term of terms) maxOrder = Math.max(maxOrder, term.i + term.j)
	const powers = termPowers(maxOrder, u, v)

	for (let i = 0; i < terms.length; i++) {
		const term = terms[i]
		output[offset + i] = powers.u[term.i] * powers.v[term.j] * scale
	}
}

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

function rawResidualRms(stars: readonly PreparedStar[]) {
	if (stars.length === 0) return 0

	let sum = 0
	for (const star of stars) sum += star.dx * star.dx + star.dy * star.dy
	return Math.sqrt(sum / stars.length)
}
