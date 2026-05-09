import { describe, expect, test } from 'bun:test'
import { WGS84_FLATTENING, WGS84_RADIUS, AU_KM } from '../src/constants'
import { angularDistance } from '../src/coordinate'
import { nearestSolarEclipse, type SolarEclipseType } from '../src/sun'
import { type BesselianElements, generateBesselianElements } from '../src/sun.eclipse.besselian'
import { generateCentralPathPolygon, generatePathLimits, type EclipsePathLimitPoint, type EclipsePathLimitsResult } from '../src/sun.eclipse.limits'
import { Timescale, timeShift, timeYMD } from '../src/time'

const total2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 3, 1), true).maximalTime })
const annular2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 4, 9), true).maximalTime })
const partial2025 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2025, 9, 21), true).maximalTime })
const hybrid2023 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2023, 1, 1), true).maximalTime })

function expectFiniteLimitPoint(point: EclipsePathLimitPoint) {
	expect(point.time.day).toBeFinite()
	expect(point.time.fraction).toBeFinite()
	expect(point.lat).toBeFinite()
	expect(Math.abs(point.lat)).toBeLessThanOrEqual(Math.PI / 2)
	expect(point.lon).toBeFinite()
	expect(point.lon).toBeGreaterThanOrEqual(-Math.PI)
	expect(point.lon).toBeLessThan(Math.PI)
	expect(point.solarAltitude).toBeFinite()
	expect(point.localDurationSeconds).toBeFinite()
	expect(point.distanceFromCenterKm).toBeFinite()
	expect(point.distanceFromCenterKm).toBeGreaterThanOrEqual(0)
}

function expectFiniteLimits(result: EclipsePathLimitsResult) {
	for (const point of result.northLimit) expectFiniteLimitPoint(point)
	for (const point of result.southLimit) expectFiniteLimitPoint(point)
	for (const profile of result.widthProfile) {
		expect(profile.widthKm).toBeFinite()
		expect(profile.widthKm).toBeGreaterThanOrEqual(0)
		expect(profile.centerLat).toBeFinite()
		expect(profile.centerLon).toBeFinite()
	}
	for (const polygon of result.polygons) for (const point of polygon.points) expectFiniteLimitPoint(point)
}

function maxRawLongitudeJump(points: readonly EclipsePathLimitPoint[]) {
	let max = 0
	for (let i = 1; i < points.length; i++) max = Math.max(max, Math.abs(points[i].lon - points[i - 1].lon))
	return max
}

function maxLimitGap(result: EclipsePathLimitsResult) {
	let max = 0

	for (const polygon of result.polygons) {
		for (let i = 1; i < polygon.northLimit.length; i++) {
			max = Math.max(max, angularDistance(polygon.northLimit[i - 1].lon, polygon.northLimit[i - 1].lat, polygon.northLimit[i].lon, polygon.northLimit[i].lat))
		}
		for (let i = 1; i < polygon.southLimit.length; i++) {
			max = Math.max(max, angularDistance(polygon.southLimit[i - 1].lon, polygon.southLimit[i - 1].lat, polygon.southLimit[i].lon, polygon.southLimit[i].lat))
		}
	}

	return max
}

function syntheticElements(input: Partial<Record<'x' | 'y' | 'd' | 'mu' | 'l1' | 'l2' | 'tanF1' | 'tanF2', readonly [number, number]>> & { type?: SolarEclipseType } = {}): BesselianElements {
	const t0 = timeYMD(2024, 1, 1, 0, Timescale.TT)

	function polynomial(key: 'x' | 'y' | 'd' | 'mu' | 'l1' | 'l2' | 'tanF1' | 'tanF2', value: number, slope = 0) {
		const coefficients = input[key] ?? [value, slope]
		return { degree: 1, coefficients: Array.from(coefficients) }
	}

	return {
		t0,
		deltaTSeconds: 69,
		validFrom: timeShift(t0, -0.5 / 24),
		validTo: timeShift(t0, 0.5 / 24),
		polynomialDegree: 1,
		x: polynomial('x', 0, 0.02),
		y: polynomial('y', 0),
		d: polynomial('d', Math.PI / 2 - 1e-3),
		mu: polynomial('mu', 0, 0.5),
		l1: polynomial('l1', 0.55),
		l2: polynomial('l2', 0.02),
		l2SignConvention: 'positiveTotal',
		tanF1: polynomial('tanF1', 0.0046),
		tanF2: polynomial('tanF2', 0.0045),
		eclipseTypeApprox: input.type ?? 'TOTAL',
		geocentricMaximum: t0,
		earth: {
			equatorialRadius: WGS84_RADIUS,
			flattening: WGS84_FLATTENING,
		},
	}
}

describe('solar eclipse path limits', () => {
	test('returns empty limits for partial-only eclipses', () => {
		const result = generatePathLimits(partial2025)

		expect(result.centerLine.hasCentralLine).toBeFalse()
		expect(result.northLimit).toHaveLength(0)
		expect(result.southLimit).toHaveLength(0)
		expect(result.widthProfile).toHaveLength(0)
		expect(result.polygons).toHaveLength(0)
	})

	test('generates aligned total eclipse limits and width profile', () => {
		const result = generatePathLimits(total2024, { stepSeconds: 300 })

		expect(result.northLimit.length).toBeGreaterThan(0)
		expect(result.southLimit).toHaveLength(result.northLimit.length)
		expect(result.widthProfile).toHaveLength(result.northLimit.length)
		expect(result.polygons).toHaveLength(1)
		expect(result.northLimit.every((point) => point.side === 'NORTH' && point.eclipseType === 'TOTAL')).toBeTrue()
		expect(result.southLimit.every((point) => point.side === 'SOUTH' && point.eclipseType === 'TOTAL')).toBeTrue()
		expect(result.northLimit.every((point, index) => point.lat >= result.southLimit[index].lat)).toBeTrue()
		expect(result.northLimit.every((point) => point.localDurationSeconds === 0 && Math.abs(point.residual ?? 0) < 1e-4)).toBeTrue()
		expect(result.diagnostics?.acceptedLimitPairs).toBe(result.widthProfile.length)
		expectFiniteLimits(result)
	})

	test('generates annular eclipse limits', () => {
		const result = generatePathLimits(annular2024, { stepSeconds: 300 })

		expect(result.northLimit.length).toBeGreaterThan(0)
		expect(result.widthProfile.every((profile) => profile.eclipseType === 'ANNULAR')).toBeTrue()
		expect(result.polygons).toHaveLength(1)
		expect(result.polygons[0].eclipseType).toBe('ANNULAR')
		expectFiniteLimits(result)
	})

	test('represents hybrid paths with total and annular limit samples', () => {
		const result = generatePathLimits(hybrid2023, { stepSeconds: 30, splitAntimeridian: true })
		const types = new Set(result.widthProfile.map((profile) => profile.eclipseType))

		expect(types.has('TOTAL')).toBeTrue()
		expect(types.has('ANNULAR')).toBeTrue()
		expect(result.polygons.some((polygon) => polygon.eclipseType === 'TOTAL')).toBeTrue()
		expect(result.polygons.some((polygon) => polygon.eclipseType === 'ANNULAR')).toBeTrue()
		expectFiniteLimits(result)
	})

	test('normalizes longitudes and avoids artificial antimeridian polygon edges when split', () => {
		const split = generatePathLimits(hybrid2023, { stepSeconds: 30, splitAntimeridian: true })
		const unsplit = generatePathLimits(hybrid2023, { stepSeconds: 30, splitAntimeridian: false })

		expect(split.northLimit.every((point) => point.lon >= -Math.PI && point.lon < Math.PI)).toBeTrue()
		expect(split.southLimit.every((point) => point.lon >= -Math.PI && point.lon < Math.PI)).toBeTrue()
		expect(split.polygons.every((polygon) => !polygon.crossesAntimeridian && maxRawLongitudeJump(polygon.points) < Math.PI)).toBeTrue()
		expect(unsplit.polygons.some((polygon) => polygon.crossesAntimeridian)).toBeTrue()
	})

	test('builds a closed central path polygon without interior duplicate points', () => {
		const polygon = generateCentralPathPolygon(total2024, { stepSeconds: 300 })

		expect(polygon.closed).toBeTrue()
		expect(polygon.points.length).toBeGreaterThan(3)
		expect(polygon.points[0].lat).toBe(polygon.points.at(-1)!.lat)
		expect(polygon.points[0].lon).toBe(polygon.points.at(-1)!.lon)

		for (let i = 1; i + 1 < polygon.points.length; i++) {
			const distance = angularDistance(polygon.points[i - 1].lon, polygon.points[i - 1].lat, polygon.points[i].lon, polygon.points[i].lat) * total2024.earth.equatorialRadius * AU_KM
			expect(distance).toBeGreaterThan(1e-6)
		}
	})

	test('computes width as the geodesic distance between north and south limits', () => {
		const result = generatePathLimits(total2024, { stepSeconds: 300 })

		for (let i = 0; i < result.widthProfile.length; i++) {
			const north = result.northLimit[i]
			const south = result.southLimit[i]
			const profile = result.widthProfile[i]
			const expectedWidth = angularDistance(north.lon, north.lat, south.lon, south.lat) * total2024.earth.equatorialRadius * AU_KM

			expect(profile.widthKm).toBeCloseTo(expectedWidth, 9)
			expect(north.distanceFromCenterKm + south.distanceFromCenterKm).toBeCloseTo(profile.widthKm, 6)
		}
	})

	test('clips limit points below the configured horizon', () => {
		const unfiltered = generatePathLimits(total2024, { stepSeconds: 300, solarAltitudeMin: 0.7, discardBelowHorizon: false })
		const filtered = generatePathLimits(total2024, { stepSeconds: 300, solarAltitudeMin: 0.7, discardBelowHorizon: true })

		expect(filtered.widthProfile.length).toBeLessThan(unfiltered.widthProfile.length)
		expect(filtered.northLimit.every((point) => point.solarAltitude >= 0.7)).toBeTrue()
		expect(filtered.southLimit.every((point) => point.solarAltitude >= 0.7)).toBeTrue()
		expectFiniteLimits(filtered)
	})

	test('supports ellipsoid and spherical Earth modes', () => {
		const ellipsoid = generatePathLimits(total2024, { stepSeconds: 600, useEllipsoid: true })
		const spherical = generatePathLimits(total2024, { stepSeconds: 600, useEllipsoid: false })
		const index = Math.floor(Math.min(ellipsoid.northLimit.length, spherical.northLimit.length) / 2)
		const latitudeDifference = Math.abs(ellipsoid.northLimit[index].lat - spherical.northLimit[index].lat)

		expect(ellipsoid.widthProfile.length).toBeGreaterThan(0)
		expect(spherical.widthProfile.length).toBeGreaterThan(0)
		expect(latitudeDifference).toBeGreaterThan(1e-5)
		expect(latitudeDifference).toBeLessThan(0.01)
		expectFiniteLimits(ellipsoid)
		expectFiniteLimits(spherical)
	})

	test('adaptive central-line sampling reduces path-limit gaps', () => {
		const coarse = generatePathLimits(total2024, { stepSeconds: 900, adaptiveSampling: false })
		const adaptive = generatePathLimits(total2024, { stepSeconds: 900, adaptiveSampling: true, maxSegmentAngularDistance: 0.02 })

		expect(adaptive.widthProfile.length).toBeGreaterThan(coarse.widthProfile.length)
		expect(maxLimitGap(coarse)).toBeGreaterThan(0.02)
		expect(maxLimitGap(adaptive)).toBeLessThanOrEqual(0.021)
		expectFiniteLimits(adaptive)
	})

	test('handles synthetic narrow, wide, polar, and missing central paths', () => {
		const narrow = generatePathLimits(syntheticElements({ l2: [0.002, 0] }), { stepSeconds: 300, useEllipsoid: false })
		const wide = generatePathLimits(syntheticElements({ l2: [0.06, 0] }), { stepSeconds: 300, useEllipsoid: false })
		const miss = generatePathLimits(syntheticElements({ x: [2, 0] }), { stepSeconds: 300, useEllipsoid: false })

		expect(narrow.widthProfile.length).toBeGreaterThan(0)
		expect(wide.widthProfile.length).toBeGreaterThan(0)
		expect(wide.widthProfile[0].widthKm).toBeGreaterThan(narrow.widthProfile[0].widthKm)
		expect(narrow.northLimit.some((point) => Math.abs(point.lat) > 1.5)).toBeTrue()
		expect(miss.widthProfile).toHaveLength(0)
		expect(miss.polygons).toHaveLength(0)
		expectFiniteLimits(narrow)
		expectFiniteLimits(wide)
	})
})
