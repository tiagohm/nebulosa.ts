import { expect, test } from 'bun:test'
import { ICRS } from '../../../src/astronomy/coordinates/frame'
import { surfaceFeature } from '../../../src/astronomy/events/surface'
import { type ElevationGrid, terrainElevation, terrainHorizon, terrainModel, terrainOcclusion, terrainShadowTip, terrainSlope, terrainSurfaceLocation } from '../../../src/astronomy/events/surface.terrain'
import { bodyShape, bodySurfaceLocation } from '../../../src/astronomy/observer/body'
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
