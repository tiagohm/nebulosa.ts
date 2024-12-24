// Adds a and b exactly, returning the result as two 64-bit floats.
export function twoSum(a: number, b: number): [number, number] {
	const x = a + b
	let eb = x - a
	let ea = x - eb
	eb = b - eb
	ea = a - ea
	return [x, ea + eb]
}

// Splits a in two aligned parts.
export function split(a: number): [number, number] {
	const c = 134217729 * a
	const abig = c - a
	const ah = c - abig
	return [ah, a - ah]
}

// Multiples a and b exactly, returning the result as two 64-bit floats.
// The first is the approximate product (with some floating point error)
// and the second is the error of the product.
export function twoProduct(a: number, b: number): [number, number] {
	const x = a * b
	const [ah, al] = split(a)
	const [bh, bl] = split(b)
	let y = x - ah * bh
	y -= al * bh
	y -= ah * bl
	return [x, al * bl - y]
}

// Computes the modulo where the result is always non-negative.
export function pmod(num: number, other: number): number {
	const rem = num % other
	return rem < 0 ? rem + other : rem
}

// Returns a pair containing the quotient and the remainder when given num is divided by other.
export function divmod(num: number, other: number): [number, number] {
	return [Math.trunc(num / other), pmod(num, other)]
}

export function roundToNearestWholeNumber(a: number): number {
	return (
		Math.abs(a) < 0.5 ? 0
		: a < 0 ? Math.ceil(a - 0.5)
		: Math.floor(a + 0.5)
	)
}
