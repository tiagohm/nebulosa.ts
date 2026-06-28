// Low-level scalar numeric utilities: exact/error-free transforms (twoSum/twoProduct/split) for
// compensated arithmetic, Euclidean modulo/divmod, rounding helpers that stay safe past 2^52,
// bit-width sign extension, tolerant equality, and interpolation/remapping (lerp, smoothstep, ...).

// Any contiguous numeric storage accepted by the array helpers: a typed array or a plain number[].
export type NumberArray = Float16Array | Float32Array | Float64Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | Uint8ClampedArray | number[]

// Dekker splitting constant 2^27 + 1, used to break a double into two non-overlapping halves.
const SPLITTER = 134217729

// Adds a and b exactly, returning [sum, error] such that sum + error == a + b with no rounding loss.
// Writes into `out` (indices 0 and 1) when provided and returns it; otherwise allocates a 2-element array.
export function twoSum(a: number, b: number, out?: NumberArray) {
	const x = a + b
	let eb = x - a
	let ea = x - eb
	eb = b - eb
	ea = a - ea

	if (out === undefined) {
		out = [x, ea + eb]
	} else {
		out[0] = x
		out[1] = ea + eb
	}

	return out
}

// Splits a in two aligned parts.
export function split(a: number) {
	const c = SPLITTER * a
	const abig = c - a
	const ah = c - abig
	return [ah, a - ah] as const
}

// Multiplies finite double values using Dekker splitting.
// Returns [product, error] such that product + error approximates the exact product,
// assuming no overflow/underflow occurs during the split/product operations.
export function twoProduct(a: number, b: number, out?: NumberArray) {
	const x = a * b

	const ca = SPLITTER * a
	const abig = ca - a
	const ah = ca - abig
	const al = a - ah

	const cb = SPLITTER * b
	const bbig = cb - b
	const bh = cb - bbig
	const bl = b - bh

	let y = x - ah * bh
	y -= al * bh
	y -= ah * bl

	if (out === undefined) {
		out = [x, al * bl - y]
	} else {
		out[0] = x
		out[1] = al * bl - y
	}

	return out
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

const TWO_POW_52 = 4503599627370496 // 2 ** 52

// Rounds to the nearest integer with ties going away from zero, leaving non-finite values and values
// at/above 2^52 (which are already integral) untouched.
export function roundToNearestWholeNumber(a: number) {
	if (!Number.isFinite(a)) return a

	const abs = Math.abs(a)

	if (abs < 0.5) return 0

	// At and above 2^52, binary64 numbers have no fractional precision below 1.
	// Adding/subtracting 0.5 can incorrectly change an already integral value.
	if (abs >= TWO_POW_52) return a

	return a < 0 ? Math.ceil(a - 0.5) : Math.floor(a + 0.5)
}

// Rounds `a` to `n` decimal places (ties away from zero), with an epsilon-tolerant half check to
// counter binary representation error. `n` is truncated to an integer; non-finite or precision-exhausted
// inputs are returned unscaled.
export function roundToNthDecimal(a: number, n: number) {
	if (!Number.isFinite(a)) return a
	if (!Number.isInteger(n)) n = Math.trunc(n)

	const factor = 10 ** n

	if (!Number.isFinite(factor)) return a
	if (factor === 0) return 0

	const scaled = a * factor

	if (!Number.isFinite(scaled)) return a

	const abs = Math.abs(scaled)

	// Avoid adding/subtracting 0.5 or epsilon around values where fractional
	// precision is already unavailable or unsafe.
	if (abs >= TWO_POW_52) return scaled / factor

	const sign = scaled < 0 ? -1 : 1
	const floor = Math.floor(abs)
	const fraction = abs - floor

	const tolerance = Math.max(Number.EPSILON, abs * Number.EPSILON)

	if (Math.abs(fraction - 0.5) <= tolerance) {
		return (sign * (floor + 1)) / factor
	}

	return (sign * Math.floor(abs + 0.5)) / factor
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
	if (a === b) return true
	if (!Number.isFinite(a) || !Number.isFinite(b)) return false

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
	const d = b - a
	if (d === 0) return 0
	return (value - a) / d
}

// Remaps a value from one linear range to another.
export function remap(value: number, inputMin: number, inputMax: number, outputMin: number, outputMax: number) {
	const d = inputMax - inputMin
	if (d === 0) return outputMin
	return outputMin + (outputMax - outputMin) * ((value - inputMin) / d)
}

// Returns the fractional part in the [0, 1) interval.
export function fract(value: number) {
	return value - Math.floor(value)
}

// Applies a cubic Hermite interpolation between edges with clamped endpoints.
export function smoothstep(edge0: number, edge1: number, value: number) {
	const t = clamp(inverseLerp(edge0, edge1, value), 0, 1)
	return t * t * (3 - 2 * t)
}
