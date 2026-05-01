import { describe, expect, test } from 'bun:test'
import type { FitsHeader } from '../src/fits'
import { type MatchedStar, type SipFitResult, type SipModel, applySipCorrection, buildSipDesignMatrix, countSipTerms, evaluateSipCorrection, fitSipDistortion, listSipTerms, sipModelIntoFitsHeader } from '../src/fits.sip'
import { DEC_TAN_SIP, RA_TAN_SIP, tanProject, tanUnproject } from '../src/fits.wcs'

const WCS = { CRPIX1: 512, CRPIX2: 384, NAXIS1: 1024, NAXIS2: 768 } as const
const TAN_WCS = { ...WCS, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 187.5, CRVAL2: -22.5, CD1_1: -2.7e-4, CD1_2: 1.3e-6, CD2_1: 1.1e-6, CD2_2: 2.7e-4 } as const

const TERMS_3 = listSipTerms(3)

const TRUE_MODEL: SipModel = {
	order: 3,
	A_ORDER: 3,
	B_ORDER: 3,
	terms: TERMS_3,
	A: {
		A_2_0: 1.2e-7,
		A_1_1: -2.1e-7,
		A_0_2: 1.7e-7,
		A_3_0: -2.4e-10,
		A_2_1: 1.1e-10,
		A_1_2: -1.5e-10,
		A_0_3: 2e-10,
	},
	B: {
		B_2_0: -1.5e-7,
		B_1_1: 1.9e-7,
		B_0_2: -1.1e-7,
		B_3_0: 1.8e-10,
		B_2_1: -1.3e-10,
		B_1_2: 9e-11,
		B_0_3: -2.2e-10,
	},
}

function noise(index: number, salt: number) {
	const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453123
	return (value - Math.floor(value) - 0.5) * 2
}

function syntheticStarsFromModel(model: SipModel, noiseScale: number = 0) {
	const stars: MatchedStar[] = []
	const cols = 10
	const rows = 8

	for (let yIndex = 0; yIndex < rows; yIndex++) {
		for (let xIndex = 0; xIndex < cols; xIndex++) {
			const index = stars.length
			const x = 80 + (864 * xIndex) / (cols - 1) + (yIndex % 2) * 3
			const y = 70 + (628 * yIndex) / (rows - 1) + (xIndex % 3) * 2
			const correction = evaluateSipCorrection(x, y, model, WCS)
			const nx = noiseScale === 0 ? 0 : noise(index, 1) * noiseScale
			const ny = noiseScale === 0 ? 0 : noise(index, 2) * noiseScale

			stars.push({ x, y, xRef: x + correction.dx + nx, yRef: y + correction.dy + ny })
		}
	}

	return stars
}

function syntheticStars(noiseScale: number = 0) {
	return syntheticStarsFromModel(TRUE_MODEL, noiseScale)
}

function clusteredStars() {
	const stars: MatchedStar[] = []

	for (let i = 0; i < 24; i++) {
		const x = 80 + (i % 6) * 6
		const y = 90 + Math.floor(i / 6) * 5
		const correction = evaluateSipCorrection(x, y, TRUE_MODEL, WCS)
		stars.push({ x, y, xRef: x + correction.dx, yRef: y + correction.dy })
	}

	return stars
}

function coefficientError(result: SipFitResult) {
	let error = 0

	for (const term of TERMS_3) {
		const a = result.A[`A_${term.i}_${term.j}`] - (TRUE_MODEL.A[`A_${term.i}_${term.j}`] ?? 0)
		const b = result.B[`B_${term.i}_${term.j}`] - (TRUE_MODEL.B[`B_${term.i}_${term.j}`] ?? 0)
		error += a * a + b * b
	}

	return Math.sqrt(error)
}

function radialSipModel(k: number): SipModel {
	return { order: 3, A_ORDER: 3, B_ORDER: 3, terms: TERMS_3, A: { A_3_0: k, A_1_2: k }, B: { B_2_1: k, B_0_3: k } }
}

function expectRadialFit(result: SipFitResult, k: number) {
	const expectedA: Record<string, number> = { A_3_0: k, A_1_2: k }
	const expectedB: Record<string, number> = { B_2_1: k, B_0_3: k }

	for (const term of TERMS_3) {
		const aKey = `A_${term.i}_${term.j}`
		const bKey = `B_${term.i}_${term.j}`

		expect(result.A[aKey]).toBeCloseTo(expectedA[aKey] ?? 0, 12)
		expect(result.B[bKey]).toBeCloseTo(expectedB[bKey] ?? 0, 12)
	}

	expect(result.rmsTotal).toBeLessThan(1e-9)
}

function medianGoodResidual(result: SipFitResult, outliers: ReadonlySet<number>) {
	const values = result.residuals
		.filter((residual) => !outliers.has(residual.index))
		.map((residual) => residual.r)
		.sort((a, b) => a - b)
	const mid = Math.floor(values.length / 2)
	return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid]
}

describe('SIP terms', () => {
	test('counts nonlinear terms', () => {
		expect(countSipTerms(2)).toBe(3)
		expect(countSipTerms(3)).toBe(7)
		expect(countSipTerms(4)).toBe(12)
		expect(countSipTerms(5)).toBe(18)
	})

	test('excludes constant and linear terms', () => {
		for (const term of listSipTerms(5)) {
			expect(term.i + term.j).toBeGreaterThanOrEqual(2)
			expect(term.i + term.j).toBeLessThanOrEqual(5)
		}
	})

	test('uses deterministic increasing total degree order', () => {
		expect(listSipTerms(3)).toEqual([
			{ i: 2, j: 0 },
			{ i: 1, j: 1 },
			{ i: 0, j: 2 },
			{ i: 3, j: 0 },
			{ i: 2, j: 1 },
			{ i: 1, j: 2 },
			{ i: 0, j: 3 },
		])
	})
})

describe('SIP design matrix', () => {
	test('builds rows from CRPIX-centered coordinates', () => {
		const star = { x: 515, y: 379, xRef: 515.25, yRef: 378.75 }
		const design = buildSipDesignMatrix([star], WCS, 2)

		expect(design.matrix.toArray()).toEqual([9, -15, 25])
		expect(design.residualX[0]).toBeCloseTo(0.25, 12)
		expect(design.residualY[0]).toBeCloseTo(-0.25, 12)
		expect(design.centeredX[0]).toBe(3)
		expect(design.centeredY[0]).toBe(-5)
	})
})

describe('SIP fitting', () => {
	test('recovers exact synthetic coefficients without noise', () => {
		const result = fitSipDistortion(syntheticStars(), WCS, { order: 3, maxIterations: 3 })

		for (const term of TERMS_3) {
			expect(result.A[`A_${term.i}_${term.j}`]).toBeCloseTo(TRUE_MODEL.A[`A_${term.i}_${term.j}`] ?? 0, 12)
			expect(result.B[`B_${term.i}_${term.j}`]).toBeCloseTo(TRUE_MODEL.B[`B_${term.i}_${term.j}`] ?? 0, 12)
		}

		expect(result.rmsTotal).toBeLessThan(1e-9)
		expect(result.rejectedStarCount).toBe(0)
		expect(result.diagnostics.rawRmsTotal).toBeGreaterThan(result.rmsTotal)
	})

	test('fits noisy synthetic data with low residuals', () => {
		const result = fitSipDistortion(syntheticStars(0.01), WCS, { order: 3, sigmaClip: 6, maxIterations: 3 })

		expect(result.rmsTotal).toBeLessThan(0.02)
		expect(result.diagnostics.medianResidual).toBeLessThan(0.02)
		expect(result.diagnostics.rawRmsTotal).toBeGreaterThan(result.rmsTotal)
		expect(result.usedStarCount).toBe(80)
	})

	test('recovers barrel radial distortion coefficients', () => {
		const k = 8e-9
		const model = radialSipModel(k)
		const result = fitSipDistortion(syntheticStarsFromModel(model), WCS, { order: 3, maxIterations: 3 })
		const correction = evaluateSipCorrection(WCS.CRPIX1 + 300, WCS.CRPIX2, model, WCS)

		expectRadialFit(result, k)
		expect(correction.dx).toBeGreaterThan(0)
		expect(Math.abs(correction.dy)).toBeLessThan(1e-12)
	})

	test('recovers pincushion radial distortion coefficients', () => {
		const k = -8e-9
		const model = radialSipModel(k)
		const result = fitSipDistortion(syntheticStarsFromModel(model), WCS, { order: 3, maxIterations: 3 })
		const correction = evaluateSipCorrection(WCS.CRPIX1 + 300, WCS.CRPIX2, model, WCS)

		expectRadialFit(result, k)
		expect(correction.dx).toBeLessThan(0)
		expect(Math.abs(correction.dy)).toBeLessThan(1e-12)
	})

	test('rejects injected outlier matches', () => {
		const stars = syntheticStars(0.002)
		const bad = 17
		stars[bad] = { ...stars[bad], xRef: stars[bad].xRef + 8, yRef: stars[bad].yRef - 7 }

		const result = fitSipDistortion(stars, WCS, { order: 3, sigmaClip: 3, maxIterations: 5 })

		expect(result.rejectedStarIndices).toContain(bad)
		expect(result.residuals[bad].rejected).toBeTrue()
		expect(result.usedStarCount).toBeLessThan(result.inputStarCount)
	})

	test('uses weights when requested', () => {
		const stars = syntheticStars()
		const outliers = new Set([5, 12, 34, 50])

		for (const index of outliers) {
			stars[index] = { ...stars[index], xRef: stars[index].xRef + 12, yRef: stars[index].yRef - 10, weight: 1e-4 }
		}

		const unweighted = fitSipDistortion(stars, WCS, { order: 3, maxIterations: 1, weighting: 'none' })
		const weighted = fitSipDistortion(stars, WCS, { order: 3, maxIterations: 1, weighting: 'star' })

		expect(coefficientError(weighted)).toBeLessThan(coefficientError(unweighted))
		expect(medianGoodResidual(weighted, outliers)).toBeLessThan(medianGoodResidual(unweighted, outliers))
		expect(weighted.diagnostics.weighted).toBeTrue()
	})

	test('fails when stars do not exceed coefficient count', () => {
		expect(() => fitSipDistortion(syntheticStars().slice(0, countSipTerms(3)), WCS, { order: 3, spatialDistribution: 'off' })).toThrow('more stars than coefficients')
	})

	test('fails for spatially clustered stars by default', () => {
		expect(() => fitSipDistortion(clusteredStars(), WCS, { order: 3 })).toThrow('poorly distributed')
	})

	test('can warn instead of failing for spatially clustered stars', () => {
		const result = fitSipDistortion(clusteredStars(), WCS, { order: 3, spatialDistribution: 'warn' })

		expect(result.diagnostics.warnings.some((warning) => warning.includes('poorly distributed'))).toBeTrue()
	})
})

describe('SIP FITS header', () => {
	test('writes forward SIP coefficients into an existing TAN header', () => {
		const header: FitsHeader = { ...TAN_WCS, A_ORDER: 5, B_ORDER: 5, AP_ORDER: 3, BP_ORDER: 3, A_0_0: 1, A_1_0: 2, B_0_1: 3, AP_3_0: 4, BP_DMAX: 5 }
		const returned = sipModelIntoFitsHeader(TRUE_MODEL, header)

		expect(returned).toBe(header)
		expect(header.CTYPE1).toBe(RA_TAN_SIP)
		expect(header.CTYPE2).toBe(DEC_TAN_SIP)
		expect(header.A_ORDER).toBe(3)
		expect(header.B_ORDER).toBe(3)
		expect(header.A_2_0).toBe(TRUE_MODEL.A.A_2_0)
		expect(header.B_0_3).toBe(TRUE_MODEL.B.B_0_3)
		expect(header.A_0_0).toBeUndefined()
		expect(header.A_1_0).toBeUndefined()
		expect(header.B_0_1).toBeUndefined()
		expect(header.AP_ORDER).toBeUndefined()
		expect(header.BP_ORDER).toBeUndefined()
		expect(header.AP_3_0).toBeUndefined()
		expect(header.BP_DMAX).toBeUndefined()
	})

	test('writes a fitted model that TAN-SIP projection uses', () => {
		const sourceModel = radialSipModel(8e-9)
		const result = fitSipDistortion(syntheticStarsFromModel(sourceModel), WCS, { order: 3, maxIterations: 3 })
		const linearHeader: FitsHeader = { ...TAN_WCS }
		const sipHeader = sipModelIntoFitsHeader(result.model, { ...TAN_WCS })
		const x = 700
		const y = 450
		const corrected = applySipCorrection(x, y, result.model, sipHeader)
		const linearSky = tanUnproject(linearHeader, corrected.x, corrected.y)
		const sipSky = tanUnproject(sipHeader, x, y)

		expect(linearSky).toBeDefined()
		expect(sipSky).toBeDefined()

		if (!linearSky || !sipSky) return

		expect(sipSky[0]).toBeCloseTo(linearSky[0], 12)
		expect(sipSky[1]).toBeCloseTo(linearSky[1], 12)

		const projected = tanProject(sipHeader, sipSky[0], sipSky[1])

		expect(projected).toBeDefined()

		if (!projected) return

		expect(projected[0]).toBeCloseTo(x, 8)
		expect(projected[1]).toBeCloseTo(y, 8)
	})
})

describe('SIP evaluation', () => {
	test('evaluates and applies expected correction', () => {
		const x = 620
		const y = 410
		const correction = evaluateSipCorrection(x, y, TRUE_MODEL, WCS)
		const corrected = applySipCorrection(x, y, TRUE_MODEL, WCS)

		expect(corrected.x).toBeCloseTo(x + correction.dx, 12)
		expect(corrected.y).toBeCloseTo(y + correction.dy, 12)
		expect(corrected.x).toBeCloseTo(620.00064851216, 12)
		expect(corrected.y).toBeCloseTo(409.99889958784, 12)
	})
})

describe('SIP validation', () => {
	test('rejects invalid order', () => {
		expect(() => countSipTerms(1)).toThrow('at least')
		expect(() => countSipTerms(6)).toThrow('not supported')
	})

	test('rejects invalid coordinates', () => {
		const stars = syntheticStars()
		stars[0] = { ...stars[0], x: Number.NaN }

		expect(() => fitSipDistortion(stars, WCS, { order: 3, spatialDistribution: 'off' })).toThrow('finite number')
	})

	test('rejects invalid weights', () => {
		const stars = syntheticStars()
		stars[0] = { ...stars[0], weight: 0 }

		expect(() => fitSipDistortion(stars, WCS, { order: 3, weighting: 'star', spatialDistribution: 'off' })).toThrow('weight must be a positive finite number')
	})
})
