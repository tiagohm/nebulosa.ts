import { expect, test } from 'bun:test'
import { TAU } from '../../../src/core/constants'
import { fft2DWorkspace, fftComplex1D, fftComplex2D, fftPaddedSize, fftPlan } from '../../../src/math/numerical/fft'

test('padded size is the next power of two', () => {
	expect(fftPaddedSize(0)).toBe(1)
	expect(fftPaddedSize(1)).toBe(1)
	expect(fftPaddedSize(5)).toBe(8)
	expect(fftPaddedSize(64)).toBe(64)
	expect(fftPaddedSize(65)).toBe(128)
})

test('impulse transforms to a flat spectrum', () => {
	const plan = fftPlan(16)
	const real = new Float64Array(16)
	const imaginary = new Float64Array(16)
	real[0] = 1
	fftComplex1D(real, imaginary, 0, plan, false)

	for (let i = 0; i < 16; i++) {
		expect(real[i]).toBeCloseTo(1, 14)
		expect(imaginary[i]).toBeCloseTo(0, 14)
	}
})

test('shifted impulse has a linear phase ramp with negative exponent', () => {
	const plan = fftPlan(8)
	const real = new Float64Array(8)
	const imaginary = new Float64Array(8)
	real[1] = 1
	fftComplex1D(real, imaginary, 0, plan, false)

	for (let k = 0; k < 8; k++) {
		expect(real[k]).toBeCloseTo(Math.cos((-TAU * k) / 8), 14)
		expect(imaginary[k]).toBeCloseTo(Math.sin((-TAU * k) / 8), 14)
	}
})

test('constant transforms to DC only', () => {
	const plan = fftPlan(32)
	const real = new Float64Array(32).fill(3)
	const imaginary = new Float64Array(32)
	fftComplex1D(real, imaginary, 0, plan, false)
	expect(real[0]).toBeCloseTo(96, 12)

	for (let i = 1; i < 32; i++) {
		expect(Math.hypot(real[i], imaginary[i])).toBeCloseTo(0, 12)
	}
})

test('sinusoid concentrates energy at its frequency', () => {
	const n = 64
	const plan = fftPlan(n)
	const real = new Float64Array(n)
	const imaginary = new Float64Array(n)
	for (let i = 0; i < n; i++) real[i] = Math.cos((TAU * 5 * i) / n)
	fftComplex1D(real, imaginary, 0, plan, false)

	for (let k = 0; k < n; k++) {
		const magnitude = Math.hypot(real[k], imaginary[k])
		expect(magnitude).toBeCloseTo(k === 5 || k === n - 5 ? n / 2 : 0, 10)
	}
})

test('transform honors the vector offset and leaves other samples untouched', () => {
	const plan = fftPlan(4)
	const real = new Float64Array([9, 1, 0, 0, 0, 9])
	const imaginary = new Float64Array(6)
	fftComplex1D(real, imaginary, 1, plan, false)
	expect(real[0]).toBe(9)
	expect(real[5]).toBe(9)
	for (let i = 1; i <= 4; i++) expect(real[i]).toBeCloseTo(1, 14)
})

test('1D and 2D round trips restore the input', () => {
	const plan = fftPlan(32)
	const real = new Float64Array(32)
	const imaginary = new Float64Array(32)
	for (let i = 0; i < 32; i++) real[i] = Math.sin(i * 0.37) + i * 0.01
	const original = real.slice()
	fftComplex1D(real, imaginary, 0, plan, false)
	fftComplex1D(real, imaginary, 0, plan, true)
	for (let i = 0; i < 32; i++) expect(real[i]).toBeCloseTo(original[i], 12)

	const workspace = fft2DWorkspace(13, 6)
	expect(workspace.width).toBe(16)
	expect(workspace.height).toBe(8)
	for (let i = 0; i < workspace.real.length; i++) workspace.real[i] = Math.cos(i * 0.11) * (i % 7)
	const original2D = workspace.real.slice()
	fftComplex2D(workspace, false)
	fftComplex2D(workspace, true)

	for (let i = 0; i < original2D.length; i++) {
		expect(workspace.real[i]).toBeCloseTo(original2D[i], 12)
		expect(workspace.imaginary[i]).toBeCloseTo(0, 12)
	}
})

test('2D impulse at (x, y) produces the separable phase ramp', () => {
	const workspace = fft2DWorkspace(8, 4)
	workspace.real[2 * 8 + 3] = 1
	fftComplex2D(workspace, false)

	for (let v = 0; v < 4; v++) {
		for (let u = 0; u < 8; u++) {
			const angle = -TAU * ((u * 3) / 8 + (v * 2) / 4)
			expect(workspace.real[v * 8 + u]).toBeCloseTo(Math.cos(angle), 12)
			expect(workspace.imaginary[v * 8 + u]).toBeCloseTo(Math.sin(angle), 12)
		}
	}
})
