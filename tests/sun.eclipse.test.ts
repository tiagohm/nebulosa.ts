import { deg, type Angle } from '../src/angle'
import { DEG2RAD, PI, PIOVERTWO, TAU } from '../src/constants'
import { sphericalSeparation } from '../src/geometry'
import { type SolarEclipse, nearestSolarEclipse } from '../src/sun'
// oxfmt-ignore
import { type GeoPoint, type PolynomialBesselianElements, intermediateGreatCircle, findEclipseCurvePoint, type SolarEclipseMapGeometry, centralAxisIntersectsEarth, solarEclipseMapToSvgPaths, computePolynomialBesselianElements, computeSolarEclipseMapGeometry, computeSunMoonPositionAt, evaluateBesselian, BRANCH_MAX_DRAWABLE_GAP, F, } from '../src/sun.eclipse.map'
import { toJulianDay, timeYMD, type Time, time, Timescale } from '../src/time'
import * as vsop87e from '../src/vsop87e'
import * as elpmpp02 from '../src/elpmpp02'
import { expect, test } from 'bun:test'
import { PlateCarree } from '../src/projection'

const CATALOG_FROM_YEAR = Number.parseInt(Bun.env.SOLAR_ECLIPSE_CATALOG_FROM_YEAR || '-2000', 10)
const CATALOG_TO_YEAR = Number.parseInt(Bun.env.SOLAR_ECLIPSE_CATALOG_TO_YEAR || '3000', 10)
const CATALOG_STEP = Number.parseInt(Bun.env.SOLAR_ECLIPSE_CATALOG_STEP_DEG || '0.5', 10)
const CATALOG_RISE_SET_STEP = Number.parseInt(Bun.env.SOLAR_ECLIPSE_CATALOG_RISE_SET_STEP_SECONDS || '600', 10)
const CATALOG_TIMEOUT_MS = Number.parseInt(Bun.env.SOLAR_ECLIPSE_CATALOG_TIMEOUT_MS || '21600000', 10)
const CATALOG_MAX_DRAWABLE_GAP = Math.max(BRANCH_MAX_DRAWABLE_GAP, CATALOG_STEP * 4)
const CATALOG_BRIDGE_LIMIT = deg(20)
const CATALOG_BRIDGE_BALANCE = 0.75
const CATALOG_OVERLAP_ARC = deg(10)
const CATALOG_RECONNECT_POLE_LATITUDE = deg(85)
const CATALOG_ANCHOR_TOLERANCE = Math.max(CATALOG_STEP, 1e-9)
const CATALOG_SEED_LATITUDES = [0, deg(20), deg(-20), deg(45), deg(-45), deg(70), deg(-70), deg(82), deg(-82)] as const

// Finite-difference d(mu)/d(normalized time); InstantBesselianElements omits the mu derivative.
export function muRate(elements: PolynomialBesselianElements, jd: number) {
	const a = evaluateBesselian(elements, time(jd, 0, Timescale.TT))
	const b = evaluateBesselian(elements, time(jd + 1e-4, 0, Timescale.TT))
	return (((b.mu - a.mu + 3 * PI) % TAU) - PI) / (1e-4 / elements.stepDays)
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

// Geometric solar altitude (radians) at a curve point's instant. Curve points must lie on the sunlit side,
// where the Sun is above the horizon (a small negative tolerance absorbs refraction near the contacts).
export function solarAltitude(elements: PolynomialBesselianElements, point: GeoPoint) {
	const be = evaluateBesselian(elements, time(point.jd!, 0, Timescale.TT))
	const H = point.x + be.mu - be.deltaTLongitudeCorrection
	const sinh = Math.sin(be.d) * Math.sin(point.y) + Math.cos(be.d) * Math.cos(point.y) * Math.cos(H)
	return Math.asin(Math.max(-1, Math.min(1, sinh)))
}

// Counts interior vertices whose direction turns by more than threshold radians: the serrilhado detector.
// Antimeridian-wrapping and zero-length steps are skipped. Zero means a smooth physical curve.
export function countKinks(points: readonly GeoPoint[], threshold: number) {
	let count = 0

	for (let i = 1; i < points.length - 1; i++) {
		const v1x = points[i].x - points[i - 1].x
		const v1y = points[i].y - points[i - 1].y
		const v2x = points[i + 1].x - points[i].x
		const v2y = points[i + 1].y - points[i].y
		if (Math.abs(v1x) > PI || Math.abs(v2x) > PI) continue
		const d1 = Math.hypot(v1x, v1y)
		const d2 = Math.hypot(v2x, v2y)
		if (d1 < 1e-9 || d2 < 1e-9) continue
		if (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (d1 * d2)))) > threshold) count++
	}

	return count
}

// Great-circle interpolation of a time-parametrized curve at an arbitrary Julian Day.
export function interpolateAtJulianDay(line: readonly GeoPoint[], jd: number) {
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

	for (const sub of pathData.split('M').filter((s) => s.length > 0)) {
		const numbers = `M${sub}`.match(/-?\d+(?:\.\d+)?/g)
		if (!numbers) continue
		const coordinates = numbers.map(Number)

		for (let i = 2; i + 1 < coordinates.length; i += 2) {
			max = Math.max(max, Math.hypot(coordinates[i] - coordinates[i - 2], coordinates[i + 1] - coordinates[i - 1]))
		}
	}

	return max
}

// Largest spherical edge between consecutive points within any branch, skipping antimeridian wraps.
export function maxBranchSegment(branches: readonly (readonly GeoPoint[])[]) {
	let max = 0

	for (const branch of branches) {
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

function catalogLabel(eclipse: Readonly<SolarEclipse>) {
	return `lunation=${eclipse.lunation}, jd=${toJulianDay(eclipse.maximalTime).toFixed(6)}, type=${eclipse.type}, gamma=${eclipse.gamma.toFixed(6)}`
}

function catalogFail(eclipse: Readonly<SolarEclipse>, message: string): never {
	throw new Error(`${message} (${catalogLabel(eclipse)})`)
}

function catalogAssert(eclipse: Readonly<SolarEclipse>, condition: boolean, message: string) {
	if (!condition) catalogFail(eclipse, message)
}

function validateCatalogPoint(eclipse: Readonly<SolarEclipse>, point: GeoPoint, name: string, requireJd: boolean) {
	catalogAssert(eclipse, Number.isFinite(point.x), `${name} has non-finite longitude`)
	catalogAssert(eclipse, Number.isFinite(point.y), `${name} has non-finite latitude`)
	catalogAssert(eclipse, point.x >= -PI && point.x <= PI, `${name} longitude is out of range`)
	catalogAssert(eclipse, point.y >= -PIOVERTWO && point.y <= PIOVERTWO, `${name} latitude is out of range`)
	if (requireJd) catalogAssert(eclipse, point.jd !== undefined && Number.isFinite(point.jd), `${name} has missing/non-finite jd`)
	else if (point.jd !== undefined) catalogAssert(eclipse, Number.isFinite(point.jd), `${name} has non-finite jd`)
}

function minDistanceToBranches(point: GeoPoint, branches: readonly (readonly GeoPoint[])[]) {
	let min = Infinity
	for (const branch of branches) for (const sample of branch) min = Math.min(min, sphericalSeparation(point.x, point.y, sample.x, sample.y))
	return min
}

function validatePointAnchor(eclipse: Readonly<SolarEclipse>, point: GeoPoint | undefined, name: string, branches: readonly (readonly GeoPoint[])[], tolerance: Angle) {
	if (!point) return
	validateCatalogPoint(eclipse, point, name, true)
	catalogAssert(eclipse, branches.length > 0, `${name} exists but its drawable family is empty`)
	catalogAssert(eclipse, minDistanceToBranches(point, branches) <= tolerance, `${name} is not attached to its drawable family`)
}

function validateCatalogBranches(eclipse: Readonly<SolarEclipse>, elements: PolynomialBesselianElements, branches: readonly (readonly GeoPoint[])[], name: string, i: -1 | 1, G: number) {
	for (let b = 0; b < branches.length; b++) {
		const branch = branches[b]
		catalogAssert(eclipse, branch.length >= 2, `${name}[${b}] is not drawable`)
		validateNoEndpointRetrace(eclipse, branch, `${name}[${b}]`)

		for (let k = 0; k < branch.length; k++) {
			const point = branch[k]
			validateCatalogPoint(eclipse, point, `${name}[${b}][${k}]`, true)
			catalogAssert(eclipse, limitTangencyResidual(elements, point, i, G) < 2e-3, `${name}[${b}][${k}] is off its magnitude locus`)
			catalogAssert(eclipse, solarAltitude(elements, point) > deg(-2), `${name}[${b}][${k}] is below the drawable sunlit limb`)
			if (k > 0) catalogAssert(eclipse, sphericalSeparation(branch[k - 1].x, branch[k - 1].y, point.x, point.y) <= CATALOG_MAX_DRAWABLE_GAP, `${name}[${b}] has a large drawable gap`)
		}
	}

	validateNoBridgeableEndpointGaps(eclipse, elements, branches, name, i, G)
}

function validateNoEndpointRetrace(eclipse: Readonly<SolarEclipse>, branch: readonly GeoPoint[], name: string) {
	catalogAssert(eclipse, !endpointRetraces(branch, true), `${name} retraces a loop from its start endpoint`)
	catalogAssert(eclipse, !endpointRetraces(branch, false), `${name} retraces a loop from its end endpoint`)
}

export function endpointRetraces(branch: readonly GeoPoint[], fromStart: boolean) {
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

function validateNoBridgeableEndpointGaps(eclipse: Readonly<SolarEclipse>, elements: PolynomialBesselianElements, branches: readonly (readonly GeoPoint[])[], name: string, i: -1 | 1, G: number) {
	for (let a = 0; a < branches.length; a++) {
		const branchA = branches[a]
		const endpointsA = [branchA[0], branchA.at(-1)!] as const

		for (let b = a + 1; b < branches.length; b++) {
			const branchB = branches[b]
			const endpointsB = [branchB[0], branchB.at(-1)!] as const

			for (let ea = 0; ea < endpointsA.length; ea++) {
				for (let eb = 0; eb < endpointsB.length; eb++) {
					const gap = sphericalSeparation(endpointsA[ea].x, endpointsA[ea].y, endpointsB[eb].x, endpointsB[eb].y)
					if (gap <= CATALOG_STEP || gap > CATALOG_BRIDGE_LIMIT) continue
					if (!hasContinuousCurveBetween(elements, endpointsA[ea], endpointsB[eb], i, G, gap)) continue
					catalogAssert(eclipse, catalogBranchRetraces(mergeCatalogBranches(branchA, branchB, ea as 0 | 1, eb as 0 | 1), CATALOG_ANCHOR_TOLERANCE, CATALOG_OVERLAP_ARC), `${name}[${a}] and ${name}[${b}] have a bridgeable endpoint gap`)
				}
			}
		}
	}
}

function pushCatalogBranchPoint(out: GeoPoint[], point: GeoPoint) {
	if (out.length === 0 || sphericalSeparation(out.at(-1)!.x, out.at(-1)!.y, point.x, point.y) > 1e-12) out.push(point)
}

function appendCatalogBranchPoints(out: GeoPoint[], branch: readonly GeoPoint[], reverse: boolean) {
	if (reverse) {
		for (let k = branch.length - 1; k >= 0; k--) pushCatalogBranchPoint(out, branch[k])
	} else {
		for (let k = 0; k < branch.length; k++) pushCatalogBranchPoint(out, branch[k])
	}
}

function mergeCatalogBranches(a: readonly GeoPoint[], b: readonly GeoPoint[], endpointA: 0 | 1, endpointB: 0 | 1) {
	const out: GeoPoint[] = []
	appendCatalogBranchPoints(out, a, endpointA === 0)
	appendCatalogBranchPoints(out, b, endpointB === 1)
	return out
}

function catalogBranchRetraces(branch: readonly GeoPoint[], tolerance: Angle, minArcSeparation: Angle) {
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

function hasContinuousCurveBetween(elements: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, i: -1 | 1, G: number, gap: Angle) {
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

function validateCatalogRiseSetCurves(eclipse: Readonly<SolarEclipse>, elements: PolynomialBesselianElements, branches: readonly (readonly GeoPoint[])[]) {
	for (let b = 0; b < branches.length; b++) {
		const branch = branches[b]
		catalogAssert(eclipse, branch.length >= 2, `riseSetCurves[${b}] is not drawable`)

		for (let k = 0; k < branch.length; k++) {
			const point = branch[k]

			validateCatalogPoint(eclipse, point, `riseSetCurves[${b}][${k}]`, true)
			catalogAssert(eclipse, Math.abs(solarAltitude(elements, point)) < deg(2.5), `riseSetCurves[${b}][${k}] is off the solar horizon`)

			if (k > 0) {
				catalogAssert(eclipse, point.jd! >= branch[k - 1].jd!, `riseSetCurves[${b}] moves backward in time`)
				catalogAssert(eclipse, sphericalSeparation(branch[k - 1].x, branch[k - 1].y, point.x, point.y) <= CATALOG_MAX_DRAWABLE_GAP, `riseSetCurves[${b}] has a large drawable gap`)
			}
		}
	}
}

function validateCatalogGeometry(eclipse: Readonly<SolarEclipse>, elements: PolynomialBesselianElements, geometry: SolarEclipseMapGeometry) {
	for (const [name, point] of Object.entries(geometry.points)) {
		if (point) {
			validateCatalogPoint(eclipse, point, name, true)
		}
	}

	const { points, lines } = geometry
	const penumbra = [...lines.penumbraNorth, ...lines.penumbraSouth]
	const umbra = [...lines.umbraNorth, ...lines.umbraSouth]

	catalogAssert(eclipse, penumbra.length > 0, 'penumbral drawable family is empty')
	validateCatalogBranches(eclipse, elements, lines.penumbraNorth, 'penumbraNorth', 1, 0)
	validateCatalogBranches(eclipse, elements, lines.penumbraSouth, 'penumbraSouth', -1, 0)
	validateCatalogBranches(eclipse, elements, lines.umbraNorth, 'umbraNorth', 1, 1)
	validateCatalogBranches(eclipse, elements, lines.umbraSouth, 'umbraSouth', -1, 1)
	validateCatalogRiseSetCurves(eclipse, elements, lines.riseSetCurves)

	validatePointAnchor(eclipse, points.N1, 'N1', penumbra, CATALOG_ANCHOR_TOLERANCE)
	validatePointAnchor(eclipse, points.N2, 'N2', penumbra, CATALOG_ANCHOR_TOLERANCE)
	validatePointAnchor(eclipse, points.S1, 'S1', penumbra, CATALOG_ANCHOR_TOLERANCE)
	validatePointAnchor(eclipse, points.S2, 'S2', penumbra, CATALOG_ANCHOR_TOLERANCE)

	if (umbra.length > 0) {
		validatePointAnchor(eclipse, points.U1, 'U1', umbra, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(eclipse, points.U2, 'U2', umbra, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(eclipse, points.U3, 'U3', umbra, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(eclipse, points.U4, 'U4', umbra, CATALOG_ANCHOR_TOLERANCE)
	}

	if (lines.riseSetCurves.length > 0) {
		validatePointAnchor(eclipse, points.P1, 'P1', lines.riseSetCurves, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(eclipse, points.P2, 'P2', lines.riseSetCurves, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(eclipse, points.P3, 'P3', lines.riseSetCurves, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(eclipse, points.P4, 'P4', lines.riseSetCurves, CATALOG_ANCHOR_TOLERANCE)
	}

	if (centralAxisIntersectsEarth(elements)) {
		validatePointAnchor(eclipse, points.C1, 'C1', [lines.centerLine], 1e-9)
		validatePointAnchor(eclipse, points.C2, 'C2', [lines.centerLine], 1e-9)
		catalogAssert(eclipse, lines.centerLine.length >= 2, 'central line is empty for a central eclipse')
	} else {
		catalogAssert(eclipse, lines.centerLine.length === 0, 'central line exists for a non-central eclipse')
	}

	validateOptionalOrder(eclipse, points.P1, points.P2, 'P1/P2')
	validateOptionalOrder(eclipse, points.P2, points.Max, 'P2/Max')
	validateOptionalOrder(eclipse, points.Max, points.P3, 'Max/P3')
	validateOptionalOrder(eclipse, points.P3, points.P4, 'P3/P4')
	validateOptionalOrder(eclipse, points.N1, points.N2, 'N1/N2')
	validateOptionalOrder(eclipse, points.S1, points.S2, 'S1/S2')
	validateOptionalOrder(eclipse, points.U1, points.U4, 'U1/U4')
	validateOptionalOrder(eclipse, points.C1, points.C2, 'C1/C2')

	const MAP_WIDTH = 2400
	const MAP_HEIGHT = 1200
	const projection = new PlateCarree(0, { scale: MAP_WIDTH / TAU, falseEasting: MAP_WIDTH / 2, falseNorthing: MAP_HEIGHT / 2, yAxisDirection: 'southUp', centralMeridian: 0, longitudeWrapMode: 'pi', maxLatitude: PIOVERTWO })

	const paths = solarEclipseMapToSvgPaths(geometry, projection)

	for (const [name, path] of [
		['centerLine', paths.centerLine],
		['umbraNorth', paths.umbraNorth],
		['umbraSouth', paths.umbraSouth],
		['penumbraNorth', paths.penumbraNorth],
		['penumbraSouth', paths.penumbraSouth],
		['riseSetCurves', paths.riseSetCurves],
	] as const) {
		catalogAssert(eclipse, longestProjectedSegment(path) < MAP_WIDTH / 2, `${name} has a projected jump`)
	}
}

function validateOptionalOrder(eclipse: Readonly<SolarEclipse>, a: GeoPoint | undefined, b: GeoPoint | undefined, name: string) {
	if (a?.jd !== undefined && b?.jd !== undefined) catalogAssert(eclipse, a.jd <= b.jd, `${name} is out of chronological order`)
}

test.skipIf(Bun.env.SOLAR_ECLIPSE_FULL_CATALOG !== 'true')(
	'validates solar eclipse map topology across the configured catalog range',
	() => {
		const start = timeYMD(CATALOG_FROM_YEAR, 1, 1)
		const endJd = toJulianDay(timeYMD(CATALOG_TO_YEAR + 1, 1, 1))
		let cursor = start
		let previousJd = -Infinity
		let previousLunation = -Infinity
		let count = 0

		while (true) {
			const eclipse = nearestSolarEclipse(cursor, true)
			const jd = toJulianDay(eclipse.maximalTime)
			if (jd >= endJd) break

			catalogAssert(eclipse, jd > previousJd, 'catalog enumeration did not advance in time')
			catalogAssert(eclipse, eclipse.lunation > previousLunation, 'catalog enumeration did not advance in lunation')

			const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
			const geometry = computeSolarEclipseMapGeometry(eclipse, elements, { longitudeStep: CATALOG_STEP, maxAngularStep: CATALOG_STEP, includeRiseSetCurves: true, riseSetStep: CATALOG_RISE_SET_STEP })
			validateCatalogGeometry(eclipse, elements, geometry)

			previousJd = jd
			previousLunation = eclipse.lunation
			cursor = eclipse.maximalTime
			count++
		}

		expect(count).toBeGreaterThan(0)
		if (CATALOG_FROM_YEAR <= -2000 && CATALOG_TO_YEAR >= 3000) expect(count).toBeGreaterThan(10000)
	},
	CATALOG_TIMEOUT_MS,
)
