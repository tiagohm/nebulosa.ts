import { deg, type Angle } from '../src/angle'
import { DEG2RAD, PI, TAU } from '../src/constants'
import { sphericalSeparation } from '../src/geometry'
import { nearestSolarEclipse } from '../src/sun'
// oxfmt-ignore
import { type GeoPoint, type PolynomialBesselianElements, intermediateGreatCircle, findEclipseCurvePoint, computePolynomialBesselianElements, computeSolarEclipseMapGeometry, computeSunMoonPositionAt, evaluateBesselian, BRANCH_MAX_DRAWABLE_GAP, F, type GeoCurve, type GeoBranch } from '../src/sun.eclipse.map'
import * as elpmpp02 from '../src/elpmpp02'
import { timeYMD, type Time, time, Timescale } from '../src/time'
import * as vsop87e from '../src/vsop87e'

const CATALOG_STEP = deg(Number.parseFloat(Bun.env.SOLAR_ECLIPSE_CATALOG_STEP_DEG || '0.5'))
const CATALOG_MAX_DRAWABLE_GAP = Math.max(BRANCH_MAX_DRAWABLE_GAP, CATALOG_STEP * 4)
const CATALOG_BRIDGE_BALANCE = 0.75
const CATALOG_RECONNECT_POLE_LATITUDE = deg(85)
const CATALOG_ANCHOR_TOLERANCE = Math.max(CATALOG_STEP, 1e-9)
const CATALOG_SEED_LATITUDES = [0, deg(20), deg(-20), deg(45), deg(-45), deg(70), deg(-70), deg(82), deg(-82)] as const

// Finite-difference d(mu)/d(normalized time); InstantBesselianElements omits the mu derivative.
export function muRate(elements: PolynomialBesselianElements, jd: number) {
	const a = evaluateBesselian(elements, time(jd, 0, Timescale.TT))
	const b = evaluateBesselian(elements, time(jd, 0.0001, Timescale.TT))
	return (((b.mu - a.mu + 3 * PI) % TAU) - PI) / (0.0001 / elements.step)
}

// Tangency residual of a limit point in Earth radii: |W + i*|E||, the eclipse-condition residual the
// curve solver drives to zero (W is the cross-track offset of the observer from the shadow axis, |E| the
// shadow-edge radius). Near zero means the point lies exactly on the requested magnitude curve: the umbra
// edge for G = 1, the penumbra edge for G = 0. Detects points that did not converge onto the physical limit.
export function limitTangencyResidual(elements: PolynomialBesselianElements, point: GeoPoint, i: -1 | 1, G: number) {
	const be = evaluateBesselian(elements, time(point.jd!, 0, Timescale.TT))
	const dmu = muRate(elements, point.jd!)
	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const H = point.x + be.mu - be.deltaTLongitudeCorrection
	const sinH = Math.sin(H)
	const cosH = Math.cos(H)
	const U = Math.atan(F * Math.tan(point.y))
	const rhoSinPhi = F * Math.sin(U)
	const rhoCosPhi = Math.cos(U)
	const ksi = rhoCosPhi * sinH
	const eta = rhoSinPhi * cosD - rhoCosPhi * cosH * sinD
	const zeta = rhoSinPhi * sinD + rhoCosPhi * cosH * cosD
	const a = be.dx - rhoCosPhi * cosH * dmu
	const b = be.dy - rhoCosPhi * sinH * sinD * dmu
	const n = Math.hypot(a, b)
	const W = ((be.y - eta) * a - (be.x - ksi) * b) / n
	const dL1 = be.l1 - zeta * be.tanF1
	const dL2 = be.l2 - zeta * be.tanF2
	const E = dL1 - G * (dL1 + dL2)
	return Math.abs(W + i * Math.abs(E))
}

// Counts interior vertices whose direction turns by more than threshold radians: the serrilhado detector.
// Antimeridian-wrapping and zero-length steps are skipped. Zero means a smooth physical curve.
export function countKinks(branch: GeoBranch, threshold: number) {
	let count = 0

	for (let i = 1; i < branch.length - 1; i++) {
		const v1x = branch[i].x - branch[i - 1].x
		const v1y = branch[i].y - branch[i - 1].y
		const v2x = branch[i + 1].x - branch[i].x
		const v2y = branch[i + 1].y - branch[i].y
		if (Math.abs(v1x) > PI || Math.abs(v2x) > PI) continue
		const d1 = Math.hypot(v1x, v1y)
		const d2 = Math.hypot(v2x, v2y)
		if (d1 < 1e-9 || d2 < 1e-9) continue
		if (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (d1 * d2)))) > threshold) count++
	}

	return count
}

// Great-circle interpolation of a time-parametrized curve at an arbitrary Julian Day.
export function interpolateAtJulianDay(line: GeoBranch, jd: number) {
	for (let i = 1; i < line.length; i++) {
		if (line[i - 1].jd! <= jd && jd <= line[i].jd!) {
			const fraction = (jd - line[i - 1].jd!) / (line[i].jd! - line[i - 1].jd!)
			return intermediateGreatCircle(line[i - 1], line[i], fraction)
		}
	}

	return undefined
}

// Longest straight projected segment (px) across every subpath of an SVG path string. A subpath starts at
// M and continues with L; antimeridian wraps are emitted as separate subpaths, so a long segment here can
// only come from a real geometry jump (a spike).
export function longestProjectedSegment(pathData: string) {
	let max = 0

	for (const sub of pathData.split('M')) {
		if (sub.length <= 0) continue

		const coordinates = sub.match(/-?\d+(?:\.\d+)?/g)

		if (!coordinates) continue

		for (let i = 2; i + 1 < coordinates.length; i += 2) {
			max = Math.max(max, Math.hypot(+coordinates[i] - +coordinates[i - 2], +coordinates[i + 1] - +coordinates[i - 1]))
		}
	}

	return max
}

// Largest spherical edge between consecutive points within any branch, skipping antimeridian wraps.
export function maxBranchSegment(curve: GeoCurve) {
	let max = 0

	for (const branch of curve) {
		for (let i = 1; i < branch.length; i++) {
			if (Math.abs(branch[i - 1].x - branch[i].x) > PI) continue
			max = Math.max(max, sphericalSeparation(branch[i - 1].x, branch[i - 1].y, branch[i].x, branch[i].y))
		}
	}

	return max
}

export function geometryFor(year: number, month: number, day: number) {
	const STEP = 0.5 * DEG2RAD
	const eclipse = nearestSolarEclipse(timeYMD(year, month, day), true)
	const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
	const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: STEP, maxAngularStep: STEP, includeRiseSetCurves: false })
	return { eclipse, elements, geometry }
}

export function sunMoonPosition(t: Time) {
	return computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon)
}

export function endpointRetraces(branch: GeoBranch, fromStart: boolean) {
	if (branch.length < 4) return false

	const endpoint = fromStart ? branch[0] : branch.at(-1)!
	const opposite = fromStart ? branch.at(-1)! : branch[0]
	let arc = 0
	let farthestDistance = 0

	for (let offset = 1; offset < branch.length - 1; offset++) {
		const k = fromStart ? offset : branch.length - 1 - offset
		const previous = fromStart ? k - 1 : k + 1
		arc += sphericalSeparation(branch[previous].x, branch[previous].y, branch[k].x, branch[k].y)
		const distance = sphericalSeparation(endpoint.x, endpoint.y, branch[k].x, branch[k].y)
		farthestDistance = Math.max(farthestDistance, distance)

		if (arc >= CATALOG_MAX_DRAWABLE_GAP && distance <= CATALOG_ANCHOR_TOLERANCE && farthestDistance > CATALOG_ANCHOR_TOLERANCE && sphericalSeparation(branch[k].x, branch[k].y, opposite.x, opposite.y) > CATALOG_STEP * 4) return true
	}

	return false
}

export function catalogBranchRetraces(branch: GeoBranch, tolerance: Angle, minArcSeparation: Angle) {
	const arc = new Float64Array(branch.length)

	for (let k = 1; k < branch.length; k++) arc[k] = arc[k - 1] + sphericalSeparation(branch[k - 1].x, branch[k - 1].y, branch[k].x, branch[k].y)

	for (let a = 0; a < branch.length; a++) {
		for (let b = a + 1; b < branch.length; b++) {
			if (arc[b] - arc[a] < minArcSeparation) continue
			if (sphericalSeparation(branch[a].x, branch[a].y, branch[b].x, branch[b].y) < tolerance) return true
		}
	}

	return false
}

export function hasContinuousCurveBetween(elements: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, i: -1 | 1, G: number, gap: Angle) {
	const limit = CATALOG_BRIDGE_BALANCE * gap
	const midpoint = intermediateGreatCircle(a, b, 0.5)
	if (Math.max(Math.abs(a.y), Math.abs(b.y), Math.abs(midpoint.y)) > CATALOG_RECONNECT_POLE_LATITUDE) return false

	for (const seed of [midpoint.y, a.y, b.y, ...CATALOG_SEED_LATITUDES]) {
		const candidate = findEclipseCurvePoint(elements, midpoint.x, seed, i, G)
		if (candidate && Math.abs(candidate.y) > CATALOG_RECONNECT_POLE_LATITUDE) continue
		if (candidate && sphericalSeparation(a.x, a.y, candidate.x, candidate.y) <= limit && sphericalSeparation(candidate.x, candidate.y, b.x, b.y) <= limit) return true
	}

	return false
}
