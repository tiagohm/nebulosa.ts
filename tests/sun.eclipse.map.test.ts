import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { nearestSolarEclipse } from '../src/sun'
import { generateBesselianElements } from '../src/sun.besselian'
import type { ContourPoint } from '../src/sun.eclipse.curves.partial'
import { generateSolarEclipseMap, queryLocalCircumstances, validateSolarEclipseMap, type SolarEclipseGenerationOptions, type SolarEclipseMap } from '../src/sun.eclipse.map'
import { timeYMD } from '../src/time'

const total2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 3, 1), true).maximalTime })
const annular2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 4, 9), true).maximalTime })
const partial2025 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2025, 9, 21), true).maximalTime })
const hybrid2023 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2023, 1, 1), true).maximalTime })

const dallas = { latitude: deg(32.7767), longitude: deg(-96.797) }

const completeOptions = {
	precisionProfile: 'LOW',
	temporalStepSeconds: 300,
	spatialResolutionDegrees: 30,
	magnitudeLevels: [0.5],
	obscurationLevels: [0.5],
	durationLevelsSeconds: [60],
	partialDurationLevelsSeconds: [3600],
	includeDiagnostics: true,
} as const satisfies SolarEclipseGenerationOptions

let totalMapCache: SolarEclipseMap | undefined
let annularMapCache: SolarEclipseMap | undefined
let partialMapCache: SolarEclipseMap | undefined

function totalMap() {
	return (totalMapCache ??= generateSolarEclipseMap({ eclipseId: '2024-total', besselianElements: total2024 }, completeOptions))
}

function annularMap() {
	return (annularMapCache ??= generateSolarEclipseMap({ eclipseId: '2024-annular', besselianElements: annular2024 }, completeOptions))
}

function partialMap() {
	return (partialMapCache ??= generateSolarEclipseMap({ eclipseId: '2025-partial', besselianElements: partial2025 }, completeOptions))
}

function maxLongitudeJump(segments?: readonly (readonly ContourPoint[])[]) {
	let max = 0

	for (const segment of segments ?? []) {
		for (let i = 1; i < segment.length; i++) max = Math.max(max, Math.abs(segment[i].lon - segment[i - 1].lon))
	}

	return max
}

function minimalOptions(options: SolarEclipseGenerationOptions = {}): SolarEclipseGenerationOptions {
	return {
		precisionProfile: 'LOW',
		temporalStepSeconds: 300,
		spatialResolutionDegrees: 30,
		magnitudeLevels: [0.5],
		obscurationLevels: [],
		durationLevelsSeconds: [],
		partialDurationLevelsSeconds: [],
		includeCentralPath: false,
		includePartialContactCurves: false,
		includePenumbraContours: false,
		includeIsoCurves: false,
		includeGlobalStats: false,
		includeDiagnostics: true,
		...options,
	}
}

describe('solar eclipse map generation', () => {
	test('generates a complete data package for a known total eclipse', () => {
		const map = totalMap()

		expect(map.metadata.eclipseId).toBe('2024-total')
		expect(map.metadata.eclipseType).toBe('TOTAL')
		expect(map.centralLine?.hasCentralLine).toBeTrue()
		expect(map.northLimit.length).toBeGreaterThan(0)
		expect(map.southLimit.length).toBeGreaterThan(0)
		expect(map.centralPathPolygon?.points.length).toBeGreaterThan(0)
		expect(map.p1Curve?.points.length).toBeGreaterThan(0)
		expect(map.p4Curve?.points.length).toBeGreaterThan(0)
		expect(map.penumbraContours.length).toBeGreaterThan(0)
		expect(map.magnitudeContours[0].segments.length).toBeGreaterThan(0)
		expect(map.obscurationContours[0].segments.length).toBeGreaterThan(0)
		expect(map.durationContours.length).toBeGreaterThan(0)
		expect(map.globalStats?.largestMagnitude).toBeGreaterThan(1)
		expect(map.globalStats?.maximumCentralPathWidthKm).toBeGreaterThan(0)
		expect(map.curves.some((curve) => curve.type === 'centralLine')).toBeTrue()
		expect(map.curves.some((curve) => curve.type === 'partialContact' && curve.subtype === 'P1')).toBeTrue()
		expect(map.generationDiagnostics?.localGridSampleCount).toBe(84)
	})

	test('generates central annular geometry for a known annular eclipse', () => {
		const map = annularMap()

		expect(map.metadata.eclipseType).toBe('ANNULAR')
		expect(map.centralLine?.isAnnular).toBeTrue()
		expect(map.centralLine?.hasCentralLine).toBeTrue()
		expect(map.northLimit.length).toBeGreaterThan(0)
		expect(map.southLimit.length).toBeGreaterThan(0)
		expect(map.curves.some((curve) => curve.type === 'annularDurationContour')).toBeTrue()
	})

	test('handles a partial-only eclipse without central path limits', () => {
		const map = partialMap()

		expect(map.metadata.eclipseType).toBe('PARTIAL')
		expect(map.centralLine?.hasCentralLine).toBeFalse()
		expect(map.northLimit).toHaveLength(0)
		expect(map.southLimit).toHaveLength(0)
		expect(map.p1Curve?.points.length).toBeGreaterThan(0)
		expect(map.p4Curve?.points.length).toBeGreaterThan(0)
		expect(map.magnitudeContours[0].segments.length).toBeGreaterThan(0)
		expect(map.warnings.some((warning) => warning.includes('central path'))).toBeTrue()
	})

	test('supports skipping optional expensive datasets and still querying local circumstances', () => {
		const map = generateSolarEclipseMap({ besselianElements: total2024 }, minimalOptions())
		const circumstances = queryLocalCircumstances(map, dallas)

		expect(map.centralLine).toBeUndefined()
		expect(map.p1Curve).toBeUndefined()
		expect(map.magnitudeContours).toHaveLength(0)
		expect(map.globalStats).toBeUndefined()
		expect(circumstances.type).toBe('TOTAL')
		expect(circumstances.maximumMagnitude).toBeGreaterThan(1)
	})

	test('keeps deterministic ids, cache keys, and generation timestamps for identical inputs', () => {
		const options = minimalOptions({ magnitudeLevels: [0.5] })
		const first = generateSolarEclipseMap({ eclipseId: 'deterministic', besselianElements: total2024 }, options)
		const second = generateSolarEclipseMap({ eclipseId: 'deterministic', besselianElements: total2024 }, options)
		const changed = generateSolarEclipseMap({ eclipseId: 'deterministic', besselianElements: total2024 }, minimalOptions({ magnitudeLevels: [0.7] }))

		expect(second.metadata.mapId).toBe(first.metadata.mapId)
		expect(second.metadata.cacheKey).toBe(first.metadata.cacheKey)
		expect(second.metadata.generationTime).toBe(first.metadata.generationTime)
		expect(changed.metadata.cacheKey).not.toBe(first.metadata.cacheKey)
	})

	test('reports validation pass and fail cases with numerical deltas', () => {
		const map = totalMap()
		const local = queryLocalCircumstances(map, dallas)
		const passing = validateSolarEclipseMap(map, {
			eclipseType: 'TOTAL',
			geocentricMaximum: map.besselianElements.geocentricMaximum,
			maxMagnitude: map.globalStats!.largestMagnitude,
			localCircumstances: [
				{
					id: 'dallas',
					location: dallas,
					type: 'TOTAL',
					maximumMagnitude: local.maximumMagnitude,
					maximumTime: local.maximum!.time,
				},
			],
			tolerances: { timeSeconds: 1, magnitude: 1e-12 },
		})
		const failing = validateSolarEclipseMap(map, { eclipseType: 'PARTIAL' })

		expect(passing.passed).toBeTrue()
		expect(passing.checks.every((check) => check.delta !== undefined)).toBeTrue()
		expect(failing.passed).toBeFalse()
		expect(failing.checks[0].name).toBe('eclipse type')
	})

	test('warns when a requested contour level is unreachable', () => {
		const map = generateSolarEclipseMap(
			{ besselianElements: partial2025 },
			minimalOptions({
				includeIsoCurves: true,
				includeGlobalStats: true,
				magnitudeLevels: [2],
			}),
		)

		expect(map.magnitudeContours).toHaveLength(1)
		expect(map.magnitudeContours[0].segments).toHaveLength(0)
		expect(map.warnings.some((warning) => warning.includes('outside the sampled reachable range'))).toBeTrue()
	})

	test('applies horizon filtering consistently to generated map contours', () => {
		const geometric = generateSolarEclipseMap(
			{ besselianElements: total2024 },
			minimalOptions({
				includeIsoCurves: true,
				includeGlobalStats: true,
				visibleOnly: false,
			}),
		)
		const visible = generateSolarEclipseMap(
			{ besselianElements: total2024 },
			minimalOptions({
				includeIsoCurves: true,
				includeGlobalStats: true,
				visibleOnly: true,
				includeSunBelowHorizon: false,
			}),
		)

		expect(visible.magnitudeContours[0].segments.flatMap((segment) => segment.points).length).toBeLessThan(geometric.magnitudeContours[0].segments.flatMap((segment) => segment.points).length)
		expect(visible.warnings.some((warning) => warning.includes('solar altitude filters'))).toBeTrue()
	})

	test('passes antimeridian splitting through to partial-contact curves', () => {
		const split = generateSolarEclipseMap(
			{ besselianElements: hybrid2023 },
			minimalOptions({
				includePartialContactCurves: true,
				splitAtAntimeridian: true,
			}),
		)
		const unsplit = generateSolarEclipseMap(
			{ besselianElements: hybrid2023 },
			minimalOptions({
				includePartialContactCurves: true,
				splitAtAntimeridian: false,
			}),
		)

		expect(maxLongitudeJump(split.p1Curve?.segments)).toBeLessThan(Math.PI)
		expect(maxLongitudeJump(split.p4Curve?.segments)).toBeLessThan(Math.PI)
		expect(Math.max(maxLongitudeJump(unsplit.p1Curve?.segments), maxLongitudeJump(unsplit.p4Curve?.segments))).toBeGreaterThan(Math.PI)
	})
})
