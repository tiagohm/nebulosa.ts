import { medianAbsoluteDeviationOf, medianOf, percentileOf } from '../../core/util'
import { validateFinite, validatePositiveFinite, validatePositiveInteger } from '../../core/validation'
import { robustLinearLeastSquares, type RobustLinearLeastSquaresResult } from '../../math/numerical/least.squares'
import { goldenSectionSearch } from '../../math/numerical/optimization'
import type { BacklashCompensation, BacklashCompensationMode } from './backlash'

// Deterministic focuser-backlash calibration from caller-supplied positions and scalar measurements.
// The module contains only synchronous numerical fitting and command/event state transitions. Positions,
// movement distances, breakpoints, and uncertainties are focuser steps; metric units are caller-defined.

// Direction of focuser counter travel, independent of driver-specific IN/OUT naming.
export type FocusAxisDirection = 'increasing' | 'decreasing'

// Observable phase of a backlash-calibration run.
export type BacklashCalibrationState = 'idle' | 'preloading' | 'probing' | 'completed' | 'failed' | 'cancelled'

// Typed operational or numerical reason for a failed calibration or directional run.
export type BacklashCalibrationFailureReason = 'invalidEvent' | 'invalidPosition' | 'invalidSample' | 'positionLimit' | 'axisStalled' | 'insufficientSlope' | 'breakpointNotFound' | 'maximumDistanceReached' | 'insufficientValidRuns' | 'unstableResult'

// Caller-facing configuration for directional preload, sampling, fitting, repetition, and limits.
export interface BacklashCalibrationOptions {
	// Requested movement increment, in focuser steps.
	readonly probeStep: number
	// Distance traveled opposite the measured direction before each reversal, in steps.
	readonly preloadDistance: number
	// Maximum counter travel after one reversal, in steps.
	readonly maximumProbeDistance: number
	// Minimum accepted absolute metric slope per focuser step.
	readonly minimumSlope: number
	// Number of runs per direction; defaults to 3 and must be at least 3.
	readonly repeats?: number
	// Measurements aggregated at each position; defaults to 3.
	readonly samplesPerPosition?: number
	// Tail preload points used to verify local slope; defaults to 4.
	readonly minimumPreloadPoints?: number
	// Points at or before a positive breakpoint, including the baseline; defaults to 2.
	readonly minimumPlateauPoints?: number
	// Points required beyond a breakpoint; defaults to 3.
	readonly minimumPostBreakPoints?: number
	// Maximum spread of a stable breakpoint window, in steps; defaults to probeStep.
	readonly breakpointTolerance?: number
	// Consecutive valid fits required for early completion; defaults to 3.
	readonly stabilityCount?: number
	// Dimensionless Huber tuning constant forwarded to robust least squares; defaults to 1.345.
	readonly huberTuning?: number
	// Optional inclusive lower focuser limit, in steps.
	readonly minimumPosition?: number
	// Optional inclusive upper focuser limit, in steps.
	readonly maximumPosition?: number
	// Multiplier used for the shared overshoot recommendation; defaults to 1.5.
	readonly safetyFactor?: number
}

// One position-level aggregate used by the breakpoint fit.
export interface BacklashProbePoint {
	// Actual counter position reported by the caller, in focuser steps.
	readonly position: number
	// Absolute counter travel from the reversal position, in steps.
	readonly traveled: number
	// Median scalar metric at this position.
	readonly value: number
	// Non-normalized MAD of the samples at this position, in metric units.
	readonly dispersion: number
	// Number of raw measurements represented by this point.
	readonly sampleCount: number
}

// Numerical requirements for fitting the continuous hinge model.
export interface BacklashFitOptions {
	// Nominal sampling resolution, in focuser steps.
	readonly probeStep: number
	// Points required at or before a positive breakpoint.
	readonly minimumPlateauPoints: number
	// Points required after the breakpoint.
	readonly minimumPostBreakPoints: number
	// Minimum accepted absolute metric slope per focuser step.
	readonly minimumSlope: number
	// Dimensionless Huber tuning constant.
	readonly huberTuning: number
}

// Outcome of fitting m(x) = intercept + slope * max(0, x - breakpoint).
export interface BacklashFit {
	// Whether all reported numeric fields form an accepted fit.
	readonly valid: boolean
	// Numerical failure category when valid is false.
	readonly reason?: 'insufficientData' | 'insufficientSlope' | 'singularFit'
	// Estimated backlash, in focuser steps.
	readonly breakpoint?: number
	// Plateau metric value.
	readonly intercept?: number
	// Post-breakpoint metric change per focuser step.
	readonly slope?: number
	// Mean normalized Huber loss.
	readonly loss?: number
	// Robust weighted RMSE normalized by the response scale.
	readonly nrmse?: number
	// Profile-loss breakpoint uncertainty, in focuser steps.
	readonly uncertainty?: number
	// Number of consolidated points at or before the breakpoint.
	readonly plateauPointCount: number
	// Number of consolidated points after the breakpoint.
	readonly postBreakpointPointCount: number
}

// Result of one preload-and-reversal measurement in a single direction.
export interface BacklashRunResult {
	// Direction measured after the reversal.
	readonly direction: FocusAxisDirection
	// Whether the run produced an accepted stable breakpoint.
	readonly valid: boolean
	// Run-local failure when valid is false.
	readonly failureReason?: BacklashCalibrationFailureReason
	// Unrounded fitted backlash, in focuser steps.
	readonly steps?: number
	// Breakpoint uncertainty, in focuser steps.
	readonly uncertainty?: number
	// Post-breakpoint metric slope per focuser step.
	readonly slope?: number
	// Metric slope per focuser step measured during the opposite-direction preload.
	readonly preloadSlope?: number
	// Normalized robust fit error.
	readonly nrmse?: number
	// Probe points retained for diagnostics; the first point is the reversal baseline.
	readonly points: readonly BacklashProbePoint[]
}

// Robust aggregate of all attempted runs for one direction.
export interface BacklashDirectionResult {
	// Aggregated direction.
	readonly direction: FocusAxisDirection
	// Rounded median backlash, in focuser steps.
	readonly steps: number
	// Non-normalized MAD of valid run breakpoints, in steps.
	readonly dispersion: number
	// Combined within-run and between-run uncertainty, in steps.
	readonly uncertainty: number
	// Number of accepted runs.
	readonly validRunCount: number
	// Number of attempted runs.
	readonly totalRunCount: number
	// All attempted runs in execution order.
	readonly runs: readonly BacklashRunResult[]
}

// Final two-direction calibration and its conservative shared overshoot recommendation.
export interface BacklashCalibrationResult {
	// Aggregate for reversals into increasing counter positions.
	readonly increasing: BacklashDirectionResult
	// Aggregate for reversals into decreasing counter positions.
	readonly decreasing: BacklashDirectionResult
	// Shared overshoot recommendation, in integer focuser steps.
	readonly recommendedOvershoot: number
	// Combined confidence in the range [0, 1].
	readonly confidence: number
	// Quality tier derived exclusively from confidence.
	readonly quality: 'good' | 'marginal' | 'poor'
}

// Command emitted by the synchronous calibration machine.
export type BacklashCalibrationCommand =
	| { readonly type: 'move'; readonly relative: number; readonly direction: FocusAxisDirection }
	| { readonly type: 'measure'; readonly sampleIndex: number; readonly sampleCount: number }
	| { readonly type: 'completed'; readonly result: BacklashCalibrationResult }
	| { readonly type: 'failed'; readonly reason: BacklashCalibrationFailureReason; readonly direction?: FocusAxisDirection }
	| { readonly type: 'cancelled' }

// Event supplied after executing the latest command.
export type BacklashCalibrationEvent = { readonly type: 'moved'; readonly position: number } | { readonly type: 'measured'; readonly position: number; readonly value: number } | { readonly type: 'cancel' }

// Fully resolved options used internally after public defaults and validation.
interface NormalizedBacklashCalibrationOptions {
	// Requested movement increment, in focuser steps.
	readonly probeStep: number
	// Opposite-direction preload distance, in focuser steps.
	readonly preloadDistance: number
	// Maximum post-reversal travel, in focuser steps.
	readonly maximumProbeDistance: number
	// Minimum accepted absolute metric slope per step.
	readonly minimumSlope: number
	// Runs attempted per direction.
	readonly repeats: number
	// Measurements aggregated at each position.
	readonly samplesPerPosition: number
	// Preload tail points used for slope validation.
	readonly minimumPreloadPoints: number
	// Minimum points at or before a positive breakpoint.
	readonly minimumPlateauPoints: number
	// Minimum points after a breakpoint.
	readonly minimumPostBreakPoints: number
	// Stable-window spread tolerance, in steps.
	readonly breakpointTolerance: number
	// Breakpoints retained in the stable window.
	readonly stabilityCount: number
	// Dimensionless Huber tuning constant.
	readonly huberTuning: number
	// Optional inclusive lower counter limit, in steps.
	readonly minimumPosition?: number
	// Optional inclusive upper counter limit, in steps.
	readonly maximumPosition?: number
	// Overshoot recommendation multiplier.
	readonly safetyFactor: number
}

// Internal accepted fit including residual data needed for selection and uncertainty.
interface CandidateFit {
	// Evaluated breakpoint, in focuser steps.
	readonly breakpoint: number
	// Plateau metric value.
	readonly intercept: number
	// Post-breakpoint metric slope per step.
	readonly slope: number
	// Mean normalized Huber loss.
	readonly loss: number
	// Robust weighted normalized RMSE.
	readonly nrmse: number
	// Points at or before the breakpoint.
	readonly plateauPointCount: number
	// Points after the breakpoint.
	readonly postBreakpointPointCount: number
}

// Reason an individual breakpoint candidate could not be accepted.
type CandidateFailure = 'insufficientData' | 'insufficientSlope' | 'singularFit'

// Candidate evaluation used to retain failure information without non-finite sentinels.
type CandidateEvaluation = { readonly fit: CandidateFit } | { readonly failure: CandidateFailure }

// Default runs attempted per direction.
const DEFAULT_REPEATS = 3

// Default raw measurements aggregated at each position.
const DEFAULT_SAMPLES_PER_POSITION = 3

// Default preload tail length for slope validation.
const DEFAULT_MINIMUM_PRELOAD_POINTS = 4

// Default plateau support for positive-breakpoint models.
const DEFAULT_MINIMUM_PLATEAU_POINTS = 2

// Default post-breakpoint support.
const DEFAULT_MINIMUM_POST_BREAK_POINTS = 3

// Default stable breakpoint window length.
const DEFAULT_STABILITY_COUNT = 3

// Standard Huber tuning constant for approximately Gaussian residuals.
const DEFAULT_HUBER_TUNING = 1.345

// Default conservative multiplier for a shared overshoot recommendation.
const DEFAULT_SAFETY_FACTOR = 1.5

// Gaussian-consistent multiplier for a raw median absolute deviation.
const NORMALIZED_MAD_SCALE = 1.4826

// Number of equal profile-loss intervals sampled for breakpoint uncertainty.
const UNCERTAINTY_PROFILE_INTERVALS = 32

// Returns an invalid fit without fabricating numeric output fields.
function invalidFit(reason: BacklashFit['reason'], plateauPointCount = 0, postBreakpointPointCount = 0): BacklashFit {
	return { valid: false, reason, plateauPointCount, postBreakpointPointCount }
}

// Consolidates valid equal-distance points without mutating caller-owned arrays.
function consolidateProbePoints(points: readonly BacklashProbePoint[]) {
	const valid: BacklashProbePoint[] = []

	for (let i = 0; i < points.length; i++) {
		const point = points[i]
		if (Number.isFinite(point.position) && Number.isFinite(point.traveled) && point.traveled >= 0 && Number.isFinite(point.value) && Number.isFinite(point.dispersion) && point.dispersion >= 0 && Number.isInteger(point.sampleCount) && point.sampleCount > 0) {
			valid.push(point)
		}
	}

	valid.sort((a, b) => a.traveled - b.traveled || a.position - b.position)
	const consolidated: BacklashProbePoint[] = []

	for (let start = 0; start < valid.length;) {
		let end = start + 1
		while (end < valid.length && valid[end].traveled === valid[start].traveled) end++

		if (end - start === 1) {
			consolidated.push({ ...valid[start] })
		} else {
			const count = end - start
			const positions = new Float64Array(count)
			const values = new Float64Array(count)
			const dispersions = new Float64Array(count)
			let sampleCount = 0

			for (let i = 0; i < count; i++) {
				const point = valid[start + i]
				positions[i] = point.position
				values[i] = point.value
				dispersions[i] = point.dispersion
				sampleCount += point.sampleCount
			}

			const value = medianOf(values.sort())
			const betweenPointMad = medianAbsoluteDeviationOf(values, value, false)
			consolidated.push({ position: medianOf(positions.sort()), traveled: valid[start].traveled, value, dispersion: Math.max(betweenPointMad, medianOf(dispersions.sort())), sampleCount })
		}

		start = end
	}

	return consolidated
}

// Validates the standalone fitting contract before allocating candidate matrices.
function validateFitOptions(options: Readonly<BacklashFitOptions>) {
	validatePositiveFinite(options.probeStep)
	validatePositiveInteger(options.minimumPlateauPoints)
	validatePositiveInteger(options.minimumPostBreakPoints)
	validatePositiveFinite(options.minimumSlope)
	validatePositiveFinite(options.huberTuning)
}

// Computes mean Huber loss against one response scale shared by every breakpoint candidate.
function normalizedHuberLoss(result: RobustLinearLeastSquaresResult, tuning: number, responseScale: number) {
	let loss = 0

	for (let i = 0; i < result.residuals.length; i++) {
		const normalized = Math.abs(result.residuals[i]) / responseScale
		loss += normalized <= tuning ? 0.5 * normalized * normalized : tuning * (normalized - 0.5 * tuning)
	}

	return loss / result.residuals.length
}

// Evaluates one fixed-breakpoint hinge model with the shared robust least-squares primitive.
function evaluateBreakpoint(points: readonly BacklashProbePoint[], breakpoint: number, options: Readonly<BacklashFitOptions>): CandidateEvaluation {
	let plateauPointCount = 0
	let postBreakpointPointCount = 0

	for (let i = 0; i < points.length; i++) {
		if (points[i].traveled <= breakpoint) plateauPointCount++
		else postBreakpointPointCount++
	}

	if (postBreakpointPointCount < options.minimumPostBreakPoints || (breakpoint > 0 && plateauPointCount < options.minimumPlateauPoints)) return { failure: 'insufficientData' }

	const design: [number, number][] = new Array(points.length)
	const values = new Float64Array(points.length)

	for (let i = 0; i < points.length; i++) {
		design[i] = [1, Math.max(0, points[i].traveled - breakpoint)]
		values[i] = points[i].value
	}

	let result: RobustLinearLeastSquaresResult

	try {
		result = robustLinearLeastSquares(design, values, { method: 'huber', tuning: options.huberTuning })
	} catch {
		return { failure: 'singularFit' }
	}

	const intercept = result.coefficients[0]
	const slope = result.coefficients[1]
	if (result.rankDeficient || !Number.isFinite(intercept) || !Number.isFinite(slope)) return { failure: 'singularFit' }
	if (Math.abs(slope) < options.minimumSlope) return { failure: 'insufficientSlope' }

	let weightedSquaredError = 0
	let weightSum = 0

	for (let i = 0; i < result.residuals.length; i++) {
		const weight = result.weights[i]
		weightedSquaredError += weight * result.residuals[i] * result.residuals[i]
		weightSum += weight
	}

	values.sort()
	const interquartileRange = percentileOf(values, 0.75) - percentileOf(values, 0.25)
	const lossScale = Math.max(interquartileRange, options.minimumSlope * options.probeStep, Number.EPSILON)
	const responseScale = Math.max(interquartileRange, Math.abs(slope) * options.probeStep, Number.EPSILON)
	const loss = normalizedHuberLoss(result, options.huberTuning, lossScale)
	const nrmse = Math.sqrt(weightedSquaredError / weightSum) / responseScale
	if (!Number.isFinite(loss) || !Number.isFinite(nrmse)) return { failure: 'singularFit' }

	return { fit: { breakpoint, intercept, slope, loss, nrmse, plateauPointCount, postBreakpointPointCount } }
}

// Compares finite candidate losses with a deterministic smaller-breakpoint tie break.
function isBetterCandidate(candidate: CandidateFit, best: CandidateFit | undefined) {
	if (best === undefined) return true
	const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(candidate.loss), Math.abs(best.loss))
	return candidate.loss < best.loss - tolerance || (Math.abs(candidate.loss - best.loss) <= tolerance && candidate.breakpoint < best.breakpoint)
}

// Requires a loss reduction beyond floating-point comparison noise for optional refinement.
function improvesCandidateLoss(candidate: CandidateFit, best: CandidateFit) {
	const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(candidate.loss), Math.abs(best.loss))
	return candidate.loss < best.loss - tolerance
}

// Samples a bounded local loss profile and returns its half-width above the minimum.
function breakpointUncertainty(points: readonly BacklashProbePoint[], fit: CandidateFit, min: number, max: number, options: Readonly<BacklashFitOptions>) {
	const threshold = fit.loss + 1 / points.length
	let lower = fit.breakpoint
	let upper = fit.breakpoint

	if (max > min) {
		for (let i = 0; i <= UNCERTAINTY_PROFILE_INTERVALS; i++) {
			const breakpoint = min + ((max - min) * i) / UNCERTAINTY_PROFILE_INTERVALS
			const evaluation = evaluateBreakpoint(points, breakpoint, options)
			if ('fit' in evaluation && evaluation.fit.loss <= threshold) {
				lower = Math.min(lower, breakpoint)
				upper = Math.max(upper, breakpoint)
			}
		}
	}

	return Math.max(options.probeStep * 0.5, (upper - lower) * 0.5)
}

// Fits a robust continuous plateau-plus-line breakpoint without mutating input points.
export function fitBacklashBreakpoint(points: readonly BacklashProbePoint[], options: Readonly<BacklashFitOptions>): BacklashFit {
	validateFitOptions(options)
	const consolidated = consolidateProbePoints(points)
	if (consolidated.length < options.minimumPostBreakPoints + 1) return invalidFit('insufficientData')

	const breakpoints: number[] = [0]
	for (let i = 0; i < consolidated.length - 1; i++) {
		const traveled = consolidated[i].traveled
		if (traveled > 0 && traveled !== breakpoints.at(-1)) breakpoints.push(traveled)
	}

	let best: CandidateFit | undefined
	let sawInsufficientSlope = false
	let sawSingularFit = false

	for (let i = 0; i < breakpoints.length; i++) {
		const evaluation = evaluateBreakpoint(consolidated, breakpoints[i], options)
		if ('fit' in evaluation) {
			if (isBetterCandidate(evaluation.fit, best)) best = evaluation.fit
		} else if (evaluation.failure === 'insufficientSlope') {
			sawInsufficientSlope = true
		} else if (evaluation.failure === 'singularFit') {
			sawSingularFit = true
		}
	}

	if (best === undefined) return invalidFit(sawInsufficientSlope ? 'insufficientSlope' : sawSingularFit ? 'singularFit' : 'insufficientData')

	const bestIndex = breakpoints.indexOf(best.breakpoint)
	const bracketMin = bestIndex > 0 ? breakpoints[bestIndex - 1] : 0
	const bracketMax = bestIndex + 1 < breakpoints.length ? breakpoints[bestIndex + 1] : consolidated.at(-1)!.traveled

	if (bracketMax > bracketMin) {
		try {
			const refined = goldenSectionSearch(
				(breakpoint) => {
					const evaluation = evaluateBreakpoint(consolidated, breakpoint, options)
					return 'fit' in evaluation ? evaluation.fit.loss : Number.MAX_VALUE
				},
				bracketMin,
				bracketMax,
				{ maxIterations: 64, tolerance: Math.max(Number.EPSILON, (bracketMax - bracketMin) * 1e-8) },
			)

			if (refined.converged) {
				const evaluation = evaluateBreakpoint(consolidated, refined.minimum, options)
				if ('fit' in evaluation && improvesCandidateLoss(evaluation.fit, best)) best = evaluation.fit
			}
		} catch {
			// The discrete candidate remains valid when the optional bounded refinement cannot evaluate.
		}
	}

	const uncertainty = breakpointUncertainty(consolidated, best, bracketMin, bracketMax, options)
	return {
		valid: true,
		breakpoint: best.breakpoint,
		intercept: best.intercept,
		slope: best.slope,
		loss: best.loss,
		nrmse: best.nrmse,
		uncertainty,
		plateauPointCount: best.plateauPointCount,
		postBreakpointPointCount: best.postBreakpointPointCount,
	}
}

// Aggregates a non-empty, single-direction run list when a strict majority is valid.
export function aggregateBacklashRuns(runs: readonly BacklashRunResult[]): BacklashDirectionResult | undefined {
	if (runs.length === 0) return undefined
	const direction = runs[0].direction
	for (let i = 1; i < runs.length; i++) if (runs[i].direction !== direction) return undefined

	const valid = runs.filter(
		(run) =>
			run.valid &&
			run.steps !== undefined &&
			run.uncertainty !== undefined &&
			run.slope !== undefined &&
			run.preloadSlope !== undefined &&
			run.nrmse !== undefined &&
			Number.isFinite(run.steps) &&
			run.steps >= 0 &&
			Number.isFinite(run.uncertainty) &&
			run.uncertainty >= 0 &&
			Number.isFinite(run.slope) &&
			Number.isFinite(run.preloadSlope) &&
			Number.isFinite(run.nrmse) &&
			run.nrmse >= 0,
	)
	if (valid.length < Math.floor(runs.length / 2) + 1) return undefined

	const steps = new Float64Array(valid.length)
	const uncertainties = new Float64Array(valid.length)
	for (let i = 0; i < valid.length; i++) {
		steps[i] = valid[i].steps!
		uncertainties[i] = valid[i].uncertainty!
	}

	const medianSteps = medianOf(steps.sort())
	const dispersion = medianAbsoluteDeviationOf(steps, medianSteps, false)
	return {
		direction,
		steps: Math.round(medianSteps),
		dispersion,
		uncertainty: Math.max(medianOf(uncertainties.sort()), NORMALIZED_MAD_SCALE * dispersion),
		validRunCount: valid.length,
		totalRunCount: runs.length,
		runs: runs.slice(),
	}
}

// Maps counter directions to the existing IN/OUT backlash-compensation contract.
export function backlashCompensationFromCalibration(result: BacklashCalibrationResult, mode: BacklashCompensationMode = 'OVERSHOOT'): BacklashCompensation {
	return { mode, backlashIn: result.decreasing.steps, backlashOut: result.increasing.steps }
}

// Expands public defaults and rejects combinations that cannot produce a stable fit.
function normalizeCalibrationOptions(options: BacklashCalibrationOptions): NormalizedBacklashCalibrationOptions {
	validatePositiveFinite(options.probeStep)
	validatePositiveFinite(options.preloadDistance)
	validatePositiveFinite(options.maximumProbeDistance)
	validatePositiveFinite(options.minimumSlope)

	const repeats = options.repeats ?? DEFAULT_REPEATS
	const samplesPerPosition = options.samplesPerPosition ?? DEFAULT_SAMPLES_PER_POSITION
	const minimumPreloadPoints = options.minimumPreloadPoints ?? DEFAULT_MINIMUM_PRELOAD_POINTS
	const minimumPlateauPoints = options.minimumPlateauPoints ?? DEFAULT_MINIMUM_PLATEAU_POINTS
	const minimumPostBreakPoints = options.minimumPostBreakPoints ?? DEFAULT_MINIMUM_POST_BREAK_POINTS
	const breakpointTolerance = options.breakpointTolerance ?? options.probeStep
	const stabilityCount = options.stabilityCount ?? DEFAULT_STABILITY_COUNT
	const huberTuning = options.huberTuning ?? DEFAULT_HUBER_TUNING
	const safetyFactor = options.safetyFactor ?? DEFAULT_SAFETY_FACTOR

	validatePositiveInteger(repeats)
	validatePositiveInteger(samplesPerPosition)
	validatePositiveInteger(minimumPreloadPoints)
	validatePositiveInteger(minimumPlateauPoints)
	validatePositiveInteger(minimumPostBreakPoints)
	validatePositiveInteger(stabilityCount)
	validatePositiveFinite(breakpointTolerance)
	validatePositiveFinite(huberTuning)
	validatePositiveFinite(safetyFactor)

	if (repeats < 3) throw new RangeError('repeats must be at least 3')
	if (minimumPreloadPoints < 2) throw new RangeError('minimumPreloadPoints must be at least 2')
	if (minimumPostBreakPoints < 2) throw new RangeError('minimumPostBreakPoints must be at least 2')
	if (safetyFactor < 1) throw new RangeError('safetyFactor must be at least 1')
	if (Math.ceil(options.preloadDistance / options.probeStep) < minimumPreloadPoints) throw new RangeError('preloadDistance cannot provide minimumPreloadPoints')
	if (Math.floor(options.maximumProbeDistance / options.probeStep) + 1 < minimumPlateauPoints + minimumPostBreakPoints + stabilityCount - 1) throw new RangeError('maximumProbeDistance cannot provide a stable breakpoint fit')

	const { minimumPosition, maximumPosition } = options
	if (minimumPosition !== undefined) validateFinite(minimumPosition)
	if (maximumPosition !== undefined) validateFinite(maximumPosition)
	if (minimumPosition !== undefined && maximumPosition !== undefined && minimumPosition >= maximumPosition) throw new RangeError('minimumPosition must be less than maximumPosition')

	return {
		probeStep: options.probeStep,
		preloadDistance: options.preloadDistance,
		maximumProbeDistance: options.maximumProbeDistance,
		minimumSlope: options.minimumSlope,
		repeats,
		samplesPerPosition,
		minimumPreloadPoints,
		minimumPlateauPoints,
		minimumPostBreakPoints,
		breakpointTolerance,
		stabilityCount,
		huberTuning,
		minimumPosition,
		maximumPosition,
		safetyFactor,
	}
}

// Returns the opposite counter direction.
function oppositeDirection(direction: FocusAxisDirection): FocusAxisDirection {
	return direction === 'increasing' ? 'decreasing' : 'increasing'
}

// Returns the signed multiplier for one counter direction.
function directionSign(direction: FocusAxisDirection) {
	return direction === 'increasing' ? 1 : -1
}

// Fits the metric slope over the measured tail of a preload.
function fitPreloadSlope(points: readonly BacklashProbePoint[], minimumPoints: number, huberTuning: number) {
	if (points.length < minimumPoints) return undefined
	const start = points.length - minimumPoints
	const design: [number, number][] = new Array(minimumPoints)
	const values = new Float64Array(minimumPoints)
	const origin = points[start].traveled

	for (let i = 0; i < minimumPoints; i++) {
		const point = points[start + i]
		design[i] = [1, point.traveled - origin]
		values[i] = point.value
	}

	try {
		const fit = robustLinearLeastSquares(design, values, { method: 'huber', tuning: huberTuning })
		const slope = fit.coefficients[1]
		return !fit.rankDeficient && Number.isFinite(slope) ? slope : undefined
	} catch {
		return undefined
	}
}

// Returns the geometric mean of bounded quality components.
function geometricMean(values: readonly number[]) {
	let logarithm = 0
	for (let i = 0; i < values.length; i++) {
		if (!Number.isFinite(values[i]) || values[i] <= 0) return 0
		logarithm += Math.log(Math.min(1, values[i]))
	}
	return Math.min(1, Math.max(0, Math.exp(logarithm / values.length)))
}

// Scores one direction without allowing invalid runs to contribute fit diagnostics.
function directionConfidence(result: BacklashDirectionResult, scale: number) {
	const valid = result.runs.filter((run) => run.valid)
	const nrmse = new Float64Array(valid.length)
	const slopeAgreement = new Float64Array(valid.length)

	for (let i = 0; i < valid.length; i++) {
		const run = valid[i]
		const preloadSlope = run.preloadSlope!
		const slope = run.slope!
		nrmse[i] = run.nrmse!
		slopeAgreement[i] = preloadSlope * slope < 0 ? Math.min(Math.abs(preloadSlope), Math.abs(slope)) / Math.max(Math.abs(preloadSlope), Math.abs(slope)) : 0
	}

	const coverage = result.validRunCount / result.totalRunCount
	const dispersionScore = 1 / (1 + result.dispersion / scale)
	const fitScore = 1 / (1 + medianOf(nrmse.sort()))
	const uncertaintyScore = 1 / (1 + result.uncertainty / scale)
	const slopeScore = medianOf(slopeAgreement.sort())
	return geometricMean([coverage, dispersionScore, fitScore, uncertaintyScore, slopeScore])
}

// Synchronous command/event state machine for repeated two-direction backlash calibration.
export class BacklashCalibration {
	readonly #config: NormalizedBacklashCalibrationOptions
	#state: BacklashCalibrationState = 'idle'
	#currentDirection?: FocusAxisDirection
	#currentPosition = 0
	#pending?: Extract<BacklashCalibrationCommand, { type: 'move' | 'measure' }>
	#terminal?: Extract<BacklashCalibrationCommand, { type: 'completed' | 'failed' | 'cancelled' }>
	#result?: BacklashCalibrationResult
	#runIndex = 0
	#preloadTraveled = 0
	#reversalPosition = 0
	#probeHadValidFit = false
	#preloadSlope?: number
	readonly #preloadPoints: BacklashProbePoint[] = []
	readonly #probePoints: BacklashProbePoint[] = []
	readonly #stableBreakpoints: number[] = []
	readonly #samples: Float64Array
	#sampleCount = 0
	readonly #increasingRuns: BacklashRunResult[] = []
	readonly #decreasingRuns: BacklashRunResult[] = []

	// Validates and stores immutable calibration options without starting movement.
	constructor(readonly options: BacklashCalibrationOptions) {
		this.#config = normalizeCalibrationOptions(options)
		this.#samples = new Float64Array(this.#config.samplesPerPosition)
	}

	// Returns the current observable phase.
	get state() {
		return this.#state
	}

	// Returns the direction of the active run, or undefined outside a run.
	get currentDirection() {
		return this.#currentDirection
	}

	// Returns the completed result, or undefined before successful completion.
	get result() {
		return this.#result
	}

	// Starts the first directional preload from a finite in-range counter position.
	start(position: number): BacklashCalibrationCommand {
		if (this.#terminal !== undefined) return this.#terminal
		if (this.#state !== 'idle') return this.#fail('invalidEvent')
		if (!Number.isFinite(position)) return this.#fail('invalidPosition')
		if (!this.#positionInRange(position)) return this.#fail('positionLimit')

		this.#currentPosition = position
		return this.#beginRun()
	}

	// Consumes the event corresponding to the pending command and emits the next command.
	next(event: BacklashCalibrationEvent): BacklashCalibrationCommand {
		if (this.#terminal !== undefined) return this.#terminal
		if (event.type === 'cancel') return this.#cancel()
		if (this.#pending === undefined || this.#state === 'idle') return this.#fail('invalidEvent')

		if (this.#pending.type === 'move') {
			if (event.type !== 'moved') return this.#fail('invalidEvent')
			return this.#handleMoved(event.position)
		}

		if (event.type !== 'measured') return this.#fail('invalidEvent')
		return this.#handleMeasured(event.position, event.value)
	}

	// Selects the alternating direction schedule and initializes one run.
	#beginRun(): BacklashCalibrationCommand {
		const repeat = Math.floor(this.#runIndex / 2)
		const first: FocusAxisDirection = repeat % 2 === 0 ? 'increasing' : 'decreasing'
		this.#currentDirection = this.#runIndex % 2 === 0 ? first : oppositeDirection(first)
		this.#state = 'preloading'
		this.#preloadTraveled = 0
		this.#preloadSlope = undefined
		this.#probeHadValidFit = false
		this.#preloadPoints.length = 0
		this.#probePoints.length = 0
		this.#stableBreakpoints.length = 0
		return this.#queueMove(oppositeDirection(this.#currentDirection), Math.min(this.#config.probeStep, this.#config.preloadDistance))
	}

	// Validates actual movement direction and queues measurements at the reported position.
	#handleMoved(position: number): BacklashCalibrationCommand {
		const pending = this.#pending!
		if (pending.type !== 'move') return this.#fail('invalidEvent')
		if (!Number.isFinite(position)) return this.#fail('invalidPosition')
		if (!this.#positionInRange(position)) return this.#fail('positionLimit')

		const delta = position - this.#currentPosition
		if (delta === 0 || Math.sign(delta) !== directionSign(pending.direction)) return this.#fail('axisStalled')
		if (Math.abs(delta) > Math.abs(pending.relative)) return this.#fail('invalidPosition')

		this.#currentPosition = position
		if (this.#state === 'preloading') this.#preloadTraveled += Math.abs(delta)
		this.#pending = undefined
		this.#sampleCount = 0
		return this.#queueMeasure()
	}

	// Validates and aggregates one metric sample without accepting mismatched positions.
	#handleMeasured(position: number, value: number): BacklashCalibrationCommand {
		if (!Number.isFinite(position) || position !== this.#currentPosition) return this.#fail('invalidPosition')
		if (!Number.isFinite(value)) return this.#fail('invalidSample')

		this.#samples[this.#sampleCount++] = value
		this.#pending = undefined
		if (this.#sampleCount < this.#config.samplesPerPosition) return this.#queueMeasure()

		const sorted = this.#samples.toSorted()
		const median = medianOf(sorted)
		const point: BacklashProbePoint = {
			position: this.#currentPosition,
			traveled: this.#state === 'preloading' ? this.#preloadTraveled : Math.abs(this.#currentPosition - this.#reversalPosition),
			value: median,
			dispersion: medianAbsoluteDeviationOf(sorted, median, false),
			sampleCount: this.#config.samplesPerPosition,
		}

		return this.#state === 'preloading' ? this.#advancePreload(point) : this.#advanceProbe(point)
	}

	// Continues preload travel or validates its tail slope and reverses into the probe.
	#advancePreload(point: BacklashProbePoint): BacklashCalibrationCommand {
		this.#preloadPoints.push(point)
		if (this.#preloadTraveled < this.#config.preloadDistance) {
			return this.#queueMove(oppositeDirection(this.#currentDirection!), Math.min(this.#config.probeStep, this.#config.preloadDistance - this.#preloadTraveled))
		}

		this.#preloadSlope = fitPreloadSlope(this.#preloadPoints, this.#config.minimumPreloadPoints, this.#config.huberTuning)
		if (this.#preloadSlope === undefined || Math.abs(this.#preloadSlope) < this.#config.minimumSlope) return this.#finishRun(false, 'insufficientSlope')

		this.#state = 'probing'
		this.#reversalPosition = this.#currentPosition
		this.#probePoints.push({ ...point, traveled: 0 })
		return this.#queueMove(this.#currentDirection!, Math.min(this.#config.probeStep, this.#config.maximumProbeDistance))
	}

	// Refits after one probe point and either completes a stable run or advances travel.
	#advanceProbe(point: BacklashProbePoint): BacklashCalibrationCommand {
		this.#probePoints.push(point)
		const fit = fitBacklashBreakpoint(this.#probePoints, this.#fitOptions())

		if (fit.valid) {
			this.#probeHadValidFit = true
			this.#stableBreakpoints.push(fit.breakpoint!)
			if (this.#stableBreakpoints.length > this.#config.stabilityCount) this.#stableBreakpoints.shift()

			if (this.#stableBreakpoints.length === this.#config.stabilityCount && fit.postBreakpointPointCount >= this.#config.minimumPostBreakPoints) {
				let minimum = this.#stableBreakpoints[0]
				let maximum = minimum
				for (let i = 1; i < this.#stableBreakpoints.length; i++) {
					minimum = Math.min(minimum, this.#stableBreakpoints[i])
					maximum = Math.max(maximum, this.#stableBreakpoints[i])
				}

				if (maximum - minimum <= this.#config.breakpointTolerance) return this.#finishRun(true, undefined, fit)
			}
		}

		if (point.traveled >= this.#config.maximumProbeDistance) return this.#finishRun(false, this.#probeHadValidFit ? 'maximumDistanceReached' : 'breakpointNotFound')
		return this.#queueMove(this.#currentDirection!, Math.min(this.#config.probeStep, this.#config.maximumProbeDistance - point.traveled))
	}

	// Records one run and advances, aggregates, or fails when a majority is impossible.
	#finishRun(valid: boolean, failureReason?: BacklashCalibrationFailureReason, fit?: BacklashFit): BacklashCalibrationCommand {
		const direction = this.#currentDirection!
		const run: BacklashRunResult = valid
			? { direction, valid: true, steps: fit!.breakpoint, uncertainty: fit!.uncertainty, slope: fit!.slope, preloadSlope: this.#preloadSlope, nrmse: fit!.nrmse, points: this.#probePoints.slice() }
			: { direction, valid: false, failureReason, preloadSlope: this.#preloadSlope, points: this.#probePoints.slice() }

		this.#runs(direction).push(run)
		this.#runIndex++
		if (!this.#majorityStillPossible('increasing') || !this.#majorityStillPossible('decreasing')) return this.#fail('insufficientValidRuns', direction)
		if (this.#runIndex >= this.#config.repeats * 2) return this.#complete()
		return this.#beginRun()
	}

	// Aggregates both directions, validates dispersion, and creates the terminal result.
	#complete(): BacklashCalibrationCommand {
		const increasing = aggregateBacklashRuns(this.#increasingRuns)
		const decreasing = aggregateBacklashRuns(this.#decreasingRuns)
		if (increasing === undefined || decreasing === undefined) return this.#fail('insufficientValidRuns')

		const scale = Math.max(this.#config.probeStep, this.#config.breakpointTolerance)
		if (increasing.dispersion > scale || decreasing.dispersion > scale) return this.#fail('unstableResult')

		const confidence = Math.min(directionConfidence(increasing, scale), directionConfidence(decreasing, scale))
		const quality: BacklashCalibrationResult['quality'] = confidence >= 0.8 ? 'good' : confidence >= 0.5 ? 'marginal' : 'poor'
		this.#result = { increasing, decreasing, recommendedOvershoot: Math.ceil(Math.max(increasing.steps, decreasing.steps) * this.#config.safetyFactor), confidence, quality }
		this.#state = 'completed'
		this.#currentDirection = undefined
		this.#pending = undefined
		this.#terminal = { type: 'completed', result: this.#result }
		return this.#terminal
	}

	// Emits an in-range finite relative movement and remembers it as the sole pending command.
	#queueMove(direction: FocusAxisDirection, distance: number): BacklashCalibrationCommand {
		const relative = directionSign(direction) * distance
		const target = this.#currentPosition + relative
		if (!Number.isFinite(relative) || relative === 0 || !Number.isFinite(target)) return this.#fail('invalidPosition')
		if (!this.#positionInRange(target)) return this.#fail('positionLimit')
		this.#pending = { type: 'move', relative, direction }
		return this.#pending
	}

	// Emits the next zero-based sample request at the current confirmed position.
	#queueMeasure(): BacklashCalibrationCommand {
		this.#pending = { type: 'measure', sampleIndex: this.#sampleCount, sampleCount: this.#config.samplesPerPosition }
		return this.#pending
	}

	// Returns fitting options shared by every probe update.
	#fitOptions(): BacklashFitOptions {
		return { probeStep: this.#config.probeStep, minimumPlateauPoints: this.#config.minimumPlateauPoints, minimumPostBreakPoints: this.#config.minimumPostBreakPoints, minimumSlope: this.#config.minimumSlope, huberTuning: this.#config.huberTuning }
	}

	// Returns the mutable run bucket for one direction.
	#runs(direction: FocusAxisDirection) {
		return direction === 'increasing' ? this.#increasingRuns : this.#decreasingRuns
	}

	// Checks whether completed plus remaining runs can still form a strict majority.
	#majorityStillPossible(direction: FocusAxisDirection) {
		const runs = this.#runs(direction)
		let valid = 0
		for (let i = 0; i < runs.length; i++) if (runs[i].valid) valid++
		return valid + (this.#config.repeats - runs.length) >= Math.floor(this.#config.repeats / 2) + 1
	}

	// Tests an inclusive optional position interval.
	#positionInRange(position: number) {
		return (this.#config.minimumPosition === undefined || position >= this.#config.minimumPosition) && (this.#config.maximumPosition === undefined || position <= this.#config.maximumPosition)
	}

	// Enters a typed failed terminal state and clears partial public results.
	#fail(reason: BacklashCalibrationFailureReason, direction = this.#currentDirection): Extract<BacklashCalibrationCommand, { type: 'failed' }> {
		this.#state = 'failed'
		this.#result = undefined
		this.#pending = undefined
		this.#currentDirection = direction
		this.#terminal = direction === undefined ? { type: 'failed', reason } : { type: 'failed', reason, direction }
		return this.#terminal
	}

	// Enters an idempotent cancelled state without exposing partial calibration data.
	#cancel(): Extract<BacklashCalibrationCommand, { type: 'cancelled' }> {
		this.#state = 'cancelled'
		this.#result = undefined
		this.#pending = undefined
		this.#currentDirection = undefined
		this.#terminal = { type: 'cancelled' }
		return this.#terminal
	}
}
