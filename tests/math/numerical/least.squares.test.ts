import { expect, test } from 'bun:test'
import { leastSquaresCoefficients, linearLeastSquares, predictLinearLeastSquares, robustLinearLeastSquares } from '../../../src/math/numerical/least.squares'

test('linear least squares', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1]), new Float64Array([1, 2]), new Float64Array([1, 3])]
	const target = new Float64Array([1, 3, 5, 7])
	const fit = linearLeastSquares(design, target)

	expect(fit.coefficients[0]).toBeCloseTo(1, 8)
	expect(fit.coefficients[1]).toBeCloseTo(2, 8)
	expect(fit.rankDeficient).toBeFalse()
	expect(fit.conditionNumber).toBeGreaterThan(1)
	expect(predictLinearLeastSquares(fit.coefficients, new Float64Array([1, 4]))).toBeCloseTo(9, 8)
})

test('flags a rank-deficient design as singular', () => {
	// Column 2 duplicates column 1, so the normal matrix is singular.
	const design = [new Float64Array([1, 1]), new Float64Array([2, 2]), new Float64Array([3, 3]), new Float64Array([4, 4])]
	const target = new Float64Array([2, 4, 6, 8])
	const fit = linearLeastSquares(design, target)

	expect(fit.rankDeficient).toBeTrue()
	expect(Number.isFinite(fit.conditionNumber)).toBeFalse()
	// A regularized fallback still returns finite coefficients that reproduce the target.
	expect(predictLinearLeastSquares(fit.coefficients, new Float64Array([5, 5]))).toBeCloseTo(10, 6)

	// Linear dependence among three columns is also singular; Gram-matrix rounding must not
	// report a finite κ below the public 1e12 cutoff.
	const dependent = [new Float64Array([1, 0, 1]), new Float64Array([0, 1, 1]), new Float64Array([1, 1, 2]), new Float64Array([2, 3, 5])]
	const dependentFit = linearLeastSquares(dependent, new Float64Array([1, 1, 2, 5]))
	expect(dependentFit.rankDeficient).toBeTrue()
	expect(Number.isFinite(dependentFit.conditionNumber)).toBeFalse()
})

test('a poorly scaled full-rank design keeps a finite condition number', () => {
	// xs = k * 5e-7, k = 0..4, columns [1, x]. XᵀX has λ_max ≈ 5, λ_min = 10 s² = 2.5e-12,
	// so κ₂(X) = sqrt(λ_max/λ_min) ≈ 1.41e6, well below the public 1e12 rank-deficiency cut.
	const s = 5e-7
	const xs = [0, s, 2 * s, 3 * s, 4 * s]
	const design = xs.map((x) => new Float64Array([1, x]))
	const target = new Float64Array(xs.map((x) => 1 + 2 * x))
	const fit = linearLeastSquares(design, target)

	expect(fit.coefficients[0]).toBeCloseTo(1, 8)
	expect(fit.coefficients[1]).toBeCloseTo(2, 8)
	expect(fit.rankDeficient).toBeFalse()
	expect(fit.conditionNumber).toBeCloseTo(Math.SQRT2 * 1e6, 0)

	// Unnormalized quadratic Vandermonde: columns [1, x, x²] with x ∈ {0, 400, …, 4000}.
	// Recovered coefficients stay accurate; a 1e-12 floor on λ of XᵀX would have called this singular.
	const xv: number[] = []
	for (let i = 0; i <= 10; i++) xv.push(i * 400)
	const vandermonde = xv.map((x) => new Float64Array([1, x, x * x]))
	const quadratic = linearLeastSquares(vandermonde, new Float64Array(xv.map((x) => 1.5 - 0.002 * x + 3e-7 * x * x)))
	expect(quadratic.coefficients[0]).toBeCloseTo(1.5, 8)
	expect(quadratic.coefficients[1]).toBeCloseTo(-0.002, 8)
	expect(quadratic.coefficients[2]).toBeCloseTo(3e-7, 8)
	expect(quadratic.rankDeficient).toBeFalse()
	expect(quadratic.conditionNumber).toBeGreaterThan(1e6)
	expect(quadratic.conditionNumber).toBeLessThan(1e12)
})

test('leverage reproduces leave-one-out residuals without refitting', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1]), new Float64Array([1, 2]), new Float64Array([1, 3]), new Float64Array([1, 5]), new Float64Array([1, 9])]
	const target = new Float64Array([1.1, 2.8, 5.3, 6.9, 11.4, 18.7])
	const weights = new Float64Array([1, 1, 2, 1, 0.5, 1])
	const fit = linearLeastSquares(design, target, { weights, leverage: true })

	expect(fit.leverage).toBeDefined()

	// Without a ridge, the hat-matrix diagonal sums to the number of free parameters.
	let trace = 0
	for (let i = 0; i < design.length; i++) trace += fit.leverage![i]
	expect(trace).toBeCloseTo(2, 8)

	for (let i = 0; i < design.length; i++) {
		const heldOutDesign = design.filter((_, index) => index !== i)
		const heldOutTarget = target.filter((_, index) => index !== i)
		const heldOutWeights = weights.filter((_, index) => index !== i)
		const heldOut = linearLeastSquares(heldOutDesign, heldOutTarget, { weights: heldOutWeights })

		expect(fit.residuals[i] / (1 - fit.leverage![i])).toBeCloseTo(target[i] - predictLinearLeastSquares(heldOut.coefficients, design[i]), 8)
	}
})

test('a ridge shrinks leverage below the unregularized value', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1]), new Float64Array([1, 2]), new Float64Array([1, 3])]
	const target = new Float64Array([1, 3, 5, 7])
	const plain = linearLeastSquares(design, target, { leverage: true })
	const regularized = linearLeastSquares(design, target, { ridge: 4, leverage: true })

	for (let i = 0; i < design.length; i++) {
		expect(regularized.leverage![i]).toBeLessThan(plain.leverage![i])
		expect(regularized.leverage![i]).toBeGreaterThan(0)
	}
})

test('the coefficients-only solver matches the full solve exactly', () => {
	const design = [new Float64Array([1, 0, 0]), new Float64Array([1, 1, 1]), new Float64Array([1, 2, 4]), new Float64Array([1, 3, 9]), new Float64Array([1, 4, 16])]
	const target = new Float64Array([1.1, 2.9, 5.2, 6.8, 9.3])
	const weights = new Float64Array([1, 0.5, 2, 0.25, 1.5])

	for (const options of [{}, { weights }, { ridge: 0.3 }, { weights, ridge: 0.3 }]) {
		const full = linearLeastSquares(design, target, options)
		const cheap = leastSquaresCoefficients(design, target, options)

		expect(cheap.length).toBe(full.coefficients.length)

		for (let i = 0; i < cheap.length; i++) expect(cheap[i]).toBe(full.coefficients[i])
	}

	expect(() => leastSquaresCoefficients(design, new Float64Array(2))).toThrowError()
})

test('robust linear least squares resists outliers', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1]), new Float64Array([1, 2]), new Float64Array([1, 3]), new Float64Array([1, 4])]
	const target = new Float64Array([1, 3, 5, 7, 100])
	const plain = linearLeastSquares(design, target)
	const robust = robustLinearLeastSquares(design, target, { method: 'tukey' })

	expect(Math.abs(plain.coefficients[1] - 2)).toBeGreaterThan(Math.abs(robust.coefficients[1] - 2))
	expect(robust.weights[4]).toBeLessThan(1)
})

test('zero-weighted samples are excluded from the fit', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1]), new Float64Array([1, 2]), new Float64Array([1, 3]), new Float64Array([1, 4])]
	const target = new Float64Array([1, 3, 5, 7, 100])
	// The fifth sample is a gross outlier; weighting it to zero must recover the clean line.
	const fit = linearLeastSquares(design, target, { weights: new Float64Array([1, 1, 1, 1, 0]) })

	expect(fit.coefficients[0]).toBeCloseTo(1, 6)
	expect(fit.coefficients[1]).toBeCloseTo(2, 6)
})

test('zero-weighted residuals do not inflate the robust scale', () => {
	const design: Float64Array[] = []
	const target: number[] = []
	const weights: number[] = []

	for (let i = 0; i < 24; i++) {
		design.push(new Float64Array([1]))
		target.push(1)
		weights.push(1)
	}

	design.push(new Float64Array([1]))
	target.push(5)
	weights.push(1)
	const weightedOutlier = weights.length - 1

	for (let i = 0; i < 30; i++) {
		design.push(new Float64Array([1]))
		target.push(1_000)
		weights.push(0)
	}

	const fit = robustLinearLeastSquares(design, target, { weights, method: 'tukey' })
	expect(fit.coefficients[0]).toBeCloseTo(1, 10)
	expect(fit.weights[weightedOutlier]).toBe(0)
})

test('robust huber fit also resists outliers', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1]), new Float64Array([1, 2]), new Float64Array([1, 3]), new Float64Array([1, 4])]
	const target = new Float64Array([1, 3, 5, 7, 100])
	const plain = linearLeastSquares(design, target)
	const robust = robustLinearLeastSquares(design, target, { method: 'huber' })

	expect(Math.abs(robust.coefficients[1] - 2)).toBeLessThan(Math.abs(plain.coefficients[1] - 2))
	expect(robust.weights[4]).toBeLessThan(1)
})

test('linear least squares rejects invalid weights', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1])]
	const target = new Float64Array([1, 3])

	expect(() => linearLeastSquares(design, target, { weights: new Float64Array([1, -1]) })).toThrow('weight at index 1 must be finite and non-negative')
	expect(() => linearLeastSquares(design, target, { weights: new Float64Array([1, Number.NaN]) })).toThrow('weight at index 1 must be finite and non-negative')
})

test('linear least squares rejects non-rectangular design matrices', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1])]
	const target = new Float64Array([1, 3])

	expect(() => linearLeastSquares(design, target)).toThrow('design matrix must be rectangular')
})
