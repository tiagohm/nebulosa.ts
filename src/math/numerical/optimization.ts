import { gaussianElimination, Matrix } from '../linear-algebra/matrix'
import type { NumberArray } from './math'

// Derivative-free numerical optimization: scalar root finders (bisection, Brent, secant, Illinois
// false-position), scalar minimizers (golden-section, Brent), multivariate minimizers (Nelder-Mead,
// coordinate descent, Powell), and a Levenberg-Marquardt non-linear least-squares fitter. Bracketed
// methods require endpoints with opposite signs (roots) or a valid bracket (minimizers); each returns a
// result reporting the estimate, function value, iteration count, and whether tolerance was reached.

export interface RootFindingOptions {
	// Maximum solver iterations.
	readonly maxIterations?: number
	// Minimum x-interval or x-step threshold.
	readonly tolerance?: number
	// Minimum absolute function-value threshold.
	readonly functionTolerance?: number
}

export interface RootFindingResult {
	// Estimated root where f(root) is approximately zero.
	readonly root: number
	// Function value evaluated at the estimated root.
	readonly value: number
	// Number of solver iterations performed.
	readonly iterations: number
	// Whether the solver reached the configured tolerance before the iteration limit.
	readonly converged: boolean
}

export interface ScalarMinimizationOptions {
	// Maximum minimizer iterations.
	readonly maxIterations?: number
	// Minimum bracket or position-change threshold.
	readonly tolerance?: number
}

export interface ScalarMinimizationResult {
	// Estimated scalar position of the minimum.
	readonly minimum: number
	// Objective value evaluated at the estimated minimum.
	readonly value: number
	// Number of minimizer iterations performed.
	readonly iterations: number
	// Whether the minimizer reached the configured tolerance before the iteration limit.
	readonly converged: boolean
}

export interface MultivariateMinimizationOptions extends ScalarMinimizationOptions {
	// Initial search step for simplex vertices or line searches.
	readonly initialStep?: number
}

export interface NelderMeadOptions extends MultivariateMinimizationOptions {
	// Reflection coefficient.
	readonly reflection?: number
	// Expansion coefficient.
	readonly expansion?: number
	// Contraction coefficient.
	readonly contraction?: number
	// Shrink coefficient.
	readonly shrink?: number
}

export interface CoordinateDescentOptions extends MultivariateMinimizationOptions {
	// Multiplicative step reduction applied when a full coordinate pass does not improve the objective.
	readonly stepReduction?: number
}

export interface PowellOptions extends MultivariateMinimizationOptions {
	// Minimum line-search tolerance used by the inner Brent minimizer.
	readonly lineTolerance?: number
}

export interface MultivariateMinimizationResult {
	// Estimated parameter vector at the minimum.
	readonly minimum: Readonly<NumberArray>
	// Objective value evaluated at the estimated minimum.
	readonly value: number
	// Number of minimizer iterations performed.
	readonly iterations: number
	// Whether the minimizer reached the configured tolerance before the iteration limit.
	readonly converged: boolean
}

export interface LevenbergMarquardtOptions {
	// Maximum optimizer iterations.
	maxIterations?: number
	// Initial damping factor.
	lambda?: number
	// Minimum residual-improvement threshold.
	tolerance?: number
	// Optional non-negative sample weights; omitted entries are not permitted.
	weights?: Readonly<NumberArray>
}

// Finite-difference step used to numerically approximate the Levenberg-Marquardt Jacobian.
const LEVENBERG_MARQUARDT_DELTA = 1e-8
// Default iteration cap and convergence tolerances for the scalar root finders.
const DEFAULT_ROOT_ITERATIONS = 100
const DEFAULT_ROOT_TOLERANCE = 1e-12
const DEFAULT_FUNCTION_TOLERANCE = 1e-12
// Default iteration cap and bracket tolerance for the scalar minimizers.
const DEFAULT_SCALAR_ITERATIONS = 100
const DEFAULT_SCALAR_TOLERANCE = 1e-10
// Default iteration cap and tolerance for the multivariate minimizers.
const DEFAULT_MULTIVARIATE_ITERATIONS = 500
const DEFAULT_MULTIVARIATE_TOLERANCE = 1e-8
// Default initial step for simplex vertices and line searches.
const DEFAULT_INITIAL_STEP = 1
// Golden ratio φ, used to expand line-search brackets.
const GOLDEN_RATIO = 1.618033988749895
// Golden-section fraction (2 - φ), the interior sampling ratio for golden-section search.
const GOLDEN_SECTION = 0.3819660112501051

// Finds a bracketed scalar root using bisection.
export function bisection(f: (x: number) => number, min: number, max: number, { maxIterations = DEFAULT_ROOT_ITERATIONS, tolerance = DEFAULT_ROOT_TOLERANCE, functionTolerance = DEFAULT_FUNCTION_TOLERANCE }: RootFindingOptions = {}): RootFindingResult {
	let a = min
	let b = max
	let fa = f(a)
	let fb = f(b)

	validateBracket(a, b, fa, fb)

	if (Math.abs(fa) <= functionTolerance) return { root: a, value: fa, iterations: 0, converged: true }
	if (Math.abs(fb) <= functionTolerance) return { root: b, value: fb, iterations: 0, converged: true }

	let mid = 0.5 * (a + b)
	let fmid = f(mid)

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		mid = 0.5 * (a + b)
		fmid = f(mid)

		if (Math.abs(fmid) <= functionTolerance || Math.abs(b - a) <= tolerance) {
			return { root: mid, value: fmid, iterations, converged: true }
		}

		if (hasOppositeSigns(fa, fmid)) {
			b = mid
			fb = fmid
		} else {
			a = mid
			fa = fmid
		}
	}

	return { root: mid, value: fmid, iterations: maxIterations, converged: false }
}

// Finds a bracketed scalar root using Brent's method.
export function brentRoot(f: (x: number) => number, min: number, max: number, { maxIterations = DEFAULT_ROOT_ITERATIONS, tolerance = DEFAULT_ROOT_TOLERANCE, functionTolerance = DEFAULT_FUNCTION_TOLERANCE }: RootFindingOptions = {}): RootFindingResult {
	let a = min
	let b = max
	let fa = f(a)
	let fb = f(b)

	validateBracket(a, b, fa, fb)

	if (Math.abs(fa) <= functionTolerance) return { root: a, value: fa, iterations: 0, converged: true }
	if (Math.abs(fb) <= functionTolerance) return { root: b, value: fb, iterations: 0, converged: true }

	let c = a
	let fc = fa
	let d = b - a
	let e = d

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		if (hasSameSign(fb, fc)) {
			c = a
			fc = fa
			d = b - a
			e = d
		}

		if (Math.abs(fc) < Math.abs(fb)) {
			a = b
			b = c
			c = a
			fa = fb
			fb = fc
			fc = fa
		}

		const stepTolerance = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tolerance
		const midpoint = 0.5 * (c - b)

		if (Math.abs(fb) <= functionTolerance || Math.abs(midpoint) <= stepTolerance) {
			return { root: b, value: fb, iterations, converged: true }
		}

		if (Math.abs(e) >= stepTolerance && Math.abs(fa) > Math.abs(fb)) {
			const s = fb / fa
			let p: number
			let q: number

			if (a === c) {
				p = 2 * midpoint * s
				q = 1 - s
			} else {
				q = fa / fc
				const r = fb / fc
				p = s * (2 * midpoint * q * (q - r) - (b - a) * (r - 1))
				q = (q - 1) * (r - 1) * (s - 1)
			}

			if (p > 0) q = -q
			p = Math.abs(p)

			const minStep = Math.min(3 * midpoint * q - Math.abs(stepTolerance * q), Math.abs(e * q))

			if (2 * p < minStep) {
				e = d
				d = p / q
			} else {
				d = midpoint
				e = d
			}
		} else {
			d = midpoint
			e = d
		}

		a = b
		fa = fb
		b += Math.abs(d) > stepTolerance ? d : copySign(stepTolerance, midpoint)
		fb = f(b)

		if (!Number.isFinite(fb)) throw new Error('function must return finite values inside the root bracket')
	}

	return { root: b, value: fb, iterations: maxIterations, converged: false }
}

// Finds a scalar root using the secant method.
export function secantRoot(f: (x: number) => number, x0: number, x1: number, { maxIterations = DEFAULT_ROOT_ITERATIONS, tolerance = DEFAULT_ROOT_TOLERANCE, functionTolerance = DEFAULT_FUNCTION_TOLERANCE }: RootFindingOptions = {}): RootFindingResult {
	let previous = x0
	let current = x1
	let fPrevious = f(previous)
	let fCurrent = f(current)

	validateFiniteValue(previous, fPrevious)
	validateFiniteValue(current, fCurrent)

	if (Math.abs(fPrevious) <= functionTolerance) return { root: previous, value: fPrevious, iterations: 0, converged: true }
	if (Math.abs(fCurrent) <= functionTolerance) return { root: current, value: fCurrent, iterations: 0, converged: true }

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		const denominator = fCurrent - fPrevious

		if (denominator === 0) {
			return { root: current, value: fCurrent, iterations, converged: false }
		}

		const next = current - (fCurrent * (current - previous)) / denominator
		const fNext = f(next)

		validateFiniteValue(next, fNext)

		if (Math.abs(fNext) <= functionTolerance || Math.abs(next - current) <= tolerance) {
			return { root: next, value: fNext, iterations, converged: true }
		}

		previous = current
		fPrevious = fCurrent
		current = next
		fCurrent = fNext
	}

	return { root: current, value: fCurrent, iterations: maxIterations, converged: false }
}

// Finds a bracketed scalar root using the Illinois false-position method.
export function falsePositionRoot(f: (x: number) => number, min: number, max: number, { maxIterations = DEFAULT_ROOT_ITERATIONS, tolerance = DEFAULT_ROOT_TOLERANCE, functionTolerance = DEFAULT_FUNCTION_TOLERANCE }: RootFindingOptions = {}): RootFindingResult {
	let a = min
	let b = max
	let fa = f(a)
	let fb = f(b)

	validateBracket(a, b, fa, fb)

	if (Math.abs(fa) <= functionTolerance) return { root: a, value: fa, iterations: 0, converged: true }
	if (Math.abs(fb) <= functionTolerance) return { root: b, value: fb, iterations: 0, converged: true }

	let root = a
	let value = fa

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		root = (a * fb - b * fa) / (fb - fa)
		value = f(root)

		validateFiniteValue(root, value)

		if (Math.abs(value) <= functionTolerance || Math.abs(b - a) <= tolerance) {
			return { root, value, iterations, converged: true }
		}

		if (hasOppositeSigns(fa, value)) {
			b = root
			fb = value
			fa *= 0.5
		} else {
			a = root
			fa = value
			fb *= 0.5
		}
	}

	return { root, value, iterations: maxIterations, converged: false }
}

// Minimizes a scalar function over a bracket using golden-section search.
export function goldenSectionSearch(f: (x: number) => number, min: number, max: number, { maxIterations = DEFAULT_SCALAR_ITERATIONS, tolerance = DEFAULT_SCALAR_TOLERANCE }: ScalarMinimizationOptions = {}): ScalarMinimizationResult {
	let a = min
	let b = max
	let c = a + GOLDEN_SECTION * (b - a)
	let d = b - GOLDEN_SECTION * (b - a)
	let fc = f(c)
	let fd = f(d)

	validateFiniteValue(c, fc)
	validateFiniteValue(d, fd)

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		if (Math.abs(b - a) <= tolerance) {
			const minimum = 0.5 * (a + b)
			const value = f(minimum)
			validateFiniteValue(minimum, value)
			return { minimum, value, iterations, converged: true }
		}

		if (fc < fd) {
			b = d
			d = c
			fd = fc
			c = a + GOLDEN_SECTION * (b - a)
			fc = f(c)
			validateFiniteValue(c, fc)
		} else {
			a = c
			c = d
			fc = fd
			d = b - GOLDEN_SECTION * (b - a)
			fd = f(d)
			validateFiniteValue(d, fd)
		}
	}

	const minimum = fc < fd ? c : d
	const value = fc < fd ? fc : fd
	return { minimum, value, iterations: maxIterations, converged: false }
}

// Minimizes a scalar function over a bracket using Brent's method.
export function brentMinimize(f: (x: number) => number, min: number, max: number, { maxIterations = DEFAULT_SCALAR_ITERATIONS, tolerance = DEFAULT_SCALAR_TOLERANCE }: ScalarMinimizationOptions = {}): ScalarMinimizationResult {
	let a = min
	let b = max
	let x = 0.5 * (a + b)
	let w = x
	let v = x
	let fx = f(x)
	let fw = fx
	let fv = fx
	let d = 0
	let e = 0

	validateFiniteValue(x, fx)

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		const midpoint = 0.5 * (a + b)
		const tol1 = tolerance * Math.abs(x) + Number.EPSILON
		const tol2 = 2 * tol1

		if (Math.abs(x - midpoint) <= tol2 - 0.5 * (b - a)) {
			return { minimum: x, value: fx, iterations, converged: true }
		}

		if (Math.abs(e) > tol1) {
			const r = (x - w) * (fx - fv)
			let q = (x - v) * (fx - fw)
			let p = (x - v) * q - (x - w) * r
			q = 2 * (q - r)

			if (q > 0) p = -p
			q = Math.abs(q)

			const previousE = e
			e = d

			if (Math.abs(p) >= Math.abs(0.5 * q * previousE) || p <= q * (a - x) || p >= q * (b - x)) {
				e = x >= midpoint ? a - x : b - x
				d = GOLDEN_SECTION * e
			} else {
				d = p / q
				const u = x + d

				if (u - a < tol2 || b - u < tol2) {
					d = copySign(tol1, midpoint - x)
				}
			}
		} else {
			e = x >= midpoint ? a - x : b - x
			d = GOLDEN_SECTION * e
		}

		const u = Math.abs(d) >= tol1 ? x + d : x + copySign(tol1, d)
		const fu = f(u)

		validateFiniteValue(u, fu)

		if (fu <= fx) {
			if (u >= x) a = x
			else b = x
			v = w
			fv = fw
			w = x
			fw = fx
			x = u
			fx = fu
		} else {
			if (u < x) a = u
			else b = u

			if (fu <= fw || w === x) {
				v = w
				fv = fw
				w = u
				fw = fu
			} else if (fu <= fv || v === x || v === w) {
				v = u
				fv = fu
			}
		}
	}

	return { minimum: x, value: fx, iterations: maxIterations, converged: false }
}

// Minimizes a multivariate function using Nelder-Mead simplex search.
export function nelderMead(
	f: (params: Readonly<NumberArray>) => number,
	initial: Readonly<NumberArray>,
	{ maxIterations = DEFAULT_MULTIVARIATE_ITERATIONS, tolerance = DEFAULT_MULTIVARIATE_TOLERANCE, initialStep = DEFAULT_INITIAL_STEP, reflection = 1, expansion = 2, contraction = 0.5, shrink = 0.5 }: NelderMeadOptions = {},
): MultivariateMinimizationResult {
	const dimensions = initial.length
	const simplex = new Array<Float64Array>(dimensions + 1)
	const values = new Float64Array(dimensions + 1)

	simplex[0] = new Float64Array(initial)
	values[0] = f(simplex[0])
	validateFiniteValue(0, values[0])

	for (let i = 0; i < dimensions; i++) {
		const vertex = new Float64Array(initial)
		vertex[i] += initialStep
		simplex[i + 1] = vertex
		values[i + 1] = f(vertex)
		validateFiniteValue(i + 1, values[i + 1])
	}

	const centroid = new Float64Array(dimensions)
	const reflected = new Float64Array(dimensions)
	const expanded = new Float64Array(dimensions)
	const contracted = new Float64Array(dimensions)

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		sortSimplex(simplex, values)

		if (simplexConverged(simplex, values, tolerance)) {
			return { minimum: simplex[0], value: values[0], iterations, converged: true }
		}

		fillCentroid(simplex, centroid)
		reflectPoint(centroid, simplex[dimensions], reflection, reflected)
		const reflectedValue = f(reflected)
		validateFiniteValue(0, reflectedValue)

		if (reflectedValue < values[0]) {
			extendPoint(centroid, reflected, expansion, expanded)
			const expandedValue = f(expanded)
			validateFiniteValue(0, expandedValue)

			if (expandedValue < reflectedValue) replaceSimplexWorst(simplex, values, expanded, expandedValue)
			else replaceSimplexWorst(simplex, values, reflected, reflectedValue)
		} else if (reflectedValue < values[dimensions - 1]) {
			replaceSimplexWorst(simplex, values, reflected, reflectedValue)
		} else {
			const outside = reflectedValue < values[dimensions]
			const contractionSource = outside ? reflected : simplex[dimensions]
			extendPoint(centroid, contractionSource, contraction, contracted)
			const contractedValue = f(contracted)
			validateFiniteValue(0, contractedValue)

			if (contractedValue < (outside ? reflectedValue : values[dimensions])) {
				replaceSimplexWorst(simplex, values, contracted, contractedValue)
			} else {
				shrinkSimplex(f, simplex, values, shrink)
			}
		}
	}

	sortSimplex(simplex, values)
	return { minimum: simplex[0], value: values[0], iterations: maxIterations, converged: false }
}

// Minimizes a multivariate function by repeatedly optimizing each coordinate direction.
export function coordinateDescent(
	f: (params: Readonly<NumberArray>) => number,
	initial: Readonly<NumberArray>,
	{ maxIterations = DEFAULT_MULTIVARIATE_ITERATIONS, tolerance = DEFAULT_MULTIVARIATE_TOLERANCE, initialStep = DEFAULT_INITIAL_STEP, stepReduction = 0.5 }: CoordinateDescentOptions = {},
): MultivariateMinimizationResult {
	const current = new Float64Array(initial)
	const direction = new Float64Array(initial.length)
	let value = f(current)
	let step = initialStep

	validateFiniteValue(0, value)

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		const previousValue = value

		for (let i = 0; i < current.length; i++) {
			direction.fill(0)
			direction[i] = 1

			const result = minimizeAlongDirection(f, current, direction, step, tolerance)
			current.set(result.point)
			value = result.value
		}

		// A full pass that no longer improves means the current step size is exhausted. Shrink it to
		// refine the search, and only declare convergence once the step itself drops below tolerance.
		if (Math.abs(previousValue - value) <= tolerance) {
			if (step <= tolerance) {
				return { minimum: current, value, iterations, converged: true }
			}

			step *= stepReduction
		}
	}

	return { minimum: current, value, iterations: maxIterations, converged: false }
}

// Minimizes a multivariate function using Powell's derivative-free direction-set method.
export function powell(f: (params: Readonly<NumberArray>) => number, initial: Readonly<NumberArray>, { maxIterations = DEFAULT_MULTIVARIATE_ITERATIONS, tolerance = DEFAULT_MULTIVARIATE_TOLERANCE, initialStep = DEFAULT_INITIAL_STEP, lineTolerance = tolerance }: PowellOptions = {}): MultivariateMinimizationResult {
	const dimensions = initial.length
	const current = new Float64Array(initial)
	const directions = new Array<Float64Array>(dimensions)
	let value = f(current)

	validateFiniteValue(0, value)

	for (let i = 0; i < dimensions; i++) {
		const direction = new Float64Array(dimensions)
		direction[i] = 1
		directions[i] = direction
	}

	for (let iterations = 1; iterations <= maxIterations; iterations++) {
		const start = new Float64Array(current)
		const startValue = value
		let biggestDecrease = 0
		let biggestDirection = 0

		for (let i = 0; i < dimensions; i++) {
			const previousValue = value
			const result = minimizeAlongDirection(f, current, directions[i], initialStep, lineTolerance)
			current.set(result.point)
			value = result.value

			const decrease = previousValue - value
			if (decrease > biggestDecrease) {
				biggestDecrease = decrease
				biggestDirection = i
			}
		}

		const displacement = subtract(current, start)
		const displacementNorm = vectorNorm(displacement)

		if (Math.abs(startValue - value) <= tolerance || displacementNorm <= tolerance) {
			return { minimum: current, value, iterations, converged: true }
		}

		if (displacementNorm > 0) {
			const result = minimizeAlongDirection(f, current, displacement, initialStep, lineTolerance)

			if (result.value < value) {
				current.set(result.point)
				value = result.value
				directions[biggestDirection] = displacement
			}
		}
	}

	return { minimum: current, value, iterations: maxIterations, converged: false }
}

// Computes the parameters of a Levenberg-Marquardt model.
// This is a non-linear least squares optimization algorithm.
// It minimizes the sum of squared residuals between the model and the data.
export function levenbergMarquardt(x: Readonly<NumberArray>, y: Readonly<NumberArray>, model: (x: number, params: NumberArray) => number, params: number[], { maxIterations = 100, lambda = 0.01, tolerance = 1e-6, weights }: LevenbergMarquardtOptions = {}) {
	const n = Math.min(x.length, y.length)
	const m = params.length
	if (weights !== undefined) {
		if (weights.length < n) throw new RangeError('weights must contain one value per sample')
		for (let i = 0; i < n; i++) if (!Number.isFinite(weights[i]) || weights[i] < 0) throw new RangeError('weights must be finite and non-negative')
	}

	const J = new Array<Float64Array>(m)
	const PJ = new Float64Array(m)
	const JTJ = Matrix.square(m) // base (undamped) JᵀJ, reused across rejected steps
	const JTJData = JTJ.data
	const damped = Matrix.square(m) // working damped copy consumed by the linear solve
	const dampedData = damped.data
	const JTR = new Float64Array(m) // base JᵀR
	const JTRWork = new Float64Array(m) // working copy consumed by the linear solve

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

	// Residuals and the Jacobian depend only on the parameters, so they are rebuilt on acceptance (and
	// initially) but reused across rejected steps, which only re-damp the diagonal and re-solve.
	let needsJacobian = true
	let error = 0

	while (maxIterations-- > 0) {
		if (needsJacobian) {
			predict(params, YP)

			// residual and current sum of squares
			error = 0
			for (let i = 0; i < n; i++) {
				const ri = y[i] - YP[i]
				R[i] = ri
				error += (weights?.[i] ?? 1) * ri * ri
			}

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
				for (let k = 0; k < n; k++) sum += (weights?.[k] ?? 1) * Ji[k] * R[k]
				JTR[i] = sum

				const iOffset = i * m

				for (let j = i; j < m; j++) {
					const Jj = J[j]

					let dot = 0
					for (let k = 0; k < n; k++) dot += (weights?.[k] ?? 1) * Ji[k] * Jj[k]

					JTJData[iOffset + j] = dot
					JTJData[j * m + i] = dot
				}
			}

			needsJacobian = false
		}

		// Damp a fresh copy of JᵀJ so the base matrix survives a possible rejected retry.
		for (let i = 0; i < dampedData.length; i++) dampedData[i] = JTJData[i]
		for (let i = 0, p = 0; i < m; i++, p += m) {
			dampedData[p + i] *= 1 + lambda
		}

		// Solve (JᵀJ + λ·diag) * dp = Jᵀr on working copies (the solver mutates them).
		JTRWork.set(JTR)
		gaussianElimination(damped, JTRWork, DP)

		if (Number.isNaN(DP[0])) break

		// Update parameters.
		for (let i = 0; i < m; i++) UP[i] = params[i] + DP[i]
		predict(UP, YPJ)

		let newError = 0
		for (let i = 0; i < n; i++) {
			const di = y[i] - YPJ[i]
			newError += (weights?.[i] ?? 1) * di * di
		}

		if (newError < error) {
			const improvement = error - newError
			for (let i = 0; i < m; i++) params[i] = UP[i]
			error = newError
			needsJacobian = true
			if (improvement <= tolerance) break
			lambda /= 10
		} else {
			lambda *= 10
		}
	}

	return params
}

// Validates that a scalar root bracket has finite values with opposite signs.
function validateBracket(a: number, b: number, fa: number, fb: number) {
	validateFiniteValue(a, fa)
	validateFiniteValue(b, fb)

	if (fa !== 0 && fb !== 0 && !hasOppositeSigns(fa, fb)) {
		throw new Error('root bracket endpoints must have opposite signs')
	}
}

// Validates a finite function value.
function validateFiniteValue(x: number, value: number) {
	if (!Number.isFinite(x) || !Number.isFinite(value)) {
		throw new TypeError('function must return finite values')
	}
}

// Checks whether values have opposite signs.
function hasOppositeSigns(a: number, b: number) {
	return (a < 0 && b > 0) || (a > 0 && b < 0)
}

// Checks whether values have the same sign.
function hasSameSign(a: number, b: number) {
	return (a < 0 && b < 0) || (a > 0 && b > 0)
}

// Copies the sign of signSource into the positive magnitude value.
function copySign(value: number, signSource: number) {
	return signSource >= 0 ? Math.abs(value) : -Math.abs(value)
}

// Sorts simplex vertices in ascending objective-value order.
function sortSimplex(simplex: Float64Array[], values: Float64Array) {
	for (let i = 1; i < values.length; i++) {
		const value = values[i]
		const vertex = simplex[i]
		let j = i - 1

		while (j >= 0 && values[j] > value) {
			values[j + 1] = values[j]
			simplex[j + 1] = simplex[j]
			j--
		}

		values[j + 1] = value
		simplex[j + 1] = vertex
	}
}

// Checks simplex convergence from objective and coordinate spreads.
function simplexConverged(simplex: Float64Array[], values: Float64Array, tolerance: number) {
	const best = simplex[0]
	const bestValue = values[0]
	let coordinateSpread = 0
	let valueSpread = 0

	for (let i = 1; i < simplex.length; i++) {
		valueSpread = Math.max(valueSpread, Math.abs(values[i] - bestValue))

		const vertex = simplex[i]
		for (let j = 0; j < best.length; j++) {
			coordinateSpread = Math.max(coordinateSpread, Math.abs(vertex[j] - best[j]))
		}
	}

	return coordinateSpread <= tolerance && valueSpread <= tolerance
}

// Computes the centroid of all simplex vertices except the worst one.
function fillCentroid(simplex: Float64Array[], centroid: Float64Array) {
	centroid.fill(0)

	for (let i = 0; i < simplex.length - 1; i++) {
		const vertex = simplex[i]
		for (let j = 0; j < centroid.length; j++) centroid[j] += vertex[j]
	}

	const scale = 1 / (simplex.length - 1)
	for (let j = 0; j < centroid.length; j++) centroid[j] *= scale
}

// Reflects source away from the centroid by the requested coefficient.
function reflectPoint(centroid: Float64Array, source: Float64Array, coefficient: number, output: Float64Array) {
	for (let i = 0; i < output.length; i++) {
		output[i] = centroid[i] + coefficient * (centroid[i] - source[i])
	}
}

// Extends from the centroid toward a source point by the requested coefficient.
function extendPoint(centroid: Float64Array, source: Float64Array, coefficient: number, output: Float64Array) {
	for (let i = 0; i < output.length; i++) {
		output[i] = centroid[i] + coefficient * (source[i] - centroid[i])
	}
}

// Replaces the worst simplex vertex with a copied point.
function replaceSimplexWorst(simplex: Float64Array[], values: Float64Array, point: Float64Array, value: number) {
	const worst = simplex.length - 1
	simplex[worst] = new Float64Array(point)
	values[worst] = value
}

// Shrinks every simplex vertex toward the current best vertex.
function shrinkSimplex(f: (params: Readonly<NumberArray>) => number, simplex: Float64Array[], values: Float64Array, shrink: number) {
	const best = simplex[0]

	for (let i = 1; i < simplex.length; i++) {
		const vertex = simplex[i]

		for (let j = 0; j < vertex.length; j++) {
			vertex[j] = best[j] + shrink * (vertex[j] - best[j])
		}

		values[i] = f(vertex)
		validateFiniteValue(i, values[i])
	}
}

// Minimizes a function along a direction using a bracketed scalar Brent search.
function minimizeAlongDirection(f: (params: Readonly<NumberArray>) => number, point: Float64Array, direction: Float64Array, step: number, tolerance: number) {
	const bracket = bracketLineMinimum(f, point, direction, step)
	const objective = (alpha: number) => f(pointAlongDirection(point, direction, alpha))
	const result = brentMinimize(objective, bracket[0], bracket[1], { tolerance })
	const next = pointAlongDirection(point, direction, result.minimum)

	return { point: next, value: result.value }
}

// Finds a scalar bracket around a line minimum.
function bracketLineMinimum(f: (params: Readonly<NumberArray>) => number, point: Float64Array, direction: Float64Array, step: number) {
	const f0 = f(point)
	let a = 0
	let fa = f0
	let b = step
	let fb = f(pointAlongDirection(point, direction, b))
	let reverse = -step
	let fReverse = f(pointAlongDirection(point, direction, reverse))

	validateFiniteValue(a, fa)
	validateFiniteValue(b, fb)
	validateFiniteValue(reverse, fReverse)

	if (fReverse < fb) {
		// Backward is downhill: make it the bracket end and reuse the already-evaluated forward value
		// (f at +step) as the opposite probe instead of recomputing it.
		const forward = fb
		b = reverse
		fb = fReverse
		reverse = step
		fReverse = forward
	}

	if (fb >= fa && fReverse >= fa) {
		return orderedPair(reverse, b)
	}

	for (let i = 0; i < DEFAULT_SCALAR_ITERATIONS; i++) {
		const c = b + GOLDEN_RATIO * (b - a)
		const fc = f(pointAlongDirection(point, direction, c))

		validateFiniteValue(c, fc)

		if (fc >= fb) return orderedPair(a, c)

		a = b
		fa = fb
		b = c
		fb = fc
	}

	return orderedPair(a, b)
}

// Computes a point translated along a direction by alpha.
function pointAlongDirection(point: Float64Array, direction: Float64Array, alpha: number) {
	const output = new Float64Array(point.length)
	for (let i = 0; i < point.length; i++) output[i] = point[i] + alpha * direction[i]
	return output
}

// Computes the vector difference a - b.
function subtract(a: Float64Array, b: Float64Array) {
	const output = new Float64Array(a.length)
	for (let i = 0; i < a.length; i++) output[i] = a[i] - b[i]
	return output
}

// Computes the Euclidean norm of a vector.
function vectorNorm(a: Float64Array) {
	let sum = 0
	for (let i = 0; i < a.length; i++) sum += a[i] * a[i]
	return Math.sqrt(sum)
}

// Returns a sorted scalar pair.
function orderedPair(a: number, b: number) {
	return a < b ? ([a, b] as const) : ([b, a] as const)
}
