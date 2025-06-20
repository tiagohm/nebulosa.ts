import type { NumberArray } from './math'

export class Vector {
	readonly data: NumberArray

	constructor(data: number | NumberArray, copy: boolean = true) {
		this.data = typeof data === 'number' ? new Float64Array(data) : copy ? new Float64Array(data) : data
	}

	get size() {
		return this.data.length
	}

	get length() {
		let sum = 0
		for (let i = 0; i < this.size; i++) sum += this.data[i] * this.data[i]
		return Math.sqrt(sum)
	}

	get normalized() {
		return this.clone().normalize()
	}

	get(index: number) {
		return this.data[index]
	}

	set(index: number, value: number) {
		this.data[index] = value
	}

	// Clones the vector, returning a new instance with the same data
	clone() {
		return new Vector(this.data)
	}

	// Normalizes the vector in place
	normalize(): this {
		const length = this.length
		if (length === 0) return this
		for (let i = 0; i < this.size; i++) this.data[i] /= length
		return this
	}

	// Computes the dot product of this vector with another vector
	dot(other: Vector) {
		if (this.size < other.size) throw new Error('vectors must be of the same size')
		let sum = 0
		for (let i = 0; i < this.size; i++) sum += this.data[i] * other.data[i]
		return sum
	}

	// Computes the cross product of this vector with another vector
	cross(other: Vector): Vector {
		if (this.size !== 3 || other.size !== 3) throw new Error('cross product is only defined for 3D vectors')

		const data = new Float64Array(3)
		data[0] = this.data[1] * other.data[2] - this.data[2] * other.data[1]
		data[1] = this.data[2] * other.data[0] - this.data[0] * other.data[2]
		data[2] = this.data[0] * other.data[1] - this.data[1] * other.data[0]
		return new Vector(data, false)
	}

	// Sums another vector to this vector in place
	plus(other: Vector): this {
		if (this.size !== other.size) throw new Error('vectors must be of the same size')
		for (let i = 0; i < this.size; i++) this.data[i] += other.data[i]
		return this
	}

	// Subtracts another vector to this vector in place
	minus(other: Vector): this {
		if (this.size !== other.size) throw new Error('vectors must be of the same size')
		for (let i = 0; i < this.size; i++) this.data[i] -= other.data[i]
		return this
	}

	// Sums this vector by another vector in place
	plusScalar(scalar: number): this {
		for (let i = 0; i < this.size; i++) this.data[i] += scalar
		return this
	}

	// Subtracts a scalar from this vector in place
	minusScalar(scalar: number): this {
		for (let i = 0; i < this.size; i++) this.data[i] -= scalar
		return this
	}

	// Multiplies this vector by a scalar in place
	mulScalar(scalar: number): this {
		for (let i = 0; i < this.size; i++) this.data[i] *= scalar
		return this
	}

	// Divides this vector by a scalar in place
	divScalar(scalar: number): this {
		if (scalar === 0) throw new Error('division by zero')
		for (let i = 0; i < this.size; i++) this.data[i] /= scalar
		return this
	}

	static x(size: number = 3) {
		const data = new Float64Array(size)
		data[0] = 1
		return new Vector(data, false)
	}

	static y(size: number = 3) {
		const data = new Float64Array(size)
		data[1] = 1
		return new Vector(data, false)
	}

	static z(size: number = 3) {
		const data = new Float64Array(size)
		data[2] = 1
		return new Vector(data, false)
	}
}
