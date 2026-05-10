import { type Angle, normalizePI } from './angle'
import { DEG2RAD } from './constants'
import { angularDistance } from './coordinate'
import type { GeographicCoordinate } from './location'
import { clamp } from './math'
import type { BesselianElements } from './sun.eclipse.besselian'
import { computeLocalCircumstances, computeLocalEclipseAt, type EclipseContact } from './sun.eclipse.circumstances'
import { type Time, timeConvert, Timescale, timeSubtract, toJulianDay } from './time'
import { validateFinite, validateInRange, validateNonNegativeInteger, validatePositiveFinite, validatePositiveInteger, validateTime } from './validation'

// Global partial-contact curves from Besselian elements.
//
// Longitudes are east-positive and normalized to [-pi, +pi]. The P1/P4
// implementation contours the global boolean field "this location has a local
// C1/C4 contact inside the requested interval" and refines each grid-edge
// crossing by recomputing local circumstances. Instantaneous penumbra contours
// use the same marching-squares machinery over m - L1 at one time; this keeps
// the first implementation deterministic and independent of rendering.

const DEFAULT_GRID_RESOLUTION_DEG = 10
const DEFAULT_ANGULAR_SAMPLING_DEG = 5
const DEFAULT_CONTOUR_TOLERANCE = 1e-6
const DEFAULT_TEMPORAL_TOLERANCE_SECONDS = 120
const DEFAULT_SPATIAL_TOLERANCE_RAD = 1e-5
const DEFAULT_MAX_REFINEMENT_ITERATIONS = 14
const DEFAULT_MIN_SEGMENT_POINTS = 2
const DEFAULT_MINIMUM_SOLAR_ALTITUDE = 0
const MAX_GRID_NODES = 250000

export type PenumbraContactType = 'P1' | 'P4'

export interface ContourPoint extends Omit<GeographicCoordinate, 'elevation'> {
	readonly latitude: Angle
	readonly longitude: Angle
	readonly time?: Time
	readonly solarAltitude?: Angle
	readonly visible?: boolean
	readonly belowHorizon?: boolean
	readonly metadata?: ContourPointMetadata
}

export interface ContourPointMetadata {
	readonly residual?: number
	readonly iterations?: number
	readonly sourceCell?: readonly [number, number]
	readonly edge?: string
	readonly refined?: boolean
}

export interface GlobalPartialContactCurveOptions {
	readonly startTime: Time
	readonly endTime: Time
	readonly gridResolutionDeg?: number
	readonly contourTolerance?: number
	readonly temporalTolerance?: number
	readonly spatialTolerance?: number
	readonly useEllipsoid?: boolean
	readonly considerSolarHorizon?: boolean
	readonly minimumSolarAltitude?: number
	readonly splitAtAntimeridian?: boolean
	readonly visibleOnly?: boolean
	readonly maxRefinementIterations?: number
	readonly minSegmentPoints?: number
	readonly includeDiagnostics?: boolean
}

export interface PenumbraContourOptions {
	readonly time?: Time
	readonly angularSamplingDeg?: number
	readonly contourTolerance?: number
	readonly useEllipsoid?: boolean
	readonly considerSolarHorizon?: boolean
	readonly minimumSolarAltitude?: number
	readonly splitAtAntimeridian?: boolean
	readonly visibleOnly?: boolean
	readonly maxRefinementIterations?: number
	readonly minSegmentPoints?: number
	readonly includeDiagnostics?: boolean
}

export interface NormalizedGlobalPartialContactCurveOptions {
	readonly startTime: Time
	readonly endTime: Time
	readonly gridResolutionDeg: number
	readonly contourTolerance: number
	readonly temporalTolerance: number
	readonly spatialTolerance: number
	readonly useEllipsoid: boolean
	readonly considerSolarHorizon: boolean
	readonly minimumSolarAltitude: Angle
	readonly splitAtAntimeridian: boolean
	readonly visibleOnly: boolean
	readonly maxRefinementIterations: number
	readonly minSegmentPoints: number
	readonly includeDiagnostics: boolean
}

export interface NormalizedPenumbraContourOptions {
	readonly time: Time
	readonly angularSamplingDeg: number
	readonly contourTolerance: number
	readonly useEllipsoid: boolean
	readonly considerSolarHorizon: boolean
	readonly minimumSolarAltitude: Angle
	readonly splitAtAntimeridian: boolean
	readonly visibleOnly: boolean
	readonly maxRefinementIterations: number
	readonly minSegmentPoints: number
	readonly includeDiagnostics: boolean
}

export interface GlobalContactCurve {
	readonly type: PenumbraContactType
	readonly points: readonly ContourPoint[]
	readonly segments?: readonly (readonly ContourPoint[])[]
	readonly visibleOnly?: boolean
	readonly options: NormalizedGlobalPartialContactCurveOptions
	readonly diagnostics?: ContactCurveDiagnostics
}

export interface GlobalEclipseContour {
	readonly time: Time
	readonly points: readonly ContourPoint[]
	readonly segments?: readonly (readonly ContourPoint[])[]
	readonly closed: boolean
	readonly options: NormalizedPenumbraContourOptions
	readonly diagnostics?: ContactCurveDiagnostics
}

export interface ContactCurveDiagnostics {
	readonly gridRows: number
	readonly gridColumns: number
	readonly evaluatedNodes: number
	readonly validNodes: number
	readonly refinedEdgeCrossings: number
	readonly discardedSegments: number
	readonly minContactTime?: Time
	readonly maxContactTime?: Time
	readonly maxRefinementIterationsReached: number
	readonly warnings?: readonly string[]
}

interface GeographicGrid {
	readonly latitudes: readonly Angle[]
	readonly longitudes: readonly Angle[]
	readonly rows: number
	readonly columns: number
}

interface ContactGridNode extends Omit<GeographicCoordinate, 'elevation'> {
	readonly p1?: ContactMetadata
	readonly p4?: ContactMetadata
}

interface ContactMetadata {
	readonly contact: EclipseContact
	readonly solarAltitude: Angle
	readonly belowHorizon: boolean
	readonly visible: boolean
}

interface RefinementResult {
	readonly point: ContourPoint
	readonly iterations: number
	readonly maxIterationsReached: boolean
}

interface MarchingFragment {
	readonly a: ContourPoint
	readonly b: ContourPoint
}

interface MutableDiagnostics {
	gridRows: number
	gridColumns: number
	evaluatedNodes: number
	validNodes: number
	refinedEdgeCrossings: number
	discardedSegments: number
	minContactTime?: Time
	maxContactTime?: Time
	maxRefinementIterationsReached: number
	warnings: string[]
}

// Generates global P1 and P4 validity-boundary curves.
export function generateGlobalPartialContactCurves(elements: BesselianElements, options: GlobalPartialContactCurveOptions): GlobalContactCurve[] {
	const resolved = normalizeGlobalPartialContactOptions(elements, options)
	const grid = buildGeographicGrid(resolved.gridResolutionDeg)
	const intervalElements = withValidityInterval(elements, resolved.startTime, resolved.endTime)
	const diagnostics = makeDiagnostics(grid)
	const nodes = evaluateContactGrid(intervalElements, grid, resolved, diagnostics)

	return [buildGlobalContactCurve(intervalElements, grid, nodes, 'P1', resolved, diagnostics), buildGlobalContactCurve(intervalElements, grid, nodes, 'P4', resolved, diagnostics)]
}

// Generates instantaneous geographic contours of the penumbral footprint.
export function generatePenumbraContourAt(elements: BesselianElements, time: Time, options?: PenumbraContourOptions): GlobalEclipseContour[] {
	const resolved = normalizePenumbraContourOptions(time, options)
	const grid = buildGeographicGrid(resolved.angularSamplingDeg)
	const diagnostics = makeDiagnostics(grid)
	const fragments: MarchingFragment[] = []
	const nodeCache = new Array<ContourFieldNode | undefined>(grid.rows * grid.columns)

	for (let row = 0; row + 1 < grid.rows; row++) {
		for (let column = 0; column < grid.columns; column++) {
			const corners = cellCorners(grid, row, column)
			const values = corners.map((corner) => evaluatePenumbraNode(elements, grid, resolved, nodeCache, diagnostics, corner[0], corner[1]))
			addCellFragments(corners, values, fragments, (a, b, edge) => refinePenumbraBoundaryPoint(elements, grid, resolved, a, b, edge, diagnostics))
		}
	}

	const segments = cleanupSegments(orderContourSegments(fragments, resolved.contourTolerance), resolved, diagnostics)
	const contours: GlobalEclipseContour[] = []

	for (const segment of segments) {
		const points = closeContourSegment(segment, resolved.contourTolerance, resolved.splitAtAntimeridian)
		contours.push({ time: resolved.time, points, segments: [points], closed: isClosedSegment(points, resolved.contourTolerance), options: resolved, diagnostics: resolved.includeDiagnostics ? finalizeDiagnostics(diagnostics) : undefined })
	}

	return contours
}

function buildGlobalContactCurve(elements: BesselianElements, grid: GeographicGrid, nodes: readonly ContactGridNode[], type: PenumbraContactType, options: NormalizedGlobalPartialContactCurveOptions, baseDiagnostics: MutableDiagnostics): GlobalContactCurve {
	const diagnostics = cloneDiagnostics(baseDiagnostics)
	const fragments: MarchingFragment[] = []

	for (let row = 0; row + 1 < grid.rows; row++) {
		for (let column = 0; column < grid.columns; column++) {
			const corners = cellCorners(grid, row, column)
			const values = corners.map((corner) => contactGridValue(nodes, grid, type, options, corner[0], corner[1]))
			addCellFragments(corners, values, fragments, (a, b, edge) => refineContactBoundaryPoint(elements, grid, nodes, type, options, a, b, edge, diagnostics))
		}
	}

	let segments = orderContourSegments(fragments, options.spatialTolerance)
	segments = cleanupSegments(segments, options, diagnostics)
	const points = flattenSegments(segments)

	updateContactTimeRange(points, diagnostics)

	return { type, points, segments, visibleOnly: options.visibleOnly, options, diagnostics: options.includeDiagnostics ? finalizeDiagnostics(diagnostics) : undefined }
}

function normalizeGlobalPartialContactOptions(elements: BesselianElements, options: GlobalPartialContactCurveOptions): NormalizedGlobalPartialContactCurveOptions {
	const startTime = timeConvert(validateTime(options.startTime), Timescale.TT)
	const endTime = timeConvert(validateTime(options.endTime), Timescale.TT)
	if (timeSubtract(endTime, startTime) <= 0) throw new Error('endTime must be after startTime')

	const gridResolutionDeg = options.gridResolutionDeg ?? DEFAULT_GRID_RESOLUTION_DEG
	const contourTolerance = options.contourTolerance ?? DEFAULT_CONTOUR_TOLERANCE
	const temporalTolerance = options.temporalTolerance ?? DEFAULT_TEMPORAL_TOLERANCE_SECONDS
	const spatialTolerance = options.spatialTolerance ?? DEFAULT_SPATIAL_TOLERANCE_RAD
	const maxRefinementIterations = options.maxRefinementIterations ?? DEFAULT_MAX_REFINEMENT_ITERATIONS
	const minSegmentPoints = options.minSegmentPoints ?? DEFAULT_MIN_SEGMENT_POINTS
	const normalized: NormalizedGlobalPartialContactCurveOptions = {
		startTime,
		endTime,
		gridResolutionDeg,
		contourTolerance,
		temporalTolerance,
		spatialTolerance,
		useEllipsoid: options.useEllipsoid ?? true,
		considerSolarHorizon: options.considerSolarHorizon ?? false,
		minimumSolarAltitude: options.minimumSolarAltitude ?? DEFAULT_MINIMUM_SOLAR_ALTITUDE,
		splitAtAntimeridian: options.splitAtAntimeridian ?? true,
		visibleOnly: options.visibleOnly ?? false,
		maxRefinementIterations,
		minSegmentPoints,
		includeDiagnostics: options.includeDiagnostics ?? false,
	}

	validateGridOptions(gridResolutionDeg, contourTolerance, temporalTolerance, spatialTolerance, maxRefinementIterations, minSegmentPoints)
	validateElements(elements)
	return normalized
}

function normalizePenumbraContourOptions(time: Time, options: PenumbraContourOptions = {}): NormalizedPenumbraContourOptions {
	validateTime(time)

	const angularSamplingDeg = options.angularSamplingDeg ?? DEFAULT_ANGULAR_SAMPLING_DEG
	const contourTolerance = options.contourTolerance ?? DEFAULT_CONTOUR_TOLERANCE
	const maxRefinementIterations = options.maxRefinementIterations ?? DEFAULT_MAX_REFINEMENT_ITERATIONS
	const minSegmentPoints = options.minSegmentPoints ?? DEFAULT_MIN_SEGMENT_POINTS
	const normalized: NormalizedPenumbraContourOptions = {
		time,
		angularSamplingDeg,
		contourTolerance,
		useEllipsoid: options.useEllipsoid ?? true,
		considerSolarHorizon: options.considerSolarHorizon ?? false,
		minimumSolarAltitude: options.minimumSolarAltitude ?? DEFAULT_MINIMUM_SOLAR_ALTITUDE,
		splitAtAntimeridian: options.splitAtAntimeridian ?? true,
		visibleOnly: options.visibleOnly ?? false,
		maxRefinementIterations,
		minSegmentPoints,
		includeDiagnostics: options.includeDiagnostics ?? false,
	}

	validateGridOptions(angularSamplingDeg, contourTolerance, DEFAULT_TEMPORAL_TOLERANCE_SECONDS, DEFAULT_SPATIAL_TOLERANCE_RAD, maxRefinementIterations, minSegmentPoints)
	return normalized
}

function buildGeographicGrid(resolutionDeg: number): GeographicGrid {
	const latitudes: Angle[] = []
	const longitudes: Angle[] = []

	for (let latitudeDeg = -90; latitudeDeg <= 90 + resolutionDeg * 1e-12; latitudeDeg += resolutionDeg) {
		latitudes.push(clamp(latitudeDeg, -90, 90) * DEG2RAD)
	}

	if (latitudes.at(-1)! < Math.PI / 2) latitudes.push(Math.PI / 2)

	const columns = Math.max(4, Math.ceil(360 / resolutionDeg))

	for (let i = 0; i < columns; i++) {
		longitudes.push(normalizePI((-180 + (360 * i) / columns) * DEG2RAD))
	}

	const nodes = latitudes.length * longitudes.length
	if (nodes > MAX_GRID_NODES) throw new Error(`grid has ${nodes} nodes; increase gridResolutionDeg`)

	return { latitudes, longitudes, rows: latitudes.length, columns: longitudes.length }
}

function evaluateContactGrid(elements: BesselianElements, grid: GeographicGrid, options: NormalizedGlobalPartialContactCurveOptions, diagnostics: MutableDiagnostics) {
	const nodes = new Array<ContactGridNode>(grid.rows * grid.columns)
	const localOptions = localCircumstanceOptions(options)

	for (let row = 0; row < grid.rows; row++) {
		const latitude = grid.latitudes[row]

		for (let column = 0; column < grid.columns; column++) {
			const longitude = grid.longitudes[column]
			const circumstances = computeLocalCircumstances(elements, { latitude, longitude }, localOptions)
			const p1 = circumstances.C1 ? contactMetadata(circumstances.C1, options) : undefined
			const p4 = circumstances.C4 ? contactMetadata(circumstances.C4, options) : undefined
			nodes[nodeIndex(grid, row, column)] = { latitude, longitude, p1, p4 }
			diagnostics.evaluatedNodes++
			if (p1 || p4) diagnostics.validNodes++
		}
	}

	return nodes
}

function contactMetadata(contact: EclipseContact, options: NormalizedGlobalPartialContactCurveOptions | NormalizedPenumbraContourOptions): ContactMetadata {
	const solarAltitude = contact.sunAltitude
	const belowHorizon = solarAltitude < options.minimumSolarAltitude
	return { contact, solarAltitude, belowHorizon, visible: !belowHorizon }
}

function contactGridValue(nodes: readonly ContactGridNode[], grid: GeographicGrid, type: PenumbraContactType, options: NormalizedGlobalPartialContactCurveOptions, row: number, column: number): ContourFieldNode {
	const node = nodes[nodeIndex(grid, row, column)]
	const contact = type === 'P1' ? node.p1 : node.p4
	const visible = !contact || !options.considerSolarHorizon || !options.visibleOnly || contact.visible
	const valid = !!contact && visible
	return { latitude: node.latitude, longitude: node.longitude, value: valid ? -1 : 1, valid, contact }
}

interface ContourFieldNode extends Omit<GeographicCoordinate, 'elevation'> {
	readonly value: number
	readonly valid: boolean
	readonly contact?: ContactMetadata
	readonly solarAltitude?: Angle
}

const CELL_FRAGMENT_EDGE_NAMES = ['bottom', 'right', 'top', 'left'] as const
const CELL_FRAGMENT_EDGES = [
	[0, 1],
	[1, 2],
	[3, 2],
	[0, 3],
] as const

function addCellFragments(corners: readonly (readonly [number, number])[], values: readonly ContourFieldNode[], fragments: MarchingFragment[], refine: (a: readonly [number, number], b: readonly [number, number], edge: string) => ContourPoint | undefined) {
	const crossings: ContourPoint[] = []

	for (let i = 0; i < CELL_FRAGMENT_EDGES.length; i++) {
		const [a, b] = CELL_FRAGMENT_EDGES[i]
		if (values[a].valid === values[b].valid) continue

		const point = refine(corners[a], corners[b], CELL_FRAGMENT_EDGE_NAMES[i])
		if (point) crossings.push(point)
	}

	if (crossings.length === 2) {
		fragments.push({ a: crossings[0], b: crossings[1] })
	} else if (crossings.length === 4) {
		fragments.push({ a: crossings[0], b: crossings[1] }, { a: crossings[2], b: crossings[3] })
	}
}

function refineContactBoundaryPoint(elements: BesselianElements, grid: GeographicGrid, nodes: readonly ContactGridNode[], type: PenumbraContactType, options: NormalizedGlobalPartialContactCurveOptions, a: readonly [number, number], b: readonly [number, number], edge: string, diagnostics: MutableDiagnostics) {
	const aNode = contactGridValue(nodes, grid, type, options, a[0], a[1])
	const bNode = contactGridValue(nodes, grid, type, options, b[0], b[1])
	const result = refineBooleanBoundary(aNode, bNode, options.maxRefinementIterations, options.spatialTolerance, (lat, lon) => contactPointAt(elements, type, options, lat, lon), edge, a[0], a[1])

	if (!result) return undefined

	diagnostics.refinedEdgeCrossings++
	if (result.maxIterationsReached) diagnostics.maxRefinementIterationsReached++
	return result.point
}

function contactPointAt(elements: BesselianElements, type: PenumbraContactType, options: NormalizedGlobalPartialContactCurveOptions, latitude: Angle, longitude: Angle): ContourPoint | undefined {
	const circumstances = computeLocalCircumstances(elements, { latitude, longitude }, localCircumstanceOptions(options))
	const contact = type === 'P1' ? circumstances.C1 : circumstances.C4
	if (!contact) return undefined

	const belowHorizon = contact.sunAltitude < options.minimumSolarAltitude
	const visible = !belowHorizon
	if (options.considerSolarHorizon && options.visibleOnly && !visible) return undefined

	return { latitude, longitude, time: contact.time, solarAltitude: contact.sunAltitude, visible, belowHorizon }
}

function refineBooleanBoundary(a: ContourFieldNode, b: ContourFieldNode, maxIterations: number, spatialTolerance: number, evaluate: (latitude: Angle, longitude: Angle) => ContourPoint | undefined, edge: string, row: number, column: number): RefinementResult | undefined {
	let valid = a.valid ? a : b
	let invalid = a.valid ? b : a
	let validPoint = contactNodePoint(valid)
	let iterations = 0
	let maxIterationsReached = false

	for (; iterations < maxIterations && angularDistance(valid.longitude, valid.latitude, invalid.longitude, invalid.latitude) > spatialTolerance; iterations++) {
		const [longitude, latitude] = interpolateGeographic(valid, invalid, 0.5)
		const point = evaluate(latitude, longitude)

		if (point) {
			valid = { latitude, longitude, value: -1, valid: true }
			validPoint = point
		} else {
			invalid = { latitude, longitude, value: 1, valid: false }
		}
	}

	if (iterations >= maxIterations && angularDistance(valid.longitude, valid.latitude, invalid.longitude, invalid.latitude) > spatialTolerance) maxIterationsReached = true
	if (!validPoint) return undefined

	return {
		point: { ...validPoint, metadata: { ...validPoint.metadata, iterations, sourceCell: [row, column], edge, refined: true } },
		iterations,
		maxIterationsReached,
	}
}

function contactNodePoint(node: ContourFieldNode): ContourPoint | undefined {
	if (!node.contact) return undefined
	return { latitude: node.latitude, longitude: node.longitude, time: node.contact.contact.time, solarAltitude: node.contact.solarAltitude, visible: node.contact.visible, belowHorizon: node.contact.belowHorizon }
}

function evaluatePenumbraNode(elements: BesselianElements, grid: GeographicGrid, options: NormalizedPenumbraContourOptions, cache: (ContourFieldNode | undefined)[], diagnostics: MutableDiagnostics, row: number, column: number): ContourFieldNode {
	const index = nodeIndex(grid, row, column)
	const cached = cache[index]
	if (cached) return cached

	const latitude = grid.latitudes[row]
	const longitude = grid.longitudes[column]
	const detail = computeLocalEclipseAt(elements, { latitude, longitude }, options.time, {
		useEarthEllipsoid: options.useEllipsoid,
		solarHorizonMinAltitude: options.minimumSolarAltitude,
	})
	const value = detail.m - detail.L1
	const valid = value <= 0
	const node = { latitude, longitude, value, valid, solarAltitude: detail.sunAltitude }
	cache[index] = node
	diagnostics.evaluatedNodes++
	if (valid) diagnostics.validNodes++
	return node
}

function refinePenumbraBoundaryPoint(elements: BesselianElements, grid: GeographicGrid, options: NormalizedPenumbraContourOptions, a: readonly [number, number], b: readonly [number, number], edge: string, diagnostics: MutableDiagnostics) {
	let aNode = penumbraValueAtGrid(elements, grid, options, a[0], a[1])
	let bNode = penumbraValueAtGrid(elements, grid, options, b[0], b[1])
	let best = Math.abs(aNode.value) <= Math.abs(bNode.value) ? aNode : bNode
	let iterations = 0

	for (; iterations < options.maxRefinementIterations && angularDistance(aNode.longitude, aNode.latitude, bNode.longitude, bNode.latitude) > options.contourTolerance; iterations++) {
		const [lon, lat] = interpolateGeographic(aNode, bNode, 0.5)
		const mid = penumbraValueAt(elements, options, lat, lon)
		if (Math.abs(mid.value) < Math.abs(best.value)) best = mid

		if (aNode.value * mid.value <= 0) {
			bNode = mid
		} else {
			aNode = mid
		}
	}

	diagnostics.refinedEdgeCrossings++
	if (iterations >= options.maxRefinementIterations && angularDistance(aNode.longitude, aNode.latitude, bNode.longitude, bNode.latitude) > options.contourTolerance) diagnostics.maxRefinementIterationsReached++

	const point = penumbraContourPoint(best, options)
	if (options.considerSolarHorizon && options.visibleOnly && !point.visible) return undefined

	return { ...point, metadata: { ...point.metadata, residual: best.value, iterations, sourceCell: [a[0], a[1]] as const, edge, refined: true } }
}

function penumbraValueAtGrid(elements: BesselianElements, grid: GeographicGrid, options: NormalizedPenumbraContourOptions, row: number, column: number) {
	return penumbraValueAt(elements, options, grid.latitudes[row], grid.longitudes[column])
}

function penumbraValueAt(elements: BesselianElements, options: NormalizedPenumbraContourOptions, latitude: Angle, longitude: Angle): ContourFieldNode {
	const detail = computeLocalEclipseAt(elements, { latitude, longitude }, options.time, {
		useEarthEllipsoid: options.useEllipsoid,
		solarHorizonMinAltitude: options.minimumSolarAltitude,
	})
	return { latitude, longitude, value: detail.m - detail.L1, valid: detail.m <= detail.L1, solarAltitude: detail.sunAltitude }
}

function penumbraContourPoint(node: ContourFieldNode, options: NormalizedPenumbraContourOptions): ContourPoint {
	const solarAltitude = node.solarAltitude ?? Number.NaN
	const belowHorizon = solarAltitude < options.minimumSolarAltitude
	return { latitude: node.latitude, longitude: node.longitude, time: options.time, solarAltitude, visible: !belowHorizon, belowHorizon }
}

function orderContourSegments(fragments: readonly MarchingFragment[], tolerance: number) {
	const remaining = fragments.slice()
	const segments: ContourPoint[][] = []

	while (remaining.length > 0) {
		const fragment = remaining.pop()!
		const segment: ContourPoint[] = [fragment.a, fragment.b]
		let extended = true

		while (extended) {
			extended = false

			for (let i = remaining.length - 1; i >= 0; i--) {
				const candidate = remaining[i]
				const first = segment[0]
				const last = segment.at(-1)!

				if (sameContourPoint(last, candidate.a, tolerance)) {
					segment.push(candidate.b)
				} else if (sameContourPoint(last, candidate.b, tolerance)) {
					segment.push(candidate.a)
				} else if (sameContourPoint(first, candidate.b, tolerance)) {
					segment.unshift(candidate.a)
				} else if (sameContourPoint(first, candidate.a, tolerance)) {
					segment.unshift(candidate.b)
				} else {
					continue
				}

				remaining.splice(i, 1)
				extended = true
			}
		}

		segments.push(deduplicateSegment(segment, tolerance))
	}

	return segments
}

function cleanupSegments(segments: readonly (readonly ContourPoint[])[], options: NormalizedGlobalPartialContactCurveOptions | NormalizedPenumbraContourOptions, diagnostics: MutableDiagnostics) {
	const cleaned: ContourPoint[][] = []
	let candidates = segments.map((segment) => segment.slice())
	const tolerance = 'spatialTolerance' in options ? options.spatialTolerance : options.contourTolerance

	if (options.considerSolarHorizon && options.visibleOnly) candidates = candidates.flatMap((segment) => splitByVisibility(segment))
	if (options.splitAtAntimeridian) candidates = candidates.flatMap((segment) => splitSegmentsAtAntimeridian(segment))

	for (const segment of candidates) {
		const deduped = deduplicateSegment(segment, tolerance)
		if (deduped.length >= options.minSegmentPoints && segmentLength(deduped) > options.contourTolerance) {
			cleaned.push(deduped)
		} else {
			diagnostics.discardedSegments++
		}
	}

	return cleaned
}

function splitByVisibility(segment: readonly ContourPoint[]) {
	const segments: ContourPoint[][] = []
	let current: ContourPoint[] = []

	for (const point of segment) {
		if (point.visible) {
			current.push(point)
		} else if (current.length > 0) {
			segments.push(current)
			current = []
		}
	}

	if (current.length > 0) segments.push(current)

	return segments
}

function splitSegmentsAtAntimeridian(segment: readonly ContourPoint[]) {
	if (segment.length === 0) return []

	const segments: ContourPoint[][] = []
	let current: ContourPoint[] = [segment[0]]

	for (let i = 1; i < segment.length; i++) {
		const previous = segment[i - 1]
		const point = segment[i]

		if (Math.abs(point.longitude - previous.longitude) > Math.PI) {
			if (current.length > 0) segments.push(current)
			current = [point]
		} else {
			current.push(point)
		}
	}

	if (current.length > 0) segments.push(current)

	return segments
}

function flattenSegments(segments: readonly (readonly ContourPoint[])[]) {
	const points: ContourPoint[] = []
	for (const segment of segments) for (const point of segment) points.push(point)
	return points
}

function closeContourSegment(segment: readonly ContourPoint[], tolerance: number, splitAtAntimeridian: boolean) {
	if (segment.length < 3 || isClosedSegment(segment, tolerance)) return segment.slice()
	if (splitAtAntimeridian && Math.abs(segment[0].longitude - segment.at(-1)!.longitude) > Math.PI) return segment.slice()
	return [...segment, segment[0]]
}

function isClosedSegment(segment: readonly ContourPoint[], tolerance: number) {
	return segment.length >= 3 && sameContourPoint(segment[0], segment.at(-1)!, tolerance)
}

function deduplicateSegment(segment: readonly ContourPoint[], tolerance: number) {
	const points: ContourPoint[] = []

	for (const point of segment) {
		const previous = points.at(-1)
		if (!previous || !sameContourPoint(previous, point, tolerance)) points.push(point)
	}

	return points
}

function sameContourPoint(a: ContourPoint, b: ContourPoint, tolerance: number) {
	return angularDistance(a.longitude, a.latitude, b.longitude, b.latitude) <= tolerance
}

function segmentLength(segment: readonly ContourPoint[]) {
	let length = 0
	for (let i = 1; i < segment.length; i++) length += angularDistance(segment[i - 1].longitude, segment[i - 1].latitude, segment[i].longitude, segment[i].latitude)
	return length
}

function interpolateGeographic(a: Pick<ContourFieldNode, 'latitude' | 'longitude'>, b: Pick<ContourFieldNode, 'latitude' | 'longitude'>, fraction: number): readonly [Angle, Angle] {
	const lat = a.latitude + (b.latitude - a.latitude) * fraction
	const lon = normalizePI(a.longitude + normalizePI(b.longitude - a.longitude) * fraction)
	return [lon, lat]
}

function cellCorners(grid: GeographicGrid, row: number, column: number) {
	const nextColumn = (column + 1) % grid.columns
	return [
		[row, column],
		[row, nextColumn],
		[row + 1, nextColumn],
		[row + 1, column],
	] as const
}

function nodeIndex(grid: GeographicGrid, row: number, column: number) {
	return row * grid.columns + (((column % grid.columns) + grid.columns) % grid.columns)
}

function localCircumstanceOptions(options: NormalizedGlobalPartialContactCurveOptions) {
	return { useEarthEllipsoid: options.useEllipsoid, solarHorizonMinAltitude: options.minimumSolarAltitude, timeToleranceSeconds: Math.max(0.1, options.temporalTolerance), scanStepSeconds: Math.max(1, options.temporalTolerance) }
}

function withValidityInterval(elements: BesselianElements, validFrom: Time, validTo: Time): BesselianElements {
	return { ...elements, validFrom, validTo }
}

function updateContactTimeRange(points: readonly ContourPoint[], diagnostics: MutableDiagnostics) {
	for (const point of points) {
		if (!point.time) continue
		if (!diagnostics.minContactTime || toJulianDay(point.time) < toJulianDay(diagnostics.minContactTime)) diagnostics.minContactTime = point.time
		if (!diagnostics.maxContactTime || toJulianDay(point.time) > toJulianDay(diagnostics.maxContactTime)) diagnostics.maxContactTime = point.time
	}
}

function makeDiagnostics(grid: GeographicGrid): MutableDiagnostics {
	return { gridRows: grid.rows, gridColumns: grid.columns, evaluatedNodes: 0, validNodes: 0, refinedEdgeCrossings: 0, discardedSegments: 0, maxRefinementIterationsReached: 0, warnings: [] }
}

function cloneDiagnostics(diagnostics: MutableDiagnostics): MutableDiagnostics {
	return { ...diagnostics, warnings: diagnostics.warnings.slice() }
}

function finalizeDiagnostics(diagnostics: MutableDiagnostics): ContactCurveDiagnostics {
	return {
		gridRows: diagnostics.gridRows,
		gridColumns: diagnostics.gridColumns,
		evaluatedNodes: diagnostics.evaluatedNodes,
		validNodes: diagnostics.validNodes,
		refinedEdgeCrossings: diagnostics.refinedEdgeCrossings,
		discardedSegments: diagnostics.discardedSegments,
		minContactTime: diagnostics.minContactTime,
		maxContactTime: diagnostics.maxContactTime,
		maxRefinementIterationsReached: diagnostics.maxRefinementIterationsReached,
		warnings: diagnostics.warnings.length > 0 ? diagnostics.warnings : undefined,
	}
}

function validateGridOptions(resolutionDeg: number, contourTolerance: number, temporalTolerance: number, spatialTolerance: number, maxRefinementIterations: number, minSegmentPoints: number) {
	validatePositiveFinite(resolutionDeg)
	validateInRange(resolutionDeg, 0, 90)
	validatePositiveFinite(contourTolerance)
	validatePositiveFinite(temporalTolerance)
	validatePositiveFinite(spatialTolerance)
	validateNonNegativeInteger(maxRefinementIterations)
	validatePositiveInteger(minSegmentPoints)
}

function validateElements(elements: BesselianElements) {
	validateTime(elements.t0)
	validateTime(elements.validFrom)
	validateTime(elements.validTo)
	validatePositiveFinite(elements.earth.equatorialRadius)
	validateFinite(elements.earth.flattening)
}
