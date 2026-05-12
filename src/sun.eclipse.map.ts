import type { Angle } from './angle'
import { AU_KM, DAYSEC, DEG2RAD } from './constants'
import { angularDistance } from './coordinate'
import type { GeographicCoordinate } from './location'
import { nearestSolarEclipse, type SolarEclipse, type SolarEclipseType } from './sun'
import { generateBesselianElements, type BesselianElements, type SolarEclipseBesselianContext } from './sun.eclipse.besselian'
import { computeLocalCircumstances, type EclipseContact, type LocalEclipseCircumstances, type LocalEclipseContactType, type LocalEclipseOptions } from './sun.eclipse.circumstances'
import { buildEclipseLocalGrid, generateEclipseIsoCurvesFromGrid, type EclipseContourLevel, type EclipseGridSample, type EclipseIsoCurve, type EclipseIsoCurveSegment, type EclipseIsoCurveType, type GeoPoint } from './sun.eclipse.isocurves'
import { generatePathLimits, type EclipsePathLimitPoint, type EclipsePathLimitsResult, type EclipsePathPolygon } from './sun.eclipse.limits'
import type { CentralLinePoint, CentralLineResult } from './sun.eclipse.lines'
import { generateGlobalPartialContactCurves, generatePenumbraContourAt, type ContourPoint, type GlobalContactCurve, type GlobalEclipseContour } from './sun.eclipse.pcurves'
import { type Time, Timescale, timeShift, timeSubtract } from './time'
import { validateFinite, validateInRange, validateNonNegativeInteger, validatePositiveFinite, validateTime } from './validation'

// High-level solar-eclipse map data aggregator.
//
// This module is intentionally rendering-agnostic. It coordinates Besselian
// element generation, central-path geometry, partial-contact curves,
// instantaneous penumbra contours, sampled local grids, iso-curves, local
// query helpers, and reference validation into one deterministic data package.

const DEFAULT_PRECISION_PROFILE: SolarEclipsePrecisionProfile = 'LOW'
const DEFAULT_MAGNITUDE_LEVELS = [0.2, 0.4, 0.6, 0.8] as const
const DEFAULT_OBSCURATION_LEVELS = [0.2, 0.4, 0.6, 0.8] as const
const DEFAULT_DURATION_LEVELS_SECONDS = [60, 120, 180] as const
const DEFAULT_PARTIAL_DURATION_LEVELS_SECONDS = [1800, 3600, 5400] as const
const DEFAULT_CONTOUR_TOLERANCE = 1e-6
const DEFAULT_ROOT_FINDING_TOLERANCE_SECONDS = 1
const DEFAULT_MAX_ITERATIONS = 14
const DEFAULT_MINIMUM_SOLAR_ALTITUDE = 0
const DEFAULT_TIME_TOLERANCE_SECONDS = 30
const DEFAULT_POSITION_TOLERANCE_KM = 25
const DEFAULT_DURATION_TOLERANCE_SECONDS = 30
const DEFAULT_PATH_WIDTH_TOLERANCE_KM = 25
const DEFAULT_MAGNITUDE_TOLERANCE = 0.02
const MAX_PENUMBRA_CONTOUR_TIMES = 1000

const PRECISION_DEFAULTS = {
	LOW: { temporalStepSeconds: 300, spatialResolutionDeg: 30 },
	MEDIUM: { temporalStepSeconds: 120, spatialResolutionDeg: 15 },
	HIGH: { temporalStepSeconds: 30, spatialResolutionDeg: 5 },
} as const satisfies Record<SolarEclipsePrecisionProfile, { readonly temporalStepSeconds: number; readonly spatialResolutionDeg: number }>

export type SolarEclipsePrecisionProfile = 'LOW' | 'MEDIUM' | 'HIGH'

export type SolarEclipseDataSourceType = 'precomputedBesselianElements' | 'computedBesselianElements'

export type SolarEclipseCurveType = 'centralLine' | 'northLimit' | 'southLimit' | 'centralPathPolygon' | 'partialContact' | 'penumbraInstantContour' | 'magnitudeContour' | 'obscurationContour' | 'totalDurationContour' | 'annularDurationContour' | 'partialDurationContour'

export type SolarEclipseCurveSubtype = 'centralLine' | 'northLimit' | 'southLimit' | 'centralPathPolygon' | 'P1' | 'P4' | EclipseIsoCurveType | 'penumbra'

export interface SolarEclipseMapInput {
	readonly approximateTime?: Time
	readonly maximumApprox?: Time
	readonly besselianElements?: BesselianElements
	readonly besselianOptions?: Omit<SolarEclipseBesselianContext, 'maximumApprox'>
}

export interface SolarEclipseGenerationOptions {
	readonly precision?: SolarEclipsePrecisionProfile
	readonly temporalStepSeconds?: number
	readonly spatialResolutionDeg?: number
	readonly magnitudeLevels?: readonly number[]
	readonly obscurationLevels?: readonly number[]
	readonly durationLevelsSeconds?: readonly number[]
	readonly partialDurationLevelsSeconds?: readonly number[]
	readonly includePenumbraContours?: boolean
	readonly penumbraContourTimes?: readonly Time[]
	readonly penumbraContourStepSeconds?: number
	readonly includeIsoCurves?: boolean
	readonly includeCentralPath?: boolean
	readonly includePartialContactCurves?: boolean
	readonly includeGlobalStats?: boolean
	readonly includeDiagnostics?: boolean
	readonly visibleOnly?: boolean
	readonly includeSunBelowHorizon?: boolean
	readonly minimumSolarAltitude?: Angle
	readonly useEllipsoid?: boolean
	readonly contourTolerance?: number
	readonly rootFindingTolerance?: number
	readonly maxIterations?: number
	readonly splitAtAntimeridian?: boolean
	readonly allowPartialGeneration?: boolean
}

export interface NormalizedSolarEclipseGenerationOptions {
	readonly precision: SolarEclipsePrecisionProfile
	readonly temporalStepSeconds: number
	readonly spatialResolutionDeg: number
	readonly magnitudeLevels: readonly number[]
	readonly obscurationLevels: readonly number[]
	readonly durationLevelsSeconds: readonly number[]
	readonly partialDurationLevelsSeconds: readonly number[]
	readonly includePenumbraContours: boolean
	readonly penumbraContourTimes?: readonly Time[]
	readonly penumbraContourStepSeconds?: number
	readonly includeIsoCurves: boolean
	readonly includeCentralPath: boolean
	readonly includePartialContactCurves: boolean
	readonly includeGlobalStats: boolean
	readonly includeDiagnostics: boolean
	readonly visibleOnly: boolean
	readonly includeSunBelowHorizon: boolean
	readonly minimumSolarAltitude: Angle
	readonly useEllipsoid: boolean
	readonly contourTolerance: number
	readonly rootFindingTolerance: number
	readonly maxIterations: number
	readonly splitAtAntimeridian: boolean
	readonly allowPartialGeneration: boolean
}

export interface SolarEclipseTimeRange {
	readonly start: Time
	readonly end: Time
}

export interface SolarEclipseMapSource {
	readonly type: SolarEclipseDataSourceType
	readonly approximateTime?: Time
	readonly resolvedMaximum?: Time
	readonly resolvedApproximation?: SolarEclipse
}

export interface SolarEclipseGeographicExtent {
	readonly minLatitude: Angle
	readonly maxLatitude: Angle
	readonly minLongitude: Angle
	readonly maxLongitude: Angle
}

export interface SolarEclipseGlobalMaximum {
	readonly latitude: Angle
	readonly longitude: Angle
	readonly time?: Time
	readonly magnitude: number
	readonly obscuration: number
	readonly eclipseType: SolarEclipseType | 'none'
	readonly solarAltitude?: Angle
}

export interface SolarEclipseMapMetadata {
	readonly date: Time
	readonly eclipseType: SolarEclipseType | 'unknown'
	readonly geocentricMaximum: Time
	readonly approximateGlobalMaximum?: SolarEclipseGlobalMaximum
	readonly deltaT: number
	readonly validTimeRange: SolarEclipseTimeRange
	readonly precision: SolarEclipsePrecisionProfile
	readonly useEllipsoid: boolean
	readonly source: SolarEclipseMapSource
}

export interface SolarEclipseCurvePoint {
	readonly latitude: Angle
	readonly longitude: Angle
	readonly time?: Time
	readonly solarAltitude?: Angle
	readonly visible?: boolean
	readonly value?: number
	readonly metadata?: Record<string, unknown>
}

export interface SolarEclipseCurveSegment {
	readonly points: readonly SolarEclipseCurvePoint[]
	readonly closed?: boolean
}

export interface SolarEclipseCurve {
	readonly type: SolarEclipseCurveType
	readonly subtype: SolarEclipseCurveSubtype
	readonly level?: number
	readonly unit?: 'fraction' | 'seconds'
	readonly points: readonly SolarEclipseCurvePoint[]
	readonly segments: readonly SolarEclipseCurveSegment[]
	readonly timeRange?: SolarEclipseTimeRange
	readonly visibleOnly?: boolean
	readonly includesBelowHorizon?: boolean
	readonly metadata?: Record<string, unknown>
	readonly warnings?: readonly string[]
}

export interface SolarEclipseGlobalStats {
	readonly sampleCount: number
	readonly eclipseSampleCount: number
	readonly visibleSampleCount: number
	readonly largestMagnitude: number
	readonly largestObscuration: number
	readonly longestTotalOrAnnularDurationSeconds?: number
	readonly longestPartialDurationSeconds?: number
	readonly maximumCentralPathWidthKm?: number
	readonly approximateGlobalMaximum?: SolarEclipseGlobalMaximum
	readonly geometricExtent?: SolarEclipseGeographicExtent
	readonly visibleExtent?: SolarEclipseGeographicExtent
}

export interface SolarEclipseGenerationDiagnostics {
	readonly sourceType: SolarEclipseDataSourceType
	readonly datasetStatus: Readonly<Record<string, string>>
	readonly centralLinePointCount: number
	readonly northLimitPointCount: number
	readonly southLimitPointCount: number
	readonly partialContactPointCount: number
	readonly penumbraContourCount: number
	readonly isoCurveCount: number
	readonly localGridSampleCount: number
	readonly curveCount: number
}

export interface SolarEclipseMap {
	readonly metadata: SolarEclipseMapMetadata
	readonly options: NormalizedSolarEclipseGenerationOptions
	readonly besselianElements: BesselianElements
	readonly centralLine?: CentralLineResult
	readonly northLimit: readonly EclipsePathLimitPoint[]
	readonly southLimit: readonly EclipsePathLimitPoint[]
	readonly centralPathPolygon?: EclipsePathPolygon
	readonly centralPathPolygons: readonly EclipsePathPolygon[]
	readonly p1Curve?: GlobalContactCurve
	readonly p4Curve?: GlobalContactCurve
	readonly penumbraContours: readonly GlobalEclipseContour[]
	readonly magnitudeContours: readonly EclipseIsoCurve[]
	readonly obscurationContours: readonly EclipseIsoCurve[]
	readonly durationContours: readonly EclipseIsoCurve[]
	readonly curves: readonly SolarEclipseCurve[]
	readonly globalStats?: SolarEclipseGlobalStats
	readonly warnings: readonly string[]
	readonly generationDiagnostics?: SolarEclipseGenerationDiagnostics
}

export interface SolarEclipseLocalQueryOptions extends LocalEclipseOptions {
	readonly returnWrapper?: false
}

export interface SolarEclipseValidationTolerances {
	readonly timeSeconds?: number
	readonly positionKm?: number
	readonly durationSeconds?: number
	readonly pathWidthKm?: number
	readonly magnitude?: number
}

export interface SolarEclipseValidationLocationReference {
	readonly id?: string
	readonly location: GeographicCoordinate
	readonly type?: SolarEclipseType | 'NONE'
	readonly maximumTime?: Time
	readonly maximumMagnitude?: number
	readonly maximumObscuration?: number
	readonly partialDurationSeconds?: number
	readonly totalOrAnnularDurationSeconds?: number
	readonly contacts?: Partial<Readonly<Record<LocalEclipseContactType, Time>>>
}

export interface SolarEclipseCentralLineReference {
	readonly id?: string
	readonly time?: Time
	readonly latitude: Angle
	readonly longitude: Angle
}

export interface SolarEclipseMapValidationReferences {
	readonly tolerances?: SolarEclipseValidationTolerances
	readonly eclipseType?: SolarEclipseType | 'unknown'
	readonly geocentricMaximum?: Time
	readonly greatestEclipseLocation?: {
		readonly latitude: Angle
		readonly longitude: Angle
	}
	readonly maxMagnitude?: number
	readonly maxObscuration?: number
	readonly maxPathWidthKm?: number
	readonly maxDurationSeconds?: number
	readonly localCircumstances?: readonly SolarEclipseValidationLocationReference[]
	readonly centralLinePoints?: readonly SolarEclipseCentralLineReference[]
}

export interface ResolvedSolarEclipseValidationTolerances {
	readonly timeSeconds: number
	readonly positionKm: number
	readonly durationSeconds: number
	readonly pathWidthKm: number
	readonly magnitude: number
}

export interface ValidationCheckResult {
	readonly name: string
	readonly passed: boolean
	readonly expected?: unknown
	readonly measured?: unknown
	readonly delta?: number
	readonly tolerance?: number
	readonly unit?: string
	readonly message?: string
}

export interface ValidationReport {
	readonly passed: boolean
	readonly checks: readonly ValidationCheckResult[]
	readonly tolerances: ResolvedSolarEclipseValidationTolerances
	readonly warnings: readonly string[]
	readonly recommendations: readonly string[]
}

interface ResolvedSolarEclipseInput {
	readonly elements: BesselianElements
	readonly source: SolarEclipseMapSource
}

interface MutableGenerationContext {
	readonly options: NormalizedSolarEclipseGenerationOptions
	readonly warnings: string[]
	readonly datasetStatus: Partial<Record<'centralPath' | 'partialContactCurves' | 'penumbraContours' | 'localGrid' | 'isoCurves', 'generated' | 'failed' | 'skipped'>>
}

// Generates a complete deterministic data package for solar-eclipse map consumers.
export function generateSolarEclipseMap(input: SolarEclipseMapInput, options?: SolarEclipseGenerationOptions): SolarEclipseMap {
	const normalized = normalizeGenerationOptions(options)
	const { elements, source } = resolveInput(input)
	const warnings: string[] = []
	const datasetStatus: MutableGenerationContext['datasetStatus'] = {}
	const context: MutableGenerationContext = { options: normalized, warnings, datasetStatus }
	let pathLimits: EclipsePathLimitsResult | undefined
	let centralLine: CentralLineResult | undefined
	let p1Curve: GlobalContactCurve | undefined
	let p4Curve: GlobalContactCurve | undefined
	let localGrid: readonly EclipseGridSample[] = []
	let penumbraContours: readonly GlobalEclipseContour[] = []
	let isoCurves: readonly EclipseIsoCurve[] = []

	if (normalized.includeCentralPath) {
		pathLimits = generateOptional(context, 'centralPath', () =>
			generatePathLimits(elements, {
				stepSeconds: normalized.temporalStepSeconds,
				useEllipsoid: normalized.useEllipsoid,
				discardBelowHorizon: normalized.visibleOnly && !normalized.includeSunBelowHorizon,
				solarAltitudeMin: normalized.minimumSolarAltitude,
				timeToleranceSeconds: normalized.rootFindingTolerance,
				spatialToleranceKm: normalized.contourTolerance * earthRadiusKm(elements),
				numericTolerance: normalized.contourTolerance,
				maxSegmentAngularDistance: normalized.spatialResolutionDeg * DEG2RAD,
				adaptiveSampling: normalized.precision !== 'LOW',
				splitAntimeridian: normalized.splitAtAntimeridian,
				maxAdaptiveDepth: normalized.maxIterations,
			}),
		)
		centralLine = pathLimits?.centerLine
		if (pathLimits) warnings.push(...pathLimits.warnings)
		if (centralLine?.warnings) warnings.push(...centralLine.warnings)
		if (!centralLine?.hasCentralLine) warnings.push('central path is not present for this eclipse or option set')
		if (pathLimits && centralLine?.hasCentralLine && (pathLimits.northLimit.length === 0 || pathLimits.southLimit.length === 0)) warnings.push('central path limits collapsed or could not be solved')
	} else {
		datasetStatus.centralPath = 'skipped'
	}

	if (normalized.includePartialContactCurves) {
		const contactCurves = generateOptional(context, 'partialContactCurves', () =>
			generateGlobalPartialContactCurves(elements, {
				startTime: elements.validFrom,
				endTime: elements.validTo,
				gridResolutionDeg: normalized.spatialResolutionDeg,
				contourTolerance: normalized.contourTolerance,
				temporalTolerance: Math.max(normalized.rootFindingTolerance, normalized.temporalStepSeconds),
				spatialTolerance: normalized.contourTolerance,
				useEllipsoid: normalized.useEllipsoid,
				considerSolarHorizon: !normalized.includeSunBelowHorizon,
				minimumSolarAltitude: normalized.minimumSolarAltitude,
				splitAtAntimeridian: normalized.splitAtAntimeridian,
				visibleOnly: normalized.visibleOnly,
				maxRefinementIterations: normalized.maxIterations,
				includeDiagnostics: normalized.includeDiagnostics,
			}),
		)

		p1Curve = contactCurves?.find((curve) => curve.type === 'P1')
		p4Curve = contactCurves?.find((curve) => curve.type === 'P4')
		if (!p1Curve || !p4Curve) warnings.push('partial-contact curve generation did not return both P1 and P4')
		appendContactDiagnosticsWarnings(warnings, p1Curve)
		appendContactDiagnosticsWarnings(warnings, p4Curve)
	} else {
		datasetStatus.partialContactCurves = 'skipped'
	}

	if (normalized.includePenumbraContours) {
		const contourTimes = resolvePenumbraContourTimes(elements, normalized)
		const contours = generateOptional(context, 'penumbraContours', () => {
			const generated: GlobalEclipseContour[] = []

			for (const time of contourTimes) {
				generated.push(
					...generatePenumbraContourAt(elements, time, {
						angularSamplingDeg: normalized.spatialResolutionDeg,
						contourTolerance: normalized.contourTolerance,
						useEllipsoid: normalized.useEllipsoid,
						considerSolarHorizon: !normalized.includeSunBelowHorizon,
						minimumSolarAltitude: normalized.minimumSolarAltitude,
						splitAtAntimeridian: normalized.splitAtAntimeridian,
						visibleOnly: normalized.visibleOnly,
						maxRefinementIterations: normalized.maxIterations,
						includeDiagnostics: normalized.includeDiagnostics,
					}),
				)
			}

			return generated
		})

		penumbraContours = contours ?? []
		if (contourTimes.length > 0 && penumbraContours.length === 0) warnings.push('requested penumbra contours produced no geometry')
		for (const contour of penumbraContours) appendContactDiagnosticsWarnings(warnings, contour)
	} else {
		datasetStatus.penumbraContours = 'skipped'
	}

	const contourLevels = buildContourLevels(normalized, elements)
	if (normalized.includeIsoCurves || normalized.includeGlobalStats) {
		const grid = generateOptional(context, 'localGrid', () => buildEclipseLocalGrid(elements, localGridOptions(normalized)))
		localGrid = grid ?? []
	}

	if (normalized.includeIsoCurves) {
		isoCurves = generateOptional(context, 'isoCurves', () => generateEclipseIsoCurvesFromGrid(localGrid, contourLevels, isoCurveOptions(normalized))) ?? []
		appendIsoWarnings(warnings, isoCurves)
	} else {
		datasetStatus.isoCurves = 'skipped'
	}

	const magnitudeContours = isoCurves.filter((curve) => curve.type === 'magnitude')
	const obscurationContours = isoCurves.filter((curve) => curve.type === 'obscuration')
	const durationContours = isoCurves.filter((curve) => curve.type === 'totalOrAnnularDuration' || curve.type === 'partialDuration')
	const centralPathPolygons = pathLimits?.polygons ?? []
	const centralPathPolygon = largestPolygon(centralPathPolygons)
	const globalStats = normalized.includeGlobalStats ? computeGlobalStats(elements, localGrid, pathLimits) : undefined
	const approximateGlobalMaximum = globalStats?.approximateGlobalMaximum ?? approximateMaximumFromCentralLine(centralLine)
	const curves = buildMapCurves(elements, normalized, centralLine, pathLimits, centralPathPolygon, p1Curve, p4Curve, penumbraContours, magnitudeContours, obscurationContours, durationContours)

	appendGlobalWarnings(warnings, normalized, globalStats, centralLine, pathLimits)

	const metadata: SolarEclipseMapMetadata = {
		date: elements.geocentricMaximum,
		eclipseType: determineEclipseType(elements, centralLine),
		geocentricMaximum: elements.geocentricMaximum,
		approximateGlobalMaximum,
		deltaT: elements.deltaTSeconds,
		validTimeRange: { start: elements.validFrom, end: elements.validTo },
		precision: normalized.precision,
		useEllipsoid: normalized.useEllipsoid,
		source,
	}

	return {
		metadata,
		options: normalized,
		besselianElements: elements,
		centralLine,
		northLimit: pathLimits?.northLimit ?? [],
		southLimit: pathLimits?.southLimit ?? [],
		centralPathPolygon,
		centralPathPolygons,
		p1Curve,
		p4Curve,
		penumbraContours,
		magnitudeContours,
		obscurationContours,
		durationContours,
		curves,
		globalStats,
		warnings,
		generationDiagnostics: normalized.includeDiagnostics
			? {
					sourceType: source.type,
					datasetStatus,
					centralLinePointCount: centralLine?.points.length ?? 0,
					northLimitPointCount: pathLimits?.northLimit.length ?? 0,
					southLimitPointCount: pathLimits?.southLimit.length ?? 0,
					partialContactPointCount: (p1Curve?.points.length ?? 0) + (p4Curve?.points.length ?? 0),
					penumbraContourCount: penumbraContours.length,
					isoCurveCount: isoCurves.length,
					localGridSampleCount: localGrid.length,
					curveCount: curves.length,
				}
			: undefined,
	}
}

// Queries local circumstances from the map's existing Besselian elements.
export function queryLocalCircumstances(map: SolarEclipseMap, location: GeographicCoordinate, options?: SolarEclipseLocalQueryOptions): LocalEclipseCircumstances {
	return computeLocalCircumstances(map.besselianElements, location, {
		useEarthEllipsoid: options?.useEarthEllipsoid ?? map.metadata.useEllipsoid,
		includeRefraction: options?.includeRefraction,
		solarHorizonMinAltitude: options?.solarHorizonMinAltitude ?? map.options.minimumSolarAltitude,
		timeToleranceSeconds: options?.timeToleranceSeconds ?? map.options.rootFindingTolerance,
		scanStepSeconds: options?.scanStepSeconds ?? Math.min(map.options.temporalStepSeconds, 60),
		longitudeConvention: options?.longitudeConvention,
	})
}

// Validates a generated map against reference eclipse data.
export function validateSolarEclipseMap(map: SolarEclipseMap, references: SolarEclipseMapValidationReferences): ValidationReport {
	const tolerances = normalizeValidationTolerances(references.tolerances)
	const checks: ValidationCheckResult[] = []
	const warnings: string[] = [...map.warnings]

	if (references.eclipseType !== undefined) {
		addExactCheck(checks, 'eclipse type', references.eclipseType, map.metadata.eclipseType)
	}

	if (references.geocentricMaximum) {
		addNumericCheck(checks, 'geocentric maximum time', Math.abs(timeDeltaSeconds(map.metadata.geocentricMaximum, references.geocentricMaximum)), tolerances.timeSeconds, 'seconds', references.geocentricMaximum, map.metadata.geocentricMaximum)
	}

	if (references.greatestEclipseLocation) {
		if (map.metadata.approximateGlobalMaximum) {
			const deltaKm = distanceKm(map.besselianElements, map.metadata.approximateGlobalMaximum.latitude, map.metadata.approximateGlobalMaximum.longitude, references.greatestEclipseLocation.latitude, references.greatestEclipseLocation.longitude)
			addNumericCheck(checks, 'greatest eclipse location', deltaKm, tolerances.positionKm, 'km', references.greatestEclipseLocation, {
				latitude: map.metadata.approximateGlobalMaximum.latitude,
				longitude: map.metadata.approximateGlobalMaximum.longitude,
			})
		} else {
			addMissingCheck(checks, 'greatest eclipse location', references.greatestEclipseLocation)
		}
	}

	if (references.maxMagnitude !== undefined) {
		addNumericCheck(checks, 'maximum magnitude', Math.abs((map.globalStats?.largestMagnitude ?? 0) - references.maxMagnitude), tolerances.magnitude, 'magnitude', references.maxMagnitude, map.globalStats?.largestMagnitude)
	}

	if (references.maxObscuration !== undefined) {
		addNumericCheck(checks, 'maximum obscuration', Math.abs((map.globalStats?.largestObscuration ?? 0) - references.maxObscuration), tolerances.magnitude, 'fraction', references.maxObscuration, map.globalStats?.largestObscuration)
	}

	if (references.maxPathWidthKm !== undefined) {
		addNumericCheck(checks, 'maximum central path width', Math.abs((map.globalStats?.maximumCentralPathWidthKm ?? 0) - references.maxPathWidthKm), tolerances.pathWidthKm, 'km', references.maxPathWidthKm, map.globalStats?.maximumCentralPathWidthKm)
	}

	if (references.maxDurationSeconds !== undefined) {
		addNumericCheck(checks, 'maximum total or annular duration', Math.abs((map.globalStats?.longestTotalOrAnnularDurationSeconds ?? 0) - references.maxDurationSeconds), tolerances.durationSeconds, 'seconds', references.maxDurationSeconds, map.globalStats?.longestTotalOrAnnularDurationSeconds)
	}

	for (const localReference of references.localCircumstances ?? []) {
		validateLocalReference(map, localReference, tolerances, checks)
	}

	for (const centralReference of references.centralLinePoints ?? []) {
		validateCentralLineReference(map, centralReference, tolerances, checks)
	}

	const recommendations = buildValidationRecommendations(map, checks)

	return { passed: checks.every((check) => check.passed), checks, tolerances, warnings, recommendations }
}

function normalizeGenerationOptions(options: SolarEclipseGenerationOptions = {}): NormalizedSolarEclipseGenerationOptions {
	const precision = options.precision ?? DEFAULT_PRECISION_PROFILE
	const profile = PRECISION_DEFAULTS[precision]
	const temporalStepSeconds = options.temporalStepSeconds ?? profile.temporalStepSeconds
	const spatialResolutionDeg = options.spatialResolutionDeg ?? profile.spatialResolutionDeg
	const magnitudeLevels = options.magnitudeLevels ?? DEFAULT_MAGNITUDE_LEVELS
	const obscurationLevels = options.obscurationLevels ?? DEFAULT_OBSCURATION_LEVELS
	const durationLevelsSeconds = options.durationLevelsSeconds ?? DEFAULT_DURATION_LEVELS_SECONDS
	const partialDurationLevelsSeconds = options.partialDurationLevelsSeconds ?? DEFAULT_PARTIAL_DURATION_LEVELS_SECONDS
	const contourTolerance = options.contourTolerance ?? DEFAULT_CONTOUR_TOLERANCE
	const rootFindingTolerance = options.rootFindingTolerance ?? DEFAULT_ROOT_FINDING_TOLERANCE_SECONDS
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
	const minimumSolarAltitude = options.minimumSolarAltitude ?? DEFAULT_MINIMUM_SOLAR_ALTITUDE
	const penumbraContourTimes = options.penumbraContourTimes?.slice()
	const penumbraContourStepSeconds = options.penumbraContourStepSeconds

	validatePositiveFinite(temporalStepSeconds)
	validateInRange(spatialResolutionDeg, 0, 90)
	validatePositiveFinite(contourTolerance)
	validatePositiveFinite(rootFindingTolerance)
	validateFinite(minimumSolarAltitude)

	validateNonNegativeInteger(maxIterations)
	if (penumbraContourStepSeconds !== undefined) validatePositiveFinite(penumbraContourStepSeconds)

	validateFractionLevels(magnitudeLevels, false)
	validateFractionLevels(obscurationLevels, true)
	validatePositiveLevels(durationLevelsSeconds)
	validatePositiveLevels(partialDurationLevelsSeconds)

	if (penumbraContourTimes) {
		if (penumbraContourTimes.length > MAX_PENUMBRA_CONTOUR_TIMES) throw new Error(`penumbraContourTimes must contain at most ${MAX_PENUMBRA_CONTOUR_TIMES} times`)
		for (const time of penumbraContourTimes) validateTime(time)
	}

	return {
		precision,
		temporalStepSeconds,
		spatialResolutionDeg,
		magnitudeLevels,
		obscurationLevels,
		durationLevelsSeconds,
		partialDurationLevelsSeconds,
		includePenumbraContours: options.includePenumbraContours ?? true,
		penumbraContourTimes,
		penumbraContourStepSeconds,
		includeIsoCurves: options.includeIsoCurves ?? true,
		includeCentralPath: options.includeCentralPath ?? true,
		includePartialContactCurves: options.includePartialContactCurves ?? true,
		includeGlobalStats: options.includeGlobalStats ?? true,
		includeDiagnostics: options.includeDiagnostics ?? false,
		visibleOnly: options.visibleOnly ?? false,
		includeSunBelowHorizon: options.includeSunBelowHorizon ?? false,
		minimumSolarAltitude,
		useEllipsoid: options.useEllipsoid ?? true,
		contourTolerance,
		rootFindingTolerance,
		maxIterations,
		splitAtAntimeridian: options.splitAtAntimeridian ?? true,
		allowPartialGeneration: options.allowPartialGeneration ?? false,
	}
}

function resolveInput(input: SolarEclipseMapInput): ResolvedSolarEclipseInput {
	if (input.besselianElements) {
		validateElements(input.besselianElements)
		return {
			elements: input.besselianElements,
			source: {
				type: 'precomputedBesselianElements',
				approximateTime: input.approximateTime ?? input.maximumApprox,
				resolvedMaximum: input.besselianElements.geocentricMaximum,
			},
		}
	}

	const maximumApprox = input.maximumApprox ?? resolveApproximateMaximum(input)
	const elements = generateBesselianElements({ ...input.besselianOptions, maximumApprox })

	return {
		elements,
		source: {
			type: 'computedBesselianElements',
			approximateTime: input.approximateTime ?? input.maximumApprox,
			resolvedMaximum: maximumApprox,
			resolvedApproximation: input.maximumApprox ? undefined : resolveNearestSolarEclipse(input.approximateTime!),
		},
	}
}

function resolveApproximateMaximum(input: SolarEclipseMapInput) {
	if (!input.approximateTime) throw new Error('approximateTime, maximumApprox, or besselianElements is required')
	return resolveNearestSolarEclipse(input.approximateTime).maximalTime
}

function resolveNearestSolarEclipse(time: Time) {
	validateTime(time)
	const next = nearestSolarEclipse(time, true)
	const previous = nearestSolarEclipse(time, false)
	const nextDelta = Math.abs(timeSubtract(next.maximalTime, time, Timescale.TT))
	const previousDelta = Math.abs(timeSubtract(previous.maximalTime, time, Timescale.TT))

	return nextDelta <= previousDelta ? next : previous
}

function generateOptional<T>(context: MutableGenerationContext, dataset: keyof MutableGenerationContext['datasetStatus'], generate: () => T): T | undefined {
	try {
		const result = generate()
		context.datasetStatus[dataset] = 'generated'
		return result
	} catch (error) {
		context.datasetStatus[dataset] = 'failed'
		const message = error instanceof Error ? error.message : String(error)
		if (!context.options.allowPartialGeneration) throw new Error(`${dataset} generation failed: ${message}`, { cause: error })
		context.warnings.push(`${dataset} generation failed: ${message}`)
		return undefined
	}
}

function resolvePenumbraContourTimes(elements: BesselianElements, options: NormalizedSolarEclipseGenerationOptions) {
	if (options.penumbraContourTimes) return options.penumbraContourTimes
	if (!options.penumbraContourStepSeconds) return [elements.geocentricMaximum]

	const intervalSeconds = timeSubtract(elements.validTo, elements.validFrom, Timescale.TT) * DAYSEC
	const count = Math.floor(intervalSeconds / options.penumbraContourStepSeconds)
	if (count + 2 > MAX_PENUMBRA_CONTOUR_TIMES) throw new Error(`penumbraContourStepSeconds produces more than ${MAX_PENUMBRA_CONTOUR_TIMES} contour times`)

	const times: Time[] = []
	for (let i = 0; i <= count; i++) times.push(timeShift(elements.validFrom, (i * options.penumbraContourStepSeconds) / DAYSEC))
	if (Math.abs(timeSubtract(times.at(-1)!, elements.validTo, Timescale.TT)) > options.rootFindingTolerance / DAYSEC) times.push(elements.validTo)
	return times
}

function buildContourLevels(options: NormalizedSolarEclipseGenerationOptions, elements: BesselianElements) {
	const levels: EclipseContourLevel[] = []

	for (const value of options.magnitudeLevels) levels.push({ type: 'magnitude', value, unit: 'fraction', label: `magnitude ${value}` })
	for (const value of options.obscurationLevels) levels.push({ type: 'obscuration', value, unit: 'fraction', label: `obscuration ${value}` })
	for (const value of options.durationLevelsSeconds) levels.push({ type: 'totalOrAnnularDuration', value, unit: 'seconds', label: `${centralDurationLabel(elements)} ${value}s` })
	for (const value of options.partialDurationLevelsSeconds) levels.push({ type: 'partialDuration', value, unit: 'seconds', label: `partial duration ${value}s` })

	return levels
}

function centralDurationLabel(elements: BesselianElements) {
	return elements.eclipseTypeApprox === 'annular' ? 'annular duration' : 'total duration'
}

function localGridOptions(options: NormalizedSolarEclipseGenerationOptions) {
	return { gridResolutionDeg: options.spatialResolutionDeg, visibleOnly: options.visibleOnly, ignoreSunBelowHorizon: options.includeSunBelowHorizon, horizonAltitudeRadians: options.minimumSolarAltitude, numericalTolerance: options.contourTolerance }
}

function isoCurveOptions(options: NormalizedSolarEclipseGenerationOptions) {
	return { ...localGridOptions(options), splitAntimeridian: options.splitAtAntimeridian, removeTinySegments: true, minSegmentPoints: 2, smoothing: 'none' as const, resampleMaxStepDegrees: Math.max(options.spatialResolutionDeg, 1) }
}

function computeGlobalStats(elements: BesselianElements, samples: readonly EclipseGridSample[], pathLimits?: EclipsePathLimitsResult): SolarEclipseGlobalStats {
	const centralLine = pathLimits?.centerLine
	let largestMagnitude = 0
	let largestObscuration = 0
	let longestTotalOrAnnularDurationSeconds: number | undefined
	let longestPartialDurationSeconds: number | undefined
	let approximateGlobalMaximum: SolarEclipseGlobalMaximum | undefined
	let eclipseSampleCount = 0
	let visibleSampleCount = 0
	let geometricExtent: MutableExtent | undefined
	let visibleExtent: MutableExtent | undefined

	for (const sample of samples) {
		const magnitude = sample.magnitude ?? 0
		const obscuration = sample.obscuration ?? 0
		const geometricallyEclipsed = sample.eclipseType !== 'none' && magnitude > 0

		if (magnitude > largestMagnitude) largestMagnitude = magnitude
		if (obscuration > largestObscuration) largestObscuration = obscuration
		if (sample.partialDurationSeconds !== null) longestPartialOrAssign(sample.partialDurationSeconds)
		if (sample.totalOrAnnularDurationSeconds !== null) longestTotalOrAssign(sample.totalOrAnnularDurationSeconds)

		if (geometricallyEclipsed) {
			eclipseSampleCount++
			geometricExtent = extendExtent(geometricExtent, sample.latitude, sample.longitude)
		}

		if (sample.visible) {
			visibleSampleCount++
			visibleExtent = extendExtent(visibleExtent, sample.latitude, sample.longitude)
		}

		if (geometricallyEclipsed && (!approximateGlobalMaximum || magnitude > approximateGlobalMaximum.magnitude)) {
			approximateGlobalMaximum = { latitude: sample.latitude, longitude: sample.longitude, time: sample.maximumTime ?? undefined, magnitude, obscuration, eclipseType: sample.eclipseType, solarAltitude: sample.solarAltitudeAtMaximum ?? undefined }
		}
	}

	const centralMaximum = maxCentralMagnitudePoint(centralLine)
	if (centralMaximum) {
		const obscuration = centralObscuration(centralMaximum)
		if (centralMaximum.magnitude > largestMagnitude) largestMagnitude = centralMaximum.magnitude
		if (obscuration > largestObscuration) largestObscuration = obscuration
		if (!approximateGlobalMaximum || centralMaximum.magnitude > approximateGlobalMaximum.magnitude) {
			approximateGlobalMaximum = { latitude: centralMaximum.lat, longitude: centralMaximum.lon, time: centralMaximum.time, magnitude: centralMaximum.magnitude, obscuration, eclipseType: centralMaximum.eclipseType, solarAltitude: centralMaximum.solarAltitude }
		}
	}

	if (centralLine?.maxDurationPoint?.centralDurationSeconds !== undefined) longestTotalOrAssign(centralLine.maxDurationPoint.centralDurationSeconds)

	function longestPartialOrAssign(value: number) {
		if (longestPartialDurationSeconds === undefined || value > longestPartialDurationSeconds) longestPartialDurationSeconds = value
	}

	function longestTotalOrAssign(value: number) {
		if (longestTotalOrAnnularDurationSeconds === undefined || value > longestTotalOrAnnularDurationSeconds) longestTotalOrAnnularDurationSeconds = value
	}

	return {
		sampleCount: samples.length,
		eclipseSampleCount,
		visibleSampleCount,
		largestMagnitude,
		largestObscuration,
		longestTotalOrAnnularDurationSeconds,
		longestPartialDurationSeconds,
		maximumCentralPathWidthKm: maxWidth(pathLimits),
		approximateGlobalMaximum,
		geometricExtent: finalizeExtent(geometricExtent),
		visibleExtent: finalizeExtent(visibleExtent),
	}
}

function maxCentralMagnitudePoint(centralLine?: CentralLineResult) {
	let best: CentralLinePoint | undefined

	for (const point of centralLine?.points ?? []) {
		if (!best || point.magnitude > best.magnitude) best = point
	}

	return best
}

function centralObscuration(point: CentralLinePoint) {
	if (point.eclipseType === 'annular') return Math.min(1, point.magnitude * point.magnitude)
	return point.eclipseType === 'total' || point.eclipseType === 'hybrid' ? 1 : Math.min(1, point.magnitude)
}

interface MutableExtent {
	minLatitude: Angle
	maxLatitude: Angle
	minLongitude: Angle
	maxLongitude: Angle
}

function extendExtent(extent: MutableExtent | undefined, latitude: Angle, longitude: Angle): MutableExtent {
	if (!extent) return { minLatitude: latitude, maxLatitude: latitude, minLongitude: longitude, maxLongitude: longitude }

	extent.minLatitude = Math.min(extent.minLatitude, latitude)
	extent.maxLatitude = Math.max(extent.maxLatitude, latitude)
	extent.minLongitude = Math.min(extent.minLongitude, longitude)
	extent.maxLongitude = Math.max(extent.maxLongitude, longitude)

	return extent
}

function finalizeExtent(extent: MutableExtent | undefined): SolarEclipseGeographicExtent | undefined {
	return extent ? { ...extent } : undefined
}

function maxWidth(pathLimits?: EclipsePathLimitsResult) {
	let maximum: number | undefined
	for (const profile of pathLimits?.widthProfile ?? []) if (maximum === undefined || profile.widthKm > maximum) maximum = profile.widthKm
	return maximum ?? pathLimits?.centerLine.maxWidthPoint?.pathWidthKm
}

function approximateMaximumFromCentralLine(centralLine?: CentralLineResult): SolarEclipseGlobalMaximum | undefined {
	const point = centralLine?.maxDurationPoint ?? centralLine?.maxWidthPoint ?? centralLine?.points[0]
	if (!point) return undefined

	return { latitude: point.lat, longitude: point.lon, time: point.time, magnitude: point.magnitude, obscuration: point.eclipseType === 'annular' ? Math.min(1, point.magnitude * point.magnitude) : 1, eclipseType: point.eclipseType, solarAltitude: point.solarAltitude }
}

function buildMapCurves(
	elements: BesselianElements,
	options: NormalizedSolarEclipseGenerationOptions,
	centralLine: CentralLineResult | undefined,
	pathLimits: EclipsePathLimitsResult | undefined,
	centralPathPolygon: EclipsePathPolygon | undefined,
	p1Curve: GlobalContactCurve | undefined,
	p4Curve: GlobalContactCurve | undefined,
	penumbraContours: readonly GlobalEclipseContour[],
	magnitudeContours: readonly EclipseIsoCurve[],
	obscurationContours: readonly EclipseIsoCurve[],
	durationContours: readonly EclipseIsoCurve[],
) {
	const curves: SolarEclipseCurve[] = []

	if (centralLine) curves.push(centralLineCurve(centralLine, options))
	if (pathLimits?.northLimit.length) curves.push(pathLimitCurve('northLimit', 'northLimit', pathLimits.northLimit, options))
	if (pathLimits?.southLimit.length) curves.push(pathLimitCurve('southLimit', 'southLimit', pathLimits.southLimit, options))
	if (centralPathPolygon?.points.length) curves.push(pathPolygonCurve(centralPathPolygon, options))
	if (p1Curve) curves.push(contactCurve(p1Curve))
	if (p4Curve) curves.push(contactCurve(p4Curve))

	for (let i = 0; i < penumbraContours.length; i++) curves.push(penumbraCurve(penumbraContours[i]))
	for (const curve of magnitudeContours) curves.push(isoCurve(elements, curve))
	for (const curve of obscurationContours) curves.push(isoCurve(elements, curve))
	for (const curve of durationContours) curves.push(isoCurve(elements, curve))

	return curves
}

function centralLineCurve(centralLine: CentralLineResult, options: NormalizedSolarEclipseGenerationOptions): SolarEclipseCurve {
	const points = centralLine.points.map(centralLinePoint)

	return {
		type: 'centralLine',
		subtype: 'centralLine',
		points,
		segments: centralLine.segments.map((segment) => ({ points: segment.map(centralLinePoint), closed: false })),
		timeRange: timeRangeFromCurvePoints(points),
		visibleOnly: options.visibleOnly,
		includesBelowHorizon: points.some((point) => (point.solarAltitude ?? 0) < options.minimumSolarAltitude),
		metadata: { isTotal: centralLine.isTotal, isAnnular: centralLine.isAnnular, isHybrid: centralLine.isHybrid, hasCentralLine: centralLine.hasCentralLine, maxDurationSeconds: centralLine.maxDurationPoint?.centralDurationSeconds, maxWidthKm: centralLine.maxWidthPoint?.pathWidthKm },
		warnings: centralLine.warnings,
	}
}

function pathLimitCurve(type: 'northLimit' | 'southLimit', subtype: 'northLimit' | 'southLimit', points: readonly EclipsePathLimitPoint[], options: NormalizedSolarEclipseGenerationOptions): SolarEclipseCurve {
	const curvePoints = points.map(pathLimitPoint)

	return {
		type,
		subtype,
		points: curvePoints,
		segments: segmentPathLimitPoints(points).map((segment) => ({ points: segment.map(pathLimitPoint), closed: false })),
		timeRange: timeRangeFromCurvePoints(curvePoints),
		visibleOnly: options.visibleOnly,
		includesBelowHorizon: points.some((point) => point.solarAltitude < options.minimumSolarAltitude),
	}
}

function pathPolygonCurve(polygon: EclipsePathPolygon, options: NormalizedSolarEclipseGenerationOptions): SolarEclipseCurve {
	const points = polygon.points.map(pathLimitPoint)

	return {
		type: 'centralPathPolygon',
		subtype: 'centralPathPolygon',
		points,
		segments: [{ points, closed: polygon.closed }],
		timeRange: timeRangeFromCurvePoints(points),
		visibleOnly: options.visibleOnly,
		includesBelowHorizon: polygon.points.some((point) => point.solarAltitude < options.minimumSolarAltitude),
		metadata: { closed: polygon.closed, crossesAntimeridian: polygon.crossesAntimeridian, eclipseType: polygon.eclipseType },
	}
}

function contactCurve(curve: GlobalContactCurve): SolarEclipseCurve {
	const points = curve.points.map(contourPoint)

	return {
		type: 'partialContact',
		subtype: curve.type,
		points,
		segments: (curve.segments ?? [curve.points]).map((segment) => ({ points: segment.map(contourPoint), closed: false })),
		timeRange: timeRangeFromCurvePoints(points),
		visibleOnly: curve.visibleOnly,
		includesBelowHorizon: curve.points.some((point) => point.belowHorizon),
		metadata: { contactType: curve.type, options: curve.options, diagnostics: curve.diagnostics },
		warnings: curve.diagnostics?.warnings,
	}
}

function penumbraCurve(contour: GlobalEclipseContour): SolarEclipseCurve {
	const points = contour.points.map(contourPoint)

	return {
		type: 'penumbraInstantContour',
		subtype: 'penumbra',
		points,
		segments: (contour.segments ?? [contour.points]).map((segment) => ({ points: segment.map(contourPoint), closed: contour.closed })),
		timeRange: { start: contour.time, end: contour.time },
		visibleOnly: contour.options.visibleOnly,
		includesBelowHorizon: contour.points.some((point) => point.belowHorizon),
		metadata: {
			closed: contour.closed,
			options: contour.options,
			diagnostics: contour.diagnostics,
		},
		warnings: contour.diagnostics?.warnings,
	}
}

function isoCurve(elements: BesselianElements, curve: EclipseIsoCurve): SolarEclipseCurve {
	const curveType = isoCurveType(elements, curve)
	const points = curve.segments.flatMap((segment) => segment.points.map(geoPoint))

	return {
		type: curveType,
		subtype: curve.type,
		level: curve.level.value,
		unit: curve.level.unit ?? (curve.type === 'magnitude' || curve.type === 'obscuration' ? 'fraction' : 'seconds'),
		points,
		segments: curve.segments.map((segment) => isoSegment(segment)),
		visibleOnly: curve.visibilityMode === 'visibleOnly',
		metadata: curve.metadata ? { ...curve.metadata } : undefined,
		warnings: curve.segments.length === 0 ? [`${curve.type} level ${curve.level.value} produced no contour segments`] : undefined,
	}
}

function isoCurveType(elements: BesselianElements, curve: EclipseIsoCurve): SolarEclipseCurveType {
	switch (curve.type) {
		case 'magnitude':
			return 'magnitudeContour'
		case 'obscuration':
			return 'obscurationContour'
		case 'partialDuration':
			return 'partialDurationContour'
		case 'totalOrAnnularDuration':
			return elements.eclipseTypeApprox === 'annular' ? 'annularDurationContour' : 'totalDurationContour'
	}
}

function segmentPathLimitPoints(points: readonly EclipsePathLimitPoint[]) {
	if (points.length === 0) return []
	const segments: EclipsePathLimitPoint[][] = []
	let currentSegmentId = points[0].segmentId
	let current: EclipsePathLimitPoint[] = []

	for (const point of points) {
		if (current.length > 0 && point.segmentId !== currentSegmentId) {
			segments.push(current)
			current = []
			currentSegmentId = point.segmentId
		}

		current.push(point)
	}

	if (current.length > 0) segments.push(current)
	return segments
}

function centralLinePoint(point: CentralLinePoint): SolarEclipseCurvePoint {
	return { latitude: point.lat, longitude: point.lon, time: point.time, solarAltitude: point.solarAltitude, value: point.magnitude, metadata: { eclipseType: point.eclipseType, pathWidthKm: point.pathWidthKm, centralDurationSeconds: point.centralDurationSeconds } }
}

function pathLimitPoint(point: EclipsePathLimitPoint): SolarEclipseCurvePoint {
	return {
		latitude: point.lat,
		longitude: point.lon,
		time: point.time,
		solarAltitude: point.solarAltitude,
		metadata: { side: point.side, eclipseType: point.eclipseType, localDurationSeconds: point.localDurationSeconds, distanceFromCenterKm: point.distanceFromCenterKm, converged: point.converged, iterations: point.iterations, residual: point.residual, segmentId: point.segmentId },
	}
}

function contourPoint(point: ContourPoint): SolarEclipseCurvePoint {
	return { latitude: point.latitude, longitude: point.longitude, time: point.time, solarAltitude: point.solarAltitude, visible: point.visible, metadata: { belowHorizon: point.belowHorizon, ...point.metadata } }
}

function geoPoint(point: GeoPoint): SolarEclipseCurvePoint {
	return { latitude: point.latitude, longitude: point.longitude }
}

function isoSegment(segment: EclipseIsoCurveSegment): SolarEclipseCurveSegment {
	return { points: segment.points.map(geoPoint), closed: segment.closed }
}

function timeRangeFromCurvePoints(points: readonly SolarEclipseCurvePoint[]): SolarEclipseTimeRange | undefined {
	let start: Time | undefined
	let end: Time | undefined

	for (const point of points) {
		if (!point.time) continue
		if (!start || timeSubtract(point.time, start, Timescale.TT) < 0) start = point.time
		if (!end || timeSubtract(point.time, end, Timescale.TT) > 0) end = point.time
	}

	return start && end ? { start, end } : undefined
}

function largestPolygon(polygons: readonly EclipsePathPolygon[]) {
	let best: EclipsePathPolygon | undefined
	for (const polygon of polygons) if (!best || polygon.points.length > best.points.length) best = polygon
	return best
}

function determineEclipseType(elements: BesselianElements, centralLine?: CentralLineResult): SolarEclipseType | 'unknown' {
	if (centralLine?.isHybrid) return 'hybrid'
	if (centralLine?.isTotal) return 'total'
	if (centralLine?.isAnnular) return 'annular'
	return elements.eclipseTypeApprox
}

function appendIsoWarnings(warnings: string[], curves: readonly EclipseIsoCurve[]) {
	for (const curve of curves) {
		const min = curve.metadata?.minValue
		const max = curve.metadata?.maxValue
		const outsideRange = min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max) && (curve.level.value < min || curve.level.value > max)

		if (outsideRange || curve.segments.length === 0) {
			warnings.push(`${curve.type} contour level ${curve.level.value} is outside the sampled reachable range`)
		}
	}
}

function appendContactDiagnosticsWarnings(warnings: string[], curve: { readonly diagnostics?: { readonly warnings?: readonly string[]; readonly maxRefinementIterationsReached?: number } } | undefined) {
	if (!curve?.diagnostics) return
	if (curve.diagnostics.warnings) warnings.push(...curve.diagnostics.warnings)
	if ((curve.diagnostics.maxRefinementIterationsReached ?? 0) > 0) warnings.push('some contact or contour refinements reached the maximum iteration count')
}

function appendGlobalWarnings(warnings: string[], options: NormalizedSolarEclipseGenerationOptions, stats: SolarEclipseGlobalStats | undefined, centralLine: CentralLineResult | undefined, pathLimits: EclipsePathLimitsResult | undefined) {
	if (stats && options.visibleOnly && !options.includeSunBelowHorizon && stats.visibleSampleCount < stats.eclipseSampleCount) warnings.push('solar altitude filters removed some geometric eclipse samples')
	if (centralLine?.hasCentralLine && pathLimits && pathLimits.widthProfile.length === 0) warnings.push('central line exists but no complete path-width profile was generated')
	if (stats && stats.sampleCount > 0 && stats.eclipseSampleCount === 0) warnings.push('local grid did not sample any eclipsed locations; increase grid resolution or inspect input elements')
}

function validateLocalReference(map: SolarEclipseMap, reference: SolarEclipseValidationLocationReference, tolerances: ResolvedSolarEclipseValidationTolerances, checks: ValidationCheckResult[]) {
	const label = reference.id ?? `${reference.location.latitude},${reference.location.longitude}`
	const circumstances = queryLocalCircumstances(map, reference.location)

	if (reference.type !== undefined) addExactCheck(checks, `local ${label} type`, reference.type, circumstances.type)
	if (reference.maximumTime) addContactTimeCheck(checks, `local ${label} maximum time`, circumstances.MAX, reference.maximumTime, tolerances.timeSeconds)
	if (reference.maximumMagnitude !== undefined) addNumericCheck(checks, `local ${label} maximum magnitude`, Math.abs(circumstances.maximumMagnitude - reference.maximumMagnitude), tolerances.magnitude, 'magnitude', reference.maximumMagnitude, circumstances.maximumMagnitude)
	if (reference.maximumObscuration !== undefined) addNumericCheck(checks, `local ${label} maximum obscuration`, Math.abs(circumstances.maximumObscuration - reference.maximumObscuration), tolerances.magnitude, 'fraction', reference.maximumObscuration, circumstances.maximumObscuration)
	if (reference.partialDurationSeconds !== undefined) addNumericCheck(checks, `local ${label} partial duration`, Math.abs((circumstances.partialDurationSeconds ?? 0) - reference.partialDurationSeconds), tolerances.durationSeconds, 'seconds', reference.partialDurationSeconds, circumstances.partialDurationSeconds)
	if (reference.totalOrAnnularDurationSeconds !== undefined)
		addNumericCheck(checks, `local ${label} total or annular duration`, Math.abs((circumstances.totalOrAnnularDurationSeconds ?? 0) - reference.totalOrAnnularDurationSeconds), tolerances.durationSeconds, 'seconds', reference.totalOrAnnularDurationSeconds, circumstances.totalOrAnnularDurationSeconds)

	if (reference.contacts?.C1) addContactTimeCheck(checks, `local ${label} C1`, circumstances.C1, reference.contacts.C1, tolerances.timeSeconds)
	if (reference.contacts?.C2) addContactTimeCheck(checks, `local ${label} C2`, circumstances.C2, reference.contacts.C2, tolerances.timeSeconds)
	if (reference.contacts?.MAX) addContactTimeCheck(checks, `local ${label} MAX`, circumstances.MAX, reference.contacts.MAX, tolerances.timeSeconds)
	if (reference.contacts?.C3) addContactTimeCheck(checks, `local ${label} C3`, circumstances.C3, reference.contacts.C3, tolerances.timeSeconds)
	if (reference.contacts?.C4) addContactTimeCheck(checks, `local ${label} C4`, circumstances.C4, reference.contacts.C4, tolerances.timeSeconds)
}

function validateCentralLineReference(map: SolarEclipseMap, reference: SolarEclipseCentralLineReference, tolerances: ResolvedSolarEclipseValidationTolerances, checks: ValidationCheckResult[]) {
	const label = reference.id || 'central line point'
	const point = nearestCentralLinePoint(map.centralLine, reference)

	if (!point) {
		addMissingCheck(checks, label, reference)
		return
	}

	const deltaKm = distanceKm(map.besselianElements, point.lat, point.lon, reference.latitude, reference.longitude)
	addNumericCheck(checks, label, deltaKm, tolerances.positionKm, 'km', reference, { latitude: point.lat, longitude: point.lon, time: point.time })
}

function nearestCentralLinePoint(centralLine: CentralLineResult | undefined, reference: SolarEclipseCentralLineReference) {
	let best: CentralLinePoint | undefined
	let bestDelta = Number.POSITIVE_INFINITY

	for (const point of centralLine?.points ?? []) {
		const delta = reference.time ? Math.abs(timeDeltaSeconds(point.time, reference.time)) : angularDistance(point.lon, point.lat, reference.longitude, reference.latitude)

		if (delta < bestDelta) {
			best = point
			bestDelta = delta
		}
	}

	return best
}

function addContactTimeCheck(checks: ValidationCheckResult[], name: string, contact: EclipseContact | undefined, expected: Time, toleranceSeconds: number) {
	if (!contact) {
		addMissingCheck(checks, name, expected)
		return
	}

	addNumericCheck(checks, name, Math.abs(timeDeltaSeconds(contact.time, expected)), toleranceSeconds, 'seconds', expected, contact.time)
}

function addExactCheck(checks: ValidationCheckResult[], name: string, expected: unknown, measured: unknown) {
	checks.push({ name, passed: expected === measured, expected, measured, delta: expected === measured ? 0 : 1, tolerance: 0 })
}

function addNumericCheck(checks: ValidationCheckResult[], name: string, delta: number, tolerance: number, unit: string, expected: unknown, measured: unknown) {
	checks.push({ name, passed: Number.isFinite(delta) && delta <= tolerance, expected, measured, delta, tolerance, unit })
}

function addMissingCheck(checks: ValidationCheckResult[], name: string, expected: unknown) {
	checks.push({ name, passed: false, expected, message: 'generated data is missing this reference measurement' })
}

function normalizeValidationTolerances(tolerances: SolarEclipseValidationTolerances = {}): ResolvedSolarEclipseValidationTolerances {
	return {
		timeSeconds: tolerances.timeSeconds ?? DEFAULT_TIME_TOLERANCE_SECONDS,
		positionKm: tolerances.positionKm ?? DEFAULT_POSITION_TOLERANCE_KM,
		durationSeconds: tolerances.durationSeconds ?? DEFAULT_DURATION_TOLERANCE_SECONDS,
		pathWidthKm: tolerances.pathWidthKm ?? DEFAULT_PATH_WIDTH_TOLERANCE_KM,
		magnitude: tolerances.magnitude ?? DEFAULT_MAGNITUDE_TOLERANCE,
	}
}

function buildValidationRecommendations(map: SolarEclipseMap, checks: readonly ValidationCheckResult[]) {
	const recommendations: string[] = []

	if (checks.some((check) => !check.passed)) recommendations.push('increase precision or tighten temporal and spatial resolution before comparing against high-precision references')
	if (!map.centralLine?.hasCentralLine && map.metadata.eclipseType !== 'partial') recommendations.push('inspect central-path options because this non-partial eclipse has no generated central line')
	if (map.warnings.some((warning) => warning.includes('maximum iteration'))) recommendations.push('increase maxIterations or relax contourTolerance for unstable grazing geometry')
	if (map.warnings.some((warning) => warning.includes('outside the sampled reachable range'))) recommendations.push('remove unreachable contour levels or use a finer spatial grid')

	return recommendations
}

function timeDeltaSeconds(a: Time, b: Time) {
	return timeSubtract(a, b, Timescale.TT) * DAYSEC
}

function distanceKm(elements: BesselianElements, aLat: Angle, aLon: Angle, bLat: Angle, bLon: Angle) {
	return angularDistance(aLon, aLat, bLon, bLat) * earthRadiusKm(elements)
}

function earthRadiusKm(elements: BesselianElements) {
	return elements.earth.equatorialRadius * AU_KM
}

function validateFractionLevels(levels: readonly number[], clampToOne: boolean) {
	validatePositiveLevels(levels)
	if (clampToOne) for (const level of levels) validateInRange(level, 0, 1)
}

function validatePositiveLevels(levels: readonly number[]) {
	for (const level of levels) validatePositiveFinite(level)
}

function validateElements(elements: BesselianElements) {
	validateTime(elements.t0)
	validateTime(elements.validFrom)
	validateTime(elements.validTo)
	validatePositiveFinite(elements.earth.equatorialRadius)
	validateFinite(elements.earth.flattening)
	if (!(timeSubtract(elements.validTo, elements.validFrom, Timescale.TT) > 0)) throw new Error('Besselian validity interval must have positive duration')
}
