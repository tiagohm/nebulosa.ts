import { type Angle, normalizePI } from './angle'
import { DEG2RAD, PI } from './constants'
import { angularDistance } from './coordinate'
import { computeLocalCircumstances } from './sun.eclipse.circumstances'
import type { BesselianElements } from './sun.eclipse.besselian'
import type { SolarEclipseType } from './sun'
import { type Time, Timescale } from './time'

// Solar-eclipse iso-curves from sampled local circumstances.
//
// Coordinates are geodetic latitude and east-positive longitude in radians.
// Output longitudes are normalized to [-pi, +pi]. The implementation is
// grid-based and uses marching squares over maximum local magnitude,
// obscuration, partial duration, or total/annular duration. This is data-only
// geometry; it deliberately does not contain rendering or map projection code.

const DEFAULT_LATITUDE_MIN_DEG = -90
const DEFAULT_LATITUDE_MAX_DEG = 90
const DEFAULT_LONGITUDE_MIN_DEG = -180
const DEFAULT_LONGITUDE_MAX_DEG = 180
const DEFAULT_GRID_RESOLUTION_DEG = 1
const DEFAULT_MAX_REFINEMENT_DEPTH = 1
const DEFAULT_NUMERICAL_TOLERANCE = 1e-9
const DEFAULT_MIN_SEGMENT_POINTS = 3
const DEFAULT_RESAMPLE_MAX_STEP_DEG = 1
const MAX_GRID_SAMPLES = 300000
const ANTIMERIDIAN_SPLIT_THRESHOLD = PI

export type EclipseIsoCurveType = 'magnitude' | 'obscuration' | 'partialDuration' | 'totalOrAnnularDuration'

export type EclipseVisibilityMode = 'geometric' | 'visibleOnly'

export interface EclipseGridSample {
	readonly latitude: number
	readonly longitude: number
	readonly magnitude: number | null
	readonly obscuration: number | null
	readonly partialDurationSeconds: number | null
	readonly totalOrAnnularDurationSeconds: number | null
	readonly eclipseType: SolarEclipseType | 'NONE'
	readonly maximumTime: Time | null
	readonly solarAltitudeAtMaximum: number | null
	readonly visible: boolean
	readonly valid: boolean
}

export interface EclipseContourLevel {
	readonly type: EclipseIsoCurveType
	readonly value: number
	readonly unit?: 'fraction' | 'seconds'
	readonly label?: string
}

export interface GeoPoint {
	readonly latitude: Angle
	readonly longitude: Angle
}

export interface EclipseIsoCurveSegment {
	readonly points: readonly GeoPoint[]
	readonly closed: boolean
}

export interface EclipseIsoCurve {
	readonly type: EclipseIsoCurveType
	readonly level: EclipseContourLevel
	readonly segments: readonly EclipseIsoCurveSegment[]
	readonly visibilityMode: EclipseVisibilityMode
	readonly metadata?: {
		readonly sampleCount?: number
		readonly gridResolutionDegrees?: number
		readonly generatedAt?: string
		readonly minValue?: number
		readonly maxValue?: number
	}
}

export interface EclipseLocalGridOptions {
	readonly latitudeMinDeg?: number
	readonly latitudeMaxDeg?: number
	readonly longitudeMinDeg?: number
	readonly longitudeMaxDeg?: number
	readonly gridResolutionDeg?: number
	readonly adaptiveRefinement?: boolean
	readonly maxRefinementDepth?: number
	readonly visibleOnly?: boolean
	readonly ignoreSunBelowHorizon?: boolean
	readonly horizonAltitudeRadians?: number
	readonly numericalTolerance?: number
}

export interface EclipseIsoCurveOptions extends EclipseLocalGridOptions {
	readonly splitAntimeridian?: boolean
	readonly removeTinySegments?: boolean
	readonly minSegmentPoints?: number
	readonly smoothing?: 'none' | 'resample'
	readonly resampleMaxStepDegrees?: number
}

interface ResolvedGridOptions {
	readonly latitudeMinDeg: number
	readonly latitudeMaxDeg: number
	readonly longitudeMinDeg: number
	readonly longitudeMaxDeg: number
	readonly gridResolutionDeg: number
	readonly effectiveGridResolutionDeg: number
	readonly adaptiveRefinement: boolean
	readonly maxRefinementDepth: number
	readonly visibleOnly: boolean
	readonly ignoreSunBelowHorizon: boolean
	readonly horizonAltitudeRadians: number
	readonly numericalTolerance: number
}

interface ResolvedIsoOptions extends ResolvedGridOptions {
	readonly splitAntimeridian: boolean
	readonly removeTinySegments: boolean
	readonly minSegmentPoints: number
	readonly smoothing: 'none' | 'resample'
	readonly resampleMaxStepDegrees: number
}

interface LatitudeLongitudeGrid {
	readonly latitudes: readonly Angle[]
	readonly longitudes: readonly Angle[]
	readonly rows: number
	readonly columns: number
	readonly wrapsLongitude: boolean
	readonly resolutionDeg: number
}

interface ScalarField {
	readonly values: Float64Array
	readonly minValue: number
	readonly maxValue: number
}

interface MarchingFragment {
	readonly a: GeoPoint
	readonly b: GeoPoint
}

interface EdgeIntersection {
	readonly point: GeoPoint
	readonly edge: number
}

// Builds a sampled local-eclipse grid suitable for reuse by iso-curve generation.
export function buildEclipseLocalGrid(elements: BesselianElements, options?: EclipseLocalGridOptions): EclipseGridSample[] {
	validateElements(elements)
	const resolved = resolveGridOptions(options)
	const grid = buildLatitudeLongitudeGrid(resolved)
	return sampleLocalEclipseGrid(elements, grid, resolved)
}

// Generates one iso-curve result per requested contour level.
export function generateEclipseIsoCurves(elements: BesselianElements, levels: readonly EclipseContourLevel[], options?: EclipseIsoCurveOptions): EclipseIsoCurve[] {
	validateElements(elements)
	const resolved = resolveIsoOptions(options)
	const grid = buildLatitudeLongitudeGrid(resolved)
	const samples = sampleLocalEclipseGrid(elements, grid, resolved)

	return generateEclipseIsoCurvesFromSamples(samples, levels, resolved, grid)
}

// Generates iso-curves from a precomputed grid built with the same options.
export function generateEclipseIsoCurvesFromGrid(samples: readonly EclipseGridSample[], levels: readonly EclipseContourLevel[], options?: EclipseIsoCurveOptions): EclipseIsoCurve[] {
	const resolved = resolveIsoOptions(options)
	const grid = buildLatitudeLongitudeGrid(resolved)

	if (samples.length !== grid.rows * grid.columns) throw new Error('sample count does not match the requested grid topology')

	return generateEclipseIsoCurvesFromSamples(samples, levels, resolved, grid)
}

function generateEclipseIsoCurvesFromSamples(samples: readonly EclipseGridSample[], levels: readonly EclipseContourLevel[], resolved: ResolvedIsoOptions, grid: LatitudeLongitudeGrid) {
	validateContourLevels(levels)
	const curves: EclipseIsoCurve[] = []

	for (const level of levels) {
		const field = extractScalarField(samples, level.type, resolved)
		const segments = cleanupSegments(marchingSquares(grid, field.values, level.value, resolved.numericalTolerance), resolved)

		curves.push({
			type: level.type,
			level,
			segments,

			visibilityMode: resolved.visibleOnly ? 'visibleOnly' : 'geometric',
			metadata: {
				sampleCount: samples.length,
				gridResolutionDegrees: resolved.effectiveGridResolutionDeg,
				minValue: Number.isFinite(field.minValue) ? field.minValue : undefined,
				maxValue: Number.isFinite(field.maxValue) ? field.maxValue : undefined,
			},
		})
	}

	return curves
}

function resolveGridOptions(options: EclipseLocalGridOptions = {}): ResolvedGridOptions {
	const latitudeMinDeg = options.latitudeMinDeg ?? DEFAULT_LATITUDE_MIN_DEG
	const latitudeMaxDeg = options.latitudeMaxDeg ?? DEFAULT_LATITUDE_MAX_DEG
	const longitudeMinDeg = options.longitudeMinDeg ?? DEFAULT_LONGITUDE_MIN_DEG
	const longitudeMaxDeg = options.longitudeMaxDeg ?? DEFAULT_LONGITUDE_MAX_DEG
	const gridResolutionDeg = options.gridResolutionDeg ?? DEFAULT_GRID_RESOLUTION_DEG
	const maxRefinementDepth = options.maxRefinementDepth ?? DEFAULT_MAX_REFINEMENT_DEPTH
	const adaptiveRefinement = options.adaptiveRefinement ?? false
	const effectiveGridResolutionDeg = adaptiveRefinement ? gridResolutionDeg / 2 ** maxRefinementDepth : gridResolutionDeg
	const numericalTolerance = options.numericalTolerance ?? DEFAULT_NUMERICAL_TOLERANCE

	validateFinite('latitudeMinDeg', latitudeMinDeg)
	validateFinite('latitudeMaxDeg', latitudeMaxDeg)
	validateFinite('longitudeMinDeg', longitudeMinDeg)
	validateFinite('longitudeMaxDeg', longitudeMaxDeg)
	validatePositiveFinite('gridResolutionDeg', gridResolutionDeg)
	validatePositiveFinite('effective grid resolution', effectiveGridResolutionDeg)
	validatePositiveFinite('numericalTolerance', numericalTolerance)

	if (latitudeMinDeg < -90 || latitudeMaxDeg > 90 || !(latitudeMaxDeg > latitudeMinDeg)) throw new Error('latitude range must be within [-90, 90] and increasing')
	if (!(longitudeMaxDeg > longitudeMinDeg)) throw new Error('longitude range must be increasing')
	if (!Number.isInteger(maxRefinementDepth) || maxRefinementDepth < 0 || maxRefinementDepth > 8) throw new Error('maxRefinementDepth must be an integer in [0, 8]')

	return {
		latitudeMinDeg,
		latitudeMaxDeg,
		longitudeMinDeg,
		longitudeMaxDeg,
		gridResolutionDeg,
		effectiveGridResolutionDeg,
		adaptiveRefinement,
		maxRefinementDepth,
		visibleOnly: options.visibleOnly ?? false,
		ignoreSunBelowHorizon: options.ignoreSunBelowHorizon ?? false,
		horizonAltitudeRadians: options.horizonAltitudeRadians ?? 0,
		numericalTolerance,
	}
}

function resolveIsoOptions(options: EclipseIsoCurveOptions = {}): ResolvedIsoOptions {
	const grid = resolveGridOptions(options)
	const minSegmentPoints = options.minSegmentPoints ?? DEFAULT_MIN_SEGMENT_POINTS
	const resampleMaxStepDegrees = options.resampleMaxStepDegrees ?? DEFAULT_RESAMPLE_MAX_STEP_DEG

	if (!Number.isInteger(minSegmentPoints) || minSegmentPoints < 1) throw new Error('minSegmentPoints must be a positive integer')
	validatePositiveFinite('resampleMaxStepDegrees', resampleMaxStepDegrees)

	return { ...grid, splitAntimeridian: options.splitAntimeridian ?? true, removeTinySegments: options.removeTinySegments ?? true, minSegmentPoints, smoothing: options.smoothing ?? 'none', resampleMaxStepDegrees }
}

function buildLatitudeLongitudeGrid(options: ResolvedGridOptions): LatitudeLongitudeGrid {
	const latitudes = buildAxis(options.latitudeMinDeg, options.latitudeMaxDeg, options.effectiveGridResolutionDeg, true)
	const longitudeSpan = options.longitudeMaxDeg - options.longitudeMinDeg
	const wrapsLongitude = longitudeSpan >= 360 - options.effectiveGridResolutionDeg * 1e-12
	const longitudes = wrapsLongitude ? buildWrappedLongitudeAxis(options.longitudeMinDeg, options.effectiveGridResolutionDeg) : buildAxis(options.longitudeMinDeg, options.longitudeMaxDeg, options.effectiveGridResolutionDeg, false)
	const rows = latitudes.length
	const columns = longitudes.length
	const samples = rows * columns

	if (samples > MAX_GRID_SAMPLES) throw new Error(`grid has ${samples} samples; increase gridResolutionDeg or reduce the range`)
	if (rows < 2 || columns < 2) throw new Error('grid must contain at least two latitude and longitude samples')

	return { latitudes, longitudes, rows, columns, wrapsLongitude, resolutionDeg: options.effectiveGridResolutionDeg }
}

function buildAxis(minDeg: number, maxDeg: number, stepDeg: number, clampLatitude: boolean) {
	const values: Angle[] = []

	for (let value = minDeg; value <= maxDeg + stepDeg * 1e-12; value += stepDeg) {
		const clamped = clampLatitude ? Math.min(90, Math.max(-90, value)) : value
		values.push(clamped * DEG2RAD)
	}

	const end = (clampLatitude ? Math.min(90, Math.max(-90, maxDeg)) : maxDeg) * DEG2RAD
	if (Math.abs(values.at(-1)! - end) > 1e-12) values.push(end)

	return values
}

function buildWrappedLongitudeAxis(minDeg: number, stepDeg: number) {
	const columns = Math.max(4, Math.ceil(360 / stepDeg))
	const longitudes: Angle[] = []
	for (let i = 0; i < columns; i++) longitudes.push(normalizeLongitudeRadians((minDeg + (360 * i) / columns) * DEG2RAD))
	return longitudes
}

function sampleLocalEclipseGrid(elements: BesselianElements, grid: LatitudeLongitudeGrid, options: ResolvedGridOptions): EclipseGridSample[] {
	const samples = new Array<EclipseGridSample>(grid.rows * grid.columns)
	const localOptions = { useEarthEllipsoid: true, solarHorizonMinAltitude: options.horizonAltitudeRadians, timeToleranceSeconds: 1, scanStepSeconds: 120 }

	for (let row = 0; row < grid.rows; row++) {
		const latitude = grid.latitudes[row]

		for (let column = 0; column < grid.columns; column++) {
			const longitude = grid.longitudes[column]
			const circumstances = computeLocalCircumstances(elements, { latitude, longitude }, localOptions)
			const maximum = circumstances.MAX
			const geometricallyOccurs = circumstances.geometricallyOccurs && maximum !== undefined && circumstances.maximumMagnitude > 0
			const belowHorizonAtMaximum = maximum ? maximum.sunAltitude < options.horizonAltitudeRadians : true
			const contributes = geometricallyOccurs && (options.ignoreSunBelowHorizon || circumstances.visibleAboveHorizon)
			const visible = geometricallyOccurs && circumstances.visibleAboveHorizon && !belowHorizonAtMaximum
			const valid = !options.visibleOnly || !geometricallyOccurs || contributes
			const eclipseType = geometricallyOccurs ? maximum.phase.type : 'NONE'
			const index = sampleIndex(grid, row, column)

			samples[index] = {
				latitude,
				longitude,
				magnitude: geometricallyOccurs ? circumstances.maximumMagnitude : 0,
				obscuration: geometricallyOccurs ? circumstances.maximumObscuration : 0,
				partialDurationSeconds: circumstances.partialDurationSeconds ?? null,
				totalOrAnnularDurationSeconds: circumstances.totalOrAnnularDurationSeconds ?? null,
				eclipseType: eclipseType === 'NONE' ? 'NONE' : eclipseType,
				maximumTime: maximum?.time ?? null,
				solarAltitudeAtMaximum: maximum?.sunAltitude ?? null,
				visible: visible && !belowHorizonAtMaximum,
				valid,
			}
		}
	}

	return samples
}

function extractScalarField(samples: readonly EclipseGridSample[], type: EclipseIsoCurveType, options: ResolvedIsoOptions): ScalarField {
	const values = new Float64Array(samples.length)
	let minValue = Number.POSITIVE_INFINITY
	let maxValue = Number.NEGATIVE_INFINITY

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		const value = scalarValue(sample, type, options)

		values[i] = value

		if (Number.isFinite(value)) {
			if (value < minValue) minValue = value
			if (value > maxValue) maxValue = value
		}
	}

	return { values, minValue, maxValue }
}

function scalarValue(sample: EclipseGridSample, type: EclipseIsoCurveType, options: ResolvedIsoOptions) {
	if (!sample.valid) return Number.NaN
	if (options.visibleOnly && !options.ignoreSunBelowHorizon && !sample.visible && sample.eclipseType !== 'NONE') return Number.NaN

	switch (type) {
		case 'magnitude':
			return sample.magnitude ?? Number.NaN
		case 'obscuration':
			return sample.obscuration ?? Number.NaN
		case 'partialDuration':
			return sample.partialDurationSeconds ?? Number.NaN
		case 'totalOrAnnularDuration':
			return sample.totalOrAnnularDurationSeconds ?? Number.NaN
	}
}

function marchingSquares(grid: LatitudeLongitudeGrid, values: Float64Array, level: number, epsilon: number): EclipseIsoCurveSegment[] {
	const fragments: MarchingFragment[] = []
	const columnLimit = grid.wrapsLongitude ? grid.columns : grid.columns - 1

	function isNotFinite(corner: { readonly value: number }) {
		return !Number.isFinite(corner.value)
	}

	for (let row = 0; row + 1 < grid.rows; row++) {
		for (let column = 0; column < columnLimit; column++) {
			const nextColumn = (column + 1) % grid.columns
			const corners = [
				{ row, column, latitude: grid.latitudes[row], longitude: grid.longitudes[column], value: values[sampleIndex(grid, row, column)] },
				{ row, column: nextColumn, latitude: grid.latitudes[row], longitude: grid.longitudes[nextColumn], value: values[sampleIndex(grid, row, nextColumn)] },
				{ row: row + 1, column: nextColumn, latitude: grid.latitudes[row + 1], longitude: grid.longitudes[nextColumn], value: values[sampleIndex(grid, row + 1, nextColumn)] },
				{ row: row + 1, column, latitude: grid.latitudes[row + 1], longitude: grid.longitudes[column], value: values[sampleIndex(grid, row + 1, column)] },
			] as const

			if (corners.some(isNotFinite)) continue

			const intersections = cellIntersections(corners, level, epsilon)

			if (intersections.length === 2) {
				fragments.push({ a: intersections[0].point, b: intersections[1].point })
			} else if (intersections.length === 4) {
				const centerValue = (corners[0].value + corners[1].value + corners[2].value + corners[3].value) * 0.25
				addAmbiguousFragments(fragments, intersections, centerValue >= level)
			}
		}
	}

	return orderFragments(fragments, epsilon)
}

type CellCorner = {
	readonly latitude: Angle
	readonly longitude: Angle
	readonly value: number
}

const CELL_INTERSECTION_EDGE_CORNERS = [
	[0, 1],
	[1, 2],
	[3, 2],
	[0, 3],
] as const

function cellIntersections(corners: readonly CellCorner[], level: number, epsilon: number) {
	const intersections: EdgeIntersection[] = []

	for (let edge = 0; edge < CELL_INTERSECTION_EDGE_CORNERS.length; edge++) {
		const [aIndex, bIndex] = CELL_INTERSECTION_EDGE_CORNERS[edge]
		const a = corners[aIndex]
		const b = corners[bIndex]
		const aDelta = a.value - level
		const bDelta = b.value - level

		if (!edgeCrossesLevel(aDelta, bDelta, epsilon)) continue

		const denominator = b.value - a.value
		const fraction = Math.abs(denominator) <= epsilon ? 0.5 : Math.min(1, Math.max(0, (level - a.value) / denominator))

		intersections.push({ point: interpolatePoint(a, b, fraction), edge })
	}

	return deduplicateIntersections(intersections, epsilon)
}

function edgeCrossesLevel(aDelta: number, bDelta: number, epsilon: number) {
	if (Math.abs(aDelta) <= epsilon && Math.abs(bDelta) <= epsilon) return false
	if (Math.abs(aDelta) <= epsilon || Math.abs(bDelta) <= epsilon) return true
	return aDelta * bDelta < 0
}

function interpolatePoint(a: CellCorner, b: CellCorner, fraction: number): GeoPoint {
	return {
		latitude: a.latitude + (b.latitude - a.latitude) * fraction,
		longitude: normalizeLongitudeRadians(a.longitude + normalizePI(b.longitude - a.longitude) * fraction),
	}
}

function deduplicateIntersections(intersections: readonly EdgeIntersection[], tolerance: number) {
	const deduped: EdgeIntersection[] = []
	for (const intersection of intersections) if (!deduped.some((candidate) => samePoint(candidate.point, intersection.point, tolerance))) deduped.push(intersection)
	return deduped
}

function addAmbiguousFragments(fragments: MarchingFragment[], intersections: readonly EdgeIntersection[], centerIsHigh: boolean) {
	const byEdge = intersections.slice().sort((a, b) => a.edge - b.edge)
	const bottom = byEdge.find((intersection) => intersection.edge === 0)
	const right = byEdge.find((intersection) => intersection.edge === 1)
	const top = byEdge.find((intersection) => intersection.edge === 2)
	const left = byEdge.find((intersection) => intersection.edge === 3)

	if (!bottom || !right || !top || !left) return

	if (centerIsHigh) {
		fragments.push({ a: left.point, b: bottom.point }, { a: right.point, b: top.point })
	} else {
		fragments.push({ a: bottom.point, b: right.point }, { a: top.point, b: left.point })
	}
}

function orderFragments(fragments: readonly MarchingFragment[], tolerance: number) {
	const remaining = fragments.slice()
	const segments: GeoPoint[][] = []

	while (remaining.length > 0) {
		const fragment = remaining.pop()!
		const points: GeoPoint[] = [fragment.a, fragment.b]
		let extended = true

		while (extended) {
			extended = false

			for (let i = remaining.length - 1; i >= 0; i--) {
				const candidate = remaining[i]
				const first = points[0]
				const last = points.at(-1)!

				if (samePoint(last, candidate.a, tolerance)) {
					points.push(candidate.b)
				} else if (samePoint(last, candidate.b, tolerance)) {
					points.push(candidate.a)
				} else if (samePoint(first, candidate.b, tolerance)) {
					points.unshift(candidate.a)
				} else if (samePoint(first, candidate.a, tolerance)) {
					points.unshift(candidate.b)
				} else {
					continue
				}

				remaining.splice(i, 1)
				extended = true
			}
		}

		segments.push(deduplicatePoints(points, tolerance))
	}

	return segments.map((points) => ({ points, closed: isClosed(points, tolerance) }))
}

function cleanupSegments(segments: readonly EclipseIsoCurveSegment[], options: ResolvedIsoOptions) {
	let current: EclipseIsoCurveSegment[] = segments.map((segment) => ({ points: segment.points.slice(), closed: segment.closed }))

	if (options.splitAntimeridian) current = current.flatMap(splitSegmentAtAntimeridian)
	if (options.smoothing === 'resample') current = current.map((segment) => resampleSegment(segment, options.resampleMaxStepDegrees * DEG2RAD))

	const cleaned: EclipseIsoCurveSegment[] = []

	for (const segment of current) {
		const points = deduplicatePoints(segment.points, options.numericalTolerance)
		const closed = isClosed(points, options.numericalTolerance)

		if (options.removeTinySegments && (points.length < options.minSegmentPoints || segmentLength(points) <= options.numericalTolerance)) continue
		if (!points.every(isFinitePoint)) continue

		cleaned.push({ points, closed })
	}

	return cleaned
}

function splitSegmentAtAntimeridian(segment: EclipseIsoCurveSegment) {
	if (segment.points.length === 0) return []

	const segments: EclipseIsoCurveSegment[] = []
	let current: GeoPoint[] = [segment.points[0]]

	for (let i = 1; i < segment.points.length; i++) {
		const previous = segment.points[i - 1]
		const point = segment.points[i]

		if (Math.abs(point.longitude - previous.longitude) > ANTIMERIDIAN_SPLIT_THRESHOLD) {
			if (current.length > 0) segments.push({ points: current, closed: false })
			current = [point]
		} else {
			current.push(point)
		}
	}

	if (current.length > 0) segments.push({ points: current, closed: segment.closed && segments.length === 0 })

	return segments
}

function resampleSegment(segment: EclipseIsoCurveSegment, maxStep: Angle): EclipseIsoCurveSegment {
	const points: GeoPoint[] = []

	for (let i = 0; i < segment.points.length; i++) {
		const point = segment.points[i]
		const previous = points.at(-1)
		if (!previous) {
			points.push(point)
			continue
		}

		const distance = angularDistance(previous.longitude, previous.latitude, point.longitude, point.latitude)
		const pieces = Math.max(1, Math.ceil(distance / maxStep))

		for (let piece = 1; piece <= pieces; piece++) {
			points.push(interpolateGeoPoint(previous, point, piece / pieces))
		}
	}

	return { points, closed: segment.closed }
}

function interpolateGeoPoint(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
	return {
		latitude: a.latitude + (b.latitude - a.latitude) * fraction,
		longitude: normalizeLongitudeRadians(a.longitude + normalizePI(b.longitude - a.longitude) * fraction),
	}
}

function deduplicatePoints(points: readonly GeoPoint[], tolerance: number) {
	const deduped: GeoPoint[] = []

	for (const point of points) {
		const previous = deduped.at(-1)
		if (!previous || !samePoint(previous, point, tolerance)) deduped.push(point)
	}

	return deduped
}

function samePoint(a: GeoPoint, b: GeoPoint, tolerance: number) {
	return angularDistance(a.longitude, a.latitude, b.longitude, b.latitude) <= tolerance
}

function isClosed(points: readonly GeoPoint[], tolerance: number) {
	return points.length >= 3 && samePoint(points[0], points.at(-1)!, tolerance)
}

function segmentLength(points: readonly GeoPoint[]) {
	let length = 0
	for (let i = 1; i < points.length; i++) length += angularDistance(points[i - 1].longitude, points[i - 1].latitude, points[i].longitude, points[i].latitude)
	return length
}

function isFinitePoint(point: GeoPoint) {
	return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= Math.PI / 2 && point.longitude >= -Math.PI && point.longitude <= Math.PI
}

function sampleIndex(grid: LatitudeLongitudeGrid, row: number, column: number) {
	return row * grid.columns + (((column % grid.columns) + grid.columns) % grid.columns)
}

function normalizeLongitudeRadians(longitude: number) {
	const normalized = normalizePI(longitude)
	return normalized === Math.PI ? Math.PI : normalized
}

function validateContourLevels(levels: readonly EclipseContourLevel[]) {
	for (const level of levels) {
		validatePositiveFinite('contour level value', level.value)

		if ((level.type === 'magnitude' || level.type === 'obscuration') && level.unit === 'seconds') throw new Error(`${level.type} levels must not use seconds`)
		if ((level.type === 'partialDuration' || level.type === 'totalOrAnnularDuration') && level.unit === 'fraction') throw new Error(`${level.type} levels must not use fraction`)
		if (level.type === 'obscuration' && level.value > 1) throw new Error('obscuration levels must be in (0, 1]')
	}
}

function validateElements(elements: BesselianElements) {
	validateTime(elements.t0, 'elements.t0')
	validateTime(elements.validFrom, 'elements.validFrom')
	validateTime(elements.validTo, 'elements.validTo')
	validatePositiveFinite('elements.earth.equatorialRadius', elements.earth.equatorialRadius)
	validateFinite('elements.earth.flattening', elements.earth.flattening)
}

function validateTime(time: Time, name: string) {
	if (!Number.isFinite(time.day) || !Number.isFinite(time.fraction)) throw new Error(`${name} must have finite day and fraction`)
	if (time.scale < Timescale.UT1 || time.scale > Timescale.TCB) throw new Error(`${name} must have a valid timescale`)
}

function validatePositiveFinite(name: string, value: number) {
	if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} must be a positive finite number`)
}

function validateFinite(name: string, value: number) {
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
}
