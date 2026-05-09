import { type Angle, normalizePI } from './angle'
import { AU_KM, PI } from './constants'
import { angularDistance } from './coordinate'
import { clamp } from './math'
import type { BesselianElements } from './sun.eclipse.besselian'
import { computeLocalEclipseAt, type LocalEclipseDetail } from './sun.eclipse.circumstances'
import { generateCentralLine, type CentralLinePoint, type CentralLineResult } from './sun.eclipse.lines'
import type { Time } from './time'

// Central solar-eclipse path limits from Besselian elements.
//
// Longitudes are east-positive and normalized to [-pi, +pi). Latitude and
// longitude are radians. The center line is generated with the same TT
// Besselian tau-hour convention used by sun.eclipse.lines.ts. Limit points are
// found by walking geodesic cross-track directions from the central line and
// solving m - abs(L2) = 0 with local Besselian circumstances. Ellipsoid mode
// evaluates observer coordinates on the ellipsoid; the transverse stepping is
// a spherical direct-geodesic approximation using the stored equatorial radius.

const DEFAULT_STEP_SECONDS = 30
const DEFAULT_TIME_TOLERANCE_SECONDS = 0.5
const DEFAULT_SPATIAL_TOLERANCE_KM = 0.05
const DEFAULT_NUMERIC_TOLERANCE = 1e-8
const DEFAULT_MAX_SEGMENT_ANGULAR_DISTANCE = Math.PI / 180
const DEFAULT_SOLAR_ALTITUDE_MIN = 0
const DEFAULT_MAX_ADAPTIVE_DEPTH = 8
const DEFAULT_MAX_SEARCH_DISTANCE_KM = 5000
const MIN_BOUNDARY_DISTANCE_KM = 0.001
const DUPLICATE_DISTANCE_KM = 1e-5

export type EclipsePathLimitSide = 'NORTH' | 'SOUTH'
export type EclipsePathLimitType = 'TOTAL' | 'ANNULAR'

export interface EclipsePathLimitOptions {
	readonly startTime?: Time
	readonly endTime?: Time
	readonly stepSeconds?: number
	readonly useEllipsoid?: boolean
	readonly discardBelowHorizon?: boolean
	readonly solarAltitudeMin?: Angle
	readonly toleranceSeconds?: number
	readonly timeToleranceSeconds?: number
	readonly spatialToleranceKm?: number
	readonly numericTolerance?: number
	readonly maxSegmentAngularDistance?: Angle
	readonly adaptiveSampling?: boolean
	readonly maxAdaptiveDepth?: number
	readonly splitAntimeridian?: boolean
	readonly breakAtAntimeridian?: boolean
	readonly maxSearchDistanceKm?: number
}

export interface EclipsePathLimitPoint {
	readonly time: Time
	readonly lat: Angle
	readonly lon: Angle
	readonly side: EclipsePathLimitSide
	readonly solarAltitude: Angle
	readonly localDurationSeconds: number
	readonly eclipseType: EclipsePathLimitType
	readonly distanceFromCenterKm: number
	readonly converged?: boolean
	readonly iterations?: number
	readonly residual?: number
	readonly segmentId?: number
}

export interface EclipsePathWidthProfile {
	readonly time: Time
	readonly centerLat: Angle
	readonly centerLon: Angle
	readonly northLat: Angle
	readonly northLon: Angle
	readonly southLat: Angle
	readonly southLon: Angle
	readonly widthKm: number
	readonly eclipseType: EclipsePathLimitType
	readonly segmentId?: number
}

export interface EclipsePathPolygon {
	readonly points: readonly EclipsePathLimitPoint[]
	readonly northLimit: readonly EclipsePathLimitPoint[]
	readonly southLimit: readonly EclipsePathLimitPoint[]
	readonly closed: boolean
	readonly crossesAntimeridian: boolean
	readonly eclipseType: EclipsePathLimitType | 'HYBRID'
}

export interface EclipsePathLimitsDiagnostics {
	readonly sampledCenterPoints: number
	readonly acceptedLimitPairs: number
	readonly rejectedLimitPairs: number
	readonly polygons: number
}

export interface EclipsePathLimitsResult {
	readonly northLimit: readonly EclipsePathLimitPoint[]
	readonly southLimit: readonly EclipsePathLimitPoint[]
	readonly centerLine: CentralLineResult
	readonly widthProfile: readonly EclipsePathWidthProfile[]
	readonly polygons: readonly EclipsePathPolygon[]
	readonly warnings: readonly string[]
	readonly diagnostics?: EclipsePathLimitsDiagnostics
}

interface ResolvedPathLimitOptions {
	readonly stepSeconds: number
	readonly useEllipsoid: boolean
	readonly discardBelowHorizon: boolean
	readonly solarAltitudeMin: Angle
	readonly timeToleranceSeconds: number
	readonly spatialToleranceKm: number
	readonly numericTolerance: number
	readonly maxSegmentAngularDistance: Angle
	readonly adaptiveSampling: boolean
	readonly splitAntimeridian: boolean
	readonly maxSearchDistanceKm: number
	readonly startTime?: Time
	readonly endTime?: Time
}

interface LimitCandidate {
	readonly lat: Angle
	readonly lon: Angle
	readonly solarAltitude: Angle
	readonly distanceFromCenterKm: number
	readonly eclipseType: EclipsePathLimitType
	readonly converged: boolean
	readonly iterations: number
	readonly residual: number
}

interface PathLimitSample {
	readonly center: CentralLinePoint
	readonly north: EclipsePathLimitPoint
	readonly south: EclipsePathLimitPoint
	readonly width: EclipsePathWidthProfile
}

// Generates north and south limits of the central totality or annularity path.
export function generatePathLimits(elements: BesselianElements, options?: EclipsePathLimitOptions): EclipsePathLimitsResult {
	const resolved = resolveOptions(options)
	const warnings: string[] = []
	const centerLine = generateCentralLine(elements, {
		startTime: resolved.startTime,
		endTime: resolved.endTime,
		stepSeconds: resolved.stepSeconds,
		useEllipsoid: resolved.useEllipsoid,
		discardBelowHorizon: resolved.discardBelowHorizon,
		solarAltitudeMin: resolved.solarAltitudeMin,
		toleranceSeconds: resolved.timeToleranceSeconds,
		numericTolerance: resolved.numericTolerance,
		maxSegmentAngularDistance: resolved.maxSegmentAngularDistance,
		adaptiveSampling: resolved.adaptiveSampling,
		breakAtAntimeridian: resolved.splitAntimeridian,
	})

	if (!centerLine.hasCentralLine) return emptyResult(centerLine, warnings)

	const rawSegments: PathLimitSample[][] = []
	let rejectedLimitPairs = 0
	let sampledCenterPoints = 0

	for (const segment of centerLine.segments) {
		const rawSegment: PathLimitSample[] = []

		for (let i = 0; i < segment.length; i++) {
			sampledCenterPoints++
			const sample = evaluatePathLimitSample(elements, resolved, segment, i, warnings)

			if (!sample) {
				rejectedLimitPairs++
				if (rawSegment.length > 0) rawSegments.push(rawSegment.slice())
				rawSegment.length = 0
				continue
			}

			if (rawSegment.length > 0 && shouldBreakPathSegment(rawSegment.at(-1)!, sample, resolved)) {
				rawSegments.push(rawSegment.slice())
				rawSegment.length = 0
			}

			rawSegment.push(sample)
		}

		if (rawSegment.length > 0) rawSegments.push(rawSegment)
	}

	const segmented = assignSegmentIds(rawSegments)
	const northLimit = removeDuplicateLimitPoints(flattenLimit(segmented, 'north'), elements, resolved)
	const southLimit = removeDuplicateLimitPoints(flattenLimit(segmented, 'south'), elements, resolved)
	const widthProfile = flattenWidth(segmented)
	const polygons = buildPolygons(segmented, elements, resolved)

	if (centerLine.warnings) warnings.push(...centerLine.warnings)
	if (northLimit.length === 0 || southLimit.length === 0) warnings.push('no complete path-limit pairs were found')

	return {
		northLimit,
		southLimit,
		centerLine,
		widthProfile,
		polygons,
		warnings,
		diagnostics: {
			sampledCenterPoints,
			acceptedLimitPairs: widthProfile.length,
			rejectedLimitPairs,
			polygons: polygons.length,
		},
	}
}

// Returns the largest generated central-path polygon, or an empty polygon.
export function generateCentralPathPolygon(elements: BesselianElements, options?: EclipsePathLimitOptions): EclipsePathPolygon {
	const result = generatePathLimits(elements, options)
	let best = result.polygons[0]

	for (let i = 1; i < result.polygons.length; i++) {
		if (result.polygons[i].points.length > best.points.length) best = result.polygons[i]
	}

	return best ?? { points: [], northLimit: [], southLimit: [], closed: false, crossesAntimeridian: false, eclipseType: 'HYBRID' }
}

function emptyResult(centerLine: CentralLineResult, warnings: string[]): EclipsePathLimitsResult {
	if (centerLine.warnings) warnings.push(...centerLine.warnings)

	return {
		northLimit: [],
		southLimit: [],
		centerLine,
		widthProfile: [],
		polygons: [],
		warnings,
		diagnostics: {
			sampledCenterPoints: centerLine.points.length,
			acceptedLimitPairs: 0,
			rejectedLimitPairs: 0,
			polygons: 0,
		},
	}
}

function resolveOptions(options: EclipsePathLimitOptions = {}): ResolvedPathLimitOptions {
	const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS
	const timeToleranceSeconds = options.timeToleranceSeconds ?? options.toleranceSeconds ?? DEFAULT_TIME_TOLERANCE_SECONDS
	const spatialToleranceKm = options.spatialToleranceKm ?? DEFAULT_SPATIAL_TOLERANCE_KM
	const numericTolerance = options.numericTolerance ?? DEFAULT_NUMERIC_TOLERANCE
	const maxSegmentAngularDistance = options.maxSegmentAngularDistance ?? DEFAULT_MAX_SEGMENT_ANGULAR_DISTANCE
	const maxAdaptiveDepth = options.maxAdaptiveDepth ?? DEFAULT_MAX_ADAPTIVE_DEPTH
	const maxSearchDistanceKm = options.maxSearchDistanceKm ?? DEFAULT_MAX_SEARCH_DISTANCE_KM
	const solarAltitudeMin = options.solarAltitudeMin ?? DEFAULT_SOLAR_ALTITUDE_MIN

	validatePositiveFinite('stepSeconds', stepSeconds)
	validatePositiveFinite('timeToleranceSeconds', timeToleranceSeconds)
	validatePositiveFinite('spatialToleranceKm', spatialToleranceKm)
	validatePositiveFinite('numericTolerance', numericTolerance)
	validatePositiveFinite('maxSegmentAngularDistance', maxSegmentAngularDistance)
	validatePositiveFinite('maxSearchDistanceKm', maxSearchDistanceKm)
	validateFinite('solarAltitudeMin', solarAltitudeMin)

	if (!Number.isInteger(maxAdaptiveDepth) || maxAdaptiveDepth < 0) throw new Error('maxAdaptiveDepth must be a non-negative integer')

	return {
		stepSeconds,
		useEllipsoid: options.useEllipsoid ?? true,
		discardBelowHorizon: options.discardBelowHorizon ?? false,
		solarAltitudeMin,
		timeToleranceSeconds,
		spatialToleranceKm,
		numericTolerance,
		maxSegmentAngularDistance,
		adaptiveSampling: (options.adaptiveSampling ?? false) && maxAdaptiveDepth > 0,
		splitAntimeridian: options.splitAntimeridian ?? options.breakAtAntimeridian ?? true,
		maxSearchDistanceKm,
		startTime: options.startTime,
		endTime: options.endTime,
	}
}

function evaluatePathLimitSample(elements: BesselianElements, options: ResolvedPathLimitOptions, segment: readonly CentralLinePoint[], index: number, warnings: string[]): PathLimitSample | undefined {
	const center = segment[index]
	const tangentBearing = tangentBearingAt(segment, index)

	if (tangentBearing === undefined) return undefined

	const centerDetail = computeLocalEclipseAt(elements, { latitude: center.lat, longitude: center.lon }, center.time, {
		useEarthEllipsoid: options.useEllipsoid,
		solarHorizonMinAltitude: options.solarAltitudeMin,
		scanStepSeconds: options.stepSeconds,
		timeToleranceSeconds: options.timeToleranceSeconds,
	})
	const eclipseType = limitTypeFromDetail(centerDetail)
	const first = findLimitCandidate(elements, options, center, tangentBearing + Math.PI / 2, eclipseType)
	const second = findLimitCandidate(elements, options, center, tangentBearing - Math.PI / 2, eclipseType)

	if (!first || !second) return undefined
	if (options.discardBelowHorizon && (first.solarAltitude < options.solarAltitudeMin || second.solarAltitude < options.solarAltitudeMin)) return undefined

	const northFirst = first.lat > second.lat || Math.abs(first.lat - second.lat) <= 1e-10
	if (Math.abs(first.lat - second.lat) <= 1e-10) pushUniqueWarning(warnings, 'north/south side labeling is geometric near a pole or equal-latitude limit pair')

	const northCandidate = northFirst ? first : second
	const southCandidate = northFirst ? second : first
	const north = makeLimitPoint(center.time, northCandidate, 'NORTH')
	const south = makeLimitPoint(center.time, southCandidate, 'SOUTH')
	const widthKm = distanceKm(north.lat, north.lon, south.lat, south.lon, elements)
	const width: EclipsePathWidthProfile = { time: center.time, centerLat: center.lat, centerLon: center.lon, northLat: north.lat, northLon: north.lon, southLat: south.lat, southLon: south.lon, widthKm, eclipseType }

	if (!isFiniteLimitPoint(north) || !isFiniteLimitPoint(south) || !Number.isFinite(widthKm)) return undefined

	return { center, north, south, width }
}

function findLimitCandidate(elements: BesselianElements, options: ResolvedPathLimitOptions, center: CentralLinePoint, bearing: Angle, eclipseType: EclipsePathLimitType): LimitCandidate | undefined {
	const centerValue = boundaryValueAt(elements, options, center.time, center.lat, center.lon)
	if (!centerValue || !(centerValue.value < 0)) return undefined

	let lowKm = 0
	let highKm = Math.max(MIN_BOUNDARY_DISTANCE_KM, Math.min(options.maxSearchDistanceKm, center.pathWidthKm * 0.75 || 25))
	let highValue = boundaryValueAtOffset(elements, options, center, bearing, highKm)

	for (let i = 0; i < 32 && (!highValue || highValue.value <= 0) && highKm < options.maxSearchDistanceKm; i++) {
		lowKm = highValue && highValue.value <= 0 ? highKm : lowKm
		highKm = Math.min(options.maxSearchDistanceKm, highKm * 2)
		highValue = boundaryValueAtOffset(elements, options, center, bearing, highKm)
	}

	if (!highValue || highValue.value <= 0) return undefined

	let lowValue = lowKm === 0 ? centerValue : boundaryValueAtOffset(elements, options, center, bearing, lowKm)
	let best = highValue
	let iterations = 0

	if (!lowValue) return undefined

	for (; iterations < 80 && highKm - lowKm > options.spatialToleranceKm; iterations++) {
		const midKm = (lowKm + highKm) * 0.5
		const midValue = boundaryValueAtOffset(elements, options, center, bearing, midKm)

		if (!midValue) {
			highKm = midKm
			continue
		}

		best = midValue

		if (Math.abs(midValue.value) <= options.numericTolerance) {
			lowKm = highKm = midKm
			break
		}

		if (lowValue.value * midValue.value <= 0) {
			highKm = midKm
			highValue = midValue
		} else {
			lowKm = midKm
			lowValue = midValue
		}
	}

	const rootKm = (lowKm + highKm) * 0.5
	const root = boundaryValueAtOffset(elements, options, center, bearing, rootKm) ?? best
	const converged = Math.abs(root.value) <= Math.max(options.numericTolerance, 1e-6) || highKm - lowKm <= options.spatialToleranceKm * 1.01

	return {
		lat: root.lat,
		lon: root.lon,
		solarAltitude: root.detail.sunAltitude,
		distanceFromCenterKm: root.distanceKm,
		eclipseType,
		converged,
		iterations,
		residual: root.value,
	}
}

function boundaryValueAtOffset(elements: BesselianElements, options: ResolvedPathLimitOptions, center: CentralLinePoint, bearing: Angle, distanceKmValue: number) {
	const [lon, lat] = offsetGeodesic(center.lat, center.lon, bearing, distanceKmValue, earthRadiusKm(elements))
	return boundaryValueAt(elements, options, center.time, lat, lon, distanceKmValue)
}

function boundaryValueAt(elements: BesselianElements, options: ResolvedPathLimitOptions, time: Time, lat: Angle, lon: Angle, distanceKmValue = 0) {
	const detail = computeLocalEclipseAt(elements, { latitude: lat, longitude: lon }, time, {
		useEarthEllipsoid: options.useEllipsoid,
		solarHorizonMinAltitude: options.solarAltitudeMin,
		scanStepSeconds: options.stepSeconds,
		timeToleranceSeconds: options.timeToleranceSeconds,
	})
	const value = detail.m - Math.abs(detail.L2)

	if (!Number.isFinite(value) || !Number.isFinite(detail.sunAltitude)) return undefined

	return { value, detail, lat, lon, distanceKm: distanceKmValue }
}

function tangentBearingAt(segment: readonly CentralLinePoint[], index: number) {
	const previous = segment[index - 1] ?? segment[index]
	const next = segment[index + 1] ?? segment[index]
	if (previous === next) return undefined

	const center = segment[index]
	const centerVector = unitVector(center.lat, center.lon)
	const previousVector = unitVector(previous.lat, previous.lon)
	const nextVector = unitVector(next.lat, next.lon)
	const tangent = [nextVector[0] - previousVector[0], nextVector[1] - previousVector[1], nextVector[2] - previousVector[2]]
	const dot = tangent[0] * centerVector[0] + tangent[1] * centerVector[1] + tangent[2] * centerVector[2]
	tangent[0] -= dot * centerVector[0]
	tangent[1] -= dot * centerVector[1]
	tangent[2] -= dot * centerVector[2]

	const length = Math.hypot(tangent[0], tangent[1], tangent[2])
	if (!(length > 0)) return undefined

	tangent[0] /= length
	tangent[1] /= length
	tangent[2] /= length

	const sinLat = Math.sin(center.lat)
	const cosLat = Math.cos(center.lat)
	const sinLon = Math.sin(center.lon)
	const cosLon = Math.cos(center.lon)
	const east = [-sinLon, cosLon, 0]
	const north = [-sinLat * cosLon, -sinLat * sinLon, cosLat]
	const eastComponent = tangent[0] * east[0] + tangent[1] * east[1]
	const northComponent = tangent[0] * north[0] + tangent[1] * north[1] + tangent[2] * north[2]

	return Math.atan2(eastComponent, northComponent)
}

function offsetGeodesic(lat: Angle, lon: Angle, bearing: Angle, distanceKmValue: number, radiusKm: number): readonly [Angle, Angle] {
	const angularDistanceValue = distanceKmValue / radiusKm
	const sinLat = Math.sin(lat)
	const cosLat = Math.cos(lat)
	const sinDistance = Math.sin(angularDistanceValue)
	const cosDistance = Math.cos(angularDistanceValue)
	const sinLat2 = sinLat * cosDistance + cosLat * sinDistance * Math.cos(bearing)
	const lat2 = Math.asin(clamp(sinLat2, -1, 1))
	const y = Math.sin(bearing) * sinDistance * cosLat
	const x = cosDistance - sinLat * Math.sin(lat2)
	const lon2 = normalizePI(lon + Math.atan2(y, x))

	return [lon2, lat2]
}

function makeLimitPoint(time: Time, candidate: LimitCandidate, side: EclipsePathLimitSide): EclipsePathLimitPoint {
	return { time, lat: candidate.lat, lon: candidate.lon, side, solarAltitude: candidate.solarAltitude, localDurationSeconds: 0, eclipseType: candidate.eclipseType, distanceFromCenterKm: candidate.distanceFromCenterKm, converged: candidate.converged, iterations: candidate.iterations, residual: candidate.residual }
}

function assignSegmentIds(segments: readonly PathLimitSample[][]) {
	const assigned: PathLimitSample[][] = []

	for (let segmentId = 0; segmentId < segments.length; segmentId++) {
		const segment = segments[segmentId]
		const out: PathLimitSample[] = []

		for (const sample of segment) {
			const north = { ...sample.north, segmentId }
			const south = { ...sample.south, segmentId }
			const width = { ...sample.width, segmentId }
			out.push({ center: sample.center, north, south, width })
		}

		assigned.push(out)
	}

	return assigned
}

function shouldBreakPathSegment(previous: PathLimitSample, current: PathLimitSample, options: ResolvedPathLimitOptions) {
	if (previous.width.eclipseType !== current.width.eclipseType) return true
	return options.splitAntimeridian && (crossesAntimeridian(previous.north, current.north) || crossesAntimeridian(previous.south, current.south))
}

function buildPolygons(segments: readonly PathLimitSample[][], elements: BesselianElements, options: ResolvedPathLimitOptions) {
	const polygons: EclipsePathPolygon[] = []

	for (const segment of segments) {
		if (segment.length < 2) continue

		const northLimit = removeDuplicateLimitPoints(
			segment.map((sample) => sample.north),
			elements,
			options,
		)
		const southLimit = removeDuplicateLimitPoints(
			segment.map((sample) => sample.south),
			elements,
			options,
		)
		const ring = removeDuplicateLimitPoints([...northLimit, ...southLimit.toReversed()], elements, options)
		const points = closeRing(ring)
		const type = polygonType(segment)

		polygons.push({
			points,
			northLimit,
			southLimit,
			closed: points.length >= 4 && sameLimitPoint(points[0], points.at(-1)!, elements, options),
			crossesAntimeridian: lineCrossesAntimeridian(points),
			eclipseType: type,
		})
	}

	return polygons
}

function closeRing(points: readonly EclipsePathLimitPoint[]) {
	if (points.length < 3) return points.slice()
	const closed = points.slice()
	if (!sameLimitPoint(closed[0], closed.at(-1)!, undefined, undefined)) closed.push(closed[0])
	return closed
}

function polygonType(segment: readonly PathLimitSample[]): EclipsePathLimitType | 'HYBRID' {
	const type = segment[0].width.eclipseType
	for (let i = 1; i < segment.length; i++) if (segment[i].width.eclipseType !== type) return 'HYBRID'
	return type
}

function flattenLimit(segments: readonly PathLimitSample[][], side: 'north' | 'south') {
	const points: EclipsePathLimitPoint[] = []
	for (const segment of segments) for (const sample of segment) points.push(sample[side])
	return points
}

function flattenWidth(segments: readonly PathLimitSample[][]) {
	const profiles: EclipsePathWidthProfile[] = []
	for (const segment of segments) for (const sample of segment) profiles.push(sample.width)
	return profiles
}

function removeDuplicateLimitPoints(points: readonly EclipsePathLimitPoint[], elements: BesselianElements, options: ResolvedPathLimitOptions) {
	const deduped: EclipsePathLimitPoint[] = []

	for (const point of points) {
		const previous = deduped.at(-1)
		if (!previous || !sameLimitPoint(previous, point, elements, options)) deduped.push(point)
	}

	return deduped
}

function sameLimitPoint(a: EclipsePathLimitPoint, b: EclipsePathLimitPoint, elements?: BesselianElements, options?: ResolvedPathLimitOptions) {
	if (a === b) return true
	const radiusKm = elements ? earthRadiusKm(elements) : AU_KM
	const toleranceKm = options ? Math.max(options.spatialToleranceKm, DUPLICATE_DISTANCE_KM) : DUPLICATE_DISTANCE_KM
	return angularDistance(a.lon, a.lat, b.lon, b.lat) * radiusKm <= toleranceKm
}

function lineCrossesAntimeridian(points: readonly EclipsePathLimitPoint[]) {
	for (let i = 1; i < points.length; i++) if (crossesAntimeridian(points[i - 1], points[i])) return true
	return false
}

function crossesAntimeridian(a: EclipsePathLimitPoint, b: EclipsePathLimitPoint) {
	return Math.abs(a.lon - b.lon) > Math.PI
}

function limitTypeFromDetail(detail: LocalEclipseDetail): EclipsePathLimitType {
	return detail.L2 >= 0 ? 'TOTAL' : 'ANNULAR'
}

function distanceKm(aLat: Angle, aLon: Angle, bLat: Angle, bLon: Angle, elements: BesselianElements) {
	return angularDistance(aLon, aLat, bLon, bLat) * earthRadiusKm(elements)
}

function earthRadiusKm(elements: BesselianElements) {
	return elements.earth.equatorialRadius * AU_KM
}

function unitVector(lat: Angle, lon: Angle) {
	const cosLat = Math.cos(lat)
	return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)]
}

function pushUniqueWarning(warnings: string[], warning: string) {
	if (!warnings.includes(warning)) warnings.push(warning)
}

function isFiniteLimitPoint(point: EclipsePathLimitPoint) {
	return (
		Number.isFinite(point.time.day) &&
		Number.isFinite(point.time.fraction) &&
		Number.isFinite(point.lat) &&
		Math.abs(point.lat) <= PI / 2 &&
		Number.isFinite(point.lon) &&
		point.lon >= -PI &&
		point.lon < PI &&
		Number.isFinite(point.solarAltitude) &&
		Number.isFinite(point.localDurationSeconds) &&
		Number.isFinite(point.distanceFromCenterKm)
	)
}

function validatePositiveFinite(name: string, value: number) {
	if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} must be a positive finite number`)
}

function validateFinite(name: string, value: number) {
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
}
