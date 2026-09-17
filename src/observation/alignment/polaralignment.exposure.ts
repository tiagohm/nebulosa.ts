import { pixelScale } from '../../astronomy/formulas'
import type { GeographicPosition } from '../../astronomy/observer/location'
import type { Time } from '../../astronomy/time/time'
import { PI, PIOVERTWO, SIDEREAL_DAYSEC, SIDEREAL_DRIFT_RATE } from '../../core/constants'
import { type MutVec3, type Vec3, vecAngleUnit, vecDot, vecLength, vecNegateMut } from '../../math/linear-algebra/vec3'
import { type Angle, arcsec } from '../../math/units/angle'
import type { ThreePointPolarAlignmentResult } from './polaralignment'
import { celestialPoleVector, transportEarthFixed } from './polaralignment.util'

// Exposure limits imposed exclusively by polar-axis misalignment. All directions share the inertial
// frame used by plate solutions, angular quantities are radians, rates are radians per SI second,
// and exposure times are SI seconds. Public vector results are freshly allocated; inputs are never
// mutated. Time-dependent estimates integrate scalar rates without allocating vectors per sample.

// Default maximum stellar displacement accepted by the exposure estimator, in pixels.
export const DEFAULT_POLAR_ALIGNMENT_MAX_TRAIL = 0.5

// Smallest vector length or polar separation retained as meaningful numerical geometry.
const VECTOR_EPSILON = 1e-14

// Minimum squared sine of the angle between the guide direction and mechanical RA axis.
const GUIDING_SINGULARITY_EPSILON = 1e-12

// Absolute root-finding tolerance in seconds; long roots additionally use a relative tolerance.
const ROOT_TIME_TOLERANCE = 0.05

// Initial even segment count for composite Simpson integration.
const INITIAL_INTEGRATION_SEGMENTS = 8

// Maximum even segment count used when composite Simpson refinement does not converge earlier.
const MAX_INTEGRATION_SEGMENTS = 1024

// Perfect-guiding geometry for a guide star and the most distant relevant science-field point.
export interface PolarAlignmentGuidedExposureInput {
	// Unit ICRF direction of the guide star; non-unit finite vectors are normalized internally.
	readonly guide: Vec3
	// Largest angular separation from the guide star to a relevant science-field point, in [0, PI].
	readonly fieldRadius: Angle
}

// Geometry and image sampling used to estimate polar-alignment-limited exposures.
export interface PolarAlignmentExposureInput {
	// Mechanical RA-axis direction in the same inertial frame as celestialPole and target.
	readonly mountPole: Vec3
	// True celestial-pole direction in the same inertial frame as mountPole and target.
	readonly celestialPole: Vec3
	// Image scale in radians per pixel; a plate-solved scale is preferred.
	readonly imageScale: Angle
	// Allowed stellar displacement in pixels; defaults to DEFAULT_POLAR_ALIGNMENT_MAX_TRAIL.
	readonly maxTrail?: number
	// Optional current science-target direction in the common inertial frame.
	readonly target?: Vec3
	// Optional ideal RA+DEC guiding geometry.
	readonly guiding?: PolarAlignmentGuidedExposureInput
	// Maximum interval searched, in seconds; defaults to one sidereal day.
	readonly searchLimit?: number
}

// Unguided instantaneous rates and conservative exposure limits.
export interface PolarAlignmentUnguidedExposureLimit {
	// Maximum angular drift rate possible for this polar error, in radians per second.
	readonly worstCaseRate: Angle
	// Conservative global exposure limit in seconds, or Infinity when not reached within searchLimit.
	readonly worstCase: number
	// Initial target-specific drift rate in radians per second, when a target was supplied.
	readonly targetRate?: Angle
	// Time-dependent target-specific limit in seconds, when a target was supplied.
	readonly target?: number
}

// Guided field-rotation rate, field extent, and exposure limit.
export interface PolarAlignmentGuidedExposureLimit {
	// Signed instantaneous field rotation rate at the guide star, in radians per second; undefined
	// when the RA/DEC guiding geometry is singular.
	readonly rotationRate?: Angle
	// Largest guide-to-field separation protected by the limit, in radians.
	readonly fieldRadius: Angle
	// Time-dependent field-rotation limit in seconds; absent only for singular RA/DEC geometry.
	readonly exposure?: number
	// Whether the guide direction is too close to the mechanical RA axis for RA+DEC kinematics.
	readonly singular: boolean
}

// Complete polar-alignment exposure estimate for unguided and optional guided capture.
export interface PolarAlignmentExposureLimit {
	// Great-circle separation of the mechanical and celestial poles, in radians.
	readonly polarError: Angle
	// Image scale used by the estimate, in radians per pixel.
	readonly imageScale: Angle
	// Allowed stellar displacement used by the estimate, in pixels.
	readonly maxTrail: number
	// Unguided rates and limits.
	readonly unguided: PolarAlignmentUnguidedExposureLimit
	// Guided field-rotation estimate, when guiding geometry was supplied.
	readonly guided?: PolarAlignmentGuidedExposureLimit
}

// Convenience input that obtains both poles from an existing three-point alignment result.
export interface PolarAlignmentResultExposureInput extends Omit<PolarAlignmentExposureInput, 'mountPole' | 'celestialPole'> {
	// Mechanical pole and exposure epoch produced by three-point polar alignment.
	readonly alignment: Pick<ThreePointPolarAlignmentResult, 'pole' | 'time'>
	// Optional exposure-start epoch. The alignment pole is transported as Earth-fixed from
	// alignment.time; when omitted, the estimate starts at alignment.time.
	readonly time?: Time
}

// Normalized geometry shared by instantaneous and time-dependent calculations.
interface PolarGeometry {
	// Normalized mechanical RA-axis direction at the alignment epoch.
	readonly mount: Vec3
	// Normalized true celestial-pole direction.
	readonly pole: Vec3
	// Constant dot product p . m retained while the mechanical axis rotates around p.
	readonly mu: number
	// X component of the constant Rodrigues term p x m.
	readonly crossX: number
	// Y component of the constant Rodrigues term p x m.
	readonly crossY: number
	// Z component of the constant Rodrigues term p x m.
	readonly crossZ: number
	// Constant squared residual magnitude |p - m|^2.
	readonly residualSquared: number
	// Stable great-circle pole separation in radians.
	readonly polarError: Angle
}

// Returns omega * (celestialPole - mountPole), in radians per second by component. Both poles are
// normalized without mutation; finite non-zero directions are required.
export function polarAlignmentResidualAngularVelocity(mountPole: Vec3, celestialPole: Vec3, rate: Angle = SIDEREAL_DRIFT_RATE): Vec3 {
	const geometry = preparePolarGeometry(mountPole, celestialPole)
	return [rate * (geometry.pole[0] - geometry.mount[0]), rate * (geometry.pole[1] - geometry.mount[1]), rate * (geometry.pole[2] - geometry.mount[2])]
}

// Computes the instantaneous target drift magnitude |omega * (p - m) x target| in radians per
// second. All directions are normalized internally and inputs are not mutated.
export function polarAlignmentUnguidedDriftRate(mountPole: Vec3, celestialPole: Vec3, target: Vec3, rate: Angle = SIDEREAL_DRIFT_RATE): Angle {
	const geometry = preparePolarGeometry(mountPole, celestialPole)
	const direction = normalizeFiniteVector(target, 'target')
	return unguidedRateForMount(geometry, direction, geometry.mount[0], geometry.mount[1], geometry.mount[2], Math.abs(rate))
}

// Computes the maximum instantaneous drift magnitude for any target, 2 * |omega| * sin(error / 2),
// in radians per second. It is independent of target direction.
export function polarAlignmentWorstCaseDriftRate(mountPole: Vec3, celestialPole: Vec3, rate: Angle = SIDEREAL_DRIFT_RATE): Angle {
	const geometry = preparePolarGeometry(mountPole, celestialPole)
	return Math.abs(rate) * Math.sqrt(geometry.residualSquared)
}

// Computes the signed residual field-roll rate for ideal guiding with physical RA and DEC
// corrections. Returns undefined when the guide direction is too close to the mechanical RA axis.
export function polarAlignmentGuidedFieldRotationRate(mountPole: Vec3, celestialPole: Vec3, guide: Vec3, rate: Angle = SIDEREAL_DRIFT_RATE): Angle | undefined {
	const geometry = preparePolarGeometry(mountPole, celestialPole)
	const direction = normalizeFiniteVector(guide, 'guide')
	return guidedRateForMount(geometry, direction, vecDot(geometry.pole, direction), geometry.mount[0], geometry.mount[1], geometry.mount[2], rate)
}

// Converts camera pixel size in micrometers and focal length in millimeters to radians per pixel.
// Both optical dimensions must be positive and finite.
export function polarAlignmentImageScale(pixelSize: number, focalLength: number): Angle {
	return arcsec(pixelScale(pixelSize, focalLength))
}

// Computes the guide-centered angular radius to a sensor corner using a gnomonic projection. Width
// and height are positive finite pixel extents and imageScale is a positive finite radian pixel angle.
export function polarAlignmentFieldRadius(width: number, height: number, imageScale: Angle): Angle {
	if (!(imageScale > 0) || imageScale >= PIOVERTWO) throw new RangeError('imageScale must be positive and less than PI / 2')
	return Math.atan((Math.hypot(width, height) / 2) * Math.tan(imageScale))
}

// Estimates conservative unguided path length and guided field rotation over time while transporting
// the Earth-fixed mechanical axis around the true pole. Infinity means the requested trail is not
// reached within searchLimit; guided exposure is undefined only at an initial kinematic singularity.
export function polarAlignmentExposureLimit(input: Readonly<PolarAlignmentExposureInput>): PolarAlignmentExposureLimit {
	const geometry = preparePolarGeometry(input.mountPole, input.celestialPole)
	const maxTrail = input.maxTrail ?? DEFAULT_POLAR_ALIGNMENT_MAX_TRAIL
	const searchLimit = input.searchLimit ?? SIDEREAL_DAYSEC
	const threshold = input.imageScale * maxTrail
	const aligned = geometry.polarError <= VECTOR_EPSILON
	const worstCaseRate = SIDEREAL_DRIFT_RATE * Math.sqrt(geometry.residualSquared)
	const worstCase = aligned ? Number.POSITIVE_INFINITY : solveExposureLimit((time) => worstCaseRate * time, threshold, worstCaseRate, searchLimit)

	let targetRate: Angle | undefined
	let targetExposure: number | undefined

	if (input.target) {
		const target = normalizeFiniteVector(input.target, 'target')
		targetRate = unguidedRateForMount(geometry, target, geometry.mount[0], geometry.mount[1], geometry.mount[2], SIDEREAL_DRIFT_RATE)

		const mount: MutVec3 = [0, 0, 0]
		const rateAt = (sampleTime: number) => {
			transportedMount(geometry, sampleTime, mount)
			return unguidedRateForMount(geometry, target, mount[0], mount[1], mount[2], SIDEREAL_DRIFT_RATE)
		}

		targetExposure = aligned ? Number.POSITIVE_INFINITY : solveExposureLimit((time) => integrateRate(time, threshold, rateAt), threshold, targetRate, searchLimit)
	}

	const unguided: PolarAlignmentUnguidedExposureLimit = { worstCaseRate, worstCase, targetRate, target: targetExposure }
	let guided: PolarAlignmentGuidedExposureLimit | undefined

	if (input.guiding) {
		const guide = normalizeFiniteVector(input.guiding.guide, 'guide')
		const poleGuideDot = vecDot(geometry.pole, guide)

		const fieldRadius = input.guiding.fieldRadius
		if (!(fieldRadius >= 0 && fieldRadius <= PI) || !Number.isFinite(fieldRadius)) throw new RangeError('fieldRadius must be finite and between 0 and PI')

		const rotationRate = guidedRateForMount(geometry, guide, poleGuideDot, geometry.mount[0], geometry.mount[1], geometry.mount[2], SIDEREAL_DRIFT_RATE)

		if (rotationRate === undefined) {
			guided = { fieldRadius, singular: true }
		} else {
			const fieldFactor = Math.sin(Math.min(fieldRadius, PIOVERTWO))

			const mount: MutVec3 = [0, 0, 0]
			const rateAt = (sampleTime: number) => {
				transportedMount(geometry, sampleTime, mount)
				const sampleRate = guidedRateForMount(geometry, guide, poleGuideDot, mount[0], mount[1], mount[2], SIDEREAL_DRIFT_RATE)
				return sampleRate === undefined ? Number.POSITIVE_INFINITY : Math.abs(sampleRate)
			}

			const exposure = aligned || fieldFactor <= VECTOR_EPSILON ? Number.POSITIVE_INFINITY : solveExposureLimit((time) => fieldFactor * integrateRate(time, threshold / Math.max(fieldFactor, Number.EPSILON), rateAt), threshold, fieldFactor * Math.abs(rotationRate), searchLimit)

			guided = { rotationRate, fieldRadius, exposure, singular: false }
		}
	}

	return { polarError: geometry.polarError, imageScale: input.imageScale, maxTrail, unguided, guided }
}

// Estimates exposure limits directly from a three-point alignment result. By default the estimate
// starts at alignment.time. An explicit time transports the Earth-fixed mechanical pole through ITRS
// to that epoch. The true pole is computed once without refraction before delegating to the vector
// estimator; target and guide directions must describe the selected start epoch.
export function polarAlignmentExposureLimitForResult(input: Readonly<PolarAlignmentResultExposureInput>, location: GeographicPosition = input.time?.location ?? input.alignment.time.location!): PolarAlignmentExposureLimit {
	const { alignment, time: requestedTime, ...exposure } = input
	const time = requestedTime ?? alignment.time
	const mountPole = transportEarthFixed(alignment.pole, alignment.time, time)
	const celestialPole = celestialPoleVector(time, location, false)
	return polarAlignmentExposureLimit({ ...exposure, mountPole, celestialPole })
}

// Builds normalized immutable pole geometry and stable small-angle separation terms.
function preparePolarGeometry(mountPole: Vec3, celestialPole: Vec3): PolarGeometry {
	const mount = normalizeFiniteVector(mountPole, 'mountPole')
	const pole = normalizeFiniteVector(celestialPole, 'celestialPole')

	// Plate solves use the above-horizon pole, which is the SCP in the southern hemisphere. Earth
	// rotation is physically oriented toward the NCP, so express both equivalent unoriented axes on
	// that side before applying signed rates or evolving the Earth-fixed mechanical axis.
	if (pole[2] < 0) {
		vecNegateMut(mount)
		vecNegateMut(pole)
	}

	const mu = Math.max(-1, Math.min(1, vecDot(pole, mount)))
	const crossX = pole[1] * mount[2] - pole[2] * mount[1]
	const crossY = pole[2] * mount[0] - pole[0] * mount[2]
	const crossZ = pole[0] * mount[1] - pole[1] * mount[0]
	const polarError = vecAngleUnit(pole, mount)
	const residualX = pole[0] - mount[0]
	const residualY = pole[1] - mount[1]
	const residualZ = pole[2] - mount[2]
	const residualSquared = residualX * residualX + residualY * residualY + residualZ * residualZ
	return { mount, pole, mu, crossX, crossY, crossZ, residualSquared, polarError }
}

// Returns a fresh unit direction or rejects non-finite and numerically degenerate vectors.
function normalizeFiniteVector(vector: Vec3, name: string): MutVec3 {
	const length = vecLength(vector)
	if (!Number.isFinite(vector[0]) || !Number.isFinite(vector[1]) || !Number.isFinite(vector[2]) || !Number.isFinite(length) || !(length > VECTOR_EPSILON)) throw new RangeError(`${name} must be finite and non-zero`)
	return [vector[0] / length, vector[1] / length, vector[2] / length]
}

// Computes an unguided rate for a pre-normalized instantaneous mount axis using only scalars.
function unguidedRateForMount(geometry: PolarGeometry, target: Vec3, mountX: number, mountY: number, mountZ: number, rate: Angle): Angle {
	const residualX = geometry.pole[0] - mountX
	const residualY = geometry.pole[1] - mountY
	const residualZ = geometry.pole[2] - mountZ
	const projection = residualX * target[0] + residualY * target[1] + residualZ * target[2]
	return rate * Math.sqrt(Math.max(0, geometry.residualSquared - projection * projection))
}

// Computes signed guided roll for a pre-normalized instantaneous mount axis, or undefined at the
// RA/DEC singularity where the guide direction is parallel to that axis.
function guidedRateForMount(geometry: PolarGeometry, guide: Vec3, poleGuideDot: number, mountX: number, mountY: number, mountZ: number, rate: Angle): Angle | undefined {
	const c = mountX * guide[0] + mountY * guide[1] + mountZ * guide[2]
	const denominator = Math.max(0, 1 - c * c)
	if (!(denominator > GUIDING_SINGULARITY_EPSILON)) return undefined
	return (rate * (poleGuideDot - c * geometry.mu)) / denominator
}

// Transports the mechanical axis around the true pole by the sidereal angle at time, writing into a
// caller-owned tuple so numerical integration does not allocate per sample.
function transportedMount(geometry: PolarGeometry, time: number, mount: MutVec3): void {
	const theta = SIDEREAL_DRIFT_RATE * time
	const cosine = Math.cos(theta)
	const sine = Math.sin(theta)
	const oneMinusCosine = 1 - cosine
	mount[0] = geometry.mount[0] * cosine + geometry.crossX * sine + geometry.pole[0] * geometry.mu * oneMinusCosine
	mount[1] = geometry.mount[1] * cosine + geometry.crossY * sine + geometry.pole[1] * geometry.mu * oneMinusCosine
	mount[2] = geometry.mount[2] * cosine + geometry.crossZ * sine + geometry.pole[2] * geometry.mu * oneMinusCosine
}

// Integrates a non-negative scalar rate over [0, time] with composite Simpson estimates doubled to
// convergence. Tolerance scales with the caller's angular trail threshold.
function integrateRate(time: number, trailLimit: Angle, rateAt: (time: number) => number): number {
	if (time === 0) return 0

	const tolerance = Math.max(1e-12, trailLimit * 1e-5)
	let segments = INITIAL_INTEGRATION_SEGMENTS
	let previous = compositeSimpson(time, segments, rateAt)

	while (segments < MAX_INTEGRATION_SEGMENTS) {
		segments *= 2
		const current = compositeSimpson(time, segments, rateAt)
		if (!Number.isFinite(current) || Math.abs(current - previous) <= tolerance) return current
		previous = current
	}

	return previous
}

// Evaluates composite Simpson integration with an even segment count and no intermediate arrays.
function compositeSimpson(time: number, segments: number, rateAt: (time: number) => number): number {
	const step = time / segments
	let sum = rateAt(0) + rateAt(time)
	for (let index = 1; index < segments; index++) sum += (index % 2 === 0 ? 2 : 4) * rateAt(index * step)
	return (sum * step) / 3
}

// Brackets and bisects the first time a monotonic accumulated trail reaches threshold. A result of
// Infinity means the threshold was not reached within searchLimit, not an infinite physical time.
function solveExposureLimit(trailAt: (time: number) => number, threshold: Angle, initialRate: Angle, searchLimit: number): number {
	let low = 0
	let high = initialRate > VECTOR_EPSILON ? Math.min(searchLimit, threshold / initialRate) : Math.min(searchLimit, 1)

	if (!(high > 0)) high = searchLimit

	let trail = trailAt(high)

	while (trail < threshold && high < searchLimit) {
		low = high
		high = Math.min(searchLimit, high * 2)
		trail = trailAt(high)
	}

	if (trail < threshold) return Number.POSITIVE_INFINITY

	while (high - low > ROOT_TIME_TOLERANCE && high - low > high * 1e-6) {
		const middle = (low + high) / 2
		if (trailAt(middle) >= threshold) high = middle
		else low = middle
	}

	return high
}
