import { PI, PIOVERTWO } from '../../../core/constants'
import { medianBySelectionOf, STANDARD_DEVIATION_SCALE } from '../../../core/util'
import type { Point, Rect } from '../../../math/numerical/geometry'
import { bahtinovAxialAngleDistance, bahtinovGlobalLineDistance, canonicalizeBahtinovLine, clipBahtinovLineToArea } from './geometry'
import type { BahtinovHoughCandidate } from './hough'
import type { BahtinovLine, BahtinovRidgePoints, BahtinovWorkspace } from './types'

// Robust weighted TLS refinement for Bahtinov Hough candidates. Fits use local ROI samples and
// return canonical full-image lines with clipped segments, pixel widths, support metrics, and a
// local covariance approximation. Caller-owned scratch buffers are reused and never escape.

// Default normal-distance band around a Hough peak used to collect ridge support, in pixels.
const DEFAULT_SUPPORT_RADIUS = 3
// Default number of Huber reweighting iterations.
const DEFAULT_ROBUST_ITERATIONS = 5
// Standard Huber transition in normalized residual units.
const HUBER_TUNING = 1.345
// Gaussian FWHM-to-sigma factor.
const SIGMA_TO_FWHM = 2.3548200450309493
// Small positive floor used only in robust scale and covariance denominators.
const NUMERICAL_FLOOR = 1e-12
// Angular change below which robust TLS iteration is considered converged, in radians.
const ANGLE_CONVERGENCE_TOLERANCE = 1e-5
// Normal-distance change below which robust TLS iteration is considered converged, in pixels.
const DISTANCE_CONVERGENCE_TOLERANCE = 1e-3
// Transverse profile bin spacing used for half-maximum interpolation, in pixels.
const PROFILE_BIN_STEP = 1

// Controls for robust local line fitting and acceptance.
export interface BahtinovLineFitOptions {
	// Maximum normal distance from the Hough candidate used as support, in pixels.
	readonly supportRadius?: number
	// Number of Huber reweighting iterations.
	readonly robustIterations?: number
	// Minimum number of ridge points required by a fitted line.
	readonly minimumSupport?: number
	// Maximum allowed robust RMS orthogonal residual in pixels.
	readonly maximumResidual?: number
	// Gaussian sigma already applied to the source profile, in pixels; used to deconvolve FWHM.
	readonly profileBlurSigma?: number
	// Approximate star center in local ROI pixel coordinates; defaults to the ROI midpoint.
	readonly center?: Readonly<Point>
}

// One fitted line paired with the Hough score that seeded it.
export interface BahtinovFittedCandidate {
	// Canonical fitted line in full-image coordinates.
	readonly line: BahtinovLine
	// Coarse-to-fine Hough score used for candidate ranking.
	readonly houghScore: number
}

// Robustly refines one local Hough candidate and returns a full-image line.
// `responseDeviation` is the signed-DoG noise scale and `area` is a half-open full-image ROI.
export function fitBahtinovLine(candidate: BahtinovHoughCandidate, ridgePoints: BahtinovRidgePoints, area: Readonly<Rect>, responseDeviation: number, workspace: BahtinovWorkspace, options: BahtinovLineFitOptions = {}): BahtinovLine | undefined {
	validateFitInput(candidate, ridgePoints, area, responseDeviation, workspace)
	const supportRadius = options.supportRadius ?? DEFAULT_SUPPORT_RADIUS
	const robustIterations = options.robustIterations ?? DEFAULT_ROBUST_ITERATIONS
	const minimumSupport = options.minimumSupport ?? 8
	const maximumResidual = options.maximumResidual ?? Number.POSITIVE_INFINITY
	const profileBlurSigma = options.profileBlurSigma ?? 0
	if (!Number.isFinite(supportRadius) || supportRadius <= 0) throw new RangeError('supportRadius must be finite and positive')
	if (!Number.isInteger(robustIterations) || robustIterations < 1 || robustIterations > 20) throw new RangeError('robustIterations must be an integer from 1 to 20')
	if (!Number.isInteger(minimumSupport) || minimumSupport < 3) throw new RangeError('minimumSupport must be an integer at least 3')
	if (!(maximumResidual > 0) || Number.isNaN(maximumResidual)) throw new RangeError('maximumResidual must be positive')
	if (!Number.isFinite(profileBlurSigma) || profileBlurSigma < 0) throw new RangeError('profileBlurSigma must be finite and non-negative')

	const localWidth = area.right - area.left
	const localHeight = area.bottom - area.top
	const centerX = options.center?.x ?? (localWidth - 1) * 0.5
	const centerY = options.center?.y ?? (localHeight - 1) * 0.5
	if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || centerX < 0 || centerX > localWidth - 1 || centerY < 0 || centerY > localHeight - 1) throw new RangeError('Bahtinov line-fit center must be finite and inside the local ROI')
	let normalAngle = candidate.normalAngle
	let distance = candidate.distance
	let supportCount = 0
	let robustScale = 0

	for (let iteration = 0; iteration < robustIterations; iteration++) {
		supportCount = collectResiduals(ridgePoints, candidate, normalAngle, distance, supportRadius, workspace.statistics)
		if (supportCount < minimumSupport) return undefined
		robustScale = medianBySelectionOf(workspace.statistics, supportCount) * STANDARD_DEVIATION_SCALE
		const moments = weightedImageMoments(candidate, normalAngle, distance, supportRadius, robustScale, localWidth, localHeight, workspace)
		if (!moments || moments.count < minimumSupport) return undefined

		const tangentAngle = 0.5 * Math.atan2(2 * moments.covarianceXY, moments.covarianceXX - moments.covarianceYY)
		const fitted = canonicalizeBahtinovLine(tangentAngle + PIOVERTWO, 0)
		const nextDistance = moments.centerX * Math.cos(fitted.normalAngle) + moments.centerY * Math.sin(fitted.normalAngle)
		if (!Number.isFinite(nextDistance) || bahtinovAxialAngleDistance(candidate.normalAngle, fitted.normalAngle) > PI / 12) return undefined
		const angleChange = bahtinovAxialAngleDistance(normalAngle, fitted.normalAngle)
		const distanceChange = Math.abs(distance - nextDistance)
		normalAngle = fitted.normalAngle
		distance = nextDistance
		if (angleChange <= ANGLE_CONVERGENCE_TOLERANCE && distanceChange <= DISTANCE_CONVERGENCE_TOLERANCE) break
	}

	const metrics = lineMetrics(ridgePoints, candidate, normalAngle, distance, supportRadius, robustScale, localWidth, localHeight, centerX, centerY)
	if (!metrics || metrics.count < minimumSupport || metrics.residual > maximumResidual) return undefined
	const globalDistance = bahtinovGlobalLineDistance(distance, normalAngle, area)
	const segment = clipBahtinovLineToArea({ normalAngle, distance: globalDistance }, area)
	if (!segment) return undefined
	const signalToNoise = metrics.strength / Math.max(NUMERICAL_FLOOR, responseDeviation * Math.sqrt(metrics.count))
	const localCovariance = imageFitCovariance(candidate, normalAngle, distance, supportRadius, localWidth, localHeight, workspace)
	const covariance = localCovariance ? globalLineCovariance(localCovariance, normalAngle, area.left, area.top) : undefined
	const fwhm = transverseProfileFwhm(normalAngle, distance, supportRadius, profileBlurSigma, localWidth, localHeight, workspace)
	if (fwhm === undefined) return undefined

	return {
		normalAngle,
		distance: globalDistance,
		strength: metrics.strength,
		signalToNoise,
		fwhm,
		coverage: metrics.coverage,
		cropCoverage: metrics.cropCoverage,
		balance: metrics.balance,
		residual: metrics.residual,
		covariance,
		segment,
	}
}

// Transforms angle-distance covariance from ROI-local to full-image line coordinates.
// `left` and `top` are the ROI origin in pixels; the returned tuple follows `[var(angle), cov(angle, distance), var(distance)]`.
function globalLineCovariance(covariance: readonly [number, number, number], normalAngle: number, left: number, top: number): readonly [number, number, number] | undefined {
	const [varianceAngle, covarianceAngleDistance, varianceDistance] = covariance
	const distanceAngleDerivative = -left * Math.sin(normalAngle) + top * Math.cos(normalAngle)
	const globalCovarianceAngleDistance = covarianceAngleDistance + distanceAngleDerivative * varianceAngle
	const globalVarianceDistance = varianceDistance + 2 * distanceAngleDerivative * covarianceAngleDistance + distanceAngleDerivative * distanceAngleDerivative * varianceAngle
	return Number.isFinite(globalCovarianceAngleDistance) && Number.isFinite(globalVarianceDistance) && globalVarianceDistance >= 0 ? [varianceAngle, globalCovarianceAngleDistance, globalVarianceDistance] : undefined
}

// Estimates line covariance from positive response-profile samples inside the fit-support band.
function imageFitCovariance(candidate: BahtinovHoughCandidate, normalAngle: number, distance: number, supportRadius: number, width: number, height: number, workspace: BahtinovWorkspace): readonly [number, number, number] | undefined {
	const candidateX = Math.cos(candidate.normalAngle)
	const candidateY = Math.sin(candidate.normalAngle)
	const normalX = Math.cos(normalAngle)
	const normalY = Math.sin(normalAngle)
	const tangentX = -normalY
	const tangentY = normalX
	const solveX = Math.abs(candidateX) >= Math.abs(candidateY)
	const denominator = solveX ? candidateX : candidateY
	const crossCoefficient = solveX ? candidateY : candidateX
	const innerLimit = solveX ? width : height
	const outerLimit = solveX ? height : width
	const halfSpan = supportRadius / Math.abs(denominator)
	let weightSum = 0
	let squaredWeightSum = 0
	let tangentMean = 0
	let squaredResidual = 0
	let tangentVarianceSum = 0

	for (let outer = 0; outer < outerLimit; outer++) {
		const center = (candidate.distance - crossCoefficient * outer) / denominator
		const first = Math.max(0, Math.ceil(center - halfSpan))
		const last = Math.min(innerLimit - 1, Math.floor(center + halfSpan))
		for (let inner = first; inner <= last; inner++) {
			const x = solveX ? inner : outer
			const y = solveX ? outer : inner
			const index = y * width + x
			const weight = workspace.response[index]
			if (workspace.mask[index] !== 0 || !(weight > 0) || Math.abs(x * candidateX + y * candidateY - candidate.distance) > supportRadius) continue
			const residual = x * normalX + y * normalY - distance
			const tangent = x * tangentX + y * tangentY
			const nextWeightSum = weightSum + weight
			const tangentDelta = tangent - tangentMean
			tangentMean += (weight / nextWeightSum) * tangentDelta
			tangentVarianceSum += weight * tangentDelta * (tangent - tangentMean)
			weightSum = nextWeightSum
			squaredWeightSum += weight * weight
			squaredResidual += weight * residual * residual
		}
	}
	if (!(weightSum > 0) || !(squaredWeightSum > 0)) return undefined
	const longitudinalVariance = Math.max(0, tangentVarianceSum / weightSum)
	const residualVariance = squaredResidual / weightSum
	const effectiveCount = (weightSum * weightSum) / squaredWeightSum
	if (!Number.isFinite(residualVariance) || !(longitudinalVariance > NUMERICAL_FLOOR) || !(effectiveCount > 2)) return undefined
	const varianceDistance = residualVariance / effectiveCount
	const varianceAngle = varianceDistance / longitudinalVariance
	const covarianceAngleDistance = tangentMean * varianceAngle
	const originVarianceDistance = varianceDistance + tangentMean * tangentMean * varianceAngle
	return Number.isFinite(varianceAngle) && Number.isFinite(covarianceAngleDistance) && Number.isFinite(originVarianceDistance) ? [varianceAngle, covarianceAngleDistance, originVarianceDistance] : undefined
}

// Measures transverse half-maximum crossings from the linear narrow-blur profile and removes known blur.
function transverseProfileFwhm(normalAngle: number, distance: number, supportRadius: number, profileBlurSigma: number, width: number, height: number, workspace: BahtinovWorkspace): number | undefined {
	const normalX = Math.cos(normalAngle)
	const normalY = Math.sin(normalAngle)
	const first = -distance
	const second = (width - 1) * normalX - distance
	const third = (height - 1) * normalY - distance
	const fourth = (width - 1) * normalX + (height - 1) * normalY - distance
	const minimumBin = Math.floor(Math.min(first, second, third, fourth))
	const maximumBin = Math.ceil(Math.max(first, second, third, fourth))
	const binCount = maximumBin - minimumBin + 1
	if (!Number.isSafeInteger(binCount) || binCount < 3 || binCount > workspace.statistics.length || binCount > workspace.intermediate.length) return undefined
	const sums = workspace.statistics
	const counts = workspace.intermediate
	sums.fill(0, 0, binCount)
	counts.fill(0, 0, binCount)

	for (let y = 0; y < height; y++) {
		const row = y * width
		for (let x = 0; x < width; x++) {
			const index = row + x
			if (workspace.mask[index] !== 0) continue
			const value = workspace.profile[index]
			if (!Number.isFinite(value) || value < 0) continue
			const bin = Math.round((x * normalX + y * normalY - distance - minimumBin) / PROFILE_BIN_STEP)
			if (bin < 0 || bin >= binCount) continue
			sums[bin] += value
			counts[bin]++
		}
	}

	const centerBin = -minimumBin
	const peakRadius = Math.max(2, Math.ceil(supportRadius))
	const firstPeakBin = Math.max(0, centerBin - peakRadius)
	const lastPeakBin = Math.min(binCount - 1, centerBin + peakRadius)
	let peakBin = firstPeakBin
	let peak = 0
	for (let bin = firstPeakBin; bin <= lastPeakBin; bin++) {
		if (counts[bin] <= 0) continue
		const value = sums[bin] / counts[bin]
		sums[bin] = value
		if (value > peak) {
			peak = value
			peakBin = bin
		}
	}
	if (!(peak > 0)) return undefined
	for (let bin = 0; bin < binCount; bin++) {
		if (bin >= firstPeakBin && bin <= lastPeakBin) continue
		sums[bin] = counts[bin] > 0 ? sums[bin] / counts[bin] : 0
	}

	const halfMaximum = peak * 0.5
	let leftBin = peakBin
	while (leftBin > 0 && sums[leftBin] > halfMaximum) leftBin--
	let rightBin = peakBin
	while (rightBin + 1 < binCount && sums[rightBin] > halfMaximum) rightBin++
	if (leftBin === 0 || rightBin === binCount - 1 || leftBin === peakBin || rightBin === peakBin) return undefined
	const leftCrossing = interpolateProfileCrossing(leftBin, sums[leftBin], leftBin + 1, sums[leftBin + 1], halfMaximum)
	const rightCrossing = interpolateProfileCrossing(rightBin - 1, sums[rightBin - 1], rightBin, sums[rightBin], halfMaximum)
	const observedFwhm = (rightCrossing - leftCrossing) * PROFILE_BIN_STEP
	if (!(observedFwhm > 0) || !Number.isFinite(observedFwhm)) return undefined
	if (!(profileBlurSigma > 0)) return observedFwhm
	const observedSigmaSquared = (observedFwhm / SIGMA_TO_FWHM) ** 2
	const sourceSigmaSquared = observedSigmaSquared - profileBlurSigma * profileBlurSigma
	return sourceSigmaSquared > 0 ? Math.sqrt(sourceSigmaSquared) * SIGMA_TO_FWHM : undefined
}

// Linearly interpolates one half-maximum crossing between adjacent profile bins.
function interpolateProfileCrossing(firstBin: number, firstValue: number, secondBin: number, secondValue: number, target: number): number {
	const difference = secondValue - firstValue
	return difference === 0 ? (firstBin + secondBin) * 0.5 : firstBin + (target - firstValue) / difference
}

// Refines all Hough candidates and retains only finite accepted lines.
export function fitBahtinovLines(candidates: readonly BahtinovHoughCandidate[], ridgePoints: BahtinovRidgePoints, area: Readonly<Rect>, responseDeviation: number, workspace: BahtinovWorkspace, options: BahtinovLineFitOptions = {}): readonly BahtinovFittedCandidate[] {
	const fitted: BahtinovFittedCandidate[] = []
	for (let index = 0; index < candidates.length; index++) {
		const line = fitBahtinovLine(candidates[index], ridgePoints, area, responseDeviation, workspace, options)
		if (line) fitted.push({ line, houghScore: candidates[index].score })
	}
	return fitted
}

// Collects absolute residuals of points selected by the original Hough support band.
function collectResiduals(ridgePoints: BahtinovRidgePoints, candidate: BahtinovHoughCandidate, normalAngle: number, distance: number, supportRadius: number, scratch: Float32Array | Float64Array): number {
	const candidateX = Math.cos(candidate.normalAngle)
	const candidateY = Math.sin(candidate.normalAngle)
	const normalX = Math.cos(normalAngle)
	const normalY = Math.sin(normalAngle)
	let count = 0
	for (let index = 0; index < ridgePoints.count; index++) {
		const candidateResidual = ridgePoints.x[index] * candidateX + ridgePoints.y[index] * candidateY - candidate.distance
		if (Math.abs(candidateResidual) > supportRadius) continue
		scratch[count++] = Math.abs(ridgePoints.x[index] * normalX + ridgePoints.y[index] * normalY - distance)
	}
	return count
}

// Computes Huber-reweighted centroid and covariance from positive signed-DoG samples.
function weightedImageMoments(
	candidate: BahtinovHoughCandidate,
	normalAngle: number,
	distance: number,
	supportRadius: number,
	robustScale: number,
	width: number,
	height: number,
	workspace: BahtinovWorkspace,
): { readonly count: number; readonly centerX: number; readonly centerY: number; readonly covarianceXX: number; readonly covarianceXY: number; readonly covarianceYY: number } | undefined {
	const candidateX = Math.cos(candidate.normalAngle)
	const candidateY = Math.sin(candidate.normalAngle)
	const normalX = Math.cos(normalAngle)
	const normalY = Math.sin(normalAngle)
	const huberLimit = HUBER_TUNING * Math.max(NUMERICAL_FLOOR, robustScale)
	const solveX = Math.abs(candidateX) >= Math.abs(candidateY)
	const denominator = solveX ? candidateX : candidateY
	const crossCoefficient = solveX ? candidateY : candidateX
	const innerLimit = solveX ? width : height
	const outerLimit = solveX ? height : width
	const halfSpan = supportRadius / Math.abs(denominator)
	let count = 0
	let weightSum = 0
	let centerX = 0
	let centerY = 0
	let covarianceXX = 0
	let covarianceXY = 0
	let covarianceYY = 0

	for (let outer = 0; outer < outerLimit; outer++) {
		const center = (candidate.distance - crossCoefficient * outer) / denominator
		const first = Math.max(0, Math.ceil(center - halfSpan))
		const last = Math.min(innerLimit - 1, Math.floor(center + halfSpan))
		for (let inner = first; inner <= last; inner++) {
			const x = solveX ? inner : outer
			const y = solveX ? outer : inner
			const index = y * width + x
			if (workspace.mask[index] !== 0 || !(workspace.response[index] > 0)) continue
			if (Math.abs(x * candidateX + y * candidateY - candidate.distance) > supportRadius) continue
			const residual = Math.abs(x * normalX + y * normalY - distance)
			const robustWeight = residual <= huberLimit ? 1 : huberLimit / residual
			const weight = workspace.response[index] * robustWeight
			if (!(weight > 0)) continue
			const nextWeightSum = weightSum + weight
			const ratio = weight / nextWeightSum
			const dx = x - centerX
			const dy = y - centerY
			centerX += ratio * dx
			centerY += ratio * dy
			const covarianceFactor = weightSum * ratio
			covarianceXX += covarianceFactor * dx * dx
			covarianceXY += covarianceFactor * dx * dy
			covarianceYY += covarianceFactor * dy * dy
			weightSum = nextWeightSum
			count++
		}
	}
	if (!(weightSum > 0)) return undefined
	return { count, centerX, centerY, covarianceXX: covarianceXX / weightSum, covarianceXY: covarianceXY / weightSum, covarianceYY: covarianceYY / weightSum }
}

// Computes final localization residual, coverage, balance, strength, and covariance evidence.
function lineMetrics(
	ridgePoints: BahtinovRidgePoints,
	candidate: BahtinovHoughCandidate,
	normalAngle: number,
	distance: number,
	supportRadius: number,
	robustScale: number,
	width: number,
	height: number,
	centerX: number,
	centerY: number,
):
	| {
			readonly count: number
			readonly strength: number
			readonly effectiveWeight: number
			readonly residual: number
			readonly coverage: number
			readonly cropCoverage: number
			readonly balance: number
			readonly longitudinalVariance: number
	  }
	| undefined {
	const segment = clipBahtinovLineToArea({ normalAngle, distance }, { left: 0, top: 0, right: width, bottom: height })
	if (!segment) return undefined
	const candidateX = Math.cos(candidate.normalAngle)
	const candidateY = Math.sin(candidate.normalAngle)
	const normalX = Math.cos(normalAngle)
	const normalY = Math.sin(normalAngle)
	const tangentX = -normalY
	const tangentY = normalX
	const huberLimit = HUBER_TUNING * Math.max(NUMERICAL_FLOOR, robustScale)
	let count = 0
	let strength = 0
	let effectiveWeight = 0
	let squaredResidual = 0
	let longitudinalMean = 0
	let longitudinalSquared = 0
	let minimumTangent = Number.POSITIVE_INFINITY
	let maximumTangent = Number.NEGATIVE_INFINITY
	let negativeStrength = 0
	let positiveStrength = 0

	for (let index = 0; index < ridgePoints.count; index++) {
		const x = ridgePoints.x[index]
		const y = ridgePoints.y[index]
		if (Math.abs(x * candidateX + y * candidateY - candidate.distance) > supportRadius) continue
		const residual = x * normalX + y * normalY - distance
		const absoluteResidual = Math.abs(residual)
		const robustWeight = absoluteResidual <= huberLimit ? 1 : huberLimit / absoluteResidual
		const baseWeight = ridgePoints.weight[index]
		const weight = baseWeight * robustWeight
		const tangent = (x - centerX) * tangentX + (y - centerY) * tangentY
		count++
		strength += baseWeight * baseWeight
		effectiveWeight += weight
		squaredResidual += weight * residual * residual
		longitudinalMean += weight * tangent
		longitudinalSquared += weight * tangent * tangent
		minimumTangent = Math.min(minimumTangent, tangent)
		maximumTangent = Math.max(maximumTangent, tangent)
		if (tangent < 0) negativeStrength += baseWeight
		else positiveStrength += baseWeight
	}
	if (!(effectiveWeight > 0) || !Number.isFinite(minimumTangent) || !Number.isFinite(maximumTangent)) return undefined
	const residual = Math.sqrt(squaredResidual / effectiveWeight)
	const segmentLength = Math.hypot(segment[1].x - segment[0].x, segment[1].y - segment[0].y)
	const coverage = segmentLength > 0 ? Math.min(1, Math.max(0, (maximumTangent - minimumTangent) / segmentLength)) : 0
	const firstEndpointTangent = (segment[0].x - centerX) * tangentX + (segment[0].y - centerY) * tangentY
	const secondEndpointTangent = (segment[1].x - centerX) * tangentX + (segment[1].y - centerY) * tangentY
	const segmentMinimumTangent = Math.min(firstEndpointTangent, secondEndpointTangent)
	const segmentMaximumTangent = Math.max(firstEndpointTangent, secondEndpointTangent)
	const boundaryTolerance = Math.max(1, supportRadius)
	const boundaryHits = (minimumTangent - segmentMinimumTangent <= boundaryTolerance ? 1 : 0) + (segmentMaximumTangent - maximumTangent <= boundaryTolerance ? 1 : 0)
	const cropCoverage = 1 - boundaryHits * 0.25
	const stronger = Math.max(negativeStrength, positiveStrength)
	const balance = stronger > 0 ? Math.min(negativeStrength, positiveStrength) / stronger : 0
	longitudinalMean /= effectiveWeight
	const longitudinalVariance = Math.max(0, longitudinalSquared / effectiveWeight - longitudinalMean * longitudinalMean)
	return { count, strength, effectiveWeight, residual, coverage, cropCoverage, balance, longitudinalVariance }
}

// Validates finite candidate, ridge, ROI, noise, and scratch capacity before fitting.
function validateFitInput(candidate: BahtinovHoughCandidate, ridgePoints: BahtinovRidgePoints, area: Readonly<Rect>, responseDeviation: number, workspace: BahtinovWorkspace): void {
	if (!Number.isFinite(candidate.normalAngle) || !Number.isFinite(candidate.distance) || !Number.isFinite(candidate.score)) throw new RangeError('Bahtinov Hough candidate must be finite')
	if (!Number.isInteger(ridgePoints.count) || ridgePoints.count < 3 || ridgePoints.count > workspace.statistics.length) throw new RangeError('invalid ridge-point count for line fitting')
	if (!Number.isInteger(area.left) || !Number.isInteger(area.top) || !Number.isInteger(area.right) || !Number.isInteger(area.bottom) || area.left >= area.right || area.top >= area.bottom) throw new RangeError('invalid Bahtinov fit area')
	if (!Number.isFinite(responseDeviation) || responseDeviation < 0) throw new RangeError('responseDeviation must be finite and non-negative')
}
