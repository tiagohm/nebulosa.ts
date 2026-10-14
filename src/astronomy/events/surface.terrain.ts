import { PI, TAU } from '../../core/constants'
import { validatePositiveFinite } from '../../core/validation'
import { type MutVec3, type Vec3, vecAngle, vecDot, vecLength, vecNormalizeMut } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
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
// great circles along azimuths, the facet slope/aspect by central differences, and the first terrain
// crossing of a straight ray toward a local altitude/azimuth, which gives point-Sun shadowing and the
// cast-shadow length of a summit. Rays and horizon profiles sample the terrain at a fixed step, so
// relief narrower than the step or the grid spacing can be missed or smoothed; results are no better
// than the DEM resolution and its own accuracy. Off the grid and on NaN cells the reference surface
// (zero elevation) stands in, which horizon samples report as incomplete. The Sun is a point at the
// direction supplied: penumbra from its finite disk is not modeled. Nothing here mutates the grid or
// the feature; the grid is never copied, and each march reuses scalar workspaces only.

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
	// Surface distance from the feature to the terrain point that sets the horizon, AU: the
	// feature's reference radius times the central angle; zero when the march had no sample.
	readonly distance: Distance
	// Whether every sample along this azimuth came from finite DEM data; false when the march left
	// the grid or crossed NaN cells and the reference surface was used there.
	readonly complete: boolean
}

// Controls for terrainHorizon.
export interface TerrainHorizonOptions {
	// Number of azimuths, evenly spaced from north through east starting at zero; defaults to 360.
	readonly azimuths?: number
	// Surface distance between samples along each azimuth, AU; defaults to half the ground spacing
	// (spacing × feature radius / 2). Ridges narrower than the step can be missed.
	readonly step?: Distance
	// Surface distance at which the march stops, AU. Defaults to the reach beyond which terrain
	// within the grid's elevation range is hidden by the body itself (from spheres through the
	// smallest and largest semi-axes offset by the elevation extremes); capped at half a great circle.
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

// Unit tangent toward a local azimuth (radians, north through east), made exactly perpendicular to
// the feature's radial direction so it spans a great circle with it. Allocates the result.
function greatCircleTangent(feature: SurfaceFeature, radial: Vec3, azimuth: Angle): MutVec3 {
	const { north, east } = feature
	const cosAzimuth = Math.cos(azimuth)
	const sinAzimuth = Math.sin(azimuth)
	const x = cosAzimuth * north[0] + sinAzimuth * east[0]
	const y = cosAzimuth * north[1] + sinAzimuth * east[1]
	const z = cosAzimuth * north[2] + sinAzimuth * east[2]
	const along = x * radial[0] + y * radial[1] + z * radial[2]
	return vecNormalizeMut([x - along * radial[0], y - along * radial[1], z - along * radial[2]])
}

// Terrain horizon mask of a feature, by ray marching the DEM. The vantage point is the feature's
// body-fixed position, so build its location with terrainSurfaceLocation (optionally with a small
// height) to stand on the terrain. Along each azimuth the march follows the great circle through
// the feature's radial direction and the local horizontal toward that azimuth (the vertical plane on
// a sphere), samples terrain points every step out to maxDistance, and keeps the highest altitude
// above the feature's reference tangent plane, with curvature included. The DEM elevations must be
// relative to feature.location.shape. Returns options.azimuths fresh samples ordered by azimuth,
// directly usable as SurfaceFeatureOptions.horizon. Throws RangeError for a non-positive or
// non-finite step, which would never finish. Cost is azimuths × maxDistance / step DEM samples.
export function terrainHorizon(model: TerrainModel, feature: SurfaceFeature, { azimuths = 360, step, maxDistance }: TerrainHorizonOptions = {}): TerrainHorizonSample[] {
	const stride = validatePositiveFinite(step ?? (model.spacing * feature.radius) / 2)
	const { up, location } = feature
	const shape = location.shape
	const [ia, ib, ic] = inverseSquaredRadii(shape)
	const point = bodyFixedPosition(location)
	const range = vecLength(point)
	const radial: Vec3 = [point[0] / range, point[1] / range, point[2] / range]

	// Terrain past the vantage tangent to the inner sphere and the outer sphere's tangent beyond it is
	// below the body's own limb, so it can never set the horizon.
	const inner = Math.min(shape.radii[0], shape.radii[1], shape.radii[2]) + Math.min(model.minimumElevation, 0)
	const outer = outerRadius(model, shape)
	const reach = Math.acos(clamp(inner / range, -1, 1)) + Math.acos(clamp(inner / outer, -1, 1))
	const limit = Math.min(maxDistance === undefined ? reach : maxDistance / feature.radius, PI)
	const count = Math.max(0, Math.floor((limit * feature.radius) / stride))

	// Central angles are shared by every azimuth.
	const cosines = new Float64Array(count)
	const sines = new Float64Array(count)
	for (let k = 0; k < count; k++) {
		const angle = ((k + 1) * stride) / feature.radius
		cosines[k] = Math.cos(angle)
		sines[k] = Math.sin(angle)
	}

	const samples: TerrainHorizonSample[] = []

	for (let i = 0; i < azimuths; i++) {
		const azimuth = (i * TAU) / azimuths
		const tangent = greatCircleTangent(feature, radial, azimuth)
		let best = -PI / 2
		let bestIndex = -1
		let complete = true

		for (let k = 0; k < count; k++) {
			const c = cosines[k]
			const s = sines[k]
			const ux = c * radial[0] + s * tangent[0]
			const uy = c * radial[1] + s * tangent[1]
			const uz = c * radial[2] + s * tangent[2]
			let elevation = sampleElevation(model, Math.atan2(uy, ux), Math.atan2(uz, Math.hypot(ux, uy)))

			if (Number.isNaN(elevation)) {
				complete = false
				elevation = 0
			}

			const r = referenceRadius(ia, ib, ic, ux, uy, uz) + elevation
			const wx = r * ux - point[0]
			const wy = r * uy - point[1]
			const wz = r * uz - point[2]
			const vertical = wx * up[0] + wy * up[1] + wz * up[2]
			const altitude = Math.atan2(vertical, Math.sqrt(Math.max(wx * wx + wy * wy + wz * wz - vertical * vertical, 0)))

			if (altitude > best) {
				best = altitude
				bestIndex = k
			}
		}

		samples.push({ azimuth, minimumAltitude: best, distance: (bestIndex + 1) * stride, complete })
	}

	return samples
}

// Body-fixed terrain point (AU) at central angle `angle` from the feature's radial direction toward
// a unit great-circle tangent, or undefined off the grid or next to missing data. Allocates the result.
function terrainPointAlong(model: TerrainModel, shape: BodyShape, radial: Vec3, tangent: Vec3, angle: Angle): MutVec3 | undefined {
	const c = Math.cos(angle)
	const s = Math.sin(angle)
	const ux = c * radial[0] + s * tangent[0]
	const uy = c * radial[1] + s * tangent[1]
	const uz = c * radial[2] + s * tangent[2]
	const elevation = sampleElevation(model, Math.atan2(uy, ux), Math.atan2(uz, Math.hypot(ux, uy)))
	if (Number.isNaN(elevation)) return undefined
	const [ia, ib, ic] = inverseSquaredRadii(shape)
	const r = referenceRadius(ia, ib, ic, ux, uy, uz) + elevation
	return [r * ux, r * uy, r * uz]
}

// Facet slope and aspect of the DEM at a feature, from the normal of the two central-difference
// chords between terrain points baseline (AU) north/south and east/west of it along great circles.
// The default baseline is one ground spacing (spacing × feature radius); a longer one averages
// over more relief. Slope is measured from the feature's reference-ellipsoid zenith; curvature
// cancels in the symmetric differences. Returns undefined when any of the four points is off the
// grid or next to missing data.
export function terrainSlope(model: TerrainModel, feature: SurfaceFeature, baseline: Distance = model.spacing * feature.radius): TerrainFacet | undefined {
	const { up, north, east, location } = feature
	const point = bodyFixedPosition(location)
	const range = vecLength(point)
	const radial: Vec3 = [point[0] / range, point[1] / range, point[2] / range]
	const angle = baseline / feature.radius
	const northTangent = greatCircleTangent(feature, radial, 0)
	const eastTangent = greatCircleTangent(feature, radial, PI / 2)

	const n0 = terrainPointAlong(model, location.shape, radial, northTangent, angle)
	const n1 = terrainPointAlong(model, location.shape, radial, northTangent, -angle)
	const e0 = terrainPointAlong(model, location.shape, radial, eastTangent, angle)
	const e1 = terrainPointAlong(model, location.shape, radial, eastTangent, -angle)
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
// Samples the clearance (point radius minus terrain radius) every step and interpolates linearly
// between the last positive sample and the first non-positive one. The feature point itself is not
// tested, so a feature standing on the terrain is not its own occluder; a crossing within the first
// step is reported at the interpolated range. Missing data and off-grid points use the reference
// surface. Throws RangeError for a non-positive or non-finite step, which would never finish.
// Returns undefined when the ray stays clear out to options.maxDistance or the enclosing sphere.
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

	// Clearance of the point at range t; writes the sampled direction and elevation into the workspace.
	let ux = 0
	let uy = 0
	let uz = 0
	let longitude = 0
	let latitude = 0
	let elevation = 0

	function clearanceAt(t: number) {
		const x = point[0] + t * dx
		const y = point[1] + t * dy
		const z = point[2] + t * dz
		const r = Math.sqrt(x * x + y * y + z * z)
		ux = x / r
		uy = y / r
		uz = z / r
		longitude = Math.atan2(uy, ux)
		latitude = Math.atan2(uz, Math.hypot(ux, uy))
		elevation = sampleElevation(model, longitude, latitude)
		if (Number.isNaN(elevation)) elevation = 0
		return r - referenceRadius(ia, ib, ic, ux, uy, uz) - elevation
	}

	let previous = Math.max(clearanceAt(0), 0)

	for (let k = 1; k * stride <= end; k++) {
		const clearance = clearanceAt(k * stride)

		if (clearance <= 0) {
			const drop = previous - clearance
			const range = (k - 1) * stride + (drop > 0 ? (stride * previous) / drop : 0)
			clearanceAt(range)
			const hit: Vec3 = [ux, uy, uz]
			return { range, distance: feature.radius * vecAngle(point, hit), longitude: normalizeAngle(longitude), latitude, elevation }
		}

		previous = clearance
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
