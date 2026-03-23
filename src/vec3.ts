import { type Angle, normalizeAngle } from './angle'
import { PI } from './constants'

// Mutable vector of numbers with three axis.
export type MutVec3 = [number, number, number]

// Vector of numbers with three axis.
export type Vec3 = Readonly<MutVec3>

// Computes the scalar product between the vectors.
export function vecDot(a: Vec3, b: Vec3) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// Fills the vector with the given values.
export function vecFill(v: MutVec3, a: number, b: number, c: number): MutVec3 {
	v[0] = a
	v[1] = b
	v[2] = c
	return v
}

// Fills the vector with the given value.
export function vecFillWith(v: MutVec3, value: number): MutVec3 {
	v.fill(value)
	return v
}

// Cross product between the vectors.
export function vecCross(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	const c = a[1] * b[2] - a[2] * b[1]
	const d = a[2] * b[0] - a[0] * b[2]
	const e = a[0] * b[1] - a[1] * b[0]

	if (o) return vecFill(o, c, d, e)
	else return [c, d, e]
}

// Computes the length of the vector.
export function vecLength(v: Vec3) {
	return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

// Computes the distance between the vectors.
export function vecDistance(a: Vec3, b: Vec3) {
	const c = a[0] - b[0]
	const d = a[1] - b[1]
	const e = a[2] - b[2]
	return Math.sqrt(c * c + d * d + e * e)
}

// Creates a new mutable vector from the given vector.
export function vecClone(v: Vec3): MutVec3 {
	return [...v]
}

// Computes the angle between the vectors.
export function vecAngle(a: Vec3, b: Vec3): Angle {
	// https://people.eecs.berkeley.edu/~wkahan/Mindless.pdf
	// const c = mulScalar(a, length(b))
	// const d = mulScalar(b, length(a))
	// return 2 * Math.atan2(length(minus(c, d)), length(plus(c, d)))

	const d = vecDot(a, b)
	const v = d / (vecLength(a) * vecLength(b))
	if (Math.abs(v) > 1) return v < 0 ? PI : 0
	else return Math.acos(v)
}

// Creates a new zeroed vector.
export function vecZero(): MutVec3 {
	return [0, 0, 0]
}

// Creates a new x-axis vector.
export function vecXAxis(): MutVec3 {
	return [1, 0, 0]
}

// Creates a new y-axis vector.
export function vecYAxis(): MutVec3 {
	return [0, 1, 0]
}

// Creates a new z-axis vector.
export function vecZAxis(): MutVec3 {
	return [0, 0, 1]
}

export function vecLatitude(v: Vec3) {
	return Math.acos(v[2])
}

export function vecLongitude(v: Vec3) {
	return normalizeAngle(Math.atan2(v[1], v[0]))
}

// Negates the vector.
export function vecNegate(a: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, -a[0], -a[1], -a[2])
	else return [-a[0], -a[1], -a[2]]
}

// Negates the vector in place.
export function vecNegateMut(a: MutVec3): MutVec3 {
	return vecNegate(a, a)
}

// Computes the sum of the vector by scalar.
export function vecPlusScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] + scalar, a[1] + scalar, a[2] + scalar)
	else return [a[0] + scalar, a[1] + scalar, a[2] + scalar]
}

// Computes the subtraction of the vector by scalar.
export function vecMinusScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] - scalar, a[1] - scalar, a[2] - scalar)
	else return [a[0] - scalar, a[1] - scalar, a[2] - scalar]
}

// Computes the multiplication of the vector by scalar.
export function vecMulScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] * scalar, a[1] * scalar, a[2] * scalar)
	else return [a[0] * scalar, a[1] * scalar, a[2] * scalar]
}

// Computes the division of the vector by scalar.
export function vecDivScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] / scalar, a[1] / scalar, a[2] / scalar)
	else return [a[0] / scalar, a[1] / scalar, a[2] / scalar]
}

// Computes the sum between the vectors.
export function vecPlus(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] + b[0], a[1] + b[1], a[2] + b[2])
	else return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

// Computes the subtraction between the vectors.
export function vecMinus(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] - b[0], a[1] - b[1], a[2] - b[2])
	else return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

// Computes the multiplication between the vectors.
export function vecMul(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] * b[0], a[1] * b[1], a[2] * b[2])
	else return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

// Computes the division between the vectors.
export function vecDiv(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] / b[0], a[1] / b[1], a[2] / b[2])
	else return [a[0] / b[0], a[1] / b[1], a[2] / b[2]]
}

// Normalizes the vector.
export function vecNormalize(v: Vec3, o?: MutVec3): MutVec3 {
	const len = vecLength(v)
	if (len === 0) return o ? vecFill(o, ...v) : vecClone(v)
	else return vecDivScalar(v, len, o)
}

// Normalizes the vector in place.
export function vecNormalizeMut(v: MutVec3): MutVec3 {
	return vecNormalize(v, v)
}

// Efficient algorithm for rotating a vector in space, given an axis and angle of rotation.
export function vecRotateByRodrigues(v: Vec3, axis: Vec3, angle: Angle, o?: MutVec3): MutVec3 {
	const cosa = Math.cos(angle)
	const ax = axis[0]
	const ay = axis[1]
	const az = axis[2]
	const len = Math.sqrt(ax * ax + ay * ay + az * az)

	if (len === 0) {
		return o ? vecFill(o, v[0], v[1], v[2]) : vecClone(v)
	}

	const invLen = 1 / len
	const kx = ax * invLen
	const ky = ay * invLen
	const kz = az * invLen
	const sina = Math.sin(angle)
	const omc = 1 - cosa
	const kv = kx * v[0] + ky * v[1] + kz * v[2]
	const cx = ky * v[2] - kz * v[1]
	const cy = kz * v[0] - kx * v[2]
	const cz = kx * v[1] - ky * v[0]

	return vecFill(o ?? [0, 0, 0], v[0] * cosa + cx * sina + kx * kv * omc, v[1] * cosa + cy * sina + ky * kv * omc, v[2] * cosa + cz * sina + kz * kv * omc)
}

// Obtains the normal vector of the plane defined by three points.
export function vecPlane(a: Vec3, b: Vec3, c: Vec3, o?: MutVec3): MutVec3 {
	const d = vecMinus(b, a, o)
	const e = vecMinus(c, b)
	return vecCross(d, e, o)
}

// Rotates the vector around the x axis.
export function vecRotX(v: Vec3, angle: Angle, o?: MutVec3): MutVec3 {
	const ct = Math.cos(angle)
	const st = Math.sin(angle)
	if (o) return vecFill(o, v[0], ct * v[1] - st * v[2], st * v[1] + ct * v[2])
	else return [v[0], ct * v[1] - st * v[2], st * v[1] + ct * v[2]]
}

// Rotates the vector around the x axis in place.
export function vecRotXMut(v: MutVec3, angle: Angle): MutVec3 {
	return vecRotX(v, angle, v)
}

// Rotates the vector around the y axis.
export function vecRotY(v: Vec3, angle: Angle, o?: MutVec3): MutVec3 {
	const ct = Math.cos(angle)
	const st = Math.sin(angle)
	if (o) return vecFill(o, ct * v[0] + st * v[2], v[1], -st * v[0] + ct * v[2])
	else return [ct * v[0] + st * v[2], v[1], -st * v[0] + ct * v[2]]
}

// Rotates the vector around the y axis in place.
export function vecRotYMut(v: MutVec3, angle: Angle): MutVec3 {
	return vecRotY(v, angle, v)
}

// Rotates the vector around the z axis.
export function vecRotZ(v: Vec3, angle: Angle, o?: MutVec3): MutVec3 {
	const ct = Math.cos(angle)
	const st = Math.sin(angle)
	if (o) return vecFill(o, ct * v[0] - st * v[1], st * v[0] + ct * v[1], v[2])
	else return [ct * v[0] - st * v[1], st * v[0] + ct * v[1], v[2]]
}

// Rotates the vector around the z axis in place.
export function vecRotZMut(v: MutVec3, angle: Angle): MutVec3 {
	return vecRotZ(v, angle, v)
}

// Computes the division of the vector by scalar.
export function vecDivScalarMut(v: MutVec3, scalar: number): MutVec3 {
	return vecDivScalar(v, scalar, v)
}

// Computes the scalar triple product a · (b × c).
export function vecTripleProduct(a: Vec3, b: Vec3, c: Vec3) {
	return a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])
}

// Computes the raw cross product length without allocating.
export function vecCrossLength(a: Vec3, b: Vec3) {
	const x = a[1] * b[2] - a[2] * b[1]
	const y = a[2] * b[0] - a[0] * b[2]
	const z = a[0] * b[1] - a[1] * b[0]
	return Math.hypot(x, y, z)
}
