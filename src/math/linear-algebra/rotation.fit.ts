import type { Angle } from '../units/angle'
import type { MutMat3 } from './mat3'
import type { Vec3 } from './vec3'

// Weighted least-squares fit of a proper three-dimensional rotation between two sets of paired
// unit directions (Wahba's problem), solved in closed form with Horn's unit-quaternion method:
// the rotation is the eigenvector of the largest eigenvalue of a symmetric 4x4 matrix built from
// the weighted cross-covariance of the pairs, found with cyclic Jacobi rotations. The result is
// always a proper rotation (determinant +1), never a reflection. Directions are unit vectors in
// any one right-handed frame; residuals are angles in radians. Every call allocates its result.
//
// B. K. P. Horn, "Closed-form solution of absolute orientation using unit quaternions",
// J. Opt. Soc. Am. A 4 (1987) 629-642.

// Weighted fit of an active rotation mapping each `from` direction onto its paired `to` direction.
export interface RotationFit {
	// Active proper rotation, row-major: `to[i] ≈ rotation · from[i]`.
	readonly rotation: MutMat3
	// Weighted root-mean-square angle between `rotation · from[i]` and `to[i]`, in radians.
	readonly residual: Angle
	// Largest angle between `rotation · from[i]` and `to[i]`, in radians.
	readonly maximumResidual: Angle
	// Gap between the two largest eigenvalues λ1 ≥ λ2 of Horn's matrix, 3(λ1 − λ2)/(4λ1), in [0, 1]
	// (λ2 ≥ −λ1/3 because the eigenvalues sum to zero). It measures how firmly the pairs fix the
	// weakest rotation direction: 1 for exact pairs spread evenly over the sphere, proportional to
	// the square of the angular radius of a small cluster of directions (whose roll about their mean
	// is the weak direction), and 0 when the rotation is undetermined.
	readonly conditioning: number
}

// Gap below which the largest eigenvalue is considered repeated, so the rotation is undetermined
// (collinear or antipodal-only directions, or a single pair).
const MINIMUM_CONDITIONING = 1e-14

// Maximum number of cyclic Jacobi sweeps; a symmetric 4x4 matrix converges in well under ten.
const MAXIMUM_SWEEPS = 64

// Fits the active proper rotation that best maps the unit directions `from` onto `to` in the
// weighted least-squares sense, minimizing Σ wᵢ |toᵢ − R fromᵢ|². `weights` defaults to 1 for every
// pair and must be non-negative. Returns undefined when the arrays differ in length, fewer than two
// pairs are given, the total weight is not positive, an input is not finite, or the pairs leave the
// rotation undetermined (all directions collinear). Inputs are unchanged.
export function fitRotation(from: readonly Vec3[], to: readonly Vec3[], weights?: readonly number[]): RotationFit | undefined {
	const n = from.length
	// A length mismatch would read past the end of an array and crash below.
	if (n < 2 || to.length !== n || (weights !== undefined && weights.length !== n)) return undefined

	let sxx = 0
	let sxy = 0
	let sxz = 0
	let syx = 0
	let syy = 0
	let syz = 0
	let szx = 0
	let szy = 0
	let szz = 0
	let total = 0

	for (let i = 0; i < n; i++) {
		const w = weights?.[i] ?? 1
		const [ax, ay, az] = from[i]
		const [bx, by, bz] = to[i]
		total += w
		sxx += w * ax * bx
		sxy += w * ax * by
		sxz += w * ax * bz
		syx += w * ay * bx
		syy += w * ay * by
		syz += w * ay * bz
		szx += w * az * bx
		szy += w * az * by
		szz += w * az * bz
	}

	if (!(total > 0) || !Number.isFinite(total)) return undefined

	// Horn's symmetric matrix N; its dominant eigenvector is the quaternion (q0, qx, qy, qz).
	// oxfmt-ignore
	const matrix = new Float64Array([
		sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
		syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
		szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
		sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
	])

	for (let i = 0; i < 16; i++) if (!Number.isFinite(matrix[i])) return undefined

	const vectors = new Float64Array(16)
	const values = new Float64Array(4)
	if (!symmetricEigen4(matrix, vectors, values)) return undefined

	let first = 0
	for (let i = 1; i < 4; i++) if (values[i] > values[first]) first = i
	let second = first === 0 ? 1 : 0
	for (let i = 0; i < 4; i++) if (i !== first && values[i] > values[second]) second = i

	const largest = values[first]
	const conditioning = largest > 0 ? (0.75 * (largest - values[second])) / largest : 0
	if (!(conditioning > MINIMUM_CONDITIONING)) return undefined

	let q0 = vectors[first]
	let qx = vectors[4 + first]
	let qy = vectors[8 + first]
	let qz = vectors[12 + first]
	const length = Math.hypot(q0, qx, qy, qz)
	q0 /= length
	qx /= length
	qy /= length
	qz /= length

	// oxfmt-ignore
	const rotation: MutMat3 = [
		q0 * q0 + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - q0 * qz), 2 * (qx * qz + q0 * qy),
		2 * (qy * qx + q0 * qz), q0 * q0 - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - q0 * qx),
		2 * (qz * qx - q0 * qy), 2 * (qz * qy + q0 * qx), q0 * q0 - qx * qx - qy * qy + qz * qz,
	]

	let squared = 0
	let maximumResidual = 0

	for (let i = 0; i < n; i++) {
		const [ax, ay, az] = from[i]
		const [bx, by, bz] = to[i]
		const rx = rotation[0] * ax + rotation[1] * ay + rotation[2] * az
		const ry = rotation[3] * ax + rotation[4] * ay + rotation[5] * az
		const rz = rotation[6] * ax + rotation[7] * ay + rotation[8] * az
		// atan2 of |cross| and dot keeps small residuals accurate where acos would lose them.
		const angle = Math.atan2(Math.hypot(ry * bz - rz * by, rz * bx - rx * bz, rx * by - ry * bx), rx * bx + ry * by + rz * bz)
		squared += (weights?.[i] ?? 1) * angle * angle
		if (angle > maximumResidual) maximumResidual = angle
	}

	return { rotation, residual: Math.sqrt(squared / total), maximumResidual, conditioning }
}

// Diagonalizes the symmetric row-major 4x4 `matrix` with cyclic Jacobi rotations. On return
// `values` holds the eigenvalues and the columns of the row-major `vectors` the matching unit
// eigenvectors; `matrix` is overwritten. Returns false when the sweeps do not converge within
// MAXIMUM_SWEEPS, which bounds the work for non-finite or pathological input.
function symmetricEigen4(matrix: Float64Array, vectors: Float64Array, values: Float64Array) {
	vectors.fill(0)
	vectors[0] = vectors[5] = vectors[10] = vectors[15] = 1

	let scale = 0
	for (let i = 0; i < 16; i++) scale += matrix[i] * matrix[i]
	const tolerance = scale * 1e-32

	for (let sweep = 0; sweep < MAXIMUM_SWEEPS; sweep++) {
		let off = 0
		for (let p = 0; p < 3; p++) for (let q = p + 1; q < 4; q++) off += matrix[p * 4 + q] * matrix[p * 4 + q]

		if (off <= tolerance) {
			for (let i = 0; i < 4; i++) values[i] = matrix[i * 5]
			return true
		}

		for (let p = 0; p < 3; p++) {
			for (let q = p + 1; q < 4; q++) {
				const apq = matrix[p * 4 + q]
				if (apq === 0) continue

				const app = matrix[p * 5]
				const aqq = matrix[q * 5]
				const theta = (aqq - app) / (2 * apq)
				// Smaller root of t² + 2θt − 1 = 0, the stable rotation of at most 45°.
				const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
				const c = 1 / Math.sqrt(t * t + 1)
				const s = t * c

				for (let k = 0; k < 4; k++) {
					const akp = matrix[k * 4 + p]
					const akq = matrix[k * 4 + q]
					matrix[k * 4 + p] = c * akp - s * akq
					matrix[k * 4 + q] = s * akp + c * akq
				}

				for (let k = 0; k < 4; k++) {
					const apk = matrix[p * 4 + k]
					const aqk = matrix[q * 4 + k]
					matrix[p * 4 + k] = c * apk - s * aqk
					matrix[q * 4 + k] = s * apk + c * aqk
				}

				for (let k = 0; k < 4; k++) {
					const vkp = vectors[k * 4 + p]
					const vkq = vectors[k * 4 + q]
					vectors[k * 4 + p] = c * vkp - s * vkq
					vectors[k * 4 + q] = s * vkp + c * vkq
				}
			}
		}
	}

	return false
}
