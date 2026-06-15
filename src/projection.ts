import { normalizeAngle, normalizePI, type Angle } from './angle'
import { DEG2RAD, PI, PIOVERTWO } from './constants'
import { euclideanDistance, fillPoint, type Point } from './geometry'
import { clamp } from './math'
import { GEOMETRY_EPSILON } from './validation'

export type LongitudeWrapMode = 'pi' | 'tau' | 'none'

export type RaAxisDirection = 'east' | 'west'

export type YAxisDirection = 'northUp' | 'southUp'

export interface ProjectionOptions {
	readonly centralMeridian?: number
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
	readonly epsilon?: number
	readonly maxIterations?: number
}

export interface ProjectionPolylineOptions extends ProjectionOptions {
	readonly discontinuityThreshold?: number
	readonly maxSegmentRadians?: number
	readonly splitLongitudeGap?: number
}

export interface Projection {
	readonly project: (longitude: Angle, latitude: Angle, out?: Point, options?: ProjectionOptions) => Point | undefined
	readonly unproject: (x: number, y: number, out?: Point, options?: ProjectionOptions) => Point | undefined
}

export abstract class AzimuthalProjection implements Projection {
	readonly #sCenterLatitude: number
	readonly #cCenterLatitude: number

	constructor(
		readonly centerLongitude: Angle,
		readonly centerLatitude: Angle,
	) {
		this.#sCenterLatitude = Math.sin(centerLatitude)
		this.#cCenterLatitude = Math.cos(centerLatitude)
	}

	protected abstract radialDistance(sinC: number, cosC: number): number | false

	protected abstract angularDistance(rho: number): number | false

	project(longitude: Angle, latitude: Angle, out?: Point) {
		const sinLatitude = Math.sin(latitude)
		const cosLatitude = Math.cos(latitude)
		const dLongitude = normalizePI(longitude - this.centerLongitude)
		const sinDLongitude = Math.sin(dLongitude)
		const cosDLongitude = Math.cos(dLongitude)
		const x = cosLatitude * sinDLongitude
		const y = this.#cCenterLatitude * sinLatitude - this.#sCenterLatitude * cosLatitude * cosDLongitude
		const sinC = Math.hypot(x, y)
		const cosC = this.#sCenterLatitude * sinLatitude + this.#cCenterLatitude * cosLatitude * cosDLongitude

		if (sinC <= GEOMETRY_EPSILON) {
			if (cosC < 0) return undefined
			return fillPoint(out, 0, 0)
		}

		const rho = this.radialDistance(sinC, cosC)

		if (rho === false) return undefined

		const scale = rho / sinC

		return fillPoint(out, x * scale, y * scale)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		if (x === 0 && y === 0) return fillPoint(out, 0, this.centerLatitude)

		const rho = Math.hypot(x, y)
		const c = this.angularDistance(rho)

		if (c === false) return undefined

		const sinC = Math.sin(c)
		const cosC = Math.cos(c)
		const latitude = Math.asin(clamp(cosC * this.#sCenterLatitude + (y * sinC * this.#cCenterLatitude) / rho, -1, 1))
		const dLongitude = Math.atan2(x * sinC, rho * this.#cCenterLatitude * cosC - y * this.#sCenterLatitude * sinC)
		return fillPoint(out, normalizeAngle(this.centerLongitude + dLongitude), latitude)
	}
}

export class Gnomonic extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		return cosC <= 0 ? false : sinC / cosC
	}

	protected angularDistance(rho: number) {
		return Math.atan(rho)
	}
}

export class Stereographic extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		const denominator = 1 + cosC
		return denominator <= GEOMETRY_EPSILON ? false : (2 * sinC) / denominator
	}

	protected angularDistance(rho: number) {
		return 2 * Math.atan(rho / 2)
	}
}

export class Orthographic extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		return cosC < 0 ? false : sinC
	}

	protected angularDistance(rho: number) {
		return rho > 1 + GEOMETRY_EPSILON ? false : Math.asin(clamp(rho, 0, 1))
	}
}

export class LambertAzimuthalEqualArea extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		const denominator = 1 + cosC
		return denominator <= GEOMETRY_EPSILON ? false : sinC * Math.sqrt(2 / denominator)
	}

	protected angularDistance(rho: number) {
		return rho > 2 + GEOMETRY_EPSILON ? false : 2 * Math.asin(clamp(rho / 2, 0, 1))
	}
}

export class AzimuthalEquidistant extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		return sinC <= GEOMETRY_EPSILON && cosC < 0 ? false : Math.atan2(sinC, cosC)
	}

	protected angularDistance(rho: number) {
		return rho > PI + GEOMETRY_EPSILON ? false : rho
	}
}

export abstract class CylindricalProjection implements Projection {
	constructor(readonly options?: ProjectionOptions) {}

	abstract project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions): Point | undefined

	abstract unproject(x: number, y: number, out?: Point, options?: ProjectionOptions): Point | undefined
}

export class Mercator extends CylindricalProjection {
	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		const longitude = longitudeFromLambda(lambda, options, this.options)
		const latitude = latitudeFromPhi(phi, options, this.options, DEFAULT_MAX_MERCATOR_LATITUDE)
		return longitude === undefined || latitude === undefined ? undefined : projectPoint(out, longitude, Math.asinh(Math.tan(latitude)), options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined
		const longitude = longitudeFromLambda(out.x, options, this.options)
		const latitude = latitudeInRange(Math.atan(Math.sinh(out.y)), options, this.options, DEFAULT_MAX_MERCATOR_LATITUDE)
		return longitude === undefined || latitude === undefined ? undefined : fillPoint(out, longitude, latitude)
	}
}

// The Web Mercator limit maps to y = +/-PI in normalized projection units.
export const WEB_MERCATOR_MAX_LATITUDE = Math.atan(Math.sinh(PI))

export class WebMercator extends Mercator {
	constructor(options?: ProjectionOptions) {
		super({ ...options, clampLatitude: true, maxLatitude: WEB_MERCATOR_MAX_LATITUDE })
	}

	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		const longitude = longitudeFromLambda(lambda, options, this.options)
		const latitude = latitudeFromPhi(phi, options, this.options, WEB_MERCATOR_MAX_LATITUDE, true)
		if (longitude === undefined || latitude === undefined) return undefined
		return super.project(longitude, latitude, out)
	}
}

function ellipsoidalMercatorInverseLatitude(y: number, eccentricity: number, maxIterations: number, epsilon: number) {
	if (eccentricity === 0) return Math.atan(Math.sinh(y))

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

export class EllipsoidalMercator extends CylindricalProjection {
	private readonly eccentricity: number

	constructor(options?: ProjectionOptions) {
		super()
		this.eccentricity = eccentricityFrom(options, this.options) ?? 0
	}

	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		const longitude = longitudeFromLambda(lambda, options, this.options)
		if (longitude === undefined) return undefined
		const latitude = latitudeFromPhi(phi, options, this.options, WEB_MERCATOR_MAX_LATITUDE)
		if (latitude === undefined) return undefined
		const sinLatitude = Math.sin(latitude)
		return projectPoint(out, longitude, Math.atanh(sinLatitude) - this.eccentricity * Math.atanh(this.eccentricity * sinLatitude), options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined
		const longitude = longitudeFromDelta(out.x, options, this.options)
		if (longitude === undefined) return undefined
		const latitude = latitudeInRange(ellipsoidalMercatorInverseLatitude(out.y, this.eccentricity, maxIterationsFrom(options, this.options), epsilonFrom(options, this.options)), options, this.options, DEFAULT_MAX_MERCATOR_LATITUDE)
		if (latitude === undefined) return undefined
		return fillPoint(out, longitude, latitude)
	}
}

export class Miller extends CylindricalProjection {
	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		const longitude = longitudeFromLambda(lambda, options, this.options)
		const latitude = latitudeFromPhi(phi, options, this.options, WEB_MERCATOR_MAX_LATITUDE)
		return longitude === undefined || latitude === undefined ? undefined : projectPoint(out, longitude, 1.25 * Math.log(Math.tan(PI / 4 + 0.4 * latitude)), options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined
		const longitude = longitudeFromDelta(out.x, options, this.options)
		const latitude = latitudeInRange(2.5 * (Math.atan(Math.exp(0.8 * out.y)) - PI / 4), options, this.options)
		return longitude === undefined || latitude === undefined ? undefined : fillPoint(out, longitude, latitude)
	}
}

export class CentralCylindrical extends CylindricalProjection {
	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		const longitude = longitudeFromLambda(lambda, options, this.options)
		return longitude === undefined ? undefined : projectPoint(out, longitude, Math.tan(phi), options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined
		const longitude = longitudeFromDelta(out.x, options, this.options)
		const latitude = latitudeInRange(Math.atan(out.y), options, this.options, DEFAULT_MAX_MERCATOR_LATITUDE)
		return longitude === undefined || latitude === undefined ? undefined : fillPoint(out, longitude, latitude)
	}
}

export class CylindricalEqualArea extends CylindricalProjection {
	protected readonly cosStandardParallel: number

	constructor(
		standardParallel: Angle = 0,
		readonly latitudeOfOrigin: Angle = 0,
		options?: ProjectionOptions,
	) {
		super(options)
		this.cosStandardParallel = cosStandardParallelFrom(standardParallel, options)
	}

	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		const longitude = longitudeFromLambda(lambda * this.cosStandardParallel, options, this.options)
		return longitude === undefined ? undefined : projectPoint(out, longitude, (Math.sin(phi) - Math.sin(this.latitudeOfOrigin)) / this.cosStandardParallel, options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined
		const longitude = longitudeFromDelta(out.x / this.cosStandardParallel, options, this.options)
		return longitude === undefined ? undefined : fillPoint(out, longitude, Math.asin(out.y * this.cosStandardParallel + Math.sin(this.latitudeOfOrigin)))
	}
}

export class LambertCylindricalEqualArea extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(0, latitudeOfOrigin)
	}
}

export class Behrmann extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(PI / 6, latitudeOfOrigin)
	}
}

export class GallPeters extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(PI / 4, latitudeOfOrigin)
	}
}

export class HoboDyer extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(37.5 * DEG2RAD, latitudeOfOrigin)
	}
}

export class Balthasart extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(50 * DEG2RAD, latitudeOfOrigin)
	}
}

export class TrystanEdwards extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(37.4 * DEG2RAD, latitudeOfOrigin)
	}
}

export class CylindricalStereographic extends CylindricalProjection {
	protected readonly cosStandardParallel: number

	constructor(standardParallel: Angle = 0, options?: ProjectionOptions) {
		super(options)
		this.cosStandardParallel = cosStandardParallelFrom(standardParallel, options)
	}

	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		const longitude = longitudeFromLambda(lambda * this.cosStandardParallel, options, this.options)
		const latitude = latitudeFromPhi(phi, options, this.options, WEB_MERCATOR_MAX_LATITUDE)
		if (latitude === undefined) return undefined
		return longitude === undefined || latitude === undefined ? undefined : projectPoint(out, longitude, (1 + this.cosStandardParallel) * Math.tan(latitude / 2), options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined

		const longitude = longitudeFromDelta(out.x / this.cosStandardParallel, this.options)
		if (longitude === undefined) return undefined

		const yLimit = 1 + this.cosStandardParallel
		const epsilon = epsilonFrom(options, this.options)
		if (out.y < -yLimit - epsilon || out.y > yLimit + epsilon) return undefined

		const latitude = latitudeInRange(2 * Math.atan(clamp(out.y, -yLimit, yLimit) / yLimit), options, this.options)
		if (latitude === undefined) return undefined

		return fillPoint(out, longitude, latitude)
	}
}

export class Gall extends CylindricalStereographic {
	constructor() {
		super(PI / 4)
	}
}

export class Braun extends CylindricalStereographic {
	constructor() {
		super(0)
	}
}

export class CylindricalEquidistant extends CylindricalProjection {
	protected readonly cosStandardParallel: number

	constructor(
		standardParallel: Angle = 0,
		readonly latitudeOfOrigin: Angle = 0,
		options?: ProjectionOptions,
	) {
		super(options)
		this.cosStandardParallel = cosStandardParallelFrom(standardParallel, options)
	}

	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		const longitude = longitudeFromLambda(lambda, options, this.options)
		const latitude = latitudeFromPhi(phi, options, this.options, WEB_MERCATOR_MAX_LATITUDE)
		if (latitude === undefined) return undefined
		return longitude === undefined || latitude === undefined ? undefined : projectPoint(out, longitude * this.cosStandardParallel, latitude - this.latitudeOfOrigin, options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined
		const longitude = longitudeFromDelta(out.x / this.cosStandardParallel, options, this.options)
		const latitude = latitudeInRange(out.y + this.latitudeOfOrigin, options, this.options, PIOVERTWO)
		return longitude === undefined || latitude === undefined ? undefined : fillPoint(out, longitude, latitude)
	}
}

export class PlateCarree extends CylindricalEquidistant {
	constructor(
		readonly latitudeOfOrigin: Angle = 0,
		options?: ProjectionOptions,
	) {
		super(0, latitudeOfOrigin, options)
	}
}

function numberFrom(num: number | undefined | null, fallback: number) {
	return num !== undefined && num !== null && Number.isFinite(num) ? num : fallback
}

function epsilonFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: number = GEOMETRY_EPSILON) {
	const epsilon = a?.epsilon ?? b?.epsilon ?? fallback
	return Number.isFinite(epsilon) && epsilon > 0 ? epsilon : fallback
}

function centralMeridianFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: Angle = 0) {
	return numberFrom(a?.centralMeridian ?? b?.centralMeridian, fallback)
}

function longitudeWrapModeFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: LongitudeWrapMode = 'pi') {
	return a?.longitudeWrapMode ?? b?.longitudeWrapMode ?? fallback
}

function raAxisDirectionFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: RaAxisDirection = 'east') {
	return a?.raAxisDirection ?? b?.raAxisDirection ?? fallback
}

function normalizeLongitudeByMode(longitude: number, mode: LongitudeWrapMode) {
	if (mode === 'tau') return normalizeAngle(longitude)
	// In 'pi' mode keep a value that already sits exactly on the +-PI seam as given, so the left (-PI) and
	// right (+PI) map edges stay distinguishable. normalizePI maps to (-PI, PI], folding -PI onto +PI, which
	// would push an antimeridian crossing deliberately placed on the left edge over to the right one.
	if (mode === 'pi') return longitude === PI || longitude === -PI ? longitude : normalizePI(longitude)
	return longitude
}

function longitudeFromLambda(lambda: number, a?: ProjectionOptions, b?: ProjectionOptions) {
	const centralMeridian = centralMeridianFrom(a, b)
	const mode = longitudeWrapModeFrom(a, b)
	const direction = raAxisDirectionFrom(a, b)

	if (!Number.isFinite(lambda)) return undefined

	const delta = direction === 'west' ? centralMeridian - lambda : lambda - centralMeridian
	return normalizeLongitudeByMode(delta, mode)
}

function longitudeFromDelta(delta: number, a?: ProjectionOptions, b?: ProjectionOptions) {
	const centralMeridian = centralMeridianFrom(a, b)
	const mode = longitudeWrapModeFrom(a, b)
	const direction = raAxisDirectionFrom(a, b)

	if (!Number.isFinite(delta)) return undefined

	const longitude = direction === 'west' ? centralMeridian - delta : centralMeridian + delta
	return normalizeLongitudeByMode(longitude, mode)
}

function maxLatitudeFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: number = PIOVERTWO) {
	const maxLatitude = numberFrom(a?.maxLatitude ?? b?.maxLatitude, fallback)
	return Number.isFinite(maxLatitude) && maxLatitude > 0 && maxLatitude <= PIOVERTWO ? maxLatitude : undefined
}

function latitudeFromPhi(latitude: number, a?: ProjectionOptions, b?: ProjectionOptions, maxLatitudeFallback: Angle = PIOVERTWO, clampFallback: boolean = false) {
	const epsilon = epsilonFrom(a, b)
	const maxLatitude = maxLatitudeFrom(a, b, maxLatitudeFallback)

	if (epsilon === undefined || maxLatitude === undefined || !Number.isFinite(latitude)) return undefined
	if (latitude < -PIOVERTWO - epsilon || latitude > PIOVERTWO + epsilon) return undefined

	let value = clamp(latitude, -PIOVERTWO, PIOVERTWO)

	if (Math.abs(value) > maxLatitude) {
		const clampLatitude = a?.clampLatitude ?? b?.clampLatitude ?? clampFallback
		if (!clampLatitude) return undefined
		value = value < 0 ? -maxLatitude : maxLatitude
	}

	return value
}

function latitudeInRange(latitude: number | undefined, a?: ProjectionOptions, b?: ProjectionOptions, maxLatitudeFallback: Angle = PIOVERTWO) {
	if (latitude === undefined) return undefined

	const epsilon = epsilonFrom(a, b)
	const maxLatitude = maxLatitudeFrom(a, b, maxLatitudeFallback)

	if (epsilon === undefined || maxLatitude === undefined || !Number.isFinite(latitude)) return undefined
	if (latitude < -maxLatitude - epsilon || latitude > maxLatitude + epsilon) return undefined

	return clamp(latitude, -maxLatitude, maxLatitude)
}

function cosStandardParallelFrom(standardParallel: Angle, options?: ProjectionOptions) {
	const epsilon = epsilonFrom(options)
	if (!Number.isFinite(standardParallel) || standardParallel <= -PIOVERTWO + epsilon || standardParallel >= PIOVERTWO - epsilon) throw new TypeError('invalid standardParallel')
	return Math.cos(standardParallel)
}

function sphericalOnlyFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: boolean = false) {
	return a?.sphericalOnly ?? b?.sphericalOnly ?? fallback
}

function eccentricityFrom(a?: ProjectionOptions, b?: ProjectionOptions) {
	if (sphericalOnlyFrom(a, b)) return 0

	const eccentricity = a?.eccentricity ?? b?.eccentricity
	if (eccentricity !== undefined && Number.isFinite(eccentricity) && eccentricity >= 0 && eccentricity < 1) return eccentricity

	const flattening = a?.flattening ?? b?.flattening
	if (flattening === 0) return 0
	if (flattening === undefined || !Number.isFinite(flattening) || flattening < 0 || flattening >= 1) throw new TypeError('invalid eccentricity')

	return Math.sqrt(flattening * (2 - flattening))
}

function maxIterationsFrom(a?: ProjectionOptions, b?: ProjectionOptions) {
	return a?.maxIterations ?? b?.maxIterations ?? 12
}

const DEFAULT_RADIUS = 1
const DEFAULT_SCALE = 1
const DEFAULT_FALSE_OFFSET = 0
const DEFAULT_MAX_MERCATOR_LATITUDE = PIOVERTWO - GEOMETRY_EPSILON

function radiusFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: number = DEFAULT_RADIUS) {
	return numberFrom(a?.radius ?? b?.radius, fallback)
}

function scaleFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: number = DEFAULT_SCALE) {
	return numberFrom(a?.scale ?? b?.scale, fallback)
}

function realScaleFrom(a?: ProjectionOptions, b?: ProjectionOptions) {
	const radius = radiusFrom(a, b)
	const scale = scaleFrom(a, b)
	if (!Number.isFinite(radius) || !Number.isFinite(scale) || radius <= 0 || scale <= 0) return undefined
	return radius * scale
}

function falseEastingFrom(a?: ProjectionOptions, b?: ProjectionOptions) {
	return numberFrom(a?.falseEasting ?? b?.falseEasting, DEFAULT_FALSE_OFFSET)
}

function falseNorthingFrom(a?: ProjectionOptions, b?: ProjectionOptions) {
	return numberFrom(a?.falseNorthing ?? b?.falseNorthing, DEFAULT_FALSE_OFFSET)
}

function yAxisDirectionFrom(a?: ProjectionOptions, b?: ProjectionOptions) {
	return a?.yAxisDirection ?? b?.yAxisDirection ?? 'northUp'
}

function projectPoint(out: Point | undefined, x: number, y: number, a?: ProjectionOptions, b?: ProjectionOptions) {
	const scale = realScaleFrom(a, b)
	const falseEasting = falseEastingFrom(a, b)
	const falseNorthing = falseNorthingFrom(a, b)
	const yAxisDirection = yAxisDirectionFrom(a, b)

	if (scale === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	return fillPoint(out, falseEasting + x * scale, falseNorthing + y * ySign * scale)
}

function unprojectPoint(out: Point | undefined, x: number, y: number, a?: ProjectionOptions, b?: ProjectionOptions) {
	const scale = realScaleFrom(a, b)
	const falseEasting = falseEastingFrom(a, b)
	const falseNorthing = falseNorthingFrom(a, b)
	const yAxisDirection = yAxisDirectionFrom(a, b)

	if (scale === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	return fillPoint(out, (x - falseEasting) / scale, ((y - falseNorthing) / scale) * ySign)
}

function shouldSplitLongitude(a: Point, b: Point, options?: ProjectionPolylineOptions, defaults?: ProjectionOptions) {
	const splitLongitudeGap = options?.splitLongitudeGap ?? PI
	const aDelta = longitudeFromLambda(a.x, options, defaults)
	const bDelta = longitudeFromLambda(b.x, options, defaults)

	if (!Number.isFinite(splitLongitudeGap) || splitLongitudeGap <= 0 || aDelta === undefined || bDelta === undefined) return undefined

	return Math.abs(bDelta - aDelta) > splitLongitudeGap
}

function densifiedPoint(a: Point, b: Point, step: number, steps: number, out?: Point) {
	const dLongitude = normalizePI(b.x - a.x)
	const t = step / steps
	return fillPoint(out, a.x + dLongitude * t, a.y + (b.y - a.y) * t)
}

// Projects an array of spherical points into a flat x/y buffer.
export function projectMany(projection: Projection, points: readonly Readonly<Point>[], options?: ProjectionOptions, out: Point[] = []) {
	if (out.length < points.length) out.length = points.length

	const n = points.length

	for (let i = 0; i < n; i++) {
		const point = points[i]
		const projected = projection.project(point.x, point.y, out[i], options)
		if (projected === undefined) return undefined
		out[i] = projected
	}

	return out
}

// Splits projected polylines at anti-meridian wraps, singularities, and large jumps.
export function projectPolyline(projection: Projection, points: readonly Readonly<Point>[], options?: ProjectionPolylineOptions): Point[][] {
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
			const point = previousPoint === undefined || step === segmentSteps ? fillPoint(p, target.x, target.y) : densifiedPoint(previousPoint, target, step, segmentSteps, p)
			const splitLongitude = previousPoint !== undefined && step === 1 && shouldSplitLongitude(previousPoint, point, options, undefined)
			const projected = projection.project(point.x, point.y, undefined, options)
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
	for (let i = 0; i < rings.length; i++) projected.push(projectPolyline(projection, rings[i], options))
	return projected
}
