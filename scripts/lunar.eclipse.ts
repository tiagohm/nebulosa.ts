import { PlateCarree } from '../src/astronomy/projections/projection'
import { PI, PIOVERTWO, TAU } from '../src/core/constants'
import { sphericalSeparation, type Point } from '../src/math/numerical/geometry'
// oxfmt-ignore
import { parseArgs } from 'node:util'
import { nearestLunarEclipse } from '../src/astronomy/bodies/moon'
import { sunMoonPosition, type EclipseGeoCurve, type EclipseGeoPoint } from '../src/astronomy/events/eclipse/eclipse'
import { computeLunarEclipseMapGeometry, lunarEclipseMapToSvgPaths, type LunarEclipseContactKind, type LunarEclipseMapGeometry, type LunarEclipseMapGeometryOptions, type LunarEclipseMapSvgPaths } from '../src/astronomy/events/eclipse/lunar/map'
import { timeYMD, toJulianDay, timeToDate } from '../src/astronomy/time/time'
import { deg } from '../src/math/units/angle'
import { longestProjectedSegment } from '../tests/util/eclipse.util'

const CATALOG_STEP = deg(0.5)
const LUNAR_ECLIPSE_MAP_GEOMETRY_OPTIONS: LunarEclipseMapGeometryOptions = { maxAngularStep: CATALOG_STEP }
// Largest geodesic gap allowed between neighboring horizon-ring samples (a few sampling steps); a bigger gap means
// the ring is broken or under-sampled.
const CATALOG_MAX_DRAWABLE_GAP = CATALOG_STEP * 4
// Canonical chronological order of the seven possible lunar contacts; resolved events must be a subsequence of it.
const CATALOG_CONTACT_ORDER: readonly LunarEclipseContactKind[] = ['P1', 'U1', 'U2', 'MAX', 'U3', 'U4', 'P4']

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

function marker(point: Point | undefined, label: string, color: string) {
	return point ? `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3" fill="${color}"/><text x="${(point.x + 5).toFixed(2)}" y="${(point.y - 5).toFixed(2)}">${label}</text>` : ''
}

function makeSvg(paths: LunarEclipseMapSvgPaths, width: number, height: number) {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><style>.ocean { fill: #103099; } .P1, .P4, .U1, .U2, .U3, .U4, .MAX { fill: #000000; stroke: #000000; opacity: 0.1; stroke-width: 1; stroke-linecap: round; } text { font: 14px sans-serif; font-weight: bold; fill: #fff; }</style><rect class="ocean" x="0" y="0" width="${width}" height="${height}"/><path class="P1" d="${paths.moonRiseSet.P1}"/><path class="U1" d="${paths.moonRiseSet.U1}"/><path class="U2" d="${paths.moonRiseSet.U2}"/><path class="MAX" d="${paths.moonRiseSet.MAX}"/><path class="U3" d="${paths.moonRiseSet.U3}"/><path class="U4" d="${paths.moonRiseSet.U4}"/><path class="P4" d="${paths.moonRiseSet.P4}"/>${marker(paths.sublunarPoints.P1, 'P1', '#FF9F1C')}${marker(paths.sublunarPoints.P4, 'P4', '#FF9F1C')}${marker(paths.sublunarPoints.U1, 'U1', '#FF9F1C')}${marker(paths.sublunarPoints.U2, 'U2', '#FF9F1C')}${marker(paths.sublunarPoints.U3, 'U3', '#FF9F1C')}${marker(paths.sublunarPoints.U4, 'U4', '#FF9F1C')}${marker(paths.sublunarPoints.MAX, 'MAX', '#FF9F1C')}</svg>`
}

const MAP_WIDTH = 2400
const MAP_HEIGHT = 1200
const projection = new PlateCarree(0, { scale: MAP_WIDTH / TAU, falseEasting: MAP_WIDTH / 2, falseNorthing: MAP_HEIGHT / 2, yAxisDirection: 'southUp', centralMeridian: 0, longitudeWrapMode: 'pi', maxLatitude: PIOVERTWO })

function catalogAssert(condition: boolean, description: string) {
	if (!condition) throw new Error(description)
}

// Validates one geographic point: finite and within the map's longitude/latitude range.
function validateCatalogPoint(point: EclipseGeoPoint, name: string) {
	catalogAssert(Number.isFinite(point.x), `${name} has non-finite longitude`)
	catalogAssert(Number.isFinite(point.y), `${name} has non-finite latitude`)
	catalogAssert(point.x >= -PI - 1e-9 && point.x <= PI + 1e-9, `${name} longitude is out of range`)
	catalogAssert(point.y >= -PIOVERTWO - 1e-9 && point.y <= PIOVERTWO + 1e-9, `${name} latitude is out of range`)
}

// A horizon curve is the small circle where the topocentric Moon altitude equals the visibility horizon, centered
// on the sublunar point, so every vertex sits at the SAME geocentric angular distance (the cap radius) from it.
// Checking that this separation is constant - plus that the ring is closed, finite, in range and densely sampled -
// catches a malformed, mis-centered or degenerate curve without depending on the engine's private cap radius.
function validateHorizonRing(curve: EclipseGeoCurve | undefined, sublunar: EclipseGeoPoint, name: string) {
	catalogAssert(curve !== undefined && curve.length > 0, `${name} horizon curve is missing`)
	const ring = curve![0]
	catalogAssert(ring.length >= 24, `${name} horizon ring is not drawable`)

	const first = ring[0]
	const last = ring.at(-1)!
	catalogAssert(Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9, `${name} horizon ring is not closed`)

	let minSeparation = Infinity
	let maxSeparation = -Infinity
	for (let k = 0; k < ring.length; k++) {
		const point = ring[k]
		validateCatalogPoint(point, `${name}[${k}]`)
		const separation = sphericalSeparation(sublunar.x, sublunar.y, point.x, point.y)
		minSeparation = Math.min(minSeparation, separation)
		maxSeparation = Math.max(maxSeparation, separation)
		if (k > 0) catalogAssert(sphericalSeparation(ring[k - 1].x, ring[k - 1].y, point.x, point.y) <= CATALOG_MAX_DRAWABLE_GAP, `${name} horizon ring has a large drawable gap`)
	}

	catalogAssert(minSeparation > 1e-6, `${name} horizon ring collapses onto the sublunar point`)
	catalogAssert(maxSeparation - minSeparation < 1e-6, `${name} horizon ring is not a circle centered on the sublunar point`)
}

// Validates a serialized SVG path: finite numbers, starts with a move, and (for the closed fill polygons) ends
// with a Z. Empty strings are skipped (an absent contact has no path).
function validatePathString(path: string, name: string, closed: boolean) {
	if (path.length === 0) return
	catalogAssert(!path.includes('NaN'), `${name} path contains NaN`)
	catalogAssert(!path.includes('Infinity'), `${name} path contains Infinity`)
	catalogAssert(path.startsWith('M'), `${name} path does not start with a move`)
	if (closed) catalogAssert(path.endsWith('Z'), `${name} fill path is not closed`)
}

// Basic validation of one eclipse's map geometry and its serialized paths. Lunar geometry is far simpler than
// solar: there is no Besselian shadow on the ground, only per-contact moon rise/set small circles, their sublunar
// centers and the contact ordering. The checks assert those invariants and that the paths are finite and drawable.
function validateCatalogGeometry(geometry: LunarEclipseMapGeometry, openPaths: LunarEclipseMapSvgPaths, fillPaths: LunarEclipseMapSvgPaths) {
	const events = geometry.events
	catalogAssert(events.length > 0, 'no contacts resolved')

	// Contacts appear in canonical chronological order and strictly advance in time; the penumbral contacts and the
	// maximum are present for every lunar eclipse.
	const present = new Set<LunarEclipseContactKind>()
	let previousOrder = -1
	for (let i = 0; i < events.length; i++) {
		const event = events[i]
		const order = CATALOG_CONTACT_ORDER.indexOf(event.kind)
		catalogAssert(order > previousOrder, 'contacts are out of canonical order')
		previousOrder = order
		present.add(event.kind)
		validateCatalogPoint(event.sublunar, `${event.kind} sublunar`)
		if (i > 0) catalogAssert(event.jd > events[i - 1].jd, 'contacts are out of chronological order')
	}

	catalogAssert(present.has('P1') && present.has('MAX') && present.has('P4'), 'missing a penumbral contact or the maximum')

	// Each existing contact's horizon curve is a proper small circle centered on its sublunar point.
	for (const event of events) validateHorizonRing(geometry.lines.moonRiseSet[event.kind], event.sublunar, event.kind)

	// Serialized paths are finite; an open curve never spans half the map (a projected antimeridian jump would).
	for (const kind of CATALOG_CONTACT_ORDER) {
		const open = openPaths.moonRiseSet[kind]
		validatePathString(open, `${kind} open`, false)
		validatePathString(fillPaths.moonRiseSet[kind], `${kind} fill`, true)
		if (open.length > 0) catalogAssert(longestProjectedSegment(open) < MAP_WIDTH / 2, `${kind} open curve has a projected jump`)
	}
}

const start = timeYMD(Math.min(FROM_YEAR, TO_YEAR), 1, 1)
const endJD = toJulianDay(timeYMD(Math.max(FROM_YEAR, TO_YEAR) + 1, 1, 1))

let cursor = start
let prevJd = -Infinity
let total = 0
let failed = 0

async function draw(file: Bun.BunFile, paths: LunarEclipseMapSvgPaths) {
	const svg = makeSvg(paths, MAP_WIDTH, MAP_HEIGHT)
	await Bun.write(file, svg)
}

console.info('🌑  validating lunar eclipses from %s-01-01 to %s-12-31', FROM_YEAR, TO_YEAR)

while (true) {
	const eclipse = nearestLunarEclipse(cursor, true)
	const jd = toJulianDay(eclipse.maximalTime)

	if (jd >= endJD) break

	// Guard against the enumeration stalling on the same eclipse (an infinite loop), independently of the map engine.
	catalogAssert(jd > prevJd, 'catalog enumeration did not advance in time')

	const abortTimer = setTimeout(() => {
		console.info('❌', name, ':', 'timed out', '|', (endTime - startTime).toFixed(0), 'ms', '| time:', eclipse.maximalTime.day + eclipse.maximalTime.fraction, '| type:', eclipse.type, '| gamma:', eclipse.gamma.toFixed(6), '| magnitude:', eclipse.magnitude.toFixed(4))
		process.exit(-1)
	}, 5000)

	const date = timeToDate(eclipse.maximalTime)
	const name = `${date[0] < 0 ? '-' : ''}${Math.abs(date[0]).toFixed(0).padStart(4, '0')}-${date[1].toFixed(0).padStart(2, '0')}-${date[2].toFixed(0).padStart(2, '0')}`

	const startTime = performance.now()
	const geometry = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition, LUNAR_ECLIPSE_MAP_GEOMETRY_OPTIONS)
	const openPaths = lunarEclipseMapToSvgPaths(geometry, projection)
	const paths = lunarEclipseMapToSvgPaths(geometry, projection, { fill: true })
	const endTime = performance.now()
	const file = Bun.file(`data/eclipse/${name}-${eclipse.type}.svg`)

	try {
		validateCatalogGeometry(geometry, openPaths, paths)
		if (args.save) await draw(file, paths)
		if (args.success) console.info('✅', name, '| type:', eclipse.type, '| gamma:', eclipse.gamma.toFixed(6), '| magnitude:', eclipse.magnitude.toFixed(4), '|', (endTime - startTime).toFixed(0), 'ms')
	} catch (e) {
		await draw(file, paths)
		console.info('❌', name, ':', (e as Error).message, '|', (endTime - startTime).toFixed(0), 'ms', '| time:', eclipse.maximalTime.day + eclipse.maximalTime.fraction, '| type:', eclipse.type, '| gamma:', eclipse.gamma.toFixed(6), '| magnitude:', eclipse.magnitude.toFixed(4))
		failed++
	} finally {
		clearInterval(abortTimer)
	}

	prevJd = jd
	cursor = eclipse.maximalTime
	total++
}

console.info(failed, 'failed of', total, 'eclipses')

process.exitCode = failed
