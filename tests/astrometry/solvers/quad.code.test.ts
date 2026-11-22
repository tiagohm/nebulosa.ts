import { describe, expect, test } from 'bun:test'
import { canonicalizeQuadCode, dequantizeQuadCodeComponent, flipQuadCodeParity, forEachQuadCodeVariant, insideQuadCircle, type MutQuadCode, type MutQuadStars, planarQuadCode, QUAD_CODE_MAX, QUAD_CODE_MIN, quadCode, quantizeQuadCodeComponent, skyQuadCode } from '../../../src/astrometry/solvers/quad.code'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { mulberry32 } from '../../../src/math/numerical/random'

function expectCode(actual: readonly number[], expected: readonly number[], digits: number = 12) {
	for (let i = 0; i < 4; i++) expect(actual[i]).toBeCloseTo(expected[i], digits)
}

describe('planar code', () => {
	test('maps A to the origin and B to (1, 1)', () => {
		expectCode(planarQuadCode(0, 0, 1, 1, 1, 0, 0, 1), [1, 0, 0, 1])
		expectCode(planarQuadCode(0, 0, 1, 1, 0.5, 0.5, 0.25, 0.75), [0.5, 0.5, 0.25, 0.75])
	})

	test('is invariant to translation, rotation and uniform scale', () => {
		const random = mulberry32(7)
		const xs = [0, 10, 4, 7]
		const ys = [0, 2, 3, -1]
		const reference = planarQuadCode(xs[0], ys[0], xs[1], ys[1], xs[2], ys[2], xs[3], ys[3])

		for (let k = 0; k < 20; k++) {
			const angle = random() * 6.28
			const scale = 0.01 + random() * 100
			const tx = random() * 1000 - 500
			const ty = random() * 1000 - 500
			const cos = Math.cos(angle) * scale
			const sin = Math.sin(angle) * scale
			const x = (i: number) => xs[i] * cos - ys[i] * sin + tx
			const y = (i: number) => xs[i] * sin + ys[i] * cos + ty
			expectCode(planarQuadCode(x(0), y(0), x(1), y(1), x(2), y(2), x(3), y(3)), reference, 9)
		}
	})

	test('a mirror image swaps x and y of C and D', () => {
		const code = planarQuadCode(0, 0, 10, 2, 4, 3, 7, -1)
		const mirrored = planarQuadCode(0, 0, 2, 10, 3, 4, -1, 7)
		expectCode(mirrored, flipQuadCodeParity(code))
	})
})

describe('sky code', () => {
	test('uses north as the code x axis and east as its y axis, as Astrometry.net', () => {
		// A at the origin, B 1 mrad north and 1 mrad east, C 1 mrad north only, D 1 mrad east only.
		const e = 1e-6
		const a = eraS2c(0, 0)
		const b = eraS2c(e, e)
		const c = eraS2c(0, e)
		const d = eraS2c(e, 0)
		const code = quadCode()
		expect(skyQuadCode(a, b, c, d, code)).toBeTrue()
		expectCode(code, [1, 0, 0, 1], 6)
	})

	test('matches the planar code of the projected quad', () => {
		const a = eraS2c(1, 0.5)
		const b = eraS2c(1.01, 0.505)
		const c = eraS2c(1.004, 0.503)
		const d = eraS2c(1.007, 0.501)
		const code = quadCode()
		expect(skyQuadCode(a, b, c, d, code)).toBeTrue()
		expect(insideQuadCircle(code[0], code[1])).toBeTrue()
		expect(insideQuadCircle(code[2], code[3])).toBeTrue()
	})

	test('refuses a star on the far hemisphere', () => {
		const a = eraS2c(0, 0)
		const b = eraS2c(0.01, 0)
		const far = eraS2c(Math.PI, 0)
		expect(skyQuadCode(a, b, far, far, quadCode())).toBeFalse()
	})

	test('is defined at the pole', () => {
		const a = eraS2c(0, Math.PI / 2 - 0.001)
		const b = eraS2c(Math.PI, Math.PI / 2 - 0.001)
		const c = eraS2c(Math.PI / 2, Math.PI / 2 - 0.0005)
		const d = eraS2c(-Math.PI / 2, Math.PI / 2 - 0.0005)
		const code = quadCode()
		expect(skyQuadCode(a, b, c, d, code)).toBeTrue()
		for (const value of code) expect(Number.isFinite(value)).toBeTrue()
	})
})

describe('canonical form', () => {
	test('enforces mean(cx, dx) <= 1/2 and cx <= dx with the star labels', () => {
		const code: MutQuadCode = [0.9, 0.2, 0.6, 0.7]
		const stars: MutQuadStars = [10, 11, 12, 13]
		canonicalizeQuadCode(code, stars)
		expectCode(code, [0.1, 0.8, 0.4, 0.3])
		expect(stars).toEqual([11, 10, 12, 13])

		const swapped: MutQuadCode = [0.4, 0.3, 0.1, 0.8]
		const labels: MutQuadStars = [1, 2, 3, 4]
		canonicalizeQuadCode(swapped, labels)
		expectCode(swapped, [0.1, 0.8, 0.4, 0.3])
		expect(labels).toEqual([1, 2, 4, 3])
	})

	test('every labeling of a quad reaches the canonical code among its variants', () => {
		const xs = [0, 10, 4, 7]
		const ys = [0, 2, 3, -1]
		const canonical = planarQuadCode(xs[0], ys[0], xs[1], ys[1], xs[2], ys[2], xs[3], ys[3])
		const canonicalStars: MutQuadStars = [0, 1, 2, 3]
		canonicalizeQuadCode(canonical, canonicalStars)

		const orders = [
			[0, 1, 2, 3],
			[1, 0, 2, 3],
			[0, 1, 3, 2],
			[1, 0, 3, 2],
		]

		for (const [a, b, c, d] of orders) {
			const code = planarQuadCode(xs[a], ys[a], xs[b], ys[b], xs[c], ys[c], xs[d], ys[d])
			let found = false

			forEachQuadCodeVariant(code, [a, b, c, d], 0.01, false, (variant) => {
				if (variant.stars.every((s, i) => s === canonicalStars[i])) {
					expectCode(variant.code, canonical)
					found = true
				}
			})

			expect(found).toBeTrue()
		}
	})

	test('unknown parity also yields the mirrored codes', () => {
		const code = planarQuadCode(0, 0, 10, 2, 4, 3, 7, -1)
		let normal = 0
		let flipped = 0
		forEachQuadCodeVariant(code, [0, 1, 2, 3], 0.01, undefined, (variant) => (variant.flipped ? flipped++ : normal++))
		expect(normal).toBeGreaterThan(0)
		expect(flipped).toBeGreaterThan(0)
	})
})

test('quantization round trip stays below the code resolution', () => {
	for (const value of [QUAD_CODE_MIN, 0, 0.123456, 0.5, 1, QUAD_CODE_MAX]) {
		expect(Math.abs(dequantizeQuadCodeComponent(quantizeQuadCodeComponent(value)) - value)).toBeLessThan(1.1e-5)
	}

	expect(quantizeQuadCodeComponent(-1)).toBe(0)
	expect(quantizeQuadCodeComponent(2)).toBe(65535)
})
