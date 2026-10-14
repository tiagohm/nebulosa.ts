import { expect, test } from 'bun:test'
import { ICRS } from '../../../src/astronomy/coordinates/frame'
import { surfaceFeature, surfaceFeatureIllumination } from '../../../src/astronomy/events/surface'
import { type ElevationGrid, terrainElevation, terrainHorizon, terrainModel, terrainOcclusion, terrainShadowTip, terrainSlope, terrainSurfaceLocation } from '../../../src/astronomy/events/surface.terrain'
import { bodyShape, bodySurfaceLocation } from '../../../src/astronomy/observer/body'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PI, PIOVERTWO, TAU } from '../../../src/core/constants'
import { type Angle, deg, toDeg } from '../../../src/math/units/angle'
import { type Distance, kilometer } from '../../../src/math/units/distance'

const RADIUS = kilometer(1737.4)
const MOON = bodyShape([RADIUS, RADIUS, RADIUS])

// Square grid centered on longitude/latitude zero, with node spacing `step` and `half` on each side
// (radians). `elevation` receives the exact central angle from the center node, so analytic profiles
// are defined along true great-circle distances.
function centeredGrid(half: Angle, step: Angle, elevation: (angle: Angle, longitude: Angle, latitude: Angle) => Distance, source: string): ElevationGrid {
	const size = Math.round((2 * half) / step) + 1
	const elevations = new Float64Array(size * size)

	for (let j = 0; j < size; j++) {
		const latitude = -half + j * step
		for (let i = 0; i < size; i++) {
			const longitude = -half + i * step
			const haversine = Math.sin(latitude / 2) ** 2 + Math.cos(latitude) * Math.sin(longitude / 2) ** 2
			elevations[j * size + i] = elevation(2 * Math.asin(Math.sqrt(haversine)), longitude, latitude)
		}
	}

	return { elevations, width: size, height: size, longitude: -half, latitude: -half, longitudeStep: step, latitudeStep: step, source }
}

// Altitude above the local horizontal at radius `from` of a point at radius `to` and central angle
// `angle` on a sphere.
function sphereAltitude(from: Distance, to: Distance, angle: Angle) {
	return Math.atan2(to * Math.cos(angle) - from, to * Math.sin(angle))
}

test('bilinear sampling wraps a global grid and holds half-cell margins at the poles and edges', () => {
	const elevations = new Float64Array(360 * 180)
	for (let j = 0; j < 180; j++) for (let i = 0; i < 360; i++) elevations[j * 360 + i] = i + 1000 * j
	elevations[1000] = Number.NaN
	const global = terrainModel({ elevations, width: 360, height: 180, longitude: deg(0.5), latitude: deg(89.5), longitudeStep: deg(1), latitudeStep: deg(-1), source: 'synthetic 1° cell-centered global' })

	expect(global.wrapsLongitude).toBeTrue()
	expect(global.minimumElevation).toBe(0)
	expect(global.maximumElevation).toBe(359 + 179000)
	expect(global.spacing).toBeCloseTo(deg(1), 15)
	// Across the 0° meridian: halfway between column 359 (359.5°) and column 0 (0.5°).
	expect(terrainElevation(global, 0, deg(89.5))!).toBeCloseTo(179.5, 9)
	expect(terrainElevation(global, TAU - deg(0.25), deg(89.5))!).toBeCloseTo(359 - 0.25 * 359, 9)
	// Within half a step of the pole, the edge row is held.
	expect(terrainElevation(global, deg(1), PIOVERTWO)!).toBeCloseTo(0.5, 9)
	expect(terrainElevation(global, deg(1), -PIOVERTWO)!).toBeCloseTo(0.5 + 179000, 9)
	expect(terrainElevation(global, deg(1), deg(90.6))).toBeUndefined()
	// Row 2, column 280 is NaN; its neighborhood is missing data.
	expect(terrainElevation(global, deg(280.2), deg(87.5))).toBeUndefined()

	const local = terrainModel({ elevations: Float32Array.of(1, 2, 3, 4), width: 2, height: 2, longitude: deg(-1), latitude: 0, longitudeStep: deg(2), latitudeStep: deg(1), source: 'synthetic local' })
	expect(local.wrapsLongitude).toBeFalse()
	expect(terrainElevation(local, 0, deg(0.5))!).toBeCloseTo(2.5, 6)
	expect(terrainElevation(local, deg(-1.9), 0)!).toBeCloseTo(1, 6)
	expect(terrainElevation(local, deg(-2.1), 0)).toBeUndefined()
	expect(terrainElevation(local, deg(1.9), deg(1.4))!).toBeCloseTo(4, 6)
	expect(terrainElevation(local, deg(2.1), 0)).toBeUndefined()
	expect(terrainSurfaceLocation(local, deg(10), 0, MOON, ICRS)).toBeUndefined()
})

test('slope and aspect of a tilted plane come from central differences on the DEM', () => {
	const gradientEast = 0.2
	const gradientNorth = -0.3
	const model = terrainModel(centeredGrid(deg(0.1), deg(0.002), (_, longitude, latitude) => RADIUS * (gradientEast * longitude + gradientNorth * latitude), 'synthetic tilted plane'))
	const location = terrainSurfaceLocation(model, 0, 0, MOON, ICRS)!
	expect(location.elevation).toBeCloseTo(0, 18)

	const facet = terrainSlope(model, surfaceFeature(location))!
	expect(facet.slope).toBeCloseTo(Math.atan(Math.hypot(gradientEast, gradientNorth)), 9)
	// Rising east and falling north, it faces down-slope toward north-northwest.
	expect(facet.aspect).toBeCloseTo(Math.atan2(-gradientEast, -gradientNorth) + TAU, 9)

	const longBaseline = terrainSlope(model, surfaceFeature(location), kilometer(1))!
	expect(longBaseline.slope).toBeCloseTo(facet.slope, 6)

	const level = terrainModel(centeredGrid(deg(0.1), deg(0.002), () => 0, 'synthetic level'))
	const flat = terrainSlope(level, surfaceFeature(location))!
	expect(flat.slope).toBeCloseTo(0, 12)
	expect(flat.aspect === 0 || flat.slope < 1e-12).toBeTrue()
	expect(terrainSlope(model, surfaceFeature(location), kilometer(5))).toBeUndefined()
})

// Flat-floored crater: floor radius 4 km, 1.5 km deep, a straight wall up to a rim at 8 km, then
// level ground. From the floor center the rim sets the horizon at every azimuth.
const FLOOR = kilometer(4)
const RIM = kilometer(8)
const DEPTH = kilometer(1.5)
const CRATER = terrainModel(
	centeredGrid(
		deg(0.4),
		deg(0.002),
		(angle) => {
			const distance = RADIUS * angle
			return distance <= FLOOR ? -DEPTH : distance >= RIM ? 0 : -DEPTH * (1 - (distance - FLOOR) / (RIM - FLOOR))
		},
		'synthetic flat-floored crater, 0.002° grid',
	),
)

test('terrain horizon from a crater floor is set by the rim with curvature included', () => {
	const location = terrainSurfaceLocation(CRATER, 0, 0, MOON, ICRS)!
	expect(location.elevation).toBeCloseTo(-DEPTH, 15)
	const feature = surfaceFeature(location)
	const rimAltitude = sphereAltitude(RADIUS - DEPTH, RADIUS, RIM / RADIUS)
	expect(toDeg(rimAltitude)).toBeCloseTo(10.49, 2)

	const horizon = terrainHorizon(CRATER, feature, { azimuths: 16, maxDistance: kilometer(11) })
	expect(horizon).toHaveLength(16)

	for (let i = 0; i < horizon.length; i++) {
		const sample = horizon[i]
		expect(sample.azimuth).toBeCloseTo((i * TAU) / 16, 15)
		expect(Math.abs(sample.minimumAltitude - rimAltitude)).toBeLessThan(deg(0.05))
		expect(Math.abs(sample.distance - RIM)).toBeLessThan(kilometer(0.1))
		expect(sample.complete).toBeTrue()
	}

	// The default reach runs past the grid edge, where the reference surface stands in.
	const reach = terrainHorizon(CRATER, feature, { azimuths: 4 })
	expect(reach.every((sample) => !sample.complete)).toBeTrue()
	expect(Math.abs(reach[1].minimumAltitude - rimAltitude)).toBeLessThan(deg(0.05))

	const masked = surfaceFeature(location, { ...terrainSlope(CRATER, feature), horizon })
	expect(masked.normal[0]).toBeCloseTo(1, 12)
	expect(Math.abs(masked.horizonAltitudeAt!(deg(100)) - rimAltitude)).toBeLessThan(deg(0.05))
})

test('a crater floor is shadowed until the Sun clears the rim', () => {
	const feature = surfaceFeature(terrainSurfaceLocation(CRATER, 0, 0, MOON, ICRS)!)
	const rimAltitude = sphereAltitude(RADIUS - DEPTH, RADIUS, RIM / RADIUS)

	const blocked = terrainOcclusion(CRATER, feature, rimAltitude - deg(0.5), deg(90))!
	expect(blocked.distance).toBeGreaterThan(FLOOR)
	expect(blocked.distance).toBeLessThan(RIM)
	expect(blocked.latitude).toBeCloseTo(0, 9)
	expect(blocked.longitude).toBeCloseTo(blocked.distance / RADIUS, 6)
	// The crossing lies on the wall.
	expect(blocked.elevation).toBeCloseTo(-DEPTH * (1 - (blocked.distance - FLOOR) / (RIM - FLOOR)), 11)

	expect(terrainOcclusion(CRATER, feature, rimAltitude + deg(0.5), deg(90))).toBeUndefined()
	expect(terrainOcclusion(CRATER, feature, rimAltitude + deg(0.5), deg(225))).toBeUndefined()
	// Toward the nadir the floor itself is hit at once.
	expect(terrainOcclusion(CRATER, feature, -PIOVERTWO, 0)!.range).toBeCloseTo(0, 15)
})

// Conical peak 3 km high with a 10 km base radius (flank slope 16.7°) on level ground.
const PEAK = kilometer(3)
const BASE = kilometer(10)
const CONE = terrainModel(centeredGrid(deg(0.7), deg(0.004), (angle) => PEAK * Math.max(0, 1 - (RADIUS * angle) / BASE), 'synthetic cone, 0.004° grid'))

test('cast-shadow length of a conical peak matches the spherical analytic tip', () => {
	const summit = surfaceFeature(terrainSurfaceLocation(CONE, 0, 0, MOON, ICRS)!)

	for (const solarAltitude of [deg(8), deg(12), deg(15)]) {
		// Sunlight grazing the summit at depression e meets the sphere at central angle
		// asin((R + H)·cos(e) / R) + e − π/2.
		const angle = Math.asin(((RADIUS + PEAK) * Math.cos(solarAltitude)) / RADIUS) + solarAltitude - PIOVERTWO
		const tip = terrainShadowTip(CONE, summit, solarAltitude, deg(90))!
		expect(Math.abs(tip.distance - RADIUS * angle)).toBeLessThan(kilometer(0.002))
		expect(tip.longitude).toBeCloseTo(TAU - angle, 8)
		expect(tip.latitude).toBeCloseTo(0, 12)
		expect(tip.elevation).toBe(0)
		// The flat-ground estimate H / tan(e) is short by the curvature drop.
		expect(tip.distance).toBeGreaterThan(PEAK / Math.tan(solarAltitude))
	}

	// With the Sun above the flank slope, the down-Sun flank is lit and the summit casts no shadow.
	const steep = terrainShadowTip(CONE, summit, deg(30), deg(0))!
	expect(steep.distance).toBeLessThan(kilometer(0.1))
	expect(steep.elevation).toBeGreaterThan(PEAK - kilometer(0.05))

	// A Sun below the horizon sends the grazing ray upward, away from the terrain.
	expect(terrainShadowTip(CONE, summit, deg(-10), deg(90))).toBeUndefined()
})

test('ground west of the peak is in its shadow out to the tip', () => {
	const solarAltitude = deg(12)
	const angle = Math.asin(((RADIUS + PEAK) * Math.cos(solarAltitude)) / RADIUS) + solarAltitude - PIOVERTWO
	const length = RADIUS * angle

	// For a parallel Sun the local altitude west of the summit is lower by the central angle.
	for (const distance of [kilometer(12), length - kilometer(0.1)]) {
		const ground = surfaceFeature(terrainSurfaceLocation(CONE, -distance / RADIUS, 0, MOON, ICRS)!)
		const hit = terrainOcclusion(CONE, ground, solarAltitude - distance / RADIUS, deg(90))!
		// The occluder lies on the cone's west flank.
		expect(hit.elevation).toBeGreaterThan(0)
		expect(hit.elevation).toBeCloseTo(PEAK * (1 - (distance - hit.distance) / BASE), 11)
	}

	const beyond = length + kilometer(0.1)
	const outside = surfaceFeature(terrainSurfaceLocation(CONE, -beyond / RADIUS, 0, MOON, ICRS)!)
	expect(terrainOcclusion(CONE, outside, solarAltitude - beyond / RADIUS, deg(90))).toBeUndefined()
	// A short maxDistance stops the ray before the peak.
	const ground = surfaceFeature(terrainSurfaceLocation(CONE, -kilometer(12) / RADIUS, 0, MOON, ICRS)!)
	expect(terrainOcclusion(CONE, ground, solarAltitude, deg(90), { maxDistance: kilometer(3) })).toBeUndefined()
})

test('off-grid rays fall back to the reference surface', () => {
	// A smooth sphere with a tiny DEM patch: a ray below the geometric dip still meets the body.
	const patch = terrainModel(centeredGrid(deg(0.01), deg(0.002), () => 0, 'synthetic level patch'))
	const feature = surfaceFeature(bodySurfaceLocation(0, 0, kilometer(1), MOON, ICRS))
	const hit = terrainOcclusion(patch, feature, deg(-3), deg(90), { step: kilometer(0.5) })!
	// Exact: depression e from height h meets the sphere at asin((R + h)·cos(e) / R) + e − π/2.
	const angle = Math.asin(((RADIUS + kilometer(1)) * Math.cos(deg(3))) / RADIUS) - PIOVERTWO + deg(3)
	expect(Math.abs(hit.distance - RADIUS * angle)).toBeLessThan(kilometer(0.01))
	expect(hit.elevation).toBe(0)
	expect(terrainOcclusion(patch, feature, deg(1), deg(90), { step: kilometer(0.5) })).toBeUndefined()
	expect(terrainOcclusion(patch, feature, PI / 2, 0)).toBeUndefined()
})

// Flat 1° cell-centered global DEM at the reference sphere.
const FLAT = terrainModel({ elevations: new Float64Array(360 * 180), width: 360, height: 180, longitude: deg(0.5), latitude: deg(89.5), longitudeStep: deg(1), latitudeStep: deg(-1), source: 'synthetic flat global' })

test('a flat DEM gives the geometric horizon of the body, not an empty mask', () => {
	const feature = surfaceFeature(bodySurfaceLocation(0, 0, 0, MOON, ICRS))
	const horizon = terrainHorizon(FLAT, feature, { azimuths: 8 })
	expect(horizon).toHaveLength(8)

	for (const sample of horizon) {
		expect(sample.minimumAltitude).toBeCloseTo(0, 9)
		expect(sample.distance).toBeCloseTo(0, 12)
		expect(sample.complete).toBeTrue()
	}

	// An east-facing 30° facet with the Sun 10° below the eastern horizon faces the Sun but is behind the body.
	const sunAt = () => [1e9 * Math.sin(deg(-10)), 1e9 * Math.cos(deg(-10)), 0] as const
	const time = timeYMDHMS(2024, 1, 1, 0, 0, 0, Timescale.TDB)
	for (const options of [{}, { horizon }, { horizon: [] }]) {
		const result = surfaceFeatureIllumination(surfaceFeature(feature.location, { slope: deg(30), aspect: deg(90), ...options }), sunAt, sunAt, time)
		expect(toDeg(result.incidence)).toBeCloseTo(70, 6)
		expect(result.solarHorizon).toBeCloseTo(0, 9)
		expect(result.sunlit).toBeFalse()
	}
})

test('an elevated vantage sees the dip of the limb, even without a sample there', () => {
	const height = kilometer(1)
	const dip = -Math.acos(RADIUS / (RADIUS + height))
	const feature = surfaceFeature(bodySurfaceLocation(deg(10), deg(-20), height, MOON, ICRS))

	for (const options of [{}, { maxDistance: kilometer(5) }, { step: kilometer(7) }]) {
		for (const sample of terrainHorizon(FLAT, feature, { azimuths: 6, ...options })) {
			expect(sample.minimumAltitude).toBeCloseTo(dip, 9)
			expect(sample.minimumAltitude).toBeLessThan(0)
			expect(sample.distance).toBeCloseTo(-dip * RADIUS, 9)
		}
	}

	// Real relief still rises above the dip: the crater rim seen from 1 km above the floor.
	const floor = terrainSurfaceLocation(CRATER, 0, 0, MOON, ICRS, height)!
	const rimAltitude = sphereAltitude(RADIUS - DEPTH + height, RADIUS, RIM / RADIUS)
	for (const sample of terrainHorizon(CRATER, surfaceFeature(floor), { azimuths: 4, maxDistance: kilometer(11) })) expect(Math.abs(sample.minimumAltitude - rimAltitude)).toBeLessThan(deg(0.05))
})

test('rays sample their final partial step and interpolate over its real length', () => {
	const feature = surfaceFeature(bodySurfaceLocation(0, 0, kilometer(1.5), MOON, ICRS))

	// Straight down from 1.5 km: steps of 1 km end at 1.7 km, so the ground lies in the last partial step.
	const nadir = terrainOcclusion(FLAT, feature, -PIOVERTWO, 0, { step: kilometer(1), maxDistance: kilometer(1.7) })!
	expect(nadir.range).toBeCloseTo(kilometer(1.5), 15)
	// A single step longer than the whole ray.
	expect(terrainOcclusion(FLAT, feature, -PIOVERTWO, 0, { step: kilometer(5), maxDistance: kilometer(2) })!.range).toBeCloseTo(kilometer(1.5), 15)
	// The ray stops short of the ground.
	expect(terrainOcclusion(FLAT, feature, -PIOVERTWO, 0, { step: kilometer(1), maxDistance: kilometer(1.4) })).toBeUndefined()

	// A shadow tip in the last partial step of a ray whose length the step does not divide.
	const summit = surfaceFeature(terrainSurfaceLocation(CONE, 0, 0, MOON, ICRS)!)
	const reference = terrainShadowTip(CONE, summit, deg(12), deg(90))!
	const partial = terrainShadowTip(CONE, summit, deg(12), deg(90), { step: kilometer(1), maxDistance: reference.range + kilometer(0.01) })!
	expect(reference.range % kilometer(1)).toBeLessThan(kilometer(0.99))
	expect(Math.abs(partial.distance - reference.distance)).toBeLessThan(kilometer(0.002))
})

test('horizon samples on a tri-axial body keep their declared azimuth', () => {
	// The strongly tri-axial case where great circles through the radial direction drift by degrees.
	const shape = bodyShape([kilometer(2000), kilometer(1000), kilometer(500)])
	const station = bodySurfaceLocation(deg(45), 0.3, 0, shape, ICRS)
	const feature = surfaceFeature(station)
	const point = station.bodyFixed!

	// Hill center 0.04 rad along the great circle through the radial direction toward azimuth 120°.
	const nominal = deg(120)
	const range = Math.hypot(point[0], point[1], point[2])
	const radial = [point[0] / range, point[1] / range, point[2] / range] as const
	const horizontal = [0, 1, 2].map((i) => Math.cos(nominal) * feature.north[i] + Math.sin(nominal) * feature.east[i])
	const along = horizontal[0] * radial[0] + horizontal[1] * radial[1] + horizontal[2] * radial[2]
	const tangent = [0, 1, 2].map((i) => horizontal[i] - along * radial[i])
	const scale = Math.hypot(tangent[0], tangent[1], tangent[2])
	const center = [0, 1, 2].map((i) => Math.cos(0.04) * radial[i] + (Math.sin(0.04) * tangent[i]) / scale)
	const longitude = Math.atan2(center[1], center[0])
	const latitude = Math.atan2(center[2], Math.hypot(center[0], center[1]))

	// A smooth 6 km Gaussian hill 10 mrad wide on a 0.02° grid around the station and the hill.
	const height = kilometer(6)
	const sigma = 0.01
	const step = deg(0.02)
	const width = 501
	const rows = 501
	const elevations = new Float64Array(width * rows)

	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < width; i++) {
			const lon = deg(42) + i * step
			const lat = deg(12) + j * step
			const cosine = Math.cos(lat) * Math.cos(latitude) * Math.cos(lon - longitude) + Math.sin(lat) * Math.sin(latitude)
			const angle = Math.acos(Math.min(cosine, 1))
			elevations[j * width + i] = height * Math.exp(-(angle * angle) / (2 * sigma * sigma))
		}
	}

	const grid = { width, height: rows, longitude: deg(42), latitude: deg(12), longitudeStep: step, latitudeStep: step }
	const model = terrainModel({ ...grid, elevations, source: 'synthetic hill on a [2000, 1000, 500] km ellipsoid' })
	// The vantage stands on the hill's far tail, about 2 m up.
	const onTerrain = surfaceFeature(terrainSurfaceLocation(model, deg(45), 0.3, shape, ICRS)!)
	const horizon = terrainHorizon(model, onTerrain, { azimuths: 72, step: kilometer(0.25), maxDistance: kilometer(80) })
	let checked = 0

	// Independent check by straight rays: just below each hill-set horizon the ray toward that very
	// azimuth meets the terrain, and just above it the ray clears.
	for (const sample of horizon) {
		if (!(sample.minimumAltitude > deg(0.5))) continue
		const options = { step: kilometer(0.1), maxDistance: kilometer(90) }
		expect(terrainOcclusion(model, onTerrain, sample.minimumAltitude - deg(0.1), sample.azimuth, options)).toBeDefined()
		expect(terrainOcclusion(model, onTerrain, sample.minimumAltitude + deg(0.1), sample.azimuth, options)).toBeUndefined()
		checked++
	}

	expect(checked).toBeGreaterThan(5)

	// A level DEM on the same convex body stays within the first step's curvature drop of the tangent plane.
	const level = terrainModel({ ...grid, elevations: new Float64Array(width * rows), source: 'synthetic level patch' })
	for (const sample of terrainHorizon(level, feature, { azimuths: 12, step: kilometer(0.25), maxDistance: kilometer(50) })) {
		expect(sample.minimumAltitude).toBeLessThanOrEqual(0)
		expect(sample.minimumAltitude).toBeGreaterThan(-deg(0.1))
	}

	// The slope of the level DEM is the reference ellipsoid itself.
	expect(terrainSlope(level, feature)!.slope).toBeCloseTo(0, 6)
})

// Strongly tri-axial reference body for the vertical-section solver.
const TRIAXIAL_BODY = bodyShape([kilometer(2000), kilometer(1000), kilometer(500)])

// Unit horizontal direction toward a local azimuth (radians) of a prepared feature.
function horizontalToward(feature: ReturnType<typeof surfaceFeature>, azimuth: Angle) {
	return [0, 1, 2].map((i) => Math.cos(azimuth) * feature.north[i] + Math.sin(azimuth) * feature.east[i])
}

test('a zero-relief tri-axial body never gives a positive horizon', () => {
	// On a convex body every other surface point lies below the tangent plane; the horizon is 0° in
	// the limit and slightly negative at a finite step, never above it.
	const feature = surfaceFeature(bodySurfaceLocation(-0.5, -0.05, 0, TRIAXIAL_BODY, ICRS))
	expect(terrainHorizon(FLAT, feature, { azimuths: 8, step: kilometer(20), maxDistance: kilometer(600) })[7].minimumAltitude).toBeLessThanOrEqual(1e-12)

	// Finer steps converge on the tangent plane from below.
	let previous = Number.NEGATIVE_INFINITY
	for (const step of [kilometer(50), kilometer(20), kilometer(10), kilometer(5)]) {
		const altitude = terrainHorizon(FLAT, feature, { azimuths: 8, step, maxDistance: kilometer(600) })[7].minimumAltitude
		expect(Number.isFinite(altitude)).toBeTrue()
		expect(altitude).toBeLessThanOrEqual(1e-12)
		expect(altitude).toBeGreaterThanOrEqual(previous)
		previous = altitude
	}
	expect(previous).toBeGreaterThan(-deg(0.5))

	// Every emitted horizon point lies on the ellipsoid, including the eccentric 300°–320° sections.
	const [a, b, c] = TRIAXIAL_BODY.radii
	const point = feature.location.bodyFixed!
	for (const sample of terrainHorizon(FLAT, feature, { azimuths: 72, step: kilometer(20), maxDistance: kilometer(600) })) {
		if (!(sample.azimuth >= deg(300) && sample.azimuth <= deg(320))) continue
		const h = horizontalToward(feature, sample.azimuth)
		const lift = sample.distance * Math.tan(sample.minimumAltitude)
		const [x, y, z] = [0, 1, 2].map((i) => point[i] + sample.distance * h[i] + lift * feature.up[i])
		expect((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2).toBeCloseTo(1, 9)
	}

	// The same holds over the body, high latitudes included, out to the limb.
	for (const longitude of [deg(-180), deg(-90), 0, deg(45), deg(135)]) {
		for (const latitude of [deg(-80), deg(-40), 0, deg(40), deg(80)]) {
			const station = surfaceFeature(bodySurfaceLocation(longitude, latitude, 0, TRIAXIAL_BODY, ICRS))
			for (const sample of terrainHorizon(FLAT, station, { azimuths: 36, step: kilometer(20), maxDistance: kilometer(2000) })) {
				expect(sample.minimumAltitude).toBeLessThanOrEqual(1e-12)
				expect(sample.minimumAltitude).toBeGreaterThan(-deg(10))
			}
		}
	}
})

test('a steep pillar on a tri-axial body sets the horizon at the azimuth of its top', () => {
	// Pillar center 0.04 rad along the great circle through the radial direction toward azimuth 120°,
	// where that great circle is seen about 5° off; a 6 km Gaussian 1 mrad wide on a 0.01° grid.
	const base = surfaceFeature(bodySurfaceLocation(deg(45), 0.3, 0, TRIAXIAL_BODY, ICRS))
	const basePoint = base.location.bodyFixed!
	const range = Math.hypot(basePoint[0], basePoint[1], basePoint[2])
	const radial = [0, 1, 2].map((i) => basePoint[i] / range)
	const horizontal = horizontalToward(base, deg(120))
	const along = horizontal[0] * radial[0] + horizontal[1] * radial[1] + horizontal[2] * radial[2]
	const tangent = [0, 1, 2].map((i) => horizontal[i] - along * radial[i])
	const scale = Math.hypot(tangent[0], tangent[1], tangent[2])
	const center = [0, 1, 2].map((i) => Math.cos(0.04) * radial[i] + (Math.sin(0.04) * tangent[i]) / scale)
	const longitude = Math.atan2(center[1], center[0])
	const latitude = Math.atan2(center[2], Math.hypot(center[0], center[1]))
	const height = kilometer(6)
	const step = deg(0.01)
	const width = 601
	const rows = 801
	const elevations = new Float64Array(width * rows)

	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < width; i++) {
			const lon = deg(42) + i * step
			const lat = deg(14) + j * step
			const cosine = Math.cos(lat) * Math.cos(latitude) * Math.cos(lon - longitude) + Math.sin(lat) * Math.sin(latitude)
			const angle = Math.acos(Math.min(cosine, 1))
			elevations[j * width + i] = height * Math.exp(-(angle * angle) / (2 * 0.001 * 0.001))
		}
	}

	const model = terrainModel({ elevations, width, height: rows, longitude: deg(42), latitude: deg(14), longitudeStep: step, latitudeStep: step, source: 'synthetic pillar on a [2000, 1000, 500] km ellipsoid' })
	const feature = surfaceFeature(terrainSurfaceLocation(model, deg(45), 0.3, TRIAXIAL_BODY, ICRS)!)
	const point = feature.location.bodyFixed!
	const top = bodySurfaceLocation(longitude, latitude, height, TRIAXIAL_BODY, ICRS).bodyFixed!
	const toward = [0, 1, 2].map((i) => top[i] - point[i])
	const dot = (v: readonly number[]) => toward[0] * v[0] + toward[1] * v[1] + toward[2] * v[2]
	const expectedAzimuth = Math.atan2(dot(feature.east), dot(feature.north))
	const expectedAltitude = Math.atan2(dot(feature.up), Math.hypot(dot(feature.north), dot(feature.east)))
	expect(toDeg(expectedAzimuth) - 120).toBeGreaterThan(3)

	const horizon = terrainHorizon(model, feature, { azimuths: 1440, step: kilometer(0.25), maxDistance: kilometer(50) })
	let peak = horizon[0]
	for (const sample of horizon) if (sample.minimumAltitude > peak.minimumAltitude) peak = sample
	expect(Math.abs(toDeg(peak.azimuth - expectedAzimuth))).toBeLessThan(0.2)
	expect(Math.abs(toDeg(peak.minimumAltitude - expectedAltitude))).toBeLessThan(0.1)
	expect(Math.abs(peak.distance - kilometer(41.5))).toBeLessThan(kilometer(1))
	expect(peak.complete).toBeTrue()
})

test('azimuth counts and sample totals are bounded before any work', () => {
	const feature = surfaceFeature(bodySurfaceLocation(0, 0, 0, MOON, ICRS))
	expect(() => terrainHorizon(FLAT, feature, { azimuths: Number.POSITIVE_INFINITY })).toThrow()
	expect(() => terrainHorizon(FLAT, feature, { azimuths: 2.5 })).toThrow()
	expect(() => terrainHorizon(FLAT, feature, { azimuths: 0 })).toThrow()
	expect(() => terrainHorizon(FLAT, feature, { azimuths: 1e9, maxDistance: kilometer(100) })).toThrow(RangeError)
	expect(() => terrainHorizon(FLAT, feature, { step: 1e-30, maxDistance: kilometer(100) })).toThrow(RangeError)
	expect(() => terrainOcclusion(FLAT, feature, deg(-1), 0, { step: 1e-30 })).toThrow(RangeError)

	const horizon = terrainHorizon(FLAT, feature, { azimuths: 7, maxDistance: kilometer(20) })
	expect(horizon.map((sample) => sample.azimuth)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => (i * TAU) / 7))
})
