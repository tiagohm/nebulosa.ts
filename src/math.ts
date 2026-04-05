export type NumberArray = Float16Array | Float32Array | Float64Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | Uint8ClampedArray | number[]

const SPLITTER = 134217729

// Adds a and b exactly, returning the result as two 64-bit floats.
export function twoSum(a: number, b: number) {
	const x = a + b
	let eb = x - a
	let ea = x - eb
	eb = b - eb
	ea = a - ea
	return [x, ea + eb] as const
}

// Splits a in two aligned parts.
export function split(a: number) {
	const c = SPLITTER * a
	const abig = c - a
	const ah = c - abig
	return [ah, a - ah] as const
}

// Multiplies a and b exactly, returning the result as two 64-bit floats.
// The first is the approximate product (with some floating point error)
// and the second is the error of the product.
export function twoProduct(a: number, b: number) {
	const x = a * b
	const [ah, al] = split(a)
	const [bh, bl] = split(b)
	let y = x - ah * bh
	y -= al * bh
	y -= ah * bl
	return [x, al * bl - y] as const
}

// Computes the Euclidean modulo where the result is always non-negative.
export function pmod(num: number, other: number) {
	const modulo = Math.abs(other)
	const rem = num % modulo
	return rem < 0 ? rem + modulo : rem + 0
}

// Computes the Euclidean modulo where the result is always positive.
export function amod(num: number, other: number) {
	const modulo = Math.abs(other)
	const rem = num % modulo
	return rem <= 0 ? rem + modulo : rem + 0
}

// Returns a Euclidean quotient/remainder pair that satisfies quotient * other + remainder = num.
export function divmod(num: number, other: number) {
	const remainder = pmod(num, other)
	const quotient = roundToNearestWholeNumber((num - remainder) / other)
	return [quotient, remainder] as const
}

// Returns the integer floor of the fractional value (x / y).
export function floorDiv(x: number, y: number) {
	return Math.floor(x / y)
}

// Rounds to the nearest integer using half-away-from-zero semantics.
export function roundToNearestWholeNumber(a: number) {
	return Math.abs(a) < 0.5 ? 0 : a < 0 ? Math.ceil(a - 0.5) : Math.floor(a + 0.5)
}

// Rounds a decimal value to n places using sign-symmetric half-away-from-zero semantics.
export function roundToNthDecimal(a: number, n: number) {
	if (!Number.isFinite(a)) return a

	const factor = 10 ** n

	if (!Number.isFinite(factor)) return a
	if (factor <= 0) return roundToNearestWholeNumber(a * factor)

	const scaled = a * factor
	const correction = Math.abs(scaled) * Number.EPSILON
	return roundToNearestWholeNumber(scaled + (scaled < 0 ? -correction : correction)) / factor
}

// Converts the low 8 bits of num to a signed integer.
export function signed8(num: number) {
	return (num << 24) >> 24
}

// Converts the low 16 bits of num to a signed integer.
export function signed16(num: number) {
	return (num << 16) >> 16
}

// Checks whether two numbers are equal within absolute/relative tolerances.
export function isNearlyEqual(a: number, b: number, relativeTolerance: number = Number.EPSILON, absoluteTolerance: number = Number.EPSILON) {
	if (!Number.isFinite(a) || !Number.isFinite(b)) return a <= b && a >= b

	const tolerance = Math.max(absoluteTolerance, Math.max(Math.abs(a), Math.abs(b)) * relativeTolerance)
	return Math.abs(a - b) <= tolerance
}

// Clamps a number into the inclusive [min, max] range.
export function clamp(value: number, min: number, max: number) {
	if (!(value >= min)) return min // handles NaN value
	if (value > max) return max
	return value
}

// Finds a value at a specific percentage (t) between a start (a) and end (b) point.
// Used widely in game development and graphics to create smooth movements, animations,
// color gradients, and transitions between points.
export function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t
}

// Computes the interpolation factor of value between a and b, returning 0 for nearly degenerate spans.
export function inverseLerp(a: number, b: number, value: number) {
	if (isNearlyEqual(a, b)) return 0
	return (value - a) / (b - a)
}

// Remaps a value from one linear range to another.
export function remap(value: number, inputMin: number, inputMax: number, outputMin: number, outputMax: number) {
	return lerp(outputMin, outputMax, inverseLerp(inputMin, inputMax, value))
}

// Returns the fractional part in the [0, 1) interval.
export function fract(value: number) {
	return pmod(value, 1)
}

// Applies a cubic Hermite interpolation between edges with clamped endpoints.
export function smoothstep(edge0: number, edge1: number, value: number) {
	const t = clamp(inverseLerp(edge0, edge1, value), 0, 1)
	return t * t * (3 - 2 * t)
}

// Separates integer part from fraction
export function modf(n: number) {
	const i = Math.trunc(n)
	const f = Math.abs(n - i)
	return [i, f] as const
}
