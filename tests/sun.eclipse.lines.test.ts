import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { WGS84_FLATTENING, WGS84_RADIUS } from '../src/constants'
import { angularDistanceHaversine } from '../src/coordinate'
import { nearestSolarEclipse, type SolarEclipseType } from '../src/sun'
import { type BesselianElements, generateBesselianElements } from '../src/sun.eclipse.besselian'
import { generateCentralLine, type CentralLinePoint, type CentralLineResult } from '../src/sun.eclipse.lines'
import { Timescale, timeShift, timeYMD } from '../src/time'

const total2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 3, 1), true).maximalTime })
const annular2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 4, 9), true).maximalTime })
const partial2025 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2025, 9, 21), true).maximalTime })
const hybrid2023 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2023, 1, 1), true).maximalTime })

function expectFiniteCentralPoint(point: CentralLinePoint) {
	expect(point.time.day).toBeFinite()
	expect(point.lat).toBeFinite()
	expect(Math.abs(point.lat)).toBeLessThanOrEqual(Math.PI / 2)
	expect(point.lon).toBeFinite()
	expect(point.lon).toBeGreaterThanOrEqual(-Math.PI)
	expect(point.lon).toBeLessThan(Math.PI)
	expect(point.solarAltitude).toBeFinite()
	expect(point.magnitude).toBeFinite()
	expect(point.pathWidthKm).toBeFinite()
	expect(point.centralDurationSeconds).toBeFinite()
}

function expectFiniteLine(line: CentralLineResult) {
	for (const point of line.points) expectFiniteCentralPoint(point)
	for (const segment of line.segments) for (const point of segment) expectFiniteCentralPoint(point)
}

function maxSegmentDistance(line: CentralLineResult) {
	let max = 0

	for (const segment of line.segments) {
		for (let i = 1; i < segment.length; i++) {
			max = Math.max(max, angularDistance(segment[i - 1], segment[i]))
		}
	}

	return max
}

function angularDistance(a: CentralLinePoint, b: CentralLinePoint) {
	return angularDistanceHaversine(a.lon, a.lat, b.lon, b.lat)
}

function syntheticElements(input: Partial<Record<'x' | 'y' | 'd' | 'mu' | 'l1' | 'l2' | 'tanF1' | 'tanF2', readonly [number, number]>> & { type?: SolarEclipseType } = {}): BesselianElements {
	const t0 = timeYMD(2024, 1, 1, 0, Timescale.TT)

	function polynomial(key: 'x' | 'y' | 'd' | 'mu' | 'l1' | 'l2' | 'tanF1' | 'tanF2', value: number, slope = 0) {
		const coefficients = input[key] ?? [value, slope]
		return { degree: 1, coefficients: [...coefficients] }
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
		eclipseTypeApprox: input.type ?? 'total',
		geocentricMaximum: t0,
		earth: {
			equatorialRadius: WGS84_RADIUS,
			flattening: WGS84_FLATTENING,
		},
	}
}

describe('solar eclipse central line', () => {
	test('returns no central line for a partial-only eclipse', () => {
		const line = generateCentralLine(partial2025)

		expect(line.hasCentralLine).toBeFalse()
		expect(line.points).toHaveLength(0)
		expect(line.segments).toHaveLength(0)
		expect(line.startTime).toBeUndefined()
		expect(line.endTime).toBeUndefined()
		expect(line.maxDurationPoint).toBeUndefined()
		expect(line.maxWidthPoint).toBeUndefined()
	})

	test('generates a normal total central line', () => {
		const line = generateCentralLine(total2024, { stepSeconds: 120 })

		expect(line.hasCentralLine).toBeTrue()
		expect(line.points.length).toBeGreaterThan(0)
		expect(line.isTotal).toBeTrue()
		expect(line.isAnnular).toBeFalse()
		expect(line.startTime).toBeDefined()
		expect(line.endTime).toBeDefined()
		expect(line.maxDurationPoint).toBeDefined()
		expect(line.maxWidthPoint).toBeDefined()
		expect(line.points.some((point) => point.eclipseType === 'total')).toBeTrue()
		expect(line.maxDurationPoint!.centralDurationSeconds).toBeGreaterThan(0)
		expect(line.maxWidthPoint!.pathWidthKm).toBeGreaterThan(0)
		expectFiniteLine(line)
	})

	test('generates a normal annular central line', () => {
		const line = generateCentralLine(annular2024, { stepSeconds: 120 })

		expect(line.hasCentralLine).toBeTrue()
		expect(line.isAnnular).toBeTrue()
		expect(line.isTotal).toBeFalse()
		expect(line.points.some((point) => point.eclipseType === 'annular')).toBeTrue()
		expect(line.points.some((point) => point.magnitude < 1)).toBeTrue()
		expectFiniteLine(line)
	})

	test('represents a hybrid central eclipse with total and annular sections', () => {
		const line = generateCentralLine(hybrid2023, { stepSeconds: 120 })

		expect(line.hasCentralLine).toBeTrue()
		expect(line.isTotal).toBeTrue()
		expect(line.isAnnular).toBeTrue()
		expect(line.isHybrid).toBeTrue()
		expect(line.points.some((point) => point.eclipseType === 'total')).toBeTrue()
		expect(line.points.some((point) => point.eclipseType === 'annular')).toBeTrue()
		expectFiniteLine(line)
	})

	test('splits render segments at the antimeridian', () => {
		const line = generateCentralLine(hybrid2023, { stepSeconds: 120, breakAtAntimeridian: true })

		expect(line.segments.length).toBeGreaterThan(1)
		expect(line.points.some((point, index) => index > 0 && Math.abs(point.lon - line.points[index - 1].lon) > Math.PI)).toBeTrue()

		for (const segment of line.segments) {
			for (let i = 1; i < segment.length; i++) {
				expect(Math.abs(segment[i].lon - segment[i - 1].lon)).toBeLessThan(Math.PI)
			}
		}
	})

	test('handles polar passages without longitude or latitude singularities', () => {
		const line = generateCentralLine(syntheticElements(), { stepSeconds: 120, useEllipsoid: false })

		expect(line.hasCentralLine).toBeTrue()
		expect(line.points.some((point) => Math.abs(point.lat) > deg(80))).toBeTrue()
		expectFiniteLine(line)
	})

	test('filters points below the configured solar altitude when requested', () => {
		const unfiltered = generateCentralLine(total2024, { stepSeconds: 300, solarAltitudeMin: 0.7, discardBelowHorizon: false })
		const filtered = generateCentralLine(total2024, { stepSeconds: 300, solarAltitudeMin: 0.7, discardBelowHorizon: true })

		expect(unfiltered.points.some((point) => point.solarAltitude < 0.7)).toBeTrue()
		expect(filtered.points.length).toBeLessThan(unfiltered.points.length)
		expect(filtered.points.every((point) => point.solarAltitude >= 0.7)).toBeTrue()
		expectFiniteLine(filtered)
	})

	test('supports ellipsoid and spherical Earth modes', () => {
		const ellipsoid = generateCentralLine(total2024, { stepSeconds: 600, useEllipsoid: true })
		const spherical = generateCentralLine(total2024, { stepSeconds: 600, useEllipsoid: false })
		const index = Math.floor(Math.min(ellipsoid.points.length, spherical.points.length) / 2)
		const latitudeDifference = Math.abs(ellipsoid.points[index].lat - spherical.points[index].lat)

		expect(ellipsoid.points.length).toBeGreaterThan(0)
		expect(spherical.points.length).toBeGreaterThan(0)
		expect(latitudeDifference).toBeGreaterThan(1e-5)
		expect(latitudeDifference).toBeLessThan(0.01)
		expectFiniteLine(ellipsoid)
		expectFiniteLine(spherical)
	})

	test('adaptive sampling reduces large geographic gaps', () => {
		const coarse = generateCentralLine(total2024, { stepSeconds: 900, adaptiveSampling: false })
		const adaptive = generateCentralLine(total2024, { stepSeconds: 900, adaptiveSampling: true, maxSegmentAngularDistance: 0.02 })

		expect(adaptive.points.length).toBeGreaterThan(coarse.points.length)
		expect(maxSegmentDistance(coarse)).toBeGreaterThan(0.02)
		expect(maxSegmentDistance(adaptive)).toBeLessThanOrEqual(0.021)
		expectFiniteLine(adaptive)
	})

	test('filters degenerate geometry without NaN or Infinity output', () => {
		const miss = generateCentralLine(syntheticElements({ x: [2, 0] }), { stepSeconds: 120 })
		const terminator = generateCentralLine(total2024, { stepSeconds: 120, discardBelowHorizon: false })

		expect(miss.hasCentralLine).toBeFalse()
		expect(miss.points).toHaveLength(0)
		expect(terminator.points.length).toBeGreaterThan(0)
		expectFiniteLine(terminator)
	})
})
