import { DEG2RAD, PI, PIOVERTWO } from '../../core/constants'
import { GEOMETRY_EPSILON } from '../../core/validation'
import { euclideanDistance, fillPoint, type Point } from '../../math/numerical/geometry'
import { clamp } from '../../math/numerical/math'
import { normalizeAngle, normalizePI, type Angle } from '../../math/units/angle'

// Map projections between spherical coordinates (longitude/latitude or RA/Dec, radians) and planar
// x/y, plus polyline/polygon helpers that split at antimeridian wraps and projection singularities.
// Provides azimuthal projections (gnomonic, stereographic, orthographic, Lambert equal-area,
// equidistant) sharing one spherical core, and a family of cylindrical projections (Mercator and
// variants, equal-area, stereographic, equidistant). A shared linear plane transform applies scale,
// radius, false easting/northing, and y-axis direction; options also control longitude wrap, RA-axis
// handedness, latitude clamping, and the ellipsoid. project/unproject return undefined off-domain.

// How a projected longitude delta is wrapped: to (-PI, PI], to [0, TAU), or left unwrapped.
export type LongitudeWrapMode = 'pi' | 'tau' | 'none'

// Whether right ascension increases to the east (right) or west (left, mirrored).
export type RaAxisDirection = 'east' | 'west'

// Whether the planar y-axis points up toward the north or the south.
export type YAxisDirection = 'northUp' | 'southUp'

// Shared options controlling the spherical-to-planar transform and domain handling for a projection.
export interface ProjectionOptions {
	// Central meridian / reference longitude subtracted before projecting, radians.
	readonly centralMeridian?: number
	// Linear scale factor applied to the normalized plane coordinates.
	readonly scale?: number
	// Sphere/ellipsoid radius multiplier applied with the scale.
	readonly radius?: number
	// Constant added to the projected x (false easting).
	readonly falseEasting?: number
	// Constant added to the projected y (false northing).
	readonly falseNorthing?: number
	// First eccentricity of the ellipsoid (0 for a sphere); overrides flattening when set.
	readonly eccentricity?: number
	// Flattening of the ellipsoid, used to derive eccentricity when eccentricity is unset.
	readonly flattening?: number
	// When true, force the spherical (eccentricity 0) form regardless of ellipsoid options.
	readonly sphericalOnly?: boolean
	// When true, clamp latitudes beyond maxLatitude instead of returning undefined.
	readonly clampLatitude?: boolean
	// Maximum |latitude| accepted/clamped, radians.
	readonly maxLatitude?: number
	// Longitude wrap convention; defaults to 'pi'.
	readonly longitudeWrapMode?: LongitudeWrapMode
	// RA-axis handedness; defaults to 'east'.
	readonly raAxisDirection?: RaAxisDirection
	// y-axis direction; defaults to 'northUp'.
	readonly yAxisDirection?: YAxisDirection
	// Numerical tolerance for domain checks and iteration; defaults to GEOMETRY_EPSILON.
	readonly epsilon?: number
	// Iteration cap for iterative inverse solvers (e.g. ellipsoidal Mercator).
	readonly maxIterations?: number
}

// Options for polyline/polygon projection, adding the criteria for splitting a path.
export interface ProjectionPolylineOptions extends ProjectionOptions {
	// Planar distance between consecutive projected points that forces a split (singularity/jump).
	readonly discontinuityThreshold?: number
	// Maximum angular length of a segment before it is densified, radians.
	readonly maxSegmentRadians?: number
	// Longitude delta between consecutive points that forces a split (antimeridian wrap), radians.
	readonly splitLongitudeGap?: number
}

// A forward/inverse projection between spherical (radians) and planar coordinates.
export interface Projection {
	// Projects (longitude, latitude) to a planar point; undefined if outside the projection domain.
	readonly project: (longitude: Angle, latitude: Angle, out?: Point, options?: ProjectionOptions) => Point | undefined
	// Inverts a planar (x, y) back to (longitude, latitude); undefined if outside the valid range.
	readonly unproject: (x: number, y: number, out?: Point, options?: ProjectionOptions) => Point | undefined
}

// Base class for azimuthal (planar) projections tangent at a center point. Subclasses supply only the
// radial mapping between the angular distance from the center and the plane radius; this class handles
// the shared spherical geometry, RA-axis mirroring, and the linear plane transform.
export abstract class AzimuthalProjection implements Projection {
	// Sine of the center latitude, cached for the spherical formulas.
	readonly #sCenterLatitude: number
	// Cosine of the center latitude, cached for the spherical formulas.
	readonly #cCenterLatitude: number

	constructor(
		readonly centerLongitude: Angle,
		readonly centerLatitude: Angle,
		readonly options?: ProjectionOptions,
	) {
		this.#sCenterLatitude = Math.sin(centerLatitude)
		this.#cCenterLatitude = Math.cos(centerLatitude)
	}

	// Maps the angular distance c from the center (given as sin c, cos c) to the plane radius rho;
	// returns false when the point is outside this projection's visible hemisphere/domain.
	protected abstract radialDistance(sinC: number, cosC: number): number | false

	// Inverse of radialDistance: maps a plane radius rho back to the angular distance c (radians);
	// returns false when rho lies outside the projection's representable range.
	protected abstract angularDistance(rho: number): number | false

	project(longitude: Angle, latitude: Angle, out?: Point, options?: ProjectionOptions) {
		const sinLatitude = Math.sin(latitude)
		const cosLatitude = Math.cos(latitude)
		// 'west' mirrors the projection about the declination axis (RA increasing to the left), which
		// is just a sign flip of the longitude delta; only x changes since y/sinC/cosC use cos(dLon).
		const direction = raAxisDirectionFrom(options, this.options)
		const dLongitude = direction === 'west' ? normalizePI(this.centerLongitude - longitude) : normalizePI(longitude - this.centerLongitude)
		const sinDLongitude = Math.sin(dLongitude)
		const cosDLongitude = Math.cos(dLongitude)
		const x = cosLatitude * sinDLongitude
		const y = this.#cCenterLatitude * sinLatitude - this.#sCenterLatitude * cosLatitude * cosDLongitude
		const sinC = Math.hypot(x, y)
		const cosC = this.#sCenterLatitude * sinLatitude + this.#cCenterLatitude * cosLatitude * cosDLongitude

		// Apply the shared linear plane transform (scale, radius, false easting/northing, y-axis
		// direction) the same way the cylindrical projections do, instead of emitting raw units.
		if (sinC <= GEOMETRY_EPSILON) {
			if (cosC < 0) return undefined
			return projectPoint(out, 0, 0, options, this.options)
		}

		const rho = this.radialDistance(sinC, cosC)

		if (rho === false) return undefined

		const scale = rho / sinC

		return projectPoint(out, x * scale, y * scale, options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		// Undo the linear plane transform first, then invert the spherical geometry on the
		// normalized coordinates.
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined

		const px = out.x
		const py = out.y

		if (px === 0 && py === 0) return fillPoint(out, normalizeAngle(this.centerLongitude), this.centerLatitude)

		const rho = Math.hypot(px, py)
		const c = this.angularDistance(rho)

		if (c === false) return undefined

		const sinC = Math.sin(c)
		const cosC = Math.cos(c)
		const latitude = Math.asin(clamp(cosC * this.#sCenterLatitude + (py * sinC * this.#cCenterLatitude) / rho, -1, 1))
		const dLongitude = Math.atan2(px * sinC, rho * this.#cCenterLatitude * cosC - py * this.#sCenterLatitude * sinC)
		// Undo the 'west' mirror applied in project so the recovered longitude matches the input.
		const direction = raAxisDirectionFrom(options, this.options)
		const longitude = direction === 'west' ? this.centerLongitude - dLongitude : this.centerLongitude + dLongitude
		return fillPoint(out, normalizeAngle(longitude), latitude)
	}
}

// Gnomonic projection: great circles map to straight lines; shows less than one hemisphere.
export class Gnomonic extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		return cosC <= 0 ? false : sinC / cosC
	}

	protected angularDistance(rho: number) {
		return Math.atan(rho)
	}
}

// Stereographic projection: conformal (angle-preserving); the antipode maps to infinity.
export class Stereographic extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		const denominator = 1 + cosC
		return denominator <= GEOMETRY_EPSILON ? false : (2 * sinC) / denominator
	}

	protected angularDistance(rho: number) {
		return 2 * Math.atan(rho / 2)
	}
}

// Orthographic projection: the view of a globe from infinite distance; one hemisphere only.
export class Orthographic extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		return cosC < 0 ? false : sinC
	}

	protected angularDistance(rho: number) {
		return rho > 1 + GEOMETRY_EPSILON ? false : Math.asin(clamp(rho, 0, 1))
	}
}

// Lambert azimuthal equal-area projection: preserves area; can show the whole sphere.
export class LambertAzimuthalEqualArea extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		const denominator = 1 + cosC
		return denominator <= GEOMETRY_EPSILON ? false : sinC * Math.sqrt(2 / denominator)
	}

	protected angularDistance(rho: number) {
		return rho > 2 + GEOMETRY_EPSILON ? false : 2 * Math.asin(clamp(rho / 2, 0, 1))
	}
}

// Azimuthal equidistant projection: distances from the center are true to scale; covers the sphere.
export class AzimuthalEquidistant extends AzimuthalProjection {
	protected radialDistance(sinC: number, cosC: number) {
		return sinC <= GEOMETRY_EPSILON && cosC < 0 ? false : Math.atan2(sinC, cosC)
	}

	protected angularDistance(rho: number) {
		return rho > PI + GEOMETRY_EPSILON ? false : rho
	}
}

// Base class for cylindrical projections, which map longitude linearly to x and a per-projection
// function of latitude to y. Subclasses implement the latitude mapping and its inverse.
export abstract class CylindricalProjection implements Projection {
	constructor(readonly options?: ProjectionOptions) {}

	abstract project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions): Point | undefined

	abstract unproject(x: number, y: number, out?: Point, options?: ProjectionOptions): Point | undefined
}

// Mercator projection: conformal; y = asinh(tan(lat)). Latitudes near the poles diverge.
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

// Web Mercator: Mercator clamped to +/-WEB_MERCATOR_MAX_LATITUDE to yield the square web-map tile.
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

// Inverts the ellipsoidal Mercator northing `y` to geodetic latitude (radians) by Newton iteration on
// the isometric-latitude equation. Returns undefined if it fails to converge within maxIterations.
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

// Ellipsoidal Mercator: conformal projection of the ellipsoid, using the configured eccentricity.
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

// Miller cylindrical projection: a Mercator variant that compresses latitude to keep the poles finite.
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

// Central cylindrical projection: perspective from the globe center onto a tangent cylinder; y = tan(lat).
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

// Cylindrical equal-area projection with a configurable standard parallel; preserves area.
export class CylindricalEqualArea extends CylindricalProjection {
	// Cosine of the standard parallel; sets the aspect ratio of the equal-area mapping.
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
		// Wrap the longitude delta first, then apply the standard-parallel scale, so a non-zero
		// central meridian round-trips (scaling lambda before subtracting it does not).
		const longitude = longitudeFromLambda(lambda, options, this.options)
		return longitude === undefined ? undefined : projectPoint(out, longitude * this.cosStandardParallel, (Math.sin(phi) - Math.sin(this.latitudeOfOrigin)) / this.cosStandardParallel, options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined
		const longitude = longitudeFromDelta(out.x / this.cosStandardParallel, options, this.options)
		return longitude === undefined ? undefined : fillPoint(out, longitude, Math.asin(out.y * this.cosStandardParallel + Math.sin(this.latitudeOfOrigin)))
	}
}

// Lambert cylindrical equal-area: standard parallel at the equator (0 deg).
export class LambertCylindricalEqualArea extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(0, latitudeOfOrigin)
	}
}

// Behrmann equal-area: standard parallel at 30 deg.
export class Behrmann extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(PI / 6, latitudeOfOrigin)
	}
}

// Gall-Peters equal-area: standard parallel at 45 deg.
export class GallPeters extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(PI / 4, latitudeOfOrigin)
	}
}

// Hobo-Dyer equal-area: standard parallel at 37.5 deg.
export class HoboDyer extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(37.5 * DEG2RAD, latitudeOfOrigin)
	}
}

// Balthasart equal-area: standard parallel at 50 deg.
export class Balthasart extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(50 * DEG2RAD, latitudeOfOrigin)
	}
}

// Trystan Edwards equal-area: standard parallel at 37.4 deg.
export class TrystanEdwards extends CylindricalEqualArea {
	constructor(latitudeOfOrigin: Angle = 0) {
		super(37.4 * DEG2RAD, latitudeOfOrigin)
	}
}

// Cylindrical stereographic projection with a configurable standard parallel.
export class CylindricalStereographic extends CylindricalProjection {
	// Cosine of the standard parallel; sets the vertical scaling.
	protected readonly cosStandardParallel: number

	constructor(standardParallel: Angle = 0, options?: ProjectionOptions) {
		super(options)
		this.cosStandardParallel = cosStandardParallelFrom(standardParallel, options)
	}

	project(lambda: Angle, phi: Angle, out?: Point, options?: ProjectionOptions) {
		// Wrap the longitude delta first, then apply the standard-parallel scale, so a non-zero
		// central meridian round-trips (scaling lambda before subtracting it does not).
		const longitude = longitudeFromLambda(lambda, options, this.options)
		const latitude = latitudeFromPhi(phi, options, this.options, WEB_MERCATOR_MAX_LATITUDE)
		if (latitude === undefined) return undefined
		return longitude === undefined || latitude === undefined ? undefined : projectPoint(out, longitude * this.cosStandardParallel, (1 + this.cosStandardParallel) * Math.tan(latitude / 2), options, this.options)
	}

	unproject(x: number, y: number, out?: Point, options?: ProjectionOptions) {
		out = unprojectPoint(out, x, y, options, this.options)
		if (out === undefined) return undefined

		const longitude = longitudeFromDelta(out.x / this.cosStandardParallel, options, this.options)
		if (longitude === undefined) return undefined

		const yLimit = 1 + this.cosStandardParallel
		const epsilon = epsilonFrom(options, this.options)
		if (out.y < -yLimit - epsilon || out.y > yLimit + epsilon) return undefined

		const latitude = latitudeInRange(2 * Math.atan(clamp(out.y, -yLimit, yLimit) / yLimit), options, this.options)
		if (latitude === undefined) return undefined

		return fillPoint(out, longitude, latitude)
	}
}

// Gall stereographic: cylindrical stereographic with standard parallel at 45 deg.
export class Gall extends CylindricalStereographic {
	constructor() {
		super(PI / 4)
	}
}

// Braun stereographic: cylindrical stereographic with standard parallel at the equator.
export class Braun extends CylindricalStereographic {
	constructor() {
		super(0)
	}
}

// Cylindrical equidistant (equirectangular) projection with a configurable standard parallel.
export class CylindricalEquidistant extends CylindricalProjection {
	// Cosine of the standard parallel; sets the longitude scaling.
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

// Plate carree (equirectangular with standard parallel at the equator): x = longitude, y = latitude.
export class PlateCarree extends CylindricalEquidistant {
	constructor(
		readonly latitudeOfOrigin: Angle = 0,
		options?: ProjectionOptions,
	) {
		super(0, latitudeOfOrigin, options)
	}
}

// Returns `num` if it is a finite number, otherwise `fallback`.
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

// Computes the wrapped longitude delta from the central meridian for a forward projection, honoring
// the RA-axis direction and wrap mode. Returns undefined for non-finite input.
function longitudeFromLambda(lambda: number, a?: ProjectionOptions, b?: ProjectionOptions) {
	const centralMeridian = centralMeridianFrom(a, b)
	const mode = longitudeWrapModeFrom(a, b)
	const direction = raAxisDirectionFrom(a, b)

	if (!Number.isFinite(lambda)) return undefined

	const delta = direction === 'west' ? centralMeridian - lambda : lambda - centralMeridian
	return normalizeLongitudeByMode(delta, mode)
}

// Recovers the absolute longitude from a delta during an inverse projection (the inverse of
// longitudeFromLambda), honoring the RA-axis direction and wrap mode.
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

// Validates and conditions an input latitude `phi`: rejects values outside +/-PI/2 (within epsilon),
// then either clamps to maxLatitude (when clamping is enabled) or returns undefined when beyond it.
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

// Validates a recovered (inverse) latitude against the projection's max latitude, clamping within
// epsilon and returning undefined when out of range or undefined on input.
function latitudeInRange(latitude: number | undefined, a?: ProjectionOptions, b?: ProjectionOptions, maxLatitudeFallback: Angle = PIOVERTWO) {
	if (latitude === undefined) return undefined

	const epsilon = epsilonFrom(a, b)
	const maxLatitude = maxLatitudeFrom(a, b, maxLatitudeFallback)

	if (epsilon === undefined || maxLatitude === undefined || !Number.isFinite(latitude)) return undefined
	if (latitude < -maxLatitude - epsilon || latitude > maxLatitude + epsilon) return undefined

	return clamp(latitude, -maxLatitude, maxLatitude)
}

// Returns cos of a validated standard parallel; throws if it is non-finite or within epsilon of +/-PI/2.
function cosStandardParallelFrom(standardParallel: Angle, options?: ProjectionOptions) {
	const epsilon = epsilonFrom(options)
	if (!Number.isFinite(standardParallel) || standardParallel <= -PIOVERTWO + epsilon || standardParallel >= PIOVERTWO - epsilon) throw new TypeError('invalid standardParallel')
	return Math.cos(standardParallel)
}

function sphericalOnlyFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: boolean = false) {
	return a?.sphericalOnly ?? b?.sphericalOnly ?? fallback
}

// Resolves the ellipsoid eccentricity: 0 when spherical-only, the explicit eccentricity if valid,
// otherwise derived from flattening. Throws when the supplied flattening is out of range.
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

// Default sphere radius multiplier.
const DEFAULT_RADIUS = 1
// Default linear scale factor.
const DEFAULT_SCALE = 1
// Default false easting/northing offset.
const DEFAULT_FALSE_OFFSET = 0
// Default latitude cap for Mercator-family projections, just shy of the pole to avoid divergence.
const DEFAULT_MAX_MERCATOR_LATITUDE = PIOVERTWO - GEOMETRY_EPSILON

function radiusFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: number = DEFAULT_RADIUS) {
	return numberFrom(a?.radius ?? b?.radius, fallback)
}

function scaleFrom(a?: ProjectionOptions, b?: ProjectionOptions, fallback: number = DEFAULT_SCALE) {
	return numberFrom(a?.scale ?? b?.scale, fallback)
}

// Combined linear scale (radius * scale); undefined if either is non-finite or non-positive.
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

// Applies the shared forward plane transform to normalized coordinates: scale by radius*scale, add
// false easting/northing, and flip y for 'southUp'. Returns undefined for non-finite or invalid scale.
function projectPoint(out: Point | undefined, x: number, y: number, a?: ProjectionOptions, b?: ProjectionOptions) {
	const scale = realScaleFrom(a, b)
	const falseEasting = falseEastingFrom(a, b)
	const falseNorthing = falseNorthingFrom(a, b)
	const yAxisDirection = yAxisDirectionFrom(a, b)

	if (scale === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	return fillPoint(out, falseEasting + x * scale, falseNorthing + y * ySign * scale)
}

// Inverse of projectPoint: removes the false offsets, undoes the scale, and restores the y sign.
function unprojectPoint(out: Point | undefined, x: number, y: number, a?: ProjectionOptions, b?: ProjectionOptions) {
	const scale = realScaleFrom(a, b)
	const falseEasting = falseEastingFrom(a, b)
	const falseNorthing = falseNorthingFrom(a, b)
	const yAxisDirection = yAxisDirectionFrom(a, b)

	if (scale === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const ySign = yAxisDirection === 'southUp' ? -1 : 1
	return fillPoint(out, (x - falseEasting) / scale, ((y - falseNorthing) / scale) * ySign)
}

// Decides whether the longitude jump between two consecutive points exceeds the split threshold
// (an antimeridian crossing). Returns undefined when the inputs are invalid.
function shouldSplitLongitude(a: Point, b: Point, options?: ProjectionPolylineOptions, defaults?: ProjectionOptions) {
	const splitLongitudeGap = options?.splitLongitudeGap ?? PI
	const aDelta = longitudeFromLambda(a.x, options, defaults)
	const bDelta = longitudeFromLambda(b.x, options, defaults)

	if (!Number.isFinite(splitLongitudeGap) || splitLongitudeGap <= 0 || aDelta === undefined || bDelta === undefined) return undefined

	return Math.abs(bDelta - aDelta) > splitLongitudeGap
}

// Linearly interpolates the `step`/`steps` fraction between spherical points a and b, taking the
// shortest longitude path. Writes into `out`, which is returned.
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
