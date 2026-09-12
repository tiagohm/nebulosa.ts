import { expect, test } from 'bun:test'
import { createTiledSkyGeometry, findTiledStarAreas } from '../../../src/catalogs/stars/tiled.catalog'
import { PIOVERTWO } from '../../../src/core/constants'

test.each([
	[-PIOVERTWO, 1],
	[-1, 1],
	[0, 2],
	[1, 3],
	[PIOVERTWO, 3],
])('findTiledStarAreas maps single-cell bands at declination %s to area %s', (declination: number, area: number) => {
	const geometry = createTiledSkyGeometry([1, 1, 1], [-PIOVERTWO, -Math.PI / 6, Math.PI / 6, PIOVERTWO], '.test')
	const areas = findTiledStarAreas(geometry, 0, declination, 0.01)

	expect(areas.map((tile) => tile.area)).toEqual([area])
})
