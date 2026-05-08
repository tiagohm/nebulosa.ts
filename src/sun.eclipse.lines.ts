import { type Angle, normalizePI } from './angle'
import { AU_KM, DAYSEC } from './constants'
import { clamp } from './math'
import { type BesselianElements, type BesselianState, evaluateBesselian, normalizeBesselianTime } from './sun.besselian'
import type { SolarEclipseType } from './sun'
import { type Time, Timescale, timeShift, timeSubtract } from './time'
import { angularDistance } from './coordinate'

// Geographic solar-eclipse central-line generation from Besselian elements.
//
// Time inputs are converted by evaluateBesselian() to the element epoch's TT
// tau-hours convention. Returned longitudes are east-positive and normalized
// to [-pi, +pi). Latitudes are geodetic in ellipsoid mode; spherical mode
// treats geocentric latitude as the geodetic-equivalent latitude on a unit
// sphere. Magnitude, path width, and duration are practical cone-geometry
// approximations for map/path use, not final eclipse-bulletin circumstances.

const DEFAULT_STEP_SECONDS = 30
const DEFAULT_TOLERANCE_SECONDS = 0.5
const DEFAULT_NUMERIC_TOLERANCE = 1e-10
const DEFAULT_MAX_SEGMENT_ANGULAR_DISTANCE = Math.PI / 180
const DEFAULT_SOLAR_ALTITUDE_MIN = 0
const MAX_ADAPTIVE_DEPTH = 12
const MIN_RADIUS = 1e-12
const MIN_GROUND_SPEED_KM_S = 1e-6
const MIN_WIDTH_INCIDENT_SIN = 0.05
const MAX_PROJECTED_PATH_WIDTH_KM = 20000

export interface CentralLineOptions {
	readonly startTime?: Time
	readonly endTime?: Time
	readonly stepSeconds?: number
	readonly useSphericalEarth?: boolean
	readonly useEllipsoid?: boolean
	readonly discardBelowHorizon?: boolean
	readonly solarAltitudeMin?: Angle
	readonly toleranceSeconds?: number
	readonly numericTolerance?: number
	readonly maxSegmentAngularDistance?: Angle
	readonly adaptiveSampling?: boolean
	readonly breakAtAntimeridian?: boolean
}

export interface CentralLinePoint {
	readonly time: Time
	readonly lat: Angle
	readonly lon: Angle
	readonly solarAltitude: Angle
	readonly eclipseType: SolarEclipseType
	readonly magnitude: number
	readonly pathWidthKm: number
	readonly centralDurationSeconds: number
}

export interface CentralLineResult {
	readonly points: readonly CentralLinePoint[]
	readonly segments: readonly (readonly CentralLinePoint[])[]
	readonly startTime?: Time
	readonly endTime?: Time
	readonly maxDurationPoint?: CentralLinePoint
	readonly maxWidthPoint?: CentralLinePoint
	readonly isTotal: boolean
	readonly isAnnular: boolean
	readonly isHybrid: boolean
	readonly hasCentralLine: boolean
	readonly warnings?: readonly string[]
}

interface ResolvedCentralLineOptions {
	readonly startTauHours: number
	readonly endTauHours: number
	readonly stepSeconds: number
	readonly useEllipsoid: boolean
	readonly discardBelowHorizon: boolean
	readonly solarAltitudeMin: Angle
	readonly toleranceSeconds: number
	readonly numericTolerance: number
	readonly maxSegmentAngularDistance: Angle
	readonly adaptiveSampling: boolean
	readonly breakAtAntimeridian: boolean
}

interface CentralAxisIntersection {
	readonly lat: Angle
	readonly lon: Angle
	readonly zeta: number
	readonly radiusCosLatitude: number
	readonly radiusSinLatitude: number
}

interface CentralLineEvaluation {
	readonly tauHours: number
	readonly time: Time
	readonly zeta: number
	readonly localUmbraRadius: number
	point: CentralLinePoint
}

// Generates geographic central-line points and render-safe segments.
export function generateCentralLine(elements: BesselianElements, options?: CentralLineOptions): CentralLineResult {
	validateElements(elements)
	const resolved = resolveOptions(elements, options)
	const warnings: string[] = []

	if (elements.eclipseTypeApprox === 'PARTIAL') {
		return emptyResult(warnings)
	}

	const sampledSegments = scanCentralLine(elements, resolved)
	const centralSegments = resolved.adaptiveSampling ? adaptiveSampleSegments(elements, resolved, sampledSegments) : sampledSegments

	for (const segment of centralSegments) {
		for (const evaluation of segment) {
			evaluation.point = { ...evaluation.point, centralDurationSeconds: computeCentralDurationInSeconds(elements, resolved, evaluation) }
		}
	}

	const physicalSegments = removeEmptySegments(centralSegments)
	const renderSegments = resolved.breakAtAntimeridian ? splitAntimeridianSegments(physicalSegments) : physicalSegments
	const points = flattenPoints(physicalSegments)
	const segments = renderSegments.map((segment) => segment.map((evaluation) => evaluation.point))
	const maxDurationPoint = maxByFinite(points, (point) => point.centralDurationSeconds)
	const maxWidthPoint = maxByFinite(points, (point) => point.pathWidthKm)
	const isTotal = points.some((point) => point.eclipseType === 'TOTAL')
	const isAnnular = points.some((point) => point.eclipseType === 'ANNULAR')
	const hasHybridPoint = points.some((point) => point.eclipseType === 'HYBRID')

	if (points.length === 0 && elements.eclipseTypeApprox !== 'UNKNOWN') warnings.push('no central axis intersection was found inside the requested interval')
	if (points.some((point) => Math.abs(Math.sin(point.solarAltitude)) < MIN_WIDTH_INCIDENT_SIN)) warnings.push('some path widths are limited near the horizon')

	return {
		points,
		segments,
		startTime: physicalSegments[0]?.[0]?.time,
		endTime: physicalSegments.at(-1)?.at(-1)?.time,
		maxDurationPoint,
		maxWidthPoint,
		isTotal,
		isAnnular,
		isHybrid: (isTotal && isAnnular) || hasHybridPoint,
		hasCentralLine: points.length > 0,
		warnings: warnings.length > 0 ? warnings : undefined,
	}
}

function emptyResult(warnings: string[]): CentralLineResult {
	return {
		points: [],
		segments: [],
		isTotal: false,
		isAnnular: false,
		isHybrid: false,
		hasCentralLine: false,
		warnings: warnings.length > 0 ? warnings : undefined,
	}
}

function resolveOptions(elements: BesselianElements, options: CentralLineOptions = {}): ResolvedCentralLineOptions {
	if (options.useSphericalEarth && options.useEllipsoid) throw new Error('useSphericalEarth and useEllipsoid cannot both be true')

	const startTime = options.startTime ?? elements.validFrom
	const endTime = options.endTime ?? elements.validTo
	const startTauHours = normalizeBesselianTime(elements, startTime)
	const endTauHours = normalizeBesselianTime(elements, endTime)
	const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS
	const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
	const numericTolerance = options.numericTolerance ?? DEFAULT_NUMERIC_TOLERANCE
	const maxSegmentAngularDistance = options.maxSegmentAngularDistance ?? DEFAULT_MAX_SEGMENT_ANGULAR_DISTANCE
	const solarAltitudeMin = options.solarAltitudeMin ?? DEFAULT_SOLAR_ALTITUDE_MIN

	validateTime(startTime, 'options.startTime')
	validateTime(endTime, 'options.endTime')
	validatePositiveFinite('stepSeconds', stepSeconds)
	validatePositiveFinite('toleranceSeconds', toleranceSeconds)
	validatePositiveFinite('numericTolerance', numericTolerance)
	validatePositiveFinite('maxSegmentAngularDistance', maxSegmentAngularDistance)
	validateFinite('solarAltitudeMin', solarAltitudeMin)

	if (!(endTauHours > startTauHours)) throw new Error('central line end time must be after start time')

	return {
		startTauHours,
		endTauHours,
		stepSeconds,
		useEllipsoid: options.useSphericalEarth ? false : (options.useEllipsoid ?? true),
		discardBelowHorizon: options.discardBelowHorizon ?? false,
		solarAltitudeMin,
		toleranceSeconds,
		numericTolerance,
		maxSegmentAngularDistance,
		adaptiveSampling: options.adaptiveSampling ?? false,
		breakAtAntimeridian: options.breakAtAntimeridian ?? true,
	}
}

function scanCentralLine(elements: BesselianElements, options: ResolvedCentralLineOptions) {
	const segments: CentralLineEvaluation[][] = []
	const stepHours = options.stepSeconds / 3600
	let previousTau = options.startTauHours
	let previous = evaluateCentralLinePoint(elements, previousTau, options)
	let currentSegment: CentralLineEvaluation[] | undefined = previous ? [previous] : undefined

	for (let tau = previousTau + stepHours; tau < options.endTauHours; tau += stepHours) {
		const current = evaluateCentralLinePoint(elements, tau, options)
		currentSegment = updateScanSegments(elements, options, segments, currentSegment, previousTau, previous, tau, current)
		previousTau = tau
		previous = current
	}

	const end = evaluateCentralLinePoint(elements, options.endTauHours, options)
	currentSegment = updateScanSegments(elements, options, segments, currentSegment, previousTau, previous, options.endTauHours, end)
	if (currentSegment && currentSegment.length > 0) segments.push(currentSegment)

	return removeEmptySegments(segments)
}

function updateScanSegments(elements: BesselianElements, options: ResolvedCentralLineOptions, segments: CentralLineEvaluation[][], currentSegment: CentralLineEvaluation[] | undefined, previousTau: number, previous: CentralLineEvaluation | undefined, tau: number, current: CentralLineEvaluation | undefined) {
	if (previous && current) {
		const segment = currentSegment ?? [previous]
		addEvaluation(segment, current, options.numericTolerance)
		return segment
	}

	if (!previous && current) {
		const segment: CentralLineEvaluation[] = []
		const boundary = refineValidityBoundary(elements, options, previousTau, tau, false)
		if (boundary) addEvaluation(segment, boundary, options.numericTolerance)
		addEvaluation(segment, current, options.numericTolerance)
		return segment
	}

	if (previous && !current) {
		const segment = currentSegment ?? [previous]
		const boundary = refineValidityBoundary(elements, options, previousTau, tau, true)
		if (boundary) addEvaluation(segment, boundary, options.numericTolerance)
		if (segment.length > 0) segments.push(segment)
		return undefined
	}

	return currentSegment
}

function evaluateCentralLinePoint(elements: BesselianElements, tauHours: number, options: ResolvedCentralLineOptions): CentralLineEvaluation | undefined {
	const time = timeShift(elements.t0, tauHours / 24)
	const state = evaluateBesselian(elements, time)
	if (!isFiniteState(state)) return undefined

	const intersection = solveCentralAxisIntersection(state, options.useEllipsoid, elements.earth.flattening, options.numericTolerance)
	if (!intersection) return undefined

	const solarAltitude = computeSolarAltitude(state, intersection.lat, intersection.lon)
	if (!Number.isFinite(solarAltitude)) return undefined
	if (options.discardBelowHorizon && solarAltitude < options.solarAltitudeMin) return undefined

	const localPenumbraRadius = state.l1 + intersection.zeta * state.tanF1
	const localUmbraRadius = state.l2 - intersection.zeta * state.tanF2
	const sunRadius = (localPenumbraRadius - localUmbraRadius) * 0.5
	const moonRadius = (localPenumbraRadius + localUmbraRadius) * 0.5

	if (!(localPenumbraRadius > 0) || !(sunRadius > MIN_RADIUS) || !(moonRadius > MIN_RADIUS)) return undefined

	const eclipseType = classifyCentralEclipseType(localUmbraRadius, options.numericTolerance)
	const magnitude = computeCentralMagnitude(sunRadius, moonRadius)
	const pathWidthKm = computePathWidthKm(elements, localUmbraRadius, solarAltitude)
	const point: CentralLinePoint = {
		time,
		lat: intersection.lat,
		lon: intersection.lon,
		solarAltitude,
		eclipseType,
		magnitude,
		pathWidthKm,
		centralDurationSeconds: 0,
	}

	if (!isFinitePoint(point)) return undefined

	return { tauHours, time, zeta: intersection.zeta, localUmbraRadius, point }
}

function solveCentralAxisIntersection(state: BesselianState, useEllipsoid: boolean, flattening: number, tolerance: number): CentralAxisIntersection | undefined {
	const roots = useEllipsoid ? solveEllipsoidZetaRoots(state, flattening, tolerance) : solveSphericalZetaRoots(state, tolerance)
	let best: CentralAxisIntersection | undefined
	let bestAltitude = Number.NEGATIVE_INFINITY

	for (let i = 0; i < roots.length; i++) {
		const candidate = zetaToGeographic(state, roots[i], useEllipsoid, flattening)
		if (!candidate) continue

		const altitude = computeSolarAltitude(state, candidate.lat, candidate.lon)
		if (altitude > bestAltitude) {
			bestAltitude = altitude
			best = candidate
		}
	}

	return best
}

function solveSphericalZetaRoots(state: BesselianState, tolerance: number) {
	const distanceSquared = state.x * state.x + state.y * state.y
	if (distanceSquared > 1 + tolerance) return []

	const zeta = Math.sqrt(Math.max(0, 1 - distanceSquared))
	return zeta <= tolerance ? [0] : [zeta, -zeta]
}

function solveEllipsoidZetaRoots(state: BesselianState, flattening: number, tolerance: number) {
	const oneMinusFlattening = 1 - flattening
	const polarRadiusSquared = oneMinusFlattening * oneMinusFlattening
	const inversePolarRadiusSquared = 1 / polarRadiusSquared
	const sinD = Math.sin(state.d)
	const cosD = Math.cos(state.d)
	const a = cosD * cosD + sinD * sinD * inversePolarRadiusSquared
	const b = 2 * state.y * sinD * cosD * (inversePolarRadiusSquared - 1)
	const c = state.x * state.x + state.y * state.y * (sinD * sinD + cosD * cosD * inversePolarRadiusSquared) - 1
	const discriminant = b * b - 4 * a * c

	if (discriminant < -tolerance) return []

	const root = Math.sqrt(Math.max(0, discriminant))
	const scale = 0.5 / a
	const z0 = (-b + root) * scale
	const z1 = (-b - root) * scale

	return Math.abs(z0 - z1) <= tolerance ? [z0] : [z0, z1]
}

function zetaToGeographic(state: BesselianState, zeta: number, useEllipsoid: boolean, flattening: number): CentralAxisIntersection | undefined {
	const sinD = Math.sin(state.d)
	const cosD = Math.cos(state.d)
	const radiusCosLatitude = zeta * cosD - state.y * sinD
	const radiusSinLatitude = state.y * cosD + zeta * sinD
	const p = Math.hypot(state.x, radiusCosLatitude)
	const hourAngle = Math.atan2(state.x, radiusCosLatitude)
	const lon = normalizePI(hourAngle - state.mu)
	const lat = useEllipsoid ? geocentricToGeodeticLatitude(p, radiusSinLatitude, flattening) : Math.asin(clamp(radiusSinLatitude, -1, 1))

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined

	return { lat, lon, zeta, radiusCosLatitude, radiusSinLatitude }
}

function geocentricToGeodeticLatitude(p: number, z: number, flattening: number) {
	if (p <= Number.EPSILON) return z >= 0 ? Math.PI / 2 : -Math.PI / 2

	const oneMinusFlattening = 1 - flattening
	const eccentricitySquared = flattening * (2 - flattening)
	const secondEccentricitySquared = eccentricitySquared / (oneMinusFlattening * oneMinusFlattening)
	const theta = Math.atan2(z, p * oneMinusFlattening)
	const sinTheta = Math.sin(theta)
	const cosTheta = Math.cos(theta)

	return Math.atan2(z + secondEccentricitySquared * oneMinusFlattening * sinTheta * sinTheta * sinTheta, p - eccentricitySquared * cosTheta * cosTheta * cosTheta)
}

function computeSolarAltitude(state: BesselianState, latitude: Angle, longitude: Angle) {
	const hourAngle = state.mu + longitude - Math.PI
	const sinDeclination = -Math.sin(state.d)
	const cosDeclination = Math.cos(state.d)
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)
	const sinAltitude = sinDeclination * sinLatitude + cosDeclination * cosLatitude * Math.cos(hourAngle)

	return Math.asin(clamp(sinAltitude, -1, 1))
}

function classifyCentralEclipseType(localUmbraRadius: number, tolerance: number): SolarEclipseType {
	if (Math.abs(localUmbraRadius) <= tolerance) return 'HYBRID'
	return localUmbraRadius > 0 ? 'TOTAL' : 'ANNULAR'
}

function computeCentralMagnitude(sunRadius: number, moonRadius: number) {
	// At the central-line point the disk-center separation is zero, so this is
	// the same angular-diameter ratio approximation used by local circumstances.
	return Math.max(0, (sunRadius + moonRadius) / (2 * sunRadius))
}

function computePathWidthKm(elements: BesselianElements, localUmbraRadius: number, solarAltitude: Angle) {
	const shadowDiameterKm = 2 * Math.abs(localUmbraRadius) * elements.earth.equatorialRadius * AU_KM
	const incidence = Math.max(Math.abs(Math.sin(solarAltitude)), MIN_WIDTH_INCIDENT_SIN)
	const projectedWidthKm = shadowDiameterKm / incidence

	return Math.min(projectedWidthKm, MAX_PROJECTED_PATH_WIDTH_KM)
}

function computeCentralDurationInSeconds(elements: BesselianElements, options: ResolvedCentralLineOptions, evaluation: CentralLineEvaluation) {
	const deltaSeconds = Math.max(options.toleranceSeconds, Math.min(options.stepSeconds * 0.5, 30))
	const deltaHours = deltaSeconds / 3600
	const before = evaluateCentralLinePoint(elements, evaluation.tauHours - deltaHours, { ...options, discardBelowHorizon: false })
	const after = evaluateCentralLinePoint(elements, evaluation.tauHours + deltaHours, { ...options, discardBelowHorizon: false })
	let distanceKm = Number.NaN
	let elapsedSeconds = 0

	if (before && after) {
		distanceKm = angularDistance(before.point.lon, before.point.lat, after.point.lon, after.point.lat) * elements.earth.equatorialRadius * AU_KM
		elapsedSeconds = timeSubtract(after.time, before.time, Timescale.TT) * DAYSEC
	} else if (before) {
		distanceKm = angularDistance(before.point.lon, before.point.lat, evaluation.point.lon, evaluation.point.lat) * elements.earth.equatorialRadius * AU_KM
		elapsedSeconds = timeSubtract(evaluation.time, before.time, Timescale.TT) * DAYSEC
	} else if (after) {
		distanceKm = angularDistance(evaluation.point.lon, evaluation.point.lat, after.point.lon, after.point.lat) * elements.earth.equatorialRadius * AU_KM
		elapsedSeconds = timeSubtract(after.time, evaluation.time, Timescale.TT) * DAYSEC
	}

	if (!(distanceKm > 0) || !(elapsedSeconds > 0)) return 0

	const groundSpeedKmS = distanceKm / elapsedSeconds
	if (!(groundSpeedKmS > MIN_GROUND_SPEED_KM_S)) return 0

	const duration = evaluation.point.pathWidthKm / groundSpeedKmS
	return Number.isFinite(duration) ? duration : 0
}

function refineValidityBoundary(elements: BesselianElements, options: ResolvedCentralLineOptions, leftTau: number, rightTau: number, leftIsValid: boolean) {
	let left = leftTau
	let right = rightTau
	let valid = leftIsValid ? evaluateCentralLinePoint(elements, left, options) : evaluateCentralLinePoint(elements, right, options)

	for (let i = 0; i < 80 && (right - left) * 3600 > options.toleranceSeconds; i++) {
		const mid = (left + right) * 0.5
		const midEvaluation = evaluateCentralLinePoint(elements, mid, options)

		if (leftIsValid) {
			if (midEvaluation) {
				left = mid
				valid = midEvaluation
			} else {
				right = mid
			}
		} else if (midEvaluation) {
			right = mid
			valid = midEvaluation
		} else {
			left = mid
		}
	}

	return valid
}

function adaptiveSampleSegments(elements: BesselianElements, options: ResolvedCentralLineOptions, segments: readonly CentralLineEvaluation[][]) {
	const refined: CentralLineEvaluation[][] = []

	for (const segment of segments) {
		if (segment.length <= 1) {
			refined.push([...segment])
			continue
		}

		const output = [segment[0]]

		for (let i = 1; i < segment.length; i++) {
			appendAdaptiveSamples(elements, options, output, segment[i - 1], segment[i], 0)
		}

		refined.push(output)
	}

	return removeEmptySegments(refined)
}

function appendAdaptiveSamples(elements: BesselianElements, options: ResolvedCentralLineOptions, output: CentralLineEvaluation[], left: CentralLineEvaluation, right: CentralLineEvaluation, depth: number) {
	const deltaSeconds = (right.tauHours - left.tauHours) * 3600

	if (depth < MAX_ADAPTIVE_DEPTH && deltaSeconds > options.toleranceSeconds * 2 && shouldSubdivide(left.point, right.point, options)) {
		const midTau = (left.tauHours + right.tauHours) * 0.5
		const mid = evaluateCentralLinePoint(elements, midTau, options)

		if (mid) {
			appendAdaptiveSamples(elements, options, output, left, mid, depth + 1)
			appendAdaptiveSamples(elements, options, output, mid, right, depth + 1)
			return
		}
	}

	addEvaluation(output, right, options.numericTolerance)
}

function shouldSubdivide(left: CentralLinePoint, right: CentralLinePoint, options: ResolvedCentralLineOptions) {
	if (angularDistance(left.lon, left.lat, right.lon, right.lat) > options.maxSegmentAngularDistance) return true
	if (Math.abs(left.lon - right.lon) > Math.PI) return true
	return left.eclipseType !== right.eclipseType
}

function splitAntimeridianSegments(segments: readonly CentralLineEvaluation[][]) {
	const split: CentralLineEvaluation[][] = []

	for (const segment of segments) {
		if (segment.length === 0) continue

		let current: CentralLineEvaluation[] = [segment[0]]

		for (let i = 1; i < segment.length; i++) {
			const previous = segment[i - 1]
			const currentPoint = segment[i]

			if (Math.abs(currentPoint.point.lon - previous.point.lon) > Math.PI) {
				if (current.length > 0) split.push(current)
				current = [currentPoint]
			} else {
				current.push(currentPoint)
			}
		}

		if (current.length > 0) split.push(current)
	}

	return split
}

function flattenPoints(segments: readonly CentralLineEvaluation[][]) {
	const points: CentralLinePoint[] = []
	for (const segment of segments) for (const evaluation of segment) points.push(evaluation.point)
	return points
}

function removeEmptySegments(segments: readonly CentralLineEvaluation[][]) {
	const filtered: CentralLineEvaluation[][] = []
	for (const segment of segments) if (segment.length > 0) filtered.push(segment.slice())
	return filtered
}

function addEvaluation(segment: CentralLineEvaluation[], evaluation: CentralLineEvaluation, tolerance: number) {
	const previous = segment.at(-1)
	if (!previous || Math.abs(previous.tauHours - evaluation.tauHours) > tolerance) segment.push(evaluation)
}

function maxByFinite<T>(values: readonly T[], value: (item: T) => number) {
	let best: T | undefined
	let bestValue = Number.NEGATIVE_INFINITY

	for (const item of values) {
		const candidate = value(item)
		if (Number.isFinite(candidate) && candidate > bestValue) {
			best = item
			bestValue = candidate
		}
	}

	return best
}

function isFiniteState(state: BesselianState) {
	return Number.isFinite(state.x) && Number.isFinite(state.y) && Number.isFinite(state.d) && Number.isFinite(state.mu) && Number.isFinite(state.l1) && Number.isFinite(state.l2) && Number.isFinite(state.tanF1) && Number.isFinite(state.tanF2)
}

function isFinitePoint(point: CentralLinePoint) {
	return Number.isFinite(point.lat) && Math.abs(point.lat) <= Math.PI / 2 && Number.isFinite(point.lon) && point.lon >= -Math.PI && point.lon < Math.PI && Number.isFinite(point.solarAltitude) && Number.isFinite(point.magnitude) && Number.isFinite(point.pathWidthKm) && Number.isFinite(point.centralDurationSeconds)
}

function validateElements(elements: BesselianElements) {
	validateTime(elements.t0, 'elements.t0')
	validateTime(elements.validFrom, 'elements.validFrom')
	validateTime(elements.validTo, 'elements.validTo')
	validatePositiveFinite('elements.earth.equatorialRadius', elements.earth.equatorialRadius)
	validateFinite('elements.earth.flattening', elements.earth.flattening)

	if (elements.earth.flattening < 0 || elements.earth.flattening >= 0.02) throw new Error('elements.earth.flattening must be in the plausible [0, 0.02) range')
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
