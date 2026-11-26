import { describe, expect, test } from 'bun:test'
import { angularDistance } from '../../../../src/astronomy/coordinates/coordinate'
import { DEFAULT_CAMERA_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/camera.config'
import { CameraSky, randomStarTile } from '../../../../src/devices/indi/simulator/camera.sky'
import type { CatalogSource, CatalogSourceStar } from '../../../../src/devices/indi/simulator/types'
import { arcsec, deg, hour } from '../../../../src/math/units/angle'
import { TestBus } from '../../../util/bus'

// Unit coverage of the camera's sky circuit: the seeded random field and the catalog cache.

const SCENE = DEFAULT_CAMERA_SIMULATOR_CONFIG.scene
const PIXEL_SCALE = arcsec(2)
const CENTER = [hour(5), deg(20)] as const

// Key that identifies a star by its position and brightness.
function key(star: CatalogSourceStar) {
	return `${star.rightAscension.toFixed(12)}:${star.declination.toFixed(12)}:${star.flux}`
}

describe('camera sky', () => {
	test('draws the same tile from the same seed and another from another seed', () => {
		const tile = randomStarTile(SCENE, CENTER, PIXEL_SCALE, 1, -2)
		expect(tile.length).toBeGreaterThan(10)
		expect(randomStarTile(SCENE, CENTER, PIXEL_SCALE, 1, -2)).toEqual(tile)
		expect(randomStarTile({ ...SCENE, seed: 7 }, CENTER, PIXEL_SCALE, 1, -2)).not.toEqual(tile)
		expect(randomStarTile(SCENE, CENTER, PIXEL_SCALE, 2, -2)).not.toEqual(tile)
	})

	test('keeps the random stars on the sky when the cone grows or moves', async () => {
		const sky = new CameraSky(new TestBus(), SCENE)
		const small = await sky.stars(CENTER, deg(0.3), PIXEL_SCALE)
		const large = await sky.stars(CENTER, deg(0.6), PIXEL_SCALE)
		const moved = await sky.stars([CENTER[0] + deg(0.2), CENTER[1]], deg(0.3), PIXEL_SCALE)
		const largeKeys = new Set(large.map(key))
		const movedKeys = new Set(moved.map(key))

		expect(large.length).toBeGreaterThan(small.length)
		for (const star of small) expect(largeKeys.has(key(star))).toBeTrue()

		// Every star the moved cone needs and the first one also covered is the same star.
		const shared = small.filter((star) => angularDistance(CENTER[0] + deg(0.2), CENTER[1], star.rightAscension, star.declination) < deg(0.2))
		expect(shared.length).toBeGreaterThan(0)
		for (const star of shared) expect(movedKeys.has(key(star))).toBeTrue()
	})

	test('covers the cone it is asked for', async () => {
		const sky = new CameraSky(new TestBus(), SCENE)
		const stars = await sky.stars(CENTER, deg(0.5), PIXEL_SCALE)
		const inside = stars.filter((star) => angularDistance(CENTER[0], CENTER[1], star.rightAscension, star.declination) <= deg(0.5))
		// Density per square pixel times the area of the cone.
		const expected = SCENE.starDensity * Math.PI * (deg(0.5) / PIXEL_SCALE) ** 2
		expect(inside.length / expected).toBeGreaterThan(0.8)
		expect(inside.length / expected).toBeLessThan(1.2)
	})

	test('changes the random field when the scene changes', async () => {
		const bus = new TestBus()
		const sky = new CameraSky(bus, SCENE)
		const before = await sky.stars(CENTER, deg(0.2), PIXEL_SCALE)
		sky.handleNumber({ device: '', name: 'SIMULATOR_SCENE', elements: { SCENE_SEED: 99 } })
		expect(bus.take()).toEqual(['SIMULATOR_SCENE'])
		const after = await sky.stars(CENTER, deg(0.2), PIXEL_SCALE)
		expect(after.map(key)).not.toEqual(before.map(key))
		expect(sky.snapshot().seed).toBe(99)
	})

	test('queries a catalog once while the cone stays inside the query and returns its stars untouched', async () => {
		const queries: number[][] = []
		const source: CatalogSource = async (rightAscension, declination, radius) => {
			queries.push([rightAscension, declination, radius])
			await Bun.sleep(1)
			return [Object.freeze({ rightAscension, declination, flux: 1, hfd: 2, snr: 10 })]
		}

		const sky = new CameraSky(new TestBus(), { ...SCENE, catalogSource: 'SKY' }, { SKY: source })
		expect(sky.catalogSourceType).toBe('SKY')

		const first = await sky.stars(CENTER, deg(0.4), PIXEL_SCALE)
		const second = await sky.stars([CENTER[0] + deg(0.05), CENTER[1]], deg(0.4), PIXEL_SCALE)
		expect(second).toBe(first)
		expect(queries).toHaveLength(1)
		expect(queries[0][2]).toBeGreaterThan(deg(0.4))
		expect(first[0]).toEqual({ rightAscension: CENTER[0], declination: CENTER[1], flux: 1, hfd: 2, snr: 10 })

		await sky.stars([CENTER[0] + deg(2), CENTER[1]], deg(0.4), PIXEL_SCALE)
		expect(queries).toHaveLength(2)
	})

	test('draws the random field instead of querying the catalog for a cone without a pointing', async () => {
		let queries = 0
		const sky = new CameraSky(new TestBus(), { ...SCENE, catalogSource: 'SKY' }, { SKY: () => (queries++, []) })
		expect((await sky.stars([0, 0], deg(0.3), PIXEL_SCALE, false)).length).toBeGreaterThan(0)
		expect(queries).toBe(0)
	})

	test('selects the random field when the configured source is missing', () => {
		expect(new CameraSky(new TestBus(), { ...SCENE, catalogSource: 'MISSING' }, { SKY: () => [] }).catalogSourceType).toBe('RANDOM')
		expect(new CameraSky(new TestBus(), { ...SCENE, catalogSource: 'SKY' }, { SKY: null }).catalogSourceType).toBe('RANDOM')
	})
})
