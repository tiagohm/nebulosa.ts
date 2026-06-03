import type { NumberArray } from './math'
import { gaussianElimination, Matrix } from './matrix'

export interface LevenbergMarquardtOptions {
	// Maximum optimizer iterations.
	maxIterations?: number
	// Initial damping factor.
	lambda?: number
	// Minimum residual-improvement threshold.
	tolerance?: number
}

const LEVENBERG_MARQUARDT_DELTA = 1e-8

// Computes the parameters of a Levenberg-Marquardt model.
// This is a non-linear least squares optimization algorithm.
// It minimizes the sum of squared residuals between the model and the data.
export function levenbergMarquardt(x: Readonly<NumberArray>, y: Readonly<NumberArray>, model: (x: number, params: NumberArray) => number, params: number[], { maxIterations = 100, lambda = 0.01, tolerance = 1e-6 }: LevenbergMarquardtOptions = {}) {
	const n = Math.min(x.length, y.length)
	const m = params.length

	const J = new Array<Float64Array>(m)
	const PJ = new Float64Array(m)
	const JTJ = Matrix.square(m)
	const JTJData = JTJ.data
	const JTR = new Float64Array(m)

	const R = new Float64Array(n)
	const UP = new Float64Array(m)
	const DP = new Float64Array(m)

	const YP = new Float64Array(n)
	const YPJ = new Float64Array(n)

	for (let i = 0; i < m; i++) {
		J[i] = new Float64Array(n)
	}

	const predict = (params: NumberArray, o: NumberArray) => {
		for (let i = 0; i < o.length; i++) o[i] = model(x[i], params)
	}

	while (maxIterations-- > 0) {
		predict(params, YP)

		// residual
		for (let i = 0; i < n; i++) R[i] = y[i] - YP[i]

		// Jacobian
		for (let j = 0; j < m; j++) {
			for (let k = 0; k < m; k++) PJ[k] = params[k]
			PJ[j] += LEVENBERG_MARQUARDT_DELTA
			predict(PJ, YPJ)

			for (let k = 0; k < n; k++) {
				J[j][k] = (YPJ[k] - YP[k]) / LEVENBERG_MARQUARDT_DELTA
			}
		}

		// J' * J and J' * r
		for (let i = 0; i < m; i++) {
			const Ji = J[i]

			let sum = 0
			for (let k = 0; k < n; k++) sum += Ji[k] * R[k]
			JTR[i] = sum

			const iOffset = i * m

			for (let j = i; j < m; j++) {
				const Jj = J[j]

				let dot = 0
				for (let k = 0; k < n; k++) dot += Ji[k] * Jj[k]

				JTJData[iOffset + j] = dot
				JTJData[j * m + i] = dot
			}
		}

		for (let i = 0, p = 0; i < m; i++, p += m) {
			JTJData[p + i] *= 1 + lambda
		}

		// Solve JTJ * dp = JTr.
		gaussianElimination(JTJ, JTR, DP)

		if (Number.isNaN(DP[0])) break

		// Update parameters.
		for (let i = 0; i < m; i++) UP[i] = params[i] + DP[i]
		predict(UP, YPJ)

		let error = 0
		let newError = 0

		for (let i = 0; i < n; i++) {
			const ri = R[i]
			const di = y[i] - YPJ[i]
			error += ri * ri
			newError += di * di
		}

		if (newError < error) {
			for (let i = 0; i < m; i++) params[i] = UP[i]
			if (Math.abs(error - newError) <= tolerance) break
			lambda /= 10
		} else {
			lambda *= 10
		}
	}

	return params
}
