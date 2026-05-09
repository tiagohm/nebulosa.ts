import { normalizeAngle, normalizePI } from './angle'
import { DEG2RAD, PI, PIOVERTWO, TAU } from './constants'
import type { Point } from './geometry'
import { clamp } from './math'

type RadialDistance = (sinC: number, cosC: number) => number | false

type AngularDistance = (rho: number) => number | false

export type LongitudeWrapMode = 'pi' | 'tau' | 'none'

export type RaAxisDirection = 'east' | 'west'

export type YAxisDirection = 'northUp' | 'southUp'

export type SphericalPoint = readonly [lambda: number, phi: number]

export type ProjectedPoint = readonly [x: number, y: number]

export interface ProjectionEquidistantAxes {
	readonly meridians?: boolean
	readonly parallels?: boolean
	readonly standardParallels?: boolean
}

export interface ProjectionProperties {
	readonly conformal: boolean
	readonly equalArea: boolean
	readonly equidistant: boolean | ProjectionEquidistantAxes
	readonly hasInverse: boolean
	readonly preservesStraightParallels: boolean
	readonly preservesStraightMeridians: boolean
	readonly finiteWorldExtent: boolean
}

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
	readonly properties: ProjectionProperties
	readonly forward: (lambda: number, phi: number, options?: ProjectionOptions) => ProjectedPoint | undefined
	readonly inverse: (x: number, y: number, options?: ProjectionOptions) => SphericalPoint | undefined
	readonly bounds: (options?: ProjectionOptions) => ProjectionBounds | undefined
	readonly canProject: (lambda: number, phi: number, options?: ProjectionOptions) => boolean
	readonly splitPolyline: (points: readonly SphericalPoint[], options?: ProjectionPolylineOptions) => ProjectedPoint[][]
}

// Projects a spherical point using a radial azimuthal scaling law.
function azimuthalProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, radialDistance: RadialDistance, out?: Point): Point | false {
	const dLongitude = normalizePI(longitude - centerLongitude)
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
		if (cosC < 0) return false

		out ??= { x: 0, y: 0 }
		out.x = 0
		out.y = 0
		return out
	}

	const rho = radialDistance(sinC, cosC)

	if (rho === false) return false

	const scale = rho / sinC
	out ??= { x: 0, y: 0 }
	out.x = x * scale
	out.y = y * scale
	return out
}

// Unprojects azimuthal plane coordinates using the inverse radial law.
function azimuthalUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number, angularDistance: AngularDistance) {
	if (x === 0 && y === 0) return [normalizeAngle(centerLongitude), centerLatitude] as const

	const rho = Math.hypot(x, y)
	const c = angularDistance(rho)

	if (c === false) return false

	const sinC = Math.sin(c)
	const cosC = Math.cos(c)
	const sinCenterLatitude = Math.sin(centerLatitude)
	const cosCenterLatitude = Math.cos(centerLatitude)
	const latitude = Math.asin(clamp(cosC * sinCenterLatitude + (y * sinC * cosCenterLatitude) / rho, -1, 1))
	const longitude = normalizeAngle(centerLongitude + Math.atan2(x * sinC, rho * cosCenterLatitude * cosC - y * sinCenterLatitude * sinC))
	return [longitude, latitude] as const
}

function gnomonicRadialDistance(sinC: number, cosC: number) {
	return cosC <= 0 ? false : sinC / cosC
}

// Projects a spherical point onto a tangent plane using the gnomonic projection.
export function gnomonicProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point): Point | false {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, gnomonicRadialDistance, out)
}

// Unprojects tangent-plane coordinates into spherical coordinates using the gnomonic projection.
export function gnomonicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, Math.atan)
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
export function stereographicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, stereographicAngularDistance)
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
export function orthographicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, orthographicAngularDistance)
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
export function lambertAzimuthalEqualAreaUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, lambertAzimuthalEqualAreaAngularDistance)
}

function azimuthalEquidistantRadialDistance(sinC: number, cosC: number) {
	return sinC <= Number.EPSILON && cosC < 0 ? false : Math.atan2(sinC, cosC)
}

function azimuthalEquidistantAngularDistance(rho: number) {
	return rho > Math.PI + Number.EPSILON ? false : rho
}

// Projects a spherical point preserving distance from the center with the azimuthal equidistant projection.
export function azimuthalEquidistantProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point): Point | false {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, azimuthalEquidistantRadialDistance, out)
}

// Unprojects azimuthal-equidistant plane coordinates into spherical coordinates.
export function azimuthalEquidistantUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, azimuthalEquidistantAngularDistance)
}

type NumberProjectionOption = 'centralMeridian' | 'latitudeOfOrigin' | 'standardParallel1' | 'standardParallel2' | 'scale' | 'radius' | 'falseEasting' | 'falseNorthing' | 'eccentricity' | 'flattening' | 'maxLatitude' | 'epsilon' | 'maxIterations'

const DEFAULT_PROJECTION_EPSILON = 1e-12
const DEFAULT_RADIUS = 1
const DEFAULT_SCALE = 1
const DEFAULT_FALSE_OFFSET = 0
const DEFAULT_MAX_MERCATOR_LATITUDE = PIOVERTWO - DEFAULT_PROJECTION_EPSILON

// The Web Mercator limit maps to y = +/-PI in normalized projection units.
export const WEB_MERCATOR_MAX_LATITUDE = Math.atan(Math.sinh(PI))

const TRYSTAN_EDWARDS_STANDARD_PARALLEL = 37.4 * DEG2RAD

const CYLINDRICAL_EQUIDISTANT_PROPERTIES: ProjectionProperties = {
	conformal: false,
	equalArea: false,
	equidistant: { meridians: true, standardParallels: true },
	hasInverse: true,
	preservesStraightParallels: true,
	preservesStraightMeridians: true,
	finiteWorldExtent: true,
}

const MERCATOR_PROPERTIES: ProjectionProperties = {
	conformal: true,
	equalArea: false,
	equidistant: false,
	hasInverse: true,
	preservesStraightParallels: true,
	preservesStraightMeridians: true,
	finiteWorldExtent: false,
}

const WEB_MERCATOR_PROPERTIES: ProjectionProperties = {
	conformal: false,
	equalArea: false,
	equidistant: false,
	hasInverse: true,
	preservesStraightParallels: true,
	preservesStraightMeridians: true,
	finiteWorldExtent: true,
}

const CYLINDRICAL_EQUAL_AREA_PROPERTIES: ProjectionProperties = {
	conformal: false,
	equalArea: true,
	equidistant: false,
	hasInverse: true,
	preservesStraightParallels: true,
	preservesStraightMeridians: true,
	finiteWorldExtent: true,
}

const CYLINDRICAL_STEREOGRAPHIC_PROPERTIES: ProjectionProperties = {
	conformal: false,
	equalArea: false,
	equidistant: false,
	hasInverse: true,
	preservesStraightParallels: true,
	preservesStraightMeridians: true,
	finiteWorldExtent: true,
}

const MILLER_PROPERTIES: ProjectionProperties = {
	conformal: false,
	equalArea: false,
	equidistant: false,
	hasInverse: true,
	preservesStraightParallels: true,
	preservesStraightMeridians: true,
	finiteWorldExtent: true,
}

const CENTRAL_CYLINDRICAL_PROPERTIES: ProjectionProperties = {
	conformal: false,
	equalArea: false,
	equidistant: false,
	hasInverse: true,
	preservesStraightParallels: true,
	preservesStraightMeridians: true,
	finiteWorldExtent: false,
}

function optionNumber(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, key: NumberProjectionOption, fallback: number) {
	return options?.[key] ?? defaults?.[key] ?? fallback
}

function optionBoolean(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, key: 'clampLatitude' | 'sphericalOnly' | 'allowInvalidOutsideDomain', fallback: boolean) {
	return options?.[key] ?? defaults?.[key] ?? fallback
}

function projectionEpsilon(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const epsilon = optionNumber(options, defaults, 'epsilon', DEFAULT_PROJECTION_EPSILON)
	return Number.isFinite(epsilon) && epsilon > 0 ? epsilon : undefined
}

function projectionScale(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const radius = optionNumber(options, defaults, 'radius', DEFAULT_RADIUS)
	const scale = optionNumber(options, defaults, 'scale', DEFAULT_SCALE)

	if (!Number.isFinite(radius) || !Number.isFinite(scale) || radius <= 0 || scale <= 0) return undefined

	return radius * scale
}

function projectionFalseEasting(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const falseEasting = optionNumber(options, defaults, 'falseEasting', DEFAULT_FALSE_OFFSET)
	return Number.isFinite(falseEasting) ? falseEasting : undefined
}

function projectionFalseNorthing(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const falseNorthing = optionNumber(options, defaults, 'falseNorthing', DEFAULT_FALSE_OFFSET)
	return Number.isFinite(falseNorthing) ? falseNorthing : undefined
}

function projectionLongitudeWrapMode(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const mode = options?.longitudeWrapMode ?? defaults?.longitudeWrapMode ?? 'pi'
	return mode === 'pi' || mode === 'tau' || mode === 'none' ? mode : undefined
}

function projectionRaAxisDirection(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const direction = options?.raAxisDirection ?? defaults?.raAxisDirection ?? 'east'
	return direction === 'east' || direction === 'west' ? direction : undefined
}

function projectionYAxisDirection(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const direction = options?.yAxisDirection ?? defaults?.yAxisDirection ?? 'northUp'
	return direction === 'northUp' || direction === 'southUp' ? direction : undefined
}

function normalizeLongitudeByMode(longitude: number, mode: LongitudeWrapMode) {
	if (mode === 'none') return longitude
	return mode === 'tau' ? normalizeAngle(longitude) : normalizePI(longitude)
}

function projectionLongitudeDelta(lambda: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const centralMeridian = optionNumber(options, defaults, 'centralMeridian', 0)
	const mode = projectionLongitudeWrapMode(options, defaults)
	const direction = projectionRaAxisDirection(options, defaults)

	if (!Number.isFinite(lambda) || !Number.isFinite(centralMeridian) || mode === undefined || direction === undefined) return undefined

	const delta = direction === 'west' ? centralMeridian - lambda : lambda - centralMeridian
	return normalizeLongitudeByMode(delta, mode)
}

function projectionLongitudeFromDelta(delta: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
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

function projectionEccentricity(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
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

function projectionMaxIterations(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const maxIterations = optionNumber(options, defaults, 'maxIterations', 12)
	return Number.isFinite(maxIterations) && maxIterations >= 1 ? Math.floor(maxIterations) : undefined
}

function projectRawPoint(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined): ProjectedPoint | undefined {
	const scale = projectionScale(options, defaults)
	const falseEasting = projectionFalseEasting(options, defaults)
	const falseNorthing = projectionFalseNorthing(options, defaults)
	const yAxisDirection = projectionYAxisDirection(options, defaults)

	if (scale === undefined || falseEasting === undefined || falseNorthing === undefined || yAxisDirection === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	return [falseEasting + x * scale, falseNorthing + y * ySign * scale] as const
}

function unprojectRawPoint(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined): ProjectedPoint | undefined {
	const scale = projectionScale(options, defaults)
	const falseEasting = projectionFalseEasting(options, defaults)
	const falseNorthing = projectionFalseNorthing(options, defaults)
	const yAxisDirection = projectionYAxisDirection(options, defaults)

	if (scale === undefined || falseEasting === undefined || falseNorthing === undefined || yAxisDirection === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	return [(x - falseEasting) / scale, ((y - falseNorthing) / scale) * ySign] as const
}

function rawLongitudeBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined, xFactor: number) {
	const mode = projectionLongitudeWrapMode(options, defaults)

	if (mode === undefined || !Number.isFinite(xFactor)) return undefined
	if (mode === 'tau') return [0, TAU * xFactor] as const

	return [-PI * xFactor, PI * xFactor] as const
}

function projectRawBounds(minX: number, maxX: number, minY: number, maxY: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined): ProjectionBounds | undefined {
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

function cylinderBounds(yMin: number, yMax: number, xFactor: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const longitudeBounds = rawLongitudeBounds(options, defaults, xFactor)
	if (longitudeBounds === undefined) return undefined

	return projectRawBounds(longitudeBounds[0], longitudeBounds[1], yMin, yMax, options, defaults)
}

function centeredCylinderBounds(yMin: number, yMax: number, xFactor: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const longitudeBounds = rawLongitudeBounds(options, defaults, xFactor)
	if (longitudeBounds === undefined) return undefined

	return projectRawBounds(longitudeBounds[0], longitudeBounds[1], yMin, yMax, options, defaults)
}

function unitValue(value: number, epsilon: number) {
	if (!Number.isFinite(value)) return undefined
	if (value < -1 - epsilon || value > 1 + epsilon) return undefined
	return clamp(value, -1, 1)
}

function equidistantCylindricalForward(lambda: number, phi: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const delta = projectionLongitudeDelta(lambda, options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (latitude === undefined || latitudeOfOrigin === undefined || delta === undefined || cosStandardParallel === undefined) return undefined

	return projectRawPoint(delta * cosStandardParallel, latitude - latitudeOfOrigin, options, defaults)
}

function equidistantCylindricalInverse(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const point = unprojectRawPoint(x, y, options, defaults)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (point === undefined || latitudeOfOrigin === undefined || cosStandardParallel === undefined) return undefined

	const latitude = inverseLatitudeInRange(point[1] + latitudeOfOrigin, options, defaults, PIOVERTWO)
	const longitude = projectionLongitudeFromDelta(point[0] / cosStandardParallel, options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : ([longitude, latitude] as const)
}

function equidistantCylindricalBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (latitudeOfOrigin === undefined || cosStandardParallel === undefined) return undefined

	return cylinderBounds(-PIOVERTWO - latitudeOfOrigin, PIOVERTWO - latitudeOfOrigin, cosStandardParallel, options, defaults)
}

function mercatorY(latitude: number) {
	return Math.asinh(Math.tan(latitude))
}

function mercatorForward(lambda: number, phi: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitude = projectionLatitude(phi, options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || delta === undefined) return undefined

	return projectRawPoint(delta, mercatorY(latitude), options, defaults)
}

function mercatorInverse(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const point = unprojectRawPoint(x, y, options, defaults)
	if (point === undefined) return undefined

	const latitude = inverseLatitudeInRange(Math.atan(Math.sinh(point[1])), options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	const longitude = projectionLongitudeFromDelta(point[0], options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : ([longitude, latitude] as const)
}

function mercatorBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const maxLatitude = projectionMaxLatitude(options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	if (maxLatitude === undefined) return undefined

	const y = mercatorY(maxLatitude)
	return centeredCylinderBounds(-y, y, 1, options, defaults)
}

function webMercatorForward(lambda: number, phi: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitude = projectionLatitude(phi, options, defaults, WEB_MERCATOR_MAX_LATITUDE, true)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || delta === undefined) return undefined

	return projectRawPoint(delta, mercatorY(latitude), options, defaults)
}

function ellipsoidalMercatorY(latitude: number, eccentricity: number) {
	const sinLatitude = Math.sin(latitude)
	return Math.atanh(sinLatitude) - eccentricity * Math.atanh(eccentricity * sinLatitude)
}

function ellipsoidalMercatorInverseLatitude(y: number, eccentricity: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
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

function ellipsoidalMercatorForward(lambda: number, phi: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitude = projectionLatitude(phi, options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)
	const eccentricity = projectionEccentricity(options, defaults)

	if (latitude === undefined || delta === undefined || eccentricity === undefined) return undefined

	return projectRawPoint(delta, ellipsoidalMercatorY(latitude, eccentricity), options, defaults)
}

function ellipsoidalMercatorInverse(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const point = unprojectRawPoint(x, y, options, defaults)
	const eccentricity = projectionEccentricity(options, defaults)

	if (point === undefined || eccentricity === undefined) return undefined

	const latitude = ellipsoidalMercatorInverseLatitude(point[1], eccentricity, options, defaults)
	const rangedLatitude = latitude === undefined ? undefined : inverseLatitudeInRange(latitude, options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	const longitude = projectionLongitudeFromDelta(point[0], options, defaults)

	return rangedLatitude === undefined || longitude === undefined ? undefined : ([longitude, rangedLatitude] as const)
}

function ellipsoidalMercatorBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const maxLatitude = projectionMaxLatitude(options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	const eccentricity = projectionEccentricity(options, defaults)

	if (maxLatitude === undefined || eccentricity === undefined) return undefined

	const y = ellipsoidalMercatorY(maxLatitude, eccentricity)
	return centeredCylinderBounds(-y, y, 1, options, defaults)
}

function millerY(latitude: number) {
	return 1.25 * Math.log(Math.tan(PI / 4 + 0.4 * latitude))
}

function millerForward(lambda: number, phi: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || delta === undefined) return undefined

	return projectRawPoint(delta, millerY(latitude), options, defaults)
}

function millerInverse(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const point = unprojectRawPoint(x, y, options, defaults)
	if (point === undefined) return undefined

	const latitude = inverseLatitudeInRange(2.5 * (Math.atan(Math.exp(0.8 * point[1])) - PI / 4), options, defaults, PIOVERTWO)
	const longitude = projectionLongitudeFromDelta(point[0], options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : ([longitude, latitude] as const)
}

function millerBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const maxLatitude = projectionMaxLatitude(options, defaults, PIOVERTWO)
	if (maxLatitude === undefined) return undefined

	const y = millerY(maxLatitude)
	return centeredCylinderBounds(-y, y, 1, options, defaults)
}

function centralCylindricalForward(lambda: number, phi: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitude = projectionLatitude(phi, options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)

	if (latitude === undefined || delta === undefined) return undefined

	return projectRawPoint(delta, Math.tan(latitude), options, defaults)
}

function centralCylindricalInverse(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const point = unprojectRawPoint(x, y, options, defaults)
	if (point === undefined) return undefined

	const latitude = inverseLatitudeInRange(Math.atan(point[1]), options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	const longitude = projectionLongitudeFromDelta(point[0], options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : ([longitude, latitude] as const)
}

function centralCylindricalBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const maxLatitude = projectionMaxLatitude(options, defaults, DEFAULT_MAX_MERCATOR_LATITUDE)
	if (maxLatitude === undefined) return undefined

	const y = Math.tan(maxLatitude)
	return centeredCylinderBounds(-y, y, 1, options, defaults)
}

function cylindricalEqualAreaForward(lambda: number, phi: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const delta = projectionLongitudeDelta(lambda, options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (latitude === undefined || latitudeOfOrigin === undefined || delta === undefined || cosStandardParallel === undefined) return undefined

	return projectRawPoint(delta * cosStandardParallel, (Math.sin(latitude) - Math.sin(latitudeOfOrigin)) / cosStandardParallel, options, defaults)
}

function cylindricalEqualAreaInverse(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const point = unprojectRawPoint(x, y, options, defaults)
	const epsilon = projectionEpsilon(options, defaults)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (point === undefined || epsilon === undefined || latitudeOfOrigin === undefined || cosStandardParallel === undefined) return undefined

	const sinLatitude = unitValue(point[1] * cosStandardParallel + Math.sin(latitudeOfOrigin), epsilon)
	const longitude = projectionLongitudeFromDelta(point[0] / cosStandardParallel, options, defaults)

	return sinLatitude === undefined || longitude === undefined ? undefined : ([longitude, Math.asin(sinLatitude)] as const)
}

function cylindricalEqualAreaBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const maxLatitude = projectionMaxLatitude(options, defaults, PIOVERTWO)
	const latitudeOfOrigin = projectionLatitudeOfOrigin(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (maxLatitude === undefined || latitudeOfOrigin === undefined || cosStandardParallel === undefined) return undefined

	const origin = Math.sin(latitudeOfOrigin)
	return cylinderBounds((-Math.sin(maxLatitude) - origin) / cosStandardParallel, (Math.sin(maxLatitude) - origin) / cosStandardParallel, cosStandardParallel, options, defaults)
}

function cylindricalStereographicForward(lambda: number, phi: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const latitude = projectionLatitude(phi, options, defaults, PIOVERTWO, false)
	const delta = projectionLongitudeDelta(lambda, options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (latitude === undefined || delta === undefined || cosStandardParallel === undefined) return undefined

	return projectRawPoint(delta * cosStandardParallel, (1 + cosStandardParallel) * Math.tan(latitude / 2), options, defaults)
}

function cylindricalStereographicInverse(x: number, y: number, options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const point = unprojectRawPoint(x, y, options, defaults)
	const epsilon = projectionEpsilon(options, defaults)
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)

	if (point === undefined || epsilon === undefined || cosStandardParallel === undefined) return undefined

	const yLimit = 1 + cosStandardParallel
	if (point[1] < -yLimit - epsilon || point[1] > yLimit + epsilon) return undefined

	const latitude = inverseLatitudeInRange(2 * Math.atan(clamp(point[1], -yLimit, yLimit) / yLimit), options, defaults, PIOVERTWO)
	const longitude = projectionLongitudeFromDelta(point[0] / cosStandardParallel, options, defaults)

	return latitude === undefined || longitude === undefined ? undefined : ([longitude, latitude] as const)
}

function cylindricalStereographicBounds(options: ProjectionOptions | undefined, defaults: ProjectionOptions | undefined) {
	const cosStandardParallel = projectionStandardParallelCos(options, defaults, 0)
	if (cosStandardParallel === undefined) return undefined

	return cylinderBounds(-1 - cosStandardParallel, 1 + cosStandardParallel, cosStandardParallel, options, defaults)
}

export abstract class ProjectionBase implements Projection {
	abstract readonly properties: ProjectionProperties

	constructor(protected readonly defaultOptions: ProjectionOptions = {}) {}

	abstract forward(lambda: number, phi: number, options?: ProjectionOptions): ProjectedPoint | undefined

	abstract inverse(x: number, y: number, options?: ProjectionOptions): SphericalPoint | undefined

	abstract bounds(options?: ProjectionOptions): ProjectionBounds | undefined

	canProject(lambda: number, phi: number, options?: ProjectionOptions) {
		return this.forward(lambda, phi, options) !== undefined
	}

	splitPolyline(points: readonly SphericalPoint[], options?: ProjectionPolylineOptions) {
		return splitProjectionPolyline(this, points, options)
	}
}

export class CylindricalEqualArea extends ProjectionBase {
	readonly properties = CYLINDRICAL_EQUAL_AREA_PROPERTIES

	constructor(readonly standardParallel1?: number) {
		super({ standardParallel1 })
	}

	forward(lambda: number, phi: number, options?: ProjectionOptions) {
		return cylindricalEqualAreaForward(lambda, phi, options, this.defaultOptions)
	}

	inverse(x: number, y: number, options?: ProjectionOptions) {
		return cylindricalEqualAreaInverse(x, y, options, this.defaultOptions)
	}

	bounds(options?: ProjectionOptions) {
		return cylindricalEqualAreaBounds(options, this.defaultOptions)
	}

	static readonly lambertCylindricalEqualArea = new CylindricalEqualArea(0)
	static readonly behrmann = new CylindricalEqualArea(PI / 6)
	static readonly gallPeters = new CylindricalEqualArea(PI / 4)
	static readonly hoboDyer = new CylindricalEqualArea(37.5 * DEG2RAD)
	static readonly balthasart = new CylindricalEqualArea(50 * DEG2RAD)
	static readonly trystanEdwards = new CylindricalEqualArea(TRYSTAN_EDWARDS_STANDARD_PARALLEL)
}

export class CylindricalStereographic extends ProjectionBase {
	readonly properties = CYLINDRICAL_STEREOGRAPHIC_PROPERTIES

	constructor(readonly standardParallel1?: number) {
		super({ standardParallel1 })
	}

	forward(lambda: number, phi: number, options?: ProjectionOptions) {
		return cylindricalStereographicForward(lambda, phi, options, this.defaultOptions)
	}

	inverse(x: number, y: number, options?: ProjectionOptions) {
		return cylindricalStereographicInverse(x, y, options, this.defaultOptions)
	}

	bounds(options?: ProjectionOptions) {
		return cylindricalStereographicBounds(options, this.defaultOptions)
	}

	static readonly gall = new CylindricalStereographic(PI / 4)
	static readonly braun = new CylindricalStereographic(0)
}

export class CylindricalEquidistant extends ProjectionBase {
	readonly properties = CYLINDRICAL_EQUIDISTANT_PROPERTIES

	constructor(readonly standardParallel1?: number) {
		super({ standardParallel1 })
	}

	forward(lambda: number, phi: number, options?: ProjectionOptions) {
		return equidistantCylindricalForward(lambda, phi, options, this.defaultOptions)
	}

	inverse(x: number, y: number, options?: ProjectionOptions) {
		return equidistantCylindricalInverse(x, y, options, this.defaultOptions)
	}

	bounds(options?: ProjectionOptions) {
		return equidistantCylindricalBounds(options, this.defaultOptions)
	}

	static readonly default = new CylindricalEquidistant()
	static readonly plateCarree = new CylindricalEquidistant(0) // simpleCylindrical
}

export class Mercator extends ProjectionBase {
	readonly properties = MERCATOR_PROPERTIES

	forward(lambda: number, phi: number, options?: ProjectionOptions) {
		return mercatorForward(lambda, phi, options, this.defaultOptions)
	}

	inverse(x: number, y: number, options?: ProjectionOptions) {
		return mercatorInverse(x, y, options, this.defaultOptions)
	}

	bounds(options?: ProjectionOptions) {
		return mercatorBounds(options, this.defaultOptions)
	}

	static readonly default = new Mercator()
}

export class WebMercator extends Mercator {
	readonly properties = WEB_MERCATOR_PROPERTIES

	constructor() {
		super({ clampLatitude: true, maxLatitude: WEB_MERCATOR_MAX_LATITUDE })
	}

	forward(lambda: number, phi: number, options?: ProjectionOptions) {
		return webMercatorForward(lambda, phi, options, this.defaultOptions)
	}

	static readonly default = new WebMercator()
}

export class EllipsoidalMercator extends ProjectionBase {
	readonly properties = MERCATOR_PROPERTIES

	constructor(eccentricity?: number) {
		super({ eccentricity })
	}

	forward(lambda: number, phi: number, options?: ProjectionOptions) {
		return ellipsoidalMercatorForward(lambda, phi, options, this.defaultOptions)
	}

	inverse(x: number, y: number, options?: ProjectionOptions) {
		return ellipsoidalMercatorInverse(x, y, options, this.defaultOptions)
	}

	bounds(options?: ProjectionOptions) {
		return ellipsoidalMercatorBounds(options, this.defaultOptions)
	}

	static readonly default = new EllipsoidalMercator()
}

export class Miller extends ProjectionBase {
	readonly properties = MILLER_PROPERTIES

	forward(lambda: number, phi: number, options?: ProjectionOptions) {
		return millerForward(lambda, phi, options, this.defaultOptions)
	}

	inverse(x: number, y: number, options?: ProjectionOptions) {
		return millerInverse(x, y, options, this.defaultOptions)
	}

	bounds(options?: ProjectionOptions) {
		return millerBounds(options, this.defaultOptions)
	}

	static readonly default = new Miller()
}

export class CentralCylindrical extends ProjectionBase {
	readonly properties = CENTRAL_CYLINDRICAL_PROPERTIES

	forward(lambda: number, phi: number, options?: ProjectionOptions) {
		return centralCylindricalForward(lambda, phi, options, this.defaultOptions)
	}

	inverse(x: number, y: number, options?: ProjectionOptions) {
		return centralCylindricalInverse(x, y, options, this.defaultOptions)
	}

	bounds(options?: ProjectionOptions) {
		return centralCylindricalBounds(options, this.defaultOptions)
	}

	static readonly default = new CentralCylindrical()
}

// Projects longitude and latitude with a registered projection.
export function projectLonLat(projection: Projection, lambda: number, phi: number, options?: ProjectionOptions) {
	return projection.forward(lambda, phi, options)
}

// Unprojects plane coordinates into longitude and latitude.
export function unprojectLonLat(projection: Projection, x: number, y: number, options?: ProjectionOptions) {
	return projection.inverse(x, y, options)
}

// Projects an array of spherical points into a flat x/y buffer.
export function projectLonLatBatch(projection: Projection, points: readonly SphericalPoint[], options?: ProjectionOptions, out: number[] = []) {
	out.length = points.length * 2

	for (let i = 0; i < points.length; i++) {
		const projected = projection.forward(points[i][0], points[i][1], options)

		if (projected === undefined) return undefined

		out[i * 2] = projected[0]
		out[i * 2 + 1] = projected[1]
	}

	return out
}

function shouldSplitLongitude(a: SphericalPoint, b: SphericalPoint, options: ProjectionPolylineOptions | undefined, defaults: ProjectionOptions | undefined) {
	const splitLongitudeGap = options?.splitLongitudeGap ?? PI
	const aDelta = projectionLongitudeDelta(a[0], options, defaults)
	const bDelta = projectionLongitudeDelta(b[0], options, defaults)

	if (!Number.isFinite(splitLongitudeGap) || splitLongitudeGap <= 0 || aDelta === undefined || bDelta === undefined) return false

	return Math.abs(bDelta - aDelta) > splitLongitudeGap
}

function densifiedPoint(a: SphericalPoint, b: SphericalPoint, step: number, steps: number): SphericalPoint {
	const dLongitude = normalizePI(b[0] - a[0])
	const t = step / steps
	return [a[0] + dLongitude * t, a[1] + (b[1] - a[1]) * t] as const
}

function projectedDistance(a: ProjectedPoint, b: ProjectedPoint) {
	return Math.hypot(b[0] - a[0], b[1] - a[1])
}

// Splits projected polylines at anti-meridian wraps, singularities, and large jumps.
export function splitProjectionPolyline(projection: Projection, points: readonly SphericalPoint[], options?: ProjectionPolylineOptions): ProjectedPoint[][] {
	if (points.length === 0) return []

	const lines: ProjectedPoint[][] = []
	let current: ProjectedPoint[] = []
	let previousProjected: ProjectedPoint | undefined
	let previousPoint: SphericalPoint | undefined
	const maxSegmentRadians = options?.maxSegmentRadians
	const discontinuityThreshold = options?.discontinuityThreshold

	for (let i = 0; i < points.length; i++) {
		const target = points[i]
		const segmentSteps = previousPoint !== undefined && maxSegmentRadians !== undefined && Number.isFinite(maxSegmentRadians) && maxSegmentRadians > 0 ? Math.max(1, Math.ceil(Math.max(Math.abs(normalizePI(target[0] - previousPoint[0])), Math.abs(target[1] - previousPoint[1])) / maxSegmentRadians)) : 1

		for (let step = 1; step <= segmentSteps; step++) {
			const point = previousPoint === undefined || step === segmentSteps ? target : densifiedPoint(previousPoint, target, step, segmentSteps)
			const splitLongitude = previousPoint !== undefined && step === 1 && shouldSplitLongitude(previousPoint, point, options, undefined)
			const projected = projection.forward(point[0], point[1], options)
			const splitDiscontinuity = previousProjected !== undefined && projected !== undefined && discontinuityThreshold !== undefined && Number.isFinite(discontinuityThreshold) && discontinuityThreshold > 0 && projectedDistance(previousProjected, projected) > discontinuityThreshold

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
export function projectPolygon(projection: Projection, rings: readonly (readonly SphericalPoint[])[], options?: ProjectionPolylineOptions) {
	const projected: ProjectedPoint[][][] = []
	for (let i = 0; i < rings.length; i++) projected.push(splitProjectionPolyline(projection, rings[i], options))
	return projected
}
