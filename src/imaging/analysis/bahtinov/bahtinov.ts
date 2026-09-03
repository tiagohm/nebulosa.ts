import { PI, PIOVERTWO } from '../../../core/constants'
import type { Point, Rect } from '../../../math/numerical/geometry'
import { bahtinovAxialAngleDistance, bahtinovAxialBisectors, computeBahtinovFocusGeometry, intersectBahtinovLines } from './geometry'
import { detectBahtinovHoughCandidates, validateBahtinovHoughOptions } from './hough'
import { fitBahtinovLines, type BahtinovFittedCandidate } from './line'
import { bahtinovLineSaturationRetention, preprocessBahtinov, type BahtinovPreprocessSuccess } from './preprocess'
import { DEFAULT_BAHTINOV_ANALYSIS_OPTIONS, type BahtinovAnalysisFailure, type BahtinovAnalysisInput, type BahtinovAnalysisOptions, type BahtinovAnalysisResult, type BahtinovExpectedPattern, type BahtinovFocusState, type BahtinovLine, type BahtinovQuality, type BahtinovWarning, type BahtinovWorkspace } from './types'

// Workspace-backed Bahtinov analyzer facade. The pipeline preprocesses a normalized ROI, detects and
// fits line candidates, selects one conditioned symmetric triplet, propagates line covariance into
// pixel focus uncertainty, and returns only finite full-image geometry.

// Angular mismatch scale for expected-pattern ranking when no hard limit is supplied.
const DEFAULT_EXPECTED_PRIOR_SCALE = PI / 12
// Relative central-difference step for line angles.
const UNCERTAINTY_ANGLE_STEP = 1e-6
// Relative central-difference step for line distances.
const UNCERTAINTY_DISTANCE_STEP = 1e-6
// Smallest score retained for a quality component that already passed its inclusive gate.
const MINIMUM_ACCEPTED_QUALITY = Number.EPSILON

// One valid central/external assignment and its score before ambiguity classification.
interface BahtinovTripletCandidate {
	// Index of the fitted central line.
	readonly central: number
	// Indices of the two fitted external lines.
	readonly external: readonly [number, number]
	// External-line intersection in full-image pixels.
	readonly reference: Readonly<Point>
	// Absolute determinant of external unit normals.
	readonly intersectionCondition: number
	// Central normal difference from the closest external bisector, in radians.
	readonly bisectorError: number
	// Largest expected-pattern difference in radians, when a prior exists.
	readonly expectedMismatch: number
	// Geometric-mean triplet score before runner-up separation.
	readonly score: number
	// Quality components independent of runner-up separation.
	readonly quality: BahtinovQuality
}

// Resolved finite analyzer thresholds used by triplet selection and focus classification.
interface ResolvedBahtinovDecisionOptions {
	// Minimum line signal-to-noise ratio.
	readonly minimumSignalToNoise: number
	// Minimum axial line separation in radians.
	readonly minimumAxialSeparation: number
	// Maximum central-to-bisector difference in radians.
	readonly maximumBisectorError: number
	// Allowed external-intersection margin in pixels.
	readonly intersectionMargin: number
	// Required relative score separation from the runner-up.
	readonly minimumCandidateSeparation: number
	// Minimum line coverage.
	readonly minimumCoverage: number
	// Minimum line balance.
	readonly minimumBalance: number
	// Maximum line residual in pixels.
	readonly maximumResidual: number
	// Absolute focus tolerance in pixels.
	readonly focusTolerance: number
	// Maximum classified uncertainty in pixels.
	readonly maximumUncertainty: number
	// Focus uncertainty interval multiplier.
	readonly focusSigma: number
	// Minimum aggregate confidence.
	readonly minimumConfidence: number
}

// Analyzes one normalized image for a three-line Bahtinov diffraction pattern.
// `workspace` must cover the resolved ROI and configured Hough grid and must not be used concurrently.
// Structural input and option errors throw. Missing or ambiguous image evidence returns a
// discriminated failure without fabricated lines, reference points, or focus values.
export function analyzeBahtinov(input: BahtinovAnalysisInput, workspace: BahtinovWorkspace, options: BahtinovAnalysisOptions = {}): BahtinovAnalysisResult {
	validateExpectedPattern(input.expected)
	const decision = resolveDecisionOptions(options)
	validateBahtinovHoughOptions(workspace, {
		maximumCandidates: options.maximumAngleCandidates,
		minimumAxialSeparation: decision.minimumAxialSeparation,
		refinementRange: options.refinementRange,
		refinementStep: options.refinementStep,
	})
	const preprocessed = preprocessBahtinov(input, workspace, options)
	if (!preprocessed.success) return { success: false, reason: preprocessed.reason, area: preprocessed.area, warnings: [] }

	const width = preprocessed.area.right - preprocessed.area.left
	const height = preprocessed.area.bottom - preprocessed.area.top
	const houghCandidates = detectBahtinovHoughCandidates(preprocessed.ridgePoints, width, height, preprocessed.workspace, {
		maximumCandidates: options.maximumAngleCandidates,
		minimumAxialSeparation: decision.minimumAxialSeparation,
		refinementRange: options.refinementRange,
		refinementStep: options.refinementStep,
		center: preprocessed.center,
	})
	if (houghCandidates.length < 3) return analysisFailure('patternNotFound', preprocessed, [])

	const fitted = fitBahtinovLines(houghCandidates, preprocessed.ridgePoints, preprocessed.area, preprocessed.responseDeviation, preprocessed.workspace, {
		maximumResidual: decision.maximumResidual,
		profileBlurSigma: preprocessed.profileBlurSigma,
		center: preprocessed.center,
	})
	if (fitted.length < 3) return analysisFailure('insufficientSupport', preprocessed, [])

	const triplets = selectTriplets(fitted, preprocessed, input.expected, decision)
	if (triplets.length === 0) return analysisFailure('patternNotFound', preprocessed, [])
	const best = triplets[0]
	const candidateSeparation = triplets.length === 1 ? 1 : Math.max(0, Math.min(1, (best.score - triplets[1].score) / Math.max(Number.EPSILON, best.score)))
	if (candidateSeparation < decision.minimumCandidateSeparation) return analysisFailure('ambiguousPattern', preprocessed, [])

	const centralLine = fitted[best.central].line
	const firstExternal = fitted[best.external[0]].line
	const secondExternal = fitted[best.external[1]].line
	const externalLines = firstExternal.normalAngle <= secondExternal.normalAngle ? ([firstExternal, secondExternal] as const) : ([secondExternal, firstExternal] as const)
	const focus = computeBahtinovFocusGeometry(centralLine, externalLines[0], externalLines[1], decision.focusTolerance)
	if (!focus) return analysisFailure('illConditioned', preprocessed, [])

	const uncertainty = propagateFocusUncertainty(centralLine, externalLines[0], externalLines[1])
	const quality = { ...best.quality, candidateSeparation }
	const confidence = geometricQualityMean(quality)
	const warnings = buildWarnings(preprocessed, best, centralLine, externalLines, uncertainty, decision, input.expected)
	const focusState = classifyFocus(focus.absoluteError, uncertainty, confidence, decision)
	return {
		success: true,
		area: { ...preprocessed.area },
		reference: { x: focus.reference.x, y: focus.reference.y },
		centralLine,
		externalLines,
		error: focus.error,
		absoluteError: focus.absoluteError,
		focusProximity: focus.focusProximity,
		uncertainty,
		focusState,
		confidence,
		quality,
		warnings,
	}
}

// Resolves and validates decision thresholds that are independent of preprocessing.
function resolveDecisionOptions(options: BahtinovAnalysisOptions): ResolvedBahtinovDecisionOptions {
	const resolved = {
		minimumSignalToNoise: options.minimumSignalToNoise ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.minimumSignalToNoise,
		minimumAxialSeparation: options.minimumAxialSeparation ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.minimumAxialSeparation,
		maximumBisectorError: options.maximumBisectorError ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.maximumBisectorError,
		intersectionMargin: options.intersectionMargin ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.intersectionMargin,
		minimumCandidateSeparation: options.minimumCandidateSeparation ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.minimumCandidateSeparation,
		minimumCoverage: options.minimumCoverage ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.minimumCoverage,
		minimumBalance: options.minimumBalance ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.minimumBalance,
		maximumResidual: options.maximumResidual ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.maximumResidual,
		focusTolerance: options.focusTolerance ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.focusTolerance,
		maximumUncertainty: options.maximumUncertainty ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.maximumUncertainty,
		focusSigma: options.focusSigma ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.focusSigma,
		minimumConfidence: options.minimumConfidence ?? DEFAULT_BAHTINOV_ANALYSIS_OPTIONS.minimumConfidence,
	}
	if (!Number.isFinite(resolved.minimumSignalToNoise) || !(resolved.minimumSignalToNoise > 0)) throw new RangeError('minimumSignalToNoise must be finite and positive')
	if (!Number.isFinite(resolved.minimumAxialSeparation) || !(resolved.minimumAxialSeparation > 0) || !(resolved.minimumAxialSeparation <= PIOVERTWO)) throw new RangeError('minimumAxialSeparation must be in (0, PI / 2]')
	if (!Number.isFinite(resolved.maximumBisectorError) || !(resolved.maximumBisectorError > 0) || !(resolved.maximumBisectorError <= PIOVERTWO)) throw new RangeError('maximumBisectorError must be in (0, PI / 2]')
	if (!Number.isFinite(resolved.intersectionMargin) || !(resolved.intersectionMargin >= 0)) throw new RangeError('intersectionMargin must be finite and non-negative')
	validateUnitInterval(resolved.minimumCandidateSeparation, 'minimumCandidateSeparation')
	validateUnitInterval(resolved.minimumCoverage, 'minimumCoverage')
	validateUnitInterval(resolved.minimumBalance, 'minimumBalance')
	if (!Number.isFinite(resolved.maximumResidual) || !(resolved.maximumResidual > 0)) throw new RangeError('maximumResidual must be finite and positive')
	if (!Number.isFinite(resolved.focusTolerance) || !(resolved.focusTolerance > 0)) throw new RangeError('focusTolerance must be finite and positive')
	if (!Number.isFinite(resolved.maximumUncertainty) || !(resolved.maximumUncertainty > 0)) throw new RangeError('maximumUncertainty must be finite and positive')
	if (!Number.isFinite(resolved.focusSigma) || !(resolved.focusSigma > 0)) throw new RangeError('focusSigma must be finite and positive')
	validateUnitInterval(resolved.minimumConfidence, 'minimumConfidence')
	return resolved
}

// Enumerates central/external assignments, applies geometric gates, and sorts by descending score.
function selectTriplets(fitted: readonly BahtinovFittedCandidate[], preprocessed: BahtinovPreprocessSuccess, expected: BahtinovExpectedPattern | undefined, options: ResolvedBahtinovDecisionOptions): readonly BahtinovTripletCandidate[] {
	const triplets: BahtinovTripletCandidate[] = []
	let maximumStrength = 0
	const saturationRetentions = preprocessed.workspace.statistics
	for (let index = 0; index < fitted.length; index++) {
		maximumStrength = Math.max(maximumStrength, fitted[index].line.strength)
		saturationRetentions[index] = bahtinovLineSaturationRetention(fitted[index].line, preprocessed)
	}

	for (let central = 0; central < fitted.length; central++) {
		for (let first = 0; first < fitted.length - 1; first++) {
			if (first === central) continue
			for (let second = first + 1; second < fitted.length; second++) {
				if (second === central) continue
				const centralLine = fitted[central].line
				const firstLine = fitted[first].line
				const secondLine = fitted[second].line
				if (!linePasses(centralLine, options) || !linePasses(firstLine, options) || !linePasses(secondLine, options)) continue
				if (
					bahtinovAxialAngleDistance(centralLine.normalAngle, firstLine.normalAngle) < options.minimumAxialSeparation ||
					bahtinovAxialAngleDistance(centralLine.normalAngle, secondLine.normalAngle) < options.minimumAxialSeparation ||
					bahtinovAxialAngleDistance(firstLine.normalAngle, secondLine.normalAngle) < options.minimumAxialSeparation
				)
					continue

				const intersection = intersectBahtinovLines(firstLine, secondLine)
				if (!intersection || !pointInsideExpandedArea(intersection.point, preprocessed.area, options.intersectionMargin)) continue
				const [shortArcBisector] = bahtinovAxialBisectors(firstLine.normalAngle, secondLine.normalAngle)
				const bisectorError = bahtinovAxialAngleDistance(centralLine.normalAngle, shortArcBisector)
				if (bisectorError > options.maximumBisectorError) continue

				const expectedMismatch = expectedPatternMismatch(centralLine, firstLine, secondLine, expected)
				const expectedLimit = expected?.maximumAngleDelta
				if (expectedLimit !== undefined && expectedMismatch > expectedLimit) continue
				const expectedScale = expectedLimit ?? DEFAULT_EXPECTED_PRIOR_SCALE
				const expectedFactor = expected ? Math.max(0.25, 1 - Math.min(1, expectedMismatch / expectedScale)) : 1
				const minimumStrength = Math.min(centralLine.strength, firstLine.strength, secondLine.strength)
				const minimumCoverage = Math.min(centralLine.coverage, firstLine.coverage, secondLine.coverage)
				const minimumCropCoverage = Math.min(centralLine.cropCoverage, firstLine.cropCoverage, secondLine.cropCoverage)
				const minimumBalance = Math.min(centralLine.balance, firstLine.balance, secondLine.balance)
				const maximumResidual = Math.max(centralLine.residual, firstLine.residual, secondLine.residual)
				const minimumSignal = Math.min(centralLine.signalToNoise, firstLine.signalToNoise, secondLine.signalToNoise)
				const saturationRetention = Math.min(saturationRetentions[central], saturationRetentions[first], saturationRetentions[second])
				const quality: BahtinovQuality = {
					signal: saturatingRatio(minimumSignal, options.minimumSignalToNoise),
					lineStrength: maximumStrength > 0 ? Math.max(0, Math.min(1, minimumStrength / maximumStrength)) : 0,
					lineCoverage: minimumCoverage,
					lineBalance: minimumBalance,
					lineFit: Math.max(MINIMUM_ACCEPTED_QUALITY, 1 - maximumResidual / options.maximumResidual),
					angularSymmetry: Math.max(MINIMUM_ACCEPTED_QUALITY, 1 - bisectorError / options.maximumBisectorError),
					intersectionCondition: intersection.condition,
					saturationRetention,
					cropCoverage: minimumCropCoverage,
					candidateSeparation: 1,
				}
				const score = geometricQualityMean(quality) * expectedFactor
				if (!(score > 0) || !Number.isFinite(score)) continue
				triplets.push({
					central,
					external: [first, second],
					reference: intersection.point,
					intersectionCondition: intersection.condition,
					bisectorError,
					expectedMismatch,
					score,
					quality,
				})
			}
		}
	}
	triplets.sort((first, second) => second.score - first.score || first.central - second.central || first.external[0] - second.external[0] || first.external[1] - second.external[1])
	return triplets
}

// Applies per-line signal, support, and residual gates.
function linePasses(line: BahtinovLine, options: ResolvedBahtinovDecisionOptions): boolean {
	return Number.isFinite(line.signalToNoise) && line.signalToNoise >= options.minimumSignalToNoise && line.coverage >= options.minimumCoverage && line.balance >= options.minimumBalance && line.residual <= options.maximumResidual
}

// Tests whether a finite point lies in the inclusive pixel-center ROI expanded by a pixel margin.
function pointInsideExpandedArea(point: Readonly<Point>, area: Readonly<Rect>, margin: number): boolean {
	return point.x >= area.left - margin && point.x <= area.right - 1 + margin && point.y >= area.top - margin && point.y <= area.bottom - 1 + margin
}

// Measures the largest axial difference from an optional expected mask pattern.
function expectedPatternMismatch(central: BahtinovLine, first: BahtinovLine, second: BahtinovLine, expected: BahtinovExpectedPattern | undefined): number {
	if (!expected) return 0
	const centralDifference = bahtinovAxialAngleDistance(central.normalAngle, expected.centralNormalAngle)
	const direct = Math.max(bahtinovAxialAngleDistance(first.normalAngle, expected.externalNormalAngles[0]), bahtinovAxialAngleDistance(second.normalAngle, expected.externalNormalAngles[1]))
	const swapped = Math.max(bahtinovAxialAngleDistance(first.normalAngle, expected.externalNormalAngles[1]), bahtinovAxialAngleDistance(second.normalAngle, expected.externalNormalAngles[0]))
	return Math.max(centralDifference, Math.min(direct, swapped))
}

// Validates the optional mask-layout contract before any image-dependent pipeline stage.
function validateExpectedPattern(expected: BahtinovExpectedPattern | undefined): void {
	if (!expected) return
	const external = expected.externalNormalAngles
	if (!external || external.length !== 2 || !Number.isFinite(expected.centralNormalAngle) || !Number.isFinite(external[0]) || !Number.isFinite(external[1])) throw new RangeError('expected Bahtinov angles must be finite')
	if (expected.maximumAngleDelta !== undefined && (!Number.isFinite(expected.maximumAngleDelta) || !(expected.maximumAngleDelta > 0 && expected.maximumAngleDelta <= PIOVERTWO))) throw new RangeError('expected maximumAngleDelta must be in (0, PI / 2]')
}

// Propagates independent line covariances to focus error through central differences.
function propagateFocusUncertainty(central: BahtinovLine, first: BahtinovLine, second: BahtinovLine): number | undefined {
	if (!central.covariance || !first.covariance || !second.covariance) return undefined
	const lines = [central, first, second] as const
	let variance = 0
	for (let lineIndex = 0; lineIndex < 3; lineIndex++) {
		const line = lines[lineIndex]
		const angleStep = UNCERTAINTY_ANGLE_STEP
		const distanceStep = Math.max(UNCERTAINTY_DISTANCE_STEP, Math.abs(line.distance) * UNCERTAINTY_DISTANCE_STEP)
		const angleDerivative = focusErrorDerivative(lines, lineIndex, angleStep, true)
		const distanceDerivative = focusErrorDerivative(lines, lineIndex, distanceStep, false)
		if (!Number.isFinite(angleDerivative) || !Number.isFinite(distanceDerivative)) return undefined
		const covariance = line.covariance
		if (!covariance) return undefined
		const [varianceAngle, covarianceAngleDistance, varianceDistance] = covariance
		const contribution = angleDerivative * angleDerivative * varianceAngle + 2 * angleDerivative * distanceDerivative * covarianceAngleDistance + distanceDerivative * distanceDerivative * varianceDistance
		if (!Number.isFinite(contribution)) return undefined
		variance += contribution
	}
	if (!Number.isFinite(variance) || variance < -1e-12) return undefined
	return Math.sqrt(Math.max(0, variance))
}

// Computes one central-difference derivative of focus error with respect to a line parameter.
function focusErrorDerivative(lines: readonly [BahtinovLine, BahtinovLine, BahtinovLine], lineIndex: number, step: number, angle: boolean): number {
	const plus = perturbedFocusError(lines, lineIndex, step, angle)
	const minus = perturbedFocusError(lines, lineIndex, -step, angle)
	return plus === undefined || minus === undefined ? Number.NaN : (plus - minus) / (2 * step)
}

// Evaluates focus error after perturbing one raw line angle or distance without canonical wrapping.
function perturbedFocusError(lines: readonly [BahtinovLine, BahtinovLine, BahtinovLine], lineIndex: number, delta: number, angle: boolean): number | undefined {
	const parameters = lines.map((line, index) => ({
		normalAngle: line.normalAngle + (angle && index === lineIndex ? delta : 0),
		distance: line.distance + (!angle && index === lineIndex ? delta : 0),
	}))
	const intersection = intersectBahtinovLines(parameters[1], parameters[2])
	if (!intersection) return undefined
	return Math.cos(parameters[0].normalAngle) * intersection.point.x + Math.sin(parameters[0].normalAngle) * intersection.point.y - parameters[0].distance
}

// Classifies a focus interval only when uncertainty and aggregate confidence are trustworthy.
function classifyFocus(absoluteError: number, uncertainty: number | undefined, confidence: number, options: ResolvedBahtinovDecisionOptions): BahtinovFocusState {
	if (confidence < options.minimumConfidence || uncertainty === undefined || uncertainty > options.maximumUncertainty) return 'indeterminate'
	const lowerError = Math.max(0, absoluteError - options.focusSigma * uncertainty)
	const upperError = absoluteError + options.focusSigma * uncertainty
	if (upperError <= options.focusTolerance) return 'focused'
	if (lowerError > options.focusTolerance) return 'defocused'
	return 'indeterminate'
}

// Builds stable numeric warnings from the selected measurement and thresholds.
function buildWarnings(
	preprocessed: BahtinovPreprocessSuccess,
	triplet: BahtinovTripletCandidate,
	central: BahtinovLine,
	external: readonly [BahtinovLine, BahtinovLine],
	uncertainty: number | undefined,
	options: ResolvedBahtinovDecisionOptions,
	expected: BahtinovExpectedPattern | undefined,
): readonly BahtinovWarning[] {
	const warnings: BahtinovWarning[] = []
	if (preprocessed.background.deviation === 0) warnings.push({ code: 'backgroundUnstable', values: { deviation: 0 } })
	if (preprocessed.coreSaturated) warnings.push({ code: 'coreSaturated', values: { fraction: preprocessed.saturationFraction } })
	if (preprocessed.spikeSaturationFraction > 0) warnings.push({ code: 'spikesSaturated', values: { fraction: preprocessed.spikeSaturationFraction } })
	const lines = [central, external[0], external[1]] as const
	const minimumCoverage = Math.min(lines[0].coverage, lines[1].coverage, lines[2].coverage)
	const minimumCropCoverage = Math.min(lines[0].cropCoverage, lines[1].cropCoverage, lines[2].cropCoverage)
	const minimumBalance = Math.min(lines[0].balance, lines[1].balance, lines[2].balance)
	const maximumResidual = Math.max(lines[0].residual, lines[1].residual, lines[2].residual)
	if (minimumCropCoverage < 0.8) warnings.push({ code: 'patternCropped', values: { coverage: minimumCropCoverage } })
	if (minimumCoverage < Math.max(options.minimumCoverage * 1.5, 0.5)) warnings.push({ code: 'lineCoverageLow', values: { coverage: minimumCoverage } })
	if (minimumBalance < Math.max(options.minimumBalance * 1.5, 0.25)) warnings.push({ code: 'lineSupportUnbalanced', values: { balance: minimumBalance } })
	if (maximumResidual > options.maximumResidual * 0.75) warnings.push({ code: 'lineResidualHigh', values: { residual: maximumResidual } })
	if (!pointInsideExpandedArea(triplet.reference, preprocessed.area, 0)) warnings.push({ code: 'intersectionOutsideArea', values: { x: triplet.reference.x, y: triplet.reference.y } })
	if (expected?.maximumAngleDelta !== undefined && triplet.expectedMismatch > expected.maximumAngleDelta) warnings.push({ code: 'expectedPatternMismatch', values: { angle: triplet.expectedMismatch } })
	if (uncertainty === undefined) warnings.push({ code: 'uncertaintyUnavailable' })
	else if (uncertainty > options.maximumUncertainty) warnings.push({ code: 'uncertaintyHigh', values: { uncertainty } })
	return warnings
}

// Creates one content-level failure after preprocessing succeeded.
function analysisFailure(reason: BahtinovAnalysisFailure['reason'], preprocessed: BahtinovPreprocessSuccess, warnings: readonly BahtinovWarning[]): BahtinovAnalysisFailure {
	return {
		success: false,
		reason,
		area: { ...preprocessed.area },
		warnings,
	}
}

// Computes the geometric mean of ten normalized quality components.
function geometricQualityMean(quality: BahtinovQuality): number {
	const product = quality.signal * quality.lineStrength * quality.lineCoverage * quality.lineBalance * quality.lineFit * quality.angularSymmetry * quality.intersectionCondition * quality.saturationRetention * quality.cropCoverage * quality.candidateSeparation
	return product > 0 && Number.isFinite(product) ? product ** 0.1 : 0
}

// Maps a positive value to a bounded quality with 0.5 at the supplied scale.
function saturatingRatio(value: number, scale: number): number {
	if (!(value > 0) || !Number.isFinite(value)) return 0
	return value / (value + scale)
}

// Validates one finite inclusive unit-interval option.
function validateUnitInterval(value: number, name: string): void {
	if (!Number.isFinite(value) || !(value >= 0) || !(value <= 1)) throw new RangeError(`${name} must be in [0, 1]`)
}
