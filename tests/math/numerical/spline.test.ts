import { expect, test } from 'bun:test'
import { akimaSpline, akimaSplineLUT, catmullRomSpline, catmullRomSplineLUT, cubicHermiteSpline, cubicHermiteSplineLUT, linearSpline, naturalCubicSpline, naturalCubicSplineLUT, pchip, spline, splineGivenEnds, type Spline } from '../../../src/math/numerical/spline'

function expectPchipLocallyBounded(s: Pick<Spline, 'compute'>, x: readonly number[], y: readonly number[], samples = 16) {
	for (let i = 0; i < x.length - 1; i++) {
		const lower = Math.min(y[i], y[i + 1]) - 1e-12
		const upper = Math.max(y[i], y[i + 1]) + 1e-12

		for (let j = 0; j <= samples; j++) {
			const t = x[i] + ((x[i + 1] - x[i]) * j) / samples
			const value = s.compute(t)

			expect(Number.isFinite(value)).toBe(true)
			expect(value).toBeGreaterThanOrEqual(lower)
			expect(value).toBeLessThanOrEqual(upper)
		}
	}
}

function expectPchipSampledMonotonic(s: Pick<Spline, 'compute'>, lower: number, upper: number, increasing: boolean, samples = 128) {
	let previous = s.compute(lower)

	for (let i = 1; i <= samples; i++) {
		const value = s.compute(lower + ((upper - lower) * i) / samples)

		if (increasing) expect(value).toBeGreaterThanOrEqual(previous - 1e-12)
		else expect(value).toBeLessThanOrEqual(previous + 1e-12)

		previous = value
	}
}

test('constant', () => {
	const c = Math.random() + 0.5
	const s = spline(0, 1, [c])

	expect(s.compute(8)).toBeCloseTo(c, 15)
})

test('degree 1', () => {
	const s = spline(0, 1, [1, 5])

	expect(s.compute(0.5)).toBeCloseTo(5.5, 15)
})

test('degree 2', () => {
	const s = spline(0, 1, [3, 8, 5])

	expect(s.compute(0.5)).toBeCloseTo(9.75, 15)
})

test('derivative', () => {
	const s = spline(0, 1, [3, 8, 5])
	const d = s.derivative()

	expect(d.coefficients).toHaveLength(2)
	expect(d.coefficients[0]).toBeCloseTo(6, 15)
	expect(d.coefficients[1]).toBeCloseTo(8, 15)
	expect(d.compute(0.5)).toBeCloseTo(11, 15)
})

test('derivative of derivative', () => {
	const s = spline(0, 1, [3, 8, 5])
	const d = s.derivative().derivative()

	expect(d.coefficients).toHaveLength(1)
	expect(d.coefficients[0]).toBeCloseTo(6, 15)
	expect(d.compute(0.5)).toBeCloseTo(6, 15)
})

test('derivative of constant', () => {
	const d = spline(-5, 4, [7]).derivative()

	expect(d.coefficients).toHaveLength(1)
	expect(d.coefficients[0]).toBeCloseTo(0, 15)
	expect(d.compute(2)).toBeCloseTo(0, 15)
})

test('integral', () => {
	const s = spline(2, 6, [3, 8, 5])
	const i = s.integral(-7)

	expect(i.coefficients).toHaveLength(4)
	expect(i.coefficients[0]).toBeCloseTo(4, 15)
	expect(i.coefficients[1]).toBeCloseTo(16, 15)
	expect(i.coefficients[2]).toBeCloseTo(20, 15)
	expect(i.coefficients[3]).toBeCloseTo(-7, 15)
	expect(i.compute(2)).toBeCloseTo(-7, 15)
	expect(i.compute(4)).toBeCloseTo(7.5, 15)
	expect(i.derivative().compute(4)).toBeCloseTo(s.compute(4), 15)
})

test('given ends', () => {
	const s = splineGivenEnds(2, 3, -0.5, 5, 11, 2)
	const d = s.derivative()

	expect(s.compute(2)).toBeCloseTo(3, 15)
	expect(s.compute(5)).toBeCloseTo(11, 15)
	expect(d.compute(2)).toBeCloseTo(-0.5, 15)
	expect(d.compute(5)).toBeCloseTo(2, 15)
})

test('linear spline interpolates and clamps by default', () => {
	const s = linearSpline([0, 1, 2], [0, 10, 20])

	expect(s.compute(-1)).toBeCloseTo(0, 15)
	expect(s.compute(0.5)).toBeCloseTo(5, 15)
	expect(s.compute(1.5)).toBeCloseTo(15, 15)
	expect(s.compute(3)).toBeCloseTo(20, 15)
})

test('linear spline extrapolates when requested', () => {
	const s = linearSpline([0, 1, 2], [0, 10, 20], { extrapolate: true })

	expect(s.compute(-1)).toBeCloseTo(-10, 15)
	expect(s.compute(3)).toBeCloseTo(30, 15)
})

test('cubic Hermite spline interpolates all control points', () => {
	const x = [0, 0.3, 0.7, 1]
	const y = [0, 0.2, 0.8, 1]
	const s = cubicHermiteSpline(x, y)

	expect(s.compute(0)).toBeCloseTo(0, 15)
	expect(s.compute(0.3)).toBeCloseTo(0.2, 15)
	expect(s.compute(0.7)).toBeCloseTo(0.8, 15)
	expect(s.compute(1)).toBeCloseTo(1, 15)
})

test('cubic Hermite LUT preserves a bounded local extremum', () => {
	const lut = cubicHermiteSplineLUT([0, 0.5, 1], [0, 1, 0], 65)

	expect(lut[0]).toBeCloseTo(0, 15)
	expect(lut[32]).toBeCloseTo(1, 15)
	expect(lut[64]).toBeCloseTo(0, 15)

	for (let i = 0; i < lut.length; i++) {
		expect(lut[i]).toBeGreaterThanOrEqual(0)
		expect(lut[i]).toBeLessThanOrEqual(1)
	}
})

test('PCHIP validates input arrays', () => {
	expect(() => pchip([], [])).toThrow('spline requires at least two points')
	expect(() => pchip([0], [1])).toThrow('spline requires at least two points')
	expect(() => pchip([0, 1], [0])).toThrow('spline x and y arrays must have the same length')
	expect(() => pchip([0, Number.POSITIVE_INFINITY], [0, 1])).toThrow('spline control points must be finite')
	expect(() => pchip([0, 1], [0, Number.NaN])).toThrow('spline control points must be finite')
	expect(() => pchip([0, 0, 1], [0, 0.5, 1])).toThrow('spline x coordinates must be strictly increasing')
	expect(() => pchip([0, 1], [0, 1], { outOfRange: 'invalid' as never })).toThrow('pchip outOfRange must be clamp, extrapolate, or throw')
})

test('PCHIP interpolates two points exactly as a line', () => {
	const s = pchip([0, 10], [0, 20])

	expect(s.compute(0)).toBeCloseTo(0, 15)
	expect(s.compute(5)).toBeCloseTo(10, 15)
	expect(s.compute(10)).toBeCloseTo(20, 15)
	expect(s.widths[0]).toBeCloseTo(10, 15)
	expect(s.secants[0]).toBeCloseTo(2, 15)
	expect(s.derivatives[0]).toBeCloseTo(2, 15)
	expect(s.derivatives[1]).toBeCloseTo(2, 15)
	expect(s.x).toBe(s.knots)
	expect(s.y).toBe(s.values)
	expect(s.slopes).toBe(s.derivatives)
})

test('PCHIP preserves monotonic increasing data', () => {
	const x = [0, 1, 2, 3, 4]
	const y = [0, 1, 1.5, 1.8, 2]
	const s = pchip(x, y)

	expectPchipLocallyBounded(s, x, y)
	expectPchipSampledMonotonic(s, 0, 4, true)
})

test('PCHIP preserves monotonic decreasing data', () => {
	const x = [0, 1, 2, 3]
	const y = [5, 3, 2, 1]
	const s = pchip(x, y)

	expectPchipLocallyBounded(s, x, y)
	expectPchipSampledMonotonic(s, 0, 3, false)
})

test('PCHIP keeps plateaus flat', () => {
	const x = [0, 1, 2, 3, 4]
	const y = [0, 1, 1, 1, 2]
	const s = pchip(x, y)

	expect(s.derivatives[1]).toBeCloseTo(0, 15)
	expect(s.derivatives[2]).toBeCloseTo(0, 15)
	expect(s.derivatives[3]).toBeCloseTo(0, 15)

	for (let i = 0; i <= 16; i++) {
		expect(s.compute(1 + i / 8)).toBeCloseTo(1, 15)
	}

	expectPchipLocallyBounded(s, x, y)
	expectPchipSampledMonotonic(s, 0, 4, true)
})

test('PCHIP handles non-uniform spacing', () => {
	const x = [0, 0.1, 1.5, 2, 10]
	const y = [0, 0.2, 0.8, 0.9, 1]
	const s = pchip(x, y)

	expectPchipLocallyBounded(s, x, y)
	expectPchipSampledMonotonic(s, 0, 10, true, 256)
})

test('PCHIP keeps mixed non-monotonic intervals locally bounded', () => {
	const x = [0, 1, 2, 3, 4]
	const y = [0, 2, 1, 3, 2]
	const s = pchip(x, y)

	expect(s.derivatives[1]).toBeCloseTo(0, 15)
	expect(s.derivatives[2]).toBeCloseTo(0, 15)
	expect(s.derivatives[3]).toBeCloseTo(0, 15)
	expectPchipLocallyBounded(s, x, y)
})

test('PCHIP returns exact knot values', () => {
	const x = [0, 0.1, 1.5, 2, 10]
	const y = [0, 0.2, 0.8, 0.9, 1]
	const s = pchip(x, y)

	for (let i = 0; i < x.length; i++) {
		expect(s.compute(x[i])).toBeCloseTo(y[i], 15)
	}
})

test('PCHIP boundary behavior is explicit', () => {
	const clamped = pchip([0, 10], [0, 20])
	const extrapolated = pchip([0, 10], [0, 20], { outOfRange: 'extrapolate' })
	const thrown = pchip([0, 10], [0, 20], { outOfRange: 'throw' })
	const booleanExtrapolated = pchip([0, 10], [0, 20], true)

	expect(clamped.compute(-5)).toBeCloseTo(0, 15)
	expect(clamped.compute(15)).toBeCloseTo(20, 15)
	expect(extrapolated.compute(-5)).toBeCloseTo(-10, 15)
	expect(extrapolated.compute(15)).toBeCloseTo(30, 15)
	expect(booleanExtrapolated.compute(15)).toBeCloseTo(30, 15)
	expect(() => thrown.compute(-1)).toThrow('pchip value is outside interpolation range')
})

test('Akima spline interpolates all control points', () => {
	const x = [0, 0.2, 0.5, 0.8, 1]
	const y = [0, 0.3, 0.1, 0.9, 1]
	const s = akimaSpline(x, y)

	expect(s.compute(0)).toBeCloseTo(0, 15)
	expect(s.compute(0.2)).toBeCloseTo(0.3, 15)
	expect(s.compute(0.5)).toBeCloseTo(0.1, 15)
	expect(s.compute(0.8)).toBeCloseTo(0.9, 15)
	expect(s.compute(1)).toBeCloseTo(1, 15)
})

test('Akima LUT interpolates exact control-point samples', () => {
	const lut = akimaSplineLUT([0, 0.5, 1], [0, 1, 0], 65)

	expect(lut[0]).toBeCloseTo(0, 15)
	expect(lut[32]).toBeCloseTo(1, 15)
	expect(lut[64]).toBeCloseTo(0, 15)
	expect(lut[31]).toBeLessThanOrEqual(1)
	expect(lut[33]).toBeLessThanOrEqual(1)
})

test('Catmull-Rom spline interpolates all control points', () => {
	const x = [0, 0.2, 0.5, 0.8, 1]
	const y = [0, 0.3, 0.1, 0.9, 1]
	const s = catmullRomSpline(x, y)

	expect(s.compute(0)).toBeCloseTo(0, 15)
	expect(s.compute(0.2)).toBeCloseTo(0.3, 15)
	expect(s.compute(0.5)).toBeCloseTo(0.1, 15)
	expect(s.compute(0.8)).toBeCloseTo(0.9, 15)
	expect(s.compute(1)).toBeCloseTo(1, 15)
})

test('Catmull-Rom LUT interpolates exact control-point samples', () => {
	const lut = catmullRomSplineLUT([0, 0.5, 1], [0, 1, 0], 65)

	expect(lut[0]).toBeCloseTo(0, 15)
	expect(lut[32]).toBeCloseTo(1, 15)
	expect(lut[64]).toBeCloseTo(0, 15)
})

test('natural cubic spline reproduces a straight line exactly', () => {
	const s = naturalCubicSpline([0, 0.3, 0.7, 1], [0, 0.3, 0.7, 1])

	expect(s.compute(0.15)).toBeCloseTo(0.15, 12)
	expect(s.compute(0.5)).toBeCloseTo(0.5, 12)
	expect(s.compute(0.9)).toBeCloseTo(0.9, 12)
})

test('natural cubic spline extrapolates when requested', () => {
	const clamped = naturalCubicSpline([0, 1, 2], [0, 1, 0])
	const extrapolated = naturalCubicSpline([0, 1, 2], [0, 1, 0], { extrapolate: true })

	expect(clamped.compute(-1)).toBeCloseTo(0, 15)
	expect(clamped.compute(3)).toBeCloseTo(0, 15)
	expect(extrapolated.compute(-1)).toBeCloseTo(-1, 15)
	expect(extrapolated.compute(3)).toBeCloseTo(-1, 15)
})

test('natural cubic LUT interpolates exact control-point samples', () => {
	const lut = naturalCubicSplineLUT([0, 0.5, 1], [0, 1, 0], 65)

	expect(lut[0]).toBeCloseTo(0, 15)
	expect(lut[32]).toBeCloseTo(1, 15)
	expect(lut[64]).toBeCloseTo(0, 15)
})

test('every interpolating spline reproduces a straight line', () => {
	const x = [0, 1, 2, 3, 4]
	const y = x.map((xi) => 2 * xi + 1)

	for (const make of [cubicHermiteSpline, akimaSpline, catmullRomSpline, naturalCubicSpline, pchip]) {
		const s = make(x, y)
		for (const probe of [0.5, 1.5, 2.5, 3.5]) {
			expect(s.compute(probe)).toBeCloseTo(2 * probe + 1, 10)
		}
	}
})

test('invalid input', () => {
	expect(() => spline(1, 1, [2])).toThrow('spline interval must have a finite non-zero width')
	expect(() => spline(0, 1, [])).toThrow('spline requires at least one coefficient')
	expect(() => linearSpline([0, 1], [0])).toThrow('spline x and y arrays must have the same length')
	expect(() => linearSpline([0, 0, 1], [0, 0.5, 1])).toThrow('spline x coordinates must be strictly increasing')
	expect(() => cubicHermiteSpline([0, 1], [0])).toThrow('spline x and y arrays must have the same length')
	expect(() => cubicHermiteSpline([0, 0, 1], [0, 0.5, 1])).toThrow('spline x coordinates must be strictly increasing')
	expect(() => cubicHermiteSplineLUT([0, 1], [0, 1], 1)).toThrow('spline LUT size must be at least two')
	expect(() => akimaSpline([0, 1], [0])).toThrow('spline x and y arrays must have the same length')
	expect(() => akimaSpline([0, 0, 1], [0, 0.5, 1])).toThrow('spline x coordinates must be strictly increasing')
	expect(() => akimaSplineLUT([0, 1], [0, 1], 1)).toThrow('spline LUT size must be at least two')
	expect(() => catmullRomSpline([0, 1], [0])).toThrow('spline x and y arrays must have the same length')
	expect(() => catmullRomSpline([0, 0, 1], [0, 0.5, 1])).toThrow('spline x coordinates must be strictly increasing')
	expect(() => catmullRomSplineLUT([0, 1], [0, 1], 1)).toThrow('spline LUT size must be at least two')
	expect(() => naturalCubicSpline([0, 1], [0])).toThrow('spline x and y arrays must have the same length')
	expect(() => naturalCubicSpline([0, 0, 1], [0, 0.5, 1])).toThrow('spline x coordinates must be strictly increasing')
	expect(() => naturalCubicSplineLUT([0, 1], [0, 1], 1)).toThrow('spline LUT size must be at least two')
})
