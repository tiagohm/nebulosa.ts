import { TAU } from '../../core/constants'
import { type Vec3, vecDot } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { KeplerOrbit } from './asteroid'

// Minimum Orbit Intersection Distance (MOID): the closest the two orbits ever come to each other as
// geometric curves, minimized over both true anomalies independently. It is time-independent — it depends
// only on the shape and orientation of the two orbits, not on where the bodies are — and is the primary
// screen for potentially hazardous asteroids (an Earth MOID below 0.05 AU makes a future close approach
// geometrically possible). Distances are AU, angles radians.
//
// The distance |r1(nu1) - r2(nu2)| is sampled on a coarse grid over both true anomalies, its local minima
// on the torus are located (two orbits admit up to four), and each is refined by Newton on the squared
// separation, falling back to Gauss-Newton when the Hessian is indefinite. The smallest refined minimum
// is the global MOID. The grid only needs to place a sample in each minimum's basin; the refiner follows
// the (often narrow and diagonal) distance valley to its bottom. The default of 180 samples per orbit
// (2 deg) resolves even near-tangent hazardous-asteroid geometries. Both orbits must be bound
// (eccentricity < 1) and expressed in the same frame.

// The MOID of two orbits and where on each it occurs.
export interface Moid {
	// Minimum orbit intersection distance (AU).
	readonly distance: number
	// True anomaly on the first orbit at the closest point (radians, [0, TAU)).
	readonly trueAnomaly1: Angle
	// True anomaly on the second orbit at the closest point (radians, [0, TAU)).
	readonly trueAnomaly2: Angle
}

// Options for the MOID search.
export interface MoidOptions {
	// Grid resolution per orbit for the coarse search. Defaults to 180 (2 deg). Increase it for orbits
	// whose closest-approach valley is narrow.
	readonly samples?: number
	// Convergence tolerance in radians for the Newton refinement. Defaults to 1e-10.
	readonly tolerance?: number
}

// Finite-difference step (radians) for the orbit tangents and curvatures used in the Newton refinement.
const DERIVATIVE_STEP = 1e-5
// Halvings of a Newton step that increased the distance. 64 reaches below the 1e-10 rad
// default tolerance from a one-cell cap, and bounds the backtrack so a non-finite trial cannot hang.
const MAX_BACKTRACKS = 64

// Computes the minimum orbit intersection distance between two bound orbits.
//
// Both orbits must be elliptical (eccentricity < 1) and given in the same reference frame; the mean
// anomaly and epoch are irrelevant. The result is the global minimum distance and the true anomaly on
// each orbit where it occurs.
export function moid(first: KeplerOrbit, second: KeplerOrbit, options?: MoidOptions): Moid {
	if (!(first.eccentricity < 1) || !(second.eccentricity < 1)) throw new Error('MOID is defined only for bound (elliptical) orbits')

	const samples = options?.samples ?? 180
	const tolerance = options?.tolerance ?? 1e-10
	const step = TAU / samples

	// Sample both orbits once; the grid distance reuses these points.
	const firstPoints = new Array<Vec3>(samples)
	const secondPoints = new Array<Vec3>(samples)
	for (let i = 0; i < samples; i++) {
		firstPoints[i] = first.positionAtTrueAnomaly(i * step)
		secondPoints[i] = second.positionAtTrueAnomaly(i * step)
	}

	// Grid of inter-orbit distances, computed inline to avoid an allocation per cell.
	const grid = new Float64Array(samples * samples)
	for (let i = 0; i < samples; i++) {
		const [ax, ay, az] = firstPoints[i]
		const row = i * samples
		for (let j = 0; j < samples; j++) {
			const b = secondPoints[j]
			const dx = ax - b[0]
			const dy = ay - b[1]
			const dz = az - b[2]
			grid[row + j] = Math.sqrt(dx * dx + dy * dy + dz * dz)
		}
	}

	let best: Moid = { distance: Number.POSITIVE_INFINITY, trueAnomaly1: 0, trueAnomaly2: 0 }

	for (let i = 0; i < samples; i++) {
		for (let j = 0; j < samples; j++) {
			if (!isLocalMinimum(grid, samples, i, j)) continue

			const refined = refine(first, second, i * step, j * step, step, tolerance)
			if (refined.distance < best.distance) best = refined
		}
	}

	return best
}

// Whether cell (i, j) is a local minimum of the distance grid against its eight toroidal neighbours.
function isLocalMinimum(grid: Float64Array, samples: number, i: number, j: number): boolean {
	const value = grid[i * samples + j]
	const iPrev = (i + samples - 1) % samples
	const iNext = (i + 1) % samples
	const jPrev = (j + samples - 1) % samples
	const jNext = (j + 1) % samples
	return (
		value <= grid[iPrev * samples + jPrev] &&
		value <= grid[iPrev * samples + j] &&
		value <= grid[iPrev * samples + jNext] &&
		value <= grid[i * samples + jPrev] &&
		value <= grid[i * samples + jNext] &&
		value <= grid[iNext * samples + jPrev] &&
		value <= grid[iNext * samples + j] &&
		value <= grid[iNext * samples + jNext]
	)
}

// Refines a grid-cell minimum of |D| where D = r1(nu1) - r2(nu2). Newton uses the Hessian of ½||D||²,
// which includes the orbital curvature D·d²r/dν² that Gauss-Newton (JtJ) drops; without it the step
// oscillates when the residual is a large fraction of the Hessian, and coplanar parallel tangents make
// JtJ singular. If that Hessian is not positive definite, the update falls back to Gauss-Newton, then
// to independent 1-D steps along each tangent. Each anomaly increment is capped to one grid cell (L∞)
// so a diagonal step still advances a full cell along both axes while staying in the flagged basin.
// The iteration budget is one step per grid sample, enough to traverse a valley of length π√2 on the
// torus. A step that increases the distance is halved until it descends. The closest point seen,
// including the grid start, is returned if the last iterate is not the minimum.
function refine(first: KeplerOrbit, second: KeplerOrbit, initialNu1: number, initialNu2: number, step: number, tolerance: number): Moid {
	let nu1 = initialNu1
	let nu2 = initialNu2
	let p1 = first.positionAtTrueAnomaly(nu1)
	let p2 = second.positionAtTrueAnomaly(nu2)
	let bestDistance = Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2])
	let bestNu1 = nu1
	let bestNu2 = nu2
	let currentDistance = bestDistance
	const maxIterations = Math.ceil(TAU / step)

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		const separation: Vec3 = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]]
		const d1 = derivatives(first, nu1, p1)
		const d2 = derivatives(second, nu2, p2)

		const a = vecDot(d1.tangent, d1.tangent)
		const c = vecDot(d2.tangent, d2.tangent)
		const b = -vecDot(d1.tangent, d2.tangent)
		const g1 = vecDot(d1.tangent, separation)
		const g2 = -vecDot(d2.tangent, separation)
		const h11 = a + vecDot(separation, d1.curvature)
		const h22 = c - vecDot(separation, d2.curvature)
		const detH = h11 * h22 - b * b
		const detJ = a * c - b * b

		let accepted = false
		for (let mode = 0; mode < 3; mode++) {
			let delta1: number
			let delta2: number
			if (mode === 0) {
				if (!(h11 > 0 && detH > 0)) continue
				delta1 = -(h22 * g1 - b * g2) / detH
				delta2 = -(-b * g1 + h11 * g2) / detH
			} else if (mode === 1) {
				if (!(detJ > 0)) continue
				delta1 = -(c * g1 - b * g2) / detJ
				delta2 = -(-b * g1 + a * g2) / detJ
			} else if (a > 0 || c > 0) {
				delta1 = a > 0 ? -g1 / a : 0
				delta2 = c > 0 ? -g2 / c : 0
			} else {
				break
			}

			// L∞ cap: a diagonal step then advances one grid cell along each anomaly.
			const maxAbs = Math.max(Math.abs(delta1), Math.abs(delta2))
			if (maxAbs > step) {
				delta1 *= step / maxAbs
				delta2 *= step / maxAbs
			}

			for (let backtrack = 0; backtrack < MAX_BACKTRACKS; backtrack++) {
				const trialNu1 = nu1 + delta1
				const trialNu2 = nu2 + delta2
				const trialP1 = first.positionAtTrueAnomaly(trialNu1)
				const trialP2 = second.positionAtTrueAnomaly(trialNu2)
				const trialDistance = Math.hypot(trialP1[0] - trialP2[0], trialP1[1] - trialP2[1], trialP1[2] - trialP2[2])
				if (trialDistance < currentDistance) {
					nu1 = trialNu1
					nu2 = trialNu2
					p1 = trialP1
					p2 = trialP2
					currentDistance = trialDistance
					if (trialDistance < bestDistance) {
						bestDistance = trialDistance
						bestNu1 = nu1
						bestNu2 = nu2
					}
					accepted = true
					break
				}
				delta1 *= 0.5
				delta2 *= 0.5
				if (Math.abs(delta1) < tolerance && Math.abs(delta2) < tolerance) break
			}
			if (accepted) {
				if (Math.abs(delta1) < tolerance && Math.abs(delta2) < tolerance) {
					return { distance: bestDistance, trueAnomaly1: normalizeAngle(bestNu1), trueAnomaly2: normalizeAngle(bestNu2) }
				}
				break
			}
		}
		if (!accepted) break
	}

	return { distance: bestDistance, trueAnomaly1: normalizeAngle(bestNu1), trueAnomaly2: normalizeAngle(bestNu2) }
}

// Orbit tangent dr/dν (AU/rad) and curvature d²r/dν² (AU/rad²) at a true anomaly, by central
// difference about the already evaluated position.
function derivatives(orbit: KeplerOrbit, nu: number, position: Vec3): { tangent: Vec3; curvature: Vec3 } {
	const plus = orbit.positionAtTrueAnomaly(nu + DERIVATIVE_STEP)
	const minus = orbit.positionAtTrueAnomaly(nu - DERIVATIVE_STEP)
	const invTwo = 1 / (2 * DERIVATIVE_STEP)
	const invSq = 1 / (DERIVATIVE_STEP * DERIVATIVE_STEP)
	return {
		tangent: [(plus[0] - minus[0]) * invTwo, (plus[1] - minus[1]) * invTwo, (plus[2] - minus[2]) * invTwo],
		curvature: [(plus[0] - 2 * position[0] + minus[0]) * invSq, (plus[1] - 2 * position[1] + minus[1]) * invSq, (plus[2] - 2 * position[2] + minus[2]) * invSq],
	}
}
