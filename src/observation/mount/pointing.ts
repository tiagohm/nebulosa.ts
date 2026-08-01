import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import type { Time } from '../../astronomy/time/time'
import { AMIN2RAD, DEG2RAD, PI, PIOVERTWO, TAU } from '../../core/constants'
import { medianOf, percentileOf, rmsOf, STANDARD_DEVIATION_SCALE } from '../../core/util'
import type { PierSide } from '../../devices/indi/device'
import { type Vec3, vecAngle } from '../../math/linear-algebra/vec3'
import { sphericalProjectTangentPlane, sphericalUnprojectTangentPlane } from '../../math/numerical/geometry'
import { estimateLeastSquaresConditioning, leastSquaresCoefficients, linearLeastSquares, predictLinearLeastSquares, type RobustRegressionMethod } from '../../math/numerical/least.squares'
import type { NumberArray } from '../../math/numerical/math'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
// oxfmt-ignore
import { availableContextRequirement, buildEmpiricalPointingFeatureNames, empiricalFeatureRequirement, extractPointingContext, featuresFromContext, normalizePierSide, type PointingContext, type PointingContextRequirement, type PointingFeatureConfiguration, type PointingFrame, type PointingModelInput, type PointingOffset, predictSemiPhysicalOffset, type ResolvedPointingFeatureConfiguration, resolveFeatureConfiguration, SEMI_PHYSICAL_TERM_NAMES, SEMI_PHYSICAL_TERM_REQUIREMENTS, semiPhysicalBasis, type SemiPhysicalTermName, satisfiesContextRequirement } from './pointing.basis'
import { buildLocalPointingResidual, type LocalPointingResidualModel, type LocalPointingResidualOptions, predictLocalPointingResidual, type ResolvedLocalPointingResidualOptions, resolveLocalResidualOptions } from './pointing.local'

// Telescope mount pointing-model fitting and correction. Takes commanded vs plate-solved sky samples
// and fits the systematic pointing error as a local tangent-plane offset (dx east, dy north, radians)
// using three strategies: a linear empirical feature model, a semi-physical TPOINT-style parameter
// model (CH/IH/ID/NP/MA/ME/TF), or a hybrid (physical + empirical residual). Provides sample
// validation, robust (IRLS) fitting, sky-coverage diagnostics, and forward correction of new targets.
// An optional local kNN layer, off by default, interpolates what the global basis leaves behind.
// The basis functions live in `pointing.basis` and the local layer in `pointing.local`.

// Fitting strategy: 'empirical' linear features only, 'semiPhysical' TPOINT-style parameters only,
// 'hybrid' semi-physical model plus an empirical residual correction.
export type PointingModelStrategy = (typeof POINTING_MODEL_STRATEGIES)[number]

// Every fitting strategy, in the order `selectPointingStrategy` tries them.
export const POINTING_MODEL_STRATEGIES = ['semiPhysical', 'hybrid', 'empirical'] as const

// How the angular pointing error is expressed: full gnomonic tangent-plane projection, or a linearized
// small-angle (`dRA·cosDec`, `dDec`) approximation.
export type PointingErrorRepresentation = (typeof POINTING_ERROR_REPRESENTATIONS)[number]

// Every error representation the model accepts.
export const POINTING_ERROR_REPRESENTATIONS = ['vectorTangent', 'smallAngle'] as const

// Every pier-side state, used to validate deserialized support sets.
const PIER_SIDES = ['EAST', 'WEST', 'NEITHER'] as const satisfies readonly PierSide[]

// One commanded-vs-solved calibration point used to fit the model.
export interface PointingSample {
	// Commanded target right ascension (radians).
	targetRightAscension: Angle
	// Commanded target declination (radians).
	targetDeclination: Angle
	// Plate-solved actual right ascension (radians).
	solvedRightAscension: Angle
	// Plate-solved actual declination (radians).
	solvedDeclination: Angle
	// Observation time, required to derive hour angle and altitude context.
	time?: Time
	// Observing-site geodetic latitude (radians), required for altitude and semi-physical terms.
	latitude?: Angle
	// Observing-site longitude (radians, positive east), required for local sidereal time.
	longitude?: Angle
	// Mount pier side at the time of the sample.
	pierSide?: PierSide
	// Radial 1-sigma uncertainty of the solved position (radians), typically the plate-solve error.
	// Samples are weighted by `1/uncertainty²`; omitted or non-positive values weigh as the average.
	uncertainty?: Angle
	// Frame both coordinates are expressed in. Samples declaring a frame other than the fit's are
	// rejected rather than mixed, since the difference would enter the fit as mechanical error. Samples
	// that declare nothing are assumed to be in the fit's frame.
	frame?: PointingFrame
}

// A computed pointing error with its great-circle separation and the representation actually used.
export interface PointingError extends PointingOffset {
	// Great-circle separation between target and solved positions (radians).
	readonly angularSeparation: Angle
	// Representation actually applied; falls back to 'smallAngle' when the tangent projection is singular.
	readonly representationUsed: PointingErrorRepresentation
	// Both representations of the same error, for comparison/diagnostics (radians).
	readonly comparison?: {
		readonly smallAngleDx: number
		readonly smallAngleDy: number
		readonly vectorDx: number
		readonly vectorDy: number
	}
}

// Thresholds controlling which samples are accepted before fitting.
export interface PointingValidationOptions {
	// Reject samples below this altitude (radians).
	readonly minimumAltitude?: Angle
	// Reject samples whose target-to-solved separation exceeds this (radians).
	readonly maximumSampleSeparation?: Angle
	// Reject same-pier-side samples closer than this to an accepted target (radians).
	readonly duplicateTolerance?: Angle
	// Recommended minimum accepted-sample count; below it a warning is emitted.
	readonly minimumSamples?: number
}

// Validation options with all thresholds resolved to concrete values.
export type ResolvedPointingValidationOptions = Required<PointingValidationOptions>

// Robust iteratively-reweighted least-squares configuration.
export interface PointingRobustFitConfiguration {
	// Weighting method; 'none' disables robust reweighting.
	readonly method?: RobustRegressionMethod
	// Maximum IRLS iterations.
	readonly maxIterations?: number
	// Convergence tolerance on the maximum weight change between iterations.
	readonly tolerance?: number
	// Tuning constant scaling the robust influence function.
	readonly tuning?: number
}

// Robust configuration with all fields resolved to concrete values.
export type ResolvedPointingRobustFitConfiguration = Required<PointingRobustFitConfiguration>

// Top-level options controlling a model fit.
export interface PointingFitOptions {
	// Model strategy (default 'hybrid').
	strategy?: PointingModelStrategy
	// Error representation (default 'vectorTangent').
	errorRepresentation?: PointingErrorRepresentation
	// Frame the samples are expressed in (default 'apparentTopocentric'). Samples declaring a different
	// frame are rejected; the model records the frame so later predictions can be checked against it.
	frame?: PointingFrame
	// Tikhonov ridge regularization, relative to the mean design-column energy so its meaning does not
	// drift with the sample count. Applied to the semi-physical block in a hybrid fit.
	ridge?: number
	// Relative ridge applied to the empirical block of a hybrid fit. Larger than `ridge` on purpose:
	// the empirical block is a flexible nuisance basis and should be shrunk harder than the physical one.
	ridgeEmpirical?: number
	// Minimum accepted-sample to free-parameter ratio required to keep a complexity tier (default 3).
	minimumSampleRatio?: number
	// Semi-physical terms to fit (default: every term in `SEMI_PHYSICAL_TERM_NAMES`).
	semiPhysicalTerms?: readonly SemiPhysicalTermName[]
	// Empirical feature toggles.
	featureConfiguration?: PointingFeatureConfiguration
	// Sample validation thresholds.
	validation?: PointingValidationOptions
	// Robust fitting configuration.
	robust?: PointingRobustFitConfiguration
	// Local residual layer, disabled by default. Enable it only for a dense, well spread calibration
	// run: it interpolates what the global basis could not describe, and with sparse samples that is
	// mostly plate-solve noise.
	local?: LocalPointingResidualOptions
}

// Documents the fixed sign and correction conventions of the produced model.
export interface PointingSignConvention {
	// Positive dx points east.
	readonly dxPositive: 'east'
	// Positive dy points north.
	readonly dyPositive: 'north'
	// Correction subtracts the predicted local error from the requested coordinate.
	readonly correctionDirection: 'subtract-predicted-local-error'
}

// Summary of the sky/site region spanned by the training samples.
export interface PointingCoverageSummary {
	// [min, max] hour angle of the samples (radians).
	readonly hourAngleRange?: readonly [Angle, Angle]
	// [min, max] declination of the samples (radians).
	readonly declinationRange?: readonly [Angle, Angle]
	// [min, max] altitude of the samples (radians).
	readonly altitudeRange?: readonly [Angle, Angle]
	// [min, max] site latitude across samples (radians).
	readonly latitudeRange?: readonly [Angle, Angle]
	// [min, max] site longitude across samples (radians).
	readonly longitudeRange?: readonly [Angle, Angle]
	// Number of occupied HA×Dec coverage bins.
	readonly occupiedSkyBins: number
	// Total available coverage bins.
	readonly totalSkyBins: number
	// Occupied/total bin ratio in [0, 1].
	readonly skyCoverageRatio: number
}

// Post-fit residual statistics and quality flags.
export interface PointingDiagnostics {
	// Total submitted samples.
	readonly totalSamples: number
	// Samples that passed validation.
	readonly validSamples: number
	// Samples rejected during validation.
	readonly rejectedSamples: number
	// RMS of east residuals (radians).
	readonly rmsDx: number
	// RMS of north residuals (radians).
	readonly rmsDy: number
	// RMS of radial residuals.
	readonly angularRms: Angle
	// Median radial residual.
	readonly medianResidual: Angle
	// Radial residual percentiles.
	readonly residualPercentiles: {
		readonly p50: Angle
		readonly p90: Angle
		readonly p95: Angle
	}
	// Dominant design-matrix condition number for the selected strategy.
	readonly conditionNumber: number
	// Sky/site coverage summary.
	readonly skyCoverage: PointingCoverageSummary
	// Accepted-sample count per pier side.
	readonly perPierSideSampleCounts: Readonly<Record<PierSide, number>>
	// Human-readable warnings about fit quality.
	readonly warnings: readonly string[]
	// Count of rejected samples by reason.
	readonly rejectedReasonCounts: Readonly<Record<string, number>>
	// Observing context every accepted sample supports; terms needing more were dropped.
	readonly supportedContext: PointingContextRequirement
	// Semi-physical terms and empirical features removed before fitting, with the reason.
	readonly droppedTerms: readonly string[]
	// RMS of the leave-one-out radial residuals (radians), or `undefined` when they could not be produced.
	// Unlike `angularRms`, this does not fall as parameters are added unless they genuinely predict, so
	// it is the metric to compare strategies with. A robust fit obtains it from one refit per sample; a
	// fixed-weight fit from the leverage identity, which is exact there.
	readonly looRms?: Angle
	// Leave-one-out radial residual percentiles (radians).
	readonly looResidualPercentiles?: {
		readonly p50: Angle
		readonly p90: Angle
		readonly p95: Angle
	}
}

// Training directions retained on the model so predictions can measure their distance to real samples.
export interface PointingSupportSet {
	// Unit vectors of the accepted training targets, flattened as `[x0, y0, z0, x1, ...]`.
	readonly directions: readonly number[]
	// Pier side of each training sample, aligned with `directions`.
	readonly pierSides: readonly PierSide[]
	// Characteristic sample spacing (radians): the median k-th neighbour distance of the training set.
	// Used as the decay length of `PointingPredictionQuality.support`.
	readonly scale: Angle
}

// Indicates how trustworthy a single prediction is relative to the training coverage.
export interface PointingPredictionQuality {
	// Angular distance to the closest training sample (radians), `Infinity` without support data.
	readonly nearestSampleDistance: Angle
	// Angular distance to the k-th closest training sample (radians), with k = `SUPPORT_NEIGHBORS`.
	readonly kthNeighborDistance: Angle
	// Continuous support in [0, 1]: `exp(-max(0, kthNeighborDistance - supportScale) / supportScale)`.
	// Stays at 1 while the direction is as well surrounded as a typical training sample, then decays
	// smoothly as it moves away from the sampled region, unlike a hard inside/outside test.
	readonly support: number
	// True when `support` falls below the usable threshold, meaning the model is extrapolating.
	readonly extrapolating: boolean
	// True when the requested pier side was represented during training.
	readonly pierSideCovered: boolean
	// Per-prediction warnings.
	readonly warnings: readonly string[]
}

// A predicted error broken down into its model components plus a quality assessment.
//
// Deliberately not a `PointingError`: that type's `angularSeparation` is the great-circle distance
// between two measured positions, while a prediction only has an offset, whose magnitude in the
// tangent plane is `hypot(dx, dy)`. The two agree to first order and diverge with the offset size, so
// they carry different names.
export interface PredictedPointingError extends PointingOffset {
	// Magnitude of the predicted tangent-plane offset (radians), `hypot(dx, dy)`.
	readonly offsetMagnitude: Angle
	// Representation the offsets are expressed in.
	readonly representationUsed: PointingErrorRepresentation
	// Trust assessment for this prediction.
	readonly quality: PointingPredictionQuality
	// Individual contributions from each model component (radians).
	readonly components: {
		readonly physical?: PointingOffset
		readonly empirical?: PointingOffset
		readonly residual?: PointingOffset
		// Local kNN layer, present only when the model carries one and is usable.
		readonly local?: PointingOffset
	}
}

// Tuning for the iterative inversion performed by `correctPointingCoordinate`.
export interface PointingCorrectionOptions {
	// Fraction of the spherical residual applied per iteration, in `(0, 1]`. Defaults to 1, which
	// converges for any error field whose gradient is small compared to 1 - that is, any physically
	// plausible mount. Lower it only to tame a pathological model.
	readonly damping?: number
	// Maximum number of fixed-point iterations. Defaults to 8; convergence normally takes two or three.
	readonly maxIterations?: number
	// Spherical residual (radians) below which the inversion is considered converged. Defaults to 1e-9,
	// about 0.2 mas, far below any mount's mechanical resolution.
	readonly tolerance?: Angle
	// Largest correction (radians) the inversion is allowed to return. Defaults to 5°, matching
	// `maximumSampleSeparation`: anything larger means the model is extrapolating wildly, and truncating
	// is safer than sending the mount to the wrong place. Use `Infinity` to disable.
	readonly maximumCorrection?: Angle
}

// A corrected coordinate together with the error that was applied.
export interface CorrectionResult extends Readonly<EquatorialCoordinate> {
	// The predicted local error at the returned coordinate, which is what the mount will actually suffer.
	readonly predictedError: PredictedPointingError
	// True when the inversion reached `tolerance` within `maxIterations` and was not clamped.
	readonly converged: boolean
	// Number of fixed-point iterations actually performed. Zero means the first candidate already solved.
	readonly iterations: number
	// Final residual between the target and where the returned command would land, including when the
	// command was clamped. Gnomonic, so it is `tan(separation)` rather than the angle itself, which the
	// caller can ignore below a degree or so and undo with `atan` above it.
	readonly residual: Angle
	// True when the correction hit `maximumCorrection` and was truncated.
	readonly clamped: boolean
}

// Fitted empirical model: separate dx/dy linear coefficients over the feature basis.
export interface EmpiricalPointingModel {
	// Feature names matching the coefficient order.
	readonly featureNames: readonly string[]
	// Linear coefficients predicting the east offset.
	readonly coefficientsDx: Readonly<NumberArray>
	// Linear coefficients predicting the north offset.
	readonly coefficientsDy: Readonly<NumberArray>
	// Condition number of the dx normal equations.
	readonly conditionNumberDx: number
	// Condition number of the dy normal equations.
	readonly conditionNumberDy: number
	// True when the dx fit was rank-deficient.
	readonly rankDeficientDx: boolean
	// True when the dy fit was rank-deficient.
	readonly rankDeficientDy: boolean
	// Ridge regularization used.
	readonly ridge: number
	// Robust method used.
	readonly robustMethod: RobustRegressionMethod
	// Projection of each empirical column onto the semi-physical block, removed before fitting so the
	// two blocks are identifiable. Flattened row-major as `[semiPhysicalTermCount][featureCount]`, with
	// separate matrices for the east and north column groups. Present only for the hybrid residual
	// model; prediction must apply the same subtraction to reproduce the fit.
	readonly orthogonalizationDx?: readonly number[]
	readonly orthogonalizationDy?: readonly number[]
}

// Fitted semi-physical model: shared TPOINT-style parameters driving both dx and dy.
export interface SemiPhysicalPointingModel {
	// TPOINT-style terms fitted, in design-matrix column order.
	readonly terms: readonly SemiPhysicalTermName[]
	// Fitted parameter values in radians, aligned with `terms`.
	readonly parameters: Readonly<NumberArray>
	// Condition number of the stacked dx/dy normal equations.
	readonly conditionNumber: number
	// True when the fit was rank-deficient.
	readonly rankDeficient: boolean
	// Ridge regularization used.
	readonly ridge: number
	// Robust method used.
	readonly robustMethod: RobustRegressionMethod
}

// Complete fitted model: strategy, configuration snapshot, coverage, diagnostics, and component models.
export interface FittedPointingModel {
	// Serialization version of this model structure.
	readonly version: number
	// Strategy used to fit the model.
	readonly strategy: PointingModelStrategy
	// Error representation used during fitting.
	readonly errorRepresentation: PointingErrorRepresentation
	// Frame every training sample was expressed in, and the frame predictions must be requested in.
	readonly frame: PointingFrame
	// Sign/correction conventions of the model.
	readonly signConvention: PointingSignConvention
	// Resolved feature configuration used.
	readonly featureConfiguration: ResolvedPointingFeatureConfiguration
	// Resolved validation thresholds used.
	readonly validation: ResolvedPointingValidationOptions
	// Resolved robust configuration used.
	readonly robust: ResolvedPointingRobustFitConfiguration
	// Ridge regularization used.
	readonly ridge: number
	// False when the fit is too underdetermined or too ill-conditioned to extrapolate from. Prediction
	// through an unusable model returns a zero offset instead of ridge-amplified noise.
	readonly usable: boolean
	// Number of accepted training samples.
	readonly trainingSampleCount: number
	// Training directions used to score how well a prediction is supported by real samples.
	readonly supportSet?: PointingSupportSet
	// Sky/site coverage of the training set.
	readonly coverage: PointingCoverageSummary
	// Residual diagnostics.
	readonly diagnostics: PointingDiagnostics
	// Empirical component, present for 'empirical' strategy.
	readonly empirical?: EmpiricalPointingModel
	// Semi-physical component, present for 'semiPhysical' and 'hybrid'.
	readonly physical?: SemiPhysicalPointingModel
	// Empirical residual component, present for 'hybrid'.
	readonly residual?: EmpiricalPointingModel
	// Local residual layer, present only when it was enabled and the sample set was dense enough. It is
	// applied on top of whatever the other components predict, and never replaces them.
	readonly local?: LocalPointingResidualModel
}

// A fitted model as it travels outside the process, optionally carrying the dataset that produced it.
export interface SerializedPointingModel extends FittedPointingModel {
	// Training samples, present only when the model was exported with `includeSamples`.
	readonly samples?: readonly PointingSample[]
}

// Controls what `MountPointing.export` writes out.
export interface PointingModelExportOptions {
	// Include the stored training samples so the model can be refitted or audited after import.
	readonly includeSamples?: boolean
}

// Snapshot of a MountPointing instance's collection and fit state.
export interface MountPointingState {
	// Number of stored samples.
	readonly sampleCount: number
	// Latest fitted model, if any.
	readonly fittedModel?: FittedPointingModel
	// Latest diagnostics.
	readonly diagnostics: PointingDiagnostics
	// True when samples changed since the last fit.
	readonly dirty: boolean
}

// Options for adding a sample and optionally refitting in one call.
export interface PointingModelUpdateOptions {
	// Refit immediately after adding the sample.
	fit?: boolean
	// Options forwarded to the fit.
	fitOptions?: PointingFitOptions
}

// An accepted sample paired with its derived context and computed error.
interface PreparedPointingSample {
	readonly sample: Readonly<PointingSample>
	readonly context: PointingContext
	readonly error: PointingError
	// Unit vector of the commanded target, cached for coverage and support geometry.
	readonly direction: Vec3
	// Inverse-variance weight from `sample.uncertainty`, or 1 when it was not supplied. Normalized to a
	// mean of 1 at fit time so the ridge and the robust scale keep their meaning.
	readonly weight: number
}

// A rejected sample together with the rejection reason.
interface RejectedPointingSample {
	readonly sample: Readonly<PointingSample>
	readonly reason: string
}

// Result of validating and preparing the full sample set for fitting.
interface PreparedPointingSamples {
	readonly accepted: readonly PreparedPointingSample[]
	readonly rejected: readonly RejectedPointingSample[]
	readonly warnings: readonly string[]
	// Strongest observing context every accepted sample provides.
	readonly supportedContext: PointingContextRequirement
}

// The basis terms and empirical features that survived context gating and the complexity ladder.
interface ResolvedPointingBasis {
	readonly semiPhysicalTerms: readonly SemiPhysicalTermName[]
	readonly featureConfiguration: ResolvedPointingFeatureConfiguration
	readonly featureNames: readonly string[]
	// Free parameters the selected basis costs, counting the empirical block once per axis.
	readonly parameterCount: number
	// Names removed by context gating or by the complexity ladder, each with its reason.
	readonly droppedTerms: readonly string[]
	// False when even the smallest tier still has fewer samples than parameters it needs.
	readonly sufficient: boolean
}

// Fully resolved fit options with all defaults applied.
interface ResolvedPointingFitOptions {
	readonly strategy: PointingModelStrategy
	readonly errorRepresentation: PointingErrorRepresentation
	readonly frame: PointingFrame
	readonly ridge: number
	readonly ridgeEmpirical: number
	readonly minimumSampleRatio: number
	readonly semiPhysicalTerms: readonly SemiPhysicalTermName[]
	readonly featureConfiguration: ResolvedPointingFeatureConfiguration
	readonly validation: ResolvedPointingValidationOptions
	readonly robust: ResolvedPointingRobustFitConfiguration
	readonly local: ResolvedLocalPointingResidualOptions
}

// Current model-structure serialization version.
const POINTING_MODEL_VERSION = 1
// Frame assumed when none is declared. Apparent topocentric without refraction: refraction is a
// function of pressure and temperature, so folding it into a mechanical model makes the fit valid only
// for the weather it was taken in. It belongs to the astrometric layer.
const DEFAULT_POINTING_FRAME: PointingFrame = 'apparentTopocentric'
// Default Tikhonov ridge, relative to the mean design-column energy, for numerical stability only.
const DEFAULT_RIDGE = 1e-6
// Default relative ridge for the empirical block of a hybrid fit: shrinks the nuisance basis without
// preventing it from describing genuinely unmodelled deformation.
const DEFAULT_EMPIRICAL_RIDGE = 1e-3
// Default accepted-sample to free-parameter ratio required before a complexity tier is kept.
const DEFAULT_MINIMUM_SAMPLE_RATIO = 3
// Condition number above which a fitted model is considered unusable for prediction.
const MAXIMUM_USABLE_CONDITION_NUMBER = 1e8
// Neighbour count defining the local sampling density used to score prediction support. Four is enough
// to describe a neighbourhood on the sphere without being dominated by a single close sample.
const SUPPORT_NEIGHBORS = 4
// Support below which a prediction counts as extrapolation. Since support only starts decaying beyond
// the characteristic spacing, `0.35 ≈ exp(-1.05)` triggers about two spacings outside the sampled region.
const MINIMUM_PREDICTION_SUPPORT = 0.35
// Support decay length used when the training set is too degenerate to measure its own spacing.
const DEFAULT_SUPPORT_SCALE = 10 * DEG2RAD
// Fraction of the spherical residual applied per inversion step. One is the undamped Newton-like step,
// which contracts for any error field whose gradient stays well below 1.
const DEFAULT_CORRECTION_DAMPING = 1
// Iteration cap for the command inversion. Real mounts converge in two or three passes.
const DEFAULT_CORRECTION_MAX_ITERATIONS = 8
// Spherical residual (radians) accepted as converged: 1e-9 rad is about 0.2 mas.
const DEFAULT_CORRECTION_TOLERANCE = 1e-9
// Largest correction (radians) the inversion may return, matching the maximum accepted sample separation.
const DEFAULT_MAXIMUM_CORRECTION = 5 * DEG2RAD
// Floor for `1 - leverage` when converting a residual into its leave-one-out counterpart, so a saturated
// row inflates the metric instead of producing a division by zero.
const MINIMUM_LEVERAGE_COMPLEMENT = 1e-6
// Floor for `cos(declination)` when undoing the small-angle scaling of a right-ascension offset. Below
// it the coordinate is within a few microarcseconds of the pole, where right ascension is meaningless.
const MINIMUM_DECLINATION_COSINE = 1e-10
// Default sample-validation thresholds: 10° minimum altitude, 5° max separation, 5′ duplicate radius,
// and a recommended minimum of 12 samples.
const DEFAULT_VALIDATION_OPTIONS: ResolvedPointingValidationOptions = {
	minimumAltitude: 10 * DEG2RAD,
	maximumSampleSeparation: 5 * DEG2RAD,
	duplicateTolerance: 5 * AMIN2RAD,
	minimumSamples: 12,
}
// Default robust-fit settings: Huber weighting with the standard 1.345 tuning constant.
const DEFAULT_ROBUST_CONFIGURATION: ResolvedPointingRobustFitConfiguration = {
	method: 'huber',
	maxIterations: 25,
	tolerance: 1e-9,
	tuning: 1.345,
}
// Fixed sign and correction conventions stamped onto every fitted model.
const DEFAULT_SIGN_CONVENTION: PointingSignConvention = {
	dxPositive: 'east',
	dyPositive: 'north',
	correctionDirection: 'subtract-predicted-local-error',
}

// Number of HA×Dec coverage bins (6 hour-angle × 4 declination) used for the sky-coverage ratio.
const TOTAL_SKY_BINS = 24

// Computes the local pointing error using the selected angular representation.
export function computePointingError(targetRa: Angle, targetDec: Angle, solvedRa: Angle, solvedDec: Angle, representation: PointingErrorRepresentation = 'vectorTangent'): PointingError {
	const simpleDx = normalizePI(solvedRa - targetRa) * Math.cos(targetDec)
	const simpleDy = solvedDec - targetDec
	const targetVector = eraS2c(targetRa, targetDec)
	const solvedVector = eraS2c(solvedRa, solvedDec)
	const projection = sphericalProjectTangentPlane(solvedVector, targetVector)
	const angularSeparation = vecAngle(targetVector, solvedVector)
	const vectorDx = projection === false ? simpleDx : projection.x
	const vectorDy = projection === false ? simpleDy : projection.y

	return {
		dx: representation === 'smallAngle' ? simpleDx : vectorDx,
		dy: representation === 'smallAngle' ? simpleDy : vectorDy,
		angularSeparation,
		representationUsed: projection === false ? 'smallAngle' : representation,
		comparison: { smallAngleDx: simpleDx, smallAngleDy: simpleDy, vectorDx, vectorDy },
	}
}

// Adds a pointing offset to the coordinate it refers to, inverting `computePointingError` for the same
// representation.
//
// `rightAscension` and `declination` (radians) are the target the offset was measured or predicted at,
// `dx` and `dy` (radians) are east-positive and north-positive. `representation` must match the one the
// offset was produced with: a `smallAngle` offset is a plain difference of spherical coordinates scaled
// by `cos(declination)`, while a `vectorTangent` one is gnomonic, and applying the wrong inverse leaves
// a second-order error that grows with the declination and the offset size. The returned right ascension
// is normalized to `0..TAU` and the declination is clamped to `±PI/2`.
export function applyPointingOffset(rightAscension: Angle, declination: Angle, dx: number, dy: number, representation: PointingErrorRepresentation = 'vectorTangent'): EquatorialCoordinate {
	if (representation !== 'smallAngle') {
		// `eraC2s` returns an `atan2` longitude in `-PI..PI`, which an offset crossing right ascension zero
		// lands on, so the wrap is undone here rather than handed to the caller.
		const [ra, dec] = eraC2s(...sphericalUnprojectTangentPlane(dx, dy, eraS2c(rightAscension, declination)))
		return { rightAscension: normalizeAngle(ra), declination: dec }
	}

	// `dx` was scaled by this same cosine, so the division is exact except at the pole itself, where the
	// scaling annihilates any offset and no right ascension can be recovered from it.
	const cosDec = Math.cos(declination)
	const ra = Math.abs(cosDec) < MINIMUM_DECLINATION_COSINE ? rightAscension : rightAscension + dx / cosDec
	return { rightAscension: normalizeAngle(ra), declination: Math.min(PIOVERTWO, Math.max(-PIOVERTWO, declination + dy)) }
}

// Fits a complete pointing model from the current sample set.
export function fitPointingModel(samples: readonly PointingSample[], options: Readonly<PointingFitOptions> = {}): FittedPointingModel {
	const resolved = resolveFitOptions(options)
	const prepared = preparePointingSamples(samples, resolved)
	const coverage = summarizePointingCoverage(prepared.accepted)
	// Packed once and shared: the support set keeps them, and the local layer copies them for itself.
	const { directions, pierSides } = packSampleDirections(prepared.accepted)
	const basis = resolvePointingBasis(resolved, prepared.supportedContext, prepared.accepted.length)
	const fit = fitStackedOffsetModel(prepared.accepted, resolved, basis)
	const physicalCount = basis.semiPhysicalTerms.length
	const featureCount = basis.featureNames.length

	const physical: SemiPhysicalPointingModel | undefined =
		physicalCount === 0
			? undefined
			: {
					terms: basis.semiPhysicalTerms,
					parameters: Array.from(fit.coefficients.subarray(0, physicalCount)),
					conditionNumber: fit.conditionNumber,
					rankDeficient: fit.rankDeficient,
					ridge: resolved.ridge,
					robustMethod: resolved.robust.method,
				}

	const empirical: EmpiricalPointingModel | undefined =
		featureCount === 0
			? undefined
			: {
					featureNames: basis.featureNames,
					coefficientsDx: Array.from(fit.coefficients.subarray(physicalCount, physicalCount + featureCount)),
					coefficientsDy: Array.from(fit.coefficients.subarray(physicalCount + featureCount)),
					conditionNumberDx: fit.conditionNumber,
					conditionNumberDy: fit.conditionNumber,
					rankDeficientDx: fit.rankDeficient,
					rankDeficientDy: fit.rankDeficient,
					ridge: physicalCount > 0 ? resolved.ridgeEmpirical : resolved.ridge,
					robustMethod: resolved.robust.method,
					orthogonalizationDx: fit.orthogonalizationDx,
					orthogonalizationDy: fit.orthogonalizationDy,
				}

	const provisional: FittedPointingModel = {
		version: POINTING_MODEL_VERSION,
		strategy: resolved.strategy,
		errorRepresentation: resolved.errorRepresentation,
		frame: resolved.frame,
		signConvention: DEFAULT_SIGN_CONVENTION,
		featureConfiguration: basis.featureConfiguration,
		validation: resolved.validation,
		robust: resolved.robust,
		ridge: resolved.ridge,
		trainingSampleCount: prepared.accepted.length,
		supportSet: buildPointingSupportSet(directions, pierSides),
		usable: basis.sufficient && !fit.rankDeficient && fit.conditionNumber <= MAXIMUM_USABLE_CONDITION_NUMBER,
		coverage,
		diagnostics: emptyDiagnostics(samples.length),
		empirical: resolved.strategy === 'empirical' ? empirical : undefined,
		physical,
		residual: resolved.strategy === 'hybrid' ? empirical : undefined,
	}

	// What the global model leaves behind at each training sample, computed once and shared: the
	// diagnostics summarize it and the local layer interpolates it.
	const residuals = computeModelResiduals(prepared.accepted, provisional)
	const local = buildLocalResidualLayer(directions, pierSides, residuals, resolved.local, provisional.usable)
	const diagnostics = buildPointingDiagnostics(samples.length, prepared, provisional, basis, fit, residuals)
	return { ...provisional, local, diagnostics }
}

// Fits every strategy on the same samples and returns the one that generalizes best.
//
// Selection uses the leave-one-out RMS, not the in-sample RMS: the latter can only improve as parameters
// are added, so choosing by it would always return the most complex model regardless of whether the extra
// terms describe the mount or the noise. Unusable models are never selected. Falls back to the in-sample
// RMS only when no candidate could produce leave-one-out residuals.
//
// The fallback is all-or-nothing on purpose. Scoring one candidate out of sample and another in sample
// would compare quantities that are not on the same scale: the in-sample RMS is systematically the
// smaller of the two, so the candidate whose leverage happened to be unavailable would win on the
// weakness of its own diagnostics rather than on the quality of its fit.
export function selectPointingStrategy(samples: readonly PointingSample[], options: Readonly<PointingFitOptions> = {}): FittedPointingModel {
	const strategies = POINTING_MODEL_STRATEGIES
	const candidates = new Array<FittedPointingModel>(strategies.length)
	let comparable = true

	for (let i = 0; i < strategies.length; i++) {
		candidates[i] = fitPointingModel(samples, { ...options, strategy: strategies[i] })
		if (candidates[i].diagnostics.looRms === undefined) comparable = false
	}

	let best: FittedPointingModel | undefined
	let bestScore = Number.POSITIVE_INFINITY

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i]
		const score = comparable ? candidate.diagnostics.looRms! : candidate.diagnostics.angularRms

		// A usable model always beats an unusable one, however good the latter's residuals look.
		if (best && !candidate.usable && best.usable) continue
		if (best && candidate.usable === best.usable && !(score < bestScore)) continue

		best = candidate
		bestScore = score
	}

	return best ?? fitPointingModel(samples, options)
}

// Predicts the local systematic error for a requested coordinate and mount state.
export function predictPointingModelError(model: FittedPointingModel, input: Readonly<PointingModelInput>): PredictedPointingError {
	const context = extractPointingContext(input)

	// An unusable model is one whose basis could not be constrained by the training set. Its
	// coefficients are not merely imprecise, they are arbitrary along the unconstrained directions, so
	// applying them would move the mount by an amount unrelated to its real error. Predicting zero is
	// the honest answer: no correction, plus a warning explaining why.
	if (!model.usable) {
		const quality = evaluatePredictionQuality(model, context)
		return {
			dx: 0,
			dy: 0,
			offsetMagnitude: 0,
			representationUsed: model.errorRepresentation,
			quality: { ...quality, warnings: [...quality.warnings, 'the fitted model is not usable for prediction'] },
			components: { physical: { dx: 0, dy: 0 }, empirical: { dx: 0, dy: 0 }, residual: { dx: 0, dy: 0 } },
		}
	}

	const components = predictModelComponents(model, context)
	const dx = (components.physical?.dx ?? 0) + (components.empirical?.dx ?? 0) + (components.residual?.dx ?? 0) + (components.local?.dx ?? 0)
	const dy = (components.physical?.dy ?? 0) + (components.empirical?.dy ?? 0) + (components.residual?.dy ?? 0) + (components.local?.dy ?? 0)
	const quality = evaluatePredictionQuality(model, context)
	return { dx, dy, offsetMagnitude: Math.hypot(dx, dy), representationUsed: model.errorRepresentation, quality, components }
}

// Solves for the coordinate the mount must be commanded to so that it lands on the requested one.
//
// Subtracting the error predicted at the target is only a first-order inversion: it is exact when the
// error field is constant near the target, which is precisely the case the model exists to contradict.
// This solves `command + error(command) = target` by fixed-point iteration in the tangent plane, so the
// error is always evaluated where the mount will actually be commanded.
//
// The iteration re-derives the observing context at every step, so terms that depend on hour angle,
// altitude or pier side are consistent with the returned command rather than with the original target.
export function correctPointingCoordinate(model: FittedPointingModel, input: Readonly<PointingModelInput>, options: Readonly<PointingCorrectionOptions> = {}): CorrectionResult {
	const damping = options.damping ?? DEFAULT_CORRECTION_DAMPING
	const maxIterations = Math.max(1, Math.trunc(options.maxIterations ?? DEFAULT_CORRECTION_MAX_ITERATIONS))
	const tolerance = options.tolerance ?? DEFAULT_CORRECTION_TOLERANCE
	const maximumCorrection = options.maximumCorrection ?? DEFAULT_MAXIMUM_CORRECTION
	const target = eraS2c(input.rightAscension, input.declination)

	let command = target
	let predictedError = predictPointingModelError(model, input)
	let residual = Number.POSITIVE_INFINITY
	let converged = false
	let clamped = false
	let iterations = 0

	while (true) {
		// How the current candidate would miss the target once the mount adds its predicted error.
		const offset = commandOffset(target, command, predictedError)

		// The candidate ended up more than 90° from the target: the model is not describing a mount. The
		// iteration has nothing left to refine, and the candidate it holds cannot even be measured against
		// the target, so the correction is abandoned instead of returned with an unmeasurable residual.
		if (offset === undefined) return refusedCorrection(model, input, iterations)

		residual = Math.hypot(offset.x, offset.y)

		if (residual <= tolerance) {
			converged = true
			break
		}

		if (iterations >= maxIterations) break

		iterations++
		command = sphericalUnprojectTangentPlane(damping * offset.x, damping * offset.y, command)
		const [rightAscension, declination] = eraC2s(...command)
		predictedError = predictPointingModelError(model, { ...input, rightAscension, declination })
	}

	const total = sphericalProjectTangentPlane(command, target)

	// A command a quarter turn away from the target is never a correction.
	if (total === false) return refusedCorrection(model, input, iterations)

	// Gnomonic offsets are `tan(separation)` along the tangent direction, so the clamp compares angles.
	const distance = Math.hypot(total.x, total.y)

	if (Math.atan(distance) > maximumCorrection) {
		const scale = Math.tan(maximumCorrection) / distance
		command = sphericalUnprojectTangentPlane(total.x * scale, total.y * scale, target)
		clamped = true
		converged = false
	}

	const [rightAscension, declination] = eraC2s(...command)

	if (!clamped) return { rightAscension, declination, predictedError, converged, iterations, residual, clamped }

	// The clamp moved the command away from the candidate the loop settled on, so the residual measured
	// there no longer describes where the mount would land. Re-measure it against the command actually
	// returned, which is what the field documents and what a caller judges the correction by. A degenerate
	// re-projection leaves the loop's value in place, as the loop itself does.
	const clampedError = predictPointingModelError(model, { ...input, rightAscension, declination })
	const offset = commandOffset(target, command, clampedError)

	return { rightAscension, declination, predictedError: clampedError, converged, iterations, residual: offset === undefined ? residual : Math.hypot(offset.x, offset.y), clamped }
}

// Result returned when the inversion cannot produce a command it is able to measure: the target itself,
// flagged as clamped so a caller refuses the slew.
//
// A model predicting a displacement of more than a quarter turn is not describing a mount, and there is
// no correction to salvage from it. Reporting the target with `clamped` set is the only honest answer,
// and `residual` becomes the finite miss of the uncorrected coordinate actually being returned, rather
// than the unmeasurable one of a candidate that was thrown away.
function refusedCorrection(model: FittedPointingModel, input: Readonly<PointingModelInput>, iterations: number): CorrectionResult {
	const uncorrected = predictPointingModelError(model, input)
	return { rightAscension: input.rightAscension, declination: input.declination, predictedError: uncorrected, converged: false, iterations, residual: Math.hypot(uncorrected.dx, uncorrected.dy), clamped: true }
}

// Tangent-plane offset from where the mount would land, when commanded to `command` while making the
// predicted `error`, to `target`. Components are gnomonic, east-positive and north-positive, in radians
// for the small separations a pointing model deals with. Returns `undefined` when the two directions are
// more than a quarter turn apart, where the tangent plane cannot represent the offset at all.
//
// The error is applied with the inverse of its own representation, so the fixed point the iteration
// converges to is the coordinate the mount really reaches under the model that was fitted. The offset
// itself stays gnomonic regardless: it parameterizes the search step, not the mount's error.
function commandOffset(target: Vec3, command: Vec3, error: Readonly<PredictedPointingError>) {
	let reached: Vec3

	if (error.representationUsed === 'smallAngle') {
		const [commandRa, commandDec] = eraC2s(...command)
		const { rightAscension, declination } = applyPointingOffset(commandRa, commandDec, error.dx, error.dy, 'smallAngle')
		reached = eraS2c(rightAscension, declination)
	} else {
		// The gnomonic case works directly on the direction vector, avoiding a spherical round trip in a
		// loop that runs once per correction iteration.
		reached = sphericalUnprojectTangentPlane(error.dx, error.dy, command)
	}

	const offset = sphericalProjectTangentPlane(target, reached)
	return offset === false ? undefined : offset
}

// Stores samples, fits the configured model, and predicts/corrects future targets.
export class MountPointing {
	readonly #samples: Readonly<PointingSample>[] = []

	#fittedModel?: FittedPointingModel
	#diagnostics = emptyDiagnostics(0)
	#dirty = false

	constructor(readonly defaults?: Readonly<PointingFitOptions>) {}

	// Adds a sample to the internal dataset.
	add(sample: Readonly<PointingSample>) {
		this.#samples.push(sample)
		this.#dirty = true
		return this.state
	}

	// Adds a sample and optionally fits immediately in collection workflows.
	model(sample: Readonly<PointingSample>, options: PointingModelUpdateOptions = {}) {
		this.add(sample)

		if (options.fit) {
			this.fit(options.fitOptions)
		}

		return this.state
	}

	// Fits the configured pointing model.
	fit(options: Readonly<PointingFitOptions> = {}) {
		this.#fittedModel = fitPointingModel(this.#samples, { ...this.defaults, ...options })
		this.#diagnostics = this.#fittedModel.diagnostics
		this.#dirty = false
		return this.#fittedModel
	}

	// Predicts the local systematic error for a requested coordinate and mount state.
	predictError(input: Readonly<PointingModelInput>) {
		return this.#fittedModel ? predictPointingModelError(this.#fittedModel, input) : unfittedPrediction(input)
	}

	// Corrects a requested coordinate using the fitted pointing model.
	correctCoordinate(input: Readonly<PointingModelInput>, options: Readonly<PointingCorrectionOptions> = {}): CorrectionResult {
		// Without a model the identity command is exactly right, so it converges trivially in zero steps.
		return this.#fittedModel ? correctPointingCoordinate(this.#fittedModel, input, options) : { rightAscension: input.rightAscension, declination: input.declination, predictedError: unfittedPrediction(input), converged: true, iterations: 0, residual: 0, clamped: false }
	}

	// Exports the fitted model into a serializable structure.
	//
	// With `includeSamples` the training set travels with the model, so a later session can refit it
	// under different options or audit which samples produced a given term instead of only inheriting
	// the coefficients. Omitted by default, since the dataset dwarfs the model.
	export(options: Readonly<PointingModelExportOptions> = {}): SerializedPointingModel | undefined {
		if (!this.#fittedModel) return undefined
		return structuredClone(options.includeSamples ? { ...this.#fittedModel, samples: this.#samples } : this.#fittedModel)
	}

	// Imports a previously fitted pointing model, validating it first.
	//
	// Throws on anything structurally wrong rather than installing a half-valid model that would only
	// fail later as a silently wrong slew. A model exported with its samples restores them too, so the
	// instance can refit without recollecting.
	import(serialized: SerializedPointingModel) {
		// The dataset is split off the model rather than cloned into it, so an instance imported from a
		// sample-carrying export exposes the same model shape as one imported from a bare export.
		const { samples, ...rest } = serialized
		const model = structuredClone(rest) as FittedPointingModel

		this.#fittedModel = model
		this.#diagnostics = model.diagnostics
		this.#dirty = false

		if (samples) {
			this.#samples.length = 0

			for (let i = 0; i < samples.length; i++) {
				this.#samples.push(structuredClone(samples[i]))
			}
		}

		return model
	}

	// Returns the latest fit diagnostics or the current empty-state diagnostics.
	get diagnostics() {
		return this.#diagnostics
	}

	// Returns the current mutable state snapshot.
	get state(): MountPointingState {
		return { sampleCount: this.#samples.length, fittedModel: this.#fittedModel, diagnostics: this.diagnostics, dirty: this.#dirty }
	}
}

// Resolves the configured sample validation thresholds.
function resolveValidationOptions(validation: PointingValidationOptions = {}): ResolvedPointingValidationOptions {
	return {
		minimumAltitude: validation.minimumAltitude ?? DEFAULT_VALIDATION_OPTIONS.minimumAltitude,
		maximumSampleSeparation: validation.maximumSampleSeparation ?? DEFAULT_VALIDATION_OPTIONS.maximumSampleSeparation,
		duplicateTolerance: validation.duplicateTolerance ?? DEFAULT_VALIDATION_OPTIONS.duplicateTolerance,
		minimumSamples: validation.minimumSamples ?? DEFAULT_VALIDATION_OPTIONS.minimumSamples,
	}
}

// Resolves the configured robust-fitting options.
function resolveRobustConfiguration(robust: PointingRobustFitConfiguration = {}): ResolvedPointingRobustFitConfiguration {
	return {
		method: robust.method ?? DEFAULT_ROBUST_CONFIGURATION.method,
		maxIterations: robust.maxIterations ?? DEFAULT_ROBUST_CONFIGURATION.maxIterations,
		tolerance: robust.tolerance ?? DEFAULT_ROBUST_CONFIGURATION.tolerance,
		tuning: robust.tuning ?? DEFAULT_ROBUST_CONFIGURATION.tuning,
	}
}

// Resolves the full fit configuration.
function resolveFitOptions(options: Readonly<PointingFitOptions> = {}): ResolvedPointingFitOptions {
	return {
		strategy: options.strategy ?? 'hybrid',
		errorRepresentation: options.errorRepresentation ?? 'vectorTangent',
		frame: options.frame ?? DEFAULT_POINTING_FRAME,
		ridge: options.ridge ?? DEFAULT_RIDGE,
		ridgeEmpirical: options.ridgeEmpirical ?? DEFAULT_EMPIRICAL_RIDGE,
		minimumSampleRatio: Math.max(1, options.minimumSampleRatio ?? DEFAULT_MINIMUM_SAMPLE_RATIO),
		semiPhysicalTerms: options.semiPhysicalTerms?.length ? [...options.semiPhysicalTerms] : SEMI_PHYSICAL_TERM_NAMES,
		featureConfiguration: resolveFeatureConfiguration(options.featureConfiguration),
		validation: resolveValidationOptions(options.validation),
		robust: resolveRobustConfiguration(options.robust),
		local: resolveLocalResidualOptions(options.local),
	}
}

// Validates and prepares the sample set before fitting.
function preparePointingSamples(samples: readonly PointingSample[], options: ResolvedPointingFitOptions): PreparedPointingSamples {
	const accepted: PreparedPointingSample[] = []
	const rejected: RejectedPointingSample[] = []
	const warnings: string[] = []

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]

		// The coordinates, the error, the context and the target direction are each derived once and then
		// handed to the validator, which used to recompute all of them: `extractPointingContext` alone
		// costs a sidereal-time and a horizontal-coordinate evaluation per call.
		if (!isFiniteCoordinate(sample.targetRightAscension, sample.targetDeclination) || !isFiniteCoordinate(sample.solvedRightAscension, sample.solvedDeclination)) {
			rejected.push({ sample, reason: 'invalid coordinate' })
			continue
		}

		if (Math.abs(sample.targetDeclination) > PIOVERTWO || Math.abs(sample.solvedDeclination) > PIOVERTWO) {
			rejected.push({ sample, reason: 'declination outside valid range' })
			continue
		}

		const error = computePointingError(sample.targetRightAscension, sample.targetDeclination, sample.solvedRightAscension, sample.solvedDeclination, options.errorRepresentation)
		const context = extractPointingContext({ rightAscension: sample.targetRightAscension, declination: sample.targetDeclination, time: sample.time, latitude: sample.latitude, longitude: sample.longitude, pierSide: sample.pierSide, frame: sample.frame })
		const direction = eraS2c(sample.targetRightAscension, sample.targetDeclination)
		const reason = validatePointingSample(sample, error, context, direction, accepted, options)

		if (reason) {
			rejected.push({ sample, reason })
			continue
		}

		const uncertainty = sample.uncertainty
		const weight = uncertainty !== undefined && Number.isFinite(uncertainty) && uncertainty > 0 ? 1 / (uncertainty * uncertainty) : 0
		accepted.push({ sample, context, error, direction, weight })
	}

	// Keep the richest context a majority of samples can supply, then reject the stragglers instead of
	// zero-filling their missing hour angle or altitude, which would alias the constant term.
	const supportedContext = majorityContextRequirement(accepted)
	const supported: PreparedPointingSample[] = []

	for (let i = 0; i < accepted.length; i++) {
		if (satisfiesContextRequirement(availableContextRequirement(accepted[i].context), supportedContext)) supported.push(accepted[i])
		else rejected.push({ sample: accepted[i].sample, reason: 'insufficient observing context' })
	}

	if (supported.length < options.validation.minimumSamples) {
		warnings.push(`too few samples: ${supported.length} valid sample(s) for a recommended minimum of ${options.validation.minimumSamples}`)
	}

	return { accepted: supported, rejected, warnings, supportedContext }
}

// Ordinal rank of an observing-context requirement, used to compare and aggregate requirements.
const CONTEXT_REQUIREMENT_RANK: Readonly<Record<PointingContextRequirement, number>> = { none: 0, hourAngle: 1, horizon: 2 }
// Ordered requirement levels, weakest first, aligned with `CONTEXT_REQUIREMENT_RANK`.
const CONTEXT_REQUIREMENT_LEVELS = ['none', 'hourAngle', 'horizon'] as const satisfies readonly PointingContextRequirement[]

// Picks the strongest observing context that at least half of the samples can supply. Using the
// majority rather than the minimum keeps a handful of context-less samples from collapsing the whole
// model to declination-only terms; those samples are rejected instead.
function majorityContextRequirement(samples: readonly PreparedPointingSample[]): PointingContextRequirement {
	if (samples.length === 0) return 'none'

	const counts = [0, 0, 0]

	for (let i = 0; i < samples.length; i++) {
		counts[CONTEXT_REQUIREMENT_RANK[availableContextRequirement(samples[i].context)]]++
	}

	const required = Math.ceil(samples.length / 2)
	let atLeast = 0

	for (let level = 2; level >= 0; level--) {
		atLeast += counts[level]
		if (atLeast >= required) return CONTEXT_REQUIREMENT_LEVELS[level]
	}

	return 'none'
}

// Empirical feature-flag groups in the order the complexity ladder switches them off: highest-order
// and least physically motivated first. `bias` is never dropped, so an over-constrained dataset still
// yields a usable constant offset.
const EMPIRICAL_FEATURE_GROUPS = [
	{ flag: 'includePolynomialTerms', names: ['normalizedHA', 'normalizedDec', 'normalizedHA*normalizedDec'] },
	{ flag: 'includeCrossTerms', names: ['sinHA*sinDec', 'sinAlt*sinDec', 'pierSide*sinHA'] },
	{ flag: 'includeAltitudeTerms', names: ['sinAlt', 'cosAlt'] },
	{ flag: 'includePierSideTerms', names: ['pierSide'] },
	{ flag: 'includeHourAngleTerms', names: ['sinHA', 'cosHA'] },
	{ flag: 'includeDeclinationTerms', names: ['sinDec', 'cosDec'] },
] as const satisfies readonly { flag: keyof ResolvedPointingFeatureConfiguration; names: readonly string[] }[]

// Strongest observing context any feature of a group needs; the group is dropped whole when the
// accepted samples cannot supply it.
function featureGroupRequirement(names: readonly string[]): PointingContextRequirement {
	let rank = 0

	for (let i = 0; i < names.length; i++) {
		rank = Math.max(rank, CONTEXT_REQUIREMENT_RANK[empiricalFeatureRequirement(names[i])])
	}

	return CONTEXT_REQUIREMENT_LEVELS[rank]
}

// Selects the basis actually fitted: the configured terms minus those the observing context cannot
// support, then minus whatever the sample count cannot afford.
//
// The affordability rule compares equations to free parameters. A sample contributes two equations
// (east and north); the semi-physical block costs one parameter per term because it is shared across
// both, while the empirical block costs one parameter per feature and per axis. A tier is kept when
// `2 * sampleCount >= minimumSampleRatio * parameterCount`, with an absolute floor of
// `parameterCount + 3` equations so a very small basis is not blocked by the ratio alone.
function resolvePointingBasis(options: ResolvedPointingFitOptions, supportedContext: PointingContextRequirement, sampleCount: number): ResolvedPointingBasis {
	const droppedTerms: string[] = []
	const semiPhysicalTerms: SemiPhysicalTermName[] = []
	const usesPhysical = options.strategy === 'semiPhysical' || options.strategy === 'hybrid'
	const usesEmpirical = options.strategy === 'empirical' || options.strategy === 'hybrid'

	if (usesPhysical) {
		for (const term of options.semiPhysicalTerms) {
			if (satisfiesContextRequirement(supportedContext, SEMI_PHYSICAL_TERM_REQUIREMENTS[term])) semiPhysicalTerms.push(term)
			else droppedTerms.push(`${term}: requires ${SEMI_PHYSICAL_TERM_REQUIREMENTS[term]} context`)
		}
	}

	const configuration: Record<keyof ResolvedPointingFeatureConfiguration, boolean> = { ...options.featureConfiguration }

	if (!usesEmpirical) {
		for (const group of EMPIRICAL_FEATURE_GROUPS) configuration[group.flag] = false
		configuration.includeBias = false
	} else {
		for (const group of EMPIRICAL_FEATURE_GROUPS) {
			const requirement = featureGroupRequirement(group.names)

			if (configuration[group.flag] && !satisfiesContextRequirement(supportedContext, requirement)) {
				configuration[group.flag] = false
				droppedTerms.push(`${group.flag}: requires ${requirement} context`)
			}
		}
	}

	const equations = sampleCount * 2
	let featureNames = buildEmpiricalPointingFeatureNames(configuration)
	let parameterCount = semiPhysicalTerms.length + featureNames.length * 2

	for (const group of EMPIRICAL_FEATURE_GROUPS) {
		if (equations >= Math.max(options.minimumSampleRatio * parameterCount, parameterCount + 3)) break
		if (!configuration[group.flag]) continue

		configuration[group.flag] = false
		droppedTerms.push(`${group.flag}: too few samples for ${parameterCount} parameters`)
		featureNames = buildEmpiricalPointingFeatureNames(configuration)
		parameterCount = semiPhysicalTerms.length + featureNames.length * 2
	}

	const sufficient = parameterCount > 0 && equations >= Math.max(options.minimumSampleRatio * parameterCount, parameterCount + 3)
	return { semiPhysicalTerms, featureConfiguration: configuration, featureNames, parameterCount, droppedTerms, sufficient }
}

// Validates one sample against the configured rules, given the quantities the caller already derived
// from it. Returns the rejection reason, or `undefined` when the sample is accepted.
//
// `error` is the sample's pointing error, `context` its observing context and `direction` the unit
// vector of its commanded target, all of which the caller keeps for the accepted sample.
function validatePointingSample(sample: Readonly<PointingSample>, error: PointingError, context: PointingContext, direction: Vec3, accepted: readonly PreparedPointingSample[], options: ResolvedPointingFitOptions) {
	if (!Number.isFinite(error.dx) || !Number.isFinite(error.dy)) {
		return 'unstable tangent-plane geometry'
	}

	if (error.angularSeparation > options.validation.maximumSampleSeparation) {
		return 'sample separation exceeds configured maximum'
	}

	// A sample reduced in another frame differs from the fit's by precession, aberration or refraction,
	// none of which the mount is responsible for. Mixing them would bake that difference into the terms.
	if (sample.frame !== undefined && sample.frame !== options.frame) {
		return 'frame differs from the model frame'
	}

	if (context.altitude !== undefined && context.altitude < options.validation.minimumAltitude) {
		return 'altitude below configured minimum'
	}

	// Duplicate rejection compares the dot product of the cached unit vectors against `cos(tolerance)`,
	// which is monotonic in the separation, instead of evaluating an inverse trig function per pair. A
	// non-positive tolerance disables the check, since no separation can fall below it.
	if (options.validation.duplicateTolerance > 0) {
		const cosineTolerance = Math.cos(options.validation.duplicateTolerance)
		const pierSide = normalizePierSide(sample.pierSide)

		for (let i = 0; i < accepted.length; i++) {
			const previous = accepted[i]

			if (normalizePierSide(previous.sample.pierSide) !== pierSide) continue

			const other = previous.direction

			if (direction[0] * other[0] + direction[1] * other[1] + direction[2] * other[2] >= cosineTolerance) {
				return 'duplicate or near-duplicate sample'
			}
		}
	}

	return undefined
}

// Checks whether one RA/Dec pair is numerically valid.
function isFiniteCoordinate(ra: Angle, dec: Angle) {
	return Number.isFinite(ra) && Number.isFinite(dec)
}

// Outcome of the joint stacked fit shared by every strategy.
interface StackedOffsetFit {
	// Coefficients laid out as [semi-physical | empirical east | empirical north].
	readonly coefficients: Float64Array
	readonly conditionNumber: number
	readonly rankDeficient: boolean
	// Hat-matrix diagonal over the stacked rows, present only for a fixed-weight fit, where the leverage
	// identity is exact and leave-one-out residuals can be derived from it.
	readonly leverage?: Readonly<NumberArray>
	// Radial leave-one-out residual of each sample (radians), from real fold refits. Present only for a
	// robust fit, where the leverage identity does not hold.
	readonly looResiduals?: Readonly<NumberArray>
	// Projection of each empirical column onto the semi-physical block, when both blocks are present.
	readonly orthogonalizationDx?: number[]
	readonly orthogonalizationDy?: number[]
}

// Relative threshold below which a semi-physical column is treated as linearly dependent on the
// previous ones and excluded from the orthogonalization.
const ORTHOGONALIZATION_TOLERANCE = 1e-12

// Fits every model component in one stacked system. Each sample contributes two rows, east and north,
// so a single robust weight per sample applies to the error vector as a whole rather than to each
// axis independently. Column layout is [semi-physical | empirical east | empirical north]: the
// semi-physical parameters are shared across both rows, while each empirical feature gets one
// coefficient per axis and is zero on the other axis' row.
//
// When both blocks are present the empirical block is orthogonalized against the semi-physical block
// by modified Gram-Schmidt before fitting. Without it the two blocks span overlapping spaces (`bias`
// competes with `CH`, `sinHA*sinDec` reproduces `MA`, `sinAlt` reproduces `TF`), predictions stay good
// and the fitted physical parameters become meaningless. After orthogonalization the physical terms
// absorb everything their basis can explain and the empirical block, by construction, only describes
// what is left. The projection coefficients are returned so prediction can repeat the subtraction.
//
// Ridge is applied per group and relative to the mean column energy of its own block, so the same
// option means the same amount of shrinkage for 12 samples and for 500. The empirical block is shrunk
// harder than the physical one, since it is a nuisance basis rather than a mechanical statement.
function fitStackedOffsetModel(samples: readonly PreparedPointingSample[], options: ResolvedPointingFitOptions, basis: ResolvedPointingBasis): StackedOffsetFit {
	const terms = basis.semiPhysicalTerms
	const physicalCount = terms.length
	const featureCount = basis.featureNames.length
	const columnCount = physicalCount + featureCount * 2
	const sampleCount = samples.length
	const dataRowCount = sampleCount * 2
	const rowCount = dataRowCount + columnCount

	if (sampleCount === 0 || columnCount === 0) {
		return { coefficients: new Float64Array(columnCount), conditionNumber: Number.POSITIVE_INFINITY, rankDeficient: true }
	}

	const rows = new Array<Float64Array>(rowCount)
	const target = new Float64Array(rowCount)
	const dxBasis = new Float64Array(physicalCount)
	const dyBasis = new Float64Array(physicalCount)
	const features = new Float64Array(featureCount)

	for (let i = 0; i < sampleCount; i++) {
		const dxRow = new Float64Array(columnCount)
		const dyRow = new Float64Array(columnCount)

		semiPhysicalBasis(samples[i].context, terms, dxBasis, dyBasis)
		featuresFromContext(samples[i].context, basis.featureConfiguration, features)

		for (let k = 0; k < physicalCount; k++) {
			dxRow[k] = dxBasis[k]
			dyRow[k] = dyBasis[k]
		}

		for (let j = 0; j < featureCount; j++) {
			dxRow[physicalCount + j] = features[j]
			dyRow[physicalCount + featureCount + j] = features[j]
		}

		rows[i * 2] = dxRow
		rows[i * 2 + 1] = dyRow
		target[i * 2] = samples[i].error.dx
		target[i * 2 + 1] = samples[i].error.dy
	}

	const orthogonalization = physicalCount > 0 && featureCount > 0 ? orthogonalizeAgainstPhysicalBlock(rows, dataRowCount, physicalCount, featureCount) : undefined
	const physicalRidge = options.ridge * blockColumnEnergy(rows, dataRowCount, 0, physicalCount)
	// The heavier empirical shrinkage exists to keep a nuisance basis from competing with the physical
	// one. With no physical block the empirical basis *is* the model, so it gets the base ridge instead.
	const empiricalRidge = (physicalCount > 0 ? options.ridgeEmpirical : options.ridge) * blockColumnEnergy(rows, dataRowCount, physicalCount, featureCount * 2)

	// Tikhonov rows appended to the design, one per column, so each block carries its own ridge.
	for (let column = 0; column < columnCount; column++) {
		const row = new Float64Array(columnCount)
		row[column] = Math.sqrt(column < physicalCount ? physicalRidge : empiricalRidge)
		rows[dataRowCount + column] = row
	}

	// The Tikhonov rows always weigh 1: their magnitude is already encoded in the appended value.
	const weights = new Float64Array(rowCount).fill(1)
	const baseWeights = normalizedSampleWeights(samples)
	let robustWeights = new Float64Array(sampleCount).fill(1)

	applyStackedWeights(weights, baseWeights, robustWeights, sampleCount)

	// Reused by every IRLS pass: one entry per sample, overwritten in place.
	const residuals = new Float64Array(sampleCount)

	// The IRLS passes exist only to settle the weights, and settling them needs nothing but coefficients.
	// Solving through `linearLeastSquares` instead would re-estimate the condition number and re-invert the
	// normal matrix on every pass — together the bulk of a solve's cost — and throw both away on all but
	// the last one. The loop leaves `weights` holding the vector that produced its final coefficients, so
	// the single full solve below reproduces them exactly.
	for (let iteration = 0; options.robust.method !== 'none' && iteration < Math.max(1, options.robust.maxIterations); iteration++) {
		applyStackedWeights(weights, baseWeights, robustWeights, sampleCount)

		const coefficients = leastSquaresCoefficients(rows, target, { weights })

		for (let i = 0; i < sampleCount; i++) {
			residuals[i] = Math.hypot(target[i * 2] - dotRow(rows[i * 2], coefficients), target[i * 2 + 1] - dotRow(rows[i * 2 + 1], coefficients))
		}

		const nextWeights = robustSampleWeights(residuals, options.robust)
		const converged = maxWeightDifference(robustWeights, nextWeights) <= options.robust.tolerance
		robustWeights = nextWeights

		if (converged) break
	}

	// Leave-one-out residuals come from real fold refits whenever the weights are not fixed, and from the
	// leverage identity otherwise; only one of the two is ever needed, so the hat-matrix inversion is
	// skipped for a robust fit.
	const robustFit = options.robust.method !== 'none'
	const fit = linearLeastSquares(rows, target, { weights, leverage: !robustFit })
	const looResiduals = robustFit ? robustLeaveOneOutResiduals(rows, target, sampleCount, baseWeights, robustWeights, options.robust) : undefined

	// Conditioning is measured on the sample rows alone, never on the ridge-augmented system the
	// coefficients come from. One Tikhonov row per column makes the augmented matrix full rank by
	// construction and caps its condition number at the ridge, so `fit.conditionNumber` would report a
	// healthy fit for a dataset that cannot constrain the basis at all — samples taken at a single
	// declination, for instance, where CH, IH and NP are exactly dependent. The ridge still stabilizes
	// the solve; it just no longer decides whether the model is usable.
	const conditioning = estimateLeastSquaresConditioning(informativeDataRows(rows, dataRowCount, columnCount), weights.subarray(0, dataRowCount))

	return { coefficients: new Float64Array(fit.coefficients), conditionNumber: conditioning.conditionNumber, rankDeficient: conditioning.rankDeficient, leverage: fit.leverage, looResiduals, orthogonalizationDx: orthogonalization?.dx, orthogonalizationDy: orthogonalization?.dy }
}

// Relative column norm below which a design column is treated as identically zero over the data rows
// and left out of the conditioning diagnostic.
const VANISHING_COLUMN_TOLERANCE = 1e-13

// Restricts the design to its data rows and to the columns that carry any signal there.
//
// Dropping the vanishing columns matters because a zero column is singular yet harmless. Orthogonalizing
// the empirical block against the physical one annihilates every feature the physical basis reproduces
// identically — `bias` against `CH`, for instance — and the ridge answers a null direction with a zero
// coefficient, which contributes zero at every target, not just at the training ones. A column that is
// merely linearly *dependent* on the others is the dangerous case: the ridge then splits the fitted
// signal among them arbitrarily, and the split only shows itself away from the sampled region. That case
// keeps its infinite condition number here, which is the whole point of the diagnostic.
function informativeDataRows(rows: readonly Float64Array[], dataRowCount: number, columnCount: number) {
	const norms = new Float64Array(columnCount)
	let maximumNorm = 0

	for (let row = 0; row < dataRowCount; row++) {
		const values = rows[row]
		for (let column = 0; column < columnCount; column++) norms[column] += values[column] * values[column]
	}

	for (let column = 0; column < columnCount; column++) {
		norms[column] = Math.sqrt(norms[column])
		if (norms[column] > maximumNorm) maximumNorm = norms[column]
	}

	const tolerance = maximumNorm * VANISHING_COLUMN_TOLERANCE
	const columns: number[] = []

	for (let column = 0; column < columnCount; column++) {
		if (norms[column] > tolerance) columns.push(column)
	}

	const design = new Array<Float64Array>(dataRowCount)

	for (let row = 0; row < dataRowCount; row++) {
		const source = rows[row]
		const values = new Float64Array(columns.length)
		for (let i = 0; i < columns.length; i++) values[i] = source[columns[i]]
		design[row] = values
	}

	return design
}

// Spreads the per-sample weights over the two stacked rows each sample contributes to the design, leaving
// the appended Tikhonov rows at their fixed weight of 1.
//
// `weights` is mutated in place. `baseWeights` and `robustWeights` hold one entry per sample; `weights`
// holds one per design row, with the `2 * sampleCount` data rows first. `heldOut` is the index of a
// sample to remove from the fit, or `-1` to keep them all: a zero-weighted row contributes nothing to
// either side of the normal equations, so zeroing it is exactly deleting it.
function applyStackedWeights(weights: Float64Array, baseWeights: Readonly<NumberArray>, robustWeights: Readonly<NumberArray>, sampleCount: number, heldOut: number = -1) {
	for (let i = 0; i < sampleCount; i++) {
		const weight = i === heldOut ? 0 : baseWeights[i] * robustWeights[i]
		weights[i * 2] = weight
		weights[i * 2 + 1] = weight
	}
}

// Refits the stacked model once per sample with that sample removed, and returns the radial residual
// each refit leaves at the sample it never saw (radians, one entry per sample).
//
// A robust fit cannot use the `r / (1 - h)` leverage identity: that identity assumes the row weights are
// fixed, whereas IRLS derives every weight and the residual scale from the whole dataset. Removing a
// sample — an outlier above all — moves the weights of the samples that remain, so the leverage-corrected
// residual is not the error a leave-one-out robust refit would produce, and scoring strategies with it
// would compare candidates on a quantity none of them actually has.
//
// `rows` and `target` are the full stacked design, Tikhonov rows included, so every fold carries the same
// regularization as the complete fit. Each fold warm-starts its IRLS from the converged weights of that
// fit, which is the same fixed point reached from any start and typically settles in one or two passes.
function robustLeaveOneOutResiduals(rows: readonly Float64Array[], target: Readonly<Float64Array>, sampleCount: number, baseWeights: Readonly<NumberArray>, robustWeights: Readonly<NumberArray>, robust: ResolvedPointingRobustFitConfiguration) {
	const weights = new Float64Array(rows.length).fill(1)
	const residuals = new Float64Array(sampleCount)
	const looResiduals = new Float64Array(sampleCount)
	const maxIterations = Math.max(1, robust.maxIterations)

	for (let heldOut = 0; heldOut < sampleCount; heldOut++) {
		let foldWeights = Float64Array.from(robustWeights)
		let coefficients: Readonly<NumberArray> = []

		for (let iteration = 0; iteration < maxIterations; iteration++) {
			applyStackedWeights(weights, baseWeights, foldWeights, sampleCount, heldOut)
			coefficients = leastSquaresCoefficients(rows, target, { weights })

			for (let i = 0; i < sampleCount; i++) {
				residuals[i] = i === heldOut ? 0 : Math.hypot(target[i * 2] - dotRow(rows[i * 2], coefficients), target[i * 2 + 1] - dotRow(rows[i * 2 + 1], coefficients))
			}

			const nextWeights = robustSampleWeights(residuals, robust, heldOut)
			const converged = maxWeightDifference(foldWeights, nextWeights) <= robust.tolerance
			foldWeights = nextWeights

			if (converged) break
		}

		looResiduals[heldOut] = Math.hypot(target[heldOut * 2] - dotRow(rows[heldOut * 2], coefficients), target[heldOut * 2 + 1] - dotRow(rows[heldOut * 2 + 1], coefficients))
	}

	return looResiduals
}

// Turns the per-sample inverse-variance weights into a vector with mean 1.
//
// Only the *relative* weights carry information: scaling them all would change the effective ridge and
// the robust scale estimate without changing the fit's intent. Samples that did not declare an
// uncertainty take the mean of those that did, so mixing annotated and bare samples does not silently
// privilege either group.
function normalizedSampleWeights(samples: readonly PreparedPointingSample[]) {
	const weights = new Float64Array(samples.length)
	let specifiedCount = 0
	let specifiedTotal = 0

	for (let i = 0; i < samples.length; i++) {
		if (samples[i].weight > 0) {
			specifiedTotal += samples[i].weight
			specifiedCount++
		}
	}

	const fallback = specifiedCount > 0 ? specifiedTotal / specifiedCount : 1
	let total = 0

	for (let i = 0; i < samples.length; i++) {
		const weight = samples[i].weight > 0 ? samples[i].weight : fallback
		weights[i] = weight
		total += weight
	}

	if (total > 0) {
		const scale = samples.length / total
		for (let i = 0; i < samples.length; i++) weights[i] *= scale
	}

	return weights
}

// Removes from every empirical column the part explained by the semi-physical block, mutating `rows`
// in place over the first `dataRowCount` rows. Returns the projection coefficients expressed in the
// original semi-physical columns, flattened row-major as `[physicalCount][featureCount]` per axis, so
// prediction can apply the identical subtraction to a new sample.
function orthogonalizeAgainstPhysicalBlock(rows: readonly Float64Array[], dataRowCount: number, physicalCount: number, featureCount: number) {
	// Modified Gram-Schmidt of the semi-physical block: `physical = q * r` with `r` upper triangular.
	const q = new Array<Float64Array>(physicalCount)
	const r = new Float64Array(physicalCount * physicalCount)
	let maximumNorm = 0

	for (let j = 0; j < physicalCount; j++) {
		const v = new Float64Array(dataRowCount)

		for (let row = 0; row < dataRowCount; row++) v[row] = rows[row][j]

		for (let k = 0; k < j; k++) {
			let projection = 0
			for (let row = 0; row < dataRowCount; row++) projection += q[k][row] * v[row]
			r[k * physicalCount + j] = projection
			for (let row = 0; row < dataRowCount; row++) v[row] -= projection * q[k][row]
		}

		let norm = 0
		for (let row = 0; row < dataRowCount; row++) norm += v[row] * v[row]
		norm = Math.sqrt(norm)
		r[j * physicalCount + j] = norm
		maximumNorm = Math.max(maximumNorm, norm)

		if (norm > 0) {
			for (let row = 0; row < dataRowCount; row++) v[row] /= norm
		}

		q[j] = v
	}

	const tolerance = maximumNorm * ORTHOGONALIZATION_TOLERANCE
	const dx = new Array<number>(physicalCount * featureCount).fill(0)
	const dy = new Array<number>(physicalCount * featureCount).fill(0)
	const projections = new Float64Array(physicalCount)
	const coefficients = new Float64Array(physicalCount)

	for (let block = 0; block < 2; block++) {
		const offset = physicalCount + block * featureCount
		const output = block === 0 ? dx : dy

		for (let j = 0; j < featureCount; j++) {
			const column = offset + j

			for (let k = 0; k < physicalCount; k++) {
				let projection = 0
				for (let row = 0; row < dataRowCount; row++) projection += q[k][row] * rows[row][column]
				projections[k] = projection
			}

			// Back-substitute `r * coefficients = projections` to express the projection in the original
			// semi-physical columns instead of the orthonormal ones.
			for (let k = physicalCount - 1; k >= 0; k--) {
				let sum = projections[k]
				for (let m = k + 1; m < physicalCount; m++) sum -= r[k * physicalCount + m] * coefficients[m]
				coefficients[k] = r[k * physicalCount + k] > tolerance ? sum / r[k * physicalCount + k] : 0
			}

			for (let k = 0; k < physicalCount; k++) output[k * featureCount + j] = coefficients[k]

			for (let row = 0; row < dataRowCount; row++) {
				let correction = 0
				for (let k = 0; k < physicalCount; k++) correction += coefficients[k] * rows[row][k]
				rows[row][column] -= correction
			}
		}
	}

	return { dx, dy }
}

// Mean squared entry of a column block over the data rows, used to make the ridge scale-invariant.
function blockColumnEnergy(rows: readonly Float64Array[], dataRowCount: number, offset: number, count: number) {
	if (count === 0 || dataRowCount === 0) return 0

	let energy = 0

	for (let row = 0; row < dataRowCount; row++) {
		for (let column = offset; column < offset + count; column++) {
			energy += rows[row][column] * rows[row][column]
		}
	}

	return energy / count
}

// Dot product of one design row with the coefficient vector.
function dotRow(row: Readonly<Float64Array>, coefficients: Readonly<NumberArray>) {
	let sum = 0
	for (let i = 0; i < row.length; i++) sum += row[i] * coefficients[i]
	return sum
}

// Builds robust sample weights from radial residuals.
//
// `heldOut` is the index of a sample excluded from the fit, or `-1` when none is. Its residual takes no
// part in the scale estimate and its weight is returned as zero, so a leave-one-out refit derives its
// weighting from the samples it actually saw.
function robustSampleWeights(residuals: Readonly<NumberArray>, robust: ResolvedPointingRobustFitConfiguration, heldOut: number = -1) {
	if (robust.method === 'none' || residuals.length === 0) {
		const weights = new Float64Array(residuals.length)
		weights.fill(1)
		if (heldOut >= 0) weights[heldOut] = 0
		return weights
	}

	const scale = robustResidualScale(residuals, heldOut)
	const weights = new Float64Array(residuals.length)

	for (let i = 0; i < residuals.length; i++) {
		if (i === heldOut) continue

		const normalizedResidual = Math.abs(residuals[i]) / (Math.max(scale, Number.EPSILON) * robust.tuning)

		if (robust.method === 'tukey') {
			if (normalizedResidual >= 1) weights[i] = 0
			else {
				const t = 1 - normalizedResidual * normalizedResidual
				weights[i] = t * t
			}
		} else {
			weights[i] = normalizedResidual <= 1 ? 1 : 1 / normalizedResidual
		}
	}

	return weights
}

// Computes a robust scale estimate for residual magnitudes, skipping `heldOut` when it is not `-1`.
function robustResidualScale(values: Readonly<NumberArray>, heldOut: number = -1) {
	const count = values.length - (heldOut >= 0 && heldOut < values.length ? 1 : 0)

	if (count <= 0) return 0

	const sorted = new Float64Array(count)

	for (let i = 0, j = 0; i < values.length; i++) {
		if (i !== heldOut) sorted[j++] = Math.abs(values[i])
	}

	const median = medianOf(sorted.sort())
	return median > 0 ? median * STANDARD_DEVIATION_SCALE : rmsOf(sorted)
}

// Computes the maximum absolute delta between two weight vectors.
function maxWeightDifference(a: Readonly<NumberArray>, b: Readonly<NumberArray>) {
	let difference = 0

	for (let i = 0; i < a.length; i++) {
		const delta = Math.abs(a[i] - b[i])
		if (delta > difference) difference = delta
	}

	return difference
}

// Predicts the empirical model offset from the fitted coefficients, repeating the orthogonalization
// applied at fit time when the model carries one.
//
// Subtracting the stored projection is equivalent to shifting the semi-physical parameters, because
// every orthogonalized column is `feature - projection onto the semi-physical block`. Expanding both
// axes collapses the correction into a single vector `u` over the semi-physical terms, so only one
// basis evaluation is needed.
function predictEmpiricalOffset(model: EmpiricalPointingModel, context: PointingContext, configuration: ResolvedPointingFeatureConfiguration, terms: readonly SemiPhysicalTermName[] | undefined): PointingOffset {
	const featureCount = model.featureNames.length
	const features = new Float64Array(featureCount)
	featuresFromContext(context, configuration, features)

	const dx = predictLinearLeastSquares(model.coefficientsDx, features)
	const dy = predictLinearLeastSquares(model.coefficientsDy, features)
	const orthogonalizationDx = model.orthogonalizationDx
	const orthogonalizationDy = model.orthogonalizationDy

	if (!orthogonalizationDx || !orthogonalizationDy || !terms || terms.length === 0) return { dx, dy }

	const physicalCount = terms.length
	const basisDx = new Float64Array(physicalCount)
	const basisDy = new Float64Array(physicalCount)
	semiPhysicalBasis(context, terms, basisDx, basisDy)

	let correctionDx = 0
	let correctionDy = 0

	for (let k = 0; k < physicalCount; k++) {
		let u = 0

		for (let j = 0; j < featureCount; j++) {
			u += model.coefficientsDx[j] * orthogonalizationDx[k * featureCount + j] + model.coefficientsDy[j] * orthogonalizationDy[k * featureCount + j]
		}

		correctionDx += u * basisDx[k]
		correctionDy += u * basisDy[k]
	}

	return { dx: dx - correctionDx, dy: dy - correctionDy }
}

// Predicts each model component individually for diagnostics and correction metadata.
function predictModelComponents(model: FittedPointingModel, context: PointingContext) {
	const physical = model.physical ? predictSemiPhysicalOffset(model.physical.parameters, model.physical.terms, context) : undefined
	const empirical = model.strategy === 'empirical' && model.empirical ? predictEmpiricalOffset(model.empirical, context, model.featureConfiguration, model.physical?.terms) : undefined
	const residual = model.strategy === 'hybrid' && model.residual ? predictEmpiricalOffset(model.residual, context, model.featureConfiguration, model.physical?.terms) : undefined
	const local = model.local ? predictLocalPointingResidual(model.local, context.rightAscension, context.declination, context.pierSide) : undefined
	return { physical, empirical, residual, local }
}

// Sums the global model components into the total predicted offset, with no quality assessment.
//
// Diagnostics need exactly this and nothing else. Calling the public prediction instead would evaluate
// the support geometry per sample and, worse, would have to do it through a model whose `diagnostics`
// are still the empty placeholder being computed, so the pier-side counts it reads are all zero.
//
// The local layer is excluded on purpose: it is trained on the residuals this function produces, so
// including it would define the residuals in terms of themselves.
function predictModelOffset(model: FittedPointingModel, context: PointingContext): PointingOffset {
	if (!model.usable) return { dx: 0, dy: 0 }

	const { physical, empirical, residual } = predictModelComponents(model, context)
	return { dx: (physical?.dx ?? 0) + (empirical?.dx ?? 0) + (residual?.dx ?? 0), dy: (physical?.dy ?? 0) + (empirical?.dy ?? 0) + (residual?.dy ?? 0) }
}

// Rescales one in-sample residual into its leave-one-out counterpart from that row's leverage.
//
// Leverage saturates at 1 for a row the fit reproduces exactly on its own, where the hold-out residual is
// genuinely undefined. Clamping just below 1 keeps the RMS finite and, being large, still flags the row
// as unsupported rather than hiding it.
function leaveOneOutResidual(residual: number, leverage: number) {
	return residual / Math.max(1 - leverage, MINIMUM_LEVERAGE_COMPLEMENT)
}

// Global-model residuals at every accepted training sample, per axis (radians).
interface ModelResiduals {
	// East residual of each sample, `error.dx - prediction.dx`.
	readonly dx: Float64Array
	// North residual of each sample, `error.dy - prediction.dy`.
	readonly dy: Float64Array
}

// Evaluates the global model at every training sample and returns what it failed to explain.
//
// The local layer and the diagnostics both need exactly this, and each prediction costs a basis
// evaluation, so it is computed once for both. The arrays are never sorted in place by either consumer.
function computeModelResiduals(samples: readonly PreparedPointingSample[], model: FittedPointingModel): ModelResiduals {
	const dx = new Float64Array(samples.length)
	const dy = new Float64Array(samples.length)

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		const prediction = predictModelOffset(model, sample.context)
		dx[i] = sample.error.dx - prediction.dx
		dy[i] = sample.error.dy - prediction.dy
	}

	return { dx, dy }
}

// Builds the local residual layer for a fit, or returns `undefined` when it must not be applied.
//
// An unusable global model predicts zero, so its "residuals" are the raw pointing errors. Letting the
// local layer interpolate those would turn a model that correctly refuses to correct into one that
// silently applies a nearest-neighbour correction with no mechanical basis at all.
function buildLocalResidualLayer(directions: readonly number[], pierSides: readonly PierSide[], residuals: ModelResiduals, options: ResolvedLocalPointingResidualOptions, usable: boolean) {
	if (!options.enabled || !usable || pierSides.length === 0) return undefined
	return buildLocalPointingResidual(directions, pierSides, residuals.dx, residuals.dy, options)
}

// Builds fit diagnostics from the global model's residuals and the training samples.
//
// The residuals are deliberately those of the global model alone. The local layer interpolates its own
// training residuals almost exactly, so including it would drive `angularRms` towards zero and report
// an accuracy that no new target would ever see.
function buildPointingDiagnostics(totalSamples: number, prepared: PreparedPointingSamples, model: FittedPointingModel, basis: ResolvedPointingBasis, fit: StackedOffsetFit, modelResiduals: ModelResiduals): PointingDiagnostics {
	const residuals = new Float64Array(prepared.accepted.length)
	const residualsDx = modelResiduals.dx
	const residualsDy = modelResiduals.dy
	const looResiduals = fit.leverage || fit.looResiduals ? new Float64Array(prepared.accepted.length) : undefined
	const warnings = [...prepared.warnings]
	const rejectedReasonCounts: Record<string, number> = {}
	const perPierSideSampleCounts = { EAST: 0, WEST: 0, NEITHER: 0 }

	for (let i = 0; i < prepared.rejected.length; i++) {
		const reason = prepared.rejected[i].reason
		rejectedReasonCounts[reason] = (rejectedReasonCounts[reason] ?? 0) + 1
	}

	for (let i = 0; i < prepared.accepted.length; i++) {
		const sample = prepared.accepted[i]
		const dx = residualsDx[i]
		const dy = residualsDy[i]

		residuals[i] = Math.hypot(dx, dy)

		if (looResiduals) {
			if (fit.looResiduals) {
				// A robust fit measures its hold-out error by refitting without the sample, so the value is
				// already the residual of a model that never saw it.
				looResiduals[i] = fit.looResiduals[i]
			} else if (fit.leverage) {
				// With fixed weights, `r / (1 - h)` is exactly the residual the fit would have produced with
				// this row held out. Applied per row rather than per sample: a true block hold-out would also
				// need the east/north cross term of the hat matrix, which barely moves the result and costs a
				// 2x2 solve per sample.
				looResiduals[i] = Math.hypot(leaveOneOutResidual(dx, fit.leverage[i * 2]), leaveOneOutResidual(dy, fit.leverage[i * 2 + 1]))
			}
		}

		perPierSideSampleCounts[sample.context.pierSide]++
	}

	// The same summary the model publishes: it is computed from `prepared.accepted`, which has not changed
	// since, so summarizing the set a second time would only rebuild an identical object.
	const skyCoverage = model.coverage
	const conditionNumber = diagnosticConditionNumber(model)

	if (perPierSideSampleCounts.EAST === 0 || perPierSideSampleCounts.WEST === 0) {
		warnings.push('only one pier side is represented in the fitted sample set')
	}

	if (skyCoverage.skyCoverageRatio < 0.35) {
		warnings.push('samples cluster heavily in one sky region')
	}

	if (!Number.isFinite(conditionNumber) || conditionNumber > 1e8) {
		warnings.push('the fitted model is poorly constrained or ill-conditioned')
	}

	if (!basis.sufficient) {
		warnings.push(`too few samples to fit ${basis.parameterCount} parameter(s); the model is not usable for prediction`)
	}

	if (basis.droppedTerms.length > 0) {
		warnings.push(`dropped term(s): ${basis.droppedTerms.join('; ')}`)
	}

	residuals.sort()
	looResiduals?.sort()

	// Every reducer returns NaN for an empty input, and a fit where no sample survived validation is a
	// legitimate outcome rather than a numerical failure: `emptyDiagnostics` already reports zeros for
	// exactly that state. Reporting the same zeros here keeps NaN out of a public field, and out of the
	// strategy comparison, where it would silently lose every ordering it takes part in.
	const summarizable = prepared.accepted.length > 0
	const usableLooResiduals = summarizable ? looResiduals : undefined

	return {
		supportedContext: prepared.supportedContext,
		droppedTerms: basis.droppedTerms,
		looRms: usableLooResiduals && rmsOf(usableLooResiduals),
		looResidualPercentiles: usableLooResiduals && { p50: percentileOf(usableLooResiduals, 0.5), p90: percentileOf(usableLooResiduals, 0.9), p95: percentileOf(usableLooResiduals, 0.95) },
		totalSamples,
		validSamples: prepared.accepted.length,
		rejectedSamples: prepared.rejected.length,
		rmsDx: summarizable ? rmsOf(residualsDx) : 0,
		rmsDy: summarizable ? rmsOf(residualsDy) : 0,
		angularRms: summarizable ? rmsOf(residuals) : 0,
		medianResidual: summarizable ? medianOf(residuals) : 0,
		residualPercentiles: summarizable
			? {
					p50: percentileOf(residuals, 0.5),
					p90: percentileOf(residuals, 0.9),
					p95: percentileOf(residuals, 0.95),
				}
			: { p50: 0, p90: 0, p95: 0 },
		conditionNumber,
		skyCoverage,
		perPierSideSampleCounts,
		warnings,
		rejectedReasonCounts,
	}
}

// Summarizes the sampled sky region and observing-site coverage.
function summarizePointingCoverage(samples: readonly PreparedPointingSample[]): PointingCoverageSummary {
	if (samples.length === 0) {
		return { occupiedSkyBins: 0, totalSkyBins: TOTAL_SKY_BINS, skyCoverageRatio: 0 }
	}

	let minHa = Number.POSITIVE_INFINITY
	let maxHa = Number.NEGATIVE_INFINITY
	let minDec = Number.POSITIVE_INFINITY
	let maxDec = Number.NEGATIVE_INFINITY
	let minAlt = Number.POSITIVE_INFINITY
	let maxAlt = Number.NEGATIVE_INFINITY
	let minLat = Number.POSITIVE_INFINITY
	let maxLat = Number.NEGATIVE_INFINITY
	let minLon = Number.POSITIVE_INFINITY
	let maxLon = Number.NEGATIVE_INFINITY
	let hasHa = false
	let hasAlt = false
	let hasLat = false
	let hasLon = false
	const bins = new Uint8Array(TOTAL_SKY_BINS)

	for (let i = 0; i < samples.length; i++) {
		const { context } = samples[i]
		const dec = context.declination
		minDec = Math.min(minDec, dec)
		maxDec = Math.max(maxDec, dec)

		if (context.hourAngle !== undefined) {
			hasHa = true
			minHa = Math.min(minHa, context.hourAngle)
			maxHa = Math.max(maxHa, context.hourAngle)
		}

		if (context.altitude !== undefined) {
			hasAlt = true
			minAlt = Math.min(minAlt, context.altitude)
			maxAlt = Math.max(maxAlt, context.altitude)
		}

		if (context.latitude !== undefined) {
			hasLat = true
			minLat = Math.min(minLat, context.latitude)
			maxLat = Math.max(maxLat, context.latitude)
		}

		if (context.longitude !== undefined) {
			hasLon = true
			minLon = Math.min(minLon, context.longitude)
			maxLon = Math.max(maxLon, context.longitude)
		}

		const haBin = context.hourAngle === undefined ? 0 : Math.min(5, Math.max(0, Math.floor(((context.hourAngle + PI) / TAU) * 6)))
		const decBin = Math.min(3, Math.max(0, Math.floor(((dec + PIOVERTWO) / PI) * 4)))
		bins[haBin * 4 + decBin] = 1
	}

	let occupiedSkyBins = 0

	for (let i = 0; i < bins.length; i++) {
		occupiedSkyBins += bins[i]
	}

	return {
		hourAngleRange: hasHa ? [minHa, maxHa] : undefined,
		declinationRange: [minDec, maxDec],
		altitudeRange: hasAlt ? [minAlt, maxAlt] : undefined,
		latitudeRange: hasLat ? [minLat, maxLat] : undefined,
		longitudeRange: hasLon ? [minLon, maxLon] : undefined,
		occupiedSkyBins,
		totalSkyBins: TOTAL_SKY_BINS,
		skyCoverageRatio: occupiedSkyBins / TOTAL_SKY_BINS,
	}
}

// Computes the dominant diagnostic condition number for the selected strategy.
function diagnosticConditionNumber(model: FittedPointingModel) {
	if (model.strategy === 'empirical') {
		return Math.max(model.empirical?.conditionNumberDx ?? Number.POSITIVE_INFINITY, model.empirical?.conditionNumberDy ?? Number.POSITIVE_INFINITY)
	}

	if (model.strategy === 'semiPhysical') {
		return model.physical?.conditionNumber ?? Number.POSITIVE_INFINITY
	}

	return Math.max(model.physical?.conditionNumber ?? 0, model.residual?.conditionNumberDx ?? 0, model.residual?.conditionNumberDy ?? 0)
}

// Packs the accepted samples into the flat direction and pier-side arrays both neighbourhood layers work
// on: `directions` as `[x0, y0, z0, x1, ...]` unit vectors, `pierSides` aligned with it, one entry per
// sample. The support set and the local residual layer measure different neighbourhoods over the same
// geometry, so this is built once and passed to both.
function packSampleDirections(samples: readonly PreparedPointingSample[]) {
	const directions = new Array<number>(samples.length * 3)
	const pierSides = new Array<PierSide>(samples.length)

	for (let i = 0; i < samples.length; i++) {
		const direction = samples[i].direction
		directions[i * 3] = direction[0]
		directions[i * 3 + 1] = direction[1]
		directions[i * 3 + 2] = direction[2]
		pierSides[i] = samples[i].context.pierSide
	}

	return { directions, pierSides }
}

// Builds the training-direction set kept on the model for prediction support scoring.
//
// `directions` is flattened as `[x0, y0, z0, ...]`, one unit vector per entry of `pierSides`. Both arrays
// are kept on the returned set by reference, so the caller must not mutate them afterwards.
function buildPointingSupportSet(directions: readonly number[], pierSides: readonly PierSide[]): PointingSupportSet | undefined {
	const count = pierSides.length

	if (count === 0) return undefined

	// The decay length is the training set's own median k-th neighbour distance, so `support` reads the
	// same way for a dense 200-point run and a sparse 20-point one: it measures distance in units of the
	// spacing this particular model was built with.
	//
	// It is measured per pier side, exactly as a query will measure it. Measuring it over the whole set
	// instead would compare a two-sided spacing against a one-sided query distance, and since filtering to
	// one side roughly halves the density, every prediction would score as if it had drifted away from the
	// sampled region — including one sitting on a training sample. A side-less query still measures against
	// every sample and so scores optimistically, which is the right direction to err for a request that did
	// not say which side of the mount it applies to.
	const spacings = new Float64Array(count)

	for (let i = 0; i < count; i++) {
		spacings[i] = neighborDistances(directions, pierSides, directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2], pierSides[i], i).kth
	}

	const scale = medianOf(spacings.sort())
	return { directions, pierSides, scale: Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SUPPORT_SCALE }
}

// Nearest and k-th nearest angular distances from a direction to the support set, optionally limited to
// one pier side and optionally skipping one index (used when measuring the training set against itself).
//
// Brute force over a few hundred unit vectors is faster than any spatial index at this size. Distances
// come from the chord length through `2*asin(chord/2)`, which stays accurate for small separations where
// `acos(dot)` loses most of its precision.
function neighborDistances(directions: readonly number[], pierSides: readonly PierSide[], x: number, y: number, z: number, pierSide: PierSide | undefined, skipIndex: number) {
	const count = pierSides.length
	const nearest = new Float64Array(SUPPORT_NEIGHBORS).fill(Number.POSITIVE_INFINITY)
	let considered = 0

	for (let i = 0; i < count; i++) {
		if (i === skipIndex) continue
		if (pierSide !== undefined && pierSides[i] !== pierSide) continue

		const dx = directions[i * 3] - x
		const dy = directions[i * 3 + 1] - y
		const dz = directions[i * 3 + 2] - z
		const distance = 2 * Math.asin(Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2))
		considered++

		if (distance >= nearest[SUPPORT_NEIGHBORS - 1]) continue

		let slot = SUPPORT_NEIGHBORS - 1

		while (slot > 0 && nearest[slot - 1] > distance) {
			nearest[slot] = nearest[slot - 1]
			slot--
		}

		nearest[slot] = distance
	}

	// With fewer than k neighbours the k-th slot is still infinite, which would zero the support of an
	// otherwise well-sampled small set. Fall back to the farthest neighbour actually found.
	const kth = considered >= SUPPORT_NEIGHBORS ? nearest[SUPPORT_NEIGHBORS - 1] : nearest[Math.max(0, Math.min(considered, SUPPORT_NEIGHBORS) - 1)]
	return { nearest: nearest[0], kth } as const
}

// Scores how well the training samples support a prediction, as a continuous spherical measure.
//
// This replaces a min/max box over hour angle, declination and altitude, which failed in two ways: hour
// angle is circular, so samples near both ends made the whole sky look covered, and being inside a range
// says nothing about being near an actual sample.
function evaluatePredictionQuality(model: FittedPointingModel, context: PointingContext): PointingPredictionQuality {
	const warnings: string[] = []
	const pierSideCovered = context.pierSide === 'NEITHER' || model.diagnostics.perPierSideSampleCounts[context.pierSide] > 0
	const supportSet = model.supportSet

	// The correction is only meaningful in the frame the terms were fitted in; a coordinate declaring
	// another one differs by precession, aberration or refraction, which the model never saw.
	if (context.frame !== undefined && context.frame !== model.frame) {
		warnings.push(`prediction is in the ${context.frame} frame but the model was fitted in ${model.frame}`)
	}

	if (!supportSet || supportSet.pierSides.length === 0) {
		warnings.push('the model carries no training directions to measure support against')
		return { nearestSampleDistance: Number.POSITIVE_INFINITY, kthNeighborDistance: Number.POSITIVE_INFINITY, support: 0, extrapolating: true, pierSideCovered, warnings }
	}

	const [x, y, z] = eraS2c(context.rightAscension, context.declination)
	// Mount flexure differs between pier sides, so support is measured only against samples on the same
	// side; falling back to the whole set when that side was never sampled would overstate it.
	const distances = neighborDistances(supportSet.directions, supportSet.pierSides, x, y, z, pierSideCovered && context.pierSide !== 'NEITHER' ? context.pierSide : undefined, -1)
	const support = Number.isFinite(distances.kth) ? Math.exp(-Math.max(0, distances.kth - supportSet.scale) / supportSet.scale) : 0
	const extrapolating = support < MINIMUM_PREDICTION_SUPPORT

	if (extrapolating) {
		warnings.push('prediction is far from the sampled sky region')
	}

	if (!pierSideCovered) {
		warnings.push('prediction uses a pier side that was not present during training')
	}

	return { nearestSampleDistance: distances.nearest, kthNeighborDistance: distances.kth, support, extrapolating, pierSideCovered, warnings }
}

// Produces the unfitted-model fallback used before a fit has been computed.
function unfittedPrediction(input: Readonly<PointingModelInput>): PredictedPointingError {
	return {
		dx: 0,
		dy: 0,
		offsetMagnitude: 0,
		representationUsed: 'vectorTangent',
		quality: {
			nearestSampleDistance: Number.POSITIVE_INFINITY,
			kthNeighborDistance: Number.POSITIVE_INFINITY,
			support: 0,
			extrapolating: true,
			pierSideCovered: false,
			warnings: ['model is not fitted'],
		},
		components: { physical: { dx: 0, dy: 0 }, empirical: { dx: 0, dy: 0 }, residual: { dx: 0, dy: 0 } },
	}
}

// Produces the default diagnostics object for the empty state.
function emptyDiagnostics(totalSamples: number): PointingDiagnostics {
	return {
		supportedContext: 'none',
		droppedTerms: [],
		totalSamples,
		validSamples: 0,
		rejectedSamples: totalSamples,
		rmsDx: 0,
		rmsDy: 0,
		angularRms: 0,
		medianResidual: 0,
		residualPercentiles: { p50: 0, p90: 0, p95: 0 },
		conditionNumber: Number.POSITIVE_INFINITY,
		skyCoverage: { occupiedSkyBins: 0, totalSkyBins: TOTAL_SKY_BINS, skyCoverageRatio: 0 },
		perPierSideSampleCounts: { EAST: 0, WEST: 0, NEITHER: 0 },
		warnings: ['no fitted model is available'],
		rejectedReasonCounts: {},
	}
}
