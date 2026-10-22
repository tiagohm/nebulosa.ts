import { DAYSEC, EARTH_ANGULAR_VELOCITY_VECTOR, PI, PIOVERTWO } from '../../core/constants'
import type { Mat2 } from '../../math/linear-algebra/mat2'
import { type Mat3, type MutMat3, matTranspose } from '../../math/linear-algebra/mat3'
import { Matrix } from '../../math/linear-algebra/matrix'
import type { Vec2 } from '../../math/linear-algebra/vec2'
import { type MutVec3, type Vec3, vecCross, vecCrossLength, vecDivScalar, vecDivScalarMut, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalizeMut, vecPlus, vecX, vecY, vecZ } from '../../math/linear-algebra/vec3'
import { erfc } from '../../math/numerical/statistics'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { CDMObject, ConjunctionDataMessage } from './cdm'

// Short-encounter collision probability (Pc) between two space objects from their states and position
// covariances at the time of closest approach (TCA), plus the RTN covariance transforms that feed it from a
// CCSDS CDM (cdm.ts). Positions are AU, velocities AU/day, covariances AU², AU²/day and AU²/day², angles
// radians, and reported durations seconds. Every state shares one frame whose axes are treated as inertial
// at TCA; the probability is invariant under a common rotation of that frame, so no conversion to GCRF is
// needed and none is performed.
//
// Model (Foster & Estes 1992; Chan 1997; Alfano 2005): relative motion is rectilinear and the combined
// position uncertainty is constant for the brief encounter, the two objects' errors are independent
// Gaussians (combined covariance C = C1 + C2), and both bodies are spheres whose combined hard-body radius
// R is given. Collapsing the motion onto the encounter plane perpendicular to the relative velocity turns
// Pc into the integral of a 2D Gaussian centred at the projected miss vector over a disk of radius R at the
// origin. Two estimators are offered:
//   - 'quadrature': the disk integral reduced to one dimension in the covariance principal axes and
//     integrated by adaptive Gauss-Kronrod to a requested relative tolerance (the high-fidelity mode of the
//     short-encounter model, not of the physics: it does not capture nonlinear relative motion, covariance
//     evolution through the encounter or velocity uncertainty);
//   - 'smallObject': the density at the disk centre times the disk area, πR²·N(0; m, C), whose relative
//     error grows like R²/σ_minor² and is only usable when R ≪ σ_minor (approximate mode); its correction
//     through fourth order is reported for both estimators so the caller can see when it is out of domain.
// Short-encounter validity is reported as diagnostics, never assumed; failures are discriminated results.
// No orbital covariance is ever synthesised from TLEs: SGP4 screening (satelliteConjunctions) can find a
// candidate but cannot supply the covariance this estimator needs. All results are freshly allocated.

// One object's state and 6x6 state covariance at TCA, in a frame shared with the other object.
export interface EncounterObjectState {
	// Position, AU.
	readonly position: Vec3
	// Inertial velocity, AU/day.
	readonly velocity: Vec3
	// Symmetric 6x6 covariance of [x, y, z, vx, vy, vz] in the same frame axes: AU², AU²/day, AU²/day².
	readonly covariance: Matrix
}

// Probability estimator.
export type CollisionProbabilityMethod = 'quadrature' | 'smallObject'

// Definiteness of a covariance matrix, judged on its correlation matrix.
export type CovarianceDefiniteness = 'positiveDefinite' | 'positiveSemidefinite' | 'indefinite'

// Positive-(semi)definiteness and conditioning of a covariance matrix.
export interface CovarianceCheck {
	// Definiteness within the eigenvalue tolerance; a zero-variance row and column that is otherwise empty
	// is discounted (CDM 5.2.8) and makes the matrix at most semidefinite.
	readonly definiteness: CovarianceDefiniteness
	// Smallest eigenvalue of the correlation matrix D^-1/2 C D^-1/2 (dimensionless, at most 1); -Infinity when
	// a variance is negative or a zero variance has a non-zero covariance, where no correlation exists.
	readonly minimumEigenvalue: number
	// Ratio of the largest to the smallest correlation eigenvalue; Infinity when the smallest is not positive.
	readonly conditionNumber: number
}

// Covariance checks of both objects and of their combined position covariance.
export interface EncounterCovarianceChecks {
	// Primary's full 6x6 state covariance.
	readonly primaryState: CovarianceCheck
	// Primary's 3x3 position covariance.
	readonly primaryPosition: CovarianceCheck
	// Secondary's full 6x6 state covariance.
	readonly secondaryState: CovarianceCheck
	// Secondary's 3x3 position covariance.
	readonly secondaryPosition: CovarianceCheck
	// Combined 3x3 position covariance C1 + C2.
	readonly combinedPosition: CovarianceCheck
}

// The encounter (conjunction) plane perpendicular to the relative velocity.
export interface EncounterPlane {
	// Unit in-plane axis along the projected miss vector (any perpendicular when the miss is zero).
	readonly xAxis: Vec3
	// Unit in-plane axis completing the right-handed (x, y, z) triad.
	readonly yAxis: Vec3
	// Unit axis along the relative velocity (secondary minus primary).
	readonly zAxis: Vec3
	// Projected miss vector [x, y] (AU); y is zero by construction.
	readonly miss: Vec2
	// Combined position covariance projected on the plane, [xx, xy, yx, yy] (AU²).
	readonly covariance: Mat2
	// Standard deviation along the major principal axis, AU.
	readonly sigmaMajor: Distance
	// Standard deviation along the minor principal axis, AU.
	readonly sigmaMinor: Distance
	// Angle of the major principal axis from xAxis toward yAxis, radians in (-PI/2, PI/2].
	readonly majorAxisAngle: Angle
	// Mahalanobis distance of the miss vector, sqrt(mᵀ C⁻¹ m) (dimensionless).
	readonly mahalanobisDistance: number
}

// Relative geometry of the encounter at the state epoch.
export interface EncounterGeometry {
	// Secondary minus primary position, AU.
	readonly relativePosition: Vec3
	// Secondary minus primary velocity, AU/day.
	readonly relativeVelocity: Vec3
	// Norm of the relative position, AU.
	readonly missDistance: Distance
	// Norm of the relative velocity, AU/day.
	readonly relativeSpeed: number
	// Signed time from the state epoch to the rectilinear closest approach, -(r·v)/|v|², seconds; near zero
	// when the states are at TCA. The plane projection already removes this along-track offset.
	readonly closestApproachOffset: number
	// Encounter plane.
	readonly plane: EncounterPlane
}

// Short-encounter validity diagnostics; heuristic screening thresholds, not accuracy bounds.
export interface ShortEncounterValidity {
	// Time to cross the combined position uncertainty along the relative velocity, 2·(k·σ_along + R)/|v|,
	// seconds, with k = encounterSigma.
	readonly encounterDuration: number
	// Largest orbital arc either object sweeps during encounterDuration, |r×v|/|r|²·duration, radians.
	readonly orbitalArc: Angle
	// Largest 1-sigma direction uncertainty of the relative velocity, sqrt(λmax of the combined velocity
	// covariance across the velocity)/|v|, radians.
	readonly velocityAngle: Angle
	// Whether orbitalArc and velocityAngle are both within their maxima.
	readonly valid: boolean
}

// Domain diagnostics of the small-object approximation πR²·N(0; m, C), reported for both estimators.
export interface SmallObjectValidity {
	// Hard-body radius over the minor plane sigma, R/σ_minor (dimensionless).
	readonly radiusRatio: number
	// Signed relative correction of the approximation through fourth order, c2 + c4, from the mean-value
	// expansion of the density f over the disk: c2 = (R²/8)·∇²f/f and c4 = (R⁴/192)·∇⁴f/f at the disk
	// centre. It estimates (exact - smallObject)/smallObject only while both terms are small; sixth and
	// higher orders are ignored.
	readonly relativeCorrection: number
	// Heuristic domain flag, not an error bound: radiusRatio < 1 and |c2| + |c4| within
	// maximumSmallObjectCorrection. Summing magnitudes keeps one term from hiding behind a cancellation of
	// the other (c2 vanishes on the ring ‖C⁻¹m‖² = tr C⁻¹).
	readonly valid: boolean
}

// A successful collision probability estimate.
export interface CollisionProbabilityEstimate {
	// Discriminant.
	readonly kind: 'estimate'
	// Estimator used.
	readonly method: CollisionProbabilityMethod
	// Probability of collision in [0, 1].
	readonly probability: number
	// Estimated absolute quadrature (algorithmic) error; 0 for the closed-form smallObject estimate, which
	// has no algorithmic error but an approximation error reported by smallObjectValidity.
	readonly error: number
	// Whether the quadrature met its tolerance within the panel budget; always true for smallObject. It
	// says nothing about the approximation or short-encounter model error.
	readonly converged: boolean
	// Encounter geometry.
	readonly geometry: EncounterGeometry
	// Covariance checks.
	readonly covariance: EncounterCovarianceChecks
	// Short-encounter validity diagnostics.
	readonly validity: ShortEncounterValidity
	// Small-object approximation diagnostics; also useful to decide whether 'smallObject' would suffice.
	readonly smallObjectValidity: SmallObjectValidity
}

// Why no probability could be estimated.
export type CollisionProbabilityFailureReason =
	// The relative velocity is zero, so no encounter plane exists.
	| 'zeroRelativeVelocity'
	// A position covariance has a negative variance, an impossible zero-variance coupling, or a negative
	// correlation eigenvalue beyond the tolerance.
	| 'indefiniteCovariance'
	// The projected encounter-plane covariance cannot be certified positive definite within the rounding of
	// its projection: some 2x2 matrix whose entries lie within their error bounds (PROJECTION_ROUNDING times
	// the absolute-value quadratic forms) is singular or indefinite. A merely elongated plane, or one whose
	// along-track variance is large, is still estimated when its transverse block is resolved.
	| 'degenerateEncounterCovariance'

// A failed collision probability estimate.
export interface CollisionProbabilityFailure {
	// Discriminant.
	readonly kind: 'failure'
	// Failure reason.
	readonly reason: CollisionProbabilityFailureReason
	// Covariance checks.
	readonly covariance: EncounterCovarianceChecks
	// Encounter geometry, when the relative velocity defines one.
	readonly geometry?: EncounterGeometry
}

// Result of a collision probability estimate.
export type CollisionProbabilityResult = CollisionProbabilityEstimate | CollisionProbabilityFailure

// Options for the collision probability estimate.
export interface CollisionProbabilityOptions {
	// Estimator; defaults to 'quadrature'.
	readonly method?: CollisionProbabilityMethod
	// Relative tolerance of the quadrature on the probability, default 1e-10.
	readonly relativeTolerance?: number
	// Maximum number of quadrature panels, default 1000; reaching it reports converged = false.
	readonly maxPanels?: number
	// Correlation-eigenvalue tolerance separating definite, semidefinite and indefinite covariances; default
	// 1e-10. It does not limit the anisotropy of the encounter-plane covariance.
	readonly covarianceTolerance?: number
	// Sigma multiple k of the along-track uncertainty used for the encounter duration, default 5.
	readonly encounterSigma?: number
	// Largest orbital arc swept during the encounter for a valid short encounter, radians, default 0.01.
	readonly maximumOrbitalArc?: Angle
	// Largest relative-velocity direction uncertainty for a valid short encounter, radians, default 0.01.
	readonly maximumVelocityAngle?: Angle
	// Largest |c2| + |c4| (see SmallObjectValidity) for a valid small-object approximation, default 0.01.
	readonly maximumSmallObjectCorrection?: number
}

// Default relative quadrature tolerance on Pc.
const DEFAULT_RELATIVE_TOLERANCE = 1e-10

// Default quadrature panel budget; bounds work on pathological geometries.
const DEFAULT_MAX_PANELS = 1000

// Default correlation-eigenvalue tolerance.
const DEFAULT_COVARIANCE_TOLERANCE = 1e-10

// Default sigma multiple for the encounter duration.
const DEFAULT_ENCOUNTER_SIGMA = 5

// Default maximum orbital arc (radians) and velocity-direction uncertainty (radians) of a short encounter.
const DEFAULT_MAXIMUM_ORBITAL_ARC = 0.01
const DEFAULT_MAXIMUM_VELOCITY_ANGLE = 0.01

// Default maximum |c2| + |c4| relative correction of a valid small-object approximation.
const DEFAULT_MAXIMUM_SMALL_OBJECT_CORRECTION = 0.01

// Relative rounding bound of a projected entry aᵀCb: the 9-term sum costs about 9ε times Σ|aᵢ||Cᵢⱼ||bⱼ|
// (Higham's γ₉), and the few-ulp error of the computed unit axes leaks C through the same absolute form,
// so 16ε bounds both. Large along-track entries enter only through axis components that are not exactly
// zero, i.e. only when the frame is oblique to the encounter axes, which is exactly when they can corrupt
// the plane block.
const PROJECTION_ROUNDING = 16 * Number.EPSILON

// Jacobi sweep cap; cyclic Jacobi converges quadratically, so 9x9 matrices need far fewer sweeps.
const JACOBI_SWEEPS = 64

// 1/sqrt(2π), the standard normal density at zero.
const INV_SQRT_TAU = 0.3989422804014327

// sqrt(1/2), converting a standard normal deviate to the erfc argument.
const SQRT_HALF = Math.SQRT1_2

// Gauss-Kronrod 7-15 abscissae on [0, 1] (descending; odd indices are the Gauss nodes), from QUADPACK qk15.
const XGK = [0.991455371120812639206854697526329, 0.949107912342758524526189684047851, 0.864864423359769072789712788640926, 0.741531185599394439863864773280788, 0.586087235467691130294144845693013, 0.405845151377397166906606412076961, 0.207784955007898467600689403773245, 0] as const

// Kronrod 15-point weights matching XGK.
const WGK = [0.02293532201052922496373200805897, 0.063092092629978553290700663189204, 0.104790010322250183839876322541518, 0.140653259715525918745189590510238, 0.16900472663926790282658342659855, 0.190350578064785409913256402421014, 0.204432940075298892414161999234649, 0.209482141084727828012999174891714] as const

// Gauss 7-point weights of the nodes XGK[1], XGK[3], XGK[5] and XGK[7].
const WG = [0.129484966168869693270611432679082, 0.27970539148927666790146777142378, 0.381830050505118944950369775488975, 0.417959183673469387755102040816327] as const

// Uniform panels seeded across the disk before adaptive refinement.
const INITIAL_PANELS = 8

// Sigma offsets at which panel breakpoints are seeded around the Gaussian centre and around the edges of
// the minor-axis band, so narrow features cannot fall between Kronrod nodes.
const BREAKPOINT_SIGMAS = [-8, -6, -4, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 4, 6, 8] as const

// Rotation matrix whose rows are the R, T and N unit vectors of the RTN frame of a state.
//
// R = r/|r| points radially outward, N = (r×v)/|r×v| along the orbital angular momentum, and T = N×R
// completes the right-handed frame (CCSDS 508.0-B-1 annex E; v must be the inertial velocity). The matrix
// maps frame components to RTN components: x_rtn = M x_frame. Returns undefined when r is zero or v is
// parallel to r, where R or N is undefined. Allocates a fresh matrix.
export function rtnRotation(position: Vec3, velocity: Vec3): MutMat3 | undefined {
	const radius = vecLength(position)
	const normal = vecCross(position, velocity)
	const normalLength = vecLength(normal)
	if (!(radius > 0) || !(normalLength > 0)) return undefined

	const r = vecDivScalar(position, radius)
	const n = vecDivScalarMut(normal, normalLength)
	const t = vecCross(n, r)
	return [r[0], r[1], r[2], t[0], t[1], t[2], n[0], n[1], n[2]]
}

// Rotates a 6x6 (or larger) state covariance with the block rotation diag(A, A): C' = B C Bᵀ.
//
// Only the leading 6x6 position/velocity block is rotated and returned; the rotation is instantaneous, so
// no rotating-frame transport term is added. Use A = rtnRotation(r, v) for frame -> RTN and its transpose
// for RTN -> frame. Allocates a fresh 6x6 matrix and does not mutate the input.
export function rotateStateCovariance(covariance: Matrix, rotation: Mat3): Matrix {
	const block = new Float64Array(36)
	for (let i = 0; i < 6; i++) {
		const bi = i < 3 ? 0 : 3

		for (let j = 0; j < 6; j++) {
			const bj = j < 3 ? 0 : 3
			let sum = 0

			for (let k = 0; k < 3; k++) {
				const row = rotation[(i - bi) * 3 + k]
				for (let l = 0; l < 3; l++) sum += row * covariance.get(bi + k, bj + l) * rotation[(j - bj) * 3 + l]
			}

			block[i * 6 + j] = sum
		}
	}

	// Symmetrize so rounding cannot leave a tiny antisymmetric residue.
	for (let i = 0; i < 6; i++) {
		for (let j = 0; j < i; j++) {
			const mean = 0.5 * (block[i * 6 + j] + block[j * 6 + i])
			block[i * 6 + j] = mean
			block[j * 6 + i] = mean
		}
	}

	return new Matrix(6, 6, block, false)
}

// Converts one CDM object to an encounter state in the axes of its REF_FRAME at TCA.
function cdmObjectState(object: CDMObject): EncounterObjectState {
	// ITRF velocities are Earth-fixed; the RTN normal is defined by the inertial orbit plane, so the
	// transport term ω×r (Earth spin about the ITRF Z axis, rad/day) is added. Polar motion and length-of-day
	// variations change ω by parts in 10⁶ and are neglected. EME2000 and GCRF are already inertial.
	const velocity: Vec3 = object.referenceFrame === 'ITRF' ? vecPlus(object.velocity, vecCross(EARTH_ANGULAR_VELOCITY_VECTOR, object.position)) : object.velocity
	const rotation = rtnRotation(object.position, velocity)
	if (rotation === undefined) throw new Error(`${object.object} inertial state vector does not define an RTN frame`)
	return { position: object.position, velocity, covariance: rotateStateCovariance(object.covariance, matTranspose(rotation, rotation)) }
}

// Converts a parsed CDM into the two encounter states (Object1, Object2) at TCA.
//
// Positions stay in the message REF_FRAME axes; ITRF velocities become inertial by adding ω×r. Each RTN
// covariance is rotated to those axes with the RTN frame built from its own inertial state. The velocity
// block is taken as the covariance of the inertial velocity, which for ITRF neglects the ω×δr coupling of
// position errors into Earth-fixed velocity (about 7e-5 s⁻¹ times the position sigma). The optional
// drag, SRP and thrust rows are dropped because the short-encounter estimator does not use them.
export function cdmEncounterStates(cdm: ConjunctionDataMessage): readonly [EncounterObjectState, EncounterObjectState] {
	return [cdmObjectState(cdm.objects[0]), cdmObjectState(cdm.objects[1])]
}

// Estimates the collision probability of a parsed CDM for a combined hard-body radius (AU).
//
// The CDM does not carry a hard-body radius, so the caller supplies it (for example from AREA_PC or
// operator knowledge). Equivalent to collisionProbability(...cdmEncounterStates(cdm), radius, options).
export function cdmCollisionProbability(cdm: ConjunctionDataMessage, hardBodyRadius: Distance, options?: CollisionProbabilityOptions): CollisionProbabilityResult {
	const [primary, secondary] = cdmEncounterStates(cdm)
	return collisionProbability(primary, secondary, hardBodyRadius, options)
}

// Estimates the short-encounter collision probability of two objects at TCA.
//
// Builds the encounter plane perpendicular to the relative velocity (secondary minus primary), projects the
// combined position covariance C1 + C2 and the miss vector onto it, and integrates the 2D Gaussian over the
// hard-body disk of radius `hardBodyRadius` (AU, positive) with the selected estimator. Both states must be
// in the same frame and at the same epoch. Covariance definiteness is checked on correlation matrices;
// an indefinite position covariance (including any negative variance), a zero relative velocity or a plane
// covariance that cannot be certified positive definite within its projection rounding return a failure
// instead of a number; strongly anisotropic or along-track-dominated positive-definite planes are
// integrated. The validity diagnostics flag encounters that are too slow or whose relative-velocity
// direction is too uncertain for the short-encounter model; the probability is still returned for them,
// and the caller decides whether to trust it.
export function collisionProbability(primary: EncounterObjectState, secondary: EncounterObjectState, hardBodyRadius: Distance, options: CollisionProbabilityOptions = {}): CollisionProbabilityResult {
	const method = options.method ?? 'quadrature'
	const tolerance = options.covarianceTolerance ?? DEFAULT_COVARIANCE_TOLERANCE

	const combined = new Float64Array(9)
	const combinedVelocity = new Float64Array(9)

	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			combined[i * 3 + j] = primary.covariance.get(i, j) + secondary.covariance.get(i, j)
			combinedVelocity[i * 3 + j] = primary.covariance.get(i + 3, j + 3) + secondary.covariance.get(i + 3, j + 3)
		}
	}

	const covariance: EncounterCovarianceChecks = {
		primaryState: covarianceCheck(primary.covariance.data, 6, primary.covariance.cols, tolerance),
		primaryPosition: covarianceCheck(primary.covariance.data, 3, primary.covariance.cols, tolerance),
		secondaryState: covarianceCheck(secondary.covariance.data, 6, secondary.covariance.cols, tolerance),
		secondaryPosition: covarianceCheck(secondary.covariance.data, 3, secondary.covariance.cols, tolerance),
		combinedPosition: covarianceCheck(combined, 3, 3, tolerance),
	}

	const relativePosition = vecMinus(secondary.position, primary.position)
	const relativeVelocity = vecMinus(secondary.velocity, primary.velocity)
	const relativeSpeed = vecLength(relativeVelocity)
	if (!(relativeSpeed > 0)) return { kind: 'failure', reason: 'zeroRelativeVelocity', covariance }

	const zAxis = vecDivScalar(relativeVelocity, relativeSpeed)
	const along = vecDot(relativePosition, zAxis)
	const perpendicular = vecMulScalar(zAxis, along)
	vecMinus(relativePosition, perpendicular, perpendicular)
	const missLength = vecLength(perpendicular)
	const xAxis = missLength > 0 ? vecDivScalarMut(perpendicular, missLength) : anyPerpendicular(zAxis, perpendicular)
	const yAxis = vecCross(zAxis, xAxis)

	const cxx = quadraticForm(combined, xAxis, xAxis)
	const cxy = quadraticForm(combined, xAxis, yAxis)
	const cyy = quadraticForm(combined, yAxis, yAxis)
	const mean = 0.5 * (cxx + cyy)
	const radius = Math.hypot(0.5 * (cxx - cyy), cxy)
	const major = mean + radius
	// det/λmax avoids the cancellation of mean - radius for an elongated ellipse.
	const determinant = cxx * cyy - cxy * cxy
	const minor = major > 0 ? determinant / major : 0
	const majorAxisAngle = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
	const mahalanobisDistance = determinant > 0 ? missLength * Math.sqrt(cyy / determinant) : Number.POSITIVE_INFINITY

	const geometry: EncounterGeometry = {
		relativePosition,
		relativeVelocity,
		missDistance: vecLength(relativePosition),
		relativeSpeed,
		closestApproachOffset: (-along / relativeSpeed) * DAYSEC,
		plane: {
			xAxis,
			yAxis,
			zAxis,
			miss: [missLength, 0],
			covariance: [cxx, cxy, cxy, cyy],
			sigmaMajor: Math.sqrt(Math.max(major, 0)),
			sigmaMinor: Math.sqrt(Math.max(minor, 0)),
			majorAxisAngle: majorAxisAngle === -PIOVERTWO ? PIOVERTWO : majorAxisAngle,
			mahalanobisDistance,
		},
	}

	if (covariance.primaryPosition.definiteness === 'indefinite' || covariance.secondaryPosition.definiteness === 'indefinite' || covariance.combinedPosition.definiteness === 'indefinite') return { kind: 'failure', reason: 'indefiniteCovariance', covariance, geometry }
	// Certify positive definiteness for every symmetric 2x2 matrix within the entry error bounds δ: its
	// smallest diagonal entries and determinant over that box are cxx - δxx, cyy - δyy and
	// (cxx - δxx)(cyy - δyy) - (|cxy| + δxy)². Unlike a global eigenvalue perturbation bound, this keeps an
	// axis-aligned, extremely elongated plane whose small variance is resolved by itself, and still rejects
	// a plane made near singular by cancellation between cxx·cyy and cxy². The margin it demands also
	// exceeds the rounding of the determinant, so the computed minor eigenvalue is positive.
	const dxx = PROJECTION_ROUNDING * absoluteQuadraticForm(combined, xAxis, xAxis)
	const dxy = PROJECTION_ROUNDING * absoluteQuadraticForm(combined, xAxis, yAxis)
	const dyy = PROJECTION_ROUNDING * absoluteQuadraticForm(combined, yAxis, yAxis)
	const lowerXX = cxx - dxx
	const lowerYY = cyy - dyy
	const upperXY = Math.abs(cxy) + dxy
	if (!(lowerXX > 0 && lowerYY > 0 && lowerXX * lowerYY > upperXY * upperXY && minor > 0)) return { kind: 'failure', reason: 'degenerateEncounterCovariance', covariance, geometry }

	const validity = shortEncounterValidity(primary, secondary, combined, combinedVelocity, zAxis, xAxis, yAxis, relativeSpeed, hardBodyRadius, options)

	// Mean-value expansion of the density over the disk, Σ (R²/4)ᵏ ∇²ᵏf / (k!(k+1)!), at the disk centre for
	// the Gaussian f centred at m = (missLength, 0) with A = C⁻¹ and u = A m:
	//   ∇²f/f = ‖u‖² - tr A,   ∇⁴f/f = (‖u‖² - tr A)² - 4 uᵀA u + 2 tr A².
	const r2 = hardBodyRadius * hardBodyRadius
	const ux = (cyy * missLength) / determinant
	const uy = (-cxy * missLength) / determinant
	const laplacian = ux * ux + uy * uy - (cxx + cyy) / determinant
	const uAu = (cyy * ux * ux - 2 * cxy * ux * uy + cxx * uy * uy) / determinant
	const traceA2 = (cxx * cxx + 2 * cxy * cxy + cyy * cyy) / (determinant * determinant)
	const second = (r2 / 8) * laplacian
	const fourth = ((r2 * r2) / 192) * (laplacian * laplacian - 4 * uAu + 2 * traceA2)
	const radiusRatio = hardBodyRadius / geometry.plane.sigmaMinor
	const smallObjectValidity: SmallObjectValidity = { radiusRatio, relativeCorrection: second + fourth, valid: radiusRatio < 1 && Math.abs(second) + Math.abs(fourth) <= (options.maximumSmallObjectCorrection ?? DEFAULT_MAXIMUM_SMALL_OBJECT_CORRECTION) }

	if (method === 'smallObject') {
		const probability = Math.min(1, ((hardBodyRadius * hardBodyRadius) / (2 * Math.sqrt(determinant))) * Math.exp(-0.5 * mahalanobisDistance * mahalanobisDistance))
		return { kind: 'estimate', method, probability, error: 0, converged: true, geometry, covariance, validity, smallObjectValidity }
	}

	// Principal axes: u along the major axis, w along the minor axis; the miss vector lies on xAxis.
	const cos = Math.cos(majorAxisAngle)
	const sin = Math.sin(majorAxisAngle)
	const integral = diskGaussianIntegral((missLength * cos) / hardBodyRadius, (-missLength * sin) / hardBodyRadius, Math.sqrt(major) / hardBodyRadius, Math.sqrt(minor) / hardBodyRadius, options.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE, options.maxPanels ?? DEFAULT_MAX_PANELS)
	return { kind: 'estimate', method, probability: Math.min(1, integral.value), error: integral.error, converged: integral.converged, geometry, covariance, validity, smallObjectValidity }
}

// Short-encounter diagnostics from the combined covariances and both orbital rates.
function shortEncounterValidity(primary: EncounterObjectState, secondary: EncounterObjectState, combined: Float64Array, combinedVelocity: Float64Array, zAxis: Vec3, xAxis: Vec3, yAxis: Vec3, relativeSpeed: number, hardBodyRadius: Distance, options: CollisionProbabilityOptions): ShortEncounterValidity {
	const sigmaAlong = Math.sqrt(Math.max(quadraticForm(combined, zAxis, zAxis), 0))
	const duration = (2 * ((options.encounterSigma ?? DEFAULT_ENCOUNTER_SIGMA) * sigmaAlong + hardBodyRadius)) / relativeSpeed
	const rate = Math.max(orbitalRate(primary), orbitalRate(secondary))
	const orbitalArc = duration * rate

	const vxx = quadraticForm(combinedVelocity, xAxis, xAxis)
	const vxy = quadraticForm(combinedVelocity, xAxis, yAxis)
	const vyy = quadraticForm(combinedVelocity, yAxis, yAxis)
	const velocityMajor = 0.5 * (vxx + vyy) + Math.hypot(0.5 * (vxx - vyy), vxy)
	const velocityAngle = Math.sqrt(Math.max(velocityMajor, 0)) / relativeSpeed

	return {
		encounterDuration: duration * DAYSEC,
		orbitalArc,
		velocityAngle,
		valid: orbitalArc <= (options.maximumOrbitalArc ?? DEFAULT_MAXIMUM_ORBITAL_ARC) && velocityAngle <= (options.maximumVelocityAngle ?? DEFAULT_MAXIMUM_VELOCITY_ANGLE),
	}
}

// Inertial angular rate |r×v|/|r|² of a state, radians per day.
function orbitalRate(state: EncounterObjectState) {
	const radius = vecLength(state.position)
	return vecCrossLength(state.position, state.velocity) / (radius * radius)
}

// aᵀ M b for a row-major 3x3 matrix M.
function quadraticForm(m: Float64Array, a: Vec3, b: Vec3) {
	return a[0] * (m[0] * b[0] + m[1] * b[1] + m[2] * b[2]) + a[1] * (m[3] * b[0] + m[4] * b[1] + m[5] * b[2]) + a[2] * (m[6] * b[0] + m[7] * b[1] + m[8] * b[2])
}

// Σ |aᵢ||Mᵢⱼ||bⱼ| for a row-major 3x3 matrix M: the scale of the rounding error of quadraticForm(m, a, b).
function absoluteQuadraticForm(m: Float64Array, a: Vec3, b: Vec3) {
	const a0 = Math.abs(a[0])
	const a1 = Math.abs(a[1])
	const a2 = Math.abs(a[2])
	const b0 = Math.abs(b[0])
	const b1 = Math.abs(b[1])
	const b2 = Math.abs(b[2])
	return a0 * (Math.abs(m[0]) * b0 + Math.abs(m[1]) * b1 + Math.abs(m[2]) * b2) + a1 * (Math.abs(m[3]) * b0 + Math.abs(m[4]) * b1 + Math.abs(m[5]) * b2) + a2 * (Math.abs(m[6]) * b0 + Math.abs(m[7]) * b1 + Math.abs(m[8]) * b2)
}

const X_AXIS = vecX()
const Y_AXIS = vecY()
const Z_AXIS = vecZ()

// A unit vector perpendicular to a unit vector, built from the coordinate axis least aligned with it.
function anyPerpendicular(v: Vec3, out?: MutVec3) {
	const ax = Math.abs(v[0])
	const ay = Math.abs(v[1])
	const az = Math.abs(v[2])
	const axis = ax <= ay && ax <= az ? X_AXIS : ay <= az ? Y_AXIS : Z_AXIS
	return vecNormalizeMut(vecCross(v, axis, out))
}

// Definiteness and conditioning of the leading `size`x`size` block of a row-major matrix with `stride`
// columns, judged on its correlation matrix so mixed position/velocity units do not bias the eigenvalues.
function covarianceCheck(data: ArrayLike<number>, size: number, stride: number, tolerance: number): CovarianceCheck {
	const kept: number[] = []
	let impossible = false

	for (let i = 0; i < size; i++) {
		const variance = data[i * stride + i]

		if (variance > 0) {
			kept.push(i)
		} else if (!(variance === 0)) {
			// A negative (or NaN) variance makes eᵢᵀ C eᵢ < 0, so C has a negative eigenvalue whatever the
			// rest of the matrix; it must never be discounted like a zero variance.
			impossible = true
		} else {
			// A zero variance with a non-zero covariance is impossible for any distribution; a zero row and
			// column is discounted (CDM 5.2.8).
			for (let j = 0; j < size; j++) if (j !== i && data[i * stride + j] !== 0) impossible = true
		}
	}

	if (impossible) return { definiteness: 'indefinite', minimumEigenvalue: Number.NEGATIVE_INFINITY, conditionNumber: Number.POSITIVE_INFINITY }
	if (kept.length === 0) return { definiteness: 'positiveSemidefinite', minimumEigenvalue: 0, conditionNumber: Number.POSITIVE_INFINITY }

	const n = kept.length
	const correlation = new Float64Array(n * n)
	for (let a = 0; a < n; a++) {
		const i = kept[a]
		const si = Math.sqrt(data[i * stride + i])
		for (let b = 0; b < n; b++) {
			const j = kept[b]
			correlation[a * n + b] = a === b ? 1 : (0.5 * (data[i * stride + j] + data[j * stride + i])) / (si * Math.sqrt(data[j * stride + j]))
		}
	}

	const eigenvalues = symmetricEigenvalues(correlation, n)
	let minimum = eigenvalues[0]
	let maximum = eigenvalues[0]
	for (let i = 1; i < n; i++) {
		minimum = Math.min(minimum, eigenvalues[i])
		maximum = Math.max(maximum, eigenvalues[i])
	}

	const definiteness: CovarianceDefiniteness = minimum < -tolerance ? 'indefinite' : minimum <= tolerance || n < size ? 'positiveSemidefinite' : 'positiveDefinite'
	return { definiteness, minimumEigenvalue: n < size ? Math.min(0, minimum) : minimum, conditionNumber: minimum > 0 && n === size ? maximum / minimum : Number.POSITIVE_INFINITY }
}

// Eigenvalues of a symmetric row-major n x n matrix by cyclic Jacobi rotations (Numerical Recipes 11.1).
// Destroys `a`; returns the diagonal after convergence, unsorted.
function symmetricEigenvalues(a: Float64Array, n: number) {
	for (let sweep = 0; sweep < JACOBI_SWEEPS; sweep++) {
		let offDiagonal = 0
		let diagonal = 0

		for (let p = 0; p < n; p++) {
			diagonal += a[p * n + p] * a[p * n + p]
			for (let q = p + 1; q < n; q++) offDiagonal += a[p * n + q] * a[p * n + q]
		}

		if (offDiagonal <= 1e-32 * diagonal) break

		for (let p = 0; p < n - 1; p++) {
			for (let q = p + 1; q < n; q++) {
				const apq = a[p * n + q]
				if (apq === 0) continue
				const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq)
				const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
				const c = 1 / Math.sqrt(t * t + 1)
				const s = t * c

				for (let r = 0; r < n; r++) {
					if (r === p || r === q) continue
					const arp = a[r * n + p]
					const arq = a[r * n + q]
					a[r * n + p] = a[p * n + r] = c * arp - s * arq
					a[r * n + q] = a[q * n + r] = s * arp + c * arq
				}

				a[p * n + p] -= t * apq
				a[q * n + q] += t * apq
				a[p * n + q] = a[q * n + p] = 0
			}
		}
	}

	const eigenvalues = new Float64Array(n)
	for (let i = 0; i < n; i++) eigenvalues[i] = a[i * n + i]
	return eigenvalues
}

// Standard normal density.
function normalDensity(z: number) {
	return INV_SQRT_TAU * Math.exp(-0.5 * z * z)
}

// Probability that a standard normal deviate lies in [a, b], accurate in relative terms in both tails.
//
// A narrow interval (width times its largest |bound| at most 1, so the density varies by at most a
// factor e across it) is integrated directly with the 15-point Kronrod rule, avoiding the cancellation
// of two nearly equal tail areas; wider intervals difference the tail areas on the side of zero they
// lie on.
function normalInterval(a: number, b: number) {
	const width = b - a
	if (!(width > 0)) return 0

	if (width * Math.max(1, Math.abs(a), Math.abs(b)) <= 1) {
		const center = 0.5 * (a + b)
		const half = 0.5 * width
		let sum = WGK[7] * normalDensity(center)
		for (let j = 0; j < 7; j++) sum += WGK[j] * (normalDensity(center - half * XGK[j]) + normalDensity(center + half * XGK[j]))
		return sum * half
	}

	if (a >= 0) return 0.5 * (erfc(a * SQRT_HALF) - erfc(b * SQRT_HALF))
	if (b <= 0) return 0.5 * (erfc(-b * SQRT_HALF) - erfc(-a * SQRT_HALF))
	return 1 - 0.5 * (erfc(-a * SQRT_HALF) + erfc(b * SQRT_HALF))
}

// One quadrature panel and its Kronrod estimate.
interface Panel {
	// Lower bound.
	readonly a: number
	// Upper bound.
	readonly b: number
	// Kronrod 15-point estimate.
	readonly value: number
	// |Kronrod - Gauss| error estimate.
	readonly error: number
}

// Kronrod 15-point estimate and |K15 - G7| error of f over [a, b].
function kronrodPanel(f: (x: number) => number, a: number, b: number): Panel {
	const center = 0.5 * (a + b)
	const half = 0.5 * (b - a)
	const fc = f(center)
	let kronrod = WGK[7] * fc
	let gauss = WG[3] * fc

	for (let j = 0; j < 7; j++) {
		const dx = half * XGK[j]
		const sum = f(center - dx) + f(center + dx)
		kronrod += WGK[j] * sum
		if (j % 2 === 1) gauss += WG[(j - 1) >> 1] * sum
	}

	return { a, b, value: kronrod * half, error: Math.abs((kronrod - gauss) * half) }
}

// Probability mass of a 2D Gaussian inside the unit disk centred at the origin.
//
// All lengths are in units of the hard-body radius: the Gaussian has mean (mu, mw) and standard deviations
// su >= sw along its principal axes. With u = sin θ the mass is
//   ∫_{-π/2}^{π/2} cos θ / su · φ((sin θ - mu)/su) · P(|w| <= cos θ) dθ,
// whose integrand is smooth (the substitution removes the √(1 - u²) endpoint singularity). Breakpoints are
// seeded at sigma offsets around the Gaussian centre and the minor-axis band edges, then the panel with
// the largest error is bisected until the total error is within relativeTolerance or maxPanels is reached.
function diskGaussianIntegral(mu: number, mw: number, su: number, sw: number, relativeTolerance: number, maxPanels: number) {
	const integrand = (theta: number) => {
		const cos = Math.cos(theta)
		if (!(cos > 0)) return 0
		const density = normalDensity((Math.sin(theta) - mu) / su) / su
		if (density === 0) return 0
		return cos * density * normalInterval((-cos - mw) / sw, (cos - mw) / sw)
	}

	const breakpoints = [-PIOVERTWO, PIOVERTWO]
	for (let i = 1; i < INITIAL_PANELS; i++) breakpoints.push(-PIOVERTWO + (PI * i) / INITIAL_PANELS)
	for (const k of BREAKPOINT_SIGMAS) {
		const u = mu + k * su
		if (u > -1 && u < 1) breakpoints.push(Math.asin(u))
		const edge = Math.abs(mw) + k * sw
		if (edge > 0 && edge < 1) {
			const theta = Math.acos(edge)
			breakpoints.push(theta, -theta)
		}
	}

	breakpoints.sort((x, y) => x - y)
	const panels: Panel[] = []
	for (let i = 1; i < breakpoints.length; i++) {
		if (breakpoints[i] > breakpoints[i - 1]) panels.push(kronrodPanel(integrand, breakpoints[i - 1], breakpoints[i]))
	}

	let value = 0
	let error = 0
	let converged = false

	while (true) {
		value = 0
		error = 0
		let worst = 0
		for (let i = 0; i < panels.length; i++) {
			value += panels[i].value
			error += panels[i].error
			if (panels[i].error > panels[worst].error) worst = i
		}

		if (error <= relativeTolerance * value) {
			converged = true
			break
		}

		const panel = panels[worst]
		const middle = 0.5 * (panel.a + panel.b)
		// Stop when the budget is spent or the worst panel can no longer be bisected in double precision.
		if (panels.length >= maxPanels || !(middle > panel.a && middle < panel.b)) break
		panels[worst] = kronrodPanel(integrand, panel.a, middle)
		panels.push(kronrodPanel(integrand, middle, panel.b))
	}

	return { value, error, converged }
}
