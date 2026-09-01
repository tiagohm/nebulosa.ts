import type { FlatDiagnostic, FlatExposureEstimate, FlatExposureInput, FlatExposureObservation } from './types'

// Pure scalar exposure estimation for one explicitly selected flat plane. Corrected signals may use
// proportional scaling; observed levels require interpolation or a positive-slope affine pedestal model.

// Maximum affine fit RMSE relative to the larger target or observed span.
const MAXIMUM_AFFINE_RELATIVE_RMSE = 0.05

// Affine level prediction used by interpolation, regression, and the corrected through-origin ratio.
interface ExposureModel {
	// Model intercept in digital numbers.
	readonly intercept: number
	// Model slope in digital numbers per second.
	readonly slope: number
	// Public method represented by the coefficients.
	readonly method: 'ratio' | 'interpolation' | 'affine'
}

// Estimates the next exposure from approved scalar observations for one physical plane.
export function estimateFlatExposure(input: FlatExposureInput): FlatExposureEstimate {
	const invalidReason = validateExposureInput(input)
	if (invalidReason) return invalidExposure(invalidReason)
	const observations = deduplicateObservations(input.observations)
	if (typeof observations === 'string') return invalidExposure(observations)

	const current = input.observations.at(-1)!
	const [targetMinimum, targetMaximum] = input.targetRange
	if (current.level >= targetMinimum && current.level <= targetMaximum) {
		if (current.exposure < input.exposureRange[0]) return { status: 'belowMinimum', method: 'none', recommendedExposure: input.exposureRange[0], diagnostics: [] }
		if (current.exposure > input.exposureRange[1]) return { status: 'aboveMaximum', method: 'none', recommendedExposure: input.exposureRange[1], diagnostics: [] }
		return { status: 'accepted', method: 'none', recommendedExposure: current.exposure, predictedLevel: current.level, diagnostics: [] }
	}

	const target = targetMinimum + (targetMaximum - targetMinimum) * 0.5
	const bracket = bracketModel(observations, target)
	if (bracket) return finishExposureEstimate(current, target, bracket, input.exposureRange, input.maximumStep)

	if (input.levelMode === 'corrected') {
		const model = { intercept: 0, slope: current.level / current.exposure, method: 'ratio' } as const
		return finishExposureEstimate(current, target, model, input.exposureRange, input.maximumStep)
	}

	if (observations.length < 2) return invalidExposure('one observed level cannot separate illumination signal from its pedestal', 'insufficientSamples')
	const affine = affineModel(observations, target)
	if (typeof affine === 'string') return invalidExposure(affine)
	return finishExposureEstimate(current, target, affine, input.exposureRange, input.maximumStep)
}

// Returns an error message for structurally or numerically unusable scalar input.
function validateExposureInput(input: FlatExposureInput): string | undefined {
	if (!Array.isArray(input.observations) || input.observations.length === 0) return 'at least one exposure observation is required'
	if (input.levelMode !== 'observed' && input.levelMode !== 'corrected') return 'exposure level mode must be observed or corrected'
	const [targetMinimum, targetMaximum] = input.targetRange
	if (!Number.isFinite(targetMinimum) || !Number.isFinite(targetMaximum) || targetMinimum > targetMaximum) return 'target range must contain ordered finite levels'
	const [exposureMinimum, exposureMaximum] = input.exposureRange
	if (!Number.isFinite(exposureMinimum) || !Number.isFinite(exposureMaximum) || exposureMinimum <= 0 || exposureMinimum >= exposureMaximum) return 'exposure range must contain ordered finite positive durations'
	if (input.maximumStep !== undefined && (!Number.isFinite(input.maximumStep) || input.maximumStep <= 0)) return 'maximum exposure step must be finite and positive'
	for (const observation of input.observations) {
		if (!Number.isFinite(observation.exposure) || observation.exposure <= 0 || !Number.isFinite(observation.level)) return 'exposure observations must contain finite positive durations and finite levels'
		if (input.levelMode === 'corrected' && observation.level <= 0) return 'corrected exposure levels must be positive'
	}
	return undefined
}

// Sorts observations by exposure and collapses exact duplicates while rejecting contradictory levels.
function deduplicateObservations(observations: readonly FlatExposureObservation[]): FlatExposureObservation[] | string {
	const sorted = Array.from(observations).sort((a, b) => a.exposure - b.exposure)
	const unique: FlatExposureObservation[] = []
	for (const observation of sorted) {
		const previous = unique.at(-1)
		if (previous?.exposure === observation.exposure) {
			if (previous.level !== observation.level) return 'duplicate exposures contain contradictory levels'
			continue
		}
		unique.push(observation)
	}
	return unique
}

// Finds the closest positive-slope adjacent pair whose levels bracket the target.
function bracketModel(observations: readonly FlatExposureObservation[], target: number): ExposureModel | undefined {
	let best: ExposureModel | undefined
	let bestSpan = Number.POSITIVE_INFINITY
	for (let i = 1; i < observations.length; i++) {
		const lower = observations[i - 1]
		const upper = observations[i]
		if (upper.level <= lower.level || target < lower.level || target > upper.level) continue
		const span = upper.exposure - lower.exposure
		if (span >= bestSpan) continue
		const slope = (upper.level - lower.level) / span
		const intercept = lower.level - slope * lower.exposure
		if (!Number.isFinite(slope) || !Number.isFinite(intercept) || slope <= 0) continue
		best = { intercept, slope, method: 'interpolation' }
		bestSpan = span
	}
	return best
}

// Fits a positive-slope affine observed-level model and rejects unstable fits with three or more points.
function affineModel(observations: readonly FlatExposureObservation[], target: number): ExposureModel | string {
	let meanExposure = 0
	let meanLevel = 0
	for (let i = 0; i < observations.length; i++) {
		meanExposure += (observations[i].exposure - meanExposure) / (i + 1)
		meanLevel += (observations[i].level - meanLevel) / (i + 1)
	}

	let covariance = 0
	let exposureVariance = 0
	let minimumLevel = Number.POSITIVE_INFINITY
	let maximumLevel = Number.NEGATIVE_INFINITY
	for (const observation of observations) {
		const dx = observation.exposure - meanExposure
		covariance += dx * (observation.level - meanLevel)
		exposureVariance += dx * dx
		if (observation.level < minimumLevel) minimumLevel = observation.level
		if (observation.level > maximumLevel) maximumLevel = observation.level
	}
	const slope = covariance / exposureVariance
	const intercept = meanLevel - slope * meanExposure
	if (!Number.isFinite(slope) || !Number.isFinite(intercept) || slope <= 0) return 'observed exposure levels do not define a finite positive-slope affine model'

	if (observations.length >= 3) {
		let squaredResiduals = 0
		for (const observation of observations) {
			const residual = observation.level - (intercept + slope * observation.exposure)
			squaredResiduals += residual * residual
		}
		const rmse = Math.sqrt(squaredResiduals / observations.length)
		const scale = Math.max(maximumLevel - minimumLevel, Math.abs(target), 1)
		if (!Number.isFinite(rmse) || rmse > scale * MAXIMUM_AFFINE_RELATIVE_RMSE) return 'observed exposure levels are too unstable for an affine recommendation'
	}

	return { intercept, slope, method: 'affine' }
}

// Applies absolute-step and exposure-range limits and predicts the signal at the returned duration.
function finishExposureEstimate(current: FlatExposureObservation, target: number, model: ExposureModel, exposureRange: readonly [number, number], maximumStep: number | undefined): FlatExposureEstimate {
	const unconstrained = (target - model.intercept) / model.slope
	if (!Number.isFinite(unconstrained) || unconstrained <= 0) return invalidExposure('the exposure model predicts no finite positive duration for the target')

	let recommended = unconstrained
	if (maximumStep !== undefined) recommended = Math.max(current.exposure - maximumStep, Math.min(current.exposure + maximumStep, recommended))
	const belowMinimum = unconstrained < exposureRange[0]
	const aboveMaximum = unconstrained > exposureRange[1]
	recommended = Math.max(exposureRange[0], Math.min(exposureRange[1], recommended))
	const predicted = model.intercept + model.slope * recommended
	if (!Number.isFinite(recommended) || !Number.isFinite(predicted)) return invalidExposure('the constrained exposure prediction is not finite')

	return {
		status: belowMinimum ? 'belowMinimum' : aboveMaximum ? 'aboveMaximum' : current.level < target ? 'increase' : 'decrease',
		method: model.method,
		recommendedExposure: recommended,
		predictedLevel: predicted,
		diagnostics: [],
	}
}

// Builds a stable invalid estimate without exposing non-finite model intermediates.
function invalidExposure(message: string, code: FlatDiagnostic['code'] = 'targetUnavailable'): FlatExposureEstimate {
	return {
		status: 'invalid',
		method: 'none',
		diagnostics: [{ severity: 'error', code, message }],
	}
}
