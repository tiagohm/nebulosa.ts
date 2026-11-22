import type { Vec3 } from '../../math/linear-algebra/vec3'

// Geometric-hash code of a four-star quad, bit-compatible with Astrometry.net (solver/quad-utils.c, BSD-3, re-implemented).
// Stars A and B are the backbone: the similarity that maps A to (0, 0) and B to (1, 1) carries C and D to
// (cx, cy) and (dx, dy), the 4-dimensional code, which is invariant to translation, rotation and uniform scale.
// In complex form, w(z) = (z - zA)·(1 + i)/(zB - zA). On the image z is the pixel position (x + iy); on the
// sky z is the gnomonic projection around the normalized midpoint of A and B with the north offset as the real
// part and the east offset as the imaginary part, the axis order Astrometry.net's star_coords produces, so a
// quad yields the same code here and in its index files. A mirror image swaps x and y of every code point.
// The canonical form keeps mean(cx, dx) <= 1/2 and cx <= dx. Astrometry.net's widest indexes use three-star patterns
// (DIMQUADS = 3), whose code is (cx, cy) alone with cx <= 1/2; the last two components are then unused. Codes are
// dimensionless; projections are radians.

// Number of stars in a quad.
export const QUAD_STARS = 4

// Number of code components: (cx, cy, dx, dy).
export const QUAD_CODE_DIMENSION = 4

// Default code-space matching tolerance, in units of |AB| (Astrometry.net's codetol).
export const DEFAULT_QUAD_CODE_TOLERANCE = 0.01

// Margin factor on the code tolerance for the canonical-form checks of a field code (Astrometry.net's cxdx_margin = 1.5·codetol).
export const QUAD_CODE_INVARIANT_MARGIN = 1.5

// Smallest code component of a valid quad: C and D lie in the circle of center (1/2, 1/2) and radius 1/sqrt(2).
export const QUAD_CODE_MIN = 0.5 - Math.SQRT1_2

// Largest code component of a valid quad.
export const QUAD_CODE_MAX = 0.5 + Math.SQRT1_2

// Scale from a code component to its unsigned 16-bit quantized value over [QUAD_CODE_MIN, QUAD_CODE_MAX].
export const QUAD_CODE_QUANTIZATION = 65535 / (QUAD_CODE_MAX - QUAD_CODE_MIN)

// A quad code (cx, cy, dx, dy).
export type MutQuadCode = [number, number, number, number]

// A read-only quad code (cx, cy, dx, dy).
export type QuadCode = Readonly<MutQuadCode>

// Star indices of a quad in code order (A, B, C, D); D is -1 for a three-star pattern (a triangle).
export type MutQuadStars = [number, number, number, number]

// Read-only star indices of a quad in code order (A, B, C, D).
export type QuadStars = Readonly<MutQuadStars>

// Allocates a zeroed quad code.
export function quadCode(): MutQuadCode {
	return [0, 0, 0, 0]
}

// Computes the code of a planar quad from the positions of A, B, C and D in any consistent unit.
// Writes into out and returns it; the result is undefined (NaN) when A and B coincide.
export function planarQuadCode(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, out: MutQuadCode = quadCode()): MutQuadCode {
	const abx = bx - ax
	const aby = by - ay
	const scale = abx * abx + aby * aby
	const cos = (aby + abx) / scale
	const sin = (aby - abx) / scale
	const acx = cx - ax
	const acy = cy - ay
	const adx = dx - ax
	const ady = dy - ay
	out[0] = acx * cos + acy * sin
	out[1] = -acx * sin + acy * cos
	out[2] = adx * cos + ady * sin
	out[3] = -adx * sin + ady * cos
	return out
}

// Gnomonic projection of the unit vector s around the unit vector r, as Astrometry.net's star_coords with tangent
// projection: out[0] is the east offset and out[1] the north offset, in radians on the tangent plane.
// Returns false, leaving out untouched, when s lies on the far hemisphere of r.
export function starCoordinates(s: Vec3, r: Vec3, out: [number, number]) {
	const sdotr = s[0] * r[0] + s[1] * r[1] + s[2] * r[2]
	if (sdotr <= 0) return false

	if (r[2] === 1) {
		out[0] = s[0] / s[2]
		out[1] = s[1] / s[2]
	} else if (r[2] === -1) {
		out[0] = -s[0] / s[2]
		out[1] = s[1] / s[2]
	} else {
		const norm = Math.hypot(r[0], r[1])
		const etax = -r[1] / norm
		const etay = r[0] / norm
		const xix = -r[2] * etay
		const xiy = r[2] * etax
		const xiz = r[0] * etay - r[1] * etax
		out[0] = (s[0] * etax + s[1] * etay) / sdotr
		out[1] = (s[0] * xix + s[1] * xiy + s[2] * xiz) / sdotr
	}

	return true
}

// Scratch projection buffers for skyQuadCode; never escape the function.
const SKY_A: [number, number] = [0, 0]
const SKY_B: [number, number] = [0, 0]
const SKY_C: [number, number] = [0, 0]
const SKY_D: [number, number] = [0, 0]
const SKY_MID: [number, number, number] = [0, 0, 0]

// Computes the code of a sky quad from the ICRS unit vectors of A, B, C and D. Writes into out and returns
// true, or returns false when a star lies on the far hemisphere of the AB midpoint.
export function skyQuadCode(a: Vec3, b: Vec3, c: Vec3, d: Vec3, out: MutQuadCode) {
	const mx = a[0] + b[0]
	const my = a[1] + b[1]
	const mz = a[2] + b[2]
	const length = Math.hypot(mx, my, mz)
	SKY_MID[0] = mx / length
	SKY_MID[1] = my / length
	SKY_MID[2] = mz / length

	if (!starCoordinates(a, SKY_MID, SKY_A) || !starCoordinates(b, SKY_MID, SKY_B) || !starCoordinates(c, SKY_MID, SKY_C) || !starCoordinates(d, SKY_MID, SKY_D)) return false

	// Astrometry.net reads star_coords into (y, x): the north offset is the code x axis, the east offset its y axis.
	planarQuadCode(SKY_A[1], SKY_A[0], SKY_B[1], SKY_B[0], SKY_C[1], SKY_C[0], SKY_D[1], SKY_D[0], out)
	return true
}

// Whether the code point (x, y) lies in the circle whose diameter is AB, widened by slack (0 for the index
// side, tolerance·(sqrt(2) + tolerance) for the field side).
export function insideQuadCircle(x: number, y: number, slack: number = 0) {
	return x * x - x + y * y - y <= slack
}

// Puts a code and its star labels in canonical form in place, as Astrometry.net's quad_enforce_invariants: when
// mean(cx, dx) > 1/2 it swaps A and B and rotates the code by 180° (v -> 1 - v), then it orders C and D so that
// cx <= dx. Both arrays are mutated.
export function canonicalizeQuadCode(code: MutQuadCode, stars: MutQuadStars) {
	if ((code[0] + code[2]) / 2 > 0.5) {
		const a = stars[0]
		stars[0] = stars[1]
		stars[1] = a
		code[0] = 1 - code[0]
		code[1] = 1 - code[1]
		code[2] = 1 - code[2]
		code[3] = 1 - code[3]
	}

	if (code[2] < code[0]) {
		const c = stars[2]
		stars[2] = stars[3]
		stars[3] = c
		const x = code[0]
		const y = code[1]
		code[0] = code[2]
		code[1] = code[3]
		code[2] = x
		code[3] = y
	}
}

// Mirrors a code (parity flip) by swapping x and y of C and D. out may alias code.
export function flipQuadCodeParity(code: QuadCode, out: MutQuadCode = quadCode()): MutQuadCode {
	const cx = code[0]
	const dx = code[2]
	out[0] = code[1]
	out[1] = cx
	out[2] = code[3]
	out[3] = dx
	return out
}

// One labeling of a field quad that may match a canonical index code: the code and the field stars in A, B, C, D order.
export interface QuadCodeVariant {
	// Code of this labeling.
	readonly code: MutQuadCode
	// Field star indices in A, B, C, D order.
	readonly stars: MutQuadStars
	// Whether the code was mirrored.
	readonly flipped: boolean
}

// Enumerates the labelings of a field quad whose code can match a canonical index code within tolerance, as
// Astrometry.net's try_all_codes: the given and the swapped backbone (v -> 1 - v), both orders of C and D, and,
// when parity is unknown, the mirrored code of each. A labeling is kept when cx <= 1/2 + m, cx <= dx + m and
// mean(cx, dx) <= 1/2 + m, with m = 1.5·tolerance. A triangle (stars[3] = -1) has no D and keeps cx <= 1/2 + m only. The code is the field code of stars (A, B, C, D); parity
// selects the normal (false), mirrored (true) or both (undefined) codes. visit is called once per labeling;
// its arguments are reused between calls and must not be retained.
export function forEachQuadCodeVariant(code: QuadCode, stars: QuadStars, tolerance: number, parity: boolean | undefined, visit: (variant: QuadCodeVariant) => void) {
	const margin = QUAD_CODE_INVARIANT_MARGIN * tolerance

	if (parity !== true) forEachBackbone(code, stars, margin, false, visit)

	if (parity !== false) {
		flipQuadCodeParity(code, VARIANT_FLIPPED)
		forEachBackbone(VARIANT_FLIPPED, stars, margin, true, visit)
	}
}

// Scratch state of forEachQuadCodeVariant; reused between calls.
const VARIANT_FLIPPED = quadCode()
const VARIANT_BACKBONE = quadCode()
const VARIANT: { code: MutQuadCode; stars: MutQuadStars; flipped: boolean } = { code: quadCode(), stars: [0, 0, 0, 0], flipped: false }

// Tries both backbone orientations of a code.
function forEachBackbone(code: QuadCode, stars: QuadStars, margin: number, flipped: boolean, visit: (variant: QuadCodeVariant) => void) {
	forEachInnerOrder(code, stars[0], stars[1], stars[2], stars[3], margin, flipped, visit)

	VARIANT_BACKBONE[0] = 1 - code[0]
	VARIANT_BACKBONE[1] = 1 - code[1]
	VARIANT_BACKBONE[2] = 1 - code[2]
	VARIANT_BACKBONE[3] = 1 - code[3]
	forEachInnerOrder(VARIANT_BACKBONE, stars[1], stars[0], stars[2], stars[3], margin, flipped, visit)
}

// Tries both orders of C and D under the canonical-form margins.
function forEachInnerOrder(code: QuadCode, a: number, b: number, c: number, d: number, margin: number, flipped: boolean, visit: (variant: QuadCodeVariant) => void) {
	if (d < 0) {
		// A triangle: one inner star, so the canonical form only bounds cx.
		if (code[0] <= 0.5 + margin) emitVariant(code[0], code[1], 0, 0, a, b, c, -1, Infinity, flipped, visit)
		return
	}

	emitVariant(code[0], code[1], code[2], code[3], a, b, c, d, margin, flipped, visit)
	emitVariant(code[2], code[3], code[0], code[1], a, b, d, c, margin, flipped, visit)
}

// Emits one labeling when it passes the canonical-form margins.
function emitVariant(cx: number, cy: number, dx: number, dy: number, a: number, b: number, c: number, d: number, margin: number, flipped: boolean, visit: (variant: QuadCodeVariant) => void) {
	if (cx > 0.5 + margin || cx > dx + margin || (cx + dx) / 2 > 0.5 + margin) return

	const variant = VARIANT
	variant.code[0] = cx
	variant.code[1] = cy
	variant.code[2] = dx
	variant.code[3] = dy
	variant.stars[0] = a
	variant.stars[1] = b
	variant.stars[2] = c
	variant.stars[3] = d
	variant.flipped = flipped
	visit(variant)
}

// Quantizes a code component to an unsigned 16-bit integer over [QUAD_CODE_MIN, QUAD_CODE_MAX], clamping outside values.
export function quantizeQuadCodeComponent(value: number) {
	const q = Math.round((value - QUAD_CODE_MIN) * QUAD_CODE_QUANTIZATION)
	return Math.max(0, Math.min(65535, q))
}

// Restores a code component from its 16-bit quantized value.
export function dequantizeQuadCodeComponent(value: number) {
	return value / QUAD_CODE_QUANTIZATION + QUAD_CODE_MIN
}
