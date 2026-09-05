import type { Angle } from '../units/angle'
import type { Point } from './geometry'

// Cartesian ellipse geometry in a common length unit. Angles turn from +X toward +Y; functions
// allocate independent results and never mutate their inputs. Axis ordering is not required here.

// A real ellipse with positive semi-axes; theta is the direction of the first axis in radians.
export interface EllipseGeometry {
	// Center in the caller's Cartesian frame and length unit.
	readonly center: Readonly<Point>
	// First positive semi-axis, in the same length unit as the center.
	readonly semiMajor: number
	// Orthogonal positive semi-axis; generic geometry also accepts semiMinor > semiMajor.
	readonly semiMinor: number
	// First-axis direction from +X toward +Y, radians.
	readonly theta: Angle
}

// Bisection limit for the continuous two-dimensional quadratic trust-region problem.
const CONTAINMENT_SOLVER_ITERATIONS = 80

// Maximizes the inner boundary's squared radius after transforming it into the outer unit circle.
// The resulting two-dimensional trust-region problem is solved analytically in the eigenbasis, with
// bisection only for the unique secular root above the largest eigenvalue.
export function maximumNormalizedBoundaryRadiusSquared(outer: EllipseGeometry, inner: EllipseGeometry): number {
	const outerCos = Math.cos(outer.theta)
	const outerSin = Math.sin(outer.theta)
	const innerCos = Math.cos(inner.theta)
	const innerSin = Math.sin(inner.theta)
	const centerX = inner.center.x - outer.center.x
	const centerY = inner.center.y - outer.center.y
	const d0 = (centerX * outerCos + centerY * outerSin) / outer.semiMajor
	const d1 = (-centerX * outerSin + centerY * outerCos) / outer.semiMinor
	const m00 = (inner.semiMajor * (outerCos * innerCos + outerSin * innerSin)) / outer.semiMajor
	const m01 = (inner.semiMinor * (-outerCos * innerSin + outerSin * innerCos)) / outer.semiMajor
	const m10 = (inner.semiMajor * (-outerSin * innerCos + outerCos * innerSin)) / outer.semiMinor
	const m11 = (inner.semiMinor * (outerSin * innerSin + outerCos * innerCos)) / outer.semiMinor
	const a00 = m00 * m00 + m10 * m10
	const a01 = m00 * m01 + m10 * m11
	const a11 = m01 * m01 + m11 * m11
	const b0 = m00 * d0 + m10 * d1
	const b1 = m01 * d0 + m11 * d1
	const constant = d0 * d0 + d1 * d1
	const midpoint = (a00 + a11) * 0.5
	const spectralRadius = Math.hypot((a00 - a11) * 0.5, a01)
	const lowEigenvalue = midpoint - spectralRadius
	const highEigenvalue = midpoint + spectralRadius
	const scale = Math.max(1, Math.abs(highEigenvalue), Math.hypot(b0, b1))

	if (spectralRadius <= Number.EPSILON * scale * 16) return constant + highEigenvalue + 2 * Math.hypot(b0, b1)

	const eigenAngle = Math.atan2(2 * a01, a00 - a11) * 0.5
	const highCos = Math.cos(eigenAngle)
	const highSin = Math.sin(eigenAngle)
	const betaLow = -b0 * highSin + b1 * highCos
	const betaHigh = b0 * highCos + b1 * highSin
	const eigenvalueGap = highEigenvalue - lowEigenvalue
	const hardCaseLow = betaLow / eigenvalueGap
	const hardTolerance = Number.EPSILON * scale * 64
	let unitLow: number
	let unitHigh: number

	if (Math.abs(betaHigh) <= hardTolerance && Math.abs(hardCaseLow) <= 1) {
		unitLow = hardCaseLow
		unitHigh = Math.sqrt(Math.max(0, 1 - unitLow * unitLow)) * (betaHigh < 0 ? -1 : 1)
	} else {
		let lower = highEigenvalue
		let upper = highEigenvalue + Math.max(1, Math.hypot(betaLow, betaHigh))
		for (let i = 0; i < CONTAINMENT_SOLVER_ITERATIONS; i++) {
			const lowTerm = betaLow / (upper - lowEigenvalue)
			const highTerm = betaHigh / (upper - highEigenvalue)
			if (lowTerm * lowTerm + highTerm * highTerm <= 1) break
			upper = highEigenvalue + (upper - highEigenvalue) * 2
		}
		for (let i = 0; i < CONTAINMENT_SOLVER_ITERATIONS; i++) {
			const lambda = (lower + upper) * 0.5
			const lowTerm = betaLow / (lambda - lowEigenvalue)
			const highTerm = betaHigh / (lambda - highEigenvalue)
			if (lowTerm * lowTerm + highTerm * highTerm > 1) lower = lambda
			else upper = lambda
		}
		unitLow = betaLow / (upper - lowEigenvalue)
		unitHigh = betaHigh / (upper - highEigenvalue)
		const norm = Math.hypot(unitLow, unitHigh)
		unitLow /= norm
		unitHigh /= norm
	}

	return constant + lowEigenvalue * unitLow * unitLow + highEigenvalue * unitHigh * unitHigh + 2 * (betaLow * unitLow + betaHigh * unitHigh)
}
