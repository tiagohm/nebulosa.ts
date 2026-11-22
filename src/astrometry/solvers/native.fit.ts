import { eraC2s } from '../../astronomy/coordinates/erfa/erfa'
import type { MutVec3, Vec3 } from '../../math/linear-algebra/vec3'
import { starCoordinates } from './quad.code'

// Gnomonic (TAN) world coordinate system of the native solver and its least-squares fits from pixel/sky
// correspondences. Pixels are FITS 1-based coordinates (the center of the first sample is (1, 1)); the tangent
// plane coordinates are xi toward east and eta toward north, in radians, so that (xi, eta) = CD·(x − CRPIX1,
// y − CRPIX2) with the CD matrix in radians per pixel. fitSimilarityTanWcs is the closed-form 2D Procrustes
// solution with isotropic scale in complex form, z_sky = c·z_pixel (direct) or c·conj(z_pixel) (mirrored),
// which needs no SVD; fitLinearTanWcs fits the full 4-parameter CD with the tangent point refitted. Every fit
// can move CRPIX to a requested pixel and CRVAL to the sky point under it, so the CD matrix and the tangent point
// always describe the same reference point.

// A TAN world coordinate system.
export interface TanWcs {
	// ICRS unit vector of the tangent point (CRVAL).
	readonly crval: Vec3
	// FITS pixel of the tangent point.
	readonly crpix1: number
	readonly crpix2: number
	// CD matrix, radians per pixel, row-major: (xi, eta) = [[cd11, cd12], [cd21, cd22]]·(u, v).
	readonly cd11: number
	readonly cd12: number
	readonly cd21: number
	readonly cd22: number
}

// A fitted WCS and the weighted mean squared residual of the fit, radians².
export interface TanWcsFit {
	// Fitted WCS.
	readonly wcs: TanWcs
	// Weighted mean squared tangent-plane residual of the pairs, radians².
	readonly residual: number
	// Whether the fit is mirrored (negative CD determinant).
	readonly flipped: boolean
}

// East and north unit vectors at a tangent point, for deprojection.
function tangentBasis(r: Vec3, east: MutVec3, north: MutVec3) {
	const norm = Math.hypot(r[0], r[1])

	// The same pole test as starCoordinates, so that projection and deprojection always use one basis.
	if (r[2] === 1 || r[2] === -1 || norm === 0) {
		// At a pole star_coords projects onto x and y directly (x/z, y/z at the north pole, -x/z, y/z at the south),
		// which this basis inverts.
		east[0] = 1
		east[1] = 0
		east[2] = 0
		north[0] = 0
		north[1] = r[2] > 0 ? 1 : -1
		north[2] = 0
		return
	}

	east[0] = -r[1] / norm
	east[1] = r[0] / norm
	east[2] = 0
	north[0] = -r[2] * east[1]
	north[1] = r[2] * east[0]
	north[2] = r[0] * east[1] - r[1] * east[0]
}

// Scratch buffers of the projections; never escape.
const EAST: MutVec3 = [0, 0, 0]
const NORTH: MutVec3 = [0, 0, 0]
const PLANE: [number, number] = [0, 0]

// Deprojects tangent-plane coordinates (xi, eta), radians, around r into a unit vector.
export function tangentToSky(r: Vec3, xi: number, eta: number, out: MutVec3 = [0, 0, 0]): MutVec3 {
	tangentBasis(r, EAST, NORTH)
	const x = r[0] + xi * EAST[0] + eta * NORTH[0]
	const y = r[1] + xi * EAST[1] + eta * NORTH[1]
	const z = r[2] + xi * EAST[2] + eta * NORTH[2]
	const length = Math.hypot(x, y, z)
	out[0] = x / length
	out[1] = y / length
	out[2] = z / length
	return out
}

// Maps a FITS pixel to its ICRS unit vector.
export function tanPixelToSky(wcs: TanWcs, x: number, y: number, out: MutVec3 = [0, 0, 0]): MutVec3 {
	const u = x - wcs.crpix1
	const v = y - wcs.crpix2
	return tangentToSky(wcs.crval, wcs.cd11 * u + wcs.cd12 * v, wcs.cd21 * u + wcs.cd22 * v, out)
}

// Maps an ICRS unit vector to its FITS pixel, written to out. Returns false when the star lies on the far hemisphere.
export function tanSkyToPixel(wcs: TanWcs, s: Vec3, out: [number, number]) {
	if (!starCoordinates(s, wcs.crval, PLANE)) return false
	const determinant = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21
	const xi = PLANE[0]
	const eta = PLANE[1]
	out[0] = wcs.crpix1 + (wcs.cd22 * xi - wcs.cd12 * eta) / determinant
	out[1] = wcs.crpix2 + (-wcs.cd21 * xi + wcs.cd11 * eta) / determinant
	return true
}

// Plate scale of a WCS, radians per pixel: the square root of the absolute CD determinant.
export function tanWcsScale(wcs: TanWcs) {
	return Math.sqrt(Math.abs(wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21))
}

// Moves the reference point of a WCS to the FITS pixel (x, y), keeping its CD matrix.
export function recenterTanWcs(wcs: TanWcs, x: number, y: number): TanWcs {
	return { ...wcs, crval: tanPixelToSky(wcs, x, y), crpix1: x, crpix2: y }
}

// Right ascension and declination of the tangent point, radians.
export function tanWcsCenter(wcs: TanWcs) {
	return eraC2s(wcs.crval[0], wcs.crval[1], wcs.crval[2])
}

// Correspondences between FITS pixels and ICRS unit vectors, with optional non-negative weights.
export interface TanCorrespondences {
	// Number of pairs.
	readonly count: number
	// FITS pixel x of pair i.
	readonly x: ArrayLike<number>
	// FITS pixel y of pair i.
	readonly y: ArrayLike<number>
	// Unit vectors, 3 per pair.
	readonly vectors: ArrayLike<number>
	// Weight of pair i; 1 when absent.
	readonly weights?: ArrayLike<number>
}

// Scratch vector for correspondence access.
const STAR: MutVec3 = [0, 0, 0]

// Reads the unit vector of pair i into STAR.
function pairVector(pairs: TanCorrespondences, i: number) {
	STAR[0] = pairs.vectors[i * 3]
	STAR[1] = pairs.vectors[i * 3 + 1]
	STAR[2] = pairs.vectors[i * 3 + 2]
	return STAR
}

// Weighted, normalized mean direction of the pairs.
function meanDirection(pairs: TanCorrespondences): MutVec3 {
	let x = 0
	let y = 0
	let z = 0

	for (let i = 0; i < pairs.count; i++) {
		const w = pairs.weights?.[i] ?? 1
		x += w * pairs.vectors[i * 3]
		y += w * pairs.vectors[i * 3 + 1]
		z += w * pairs.vectors[i * 3 + 2]
	}

	const length = Math.hypot(x, y, z)
	return [x / length, y / length, z / length]
}

// Fits a similarity TAN WCS (rotation, isotropic scale, optional mirror) to at least 2 pairs. parity forces
// the direct (false) or mirrored (true) model; undefined keeps the one with the lower residual. When crpix is
// given, the result is re-referenced to that FITS pixel. Returns undefined for degenerate input (coincident
// pixels or stars on the far hemisphere of their mean direction).
export function fitSimilarityTanWcs(pairs: TanCorrespondences, parity?: boolean, crpix?: readonly [number, number]): TanWcsFit | undefined {
	let fit = similarityAround(pairs, meanDirection(pairs), parity)
	if (fit === undefined || crpix === undefined) return fit

	// Refit on the tangent plane of the requested reference pixel so the CD matrix belongs to it.
	for (let iteration = 0; iteration < 2 && fit !== undefined; iteration++) {
		fit = similarityAround(pairs, tanPixelToSky(fit.wcs, crpix[0], crpix[1]), parity)
	}

	return fit === undefined ? undefined : { ...fit, wcs: recenterTanWcs(fit.wcs, crpix[0], crpix[1]) }
}

// Closed-form similarity fit on the tangent plane of r.
function similarityAround(pairs: TanCorrespondences, r: Vec3, parity: boolean | undefined): TanWcsFit | undefined {
	const n = pairs.count
	const xi = new Float64Array(n)
	const eta = new Float64Array(n)
	let sw = 0
	let mx = 0
	let my = 0
	let mxi = 0
	let meta = 0

	for (let i = 0; i < n; i++) {
		if (!starCoordinates(pairVector(pairs, i), r, PLANE)) return undefined
		xi[i] = PLANE[0]
		eta[i] = PLANE[1]
		const w = pairs.weights?.[i] ?? 1
		sw += w
		mx += w * pairs.x[i]
		my += w * pairs.y[i]
		mxi += w * xi[i]
		meta += w * eta[i]
	}

	if (!(sw > 0)) return undefined

	mx /= sw
	my /= sw
	mxi /= sw
	meta /= sw

	// Complex least squares: c = Σ w·s·conj(q) / Σ w·|q|², with q = p (direct) or conj(p) (mirrored).
	let pp = 0
	let directRe = 0
	let directIm = 0
	let mirrorRe = 0
	let mirrorIm = 0

	for (let i = 0; i < n; i++) {
		const w = pairs.weights?.[i] ?? 1
		const u = pairs.x[i] - mx
		const v = pairs.y[i] - my
		const a = xi[i] - mxi
		const b = eta[i] - meta
		pp += w * (u * u + v * v)
		// s·conj(p) = (a + ib)(u - iv)
		directRe += w * (a * u + b * v)
		directIm += w * (b * u - a * v)
		// s·p = (a + ib)(u + iv)
		mirrorRe += w * (a * u - b * v)
		mirrorIm += w * (b * u + a * v)
	}

	if (!(pp > 0)) return undefined

	const candidates: { readonly flipped: boolean; readonly re: number; readonly im: number }[] = []
	if (parity !== true) candidates.push({ flipped: false, re: directRe / pp, im: directIm / pp })
	if (parity !== false) candidates.push({ flipped: true, re: mirrorRe / pp, im: mirrorIm / pp })

	let best: TanWcsFit | undefined

	for (const { flipped, re, im } of candidates) {
		const cd11 = re
		const cd12 = flipped ? im : -im
		const cd21 = im
		const cd22 = flipped ? -re : re
		let residual = 0

		for (let i = 0; i < n; i++) {
			const w = pairs.weights?.[i] ?? 1
			const u = pairs.x[i] - mx
			const v = pairs.y[i] - my
			residual += w * ((cd11 * u + cd12 * v - (xi[i] - mxi)) ** 2 + (cd21 * u + cd22 * v - (eta[i] - meta)) ** 2)
		}

		residual /= sw
		if (best !== undefined && !(residual < best.residual)) continue

		// The tangent point r has (xi, eta) = (0, 0): its pixel is the centroid minus CD⁻¹·(mean xi, mean eta).
		const determinant = cd11 * cd22 - cd12 * cd21
		if (!(Math.abs(determinant) > 0)) continue
		const crpix1 = mx - (cd22 * mxi - cd12 * meta) / determinant
		const crpix2 = my - (-cd21 * mxi + cd11 * meta) / determinant
		best = { wcs: { crval: [r[0], r[1], r[2]], crpix1, crpix2, cd11, cd12, cd21, cd22 }, residual, flipped }
	}

	return best
}

// Fits the full linear TAN WCS (4-parameter CD and tangent point) to at least 3 pairs with CRPIX fixed at crpix,
// starting from an approximate WCS whose tangent point is refined over iterations. Returns undefined when the
// weighted normal equations are singular.
export function fitLinearTanWcs(pairs: TanCorrespondences, initial: TanWcs, crpix: readonly [number, number] = [initial.crpix1, initial.crpix2], iterations: number = 3): TanWcsFit | undefined {
	let wcs: TanWcs = recenterTanWcs(initial, crpix[0], crpix[1])
	let residual = Infinity

	for (let iteration = 0; iteration < iterations; iteration++) {
		const n = pairs.count
		// Normal equations of [u v 1] against xi and eta.
		let suu = 0
		let suv = 0
		let su = 0
		let svv = 0
		let sv = 0
		let s1 = 0
		let suxi = 0
		let svxi = 0
		let sxi = 0
		let sueta = 0
		let sveta = 0
		let seta = 0
		const xi = new Float64Array(n)
		const eta = new Float64Array(n)

		for (let i = 0; i < n; i++) {
			if (!starCoordinates(pairVector(pairs, i), wcs.crval, PLANE)) return undefined
			const w = pairs.weights?.[i] ?? 1
			const u = pairs.x[i] - crpix[0]
			const v = pairs.y[i] - crpix[1]
			xi[i] = PLANE[0]
			eta[i] = PLANE[1]
			suu += w * u * u
			suv += w * u * v
			su += w * u
			svv += w * v * v
			sv += w * v
			s1 += w
			suxi += w * u * xi[i]
			svxi += w * v * xi[i]
			sxi += w * xi[i]
			sueta += w * u * eta[i]
			sveta += w * v * eta[i]
			seta += w * eta[i]
		}

		const solution = solveSymmetric3(suu, suv, su, svv, sv, s1, suxi, svxi, sxi, sueta, sveta, seta)
		if (solution === undefined) return undefined

		const [cd11, cd12, t1, cd21, cd22, t2] = solution
		const crval = tangentToSky(wcs.crval, t1, t2)
		wcs = { crval, crpix1: crpix[0], crpix2: crpix[1], cd11, cd12, cd21, cd22 }

		residual = 0
		for (let i = 0; i < n; i++) {
			const w = pairs.weights?.[i] ?? 1
			const u = pairs.x[i] - crpix[0]
			const v = pairs.y[i] - crpix[1]
			residual += w * ((cd11 * u + cd12 * v + t1 - xi[i]) ** 2 + (cd21 * u + cd22 * v + t2 - eta[i]) ** 2)
		}
		residual /= s1
	}

	return { wcs, residual, flipped: wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21 < 0 }
}

// Solves the symmetric 3x3 system [[a, b, c], [b, d, e], [c, e, f]]·p = r for two right-hand sides by Cramer's rule.
function solveSymmetric3(a: number, b: number, c: number, d: number, e: number, f: number, r1: number, r2: number, r3: number, q1: number, q2: number, q3: number) {
	const m11 = d * f - e * e
	const m12 = c * e - b * f
	const m13 = b * e - c * d
	const determinant = a * m11 + b * m12 + c * m13
	if (!(Math.abs(determinant) > 1e-300)) return undefined

	const m22 = a * f - c * c
	const m23 = b * c - a * e
	const m33 = a * d - b * b
	const solve = (p1: number, p2: number, p3: number) => [(m11 * p1 + m12 * p2 + m13 * p3) / determinant, (m12 * p1 + m22 * p2 + m23 * p3) / determinant, (m13 * p1 + m23 * p2 + m33 * p3) / determinant] as const
	return [...solve(r1, r2, r3), ...solve(q1, q2, q3)] as const
}
