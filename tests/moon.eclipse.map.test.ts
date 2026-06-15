import { describe, expect, test } from 'bun:test'
import type { Angle } from '../src/angle'
import { PIOVERTWO, TAU } from '../src/constants'
import * as elpmpp02 from '../src/elpmpp02'
import { nearestLunarEclipse } from '../src/moon'
import { computeLunarEclipseMapGeometry, lunarEclipseEvents, lunarEclipseMapToSvgPaths, type LunarEclipseContactKind } from '../src/moon.eclipse.map'
import { PlateCarree } from '../src/projection'
import { computeSunMoonPositionAt } from '../src/sun.eclipse.map'
import { type Time, timeYMDHMS } from '../src/time'
import * as vsop87e from '../src/vsop87e'

// Apparent Sun/Moon position provider from the analytical VSOP87E + ELP/MPP02 ephemerides (no fixtures).
function sunMoonPosition(t: Time) {
	return computeSunMoonPositionAt(t, vsop87e.sun, vsop87e.earth, elpmpp02.moon)
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
})

describe('horizon curve geometry', () => {
	const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition)

	test('every curve point has Moon altitude on the horizon', () => {
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
					const alt = moonAltitude(event.rightAscension, event.declination, event.gast, point.x, point.y)
					expect(alt).toBeCloseTo(0, 5)
				}
			}
		}
	})

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

	test('horizon altitude option shifts the curve to that altitude', () => {
		const altOption: Angle = (10 / 180) * Math.PI
		const geo = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition, { horizonAltitude: altOption })
		const max = geo.events.find((e) => e.kind === 'MAX')!
		for (const point of geo.lines.moonRiseSet.MAX![0]) {
			const alt = moonAltitude(max.rightAscension, max.declination, max.gast, point.x, point.y)
			expect(alt).toBeCloseTo(altOption, 5)
		}
	})
})

describe('high declination robustness', () => {
	// A northern-declination total eclipse: the sublunar point is far north, exercising a near-polar circle.
	test('curve stays finite and within latitude bounds', () => {
		const geometry = computeLunarEclipseMapGeometry(TOTAL, sunMoonPosition)
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

	test('projects the sublunar points', () => {
		expect(svg.sublunarPoints.MAX).toBeDefined()
		expect(Number.isFinite(svg.sublunarPoints.MAX!.x)).toBe(true)
		expect(Number.isFinite(svg.sublunarPoints.MAX!.y)).toBe(true)
	})

	test('penumbral eclipse omits umbral contact paths', () => {
		const geo = computeLunarEclipseMapGeometry(PENUMBRAL, sunMoonPosition)
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
})
