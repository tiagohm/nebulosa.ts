import { TAU } from '../../core/constants'
import { type Vec3, vecDot } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { KeplerOrbit, positionAtTrueAnomaly } from './asteroid'

// Minimum Orbit Intersection Distance (MOID): the closest the two orbits ever come to each other as
// geometric curves, minimized over both true anomalies independently. It is time-independent — it depends
// only on the shape and orientation of the two orbits, not on where the bodies are — and is the primary
// screen for potentially hazardous asteroids (an Earth MOID below 0.05 AU makes a future close approach
// geometrically possible). Distances are AU, angles radians.
//
// The distance |r1(nu1) - r2(nu2)| is sampled on a coarse grid over both true anomalies, its local minima
// on the torus are located (two orbits admit up to four), and each is refined with two-dimensional
// Gauss-Newton on the separation vector. The smallest refined minimum is the global MOID. The grid only
// needs to place a sample in each minimum's basin, since the Gauss-Newton step follows the (often narrow
// and diagonal) distance valley to its bottom; the default of 180 samples per orbit (2 deg) resolves even
// near-tangent hazardous-asteroid geometries. Both orbits must be bound (eccentricity < 1) and expressed
// in the same frame.

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
	// Convergence tolerance in radians for the Gauss-Newton refinement. Defaults to 1e-10.
	readonly tolerance?: number
}

// Maximum Gauss-Newton steps per candidate; convergence is quadratic near the minimum.
const MAX_REFINE_ITERATIONS = 40
// Finite-difference step (radians) for the orbit tangents used in the Gauss-Newton refinement.
const DERIVATIVE_STEP = 1e-5

// Computes the minimum orbit intersection distance between two bound orbits.
//
// Both orbits must be elliptical (eccentricity < 1) and given in the same reference frame; the mean
// anomaly and epoch are irrelevant. The result is the global minimum distance and the true anomaly on
// each orbit where it occurs.
export function moid(first: KeplerOrbit, second: KeplerOrbit, options?: MoidOptions): Moid {
	if (first.eccentricity >= 1 || second.eccentricity >= 1) throw new Error('MOID is defined only for bound (elliptical) orbits')

	const samples = options?.samples ?? 180
	const tolerance = options?.tolerance ?? 1e-10
	const step = TAU / samples

	// Sample both orbits once; the grid distance reuses these points.
	const firstPoints = new Array<Vec3>(samples)
	const secondPoints = new Array<Vec3>(samples)
	for (let i = 0; i < samples; i++) {
		firstPoints[i] = positionAtTrueAnomaly(first, i * step)
		secondPoints[i] = positionAtTrueAnomaly(second, i * step)
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

// Refines a grid-cell minimum with Gauss-Newton on the separation vector D = r1(nu1) - r2(nu2). The
// Jacobian columns are the orbit tangents (t1, -t2), so the normal equations (JtJ) delta = -(Jt D) give a
// full two-dimensional step that follows a diagonal distance valley, where alternating one-dimensional
// minimizations stall. Steps are capped to one grid cell so the search stays in the flagged basin.
function refine(first: KeplerOrbit, second: KeplerOrbit, initialNu1: number, initialNu2: number, step: number, tolerance: number): Moid {
	let nu1 = initialNu1
	let nu2 = initialNu2

	for (let iteration = 0; iteration < MAX_REFINE_ITERATIONS; iteration++) {
		const p1 = positionAtTrueAnomaly(first, nu1)
		const p2 = positionAtTrueAnomaly(second, nu2)
		const separation: Vec3 = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]]

		const t1 = tangent(first, nu1)
		const t2 = tangent(second, nu2)

		const a = vecDot(t1, t1)
		const c = vecDot(t2, t2)
		const b = -vecDot(t1, t2)
		const determinant = a * c - b * b
		if (determinant <= 0) break // parallel tangents: degenerate step, keep the current point

		const g1 = vecDot(t1, separation)
		const g2 = -vecDot(t2, separation)
		let delta1 = -(c * g1 - b * g2) / determinant
		let delta2 = -(-b * g1 + a * g2) / determinant

		// Keep the step within the flagged grid cell so it cannot jump to another basin.
		const magnitude = Math.hypot(delta1, delta2)
		if (magnitude > step) {
			delta1 *= step / magnitude
			delta2 *= step / magnitude
		}

		nu1 += delta1
		nu2 += delta2
		if (Math.abs(delta1) < tolerance && Math.abs(delta2) < tolerance) break
	}

	const p1 = positionAtTrueAnomaly(first, nu1)
	const p2 = positionAtTrueAnomaly(second, nu2)
	return { distance: Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]), trueAnomaly1: normalizeAngle(nu1), trueAnomaly2: normalizeAngle(nu2) }
}

// Orbit position tangent dr/dnu (AU per radian) at a true anomaly, by central difference.
function tangent(orbit: KeplerOrbit, nu: number): Vec3 {
	const plus = positionAtTrueAnomaly(orbit, nu + DERIVATIVE_STEP)
	const minus = positionAtTrueAnomaly(orbit, nu - DERIVATIVE_STEP)
	const scale = 1 / (2 * DERIVATIVE_STEP)
	return [(plus[0] - minus[0]) * scale, (plus[1] - minus[1]) * scale, (plus[2] - minus[2]) * scale]
}
