import { expect, test } from 'bun:test'
import { akimaSpline, akimaSplineLUT, catmullRomSpline, catmullRomSplineLUT, cubicHermiteSpline, cubicHermiteSplineLUT, naturalCubicSpline, naturalCubicSplineLUT, spline, splineGivenEnds } from '../src/spline'

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

test('natural cubic LUT interpolates exact control-point samples', () => {
	const lut = naturalCubicSplineLUT([0, 0.5, 1], [0, 1, 0], 65)

	expect(lut[0]).toBeCloseTo(0, 15)
	expect(lut[32]).toBeCloseTo(1, 15)
	expect(lut[64]).toBeCloseTo(0, 15)
})

test('invalid input', () => {
	expect(() => spline(1, 1, [2])).toThrow('spline interval must have a finite non-zero width')
	expect(() => spline(0, 1, [])).toThrow('spline requires at least one coefficient')
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
