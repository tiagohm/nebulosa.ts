import type { PlateSolution } from '../../astrometry/solvers/platesolver'
import { tanProject, tanUnproject } from '../../astrometry/wcs/fits.wcs'
import { DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters, refractedAltitude } from '../../astronomy/coordinates/astrometry'
import { eraEpv00 } from '../../astronomy/coordinates/erfa/earth'
import { type EraAstrom, eraApco13, eraAtciqz, eraAticq, eraAtioq, eraAtoiq } from '../../astronomy/coordinates/erfa/erfa'
import { Ellipsoid, type GeographicPosition } from '../../astronomy/observer/location'
import { pmAngles, pmMatrix, type Time, tdb, tt, ut1 } from '../../astronomy/time/time'
import { ELLIPSOID_PARAMETERS, PIOVERTWO } from '../../core/constants'
import { matMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecAngleUnit, vecDot, vecLength, vecNormalizeMut } from '../../math/linear-algebra/vec3'
import type { Point } from '../../math/numerical/geometry'
import type { Angle } from '../../math/units/angle'
import { projectPolarAlignmentOverlayPoint } from './tppa.overlay'

// Earth-fixed geometry of camera-based (iPolar) polar alignment. A camera rigidly attached to the RA
// axis sees a fixed set of sensor rays; between exposures those rays turn about the mechanical axis,
// which is fixed in the terrestrial frame, not in ICRS. This module maps a fixed grid of sensor
// pixels through each plate solution to the physical directions of the incoming light at the
// exposure's own instant, expressed in ITRS (unit vectors, x towards longitude 0 on the equator, z
// towards the CIO-based terrestrial pole, right-handed): astrometric ICRS directions from the WCS
// (SIP included) go through ERFA's observed-place chain (light deflection, annual and diurnal
// aberration, precession-nutation, Earth rotation, polar motion and, unless disabled, refraction)
// to the local horizon of the site, which is then rotated into ITRS through its geodetic normal.
// It also builds the alignment target in the same physical frame, decomposes an axis error into
// signed on-sky azimuth and altitude components, and projects a physical direction back into the
// FITS pixels of a solved frame. Pixels are FITS 1-based: pixel centers at integers, the image
// spanning [0.5, W + 0.5] × [0.5, H + 0.5]. Angles are radians. Every function allocates its result.

// Number of sample pixels along each image axis; the grid holds its square.
export const IPOLAR_SAMPLE_GRID = 7

// Fraction of the image width and height left unsampled at each edge, where SIP fits are least
// constrained, in [0, 0.5).
export const IPOLAR_SAMPLE_INSET = 0.04

// Minimum length of a tangent axis before the decomposition is treated as singular.
const TANGENT_EPSILON = 1e-9

// Atmosphere and site an iPolar measurement is computed for.
export interface IPolarObserver {
	// Geodetic site of the mount, in radians and the toolkit's distance unit.
	readonly location: GeographicPosition
	// Atmosphere of both the observed rays and the target pole; false is the vacuum model: rays
	// without refraction and the geometric pole as the target.
	readonly refraction: RefractionParameters | false
}

// Physical-frame context of one exposure: its ERFA astrometry parameters and local horizon basis.
export interface IPolarFrameContext {
	// Star-independent ERFA parameters for ICRS ⇄ observed at the exposure instant.
	readonly astrom: EraAstrom
	// Local north (horizontal), in ITRS.
	readonly north: Vec3
	// Local east, in ITRS.
	readonly east: Vec3
	// Local up (geodetic normal), in ITRS.
	readonly up: Vec3
}

// Signed decomposition of the angle from the target pole to the mechanical axis.
export interface IPolarError {
	// Great-circle separation between the axis and the target, in radians, [0, π).
	readonly total: Angle
	// On-sky component towards local east at the target, in radians: positive when the axis lies
	// east of the pole, in either hemisphere.
	readonly azimuth: Angle
	// On-sky component towards the zenith at the target, in radians: positive when the axis lies
	// above the pole.
	readonly altitude: Angle
}

// Where a physical direction falls in a solved frame. Points are FITS 1-based pixels.
export type IPolarProjection =
	// Inside the image.
	| { readonly kind: 'visible'; readonly position: Point }
	// Outside the image; `border` is where the line from the image center towards it leaves the
	// image, and `direction` the unit pixel direction of that line.
	| { readonly kind: 'offscreen'; readonly position: Point; readonly border: Point; readonly direction: Point }
	// Behind the tangent plane of the WCS, or not finite: no pixel represents it.
	| { readonly kind: 'unprojectable' }

// Builds the ERFA context of an exposure at `time` (its mid-exposure instant) for the observer.
// The Earth ephemeris comes from eraEpv00 at TDB, so the context costs one ephemeris evaluation.
export function ipolarFrameContext(time: Time, observer: IPolarObserver): IPolarFrameContext {
	const { location, refraction } = observer
	const a = tt(time)
	const b = ut1(time)
	const c = tdb(time)
	const [sp, xp, yp] = pmAngles(time)
	const { radius, flattening } = ELLIPSOID_PARAMETERS[location.ellipsoid ?? Ellipsoid.IERS2010]
	const pressure = refraction === false ? 0 : (refraction.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure)
	const temperature = refraction === false ? 0 : (refraction.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature)
	const humidity = refraction === false ? 0 : (refraction.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity)
	const wavelength = refraction === false ? 0 : (refraction.wl ?? DEFAULT_REFRACTION_PARAMETERS.wl)
	const [bary, helio] = eraEpv00(c.day, c.fraction)
	const astrom = eraApco13(a.day, a.fraction, b.day, b.fraction, location.longitude, location.latitude, location.elevation, xp, yp, sp, pressure, temperature, humidity, wavelength, bary, helio[0], radius, flattening)
	return { astrom, ...horizonBasis(location) }
}

// FITS 1-based pixels of the sample grid for an image of `width` × `height` pixels, row by row from
// the first pixel row. The same pixels are used for every frame of a session, so equal indices are
// the same sensor ray.
export function ipolarSamplePixels(width: number, height: number): readonly Point[] {
	const pixels: Point[] = []
	const span = 1 - 2 * IPOLAR_SAMPLE_INSET

	for (let j = 0; j < IPOLAR_SAMPLE_GRID; j++) {
		const y = 0.5 + height * (IPOLAR_SAMPLE_INSET + (span * j) / (IPOLAR_SAMPLE_GRID - 1))

		for (let i = 0; i < IPOLAR_SAMPLE_GRID; i++) {
			const x = 0.5 + width * (IPOLAR_SAMPLE_INSET + (span * i) / (IPOLAR_SAMPLE_GRID - 1))
			pixels.push({ x, y })
		}
	}

	return pixels
}

// Physical ITRS unit directions of the sample grid of `solution` (see ipolarSamplePixels) at the
// exposure of `context`, in grid order. Returns undefined when any sample cannot be unprojected or
// is not finite, so a partial grid never pairs different sensor rays.
export function ipolarEarthFixedRays(solution: PlateSolution, context: IPolarFrameContext): Vec3[] | undefined {
	const pixels = ipolarSamplePixels(solution.widthInPixels, solution.heightInPixels)
	const rays: Vec3[] = new Array(pixels.length)

	for (let i = 0; i < pixels.length; i++) {
		const sky = tanUnproject(solution, pixels[i].x, pixels[i].y)
		if (sky === undefined) return undefined
		const ray = ipolarIcrsToItrs(sky[0], sky[1], context)
		if (ray === undefined) return undefined
		rays[i] = ray
	}

	return rays
}

// Physical ITRS unit direction of the light arriving from astrometric ICRS (rightAscension,
// declination), in radians, at the exposure of `context`. Undefined when not finite.
export function ipolarIcrsToItrs(rightAscension: Angle, declination: Angle, context: IPolarFrameContext): MutVec3 | undefined {
	const [ri, di] = eraAtciqz(rightAscension, declination, context.astrom)
	const [azimuth, zenith] = eraAtioq(ri, di, context.astrom)
	const ray = horizontalToItrs(azimuth, PIOVERTWO - zenith, context)
	return Number.isFinite(ray[0]) && Number.isFinite(ray[1]) && Number.isFinite(ray[2]) ? ray : undefined
}

// Astrometric ICRS [rightAscension, declination], in radians, at which a star would appear along
// the physical ITRS unit `direction` at the exposure of `context`; the inverse of ipolarIcrsToItrs.
export function ipolarItrsToIcrs(direction: Vec3, context: IPolarFrameContext): readonly [Angle, Angle] {
	const n = vecDot(direction, context.north)
	const e = vecDot(direction, context.east)
	const u = vecDot(direction, context.up)
	const azimuth = Math.atan2(e, n)
	const zenith = Math.atan2(Math.hypot(n, e), u)
	const [ri, di] = eraAtoiq('A', azimuth, zenith, context.astrom)
	return eraAticq(ri, di, context.astrom)
}

// Physical ITRS unit direction the mechanical RA axis should point to at the exposure of `context`:
// the celestial intermediate pole of the hemisphere of the site (polar motion included, the north
// pole for latitude ≥ 0), raised to its apparent altitude by the observer's refraction, or the
// geometric pole when refraction is false.
export function ipolarTargetPole(time: Time, observer: IPolarObserver, context: IPolarFrameContext): MutVec3 {
	const north = observer.location.latitude >= 0
	const pole = matMulVec(pmMatrix(time), [0, 0, north ? 1 : -1])
	if (observer.refraction === false) return pole

	const n = vecDot(pole, context.north)
	const e = vecDot(pole, context.east)
	const altitude = Math.atan2(vecDot(pole, context.up), Math.hypot(n, e))
	return horizontalToItrs(Math.atan2(e, n), refractedAltitude(altitude, observer.refraction), context)
}

// Decomposes the angle from the `target` pole to the mechanical `axis` (ITRS unit vectors) with the
// spherical logarithm at the target, projected on the local east and zenith tangents there.
// Returns undefined for antipodal geometry or a target at the zenith, where the altitude tangent
// is undefined.
export function ipolarError(axis: Vec3, target: Vec3, context: IPolarFrameContext): IPolarError | undefined {
	const east = tangentAt(context.east, target)
	if (east === undefined) return undefined
	const zenith = tangentAt(context.up, target, east)
	if (zenith === undefined) return undefined

	const total = vecAngleUnit(target, axis)
	if (!(total < Math.PI - TANGENT_EPSILON)) return undefined
	if (total === 0) return { total, azimuth: 0, altitude: 0 }

	const dot = vecDot(target, axis)
	const scale = total < 1e-6 ? 1 + (total * total) / 6 : total / Math.sin(total)
	const x = scale * (axis[0] - dot * target[0])
	const y = scale * (axis[1] - dot * target[1])
	const z = scale * (axis[2] - dot * target[2])
	return { total, azimuth: x * east[0] + y * east[1] + z * east[2], altitude: x * zenith[0] + y * zenith[1] + z * zenith[2] }
}

// Projects the physical ITRS unit `direction` into the FITS pixels of `solution` at the exposure of
// `context`. An off-image point keeps its position and gets the border crossing of the line from
// the image center towards it.
export function ipolarProject(direction: Vec3, solution: PlateSolution, context: IPolarFrameContext): IPolarProjection {
	const [rightAscension, declination] = ipolarItrsToIcrs(direction, context)
	const pixel = tanProject(solution, rightAscension, declination)
	if (pixel === undefined || !Number.isFinite(pixel[0]) || !Number.isFinite(pixel[1])) return { kind: 'unprojectable' }

	const point = projectPolarAlignmentOverlayPoint({ x: pixel[0], y: pixel[1] }, { x: 0.5, y: 0.5, width: solution.widthInPixels, height: solution.heightInPixels })
	if (point === undefined) return { kind: 'unprojectable' }
	if (point.onScreen) return { kind: 'visible', position: point.position }
	return { kind: 'offscreen', position: point.position, border: point.display, direction: point.direction }
}

// Local north, east and up of a geodetic site, in ITRS.
function horizonBasis({ longitude, latitude }: GeographicPosition) {
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)
	const sinLon = Math.sin(longitude)
	const cosLon = Math.cos(longitude)
	const north: Vec3 = [-sinLat * cosLon, -sinLat * sinLon, cosLat]
	const east: Vec3 = [-sinLon, cosLon, 0]
	const up: Vec3 = [cosLat * cosLon, cosLat * sinLon, sinLat]
	return { north, east, up } as const
}

// ITRS unit vector of a local horizontal direction: azimuth from north through east and altitude,
// in radians.
function horizontalToItrs(azimuth: Angle, altitude: Angle, { north, east, up }: Pick<IPolarFrameContext, 'north' | 'east' | 'up'>): MutVec3 {
	const n = Math.cos(altitude) * Math.cos(azimuth)
	const e = Math.cos(altitude) * Math.sin(azimuth)
	const u = Math.sin(altitude)
	return [north[0] * n + east[0] * e + up[0] * u, north[1] * n + east[1] * e + up[1] * u, north[2] * n + east[2] * e + up[2] * u]
}

// Unit component of `vector` tangent to the sphere at the unit `point`, also orthogonal to the unit
// `other` when given; undefined when that component vanishes.
function tangentAt(vector: Vec3, point: Vec3, other?: Vec3): MutVec3 | undefined {
	const p = vecDot(vector, point)
	const tangent: MutVec3 = [vector[0] - p * point[0], vector[1] - p * point[1], vector[2] - p * point[2]]

	if (other !== undefined) {
		const o = vecDot(tangent, other)
		tangent[0] -= o * other[0]
		tangent[1] -= o * other[1]
		tangent[2] -= o * other[2]
	}

	return vecLength(tangent) > TANGENT_EPSILON ? vecNormalizeMut(tangent) : undefined
}
