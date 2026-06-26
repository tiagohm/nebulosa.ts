import { describe, expect, test } from 'bun:test'
import { nearestLunarEclipse } from '../../../../../src/astronomy/bodies/moon'
import { sunMoonPosition } from '../../../../../src/astronomy/events/eclipse/eclipse'
import { moonAltitudeAt } from '../../../../../src/astronomy/events/eclipse/lunar/moon.eclipse.local'
import { computeLunarEclipseMapGeometry, lunarEclipseEvents, lunarEclipseMapToSvgPaths, MOON_RADIUS_EARTH_RADII, type LunarEclipseContactKind } from '../../../../../src/astronomy/events/eclipse/lunar/moon.eclipse.map'
import { PlateCarree } from '../../../../../src/astronomy/projections/projection'
import { greenwichApparentSiderealTime, type Time, timeYMDHMS } from '../../../../../src/astronomy/time/time'
import { PI, PIOVERTWO, TAU } from '../../../../../src/core/constants'
import { deg, type Angle } from '../../../../../src/math/units/angle'
import { longestProjectedSegment } from '../../../../util/eclipse.util'

// Cheap deterministic position provider for tests that exercise local-circumstance plumbing rather than the
// analytical VSOP87/ELP ephemerides. The Moon stays high for FAST_LONGITUDE/FAST_LATITUDE, keeping visibility
// and duration assertions stable while avoiding hundreds of expensive series evaluations.
function fastSunMoonPosition(time: Time) {
	const gast = greenwichApparentSiderealTime(time)

	return {
		sun: { rightAscension: gast - Math.PI + deg(0.1), declination: 0, distance: 1 },
		moon: { rightAscension: gast, declination: 0, distance: 60 },
		deltaT: 0,
	}
}

// Known eclipses (see tests/moon.test.ts): types verified against timeanddate.com.
const PENUMBRAL = nearestLunarEclipse(timeYMDHMS(1973, 6, 1), true)
const TOTAL = nearestLunarEclipse(timeYMDHMS(1997, 7, 1), true)
const PARTIAL = nearestLunarEclipse(timeYMDHMS(1994, 5, 25), true)

// Moon altitude (radians) at a geographic point, from a map event's apparent RA/Dec and GAST.
function moonAltitude(rightAscension: Angle, declination: Angle, gast: Angle, longitude: Angle, latitude: Angle): Angle {
	const H = gast + longitude - rightAscension
	const sinAlt = Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(H)
	return Math.asin(Math.max(-1, Math.min(1, sinAlt)))
}

function equirectangular(width: number, height: number) {
	return new PlateCarree(undefined, {
		scale: width / TAU,
		falseEasting: width / 2,
		falseNorthing: height / 2,
		yAxisDirection: 'southUp',
		centralMeridian: 0,
		longitudeWrapMode: 'pi',
		maxLatitude: PIOVERTWO,
	})
}

describe('events by type', () => {
	test('penumbral has P1, MAX, P4', () => {
		expect(lunarEclipseEvents(PENUMBRAL).map((e) => e.kind)).toEqual(['P1', 'MAX', 'P4'])
	})

	test('partial has P1, U1, MAX, U4, P4', () => {
		expect(lunarEclipseEvents(PARTIAL).map((e) => e.kind)).toEqual(['P1', 'U1', 'MAX', 'U4', 'P4'])
	})

	test('total has all seven contacts', () => {
		expect(lunarEclipseEvents(TOTAL).map((e) => e.kind)).toEqual(['P1', 'U1', 'U2', 'MAX', 'U3', 'U4', 'P4'])
	})

	test('contact times are ascending', () => {
		const events = lunarEclipseEvents(TOTAL)
		for (let i = 1; i < events.length; i++) expect(events[i].jd).toBeGreaterThan(events[i - 1].jd)
	})

	// Before JD 0 the contact Time.day values are negative; the absent-contact sentinel is day 0 AND fraction 0,
	// so real ancient contacts must not be dropped (a positive-day test would discard them all).
	test('eclipse before JD 0 keeps its contacts', () => {
		const ancient = nearestLunarEclipse(timeYMDHMS(-5000, 1, 1), true)
		expect(ancient.type).toBe('PARTIAL')
		const events = lunarEclipseEvents(ancient)
		expect(events.map((e) => e.kind)).toEqual(['P1', 'U1', 'MAX', 'U4', 'P4'])
		// The resolved contacts have negative days (real), while the absent totality contact keeps the sentinel.
		expect(events[0].time.day).toBeLessThan(0)
		expect(ancient.totalBeginTime.day).toBe(0)
		expect(ancient.totalBeginTime.fraction).toBe(0)
		// Map geometry is built for the ancient eclipse rather than reporting nothing.
		const geometry = computeLunarEclipseMapGeometry(ancient, fastSunMoonPosition)
		expect(geometry.events).toHaveLength(events.length)
		expect(geometry.lines.moonRiseSet.MAX![0].length).toBeGreaterThan(0)
	})
})

describe('maxAngularStep validation', () => {
	// An invalid spacing must fall back to the default, not make the per-curve sample count non-finite and throw
	// a RangeError from new Array(...).
	test('invalid maxAngularStep falls back to the default instead of throwing', () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const geometry = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition, { maxAngularStep: bad })
			const branch = geometry.lines.moonRiseSet.MAX![0]
			expect(branch.length).toBeGreaterThan(1)
			for (const point of branch) {
				expect(Number.isFinite(point.x)).toBe(true)
				expect(Number.isFinite(point.y)).toBe(true)
			}
		}

		// The fallback produces exactly the default-spacing curve.
		const fallback = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition, { maxAngularStep: 0 }).lines.moonRiseSet.MAX![0]
		const byDefault = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition).lines.moonRiseSet.MAX![0]
		expect(fallback.length).toBe(byDefault.length)
	}, 4000)

	// A pathologically small but finite maxAngularStep passes the finite-positive check, yet would derive an
	// unsafe array length and throw a RangeError; the per-curve point count must be capped instead.
	test('a tiny maxAngularStep is capped instead of throwing', () => {
		for (const tiny of [Number.MIN_VALUE, 1e-300, 1e-12]) {
			const geometry = computeLunarEclipseMapGeometry(PENUMBRAL, fastSunMoonPosition, { maxAngularStep: tiny })
			const branch = geometry.lines.moonRiseSet.MAX![0]
			// Many points (a fine curve), but bounded by the safety ceiling (+ the repeated closing vertex).
			expect(branch.length).toBeGreaterThan(1000)
			expect(branch.length).toBeLessThanOrEqual(100001)
			expect(Number.isFinite(branch[0].x)).toBe(true)
			expect(Number.isFinite(branch.at(-1)!.y)).toBe(true)
		}
	}, 8000)
})

describe('horizon curve geometry', () => {
	const geometry = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition)

	test('every curve point is finite and within latitude bounds', () => {
		for (const event of geometry.events) {
			const curve = geometry.lines.moonRiseSet[event.kind]!
			expect(curve.length).toBeGreaterThan(0)
			for (const branch of curve) {
				for (const point of branch) {
					expect(Number.isFinite(point.x)).toBe(true)
					expect(Number.isFinite(point.y)).toBe(true)
					expect(point.x).toBeGreaterThanOrEqual(-Math.PI - 1e-9)
					expect(point.x).toBeLessThanOrEqual(Math.PI + 1e-9)
					expect(Math.abs(point.y)).toBeLessThanOrEqual(PIOVERTWO + 1e-9)
				}
			}
		}
	})

	test('every curve point has topocentric Moon altitude on the horizon', () => {
		// Rise/set is a topocentric condition. The parallax-reduced circle must put the topocentric Moon center
		// on the horizon (h0 = 0); the bare geocentric circle would leave it ~one horizontal parallax (~0.95 deg)
		// above the boundary. The geocentric altitude (moonAltitude) at these points is now h0 + parallax, not h0.
		for (const event of geometry.events) {
			const branch = geometry.lines.moonRiseSet[event.kind]![0]
			const stepN = Math.max(1, Math.floor(branch.length / 12))
			for (let i = 0; i < branch.length; i += stepN) {
				const point = branch[i]
				const topocentricAltitude = moonAltitudeAt(event.time, point.x, point.y, fastSunMoonPosition)
				expect(topocentricAltitude).toBeCloseTo(0, 3)
			}
		}
	}, 8000)

	test('sublunar point sees the Moon at the zenith and its antipode below the horizon', () => {
		for (const event of geometry.events) {
			const sub = event.sublunar
			const altSub = moonAltitude(event.rightAscension, event.declination, event.gast, sub.x, sub.y)
			expect(altSub).toBeCloseTo(PIOVERTWO, 6)
			const antipodeLon = sub.x > 0 ? sub.x - Math.PI : sub.x + Math.PI
			const altAnti = moonAltitude(event.rightAscension, event.declination, event.gast, antipodeLon, -sub.y)
			expect(altAnti).toBeCloseTo(-PIOVERTWO, 6)
		}
	})

	test('horizon altitude option shifts the curve to that topocentric altitude', () => {
		const altOption: Angle = deg(10)
		const geo = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition, { horizonAltitude: altOption })
		const max = geo.events.find((e) => e.kind === 'MAX')!
		const branch = geo.lines.moonRiseSet.MAX![0]
		const stepN = Math.max(1, Math.floor(branch.length / 12))
		for (let i = 0; i < branch.length; i += stepN) {
			const point = branch[i]
			expect(moonAltitudeAt(max.time, point.x, point.y, fastSunMoonPosition)).toBeCloseTo(altOption, 3)
		}
	}, 2000)

	test('negative horizon altitude option lowers the topocentric curve', () => {
		const altOption: Angle = deg(-2)
		const geo = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition, { horizonAltitude: altOption })
		const max = geo.events.find((e) => e.kind === 'MAX')!
		const branch = geo.lines.moonRiseSet.MAX![0]
		const stepN = Math.max(1, Math.floor(branch.length / 12))
		expect(max.horizonAltitude).toBeCloseTo(altOption, 12)
		for (let i = 0; i < branch.length; i += stepN) {
			const point = branch[i]
			expect(moonAltitudeAt(max.time, point.x, point.y, fastSunMoonPosition)).toBeCloseTo(altOption, 3)
		}
	}, 2000)
})

describe('upper-limb visibility', () => {
	// TOTAL is the 1997-07 eclipse, near perigee: its apparent semidiameter (~0.279 deg) is distinctly larger
	// than the mean (~0.259 deg), so the upper-limb curve must use the per-event semidiameter from the distance.
	test('upper-limb curve uses the per-event semidiameter from the Moon distance', () => {
		const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition, { limbVisibility: 'upperLimb' })
		for (const event of geometry.events) {
			const semidiameter = Math.asin(MOON_RADIUS_EARTH_RADII / event.distance)
			// Near perigee, distinctly above the 0.259 deg mean a fixed lift would have used.
			expect(semidiameter).toBeGreaterThan(deg(0.27))
			// The effective horizon is one semidiameter below the true horizon (upper limb on the horizon).
			expect(event.horizonAltitude).toBeCloseTo(-semidiameter, 9)
			// Sampled curve points have topocentric Moon-center altitude = -asin(moonRadius / distance).
			const branch = geometry.lines.moonRiseSet[event.kind]![0]
			const stepN = Math.max(1, Math.floor(branch.length / 8))

			for (let i = 0; i < branch.length; i += stepN) {
				const point = branch[i]
				expect(moonAltitudeAt(event.time, point.x, point.y, sunMoonPosition)).toBeCloseTo(-semidiameter, 3)
			}
		}
	}, 8000)
})

describe('high declination robustness', () => {
	// A northern-declination total eclipse: the sublunar point is far north, exercising a near-polar circle.
	test('curve stays finite and within latitude bounds', () => {
		const geometry = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition)
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		for (const point of geometry.lines.moonRiseSet.MAX![0]) {
			expect(Number.isFinite(point.x)).toBe(true)
			expect(Number.isFinite(point.y)).toBe(true)
			expect(Math.abs(point.y)).toBeLessThanOrEqual(PIOVERTWO + 1e-9)
		}
		expect(Math.abs(max.declination)).toBeLessThanOrEqual(PIOVERTWO)
	})
})

describe('SVG serialization', () => {
	const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition)
	const projection = equirectangular(720, 360)
	const svg = lunarEclipseMapToSvgPaths(geometry, projection)

	test('emits a path per existing contact and no NaN/Infinity', () => {
		for (const kind of ['P1', 'U1', 'U2', 'MAX', 'U3', 'U4', 'P4'] as LunarEclipseContactKind[]) {
			const path = svg.moonRiseSet[kind]
			expect(path.length).toBeGreaterThan(0)
			expect(path).not.toContain('NaN')
			expect(path).not.toContain('Infinity')
			expect(path.startsWith('M')).toBe(true)
		}
	})

	test('antimeridian wrap splits into multiple subpaths instead of one spanning line', () => {
		// A horizon circle spans all longitudes, so it must cross the antimeridian and split into >= 2 subpaths.
		const subpaths = svg.moonRiseSet.MAX.split('M').length - 1
		expect(subpaths).toBeGreaterThanOrEqual(2)
	})

	// With a non-zero central meridian supplied via projectionOptions, the open curve must split on the shifted
	// seam (central meridian +- PI), not raw +- PI; otherwise a segment crossing the real seam is drawn as a
	// full-width horizontal line across the map. The longest projected segment must stay well under the map width.
	test('open curves follow a non-zero central meridian without a map-spanning segment', () => {
		const centered = lunarEclipseMapToSvgPaths(geometry, projection, { projectionOptions: { centralMeridian: PI } }).moonRiseSet.MAX
		expect(centered.length).toBeGreaterThan(0)
		expect(longestProjectedSegment(centered)).toBeLessThan(720 / 2)
		// It still crosses the (shifted) seam, so it splits into multiple subpaths.
		expect(centered.split('M').length - 1).toBeGreaterThanOrEqual(2)
	})

	test('projects the sublunar points', () => {
		expect(svg.sublunarPoints.MAX).toBeDefined()
		expect(Number.isFinite(svg.sublunarPoints.MAX!.x)).toBe(true)
		expect(Number.isFinite(svg.sublunarPoints.MAX!.y)).toBe(true)
	})

	test('penumbral eclipse omits umbral contact paths', () => {
		const geo = computeLunarEclipseMapGeometry(PENUMBRAL, fastSunMoonPosition)
		const paths = lunarEclipseMapToSvgPaths(geo, projection)
		expect(paths.moonRiseSet.P1.length).toBeGreaterThan(0)
		expect(paths.moonRiseSet.U1).toBe('')
		expect(paths.moonRiseSet.U2).toBe('')
		expect(paths.moonRiseSet.MAX.length).toBeGreaterThan(0)
	})
})

// Parses an "M x y L x y ... Z" path into its vertices.
function parsePolygon(path: string): { x: number; y: number }[] {
	const points: { x: number; y: number }[] = []
	for (const token of path.replaceAll('Z', '').split(/[ML]/)) {
		const trimmed = token.trim()
		if (!trimmed) continue
		const [x, y] = trimmed.split(/\s+/).map(Number)
		if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y })
	}
	return points
}

// Ray-casting point-in-polygon test.
function pointInPolygon(px: number, py: number, polygon: { x: number; y: number }[]): boolean {
	let inside = false
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x
		const yi = polygon[i].y
		const xj = polygon[j].x
		const yj = polygon[j].y
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
	}
	return inside
}

// Even-odd point-in-path test across every "M ... Z" subpath, matching the fill-rule the polygons require.
function pointInPath(px: number, py: number, path: string): boolean {
	let inside = false
	for (const part of path.split('M')) {
		const trimmed = part.trim()
		if (!trimmed) continue
		const polygon = parsePolygon(`M${trimmed}`)
		if (polygon.length >= 3 && pointInPolygon(px, py, polygon)) inside = !inside
	}
	return inside
}

describe('fill region polygons', () => {
	const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition)
	const projection = equirectangular(720, 360)

	test('fill replaces the open curves with closed polygons', () => {
		// Without fill the curves are open polylines; with fill moonRiseSet holds closed region polygons.
		expect(lunarEclipseMapToSvgPaths(geometry, projection).moonRiseSet.MAX.endsWith('Z')).toBe(false)
		expect(lunarEclipseMapToSvgPaths(geometry, projection, { fill: true }).moonRiseSet.MAX.endsWith('Z')).toBe(true)
	})

	test('each region polygon is closed and finite', () => {
		const paths = lunarEclipseMapToSvgPaths(geometry, projection, { fill: true })
		for (const kind of ['P1', 'U1', 'U2', 'MAX', 'U3', 'U4', 'P4'] as LunarEclipseContactKind[]) {
			const path = paths.moonRiseSet[kind]
			expect(path.startsWith('M')).toBe(true)
			expect(path.endsWith('Z')).toBe(true)
			expect(path).not.toContain('NaN')
			expect(path).not.toContain('Infinity')
		}
	})

	test('aboveHorizon fill contains the sublunar point and belowHorizon does not', () => {
		const above = lunarEclipseMapToSvgPaths(geometry, projection, { fill: true, fillRegion: 'aboveHorizon' })
		const below = lunarEclipseMapToSvgPaths(geometry, projection, { fill: true, fillRegion: 'belowHorizon' })
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		const sub = projection.project(max.sublunar.x, max.sublunar.y)!

		expect(pointInPolygon(sub.x, sub.y, parsePolygon(above.moonRiseSet.MAX))).toBe(true)
		expect(pointInPolygon(sub.x, sub.y, parsePolygon(below.moonRiseSet.MAX))).toBe(false)
	})

	test('aboveHorizon fill excludes the antipodal (below-horizon) point', () => {
		const above = lunarEclipseMapToSvgPaths(geometry, projection, { fill: true, fillRegion: 'aboveHorizon' })
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		const antiLon = max.sublunar.x > 0 ? max.sublunar.x - Math.PI : max.sublunar.x + Math.PI
		const anti = projection.project(antiLon, -max.sublunar.y)!
		expect(pointInPolygon(anti.x, anti.y, parsePolygon(above.moonRiseSet.MAX))).toBe(false)
	})

	// Near the celestial equator (|declination| below the lunar parallax) the cap encloses neither pole, so the
	// pole-edge closure is wrong; the ring-topology path must still put the sublunar point inside the cap.
	test('near-equatorial eclipse: aboveHorizon fill contains the sublunar point', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(2016, 3, 1), true)
		const geo = computeLunarEclipseMapGeometry(eclipse, fastSunMoonPosition)
		const max = geo.events.find((e) => e.kind === 'MAX')!
		// 2016-03-23 penumbral eclipse: MAX declination ~ -0.31 deg, smaller than the ~0.95 deg lunar parallax.
		expect(Math.abs(max.declination)).toBeLessThan(deg(0.95))

		const above = lunarEclipseMapToSvgPaths(geo, projection, { fill: true, fillRegion: 'aboveHorizon' }).moonRiseSet.MAX
		const sub = projection.project(max.sublunar.x, max.sublunar.y)!
		expect(pointInPath(sub.x, sub.y, above)).toBe(true)

		// The antipodal point is below the horizon, so it must be outside the cap.
		const antiLon = max.sublunar.x > 0 ? max.sublunar.x - Math.PI : max.sublunar.x + Math.PI
		const anti = projection.project(antiLon, -max.sublunar.y)!
		expect(pointInPath(anti.x, anti.y, above)).toBe(false)
	})

	// The belowHorizon complement of a near-equatorial cap is the map rectangle with the cap punched out:
	// the antipode is inside it, the sublunar point is not (with the required even-odd fill rule).
	test('near-equatorial eclipse: belowHorizon fill is the cap complement', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(2016, 3, 1), true)
		const geo = computeLunarEclipseMapGeometry(eclipse, fastSunMoonPosition)
		const max = geo.events.find((e) => e.kind === 'MAX')!
		const below = lunarEclipseMapToSvgPaths(geo, projection, { fill: true, fillRegion: 'belowHorizon' }).moonRiseSet.MAX
		const sub = projection.project(max.sublunar.x, max.sublunar.y)!
		const antiLon = max.sublunar.x > 0 ? max.sublunar.x - Math.PI : max.sublunar.x + Math.PI
		const anti = projection.project(antiLon, -max.sublunar.y)!
		expect(pointInPath(anti.x, anti.y, below)).toBe(true)
		expect(pointInPath(sub.x, sub.y, below)).toBe(false)
	})

	// A sufficiently negative horizon makes the visibility cap larger than a hemisphere: the above-horizon region
	// contains the sublunar point AND both poles, and the bounded ring is the small antipodal below-horizon hole.
	// aboveHorizon must fill the complement of that ring, not the ring (which would invert the regions).
	test('near-equatorial eclipse with a lowered horizon fills the larger-than-hemisphere cap', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(2016, 3, 1), true)
		const geo = computeLunarEclipseMapGeometry(eclipse, fastSunMoonPosition, { horizonAltitude: deg(-2) })
		const max = geo.events.find((e) => e.kind === 'MAX')!
		const above = lunarEclipseMapToSvgPaths(geo, projection, { fill: true, fillRegion: 'aboveHorizon' }).moonRiseSet.MAX
		const below = lunarEclipseMapToSvgPaths(geo, projection, { fill: true, fillRegion: 'belowHorizon' }).moonRiseSet.MAX
		const sub = projection.project(max.sublunar.x, max.sublunar.y)!
		const antiLon = max.sublunar.x > 0 ? max.sublunar.x - Math.PI : max.sublunar.x + Math.PI
		const anti = projection.project(antiLon, -max.sublunar.y)!

		// Above-horizon contains the sublunar point and excludes its antipode.
		expect(pointInPath(sub.x, sub.y, above)).toBe(true)
		expect(pointInPath(anti.x, anti.y, above)).toBe(false)
		// Below-horizon is the antipodal hole: the antipode is inside, the sublunar point outside.
		expect(pointInPath(anti.x, anti.y, below)).toBe(true)
		expect(pointInPath(sub.x, sub.y, below)).toBe(false)
	})

	// A lowered horizon on a near-equatorial eclipse makes the cap exceed a hemisphere AND enclose BOTH poles
	// (the ring then winds neither pole, winding ~ 0). aboveHorizon must contain both poles - the Moon is above
	// the threshold there - and exclude only the small antipodal below-horizon hole. (When the cap exceeds a
	// hemisphere but encloses just one pole, the ring winds that pole and the polar branch handles it; the two
	// conditions "ring winds a pole" and "both poles above the threshold" cannot hold together.)
	test('lowered horizon on a near-equatorial eclipse: both poles are inside aboveHorizon', () => {
		const geo = computeLunarEclipseMapGeometry(TOTAL, fastSunMoonPosition, { horizonAltitude: deg(-5) })
		const max = geo.events.find((e) => e.kind === 'MAX')!
		const above = lunarEclipseMapToSvgPaths(geo, projection, { fill: true, fillRegion: 'aboveHorizon' }).moonRiseSet.MAX
		const northPole = projection.project(0, PIOVERTWO - 1e-6)!
		const southPole = projection.project(0, -(PIOVERTWO - 1e-6))!
		const antiLon = max.sublunar.x > 0 ? max.sublunar.x - Math.PI : max.sublunar.x + Math.PI
		const anti = projection.project(antiLon, -max.sublunar.y)!

		expect(pointInPath(northPole.x, northPole.y, above)).toBe(true)
		expect(pointInPath(southPole.x, southPole.y, above)).toBe(true)
		expect(pointInPath(anti.x, anti.y, above)).toBe(false)
	})

	// The fill must follow the projection's central meridian exactly like the open curves: a polar cap ordered and
	// closed in raw [-PI, PI] longitude (ignoring the central meridian) fills the wrong side. With a map centered on
	// 180 deg, the MAX cap of the 1997-09-16 total eclipse must still place the sublunar point inside aboveHorizon,
	// its antipode outside, and the enclosed pole inside.
	test('a non-zero central meridian fills the same side of the curve', () => {
		const centered = new PlateCarree(undefined, { scale: 720 / TAU, falseEasting: 360, falseNorthing: 180, yAxisDirection: 'southUp', centralMeridian: PI, longitudeWrapMode: 'pi', maxLatitude: PIOVERTWO })
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		const above = lunarEclipseMapToSvgPaths(geometry, centered, { fill: true, fillRegion: 'aboveHorizon' }).moonRiseSet.MAX

		const sub = centered.project(max.sublunar.x, max.sublunar.y)!
		const antiLon = max.sublunar.x > 0 ? max.sublunar.x - PI : max.sublunar.x + PI
		const anti = centered.project(antiLon, -max.sublunar.y)!
		// Project the enclosed pole at the central meridian so it lands in the map interior, not on the +-PI edge
		// where a point-in-polygon test would be ambiguous.
		const enclosedPole = centered.project(PI, max.declination >= 0 ? PIOVERTWO - 1e-6 : -(PIOVERTWO - 1e-6))!

		expect(pointInPath(sub.x, sub.y, above)).toBe(true)
		expect(pointInPath(anti.x, anti.y, above)).toBe(false)
		expect(pointInPath(enclosedPole.x, enclosedPole.y, above)).toBe(true)
	})

	// Same requirement, but with the central meridian supplied through options.projectionOptions (the documented
	// call-time channel) on a projection built at meridian 0. The fill must resolve the central meridian the same
	// way the open curves and sublunar points do, so the shadow follows them; the bug left the fill at the
	// projection's own meridian (0) while the sublunar point shifted, so the shadow excluded it.
	test('central meridian from options.projectionOptions still fills the same side', () => {
		const projectionOptions = { centralMeridian: PI }
		const max = geometry.events.find((e) => e.kind === 'MAX')!
		const paths = lunarEclipseMapToSvgPaths(geometry, projection, { fill: true, fillRegion: 'aboveHorizon', projectionOptions })
		const above = paths.moonRiseSet.MAX

		const sub = projection.project(max.sublunar.x, max.sublunar.y, undefined, projectionOptions)!
		const antiLon = max.sublunar.x > 0 ? max.sublunar.x - PI : max.sublunar.x + PI
		const anti = projection.project(antiLon, -max.sublunar.y, undefined, projectionOptions)!
		const enclosedPole = projection.project(PI, max.declination >= 0 ? PIOVERTWO - 1e-6 : -(PIOVERTWO - 1e-6), undefined, projectionOptions)!

		// The sublunar point (projected with the call-time options) shifts with the central meridian, and the fill
		// must shift with it.
		expect(paths.sublunarPoints.MAX).toEqual(sub)
		expect(pointInPath(sub.x, sub.y, above)).toBe(true)
		expect(pointInPath(anti.x, anti.y, above)).toBe(false)
		expect(pointInPath(enclosedPole.x, enclosedPole.y, above)).toBe(true)
	})
})
