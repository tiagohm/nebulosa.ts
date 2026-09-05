import { expect, test } from 'bun:test'
import { TAU } from '../../../src/core/constants'
import { ellipseFromConic, fitEllipse } from '../../../src/math/numerical/ellipse.fit'
import type { EllipseGeometry } from '../../../src/math/numerical/ellipse.geometry'

function points(ellipse: EllipseGeometry, count = 120, span = TAU) {
	const x = new Float64Array(count)
	const y = new Float64Array(count)
	const c = Math.cos(ellipse.theta)
	const s = Math.sin(ellipse.theta)
	for (let i = 0; i < count; i++) {
		const u = ellipse.semiMajor * Math.cos((i * span) / count)
		const v = ellipse.semiMinor * Math.sin((i * span) / count)
		x[i] = ellipse.center.x + c * u - s * v
		y[i] = ellipse.center.y + s * u + c * v
	}
	return { x, y }
}

test('fits exact circles, nearly repeated eigenvalues and independent rotated ellipses', () => {
	for (const ratio of [1, 1 + 1e-10, 1.5, 4])
		for (const theta of [0, 0.37, 1.8, 3.1]) {
			const expected = { center: { x: 2.3, y: -9.7 }, semiMajor: 40, semiMinor: 40 / ratio, theta }
			const { x, y } = points(expected)
			const fit = fitEllipse(x, y)!
			expect(fit).toBeDefined()
			expect(fit.ellipse.center.x).toBeCloseTo(expected.center.x, 8)
			expect(fit.ellipse.center.y).toBeCloseTo(expected.center.y, 8)
			expect(fit.ellipse.semiMajor).toBeCloseTo(expected.semiMajor, 7)
			expect(fit.ellipse.semiMinor).toBeCloseTo(expected.semiMinor, 7)
			expect(fit.rms).toBeLessThan(1e-8)
			if (ratio > 1.01) expect(fit.ellipse.theta).toBeCloseTo(theta, 8)
		}
})

test('normalizes large translations and changes of length unit', () => {
	for (const scale of [1e-4, 1, 1e5]) {
		const expected = { center: { x: 1e6 * scale, y: -2e6 * scale }, semiMajor: 40 * scale, semiMinor: 30 * scale, theta: 1.13 }
		const { x, y } = points(expected)
		const saved = x.slice()
		const fit = fitEllipse(x, y)!
		expect(fit).toBeDefined()
		expect(Math.abs(fit.ellipse.center.x - expected.center.x) / scale).toBeLessThan(1e-8)
		expect(Math.abs(fit.ellipse.semiMajor / expected.semiMajor - 1)).toBeLessThan(1e-8)
		expect(x).toEqual(saved)
	}
})

test('requires a real ellipse and rejects imaginary and degenerate conics', () => {
	expect(ellipseFromConic([1, 0, 1, 0, 0, 1])).toBeUndefined()
	expect(ellipseFromConic([1, 0, -1, 0, 0, -1])).toBeUndefined()
	expect(ellipseFromConic([1, 2, 1, 0, 0, -1])).toBeUndefined()
	expect(ellipseFromConic([1, 0, 1, 0, 0, 0])).toBeUndefined()
	expect(ellipseFromConic([-1, 0, -1, 0, 0, 4])).toEqual({ center: { x: 0, y: 0 }, semiMajor: 2, semiMinor: 2, theta: 0 })
})

test('does not regularize deficient points or a short arc into an accepted ellipse', () => {
	expect(fitEllipse([1, 2, 3], [2, 3, 4])).toBeUndefined()
	expect(fitEllipse([0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5])).toBeUndefined()
	const ellipse = { center: { x: 0, y: 0 }, semiMajor: 40, semiMinor: 30, theta: 0.3 }
	const arc = points(ellipse, 100, 0.04)
	expect(fitEllipse(arc.x, arc.y)).toBeUndefined()
	const line = points({ ...ellipse, semiMinor: 1e-7 })
	expect(fitEllipse(line.x, line.y)).toBeUndefined()
})

test('robustly rejects sparse radial outliers and caps bright sectors', () => {
	const expected = { center: { x: 15.2, y: 21.1 }, semiMajor: 40, semiMinor: 30, theta: 0.73 }
	const { x, y } = points(expected, 180)
	const weights = new Float64Array(180).fill(1)
	for (let i = 0; i < x.length; i += 23) {
		x[i] += 2
		y[i] -= 2
		weights[i] = 1000
	}
	const fit = fitEllipse(x, y, weights)!
	expect(fit).toBeDefined()
	expect(Math.hypot(fit.ellipse.center.x - expected.center.x, fit.ellipse.center.y - expected.center.y)).toBeLessThan(0.02)
	expect(fit.weights[0]).toBe(0)
	const copy = fit.residuals.slice()
	fitEllipse(x, y)
	expect(fit.residuals).toEqual(copy)
})

test('zero-precision samples neither affect robust scale nor singular trial residuals', () => {
	const expected = { center: { x: 0, y: 0 }, semiMajor: 40, semiMinor: 30, theta: 0 }
	const { x, y } = points(expected, 180)
	const weights = new Float64Array(180).fill(1)
	for (let i = 0; i < 70; i++) {
		x[i] = 0
		y[i] = 0
		weights[i] = 0
	}
	const fit = fitEllipse(x, y, weights)!
	expect(fit).toBeDefined()
	expect(fit.ellipse.semiMajor).toBeCloseTo(40, 8)
	expect(fit.rms).toBeLessThan(1e-8)
})
