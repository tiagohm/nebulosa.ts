import { horizontalToEnuVector } from '../../astronomy/coordinates/frame.local'
import { medianOf } from '../../core/util'
import { validateFinite, validateVector } from '../../core/validation'
import { matFill, matMul, matMulVec, matRodriguesRotation, matTranspose, type Mat3 } from '../../math/linear-algebra/mat3'
import { rigidIdentity } from '../../math/linear-algebra/rigid3'
import { type MutVec3, vecCross, vecCrossLength, vecDot, vecLength, vecNormalize, type Vec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { mountDirectionFromEncoders, type MountEncoderPosition, type TwoAxisMountGeometry } from './kinematics'

// Direction-only calibration of a mount base frame against a world frame. Rotations remain on
// SO(3) through active left-multiplicative Rodrigues updates; angular residuals are radians.

// One corresponding non-zero direction pair used to estimate a mount-to-world rotation.
export interface DirectionAlignmentSample {
	// Direction expressed in the mount base frame; magnitude is ignored.
	readonly mount: Vec3
	// Corresponding direction expressed in the world frame; magnitude is ignored.
	readonly world: Vec3
	// Optional non-negative relative sample weight; defaults to one.
	readonly weight?: number
}

// Numerical and robust controls for direction alignment.
export interface DirectionAlignmentOptions {
	// Maximum left-increment refinement iterations; defaults to 24.
	readonly maxIterations?: number
	// Rotation-increment convergence threshold in radians; defaults to 1e-12.
	readonly tolerance?: Angle
	// Sample-level robust weighting method; defaults to none.
	readonly robust?: 'none' | 'huber' | 'tukey'
	// Positive normalized-residual cutoff; defaults to 1.345 for Huber and 4.685 for Tukey.
	readonly tuning?: number
}

// Fitted proper rotation and angular diagnostics for all input samples.
export interface DirectionAlignmentResult {
	// Active proper rotation mapping mount directions into the world frame.
	readonly mountToWorld: Mat3
	// Exact transpose mapping world directions back into the mount frame.
	readonly worldToMount: Mat3
	// Final angular residual of every sample, in radians.
	readonly residuals: Readonly<Float64Array>
	// Final base times robust sample weights.
	readonly weights: Readonly<Float64Array>
	// Final weighted root-mean-square angular residual, in radians.
	readonly rms: Angle
	// Maximum angular residual across every sample, including downweighted outliers.
	readonly maximumResidual: Angle
	// Estimated condition number of the final tangent design matrix.
	readonly conditionNumber: number
	// Number of attempted refinement iterations; zero for an exact two-sample TRIAD fit.
	readonly iterations: number
	// Whether the final update met the requested tolerance or no refinement was needed.
	readonly converged: boolean
	// Total number of supplied samples.
	readonly sampleCount: number
	// Number of samples whose final robust weight is exactly zero.
	readonly rejectedCount: number
	// Non-fatal conditioning and convergence diagnostics.
	readonly warnings: readonly string[]
}

// One mount encoder observation paired with an already reduced ENU horizontal direction.
export interface MountAlignmentObservation {
	// Encoder position selecting the physical mount pose.
	readonly encoders: MountEncoderPosition
	// Observed azimuth north through east, in radians.
	readonly azimuth: Angle
	// Observed altitude above the horizon, in radians.
	readonly altitude: Angle
	// Optional non-negative relative observation weight; defaults to one.
	readonly weight?: number
}

// Default nonlinear-refinement iteration cap.
const DEFAULT_MAX_ITERATIONS = 24

// Default rotation-increment convergence threshold in radians.
const DEFAULT_TOLERANCE = 1e-12

// Default Huber normalized-residual cutoff.
const DEFAULT_HUBER_TUNING = 1.345

// Default Tukey normalized-residual cutoff.
const DEFAULT_TUKEY_TUNING = 4.685

// Minimum sine of separation accepted for both TRIAD bases.
const TRIAD_MINIMUM_CROSS = 1e-10

// Relative singularity threshold for the three-parameter tangent normal matrix.
const NORMAL_RELATIVE_EPSILON = 128 * Number.EPSILON

// Maximum number of objective backtracking halvings.
const MAX_BACKTRACKING_STEPS = 16

// Normal consistency factor converting median absolute residual to Gaussian sigma.
const ROBUST_MAD_SCALE = 0.6744897501960817

// Fits one proper rotation from at least two effective direction correspondences.
export function fitDirectionAlignment(samples: readonly Readonly<DirectionAlignmentSample>[], options: Readonly<DirectionAlignmentOptions> = {}): DirectionAlignmentResult {
	const controls = alignmentControls(options)
	const normalized = normalizeSamples(samples)
	let rotation = triadInitialRotation(normalized.mount, normalized.world, normalized.baseWeights)
	let residuals = alignmentResiduals(rotation, normalized.mount, normalized.world)
	let weights = finalWeights(residuals, normalized.baseWeights, controls)
	let iterations = 0
	let converged = residuals.every((residual) => residual <= controls.tolerance)

	if (!converged) {
		for (let iteration = 0; iteration < controls.maxIterations; iteration++) {
			iterations = iteration + 1
			weights = finalWeights(residuals, normalized.baseWeights, controls)
			ensureEffectiveWeights(weights)
			const normal = tangentNormal(rotation, normalized.mount, normalized.world, weights)
			const delta = solveSymmetricNormal(normal.matrix, normal.rhs)
			if (!delta) break

			const deltaLength = vecLength(delta)
			if (deltaLength <= controls.tolerance) {
				converged = true
				break
			}

			const objective = weightedObjective(residuals, weights)
			let accepted = false

			for (let backtracking = 0; backtracking <= MAX_BACKTRACKING_STEPS; backtracking++) {
				const factor = 2 ** -backtracking
				const candidate = matMul(matRodriguesRotation(delta, deltaLength * factor), rotation)
				const candidateResiduals = alignmentResiduals(candidate, normalized.mount, normalized.world)

				if (weightedObjective(candidateResiduals, weights) < objective) {
					rotation = candidate
					residuals = candidateResiduals
					accepted = true
					if (deltaLength * factor <= controls.tolerance) converged = true
					break
				}
			}

			if (!accepted || converged) break
		}
	}

	residuals = alignmentResiduals(rotation, normalized.mount, normalized.world)
	weights = finalWeights(residuals, normalized.baseWeights, controls)
	ensureEffectiveWeights(weights)
	const finalNormal = tangentNormal(rotation, normalized.mount, normalized.world, weights).matrix
	const conditionNumber = tangentConditionNumber(finalNormal)
	const diagnostics = residualDiagnostics(residuals, weights)
	const warnings: string[] = []
	if (!Number.isFinite(conditionNumber) || conditionNumber > 1e8) warnings.push('alignment geometry is ill-conditioned')
	if (!converged) warnings.push('alignment refinement did not converge')
	const rejectedCount = countRejected(weights)
	if (rejectedCount > 0) warnings.push(`${rejectedCount} sample(s) received zero final weight`)

	return {
		mountToWorld: rotation,
		worldToMount: matTranspose(rotation),
		residuals,
		weights,
		rms: diagnostics.rms,
		maximumResidual: diagnostics.maximum,
		conditionNumber,
		iterations,
		converged,
		sampleCount: samples.length,
		rejectedCount,
		warnings,
	}
}

// Rotates and normalizes a non-zero mount-frame direction into the fitted world frame.
export function predictWorldDirection(alignment: Readonly<DirectionAlignmentResult>, mountDirection: Vec3, out?: MutVec3): MutVec3 {
	validateDirection(mountDirection, 'mountDirection')
	return vecNormalize(matMulVec(alignment.mountToWorld, mountDirection, out), out)
}

// Rotates and normalizes a non-zero world-frame direction into the fitted mount frame.
export function predictMountDirection(alignment: Readonly<DirectionAlignmentResult>, worldDirection: Vec3, out?: MutVec3): MutVec3 {
	validateDirection(worldDirection, 'worldDirection')
	return vecNormalize(matMulVec(alignment.worldToMount, worldDirection, out), out)
}

// Materializes the fitted rotation as the geometry's sole base-to-world orientation while
// preserving its existing translation in metres.
export function applyDirectionAlignment(geometry: Readonly<TwoAxisMountGeometry>, alignment: Readonly<DirectionAlignmentResult>): TwoAxisMountGeometry {
	return { ...geometry, baseToWorld: { rotation: alignment.mountToWorld, translation: geometry.baseToWorld.translation } }
}

// Fits mount-base to ENU orientation from encoder positions and observed horizontal coordinates.
// Astrometric place conversion and refraction must already be reflected in azimuth and altitude.
export function fitMountAlignment(geometry: Readonly<TwoAxisMountGeometry>, observations: readonly Readonly<MountAlignmentObservation>[], options: Readonly<DirectionAlignmentOptions> = {}): DirectionAlignmentResult {
	const baseGeometry: TwoAxisMountGeometry = { ...geometry, baseToWorld: rigidIdentity() }
	const samples = new Array<DirectionAlignmentSample>(observations.length)

	for (let i = 0; i < observations.length; i++) {
		const observation = observations[i]
		samples[i] = {
			mount: mountDirectionFromEncoders(baseGeometry, observation.encoders),
			world: horizontalToEnuVector(observation.azimuth, observation.altitude),
			weight: observation.weight,
		}
	}

	return fitDirectionAlignment(samples, options)
}

// Validated numerical controls used during alignment.
interface AlignmentControls {
	// Positive nonlinear iteration cap.
	readonly maxIterations: number
	// Non-negative update threshold in radians.
	readonly tolerance: Angle
	// Selected sample-level robust method.
	readonly robust: 'none' | 'huber' | 'tukey'
	// Positive robust cutoff in normalized residual units.
	readonly tuning: number
}

// Normalized direction arrays and immutable base weights.
interface NormalizedAlignmentSamples {
	// Unit mount directions.
	readonly mount: readonly Vec3[]
	// Unit world directions.
	readonly world: readonly Vec3[]
	// Non-negative user weights.
	readonly baseWeights: Readonly<Float64Array>
}

// Compact symmetric normal matrix and right-hand side for one tangent update.
interface TangentNormalSystem {
	// Upper-triangular entries [a00,a01,a02,a11,a12,a22].
	readonly matrix: Readonly<Float64Array>
	// Three-component tangent right-hand side.
	readonly rhs: Vec3
}

// Weighted angular residual summary.
interface AlignmentResidualDiagnostics {
	// Weighted angular RMS in radians.
	readonly rms: Angle
	// Maximum angular residual in radians.
	readonly maximum: Angle
}

// Validates and resolves alignment options.
function alignmentControls(options: Readonly<DirectionAlignmentOptions>): AlignmentControls {
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE
	const robust = options.robust ?? 'none'
	const tuning = options.tuning ?? (robust === 'tukey' ? DEFAULT_TUKEY_TUNING : DEFAULT_HUBER_TUNING)
	if (!Number.isInteger(maxIterations) || maxIterations <= 0) throw new RangeError('maxIterations must be a positive integer')
	validateFinite(tolerance)
	validateFinite(tuning)
	if (tolerance < 0) throw new RangeError('tolerance must be non-negative')
	if (tuning <= 0) throw new RangeError('tuning must be positive')
	if (robust !== 'none' && robust !== 'huber' && robust !== 'tukey') throw new RangeError('robust method is invalid')
	return { maxIterations, tolerance, robust, tuning }
}

// Normalizes and validates all direction pairs and base weights.
function normalizeSamples(samples: readonly Readonly<DirectionAlignmentSample>[]): NormalizedAlignmentSamples {
	if (samples.length < 2) throw new RangeError('at least two alignment samples are required')
	const mount = new Array<Vec3>(samples.length)
	const world = new Array<Vec3>(samples.length)
	const baseWeights = new Float64Array(samples.length)
	let effectiveCount = 0

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		validateDirection(sample.mount, `samples[${i}].mount`)
		validateDirection(sample.world, `samples[${i}].world`)
		const weight = sample.weight ?? 1
		validateFinite(weight)
		if (weight < 0) throw new RangeError(`samples[${i}].weight must be non-negative`)
		mount[i] = vecNormalize(sample.mount)
		world[i] = vecNormalize(sample.world)
		baseWeights[i] = weight
		if (weight > 0) effectiveCount++
	}

	if (effectiveCount < 2) throw new RangeError('at least two positive-weight samples are required')

	return { mount, world, baseWeights }
}

// Validates one finite non-zero direction.
function validateDirection(direction: Vec3, name: string): void {
	validateVector(direction)
	if (vecLength(direction) === 0) throw new RangeError(`${name} must be non-zero`)
}

// Selects the positive-weight pair with the strongest joint cross-product conditioning and builds
// the active rotation that maps its mount TRIAD basis into its world TRIAD basis.
function triadInitialRotation(mount: readonly Vec3[], world: readonly Vec3[], weights: Readonly<Float64Array>): Mat3 {
	let first = -1
	let second = -1
	let bestScore = 0

	for (let i = 0; i < mount.length - 1; i++) {
		if (weights[i] <= 0) continue

		for (let j = i + 1; j < mount.length; j++) {
			if (weights[j] <= 0) continue

			const score = Math.min(vecCrossLength(mount[i], mount[j]), vecCrossLength(world[i], world[j]))

			if (score > bestScore) {
				bestScore = score
				first = i
				second = j
			}
		}
	}

	if (first < 0 || second < 0 || bestScore < TRIAD_MINIMUM_CROSS) throw new RangeError('alignment directions are collinear or antipodal')

	const mountBasis = triadBasis(mount[first], mount[second])
	const worldBasis = triadBasis(world[first], world[second])
	return matMul(worldBasis, matTranspose(mountBasis))
}

// Builds a right-handed matrix whose columns are the TRIAD basis vectors.
function triadBasis(first: Vec3, second: Vec3): Mat3 {
	const e1 = vecNormalize(first)
	const e2 = vecNormalize(vecCross(first, second))
	const e3 = vecCross(e1, e2)
	return matFill([0, 0, 0, 0, 0, 0, 0, 0, 0], e1[0], e2[0], e3[0], e1[1], e2[1], e3[1], e1[2], e2[2], e3[2])
}

// Computes true angular residuals for one rotation.
function alignmentResiduals(rotation: Mat3, mount: readonly Vec3[], world: readonly Vec3[]): Float64Array {
	const residuals = new Float64Array(mount.length)
	const predicted: MutVec3 = [0, 0, 0]

	for (let i = 0; i < mount.length; i++) {
		matMulVec(rotation, mount[i], predicted)
		residuals[i] = Math.atan2(vecCrossLength(predicted, world[i]), Math.max(-1, Math.min(1, vecDot(predicted, world[i]))))
	}

	return residuals
}

// Combines user and sample-level IRLS weights from angular residuals.
function finalWeights(residuals: Readonly<Float64Array>, baseWeights: Readonly<Float64Array>, controls: Readonly<AlignmentControls>): Float64Array {
	const weights = new Float64Array(residuals.length)
	if (controls.robust === 'none') {
		weights.set(baseWeights)
		return weights
	}

	const scale = Math.max(alignmentRobustScale(residuals), controls.tolerance, 1e-12)

	for (let i = 0; i < residuals.length; i++) {
		const normalized = residuals[i] / (scale * controls.tuning)

		let robustWeight: number
		if (controls.robust === 'huber') robustWeight = normalized <= 1 ? 1 : 1 / normalized
		else if (normalized >= 1) robustWeight = 0
		else {
			const t = 1 - normalized * normalized
			robustWeight = t * t
		}

		weights[i] = baseWeights[i] * robustWeight
	}

	return weights
}

// Estimates angular residual scale with median absolute deviation and an RMS fallback.
function alignmentRobustScale(residuals: Readonly<Float64Array>): number {
	const absolute = new Float64Array(residuals.length)
	let sumSquares = 0

	for (let i = 0; i < residuals.length; i++) {
		absolute[i] = Math.abs(residuals[i])
		sumSquares += residuals[i] * residuals[i]
	}

	const scale = medianOf(absolute.sort()) / ROBUST_MAD_SCALE
	return scale > 0 ? scale : Math.sqrt(sumSquares / residuals.length)
}

// Ensures robust weighting retains enough correspondences to determine a rotation.
function ensureEffectiveWeights(weights: Readonly<Float64Array>): void {
	let count = 0
	for (let i = 0; i < weights.length; i++) if (weights[i] > 0) count++
	if (count < 2) throw new RangeError('robust weighting left fewer than two effective samples')
}

// Builds the three-parameter tangent normal system. Each sample contributes the two-dimensional
// tangent projector I-pp^T and right-hand side p×world for predicted direction p.
function tangentNormal(rotation: Mat3, mount: readonly Vec3[], world: readonly Vec3[], weights: Readonly<Float64Array>): TangentNormalSystem {
	const matrix = new Float64Array(6)
	const rhs: MutVec3 = [0, 0, 0]
	const predicted: MutVec3 = [0, 0, 0]
	const cross: MutVec3 = [0, 0, 0]

	for (let i = 0; i < mount.length; i++) {
		const weight = weights[i]

		if (weight <= 0) continue

		matMulVec(rotation, mount[i], predicted)
		const x = predicted[0]
		const y = predicted[1]
		const z = predicted[2]
		matrix[0] += weight * (1 - x * x)
		matrix[1] -= weight * x * y
		matrix[2] -= weight * x * z
		matrix[3] += weight * (1 - y * y)
		matrix[4] -= weight * y * z
		matrix[5] += weight * (1 - z * z)
		vecCross(predicted, world[i], cross)
		rhs[0] += weight * cross[0]
		rhs[1] += weight * cross[1]
		rhs[2] += weight * cross[2]
	}

	return { matrix, rhs }
}

// Solves one symmetric 3x3 tangent normal system, or returns undefined when relatively singular.
function solveSymmetricNormal(matrix: Readonly<Float64Array>, rhs: Vec3): Vec3 | undefined {
	const [a, b, c, d, e, f] = matrix
	const c00 = d * f - e * e
	const c01 = c * e - b * f
	const c02 = b * e - c * d
	const c11 = a * f - c * c
	const c12 = b * c - a * e
	const c22 = a * d - b * b
	const determinant = a * c00 + b * c01 + c * c02
	const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d), Math.abs(e), Math.abs(f))
	if (!(scale > 0) || determinant <= NORMAL_RELATIVE_EPSILON * scale * scale * scale) return undefined
	return [(c00 * rhs[0] + c01 * rhs[1] + c02 * rhs[2]) / determinant, (c01 * rhs[0] + c11 * rhs[1] + c12 * rhs[2]) / determinant, (c02 * rhs[0] + c12 * rhs[1] + c22 * rhs[2]) / determinant]
}

// Estimates the tangent design condition number from the normal matrix one-norm and its inverse.
function tangentConditionNumber(matrix: Readonly<Float64Array>): number {
	const [a, b, c, d, e, f] = matrix
	const c00 = d * f - e * e
	const c01 = c * e - b * f
	const c02 = b * e - c * d
	const c11 = a * f - c * c
	const c12 = b * c - a * e
	const c22 = a * d - b * b
	const determinant = a * c00 + b * c01 + c * c02
	if (!(determinant > 0)) return Number.POSITIVE_INFINITY
	const norm = Math.max(Math.abs(a) + Math.abs(b) + Math.abs(c), Math.abs(b) + Math.abs(d) + Math.abs(e), Math.abs(c) + Math.abs(e) + Math.abs(f))
	const inverseNorm = Math.max(Math.abs(c00) + Math.abs(c01) + Math.abs(c02), Math.abs(c01) + Math.abs(c11) + Math.abs(c12), Math.abs(c02) + Math.abs(c12) + Math.abs(c22)) / determinant
	return Math.sqrt(norm * inverseNorm)
}

// Computes a fixed-weight angular least-squares objective.
function weightedObjective(residuals: Readonly<Float64Array>, weights: Readonly<Float64Array>): number {
	let objective = 0
	for (let i = 0; i < residuals.length; i++) objective += weights[i] * residuals[i] * residuals[i]
	return objective
}

// Computes final RMS and maximum angular residuals.
function residualDiagnostics(residuals: Readonly<Float64Array>, weights: Readonly<Float64Array>): AlignmentResidualDiagnostics {
	let weightedSquares = 0
	let weightSum = 0
	let maximum = 0

	for (let i = 0; i < residuals.length; i++) {
		weightedSquares += weights[i] * residuals[i] * residuals[i]
		weightSum += weights[i]
		maximum = Math.max(maximum, residuals[i])
	}

	return { rms: Math.sqrt(weightedSquares / weightSum), maximum }
}

// Counts final samples rejected exactly by redescending robust weights.
function countRejected(weights: Readonly<Float64Array>): number {
	let count = 0
	for (let i = 0; i < weights.length; i++) if (weights[i] === 0) count++
	return count
}
