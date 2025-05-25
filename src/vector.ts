import type { Angle } from './angle'
import { PI } from './constants'

export namespace Vector3 {
	// Vector of numbers with three axis.
	export type Vector = [number, number, number]

	// Computes the scalar product between the vectors.
	export function dot(a: Readonly<Vector>, b: Readonly<Vector>) {
		return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
	}

	// Fills the vector.
	export function fill(v: Vector, a: number, b: number, c: number): Vector {
		v[0] = a
		v[1] = b
		v[2] = c
		return v
	}

	export function fillWith(v: Vector, value: number): Vector {
		v.fill(value)
		return v
	}

	// Cross product between the vectors.
	export function cross(a: Readonly<Vector>, b: Readonly<Vector>, o?: Vector): Vector {
		const c = a[1] * b[2] - a[2] * b[1]
		const d = a[2] * b[0] - a[0] * b[2]
		const e = a[0] * b[1] - a[1] * b[0]

		if (o) return fill(o, c, d, e)
		else return [c, d, e]
	}

	// Computes the length of the vector.
	export function length(v: Readonly<Vector>) {
		return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
	}

	// Computes the distance between the vectors.
	export function distance(a: Readonly<Vector>, b: Readonly<Vector>) {
		const c = a[0] - b[0]
		const d = a[1] - b[1]
		const e = a[2] - b[2]
		return Math.sqrt(c * c + d * d + e * e)
	}

	// Creates a new mutable vector from the given vector.
	export function clone(v: Readonly<Vector>): Vector {
		return [...v]
	}

	// Computes the angle between the vectors.
	export function angle(a: Readonly<Vector>, b: Readonly<Vector>): Angle {
		// https://people.eecs.berkeley.edu/~wkahan/Mindless.pdf
		// const c = mulScalar(a, length(b))
		// const d = mulScalar(b, length(a))
		// return 2 * Math.atan2(length(minus(c, d)), length(plus(c, d)))

		const d = dot(a, b)
		const v = d / (length(a) * length(b))
		if (Math.abs(v) > 1) return v < 0 ? PI : 0
		else return Math.acos(v)
	}

	// Creates a new zeroed vector.
	export function zero(): Vector {
		return [0, 0, 0]
	}

	// Creates a new x-axis vector.
	export function xAxis(): Vector {
		return [1, 0, 0]
	}

	// Creates a new y-axis vector.
	export function yAxis(): Vector {
		return [0, 1, 0]
	}

	// Creates a new z-axis vector.
	export function zAxis(): Vector {
		return [0, 0, 1]
	}

	export function latitude(v: Readonly<Vector>) {
		return Math.acos(v[2])
	}

	export function longitude(v: Readonly<Vector>) {
		return Math.atan2(v[1], v[0])
	}

	// Negates the vector.
	export function negate(a: Readonly<Vector>, o?: Vector): Vector {
		if (o) return fill(o, -a[0], -a[1], -a[2])
		else return [-a[0], -a[1], -a[2]]
	}

	// Computes the sum of the vector by scalar.
	export function plusScalar(a: Readonly<Vector>, scalar: number, o?: Vector): Vector {
		if (o) return fill(o, a[0] + scalar, a[1] + scalar, a[2] + scalar)
		else return [a[0] + scalar, a[1] + scalar, a[2] + scalar]
	}

	// Computes the subtraction of the vector by scalar.
	export function minusScalar(a: Readonly<Vector>, scalar: number, o?: Vector): Vector {
		if (o) return fill(o, a[0] - scalar, a[1] - scalar, a[2] - scalar)
		else return [a[0] - scalar, a[1] - scalar, a[2] - scalar]
	}

	// Computes the multiplication of the vector by scalar.
	export function mulScalar(a: Readonly<Vector>, scalar: number, o?: Vector): Vector {
		if (o) return fill(o, a[0] * scalar, a[1] * scalar, a[2] * scalar)
		else return [a[0] * scalar, a[1] * scalar, a[2] * scalar]
	}

	// Computes the division of the vector by scalar.
	export function divScalar(a: Readonly<Vector>, scalar: number, o?: Vector): Vector {
		if (o) return fill(o, a[0] / scalar, a[1] / scalar, a[2] / scalar)
		else return [a[0] / scalar, a[1] / scalar, a[2] / scalar]
	}

	// Computes the sum between the vectors.
	export function plus(a: Readonly<Vector>, b: Readonly<Vector>, o?: Vector): Vector {
		if (o) return fill(o, a[0] + b[0], a[1] + b[1], a[2] + b[2])
		else return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
	}

	// Computes the subtraction between the vectors.
	export function minus(a: Readonly<Vector>, b: Readonly<Vector>, o?: Vector): Vector {
		if (o) return fill(o, a[0] - b[0], a[1] - b[1], a[2] - b[2])
		else return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
	}

	// Computes the multiplication between the vectors.
	export function mul(a: Readonly<Vector>, b: Readonly<Vector>, o?: Vector): Vector {
		if (o) return fill(o, a[0] * b[0], a[1] * b[1], a[2] * b[2])
		else return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
	}

	// Computes the division between the vectors.
	export function div(a: Readonly<Vector>, b: Readonly<Vector>, o?: Vector): Vector {
		if (o) return fill(o, a[0] / b[0], a[1] / b[1], a[2] / b[2])
		else return [a[0] / b[0], a[1] / b[1], a[2] / b[2]]
	}

	// Normalizes the vector.
	export function normalize(v: Readonly<Vector>, o?: Vector): Vector {
		const len = length(v)
		if (len === 0) return o ? fill(o, ...v) : clone(v)
		else return divScalar(v, len, o)
	}

	// Efficient algorithm for rotating a vector in space, given an axis and angle of rotation.
	export function rotateByRodrigues(v: Readonly<Vector>, axis: Readonly<Vector>, angle: Angle, o?: Vector): Readonly<Vector> {
		const cosa = Math.cos(angle)
		const b = zero()
		const c = zero()
		const k = normalize(axis, o)
		mulScalar(cross(k, v, b), Math.sin(angle), b)
		mulScalar(k, dot(k, v), c)
		plus(mulScalar(v, cosa, k), b, b)
		return plus(b, mulScalar(c, 1 - cosa, c), o)
	}

	export function plane(a: Readonly<Vector>, b: Readonly<Vector>, c: Readonly<Vector>, o?: Vector): Vector {
		const d = minus(b, a, o)
		const e = minus(c, b)
		return cross(d, e, o)
	}
}
