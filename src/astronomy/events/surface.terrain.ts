import { PI, TAU } from '../../core/constants'
import { validatePositiveFinite, validatePositiveInteger } from '../../core/validation'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDivScalarMut, vecDot, vecLatitude, vecLength, vecLongitude, vecMinus, vecMulScalar, vecNormalizeMut, vecZero } from '../../math/linear-algebra/vec3'
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
// the feature's vertical plane toward each azimuth (so samples keep their azimuth on tri-axial
// bodies), never below the limb of the body's lowest surface; the facet slope/aspect by central
// differences in the same planes; and the first terrain crossing of a straight ray toward a local
// altitude/azimuth, which gives point-Sun shadowing and the cast-shadow length of a summit. Rays and
// horizon profiles sample the terrain at a fixed step, so relief narrower than the step or the grid spacing can be missed or smoothed; results are no better
// than the DEM resolution and its own accuracy. Off the grid and on NaN cells the reference surface
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
	// Distance from the feature to the point that sets the horizon, AU: the arc of its vertical plane
	// at the vantage's distance from the plane's center (the vantage radius on a sphere). When no
	// terrain sample rises above the body's own limb, it is the distance to that limb, zero for a
	// vantage on a smooth sphere.
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
	// Surface distance between samples along each azimuth, AU; defaults to half the ground spacing
	// (spacing × feature radius / 2). Ridges narrower than the step can be missed.
	readonly step?: Distance
	// Surface distance at which the march stops, AU, with the last sample exactly there. Defaults to
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
// and the horizontal direction at that azimuth. Its points are offset·normal + ρ·(cos θ·a + sin θ·b),
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
	return { normal, offset, a, b, range }
}

// Secant iterations that move a vertical-section sample onto the terrain; each costs one DEM lookup.
// A sphere needs none. Otherwise each sample starts from the previous sample's radius, so a few
// suffice even on strongly tri-axial shapes; the last iterate is kept if the bound is hit.
const MAX_SECTION_ITERATIONS = 8

// Radius residual, relative to the section range, below which a section sample is on the terrain.
const SECTION_TOLERANCE = 1e-12

// Scratch state of the section solver, reused across samples of one march.
interface SectionWork {
	// DEM elevation (AU) at the last evaluated point; NaN off the grid or next to missing data.
	elevation: number
	// Section radius ρ (AU) of the last solved sample, the start for the next one.
	rho: number
}

// Radius residual (AU) of the section point offset·normal + rho·u: its distance from the body center
// minus the terrain radius in its direction (reference radius plus DEM elevation, zero elevation
// standing in for missing data). Positive above the terrain. Writes the DEM elevation into work.
function sectionResidual(model: TerrainModel, ia: number, ib: number, ic: number, section: VerticalSection, ux: number, uy: number, uz: number, rho: number, work: SectionWork) {
	const { normal, offset } = section
	const x = offset * normal[0] + rho * ux
	const y = offset * normal[1] + rho * uy
	const z = offset * normal[2] + rho * uz
	const r = Math.hypot(x, y, z)
	const elevation = sampleElevation(model, Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y)))
	work.elevation = elevation
	return r - referenceRadius(ia, ib, ic, x / r, y / r, z / r) - (Number.isNaN(elevation) ? 0 : elevation)
}

// Fixed-point update of a section radius: the ρ at which the terrain radius just found at rho (its
// distance minus residual) would be met. Always finite and non-negative.
function sectionFixedPoint(offset: Distance, rho: Distance, residual: Distance) {
	const terrainRadius = Math.sqrt(offset * offset + rho * rho) - residual
	return Math.sqrt(Math.max(terrainRadius * terrainRadius - offset * offset, 0))
}

// Moves the section sample at angle θ (given by its cosine and sine) onto the terrain and writes the
// body-fixed point (AU) into out. With a zero offset (a sphere) the terrain radius straight along u
// is exact in one DEM lookup. Otherwise the solve starts from work.rho, the previous sample's radius
// along the same march (the section range for the first), takes a fixed-point step and refines with
// secant iterations on sectionResidual, falling back to a fixed-point step whenever the secant
// leaves positive radii. Following the previous root keeps the march on one continuous terrain
// profile; on strongly tri-axial shapes, relief steep enough to give one section ray several
// terrain crossings can leave it on the ground crossing and miss that relief. Stores the solved
// radius in work.rho and returns the DEM elevation at the final point, NaN off the grid or next to
// missing data, where the reference surface stands in. Hot path: no allocation.
function sectionTerrainPoint(model: TerrainModel, ia: number, ib: number, ic: number, section: VerticalSection, cosAngle: number, sinAngle: number, work: SectionWork, out: MutVec3) {
	const { normal, offset, a, b } = section
	const ux = cosAngle * a[0] + sinAngle * b[0]
	const uy = cosAngle * a[1] + sinAngle * b[1]
	const uz = cosAngle * a[2] + sinAngle * b[2]
	const tolerance = SECTION_TOLERANCE * section.range
	let elevation: number
	let rho: number

	if (Math.abs(offset) <= tolerance) {
		elevation = sampleElevation(model, Math.atan2(uy, ux), Math.atan2(uz, Math.hypot(ux, uy)))
		rho = referenceRadius(ia, ib, ic, ux, uy, uz) + (Number.isNaN(elevation) ? 0 : elevation)
	} else {
		let previousRho = work.rho
		let previousResidual = sectionResidual(model, ia, ib, ic, section, ux, uy, uz, previousRho, work)
		elevation = work.elevation
		rho = previousRho

		if (Math.abs(previousResidual) > tolerance) {
			rho = sectionFixedPoint(offset, previousRho, previousResidual)

			for (let i = 0; i < MAX_SECTION_ITERATIONS; i++) {
				const residual = sectionResidual(model, ia, ib, ic, section, ux, uy, uz, rho, work)
				elevation = work.elevation
				if (Math.abs(residual) <= tolerance) break
				let next = rho - (residual * (rho - previousRho)) / (residual - previousResidual)
				if (!(next > 0 && Number.isFinite(next))) next = sectionFixedPoint(offset, rho, residual)
				previousRho = rho
				previousResidual = residual
				rho = next
			}
		}
	}

	work.rho = rho
	out[0] = offset * normal[0] + rho * ux
	out[1] = offset * normal[1] + rho * uy
	out[2] = offset * normal[2] + rho * uz
	return elevation
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
// when that exceeds MAX_RAY_SAMPLES, which would scan without practical bound. A
// non-positive or NaN span has none.
function raySampleCount(span: number, stride: number) {
	if (!(span > 0)) return 0
	const count = Math.ceil(span / stride)
	if (!(count <= MAX_RAY_SAMPLES)) throw new RangeError(`terrain march needs more than ${MAX_RAY_SAMPLES} samples; increase step or reduce maxDistance`)
	return count
}

// Terrain horizon mask of a feature, by marching the DEM. The vantage point is the feature's
// body-fixed position, so build its location with terrainSurfaceLocation (optionally with a small
// height) to stand on the terrain. Along each azimuth the march follows the terrain's intersection
// with the feature's vertical plane toward that azimuth, so every sample is seen at that azimuth on a
// tri-axial body too. Distances along an azimuth are arcs of that section at the vantage's distance
// from the section center (the vantage radius on a sphere). The march samples every step out to
// maxDistance, the last sample landing exactly there, and keeps the highest altitude above the
// feature's reference tangent plane, with curvature included; the first sample is a full step out,
// so ground curving away from the vantage reads up to about step / (2 × curvature radius) low. The
// mask never drops below the limb of the body's lowest possible surface (smallest semi-axis plus the
// lowest elevation) seen from the vantage in that plane: zero for a vantage on a smooth sphere and
// -acos(R / (R + h)) at height h, whatever the step. The DEM elevations must be relative to
// feature.location.shape. Returns options.azimuths fresh samples ordered by azimuth, directly usable as SurfaceFeatureOptions.horizon. Throws for a
// non-integer or non-positive azimuth count, a non-positive or non-finite step, or a march over
// MAX_RAY_SAMPLES samples per azimuth or MAX_HORIZON_SAMPLES in total, which would never finish or
// scan without practical bound. Cost is azimuths × maxDistance / step DEM samples, a few times more
// on a non-spherical shape.
export function terrainHorizon(model: TerrainModel, feature: SurfaceFeature, { azimuths = 360, step, maxDistance }: TerrainHorizonOptions = {}): TerrainHorizonSample[] {
	validatePositiveInteger(azimuths)
	const stride = validatePositiveFinite(step ?? (model.spacing * feature.radius) / 2)
	const { up, location } = feature
	const shape = location.shape
	const [ia, ib, ic] = inverseSquaredRadii(shape)
	const point = bodyFixedPosition(location)
	const inner = Math.min(shape.radii[0], shape.radii[1], shape.radii[2]) + Math.min(model.minimumElevation, 0)
	const outer = outerRadius(model, shape)

	// Bound the work before any march. A section's offset is at most the vantage's distance from its
	// zenith line through the center; both tangent angles of the default reach grow with the offset,
	// and the section range is at most the vantage's distance from the center.
	const distance2 = vecDot(point, point)
	const along = vecDot(point, up)
	const offsetBound = Math.sqrt(Math.max(distance2 - along * along, 0))
	const reachBound = sectionReach(inner, outer, offsetBound, Math.sqrt(Math.max(distance2 - offsetBound * offsetBound, 0)))
	const lengthBound = maxDistance ?? Math.min(reachBound, PI) * Math.sqrt(distance2)
	const countBound = raySampleCount(lengthBound, stride)
	if (!(countBound * azimuths <= MAX_HORIZON_SAMPLES)) throw new RangeError(`terrain horizon needs more than ${MAX_HORIZON_SAMPLES} samples; increase step, reduce azimuths or reduce maxDistance`)

	const samples: TerrainHorizonSample[] = []
	const terrain: MutVec3 = [0, 0, 0]
	const work: SectionWork = { elevation: 0, rho: 0 }

	for (let i = 0; i < azimuths; i++) {
		const azimuth = (i * TAU) / azimuths
		const section = verticalSection(feature, point, azimuth)
		const { range, offset } = section

		// Limb of the inner circle of this section: rays below it enter the solid body.
		const innerCircle = Math.sqrt(Math.max(inner * inner - offset * offset, 0))
		const limb = Math.acos(clamp(innerCircle / range, -1, 1))
		let best: number

		if (limb > 0) {
			const c = innerCircle * Math.cos(limb)
			const s = innerCircle * Math.sin(limb)
			terrain[0] = offset * section.normal[0] + c * section.a[0] + s * section.b[0]
			terrain[1] = offset * section.normal[1] + c * section.a[1] + s * section.b[1]
			terrain[2] = offset * section.normal[2] + c * section.a[2] + s * section.b[2]
			best = altitudeFrom(up, point, terrain)
		} else {
			// The vantage is on the inner circle: its limb is the section's tangent there.
			best = Math.asin(clamp(vecDot(section.b, up), -1, 1))
		}

		// Section angles: every step, ending exactly at the limit.
		const delta = stride / range
		const limit = Math.min(maxDistance === undefined ? sectionReach(inner, outer, offset, range) : maxDistance / range, PI)
		const steps = raySampleCount(limit, delta)
		let bestAngle = limb
		let complete = true
		work.rho = range

		for (let k = 1; k <= steps; k++) {
			const angle = Math.min(k * delta, limit)
			if (Number.isNaN(sectionTerrainPoint(model, ia, ib, ic, section, Math.cos(angle), Math.sin(angle), work, terrain))) complete = false
			const altitude = altitudeFrom(up, point, terrain)

			if (altitude > best) {
				best = altitude
				bestAngle = angle
			}
		}

		samples.push({ azimuth, minimumAltitude: best, distance: bestAngle * range, complete })
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
// vertical plane toward that azimuth. The default baseline is one ground spacing (spacing × feature
// radius); a longer one averages over more relief. Slope is measured from the feature's
// reference-ellipsoid zenith; curvature cancels in the symmetric differences. Returns undefined when
// any of the four points is off the grid or next to missing data.
export function terrainSlope(model: TerrainModel, feature: SurfaceFeature, baseline: Distance = model.spacing * feature.radius): TerrainFacet | undefined {
	const { up, north, east, location } = feature
	const point = bodyFixedPosition(location)
	const [ia, ib, ic] = inverseSquaredRadii(location.shape)
	const northward = verticalSection(feature, point, 0)
	const eastward = verticalSection(feature, point, PI / 2)
	const northAngle = baseline / northward.range
	const eastAngle = baseline / eastward.range

	const work: SectionWork = { elevation: 0, rho: northward.range }
	const n0: MutVec3 = [0, 0, 0]
	const n1: MutVec3 = [0, 0, 0]
	const e0: MutVec3 = [0, 0, 0]
	const e1: MutVec3 = [0, 0, 0]
	if (Number.isNaN(sectionTerrainPoint(model, ia, ib, ic, northward, Math.cos(northAngle), Math.sin(northAngle), work, n0))) return undefined
	work.rho = northward.range
	if (Number.isNaN(sectionTerrainPoint(model, ia, ib, ic, northward, Math.cos(northAngle), -Math.sin(northAngle), work, n1))) return undefined
	work.rho = eastward.range
	if (Number.isNaN(sectionTerrainPoint(model, ia, ib, ic, eastward, Math.cos(eastAngle), Math.sin(eastAngle), work, e0))) return undefined
	work.rho = eastward.range
	if (Number.isNaN(sectionTerrainPoint(model, ia, ib, ic, eastward, Math.cos(eastAngle), -Math.sin(eastAngle), work, e1))) return undefined

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
