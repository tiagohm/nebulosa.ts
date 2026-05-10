import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { nearestSolarEclipse } from '../src/sun'
import { generateBesselianElements, type BesselianElements } from '../src/sun.eclipse.besselian'
import type { ContourPoint } from '../src/sun.eclipse.pcurves'
import { generateSolarEclipseMap, queryLocalCircumstances, validateSolarEclipseMap, type SolarEclipseGenerationOptions } from '../src/sun.eclipse.map'
import { timeYMD } from '../src/time'

const TOTAL_2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 3, 1), true).maximalTime })
const ANNULAR_2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 4, 9), true).maximalTime })
const PARTIAL_2025 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2025, 9, 21), true).maximalTime })
const HYBRID_2023 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2023, 1, 1), true).maximalTime })

const DALLAS = { latitude: deg(32.7767), longitude: deg(-96.797), elevation: 0 }
const GENERATION_OPTIONS = { precision: 'LOW', temporalStepSeconds: 300, spatialResolutionDeg: 30, magnitudeLevels: [0.5], obscurationLevels: [0.5], durationLevelsSeconds: [60], partialDurationLevelsSeconds: [3600], includeDiagnostics: true } as const satisfies SolarEclipseGenerationOptions

const TOTAL_MAP = generateSolarEclipseMap({ besselianElements: TOTAL_2024 }, GENERATION_OPTIONS)
const ANNULAR_MAP = generateSolarEclipseMap({ besselianElements: ANNULAR_2024 }, GENERATION_OPTIONS)
const PARTIAL_MAP = generateSolarEclipseMap({ besselianElements: PARTIAL_2025 }, GENERATION_OPTIONS)

function maxLongitudeJump(segments?: readonly (readonly ContourPoint[])[]) {
	let max = 0
	for (const segment of segments ?? []) for (let i = 1; i < segment.length; i++) max = Math.max(max, Math.abs(segment[i].longitude - segment[i - 1].longitude))
	return max
}

function minimalOptions(options: SolarEclipseGenerationOptions = {}): SolarEclipseGenerationOptions {
	return {
		precision: 'LOW',
		temporalStepSeconds: 300,
		spatialResolutionDeg: 30,
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

function publishedL2Elements(elements: BesselianElements): BesselianElements {
	const { l2SignConvention: _l2SignConvention, ...rest } = elements

	return {
		...rest,
		l2: { ...elements.l2, coefficients: elements.l2.coefficients.map((coefficient) => -coefficient) },
		samples: elements.samples?.map((sample) => ({ ...sample, l2: -sample.l2 })),
	}
}

describe('solar eclipse map generation', () => {
	test('generates a complete data package for a known total eclipse', () => {
		const map = TOTAL_MAP

		expect(map.metadata.eclipseType).toBe('total')
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
		const map = ANNULAR_MAP

		expect(map.metadata.eclipseType).toBe('annular')
		expect(map.centralLine?.isAnnular).toBeTrue()
		expect(map.centralLine?.hasCentralLine).toBeTrue()
		expect(map.northLimit.length).toBeGreaterThan(0)
		expect(map.southLimit.length).toBeGreaterThan(0)
		expect(map.curves.some((curve) => curve.type === 'annularDurationContour')).toBeTrue()
	})

	test('handles a partial-only eclipse without central path limits', () => {
		const map = PARTIAL_MAP

		expect(map.metadata.eclipseType).toBe('partial')
		expect(map.centralLine?.hasCentralLine).toBeFalse()
		expect(map.northLimit).toHaveLength(0)
		expect(map.southLimit).toHaveLength(0)
		expect(map.p1Curve?.points.length).toBeGreaterThan(0)
		expect(map.p4Curve?.points.length).toBeGreaterThan(0)
		expect(map.magnitudeContours[0].segments.length).toBeGreaterThan(0)
		expect(map.warnings.some((warning) => warning.includes('central path'))).toBeTrue()
	})

	test('supports skipping optional expensive datasets and still querying local circumstances', () => {
		const map = generateSolarEclipseMap({ besselianElements: TOTAL_2024 }, minimalOptions())
		const circumstances = queryLocalCircumstances(map, DALLAS)

		expect(map.centralLine).toBeUndefined()
		expect(map.p1Curve).toBeUndefined()
		expect(map.magnitudeContours).toHaveLength(0)
		expect(map.globalStats).toBeUndefined()
		expect(circumstances.type).toBe('total')
		expect(circumstances.maximumMagnitude).toBeGreaterThan(1)
	})

	test('accepts published Besselian elements with negative l2 for total eclipses', () => {
		const map = generateSolarEclipseMap({ besselianElements: publishedL2Elements(TOTAL_2024) }, minimalOptions())
		const circumstances = queryLocalCircumstances(map, DALLAS)

		expect(map.metadata.eclipseType).toBe('total')
		expect(circumstances.type).toBe('total')
		expect(circumstances.maximumMagnitude).toBeGreaterThan(1)
	})

	test('reports validation pass and fail cases with numerical deltas', () => {
		const map = TOTAL_MAP
		const local = queryLocalCircumstances(map, DALLAS)
		const passing = validateSolarEclipseMap(map, {
			eclipseType: 'total',
			geocentricMaximum: map.besselianElements.geocentricMaximum,
			maxMagnitude: map.globalStats!.largestMagnitude,
			localCircumstances: [{ id: 'dallas', location: DALLAS, type: 'total', maximumMagnitude: local.maximumMagnitude, maximumTime: local.MAX!.time }],
			tolerances: { timeSeconds: 1, magnitude: 1e-12 },
		})
		const failing = validateSolarEclipseMap(map, { eclipseType: 'partial' })

		expect(passing.passed).toBeTrue()
		expect(passing.checks.every((check) => check.delta !== undefined)).toBeTrue()
		expect(failing.passed).toBeFalse()
		expect(failing.checks[0].name).toBe('eclipse type')
	})

	test('warns when a requested contour level is unreachable', () => {
		const map = generateSolarEclipseMap({ besselianElements: PARTIAL_2025 }, minimalOptions({ includeIsoCurves: true, includeGlobalStats: true, magnitudeLevels: [2] }))

		expect(map.magnitudeContours).toHaveLength(1)
		expect(map.magnitudeContours[0].segments).toHaveLength(0)
		expect(map.warnings.some((warning) => warning.includes('outside the sampled reachable range'))).toBeTrue()
	})

	test('applies horizon filtering consistently to generated map contours', () => {
		const geometric = generateSolarEclipseMap({ besselianElements: TOTAL_2024 }, minimalOptions({ includeIsoCurves: true, includeGlobalStats: true, visibleOnly: false }))
		const visible = generateSolarEclipseMap({ besselianElements: TOTAL_2024 }, minimalOptions({ includeIsoCurves: true, includeGlobalStats: true, visibleOnly: true, includeSunBelowHorizon: false }))

		expect(visible.magnitudeContours[0].segments.flatMap((segment) => segment.points).length).toBeLessThan(geometric.magnitudeContours[0].segments.flatMap((segment) => segment.points).length)
		expect(visible.warnings.some((warning) => warning.includes('solar altitude filters'))).toBeTrue()
	})

	test('passes antimeridian splitting through to partial-contact curves', () => {
		const split = generateSolarEclipseMap({ besselianElements: HYBRID_2023 }, minimalOptions({ includePartialContactCurves: true, splitAtAntimeridian: true }))
		const unsplit = generateSolarEclipseMap({ besselianElements: HYBRID_2023 }, minimalOptions({ includePartialContactCurves: true, splitAtAntimeridian: false }))

		expect(maxLongitudeJump(split.p1Curve?.segments)).toBeLessThan(Math.PI)
		expect(maxLongitudeJump(split.p4Curve?.segments)).toBeLessThan(Math.PI)
		expect(Math.max(maxLongitudeJump(unsplit.p1Curve?.segments), maxLongitudeJump(unsplit.p4Curve?.segments))).toBeGreaterThan(Math.PI)
	})
})
