import { describe, expect, test } from 'bun:test'
import { nearestSolarEclipse } from '../src/sun'
import { derivativeBesselian, derivativeBesselianPolynomial, evaluateBesselian, evaluateBesselianPolynomial, generateBesselianElements, type BesselianElements, type BesselianSample } from '../src/sun.eclipse.besselian'
import { Timescale, timeYMD, toJulianDay } from '../src/time'

const QUANTITIES = ['x', 'y', 'd', 'mu', 'l1', 'l2', 'tanF1', 'tanF2'] as const
const DERIVATIVES = ['dx', 'dy', 'dd', 'dmu', 'dl1', 'dl2', 'dtanF1', 'dtanF2'] as const

function expectFiniteElements(elements: BesselianElements) {
	expect(elements.t0.scale).toBe(Timescale.TT)
	expect(elements.polynomialDegree).toBe(3)
	expect(elements.deltaTSeconds).toBeFinite()
	expect(elements.deltaTSeconds).toBeGreaterThan(0)
	expect(elements.validFrom.scale).toBe(Timescale.TT)
	expect(elements.validTo.scale).toBe(Timescale.TT)
	expect(toJulianDay(elements.validFrom)).toBeLessThan(toJulianDay(elements.t0))
	expect(toJulianDay(elements.validTo)).toBeGreaterThan(toJulianDay(elements.t0))
	expect(elements.earth.equatorialRadius).toBeGreaterThan(0)
	expect(elements.earth.flattening).toBeGreaterThan(0)

	for (const key of QUANTITIES) {
		expect(elements[key].degree).toBe(elements.polynomialDegree)
		expect(elements[key].coefficients).toHaveLength(elements.polynomialDegree + 1)
		for (const coefficient of elements[key].coefficients) expect(coefficient).toBeFinite()
	}
}

function expectFiniteSample(sample: BesselianSample) {
	expect(sample.time.scale).toBe(Timescale.TT)
	expect(sample.tauHours).toBeFinite()

	for (const key of QUANTITIES) {
		expect(sample[key]).toBeFinite()
	}
}

function expectPolynomialFitMatchesSamples(elements: BesselianElements) {
	for (const sample of elements.samples ?? []) {
		const state = evaluateBesselian(elements, sample.time)

		for (const key of QUANTITIES) {
			expect(Math.abs(state[key] - sample[key])).toBeLessThan(5e-6)
		}
	}
}

function expectContinuousMu(samples: readonly BesselianSample[]) {
	for (let i = 1; i < samples.length; i++) {
		expect(Math.abs(samples[i].mu - samples[i - 1].mu)).toBeLessThan(0.2)
	}
}

function expectFiniteStateAndDerivative(elements: BesselianElements) {
	const state = evaluateBesselian(elements, elements.t0)
	expect(state.time.scale).toBe(Timescale.TT)
	expect(state.tauHours).toBeCloseTo(0, 12)

	for (const key of QUANTITIES) {
		expect(state[key]).toBeFinite()
	}

	const derivative = derivativeBesselian(elements, elements.t0)
	expect(derivative.time.scale).toBe(Timescale.TT)
	expect(derivative.tauHours).toBeCloseTo(0, 12)

	for (const key of DERIVATIVES) {
		expect(derivative[key]).toBeFinite()
	}
}

describe('solar eclipse Besselian elements', () => {
	test('2017-08-21 total solar eclipse', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2017, 8, 1), true)
		const elements = generateBesselianElements({ maximumApprox: eclipse.maximalTime })

		expect(eclipse.type).toBe('TOTAL')
		expect(elements.eclipseTypeApprox).toBe('TOTAL')
		expect(elements.samples).toHaveLength(37)
		expectFiniteElements(elements)
		for (const sample of elements.samples ?? []) expectFiniteSample(sample)
		expectPolynomialFitMatchesSamples(elements)
		expectContinuousMu(elements.samples ?? [])
		expectFiniteStateAndDerivative(elements)

		const maximum = evaluateBesselian(elements, eclipse.maximalTime)
		expect(Math.hypot(maximum.x, maximum.y)).toBeLessThan(1)
		expect(maximum.l2).toBeGreaterThan(0)
	})

	test('2024-04-08 total solar eclipse', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2024, 3, 1), true)
		const elements = generateBesselianElements({ maximumApprox: eclipse.maximalTime })

		expect(eclipse.type).toBe('TOTAL')
		expect(elements.eclipseTypeApprox).toBe('TOTAL')
		expect(elements.samples).toHaveLength(37)
		expectFiniteElements(elements)
		for (const sample of elements.samples ?? []) expectFiniteSample(sample)
		expectPolynomialFitMatchesSamples(elements)
		expectContinuousMu(elements.samples ?? [])
		expectFiniteStateAndDerivative(elements)

		const maximum = evaluateBesselian(elements, eclipse.maximalTime)
		expect(Math.hypot(maximum.x, maximum.y)).toBeLessThan(1)
		expect(maximum.l2).toBeGreaterThan(0)
	})

	test('polynomial evaluation and derivative helpers use ascending coefficients', () => {
		const polynomial = { degree: 3, coefficients: [1, 2, 3, 4] }

		expect(evaluateBesselianPolynomial(polynomial, 2)).toBe(49)
		expect(derivativeBesselianPolynomial(polynomial, 2)).toBe(62)
	})

	test('rejects insufficient samples for the requested polynomial degree', () => {
		const eclipse = nearestSolarEclipse(timeYMD(2024, 3, 1), true)

		expect(() => generateBesselianElements({ maximumApprox: eclipse.maximalTime, intervalHours: 1, stepMinutes: 60, polynomialDegree: 4 })).toThrow('at least 5 Besselian samples')
	})
})
