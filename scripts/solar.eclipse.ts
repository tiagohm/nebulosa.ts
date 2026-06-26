import { nearestSolarEclipse, type SolarEclipse } from '../src/astronomy/bodies/sun'
import { PlateCarree } from '../src/astronomy/projections/projection'
import { PI, PIOVERTWO, TAU } from '../src/core/constants'
import { sphericalSeparation, type Point } from '../src/math/numerical/geometry'
import { deg, type Angle } from '../src/math/units/angle'
// oxfmt-ignore
import { BRANCH_MAX_DRAWABLE_GAP, type SolarEclipseGeoPoint, type PolynomialBesselianElements, type SolarEclipseMapGeometry, type SolarEclipseMapGeometryOptions, type SolarEclipseMapSvgPaths, centralAxisIntersectsEarth, computePolynomialBesselianElements, computeSolarEclipseMapGeometry, solarAltitudeAtPoint, solarEclipseMapToSvgPaths, type SolarEclipseGeoCurve, type SolarEclipseGeoBranch } from '../src/astronomy/events/eclipse/solar/map'
import { parseArgs } from 'node:util'
import { sunMoonPosition } from '../src/astronomy/events/eclipse/eclipse'
import { timeYMD, toJulianDay, timeToDate } from '../src/astronomy/time/time'
import { catalogBranchRetraces, endpointRetraces, hasContinuousCurveBetween, limitTangencyResidual, longestProjectedSegment } from '../tests/util/eclipse.util'

const CATALOG_STEP = deg(0.5)
const CATALOG_MAX_DRAWABLE_GAP = Math.max(BRANCH_MAX_DRAWABLE_GAP, CATALOG_STEP * 4)
const CATALOG_ANCHOR_TOLERANCE = Math.max(CATALOG_STEP, 1e-9)
const CATALOG_RISE_SET_STEP = 600
const CATALOG_BRIDGE_LIMIT = deg(20)
const CATALOG_OVERLAP_ARC = deg(10)
// gamma bounds (axis distance from Earth's center, equatorial radii) bracketing the central/non-central
// boundary at |gamma| ~ 0.9972: below CLEARLY_CENTRAL_GAMMA the shadow axis pierces the ellipsoid (a central
// line must exist), above CLEARLY_NON_CENTRAL_GAMMA the umbra no longer touches Earth on the axis (no central
// line). The margin around 0.9972..1.0266 leaves the grazing band unasserted, where central existence is
// genuinely geometry-dependent. gamma comes from nearestSolarEclipse, independent of the map engine, so these
// bound the engine's own central classifier from outside it.
const CLEARLY_CENTRAL_GAMMA = 0.99
const CLEARLY_NON_CENTRAL_GAMMA = 1.05
const SOLAR_ECLIPSE_MAP_GEOMETRY_OPTIONS: SolarEclipseMapGeometryOptions = { longitudeStep: CATALOG_STEP, maxAngularStep: CATALOG_STEP, includeRiseSetCurves: true, riseSetStep: CATALOG_RISE_SET_STEP }

const CURRENT_YEAR = new Date().getFullYear().toFixed(0)

const { values: args } = parseArgs({
	args: Bun.argv,
	allowPositionals: true,
	options: {
		from: { type: 'string' },
		to: { type: 'string' },
		success: { type: 'boolean', default: false },
		save: { type: 'boolean', default: false },
	},
})

const FROM_YEAR = +(args.from?.trim() || CURRENT_YEAR)
const TO_YEAR = +(args.to?.trim() || FROM_YEAR)

if (!Number.isFinite(FROM_YEAR) || !Number.isFinite(TO_YEAR)) {
	console.error('invalid from/to year:', FROM_YEAR, TO_YEAR)
	process.exit(1)
}

function catalogAssert(condition: boolean, description: string) {
	if (!condition) throw new Error(description)
}

function marker(point: Point | undefined | null, label: string, color: string) {
	return point ? `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3" fill="${color}"/><text x="${(point.x + 5).toFixed(2)}" y="${(point.y - 5).toFixed(2)}">${label}</text>` : ''
}

function makeSvg(paths: SolarEclipseMapSvgPaths, width: number, height: number) {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><style>.ocean { fill: #103099; } .umbra { fill: none; stroke: #FFE66D; stroke-width: 2; stroke-linecap: round; } .center { fill: none; stroke: #FF2ED1; stroke-width: 2; stroke-linecap: round; } .penumbra { fill: none; stroke: #FF9F1C; stroke-width: 2; stroke-linecap: round; } .riseset { fill: none; stroke: #00E5FF; stroke-width: 2; }text { font: 14px sans-serif; font-weight: bold; fill: #fff; }</style><rect class="ocean" x="0" y="0" width="${width}" height="${height}"/><path class="penumbra" d="${paths.penumbraNorth}"/><path class="penumbra" d="${paths.penumbraSouth}"/><path class="riseset" d="${paths.riseSetCurves}"/><path class="umbra" d="${paths.umbraNorth}"/><path class="umbra" d="${paths.umbraSouth}"/><path class="center" d="${paths.centerLine}"/>${marker(paths.points.P1, 'P1', '#FF9F1C')}${marker(paths.points.P4, 'P4', '#FF9F1C')}${marker(paths.points.P2, 'P2', '#FF9F1C')}${marker(paths.points.P3, 'P3', '#FF9F1C')}${marker(paths.points.U1, 'U1', '#FFE66D')}${marker(paths.points.U4, 'U4', '#FFE66D')}${marker(paths.points.U2, 'U2', '#FFE66D')}${marker(paths.points.U3, 'U3', '#FFE66D')}${marker(paths.points.C1, 'C1', '#FF7BEA')}${marker(paths.points.C2, 'C2', '#FF7BEA')}${marker(paths.points.N1, 'N1', '#35FF7A')}${marker(paths.points.N2, 'N2', '#35FF7A')}${marker(paths.points.S1, 'S1', '#FF4D4D')}${marker(paths.points.S2, 'S2', '#FF4D4D')}${marker(paths.points.Max, 'Max', '#FFFFFF')}</svg>`
}

function validateCatalogPoint(point: SolarEclipseGeoPoint, name: string, requireJd: boolean) {
	catalogAssert(Number.isFinite(point.x), `${name} has non-finite longitude`)
	catalogAssert(Number.isFinite(point.y), `${name} has non-finite latitude`)
	catalogAssert(point.x >= -PI && point.x <= PI, `${name} longitude is out of range`)
	catalogAssert(point.y >= -PIOVERTWO && point.y <= PIOVERTWO, `${name} latitude is out of range`)
	if (requireJd) catalogAssert(point.jd !== undefined && Number.isFinite(point.jd), `${name} has missing/non-finite jd`)
	else if (point.jd !== undefined) catalogAssert(Number.isFinite(point.jd), `${name} has non-finite jd`)
}

function minDistanceToBranches(point: SolarEclipseGeoPoint, curve: SolarEclipseGeoCurve) {
	let min = Infinity
	for (const branch of curve) for (const sample of branch) min = Math.min(min, sphericalSeparation(point.x, point.y, sample.x, sample.y))
	return min
}

function validatePointAnchor(point: SolarEclipseGeoPoint | undefined, name: string, curve: SolarEclipseGeoCurve, tolerance: Angle) {
	if (!point) return
	validateCatalogPoint(point, name, true)
	catalogAssert(curve.length > 0, `${name} exists but its drawable family is empty`)
	catalogAssert(minDistanceToBranches(point, curve) <= tolerance, `${name} is not attached to its drawable family`)
}

// Minimum Sun altitude for a U-contact to be required to lie on the drawable umbra family. The umbra limit is
// a day-side curve (the solver gates Sun altitude >= 0), so an antumbral cone tangency that occurs at or below
// the horizon has no day-side limit to attach to: it is still a real geometric contact, reported at its true
// position, but requiring attachment there is unsatisfiable (e.g. the 5968-05-24 annular, whose U4 lands
// exactly on the terminator ~8.7 deg from the nearest family point). Above-horizon U-contacts must still attach.
const UMBRAL_CONTACT_ATTACH_MIN_ALTITUDE = deg(0.5)

// Validates a U-contact's attachment to the umbra family, but only when it occurs above the horizon, where a
// day-side umbra limit can exist; a contact at or below the horizon is exempt (see the constant above).
function validateUmbralContactAnchor(elements: PolynomialBesselianElements, point: SolarEclipseGeoPoint | undefined, name: string, curve: SolarEclipseGeoCurve) {
	if (!point) return
	validateCatalogPoint(point, name, true)
	if (solarAltitudeAtPoint(elements, point) < UMBRAL_CONTACT_ATTACH_MIN_ALTITUDE) return
	validatePointAnchor(point, name, curve, CATALOG_ANCHOR_TOLERANCE)
}

function validateNoBridgeableEndpointGaps(elements: PolynomialBesselianElements, curve: SolarEclipseGeoCurve, name: string, i: -1 | 1, G: number) {
	for (let a = 0; a < curve.length; a++) {
		const branchA = curve[a]
		const endpointsA = [branchA[0], branchA.at(-1)!] as const

		for (let b = a + 1; b < curve.length; b++) {
			const branchB = curve[b]
			const endpointsB = [branchB[0], branchB.at(-1)!] as const

			for (let ea = 0; ea < endpointsA.length; ea++) {
				for (let eb = 0; eb < endpointsB.length; eb++) {
					const gap = sphericalSeparation(endpointsA[ea].x, endpointsA[ea].y, endpointsB[eb].x, endpointsB[eb].y)
					if (gap <= CATALOG_STEP || gap > CATALOG_BRIDGE_LIMIT) continue
					if (!hasContinuousCurveBetween(elements, endpointsA[ea], endpointsB[eb], i, G, gap)) continue
					catalogAssert(catalogBranchRetraces(mergeCatalogBranches(branchA, branchB, ea as 0 | 1, eb as 0 | 1), CATALOG_ANCHOR_TOLERANCE, CATALOG_OVERLAP_ARC), `${name}[${a}] and ${name}[${b}] have a bridgeable endpoint gap`)
				}
			}
		}
	}
}

function validateCatalogBranches(elements: PolynomialBesselianElements, curve: SolarEclipseGeoCurve, name: string, i: -1 | 1, G: number) {
	for (let b = 0; b < curve.length; b++) {
		const branch = curve[b]
		catalogAssert(branch.length >= 2, `${name}[${b}] is not drawable`)
		validateNoEndpointRetrace(branch, `${name}[${b}]`)

		for (let k = 0; k < branch.length; k++) {
			const point = branch[k]
			validateCatalogPoint(point, `${name}[${b}][${k}]`, true)
			catalogAssert(limitTangencyResidual(elements, point, i, G) < 2e-3, `${name}[${b}][${k}] is off its magnitude locus`)
			catalogAssert(solarAltitudeAtPoint(elements, point) > deg(-2), `${name}[${b}][${k}] is below the drawable sunlit limb`)
			if (k > 0) catalogAssert(sphericalSeparation(branch[k - 1].x, branch[k - 1].y, point.x, point.y) <= CATALOG_MAX_DRAWABLE_GAP, `${name}[${b}] has a large drawable gap`)
		}
	}

	validateNoBridgeableEndpointGaps(elements, curve, name, i, G)
}

function validateNoEndpointRetrace(branch: SolarEclipseGeoBranch, name: string) {
	catalogAssert(!endpointRetraces(branch, true), `${name} retraces a loop from its start endpoint`)
	catalogAssert(!endpointRetraces(branch, false), `${name} retraces a loop from its end endpoint`)
}

function pushCatalogBranchPoint(out: SolarEclipseGeoBranch, point: SolarEclipseGeoPoint) {
	if (out.length === 0 || sphericalSeparation(out.at(-1)!.x, out.at(-1)!.y, point.x, point.y) > 1e-12) out.push(point)
}

function appendCatalogBranchPoints(out: SolarEclipseGeoBranch, branch: SolarEclipseGeoBranch, reverse: boolean) {
	if (reverse) {
		for (let k = branch.length - 1; k >= 0; k--) pushCatalogBranchPoint(out, branch[k])
	} else {
		for (let k = 0; k < branch.length; k++) pushCatalogBranchPoint(out, branch[k])
	}
}

function mergeCatalogBranches(a: SolarEclipseGeoBranch, b: SolarEclipseGeoBranch, endpointA: 0 | 1, endpointB: 0 | 1) {
	const out: SolarEclipseGeoBranch = []
	appendCatalogBranchPoints(out, a, endpointA === 0)
	appendCatalogBranchPoints(out, b, endpointB === 1)
	return out
}

function validateCatalogRiseSetCurves(elements: PolynomialBesselianElements, curve: SolarEclipseGeoCurve) {
	for (let b = 0; b < curve.length; b++) {
		const branch = curve[b]
		catalogAssert(branch.length >= 2, `riseSetCurves[${b}] is not drawable`)

		for (let k = 0; k < branch.length; k++) {
			const point = branch[k]

			validateCatalogPoint(point, `riseSetCurves[${b}][${k}]`, true)
			catalogAssert(Math.abs(solarAltitudeAtPoint(elements, point)) < deg(2.5), `riseSetCurves[${b}][${k}] is off the solar horizon`)

			if (k > 0) {
				catalogAssert(point.jd! >= branch[k - 1].jd!, `riseSetCurves[${b}] moves backward in time`)
				catalogAssert(sphericalSeparation(branch[k - 1].x, branch[k - 1].y, point.x, point.y) <= CATALOG_MAX_DRAWABLE_GAP, `riseSetCurves[${b}] has a large drawable gap`)
			}
		}
	}
}

const MAP_WIDTH = 2400
const MAP_HEIGHT = 1200
const projection = new PlateCarree(0, { scale: MAP_WIDTH / TAU, falseEasting: MAP_WIDTH / 2, falseNorthing: MAP_HEIGHT / 2, yAxisDirection: 'southUp', centralMeridian: 0, longitudeWrapMode: 'pi', maxLatitude: PIOVERTWO })

function validateCatalogGeometry(eclipse: SolarEclipse, elements: PolynomialBesselianElements, geometry: SolarEclipseMapGeometry, paths: SolarEclipseMapSvgPaths) {
	for (const [name, point] of Object.entries(geometry.points)) {
		if (point) {
			validateCatalogPoint(point, name, true)
		}
	}

	const { points, lines } = geometry
	const penumbra = [...lines.penumbraNorth, ...lines.penumbraSouth]
	const umbra = [...lines.umbraNorth, ...lines.umbraSouth]

	// The penumbral limit exists only when the penumbra actually reaches Earth. An extreme grazing partial
	// whose penumbral cone misses the ellipsoid (e.g. the 3205-11-03 partial at gamma 1.534, magnitude
	// 0.0013, whose penumbra clears the limb by ~0.0003 Earth radii) has no drawable limit and no external
	// contacts, so require the family only when a P1/P4 contact is present. An empty family with a contact
	// present is still a real defect and fails.
	if (points.P1 || points.P4) catalogAssert(penumbra.length > 0, 'penumbral drawable family is empty')
	validateCatalogBranches(elements, lines.penumbraNorth, 'penumbraNorth', 1, 0)
	validateCatalogBranches(elements, lines.penumbraSouth, 'penumbraSouth', -1, 0)
	validateCatalogBranches(elements, lines.umbraNorth, 'umbraNorth', 1, 1)
	validateCatalogBranches(elements, lines.umbraSouth, 'umbraSouth', -1, 1)
	validateCatalogRiseSetCurves(elements, lines.riseSetCurves)

	validatePointAnchor(points.N1, 'N1', penumbra, CATALOG_ANCHOR_TOLERANCE)
	validatePointAnchor(points.N2, 'N2', penumbra, CATALOG_ANCHOR_TOLERANCE)
	validatePointAnchor(points.S1, 'S1', penumbra, CATALOG_ANCHOR_TOLERANCE)
	validatePointAnchor(points.S2, 'S2', penumbra, CATALOG_ANCHOR_TOLERANCE)

	if (umbra.length > 0) {
		validateUmbralContactAnchor(elements, points.U1, 'U1', umbra)
		validateUmbralContactAnchor(elements, points.U2, 'U2', umbra)
		validateUmbralContactAnchor(elements, points.U3, 'U3', umbra)
		validateUmbralContactAnchor(elements, points.U4, 'U4', umbra)
	}

	if (lines.riseSetCurves.length > 0) {
		validatePointAnchor(points.P1, 'P1', lines.riseSetCurves, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(points.P2, 'P2', lines.riseSetCurves, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(points.P3, 'P3', lines.riseSetCurves, CATALOG_ANCHOR_TOLERANCE)
		validatePointAnchor(points.P4, 'P4', lines.riseSetCurves, CATALOG_ANCHOR_TOLERANCE)
	}

	// Cross-check the engine's central classifier against gamma, computed independently by nearestSolarEclipse.
	// Otherwise a misclassification is self-consistent and invisible: a central eclipse wrongly called
	// non-central draws no central line, the else branch only confirms the (empty) line is empty, and nothing
	// fails (the 6255-06-02 total, gamma 0.899, slipped through this way). A clearly central eclipse must pierce
	// the ellipsoid; a clearly non-central / partial one must not.
	const absGamma = Math.abs(eclipse.gamma)
	const isCentral = centralAxisIntersectsEarth(elements)
	if (eclipse.type !== 'partial' && absGamma < CLEARLY_CENTRAL_GAMMA) catalogAssert(isCentral, 'central eclipse misclassified as non-central')
	if (absGamma > CLEARLY_NON_CENTRAL_GAMMA) catalogAssert(!isCentral, 'non-central eclipse misclassified as central')

	if (isCentral) {
		validatePointAnchor(points.C1, 'C1', [lines.centerLine], 1e-9)
		validatePointAnchor(points.C2, 'C2', [lines.centerLine], 1e-9)
		catalogAssert(lines.centerLine.length >= 2, 'central line is empty for a central eclipse')
	} else {
		catalogAssert(lines.centerLine.length === 0, 'central line exists for a non-central eclipse')
	}

	validateOptionalOrder(points.P1, points.P2, 'P1/P2')
	validateOptionalOrder(points.P2, points.Max, 'P2/Max')
	validateOptionalOrder(points.Max, points.P3, 'Max/P3')
	validateOptionalOrder(points.P3, points.P4, 'P3/P4')
	validateOptionalOrder(points.N1, points.N2, 'N1/N2')
	validateOptionalOrder(points.S1, points.S2, 'S1/S2')
	validateOptionalOrder(points.U1, points.U4, 'U1/U4')
	validateOptionalOrder(points.C1, points.C2, 'C1/C2')

	for (const [name, path] of [
		['centerLine', paths.centerLine],
		['umbraNorth', paths.umbraNorth],
		['umbraSouth', paths.umbraSouth],
		['penumbraNorth', paths.penumbraNorth],
		['penumbraSouth', paths.penumbraSouth],
		['riseSetCurves', paths.riseSetCurves],
	] as const) {
		catalogAssert(longestProjectedSegment(path) < MAP_WIDTH / 2, `${name} has a projected jump`)
	}
}

function validateOptionalOrder(a: SolarEclipseGeoPoint | undefined, b: SolarEclipseGeoPoint | undefined, name: string) {
	if (a?.jd !== undefined && b?.jd !== undefined) catalogAssert(a.jd <= b.jd, `${name} is out of chronological order`)
}

async function removeFileIfExists(file: Bun.BunFile) {
	if (await file.exists()) await file.delete()
}

const start = timeYMD(Math.min(FROM_YEAR, TO_YEAR), 1, 1)
const endJD = toJulianDay(timeYMD(Math.max(FROM_YEAR, TO_YEAR) + 1, 1, 1))

let cursor = start
let total = 0
let failed = 0

async function draw(file: Bun.BunFile, paths: SolarEclipseMapSvgPaths) {
	const svg = makeSvg(paths, MAP_WIDTH, MAP_HEIGHT)
	await Bun.write(file, svg)
}

console.info('☀️  validating solar eclipses from %s-01-01 to %s-12-31', FROM_YEAR, TO_YEAR)

for (let prevJd = -Infinity, prevLunation = -Infinity; ; ) {
	const eclipse = nearestSolarEclipse(cursor, true)
	const jd = toJulianDay(eclipse.maximalTime)

	if (jd >= endJD) break

	const abortTimer = setTimeout(() => {
		console.info('❌', name, ':', 'timed out', '|', (endTime - startTime).toFixed(0), 'ms', '| time:', eclipse.maximalTime.day + eclipse.maximalTime.fraction, '| type:', eclipse.type, '| gamma:', eclipse.gamma.toFixed(6), '| magnitude:', eclipse.magnitude.toFixed(4))
		process.exit(-1)
	}, 5000)

	catalogAssert(jd > prevJd, 'catalog enumeration did not advance in time')
	catalogAssert(eclipse.lunation > prevLunation, 'catalog enumeration did not advance in lunation')

	const date = timeToDate(eclipse.maximalTime)
	const name = `${date[0] < 0 ? '-' : ''}${Math.abs(date[0]).toFixed(0).padStart(4, '0')}-${date[1].toFixed(0).padStart(2, '0')}-${date[2].toFixed(0).padStart(2, '0')}`

	const startTime = performance.now()
	const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
	const geometry = computeSolarEclipseMapGeometry(eclipse, elements, SOLAR_ECLIPSE_MAP_GEOMETRY_OPTIONS)
	const paths = solarEclipseMapToSvgPaths(geometry, projection)
	const endTime = performance.now()
	const file = Bun.file(`data/eclipse/${name}-${eclipse.type}.svg`)

	try {
		validateCatalogGeometry(eclipse, elements, geometry, paths)
		if (args.save) await draw(file, paths)
		else await removeFileIfExists(file)
		if (args.success) console.info('✅', name, '| type:', eclipse.type, '| gamma:', eclipse.gamma.toFixed(6), '| magnitude:', eclipse.magnitude.toFixed(4), '|', (endTime - startTime).toFixed(0), 'ms')
	} catch (e) {
		await draw(file, paths)
		console.info('❌', name, ':', (e as Error).message, '|', (endTime - startTime).toFixed(0), 'ms', '| time:', eclipse.maximalTime.day + eclipse.maximalTime.fraction, '| type:', eclipse.type, '| gamma:', eclipse.gamma.toFixed(6), '| magnitude:', eclipse.magnitude.toFixed(4))
		failed++
	} finally {
		clearInterval(abortTimer)
	}

	prevJd = jd
	prevLunation = eclipse.lunation
	cursor = eclipse.maximalTime
	total++
}

console.info(failed, 'failed of', total, 'eclipses')

process.exitCode = failed
