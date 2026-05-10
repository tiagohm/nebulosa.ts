import { normalizeAngle, normalizePI } from './angle'
import { DEG2RAD, PI, PIOVERTWO, TAU } from './constants'
import { euclideanDistance, type Point } from './geometry'
import { clamp } from './math'
import type { PickByValue } from './types'

type RadialDistance = (sinC: number, cosC: number) => number | false

type AngularDistance = (rho: number) => number | false

export type LongitudeWrapMode = 'pi' | 'tau' | 'none'

export type RaAxisDirection = 'east' | 'west'

export type YAxisDirection = 'northUp' | 'southUp'

export interface ProjectionBounds {
	readonly minX: number
	readonly maxX: number
	readonly minY: number
	readonly maxY: number
}

export interface ProjectionOptions {
	readonly centralMeridian?: number
	readonly latitudeOfOrigin?: number
	readonly standardParallel1?: number
	readonly standardParallel2?: number
	readonly scale?: number
	readonly radius?: number
	readonly falseEasting?: number
	readonly falseNorthing?: number
	readonly eccentricity?: number
	readonly flattening?: number
	readonly sphericalOnly?: boolean
	readonly clampLatitude?: boolean
	readonly maxLatitude?: number
	readonly longitudeWrapMode?: LongitudeWrapMode
	readonly raAxisDirection?: RaAxisDirection
	readonly yAxisDirection?: YAxisDirection
	readonly allowInvalidOutsideDomain?: boolean
	readonly epsilon?: number
	readonly maxIterations?: number
}

export interface ProjectionPolylineOptions extends ProjectionOptions {
	readonly discontinuityThreshold?: number
	readonly maxSegmentRadians?: number
	readonly splitLongitudeGap?: number
}

export interface Projection {
	readonly forward: (lambda: number, phi: number, options?: ProjectionOptions, out?: Point) => Point | undefined
	readonly inverse: (x: number, y: number, options?: ProjectionOptions, out?: Point) => Point | undefined
	readonly bounds: (options?: ProjectionOptions) => ProjectionBounds | undefined
	readonly splitPolyline: (points: readonly Point[], options?: ProjectionPolylineOptions) => Point[][]
}

function fillPoint(out: Point | undefined, x: number, y: number) {
	if (out === undefined) {
		return { x, y }
	} else {
		out.x = x
		out.y = y
		return out
	}
}

function azimuthalRawProject(dLongitude: number, latitude: number, centerLatitude: number, radialDistance: RadialDistance, out?: Point): Point | undefined {
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)
	const sinCenterLatitude = Math.sin(centerLatitude)
	const cosCenterLatitude = Math.cos(centerLatitude)
	const sinDLongitude = Math.sin(dLongitude)
	const cosDLongitude = Math.cos(dLongitude)
	const x = cosLatitude * sinDLongitude
	const y = cosCenterLatitude * sinLatitude - sinCenterLatitude * cosLatitude * cosDLongitude
	const sinC = Math.hypot(x, y)
	const cosC = sinCenterLatitude * sinLatitude + cosCenterLatitude * cosLatitude * cosDLongitude

	if (sinC <= Number.EPSILON) {
		if (cosC < 0) return undefined
		return fillPoint(out, 0, 0)
	}

	const rho = radialDistance(sinC, cosC)

	if (rho === false) return undefined

	const scale = rho / sinC

	return fillPoint(out, x * scale, y * scale)
}

// Projects a spherical point using a radial azimuthal scaling law.
function azimuthalProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, radialDistance: RadialDistance, out?: Point): Point | undefined {
	return azimuthalRawProject(normalizePI(longitude - centerLongitude), latitude, centerLatitude, radialDistance, out)
}

function azimuthalRawUnproject(x: number, y: number, centerLatitude: number, angularDistance: AngularDistance, out?: Point) {
	if (x === 0 && y === 0) return fillPoint(out, 0, centerLatitude)

	const rho = Math.hypot(x, y)
	const c = angularDistance(rho)

	if (c === false) return undefined

	const sinC = Math.sin(c)
	const cosC = Math.cos(c)
	const sinCenterLatitude = Math.sin(centerLatitude)
	const cosCenterLatitude = Math.cos(centerLatitude)
	const latitude = Math.asin(clamp(cosC * sinCenterLatitude + (y * sinC * cosCenterLatitude) / rho, -1, 1))
	const dLongitude = Math.atan2(x * sinC, rho * cosCenterLatitude * cosC - y * sinCenterLatitude * sinC)
	return fillPoint(out, dLongitude, latitude)
}

// Unprojects azimuthal plane coordinates using the inverse radial law.
function azimuthalUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number, angularDistance: AngularDistance, out?: Point) {
	const point = azimuthalRawUnproject(x, y, centerLatitude, angularDistance, out)
	return point && fillPoint(point, normalizeAngle(centerLongitude + point.x), point.y)
}

function gnomonicRadialDistance(sinC: number, cosC: number) {
	return cosC <= 0 ? false : sinC / cosC
}

// Projects a spherical point onto a tangent plane using the gnomonic projection.
export function gnomonicProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point): Point | undefined {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, gnomonicRadialDistance, out)
}

// Unprojects tangent-plane coordinates into spherical coordinates using the gnomonic projection.
export function gnomonicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, Math.atan, out)
}

function stereographicRadialDistance(sinC: number, cosC: number) {
	const denominator = 1 + cosC
	return denominator <= Number.EPSILON ? false : (2 * sinC) / denominator
}

function stereographicAngularDistance(rho: number) {
	return 2 * Math.atan(rho / 2)
}

// Projects a spherical point onto a perspective plane using the stereographic projection.
export function stereographicProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, stereographicRadialDistance, out)
}

// Unprojects perspective-plane coordinates into spherical coordinates using the stereographic projection.
export function stereographicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, stereographicAngularDistance, out)
}

function orthographicRadialDistance(sinC: number, cosC: number) {
	return cosC < 0 ? false : sinC
}

function orthographicAngularDistance(rho: number) {
	return rho > 1 + Number.EPSILON ? false : Math.asin(clamp(rho, 0, 1))
}

// Projects a spherical point onto the visible hemisphere using the orthographic projection.
export function orthographicProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, orthographicRadialDistance, out)
}

// Unprojects orthographic-plane coordinates into spherical coordinates using the orthographic projection.
export function orthographicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, orthographicAngularDistance, out)
}

function lambertAzimuthalEqualAreaRadialDistance(sinC: number, cosC: number) {
	const denominator = 1 + cosC
	return denominator <= Number.EPSILON ? false : sinC * Math.sqrt(2 / denominator)
}

function lambertAzimuthalEqualAreaAngularDistance(rho: number) {
	return rho > 2 + Number.EPSILON ? false : 2 * Math.asin(clamp(rho / 2, 0, 1))
}

// Projects a spherical point preserving area with the Lambert azimuthal equal-area projection.
export function lambertAzimuthalEqualAreaProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, lambertAzimuthalEqualAreaRadialDistance, out)
}

// Unprojects Lambert azimuthal equal-area plane coordinates into spherical coordinates.
export function lambertAzimuthalEqualAreaUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, lambertAzimuthalEqualAreaAngularDistance, out)
}

function azimuthalEquidistantRadialDistance(sinC: number, cosC: number) {
	return sinC <= Number.EPSILON && cosC < 0 ? false : Math.atan2(sinC, cosC)
}

function azimuthalEquidistantAngularDistance(rho: number) {
	return rho > Math.PI + Number.EPSILON ? false : rho
}

// Projects a spherical point preserving distance from the center with the azimuthal equidistant projection.
export function azimuthalEquidistantProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, azimuthalEquidistantRadialDistance, out)
}

// Unprojects azimuthal-equidistant plane coordinates into spherical coordinates.
export function azimuthalEquidistantUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, azimuthalEquidistantAngularDistance, out)
}

const DEFAULT_PROJECTION_EPSILON = 1e-12
const DEFAULT_RADIUS = 1
const DEFAULT_SCALE = 1
const DEFAULT_FALSE_OFFSET = 0
const DEFAULT_MAX_MERCATOR_LATITUDE = PIOVERTWO - DEFAULT_PROJECTION_EPSILON

// The Web Mercator limit maps to y = +/-PI in normalized projection units.
export const WEB_MERCATOR_MAX_LATITUDE = Math.atan(Math.sinh(PI))

const TRYSTAN_EDWARDS_STANDARD_PARALLEL = 37.4 * DEG2RAD

function optionNumber(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, key: keyof PickByValue<ProjectionOptions, number | undefined>, fallback: number) {
	return options?.[key] ?? defaults?.[key] ?? fallback
}

function optionBoolean(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, key: keyof PickByValue<ProjectionOptions, boolean | undefined>, fallback: boolean) {
	return options?.[key] ?? defaults?.[key] ?? fallback
}

function projectionEpsilon(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const epsilon = optionNumber(options, defaults, 'epsilon', DEFAULT_PROJECTION_EPSILON)
	return Number.isFinite(epsilon) && epsilon > 0 ? epsilon : undefined
}

function projectionScale(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const radius = optionNumber(options, defaults, 'radius', DEFAULT_RADIUS)
	const scale = optionNumber(options, defaults, 'scale', DEFAULT_SCALE)

	if (!Number.isFinite(radius) || !Number.isFinite(scale) || radius <= 0 || scale <= 0) return undefined

	return radius * scale
}

function projectionFalseEasting(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const falseEasting = optionNumber(options, defaults, 'falseEasting', DEFAULT_FALSE_OFFSET)
	return Number.isFinite(falseEasting) ? falseEasting : undefined
}

function projectionFalseNorthing(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const falseNorthing = optionNumber(options, defaults, 'falseNorthing', DEFAULT_FALSE_OFFSET)
	return Number.isFinite(falseNorthing) ? falseNorthing : undefined
}

function projectionLongitudeWrapMode(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const mode = options?.longitudeWrapMode ?? defaults?.longitudeWrapMode ?? 'pi'
	return mode === 'pi' || mode === 'tau' || mode === 'none' ? mode : undefined
}

function projectionRaAxisDirection(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const direction = options?.raAxisDirection ?? defaults?.raAxisDirection ?? 'east'
	return direction === 'east' || direction === 'west' ? direction : undefined
}

function projectionYAxisDirection(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const direction = options?.yAxisDirection ?? defaults?.yAxisDirection ?? 'northUp'
	return direction === 'northUp' || direction === 'southUp' ? direction : undefined
}

function normalizeLongitudeByMode(longitude: number, mode: LongitudeWrapMode) {
	if (mode === 'none') return longitude
	return mode === 'tau' ? normalizeAngle(longitude) : normalizePI(longitude)
}

function projectionLongitudeDelta(lambda: number, options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const centralMeridian = optionNumber(options, defaults, 'centralMeridian', 0)
	const mode = projectionLongitudeWrapMode(options, defaults)
	const direction = projectionRaAxisDirection(options, defaults)

	if (!Number.isFinite(lambda) || !Number.isFinite(centralMeridian) || mode === undefined || direction === undefined) return undefined

	const delta = direction === 'west' ? centralMeridian - lambda : lambda - centralMeridian
	return normalizeLongitudeByMode(delta, mode)
}

function projectionLongitudeFromDelta(delta: number, options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const centralMeridian = optionNumber(options, defaults, 'centralMeridian', 0)
	const mode = projectionLongitudeWrapMode(options, defaults)
	const direction = projectionRaAxisDirection(options, defaults)

	if (!Number.isFinite(delta) || !Number.isFinite(centralMeridian) || mode === undefined || direction === undefined) return undefined

	const longitude = direction === 'west' ? centralMeridian - delta : centralMeridian + delta
	return normalizeLongitudeByMode(longitude, mode)
}

function projectionMaxLatitude(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, fallback: number) {
	const maxLatitude = optionNumber(options, defaults, 'maxLatitude', fallback)
	return Number.isFinite(maxLatitude) && maxLatitude > 0 && maxLatitude <= PIOVERTWO ? maxLatitude : undefined
}

function projectionLatitude(latitude: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, maxLatitudeFallback: number, clampFallback: boolean) {
	const epsilon = projectionEpsilon(options, defaults)
	const maxLatitude = projectionMaxLatitude(options, defaults, maxLatitudeFallback)

	if (epsilon === undefined || maxLatitude === undefined || !Number.isFinite(latitude)) return undefined
	if (latitude < -PIOVERTWO - epsilon || latitude > PIOVERTWO + epsilon) return undefined

	let value = clamp(latitude, -PIOVERTWO, PIOVERTWO)

	if (Math.abs(value) > maxLatitude) {
		const clampLatitude = optionBoolean(options, defaults, 'clampLatitude', clampFallback)
		if (!clampLatitude) return undefined
		value = value < 0 ? -maxLatitude : maxLatitude
	}

	return value
}

function projectionLatitudeOfOrigin(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitudeOfOrigin = optionNumber(options, defaults, 'latitudeOfOrigin', 0)
	return projectionLatitude(latitudeOfOrigin, undefined, undefined, PIOVERTWO, false)
}

function inverseLatitudeInRange(latitude: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, maxLatitudeFallback: number) {
	const epsilon = projectionEpsilon(options, defaults)
	const maxLatitude = projectionMaxLatitude(options, defaults, maxLatitudeFallback)

	if (epsilon === undefined || maxLatitude === undefined || !Number.isFinite(latitude)) return undefined
	if (latitude < -maxLatitude - epsilon || latitude > maxLatitude + epsilon) return undefined

	return clamp(latitude, -maxLatitude, maxLatitude)
}

function projectionStandardParallelCos(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, fallback: number) {
	const epsilon = projectionEpsilon(options, defaults)
	const standardParallel = optionNumber(options, defaults, 'standardParallel1', fallback)

	if (epsilon === undefined || !Number.isFinite(standardParallel) || standardParallel <= -PIOVERTWO + epsilon || standardParallel >= PIOVERTWO - epsilon) return undefined

	return Math.cos(standardParallel)
}

function projectionEccentricity(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	if (optionBoolean(options, defaults, 'sphericalOnly', false)) return 0

	const eccentricity = options?.eccentricity ?? defaults?.eccentricity

	if (eccentricity !== undefined) {
		return Number.isFinite(eccentricity) && eccentricity >= 0 && eccentricity < 1 ? eccentricity : undefined
	}

	const flattening = options?.flattening ?? defaults?.flattening

	if (flattening === undefined) return 0
	if (!Number.isFinite(flattening) || flattening < 0 || flattening >= 1) return undefined

	return Math.sqrt(flattening * (2 - flattening))
}

function projectionMaxIterations(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const maxIterations = optionNumber(options, defaults, 'maxIterations', 12)
	return Number.isFinite(maxIterations) && maxIterations >= 1 ? Math.floor(maxIterations) : undefined
}

function projectRawPoint(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const scale = projectionScale(options, defaults)
	const falseEasting = projectionFalseEasting(options, defaults)
	const falseNorthing = projectionFalseNorthing(options, defaults)
	const yAxisDirection = projectionYAxisDirection(options, defaults)

	if (scale === undefined || falseEasting === undefined || falseNorthing === undefined || yAxisDirection === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	return fillPoint(out, falseEasting + x * scale, falseNorthing + y * ySign * scale)
}

function unprojectRawPoint(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const scale = projectionScale(options, defaults)
	const falseEasting = projectionFalseEasting(options, defaults)
	const falseNorthing = projectionFalseNorthing(options, defaults)
	const yAxisDirection = projectionYAxisDirection(options, defaults)

	if (scale === undefined || falseEasting === undefined || falseNorthing === undefined || yAxisDirection === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	return fillPoint(out, (x - falseEasting) / scale, ((y - falseNorthing) / scale) * ySign)
}

function rawLongitudeBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, xFactor: number, out?: Point) {
	const mode = projectionLongitudeWrapMode(options, defaults)

	if (mode === undefined || !Number.isFinite(xFactor)) return undefined
	if (mode === 'tau') return fillPoint(out, 0, TAU * xFactor)

	return fillPoint(out, -PI * xFactor, PI * xFactor)
}

function projectRawBounds(minX: number, maxX: number, minY: number, maxY: number, options?: ProjectionOptions, defaults?: ProjectionOptions): ProjectionBounds | undefined {
	const scale = projectionScale(options, defaults)
	const falseEasting = projectionFalseEasting(options, defaults)
	const falseNorthing = projectionFalseNorthing(options, defaults)
	const yAxisDirection = projectionYAxisDirection(options, defaults)

	if (scale === undefined || falseEasting === undefined || falseNorthing === undefined || yAxisDirection === undefined) return undefined
	if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	const scaledMinY = falseNorthing + minY * ySign * scale
	const scaledMaxY = falseNorthing + maxY * ySign * scale

	return {
		minX: falseEasting + minX * scale,
		maxX: falseEasting + maxX * scale,
		minY: Math.min(scaledMinY, scaledMaxY),
		maxY: Math.max(scaledMinY, scaledMaxY),
	}
}

function cylinderBounds(yMin: number, yMax: number, xFactor: number, options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const longitudeBounds = rawLongitudeBounds(options, defaults, xFactor)
	if (longitudeBounds === undefined) return undefined

	return projectRawBounds(longitudeBounds.x, longitudeBounds.y, yMin, yMax, options, defaults)
}

function centeredCylinderBounds(yMin: number, yMax: number, xFactor: number, options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const longitudeBounds = rawLongitudeBounds(options, defaults, xFactor)
	if (longitudeBounds === undefined) return undefined

	return projectRawBounds(longitudeBounds.x, longitudeBounds.y, yMin, yMax, options, defaults)
}

function unitValue(value: number, epsilon: number) {
	if (!Number.isFinite(value)) return undefined
	if (value < -1 - epsilon || value > 1 + epsilon) return undefined
	return clamp(value, -1, 1)
}

function azimuthalForward(lambda: number, phi: number, radialDistance: RadialDistance, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || latitudeOfOrigin === undefined || delta === undefined) return undefined

	const point = azimuthalRawProject(delta, latitude, latitudeOfOrigin, radialDistance, out)
	return point && projectRawPoint(point.x, point.y, options, defaults, out)
}

function azimuthalInverse(x: number, y: number, angularDistance: AngularDistance, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const point = unprojectRawPoint(x, y, options, defaults, out)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)

	if (point === undefined || latitudeOfOrigin === undefined) return undefined

	const spherical = azimuthalRawUnproject(point.x, point.y, latitudeOfOrigin, angularDistance, out)
	const longitude = spherical && projectionLongitudeFromDelta(spherical.x, options, defaults)

	return spherical === undefined || longitude === undefined ? undefined : fillPoint(out, longitude, spherical.y)
}

function azimuthalBounds(radius: number, options?: ProjectionOptions, defaults?: ProjectionOptions) {
	return projectRawBounds(-radius, radius, -radius, radius, options, defaults)
}

function equidistantCylindricalForward(lambda: number, phi: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const delta = projectionLongitudeDelta(lambda, options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (latitude === undefined || latitudeOfOrigin === undefined || delta === undefined || cosStandardParallel === undefined) return undefined

	return projectRawPoint(delta * cosStandardParallel, latitude - latitudeOfOrigin, options, defaults, out)
}

function equidistantCylindricalInverse(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const point = unprojectRawPoint(x, y, options, defaults, out)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (point === undefined || latitudeOfOrigin === undefined || cosStandardParallel === undefined) return undefined

	const latitude = inverseLatitudeInRange(point.y + latitudeOfOrigin, options, defaults, PIOVERTWO)
	const longitude = projectionLongitudeFromDelta(point.x / cosStandardParallel, options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : fillPoint(out, longitude, latitude)
}

function equidistantCylindricalBounds(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (latitudeOfOrigin === undefined || cosStandardParallel === undefined) return undefined

	return cylinderBounds(-PIOVERTWO - latitudeOfOrigin, PIOVERTWO - latitudeOfOrigin, cosStandardParallel, options, defaults)
}

function mercatorY(latitude: number) {
	return Math.asinh(Math.tan(latitude))
}

function mercatorForward(lambda: number, phi: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || delta === undefined) return undefined

	return projectRawPoint(delta, mercatorY(latitude), options, defaults, out)
}

function mercatorInverse(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const point = unprojectRawPoint(x, y, options, defaults, out)
	if (point === undefined) return undefined

	const latitude = inverseLatitudeInRange(Math.atan(Math.sinh(point.y)), options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	const longitude = projectionLongitudeFromDelta(point.x, options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : fillPoint(out, longitude, latitude)
}

function mercatorBounds(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const maxLatitude = projectionMaxLatitude(options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	if (maxLatitude === undefined) return undefined

	const y = mercatorY(maxLatitude)
	return centeredCylinderBounds(-y, y, 1, options, defaults)
}

function webMercatorForward(lambda: number, phi: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, WEB_MERCATOR_MAX_LATITUDE, true)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || delta === undefined) return undefined

	return projectRawPoint(delta, mercatorY(latitude), options, defaults, out)
}

function ellipsoidalMercatorY(latitude: number, eccentricity: number) {
	const sinLatitude = Math.sin(latitude)
	return Math.atanh(sinLatitude) - eccentricity * Math.atanh(eccentricity * sinLatitude)
}

function ellipsoidalMercatorInverseLatitude(y: number, eccentricity: number, options?: ProjectionOptions, defaults?: ProjectionOptions) {
	if (eccentricity === 0) return Math.atan(Math.sinh(y))

	const epsilon = projectionEpsilon(options, defaults)
	const maxIterations = projectionMaxIterations(options, defaults)

	if (epsilon === undefined || maxIterations === undefined) return undefined

	let latitude = Math.atan(Math.sinh(y))
	const eccentricitySquared = eccentricity * eccentricity

	for (let i = 0; i < maxIterations; i++) {
		const sinLatitude = Math.sin(latitude)
		const cosLatitude = Math.cos(latitude)
		const denominator = 1 - eccentricitySquared * sinLatitude * sinLatitude

		if (Math.abs(cosLatitude) <= epsilon || denominator <= 0) return undefined

		const residual = Math.atanh(sinLatitude) - eccentricity * Math.atanh(eccentricity * sinLatitude) - y
		const derivative = (1 - eccentricitySquared) / (cosLatitude * denominator)
		const step = residual / derivative
		latitude -= step

		if (Math.abs(step) <= epsilon) return clamp(latitude, -PIOVERTWO, PIOVERTWO)
	}

	return undefined
}

function ellipsoidalMercatorForward(lambda: number, phi: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)
	const eccentricity = projectionEccentricity(options, defaults)

	if (latitude === undefined || delta === undefined || eccentricity === undefined) return undefined

	return projectRawPoint(delta, ellipsoidalMercatorY(latitude, eccentricity), options, defaults, out)
}

function ellipsoidalMercatorInverse(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const point = unprojectRawPoint(x, y, options, defaults, out)
	const eccentricity = projectionEccentricity(options, defaults)

	if (point === undefined || eccentricity === undefined) return undefined

	const latitude = ellipsoidalMercatorInverseLatitude(point.y, eccentricity, options, defaults)
	const rangedLatitude = latitude === undefined ? undefined : inverseLatitudeInRange(latitude, options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	const longitude = projectionLongitudeFromDelta(point.x, options, defaults)

	return rangedLatitude === undefined || longitude === undefined ? undefined : fillPoint(out, longitude, rangedLatitude)
}

function ellipsoidalMercatorBounds(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const maxLatitude = projectionMaxLatitude(options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	const eccentricity = projectionEccentricity(options, defaults)

	if (maxLatitude === undefined || eccentricity === undefined) return undefined

	const y = ellipsoidalMercatorY(maxLatitude, eccentricity)
	return centeredCylinderBounds(-y, y, 1, options, defaults)
}

function millerY(latitude: number) {
	return 1.25 * Math.log(Math.tan(PI / 4 + 0.4 * latitude))
}

function millerForward(lambda: number, phi: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || delta === undefined) return undefined

	return projectRawPoint(delta, millerY(latitude), options, defaults, out)
}

function millerInverse(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const point = unprojectRawPoint(x, y, options, defaults, out)
	if (point === undefined) return undefined

	const latitude = inverseLatitudeInRange(2.5 * (Math.atan(Math.exp(0.8 * point.y)) - PI / 4), options, defaults, PIOVERTWO)
	const longitude = projectionLongitudeFromDelta(point.x, options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : fillPoint(out, longitude, latitude)
}

function millerBounds(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const maxLatitude = projectionMaxLatitude(options, defaults, PIOVERTWO)
	if (maxLatitude === undefined) return undefined

	const y = millerY(maxLatitude)
	return centeredCylinderBounds(-y, y, 1, options, defaults)
}

function centralCylindricalForward(lambda: number, phi: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || delta === undefined) return undefined

	return projectRawPoint(delta, Math.tan(latitude), options, defaults, out)
}

function centralCylindricalInverse(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const point = unprojectRawPoint(x, y, options, defaults, out)
	if (point === undefined) return undefined

	const latitude = inverseLatitudeInRange(Math.atan(point.y), options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	const longitude = projectionLongitudeFromDelta(point.x, options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : fillPoint(out, longitude, latitude)
}

function centralCylindricalBounds(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const maxLatitude = projectionMaxLatitude(options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	if (maxLatitude === undefined) return undefined

	const y = Math.tan(maxLatitude)
	return centeredCylinderBounds(-y, y, 1, options, defaults)
}

function cylindricalEqualAreaForward(lambda: number, phi: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const delta = projectionLongitudeDelta(lambda, options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (latitude === undefined || latitudeOfOrigin === undefined || delta === undefined || cosStandardParallel === undefined) return undefined

	return projectRawPoint(delta * cosStandardParallel, (Math.sin(latitude) - Math.sin(latitudeOfOrigin)) / cosStandardParallel, options, defaults, out)
}

function cylindricalEqualAreaInverse(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const point = unprojectRawPoint(x, y, options, defaults, out)
	const epsilon = projectionEpsilon(options, defaults)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (point === undefined || epsilon === undefined || latitudeOfOrigin === undefined || cosStandardParallel === undefined) return undefined

	const sinLatitude = unitValue(point.y * cosStandardParallel + Math.sin(latitudeOfOrigin), epsilon)
	const longitude = projectionLongitudeFromDelta(point.x / cosStandardParallel, options, defaults)

	return sinLatitude === undefined || longitude === undefined ? undefined : fillPoint(out, longitude, Math.asin(sinLatitude))
}

function cylindricalEqualAreaBounds(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const maxLatitude = projectionMaxLatitude(options, defaults, PIOVERTWO)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (maxLatitude === undefined || latitudeOfOrigin === undefined || cosStandardParallel === undefined) return undefined

	const origin = Math.sin(latitudeOfOrigin)
	return cylinderBounds((-Math.sin(maxLatitude) - origin) / cosStandardParallel, (Math.sin(maxLatitude) - origin) / cosStandardParallel, cosStandardParallel, options, defaults)
}

function cylindricalStereographicForward(lambda: number, phi: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (latitude === undefined || delta === undefined || cosStandardParallel === undefined) return undefined

	return projectRawPoint(delta * cosStandardParallel, (1 + cosStandardParallel) * Math.tan(latitude / 2), options, defaults, out)
}

function cylindricalStereographicInverse(x: number, y: number, options?: ProjectionOptions, defaults?: ProjectionOptions, out?: Point) {
	const point = unprojectRawPoint(x, y, options, defaults, out)
	const epsilon = projectionEpsilon(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (point === undefined || epsilon === undefined || cosStandardParallel === undefined) return undefined

	const yLimit = 1 + cosStandardParallel
	if (point.y < -yLimit - epsilon || point.y > yLimit + epsilon) return undefined

	const latitude = inverseLatitudeInRange(2 * Math.atan(clamp(point.y, -yLimit, yLimit) / yLimit), options, defaults, PIOVERTWO)
	const longitude = projectionLongitudeFromDelta(point.x / cosStandardParallel, options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : fillPoint(out, longitude, latitude)
}

function cylindricalStereographicBounds(options?: ProjectionOptions, defaults?: ProjectionOptions) {
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)
	if (cosStandardParallel === undefined) return undefined

	return cylinderBounds(-1 - cosStandardParallel, 1 + cosStandardParallel, cosStandardParallel, options, defaults)
}

export abstract class ProjectionBase implements Projection {
	constructor(protected readonly defaultOptions: ProjectionOptions = {}) {}

	abstract forward(lambda: number, phi: number, options?: ProjectionOptions, out?: Point): Point | undefined

	abstract inverse(x: number, y: number, options?: ProjectionOptions, out?: Point): Point | undefined

	abstract bounds(options?: ProjectionOptions): ProjectionBounds | undefined

	splitPolyline(points: readonly Point[], options?: ProjectionPolylineOptions) {
		return splitProjectionPolyline(this, points, options)
	}
}

abstract class AzimuthalProjectionBase extends ProjectionBase {
	constructor(defaultOptions: ProjectionOptions = {}) {
		super(defaultOptions)
	}

	protected abstract readonly radialDistance: RadialDistance
	protected abstract readonly angularDistance: AngularDistance
	protected abstract readonly boundRadius: number | undefined

	forward(lambda: number, phi: number, options?: ProjectionOptions, out?: Point) {
		return azimuthalForward(lambda, phi, this.radialDistance, options, this.defaultOptions, out)
	}

	inverse(x: number, y: number, options?: ProjectionOptions, out?: Point) {
		return azimuthalInverse(x, y, this.angularDistance, options, this.defaultOptions, out)
	}

	bounds(options?: ProjectionOptions) {
		return this.boundRadius === undefined ? undefined : azimuthalBounds(this.boundRadius, options, this.defaultOptions)
	}
}

export class Gnomonic extends AzimuthalProjectionBase {
	protected readonly radialDistance = gnomonicRadialDistance
	protected readonly angularDistance = Math.atan
	protected readonly boundRadius = undefined

	static readonly default = new Gnomonic()
}

export class Stereographic extends AzimuthalProjectionBase {
	protected readonly radialDistance = stereographicRadialDistance
	protected readonly angularDistance = stereographicAngularDistance
	protected readonly boundRadius = undefined

	static readonly default = new Stereographic()
}

export class Orthographic extends AzimuthalProjectionBase {
	protected readonly radialDistance = orthographicRadialDistance
	protected readonly angularDistance = orthographicAngularDistance
	protected readonly boundRadius = 1

	static readonly default = new Orthographic()
}

export class LambertAzimuthalEqualArea extends AzimuthalProjectionBase {
	protected readonly radialDistance = lambertAzimuthalEqualAreaRadialDistance
	protected readonly angularDistance = lambertAzimuthalEqualAreaAngularDistance
	protected readonly boundRadius = 2

	static readonly default = new LambertAzimuthalEqualArea()
}

export class AzimuthalEquidistant extends AzimuthalProjectionBase {
	protected readonly radialDistance = azimuthalEquidistantRadialDistance
	protected readonly angularDistance = azimuthalEquidistantAngularDistance
	protected readonly boundRadius = PI

	static readonly default = new AzimuthalEquidistant()
}

export abstract class CylindricalProjectionBase extends ProjectionBase {
	constructor(defaultOptions: ProjectionOptions = {}) {
		super(defaultOptions)
	}

	protected abstract readonly cylindricalProject: typeof projectRawPoint
	protected abstract readonly cylindricalUnproject: typeof unprojectRawPoint
	protected abstract readonly cylindricalBounds: typeof cylindricalEqualAreaBounds

	forward(lambda: number, phi: number, options?: ProjectionOptions, out?: Point) {
		return this.cylindricalProject(lambda, phi, options, this.defaultOptions, out)
	}

	inverse(x: number, y: number, options?: ProjectionOptions, out?: Point) {
		return this.cylindricalUnproject(x, y, options, this.defaultOptions, out)
	}

	bounds(options?: ProjectionOptions) {
		return this.cylindricalBounds(options, this.defaultOptions)
	}
}

export class CylindricalEqualArea extends CylindricalProjectionBase {
	protected readonly cylindricalProject = cylindricalEqualAreaForward
	protected readonly cylindricalUnproject = cylindricalEqualAreaInverse
	protected readonly cylindricalBounds = cylindricalEqualAreaBounds

	constructor(readonly standardParallel1?: number) {
		super({ standardParallel1 })
	}

	static readonly lambertCylindricalEqualArea = new CylindricalEqualArea(0)
	static readonly behrmann = new CylindricalEqualArea(PI / 6)
	static readonly gallPeters = new CylindricalEqualArea(PI / 4)
	static readonly hoboDyer = new CylindricalEqualArea(37.5 * DEG2RAD)
	static readonly balthasart = new CylindricalEqualArea(50 * DEG2RAD)
	static readonly trystanEdwards = new CylindricalEqualArea(TRYSTAN_EDWARDS_STANDARD_PARALLEL)
}

export class CylindricalStereographic extends CylindricalProjectionBase {
	protected readonly cylindricalProject = cylindricalStereographicForward
	protected readonly cylindricalUnproject = cylindricalStereographicInverse
	protected readonly cylindricalBounds = cylindricalStereographicBounds

	constructor(readonly standardParallel1?: number) {
		super({ standardParallel1 })
	}

	static readonly gall = new CylindricalStereographic(PI / 4)
	static readonly braun = new CylindricalStereographic(0)
}

export class CylindricalEquidistant extends CylindricalProjectionBase {
	protected readonly cylindricalProject = equidistantCylindricalForward
	protected readonly cylindricalUnproject = equidistantCylindricalInverse
	protected readonly cylindricalBounds = equidistantCylindricalBounds

	constructor(readonly standardParallel1?: number) {
		super({ standardParallel1 })
	}

	static readonly default = new CylindricalEquidistant()
	static readonly plateCarree = new CylindricalEquidistant(0) // simpleCylindrical
}

export class Mercator extends CylindricalProjectionBase {
	protected readonly cylindricalProject = mercatorForward
	protected readonly cylindricalUnproject = mercatorInverse
	protected readonly cylindricalBounds = mercatorBounds

	static readonly default = new Mercator()
}

const DEFAULT_WEB_MERCATOR_PROJECTION_OPTIONS: ProjectionOptions = { clampLatitude: true, maxLatitude: WEB_MERCATOR_MAX_LATITUDE }

export class WebMercator extends Mercator {
	protected readonly cylindricalProject = webMercatorForward
	protected readonly cylindricalUnproject = mercatorInverse
	protected readonly cylindricalBounds = mercatorBounds

	constructor() {
		super(DEFAULT_WEB_MERCATOR_PROJECTION_OPTIONS)
	}

	static readonly default = new WebMercator()
}

export class EllipsoidalMercator extends CylindricalProjectionBase {
	protected readonly cylindricalProject = ellipsoidalMercatorForward
	protected readonly cylindricalUnproject = ellipsoidalMercatorInverse
	protected readonly cylindricalBounds = ellipsoidalMercatorBounds

	constructor(eccentricity?: number) {
		super({ eccentricity })
	}

	static readonly default = new EllipsoidalMercator()
}

export class Miller extends CylindricalProjectionBase {
	protected readonly cylindricalProject = millerForward
	protected readonly cylindricalUnproject = millerInverse
	protected readonly cylindricalBounds = millerBounds

	static readonly default = new Miller()
}

export class CentralCylindrical extends CylindricalProjectionBase {
	protected readonly cylindricalProject = centralCylindricalForward
	protected readonly cylindricalUnproject = centralCylindricalInverse
	protected readonly cylindricalBounds = centralCylindricalBounds

	static readonly default = new CentralCylindrical()
}

// Projects longitude and latitude with a registered projection.
export function projectLonLat(projection: Projection, lambda: number, phi: number, options?: ProjectionOptions, out?: Point) {
	return projection.forward(lambda, phi, options, out)
}

// Unprojects plane coordinates into longitude and latitude.
export function unprojectLonLat(projection: Projection, x: number, y: number, options?: ProjectionOptions, out?: Point) {
	return projection.inverse(x, y, options, out)
}

// Projects an array of spherical points into a flat x/y buffer.
export function projectLonLatBatch(projection: Projection, points: readonly Point[], options?: ProjectionOptions, out: Point[] = []) {
	out.length = points.length

	for (let i = 0; i < points.length; i++) {
		const projected = projection.forward(points[i].x, points[i].y, options, out[i])
		if (projected === undefined) return undefined
		out[i] = projected
	}

	return out
}

function shouldSplitLongitude(a: Point, b: Point, options?: ProjectionPolylineOptions, defaults?: ProjectionOptions) {
	const splitLongitudeGap = options?.splitLongitudeGap ?? PI
	const aDelta = projectionLongitudeDelta(a.x, options, defaults)
	const bDelta = projectionLongitudeDelta(b.x, options, defaults)

	if (!Number.isFinite(splitLongitudeGap) || splitLongitudeGap <= 0 || aDelta === undefined || bDelta === undefined) return undefined

	return Math.abs(bDelta - aDelta) > splitLongitudeGap
}

function densifiedPoint(a: Point, b: Point, step: number, steps: number, out?: Point) {
	const dLongitude = normalizePI(b.x - a.x)
	const t = step / steps
	return fillPoint(out, a.x + dLongitude * t, a.y + (b.y - a.y) * t)
}

// Splits projected polylines at anti-meridian wraps, singularities, and large jumps.
export function splitProjectionPolyline(projection: Projection, points: readonly Point[], options?: ProjectionPolylineOptions): Point[][] {
	if (points.length === 0) return []

	const lines: Point[][] = []
	let current: Point[] = []
	let previousProjected: Point | undefined
	let previousPoint: Point | undefined
	const maxSegmentRadians = options?.maxSegmentRadians
	const discontinuityThreshold = options?.discontinuityThreshold
	const p: Point = { x: 0, y: 0 }

	for (let i = 0; i < points.length; i++) {
		const target = points[i]
		const segmentSteps = previousPoint !== undefined && maxSegmentRadians !== undefined && Number.isFinite(maxSegmentRadians) && maxSegmentRadians > 0 ? Math.max(1, Math.ceil(Math.max(Math.abs(normalizePI(target.x - previousPoint.x)), Math.abs(target.y - previousPoint.y)) / maxSegmentRadians)) : 1

		for (let step = 1; step <= segmentSteps; step++) {
			const point = previousPoint === undefined || step === segmentSteps ? target : densifiedPoint(previousPoint, target, step, segmentSteps, p)
			const splitLongitude = previousPoint !== undefined && step === 1 && shouldSplitLongitude(previousPoint, point, options, undefined)
			const projected = projection.forward(point.x, point.y, options)
			const splitDiscontinuity = previousProjected !== undefined && projected !== undefined && discontinuityThreshold !== undefined && Number.isFinite(discontinuityThreshold) && discontinuityThreshold > 0 && euclideanDistance(previousProjected, projected) > discontinuityThreshold

			if (splitLongitude || projected === undefined || splitDiscontinuity) {
				if (current.length > 0) lines.push(current)
				current = []
				previousProjected = undefined
			}

			if (projected !== undefined) {
				current.push(projected)
				previousProjected = projected
			}
		}

		previousPoint = target
	}

	if (current.length > 0) lines.push(current)

	return lines
}

// Projects polygon rings, preserving splits caused by longitude wraps or projection domains.
export function projectPolygon(projection: Projection, rings: readonly (readonly Point[])[], options?: ProjectionPolylineOptions) {
	const projected: Point[][][] = []
	for (let i = 0; i < rings.length; i++) projected.push(splitProjectionPolyline(projection, rings[i], options))
	return projected
}
