import { refractedAltitude, type RefractionParameters } from '../../astronomy/coordinates/astrometry'
import { enuToTakiMatrix, enuVectorToHorizontal, horizontalToEnuVector, takiToEnuMatrix } from '../../astronomy/coordinates/frame.local'
import { PI, PIOVERTWO, TAU } from '../../core/constants'
import { validateFinite, validateInRange } from '../../core/validation'
import { matMulVec } from '../../math/linear-algebra/mat3'
import { vecAngleUnit, vecMulScalar, vecNormalize, type Vec3 } from '../../math/linear-algebra/vec3'
import { linearLeastSquares, robustLinearLeastSquares, type LinearLeastSquaresResult } from '../../math/numerical/least.squares'
import { normalizeAngle, type Angle } from '../../math/units/angle'
import { decomposePolarErrorGeodesic } from './polaralignment.util'

// Challis/Taki declination-drift estimation of equatorial polar-axis misalignment. Hour angle is
// west-positive, all angles are radians, and the fitted small-angle components retain Taki's signs.

// One apparent mount-declination observation of a tracked star.
export interface ChallisObservation {
	// Stable identifier grouping observations that share one unknown declination intercept.
	readonly star: string | number
	// West-positive hour angle in radians; wrapping is allowed.
	readonly hourAngle: Angle
	// Apparent mount declination in radians.
	readonly mountDeclination: Angle
	// Known additive effect in mount declination, subtracted before fitting, in radians.
	readonly correction?: Angle
	// Optional non-negative relative observation weight; defaults to one.
	readonly weight?: number
}

// Numerical controls for the shared linear or robust regression.
export interface ChallisFitOptions {
	// Robust loss applied per observation; defaults to none.
	readonly robust?: 'none' | 'huber' | 'tukey'
	// Maximum IRLS iterations for robust fits.
	readonly maxIterations?: number
	// IRLS coefficient and weight convergence tolerance.
	readonly tolerance?: number
	// Positive robust loss tuning constant.
	readonly tuning?: number
}

// Fitted Taki small-angle polar-axis components and physical ENU diagnostics.
export interface ChallisPolarAlignmentResult {
	// Taki u component multiplying cos(H), in radians.
	readonly u: Angle
	// Taki v component multiplying -sin(H), in radians.
	readonly v: Angle
	// Small-angle misalignment magnitude hypot(u,v), in radians.
	readonly magnitude: Angle
	// Orientation atan2(u,v), normalized to 0..TAU radians.
	readonly orientation: Angle
	// North-oriented mathematical polar axis normalize([u,v,1]) in the Taki frame.
	readonly takiPole: Vec3
	// Physical above-horizon polar axis in ENU for the observer's hemisphere.
	readonly poleEnu: Vec3
	// Pole azimuth north through east in radians.
	readonly azimuth: Angle
	// Pole altitude above the horizon in radians.
	readonly altitude: Angle
	// Signed geodesic component along positive azimuth adjustment, in radians; undefined when the
	// local adjustment tangent is singular, including at a geographic pole.
	readonly azimuthError?: Angle
	// Signed geodesic component along positive altitude adjustment, in radians; undefined when the
	// local adjustment tangent is singular, including at a geographic pole.
	readonly altitudeError?: Angle
	// Great-circle separation from the physical celestial pole, in radians.
	readonly totalError: Angle
	// Estimated condition number of the weighted design matrix.
	readonly conditionNumber: number
	// Whether the solver diagnosed a rank-deficient design; successful fits require false.
	readonly rankDeficient: boolean
	// Target-minus-fitted declination residuals, in radians.
	readonly residuals: Readonly<Float64Array>
	// Final base times robust weight for every observation.
	readonly weights: Readonly<Float64Array>
	// Non-fatal coverage, leverage, conditioning, and approximation diagnostics.
	readonly warnings: readonly string[]
}

// Minimum reliable geometric altitude for the existing refraction model, in radians.
const MINIMUM_REFRACTION_ALTITUDE = -PI / 180

// Hour-angle separation below which observations count as the same effective instant.
const DISTINCT_HOUR_ANGLE_EPSILON = 1e-8

// Coverage below 30 degrees is reported as weak.
const MINIMUM_RECOMMENDED_COVERAGE = PI / 6

// Small-angle magnitudes above five degrees are reported as outside the intended approximation.
const SMALL_ANGLE_WARNING_LIMIT = (5 * PI) / 180

// Fits shared Taki u/v components and one independent declination intercept per star.
export function fitChallisPolarAlignment(observations: readonly Readonly<ChallisObservation>[], latitude: Angle, options: Readonly<ChallisFitOptions> = {}): ChallisPolarAlignmentResult {
	validateInRange(latitude, -PIOVERTWO, PIOVERTWO)
	validateFitOptions(options)
	if (observations.length === 0) throw new RangeError('at least three Challis observations are required')

	const starColumns = new Map<string | number, number>()
	for (const observation of observations) if (!starColumns.has(observation.star)) starColumns.set(observation.star, starColumns.size)
	const columnCount = starColumns.size + 2
	const design = new Array<Float64Array>(observations.length)
	const target = new Float64Array(observations.length)
	const baseWeights = new Float64Array(observations.length)
	let positiveWeightCount = 0

	for (let i = 0; i < observations.length; i++) {
		const observation = observations[i]
		validateFinite(observation.hourAngle)
		validateFinite(observation.mountDeclination)
		validateFinite(observation.correction ?? 0)
		const weight = observation.weight ?? 1
		validateFinite(weight)
		if (weight < 0) throw new RangeError(`observations[${i}].weight must be non-negative`)
		if (weight > 0) positiveWeightCount++
		const row = new Float64Array(columnCount)
		row[starColumns.get(observation.star)!] = 1
		row[columnCount - 2] = Math.cos(observation.hourAngle)
		row[columnCount - 1] = -Math.sin(observation.hourAngle)
		design[i] = row
		target[i] = observation.mountDeclination - (observation.correction ?? 0)
		baseWeights[i] = weight
	}

	if (positiveWeightCount < columnCount) throw new RangeError(`at least ${columnCount} positive-weight observations are required`)

	const robust = options.robust ?? 'none'
	let fit: LinearLeastSquaresResult
	let weights: Float64Array

	if (robust === 'none') {
		fit = linearLeastSquares(design, target, { weights: baseWeights })
		weights = Float64Array.from(baseWeights)
	} else {
		const robustFit = robustLinearLeastSquares(design, target, { weights: baseWeights, method: robust, maxIterations: options.maxIterations, tolerance: options.tolerance, tuning: options.tuning })
		fit = robustFit
		weights = Float64Array.from(robustFit.weights)
	}

	if (fit.rankDeficient || !Number.isFinite(fit.conditionNumber)) throw new RangeError('Challis design matrix is rank deficient')
	const u = fit.coefficients[columnCount - 2]
	const v = fit.coefficients[columnCount - 1]
	if (!Number.isFinite(u) || !Number.isFinite(v)) throw new RangeError('Challis fit produced non-finite polar components')

	const magnitude = Math.hypot(u, v)
	const orientation = normalizeAngle(Math.atan2(u, v))
	const takiPole = vecNormalize([u, v, 1])
	const hemisphere = latitude >= 0 ? 1 : -1
	const poleEnu = matMulVec(takiToEnuMatrix(latitude), vecMulScalar(takiPole, hemisphere))
	const targetEnu = matMulVec(takiToEnuMatrix(latitude), [0, 0, hemisphere])
	const horizontal = enuVectorToHorizontal(poleEnu)
	const error = decomposePolarErrorGeodesic(poleEnu, targetEnu, [0, 0, 1], [1, 0, 0])
	const totalError = vecAngleUnit(targetEnu, poleEnu)

	const residuals = Float64Array.from(fit.residuals)
	const warnings = [...challisWarnings(observations, weights, fit, magnitude)]
	if (!error) warnings.push('polar error adjustment components are undefined at this latitude')

	return {
		u,
		v,
		magnitude,
		orientation,
		takiPole,
		poleEnu,
		azimuth: horizontal.azimuth,
		altitude: horizontal.altitude,
		azimuthError: error?.azimuth,
		altitudeError: error?.altitude,
		totalError,
		conditionNumber: fit.conditionNumber,
		rankDeficient: fit.rankDeficient,
		residuals,
		weights,
		warnings,
	}
}

// Computes the apparent declination increment caused by the existing atmospheric refraction model.
// Directions below -1 degree geometric altitude are rejected because the model is unreliable there.
export function challisRefractionCorrection(hourAngle: Angle, declination: Angle, latitude: Angle, refraction?: Readonly<RefractionParameters>): Angle {
	validateFinite(hourAngle)
	validateInRange(declination, -PIOVERTWO, PIOVERTWO)
	validateInRange(latitude, -PIOVERTWO, PIOVERTWO)
	const cosDeclination = Math.cos(declination)
	const taki = [cosDeclination * Math.cos(hourAngle), -cosDeclination * Math.sin(hourAngle), Math.sin(declination)] as const
	const horizontal = enuVectorToHorizontal(matMulVec(takiToEnuMatrix(latitude), taki))
	if (horizontal.altitude < MINIMUM_REFRACTION_ALTITUDE) throw new RangeError('refraction correction is unreliable below -1 degree altitude')
	const apparentAltitude = refractedAltitude(horizontal.altitude, refraction)
	const apparentEnu = horizontalToEnuVector(horizontal.azimuth, apparentAltitude)
	const apparentTaki = matMulVec(enuToTakiMatrix(latitude), apparentEnu)
	const apparentDeclination = Math.atan2(apparentTaki[2], Math.hypot(apparentTaki[0], apparentTaki[1]))
	return apparentDeclination - declination
}

// Validates finite robust controls before delegating to the shared least-squares implementation.
function validateFitOptions(options: Readonly<ChallisFitOptions>): void {
	const robust = options.robust ?? 'none'
	if (robust !== 'none' && robust !== 'huber' && robust !== 'tukey') throw new RangeError('robust method is invalid')
	if (options.maxIterations !== undefined && (!Number.isInteger(options.maxIterations) || options.maxIterations <= 0)) throw new RangeError('maxIterations must be a positive integer')
	if (options.tolerance !== undefined) {
		validateFinite(options.tolerance)
		if (options.tolerance < 0) throw new RangeError('tolerance must be non-negative')
	}
	if (options.tuning !== undefined) {
		validateFinite(options.tuning)
		if (options.tuning <= 0) throw new RangeError('tuning must be positive')
	}
}

function effectiveAngleComparator(a: number, b: number) {
	return a - b
}

// Produces non-fatal diagnostics from hour-angle coverage, final weights, conditioning, and scale.
function challisWarnings(observations: readonly Readonly<ChallisObservation>[], weights: Readonly<Float64Array>, fit: Readonly<LinearLeastSquaresResult>, magnitude: Angle): readonly string[] {
	const warnings: string[] = []
	const effectiveAngles: number[] = []
	let weightSum = 0
	let maximumWeight = 0

	for (let i = 0; i < observations.length; i++) {
		if (weights[i] <= 0) continue
		effectiveAngles.push(normalizeAngle(observations[i].hourAngle))
		weightSum += weights[i]
		maximumWeight = Math.max(maximumWeight, weights[i])
	}

	effectiveAngles.sort(effectiveAngleComparator)

	let distinctCount = effectiveAngles.length > 0 ? 1 : 0
	for (let i = 1; i < effectiveAngles.length; i++) if (effectiveAngles[i] - effectiveAngles[i - 1] > DISTINCT_HOUR_ANGLE_EPSILON) distinctCount++
	if (distinctCount > 1 && effectiveAngles[0] + TAU - effectiveAngles.at(-1)! <= DISTINCT_HOUR_ANGLE_EPSILON) distinctCount--
	if (distinctCount < 3) warnings.push('fewer than three effectively distinct hour angles')
	if (hourAngleCoverage(effectiveAngles) < MINIMUM_RECOMMENDED_COVERAGE) warnings.push('hour-angle coverage is small or concentrated')
	if (fit.conditionNumber > 1e8) warnings.push('Challis design matrix is ill-conditioned')
	if (weightSum > 0 && maximumWeight / weightSum > 0.5) warnings.push('fit depends excessively on one observation')
	if (magnitude > SMALL_ANGLE_WARNING_LIMIT) warnings.push('polar error exceeds the recommended small-angle range')
	return warnings
}

// Computes the shortest circular arc containing all sorted normalized hour angles.
function hourAngleCoverage(sortedAngles: readonly number[]): Angle {
	if (sortedAngles.length < 2) return 0
	let largestGap = sortedAngles[0] + TAU - sortedAngles.at(-1)!
	for (let i = 1; i < sortedAngles.length; i++) largestGap = Math.max(largestGap, sortedAngles[i] - sortedAngles[i - 1])
	return TAU - largestGap
}
