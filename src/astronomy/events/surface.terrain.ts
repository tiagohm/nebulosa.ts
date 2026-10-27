import { PI, TAU } from '../../core/constants'
import { validatePositiveFinite, validatePositiveInteger } from '../../core/validation'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDivScalarMut, vecDot, vecLatitude, vecLength, vecLongitude, vecMinus, vecMulScalar, vecNormalizeMut, vecZero } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { brentRoot } from '../../math/numerical/optimization'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { Frame } from '../coordinates/frame'
import { bodyFixedPosition, type BodyShape, type BodySurfaceLocation, bodySurfaceLocation } from '../observer/body'
import type { HorizonSample } from '../observer/horizon'
import type { SurfaceFeature } from './surface'

// Terrain relief for surface-feature illumination from a caller-supplied digital elevation model
// (DEM) on a body-fixed planetocentric longitude/latitude grid. Grid nodes are cell centers; each
// value is a radial elevation in AU above the same reference tri-axial ellipsoid as the feature's
// BodySurfaceLocation (for lunar LOLA products, a 1737.4 km sphere). Elevations are interpolated
// bilinearly in longitude/latitude index space; a grid spanning a full turn of longitude wraps, and
// values within half a step outside the first or last node are held at the edge, so a global
// cell-centered grid reaches the poles. NaN marks missing data.
//
// From a feature prepared by surfaceFeature, the module derives the terrain horizon mask by marching
// the feature's vertical plane toward each azimuth (so samples keep their azimuth on tri-axial
// bodies), never below the limb of the body's lowest surface; the facet slope/aspect by central
// differences in the same planes; and the first terrain crossing of a straight ray toward a local
// altitude/azimuth, which gives point-Sun shadowing and the cast-shadow length of a summit. On a
// sphere the planes pass through the center and are sampled along radial rays; on other shapes each
// sample is the highest terrain crossing of a vertical line, bracketed and refined so no point off
// the terrain is ever reported. Rays and horizon profiles sample the terrain at a fixed step, so
// relief narrower than the step or the grid spacing can be missed or smoothed; results are no
// better than the DEM resolution and its own accuracy. Off the grid and on NaN cells the reference surface
// (zero elevation) stands in, which horizon samples report as incomplete. The Sun is a point at the
// direction supplied: penumbra from its finite disk is not modeled. Nothing here mutates the grid or
// the feature; the grid is never copied, and each march reuses scalar workspaces only. Sample
// counts are bounded (MAX_RAY_SAMPLES per ray or azimuth, MAX_HORIZON_SAMPLES per horizon) so a
// tiny step or a huge azimuth count fails fast instead of scanning without practical bound.

// A gridded DEM in body-fixed planetocentric coordinates. Node (column i, row j) is the center of a
// cell at longitude + i·longitudeStep and latitude + j·latitudeStep, stored row-major at
// elevations[j·width + i]. The grid is caller-owned and read in place.
export interface ElevationGrid {
	// Radial elevations above the reference ellipsoid in AU, row-major, width·height values; NaN
	// marks missing data.
	readonly elevations: Float32Array | Float64Array
	// Number of columns (longitude nodes), at least 1.
	readonly width: number
	// Number of rows (latitude nodes), at least 1.
	readonly height: number
	// East-positive planetocentric longitude of column 0, radians.
	readonly longitude: Angle
	// Planetocentric latitude of row 0, radians.
	readonly latitude: Angle
	// Signed longitude increment between columns, radians; positive runs east. Its magnitude is the
	// grid's longitude resolution.
	readonly longitudeStep: Angle
	// Signed latitude increment between rows, radians; negative for north-up rasters. Its magnitude is
	// the grid's latitude resolution.
	readonly latitudeStep: Angle
	// Provenance of the elevations, such as the product name, version, reference radius and any
	// resampling applied, carried for reporting.
	readonly source: string
}

// A DEM prepared once for repeated terrain queries. The grid is referenced, not copied.
export interface TerrainModel {
	// The caller's grid.
	readonly grid: ElevationGrid
	// Whether the columns span a full turn of longitude, so interpolation wraps from the last
	// column back to the first.
	readonly wrapsLongitude: boolean
	// Lowest finite elevation in the grid, AU; zero for a grid without finite values.
	readonly minimumElevation: Distance
	// Highest finite elevation in the grid, AU; zero for a grid without finite values.
	readonly maximumElevation: Distance
	// Finest angular grid step, the smaller of |longitudeStep| and |latitudeStep|, radians. Times the
	// body radius it is the ground resolution along a meridian, and along a parallel at the equator.
	readonly spacing: Angle
}

// Facet orientation derived from a DEM, ready to spread into SurfaceFeatureOptions.
export interface TerrainFacet {
	// Facet tilt from the local zenith, radians in [0, PI/2] for a single-valued surface.
	readonly slope: Angle
	// Local azimuth the facet faces (its down-slope direction), north through east, radians in
	// [0, TAU); zero on a level facet.
	readonly aspect: Angle
}

// A terrain horizon sample with the geometry that set it.
export interface TerrainHorizonSample extends HorizonSample {
	// Distance from the feature to the point that sets the horizon, AU, measured as the march measures
	// it (see TerrainHorizonOptions.step): an arc at the vantage radius on a sphere, a horizontal
	// distance on other shapes. When no terrain sample rises above the body's own limb, it is the
	// distance to that limb, zero for a vantage on a smooth sphere.
	readonly distance: Distance
	// Whether every sample along this azimuth came from finite DEM data; false when the march left
	// the grid or crossed NaN cells and the reference surface was used there.
	readonly complete: boolean
}

// Controls for terrainHorizon.
export interface TerrainHorizonOptions {
	// Number of azimuths, a positive integer, evenly spaced from north through east starting at zero;
	// defaults to 360.
	readonly azimuths?: number
	// Distance between samples along each azimuth, AU; defaults to half the ground spacing (spacing ×
	// feature radius / 2). On a sphere, or when the vantage's zenith passes through the body center,
	// it is an arc at the vantage's distance from the center; otherwise it is a horizontal distance
	// along the azimuth in the vantage's tangent plane. Ridges narrower than the step can be missed.
	readonly step?: Distance
	// Distance, measured like step, at which the march stops, AU, with the last sample exactly there. Defaults to
	// the reach beyond which terrain within the grid's elevation range is hidden by the body itself
	// (from spheres through the smallest and largest semi-axes offset by the elevation extremes);
	// capped at half a turn of section angle.
	readonly maxDistance?: Distance
}

// Controls for terrain ray intersections.
export interface TerrainRayOptions {
	// Distance between samples along the ray, AU; defaults to half the ground spacing
	// (spacing × feature radius / 2). Obstacles thinner than the step can be missed.
	readonly step?: Distance
	// Range at which the ray stops, AU. Defaults to its exit from the sphere through the largest
	// semi-axis plus the highest elevation, beyond which no terrain can be hit.
	readonly maxDistance?: Distance
}

// The first terrain crossing of a ray from a surface feature.
export interface TerrainRayHit {
	// Straight-line distance from the feature point to the crossing along the ray, AU.
	readonly range: Distance
	// Surface distance from the feature to the crossing, AU: the feature's reference radius times
	// the central angle between them. For a shadow tip this is the cast-shadow length.
	readonly distance: Distance
	// East-positive planetocentric longitude of the crossing, radians in [0, TAU).
	readonly longitude: Angle
	// Planetocentric latitude of the crossing, radians.
	readonly latitude: Angle
	// Terrain elevation at the crossing, AU; zero where the reference surface stood in for missing data.
	readonly elevation: Distance
}

// Prepares a DEM for terrain queries with one pass over its elevations for the finite extremes.
// Longitude wraps when width·|longitudeStep| equals a full turn to within a millionth of a step.
// Does not copy or mutate the grid; later edits to its elevations are seen, but not by the cached
// extremes.
export function terrainModel(grid: ElevationGrid): TerrainModel {
	const { elevations } = grid
	let minimumElevation = Number.POSITIVE_INFINITY
	let maximumElevation = Number.NEGATIVE_INFINITY

	for (let i = 0; i < elevations.length; i++) {
		const value = elevations[i]
		if (value < minimumElevation) minimumElevation = value
		if (value > maximumElevation) maximumElevation = value
	}

	if (!(minimumElevation <= maximumElevation)) minimumElevation = maximumElevation = 0

	const step = Math.abs(grid.longitudeStep)
	const wrapsLongitude = Math.abs(grid.width * step - TAU) <= 1e-6 * step
	return { grid, wrapsLongitude, minimumElevation, maximumElevation, spacing: Math.min(step, Math.abs(grid.latitudeStep)) }
}

// Bilinear elevation (AU) at a planetocentric longitude/latitude (radians); NaN off the grid or when
// any of the four supporting nodes is NaN. Hot path: no allocation.
function sampleElevation(model: TerrainModel, longitude: Angle, latitude: Angle) {
	const { grid } = model
	const { width, height, elevations } = grid

	let y = (latitude - grid.latitude) / grid.latitudeStep
	if (!(y >= -0.5 && y <= height - 0.5)) return Number.NaN
	y = clamp(y, 0, height - 1)

	const step = Math.abs(grid.longitudeStep)
	let x = normalizeAngle(grid.longitudeStep >= 0 ? longitude - grid.longitude : grid.longitude - longitude) / step
	let x0: number
	let x1: number

	if (model.wrapsLongitude) {
		x0 = Math.floor(x)
		x -= x0
		x0 %= width
		x1 = x0 + 1 === width ? 0 : x0 + 1
	} else {
		// Longitudes just west of column 0 normalize to nearly a full turn; bring them back.
		if (x > width - 0.5) x -= TAU / step
		if (!(x >= -0.5 && x <= width - 0.5)) return Number.NaN
		x = clamp(x, 0, width - 1)
		x0 = Math.floor(x)
		x -= x0
		x1 = Math.min(x0 + 1, width - 1)
	}

	const y0 = Math.floor(y)
	const y1 = Math.min(y0 + 1, height - 1)
	const fy = y - y0
	const r0 = y0 * width
	const r1 = y1 * width
	const lower = elevations[r0 + x0] + (elevations[r0 + x1] - elevations[r0 + x0]) * x
	const upper = elevations[r1 + x0] + (elevations[r1 + x1] - elevations[r1 + x0]) * x
	return lower + (upper - lower) * fy
}

// Bilinear DEM elevation (AU) at a planetocentric east-positive longitude and latitude (radians), or
// undefined off the grid or next to missing data.
export function terrainElevation(model: TerrainModel, longitude: Angle, latitude: Angle): Distance | undefined {
	const elevation = sampleElevation(model, longitude, latitude)
	return Number.isNaN(elevation) ? undefined : elevation
}

// Creates a BodySurfaceLocation standing on the DEM: its elevation is the interpolated terrain
// elevation plus height (AU, default zero). shape must be the reference the DEM elevations are
// measured from. Returns undefined off the grid or next to missing data. Allocates a new location.
export function terrainSurfaceLocation(model: TerrainModel, longitude: Angle, latitude: Angle, shape: BodyShape, frame: Frame, height: Distance = 0): BodySurfaceLocation | undefined {
	const elevation = sampleElevation(model, longitude, latitude)
	return Number.isNaN(elevation) ? undefined : bodySurfaceLocation(longitude, latitude, elevation + height, shape, frame)
}

// Reference-ellipsoid radius (AU) along a body-fixed unit direction, from precomputed inverse
// squared semi-axes.
function referenceRadius(ia: number, ib: number, ic: number, x: number, y: number, z: number) {
	return 1 / Math.sqrt(x * x * ia + y * y * ib + z * z * ic)
}

// Inverse squared semi-axes of a shape, for referenceRadius.
function inverseSquaredRadii(shape: BodyShape) {
	const [a, b, c] = shape.radii
	return [1 / (a * a), 1 / (b * b), 1 / (c * c)] as const
}

// Radius (AU) of a sphere enclosing the terrain: the largest semi-axis plus the higher of the
// grid's maximum elevation and the zero-elevation stand-in for missing data.
function outerRadius(model: TerrainModel, shape: BodyShape) {
	const [a, b, c] = shape.radii
	return Math.max(a, b, c) + Math.max(model.maximumElevation, 0)
}

// Most terrain samples one horizon azimuth or one ray may take; pass a longer step or shorter
// maxDistance to stay below it.
const MAX_RAY_SAMPLES = 1e6

// Most terrain samples one terrainHorizon call may take (azimuths × samples per azimuth), which keeps
// a call to seconds rather than an unbounded scan.
const MAX_HORIZON_SAMPLES = 1e8

// The vertical plane through a feature toward one local azimuth: spanned by the feature's zenith
// and the horizontal direction h at that azimuth. Its points are offset·normal + ρ·(cos θ·a + sin θ·b),
// where a and b are orthonormal in the parallel plane through the body center, a toward the feature
// and b toward the azimuth. Every point of the plane seen from the feature lies at that azimuth, even
// on a tri-axial body, where great circles through the radial direction would drift off it.
interface VerticalSection {
	// Unit plane normal, horizontal and perpendicular to the azimuth, body-fixed axes.
	readonly normal: Vec3
	// Signed distance of the plane from the body center along normal, AU; zero on a sphere.
	readonly offset: Distance
	// Unit in-plane direction from the section center toward the feature, body-fixed axes.
	readonly a: Vec3
	// Unit in-plane direction perpendicular to a, toward the azimuth, body-fixed axes.
	readonly b: Vec3
	// Unit horizontal direction toward the azimuth in the feature's tangent plane, body-fixed axes.
	readonly h: Vec3
	// Distance of the feature from the section center (offset·normal), AU.
	readonly range: Distance
}

// Builds the vertical section of a feature toward azimuth (radians, north through east). point is
// the feature's body-fixed position (AU). Allocates the section.
function verticalSection(feature: SurfaceFeature, point: Vec3, azimuth: Angle): VerticalSection {
	const { up, north, east } = feature
	const cosAzimuth = Math.cos(azimuth)
	const sinAzimuth = Math.sin(azimuth)
	const h: MutVec3 = [cosAzimuth * north[0] + sinAzimuth * east[0], cosAzimuth * north[1] + sinAzimuth * east[1], cosAzimuth * north[2] + sinAzimuth * east[2]]
	// h and up are orthonormal, so h × up is already a unit vector.
	const normal = vecCross(h, up)
	const offset = vecDot(normal, point)
	const a = vecMulScalar(normal, offset)
	vecMinus(point, a, a)
	const range = vecLength(a)
	vecDivScalarMut(a, range)
	const b = vecMulScalar(a, vecDot(h, a))
	vecNormalizeMut(vecMinus(h, b, b))
	return { normal, offset, a, b, h, range }
}

// Section offset, relative to the vantage's distance from the body center, below which a vertical
// section is taken to pass through the center; also the relative size of the solver's root bracket.
const SECTION_TOLERANCE = 1e-12

// Number of evenly spaced heights at which a vertical line is scanned, top down, for its first
// terrain crossing before Brent's method refines it. The scan spans the shell between the scaled
// reference ellipsoids that enclose the terrain, so relief giving one line several crossings closer
// than that shell's height / VERTICAL_SCAN can be read at a lower crossing.
const VERTICAL_SCAN = 8

// Terrain points on the vertical sections of one feature, with workspaces reused across the samples
// of one call. Sections through the body center (every section on a sphere, or every section when
// the vantage's zenith passes through the center) are sampled exactly along radial rays at a section
// angle θ, in one DEM lookup. Other sections are sampled on vertical lines (parallel to the vantage's
// zenith) at a horizontal offset s along the azimuth. On such a line the altitude seen from the
// vantage grows with height, so its highest terrain crossing is the one that can set the horizon. That
// crossing is bracketed by the scaled reference ellipsoids enclosing the terrain from inside and
// outside, scanned top down and refined by Brent's method, so a returned point always lies between a
// point above and a point below the terrain, within the solver tolerance; a line that meets no
// terrain returns undefined instead of a point. Missing data uses the zero-elevation reference.
function sectionSampler(model: TerrainModel, feature: SurfaceFeature) {
	const { up, location } = feature
	const point = bodyFixedPosition(location)
	const shape = location.shape
	const [ia, ib, ic] = inverseSquaredRadii(shape)
	const minimumAxis = Math.min(shape.radii[0], shape.radii[1], shape.radii[2])
	// Scaling the reference by these factors gives radii at most ref + the lowest elevation and at
	// least ref + the highest one in every direction (ref ≥ minimumAxis), zero standing in for gaps.
	const innerScale = 1 + Math.min(model.minimumElevation, 0) / minimumAxis
	const outerScale = 1 + Math.max(model.maximumElevation, 0) / minimumAxis
	const tolerance = SECTION_TOLERANCE * vecLength(point)
	const brent = { tolerance, functionTolerance: tolerance }
	const foot = vecZero()
	const roots = new Float64Array(2)
	let elevation = 0

	// Radius residual (AU) at height lambda on the vertical line through foot: the distance from the
	// body center minus the terrain radius in that direction. Positive above the terrain; stores the
	// DEM elevation, NaN off the grid or next to missing data.
	function residual(lambda: number) {
		const x = foot[0] + lambda * up[0]
		const y = foot[1] + lambda * up[1]
		const z = foot[2] + lambda * up[2]
		const r = Math.hypot(x, y, z)
		elevation = sampleElevation(model, Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y)))
		return r - referenceRadius(ia, ib, ic, x / r, y / r, z / r) - (Number.isNaN(elevation) ? 0 : elevation)
	}

	// Heights (AU, ascending, into roots) where the vertical line through foot meets the reference
	// ellipsoid scaled by scale; false when it misses. Uses the cancellation-free quadratic roots.
	function ellipsoidRoots(scale: number) {
		const s2 = scale * scale
		const wa = ia / s2
		const wb = ib / s2
		const wc = ic / s2
		const quadratic = up[0] * up[0] * wa + up[1] * up[1] * wb + up[2] * up[2] * wc
		const linear = foot[0] * up[0] * wa + foot[1] * up[1] * wb + foot[2] * up[2] * wc
		const constant = foot[0] * foot[0] * wa + foot[1] * foot[1] * wb + foot[2] * foot[2] * wc - 1
		const discriminant = linear * linear - quadratic * constant
		if (!(discriminant >= 0)) return false
		const q = -(linear + (linear >= 0 ? 1 : -1) * Math.sqrt(discriminant))
		const first = q / quadratic
		const second = q !== 0 ? constant / q : first
		roots[0] = Math.min(first, second)
		roots[1] = Math.max(first, second)
		return true
	}

	// Terrain point (AU, into out) on a section through the center at section angle θ, given by its
	// cosine and sine. Returns the DEM elevation, NaN where the reference surface stood in.
	function radial(section: VerticalSection, cosAngle: number, sinAngle: number, out: MutVec3) {
		const { a, b } = section
		const ux = cosAngle * a[0] + sinAngle * b[0]
		const uy = cosAngle * a[1] + sinAngle * b[1]
		const uz = cosAngle * a[2] + sinAngle * b[2]
		const value = sampleElevation(model, Math.atan2(uy, ux), Math.atan2(uz, Math.hypot(ux, uy)))
		const r = referenceRadius(ia, ib, ic, ux, uy, uz) + (Number.isNaN(value) ? 0 : value)
		out[0] = r * ux
		out[1] = r * uy
		out[2] = r * uz
		return value
	}

	// Highest terrain point (AU, into out) on the vertical line at horizontal offset s (AU, signed)
	// along h from the vantage. Returns the DEM elevation there, NaN where the reference surface
	// stood in, or undefined when the line meets no terrain. At most VERTICAL_SCAN + 2 residuals plus
	// Brent's bracketed refinement; throws only if that refinement fails to converge.
	function vertical(h: Vec3, s: Distance, out: MutVec3) {
		foot[0] = point[0] + s * h[0]
		foot[1] = point[1] + s * h[1]
		foot[2] = point[2] + s * h[2]
		if (!ellipsoidRoots(outerScale)) return undefined
		const top = roots[1]
		let bottom = roots[0]
		if (innerScale > 0 && ellipsoidRoots(innerScale)) bottom = roots[1]
		let lambda = top

		if (top - bottom > tolerance) {
			let upper = top
			let upperResidual = residual(top)
			let found = false

			for (let j = 1; j <= VERTICAL_SCAN; j++) {
				const lower = top - ((top - bottom) * j) / VERTICAL_SCAN
				const lowerResidual = residual(lower)

				if (lowerResidual <= 0) {
					if (upperResidual <= 0) {
						lambda = upper
					} else {
						const result = brentRoot(residual, lower, upper, brent)
						if (!result.converged) throw new Error('terrain section root did not converge')
						lambda = result.root
					}
					found = true
					break
				}

				upper = lower
				upperResidual = lowerResidual
			}

			if (!found) return undefined
		}

		// Re-evaluate at the emitted point so its elevation matches it.
		residual(lambda)
		out[0] = foot[0] + lambda * up[0]
		out[1] = foot[1] + lambda * up[1]
		out[2] = foot[2] + lambda * up[2]
		return elevation
	}

	return { point, tolerance, radial, vertical }
}

// Altitude (radians) above the feature's reference tangent plane of the direction from point to
// target, both body-fixed AU; the zenith-or-nadir and coincident cases return ±PI/2 or zero.
function altitudeFrom(up: Vec3, point: Vec3, target: Vec3) {
	const wx = target[0] - point[0]
	const wy = target[1] - point[1]
	const wz = target[2] - point[2]
	const vertical = wx * up[0] + wy * up[1] + wz * up[2]
	return Math.atan2(vertical, Math.sqrt(Math.max(wx * wx + wy * wy + wz * wz - vertical * vertical, 0)))
}

// Number of samples, endpoint included, for a march of length span (AU) at stride; throws RangeError
// when that exceeds MAX_RAY_SAMPLES, which would scan without practical bound. A non-positive or NaN
// span has none.
function raySampleCount(span: number, stride: number) {
	if (!(span > 0)) return 0
	const count = Math.ceil(span / stride)
	if (!(count <= MAX_RAY_SAMPLES)) throw new RangeError(`terrain march needs more than ${MAX_RAY_SAMPLES} samples; increase step or reduce maxDistance`)
	return count
}

// Terrain horizon mask of a feature, by marching the DEM. The vantage point is the feature's
// body-fixed position, so build its location with terrainSurfaceLocation (optionally with a small
// height) to stand on the terrain. Along each azimuth the march samples the terrain in the feature's
// vertical plane toward that azimuth, so every sample is seen at that azimuth on a tri-axial body
// too. On a sphere (or whenever the vantage's zenith passes through the body center) distances along
// an azimuth are arcs at the vantage's distance from the center; on other shapes they are horizontal
// distances along the azimuth in the vantage's tangent plane, where each sample is the highest
// terrain on the vertical line there (see sectionSampler). The march samples every step out to
// maxDistance, the last sample landing exactly there, and keeps the highest altitude above the
// feature's reference tangent plane, with curvature included; the first sample is a full step out,
// so ground curving away from the vantage reads up to about step / (2 × curvature radius) low, and a
// smooth convex body never gives a positive horizon. The mask never drops below the limb of the
// body's lowest possible surface (smallest semi-axis plus the lowest elevation) seen from the vantage
// in that plane: zero for a vantage on a smooth sphere and -acos(R / (R + h)) at height h, whatever
// the step. The DEM elevations must be relative to feature.location.shape. Returns options.azimuths
// fresh samples ordered by azimuth, directly usable as SurfaceFeatureOptions.horizon. Throws for a
// non-integer or non-positive azimuth count, a non-positive or non-finite step, or a march over
// MAX_RAY_SAMPLES samples per azimuth or MAX_HORIZON_SAMPLES in total, which would never finish or
// scan without practical bound. Cost is azimuths × maxDistance / step samples: one DEM lookup each
// through the center, up to about VERTICAL_SCAN + 40 on other sections.
export function terrainHorizon(model: TerrainModel, feature: SurfaceFeature, { azimuths = 360, step, maxDistance }: TerrainHorizonOptions = {}): TerrainHorizonSample[] {
	validatePositiveInteger(azimuths)
	const stride = validatePositiveFinite(step ?? (model.spacing * feature.radius) / 2)
	const { up, location } = feature
	const shape = location.shape
	const sampler = sectionSampler(model, feature)
	const { point } = sampler
	const inner = Math.min(shape.radii[0], shape.radii[1], shape.radii[2]) + Math.min(model.minimumElevation, 0)
	const outer = outerRadius(model, shape)

	// A section's offset is at most the vantage's distance from its zenith line through the center;
	// when that is negligible, every section passes through the center and is sampled radially.
	const distance2 = vecDot(point, point)
	const along = vecDot(point, up)
	const offsetBound = Math.sqrt(Math.max(distance2 - along * along, 0))
	const radial = offsetBound <= sampler.tolerance

	// Bound the work before any march. Through the center the default reach is at most the bound
	// angle times the vantage distance; other sections march horizontally at most across the outer
	// sphere, 2 × outer + the vantage distance.
	const reachBound = sectionReach(inner, outer, offsetBound, Math.sqrt(Math.max(distance2 - offsetBound * offsetBound, 0)))
	const lengthBound = maxDistance ?? (radial ? Math.min(reachBound, PI) * Math.sqrt(distance2) : 2 * outer + Math.sqrt(distance2))
	const countBound = raySampleCount(lengthBound, stride)
	if (!(countBound * azimuths <= MAX_HORIZON_SAMPLES)) throw new RangeError(`terrain horizon needs more than ${MAX_HORIZON_SAMPLES} samples; increase step, reduce azimuths or reduce maxDistance`)

	const samples: TerrainHorizonSample[] = []
	const terrain = vecZero()

	for (let i = 0; i < azimuths; i++) {
		const azimuth = (i * TAU) / azimuths
		const section = verticalSection(feature, point, azimuth)
		const { range, offset, a, b, h } = section

		// Limb of the inner circle of this section: rays below it enter the solid body.
		const innerCircle = Math.sqrt(Math.max(inner * inner - offset * offset, 0))
		const limb = Math.acos(clamp(innerCircle / range, -1, 1))
		let best: number
		let bestDistance = 0

		if (limb > 0) {
			const c = innerCircle * Math.cos(limb)
			const s = innerCircle * Math.sin(limb)
			terrain[0] = offset * section.normal[0] + c * a[0] + s * b[0]
			terrain[1] = offset * section.normal[1] + c * a[1] + s * b[1]
			terrain[2] = offset * section.normal[2] + c * a[2] + s * b[2]
			best = altitudeFrom(up, point, terrain)
			bestDistance = radial ? limb * range : (terrain[0] - point[0]) * h[0] + (terrain[1] - point[1]) * h[1] + (terrain[2] - point[2]) * h[2]
		} else {
			// The vantage is on the inner circle: its limb is the section's tangent there.
			best = Math.asin(clamp(vecDot(b, up), -1, 1))
		}

		let complete = true
		const reach = sectionReach(inner, outer, offset, range)

		if (radial) {
			// Section angles: every step, ending exactly at the limit.
			const delta = stride / range
			const limit = Math.min(maxDistance === undefined ? reach : maxDistance / range, PI)
			const steps = raySampleCount(limit, delta)

			for (let k = 1; k <= steps; k++) {
				const angle = Math.min(k * delta, limit)
				if (Number.isNaN(sampler.radial(section, Math.cos(angle), Math.sin(angle), terrain))) complete = false
				const altitude = altitudeFrom(up, point, terrain)

				if (altitude > best) {
					best = altitude
					bestDistance = angle * range
				}
			}
		} else {
			// Horizontal offsets: every step, ending exactly at the limit. By default the limit bounds
			// the horizontal offset of any section point within the reach angle of the outer circle.
			const outerCircle = Math.sqrt(Math.max(outer * outer - offset * offset, 0))
			const ah = Math.abs(vecDot(a, h))
			const limit = maxDistance ?? outerCircle * (Math.sin(Math.min(reach, PI / 2)) * vecDot(b, h) + ah) + range * ah
			const steps = raySampleCount(limit, stride)

			for (let k = 1; k <= steps; k++) {
				const s = Math.min(k * stride, limit)
				const value = sampler.vertical(h, s, terrain)
				if (value === undefined) continue
				if (Number.isNaN(value)) complete = false
				const altitude = altitudeFrom(up, point, terrain)

				if (altitude > best) {
					best = altitude
					bestDistance = s
				}
			}
		}

		samples.push({ azimuth, minimumAltitude: best, distance: bestDistance, complete })
	}

	return samples
}

// Section angle (radians) beyond which terrain cannot set a horizon: the vantage's tangent to the
// inner circle of the section plus the outer circle's tangent beyond it. inner and outer are sphere
// radii (AU) bounding the solid body and the terrain; offset is the section's distance from the
// body center and range the vantage's distance from the section center (AU).
function sectionReach(inner: Distance, outer: Distance, offset: Distance, range: Distance) {
	const innerCircle = Math.sqrt(Math.max(inner * inner - offset * offset, 0))
	const outerCircle = Math.sqrt(Math.max(outer * outer - offset * offset, 0))
	return Math.acos(clamp(innerCircle / range, -1, 1)) + Math.acos(clamp(innerCircle / outerCircle, -1, 1))
}

// Facet slope and aspect of the DEM at a feature, from the normal of the two central-difference
// chords between terrain points baseline (AU) north/south and east/west of it, each in the feature's
// vertical plane toward that azimuth and found as in terrainHorizon (arcs through the center,
// horizontal offsets on other sections). The default baseline is one ground spacing (spacing ×
// feature radius); a longer one averages over more relief. Slope is measured from the feature's
// reference-ellipsoid zenith; curvature cancels in the symmetric differences. Returns undefined when
// any of the four points is off the grid, next to missing data, or not found.
export function terrainSlope(model: TerrainModel, feature: SurfaceFeature, baseline: Distance = model.spacing * feature.radius): TerrainFacet | undefined {
	const { up, north, east } = feature
	const sampler = sectionSampler(model, feature)
	const { point } = sampler
	const northward = verticalSection(feature, point, 0)
	const eastward = verticalSection(feature, point, PI / 2)
	const along = vecDot(point, up)
	const radial = Math.sqrt(Math.max(vecDot(point, point) - along * along, 0)) <= sampler.tolerance

	// Terrain point at signed distance d along a section, or undefined when none is usable.
	function terrainAt(section: VerticalSection, d: Distance, out: MutVec3) {
		const angle = d / section.range
		const value = radial ? sampler.radial(section, Math.cos(angle), Math.sin(angle), out) : sampler.vertical(section.h, d, out)
		return value === undefined || Number.isNaN(value) ? undefined : out
	}

	const n0 = terrainAt(northward, baseline, vecZero())
	const n1 = terrainAt(northward, -baseline, vecZero())
	const e0 = terrainAt(eastward, baseline, vecZero())
	const e1 = terrainAt(eastward, -baseline, vecZero())
	if (n0 === undefined || n1 === undefined || e0 === undefined || e1 === undefined) return undefined

	// Upward normal: (east chord) × (north chord), since east × north = up.
	const ex = e0[0] - e1[0]
	const ey = e0[1] - e1[1]
	const ez = e0[2] - e1[2]
	const nx = n0[0] - n1[0]
	const ny = n0[1] - n1[1]
	const nz = n0[2] - n1[2]
	const normal: Vec3 = [ey * nz - ez * ny, ez * nx - ex * nz, ex * ny - ey * nx]
	const towardNorth = vecDot(normal, north)
	const towardEast = vecDot(normal, east)
	const horizontal = Math.hypot(towardNorth, towardEast)

	return { slope: Math.atan2(horizontal, vecDot(normal, up)), aspect: horizontal > 0 ? normalizeAngle(Math.atan2(towardEast, towardNorth)) : 0 }
}

// First terrain crossing of the straight ray from the feature point toward a local altitude and
// azimuth (radians; altitude above the reference tangent plane, azimuth north through east).
// Samples the clearance (point radius minus terrain radius) every step, with a final sample exactly
// at the end of the ray, and interpolates linearly over the actual length of the segment between the
// last positive sample and the first non-positive one. The feature point itself is not tested, so a
// feature standing on the terrain is not its own occluder; a crossing within the first step is
// reported at the interpolated range. Missing data and off-grid points use the reference surface.
// Throws RangeError for a non-positive or non-finite step, or a ray over MAX_RAY_SAMPLES samples,
// which would never finish or scan without practical bound. Returns undefined when the ray stays
// clear out to options.maxDistance or the enclosing sphere.
export function terrainOcclusion(model: TerrainModel, feature: SurfaceFeature, altitude: Angle, azimuth: Angle, { step, maxDistance }: TerrainRayOptions = {}): TerrainRayHit | undefined {
	const stride = validatePositiveFinite(step ?? (model.spacing * feature.radius) / 2)
	const { up, north, east, location } = feature
	const [ia, ib, ic] = inverseSquaredRadii(location.shape)
	const point = bodyFixedPosition(location)

	const cosAltitude = Math.cos(altitude)
	const n = cosAltitude * Math.cos(azimuth)
	const e = cosAltitude * Math.sin(azimuth)
	const v = Math.sin(altitude)
	const dx = n * north[0] + e * east[0] + v * up[0]
	const dy = n * north[1] + e * east[1] + v * up[1]
	const dz = n * north[2] + e * east[2] + v * up[2]

	// Exit range from the enclosing sphere: |point + t·d| = outer.
	const outer = outerRadius(model, location.shape)
	const b = point[0] * dx + point[1] * dy + point[2] * dz
	const discriminant = b * b - (vecDot(point, point) - outer * outer)
	if (!(discriminant > 0)) return undefined
	let end = -b + Math.sqrt(discriminant)
	if (maxDistance !== undefined) end = Math.min(end, maxDistance)
	const count = raySampleCount(end, stride)

	// Clearance of the point at range t; writes the sampled direction and elevation into the workspace.
	const u = vecZero()
	let longitude = 0
	let latitude = 0
	let elevation = 0

	function clearanceAt(t: number) {
		u[0] = point[0] + t * dx
		u[1] = point[1] + t * dy
		u[2] = point[2] + t * dz
		const r = vecLength(u)
		vecDivScalarMut(u, r)
		longitude = vecLongitude(u)
		latitude = vecLatitude(u)
		elevation = sampleElevation(model, longitude, latitude)
		if (Number.isNaN(elevation)) elevation = 0
		return r - referenceRadius(ia, ib, ic, u[0], u[1], u[2]) - elevation
	}

	let previous = Math.max(clearanceAt(0), 0)
	let previousRange = 0

	for (let k = 1; k <= count; k++) {
		const range = Math.min(k * stride, end)
		const clearance = clearanceAt(range)

		if (clearance <= 0) {
			const drop = previous - clearance
			const crossing = previousRange + (drop > 0 ? ((range - previousRange) * previous) / drop : 0)
			clearanceAt(crossing)
			return { range: crossing, distance: feature.radius * vecAngle(point, u), longitude: normalizeAngle(longitude), latitude, elevation }
		}

		previous = clearance
		previousRange = range
	}

	return undefined
}

// Tip of the shadow a feature casts for a point Sun at solarAltitude/solarAzimuth (radians, local
// frame): the first terrain crossing of the sunlight ray that grazes the feature point, heading
// down-Sun toward altitude -solarAltitude and azimuth solarAzimuth + PI. Place the feature on the
// casting summit or rim; hit.distance is the cast-shadow length along the surface and hit.range the
// straight-line length. Terrain between the feature and the tip may still be lit where it rises
// into the light. The solar disk blurs the tip: pass solarAltitude ± the solar angular radius for
// the umbra and penumbra limits. Returns undefined when the ray finds no terrain, as with
// terrainOcclusion, whose sampling and step rules apply.
export function terrainShadowTip(model: TerrainModel, feature: SurfaceFeature, solarAltitude: Angle, solarAzimuth: Angle, options?: TerrainRayOptions): TerrainRayHit | undefined {
	return terrainOcclusion(model, feature, -solarAltitude, solarAzimuth + PI, options)
}
