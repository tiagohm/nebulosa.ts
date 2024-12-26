import { expect, test } from 'bun:test'
import { GeoId, polarRadius } from './location'

test('polarRadius', () => {
	expect(polarRadius(GeoId.IERS2010)).toBeCloseTo(0.000042492261609253282, 20)
	expect(polarRadius(GeoId.WGS84)).toBeCloseTo(0.000042492264659253469, 20)
})
