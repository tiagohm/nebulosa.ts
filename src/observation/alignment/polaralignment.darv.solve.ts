import { SIDEREAL_DRIFT_RATE } from '../../core/constants'
import { estimateLeastSquaresConditioning, linearLeastSquares, robustLinearLeastSquares } from '../../math/numerical/least.squares'
import type { Angle } from '../../math/units/angle'
import { darvGeometryFactors, type DarvExposureMode } from './polaralignment.darv'

// Inverse, small-angle DARV geometry. Stellar north drift is radians per SI second; polar errors
// are radians in the three-point convention, relative to the geometric pole. Inputs are unchanged.
// A single component assumes the other is negligible; a joint fit requires independent hour angles.
// Use convertPolarAlignmentAltitudeError from polaralignment.util for a refracted display;
// it converts both mount-pole and target altitudes without changing these geometric solutions.

// Minimum dimensionless sensitivity accepted for a single component (at most 100-fold amplification).
const MIN_GEOMETRY_FACTOR = 0.01
// Maximum weighted design-matrix condition number accepted for a two-component inversion.
const MAX_CONDITION_NUMBER = 100

// One time-oriented, celestial-north drift observation at the exposure midpoint.
export interface DarvDriftObservation {
	// Signed stellar north drift, radians per second, after cancelling commanded RA motion.
	readonly drift: number
	// West-positive hour angle at exposure midpoint, radians.
	readonly hourAngle: Angle
	// Geographic latitude, radians; observations must describe the same mount error.
	readonly latitude: Angle
	// Positive one-sigma drift uncertainty in radians per second; omit on all rows for equal weights.
	readonly uncertainty?: number
}

// Inconclusive inversion, with no fabricated polar errors.
export interface DarvPolarErrorFailure {
	// Discriminates an inconclusive result.
	readonly status: 'inconclusive'
	// Insufficient independent information or a poorly conditioned geometry matrix.
	readonly reason: 'insufficientObservations' | 'geometryDegenerate'
	// Weighted design-matrix condition number; Infinity for rank deficiency.
	readonly conditionNumber: number
}

// One isolated polar component inferred from a signed drift measurement.
export interface DarvPolarErrorComponent {
	// Discriminates a measured result.
	readonly status: 'ok'
	// Mechanical component whose complementary error is assumed negligible.
	readonly mode: DarvExposureMode
	// Signed polar error, radians, relative to the geometric pole.
	readonly error: Angle
	// Propagated one-sigma error in radians when drift uncertainty was supplied.
	readonly uncertainty?: Angle
	// Measured stellar north drift, radians per second.
	readonly drift: number
	// Signed dimensionless coefficient in drift = sidereal rate × factor × error.
	readonly geometryFactor: number
	// Geometry-only score in [0, 1], not a probability or measurement SNR.
	readonly confidence: number
}

// Success or an explicit inability to infer the selected component.
export type DarvPolarErrorComponentResult = DarvPolarErrorComponent | DarvPolarErrorFailure

// Weighted two-component polar-error solution and residual diagnostics.
export interface DarvPolarErrorSolution {
	// Discriminates a measured result.
	readonly status: 'ok'
	// Mount-pole azimuth offset in the three-point convention, radians.
	readonly azimuthError: Angle
	// Signed mount-pole altitude offset in the three-point convention, radians, geometric reference.
	readonly altitudeError: Angle
	// Weighted residual RMS, radians per second.
	readonly residualRms: number
	// Condition number of the final weighted design matrix.
	readonly conditionNumber: number
	// Total number of supplied observations.
	readonly observations: number
	// Number retaining at least half their initial weight.
	readonly inliers: number
}

// Joint solution or an explicit lack of independent geometry.
export type DarvPolarErrorResult = DarvPolarErrorSolution | DarvPolarErrorFailure

// Estimates one component from an observation and mode without mutating either. The complementary
// error must be negligible. Near-zero sensitivity is inconclusive, including latitude at the pole.
export function estimateDarvPolarErrorComponent(observation: Readonly<DarvDriftObservation>, mode: DarvExposureMode): DarvPolarErrorComponentResult {
	const factors = darvGeometryFactors(observation.latitude, observation.hourAngle)
	const geometryFactor = factors[mode === 'azimuth' ? 0 : 1]
	if (Math.abs(geometryFactor) < MIN_GEOMETRY_FACTOR) return { status: 'inconclusive', reason: 'geometryDegenerate', conditionNumber: Infinity }
	const sensitivity = SIDEREAL_DRIFT_RATE * geometryFactor
	return { status: 'ok', mode, error: observation.drift / sensitivity, uncertainty: observation.uncertainty === undefined ? undefined : observation.uncertainty / Math.abs(sensitivity), drift: observation.drift, geometryFactor, confidence: Math.abs(geometryFactor) }
}

// Solves at least two independent observations of the same small polar error using shared weighted
// QR. Uncertainties are positive rad/s; omitted values use the largest supplied uncertainty, or equal
// weights if none were supplied. Weights are normalized to avoid overflow. Optional Huber IRLS
// downweights inconsistent observations (with only two rows no outlier can be identified). A condition
// number above 100 is inconclusive before and after fitting. Newly allocated diagnostics, no IO.
export function solveDarvPolarError(observations: readonly DarvDriftObservation[], robust = false): DarvPolarErrorResult {
	if (observations.length < 2) return { status: 'inconclusive', reason: 'insufficientObservations', conditionNumber: Infinity }

	let minimum = Infinity
	let maximum = 0

	for (const observation of observations) {
		if (observation.uncertainty !== undefined) {
			minimum = Math.min(minimum, observation.uncertainty)
			maximum = Math.max(maximum, observation.uncertainty)
		}
	}

	if (maximum === 0) minimum = maximum = 1

	const design = observations.map((observation) => darvGeometryFactors(observation.latitude, observation.hourAngle))
	const target = observations.map((observation) => observation.drift / SIDEREAL_DRIFT_RATE)
	const weights = observations.map((observation) => (minimum / (observation.uncertainty ?? maximum)) ** 2)
	const conditioning = estimateLeastSquaresConditioning(design, weights)
	if (conditioning.rankDeficient || conditioning.conditionNumber > MAX_CONDITION_NUMBER) return { status: 'inconclusive', reason: 'geometryDegenerate', conditionNumber: conditioning.conditionNumber }

	const robustFit = robust ? robustLinearLeastSquares(design, target, { weights, method: 'huber', tolerance: 1e-12 }) : undefined
	const fit = robustFit ?? linearLeastSquares(design, target, { weights })
	if (fit.rankDeficient || fit.conditionNumber > MAX_CONDITION_NUMBER) return { status: 'inconclusive', reason: 'geometryDegenerate', conditionNumber: fit.conditionNumber }

	const finalWeights = robustFit?.weights ?? weights

	let squared = 0
	let weightSum = 0
	let inliers = 0

	for (let i = 0; i < observations.length; i++) {
		const weight = finalWeights[i]
		squared += weight * fit.residuals[i] ** 2
		weightSum += weight
		if (weight >= weights[i] * 0.5) inliers++
	}

	return { status: 'ok', azimuthError: fit.coefficients[0], altitudeError: fit.coefficients[1], residualRms: Math.sqrt(squared / weightSum) * SIDEREAL_DRIFT_RATE, conditionNumber: fit.conditionNumber, observations: observations.length, inliers }
}
