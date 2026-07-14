import { angularDistance, type EquatorialCoordinate, equatorialToHorizontal } from '../../astronomy/coordinates/coordinate'
import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { localSiderealTime } from '../../astronomy/observer/location'
import type { Time } from '../../astronomy/time/time'
import { AMIN2RAD, DEG2RAD, PI, PIOVERTWO, TAU } from '../../core/constants'
import { medianOf, percentileOf, rmsOf, STANDARD_DEVIATION_SCALE } from '../../core/util'
import type { PierSide } from '../../devices/indi/device'
import { type Vec3, vecAngle } from '../../math/linear-algebra/vec3'
import { sphericalProjectTangentPlane, sphericalUnprojectTangentPlane } from '../../math/numerical/geometry'
import { linearLeastSquares, predictLinearLeastSquares, type RobustRegressionMethod, robustLinearLeastSquares } from '../../math/numerical/least.squares'
import type { NumberArray } from '../../math/numerical/math'
import { type Angle, normalizePI } from '../../math/units/angle'

// Telescope mount pointing-model fitting and correction. Takes commanded vs plate-solved sky samples
// and fits the systematic pointing error as a local tangent-plane offset (dx east, dy north, radians)
// using three strategies: a linear empirical feature model, a semi-physical TPOINT-style parameter
// model (IH/ID/MA/ME/NPAE/CONE/FLEXURE), or a hybrid (physical + empirical residual). Provides sample
// validation, robust (IRLS) fitting, sky-coverage diagnostics, and forward correction of new targets.

// Fitting strategy: 'empirical' linear features only, 'semiPhysical' TPOINT-style parameters only,
// 'hybrid' semi-physical model plus an empirical residual correction.
export type PointingModelStrategy = 'empirical' | 'semiPhysical' | 'hybrid'

// How the angular pointing error is expressed: full gnomonic tangent-plane projection, or a linearized
// small-angle (`dRA·cosDec`, `dDec`) approximation.
export type PointingErrorRepresentation = 'vectorTangent' | 'smallAngle'

// Names of the semi-physical (TPOINT-like) parameters: index/collimation, polar-axis misalignment in
// azimuth/elevation, non-perpendicularity, optical-axis cone error, and tube flexure.
export type SemiPhysicalParameterName = 'IH' | 'ID' | 'MA' | 'ME' | 'NPAE' | 'CONE' | 'FLEXURE'

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
}

// A coordinate plus optional context to evaluate or correct with a fitted model.
export interface PointingModelInput extends EquatorialCoordinate {
	// Time used to derive hour angle and altitude (radians via LST).
	time?: Time
	// Site latitude (radians).
	latitude?: Angle
	// Site longitude (radians, positive east).
	longitude?: Angle
	// Mount pier side.
	pierSide?: PierSide
}

// A local tangent-plane offset in radians: dx toward east, dy toward north.
export interface PointingOffset {
	// East-positive tangent offset (radians).
	readonly dx: number
	// North-positive tangent offset (radians).
	readonly dy: number
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

// Toggles for which empirical basis terms enter the design matrix.
export interface PointingFeatureConfiguration {
	// Include a constant bias term.
	readonly includeBias?: boolean
	// Include sin/cos of hour angle.
	readonly includeHourAngleTerms?: boolean
	// Include sin/cos of declination.
	readonly includeDeclinationTerms?: boolean
	// Include sin/cos of altitude.
	readonly includeAltitudeTerms?: boolean
	// Include hour-angle×declination and altitude×declination cross terms.
	readonly includeCrossTerms?: boolean
	// Include pier-side terms (and pier-side×angle cross terms when cross terms are enabled).
	readonly includePierSideTerms?: boolean
	// Include normalized-angle polynomial terms.
	readonly includePolynomialTerms?: boolean
}

// Feature configuration with all flags resolved to concrete booleans.
export type ResolvedPointingFeatureConfiguration = Required<PointingFeatureConfiguration>

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
	// Tikhonov ridge regularization applied to the normal equations.
	ridge?: number
	// Empirical feature toggles.
	featureConfiguration?: PointingFeatureConfiguration
	// Sample validation thresholds.
	validation?: PointingValidationOptions
	// Robust fitting configuration.
	robust?: PointingRobustFitConfiguration
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
	// RMS of radial residuals (radians).
	readonly angularRms: Angle
	// Median radial residual (radians).
	readonly medianResidual: Angle
	// Radial residual percentiles (radians).
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
}

// Indicates how trustworthy a single prediction is relative to the training coverage.
export interface PointingPredictionQuality {
	// True when the requested point lies inside the sampled HA/Dec/altitude ranges.
	readonly insideCoverage: boolean
	// True when the requested pier side was represented during training.
	readonly pierSideCovered: boolean
	// Number of training samples backing the model.
	readonly support: number
	// Per-prediction warnings.
	readonly warnings: readonly string[]
}

// A predicted error broken down into its model components plus a quality assessment.
export interface PredictedPointingError extends PointingError {
	// Trust assessment for this prediction.
	readonly quality: PointingPredictionQuality
	// Individual contributions from each model component (radians).
	readonly components: {
		readonly physical?: PointingOffset
		readonly empirical?: PointingOffset
		readonly residual?: PointingOffset
	}
}

// A corrected coordinate together with the error that was applied.
export interface CorrectionResult extends Readonly<EquatorialCoordinate> {
	// The predicted local error subtracted to produce this coordinate.
	readonly predictedError: PredictedPointingError
}

// A computed empirical feature row plus the context it was derived from.
export interface PointingFeatureVector {
	// Ordered feature names matching `values`.
	readonly names: readonly string[]
	// Feature values aligned with `names`.
	readonly values: Readonly<Float64Array>
	// Geometric context used to build the features.
	readonly context: PointingContext
}

// An orthonormal local tangent-plane basis at a sky position.
export interface PointingTangentBasis {
	// Unit position vector at the tangent point.
	readonly origin: Vec3
	// East-pointing unit basis vector.
	readonly east: Vec3
	// North-pointing unit basis vector.
	readonly north: Vec3
}

// A tangent-plane projection result that also exposes the gnomonic denominator (for singularity checks).
export interface TangentPlaneProjection extends PointingOffset {
	// Gnomonic projection denominator; near zero indicates a degenerate projection.
	readonly denominator: number
}

// Geometric state derived from a coordinate and observing context, shared by all model components.
export interface PointingContext extends Readonly<EquatorialCoordinate> {
	// Observation time, when available.
	readonly time?: Time
	// Normalized pier side ('EAST' | 'WEST' | 'NEITHER').
	readonly pierSide: PierSide
	// Numeric pier-side encoding: +1 east, -1 west, 0 neither.
	readonly pierSideValue: number
	// Local apparent sidereal time (radians), when derivable.
	readonly lst?: Angle
	// Hour angle (radians, normalized to -PI..PI), when derivable.
	readonly hourAngle?: Angle
	// Altitude above the horizon (radians), when derivable.
	readonly altitude?: Angle
	// Azimuth (radians), when derivable.
	readonly azimuth?: Angle
	// Site latitude (radians).
	readonly latitude?: Angle
	// Site longitude (radians, positive east).
	readonly longitude?: Angle
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
}

// Fitted semi-physical model: shared TPOINT-style parameters driving both dx and dy.
export interface SemiPhysicalPointingModel {
	// Parameter names (IH/ID/MA/ME/NPAE/CONE/FLEXURE).
	readonly parameterNames: readonly string[]
	// Fitted parameter values aligned with `parameterNames`.
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
	// Number of accepted training samples.
	readonly trainingSampleCount: number
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
}

// Fully resolved fit options with all defaults applied.
interface ResolvedPointingFitOptions {
	readonly strategy: PointingModelStrategy
	readonly errorRepresentation: PointingErrorRepresentation
	readonly ridge: number
	readonly featureConfiguration: ResolvedPointingFeatureConfiguration
	readonly validation: ResolvedPointingValidationOptions
	readonly robust: ResolvedPointingRobustFitConfiguration
}

// Current model-structure serialization version.
const POINTING_MODEL_VERSION = 1
// Default Tikhonov ridge applied to the normal equations for numerical stability.
const DEFAULT_RIDGE = 1e-6
// Default empirical feature set: all geometric terms on, polynomial terms off.
const DEFAULT_FEATURE_CONFIGURATION: ResolvedPointingFeatureConfiguration = {
	includeBias: true,
	includeHourAngleTerms: true,
	includeDeclinationTerms: true,
	includeAltitudeTerms: true,
	includeCrossTerms: true,
	includePierSideTerms: true,
	includePolynomialTerms: false,
}
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

// Ordered semi-physical parameter names; the basis builder relies on these fixed indices.
export const SEMI_PHYSICAL_PARAMETER_NAMES = ['IH', 'ID', 'MA', 'ME', 'NPAE', 'CONE', 'FLEXURE'] as const

// Number of HA×Dec coverage bins (6 hour-angle × 4 declination) used for the sky-coverage ratio.
const TOTAL_SKY_BINS = 24

// Extracts the geometric context needed by the empirical and semi-physical models.
export function extractPointingContext(input: Readonly<PointingModelInput>): PointingContext {
	const pierSide = normalizePierSide(input.pierSide)
	const latitude = isFiniteAngle(input.latitude) ? input.latitude : undefined
	const longitude = isFiniteAngle(input.longitude) ? input.longitude : undefined

	let lst: Angle | undefined
	let hourAngle: Angle | undefined
	let azimuth: Angle | undefined
	let altitude: Angle | undefined

	if (input.time && longitude !== undefined) {
		lst = localSiderealTime(input.time, longitude, true)
		hourAngle = normalizePI(lst - input.rightAscension)
	}

	if (latitude !== undefined && lst !== undefined) {
		;[azimuth, altitude] = equatorialToHorizontal(input.rightAscension, input.declination, latitude, lst)
	}

	return { rightAscension: input.rightAscension, declination: input.declination, time: input.time, pierSide, pierSideValue: pierSide === 'EAST' ? 1 : pierSide === 'WEST' ? -1 : 0, lst, hourAngle, azimuth, altitude, latitude, longitude }
}

// Builds the deterministic empirical feature-name list for the configured model.
export function buildEmpiricalPointingFeatureNames(configuration: PointingFeatureConfiguration = {}): readonly string[] {
	const resolved = resolveFeatureConfiguration(configuration)
	const names: string[] = []

	if (resolved.includeBias) names.push('bias')
	if (resolved.includeHourAngleTerms) names.push('sinHA', 'cosHA')
	if (resolved.includeDeclinationTerms) names.push('sinDec', 'cosDec')
	if (resolved.includeAltitudeTerms) names.push('sinAlt', 'cosAlt')
	if (resolved.includePierSideTerms) names.push('pierSide')
	if (resolved.includeCrossTerms) {
		names.push('sinHA*sinDec', 'sinHA*cosDec', 'cosHA*sinDec', 'cosHA*cosDec')
		names.push('sinAlt*sinDec', 'cosAlt*cosDec')
		if (resolved.includePierSideTerms) names.push('pierSide*sinHA', 'pierSide*cosHA', 'pierSide*sinDec', 'pierSide*cosDec')
	}
	if (resolved.includePolynomialTerms) names.push('normalizedHA', 'normalizedDec', 'normalizedHA*normalizedDec')

	return names
}

// Extracts the configured empirical feature vector from the current sky position and mount state.
export function extractEmpiricalPointingFeatures(input: Readonly<PointingModelInput>, configuration: PointingFeatureConfiguration = {}): PointingFeatureVector {
	const resolved = resolveFeatureConfiguration(configuration)
	const context = extractPointingContext(input)
	const names = buildEmpiricalPointingFeatureNames(resolved)
	const values = new Float64Array(names.length)
	let index = 0

	const hourAngle = context.hourAngle ?? 0
	const altitude = context.altitude ?? 0
	const normalizedHourAngle = context.hourAngle === undefined ? 0 : hourAngle / PI
	const normalizedDeclination = input.declination / PIOVERTWO
	const sinHa = context.hourAngle === undefined ? 0 : Math.sin(hourAngle)
	const cosHa = context.hourAngle === undefined ? 0 : Math.cos(hourAngle)
	const sinDec = Math.sin(input.declination)
	const cosDec = Math.cos(input.declination)
	const sinAlt = context.altitude === undefined ? 0 : Math.sin(altitude)
	const cosAlt = context.altitude === undefined ? 0 : Math.cos(altitude)
	const pierSide = context.pierSideValue

	if (resolved.includeBias) values[index++] = 1

	if (resolved.includeHourAngleTerms) {
		values[index++] = sinHa
		values[index++] = cosHa
	}

	if (resolved.includeDeclinationTerms) {
		values[index++] = sinDec
		values[index++] = cosDec
	}

	if (resolved.includeAltitudeTerms) {
		values[index++] = sinAlt
		values[index++] = cosAlt
	}

	if (resolved.includePierSideTerms) values[index++] = pierSide

	if (resolved.includeCrossTerms) {
		values[index++] = sinHa * sinDec
		values[index++] = sinHa * cosDec
		values[index++] = cosHa * sinDec
		values[index++] = cosHa * cosDec
		values[index++] = sinAlt * sinDec
		values[index++] = cosAlt * cosDec

		if (resolved.includePierSideTerms) {
			values[index++] = pierSide * sinHa
			values[index++] = pierSide * cosHa
			values[index++] = pierSide * sinDec
			values[index++] = pierSide * cosDec
		}
	}

	if (resolved.includePolynomialTerms) {
		values[index++] = normalizedHourAngle
		values[index++] = normalizedDeclination
		values[index++] = normalizedHourAngle * normalizedDeclination
	}

	return { names, values, context }
}

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

// Fits a complete pointing model from the current sample set.
export function fitPointingModel(samples: readonly PointingSample[], options: Readonly<PointingFitOptions> = {}): FittedPointingModel {
	const resolved = resolveFitOptions(options)
	const prepared = preparePointingSamples(samples, resolved)
	const coverage = summarizePointingCoverage(prepared.accepted)
	const empiricalFeatureNames = buildEmpiricalPointingFeatureNames(resolved.featureConfiguration)
	const physical = resolved.strategy === 'semiPhysical' || resolved.strategy === 'hybrid' ? fitSemiPhysicalModel(prepared.accepted, resolved) : undefined
	const empirical = resolved.strategy === 'empirical' ? fitEmpiricalModel(prepared.accepted, resolved, undefined) : undefined
	const residual = resolved.strategy === 'hybrid' ? fitEmpiricalResidualModel(prepared.accepted, resolved, physical) : undefined

	const provisional: FittedPointingModel = {
		version: POINTING_MODEL_VERSION,
		strategy: resolved.strategy,
		errorRepresentation: resolved.errorRepresentation,
		signConvention: DEFAULT_SIGN_CONVENTION,
		featureConfiguration: resolved.featureConfiguration,
		validation: resolved.validation,
		robust: resolved.robust,
		ridge: resolved.ridge,
		trainingSampleCount: prepared.accepted.length,
		coverage,
		diagnostics: emptyDiagnostics(samples.length),
		empirical: resolved.strategy === 'empirical' ? empirical : undefined,
		physical,
		residual,
	}

	const diagnostics = buildPointingDiagnostics(samples.length, prepared, provisional, empiricalFeatureNames)
	return { ...provisional, diagnostics }
}

// Predicts the local systematic error for a requested coordinate and mount state.
export function predictPointingModelError(model: FittedPointingModel, input: Readonly<PointingModelInput>): PredictedPointingError {
	const context = extractPointingContext(input)
	const components = predictModelComponents(model, context)
	const dx = (components.physical?.dx ?? 0) + (components.empirical?.dx ?? 0) + (components.residual?.dx ?? 0)
	const dy = (components.physical?.dy ?? 0) + (components.empirical?.dy ?? 0) + (components.residual?.dy ?? 0)
	const quality = evaluatePredictionQuality(model, context)
	return { dx, dy, angularSeparation: Math.hypot(dx, dy), representationUsed: model.errorRepresentation, quality, components }
}

// Applies the predicted local correction to a requested coordinate.
export function correctPointingCoordinate(model: FittedPointingModel, input: Readonly<PointingModelInput>): CorrectionResult {
	const predictedError = predictPointingModelError(model, input)
	const [rightAscension, declination] = eraC2s(...sphericalUnprojectTangentPlane(-predictedError.dx, -predictedError.dy, eraS2c(input.rightAscension, input.declination)))
	return { rightAscension, declination, predictedError }
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
	correctCoordinate(input: Readonly<PointingModelInput>): CorrectionResult {
		return this.#fittedModel ? correctPointingCoordinate(this.#fittedModel, input) : { rightAscension: input.rightAscension, declination: input.declination, predictedError: unfittedPrediction(input) }
	}

	// Exports the fitted model into a serializable structure.
	export() {
		return this.#fittedModel ? structuredClone(this.#fittedModel) : undefined
	}

	// Imports a previously fitted pointing model.
	import(serialized: FittedPointingModel) {
		this.#fittedModel = structuredClone(serialized)
		this.#diagnostics = this.#fittedModel.diagnostics
		this.#dirty = false
		return this.#fittedModel
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

// Normalizes the optional pier-side input.
function normalizePierSide(pierSide?: PierSide) {
	return pierSide === 'EAST' || pierSide === 'WEST' ? pierSide : 'NEITHER'
}

// Checks whether the provided value is a finite angular value.
function isFiniteAngle(value: number | undefined) {
	return value !== undefined && Number.isFinite(value)
}

// Resolves the configured empirical feature flags.
export function resolveFeatureConfiguration(configuration: PointingFeatureConfiguration = {}): ResolvedPointingFeatureConfiguration {
	return {
		includeBias: configuration.includeBias ?? DEFAULT_FEATURE_CONFIGURATION.includeBias,
		includeHourAngleTerms: configuration.includeHourAngleTerms ?? DEFAULT_FEATURE_CONFIGURATION.includeHourAngleTerms,
		includeDeclinationTerms: configuration.includeDeclinationTerms ?? DEFAULT_FEATURE_CONFIGURATION.includeDeclinationTerms,
		includeAltitudeTerms: configuration.includeAltitudeTerms ?? DEFAULT_FEATURE_CONFIGURATION.includeAltitudeTerms,
		includeCrossTerms: configuration.includeCrossTerms ?? DEFAULT_FEATURE_CONFIGURATION.includeCrossTerms,
		includePierSideTerms: configuration.includePierSideTerms ?? DEFAULT_FEATURE_CONFIGURATION.includePierSideTerms,
		includePolynomialTerms: configuration.includePolynomialTerms ?? DEFAULT_FEATURE_CONFIGURATION.includePolynomialTerms,
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
		ridge: options.ridge ?? DEFAULT_RIDGE,
		featureConfiguration: resolveFeatureConfiguration(options.featureConfiguration),
		validation: resolveValidationOptions(options.validation),
		robust: resolveRobustConfiguration(options.robust),
	}
}

// Validates and prepares the sample set before fitting.
function preparePointingSamples(samples: readonly PointingSample[], options: ResolvedPointingFitOptions): PreparedPointingSamples {
	const accepted: PreparedPointingSample[] = []
	const rejected: RejectedPointingSample[] = []
	const warnings: string[] = []

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		const reason = validatePointingSample(sample, accepted, options)

		if (reason) {
			rejected.push({ sample, reason })
			continue
		}

		const error = computePointingError(sample.targetRightAscension, sample.targetDeclination, sample.solvedRightAscension, sample.solvedDeclination, options.errorRepresentation)
		const context = extractPointingContext({ rightAscension: sample.targetRightAscension, declination: sample.targetDeclination, time: sample.time, latitude: sample.latitude, longitude: sample.longitude, pierSide: sample.pierSide })
		accepted.push({ sample, context, error })
	}

	if (accepted.length < options.validation.minimumSamples) {
		warnings.push(`too few samples: ${accepted.length} valid sample(s) for a recommended minimum of ${options.validation.minimumSamples}`)
	}

	return { accepted, rejected, warnings }
}

// Validates one sample against the configured rules.
function validatePointingSample(sample: Readonly<PointingSample>, accepted: readonly PreparedPointingSample[], options: ResolvedPointingFitOptions) {
	if (!isFiniteCoordinate(sample.targetRightAscension, sample.targetDeclination) || !isFiniteCoordinate(sample.solvedRightAscension, sample.solvedDeclination)) {
		return 'invalid coordinate'
	}

	if (Math.abs(sample.targetDeclination) > PIOVERTWO || Math.abs(sample.solvedDeclination) > PIOVERTWO) {
		return 'declination outside valid range'
	}

	const error = computePointingError(sample.targetRightAscension, sample.targetDeclination, sample.solvedRightAscension, sample.solvedDeclination, options.errorRepresentation)

	if (!Number.isFinite(error.dx) || !Number.isFinite(error.dy)) {
		return 'unstable tangent-plane geometry'
	}

	if (error.angularSeparation > options.validation.maximumSampleSeparation) {
		return 'sample separation exceeds configured maximum'
	}

	const context = extractPointingContext({ rightAscension: sample.targetRightAscension, declination: sample.targetDeclination, time: sample.time, latitude: sample.latitude, longitude: sample.longitude, pierSide: sample.pierSide })

	if (context.altitude !== undefined && context.altitude < options.validation.minimumAltitude) {
		return 'altitude below configured minimum'
	}

	for (let i = 0; i < accepted.length; i++) {
		const previous = accepted[i]
		const samePierSide = normalizePierSide(previous.sample.pierSide) === normalizePierSide(sample.pierSide)
		const targetDistance = angularDistance(previous.sample.targetRightAscension, previous.sample.targetDeclination, sample.targetRightAscension, sample.targetDeclination)

		if (samePierSide && targetDistance <= options.validation.duplicateTolerance) {
			return 'duplicate or near-duplicate sample'
		}
	}

	return undefined
}

// Checks whether one RA/Dec pair is numerically valid.
function isFiniteCoordinate(ra: Angle, dec: Angle) {
	return Number.isFinite(ra) && Number.isFinite(dec)
}

// Fits the empirical dx/dy residual model.
function fitEmpiricalResidualModel(samples: readonly PreparedPointingSample[], options: ResolvedPointingFitOptions, physical: SemiPhysicalPointingModel | undefined): EmpiricalPointingModel {
	if (!physical) {
		return fitEmpiricalModel(samples, options, undefined)
	}

	const residualTargets = new Array<PointingOffset>(samples.length)

	for (let i = 0; i < samples.length; i++) {
		const predicted = predictSemiPhysicalOffset(physical.parameters, samples[i].context)
		residualTargets[i] = { dx: samples[i].error.dx - predicted.dx, dy: samples[i].error.dy - predicted.dy }
	}

	return fitEmpiricalModel(samples, options, residualTargets)
}

// Fits the empirical model with optional precomputed residual targets.
function fitEmpiricalModel(samples: readonly PreparedPointingSample[], options: ResolvedPointingFitOptions, targets: readonly PointingOffset[] | undefined): EmpiricalPointingModel {
	const names = buildEmpiricalPointingFeatureNames(options.featureConfiguration)
	const design = new Array<Readonly<Float64Array>>(samples.length)
	const dxTarget = new Float64Array(samples.length)
	const dyTarget = new Float64Array(samples.length)

	for (let i = 0; i < samples.length; i++) {
		const features = extractEmpiricalPointingFeatures(samples[i].context, options.featureConfiguration)
		design[i] = features.values
		dxTarget[i] = targets?.[i]?.dx ?? samples[i].error.dx
		dyTarget[i] = targets?.[i]?.dy ?? samples[i].error.dy
	}

	const dxFit = options.robust.method === 'none' ? linearLeastSquares(design, dxTarget, { ridge: options.ridge }) : robustLinearLeastSquares(design, dxTarget, { ridge: options.ridge, ...options.robust })
	const dyFit = options.robust.method === 'none' ? linearLeastSquares(design, dyTarget, { ridge: options.ridge }) : robustLinearLeastSquares(design, dyTarget, { ridge: options.ridge, ...options.robust })

	return {
		featureNames: names,
		coefficientsDx: dxFit.coefficients,
		coefficientsDy: dyFit.coefficients,
		conditionNumberDx: dxFit.conditionNumber,
		conditionNumberDy: dyFit.conditionNumber,
		rankDeficientDx: dxFit.rankDeficient,
		rankDeficientDy: dyFit.rankDeficient,
		ridge: options.ridge,
		robustMethod: options.robust.method,
	}
}

// Fits the shared-parameter semi-physical model.
function fitSemiPhysicalModel(samples: readonly PreparedPointingSample[], options: ResolvedPointingFitOptions): SemiPhysicalPointingModel {
	const parameterCount = SEMI_PHYSICAL_PARAMETER_NAMES.length
	const designRows = new Array<Readonly<Float64Array>>(samples.length * 2)
	const target = new Float64Array(samples.length * 2)
	let weights = new Float64Array(samples.length).fill(1)

	for (let i = 0; i < samples.length; i++) {
		const basis = semiPhysicalBasis(samples[i].context)
		designRows[i * 2] = basis.dx
		designRows[i * 2 + 1] = basis.dy
		target[i * 2] = samples[i].error.dx
		target[i * 2 + 1] = samples[i].error.dy
	}

	if (samples.length === 0) {
		return {
			parameterNames: SEMI_PHYSICAL_PARAMETER_NAMES,
			parameters: new Array<number>(parameterCount).fill(0),
			conditionNumber: Number.POSITIVE_INFINITY,
			rankDeficient: true,
			ridge: options.ridge,
			robustMethod: options.robust.method,
		}
	}

	let parameters = new Float64Array(parameterCount)
	let conditionNumber = Number.POSITIVE_INFINITY
	let rankDeficient = true

	for (let iteration = 0; iteration < Math.max(1, options.robust.maxIterations); iteration++) {
		const duplicatedWeights = duplicateSampleWeights(weights)
		const fit = linearLeastSquares(designRows, target, { ridge: options.ridge, weights: duplicatedWeights })
		parameters = new Float64Array(fit.coefficients)
		conditionNumber = fit.conditionNumber
		rankDeficient = fit.rankDeficient

		if (options.robust.method === 'none') {
			break
		}

		const residuals = new Float64Array(samples.length)

		for (let i = 0; i < samples.length; i++) {
			// Reuse the design rows built once above instead of recomputing the basis (trig + allocations) each iteration.
			const predicted = evaluateSemiPhysicalBasis(parameters, { dx: designRows[i * 2], dy: designRows[i * 2 + 1] })
			residuals[i] = Math.hypot(samples[i].error.dx - predicted.dx, samples[i].error.dy - predicted.dy)
		}

		const nextWeights = robustSampleWeights(residuals, options.robust)

		if (maxWeightDifference(weights, nextWeights) <= options.robust.tolerance) {
			weights = nextWeights
			break
		}

		weights = nextWeights
	}

	return {
		parameterNames: SEMI_PHYSICAL_PARAMETER_NAMES,
		parameters: Array.from(parameters),
		conditionNumber,
		rankDeficient,
		ridge: options.ridge,
		robustMethod: options.robust.method,
	}
}

// Predicts the semi-physical offset from the fitted shared parameters.
export function predictSemiPhysicalOffset(parameters: Readonly<NumberArray>, context: PointingContext): PointingOffset {
	return evaluateSemiPhysicalBasis(parameters, semiPhysicalBasis(context))
}

// Builds the semi-physical basis functions for one sky position and mount state.
function semiPhysicalBasis(context: PointingContext): Readonly<{ dx: Float64Array; dy: Float64Array }> {
	const dx = new Float64Array(SEMI_PHYSICAL_PARAMETER_NAMES.length)
	const dy = new Float64Array(SEMI_PHYSICAL_PARAMETER_NAMES.length)
	const sinDec = Math.sin(context.declination)
	const cosDec = Math.cos(context.declination)
	const hourAngle = context.hourAngle ?? 0
	const sinHa = context.hourAngle === undefined ? 0 : Math.sin(hourAngle)
	const cosHa = context.hourAngle === undefined ? 0 : Math.cos(hourAngle)
	const latitude = context.latitude
	const sinLat = latitude === undefined ? 0 : Math.sin(latitude)
	const cosLat = latitude === undefined ? 0 : Math.cos(latitude)
	const altitude = context.altitude

	dx[0] = 1
	dy[1] = 1
	dx[4] = sinDec
	dx[5] = cosHa * cosDec
	dy[5] = sinHa

	if (latitude !== undefined && context.hourAngle !== undefined) {
		// MA and ME reuse the small-angle polar-axis misalignment pattern in tangent coordinates.
		dx[2] = -sinLat * cosDec + cosLat * sinDec * cosHa
		dy[2] = cosLat * sinHa
		dx[3] = sinDec * sinHa
		dy[3] = -cosHa
	}

	if (altitude !== undefined) {
		dy[6] = -Math.cos(altitude)
	}

	return { dx, dy }
}

// Evaluates one semi-physical basis instance.
function evaluateSemiPhysicalBasis(parameters: Readonly<NumberArray>, basis: Readonly<{ dx: Readonly<NumberArray>; dy: Readonly<NumberArray> }>): PointingOffset {
	let dx = 0
	let dy = 0

	for (let i = 0; i < parameters.length; i++) {
		dx += parameters[i] * basis.dx[i]
		dy += parameters[i] * basis.dy[i]
	}

	return { dx, dy }
}

// Duplicates per-sample weights into the stacked dx/dy fit rows.
function duplicateSampleWeights(weights: Readonly<NumberArray>) {
	const duplicated = new Float64Array(weights.length * 2)

	for (let i = 0; i < weights.length; i++) {
		duplicated[i * 2] = weights[i]
		duplicated[i * 2 + 1] = weights[i]
	}

	return duplicated
}

// Builds robust sample weights from radial residuals.
function robustSampleWeights(residuals: Readonly<NumberArray>, robust: ResolvedPointingRobustFitConfiguration) {
	if (robust.method === 'none' || residuals.length === 0) {
		const weights = new Float64Array(residuals.length)
		weights.fill(1)
		return weights
	}

	const scale = robustResidualScale(residuals)
	const weights = new Float64Array(residuals.length)

	for (let i = 0; i < residuals.length; i++) {
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

// Computes a robust scale estimate for residual magnitudes.
function robustResidualScale(values: Readonly<NumberArray>) {
	if (values.length === 0) return 0

	const sorted = new Float64Array(values.length)

	for (let i = 0; i < values.length; i++) {
		sorted[i] = Math.abs(values[i])
	}

	const median = medianOf(sorted.sort())
	return median > 0 ? median * STANDARD_DEVIATION_SCALE : rmsOf(values)
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

// Predicts the empirical model offset from the fitted coefficients.
function predictEmpiricalOffset(model: EmpiricalPointingModel, input: Readonly<PointingModelInput>, configuration: ResolvedPointingFeatureConfiguration): PointingOffset {
	const features = extractEmpiricalPointingFeatures(input, configuration)
	return { dx: predictLinearLeastSquares(model.coefficientsDx, features.values), dy: predictLinearLeastSquares(model.coefficientsDy, features.values) }
}

// Predicts each model component individually for diagnostics and correction metadata.
function predictModelComponents(model: FittedPointingModel, context: PointingContext) {
	const input: Readonly<PointingModelInput> = { rightAscension: context.rightAscension, declination: context.declination, time: context.time, latitude: context.latitude, longitude: context.longitude, pierSide: context.pierSide }
	const physical = model.physical ? predictSemiPhysicalOffset(model.physical.parameters, context) : undefined
	const empirical = model.strategy === 'empirical' && model.empirical ? predictEmpiricalOffset(model.empirical, input, model.featureConfiguration) : undefined
	const residual = model.strategy === 'hybrid' && model.residual ? predictEmpiricalOffset(model.residual, input, model.featureConfiguration) : undefined
	return { physical, empirical, residual }
}

// Builds fit diagnostics from the fitted model and training samples.
function buildPointingDiagnostics(totalSamples: number, prepared: PreparedPointingSamples, model: FittedPointingModel, empiricalFeatureNames: readonly string[]): PointingDiagnostics {
	const residuals = new Float64Array(prepared.accepted.length)
	const residualsDx = new Float64Array(prepared.accepted.length)
	const residualsDy = new Float64Array(prepared.accepted.length)
	const warnings = [...prepared.warnings]
	const rejectedReasonCounts: Record<string, number> = {}
	const perPierSideSampleCounts = { EAST: 0, WEST: 0, NEITHER: 0 }

	for (let i = 0; i < prepared.rejected.length; i++) {
		const reason = prepared.rejected[i].reason
		rejectedReasonCounts[reason] = (rejectedReasonCounts[reason] ?? 0) + 1
	}

	for (let i = 0; i < prepared.accepted.length; i++) {
		const sample = prepared.accepted[i]
		const prediction = predictPointingModelError(model, sample.context)
		const dx = sample.error.dx - prediction.dx
		const dy = sample.error.dy - prediction.dy
		const radial = Math.hypot(dx, dy)

		residualsDx[i] = dx
		residualsDy[i] = dy
		residuals[i] = radial

		perPierSideSampleCounts[sample.context.pierSide]++
	}

	const skyCoverage = summarizePointingCoverage(prepared.accepted)
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

	if (prepared.accepted.length < Math.max(2, empiricalFeatureNames.length)) {
		warnings.push('the empirical feature matrix is underdetermined for the available samples')
	}

	residuals.sort()

	return {
		totalSamples,
		validSamples: prepared.accepted.length,
		rejectedSamples: prepared.rejected.length,
		rmsDx: rmsOf(residualsDx),
		rmsDy: rmsOf(residualsDy),
		angularRms: rmsOf(residuals),
		medianResidual: medianOf(residuals),
		residualPercentiles: {
			p50: percentileOf(residuals, 0.5),
			p90: percentileOf(residuals, 0.9),
			p95: percentileOf(residuals, 0.95),
		},
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

// Evaluates whether the prediction lies inside or outside the sampled sky region.
function evaluatePredictionQuality(model: FittedPointingModel, context: PointingContext): PointingPredictionQuality {
	const warnings: string[] = []
	const coverage = model.coverage
	let insideCoverage = true

	if (coverage.declinationRange) {
		insideCoverage &&= context.declination >= coverage.declinationRange[0] && context.declination <= coverage.declinationRange[1]
	}

	if (coverage.hourAngleRange && context.hourAngle !== undefined) {
		insideCoverage &&= context.hourAngle >= coverage.hourAngleRange[0] && context.hourAngle <= coverage.hourAngleRange[1]
	}

	if (coverage.altitudeRange && context.altitude !== undefined) {
		insideCoverage &&= context.altitude >= coverage.altitudeRange[0] && context.altitude <= coverage.altitudeRange[1]
	}

	const pierSideCovered = context.pierSide === 'NEITHER' || model.diagnostics.perPierSideSampleCounts[context.pierSide] > 0

	if (!insideCoverage) {
		warnings.push('prediction is outside the sampled sky region')
	}

	if (!pierSideCovered) {
		warnings.push('prediction uses a pier side that was not present during training')
	}

	return { insideCoverage, pierSideCovered, support: model.trainingSampleCount, warnings }
}

// Produces the unfitted-model fallback used before a fit has been computed.
function unfittedPrediction(input: Readonly<PointingModelInput>): PredictedPointingError {
	return {
		dx: 0,
		dy: 0,
		angularSeparation: 0,
		representationUsed: 'vectorTangent',
		quality: {
			insideCoverage: false,
			pierSideCovered: false,
			support: 0,
			warnings: ['model is not fitted'],
		},
		components: { physical: { dx: 0, dy: 0 }, empirical: { dx: 0, dy: 0 }, residual: { dx: 0, dy: 0 } },
	}
}

// Produces the default diagnostics object for the empty state.
function emptyDiagnostics(totalSamples: number): PointingDiagnostics {
	return {
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
