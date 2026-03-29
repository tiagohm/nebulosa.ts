import { describe, expect, test } from 'bun:test'
import { type Angle, arcsec, deg, formatAZ, formatDEC, formatRA, normalizeAngle, toArcsec } from '../src/angle'
import { Bitpix } from '../src/fits'
import { sphericalDestination, sphericalSeparation } from '../src/geometry'
import { HnskyCatalog } from '../src/hnsky'
import { gnomonicUnproject } from '../src/projection'
import { mulberry32, type Random } from '../src/random'
import type { StarCatalog, StarCatalogEntry, StarCatalogQuery } from '../src/star.catalog'
import { crossMatchStars, type StarCrossmatchCameraInfo } from '../src/star.crossmatching'
import { type DetectedStar, detectStars } from '../src/star.detector'
import { downloadPerTag } from './download'
import { readImage } from './image.util'

await downloadPerTag('hnsky')

interface SyntheticCatalogStar extends StarCatalogEntry {
	readonly magnitude?: number
}

interface ScenarioOptions {
	readonly seed: number
	readonly centerRA: Angle
	readonly centerDEC: Angle
	readonly queryOffset?: Angle
	readonly queryOffsetAngle?: Angle
	readonly width?: number
	readonly height?: number
	readonly pixelsPerRadian?: number
	readonly rotation?: Angle
	readonly mirrored?: boolean
	readonly matchedStars?: number
	readonly distractorStars?: number
}

interface Scenario {
	readonly camera: StarCrossmatchCameraInfo
	readonly trueCenterRA: Angle
	readonly trueCenterDEC: Angle
	readonly queryCenterRA: Angle
	readonly queryCenterDEC: Angle
	readonly queryRadius: Angle
	readonly detectedStars: readonly DetectedStar[]
	readonly catalogStars: readonly SyntheticCatalogStar[]
	readonly truthIds: readonly string[]
}

// Provides a deterministic in-memory catalog for the crossmatcher tests.
class MockCatalog implements StarCatalog<SyntheticCatalogStar> {
	constructor(private readonly stars: readonly SyntheticCatalogStar[]) {}

	// Queries the catalog with exact spherical separation.
	queryCone(centerRA: Angle, centerDEC: Angle, radius: Angle) {
		return this.stars.filter((star) => sphericalSeparation(centerRA, centerDEC, star.rightAscension, star.declination) <= radius)
	}

	// Queries the catalog through the generic region interface.
	queryRegion(query: StarCatalogQuery) {
		switch (query.kind) {
			case 'cone':
				return this.queryCone(query.centerRA, query.centerDEC, query.radius)
			case 'box':
				return this.queryBox(query.minRA, query.maxRA, query.minDEC, query.maxDEC)
			case 'polygon':
				return this.queryPolygon(query.vertices)
		}
	}

	// Queries a possibly wrapping RA/Dec box.
	queryBox(minRA: Angle, maxRA: Angle, minDEC: Angle, maxDEC: Angle) {
		return this.stars.filter((star) => insideRaRange(star.rightAscension, minRA, maxRA) && star.declination >= minDEC && star.declination <= maxDEC)
	}

	// Returns polygon candidates conservatively for interface completeness.
	queryPolygon(_vertices: readonly (readonly [Angle, Angle])[]) {
		return [...this.stars]
	}

	// Retrieves a catalog entry by identifier.
	get(id: string) {
		return this.stars.find((star) => star.id === id)
	}

	// Streams generic region results.
	*streamRegion(query: StarCatalogQuery) {
		for (const star of this.queryRegion(query)) yield star
	}
}

// Creates a deterministic synthetic sky/image scenario around a true field center.
function createScenario(options: ScenarioOptions): Scenario {
	const width = options.width ?? 1600
	const height = options.height ?? 1200
	const pixelsPerRadian = options.pixelsPerRadian ?? 95000
	const rotation = options.rotation ?? 0.35
	const mirrored = options.mirrored ?? false
	const matchedStars = options.matchedStars ?? 22
	const distractorStars = options.distractorStars ?? 30
	const random = mulberry32(options.seed)
	const fieldRadiusPixels = Math.min(width, height) * 0.32
	const fieldRadiusRadians = fieldRadiusPixels / pixelsPerRadian
	const queryOffset = options.queryOffset ?? arcsec(0)
	const queryOffsetAngle = options.queryOffsetAngle ?? 0
	const queryCenter = sphericalDestination(options.centerRA, options.centerDEC, queryOffsetAngle, queryOffset)
	const queryRadius = Math.min(deg(2), fieldRadiusRadians * 2.8 + queryOffset + arcsec(30))
	const catalogStars: SyntheticCatalogStar[] = []
	const detectedStars: DetectedStar[] = []
	const truthIds: string[] = []
	let attempts = 0

	while (detectedStars.length < matchedStars && attempts < matchedStars * 500) {
		attempts++

		const planeX = randomRange(random, -fieldRadiusRadians, fieldRadiusRadians)
		const planeY = randomRange(random, -fieldRadiusRadians, fieldRadiusRadians)
		if (planeX * planeX + planeY * planeY > fieldRadiusRadians * fieldRadiusRadians) continue

		const imagePoint = planeToImage(planeX, planeY, width, height, pixelsPerRadian, rotation, mirrored)
		if (imagePoint.x < 24 || imagePoint.x > width - 24 || imagePoint.y < 24 || imagePoint.y > height - 24) continue
		if (!isSeparated(imagePoint.x, imagePoint.y, detectedStars, 22)) continue

		const sky = gnomonicUnproject(planeX, planeY, options.centerRA, options.centerDEC)
		if (sky === false) continue

		const id = detectedStars.length.toFixed(0)
		catalogStars.push({ id, epoch: 2000, rightAscension: sky[0], declination: sky[1], magnitude: 10 + random() * 2 })
		detectedStars.push({ x: imagePoint.x, y: imagePoint.y, flux: 2000 + detectedStars.length * 100, snr: 20 + detectedStars.length * 0.5, hfd: 2.2 + (detectedStars.length % 3) * 0.1 })
		truthIds.push(id)
	}

	for (let index = 0; index < distractorStars; index++) {
		const radius = randomRange(random, fieldRadiusRadians * 1.45, Math.min(queryRadius * 0.95, fieldRadiusRadians * 3))
		const angle = randomRange(random, 0, Math.PI * 2)
		const sky = gnomonicUnproject(radius * Math.cos(angle), radius * Math.sin(angle), options.centerRA, options.centerDEC)
		if (sky === false) continue
		catalogStars.push({ id: `d${index}`, epoch: 2000, rightAscension: sky[0], declination: sky[1], magnitude: 12 + random() * 2 })
	}

	return {
		camera: { width, height },
		trueCenterRA: options.centerRA,
		trueCenterDEC: options.centerDEC,
		queryCenterRA: queryCenter[0],
		queryCenterDEC: queryCenter[1],
		queryRadius,
		detectedStars,
		catalogStars,
		truthIds,
	}
}

// Projects tangent-plane coordinates into synthetic image pixels.
function planeToImage(planeX: number, planeY: number, width: number, height: number, pixelsPerRadian: number, rotation: Angle, mirrored: boolean) {
	let x = planeX * pixelsPerRadian
	const y = -planeY * pixelsPerRadian
	if (mirrored) x = -x
	const cosRotation = Math.cos(rotation)
	const sinRotation = Math.sin(rotation)
	return { x: width * 0.5 + cosRotation * x - sinRotation * y, y: height * 0.5 + sinRotation * x + cosRotation * y } as const
}

// Generates a deterministic floating-point value in a range.
function randomRange(random: Random, min: number, max: number) {
	return min + (max - min) * random()
}

// Keeps synthetic detections well separated for robust triangle generation.
function isSeparated(x: number, y: number, stars: readonly DetectedStar[], minDistance: number) {
	const minDistanceSq = minDistance * minDistance

	for (let index = 0; index < stars.length; index++) {
		const star = stars[index]
		const dx = star.x - x
		const dy = star.y - y
		if (dx * dx + dy * dy < minDistanceSq) return false
	}

	return true
}

// Checks whether an RA lies inside a possibly wrapping interval.
function insideRaRange(rightAscension: Angle, minRA: Angle, maxRA: Angle) {
	rightAscension = normalizeAngle(rightAscension)
	const normalizedMin = normalizeAngle(minRA)
	const normalizedMax = normalizeAngle(maxRA)
	return normalizedMin <= normalizedMax ? rightAscension >= normalizedMin && rightAscension <= normalizedMax : rightAscension >= normalizedMin || rightAscension <= normalizedMax
}

// Returns matched catalog identifiers in detected-star order.
function matchedIds(result: Awaited<ReturnType<typeof crossMatchStars<SyntheticCatalogStar>>>) {
	return result.matches.map((match) => match.catalogStar?.id)
}

describe('image-based star crossmatching', () => {
	test('recovers the approximate image center and catalog associations', async () => {
		const scenario = createScenario({ seed: 1, centerRA: deg(120), centerDEC: deg(-20), queryOffset: arcsec(180), queryOffsetAngle: 0.7 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), { centerRA: scenario.queryCenterRA, centerDEC: scenario.queryCenterDEC, radius: scenario.queryRadius, camera: scenario.camera })

		expect(result.success).toBeTrue()
		expect(sphericalSeparation(result.solution!.rightAscension, result.solution!.declination, scenario.trueCenterRA, scenario.trueCenterDEC)).toBeLessThan(arcsec(5))
		expect(result.summary.matchedCount).toBe(scenario.truthIds.length)
		expect(matchedIds(result)).toEqual([...scenario.truthIds])
	})

	test('iterative refinement handles a significantly shifted query center', async () => {
		const scenario = createScenario({ seed: 2, centerRA: deg(45), centerDEC: deg(15), queryOffset: arcsec(700), queryOffsetAngle: 1.8, rotation: -0.42 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), { centerRA: scenario.queryCenterRA, centerDEC: scenario.queryCenterDEC, radius: scenario.queryRadius, camera: scenario.camera, refinementIterations: 3 })

		expect(result.success).toBeTrue()
		expect(sphericalSeparation(result.solution!.rightAscension, result.solution!.declination, scenario.trueCenterRA, scenario.trueCenterDEC)).toBeLessThan(arcsec(8))
	})

	test('supports mirrored image geometry', async () => {
		const scenario = createScenario({ seed: 3, centerRA: deg(210), centerDEC: deg(12), mirrored: true, rotation: 0.61, queryOffset: arcsec(240), queryOffsetAngle: 2.2 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), { centerRA: scenario.queryCenterRA, centerDEC: scenario.queryCenterDEC, radius: scenario.queryRadius, camera: scenario.camera })

		expect(result.success).toBeTrue()
		expect(result.solution?.mirrored).toBeTrue()
		expect(result.summary.matchedCount).toBe(scenario.truthIds.length)
	})

	test('handles RA wraparound near 0/360', async () => {
		const scenario = createScenario({ seed: 4, centerRA: deg(359.8), centerDEC: deg(5), queryOffset: arcsec(220), queryOffsetAngle: 0.4, rotation: -0.2 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), { centerRA: scenario.queryCenterRA, centerDEC: scenario.queryCenterDEC, radius: scenario.queryRadius, camera: scenario.camera })

		expect(result.success).toBeTrue()
		expect(sphericalSeparation(result.solution!.rightAscension, result.solution!.declination, scenario.trueCenterRA, scenario.trueCenterDEC)).toBeLessThan(arcsec(6))
	})

	test('handles polar fields', async () => {
		const scenario = createScenario({ seed: 5, centerRA: deg(35), centerDEC: deg(88), queryOffset: arcsec(180), queryOffsetAngle: 2.6, rotation: 0.12 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), { centerRA: scenario.queryCenterRA, centerDEC: scenario.queryCenterDEC, radius: scenario.queryRadius, camera: scenario.camera })

		expect(result.success).toBeTrue()
		expect(sphericalSeparation(result.solution!.rightAscension, result.solution!.declination, scenario.trueCenterRA, scenario.trueCenterDEC)).toBeLessThan(arcsec(10))
	})

	test('works without pixel size or focal length metadata', async () => {
		const scenario = createScenario({ seed: 6, centerRA: deg(180), centerDEC: deg(-12), queryOffset: arcsec(150), queryOffsetAngle: 1.2 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), { centerRA: scenario.queryCenterRA, centerDEC: scenario.queryCenterDEC, radius: scenario.queryRadius, camera: { width: scenario.camera.width, height: scenario.camera.height } })

		expect(result.success).toBeTrue()
		expect(result.summary.matchedCount).toBe(scenario.truthIds.length)
	})

	test('accepts an optical scale hint when focal length and pixel size are available', async () => {
		const scenario = createScenario({ seed: 7, centerRA: deg(260), centerDEC: deg(18), pixelsPerRadian: 90000, queryOffset: arcsec(200), queryOffsetAngle: 0.9 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), {
			centerRA: scenario.queryCenterRA,
			centerDEC: scenario.queryCenterDEC,
			radius: scenario.queryRadius,
			camera: { ...scenario.camera, pixelSize: 4.8, focalLength: 432 },
		})

		expect(result.success).toBeTrue()
		expect(result.solution?.fieldRadius).toBeGreaterThan(0)
	})

	test('fails explicitly when the catalog query is empty', async () => {
		const camera = { width: 1200, height: 900 }
		const detectedStars: readonly DetectedStar[] = [{ x: 200, y: 250, flux: 2000, snr: 20, hfd: 2.2 }]
		const result = await crossMatchStars(detectedStars, new MockCatalog([]), { centerRA: deg(10), centerDEC: deg(10), radius: deg(1), camera })

		expect(result.success).toBeFalse()
		expect(result.failureReason).toBe('no catalog stars in query region')
		expect(result.summary.matchedCount).toBe(0)
	})

	test('fails explicitly when there are too few stars for a geometric solution', async () => {
		const scenario = createScenario({ seed: 8, centerRA: deg(90), centerDEC: deg(10), matchedStars: 2, distractorStars: 4 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), {
			centerRA: scenario.queryCenterRA,
			centerDEC: scenario.queryCenterDEC,
			radius: scenario.queryRadius,
			camera: scenario.camera,
			matchingConfig: { minStars: 3, minInliers: 3 },
		})

		expect(result.success).toBeFalse()
		expect(result.failureReason).toBeDefined()
	})

	test('deterministic repeated execution returns the same result', async () => {
		const scenario = createScenario({ seed: 9, centerRA: deg(310), centerDEC: deg(-5), queryOffset: arcsec(260), queryOffsetAngle: 2.9, rotation: -0.48 })
		const options = { centerRA: scenario.queryCenterRA, centerDEC: scenario.queryCenterDEC, radius: scenario.queryRadius, camera: scenario.camera }
		const first = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), options)
		const second = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), options)

		expect(second).toEqual(first)
	})

	test('summary metrics include residual and sky-separation statistics', async () => {
		const scenario = createScenario({ seed: 10, centerRA: deg(12), centerDEC: deg(1), queryOffset: arcsec(140), queryOffsetAngle: 0.5 })
		const result = await crossMatchStars(scenario.detectedStars, new MockCatalog(scenario.catalogStars), { centerRA: scenario.queryCenterRA, centerDEC: scenario.queryCenterDEC, radius: scenario.queryRadius, camera: scenario.camera })

		expect(result.success).toBeTrue()
		expect(result.summary.averageResidual).toBeLessThan(2)
		expect(result.summary.medianSkySeparation).toBeLessThan(arcsec(2))
		expect(result.summary.projectedCatalogCount).toBeGreaterThanOrEqual(result.summary.matchedCount)
	})
})

test('real scenario', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const stars = detectStars(image, { maxStars: 100 })

	// Rotate and shift stars out of center
	const dx = 35
	const dy = 48
	const rotation = deg(2)
	const cosRot = Math.cos(rotation)
	const sinRot = Math.sin(rotation)

	function rotateAndTranslate(s: DetectedStar) {
		const x = s.x * cosRot - s.y * sinRot + dx
		const y = s.x * sinRot + s.y * cosRot + dy
		return { ...s, x, y }
	}

	const catalog = new HnskyCatalog()
	const archive = new Bun.Archive(await Bun.file('data/HNSKY_g14.tar').arrayBuffer())
	catalog.open(await archive.files(), 'g14')

	const result = await crossMatchStars(stars.map(rotateAndTranslate), catalog, {
		centerRA: deg(161.0177548315),
		centerDEC: deg(-59.6022705034),
		radius: deg(1),
		camera: {
			width: 1037,
			height: 706,
			pixelSize: 18.5021,
			// focalLength: 1050,
		},
	})

	expect(result.solution).toBeDefined()
	expect(formatRA(result.solution!.rightAscension).substring(0, 8)).toBe('10 43 45')
	expect(formatDEC(result.solution!.declination).substring(0, 9)).toBe('-59 34 04')
	expect(formatAZ(result.solution!.rotation).substring(0, 9)).toBe('112 12 47')
	expect(toArcsec(result.solution!.scale)).toBeCloseTo(2.735, 2)
	expect(formatAZ(result.solution!.fieldRadius).substring(0, 9)).toBe('000 28 35')
}, 2500)
