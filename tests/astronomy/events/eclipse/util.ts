import { nearestSolarEclipse } from '../../../../src/astronomy/bodies/sun'
import { DEG2RAD, PI, TAU } from '../../../../src/core/constants'
import { sphericalSeparation } from '../../../../src/math/numerical/geometry'
import { deg, type Angle } from '../../../../src/math/units/angle'
// oxfmt-ignore
import { type SolarEclipseGeoPoint, type PolynomialBesselianElements, intermediateGreatCircle, findEclipseCurvePoint, computePolynomialBesselianElements, computeSolarEclipseMapGeometry, evaluateBesselian, BRANCH_MAX_DRAWABLE_GAP } from '../../../../src/astronomy/events/eclipse/solar/map'
import { F, sunMoonPosition, type EclipseGeoBranch, type EclipseGeoCurve, type SunMoonProvider } from '../../../../src/astronomy/events/eclipse/eclipse'
import { timeYMD, time, Timescale } from '../../../../src/astronomy/time/time'

const CATALOG_STEP = deg(Number.parseFloat(Bun.env.SOLAR_ECLIPSE_CATALOG_STEP_DEG || '0.5'))
const CATALOG_MAX_DRAWABLE_GAP = Math.max(BRANCH_MAX_DRAWABLE_GAP, CATALOG_STEP * 4)
const CATALOG_BRIDGE_BALANCE = 0.75
const CATALOG_RECONNECT_POLE_LATITUDE = deg(85)
const CATALOG_ANCHOR_TOLERANCE = Math.max(CATALOG_STEP, 1e-9)

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
export function limitTangencyResidual(elements: PolynomialBesselianElements, point: SolarEclipseGeoPoint, i: -1 | 1, G: number) {
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
export function countKinks(branch: EclipseGeoBranch, threshold: number) {
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
export function interpolateAtJulianDay(line: EclipseGeoBranch, jd: number) {
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
export function maxBranchSegment(curve: EclipseGeoCurve) {
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

export function fixedSunMoonPosition(rightAscension: number, declination: number = 0): SunMoonProvider {
	return () => ({
		sun: { rightAscension: rightAscension - PI + deg(0.1), declination: 0, distance: 1 },
		moon: { rightAscension, declination, distance: 60 },
		deltaT: 0,
	})
}

export function endpointRetraces(branch: EclipseGeoBranch, fromStart: boolean) {
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

export function catalogBranchRetraces(branch: EclipseGeoBranch, tolerance: Angle, minArcSeparation: Angle) {
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

// Dense latitude seeds for the recursive continuity probe, finer than the coarse meridian-scan seeds so a near-pole
// in-between point sitting in a narrow Newton convergence basin is still found. Kept at least as dense as the
// engine's own bridge seeds, so the probe is ground truth for "a continuous drawable curve exists": if it
// finds one the engine left unbridged, that is a real engine defect, not a probe artifact.
const CATALOG_BRIDGE_SEED_LATITUDES: number[] = []
for (let degrees = -88; degrees <= 88; degrees += 2) CATALOG_BRIDGE_SEED_LATITUDES.push(degrees * DEG2RAD)

// Maximum recursion depth of the continuity probe; 20 deg (CATALOG_BRIDGE_LIMIT) bisected to CATALOG_STEP
// needs ~6 levels, so 10 leaves margin.
const CATALOG_BRIDGE_MAX_DEPTH = 10

// Solves an in-between curve point on the great-circle-midpoint meridian of a..b that lies strictly between
// them (both sub-distances within CATALOG_BRIDGE_BALANCE of the gap), or undefined when none is found.
function solveCatalogBridgeMidpoint(elements: PolynomialBesselianElements, a: SolarEclipseGeoPoint, b: SolarEclipseGeoPoint, i: -1 | 1, G: number) {
	const limit = CATALOG_BRIDGE_BALANCE * sphericalSeparation(a.x, a.y, b.x, b.y)
	const midpoint = intermediateGreatCircle(a, b, 0.5)

	for (const seed of [midpoint.y, a.y, b.y, ...CATALOG_BRIDGE_SEED_LATITUDES]) {
		const candidate = findEclipseCurvePoint(elements, midpoint.x, seed, i, G)
		if (candidate && Math.abs(candidate.y) <= CATALOG_RECONNECT_POLE_LATITUDE && sphericalSeparation(a.x, a.y, candidate.x, candidate.y) <= limit && sphericalSeparation(candidate.x, candidate.y, b.x, b.y) <= limit) return candidate
	}

	return undefined
}

// Whether a continuous drawable curve connects a and b: recursively bisect, solving an in-between curve point
// on each half until the sub-gaps fall to the sampling step. A single lenient midpoint within a fraction of a
// large gap (the previous test) is not enough — over a near-pole 13 deg gap it accepts a coincidental point
// that no continuous limit actually links (the 6255-06-02 umbra-south branches), a false positive that demands
// a merge the engine correctly refuses. Requiring every recursive half to be bridgeable, down to a step that
// can still hold an irreducible fold cusp (CATALOG_MAX_DRAWABLE_GAP), matches the engine's drawable-continuity
// definition and only ever makes the probe stricter, so it can remove false positives but never invent gaps.
export function hasContinuousCurveBetween(elements: PolynomialBesselianElements, a: SolarEclipseGeoPoint, b: SolarEclipseGeoPoint, i: -1 | 1, G: number, _gap: Angle, depth = 0): boolean {
	const gap = sphericalSeparation(a.x, a.y, b.x, b.y)
	if (gap <= CATALOG_STEP) return true
	if (Math.max(Math.abs(a.y), Math.abs(b.y)) > CATALOG_RECONNECT_POLE_LATITUDE) return false

	const midpoint = depth < CATALOG_BRIDGE_MAX_DEPTH ? solveCatalogBridgeMidpoint(elements, a, b, i, G) : undefined
	// No further subdivision possible: continuous only if the remaining gap is already a single drawable step
	// (a vertical-tangent fold cusp leaves one irreducible step), otherwise it is a real discontinuity.
	if (!midpoint) return gap <= CATALOG_MAX_DRAWABLE_GAP

	return hasContinuousCurveBetween(elements, a, midpoint, i, G, 0, depth + 1) && hasContinuousCurveBetween(elements, midpoint, b, i, G, 0, depth + 1)
}
